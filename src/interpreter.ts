import { Branching, DefinitionNames, DestructuringDefinition, Expression, FunctionCall, FunctionLiteral, NativeCode, NumberLiteral, ObjectLiteral, Reference, ReferenceNames, SingleDefinition, StringLiteral, TypeExpression, ValueExpression } from './abstract-syntax-tree';

interface Scope {
	[key: string]: {
		checkedTypes: string[];
		value: any;
	};
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
				for (const key in value1) {
					if (value1[key] !== value2[key]) {
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
	[key: string]: {
		checkedTypes: string[];
		value: NativeCode;
	};
} = {
	//#region Types
	//#region Primitive Types
	// TODO Boolean
	//#region Numbers
	Float64: {
		checkedTypes: ['Type'],
		value: {
			type: 'native',
			code: (x: any) =>
				typeof x === 'number',
			params: { singleNames: [{ type: 'name', name: 'x', }] },
			returnType: 'Boolean',
			pure: true,
		}
	},
	Integer: {
		checkedTypes: ['Type'],
		value: {
			type: 'native',
			code: (x: any) =>
				Number.isInteger(x),
			params: { singleNames: [{ type: 'name', name: 'x', }] },
			returnType: 'Boolean',
			pure: true,
		}
	},
	NonNegativeInteger: {
		checkedTypes: ['Type'],
		value: {
			type: 'native',
			code: (x: any) =>
				Number.isInteger(x)
				&& x >= 0,
			params: { singleNames: [{ type: 'name', name: 'x', }] },
			returnType: 'Boolean',
			pure: true,
		}
	},
	//#endregion Numbers
	String: {
		checkedTypes: ['Type'],
		// PureFunction Any => Boolean
		value: {
			type: 'native',
			code: (x: any) => {
				return typeof x === 'string';
			},
			params: { singleNames: [{ type: 'name', name: 'x', }] },
			returnType: 'Boolean',
			pure: true,
		}
	},
	// TODO Object?
	// TODO generic array?
	Array: {
		checkedTypes: ['Type'],
		// PureFunction Any => Array
		value: {
			type: 'native',
			code: Array.isArray,
			params: { singleNames: [{ type: 'name', name: 'x', }] },
			returnType: 'Boolean',
			pure: true,
		}
	},
	// TODO Dictionary
	// TODO Stream
	// TODO Function
	Type: {
		checkedTypes: ['Type'],
		// PureFunction Any => Boolean
		value: {
			type: 'native',
			code: (x: any, scope: Scope) => {
				// TODO check function return type
				// const returnType = getReturnType(x, scope);
				return true;
			},
			params: { singleNames: [{ type: 'name', name: 'x', }] },
			returnType: 'Boolean',
			pure: true,
		}
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
		checkedTypes: ['PureFunction'],
		value: {
			type: 'native',
			code: (...args: boolean[]) =>
				!args.some(arg => !arg),
			// TODO params type ...boolean[]
			params: { singleNames: [], rest: { name: 'args' } },
			returnType: 'Boolean',
			pure: true,
		}
	},
	or: {
		checkedTypes: ['PureFunction'],
		value: {
			type: 'native',
			code: (...args: boolean[]) =>
				args.some(arg => arg),
			// TODO params type ...boolean[]
			params: { singleNames: [], rest: { name: 'args' } },
			returnType: 'Boolean',
			pure: true,
		}
	},
	//#endregion Boolean
	//#region Number
	// TODO comparison operations, multiply, subtract, divide, exponentiate, trogonometrie, random
	modulo: {
		checkedTypes: ['PureFunction'],
		value: {
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
		}
	},
	subtract: {
		checkedTypes: ['PureFunction'],
		value: {
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
		}
	},
	sum: {
		checkedTypes: ['PureFunction'],
		value: {
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
		}
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
	// TODO create$, map$, aggregate$/combine$
	create$: {
		checkedTypes: ['Function'],
		value: {
			type: 'native',
			code: (x: any) =>
				typeof x === 'number',
			params: { singleNames: [{ type: 'name', name: 'x', }] },
			returnType: 'Boolean',
			pure: true,
		}
	},
	//#endregion Stream
	//#endregion Data Transformation
	//#region Utility
	// TODO createError (inklusive StackTrace)
	import: {
		// TODO pure bei static import?
		// TODO check file exists, return type
		checkedTypes: ['ImpureFunction'],
		value: {
			type: 'native',
			code: (path: string) =>
				require(path),
			params: { singleNames: [{ type: 'name', name: 'x', typeGuard: { type: 'reference', names: ['String'] } }] },
			returnType: 'Any',
			pure: true,
		}
	},
	log: {
		// TODO check file exists, return type
		checkedTypes: ['ImpureFunction'],
		value: {
			type: 'native',
			code: (...args: any[]) => {
				console.log(...args)
				return null
			},
			params: { singleNames: [], rest: { name: 'args' } },
			returnType: 'Empty',
			pure: true,
		}
	},
	//#endregion Utility
	//#endregion Functions
};

export function interpreteAst(expressions: Expression[]): { value: any; state: Scope; } {
	return interpreteExpressions(
		expressions,
		builtIns
	);
}

/**
 * Gibt den Wert der letzten Expression zurück.
 */
function interpreteExpressions(expressions: Expression[], state: Scope): { value: any; state: Scope; } {
	let newState = state;
	let value;
	expressions.forEach(expression => {
		const result = interpreteExpression(expression, newState);
		newState = result.state;
		value = result.value;
	});
	return {
		value: value,
		state: newState,
	};
}

function interpreteExpression(expression: Expression, state: Scope): { value: any; state: Scope; } {
	switch (expression.type) {

		case 'definition':
			return interpreteSingleDefinition(expression, state);

		case 'destructuring':
			return interpreteDestructuringDefinition(expression, state);

		case 'branching':
		case 'empty':
		case 'dictionary':
		case 'list':
		case 'functionCall':
		case 'functionLiteral':
		case 'number':
		case 'reference':
		case 'string':
			return { state: state, value: interpreteValueExpression(expression, state) };

		default:
			throw new Error('TODO');
	}
}

//#region Definition

/**
 * Gibt den Wert zurück, der zugewiesen wird.
 */
function interpreteSingleDefinition(definition: SingleDefinition, state: Scope): { value: any; state: Scope; } {
	const { name, typeGuard, value } = definition;
	checkNameDefined(name, state)
	const uncheckedValue = interpreteValueExpression(value, state);
	const checkedValue = checkType(typeGuard, uncheckedValue, state);
	const finalValue = checkedValue.value;
	const newState: Scope = {
		...state,
		[name]: {
			checkedTypes: checkedValue.isError ? ['Error'] : ['TODO'],
			value: finalValue
		}
	}
	return { value: finalValue, state: newState }
}

function interpreteDestructuringDefinition(destructuring: DestructuringDefinition, state: Scope): { value: undefined; state: Scope; hasError: boolean; } {
	const sourceValues = interpreteValueExpression(destructuring.value, state);
	const newState: Scope = {
		...state,
	}
	const hasError = interpreteDestructuring(destructuring.names, sourceValues, newState, state, true);
	return { value: undefined, state: newState, hasError: hasError }
}

function interpreteDestructuring(
	destructuringNames: DefinitionNames,
	sourceValues: { [key: string]: any } | any[],
	targetObject: Scope,
	state: Scope,
	checkDefinedNames: boolean,
): boolean {
	if (typeof sourceValues !== 'object') {
		throw new Error();
	}
	let hasError = false;
	const isArray = Array.isArray(sourceValues);
	destructuringNames.singleNames.forEach(({ name, typeGuard, source, fallback }, index) => {
		if (checkDefinedNames) {
			checkNameDefined(name, targetObject)
		}
		const sourceWithAlias = source ?? name;
		const sourceValue = isArray
			? (sourceValues as any[])[index]
			: (sourceValues as { [key: string]: any })[sourceWithAlias];
		const uncheckedValue = sourceValue ?? (fallback && interpreteValueExpression(fallback, state));
		const checkedValue = checkType(typeGuard, uncheckedValue, state);
		if (checkedValue.isError) {
			hasError = true
		}
		targetObject[name] = {
			checkedTypes: [],// TODO
			value: checkedValue.value,
		};
	});
	if (destructuringNames.rest) {
		const targetName = destructuringNames.rest.name;
		if (checkDefinedNames) {
			checkNameDefined(targetName, targetObject)
		}
		let uncheckedValue;
		if (isArray) {
			// TODO dict destructuring?
			uncheckedValue = (sourceValues as any[]).slice(destructuringNames.singleNames.length);
		}
		else {
			// TODO alle nicht benutzten dict keys nehmen? als dict?
		}
		const checkedValue = checkType(destructuringNames.rest.typeGuard, uncheckedValue, state);
		targetObject[targetName] = {
			checkedTypes: [],// TODO
			value: checkedValue.value,
		};
	}
	return hasError
}

//#endregion Definition

//#region Value

// TODO return checkedTypes?
function interpreteValueExpression(expression: ValueExpression, state: Scope): any {
	switch (expression.type) {
		case 'branching':
			return interpreteBranching(expression, state);

		case 'empty':
		case 'dictionary':
		case 'list':
			return interpreteObjectLiteral(expression, state);

		case 'functionCall':
			return interpreteFunctionCall(expression, state);

		case 'functionLiteral':
			return expression;

		case 'number':
			return expression.value;

		case 'reference':
			return interpreteReferenceNames(expression.names, state);

		case 'string':
			return interpreteStringLiteral(expression, state);

		default:
			throw new Error('TODO');
	}
}

function interpreteBranching(branching: Branching, state: Scope): any {
	const value = interpreteValueExpression(branching.value, state);
	const values = typeof value === 'object'
		? value
		: [value];
	for (const branch of branching.branches) {
		const functionValue: FunctionLiteral | NativeCode = interpreteValueExpression(branch, state)
		// TODO typeCheck functionValue auf Function
		const functionName = branch.type === 'reference'
			? referenceNamesToString(branch.names)
			: undefined
		const functionScope = tryMakeFunctionScope(functionValue.params, values, functionName, state);
		if (functionScope instanceof Error) {
			continue;
		}
		return callFunctionWithScope(functionValue, functionScope);
	}
	// TODO error verbessern mit value, errors?
	return new Error('No branch matched');
}

function interpreteObjectLiteral(objectExpression: ObjectLiteral, state: Scope): object | null {
	switch (objectExpression.type) {
		case 'empty':
			return null;

		case 'dictionary':
			const valuesDictionary: Scope = {};
			objectExpression.values.forEach((expression, index) => {
				const { name, typeGuard, value } = expression;
				checkNameDefined(name, valuesDictionary)
				const uncheckedValue = interpreteValueExpression(value, state);
				const checkedValue = checkType(typeGuard, uncheckedValue, state);
				valuesDictionary[name] = {
					checkedTypes: [], // TODO typeGuard/Error
					value: checkedValue.value
				};
			});
			if (!Object.keys(valuesDictionary).length) {
				return null;
			}
			return valuesDictionary;

		case 'list':
			const valuesArray = objectExpression.values.map((expression, index) => {
				const uncheckedValue = interpreteValueExpression(expression, state);
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
	// TODO
	const parts = stringLiteral.values.map(part => {
		switch (part.type) {
			case 'stringToken':
				return part.value;

			default:
				return interpreteValueExpression(part, state);
		}
	})
	const joined = parts.join('')
	return joined
}

function interpreteReferenceNames(referenceNames: ReferenceNames, state: Scope): any {
	let value: any = state;
	referenceNames.forEach(name => {
		if (!(name in value)) {
			throw new Error(`${name} is not defined`);
		}
		value = value[name].value
	});
	return value;
}

function interpreteFunctionCall(functionCall: FunctionCall, state: Scope): any {
	const functionValue: FunctionLiteral | NativeCode = interpreteReferenceNames(functionCall.functionReference, state);
	if (functionValue.type !== 'functionLiteral' && functionValue.type !== 'native') {
		throw new Error(`Can not call ${referenceNamesToString(functionCall.functionReference)} because it is not a function`);
	}
	const params = interpreteValueExpression(functionCall.params, state);
	const returnValue = callFunction(functionValue, params, referenceNamesToString(functionCall.functionReference), state);
	return returnValue;
}

// TODO call imported functions mit imported scope
function tryMakeFunctionScope(
	paramDefinitions: DefinitionNames,
	paramValues: any,
	functionName: string | undefined,
	state: Scope,
): Scope | Error {
	if (!paramDefinitions) {
		if (paramValues !== null) {
			return new Error(`Function ${functionName ?? '(anonymous)'} takes no arguments`);
		}
		return state;
	}

	const functionScope = { ...state };
	const hasError = interpreteDestructuring(
		paramDefinitions,
		paramValues,
		functionScope,
		state,
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
	params: any,
	functionName: string | undefined,
	state: Scope,
): any {
	const functionScope = tryMakeFunctionScope(functionLiteral.params, params, functionName, state);
	if (functionScope instanceof Error) {
		return functionScope
	}
	return callFunctionWithScope(functionLiteral, functionScope);
}

function callFunctionWithScope(functionLiteral: FunctionLiteral | NativeCode, functionScope: Scope): any {
	let returnValue;
	switch (functionLiteral.type) {
		case 'functionLiteral':
			returnValue = interpreteExpressions(functionLiteral.body, functionScope).value;
			break;

		case 'native':
			const nativeArgs = functionLiteral.params.singleNames.map(definitionName =>
				functionScope[definitionName.name]!.value);
			if (functionLiteral.params.rest) {
				nativeArgs.push(...functionScope[functionLiteral.params.rest.name]!.value);
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

function checkType(typeExpression: TypeExpression | undefined, value: any, state: Scope): { value: any; isError: boolean; } {
	if (!typeExpression) {
		return {
			value: value,
			isError: false
		}
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
	const interpretedExpression = interpreteValueExpression(typeExpression, state)
	switch (typeof interpretedExpression) {
		case 'number':
			return {
				type: 'native',
				pure: true,
				code: (x: any) =>
					x === interpretedExpression,
				params: { singleNames: [{ type: 'name', name: 'x', }] },
				returnType: 'Boolean',
			}

		// TODO string literal, object literal, interface (object mit typeguards)
		// TODO typeCheck typeFunction auf Function: any => boolean
		default:
			return interpretedExpression;
	}
}

function checkNameDefined(name: string, scope: object) {
	if (name in scope) {
		throw new Error(`${name} is already defined`)
	}
}

function referenceNamesToString(referenceName: ReferenceNames): string {
	return referenceName.join('.')
}

function getReturnType(funcionLiteral: FunctionLiteral, scope: Scope): string {
	// TODO checkedTypes benutzen?
	const lastExpression = funcionLiteral.body[funcionLiteral.body.length - 1]
	if (!lastExpression) {
		return 'Empty';
	}
	return 'TODO';
}

//#endregion helper