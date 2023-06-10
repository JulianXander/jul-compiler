import { extname, join } from 'path';
import { getCheckedEscapableName } from './checker';
import {
	Any,
	BuiltInType,
	BuiltInTypeBase,
	Collection,
	ComplementType,
	DictionaryLiteralType,
	Float,
	// EmptyType,
	FunctionType,
	Integer,
	IntersectionType,
	ParameterReference,
	Primitive,
	ReferencePath,
	RuntimeType,
	StreamType,
	TupleType,
	Type,
	TypeOfType,
	UnionType,
	_Boolean,
	_Error,
	ListType,
	ParametersType,
	_String,
	deepEquals,
	DictionaryType
} from './runtime';
import {
	BracketedExpression,
	CheckedValueExpression,
	ParseDictionaryField,
	ParseDictionaryTypeField,
	ParseFunctionCall,
	ParseListValue,
	ParsedFile,
	Reference,
	StringToken,
	SymbolDefinition,
	SymbolTable,
	TypedExpression
} from './syntax-tree';
import { NonEmptyArray, isDefined, isNonEmpty, last, map, mapDictionary, toDictionary } from './util';
import { parseFile } from './parser';
import { ParserError } from './parser-combinator';
import { getCheckedName } from './checker';

export type ParsedDocuments = { [filePath: string]: ParsedFile; };

const maxElementsPerLine = 5;

// const anyType: Any = {
// 	type: 'any'
// };

// const emptyType: EmptyType = {
// 	type: 'empty'
// };

// const stringType: StringType = {
// 	type: 'string'
// };

const coreBuiltInSymbolTypes: { [key: string]: RuntimeType; } = {
	true: true,
	false: false,
	Any: new TypeOfType(Any),
	Boolean: new TypeOfType(_Boolean),
	Integer: new TypeOfType(Integer),
	Float: new TypeOfType(Float),
	String: new TypeOfType(_String),
	Error: new TypeOfType(_Error),
	List: new FunctionType(
		new ParametersType([{
			name: 'ElementType',
			type: Type,
		}]),
		new TypeOfType(new ListType(new ParameterReference([{
			type: 'name',
			name: 'ElementType',
		}], 0))),
	),
	Dictionary: new FunctionType(
		new ParametersType([{
			name: 'ElementType',
			type: Type,
		}]),
		new TypeOfType(new DictionaryType(new ParameterReference([{
			type: 'name',
			name: 'ElementType',
		}], 0))),
	),
	Stream: new FunctionType(
		new ParametersType([{
			name: 'ValueType',
			type: Type,
		}]),
		new TypeOfType(new StreamType(new ParameterReference([{
			type: 'name',
			name: 'ValueType',
		}], 0))),
	),
	Type: new TypeOfType(Type),
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
	nativeFunction: new FunctionType(
		new ParametersType([
			{
				name: 'FunctionType',
				// TODO functionType
				type: Type,
			},
			{
				name: 'js',
				type: _String,
			},
		]),
		new ParameterReference([{
			type: 'name',
			name: 'FunctionType',
		}], 0),
	),
	nativeValue: new FunctionType(
		new ParametersType([
			{
				name: 'js',
				type: _String,
			},
		]),
		Any,
	),
};

export const coreLibPath = join(__dirname, 'core-lib.jul');
const parsedCoreLib = parseFile(coreLibPath);
inferFileTypes(parsedCoreLib, [], {}, '');
export const builtInSymbols: SymbolTable = parsedCoreLib.symbols;

export function dereferenceWithBuiltIns(path: ReferencePath, scopes: SymbolTable[]): {
	isBuiltIn: boolean;
	symbol: SymbolDefinition;
} | undefined {
	// TODO nested ref path
	const name = path[0].name;
	return findSymbolInScopesWithBuiltIns(name, scopes);
}

function dereferenceFromObject(reference: Reference, sourceObjectType: RuntimeType): RuntimeType | undefined {
	// TODO nested ref path
	const name = reference.path[0].name;
	if (typeof sourceObjectType !== 'object'
		|| !sourceObjectType) {
		return undefined;
	}
	if (sourceObjectType instanceof BuiltInTypeBase) {
		switch (sourceObjectType.type) {
			case 'dictionaryLiteral':
				return sourceObjectType.fields[name];
			// TODO other object types

			default:
				return undefined;
		}
	}
	if (Array.isArray(sourceObjectType)) {
		// TODO dereference by index
		return undefined;
	}
	return sourceObjectType[name];
}

function dereferenceType(reference: Reference, scopes: SymbolTable[]): {
	type: RuntimeType;
	found: boolean;
} {
	// TODO nested ref path
	const name = reference.path[0].name;
	const coreType = coreBuiltInSymbolTypes[name];
	if (coreType !== undefined) {
		return {
			type: coreType,
			found: true,
		};
	}
	const foundSymbol = findSymbolInScopes(name, scopes);
	if (!foundSymbol) {
		return {
			type: Any,
			found: false,
		};
	}
	if (foundSymbol.functionParameterIndex !== undefined) {
		// TODO ParameterReference nur liefern, wenn Symbol im untersten Scope gefunden,
		// da ParameterReference auf höhere Funktionen problematisch ist?
		return {
			type: new ParameterReference(reference.path, foundSymbol.functionParameterIndex),
			found: true,
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
			found: true
		};
	}
	return {
		type: referencedType,
		found: true
	};
}

function findSymbolInScopesWithBuiltIns(name: string, scopes: SymbolTable[]): {
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
		symbol: ownSymbol,
	};
}

function findSymbolInScopes(name: string, scopes: SymbolTable[]): SymbolDefinition | undefined {
	for (const scope of scopes) {
		const symbol = scope[name];
		if (symbol) {
			return symbol;
		}
	}
}

/**
 * infer types of expressions, normalize typeGuards
 * fills errors
 */
export function checkTypes(
	document: ParsedFile,
	documents: ParsedDocuments,
	folder: string,
): void {
	inferFileTypes(document, [builtInSymbols], documents, folder);
}

function inferFileTypes(
	file: ParsedFile,
	scopes: SymbolTable[],
	parsedDocuments: ParsedDocuments,
	folder: string,
): void {
	const scopes2 = [
		...scopes,
		file.symbols,
	] as any as NonEmptyArray<SymbolTable>;
	file.expressions?.forEach(expression => {
		setInferredType(expression, scopes2, parsedDocuments, folder, file);
	});
}

function setInferredType(
	expression: TypedExpression,
	scopes: NonEmptyArray<SymbolTable>,
	parsedDocuments: ParsedDocuments,
	folder: string,
	file: ParsedFile,
): void {
	if (expression.inferredType) {
		return;
	}
	expression.inferredType = inferType(expression, scopes, parsedDocuments, folder, file);
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
	file: ParsedFile,
): RuntimeType {
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
				if (index) {
					// Fehler, wenn ParameterTyp des Branches schon von vorherigen Branches abgedeckt.
					// Also wenn aktueller ParamterTyp Teilmenge der Veroderung der vorherigen ParameterTypen ist.
					const previousTypes = branches.slice(0, index).map(previousBranch => {
						return getParamsType(previousBranch.inferredType);
					});
					const combinedPreviousType = new UnionType(previousTypes);
					const currentParamsType = getParamsType(branch.inferredType);
					const error = isTypeAssignableTo(currentParamsType, combinedPreviousType);
					if (!error) {
						errors.push({
							message: 'Unreachable branch detected.',
							startRowIndex: branch.startRowIndex,
							startColumnIndex: branch.startColumnIndex,
							endRowIndex: branch.endRowIndex,
							endColumnIndex: branch.endColumnIndex,
						});
					}
				}
			});
			// TODO normalize (flatten) UnionType, wenn any verodert => return any
			return new UnionType(expression.branches.map(branch => {
				return getReturnType(branch.inferredType);
			}));
		}
		case 'definition': {
			setInferredType(expression.value, scopes, parsedDocuments, folder, file);
			const inferredType = coreBuiltInSymbolTypes[expression.name.name] ?? expression.value.inferredType!;
			const currentScope = last(scopes);
			// TODO typecheck mit typeguard, ggf union mit Error type
			currentScope[expression.name.name]!.normalizedType = inferredType;
			const typeGuard = expression.typeGuard;
			if (typeGuard) {
				setInferredType(typeGuard, scopes, parsedDocuments, folder, file);
				// TODO fix normalizeType
				// expression.normalizedTypeGuard = typeGuard.inferredType
				// valueExpression.normalizedTypeGuard = normalizeType(valueExpression.typeGuard);

				const error = isTypeAssignableTo(inferredType, valueOf(typeGuard.inferredType));
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
			setInferredType(value, scopes, parsedDocuments, folder, file);
			const currentScope = last(scopes);
			expression.fields.fields.forEach(field => {
				if (field.spread) {
					// TODO?
				}
				else {
					const fieldName = getCheckedName(field.name);
					if (!fieldName) {
						return;
					}
					const pathToDereference = field.assignedValue ?? field.name;
					if (pathToDereference.type !== 'reference') {
						return;
					}
					const valueType = value.inferredType!;
					const dereferencedType = dereferenceFromObject(pathToDereference, valueType);
					if (dereferencedType === undefined) {
						errors.push({
							message: `Failed to dereference ${referencePathToString(pathToDereference.path)} in type ${typeToString(valueType, 0)}`,
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
						// TODO check value, check fallback?
						const error = isTypeAssignableTo(dereferencedType, valueOf(typeGuard.inferredType));
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
				}
			});
			return Any;
		}
		case 'dictionary': {
			const fieldTypes: { [key: string]: RuntimeType; } = {};
			expression.fields.forEach(field => {
				setInferredType(field.value, scopes, parsedDocuments, folder, file);
				switch (field.type) {
					case 'singleDictionaryField': {
						if (field.fallback) {
							setInferredType(field.fallback, scopes, parsedDocuments, folder, file);
						}
						if (field.typeGuard) {
							setInferredType(field.typeGuard, scopes, parsedDocuments, folder, file);
						}
						const fieldName = getCheckedEscapableName(field.name);
						if (!fieldName) {
							return;
						}
						fieldTypes[fieldName] = field.value.inferredType!;
						return;
					}
					case 'spread':
						// TODO spread fields flach machen
						return;
					default: {
						const assertNever: never = field;
						throw new Error('Unexpected Dictionary field type ' + (assertNever as ParseDictionaryField).type);
					}
				}
			})
			return new DictionaryLiteralType(fieldTypes);
		}
		case 'dictionaryType': {
			const fieldTypes: { [key: string]: RuntimeType; } = {};
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
						fieldTypes[fieldName] = valueOf(field.typeGuard.inferredType);
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
			return new TypeOfType(new DictionaryLiteralType(fieldTypes));
		}
		case 'empty':
			return null;
		case 'field':
			// TODO?
			return Any;
		case 'float':
			return expression.value;
		case 'fraction':
			return new DictionaryLiteralType({
				numerator: expression.numerator,
				denominator: expression.denominator,
			});
		case 'functionCall': {
			// TODO provide args types for conditional/generic/derived type?
			// TODO infer last body expression type for returnType
			const functionReference = expression.functionReference;
			setInferredType(functionReference, scopes, parsedDocuments, folder, file);
			setInferredType(expression.arguments, scopes, parsedDocuments, folder, file);
			const argsType = expression.arguments.inferredType!;
			const functionType = functionReference.inferredType;
			const paramsType = getParamsType(functionType);
			// TODO function parameter assignment logik berücksichtigen
			const assignArgsError = isTypeAssignableTo(argsType, paramsType);
			if (assignArgsError) {
				errors.push({
					message: assignArgsError,
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.endRowIndex,
					endColumnIndex: expression.endColumnIndex,
				});
			}
			// TODO statt functionname functionref value/inferred type prüfen?
			if (functionReference.path.length === 1) {
				const functionName = functionReference.path[0].name;
				switch (functionName) {
					case 'import': {
						const { path, error } = getPathFromImport(expression);
						if (error) {
							errors.push(error)
						}
						if (!path) {
							return Any;
						}
						// TODO get full path, get type from parsedfile
						const fullPath = join(folder, path);
						const importedFile = parsedDocuments[fullPath];
						if (!importedFile) {
							return Any;
						}
						const importedTypes = mapDictionary(importedFile.symbols, symbol => {
							return symbol.normalizedType!;
						});
						return new DictionaryLiteralType(importedTypes);
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
					case 'And': {
						//TODO andere array args types?
						if (!(argsType instanceof TupleType)) {
							// TODO error?
							return Any;
						}
						return new TypeOfType(new IntersectionType(argsType.elementTypes.map(valueOf)));
					}
					case 'Or': {
						//TODO andere array args types?
						if (!(argsType instanceof TupleType)) {
							// TODO error?
							return Any;
						}
						return new TypeOfType(new UnionType(argsType.elementTypes.map(valueOf)));
					}
					case 'Not': {
						//TODO andere array args types?
						if (!(argsType instanceof TupleType)) {
							// TODO error?
							return Any;
						}
						if (!isNonEmpty(argsType.elementTypes)) {
							// TODO error?
							return Any;
						}
						return new TypeOfType(new ComplementType(valueOf(argsType.elementTypes[0])));
					}
					default:
						break;
				}
			}
			const returnType = getReturnType(functionType);
			// evaluate generic ReturnType
			const dereferencedReturnType = dereferenceArgumentTypesNested(argsType, returnType);
			return dereferencedReturnType;
		}
		case 'functionLiteral': {
			const functionScopes: NonEmptyArray<SymbolTable> = [...scopes, expression.symbols];
			setInferredType(expression.params, functionScopes, parsedDocuments, folder, file);
			expression.body.forEach(bodyExpression => {
				setInferredType(bodyExpression, functionScopes, parsedDocuments, folder, file);
			});
			const inferredReturnType = last(expression.body)?.inferredType ?? null;
			const declaredReturnType = expression.returnType;
			if (declaredReturnType) {
				setInferredType(declaredReturnType, functionScopes, parsedDocuments, folder, file);
				const error = isTypeAssignableTo(inferredReturnType, valueOf(declaredReturnType.inferredType));
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
			return new FunctionType(
				// TODO valueOf?
				expression.params.inferredType!,
				inferredReturnType,
			);
		}
		case 'functionTypeLiteral': {
			const functionScopes: NonEmptyArray<SymbolTable> = [...scopes, expression.symbols];
			setInferredType(expression.params, functionScopes, parsedDocuments, folder, file);
			// TODO parameterReference
			setInferredType(expression.returnType, functionScopes, parsedDocuments, folder, file);
			const inferredReturnType = expression.returnType.inferredType;
			if (inferredReturnType === undefined) {
				console.log(JSON.stringify(expression, undefined, 4));
				throw new Error('returnType was not inferred');
			}
			return new TypeOfType(new FunctionType(
				// TODO valueOf bei non Parameters Type?
				expression.params.inferredType!,
				valueOf(inferredReturnType),
			));
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
			return new TupleType(expression.values.map(element => {
				if (element.type === 'spread') {
					// TODO flatten spread tuple value type
					return Any;
				}
				return element.inferredType!;
			}));
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
				if (inferredType instanceof DictionaryType
					|| inferredType instanceof DictionaryLiteralType) {
					hasDictionary = true;
				}
			});
			return Any;
		}
		case 'parameter': {
			if (expression.typeGuard) {
				setInferredType(expression.typeGuard, scopes, parsedDocuments, folder, file);
			}
			if (expression.fallback) {
				setInferredType(expression.fallback, scopes, parsedDocuments, folder, file);
			}
			// TODO fallback berücksichtigen?
			const inferredType = valueOf(expression.typeGuard?.inferredType);
			// TODO check array type bei spread
			const currentScope = last(scopes);
			const parameterName = expression.name.name;
			const parameterSymbol = currentScope[parameterName];
			if (!parameterSymbol) {
				console.log(scopes);
				throw new Error(`parameterSymbol ${parameterName} not found`);
			}
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
			const { found, type } = dereferenceType(expression, scopes);
			if (!found) {
				errors.push({
					message: `${referencePathToString(expression.path)} is not defined`,
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.endRowIndex,
					endColumnIndex: expression.endColumnIndex,
				})
			}
			return type;
		}
		case 'string': {
			// TODO string template type?
			if (expression.values.every((part): part is StringToken => part.type === 'stringToken')) {
				// string literal type
				// TODO sollte hier überhaupt mehrelementiger string möglich sein?
				return expression.values.map(part => part.value).join('\n');
			}
			return _String;
		}
		default: {
			const assertNever: never = expression;
			throw new Error(`Unexpected valueExpression.type: ${(assertNever as CheckedValueExpression).type}`);
		}
	}
}

function valueOf(type: RuntimeType | undefined): RuntimeType {
	switch (typeof type) {
		case 'boolean':
		case 'bigint':
		case 'number':
		case 'string':
			return type;
		case 'object':
			if (type instanceof BuiltInTypeBase) {
				if (type instanceof TypeOfType) {
					return type.value;
				}
				// TODO error?
				return Any;
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

function dereferenceArgumentTypesNested(argsType: RuntimeType, typeToDereference: RuntimeType): RuntimeType {
	if (!(typeToDereference instanceof BuiltInTypeBase)) {
		return typeToDereference;
	}
	const builtInType: BuiltInType = typeToDereference;
	switch (builtInType.type) {
		case 'any':
		case 'boolean':
		case 'error':
		case 'float':
		case 'integer':
		case 'string':
		case 'type':
			return builtInType;
		case 'and':
			return new IntersectionType(builtInType.choiceTypes.map(choiceType => dereferenceArgumentTypesNested(argsType, choiceType)));
		case 'dictionary':
			return new DictionaryType(dereferenceArgumentTypesNested(argsType, builtInType.elementType));
		case 'list':
			return new ListType(dereferenceArgumentTypesNested(argsType, builtInType.elementType));
		case 'not':
			return new ComplementType(dereferenceArgumentTypesNested(argsType, builtInType.sourceType));
		case 'or':
			return new UnionType(builtInType.choiceTypes.map(choiceType => dereferenceArgumentTypesNested(argsType, choiceType)));
		case 'reference':
			// TODO immer valueOf?
			return valueOf(dereferenceArgumentType(argsType, builtInType));
		case 'stream':
			return new StreamType(dereferenceArgumentTypesNested(argsType, builtInType.valueType));
		case 'typeOf':
			return new TypeOfType(dereferenceArgumentTypesNested(argsType, builtInType.value));
		// TODO
		case 'dictionaryLiteral':
		case 'function':
		case 'parameters':
		case 'tuple':
			return builtInType;
		default: {
			const assertNever: never = builtInType;
			throw new Error('Unexpected BuiltInType.type: ' + (assertNever as BuiltInType).type);
		}
	}
}

function dereferenceArgumentType(argsType: RuntimeType, parameterReference: ParameterReference): RuntimeType | undefined {
	if (!(argsType instanceof BuiltInTypeBase)) {
		return undefined;
	}
	switch (argsType.type) {
		case 'dictionaryLiteral': {
			// TODO dereference nested path
			const referenceName = parameterReference.path[0].name;
			const argType = argsType.fields[referenceName];
			// TODO error bei unbound ref?
			return argType;
		}
		case 'tuple': {
			// TODO Param index nicht in ParameterReference, stattdessen mithilfe von parameterReference.functionRef.paramsType ermitteln?
			// TODO dereference nested path
			// const referenceName = parameterReference.path[0].name;
			const paramIndex = parameterReference.index;
			const argType = argsType.elementTypes[paramIndex];
			// TODO error bei unbound ref?
			return argType;
		}
		case 'list':
		// TODO?
		default:
			return argsType;
	}
}

// TODO flatten nested or/and
// TODO distribute and>or nesting chain
// TODO merge dictionaries bei and, spread
// TODO resolve dereferences
// function normalizeType(typeExpression: CheckedValueExpression): Type {
// 	switch (typeExpression.type) {

// 		case 'branching':
// 			// TODO union branch return types?
// 			// TODO conditional type?
// 			return;

// 		case 'dictionary':
// 			// TODO dictionary literal type?
// 			return;

// 		case 'dictionaryType': {
// 			const normalizedDictionaryType: DictionaryLiteralType = {
// 				type: 'dictionaryLiteral',
// 				fields: {}
// 			};
// 			typeExpression.fields.forEach(field => {
// 				// TODO check field name already defined?
// 				switch (field.type) {
// 					case 'singleDictionaryTypeField':
// 						normalizedDictionaryType.fields[field.name] = normalizeType(field.typeGuard);
// 						return;

// 					case 'spreadDictionaryTypeField': {
// 						// merge dictionaries bei spread
// 						const normalizedSpread = normalizeType(field.value);
// 						if (normalizedSpread.type !== 'dictionaryLiteral') {
// 							// TODO?
// 							throw new Error(`Can not spread ${normalizedSpread.type} into dictionary type`);
// 						}
// 						for (const key in normalizedSpread.fields) {
// 							normalizedDictionaryType.fields[key] = normalizedSpread.fields[key];
// 						}
// 						return;
// 					}

// 					default: {
// 						const assertNever: never = field;
// 						throw new Error(`Unexpected field.type: ${(assertNever as any).type}`);
// 					}
// 				}
// 			});
// 			return normalizedDictionaryType;
// 		}

// 		case 'empty':
// 			return emptyType;

// 		case 'functionCall': {
// 			// TODO was wenn dereference chain?
// 			const functionName = typeExpression.functionReference.names[0].name;
// 			switch (functionName) {
// 				case 'Or': {
// 					const args = typeExpression.arguments;
// 					switch (args.type) {
// 						case 'empty':
// 							return emptyType;

// 						case 'dictionary':
// 							// TODO error? dictionary to array?
// 							throw new Error('unexpected arguments for Or: dictionary');

// 						case 'list': {
// 							const normalizedArgs = args.values.map(normalizeType);
// 							const or: UnionType = {
// 								type: 'or',
// 								orTypes: [],
// 							};
// 							// flatten nested or
// 							normalizedArgs.forEach(argument => {
// 								if (argument.type === 'or') {
// 									or.orTypes.push(...argument.orTypes);
// 								}
// 								else {
// 									or.orTypes.push(argument);
// 								}
// 							});
// 							return or;
// 						}

// 						default: {
// 							const assertNever: never = args;
// 							throw new Error(`Unexpected args.type: ${(assertNever as ObjectLiteral)}`);
// 						}
// 					}
// 				}

// 				default: {
// 					// TODO
// 					return;
// 				}
// 			}
// 		}
// 		case 'functionLiteral':
// 			// TODO FunctionLiteralType?
// 			// custom function type?
// 			return;

// 		case 'list':
// 			return {
// 				type: 'tuple',
// 				elementTypes: typeExpression.values.map(normalizeType),
// 			};

// 		case 'number':
// 			return {
// 				type: 'numberLiteral',
// 				value: typeExpression.value
// 			};

// 		case 'reference': {
// 			// TODO builtin primitive types (String etc)
// 			// TODO resolve dereference
// 			return;
// 		}

// 		case 'string': {
// 			// TODO string template type?
// 			// evaluate values, wenn alles bekannt: string literal, sonst: string
// 			let combinedString = '';
// 			for (const value of typeExpression.values) {
// 				if (value.type === 'stringToken') {
// 					combinedString += value.value;
// 					continue;
// 				}
// 				const evaluatedValue = normalizeType(value);
// 				// TODO number als string auswerten?
// 				if (evaluatedValue.type === 'stringLiteral') {
// 					combinedString += evaluatedValue.value;
// 					continue;
// 				}
// 				return stringType;
// 			}
// 			return {
// 				type: 'stringLiteral',
// 				value: combinedString
// 			};
// 		}

// 		default: {
// 			const assertNever: never = typeExpression;
// 			throw new Error(`Unexpected type.type: ${(assertNever as CheckedValueExpression).type}`);
// 		}
// 	}
// }

// TODO return true/false = always/never, sometimes/maybe?
function isTypeAssignableTo(valueType: RuntimeType, typeType: RuntimeType): string | undefined {
	const typeError = getTypeError(valueType, typeType);
	if (typeof typeError === 'object') {
		return typeErrorToString(typeError);
	}
	return undefined;
}

/**
 * Liefert den Fehler, der beim Zuweisen eines Wertes vom Typ valueType in eine Variable vom Typ targetType entsteht.
 * valueType muss also Teilmenge von targetType sein.
 */
function getTypeError(
	valueType: RuntimeType,
	targetType: RuntimeType,
): TypeError | undefined {
	if (targetType === Any) {
		return undefined;
	}
	if (valueType === Any) {
		// TODO error/warning bei any?
		// error type bei assignment/function call?
		// maybe return value?
		return undefined;
	}
	if (deepEquals(valueType, targetType)) {
		return undefined;
	}
	if (valueType instanceof BuiltInTypeBase) {
		switch (valueType.type) {
			case 'and': {
				const subErrors = valueType.choiceTypes.map(choiceType =>
					getTypeError(choiceType, targetType)).filter(isDefined);
				if (!subErrors.length) {
					return undefined;
				}
				return {
					// TODO error struktur überdenken
					message: subErrors.map(typeErrorToString).join('\n'),
					// innerError
				};
			}
			case 'or': {
				const subErrors = valueType.choiceTypes.map(choiceType =>
					getTypeError(choiceType, targetType));
				if (subErrors.every(isDefined)) {
					return {
						// TODO error struktur überdenken
						message: subErrors.map(typeErrorToString).join('\n'),
						// innerError
					};
				}
				return undefined;
			}
			case 'reference': {
				// TODO
				// const dereferenced = dereferenceArgumentType(null as any, valueType);
				// return getTypeError(dereferenced ?? Any, targetType);
				return undefined;
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
		case 'object':
			if (targetType instanceof BuiltInTypeBase) {
				switch (targetType.type) {
					case 'and': {
						const subErrors = targetType.choiceTypes.map(choiceType =>
							getTypeError(valueType, choiceType)).filter(isDefined);
						if (!subErrors.length) {
							return undefined;
						}
						return {
							// TODO error struktur überdenken
							message: subErrors.map(typeErrorToString).join('\n'),
							// innerError
						};
					}
					case 'any':
						throw new Error('Unexpected any targetType');
					case 'boolean':
						switch (typeof valueType) {
							case 'boolean':
								return undefined;

							default:
								break;
						}
						break;
					case 'dictionary': {
						if (typeof valueType !== 'object') {
							// TODO type specific error?
							break;
						}
						if (!valueType) {
							// TODO null specific error?
							break;
						}
						const elementType = targetType.elementType;
						if (valueType instanceof BuiltInTypeBase) {
							switch (valueType.type) {
								case 'dictionaryLiteral': {
									const subErrors = map(
										valueType.fields,
										(fieldType, fieldName) =>
											// TODO add fieldName to error
											// TODO the field x is missing error?
											getTypeError(fieldType, elementType),
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
						if (Array.isArray(valueType)) {
							// TODO array specific error?
							break;
						}
						// plain Dictionary
						// TODO wird das gebraucht? aktuell wird dictionary type immer als dictionaryLiteralType inferred
						// wann tritt also dieser case ein? ggf ebenso mit array/tuple?
						const subErrors = map(
							valueType,
							(fieldType, fieldName) =>
								// TODO add fieldName to error
								getTypeError(fieldType, elementType),
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
					case 'dictionaryLiteral': {
						if (typeof valueType !== 'object') {
							// TODO type specific error?
							break;
						}
						if (!valueType) {
							// TODO null specific error?
							break;
						}
						if (valueType instanceof BuiltInTypeBase) {
							switch (valueType.type) {
								case 'dictionaryLiteral': {
									const subErrors = map(
										targetType.fields,
										(fieldType, fieldName) =>
											// TODO add fieldName to error
											// TODO the field x is missing error?
											getTypeError(valueType.fields[fieldName] ?? null, fieldType),
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
						if (Array.isArray(valueType)) {
							// TODO array specific error?
							break;
						}
						// plain Dictionary
						// TODO wird das gebraucht? aktuell wird dictionary type immer als dictionaryLiteralType inferred
						// wann tritt also dieser case ein? ggf ebenso mit array/tuple?
						const subErrors = map(
							targetType.fields,
							(fieldType, fieldName) =>
								// TODO add fieldName to error
								// TODO the field x is missing error?
								getTypeError(valueType[fieldName] ?? null, fieldType),
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
					case 'error':
						break;
					case 'float':
						switch (typeof valueType) {
							case 'number':
								return undefined;

							default:
								break;
						}
						break;
					case 'function': {
						// TODO types als function interpretieren?
						if (!(valueType instanceof FunctionType)) {
							break;
						}
						// check value params obermenge von target params und value returntype teilmenge von target returntype
						const paramsError = getTypeError(targetType.paramsType, valueType.paramsType);
						if (paramsError) {
							return paramsError;
						}
						return getTypeError(valueType.returnType, targetType.returnType);
					}
					case 'integer':
						switch (typeof valueType) {
							case 'bigint':
								return undefined;

							default:
								break;
						}
						break;
					case 'list': {
						const targetElementType = targetType.elementType;
						if (valueType instanceof BuiltInTypeBase) {
							switch (valueType.type) {
								case 'list':
									return getTypeError(valueType.elementType, targetElementType);
								case 'tuple':
									const subErrors = valueType.elementTypes.map(valueElement =>
										getTypeError(valueElement, targetElementType)).filter(isDefined);
									if (!subErrors.length) {
										return undefined;
									}
									return {
										// TODO error struktur überdenken
										message: subErrors.map(typeErrorToString).join('\n'),
										// innerError
									};
								default:
									break;
							}
						}
						if (Array.isArray(valueType)) {
							const subErrors = valueType.map(valueElement =>
								getTypeError(valueElement, targetElementType)).filter(isDefined);
							if (!subErrors.length) {
								return undefined;
							}
							return {
								// TODO error struktur überdenken
								message: subErrors.map(typeErrorToString).join('\n'),
								// innerError
							};
						}
						break;
					}
					case 'not': {
						const sourceError = getTypeError(valueType, targetType.sourceType);
						if (sourceError === undefined) {
							return {
								message: `${typeToString(valueType, 0)} is assignable to ${typeToString(targetType.sourceType, 0)}, but should not be.`
							};
						}
						return undefined;
					}
					case 'parameters': {
						switch (typeof valueType) {
							case 'bigint':
							case 'boolean':
							case 'number':
							case 'string':
								return getTypeErrorForPrimitiveArg(valueType, targetType);
							case 'object':
								if (!valueType) {
									return getTypeErrorForPrimitiveArg(valueType, targetType);
								}
								return getTypeErrorForWrappedArgs(valueType, targetType);
							default:
								break;
						}
						break;
					}
					case 'or': {
						const subErrors = targetType.choiceTypes.map(choiceType =>
							getTypeError(valueType, choiceType));
						if (subErrors.every(isDefined)) {
							return {
								// TODO error struktur überdenken
								message: subErrors.map(typeErrorToString).join('\n'),
								// innerError
							};
						}
						return undefined;
					}
					case 'reference': {
						// TODO
						// const dereferenced = dereferenceArgumentType(null as any, targetType);
						// return getTypeError(valueType, dereferenced ?? Any);
						return undefined;
					}
					case 'stream': {
						if (!(valueType instanceof StreamType)) {
							break;
						}
						return getTypeError(valueType.valueType, targetType.valueType);
					}
					case 'string':
						switch (typeof valueType) {
							case 'string':
								return undefined;

							default:
								break;
						}
						break;
					case 'type':
						switch (typeof valueType) {
							case 'bigint':
							case 'boolean':
							case 'number':
							case 'string':
								return undefined;
							case 'object':
								if (!valueType) {
									return undefined;
								}
								if (valueType instanceof BuiltInTypeBase) {
									switch (valueType.type) {
										case 'boolean':
										case 'float':
										case 'integer':
										case 'string':
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
					case 'tuple':
					case 'typeOf':
						break;
					default: {
						const assertNever: never = targetType;
						throw new Error(`Unexpected targetType.type: ${(assertNever as BuiltInType).type}`);
					}
				}
			}
			break;
		default:
			break;
	}
	return { message: `Can not assign ${typeToString(valueType, 0)} to ${typeToString(targetType, 0)}.` };
}

function getTypeErrorForPrimitiveArg(value: Primitive, targetType: ParametersType): TypeError | undefined {
	const wrappeValue = new TupleType([value]);
	return getTypeErrorForWrappedArgs(wrappeValue, targetType);
}

// TODO check mit _ParametersType = plain type
function getTypeErrorForWrappedArgs(wrappedValue: RuntimeType, targetType: ParametersType): TypeError | undefined {
	if (typeof wrappedValue !== 'object' || !wrappedValue) {
		throw new Error('wrappedValue should be object but got' + typeof wrappedValue);
	}
	if (wrappedValue instanceof BuiltInTypeBase) {
		// TODO other cases
		switch (wrappedValue.type) {
			case 'dictionaryLiteral':
				return getTypeErrorForCollectionArgs(wrappedValue.fields, targetType);
			case 'tuple':
				return getTypeErrorForCollectionArgs(wrappedValue.elementTypes, targetType);
			case 'parameters': {
				let index = 0;
				const targetSingleNames = targetType.singleNames;
				const valueSingleNames = wrappedValue.singleNames;
				const valueRest = wrappedValue.rest;
				const valueRestType = valueRest?.type;
				const valueRestItemType = valueRest
					? valueRestType instanceof ListType
						? valueRestType.elementType
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
						? valueParameter.type ?? valueRestItemType ?? Any
						: null;
					const error = targetParameterType
						? getTypeError(valueParameterType, targetParameterType)
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
						const valueParameterType = valueParameter.type ?? valueRestItemType ?? Any;
						const error = getTypeError(valueParameterType, targetRestType);
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
				return { message: 'getTypeErrorForWrappedArgs not implemented yet for ' + wrappedValue.type };
		}
	}
	return getTypeErrorForCollectionArgs(wrappedValue, targetType);
}

function getTypeErrorForCollectionArgs(collectionValue: Collection, targetType: ParametersType): TypeError | undefined {
	const isArray = Array.isArray(collectionValue);
	let index = 0;
	const { singleNames, rest } = targetType;
	for (; index < singleNames.length; index++) {
		const param = singleNames[index]!;
		const { name, type } = param;
		const value = (isArray
			? collectionValue[index]
			: collectionValue[name]) ?? null;
		const error = type
			? getTypeError(value, type)
			: undefined;
		if (error) {
			// TODO collect inner errors
			return error;
			// return new Error(`Can not assign the value ${value} to param ${name} because it is not of type ${type}`);
		}
	}
	if (rest) {
		const restType = rest.type;
		if (isArray) {
			const remainingArgs = collectionValue.slice(index);
			const error = restType
				? getTypeError(remainingArgs, restType)
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

// function isSubType(superType: Type, subType: Type): boolean | 'maybe' {
// 	// TODO deepEquals
// 	if (superType === subType) {
// 		return true;
// 	}
// 	// TODO non nullable type?
// 	// if (subType.type === 'empty') {
// 	// 	return true;
// 	// }

// 	// TODO subtype predicate?!
// 	// TODO bei supertype predicate: literal subtype value checken, sonst false
// 	// TODO order maybe bei predicate?
// 	switch (superType.type) {
// 		case 'any':
// 			return true;

// 		case 'empty':
// 			return false;

// 		// TODO Or Type contains
// 		case 'or': {
// 			let result: false | 'maybe' = false;
// 			// TODO case subType = orType: check ob alle subType orTypes im superType enthalten sind (via isSubType)
// 			for (const orType of superType.orTypes) {
// 				const orIsSuperType = isSubType(orType, subType);
// 				if (orIsSuperType === true) {
// 					return true;
// 				}
// 				else if (orIsSuperType === 'maybe') {
// 					result = 'maybe';
// 				}
// 			}
// 			return result;
// 		}

// 		case 'functionLiteral':
// 			// TODO check subType.paramType > superType.paramType und subType.returnType < superType.returnType
// 			return false;

// 		default:
// 			throw new Error('TODO');
// 	}
// }

//#region import

export function getPathFromImport(importExpression: ParseFunctionCall): { path?: string, error?: ParserError } {
	const pathExpression = getPathExpression(importExpression.arguments);
	if (pathExpression?.type === 'string'
		&& pathExpression.values.length === 1
		&& pathExpression.values[0]!.type === 'stringToken') {
		const importedPath = pathExpression.values[0].value;
		const extension = extname(importedPath);
		switch (extension) {
			case '':
				return { path: importedPath + '.jul' };
			case '.js':
			case '.json':
			case '.yaml':
				return { path: importedPath };
			default:
				return {
					error: {
						message: `Unexpected extension for import: ${extension}`,
						startRowIndex: pathExpression.startRowIndex,
						startColumnIndex: pathExpression.startColumnIndex,
						endRowIndex: pathExpression.endRowIndex,
						endColumnIndex: pathExpression.endColumnIndex,
					}
				};
		}
	}
	// TODO dynamische imports verbieten???
	return {
		error: {
			message: 'dynamic import not allowed',
			startRowIndex: importExpression.startRowIndex,
			startColumnIndex: importExpression.startColumnIndex,
			endRowIndex: importExpression.endColumnIndex,
			endColumnIndex: importExpression.endColumnIndex,
		}
	};
}

function getPathExpression(importParams: BracketedExpression): ParseListValue | undefined {
	switch (importParams.type) {
		case 'dictionary':
			return importParams.fields[0].value;
		case 'bracketed':
		case 'dictionaryType':
		case 'empty':
		case 'object':
			return undefined;
		case 'list':
			return importParams.values[0];
		default: {
			const assertNever: never = importParams;
			throw new Error(`Unexpected importParams.type: ${(assertNever as BracketedExpression).type}`);
		}
	}
}

//#endregion import

//#region ToString

export function typeToString(type: RuntimeType, indent: number): string {
	switch (typeof type) {
		case 'string':
			return `§${type.replaceAll('§', '§§')}§`;
		case 'bigint':
		case 'boolean':
		case 'number':
			return type.toString();
		case 'object': {
			if (type === null) {
				return '()';
			}
			if (Array.isArray(type)) {
				return arrayTypeToString(type, indent);
			}
			if (type instanceof BuiltInTypeBase) {
				const builtInType: BuiltInType = type;
				switch (builtInType.type) {
					case 'and':
						return `And${arrayTypeToString(builtInType.choiceTypes, indent)}`;
					case 'any':
						return 'Any';
					case 'integer':
						return 'Integer';
					case 'boolean':
						return 'Boolean';
					case 'dictionary':
						return `Dictionary(${typeToString(builtInType.elementType, indent)})`;
					case 'dictionaryLiteral':
						return dictionaryTypeToString(builtInType.fields, ': ', indent);
					case 'error':
						return 'Error';
					case 'float':
						return 'Float';
					case 'function':
						return `${typeToString(builtInType.paramsType, indent)} => ${typeToString(builtInType.returnType, indent)}`;
					case 'list':
						return `List(${typeToString(builtInType.elementType, indent)})`;
					case 'not':
						return `Not(${typeToString(builtInType.sourceType, indent)})`;
					case 'or':
						return `Or${arrayTypeToString(builtInType.choiceTypes, indent)}`;
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
						]
						return bracketedExpressionToString(elements, multiline, indent);
					}
					case 'reference':
						return referencePathToString(builtInType.path);
					case 'stream':
						return `Stream(${typeToString(builtInType.valueType, indent)})`;
					case 'string':
						return 'String';
					case 'tuple':
						return arrayTypeToString(builtInType.elementTypes, indent);
					case 'type':
						return 'Type';
					case 'typeOf':
						return `TypeOf(${typeToString(builtInType.value, indent)})`;
					default: {
						const assertNever: never = builtInType;
						throw new Error(`Unexpected BuiltInType ${(assertNever as BuiltInType).type}`);
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

function optionalTypeGuardToString(type: RuntimeType | undefined, indent: number): string {
	return type
		? `: ${typeToString(type, indent)}`
		: '';
}

function arrayTypeToString(
	array: RuntimeType[],
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
		newIndent);
}

function dictionaryTypeToString(
	dictionary: { [key: string]: RuntimeType; },
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
		newIndent);
}

function bracketedExpressionToString(
	elements: string[],
	multiline: boolean,
	indent: number,
): string {
	const indentString = '\t'.repeat(indent);
	const elementsWithIndent = multiline
		? elements.map(element => {
			return `${indentString}${element}`;
		})
		: elements;
	const bracketSeparator = multiline
		? '\n'
		: '';
	const elementSeparator = multiline
		? '\n'
		: ' ';
	return `(${bracketSeparator}${elementsWithIndent.join(elementSeparator)}${bracketSeparator})`;
}

function referencePathToString(path: ReferencePath): string {
	return path.map(pathSegment => {
		return pathSegment.name;
	}).join('/');
}

//#endregion ToString

function getParamsType(possibleFunctionType: RuntimeType | undefined): RuntimeType {
	if (possibleFunctionType instanceof FunctionType) {
		return possibleFunctionType.paramsType;
	}
	return Any;
}

function getReturnType(possibleFunctionType: RuntimeType | undefined): RuntimeType {
	if (possibleFunctionType instanceof FunctionType) {
		return possibleFunctionType.returnType;
	}
	return Any;
}