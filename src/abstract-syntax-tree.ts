import { ParserError } from "./parser-combinator";

//#region util

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

export interface AbstractSyntaxTree {
	parsed?: Expression[];
	errors?: ParserError[];
}

export type Expression =
	| SingleDefinition
	| DestructuringDefinition
	| ValueExpression
	;

export type ValueExpression =
	| Branching
	| NumberLiteral
	| StringLiteral
	| FunctionLiteral
	| ObjectLiteral
	| FunctionCall
	| Reference
	| NativeFunction
	| NativeValue
	;

export type TypeExpression = ValueExpression; // TODO function any=>boolean/type literal

export interface StringLiteral {
	type: 'string';
	values: ({
		type: 'stringToken';
		value: String;
	} | ValueExpression)[];
}

export interface NumberLiteral {
	type: 'number';
	value: number;
}

export type ObjectLiteral = EmptyLiteral | ListLiteral | DictionaryLiteral;

export interface EmptyLiteral {
	type: 'empty';
}

export interface ListLiteral {
	type: 'list';
	/**
	 * niemals leeres array (stattdessen EmptyObject)
	 * TODO check beim parsen und interpreten
	 */
	values: ValueExpression[];
}

export interface DictionaryLiteral {
	type: 'dictionary';
	/**
	 * niemals leeres array (stattdessen EmptyObject)
	 * TODO check beim parsen und interpreten
	 */
	values: {
		name: string;
		typeGuard?: TypeExpression;
		value: ValueExpression;
	}[];
}

export interface FunctionLiteral {
	type: 'functionLiteral';
	// TODO functionName?
	params: DefinitionNames;
	body: Expression[];
	pure: boolean;
}

export interface FunctionCall {
	type: 'functionCall';
	functionReference: ReferenceNames;
	params: ObjectLiteral;
}

export type ReferenceNames = [string, ...(number | string)[]];

export interface Reference {
	type: 'reference';
	names: ReferenceNames;
}

export interface DefinitionNames {
	singleNames: DefinitionName[];
	rest?: {
		name: string;
		/**
		 * Generic List/Dictionary Type
		 */
		typeGuard?: TypeExpression;
		// TODO List/Dictionary
		// isList: boolean;
	};
}

export interface DefinitionName {
	type: 'name';
	name: string;
	/**
	 * Wenn vorhanden, dann ist name ein Alias
	 */
	source?: string;
	typeGuard?: TypeExpression;
	fallback?: ValueExpression;
}

// interface ObjectDereference{
// 	type: 'objectDereference';
// 	object
// 	nullsafe: boolean;
// }

export interface SingleDefinition {
	type: 'definition';
	name: string;
	value: ValueExpression;
	typeGuard?: TypeExpression;
}

export interface DestructuringDefinition {
	type: 'destructuring';
	names: DefinitionNames;
	value: ValueExpression;
}

export interface Branching {
	type: 'branching';
	value: ValueExpression;
	// TODO check FunctionExpression
	branches: ValueExpression[];
}

//#region interpreter

export interface NativeFunction {
	type: 'native';
	params: DefinitionNames;
	code: Function;
	pure: boolean;
	returnType: string;
}

export interface NativeValue {
	type: 'value';
	value: InterpretedValue;
}

export type InterpretedValue =
	| null
	| boolean
	| string
	| number
	| FunctionLiteral
	| NativeFunction
	| Stream<InterpretedValue>
	| InterpretedValue[]
	| { [name: string]: InterpretedValue }
	| Error
	;

export type Listener<T> = (value: T) => void;

export class Stream<T> {
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

//#endregion interpreter