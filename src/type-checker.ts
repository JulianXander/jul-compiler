import { CheckedValueExpression } from './syntax-tree';

//#region NormalizedType

type NormalizedType =
	| EmptyType
	| AnyType
	| BooleanLiteralType
	| StringLiteralType
	| NumberLiteralType
	| DictionaryLiteralType
	| FunctionLiteralType
	| StringType
	| NumberType
	| ListType
	| TupleType
	// TODO? | DictionaryType
	| StreamType
	| UnionType
	| IntersectionType
	// TODO? | ParametersType oder stattdessen einfach dictionarytype?
	| CustomFunctionType
	;

interface EmptyType {
	type: 'empty';
}

interface AnyType {
	type: 'any';
}

interface BooleanLiteralType {
	type: 'booleanLiteral';
	value: boolean;
}

interface StringLiteralType {
	type: 'stringLiteral';
	value: string;
}

interface NumberLiteralType {
	type: 'numberLiteral';
	value: number;
}

interface StringType {
	type: 'string';
}

interface NumberType {
	type: 'number';
}

interface DictionaryLiteralType {
	type: 'dictionaryLiteral';
	fields: { [key: string]: NormalizedType; };
}

interface FunctionLiteralType {
	type: 'functionLiteral';
	// TODO generic return type? parameters type ref auf anderen, fallbacks
	parameterType: NormalizedType;
	returnType: NormalizedType;
}

interface StreamType {
	type: 'stream';
	valueType: NormalizedType;
}

interface ListType {
	type: 'list';
	elementType: NormalizedType;
}

interface TupleType {
	type: 'tuple';
	elementTypes: NormalizedType[];
}

interface UnionType {
	type: 'or';
	orTypes: NormalizedType[];
}

interface IntersectionType {
	type: 'and';
	andTypes: NormalizedType[];
}

interface CustomFunctionType {
	type: 'customFunction';
	fn: (x: any) => boolean;
}

//#endregion NormalizedType

// TODO flatten nested or/and
// TODO distribute and>or nesting chain
// TODO merge dictionaries bei and, spread
// TODO resolve dereferences
export function normalizeType(type: CheckedValueExpression): NormalizedType {
	return type;
}

// TODO return true/false = always/never, sometimes/maybe?
export function isTypeAssignableTo(valueType: NormalizedType, targetType: NormalizedType): boolean | 'maybe' {

}

export function isSubType(superType: NormalizedType, subType: NormalizedType): boolean | 'maybe' {
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
}