import { ParserError } from "./parser-combinator";

//#region util

export type NonEmptyArray<T> = [T, ...T[]];

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
	;

export type TypeExpression = ValueExpression; // TODO function any=>boolean/type literal

export interface StringLiteral {
	type: 'string';
	values: ({
		type: 'stringToken';
		value: string;
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
	 * niemals leeres array (stattdessen EmptyLiteral)
	 */
	values: NonEmptyArray<ValueExpression>;
}

export interface DictionaryLiteral {
	type: 'dictionary';
	/**
	 * niemals leeres array (stattdessen EmptyLiteral)
	 */
	values: NonEmptyArray<DictionaryValue>;
}

export interface DictionaryValue {
	name: string;
	typeGuard?: TypeExpression;
	value: ValueExpression;
}

export interface FunctionLiteral {
	type: 'functionLiteral';
	// TODO functionName? für StackTrace
	params: DefinitionNames | TypeExpression;
	body: Expression[];
	// TODO entfernen?
	pure: boolean;
}

export interface FunctionCall {
	type: 'functionCall';
	functionReference: ReferenceNames;
	// TODO primitive value direkt als params?
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
	// TODO description
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
	// TODO description
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