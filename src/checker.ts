import { join } from 'path';
import {
	Any,
	BuiltInTypeBase,
	Float,
	Integer,
	Type,
	deepEquals,
	_Boolean,
	_Date,
	_Error,
	_Text,
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
	CompileTimeIntersectionType,
	CompileTimeListType,
	CompileTimeStreamType,
	CompileTimeTupleType,
	CompileTimeType,
	CompileTimeTypeOfType,
	CompileTimeUnionType,
	NestedReference,
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
import { NonEmptyArray, getValueWithFallback, isDefined, isNonEmpty, last, map, mapDictionary } from './util.js';
import { coreLibPath, getPathFromImport, parseFile } from './parser/parser.js';
import { ParserError } from './parser/parser-combinator.js';
import { getCheckedEscapableName } from './parser/parser-utils.js';

export type ParsedDocuments = { [filePath: string]: ParsedFile; };

const maxElementsPerLine = 5;

const coreBuiltInSymbolTypes: { [key: string]: CompileTimeType; } = {
	true: true,
	false: false,
	Any: new CompileTimeTypeOfType(Any),
	Boolean: new CompileTimeTypeOfType(_Boolean),
	Integer: new CompileTimeTypeOfType(Integer),
	Float: new CompileTimeTypeOfType(Float),
	Text: new CompileTimeTypeOfType(_Text),
	Date: new CompileTimeTypeOfType(_Date),
	Error: new CompileTimeTypeOfType(_Error),
	List: (() => {
		const parameterReference = new ParameterReference('ElementType', 0);
		const functionType = new CompileTimeFunctionType(
			new ParametersType([{
				name: 'ElementType',
				type: Type,
			}]),
			new CompileTimeTypeOfType(new CompileTimeListType(parameterReference)),
			true,
		);
		parameterReference.functionRef = functionType;
		return functionType;
	})(),
	Dictionary: (() => {
		const parameterReference = new ParameterReference('ElementType', 0);
		const functionType = new CompileTimeFunctionType(
			new ParametersType([{
				name: 'ElementType',
				type: Type,
			}]),
			new CompileTimeTypeOfType(new CompileTimeDictionaryType(parameterReference)),
			true,
		);
		parameterReference.functionRef = functionType;
		return functionType;
	})(),
	Stream: (() => {
		const parameterReference = new ParameterReference('ValueType', 0);
		const functionType = new CompileTimeFunctionType(
			new ParametersType([{
				name: 'ValueType',
				type: Type,
			}]),
			new CompileTimeTypeOfType(new CompileTimeStreamType(parameterReference)),
			true,
		);
		parameterReference.functionRef = functionType;
		return functionType;
	})(),
	Type: new CompileTimeTypeOfType(Type),
	// ValueOf:  new FunctionType(
	// 		new _ParametersType({
	// 			T: _type,
	// 		}),
	// 		new ParameterReference([{
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
		const parameterReference = new ParameterReference('FunctionType', 0);
		const functionType = new CompileTimeFunctionType(
			new ParametersType([
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
	nativeValue: new CompileTimeFunctionType(
		new ParametersType([
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
		const parameterReference = new ParameterReference(reference.name.name, foundSymbol.functionParameterIndex);
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
	const referencedType = foundSymbol.normalizedType;
	if (referencedType === undefined) {
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

function dereferenceNameFromObject(
	name: string,
	sourceObjectType: CompileTimeType,
): CompileTimeType | undefined {
	if (sourceObjectType === null) {
		return null;
	}
	if (typeof sourceObjectType !== 'object') {
		return undefined;
	}
	if (sourceObjectType instanceof BuiltInTypeBase) {
		switch (sourceObjectType.type) {
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
						return undefined;
				}
			case 'list':
				// TODO error: cant dereference name in list 
				return undefined;
			case 'nestedReference':
			case 'parameterReference':
				return new NestedReference(sourceObjectType, name);
			case 'stream':
				switch (name) {
					case 'getValue':
						return new CompileTimeFunctionType(null, sourceObjectType.ValueType, false);
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
					if (innerType instanceof BuiltInTypeBase) {
						switch (innerType.type) {
							case 'dictionary':
								switch (name) {
									case 'ElementType':
										return innerType.ElementType;
									default:
										return undefined;
								}
							case 'list':
								switch (name) {
									case 'ElementType':
										return innerType.ElementType;
									default:
										return undefined;
								}
							case 'parameterReference':
								return new NestedReference(sourceObjectType, name);
							default:
								return undefined;
						}
					}
					if (Array.isArray(innerType)) {
						// TODO?
						switch (name) {
							case 'ElementType':
								return createNormalizedUnionType(innerType);
							default:
								return undefined;
						}
					}
					// case dictionary
					// TODO?
					switch (name) {
						case 'ElementType':
							return createNormalizedUnionType(Object.values(innerType));
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
	if (Array.isArray(sourceObjectType)) {
		// TODO error: cant dereference name in list 
		return undefined;
	}
	return sourceObjectType[name];
}

function dereferenceIndexFromObject(
	index: number,
	sourceObjectType: CompileTimeType,
): CompileTimeType | undefined {
	if (sourceObjectType === null) {
		return null;
	}
	if (typeof sourceObjectType !== 'object') {
		return undefined;
	}
	if (sourceObjectType instanceof BuiltInTypeBase) {
		switch (sourceObjectType.type) {
			case 'dictionaryLiteral':
				// TODO error: cant dereference index in dictionary type
				return undefined;
			case 'list':
				return sourceObjectType.ElementType;
			case 'parameterReference':
				return new NestedReference(sourceObjectType, index);
			case 'tuple':
				return sourceObjectType.ElementTypes[index - 1];
			// TODO other object types
			default:
				return undefined;
		}
	}
	if (Array.isArray(sourceObjectType)) {
		// TODO dereference by index
		return sourceObjectType[index - 1];
	}
	// TODO error: cant dereference index in dictionary
	return undefined;
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
	if (!(typeToDereference instanceof BuiltInTypeBase)) {
		return typeToDereference;
	}
	const builtInType: BuiltInCompileTimeType = typeToDereference;
	switch (builtInType.type) {
		case 'any':
		case 'blob':
		case 'boolean':
		case 'date':
		case 'error':
		case 'float':
		case 'integer':
		case 'text':
		case 'type':
			return builtInType;
		case 'and':
			return new CompileTimeIntersectionType(builtInType.ChoiceTypes.map(choiceType => dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, choiceType)));
		case 'dictionary':
			return new CompileTimeDictionaryType(dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, builtInType.ElementType));
		case 'list':
			return new CompileTimeListType(dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, builtInType.ElementType));
		case 'nestedReference': {
			const dereferencedSource = dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, builtInType.source);
			const nestedKey = builtInType.nestedKey;
			const dereferencedNested = typeof nestedKey === 'string'
				? dereferenceNameFromObject(nestedKey, dereferencedSource)
				: dereferenceIndexFromObject(nestedKey, dereferencedSource);
			if (dereferencedNested === undefined) {
				return Any;
			}
			return dereferencedNested;
		}
		case 'not':
			return new CompileTimeComplementType(dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, builtInType.SourceType));
		case 'or': {
			const dereferencedChoices = builtInType.ChoiceTypes.map(choiceType => dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, choiceType));
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
		case 'stream':
			return new CompileTimeStreamType(dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, builtInType.ValueType));
		case 'typeOf':
			return new CompileTimeTypeOfType(dereferenceArgumentTypesNested(calledFunction, prefixArgumentType, argsType, builtInType.value));
		// TODO
		case 'dictionaryLiteral':
		case 'function':
		case 'parameters':
		case 'tuple':
			return builtInType;
		default: {
			const assertNever: never = builtInType;
			throw new Error('Unexpected BuiltInType.type: ' + (assertNever as BuiltInCompileTimeType).type);
		}
	}
}

function dereferenceParameterFromArgumentType(
	calledFunction: CompileTimeType,
	prefixArgumentType: CompileTimeType | undefined,
	argsType: CompileTimeType,
	parameterReference: ParameterReference,
): CompileTimeType {
	if (parameterReference.functionRef !== calledFunction) {
		return parameterReference;
	}
	// TODO Param index nicht in ParameterReference, stattdessen mithilfe von parameterReference.functionRef.paramsType ermitteln?
	const paramIndex = parameterReference.index;
	if (prefixArgumentType !== undefined && paramIndex === 0) {
		return prefixArgumentType;
	}
	if (argsType === null) {
		return null;
	}
	if (!(argsType instanceof BuiltInTypeBase)) {
		return parameterReference;
	}
	switch (argsType.type) {
		case 'dictionaryLiteral': {
			const referenceName = parameterReference.name;
			const argType = argsType.Fields[referenceName];
			// TODO error bei unbound ref?
			if (!argType) {
				return parameterReference;
			}
			const dereferenced = dereferenceNameFromObject(referenceName, argType);
			if (dereferenced === undefined) {
				return parameterReference;
			}
			return dereferenced;
		}
		case 'tuple': {
			// TODO dereference nested path
			// const referenceName = parameterReference.path[0].name;
			const argIndex = prefixArgumentType === undefined
				? paramIndex
				: paramIndex - 1;
			const argType = argsType.ElementTypes[argIndex];
			// TODO error bei unbound ref?
			if (argType === undefined) {
				return parameterReference;
			}
			return argType;
		}
		case 'list':
		// TODO?
		default:
			return argsType;
	}
}

export function dereferenceParameterTypeFromFunctionRef(parameterReference: ParameterReference): CompileTimeType | undefined {
	const functionType = parameterReference.functionRef;
	if (functionType) {
		const paramsType = functionType.ParamsType;
		if (paramsType instanceof ParametersType) {
			const matchedParameter = paramsType.singleNames.find(parameter =>
				parameter.name === parameterReference.name);
			return matchedParameter?.type;
		}
	}
	return undefined;
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
	const scopes2 = [
		...scopes,
		file.symbols,
	] as any as NonEmptyArray<SymbolTable>;
	file.expressions?.forEach(expression => {
		setInferredType(expression, scopes2, parsedDocuments, sourceFolder, file);
	});
}

function setInferredType(
	expression: TypedExpression,
	scopes: NonEmptyArray<SymbolTable>,
	parsedDocuments: ParsedDocuments,
	sourceFolder: string,
	file: ParsedExpressions2,
): void {
	if (expression.inferredType) {
		return;
	}
	expression.inferredType = inferType(expression, scopes, parsedDocuments, sourceFolder, file);
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
				const functionType = new CompileTimeFunctionType(Any, Any, false);
				const nonFunctionError = areArgsAssignableTo(undefined, branch.inferredType!, functionType);
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
			const inferredType = getValueWithFallback(coreBuiltInSymbolTypes[name], getValueWithFallback(value?.inferredType, Any));
			checkNameDefinedInUpperScope(expression, scopes, errors, name);
			// TODO typecheck mit typeguard, ggf union mit Error type
			const currentScope = last(scopes);
			const symbol = currentScope[name];
			if (!symbol) {
				throw new Error(`Definition Symbol ${name} not found`);
			}
			symbol.normalizedType = inferredType;
			const typeGuard = expression.typeGuard;
			if (typeGuard) {
				setInferredType(typeGuard, scopes, parsedDocuments, folder, file);
				// TODO fix normalizeType
				// expression.normalizedTypeGuard = typeGuard.inferredType
				// valueExpression.normalizedTypeGuard = normalizeType(valueExpression.typeGuard);

				const error = areArgsAssignableTo(undefined, inferredType, valueOf(typeGuard.inferredType));
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
				const valueType = getValueWithFallback(value?.inferredType, Any);
				const dereferencedType = dereferenceNameFromObject(referenceName, valueType);
				if (dereferencedType === undefined) {
					errors.push({
						message: `Failed to dereference ${referenceName} in type ${typeToString(valueType, 0)}`,
						startRowIndex: field.startRowIndex,
						startColumnIndex: field.startColumnIndex,
						endRowIndex: field.endRowIndex,
						endColumnIndex: field.endColumnIndex,
					});
					return;
				}
				currentScope[fieldName]!.normalizedType = dereferencedType;
				const typeGuard = field.typeGuard;
				if (typeGuard) {
					setInferredType(typeGuard, scopes, parsedDocuments, folder, file);
					// TODO check value?
					const error = areArgsAssignableTo(undefined, dereferencedType, valueOf(typeGuard.inferredType));
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
						if (field.typeGuard) {
							setInferredType(field.typeGuard, scopes, parsedDocuments, folder, file);
						}
						const fieldName = getCheckedEscapableName(field.name);
						if (!fieldName) {
							return;
						}
						const fieldType = getValueWithFallback(field.value?.inferredType, Any);
						fieldTypes[fieldName] = fieldType;
						const fieldSymbol = expression.symbols[fieldName];
						if (!fieldSymbol) {
							throw new Error(`fieldSymbol ${fieldName} not found`);
						}
						fieldSymbol.normalizedType = fieldType;
						return;
					}
					case 'spread':
						const valueType = value?.inferredType;
						// TODO DictionaryType, ChoiceType etc ?
						if (valueType instanceof CompileTimeDictionaryLiteralType) {
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
			return new CompileTimeDictionaryLiteralType(fieldTypes);
		}
		case 'dictionaryType': {
			const fieldTypes: CompileTimeDictionary = {};
			expression.fields.forEach(field => {
				switch (field.type) {
					case 'singleDictionaryTypeField': {
						if (!field.typeGuard) {
							return;
						}
						setInferredType(field.typeGuard, scopes, parsedDocuments, folder, file);
						const fieldName = getCheckedEscapableName(field.name);
						if (!fieldName) {
							return;
						}
						const fieldType = valueOf(field.typeGuard.inferredType);
						fieldTypes[fieldName] = fieldType;
						const fieldSymbol = expression.symbols[fieldName];
						if (!fieldSymbol) {
							throw new Error(`fieldSymbol ${fieldName} not found`);
						}
						fieldSymbol.normalizedType = fieldType;
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
			return new CompileTimeTypeOfType(new CompileTimeDictionaryLiteralType(fieldTypes));
		}
		case 'empty':
			return null;
		case 'field':
			// TODO?
			return Any;
		case 'float':
			return expression.value;
		case 'fraction':
			return new CompileTimeDictionaryLiteralType({
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
					if (paramsType instanceof ParametersType) {
						const param = paramsType.singleNames[argIndex];
						if (param !== undefined
							&& param.type instanceof CompileTimeFunctionType) {
							const innerParamsType = param.type.ParamsType;
							if (arg.params.type === 'parameters') {
								arg.params.singleFields.forEach((literalParam, literalParamIndex) => {
									if (innerParamsType instanceof ParametersType) {
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
			setInferredType(args, scopes, parsedDocuments, folder, file);
			const argsType = args.inferredType!;
			const assignArgsError = areArgsAssignableTo(prefixArgument?.inferredType, argsType, paramsType);
			if (assignArgsError) {
				errors.push({
					message: assignArgsError,
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.endRowIndex,
					endColumnIndex: expression.endColumnIndex,
				});
			}
			function getReturnTypeFromFunctionCall(
				functionCall: ParseFunctionCall,
				functionExpression: SimpleExpression,
			): CompileTimeType {
				// TODO statt functionname functionref value/inferred type prüfen?
				if (functionExpression.type === 'reference') {
					const functionName = functionExpression.name.name;
					function getAllArgTypes(): (CompileTimeType[] | undefined) {
						const prefixArgTypes = prefixArgument
							? [prefixArgument.inferredType!]
							: [];
						if (argsType == null) {
							return prefixArgTypes;
						}
						if (!(argsType instanceof CompileTimeTupleType)) {
							// TODO other types
							return undefined;
						}
						const allArgTypes = [
							...prefixArgTypes,
							...argsType.ElementTypes,
						];
						return allArgTypes;
					}
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
									return getValueWithFallback(symbol.normalizedType, Any);
								});
								return new CompileTimeDictionaryLiteralType(importedTypes);
							}
							// value import
							// the last expression is imported
							if (!importedFile.expressions) {
								return Any;
							}
							return getValueWithFallback(last(importedFile.expressions)?.inferredType, Any);
						}
						// case 'nativeFunction': {
						// 	const argumentType = dereferenceArgumentType(argsType, new ParameterReference([{
						// 		type: 'name',
						// 		name: 'FunctionType',
						// 	}]));
						// 	return valueOf(argumentType);
						// }

						// case 'nativeValue': {
						// 	const argumentType = dereferenceArgumentType(argsType, new ParameterReference([{
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
						case 'length': {
							const argTypes = getAllArgTypes();
							const firstArgType = argTypes?.[0];
							return getLengthFromType(firstArgType);
						}
						case 'And': {
							const argTypes = getAllArgTypes();
							if (!argTypes) {
								// TODO unknown?
								return Any;
							}
							return new CompileTimeTypeOfType(new CompileTimeIntersectionType(argTypes.map(valueOf)));
						}
						case 'Not': {
							const argTypes = getAllArgTypes();
							if (!argTypes) {
								// TODO unknown?
								return Any;
							}
							if (!isNonEmpty(argTypes)) {
								// TODO unknown?
								return Any;
							}
							return new CompileTimeTypeOfType(new CompileTimeComplementType(valueOf(argTypes[0])));
						}
						case 'Or': {
							const argTypes = getAllArgTypes();
							if (!argTypes) {
								// TODO unknown?
								return Any;
							}
							const choices = argTypes.map(valueOf);
							const unionType = createNormalizedUnionType(choices);
							return new CompileTimeTypeOfType(unionType);
						}
						case 'TypeOf': {
							const argTypes = getAllArgTypes();
							if (!argTypes) {
								// TODO unknown?
								return Any;
							}
							if (!isNonEmpty(argTypes)) {
								// TODO unknown?
								return Any;
							}
							return new CompileTimeTypeOfType(argTypes[0]);
						}
						default:
							break;
					}
				}
				return getReturnTypeFromFunctionType(functionType);
			}
			const returnType = getReturnTypeFromFunctionCall(expression, functionExpression);
			// evaluate generic ReturnType
			const dereferencedReturnType = dereferenceArgumentTypesNested(functionType, prefixArgument?.inferredType, argsType, returnType);
			// const dereferencedReturnType2 = dereferenceArgumentTypesNested2(expression, prefixArgument?.inferredType, argsType, returnType);
			return dereferencedReturnType;
		}
		case 'functionLiteral': {
			const ownSymbols = expression.symbols;
			const functionScopes: NonEmptyArray<SymbolTable> = [...scopes, ownSymbols];
			const params = expression.params;
			const functionType = new CompileTimeFunctionType(
				null,
				null,
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
							normalizedType: paramsTypeValue,
						};
					}
				}
			}
			//#endregion narrowed type symbol für branching
			expression.body.forEach(bodyExpression => {
				setInferredType(bodyExpression, functionScopes, parsedDocuments, folder, file);
			});
			const inferredReturnType = last(expression.body)?.inferredType ?? null;
			const declaredReturnType = expression.returnType;
			if (declaredReturnType) {
				setInferredType(declaredReturnType, functionScopes, parsedDocuments, folder, file);
				const error = areArgsAssignableTo(undefined, inferredReturnType, valueOf(declaredReturnType.inferredType));
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
			const functionType = new CompileTimeFunctionType(
				null,
				null,
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
			if (inferredReturnType === undefined) {
				console.log(JSON.stringify(expression, undefined, 4));
				throw new Error('returnType was not inferred');
			}
			functionType.ReturnType = valueOf(inferredReturnType);
			return new CompileTimeTypeOfType(functionType);
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
			return new CompileTimeTupleType(expression.values.map(element => {
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
				if (inferredType instanceof CompileTimeDictionaryType
					|| inferredType instanceof CompileTimeDictionaryLiteralType) {
					hasDictionary = true;
				}
			});
			return Any;
		}
		case 'parameter': {
			if (expression.typeGuard) {
				setInferredType(expression.typeGuard, scopes, parsedDocuments, folder, file);
			}
			checkNameDefinedInUpperScope(expression, scopes, errors, expression.name.name);
			//#region infer argument type bei function literal welches inline argument eines function calls ist
			const inferredTypeFromCall = expression.inferredTypeFromCall;
			let dereferencedTypeFromCall = inferredTypeFromCall;
			if (inferredTypeFromCall !== undefined
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
					dereferencedTypeFromCall = dereferenceArgumentTypesNested(functionType, prefixArgument?.inferredType, null, inferredTypeFromCall);
				}
			}
			//#endregion
			const inferredType = getValueWithFallback(dereferencedTypeFromCall, valueOf(expression.typeGuard?.inferredType));
			// TODO check array type bei spread
			const parameterSymbol = findParameterSymbol(expression, scopes);
			parameterSymbol.normalizedType = inferredType;
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
			return new ParametersType(
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

// TODO überlappende choices zusammenfassen (Wenn A Teilmenge von B, dann ist Or(A B) = B)
function createNormalizedUnionType(choiceTypes: CompileTimeType[]): CompileTimeType {
	//#region flatten UnionTypes
	// Or(1 Or(2 3)) => Or(1 2 3)
	const flatChoices = choiceTypes.filter(choiceType =>
		!(choiceType instanceof CompileTimeUnionType));
	const unionChoices = choiceTypes.filter((choiceType): choiceType is CompileTimeUnionType =>
		choiceType instanceof CompileTimeUnionType);
	unionChoices.forEach(union => {
		flatChoices.push(...union.ChoiceTypes);
	});
	//#endregion flatten UnionTypes
	if (flatChoices.includes(Any)) {
		return Any;
	}
	//#region remove duplicates
	const uniqueChoices: CompileTimeType[] = [];
	flatChoices.forEach(choice => {
		if (!uniqueChoices.some(uniqueChoice =>
			deepEquals(choice, uniqueChoice))) {
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
	const streamChoices = uniqueChoices.filter((choiceType): choiceType is CompileTimeStreamType =>
		choiceType instanceof CompileTimeStreamType);
	let collapsedStreamChoices: CompileTimeType[];
	if (streamChoices.length > 1) {
		collapsedStreamChoices = [];
		const streamValueChoices = streamChoices.map(stream => stream.ValueType);
		const collapsedValueType = createNormalizedUnionType(streamValueChoices);
		collapsedStreamChoices.push(
			new CompileTimeStreamType(collapsedValueType),
			...uniqueChoices.filter(choiceType =>
				!(choiceType instanceof CompileTimeStreamType)),
		);
		if (collapsedStreamChoices.length === 1) {
			return collapsedStreamChoices[0]!;
		}
	}
	else {
		collapsedStreamChoices = uniqueChoices;
	}
	//#endregion collapse Streams
	return new CompileTimeUnionType(collapsedStreamChoices);
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
}

function valueOf(type: CompileTimeType | undefined): CompileTimeType {
	switch (typeof type) {
		case 'boolean':
		case 'bigint':
		case 'number':
		case 'string':
			return type;
		case 'object':
			if (type instanceof BuiltInTypeBase) {
				switch (type.type) {
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
			// null/array/dictionary
			return type;
		case 'function':
		case 'symbol':
		case 'undefined':
			return Any;
		default: {
			const assertNever: never = type;
			throw new Error(`Unexpected type ${typeof assertNever} for valueOf`);
		}
	}
}

function getLengthFromType(argType: CompileTimeType | undefined): CompileTimeType {
	if (typeof argType !== 'object') {
		// TODO non negative
		return Integer;
	}
	if (argType === null) {
		return 0n;
	}
	if (argType instanceof BuiltInTypeBase) {
		switch (argType.type) {
			case 'tuple':
				return BigInt(argType.ElementTypes.length);
			case 'list':
				// TODO positive
				return Integer;
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

//#region TypeError

// TODO return true/false = always/never, sometimes/maybe?
function areArgsAssignableTo(
	prefixArgumentType: undefined | CompileTimeType,
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
	prefixArgumentType: undefined | CompileTimeType,
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
	if (deepEquals(argumentsType, targetType)) {
		return undefined;
	}
	if (argumentsType instanceof BuiltInTypeBase) {
		switch (argumentsType.type) {
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
				if (dereferencedParameterType === undefined) {
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
		// case 'boolean':
		// 	// true/false literal type
		// 	switch (typeof valueType) {
		// 		case 'object':
		// 			if (valueType instanceof BuiltInTypeBase) {
		// 				switch (valueType.type) {
		// 					case 'boolean':
		// 						// TODO return maybe?
		// 						return undefined;

		// 					default:
		// 						break;
		// 				}
		// 			}
		// 			break;

		// 		default:
		// 			break;
		// 	}
		// 	break;
		case 'object': {
			if (targetType instanceof BuiltInTypeBase) {
				switch (targetType.type) {
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
						if (argumentsType instanceof BuiltInTypeBase) {
							switch (argumentsType.type) {
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
						if (!(argumentsType instanceof CompileTimeFunctionType)) {
							break;
						}
						// check args params obermenge von target params und args returntype teilmenge von target returntype
						const paramsError = getTypeError(prefixArgumentType, targetType.ParamsType, argumentsType.ParamsType);
						if (paramsError) {
							return paramsError;
						}
						return getTypeError(prefixArgumentType, argumentsType.ReturnType, targetType.ReturnType);
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
						if (argumentsType instanceof BuiltInTypeBase) {
							switch (argumentsType.type) {
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
						if (!(argumentsType instanceof CompileTimeStreamType)) {
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
								return undefined;
							case 'object':
								if (!argumentsType) {
									return undefined;
								}
								if (argumentsType instanceof BuiltInTypeBase) {
									switch (argumentsType.type) {
										case 'boolean':
										case 'float':
										case 'integer':
										case 'text':
										case 'typeOf':
											return undefined;
										// TODO check inner types rekursiv
										case 'dictionary':
										case 'dictionaryLiteral':
										case 'list':
										case 'tuple':
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
						throw new Error(`Unexpected targetType.type: ${(assertNever as BuiltInCompileTimeType).type}`);
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
	prefixArgumentType: undefined | CompileTimeType,
	argumentsType: CompileTimeType,
	targetElementTypes: CompileTimeType[],
): TypeError | true | undefined {
	if (argumentsType instanceof BuiltInTypeBase) {
		switch (argumentsType.type) {
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
	prefixArgumentType: undefined | CompileTimeType,
	argumentElementTypes: CompileTimeType[],
	targetElementTypes: CompileTimeType[],
): TypeError | undefined {
	// TODO fehler wenn argument mehr elemente entfält als target?
	const subErrors = targetElementTypes.map((targetElementType, index) => {
		const valueElement = argumentElementTypes[index];
		if (valueElement === undefined) {
			// TODO kein Fehler bei empty target?
			const error: TypeError = {
				message: `Missing element at position ${index + 1}. Expected ${typeToString(targetElementType, 0)}.`,
			};
			return error;
		}
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
	prefixArgumentType: undefined | CompileTimeType,
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
	if (argumentsType instanceof BuiltInTypeBase) {
		switch (argumentsType.type) {
			case 'dictionaryLiteral': {
				const subErrors = map(
					targetFieldTypes,
					(fieldType, fieldName) =>
						// TODO the field x is missing error?
						getDictionaryFieldError(fieldName, fieldType, prefixArgumentType, argumentsType.Fields[fieldName] ?? null),
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
			getDictionaryFieldError(fieldName, fieldType, prefixArgumentType, argumentsType[fieldName] ?? null),
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
	prefixArgumentType: undefined | CompileTimeType,
	argumentsType: CompileTimeType,
	targetType: ParametersType,
): TypeError | undefined {
	if (typeof argumentsType !== 'object') {
		throw new Error('wrappedValue should be object but got' + typeof argumentsType);
	}
	if (argumentsType instanceof BuiltInTypeBase) {
		// TODO other cases
		switch (argumentsType.type) {
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
					? valueRestType instanceof CompileTimeListType
						? valueRestType.ElementType
						: Any
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
					const valueParameterType = valueParameter
						? getValueWithFallback(valueParameter.type, getValueWithFallback(valueRestItemType, Any))
						: null;
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
						const valueParameterType = getValueWithFallback(valueParameter.type, getValueWithFallback(valueRestItemType, Any));
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
				return { message: 'getTypeErrorForWrappedArgs not implemented yet for ' + argumentsType.type };
		}
	}
	return getTypeErrorForParametersWithCollectionArgs(prefixArgumentType, argumentsType, targetType);
}

function getTypeErrorForParametersWithCollectionArgs(
	prefixArgumentType: undefined | CompileTimeType,
	argumentsType: CompileTimeCollection | null,
	targetType: ParametersType,
): TypeError | undefined {
	const hasPrefixArg = prefixArgumentType !== undefined;
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
			argument = argumentsType
				? (isArray
					? argumentsType[argumentIndex]
					: argumentsType[name]) ?? null
				: null;
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
			const remainingArgs = hasPrefixArg && !paramIndex
				? [prefixArgumentType]
				: null;
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
				? getTypeError(undefined, remainingArgs, restType)
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
		case 'string':
			return `§${type.replaceAll('§', '§§')}§`;
		case 'bigint':
		case 'boolean':
			return type.toString();
		case 'number':
			return type.toString() + 'f';
		case 'object': {
			if (type === null) {
				return '()';
			}
			if (Array.isArray(type)) {
				return arrayTypeToString(type, indent);
			}
			if (type instanceof BuiltInTypeBase) {
				const builtInType: BuiltInCompileTimeType = type;
				switch (builtInType.type) {
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
					case 'integer':
						return 'Integer';
					case 'list':
						return `List(${typeToString(builtInType.ElementType, indent)})`;
					case 'nestedReference':
						return `${typeToString(builtInType.source, indent)}/${builtInType.nestedKey}`;
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
						throw new Error(`Unexpected BuiltInType ${(assertNever as BuiltInCompileTimeType).type}`);
					}
				}
			}
			// Dictionary
			return dictionaryTypeToString(type, ' = ', indent);
		}
		case 'function':
			// TODO?
			throw new Error('typeToString not implemented yet for CustomFunction');
		default: {
			const assertNever: never = type;
			throw new Error(`Unexpected type ${typeof assertNever}`);
		}
	}
}

function optionalTypeGuardToString(type: CompileTimeType | undefined, indent: number): string {
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
	dictionary: { [key: string]: CompileTimeType; },
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

function getParamsType(possibleFunctionType: CompileTimeType | undefined): CompileTimeType {
	if (possibleFunctionType instanceof CompileTimeFunctionType) {
		return possibleFunctionType.ParamsType;
	}
	return Any;
}

function getReturnTypeFromFunctionType(possibleFunctionType: CompileTimeType | undefined): CompileTimeType {
	if (possibleFunctionType instanceof CompileTimeFunctionType) {
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