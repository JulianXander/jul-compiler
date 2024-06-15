import { join } from 'path';
import {
	Any,
	Float,
	Integer,
	Type,
	_Boolean,
	_Date,
	_Error,
	_Text,
	_julTypeSymbol,
} from './runtime.js';
import {
	BracketedExpression,
	BuiltInCompileTimeType,
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
	Never,
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
	Reference,
	SimpleExpression,
	SymbolDefinition,
	SymbolTable,
	TextToken,
	TypedExpression,
} from './syntax-tree.js';
import { NonEmptyArray, elementsEqual, fieldsEqual, getValueWithFallback, isDefined, isNonEmpty, last, map, mapDictionary } from './util.js';
import { coreLibPath, getPathFromImport, parseFile } from './parser/parser.js';
import { ParserError } from './parser/parser-combinator.js';
import { getCheckedEscapableName } from './parser/parser-utils.js';

export type ParsedDocuments = { [filePath: string]: ParsedFile; };

const maxElementsPerLine = 5;

const CompileTimeNonZeroInteger = createNormalizedIntersectionType([Integer, createCompileTimeComplementType(0n)]);

const coreBuiltInSymbolTypes: { [key: string]: CompileTimeType; } = {
	true: true,
	false: false,
	Any: createCompileTimeTypeOfType(Any),
	Boolean: createCompileTimeTypeOfType(_Boolean),
	Integer: createCompileTimeTypeOfType(Integer),
	Float: createCompileTimeTypeOfType(Float),
	Text: createCompileTimeTypeOfType(_Text),
	Date: createCompileTimeTypeOfType(_Date),
	Error: createCompileTimeTypeOfType(_Error),
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
		Any,
		false,
	),
};

const parsedCoreLib = parseFile(coreLibPath);
const parsedCoreLib2 = parsedCoreLib.unchecked;
inferFileTypes(parsedCoreLib2, [], {}, '');
export const builtInSymbols: SymbolTable = parsedCoreLib2.symbols;

//#region dereference

function dereferenceType(reference: Reference, scopes: SymbolTable[]): {
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
			type: Any,
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
	const referencedType = foundSymbol.inferredType;
	if (referencedType === null) {
		// TODO was wenn referencedsymbol type noch nicht inferred ist?
		// tritt vermutlich bei rekursion auf
		// setInferredType(referencedSymbol)
		// console.log(reference);
		// throw new Error('symbol type was not inferred');
		return {
			type: Any,
			found: true,
			foundSymbol: foundSymbol,
			isBuiltIn: isBuiltIn,
		};
	}
	return {
		type: referencedType,
		found: true,
		foundSymbol: foundSymbol,
		isBuiltIn: isBuiltIn,
	};
}

export function getStreamGetValueType(streamType: CompileTimeStreamType): CompileTimeFunctionType {
	return createCompileTimeFunctionType(undefined, streamType.ValueType, false);
}

function dereferenceNestedKeyFromObject(nestedKey: string | number, source: CompileTimeType): CompileTimeType | null {
	return typeof nestedKey === 'string'
		? dereferenceNameFromObject(nestedKey, source)
		: dereferenceIndexFromObject(nestedKey, source);
}

export function dereferenceNameFromObject(
	name: string,
	sourceObjectType: CompileTimeType,
): CompileTimeType | null {
	if (sourceObjectType === undefined) {
		return undefined;
	}
	if (typeof sourceObjectType !== 'object') {
		return null;
	}
	if (_julTypeSymbol in sourceObjectType) {
		switch (sourceObjectType[_julTypeSymbol]) {
			case 'any':
				return Any;
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
						return null;
				}
			case 'list':
				// TODO error: cant dereference name in list 
				return null;
			case 'nestedReference':
			case 'parameterReference':
				return createNestedReference(sourceObjectType, name);
			case 'parameters': {
				const matchedParameter = sourceObjectType.singleNames.find(parameter => parameter.name === name);
				if (matchedParameter) {
					return matchedParameter.type;
				}
				return null;
			}
			case 'stream':
				switch (name) {
					case 'getValue':
						return getStreamGetValueType(sourceObjectType);
					case 'ValueType':
						return sourceObjectType.ValueType;
					default:
						return null;
				}
			case 'typeOf': {
				const innerType = sourceObjectType.value;
				if (typeof innerType === 'object') {
					if (!innerType) {
						// TODO?
						return null;
					}
					if (_julTypeSymbol in innerType) {
						switch (innerType[_julTypeSymbol]) {
							case 'dictionary':
								switch (name) {
									case 'ElementType':
										return innerType.ElementType;
									default:
										return null;
								}
							case 'list':
								switch (name) {
									case 'ElementType':
										return innerType.ElementType;
									default:
										return null;
								}
							case 'nestedReference':
							case 'parameterReference':
								return createNestedReference(sourceObjectType, name);
							case 'tuple':
								switch (name) {
									case 'ElementType':
										return createNormalizedUnionType(innerType.ElementTypes);
									default:
										return null;
								}
							default:
								return null;
						}
					}
					if (Array.isArray(innerType)) {
						// TODO?
						switch (name) {
							case 'ElementType':
								return createNormalizedUnionType(innerType);
							default:
								return null;
						}
					}
					// case dictionary
					// TODO?
					switch (name) {
						case 'ElementType':
							return createNormalizedUnionType(Object.values(innerType));
						default:
							return null;
					}
				}
				return null;
			}
			// TODO other object types
			default:
				return null;
		}
	}
	if (Array.isArray(sourceObjectType)) {
		// TODO error: cant dereference name in list 
		return null;
	}
	return sourceObjectType[name];
}

function dereferenceIndexFromObject(
	index: number,
	sourceObjectType: CompileTimeType,
): CompileTimeType | null {
	if (sourceObjectType === undefined) {
		return undefined;
	}
	if (typeof sourceObjectType !== 'object') {
		return null;
	}
	if (_julTypeSymbol in sourceObjectType) {
		switch (sourceObjectType[_julTypeSymbol]) {
			case 'dictionaryLiteral':
				// TODO error: cant dereference index in dictionary type
				return null;
			case 'list':
				return sourceObjectType.ElementType;
			case 'parameterReference':
				return createNestedReference(sourceObjectType, index);
			case 'tuple':
				return sourceObjectType.ElementTypes[index - 1];
			// TODO other object types
			default:
				return null;
		}
	}
	if (Array.isArray(sourceObjectType)) {
		// TODO dereference by index
		return sourceObjectType[index - 1];
	}
	// TODO error: cant dereference index in dictionary
	return null;
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
	prefixArgumentType: CompileTimeType | null,
	argsType: CompileTimeType,
	typeToDereference: CompileTimeType,
): CompileTimeType {
	if (!isBuiltInType(typeToDereference)) {
		return typeToDereference;
	}
	const builtInType: BuiltInCompileTimeType = typeToDereference;
	switch (builtInType[_julTypeSymbol]) {
		case 'any':
		case 'blob':
		case 'boolean':
		case 'date':
		case 'error':
		case 'float':
		case 'integer':
		case 'never':
		case 'text':
		case 'type':
			return builtInType;
		case 'and': {
			const rawChoices = builtInType.ChoiceTypes;
			const dereferencedChoices = rawChoices.map(choiceType => dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, choiceType));
			if (elementsEqual(rawChoices, dereferencedChoices)) {
				return builtInType;
			}
			return createNormalizedIntersectionType(dereferencedChoices);
		}
		case 'dictionary': {
			const rawElement = builtInType.ElementType;
			const dereferencedElement = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawElement);
			if (dereferencedElement === rawElement) {
				return builtInType;
			}
			return createCompileTimeDictionaryType(dereferencedElement);
		}
		case 'greater': {
			const rawValue = builtInType.Value;
			const dereferencedValue = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawValue);
			if (dereferencedValue === rawValue) {
				return builtInType;
			}
			return createCompileTimeGreaterType(dereferencedValue);
		}
		case 'list': {
			const rawElement = builtInType.ElementType;
			const dereferencedElement = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawElement);
			if (dereferencedElement === rawElement) {
				return builtInType;
			}
			return createCompileTimeListType(dereferencedElement);
		}
		case 'nestedReference': {
			const dereferencedSource = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, builtInType.source);
			const dereferencedNested = dereferenceNestedKeyFromObject(builtInType.nestedKey, dereferencedSource);
			if (dereferencedNested === null) {
				return Any;
			}
			return dereferencedNested;
		}
		case 'not': {
			const rawSource = builtInType.SourceType;
			const dereferencedSource = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawSource);
			if (dereferencedSource === rawSource) {
				return builtInType;
			}
			return createCompileTimeComplementType(dereferencedSource);
		}
		case 'or': {
			const rawChoices = builtInType.ChoiceTypes;
			const dereferencedChoices = rawChoices.map(choiceType => dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, choiceType));
			if (elementsEqual(rawChoices, dereferencedChoices)) {
				return builtInType;
			}
			return createNormalizedUnionType(dereferencedChoices);
		}
		case 'parameterReference': {
			const dereferencedParameter = dereferenceParameterFromArgumentType(calledFunction, prefixArgumentType, argsType, builtInType);
			const dereferencedNested = dereferencedParameter === builtInType
				? dereferencedParameter
				: dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, dereferencedParameter);
			// TODO immer valueOf?
			return valueOf(dereferencedNested);
		}
		case 'stream': {
			const rawValue = builtInType.ValueType;
			const dereferencedValue = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawValue);
			if (dereferencedValue === rawValue) {
				return builtInType;
			}
			return createCompileTimeStreamType(dereferencedValue);
		}
		case 'typeOf': {
			const rawValue = builtInType.value;
			const dereferencedValue = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, rawValue);
			if (dereferencedValue === rawValue) {
				return builtInType;
			}
			return createCompileTimeTypeOfType(dereferencedValue);
		}
		// TODO
		case 'dictionaryLiteral':
		case 'function':
		case 'parameters':
		case 'tuple':
			return builtInType;
		default: {
			const assertNever: never = builtInType;
			throw new Error('Unexpected BuiltInType.type: ' + (assertNever as BuiltInCompileTimeType)[_julTypeSymbol]);
		}
	}
}

/**
 * combine prefixArgumentType and argsType
 */
function getAllArgTypes(
	prefixArgumentType: CompileTimeType | null,
	argsType: CompileTimeType,
): CompileTimeType[] | undefined {
	const prefixArgTypes = prefixArgumentType === null
		? []
		: [prefixArgumentType];
	if (argsType === undefined) {
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
	prefixArgumentType: CompileTimeType | null,
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
			return Any;
		}
		return allArgTypes.slice(paramIndex);
	}
	if (prefixArgumentType !== null && paramIndex === 0) {
		return prefixArgumentType;
	}
	if (argsType === undefined) {
		return undefined;
	}
	if (!isBuiltInType(argsType)) {
		return parameterReference;
	}
	switch (argsType[_julTypeSymbol]) {
		case 'dictionaryLiteral': {
			const referenceName = parameterReference.name;
			const argType = argsType.Fields[referenceName];
			// TODO error bei unbound ref?
			if (!argType) {
				return parameterReference;
			}
			const dereferenced = dereferenceNameFromObject(referenceName, argType);
			if (dereferenced === null) {
				return parameterReference;
			}
			return dereferenced;
		}
		case 'tuple': {
			// TODO dereference nested path
			// const referenceName = parameterReference.path[0].name;
			const argIndex = prefixArgumentType === null
				? paramIndex
				: paramIndex - 1;
			if (argIndex > argsType.ElementTypes.length) {
				// TODO error bei unbound ref?
				return parameterReference;
			}
			const argType = argsType.ElementTypes[argIndex];
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
	if (typeof rawType !== 'object') {
		return rawType;
	}
	if (rawType === null) {
		return rawType;
	}
	if (_julTypeSymbol in rawType) {
		switch (rawType[_julTypeSymbol]) {
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
				return createCompileTimeDictionaryLiteralType(dereferencedFields);
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
				if (dereferencedNested === null) {
					return Any;
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
				if (dereferenced1 === null) {
					return Any;
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
				const dereferencedRest = rawRest === undefined
					? undefined
					: dereferenceNestedParameter(rawRest);
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
	return rawType;
}

function dereferenceNestedParameter(parameter: Parameter): Parameter {
	return {
		name: parameter.name,
		type: parameter.type === null
			? null
			: dereferenceNested(parameter.type),
	};
}

function dereferenceParameterTypeFromFunctionRef(parameterReference: ParameterReference): CompileTimeType | null {
	const functionType = parameterReference.functionRef;
	if (functionType) {
		const paramsType = functionType.ParamsType;
		if (isParametersType(paramsType)) {
			const matchedParameter = paramsType.singleNames.find(parameter =>
				parameter.name === parameterReference.name);
			return matchedParameter
				? matchedParameter.type
				: null;
		}
	}
	return null;
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
	inferFileTypes(checked, [builtInSymbols], documents, document.sourceFolder);
}

function inferFileTypes(
	file: ParsedExpressions2,
	scopes: SymbolTable[],
	parsedDocuments: ParsedDocuments,
	sourceFolder: string,
): void {
	const fileScopes = [
		...scopes,
		file.symbols,
	] as any as NonEmptyArray<SymbolTable>;
	file.expressions?.forEach(expression => {
		setInferredType(expression, fileScopes, parsedDocuments, sourceFolder, file);
	});
}

function setInferredType(
	expression: TypedExpression,
	scopes: NonEmptyArray<SymbolTable>,
	parsedDocuments: ParsedDocuments,
	sourceFolder: string,
	file: ParsedExpressions2,
): void {
	if (expression.inferredType !== null) {
		return;
	}
	const rawType = inferType(expression, scopes, parsedDocuments, sourceFolder, file);
	expression.inferredType = rawType;
	expression.dereferencedType = dereferenceNested(rawType);
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
): CompileTimeType {
	const errors = file.errors;
	switch (expression.type) {
		case 'bracketed':
			// TODO?
			return Any;
		case 'branching': {
			// union branch return types
			// TODO conditional type?
			setInferredType(expression.value, scopes, parsedDocuments, folder, file);
			const branches = expression.branches;
			branches.forEach((branch, index) => {
				setInferredType(branch, scopes, parsedDocuments, folder, file);
				// Fehler, wenn branch type != function
				const functionType = createCompileTimeFunctionType(Any, Any, false);
				const nonFunctionError = areArgsAssignableTo(null, branch.inferredType!, functionType);
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
					// const error = areArgsAssignableTo(null, currentParamsType, combinedPreviousType);
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
				return getReturnTypeFromFunctionType(branch.inferredType);
			});
			return createNormalizedUnionType(branchReturnTypes);
		}
		case 'definition': {
			const value = expression.value;
			if (value) {
				setInferredType(value, scopes, parsedDocuments, folder, file);
			}
			const name = expression.name.name;
			let inferredType: CompileTimeType;
			let dereferencedType: CompileTimeType;
			if (name in coreBuiltInSymbolTypes) {
				inferredType = coreBuiltInSymbolTypes[name];
				dereferencedType = inferredType;
			}
			else {
				if (value && value.inferredType !== null) {
					inferredType = value.inferredType;
					dereferencedType = value.dereferencedType!;
				}
				else {
					inferredType = Any;
					dereferencedType = Any;
				}
			}
			checkNameDefinedInUpperScope(expression, scopes, errors, name);
			// TODO typecheck mit typeguard, ggf union mit Error type
			const currentScope = last(scopes);
			const symbol = currentScope[name];
			if (!symbol) {
				throw new Error(`Definition Symbol ${name} not found`);
			}
			symbol.inferredType = inferredType;
			symbol.dereferencedType = dereferencedType;
			const typeGuard = expression.typeGuard;
			if (typeGuard) {
				setInferredType(typeGuard, scopes, parsedDocuments, folder, file);
				checkTypeGuardIsType(typeGuard, errors);
				const typeGuardType = typeGuard.dereferencedType;
				const assignmentError = areArgsAssignableTo(null, dereferencedType, valueOf(typeGuardType));
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
			return inferredType;
		}
		case 'destructuring': {
			const value = expression.value;
			if (value) {
				setInferredType(value, scopes, parsedDocuments, folder, file);
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
				const valueType = value
					? getValueWithFallback(value.inferredType, Any)
					: Any;
				const dereferencedType = dereferenceNameFromObject(referenceName, valueType);
				if (dereferencedType === null) {
					errors.push({
						message: `Failed to dereference ${referenceName} in type ${typeToString(valueType, 0)}`,
						startRowIndex: field.startRowIndex,
						startColumnIndex: field.startColumnIndex,
						endRowIndex: field.endRowIndex,
						endColumnIndex: field.endColumnIndex,
					});
					return;
				}
				const symbol = currentScope[fieldName]!;
				symbol.inferredType = dereferencedType;
				symbol.dereferencedType = dereferenceNested(dereferencedType);
				const typeGuard = field.typeGuard;
				if (typeGuard) {
					setInferredType(typeGuard, scopes, parsedDocuments, folder, file);
					checkTypeGuardIsType(typeGuard, errors);
					// TODO check value?
					const error = areArgsAssignableTo(null, dereferencedType, valueOf(typeGuard.inferredType));
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
			return Any;
		}
		case 'dictionary': {
			const fieldTypes: CompileTimeDictionary = {};
			let isUnknownType = false;
			expression.fields.forEach(field => {
				const value = field.value;
				if (value) {
					setInferredType(value, scopes, parsedDocuments, folder, file);
				}
				switch (field.type) {
					case 'singleDictionaryField': {
						const typeGuard = field.typeGuard;
						if (typeGuard) {
							setInferredType(typeGuard, scopes, parsedDocuments, folder, file);
							checkTypeGuardIsType(typeGuard, errors);
						}
						const fieldName = getCheckedEscapableName(field.name);
						if (!fieldName) {
							return;
						}
						const fieldType = field.value
							? getValueWithFallback(field.value.inferredType, Any)
							: Any;
						fieldTypes[fieldName] = fieldType;
						const fieldSymbol = expression.symbols[fieldName];
						if (!fieldSymbol) {
							throw new Error(`fieldSymbol ${fieldName} not found`);
						}
						fieldSymbol.inferredType = fieldType;
						fieldSymbol.dereferencedType = dereferenceNested(fieldType);
						return;
					}
					case 'spread':
						const valueType = value?.inferredType;
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
				return Any;
			}
			return createCompileTimeDictionaryLiteralType(fieldTypes);
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
						setInferredType(typeGuard, scopes, parsedDocuments, folder, file);
						checkTypeGuardIsType(typeGuard, errors);
						const fieldName = getCheckedEscapableName(field.name);
						if (!fieldName) {
							return;
						}
						const fieldType = valueOf(typeGuard.inferredType);
						fieldTypes[fieldName] = fieldType;
						const fieldSymbol = expression.symbols[fieldName];
						if (!fieldSymbol) {
							throw new Error(`fieldSymbol ${fieldName} not found`);
						}
						fieldSymbol.inferredType = fieldType;
						fieldSymbol.dereferencedType = dereferenceNested(fieldType);
						return;
					}
					case 'spread':
						setInferredType(field.value, scopes, parsedDocuments, folder, file);
						// TODO spread fields flach machen
						// TODO error when spread list
						return;
					default: {
						const assertNever: never = field;
						throw new Error('Unexpected DictionaryType field type ' + (assertNever as ParseDictionaryTypeField).type);
					}
				}
			});
			return createCompileTimeTypeOfType(createCompileTimeDictionaryLiteralType(fieldTypes));
		}
		case 'empty':
			return undefined;
		case 'field':
			// TODO?
			return Any;
		case 'float':
			return expression.value;
		case 'fraction':
			return createCompileTimeDictionaryLiteralType({
				numerator: expression.numerator,
				denominator: expression.denominator,
			});
		case 'functionCall': {
			// TODO provide args types for conditional/generic/derived type?
			// TODO infer last body expression type for returnType
			const prefixArgument = expression.prefixArgument;
			if (prefixArgument) {
				setInferredType(prefixArgument, scopes, parsedDocuments, folder, file);
			}
			const functionExpression = expression.functionExpression;
			if (!functionExpression) {
				return Any;
			}
			setInferredType(functionExpression, scopes, parsedDocuments, folder, file);
			const functionType = functionExpression.inferredType!;
			const paramsType = getParamsType(functionType);
			const args = expression.arguments;
			if (!args) {
				return Any;
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
										literalParam.inferredTypeFromCall = innerParam
											? innerParam.type
											: null;
									}
								});
							}
						}
						// TODO rest param berücksichtigen
					}
				}
			});
			//#endregion
			setInferredType(args, scopes, parsedDocuments, folder, file);
			const argsType = args.inferredType!;
			const prefixArgumentType = prefixArgument
				? prefixArgument.inferredType
				: null;
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
			// const dereferencedReturnType2 = dereferenceArgumentTypesNested2(expression, prefixArgumentType, argsType, returnType);
			return dereferencedReturnType;
		}
		case 'functionLiteral': {
			const ownSymbols = expression.symbols;
			const functionScopes: NonEmptyArray<SymbolTable> = [...scopes, ownSymbols];
			const params = expression.params;
			const functionType = createCompileTimeFunctionType(
				undefined,
				undefined,
				// TODO pure, wenn der body pure ist
				false,
			);
			if (params.type === 'parameters') {
				setFunctionRefForParams(params, functionType, functionScopes);
			}
			setInferredType(params, functionScopes, parsedDocuments, folder, file);
			const paramsTypeValue = valueOf(params.inferredType);
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
							inferredType: paramsTypeValue,
						};
					}
				}
			}
			//#endregion narrowed type symbol für branching
			expression.body.forEach(bodyExpression => {
				setInferredType(bodyExpression, functionScopes, parsedDocuments, folder, file);
			});
			const inferredReturnType = last(expression.body)?.inferredType!;
			const declaredReturnType = expression.returnType;
			if (declaredReturnType) {
				setInferredType(declaredReturnType, functionScopes, parsedDocuments, folder, file);
				const error = areArgsAssignableTo(null, inferredReturnType, valueOf(declaredReturnType.inferredType));
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
			functionType.ReturnType = inferredReturnType;
			return functionType;
		}
		case 'functionTypeLiteral': {
			const functionScopes: NonEmptyArray<SymbolTable> = [...scopes, expression.symbols];
			const params = expression.params;
			const functionType = createCompileTimeFunctionType(
				undefined,
				undefined,
				true,
			);
			if (params.type === 'parameters') {
				setFunctionRefForParams(params, functionType, functionScopes);
			}
			setInferredType(params, functionScopes, parsedDocuments, folder, file);
			functionType.ParamsType = valueOf(params.inferredType);
			// TODO check returnType muss pure sein
			setInferredType(expression.returnType, functionScopes, parsedDocuments, folder, file);
			const inferredReturnType = expression.returnType.inferredType;
			if (inferredReturnType === null) {
				console.log(JSON.stringify(expression, undefined, 4));
				throw new Error('returnType was not inferred');
			}
			functionType.ReturnType = valueOf(inferredReturnType);
			return createCompileTimeTypeOfType(functionType);
		}
		case 'integer':
			return expression.value;
		case 'list':
			// TODO spread elements
			// TODO error when spread dictionary
			expression.values.forEach(element => {
				const typedExpression = element.type === 'spread'
					? element.value
					: element;
				setInferredType(typedExpression, scopes, parsedDocuments, folder, file);
			});
			return createCompileTimeTupleType(expression.values.map(element => {
				if (element.type === 'spread') {
					// TODO flatten spread tuple value type
					return Any;
				}
				return element.inferredType!;
			}));
		case 'nestedReference': {
			const source = expression.source;
			setInferredType(source, scopes, parsedDocuments, folder, file);
			const nestedKey = expression.nestedKey;
			if (!nestedKey) {
				return Any;
			}
			switch (nestedKey.type) {
				case 'index': {
					const dereferencedType = dereferenceIndexFromObject(nestedKey.name, source.inferredType!);
					return getValueWithFallback(dereferencedType, Any);
				}
				case 'name':
				case 'text': {
					const fieldName = getCheckedEscapableName(nestedKey);
					if (!fieldName) {
						return Any;
					}
					const dereferencedType = dereferenceNameFromObject(fieldName, source.inferredType!);
					return getValueWithFallback(dereferencedType, Any);
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
				setInferredType(typedExpression, scopes, parsedDocuments, folder, file);
				const inferredType = typedExpression.inferredType;
				// TODO
				if (isDictionaryType(inferredType)
					|| isDictionaryLiteralType(inferredType)) {
					hasDictionary = true;
				}
			});
			return Any;
		}
		case 'parameter': {
			const typeGuard = expression.typeGuard;
			if (typeGuard) {
				setInferredType(typeGuard, scopes, parsedDocuments, folder, file);
				checkTypeGuardIsType(typeGuard, errors);
			}
			checkNameDefinedInUpperScope(expression, scopes, errors, expression.name.name);
			//#region infer argument type bei function literal welches inline argument eines function calls ist
			const inferredTypeFromCall = expression.inferredTypeFromCall;
			let dereferencedTypeFromCall = inferredTypeFromCall;
			if (inferredTypeFromCall !== null
				&& expression.parent?.type === 'parameters'
				&& expression.parent.parent?.type === 'functionLiteral'
				&& expression.parent.parent.parent?.type === 'list'
				&& expression.parent.parent.parent.parent?.type === 'functionCall') {
				// evaluate generic ParameterType
				const functionCall = expression.parent.parent.parent.parent;
				const functionExpression = functionCall.functionExpression;
				const args = functionCall.arguments;
				if (functionExpression && args) {
					const functionType = functionExpression.inferredType!;
					const prefixArgument = functionCall.prefixArgument;
					// TODO rest berücksichtigen
					// const paramIndex = expression.parent.singleFields.indexOf(expression);
					// TODO previous arg types
					const prefixArgumentType = prefixArgument
						? prefixArgument.inferredType
						: null;
					dereferencedTypeFromCall = dereferenceArgumentTypesNested(functionType, prefixArgumentType, undefined, inferredTypeFromCall);
				}
			}
			//#endregion
			const typeGuardType = typeGuard
				? typeGuard.inferredType
				: null;
			const inferredType = getValueWithFallback(dereferencedTypeFromCall, valueOf(typeGuardType));
			// TODO check array type bei spread
			const parameterSymbol = findParameterSymbol(expression, scopes);
			parameterSymbol.inferredType = inferredType;
			parameterSymbol.dereferencedType = dereferenceNested(inferredType);
			return inferredType;
		}
		case 'parameters': {
			expression.singleFields.forEach(field => {
				setInferredType(field, scopes, parsedDocuments, folder, file);
			});
			const rest = expression.rest;
			if (rest) {
				setInferredType(rest, scopes, parsedDocuments, folder, file);
				// TODO check rest type is list type
			}
			return createParametersType(
				expression.singleFields.map(field => {
					return {
						name: field.source ?? field.name.name,
						type: field.inferredType
					};
				}),
				rest && {
					name: rest.name.name,
					type: rest.inferredType,
				},
			);
		}
		case 'reference': {
			const {
				found,
				foundSymbol,
				type,
				isBuiltIn,
			} = dereferenceType(expression, scopes);
			if (!found) {
				errors.push({
					message: `${expression.name.name} is not defined.`,
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
					message: `${expression.name.name} is used before it is defined.`,
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.endRowIndex,
					endColumnIndex: expression.endColumnIndex,
				});
			}
			return type;
		}
		case 'text': {
			// TODO string template type?
			if (expression.values.every((part): part is TextToken => part.type === 'textToken')) {
				// string literal type
				// TODO sollte hier überhaupt mehrelementiger string möglich sein?
				return expression.values.map(part => part.value).join('\n');
			}
			expression.values.forEach(part => {
				if (part.type !== 'textToken') {
					setInferredType(part, scopes, parsedDocuments, folder, file);
				}
			});
			return _Text;
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
	const prefixArgumentType = prefixArgument
		? prefixArgument.inferredType
		: null;
	const argsType = functionCall.arguments?.inferredType!;
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
					return Any;
				}
				// TODO get full path, get type from parsedfile
				const fullPath = join(folder, path);
				const importedFile = parsedDocuments[fullPath]?.checked;
				if (!importedFile) {
					return Any;
				}
				// definitions import
				// a dictionary containing all definitions is imported
				if (Object.keys(importedFile.symbols).length) {
					const importedTypes = mapDictionary(importedFile.symbols, symbol => {
						return getValueWithFallback(symbol.inferredType, Any);
					});
					return createCompileTimeDictionaryLiteralType(importedTypes);
				}
				// value import
				// the last expression is imported
				if (!importedFile.expressions) {
					return Any;
				}
				const lastExpression = last(importedFile.expressions);
				if (!lastExpression) {
					return Any;
				}
				return getValueWithFallback(lastExpression.inferredType, Any);
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
					? dereferenceNested(argTypes[0])
					: null;
				return getLastElementFromType(dereferencedArgType);
			}
			case 'length': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				const firstArgType = argTypes?.length
					? argTypes[0]
					: null;
				return getLengthFromType(firstArgType);
			}
			case 'And': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					// TODO unknown?
					return Any;
				}
				return createCompileTimeTypeOfType(createNormalizedIntersectionType(argTypes.map(valueOf)));
			}
			case 'Not': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					// TODO unknown?
					return Any;
				}
				if (!isNonEmpty(argTypes)) {
					// TODO unknown?
					return Any;
				}
				return createCompileTimeTypeOfType(createCompileTimeComplementType(valueOf(argTypes[0])));
			}
			case 'Or': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					// TODO unknown?
					return Any;
				}
				const choices = argTypes.map(valueOf);
				const unionType = createNormalizedUnionType(choices);
				return createCompileTimeTypeOfType(unionType);
			}
			case 'TypeOf': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					// TODO unknown?
					return Any;
				}
				if (!isNonEmpty(argTypes)) {
					// TODO unknown?
					return Any;
				}
				return createCompileTimeTypeOfType(argTypes[0]);
			}
			case 'Greater': {
				const argTypes = getAllArgTypes(prefixArgumentType, argsType);
				if (!argTypes) {
					// TODO unknown?
					return Any;
				}
				if (!isNonEmpty(argTypes)) {
					// TODO unknown?
					return Any;
				}
				return createCompileTimeTypeOfType(createCompileTimeGreaterType(valueOf(argTypes[0])));
			}
			default:
				break;
		}
	}
	const functionType = functionExpression.inferredType;
	return getReturnTypeFromFunctionType(functionType);
}

function getElementFromTypes(argsTypes: CompileTimeType[] | undefined): CompileTimeType {
	if (!argsTypes) {
		return;
	}
	const [valuesType, indexType] = argsTypes;
	if (valuesType === undefined
		|| valuesType === null
		|| indexType === undefined) {
		return;
	}
	if (typeof indexType === 'bigint') {
		const dereferencedIndex = dereferenceIndexFromObject(Number(indexType), valuesType);
		if (dereferencedIndex !== null) {
			return dereferencedIndex;
		}
	}
	if (isUnionType(indexType)) {
		const getElementChoices = indexType.ChoiceTypes.map(indexChoice => getElementFromTypes([valuesType, indexChoice]));
		return createNormalizedUnionType(getElementChoices);
	}
	if (isBuiltInType(valuesType)) {
		switch (valuesType[_julTypeSymbol]) {
			case 'tuple':
				return createNormalizedUnionType([undefined, ...valuesType.ElementTypes]);
			case 'list':
				return createNormalizedUnionType([undefined, valuesType.ElementType]);
			case 'or': {
				const getElementChoices = valuesType.ChoiceTypes.map(valuesChoice => getElementFromTypes([valuesChoice, indexType]));
				return createNormalizedUnionType(getElementChoices);
			}
			default:
				return Any;
		}
	}
	if (Array.isArray(valuesType)) {
		return createNormalizedUnionType([undefined, ...valuesType]);
	}
	return Any;
}

function getLastElementFromType(valuesType: CompileTimeType | null): CompileTimeType {
	if (typeof valuesType !== 'object'
		|| valuesType === null
	) {
		return;
	}
	if (_julTypeSymbol in valuesType) {
		switch (valuesType[_julTypeSymbol]) {
			case 'tuple':
				return last(valuesType.ElementTypes);
			case 'list':
				return valuesType.ElementType;
			case 'or': {
				const lastElementChoices = valuesType.ChoiceTypes.map(valuesChoice => getLastElementFromType(valuesChoice));
				return createNormalizedUnionType(lastElementChoices);
			}
			default:
				return Any;
		}
	}
	if (Array.isArray(valuesType)) {
		return last(valuesType);
	}
	return Any;
}

function getLengthFromType(argType: CompileTimeType | null): CompileTimeType {
	if (typeof argType !== 'object') {
		// TODO non negative
		return Integer;
	}
	if (argType === null) {
		return 0n;
	}
	if (_julTypeSymbol in argType) {
		switch (argType[_julTypeSymbol]) {
			case 'tuple':
				return BigInt(argType.ElementTypes.length);
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
	if (Array.isArray(argType)) {
		return BigInt(argType.length);
	}
	// TODO non negative
	return Integer;
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
	if (flatChoices.includes(Any)) {
		return Any;
	}
	//#region remove Never
	const choicesWithoutNever = flatChoices.filter(choice =>
		choice !== Never);
	if (!choicesWithoutNever.length) {
		return Never;
	}
	if (choicesWithoutNever.length === 1) {
		return choicesWithoutNever[0];
	}
	//#endregion remove Never
	//#region remove duplicates
	const uniqueChoices: CompileTimeType[] = [];
	choicesWithoutNever.forEach(choice => {
		if (!uniqueChoices.some(uniqueChoice =>
			choice === uniqueChoice)) {
			uniqueChoices.push(choice);
		}
	});
	if (uniqueChoices.length === 1) {
		return uniqueChoices[0];
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
			return collapsedStreamChoices[0];
		}
	}
	else {
		collapsedStreamChoices = uniqueChoices;
	}
	//#endregion collapse Streams
	return {
		[_julTypeSymbol]: 'or',
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
		const secondIntersectionType = ChoiceTypes[1];
		const distributedChoices = firstUnionChoices.map(choice => {
			return createNormalizedIntersectionType([choice, secondIntersectionType]);
		});
		const distributedType = createNormalizedUnionType(distributedChoices);
		return distributedType;
	}

	// And(A Not(A)) => Never
	if (ChoiceTypes.length === 2
		&& isComplementType(ChoiceTypes[1])
		&& ChoiceTypes[0] === ChoiceTypes[1].SourceType) {
		return Never;
	}

	return {
		[_julTypeSymbol]: 'and',
		ChoiceTypes: ChoiceTypes,
	};
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

function valueOf(type: CompileTimeType | null): CompileTimeType {
	switch (typeof type) {
		case 'boolean':
		case 'bigint':
		case 'number':
		case 'string':
		case 'undefined':
			return type;
		case 'object':
			if (type === null) {
				return Any;
			}
			if (isBuiltInType(type)) {
				switch (type[_julTypeSymbol]) {
					case 'dictionaryLiteral': {
						const fieldValues = mapDictionary(type.Fields, valueOf);
						return fieldValues;
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
						return type.ElementTypes.map(valueOf);
					case 'typeOf':
						return type.value;
					default:
						// TODO error?
						// return Any;
						return type;
				}
			}
			// array/dictionary
			return type;
		case 'function':
		case 'symbol':
			return Any;
		default: {
			const assertNever: never = type;
			throw new Error(`Unexpected type ${typeof assertNever} for valueOf`);
		}
	}
}

//#region TypeError

// TODO return true/false = always/never, sometimes/maybe?
function areArgsAssignableTo(
	prefixArgumentType: null | CompileTimeType,
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
	prefixArgumentType: null | CompileTimeType,
	argumentsType: CompileTimeType,
	targetType: CompileTimeType,
): TypeError | undefined {
	if (targetType === Any) {
		return undefined;
	}
	if (argumentsType === Any) {
		// TODO error/warning bei any?
		// error type bei assignment/function call?
		// maybe return value?
		return undefined;
	}
	if (argumentsType === targetType) {
		return undefined;
	}
	if (isBuiltInType(argumentsType)) {
		switch (argumentsType[_julTypeSymbol]) {
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
				if (dereferencedParameterType === null) {
					return undefined;
				}
				return getTypeError(prefixArgumentType, dereferencedParameterType, targetType);
			}
			default:
				break;
		}
	}
	// TODO generic types (customType, union/intersection, ...?)
	switch (typeof targetType) {
		case 'object': {
			if (isBuiltInType(targetType)) {
				switch (targetType[_julTypeSymbol]) {
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
					case 'any':
						throw new Error('Unexpected any targetType');
					case 'blob':
						break;
					case 'boolean':
						switch (typeof argumentsType) {
							case 'boolean':
								return undefined;

							default:
								break;
						}
						break;
					case 'date':
						break;
					case 'dictionary': {
						if (typeof argumentsType !== 'object') {
							// TODO type specific error?
							break;
						}
						if (!argumentsType) {
							// TODO null specific error?
							break;
						}
						const elementType = targetType.ElementType;
						if (_julTypeSymbol in argumentsType) {
							switch (argumentsType[_julTypeSymbol]) {
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
						if (Array.isArray(argumentsType)) {
							// TODO array specific error?
							break;
						}
						// plain Dictionary
						// TODO wird das gebraucht? aktuell wird dictionary type immer als dictionaryLiteralType inferred
						// wann tritt also dieser case ein? ggf ebenso mit array/tuple?
						const subErrors = map(
							argumentsType,
							(fieldType, fieldName) =>
								getDictionaryFieldError(fieldName, elementType, prefixArgumentType, fieldType),
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
					case 'dictionaryLiteral': {
						const error = getDictionaryLiteralTypeError(prefixArgumentType, argumentsType, targetType.Fields);
						if (error === true) {
							// Standardfehler
							break;
						}
						return error;
					}
					case 'error':
						break;
					case 'float':
						switch (typeof argumentsType) {
							case 'number':
								return undefined;

							default:
								break;
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
						if (((typeof greaterValue === 'bigint'
							&& typeof argumentsType === 'bigint')
							|| (typeof greaterValue === 'number'
								&& typeof argumentsType === 'number'))
							&& argumentsType > greaterValue) {
							return undefined;
						}
						break;
					}
					case 'integer':
						switch (typeof argumentsType) {
							case 'bigint':
								return undefined;

							default:
								break;
						}
						break;
					case 'list': {
						const targetElementType = targetType.ElementType;
						if (isBuiltInType(argumentsType)) {
							switch (argumentsType[_julTypeSymbol]) {
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
						}
						if (Array.isArray(argumentsType)) {
							const subErrors = argumentsType.map(valueElement =>
								getTypeError(prefixArgumentType, valueElement, targetElementType)).filter(isDefined);
							if (subErrors.length) {
								return {
									// TODO error struktur überdenken
									message: subErrors.map(typeErrorToString).join('\n'),
									// innerError
								};
							}
							return undefined;
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
							return {
								message: `${typeToString(argumentsType, 0)} is assignable to ${typeToString(targetType.SourceType, 0)}, but should not be.`
							};
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
						// return getTypeError(valueType, dereferenced ?? Any);
						return undefined;
					}
					case 'stream': {
						if (!isStreamType(argumentsType)) {
							break;
						}
						return getTypeError(prefixArgumentType, argumentsType.ValueType, targetType.ValueType);
					}
					case 'text':
						switch (typeof argumentsType) {
							case 'string':
								return undefined;

							default:
								break;
						}
						break;
					case 'tuple': {
						const error = getTupleTypeError(prefixArgumentType, argumentsType, targetType.ElementTypes);
						if (error === true) {
							// Standardfehler
							break;
						}
						return error;
					}
					case 'type':
						switch (typeof argumentsType) {
							case 'bigint':
							case 'boolean':
							case 'number':
							case 'string':
							case 'undefined':
								return undefined;
							case 'object':
								if (!argumentsType) {
									return undefined;
								}
								if (_julTypeSymbol in argumentsType) {
									switch (argumentsType[_julTypeSymbol]) {
										case 'boolean':
										case 'float':
										case 'integer':
										case 'text':
										case 'typeOf':
											return undefined;
										case 'tuple': {
											// alle ElementTypes müssen Typen sein
											const subErrors = argumentsType.ElementTypes.map(elementType =>
												getTypeError(null, elementType, targetType)).filter(isDefined);
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
								}
								break;
							default:
								break;
						}
						break;
					// TODO
					case 'typeOf':
						break;
					default: {
						const assertNever: never = targetType;
						throw new Error(`Unexpected targetType.type: ${(assertNever as BuiltInCompileTimeType)[_julTypeSymbol]}`);
					}
				}
			}
			else {
				// null/array/dictionary
				if (targetType === null) {
					break;
				}
				if (Array.isArray(targetType)) {
					const error = getTupleTypeError(prefixArgumentType, argumentsType, targetType);
					if (error === true) {
						// Standardfehler
						break;
					}
					return error;
				}
				// dictionary
				const error = getDictionaryLiteralTypeError(prefixArgumentType, argumentsType, targetType);
				if (error === true) {
					// Standardfehler
					break;
				}
				return error;
			}
			break;
		}
		default:
			break;
	}
	return { message: `Can not assign ${typeToString(argumentsType, 0)} to ${typeToString(targetType, 0)}.` };
}

/**
 * Liefert true bei Standardfehler, undefined bei keinem Fehler.
 */
function getTupleTypeError(
	prefixArgumentType: null | CompileTimeType,
	argumentsType: CompileTimeType,
	targetElementTypes: CompileTimeType[],
): TypeError | true | undefined {
	if (isBuiltInType(argumentsType)) {
		switch (argumentsType[_julTypeSymbol]) {
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
	if (Array.isArray(argumentsType)) {
		return getTupleTypeError2(prefixArgumentType, argumentsType, targetElementTypes);
	}
	return true;
}

function getTupleTypeError2(
	prefixArgumentType: null | CompileTimeType,
	argumentElementTypes: CompileTimeType[],
	targetElementTypes: CompileTimeType[],
): TypeError | undefined {
	// TODO fehler wenn argument mehr elemente entfält als target?
	const subErrors = targetElementTypes.map((targetElementType, index) => {
		const valueElement = argumentElementTypes[index];
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
	prefixArgumentType: null | CompileTimeType,
	argumentsType: CompileTimeType,
	targetFieldTypes: CompileTimeDictionary,
): TypeError | true | undefined {
	if (typeof argumentsType !== 'object') {
		// TODO type specific error?
		return true;
	}
	if (!argumentsType) {
		// TODO null specific error?
		return true;
	}
	if (_julTypeSymbol in argumentsType) {
		switch (argumentsType[_julTypeSymbol]) {
			case 'dictionaryLiteral': {
				const subErrors = map(
					targetFieldTypes,
					(fieldType, fieldName) =>
						// TODO the field x is missing error?
						getDictionaryFieldError(fieldName, fieldType, prefixArgumentType, argumentsType.Fields[fieldName]),
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
				break;
		}
		return true;
	}
	if (Array.isArray(argumentsType)) {
		// TODO array specific error?
		return true;
	}
	// plain Dictionary
	// TODO wird das gebraucht? aktuell wird dictionary type immer als dictionaryLiteralType inferred
	// wann tritt also dieser case ein? ggf ebenso mit array/tuple?
	const subErrors = map(
		targetFieldTypes,
		(fieldType, fieldName) =>
			// TODO the field x is missing error?
			getDictionaryFieldError(fieldName, fieldType, prefixArgumentType, argumentsType[fieldName]),
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

function getDictionaryFieldError(
	fieldName: string,
	fieldTargetType: CompileTimeType,
	prefixArgumentType: CompileTimeType | null,
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
	prefixArgumentType: null | CompileTimeType,
	argumentsType: CompileTimeType,
	targetType: ParametersType,
): TypeError | undefined {
	if (argumentsType !== undefined
		&& typeof argumentsType !== 'object') {
		throw new Error('argumentsType should be undefined or object but got' + typeof argumentsType);
	}
	if (isBuiltInType(argumentsType)) {
		// TODO other cases
		switch (argumentsType[_julTypeSymbol]) {
			case 'dictionaryLiteral':
				return getTypeErrorForParametersWithCollectionArgs(prefixArgumentType, argumentsType.Fields, targetType);
			case 'tuple':
				return getTypeErrorForParametersWithCollectionArgs(prefixArgumentType, argumentsType.ElementTypes, targetType);
			case 'parameters': {
				// TODO prefixArgumentType berücksichtigen?
				let index = 0;
				const targetSingleNames = targetType.singleNames;
				const valueSingleNames = argumentsType.singleNames;
				const valueRest = argumentsType.rest;
				const valueRestType = valueRest?.type;
				const valueRestItemType = valueRest
					? isListType(valueRestType)
						? valueRestType.ElementType
						: Any
					: null;
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
					const valueParameterType = valueParameter && getValueWithFallback(valueParameter.type, getValueWithFallback(valueRestItemType, Any));
					const error = targetParameterType
						? getTypeError(null, valueParameterType, targetParameterType)
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
						const valueParameterType = getValueWithFallback(valueParameter.type, getValueWithFallback(valueRestItemType, Any));
						const error = getTypeError(null, valueParameterType, targetRestType);
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
				return { message: 'getTypeErrorForWrappedArgs not implemented yet for ' + argumentsType[_julTypeSymbol] };
		}
	}
	return getTypeErrorForParametersWithCollectionArgs(prefixArgumentType, argumentsType, targetType);
}

function getTypeErrorForParametersWithCollectionArgs(
	prefixArgumentType: null | CompileTimeType,
	argumentsType: CompileTimeCollection | undefined,
	targetType: ParametersType,
): TypeError | undefined {
	const hasPrefixArg = prefixArgumentType !== null;
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
			argument = argumentsType && (isArray
				? argumentsType[argumentIndex]
				: argumentsType[name]);
			argumentIndex++;
		}
		const error = type
			? getTypeError(null, argument, type)
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
			const remainingArgs = hasPrefixArg && !paramIndex
				? [prefixArgumentType]
				: undefined;
			const error = restType
				? getTypeError(null, remainingArgs, restType)
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
				? getTypeError(null, remainingArgs, restType)
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

export function typeToString(type: CompileTimeType, indent: number): string {
	switch (typeof type) {
		case 'bigint':
		case 'boolean':
			return type.toString();
		case 'function':
			// TODO?
			throw new Error('typeToString not implemented yet for CustomFunction');
		case 'number':
			return type.toString() + 'f';
		case 'object': {
			if (type === null) {
				// TODO throw error?
				return '()';
			}
			if (Array.isArray(type)) {
				return arrayTypeToString(type, indent);
			}
			if (_julTypeSymbol in type) {
				const builtInType: BuiltInCompileTimeType = type;
				switch (builtInType[_julTypeSymbol]) {
					case 'and':
						return `And${arrayTypeToString(builtInType.ChoiceTypes, indent)}`;
					case 'any':
						return 'Any';
					case 'blob':
						return 'Blob';
					case 'boolean':
						return 'Boolean';
					case 'date':
						return 'Date';
					case 'dictionary':
						return `Dictionary(${typeToString(builtInType.ElementType, indent)})`;
					case 'dictionaryLiteral':
						return dictionaryTypeToString(builtInType.Fields, ': ', indent);
					case 'error':
						return 'Error';
					case 'float':
						return 'Float';
					case 'function':
						return `${typeToString(builtInType.ParamsType, indent)} :> ${typeToString(builtInType.ReturnType, indent)}`;
					case 'greater':
						return `Greater(${typeToString(builtInType.Value, indent)})`;
					case 'integer':
						return 'Integer';
					case 'list':
						return `List(${typeToString(builtInType.ElementType, indent)})`;
					case 'nestedReference':
						return `${typeToString(builtInType.source, indent)}/${builtInType.nestedKey}`;
					case 'never':
						return 'Never';
					case 'not':
						return `Not(${typeToString(builtInType.SourceType, indent)})`;
					case 'or':
						return `Or${arrayTypeToString(builtInType.ChoiceTypes, indent)}`;
					case 'parameters': {
						const rest = builtInType.rest;
						const multiline = builtInType.singleNames.length + (rest ? 1 : 0) > 1;
						const newIndent = multiline
							? indent + 1
							: indent;
						const elements = [
							...builtInType.singleNames.map(element => {
								return `${element.name}${optionalTypeGuardToString(element.type, newIndent)}`;
							}),
							...(rest ? [`...${rest.name}${optionalTypeGuardToString(rest.type, newIndent)}`] : []),
						];
						return bracketedExpressionToString(elements, multiline, indent);
					}
					case 'parameterReference':
						return builtInType.name;
					case 'stream':
						return `Stream(${typeToString(builtInType.ValueType, indent)})`;
					case 'text':
						return 'Text';
					case 'tuple':
						return arrayTypeToString(builtInType.ElementTypes, indent);
					case 'type':
						return 'Type';
					case 'typeOf':
						return `TypeOf(${typeToString(builtInType.value, indent)})`;
					default: {
						const assertNever: never = builtInType;
						throw new Error(`Unexpected BuiltInType ${(assertNever as BuiltInCompileTimeType)[_julTypeSymbol]}`);
					}
				}
			}
			// Dictionary
			return dictionaryTypeToString(type, ' = ', indent);
		}
		case 'string':
			return `§${type.replaceAll('§', '§§')}§`;
		case 'undefined':
			return '()';
		default: {
			const assertNever: never = type;
			throw new Error(`Unexpected type ${typeof assertNever}`);
		}
	}
}

function optionalTypeGuardToString(type: CompileTimeType | null, indent: number): string {
	return type
		? `: ${typeToString(type, indent)}`
		: '';
}

function arrayTypeToString(
	array: CompileTimeType[],
	indent: number,
): string {
	const multiline = array.length > maxElementsPerLine;
	const newIndent = multiline
		? indent + 1
		: indent;
	return bracketedExpressionToString(
		array.map(element =>
			typeToString(element, newIndent)),
		multiline,
		indent);
}

function dictionaryTypeToString(
	dictionary: CompileTimeDictionary,
	nameSeparator: string,
	indent: number,
): string {
	const multiline = Object.keys(dictionary).length > 1;
	const newIndent = multiline
		? indent + 1
		: indent;
	return bracketedExpressionToString(
		map(
			dictionary,
			(element, key) => {
				return `${key}${nameSeparator}${typeToString(element, newIndent)}`;
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

function getParamsType(possibleFunctionType: CompileTimeType | null): CompileTimeType {
	if (isFunctionType(possibleFunctionType)) {
		return possibleFunctionType.ParamsType;
	}
	return Any;
}

function getReturnTypeFromFunctionType(possibleFunctionType: CompileTimeType | null): CompileTimeType {
	if (isFunctionType(possibleFunctionType)) {
		return possibleFunctionType.ReturnType;
	}
	return Any;
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
	const typeGuardType = typeGuard.inferredType!;
	const typeGuardTypeError = areArgsAssignableTo(null, typeGuardType, Type);
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

//#region BuiltInType guards

export function isBuiltInType(type: CompileTimeType | null): type is BuiltInCompileTimeType {
	return typeof type === 'object'
		&& !!type
		&& _julTypeSymbol in type;
}

function isComplementType(type: CompileTimeType | null): type is CompileTimeComplementType {
	return isBuiltInType(type)
		&& type[_julTypeSymbol] === 'not';
}

function isDictionaryType(type: CompileTimeType | null): type is CompileTimeDictionaryType {
	return isBuiltInType(type)
		&& type[_julTypeSymbol] === 'dictionary';
}

export function isDictionaryLiteralType(type: CompileTimeType | null): type is CompileTimeDictionaryLiteralType {
	return isBuiltInType(type)
		&& type[_julTypeSymbol] === 'dictionaryLiteral';
}

export function isFunctionType(type: CompileTimeType | null): type is CompileTimeFunctionType {
	return isBuiltInType(type)
		&& type[_julTypeSymbol] === 'function';
}

export function isListType(type: CompileTimeType | null): type is CompileTimeListType {
	return isBuiltInType(type)
		&& type[_julTypeSymbol] === 'list';
}

export function isParametersType(type: CompileTimeType | null): type is ParametersType {
	return isBuiltInType(type)
		&& type[_julTypeSymbol] === 'parameters';
}

export function isParamterReference(type: CompileTimeType | null): type is ParameterReference {
	return isBuiltInType(type)
		&& type[_julTypeSymbol] === 'parameterReference';
}

function isStreamType(type: CompileTimeType | null): type is CompileTimeStreamType {
	return isBuiltInType(type)
		&& type[_julTypeSymbol] === 'stream';
}

export function isTupleType(type: CompileTimeType | null): type is CompileTimeTupleType {
	return isBuiltInType(type)
		&& type[_julTypeSymbol] === 'tuple';
}

export function isTypeOfType(type: CompileTimeType | null): type is CompileTimeTypeOfType {
	return isBuiltInType(type)
		&& type[_julTypeSymbol] === 'typeOf';
}

export function isUnionType(type: CompileTimeType | null): type is CompileTimeUnionType {
	return isBuiltInType(type)
		&& type[_julTypeSymbol] === 'or';
}

//#endregion BuiltInType guards