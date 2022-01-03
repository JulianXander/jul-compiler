import { join } from 'path';
import { parseFile } from './parser';
import { ParserError } from './parser-combinator';
import {
	AnyType,
	CheckedValueExpression,
	DictionaryLiteralType,
	EmptyType,
	NormalizedType,
	ObjectLiteral,
	ParsedFile,
	ParseExpression,
	Reference,
	StringType,
	SymbolDefinition,
	SymbolTable,
	TypedExpression,
	UnionType,
} from './syntax-tree';
import { last } from './util';

const anyType: AnyType = {
	type: 'any'
};

const emptyType: EmptyType = {
	type: 'empty'
};

const stringType: StringType = {
	type: 'string'
};

const coreBuiltInSymbols: SymbolTable = {
	nativeFunction: {
		typeExpression: null as any,
		normalizedType: {
			type: 'functionLiteral',
			// TODO generic function
			parameterType: {
				type: 'dictionaryLiteral',
				fields: {
					FunctionType: {
						// TODO functionType
						type: 'any'
					},
					js: {
						type: 'string'
					}
				}
			},
			returnType: {
				type: 'reference',
				names: [{
					type: 'name',
					name: 'FunctionType',
					startRowIndex: 162,
					startColumnIndex: 0,
					endRowIndex: 162,
					endColumnIndex: 5,
				}]
			},
		},
		description: `Interpretes the given String as js Code and yields the return value,
assuming the specified type without checking. Make sure the Type fits under all circumstances`,
		startRowIndex: 162,
		startColumnIndex: 0,
		endRowIndex: 162,
		endColumnIndex: 5,
	}
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
	const name = reference.names[0].name;
	return findSymbolInScopesWithBuiltIns(name, scopes);
}

function dereference(reference: Reference, scopes: SymbolTable[]): SymbolDefinition | undefined {
	// TODO nested ref path
	const name = reference.names[0].name;
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
	for (const uri in documents) {
		const document = documents[uri]!;
		const { errors, expressions } = document;
		expressions?.forEach(expression => {
			checkType(expression, errors);
		});
	}
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
	];
	file.expressions?.forEach(expression => {
		setInferredType(expression, scopes2);
	});
}

function setInferredType(
	expression: TypedExpression,
	scopes: SymbolTable[],
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
	scopes: SymbolTable[],
): NormalizedType {
	switch (expression.type) {
		case 'bracketed':
			// TODO?
			return anyType;

		case 'branching':
			// union branch return types
			// TODO conditional type?
			setInferredType(expression.value, scopes);
			expression.branches.forEach(branch => {
				setInferredType(branch, scopes);
			});
			return {
				type: 'or',
				// TODO normalize UnionType, wenn any verodert => return any
				orTypes: expression.branches.map(branch => {
					if (branch.inferredType!.type === 'functionLiteral') {
						return branch.inferredType.returnType;
					}
					// TODO return any?
					throw new Error('TODO?');
				})
			};

		case 'definition': {
			setInferredType(expression.value, scopes);
			const inferredType = expression.value.inferredType!;
			const currentScope = last(scopes)!;
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
			return anyType;

		case 'dictionary':
			// TODO dictionary literal type?
			return anyType;

		case 'dictionaryType':
			// TODO?
			return anyType;

		case 'empty':
			return emptyType;

		case 'field':
			// TODO?
			return anyType;

		case 'functionCall': {
			// TODO provide args types for conditional/generic/derived type?
			setInferredType(expression.functionReference, scopes);
			setInferredType(expression.arguments, scopes);
			const functionType = expression.functionReference.inferredType;
			if (functionType?.type !== 'functionLiteral') {
				// TODO error?
				return anyType;
			}
			const returnType = functionType.returnType;
			if (returnType.type !== 'reference') {
				return returnType;
			}
			// evaluate generic ReturnType
			const argsType = expression.arguments.inferredType!;
			switch (argsType.type) {
				case 'dictionaryLiteral': {
					const referenceName = returnType.names[0].name;
					const argType = argsType.fields[referenceName];
					// TODO error bei unbound ref?
					return argType ?? anyType;
				}

				case 'tuple': {
					// TODO get param index
					const referenceName = returnType.names[0].name;
					// functionType.parameterType
					const paramIndex = 0;
					const argType = argsType.elementTypes[paramIndex];
					// TODO error bei unbound ref?
					return argType ?? anyType;
				}

				case 'list':
				// TODO?

				default:
					return anyType;
			}
		}

		case 'functionLiteral': {
			setInferredType(expression.params, scopes);
			const functionScopes = [...scopes, expression.symbols];
			expression.body.forEach(bodyExpression => {
				setInferredType(bodyExpression, functionScopes);
			});
			// TODO declaredReturnType vs inferredReturnType
			return {
				type: 'functionLiteral',
				parameterType: expression.params.inferredType!,
				returnType: last(expression.body)?.inferredType ?? emptyType,
			};
		}

		case 'functionTypeLiteral': {
			setInferredType(expression.params, scopes);
			setInferredType(expression.returnType, scopes);
			return {
				// TODO functionTypeLiteral?
				type: 'functionLiteral',
				parameterType: expression.params.inferredType!,
				returnType: expression.returnType.inferredType!,
			};
		}

		case 'list':
			// TODO spread elements
			expression.values.forEach(element => {
				setInferredType(element, scopes);
			});
			return {
				type: 'tuple',
				elementTypes: expression.values.map(element => {
					return element.inferredType!;
				})
			};

		case 'number':
			return {
				type: 'numberLiteral',
				value: expression.value
			};

		case 'parameters': {
			// TODO
			return anyType;
		}

		case 'reference': {
			const referencedSymbol = dereference(expression, scopes);
			if (!referencedSymbol) {
				// TODO add 'reference not found' error?
				return anyType;
			}
			// TODO was wenn referencedsymbol type noch nicht inferred ist?
			return referencedSymbol.normalizedType!;
		}

		case 'string':
			// TODO string literal type
			// TODO string template type?
			return stringType;

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

function isSubType(superType: NormalizedType, subType: NormalizedType): boolean | 'maybe' {
	// TODO deepEquals
	if (superType === subType) {
		return true;
	}
	// TODO non nullable type?
	// if (subType.type === 'empty') {
	// 	return true;
	// }

	// TODO subtype predicate?!
	// TODO bei supertype predicate: literal subtype value checken, sonst false
	// TODO order maybe bei predicate?
	switch (superType.type) {
		case 'any':
			return true;

		case 'empty':
			return false;

		// TODO Or Type contains
		case 'or': {
			let result: false | 'maybe' = false;
			// TODO case subType = orType: check ob alle subType orTypes im superType enthalten sind (via isSubType)
			for (const orType of superType.orTypes) {
				const orIsSuperType = isSubType(orType, subType);
				if (orIsSuperType === true) {
					return true;
				}
				else if (orIsSuperType === 'maybe') {
					result = 'maybe';
				}
			}
			return result;
		}

		case 'functionLiteral':
			// TODO check subType.paramType > superType.paramType und subType.returnType < superType.returnType
			return false;

		default:
			throw new Error('TODO');
	}
}