import { Branching, DefinitionNames, DestructuringDefinition, Expression, FunctionCall, FunctionLiteral, NativeCode, NumberLiteral, ObjectLiteral, Reference, ReferenceNames, SingleDefinition, StringLiteral, TypeExpression, ValueExpression } from './abstract-syntax-tree';

type InterpretedValue =
	| null
	| boolean
	| string
	| number
	| FunctionLiteral
	| NativeCode
	| Stream<InterpretedValue>
	| InterpretedValue[]
	| { [name: string]: InterpretedValue }
	| Error
	;

// TODO Scope mit Object.create(null) erzeugen, damit prototype leer ist
interface Scope {
	[name: string]: InterpretedValue;
}

// TODO in scope/globals aufnehmen? 
// TODO beim interprete start setzen
let processId = 1;

//#region util

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

//#endregion util

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

	push(value: T): void {
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
	stream$.push(initialValue);
	return stream$;
}

function timer$(delayMs: number): Stream<number> {
	const stream$ = createSource$(1);
	const cycle = () => {
		setTimeout(() => {
			if (stream$.completed) {
				return;
			}
			processId++;
			stream$.push(stream$.lastValue! + 1);
			cycle();
		}, delayMs);
	}
	cycle();
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
		response$.push(response);
	}).catch(error => {
		processId++;
		response$.push(error);
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
	return new Stream(getValue);
}

function map$<TSource, TTarget>(
	source$: Stream<TSource>,
	mapFunction: (value: TSource) => TTarget,
): Stream<TTarget> {
	let lastSourceValue: TSource;
	const mapped$: Stream<TTarget> = createDerived$(() => {
		if (processId === mapped$.lastProcessId) {
			return mapped$.lastValue!;
		}
		const currentSourceValue = source$.getValue();
		if (deepEquals(currentSourceValue, lastSourceValue)) {
			mapped$.lastProcessId = processId;
			return mapped$.lastValue!;
		}
		const currentMappedValue = mapFunction(currentSourceValue);
		lastSourceValue = currentSourceValue;
		mapped$.push(currentMappedValue);
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
		if (combined$.lastProcessId === processId) {
			return lastValues;
		}
		const currentValues = source$s.map(source$ =>
			source$.getValue());
		if (deepEquals(currentValues, lastValues)) {
			combined$.lastProcessId = processId;
			return lastValues;
		}
		combined$.push(currentValues);
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
		if (processId === flat$.lastProcessId) {
			return lastValue;
		}
		const currentValue = source$$.getValue().getValue();
		if (deepEquals(currentValue, lastValue)) {
			flat$.lastProcessId = processId;
			return lastValue;
		}
		flat$.push(currentValue);
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
		if (processId === flat$.lastProcessId) {
			return lastValue;
		}
		const currentValue = source$$.getValue().getValue();
		if (deepEquals(currentValue, lastValue)) {
			flat$.lastProcessId = processId;
			return lastValue;
		}
		flat$.push(currentValue);
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

const builtIns: {
	[key: string]: NativeCode;
} = {
	//#region Types
	//#region Primitive Types
	// TODO Any?
	// TODO Boolean?
	//#region Numbers
	Float64: {
		type: 'native',
		code: (x: any) =>
			typeof x === 'number',
		params: { singleNames: [{ type: 'name', name: 'x', }] },
		returnType: 'Boolean',
		pure: true,
	},
	Integer: {
		type: 'native',
		code: (x: any) =>
			Number.isInteger(x),
		params: { singleNames: [{ type: 'name', name: 'x', }] },
		returnType: 'Boolean',
		pure: true,
	},
	NonNegativeInteger: {
		type: 'native',
		code: (x: any) =>
			Number.isInteger(x)
			&& x >= 0,
		params: { singleNames: [{ type: 'name', name: 'x', }] },
		returnType: 'Boolean',
		pure: true,
	},
	//#endregion Numbers
	String: {
		type: 'native',
		code: (x: any) => {
			return typeof x === 'string';
		},
		params: { singleNames: [{ type: 'name', name: 'x', }] },
		returnType: 'Boolean',
		pure: true,
	},
	// TODO Object?
	// TODO generic array?
	Array: {
		type: 'native',
		code: Array.isArray,
		params: { singleNames: [{ type: 'name', name: 'x', }] },
		returnType: 'Boolean',
		pure: true,
	},
	// TODO Dictionary
	Function: {
		// TODO Generic Parameter und Return Type
		type: 'native',
		code: (x: any) => {
			return typeof x === 'object'
				&& x !== null
				&& ((x as FunctionLiteral).type === 'functionLiteral'
					|| (x as NativeCode).type === 'native');
		},
		params: { singleNames: [{ type: 'name', name: 'x', }] },
		returnType: 'Boolean',
		pure: true,
	},
	Type: {
		// PureFunction Any => Boolean
		type: 'native',
		code: (x: any, scope: Scope) => {
			// TODO check function return type
			// const returnType = getReturnType(x, scope);
			return true;
		},
		params: { singleNames: [{ type: 'name', name: 'x', }] },
		returnType: 'Boolean',
		pure: true,
	},
	Stream: {
		// TODO Generic Type
		type: 'native',
		code: (x: any) => {
			return x instanceof Stream;
		},
		params: { singleNames: [{ type: 'name', name: 'x', }] },
		returnType: 'Boolean',
		pure: true,
	},
	Error: {
		type: 'native',
		code: (x: any) => {
			return x instanceof Error;
		},
		params: { singleNames: [{ type: 'name', name: 'x', }] },
		returnType: 'Boolean',
		pure: true,
	},
	//#endregion Primitive Types
	//#region Type Combinators
	// TODO Or, And(Merge)
	// Or: {
	// 	checkedTypes: ['PureFunction'],
	// 	value: (...types: Type[]) =>
	// 		(...args: any[]) =>
	// 			types.some(type => type(args))
	// },
	//#endregion Type Combinators
	//#endregion Types
	//#region Functions
	// TODO wird das überhaupt gebraucht? evtl alles über type branching möglich
	//#region Boolean
	and: {
		type: 'native',
		code: (...args: boolean[]) =>
			!args.some(arg => !arg),
		// TODO params type ...boolean[]
		params: { singleNames: [], rest: { name: 'args' } },
		returnType: 'Boolean',
		pure: true,
	},
	or: {
		type: 'native',
		code: (...args: boolean[]) =>
			args.some(arg => arg),
		// TODO params type ...boolean[]
		params: { singleNames: [], rest: { name: 'args' } },
		returnType: 'Boolean',
		pure: true,
	},
	//#endregion Boolean
	//#region Number
	// TODO comparison operations, multiply, subtract, divide, exponentiate, trogonometrie, random
	modulo: {
		type: 'native',
		code: (dividend: number, divisor: number) =>
			dividend % divisor,
		params: {
			singleNames: [
				{ type: 'name', name: 'dividend', typeGuard: { type: 'reference', names: ['Float64'] } },
				{ type: 'name', name: 'divisor', typeGuard: { type: 'reference', names: ['Float64'] } }]
		},
		returnType: 'Number',
		pure: true,
	},
	subtract: {
		type: 'native',
		code: (minuend: number, subtrahend: number) =>
			minuend - subtrahend,
		params: {
			singleNames: [
				{ type: 'name', name: 'minuend', typeGuard: { type: 'reference', names: ['Float64'] } },
				{ type: 'name', name: 'subtrahend', typeGuard: { type: 'reference', names: ['Float64'] } }]
		},
		returnType: 'Number',
		pure: true,
	},
	sum: {
		type: 'native',
		code: (...args: number[]) =>
			args.reduce(
				(accumulator, current) =>
					accumulator + current,
				0),
		// TODO params type ...T[]
		params: { singleNames: [], rest: { name: 'args' } },
		returnType: 'Number',
		pure: true,
	},
	//#endregion Number
	//#region String
	// TODO split, replace, substring, regex
	//#endregion String
	//#region Date
	// TODO date type, date literal etc
	// TODO currentDate, hour day etc
	//#endregion Date
	//#region Data Transformation
	// TODO map, filter, filterMap?, flatten/flatMap, aggregate, (concat, merge)?
	// contains, forEach
	// Array, Dictionary, Stream, String, generisch? mapFunction?
	//#region Stream
	//#region core
	complete: {
		type: 'native',
		code: (stream$: Stream<any>) => {
			stream$.complete();
			return null;
		},
		params: {
			singleNames: [
				{ type: 'name', name: 'stream$', typeGuard: { type: 'reference', names: ['Stream'] } },
			]
		},
		returnType: '()',
		pure: true,
	},
	onCompleted: {
		type: 'native',
		code: (stream$: Stream<any>, callback: () => void) => {
			stream$.onCompleted(callback);
			return null;
		},
		params: {
			singleNames: [
				{ type: 'name', name: 'stream$', typeGuard: { type: 'reference', names: ['Stream'] } },
				{ type: 'name', name: 'callback', typeGuard: { type: 'reference', names: ['Function'] } },
			]
		},
		returnType: '()',
		pure: true,
	},
	subscribe: {
		type: 'native',
		// TODO evaluateOnSubscribe?
		// TODO generic type argument, inferred basierend auf stream$
		code: (stream$: Stream<any>, listener: Listener<any>) => {
			return stream$.subscribe(listener);
		},
		params: {
			singleNames: [
				{ type: 'name', name: 'stream$', typeGuard: { type: 'reference', names: ['Stream'] } },
				{ type: 'name', name: 'listener', typeGuard: { type: 'reference', names: ['Function'] } },
			]
		},
		// TODO returnType Function () => void
		returnType: 'Function',
		pure: true,
	},
	//#endregion core
	// TODO create$
	//#region create
	// create$: {
	// 		type: 'native',
	// 		code: (x: any) =>
	// 			create$,
	// 		params: { singleNames: [{ type: 'name', name: 'x', }] },
	// 		returnType: 'Stream',
	// 		pure: true,
	// },
	timer$: {
		type: 'native',
		code: timer$,
		params: { singleNames: [{ type: 'name', name: 'delayMs', typeGuard: { type: 'reference', names: ['Float64'] } }] },
		// TODO returnType Stream(PositiveInteger)
		returnType: 'Stream',
		pure: true,
	},
	// TODO httpRequest$, of$
	//#endregion create
	//#region transform
	// TODO map$, combine$
	combine$: {
		type: 'native',
		code: combine$,
		// TODO Tuple type propagation in returnType
		// TODO source$s typeGuard Array(Stream)
		params: { singleNames: [], rest: { name: 'source$s' } },
		// TODO returnType Stream(Array)
		returnType: 'Stream',
		pure: true,
	},
	map$: {
		type: 'native',
		code: map$,
		params: { singleNames: [{ type: 'name', name: 'source', typeGuard: { type: 'reference', names: ['Stream'] } }] },
		// TODO returnType Stream(PositiveInteger)
		returnType: 'Stream',
		pure: true,
	},
	// TODO flatMerge$?(erstmal weglassen), flatSwitch$, takeUntil$
	//#endregion transform
	//#endregion Stream
	//#endregion Data Transformation
	//#region Utility
	// TODO createError (inklusive StackTrace)
	import: {
		// TODO pure bei static import?
		// TODO check file exists, return type
		type: 'native',
		code: (path: string) =>
			require(path),
		params: { singleNames: [{ type: 'name', name: 'x', typeGuard: { type: 'reference', names: ['String'] } }] },
		returnType: 'Any',
		pure: true,
	},
	log: {
		type: 'native',
		code: (...args: any[]) => {
			console.log(...args)
			return null
		},
		params: { singleNames: [], rest: { name: 'args' } },
		returnType: 'Empty',
		pure: true,
	},
	//#endregion Utility
	//#endregion Functions
};

export function interpreteAst(expressions: Expression[]): { value: InterpretedValue; state: Scope; } {
	const scope = createScope(builtIns);
	const value = interpreteExpressions(expressions, scope);
	return {
		state: scope,
		value: value,
	};
}

/**
 * Gibt den Wert der letzten Expression zurück.
 */
function interpreteExpressions(expressions: Expression[], scope: Scope): InterpretedValue {
	let value: InterpretedValue = null;
	expressions.forEach(expression => {
		value = interpreteExpression(expression, scope);
	});
	return value;
}

function interpreteExpression(expression: Expression, state: Scope): InterpretedValue {
	switch (expression.type) {
		case 'definition':
			return interpreteSingleDefinition(expression, state);

		case 'destructuring':
			interpreteDestructuringDefinition(expression, state);
			return null;

		case 'branching':
			return interpreteBranching(expression, state);

		case 'empty':
		case 'dictionary':
		case 'list':
			return interpreteObjectLiteral(expression, state);

		case 'functionCall':
			return interpreteFunctionCall(expression, state);

		case 'functionLiteral':
		case 'native':
			return expression;

		case 'number':
			return expression.value;

		case 'reference':
			return interpreteReferenceNames(expression.names, state);

		case 'string':
			return interpreteStringLiteral(expression, state);

		default: {
			const assertNever: never = expression;
			throw new Error('Unexpected expresstionType: ' + (assertNever as Expression).type);
		}
	}
}

//#region Definition

/**
 * Gibt den Wert zurück, der zugewiesen wird.
 */
function interpreteSingleDefinition(definition: SingleDefinition, scope: Scope): InterpretedValue {
	const { name, typeGuard, value } = definition;
	checkNameAlreadyDefined(name, scope);
	const uncheckedValue = interpreteExpression(value, scope);
	const checkedValue = checkType(typeGuard, uncheckedValue, scope);
	const finalValue = checkedValue.value;
	scope[name] = finalValue;
	return finalValue;
}

function interpreteDestructuringDefinition(destructuring: DestructuringDefinition, scope: Scope): void {
	const sourceValues = interpreteExpression(destructuring.value, scope);
	interpreteDestructuring(destructuring.names, sourceValues as any, scope, scope, true);
}

function interpreteDestructuring(
	destructuringNames: DefinitionNames,
	sourceValues: { [key: string]: InterpretedValue } | InterpretedValue[],
	targetObject: Scope,
	state: Scope,
	checkDefinedNames: boolean,
): boolean {
	if (typeof sourceValues !== 'object' || sourceValues === null) {
		throw new Error('Can only destructure objects');
	}
	let hasError = false;
	const isArray = Array.isArray(sourceValues);
	destructuringNames.singleNames.forEach(({ name, typeGuard, source, fallback }, index) => {
		if (checkDefinedNames) {
			checkNameAlreadyDefined(name, targetObject)
		}
		const sourceWithAlias = source ?? name;
		const sourceValue = isArray
			? sourceValues[index]
			: sourceValues[sourceWithAlias];
		const uncheckedValue = sourceValue ?? (fallback && interpreteExpression(fallback, state)) ?? null;
		const checkedValue = checkType(typeGuard, uncheckedValue, state);
		if (checkedValue.isError) {
			hasError = true;
		}
		targetObject[name] = checkedValue.value;
	});
	if (destructuringNames.rest) {
		const targetName = destructuringNames.rest.name;
		if (checkDefinedNames) {
			checkNameAlreadyDefined(targetName, targetObject);
		}
		let uncheckedValue;
		if (isArray) {
			// TODO dict destructuring?
			uncheckedValue = sourceValues.slice(destructuringNames.singleNames.length);
		}
		else {
			// TODO alle nicht benutzten dict keys nehmen? als dict?
			throw new Error('dictionary rest destructuring not implemented yet');
		}
		const checkedValue = checkType(destructuringNames.rest.typeGuard, uncheckedValue, state);
		targetObject[targetName] = checkedValue.value;
	}
	return hasError;
}

//#endregion Definition

//#region Value

function interpreteBranching(branching: Branching, state: Scope): InterpretedValue {
	const value = interpreteExpression(branching.value, state);
	const values = typeof value === 'object'
		? value
		: [value];
	for (const branch of branching.branches) {
		const functionValue = interpreteExpression(branch, state) as FunctionLiteral | NativeCode;
		// TODO typeCheck functionValue auf Function
		const functionName = branch.type === 'reference'
			? referenceNamesToString(branch.names)
			: undefined;
		const functionScope = tryCreateFunctionScope(functionValue.params, values as any, functionName, state);
		if (functionScope instanceof Error) {
			continue;
		}
		return callFunctionWithScope(functionValue, functionScope);
	}
	// TODO error verbessern mit value, errors?
	return new Error('No branch matched');
}

function interpreteObjectLiteral(objectExpression: ObjectLiteral, state: Scope): InterpretedValue[] | { [key: string]: InterpretedValue } | null {
	switch (objectExpression.type) {
		case 'empty':
			return null;

		case 'dictionary':
			const valuesDictionary: Scope = Object.create(null);
			objectExpression.values.forEach((expression, index) => {
				const { name, typeGuard, value } = expression;
				checkNameAlreadyDefined(name, valuesDictionary)
				const uncheckedValue = interpreteExpression(value, state);
				const checkedValue = checkType(typeGuard, uncheckedValue, state);
				valuesDictionary[name] = checkedValue.value;
			});
			if (!Object.keys(valuesDictionary).length) {
				return null;
			}
			return valuesDictionary;

		case 'list':
			const valuesArray = objectExpression.values.map((expression, index) => {
				const uncheckedValue = interpreteExpression(expression, state);
				return uncheckedValue;
			});
			if (!valuesArray.length) {
				return null;
			}
			return valuesArray;

		default:
			throw new Error('Unexpected type');
	}
}

function interpreteStringLiteral(stringLiteral: StringLiteral, state: Scope): string {
	const parts = stringLiteral.values.map(part => {
		switch (part.type) {
			case 'stringToken':
				return part.value;

			default:
				return interpreteExpression(part, state);
		}
	})
	const joined = parts.join('');
	return joined;
}

function interpreteReferenceNames(referenceNames: ReferenceNames, scope: Scope): InterpretedValue {
	let value = getValueFromScope(scope, referenceNames[0]);
	for (let index = 1; index < referenceNames.length; index++) {
		const name = referenceNames[index]!;
		if (
			// Prüfe ob value ein Dictionary/Array ist
			typeof value !== 'object'
			|| value === null
			|| value instanceof Stream
			|| !(name in value)
		) {
			// check scope for function, create function with argument bound to value
			const functionValue = getValueFromScope(scope, name as string) as FunctionLiteral | NativeCode;
			if (!functionValue || (functionValue.type !== 'functionLiteral' && functionValue.type !== 'native')) {
				throw new Error(`Can not bind argument to ${name} because it is not a function`);
			}
			const boundFunction: FunctionLiteral = {
				type: 'functionLiteral',
				pure: functionValue.pure,
				params: {
					...functionValue.params,
					// remove 1st argument
					singleNames: functionValue.params.singleNames.slice(1)
				},
				// TODO call functionValue mit value, ...args
				body: [
					{
						type: 'functionCall',
						functionReference: [name as string],
						params: {
							type: 'list',
							values: [value as any] // TODO array/dictionary? params aus functionValue mappen?
						},
					}
				],
			};
			value = boundFunction;
		}
		else {
			value = (value as any)[name];
		}
	}
	return value;
}

function interpreteFunctionCall(functionCall: FunctionCall, state: Scope): InterpretedValue {
	const functionReference = functionCall.functionReference;
	const functionValue = interpreteReferenceNames(functionReference, state) as FunctionLiteral | NativeCode;
	const functionName = referenceNamesToString(functionReference);
	if (functionValue.type !== 'functionLiteral' && functionValue.type !== 'native') {
		throw new Error(`Can not call ${functionName} because it is not a function`);
	}
	const params = interpreteExpression(functionCall.params, state);
	const returnValue = callFunction(functionValue, params as any, functionName, state);
	return returnValue;
}

// TODO call imported functions mit imported scope
function tryCreateFunctionScope(
	paramDefinitions: DefinitionNames,
	paramValues: { [key: string]: InterpretedValue } | InterpretedValue[],
	functionName: string | undefined,
	scope: Scope,
): Scope | Error {
	if (!paramDefinitions) {
		if (paramValues !== null) {
			return new Error(`Function ${functionName ?? '(anonymous)'} takes no arguments`);
		}
		return scope;
	}

	const functionScope = createScope(scope);
	const hasError = interpreteDestructuring(
		paramDefinitions,
		paramValues,
		functionScope,
		scope,
		false,
	);
	if (hasError) {
		// TODO error verbessern
		return new Error('Invalid arguments');
	}
	return functionScope;
}

function callFunction(
	functionLiteral: FunctionLiteral | NativeCode,
	params: { [key: string]: InterpretedValue } | InterpretedValue[],
	functionName: string | undefined,
	state: Scope,
): InterpretedValue {
	const functionScope = tryCreateFunctionScope(functionLiteral.params, params, functionName, state);
	if (functionScope instanceof Error) {
		return functionScope;
	}
	return callFunctionWithScope(functionLiteral, functionScope);
}

function callFunctionWithScope(functionLiteral: FunctionLiteral | NativeCode, functionScope: Scope): InterpretedValue {
	let returnValue;
	switch (functionLiteral.type) {
		case 'functionLiteral':
			returnValue = interpreteExpressions(functionLiteral.body, functionScope);
			break;

		case 'native':
			const nativeArgs = functionLiteral.params.singleNames.map(definitionName =>
				getValueFromScope(functionScope, definitionName.name));
			if (functionLiteral.params.rest) {
				nativeArgs.push(...getValueFromScope(functionScope, functionLiteral.params.rest.name) as any);
			}
			returnValue = functionLiteral.code(...nativeArgs);
			break;

		default:
			throw new Error('invalid function type');
	}
	return returnValue;
}

//#endregion Value

//#region helper

function createScope(baseScope: Scope): Scope {
	return Object.assign(Object.create(null), baseScope);
}

function getValueFromScope(scope: Scope, name: string): InterpretedValue {
	if (name in scope) {
		return scope[name]!;
	}
	throw new Error(`${name} is not defined`);
}

function checkType(typeExpression: TypeExpression | undefined, value: InterpretedValue, state: Scope): { value: InterpretedValue; isError: boolean; } {
	if (!typeExpression) {
		return {
			value: value,
			isError: false
		};
	}
	const typeFunction = interpreteTypeExpression(typeExpression, state)
	const functionName = typeExpression.type === 'reference'
		? referenceNamesToString(typeExpression.names)
		: undefined;

	const typeCheck = callFunction(typeFunction, [value], functionName, state);
	if (typeCheck instanceof Error) {
		return {
			value: typeCheck,
			isError: true
		};
	}
	if (typeof typeCheck !== 'boolean') {
		throw new Error('TypeCheck returned a non boolean value');
	}
	return {
		value: typeCheck
			? value
			// TODO error verbessern mit functionName/type function definition
			: new Error('Type mismatch'),
		isError: !typeCheck
	}
}

function interpreteTypeExpression(typeExpression: TypeExpression, state: Scope): FunctionLiteral | NativeCode {
	const interpretedExpression = interpreteExpression(typeExpression, state)
	switch (typeof interpretedExpression) {
		case 'number':
			return {
				type: 'native',
				pure: true,
				code: (x: any) =>
					x === interpretedExpression,
				params: { singleNames: [{ type: 'name', name: 'x', }] },
				returnType: 'Boolean',
			};

		// TODO null/() literal, boolean literal, string literal, object literal, interface (object mit typeguards)
		// TODO typeCheck typeFunction auf Function: any => boolean
		default:
			return interpretedExpression as any;
	}
}

function checkNameAlreadyDefined(name: string, scope: object) {
	if (name in scope) {
		throw new Error(`${name} is already defined`);
	}
}

function referenceNamesToString(referenceName: ReferenceNames): string {
	return referenceName.join('.');
}

function getReturnType(funcionLiteral: FunctionLiteral, scope: Scope): string {
	// TODO checkedTypes benutzen?
	const lastExpression = funcionLiteral.body[funcionLiteral.body.length - 1];
	if (!lastExpression) {
		return 'Empty';
	}
	return 'TODO';
}

// TODO Expression/Value toString

//#endregion helper