import { extname, join } from 'path';
import * as runtime from '../runtime/runtime.js';
import { constantValueToType, resetFoldBudget, typeToConstantValue, tryBuildCallable } from './constant-folding.js';
import {
	BracketedExpression,
	CompileTimeDictionary,
	CompileTimeFunctionType,
	CompileTimeType,
	createCompileTimeConcatType,
	createCompileTimeComplementType,
	createCompileTimeDictionaryLiteralType,
	createCompileTimeDictionaryType,
	createCompileTimeFunctionType,
	createCompileTimeBoundType,
	createCompileTimeListType,
	createCompileTimeIndexRangeType,
	createCompileTimeStreamType,
	createCompileTimeTupleType,
	createCompileTimeTypeOfType,
	ConditionalTypeBranch,
	createParameterReference,
	createParametersType,
	ParsedExpressions2,
	ParsedFile,
	ParseDictionaryField,
	ParseExpression,
	ParseDictionaryLiteral,
	ParseBranching,
	ParseDestructuringField,
	ParseDictionaryTypeField,
	ParseFunctionCall,
	ParseFunctionLiteral,
	ParseListLiteral,
	ParseParameterField,
	ParseParameterFields,
	ParseTextLiteral,
	ParseValueExpression,
	ParseReference,
	PredicateFacts,
	Purity,
	SimpleExpression,
	SymbolDefinition,
	SymbolTable,
	Name,
	TextToken,
	TypedExpression,
	TypeInfo,
	ParseExpressionBase,
	PositionedExpression,
	CompileTimeAliasType,
	createCompileTimeAliasType,
	forEachChild,
	forEachChildType,
	NestedReferenceType,
	builtinAny,
	builtinBlob,
	builtinEmpty,
	builtinNever,
	builtinBoolean,
	builtinInteger,
	builtinText,
	builtinFloat,
	builtinDate,
	builtinError,
	builtinType,
	createBooleanLiteral,
	createIntegerLiteral,
	createFloatLiteral,
	createTextLiteral,
	FunctionIdentity,
	createFunctionIdentity,
	getFunctionTypeFacts,
} from '../syntax-tree.js';
import { Extension, NonEmptyArray, elementsEqual, escapeReservedJsVariableName, forEach, isDefined, isNonEmpty, isTestFilePath, last, mapDictionary } from '../util.js';
import { coreLibPath, getPathFromImport, isCoreLibPath, isImportFunctionCall, isTopLevelImport, parseFile } from '../parser/parser.js';
import { CompilerError, ErrorCode, Positioned } from '../compiler-errors.js';
import { getCheckedEscapableName, getExportedSymbols, getTestCallArguments, getNameFromValue, getTestName, isInsideFunctionLiteral } from '../parser/parser-utils.js';
import { FieldSymbolLocation, getFieldSymbolsFromDictionaryType, ReferenceIndex, ReferenceLocation, resolveCanonicalSymbol, resolveImportBinding } from './reference-index.js';
import { collectCompletedNames, reportStreamsWithoutEnd } from './stream-lifetime.js';
import { applyIgnoreComments } from '../parser/comment-directives.js';
import { checkerStats } from './checker-stats.js';
import {
	addFromTypes,
	canHaveFields,
	concatFromTypes,
	createConditionalType,
	createNormalizedIntersectionType,
	createNormalizedUnionType,
	dereferenceArgumentTypesNested,
	dereferenceIndexFromObject,
	dereferenceNameFromObject,
	dereferenceNestedKeyFromObject,
	dereferenceParameterTypeFromFunctionRef,
	getAllArgTypes,
	getArgumentsAssignability,
	getElementTypeAtIndex,
	getLengthFromType,
	getNamedAccess,
	hasKnownFields,
	hasKnownLength,
	isDictionaryLiteralType,
	isDictionaryType,
	isFunctionType,
	isParametersType,
	isSubtypeOf,
	isTupleType,
	isTypeAssignable,
	isTypeAssignableForPredicateFunction,
	isTypePropertyOfValue,
	isUnionType,
	isUnresolvedPlaceholderType,
	mapElementsFromTypes,
	resolveAlias,
	resolvePlaceholders,
	splitReceiver,
	spreadDictionaryTypes,
	typeEquals,
	typeErrorToString,
	typePropertyAccess,
	typeToString,
	typesOverlap,
	valueFieldAccess,
	valueOf,
	withElementAtFromTypes,
	type TypeAssignability,
} from './type-algebra.js';

export type ParsedDocuments = { [filePath: string]: ParsedFile; };

/**
 * Trägt einen Feldnamen als Referenz auf die Felddeklaration(en) seines Quelltyps ein.
 * Zeigt der Quelltyp auf keine Deklaration (z.B. Any oder ein rein berechneter Typ), gibt es nichts
 * einzutragen - der Feldname bleibt dann ohne Identität, statt über den blossen Namen zu raten.
 */
function recordFieldReference(
	nestedKey: Name | ParseTextLiteral,
	sourceType: CompileTimeType | undefined,
	referenceIndex: ReferenceIndex,
	filePath: string,
): void {
	const fieldName = getCheckedEscapableName(nestedKey);
	if (!fieldName || !sourceType) {
		return;
	}
	getDeclaredFieldSymbols(sourceType, fieldName).forEach(fieldSymbol => {
		referenceIndex.recordReference(fieldSymbol.symbol, fieldSymbol.filePath, toReferenceLocation(nestedKey, filePath));
	});
}

/**
 * Die Felddeklarationen, auf die ein Feldname in sourceType zeigt, ohne builtins.
 */
function getDeclaredFieldSymbols(sourceType: CompileTimeType, fieldName: string): FieldSymbolLocation[] {
	const fieldSymbols = getFieldSymbolsFromDictionaryType(sourceType, fieldName);
	if (!fieldSymbols.length) {
		getFieldSymbolsFromDictionaryType(resolvePlaceholders(sourceType), fieldName, fieldSymbols);
	}
	return fieldSymbols.filter(fieldSymbol => fieldSymbol.filePath !== '');
}

function toReferenceLocation(position: Positioned, filePath: string): ReferenceLocation {
	return {
		filePath: filePath,
		startRowIndex: position.startRowIndex,
		startColumnIndex: position.startColumnIndex,
		endRowIndex: position.endRowIndex,
		endColumnIndex: position.endColumnIndex,
	};
}

/**
 * Destructuring eines Dictionary-Werts: Das Feld-Token (source beim Alias, sonst name) ist eine
 * Referenz auf das Feld des Werttyps. Ohne Alias ist der lokale Name das Feld selbst, wie beim
 * Import. Er wird deshalb mit den Typfeldern verknüpft, damit seine Verwendungen zu ihnen gehören.
 * Ist das Feld des Werttyps selbst ein Literalfeld mit erwartetem Typ (a: MyType = [...]), sind
 * dessen Typfelder gemeint.
 */
function recordDestructuringFieldReferences(
	field: ParseDestructuringField,
	valueType: CompileTimeType,
	localSymbol: SymbolDefinition | undefined,
	referenceIndex: ReferenceIndex,
	filePath: string,
): void {
	const fieldToken = field.source ?? field.name;
	getDeclaredFieldSymbols(valueType, fieldToken.name).forEach(valueField => {
		referenceIndex.recordReference(valueField.symbol, valueField.filePath, toReferenceLocation(fieldToken, filePath));
		if (field.source || !localSymbol) {
			return;
		}
		const typeFields = referenceIndex.getRelatedTypeFields(valueField.symbol, valueField.filePath);
		(typeFields.length ? typeFields : [valueField]).forEach(typeField => {
			referenceIndex.recordRelatedSymbol(typeField, { symbol: localSymbol, filePath: filePath });
		});
	});
}

/**
 * Trägt die Feldnamen eines Dictionary-Literals als Referenzen auf die Felder seines erwarteten
 * Typs ein und verknüpft die Feldsymbole des Literals mit ihnen. Über die Verknüpfung findet sich
 * auch ein späterer Zugriff auf das Literalfeld (a/name). Bei einer Union zählen die Zweige, die
 * nach dem Aussortieren übrig bleiben, und zwar alle davon.
 */
function recordContextualFieldReferences(
	dictionary: ParseDictionaryLiteral,
	fieldTypes: CompileTimeDictionary,
	referenceIndex: ReferenceIndex,
	filePath: string,
): void {
	const expectedType = narrowExpectedTypeByFields(dictionary.expectedType, fieldTypes, getWrittenFieldNames(dictionary));
	if (!expectedType) {
		return;
	}
	dictionary.fields.forEach(field => {
		if (field.type !== 'singleDictionaryField') {
			return;
		}
		const fieldName = getCheckedEscapableName(field.name);
		const literalFieldSymbol = fieldName === undefined
			? undefined
			: dictionary.symbols[fieldName];
		if (!fieldName || !literalFieldSymbol) {
			return;
		}
		getDeclaredFieldSymbols(expectedType, fieldName).forEach(typeField => {
			referenceIndex.recordReference(typeField.symbol, typeField.filePath, toReferenceLocation(field.name, filePath));
			referenceIndex.recordRelatedSymbol(typeField, { symbol: literalFieldSymbol, filePath: filePath });
		});
	});
}

/**
 * Die Verweise auf Parameter je Funktion (getParameterProjections), einmal gesammelt statt je Aufruf.
 * Muss vor der core-lib Initialisierung stehen, die den Checker bereits benutzt.
 */
const parameterProjectionsCache = new WeakMap<CompileTimeFunctionType, ParameterProjection[]>();

/**
 * Schutz gegen Zyklen über Aliase und verschachtelte Typen in classifyTypeness. Echte Typen sind
 * nie annähernd so tief. Steht hier oben, weil die core-lib schon beim Modul-Load gecheckt wird.
 */
const maxTypenessDepth = 50;

/**
 * Kombinieren auf derselben Ebene, statt eine Datenebene hinzuzufügen - siehe
 * findUnproductiveSelfReference. Muss wie subtypeReductionLimit hier oben stehen: die core-lib
 * wird schon beim Modul-Load gecheckt und läuft dabei durch die Prüfung.
 */
const typeCombinatorNames = ['Or', 'And', 'Not', 'TypeOf', 'Greater'];

/**
 * Stream(ValueType) und FiniteStream(ValueType): dieselbe Typfunktion, nur das Merkmal finite
 * unterscheidet sie.
 */
function createStreamTypeFunction(finite: boolean): CompileTimeFunctionType {
	const parameterReference = createParameterReference('ValueType', 0);
	parameterReference.deferValueOf = true;
	const functionType = createCompileTimeFunctionType(
		createParametersType([{
			name: 'ValueType',
			type: builtinType,
		}]),
		createCompileTimeTypeOfType(createCompileTimeStreamType(parameterReference, finite)),
		'pure',
	);
	parameterReference.functionRef = functionType.identity;
	return functionType;
}

const coreBuiltInSymbolTypes: { [key: string]: CompileTimeType; } = {
	true: createBooleanLiteral(true),
	false: createBooleanLiteral(false),
	Any: createCompileTimeTypeOfType(builtinAny),
	Type: createCompileTimeTypeOfType(builtinType),
	Empty: createCompileTimeTypeOfType(builtinEmpty),
	Boolean: createCompileTimeTypeOfType(builtinBoolean),
	Integer: createCompileTimeTypeOfType(builtinInteger),
	Float: createCompileTimeTypeOfType(builtinFloat),
	Text: createCompileTimeTypeOfType(builtinText),
	Date: createCompileTimeTypeOfType(builtinDate),
	Blob: createCompileTimeTypeOfType(builtinBlob),
	Error: createCompileTimeTypeOfType(builtinError),
	List: (() => {
		const parameterReference = createParameterReference('ElementType', 0);
		// Das Argument ist ein Typwert, gemeint ist der Typ, den er beschreibt.
		parameterReference.deferValueOf = true;
		const functionType = createCompileTimeFunctionType(
			createParametersType([{
				name: 'ElementType',
				type: builtinType,
			}]),
			createCompileTimeTypeOfType(createCompileTimeListType(parameterReference)),
			'pure',
		);
		parameterReference.functionRef = functionType.identity;
		return functionType;
	})(),
	Dictionary: (() => {
		const parameterReference = createParameterReference('ElementType', 0);
		// Das Argument ist ein Typwert, gemeint ist der Typ, den er beschreibt.
		parameterReference.deferValueOf = true;
		const functionType = createCompileTimeFunctionType(
			createParametersType([{
				name: 'ElementType',
				type: builtinType,
			}]),
			createCompileTimeTypeOfType(createCompileTimeDictionaryType(parameterReference)),
			'pure',
		);
		parameterReference.functionRef = functionType.identity;
		return functionType;
	})(),
	Stream: createStreamTypeFunction(false),
	FiniteStream: createStreamTypeFunction(true),
	nativeFunction: (() => {
		const parameterReference = createParameterReference('FunctionType', 0);
		parameterReference.deferValueOf = true;
		const functionType = createCompileTimeFunctionType(
			createParametersType([
				{
					name: 'FunctionType',
					// TODO functionType
					type: builtinType,
				},
				{
					name: 'js',
					type: builtinText,
				},
			]),
			parameterReference,
			'impure',
		);
		parameterReference.functionRef = functionType.identity;
		return functionType;
	})(),
	nativeValue: createCompileTimeFunctionType(
		createParametersType([
			{
				name: 'js',
				type: builtinText,
			},
		]),
		builtinAny,
		'impure',
	),
};

/**
 * Je Rumpf die Namen, auf die dort irgendwo complete aufgerufen wird. Vor dem Rumpf gesammelt,
 * damit ein so beendeter Stream schon an seiner Definition ein FiniteStream ist. Muss vor dem
 * Check der core-lib stehen, der beim Modul-Load läuft.
 */
const completedNamesByScope = new WeakMap<SymbolTable, Set<string>>();

// Einziger Dateizugriff des Checkers, bewusst am ProjectHost vorbei: die core-lib gehört zum
// Compiler, nicht zum Projekt, ändert sich während eines Laufs nicht und wird deshalb einmal je
// Prozess gelesen statt je Host.
const parsedCoreLib = parseFile(coreLibPath);
const parsedCoreLib2 = parsedCoreLib.unchecked;
inferFileTypes([], {
	documents: {},
	file: parsedCoreLib2,
	folder: '',
	filePath: '',
	referenceIndex: undefined,
	onProgress: undefined,
	warnUnknown: false,
});
export const builtInSymbols: SymbolTable = parsedCoreLib2.symbols;

//#region dereference

/**
 * JUL-Konvention: Typdefinitionen beginnen mit einem Grossbuchstaben, Werte mit einem
 * Kleinbuchstaben. Während eine Definition selbst gecheckt wird, ist ihr typeInfo noch leer -
 * der Name ist dann das Einzige, woran eine Selbstreferenz die beiden unterscheiden kann.
 */
function isTypeName(name: string): boolean {
	return /^\p{Lu}/u.test(name);
}

/**
 * Steht die Referenz innerhalb der Definition dieses Namens?
 * Ein leeres typeInfo heißt nur "Symbol noch nicht gecheckt" und trifft auch auf eine
 * Vorwärtsreferenz zu - die ist aber bereits als JUL3202 gemeldet und darf keinen Folgefehler
 * bekommen. Nur die Selbstreferenz beschreibt einen rekursiven Typ.
 * Verglichen wird der Name, nicht die Objektidentität: die parent-Kette endet an einem anderen
 * Definition-Objekt als dem in der Symboltabelle (siehe TODO, Parser-Backtracking). Eine
 * Namensüberdeckung wäre ohnehin bereits JUL3203.
 */
/**
 * Ruft sich eine Typfunktion im eigenen Rumpf auf (`Tree(T)` in `Tree = (T: Type) => ...`)? Ihr
 * Symbol hat dann noch keinen Typ, und die Referenz steht für den Alias (siehe dereferenceType).
 */
function getSelfAppliedTypeFunction(functionExpression: SimpleExpression): CompileTimeAliasType | undefined {
	if (functionExpression.type !== 'reference') {
		return undefined;
	}
	const type = functionExpression.typeInfo?.type;
	if (type?.julType !== 'typeOf'
		|| type.value.julType !== 'alias'
		|| type.value.args) {
		return undefined;
	}
	const alias = type.value;
	if (alias.symbol.typeInfo) {
		return undefined;
	}
	const definition = alias.symbol.definition;
	return definition?.type === 'definition'
		&& definition.value?.type === 'functionLiteral'
		? alias
		: undefined;
}

function isSelfReference(reference: ParseReference, name: string): boolean {
	let current: PositionedExpression | undefined = reference.parent;
	while (current) {
		if (current.type === 'definition'
			&& current.name.name === name) {
			return true;
		}
		current = current.parent;
	}
	return false;
}

function dereferenceType(reference: ParseReference, scopes: SymbolTable[]): {
	type: CompileTimeType;
	found: boolean;
	/**
	 * Undefined, wenn symbol in coreBuiltInSymbolTypes gefunden.
	 */
	foundSymbol?: SymbolDefinition;
	isBuiltIn: boolean;
} {
	const name = reference.name.name;
	const coreType = coreBuiltInSymbolTypes[name];
	if (coreType !== undefined) {
		return {
			type: coreType,
			found: true,
			isBuiltIn: true,
		};
	}
	const findResult = findSymbolInScopes(name, scopes);
	if (!findResult) {
		return {
			type: builtinAny,
			found: false,
			isBuiltIn: false,
		};
	}
	const foundSymbol = findResult.symbol;
	// Der oberste Scope ist builtInSymbols.
	// Beim Checken der core-lib selbst ist der oberste Scope ihre eigene Symboltabelle
	// (sie wird ohne builtInSymbols gecheckt). Auch dann ist isBuiltIn korrekt:
	// innerhalb der core-lib sind Vorwärtsreferenzen erlaubt (kein usedBeforeDefined).
	const isBuiltIn = findResult.scopeIndex === 0;
	if (foundSymbol.functionParameterIndex !== undefined) {
		// TODO ParameterReference nur liefern, wenn Symbol im untersten Scope gefunden,
		// da ParameterReference auf höhere Funktionen problematisch ist?
		const parameterReference = createParameterReference(reference.name.name, foundSymbol.functionParameterIndex);
		parameterReference.functionRef = foundSymbol.functionRef;
		return {
			type: parameterReference,
			found: true,
			foundSymbol: foundSymbol,
			isBuiltIn: isBuiltIn,
		};
	}
	const referencedType = foundSymbol.typeInfo;
	if (!referencedType) {
		// Das Symbol wird gerade selbst gecheckt: eine Selbstreferenz. Ein Typ bekommt den
		// Alias-Knoten, der den Namen hält und erst auflöst, wenn das Symbol fertig ist -
		// unproduktive Zyklen sind hier bereits als JUL5170 gemeldet. Ein Wert (rekursive
		// Funktion) bleibt bei Any, sonst stünde sein Name fälschlich für einen Typ.
		return {
			type: isTypeName(name) && isSelfReference(reference, name)
				? createCompileTimeTypeOfType(createCompileTimeAliasType(name, foundSymbol))
				: builtinAny,
			found: true,
			foundSymbol: foundSymbol,
			isBuiltIn: isBuiltIn,
		};
	}
	// Jede Referenz auf eine Typdefinition trägt ihren Namen mit: nur so erscheint er an der
	// Schreibstelle statt des ausgeschriebenen Typs. Der Name gilt pro Schreibstelle, PositiveInteger
	// wird also nirgends zu GameCardId, nur weil GameCardId darauf zeigt.
	return {
		type: isTypeName(name) && referencedType.type.julType === 'typeOf'
			? createCompileTimeTypeOfType(createCompileTimeAliasType(name, foundSymbol))
			: referencedType.type,
		found: true,
		foundSymbol: foundSymbol,
		isBuiltIn: isBuiltIn,
	};
}

/**
 * Wie canHaveFields, aber Empty zählt nicht mit: Aus Empty liest jeder Zugriff Empty, über den
 * Namen wie über die Position. Or([] List(X)) trägt also ebenso wenig benannte Felder wie List(X).
 */
function canHaveFieldsBesideEmpty(rawType: CompileTimeType): boolean {
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'empty':
			return false;
		case 'or':
			return type.ChoiceTypes.some(canHaveFieldsBesideEmpty);
		default:
			return canHaveFields(type);
	}
}

/**
 * Kann dieser Typ überhaupt Positionen tragen?
 * Gegenstück zu canHaveFields, mit derselben Zweifelsregel.
 */
function canHaveIndexes(rawType: CompileTimeType): boolean {
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'boolean':
		case 'booleanLiteral':
		case 'dictionary':
		case 'dictionaryLiteral':
		case 'float':
		case 'floatLiteral':
		case 'integer':
		case 'integerLiteral':
		case 'text':
		case 'textLiteral':
			return false;
		default:
			return true;
	}
}

export function findSymbolInScopesWithBuiltIns(name: string, scopes: SymbolTable[]): {
	isBuiltIn: boolean;
	symbol: SymbolDefinition;
} | undefined {
	const builtInSymbol = builtInSymbols[name];
	if (builtInSymbol) {
		return {
			isBuiltIn: true,
			symbol: builtInSymbol,
		};
	}
	const ownSymbol = findSymbolInScopes(name, scopes);
	return ownSymbol && {
		isBuiltIn: false,
		symbol: ownSymbol.symbol,
	};
}

function findSymbolInScopes(name: string, scopes: SymbolTable[]): {
	symbol: SymbolDefinition,
	scopeIndex: number,
} | undefined {
	// beim untersten scope beginnen, damit ggf narrowed symbol gefunden wird
	for (let index = scopes.length - 1; index >= 0; index--) {
		const scope = scopes[index]!;
		const symbol = scope[name];
		if (symbol) {
			return {
				symbol: symbol,
				scopeIndex: index,
			};
		}
	}
}

function findParameterSymbol(
	expression: ParseParameterField,
	scopes: NonEmptyArray<SymbolTable>,
): SymbolDefinition {
	const currentScope = last(scopes);
	const parameterName = expression.name.name;
	const parameterSymbol = currentScope[parameterName];
	if (!parameterSymbol) {
		throw new Error(`parameterSymbol ${parameterName} not found`);
	}
	return parameterSymbol;
}

/**
 * Instanziiert die Signaturen der Callback-Parameter gegen die konkreten Argumente des Aufrufs.
 * Ein Parametertyp wie `TypeOf(values)/ElementType` in einer Callback-Signatur wird erst hier
 * konkret; ohne das bliebe er ein Platzhalter, den isTypeAssignable permissiv durchwinkt.
 *
 * Bewusst nur diese eine Verschachtelungsebene statt einer Erweiterung von traversePlaceholders:
 * dort steigt der argumentContext-Zweig nicht in Funktions- und Parameterknoten ab, und das
 * nachzurüsten zerstört die Auflösung generischer Rückgabetypen (`TypeOf(callback)/ReturnType`).
 */
function dereferenceCallbackParams(
	calledFunction: CompileTimeType,
	argsType: CompileTimeType,
	paramsType: CompileTimeType,
): CompileTimeType {
	if (!isParametersType(paramsType)) {
		return paramsType;
	}
	let changed = false;
	const dereferencedSingleNames = paramsType.singleNames.map(parameter => {
		const parameterType = parameter.type;
		if (!parameterType) {
			return parameter;
		}
		if (!isFunctionType(parameterType)) {
			// Ein Parametertyp wie `TypeOf(stream$)/ValueType` verweist auf ein anderes Argument und
			// wird erst mit dessen Typ prüfbar.
			const dereferenced = dereferenceArgumentTypesNested(calledFunction, argsType, parameterType);
			if (dereferenced === parameterType) {
				return parameter;
			}
			changed = true;
			return { name: parameter.name, type: dereferenced };
		}
		const callbackParamsType = parameterType.ParamsType;
		let callbackChanged = false;
		const dereferencedCallbackParamsType = isParametersType(callbackParamsType)
			? createParametersType(
				callbackParamsType.singleNames.map(callbackParameter => {
					const callbackParameterType = callbackParameter.type;
					if (!callbackParameterType) {
						return callbackParameter;
					}
					const dereferenced = dereferenceArgumentTypesNested(calledFunction, argsType, callbackParameterType);
					if (dereferenced === callbackParameterType) {
						return callbackParameter;
					}
					callbackChanged = true;
					return { name: callbackParameter.name, type: dereferenced };
				}),
				callbackParamsType.rest)
			: callbackParamsType;
		// Auch der Rückgabetyp kann einen Typparameter der aufgerufenen Funktion nennen (`:> T`).
		// Roh bliebe er ein Platzhalter, und der Rückgabewert des Callbacks würde nicht verglichen.
		const dereferencedCallbackReturnType = dereferenceArgumentTypesNested(calledFunction, argsType, parameterType.ReturnType);
		if (dereferencedCallbackReturnType !== parameterType.ReturnType) {
			callbackChanged = true;
		}
		if (!callbackChanged) {
			return parameter;
		}
		changed = true;
		const dereferencedCallbackType = createCompileTimeFunctionType(
			dereferencedCallbackParamsType,
			dereferencedCallbackReturnType,
			parameterType.purity,
			parameterType.aliasName,
			{ predicate: parameterType.predicate },
		);
		return { name: parameter.name, type: dereferencedCallbackType };
	});
	if (!changed) {
		return paramsType;
	}
	return createParametersType(dereferencedSingleNames, paramsType.rest);
}

//#region Signatur am Aufruf

/**
 * Ein Verweis wie `TypeOf(stream$)/ValueType` oder `TypeOf(values)/ElementType` in der Signatur einer
 * Funktion: der Parameter, auf den er zeigt, spielt die Rolle eines Typparameters.
 */
interface ParameterProjection {
	index: number;
	/** Von außen nach innen, bei `TypeOf(x)/ElementType/ValueType` also ElementType, ValueType. */
	path: ProjectionStep[];
	/** Der Verweis selbst, er wird gegen die Argumente aufgelöst. */
	reference: NestedReferenceType;
}

/**
 * Ein Schlüssel im Pfad. Hinter TypeOf ist er eine Eigenschaft des Typs (`TypeOf(values)/ElementType`),
 * sonst ein Feld des Werts (`point/x`) - wie beim Lesen, siehe dereferenceNameFromObject.
 */
interface ProjectionStep {
	name: string;
	ofType: boolean;
}

function getParameterProjections(functionType: CompileTimeFunctionType): ParameterProjection[] {
	const cached = parameterProjectionsCache.get(functionType);
	if (cached) {
		return cached;
	}
	const projections: ParameterProjection[] = [];
	const visit = (type: CompileTimeType): void => {
		if (type.julType === 'nestedReference') {
			const projection = getParameterProjection(type, functionType);
			if (projection) {
				projections.push(projection);
				return;
			}
		}
		forEachChildType(type, visit);
	};
	visit(functionType.ParamsType);
	visit(functionType.ReturnType);
	parameterProjectionsCache.set(functionType, projections);
	return projections;
}

function getParameterProjection(
	reference: NestedReferenceType,
	functionType: CompileTimeFunctionType,
): ParameterProjection | undefined {
	const path: ProjectionStep[] = [];
	let source: CompileTimeType = reference;
	while (source.julType === 'nestedReference') {
		if (typeof source.nestedKey !== 'string') {
			return undefined;
		}
		path.unshift({ name: source.nestedKey, ofType: source.source.julType === 'typeOf' });
		source = source.source;
	}
	if (source.julType === 'typeOf') {
		source = source.value;
	}
	if (source.julType !== 'parameterReference'
		|| source.functionRef !== functionType.identity) {
		return undefined;
	}
	return { index: source.index, path: path, reference: reference };
}

/**
 * Setzt in die Parameter, auf die ein Verweis zeigt, den projizierten Argumenttyp ein - in die
 * deklarierte Form, nicht den ganzen Argumenttyp: aus `stream$: Stream(Any)` wird am Aufruf
 * `Stream(Or([] PlayerInput))`, wie ein Typparameter in TypeScript. So bleibt jede Zeile eine
 * Anforderung. Lässt sich der Verweis nicht auflösen (falsches Argument), bleibt der Parameter
 * deklariert.
 */
function substituteParameterProjections(
	resolvedFunctionType: CompileTimeFunctionType,
	calledFunction: CompileTimeType,
	argsType: CompileTimeType,
	paramsType: CompileTimeType,
): CompileTimeType {
	if (!isParametersType(paramsType)) {
		return paramsType;
	}
	const projections = getParameterProjections(resolvedFunctionType);
	if (!projections.length) {
		return paramsType;
	}
	let changed = false;
	const substitutedSingleNames = paramsType.singleNames.map((parameter, index) => {
		const parameterType = parameter.type;
		if (!parameterType) {
			return parameter;
		}
		const substituted = projections.reduce<CompileTimeType>(
			(currentType, projection) => {
				if (projection.index !== index) {
					return currentType;
				}
				const projected = dereferenceArgumentTypesNested(calledFunction, argsType, projection.reference);
				// Empty und Never sagen nichts über die Form: aus einem leeren Argument würde sonst
				// List(Empty).
				if (projected.isUnresolvedPlaceholder
					|| projected.julType === 'any'
					|| projected.julType === 'empty'
					|| projected.julType === 'never') {
					return currentType;
				}
				return substituteProjection(currentType, projection.path, projected);
			},
			parameterType);
		if (substituted === parameterType) {
			return parameter;
		}
		changed = true;
		return { name: parameter.name, type: substituted };
	});
	if (!changed) {
		return paramsType;
	}
	return createParametersType(substitutedSingleNames, paramsType.rest);
}

/**
 * Schreibt projected an die Stelle, die path in declared bezeichnet, über dieselben Tabellen, über
 * die auch gelesen wird. Or wird durchgereicht, damit `Or([] List(Any))` das Empty behält. Eine
 * Form ohne diese Eigenschaft bleibt, wie sie ist.
 */
function substituteProjection(
	declared: CompileTimeType,
	path: ProjectionStep[],
	projected: CompileTimeType,
): CompileTimeType {
	const [step, ...restPath] = path;
	if (step === undefined) {
		return projected;
	}
	const resolved = resolveAlias(declared);
	if (resolved.julType === 'or') {
		const choices = resolved.ChoiceTypes;
		const substitutedChoices = choices.map(choice => substituteProjection(choice, path, projected));
		return elementsEqual(choices, substitutedChoices)
			? declared
			: createNormalizedUnionType(substitutedChoices);
	}
	const access = getNamedAccess(step.ofType ? typePropertyAccess : valueFieldAccess, resolved);
	const current = access?.get(resolved, step.name);
	if (!access || !current) {
		return declared;
	}
	// Gelesen ergibt eine Typeigenschaft einen Typwert, in die Form gehört aber der Typ selbst:
	// aus Stream(Any) wird Stream(Integer), nicht Stream(TypeOf(Integer)).
	const leaf = !restPath.length
		&& projected.julType === 'typeOf'
		&& (step.ofType || isTypePropertyOfValue(resolved.julType, step.name))
		? projected.value
		: projected;
	const substituted = substituteProjection(current, restPath, leaf);
	return access.set(resolved, step.name, substituted) ?? declared;
}

//#endregion Signatur am Aufruf

/**
 * Bindet den Empfänger von a.f(b) als erstes Argument in die Argumentkollektion, danach ist er nur
 * noch ein Argument. Tuple und leere Argumente werden zu einem Tuple mit dem Empfänger vorn, so
 * hängt ihn auch die Laufzeit an. Sonst Concat([Empfänger] args): bei benannten Argumenten ist der
 * Schlüssel des ersten Parameters in Checker und Laufzeit verschieden (name gegen source ?? name),
 * und vor einer List ginge beim Falten verloren, dass der Empfänger an erster Stelle steht.
 */
export function bindReceiver(
	receiverType: CompileTimeType | undefined,
	rawArgsType: CompileTimeType,
): CompileTimeType {
	if (!receiverType) {
		return rawArgsType;
	}
	const argsType = resolveAlias(rawArgsType);
	switch (argsType.julType) {
		case 'empty':
			return createCompileTimeTupleType([receiverType]);
		case 'tuple':
			return createCompileTimeTupleType([receiverType, ...argsType.ElementTypes]);
		default:
			return createCompileTimeConcatType([createCompileTimeTupleType([receiverType]), rawArgsType]);
	}
}

//#endregion dereference

export interface CheckOptions {
	/**
	 * Der Checker schreibt seine Ergebnisse (typeInfo, Fehler) in den Baum und überspringt
	 * Ausdrücke, die schon eine typeInfo haben. Wer dieselbe Datei später ohne neues Parsen erneut
	 * checkt (Language Server: Abhängige nach Änderung eines Imports), braucht deshalb checked als
	 * Klon von unchecked. Sonst ist checked dasselbe Objekt wie unchecked - das spart bei großen
	 * Dateien den Großteil der Ladezeit. Pflicht, damit jeder Aufrufer das ausdrücklich entscheidet.
	 */
	readonly cloneUnchecked: boolean;
	/**
	 * Wird während des Checklaufs mit den aufgelösten Referenzen der Datei befüllt (vorher
	 * geleert). Nur der Language Server hält einen Index über die Lebensdauer mehrerer Checkläufe
	 * hinweg; CLI und Tests lassen ihn weg und zahlen keine Buchführungskosten.
	 */
	readonly referenceIndex?: ReferenceIndex;
	/**
	 * Wird während des Checklaufs regelmäßig aufgerufen, damit der Aufrufer aus der synchronen
	 * Arbeit heraus etwas tun kann, wofür sein Event-Loop nicht drankommt (CLI: Fortschritt
	 * zeichnen). Der Abstand ist eine Anzahl inferierter Ausdrücke, keine Zeit.
	 */
	readonly onProgress?: () => void;
	/**
	 * Ob für diese Datei ein unknown an einer meldenden Stelle (Definition mit Typ, Argument,
	 * Rückgabewert) als Warnung typeNotProven gemeldet wird. Fehlt die Funktion, wird nicht gemeldet.
	 * Eine Funktion statt eines Werts, weil der Language Server mehrere Projekte mit je eigener
	 * jul-config.yaml hält.
	 */
	readonly warnUnknown?: (filePath: string) => boolean;
}

/**
 * infer types of expressions, normalize typeGuards
 * fills errors
 */
export function checkTypes(
	document: ParsedFile,
	documents: ParsedDocuments,
	options: CheckOptions,
): void {
	const { cloneUnchecked, referenceIndex, onProgress } = options;
	referenceIndex?.clearReferencesFromFile(document.filePath);
	resetFoldBudget();
	const checked = cloneUnchecked
		? structuredClone(document.unchecked)
		: document.unchecked;
	document.checked = checked;
	// Die core-lib definiert die builtInSymbols selbst. Bekäme sie sie zusätzlich als oberen
	// Scope, stünde ihre Symboltabelle zweimal im Stack und jede Definition wäre
	// alreadyDefinedInUpperScope. Daher ohne Scopes checken, genau wie beim initialen Laden.
	const scopes = isCoreLibPath(document.filePath)
		? []
		: [builtInSymbols];
	inferFileTypes(scopes, {
		documents: documents,
		file: checked,
		folder: document.sourceFolder,
		filePath: document.filePath,
		referenceIndex: referenceIndex,
		onProgress: onProgress,
		warnUnknown: !isCoreLibPath(document.filePath)
			&& !isTypeScriptFile(document.filePath)
			&& !!options.warnUnknown?.(document.filePath),
	});
	if (extname(document.filePath) === Extension.jul
		&& !isCoreLibPath(document.filePath)) {
		reportUnusedDefinitions(checked);
		reportStreamsWithoutEnd(checked.expressions, checked.errors);
	}
	if (isTestFilePath(document.filePath)) {
		reportDuplicateTestNames(checked);
	}
	// Zuletzt, erst dann stehen alle Warnungen der Datei fest.
	applyIgnoreComments(checked);
}

//#region ungenutzte Definitionen

/**
 * Meldet lokale Bindungen, die keine Referenz gefunden hat (isUsed).
 * Ausgenommen ist, was außerhalb des Scopes noch ankommt: Top-Level-Definitionen sind exportiert,
 * die letzte Definition eines Funktionsrumpfs ist sein Rückgabewert, Parameter werden vom Aufrufer
 * belegt. Destructuring auf oberster Ebene wird nicht exportiert und daher geprüft.
 */
function reportUnusedDefinitions(file: ParsedExpressions2): void {
	const { errors } = file;
	forEach(file.symbols, (symbol, name) => {
		if (symbol.definition?.type === 'destructuringField') {
			reportIfUnused(symbol, name, errors);
		}
	});
	file.expressions?.forEach(expression => {
		reportUnusedInFunctionBodies(expression, errors);
	});
}

function reportUnusedInFunctionBodies(expression: PositionedExpression, errors: CompilerError[]): void {
	if (expression.type === 'functionLiteral') {
		const returnedDefinition = last(expression.body);
		forEach(expression.symbols, (symbol, name) => {
			const definition = symbol.definition;
			if ((definition?.type === 'definition' && definition !== returnedDefinition)
				|| definition?.type === 'destructuringField') {
				reportIfUnused(symbol, name, errors);
			}
		});
	}
	forEachChild(expression, child => {
		reportUnusedInFunctionBodies(child, errors);
	});
}

function reportIfUnused(symbol: SymbolDefinition, name: string, errors: CompilerError[]): void {
	if (symbol.isUsed) {
		return;
	}
	errors.push({
		code: ErrorCode.unusedDefinition,
		message: `'${name}' is defined but never used.`,
		startRowIndex: symbol.startRowIndex,
		startColumnIndex: symbol.startColumnIndex,
		endRowIndex: symbol.endRowIndex,
		endColumnIndex: symbol.endColumnIndex,
	});
}

/**
 * Liegt der Ausdruck innerhalb von ancestor (oder ist er es selbst)?
 */
function isInside(expression: PositionedExpression, ancestor: PositionedExpression | undefined): boolean {
	if (!ancestor) {
		return false;
	}
	for (let current: PositionedExpression | undefined = expression; current; current = current.parent) {
		if (current === ancestor) {
			return true;
		}
	}
	return false;
}

//#endregion ungenutzte Definitionen

function inferFileTypes(
	scopes: SymbolTable[],
	checkContext: CheckContext,
): void {
	const { file } = checkContext;
	const fileScopes = [
		...scopes,
		file.symbols,
	] as any as NonEmptyArray<SymbolTable>;
	registerCompletedNames(file.symbols, file.expressions ?? []);
	file.expressions?.forEach(expression => {
		setInferredType(expression, { scopes: fileScopes, narrowedTypes: undefined }, undefined, checkContext);
	});
}

function registerCompletedNames(scope: SymbolTable, body: readonly PositionedExpression[]): void {
	if (!completedNamesByScope.has(scope)) {
		completedNamesByScope.set(scope, collectCompletedNames(body));
	}
}

/**
 * Ein Stream, auf den im Rumpf seiner Definition complete steht, endet: nach außen wie im Rumpf
 * ein FiniteStream. Andere Typen bleiben unverändert.
 */
function withCompletedStream(typeInfo: TypeInfo, scope: SymbolTable, name: string): TypeInfo {
	if (!completedNamesByScope.get(scope)?.has(name)) {
		return typeInfo;
	}
	const resolved = resolvePlaceholders(typeInfo.type);
	if (resolved.julType !== 'stream' || resolved.finite) {
		return typeInfo;
	}
	return {
		...typeInfo,
		type: createCompileTimeStreamType(resolved.ValueType, true),
	};
}

/**
 * Was für einen ganzen checkTypes-Lauf gilt, im Unterschied zu TypeContext, das sich je Stelle im
 * Baum ändert. Eine neue Angabe für den Lauf wird hier ein Feld, statt durch alle gegenseitig
 * rekursiven inferType/setInferredType-Aufrufe als eigener Parameter zu wandern.
 */
interface CheckContext {
	readonly documents: ParsedDocuments;
	readonly file: ParsedExpressions2;
	/**
	 * Leerstring, wenn builtin.
	 */
	readonly folder: string;
	/**
	 * Leerstring, wenn builtin.
	 */
	readonly filePath: string;
	/** Siehe CheckOptions. */
	readonly referenceIndex: ReferenceIndex | undefined;
	/** Siehe CheckOptions. */
	readonly onProgress: (() => void) | undefined;
	/**
	 * Ob ein unknown an einer meldenden Stelle als Warnung gemeldet wird: nur für .jul-Dateien des
	 * Projekts, nicht für die core-lib und nicht für TS/JS, deren Rumpf nur ein Artefakt des Parsers ist.
	 */
	readonly warnUnknown: boolean;
}

/**
 * Unter welchem Kontext ein Ausdruck typisiert wird: was hier sichtbar ist und was zusätzlich
 * über Pfade bekannt ist. Beides ändert sich nur gemeinsam, beim Eintritt in einen Funktionsrumpf.
 */
interface TypeContext {
	scopes: NonEmptyArray<SymbolTable>;
	/** Verengte Typen des umgebenden branch-Rumpfs. Undefined außerhalb jedes branchings. */
	narrowedTypes: NarrowedTypes | undefined;
}

//#region branch narrowing

/**
 * Verengte Typen je Zugriffspfad, gültig im Rumpf eines branches.
 * Die Wurzel ist die Identität des Symbols, nicht sein Name: Ein Nachschlag für einen nicht
 * verengten Ausdruck kostet damit einen Zugriff, unabhängig von der Schachtelungstiefe - und
 * praktisch jeder Nachschlag ist ein Fehlschlag.
 */
type NarrowedTypes = Map<SymbolDefinition, NarrowedPath[]>;

interface NarrowedPath {
	/** Feldnamen und Indizes ab der Wurzel. Leer = die Wurzel selbst. */
	keys: (string | number)[];
	type: CompileTimeType;
}

interface AccessPath {
	symbol: SymbolDefinition;
	keys: (string | number)[];
}

/**
 * Der Zugriffspfad, den dieser Ausdruck bezeichnet.
 * undefined, sobald ein Glied kein Name und kein literaler Schlüssel ist - ein Aufruf als Quelle
 * (getStep(flag)/type) bezeichnet keinen Pfad, denn zwei Aufrufe sind zwei Werte.
 */
function getAccessPath(
	expression: ParseValueExpression,
	scopes: SymbolTable[],
): AccessPath | undefined {
	switch (expression.type) {
		case 'reference': {
			const symbol = findSymbolInScopesWithBuiltIns(expression.name.name, scopes)?.symbol;
			return symbol && {
				symbol: symbol,
				keys: [],
			};
		}
		case 'nestedReference': {
			const nestedKey = expression.nestedKey;
			if (!nestedKey) {
				return undefined;
			}
			const sourcePath = getAccessPath(expression.source, scopes);
			if (!sourcePath) {
				return undefined;
			}
			const key = nestedKey.type === 'index'
				? nestedKey.name
				: getCheckedEscapableName(nestedKey);
			if (key === undefined) {
				return undefined;
			}
			return {
				symbol: sourcePath.symbol,
				keys: [...sourcePath.keys, key],
			};
		}
		default:
			return undefined;
	}
}

/**
 * Der verengte Typ für diesen Pfad, falls einer bekannt ist.
 * Trifft kein Eintrag genau, wird vom längsten passenden Präfix aus dereferenziert - so wirkt ein
 * Eintrag für die Quelle auch auf alle Felder darunter.
 */
function getNarrowedType(
	narrowedTypes: NarrowedTypes | undefined,
	symbol: SymbolDefinition,
	keys: (string | number)[],
): CompileTimeType | undefined {
	const paths = narrowedTypes?.get(symbol);
	if (!paths) {
		return undefined;
	}
	let longestMatch: NarrowedPath | undefined = undefined;
	for (const path of paths) {
		if (path.keys.length > keys.length
			|| (longestMatch && path.keys.length <= longestMatch.keys.length)) {
			continue;
		}
		if (path.keys.every((key, index) => key === keys[index])) {
			longestMatch = path;
		}
	}
	if (!longestMatch) {
		return undefined;
	}
	let type = longestMatch.type;
	for (const key of keys.slice(longestMatch.keys.length)) {
		// Die Verengung legt ein And über den noch unaufgelösten Typ der Quelle ab (etwa einen
		// Parameter). dereferenceNestedKeyFromObject behandelt And nicht und fiele auf Any, erst
		// der aufgelöste Typ kennt seine Felder.
		const sourceType = type.julType === 'and'
			? resolvePlaceholders(type)
			: type;
		const dereferenced = dereferenceNestedKeyFromObject(key, sourceType);
		if (!dereferenced) {
			return undefined;
		}
		type = dereferenced;
	}
	return type;
}

/**
 * Eine neue Umgebung mit diesem Eintrag. Ein vorhandener Eintrag für denselben Pfad wird ersetzt,
 * nicht ergänzt - der neue Typ entsteht als Schnitt mit dem alten und ist damit der engere.
 */
function withNarrowedType(
	narrowedTypes: NarrowedTypes | undefined,
	symbol: SymbolDefinition,
	keys: (string | number)[],
	type: CompileTimeType,
): NarrowedTypes {
	const result: NarrowedTypes = new Map(narrowedTypes);
	const paths = result.get(symbol) ?? [];
	const withoutPath = paths.filter(path =>
		path.keys.length !== keys.length
		|| !path.keys.every((key, index) => key === keys[index]));
	result.set(symbol, [
		...withoutPath,
		{
			keys: keys,
			type: type,
		},
	]);
	return result;
}

/**
 * Eine neue Umgebung, in der dieser Ausdruck den Typ hat - und mit ihm jede Quelle darüber:
 * dass step/type ein Text ist, beweist, dass step nicht empty ist, denn Empty hat kein Feld.
 * Index-Pfade tragen diesen Schluss noch nicht.
 */
function withNarrowedPath(
	narrowedTypes: NarrowedTypes | undefined,
	expression: ParseValueExpression,
	type: CompileTimeType,
	scopes: SymbolTable[],
): NarrowedTypes | undefined {
	const path = getAccessPath(expression, scopes);
	if (!path) {
		return narrowedTypes;
	}
	let result = withNarrowedType(narrowedTypes, path.symbol, path.keys, type);
	let narrowedExpression: ParseValueExpression = expression;
	let narrowedType = type;
	while (narrowedExpression.type === 'nestedReference') {
		const source = narrowedExpression.source;
		const nestedKey = narrowedExpression.nestedKey;
		const key = nestedKey && nestedKey.type !== 'index'
			? getCheckedEscapableName(nestedKey)
			: undefined;
		const sourcePath = key
			? getAccessPath(source, scopes)
			: undefined;
		if (!key
			|| !sourcePath) {
			break;
		}
		const sourceType = getNarrowedType(result, sourcePath.symbol, sourcePath.keys)
			?? source.typeInfo?.type
			?? builtinAny;
		narrowedType = createNormalizedIntersectionType([
			sourceType,
			// complete: false, denn der branch beweist nur diesen einen Fakt - über andere
			// Felder der Quelle ist damit nichts gesagt.
			createCompileTimeDictionaryLiteralType({ [key]: narrowedType }, false),
		]);
		result = withNarrowedType(result, sourcePath.symbol, sourcePath.keys, narrowedType);
		narrowedExpression = source;
	}
	return result;
}

/**
 * Der Ausdruck, aus dem der Wert dieses Symbols stammt - falls das ein Feldzugriff war.
 * Ein Name bezeichnet in JUL genau einen Wert, was über ihn gilt, gilt also auch über seine
 * Herkunft. Nur für Feldzugriffe, denn zwei Aufrufe sind zwei Werte.
 */
function getOriginExpression(symbol: SymbolDefinition): ParseValueExpression | undefined {
	const definition = symbol.definition;
	if (definition?.type !== 'definition') {
		return undefined;
	}
	const value = definition.value;
	return value?.type === 'nestedReference'
		? value
		: undefined;
}

/**
 * Die geschriebenen Werte einer Kollektion, Index für Index.
 * undefined, wenn sich kein Ausdruck zuordnen lässt - dann wird weder verengt noch gemeldet.
 */
function getWrittenArguments(args: ParseValueExpression | undefined): ParseValueExpression[] | undefined {
	if (args?.type !== 'list') {
		return undefined;
	}
	// Ein Spread verschiebt alle folgenden Indizes unbekannt weit, damit ist keinem Element
	// mehr ein Ausdruck zuzuordnen.
	if (args.values.some(value => value.type === 'spread')) {
		return undefined;
	}
	return args.values as ParseValueExpression[];
}

/**
 * Der Typ, den Argument argumentIndex in diesem branch erfüllen muss.
 * undefined = der branch sagt nichts über dieses Argument aus, es wird also nicht verengt.
 */
function getBranchArgumentType(
	paramsType: CompileTimeType,
	argumentIndex: number,
): CompileTimeType | undefined {
	const rawArgumentType = getRawBranchArgumentType(paramsType, argumentIndex);
	// Ein Funktionswert im Kopf ist hier schon ein Prädikat (valueOf), mit dem geschnitten und
	// das abgezogen werden kann wie jeder andere Typ.
	return rawArgumentType && resolveAlias(rawArgumentType);
}

/**
 * Höchstens diese Werte liegen im Typ: ein Prädikat zählt mit seiner Obermenge, unter Not mit
 * seiner Untermenge. Für die Frage "könnte der Wert hier liegen".
 */
function getUpperBoundType(type: CompileTimeType): CompileTimeType {
	return mapBoundType(type, true);
}

/**
 * Mindestens diese Werte liegen im Typ: ein Prädikat zählt nur mit dem, wofür es nachweislich
 * true liefert. Für die Frage "fängt dieser Kopf den Wert sicher ab".
 */
function getLowerBoundType(type: CompileTimeType): CompileTimeType {
	return mapBoundType(type, false);
}

function mapBoundType(rawType: CompileTimeType, upper: boolean): CompileTimeType {
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'predicate':
			return upper
				? type.UpperBound
				: type.LowerBound;
		case 'not': {
			const source = mapBoundType(type.SourceType, !upper);
			return source === type.SourceType
				? type
				: createNormalizedComplementType(source);
		}
		case 'or':
		case 'and': {
			const choices = type.ChoiceTypes.map(choice => mapBoundType(choice, upper));
			if (elementsEqual(choices, type.ChoiceTypes)) {
				return type;
			}
			return type.julType === 'or'
				? createNormalizedUnionType(choices)
				: createNormalizedIntersectionType(choices);
		}
		case 'tuple': {
			const elements = type.ElementTypes.map(element => mapBoundType(element, upper));
			return elementsEqual(elements, type.ElementTypes)
				? type
				: createCompileTimeTupleType(elements);
		}
		default:
			return type;
	}
}

/**
 * Not mit den beiden Randfällen, die als Quelle sonst permissiv blieben: Not(Never) ist alles,
 * Not(Any) nichts.
 */
function createNormalizedComplementType(source: CompileTimeType): CompileTimeType {
	const resolved = resolveAlias(source);
	switch (resolved.julType) {
		case 'never':
			return builtinAny;
		case 'any':
			return builtinNever;
		default:
			return createCompileTimeComplementType(source);
	}
}

function getRawBranchArgumentType(
	paramsType: CompileTimeType,
	argumentIndex: number,
): CompileTimeType | undefined {
	if (!isParametersType(paramsType)) {
		// Typ-Kopf: beschreibt die Argumentkollektion, das Argument ist deren Element
		return getElementTypeAtIndex(paramsType, argumentIndex);
	}
	const singleNames = paramsType.singleNames;
	const rest = paramsType.rest;
	if (!singleNames.length
		&& !rest) {
		// catchAll () => ...: matcht jede Kollektion und bindet nichts
		return undefined;
	}
	const singleName = singleNames[argumentIndex];
	if (singleName) {
		return singleName.type;
	}
	return rest
		? getElementTypeAtIndex(rest.type, argumentIndex - singleNames.length)
		: undefined;
}

/**
 * Ob die branches beweisbar jeden möglichen Wert von args abdecken - nur für den Fall eines
 * einzelnen, nicht destrukturierten Arguments (?(x)). Bei mehreren Argumenten oder wenn sich
 * args/branch-Typen nicht auflösen lassen, konservativ false: dann bleibt Error im Rückgabetyp.
 * Syntaktisches catchAll ((), Any) wird vom Aufrufer schon vorher geprüft.
 */
function isBranchingExhaustive(
	args: ParseValueExpression | undefined,
	branches: ParseValueExpression[],
): boolean {
	const argsType = args?.typeInfo && resolvePlaceholders(args.typeInfo.type);
	if (!argsType) {
		return false;
	}
	// args ist die Argumentkollektion (Tuple/List/...), nicht der Wert selbst - dieselbe
	// Auflösung wie getBranchArgumentType für den Typ-Kopf-Fall.
	const argValueType = getElementTypeAtIndex(argsType, 0);
	if (!argValueType) {
		return false;
	}
	const branchValueTypes = branches.map(branch => {
		const paramsType = getParamsType(branch.typeInfo && resolvePlaceholders(branch.typeInfo.type));
		return getBranchArgumentType(paramsType, 0);
	});
	if (branchValueTypes.some(valueType => !valueType)) {
		// undefined heißt hier: nicht bestimmbar (catchAll wurde vom Aufrufer schon ausgeschlossen)
		return false;
	}
	const combinedType = createNormalizedUnionType(branchValueTypes as CompileTimeType[]);
	// Abgedeckt ist nur, was die Köpfe sicher abfangen: von einem Prädikat die Untermenge. Oder
	// es bleibt nach dem Abziehen nichts übrig - dort greift die Identität, sodass isEven im
	// Kopf den isEven-Anteil des Arguments abdeckt. Abgezogen wird Kopf für Kopf: die ganze
	// Union auf einmal würde über das Or des Arguments verteilt und nie mit dem gleichen Kopf
	// verglichen.
	// Nicht erschöpfend heißt: Error kommt in den Rückgabetyp, und das wird an der Verwendung zum
	// Fehler. Das darf nur ein Beweis auslösen (Prinzip Freiheit), unbekannt gilt als erschöpfend.
	if (isSubtypeOf(argValueType, getLowerBoundType(combinedType)) !== false) {
		return true;
	}
	const remainingType = (branchValueTypes as CompileTimeType[]).reduce<CompileTimeType>(
		(remaining, branchValueType) =>
			createNormalizedIntersectionType([remaining, createCompileTimeComplementType(branchValueType)]),
		argValueType);
	return resolveAlias(remainingType).julType === 'never';
}

/**
 * Ob der Kopf dieses branches beweisbar keinen Wert der Argumente trifft: An einer Stelle
 * haben Argument und Kopf keinen gemeinsamen Wert. Was sich nicht entscheiden lässt, gilt
 * als erreichbar.
 */
function isBranchDisjointToArgs(
	args: ParseValueExpression | undefined,
	branch: ParseValueExpression,
): boolean {
	const argsType = args?.typeInfo && resolvePlaceholders(args.typeInfo.type);
	if (!argsType) {
		return false;
	}
	const paramsType = getParamsType(branch.typeInfo && resolvePlaceholders(branch.typeInfo.type));
	const headLength = getBranchHeadLength(paramsType);
	for (let argumentIndex = 0; argumentIndex < headLength; argumentIndex++) {
		const headType = getBranchArgumentType(paramsType, argumentIndex);
		if (!headType) {
			continue;
		}
		const argumentType = getArgumentTypeAtIndex(argsType, argumentIndex);
		if (argumentType
			&& typesOverlap(argumentType, headType) === false) {
			return true;
		}
	}
	return false;
}

/**
 * Anzahl der Stellen, die ein branch-Kopf einzeln benennt. Ein Rest-Parameter und eine Liste
 * als Typ-Kopf zählen nicht mit, ihre Länge ist offen.
 */
function getBranchHeadLength(paramsType: CompileTimeType): number {
	if (isParametersType(paramsType)) {
		return paramsType.singleNames.length;
	}
	const resolvedType = resolveAlias(paramsType);
	return resolvedType.julType === 'tuple'
		? resolvedType.ElementTypes.length
		: 0;
}

/**
 * Der Typ des Arguments an dieser Stelle der Argumentkollektion. Fehlt die Stelle in einem
 * Tuple, kommt dort Empty an. undefined, wenn er sich nicht bestimmen lässt.
 */
function getArgumentTypeAtIndex(
	argsType: CompileTimeType,
	index: number,
): CompileTimeType | undefined {
	const resolvedType = resolveAlias(argsType);
	switch (resolvedType.julType) {
		case 'empty':
			return builtinEmpty;
		case 'tuple':
			return resolvedType.ElementTypes[index] ?? builtinEmpty;
		case 'or': {
			const choiceTypes: CompileTimeType[] = [];
			for (const choiceType of resolvedType.ChoiceTypes) {
				const elementType = getArgumentTypeAtIndex(choiceType, index);
				if (!elementType) {
					return undefined;
				}
				choiceTypes.push(elementType);
			}
			return createNormalizedUnionType(choiceTypes);
		}
		// Bei List steht die Länge nicht fest, bei Dictionary hängt die Stelle an den Namen.
		default:
			return undefined;
	}
}

//#region erwarteter Typ

/**
 * Any verlangt nichts und zählt deshalb wie kein erwarteter Typ. Das spart die Arbeit in allen
 * Teilbäumen unter Any-Parametern.
 */
function toExpectedType(type: CompileTimeType | undefined): CompileTimeType | undefined {
	return type && type.julType !== 'any'
		? type
		: undefined;
}

/**
 * Wendet getChildType auf jeden Zweig einer Union an. Zweige ohne Ergebnis fallen weg, sie können
 * das Literal nicht aufnehmen (z.B. Empty bei Or([] List(X))).
 */
function getExpectedChildTypeOfUnion(
	choiceTypes: CompileTimeType[],
	getChildType: (choiceType: CompileTimeType) => CompileTimeType | undefined,
): CompileTimeType | undefined {
	const childTypes: CompileTimeType[] = [];
	for (const choiceType of choiceTypes) {
		const childType = getChildType(choiceType);
		if (childType) {
			childTypes.push(childType);
		}
	}
	switch (childTypes.length) {
		case 0:
			return undefined;
		case 1:
			return childTypes[0];
		default:
			return createNormalizedUnionType(childTypes);
	}
}

/**
 * Der erwartete Typ des Elements an Position index eines Listen-Literals bzw. des Arguments an
 * Position index einer Argumentliste.
 */
function getExpectedElementType(
	expectedType: CompileTimeType | undefined,
	index: number,
): CompileTimeType | undefined {
	if (!expectedType) {
		return undefined;
	}
	const type = resolveAlias(expectedType);
	switch (type.julType) {
		case 'list':
			return toExpectedType(type.ElementType);
		case 'tuple':
			return toExpectedType(type.ElementTypes[index]);
		case 'parameters':
			return toExpectedType(getRawBranchArgumentType(type, index));
		case 'or':
			return getExpectedChildTypeOfUnion(type.ChoiceTypes, choiceType =>
				getExpectedElementType(choiceType, index));
		default:
			return undefined;
	}
}

/**
 * Der erwartete Typ eines Elements hinter einem Spread, dessen Position damit unbekannt ist. Das
 * geht nur, wo jede in Frage kommende Position dasselbe verlangt: bei List(X) und beim
 * Rest-Parameter, sofern der erste Spread nicht vor ihm beginnt.
 */
function getExpectedElementTypeAfterSpread(
	expectedType: CompileTimeType | undefined,
	/**
	 * Position des ersten Spreads, samt Präfix-Argument.
	 */
	firstSpreadIndex: number,
): CompileTimeType | undefined {
	if (!expectedType) {
		return undefined;
	}
	const type = resolveAlias(expectedType);
	switch (type.julType) {
		case 'list':
			return toExpectedType(type.ElementType);
		case 'parameters':
			if (!type.rest || firstSpreadIndex < type.singleNames.length) {
				return undefined;
			}
			return getExpectedElementTypeAfterSpread(type.rest.type, firstSpreadIndex - type.singleNames.length);
		case 'or':
			return getExpectedChildTypeOfUnion(type.ChoiceTypes, choiceType =>
				getExpectedElementTypeAfterSpread(choiceType, firstSpreadIndex));
		default:
			return undefined;
	}
}

/**
 * Der erwartete Typ des Felds fieldName eines Dictionary-Literals bzw. des benannten Arguments
 * fieldName.
 */
function getExpectedFieldType(
	expectedType: CompileTimeType | undefined,
	fieldName: string,
): CompileTimeType | undefined {
	if (!expectedType) {
		return undefined;
	}
	const type = resolveAlias(expectedType);
	switch (type.julType) {
		case 'dictionaryLiteral':
			return toExpectedType(type.Fields[fieldName]);
		case 'dictionary':
			return toExpectedType(type.ElementType);
		case 'parameters':
			return toExpectedType(type.singleNames.find(parameter => parameter.name === fieldName)?.type);
		case 'or':
			return getExpectedChildTypeOfUnion(type.ChoiceTypes, choiceType =>
				getExpectedFieldType(choiceType, fieldName));
		default:
			return undefined;
	}
}

/**
 * Der Funktionstyp, den ein Funktionsliteral erfüllen muss. Aus einer Union zählen nur die
 * Zweige, die ein Funktionsliteral aufnehmen können. Bleiben mehrere, ist nicht entscheidbar,
 * welcher gemeint ist - dann gibt es keinen.
 */
function getExpectedFunctionType(expectedType: CompileTimeType | undefined): CompileTimeFunctionType | undefined {
	if (!expectedType) {
		return undefined;
	}
	const type = resolveAlias(expectedType);
	if (isFunctionType(type)) {
		return type;
	}
	if (!isUnionType(type)) {
		return undefined;
	}
	const functionTypes = type.ChoiceTypes
		.map(choiceType => resolveAlias(choiceType))
		.filter(isFunctionType);
	return functionTypes.length === 1
		? functionTypes[0]
		: undefined;
}

/**
 * Die ausgeschriebenen Feldnamen eines Dictionary-Literals.
 * undefined bei einem Spread, dessen Felder sind nicht ausgeschrieben.
 */
function getWrittenFieldNames(dictionary: ParseDictionaryLiteral): Set<string> | undefined {
	const fieldNames = new Set<string>();
	for (const field of dictionary.fields) {
		if (field.type === 'spread') {
			return undefined;
		}
		const fieldName = getCheckedEscapableName(field.name);
		if (fieldName !== undefined) {
			fieldNames.add(fieldName);
		}
	}
	return fieldNames;
}

/**
 * Sortiert aus einer Union die Zweige aus, die ein Dictionary-Literal nicht aufnehmen können:
 * - ein schon inferiertes Feld widerspricht dem Feldtyp des Zweigs (diskriminierte Union:
 *   kind = §a§ passt nicht zu [kind: §b§ ...])
 * - der Zweig verlangt ein Feld, das im Literal nicht ausgeschrieben ist. Ein Feld, dessen Typ
 *   Empty zulässt, darf fehlen.
 * Ein Zweig fällt nur bei einem nachgewiesenen Widerspruch weg.
 */
function narrowExpectedTypeByFields(
	expectedType: CompileTimeType | undefined,
	fieldTypes: CompileTimeDictionary,
	/**
	 * Alle ausgeschriebenen Feldnamen des Literals, auch die noch nicht inferierten.
	 * undefined bei einem Spread im Literal: dessen Felder sind nicht bekannt, es wird dann nicht
	 * auf fehlende Felder geprüft.
	 */
	writtenFieldNames: Set<string> | undefined,
): CompileTimeType | undefined {
	if (!expectedType) {
		return undefined;
	}
	const type = resolveAlias(expectedType);
	if (!isUnionType(type)) {
		return expectedType;
	}
	const matchingChoiceTypes = type.ChoiceTypes.filter(choiceType => {
		const resolvedChoiceType = resolveAlias(choiceType);
		if (isDictionaryType(resolvedChoiceType)) {
			return true;
		}
		if (!isDictionaryLiteralType(resolvedChoiceType)) {
			return false;
		}
		for (const fieldName in fieldTypes) {
			const choiceFieldType = resolvedChoiceType.Fields[fieldName];
			if (choiceFieldType
				&& isSubtypeOf(resolvePlaceholders(fieldTypes[fieldName]!), resolvePlaceholders(choiceFieldType)) === false) {
				return false;
			}
		}
		if (writtenFieldNames) {
			for (const fieldName in resolvedChoiceType.Fields) {
				if (!writtenFieldNames.has(fieldName)
					&& isSubtypeOf(builtinEmpty, resolvePlaceholders(resolvedChoiceType.Fields[fieldName]!)) === false) {
					return false;
				}
			}
		}
		return true;
	});
	switch (matchingChoiceTypes.length) {
		case 0:
			return undefined;
		case 1:
			return matchingChoiceTypes[0];
		default:
			return matchingChoiceTypes.length === type.ChoiceTypes.length
				? expectedType
				: createNormalizedUnionType(matchingChoiceTypes);
	}
}

/**
 * Der erwartete Typ eines Arguments, instanziiert mit den bisher bekannten Argumenten des Aufrufs:
 * bei einem Callback dessen Parametertypen, sonst der Parametertyp selbst (value: TypeOf(stream$)/ValueType
 * wird zu value: Integer).
 */
function instantiateExpectedArgument(
	calledFunction: CompileTimeType,
	argsType: CompileTimeType,
	expectedType: CompileTimeType | undefined,
	argument: ParseValueExpression,
): CompileTimeType | undefined {
	if (argument.type === 'functionLiteral') {
		return instantiateExpectedCallback(calledFunction, argsType, expectedType);
	}
	return expectedType && dereferenceArgumentTypesNested(calledFunction, argsType, expectedType);
}

/**
 * Die Zweige einer aufgerufenen Union von Funktionen (?(mode) [§and§] => all [§or§] => exists).
 * undefined, wenn der Typ keine Union ist oder ein Zweig keine Funktion.
 */
function getUnionFunctionChoices(calledType: CompileTimeType): CompileTimeFunctionType[] | undefined {
	const type = resolveAlias(calledType);
	if (!isUnionType(type)) {
		return undefined;
	}
	const choices = type.ChoiceTypes.map(resolveAlias);
	return choices.every(isFunctionType)
		? choices as CompileTimeFunctionType[]
		: undefined;
}

/**
 * Fasst die erwarteten Typen eines Arguments aus den Zweigen einer aufgerufenen Union von Funktionen
 * zusammen. Ein Funktionsliteral braucht einen eindeutigen Callback-Parametertyp: stimmen die
 * Parameter der Zweige überein, gilt der des ersten, sonst gibt es keine Erwartung.
 */
function mergeExpectedArgumentTypes(
	expectedTypes: (CompileTimeType | undefined)[],
	argument: ParseValueExpression,
): CompileTimeType | undefined {
	const definedTypes = expectedTypes.filter(isDefined);
	if (definedTypes.length !== expectedTypes.length) {
		return undefined;
	}
	if (argument.type !== 'functionLiteral') {
		return createNormalizedUnionType(definedTypes);
	}
	const [first, ...others] = definedTypes.map(getExpectedFunctionType);
	return first && others.every(other => other && typeEquals(other.ParamsType, first.ParamsType))
		? first
		: undefined;
}

/**
 * Instanziiert die Parametertypen eines erwarteten Callbacks mit den Argumenten des Aufrufs, so
 * dass (value: TypeOf(values)/ElementType) zu (value: Integer) wird. Wie bei
 * dereferenceCallbackParams nur diese eine Ebene. Was sich nicht instanziieren lässt, bleibt roh.
 */
function instantiateExpectedCallback(
	calledFunction: CompileTimeType,
	argsType: CompileTimeType,
	expectedType: CompileTimeType | undefined,
): CompileTimeType | undefined {
	const expectedFunctionType = getExpectedFunctionType(expectedType);
	if (!expectedFunctionType) {
		return expectedType;
	}
	const paramsType = expectedFunctionType.ParamsType;
	if (!isParametersType(paramsType)) {
		return expectedFunctionType;
	}
	let changed = false;
	const instantiatedSingleNames = paramsType.singleNames.map(parameter => {
		if (!parameter.type) {
			return parameter;
		}
		const instantiatedType = dereferenceArgumentTypesNested(calledFunction, argsType, parameter.type);
		if (instantiatedType === parameter.type) {
			return parameter;
		}
		changed = true;
		return { name: parameter.name, type: instantiatedType };
	});
	// Wie bei dereferenceCallbackParams: auch `:> T` am Callback wird mit dem Aufruf konkret.
	const instantiatedReturnType = dereferenceArgumentTypesNested(calledFunction, argsType, expectedFunctionType.ReturnType);
	if (instantiatedReturnType !== expectedFunctionType.ReturnType) {
		changed = true;
	}
	if (!changed) {
		return expectedFunctionType;
	}
	return createCompileTimeFunctionType(
		createParametersType(instantiatedSingleNames, paramsType.rest),
		instantiatedReturnType,
		expectedFunctionType.purity,
		expectedFunctionType.aliasName,
		{ predicate: expectedFunctionType.predicate },
	);
}

//#endregion erwarteter Typ

/**
 * Die Veroderung dessen, was die branches vor diesem an dieser Argumentstelle bereits abfangen.
 * _branch probiert die branches der Reihe nach, wer hier ankommt hat also alle vorherigen nicht
 * gematcht. undefined, wenn es keine vorherigen branches gibt oder einer davon alles matcht bzw.
 * nicht bestimmbar ist — dann wird nichts abgezogen. Ein solcher branch macht diesen hier
 * unerreichbar, das ist aber eine eigene Diagnose und kein Fall für die Verengung.
 */
function getPreviousBranchArgumentType(
	branching: ParseBranching,
	branch: ParseValueExpression,
	argumentIndex: number,
): CompileTimeType | undefined {
	const branchIndex = branching.branches.indexOf(branch);
	if (branchIndex < 1) {
		return undefined;
	}
	const previousValueTypes: CompileTimeType[] = [];
	for (const previousBranch of branching.branches.slice(0, branchIndex)) {
		const previousParamsType = getParamsType(previousBranch.typeInfo && resolvePlaceholders(previousBranch.typeInfo.type));
		const previousValueType = getBranchArgumentType(previousParamsType, argumentIndex);
		if (!previousValueType
			|| previousValueType.julType === 'any') {
			return undefined;
		}
		previousValueTypes.push(previousValueType);
	}
	return createNormalizedUnionType(previousValueTypes);
}

/**
 * Verengt den Typ des gebranchten Werts: schneidet mit dem Typ, den dieser branch matcht,
 * und zieht ab, was die vorherigen branches schon abgefangen haben.
 */
function narrowBranchedType(
	branchedType: CompileTimeType,
	branchValueType: CompileTimeType | undefined,
	previousBranchValueType: CompileTimeType | undefined,
): CompileTimeType {
	const intersectedType = branchValueType
		? createNormalizedIntersectionType([branchedType, branchValueType])
		: branchedType;
	return previousBranchValueType
		? createNormalizedIntersectionType([intersectedType, createCompileTimeComplementType(previousBranchValueType)])
		: intersectedType;
}

/**
 * Was aus dem Ergebnis dieses Funktionsliterals als Prädikat folgt, je Richtung getrennt.
 * Erkannt wird bewusst nur die einfachste Form: ein Parameter, Rumpf genau ein branching über
 * eben diesen Parameter. undefined ("keine Aussage") ist überall erlaubt, zu klein bzw. zu groß
 * wäre der Fehler, der verengt, wo nichts folgt.
 */
function getPredicateFacts(
	expression: ParseFunctionLiteral,
	returnType: CompileTimeType,
): PredicateFacts | undefined {
	const params = expression.params;
	if (params.type !== 'parameters'
		|| params.singleFields.length !== 1
		|| params.rest) {
		return undefined;
	}
	const branching = expression.body.length === 1
		? expression.body[0]
		: undefined;
	if (branching?.type !== 'branching') {
		return undefined;
	}
	// Die Aussage gilt dem Parameter, also muss genau er gebrancht werden.
	const branchedValues = getWrittenArguments(branching.args);
	const branchedValue = branchedValues?.length === 1
		? branchedValues[0]
		: undefined;
	if (branchedValue?.type !== 'reference'
		|| branchedValue.name.name !== params.singleFields[0]!.name.name) {
		return undefined;
	}
	// Die Laufzeit matcht ein Prädikat in Typ-Position mit einer Wahrheitsprüfung. Damit würde
	// auch der Error eines nicht erschöpfenden branchings matchen, für einen Wert, den kein
	// branch nennt - ifTrue wäre dann zu klein. Steht hinter den Formprüfungen, weil es die
	// einzige teure Bedingung ist.
	if (isSubtypeOf(resolvePlaceholders(returnType), builtinBoolean) !== true) {
		return undefined;
	}
	const ifTrueTypes: CompileTimeType[] = [];
	const definitelyTrueTypes: CompileTimeType[] = [];
	const caughtTypes: CompileTimeType[] = [];
	let caughtUnknown = false;
	for (const branch of branching.branches) {
		const branchReturnType = getReturnTypeFromFunctionType(branch.typeInfo);
		const isLiteral = branchReturnType.julType === 'booleanLiteral';
		const isAlwaysFalse = isLiteral && !branchReturnType.value;
		const branchValueType = getBranchArgumentType(
			getParamsType(branch.typeInfo && resolvePlaceholders(branch.typeInfo.type)),
			0);
		if (!branchValueType) {
			if (!isAlwaysFalse) {
				// Ein branch, der alles matcht und true liefern kann: der Wert kann alles sein.
				return undefined;
			}
			// Was dieser branch abfängt, steht nicht fest - danach ist kein branch mehr
			// nachweislich erreichbar.
			caughtUnknown = true;
			continue;
		}
		if (!isAlwaysFalse) {
			// Alles, was nicht nachweislich false ist, zählt mit: das macht ifTrue höchstens
			// größer, und zu groß ist beim Schneiden harmlos.
			ifTrueTypes.push(branchValueType);
		}
		if (isLiteral
			&& branchReturnType.value
			&& !caughtUnknown) {
			// Nachweislich true - aber nur für Werte, die keiner der vorherigen branches
			// abfängt, denn _branch nimmt den ersten Treffer.
			definitelyTrueTypes.push(caughtTypes.length
				? createNormalizedIntersectionType([
					branchValueType,
					createCompileTimeComplementType(createNormalizedUnionType(caughtTypes)),
				])
				: branchValueType);
		}
		caughtTypes.push(branchValueType);
	}
	if (!ifTrueTypes.length) {
		return undefined;
	}
	return {
		ifTrue: createNormalizedUnionType(ifTrueTypes),
		excludedIfFalse: definitelyTrueTypes.length
			? createNormalizedUnionType(definitelyTrueTypes)
			: undefined,
	};
}

//#endregion branch narrowing

function setInferredType(
	expression: TypedExpression,
	typeContext: TypeContext,
	/**
	 * Was die Stelle verlangt, an der der Ausdruck steht. Pflicht, damit jede Aufrufstelle
	 * ausdrücklich entscheidet, was sie weitergibt.
	 */
	expectedType: CompileTimeType | undefined,
	checkContext: CheckContext,
): void {
	if (expression.typeInfo) {
		return;
	}
	const checkedExpectedType = toExpectedType(expectedType);
	if (checkedExpectedType) {
		expression.expectedType = checkedExpectedType;
	}
	expression.typeInfo = inferType(expression, typeContext, checkContext);
}

// TODO flatten nested or/and
// TODO distribute and>or nesting chain
// TODO merge dictionaries bei and, spread
// TODO resolve dereferences
/**
 * Füllt errors
 */
function inferType(
	expression: TypedExpression,
	typeContext: TypeContext,
	checkContext: CheckContext,
): TypeInfo {
	checkerStats.inferType++;
	// Jeder 256. Ausdruck: selten genug, dass der Aufruf nicht ins Gewicht fällt, oft genug, dass
	// auch bei einer großen Datei mehrmals je Frame-Takt nachgefragt wird.
	if ((checkerStats.inferType & 0xff) === 0) {
		checkContext.onProgress?.();
	}
	const { scopes, narrowedTypes } = typeContext;
	const { documents: parsedDocuments, folder, filePath, referenceIndex } = checkContext;
	const errors = checkContext.file.errors;
	switch (expression.type) {
		case 'binding':
		case 'data':
			// TODO?
			return { type: builtinAny };
		case 'branching': {
			// union branch return types
			// TODO conditional type?
			const args = expression.args;
			if (args) {
				setInferredType(args, typeContext, undefined, checkContext);
			}
			const branches = expression.branches;
			branches.forEach((branch, index) => {
				setInferredType(branch, typeContext, undefined, checkContext);
				checkIsFunction(branch, ErrorCode.branchIsNotFunction, 'Expected branch to be a function.', errors);
				// Unreachable auch ohne vorherigen Branch: Der Kopf hat mit den Argumenten keinen
				// gemeinsamen Wert, etwa ein zweistelliger Kopf bei ?([a b]).
				if (isBranchDisjointToArgs(args, branch)) {
					errors.push({
						code: ErrorCode.unreachableBranch,
						message: 'Unreachable branch detected.',
						startRowIndex: branch.startRowIndex,
						startColumnIndex: branch.startColumnIndex,
						endRowIndex: branch.endRowIndex,
						endColumnIndex: branch.endColumnIndex,
					});
					return;
				}
				if (index) {
					// Unreachable: Ein Branch ist unreachable, wenn sein Argument-Typ bereits
					// von vorherigen Branches abgedeckt wird. Sonderfall: () ist orthogonal zu
					// konkreten Typ-Köpfen, kann aber gegen einen anderen () unreachable sein.
					const currentParamsType = getParamsType(branch.typeInfo && resolvePlaceholders(branch.typeInfo.type));

					// Any ist ein Typ-Kopf catchAll und kann nicht unreachable sein
					if (currentParamsType.julType === 'any') {
						return;
					}

					const previousTypes = branches.slice(0, index).map(previousBranch => {
						const ty = previousBranch.typeInfo && resolvePlaceholders(previousBranch.typeInfo.type);
						return getParamsType(ty);
					});

					// Spezialfall: () vs () ist unreachable
					if (currentParamsType.julType === 'empty') {
						const previousHasEmpty = previousTypes.some(t => t.julType === 'empty');
						if (previousHasEmpty) {
							errors.push({
								code: ErrorCode.unreachableBranch,
								message: 'Unreachable branch detected.',
								startRowIndex: branch.startRowIndex,
								startColumnIndex: branch.startColumnIndex,
								endRowIndex: branch.endRowIndex,
								endColumnIndex: branch.endColumnIndex,
							});
						}
						return;
					}

					// Extrahiere Argument-Typen aller vorherigen Branches (Typ-Kopf-Elementen)
					// und kombiniere sie zu einer Union. () hat keinen Argument-Typ (undefined).
					// Spezialfall: Any und untypisierte Parameter sind catchAll — sie sind nie unreachable
					const previousArgumentTypes: CompileTimeType[] = [];
					for (const prevType of previousTypes) {
						if (prevType.julType !== 'empty') {
							// Any ist ein Typ-Kopf catchAll
							if (prevType.julType === 'any') {
								// Any matcht alles → der aktuelle Branch kann nicht unreachable sein
								return;
							}
							// Untypisierte Parameter (getBranchArgumentType gibt undefined) sind auch catchAll
							const argType = getBranchArgumentType(prevType, 0);
							if (!argType) {
								// Catchall oder Prädikat
								return;
							}
							previousArgumentTypes.push(argType);
						}
					}

					if (previousArgumentTypes.length === 0) {
						// Keine konkreten vorherigen Branches
						return;
					}

					// Argument-Typ des aktuellen Branches
					const currentArgumentType = getBranchArgumentType(currentParamsType, 0);
					if (!currentArgumentType) {
						// undefined: entweder catchAll (untypisiert) oder Prädikat.
						// Catchall und Prädikat sind nicht unreachable (sie matchen immer).
						// TODO: Prädikat-Fakten checken falls nötig
						return;
					}

					// Any ist auch bei Parameter-Elementen ein catchAll
					if (currentArgumentType.julType === 'any') {
						return;
					}

					// Kombiniere vorherige Argument-Typen zu Union
					const combinedPreviousArgumentType = createNormalizedUnionType(previousArgumentTypes);

					// Prüfe ob currentArgumentType Teilmenge von combinedPreviousArgumentType ist.
					// Sicher abgefangen haben die vorherigen Köpfe nur ihre Untermenge, und der
					// aktuelle kann alles aus seiner Obermenge treffen - das zählt bei Prädikaten.
					// Derselbe Kopf ist dagegen über die Identität abgefangen.
					// Unerreichbar ist er nur bewiesen: kann der aktuelle Kopf etwas treffen, das die
					// vorherigen nicht sicher abfangen, oder ist das unbekannt (Any), ist er erreichbar.
					const isSameAsPrevious = previousArgumentTypes.some(previousArgumentType =>
						typeEquals(previousArgumentType, currentArgumentType));
					const isUnreachable = isSameAsPrevious
						|| isSubtypeOf(
							getUpperBoundType(currentArgumentType),
							getLowerBoundType(combinedPreviousArgumentType)) === true;
					if (isUnreachable) {
						errors.push({
							code: ErrorCode.unreachableBranch,
							message: 'Unreachable branch detected.',
							startRowIndex: branch.startRowIndex,
							startColumnIndex: branch.startColumnIndex,
							endRowIndex: branch.endRowIndex,
							endColumnIndex: branch.endColumnIndex,
						});
					}
				}
			});
			const branchReturnTypes = expression.branches.map(branch => {
				return getReturnTypeFromFunctionType(branch.typeInfo);
			});
			// _branch (runtime.ts) gibt Error zurück, wenn kein branch matcht. Das gehört nur
			// dann nicht in den Typ, wenn beweisbar kein Wert von args durchrutschen kann:
			// entweder ein branch matcht syntaktisch alles (catchAll), oder die branches decken
			// den ganzen args-Typ ab. Nicht entscheidbar zählt als nicht exhaustiv - lieber
			// Error zu viel im Typ als ein unsound weggelassenes Error (Prinzip Freiheit).
			const isExhaustive = branches.some(branch => {
				const paramsType = getParamsType(branch.typeInfo && resolvePlaceholders(branch.typeInfo.type));
				return paramsType.julType === 'any'
					|| (isParametersType(paramsType) && !paramsType.singleNames.length && !paramsType.rest);
			}) || isBranchingExhaustive(args, branches);
			const rawType = createNormalizedUnionType(
				isExhaustive
					? branchReturnTypes
					: [...branchReturnTypes, builtinError]);
			return { type: rawType };
		}
		case 'typeBranching': {
			// Nur als Rückgabetyp erlaubt: dort wird es nie emittiert, anderswo bräuchte es eine
			// Runtime-Implementierung.
			const parent = expression.parent;
			const isReturnType = (parent?.type === 'functionLiteral' || parent?.type === 'functionTypeLiteral')
				&& parent.returnType === expression;
			if (!isReturnType) {
				errors.push({
					code: ErrorCode.typeBranchingOutsideReturnType,
					message: 'Type branching (:?) is only allowed as return type.',
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.startRowIndex,
					endColumnIndex: expression.startColumnIndex + 2,
				});
			}
			const args = expression.args;
			if (args) {
				setInferredType(args, typeContext, undefined, checkContext);
			}
			// Operanden, Köpfe und Ergebnisse werden gelesen wie der Ausdruck hinter ->: als
			// Wertemenge, nicht als Typwert.
			const operands = args
				? getArgValueExpressions(args).map(arg => valueOf(arg?.typeInfo?.type))
				: [];
			const conditionalBranches: ConditionalTypeBranch[] = [];
			expression.branches.forEach(branch => {
				setInferredType(branch, typeContext, undefined, checkContext);
				if (!checkIsFunction(branch, ErrorCode.branchIsNotFunction, 'Expected branch to be a function.', errors)) {
					return;
				}
				const branchType = resolveAlias(branch.typeInfo!.type);
				if (!isFunctionType(branchType)) {
					return;
				}
				const paramsType = branchType.ParamsType;
				let head: CompileTimeType;
				if (isParametersType(paramsType)) {
					// () ist der catchAll. Eine Bindung im Kopf bleibt für ihre Bedeutung auf
					// Typebene frei. Als Kopf gelten dann die Typen der Parameter, damit auf den
					// Fehler keine Folgefehler kommen.
					if (paramsType.singleNames.length || paramsType.rest) {
						head = paramsType.singleNames.length && !paramsType.rest
							? createCompileTimeTupleType(paramsType.singleNames.map(parameter => parameter.type ?? builtinAny))
							: builtinAny;
						errors.push({
							code: ErrorCode.typeBranchHeadBinding,
							message: 'A branch of :? must not bind a name in its head. Use a type as head, e.g. [Integer] => Integer.',
							startRowIndex: branch.startRowIndex,
							startColumnIndex: branch.startColumnIndex,
							endRowIndex: branch.endRowIndex,
							endColumnIndex: branch.endColumnIndex,
						});
					}
					else {
						head = builtinAny;
					}
				}
				else {
					head = valueOf(paramsType);
				}
				conditionalBranches.push({
					Head: head,
					Result: valueOf(branchType.ReturnType),
				});
			});
			return { type: createCompileTimeTypeOfType(createConditionalType(operands, conditionalBranches)) };
		}
		case 'definition': {
			const value = expression.value;
			const name = expression.name.name;
			// Der Typguard vor dem Wert: er legt fest, was der Wert erfüllen muss.
			const typeGuard = expression.typeGuard;
			if (typeGuard) {
				setInferredType(typeGuard, typeContext, undefined, checkContext);
				checkTypeGuardIsType(typeGuard, errors);
			}
			if (value) {
				const expectedValueType = typeGuard?.typeInfo && valueOf(typeGuard.typeInfo.type);
				setInferredType(value, typeContext, expectedValueType, checkContext);
			}
			const circularReference = value && findUnproductiveSelfReferenceInDefinition(value, name);
			if (circularReference) {
				errors.push({
					code: ErrorCode.circularTypeDefinition,
					message: `Circular type definition '${name}'. A type can only refer to itself through a field, list, tuple, stream or function.`,
					startRowIndex: circularReference.startRowIndex,
					startColumnIndex: circularReference.startColumnIndex,
					endRowIndex: circularReference.endRowIndex,
					endColumnIndex: circularReference.endColumnIndex,
				});
			}
			let typeInfo: TypeInfo;
			if (name in coreBuiltInSymbolTypes) {
				const rawType = coreBuiltInSymbolTypes[name]!;
				typeInfo = { type: rawType };
			}
			else {
				if (value?.typeInfo) {
					typeInfo = value.typeInfo;
				}
				else {
					typeInfo = { type: builtinAny };
				}
			}
			checkNameDefinedInUpperScope(expression, scopes, errors, name);
			// TODO typecheck mit typeguard, ggf union mit Error type
			const currentScope = last(scopes);
			const symbol = currentScope[name];
			if (!symbol) {
				throw new Error(`Definition Symbol ${name} not found`);
			}
			typeInfo = withCompletedStream(typeInfo, currentScope, name);
			symbol.typeInfo = typeInfo;
			// Ein hingeschriebener TypeGuard ist die erklärte Absicht und geht dem inferierten Typ vor.
			checkNamingCase(
				expression.name,
				typeGuard?.typeInfo ? valueOf(typeGuard.typeInfo.type) : typeInfo.type,
				errors,
			);
			if (typeGuard) {
				const typeGuardType = typeGuard.typeInfo;
				const dereferencedTargetType = typeGuardType && valueOf(resolvePlaceholders(typeGuardType.type));
				const assignability = dereferencedTargetType && isTypeAssignable(resolvePlaceholders(typeInfo.type), dereferencedTargetType);
				if (assignability && assignability.assignable === false) {
					const assignmentError = typeErrorToString(assignability.error);
					// Position wandert beim Abstieg durch verschachtelte Dictionary-Literale auf
					// die innerste noch vorhandene, tatsächlich falsche Stelle (TypeScript/
					// Rust/Elm-Vorbild: eine Diagnose, eine möglichst genaue Position, statt
					// einer zweiten Diagnose mit demselben Text an einer weniger genauen Stelle).
					const innerPosition = dereferencedTargetType && findInnermostErrorPosition(value);
					const position = innerPosition ?? expression;

					// Ob die umhüllende "Can not assign X to Y."-Zeile fehlt, entscheidet
					// isTypeAssignable bereits an der Quelle (case 'dictionaryLiteral') - hier nur
					// noch die fertige Meldung übernehmen, kein nachträgliches Textschneiden mehr.
					const message = `Definition type mismatch.\n${assignmentError}`;

					errors.push({
						code: ErrorCode.definitionTypeMismatch,
						message,
						startRowIndex: position.startRowIndex,
						startColumnIndex: position.startColumnIndex,
						endRowIndex: position.endRowIndex,
						endColumnIndex: position.endColumnIndex,
					});
				}
				else if (assignability && dereferencedTargetType) {
					reportUnknown(assignability, checkContext, 'Definition', typeInfo.type, dereferencedTargetType, expression);
				}
			}
			return typeInfo;
		}
		case 'destructuring': {
			const value = expression.value;
			if (value) {
				setInferredType(value, typeContext, undefined, checkContext);
			}
			const currentScope = last(scopes);
			let allFieldsResolved = true;
			expression.fields.fields.forEach((field, index) => {
				// TODO spread
				const fieldName = field.name.name;
				if (!fieldName) {
					allFieldsResolved = false;
					return;
				}
				checkNameDefinedInUpperScope(expression, scopes, errors, fieldName);
				const referenceName = field.source?.name ?? fieldName;
				if (referenceIndex) {
					const localSymbol = currentScope[fieldName];
					if (localSymbol) {
						if (field.source) {
							// Alias: source zeigt auf den Ursprung, name ist eine eigene, unabhängige
							// lokale Identität (siehe resolveCanonicalSymbol in reference-index.ts).
							const imported = resolveImportBinding(field, filePath, parsedDocuments);
							if (imported) {
								referenceIndex.recordReference(imported.symbol, imported.filePath, {
									filePath,
									startRowIndex: field.source.startRowIndex,
									startColumnIndex: field.source.startColumnIndex,
									endRowIndex: field.source.endRowIndex,
									endColumnIndex: field.source.endColumnIndex,
								});
							}
						} else {
							// Kein Alias: der lokale Name ist der geteilte Name, folgt der Importkette.
							const canonical = resolveCanonicalSymbol(localSymbol, filePath, parsedDocuments);
							referenceIndex.recordReference(canonical.symbol, canonical.filePath, {
								filePath,
								startRowIndex: field.name.startRowIndex,
								startColumnIndex: field.name.startColumnIndex,
								endRowIndex: field.name.endRowIndex,
								endColumnIndex: field.name.endColumnIndex,
							});
						}
					}
					if (value?.typeInfo && !isImportFunctionCall(value)) {
						recordDestructuringFieldReferences(field, value.typeInfo.type, localSymbol, referenceIndex, filePath);
					}
				}
				const valueType: CompileTimeType = value?.typeInfo
					? value.typeInfo.type
					: builtinAny;
				// Die Laufzeit greift bei einem Array über die Position zu, sonst über den Namen
				// (_isArray ? _temp[index] : _temp.name) - der Checker prüft deshalb beides.
				// Bei einer offenen Quelle legt sich dereferenceNameFromObject aber auf den Namen
				// fest (a/x), und die Position ginge verloren. Schließt der Typ der Quelle benannte
				// Felder aus, ist jedes Argument ein Array, gelesen wird also über die Position.
				const readsByPosition = isUnresolvedPlaceholderType(valueType)
					&& !canHaveFieldsBesideEmpty(resolvePlaceholders(valueType));
				const fieldType = readsByPosition
					? dereferenceIndexFromObject(index + 1, valueType)
					: dereferenceNameFromObject(referenceName, valueType)
					?? dereferenceIndexFromObject(index + 1, valueType);
				if (!fieldType) {
					allFieldsResolved = false;
					errors.push({
						code: ErrorCode.dereferenceFailed,
						message: `Failed to dereference '${referenceName}' in type ${typeToString(resolvePlaceholders(valueType), 0, 0)}`,
						startRowIndex: field.startRowIndex,
						startColumnIndex: field.startColumnIndex,
						endRowIndex: field.endRowIndex,
						endColumnIndex: field.endColumnIndex,
					});
					return;
				}
				const symbol = currentScope[fieldName]!;
				symbol.typeInfo = { type: fieldType };
				checkNamingCase(field.name, fieldType, errors);
				const typeGuard = field.typeGuard;
				if (typeGuard) {
					setInferredType(typeGuard, typeContext, undefined, checkContext);
					checkTypeGuardIsType(typeGuard, errors);
					// TODO check value?
					const assignability = typeGuard.typeInfo && isTypeAssignable(fieldType, valueOf(resolvePlaceholders(typeGuard.typeInfo.type)));
					if (assignability && assignability.assignable === false) {
						errors.push({
							code: ErrorCode.destructuringFieldTypeMismatch,
							message: typeErrorToString(assignability.error),
							startRowIndex: field.startRowIndex,
							startColumnIndex: field.startColumnIndex,
							endRowIndex: field.endRowIndex,
							endColumnIndex: field.endColumnIndex,
						});
					}
				}
			});
			// Erst wenn jeder gewünschte Name im Wert steht, heißt ein übriges Feld "niemand
			// bindet es". Sonst ist der gemeldete Name die Ursache und diese Warnung nur ihre Folge.
			if (allFieldsResolved) {
				checkDiscardedDestructuringFields(value, expression.fields.fields, errors);
			}
			return { type: builtinAny };
		}
		case 'dictionary': {
			const aliasName = getNameFromValue(expression);
			const createDictionary = (fieldTypes: CompileTimeDictionary, complete = true) => createCompileTimeDictionaryLiteralType(
				fieldTypes,
				complete,
				{ expression: expression, filePath: filePath },
				aliasName);
			// Das Literal entsteht von links nach rechts: jeder Spread wird auf das bisherige Ergebnis
			// gemergt. undefined heißt, der Typ ist nicht mehr entscheidbar.
			let literalType: CompileTimeType | undefined = createDictionary({});
			// Aufeinanderfolgende Felder werden gesammelt und erst vor dem nächsten Spread bzw. am
			// Ende gemergt. Ein Merge je Feld kopiert jedes Mal alle Felder und normalisiert eine
			// Union jedes Mal neu, das hat parse+check von yugioh mehr als verdreifacht.
			let pendingFieldTypes: CompileTimeDictionary = {};
			const mergePendingFields = () => {
				if (Object.keys(pendingFieldTypes).length) {
					literalType = literalType
						&& spreadDictionaryTypes(literalType, createDictionary(pendingFieldTypes), createDictionary);
					pendingFieldTypes = {};
				}
			};
			// Die schon inferierten und alle ausgeschriebenen Felder, für das Aussortieren einer
			// erwarteten Union.
			const writtenFieldTypes: CompileTimeDictionary = {};
			const writtenFieldNames = getWrittenFieldNames(expression);
			expression.fields.forEach(field => {
				const value = field.value;
				if (value) {
					const fieldName = field.type === 'singleDictionaryField'
						? getCheckedEscapableName(field.name)
						: undefined;
					let expectedFieldType: CompileTimeType | undefined;
					if (fieldName !== undefined) {
						// Aussortieren braucht isTypeAssignable, deshalb nur, wo ein Kind einen eindeutigen
						// Zweig verlangen kann.
						const needsUniqueChoice = value.type === 'functionLiteral'
							|| value.type === 'dictionary'
							|| value.type === 'list';
						const expectedDictionaryType = needsUniqueChoice
							? narrowExpectedTypeByFields(expression.expectedType, writtenFieldTypes, writtenFieldNames)
							: expression.expectedType;
						expectedFieldType = getExpectedFieldType(expectedDictionaryType, fieldName);
					}
					setInferredType(value, typeContext, expectedFieldType, checkContext);
					if (fieldName !== undefined && value.typeInfo) {
						writtenFieldTypes[fieldName] = value.typeInfo.type;
					}
				}
				switch (field.type) {
					case 'singleDictionaryField': {
						const fieldName = getCheckedEscapableName(field.name);
						if (!fieldName) {
							return;
						}
						const fieldType = field.value?.typeInfo?.type ?? builtinAny;
						pendingFieldTypes[fieldName] = fieldType;
						const fieldSymbol = expression.symbols[fieldName];
						if (!fieldSymbol) {
							throw new Error(`fieldSymbol ${fieldName} not found`);
						}
						fieldSymbol.typeInfo = { type: fieldType };
						return;
					}
					case 'spread':
						// resolvePlaceholders nötig: sonst wird z.B. eine Parameter-Typreferenz
						// nicht als dictionaryLiteral erkannt und der gesamte Literal-Typ fällt
						// still auf Any zurück (verschluckt dann jeden Folgefehler).
						const valueType = value?.typeInfo && resolvePlaceholders(value.typeInfo.type);
						mergePendingFields();
						literalType = literalType
							&& valueType
							&& spreadDictionaryTypes(literalType, valueType, createDictionary);
						return;
					default: {
						const assertNever: never = field;
						throw new Error('Unexpected Dictionary field type ' + (assertNever as ParseDictionaryField).type);
					}
				}
			});
			mergePendingFields();
			if (referenceIndex) {
				recordContextualFieldReferences(expression, writtenFieldTypes, referenceIndex, filePath);
			}
			return { type: literalType ?? builtinAny };
		}
		case 'dictionaryType': {
			const fieldTypes: CompileTimeDictionary = {};
			expression.fields.forEach(field => {
				switch (field.type) {
					case 'singleDictionaryTypeField': {
						const typeGuard = field.typeGuard;
						if (!typeGuard) {
							return;
						}
						setInferredType(typeGuard, typeContext, undefined, checkContext);
						checkTypeGuardIsType(typeGuard, errors);
						const fieldName = getCheckedEscapableName(field.name);
						if (!fieldName) {
							return;
						}
						const fieldType = valueOf(typeGuard.typeInfo?.type);
						fieldTypes[fieldName] = fieldType;
						const fieldSymbol = expression.symbols[fieldName];
						if (!fieldSymbol) {
							throw new Error(`fieldSymbol ${fieldName} not found`);
						}
						fieldSymbol.typeInfo = { type: fieldType };
						return;
					}
					case 'spread': {
						setInferredType(field.value, typeContext, undefined, checkContext);
						// resolvePlaceholders/valueOf nötig: die Quelle steht als Typausdruck
						// (TypeOf(dictionaryLiteral)) da, nicht als Wert - dieselbe Begründung
						// wie beim Spread in case 'dictionary'.
						const spreadType = field.value.typeInfo
							&& resolveAlias(valueOf(resolvePlaceholders(field.value.typeInfo.type)));
						// TODO error when spread list
						if (isDictionaryLiteralType(spreadType)) {
							for (const key in spreadType.Fields) {
								fieldTypes[key] = spreadType.Fields[key]!;
							}
						}
						return;
					}
					default: {
						const assertNever: never = field;
						throw new Error('Unexpected DictionaryType field type ' + (assertNever as ParseDictionaryTypeField).type);
					}
				}
			});
			const aliasName = getNameFromValue(expression);
			const rawType = createCompileTimeTypeOfType(createCompileTimeDictionaryLiteralType(
				fieldTypes,
				true,
				{ expression: expression, filePath: filePath },
				aliasName));
			return { type: rawType };
		}
		case 'empty':
			return { type: builtinEmpty };
		case 'field':
			// TODO?
			return { type: builtinEmpty };
		case 'float': {
			const rawType = createFloatLiteral(expression.value);
			return { type: rawType };
		}
		case 'fraction': {
			const rawType = createCompileTimeDictionaryLiteralType({
				numerator: createIntegerLiteral(expression.numerator),
				denominator: createIntegerLiteral(expression.denominator),
			}, true);
			return { type: rawType };
		}
		case 'functionCall': {
			// TODO provide args types for conditional/generic/derived type?
			// TODO infer last body expression type for returnType
			const prefixArgument = expression.prefixArgument;
			const functionExpression = expression.functionExpression;
			if (!functionExpression) {
				// Beim Tippen von `a.` fehlt die Funktion noch, das Präfix-Argument braucht die
				// Completion trotzdem inferiert.
				if (prefixArgument) {
					setInferredType(prefixArgument, typeContext, undefined, checkContext);
				}
				return { type: builtinAny };
			}
			// Die Funktion vor dem Präfix-Argument: es erwartet ihren ersten Parameter.
			setInferredType(functionExpression, typeContext, undefined, checkContext);
			const selfApplied = !prefixArgument && getSelfAppliedTypeFunction(functionExpression);
			if (selfApplied) {
				// Die Typfunktion wird selbst noch geprüft, ihr Rückgabetyp steht noch nicht fest:
				// der Aufruf bleibt als Knoten stehen und wird erst beim Zugriff aufgelöst.
				const selfArgs = expression.arguments;
				if (selfArgs) {
					setInferredType(selfArgs, typeContext, undefined, checkContext);
				}
				const selfArgsType = selfArgs?.typeInfo?.type ?? builtinEmpty;
				return {
					type: createCompileTimeTypeOfType(createCompileTimeAliasType(selfApplied.name, selfApplied.symbol, selfArgsType)),
				};
			}
			const isFunction = checkIsFunction(functionExpression, ErrorCode.valueIsNotFunction, 'Expected a function to call.', errors);
			const functionType = functionExpression.typeInfo!.type;
			const paramsType = getParamsType(functionType);
			if (prefixArgument) {
				setInferredType(prefixArgument, typeContext, getExpectedElementType(paramsType, 0), checkContext);
			}
			const args = expression.arguments;
			if (!args) {
				return { type: builtinAny };
			}
			//#region erwartete Typen der Argumente
			// Jedes Argument erwartet seinen Parametertyp. Dafür werden die Argumente hier einzeln und
			// in Reihenfolge inferiert, die Argumentliste setzt sie danach nur noch zusammen.
			const argsPrefixCount = prefixArgument ? 1 : 0;
			const rawPrefixArgumentTypeForArgs = prefixArgument?.typeInfo?.type;
			// Bei einer aufgerufenen Union von Funktionen wird pro Zweig erwartet und instanziiert,
			// die Ergebnisse fasst mergeExpectedArgumentTypes zusammen.
			const unionFunctionChoices = getUnionFunctionChoices(functionType);
			const getExpectedArgumentType = (
				getRawType: (paramsType: CompileTimeType) => CompileTimeType | undefined,
				getProvisionalArgsType: () => CompileTimeType,
				value: ParseValueExpression,
			): CompileTimeType | undefined => {
				const expectedTypes = (unionFunctionChoices ?? [functionType]).map(calledFunction => {
					const rawType = getRawType(unionFunctionChoices
						? getParamsType(calledFunction)
						: paramsType);
					return value.type === 'functionLiteral' || rawType?.isUnresolvedPlaceholder
						? instantiateExpectedArgument(
							calledFunction, bindReceiver(rawPrefixArgumentTypeForArgs, getProvisionalArgsType()), rawType, value)
						: rawType;
				});
				return unionFunctionChoices
					? mergeExpectedArgumentTypes(expectedTypes, value)
					: expectedTypes[0];
			};
			switch (args.type) {
				case 'list': {
					// Ein Spread verschiebt alle folgenden Positionen unbekannt weit.
					let firstSpreadIndex: number | undefined;
					args.values.forEach((value, index) => {
						if (value.type === 'spread') {
							firstSpreadIndex ??= index + argsPrefixCount;
							setInferredType(value.value, typeContext, undefined, checkContext);
							return;
						}
						const expectedArgumentType = getExpectedArgumentType(
							calledParamsType => firstSpreadIndex === undefined
								? getExpectedElementType(calledParamsType, index + argsPrefixCount)
								: getExpectedElementTypeAfterSpread(calledParamsType, firstSpreadIndex),
							// Vorläufige Argumente: die vorherigen sind schon inferiert, die übrigen Any.
							() => createCompileTimeTupleType(args.values.map(otherValue =>
								(otherValue as ParseExpressionBase).typeInfo?.type ?? builtinAny)),
							value);
						setInferredType(value, typeContext, expectedArgumentType, checkContext);
					});
					break;
				}
				case 'dictionary': {
					const provisionalFieldTypes: CompileTimeDictionary = {};
					args.fields.forEach(field => {
						const value = field.value;
						if (!value) {
							return;
						}
						const fieldName = field.type === 'singleDictionaryField'
							? getCheckedEscapableName(field.name)
							: undefined;
						const expectedArgumentType = getExpectedArgumentType(
							calledParamsType => fieldName === undefined
								? undefined
								: getExpectedFieldType(calledParamsType, fieldName),
							() => createCompileTimeDictionaryLiteralType(provisionalFieldTypes, true),
							value);
						setInferredType(value, typeContext, expectedArgumentType, checkContext);
						if (fieldName !== undefined && value.typeInfo) {
							provisionalFieldTypes[fieldName] = value.typeInfo.type;
						}
					});
					break;
				}
				default:
					break;
			}
			//#endregion erwartete Typen der Argumente
			setInferredType(args, typeContext, undefined, checkContext);
			if (!isFunction) {
				// Die Argumente sind inferiert, ihre eigenen Fehler also gemeldet.
				// Alles weitere setzt eine Funktion voraus und wäre wirkungslos.
				return { type: builtinAny };
			}
			// Präfix-Argument (z.B. `values` in `values.slice(1)`) referenziert einen eigenen
			// Parameter und bleibt sonst eine abstrakte parameterReference statt des konkreten
			// deklarierten Typs - unaufgelöst in generischen Rückgabetypen der aufgerufenen
			// Funktion (TypeOf(values)/ElementType), als unknown verschluckt von der
			// nestedReference-Rückfallregel in isTypeAssignable. resolvePlaceholders löst über
			// functionRef+Index auf.
			// Nur das Präfix, nicht argsType: args kann selbst generische Typwerte enthalten
			// (z.B. die Signatur eines nativeFunction-Aufrufs) - die dürfen nicht vorschnell
			// über den eigenen (noch generischen) Deklarationskontext aufgelöst werden.
			const argsType = args.typeInfo!.type;
			const rawPrefixArgumentType = prefixArgument?.typeInfo?.type;
			const prefixArgumentType = rawPrefixArgumentType && resolvePlaceholders(rawPrefixArgumentType);
			// Die Signaturen der Callback-Parameter werden gegen die konkreten Argumente
			// instanziiert, bevor geprüft wird: ein generischer Parametertyp darin
			// (TypeOf(values)/ElementType) bliebe sonst ein Platzhalter, und die Prüfung liefe als
			// unknown durch - die Kontravarianzprüfung des Callbacks liefe ins Leere.
			// Nur diese eine Ebene, nicht der ganze Baum: traversePlaceholders steigt mit
			// argumentContext bewusst nicht in Funktions- und Parameterknoten ab, weil das die
			// Auflösung des Rückgabetyps (TypeOf(callback)/ReturnType) zerstört.
			// Ab hier ist der Empfänger das erste Argument (wie bei Uniform Function Call Syntax).
			const boundArgsType = bindReceiver(prefixArgumentType, argsType);
			const dereferencedParamsType = dereferenceCallbackParams(functionType, boundArgsType, paramsType);
			const argsAssignability = getArgumentsAssignability(boundArgsType, dereferencedParamsType);
			const hasArgsError = argsAssignability.assignable === false;
			if (argsAssignability.assignable === false) {
				const position = (prefixArgument && findErrorPositionInChild(prefixArgument))
					?? findInnermostErrorPosition(args)
					?? expression;
				errors.push({
					code: ErrorCode.argumentTypeMismatch,
					message: `Argument type mismatch.\n${typeErrorToString(argsAssignability.error)}`,
					startRowIndex: position.startRowIndex,
					startColumnIndex: position.startColumnIndex,
					endRowIndex: position.endRowIndex,
					endColumnIndex: position.endColumnIndex,
				});
			}
			else {
				reportUnknown(argsAssignability, checkContext, 'Argument', boundArgsType, dereferencedParamsType, expression);
			}
			// Ein Parameter mit Funktionstyp ist eine Referenz, deren Stelligkeit erst aufgelöst
			// bekannt ist. Aufgelöst wird nur dann, weil es sonst jeden Aufruf verteuert.
			const discardCheckParamsType = paramsType.julType === 'any' && isFunction
				? getParamsType(resolvePlaceholders(functionType))
				: paramsType;
			checkDiscardedArguments(args, discardCheckParamsType, !!prefixArgument, errors);
			// Name statt Symbol wie bei den übrigen Builtins: `test` zu überschatten ist JUL3203.
			if (functionExpression.type === 'reference'
				&& functionExpression.name.name === 'test') {
				checkTestCall(expression, hasArgsError, checkContext.filePath, errors);
			}
			const returnType = getReturnTypeFromFunctionCall(expression, functionExpression, checkContext);
			// Für den Rückgabetyp bleibt ein Platzhalter stehen, statt hier schon auf den
			// deklarierten Parametertyp zu fallen: erst der Aufrufort kennt den konkreten Typ,
			// und der generische Rückgabetyp der gerufenen Funktion kann ihn dort exakt
			// weiterrechnen. Geprüft wird weiter gegen den aufgelösten Typ (siehe oben).
			const returnPrefixArgumentType = rawPrefixArgumentType && isUnresolvedPlaceholderType(rawPrefixArgumentType)
				? rawPrefixArgumentType
				: prefixArgumentType;
			// evaluate generic ReturnType
			const outermostFunctionTypeArg = getArgValueExpressions(args)[0];
			// :> an der äußersten Signatur eines nativeFunction-Aufrufs ist eine bedingte
			// Zusicherung (Purity folgt den übergebenen Funktionsargumenten), keine unbestimmte -
			// verschachtelte :> an Callback-Parametern derselben Signatur bleiben unknown. Der
			// Klon teilt die Identität des Originals, die parameterReference-Knoten in ParamsType und
			// ReturnType lösen sich also weiter auf.
			const isConditionallyPureSignature = functionExpression.type === 'reference'
				&& functionExpression.name.name === 'nativeFunction'
				&& outermostFunctionTypeArg?.type === 'functionTypeLiteral'
				&& outermostFunctionTypeArg.arrow === 'unknown';
			const unadjustedReturnType = dereferenceArgumentTypesNested(functionType, bindReceiver(returnPrefixArgumentType, argsType), returnType);
			const resolvedUnadjustedReturnType = resolveAlias(unadjustedReturnType);
			const dereferencedReturnType = isConditionallyPureSignature && isFunctionType(resolvedUnadjustedReturnType)
				? { ...resolvedUnadjustedReturnType, purity: 'pureIfArgsPure' as const }
				: unadjustedReturnType;
			// Für Hover und Co.: die Signatur, gegen die dieser Aufruf geprüft wurde. Eine Kopie,
			// denn die Platzhalter in Parameter- und Rückgabetyp zeigen auf das Original.
			// Der Aliasname entfällt, er stünde sonst in der Anzeige statt der verengten Typen.
			const resolvedFunctionType = resolveAlias(functionType);
			if (isFunctionType(resolvedFunctionType)) {
				const callSiteParamsType = substituteParameterProjections(
					resolvedFunctionType, functionType, boundArgsType, dereferencedParamsType);
				expression.calledFunctionType = {
					...resolvedFunctionType,
					ParamsType: callSiteParamsType,
					ReturnType: dereferencedReturnType,
					aliasName: undefined,
					isUnresolvedPlaceholder: callSiteParamsType.isUnresolvedPlaceholder
						|| dereferencedReturnType.isUnresolvedPlaceholder,
				};
			}
			const foldedType = tryFoldCall(
				functionExpression, functionType, boundArgsType, hasArgsError);
			const boundReturnType = !foldedType && !hasArgsError
				? bindClosureArguments(functionExpression, functionType, boundArgsType, dereferencedReturnType)
				: undefined;
			return { type: foldedType ?? boundReturnType ?? dereferencedReturnType };
		}
		case 'functionLiteral': {
			const ownSymbols = expression.symbols;
			registerCompletedNames(ownSymbols, expression.body);
			const functionScopes: NonEmptyArray<SymbolTable> = [...scopes, ownSymbols];
			const params = expression.params;
			// Der Funktionstyp entsteht erst nach dem Rumpf. Bis dahin zeigen Parameter und
			// parameterReference auf die Identität, die nur ParamsType trägt.
			const identity = createFunctionIdentity(builtinEmpty);
			if (params.type === 'parameters') {
				setFunctionRefForParams(params, identity, functionScopes);
			}
			// Die Params sagen die Verengung erst aus, sie sehen sie also noch nicht.
			const functionTypeContext: TypeContext = {
				scopes: functionScopes,
				narrowedTypes: narrowedTypes,
			};
			// Untypisierte Parameter bekommen ihren Typ aus dem erwarteten Funktionstyp.
			const expectedFunctionType = getExpectedFunctionType(expression.expectedType);
			setInferredType(params, functionTypeContext, expectedFunctionType?.ParamsType, checkContext);
			const paramsTypeValue = valueOf(params.typeInfo!.type);
			checkParamsTypeIsCollection(params, errors);
			checkTypeHeadPredicates(params, errors);
			identity.ParamsType = paramsTypeValue;
			//#region verengte Typen für branching
			let branchNarrowedTypes = narrowedTypes;
			const branching = expression.parent;
			if (branching?.type === 'branching') {
				getWrittenArguments(branching.args)?.forEach((argument, argumentIndex) => {
					const path = getAccessPath(argument, functionScopes);
					if (!path) {
						return;
					}
					const branchRawType = getBranchArgumentType(paramsTypeValue, argumentIndex);
					// Was vorherige branches schon abfangen, kann hier nicht mehr ankommen.
					const previousBranchValueType = getPreviousBranchArgumentType(branching, expression, argumentIndex);
					if (!branchRawType
						&& !previousBranchValueType) {
						return;
					}
					// branching.args wird in case 'branching' vor den branches inferiert
					const currentType = getNarrowedType(branchNarrowedTypes, path.symbol, path.keys)
						?? argument.typeInfo?.type
						?? builtinAny;
					// verengen heißt schneiden, nicht ersetzen: sonst würde z.B. Any => ... verbreitern
					const narrowedType = narrowBranchedType(currentType, branchRawType, previousBranchValueType);
					branchNarrowedTypes = withNarrowedPath(branchNarrowedTypes, argument, narrowedType, functionScopes);
					const originExpression = getOriginExpression(path.symbol);
					if (originExpression) {
						branchNarrowedTypes = withNarrowedPath(branchNarrowedTypes, originExpression, narrowedType, functionScopes);
					}
				});
			}
			//#endregion verengte Typen für branching
			const branchTypeContext: TypeContext = {
				scopes: functionScopes,
				narrowedTypes: branchNarrowedTypes,
			};
			// Der deklarierte Rückgabetyp vor dem Rumpf: er legt fest, was der Rumpf liefern muss.
			// Er darf die Parameter nennen (TypeOf(a)), die sind hier schon inferiert.
			const declaredReturnType = expression.returnType;
			if (declaredReturnType) {
				setInferredType(declaredReturnType, branchTypeContext, undefined, checkContext);
			}
			// Der letzte Ausdruck ist der Rückgabewert: er erwartet den deklarierten Rückgabetyp, sonst
			// den des erwarteten Funktionstyps.
			const expectedReturnType = declaredReturnType?.typeInfo
				? valueOf(declaredReturnType.typeInfo.type)
				: expectedFunctionType?.ReturnType;
			const lastBodyExpression = last(expression.body);
			expression.body.forEach(bodyExpression => {
				const expectedBodyType = bodyExpression === lastBodyExpression
					? expectedReturnType
					: undefined;
				setInferredType(bodyExpression, branchTypeContext, expectedBodyType, checkContext);
			});
			let purity: CompileTimeFunctionType['purity'] = expression.arrow ?? 'unknown';
			//#region Purity-Inferenz (docs/pure-inference-umsetzung.md Schritt 3)
			// E6: der Dummy-Rumpf importierter TS-Funktionen ist keine Aussage über das JS dahinter -
			// für sie gilt der Pfeil, den der typescript-parser aus dem JSDoc ableitet. @pure heißt
			// dort nur "ruft nichts Unreines außer den übergebenen Funktionen auf".
			if (isTypeScriptFile(filePath)) {
				if (expression.arrow === 'pure'
					&& !canNotHoldFunction(paramsTypeValue)) {
					purity = 'pureIfArgsPure';
				}
			}
			else {
				const bodyPurity = inferBodyPurity(expression.body, identity);
				// Ein Rumpf, der nur deshalb unentscheidbar ist, weil er eigene funktionswertige
				// Parameter aufruft, ist nicht grundsätzlich unentscheidbar, sondern bedingt rein.
				const conditionallyPure = bodyPurity.purity === 'unknown' && bodyPurity.unknownOnlyFromOwnParameterCalls;
				switch (expression.arrow) {
					case undefined:
					case 'unknown':
						purity = conditionallyPure ? 'pureIfArgsPure' : bodyPurity.purity;
						break;
					case 'impure':
						break;
					case 'pure':
						if (conditionallyPure) {
							// Still herabgesetzt, keine Diagnose: das Ergebnis ist strikt
							// präziser als die geschriebene Zusicherung und erhält das bisherige
							// konservative Verhalten an der Aufrufstelle.
							purity = 'pureIfArgsPure';
						}
						else if (bodyPurity.purity === 'impure') {
							purity = 'impure';
							// expression.returnType ist gesetzt: ein Pfeil bedingt einen Rückgabetyp
							// (functionTypeBodyParser), siehe "Geprüfte Voraussetzungen".
							const declaredReturnType = expression.returnType!;
							const impureExpression = bodyPurity.impureExpression ?? expression;
							errors.push({
								code: ErrorCode.purityMismatch,
								message: 'Purity mismatch.\nThe function is declared pure, but this call is not.',
								startRowIndex: impureExpression.startRowIndex,
								startColumnIndex: impureExpression.startColumnIndex,
								endRowIndex: impureExpression.endRowIndex,
								endColumnIndex: impureExpression.endColumnIndex,
								relatedInformation: {
									message: 'Declared as pure here.',
									startRowIndex: declaredReturnType.startRowIndex,
									startColumnIndex: declaredReturnType.startColumnIndex,
									endRowIndex: declaredReturnType.endRowIndex,
									endColumnIndex: declaredReturnType.endColumnIndex,
								},
							});
						}
						break;
				}
			}
			//#endregion Purity-Inferenz
			//#region Faltbarkeit
			// Ein Funktionsliteral ist faltbar, wenn sein Rumpf kein nativeFunction-/nativeValue-
			// Literal enthält (containsNativeLiteral, die Sicherheitsgrenze) und es nicht aus einer
			// .ts/.js-Datei stammt (deren Rumpf ist ein Emitter-Artefakt, keine Aussage über das
			// tatsächliche JS dahinter). Beides wird hier beim Prüfen des Literals berechnet, nicht
			// erst beim Falten: eine Aufrufstelle in einer anderen Datei kennt filePath nicht mehr.
			// Die dritte Bedingung - jede freie Referenz des Rumpfs lässt sich auflösen - hängt von
			// der Umgebung an der jeweiligen Aufrufstelle ab und wird deshalb nicht hier, sondern
			// im Auswerter geprüft (constant-folding.ts, buildEnvironment).
			const foldable = !isTypeScriptFile(filePath)
				&& !expression.body.some(containsNativeLiteral);
			//#endregion Faltbarkeit
			// Ein leerer body ist ungültig, nicht leer (Empty). Any als Ergebnis, damit sich der
			// Fehler nicht kaskadierend fortsetzt - beim Tippen ist der Zustand der Normalfall.
			const inferredReturnType: CompileTimeType = last(expression.body)?.typeInfo?.type ?? builtinAny;
			// Any als inferierter Typ heißt "nichts Genaueres bekannt", nicht "Any ist der Typ" -
			// hier auf den deklarierten Typ zurückfallen, sonst sehen Aufrufer Any statt der
			// geprüften Zusicherung. Ist der inferierte Typ enger als deklariert (Normalfall,
			// z.B. ein Literal), bleibt er erhalten - er ist die genauere Information.
			let returnType = inferredReturnType;
			if (declaredReturnType) {
				// roh für den Any-Fallback unten: der generische Platzhalter (z.B.
				// TypeOf(values)/ElementType) muss je Aufruf neu aufgelöst werden, nicht schon
				// hier mit dem an der Deklaration sichtbaren Parametertyp fest verdrahtet werden.
				const rawDeclaredReturnType = valueOf(declaredReturnType.typeInfo!.type);
				const dereferencedDeclaredReturnType = resolvePlaceholders(rawDeclaredReturnType);
				const returnAssignability = isTypeAssignable(resolvePlaceholders(inferredReturnType), dereferencedDeclaredReturnType);
				reportUnknown(returnAssignability, checkContext, 'Return', inferredReturnType, dereferencedDeclaredReturnType, last(expression.body) ?? expression);
				if (returnAssignability.assignable === false) {
					// Markiert wird nur der zurückgegebene Ausdruck (last(body)), nicht die
					// ganze Funktion - sonst ummantelt die mehrzeilige Klammerung (formatErrors)
					// den kompletten Funktionsrumpf statt der tatsächlich betroffenen Stelle.
					const returnedExpression = last(expression.body) ?? expression;
					errors.push({
						code: ErrorCode.returnTypeMismatch,
						message: `Return type mismatch.\n${typeErrorToString(returnAssignability.error)}`,
						startRowIndex: returnedExpression.startRowIndex,
						startColumnIndex: returnedExpression.startColumnIndex,
						endRowIndex: returnedExpression.endRowIndex,
						endColumnIndex: returnedExpression.endColumnIndex,
						// Verweist auf die Deklaration, damit sichtbar wird, WARUM der Zieltyp
						// gilt - besonders bei langen Funktionsrümpfen, wo die Signatur beim
						// Lesen der Rückgabe längst nicht mehr im Bild ist.
						relatedInformation: {
							message: `Declared as ${typeToString(dereferencedDeclaredReturnType, 0, 1)} here.`,
							startRowIndex: declaredReturnType.startRowIndex,
							startColumnIndex: declaredReturnType.startColumnIndex,
							endRowIndex: declaredReturnType.endRowIndex,
							endColumnIndex: declaredReturnType.endColumnIndex,
						},
					});
				}
				else if (inferredReturnType.julType === 'any'
					|| isUnresolvedPlaceholderType(rawDeclaredReturnType)) {
					// Any: kein body-Typ bekannt, deklarierter Typ ist die einzige Information.
					// Platzhalter: der deklarierte Typ referenziert eigene Parameter (z.B.
					// Concat(TypeOf(a) TypeOf(b))) und muss je Aufruf neu aufgelöst werden - der
					// body-Typ wäre nur die an der Deklaration sichtbare, fest verdrahtete Instanz.
					returnType = rawDeclaredReturnType;
				}
			}
			const functionType = createCompileTimeFunctionType(paramsTypeValue, returnType, purity, undefined, {
				identity: identity,
				literal: expression,
				foldable: foldable,
				predicate: getPredicateFacts(expression, returnType),
			});
			return { type: functionType };
		}
		case 'functionTypeLiteral': {
			const functionScopes: NonEmptyArray<SymbolTable> = [...scopes, expression.symbols];
			const params = expression.params;
			const identity = createFunctionIdentity(builtinEmpty);
			if (params.type === 'parameters') {
				setFunctionRefForParams(params, identity, functionScopes);
			}
			const functionTypeContext: TypeContext = {
				scopes: functionScopes,
				narrowedTypes: narrowedTypes,
			};
			setInferredType(params, functionTypeContext, undefined, checkContext);
			const paramsType = valueOf(params.typeInfo!.type);
			identity.ParamsType = paramsType;
			checkParamsTypeIsCollection(params, errors);
			// TODO check returnType muss pure sein
			setInferredType(expression.returnType, functionTypeContext, undefined, checkContext);
			const inferredReturnType = expression.returnType.typeInfo!.type;
			const functionType = createCompileTimeFunctionType(
				paramsType,
				valueOf(inferredReturnType),
				expression.arrow ?? 'unknown',
				undefined,
				{ identity: identity },
			);
			const rawType = createCompileTimeTypeOfType(functionType);
			return { type: rawType };
		}
		case 'integer': {
			const rawType = createIntegerLiteral(expression.value);
			return { type: rawType };
		}
		case 'list': {
			// TODO error when spread dictionary
			// Ein Spread verschiebt alle folgenden Positionen unbekannt weit.
			let firstSpreadIndex: number | undefined;
			expression.values.forEach((element, index) => {
				if (element.type === 'spread') {
					firstSpreadIndex ??= index;
					setInferredType(element.value, typeContext, undefined, checkContext);
					return;
				}
				const expectedElementType = firstSpreadIndex === undefined
					? getExpectedElementType(expression.expectedType, index)
					: getExpectedElementTypeAfterSpread(expression.expectedType, firstSpreadIndex);
				setInferredType(element, typeContext, expectedElementType, checkContext);
			});

			// Bleibt eine Spread-Quelle bis zum Aufruf offen (z.B. ein eigener Parameter), muss
			// die Aneinanderreihung ebenso offen bleiben - sonst fällt sie hier schon auf den
			// deklarierten Parametertyp zurück, obwohl Concat sie am Aufrufort exakt berechnen
			// könnte (docs/generic-types-through-function-body.md).
			const hasDeferredSpread = expression.values.some(element =>
				element.type === 'spread' && isUnresolvedPlaceholderType(element.value.typeInfo!.type));
			if (hasDeferredSpread) {
				const sources = expression.values.map(element =>
					element.type === 'spread'
						? element.value.typeInfo!.type
						: createCompileTimeTupleType([element.typeInfo!.type]));
				return { type: concatFromTypes(sources) };
			}

			// Akkumuliere Element-Typen, handle Spreads durch Flattening/Collapsing
			const tupleElements: CompileTimeType[] = [];
			let hasListSpread = false;

			for (const element of expression.values) {
				if (element.type === 'spread') {
					const sourceType = resolvePlaceholders(element.value.typeInfo!.type);
					const spreadResult = getSpreadElementTypes(sourceType);
					if (spreadResult) {
						if (spreadResult.isListSpread) {
							hasListSpread = true;
						}
						tupleElements.push(...spreadResult.elementTypes);
					} else {
						// Nicht auflösbare Quelle (z.B. Any): fallback zu any
						tupleElements.push(builtinAny);
					}
				} else {
					tupleElements.push(element.typeInfo!.type);
				}
			}

			// Entscheide outer type: List wenn min. ein List-Spread, sonst Tuple
			let rawType: CompileTimeType;
			if (hasListSpread) {
				// Baue Union aller tupleElements-Typen für List ElementType
				// WICHTIG: Resolve Placeholders auf jedem Element (z.B. parameterReference in List(T))
				const dereferencedElements = tupleElements.map(t => resolvePlaceholders(t));
				const unionType = createNormalizedUnionType(dereferencedElements);
				rawType = createCompileTimeListType(unionType);
			} else {
				// Alle Spreads sind Tuples (oder keine Spreads) → Tuple mit bekannter Länge
				rawType = createCompileTimeTupleType(tupleElements);
			}

			return { type: rawType };
		}
		case 'nestedReference': {
			const source = expression.source;
			setInferredType(source, typeContext, undefined, checkContext);
			const nestedKey = expression.nestedKey;
			if (!nestedKey) {
				return { type: builtinAny };
			}
			// Vor der Verengung, die weiter unten früh zurückkehrt: der Feldzugriff ist unabhängig
			// vom verengten Ergebnis eine Referenz auf die Felddeklaration.
			if (referenceIndex && nestedKey.type !== 'index') {
				recordFieldReference(nestedKey, source.typeInfo?.type, referenceIndex, filePath);
			}
			if (narrowedTypes) {
				const path = getAccessPath(expression, scopes);
				const narrowedType = path && getNarrowedType(narrowedTypes, path.symbol, path.keys);
				if (narrowedType) {
					return { type: narrowedType };
				}
			}
			switch (nestedKey.type) {
				case 'index': {
					// Ein ungültiger Index kann nichts dereferenzieren. Der Parser hat ihn schon
					// gemeldet, hier also gar nicht erst nachsehen.
					if (nestedKey.name < 1) {
						return { type: builtinAny };
					}
					const sourceType = resolvePlaceholders(source.typeInfo!.type);
					// Der rawType kann eine Form sein, die dereferenceIndexFromObject nicht
					// behandelt, z.B. das and aus der Verengung eines branches. Dann auf dem
					// aufgelösten Typ nachsehen, bevor der Index als daneben gilt.
					const dereferencedType = dereferenceIndexFromObject(nestedKey.name, source.typeInfo!.type)
						?? dereferenceIndexFromObject(nestedKey.name, sourceType);
					if (!dereferencedType) {
						// Zwei verschiedene Aussagen: die Art passt nicht zur Quelle (beweisbar
						// falsch, unabhängig von der Länge) oder der Index liegt daneben (nur
						// beweisbar, wenn die Länge feststeht).
						const kindMismatch = !canHaveIndexes(sourceType);
						if (kindMismatch || hasKnownLength(sourceType)) {
							const baseMessage = `Failed to dereference index ${nestedKey.name} in type ${typeToString(sourceType, 0, 0)}`;
							errors.push({
								code: ErrorCode.dereferenceFailed,
								message: kindMismatch
									? `${baseMessage}. An index needs a List.`
									: baseMessage,
								startRowIndex: nestedKey.startRowIndex,
								startColumnIndex: nestedKey.startColumnIndex,
								endRowIndex: nestedKey.endRowIndex,
								endColumnIndex: nestedKey.endColumnIndex,
							});
						}
						// Any als Ergebnis, damit sich der Fehler nicht kaskadierend fortsetzt
						return { type: builtinAny };
					}
					return { type: dereferencedType };
				}
				case 'name':
				case 'text': {
					const fieldName = getCheckedEscapableName(nestedKey);
					if (!fieldName) {
						return { type: builtinAny };
					}
					const sourceType = resolvePlaceholders(source.typeInfo!.type);
					// Der rawType kann eine Form sein, die dereferenceNameFromObject nicht behandelt,
					// z.B. das and aus der Verengung eines branches. Dann auf dem aufgelösten Typ
					// nachsehen, bevor das Feld als fehlend gilt.
					const rawDereferencedType = dereferenceNameFromObject(fieldName, source.typeInfo!.type);
					const resolvedDereferencedType = dereferenceNameFromObject(fieldName, sourceType);
					const dereferencedType = rawDereferencedType ?? resolvedDereferencedType;
					if (!dereferencedType
						|| (isUnresolvedPlaceholderType(dereferencedType) && !resolvedDereferencedType)) {
						// Ein Zugriff über einen unaufgelösten Verweis (parameterReference/
						// nestedReference) liefert selbst IMMER einen aufgeschobenen Knoten, nie
						// undefined - richtig fürs echte Generic-Warten, würde ein konkret
						// fehlendes Feld sonst aber für immer verschleiern (die Quelle ist z.B.
						// ein Funktionsparameter mit bereits vollständig bekanntem Typ). Deshalb
						// zusätzlich am AUFGELÖSTEN Typ prüfen, ob das Feld dort nachweislich fehlt.
						// Entweder passt die Art nicht zur Quelle, oder das Feld fehlt - letzteres
						// nur melden, wenn der Quelltyp seine Feldmenge kennt. Sonst würde aus
						// "weiß ich nicht" ein "gibt es nicht" und jeder noch unaufgelöste Typ
						// lieferte Falschfehler.
						const kindMismatch = !canHaveFields(sourceType);
						if (kindMismatch || hasKnownFields(sourceType)) {
							const baseMessage = `Failed to dereference field '${fieldName}' in type ${typeToString(sourceType, 0, 0)}`;
							errors.push({
								code: ErrorCode.dereferenceFailed,
								message: kindMismatch
									? `${baseMessage}. A field name needs a Dictionary.`
									: isTypePropertyOfValue(resolveAlias(sourceType).julType, fieldName)
										? `${baseMessage}. ${fieldName} is a property of the type: TypeOf(…)/${fieldName}.`
										: baseMessage,
								startRowIndex: nestedKey.startRowIndex,
								startColumnIndex: nestedKey.startColumnIndex,
								endRowIndex: nestedKey.endRowIndex,
								endColumnIndex: nestedKey.endColumnIndex,
							});
							// Any als Ergebnis, damit sich der Fehler nicht kaskadierend fortsetzt
							return { type: builtinAny };
						}
						if (!dereferencedType) {
							// Weder roh noch aufgelöst entscheidbar - abwarten wie bisher.
							return { type: builtinAny };
						}
						// Nicht entscheidbar (weder Fehler noch Erfolg bewiesen): der aufgeschobene
						// Platzhalter bleibt stehen, genau wie vor dieser zusätzlichen Prüfung.
					}
					return { type: dereferencedType };
				}
				default: {
					const assertNever: never = nestedKey;
					throw new Error(`Unexpected nestedKey.type ${(assertNever as TypedExpression).type}`);
				}
			}
		}
		case 'object': {
			// TODO error when List/Dictionary mixed
			expression.values.forEach(element => {
				setInferredType(element.value, typeContext, undefined, checkContext);
			});

			// Bleibt eine Spread-Quelle bis zum Aufruf offen, muss die Aneinanderreihung ebenso
			// offen bleiben (dieselbe Begründung wie bei case 'list').
			const hasDeferredSpread = expression.values.some(element =>
				isUnresolvedPlaceholderType(element.value.typeInfo!.type));
			if (hasDeferredSpread) {
				return { type: concatFromTypes(expression.values.map(element => element.value.typeInfo!.type)) };
			}

			// Nur reine Spreads (siehe ParseUnknownObjectLiteral) - Bug (CHECKER-AUDIT.md #6):
			// f(...values) landete bisher komplett auf Any, weil dieser Fall bislang gar nicht
			// aufgelöst wurde. Auflösung wie bei case 'list': lässt sich jede Quelle als
			// Liste/Tuple/Empty auflösen, wird genauso zu Tuple bzw. List zusammengesetzt.
			const tupleElements: CompileTimeType[] = [];
			let hasListSpread = false;
			let isResolvableAsList = true;
			for (const element of expression.values) {
				const sourceType = resolvePlaceholders(element.value.typeInfo!.type);
				const spreadResult = getSpreadElementTypes(sourceType);
				if (!spreadResult) {
					isResolvableAsList = false;
					break;
				}
				if (spreadResult.isListSpread) {
					hasListSpread = true;
				}
				tupleElements.push(...spreadResult.elementTypes);
			}
			if (isResolvableAsList) {
				const rawType = hasListSpread
					? createCompileTimeListType(createNormalizedUnionType(tupleElements.map(resolvePlaceholders)))
					: createCompileTimeTupleType(tupleElements);
				return { type: rawType };
			}

			// Lässt sich nicht als Liste/Tuple auflösen: laut ParseUnknownObjectLiteral kann die
			// Quelle statt dessen auch ein Dictionary sein (f(...namedArgs)). Wie beim Spread in
			// case 'dictionary': spätere Felder überschreiben frühere gleichnamige.
			const fieldTypes: CompileTimeDictionary = {};
			let isResolvableAsDictionary = true;
			for (const element of expression.values) {
				const sourceType = resolvePlaceholders(element.value.typeInfo!.type);
				if (!isDictionaryLiteralType(sourceType)) {
					isResolvableAsDictionary = false;
					break;
				}
				for (const key in sourceType.Fields) {
					fieldTypes[key] = sourceType.Fields[key]!;
				}
			}
			if (!isResolvableAsDictionary) {
				return { type: builtinAny };
			}
			return { type: createCompileTimeDictionaryLiteralType(fieldTypes, true) };
		}
		case 'parameter': {
			const typeGuard = expression.typeGuard;
			if (typeGuard) {
				setInferredType(typeGuard, typeContext, undefined, checkContext);
				checkTypeGuardIsType(typeGuard, errors);
			}
			checkNameDefinedInUpperScope(expression, scopes, errors, expression.name.name);
			const typeGuardType = typeGuard?.typeInfo?.type;
			// Ein hingeschriebener TypeGuard gilt, auch wenn der Aufrufkontext etwas anderes
			// zusichert - sonst wäre er stillschweigend wirkungslos und die Kontravarianzprüfung
			// vergliche den erwarteten Typ mit sich selbst. Der Kontext füllt nur untypisierte
			// Parameter (`values.map((item) => ...)`). Die Fallunterscheidung muss am TypeGuard
			// selbst hängen, nicht an valueOf: valueOf(undefined) liefert Any, nicht undefined.
			const inferredType = typeGuardType
				? valueOf(typeGuardType)
				: expression.expectedType ?? builtinAny;
			// TODO check array type bei spread
			const parameterSymbol = findParameterSymbol(expression, scopes);
			const typeInfo: TypeInfo = { type: inferredType };
			parameterSymbol.typeInfo = typeInfo;
			checkNamingCase(expression.name, inferredType, errors);
			return typeInfo;
		}
		case 'parameters': {
			expression.singleFields.forEach((field, index) => {
				const expectedParameterType = getExpectedElementType(expression.expectedType, index);
				setInferredType(field, typeContext, expectedParameterType, checkContext);
			});
			const rest = expression.rest;
			if (rest) {
				setInferredType(rest, typeContext, undefined, checkContext);
				// TODO check rest type is list type
			}
			const rawType = createParametersType(
				expression.singleFields.map(field => {
					return {
						name: field.source?.name ?? field.name.name,
						type: field.typeInfo?.type
					};
				}),
				rest && {
					name: rest.name.name,
					type: rest.typeInfo?.type
				},
			);
			return { type: rawType };
		}
		case 'reference': {
			const {
				found,
				foundSymbol,
				type,
				isBuiltIn,
			} = dereferenceType(expression, scopes);
			const name = expression.name.name;
			// Name statt Symbol wie bei den übrigen Builtins: `test` zu überschatten ist JUL3203.
			if (name === 'test'
				&& isBuiltIn
				&& !isCalledFunction(expression)) {
				errors.push({
					code: ErrorCode.testNotCalled,
					message: `'test' can only be called directly.`,
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.endRowIndex,
					endColumnIndex: expression.endColumnIndex,
				});
			}
			if (!found) {
				errors.push({
					code: ErrorCode.notDefined,
					message: `'${name}' is not defined.`,
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.endRowIndex,
					endColumnIndex: expression.endColumnIndex,
				});
			}
			// check position: reference (expression) darf nicht vor definition (foundSymbol) benutzt werden
			// wenn kein foundSymbol: symbol ist in core-lib definiert, dann ist alles erlaubt
			if (foundSymbol
				&& !isBuiltIn
				&& (expression.startRowIndex < foundSymbol.startRowIndex
					|| (expression.startRowIndex === foundSymbol.startRowIndex
						&& expression.startColumnIndex < foundSymbol.startColumnIndex))) {
				errors.push({
					code: ErrorCode.usedBeforeDefined,
					message: `'${name}' is used before it is defined.`,
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.endRowIndex,
					endColumnIndex: expression.endColumnIndex,
				});
			}
			if (foundSymbol
				&& !isBuiltIn
				&& !foundSymbol.isUsed
				&& !isInside(expression, foundSymbol.definition)) {
				foundSymbol.isUsed = true;
			}
			if (referenceIndex && foundSymbol && !isBuiltIn) {
				const canonical = resolveCanonicalSymbol(foundSymbol, filePath, parsedDocuments);
				referenceIndex.recordReference(canonical.symbol, canonical.filePath, {
					filePath,
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.endRowIndex,
					endColumnIndex: expression.endColumnIndex,
				});
			}
			const narrowedType = foundSymbol && getNarrowedType(narrowedTypes, foundSymbol, []);
			return { type: narrowedType ?? type };
		}
		case 'text': {
			// TODO string template type?
			if (expression.values.every((part): part is TextToken => part.type === 'textToken')) {
				// string literal type
				// TODO sollte hier überhaupt mehrelementiger string möglich sein?
				const rawType = createTextLiteral(
					expression.values.map(part => part.value).join('\n'));
				return { type: rawType };
			}
			expression.values.forEach(part => {
				if (part.type !== 'textToken') {
					setInferredType(part, typeContext, undefined, checkContext);
				}
			});
			return { type: builtinText };
		}
		default: {
			const assertNever: never = expression;
			throw new Error(`Unexpected valueExpression.type: ${(assertNever as TypedExpression).type}`);
		}
	}
}

function isTypeCombinatorCall(functionCall: ParseFunctionCall): boolean {
	const functionExpression = functionCall.functionExpression;
	return functionExpression?.type === 'reference'
		&& typeCombinatorNames.includes(functionExpression.name.name);
}

/**
 * Die Selbstreferenz einer Definition, die durch keinen datentragenden Konstruktor läuft.
 * Eine solche Gleichung (Bad = Or(Integer Bad)) hat keine eindeutige Lösung - sie wird von jeder
 * Obermenge von Integer erfüllt - und beim Prüfen eines Werts wird nichts kleiner. Genau daran
 * würde auch die Auflösung nicht terminieren.
 * Konservativ: was hier nicht als Kombinator erkannt wird, gilt als produktiv und wird nicht
 * gemeldet. Eine Falschmeldung wäre teurer als eine ausgelassene.
 */
function findUnproductiveSelfReferenceInDefinition(
	value: ParseValueExpression,
	definitionName: string,
): ParseReference | undefined {
	if (value.type === 'functionLiteral') {
		// Eine Typfunktion, die sich ohne Datenebene selbst aufruft (Loop = (T: Type) => Loop(T)),
		// liefe beim Auflösen und beim Prüfen zur Laufzeit ebenso endlos. Maßgeblich ist, was sie
		// liefert, also der letzte Ausdruck des Rumpfs.
		const result = last(value.body);
		return isTypeName(definitionName) && result
			? findUnproductiveSelfReference(result, definitionName, true)
			: undefined;
	}
	return findUnproductiveSelfReference(value, definitionName, false);
}

function findUnproductiveSelfReference(
	expression: PositionedExpression,
	definitionName: string,
	/**
	 * Im Rumpf einer Typfunktion steht ihr Aufruf für den Typ selbst. Außerhalb nicht: dort ruft
	 * sich etwa nativeFunction = nativeFunction(...) auf, ohne einen Typ zu beschreiben.
	 */
	isTypeFunctionBody: boolean,
): ParseReference | undefined {
	switch (expression.type) {
		case 'reference':
			return expression.name.name === definitionName
				? expression
				: undefined;
		case 'dictionary':
		case 'dictionaryType':
		case 'list':
		case 'object':
		case 'functionLiteral':
		case 'functionTypeLiteral':
			return undefined;
		case 'functionCall': {
			const functionExpression = expression.functionExpression;
			if (isTypeFunctionBody
				&& functionExpression?.type === 'reference'
				&& functionExpression.name.name === definitionName) {
				return functionExpression;
			}
			if (!isTypeCombinatorCall(expression)) {
				return undefined;
			}
			// Nur in die Argumente absteigen: die Argumentliste ist syntaktisch eine Kollektion
			// (list/dictionary), fügt aber keine Datenebene hinzu.
			const args = expression.arguments;
			return args
				&& forEachChild(args, child =>
					findUnproductiveSelfReference(child, definitionName, isTypeFunctionBody));
		}
		default:
			return forEachChild(expression, child =>
				findUnproductiveSelfReference(child, definitionName, isTypeFunctionBody));
	}
}

//#region get Type from FunctionCall

function getReturnTypeFromFunctionCall(
	functionCall: ParseFunctionCall,
	functionExpression: SimpleExpression,
	checkContext: CheckContext,
): CompileTimeType {
	const { documents: parsedDocuments, folder } = checkContext;
	const errors = checkContext.file.errors;
	const argsType = functionCall.arguments?.typeInfo?.type ?? builtinAny;
	const boundArgsType = bindReceiver(functionCall.prefixArgument?.typeInfo?.type, argsType);
	// TODO statt functionname functionref value/inferred type prüfen?
	if (functionExpression.type === 'reference') {
		const functionName = functionExpression.name.name;
		switch (functionName) {
			case 'import': {
				const { path, error } = getPathFromImport(functionCall, folder);
				// Für einen Top-Level-Import hat der Parser den Fehler schon gemeldet
				// (getImportedPaths), und checked ist ein Klon von unchecked - sonst stünde er doppelt da.
				if (error
					&& !isTopLevelImport(functionCall)) {
					errors.push(error);
				}
				if (!path) {
					return builtinAny;
				}
				// TODO get full path, get type from parsedfile
				const fullPath = join(folder, path);
				const importedFile = parsedDocuments[fullPath]?.checked;
				if (!importedFile) {
					return builtinAny;
				}
				// definitions import
				// a dictionary containing all definitions is imported
				const exportedSymbols = getExportedSymbols(importedFile.symbols);
				if (Object.keys(exportedSymbols).length) {
					const importedTypes = mapDictionary(exportedSymbols, symbol => {
						const symbolType: CompileTimeType = symbol.typeInfo
							? symbol.typeInfo.type
							: builtinAny;
						return symbolType;
					});
					// TODO exrepssion, filePath?
					return createCompileTimeDictionaryLiteralType(importedTypes, true);
				}
				// value import
				// the last expression is imported
				if (!importedFile.expressions) {
					return builtinAny;
				}
				const lastExpression = last(importedFile.expressions);
				if (!lastExpression) {
					return builtinAny;
				}
				return lastExpression.typeInfo
					? lastExpression.typeInfo.type
					: builtinAny;
			}
			case 'And': {
				const argTypes = getAllArgTypes(boundArgsType);
				if (!argTypes) {
					// TODO unknown?
					return builtinAny;
				}
				return createCompileTimeTypeOfType(createNormalizedIntersectionType(argTypes.map(valueOf)));
			}
			case 'ElementAt': {
				const argTypes = getAllArgTypes(boundArgsType);
				const sourceType = argTypes?.[0];
				const indexType = argTypes?.[1];
				if (!sourceType
					|| !indexType) {
					return builtinAny;
				}
				const elementType = dereferenceNestedKeyFromObject(valueOf(indexType), valueOf(sourceType));
				return createCompileTimeTypeOfType(elementType ?? builtinAny);
			}
			case 'LengthOf': {
				const argTypes = getAllArgTypes(boundArgsType);
				const sourceType = argTypes?.[0];
				if (!sourceType) {
					return builtinAny;
				}
				return createCompileTimeTypeOfType(getLengthFromType(valueOf(sourceType)));
			}
			case 'WithElementAt': {
				const argTypes = getAllArgTypes(boundArgsType);
				const sourceType = argTypes?.[0];
				const indexType = argTypes?.[1];
				const valueType = argTypes?.[2];
				if (!sourceType
					|| !indexType
					|| !valueType) {
					return builtinAny;
				}
				return createCompileTimeTypeOfType(
					withElementAtFromTypes(valueOf(sourceType), valueOf(indexType), valueOf(valueType)));
			}
			case 'IndexRange': {
				const argTypes = getAllArgTypes(boundArgsType);
				const startType = argTypes?.[0];
				if (!startType) {
					return builtinAny;
				}
				const endType = argTypes?.[1] ?? builtinEmpty as CompileTimeType;
				return createCompileTimeTypeOfType(
					createCompileTimeIndexRangeType(valueOf(startType), valueOf(endType)));
			}
			case 'MapElements': {
				const argTypes = getAllArgTypes(boundArgsType);
				const sourceType = argTypes?.[0];
				const callbackType = argTypes?.[1];
				if (!sourceType
					|| !callbackType) {
					return builtinAny;
				}
				return createCompileTimeTypeOfType(
					mapElementsFromTypes(valueOf(sourceType), valueOf(callbackType)));
			}
			case 'Concat': {
				const argTypes = getAllArgTypes(boundArgsType);
				if (!argTypes) {
					return builtinAny;
				}
				return createCompileTimeTypeOfType(
					concatFromTypes(argTypes.map(valueOf)));
			}
			case 'Add': {
				const argTypes = getAllArgTypes(boundArgsType);
				const argType = argTypes?.[0];
				if (!argType) {
					return builtinAny;
				}
				return createCompileTimeTypeOfType(addFromTypes(valueOf(argType)));
			}
			case 'Not': {
				const argTypes = getAllArgTypes(boundArgsType);
				if (!argTypes) {
					// TODO unknown?
					return builtinAny;
				}
				if (!isNonEmpty(argTypes)) {
					// TODO unknown?
					return builtinAny;
				}
				return createCompileTimeTypeOfType(createCompileTimeComplementType(valueOf(argTypes[0])));
			}
			case 'Or': {
				const argTypes = getAllArgTypes(boundArgsType);
				if (!argTypes) {
					// TODO unknown?
					return builtinAny;
				}
				const choices = argTypes.map(valueOf);
				const unionType = createNormalizedUnionType(choices);
				return createCompileTimeTypeOfType(unionType);
			}
			case 'TypeOf': {
				const argTypes = getAllArgTypes(boundArgsType);
				if (!argTypes) {
					// TODO unknown?
					return builtinAny;
				}
				if (!isNonEmpty(argTypes)) {
					// TODO unknown?
					return builtinAny;
				}
				return createCompileTimeTypeOfType(argTypes[0]);
			}
			case 'GreaterInteger':
			case 'LessInteger': {
				const argTypes = getAllArgTypes(boundArgsType);
				if (!argTypes) {
					// TODO unknown?
					return builtinAny;
				}
				if (!isNonEmpty(argTypes)) {
					// TODO unknown?
					return builtinAny;
				}
				return createCompileTimeTypeOfType(createCompileTimeBoundType(
					functionName === 'GreaterInteger' ? 'greater' : 'less',
					'integer',
					valueOf(argTypes[0])));
			}
			default:
				break;
		}
	}
	const functionType = functionExpression.typeInfo;
	return getReturnTypeFromFunctionType(functionType);
}

//#endregion get Type from FunctionCall

//#region Sequenz Arithmetik

/**
 * Elemente, die ein Spread in ein List-Literal einbringt, und ob dadurch die Gesamtlänge
 * unbestimmt wird (dann muss das Literal zur List werden statt zum Tuple). `Or([] List(X))`
 * (Idiom für eine möglicherweise leere Liste) muss dafür durch seine Choices hindurchschauen:
 * unterschiedliche Längen zwischen den Choices bedeuten ebenfalls eine unbestimmte Gesamtlänge.
 */
function getSpreadElementTypes(
	rawSourceType: CompileTimeType,
): { elementTypes: CompileTimeType[]; isListSpread: boolean; } | undefined {
	const sourceType = resolveAlias(rawSourceType);
	switch (sourceType.julType) {
		case 'tuple':
			return { elementTypes: sourceType.ElementTypes, isListSpread: false };
		case 'list':
			return { elementTypes: [sourceType.ElementType], isListSpread: true };
		case 'empty':
			return { elementTypes: [], isListSpread: false };
		case 'or': {
			const subResults = sourceType.ChoiceTypes.map(getSpreadElementTypes);
			if (subResults.some(subResult => !subResult)) {
				return undefined;
			}
			const resolvedResults = subResults as { elementTypes: CompileTimeType[]; isListSpread: boolean; }[];
			const lengths = new Set(resolvedResults.map(subResult => subResult.elementTypes.length));
			const isListSpread = resolvedResults.some(subResult => subResult.isListSpread) || lengths.size > 1;
			const elementTypes = resolvedResults.flatMap(subResult => subResult.elementTypes);
			return { elementTypes: elementTypes, isListSpread: isListSpread };
		}
		default:
			return undefined;
	}
}

//#endregion Sequenz Arithmetik

//#region Typ Arithmetik

/** pure < unknown < impure. Ein beweisbar unreiner Beitrag gewinnt, sonst ein unbekannter. */
function joinPurity(first: Purity, second: Purity): Purity {
	if (first === 'impure' || second === 'impure') {
		return 'impure';
	}
	if (first === 'unknown' || second === 'unknown') {
		return 'unknown';
	}
	return 'pure';
}

/**
 * Purity-Beitrag eines übergebenen Werts (Argument, Prefix-Argument oder ganze Argumentliste).
 * ownFunctionType ist gesetzt, wenn innerhalb eines Rumpfes inferiert wird (Schritt 2): dann zählt
 * die Weitergabe eines eigenen Parameters als rein (E1), aber nur solange die Referenz nicht aus
 * einer fremden Funktion stammt (E2). Ohne den Kontext - also bei der Faltung - zählt sie als
 * 'unknown'.
 */
function getArgumentPurity(rawArgType: CompileTimeType, ownFunctionType: FunctionIdentity | undefined): Purity {
	const argType = resolveAlias(rawArgType);
	if (isFunctionType(argType)) {
		// Mit welchen Argumenten eine bedingt reine Funktion später gerufen wird, ist an der
		// Übergabestelle nicht bekannt - sie zählt hier wie 'unknown'.
		return argType.purity === 'pureIfArgsPure' ? 'unknown' : argType.purity;
	}
	if (argType.julType === 'parameterReference') {
		if (argType.functionRef === ownFunctionType) {
			return 'pure';
		}
		// Ein fremder (aus einer äußeren Funktion geschlossener) Parameter ist nicht pauschal
		// unentscheidbar, sondern nur so weit, wie sein deklarierter Typ überhaupt eine Funktion
		// sein kann - ein Integer ist nie aufrufbar und kann die Weitergabe nicht unrein machen.
		// Ein Funktionsparameter landet über den deklarierten Typ oben im Funktionstyp-Zweig und
		// trägt dort weiterhin seine eigene (bei `:>` unbekannte) Purity - für ihn ändert sich
		// nichts.
		const declaredType = dereferenceParameterTypeFromFunctionRef(argType);
		return declaredType && declaredType !== argType
			? getArgumentPurity(declaredType, ownFunctionType)
			: 'unknown';
	}
	// Ein Schnitt ist höchstens so groß wie sein kleinster Teil: kann ein Teil keine Funktion
	// sein, kann es der ganze Schnitt nicht. Deshalb genügt hier ein reiner Teil - anders als bei
	// der Vereinigung unten, wo jeder Teil möglich ist und deshalb jeder rein sein muss.
	// Ohne diesen Abstieg fällt schon ein verengter Parameter durch (im branch steht statt `a`
	// der genarrowte Typ `And(a Not(0))`).
	if (argType.julType === 'and') {
		return argType.ChoiceTypes.some(choiceType =>
			getArgumentPurity(choiceType, ownFunctionType) === 'pure')
			? 'pure'
			: 'unknown';
	}
	if (argType.julType === 'or') {
		return argType.ChoiceTypes.reduce<Purity>(
			(purity, choiceType) => joinPurity(purity, getArgumentPurity(choiceType, ownFunctionType)),
			'pure');
	}
	if (isTupleType(argType)) {
		return argType.ElementTypes.reduce<Purity>(
			(purity, elementType) => joinPurity(purity, getArgumentPurity(elementType, ownFunctionType)),
			'pure');
	}
	if (isDictionaryLiteralType(argType)) {
		return Object.values(argType.Fields).reduce<Purity>(
			(purity, fieldType) => joinPurity(purity, getArgumentPurity(fieldType, ownFunctionType)),
			'pure');
	}
	switch (argType.julType) {
		case 'empty':
		case 'integer':
		case 'integerLiteral':
		case 'float':
		case 'floatLiteral':
		case 'text':
		case 'textLiteral':
		case 'boolean':
		case 'booleanLiteral':
		case 'date':
		case 'blob':
		case 'error':
			return 'pure';
		// Ein Typ als Wert (Integer in aggregate(values Integer ...)) ist ein Beschreibungsobjekt und
		// nicht aufrufbar, die Weitergabe kann nichts Unreines auslösen.
		case 'typeOf':
			return 'pure';
		default:
			return 'unknown';
	}
}

/**
 * Purity eines konkreten Aufrufs, dreiwertig (Argument-Regel aus docs/pure-functions.md, verschärft
 * in docs/pure-inference-umsetzung.md Schritt 1): die aufgerufene Funktion muss 'pure' sein, und
 * jeder übergebene Wert - Prefix-Argument eingeschlossen - muss seinerseits 'pure' sein, sonst
 * gewinnt der schwächste Beitrag (joinPurity). Kein Fixpunkt, kein neuer Zustand im Typ - das
 * Ergebnis gilt nur für diese eine Aufrufstelle.
 */
export function getCallPurityInfo(
	functionType: CompileTimeType,
	boundArgsType: CompileTimeType,
	ownFunctionType?: FunctionIdentity,
): Purity {
	const { receiverType: prefixArgumentType, argsType } = splitReceiver(boundArgsType);
	const resolvedFunctionType = resolveAlias(functionType);
	if (!isFunctionType(resolvedFunctionType)) {
		return 'unknown';
	}
	if (resolvedFunctionType.purity !== 'pureIfArgsPure') {
		return resolvedFunctionType.purity;
	}
	const prefixPurity = prefixArgumentType
		? getArgumentPurity(prefixArgumentType, ownFunctionType)
		: 'pure';
	const argsPurity = getArgumentPurity(argsType, ownFunctionType);
	return joinPurity(prefixPurity, argsPurity);
}

/** Zweiwertige Auskunft für die Faltung: nur ein Beweis genügt. */
export function getCallPurity(
	functionType: CompileTimeType,
	argsType: CompileTimeType,
): Purity {
	return getCallPurityInfo(functionType, argsType) === 'pure' ? 'pure' : 'impure';
}

/**
 * E6: der Dummy-Rumpf (`nativeValue`) importierter TS-Funktionen ist ein Artefakt des
 * typescript-parsers, keine Aussage über das JS dahinter - ihre Purity kommt aus dem JSDoc,
 * nicht aus der Inferenz.
 */
function isTypeScriptFile(filePath: string): boolean {
	const extension = extname(filePath);
	return extension === Extension.ts || extension === Extension.js;
}

/**
 * Nimmt kein Parameter eine Funktion auf? Nach derselben Regel wie ein übergebener Wert
 * (getArgumentPurity): was sich nicht als funktionsfrei erweisen lässt, etwa Any oder eine
 * Liste, zählt als möglicher Callback.
 */
function canNotHoldFunction(paramsType: CompileTimeType): boolean {
	if (paramsType.julType !== 'parameters') {
		return false;
	}
	const parameters = paramsType.rest
		? [...paramsType.singleNames, paramsType.rest]
		: paramsType.singleNames;
	return parameters.every(parameter =>
		parameter.type !== undefined
		&& getArgumentPurity(parameter.type, undefined) === 'pure');
}

export interface BodyPurity {
	purity: Purity;
	/** Erste beweisbar unreine Stelle - für JUL5101, damit der Fehler dort steht, wo er entsteht. */
	impureExpression?: PositionedExpression;
	/**
	 * Nur relevant, wenn purity 'unknown' ist: true, wenn jeder unentscheidbare Beitrag aus dem
	 * Aufruf eines eigenen funktionswertigen Parameters stammt (E1) - dann ist der Rumpf nicht
	 * grundsätzlich unentscheidbar, sondern bedingt rein (pureIfArgsPure). Ein fremder, über eine
	 * äußere Funktion geschlossener Parameter (E2) oder jede andere Unknown-Quelle macht false.
	 */
	unknownOnlyFromOwnParameterCalls: boolean;
}

/**
 * Inferiert die Purity eines Funktionsrumpfs aus dem bereits geprüften Baum (jeder Knoten trägt
 * typeInfo). Keine eigene Typauflösung, nur Lesen - docs/pure-inference-umsetzung.md Schritt 2.
 * ownFunctionType ist der Typ der Funktion, deren Rumpf gerade untersucht wird - er entscheidet,
 * ob ein aufgerufener oder weitergegebener Parameter der eigene ist (E1) oder ein fremder,
 * geschlossen über eine äußere Funktion (E2).
 */
export function inferBodyPurity(
	body: ParseExpression[],
	ownFunctionType: FunctionIdentity,
): BodyPurity {
	let purity: Purity = 'pure';
	let impureExpression: PositionedExpression | undefined;
	let unknownOnlyFromOwnParameterCalls = true;

	function contribute(contributedPurity: Purity, expression: PositionedExpression, fromOwnParameterCall = false): void {
		if (contributedPurity === 'impure' && !impureExpression) {
			impureExpression = expression;
		}
		if (contributedPurity === 'unknown' && !fromOwnParameterCall) {
			unknownOnlyFromOwnParameterCalls = false;
		}
		purity = joinPurity(purity, contributedPurity);
	}

	function walk(expression: PositionedExpression): undefined {
		switch (expression.type) {
			case 'functionLiteral':
				// Eine Funktion zu erzeugen ist rein; ihr Aufruf trägt bei, nicht ihre Erzeugung -
				// und ihre Purity steht bereits an ihrem Typ, weil sie vorher inferiert wurde.
				return undefined;
			case 'functionCall': {
				const functionExpression = expression.functionExpression;
				if (functionExpression?.type === 'reference'
					&& isSelfReference(functionExpression, functionExpression.name.name)) {
					// E5: der rekursive Aufruf wird optimistisch als rein angenommen.
					contribute('pure', expression);
				}
				else {
					const calleeType = functionExpression?.typeInfo && resolveAlias(functionExpression.typeInfo.type);
					if (calleeType?.julType === 'parameterReference') {
						// E1/E2: der eigene Parameter direkt aufzurufen ist bedingt rein - mit
						// welchen Argumenten er später gerufen wird, entscheidet sich erst an der
						// Aufrufstelle dieser Funktion (Schritt 4). Ein fremder (aus einer äußeren
						// Funktion geschlossener) Parameter bleibt uneingeschränkt unentscheidbar.
						const isOwnParameter = calleeType.functionRef === ownFunctionType;
						contribute('unknown', expression, isOwnParameter);
					}
					else {
						const argsType = bindReceiver(
							expression.prefixArgument?.typeInfo?.type,
							expression.arguments?.typeInfo?.type ?? builtinEmpty);
						contribute(
							getCallPurityInfo(
								functionExpression?.typeInfo?.type ?? builtinAny,
								argsType,
								ownFunctionType),
							expression);
					}
				}
				// Weitere Aufrufe können in den Argumentausdrücken stehen.
				forEachChild(expression, walk);
				return undefined;
			}
			case 'branching': {
				// In die Zweig-Literale wird nicht abgestiegen - ihre Purity steht bereits an
				// ihrem Typ, genau wie bei jedem anderen aufgerufenen Wert. Ein Zweig muss kein
				// Literal sein, er kann auch eine Referenz auf eine Funktion sein.
				const branchesPurity = expression.branches.reduce<Purity>((accumulated, branch) => {
					const branchType = branch.typeInfo && resolveAlias(branch.typeInfo.type);
					if (!branchType || !isFunctionType(branchType)) {
						return joinPurity(accumulated, 'unknown');
					}
					// Ein Zweig-Literal, das nur deshalb unentscheidbar ist, weil es Parameter der
					// umgebenden Funktion aufruft (an seinem eigenen Typ fremd, E2), ist für die
					// umgebende Funktion bedingt rein: sein Rumpf wird aus ihrer Sicht noch einmal
					// untersucht, dort sind diese Parameter die eigenen.
					if (branch.type === 'functionLiteral' && branchType.purity === 'unknown') {
						const branchBodyPurity = inferBodyPurity(branch.body, ownFunctionType);
						contribute(
							branchBodyPurity.purity,
							branchBodyPurity.impureExpression ?? branch,
							branchBodyPurity.unknownOnlyFromOwnParameterCalls);
						return accumulated;
					}
					// Mit welchen Argumenten der getroffene Zweig gerufen wird, ist hier nicht
					// bekannt - eine bedingt reine Funktion zählt wie bei getArgumentPurity als 'unknown'.
					return joinPurity(accumulated, branchType.purity === 'pureIfArgsPure' ? 'unknown' : branchType.purity);
				}, 'pure');
				contribute(branchesPurity, expression);
				if (expression.args) {
					walk(expression.args);
				}
				return undefined;
			}
			case 'typeBranching':
				// Rechnet nur auf Typen, und die Zweige werden nie aufgerufen.
				return undefined;
			case 'reference':
				// Der bloße Zugriff ist rein, auch auf einen fremden Parameter (E2) - nur Aufruf
				// und Weitergabe zählen.
				return undefined;
			default:
				forEachChild(expression, walk);
				return undefined;
		}
	}

	body.forEach(walk);
	return { purity, impureExpression, unknownOnlyFromOwnParameterCalls };
}

/**
 * Die Sicherheitsgrenze für constant folding von Nutzerfunktionen: ein Funktionsliteral ist nur
 * faltbar, wenn sein Rumpf keinen Aufruf von nativeFunction/nativeValue enthält - beide sind
 * gewöhnliche core-lib-Builtins, über die Nutzercode beliebiges JS einbetten kann (siehe
 * tryBuildCallable). Die Menge der zur Prüfzeit ausgeführten Funktionen war bis zu dieser Stufe
 * kuratiert (nur runtime.ts); seither läuft erstmals emittierter Nutzercode zur Prüfzeit, und der
 * Language Server prüft beim Öffnen einer Datei ungefragt - eine Lücke hier bedeutet
 * Codeausführung beim bloßen Öffnen einer fremden .jul-Datei. Der Rumpf ist dabei beweisbar unrein
 * (nativeFunction/nativeValue sind `~>`) und fällt deshalb meist schon am Purity-Gate in
 * tryFoldCall durch - dieser Walker ist trotzdem der unabhängige, strukturelle zweite Riegel:
 * Purity ruht auf dem geschriebenen `~>` in der core-lib, einer Deklaration, keinem Beweis.
 * Anders als inferBodyPurity steigt dieser Walker auch in verschachtelte Funktionsliterale ab -
 * sie werden als Teil desselben emittierten Slice mit ausgeführt, wenn die äußere Funktion
 * gefaltet wird, ihre eigene Purity ist dafür irrelevant.
 */
function containsNativeLiteral(expression: PositionedExpression): boolean {
	if (expression.type === 'functionCall') {
		const functionExpression = expression.functionExpression;
		if (functionExpression?.type === 'reference'
			&& (functionExpression.name.name === 'nativeFunction' || functionExpression.name.name === 'nativeValue')) {
			return true;
		}
	}
	return forEachChild(expression, child => containsNativeLiteral(child) ? true : undefined) ?? false;
}

/**
 * Versucht, einen Aufruf eines `->`-Builtins mit compile-time bekannten Argumenten auszuführen
 * und sein Ergebnis als präziseren Typ zurückzugeben - der emittierte Code bleibt unverändert,
 * gefaltet wird nur der Typ. `undefined` heißt "nicht gefaltet"; das ist kein Fehler und wird nie
 * gemeldet. Die Bedingungen (kein Argumentfehler, Aufruf über eine Referenz, beweisbar reiner
 * Aufruf, Runtime-Export unter dem Namen, konstante Argumente) werden unten in dieser Reihenfolge
 * geprüft.
 */
function tryFoldCall(
	functionExpression: SimpleExpression,
	functionType: CompileTimeType,
	boundArgsType: CompileTimeType,
	hasArgsError: boolean,
): CompileTimeType | undefined {
	// Die Laufzeit bekommt den Empfänger wieder getrennt, das ist ihre Aufrufkonvention.
	const { receiverType: prefixArgumentType, argsType } = splitReceiver(boundArgsType);
	if (hasArgsError) {
		return undefined;
	}
	if (functionExpression.type !== 'reference') {
		return undefined;
	}
	const resolvedFunctionType = resolveAlias(functionType);
	if (!isFunctionType(resolvedFunctionType) || getCallPurity(resolvedFunctionType, boundArgsType) !== 'pure') {
		return undefined;
	}
	// Ein Typkonstruktor (List, Or, ...) liefert ein Typobjekt, das sich nicht in einen Typ
	// zurückübersetzen lässt (constantValueToType): der Aufruf liefe umsonst.
	const declaredReturnJulType = resolveAlias(resolvedFunctionType.ReturnType).julType;
	if (declaredReturnJulType === 'type'
		|| declaredReturnJulType === 'typeOf') {
		return undefined;
	}
	// Trägt der Typ ein literal, ist es eine Nutzerfunktion (case 'functionLiteral' setzt es) -
	// dafür der Auswerter (tryBuildCallable). Sonst ein Runtime-Export mit params unter diesem
	// Namen; params hängt nur an Builtins, die runtime.ts selbst per _createFunction(...)
	// registriert, ihre Namen sind über JUL3203 überdeckungsgeschützt. Eine per nativeFunction
	// definierte Funktion (z.B. myFn = nativeFunction(...)) trägt weder literal (sie entsteht aus
	// einer Signatur, nicht aus einem geprüften Rumpf) noch params (das hängt nur an runtime.ts-
	// Exporten) und faltet hier deshalb nicht - ihre `->`-Signatur ist eine ungeprüfte Zusicherung.
	const name = functionExpression.name.name;
	let callable: Function | undefined;
	if (resolvedFunctionType.literal) {
		callable = resolvedFunctionType.foldable ? tryBuildCallable(resolvedFunctionType) : undefined;
	}
	else {
		const runtimeFunction = (runtime as { [key: string]: unknown; })[escapeReservedJsVariableName(name)];
		callable = typeof runtimeFunction === 'function' && 'params' in runtimeFunction
			? runtimeFunction as Function
			: undefined;
	}
	if (!callable) {
		return undefined;
	}
	const prefixValue = prefixArgumentType && typeToConstantValue(prefixArgumentType);
	if (prefixArgumentType && !prefixValue) {
		return undefined;
	}
	const argsValue = typeToConstantValue(argsType);
	if (!argsValue) {
		return undefined;
	}
	checkerStats.foldableCall++;
	try {
		const result = runtime._callFunction(callable, prefixValue?.value, argsValue.value as any);
		return constantValueToType(result);
	}
	catch {
		return undefined;
	}
}

/**
 * Liefert der Aufruf eine Funktion, die im Rumpf der aufgerufenen steht, hält der Funktionstyp
 * fest, woran die Parameter gebunden sind - sonst teilen alle Aufrufe denselben deklarierten
 * Rückgabetyp, und divisibleBy(5) wäre weder faltbar noch von divisibleBy(3) zu unterscheiden.
 * Nur bei einem reinen Aufruf mit konstanten Argumenten, und nur wenn die aufgerufene Funktion
 * selbst nichts Ungebundenes aus einer umgebenden Funktion mitbringt. undefined heißt: bleibt
 * beim deklarierten Rückgabetyp.
 */
function bindClosureArguments(
	functionExpression: SimpleExpression,
	functionType: CompileTimeType,
	boundArgsType: CompileTimeType,
	returnType: CompileTimeType,
): CompileTimeFunctionType | undefined {
	const { receiverType: prefixArgumentType, argsType } = splitReceiver(boundArgsType);
	if (functionExpression.type !== 'reference') {
		return undefined;
	}
	const callee = resolveAlias(functionType);
	const result = resolveAlias(returnType);
	if (!isFunctionType(callee)
		|| !isFunctionType(result)
		|| !result.literal
		|| callee.purity !== 'pure') {
		return undefined;
	}
	const calleeLiteral = callee.literal;
	if (!calleeLiteral
		|| calleeLiteral.params.type !== 'parameters'
		|| calleeLiteral.params.rest) {
		return undefined;
	}
	if (isInsideFunctionLiteral(calleeLiteral)
		&& !callee.boundArguments) {
		return undefined;
	}
	if (!isInside(result.literal, calleeLiteral)) {
		return undefined;
	}
	const argsValue = typeToConstantValue(argsType);
	const prefixValue = prefixArgumentType && typeToConstantValue(prefixArgumentType);
	if (!argsValue
		|| (prefixArgumentType && !prefixValue)) {
		return undefined;
	}
	const positionalValues: unknown[] = [
		...(prefixValue ? [prefixValue.value] : []),
		...(Array.isArray(argsValue.value)
			? argsValue.value
			: argsValue.value === undefined
				? []
				: [argsValue.value]),
	];
	const parameterNames = calleeLiteral.params.singleFields.map(field => field.name.name);
	if (positionalValues.length > parameterNames.length) {
		return undefined;
	}
	const values: { [name: string]: unknown; } = { ...callee.boundArguments?.values };
	parameterNames.forEach((parameterName, index) => {
		values[parameterName] = positionalValues[index];
	});
	const argumentsDisplay = getAllArgTypes(boundArgsType)
		?.map(argType => typeToString(argType, 0, 1))
		.join(' ') ?? '';
	return createCompileTimeFunctionType(result.ParamsType, result.ReturnType, result.purity, result.aliasName, {
		...getFunctionTypeFacts(result),
		boundArguments: {
			values: values,
			display: `${functionExpression.name.name}(${argumentsDisplay})`,
		},
	});
}

//#endregion Typ Arithmetik

//#region test

/**
 * `test` ist nur in *.test.jul erlaubt. Liefert der Callback statisch false, schlägt der Test in
 * jedem Lauf fehl und wird schon hier gemeldet. Gefaltet wird dafür nichts Zusätzliches: Der
 * Rumpf des Callbacks ist beim Check des Literals bereits gefaltet, sein Rückgabetyp ist dann das
 * Literal. Ist er nur Boolean, entscheidet erst der Lauf.
 */
function checkTestCall(
	call: ParseFunctionCall,
	hasArgumentError: boolean,
	filePath: string,
	errors: CompilerError[],
): void {
	if (!isTestFilePath(filePath)) {
		errors.push({
			code: ErrorCode.testOutsideTestFile,
			message: `'test' is only allowed in *.test.jul files.`,
			startRowIndex: call.startRowIndex,
			startColumnIndex: call.startColumnIndex,
			endRowIndex: call.endRowIndex,
			endColumnIndex: call.endColumnIndex,
		});
		return;
	}
	if (call.parent) {
		errors.push({
			code: ErrorCode.testNotTopLevel,
			message: `'test' is only allowed at the top level of a file.`,
			startRowIndex: call.startRowIndex,
			startColumnIndex: call.startColumnIndex,
			endRowIndex: call.endRowIndex,
			endColumnIndex: call.endColumnIndex,
		});
	}
	const { name, callback } = getTestCallArguments(call);
	if (name && getTestName(call) === undefined) {
		errors.push({
			code: ErrorCode.testNameNotLiteral,
			message: 'The name of a test must be a text literal without interpolation.',
			startRowIndex: name.startRowIndex,
			startColumnIndex: name.startColumnIndex,
			endRowIndex: name.endRowIndex,
			endColumnIndex: name.endColumnIndex,
		});
	}
	if (hasArgumentError) {
		return;
	}
	const callbackType = callback?.typeInfo && resolveAlias(resolvePlaceholders(callback.typeInfo.type));
	if (!isFunctionType(callbackType)) {
		return;
	}
	const returnType = resolveAlias(resolvePlaceholders(callbackType.ReturnType));
	if (returnType.julType !== 'booleanLiteral'
		|| returnType.value) {
		return;
	}
	const lastExpression = callback!.type === 'functionLiteral'
		? last(callback!.body)
		: undefined;
	const callText = lastExpression?.type === 'functionCall'
		? getFoldedCallText(lastExpression)
		: undefined;
	const position = callText
		? lastExpression!
		: callback!;
	errors.push({
		code: ErrorCode.testFails,
		message: `Test fails.\n${callText ?? 'The callback'} returns false.`,
		startRowIndex: position.startRowIndex,
		startColumnIndex: position.startColumnIndex,
		endRowIndex: position.endRowIndex,
		endColumnIndex: position.endColumnIndex,
	});
}

/**
 * Die Referenz ist selbst die aufgerufene Funktion eines Aufrufs, auch in der Präfixform.
 */
function isCalledFunction(reference: ParseReference): boolean {
	const parent = reference.parent;
	return parent?.type === 'functionCall'
		&& parent.functionExpression === reference;
}

/**
 * Jeder weitere Test gleichen Namens in der Datei. Nur auf oberster Ebene, ein test anderswo ist
 * schon JUL2702, und ohne literalen Namen JUL2701.
 */
function reportDuplicateTestNames(file: ParsedExpressions2): void {
	const names = new Set<string>();
	file.expressions?.forEach(expression => {
		if (expression.type !== 'functionCall'
			|| expression.functionExpression?.type !== 'reference'
			|| expression.functionExpression.name.name !== 'test') {
			return;
		}
		const name = getTestName(expression);
		if (name === undefined) {
			return;
		}
		if (names.has(name)) {
			const nameExpression = getTestCallArguments(expression).name!;
			file.errors.push({
				code: ErrorCode.duplicateTestName,
				message: `Duplicate test name '${name}' in this file.`,
				startRowIndex: nameExpression.startRowIndex,
				startColumnIndex: nameExpression.startColumnIndex,
				endRowIndex: nameExpression.endRowIndex,
				endColumnIndex: nameExpression.endColumnIndex,
			});
		}
		names.add(name);
	});
}

/**
 * Aufruf mit seinen gefalteten Argumenten, z.B. `equal(600 400)`. Nur für eine Referenz als
 * Funktion und für Argumente, deren Typen sich als Liste lesen lassen.
 */
function getFoldedCallText(call: ParseFunctionCall): string | undefined {
	const functionExpression = call.functionExpression;
	const argsType = call.arguments?.typeInfo?.type;
	if (functionExpression?.type !== 'reference'
		|| !argsType) {
		return undefined;
	}
	const argTypes = getAllArgTypes(bindReceiver(call.prefixArgument?.typeInfo?.type, argsType));
	if (!argTypes) {
		return undefined;
	}
	const argsText = argTypes.map(argType => typeToString(resolvePlaceholders(argType), 0, 1)).join(' ');
	return `${functionExpression.name.name}(${argsText})`;
}

//#endregion test

//#region verworfene Werte

/**
 * Meldet Argumente, die im Quelltext stehen und nirgends ankommen, weil die Parameterliste sie
 * nicht aufnimmt. Dass mehr Argumente überhaupt zulässig sind, ist die Regel der Sprache und kein
 * Fehler: ein Typ nennt Anforderungen, kein vollständiges Bild. Gemeldet wird deshalb nur, was an
 * dieser Stelle geschrieben steht und gelöscht werden kann.
 *
 * Nur beim Aufruf: assignArgs bindet ausschließlich die deklarierten Parameter, alles weitere
 * fällt weg. Eine Zuweisung verwirft dagegen nichts - der TypeGuard prüft, er formt nicht um,
 * und das Symbol behält den Typ des Werts samt aller Elemente und Felder.
 */
function checkDiscardedArguments(
	writtenArgs: BracketedExpression,
	paramsType: CompileTimeType,
	hasReceiver: boolean,
	errors: CompilerError[],
): void {
	const prefixArgumentCount = hasReceiver ? 1 : 0;
	// Die Parameter-Namen, die bereits vom Prefix gebunden sind
	const prefixParameterNames = prefixArgumentCount > 0
		? getKnownFieldNames(paramsType)?.slice(0, prefixArgumentCount)
		: undefined;
	switch (writtenArgs.type) {
		case 'list':
			checkDiscardedElements(writtenArgs, paramsType, prefixArgumentCount, errors);
			return;
		case 'dictionary': {
			const knownNames = getKnownFieldNames(paramsType);
			if (knownNames) {
				checkDiscardedFields(
					writtenArgs,
					knownNames,
					fieldName => `There is no parameter named '${fieldName}'.`,
					errors,
					prefixParameterNames,
				);
			}
			return;
		}
		default:
			return;
	}
}

function checkDiscardedElements(
	writtenList: ParseListLiteral,
	paramsType: CompileTimeType,
	prefixArgumentCount: number,
	errors: CompilerError[],
): void {
	// Ein Spread verschiebt alle folgenden Indizes unbekannt weit, damit steht nicht fest,
	// welches Element überzählig wäre.
	if (writtenList.values.some(value => value.type === 'spread')) {
		return;
	}
	const arity = getKnownArity(paramsType);
	if (arity === undefined) {
		return;
	}
	const writtenValues = writtenList.values as ParseValueExpression[];
	const writtenFrom = arity - prefixArgumentCount;
	if (writtenFrom >= writtenValues.length) {
		return;
	}
	const totalCount = writtenValues.length + prefixArgumentCount;
	const subject = arity === 1
		? 'argument'
		: 'arguments';
	writtenValues.slice(Math.max(0, writtenFrom)).forEach(writtenValue => {
		errors.push({
			code: ErrorCode.discardedValue,
			message: `This value is discarded. Expected ${arity} ${subject}, got ${totalCount}.`,
			startRowIndex: writtenValue.startRowIndex,
			startColumnIndex: writtenValue.startColumnIndex,
			endRowIndex: writtenValue.endRowIndex,
			endColumnIndex: writtenValue.endColumnIndex,
		});
	});
}

function checkDiscardedFields(
	writtenDictionary: ParseDictionaryLiteral,
	knownNames: string[],
	getMessage: (fieldName: string) => string,
	errors: CompilerError[],
	prefixParameterNames?: string[],
): void {
	// Ein Spread bringt unbekannte Felder mit, damit steht nicht fest, welches überzählig wäre.
	if (writtenDictionary.fields.some(field => field.type === 'spread')) {
		return;
	}
	writtenDictionary.fields.forEach(field => {
		if (field.type !== 'singleDictionaryField') {
			return;
		}
		const fieldName = getCheckedEscapableName(field.name);
		if (!fieldName) {
			return;
		}
		// Prüfe ZUERST ob der Name vom Prefix-Argument bereits gebunden ist
		if (prefixParameterNames?.includes(fieldName)) {
			errors.push({
				code: ErrorCode.discardedValue,
				message: `This value is discarded. Parameter '${fieldName}' is already bound by the prefix argument.`,
				startRowIndex: field.startRowIndex,
				startColumnIndex: field.startColumnIndex,
				endRowIndex: field.endRowIndex,
				endColumnIndex: field.endColumnIndex,
			});
			return;
		}
		// Dann: ist der Name bekannt (als Parameter)?
		if (knownNames.includes(fieldName)) {
			return;  // Alles OK
		}
		// Sonst: unbekannter Name
		errors.push({
			code: ErrorCode.discardedValue,
			message: `This value is discarded. ${getMessage(fieldName)}`,
			startRowIndex: field.startRowIndex,
			startColumnIndex: field.startColumnIndex,
			endRowIndex: field.endRowIndex,
			endColumnIndex: field.endColumnIndex,
		});
	});
}

/**
 * Meldet Felder eines Literals, die beim Destructuring niemand bindet. Anders als bei einer
 * Definition hält hier keine Variable den ganzen Wert - gebunden werden nur die genannten Namen,
 * alles andere ist danach unerreichbar.
 */
function checkDiscardedDestructuringFields(
	writtenValue: ParseValueExpression | undefined,
	fields: ParseDestructuringField[],
	errors: CompilerError[],
): void {
	if (writtenValue?.type !== 'dictionary') {
		return;
	}
	const boundNames = fields.map(field => field.source?.name ?? field.name.name);
	checkDiscardedFields(
		writtenValue,
		boundNames,
		fieldName => `'${fieldName}' is not destructured.`,
		errors,
	);
}

/**
 * Wie viele Argumente die Parameterliste positionell aufnimmt.
 * undefined heißt "nicht entscheidbar" - ein rest nimmt beliebig viele, und bei List, Any, Or
 * oder einem Platzhalter ist die Stelligkeit unbekannt.
 */
function getKnownArity(paramsType: CompileTimeType): number | undefined {
	if (isParametersType(paramsType)) {
		return paramsType.rest
			? undefined
			: paramsType.singleNames.length;
	}
	if (paramsType.julType === 'tuple') {
		return paramsType.ElementTypes.length;
	}
	return undefined;
}

/**
 * Welche Namen die Parameterliste aufnimmt.
 * undefined heißt "nicht entscheidbar" - ein rest nimmt beliebige, und bei Dictionary, Any oder
 * einem Platzhalter ist die Feldmenge unbekannt.
 */
function getKnownFieldNames(paramsType: CompileTimeType): string[] | undefined {
	if (isParametersType(paramsType)) {
		return paramsType.rest
			? undefined
			: paramsType.singleNames.map(parameter => parameter.name);
	}
	if (isDictionaryLiteralType(paramsType)) {
		return Object.keys(paramsType.Fields);
	}
	return undefined;
}

//#endregion verworfene Werte

/**
 * Ein Params-Typ wird gegen die Argumentkollektion geprüft. Kann keiner seiner Werte eine
 * Kollektion sein, ist die Funktion nicht aufrufbar und greift auch als branch nie.
 */
function checkParamsTypeIsCollection(
	params: SimpleExpression | ParseParameterFields,
	errors: CompilerError[],
): void {
	if (params.type === 'parameters') {
		return;
	}
	const paramsType = valueOf(params.typeInfo && resolvePlaceholders(params.typeInfo.type));
	if (!isDefinitelyNotCollectionType(paramsType)) {
		return;
	}
	errors.push({
		code: ErrorCode.paramsTypeIsNotCollection,
		message: `Expected the params type to describe an argument collection. Did you mean [${typeToString(paramsType, 0, 0)}]?`,
		startRowIndex: params.startRowIndex,
		startColumnIndex: params.startColumnIndex,
		endRowIndex: params.endRowIndex,
		endColumnIndex: params.endColumnIndex,
	});
}

/**
 * Ein Funktionswert in einem Typ-Kopf wie [isEven] ist ein Prädikat und muss dieselben
 * Bedingungen erfüllen wie in einem Typguard. Tiefer verschachtelte, etwa in Or(isEven Text),
 * prüft bereits der Type-Parameter von Or.
 */
function checkTypeHeadPredicates(
	params: SimpleExpression | ParseParameterFields,
	errors: CompilerError[],
): void {
	if (params.type !== 'list') {
		return;
	}
	params.values.forEach(value => {
		if (value.type === 'spread') {
			return;
		}
		const valueType = value.typeInfo && resolveAlias(resolvePlaceholders(value.typeInfo.type));
		if (!isFunctionType(valueType)) {
			return;
		}
		const assignability = isTypeAssignableForPredicateFunction(valueType);
		// TODO warnen bei unbekannter assignability?
		if (assignability.assignable === false) {
			errors.push({
				code: ErrorCode.typeGuardIsNotType,
				message: assignability.error.getMessage(),
				startRowIndex: value.startRowIndex,
				startColumnIndex: value.startColumnIndex,
				endRowIndex: value.endRowIndex,
				endColumnIndex: value.endColumnIndex,
			});
		}
	});
}

/**
 * true, wenn kein Wert dieses Typs eine Argumentkollektion sein kann.
 * Empty gehört dazu (der Aufruf ohne Argumente) und fällt daher nicht darunter.
 * Im Zweifel false: nicht aufgelöste Typen und Never bleiben ungemeldet.
 */
function isDefinitelyNotCollectionType(rawType: CompileTimeType): boolean {
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'blob':
		case 'boolean':
		case 'booleanLiteral':
		case 'date':
		case 'float':
		case 'floatLiteral':
		case 'function':
		case 'bound':
		case 'integer':
		case 'integerLiteral':
		case 'text':
		case 'textLiteral':
			return true;
		case 'or':
			// nur wenn keiner der Choices eine Kollektion sein kann
			return type.ChoiceTypes.every(isDefinitelyNotCollectionType);
		default:
			// and bleibt bewusst draußen: ein unbewohnter Schnitt wäre sonst ein Fehler
			return false;
	}
}

function setFunctionRefForParams(
	params: ParseParameterFields,
	identity: FunctionIdentity,
	functionScopes: NonEmptyArray<SymbolTable>,
): void {
	params.singleFields.forEach(parameter => {
		const parameterSymbol = findParameterSymbol(parameter, functionScopes);
		parameterSymbol.functionRef = identity;
	});
	const restParameter = params.rest;
	if (restParameter) {
		const parameterSymbol = findParameterSymbol(restParameter, functionScopes);
		parameterSymbol.functionRef = identity;
	}
}

/**
 * Findet die innerste Position im Quelltext, an der der Zuweisungsfehler tatsächlich sitzt:
 * steigt durch verschachtelte Listen- und Dictionary-Literale sowie durch die Argumentliste
 * eines Aufrufs ab, solange ein geschriebenes Kind dem Typ widerspricht, den seine Stelle
 * verlangt. Welcher Typ das ist, hat der Checker beim Inferieren am Kind gemerkt (expectedType),
 * samt Spread und Aussortieren von Union-Zweigen. Ein fehlendes Feld oder Element hat keinen
 * Ausdruck zum Zeigen und bricht den Abstieg an dieser Stelle ab - undefined heißt "keine
 * genauere Position als die aufrufende Stelle".
 * Nach dem Vorbild von TypeScript/Rust/Elm: eine Diagnose, eine möglichst genaue Position,
 * statt einer zweiten Diagnose mit demselben Text an einer weniger genauen Stelle.
 */
function findInnermostErrorPosition(value: PositionedExpression | undefined): Positioned | undefined {
	for (const child of getWrittenChildValues(value)) {
		const position = findErrorPositionInChild(child);
		if (position) {
			return position;
		}
	}
	return undefined;
}

/**
 * Die innerste Position in child, falls child selbst seinem erwarteten Typ widerspricht.
 */
function findErrorPositionInChild(child: ParseValueExpression): Positioned | undefined {
	return hasExpectedTypeError(child)
		? findInnermostErrorPosition(child) ?? child
		: undefined;
}

/**
 * Die geschriebenen Elemente einer Liste bzw. Feldwerte eines Dictionaries, ohne Spreads.
 */
function getWrittenChildValues(value: PositionedExpression | undefined): ParseValueExpression[] {
	switch (value?.type) {
		case 'list':
			return value.values.filter((element): element is ParseValueExpression => element.type !== 'spread');
		case 'dictionary':
			return value.fields
				.map(field => field.type === 'singleDictionaryField' ? field.value : undefined)
				.filter(isDefined);
		default:
			return [];
	}
}

function hasExpectedTypeError(expression: ParseValueExpression): boolean {
	const expectedType = expression.expectedType;
	const ownType = expression.typeInfo?.type;
	if (!expectedType || !ownType) {
		return false;
	}
	// Zuerst ungelöst, wie die Prüfung des Aufrufs selbst (isTypeAssignable bekommt argsType
	// bewusst ungelöst) - sonst findet die Suche den Fehler nicht wieder, den sie erklären soll.
	return isSubtypeOf(ownType, expectedType) === false
		|| isSubtypeOf(resolvePlaceholders(ownType), resolvePlaceholders(expectedType)) === false;
}

function getParamsType(possibleFunctionType: CompileTimeType | undefined): CompileTimeType {
	const functionType = possibleFunctionType && resolveAlias(possibleFunctionType);
	if (isFunctionType(functionType)) {
		return resolveAlias(functionType.ParamsType);
	}
	return builtinAny;
}

function getReturnTypeFromFunctionType(possibleFunctionType: TypeInfo | undefined): CompileTimeType {
	if (!possibleFunctionType) {
		return builtinAny;
	}
	const rawType = possibleFunctionType.type;
	if (isFunctionType(rawType)) {
		return rawType.ReturnType;
	}
	return builtinAny;
}

function getArgValueExpressions(args: BracketedExpression): (ParseValueExpression | undefined)[] {
	switch (args.type) {
		case 'binding':
		case 'data':
			return [];
		case 'dictionary':
			return args.fields.map(field => field.value);
		case 'dictionaryType':
			return [];
		case 'empty':
			return [];
		case 'list':
			return args.values.map(value => {
				return value.type === 'spread'
					? value.value
					: value;
			});
		case 'object':
			return args.values.map(value => {
				return value.value;
			});
		default: {
			const assertNever: never = args;
			throw new Error(`Unexpected args.type: ${(assertNever as BracketedExpression).type}`);
		}
	}
}

//#region Warnung bei unknown

/**
 * Meldet ein unknown an einer meldenden Stelle als Warnung. Die Prüfung selbst bleibt unverändert:
 * unknown ist weiter zulässig, es wird nur sichtbar.
 */
function reportUnknown(
	assignability: TypeAssignability,
	checkContext: CheckContext,
	subject: 'Definition' | 'Argument' | 'Return',
	source: CompileTimeType,
	target: CompileTimeType,
	position: Positioned,
): void {
	if (!checkContext.warnUnknown
		|| assignability.assignable !== undefined) {
		return;
	}
	checkContext.file.errors.push({
		code: ErrorCode.typeNotProven,
		message: `${subject} type can not be verified.
Can not prove that ${typeToString(resolvePlaceholders(source), 0, 1, true)} is assignable to ${typeToString(resolvePlaceholders(target), 0, 1)}.`,
		startRowIndex: position.startRowIndex,
		startColumnIndex: position.startColumnIndex,
		endRowIndex: position.endRowIndex,
		endColumnIndex: position.endColumnIndex,
	});
}

//#endregion Warnung bei unknown

//#region Schreibweise

/**
 * 'type': die Werte sind sicher Typen, 'value': sicher keine, 'unknown': lässt sich nicht sagen.
 * Kriterium ist der statische Typ, nicht die Zuweisbarkeit an Type - die erfüllt jeder Literalwert.
 */
export type Typeness = 'type' | 'value' | 'unknown';

/**
 * Teilt einen statischen Typ danach ein, ob die Werte, die er beschreibt, Typen sind.
 * Eine Funktion ist so viel Typ wie ihr Rückgabetyp: liefert sie sicher einen Typ, ist sie ein
 * höherer Typ. Prädikate sind vorerst ausgenommen.
 */
export function classifyTypeness(type: CompileTimeType | undefined): Typeness {
	return classifyTypenessOnPath(type, 0, []) ?? 'unknown';
}

/**
 * undefined: ein Alias, der schon auf dem Pfad liegt (Node in den eigenen children). Diese Stelle
 * ist so viel Typ wie der umgebende Typ und trägt nichts Eigenes bei. Ohne das liefe der Durchlauf
 * bei zwei rekursiven Feldern (Bin mit left und right) exponentiell, bis zur Tiefenbremse.
 */
function classifyTypenessOnPath(
	type: CompileTimeType | undefined,
	depth: number,
	/** Kurz, deshalb ein Array statt eines Set: das entstünde bei jedem Aufruf neu. */
	aliasesOnPath: SymbolDefinition[],
): Typeness | undefined {
	if (!type || depth > maxTypenessDepth) {
		return 'unknown';
	}
	if (type.julType === 'alias') {
		if (aliasesOnPath.includes(type.symbol)) {
			return undefined;
		}
		aliasesOnPath.push(type.symbol);
		try {
			return classifyTypenessOnPath(resolveAlias(type), depth + 1, aliasesOnPath);
		}
		finally {
			aliasesOnPath.pop();
		}
	}
	const resolved = resolveAlias(type);
	switch (resolved.julType) {
		case 'type':
		case 'typeOf':
			return 'type';
		case 'boolean':
		case 'booleanLiteral':
		case 'integer':
		case 'integerLiteral':
		case 'float':
		case 'floatLiteral':
		case 'text':
		case 'textLiteral':
		case 'date':
		case 'blob':
		case 'error':
		case 'empty':
		case 'stream':
		case 'bound':
		case 'add':
		case 'lengthOf':
		case 'indexRange':
			return 'value';
		case 'list':
		case 'dictionary':
			return classifyTypenessOnPath(resolved.ElementType, depth + 1, aliasesOnPath);
		case 'tuple':
			return combineTypeness(resolved.ElementTypes.map(elementType => classifyTypenessOnPath(elementType, depth + 1, aliasesOnPath)));
		// Ein Dictionary mit = ist ein Wert, auch wenn alle Felder Typen sind. Der Dictionary-Typ
		// [x: Integer] hat den Typ TypeOf(...) und wird oben als Typ erkannt. Anders als beim Tupel
		// gibt es hier keine gemeinsame Schreibweise für Wert und Typ.
		case 'dictionaryLiteral':
			return 'value';
		case 'or':
			return combineTypeness(resolved.ChoiceTypes.map(choiceType => classifyTypenessOnPath(choiceType, depth + 1, aliasesOnPath)));
		case 'and': {
			// Der Schnitt ist Teilmenge jedes Operanden: ein eindeutiger Operand genügt.
			const choices = resolved.ChoiceTypes.map(choiceType => classifyTypenessOnPath(choiceType, depth + 1, aliasesOnPath));
			const isType = choices.includes('type');
			const isValue = choices.includes('value');
			return isType === isValue
				? 'unknown'
				: isType ? 'type' : 'value';
		}
		// Wie jede Funktion nach ihrem Rückgabetyp: ein Prädikat liefert einen Boolean und wird
		// klein geschrieben wie or und equal, auch wenn es in Typ-Position stehen kann.
		case 'function':
			return classifyTypenessOnPath(resolved.ReturnType, depth + 1, aliasesOnPath);
		// Ein Wert, der das Prädikat erfüllt, ist einer aus der Obermenge.
		case 'predicate':
			return classifyTypenessOnPath(resolved.UpperBound, depth + 1, aliasesOnPath);
		case 'parameterReference': {
			// Die Referenz steht für das Argument selbst (`(T: Type) => T`) oder für die Werte, die
			// es beschreibt (`(T: Type v: T) => v`). Bei einem Wert als Argument ist beides dasselbe
			// Singleton, bei einem Typ nicht - dann bleibt es offen.
			const declared = classifyTypenessOnPath(dereferenceParameterTypeFromFunctionRef(resolved), depth + 1, aliasesOnPath);
			return declared === 'value' ? 'value' : 'unknown';
		}
		case 'any':
		case 'never':
		case 'not':
		case 'conditional':
		case 'mapElements':
		case 'concat':
		case 'withElementAt':
		case 'nestedReference':
		case 'parameters':
			return 'unknown';
		default: {
			const assertNever: never = resolved;
			throw new Error(`Unexpected julType: ${(assertNever as CompileTimeType).julType}`);
		}
	}
}

/**
 * Eindeutig nur, wenn alle Teile dasselbe sagen.
 */
function combineTypeness(rawParts: (Typeness | undefined)[]): Typeness | undefined {
	// Ein Alias, der schon auf dem Pfad liegt, trägt nichts bei (siehe classifyTypenessOnPath).
	const parts = rawParts.filter(isDefined);
	const first = parts[0];
	if (!first) {
		return rawParts.length ? undefined : 'unknown';
	}
	return parts.every(part => part === first)
		? first
		: 'unknown';
}

/**
 * Typen und höhere Typen beginnen groß, alles, was sicher kein Typ ist, klein.
 * Namen, die nicht mit einem Buchstaben beginnen, bleiben frei.
 */
function checkNamingCase(
	name: Name,
	type: CompileTimeType,
	errors: CompilerError[],
): void {
	const firstCharacter = name.name[0];
	if (!firstCharacter) {
		return;
	}
	const isUpperCase = /\p{Lu}/u.test(firstCharacter);
	const isLowerCase = /\p{Ll}/u.test(firstCharacter);
	if (!isUpperCase && !isLowerCase) {
		return;
	}
	const typeness = classifyTypeness(type);
	let message: string | undefined;
	if (typeness === 'type' && isLowerCase) {
		message = `'${name.name}' is a type and should start with an uppercase letter.`;
	}
	else if (typeness === 'value' && isUpperCase) {
		message = `'${name.name}' is not a type and should start with a lowercase letter.`;
	}
	if (message) {
		errors.push({
			code: ErrorCode.namingCase,
			message,
			startRowIndex: name.startRowIndex,
			startColumnIndex: name.startColumnIndex,
			endRowIndex: name.endRowIndex,
			endColumnIndex: name.endColumnIndex,
		});
	}
}

//#endregion Schreibweise

function checkNameDefinedInUpperScope(
	expression: TypedExpression,
	scopes: NonEmptyArray<SymbolTable>,
	errors: CompilerError[],
	name: string,
): void {
	const alreadyDefined = scopes.some((scope, index) =>
		// nur vorherige scopes prüfen
		index < scopes.length - 1
		&& scope[name] !== undefined);
	if (alreadyDefined) {
		errors.push({
			code: ErrorCode.alreadyDefinedInUpperScope,
			message: `'${name}' is already defined in upper scope`,
			startRowIndex: expression.startRowIndex,
			startColumnIndex: expression.startColumnIndex,
			endRowIndex: expression.endRowIndex,
			endColumnIndex: expression.endColumnIndex,
		});
	}
}

/**
 * typeGuard.inferredType muss gesetzt sein
 */
function checkTypeGuardIsType(
	typeGuard: ParseValueExpression,
	errors: CompilerError[],
): void {
	const typeGuardType = resolvePlaceholders(typeGuard.typeInfo!.type);
	const typeGuardAssignability = isTypeAssignable(typeGuardType, builtinType);
	if (typeGuardAssignability.assignable === false) {
		errors.push({
			code: ErrorCode.typeGuardIsNotType,
			message: typeErrorToString(typeGuardAssignability.error),
			startRowIndex: typeGuard.startRowIndex,
			startColumnIndex: typeGuard.startColumnIndex,
			endRowIndex: typeGuard.endRowIndex,
			endColumnIndex: typeGuard.endColumnIndex,
		});
	}
}

/**
 * Meldet, wenn der Ausdruck sicher keine Funktion ist. Genutzt für branches und für den
 * aufgerufenen Ausdruck eines functionCalls — beide unterscheiden sich nur in code und message.
 * Für any und unaufgelöste Referenzen ist das Ergebnis unbekannt, gemeldet wird also nur, wenn es
 * feststeht.
 * Liefert false, wenn gemeldet wurde. Der Aufrufer kann daran erkennen, dass die weitere
 * Auswertung als Funktion sinnlos ist.
 */
function checkIsFunction(
	expression: TypedExpression,
	code: ErrorCode,
	message: string,
	errors: CompilerError[],
): boolean {
	const anyFunctionType = createCompileTimeFunctionType(builtinAny, builtinAny, 'unknown');
	const functionAssignability = isTypeAssignable(resolvePlaceholders(expression.typeInfo!.type), anyFunctionType);
	if (functionAssignability.assignable === false) {
		errors.push({
			code: code,
			message: `${message}\n${typeErrorToString(functionAssignability.error)}`,
			startRowIndex: expression.startRowIndex,
			startColumnIndex: expression.startColumnIndex,
			endRowIndex: expression.endRowIndex,
			endColumnIndex: expression.endColumnIndex,
		});
		return false;
	}
	return true;
}
