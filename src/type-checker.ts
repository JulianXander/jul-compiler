import { ParserError } from './parser-combinator';
import {
	CheckedValueExpression,
	DictionaryLiteralType,
	EmptyType,
	NormalizedType,
	ObjectLiteral,
	ParsedFile,
	ParseExpression,
	StringType,
	UnionType,
} from './syntax-tree';

const emptyType: EmptyType = {
	type: 'empty'
};

const stringType: StringType = {
	type: 'string'
};

/**
 * infer types of expressions, normalize typeGuards
 * fills errors
 */
export function checkTypes(documents: { [documentUri: string]: ParsedFile; }): void {
	inferTypes(documents);
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
			// TODO check return type
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
function inferTypes(documents: { [documentUri: string]: ParsedFile; }): void {
	// TODO recurse
	// TODO check cyclic import
}

// TODO flatten nested or/and
// TODO distribute and>or nesting chain
// TODO merge dictionaries bei and, spread
// TODO resolve dereferences
function inferType(valueExpression: CheckedValueExpression): NormalizedType {
	switch (valueExpression.type) {
		case 'branching':
			// TODO union branch return types?
			// TODO conditional type?
			return;

		case 'dictionary':
			// TODO dictionary literal type?
			return;

		case 'dictionaryType':
			// TODO?
			return;

		case 'empty':
			return emptyType;

		case 'functionCall':
			// get function returntype, provide args types for conditional/generic/derived type?
			return;

		case 'functionLiteral':
			// TODO?
			return;

		case 'list':
			// TODO?
			return;

		case 'number':
			// TODO?
			return;

		case 'reference':
			// TODO?
			return;

		case 'string':
			// TODO?
			return;

		default: {
			const assertNever: never = valueExpression;
			throw new Error(`Unexpected valueExpression.type: ${(assertNever as CheckedValueExpression).type}`);
		}
	}
}

// TODO flatten nested or/and
// TODO distribute and>or nesting chain
// TODO merge dictionaries bei and, spread
// TODO resolve dereferences
function normalizeType(typeExpression: CheckedValueExpression): NormalizedType {
	switch (typeExpression.type) {

		case 'branching':
			// TODO union branch return types?
			// TODO conditional type?
			return;

		case 'dictionary':
			// TODO dictionary literal type?
			return;

		case 'dictionaryType': {
			const normalizedDictionaryType: DictionaryLiteralType = {
				type: 'dictionaryLiteral',
				fields: {}
			};
			typeExpression.fields.forEach(field => {
				// TODO check field name already defined?
				switch (field.type) {
					case 'singleDictionaryTypeField':
						normalizedDictionaryType.fields[field.name] = normalizeType(field.typeGuard);
						return;

					case 'spreadDictionaryTypeField': {
						// merge dictionaries bei spread
						const normalizedSpread = normalizeType(field.value);
						if (normalizedSpread.type !== 'dictionaryLiteral') {
							// TODO?
							throw new Error(`Can not spread ${normalizedSpread.type} into dictionary type`);
						}
						for (const key in normalizedSpread.fields) {
							normalizedDictionaryType.fields[key] = normalizedSpread.fields[key];
						}
						return;
					}

					default: {
						const assertNever: never = field;
						throw new Error(`Unexpected field.type: ${(assertNever as any).type}`);
					}
				}
			});
			return normalizedDictionaryType;
		}

		case 'empty':
			return emptyType;

		case 'functionCall': {
			// TODO was wenn dereference chain?
			const functionName = typeExpression.functionReference.names[0].name;
			switch (functionName) {
				case 'Or': {
					const args = typeExpression.arguments;
					switch (args.type) {
						case 'empty':
							return emptyType;

						case 'dictionary':
							// TODO error? dictionary to array?
							throw new Error('unexpected arguments for Or: dictionary');

						case 'list': {
							const normalizedArgs = args.values.map(normalizeType);
							const or: UnionType = {
								type: 'or',
								orTypes: [],
							};
							// flatten nested or
							normalizedArgs.forEach(argument => {
								if (argument.type === 'or') {
									or.orTypes.push(...argument.orTypes);
								}
								else {
									or.orTypes.push(argument);
								}
							});
							return or;
						}

						default: {
							const assertNever: never = args;
							throw new Error(`Unexpected args.type: ${(assertNever as ObjectLiteral)}`);
						}
					}
				}

				default: {
					// TODO
					return;
				}
			}
		}
		case 'functionLiteral':
			// TODO FunctionLiteralType?
			// custom function type?
			return;

		case 'list':
			return {
				type: 'tuple',
				elementTypes: typeExpression.values.map(normalizeType),
			};

		case 'number':
			return {
				type: 'numberLiteral',
				value: typeExpression.value
			};

		case 'reference': {
			// TODO builtin primitive types (String etc)
			// TODO resolve dereference
			return;
		}

		case 'string': {
			// TODO string template type?
			// evaluate values, wenn alles bekannt: string literal, sonst: string
			let combinedString = '';
			for (const value of typeExpression.values) {
				if (value.type === 'stringToken') {
					combinedString += value.value;
					continue;
				}
				const evaluatedValue = normalizeType(value);
				// TODO number als string auswerten?
				if (evaluatedValue.type === 'stringLiteral') {
					combinedString += evaluatedValue.value;
					continue;
				}
				return stringType;
			}
			return {
				type: 'stringLiteral',
				value: combinedString
			};
		}

		default: {
			const assertNever: never = typeExpression;
			throw new Error(`Unexpected type.type: ${(assertNever as CheckedValueExpression).type}`);
		}
	}
}

// TODO return true/false = always/never, sometimes/maybe?
function isTypeAssignableTo(valueType: NormalizedType, targetType: NormalizedType): boolean | 'maybe' {

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

	// TODO subtype customFunction?!
	// TODO bei supertype customFunction: literal subtype value checken, sonst false
	// TODO order maybe bei customFunction?
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
			return;

		default:
			break;
	}
};;