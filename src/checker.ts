import { join } from 'path';
import {
	_Boolean,
	_Text,
	BracketedExpression,
	CompileTimeCollection,
	CompileTimeComplementType,
	CompileTimeDictionary,
	CompileTimeDictionaryLiteralType,
	CompileTimeDictionaryType,
	CompileTimeFunctionType,
	CompileTimeListType,
	CompileTimeStreamType,
	CompileTimeTupleType,
	CompileTimeType,
	CompileTimeTypeOfType,
	CompileTimeUnionType,
	createCompileTimeComplementType,
	createCompileTimeDictionaryLiteralType,
	createCompileTimeDictionaryType,
	createCompileTimeFunctionType,
	createCompileTimeGreaterType,
	createCompileTimeListType,
	createCompileTimeStreamType,
	createCompileTimeTupleType,
	createCompileTimeTypeOfType,
	createNestedReference,
	createParameterReference,
	createParametersType,
	Integer,
	Parameter,
	ParameterReference,
	ParametersType,
	ParsedExpressions2,
	ParsedFile,
	ParseDictionaryField,
	ParseDictionaryTypeField,
	ParseFunctionCall,
	ParseParameterField,
	ParseParameterFields,
	ParseValueExpression,
	ParseReference,
	SimpleExpression,
	SymbolDefinition,
	SymbolTable,
	TextLiteralType,
	TextToken,
	Type,
	TypedExpression,
	TypeInfo,
} from './syntax-tree.js';
import { NonEmptyArray, elementsEqual, fieldsEqual, isDefined, isNonEmpty, last, map, mapDictionary } from './util.js';
import { coreLibPath, getPathFromImport, parseFile } from './parser/parser.js';
import { ParserError } from './parser/parser-combinator.js';
import { getCheckedEscapableName } from './parser/parser-utils.js';

export type ParsedDocuments = { [filePath: string]: ParsedFile; };

const maxElementsPerLine = 5;

const CompileTimeNonZeroInteger = createNormalizedIntersectionType([Integer, createCompileTimeComplementType({ julType: 'integerLiteral', value: 0n })]);

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
	Boolean: createCompileTimeTypeOfType(_Boolean),
	Integer: createCompileTimeTypeOfType(Integer),
	Float: createCompileTimeTypeOfType({ julType: 'float' }),
	Text: createCompileTimeTypeOfType(_Text),
	Date: createCompileTimeTypeOfType({ julType: 'date' }),
	Error: createCompileTimeTypeOfType({ julType: 'error' }),
	List: (() => {
		const parameterReference = createParameterReference('ElementType', 0);
		const functionType = createCompileTimeFunctionType(
			createParametersType([{
				name: 'ElementType',
				type: Type,
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
				type: Type,
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
				type: Type,
			}]),
			createCompileTimeTypeOfType(createCompileTimeStreamType(parameterReference)),
			true,
		);
		parameterReference.functionRef = functionType;
		return functionType;
	})(),
	Type: createCompileTimeTypeOfType(Type),
	// ValueOf:  new FunctionType(
	// 		new _ParametersType({
	// 			T: _type,
	// 		}),
	// 		createParameterReference([{
	// 			type: 'name',
	// 			name: 'FunctionType',
	// 		}]),
	// 	),
	// TODO And
	// TODO hier? oder customlogik case in inferType?
	// Or: new FunctionType(
	// 	// TODO rest args type?
	// 	,
	// 	new UnionType(),
	// ),
	nativeFunction: (() => {
		const parameterReference = createParameterReference('FunctionType', 0);
		const functionType = createCompileTimeFunctionType(
			createParametersType([
				{
					name: 'FunctionType',
					// TODO functionType
					type: Type,
				},
				{
					name: 'pure',
					type: _Boolean,
				},
				{
					name: 'js',
					type: _Text,
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
				type: _Text,
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
	// Außer bei inferFileTypes mit core-lib, was keine Rolle spielt, denn für core-lib werden Fehler ignoriert.
	const isBuiltIn = findResult.scopeIndex === 0;
	if (foundSymbol.functionParameterIndex !== undefined) {
		// TODO ParameterReference nur liefern, wenn Symbol im untersten Scope gefunden,
		// da ParameterReference auf höhere Funktionen problematisch ist?
		const parameterReference = createParameterReference(reference.name.name, foundSymbol.functionParameterIndex);
		if (foundSymbol.functionRef === undefined) {
			console.log('functionRef missing');
		}
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
		type: referencedType.rawType,
		found: true,
		foundSymbol: foundSymbol,
		isBuiltIn: isBuiltIn,
	};
}

export function getStreamGetValueType(streamType: CompileTimeStreamType): CompileTimeFunctionType {
	return createCompileTimeFunctionType({ julType: 'empty' }, streamType.ValueType, false);
}

function dereferenceNestedKeyFromObject(nestedKey: string | number, source: CompileTimeType): CompileTimeType | undefined {
	return typeof nestedKey === 'string'
		? dereferenceNameFromObject(nestedKey, source)
		: dereferenceIndexFromObject(nestedKey, source);
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
			// TODO error: cant dereference name in list 
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
			if (typeof innerType === 'object') {
				if (!innerType) {
					// TODO?
					return undefined;
				}
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
			return undefined;
		}
		// TODO other object types
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
			// TODO error: cant dereference index in dictionary type
			return undefined;
		case 'list':
			return sourceObjectType.ElementType;
		case 'or': {
			const dereferencedChoices = sourceObjectType.ChoiceTypes.map(choiceType => {
				return dereferenceIndexFromObject(index, choiceType);
			}).filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(dereferencedChoices);
		}
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
		console.log(scopes);
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
		case 'nestedReference': {
			const dereferencedSource = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, typeToDereference.source);
			const dereferencedNested = dereferenceNestedKeyFromObject(typeToDereference.nestedKey, dereferencedSource);
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
			if (argIndex > argsType.ElementTypes.length) {
				// TODO error bei unbound ref?
				return parameterReference;
			}
			const argType = argsType.ElementTypes[argIndex]!;
			return argType;
		}
		case 'list':
		// TODO?
		default:
			return argsType;
	}
}

/**
 * Dereferenziert nestedReference und parameterReference über dereferenceParameterTypeFromFunctionRef rekursiv soweit wie möglich.
 */
function dereferenceNested(rawType: CompileTimeType): CompileTimeType {
	switch (rawType.julType) {
		case 'and': {
			const rawChoices = rawType.ChoiceTypes;
			const dereferencedChoices = rawChoices.map(dereferenceNested);
			if (elementsEqual(rawChoices, dereferencedChoices)) {
				return rawType;
			}
			return createNormalizedIntersectionType(dereferencedChoices);
		}
		case 'dictionary': {
			const rawElement = rawType.ElementType;
			const dereferencedElement = dereferenceNested(rawElement);
			if (dereferencedElement === rawElement) {
				return rawType;
			}
			return createCompileTimeDictionaryType(dereferencedElement);
		}
		case 'dictionaryLiteral': {
			const rawFields = rawType.Fields;
			const dereferencedFields = mapDictionary(rawFields, dereferenceNested);
			if (fieldsEqual(rawFields, dereferencedFields)) {
				return rawType;
			}
			return createCompileTimeDictionaryLiteralType(dereferencedFields, rawType.expression, rawType.filePath);
		}
		case 'function': {
			const dereferencedParamsType = dereferenceNested(rawType.ParamsType);
			const dereferencedReturnType = dereferenceNested(rawType.ReturnType);
			if (dereferencedParamsType === rawType.ParamsType
				&& dereferencedReturnType === rawType.ReturnType) {
				return rawType;
			}
			return createCompileTimeFunctionType(dereferencedParamsType, dereferencedReturnType, rawType.pure);
		}
		case 'list': {
			const rawElement = rawType.ElementType;
			const dereferencedElement = dereferenceNested(rawElement);
			if (dereferencedElement === rawElement) {
				return rawType;
			}
			return createCompileTimeListType(dereferencedElement);
		}
		case 'nestedReference': {
			const dereferencedSource = dereferenceNested(rawType.source);
			const dereferencedNested = dereferenceNestedKeyFromObject(rawType.nestedKey, dereferencedSource);
			if (!dereferencedNested) {
				return { julType: 'any' };
			}
			return dereferencedNested;
		}
		case 'not': {
			const rawSource = rawType.SourceType;
			const dereferencedSource = dereferenceNested(rawSource);
			if (dereferencedSource === rawSource) {
				return rawType;
			}
			return createCompileTimeComplementType(dereferencedSource);
		}
		case 'or': {
			const rawChoices = rawType.ChoiceTypes;
			const dereferencedChoices = rawChoices.map(dereferenceNested);
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
			const dereferenced2 = dereferenceNested(dereferenced1);
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
			const dereferencedValue = dereferenceNested(rawValue);
			if (dereferencedValue === rawValue) {
				return rawType;
			}
			return createCompileTimeStreamType(dereferencedValue);
		}
		case 'tuple': {
			const rawElements = rawType.ElementTypes;
			const dereferencedElements = rawElements.map(dereferenceNested);
			if (elementsEqual(rawElements, dereferencedElements)) {
				return rawType;
			}
			return createCompileTimeTupleType(dereferencedElements);
		}
		case 'typeOf': {
			const rawValue = rawType.value;
			const dereferencedValue = dereferenceNested(rawValue);
			if (dereferencedValue === rawValue) {
				return rawType;
			}
			return createCompileTimeTypeOfType(dereferencedValue);
		}
		default:
			return rawType;
	}
}

function dereferenceNestedParameter(parameter: Parameter): Parameter {
	return {
		name: parameter.name,
		type: parameter.type && dereferenceNested(parameter.type),
	};
}

function dereferenceParameterTypeFromFunctionRef(parameterReference: ParameterReference): CompileTimeType | undefined {
	const functionType = parameterReference.functionRef;
	if (functionType) {
		const paramsType = functionType.ParamsType;
		if (isParametersType(paramsType)) {
			const matchedParameter = paramsType.singleNames.find(parameter =>
				parameter.name === parameterReference.name);
			return matchedParameter?.type;
		}
	}
}

//#endregion dereference

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
	inferFileTypes(checked, [builtInSymbols], documents, document.sourceFolder, document.filePath);
}

function inferFileTypes(
	file: ParsedExpressions2,
	scopes: SymbolTable[],
	parsedDocuments: ParsedDocuments,
	sourceFolder: string,
	filePath: string,
): void {
	const fileScopes = [
		...scopes,
		file.symbols,
	] as any as NonEmptyArray<SymbolTable>;
	file.expressions?.forEach(expression => {
		setInferredType(expression, fileScopes, parsedDocuments, sourceFolder, file, filePath);
	});
}

function setInferredType(
	expression: TypedExpression,
	scopes: NonEmptyArray<SymbolTable>,
	parsedDocuments: ParsedDocuments,
	sourceFolder: string,
	file: ParsedExpressions2,
	filePath: string,
): void {
	if (expression.typeInfo) {
		return;
	}
	expression.typeInfo = inferType(expression, scopes, parsedDocuments, sourceFolder, file, filePath);
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
	scopes: NonEmptyArray<SymbolTable>,
	parsedDocuments: ParsedDocuments,
	folder: string,
	file: ParsedExpressions2,
	filePath: string,
): TypeInfo {
	const errors = file.errors;
	switch (expression.type) {
		case 'bracketed':
			// TODO?
			return {
				rawType: { julType: 'any' },
				dereferencedType: { julType: 'any' },
			};
		case 'branching': {
			// union branch return types
			// TODO conditional type?
			setInferredType(expression.value, scopes, parsedDocuments, folder, file, filePath);
			const branches = expression.branches;
			branches.forEach((branch, index) => {
				setInferredType(branch, scopes, parsedDocuments, folder, file, filePath);
				// Fehler, wenn branch type != function
				const functionType = createCompileTimeFunctionType({ julType: 'any' }, { julType: 'any' }, false);
				const nonFunctionError = areArgsAssignableTo(undefined, branch.typeInfo!.dereferencedType, functionType);
				if (nonFunctionError) {
					errors.push({
						message: 'Expected branch to be a function.\n' + nonFunctionError,
						startRowIndex: branch.startRowIndex,
						startColumnIndex: branch.startColumnIndex,
						endRowIndex: branch.endRowIndex,
						endColumnIndex: branch.endColumnIndex,
					});
				}
				if (index) {
					// Fehler, wenn ParameterTyp des Branches schon von vorherigen Branches abgedeckt.
					// Also wenn aktueller ParamterTyp Teilmenge der Veroderung der vorherigen ParameterTypen ist.
					// TODO
					// const previousTypes = branches.slice(0, index).map(previousBranch => {
					// 	return getParamsType(previousBranch.inferredType);
					// });
					// const combinedPreviousType = new UnionType(previousTypes);
					// const currentParamsType = getParamsType(branch.inferredType);
					// const error = areArgsAssignableTo(undefined, currentParamsType, combinedPreviousType);
					// if (!error) {
					// 	errors.push({
					// 		message: 'Unreachable branch detected.',
					// 		startRowIndex: branch.startRowIndex,
					// 		startColumnIndex: branch.startColumnIndex,
					// 		endRowIndex: branch.endRowIndex,
					// 		endColumnIndex: branch.endColumnIndex,
					// 	});
					// }
				}
			});
			const branchReturnTypes = expression.branches.map(branch => {
				return getReturnTypeFromFunctionType(branch.typeInfo);
			});
			const rawType = createNormalizedUnionType(branchReturnTypes);
			return {
				rawType: rawType,
				dereferencedType: dereferenceNested(rawType),
			};
		}
		case 'definition': {
			const value = expression.value;
			if (value) {
				setInferredType(value, scopes, parsedDocuments, folder, file, filePath);
			}
			const name = expression.name.name;
			let typeInfo: TypeInfo;
			if (name in coreBuiltInSymbolTypes) {
				const rawType = coreBuiltInSymbolTypes[name]!;
				typeInfo = {
					rawType: rawType,
					dereferencedType: rawType,
				};
			}
			else {
				if (value?.typeInfo) {
					typeInfo = value.typeInfo;
				}
				else {
					typeInfo = {
						rawType: { julType: 'any' },
						dereferencedType: { julType: 'any' },
					};
				}
			}
			if (!typeInfo.rawType.name) {
				typeInfo.rawType.name = name;
			}
			if (!typeInfo.dereferencedType.name) {
				typeInfo.dereferencedType.name = name;
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
				setInferredType(typeGuard, scopes, parsedDocuments, folder, file, filePath);
				checkTypeGuardIsType(typeGuard, errors);
				const typeGuardType = typeGuard.typeInfo;
				const assignmentError = typeGuardType && areArgsAssignableTo(undefined, typeInfo.dereferencedType, valueOf(typeGuardType.dereferencedType));
				if (assignmentError) {
					errors.push({
						message: assignmentError,
						startRowIndex: expression.startRowIndex,
						startColumnIndex: expression.startColumnIndex,
						endRowIndex: expression.endRowIndex,
						endColumnIndex: expression.endColumnIndex,
					});
				}
			}
			return typeInfo;
		}
		case 'destructuring': {
			const value = expression.value;
			if (value) {
				setInferredType(value, scopes, parsedDocuments, folder, file, filePath);
			}
			const currentScope = last(scopes);
			expression.fields.fields.forEach(field => {
				// TODO spread
				const fieldName = field.name.name;
				if (!fieldName) {
					return;
				}
				checkNameDefinedInUpperScope(expression, scopes, errors, fieldName);
				const referenceName = field.source?.name ?? fieldName;
				const valueType: CompileTimeType = value?.typeInfo
					? value.typeInfo.rawType
					: { julType: 'any' };
				const fieldType = dereferenceNameFromObject(referenceName, valueType);
				if (!fieldType) {
					errors.push({
						message: `Failed to dereference ${referenceName} in type ${typeToString(value?.typeInfo?.dereferencedType ?? { julType: 'any' }, 0, 0)}`,
						startRowIndex: field.startRowIndex,
						startColumnIndex: field.startColumnIndex,
						endRowIndex: field.endRowIndex,
						endColumnIndex: field.endColumnIndex,
					});
					return;
				}
				const symbol = currentScope[fieldName]!;
				symbol.typeInfo = {
					rawType: fieldType,
					dereferencedType: dereferenceNested(fieldType)
				};
				const typeGuard = field.typeGuard;
				if (typeGuard) {
					setInferredType(typeGuard, scopes, parsedDocuments, folder, file, filePath);
					checkTypeGuardIsType(typeGuard, errors);
					// TODO check value?
					const error = typeGuard.typeInfo && areArgsAssignableTo(undefined, fieldType, valueOf(typeGuard.typeInfo.dereferencedType));
					if (error) {
						errors.push({
							message: error,
							startRowIndex: field.startRowIndex,
							startColumnIndex: field.startColumnIndex,
							endRowIndex: field.endRowIndex,
							endColumnIndex: field.endColumnIndex,
						});
					}
				}
			});
			return {
				rawType: { julType: 'any' },
				dereferencedType: { julType: 'any' },
			};
		}
		case 'dictionary': {
			const fieldTypes: CompileTimeDictionary = {};
			let isUnknownType = false;
			expression.fields.forEach(field => {
				const value = field.value;
				if (value) {
					setInferredType(value, scopes, parsedDocuments, folder, file, filePath);
				}
				switch (field.type) {
					case 'singleDictionaryField': {
						const typeGuard = field.typeGuard;
						if (typeGuard) {
							setInferredType(typeGuard, scopes, parsedDocuments, folder, file, filePath);
							checkTypeGuardIsType(typeGuard, errors);
						}
						const fieldName = getCheckedEscapableName(field.name);
						if (!fieldName) {
							return;
						}
						const fieldType = field.value?.typeInfo?.rawType ?? { julType: 'any' };
						fieldTypes[fieldName] = fieldType;
						const fieldSymbol = expression.symbols[fieldName];
						if (!fieldSymbol) {
							throw new Error(`fieldSymbol ${fieldName} not found`);
						}
						fieldSymbol.typeInfo = {
							rawType: fieldType,
							dereferencedType: dereferenceNested(fieldType),
						};
						return;
					}
					case 'spread':
						const valueType = value?.typeInfo?.rawType;
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
				return {
					rawType: { julType: 'any' },
					dereferencedType: { julType: 'any' },
				};
			}
			const rawType = createCompileTimeDictionaryLiteralType(fieldTypes, expression, filePath);
			return {
				// typeExpression: expression,
				rawType: rawType,
				dereferencedType: dereferenceNested(rawType),
			};
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
						setInferredType(typeGuard, scopes, parsedDocuments, folder, file, filePath);
						checkTypeGuardIsType(typeGuard, errors);
						const fieldName = getCheckedEscapableName(field.name);
						if (!fieldName) {
							return;
						}
						const fieldType = valueOf(typeGuard.typeInfo?.rawType);
						fieldTypes[fieldName] = fieldType;
						const fieldSymbol = expression.symbols[fieldName];
						if (!fieldSymbol) {
							throw new Error(`fieldSymbol ${fieldName} not found`);
						}
						fieldSymbol.typeInfo = {
							rawType: fieldType,
							dereferencedType: dereferenceNested(fieldType),
						};
						return;
					}
					case 'spread':
						setInferredType(field.value, scopes, parsedDocuments, folder, file, filePath);
						// TODO spread fields flach machen
						// TODO error when spread list
						return;
					default: {
						const assertNever: never = field;
						throw new Error('Unexpected DictionaryType field type ' + (assertNever as ParseDictionaryTypeField).type);
					}
				}
			});
			const rawType = createCompileTimeTypeOfType(createCompileTimeDictionaryLiteralType(fieldTypes, expression, filePath));
			return {
				rawType: rawType,
				dereferencedType: dereferenceNested(rawType),
			};
		}
		case 'empty':
			return {
				rawType: { julType: 'empty' },
				dereferencedType: { julType: 'empty' },
			};
		case 'field':
			// TODO?
			return {
				rawType: { julType: 'empty' },
				dereferencedType: { julType: 'empty' },
			};
		case 'float': {
			const rawType: CompileTimeType = {
				julType: 'floatLiteral',
				value: expression.value
			};
			return {
				rawType: rawType,
				dereferencedType: rawType,
			};
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
			});
			return {
				rawType: rawType,
				dereferencedType: rawType,
			};
		}
		case 'functionCall': {
			// TODO provide args types for conditional/generic/derived type?
			// TODO infer last body expression type for returnType
			const prefixArgument = expression.prefixArgument;
			if (prefixArgument) {
				setInferredType(prefixArgument, scopes, parsedDocuments, folder, file, filePath);
			}
			const functionExpression = expression.functionExpression;
			if (!functionExpression) {
				return {
					rawType: { julType: 'any' },
					dereferencedType: { julType: 'any' },
				};
			}
			setInferredType(functionExpression, scopes, parsedDocuments, folder, file, filePath);
			const functionType = functionExpression.typeInfo!.rawType;
			const paramsType = getParamsType(functionType);
			const args = expression.arguments;
			if (!args) {
				return {
					rawType: { julType: 'any' },
					dereferencedType: { julType: 'any' },
				};
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
			setInferredType(args, scopes, parsedDocuments, folder, file, filePath);
			const argsType = args.typeInfo!.rawType;
			const prefixArgumentType = prefixArgument?.typeInfo?.rawType;
			const assignArgsError = areArgsAssignableTo(prefixArgumentType, argsType, paramsType);
			if (assignArgsError) {
				errors.push({
					message: assignArgsError,
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.endRowIndex,
					endColumnIndex: expression.endColumnIndex,
				});
			}
			const returnType = getReturnTypeFromFunctionCall(expression, functionExpression, parsedDocuments, folder, errors);
			// evaluate generic ReturnType
			const dereferencedReturnType = dereferenceArgumentTypesNested(functionType, prefixArgumentType, argsType, returnType);
			return {
				rawType: dereferencedReturnType,
				dereferencedType: dereferenceNested(dereferencedReturnType),
			};
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
			setInferredType(params, functionScopes, parsedDocuments, folder, file, filePath);
			const paramsTypeValue = valueOf(params.typeInfo!.rawType);
			functionType.ParamsType = paramsTypeValue;
			//#region narrowed type symbol für branching
			const branching = expression.parent;
			if (branching?.type === 'branching') {
				const branchedvalue = branching.value;
				if (branchedvalue.type === 'reference') {
					const branchedName = branchedvalue.name.name;
					const branchedSymbol = findSymbolInScopesWithBuiltIns(branchedName, functionScopes)?.symbol;
					if (branchedSymbol) {
						// TODO narrowed Hinweis in description?
						ownSymbols[branchedName] = {
							...branchedSymbol,
							functionParameterIndex: undefined,
							// TODO paramsType spreaden?
							typeInfo: {
								rawType: paramsTypeValue,
								dereferencedType: valueOf(params.typeInfo!.dereferencedType),
							},
						};
					}
				}
			}
			//#endregion narrowed type symbol für branching
			expression.body.forEach(bodyExpression => {
				setInferredType(bodyExpression, functionScopes, parsedDocuments, folder, file, filePath);
			});
			const inferredReturnType = last(expression.body)?.typeInfo!;
			const declaredReturnType = expression.returnType;
			if (declaredReturnType) {
				setInferredType(declaredReturnType, functionScopes, parsedDocuments, folder, file, filePath);
				const error = areArgsAssignableTo(undefined, inferredReturnType.dereferencedType, valueOf(declaredReturnType.typeInfo!.dereferencedType));
				if (error) {
					errors.push({
						message: error,
						startRowIndex: expression.startRowIndex,
						startColumnIndex: expression.startColumnIndex,
						endRowIndex: expression.endRowIndex,
						endColumnIndex: expression.endColumnIndex,
					});
				}
			}
			functionType.ReturnType = inferredReturnType.rawType;
			return {
				rawType: functionType,
				dereferencedType: dereferenceNested(functionType),
			};
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
			setInferredType(params, functionScopes, parsedDocuments, folder, file, filePath);
			functionType.ParamsType = valueOf(params.typeInfo!.rawType);
			// TODO check returnType muss pure sein
			setInferredType(expression.returnType, functionScopes, parsedDocuments, folder, file, filePath);
			const inferredReturnType = expression.returnType.typeInfo!.rawType;
			functionType.ReturnType = valueOf(inferredReturnType);
			const rawType = createCompileTimeTypeOfType(functionType);
			return {
				rawType: rawType,
				dereferencedType: dereferenceNested(rawType),
			};
		}
		case 'integer': {
			const rawType: CompileTimeType = {
				julType: 'integerLiteral',
				value: expression.value,
			};
			return {
				rawType: rawType,
				dereferencedType: rawType,
			};
		}
		case 'list': {
			// TODO spread elements
			// TODO error when spread dictionary
			expression.values.forEach(element => {
				const typedExpression = element.type === 'spread'
					? element.value
					: element;
				setInferredType(typedExpression, scopes, parsedDocuments, folder, file, filePath);
			});
			const rawType = createCompileTimeTupleType(expression.values.map(element => {
				if (element.type === 'spread') {
					// TODO flatten spread tuple value type
					return { julType: 'any' };
				}
				return element.typeInfo!.rawType;
			}));
			return {
				rawType: rawType,
				dereferencedType: dereferenceNested(rawType),
			};
		}
		case 'nestedReference': {
			const source = expression.source;
			setInferredType(source, scopes, parsedDocuments, folder, file, filePath);
			const nestedKey = expression.nestedKey;
			if (!nestedKey) {
				return {
					rawType: { julType: 'any' },
					dereferencedType: { julType: 'any' },
				};
			}
			switch (nestedKey.type) {
				case 'index': {
					const dereferencedType = dereferenceIndexFromObject(nestedKey.name, source.typeInfo!.rawType);
					const rawType = dereferencedType ?? { julType: 'any' };
					return {
						rawType: rawType,
						dereferencedType: dereferenceNested(rawType),
					};
				}
				case 'name':
				case 'text': {
					const fieldName = getCheckedEscapableName(nestedKey);
					if (!fieldName) {
						return {
							rawType: { julType: 'any' },
							dereferencedType: { julType: 'any' },
						};
					}
					const dereferencedType = dereferenceNameFromObject(fieldName, source.typeInfo!.rawType);
					const rawType = dereferencedType ?? { julType: 'any' };
					return {
						rawType: rawType,
						dereferencedType: dereferenceNested(rawType),
					};
				}
				default: {
					const assertNever: never = nestedKey;
					throw new Error(`Unexpected nestedKey.type ${(assertNever as TypedExpression).type}`);
				}
			}
		}
		case 'object': {
			// TODO check is List or Dictionary in values
			// TODO error when List/Dictionary mixed
			// TODO Dictionary Type?
			let hasList: boolean = false;
			let hasDictionary: boolean = false;
			expression.values.forEach(element => {
				const typedExpression = element.value;
				setInferredType(typedExpression, scopes, parsedDocuments, folder, file, filePath);
				const inferredType = typedExpression.typeInfo?.rawType;
				// TODO
				if (isDictionaryType(inferredType)
					|| isDictionaryLiteralType(inferredType)) {
					hasDictionary = true;
				}
			});
			return {
				rawType: { julType: 'any' },
				dereferencedType: { julType: 'any' },
			};
		}
		case 'parameter': {
			const typeGuard = expression.typeGuard;
			if (typeGuard) {
				setInferredType(typeGuard, scopes, parsedDocuments, folder, file, filePath);
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
					const functionType = functionExpression.typeInfo!.rawType;
					const prefixArgument = functionCall.prefixArgument;
					// TODO rest berücksichtigen
					// const paramIndex = expression.parent.singleFields.indexOf(expression);
					// TODO previous arg types
					const prefixArgumentType = prefixArgument?.typeInfo?.rawType;
					dereferencedTypeFromCall = dereferenceArgumentTypesNested(functionType, prefixArgumentType, { julType: 'empty' }, inferredTypeFromCall);
				}
			}
			//#endregion
			const typeGuardType = typeGuard?.typeInfo?.rawType;
			const inferredType = dereferencedTypeFromCall ?? valueOf(typeGuardType);
			// TODO check array type bei spread
			const parameterSymbol = findParameterSymbol(expression, scopes);
			const typeInfo: TypeInfo = {
				rawType: inferredType,
				dereferencedType: dereferenceNested(inferredType),
			};
			parameterSymbol.typeInfo = typeInfo;
			return typeInfo;
		}
		case 'parameters': {
			expression.singleFields.forEach(field => {
				setInferredType(field, scopes, parsedDocuments, folder, file, filePath);
			});
			const rest = expression.rest;
			if (rest) {
				setInferredType(rest, scopes, parsedDocuments, folder, file, filePath);
				// TODO check rest type is list type
			}
			const rawType = createParametersType(
				expression.singleFields.map(field => {
					return {
						name: field.source ?? field.name.name,
						type: field.typeInfo?.rawType
					};
				}),
				rest && {
					name: rest.name.name,
					type: rest.typeInfo?.rawType
				},
			);
			return {
				rawType: rawType,
				dereferencedType: dereferenceNested(rawType),
			};
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
					message: `${name} is not defined.`,
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
					message: `${name} is used before it is defined.`,
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.endRowIndex,
					endColumnIndex: expression.endColumnIndex,
				});
			}
			return {
				rawType: type,
				dereferencedType: dereferenceNested(type),
			};
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
				return {
					rawType: rawType,
					dereferencedType: rawType,
				};
			}
			expression.values.forEach(part => {
				if (part.type !== 'textToken') {
					setInferredType(part, scopes, parsedDocuments, folder, file, filePath);
				}
			});
			return {
				rawType: _Text,
				dereferencedType: _Text,
			};
		}
		default: {
			const assertNever: never = expression;
			throw new Error(`Unexpected valueExpression.type: ${(assertNever as TypedExpression).type}`);
		}
	}
}

//#region get Type from FunctionCall

function getReturnTypeFromFunctionCall(
	functionCall: ParseFunctionCall,
	functionExpression: SimpleExpression,
	parsedDocuments: ParsedDocuments,
	folder: string,
	errors: ParserError[],
): CompileTimeType {
	const prefixArgument = functionCall.prefixArgument;
	const prefixArgumentType = prefixArgument?.typeInfo?.rawType;
	const argsType = functionCall.arguments?.typeInfo?.rawType ?? { julType: 'any' };
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
							? symbol.typeInfo.rawType
							: { julType: 'any' };
						return symbolType;
					});
					// TODO exrepssion, filePath?
					return createCompileTimeDictionaryLiteralType(importedTypes);
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
					? lastExpression.typeInfo.rawType
					: { julType: 'any' };
			}
			// case 'nativeFunction': {
			// 	const argumentType = dereferenceArgumentType(argsType, createParameterReference([{
			// 		type: 'name',
			// 		name: 'FunctionType',
			// 	}]));
			// 	return valueOf(argumentType);
			// }

			// case 'nativeValue': {
			// 	const argumentType = dereferenceArgumentType(argsType, createParameterReference([{
			// 		type: 'name',
			// 		name: 'js',
			// 	}]));
			// 	if (typeof argumentType === 'string') {
			// 		console.log('stg', argumentType);
			// 		// const test = (global as any)['_string'];
			// 		try {
			// 			const test = eval(argumentType);
			// 			console.log(test);

			// 		} catch (error) {
			// 			console.error(error);
			// 		}
			// 	}
			// 	return _any;
			// }
			case 'getElement': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				const dereferencedArgTypes = argTypes?.map(dereferenceNested);
				return getElementFromTypes(dereferencedArgTypes);
			}
			case 'lastElement': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				const dereferencedArgType = argTypes?.length
					? dereferenceNested(argTypes[0]!)
					: undefined;
				return getLastElementFromType(dereferencedArgType);
			}
			case 'length': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				const firstArgType = argTypes?.length
					? argTypes[0]
					: undefined;
				return getLengthFromType(firstArgType);
			}
			case 'And': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					// TODO unknown?
					return { julType: 'any' };
				}
				return createCompileTimeTypeOfType(createNormalizedIntersectionType(argTypes.map(valueOf)));
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

function getElementFromTypes(argsTypes: CompileTimeType[] | undefined): CompileTimeType {
	if (!argsTypes) {
		return { julType: 'empty' };
	}
	const [valuesType, indexType] = argsTypes;
	if (valuesType === undefined
		|| indexType === undefined) {
		return { julType: 'empty' };
	}
	if (indexType.julType === 'integerLiteral') {
		const dereferencedIndex = dereferenceIndexFromObject(Number(indexType.value), valuesType);
		if (dereferencedIndex) {
			return dereferencedIndex;
		}
	}
	if (isUnionType(indexType)) {
		const getElementChoices = indexType.ChoiceTypes.map(indexChoice => getElementFromTypes([valuesType, indexChoice]));
		return createNormalizedUnionType(getElementChoices);
	}
	switch (valuesType.julType) {
		case 'tuple':
			return createNormalizedUnionType([{ julType: 'empty' }, ...valuesType.ElementTypes]);
		case 'list':
			return createNormalizedUnionType([{ julType: 'empty' }, valuesType.ElementType]);
		case 'or': {
			const getElementChoices = valuesType.ChoiceTypes.map(valuesChoice => getElementFromTypes([valuesChoice, indexType]));
			return createNormalizedUnionType(getElementChoices);
		}
		default:
			return { julType: 'any' };
	}
}

function getLastElementFromType(valuesType: CompileTimeType | undefined): CompileTimeType {
	if (!valuesType) {
		return {
			julType: 'empty'
		};
	}
	switch (valuesType.julType) {
		case 'tuple':
			return last(valuesType.ElementTypes) ?? {
				julType: 'empty'
			};
		case 'list':
			return valuesType.ElementType;
		case 'or': {
			const lastElementChoices = valuesType.ChoiceTypes.map(valuesChoice => getLastElementFromType(valuesChoice));
			return createNormalizedUnionType(lastElementChoices);
		}
		default:
			return { julType: 'any' };
	}
}

function getLengthFromType(argType: CompileTimeType | undefined): CompileTimeType {
	if (!argType) {
		// TODO non negative
		return Integer;
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
			// TODO positive
			return CompileTimeNonZeroInteger;
		case 'or': {
			const lengthChoices = argType.ChoiceTypes.map(getLengthFromType);
			return createNormalizedUnionType(lengthChoices);
		}
		case 'parameterReference': {
			const dereferenced = dereferenceParameterTypeFromFunctionRef(argType);
			return getLengthFromType(dereferenced);
		}
		default:
			// TODO non negative
			return Integer;
	}
}

//#endregion get Type from FunctionCall

// TODO überlappende choices zusammenfassen (Wenn A Teilmenge von B, dann ist Or(A B) = B)
function createNormalizedUnionType(choiceTypes: CompileTimeType[]): CompileTimeType {
	//#region flatten UnionTypes
	// Or(1 Or(2 3)) => Or(1 2 3)
	const flatChoices = choiceTypes.filter(choiceType =>
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
	//#region collapse Streams
	// Or(Stream(1) Stream(2)) => Stream(Or(1 2))
	// TODO? diese Zusammenfassung ist eigentlich inhaltlich falsch, denn der Typ ist ungenauer
	// Or([1 1] [2 2]) != [Or(1 2) Or(1 2)] wegen Mischungen wie [1 2], [2 1] obwohl nur [1 1] oder [2 2] erlaubt sein sollten
	const streamChoices = uniqueChoices.filter(isStreamType);
	let collapsedStreamChoices: CompileTimeType[];
	if (streamChoices.length > 1) {
		collapsedStreamChoices = [];
		const streamValueChoices = streamChoices.map(stream => stream.ValueType);
		const collapsedValueType = createNormalizedUnionType(streamValueChoices);
		collapsedStreamChoices.push(
			createCompileTimeStreamType(collapsedValueType),
			...uniqueChoices.filter(choiceType =>
				!isStreamType(choiceType)),
		);
		if (collapsedStreamChoices.length === 1) {
			return collapsedStreamChoices[0]!;
		}
	}
	else {
		collapsedStreamChoices = uniqueChoices;
	}
	//#endregion collapse Streams
	return {
		julType: 'or',
		ChoiceTypes: collapsedStreamChoices,
	};
}

function createNormalizedIntersectionType(ChoiceTypes: CompileTimeType[]): CompileTimeType {
	// TODO flatten nested IntersectionTypes?

	// Distributivgesetz anwenden:
	// And(Or(A B) C) => Or(And(A C) And(B C)
	if (ChoiceTypes.length === 2
		&& isUnionType(ChoiceTypes[0])) {
		const firstUnionChoices = ChoiceTypes[0].ChoiceTypes;
		const secondIntersectionType = ChoiceTypes[1]!;
		const distributedChoices = firstUnionChoices.map(choice => {
			return createNormalizedIntersectionType([choice, secondIntersectionType]);
		});
		const distributedType = createNormalizedUnionType(distributedChoices);
		return distributedType;
	}

	// TODO leere Schnittemenge ermitteln? A not assignable to B und B not assignable to A
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
		// TODO Schnittmengenprüfung bauen, areArgsAssignableTo liefert nur Teilmengen
		const secondAssignToFirstError = areArgsAssignableTo(undefined, second, first);
		if (secondAssignToFirstError) {
			return first;
		}
	}

	return {
		julType: 'and',
		ChoiceTypes: ChoiceTypes,
	};
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
		// TODO
		case 'and':
		case 'dictionaryLiteral':
		case 'function':
		case 'nestedReference':
		case 'or':
		case 'parameterReference':
		case 'parameters':
		case 'tuple':
			return false;
		default:
			const assertNever: never = first;
			throw new Error('Unexpected julType: ' + (assertNever as CompileTimeType).julType);
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
			return createCompileTimeDictionaryLiteralType(fieldValues);
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
			// TODO nur die Schnittmenge der args Choices muss zum target passen
			const subErrors = argumentsType.ChoiceTypes.map(choiceType =>
				getTypeError(prefixArgumentType, choiceType, targetType));
			if (subErrors.every(isDefined)) {
				return {
					// TODO error struktur überdenken
					message: subErrors.map(typeErrorToString).join('\n'),
					// innerError
				};
			}
			return undefined;
		}
		case 'nestedReference':
			// TODO?
			return undefined;
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
			if (argumentsType.julType === 'booleanLiteral'
				&& argumentsType.value === targetType.value) {
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
			return error;
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
			if (argumentsType.julType === 'floatLiteral'
				&& argumentsType.value === targetType.value) {
				return undefined;
			}
			break;
		case 'function': {
			// TODO types als function interpretieren?
			if (!isFunctionType(argumentsType)) {
				break;
			}
			// check args params obermenge von target params und args returntype teilmenge von target returntype
			const paramsError = getTypeError(prefixArgumentType, targetType.ParamsType, argumentsType.ParamsType);
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
			if (argumentsType.julType === 'integerLiteral'
				&& argumentsType.value === targetType.value) {
				return undefined;
			}
			break;
		case 'list': {
			const targetElementType = targetType.ElementType;
			switch (argumentsType.julType) {
				case 'list':
					return getTypeError(prefixArgumentType, argumentsType.ElementType, targetElementType);
				case 'tuple':
					const subErrors = argumentsType.ElementTypes.map(valueElement =>
						getTypeError(prefixArgumentType, valueElement, targetElementType)).filter(isDefined);
					if (subErrors.length) {
						return {
							// TODO error struktur überdenken
							message: subErrors.map(typeErrorToString).join('\n'),
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
			const sourceError = getTypeError(prefixArgumentType, argumentsType, targetType.SourceType);
			if (sourceError === undefined) {
				// TODO
				// return {
				// 	message: `${typeToString(argumentsType, 0)} is assignable to ${typeToString(targetType.SourceType, 0)}, but should not be.`
				// };
			}
			return undefined;
		}
		case 'or': {
			// das arg muss zu mindestens einem target Choice passen
			const subErrors = targetType.ChoiceTypes.map(choiceType =>
				getTypeError(prefixArgumentType, argumentsType, choiceType));
			if (subErrors.every(isDefined)) {
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
			if (argumentsType.julType === 'textLiteral'
				&& argumentsType.value === targetType.value) {
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
		return {
			// TODO error struktur überdenken
			message: subErrors.map(typeErrorToString).join('\n'),
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
			const subErrors = map(
				targetFieldTypes,
				(fieldType, fieldName) => {
					// TODO the field x is missing error?
					const argument: CompileTimeType = argumentsType.Fields[fieldName] ?? { julType: 'empty' };
					return getDictionaryFieldError(fieldName, fieldType, prefixArgumentType, argument);
				},
			).filter(isDefined);
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
		const wrappedError: TypeError = {
			message: `Invalid value for field ${fieldName}`,
			innerError: subError,
		};
		return wrappedError;
	}
	return subError;
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
						message: `Parameter name mismatch. Got ${valueParameter.name} but expected ${targetParameterName}`,
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

//#endregion TypeError

//#region ToString

// TODO expand ReferenceType 1 level deep?
export function typeToString(type: CompileTimeType, indent: number, depth: number): string {
	if (depth && type.name) {
		return type.name;
	}
	switch (type.julType) {
		case 'and':
			return `And${arrayTypeToString(type.ChoiceTypes, indent, depth + 1)}`;
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
			return `Dictionary(${typeToString(type.ElementType, indent, depth + 1)})`;
		case 'dictionaryLiteral':
			return dictionaryTypeToString(type.Fields, ': ', indent, depth + 1);
		case 'empty':
			return '()';
		case 'error':
			return 'Error';
		case 'float':
			return 'Float';
		case 'floatLiteral':
			return type.value.toString() + 'f';
		case 'function': {
			const paramsString = typeToString(type.ParamsType, indent, depth + 1);
			const returnString = typeToString(type.ReturnType, indent, depth + 1);
			return `${paramsString} :> ${returnString}`;
		}
		case 'greater':
			return `Greater(${typeToString(type.Value, indent, depth + 1)})`;
		case 'integer':
			return 'Integer';
		case 'list':
			return `List(${typeToString(type.ElementType, indent, depth + 1)})`;
		case 'nestedReference':
			return `${typeToString(type.source, indent, depth + 1)}/${type.nestedKey}`;
		case 'never':
			return 'Never';
		case 'not':
			return `Not(${typeToString(type.SourceType, indent, depth + 1)})`;
		case 'or':
			return `Or${arrayTypeToString(type.ChoiceTypes, indent, depth + 1)}`;
		case 'parameters': {
			const rest = type.rest;
			const multiline = type.singleNames.length + (rest ? 1 : 0) > 1;
			const newIndent = multiline
				? indent + 1
				: indent;
			const elements = [
				...type.singleNames.map(element => {
					return `${element.name}${optionalTypeGuardToString(element.type, newIndent, depth + 1)}`;
				}),
				...(rest
					? [`...${rest.name}${optionalTypeGuardToString(rest.type, newIndent, depth + 1)}`]
					: []),
			];
			return bracketedExpressionToString(elements, multiline, indent);
		}
		case 'parameterReference':
			return type.name;
		case 'stream':
			return `Stream(${typeToString(type.ValueType, indent, depth + 1)})`;
		case 'text':
			return 'Text';
		case 'textLiteral':
			return `§${type.value.replaceAll('§', '§§')}§`;
		case 'tuple':
			return arrayTypeToString(type.ElementTypes, indent, depth + 1);
		case 'type':
			return 'Type';
		case 'typeOf':
			return `TypeOf(${typeToString(type.value, indent, depth)})`;
		default: {
			const assertNever: never = type;
			throw new Error(`Unexpected BuiltInType ${(assertNever as CompileTimeType).julType}`);
		}
	}
}

function optionalTypeGuardToString(type: CompileTimeType | undefined, indent: number, depth: number): string {
	return type
		? `: ${typeToString(type, indent, depth)}`
		: '';
}

function arrayTypeToString(
	array: CompileTimeType[],
	indent: number,
	depth: number,
): string {
	const multiline = array.length > maxElementsPerLine;
	const newIndent = multiline
		? indent + 1
		: indent;
	return bracketedExpressionToString(
		array.map(element =>
			typeToString(element, newIndent, depth)),
		multiline,
		indent);
}

function dictionaryTypeToString(
	dictionary: CompileTimeDictionary,
	nameSeparator: string,
	indent: number,
	depth: number,
): string {
	const multiline = Object.keys(dictionary).length > 1;
	const newIndent = multiline
		? indent + 1
		: indent;
	return bracketedExpressionToString(
		map(
			dictionary,
			(element, key) => {
				return `${key}${nameSeparator}${typeToString(element, newIndent, depth)}`;
			}),
		multiline,
		indent);
}

function bracketedExpressionToString(
	elements: string[],
	multiline: boolean,
	indent: number,
): string {
	const indentString = '\t'.repeat(indent + 1);
	const openingBracketSeparator = multiline
		? '\n' + indentString
		: '';
	const elementSeparator = multiline
		? '\n' + indentString
		: ' ';
	const closingBracketSeparator = multiline
		? '\n' + '\t'.repeat(indent)
		: '';
	return `(${openingBracketSeparator}${elements.join(elementSeparator)}${closingBracketSeparator})`;
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
	const rawType = possibleFunctionType.rawType;
	if (isFunctionType(rawType)) {
		return rawType.ReturnType;
	}
	return { julType: 'any' };
}

function getArgValueExpressions(args: BracketedExpression): (ParseValueExpression | undefined)[] {
	switch (args.type) {
		case 'bracketed':
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

export function getCheckedName(parseName: ParseValueExpression): string | undefined {
	if (parseName.type !== 'reference') {
		return undefined;
	}
	return parseName.name.name;
}

function checkNameDefinedInUpperScope(
	expression: TypedExpression,
	scopes: NonEmptyArray<SymbolTable>,
	errors: ParserError[],
	name: string,
): void {
	const alreadyDefined = scopes.some((scope, index) =>
		// nur vorherige scopes prüfen
		index < scopes.length - 1
		&& scope[name] !== undefined);
	if (alreadyDefined) {
		errors.push({
			message: `${name} is already defined in upper scope`,
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
	errors: ParserError[],
): void {
	const typeGuardType = typeGuard.typeInfo!.dereferencedType;
	const typeGuardTypeError = areArgsAssignableTo(undefined, typeGuardType, Type);
	if (typeGuardTypeError) {
		errors.push({
			message: typeGuardTypeError,
			startRowIndex: typeGuard.startRowIndex,
			startColumnIndex: typeGuard.startColumnIndex,
			endRowIndex: typeGuard.endRowIndex,
			endColumnIndex: typeGuard.endColumnIndex,
		});
	}
}

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