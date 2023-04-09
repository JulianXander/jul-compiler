// Enthält Laufzeit helper sowie core-lib builtins

//#region helper
let processId = 1;

interface Params {
	type?: RuntimeType;
	singleNames?: {
		name: string;
		type?: RuntimeType;
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
		const assignedParams = tryAssignParams(branch.params, value);
		if (!(assignedParams instanceof Error)) {
			return branch(assignedParams);
		}
	}
	return new Error(`${value} did not match any branch`);
}

export function _callFunction(fn: JulFunction | Function, args: any) {
	if ('params' in fn) {
		// jul function
		const assignedParams = tryAssignParams(fn.params, args);
		if (assignedParams instanceof Error) {
			return assignedParams;
		}
		return fn(...assignedParams);
	}
	// js function
	return Array.isArray(args)
		? fn(...args)
		: fn(args)
}

export function _checkType(type: RuntimeType, value: any) {
	return isOfType(value, type)
		? value
		: new Error(`${value} is not of type ${type}`);
}

export function _createFunction(fn: Function, params: Params): JulFunction {
	const julFn = fn as JulFunction;
	julFn.params = params;
	return julFn;
}

export function _checkDictionaryType(dictionaryType: Params, value: any): boolean {
	const assignedParams = tryAssignParams(dictionaryType, value);
	return assignedParams instanceof Error;
}

//#endregion internals

function isOfType(value: any, type: RuntimeType): boolean {
	switch (typeof type) {
		case 'bigint':
		case 'boolean':
		case 'number':
		case 'string':
			return value === type;
		case 'object': {
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
					case 'string':
						return typeof value === 'string';
					case 'error':
						return value instanceof Error;
					case 'dictionary': {
						if (!isDictionary(value)) {
							return false;
						}
						const elementType = builtInType.elementType;
						for (const key in value) {
							const elementValue = value[key];
							if (!isOfType(elementValue, elementType)) {
								return false;
							}
						}
						return true;
					}
					case 'dictionaryLiteral': {
						if (!isDictionary(value)) {
							return false;
						}
						const fieldTypes = builtInType.fields;
						for (const key in fieldTypes) {
							const elementValue = value[key];
							const elementType = fieldTypes[key]!;
							if (!isOfType(elementValue, elementType)) {
								return false;
							}
						}
						return true;
					}
					case 'list':
						return Array.isArray(value)
							&& value.every(element =>
								isOfType(element, builtInType.elementType));
					case 'tuple':
						return Array.isArray(value)
							&& value.length <= builtInType.elementTypes.length
							&& builtInType.elementTypes.every((elementType, index) =>
								isOfType(value[index], elementType));
					case 'stream':
						// TODO check value type
						return value instanceof Stream;
					case 'function':
						// TODO check returntype/paramstype
						return typeof value === 'function';
					case 'reference':
						// TODO deref?
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
						return builtInType.choiceTypes.every(coiceType =>
							isOfType(value, coiceType));
					case 'or':
						return builtInType.choiceTypes.some(coiceType =>
							isOfType(value, coiceType));
					case 'not':
						return !isOfType(value, builtInType.sourceType);
					case 'typeOf':
						return deepEquals(value, builtInType.value);
					default: {
						const assertNever: never = builtInType;
						throw new Error(`Unexpected BuiltInType ${(assertNever as BuiltInType).type}`);
					}
				}
			}
			// null/Dictionary/Array
			return deepEquals(value, type);
		}
		case 'function':
			return type(value);
		default: {
			const assertNever: never = type;
			throw new Error(`Unexpected type ${typeof assertNever}`);
		}
	}
}

// TODO check empty prototype?
function isDictionary(value: any): value is { [key: string]: any; } {
	return typeof value === 'object'
		&& !(value instanceof BuiltInTypeBase)
		&& !(value instanceof Error)
		&& !Array.isArray(value);
}

function tryAssignParams(params: Params, values: any): any[] | Error {
	const assignedValues: any[] = [];
	const { type: outerType, singleNames, rest } = params;
	if (outerType !== undefined) {
		const isValid = isOfType(values, outerType);
		if (!isValid) {
			return new Error(`Can not assign the value ${values} to params because it is not of type ${outerType}`);
		}
		return assignedValues;
	}
	// primitive value in Array wrappen
	const wrappedValue: any[] | { [key: string]: any; } = typeof values === 'object'
		? values
		: [values];
	const isArray = Array.isArray(wrappedValue);
	let index = 0;
	if (singleNames) {
		for (; index < singleNames.length; index++) {
			const param = singleNames[index]!;
			const { name, type } = param;
			const value = isArray
				? wrappedValue[index]
				: wrappedValue[name];
			const isValid = type
				? isOfType(value, type)
				: true;
			if (!isValid) {
				return new Error(`Can not assign the value ${value} to param ${name} because it is not of type ${type}`);
			}
			assignedValues.push(value);
		}
	}
	if (rest) {
		const restType = rest.type;
		if (isArray) {
			const remainingArgs = wrappedValue.slice(index);
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
			throw new Error('tryAssignParams not implemented yet for rest dictionary');
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
			else if (value1 instanceof Stream || value2 instanceof Stream) {
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

export type RuntimeType =
	| null
	| boolean
	| number
	| bigint
	| string
	| any[]
	| { [key: string]: any; }
	| BuiltInType
	| CustomType
	;

interface Fraction {
	numerator: bigint;
	denominator: bigint;
}

type Rational = bigint | Fraction;

type CustomType = (value: any) => boolean;

export type BuiltInType =
	| AnyType
	| BooleanType
	| IntegerType
	| FloatType
	| StringType
	| ErrorType
	| ListType
	| TupleType
	| DictionaryType
	| DictionaryLiteralType
	| StreamType
	| FunctionType
	| ParameterReference
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

export class StringType extends BuiltInTypeBase {
	readonly type = 'string';
}

class ErrorType extends BuiltInTypeBase {
	readonly type = 'error';
}

class ListType extends BuiltInTypeBase {
	constructor(public elementType: RuntimeType) { super(); }
	readonly type = 'list';
}

export class TupleType extends BuiltInTypeBase {
	constructor(public elementTypes: RuntimeType[]) { super(); }
	readonly type = 'tuple';
}

class DictionaryType extends BuiltInTypeBase {
	constructor(public elementType: RuntimeType) { super(); }
	readonly type = 'dictionary';
}

// TODO rename to _DictionaryLiteralType or split builtin exports to other file or importLine contain only builtins?
export class DictionaryLiteralType extends BuiltInTypeBase {
	constructor(public fields: { [key: string]: RuntimeType; }) { super(); }
	readonly type = 'dictionaryLiteral';
}

export class StreamType extends BuiltInTypeBase {
	constructor(public valueType: RuntimeType) { super(); }
	readonly type = 'stream';
}

export class FunctionType extends BuiltInTypeBase {
	constructor(
		public paramsType: RuntimeType,
		public returnType: RuntimeType,
	) {
		super();
		// TODO set functionRef bei params
		if (returnType instanceof ParameterReference) {
			returnType.functionRef = this;
		}
	}
	readonly type = 'function';
}

// TODO Parameter Type ???


export class ParameterReference extends BuiltInTypeBase {
	constructor(
		public path: ReferencePath,
		public index: number,
	) { super(); }
	readonly type = 'reference';
	/**
	 * Wird im constructor von FunctionType gesetzt und sollte immer vorhanden sein.
	 */
	functionRef?: FunctionType;
}

export type ReferencePath = [Name, ...(Name | Index)[]];

export interface Name {
	type: 'name';
	name: string;
}

export interface Index {
	type: 'index';
	name: number;
}

export class TypeType extends BuiltInTypeBase {
	readonly type = 'type';
}

export class IntersectionType extends BuiltInTypeBase {
	constructor(public choiceTypes: RuntimeType[]) { super(); }
	readonly type = 'and';
}

export class UnionType extends BuiltInTypeBase {
	constructor(public choiceTypes: RuntimeType[]) { super(); }
	readonly type = 'or';
}

export class ComplementType extends BuiltInTypeBase {
	constructor(public sourceType: RuntimeType) { super(); }
	readonly type = 'not';
}

export class TypeOfType extends BuiltInTypeBase {
	constructor(public value: any) { super(); }
	readonly type = 'typeOf';
}

//#endregion Types

//#region Stream

type Listener<T> = (value: T) => void;

class Stream<T> {
	constructor(getValue: () => T) {
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
		this.lastValue = value;
		this.lastProcessId = processId;
		this.listeners.forEach(listener => listener(value));
	}
	/**
	 * Aktualisiert diesen Stream und alle Dependencies und benachrichtigt Subscriber.
	 */
	readonly getValue: () => T;
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

function createSource$<T>(initialValue: T): Stream<T> {
	const stream$: Stream<T> = new Stream(() => stream$.lastValue as T);
	stream$.push(initialValue, processId);
	return stream$;
}
function of$<T>(value: T): Stream<T> {
	const $ = createSource$(value);
	$.complete();
	return $;
}

//#endregion create

//#region transform

function createDerived$<T>(getValue: () => T): Stream<T> {
	const derived$: Stream<T> = new Stream(() => {
		if (processId === derived$.lastProcessId
			|| derived$.completed) {
			return derived$.lastValue!;
		}
		return getValue();
	});
	return derived$;
}

function map$<TSource, TTarget>(
	source$: Stream<TSource>,
	mapFunction: (value: TSource) => TTarget,
): Stream<TTarget> {
	let lastSourceValue: TSource;
	const mapped$: Stream<TTarget> = createDerived$(() => {
		const currentSourceValue = source$.getValue();
		if (deepEquals(currentSourceValue, lastSourceValue)) {
			mapped$.lastProcessId = processId;
			return mapped$.lastValue!;
		}
		const currentMappedValue = mapFunction(currentSourceValue);
		lastSourceValue = currentSourceValue;
		mapped$.push(currentMappedValue, processId);
		return currentMappedValue;
	});
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

function combine$<T>(
	...source$s: Stream<T>[]
): Stream<T[]> {
	const combined$: Stream<T[]> = createDerived$(() => {
		const lastValues = combined$.lastValue!;
		const currentValues = source$s.map(source$ =>
			source$.getValue());
		if (deepEquals(currentValues, lastValues)) {
			combined$.lastProcessId = processId;
			return lastValues;
		}
		combined$.push(currentValues, processId);
		return currentValues;
	});
	combined$.onCompleted(() => {
		unsubscribes.forEach((unsubscribe, index) => {
			unsubscribe();
		});
	});
	const unsubscribes = source$s.map((source$, index) => {
		source$.onCompleted(() => {
			// combined ist complete, wenn alle Sources complete sind.
			if (!source$s.some(source$ => !source$.completed)) {
				combined$.complete();
			}
		});
		return source$.subscribe(value => {
			combined$.getValue();
		});
	});
	return combined$;
}

function takeUntil$<T>(source$: Stream<T>, completed$: Stream<any>): Stream<T> {
	const mapped$ = map$(source$, x => x);
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

function flatMerge$<T>(source$$: Stream<Stream<T>>): Stream<T> {
	const inner$s: Stream<T>[] = [];
	const unsubscribeInners: (() => void)[] = [];
	const flat$: Stream<T> = createDerived$(() => {
		const lastValue = flat$.lastValue!;
		const currentValue = source$$.getValue().getValue();
		if (deepEquals(currentValue, lastValue)) {
			flat$.lastProcessId = processId;
			return lastValue;
		}
		flat$.push(currentValue, processId);
		return currentValue;
	});
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
				if (!inner$s.some(source$ => !source$.completed)) {
					flat$.complete();
				}
			});
		});
	});
	return flat$;
}

function flatSwitch$<T>(source$$: Stream<Stream<T>>): Stream<T> {
	let unsubscribeInner: () => void;
	const flat$: Stream<T> = createDerived$(() => {
		const lastValue = flat$.lastValue!;
		const currentValue = source$$.getValue().getValue();
		if (deepEquals(currentValue, lastValue)) {
			flat$.lastProcessId = processId;
			return lastValue;
		}
		flat$.push(currentValue, processId);
		return currentValue;
	});
	const unsubscribeOuter = source$$.subscribe(source$ => {
		unsubscribeInner = takeUntil$(source$, source$$).subscribe(value => {
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

// TODO
// function flatMap

// TODO testen
function accumulate$<TSource, TAccumulated>(
	source$: Stream<TSource>,
	initialAccumulator: TAccumulated,
	accumulate: (previousAccumulator: TAccumulated, value: TSource) => TAccumulated,
): Stream<TAccumulated> {
	const mapped$ = map$(source$, value => {
		const newAccumulator = accumulate(
			mapped$.lastValue === undefined
				? initialAccumulator
				: mapped$.lastValue,
			value);
		return newAccumulator;
	});
	return mapped$;
}

function retry$<T>(
	method$: () => Stream<T | Error>,
	maxAttepmts: number,
	currentAttempt: number = 1,
): Stream<T | Error> {
	if (currentAttempt === maxAttepmts) {
		return method$();
	}
	const withRetry$$ = map$(method$(), result => {
		if (result instanceof Error) {
			console.log('Error! Retrying... Attempt:', currentAttempt, 'process:', processId);
			return retry$(method$, maxAttepmts, currentAttempt + 1);
		}
		return of$<T | Error>(result);
	});
	return flatSwitch$(withRetry$$);
};

//#endregion transform

//#endregion Stream

//#region JSON

type ParserResult<T> = {
	parsed: T,
	endIndex: number;
} | Error;

function parseJsonValue(json: string, startIndex: number): ParserResult<any> {
	let index = parseJsonWhiteSpace(json, startIndex);
	const character = json[index]
	switch (character) {
		case 'n':
			return parseJsonToken(json, index, 'null', null)
		case 't':
			return parseJsonToken(json, index, 'true', true)
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
			const numerator = BigInt(integerString + (fractionString ?? ''))
			const exponentString = match.groups!.exponent;
			const fractionExponent = fractionString
				? BigInt('-' + fractionString.length)
				: 0n;
			const exponent = exponentString
				? BigInt(exponentString)
				: 0n;
			const combinedExponent = fractionExponent + exponent;
			const numberValue: Rational = combinedExponent < 0
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
			const array: any[] = [];
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
					array.push(elementResult.parsed);
					isSeparator = true;
					index = elementResult.endIndex;
				}
			}
		}
		case '{': {
			index++;
			const object: { [key: string]: any } = {};
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
							}
						default:
							return new Error(`Invalid JSON. Unexpected character ${objectCharacter} at position ${index} while parsing object.`);
					}
				}
				else {
					if (objectCharacter !== '"') {
						return new Error(`Invalid JSON. Unexpected character ${objectCharacter} at position ${index} while parsing object key.`)
					}
					const keyResult = parseJsonString(json, index);
					if (keyResult instanceof Error) {
						return keyResult;
					}
					const colonIndex = parseJsonWhiteSpace(json, keyResult.endIndex);
					const colonCharacter = json[colonIndex];
					if (colonCharacter !== ':') {
						return new Error(`Invalid JSON. Unexpected character ${objectCharacter} at position ${index} while parsing colon.`)
					}
					const valueResult = parseJsonValue(json, colonIndex + 1);
					if (valueResult instanceof Error) {
						return valueResult;
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
						index++
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

//#endregion JSON

//#endregion helper

//#region builtins
//#region Types
export const Any = new AnyType();
export const _Boolean = new BooleanType();
//#region Number
export const Float = new FloatType();
export const Integer = new IntegerType();
export const NonZeroInteger = new UnionType([Integer, new ComplementType(0)]);
//#endregion Number
export const _String = new StringType();
export const _Error = new ErrorType();
export const List = _createFunction(
	(ElementType: RuntimeType) =>
		new ListType(ElementType),
	{
		singleNames: [
			{
				name: 'ElementType',
				// TODO
				// type: { type: 'reference', names: ['Type'] }
			},
		]
	}
)
export const Type = new TypeType();
//#endregion Types
//#region Functions
//#region Any
export const equal = _createFunction(
	(first: any, second: any) =>
		first === second,
	{
		singleNames: [
			{
				name: 'first',
				// TODO
				// type: { type: 'reference', names: ['Any'] }
			},
			{
				name: 'second',
				// TODO
				// type: { type: 'reference', names: ['Any'] }
			}
		]
	}
);
//#endregion Any
//#region Number
// TODO moduloFloat
export const modulo = _createFunction(
	(dividend: bigint, divisor: bigint) =>
		dividend % divisor,
	{
		singleNames: [
			{
				name: 'dividend',
				// TODO
				// type: { type: 'reference', names: ['Integer'] }
			},
			{
				name: 'divisor',
				// TODO
				// type: { type: 'reference', names: ['NonZeroInteger'] }
			}
		]
	}
);
export const subtract = _createFunction(
	(minuend: Rational, subtrahend: Rational): Rational => {
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
	},
	{
		singleNames: [
			{
				name: 'minuend',
				// TODO
				// type: { type: 'reference', names: ['Rational'] }
			},
			{
				name: 'subtrahend',
				// TODO
				// type: { type: 'reference', names: ['Rational'] }
			}
		]
	}
);
export const subtractFloat = _createFunction(
	(minuend: number, subtrahend: number) =>
		minuend - subtrahend,
	{
		singleNames: [
			{
				name: 'minuend',
				// TODO
				// type: { type: 'reference', names: ['Float'] }
			},
			{
				name: 'subtrahend',
				// TODO
				// type: { type: 'reference', names: ['Float'] }
			}
		]
	}
);
// TODO sum, sumFloat
export const sum = _createFunction(
	(...args: Rational[]) =>
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
			0n),
	// TODO params type ...Rational[]
	{
		rest: {
			// name: 'args'
		}
	}
);
export const sumFloat = _createFunction(
	(...args: number[]) =>
		args.reduce(
			(accumulator, current) =>
				accumulator + current,
			0),
	// TODO params type ...Float[]
	{
		rest: {
			// name: 'args'
		}
	}
);
//#endregion Number
//#region String
export const parseJson = _createFunction(
	(json: string) => {
		const result = parseJsonValue(json, 0);
		if (result instanceof Error) {
			return result;
		}
		const endIndex = parseJsonWhiteSpace(json, result.endIndex);
		if (endIndex < json.length) {
			return new Error(`Invalid JSON. Unexpected extra charcter ${json[endIndex]} after parsed value at position ${endIndex}`);
		}
		return result.parsed;
	},
	{
		singleNames: [
			{
				name: 'json',
				// TODO
				// typeGuard: { type: 'reference', names: ['String'] }
			},
		]
	}
)
//#endregion String
//#region List
export const forEach = _createFunction(
	(
		values: any[],
		callback: (value: any) => void,
	) => {
		values.forEach(callback);
		return null;
	},
	{
		singleNames: [
			{
				name: 'values',
				// TODO
				// typeGuard: { type: 'reference', names: ['List'] }
			},
			{
				name: 'callback',
				// TODO
				// typeGuard: { type: 'reference', names: ['Function'] }
			},
		]
	}
)
//#endregion List
//#region Stream
//#region core
export const complete = _createFunction(
	(stream$: Stream<any>) => {
		stream$.complete();
		return null;
	},
	{
		singleNames: [
			{
				name: 'stream$',
				// TODO
				// typeGuard: { type: 'reference', names: ['Stream'] }
			},
		]
	}
);
export const subscribe = _createFunction(
	(stream$: Stream<any>, listener: JulFunction) => {
		const listenerFunction: Listener<any> = (value: any) => {
			_callFunction(listener, [value]);
		};
		return stream$.subscribe(listenerFunction);
	},
	{
		singleNames: [
			{
				name: 'stream$',
				// TODO
				// typeGuard: { type: 'reference', names: ['Stream'] }
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
export const httpTextRequest$ = _createFunction(
	(
		url: string,
		method: string,
		headers: { [key: string]: string },
		body: any
	): Stream<null | string | Error> => {
		const abortController = new AbortController();
		const response$ = createSource$<null | string | Error>(null);
		response$.onCompleted(() => {
			abortController.abort();
		});
		fetch(url, {
			method: method,
			headers: headers,
			body: body,
			signal: abortController.signal,
		}).then(response => {
			if (response.ok) {
				return response.text();
			}
			else {
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
	},
	{
		singleNames: [
			{
				name: 'url',
				// TODO
				// type: String
			},
			{
				name: 'method',
				// TODO
				// type: String
			},
			{
				name: 'body',
				// TODO
				// type: Any
			},
		]
	}
);
export const timer$ = _createFunction(
	(delayMs: number): Stream<number> => {
		const stream$ = createSource$(1);
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
	},
	{
		singleNames: [{
			name: 'delayMs',
			// TODO
			// type: Float
		}]
	}
);
//#endregion create
//#endregion Stream
//#region Utility
export const log = _createFunction(
	console.log,
	{
		rest: {}
	}
);
export const repeat = _createFunction(
	(
		count: bigint,
		iteratee: (index: bigint) => void,
	) => {
		for (let index = 1n; index <= count; index++) {
			iteratee(index);
		}
	},
	{
		singleNames: [
			{
				name: 'count',
				// TODO
				// type: Integer
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
			// TODO
			// type: String
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