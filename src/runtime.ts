let processId = 1;

type Type = (value: any) => boolean

interface Params {
	singleNames?: {
		name: string;
		type?: Type;
	}[];
	rest?: {
		type?: Type
	};
}

type JulFunction = Function & { params: Params };

//#region internals

export function _branch(value: any, ...branches: JulFunction[]) {
	// TODO collect inner Errors?
	for (const branch of branches) {
		const assignedParams = tryAssignParams(value, branch.params);
		if (!(assignedParams instanceof Error)) {
			return branch(assignedParams);
		}
	}
	return new Error(`${value} did not match any branch`);
}

export function _callFunction(fn: JulFunction, args: any) {
	const assignedParams = tryAssignParams(args, fn.params);
	if (assignedParams instanceof Error) {
		return assignedParams;
	}
	return fn(...assignedParams);
}

export function _checkType(type: Type, value: any) {
	return type(value)
		? value
		: new Error(`${value} is not of type ${type}`);
}

export function _createFunction(fn: Function, params: Params): JulFunction {
	const julFn = fn as JulFunction;
	julFn.params = params;
	return julFn;
}

//#endregion internals

function tryAssignParams(values: any[] | { [key: string]: any }, params: Params): any[] | Error {
	const assigneds: any[] = [];
	const { singleNames, rest } = params;
	const isArray = Array.isArray(values);
	let index = 0;
	if (singleNames) {
		for (; index < singleNames.length; index++) {
			const param = singleNames[index]!;
			const { name, type } = param;
			const value = isArray
				? values[index]
				: values[name];
			const isValid = type
				? type(value)
				: true;
			if (!isValid) {
				return new Error(`Can not assigne the value ${value} to param ${name} because it is not of type ${type}`);
			}
			assigneds.push(value);
		}
	}
	if (rest) {
		const restType = rest.type;
		if (isArray) {
			for (; index < values.length; index++) {
				const value = values[index];
				const isValid = restType
					? restType(value)
					: true;
				if (!isValid) {
					return new Error(`Can not assigne the value ${value} to rest param because it is not of type ${rest}`);
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

function deepEquals(value1: any, value2: any): boolean {
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
				return true
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
// TODO

//#region Number
export const subtract = _createFunction(
	(minuend: number, subtrahend: number) =>
		minuend - subtrahend,
	{
		singleNames: [
			{
				name: 'minuend',
				// TODO
				// type: { type: 'reference', names: ['Float64'] }
			},
			{
				name: 'subtrahend',
				// TODO
				// type: { type: 'reference', names: ['Float64'] }
			}]
	}
);
export const sum = _createFunction(
	(...args: number[]) =>
		args.reduce(
			(accumulator, current) =>
				accumulator + current,
			0),
	// TODO params type ...Float64[]
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
		}
		cycle();
		return stream$;
	},
	{
		singleNames: [{
			name: 'delayMs',
			// TODO params type Float64
			// type: Float64
		}]
	}
);
//#endregion create
//#endregion Stream
//#region Utility
export const log = _createFunction(console.log, { rest: {} });
//#endregion Utility

// TODO dynamische imports erlauben??
// export const _import = _createFunction(require, {
// 	singleNames: [{
// 		name: 'path',
// 		type: (x) => typeof x === 'string'
// 	}]
// });

//#endregion builtins