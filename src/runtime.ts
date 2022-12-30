let processId = 1;

interface Params {
	type?: Type;
	singleNames?: {
		name: string;
		type?: Type;
	}[];
	rest?: {
		type?: Type;
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

export function _callFunction(fn: JulFunction, args: any) {
	const assignedParams = tryAssignParams(fn.params, args);
	if (assignedParams instanceof Error) {
		return assignedParams;
	}
	return fn(...assignedParams);
}

export function _checkType(type: Type, value: any) {
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

function isOfType(value: any, type: Type): boolean {
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

					case 'arbitraryInteger':
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

// TOOD check empty prototype?
function isDictionary(value: any): value is { [key: string]: any; } {
	return typeof value === 'object'
		&& !(value instanceof BuiltInTypeBase)
		&& !(value instanceof Error)
		&& !Array.isArray(value);
}

function tryAssignParams(params: Params, values: any): any[] | Error {
	const assigneds: any[] = [];
	const { type: outerType, singleNames, rest } = params;
	if (outerType) {
		const isValid = isOfType(values, outerType);
		if (!isValid) {
			return new Error(`Can not assign the value ${values} to params because it is not of type ${outerType}`);
		}
		return assigneds;
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
			assigneds.push(value);
		}
	}
	if (rest) {
		const restType = rest.type;
		if (isArray) {
			for (; index < wrappedValue.length; index++) {
				const value = wrappedValue[index];
				const isValid = restType
					? isOfType(value, restType)
					: true;
				if (!isValid) {
					return new Error(`Can not assign the value ${value} to rest param because it is not of type ${rest}`);
				}
				assigneds.push(value);
			}
		}
		else {
			// TODO rest dictionary??
			throw new Error('tryAssignParams not implemented yet for rest dictionary');
		}
	}
	return assigneds;
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

export type Type =
	| null
	| boolean
	| number
	| bigint
	| string
	| { [key: string]: any; }
	| any[]
	| BuiltInType
	| CustomType
	;

type CustomType = (value: any) => boolean;

export type BuiltInType =
	| Any
	| BooleanType
	| ArbitraryInteger
	| Float
	| StringType
	| ErrorType
	| DictionaryType
	| DictionaryLiteralType
	| ListType
	| TupleType
	| StreamType
	| FunctionType
	| ArgumentReference
	| TypeType
	| IntersectionType
	| UnionType
	| TypeOfType
	;

export class BuiltInTypeBase { }

export class Any extends BuiltInTypeBase {
	readonly type = 'any';
}

export class BooleanType extends BuiltInTypeBase {
	readonly type = 'boolean';
}

export class ArbitraryInteger extends BuiltInTypeBase {
	readonly type = 'arbitraryInteger';
}

export class Float extends BuiltInTypeBase {
	readonly type = 'float';
}

export class StringType extends BuiltInTypeBase {
	readonly type = 'string';
}

class ErrorType extends BuiltInTypeBase {
	readonly type = 'error';
}

class DictionaryType extends BuiltInTypeBase {
	constructor(public elementType: Type) { super(); }
	readonly type = 'dictionary';
}

export class DictionaryLiteralType extends BuiltInTypeBase {
	constructor(public fields: { [key: string]: Type; }) { super(); }
	readonly type = 'dictionaryLiteral';
}

class ListType extends BuiltInTypeBase {
	constructor(public elementType: Type) { super(); }
	readonly type = 'list';
}

export class TupleType extends BuiltInTypeBase {
	constructor(public elementTypes: Type[]) { super(); }
	readonly type = 'tuple';
}

export class StreamType extends BuiltInTypeBase {
	constructor(public valueType: Type) { super(); }
	readonly type = 'stream';
}

export class FunctionType extends BuiltInTypeBase {
	constructor(
		public paramsType: Type,
		public returnType: Type,
	) {
		super();
		// TODO set functionRef bei params
		if (returnType instanceof ArgumentReference) {
			returnType.functionRef = this;
		}
	}
	readonly type = 'function';
}

// TODO Parameter Type ???


export class ArgumentReference extends BuiltInTypeBase {
	constructor(
		public path: ReferencePath,
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
	constructor(public choiceTypes: Type[]) { super(); }
	readonly type = 'and';
}

export class UnionType extends BuiltInTypeBase {
	constructor(public choiceTypes: Type[]) { super(); }
	readonly type = 'or';
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

function httpRequest$(url: string, method: string, body: any): Stream<null | Response | Error> {
	const abortController = new AbortController();
	const response$ = createSource$<null | Response | Error>(null);
	response$.onCompleted(() => {
		abortController.abort();
	});
	fetch(url, {
		method: method,
		body: body,
		signal: abortController.signal,
	}).then(response => {
		processId++;
		response$.push(response, processId);
	}).catch(error => {
		processId++;
		response$.push(error, processId);
	}).finally(() => {
		response$.complete();
	});
	return response$;
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

//#region builtins

//#region Types
export const _any = new Any();
export const _boolean = new BooleanType();
export const _arbitraryInteger = new ArbitraryInteger();
export const _float = new Float();
export const _string = new StringType();
export const _error = new ErrorType();
export const _type = new TypeType();
//#endregion Types

// TODO remove
// TODO types, funktionen ergänzen

//#region Number
// TODO subtract, subtractFloat
export const subtract = _createFunction(
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
			}]
	}
);
// TODO sum, sumFloat
export const sum = _createFunction(
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
//#endregion Utility

// TODO dynamische imports erlauben??
// export const _import = _createFunction(require, {
// 	singleNames: [{
// 		name: 'path',
// 		type: (x) => typeof x === 'string'
// 	}]
// });

//#endregion builtins