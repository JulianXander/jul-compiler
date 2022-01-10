import { join } from 'path';
import { parseFile } from './parser';
import { ParserError } from './parser-combinator';
import {
	Any,
	ArgumentReference,
	BuiltInTypeBase,
	DictionaryLiteralType,
	// EmptyType,
	FunctionType,
	StringType,
	TupleType,
	Type,
	TypeOfType,
	UnionType,
	_any,
	_string,
	_type,
} from './runtime';
import {
	CheckedValueExpression,
	// DictionaryLiteralType,
	NormalizedType,
	ObjectLiteral,
	ParsedFile,
	ParseDictionaryTypeField,
	ParseExpression,
	Reference,
	SymbolDefinition,
	SymbolTable,
	TypedExpression,
} from './syntax-tree';
import { forEach, last, NonEmptyArray, toDictionary } from './util';

// const anyType: Any = {
// 	type: 'any'
// };

// const emptyType: EmptyType = {
// 	type: 'empty'
// };

// const stringType: StringType = {
// 	type: 'string'
// };

const coreBuiltInSymbols: SymbolTable = {
	true: {
		description: 'asdf true',
		typeExpression: null as any,
		normalizedType: true,
		startRowIndex: 162,
		startColumnIndex: 0,
		endRowIndex: 162,
		endColumnIndex: 5,
	},
	false: {
		description: 'asdf false',
		typeExpression: null as any,
		normalizedType: false,
		startRowIndex: 162,
		startColumnIndex: 0,
		endRowIndex: 162,
		endColumnIndex: 5,
	},
	Any: {
		description: 'asdf Any',
		typeExpression: null as any,
		normalizedType: new TypeOfType(_any),
		startRowIndex: 162,
		startColumnIndex: 0,
		endRowIndex: 162,
		endColumnIndex: 5,
	},
	Type: {
		description: 'asdf Type',
		typeExpression: null as any,
		normalizedType: new TypeOfType(_type),
		startRowIndex: 162,
		startColumnIndex: 0,
		endRowIndex: 162,
		endColumnIndex: 5,
	},
	nativeFunction: {
		typeExpression: null as any,
		normalizedType: new FunctionType(
			new DictionaryLiteralType({
				// TODO functionType
				FunctionType: _any,
				js: _string
			}),
			// TODO?! argumentreference type?
			new ArgumentReference([{
				type: 'name',
				name: 'FunctionType',
			}]),
		),
		description: `Interpretes the given String as js Code and yields the return value,
assuming the specified type without checking. Make sure the Type fits under all circumstances`,
		startRowIndex: 162,
		startColumnIndex: 0,
		endRowIndex: 162,
		endColumnIndex: 5,
	},
	nativeValue: {
		typeExpression: null as any,
		normalizedType: new FunctionType(
			new DictionaryLiteralType({
				js: _string
			}),
			_any,
		),
		description: `TODO nativeValue`,
		startRowIndex: 162,
		startColumnIndex: 0,
		endRowIndex: 162,
		endColumnIndex: 5,
	},
};

export const coreLibPath = join(__dirname, '..', '..', 'core-lib.jul');
const parsedCoreLib = parseFile(coreLibPath);
inferFileTypes(parsedCoreLib, [coreBuiltInSymbols]);
const builtInSymbols: SymbolTable = {
	...parsedCoreLib.symbols,
	...coreBuiltInSymbols
};

export function dereferenceWithBuiltIns(reference: Reference, scopes: SymbolTable[]): {
	isBuiltIn: boolean;
	symbol: SymbolDefinition;
} | undefined {
	// TODO nested ref path
	const name = reference.path[0].name;
	return findSymbolInScopesWithBuiltIns(name, scopes);
}

function dereference(reference: Reference, scopes: SymbolTable[]): SymbolDefinition | undefined {
	// TODO nested ref path
	const name = reference.path[0].name;
	return findSymbolInScopes(name, scopes);
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
export function checkTypes(documents: { [documentUri: string]: ParsedFile; }): void {
	inferFilesTypes(documents);
	forEach(
		documents,
		document => {

			const { errors, expressions } = document;
			expressions?.forEach(expression => {
				checkType(expression, errors);
			});
		});
}

/**
 * füllt errors
 */
function checkType(expression: ParseExpression, errors: ParserError[]): void {
	switch (expression.type) {
		case 'bracketed':
			return;

		case 'branching':
			// TODO check branches recursively
			return;

		case 'definition': {
			if (!expression.typeGuard) {
				return;
			}
			// TODO error structure??nested errors?
			const error = isTypeAssignableTo(expression.inferredType!, expression.normalizedTypeGuard!);
			if (error) {
				errors.push({
					message: 'Can not assign due to type mismatch',
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.endRowIndex,
					endColumnIndex: expression.endColumnIndex,
				});
			}
			return;
		}

		case 'destructuring':
			// TODO check typeguards
			expression.fields.fields.forEach(field => {
				if (field.typeGuard) {
					// check value, check fallback?
				}
			});
			return;

		case 'dictionary':
			// TODO
			return;

		case 'dictionaryType':
			// TODO?
			return;

		case 'empty':
			return;

		case 'field':
			return;

		case 'functionCall':
			// TODO check args
			return;

		case 'functionLiteral':
			// TODO check inferred return type vs declared return type
			return;

		case 'functionTypeLiteral':
			// TODO?
			return;

		case 'list':
			// TODO?
			return;

		case 'number':
			return;

		case 'reference':
			return;

		case 'string':
			// check nested expressions
			expression.values.forEach(value => {
				if (value.type === 'stringToken') {
					return;
				}
				checkType(value, errors);
			});
			return;

		default: {
			const assertNever: never = expression;
			throw new Error(`Unexpected expression.type: ${(assertNever as ParseExpression).type}`);
		}
	}
}

// infer types of expressions, normalize typeGuards
function inferFilesTypes(
	files: { [documentUri: string]: ParsedFile; },
): void {
	// TODO recurse
	// TODO check cyclic import
	for (const uri in files) {
		const file = files[uri]!;
		inferFileTypes(file, [builtInSymbols]);
	}
}

function inferFileTypes(file: ParsedFile, scopes: SymbolTable[]): void {
	const scopes2 = [
		...scopes,
		file.symbols,
	] as any as NonEmptyArray<SymbolTable>;
	file.expressions?.forEach(expression => {
		setInferredType(expression, scopes2);
	});
}

function setInferredType(
	expression: TypedExpression,
	scopes: NonEmptyArray<SymbolTable>,
): void {
	if (expression.inferredType) {
		return;
	}
	expression.inferredType = inferType(expression, scopes);
}

// TODO flatten nested or/and
// TODO distribute and>or nesting chain
// TODO merge dictionaries bei and, spread
// TODO resolve dereferences
function inferType(
	expression: TypedExpression,
	scopes: NonEmptyArray<SymbolTable>,
): NormalizedType {
	switch (expression.type) {
		case 'bracketed':
			// TODO?
			return _any;

		case 'branching':
			// union branch return types
			// TODO conditional type?
			setInferredType(expression.value, scopes);
			expression.branches.forEach(branch => {
				setInferredType(branch, scopes);
			});
			// TODO normalize (flatten) UnionType, wenn any verodert => return any
			return new UnionType(expression.branches.map(branch => {
				const inferredType = branch.inferredType as FunctionType;
				if (inferredType.type === 'function') {
					return inferredType.returnType;
				}
				// TODO return any?
				throw new Error('TODO?');
			}));

		case 'definition': {
			setInferredType(expression.value, scopes);
			const inferredType = expression.value.inferredType!;
			const currentScope = last(scopes);
			// TODO typecheck mit typeguard, ggf union mit Error type
			// TODO remove checkType, wenn type hier gecheckt wird
			currentScope[expression.name.name]!.normalizedType = inferredType;
			if (expression.typeGuard) {
				// TODO fix normalizeType
				// valueExpression.normalizedTypeGuard = normalizeType(valueExpression.typeGuard);
			}
			return inferredType;
		}

		case 'destructuring':
			// TODO?
			return _any;

		case 'dictionary':
			// TODO dictionary literal type?
			return _any;

		case 'dictionaryType': {
			// TODO infer field types
			// expression.fields.forEach(field => {
			// 	setInferredType(field, scopes);
			// });
			const fieldTypes: { [key: string]: Type; } = {};
			expression.fields.forEach(field => {
				switch (field.type) {
					case 'singleDictionaryTypeField': {
						// TODO fieldName as string
						const fieldName = field.name;
						// fieldTypes[fieldName] = field.inferredType!
						break;
					}

					case 'spreadDictionaryTypeField':
						// TODO spread fields flach machen
						break;

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
			return _any;

		case 'functionCall': {
			// TODO provide args types for conditional/generic/derived type?
			// TODO infer last body expression type for returnType
			setInferredType(expression.functionReference, scopes);
			setInferredType(expression.arguments, scopes);
			const functionType = expression.functionReference.inferredType;
			if (!(functionType instanceof FunctionType)) {
				// TODO error?
				return _any;
			}
			const returnType = functionType.returnType;
			if (!(returnType instanceof ArgumentReference)) {
				return returnType;
			}
			// evaluate generic ReturnType
			const argsType = expression.arguments.inferredType!;
			if (!(argsType instanceof BuiltInTypeBase)) {
				return _any;
			}
			switch (argsType.type) {
				case 'dictionaryLiteral': {
					// TODO dereference nested path
					const referenceName = returnType.path[0].name;
					const argType = argsType.fields[referenceName];
					// TODO error bei unbound ref?
					return argType ?? _any;
				}

				case 'tuple': {
					// TODO get param index
					// TODO dereference nested path
					const referenceName = returnType.path[0].name;
					// functionType.parameterType
					const paramIndex = 0;
					const argType = argsType.elementTypes[paramIndex];
					// TODO error bei unbound ref?
					return argType ?? _any;
				}

				case 'list':
				// TODO?

				default:
					return _any;
			}
		}

		case 'functionLiteral': {
			const functionScopes: NonEmptyArray<SymbolTable> = [...scopes, expression.symbols];
			setInferredType(expression.params, functionScopes);
			const declaredReturnType = expression.returnType;
			if (declaredReturnType) {
				setInferredType(declaredReturnType, functionScopes);
			}
			expression.body.forEach(bodyExpression => {
				setInferredType(bodyExpression, functionScopes);
			});
			// TODO declaredReturnType vs inferredReturnType
			const inferredReturnType = last(expression.body)?.inferredType ?? null;
			return new FunctionType(
				expression.params.inferredType!,
				inferredReturnType,
			);
		}

		case 'functionTypeLiteral': {
			const functionScopes: NonEmptyArray<SymbolTable> = [...scopes, expression.symbols];
			setInferredType(expression.params, functionScopes);
			// TODO argumentReference
			setInferredType(expression.returnType, functionScopes);
			const inferredReturnType = expression.returnType.inferredType;
			if (inferredReturnType === undefined) {
				console.log(JSON.stringify(expression, undefined, 4));
				throw new Error('returnType was not inferred');
			}
			// TODO FunctionTypeLiteral?
			return new TypeOfType(new FunctionType(
				expression.params.inferredType!,
				inferredReturnType,
			));
		}

		case 'list':
			// TODO spread elements
			expression.values.forEach(element => {
				setInferredType(element, scopes);
			});
			return new TupleType(expression.values.map(element => {
				return element.inferredType!;
			}));

		case 'number':
			return expression.value;

		case 'parameter': {
			if (expression.typeGuard) {
				setInferredType(expression.typeGuard, scopes);
			}
			if (expression.fallback) {
				setInferredType(expression.fallback, scopes);
			}
			// TODO fallback berücksichtigen?
			const inferredType = expression.typeGuard?.inferredType ?? _any;
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
				setInferredType(field, scopes);
			});
			if (expression.rest) {
				setInferredType(expression.rest, scopes);
			}
			// TODO rest in dictionarytype?! oder parameterstype als eigener typ?
			return new DictionaryLiteralType(toDictionary(
				expression.singleFields,
				field =>
					field.name.name,
				field =>
					field.inferredType!
			));
		}

		case 'reference': {
			const referencedSymbol = dereference(expression, scopes);
			if (!referencedSymbol) {
				// TODO add 'reference not found' error?
				return _any;
			}
			if (referencedSymbol.normalizedType === undefined) {
				// TODO was wenn referencedsymbol type noch nicht inferred ist?
				// setInferredType(referencedSymbol)
				console.log(expression);
				throw new Error('symbol type was not inferred');
			}
			return referencedSymbol.normalizedType;
		}

		case 'string':
			// TODO string literal type
			// TODO string template type?
			return _string;

		default: {
			const assertNever: never = expression;
			throw new Error(`Unexpected valueExpression.type: ${(assertNever as CheckedValueExpression).type}`);
		}
	}
}

// TODO flatten nested or/and
// TODO distribute and>or nesting chain
// TODO merge dictionaries bei and, spread
// TODO resolve dereferences
// function normalizeType(typeExpression: CheckedValueExpression): NormalizedType {
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
function isTypeAssignableTo(valueType: NormalizedType, targetType: NormalizedType): boolean | 'maybe' {
	return false;
}

// function isSubType(superType: NormalizedType, subType: NormalizedType): boolean | 'maybe' {
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