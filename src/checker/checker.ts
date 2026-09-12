import { join } from 'path';
import {
	BracketedExpression,
	CompileTimeConcatType,
	CompileTimeCollection,
	CompileTimeComplementType,
	CompileTimeDictionary,
	CompileTimeDictionaryLiteralType,
	CompileTimeDictionaryType,
	CompileTimeFunctionType,
	CompileTimeGreaterType,
	CompileTimeListType,
	CompileTimeRangeType,
	CompileTimeStreamType,
	CompileTimeTupleType,
	CompileTimeType,
	CompileTimeTypeOfType,
	CompileTimeUnionType,
	createCompileTimeConcatType,
	createCompileTimeComplementType,
	createCompileTimeDictionaryLiteralType,
	createCompileTimeDictionaryType,
	createCompileTimeFunctionType,
	createCompileTimeGreaterType,
	createCompileTimeLengthOfType,
	createCompileTimeListType,
	createCompileTimeRangeType,
	createCompileTimeStreamType,
	createCompileTimeTupleType,
	createCompileTimeTupleOfType,
	createCompileTimeTypeOfType,
	createCompileTimeWithElementAtType,
	createNestedReference,
	createParameterReference,
	createParametersType,
	Parameter,
	ParameterReference,
	ParametersType,
	ParsedExpressions2,
	ParsedFile,
	ParseDictionaryField,
	ParseDictionaryLiteral,
	ParseBranching,
	ParseDestructuringField,
	ParseDictionaryTypeField,
	ParseFunctionCall,
	ParseFunctionLiteral,
	ParseListLiteral,
	ParseParameterField,
	ParseParameterFields,
	ParseValueExpression,
	ParseReference,
	PredicateFacts,
	SimpleExpression,
	SymbolDefinition,
	SymbolTable,
	TextLiteralType,
	TextToken,
	TypedExpression,
	TypeInfo,
	ParseExpressionBase,
} from '../syntax-tree.js';
import { NonEmptyArray, elementsEqual, fieldsEqual, isDefined, isNonEmpty, last, map, mapDictionary } from '../util.js';
import { coreLibPath, getPathFromImport, isCoreLibPath, parseFile } from '../parser/parser.js';
import { CompilerError, ErrorCode, Positioned } from '../compiler-errors.js';
import { getCheckedEscapableName } from '../parser/parser-utils.js';

export type ParsedDocuments = { [filePath: string]: ParsedFile; };

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
};

export function resetCheckerStats(): void {
	checkerStats.inferType = 0;
	checkerStats.resolvePlaceholders = 0;
	checkerStats.getTypeError = 0;
}

//#endregion stats

const maxElementsPerLine = 5;
const maxFieldsInTypeDump = 5;

/**
 * Einheit fuer eine Einrueckungsebene in generiertem Diagnosetext (Fehlerketten, Typ-Dumps) -
 * geteilt zwischen indentLines und bracketedExpressionToString, damit beide nie auseinanderlaufen
 * (Fund im echten yugioh-Fehlerbild: Tabs vs. Leerzeichen mischten sich, weil beide Stellen ihre
 * eigene Einrueckung hatten). Leerzeichen statt Tabs: das ist generierter Diagnosetext, kein
 * Quellcode (JULs Tab-Konvention gilt dort) - ein Tab-Zeichen rendert je nach Terminal/Editor-
 * Tabstop unterschiedlich breit, Leerzeichen sind ueberall gleich breit.
 */
const indentUnit = '  ';

/**
 * Ab wie vielen Choices die Teilmengen-Elimination in createNormalizedUnionType übersprungen
 * wird, um O(n²) getTypeError-Aufrufe bei großen Unions zu vermeiden (wie TypeScript es bei
 * getUnionType(..., UnionReduction.Subtype) macht). Wert durch Messung belegt, nicht geschätzt.
 * Muss vor CompileTimeNonZeroInteger stehen, weil das schon beim Modul-Load
 * createNormalizedUnionType aufruft.
 */
const subtypeReductionLimit = 20;

const CompileTimeNonZeroInteger = createNormalizedIntersectionType([
	{ julType: 'integer' },
	createCompileTimeComplementType({ julType: 'integerLiteral', value: 0n }),
]);

const coreBuiltInSymbolTypes: { [key: string]: CompileTimeType; } = {
	true: {
		julType: 'booleanLiteral',
		value: true,
	},
	false: {
		julType: 'booleanLiteral',
		value: false,
	},
	Any: createCompileTimeTypeOfType({ julType: 'any' }),
	Type: createCompileTimeTypeOfType({ julType: 'type' }),
	Empty: createCompileTimeTypeOfType({ julType: 'empty' }),
	Boolean: createCompileTimeTypeOfType({ julType: 'boolean' }),
	Integer: createCompileTimeTypeOfType({ julType: 'integer' }),
	Float: createCompileTimeTypeOfType({ julType: 'float' }),
	Text: createCompileTimeTypeOfType({ julType: 'text' }),
	Date: createCompileTimeTypeOfType({ julType: 'date' }),
	Error: createCompileTimeTypeOfType({ julType: 'error' }),
	List: (() => {
		const parameterReference = createParameterReference('ElementType', 0);
		const functionType = createCompileTimeFunctionType(
			createParametersType([{
				name: 'ElementType',
				type: { julType: 'type' },
			}]),
			createCompileTimeTypeOfType(createCompileTimeListType(parameterReference)),
			true,
		);
		parameterReference.functionRef = functionType;
		return functionType;
	})(),
	Dictionary: (() => {
		const parameterReference = createParameterReference('ElementType', 0);
		const functionType = createCompileTimeFunctionType(
			createParametersType([{
				name: 'ElementType',
				type: { julType: 'type' },
			}]),
			createCompileTimeTypeOfType(createCompileTimeDictionaryType(parameterReference)),
			true,
		);
		parameterReference.functionRef = functionType;
		return functionType;
	})(),
	Stream: (() => {
		const parameterReference = createParameterReference('ValueType', 0);
		const functionType = createCompileTimeFunctionType(
			createParametersType([{
				name: 'ValueType',
				type: { julType: 'type' },
			}]),
			createCompileTimeTypeOfType(createCompileTimeStreamType(parameterReference)),
			true,
		);
		parameterReference.functionRef = functionType;
		return functionType;
	})(),
	nativeFunction: (() => {
		const parameterReference = createParameterReference('FunctionType', 0);
		const functionType = createCompileTimeFunctionType(
			createParametersType([
				{
					name: 'FunctionType',
					// TODO functionType
					type: { julType: 'type' },
				},
				{
					name: 'pure',
					type: { julType: 'boolean' },
				},
				{
					name: 'js',
					type: { julType: 'text' },
				},
			]),
			parameterReference,
			false,
		);
		parameterReference.functionRef = functionType;
		return functionType;
	})(),
	nativeValue: createCompileTimeFunctionType(
		createParametersType([
			{
				name: 'js',
				type: { julType: 'text' },
			},
		]),
		{ julType: 'any' },
		false,
	),
};

const parsedCoreLib = parseFile(coreLibPath);
const parsedCoreLib2 = parsedCoreLib.unchecked;
inferFileTypes(parsedCoreLib2, [], {}, '', '');
export const builtInSymbols: SymbolTable = parsedCoreLib2.symbols;

//#region dereference

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
			type: { julType: 'any' },
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
		// TODO was wenn referencedsymbol type noch nicht inferred ist?
		// tritt vermutlich bei rekursion auf
		// setInferredType(referencedSymbol)
		// console.log(reference);
		// throw new Error('symbol type was not inferred');
		return {
			type: { julType: 'any' },
			found: true,
			foundSymbol: foundSymbol,
			isBuiltIn: isBuiltIn,
		};
	}
	return {
		type: referencedType.type,
		found: true,
		foundSymbol: foundSymbol,
		isBuiltIn: isBuiltIn,
	};
}

export function getStreamGetValueType(streamType: CompileTimeStreamType): CompileTimeFunctionType {
	return createCompileTimeFunctionType({ julType: 'empty' }, streamType.ValueType, false);
}

/**
 * Faltet einen Zugriff so weit, wie die Position beweisbar ist: existiert sie, kommt ihr Typ
 * heraus; existiert sie nachweislich nicht, Empty; ist es nicht entscheidbar, die Vereinigung
 * aller Positionen. Ein noch unaufgelöster Schlüssel bleibt als Knoten stehen.
 */
function dereferenceNestedKeyFromObject(
	nestedKey: string | number | CompileTimeType,
	source: CompileTimeType,
): CompileTimeType | undefined {
	if (typeof nestedKey === 'string') {
		return dereferenceNestedKeyFromObject({ julType: 'textLiteral', value: nestedKey }, source);
	}
	if (typeof nestedKey === 'number') {
		return dereferenceNestedKeyFromObject({ julType: 'integerLiteral', value: BigInt(nestedKey) }, source);
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
				? { julType: 'empty' }
				: dereferenceUnknownKeyFromObject(nestedKey, source);
		}
		case 'textLiteral': {
			const dereferenced = dereferenceNameFromObject(nestedKey.value, source);
			if (dereferenced) {
				return dereferenced;
			}
			return hasKnownFields(source)
				? { julType: 'empty' }
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
		case 'range':
			return dereferenceRangeFromObject(nestedKey, source);
		default:
			// Ein Platzhalter kann sich noch zu einem Literal auflösen, der Knoten bleibt also
			// stehen. Nur ein aufgelöster, aber unbestimmter Schlüssel (PositiveInteger, Any)
			// heißt wirklich "die Position steht nicht fest".
			return isUnresolvedPlaceholderType(nestedKey)
				? createNestedReference(source, nestedKey)
				: dereferenceUnknownKeyFromObject(nestedKey, source);
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
	source: CompileTimeType,
): CompileTimeType | undefined {
	switch (source.julType) {
		case 'empty':
			return { julType: 'empty' };
		case 'any':
			return { julType: 'any' };
		case 'tuple':
			return createNormalizedUnionType([{ julType: 'empty' }, ...source.ElementTypes]);
		case 'list':
			return createNormalizedUnionType([{ julType: 'empty' }, source.ElementType]);
		case 'or': {
			const choices = source.ChoiceTypes
				.map(choiceType => dereferenceUnknownKeyFromObject(nestedKey, choiceType))
				.filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(choices);
		}
		case 'nestedReference':
		case 'parameterReference':
			return createNestedReference(source, nestedKey);
		case 'typeOf':
			return dereferenceUnknownKeyFromObject(nestedKey, source.value);
		default:
			return { julType: 'any' };
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
function hasKnownFields(type: CompileTimeType): boolean {
	switch (type.julType) {
		case 'dictionaryLiteral':
			return type.complete;
		case 'function':
		case 'parameters':
		case 'stream':
			return true;
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
	return type.julType === 'tuple';
}

/**
 * Kann dieser Typ überhaupt benannte Felder tragen?
 * Ein Nein heißt: der Name liegt nicht daneben, er passt gar nicht zur Art der Quelle.
 * Im Zweifel ja, damit aus "weiß ich nicht" kein Fehler wird.
 */
function canHaveFields(type: CompileTimeType): boolean {
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
 * Kann dieser Typ überhaupt Positionen tragen?
 * Gegenstück zu canHaveFields, mit derselben Zweifelsregel.
 */
function canHaveIndexes(type: CompileTimeType): boolean {
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
	sourceObjectType: CompileTimeType,
): CompileTimeType | undefined {
	switch (sourceObjectType.julType) {
		case 'empty':
			return {
				julType: 'empty'
			};
		case 'any':
			return {
				julType: 'any'
			};
		case 'dictionaryLiteral':
			return sourceObjectType.Fields[name];
		case 'dictionary':
			// TODO Or(() sourceObjectType.ElementType)
			return sourceObjectType.ElementType;
		case 'function':
			switch (name) {
				case 'ParamsType':
					return sourceObjectType.ParamsType;
				case 'ReturnType':
					return sourceObjectType.ReturnType;
				default:
					return undefined;
			}
		case 'list':
			// Eine List trägt keine benannten Felder; gemeldet wird an der Aufrufstelle.
			return undefined;
		case 'nestedReference':
		case 'parameterReference':
			return createNestedReference(sourceObjectType, name);
		case 'or': {
			const dereferencedChoices = sourceObjectType.ChoiceTypes.map(choiceType => {
				return dereferenceNameFromObject(name, choiceType);
			}).filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(dereferencedChoices);
		}
		case 'parameters': {
			const matchedParameter = sourceObjectType.singleNames.find(parameter => parameter.name === name);
			if (matchedParameter) {
				return matchedParameter.type;
			}
			return undefined;
		}
		case 'stream':
			switch (name) {
				case 'getValue':
					return getStreamGetValueType(sourceObjectType);
				case 'ValueType':
					return sourceObjectType.ValueType;
				default:
					return undefined;
			}
		case 'typeOf': {
			const innerType = sourceObjectType.value;
			return dereferenceNameFromObjectType(name, innerType, sourceObjectType);
		}
		// TODO other object types
		default:
			return undefined;
	}
}

function dereferenceNameFromObjectType(
	name: string,
	innerType: CompileTimeType,
	sourceObjectType: CompileTimeType,
): CompileTimeType | undefined {
	switch (innerType.julType) {
		case 'dictionary':
			switch (name) {
				case 'ElementType':
					return innerType.ElementType;
				default:
					return undefined;
			}
		case 'dictionaryLiteral':
			return innerType.Fields[name];
		case 'list':
			switch (name) {
				case 'ElementType':
					return innerType.ElementType;
				default:
					return undefined;
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
			return createNormalizedUnionType(dereferencedChoices);
		}
		case 'tuple':
			switch (name) {
				case 'ElementType':
					return createNormalizedUnionType(innerType.ElementTypes);
				default:
					return undefined;
			}
		default:
			return undefined;
	}
}

export function dereferenceIndexFromObject(
	index: number,
	sourceObjectType: CompileTimeType,
): CompileTimeType | undefined {
	if (sourceObjectType === undefined) {
		return undefined;
	}
	switch (sourceObjectType.julType) {
		case 'empty':
			return { julType: 'empty' };
		case 'dictionaryLiteral':
			// Ein Dictionary trägt keine Positionen; gemeldet wird an der Aufrufstelle.
			return undefined;
		case 'list':
			// Eine List kennt ihre Länge nicht, die Position ist also nicht beweisbar vorhanden.
			return createNormalizedUnionType([{ julType: 'empty' }, sourceObjectType.ElementType]);
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
		// TODO other object types
		default:
			return undefined;
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
	switch (typeToDereference.julType) {
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
			return typeToDereference;
		case 'and': {
			const rawChoices = typeToDereference.ChoiceTypes;
			const dereferencedChoices = rawChoices.map(choiceType => dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, choiceType));
			if (elementsEqual(rawChoices, dereferencedChoices)) {
				return typeToDereference;
			}
			return createNormalizedIntersectionType(dereferencedChoices);
		}
		case 'dictionary': {
			const rawElement = typeToDereference.ElementType;
			const dereferencedElement = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawElement);
			if (dereferencedElement === rawElement) {
				return typeToDereference;
			}
			return createCompileTimeDictionaryType(dereferencedElement);
		}
		case 'greater': {
			const rawValue = typeToDereference.Value;
			const dereferencedValue = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawValue);
			if (dereferencedValue === rawValue) {
				return typeToDereference;
			}
			return createCompileTimeGreaterType(dereferencedValue);
		}
		case 'list': {
			const rawElement = typeToDereference.ElementType;
			const dereferencedElement = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawElement);
			if (dereferencedElement === rawElement) {
				return typeToDereference;
			}
			return createCompileTimeListType(dereferencedElement);
		}
		case 'lengthOf': {
			const rawSource = typeToDereference.Source;
			const dereferencedSource = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawSource);
			if (dereferencedSource === rawSource) {
				return typeToDereference;
			}
			// Neu falten statt neu einpacken: steht die Quelle jetzt fest, ist die Laenge ein
			// Literal (Tuple) oder aufgesplittet (Or) - lengthOf(konkrete Quelle) waere zwar
			// korrekt, aber unnoetig grob.
			return getLengthFromType(dereferencedSource);
		}
		case 'nestedReference': {
			const dereferencedSource = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, typeToDereference.source);
			const dereferencedKey = typeof typeToDereference.nestedKey === 'object'
				? dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, typeToDereference.nestedKey)
				: typeToDereference.nestedKey;
			const dereferencedNested = dereferenceNestedKeyFromObject(dereferencedKey, dereferencedSource);
			if (!dereferencedNested) {
				return { julType: 'any' };
			}
			return dereferencedNested;
		}
		case 'not': {
			const rawSource = typeToDereference.SourceType;
			const dereferencedSource = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawSource);
			if (dereferencedSource === rawSource) {
				return typeToDereference;
			}
			return createCompileTimeComplementType(dereferencedSource);
		}
		case 'or': {
			const rawChoices = typeToDereference.ChoiceTypes;
			const dereferencedChoices = rawChoices.map(choiceType => dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, choiceType));
			if (elementsEqual(rawChoices, dereferencedChoices)) {
				return typeToDereference;
			}
			return createNormalizedUnionType(dereferencedChoices);
		}
		case 'parameterReference': {
			const dereferencedParameter = dereferenceParameterFromArgumentType(calledFunction, prefixArgumentType, argsType, typeToDereference);
			const dereferencedNested = dereferencedParameter === typeToDereference
				? dereferencedParameter
				: dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, dereferencedParameter);
			// TODO immer valueOf?
			return valueOf(dereferencedNested);
		}
		case 'stream': {
			const rawValue = typeToDereference.ValueType;
			const dereferencedValue = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawValue);
			if (dereferencedValue === rawValue) {
				return typeToDereference;
			}
			return createCompileTimeStreamType(dereferencedValue);
		}
		case 'typeOf': {
			const rawValue = typeToDereference.value;
			const dereferencedValue = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawValue);
			if (dereferencedValue === rawValue) {
				return typeToDereference;
			}
			return createCompileTimeTypeOfType(dereferencedValue);
		}
		case 'withElementAt': {
			const rawSource = typeToDereference.Source;
			const rawIndex = typeToDereference.Index;
			const rawValue = typeToDereference.Value;
			const dereferencedSource = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawSource);
			const dereferencedIndex = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawIndex);
			const dereferencedValue = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawValue);
			if (dereferencedSource === rawSource
				&& dereferencedIndex === rawIndex
				&& dereferencedValue === rawValue) {
				return typeToDereference;
			}
			// Neu falten, nicht neu einpacken: steht die Position jetzt fest, ist das Ergebnis ein
			// konkretes Tuple.
			return withElementAtFromTypes(dereferencedSource, dereferencedIndex, dereferencedValue);
		}
		case 'range': {
			const rawStart = typeToDereference.Start;
			const rawEnd = typeToDereference.End;
			const dereferencedStart = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawStart);
			const dereferencedEnd = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawEnd);
			if (dereferencedStart === rawStart
				&& dereferencedEnd === rawEnd) {
				return typeToDereference;
			}
			return createCompileTimeRangeType(dereferencedStart, dereferencedEnd);
		}
		case 'tupleOf': {
			const rawCount = typeToDereference.Count;
			const rawElement = typeToDereference.ElementType;
			const dereferencedCount = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawCount);
			const dereferencedElement = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawElement);
			if (dereferencedCount === rawCount
				&& dereferencedElement === rawElement) {
				return typeToDereference;
			}
			// Neu falten, nicht neu einpacken: steht die Anzahl jetzt fest, ist es ein Tuple.
			return tupleOfFromTypes(dereferencedCount, dereferencedElement);
		}
		case 'concat': {
			const rawSources = typeToDereference.Sources;
			const dereferencedSources = rawSources.map(source =>
				dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, source));
			if (rawSources.every((source, i) => source === dereferencedSources[i])) {
				return typeToDereference;
			}
			return concatFromTypes(dereferencedSources);
		}
		// TODO
		case 'dictionaryLiteral':
		case 'function':
		case 'parameters':
		case 'tuple':
			return typeToDereference;
		default: {
			const assertNever: never = typeToDereference;
			throw new Error('Unexpected typeToDereference.type: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

/**
 * combine prefixArgumentType and argsType
 */
function getAllArgTypes(
	prefixArgumentType: CompileTimeType | undefined,
	argsType: CompileTimeType,
): CompileTimeType[] | undefined {
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
	argsType: CompileTimeType,
	parameterReference: ParameterReference,
): CompileTimeType {
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
			return { julType: 'any' };
		}
		return {
			julType: 'tuple',
			ElementTypes: allArgTypes.slice(paramIndex)
		};
	}
	if (prefixArgumentType && paramIndex === 0) {
		return prefixArgumentType;
	}
	if (argsType.julType === 'empty') {
		return {
			julType: 'empty'
		};
	}
	switch (argsType.julType) {
		case 'dictionaryLiteral': {
			const referenceName = parameterReference.name;
			const argType = argsType.Fields[referenceName];
			// TODO error bei unbound ref?
			if (!argType) {
				return parameterReference;
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
			if (!argType) {
				// TODO error bei unbound ref?
				return parameterReference;
			}
			return argType;
		}
		case 'function':
			// Wenn der Parameter ein Callback ist und sein Typ dereferenziert wird (z. B. callback/ReturnType),
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
	checkerStats.resolvePlaceholders++;
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
			// Blatt-Typen: kein verschachtelter CompileTimeType, der einen Platzhalter tragen koennte.
			return rawType;
		case 'and': {
			const rawChoices = rawType.ChoiceTypes;
			const dereferencedChoices = rawChoices.map(resolvePlaceholders);
			if (elementsEqual(rawChoices, dereferencedChoices)) {
				return rawType;
			}
			return createNormalizedIntersectionType(dereferencedChoices);
		}
		case 'dictionary': {
			const rawElement = rawType.ElementType;
			const dereferencedElement = resolvePlaceholders(rawElement);
			if (dereferencedElement === rawElement) {
				return rawType;
			}
			return createCompileTimeDictionaryType(dereferencedElement, rawType.aliasName);
		}
		case 'dictionaryLiteral': {
			const rawFields = rawType.Fields;
			const dereferencedFields = mapDictionary(rawFields, resolvePlaceholders);
			if (fieldsEqual(rawFields, dereferencedFields)) {
				return rawType;
			}
			return createCompileTimeDictionaryLiteralType(dereferencedFields, rawType.complete, rawType.declaration, rawType.aliasName);
		}
		case 'function': {
			const dereferencedParamsType = resolvePlaceholders(rawType.ParamsType);
			const dereferencedReturnType = resolvePlaceholders(rawType.ReturnType);
			if (dereferencedParamsType === rawType.ParamsType
				&& dereferencedReturnType === rawType.ReturnType) {
				return rawType;
			}
			const dereferencedType = createCompileTimeFunctionType(dereferencedParamsType, dereferencedReturnType, rawType.pure, rawType.aliasName);
			// Die Prädikat-Fakten beschreiben den Wert, nicht die Platzhalter darin - sie gehen
			// beim Neubau sonst still verloren.
			dereferencedType.predicate = rawType.predicate;
			return dereferencedType;
		}
		case 'greater': {
			const rawValue = rawType.Value;
			const dereferencedValue = resolvePlaceholders(rawValue);
			if (dereferencedValue === rawValue) {
				return rawType;
			}
			return createCompileTimeGreaterType(dereferencedValue);
		}
		case 'list': {
			const rawElement = rawType.ElementType;
			const dereferencedElement = resolvePlaceholders(rawElement);
			if (dereferencedElement === rawElement) {
				return rawType;
			}
			return createCompileTimeListType(dereferencedElement);
		}
		case 'nestedReference': {
			const dereferencedSource = resolvePlaceholders(rawType.source);
			const dereferencedKey = typeof rawType.nestedKey === 'object'
				? resolvePlaceholders(rawType.nestedKey)
				: rawType.nestedKey;
			const dereferencedNested = dereferenceNestedKeyFromObject(dereferencedKey, dereferencedSource);
			if (!dereferencedNested) {
				return { julType: 'any' };
			}
			return dereferencedNested;
		}
		case 'not': {
			const rawSource = rawType.SourceType;
			const dereferencedSource = resolvePlaceholders(rawSource);
			if (dereferencedSource === rawSource) {
				return rawType;
			}
			return createCompileTimeComplementType(dereferencedSource);
		}
		case 'lengthOf': {
			const rawSource = rawType.Source;
			const dereferencedSource = resolvePlaceholders(rawSource);
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
			const dereferencedChoices = rawChoices.map(resolvePlaceholders);
			if (elementsEqual(rawChoices, dereferencedChoices)) {
				return rawType;
			}
			return createNormalizedUnionType(dereferencedChoices);
		}
		case 'parameterReference': {
			const dereferenced1 = dereferenceParameterTypeFromFunctionRef(rawType);
			if (!dereferenced1) {
				return { julType: 'any' };
			}
			if (dereferenced1 === rawType) {
				return rawType;
			}
			const dereferenced2 = resolvePlaceholders(dereferenced1);
			return dereferenced2;
		}
		case 'parameters': {
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
			const dereferencedValue = resolvePlaceholders(rawValue);
			if (dereferencedValue === rawValue) {
				return rawType;
			}
			return createCompileTimeStreamType(dereferencedValue);
		}
		case 'tuple': {
			const rawElements = rawType.ElementTypes;
			const dereferencedElements = rawElements.map(resolvePlaceholders);
			if (elementsEqual(rawElements, dereferencedElements)) {
				return rawType;
			}
			return createCompileTimeTupleType(dereferencedElements);
		}
		case 'typeOf': {
			const rawValue = rawType.value;
			const dereferencedValue = resolvePlaceholders(rawValue);
			if (dereferencedValue === rawValue) {
				return rawType;
			}
			return createCompileTimeTypeOfType(dereferencedValue);
		}
		case 'withElementAt': {
			const rawSource = rawType.Source;
			const rawIndex = rawType.Index;
			const rawValue = rawType.Value;
			const dereferencedSource = resolvePlaceholders(rawSource);
			const dereferencedIndex = resolvePlaceholders(rawIndex);
			const dereferencedValue = resolvePlaceholders(rawValue);
			if (dereferencedSource === rawSource
				&& dereferencedIndex === rawIndex
				&& dereferencedValue === rawValue) {
				return rawType;
			}
			// Neu falten statt neu einpacken, sonst bleibt der Knoten trotz aufgeloester Teile stehen.
			return withElementAtFromTypes(dereferencedSource, dereferencedIndex, dereferencedValue);
		}
		case 'range': {
			const rawStart = rawType.Start;
			const rawEnd = rawType.End;
			const dereferencedStart = resolvePlaceholders(rawStart);
			const dereferencedEnd = resolvePlaceholders(rawEnd);
			if (dereferencedStart === rawStart
				&& dereferencedEnd === rawEnd) {
				return rawType;
			}
			return createCompileTimeRangeType(dereferencedStart, dereferencedEnd);
		}
		case 'tupleOf': {
			const rawCount = rawType.Count;
			const rawElement = rawType.ElementType;
			const dereferencedCount = resolvePlaceholders(rawCount);
			const dereferencedElement = resolvePlaceholders(rawElement);
			if (dereferencedCount === rawCount
				&& dereferencedElement === rawElement) {
				return rawType;
			}
			// Neu falten statt neu einpacken.
			return tupleOfFromTypes(dereferencedCount, dereferencedElement);
		}
		case 'concat': {
			const rawSources = rawType.Sources;
			const dereferencedSources = rawSources.map(resolvePlaceholders);
			if (rawSources.every((source, i) => source === dereferencedSources[i])) {
				return rawType;
			}
			// Neu falten statt neu einpacken.
			return concatFromTypes(dereferencedSources);
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
			// aus dem Rumpf - bei einem Alias laufen beide auseinander.
			return paramsType.singleNames[parameterReference.index]?.type;
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

/**
 * infer types of expressions, normalize typeGuards
 * fills errors
 */
export function checkTypes(
	document: ParsedFile,
	documents: ParsedDocuments,
): void {
	const checked = structuredClone(document.unchecked);
	document.checked = checked;
	// Die core-lib definiert die builtInSymbols selbst. Bekäme sie sie zusätzlich als oberen
	// Scope, stünde ihre Symboltabelle zweimal im Stack und jede Definition wäre
	// alreadyDefinedInUpperScope. Daher ohne Scopes checken, genau wie beim initialen Laden.
	const scopes = isCoreLibPath(document.filePath)
		? []
		: [builtInSymbols];
	inferFileTypes(checked, scopes, documents, document.sourceFolder, document.filePath);
}

function inferFileTypes(
	file: ParsedExpressions2,
	scopes: SymbolTable[],
	parsedDocuments: ParsedDocuments,
	/**
	 * Leerstring, wenn builtin.
	 */
	sourceFolder: string,
	/**
	 * Leerstring, wenn builtin.
	 */
	filePath: string,
): void {
	const fileScopes = [
		...scopes,
		file.symbols,
	] as any as NonEmptyArray<SymbolTable>;
	file.expressions?.forEach(expression => {
		setInferredType(expression, { scopes: fileScopes, narrowedTypes: undefined }, parsedDocuments, sourceFolder, file, filePath);
	});
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
		const dereferenced = dereferenceNestedKeyFromObject(key, type);
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
			?? { julType: 'any' };
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
	const rawType = getRawBranchArgumentType(paramsType, argumentIndex);
	// Ein Funktionswert in Typ-Position ist ein Prädikat - die Laufzeit ruft ihn auf
	// (runtime.ts, getTypeError case 'function') - und keine Zusicherung über die Gestalt des
	// Werts. Damit zu schneiden ergäbe Never, also hier keine Aussage. Was ein Prädikat hergibt,
	// liefert getBranchPredicateFacts - je Richtung getrennt.
	return isFunctionType(rawType)
		? undefined
		: rawType;
}

/**
 * Die Prädikat-Fakten des branch-Kopfs an dieser Argumentstelle.
 * Welche Richtung gilt, entscheidet die Aufrufstelle über das Feld - ifTrue nur für den branch
 * selbst, excludedIfFalse nur für spätere branches. isBranchingExhaustive bräuchte eine dritte
 * Aussage (das Prädikat muss für jeden Wert definiert sein) und rechnet deshalb ohne beide.
 */
function getBranchPredicateFacts(
	paramsType: CompileTimeType,
	argumentIndex: number,
): PredicateFacts | undefined {
	const rawType = getRawBranchArgumentType(paramsType, argumentIndex);
	return isFunctionType(rawType)
		? rawType.predicate
		: undefined;
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
	return !getTypeError(undefined, argValueType, combinedType);
}

/**
 * Der Typ des Elements an dieser Stelle einer Kollektion.
 * undefined, wenn er sich nicht bestimmen lässt - dann wird nicht verengt.
 */
function getElementTypeAtIndex(
	type: CompileTimeType | undefined,
	index: number,
): CompileTimeType | undefined {
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
		const previousValueType = getBranchArgumentType(previousParamsType, argumentIndex)
			?? getBranchPredicateFacts(previousParamsType, argumentIndex)?.excludedIfFalse;
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
	if (getTypeError(undefined, resolvePlaceholders(returnType), { julType: 'boolean' })) {
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
	parsedDocuments: ParsedDocuments,
	/**
	 * Leerstring, wenn builtin.
	 */
	sourceFolder: string,
	file: ParsedExpressions2,
	/**
	 * Leerstring, wenn builtin.
	 */
	filePath: string,
): void {
	if (expression.typeInfo) {
		return;
	}
	expression.typeInfo = inferType(expression, typeContext, parsedDocuments, sourceFolder, file, filePath);
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
	parsedDocuments: ParsedDocuments,
	/**
	 * Leerstring, wenn builtin.
	 */
	folder: string,
	file: ParsedExpressions2,
	/**
	 * Leerstring, wenn builtin.
	 */
	filePath: string,
): TypeInfo {
	checkerStats.inferType++;
	const { scopes, narrowedTypes } = typeContext;
	const errors = file.errors;
	switch (expression.type) {
		case 'binding':
		case 'data':
			// TODO?
			return { type: { julType: 'any' } };
		case 'branching': {
			// union branch return types
			// TODO conditional type?
			const args = expression.args;
			if (args) {
				setInferredType(args, typeContext, parsedDocuments, folder, file, filePath);
			}
			const branches = expression.branches;
			branches.forEach((branch, index) => {
				setInferredType(branch, typeContext, parsedDocuments, folder, file, filePath);
				checkIsFunction(branch, ErrorCode.branchIsNotFunction, 'Expected branch to be a function.', errors);
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
					const error = areArgsAssignableTo(undefined, currentArgumentType, combinedPreviousArgumentType);
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
					: [...branchReturnTypes, { julType: 'error' }]);
			return { type: rawType };
		}
		case 'definition': {
			const value = expression.value;
			if (value) {
				setInferredType(value, typeContext, parsedDocuments, folder, file, filePath);
			}
			const name = expression.name.name;
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
					typeInfo = { type: { julType: 'any' } };
				}
			}
			checkNameDefinedInUpperScope(expression, scopes, errors, name);
			// TODO typecheck mit typeguard, ggf union mit Error type
			const currentScope = last(scopes);
			const symbol = currentScope[name];
			if (!symbol) {
				throw new Error(`Definition Symbol ${name} not found`);
			}
			symbol.typeInfo = typeInfo;
			const typeGuard = expression.typeGuard;
			if (typeGuard) {
				setInferredType(typeGuard, typeContext, parsedDocuments, folder, file, filePath);
				checkTypeGuardIsType(typeGuard, errors);
				const typeGuardType = typeGuard.typeInfo;
				const resolvedTargetType = typeGuardType && valueOf(resolvePlaceholders(typeGuardType.type));
				const assignmentError = resolvedTargetType && areArgsAssignableTo(undefined, resolvePlaceholders(typeInfo.type), resolvedTargetType);
				if (assignmentError) {
					// Position wandert beim Abstieg durch verschachtelte Dictionary-Literale auf
					// die innerste noch vorhandene, tatsaechlich falsche Stelle (TypeScript/
					// Rust/Elm-Vorbild: eine Diagnose, eine moeglichst genaue Position, statt
					// einer zweiten Diagnose mit demselben Text an einer weniger genauen Stelle).
					const innerPosition = resolvedTargetType && findInnermostErrorPosition(value, resolvedTargetType);
					const position = innerPosition ?? expression;
					
					// Ob die umhuellende "Can not assign X to Y."-Zeile fehlt, entscheidet
					// getTypeError bereits an der Quelle (case 'dictionaryLiteral': in
					// getTypeError, hasMultipleFields) - hier nur noch die fertige Meldung
					// uebernehmen, kein nachtraegliches Textschneiden mehr.
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
				setInferredType(value, typeContext, parsedDocuments, folder, file, filePath);
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
				const valueType: CompileTimeType = value?.typeInfo
					? value.typeInfo.type
					: { julType: 'any' };
				// Die Laufzeit greift bei einem Array über die Position zu, sonst über den Namen
				// (_isArray ? _temp[index] : _temp.name) - der Checker prüft deshalb beides.
				const fieldType = dereferenceNameFromObject(referenceName, valueType)
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
				const typeGuard = field.typeGuard;
				if (typeGuard) {
					setInferredType(typeGuard, typeContext, parsedDocuments, folder, file, filePath);
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
			return { type: { julType: 'any' } };
		}
		case 'dictionary': {
			const fieldTypes: CompileTimeDictionary = {};
			let isUnknownType = false;
			expression.fields.forEach(field => {
				const value = field.value;
				if (value) {
					setInferredType(value, typeContext, parsedDocuments, folder, file, filePath);
				}
				switch (field.type) {
					case 'singleDictionaryField': {
						const typeGuard = field.typeGuard;
						if (typeGuard) {
							setInferredType(typeGuard, typeContext, parsedDocuments, folder, file, filePath);
							checkTypeGuardIsType(typeGuard, errors);
						}
						const fieldName = getCheckedEscapableName(field.name);
						if (!fieldName) {
							return;
						}
						const fieldType = field.value?.typeInfo?.type ?? { julType: 'any' };
						fieldTypes[fieldName] = fieldType;
						const fieldSymbol = expression.symbols[fieldName];
						if (!fieldSymbol) {
							throw new Error(`fieldSymbol ${fieldName} not found`);
						}
						fieldSymbol.typeInfo = { type: fieldType };
						return;
					}
					case 'spread':
						// resolvePlaceholders noetig: sonst wird z.B. eine Parameter-Typreferenz
						// nicht als dictionaryLiteral erkannt und der gesamte Literal-Typ faellt
						// still auf Any zurueck (verschluckt dann jeden Folgefehler).
						const valueType = value?.typeInfo && resolvePlaceholders(value.typeInfo.type);
						// TODO DictionaryType, ChoiceType etc ?
						if (isDictionaryLiteralType(valueType)) {
							const valueFieldTypes = valueType.Fields;
							for (const key in valueType.Fields) {
								fieldTypes[key] = valueFieldTypes[key]!;
							}
						}
						else {
							isUnknownType = true;
						}
						return;
					default: {
						const assertNever: never = field;
						throw new Error('Unexpected Dictionary field type ' + (assertNever as ParseDictionaryField).type);
					}
				}
			});
			if (isUnknownType) {
				return { type: { julType: 'any' } };
			}
			const aliasName = getNameFromValue(expression);
			const rawType = createCompileTimeDictionaryLiteralType(
				fieldTypes,
				true,
				{ expression: expression, filePath: filePath },
				aliasName);
			return { type: rawType };
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
						setInferredType(typeGuard, typeContext, parsedDocuments, folder, file, filePath);
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
						setInferredType(field.value, typeContext, parsedDocuments, folder, file, filePath);
						// resolvePlaceholders/valueOf noetig: die Quelle steht als Typausdruck
						// (TypeOf(dictionaryLiteral)) da, nicht als Wert - dieselbe Begruendung
						// wie beim Spread in case 'dictionary'.
						const spreadType = field.value.typeInfo
							&& valueOf(resolvePlaceholders(field.value.typeInfo.type));
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
			return { type: { julType: 'empty' } };
		case 'field':
			// TODO?
			return { type: { julType: 'empty' } };
		case 'float': {
			const rawType: CompileTimeType = {
				julType: 'floatLiteral',
				value: expression.value
			};
			return { type: rawType };
		}
		case 'fraction': {
			const rawType = createCompileTimeDictionaryLiteralType({
				numerator: {
					julType: 'integerLiteral',
					value: expression.numerator,
				},
				denominator: {
					julType: 'integerLiteral',
					value: expression.denominator,
				},
			}, true);
			return { type: rawType };
		}
		case 'functionCall': {
			// TODO provide args types for conditional/generic/derived type?
			// TODO infer last body expression type for returnType
			const prefixArgument = expression.prefixArgument;
			if (prefixArgument) {
				setInferredType(prefixArgument, typeContext, parsedDocuments, folder, file, filePath);
			}
			const functionExpression = expression.functionExpression;
			if (!functionExpression) {
				return { type: { julType: 'any' } };
			}
			setInferredType(functionExpression, typeContext, parsedDocuments, folder, file, filePath);
			const isFunction = checkIsFunction(functionExpression, ErrorCode.valueIsNotFunction, 'Expected a function to call.', errors);
			const functionType = functionExpression.typeInfo!.type;
			const paramsType = getParamsType(functionType);
			const args = expression.arguments;
			if (!args) {
				return { type: { julType: 'any' } };
			}
			//#region infer argument type bei function literal welches inline argument eines function calls ist
			const prefixArgs = prefixArgument
				? [prefixArgument]
				: [];
			const argValues = getArgValueExpressions(args);
			const allArgExpressions = [
				...prefixArgs,
				...argValues,
			];
			allArgExpressions.forEach((arg, argIndex) => {
				if (arg?.type === 'functionLiteral') {
					// TODO get param type by name, spread args berücksichtigen
					if (isParametersType(paramsType)) {
						const param = paramsType.singleNames[argIndex];
						if (param && isFunctionType(param.type)) {
							const innerParamsType = param.type.ParamsType;
							if (arg.params.type === 'parameters') {
								arg.params.singleFields.forEach((literalParam, literalParamIndex) => {
									if (isParametersType(innerParamsType)) {
										const innerParam = innerParamsType.singleNames[literalParamIndex];
										literalParam.inferredTypeFromCall = innerParam?.type;
									}
								});
							}
						}
						// TODO rest param berücksichtigen
					}
				}
			});
			//#endregion
			setInferredType(args, typeContext, parsedDocuments, folder, file, filePath);
			if (!isFunction) {
				// Die Argumente sind inferiert, ihre eigenen Fehler also gemeldet.
				// Alles weitere setzt eine Funktion voraus und wäre wirkungslos.
				return { type: { julType: 'any' } };
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
			const prefixArgumentType = prefixArgument?.typeInfo?.type && resolvePlaceholders(prefixArgument.typeInfo.type);
			const assignArgsError = areArgsAssignableTo(prefixArgumentType, argsType, paramsType);
			if (assignArgsError) {
				errors.push({
					code: ErrorCode.argumentTypeMismatch,
					message: `Argument type mismatch.\n${assignArgsError}`,
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.endRowIndex,
					endColumnIndex: expression.endColumnIndex,
				});
			}
			checkDiscardedArguments(args, paramsType, prefixArgumentType, errors);
			const returnType = getReturnTypeFromFunctionCall(expression, functionExpression, parsedDocuments, folder, errors);
			// evaluate generic ReturnType
			const dereferencedReturnType = dereferenceArgumentTypesNested(functionType, prefixArgumentType, argsType, returnType);
			return { type: dereferencedReturnType };
		}
		case 'functionLiteral': {
			const ownSymbols = expression.symbols;
			const functionScopes: NonEmptyArray<SymbolTable> = [...scopes, ownSymbols];
			const params = expression.params;
			const functionType = createCompileTimeFunctionType(
				{ julType: 'empty' },
				{ julType: 'empty' },
				// TODO pure, wenn der body pure ist
				false,
			);
			if (params.type === 'parameters') {
				setFunctionRefForParams(params, functionType, functionScopes);
			}
			// Die Params sagen die Verengung erst aus, sie sehen sie also noch nicht.
			const functionTypeContext: TypeContext = {
				scopes: functionScopes,
				narrowedTypes: narrowedTypes,
			};
			setInferredType(params, functionTypeContext, parsedDocuments, folder, file, filePath);
			const paramsTypeValue = valueOf(params.typeInfo!.type);
			checkParamsTypeIsCollection(params, errors);
			functionType.ParamsType = paramsTypeValue;
			//#region verengte Typen für branching
			let branchNarrowedTypes = narrowedTypes;
			const branching = expression.parent;
			if (branching?.type === 'branching') {
				getWrittenArguments(branching.args)?.forEach((argument, argumentIndex) => {
					const path = getAccessPath(argument, functionScopes);
					if (!path) {
						return;
					}
					const branchRawType = getBranchArgumentType(paramsTypeValue, argumentIndex)
						?? getBranchPredicateFacts(paramsTypeValue, argumentIndex)?.ifTrue;
					// Was vorherige branches schon abfangen, kann hier nicht mehr ankommen.
					const previousBranchValueType = getPreviousBranchArgumentType(branching, expression, argumentIndex);
					if (!branchRawType
						&& !previousBranchValueType) {
						return;
					}
					// branching.args wird in case 'branching' vor den branches inferiert
					const currentType = getNarrowedType(branchNarrowedTypes, path.symbol, path.keys)
						?? argument.typeInfo?.type
						?? { julType: 'any' };
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
			expression.body.forEach(bodyExpression => {
				setInferredType(bodyExpression, branchTypeContext, parsedDocuments, folder, file, filePath);
			});
			// Ein leerer body ist ungültig, nicht leer (Empty). Any als Ergebnis, damit sich der
			// Fehler nicht kaskadierend fortsetzt - beim Tippen ist der Zustand der Normalfall.
			const inferredReturnType: CompileTimeType = last(expression.body)?.typeInfo?.type ?? { julType: 'any' };
			const declaredReturnType = expression.returnType;
			// Any als inferierter Typ heißt "nichts Genaueres bekannt", nicht "Any ist der Typ" -
			// hier auf den deklarierten Typ zurückfallen, sonst sehen Aufrufer Any statt der
			// geprüften Zusicherung. Ist der inferierte Typ enger als deklariert (Normalfall,
			// z.B. ein Literal), bleibt er erhalten - er ist die genauere Information.
			let returnType = inferredReturnType;
			if (declaredReturnType) {
				setInferredType(declaredReturnType, branchTypeContext, parsedDocuments, folder, file, filePath);
				// roh für den Any-Fallback unten: der generische Platzhalter (z.B.
				// TypeOf(values)/ElementType) muss je Aufruf neu aufgelöst werden, nicht schon
				// hier mit dem an der Deklaration sichtbaren Parametertyp fest verdrahtet werden.
				const rawDeclaredReturnType = valueOf(declaredReturnType.typeInfo!.type);
				const resolvedDeclaredReturnType = resolvePlaceholders(rawDeclaredReturnType);
				const error = areArgsAssignableTo(undefined, resolvePlaceholders(inferredReturnType), resolvedDeclaredReturnType);
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
							message: `Declared as ${typeToString(resolvedDeclaredReturnType, 0, 1)} here.`,
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
					// Concat(TypeOf(a) TypeOf(b))) und muss je Aufruf neu aufgeloest werden - der
					// body-Typ waere nur die an der Deklaration sichtbare, fest verdrahtete Instanz.
					returnType = rawDeclaredReturnType;
				}
			}
			functionType.ReturnType = returnType;
			functionType.predicate = getPredicateFacts(expression, returnType);
			return { type: functionType };
		}
		case 'functionTypeLiteral': {
			const functionScopes: NonEmptyArray<SymbolTable> = [...scopes, expression.symbols];
			const params = expression.params;
			const functionType = createCompileTimeFunctionType(
				{ julType: 'empty' },
				{ julType: 'empty' },
				true,
			);
			if (params.type === 'parameters') {
				setFunctionRefForParams(params, functionType, functionScopes);
			}
			const functionTypeContext: TypeContext = {
				scopes: functionScopes,
				narrowedTypes: narrowedTypes,
			};
			setInferredType(params, functionTypeContext, parsedDocuments, folder, file, filePath);
			functionType.ParamsType = valueOf(params.typeInfo!.type);
			checkParamsTypeIsCollection(params, errors);
			// TODO check returnType muss pure sein
			setInferredType(expression.returnType, functionTypeContext, parsedDocuments, folder, file, filePath);
			const inferredReturnType = expression.returnType.typeInfo!.type;
			functionType.ReturnType = valueOf(inferredReturnType);
			const rawType = createCompileTimeTypeOfType(functionType);
			return { type: rawType };
		}
		case 'integer': {
			const rawType: CompileTimeType = {
				julType: 'integerLiteral',
				value: expression.value,
			};
			return { type: rawType };
		}
		case 'list': {
			// TODO error when spread dictionary
			expression.values.forEach(element => {
				const typedExpression = element.type === 'spread'
					? element.value
					: element;
				setInferredType(typedExpression, typeContext, parsedDocuments, folder, file, filePath);
			});

			// Bleibt eine Spread-Quelle bis zum Aufruf offen (z.B. ein eigener Parameter), muss
			// die Aneinanderreihung ebenso offen bleiben - sonst faellt sie hier schon auf den
			// deklarierten Parametertyp zurueck, obwohl Concat sie am Aufrufort exakt berechnen
			// koennte (docs/generic-types-through-function-body.md).
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
						tupleElements.push({ julType: 'any' });
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
				const resolvedElements = tupleElements.map(t => resolvePlaceholders(t));
				const unionType = createNormalizedUnionType(resolvedElements);
				rawType = createCompileTimeListType(unionType);
			} else {
				// Alle Spreads sind Tuples (oder keine Spreads) → Tuple mit bekannter Länge
				rawType = createCompileTimeTupleType(tupleElements);
			}

			return { type: rawType };
		}
		case 'nestedReference': {
			const source = expression.source;
			setInferredType(source, typeContext, parsedDocuments, folder, file, filePath);
			const nestedKey = expression.nestedKey;
			if (!nestedKey) {
				return { type: { julType: 'any' } };
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
						return { type: { julType: 'any' } };
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
						return { type: { julType: 'any' } };
					}
					return { type: dereferencedType };
				}
				case 'name':
				case 'text': {
					const fieldName = getCheckedEscapableName(nestedKey);
					if (!fieldName) {
						return { type: { julType: 'any' } };
					}
					const sourceType = resolvePlaceholders(source.typeInfo!.type);
					// Der rawType kann eine Form sein, die dereferenceNameFromObject nicht behandelt,
					// z.B. das and aus der Verengung eines branches. Dann auf dem aufgelösten Typ
					// nachsehen, bevor das Feld als fehlend gilt.
					const dereferencedType = dereferenceNameFromObject(fieldName, source.typeInfo!.type)
						?? dereferenceNameFromObject(fieldName, sourceType);
					if (!dereferencedType) {
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
									: baseMessage,
								startRowIndex: nestedKey.startRowIndex,
								startColumnIndex: nestedKey.startColumnIndex,
								endRowIndex: nestedKey.endRowIndex,
								endColumnIndex: nestedKey.endColumnIndex,
							});
						}
						// Any als Ergebnis, damit sich der Fehler nicht kaskadierend fortsetzt
						return { type: { julType: 'any' } };
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
				setInferredType(element.value, typeContext, parsedDocuments, folder, file, filePath);
			});

			// Bleibt eine Spread-Quelle bis zum Aufruf offen, muss die Aneinanderreihung ebenso
			// offen bleiben (dieselbe Begruendung wie bei case 'list').
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
				return { type: { julType: 'any' } };
			}
			return { type: createCompileTimeDictionaryLiteralType(fieldTypes, true) };
		}
		case 'parameter': {
			const typeGuard = expression.typeGuard;
			if (typeGuard) {
				setInferredType(typeGuard, typeContext, parsedDocuments, folder, file, filePath);
				checkTypeGuardIsType(typeGuard, errors);
			}
			checkNameDefinedInUpperScope(expression, scopes, errors, expression.name.name);
			//#region infer argument type bei function literal welches inline argument eines function calls ist
			const inferredTypeFromCall = expression.inferredTypeFromCall;
			let dereferencedTypeFromCall = inferredTypeFromCall;
			if (inferredTypeFromCall
				&& expression.parent?.type === 'parameters'
				&& expression.parent.parent?.type === 'functionLiteral'
				&& expression.parent.parent.parent?.type === 'list'
				&& expression.parent.parent.parent.parent?.type === 'functionCall') {
				// evaluate generic ParameterType
				const functionCall = expression.parent.parent.parent.parent;
				const functionExpression = functionCall.functionExpression;
				const args = functionCall.arguments;
				if (functionExpression && args) {
					const functionType = functionExpression.typeInfo!.type;
					const prefixArgument = functionCall.prefixArgument;
					// TODO rest berücksichtigen
					// const paramIndex = expression.parent.singleFields.indexOf(expression);
					const prefixArgumentType = prefixArgument?.typeInfo?.type;
					// argsType.typeInfo ist hier noch nicht gesetzt, denn der aktuelle parameter befindet sich in einem arg
					// daher die typeInfo aus den values nehmen und vorläufigen argsType konstruieren (typeInfo ist bei vorherigen args schon gesetzt)
					const argsType: CompileTimeType = args.type === 'list'
						? createCompileTimeTupleType(args.values.map(value => (value as ParseExpressionBase).typeInfo?.type ?? { julType: 'any' }))
						: { julType: 'any' };
					dereferencedTypeFromCall = dereferenceArgumentTypesNested(functionType, prefixArgumentType, argsType, inferredTypeFromCall);
				}
			}
			//#endregion
			const typeGuardType = typeGuard?.typeInfo?.type;
			const inferredType = dereferencedTypeFromCall ?? valueOf(typeGuardType);
			// TODO check array type bei spread
			const parameterSymbol = findParameterSymbol(expression, scopes);
			const typeInfo: TypeInfo = { type: inferredType };
			parameterSymbol.typeInfo = typeInfo;
			return typeInfo;
		}
		case 'parameters': {
			expression.singleFields.forEach(field => {
				setInferredType(field, typeContext, parsedDocuments, folder, file, filePath);
			});
			const rest = expression.rest;
			if (rest) {
				setInferredType(rest, typeContext, parsedDocuments, folder, file, filePath);
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
			const narrowedType = foundSymbol && getNarrowedType(narrowedTypes, foundSymbol, []);
			return { type: narrowedType ?? type };
		}
		case 'text': {
			// TODO string template type?
			if (expression.values.every((part): part is TextToken => part.type === 'textToken')) {
				// string literal type
				// TODO sollte hier überhaupt mehrelementiger string möglich sein?
				const rawType: CompileTimeType = {
					julType: 'textLiteral',
					value: expression.values.map(part => part.value).join('\n'),
				};
				return { type: rawType };
			}
			expression.values.forEach(part => {
				if (part.type !== 'textToken') {
					setInferredType(part, typeContext, parsedDocuments, folder, file, filePath);
				}
			});
			return { type: { julType: 'text' } };
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

//#region get Type from FunctionCall

function getReturnTypeFromFunctionCall(
	functionCall: ParseFunctionCall,
	functionExpression: SimpleExpression,
	parsedDocuments: ParsedDocuments,
	folder: string,
	errors: CompilerError[],
): CompileTimeType {
	const prefixArgument = functionCall.prefixArgument;
	const prefixArgumentType = prefixArgument?.typeInfo?.type;
	const argsType = functionCall.arguments?.typeInfo?.type ?? { julType: 'any' };
	// TODO statt functionname functionref value/inferred type prüfen?
	if (functionExpression.type === 'reference') {
		const functionName = functionExpression.name.name;
		switch (functionName) {
			case 'import': {
				const { path, error } = getPathFromImport(functionCall, folder);
				if (error) {
					errors.push(error);
				}
				if (!path) {
					return { julType: 'any' };
				}
				// TODO get full path, get type from parsedfile
				const fullPath = join(folder, path);
				const importedFile = parsedDocuments[fullPath]?.checked;
				if (!importedFile) {
					return { julType: 'any' };
				}
				// definitions import
				// a dictionary containing all definitions is imported
				if (Object.keys(importedFile.symbols).length) {
					const importedTypes = mapDictionary(importedFile.symbols, symbol => {
						const symbolType: CompileTimeType = symbol.typeInfo
							? symbol.typeInfo.type
							: { julType: 'any' };
						return symbolType;
					});
					// TODO exrepssion, filePath?
					return createCompileTimeDictionaryLiteralType(importedTypes, true);
				}
				// value import
				// the last expression is imported
				if (!importedFile.expressions) {
					return { julType: 'any' };
				}
				const lastExpression = last(importedFile.expressions);
				if (!lastExpression) {
					return { julType: 'any' };
				}
				return lastExpression.typeInfo
					? lastExpression.typeInfo.type
					: { julType: 'any' };
			}
			case 'And': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					// TODO unknown?
					return { julType: 'any' };
				}
				return createCompileTimeTypeOfType(createNormalizedIntersectionType(argTypes.map(valueOf)));
			}
			case 'ElementAt': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				const sourceType = argTypes?.[0];
				const indexType = argTypes?.[1];
				if (!sourceType
					|| !indexType) {
					return { julType: 'any' };
				}
				const elementType = dereferenceNestedKeyFromObject(valueOf(indexType), valueOf(sourceType));
				return createCompileTimeTypeOfType(elementType ?? { julType: 'any' });
			}
			case 'LengthOf': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				const sourceType = argTypes?.[0];
				if (!sourceType) {
					return { julType: 'any' };
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
					return { julType: 'any' };
				}
				return createCompileTimeTypeOfType(
					withElementAtFromTypes(valueOf(sourceType), valueOf(indexType), valueOf(valueType)));
			}
			case 'Range': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				const startType = argTypes?.[0];
				if (!startType) {
					return { julType: 'any' };
				}
				const endType = argTypes?.[1] ?? { julType: 'empty' } as CompileTimeType;
				return createCompileTimeTypeOfType(
					createCompileTimeRangeType(valueOf(startType), valueOf(endType)));
			}
			case 'TupleOf': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				const countType = argTypes?.[0];
				const elementType = argTypes?.[1];
				if (!countType
					|| !elementType) {
					return { julType: 'any' };
				}
				return createCompileTimeTypeOfType(
					tupleOfFromTypes(valueOf(countType), valueOf(elementType)));
			}
			case 'Concat': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					return { julType: 'any' };
				}
				return createCompileTimeTypeOfType(
					concatFromTypes(argTypes.map(valueOf)));
			}
			case 'Not': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					// TODO unknown?
					return { julType: 'any' };
				}
				if (!isNonEmpty(argTypes)) {
					// TODO unknown?
					return { julType: 'any' };
				}
				return createCompileTimeTypeOfType(createCompileTimeComplementType(valueOf(argTypes[0])));
			}
			case 'Or': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					// TODO unknown?
					return { julType: 'any' };
				}
				const choices = argTypes.map(valueOf);
				const unionType = createNormalizedUnionType(choices);
				return createCompileTimeTypeOfType(unionType);
			}
			case 'TypeOf': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					// TODO unknown?
					return { julType: 'any' };
				}
				if (!isNonEmpty(argTypes)) {
					// TODO unknown?
					return { julType: 'any' };
				}
				return createCompileTimeTypeOfType(argTypes[0]);
			}
			case 'Greater': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					// TODO unknown?
					return { julType: 'any' };
				}
				if (!isNonEmpty(argTypes)) {
					// TODO unknown?
					return { julType: 'any' };
				}
				return createCompileTimeTypeOfType(createCompileTimeGreaterType(valueOf(argTypes[0])));
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
 * Elemente, die ein Spread in ein List-Literal einbringt, und ob dadurch die Gesamtlaenge
 * unbestimmt wird (dann muss das Literal zur List werden statt zum Tuple). `Or([] List(X))`
 * (Idiom fuer eine moeglicherweise leere Liste) muss dafuer durch seine Choices hindurchschauen:
 * unterschiedliche Laengen zwischen den Choices bedeuten ebenfalls eine unbestimmte Gesamtlaenge.
 */
function getSpreadElementTypes(
	sourceType: CompileTimeType,
): { elementTypes: CompileTimeType[]; isListSpread: boolean; } | undefined {
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
function dereferenceRangeFromObject(
	range: CompileTimeRangeType,
	source: CompileTimeType,
): CompileTimeType | undefined {
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
			return { julType: 'empty' };
		case 'or': {
			const choices = source.ChoiceTypes
				.map(choice => dereferenceRangeFromObject(range, choice))
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
				return { julType: 'empty' };
			}
			return createCompileTimeTupleType(source.ElementTypes.slice(clampedFrom - 1, clampedTo));
		}
		case 'list': {
			const sliced = createCompileTimeListType(source.ElementType);
			return rangeCoversFirstPosition(start, end)
				? sliced
				: createNormalizedUnionType([{ julType: 'empty' }, sliced]);
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
function rangeCoversFirstPosition(start: CompileTimeType, end: CompileTimeType): boolean {
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
 * Count Positionen vom Typ ElementType. Nur bei literalem Count steht die Laenge fest und das
 * Ergebnis ist ein Tuple; sonst bleibt nur "eine Liste davon".
 */
function tupleOfFromTypes(
	countType: CompileTimeType,
	elementType: CompileTimeType,
): CompileTimeType {
	// Eine Laenge ueber einer noch offenen Quelle kann sich zum Literal auflösen (Tuple), eine
	// ueber einer bekannten List dagegen nie - nur im ersten Fall lohnt das Warten.
	const countCanBecomeLiteral = isUnresolvedPlaceholderType(countType)
		|| (countType.julType === 'lengthOf' && isUnresolvedPlaceholderType(countType.Source));
	if (countCanBecomeLiteral) {
		return createCompileTimeTupleOfType(countType, elementType);
	}
	switch (countType.julType) {
		case 'integerLiteral': {
			const count = Number(countType.value);
			if (count < 1) {
				return { julType: 'empty' };
			}
			return createCompileTimeTupleType(new Array(count).fill(elementType));
		}
		case 'or': {
			const countChoices = countType.ChoiceTypes.map(countChoice =>
				tupleOfFromTypes(countChoice, elementType));
			return createNormalizedUnionType(countChoices);
		}
		default:
			return createCompileTimeListType(elementType);
	}
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
	// Or-Quelle zuerst verteilen (Fund: Or([] List(X)) ist das Idiom fuer eine moeglicherweise
	// leere Liste, CLAUDE.md) - sonst gilt eine Quelle mit unbestimmter Laenge faelschlich als
	// nicht auflösbar. Analog zu tupleOfFromTypes' 'or'-Fall bei Count.
	const orIndex = sourceTypes.findIndex(source => valueOf(source).julType === 'or');
	if (orIndex !== -1) {
		const orSource = valueOf(sourceTypes[orIndex]!);
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
		// TypeOf(X) faellt hier zu X, sonst wuerde z.B. Concat(TypeOf(a) TypeOf(b)) nie greifen.
		const source = valueOf(rawSource);
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
			: createCompileTimeListType({ julType: 'never' });
	}
	return elementTypes.length
		? createCompileTimeTupleType(elementTypes)
		: { julType: 'empty' };
}

function getLengthFromType(argType: CompileTimeType | undefined): CompileTimeType {
	if (!argType) {
		// TODO non negative
		return { julType: 'integer' };
	}
	switch (argType.julType) {
		case 'empty':
			return {
				julType: 'integerLiteral',
				value: 0n
			};
		case 'tuple':
			return {
				julType: 'integerLiteral',
				value: BigInt(argType.ElementTypes.length)
			};
		case 'list':
			return createCompileTimeLengthOfType(argType);
		case 'or': {
			const lengthChoices = argType.ChoiceTypes.map(getLengthFromType);
			return createNormalizedUnionType(lengthChoices);
		}
		case 'parameterReference':
			return createCompileTimeLengthOfType(argType);
		default:
			// TODO non negative
			return { julType: 'integer' };
	}
}

/**
 * Source mit Value an Position Index. Faltet so weit, wie die Position feststeht; solange Quelle
 * oder Index noch Platzhalter sind, bleibt der Knoten stehen und wird am Aufruf erneut gefaltet.
 */
function withElementAtFromTypes(
	sourceType: CompileTimeType,
	indexType: CompileTimeType,
	valueType: CompileTimeType,
): CompileTimeType {
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
			// setElement legt die Liste erst an: übrig bleibt genau der gesetzte Wert.
			return createCompileTimeTupleType([valueType]);
		case 'tuple': {
			if (indexType.julType === 'integerLiteral') {
				const elementTypes = [...sourceType.ElementTypes];
				elementTypes[Number(indexType.value) - 1] = valueType;
				return createCompileTimeTupleType(elementTypes);
			}
			// Ohne feste Position kann es jede getroffen haben.
			return createCompileTimeTupleType(sourceType.ElementTypes.map(elementType =>
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
			return { julType: 'any' };
	}
}

//#endregion Sequenz Arithmetik

//#region Typ Arithmetik

/**
 * Choices, die sicher nicht ohne Weiteres auflösbar sind - werden nie verworfen und verwerfen
 * auch nichts, damit die Elimination im Zweifel keine Information wegwirft (Prinzip Freiheit).
 * Rekursiv, denn ein Platzhalter bleibt unauflösbar, auch wenn er nicht an oberster Stelle steht
 * (z.B. And(nestedReference Integer) aus einer Verengung) - getTypeError behandelt
 * parameterReference/nestedReference permissiv (immer "kein Fehler"), das würde sonst hier eine
 * Elimination vortäuschen, die den Platzhalter-Anteil verwirft, bevor er aufgelöst ist.
 */
function isUnresolvedPlaceholderType(type: CompileTimeType): boolean {
	switch (type.julType) {
		case 'parameterReference':
		case 'nestedReference':
		// Der Knoten entsteht nur, wenn die Faltung nicht durchkam - er wartet also noch.
		case 'withElementAt':
			return true;
		case 'range':
			return isUnresolvedPlaceholderType(type.Start) || isUnresolvedPlaceholderType(type.End);
		case 'tupleOf':
			return true;
		case 'concat':
			return type.Sources.some(isUnresolvedPlaceholderType);
		case 'and':
		case 'or':
			return type.ChoiceTypes.some(isUnresolvedPlaceholderType);
		case 'not':
			return isUnresolvedPlaceholderType(type.SourceType);
		case 'typeOf':
			return isUnresolvedPlaceholderType(type.value);
		case 'list':
		case 'dictionary':
			return isUnresolvedPlaceholderType(type.ElementType);
		case 'stream':
			return isUnresolvedPlaceholderType(type.ValueType);
		case 'greater':
			return isUnresolvedPlaceholderType(type.Value);
		case 'tuple':
			return type.ElementTypes.some(isUnresolvedPlaceholderType);
		case 'function':
			return isUnresolvedPlaceholderType(type.ParamsType) || isUnresolvedPlaceholderType(type.ReturnType);
		default:
			return false;
	}
}

/**
 * Entfernt Choices, die bereits Teilmenge eines anderen Choice in derselben Liste sind:
 * Or(Boolean False) => [Boolean]. Bei struktureller Gleichwertigkeit (a Teilmenge von b und b
 * Teilmenge von a) gewinnt der frühere Index - sollte durch die Duplikat-Entfernung davor aber
 * ohnehin nicht mehr vorkommen.
 */
function removeSubtypes(choices: CompileTimeType[]): CompileTimeType[] {
	return choices.filter((choice, index) => {
		if (isUnresolvedPlaceholderType(choice)) {
			return true;
		}
		return !choices.some((otherChoice, otherIndex) => {
			if (index === otherIndex
				|| isUnresolvedPlaceholderType(otherChoice)) {
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
	const flatChoices: CompileTimeType[] = choiceTypes.filter(choiceType =>
		!isUnionType(choiceType));
	const unionChoices = choiceTypes.filter(isUnionType);
	unionChoices.forEach(union => {
		flatChoices.push(...union.ChoiceTypes);
	});
	//#endregion flatten UnionTypes
	if (flatChoices.some(choice => choice.julType === 'any')) {
		return { julType: 'any' };
	}
	//#region remove Never
	const choicesWithoutNever = flatChoices.filter(choice =>
		choice.julType !== 'never');
	if (!choicesWithoutNever.length) {
		return { julType: 'never' };
	}
	if (choicesWithoutNever.length === 1) {
		return choicesWithoutNever[0]!;
	}
	//#endregion remove Never
	//#region remove duplicates
	const uniqueChoices: CompileTimeType[] = [];
	choicesWithoutNever.forEach(choice => {
		if (!uniqueChoices.some(uniqueChoice =>
			typeEquals(choice, uniqueChoice))) {
			uniqueChoices.push(choice);
		}
	});
	if (uniqueChoices.length === 1) {
		return uniqueChoices[0]!;
	}
	//#endregion remove duplicates
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
			createCompileTimeStreamType(collapsedValueType),
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
	return {
		julType: 'or',
		ChoiceTypes: collapsedStreamChoices,
	};
}

function createNormalizedIntersectionType(ChoiceTypes: CompileTimeType[]): CompileTimeType {
	// TODO flatten nested IntersectionTypes?

	if (ChoiceTypes.length === 2) {
		const first = ChoiceTypes[0]!;
		const second = ChoiceTypes[1]!;

		// Never ist das absorbierende Element:
		// And(A Never) => Never
		if (first.julType === 'never'
			|| second.julType === 'never') {
			return { julType: 'never' };
		}

		// Any ist das neutrale Element:
		// And(A Any) => A
		if (first.julType === 'any') {
			return second;
		}
		if (second.julType === 'any') {
			return first;
		}
	}

	// Distributivgesetz anwenden:
	// And(Or(A B) C) => Or(And(A C) And(B C)
	if (ChoiceTypes.length === 2) {
		// beide Seiten prüfen, damit die Reihenfolge der Argumente egal ist
		const unionIndex = ChoiceTypes.findIndex(isUnionType);
		if (unionIndex >= 0) {
			const unionType = ChoiceTypes[unionIndex] as CompileTimeUnionType;
			const otherIntersectionType = ChoiceTypes[unionIndex ? 0 : 1]!;
			const distributedChoices = unionType.ChoiceTypes.map(choice => {
				return createNormalizedIntersectionType([choice, otherIntersectionType]);
			});
			const distributedType = createNormalizedUnionType(distributedChoices);
			return distributedType;
		}
	}

	if (ChoiceTypes.length === 2
		&& isComplementType(ChoiceTypes[1])) {
		const first = ChoiceTypes[0]!;
		const second = ChoiceTypes[1].SourceType;
		if (typeEquals(first, second)) {
			// And(A Not(A)) => Never
			return { julType: 'never' };
		}
		// And(A Not(B))
		// Wenn B keine Schnittmenge mit A hat: nur A liefern
		const secondAssignToFirstError = areArgsAssignableTo(undefined, second, first);
		if (secondAssignToFirstError) {
			return first;
		}
	}

	if (ChoiceTypes.length === 2) {
		const first = ChoiceTypes[0]!;
		const second = ChoiceTypes[1]!;

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
				keys.forEach(key => {
					const firstFieldType = first.Fields[key];
					const secondFieldType = second.Fields[key];
					mergedFields[key] = firstFieldType && secondFieldType
						? createNormalizedIntersectionType([firstFieldType, secondFieldType])
						: firstFieldType ?? secondFieldType!;
				});
				return createCompileTimeDictionaryLiteralType(mergedFields, first.complete || second.complete);
			}
			if (typesOverlap(first, second) === false) {
				return { julType: 'never' };
			}
			return {
				julType: 'and',
				ChoiceTypes: ChoiceTypes,
			};
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
			return { julType: 'never' };
		}
	}

	return {
		julType: 'and',
		ChoiceTypes: ChoiceTypes,
	};
}

/**
 * Sagt getTypeError für diesen Typ überhaupt etwas aus?
 * Für any, nestedReference, parameterReference und parameters ist die Prüfung bewusst permissiv,
 * "kein Fehler" heißt dort also nicht "ist zuweisbar". Wer aus einem ausbleibenden Fehler etwas
 * folgert, muss diese Typen ausnehmen.
 */
function hasReliableTypeError(type: CompileTimeType): boolean {
	switch (type.julType) {
		case 'any':
		case 'nestedReference':
		case 'parameterReference':
		case 'parameters':
			return false;
		default:
			return true;
	}
}

/**
 * Die grobe Laufzeit-Familie eines Typs. Werte aus verschiedenen Familien sind disjunkt,
 * ihr Schnitt ist also leer.
 * undefined = Familie unbekannt, dann ist keine Aussage über Disjunktheit möglich.
 */
function getTypeFamily(type: CompileTimeType): string | undefined {
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
		case 'list':
		case 'tuple':
			return 'list';
		case 'stream':
			return 'stream';
		case 'text':
		case 'textLiteral':
			return 'text';
		// greater kann Integer oder Float sein, daher keine Aussage
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
function typesOverlap(first: CompileTimeType, second: CompileTimeType): boolean | undefined {
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
	// getTypeFamily ordnet 'greater' keiner Familie zu (Integer oder Float moeglich) - daher
	// hier vorab behandeln, bevor die Familienpruefung mit undefined aufgibt.
	if (first.julType === 'greater') {
		return greaterOverlapsWith(first, second);
	}
	if (second.julType === 'greater') {
		return greaterOverlapsWith(second, first);
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
		// strukturierte Typen derselben Familie können sich beliebig überschneiden,
		// z.B. enthalten List(Integer) und List(Text) beide die leere Liste
		case 'dictionary':
		case 'function':
		case 'list':
		case 'stream':
			return undefined;
		default:
			// zwei Basistypen derselben Familie, z.B. Integer und Integer
			return true;
	}
	//#endregion gleiche Familie
}

/**
 * Greater(Value) ist nach oben unbeschraenkt - Ueberlappung ist daher nur bei gleichem
 * Literaltyp (Integer/Integer oder Float/Float) entscheidbar, sonst undefined.
 */
function greaterOverlapsWith(greater: CompileTimeGreaterType, other: CompileTimeType): boolean | undefined {
	switch (other.julType) {
		case 'greater':
			// Beide nach oben unbeschraenkt - es gibt immer einen gemeinsamen groesseren Wert.
			return true;
		case 'integerLiteral':
		case 'floatLiteral':
			return greater.Value.julType === other.julType
				? other.value > greater.Value.value
				: undefined;
		case 'integer':
			return greater.Value.julType === 'integerLiteral'
				? true
				: undefined;
		case 'float':
			return greater.Value.julType === 'floatLiteral'
				? true
				: undefined;
		default:
			return undefined;
	}
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

function isLiteralType(type: CompileTimeType): boolean {
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

function typeEquals(first: CompileTimeType, second: CompileTimeType): boolean {
	if (first === second) {
		return true;
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
		case 'greater':
			return second.julType === 'greater'
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
				&& typeEquals(first.ValueType, second.ValueType);
		case 'typeOf':
			return second.julType === 'typeOf'
				&& typeEquals(first.value, second.value);
		case 'function':
			return second.julType === 'function'
				&& typeEquals(first.ParamsType, second.ParamsType)
				&& typeEquals(first.ReturnType, second.ReturnType)
				&& first.pure === second.pure;
		case 'withElementAt':
			return second.julType === 'withElementAt'
				&& typeEquals(first.Source, second.Source)
				&& typeEquals(first.Index, second.Index)
				&& typeEquals(first.Value, second.Value);
		case 'range':
			return second.julType === 'range'
				&& typeEquals(first.Start, second.Start)
				&& typeEquals(first.End, second.End);
		case 'tupleOf':
			return second.julType === 'tupleOf'
				&& typeEquals(first.Count, second.Count)
				&& typeEquals(first.ElementType, second.ElementType);
		case 'concat':
			return second.julType === 'concat'
				&& first.Sources.length === second.Sources.length
				&& first.Sources.every((source, i) => typeEquals(source, second.Sources[i]!));
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
				&& first.index === second.index;
		case 'nestedReference':
			return second.julType === 'nestedReference'
				&& nestedKeysEqual(first.nestedKey, second.nestedKey)
				&& typeEquals(first.source, second.source);
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
		default:
			const assertNever: never = first;
			throw new Error('Unexpected julType: ' + (assertNever as CompileTimeType).julType);
	}
}

//#endregion Typ Arithmetik

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
 * true, wenn kein Wert dieses Typs eine Argumentkollektion sein kann.
 * Empty gehört dazu (der Aufruf ohne Argumente) und fällt daher nicht darunter.
 * Im Zweifel false: nicht aufgelöste Typen und Never bleiben ungemeldet.
 */
function isDefinitelyNotCollectionType(type: CompileTimeType): boolean {
	switch (type.julType) {
		case 'blob':
		case 'boolean':
		case 'booleanLiteral':
		case 'date':
		case 'float':
		case 'floatLiteral':
		case 'function':
		case 'greater':
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

function valueOf(type: CompileTimeType | undefined): CompileTimeType {
	if (!type) {
		return { julType: 'any' };
	}
	switch (type.julType) {
		case 'dictionaryLiteral': {
			const fieldValues = mapDictionary(type.Fields, valueOf);
			return createCompileTimeDictionaryLiteralType(fieldValues, type.complete);
		}
		case 'function':
			// TODO?
			return type;
		case 'nestedReference':
			// TODO?
			return type;
		case 'parameters':
			return type;
		case 'parameterReference':
			// TODO wo deref? wo Type => value auspacken?
			return type;
		case 'stream':
			// TODO?
			return type;
		case 'tuple':
			return {
				julType: 'tuple',
				ElementTypes: type.ElementTypes.map(valueOf)
			};
		case 'typeOf':
			return type.value;
		default:
			// TODO error?
			// return { julType: 'any' };
			return type;
	}
}

//#region TypeError

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
	checkerStats.getTypeError++;
	if (targetType.julType === 'any') {
		return undefined;
	}
	if (argumentsType.julType === 'any') {
		// TODO error/warning bei any?
		// error type bei assignment/function call?
		// maybe return value?
		return undefined;
	}
	if (argumentsType === targetType) {
		return undefined;
	}
	switch (argumentsType.julType) {
		case 'and': {
			if (targetType.julType === 'and') {
				// Erst das target zerlegen, das ist exakt: der Wert muss zu jedem target Choice
				// passen. Sonst müsste ein einzelner args Choice für das ganze target reichen,
				// was z.B. And(Integer Greater(0)) gegen And(Integer Not(0)) fälschlich ablehnt.
				break;
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
					return getTypeError(prefixArgumentType, dereferencedArgumentsType, targetType);
				}
				// Choices, die sich zum selben Typ auflösen, liefern dieselbe Meldung
				const uniqueMessages = [...new Set(subErrors.map(typeErrorToString))];
				return {
					// TODO error struktur überdenken
					message: uniqueMessages.join('\n'),
					// innerError
				};
			}
			return undefined;
		}
		case 'nestedReference':
			// TODO?
			return undefined;
		case 'lengthOf': {
			// Source ist nur dann garantiert schon der reine list-Zweig (nie Empty), wenn
			// getLengthFromType sie bereits aufgesplittet hat. Bei einer hier noch unaufgelösten
			// Source (z.B. parameterReference, weil argsType bewusst ungeprüft bleibt, siehe
			// Aufrufer) gilt das nicht automatisch - erst auflösen und ggf. neu aufsplitten,
			// bevor NonZeroInteger unterstellt wird.
			const resolvedSource = resolvePlaceholders(argumentsType.Source);
			if (resolvedSource !== argumentsType.Source) {
				const resolvedLength = getLengthFromType(resolvedSource);
				if (!typeEquals(resolvedLength, argumentsType)) {
					return getTypeError(prefixArgumentType, resolvedLength, targetType);
				}
			}
			return getTypeError(prefixArgumentType, CompileTimeNonZeroInteger, targetType);
		}
		case 'not': {
			// Not(X) heißt "alles außer X" - das ist nur dann unzulässig, wenn das target
			// ausschließlich X-Werte zulässt (target Teilmenge von X), der Wert also garantiert
			// ausgeschlossen wäre. Sonst permissiv, wie bei Any: wir wissen nichts Genaueres.
			// isNotAssignableTo traegt den hasReliableTypeError-Guard schon (undefined bei
			// unaufgeloesten/generischen Zielen), das wird hier mitgenutzt statt dupliziert.
			if (isNotAssignableTo(targetType, argumentsType.SourceType) === false) {
				return {
					message: `Can not assign ${typeToString(argumentsType, 0, 0)} to ${typeToString(targetType, 0, 0)}.`,
				};
			}
			return undefined;
		}
		case 'or': {
			// alle args Choices müssen zum target passen
			const subErrors = argumentsType.ChoiceTypes.map(choiceType =>
				getTypeError(prefixArgumentType, choiceType, targetType)).filter(isDefined);
			if (subErrors.length) {
				return {
					// TODO error struktur überdenken
					message: subErrors.map(typeErrorToString).join('\n'),
					// innerError
				};
			}
			return undefined;
		}
		case 'parameterReference': {
			const dereferencedParameterType = dereferenceParameterTypeFromFunctionRef(argumentsType);
			if (!dereferencedParameterType) {
				return undefined;
			}
			return getTypeError(prefixArgumentType, dereferencedParameterType, targetType);
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
					// TODO error struktur überdenken
					message: subErrors.map(typeErrorToString).join('\n'),
					// innerError
				};
			}
			return undefined;
		}
		case 'blob':
			break;
		case 'boolean':
			switch (argumentsType.julType) {
				case 'boolean':
					return undefined;
				case 'booleanLiteral':
					return undefined;
				default:
					break;
			}
			break;
		case 'booleanLiteral':
			if (typeEquals(argumentsType, targetType)) {
				return undefined;
			}
			break;
		case 'date':
			break;
		case 'dictionary': {
			const elementType = targetType.ElementType;
			switch (argumentsType.julType) {
				case 'dictionary': {
					const subError = getTypeError(prefixArgumentType, argumentsType.ElementType, elementType);
					return subError;
				}
				case 'dictionaryLiteral': {
					const subErrors = map(
						argumentsType.Fields,
						(fieldType, fieldName) => {
							// TODO the field x is missing error?
							return getDictionaryFieldError(fieldName, elementType, prefixArgumentType, fieldType);
						},
					).filter(isDefined);
					if (!subErrors.length) {
						return undefined;
					}
					return {
						// TODO error struktur überdenken
						message: subErrors.map(typeErrorToString).join('\n'),
						// innerError
					};
				}
				default:
					// TODO type specific error?
					break;
			}
			break;
		}
		case 'dictionaryLiteral': {
			const error = getDictionaryLiteralTypeError(prefixArgumentType, argumentsType, targetType.Fields);
			if (error === true) {
				// Standardfehler
				break;
			}
			if (!error) {
				return undefined;
			}
			// targetType mit depth=1, damit z.B. GameBoard als kurzer Alias erscheint statt
			// voll ausgeschrieben (typeToString zeigt Aliase nur ab depth>0). argumentsType
			// dagegen mit suppressAlias=true: sein aliasName ist der Name der Definition, die
			// den Wert haelt (z.B. "newGameState"), kein Typname - der wuerde hier faelschlich
			// als Typ erscheinen, auch bei verschachtelten Feldern (Fund newBoard, s.o.).
			// Wuerde diese Kopfzeile selbst mehrzeilig rendern (z.B. weil ein Feld einen
			// groesseren verschachtelten Typ enthaelt), traegt sie neben der folgenden
			// "Invalid value for field"-Kette nichts bei und lenkt vom eigentlichen Fehler ab
			// (Fund im echten yugioh-Fehlerbild, Session 2026-09-10) - dann faellt sie ganz weg.
			// Entscheidung anhand des tatsaechlich gerenderten Textes, bevor er mit dem Detail
			// verklebt wird, statt den fertigen String spaeter wieder aufzutrennen.
			const header = `Can not assign ${typeToString(argumentsType, 0, 0, true)} to ${typeToString(targetType, 0, 1)}.`;
			if (header.includes('\n')) {
				return error;
			}
			return {
				message: `${header}\n${indentLines(error.message)}`,
			};
		}
		case 'empty':
			if (argumentsType.julType === 'empty') {
				return undefined;
			}
			break;
		case 'error':
			break;
		case 'float':
			switch (argumentsType.julType) {
				case 'float':
					return undefined;
				case 'floatLiteral':
					return undefined;
				default:
					break;
			}
			break;
		case 'floatLiteral':
			if (typeEquals(argumentsType, targetType)) {
				return undefined;
			}
			break;
		case 'function': {
			// TODO types als function interpretieren?
			if (!isFunctionType(argumentsType)) {
				break;
			}
			// Kontravarianz: Funktionstyp-Subtyping dreht die Richtung bei Parametern um.
			// - Parameter: argumentsType.ParamsType muss Obermenge von targetType.ParamsType sein.
			//   Grund: Wer weniger Parameter fordert, ist überall einsetzbar. Eine Funktion f(x)
			//   passt überall wo eine Funktion g(x, y) verlangt wird, wenn f weniger Parameter
			//   braucht als targetType.ParamsType — der Aufrufer kann einfach weniger übergeben.
			// - Return-Type: Normale Richtung (Kovarianz).
			//   argumentsType.ReturnType muss Teilmenge von targetType.ReturnType sein,
			//   weil der Rückgabewert das erfüllen muss, was die Zielposition erwartet.
			const paramsError = getTypeError(prefixArgumentType, argumentsType.ParamsType, targetType.ParamsType);
			if (paramsError) {
				return paramsError;
			}
			return getTypeError(prefixArgumentType, argumentsType.ReturnType, targetType.ReturnType);
		}
		case 'greater': {
			const greaterValue = targetType.Value;
			if (((greaterValue.julType === 'integerLiteral'
				&& argumentsType.julType === 'integerLiteral')
				|| (greaterValue.julType === 'floatLiteral'
					&& argumentsType.julType === 'floatLiteral'))
				&& argumentsType.value > greaterValue.value) {
				return undefined;
			}
			break;
		}
		case 'integer':
			switch (argumentsType.julType) {
				case 'integer':
					return undefined;
				case 'integerLiteral':
					return undefined;
				default:
					break;
			}
			break;
		case 'integerLiteral':
			if (typeEquals(argumentsType, targetType)) {
				return undefined;
			}
			break;
		case 'list': {
			const targetElementType = targetType.ElementType;
			switch (argumentsType.julType) {
				case 'list': {
					const elementError = getTypeError(prefixArgumentType, argumentsType.ElementType, targetElementType);
					if (!elementError) {
						return undefined;
					}
					// Ohne Huelle stand der Element-Fehler roh neben anderen Or-Choice-Fehlern,
					// ohne erkennbaren Bezug zur umschliessenden Liste (Fund im echten
					// yugioh-Fehlerbild, Session 2026-09-10) - analog zum dictionaryLiteral-Fall.
					return {
						message: `Can not assign ${typeToString(argumentsType, 0, 0, true)} to ${typeToString(targetType, 0, 1)}.\n${indentLines(elementError.message)}`,
					};
				}
				case 'tuple':
					const subErrors = argumentsType.ElementTypes.map(valueElement =>
						getTypeError(prefixArgumentType, valueElement, targetElementType)).filter(isDefined);
					if (subErrors.length) {
						// Mehrere Tupel-Elemente mit demselben Zieltyp erzeugen sonst dieselbe
						// Meldung mehrfach hintereinander - dedup wie in getTupleTypeError2.
						const uniqueMessages = [...new Set(subErrors.map(typeErrorToString))];
						return {
							// TODO error struktur überdenken
							message: uniqueMessages.join('\n'),
							// innerError
						};
					}
					return undefined;
				default:
					break;
			}
			break;
		}
		case 'nestedReference':
			// TODO?
			return undefined;
		case 'never':
			break;
		case 'not': {
			// Der Wert darf den SourceType nicht überlappen. Zuweisbarkeit genügt hier nicht:
			// Integer ist keine Teilmenge von 0, enthält 0 aber und ist damit unzulässig.
			// Bei unbekannter Überlappung wird nichts gemeldet.
			if (typesOverlap(argumentsType, targetType.SourceType)) {
				return {
					message: `Can not assign ${typeToString(argumentsType, 0, 0)} to ${typeToString(targetType, 0, 0)}.`,
				};
			}
			return undefined;
		}
		case 'or': {
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
					const asLiteralUnion: CompileTimeType = {
						julType: 'or',
						ChoiceTypes: [
							{ julType: 'booleanLiteral', value: true },
							{ julType: 'booleanLiteral', value: false },
						],
					};
					return getTypeError(prefixArgumentType, asLiteralUnion, targetType);
				}
				// Best-Match statt Alle-Choices-Dump (TS/Flow-Vorbild, Fund im echten
				// yugioh-Fehlerbild, Session 2026-09-10): nur den strukturell naechsten Choice
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
						message: `Can not assign ${typeToString(argumentsType, 0, 0, true)} to ${typeToString(targetType, 0, 1)}.\n${indentLines(typeErrorToString(closestError))}`,
					};
				}
				return {
					// TODO error struktur überdenken
					message: subErrors.map(typeErrorToString).join('\n'),
					// innerError
				};
			}
			return undefined;
		}
		case 'parameters':
			return getTypeErrorForParameters(prefixArgumentType, argumentsType, targetType);
		case 'parameterReference': {
			// TODO
			// const dereferenced = dereferenceArgumentType(null as any, targetType);
			// return getTypeError(valueType, dereferenced ?? { julType: 'any' });
			return undefined;
		}
		case 'stream': {
			if (!isStreamType(argumentsType)) {
				break;
			}
			return getTypeError(prefixArgumentType, argumentsType.ValueType, targetType.ValueType);
		}
		case 'text':
			switch (argumentsType.julType) {
				case 'text':
					return undefined;
				case 'textLiteral':
					return undefined;
				default:
					break;
			}
			break;
		case 'textLiteral': {
			if (typeEquals(argumentsType, targetType)) {
				return undefined;
			}
			break;
		}
		case 'tuple': {
			const error = getTupleTypeError(prefixArgumentType, argumentsType, targetType.ElementTypes);
			if (error === true) {
				// Standardfehler
				break;
			}
			return error;
		}
		case 'type':
			switch (argumentsType.julType) {
				case 'boolean':
				case 'booleanLiteral':
				case 'empty':
				case 'float':
				case 'floatLiteral':
				case 'integer':
				case 'integerLiteral':
				case 'text':
				case 'textLiteral':
				case 'type':
				case 'typeOf':
					return undefined;
				case 'tuple': {
					// alle ElementTypes müssen Typen sein
					const subErrors = argumentsType.ElementTypes.map(elementType =>
						getTypeError(undefined, elementType, targetType)).filter(isDefined);
					if (subErrors.length) {
						return {
							// TODO error struktur überdenken
							message: subErrors.map(typeErrorToString).join('\n'),
							// innerError
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
			// In der Oberflaeche nicht konstruierbar, nur zur Vollstaendigkeit des Switches.
			return getTypeError(prefixArgumentType, argumentsType, CompileTimeNonZeroInteger);
		case 'withElementAt':
			// Noch ungefalteter Platzhalter als Ziel: permissiv wie nestedReference, sonst
			// entstuenden Fehler an einem Typ, der noch gar nicht feststeht.
			return undefined;
		case 'range':
			// Nur als Schluessel sinnvoll, nie als Zieltyp einer Zuweisung.
			return undefined;
		case 'tupleOf':
			// Noch ungefalteter Platzhalter als Ziel: permissiv wie nestedReference.
			return undefined;
		case 'concat':
			// Ungefaltete Konkatenation: permissiv wie nestedReference.
			return undefined;
		default: {
			const assertNever: never = targetType;
			throw new Error(`Unexpected targetType.type: ${(assertNever as CompileTimeType).julType}`);
		}
	}
	return { message: `Can not assign ${typeToString(argumentsType, 0, 0)} to ${typeToString(targetType, 0, 0)}.` };
}

/**
 * Liefert true bei Standardfehler, undefined bei keinem Fehler.
 */
function getTupleTypeError(
	prefixArgumentType: CompileTimeType | undefined,
	argumentsType: CompileTimeType,
	targetElementTypes: CompileTimeType[],
): TypeError | true | undefined {
	switch (argumentsType.julType) {
		case 'list':
			if (targetElementTypes.length > 1) {
				return {
					message: `Expected ${targetElementTypes.length} elements, but List may contain less.`,
				};
			}
			return getTypeError(prefixArgumentType, argumentsType.ElementType, targetElementTypes[0]!);
		case 'tuple':
			return getTupleTypeError2(prefixArgumentType, argumentsType.ElementTypes, targetElementTypes);
		default:
			return true;
	}
}

function getTupleTypeError2(
	prefixArgumentType: CompileTimeType | undefined,
	argumentElementTypes: CompileTimeType[],
	targetElementTypes: CompileTimeType[],
): TypeError | undefined {
	// TODO fehler wenn argument mehr elemente entfält als target?
	const subErrors = targetElementTypes.map((targetElementType, index) => {
		const valueElement = argumentElementTypes[index] ?? { julType: 'empty' };
		return getTypeError(prefixArgumentType, valueElement, targetElementType);
	}).filter(isDefined);
	if (subErrors.length) {
		// Fehlende Elemente werden alle zu Empty (s.o.) - bei mehreren fehlenden Elementen mit
		// demselben Zieltyp entstünde sonst dieselbe Meldung mehrfach hintereinander, ohne neue
		// Information je Wiederholung. Dedup wie beim 'and'-Fall oben (new Set über den Text).
		const uniqueMessages = [...new Set(subErrors.map(typeErrorToString))];
		return {
			// TODO error struktur überdenken
			message: uniqueMessages.join('\n'),
			// innerError
		};
	}
	return undefined;
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
			// Fuer ein fehlendes Feld gibt es keinen Wert zum Vergleichen - der erwartete Typ
			// steht bereits an der Zieltyp-Deklaration selbst, ihn hier zusaetzlich auszuschreiben
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
							// unvollstaendigen Dictionary nicht auf, ist das kein Beweis, dass
							// es fehlt.
							return undefined;
						}
						if (isFieldOptional(fieldType, prefixArgumentType)) {
							// Or([] X) ist das Idiom fuer optionale Felder - Weglassen bleibt erlaubt.
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
 * Darf ein Feld dieses Zieltyps im Literal fehlen? Or([] X) ist das Idiom fuer optionale Felder
 * (CLAUDE.md) - Empty erfuellt das Ziel dann bereits, ohne dass es explizit als `feld = []`
 * dastehen muss.
 */
function isFieldOptional(fieldTargetType: CompileTimeType, prefixArgumentType: CompileTimeType | undefined): boolean {
	return !getTypeError(prefixArgumentType, { julType: 'empty' }, fieldTargetType);
}

/**
 * Findet die innerste Position im Quelltext, an der der Zuweisungsfehler tatsaechlich sitzt:
 * steigt durch verschachtelte Dictionary-Literale ab, solange es ein konkretes Feld mit
 * falschem Wert gibt. Ein fehlendes Feld hat keinen Ausdruck zum Zeigen und bricht den Abstieg
 * an dieser Stelle ab - undefined heisst "keine genauere Position als die aufrufende Stelle".
 * Nach dem Vorbild von TypeScript/Rust/Elm: eine Diagnose, eine moeglichst genaue Position,
 * statt einer zweiten Diagnose mit demselben Text an einer weniger genauen Stelle.
 */
function findInnermostErrorPosition(
	value: ParseValueExpression | undefined,
	targetType: CompileTimeType,
): Positioned | undefined {
	if (value?.type === 'list') {
		if (isTupleType(targetType)) {
			return findInnermostElementErrorPosition(value, index => targetType.ElementTypes[index]);
		}
		if (isListType(targetType)) {
			return findInnermostElementErrorPosition(value, () => targetType.ElementType);
		}
		return undefined;
	}
	if (value?.type !== 'dictionary') {
		return undefined;
	}
	if (isDictionaryLiteralType(targetType)) {
		let result: Positioned | undefined;
		map(targetType.Fields, (fieldTargetType, fieldName) => {
			if (result) {
				return;
			}
			result = findInnermostFieldErrorPosition(value, fieldName, fieldTargetType);
		});
		return result;
	}
	if (isDictionaryType(targetType)) {
		const elementType = targetType.ElementType;
		for (const field of value.fields) {
			if (field.type !== 'singleDictionaryField') {
				continue;
			}
			const fieldName = getCheckedEscapableName(field.name);
			if (!fieldName) {
				continue;
			}
			const result = findInnermostFieldErrorPosition(value, fieldName, elementType);
			if (result) {
				return result;
			}
		}
	}
	return undefined;
}

/**
 * Tupel-/Listen-Pendant zu findInnermostFieldErrorPosition: findet das erste Element mit
 * tatsaechlichem Fehler und steigt rekursiv weiter ab, falls das Element selbst wieder ein
 * Literal ist. Ein Spread verschiebt die Zuordnung unbekannt weit (dieselbe Begruendung wie bei
 * getWrittenArguments/getTupleTypeError2) - dann bricht der Abstieg ab, ebenso bei einem
 * fehlenden Element (kein Ausdruck zum Zeigen vorhanden).
 */
function findInnermostElementErrorPosition(
	value: ParseListLiteral,
	getElementTargetType: (index: number) => CompileTimeType | undefined,
): Positioned | undefined {
	if (value.values.some(element => element.type === 'spread')) {
		return undefined;
	}
	for (let index = 0; index < value.values.length; index++) {
		const elementExpression = value.values[index] as ParseValueExpression;
		const elementTargetType = getElementTargetType(index);
		if (!elementTargetType || !elementExpression.typeInfo) {
			continue;
		}
		const elementError = getTypeError(undefined, resolvePlaceholders(elementExpression.typeInfo.type), elementTargetType);
		if (!elementError) {
			continue;
		}
		return findInnermostErrorPosition(elementExpression, elementTargetType) ?? elementExpression;
	}
	return undefined;
}

function findInnermostFieldErrorPosition(
	value: ParseDictionaryLiteral,
	fieldName: string,
	fieldTargetType: CompileTimeType,
): Positioned | undefined {
	const fieldExpression = value.fields.find(field =>
		field.type === 'singleDictionaryField'
		&& getCheckedEscapableName(field.name) === fieldName);
	if (!fieldExpression || fieldExpression.type !== 'singleDictionaryField') {
		return undefined;
	}
	const fieldValue = fieldExpression.value;
	if (!fieldValue?.typeInfo) {
		return undefined;
	}
	const fieldError = getTypeError(undefined, resolvePlaceholders(fieldValue.typeInfo.type), fieldTargetType);
	if (!fieldError) {
		return undefined;
	}
	return findInnermostErrorPosition(fieldValue, fieldTargetType) ?? fieldValue;
}


function getTypeErrorForParameters(
	prefixArgumentType: CompileTimeType | undefined,
	argumentsType: CompileTimeType,
	targetType: ParametersType,
): TypeError | undefined {
	// TODO other cases
	switch (argumentsType.julType) {
		case 'dictionaryLiteral':
			return getTypeErrorForParametersWithCollectionArgs(prefixArgumentType, argumentsType.Fields, targetType);
		case 'empty':
			return getTypeErrorForParametersWithCollectionArgs(prefixArgumentType, undefined, targetType);
		case 'tuple':
			return getTypeErrorForParametersWithCollectionArgs(prefixArgumentType, argumentsType.ElementTypes, targetType);
		case 'parameters': {
			// TODO prefixArgumentType berücksichtigen?
			let index = 0;
			const targetSingleNames = targetType.singleNames;
			const valueSingleNames = argumentsType.singleNames;
			const valueRest = argumentsType.rest;
			const valueRestType = valueRest?.type;
			const valueRestItemType: CompileTimeType | undefined = valueRest
				? isListType(valueRestType)
					? valueRestType.ElementType
					: { julType: 'any' }
				: undefined;
			for (; index < targetSingleNames.length; index++) {
				const targetParameter = targetSingleNames[index]!;
				const targetParameterName = targetParameter.name;
				const targetParameterType = targetParameter.type;
				const valueParameter = valueSingleNames[index];
				if (valueParameter && valueParameter.name !== targetParameterName) {
					return {
						message: `Parameter name mismatch. Got '${valueParameter.name}' but expected '${targetParameterName}'`,
					};
				}
				const valueParameterType: CompileTimeType = valueParameter?.type ?? valueRestItemType ?? { julType: 'any' };
				const error = targetParameterType
					? getTypeError(undefined, valueParameterType, targetParameterType)
					: undefined;
				if (error) {
					// TODO collect inner errors
					return error;
					// return new Error(`Can not assign the value ${value} to param ${name} because it is not of type ${type}`);
				}
			}
			const targetRestType = targetType.rest?.type;
			if (targetRestType) {
				const remainingValueParameters = valueSingleNames.slice(index);
				for (const valueParameter of remainingValueParameters) {
					const valueParameterType = valueParameter.type ?? valueRestItemType ?? { julType: 'any' };
					const error = getTypeError(undefined, valueParameterType, targetRestType);
					if (error) {
						// TODO collect inner errors
						return error;
						// return new Error(`Can not assign the value ${value} to param ${name} because it is not of type ${type}`);
					}
				}
			}
			return undefined;
		}
		default:
			return { message: 'getTypeErrorForParameters not implemented yet for ' + argumentsType.julType };
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
				: argumentsType[name])) ?? { julType: 'empty' };
			argumentIndex++;
		}
		const error = type
			? getTypeError(undefined, argument, type)
			: undefined;
		if (error) {
			// TODO collect inner errors
			return error;
			// return new Error(`Can not assign the value ${value} to param ${name} because it is not of type ${type}`);
		}
	}
	if (rest) {
		const restType = rest.type;
		if (!argumentsType) {
			const remainingArgs: CompileTimeType = hasPrefixArg && !paramIndex
				? { julType: 'tuple', ElementTypes: [prefixArgumentType] }
				: { julType: 'empty' };
			const error = restType
				? getTypeError(undefined, remainingArgs, restType)
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
				? getTypeError(undefined, { julType: 'tuple', ElementTypes: remainingArgs }, restType)
				: undefined;
			if (error) {
				// TODO collect inner errors
				return error;
				// return new Error(`Can not assign the value ${remainingArgs} to rest param because it is not of type ${rest}`);
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
 * Rueckt jede Zeile eines mehrzeiligen Fehlertexts eine Ebene tiefer - fuer verschachtelte
 * Dictionary-Felder, damit die Tiefe beim Lesen sichtbar ist (TypeScript-Vorbild), statt nur
 * ueber die Abfolge von Typ-Mismatch/Feldname-Zeilen erschlossen werden zu muessen.
 */
function indentLines(text: string): string {
	return text.split('\n').map(line => `${indentUnit}${line}`).join('\n');
}

//#endregion TypeError

//#region ToString

// TODO expand ReferenceType 1 level deep?
// suppressAlias unterdrueckt aliasName in der gesamten Rekursion, nicht nur an der Aufrufstelle -
// noetig, um einen Wert zu beschreiben (der Alias ist dort immer nur der Name der Definition,
// die den Wert haelt, nie ein echter Typname; siehe Fund newGameState/newBoard, Session 2026-09-10).
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
			return `${paramsString} :> ${returnString}`;
		}
		case 'greater':
			return `Greater(${typeToString(type.Value, indent, depth + 1, suppressAlias)})`;
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
			return `Stream(${typeToString(type.ValueType, indent, depth + 1, suppressAlias)})`;
		case 'text':
			return 'Text';
		case 'textLiteral':
			return `§${type.value.replaceAll('§', '§§')}§`;
		case 'tuple':
			return arrayTypeToString(type.ElementTypes, indent, depth + 1, suppressAlias);
		case 'withElementAt':
			return `WithElementAt(${typeToString(type.Source, indent, depth + 1, suppressAlias)} ${typeToString(type.Index, indent, depth + 1, suppressAlias)} ${typeToString(type.Value, indent, depth + 1, suppressAlias)})`;
		case 'range':
			return `Range(${typeToString(type.Start, indent, depth + 1, suppressAlias)} ${typeToString(type.End, indent, depth + 1, suppressAlias)})`;
		case 'tupleOf':
			return `TupleOf(${typeToString(type.Count, indent, depth + 1, suppressAlias)} ${typeToString(type.ElementType, indent, depth + 1, suppressAlias)})`;
		case 'concat':
			return `Concat(${type.Sources.map((source, i) =>
				i > 0 ? ' ' + typeToString(source, indent, depth + 1, suppressAlias) : typeToString(source, indent, depth + 1, suppressAlias)).join('')})`;
		case 'type':
			return 'Type';
		case 'typeOf':
			return `TypeOf(${typeToString(type.value, indent, depth, suppressAlias)})`;
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
 * umhuellenden "Can not assign X to Y."-Fehlerzeile zu entscheiden, ob X selbst ausgeschrieben
 * werden wuerde (dann traegt die Huelle nichts bei, was die Feld-Kette nicht ohnehin zeigt).
 * Eine Quelle statt zweier, die auseinanderlaufen koennten.
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
	// sobald dieser Dump in eine bereits eingerueckte Fehlerkette eingebettet wird (Fund im
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
	if (isFunctionType(possibleFunctionType)) {
		return possibleFunctionType.ParamsType;
	}
	return { julType: 'any' };
}

function getReturnTypeFromFunctionType(possibleFunctionType: TypeInfo | undefined): CompileTimeType {
	if (!possibleFunctionType) {
		return { julType: 'any' };
	}
	const rawType = possibleFunctionType.type;
	if (isFunctionType(rawType)) {
		return rawType.ReturnType;
	}
	return { julType: 'any' };
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
	const typeGuardTypeError = areArgsAssignableTo(undefined, typeGuardType, { julType: 'type' });
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
	const anyFunctionType = createCompileTimeFunctionType({ julType: 'any' }, { julType: 'any' }, false);
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