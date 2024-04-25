// Enthält Laufzeit helper sowie core-lib builtins

//#region helper
let processId = 1;

interface Params {
	type?: RuntimeType;
	singleNames?: {
		name: string;
		type?: RuntimeType;
		source?: string;
	}[];
	rest?: {
		type?: RuntimeType;
	};
}

// TODO ParamsType, ReturnType
type JulFunction = Function & { params: Params; };

//#region internals

export function _branch(value: any, ...branches: JulFunction[]) {
	// TODO collect inner Errors?
	for (const branch of branches) {
		// primitive value in Array wrappen
		const wrappedArgs: Collection = isRealObject(value)
			? value
			: [value];
		const assignedParams = tryAssignArgs(branch.params, undefined, wrappedArgs, value);
		if (!(assignedParams instanceof Error)) {
			return branch(...assignedParams);
		}
	}
	return new Error(`${value} did not match any branch`);
}

export function _callFunction(fn: JulFunction | Function, prefixArg: any, args: any) {
	if ('params' in fn) {
		// jul function
		const assignedParams = tryAssignArgs(fn.params, prefixArg, args, args);
		if (assignedParams instanceof Error) {
			return assignedParams;
		}
		return fn(...assignedParams);
	}
	// js function
	const wrappedArgs = Array.isArray(args)
		? args
		: [args];
	const argsWithPrefix = prefixArg === undefined
		? wrappedArgs
		: [prefixArg, ...wrappedArgs];
	return fn(...argsWithPrefix);
}

export function _checkType(type: RuntimeType, value: any) {
	return isOfType(value, type)
		? value
		: new Error(`${value} is not of type ${type}`);
}

export function _combineObject(...parts: (Collection | null)[]): Collection | null {
	const nonEmptyParts = parts.filter(part => part !== null);
	const firstNonEmptyPart = nonEmptyParts[0];
	if (!firstNonEmptyPart) {
		return null;
	}
	if (Array.isArray(firstNonEmptyPart)) {
		return ([] as any[]).concat(...nonEmptyParts);
	}
	else {
		return Object.assign({}, ...nonEmptyParts);
	}
}

export function _createFunction(fn: Function, params: Params): JulFunction {
	const julFn = fn as JulFunction;
	julFn.params = params;
	return julFn;
}

//#endregion internals

// TODO value: RuntimeValue, RuntimeValue = RuntimeType | Stream ...
function isOfType(value: any, type: RuntimeType): boolean {
	switch (typeof type) {
		case 'bigint':
		case 'boolean':
		case 'number':
		case 'string':
			return value === type;
		case 'object': {
			if (type === null) {
				return value === null;
			}
			if (Array.isArray(type)) {
				return isOfTupleType(value, type);
			}
			if (type instanceof BuiltInTypeBase) {
				const builtInType = type as BuiltInType;
				switch (builtInType.type) {
					case 'any':
						return true;
					case 'boolean':
						return typeof value === 'boolean';
					case 'integer':
						return typeof value === 'bigint';
					case 'float':
						return typeof value === 'number';
					case 'text':
						return typeof value === 'string';
					case 'date':
						return value instanceof Date;
					case 'blob':
						return value instanceof Blob;
					case 'error':
						return value instanceof Error;
					case 'dictionary': {
						if (!isDictionary(value)) {
							return false;
						}
						const elementType = builtInType.ElementType;
						for (const key in value) {
							const elementValue = value[key] ?? null;
							if (!isOfType(elementValue, elementType)) {
								return false;
							}
						}
						return true;
					}
					case 'dictionaryLiteral':
						return isOfDictionaryLiteralType(value, builtInType.Fields);
					case 'list':
						return Array.isArray(value)
							&& value.length > 0
							&& value.every(element =>
								isOfType(element, builtInType.ElementType));
					case 'tuple':
						return isOfTupleType(value, builtInType.ElementTypes);
					case 'stream':
						// TODO check value type
						return value instanceof StreamClass;
					case 'function':
						// TODO check returntype/paramstype
						return typeof value === 'function';
					case 'nestedReference':
						// TODO?
						return true;
					case 'parameterReference':
						// TODO deref?
						return true;
					case 'parameters':
						// TODO?
						return true;
					case 'type':
						// TODO check primitive value (null/boolean/number/string)/builtintype/function
						// return value === null
						// || typeof value === 'boolean'
						// || typeof value === 'number'
						// || typeof value === 'string'
						// || value instanceof BuiltInTypeBase
						// || typeof value === ;
						return true;
					case 'and':
						return builtInType.ChoiceTypes.every(coiceType =>
							isOfType(value, coiceType));
					case 'or':
						return builtInType.ChoiceTypes.some(coiceType =>
							isOfType(value, coiceType));
					case 'not':
						return !isOfType(value, builtInType.SourceType);
					case 'typeOf':
						return deepEquals(value, builtInType.value);
					default: {
						const assertNever: never = builtInType;
						throw new Error(`Unexpected BuiltInType ${(assertNever as BuiltInType).type}`);
					}
				}
			}
			// Dictionary
			return isOfDictionaryLiteralType(value, type);
		}
		case 'function':
			return type(value);
		default: {
			const assertNever: never = type;
			throw new Error(`Unexpected type ${typeof assertNever}`);
		}
	}
}

function isOfTupleType(value: any, elementTypes: RuntimeType[]): boolean {
	return Array.isArray(value)
		&& value.length >= elementTypes.length
		&& elementTypes.every((elementType, index) =>
			isOfType(value[index] ?? null, elementType));
}

function isOfDictionaryLiteralType(value: any, fieldTypes: RuntimeDictionary): boolean {
	if (!isDictionary(value)) {
		return false;
	}
	for (const key in fieldTypes) {
		const elementValue = value[key] ?? null;
		const elementType = fieldTypes[key]!;
		if (!isOfType(elementValue, elementType)) {
			return false;
		}
	}
	return true;
}

function isRealObject(value: any): value is Collection {
	return typeof value === 'object'
		&& value !== null;
}

// TODO check empty prototype?
function isDictionary(value: any): value is RuntimeDictionary {
	return isRealObject(value)
		&& !(value instanceof BuiltInTypeBase)
		&& !(value instanceof Error)
		&& !Array.isArray(value);
}

function tryAssignArgs(
	params: Params,
	prefixArg: any,
	args: Collection | null,
	rawArgs: any,
): any[] | Error {
	const assignedValues: any[] = [];
	const { type: paramsType, singleNames, rest } = params;
	const hasPrefixArg = prefixArg !== undefined;
	if (paramsType !== undefined) {
		// TODO typecheck prefixArg with paramsType?
		// TODO typecheck paramsType wrappedArgs unwrappen? also nur 1. arg checken?
		const isValid = isOfType(rawArgs, paramsType);
		if (!isValid) {
			return new Error(`Can not assign the value ${rawArgs} to params because it is not of type ${paramsType}`);
		}
		return assignedValues;
	}
	const isArray = Array.isArray(args);
	let paramIndex = 0;
	let argIndex = 0;
	if (singleNames) {
		for (; paramIndex < singleNames.length; paramIndex++) {
			const param = singleNames[paramIndex]!;
			const { name, type, source } = param;
			const sourceWithFallback = source ?? name;
			let arg;
			if (hasPrefixArg && !paramIndex) {
				arg = prefixArg;
			}
			else {
				arg = (isArray
					? args[argIndex]
					: args?.[sourceWithFallback]) ?? null;
				argIndex++;
			}
			const isValid = type
				? isOfType(arg, type)
				: true;
			if (!isValid) {
				return new Error(`Can not assign the value ${arg} to param ${sourceWithFallback} because it is not of type ${type}`);
			}
			assignedValues.push(arg);
		}
	}
	if (rest) {
		const restType = rest.type;
		if (args === null) {
			const remainingArgs = hasPrefixArg && !paramIndex
				? [prefixArg]
				: null;
			const isValid = restType
				? isOfType(remainingArgs, restType)
				: true;
			if (!isValid) {
				return new Error(`Can not assign the value ${remainingArgs} to rest param because it is not of type ${rest}`);
			}
			assignedValues.push(...remainingArgs ?? []);
		}
		else if (isArray) {
			const remainingArgs = args.slice(argIndex);
			if (hasPrefixArg && !paramIndex) {
				remainingArgs.unshift(prefixArg);
			}
			const isValid = restType
				? isOfType(remainingArgs, restType)
				: true;
			if (!isValid) {
				return new Error(`Can not assign the value ${remainingArgs} to rest param because it is not of type ${rest}`);
			}
			assignedValues.push(...remainingArgs);
		}
		else {
			// TODO rest dictionary??
			throw new Error('tryAssignArgs not implemented yet for rest dictionary');
		}
	}
	return assignedValues;
}

// TODO toString

export function deepEquals(value1: any, value2: any): boolean {
	const type1 = typeof value1;
	if (type1 !== typeof value2) {
		return false;
	}
	switch (type1) {
		case 'bigint':
		case 'boolean':
		case 'function':
		case 'number':
		case 'string':
		case 'symbol':
		case 'undefined':
			return value1 === value2;
		case 'object':
			if (value1 === null || value2 === null) {
				return value1 === value2;
			}
			else if (value1 instanceof StreamClass || value2 instanceof StreamClass) {
				return value1 === value2;
			}
			else if (Array.isArray(value1) || Array.isArray(value2)) {
				if (!Array.isArray(value1)
					|| !Array.isArray(value2)
					|| value1.length !== value2.length) {
					return false;
				}
				for (let index = 0; index < value1.length; index++) {
					if (value1[index] !== value2[index]) {
						return false;
					}
				}
				return true;
			}
			else {
				// Dictionary/Function Object
				const typedValue1 = value1 as any;
				for (const key in typedValue1) {
					if (typedValue1[key] !== (value2 as any)[key]) {
						return false;
					}
				}
				return true;
			}
		default: {
			const assertNever: never = type1;
			throw new Error('Unexpected type for deepEquals: ' + assertNever);
		}
	}
}

//#region Types

export type Primitive =
	| null
	| boolean
	| number
	| bigint
	| string
	;

export interface RuntimeDictionary { [key: string]: RuntimeType; }

export type Collection =
	| RuntimeType[]
	| RuntimeDictionary
	;

export type RuntimeType =
	| Primitive
	| Collection
	| BuiltInType
	| CustomType
	;

/**
 * numerator / denominator
 */
interface RuntimeFraction {
	numerator: bigint;
	denominator: bigint;
}

type RuntimeRational = bigint | RuntimeFraction;

type CustomType = (value: any) => boolean;

//#region BuiltInType

export type BuiltInType =
	| AnyType
	| BooleanType
	| IntegerType
	| FloatType
	| TextType
	| DateType
	| BlobType
	| ErrorType
	| ListType
	| TupleType
	| DictionaryType
	| DictionaryLiteralType
	| StreamType
	| FunctionType
	| NestedReference
	| ParameterReference
	| ParametersType
	| TypeType
	| IntersectionType
	| UnionType
	| ComplementType
	| TypeOfType
	;

export class BuiltInTypeBase { }

export class AnyType extends BuiltInTypeBase {
	readonly type = 'any';
}

export class BooleanType extends BuiltInTypeBase {
	readonly type = 'boolean';
}

export class IntegerType extends BuiltInTypeBase {
	readonly type = 'integer';
}

export class FloatType extends BuiltInTypeBase {
	readonly type = 'float';
}

export class TextType extends BuiltInTypeBase {
	readonly type = 'text';
}

export class DateType extends BuiltInTypeBase {
	readonly type = 'date';
}

export class BlobType extends BuiltInTypeBase {
	readonly type = 'blob';
}

class ErrorType extends BuiltInTypeBase {
	readonly type = 'error';
}

export class ListType extends BuiltInTypeBase {
	constructor(public ElementType: RuntimeType) { super(); }
	readonly type = 'list';
}

export class TupleType extends BuiltInTypeBase {
	constructor(public ElementTypes: RuntimeType[]) { super(); }
	readonly type = 'tuple';
}

export class DictionaryType extends BuiltInTypeBase {
	constructor(public ElementType: RuntimeType) { super(); }
	readonly type = 'dictionary';
}

// TODO rename to _DictionaryLiteralType or split builtin exports to other file or importLine contain only builtins?
export class DictionaryLiteralType extends BuiltInTypeBase {
	constructor(public Fields: RuntimeDictionary) { super(); }
	readonly type = 'dictionaryLiteral';
}

export class StreamType extends BuiltInTypeBase {
	constructor(public ValueType: RuntimeType) { super(); }
	readonly type = 'stream';
}

export class FunctionType extends BuiltInTypeBase {
	constructor(
		public ParamsType: RuntimeType,
		public ReturnType: RuntimeType,
	) {
		super();
	}
	readonly type = 'function';
}

export class NestedReference extends BuiltInTypeBase {
	constructor(
		public source: RuntimeType,
		public nestedKey: string | number,
	) { super(); }
	readonly type = 'nestedReference';
}

/**
 * Wird aktuell nur als CompileTimeType benutzt
 */
export class ParameterReference extends BuiltInTypeBase {
	constructor(
		public name: string,
		public index: number,
	) { super(); }
	readonly type = 'parameterReference';
	/**
	 * Muss nach dem Erzeugen gesetzt werden.
	 */
	functionRef?: FunctionType;
}

/**
 * Wird aktuell nur als CompileTimeType benutzt
 */
export class ParametersType extends BuiltInTypeBase {
	constructor(
		public singleNames: Parameter[],
		public rest?: Parameter,
	) {
		super();
	}
	readonly type = 'parameters';
}

interface Parameter {
	name: string;
	type?: RuntimeType;
}

export class TypeType extends BuiltInTypeBase {
	readonly type = 'type';
}

export class IntersectionType extends BuiltInTypeBase {
	// TODO flatten nested IntersectionTypes?
	constructor(public ChoiceTypes: RuntimeType[]) { super(); }
	readonly type = 'and';
}

export class UnionType extends BuiltInTypeBase {
	// TODO flatten nested UnionTypes?
	constructor(public ChoiceTypes: RuntimeType[]) { super(); }
	readonly type = 'or';
}

export class ComplementType extends BuiltInTypeBase {
	constructor(public SourceType: RuntimeType) { super(); }
	readonly type = 'not';
}

export class TypeOfType extends BuiltInTypeBase {
	constructor(public value: any) { super(); }
	readonly type = 'typeOf';
}

//#endregion BuiltInType

export function _optionalType(...types: RuntimeType[]): UnionType {
	return new UnionType([null, ...types]);
}

//#endregion Types

//#region JSON

//#region parse

type ParserResult<T> = {
	parsed: T,
	endIndex: number;
} | Error;

export type JsonValue =
	| null
	| boolean
	| RuntimeRational
	| string
	| JsonValue[]
	| { [key: string]: JsonValue; }
	;

export function _parseJson(json: string): JsonValue | Error {
	const result = parseJsonValue(json, 0);
	if (result instanceof Error) {
		return result;
	}
	const endIndex = parseJsonWhiteSpace(json, result.endIndex);
	if (endIndex < json.length) {
		return new Error(`Invalid JSON. Unexpected extra charcter ${json[endIndex]} after parsed value at position ${endIndex}`);
	}
	return result.parsed;
}

function parseJsonValue(json: string, startIndex: number): ParserResult<JsonValue> {
	let index = parseJsonWhiteSpace(json, startIndex);
	const character = json[index];
	switch (character) {
		case 'n':
			return parseJsonToken(json, index, 'null', null);
		case 't':
			return parseJsonToken(json, index, 'true', true);
		case 'f':
			return parseJsonToken(json, index, 'false', false);
		case '-':
		case '0':
		case '1':
		case '2':
		case '3':
		case '4':
		case '5':
		case '6':
		case '7':
		case '8':
		case '9': {
			const isNegative = character === '-';
			const numberRegex = /(?<integer>0|[1-9][0-9]*)(\.(?<fraction>[0-9]+))?([eE](?<exponent>[-+]?[0-9]+))?/y;
			numberRegex.lastIndex = isNegative
				? index + 1
				: index;
			const match = numberRegex.exec(json);
			if (!match) {
				return new Error(`Invalid JSON. Failed to parse number at position ${index}`);
			}
			const integerString = (isNegative ? '-' : '') + match.groups!.integer!;
			const fractionString = match.groups!.fraction;
			const numerator = BigInt(integerString + (fractionString ?? ''));
			const exponentString = match.groups!.exponent;
			const fractionExponent = fractionString
				? BigInt('-' + fractionString.length)
				: 0n;
			const exponent = exponentString
				? BigInt(exponentString)
				: 0n;
			const combinedExponent = fractionExponent + exponent;
			const numberValue: RuntimeRational = combinedExponent < 0
				// TODO kürzen?
				? {
					numerator: numerator,
					denominator: 10n ** (-1n * combinedExponent),
				}
				: numerator * 10n ** combinedExponent;
			return {
				parsed: numberValue,
				endIndex: numberRegex.lastIndex,
			};
		}
		case '"':
			return parseJsonString(json, index + 1);
		case '[': {
			index++;
			let array: any[] | null = null;
			index = parseJsonWhiteSpace(json, index);
			if (json[index] === ']') {
				return {
					parsed: array,
					endIndex: index + 1,
				};
			}
			let isSeparator = false;
			while (index < json.length) {
				if (isSeparator) {
					index = parseJsonWhiteSpace(json, index);
					const arrayCharacter = json[index];
					switch (arrayCharacter) {
						case ',':
							isSeparator = false;
							index++;
							break;
						case ']':
							return {
								parsed: array,
								endIndex: index + 1,
							};
						default:
							return new Error(`Invalid JSON. Unexpected character ${arrayCharacter} at position ${index} while parsing array.`);
					}
				}
				else {
					const elementResult = parseJsonValue(json, index);
					if (elementResult instanceof Error) {
						return elementResult;
					}
					if (array === null) {
						array = [];
					}
					array.push(elementResult.parsed);
					isSeparator = true;
					index = elementResult.endIndex;
				}
			}
		}
		case '{': {
			index++;
			let object: { [key: string]: any; } | null = null;
			index = parseJsonWhiteSpace(json, index);
			if (json[index] === '}') {
				return {
					parsed: object,
					endIndex: index + 1,
				};
			}
			let isSeparator = false;
			while (index < json.length) {
				index = parseJsonWhiteSpace(json, index);
				const objectCharacter = json[index];
				if (isSeparator) {
					switch (objectCharacter) {
						case ',':
							isSeparator = false;
							index++;
							break;
						case '}':
							return {
								parsed: object,
								endIndex: index + 1,
							};
						default:
							return new Error(`Invalid JSON. Unexpected character ${objectCharacter} at position ${index} while parsing object.`);
					}
				}
				else {
					if (objectCharacter !== '"') {
						return new Error(`Invalid JSON. Unexpected character ${objectCharacter} at position ${index} while parsing object key.`);
					}
					const keyResult = parseJsonString(json, index + 1);
					if (keyResult instanceof Error) {
						return keyResult;
					}
					const colonIndex = parseJsonWhiteSpace(json, keyResult.endIndex);
					const colonCharacter = json[colonIndex];
					if (colonCharacter !== ':') {
						return new Error(`Invalid JSON. Unexpected character ${objectCharacter} at position ${index} while parsing colon.`);
					}
					const valueResult = parseJsonValue(json, colonIndex + 1);
					if (valueResult instanceof Error) {
						return valueResult;
					}
					if (object === null) {
						object = {};
					}
					object[keyResult.parsed] = valueResult.parsed;
					isSeparator = true;
					index = valueResult.endIndex;
				}
			}
		}
		default:
			return new Error(`Invalid JSON. Unexpected character ${character} at position ${index}`);
	}
}

function parseJsonWhiteSpace(json: string, startIndex: number): number {
	const whiteSpaceRegex = /[ \n\r\t]*/y;
	whiteSpaceRegex.lastIndex = startIndex;
	whiteSpaceRegex.exec(json);
	return whiteSpaceRegex.lastIndex;
}

function parseJsonToken(json: string, startIndex: number, token: string, value: any): ParserResult<any> {
	const endIndex = startIndex + token.length;
	if (json.substring(startIndex, endIndex) !== token) {
		return new Error(`Inavlid JSON. Failed to parse value ${token} at position ${startIndex}`);
	}
	return {
		parsed: value,
		endIndex: endIndex,
	};
}

/**
 * startIndex fängt hinter dem ersten " an
 */
function parseJsonString(json: string, startIndex: number): ParserResult<string> {
	let stringValue = '';
	for (let index = startIndex; index < json.length; index++) {
		const stringCharacter = json[index];
		switch (stringCharacter) {
			case '"':
				return {
					parsed: stringValue,
					endIndex: index + 1,
				};
			case '\\':
				index++;
				if (index === json.length) {
					return new Error('Invalid JSON. String not terminated.');
				}
				const escapedCharacter = json[index];
				switch (escapedCharacter) {
					case '"':
					case '\\':
					case '/':
					case 'b':
					case 'f':
					case 'n':
					case 'r':
					case 't':
						stringValue += escapedCharacter;
						break;
					case 'u':
						index++;
						const hexEndIndex = index + 4;
						if (hexEndIndex >= json.length) {
							return new Error('Invalid JSON. String not terminated.');
						}
						const hexCharacters = json.substring(index, hexEndIndex);
						if (!/[0-9a-fA-F]{4}/.test(hexCharacters)) {
							return new Error(`Invalid JSON. Invalid hex code at position ${index}.`);
						}
						stringValue += String.fromCharCode(parseInt(hexCharacters, 16));
						index = hexEndIndex - 1;
						break;
					default:
						return new Error();
				}
				break;
			default:
				stringValue += stringCharacter;
				break;
		}
	}
	return new Error('Invalid JSON. String not terminated.');
}

//#endregion parse

function _toJson(value: RuntimeType): string | Error {
	switch (typeof value) {
		case 'bigint':
		case 'boolean':
		case 'number':
			return value.toString();
		case 'string':
			return JSON.stringify(value);
		case 'function':
		case 'object': {
			if (value === null) {
				return 'null';
			}
			if (Array.isArray(value)) {
				return `[${value.map(_toJson).join()}]`;
			}
			return `{${Object.entries(value).map(([key, innerValue]) => {
				return `${_toJson(key)}:${_toJson(innerValue)}`;
			}).join()}}`;
		};
		case 'symbol':
			return new Error('Can not convert symbol to JSON');
		case 'undefined':
			return new Error('Can not convert undefined to JSON');
		default: {
			const assertNever: never = value;
			return new Error(`Unexpected type ${typeof assertNever}`);
		}
	}
}

//#endregion JSON

//#endregion helper

//#region builtins
//#region Types
export const Any = new AnyType();
export const Type = new TypeType();
export const List = (ElementType: RuntimeType) =>
	new ListType(ElementType);
_createFunction(
	List,
	{
		singleNames: [
			{
				name: 'ElementType',
				type: Type,
			},
		]
	}
);
export const And = (...args: RuntimeType[]) =>
	new IntersectionType(args);
_createFunction(
	And,
	{
		rest: {
			type: new ListType(Type)
		}
	}
);
export const Or = (...args: RuntimeType[]) =>
	new UnionType(args);
_createFunction(
	Or,
	{
		rest: {
			type: new ListType(Type)
		}
	}
);
export const Not = (T: RuntimeType[]) =>
	new ComplementType(T);
_createFunction(
	Not,
	{
		singleNames: [
			{
				name: 'T',
				type: Type,
			},
		]
	}
);
// TODO Without
export const TypeOf = (value: any) => {
	return new TypeOfType(value);
};
_createFunction(
	TypeOf,
	{
		singleNames: [
			{
				name: 'value',
			},
		]
	}
);
// TODO ValueOf
export const _Boolean = new BooleanType();
//#region Number
export const Float = new FloatType();
export const NonZeroFloat = new IntersectionType([Float, new ComplementType(0)]);
export const Integer = new IntegerType();
export const NonZeroInteger = new IntersectionType([Integer, new ComplementType(0n)]);
export const Fraction = new DictionaryLiteralType({
	numerator: Integer,
	denominator: Integer
});
export const Rational = new UnionType([Integer, Fraction]);
//#endregion Number
export const _Text = new TextType();
export const _Date = new DateType();
export const _Blob = new BlobType();
export const _Error = new ErrorType();
export const Dictionary = (ElementType: RuntimeType) =>
	new DictionaryType(ElementType);
_createFunction(
	Dictionary,
	{
		singleNames: [
			{
				name: 'ElementType',
				type: Type,
			},
		]
	}
);
export const Stream = (ValueType: RuntimeType) =>
	new StreamType(ValueType);
_createFunction(
	Stream,
	{
		singleNames: [
			{
				name: 'ValueType',
				type: Type,
			},
		]
	}
);
//#endregion Types
//#region Functions
//#region Any
export const equal = (first: any, second: any) =>
	first === second;
_createFunction(
	equal,
	{
		singleNames: [
			{
				name: 'first',
			},
			{
				name: 'second',
			}
		]
	}
);
//#endregion Any
//#region Number
export const divideFloat = (dividend: number, divisor: number) =>
	dividend / divisor;
_createFunction(
	divideFloat,
	{
		singleNames: [
			{
				name: 'dividend',
				type: Float,
			},
			{
				name: 'divisor',
				type: NonZeroFloat,
			}
		]
	}
);
// TODO support Rational values
export const greater = (first: number | bigint, second: number | bigint) =>
	first > second;
_createFunction(
	greater,
	{
		singleNames: [
			{
				name: 'first',
				type: new UnionType([Integer, Float]),
			},
			{
				name: 'second',
				type: new UnionType([Integer, Float]),
			}
		]
	}
);
// TODO moduloFloat
export const modulo = (dividend: bigint, divisor: bigint) =>
	dividend % divisor;
_createFunction(
	modulo,
	{
		singleNames: [
			{
				name: 'dividend',
				type: Integer,
			},
			{
				name: 'divisor',
				type: NonZeroInteger,
			}
		]
	}
);
export const multiply = (...args: RuntimeRational[]) =>
	args.reduce(
		(accumulator, current) => {
			if (typeof accumulator === 'bigint') {
				if (typeof current === 'bigint') {
					return accumulator * current;
				}
				else {
					return {
						numerator: accumulator * current.numerator,
						denominator: current.denominator,
					};
				}
			}
			else {
				if (typeof current === 'bigint') {
					return {
						numerator: accumulator.numerator * current,
						denominator: accumulator.denominator,
					};
				}
				else {
					// TODO kleinstes gemeinsames Vielfaches, kürzen
					return {
						numerator: accumulator.numerator * current.numerator,
						denominator: accumulator.denominator * current.denominator,
					};
				}
			}
		},
		1n);
_createFunction(
	multiply,
	{
		rest: {
			type: new ListType(Rational)
		}
	}
);
export const multiplyFloat = (...args: number[]) =>
	args.reduce(
		(accumulator, current) => {
			return accumulator * current;
		},
		1);
_createFunction(
	multiplyFloat,
	{
		rest: {
			type: new ListType(Float)
		}
	}
);
export const rationalToFloat = (rational: RuntimeRational): number => {
	if (typeof rational === 'bigint') {
		return Number(rational);
	}
	else {
		return Number(rational.numerator) / Number(rational.denominator);
	}
};
_createFunction(
	rationalToFloat,
	{
		singleNames: [
			{
				name: 'rational',
				type: Rational,
			},
		]
	}
);
export const subtract = (minuend: RuntimeRational, subtrahend: RuntimeRational): RuntimeRational => {
	if (typeof minuend === 'bigint') {
		if (typeof subtrahend === 'bigint') {
			return minuend - subtrahend;
		}
		else {
			return {
				numerator: minuend * subtrahend.denominator - subtrahend.numerator,
				denominator: subtrahend.denominator,
			};
		}
	}
	else {
		if (typeof subtrahend === 'bigint') {
			return {
				numerator: minuend.numerator - subtrahend * minuend.denominator,
				denominator: minuend.denominator,
			};
		}
		else {
			// TODO kleinstes gemeinsames Vielfaches, kürzen
			return {
				numerator: minuend.numerator * subtrahend.denominator - subtrahend.numerator * minuend.denominator,
				denominator: minuend.denominator * subtrahend.denominator,
			};
		}
	}
};
_createFunction(
	subtract,
	{
		singleNames: [
			{
				name: 'minuend',
				type: Rational,
			},
			{
				name: 'subtrahend',
				type: Rational,
			}
		]
	}
);
export const subtractFloat = (minuend: number, subtrahend: number) =>
	minuend - subtrahend;
_createFunction(
	subtractFloat,
	{
		singleNames: [
			{
				name: 'minuend',
				type: Float,
			},
			{
				name: 'subtrahend',
				type: Float,
			}
		]
	}
);
export const add = (...args: RuntimeRational[]) =>
	args.reduce(
		(accumulator, current) => {
			if (typeof accumulator === 'bigint') {
				if (typeof current === 'bigint') {
					return accumulator + current;
				}
				else {
					return {
						numerator: accumulator * current.denominator + current.numerator,
						denominator: current.denominator,
					};
				}
			}
			else {
				if (typeof current === 'bigint') {
					return {
						numerator: accumulator.numerator + current * accumulator.denominator,
						denominator: accumulator.denominator,
					};
				}
				else {
					// TODO kleinstes gemeinsames Vielfaches, kürzen
					return {
						numerator: accumulator.numerator * current.denominator + current.numerator * accumulator.denominator,
						denominator: accumulator.denominator * current.denominator,
					};
				}
			}
		},
		0n);
_createFunction(
	add,
	{
		rest: {
			type: new ListType(Rational)
		}
	}
);
export const addFloat = (...args: number[]) =>
	args.reduce(
		(accumulator, current) =>
			accumulator + current,
		0);
_createFunction(
	addFloat,
	{
		rest: {
			type: new ListType(Float)
		}
	}
);
//#endregion Number
//#region Text
export const combineTexts = (texts: string[] | null, separator: string | null) => {
	return texts?.join(separator ?? '') ?? '';
};
_createFunction(
	combineTexts,
	{
		singleNames: [
			{
				name: 'texts',
				type: _optionalType(new ListType(_Text)),
			},
			{
				name: 'separator',
				type: _optionalType(_Text),
			},
		]
	}
);
export const parseFloat = (stringNumber: string) => {
	const result = +stringNumber;
	if (Number.isNaN(result)) {
		return new Error(`Invalid number.`);
	}
	return result;
};
_createFunction(
	parseFloat,
	{
		singleNames: [
			{
				name: 'stringNumber',
				type: _Text,
			},
		]
	}
);
export const parseJson = _createFunction(
	_parseJson,
	{
		singleNames: [
			{
				name: 'json',
				type: _Text,
			},
		]
	}
);
export const toJson = _createFunction(
	_toJson,
	{
		singleNames: [
			{
				name: 'value',
				// TODO JsonValue
				type: Any,
			},
		]
	}
);
export const regex = (text: string, regex1: string) => {
	try {
		const match = text.match(regex1);
		return {
			isMatch: !!match,
			unnamedCaptures: match ? Array.from(match) : null,
			namedCaptures: match?.groups ?? null,
		};
	}
	catch (error) {
		return error;
	}
};
_createFunction(
	regex,
	{
		singleNames: [
			{
				name: 'text',
				type: _Text,
			},
			{
				name: 'regex',
				type: _Text,
			},
		]
	}
);
//#endregion Text
//#region Date
export const addDate = (
	date: Date,
	years: bigint | null,
	months: bigint | null,
	days: bigint | null,
	hours: bigint | null,
	minutes: bigint | null,
	seconds: bigint | null,
	milliseconds: bigint | null
) => new Date(
	date.getFullYear() + Number(years ?? 0),
	date.getMonth() + Number(months ?? 0),
	date.getDate() + Number(days ?? 0),
	date.getHours() + Number(hours ?? 0),
	date.getMinutes() + Number(minutes ?? 0),
	date.getSeconds() + Number(seconds ?? 0),
	date.getMilliseconds() + Number(milliseconds ?? 0),
);
_createFunction(
	addDate,
	{
		singleNames: [
			{
				name: 'date',
				type: _Date
			},
			{
				name: 'years',
				type: _optionalType(Integer)
			},
			{
				name: 'months',
				type: _optionalType(Integer)
			},
			{
				name: 'days',
				type: _optionalType(Integer)
			},
			{
				name: 'hours',
				type: _optionalType(Integer)
			},
			{
				name: 'minutes',
				type: _optionalType(Integer)
			},
			{
				name: 'seconds',
				type: _optionalType(Integer)
			},
			{
				name: 'milliseconds',
				type: _optionalType(Integer)
			},
		]
	}
);
export const currentDate = () => new Date();
_createFunction(
	currentDate,
	{}
);
export const toIsoDateText = (
	date: Date,
) => date.toISOString();
_createFunction(
	toIsoDateText,
	{
		singleNames: [
			{
				name: 'date',
				type: _Date
			},
		]
	}
);
//#endregion Date
//#region List
export const length = (
	values: any[] | null,
): bigint => {
	if (values === null) {
		return 0n;
	}
	return BigInt(values.length);
};
_createFunction(
	length,
	{
		singleNames: [
			{
				name: 'values',
				type: _optionalType(new ListType(Any))
			},
		]
	}
);
export const elementAt = <T>(
	values: T[],
	index: bigint,
): T | null => {
	return values[Number(index) - 1] ?? null;
};
_createFunction(
	elementAt,
	{
		singleNames: [
			{
				name: 'values',
				type: new ListType(Any)
			},
			{
				name: 'index',
				type: NonZeroInteger
			},
		]
	}
);
export const filterMap = <T, U>(
	values: T[] | null,
	callback: (value: T) => U | null,
): U[] | null => {
	if (!values) {
		return null;
	}
	const mappedValues: U[] = [];
	values.forEach(value => {
		const mapped = callback(value);
		if (mapped !== null) {
			mappedValues.push(mapped);
		}
	});
	return mappedValues.length
		? mappedValues
		: null;
};
_createFunction(
	filterMap,
	{
		singleNames: [
			{
				name: 'values',
				type: _optionalType(new ListType(Any))
			},
			{
				name: 'callback',
				// TODO
				// typeGuard: { type: 'reference', names: ['Function'] }
			},
		]
	}
);
export const forEach = (
	values: any[],
	callback: (value: any) => void,
) => {
	values.forEach(callback);
	return null;
};
_createFunction(
	forEach,
	{
		singleNames: [
			{
				name: 'values',
				type: new ListType(Any)
			},
			{
				name: 'callback',
				// TODO
				// typeGuard: { type: 'reference', names: ['Function'] }
			},
		]
	}
);
//#endregion List
//#region Dictionary
export const getField = <T>(
	dictionary: { [key: string]: T; },
	key: string,
): T | null => {
	return dictionary[key] ?? null;
};
_createFunction(
	getField,
	{
		singleNames: [
			{
				name: 'dictionary',
				type: new DictionaryType(Any)
			},
			{
				name: 'key',
				type: _Text
			},
		]
	}
);
export const setField = <T>(
	dictionary: { [key: string]: T; } | null,
	key: string,
	value: T,
): { [key: string]: T; } => {
	return {
		...dictionary,
		[key]: value,
	};
};
_createFunction(
	setField,
	{
		singleNames: [
			{
				name: 'dictionary',
				type: _optionalType(new DictionaryType(Any))
			},
			{
				name: 'key',
				type: _Text
			},
			{
				name: 'value',
			},
		]
	}
);
//#endregion Dictionary
//#region Stream
//#region helper
type Listener<T> = (value: T) => void;

class StreamClass<T> {
	constructor(
		/**
		 * Aktualisiert diesen Stream und alle Dependencies und benachrichtigt Subscriber.
		 */
		public readonly getValue: () => T,
		public readonly ValueType: RuntimeType,
	) {
		this.getValue = getValue;
	}

	lastValue?: T;
	lastProcessId?: number;
	completed: boolean = false;
	listeners: Listener<T>[] = [];
	onCompletedListeners: (() => void)[] = [];

	push(value: T, processId: number): void {
		if (processId === this.lastProcessId) {
			return;
		}
		if (deepEquals(value, this.lastValue)) {
			return;
		}
		if (this.completed) {
			throw new Error('Can not push to completed stream.');
		}
		// TODO typecheck value
		this.lastValue = value;
		this.lastProcessId = processId;
		this.listeners.forEach(listener => listener(value));
	}
	/**
	 * Gibt einen unsubscribe callback zurück.
	 * Wertet sofort den listener beim subscriben sofort aus, wenn evaluateOnSubscribe = true.
	 */
	subscribe(listener: Listener<T>, evaluateOnSubscribe: boolean = true): () => void {
		if (evaluateOnSubscribe) {
			listener(this.getValue());
		}
		if (this.completed) {
			return () => { };
		}
		this.listeners.push(listener);
		return () => {
			if (this.completed) {
				return;
			}
			const index = this.listeners.indexOf(listener);
			if (index === -1) {
				throw new Error('Can not unsubscribe listener, because listener was not subscribed.');
			}
			this.listeners.splice(index, 1);
		};
	}
	complete(): void {
		if (this.completed) {
			return;
		}
		this.completed = true;
		// dispose listeners
		this.listeners = [];
		this.onCompletedListeners.forEach(onCompletedListener => {
			onCompletedListener();
		});
		this.onCompletedListeners = [];
	}
	/**
	 * Wenn der Stream schon completed ist wird der callback sofort aufgerufen.
	 */
	onCompleted(callback: () => void): void {
		if (this.completed) {
			callback();
		}
		else {
			this.onCompletedListeners.push(callback);
		}
	}
}

//#region create

function _create$<T>(valueType: RuntimeType, initialValue: T): StreamClass<T> {
	const stream$: StreamClass<T> = new StreamClass(
		() =>
			stream$.lastValue as T,
		valueType);
	stream$.push(initialValue, processId);
	return stream$;
}

function _completed$<T>(value: T): StreamClass<T> {
	const $ = _create$(new TypeOfType(value), value);
	$.complete();
	return $;
}

type HttpResponseType =
	| 'blob'
	| 'text'
	;

const httpBlobResponseJulType = new UnionType([null, _Text, _Error]);
const httpTextResponseJulType = new UnionType([null, _Text, _Error]);

function httpRequest$(
	url: string,
	method: string,
	headers: { [key: string]: string; } | null,
	body: any,
	responseType: HttpResponseType,
): StreamClass<null | string | Blob | Error> {
	const abortController = new AbortController();
	const response$ = _create$<null | string | Blob | Error>(
		responseType === 'text'
			? httpTextResponseJulType
			: httpBlobResponseJulType,
		null);
	response$.onCompleted(() => {
		abortController.abort();
	});
	fetch(url, {
		method: method,
		headers: headers ?? undefined,
		body: body,
		signal: abortController.signal,
	}).then<string | Blob>(response => {
		if (response.ok) {
			switch (responseType) {
				case 'text':
					return response.text();
				case 'blob':
					return response.blob();
				default: {
					const assertNever: never = responseType;
					throw new Error(`Unexpected HttpResponseType ${assertNever}`);
				}
			}
		}
		else {
			// TODO improve error handling: return error response body (text)
			// return response.text();
			throw new Error(response.statusText);
		}
	}).then(responseText => {
		processId++;
		response$.push(responseText, processId);
	}).catch(error => {
		processId++;
		response$.push(error, processId);
	}).finally(() => {
		response$.complete();
	});
	return response$;
}

//#endregion create

//#region transform

// TODO warum?
function createDerived$<T>(getValue: () => T, valueType: RuntimeType): StreamClass<T> {
	const derived$: StreamClass<T> = new StreamClass(
		() => {
			if (processId === derived$.lastProcessId
				|| derived$.completed) {
				return derived$.lastValue!;
			}
			return getValue();
		},
		valueType);
	return derived$;
}

function _map$<TSource, TTarget>(
	source$: StreamClass<TSource>,
	mapFunction: (value: TSource) => TTarget,
	mappedType: RuntimeType,
): StreamClass<TTarget> {
	let lastSourceValue: TSource;
	const mapped$: StreamClass<TTarget> = createDerived$(
		() => {
			const currentSourceValue = source$.getValue();
			if (deepEquals(currentSourceValue, lastSourceValue)) {
				mapped$.lastProcessId = processId;
				return mapped$.lastValue!;
			}
			const currentMappedValue = mapFunction(currentSourceValue);
			lastSourceValue = currentSourceValue;
			mapped$.push(currentMappedValue, processId);
			return currentMappedValue;
		},
		mappedType,
	);
	mapped$.onCompleted(() => {
		unsubscribe();
	});
	const unsubscribe = source$.subscribe(sourceValue => {
		mapped$.getValue();
	});
	source$.onCompleted(() => {
		mapped$.complete();
	});
	return mapped$;
}

function _combine$<T>(
	...source$s: StreamClass<T>[]
): StreamClass<T[]> {
	const combined$: StreamClass<T[]> = createDerived$(
		() => {
			const lastValues = combined$.lastValue!;
			const currentValues = source$s.map(source$ =>
				source$.getValue());
			if (deepEquals(currentValues, lastValues)) {
				combined$.lastProcessId = processId;
				return lastValues;
			}
			combined$.push(currentValues, processId);
			return currentValues;
		},
		new UnionType(source$s.map(source$ => source$.ValueType)),
	);
	combined$.onCompleted(() => {
		unsubscribes.forEach((unsubscribe, index) => {
			unsubscribe();
		});
	});
	const unsubscribes = source$s.map((source$, index) => {
		source$.onCompleted(() => {
			// combined ist complete, wenn alle Sources complete sind.
			if (source$s.every(source$ => source$.completed)) {
				combined$.complete();
			}
		});
		return source$.subscribe(value => {
			combined$.getValue();
		});
	});
	return combined$;
}

function _take$<T>(source$: StreamClass<T>, count: bigint): StreamClass<T> {
	let counter = 0n;
	const mapped$ = _create$<T>(source$.ValueType, source$.lastValue!);
	const unsubscribe = source$.subscribe(
		(value) => {
			mapped$.push(value, processId);
			counter++;
			if (counter === count) {
				unsubscribe();
				mapped$.complete();
			}
		},
		false);
	source$.onCompleted(() => {
		mapped$.complete();
	});
	return mapped$;
}

// TODO testen
function takeUntil$<T>(source$: StreamClass<T>, completed$: StreamClass<any>): StreamClass<T> {
	const mapped$ = _map$(source$, x => x, source$.ValueType);
	const unsubscribeCompleted = completed$.subscribe(
		() => {
			mapped$.complete();
		},
		false);
	completed$.onCompleted(() => {
		mapped$.complete();
	});
	mapped$.onCompleted(() => {
		unsubscribeCompleted();
	});
	return mapped$;
}

function flatMerge$<T>(source$$: StreamClass<StreamClass<T>>): StreamClass<T> {
	const inner$s: StreamClass<T>[] = [];
	const unsubscribeInners: (() => void)[] = [];
	const flat$: StreamClass<T> = createDerived$(
		() => {
			const lastValue = flat$.lastValue!;
			const currentValue = source$$.getValue().getValue();
			if (deepEquals(currentValue, lastValue)) {
				flat$.lastProcessId = processId;
				return lastValue;
			}
			flat$.push(currentValue, processId);
			return currentValue;
		},
		// TODO
		Any,
	);
	const unsubscribeOuter = source$$.subscribe(source$ => {
		inner$s.push(source$);
		const unsubscribeInner = source$.subscribe(value => {
			flat$.getValue();
		});
		unsubscribeInners.push(unsubscribeInner);
	});
	flat$.onCompleted(() => {
		unsubscribeOuter();
		unsubscribeInners.forEach(unsubscribeInner => {
			unsubscribeInner();
		});
	});
	// flat ist complete, wenn outerSource und alle innerSources complete sind
	source$$.onCompleted(() => {
		inner$s.forEach(inner$ => {
			inner$.onCompleted(() => {
				if (inner$s.every(source$ => source$.completed)) {
					flat$.complete();
				}
			});
		});
	});
	return flat$;
}

function flatSwitch$<T>(source$$: StreamClass<StreamClass<T>>): StreamClass<T> {
	let unsubscribeInner: () => void;
	const flat$: StreamClass<T> = createDerived$(
		() => {
			const lastValue = flat$.lastValue!;
			const currentValue = source$$.getValue().getValue();
			if (deepEquals(currentValue, lastValue)) {
				flat$.lastProcessId = processId;
				return lastValue;
			}
			flat$.push(currentValue, processId);
			return currentValue;
		},
		// TODO
		// source$$.ValueType.ValueType,
		Any,
	);
	const unsubscribeOuter = source$$.subscribe(source$ => {
		unsubscribeInner?.();
		unsubscribeInner = source$.subscribe(value => {
			flat$.getValue();
		});
	});
	flat$.onCompleted(() => {
		unsubscribeOuter();
		unsubscribeInner?.();
	});
	// flat ist complete, wenn outerSource und die aktuelle innerSource complete sind
	source$$.onCompleted(() => {
		source$$.getValue().onCompleted(() => {
			flat$.complete();
		});
	});
	return flat$;
}

function flatMap$<T, U>(
	source$: StreamClass<T>,
	transform$: (value: T) => StreamClass<U>,
	merge: boolean,
): StreamClass<U> {
	const mapped$ = _map$(
		source$,
		transform$,
		// TODO
		Any,
	);
	if (merge) {
		return flatMerge$(mapped$);
	}
	else {
		return flatSwitch$(mapped$);
	}
}

// TODO testen
function accumulate$<TSource, TAccumulated>(
	source$: StreamClass<TSource>,
	initialAccumulator: TAccumulated,
	accumulate: (previousAccumulator: TAccumulated, value: TSource) => TAccumulated,
): StreamClass<TAccumulated> {
	const mapped$ = _map$(
		source$,
		value => {
			const newAccumulator = accumulate(
				mapped$.lastValue === undefined
					? initialAccumulator
					: mapped$.lastValue,
				value);
			return newAccumulator;
		},
		// TODO
		Any,
	);
	return mapped$;
}

function retry$<T>(
	method$: () => StreamClass<T | Error>,
	maxAttepmts: number,
	currentAttempt: number = 1,
): StreamClass<T | Error> {
	if (currentAttempt === maxAttepmts) {
		return method$();
	}
	const withRetry$$ = _map$(
		method$(),
		result => {
			if (result instanceof Error) {
				console.log('Error! Retrying... Attempt:', currentAttempt, 'process:', processId);
				return retry$(method$, maxAttepmts, currentAttempt + 1);
			}
			return _completed$<T | Error>(result);
		},
		// TODO
		Any,
	);
	return flatSwitch$(withRetry$$);
};

//#endregion transform
//#endregion helper
//#region core
export const complete = (stream$: StreamClass<any>) => {
	stream$.complete();
	return null;
};
_createFunction(
	complete,
	{
		singleNames: [
			{
				name: 'stream$',
				type: new StreamType(Any)
			},
		]
	}
);
export const push = (stream$: StreamClass<any>, value: any) => {
	processId++;
	stream$.push(value, processId);
	return null;
};
_createFunction(
	push,
	{
		singleNames: [
			{
				name: 'stream$',
				type: new StreamType(Any)
			},
			{
				name: 'value',
				type: Any
			},
		]
	}
);
export const subscribe = (stream$: StreamClass<any>, listener: JulFunction) => {
	const listenerFunction: Listener<any> = (value: any) => {
		_callFunction(listener, undefined, [value]);
	};
	return stream$.subscribe(listenerFunction);
};
_createFunction(
	subscribe,
	{
		singleNames: [
			{
				name: 'stream$',
				type: new StreamType(Any)
			},
			{
				name: 'listener',
				// TODO
				// typeGuard: { type: 'reference', names: ['Function'] }
			},
		]
	}
);
//#endregion core
//#region create
export const create$ = _createFunction(
	_create$,
	{
		singleNames: [
			{
				name: 'ValueType',
				type: Type
			},
			{
				name: 'initialValue',
				// TODO parameterReference ValueType
				type: Any
			},
		]
	}
);
export const completed$ = _createFunction(
	_completed$,
	{
		singleNames: [
			{
				name: 'initialValue',
				type: Any
			},
		]
	}
);
export const httpTextRequest$ = (
	url: string,
	method: string,
	headers: { [key: string]: string; } | null,
	body: any,
) => {
	return httpRequest$(url, method, headers, body, 'text');
};
_createFunction(
	httpTextRequest$,
	{
		singleNames: [
			{
				name: 'url',
				type: _Text
			},
			{
				name: 'method',
				type: _Text
			},
			{
				name: 'headers',
				type: _optionalType(new DictionaryType(_Text))
			},
			{
				name: 'body',
			},
		]
	}
);
export const httpBlobRequest$ = (
	url: string,
	method: string,
	headers: { [key: string]: string; } | null,
	body: any,
) => {
	return httpRequest$(url, method, headers, body, 'blob');
};
_createFunction(
	httpBlobRequest$,
	{
		singleNames: [
			{
				name: 'url',
				type: _Text
			},
			{
				name: 'method',
				type: _Text
			},
			{
				name: 'headers',
				type: _optionalType(new DictionaryType(_Text))
			},
			{
				name: 'body',
			},
		]
	}
);
export const timer$ = (delayMs: number): StreamClass<number> => {
	const stream$ = _create$(Float, 1);
	const cycle = () => {
		setTimeout(() => {
			if (stream$.completed) {
				return;
			}
			processId++;
			stream$.push(stream$.lastValue! + 1, processId);
			cycle();
		}, delayMs);
	};
	cycle();
	return stream$;
};
_createFunction(
	timer$,
	{
		singleNames: [{
			name: 'delayMs',
			type: Float
		}]
	}
);
//#endregion create
//#region transform
export const map$ = <T, U>(source$: StreamClass<T>, transform$: (value: T) => U) => {
	// TODO get ReturnType from JulFunction transForm$
	return _map$(source$, transform$, Any);
};
_createFunction(
	map$,
	{
		singleNames: [
			{
				name: 'source$',
				type: new StreamType(Any)
			},
			{
				name: 'transform$',
				// TODO
				// type: function source$/ValueType => Any
			}
		]
	}
);
export const flatMergeMap$ = <T, U>(source$: StreamClass<T>, transform$: (value: T) => StreamClass<U>) => {
	return flatMap$(source$, transform$, true);
};
_createFunction(
	flatMergeMap$,
	{
		singleNames: [
			{
				name: 'source$',
				type: new StreamType(Any)
			},
			{
				name: 'transform$',
				// TODO
				// type: function source$/ValueType => Any
			}
		]
	}
);
export const flatSwitchMap$ = <T, U>(source$: StreamClass<T>, transform$: (value: T) => StreamClass<U>) => {
	return flatMap$(source$, transform$, false);
};
_createFunction(
	flatSwitchMap$,
	{
		singleNames: [
			{
				name: 'source$',
				type: new StreamType(Any)
			},
			{
				name: 'transform$',
				// TODO
				// type: function source$/ValueType => Any
			}
		]
	}
);
export const combine$ = _createFunction(
	_combine$,
	{
		rest: {
			type: _optionalType(new ListType(new StreamType(Any)))
		}
	}
);
export const take$ = _createFunction(
	_take$,
	{
		singleNames: [
			{
				name: 'source$',
				type: new StreamType(Any)
			},
			{
				name: 'count',
				type: NonZeroInteger
			}
		]
	}
);
//#endregion transform
//#endregion Stream
//#region Utility
export const log = (...args: any[]) => {
	console.log(...args);
	return null;
};
_createFunction(
	log,
	{
		rest: {}
	}
);
export const repeat = (
	count: bigint,
	iteratee: (index: bigint) => void,
) => {
	for (let index = 1n; index <= count; index++) {
		iteratee(index);
	}
};
_createFunction(
	repeat,
	{
		singleNames: [
			{
				name: 'count',
				type: Integer
			},
			{
				name: 'iteratee',
				// TODO
				// type: Function
			},
		]
	}
);
export const runJs = _createFunction(
	eval,
	{
		singleNames: [{
			name: 'js',
			type: _Text
		}]
	}
);
// TODO dynamische imports erlauben??
// export const _import = _createFunction(require, {
// 	singleNames: [{
// 		name: 'path',
// 		type: (x) => typeof x === 'string'
// 	}]
// });
//#endregion Utility
//#endregion Functions
//#endregion builtins