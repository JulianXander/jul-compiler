import { extname, join } from 'path';
import * as runtime from '../runtime/runtime.js';
import { constantValueToType, resetFoldBudget, typeToConstantValue, tryBuildCallable } from './constant-folding.js';
import {
	BracketedExpression,
	CompileTimeCollection,
	CompileTimeComplementType,
	CompileTimeDictionary,
	CompileTimeDictionaryLiteralType,
	CompileTimeDictionaryType,
	CompileTimeFunctionType,
	CompileTimeBoundType,
	CompileTimeListType,
	CompileTimeIndexRangeType,
	CompileTimeStreamType,
	CompileTimeTupleType,
	CompileTimeType,
	CompileTimeTypeOfType,
	CompileTimeUnionType,
	CompileTimePredicateType,
	createCompileTimeAddType,
	createCompileTimeConcatType,
	createCompileTimeComplementType,
	createCompileTimePredicateType,
	createCompileTimeDictionaryLiteralType,
	createCompileTimeDictionaryType,
	createCompileTimeFunctionType,
	createCompileTimeBoundType,
	createCompileTimeLengthOfType,
	createCompileTimeListType,
	createCompileTimeIndexRangeType,
	createCompileTimeStreamType,
	createCompileTimeTupleType,
	createCompileTimeMapElementsType,
	createCompileTimeTypeOfType,
	createCompileTimeWithElementAtType,
	createCompileTimeConditionalType,
	ConditionalTypeBranch,
	createNestedReference,
	createParameterReference,
	createParametersType,
	Parameter,
	ParameterReference,
	ParametersType,
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
	TypePurity,
	SimpleExpression,
	SymbolDefinition,
	SymbolTable,
	Name,
	TextLiteralType,
	TextToken,
	TypedExpression,
	TypeInfo,
	ParseExpressionBase,
	PositionedExpression,
	CompileTimeAliasType,
	createCompileTimeAliasType,
	ResolvedType,
	forEachChild,
	forEachChildType,
	NestedReferenceType,
	builtinAny,
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
	createCompileTimeIntersectionType,
	createCompileTimeUnionType,
	createIntegerLiteral,
	createFloatLiteral,
	createTextLiteral,
	updateFunctionTypeUnresolvedFlag,
} from '../syntax-tree.js';
import { Extension, NonEmptyArray, elementsEqual, escapeReservedJsVariableName, fieldsEqual, forEach, isDefined, isNonEmpty, isTestFilePath, last, map, mapDictionary } from '../util.js';
import { coreLibPath, getPathFromImport, isCoreLibPath, isImportFunctionCall, isTopLevelImport, parseFile } from '../parser/parser.js';
import { CompilerError, ErrorCode, Positioned } from '../compiler-errors.js';
import { getCheckedEscapableName, getExportedSymbols, getTestCallArguments, getTestName } from '../parser/parser-utils.js';
import { FieldSymbolLocation, getFieldSymbolsFromDictionaryType, ReferenceIndex, ReferenceLocation, resolveCanonicalSymbol, resolveImportBinding } from './reference-index.js';
import { collectCompletedNames, reportStreamsWithoutEnd } from './stream-lifetime.js';
import { applyIgnoreComments } from '../parser/comment-directives.js';

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

//#region stats

/**
 * Zählt die Arbeit des Checkers, damit ein Umbau der Typauflösung messbar bleibt.
 * Deterministisch, im Gegensatz zu einer Zeitmessung.
 * Muss vor der core-lib Initialisierung stehen, die den Checker bereits benutzt.
 */
export const checkerStats = {
	/** Bezugsgröße: inferierte Ausdrücke. */
	inferType: 0,
	/** Auflösung von Platzhaltern für Prüfung und Anzeige. */
	resolvePlaceholders: 0,
	/** Relationsprüfungen inklusive Rekursion über Choices. */
	getTypeError: 0,
	/** Aufrufstellen, an denen constant folding tatsächlich gegriffen hat (siehe tryFoldCall). */
	foldableCall: 0,
};

export function resetCheckerStats(): void {
	checkerStats.inferType = 0;
	checkerStats.resolvePlaceholders = 0;
	checkerStats.getTypeError = 0;
	checkerStats.foldableCall = 0;
}

//#endregion stats

/**
 * Die Verweise auf Parameter je Funktion (getParameterProjections), einmal gesammelt statt je Aufruf.
 * Muss vor der core-lib Initialisierung stehen, die den Checker bereits benutzt.
 */
const parameterProjectionsCache = new WeakMap<CompileTimeFunctionType, ParameterProjection[]>();

/**
 * Ergebnis von containsArgumentPlaceholder je Typobjekt.
 * Muss vor der core-lib Initialisierung stehen, die den Checker bereits benutzt.
 */
const argumentPlaceholderCache = new WeakMap<CompileTimeType, boolean>();

/**
 * Der aufgelöste Typ je Anwendungsknoten (Alias mit args), siehe dereferenceAlias.
 * Muss vor der core-lib Initialisierung stehen, die den Checker bereits benutzt.
 */
const aliasApplicationCache = new WeakMap<CompileTimeAliasType, CompileTimeType>();

/**
 * Wie viele Anwendungsknoten ein Vergleich höchstens auflöst, bevor er das Paar als zuweisbar
 * annimmt. Der Stapel laufender Alias-Vergleiche erkennt Anwendungen mit gleichen Argumenten
 * wieder (isSameOrSameAliasApplication), aber nicht jede Rekursion wiederholt ihre Argumente -
 * erst das Budget garantiert, dass der Vergleich endet. Gilt für getTypeError und typeEquals je
 * eigenen Stapel.
 */
const maxAliasApplicationExpansions = 100;
let aliasApplicationExpansionsRemaining = maxAliasApplicationExpansions;
let typeEqualsApplicationExpansionsRemaining = maxAliasApplicationExpansions;

//#region benannte Eigenschaften

/**
 * Lesen und Schreiben einer benannten Eigenschaft einer Knotenart, nebeneinander, damit beide
 * zusammenpassen. set liefert undefined, wenn sich die Eigenschaft nicht zurückschreiben lässt
 * (etwa weil sie berechnet ist wie der ElementType eines Tupels).
 * Die Tabellen stehen vor der core-lib Initialisierung, die den Checker bereits benutzt.
 */
interface NamedAccess<T extends ResolvedType> {
	get(type: T, name: string): CompileTimeType | undefined;
	set(type: T, name: string, value: CompileTimeType): CompileTimeType | undefined;
}

type NamedAccessTable = { [K in ResolvedType['julType']]?: NamedAccess<Extract<ResolvedType, { julType: K; }>> };

function withReturnOrParamsType(
	functionType: CompileTimeFunctionType,
	name: string,
	value: CompileTimeType,
): CompileTimeFunctionType | undefined {
	const paramsType = name === 'ParamsType' ? value : functionType.ParamsType;
	const returnType = name === 'ReturnType' ? value : functionType.ReturnType;
	if (paramsType === functionType.ParamsType
		&& returnType === functionType.ReturnType) {
		return undefined;
	}
	// Der Aliasname beschriebe die geänderte Signatur nicht mehr.
	return {
		...functionType,
		ParamsType: paramsType,
		ReturnType: returnType,
		aliasName: undefined,
		isUnresolvedPlaceholder: paramsType.isUnresolvedPlaceholder || returnType.isUnresolvedPlaceholder,
	};
}

function withDictionaryLiteralField(
	type: Extract<ResolvedType, { julType: 'dictionaryLiteral'; }>,
	name: string,
	value: CompileTimeType,
): CompileTimeType | undefined {
	if (!(name in type.Fields)) {
		return undefined;
	}
	return createCompileTimeDictionaryLiteralType({ ...type.Fields, [name]: value }, type.complete, type.declaration);
}

/**
 * Felder eines Werts: `x/name`, wobei x einen Wert dieses Typs hat (`point/x`, `s$/getValue`). Die
 * Einträge für Funktion und Stream tragen auch deren Typeigenschaften, typePropertyAccess übernimmt
 * sie. Über einen Wert gelesen werden sie nicht, siehe isTypePropertyOfValue.
 */
const valueFieldAccess: NamedAccessTable = {
	dictionaryLiteral: {
		get: (type, name) => type.Fields[name],
		set: withDictionaryLiteralField,
	},
	dictionary: {
		// TODO Or(() type.ElementType)
		get: type => type.ElementType,
		set: (_type, _name, value) => createCompileTimeDictionaryType(value),
	},
	function: {
		get: (type, name) => {
			switch (name) {
				case 'ParamsType':
					return type.ParamsType;
				case 'ReturnType':
					return type.ReturnType;
				case 'PredicateIfTrue':
					// Any als neutrales Element von And: ohne erkannte Prädikat-Form (kein
					// .predicate) soll die Projektion den ElementType unverändert lassen,
					// statt ihn fälschlich einzuschränken.
					return type.predicate?.ifTrue ?? builtinAny;
				default:
					return undefined;
			}
		},
		set: withReturnOrParamsType,
	},
	parameters: {
		get: (type, name) => type.singleNames.find(parameter => parameter.name === name)?.type,
		set: (type, name, value) => {
			const index = type.singleNames.findIndex(parameter => parameter.name === name);
			if (index === -1) {
				return undefined;
			}
			const singleNames = type.singleNames.map((parameter, parameterIndex) =>
				parameterIndex === index
					? { name: parameter.name, type: value }
					: parameter);
			return createParametersType(singleNames, type.rest);
		},
	},
	stream: {
		get: (type, name) => {
			switch (name) {
				case 'getValue':
					return getStreamGetValueType(type);
				case 'ValueType':
					return type.ValueType;
				default:
					return undefined;
			}
		},
		set: (type, name, value) => name === 'ValueType'
			? createCompileTimeStreamType(value, type.finite)
			: undefined,
	},
};

/**
 * Eigenschaften eines Typs: `TypeOf(x)/name` (`TypeOf(values)/ElementType`).
 */
const typePropertyAccess: NamedAccessTable = {
	dictionary: {
		get: (type, name) => name === 'ElementType' ? type.ElementType : undefined,
		set: (_type, name, value) => name === 'ElementType'
			? createCompileTimeDictionaryType(value)
			: undefined,
	},
	dictionaryLiteral: {
		get: (type, name) => type.Fields[name],
		set: withDictionaryLiteralField,
	},
	list: {
		get: (type, name) => name === 'ElementType' ? type.ElementType : undefined,
		set: (_type, name, value) => name === 'ElementType'
			? createCompileTimeListType(value)
			: undefined,
	},
	tuple: {
		get: (type, name) => name === 'ElementType'
			? createNormalizedUnionType(type.ElementTypes)
			: undefined,
		// Die Union der Elemente lässt sich nicht auf die einzelnen Positionen zurückverteilen.
		set: () => undefined,
	},
	// Signatur und Werttyp sind Eigenschaften des Typs, derselbe Zugriff wie über einen Wert.
	function: valueFieldAccess.function,
	parameters: valueFieldAccess.parameters,
	stream: {
		// getValue ist ein Feld des Streams, keine Eigenschaft seines Typs.
		get: (type, name) => name === 'ValueType' ? type.ValueType : undefined,
		set: valueFieldAccess.stream!.set,
	},
};

function getNamedAccess(table: NamedAccessTable, type: ResolvedType): NamedAccess<ResolvedType> | undefined {
	return table[type.julType] as NamedAccess<ResolvedType> | undefined;
}

//#endregion benannte Eigenschaften

const maxElementsPerLine = 5;
const maxFieldsInTypeDump = 5;

/** Notbremse gegen eine Alias-Kette ohne Ende. */
const maxAliasDepth = 100;

/**
 * Schutz gegen Zyklen über Aliase und verschachtelte Typen in classifyTypeness. Echte Typen sind
 * nie annähernd so tief. Steht hier oben, weil die core-lib schon beim Modul-Load gecheckt wird.
 */
const maxTypenessDepth = 50;

/**
 * Alias-Paare, deren Vergleich gerade läuft.
 * Ein Zyklus im Typgraph führt zwingend über einen Alias - nur er kann zurückverweisen -,
 * deshalb genügt die Besuchsmenge dort. Modul-Slot statt CheckContext-Feld, weil die
 * Typvergleiche (getTypeError, typeEquals) keinen CheckContext bekommen; sie sind synchron und
 * nicht reentrant. Muss hier oben stehen, weil die core-lib schon beim Modul-Load gecheckt wird.
 */
const aliasComparisonsInProgress: { args: CompileTimeType; target: CompileTimeType; }[] = [];

/** Wie aliasComparisonsInProgress, aber für typeEquals - eine eigene Rekursion. */
const aliasEqualityInProgress: { first: CompileTimeType; second: CompileTimeType; }[] = [];

/**
 * Notbremse für die Vergleichsrekursion.
 * Die Besuchsmengen decken Zyklen ab; eine sehr tiefe, nicht zyklische Verschachtelung läuft an
 * ihnen vorbei und kippt irgendwann in den Stack Overflow (gemessen ab rund 4000 Ebenen, je nach
 * Plattform). Der Wert liegt bewusst weit darunter und weit über jeder realen Verschachtelung -
 * eine Notbremse, die selbst am Abgrund steht, ist keine.
 */
const maxTypeComparisonDepth = 100;

// Müssen wie alles hier oben stehen: die core-lib wird schon beim Modul-Load gecheckt und läuft
// dabei durch beide Funktionen.
let typeComparisonDepth = 0;
let typeEqualsDepth = 0;

/**
 * Einheit für eine Einrückungsebene in generiertem Diagnosetext (Fehlerketten, Typ-Dumps) -
 * geteilt zwischen indentLines und bracketedExpressionToString, damit beide nie auseinanderlaufen
 * (Fund im echten yugioh-Fehlerbild: Tabs vs. Leerzeichen mischten sich, weil beide Stellen ihre
 * eigene Einrückung hatten). Leerzeichen statt Tabs: das ist generierter Diagnosetext, kein
 * Quellcode (JULs Tab-Konvention gilt dort) - ein Tab-Zeichen rendert je nach Terminal/Editor-
 * Tabstop unterschiedlich breit, Leerzeichen sind überall gleich breit.
 */
const indentUnit = '  ';

/**
 * Ab wie vielen Choices die Teilmengen-Elimination in createNormalizedUnionType übersprungen
 * wird, um O(n²) getTypeError-Aufrufe bei großen Unions zu vermeiden (wie TypeScript es bei
 * getUnionType(..., UnionReduction.Subtype) macht). Wert durch Messung belegt, nicht geschätzt.
 * Muss vor CompileTimePositiveInteger stehen, weil das schon beim Modul-Load
 * createNormalizedUnionType aufruft.
 */
const subtypeReductionLimit = 20;

/**
 * Ab dieser Länge bildet MapElements ein Tupel nicht mehr je Position ab, sondern alle Positionen
 * mit der Union der Elemente. Je Position entstehen sonst n verschiedene Typen, die weiter hinten
 * (etwa in removeSubtypes) quadratisch kosten.
 */
const maxMappedPositions = 50;

/**
 * Kombinieren auf derselben Ebene, statt eine Datenebene hinzuzufügen - siehe
 * findUnproductiveSelfReference. Muss wie subtypeReductionLimit hier oben stehen: die core-lib
 * wird schon beim Modul-Load gecheckt und läuft dabei durch die Prüfung.
 */
const typeCombinatorNames = ['Or', 'And', 'Not', 'TypeOf', 'Greater'];

/**
 * Die Länge einer Kollektion, die nicht Empty ist: mindestens 1.
 */
const CompileTimePositiveInteger = createCompileTimeBoundType('greater', 'integer', createIntegerLiteral(0n));

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
	parameterReference.functionRef = functionType;
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
		parameterReference.functionRef = functionType;
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
		parameterReference.functionRef = functionType;
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
		parameterReference.functionRef = functionType;
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

export function getStreamGetValueType(streamType: CompileTimeStreamType): CompileTimeFunctionType {
	return createCompileTimeFunctionType(builtinEmpty, streamType.ValueType, 'impure');
}

/**
 * Faltet einen Zugriff so weit, wie die Position beweisbar ist: existiert sie, kommt ihr Typ
 * heraus; existiert sie nachweislich nicht, Empty; ist es nicht entscheidbar, die Vereinigung
 * aller Positionen. Ein noch unaufgelöster Schlüssel bleibt als Knoten stehen.
 */
function dereferenceNestedKeyFromObject(
	rawNestedKey: string | number | CompileTimeType,
	rawSource: CompileTimeType,
): CompileTimeType | undefined {
	const nestedKey = typeof rawNestedKey === 'object'
		? resolveAlias(rawNestedKey)
		: rawNestedKey;
	const source = resolveAlias(rawSource);
	if (typeof nestedKey === 'string') {
		return dereferenceNestedKeyFromObject(createTextLiteral(nestedKey), source);
	}
	if (typeof nestedKey === 'number') {
		return dereferenceNestedKeyFromObject(createIntegerLiteral(BigInt(nestedKey)), source);
	}
	switch (nestedKey.julType) {
		case 'or': {
			// Jeder Choice ist ein eigener Zugriff. Sonst gälte die ganze Union als "steht nicht
			// fest", obwohl Or(1 2) auf einem Zweituple jede Position beweisbar trifft.
			const choices = nestedKey.ChoiceTypes
				.map(keyChoice => dereferenceNestedKeyFromObject(keyChoice, source))
				.filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(choices);
		}
		case 'integerLiteral': {
			const index = Number(nestedKey.value);
			const dereferenced = dereferenceIndexFromObject(index, source);
			if (dereferenced) {
				return dereferenced;
			}
			// Nur wo die Länge feststeht, heißt ein Fehlschlag "die Position gibt es nicht".
			return hasKnownLength(source)
				? builtinEmpty
				: dereferenceUnknownKeyFromObject(nestedKey, source);
		}
		case 'textLiteral': {
			const dereferenced = dereferenceNameFromObject(nestedKey.value, source);
			if (dereferenced) {
				return dereferenced;
			}
			return hasKnownFields(source)
				? builtinEmpty
				: dereferenceUnknownKeyFromObject(nestedKey, source);
		}
		case 'lengthOf': {
			// Der Index ist beweisbar die Länge genau dieser Quelle: bei einer List ist er
			// damit nie zu groß (er trifft exakt das letzte Element) und nie 0 (lengthOf.Source
			// ist per Konstruktion nie Empty, siehe getLengthFromType). Kein Empty im Ergebnis.
			if (source.julType === 'list'
				&& typeEquals(nestedKey.Source, source)) {
				return source.ElementType;
			}
			return dereferenceUnknownKeyFromObject(nestedKey, source);
		}
		case 'indexRange':
			return dereferenceIndexRangeFromObject(nestedKey, source);
		default: {
			// Ein Platzhalter kann sich noch zu einem Literal auflösen, der Knoten bleibt also
			// stehen. Nur ein aufgelöster, aber unbestimmter Schlüssel (PositiveInteger, Any)
			// heißt wirklich "die Position steht nicht fest".
			if (isUnresolvedPlaceholderType(nestedKey)) {
				return createNestedReference(source, nestedKey);
			}
			// Liegt er zwischen zwei Grenzen, stehen zumindest die möglichen Positionen fest.
			const range = getIntegerRange(nestedKey);
			return range?.isInteger
				? dereferenceIntegerRangeFromObject(range, nestedKey, source)
				: dereferenceUnknownKeyFromObject(nestedKey, source);
		}
	}
}

/**
 * Der Index liegt irgendwo in range: dann sind genau die Positionen darin möglich, und Empty nur,
 * wenn range über die Länge hinausreicht. Die Positionen werden direkt gewählt statt als
 * Or(1 2 … n) aufgezählt, damit ein großer Bereich keine große Union erzeugt.
 */
function dereferenceIntegerRangeFromObject(
	range: IntegerRange,
	nestedKey: CompileTimeType,
	rawSource: CompileTimeType,
): CompileTimeType | undefined {
	const source = resolveAlias(rawSource);
	switch (source.julType) {
		case 'tuple': {
			const length = BigInt(source.ElementTypes.length);
			const first = range.min === undefined || range.min < 1n ? 1n : range.min;
			const last = range.max === undefined || range.max > length ? length : range.max;
			const choices: CompileTimeType[] = [];
			for (let position = first; position <= last; position++) {
				choices.push(source.ElementTypes[Number(position) - 1]!);
			}
			const reachesOutside = range.min === undefined
				|| range.min < 1n
				|| range.max === undefined
				|| range.max > length;
			if (reachesOutside) {
				choices.push(builtinEmpty);
			}
			return createNormalizedUnionType(choices);
		}
		// Wie bei einem Literal: nur die erste Position ist beweisbar belegt.
		case 'list':
			return range.min !== undefined
				&& range.min >= 1n
				&& range.max !== undefined
				&& range.max <= 1n
				? source.ElementType
				: createNormalizedUnionType([builtinEmpty, source.ElementType]);
		case 'or': {
			const choices = source.ChoiceTypes
				.map(choiceType => dereferenceIntegerRangeFromObject(range, nestedKey, choiceType))
				.filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(choices);
		}
		default:
			return dereferenceUnknownKeyFromObject(nestedKey, source);
	}
}

/**
 * Der Schlüssel steht nicht fest, die Quelle schon: dann ist jede ihrer Positionen möglich,
 * dazu Empty, weil der Schlüssel danebenliegen kann.
 * Nur für Kollektionen mit Positionen. Ein Dictionary fällt bewusst auf Any: die Vereinigung
 * seiner Feldtypen ist zwar genauer, erzeugt aber Typen, an denen die weitere Prüfung erstickt -
 * gemessen hat sie parse+check vervierfacht.
 */
function dereferenceUnknownKeyFromObject(
	nestedKey: CompileTimeType,
	rawSource: CompileTimeType,
): CompileTimeType | undefined {
	const source = resolveAlias(rawSource);
	switch (source.julType) {
		case 'empty':
			return builtinEmpty;
		case 'any':
			return builtinAny;
		case 'tuple':
			return createNormalizedUnionType([builtinEmpty, ...source.ElementTypes]);
		case 'list':
			return createNormalizedUnionType([builtinEmpty, source.ElementType]);
		case 'or': {
			const choices = source.ChoiceTypes
				.map(choiceType => dereferenceUnknownKeyFromObject(nestedKey, choiceType))
				.filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(choices);
		}
		case 'concat': {
			const dereferencedSources = source.Sources
				.map(sourceType => dereferenceUnknownKeyFromObject(nestedKey, sourceType))
				.filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(dereferencedSources);
		}
		case 'nestedReference':
		case 'parameterReference':
			return createNestedReference(source, nestedKey);
		case 'typeOf':
			return dereferenceUnknownKeyFromObject(nestedKey, source.value);
		// Ein Wert, der das Prädikat erfüllt, liegt in dessen Obermenge und hat deren Gestalt.
		case 'predicate':
			return dereferenceUnknownKeyFromObject(nestedKey, source.UpperBound);
		// Weder Positionen noch benannte Felder mit unbekanntem Schlüssel bekannt - bisheriges,
		// unverändertes Verhalten wie vor der Exhaustivitätsprüfung: permissiv wie 'any'.
		case 'and':
		case 'blob':
		case 'boolean':
		case 'booleanLiteral':
		case 'date':
		case 'dictionary':
		case 'dictionaryLiteral':
		case 'error':
		case 'float':
		case 'floatLiteral':
		case 'function':
		case 'bound':
		case 'integer':
		case 'integerLiteral':
		case 'add':
		case 'lengthOf':
		case 'never':
		case 'not':
		case 'parameters':
		case 'indexRange':
		case 'stream':
		case 'text':
		case 'textLiteral':
		case 'mapElements':
		case 'type':
		case 'conditional':
		case 'withElementAt':
			return builtinAny;
		default: {
			const assertNever: never = source;
			throw new Error('Unexpected source.julType: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

function nestedKeysEqual(
	first: string | number | CompileTimeType,
	second: string | number | CompileTimeType,
): boolean {
	if (typeof first === 'object'
		&& typeof second === 'object') {
		return typeEquals(first, second);
	}
	return first === second;
}

/**
 * Kennt dieser Typ seine Feldmenge?
 * Nur dann heißt ein fehlgeschlagenes dereferenceNameFromObject "das Feld gibt es nicht".
 * Bei allen anderen liefert es undefined, weil der Typ noch nicht ausgewertet ist oder
 * dereferenceNameFromObject ihn nicht behandelt — daraus darf kein Fehler werden.
 */
function hasKnownFields(rawType: CompileTimeType): boolean {
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'empty':
		case 'dictionary':
			// dereferenceNameFromObject liefert für JEDEN Namen einen Treffer (vakuos bei Empty,
			// den ElementType bei dictionary) - nie undefined. Damit ist die Feldmenge in dem
			// Sinn, den dieser Test braucht (kann dereferenceNameFromObject je scheitern?),
			// bereits vollständig entschieden.
			return true;
		case 'dictionaryLiteral':
			return type.complete;
		case 'function':
		case 'parameters':
		case 'stream':
			return true;
		case 'or':
			// Jeder Choice muss selbst entscheidbar sein - erst dann ist auch für die ganze
			// Union feststellbar, ob ein Feld existiert (siehe dereferenceNameFromObject,
			// case 'or': das setzt genau diese Entscheidbarkeit je Choice voraus).
			return type.ChoiceTypes.every(choiceType => !canHaveFields(choiceType) || hasKnownFields(choiceType));
		default:
			return false;
	}
}

/**
 * Kennt dieser Typ seine Länge?
 * Nur dann heißt ein fehlgeschlagenes dereferenceIndexFromObject "der Index liegt daneben".
 * Eine List hat keine bekannte Länge, dort ist kein Index zu weit.
 */
function hasKnownLength(type: CompileTimeType): boolean {
	return resolveAlias(type).julType === 'tuple';
}

/**
 * Kann dieser Typ überhaupt benannte Felder tragen?
 * Ein Nein heißt: der Name liegt nicht daneben, er passt gar nicht zur Art der Quelle.
 * Im Zweifel ja, damit aus "weiß ich nicht" kein Fehler wird.
 */
function canHaveFields(rawType: CompileTimeType): boolean {
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'boolean':
		case 'booleanLiteral':
		case 'float':
		case 'floatLiteral':
		case 'integer':
		case 'integerLiteral':
		case 'list':
		case 'text':
		case 'textLiteral':
		case 'tuple':
			return false;
		default:
			return true;
	}
}

/**
 * Liest x/name bei einem Wert x dieses Typs eine Eigenschaft des Typs statt eines Felds des Werts?
 * Die Typeigenschaften eines Typwerts (TypeOf(x)/name) sind es immer.
 */
function isTypePropertyOfValue(julType: ResolvedType['julType'], name: string): boolean {
	switch (julType) {
		case 'function':
			return name === 'ParamsType' || name === 'ReturnType' || name === 'PredicateIfTrue';
		case 'stream':
			return name === 'ValueType';
		default:
			return false;
	}
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

export function dereferenceNameFromObject(
	name: string,
	rawSourceObjectType: CompileTimeType,
): CompileTimeType | undefined {
	const sourceObjectType = resolveAlias(rawSourceObjectType);
	switch (sourceObjectType.julType) {
		case 'empty':
			return builtinEmpty;
		case 'any':
			return builtinAny;
		case 'function':
		case 'stream':
			// Signatur und Werttyp sind Eigenschaften des Typs, gelesen über TypeOf(s$)/ValueType.
			// Der Wert selbst hat sie nicht, ein Funktionswert hat gar keine Felder.
			if (isTypePropertyOfValue(sourceObjectType.julType, name)) {
				return undefined;
			}
			return getNamedAccess(valueFieldAccess, sourceObjectType)!.get(sourceObjectType, name);
		case 'dictionaryLiteral':
		case 'dictionary':
		case 'parameters':
			return getNamedAccess(valueFieldAccess, sourceObjectType)!.get(sourceObjectType, name);
		case 'concat':
		case 'list':
		case 'tuple':
			// List/Tuple/Concat tragen keine benannten Felder; gemeldet wird an der Aufrufstelle.
			return undefined;
		case 'nestedReference':
		case 'parameterReference':
			return createNestedReference(sourceObjectType, name);
		case 'or': {
			const dereferencedChoices: CompileTimeType[] = [];
			for (const choiceType of sourceObjectType.ChoiceTypes) {
				const dereferenced = dereferenceNameFromObject(name, choiceType);
				if (dereferenced) {
					dereferencedChoices.push(dereferenced);
					continue;
				}
				// Fehlt das Feld nachweislich (die Art kennt ihre Feldmenge oder kann grundsätzlich
				// keine Felder tragen), ist der Zugriff für die GANZE Union unsicher - ein anderer
				// Choice (z.B. Empty) darf das nicht stillschweigend überdecken. Ein Choice, der nur
				// noch nicht aufgelöst ist (unvollständiges Dictionary), bleibt dagegen unentschieden
				// und wird wie bisher aus der Vereinigung weggelassen.
				if (!canHaveFields(choiceType) || hasKnownFields(choiceType)) {
					return undefined;
				}
			}
			// Kein Choice hat etwas beigetragen: unbekannt, nicht die leere Union Never.
			return dereferencedChoices.length
				? createNormalizedUnionType(dereferencedChoices)
				: undefined;
		}
		case 'typeOf': {
			const innerType = sourceObjectType.value;
			return dereferenceNameFromObjectType(name, innerType, sourceObjectType);
		}
		// Ein Wert, der das Prädikat erfüllt, liegt in dessen Obermenge und hat deren Gestalt.
		case 'predicate':
			return dereferenceNameFromObject(name, sourceObjectType.UpperBound);
		// Keine benannten Felder und kein Sonderfall nötig - unverändertes Verhalten wie vor der
		// Exhaustivitätsprüfung.
		case 'and':
		case 'blob':
		case 'boolean':
		case 'booleanLiteral':
		case 'date':
		case 'error':
		case 'float':
		case 'floatLiteral':
		case 'bound':
		case 'integer':
		case 'integerLiteral':
		case 'add':
		case 'lengthOf':
		case 'never':
		case 'not':
		case 'indexRange':
		case 'text':
		case 'textLiteral':
		case 'mapElements':
		case 'type':
		case 'conditional':
		case 'withElementAt':
			return undefined;
		default: {
			const assertNever: never = sourceObjectType;
			throw new Error('Unexpected sourceObjectType.julType: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

function dereferenceNameFromObjectType(
	name: string,
	rawInnerType: CompileTimeType,
	sourceObjectType: CompileTimeType,
): CompileTimeType | undefined {
	const innerType = resolveAlias(rawInnerType);
	switch (innerType.julType) {
		case 'dictionary':
		case 'dictionaryLiteral':
		case 'function':
		case 'list':
		case 'parameters':
		case 'stream':
		case 'tuple': {
			// Die Tabelle liefert den Typ selbst, der Ausdruck bezeichnet ihn aber als Wert:
			// List(Integer)/ElementType ist der Typ Integer, wie ein geschriebenes Integer auch.
			const property = getNamedAccess(typePropertyAccess, innerType)!.get(innerType, name);
			return property && createCompileTimeTypeOfType(property);
		}
		case 'nestedReference':
		case 'parameterReference':
			return createNestedReference(sourceObjectType, name);
		case 'or': {
			const dereferencedChoices = innerType.ChoiceTypes.map(choiceType => {
				// Der choice braucht seine eigene TypeOf Hülle: sonst entsteht für einen noch
				// nicht aufgelösten choice die Referenz values/ElementType statt
				// TypeOf(values)/ElementType, und die ist nicht auflösbar, weil ElementType
				// eine Eigenschaft des Typs ist und nicht des Werts.
				return dereferenceNameFromObjectType(name, choiceType, createCompileTimeTypeOfType(choiceType));
			}).filter((type): type is CompileTimeType => !!type);
			// Kein Choice hat die Eigenschaft: unbekannt, nicht die leere Union Never.
			return dereferencedChoices.length
				? createNormalizedUnionType(dereferencedChoices)
				: undefined;
		}
		case 'concat': {
			// Gleiches Prinzip wie 'or': jede Quelle einzeln dereferenzieren (mit eigener TypeOf-
			// Hülle, aus demselben Grund wie dort) und die Ergebnisse zur Union zusammenfassen.
			// Eine noch unaufgelöste Quelle (z.B. ein generischer Funktionsparameter hinter einem
			// Spread) liefert über den 'parameterReference'-Fall bereits eine offene
			// nestedReference zurück - die Generizität bleibt so erhalten, statt hier auf Any
			// zu kollabieren.
			const dereferencedSources = innerType.Sources.map(sourceType => {
				return dereferenceNameFromObjectType(name, sourceType, createCompileTimeTypeOfType(sourceType));
			}).filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(dereferencedSources);
		}
		// Keine Eigenschaft mit diesem Namen bekannt - unverändertes Verhalten wie vor der
		// Exhaustivitätsprüfung.
		case 'and':
		case 'any':
		case 'blob':
		case 'boolean':
		case 'booleanLiteral':
		case 'date':
		case 'empty':
		case 'error':
		case 'float':
		case 'floatLiteral':
		case 'bound':
		case 'integer':
		case 'integerLiteral':
		case 'add':
		case 'lengthOf':
		case 'never':
		case 'not':
		case 'indexRange':
		case 'text':
		case 'textLiteral':
		case 'mapElements':
		case 'type':
		case 'typeOf':
		case 'conditional':
		case 'withElementAt':
		// Ein Prädikat als Typwert hat keine benannten Felder wie ElementType.
		case 'predicate':
			return undefined;
		default: {
			const assertNever: never = innerType;
			throw new Error('Unexpected innerType.julType: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

export function dereferenceIndexFromObject(
	index: number,
	rawSourceObjectType: CompileTimeType,
): CompileTimeType | undefined {
	if (rawSourceObjectType === undefined) {
		return undefined;
	}
	const sourceObjectType = resolveAlias(rawSourceObjectType);
	switch (sourceObjectType.julType) {
		case 'empty':
			return builtinEmpty;
		// Ein Wert, der das Prädikat erfüllt, liegt in dessen Obermenge und hat deren Gestalt.
		case 'predicate':
			return dereferenceIndexFromObject(index, sourceObjectType.UpperBound);
		case 'dictionaryLiteral':
			// Ein Dictionary trägt keine Positionen; gemeldet wird an der Aufrufstelle.
			return undefined;
		case 'list':
			// List(X) schliesst Empty als Typ aus, ein Wert hat also mindestens ein Element -
			// Index 1 existiert beweisbar. Ab Index 2 ist die Länge weiterhin nicht bekannt.
			return index === 1
				? sourceObjectType.ElementType
				: createNormalizedUnionType([builtinEmpty, sourceObjectType.ElementType]);
		case 'or': {
			const dereferencedChoices = sourceObjectType.ChoiceTypes.map(choiceType => {
				return dereferenceIndexFromObject(index, choiceType);
			}).filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(dereferencedChoices);
		}
		case 'nestedReference':
		case 'parameterReference':
			return createNestedReference(sourceObjectType, index);
		case 'tuple':
			return sourceObjectType.ElementTypes[index - 1];
		case 'concat': {
			// Ein Concat bleibt nur stehen, solange eine Quelle offen ist (siehe concatFromTypes).
			// Die Quellen werden abgezählt, solange ihre Länge feststeht; liegt die Position
			// dahinter, hängt sie vom Argument ab, und der Zugriff wartet auf die aufgelösten
			// Quellen, statt verloren zu gehen.
			const deferred = sourceObjectType.Sources.some(isUnresolvedPlaceholderType)
				? createNestedReference(sourceObjectType, index)
				: undefined;
			let remainingIndex = index;
			for (const rawSource of sourceObjectType.Sources) {
				const source = resolveAlias(valueOf(rawSource));
				switch (source.julType) {
					case 'empty':
						continue;
					case 'tuple':
						if (remainingIndex <= source.ElementTypes.length) {
							return source.ElementTypes[remainingIndex - 1];
						}
						remainingIndex -= source.ElementTypes.length;
						continue;
					case 'list':
						// Wie im Fall 'list': nur die erste Position ist beweisbar belegt.
						return remainingIndex === 1
							? source.ElementType
							: deferred;
					default:
						return deferred;
				}
			}
			return deferred;
		}
		// Keine Position mit diesem Index bekannt - unverändertes Verhalten wie vor der
		// Exhaustivitätsprüfung.
		case 'and':
		case 'any':
		case 'blob':
		case 'boolean':
		case 'booleanLiteral':
		case 'date':
		case 'dictionary':
		case 'error':
		case 'float':
		case 'floatLiteral':
		case 'function':
		case 'bound':
		case 'integer':
		case 'integerLiteral':
		case 'add':
		case 'lengthOf':
		case 'never':
		case 'not':
		case 'parameters':
		case 'indexRange':
		case 'stream':
		case 'text':
		case 'textLiteral':
		case 'mapElements':
		case 'type':
		case 'typeOf':
		case 'conditional':
		case 'withElementAt':
			return undefined;
		default: {
			const assertNever: never = sourceObjectType;
			throw new Error('Unexpected sourceObjectType.julType: ' + (assertNever as CompileTimeType).julType);
		}
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

function dereferenceArgumentTypesNested(
	calledFunction: CompileTimeType,
	prefixArgumentType: CompileTimeType | undefined,
	argsType: CompileTimeType,
	typeToDereference: CompileTimeType,
): CompileTimeType {
	return traversePlaceholders(typeToDereference, {
		calledFunction: calledFunction,
		prefixArgumentType: prefixArgumentType,
		argsType: argsType,
	});
}

/**
 * Instanziiert die Signaturen der Callback-Parameter gegen die konkreten Argumente des Aufrufs.
 * Ein Parametertyp wie `TypeOf(values)/ElementType` in einer Callback-Signatur wird erst hier
 * konkret; ohne das bliebe er ein Platzhalter, den getTypeError permissiv durchwinkt.
 *
 * Bewusst nur diese eine Verschachtelungsebene statt einer Erweiterung von traversePlaceholders:
 * dort steigt der argumentContext-Zweig nicht in Funktions- und Parameterknoten ab, und das
 * nachzurüsten zerstört die Auflösung generischer Rückgabetypen (`TypeOf(callback)/ReturnType`).
 */
function dereferenceCallbackParams(
	calledFunction: CompileTimeType,
	prefixArgumentType: CompileTimeType | undefined,
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
			const dereferenced = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, parameterType);
			if (dereferenced === parameterType) {
				return parameter;
			}
			changed = true;
			return { name: parameter.name, type: dereferenced };
		}
		const callbackParamsType = parameterType.ParamsType;
		if (!isParametersType(callbackParamsType)) {
			return parameter;
		}
		let callbackChanged = false;
		const dereferencedCallbackParams = callbackParamsType.singleNames.map(callbackParameter => {
			const callbackParameterType = callbackParameter.type;
			if (!callbackParameterType) {
				return callbackParameter;
			}
			const dereferenced = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, callbackParameterType);
			if (dereferenced === callbackParameterType) {
				return callbackParameter;
			}
			callbackChanged = true;
			return { name: callbackParameter.name, type: dereferenced };
		});
		if (!callbackChanged) {
			return parameter;
		}
		changed = true;
		const dereferencedCallbackType = createCompileTimeFunctionType(
			createParametersType(dereferencedCallbackParams, callbackParamsType.rest),
			parameterType.ReturnType,
			parameterType.purity,
			parameterType.aliasName,
		);
		dereferencedCallbackType.predicate = parameterType.predicate;
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
		|| source.functionRef !== functionType) {
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
	prefixArgumentType: CompileTimeType | undefined,
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
				const projected = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, projection.reference);
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
 * combine prefixArgumentType and argsType
 */
function getAllArgTypes(
	prefixArgumentType: CompileTimeType | undefined,
	rawArgsType: CompileTimeType,
): CompileTimeType[] | undefined {
	const argsType = resolveAlias(rawArgsType);
	const prefixArgTypes = prefixArgumentType
		? [prefixArgumentType]
		: [];
	if (argsType.julType === 'empty') {
		return prefixArgTypes;
	}
	if (isTupleType(argsType)) {
		const allArgTypes = [
			...prefixArgTypes,
			...argsType.ElementTypes,
		];
		return allArgTypes;
	}
	// TODO other argsType types
	return undefined;
}

function dereferenceParameterFromArgumentType(
	calledFunction: CompileTimeType,
	prefixArgumentType: CompileTimeType | undefined,
	rawArgsType: CompileTimeType,
	parameterReference: ParameterReference,
): CompileTimeType {
	const argsType = resolveAlias(rawArgsType);
	if (!calledFunction || parameterReference.functionRef !== calledFunction) {
		return parameterReference;
	}
	// TODO Param index nicht in ParameterReference, stattdessen mithilfe von parameterReference.functionRef.paramsType ermitteln?
	const paramIndex = parameterReference.index;
	const paramsType = calledFunction.ParamsType;
	const isRest = isParametersType(paramsType)
		? paramsType.singleNames.length === paramIndex
		// TODO?
		: false;
	if (isRest) {
		const allArgTypes = getAllArgTypes(prefixArgumentType, argsType);
		if (allArgTypes === undefined) {
			// Ist der Rest der einzige Parameter, sammelt er die ganze Argumentkollektion, auch
			// wenn sie keine Tuple ist (f(...ys) mit ys: List(Integer)).
			if (paramIndex === 0
				&& !prefixArgumentType) {
				return rawArgsType;
			}
			return builtinAny;
		}
		return createCompileTimeTupleType(allArgTypes.slice(paramIndex));
	}
	if (prefixArgumentType && paramIndex === 0) {
		return prefixArgumentType;
	}
	if (argsType.julType === 'empty') {
		return builtinEmpty;
	}
	switch (argsType.julType) {
		case 'dictionaryLiteral': {
			const referenceName = parameterReference.name;
			const argType = argsType.Fields[referenceName];
			// Ohne Argument kommt der Parameter zur Laufzeit als Empty an.
			if (!argType) {
				return builtinEmpty;
			}
			const dereferenced = dereferenceNameFromObject(referenceName, argType);
			if (!dereferenced) {
				return parameterReference;
			}
			return dereferenced;
		}
		case 'tuple': {
			// TODO dereference nested path
			// const referenceName = parameterReference.path[0].name;
			const argIndex = prefixArgumentType
				? paramIndex - 1
				: paramIndex;
			const argType = argsType.ElementTypes[argIndex];
			// Ohne Argument kommt der Parameter zur Laufzeit als Empty an.
			if (!argType) {
				return builtinEmpty;
			}
			return argType;
		}
		case 'function':
			// Wenn der Parameter ein Callback ist und sein Typ dereferenziert wird (z. B. TypeOf(callback)/ReturnType),
			// muss der ReturnType der Funktion extrahiert werden, nicht die Funktion selbst.
			return argsType.ReturnType;
		case 'list':
			// Eine List hat keine bekannte Länge, aber alle Elemente haben denselben Typ.
			// Wenn Argumente als Spread hereinkommen (...values), hat jedes Argument den ElementType.
			// Der erste Parameterindex (0) ist nach prefixArgument (falls vorhanden), alle anderen
			// sind Spread-Elemente und haben also den ElementType.
			return argsType.ElementType;
		default:
			return argsType;
	}
}

/**
 * Löst parameterReference und nestedReference über ihre Deklaration rekursiv soweit wie möglich auf.
 * Nicht Auflösbares wird zu Any — daher nur für Prüfung und Anzeige geeignet, nie zur
 * Weiterverarbeitung eines Typs, der seine Generizität behalten muss.
 */
export function resolvePlaceholders(rawType: CompileTimeType): CompileTimeType {
	return traversePlaceholders(rawType, undefined);
}

/**
 * Enthält der Typ etwas, das traversePlaceholders mit argumentContext ersetzen würde? Folgt
 * denselben Abstiegen, also nicht in Funktionen, Parameter und das Ziel eines Alias. Das Flag
 * isUnresolvedPlaceholder taugt dafür nicht, ein Dictionary-Literal setzt es bewusst nie.
 * Gecacht, weil große Dictionary-Literale sonst bei jedem Aufruf durchlaufen würden. Das geht, weil
 * Dictionary-Literale und Tupel nach dem Erzeugen nicht mehr verändert werden.
 */
function containsArgumentPlaceholder(type: CompileTimeType): boolean {
	switch (type.julType) {
		case 'parameterReference':
		case 'nestedReference':
			return true;
		case 'alias':
			return !!type.args && containsArgumentPlaceholder(type.args);
		case 'function':
		case 'parameters':
			return false;
		default:
			break;
	}
	const cached = argumentPlaceholderCache.get(type);
	if (cached !== undefined) {
		return cached;
	}
	let contains = false;
	forEachChildType(type, child => {
		contains ||= containsArgumentPlaceholder(child);
	});
	argumentPlaceholderCache.set(type, contains);
	return contains;
}

/** Die Argumente eines Aufrufs, über die ein parameterReference aufgelöst wird. */
interface ArgumentContext {
	calledFunction: CompileTimeType;
	prefixArgumentType: CompileTimeType | undefined;
	argsType: CompileTimeType;
}

/**
 * Die einzige Traversierung über einen Typbaum. Der Kontext entscheidet, woher ein
 * parameterReference seinen Wert bekommt:
 * undefined aus der Deklaration (resolvePlaceholders), gesetzt aus den Argumenten eines Aufrufs
 * (dereferenceArgumentTypesNested).
 * Gefaltet wird ausschließlich in den *FromTypes-Funktionen.
 */
function traversePlaceholders(
	rawType: CompileTimeType,
	argumentContext: ArgumentContext | undefined,
): CompileTimeType {
	if (!argumentContext) {
		checkerStats.resolvePlaceholders++;
	}
	switch (rawType.julType) {
		case 'any':
		case 'blob':
		case 'boolean':
		case 'booleanLiteral':
		case 'date':
		case 'empty':
		case 'error':
		case 'float':
		case 'floatLiteral':
		case 'integer':
		case 'integerLiteral':
		case 'never':
		case 'text':
		case 'textLiteral':
		case 'type':
			// Blatt-Typen: kein verschachtelter CompileTimeType, der einen Platzhalter tragen könnte.
			return rawType;
		case 'and': {
			const rawChoices = rawType.ChoiceTypes;
			const dereferencedChoices = rawChoices.map(choiceType => traversePlaceholders(choiceType, argumentContext));
			if (elementsEqual(rawChoices, dereferencedChoices)) {
				return rawType;
			}
			return createNormalizedIntersectionType(dereferencedChoices);
		}
		case 'dictionary': {
			const rawElement = rawType.ElementType;
			const dereferencedElement = traversePlaceholders(rawElement, argumentContext);
			if (dereferencedElement === rawElement) {
				return rawType;
			}
			return createCompileTimeDictionaryType(
				dereferencedElement,
				argumentContext ? undefined : rawType.aliasName);
		}
		case 'dictionaryLiteral': {
			// Auch mit argumentContext: ein Typparameter in einem Feld (`[value: T]`) wird erst am
			// Aufruf der Typfunktion konkret.
			if (argumentContext && !containsArgumentPlaceholder(rawType)) {
				return rawType;
			}
			const rawFields = rawType.Fields;
			const dereferencedFields = mapDictionary(rawFields, field => traversePlaceholders(field, argumentContext));
			if (fieldsEqual(rawFields, dereferencedFields)) {
				return rawType;
			}
			return createCompileTimeDictionaryLiteralType(dereferencedFields, rawType.complete, rawType.declaration, rawType.aliasName);
		}
		case 'function': {
			if (argumentContext) {
				return rawType;
			}
			const dereferencedParamsType = resolvePlaceholders(rawType.ParamsType);
			const dereferencedReturnType = resolvePlaceholders(rawType.ReturnType);
			if (dereferencedParamsType === rawType.ParamsType
				&& dereferencedReturnType === rawType.ReturnType) {
				return rawType;
			}
			const dereferencedType = createCompileTimeFunctionType(dereferencedParamsType, dereferencedReturnType, rawType.purity, rawType.aliasName);
			// Die Prädikat-Fakten und das Literal beschreiben den Wert, nicht die Platzhalter darin -
			// sie gehen beim Neubau sonst still verloren. Am Literal hängen Faltung und Identität.
			dereferencedType.predicate = rawType.predicate;
			dereferencedType.literal = rawType.literal;
			dereferencedType.foldable = rawType.foldable;
			dereferencedType.boundArguments = rawType.boundArguments;
			return dereferencedType;
		}
		case 'bound': {
			const rawValue = rawType.Value;
			const dereferencedValue = traversePlaceholders(rawValue, argumentContext);
			if (dereferencedValue === rawValue) {
				return rawType;
			}
			return createCompileTimeBoundType(rawType.Relation, rawType.Family, dereferencedValue);
		}
		case 'list': {
			const rawElement = rawType.ElementType;
			const dereferencedElement = traversePlaceholders(rawElement, argumentContext);
			if (dereferencedElement === rawElement) {
				return rawType;
			}
			return createCompileTimeListType(dereferencedElement);
		}
		case 'nestedReference': {
			const dereferencedSource = traversePlaceholders(rawType.source, argumentContext);
			const dereferencedKey = typeof rawType.nestedKey === 'object'
				? traversePlaceholders(rawType.nestedKey, argumentContext)
				: rawType.nestedKey;
			const dereferencedNested = dereferenceNestedKeyFromObject(dereferencedKey, dereferencedSource);
			if (!dereferencedNested) {
				return builtinAny;
			}
			return rawType.deferValueOf
				? valueOf(dereferencedNested)
				: dereferencedNested;
		}
		case 'not': {
			const rawSource = rawType.SourceType;
			const dereferencedSource = traversePlaceholders(rawSource, argumentContext);
			if (dereferencedSource === rawSource) {
				return rawType;
			}
			return createCompileTimeComplementType(dereferencedSource);
		}
		case 'lengthOf': {
			const rawSource = rawType.Source;
			const dereferencedSource = traversePlaceholders(rawSource, argumentContext);
			if (dereferencedSource === rawSource) {
				return rawType;
			}
			// Nicht nur die aufgelöste Source in lengthOf einpacken: getLengthFromType splittet
			// z.B. Or([] List(T)) in Or(0 lengthOf(List(T))) auf. Würde hier stattdessen direkt
			// lengthOf(Or([] List(T))) entstehen, gölte die Source-nie-Empty-Invariante
			// (getTypeError, case 'lengthOf') nicht mehr, obwohl der Aufrufer sich genau darauf
			// verlässt.
			return getLengthFromType(dereferencedSource);
		}
		case 'or': {
			const rawChoices = rawType.ChoiceTypes;
			const dereferencedChoices = rawChoices.map(choiceType => traversePlaceholders(choiceType, argumentContext));
			if (elementsEqual(rawChoices, dereferencedChoices)) {
				return rawType;
			}
			return createNormalizedUnionType(dereferencedChoices);
		}
		case 'parameterReference': {
			if (argumentContext) {
				const dereferencedParameter = dereferenceParameterFromArgumentType(
					argumentContext.calledFunction,
					argumentContext.prefixArgumentType,
					argumentContext.argsType,
					rawType);
				const dereferencedNested = dereferencedParameter === rawType
					? dereferencedParameter
					: traversePlaceholders(dereferencedParameter, argumentContext);
				// Ein nacktes T meint das Argument als Typ, TypeOf(value) den Typ des Arguments.
				return rawType.deferValueOf
					? valueOf(dereferencedNested)
					: dereferencedNested;
			}
			const dereferenced1 = dereferenceParameterTypeFromFunctionRef(rawType);
			if (!dereferenced1) {
				return builtinAny;
			}
			if (dereferenced1 === rawType) {
				return rawType;
			}
			return resolvePlaceholders(dereferenced1);
		}
		case 'parameters': {
			if (argumentContext) {
				return rawType;
			}
			const dereferencedSingleNames = rawType.singleNames.map(dereferenceNestedParameter);
			const rawRest = rawType.rest;
			const dereferencedRest = rawRest
				? dereferenceNestedParameter(rawRest)
				: undefined;
			if (rawRest === dereferencedRest
				&& elementsEqual(rawType.singleNames, dereferencedSingleNames)) {
				return rawType;
			}
			return createParametersType(dereferencedSingleNames, dereferencedRest);
		}
		case 'stream': {
			const rawValue = rawType.ValueType;
			const dereferencedValue = traversePlaceholders(rawValue, argumentContext);
			if (dereferencedValue === rawValue) {
				return rawType;
			}
			return createCompileTimeStreamType(dereferencedValue, rawType.finite);
		}
		case 'tuple': {
			// Auch mit argumentContext: ein Typparameter in einem Tupel (`[T T]`) wird erst am
			// Aufruf der Typfunktion konkret.
			if (argumentContext && !containsArgumentPlaceholder(rawType)) {
				return rawType;
			}
			const rawElements = rawType.ElementTypes;
			const dereferencedElements = rawElements.map(element => traversePlaceholders(element, argumentContext));
			if (elementsEqual(rawElements, dereferencedElements)) {
				return rawType;
			}
			return createCompileTimeTupleType(dereferencedElements);
		}
		case 'typeOf': {
			const rawValue = rawType.value;
			const dereferencedValue = traversePlaceholders(rawValue, argumentContext);
			if (dereferencedValue === rawValue) {
				return rawType;
			}
			return createCompileTimeTypeOfType(dereferencedValue);
		}
		case 'withElementAt': {
			const rawSource = rawType.Source;
			const rawIndex = rawType.Index;
			const rawValue = rawType.Value;
			const dereferencedSource = traversePlaceholders(rawSource, argumentContext);
			const dereferencedIndex = traversePlaceholders(rawIndex, argumentContext);
			const dereferencedValue = traversePlaceholders(rawValue, argumentContext);
			if (dereferencedSource === rawSource
				&& dereferencedIndex === rawIndex
				&& dereferencedValue === rawValue) {
				return rawType;
			}
			// Neu falten statt neu einpacken, sonst bleibt der Knoten trotz aufgelöster Teile stehen.
			return withElementAtFromTypes(dereferencedSource, dereferencedIndex, dereferencedValue);
		}
		case 'conditional': {
			// Nur die Operanden entscheiden über den Zweig. Köpfe und Ergebnisse werden mit
			// aufgelöst, damit ein Ergebnis wie TypeOf(a) am Aufruf ebenfalls konkret wird.
			const rawOperands = rawType.Operands;
			const dereferencedOperands = rawOperands.map(operand => traversePlaceholders(operand, argumentContext));
			const rawBranches = rawType.Branches;
			const dereferencedBranches = rawBranches.map(branch => ({
				Head: traversePlaceholders(branch.Head, argumentContext),
				Result: traversePlaceholders(branch.Result, argumentContext),
			}));
			if (elementsEqual(rawOperands, dereferencedOperands)
				&& rawBranches.every((branch, index) =>
					branch.Head === dereferencedBranches[index]!.Head
					&& branch.Result === dereferencedBranches[index]!.Result)) {
				return rawType;
			}
			// Neu auswerten statt neu einpacken.
			return createConditionalType(dereferencedOperands, dereferencedBranches);
		}
		case 'indexRange': {
			const rawStart = rawType.Start;
			const rawEnd = rawType.End;
			const dereferencedStart = traversePlaceholders(rawStart, argumentContext);
			const dereferencedEnd = traversePlaceholders(rawEnd, argumentContext);
			if (dereferencedStart === rawStart
				&& dereferencedEnd === rawEnd) {
				return rawType;
			}
			return createCompileTimeIndexRangeType(dereferencedStart, dereferencedEnd);
		}
		case 'mapElements': {
			const rawSource = rawType.Source;
			const rawCallback = rawType.Callback;
			const dereferencedSource = traversePlaceholders(rawSource, argumentContext);
			// Die Verweise im Rückgabetyp des Callbacks zeigen auf genau dieses Funktionsobjekt.
			// resolvePlaceholders baut Funktionen neu, in einer Kopie fände das Einsetzen sie nicht.
			const dereferencedCallback = rawCallback.julType === 'function'
				? rawCallback
				: traversePlaceholders(rawCallback, argumentContext);
			if (dereferencedSource === rawSource
				&& dereferencedCallback === rawCallback) {
				return rawType;
			}
			const mapped = mapElementsFromTypes(dereferencedSource, dereferencedCallback);
			if (mapped.julType === 'mapElements') {
				return rawType.deferValueOf
					? { ...mapped, deferValueOf: true }
					: mapped;
			}
			// Der Rückgabetyp des Callbacks kann noch Parameter der umgebenden Funktion nennen.
			const resolved = isUnresolvedPlaceholderType(mapped)
				? traversePlaceholders(mapped, argumentContext)
				: mapped;
			return rawType.deferValueOf
				? valueOf(resolved)
				: resolved;
		}
		case 'concat': {
			const rawSources = rawType.Sources;
			const dereferencedSources = rawSources.map(source => traversePlaceholders(source, argumentContext));
			if (rawSources.every((source, i) => source === dereferencedSources[i])) {
				return rawType;
			}
			// Neu falten statt neu einpacken.
			return concatFromTypes(dereferencedSources);
		}
		case 'add': {
			const rawArgs = rawType.ArgsType;
			const dereferencedArgs = traversePlaceholders(rawArgs, argumentContext);
			if (dereferencedArgs === rawArgs) {
				return rawType;
			}
			// Neu falten statt neu einpacken.
			return addFromTypes(dereferencedArgs);
		}
		case 'alias': {
			// Stoppt vor dem Ziel: Absteigen würde bei einem rekursiven Typ nicht terminieren.
			// Nur die Argumente einer Anwendung (Tree(T)) tragen Platzhalter, und die sind endlich.
			const rawArgs = rawType.args;
			if (!rawArgs) {
				return rawType;
			}
			const dereferencedArgs = traversePlaceholders(rawArgs, argumentContext);
			if (dereferencedArgs === rawArgs) {
				return rawType;
			}
			return createCompileTimeAliasType(rawType.name, rawType.symbol, dereferencedArgs);
		}
		case 'predicate': {
			// Aufgelöst werden nur die Schranken. Die Funktion bleibt dasselbe Objekt, an ihr
			// hängen Identität und Faltung.
			const rawUpper = rawType.UpperBound;
			const rawLower = rawType.LowerBound;
			const dereferencedUpper = traversePlaceholders(rawUpper, argumentContext);
			const dereferencedLower = traversePlaceholders(rawLower, argumentContext);
			if (dereferencedUpper === rawUpper
				&& dereferencedLower === rawLower) {
				return rawType;
			}
			return createCompileTimePredicateType(rawType.FunctionType, dereferencedUpper, dereferencedLower, rawType.name);
		}
		default: {
			const assertNever: never = rawType;
			throw new Error('Unexpected rawType.julType: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

function dereferenceNestedParameter(parameter: Parameter): Parameter {
	return {
		name: parameter.name,
		type: parameter.type && resolvePlaceholders(parameter.type),
	};
}

function dereferenceParameterTypeFromFunctionRef(parameterReference: ParameterReference): CompileTimeType | undefined {
	const functionType = parameterReference.functionRef;
	if (functionType) {
		const paramsType = functionType.ParamsType;
		if (isParametersType(paramsType)) {
			// Nach Index, nicht Name: ParamsType speichert bei einem aliasierten Parameter
			// (name = source) den Quellnamen, parameterReference.name aber den lokalen Namen
			// aus dem Rumpf - bei einem Alias laufen beide auseinander. Der Rest-Parameter steht
			// hinter den einzelnen.
			const { singleNames, rest } = paramsType;
			return parameterReference.index === singleNames.length
				? rest?.type
				: singleNames[parameterReference.index]?.type;
		}
	}
}

//#endregion dereference

//#region CompileTimeType guards

function isComplementType(type: CompileTimeType | undefined): type is CompileTimeComplementType {
	return !!type && type.julType === 'not';
}

function isDictionaryType(type: CompileTimeType | undefined): type is CompileTimeDictionaryType {
	return !!type && type.julType === 'dictionary';
}

export function isDictionaryLiteralType(type: CompileTimeType | undefined): type is CompileTimeDictionaryLiteralType {
	return !!type && type.julType === 'dictionaryLiteral';
}

export function isFunctionType(type: CompileTimeType | undefined): type is CompileTimeFunctionType {
	return !!type && type.julType === 'function';
}

export function isListType(type: CompileTimeType | undefined): type is CompileTimeListType {
	return !!type && type.julType === 'list';
}

export function isParametersType(type: CompileTimeType | undefined): type is ParametersType {
	return !!type && type.julType === 'parameters';
}

export function isParameterReference(type: CompileTimeType | undefined): type is ParameterReference {
	return !!type && type.julType === 'parameterReference';
}

function isStreamType(type: CompileTimeType | undefined): type is CompileTimeStreamType {
	return !!type && type.julType === 'stream';
}

export function isTextLiteralType(type: CompileTimeType | undefined): type is TextLiteralType {
	return !!type && type.julType === 'textLiteral';
}

export function isTupleType(type: CompileTimeType | undefined): type is CompileTimeTupleType {
	return !!type && type.julType === 'tuple';
}

export function isTypeOfType(type: CompileTimeType | undefined): type is CompileTimeTypeOfType {
	return !!type && type.julType === 'typeOf';
}

export function isUnionType(type: CompileTimeType | undefined): type is CompileTimeUnionType {
	return !!type && type.julType === 'or';
}

//#endregion CompileTimeType guards

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
	if (!getTypeError(undefined, argValueType, getLowerBoundType(combinedType))) {
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

/**
 * Der Typ des Elements an dieser Stelle einer Kollektion.
 * undefined, wenn er sich nicht bestimmen lässt - dann wird nicht verengt.
 */
function getElementTypeAtIndex(
	rawType: CompileTimeType | undefined,
	index: number,
): CompileTimeType | undefined {
	const type = rawType && resolveAlias(rawType);
	switch (type?.julType) {
		case 'any':
			return type;
		case 'list':
			return type.ElementType;
		case 'tuple':
			return type.ElementTypes[index];
		case 'or': {
			const choiceTypes: CompileTimeType[] = [];
			for (const choiceType of type.ChoiceTypes) {
				const elementType = getElementTypeAtIndex(choiceType, index);
				if (!elementType) {
					return undefined;
				}
				choiceTypes.push(elementType);
			}
			return createNormalizedUnionType(choiceTypes);
		}
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
				&& getTypeError(undefined, resolvePlaceholders(fieldTypes[fieldName]!), resolvePlaceholders(choiceFieldType))) {
				return false;
			}
		}
		if (writtenFieldNames) {
			for (const fieldName in resolvedChoiceType.Fields) {
				if (!writtenFieldNames.has(fieldName)
					&& getTypeError(undefined, builtinEmpty, resolvePlaceholders(resolvedChoiceType.Fields[fieldName]!))) {
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
	prefixArgumentType: CompileTimeType | undefined,
	argsType: CompileTimeType,
	expectedType: CompileTimeType | undefined,
	argument: ParseValueExpression,
): CompileTimeType | undefined {
	if (argument.type === 'functionLiteral') {
		return instantiateExpectedCallback(calledFunction, prefixArgumentType, argsType, expectedType);
	}
	return expectedType && dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, expectedType);
}

/**
 * Instanziiert die Parametertypen eines erwarteten Callbacks mit den Argumenten des Aufrufs, so
 * dass (value: TypeOf(values)/ElementType) zu (value: Integer) wird. Wie bei
 * dereferenceCallbackParams nur diese eine Ebene. Was sich nicht instanziieren lässt, bleibt roh.
 */
function instantiateExpectedCallback(
	calledFunction: CompileTimeType,
	prefixArgumentType: CompileTimeType | undefined,
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
		const instantiatedType = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, parameter.type);
		if (instantiatedType === parameter.type) {
			return parameter;
		}
		changed = true;
		return { name: parameter.name, type: instantiatedType };
	});
	if (!changed) {
		return expectedFunctionType;
	}
	const instantiatedFunctionType = createCompileTimeFunctionType(
		createParametersType(instantiatedSingleNames, paramsType.rest),
		expectedFunctionType.ReturnType,
		expectedFunctionType.purity,
		expectedFunctionType.aliasName,
	);
	instantiatedFunctionType.predicate = expectedFunctionType.predicate;
	return instantiatedFunctionType;
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
	if (getTypeError(undefined, resolvePlaceholders(returnType), builtinBoolean)) {
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
					// areArgsAssignableTo gibt einen Error zurück wenn NICHT assignierbar (nicht ⊆),
					// undefined wenn OK (d.h. assignierbar).
					// Sicher abgefangen haben die vorherigen Köpfe nur ihre Untermenge, und der
					// aktuelle kann alles aus seiner Obermenge treffen - das zählt bei Prädikaten.
					// Derselbe Kopf ist dagegen über die Identität abgefangen.
					// Kann der aktuelle alles treffen, ist er erreichbar - Any als Quelle wäre in
					// areArgsAssignableTo permissiv und hieße sonst "abgedeckt".
					const isSameAsPrevious = previousArgumentTypes.some(previousArgumentType =>
						typeEquals(previousArgumentType, currentArgumentType));
					// Ebenso, wenn "kein Fehler" für ihn nicht "Teilmenge" heißt, etwa bei Not(1).
					const currentUpperBound = getUpperBoundType(currentArgumentType);
					const error = isSameAsPrevious
						? undefined
						: currentUpperBound.julType === 'any'
							|| !hasReliableTypeError(currentUpperBound)
							? 'reachable'
							: areArgsAssignableTo(
								undefined,
								currentUpperBound,
								getLowerBoundType(combinedPreviousArgumentType));
					if (!error) {
						// Kein Error = currentArgumentType ist Teilmenge = unreachable
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
				const assignmentError = dereferencedTargetType && areArgsAssignableTo(undefined, resolvePlaceholders(typeInfo.type), dereferencedTargetType);
				if (assignmentError) {
					// Position wandert beim Abstieg durch verschachtelte Dictionary-Literale auf
					// die innerste noch vorhandene, tatsächlich falsche Stelle (TypeScript/
					// Rust/Elm-Vorbild: eine Diagnose, eine möglichst genaue Position, statt
					// einer zweiten Diagnose mit demselben Text an einer weniger genauen Stelle).
					const innerPosition = dereferencedTargetType && findInnermostErrorPosition(value);
					const position = innerPosition ?? expression;

					// Ob die umhüllende "Can not assign X to Y."-Zeile fehlt, entscheidet
					// getTypeError bereits an der Quelle (case 'dictionaryLiteral': in
					// getTypeError, hasMultipleFields) - hier nur noch die fertige Meldung
					// übernehmen, kein nachträgliches Textschneiden mehr.
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
					const error = typeGuard.typeInfo && areArgsAssignableTo(undefined, fieldType, valueOf(resolvePlaceholders(typeGuard.typeInfo.type)));
					if (error) {
						errors.push({
							code: ErrorCode.destructuringFieldTypeMismatch,
							message: error,
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
			const createDictionary = (fieldTypes: CompileTimeDictionary) => createCompileTimeDictionaryLiteralType(
				fieldTypes,
				true,
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
						// Aussortieren braucht getTypeError, deshalb nur, wo ein Kind einen eindeutigen
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
						let expectedArgumentType = firstSpreadIndex === undefined
							? getExpectedElementType(paramsType, index + argsPrefixCount)
							: getExpectedElementTypeAfterSpread(paramsType, firstSpreadIndex);
						if (value.type === 'functionLiteral' || expectedArgumentType?.isUnresolvedPlaceholder) {
							// Vorläufige Argumente: die vorherigen sind schon inferiert, die übrigen Any.
							const provisionalArgsType = createCompileTimeTupleType(args.values.map(otherValue =>
								(otherValue as ParseExpressionBase).typeInfo?.type ?? builtinAny));
							expectedArgumentType = instantiateExpectedArgument(
								functionType, rawPrefixArgumentTypeForArgs, provisionalArgsType, expectedArgumentType, value);
						}
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
						let expectedArgumentType = fieldName === undefined
							? undefined
							: getExpectedFieldType(paramsType, fieldName);
						if (value.type === 'functionLiteral' || expectedArgumentType?.isUnresolvedPlaceholder) {
							expectedArgumentType = instantiateExpectedArgument(
								functionType,
								rawPrefixArgumentTypeForArgs,
								createCompileTimeDictionaryLiteralType(provisionalFieldTypes, true),
								expectedArgumentType,
								value);
						}
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
			// Funktion (TypeOf(values)/ElementType), lautlos verschluckt von getTypeErrors
			// nestedReference-Rückfallregel. resolvePlaceholders löst über functionRef+Index auf.
			// Nur das Präfix, nicht argsType: args kann selbst generische Typwerte enthalten
			// (z.B. die Signatur eines nativeFunction-Aufrufs) - die dürfen nicht vorschnell
			// über den eigenen (noch generischen) Deklarationskontext aufgelöst werden.
			const argsType = args.typeInfo!.type;
			const rawPrefixArgumentType = prefixArgument?.typeInfo?.type;
			const prefixArgumentType = rawPrefixArgumentType && resolvePlaceholders(rawPrefixArgumentType);
			// Die Signaturen der Callback-Parameter werden gegen die konkreten Argumente
			// instanziiert, bevor geprüft wird: ein generischer Parametertyp darin
			// (TypeOf(values)/ElementType) bliebe sonst ein Platzhalter, den getTypeError
			// permissiv durchwinkt - die Kontravarianzprüfung des Callbacks liefe ins Leere.
			// Nur diese eine Ebene, nicht der ganze Baum: traversePlaceholders steigt mit
			// argumentContext bewusst nicht in Funktions- und Parameterknoten ab, weil das die
			// Auflösung des Rückgabetyps (TypeOf(callback)/ReturnType) zerstört.
			const dereferencedParamsType = dereferenceCallbackParams(functionType, prefixArgumentType, argsType, paramsType);
			const assignArgsError = areArgsAssignableTo(prefixArgumentType, argsType, dereferencedParamsType);
			if (assignArgsError) {
				const position = (prefixArgument && findErrorPositionInChild(prefixArgument))
					?? findInnermostErrorPosition(args)
					?? expression;
				errors.push({
					code: ErrorCode.argumentTypeMismatch,
					message: `Argument type mismatch.\n${assignArgsError}`,
					startRowIndex: position.startRowIndex,
					startColumnIndex: position.startColumnIndex,
					endRowIndex: position.endRowIndex,
					endColumnIndex: position.endColumnIndex,
				});
			}
			checkDiscardedArguments(args, paramsType, prefixArgumentType, errors);
			// Name statt Symbol wie bei den übrigen Builtins: `test` zu überschatten ist JUL3203.
			if (functionExpression.type === 'reference'
				&& functionExpression.name.name === 'test') {
				checkTestCall(expression, !!assignArgsError, checkContext.filePath, errors);
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
			const dereferencedReturnType = dereferenceArgumentTypesNested(functionType, returnPrefixArgumentType, argsType, returnType);
			// Für Hover und Co.: die Signatur, gegen die dieser Aufruf geprüft wurde. Eine Kopie,
			// denn die Platzhalter in Parameter- und Rückgabetyp zeigen auf das Original.
			// Der Aliasname entfällt, er stünde sonst in der Anzeige statt der verengten Typen.
			const resolvedFunctionType = resolveAlias(functionType);
			if (isFunctionType(resolvedFunctionType)) {
				const callSiteParamsType = substituteParameterProjections(
					resolvedFunctionType, functionType, prefixArgumentType, argsType, dereferencedParamsType);
				expression.calledFunctionType = {
					...resolvedFunctionType,
					ParamsType: callSiteParamsType,
					ReturnType: dereferencedReturnType,
					aliasName: undefined,
					isUnresolvedPlaceholder: callSiteParamsType.isUnresolvedPlaceholder
						|| dereferencedReturnType.isUnresolvedPlaceholder,
				};
			}
			// :> an der äußersten Signatur eines nativeFunction-Aufrufs ist eine bedingte
			// Zusicherung (Purity folgt den übergebenen Funktionsargumenten), keine unbestimmte -
			// verschachtelte :> an Callback-Parametern derselben Signatur bleiben unknown. Der
			// Ergebnistyp ist dasselbe Objekt wie der Typ des Argumentknotens (dereferenceArgumentTypesNested
			// substituiert den parameterReference von nativeFunction ohne zu klonen); interne
			// parameterReference-Knoten in ParamsType/ReturnType zeigen per functionRef auf genau
			// dieses Objekt, deshalb hier gezielt mutiert statt kopiert - eine Kopie würde diese
			// Identität brechen und generische Rückgabetypen nicht mehr auflösbar machen.
			const outermostFunctionTypeArg = getArgValueExpressions(args)[0];
			const isConditionallyPureSignature = functionExpression.type === 'reference'
				&& functionExpression.name.name === 'nativeFunction'
				&& outermostFunctionTypeArg?.type === 'functionTypeLiteral'
				&& outermostFunctionTypeArg.arrow === 'unknown';
			if (isConditionallyPureSignature) {
				const resolvedReturnType = resolveAlias(dereferencedReturnType);
				if (isFunctionType(resolvedReturnType)) {
					resolvedReturnType.purity = 'pureIfArgsPure';
				}
			}
			const foldedType = tryFoldCall(
				functionExpression, functionType, prefixArgumentType, argsType, assignArgsError);
			const boundReturnType = !foldedType && !assignArgsError
				? bindClosureArguments(functionExpression, functionType, prefixArgumentType, argsType, dereferencedReturnType)
				: undefined;
			return { type: foldedType ?? boundReturnType ?? dereferencedReturnType };
		}
		case 'functionLiteral': {
			const ownSymbols = expression.symbols;
			registerCompletedNames(ownSymbols, expression.body);
			const functionScopes: NonEmptyArray<SymbolTable> = [...scopes, ownSymbols];
			const params = expression.params;
			const functionType = createCompileTimeFunctionType(
				builtinEmpty,
				builtinEmpty,
				expression.arrow ?? 'unknown',
			);
			if (params.type === 'parameters') {
				setFunctionRefForParams(params, functionType, functionScopes);
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
			functionType.ParamsType = paramsTypeValue;
			updateFunctionTypeUnresolvedFlag(functionType);
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
			//#region Purity-Inferenz (docs/pure-inference-umsetzung.md Schritt 3)
			// E6: der Dummy-Rumpf importierter TS-Funktionen ist keine Aussage über das JS dahinter -
			// für sie gilt der Pfeil, den der typescript-parser aus dem JSDoc ableitet. @pure heißt
			// dort nur "ruft nichts Unreines außer den übergebenen Funktionen auf".
			if (isTypeScriptFile(filePath)) {
				if (expression.arrow === 'pure'
					&& !canNotHoldFunction(paramsTypeValue)) {
					functionType.purity = 'pureIfArgsPure';
				}
			}
			else {
				const bodyPurity = inferBodyPurity(expression.body, functionType);
				// Ein Rumpf, der nur deshalb unentscheidbar ist, weil er eigene funktionswertige
				// Parameter aufruft, ist nicht grundsätzlich unentscheidbar, sondern bedingt rein.
				const conditionallyPure = bodyPurity.purity === 'unknown' && bodyPurity.unknownOnlyFromOwnParameterCalls;
				switch (expression.arrow) {
					case undefined:
					case 'unknown':
						functionType.purity = conditionallyPure ? 'pureIfArgsPure' : bodyPurity.purity;
						break;
					case 'impure':
						break;
					case 'pure':
						if (conditionallyPure) {
							// Still herabgesetzt, keine Diagnose: das Ergebnis ist strikt
							// präziser als die geschriebene Zusicherung und erhält das bisherige
							// konservative Verhalten an der Aufrufstelle.
							functionType.purity = 'pureIfArgsPure';
						}
						else if (bodyPurity.purity === 'impure') {
							functionType.purity = 'impure';
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
			functionType.literal = expression;
			functionType.foldable = !isTypeScriptFile(filePath)
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
				const error = areArgsAssignableTo(undefined, resolvePlaceholders(inferredReturnType), dereferencedDeclaredReturnType);
				if (error) {
					// Markiert wird nur der zurückgegebene Ausdruck (last(body)), nicht die
					// ganze Funktion - sonst ummantelt die mehrzeilige Klammerung (formatErrors)
					// den kompletten Funktionsrumpf statt der tatsächlich betroffenen Stelle.
					const returnedExpression = last(expression.body) ?? expression;
					errors.push({
						code: ErrorCode.returnTypeMismatch,
						message: `Return type mismatch.\n${error}`,
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
			functionType.ReturnType = returnType;
			updateFunctionTypeUnresolvedFlag(functionType);
			functionType.predicate = getPredicateFacts(expression, returnType);
			return { type: functionType };
		}
		case 'functionTypeLiteral': {
			const functionScopes: NonEmptyArray<SymbolTable> = [...scopes, expression.symbols];
			const params = expression.params;
			const functionType = createCompileTimeFunctionType(
				builtinEmpty,
				builtinEmpty,
				expression.arrow ?? 'unknown',
			);
			if (params.type === 'parameters') {
				setFunctionRefForParams(params, functionType, functionScopes);
			}
			const functionTypeContext: TypeContext = {
				scopes: functionScopes,
				narrowedTypes: narrowedTypes,
			};
			setInferredType(params, functionTypeContext, undefined, checkContext);
			functionType.ParamsType = valueOf(params.typeInfo!.type);
			updateFunctionTypeUnresolvedFlag(functionType);
			checkParamsTypeIsCollection(params, errors);
			// TODO check returnType muss pure sein
			setInferredType(expression.returnType, functionTypeContext, undefined, checkContext);
			const inferredReturnType = expression.returnType.typeInfo!.type;
			functionType.ReturnType = valueOf(inferredReturnType);
			updateFunctionTypeUnresolvedFlag(functionType);
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
						name: field.source ?? field.name.name,
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

function getNameFromValue(expression: TypedExpression): string | undefined {
	if (expression.parent?.type === 'definition'
		&& expression.parent.value === expression) {
		return expression.parent.name.name;
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
	const prefixArgument = functionCall.prefixArgument;
	const prefixArgumentType = prefixArgument?.typeInfo?.type;
	const argsType = functionCall.arguments?.typeInfo?.type ?? builtinAny;
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
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					// TODO unknown?
					return builtinAny;
				}
				return createCompileTimeTypeOfType(createNormalizedIntersectionType(argTypes.map(valueOf)));
			}
			case 'ElementAt': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
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
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				const sourceType = argTypes?.[0];
				if (!sourceType) {
					return builtinAny;
				}
				return createCompileTimeTypeOfType(getLengthFromType(valueOf(sourceType)));
			}
			case 'WithElementAt': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
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
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				const startType = argTypes?.[0];
				if (!startType) {
					return builtinAny;
				}
				const endType = argTypes?.[1] ?? builtinEmpty as CompileTimeType;
				return createCompileTimeTypeOfType(
					createCompileTimeIndexRangeType(valueOf(startType), valueOf(endType)));
			}
			case 'MapElements': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
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
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					return builtinAny;
				}
				return createCompileTimeTypeOfType(
					concatFromTypes(argTypes.map(valueOf)));
			}
			case 'Add': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				const argType = argTypes?.[0];
				if (!argType) {
					return builtinAny;
				}
				return createCompileTimeTypeOfType(addFromTypes(valueOf(argType)));
			}
			case 'Not': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
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
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					// TODO unknown?
					return builtinAny;
				}
				const choices = argTypes.map(valueOf);
				const unionType = createNormalizedUnionType(choices);
				return createCompileTimeTypeOfType(unionType);
			}
			case 'TypeOf': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
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
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
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

/**
 * Die Teilfolge der Quelle zwischen den Bereichsgrenzen. Bei bekannter Länge und literalen
 * Grenzen ein Tuple der getroffenen Positionen, sonst eine List - mit Empty, solange nicht
 * feststeht, dass der Bereich mindestens eine Position trifft.
 */
function dereferenceIndexRangeFromObject(
	range: CompileTimeIndexRangeType,
	rawSource: CompileTimeType,
): CompileTimeType | undefined {
	const source = resolveAlias(rawSource);
	if (isUnresolvedPlaceholderType(source)) {
		return createNestedReference(source, range);
	}
	// Steht die Quelle fest, müssen die Grenzen jetzt entschieden werden. Ein weggelassenes
	// optionales Argument bleibt sonst für immer parameterReference, der Knoten bliebe stehen -
	// und ein stehengebliebener Knoten wird permissiv geprüft, der Fehler verschwände lautlos.
	const start = resolvePlaceholders(range.Start);
	const end = resolvePlaceholders(range.End);
	switch (source.julType) {
		case 'empty':
			return builtinEmpty;
		case 'or': {
			const choices = source.ChoiceTypes
				.map(choice => dereferenceIndexRangeFromObject(range, choice))
				.filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(choices);
		}
		case 'tuple': {
			if (start.julType !== 'integerLiteral') {
				break;
			}
			const length = source.ElementTypes.length;
			const from = Number(start.value);
			const to = end.julType === 'empty'
				? length
				: end.julType === 'integerLiteral'
					? Number(end.value)
					: undefined;
			if (to === undefined) {
				break;
			}
			// Die Laufzeit schneidet an den Rändern ab, statt zu melden.
			const clampedFrom = Math.max(from, 1);
			const clampedTo = Math.min(to, length);
			if (clampedFrom > clampedTo) {
				return builtinEmpty;
			}
			return createCompileTimeTupleType(source.ElementTypes.slice(clampedFrom - 1, clampedTo));
		}
		case 'list': {
			const sliced = createCompileTimeListType(source.ElementType);
			return rangeCoversFirstPosition(start, end)
				? sliced
				: createNormalizedUnionType([builtinEmpty, sliced]);
		}
		default:
			break;
	}
	return dereferenceUnknownKeyFromObject(range, source);
}

/**
 * Trifft der Bereich garantiert mindestens eine Position? Nur dann darf Empty entfallen.
 * Beweisbar, wenn er bei 1 beginnt und bis zum Ende läuft - offen geschrieben oder über die
 * Länge einer Quelle, die selbst nie Empty ist (siehe getLengthFromType).
 */
function rangeCoversFirstPosition(rawStart: CompileTimeType, rawEnd: CompileTimeType): boolean {
	const start = resolveAlias(rawStart);
	const end = resolveAlias(rawEnd);
	if (start.julType !== 'integerLiteral'
		|| start.value !== 1n) {
		return false;
	}
	switch (end.julType) {
		case 'empty':
		case 'lengthOf':
			return true;
		case 'integerLiteral':
			return end.value >= 1n;
		default:
			return false;
	}
}

/**
 * Source, jede Position abgebildet durch callback. Bei einem Tuple wird der Rückgabetyp des
 * Callbacks je Position instanziiert, mit dem Element und seinem Index als Argumenten. Der Rumpf
 * wird dafür nicht neu inferiert: sein Rückgabetyp nennt die eigenen Parameter noch als Verweise,
 * eingesetzt wird wie beim Aufruf einer Funktion mit generischem Rückgabetyp.
 */
function mapElementsFromTypes(
	rawSourceType: CompileTimeType,
	rawCallbackType: CompileTimeType,
): CompileTimeType {
	const callbackType = resolveAlias(rawCallbackType);
	if (callbackType.julType !== 'function'
		&& isUnresolvedPlaceholderType(callbackType)) {
		return createCompileTimeMapElementsType(rawSourceType, rawCallbackType);
	}
	const sourceType = resolveAlias(rawSourceType);
	switch (sourceType.julType) {
		case 'empty':
			return builtinEmpty;
		case 'tuple': {
			const elementTypes = sourceType.ElementTypes;
			if (!elementTypes.length) {
				return builtinEmpty;
			}
			if (elementTypes.length > maxMappedPositions) {
				const mapped = mapElementType(callbackType, createNormalizedUnionType(elementTypes), undefined);
				return createCompileTimeTupleType(new Array(elementTypes.length).fill(mapped));
			}
			return createCompileTimeTupleType(elementTypes.map((elementType, index) =>
				mapElementType(callbackType, elementType, createIntegerLiteral(BigInt(index + 1)))));
		}
		case 'list':
			// Die Länge steht nicht fest, jedes Element bekommt denselben Typ.
			return createCompileTimeListType(mapElementType(callbackType, sourceType.ElementType, undefined));
		case 'or':
			return createNormalizedUnionType(sourceType.ChoiceTypes.map(choiceType =>
				mapElementsFromTypes(choiceType, rawCallbackType)));
		default:
			if (isUnresolvedPlaceholderType(sourceType)) {
				return createCompileTimeMapElementsType(rawSourceType, rawCallbackType);
			}
			// Über die Quelle ist nichts bekannt, sie kann also auch leer sein.
			return createNormalizedUnionType([
				builtinEmpty,
				createCompileTimeListType(mapElementType(callbackType, builtinAny, undefined)),
			]);
	}
}

/**
 * Der Rückgabetyp von callback für ein Element. Ohne feststehenden Index bleibt der Parameter
 * index ungebunden und fällt später auf seinen deklarierten Typ zurück.
 */
function mapElementType(
	callbackType: CompileTimeType,
	elementType: CompileTimeType,
	indexType: CompileTimeType | undefined,
): CompileTimeType {
	if (callbackType.julType !== 'function') {
		return builtinAny;
	}
	const argsType = createCompileTimeTupleType(indexType
		? [elementType, indexType]
		: [elementType]);
	return dereferenceArgumentTypesNested(callbackType, undefined, argsType, callbackType.ReturnType);
}

/**
 * Die Aneinanderreihung mehrerer Quellen. Sind alle Quellen konkrete Tupel, wird das Ergebnis
 * ihr Tuple; hat eine Quelle eine List, Union der Elementtypen als List; bei unaufgelösten
 * Quellen aufschieben.
 */
function concatFromTypes(sourceTypes: CompileTimeType[]): CompileTimeType {
	if (sourceTypes.some(isUnresolvedPlaceholderType)) {
		return createCompileTimeConcatType(sourceTypes);
	}
	// Or-Quelle zuerst verteilen (Fund: Or([] List(X)) ist das Idiom für eine möglicherweise
	// leere Liste, CLAUDE.md) - sonst gilt eine Quelle mit unbestimmter Länge fälschlich als
	// nicht auflösbar.
	const orIndex = sourceTypes.findIndex(source => resolveAlias(valueOf(source)).julType === 'or');
	if (orIndex !== -1) {
		const orSource = resolveAlias(valueOf(sourceTypes[orIndex]!));
		if (orSource.julType === 'or') {
			const choiceResults = orSource.ChoiceTypes.map(choice => {
				const substituted = sourceTypes.slice();
				substituted[orIndex] = choice;
				return concatFromTypes(substituted);
			});
			return createNormalizedUnionType(choiceResults);
		}
	}
	const elementTypes: CompileTimeType[] = [];
	let hasListSource = false;
	for (const rawSource of sourceTypes) {
		// TypeOf(X) fällt hier zu X, sonst würde z.B. Concat(TypeOf(a) TypeOf(b)) nie greifen.
		const source = resolveAlias(valueOf(rawSource));
		if (source.julType === 'empty') {
			continue;
		}
		if (source.julType === 'tuple') {
			elementTypes.push(...source.ElementTypes);
		} else if (source.julType === 'list') {
			// Über eine List-Quelle ist die Länge unbekannt, das Ergebnis bleibt List.
			hasListSource = true;
			elementTypes.push(source.ElementType);
		} else {
			// Unknown: nicht entscheidbar, bleibt aufschiebbar.
			return createCompileTimeConcatType(sourceTypes);
		}
	}
	if (hasListSource) {
		return elementTypes.length
			? createCompileTimeListType(createNormalizedUnionType(elementTypes))
			: createCompileTimeListType(builtinNever);
	}
	return elementTypes.length
		? createCompileTimeTupleType(elementTypes)
		: builtinEmpty;
}

/**
 * Die möglichen Summen der Integer-Argumente ArgsType (Tuple oder List). Gerechnet wird mit dem
 * Mindestwert m je Argument (x ≥ m, siehe getIntegerMinimum): Hat jedes Argument einen, ist die
 * Summe ≥ Σm. Eine List zählt wie ein Argument ihres Elementtyps, denn sie ist nie leer - aber nur
 * bei m ≥ 0, sonst senkt jedes weitere Element die Summe. Ohne Grenze bleibt Integer, auch für
 * Argumente, die nicht sicher Integer sind: Den Rest deckt der catchAll von add ab.
 * Bleibt stehen, solange ArgsType noch Platzhalter enthält.
 */
function addFromTypes(rawArgsType: CompileTimeType): CompileTimeType {
	if (isUnresolvedPlaceholderType(rawArgsType)) {
		return createCompileTimeAddType(rawArgsType);
	}
	const argsType = resolveAlias(rawArgsType);
	let elementTypes: CompileTimeType[];
	switch (argsType.julType) {
		case 'tuple':
			elementTypes = argsType.ElementTypes;
			break;
		case 'list':
			elementTypes = [argsType.ElementType];
			break;
		default:
			return builtinInteger;
	}
	let sum = 0n;
	for (const elementType of elementTypes) {
		// Nur für ganze Zahlen heißt > a dasselbe wie ≥ a + 1.
		if (getTypeError(undefined, elementType, builtinInteger)) {
			return builtinInteger;
		}
		const minimum = getIntegerMinimum(elementType);
		if (minimum === undefined
			|| (argsType.julType === 'list' && minimum < 0n)) {
			return builtinInteger;
		}
		sum += minimum;
	}
	return createCompileTimeBoundType('greater', 'integer', createIntegerLiteral(sum - 1n));
}

/**
 * Der kleinste Wert m, für den jeder Integer dieses Typs x ≥ m erfüllt. undefined heißt: nach
 * unten offen, oder die Grenze ist hier nicht ablesbar.
 */
function getIntegerMinimum(rawType: CompileTimeType): bigint | undefined {
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'integerLiteral':
			return type.value;
		case 'bound': {
			const value = type.Value;
			return type.Relation === 'greater'
				&& type.Family === 'integer'
				&& value.julType === 'integerLiteral'
				? value.value + 1n
				: undefined;
		}
		// Eine Länge ist nie 0 (siehe getLengthFromType).
		case 'lengthOf':
			return 1n;
		case 'and': {
			let maximum: bigint | undefined;
			for (const choiceType of type.ChoiceTypes) {
				const minimum = getIntegerMinimum(choiceType);
				if (minimum !== undefined
					&& (maximum === undefined || minimum > maximum)) {
					maximum = minimum;
				}
			}
			return maximum;
		}
		case 'or': {
			let minimum: bigint | undefined;
			for (const choiceType of type.ChoiceTypes) {
				const choiceMinimum = getIntegerMinimum(choiceType);
				if (choiceMinimum === undefined) {
					return undefined;
				}
				if (minimum === undefined || choiceMinimum < minimum) {
					minimum = choiceMinimum;
				}
			}
			return minimum;
		}
		default:
			return undefined;
	}
}

function getLengthFromType(rawArgType: CompileTimeType | undefined): CompileTimeType {
	if (!rawArgType) {
		// TODO non negative
		return builtinInteger;
	}
	const argType = resolveAlias(rawArgType);
	switch (argType.julType) {
		case 'empty':
			return createIntegerLiteral(0n);
		case 'tuple':
			return createIntegerLiteral(BigInt(argType.ElementTypes.length));
		case 'list':
			return createCompileTimeLengthOfType(argType);
		case 'or': {
			const lengthChoices = argType.ChoiceTypes.map(getLengthFromType);
			return createNormalizedUnionType(lengthChoices);
		}
		default:
			// Quelle wartet noch auf weitere Auflösung (z.B. ein Feldzugriff wie history/gameStates
			// als nestedReference): Länge an die Quelle binden, statt sie auf ein anonymes Integer
			// abzuflachen - sonst erkennt ElementAt später nicht mehr, dass ein Index exakt diese
			// Länge ist (siehe dereferenceNestedKeyFromObject, case 'lengthOf').
			return isUnresolvedPlaceholderType(argType)
				? createCompileTimeLengthOfType(argType)
				// TODO non negative
				: builtinInteger;
	}
}

/**
 * Source mit Value an Position Index. Faltet so weit, wie die Position feststeht; solange Quelle
 * oder Index noch Platzhalter sind, bleibt der Knoten stehen und wird am Aufruf erneut gefaltet.
 */
function withElementAtFromTypes(
	rawSourceType: CompileTimeType,
	rawIndexType: CompileTimeType,
	valueType: CompileTimeType,
): CompileTimeType {
	const sourceType = resolveAlias(rawSourceType);
	const indexType = resolveAlias(rawIndexType);
	// Ein Platzhalter kann sich noch zu einem Literal auflösen - dann steht genau eine Position
	// fest. Vorschnelles Falten würde stattdessen jede Position mit Value vereinigen.
	if (isUnresolvedPlaceholderType(sourceType)
		|| isUnresolvedPlaceholderType(indexType)) {
		return createCompileTimeWithElementAtType(sourceType, indexType, valueType);
	}
	if (isUnionType(indexType)) {
		const indexChoices = indexType.ChoiceTypes.map(indexChoice =>
			withElementAtFromTypes(sourceType, indexChoice, valueType));
		return createNormalizedUnionType(indexChoices);
	}
	switch (sourceType.julType) {
		case 'empty':
		case 'tuple': {
			// Empty ist ein 0-elementiges Tuple: dieselbe Positionslogik gilt für beide.
			const existingElementTypes = sourceType.julType === 'tuple' ? sourceType.ElementTypes : [];
			if (indexType.julType === 'integerLiteral') {
				// Liegt die Position hinter dem bisherigen Ende, entsteht eine Lücke - die muss
				// explizit mit Empty gefüllt werden. Ein rohes JS-Array-Loch (durch reines
				// Indexzuweisen über die Länge hinaus) wird beim nächsten Spread (z.B. beim
				// nächsten verketteten setElement, das existingElementTypes erneut kopiert) zu
				// einem echten undefined-Wert "verdichtet" - kein Loch mehr, sondern ein Element,
				// das kein CompileTimeType ist. Code, der jedes Element direkt anfasst (z.B.
				// typeToString), scheitert dann an undefined.julType.
				const position = Number(indexType.value);
				const elementTypes = [...existingElementTypes];
				for (let i = elementTypes.length; i < position - 1; i++) {
					elementTypes[i] = builtinEmpty;
				}
				elementTypes[position - 1] = valueType;
				return createCompileTimeTupleType(elementTypes);
			}
			if (existingElementTypes.length === 0) {
				// Ohne vorhandene Positionen UND ohne feste neue Position ist auch die Länge
				// unbekannt - anders als unten darf hier nicht einfach über nichts gemappt werden.
				return createCompileTimeListType(createNormalizedUnionType([builtinEmpty, valueType]));
			}
			// Ohne feste Position kann es jede vorhandene getroffen haben.
			return createCompileTimeTupleType(existingElementTypes.map(elementType =>
				createNormalizedUnionType([elementType, valueType])));
		}
		case 'list':
			return createCompileTimeListType(createNormalizedUnionType([sourceType.ElementType, valueType]));
		case 'or': {
			const sourceChoices = sourceType.ChoiceTypes.map(sourceChoice =>
				withElementAtFromTypes(sourceChoice, indexType, valueType));
			return createNormalizedUnionType(sourceChoices);
		}
		default:
			return builtinAny;
	}
}

//#endregion Sequenz Arithmetik

//#region Bedingte Typen

/**
 * `:?(Operanden)`: prüft die Kollektion der Operanden der Reihe nach gegen die Köpfe der Zweige.
 * Teilmenge: Ergebnis aufnehmen, fertig. Disjunkt: Zweig überspringen. Überlappend: Ergebnis
 * aufnehmen, weiter mit dem nächsten Zweig. Das Ergebnis ist die Union der aufgenommenen
 * Ergebnisse, ohne Treffer also Never.
 * Solange ein Operand noch Platzhalter enthält, bleibt der Knoten stehen und wird am Aufruf bzw.
 * per resolvePlaceholders erneut ausgewertet.
 */
function createConditionalType(
	operands: CompileTimeType[],
	branches: ConditionalTypeBranch[],
): CompileTimeType {
	if (operands.some(isUnresolvedPlaceholderType)) {
		return createCompileTimeConditionalType(operands, branches);
	}
	const collection = operands.length
		? createCompileTimeTupleType(operands)
		: builtinEmpty;
	// Gegen Any meldet getTypeError nie einen Fehler. Ein Operand, in dem Any steckt, ist
	// deshalb nie Teilmenge eines Kopfs, sondern überlappt ihn höchstens.
	const isReliable = !containsAny(collection);
	const results: CompileTimeType[] = [];
	for (const branch of branches) {
		if (isReliable
			&& !getTypeError(undefined, collection, branch.Head)) {
			results.push(branch.Result);
			break;
		}
		if (typesOverlap(collection, branch.Head) === false) {
			continue;
		}
		results.push(branch.Result);
	}
	return createNormalizedUnionType(results);
}

/**
 * Steckt irgendwo in diesem Typ Any (oder ein Typ, gegen den getTypeError ebenso nichts aussagt)?
 * Anders als hasReliableTypeError steigt das auch in Kollektionen ab.
 */
function containsAny(rawType: CompileTimeType): boolean {
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'and':
		case 'or':
			return type.ChoiceTypes.some(containsAny);
		case 'not':
			return containsAny(type.SourceType);
		case 'tuple':
			return type.ElementTypes.some(containsAny);
		case 'list':
		case 'dictionary':
			return containsAny(type.ElementType);
		case 'dictionaryLiteral':
			return Object.values(type.Fields).some(containsAny);
		case 'stream':
			return containsAny(type.ValueType);
		default:
			return !hasReliableTypeError(type);
	}
}

//#endregion Bedingte Typen

//#region Typ Arithmetik

/**
 * Wartet dieser Typ noch auf den Aufrufort?
 * Choices, für die das gilt, werden nie verworfen und verwerfen auch nichts, damit die
 * Elimination im Zweifel keine Information wegwirft (Prinzip Freiheit) - getTypeError behandelt
 * parameterReference/nestedReference permissiv (immer "kein Fehler"), das würde sonst eine
 * Elimination vortäuschen, die den Platzhalter-Anteil verwirft, bevor er aufgelöst ist.
 * Reiner Feldzugriff: das Ergebnis wird beim Konstruieren berechnet (siehe die Konstruktoren in
 * syntax-tree.ts), weil die Frage pro Typ vielfach gestellt wird - unter anderem in einer
 * verschachtelten Schleife in removeSubtypes.
 */
function isUnresolvedPlaceholderType(type: CompileTimeType): boolean {
	return type.isUnresolvedPlaceholder;
}

/**
 * Entfernt Choices, die bereits Teilmenge eines anderen Choice in derselben Liste sind:
 * Or(Boolean False) => [Boolean]. Bei struktureller Gleichwertigkeit (a Teilmenge von b und b
 * Teilmenge von a) gewinnt der frühere Index - sollte durch die Duplikat-Entfernung davor aber
 * ohnehin nicht mehr vorkommen.
 */
function removeSubtypes(choices: CompileTimeType[]): CompileTimeType[] {
	// Wo "kein Fehler" nicht "Teilmenge" heißt (Prädikat, Not), wird weder verworfen noch
	// verworfen lassen - wie bei einem noch ungelösten Platzhalter.
	const isComparable = (type: CompileTimeType) =>
		!isUnresolvedPlaceholderType(type)
		&& !isOpaqueForNormalization(type)
		&& hasReliableTypeError(type);
	return choices.filter((choice, index) => {
		if (!isComparable(choice)) {
			return true;
		}
		return !choices.some((otherChoice, otherIndex) => {
			if (index === otherIndex
				|| !isComparable(otherChoice)) {
				return false;
			}
			const isSubtype = !getTypeError(undefined, choice, otherChoice);
			if (!isSubtype) {
				return false;
			}
			const otherIsAlsoSubtype = !getTypeError(undefined, otherChoice, choice);
			return otherIsAlsoSubtype
				? otherIndex < index
				: true;
		});
	});
}

function createNormalizedUnionType(choiceTypes: CompileTimeType[]): CompileTimeType {
	//#region flatten UnionTypes
	// Or(1 Or(2 3)) => Or(1 2 3)
	// Ein Alias auf eine Union wird NICHT aufgeflacht: er ist der einzige Träger seines Namens,
	// und die Dedup- bzw. Teilmengen-Elimination unten löst ihn ohnehin auf (typeEquals und
	// getTypeError dealiasen beide).
	const flatChoices: CompileTimeType[] = choiceTypes.filter(choiceType =>
		!isUnionType(choiceType));
	const unionChoices = choiceTypes.filter(isUnionType);
	unionChoices.forEach(union => {
		flatChoices.push(...union.ChoiceTypes);
	});
	//#endregion flatten UnionTypes
	// Undurchsichtige Choices (isOpaqueForNormalization) werden hier nie aufgelöst: sie machen die
	// Union weder zu Any noch fallen sie als Never weg.
	if (flatChoices.some(choice =>
		!isOpaqueForNormalization(choice)
		&& resolveAlias(choice).julType === 'any')) {
		return builtinAny;
	}
	//#region remove Never
	const choicesWithoutNever = flatChoices.filter(choice =>
		isOpaqueForNormalization(choice)
		|| resolveAlias(choice).julType !== 'never');
	if (!choicesWithoutNever.length) {
		return builtinNever;
	}
	if (choicesWithoutNever.length === 1) {
		return choicesWithoutNever[0]!;
	}
	//#endregion remove Never
	//#region remove duplicates
	const uniqueChoices: CompileTimeType[] = [];
	choicesWithoutNever.forEach(choice => {
		if (!uniqueChoices.some(uniqueChoice =>
			isOpaqueForNormalization(choice) || isOpaqueForNormalization(uniqueChoice)
				? isSameOpaqueChoice(choice, uniqueChoice)
				: typeEquals(choice, uniqueChoice))) {
			uniqueChoices.push(choice);
		}
	});
	if (uniqueChoices.length === 1) {
		return uniqueChoices[0]!;
	}
	//#endregion remove duplicates
	//#region complement
	// Or(A Not(A)) => Any: jeder Wert liegt in A oder nicht. Gilt auch für ein Prädikat, dessen
	// Inhalt der Checker nicht kennt - nur so ist [isEven] … [Not(isEven)] erschöpfend.
	if (uniqueChoices.some(choice => {
		if (isOpaqueForNormalization(choice)) {
			return false;
		}
		const resolved = resolveAlias(choice);
		return isComplementType(resolved)
			&& uniqueChoices.some(other =>
				!isOpaqueForNormalization(other)
				&& typeEquals(other, resolved.SourceType));
	})) {
		return builtinAny;
	}
	//#endregion complement
	//#region collapse Boolean
	// Or(true false) => Boolean: die einzigen zwei möglichen Werte, kein Informationsverlust.
	if (uniqueChoices.length === 2
		&& uniqueChoices.some(choice => {
			const resolved = !isOpaqueForNormalization(choice) && resolveAlias(choice);
			return resolved && resolved.julType === 'booleanLiteral' && resolved.value === true;
		})
		&& uniqueChoices.some(choice => {
			const resolved = !isOpaqueForNormalization(choice) && resolveAlias(choice);
			return resolved && resolved.julType === 'booleanLiteral' && resolved.value === false;
		})) {
		return builtinBoolean;
	}
	//#endregion collapse Boolean
	//#region remove subtypes
	// Or(Boolean False) => Boolean: ein Choice, der schon Teilmenge eines anderen ist, trägt
	// keine zusätzliche Information mehr. Nur bis zu einer
	// Größenschwelle, sonst O(n²) mit getTypeError - einem der teuersten Checker-Aufrufe (wie
	// TypeScript es bei getUnionType(..., UnionReduction.Subtype) macht). Choices, die nicht
	// sicher aufgelöst sind (parameterReference/nestedReference), werden nie verworfen und
	// verwerfen auch nichts - im Zweifel nicht kollabieren (Prinzip Freiheit).
	const reducedChoices = uniqueChoices.length <= subtypeReductionLimit
		? removeSubtypes(uniqueChoices)
		: uniqueChoices;
	if (reducedChoices.length === 1) {
		return reducedChoices[0]!;
	}
	//#endregion remove subtypes
	//#region collapse Streams
	// Or(Stream(1) Stream(2)) => Stream(Or(1 2))
	// TODO? diese Zusammenfassung ist eigentlich inhaltlich falsch, denn der Typ ist ungenauer
	// Or([1 1] [2 2]) != [Or(1 2) Or(1 2)] wegen Mischungen wie [1 2], [2 1] obwohl nur [1 1] oder [2 2] erlaubt sein sollten
	const streamChoices = reducedChoices.filter(isStreamType);
	let collapsedStreamChoices: CompileTimeType[];
	if (streamChoices.length > 1) {
		collapsedStreamChoices = [];
		const streamValueChoices = streamChoices.map(stream => stream.ValueType);
		const collapsedValueType = createNormalizedUnionType(streamValueChoices);
		collapsedStreamChoices.push(
			// Endlich nur, wenn jeder Choice endlich ist, sonst verspräche die Union mehr als ihre Teile.
			createCompileTimeStreamType(collapsedValueType, streamChoices.every(stream => stream.finite)),
			...reducedChoices.filter(choiceType =>
				!isStreamType(choiceType)),
		);
		if (collapsedStreamChoices.length === 1) {
			return collapsedStreamChoices[0]!;
		}
	}
	else {
		collapsedStreamChoices = reducedChoices;
	}
	//#endregion collapse Streams
	return createCompileTimeUnionType(collapsedStreamChoices);
}

/**
 * Der Typ von [...left ...right]: Felder von right überschreiben gleichnamige von left.
 * Eine Union verteilt sich über ihre Choices, auf jeder Seite. Empty trägt keine Felder bei.
 * Liefert undefined, wenn eine Seite kein Dictionary-Literal ist - dann ist nichts entscheidbar.
 */
function spreadDictionaryTypes(
	rawLeft: CompileTimeType,
	rawRight: CompileTimeType,
	createDictionary: (fieldTypes: CompileTimeDictionary) => CompileTimeType,
): CompileTimeType | undefined {
	const left = resolveAlias(rawLeft);
	const right = resolveAlias(rawRight);
	const distributed = isUnionType(left)
		? left.ChoiceTypes.map(choice => spreadDictionaryTypes(choice, right, createDictionary))
		: isUnionType(right)
			? right.ChoiceTypes.map(choice => spreadDictionaryTypes(left, choice, createDictionary))
			: undefined;
	if (distributed) {
		return distributed.every(isDefined)
			? createNormalizedUnionType(distributed)
			: undefined;
	}
	if (right.julType === 'empty') {
		return left;
	}
	if (left.julType === 'empty') {
		return right;
	}
	if (isDictionaryLiteralType(left)
		&& isDictionaryLiteralType(right)) {
		return createDictionary({
			...left.Fields,
			...right.Fields,
		});
	}
	return undefined;
}

function createNormalizedIntersectionType(ChoiceTypes: CompileTimeType[]): CompileTimeType {
	// TODO flatten nested IntersectionTypes?

	if (ChoiceTypes.length === 2) {
		const first = resolveAlias(ChoiceTypes[0]!);
		const second = resolveAlias(ChoiceTypes[1]!);

		// Never ist das absorbierende Element:
		// And(A Never) => Never
		if (first.julType === 'never'
			|| second.julType === 'never') {
			return builtinNever;
		}

		// Any ist das neutrale Element:
		// And(A Any) => A
		if (first.julType === 'any') {
			return ChoiceTypes[1]!;
		}
		if (second.julType === 'any') {
			return ChoiceTypes[0]!;
		}
	}

	// Ab hier bauen die Regeln den Typ um (Distribution, Feld-Merge, Teilmengen-Shortcut) - ein
	// Alias überlebt das ohnehin nicht, also gleich auf den aufgelösten Choices arbeiten.
	const resolvedChoices = ChoiceTypes.map(resolveAlias);

	// Distributivgesetz anwenden:
	// And(Or(A B) C) => Or(And(A C) And(B C)
	if (ChoiceTypes.length === 2) {
		// beide Seiten prüfen, damit die Reihenfolge der Argumente egal ist
		const unionIndex = resolvedChoices.findIndex(isUnionType);
		if (unionIndex >= 0) {
			const unionType = resolvedChoices[unionIndex] as CompileTimeUnionType;
			const otherIntersectionType = resolvedChoices[unionIndex ? 0 : 1]!;
			const distributedChoices = unionType.ChoiceTypes.map(choice => {
				return createNormalizedIntersectionType([choice, otherIntersectionType]);
			});
			const distributedType = createNormalizedUnionType(distributedChoices);
			return distributedType;
		}
	}

	if (resolvedChoices.length === 2
		&& isComplementType(resolvedChoices[1])) {
		const first = resolvedChoices[0]!;
		const second = resolvedChoices[1].SourceType;
		if (typeEquals(first, second)) {
			// And(A Not(A)) => Never
			return builtinNever;
		}
		// And(A Not(B))
		// Wenn B keine Schnittmenge mit A hat: nur A liefern. Dass B keine Teilmenge von A ist,
		// reicht nicht: Or(0 §a§) liegt nicht in Integer, schließt aber die 0 aus.
		if (typesOverlap(first, second) === false) {
			// Der geschriebene Typ statt des aufgelösten, damit ein Alias wie PositiveInteger in
			// der Anzeige erhalten bleibt.
			return ChoiceTypes[0]!;
		}
	}

	if (resolvedChoices.length === 2) {
		const first = resolvedChoices[0]!;
		const second = resolvedChoices[1]!;

		// Dictionaries sind Strukturen, keine Wertemengen: der Teilmengen-Shortcut unten würde bei
		// einer unvollständigen Seite (complete: false) Felder verlieren, die nur die andere Seite
		// kennt - "zuweisbar" heißt dort nur "widerspricht nicht nachweisbar", nicht "enthält schon
		// alles". Deshalb werden Felder hier stattdessen zusammengeführt, bevor der Shortcut greift.
		if (first.julType === 'dictionaryLiteral'
			|| second.julType === 'dictionaryLiteral') {
			if (first.julType === 'dictionaryLiteral'
				&& second.julType === 'dictionaryLiteral') {
				const keys = new Set([...Object.keys(first.Fields), ...Object.keys(second.Fields)]);
				const mergedFields: CompileTimeDictionary = {};
				for (const key of keys) {
					const firstFieldType = first.Fields[key];
					const secondFieldType = second.Fields[key];
					if (firstFieldType && secondFieldType) {
						const mergedFieldType = createNormalizedIntersectionType([firstFieldType, secondFieldType]);
						// Beide Seiten verlangen das Feld, kein Wert erfüllt beide: dann gibt es auch
						// kein Dictionary, das beide erfüllt. So fällt z.B. beim Verengen über
						// step/type die Choice mit dem anderen type aus der Union.
						if (mergedFieldType.julType === 'never') {
							return builtinNever;
						}
						mergedFields[key] = mergedFieldType;
					}
					else {
						mergedFields[key] = firstFieldType ?? secondFieldType!;
					}
				}
				return createCompileTimeDictionaryLiteralType(mergedFields, first.complete || second.complete);
			}
			if (typesOverlap(first, second) === false) {
				return builtinNever;
			}
			return createCompileTimeIntersectionType(ChoiceTypes);
		}

		// Teilmenge liefern:
		// And(A B) => A, wenn A Teilmenge von B ist
		// z.B. And(Integer Rational) => Integer, And(Integer Integer) => Integer
		if (hasReliableTypeError(first)
			&& hasReliableTypeError(second)) {
			if (!areArgsAssignableTo(undefined, first, second)) {
				return first;
			}
			if (!areArgsAssignableTo(undefined, second, first)) {
				return second;
			}
		}

		// leere Schnittmenge:
		// And(A B) => Never, wenn A und B keinen gemeinsamen Wert haben
		// z.B. And(Integer Text) => Never
		if (typesOverlap(first, second) === false) {
			return builtinNever;
		}
	}

	const intersectionType = createCompileTimeIntersectionType(ChoiceTypes);
	// Grenzen ohne gemeinsame ganze Zahl, auch über mehr als zwei Choices:
	// And(Integer GreaterInteger(2) LessInteger(2)) => Never
	const range = getIntegerRange(intersectionType);
	if (range?.isInteger
		&& isEmptyIntegerRange(range)) {
		return builtinNever;
	}
	return intersectionType;
}

/**
 * Sagt getTypeError für diesen Typ überhaupt etwas aus?
 * Für any, nestedReference, parameterReference und parameters ist die Prüfung bewusst permissiv,
 * "kein Fehler" heißt dort also nicht "ist zuweisbar". Wer aus einem ausbleibenden Fehler etwas
 * folgert, muss diese Typen ausnehmen.
 * Zusammengesetzte Typen erben die Verlässlichkeit ihrer Bestandteile: steckt in einem And, Or
 * oder Not noch eine parameterReference, steht der Typ noch nicht fest und sagt damit genauso
 * wenig aus wie die Referenz selbst.
 */
function hasReliableTypeError(type: CompileTimeType): boolean {
	switch (type.julType) {
		case 'and':
		case 'or':
			return type.ChoiceTypes.every(hasReliableTypeError);
		// Not(X) ist in getTypeError als Quelle wie als Ziel permissiv, auch wenn X verlässlich ist.
		case 'not':
			return false;
		case 'any':
		case 'nestedReference':
		case 'parameterReference':
		case 'parameters':
		// Ein stehengebliebener bedingter Typ wartet noch auf seine Operanden, eine Summe auf ihre
		// Argumente.
		case 'conditional':
		case 'add':
		// Gegen ein Prädikat heißt "kein Fehler" nur "liegt in der Obermenge", nicht "erfüllt es".
		case 'predicate':
			return false;
		// alias: getTypeError und typeEquals lösen ihn selbst auf, die Verlässlichkeit des Ziels
		// wird hier bewusst nicht mitgeprüft.
		case 'alias':
		case 'blob':
		case 'boolean':
		case 'booleanLiteral':
		case 'concat':
		case 'date':
		case 'dictionary':
		case 'dictionaryLiteral':
		case 'empty':
		case 'error':
		case 'float':
		case 'floatLiteral':
		case 'function':
		case 'bound':
		case 'integer':
		case 'integerLiteral':
		case 'lengthOf':
		case 'list':
		case 'never':
		case 'indexRange':
		case 'stream':
		case 'text':
		case 'textLiteral':
		case 'tuple':
		case 'mapElements':
		case 'type':
		case 'typeOf':
		case 'withElementAt':
			return true;
		default: {
			const assertNever: never = type;
			throw new Error('Unexpected type.julType: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

/**
 * Die grobe Laufzeit-Familie eines Typs. Werte aus verschiedenen Familien sind disjunkt,
 * ihr Schnitt ist also leer.
 * undefined = Familie unbekannt, dann ist keine Aussage über Disjunktheit möglich.
 */
function getTypeFamily(type: ResolvedType): string | undefined {
	switch (type.julType) {
		case 'blob':
			return 'blob';
		case 'boolean':
		case 'booleanLiteral':
			return 'boolean';
		case 'date':
			return 'date';
		case 'dictionary':
		case 'dictionaryLiteral':
			return 'dictionary';
		case 'empty':
			return 'empty';
		case 'error':
			return 'error';
		case 'float':
		case 'floatLiteral':
			return 'float';
		case 'function':
			return 'function';
		case 'integer':
		case 'integerLiteral':
			return 'integer';
		case 'bound':
			return type.Family;
		case 'list':
		case 'tuple':
			return 'list';
		case 'stream':
			return 'stream';
		case 'text':
		case 'textLiteral':
			return 'text';
		default:
			return undefined;
	}
}

/**
 * Haben die beiden Typen mindestens einen gemeinsamen Wert?
 * Das ist eine andere Relation als die Zuweisbarkeit (getTypeError), die nur Teilmengen prüft:
 * Integer ist keine Teilmenge von 0, überlappt mit 0 aber sehr wohl.
 * undefined = unbekannt. Aufrufer müssen dann permissiv sein, sonst entstehen Falschfehler.
 */
/**
 * Sicher überlappend nur für dasselbe Prädikat oder einen konstanten Wert, für den es true
 * liefert. Sicher disjunkt, wenn der Wert es nicht erfüllt oder außerhalb der Obermenge liegt.
 */
function predicateOverlapsWith(predicate: CompileTimePredicateType, other: ResolvedType): boolean | undefined {
	if (other.julType === 'predicate'
		&& isSamePredicate(predicate, other)) {
		return true;
	}
	const folded = tryFoldPredicate(predicate, other);
	if (folded !== undefined) {
		return folded;
	}
	return typesOverlap(predicate.UpperBound, other) === false
		? false
		: undefined;
}

function typesOverlap(rawFirst: CompileTimeType, rawSecond: CompileTimeType): boolean | undefined {
	const first = resolveAlias(rawFirst);
	const second = resolveAlias(rawSecond);
	// never enthält keinen Wert, any alle
	if (first.julType === 'never'
		|| second.julType === 'never') {
		return false;
	}
	if (first.julType === 'any'
		|| second.julType === 'any') {
		return true;
	}
	// Or überlappt, wenn ein Choice überlappt, und ist disjunkt, wenn alle Choices disjunkt sind
	if (isUnionType(first)) {
		return someTypeOverlaps(first.ChoiceTypes, second);
	}
	if (isUnionType(second)) {
		return someTypeOverlaps(second.ChoiceTypes, first);
	}
	// Aus den Teilen eines And lässt sich keine Überlappung bestätigen, aus Grenzen um ganze
	// Zahlen schon: And(Integer Not(GreaterInteger(3))) und GreaterInteger(2) teilen sich die 3.
	const firstRange = getIntegerRange(first);
	const secondRange = getIntegerRange(second);
	if (firstRange
		&& secondRange
		&& (firstRange.isInteger || secondRange.isInteger)) {
		const min = maxBound(firstRange.min, secondRange.min);
		const max = minBound(firstRange.max, secondRange.max);
		return min === undefined
			|| max === undefined
			|| min <= max;
	}
	// And ist disjunkt, sobald ein Choice disjunkt ist.
	// Überlappung lässt sich aus den Teilen dagegen nicht bestätigen.
	if (first.julType === 'and') {
		return everyTypeOverlaps(first.ChoiceTypes, second);
	}
	if (second.julType === 'and') {
		return everyTypeOverlaps(second.ChoiceTypes, first);
	}
	// A überlappt Not(B) genau dann, wenn A keine Teilmenge von B ist.
	// Hier fällt die Überlappung auf die vorhandene Zuweisbarkeit zurück.
	if (isComplementType(first)) {
		return isNotAssignableTo(second, first.SourceType);
	}
	if (isComplementType(second)) {
		return isNotAssignableTo(first, second.SourceType);
	}
	if (first.julType === 'predicate') {
		return predicateOverlapsWith(first, second);
	}
	if (second.julType === 'predicate') {
		return predicateOverlapsWith(second, first);
	}
	const firstFamily = getTypeFamily(first);
	const secondFamily = getTypeFamily(second);
	if (!firstFamily
		|| !secondFamily) {
		return undefined;
	}
	if (firstFamily !== secondFamily) {
		return false;
	}
	//#region gleiche Familie
	// Innerhalb der Familie beantwortet eine Grenze nur die Bereichssicht oben. Konnte sie es nicht
	// (Float, unbekannter Wert), ist die Überlappung unbekannt, nicht wie beim Basistyp gegeben.
	if (first.julType === 'bound'
		|| second.julType === 'bound') {
		return undefined;
	}
	const firstIsLiteral = isLiteralType(first);
	const secondIsLiteral = isLiteralType(second);
	if (firstIsLiteral
		&& secondIsLiteral) {
		return typeEquals(first, second);
	}
	if (firstIsLiteral
		|| secondIsLiteral) {
		// ein Literal gegen den Basistyp derselben Familie: das Literal ist enthalten
		return true;
	}
	switch (firstFamily) {
		case 'list':
			return sequencesOverlap(first, second);
		// strukturierte Typen derselben Familie können sich beliebig überschneiden
		case 'dictionary':
		case 'function':
		case 'stream':
			return undefined;
		default:
			// zwei Basistypen derselben Familie, z.B. Integer und Integer
			return true;
	}
	//#endregion gleiche Familie
}

/**
 * Überlappung zweier Tuples oder Lists, Position für Position. Beide schließen das Leere aus, und
 * ein Tuple nennt nur Mindestpositionen: [Integer] und [Integer Text] teilen sich [1 §x§].
 * Gemeinsam ist ein Wert daher genau dann, wenn jede Position, die beide festlegen, überlappt.
 * Eine List legt jede Position auf ihren Elementtyp fest.
 */
function sequencesOverlap(first: ResolvedType, second: ResolvedType): boolean | undefined {
	let pairs: [CompileTimeType, CompileTimeType][];
	if (first.julType === 'tuple' && second.julType === 'tuple') {
		const length = Math.min(first.ElementTypes.length, second.ElementTypes.length);
		pairs = first.ElementTypes.slice(0, length).map((element, index) =>
			[element, second.ElementTypes[index]!]);
	}
	else if (first.julType === 'tuple' && second.julType === 'list') {
		pairs = first.ElementTypes.map(element => [element, second.ElementType]);
	}
	else if (first.julType === 'list' && second.julType === 'tuple') {
		pairs = second.ElementTypes.map(element => [first.ElementType, element]);
	}
	else if (first.julType === 'list' && second.julType === 'list') {
		pairs = [[first.ElementType, second.ElementType]];
	}
	else {
		return undefined;
	}
	const results = pairs.map(([firstElement, secondElement]) => typesOverlap(firstElement, secondElement));
	if (results.some(result => result === false)) {
		return false;
	}
	return results.every(result => result === true)
		? true
		: undefined;
}

/**
 * Die ganzen Zahlen eines Typs als lückenloser Bereich von min bis max (beide inklusive,
 * undefined = offen, min > max = leer). isInteger, wenn der Typ nur ganze Zahlen enthält. Sonst
 * beschreiben die Grenzen nur seine ganzzahligen Werte, etwa Not(GreaterInteger(2)) bis 2.
 */
interface IntegerRange {
	isInteger: boolean;
	min?: bigint;
	max?: bigint;
}

/**
 * Der Typ als IntegerRange. undefined, wenn er nicht allein aus Integer, Integer-Literalen,
 * GreaterInteger, LessInteger, deren Not mit Integer-Literal, And und Or besteht, oder wenn seine
 * ganzen Zahlen eine Lücke haben: Or(1 3) und And(Integer Not(3)) sind kein Bereich.
 */
function getIntegerRange(rawType: CompileTimeType): IntegerRange | undefined {
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'integer':
			return { isInteger: true };
		case 'integerLiteral':
			return { isInteger: true, min: type.value, max: type.value };
		case 'bound': {
			const value = resolveAlias(type.Value);
			if (type.Family !== 'integer'
				|| value.julType !== 'integerLiteral') {
				return undefined;
			}
			return type.Relation === 'greater'
				? { isInteger: true, min: value.value + 1n }
				: { isInteger: true, max: value.value - 1n };
		}
		// Not(GreaterInteger(3)) enthält außer den ganzen Zahlen bis 3 auch alles andere, etwa Text.
		case 'not': {
			const source = resolveAlias(type.SourceType);
			if (source.julType !== 'bound'
				|| source.Family !== 'integer') {
				return undefined;
			}
			const value = resolveAlias(source.Value);
			if (value.julType !== 'integerLiteral') {
				return undefined;
			}
			return source.Relation === 'greater'
				? { isInteger: false, max: value.value }
				: { isInteger: false, min: value.value };
		}
		case 'and': {
			let range: IntegerRange = { isInteger: false };
			// Ein Not(n) nimmt eine einzelne Zahl heraus. Das ist nur dann wieder ein Bereich, wenn
			// sie am Rand liegt: ≤ 3 ohne 3 ist ≤ 2.
			const excluded: bigint[] = [];
			for (const choiceType of type.ChoiceTypes) {
				const choice = resolveAlias(choiceType);
				if (choice.julType === 'not') {
					const source = resolveAlias(choice.SourceType);
					if (source.julType === 'integerLiteral') {
						excluded.push(source.value);
						continue;
					}
				}
				const choiceRange = getIntegerRange(choice);
				if (!choiceRange) {
					return undefined;
				}
				range = {
					isInteger: range.isInteger || choiceRange.isInteger,
					min: maxBound(range.min, choiceRange.min),
					max: minBound(range.max, choiceRange.max),
				};
			}
			return excludeFromIntegerRange(range, excluded);
		}
		case 'or': {
			const ranges: IntegerRange[] = [];
			for (const choiceType of type.ChoiceTypes) {
				const choiceRange = getIntegerRange(choiceType);
				if (!choiceRange) {
					return undefined;
				}
				if (!isEmptyIntegerRange(choiceRange)) {
					ranges.push(choiceRange);
				}
			}
			return unionOfIntegerRanges(ranges);
		}
		default:
			return undefined;
	}
}

function isEmptyIntegerRange(range: IntegerRange): boolean {
	return range.min !== undefined
		&& range.max !== undefined
		&& range.min > range.max;
}

/**
 * Nimmt einzelne Zahlen aus dem Bereich heraus. Am Rand verschiebt das die Grenze, so lange, bis
 * der Rand nicht mehr ausgenommen ist. Liegt eine Zahl im Inneren, hat der Bereich eine Lücke.
 */
function excludeFromIntegerRange(range: IntegerRange, excluded: bigint[]): IntegerRange | undefined {
	let { min, max } = range;
	let remaining = excluded;
	let changed = true;
	while (changed) {
		changed = false;
		remaining = remaining.filter(value => {
			if (value === min) {
				min = value + 1n;
				changed = true;
				return false;
			}
			if (value === max) {
				max = value - 1n;
				changed = true;
				return false;
			}
			return true;
		});
	}
	const result = { isInteger: range.isInteger, min, max };
	if (isEmptyIntegerRange(result)) {
		return result;
	}
	const hasHole = remaining.some(value =>
		(min === undefined || value > min)
		&& (max === undefined || value < max));
	return hasHole ? undefined : result;
}

/**
 * Die Vereinigung, falls sie wieder lückenlos ist: überlappend oder angrenzend, bei ganzen Zahlen
 * also auch 3 und 4. Leer, wenn es keinen Bereich gibt.
 */
function unionOfIntegerRanges(ranges: IntegerRange[]): IntegerRange | undefined {
	const isInteger = ranges.every(range => range.isInteger);
	if (!ranges.length) {
		return { isInteger: true, min: 1n, max: 0n };
	}
	// Nach unterer Grenze sortiert, offen nach unten zuerst.
	const sorted = [...ranges].sort((first, second) => {
		if (first.min === second.min) {
			return 0;
		}
		if (first.min === undefined) {
			return -1;
		}
		if (second.min === undefined) {
			return 1;
		}
		return first.min < second.min ? -1 : 1;
	});
	const min = sorted[0]!.min;
	let max = sorted[0]!.max;
	for (const range of sorted.slice(1)) {
		if (max === undefined) {
			// Schon nach oben offen, alles Weitere liegt darin.
			break;
		}
		if (range.min! > max + 1n) {
			return undefined;
		}
		max = range.max === undefined || range.max > max
			? range.max
			: max;
	}
	return { isInteger, min, max };
}

/** Die größere zweier unteren Grenzen, undefined = offen. */
function maxBound(first: bigint | undefined, second: bigint | undefined): bigint | undefined {
	if (first === undefined) {
		return second;
	}
	if (second === undefined) {
		return first;
	}
	return first > second ? first : second;
}

/** Die kleinere zweier oberen Grenzen, undefined = offen. */
function minBound(first: bigint | undefined, second: bigint | undefined): bigint | undefined {
	if (first === undefined) {
		return second;
	}
	if (second === undefined) {
		return first;
	}
	return first < second ? first : second;
}

function someTypeOverlaps(choiceTypes: CompileTimeType[], other: CompileTimeType): boolean | undefined {
	const results = choiceTypes.map(choiceType => typesOverlap(choiceType, other));
	if (results.some(result => result === true)) {
		return true;
	}
	return results.every(result => result === false)
		? false
		: undefined;
}

function everyTypeOverlaps(choiceTypes: CompileTimeType[], other: CompileTimeType): boolean | undefined {
	const results = choiceTypes.map(choiceType => typesOverlap(choiceType, other));
	return results.some(result => result === false)
		? false
		: undefined;
}

/**
 * Ist der Wert dem Zieltyp sicher nicht zuweisbar?
 * undefined, wenn die Zuweisbarkeitsprüfung für einen der beiden Typen nichts aussagt —
 * "kein Fehler" heißt dort eben nicht "ist zuweisbar".
 */
function isNotAssignableTo(type: CompileTimeType, targetType: CompileTimeType): boolean | undefined {
	if (!hasReliableTypeError(type)
		|| !hasReliableTypeError(targetType)) {
		return undefined;
	}
	return !!areArgsAssignableTo(undefined, type, targetType);
}

function isLiteralType(type: ResolvedType): boolean {
	switch (type.julType) {
		case 'booleanLiteral':
		case 'floatLiteral':
		case 'integerLiteral':
		case 'textLiteral':
			return true;
		default:
			return false;
	}
}

// 'unknown', 'impure' und 'pureIfArgsPure' fallen zusammen, weil kein Algorithmus sie
// unterscheidet - sonst bekäme createNormalizedUnionType eine zweite künstliche Trennung.
function effectivePurity(purity: TypePurity): 'pure' | 'notPure' {
	return purity === 'pure' ? 'pure' : 'notPure';
}

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
function getArgumentPurity(rawArgType: CompileTimeType, ownFunctionType: CompileTimeFunctionType | undefined): Purity {
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
	prefixArgumentType: CompileTimeType | undefined,
	argsType: CompileTimeType,
	ownFunctionType?: CompileTimeFunctionType,
): Purity {
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
	prefixArgumentType: CompileTimeType | undefined,
	argsType: CompileTimeType,
): Purity {
	return getCallPurityInfo(functionType, prefixArgumentType, argsType) === 'pure' ? 'pure' : 'impure';
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
	ownFunctionType: CompileTimeFunctionType,
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
						const prefixArgumentType = expression.prefixArgument?.typeInfo?.type;
						const argsType = expression.arguments?.typeInfo?.type ?? builtinEmpty;
						contribute(
							getCallPurityInfo(
								functionExpression?.typeInfo?.type ?? builtinAny,
								prefixArgumentType,
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
	prefixArgumentType: CompileTimeType | undefined,
	argsType: CompileTimeType,
	assignArgsError: string | undefined,
): CompileTimeType | undefined {
	if (assignArgsError) {
		return undefined;
	}
	if (functionExpression.type !== 'reference') {
		return undefined;
	}
	const resolvedFunctionType = resolveAlias(functionType);
	if (!isFunctionType(resolvedFunctionType) || getCallPurity(resolvedFunctionType, prefixArgumentType, argsType) !== 'pure') {
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
	prefixArgumentType: CompileTimeType | undefined,
	argsType: CompileTimeType,
	returnType: CompileTimeType,
): CompileTimeFunctionType | undefined {
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
	const argumentsDisplay = getAllArgTypes(prefixArgumentType, argsType)
		?.map(argType => typeToString(argType, 0, 1))
		.join(' ') ?? '';
	const boundType = createCompileTimeFunctionType(result.ParamsType, result.ReturnType, result.purity, result.aliasName);
	boundType.predicate = result.predicate;
	boundType.literal = result.literal;
	boundType.foldable = result.foldable;
	boundType.boundArguments = {
		values: values,
		display: `${functionExpression.name.name}(${argumentsDisplay})`,
	};
	return boundType;
}

function isAliasApplication(type: CompileTimeType): type is CompileTimeAliasType & { args: CompileTimeType; } {
	return type.julType === 'alias' && !!type.args;
}

/**
 * Dieselbe Typfunktion mit gleichen Argumenten, etwa Tree(Integer) und Tree(Integer) aus zwei
 * Auflösungen: gleich, ohne aufzulösen.
 */
function isSameAliasApplication(first: CompileTimeType, second: CompileTimeType): boolean {
	return isAliasApplication(first)
		&& isAliasApplication(second)
		&& first.symbol === second.symbol
		&& typeEquals(first.args, second.args);
}

/**
 * Für den Stapel laufender Alias-Vergleiche: jede Auflösung von Tree(Text) erzeugt einen neuen
 * inneren Knoten, derselbe Vergleich eine Ebene tiefer wäre an der Identität nicht zu erkennen.
 */
function isSameOrSameAliasApplication(first: CompileTimeType, second: CompileTimeType): boolean {
	return first === second
		|| isSameAliasApplication(first, second);
}

function typeEquals(first: CompileTimeType, second: CompileTimeType): boolean {
	if (first === second) {
		return true;
	}
	// Dieselbe Notbremse wie in getTypeError. Hier fällt sie auf "nicht gleich" zurück: eine
	// ausgelassene Deduplizierung ist harmlos, eine fälschlich angenommene Gleichheit nicht.
	if (typeEqualsDepth >= maxTypeComparisonDepth) {
		return false;
	}
	typeEqualsDepth++;
	try {
		return typeEqualsAtDepth(first, second);
	}
	finally {
		typeEqualsDepth--;
	}
}

function typeEqualsAtDepth(first: CompileTimeType, second: CompileTimeType): boolean {
	// Der Alias ist reine Beschriftung: geprüft wird der Typ dahinter. Vor dem switch, weil sonst
	// jeder Zweig seinen eigenen Alias-Fall auf der Gegenseite bräuchte.
	// Liegt das Paar bereits auf dem Stack, gilt es als gleich - dieselbe coinduktive Annahme wie
	// in getTypeError, ohne die der Vergleich rekursiver Typen nicht endet.
	if (first.julType === 'alias'
		|| second.julType === 'alias') {
		if (aliasEqualityInProgress.some(pair =>
			isSameOrSameAliasApplication(pair.first, first)
			&& isSameOrSameAliasApplication(pair.second, second))) {
			return true;
		}
		if (isSameAliasApplication(first, second)) {
			return true;
		}
		if (!aliasEqualityInProgress.length) {
			typeEqualsApplicationExpansionsRemaining = maxAliasApplicationExpansions;
		}
		if (isAliasApplication(first) || isAliasApplication(second)) {
			// Wie bei der Tiefenbremse "nicht gleich": eine ausgelassene Deduplizierung ist harmlos.
			if (typeEqualsApplicationExpansionsRemaining <= 0) {
				return false;
			}
			typeEqualsApplicationExpansionsRemaining--;
		}
		aliasEqualityInProgress.push({ first: first, second: second });
		try {
			return typeEquals(
				first.julType === 'alias' ? dereferenceAlias(first) : first,
				second.julType === 'alias' ? dereferenceAlias(second) : second);
		}
		finally {
			aliasEqualityInProgress.pop();
		}
	}
	switch (first.julType) {
		case 'empty':
		case 'any':
		case 'blob':
		case 'boolean':
		case 'date':
		case 'error':
		case 'integer':
		case 'float':
		case 'never':
		case 'text':
		case 'type':
			return first.julType === second.julType;
		case 'booleanLiteral':
		case 'integerLiteral':
		case 'floatLiteral':
		case 'textLiteral':
			return first.julType === second.julType
				&& first.value === second.value;
		case 'dictionary':
			return second.julType === 'dictionary'
				&& typeEquals(first.ElementType, second.ElementType);
		case 'bound':
			return second.julType === 'bound'
				&& first.Relation === second.Relation
				&& first.Family === second.Family
				&& typeEquals(first.Value, second.Value);
		case 'lengthOf':
			return second.julType === 'lengthOf'
				&& typeEquals(first.Source, second.Source);
		case 'list':
			return second.julType === 'list'
				&& typeEquals(first.ElementType, second.ElementType);
		case 'not':
			return second.julType === 'not'
				&& typeEquals(first.SourceType, second.SourceType);
		case 'stream':
			return second.julType === 'stream'
				&& first.finite === second.finite
				&& typeEquals(first.ValueType, second.ValueType);
		case 'typeOf':
			return second.julType === 'typeOf'
				&& typeEquals(first.value, second.value);
		case 'function':
			return second.julType === 'function'
				&& typeEquals(first.ParamsType, second.ParamsType)
				&& typeEquals(first.ReturnType, second.ReturnType)
				&& effectivePurity(first.purity) === effectivePurity(second.purity);
		case 'conditional':
			return second.julType === 'conditional'
				&& first.Operands.length === second.Operands.length
				&& first.Operands.every((operand, i) => typeEquals(operand, second.Operands[i]!))
				&& first.Branches.length === second.Branches.length
				&& first.Branches.every((branch, i) =>
					typeEquals(branch.Head, second.Branches[i]!.Head)
					&& typeEquals(branch.Result, second.Branches[i]!.Result));
		case 'withElementAt':
			return second.julType === 'withElementAt'
				&& typeEquals(first.Source, second.Source)
				&& typeEquals(first.Index, second.Index)
				&& typeEquals(first.Value, second.Value);
		case 'indexRange':
			return second.julType === 'indexRange'
				&& typeEquals(first.Start, second.Start)
				&& typeEquals(first.End, second.End);
		case 'mapElements':
			// Der Callback zählt als Objekt: seine Parameterverweise hängen an genau diesem.
			return second.julType === 'mapElements'
				&& typeEquals(first.Source, second.Source)
				&& first.Callback === second.Callback
				&& first.deferValueOf === second.deferValueOf;
		case 'concat':
			return second.julType === 'concat'
				&& first.Sources.length === second.Sources.length
				&& first.Sources.every((source, i) => typeEquals(source, second.Sources[i]!));
		case 'add':
			return second.julType === 'add'
				&& typeEquals(first.ArgsType, second.ArgsType);
		case 'tuple':
			return second.julType === 'tuple'
				&& first.ElementTypes.length === second.ElementTypes.length
				&& first.ElementTypes.every((elem, i) => typeEquals(elem, second.ElementTypes[i]!));
		case 'or':
			// Or-Typen sind Mengen, nicht Sequenzen: Reihenfolge ist egal,
			// aber jede Choice muss in beiden vorhanden sein.
			return second.julType === 'or'
				&& first.ChoiceTypes.length === second.ChoiceTypes.length
				&& first.ChoiceTypes.every(choice =>
					second.ChoiceTypes.some(otherChoice => typeEquals(choice, otherChoice)));
		case 'and':
			// Wie 'or': Schnittmengen sind kommutativ
			return second.julType === 'and'
				&& first.ChoiceTypes.length === second.ChoiceTypes.length
				&& first.ChoiceTypes.every(choice =>
					second.ChoiceTypes.some(otherChoice => typeEquals(choice, otherChoice)));
		case 'dictionaryLiteral':
			return second.julType === 'dictionaryLiteral'
				&& Object.keys(first.Fields).length === Object.keys(second.Fields).length
				&& Object.entries(first.Fields).every(([key, value]) => {
					const otherValue = second.Fields[key];
					return otherValue !== undefined && typeEquals(value, otherValue);
				});
		case 'parameterReference':
			return second.julType === 'parameterReference'
				&& first.name === second.name
				&& first.index === second.index
				&& first.deferValueOf === second.deferValueOf;
		case 'nestedReference':
			return second.julType === 'nestedReference'
				&& nestedKeysEqual(first.nestedKey, second.nestedKey)
				&& typeEquals(first.source, second.source)
				&& first.deferValueOf === second.deferValueOf;
		case 'parameters':
			return second.julType === 'parameters'
				&& first.singleNames.length === second.singleNames.length
				&& first.singleNames.every((param, i) => {
					const otherParam = second.singleNames[i];
					return otherParam !== undefined
						&& param.name === otherParam.name
						&& (param.type === undefined && otherParam.type === undefined
							|| param.type !== undefined && otherParam.type !== undefined && typeEquals(param.type, otherParam.type));
				})
				&& (first.rest === undefined && second.rest === undefined
					|| first.rest !== undefined && second.rest !== undefined
					&& first.rest.name === second.rest.name
					&& (first.rest.type === undefined && second.rest.type === undefined
						|| first.rest.type !== undefined && second.rest.type !== undefined && typeEquals(first.rest.type, second.rest.type)));
		case 'predicate':
			return second.julType === 'predicate'
				&& isSamePredicate(first, second);
		default:
			const assertNever: never = first;
			throw new Error('Unexpected julType: ' + (assertNever as CompileTimeType).julType);
	}
}

/**
 * Zwei Prädikate sind gleich, wenn es dieselbe Funktion ist und sie rein ist - nur dann liefert
 * sie für denselben Wert bei jeder Auswertung dasselbe. Gleiches Verhalten zweier verschiedener
 * Funktionen lässt sich nicht feststellen. Eine fälschlich angenommene Gleichheit wäre unsound,
 * deshalb zählt nur dasselbe Funktionstyp-Objekt. Auch das reicht nicht, wenn das Literal in
 * einer anderen Funktion steht: dann ist der Funktionstyp der deklarierte Rückgabetyp, den jeder
 * Aufruf teilt, und divisibleBy(5) wäre dasselbe wie divisibleBy(3). Solange der Funktionstyp
 * nicht festhält, woran seine freien Referenzen gebunden sind, gilt so ein Prädikat nie als gleich.
 */
function isSamePredicate(first: CompileTimePredicateType, second: CompileTimePredicateType): boolean {
	const firstFunction = first.FunctionType;
	const secondFunction = second.FunctionType;
	if (firstFunction.purity !== 'pure'
		|| secondFunction.purity !== 'pure') {
		return false;
	}
	const literal = firstFunction.literal;
	if (!literal) {
		// Ohne Literal (nativeFunction, Import aus .ts) bleibt nur dasselbe Objekt.
		return firstFunction === secondFunction;
	}
	if (literal !== secondFunction.literal) {
		return false;
	}
	if (!isInsideFunctionLiteral(literal)) {
		return true;
	}
	const firstBound = firstFunction.boundArguments;
	const secondBound = secondFunction.boundArguments;
	return !!firstBound
		&& !!secondBound
		&& haveSameBoundValues(firstBound.values, secondBound.values);
}

function haveSameBoundValues(
	first: { [name: string]: unknown; },
	second: { [name: string]: unknown; },
): boolean {
	const names = Object.keys(first);
	return names.length === Object.keys(second).length
		&& names.every(name =>
			name in second
			&& runtime.deepEqual(first[name], second[name]));
}

function isInsideFunctionLiteral(expression: TypedExpression): boolean {
	for (let parent = expression.parent; parent; parent = parent.parent) {
		if (parent.type === 'functionLiteral') {
			return true;
		}
	}
	return false;
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
	const argTypes = getAllArgTypes(call.prefixArgument?.typeInfo?.type, argsType);
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
	prefixArgumentType: CompileTimeType | undefined,
	errors: CompilerError[],
): void {
	const prefixArgumentCount = prefixArgumentType ? 1 : 0;
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
		const error = getPredicateFunctionError(valueType);
		if (error) {
			errors.push({
				code: ErrorCode.typeGuardIsNotType,
				message: error.message,
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
	functionType: CompileTimeFunctionType,
	functionScopes: NonEmptyArray<SymbolTable>,
): void {
	params.singleFields.forEach(parameter => {
		const parameterSymbol = findParameterSymbol(parameter, functionScopes);
		parameterSymbol.functionRef = functionType;
	});
	const restParameter = params.rest;
	if (restParameter) {
		const parameterSymbol = findParameterSymbol(restParameter, functionScopes);
		parameterSymbol.functionRef = functionType;
	}
}

/**
 * Der Typ hinter einem Alias.
 * Any, solange das Symbol noch gecheckt wird - das ist der Zyklusfall, und unproduktive Zyklen
 * sind an dieser Stelle bereits als JUL5170 gemeldet.
 */
function dereferenceAlias(alias: CompileTimeAliasType): CompileTimeType {
	const symbolType = alias.symbol.typeInfo?.type;
	if (!symbolType) {
		return builtinAny;
	}
	if (alias.args) {
		return dereferenceAliasApplication(alias, alias.args, symbolType);
	}
	// Eine Typdefinition hält ihren Typ als TypeOf; der Alias steht für den Typ selbst.
	return symbolType.julType === 'typeOf'
		? symbolType.value
		: symbolType;
}

/**
 * Ein Alias, dessen Definition gerade geprüft wird (`Node` in `Node = [left: Or([] Node)]`): sein
 * Symbol hat noch keinen Typ, aufgelöst ergibt er Any. Wer Typen dabei vergleicht oder
 * zusammenfasst, darf das nicht für bare Münze nehmen - er steht für den fertigen Typ.
 */
function isPendingAlias(type: CompileTimeType): type is CompileTimeAliasType {
	return type.julType === 'alias'
		&& !type.symbol.typeInfo;
}

/**
 * Choices, die das Normalisieren einer Union nicht auflösen darf: ein Alias in Prüfung (aufgelöst
 * Any, siehe isPendingAlias) und eine Anwendung wie Bin(T) - ihre Auflösung enthielte wieder ein Or
 * mit einer Anwendung, das Normalisieren liefe endlos. Sie verwerfen nichts, werden nicht verworfen
 * und gelten nur bei gleichem Symbol und gleichen args als Duplikat.
 */
function isOpaqueForNormalization(type: CompileTimeType): boolean {
	return isPendingAlias(type)
		|| isAliasApplication(type);
}

function isSameOpaqueChoice(first: CompileTimeType, second: CompileTimeType): boolean {
	if (first === second) {
		return true;
	}
	if (first.julType !== 'alias'
		|| second.julType !== 'alias'
		|| first.symbol !== second.symbol) {
		return false;
	}
	return first.args && second.args
		? typeEquals(first.args, second.args)
		: !first.args && !second.args;
}

/**
 * Tree(T) als Rückgabetyp der fertigen Typfunktion mit diesen Argumenten, eine Ebene tief: die
 * Selbstanwendung darin bleibt wieder ein Knoten. Erst hier, nicht beim Erzeugen, denn beim
 * Erzeugen wird die Typfunktion selbst noch geprüft.
 */
function dereferenceAliasApplication(
	alias: CompileTimeAliasType,
	args: CompileTimeType,
	symbolType: CompileTimeType,
): CompileTimeType {
	const cached = aliasApplicationCache.get(alias);
	if (cached) {
		return cached;
	}
	const functionType = resolveAlias(symbolType);
	if (!isFunctionType(functionType)) {
		return builtinAny;
	}
	const returnType = dereferenceArgumentTypesNested(symbolType, undefined, args, functionType.ReturnType);
	// Wie bei einer Typdefinition steht der Typ als TypeOf, der Alias steht für den Typ selbst.
	const dereferenced = returnType.julType === 'typeOf'
		? returnType.value
		: returnType;
	aliasApplicationCache.set(alias, dereferenced);
	return dereferenced;
}

/**
 * Der Typ ohne Alias-Hüllen, auch mehrfach geschachtelte (B = A = ...).
 * Die Schleifengrenze ist eine Notbremse: unproduktive Zyklen meldet bereits JUL5170, aber ein
 * hängender Language Server wäre ein schlechterer Ausgang als ein ungenauer Typ.
 */
export function resolveAlias(type: CompileTimeType): ResolvedType {
	let current = type;
	for (let depth = 0; current.julType === 'alias'; depth++) {
		if (depth >= maxAliasDepth) {
			return builtinAny;
		}
		current = dereferenceAlias(current);
	}
	return current;
}

/**
 * Die Menge der Werte, für die functionType true liefert, soweit der Checker sie kennt.
 * Obermenge ist der erste Parametertyp, denn die Laufzeit bindet den Wert als einziges Argument
 * und ein unpassender Wert erfüllt das Prädikat nicht. Dazu kommen die erkannten Fakten.
 */
function createPredicateFromFunctionType(functionType: CompileTimeFunctionType): CompileTimePredicateType {
	const parameterType = getFirstParameterType(functionType.ParamsType);
	const facts = functionType.predicate;
	const upperBound = facts
		? createNormalizedIntersectionType([parameterType, facts.ifTrue])
		: parameterType;
	const name = functionType.boundArguments?.display
		?? (functionType.literal && getNameFromValue(functionType.literal));
	return createCompileTimePredicateType(functionType, upperBound, facts?.excludedIfFalse ?? builtinNever, name);
}

/**
 * Was ein einzelnes Argument erfüllen muss, um an die erste Stelle gebunden zu werden.
 * Ohne Parameter wird ein einzelnes Argument schlicht nicht gebunden, jeder Wert passt.
 */
function getFirstParameterType(paramsType: CompileTimeType): CompileTimeType {
	if (isParametersType(paramsType)) {
		const firstParameter = paramsType.singleNames[0];
		if (firstParameter) {
			return firstParameter.type ?? builtinAny;
		}
		const restType = paramsType.rest?.type;
		return restType
			? getElementTypeAtIndex(restType, 0) ?? builtinAny
			: builtinAny;
	}
	return getElementTypeAtIndex(paramsType, 0) ?? builtinAny;
}

function valueOf(type: CompileTimeType | undefined): CompileTimeType {
	if (!type) {
		return builtinAny;
	}
	switch (type.julType) {
		case 'dictionaryLiteral': {
			const fieldValues = mapDictionary(type.Fields, valueOf);
			return createCompileTimeDictionaryLiteralType(fieldValues, type.complete);
		}
		case 'function':
			// Ein Funktionswert in Typ-Position ist ein Prädikat. Das Funktionstyp-Literal kommt
			// hier nicht an: es steht als TypeOf(F) und wird oben zu F ausgepackt.
			return createPredicateFromFunctionType(type);
		case 'predicate':
			return type;
		case 'mapElements':
		case 'nestedReference':
			// Wie bei parameterReference: aufgelöst und ausgepackt wird am Aufruf.
			return type.deferValueOf
				? type
				: { ...type, deferValueOf: true };
		case 'parameters':
			return type;
		case 'parameterReference':
			// Der Argumenttyp steht erst beim Aufruf fest, dort holt traversePlaceholders das
			// valueOf nach.
			return type.deferValueOf
				? type
				: { ...type, deferValueOf: true };
		case 'stream':
			// TODO?
			return type;
		case 'tuple':
			return createCompileTimeTupleType(type.ElementTypes.map(valueOf));
		// Wie beim Tuple je Element, nur mit offener Länge: eine List, deren Elemente Typwerte
		// sind, als Typ gelesen ist die List dieser Typen.
		case 'list': {
			const elementValue = valueOf(type.ElementType);
			return elementValue === type.ElementType
				? type
				: createCompileTimeListType(elementValue);
		}
		case 'dictionary': {
			const elementValue = valueOf(type.ElementType);
			return elementValue === type.ElementType
				? type
				: createCompileTimeDictionaryType(elementValue);
		}
		case 'or': {
			// Der Wert ist einer der Choices, als Typ gelesen also die Union ihrer Werte:
			// Or(TypeOf(Integer) TypeOf(Text)) wird zu Or(Integer Text). Neu gebaut wird nur, wenn
			// sich ein Choice ändert, das Normalisieren der Union ist nicht billig.
			const choiceValues = type.ChoiceTypes.map(valueOf);
			return choiceValues.every((choiceValue, index) => choiceValue === type.ChoiceTypes[index])
				? type
				: createNormalizedUnionType(choiceValues);
		}
		case 'typeOf':
			return type.value;
		// Kein TypeOf zum Auspacken und keine Felder, die eines enthalten könnten: der Typ ist
		// bereits der Wert. Zusammengesetzte Varianten steigen bewusst nicht ab - ein TypeOf
		// darin ist Teil des Typs, nicht seine Verpackung.
		case 'alias':
		case 'and':
		case 'any':
		case 'blob':
		case 'add':
		case 'boolean':
		case 'booleanLiteral':
		case 'concat':
		case 'conditional':
		case 'date':
		case 'empty':
		case 'error':
		case 'float':
		case 'floatLiteral':
		case 'bound':
		case 'integer':
		case 'integerLiteral':
		case 'lengthOf':
		case 'never':
		case 'not':
		case 'indexRange':
		case 'text':
		case 'textLiteral':
		case 'type':
		case 'withElementAt':
			return type;
		default: {
			const assertNever: never = type;
			throw new Error('Unexpected type.julType: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

//#region TypeAssignability

// TODO return true/false = always/never, sometimes/maybe?
function areArgsAssignableTo(
	prefixArgumentType: CompileTimeType | undefined,
	argumentsType: CompileTimeType,
	parametersType: CompileTimeType,
): string | undefined {
	const typeError = getTypeError(prefixArgumentType, argumentsType, parametersType);
	if (typeError) {
		return typeErrorToString(typeError);
	}
	return undefined;
}

/**
 * Liefert den Fehler, der beim Zuweisen eines Wertes vom Typ valueType in eine Variable vom Typ targetType entsteht.
 * valueType muss also Teilmenge von targetType sein.
 */
export function getTypeError(
	prefixArgumentType: CompileTimeType | undefined,
	argumentsType: CompileTimeType,
	targetType: CompileTimeType,
): TypeError | undefined {
	return isTypeAssignable(prefixArgumentType, argumentsType, targetType).error;
}

function isTypeAssignable(
	prefixArgumentType: CompileTimeType | undefined,
	argumentsType: CompileTimeType,
	targetType: CompileTimeType,
): TypeAssignability {
	if (typeComparisonDepth >= maxTypeComparisonDepth) {
		return { assignable: false, error: { message: 'Type comparison is excessively deep and possibly infinite.' } };
	}
	typeComparisonDepth++;
	try {
		return isTypeAssignableAtDepth(prefixArgumentType, argumentsType, targetType);
	}
	finally {
		typeComparisonDepth--;
	}
}

interface TypeAssignability {
	assignable: boolean | undefined;
	error?: TypeError;
}

function isTypeAssignableAtDepth(
	prefixArgumentType: CompileTimeType | undefined,
	argumentsType: CompileTimeType,
	targetType: CompileTimeType,
): TypeAssignability {
	checkerStats.getTypeError++;
	if (targetType.julType === 'any') {
		return { assignable: true };
	}
	if (argumentsType.julType === 'any') {
		// TODO error/warning bei any?
		// error type bei assignment/function call?
		// maybe return value?
		return { assignable: undefined };
	}
	if (argumentsType === targetType) {
		return { assignable: true };
	}
	// Der Alias ist reine Beschriftung: zugewiesen wird gegen den Typ dahinter, in beide Richtungen.
	// Liegt das Paar bereits auf dem Stack, gilt es als zuweisbar - bei rekursiven Typen ist das
	// die einzige Annahme, unter der der Vergleich überhaupt endet (TypeScripts "maybe stack").
	if (argumentsType.julType === 'alias'
		|| targetType.julType === 'alias') {
		// Mit einer Anwendung (Tree(T)) beteiligt ist jede Seite bei jeder Auflösung ein neues Objekt,
		// auch die Union oder das Dictionary neben ihr: dann nur strukturell wiederzuerkennen. Sonst
		// genügt die Identität, das hält die vielen gewöhnlichen Alias-Vergleiche billig.
		const involvesApplication = isAliasApplication(argumentsType) || isAliasApplication(targetType);
		if (aliasComparisonsInProgress.some(pair =>
			involvesApplication
				? typeEquals(pair.args, argumentsType) && typeEquals(pair.target, targetType)
				: pair.args === argumentsType && pair.target === targetType)) {
			return { assignable: undefined };
		}
		if (isSameAliasApplication(argumentsType, targetType)) {
			return { assignable: true };
		}
		if (!aliasComparisonsInProgress.length) {
			aliasApplicationExpansionsRemaining = maxAliasApplicationExpansions;
		}
		if (isAliasApplication(argumentsType) || isAliasApplication(targetType)) {
			// Siehe maxAliasApplicationExpansions: im Zweifel zuweisbar, wie beim Stapel.
			if (aliasApplicationExpansionsRemaining <= 0) {
				return { assignable: undefined };
			}
			aliasApplicationExpansionsRemaining--;
		}
		aliasComparisonsInProgress.push({ args: argumentsType, target: targetType });
		try {
			return isTypeAssignable(
				prefixArgumentType,
				argumentsType.julType === 'alias' ? dereferenceAlias(argumentsType) : argumentsType,
				targetType.julType === 'alias' ? dereferenceAlias(targetType) : targetType);
		}
		finally {
			aliasComparisonsInProgress.pop();
		}
	}
	// Ganze Zahlen zwischen zwei Grenzen passen genau dann, wenn beide Grenzen im target liegen.
	// Die Zerlegung unten geht über Or(T B) und verlangt dort einen einzelnen passenden Choice, das
	// scheitert schon an And(Integer Not(GreaterInteger(2))) gegen Not(GreaterInteger(3)).
	// Passt es nicht, liefert die Zerlegung die genauere Meldung, etwa gegen welchen Teil des targets.
	const fitsRange = integerRangeFits(argumentsType, targetType);
	if (fitsRange === true) {
		return { assignable: true };
	}
	if (fitsRange === false) {
		return isTypeAssignableByStructure(prefixArgumentType, argumentsType, targetType)
			?? {
			assignable: false,
			error: {
				message: `Can not assign ${typeToString(argumentsType, 0, 0)} to ${typeToString(targetType, 0, 0)}.`,
			},
		};
	}
	return isTypeAssignableByStructure(prefixArgumentType, argumentsType, targetType);
}

/**
 * Liegen die ganzen Zahlen des Werts sicher im target (true) oder sicher nicht (false)?
 * undefined, wenn einer der beiden Typen sich nicht als Integer-Bereich lesen lässt.
 */
function integerRangeFits(argumentsType: CompileTimeType, targetType: CompileTimeType): boolean | undefined {
	const argumentsRange = getIntegerRange(argumentsType);
	if (!argumentsRange?.isInteger) {
		return undefined;
	}
	const targetRange = getIntegerRange(targetType);
	if (!targetRange) {
		return undefined;
	}
	const { min, max } = argumentsRange;
	const isEmpty = min !== undefined
		&& max !== undefined
		&& min > max;
	const fitsMin = targetRange.min === undefined
		|| (min !== undefined && min >= targetRange.min);
	const fitsMax = targetRange.max === undefined
		|| (max !== undefined && max <= targetRange.max);
	return isEmpty || (fitsMin && fitsMax);
}

function isTypeAssignableByStructure(
	prefixArgumentType: CompileTimeType | undefined,
	argumentsType: Exclude<ResolvedType, { julType: 'any'; }>,
	targetType: Exclude<ResolvedType, { julType: 'any'; }>,
): TypeAssignability {
	switch (argumentsType.julType) {
		case 'and': {
			if (targetType.julType === 'and') {
				// Erst das target zerlegen, das ist exakt: der Wert muss zu jedem target Choice
				// passen. Sonst müsste ein einzelner args Choice für das ganze target reichen,
				// was z.B. And(Integer Or(1 §a§)) gegen And(Integer Not(0)) fälschlich ablehnt.
				break;
			}
			// Ein Not-Choice sagt als Quelle nichts Verlässliches (siehe case 'not'), passt also
			// fast immer und darf deshalb nicht als "passender Choice" zählen. Stattdessen exakt:
			// And(A Not(B)) liegt in T genau dann, wenn A in Or(T B) liegt.
			const complementChoices = argumentsType.ChoiceTypes.filter(choiceType =>
				isComplementType(resolveAlias(choiceType)));
			if (complementChoices.length
				&& complementChoices.length < argumentsType.ChoiceTypes.length) {
				const otherChoices = argumentsType.ChoiceTypes.filter(choiceType =>
					!complementChoices.includes(choiceType));
				const widenedTarget = createNormalizedUnionType([
					targetType,
					...complementChoices.map(choiceType =>
						(resolveAlias(choiceType) as CompileTimeComplementType).SourceType),
				]);
				const remainingType = otherChoices.length === 1
					? otherChoices[0]!
					: createCompileTimeIntersectionType(otherChoices);
				if (getTypeError(prefixArgumentType, remainingType, widenedTarget)) {
					return {
						assignable: false,
						error: {
							message: `Can not assign ${typeToString(argumentsType, 0, 0)} to ${typeToString(targetType, 0, 0)}.`,
						}
					};
				}
				return { assignable: undefined };
			}
			// Es genügt, wenn ein args Choice zum target passt, denn der Wert erfüllt alle.
			const subErrors = argumentsType.ChoiceTypes.map(choiceType =>
				getTypeError(prefixArgumentType, choiceType, targetType));
			if (subErrors.every(isDefined)) {
				// Kein einzelner choice reicht. Die Schnittmenge kann trotzdem passen, sichtbar
				// wird das aber erst nach dem Auflösen: And(value Not(Empty)) mit
				// value: Or([] Integer) ist Integer, kein einzelner choice sagt das.
				const dereferencedArgumentsType = resolvePlaceholders(argumentsType);
				if (dereferencedArgumentsType !== argumentsType) {
					return isTypeAssignable(prefixArgumentType, dereferencedArgumentsType, targetType);
				}
				// Bleibt auch nach dem Auflösen nichts übrig: das target selbst kann sich noch
				// zerlegen lassen (z.B. Or): And(Integer Not(0)) passt als GANZES zu
				// Or([] And(Integer Not(0))), obwohl weder Integer noch Not(0) allein passt.
				if (targetType.julType === 'or') {
					break;
				}
				// Choices, die sich zum selben Typ auflösen, liefern dieselbe Meldung
				const uniqueMessages = [...new Set(subErrors.map(typeErrorToString))];
				return {
					assignable: false,
					error: {
						// TODO error struktur überdenken
						message: uniqueMessages.join('\n'),
						// innerError
					}
				};
			}
			return { assignable: undefined };
		}
		case 'add':
		case 'concat': {
			// Wie withElementAt: eine noch unaufgelöste Source (z.B. der eigene Parameter, bevor
			// er am Aufruf substituiert wird) hält den Knoten als Concat(...) stehen
			// (concatFromTypes: isUnresolvedPlaceholderType-Guard). Erst per resolvePlaceholders
			// neu falten versuchen, sonst permissiv wie nestedReference - als Zieltyp ist concat
			// schon permissiv (siehe unten), als Argumenttyp fehlte das.
			const resolved = resolvePlaceholders(argumentsType);
			if (resolved !== argumentsType) {
				return isTypeAssignable(prefixArgumentType, resolved, targetType);
			}
			return { assignable: undefined };
		}
		case 'lengthOf': {
			// Source ist nur dann garantiert schon der reine list-Zweig (nie Empty), wenn
			// getLengthFromType sie bereits aufgesplittet hat. Bei einer hier noch unaufgelösten
			// Source (z.B. parameterReference, weil argsType bewusst ungeprüft bleibt, siehe
			// Aufrufer) gilt das nicht automatisch - erst auflösen und ggf. neu aufsplitten,
			// bevor PositiveInteger unterstellt wird.
			const dereferencedSource = resolvePlaceholders(argumentsType.Source);
			if (dereferencedSource !== argumentsType.Source) {
				const dereferencedLength = getLengthFromType(dereferencedSource);
				if (!typeEquals(dereferencedLength, argumentsType)) {
					return isTypeAssignable(prefixArgumentType, dereferencedLength, targetType);
				}
			}
			return isTypeAssignable(prefixArgumentType, CompileTimePositiveInteger, targetType);
		}
		case 'nestedReference': {
			// Wie concat/withElementAt: erst auflösen versuchen, sonst permissiv.
			const resolved = resolvePlaceholders(argumentsType);
			if (resolved !== argumentsType) {
				return isTypeAssignable(prefixArgumentType, resolved, targetType);
			}
			return { assignable: undefined };
		}
		case 'not': {
			// Not(X) heißt "alles außer X" - das ist nur dann unzulässig, wenn das target
			// ausschließlich X-Werte zulässt (target Teilmenge von X), der Wert also garantiert
			// ausgeschlossen wäre. Sonst permissiv, wie bei Any: wir wissen nichts Genaueres.
			// isNotAssignableTo trägt den hasReliableTypeError-Guard schon (undefined bei
			// unaufgelösten/generischen Zielen), das wird hier mitgenutzt statt dupliziert.
			// Gegen ein Not als target geht es exakt: Not(A) liegt genau dann in Not(B), wenn B in A
			// liegt. Not(GreaterInteger(3)) passt also nicht zu Not(GreaterInteger(2)), denn 3 wäre ausgeschlossen.
			if (targetType.julType === 'not'
				&& isNotAssignableTo(targetType.SourceType, argumentsType.SourceType) === true) {
				return {
					assignable: false,
					error: {
						message: `Can not assign ${typeToString(argumentsType, 0, 0)} to ${typeToString(targetType, 0, 0)}.`,
					}
				};
			}
			if (isNotAssignableTo(targetType, argumentsType.SourceType) === false) {
				return {
					assignable: false,
					error: {
						message: `Can not assign ${typeToString(argumentsType, 0, 0)} to ${typeToString(targetType, 0, 0)}.`,
					}
				};
			}
			return { assignable: undefined };
		}
		case 'or': {
			// alle args Choices müssen zum target passen
			const subErrors = argumentsType.ChoiceTypes.map(choiceType =>
				getTypeError(prefixArgumentType, choiceType, targetType)).filter(isDefined);
			if (subErrors.length) {
				return {
					assignable: false,
					error: {
						// TODO error struktur überdenken
						message: subErrors.map(typeErrorToString).join('\n'),
						// innerError
					}
				};
			}
			return { assignable: undefined };
		}
		case 'parameterReference': {
			const dereferencedParameterType = dereferenceParameterTypeFromFunctionRef(argumentsType);
			if (!dereferencedParameterType) {
				return { assignable: undefined };
			}
			return isTypeAssignable(prefixArgumentType, dereferencedParameterType, targetType);
		}
		case 'predicate':
			switch (targetType.julType) {
				// Diese Ziele werden erst zerlegt, damit ein gleiches Prädikat darin gefunden wird.
				case 'and':
				case 'not':
				case 'or':
				case 'predicate':
					break;
				// Ein Wert, der das Prädikat erfüllt, liegt in der Obermenge.
				default:
					return isTypeAssignable(prefixArgumentType, argumentsType.UpperBound, targetType);
			}
			break;
		case 'mapElements': {
			// Wie concat/withElementAt: solange die Anzahl noch offen ist, bleibt der Knoten
			// stehen - erst neu falten versuchen, sonst permissiv.
			const resolved = resolvePlaceholders(argumentsType);
			if (resolved !== argumentsType) {
				return isTypeAssignable(prefixArgumentType, resolved, targetType);
			}
			return { assignable: undefined };
		}
		case 'conditional': {
			// Wie withElementAt: erst auswerten versuchen, sonst permissiv.
			const resolved = resolvePlaceholders(argumentsType);
			if (resolved !== argumentsType) {
				return isTypeAssignable(prefixArgumentType, resolved, targetType);
			}
			return { assignable: undefined };
		}
		case 'withElementAt': {
			// Steht die Position (noch) nicht fest, bleibt setElement als WithElementAt(...)
			// stehen (withElementAtFromTypes: Platzhalter bleibt ungefaltet, bis Source/Index
			// feststehen) - das ist kein falscher Wert, sondern einer, der es noch werden kann.
			// Erst per resolvePlaceholders neu falten versuchen (Source/Index könnten seither
			// aufgelöst sein), sonst permissiv wie nestedReference/parameterReference: als
			// Zieltyp ist withElementAt schon permissiv (siehe unten), als Argumenttyp fehlte das.
			const resolved = resolvePlaceholders(argumentsType);
			if (resolved !== argumentsType) {
				return isTypeAssignable(prefixArgumentType, resolved, targetType);
			}
			return { assignable: undefined };
		}
		default:
			break;
	}
	// TODO generic types (customType, union/intersection, ...?)
	switch (targetType.julType) {
		case 'and': {
			// das arg muss zu allen target Choices passen
			const subErrors = targetType.ChoiceTypes.map(choiceType =>
				getTypeError(prefixArgumentType, argumentsType, choiceType)).filter(isDefined);
			if (subErrors.length) {
				return {
					assignable: false,
					error: {
						// TODO error struktur überdenken
						message: subErrors.map(typeErrorToString).join('\n'),
						// innerError
					}
				};
			}
			return { assignable: undefined };
		}
		case 'blob':
			break;
		case 'boolean':
			switch (argumentsType.julType) {
				case 'boolean':
					return { assignable: true };
				case 'booleanLiteral':
					return { assignable: true };
				default:
					break;
			}
			break;
		case 'booleanLiteral':
			if (typeEquals(argumentsType, targetType)) {
				return { assignable: undefined };
			}
			break;
		case 'date':
			break;
		case 'dictionary': {
			const elementType = targetType.ElementType;
			switch (argumentsType.julType) {
				case 'dictionary': {
					const subError = isTypeAssignable(prefixArgumentType, argumentsType.ElementType, elementType);
					return subError;
				}
				case 'dictionaryLiteral': {
					// TODO getDictionaryFieldError mit TypeAssignabilty
					const subErrors = map(
						argumentsType.Fields,
						(fieldType, fieldName) => {
							// TODO the field x is missing error?
							return getDictionaryFieldError(fieldName, elementType, prefixArgumentType, fieldType);
						},
					).filter(isDefined);
					if (!subErrors.length) {
						return { assignable: undefined };
					}
					return {
						assignable: false,
						error: {
							// TODO error struktur überdenken
							message: subErrors.map(typeErrorToString).join('\n'),
							// innerError
						}
					};
				}
				default:
					// TODO type specific error?
					break;
			}
			break;
		}
		case 'dictionaryLiteral': {
			// TODO getDictionaryFieldError mit TypeAssignabilty
			const error = getDictionaryLiteralTypeError(prefixArgumentType, argumentsType, targetType.Fields);
			if (error === true) {
				// Standardfehler
				break;
			}
			if (!error) {
				return { assignable: undefined };
			}
			// targetType mit depth=1, damit z.B. GameBoard als kurzer Alias erscheint statt
			// voll ausgeschrieben (typeToString zeigt Aliase nur ab depth>0). argumentsType
			// dagegen mit suppressAlias=true: sein aliasName ist der Name der Definition, die
			// den Wert hält (z.B. "newGameState"), kein Typname - der würde hier fälschlich
			// als Typ erscheinen, auch bei verschachtelten Feldern (Fund newBoard, s.o.).
			// Würde diese Kopfzeile selbst mehrzeilig rendern (z.B. weil ein Feld einen
			// größeren verschachtelten Typ enthält), trägt sie neben der folgenden
			// "Invalid value for field"-Kette nichts bei und lenkt vom eigentlichen Fehler ab
			// (Fund im echten yugioh-Fehlerbild, Session 2026-09-10) - dann fällt sie ganz weg.
			// Entscheidung anhand des tatsächlich gerenderten Textes, bevor er mit dem Detail
			// verklebt wird, statt den fertigen String später wieder aufzutrennen.
			const header = `Can not assign ${typeToString(argumentsType, 0, 0, true)} to ${typeToString(targetType, 0, 1)}.`;
			if (header.includes('\n')) {
				return {
					assignable: false,
					error: error,
				};
			}
			return {
				assignable: false,
				error: {
					message: `${header}\n${indentLines(error.message)}`,
				}
			};
		}
		case 'empty':
			if (argumentsType.julType === 'empty') {
				return { assignable: true };
			}
			break;
		case 'error':
			break;
		case 'float':
			switch (argumentsType.julType) {
				case 'float':
					return { assignable: true };
				case 'floatLiteral':
					return { assignable: true };
				case 'bound':
					if (argumentsType.Family === 'float') {
						return { assignable: true };
					}
					break;
				default:
					break;
			}
			break;
		case 'floatLiteral':
			if (typeEquals(argumentsType, targetType)) {
				return { assignable: true };
			}
			break;
		case 'function': {
			// TODO types als function interpretieren?
			if (!isFunctionType(argumentsType)) {
				break;
			}
			// Kontravarianz: Funktionstyp-Subtyping dreht die Richtung bei Parametern um.
			// - Parameter: targetType.ParamsType muss Teilmenge von argumentsType.ParamsType sein.
			//   Die übergebene Funktion muss also alles annehmen, was die Zielposition ihr
			//   übergibt. Wer weniger fordert, ist überall einsetzbar; wer mehr fordert, bekommt
			//   Werte, die er laut eigener Deklaration ablehnt.
			// - Return-Type: Normale Richtung (Kovarianz).
			//   argumentsType.ReturnType muss Teilmenge von targetType.ReturnType sein,
			//   weil der Rückgabewert das erfüllen muss, was die Zielposition erwartet.
			const paramsAssignability = isTypeAssignable(prefixArgumentType, targetType.ParamsType, argumentsType.ParamsType);
			if (paramsAssignability.assignable === false) {
				return paramsAssignability;
			}
			const returnAssignability = isTypeAssignable(prefixArgumentType, argumentsType.ReturnType, targetType.ReturnType);
			if (returnAssignability.error) {
				// Ohne Beschriftung liesse sich nicht erkennen, dass die Meldung den Rückgabewert
				// betrifft, statt z.B. einen weiteren Parameter (siehe getParameterError).
				return {
					assignable: false,
					error: {
						message: `Invalid return value\n${indentLines(typeErrorToString(returnAssignability.error))}`,
					}
				};
			}
			if (paramsAssignability.assignable === undefined
				|| returnAssignability.assignable === undefined) {
				return { assignable: undefined };
			}
			return { assignable: true };
		}
		// Ganzzahlige Grenzen hat integerRangeFits schon entschieden, hier bleiben die übrigen Familien.
		case 'bound': {
			const boundValue = targetType.Value;
			const literalFamily = targetType.Family === 'integer' ? 'integerLiteral' : 'floatLiteral';
			if (boundValue.julType !== literalFamily) {
				break;
			}
			if (argumentsType.julType === literalFamily
				&& (targetType.Relation === 'greater'
					? argumentsType.value > boundValue.value
					: argumentsType.value < boundValue.value)) {
				return { assignable: true };
			}
			// GreaterFloat(a) liegt in GreaterFloat(b), wenn a >= b, LessFloat umgekehrt.
			if (argumentsType.julType === 'bound'
				&& argumentsType.Relation === targetType.Relation
				&& argumentsType.Family === targetType.Family) {
				const argumentValue = argumentsType.Value;
				if (argumentValue.julType === literalFamily
					&& (targetType.Relation === 'greater'
						? argumentValue.value >= boundValue.value
						: argumentValue.value <= boundValue.value)) {
					return { assignable: true };
				}
			}
			break;
		}
		case 'integer':
			switch (argumentsType.julType) {
				case 'integer':
					return { assignable: true };
				case 'integerLiteral':
					return { assignable: true };
				case 'bound':
					if (argumentsType.Family === 'integer') {
						return { assignable: true };
					}
					break;
				default:
					break;
			}
			break;
		case 'integerLiteral':
			if (typeEquals(argumentsType, targetType)) {
				return { assignable: true };
			}
			break;
		case 'list': {
			const targetElementType = targetType.ElementType;
			switch (argumentsType.julType) {
				case 'list': {
					const elementAssignability = isTypeAssignable(prefixArgumentType, argumentsType.ElementType, targetElementType);
					if (!elementAssignability.error) {
						return elementAssignability;
					}
					// Ohne Hülle stand der Element-Fehler roh neben anderen Or-Choice-Fehlern,
					// ohne erkennbaren Bezug zur umschliessenden Liste (Fund im echten
					// yugioh-Fehlerbild, Session 2026-09-10) - analog zum dictionaryLiteral-Fall.
					return {
						assignable: false,
						error: {
							message: `Can not assign ${typeToString(argumentsType, 0, 0, true)} to ${typeToString(targetType, 0, 1)}.\n${indentLines(elementAssignability.error.message)}`,
						}
					};
				}
				case 'tuple': {
					const elementAssignabilities = argumentsType.ElementTypes.map(valueElement =>
						isTypeAssignable(prefixArgumentType, valueElement, targetElementType));
					return joinTypeAssignabilities(elementAssignabilities);
				}
				default:
					break;
			}
			break;
		}
		case 'nestedReference':
			// TODO?
			return { assignable: undefined };
		case 'never':
			break;
		case 'not': {
			// TODO types overlap dreiwertig mit unbekannt wert
			// Der Wert darf den SourceType nicht überlappen. Zuweisbarkeit genügt hier nicht:
			// Integer ist keine Teilmenge von 0, enthält 0 aber und ist damit unzulässig.
			// Bei unbekannter Überlappung wird nichts gemeldet.
			if (typesOverlap(argumentsType, targetType.SourceType)) {
				return {
					assignable: false,
					error: {
						message: `Can not assign ${typeToString(argumentsType, 0, 0)} to ${typeToString(targetType, 0, 0)}.`,
					}
				};
			}
			return { assignable: undefined };
		}
		case 'or': {
			// TODO subErrors stattdessen mit 3wertiger Assignability
			// das arg muss zu mindestens einem target Choice passen
			const subErrors = targetType.ChoiceTypes.map(choiceType =>
				getTypeError(prefixArgumentType, argumentsType, choiceType));
			if (subErrors.every(isDefined)) {
				if (argumentsType.julType === 'boolean') {
					// Boolean passt zu keinem einzelnen Choice, kann aber trotzdem vollständig
					// abgedeckt sein, wenn die Choices zusammen sowohl true als auch false
					// treffen (z.B. Or(true false)) - Boolean hat nur diese zwei bewohnten
					// Werte. Bewusst nur hier und nicht generell für 'boolean' als
					// argumentsType, damit der sehr viel häufigere Fall Boolean-gegen-Boolean/
					// Any keinen zusätzlichen Aufwand bekommt.
					const asLiteralUnion = createCompileTimeUnionType([
						createBooleanLiteral(true),
						createBooleanLiteral(false),
					]);
					return isTypeAssignable(prefixArgumentType, asLiteralUnion, targetType);
				}
				// Best-Match statt Alle-Choices-Dump (TS/Flow-Vorbild, Fund im echten
				// yugioh-Fehlerbild, Session 2026-09-10): nur den strukturell nächsten Choice
				// (gleicher julType wie der Wert) vertiefen, statt jeden fehlgeschlagenen
				// Choice einzeln zu zeigen - sonst stehen triviale Fehler ("List ist kein
				// Empty") gleichberechtigt neben dem eigentlich relevanten. Der volle
				// Or-Zieltyp bleibt im Kopf sichtbar, damit die anderen Choices nicht aus der
				// Meldung verschwinden. Fallback (kein eindeutiger Kandidat): wie bisher alle
				// Choice-Fehler einzeln zeigen.
				const closestIndexes = targetType.ChoiceTypes
					.map((choiceType, index) => choiceType.julType === argumentsType.julType ? index : -1)
					.filter(index => index !== -1);
				if (closestIndexes.length === 1) {
					const closestError = subErrors[closestIndexes[0]!]!;
					return {
						assignable: false,
						error: {
							message: `Can not assign ${typeToString(argumentsType, 0, 0, true)} to ${typeToString(targetType, 0, 1)}.\n${indentLines(typeErrorToString(closestError))}`,
						}
					};
				}
				return {
					assignable: false,
					error: {
						// TODO error struktur überdenken
						message: subErrors.map(typeErrorToString).join('\n'),
						// innerError
					}
				};
			}
			return { assignable: undefined };
		}
		case 'parameters':
			// TODO getTypeErrorForParameters stattdessen mit 3wertiger assignability
			return isTypeAssignableForParameters(prefixArgumentType, argumentsType, targetType);
		case 'parameterReference': {
			// TODO
			// const dereferenced = dereferenceArgumentType(null as any, targetType);
			// return getTypeError(valueType, dereferenced ?? builtinAny);
			return { assignable: undefined };
		}
		case 'stream': {
			if (!isStreamType(argumentsType)) {
				break;
			}
			// FiniteStream fordert mehr als Stream: ein Stream ohne Zusage passt nicht.
			if (targetType.finite && !argumentsType.finite) {
				break;
			}
			return isTypeAssignable(prefixArgumentType, argumentsType.ValueType, targetType.ValueType);
		}
		case 'text':
			switch (argumentsType.julType) {
				case 'text':
					return { assignable: true };
				case 'textLiteral':
					return { assignable: true };
				default:
					break;
			}
			break;
		case 'textLiteral': {
			if (typeEquals(argumentsType, targetType)) {
				return { assignable: true };
			}
			break;
		}
		case 'tuple':
			return isTypeAssignableForTuple(prefixArgumentType, argumentsType, targetType);
		case 'type':
			switch (argumentsType.julType) {
				case 'boolean':
				case 'booleanLiteral':
				case 'bound':
				case 'empty':
				case 'float':
				case 'floatLiteral':
				case 'integer':
				case 'integerLiteral':
				case 'text':
				case 'textLiteral':
				case 'type':
				case 'typeOf':
					return { assignable: true };
				case 'function':
					// TODO getPredicateFunctionError stattdessen mit 3wertiger assignability
					return getPredicateFunctionError(argumentsType);
				// Ein Wert, der das Prädikat erfüllt, ist ein Typ, wenn seine Obermenge aus
				// Typen besteht.
				case 'predicate':
					return isTypeAssignable(prefixArgumentType, argumentsType.UpperBound, targetType);
				case 'tuple': {
					// alle ElementTypes müssen Typen sein
					const subErrors = argumentsType.ElementTypes.map(elementType =>
						getTypeError(undefined, elementType, targetType)).filter(isDefined);
					if (subErrors.length) {
						return {
							assignable: false,
							error: {
								// TODO error struktur überdenken
								message: subErrors.map(typeErrorToString).join('\n'),
								// innerError
							}
						};
					}
					return undefined;
				}
				// TODO check inner types rekursiv
				case 'dictionary':
				case 'dictionaryLiteral':
				case 'list':
					return undefined;
				default:
					// TODO type specific error?
					break;
			}
			break;
		// TODO
		case 'typeOf':
			break;
		case 'lengthOf':
			// In der Oberfläche nicht konstruierbar, nur zur Vollständigkeit des Switches.
			return isTypeAssignable(prefixArgumentType, argumentsType, CompileTimePositiveInteger);
		case 'conditional':
			// Wartet noch auf seine Operanden: permissiv wie withElementAt.
			return { assignable: undefined };
		case 'withElementAt':
			// Noch ungefalteter Platzhalter als Ziel: permissiv wie nestedReference, sonst
			// entstünden Fehler an einem Typ, der noch gar nicht feststeht.
			return { assignable: undefined };
		case 'indexRange':
			// Nur als Schlüssel sinnvoll, nie als Zieltyp einer Zuweisung.
			return { assignable: undefined };
		case 'mapElements':
			// Noch ungefalteter Platzhalter als Ziel: permissiv wie nestedReference.
			return { assignable: undefined };
		case 'concat':
			// Ungefaltete Konkatenation: permissiv wie nestedReference.
			return { assignable: undefined };
		case 'add':
			// Ungefaltete Summe: permissiv wie concat.
			return { assignable: undefined };
		case 'predicate': {
			if (argumentsType.julType === 'predicate'
				&& isSamePredicate(argumentsType, targetType)) {
				return { assignable: true };
			}
			const folded = tryFoldPredicate(targetType, argumentsType);
			if (folded !== undefined) {
				if (folded) {
					return { assignable: true };
				}
				break;
			}
			// Was das Prädikat für einen Wert in der Obermenge liefert, weiß der Checker nicht.
			// Das prüft die Laufzeit.
			if (isTypeAssignable(prefixArgumentType, argumentsType, targetType.UpperBound)) {
				break;
			}
			return { assignable: undefined };
		}
		default: {
			const assertNever: never = targetType;
			throw new Error(`Unexpected targetType.type: ${(assertNever as CompileTimeType).julType}`);
		}
	}
	return getDefaultTypeError(argumentsType, targetType);
}

function getDefaultTypeError(argumentsType: CompileTimeType, targetType: CompileTimeType) {
	return {
		assignable: false,
		error: { message: `Can not assign ${typeToString(argumentsType, 0, 0)} to ${typeToString(targetType, 0, 0)}.` },
	}
}

/**
 * Jede Funktion ist als Typ zulässig, die true liefern kann und rein ist: Identität und Faltung
 * setzen voraus, dass sie für denselben Wert immer dasselbe liefert. Unbekannte Reinheit ist
 * keine Ablehnung, gefaltet wird dann nur nicht.
 */
function getPredicateFunctionError(functionType: CompileTimeFunctionType): TypeError | undefined {
	if (functionType.purity === 'impure') {
		return { message: 'A predicate used as a type must be pure.' };
	}
	if (getTypeError(undefined, createBooleanLiteral(true), resolvePlaceholders(functionType.ReturnType))) {
		return { message: 'A predicate used as a type must be able to return true.' };
	}
	return undefined;
}

/**
 * Liefert das Prädikat für diesen konstanten Wert true? undefined, wenn es sich nicht ausrechnen
 * lässt: der Wert ist nicht konstant, die Funktion nicht rein oder nicht faltbar, oder das Budget
 * ist erschöpft. Ausgewertet wird nach derselben Regel wie zur Laufzeit.
 */
function tryFoldPredicate(predicate: CompileTimePredicateType, argumentsType: CompileTimeType): boolean | undefined {
	const functionType = predicate.FunctionType;
	if (functionType.purity !== 'pure') {
		return undefined;
	}
	const value = typeToConstantValue(argumentsType);
	if (!value) {
		return undefined;
	}
	const callable = tryBuildCallable(functionType);
	if (!callable) {
		return undefined;
	}
	checkerStats.foldableCall++;
	try {
		return runtime._isOfType(value.value, callable as Parameters<typeof runtime._isOfType>[1]);
	}
	catch {
		return undefined;
	}
}

function isTypeAssignableForTuple(
	prefixArgumentType: CompileTimeType | undefined,
	argumentsType: CompileTimeType,
	targetType: CompileTimeTupleType,
): TypeAssignability {
	const targetElementTypes = targetType.ElementTypes;
	switch (argumentsType.julType) {
		case 'list':
			if (targetElementTypes.length > 1) {
				return {
					assignable: false,
					error: {
						message: `Expected ${targetElementTypes.length} elements, but List may contain less.`,
					}
				};
			}
			return isTypeAssignable(prefixArgumentType, argumentsType.ElementType, targetElementTypes[0]!);
		case 'tuple':
			return isTypeAssignableForTuple2(prefixArgumentType, argumentsType.ElementTypes, targetElementTypes);
		case 'parameters':
			// Gegenstück zu getTypeErrorForParameters' case 'tuple': dort darf ein unbenanntes
			// Tuple-Pattern (`[Integer] => ...`) als Argument gegen einen benannten Parametertyp
			// bestehen, hier ist es umgekehrt - ein benannter Parametertyp (z.B. filter's
			// deklarierter predicate-Typ) tritt kontravariant als "argumentsType" gegen ein
			// unbenanntes Tuple-Ziel an (z.B. ein als Prädikat übergebenes `[Integer] => true`).
			// TODO argumentsType.rest berücksichtigen - kein aktueller Fall deklariert einen
			// Rest-Parameter an dieser Stelle.
			return isTypeAssignableForTuple2(
				prefixArgumentType,
				argumentsType.singleNames.map(param => param.type ?? builtinAny),
				targetElementTypes,
			);
		default:
			return getDefaultTypeError(argumentsType, targetType);
	}
}

function isTypeAssignableForTuple2(
	prefixArgumentType: CompileTimeType | undefined,
	argumentElementTypes: CompileTimeType[],
	targetElementTypes: CompileTimeType[],
): TypeAssignability {
	// TODO fehler wenn argument mehr elemente entfält als target?
	const elementAssignabilities = targetElementTypes.map((targetElementType, index) => {
		const valueElement = argumentElementTypes[index] ?? builtinEmpty;
		return isTypeAssignable(prefixArgumentType, valueElement, targetElementType);
	});
	return joinTypeAssignabilities(elementAssignabilities);
}

/**
 * joined assignable :=
 * false, wenn mindestens 1 false
 * undefined, wenn kein false und mindestens 1 undefined
 * true, wenn alle true
 */
function joinTypeAssignabilities(typeAssignabilities: TypeAssignability[]): TypeAssignability {
	const errors = typeAssignabilities.map(elementAssignability => elementAssignability.error).filter(isDefined);
	if (errors.length) {
		const uniqueMessages = [...new Set(errors.map(typeErrorToString))];
		return {
			assignable: false,
			error: {
				// TODO error struktur überdenken
				message: uniqueMessages.join('\n'),
				// innerError
			}
		};
	}
	const hasUnkownAssignability = typeAssignabilities.some(typeAssignability => typeAssignability.assignable === undefined);
	if (hasUnkownAssignability) {
		return { assignable: undefined };
	}
	else {
		return { assignable: true };
	}
}

/**
 * Liefert true bei Standardfehler, undefined bei keinem Fehler.
 */
function getDictionaryLiteralTypeError(
	prefixArgumentType: CompileTimeType | undefined,
	argumentsType: CompileTimeType,
	targetFieldTypes: CompileTimeDictionary,
): TypeError | true | undefined {
	switch (argumentsType.julType) {
		case 'dictionaryLiteral': {
			// Für ein fehlendes Feld gibt es keinen Wert zum Vergleichen - der erwartete Typ
			// steht bereits an der Zieltyp-Deklaration selbst, ihn hier zusätzlich auszuschreiben
			// ist reine Wiederholung (TypeScript/Rust/Elm/GHC tun das ebenfalls nicht). Fehlende
			// Feldnamen werden deshalb gesammelt und zu einer Zeile zusammengefasst, statt je
			// Feld eine eigene "Missing field X, expected Y."-Zeile zu erzeugen.
			const missingFieldNames: string[] = [];
			const fieldValueErrors = map(
				targetFieldTypes,
				(fieldType, fieldName) => {
					const knownField = argumentsType.Fields[fieldName];
					if (knownField === undefined) {
						if (!argumentsType.complete) {
							// Unwissen ist keine Ablehnung: taucht das Feld in einem
							// unvollständigen Dictionary nicht auf, ist das kein Beweis, dass
							// es fehlt.
							return undefined;
						}
						if (isFieldOptional(fieldType, prefixArgumentType)) {
							// Or([] X) ist das Idiom für optionale Felder - Weglassen bleibt erlaubt.
							return undefined;
						}
						missingFieldNames.push(fieldName);
						return undefined;
					}
					return getDictionaryFieldError(fieldName, fieldType, prefixArgumentType, knownField);
				},
			).filter(isDefined);
			const missingFieldsError: TypeError | undefined = missingFieldNames.length
				? {
					message: missingFieldNames.length === 1
						? `Missing field '${missingFieldNames[0]}'.`
						: `Missing fields: ${missingFieldNames.map(fieldName => `'${fieldName}'`).join(', ')}.`,
				}
				: undefined;
			const subErrors = missingFieldsError ? [missingFieldsError, ...fieldValueErrors] : fieldValueErrors;
			if (subErrors.length) {
				return {
					// TODO error struktur überdenken
					message: subErrors.map(typeErrorToString).join('\n'),
					// innerError
				};
			}
			return undefined;
		}
		default:
			// TODO type specific error?
			return true;
	}
}

function getDictionaryFieldError(
	fieldName: string,
	fieldTargetType: CompileTimeType,
	prefixArgumentType: CompileTimeType | undefined,
	fieldValueType: CompileTimeType,
): TypeError | undefined {
	const subError = getTypeError(prefixArgumentType, fieldValueType, fieldTargetType);
	if (subError) {
		// Feldname steht VOR der Erklärung, die er einleitet (TypeScript-Vorbild), nicht danach -
		// sonst müsste man beim Lesen den Feldnamen im Kopf der richtigen Ebene der Typ-Kette
		// zuordnen statt ihn direkt an der Stelle zu lesen, wo er hingehört. Eine Ebene tiefer
		// eingerückt, damit die Verschachtelungstiefe auch bei 3+ Ebenen sichtbar bleibt.
		return {
			message: `Invalid value for field '${fieldName}'\n${indentLines(typeErrorToString(subError))}`,
		};
	}
	return subError;
}

/**
 * Pendant zu getDictionaryFieldError für positionale Funktionsargumente: ohne den Parameternamen
 * ist bei mehreren Argumenten/Überladungen nicht erkennbar, welches Argument betroffen ist
 * (Fund: JUL5050 nannte nur den Typkonflikt, nie die Parameterposition).
 */
function getParameterError(
	parameterName: string,
	parameterTargetType: CompileTimeType,
	argumentType: CompileTimeType,
	/**
	 * 'type' beim kontravarianten Vergleich zweier Funktionstypen: dort steht die deklarierte
	 * Signatur zur Prüfung, kein Wert, der an den Parameter übergeben wird.
	 */
	subject: 'value' | 'type' = 'value',
): TypeError | undefined {
	const subError = getTypeError(undefined, argumentType, parameterTargetType);
	if (subError) {
		return {
			message: `Invalid ${subject} for parameter '${parameterName}'\n${indentLines(typeErrorToString(subError))}`,
		};
	}
	return subError;
}

/**
 * Darf ein Feld dieses Zieltyps im Literal fehlen? Or([] X) ist das Idiom für optionale Felder
 * (CLAUDE.md) - Empty erfüllt das Ziel dann bereits, ohne dass es explizit als `feld = []`
 * dastehen muss.
 */
function isFieldOptional(fieldTargetType: CompileTimeType, prefixArgumentType: CompileTimeType | undefined): boolean {
	return !getTypeError(prefixArgumentType, builtinEmpty, fieldTargetType);
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
	// Zuerst ungelöst, wie die Prüfung des Aufrufs selbst (areArgsAssignableTo bekommt argsType
	// bewusst ungelöst) - sonst findet die Suche den Fehler nicht wieder, den sie erklären soll.
	return !!getTypeError(undefined, ownType, expectedType)
		|| !!getTypeError(undefined, resolvePlaceholders(ownType), resolvePlaceholders(expectedType));
}


function isTypeAssignableForParameters(
	prefixArgumentType: CompileTimeType | undefined,
	argumentsType: CompileTimeType,
	targetType: ParametersType,
): TypeAssignability {
	// TODO other cases
	switch (argumentsType.julType) {
		case 'dictionaryLiteral':
			return getTypeErrorForParametersWithCollectionArgs(prefixArgumentType, argumentsType.Fields, targetType);
		case 'empty':
			return getTypeErrorForParametersWithCollectionArgs(prefixArgumentType, undefined, targetType);
		case 'tuple':
			return getTypeErrorForParametersWithCollectionArgs(prefixArgumentType, argumentsType.ElementTypes, targetType);
		case 'list': {
			// Eine Liste als Argumentliste hat unbekannte Länge (entsteht durch einen Spread, dessen
			// Quelle erst zur Laufzeit feststeht). Welche Position welchen Parameter trifft, steht
			// damit nicht fest: jeder Einzelparameter muss den Elementtyp annehmen können. Belegt
			// ist nur die erste Position - List(X) schließt das Leere aus -, jede weitere kann
			// fehlen und muss deshalb zusätzlich Empty vertragen.
			const elementType = argumentsType.ElementType;
			const optionalElementType = createNormalizedUnionType([builtinEmpty, elementType]);
			const singleNames = targetType.singleNames;
			// Ein Prefix-Argument belegt die erste Parameterposition selbst; die Liste beginnt erst
			// dahinter, die garantierte Position rückt also mit.
			const guaranteedIndex = prefixArgumentType ? 1 : 0;
			for (let index = 0; index < singleNames.length; index++) {
				const parameter = singleNames[index]!;
				const parameterType = parameter.type;
				if (!parameterType) {
					continue;
				}
				const argumentType = prefixArgumentType && !index
					? prefixArgumentType
					: index === guaranteedIndex
						? elementType
						: optionalElementType;
				const error = getParameterError(parameter.name, parameterType, argumentType);
				if (error) {
					// TODO collect inner errors
					return error;
				}
			}
			const rest = targetType.rest;
			const restType = rest?.type;
			if (restType) {
				// Übrig bleibt wieder eine Liste desselben Elementtyps - aber womöglich keine mehr,
				// sobald Einzelparameter Positionen verbraucht haben. Ein Prefix-Argument, das kein
				// Einzelparameter aufgenommen hat, landet ebenfalls im Rest und geht in den
				// Elementtyp ein.
				const restElementType = prefixArgumentType && !singleNames.length
					? createNormalizedUnionType([prefixArgumentType, elementType])
					: elementType;
				const remainingType = singleNames.length
					? createNormalizedUnionType([builtinEmpty, createCompileTimeListType(restElementType)])
					: createCompileTimeListType(restElementType);
				const error = getParameterError(rest!.name, restType, remainingType);
				if (error) {
					// TODO collect inner errors
					return error;
				}
			}
			return undefined;
		}
		case 'parameters': {
			// Parameter gegen Parameter tritt nur beim Vergleich zweier Funktionstypen auf, und
			// der ruft kontravariant auf: targetType ist die übergebene Funktion, argumentsType
			// die Signatur, die die Zielposition zusichert. Deshalb ist hier targetType das
			// "Got" und argumentsType das "expected".
			// TODO prefixArgumentType berücksichtigen?
			let index = 0;
			const targetSingleNames = targetType.singleNames;
			const valueSingleNames = argumentsType.singleNames;
			const valueRest = argumentsType.rest;
			const valueRestType = valueRest?.type;
			const valueRestItemType: CompileTimeType | undefined = valueRest
				? isListType(valueRestType)
					? valueRestType.ElementType
					: builtinAny
				: undefined;
			for (; index < targetSingleNames.length; index++) {
				const targetParameter = targetSingleNames[index]!;
				const targetParameterName = targetParameter.name;
				const targetParameterType = targetParameter.type;
				const valueParameter = valueSingleNames[index];
				if (valueParameter && valueParameter.name !== targetParameterName) {
					return {
						assignable: false,
						error: {
							message: `Parameter name mismatch. Got '${targetParameterName}' but expected '${valueParameter.name}'`,
						}
					};
				}
				const valueParameterType: CompileTimeType = valueParameter?.type ?? valueRestItemType ?? builtinAny;
				const error = targetParameterType
					? getParameterError(targetParameterName, targetParameterType, valueParameterType, 'type')
					: undefined;
				if (error) {
					// TODO collect inner errors
					return error;
				}
			}
			const targetRest = targetType.rest;
			const targetRestType = targetRest?.type;
			if (targetRestType) {
				// Gegen den Elementtyp prüfen, nicht gegen den Listentyp selbst: ein Rest-Parameter
				// `...args: List(Any)` nimmt je übrigem Parameter einen Wert vom Elementtyp
				// entgegen, nicht die ganze Liste.
				const targetRestItemType = isListType(targetRestType)
					? targetRestType.ElementType
					: builtinAny;
				const remainingValueParameters = valueSingleNames.slice(index);
				for (const valueParameter of remainingValueParameters) {
					const valueParameterType = valueParameter.type ?? valueRestItemType ?? builtinAny;
					const error = getParameterError(targetRest!.name, targetRestItemType, valueParameterType, 'type');
					if (error) {
						// TODO collect inner errors
						return error;
					}
				}
			}
			return undefined;
		}
		default:
			return {
				assignable: false,
				error: { message: 'getTypeErrorForParameters not implemented yet for ' + argumentsType.julType }
			};
	}
}

function getTypeErrorForParametersWithCollectionArgs(
	prefixArgumentType: CompileTimeType | undefined,
	argumentsType: CompileTimeCollection | undefined,
	targetType: ParametersType,
): TypeError | undefined {
	const hasPrefixArg = !!prefixArgumentType;
	const isArray = Array.isArray(argumentsType);
	let paramIndex = 0;
	let argumentIndex = 0;
	const { singleNames, rest } = targetType;
	for (; paramIndex < singleNames.length; paramIndex++) {
		const param = singleNames[paramIndex]!;
		const { name, type } = param;
		let argument: CompileTimeType;
		if (hasPrefixArg && !paramIndex) {
			argument = prefixArgumentType;
		}
		else {
			argument = (argumentsType && (isArray
				? argumentsType[argumentIndex]
				: argumentsType[name])) ?? builtinEmpty;
			argumentIndex++;
		}
		const error = type
			? getParameterError(name, type, argument)
			: undefined;
		if (error) {
			// TODO collect inner errors
			return error;
		}
	}
	if (rest) {
		const restType = rest.type;
		if (!argumentsType) {
			const remainingArgs: CompileTimeType = hasPrefixArg && !paramIndex
				? createCompileTimeTupleType([prefixArgumentType])
				: builtinEmpty;
			const error = restType
				? getParameterError(rest.name, restType, remainingArgs)
				: undefined;
			if (error) {
				return error;
			}
			return undefined;
		}
		if (isArray) {
			const remainingArgs = argumentsType.slice(argumentIndex);
			if (hasPrefixArg && !paramIndex) {
				remainingArgs.unshift(prefixArgumentType);
			}
			const error = restType
				? getParameterError(rest.name, restType, createCompileTimeTupleType(remainingArgs))
				: undefined;
			if (error) {
				// TODO collect inner errors
				return error;
			}
		}
		else {
			// TODO rest dictionary??
			return { message: 'Can not assign dictionary to rest parameter' };
		}
	}
}

interface TypeError {
	message: string;
	innerError?: TypeError;
}

function typeErrorToString(typeError: TypeError): string {
	if (typeError.innerError) {
		return typeErrorToString(typeError.innerError) + '\n' + typeError.message;
	}
	return typeError.message;
}

/**
 * Rückt jede Zeile eines mehrzeiligen Fehlertexts eine Ebene tiefer - für verschachtelte
 * Dictionary-Felder, damit die Tiefe beim Lesen sichtbar ist (TypeScript-Vorbild), statt nur
 * über die Abfolge von Typ-Mismatch/Feldname-Zeilen erschlossen werden zu müssen.
 */
function indentLines(text: string): string {
	return text.split('\n').map(line => `${indentUnit}${line}`).join('\n');
}

//#endregion TypeAssignability

//#region ToString

// TODO expand ReferenceType 1 level deep?
// suppressAlias unterdrückt aliasName in der gesamten Rekursion, nicht nur an der Aufrufstelle -
// nötig, um einen Wert zu beschreiben (der Alias ist dort immer nur der Name der Definition,
// die den Wert hält, nie ein echter Typname; siehe Fund newGameState/newBoard, Session 2026-09-10).
/** Der Name, bei einer Anwendung mit Argumenten: Tree(Integer). */
function aliasNameToString(alias: CompileTimeAliasType, indent: number): string {
	if (!alias.args) {
		return alias.name;
	}
	const args = resolveAlias(alias.args);
	const argTypes = args.julType === 'tuple'
		? args.ElementTypes
		: [args];
	// Die Argumente sind Typwerte (TypeOf(Integer)), angezeigt wird der Typ.
	const argsString = argTypes.map(arg => typeToString(valueOf(arg), indent, 1)).join(' ');
	return `${alias.name}(${argsString})`;
}

/** Der Name, unter dem die Grenze geschrieben wird, etwa GreaterInteger. */
function boundName(type: CompileTimeBoundType): string {
	const relation = type.Relation === 'greater' ? 'Greater' : 'Less';
	const family = type.Family === 'integer' ? 'Integer' : 'Float';
	return relation + family;
}

export function typeToString(type: CompileTimeType, indent: number, depth: number, suppressAlias = false): string {
	if (depth && type.aliasName && !suppressAlias) {
		return type.aliasName;
	}
	switch (type.julType) {
		case 'and':
			return `And${arrayTypeToString(type.ChoiceTypes, indent, depth + 1, suppressAlias, 'round')}`;
		case 'any':
			return 'Any';
		case 'blob':
			return 'Blob';
		case 'boolean':
			return 'Boolean';
		case 'integerLiteral':
		case 'booleanLiteral':
			return type.value.toString();
		case 'date':
			return 'Date';
		case 'dictionary':
			return `Dictionary(${typeToString(type.ElementType, indent, depth + 1, suppressAlias)})`;
		case 'dictionaryLiteral':
			return dictionaryTypeToString(type.Fields, ': ', indent, depth + 1, suppressAlias);
		case 'empty':
			return 'Empty';
		case 'error':
			return 'Error';
		case 'float':
			return 'Float';
		case 'floatLiteral':
			return type.value.toString() + 'f';
		case 'function': {
			const paramsString = typeToString(type.ParamsType, indent, depth + 1, suppressAlias);
			const returnString = typeToString(type.ReturnType, indent, depth + 1, suppressAlias);
			const arrow = type.purity === 'pure'
				? '->'
				: type.purity === 'impure'
					? '~>'
					: ':>';
			return `${paramsString} ${arrow} ${returnString}`;
		}
		case 'bound':
			return `${boundName(type)}(${typeToString(type.Value, indent, depth + 1, suppressAlias)})`;
		case 'integer':
			return 'Integer';
		case 'lengthOf':
			return `LengthOf(${typeToString(type.Source, indent, depth + 1, suppressAlias)})`;
		case 'list':
			return `List(${typeToString(type.ElementType, indent, depth + 1, suppressAlias)})`;
		case 'nestedReference':
			return `${typeToString(type.source, indent, depth + 1, suppressAlias)}/${typeof type.nestedKey === 'object'
				? typeToString(type.nestedKey, indent, depth + 1, suppressAlias)
				: type.nestedKey}`;
		case 'never':
			return 'Never';
		case 'not':
			return `Not(${typeToString(type.SourceType, indent, depth + 1, suppressAlias)})`;
		case 'or':
			return `Or${arrayTypeToString(type.ChoiceTypes, indent, depth + 1, suppressAlias, 'round')}`;
		case 'parameters': {
			const rest = type.rest;
			const multiline = type.singleNames.length + (rest ? 1 : 0) > 1;
			const newIndent = multiline
				? indent + 1
				: indent;
			const elements = [
				...type.singleNames.map(element => {
					return `${element.name}${optionalTypeGuardToString(element.type, newIndent, depth + 1, suppressAlias)}`;
				}),
				...(rest
					? [`...${rest.name}${optionalTypeGuardToString(rest.type, newIndent, depth + 1, suppressAlias)}`]
					: []),
			];
			return bracketedExpressionToString(elements, multiline, indent, 'round');
		}
		case 'parameterReference':
			return type.name;
		case 'stream':
			return `${type.finite ? 'FiniteStream' : 'Stream'}(${typeToString(type.ValueType, indent, depth + 1, suppressAlias)})`;
		case 'text':
			return 'Text';
		case 'textLiteral':
			return `§${type.value.replaceAll('§', '§§')}§`;
		case 'tuple':
			return arrayTypeToString(type.ElementTypes, indent, depth + 1, suppressAlias);
		case 'conditional': {
			const operands = type.Operands.map(operand => typeToString(operand, indent, depth + 1, suppressAlias)).join(' ');
			const branches = type.Branches.map(branch =>
				`${typeToString(branch.Head, indent, depth + 1, suppressAlias)} => ${typeToString(branch.Result, indent, depth + 1, suppressAlias)}`);
			return `:?(${operands}) [${branches.join(', ')}]`;
		}
		case 'withElementAt':
			return `WithElementAt(${typeToString(type.Source, indent, depth + 1, suppressAlias)} ${typeToString(type.Index, indent, depth + 1, suppressAlias)} ${typeToString(type.Value, indent, depth + 1, suppressAlias)})`;
		case 'indexRange':
			return `IndexRange(${typeToString(type.Start, indent, depth + 1, suppressAlias)} ${typeToString(type.End, indent, depth + 1, suppressAlias)})`;
		case 'mapElements':
			return `MapElements(${typeToString(type.Source, indent, depth + 1, suppressAlias)} ${typeToString(type.Callback, indent, depth + 1, suppressAlias)})`;
		case 'concat':
			return `Concat(${type.Sources.map((source, i) =>
				i > 0 ? ' ' + typeToString(source, indent, depth + 1, suppressAlias) : typeToString(source, indent, depth + 1, suppressAlias)).join('')})`;
		case 'add':
			return `Add(${typeToString(type.ArgsType, indent, depth + 1, suppressAlias)})`;
		case 'type':
			return 'Type';
		case 'typeOf':
			return `TypeOf(${typeToString(type.value, indent, depth, suppressAlias)})`;
		case 'alias':
			// Wie aliasName: ab depth > 0 nur der Name, die äußerste Ebene wird ausgeschrieben.
			// suppressAlias greift nicht - es zielt auf Namen von Wertdefinitionen, und ein
			// Alias-Knoten entsteht nur für Typdefinitionen.
			return depth
				? aliasNameToString(type, indent)
				: typeToString(dereferenceAlias(type), indent, depth, suppressAlias);
		case 'predicate':
			// Gezeigt wird, was in Typ-Position stand. Die Obermenge wäre falsch: isEven ist nicht
			// Integer.
			return type.name ?? typeToString(type.FunctionType, indent, depth + 1, suppressAlias);
		default: {
			const assertNever: never = type;
			throw new Error(`Unexpected BuiltInType ${(assertNever as CompileTimeType).julType}`);
		}
	}
}

function optionalTypeGuardToString(type: CompileTimeType | undefined, indent: number, depth: number, suppressAlias: boolean): string {
	return type
		? `: ${typeToString(type, indent, depth, suppressAlias)}`
		: '';
}

function arrayTypeToString(
	array: CompileTimeType[],
	indent: number,
	depth: number,
	suppressAlias: boolean,
	kind: 'round' | 'square' = 'square',
): string {
	const multiline = array.length > maxElementsPerLine;
	const newIndent = multiline
		? indent + 1
		: indent;
	return bracketedExpressionToString(
		array.map(element =>
			typeToString(element, newIndent, depth, suppressAlias)),
		multiline,
		indent,
		kind);
}

/**
 * Ob typeToString(dictionary) mehrzeilig rendert - auch genutzt, um vor dem Bauen einer
 * umhüllenden "Can not assign X to Y."-Fehlerzeile zu entscheiden, ob X selbst ausgeschrieben
 * werden würde (dann trägt die Hülle nichts bei, was die Feld-Kette nicht ohnehin zeigt).
 * Eine Quelle statt zweier, die auseinanderlaufen könnten.
 */
function hasMultipleFields(dictionary: CompileTimeDictionary): boolean {
	return Object.keys(dictionary).length > 1;
}

function dictionaryTypeToString(
	dictionary: CompileTimeDictionary,
	nameSeparator: string,
	indent: number,
	depth: number,
	suppressAlias: boolean,
): string {
	const multiline = hasMultipleFields(dictionary);
	const newIndent = multiline
		? indent + 1
		: indent;
	const allFields = map(
		dictionary,
		(element, key) => {
			return `${key}${nameSeparator}${typeToString(element, newIndent, depth, suppressAlias)}`;
		});

	// Begrenzen bei zu vielen Feldern: zeige maxFieldsInTypeDump Felder, dann "and N more"
	let displayFields = allFields;
	if (allFields.length > maxFieldsInTypeDump) {
		displayFields = [
			...allFields.slice(0, maxFieldsInTypeDump),
			`(and ${allFields.length - maxFieldsInTypeDump} more field${allFields.length - maxFieldsInTypeDump === 1 ? '' : 's'})`,
		];
	}

	return bracketedExpressionToString(
		displayFields,
		multiline,
		indent);
}

/**
 * @param kind Daten werden eckig geschrieben, Bindungsstellen (Parameterliste,
 * Argumentliste eines Typaufrufs wie Or/And) rund.
 */
function bracketedExpressionToString(
	elements: string[],
	multiline: boolean,
	indent: number,
	kind: 'round' | 'square' = 'square',
): string {
	// Dieselbe Einheit wie indentLines (indentUnit) - sonst mischen sich Tabs und Leerzeichen,
	// sobald dieser Dump in eine bereits eingerückte Fehlerkette eingebettet wird (Fund im
	// echten yugioh-Fehlerbild, Session 2026-09-10).
	const indentString = indentUnit.repeat(indent + 1);
	const openingBracketSeparator = multiline
		? '\n' + indentString
		: '';
	const elementSeparator = multiline
		? '\n' + indentString
		: ' ';
	const closingBracketSeparator = multiline
		? '\n' + indentUnit.repeat(indent)
		: '';
	const [opening, closing] = kind === 'round'
		? ['(', ')']
		: ['[', ']'];
	return `${opening}${openingBracketSeparator}${elements.join(elementSeparator)}${closingBracketSeparator}${closing}`;
}

//#endregion ToString

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
		case 'dictionaryLiteral':
			return combineTypeness(Object.values(resolved.Fields).map(fieldType => classifyTypenessOnPath(fieldType, depth + 1, aliasesOnPath)));
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
	const typeGuardTypeError = areArgsAssignableTo(undefined, typeGuardType, builtinType);
	if (typeGuardTypeError) {
		errors.push({
			code: ErrorCode.typeGuardIsNotType,
			message: typeGuardTypeError,
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
 * areArgsAssignableTo ist für any und unaufgelöste Referenzen bewusst permissiv, gemeldet wird
 * also nur, wenn es feststeht.
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
	const nonFunctionError = areArgsAssignableTo(undefined, resolvePlaceholders(expression.typeInfo!.type), anyFunctionType);
	if (nonFunctionError) {
		errors.push({
			code: code,
			message: `${message}\n${nonFunctionError}`,
			startRowIndex: expression.startRowIndex,
			startColumnIndex: expression.startColumnIndex,
			endRowIndex: expression.endRowIndex,
			endColumnIndex: expression.endColumnIndex,
		});
		return false;
	}
	return true;
}
