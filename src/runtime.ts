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

/**
 * Wird aufgerufen mit args = dictionary, oder unknown object, also Ergebnis von _combineObject
 */
export function _callFunction(fn: JulFunction | Function, prefixArg: any, args: Collection | undefined) {
	if ('params' in fn) {
		// jul function
		const assignedParams = assignArgs(fn.params, prefixArg, args);
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

export function _combineObject(...parts: (Collection | undefined)[]): Collection | undefined {
	const nonEmptyParts = parts.filter(part => part !== undefined);
	const firstNonEmptyPart = nonEmptyParts[0];
	if (!firstNonEmptyPart) {
		return;
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

//#region toString

function typeToString(type: RuntimeType, indent: number): string {
	switch (typeof type) {
		case 'bigint':
		case 'boolean':
			return type.toString();
		case 'function':
			return 'CustomType: ' + type;
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
				switch (type[_julTypeSymbol]) {
					case 'and':
						return `And${arrayTypeToString(type.ChoiceTypes, indent)}`;
					case 'any':
						return 'Any';
					case 'blob':
						return 'Blob';
					case 'boolean':
						return 'Boolean';
					case 'date':
						return 'Date';
					case 'dictionary':
						return `Dictionary(${typeToString(type.ElementType, indent)})`;
					case 'dictionaryLiteral':
						return dictionaryTypeToString(type.Fields, ': ', indent);
					case 'empty':
						return 'Empty';
					case 'error':
						return 'Error';
					case 'float':
						return 'Float';
					case 'function':
						return 'Function';
					case 'greater':
						return `Greater(${typeToString(type.Value, indent)})`;
					case 'integer':
						return 'Integer';
					case 'list':
						return `List(${typeToString(type.ElementType, indent)})`;
					case 'not':
						return `Not(${typeToString(type.SourceType, indent)})`;
					case 'or':
						return `Or${arrayTypeToString(type.ChoiceTypes, indent)}`;
					case 'stream':
						return 'Stream';
					case 'text':
						return 'Text';
					case 'tuple':
						return arrayTypeToString(type.ElementTypes, indent);
					case 'type':
						return 'Type';
					case 'typeOf':
						return `TypeOf(${typeToString(type.value, indent)})`;
					default: {
						const assertNever: never = type;
						throw new Error(`Unexpected BuiltInType ${(assertNever as BuiltInType)[_julTypeSymbol]}`);
					}
				}
			}
			// Dictionary
			return dictionaryTypeToString(type, ' = ', indent);;
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

const maxElementsPerLine = 5;
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
		indent);
}

function dictionaryTypeToString(
	dictionary: RuntimeDictionary,
	nameSeparator: string,
	indent: number,
): string {
	const multiline = Object.keys(dictionary).length > 1;
	const newIndent = multiline
		? indent + 1
		: indent;
	return bracketedExpressionToString(
		Object.entries(dictionary).map(([key, element]) => {
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

//#endregion toString

//#region check type

function getTypeError(value: any, type: RuntimeType): string | undefined {
	switch (typeof type) {
		case 'bigint':
		case 'boolean':
		case 'number':
		case 'string':
		case 'undefined':
			if (value === type) {
				return undefined;
			}
			break;
		case 'object': {
			if (type === null) {
				if (value === null) {
					return undefined;
				}
				break;
			}
			if (Array.isArray(type)) {
				return getTupleTypeError(value, type);
			}
			if (_julTypeSymbol in type) {
				switch (type[_julTypeSymbol]) {
					case 'any':
						return undefined;
					case 'empty':
						if (value === undefined) {
							return undefined;
						}
						break;
					case 'boolean':
						if (typeof value === 'boolean') {
							return undefined;
						}
						break;
					case 'integer':
						if (typeof value === 'bigint') {
							return undefined;
						}
						break;
					case 'float':
						if (typeof value === 'number') {
							return undefined;
						}
						break;
					case 'greater':
						if (value > type.Value) {
							return undefined;
						}
						break;
					case 'text':
						if (typeof value === 'string') {
							return undefined;
						}
						break;
					case 'date':
						if (value instanceof Date) {
							return undefined;
						}
						break;
					case 'blob':
						if (value instanceof Blob) {
							return undefined;
						}
						break;
					case 'error':
						if (value instanceof Error) {
							return undefined;
						}
						break;
					case 'dictionary': {
						if (!isDictionary(value)) {
							return `The value ${value} is not a Dictionary.`;
						}
						const elementType = type.ElementType;
						if (elementType === Any) {
							return undefined;
						}
						for (const key in value) {
							const elementValue = value[key];
							const elementError = getTypeError(elementValue, elementType);
							if (elementError) {
								return `Invalid value for field ${key}.\n${elementError}`;
							}
						}
						return undefined;
					}
					case 'dictionaryLiteral':
						return getDictionaryLiteralTypeError(value, type.Fields);
					case 'list': {
						if (!Array.isArray(value)) {
							return `The value ${value} is not an Array.`;
						}
						if (!value.length) {
							return 'The value has no elements.';
						}
						const elementType = type.ElementType;
						if (elementType === Any) {
							return undefined;
						}
						for (let index = 0; index < value.length; index++) {
							const elementValue = value[index];
							const elementError = getTypeError(elementValue, elementType);
							if (elementError) {
								return `Invalid value at index ${index + 1}.\n${elementError}`;
							}
						}
						return undefined;
					}
					case 'tuple':
						return getTupleTypeError(value, type.ElementTypes);
					case 'stream':
						if (value instanceof StreamClass) {
							return undefined;
						}
						break;
					case 'function':
						if (typeof value === 'function') {
							return undefined;
						}
						break;
					case 'type': {
						const valueType = typeof value;
						switch (valueType) {
							case 'bigint':
							case 'boolean':
							case 'function':
							case 'number':
							case 'string':
							case 'undefined':
								return undefined;
							case 'object':
								if (_julTypeSymbol in value) {
									return undefined;
								}
								break;
							case 'symbol':
								break;
							default: {
								const assertNever: never = valueType;
								throw new Error(`Unexpected type ${assertNever}`);
							}
						}
						break;
					}
					case 'and':
						for (const coiceType of type.ChoiceTypes) {
							const choiceError = getTypeError(value, coiceType);
							if (choiceError) {
								return choiceError;
							}
						}
						return undefined;
					case 'or':
						const choiceErrors = [];
						for (const coiceType of type.ChoiceTypes) {
							const choiceError = getTypeError(value, coiceType);
							if (!choiceError) {
								return undefined;
							}
							choiceErrors.push(choiceError);
						}
						return 'No choice is valid.\n' + choiceErrors.join('\n');
					case 'not':
						if (getTypeError(value, type.SourceType)) {
							return undefined;
						}
						break;
					case 'typeOf':
						if (deepEqual(value, type.value)) {
							return undefined;
						}
						break;
					default: {
						const assertNever: never = type;
						throw new Error(`Unexpected BuiltInType ${(assertNever as BuiltInType)[_julTypeSymbol]}`);
					}
				}
				break;
			}
			// Dictionary
			return getDictionaryLiteralTypeError(value, type);
		}
		case 'function':
			if (type(value)) {
				return undefined;
			}
			break;
		default: {
			const assertNever: never = type;
			throw new Error(`Unexpected type ${typeof assertNever}`);
		}
	}
	return `Can not assign the value ${value} to type ${typeToString(type, 0)}`;
}

function getTupleTypeError(value: any, elementTypes: RuntimeType[]): string | undefined {
	if (!Array.isArray(value)) {
		return `The value ${value} is not an Array.`;
	}
	if (value.length < elementTypes.length) {
		return `The value has too few elements. Expected ${elementTypes.length} but got ${value.length}.`;
	}
	for (let index = 0; index < elementTypes.length; index++) {
		const elementType = elementTypes[index];
		const elementValue = value[index];
		const elementError = getTypeError(elementValue, elementType);
		if (elementError) {
			return `Invalid value at index ${index + 1}.\n${elementError}`;
		}
	}
}

function getDictionaryLiteralTypeError(value: any, fieldTypes: RuntimeDictionary): string | undefined {
	if (!isDictionary(value)) {
		return `The value ${value} is not a Dictionary.`;
	}
	for (const key in fieldTypes) {
		const elementValue = value[key];
		const elementType = fieldTypes[key];
		const elementError = getTypeError(elementValue, elementType);
		if (elementError) {
			return `Invalid value for field ${key}.\n${elementError}`;
		}
	}
}

function isRealObject(value: any): value is Collection {
	return typeof value === 'object'
		&& value !== null;
}

// TODO check empty prototype?
function isDictionary(value: any): value is RuntimeDictionary {
	return isRealObject(value)
		&& !(_julTypeSymbol in value)
		&& !(value instanceof Error)
		&& !Array.isArray(value);
}

//#endregion check type

/**
 * Ohne type check
 */
function assignArgs(
	params: Params,
	prefixArg: any,
	args: Collection | undefined,
): any[] {
	const assignedValues: any[] = [];
	const { type: paramsType, singleNames, rest } = params;
	const hasPrefixArg = prefixArg !== undefined;
	if (paramsType !== undefined) {
		return assignedValues;
	}
	const isArray = Array.isArray(args);
	let paramIndex = 0;
	let argIndex = 0;
	if (singleNames) {
		for (; paramIndex < singleNames.length; paramIndex++) {
			const param = singleNames[paramIndex]!;
			const { name, source } = param;
			const sourceWithFallback = source ?? name;
			let arg;
			if (hasPrefixArg && !paramIndex) {
				arg = prefixArg;
			}
			else {
				arg = isArray
					? args[argIndex]
					: args?.[sourceWithFallback];
				argIndex++;
			}
			assignedValues.push(arg);
		}
	}
	if (rest) {
		if (args === undefined) {
			const remainingArgs = hasPrefixArg && !paramIndex
				? [prefixArg]
				: undefined;
			assignedValues.push(...remainingArgs ?? []);
		}
		else if (isArray) {
			const remainingArgs = args.slice(argIndex);
			if (hasPrefixArg && !paramIndex) {
				remainingArgs.unshift(prefixArg);
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

/**
 * Mit type check
 */
function tryAssignArgs(
	params: Params,
	prefixArg: any,
	args: Collection | undefined,
	rawArgs: any,
): any[] | Error {
	const assignedValues: any[] = [];
	const { type: paramsType, singleNames, rest } = params;
	const hasPrefixArg = prefixArg !== undefined;
	if (paramsType !== undefined) {
		// TODO typecheck prefixArg with paramsType?
		// TODO typecheck paramsType wrappedArgs unwrappen? also nur 1. arg checken?
		const typeError = getTypeError(rawArgs, paramsType);
		if (typeError) {
			return new Error(`Can not assign the value to params.\n${typeError}`);
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
				arg = isArray
					? args[argIndex]
					: args?.[sourceWithFallback];
				argIndex++;
			}
			const typeError = type
				? getTypeError(arg, type)
				: undefined;
			if (typeError) {
				return new Error(`Can not assign the value to param ${sourceWithFallback}.\n${typeError}`);
			}
			assignedValues.push(arg);
		}
	}
	if (rest) {
		const restType = rest.type;
		if (args === undefined) {
			const remainingArgs = hasPrefixArg && !paramIndex
				? [prefixArg]
				: undefined;
			const typeError = restType
				? getTypeError(remainingArgs, restType)
				: true;
			if (typeError) {
				return new Error(`Can not assign the value to rest param.\n${typeError}`);
			}
			assignedValues.push(...remainingArgs ?? []);
		}
		else if (isArray) {
			const remainingArgs = args.slice(argIndex);
			if (hasPrefixArg && !paramIndex) {
				remainingArgs.unshift(prefixArg);
			}
			const typeError = restType
				? getTypeError(remainingArgs, restType)
				: true;
			if (typeError) {
				return new Error(`Can not assign the value to rest param.\n${typeError}`);
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

export function deepEqual(value1: any, value2: any): boolean {
	if (value1 === value2) {
		return true;
	}
	const type1 = typeof value1;
	switch (type1) {
		case 'bigint':
		case 'boolean':
		case 'function':
		case 'number':
		case 'string':
		case 'symbol':
		case 'undefined':
			return false;
		case 'object':
			if (typeof value2 !== 'object') {
				return false;
			}
			if (value1 === null || value2 === null) {
				return false;
			}
			else if (value1 instanceof StreamClass || value2 instanceof StreamClass) {
				return false;
			}
			else if (Array.isArray(value1) || Array.isArray(value2)) {
				if (!Array.isArray(value1)
					|| !Array.isArray(value2)
					|| value1.length !== value2.length) {
					return false;
				}
				for (let index = 0; index < value1.length; index++) {
					const elementValuesEqual = deepEqual(value1[index], value2[index]);
					if (!elementValuesEqual) {
						return false;
					}
				}
				return true;
			}
			else {
				// Dictionary/Function Object
				if (Object.keys(value1).length !== Object.keys(value2).length) {
					return false;
				}
				for (const key in value1) {
					const fieldValuesEqual = deepEqual(value1[key], value2[key]);
					if (!fieldValuesEqual) {
						return false;
					}
				}
				return true;
			}
		default: {
			const assertNever: never = type1;
			throw new Error('Unexpected type for deepEqual: ' + assertNever);
		}
	}
}

//#region Types

type Primitive =
	| undefined
	| boolean
	| number
	| bigint
	| string
	;

interface RuntimeDictionary { [key: string]: RuntimeType; }

type Collection =
	| RuntimeType[]
	| RuntimeDictionary
	;

type RuntimeType =
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

type BuiltInType =
	| AnyType
	| EmptyType
	| BooleanType
	| IntegerType
	| FloatType
	| GreaterType
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
	| TypeType
	| IntersectionType
	| UnionType
	| ComplementType
	| TypeOfType
	;


/**
 * Wird vom emitter benutzt
 */
export const _julTypeSymbol = Symbol.for('julType');

interface AnyType {
	readonly [_julTypeSymbol]: 'any';
}

interface EmptyType {
	readonly [_julTypeSymbol]: 'empty';
}

interface BooleanType {
	readonly [_julTypeSymbol]: 'boolean';
}

interface IntegerType {
	readonly [_julTypeSymbol]: 'integer';
}

interface FloatType {
	readonly [_julTypeSymbol]: 'float';
}

interface GreaterType {
	readonly [_julTypeSymbol]: 'greater';
	readonly Value: bigint | number;
}

interface TextType {
	readonly [_julTypeSymbol]: 'text';
}

interface DateType {
	readonly [_julTypeSymbol]: 'date';
}

interface BlobType {
	readonly [_julTypeSymbol]: 'blob';
}

interface ErrorType {
	readonly [_julTypeSymbol]: 'error';
}

interface ListType {
	readonly [_julTypeSymbol]: 'list';
	readonly ElementType: RuntimeType;
}

interface TupleType {
	readonly [_julTypeSymbol]: 'tuple';
	readonly ElementTypes: RuntimeType[];
}

interface DictionaryType {
	readonly [_julTypeSymbol]: 'dictionary';
	readonly ElementType: RuntimeType;
}

interface DictionaryLiteralType {
	readonly [_julTypeSymbol]: 'dictionaryLiteral';
	readonly Fields: RuntimeDictionary;
}

interface StreamType {
	readonly [_julTypeSymbol]: 'stream';
}

const _StreamType: StreamType = { [_julTypeSymbol]: 'stream' };

interface FunctionType {
	readonly [_julTypeSymbol]: 'function';
}

/**
 * Wird vom emitter benutzt
 */
export const _Function: FunctionType = { [_julTypeSymbol]: 'function' };

interface TypeType {
	readonly [_julTypeSymbol]: 'type';
}

interface IntersectionType {
	readonly [_julTypeSymbol]: 'and';
	readonly ChoiceTypes: RuntimeType[];
}

interface UnionType {
	readonly [_julTypeSymbol]: 'or';
	readonly ChoiceTypes: RuntimeType[];
}
export const Or = (...ChoiceTypes: RuntimeType[]): UnionType => {
	// TODO flatten nested UnionTypes?
	return {
		[_julTypeSymbol]: 'or',
		ChoiceTypes: ChoiceTypes,
	};
};

interface ComplementType {
	readonly [_julTypeSymbol]: 'not';
	readonly SourceType: RuntimeType;
}

export const Not = (T: RuntimeType) => {
	return {
		[_julTypeSymbol]: 'not',
		SourceType: T,
	};
};

interface TypeOfType {
	readonly [_julTypeSymbol]: 'typeOf';
	readonly value: RuntimeType;
}

//#endregion BuiltInType

function optionalType(...types: RuntimeType[]): UnionType {
	return Or(undefined, ...types);
}

//#endregion Types

//#region JSON

//#region parse

type ParserResult<T> = {
	parsed: T,
	endIndex: number;
} | Error;

export type JsonValue =
	| undefined
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
			return parseJsonToken(json, index, 'null', undefined);
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
			let array: any[] | undefined = undefined;
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
					if (!array) {
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
			let object: { [key: string]: any; } | undefined = undefined;
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
					if (!object) {
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
						stringValue += escapedCharacter;
						break;
					case 'b':
						stringValue += '\b';
						break;
					case 'f':
						stringValue += '\f';
						break;
					case 'n':
						stringValue += '\n';
						break;
					case 'r':
						stringValue += '\r';
						break;
					case 't':
						stringValue += '\t';
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
			if (!value) {
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
			return 'null';
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
export const Any: AnyType = { [_julTypeSymbol]: 'any' };
export const Empty: EmptyType = { [_julTypeSymbol]: 'empty' };
export const Type: TypeType = { [_julTypeSymbol]: 'type' };
export const List = (ElementType: RuntimeType): ListType => {
	return {
		[_julTypeSymbol]: 'list',
		ElementType: ElementType,
	};
};
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
export const And = (...ChoiceTypes: RuntimeType[]): IntersectionType => {
	// TODO flatten nested IntersectionTypes?
	return {
		[_julTypeSymbol]: 'and',
		ChoiceTypes: ChoiceTypes,
	};
};
_createFunction(
	And,
	{
		rest: {
			type: List(Type)
		}
	}
);
_createFunction(
	Or,
	{
		rest: {
			type: List(Type)
		}
	}
);
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
export const TypeOf = (value: any): TypeOfType => {
	return {
		[_julTypeSymbol]: 'typeOf',
		value: value,
	};
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
export const _Boolean: BooleanType = { [_julTypeSymbol]: 'boolean' };
//#region Number
export const Float: FloatType = { [_julTypeSymbol]: 'float' };
export const NonZeroFloat = And(Float, Not(0));
export const Integer: IntegerType = { [_julTypeSymbol]: 'integer' };
export const NonZeroInteger = And(Integer, Not(0n));
export const Greater = (Value: bigint | number): GreaterType => {
	return {
		[_julTypeSymbol]: 'greater',
		Value: Value,
	};
};
_createFunction(
	Greater,
	{
		singleNames: [
			{
				name: 'Value',
				type: Or(Integer, Float),
			},
		]
	}
);
export const PositiveInteger = And(Integer, Greater(0n));
export const Fraction: DictionaryLiteralType = {
	[_julTypeSymbol]: 'dictionaryLiteral',
	Fields: {
		numerator: Integer,
		denominator: Integer
	},
};
export const Rational = Or(Integer, Fraction);
//#endregion Number
export const _Text: TextType = { [_julTypeSymbol]: 'text' };
export const _Date: DateType = { [_julTypeSymbol]: 'date' };
export const _Blob: BlobType = { [_julTypeSymbol]: 'blob' };
export const _Error: ErrorType = { [_julTypeSymbol]: 'error' };
export const Dictionary = (ElementType: RuntimeType): DictionaryType => {
	return {
		[_julTypeSymbol]: 'dictionary',
		ElementType: ElementType,
	};
};
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
	_StreamType;
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
_createFunction(
	deepEqual,
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
//#region Boolean
export const not = (value: boolean): boolean =>
	!value;
_createFunction(
	not,
	{
		singleNames: [
			{
				name: 'value',
				type: _Boolean
			},
		]
	}
);
export const and = (...args: boolean[]): boolean =>
	!args.includes(false);
_createFunction(
	and,
	{
		rest: {
			type: List(_Boolean)
		}
	}
);
export const or = (...args: boolean[]): boolean =>
	args.includes(true);
_createFunction(
	or,
	{
		rest: {
			type: List(_Boolean)
		}
	}
);
//#endregion Boolean
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
				type: Or(Integer, Float),
			},
			{
				name: 'second',
				type: Or(Integer, Float),
			}
		]
	}
);
export function maxInteger(...args: bigint[]): bigint {
	let max = args[0]!;
	for (let index = 1; index < args.length; index++) {
		const element = args[index]!;
		if (element > max) {
			max = element;
		}
	}
	return max;
}
_createFunction(
	maxInteger,
	{
		rest: {
			type: List(Integer)
		}
	}
);
export const maxFloat = (...args: number[]) =>
	Math.max(...args);
_createFunction(
	maxFloat,
	{
		rest: {
			type: List(Float)
		}
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
			type: List(Rational)
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
			type: List(Float)
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
export const subtractInteger = (minuend: bigint, subtrahend: bigint) =>
	minuend - subtrahend;
_createFunction(
	subtractInteger,
	{
		singleNames: [
			{
				name: 'minuend',
				type: Integer,
			},
			{
				name: 'subtrahend',
				type: Integer,
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
			type: List(Rational)
		}
	}
);
export const addInteger = (...args: bigint[]): bigint =>
	args.reduce(
		(accumulator, current) =>
			accumulator + current,
		0n);
_createFunction(
	addInteger,
	{
		rest: {
			type: List(Integer)
		}
	}
);
export const addFloat = (...args: number[]): number =>
	args.reduce(
		(accumulator, current) =>
			accumulator + current,
		0);
_createFunction(
	addFloat,
	{
		rest: {
			type: List(Float)
		}
	}
);
//#endregion Number
//#region Text
export const combineTexts = (texts: string[] | undefined, separator: string | undefined) => {
	return texts?.join(separator ?? '') ?? '';
};
_createFunction(
	combineTexts,
	{
		singleNames: [
			{
				name: 'texts',
				type: optionalType(List(_Text)),
			},
			{
				name: 'separator',
				type: optionalType(_Text),
			},
		]
	}
);
export const parseFloat = (textNumber: string) => {
	const result = +textNumber;
	if (Number.isNaN(result)) {
		return new Error('Invalid number.');
	}
	return result;
};
_createFunction(
	parseFloat,
	{
		singleNames: [
			{
				name: 'textNumber',
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
			unnamedCaptures: match ? Array.from(match) : undefined,
			namedCaptures: match?.groups,
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
	years: bigint | undefined,
	months: bigint | undefined,
	days: bigint | undefined,
	hours: bigint | undefined,
	minutes: bigint | undefined,
	seconds: bigint | undefined,
	milliseconds: bigint | undefined
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
				type: optionalType(Integer)
			},
			{
				name: 'months',
				type: optionalType(Integer)
			},
			{
				name: 'days',
				type: optionalType(Integer)
			},
			{
				name: 'hours',
				type: optionalType(Integer)
			},
			{
				name: 'minutes',
				type: optionalType(Integer)
			},
			{
				name: 'seconds',
				type: optionalType(Integer)
			},
			{
				name: 'milliseconds',
				type: optionalType(Integer)
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
	values: any[] | undefined,
): bigint => {
	if (!values) {
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
				type: optionalType(List(Any))
			},
		]
	}
);
export const getElement = <T>(
	values: T[] | undefined,
	index: bigint,
): T | undefined => {
	return values?.[Number(index) - 1];
};
_createFunction(
	getElement,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
			{
				name: 'index',
				type: NonZeroInteger
			},
		]
	}
);
export const setElement = <T>(
	values: T[] | undefined,
	index: bigint,
	value: T,
): T[] => {
	const copy = values
		? [...values]
		: [];
	copy[Number(index) - 1] = value;
	return copy;
};
_createFunction(
	getElement,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
			{
				name: 'index',
				type: PositiveInteger
			},
			{
				name: 'value',
			},
		]
	}
);
export const map = <T, U>(
	values: T[] | undefined,
	callback: (value: T, index: bigint) => U,
): U[] | undefined => {
	if (!values) {
		return;
	}
	const mappedValues = values.map((value, index) => {
		return callback(value, BigInt(index + 1));
	});
	return mappedValues.length
		? mappedValues
		: undefined;
};
_createFunction(
	map,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
			{
				name: 'callback',
				type: _Function
			},
		]
	}
);
export const filter = <T>(
	values: T[] | undefined,
	predicate: (value: T, index: bigint) => boolean,
): T[] | undefined => {
	if (!values) {
		return;
	}
	const filtered = values.filter((value, index) => {
		return predicate(value, BigInt(index + 1));
	});
	return filtered.length
		? filtered
		: undefined;
};
_createFunction(
	filter,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
			{
				name: 'predicate',
				type: _Function
			},
		]
	}
);
export const filterMap = <T, U>(
	values: T[] | undefined,
	callback: (value: T, index: bigint) => U | undefined,
): U[] | undefined => {
	if (!values) {
		return;
	}
	const mappedValues: U[] = [];
	values.forEach((value, index) => {
		const mapped = callback(value, BigInt(index + 1));
		if (mapped !== undefined) {
			mappedValues.push(mapped);
		}
	});
	return mappedValues.length
		? mappedValues
		: undefined;
};
_createFunction(
	filterMap,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
			{
				name: 'callback',
				type: _Function
			},
		]
	}
);
export const slice = <T>(
	values: T[] | undefined,
	start: bigint,
	end: bigint | undefined,
): T[] | undefined => {
	if (!values) {
		return;
	}
	const sliced = values.slice(
		Number(start) - 1,
		typeof end === 'bigint'
			? Number(end)
			: undefined
	);
	return sliced.length ? sliced : undefined;
};
_createFunction(
	slice,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
			{
				name: 'start',
				type: Integer
			},
			{
				name: 'end',
				type: optionalType(Integer)
			},
		]
	}
);
export const findFirst = <T>(
	values: T[] | undefined,
	predicate: (value: T, index: bigint) => boolean,
): T | undefined => {
	return values?.find((value, index) => {
		return predicate(value, BigInt(index + 1));
	});
};
_createFunction(
	findFirst,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
			{
				name: 'predicate',
				type: _Function
			},
		]
	}
);
export const findLast = <T>(
	values: T[] | undefined,
	predicate: (value: T, index: bigint) => boolean,
): T | undefined => {
	return values?.findLast((value, index) => {
		return predicate(value, BigInt(index + 1));
	});
};
_createFunction(
	findLast,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
			{
				name: 'predicate',
				type: _Function
			},
		]
	}
);
export const findLastIndex = <T>(
	values: T[] | undefined,
	predicate: (value: T, index: bigint) => boolean,
): bigint | undefined => {
	if (!values) {
		return;
	}
	const lastIndexFloat = values.findLastIndex((value, index) => {
		return predicate(value, BigInt(index + 1));
	});
	return lastIndexFloat === -1
		? undefined
		: BigInt(lastIndexFloat + 1);
};
_createFunction(
	findLastIndex,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
			{
				name: 'predicate',
				type: _Function
			},
		]
	}
);
export const lastElement = <T>(values: T[] | undefined): T | undefined => {
	return values?.[values.length - 1];
};
_createFunction(
	lastElement,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
		]
	}
);
export const forEach = <T>(
	values: T[] | undefined,
	callback: (value: T, index: bigint) => void,
) => {
	values?.forEach((value, index) => {
		return callback(value, BigInt(index + 1));
	});
};
_createFunction(
	forEach,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
			{
				name: 'callback',
				type: _Function
			},
		]
	}
);
export const exists = <T>(
	values: T[] | undefined,
	predicate: (value: T, index: bigint) => boolean,
): boolean => {
	if (!values) {
		return false;
	}
	return values.some((value, index) => {
		return predicate(value, BigInt(index + 1));
	});
};
_createFunction(
	exists,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
			{
				name: 'predicate',
				type: _Function
			},
		]
	}
);

export const all = <T>(
	values: T[] | undefined,
	predicate: (value: T, index: bigint) => boolean,
): boolean => {
	if (!values) {
		return true;
	}
	return values.every((value, index) => {
		return predicate(value, BigInt(index + 1));
	});
};
_createFunction(
	all,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
			{
				name: 'predicate',
				type: _Function
			},
		]
	}
);
export const toDictionary = (
	values: any[] | undefined,
	getKey: (value: any, index: bigint) => string,
	getValue: (value: any, index: bigint) => any,
): RuntimeDictionary | undefined => {
	if (!values) {
		return;
	}
	const dictionary: RuntimeDictionary = {};
	let indexBigint = 1n;
	for (let index = 0; index < values.length; index++) {
		const oldValue = values[index];
		const key = getKey(oldValue, indexBigint);
		const newValue = getValue(oldValue, indexBigint);
		dictionary[key] = newValue;
		indexBigint++;
	}
	return dictionary;
};
_createFunction(
	toDictionary,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
			{
				name: 'getKey',
				type: _Function
			},
			{
				name: 'getValue',
				type: _Function
			},
		]
	}
);
export const aggregate = <T, U>(
	values: T[] | undefined,
	initialValue: U,
	callback: (accumulator: U, value: T, index: bigint) => U,
): U => {
	if (!values) {
		return initialValue;
	}
	return values.reduce(
		(accumulator, value, index) => {
			return callback(accumulator, value, BigInt(index + 1));
		},
		initialValue);
};
_createFunction(
	aggregate,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(List(Any))
			},
			{
				name: 'initialValue',
			},
			{
				name: 'callback',
				type: _Function
			},
		]
	}
);
//#endregion List
//#region Dictionary
export const getField = <T>(
	dictionary: { [key: string]: T; } | undefined,
	key: string,
): T | undefined => {
	return dictionary?.[key];
};
_createFunction(
	getField,
	{
		singleNames: [
			{
				name: 'dictionary',
				type: optionalType(Dictionary(Any))
			},
			{
				name: 'key',
				type: _Text
			},
		]
	}
);
export const setField = <T>(
	dictionary: { [key: string]: T; } | undefined,
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
				type: optionalType(Dictionary(Any))
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
export const toList = <T>(
	dictionary: { [key: string]: T; } | undefined,
): T[] | undefined => {
	if (!dictionary) {
		return;
	}
	return Object.values(dictionary);
};
_createFunction(
	toList,
	{
		singleNames: [
			{
				name: 'values',
				type: optionalType(Dictionary(Any))
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
	) {
		this.getValue = getValue;
	}

	/**
	 * Bei Quell-Streams (z.B. mit timer$ oder create$) wird immer sofort ein Startwert mit push eingetragen.
	 * 
	 * Falls abgeleiteter Stream (createDerived$, map$, combine$, etc):
	 * lastValue wird lazy gesetzt.
	 * Wenn getValue noch nicht aufgerufen wurde, dann ist lastValue noch null.
	 */
	lastValue: T | null = null;
	lastProcessId?: number;
	completed: boolean = false;
	listeners: Listener<T>[] = [];
	onCompletedListeners: (() => void)[] = [];

	push(value: T, processId: number): void {
		if (processId === this.lastProcessId) {
			return;
		}
		if (deepEqual(value, this.lastValue)) {
			return;
		}
		if (this.completed) {
			throw new Error('Can not push to completed stream.');
		}
		this.lastValue = value;
		this.lastProcessId = processId;
		this.listeners.forEach(listener => listener(value));
	}
	/**
	 * Gibt einen unsubscribe callback zurück.
	 * Wertet den listener beim subscriben sofort aus, wenn evaluateOnSubscribe = true.
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

function _create$<T>(initialValue: T): StreamClass<T> {
	const stream$: StreamClass<T> = new StreamClass(
		() =>
			stream$.lastValue as T,
	);
	stream$.push(initialValue, processId);
	return stream$;
}

function _completed$<T>(value: T): StreamClass<T> {
	const $ = _create$(value);
	$.complete();
	return $;
}

type HttpResponseType =
	| 'blob'
	| 'text'
	;

function httpRequest$(
	url: string,
	method: string,
	headers: { [key: string]: string; } | undefined,
	body: any,
	responseType: HttpResponseType,
): StreamClass<undefined | string | Blob | Error> {
	const abortController = new AbortController();
	const response$ = _create$<undefined | string | Blob | Error>(undefined);
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

function createDerived$<T>(getValue: () => T): StreamClass<T> {
	const derived$: StreamClass<T> = new StreamClass(
		() => {
			if (processId === derived$.lastProcessId
				|| derived$.completed) {
				return derived$.lastValue!;
			}
			return getValue();
		},
	);
	return derived$;
}

function _map$<TSource, TTarget>(
	source$: StreamClass<TSource>,
	mapFunction: (value: TSource) => TTarget,
): StreamClass<TTarget> {
	let lastSourceValue: TSource | null = null;
	const mapped$: StreamClass<TTarget> = createDerived$(
		() => {
			const currentSourceValue = source$.getValue();
			if (deepEqual(currentSourceValue, lastSourceValue)) {
				mapped$.lastProcessId = processId;
				return mapped$.lastValue!;
			}
			const currentMappedValue = mapFunction(currentSourceValue);
			lastSourceValue = currentSourceValue;
			mapped$.push(currentMappedValue, processId);
			return currentMappedValue;
		},
	);
	const unsubscribe = source$.subscribe(sourceValue => {
		mapped$.getValue();
	});
	mapped$.onCompleted(() => {
		unsubscribe();
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
			if (deepEqual(currentValues, lastValues)) {
				combined$.lastProcessId = processId;
				return lastValues;
			}
			combined$.push(currentValues, processId);
			return currentValues;
		},
	);
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
	combined$.onCompleted(() => {
		unsubscribes.forEach((unsubscribe, index) => {
			unsubscribe();
		});
	});
	return combined$;
}

function _take$<T>(source$: StreamClass<T>, count: bigint): StreamClass<T> {
	let counter = 0n;
	const mapped$ = _create$<T>(source$.lastValue!);
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
	const mapped$ = _map$(source$, x => x);
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
			if (deepEqual(currentValue, lastValue)) {
				flat$.lastProcessId = processId;
				return lastValue;
			}
			flat$.push(currentValue, processId);
			return currentValue;
		},
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
			if (deepEqual(currentValue, lastValue)) {
				flat$.lastProcessId = processId;
				return lastValue;
			}
			flat$.push(currentValue, processId);
			return currentValue;
		},
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
				mapped$.lastValue === null
					? initialAccumulator
					: mapped$.lastValue,
				value);
			return newAccumulator;
		},
	);
	return mapped$;
}

function retry$<T>(
	method$: () => StreamClass<T | Error>,
	maxAttempts: number,
	currentAttempt: number = 1,
): StreamClass<T | Error> {
	if (currentAttempt === maxAttempts) {
		return method$();
	}
	const withRetry$$ = _map$(
		method$(),
		result => {
			if (result instanceof Error) {
				console.log('Error! Retrying... Attempt:', currentAttempt, 'process:', processId);
				return retry$(method$, maxAttempts, currentAttempt + 1);
			}
			return _completed$<T | Error>(result);
		},
	);
	return flatSwitch$(withRetry$$);
};

//#endregion transform
//#endregion helper
//#region core
export const complete = (stream$: StreamClass<any>): undefined => {
	stream$.complete();
};
_createFunction(
	complete,
	{
		singleNames: [
			{
				name: 'stream$',
				type: _StreamType
			},
		]
	}
);
export const push = (stream$: StreamClass<any>, value: any) => {
	processId++;
	stream$.push(value, processId);
};
_createFunction(
	push,
	{
		singleNames: [
			{
				name: 'stream$',
				type: _StreamType
			},
			{
				name: 'value',
			},
		]
	}
);
export const subscribe = <T>(stream$: StreamClass<T>, listener: Listener<T>) => {
	return stream$.subscribe(listener);
};
_createFunction(
	subscribe,
	{
		singleNames: [
			{
				name: 'stream$',
				type: _StreamType
			},
			{
				name: 'listener',
				type: _Function
			},
		]
	}
);
//#endregion core
//#region create
export const create$ = (ValueType: any, initialValue: any) => {
	return _create$(initialValue);
};
_createFunction(
	create$,
	{
		singleNames: [
			{
				name: 'ValueType',
				type: Type
			},
			{
				name: 'initialValue',
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
			},
		]
	}
);
export const httpTextRequest$ = (
	url: string,
	method: string,
	headers: { [key: string]: string; } | undefined,
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
				type: optionalType(Dictionary(_Text))
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
	headers: { [key: string]: string; } | undefined,
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
				type: optionalType(Dictionary(_Text))
			},
			{
				name: 'body',
			},
		]
	}
);
export const timer$ = (delayMs: number): StreamClass<number> => {
	const stream$ = _create$(1);
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
	return _map$(source$, transform$);
};
_createFunction(
	map$,
	{
		singleNames: [
			{
				name: 'source$',
				type: _StreamType
			},
			{
				name: 'transform$',
				type: _Function
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
				type: _StreamType
			},
			{
				name: 'transform$',
				type: _Function
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
				type: _StreamType
			},
			{
				name: 'transform$',
				type: _Function
			}
		]
	}
);
export const combine$ = _createFunction(
	_combine$,
	{
		rest: {
			type: optionalType(List(_StreamType))
		}
	}
);
export const take$ = _createFunction(
	_take$,
	{
		singleNames: [
			{
				name: 'source$',
				type: _StreamType
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
				type: _Function
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