import { ParserError } from "./parser-combinator";
import { NonEmptyArray } from './util';

export interface SymbolTable {
	[symbol: string]: SymbolDefinition;
}

export interface SymbolDefinition {
	description?: string;
	type: TypeExpression;
}

export interface ParsedFile {
	errors?: ParserError[];
	expressions?: Expression[];
	symbols: SymbolTable;
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

export type PositionedExpression =
	| Expression
	| DefinitionName
	| DefinitionNames
	| DictionaryValue
	;

export interface Positioned {
	startRowIndex: number;
	startColumnIndex: number;
	endRowIndex: number;
	endColumnIndex: number;
}

export interface StringLiteral extends Positioned {
	type: 'string';
	values: ({
		type: 'stringToken';
		value: string;
	} | ValueExpression)[];
}

export interface NumberLiteral extends Positioned {
	type: 'number';
	value: number;
}

export type ObjectLiteral = EmptyLiteral | ListLiteral | DictionaryLiteral;

export interface EmptyLiteral extends Positioned {
	type: 'empty';
}

export interface ListLiteral extends Positioned {
	type: 'list';
	/**
	 * niemals leeres array (stattdessen EmptyLiteral)
	 */
	values: NonEmptyArray<ValueExpression>;
}

export interface DictionaryLiteral extends Positioned {
	type: 'dictionary';
	/**
	 * niemals leeres array (stattdessen EmptyLiteral)
	 */
	values: NonEmptyArray<DictionaryValue>;
}

export interface DictionaryValue extends Positioned {
	type: 'dictionaryValue';
	name: string;
	typeGuard?: TypeExpression;
	value: ValueExpression;
}

export interface FunctionLiteral extends Positioned {
	type: 'functionLiteral';
	// TODO functionName? für StackTrace
	params: DefinitionNames | TypeExpression;
	body: Expression[];
	symbols: SymbolTable;
	// TODO entfernen?
	pure: boolean;
}

export interface FunctionCall extends Positioned {
	type: 'functionCall';
	// TODO functionReference mit Reference, für position
	functionReference: Reference;
	// TODO primitive value direkt als arguments?
	arguments: ObjectLiteral;
}

export interface Reference extends Positioned {
	type: 'reference';
	names: ReferenceNames;
}

export type ReferenceNames = [string, ...(number | string)[]];

export interface DefinitionNames extends Positioned {
	type: 'definitionNames';
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

export interface DefinitionName extends Positioned {
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

export interface SingleDefinition extends Positioned {
	type: 'definition';
	name: DefinitionName;
	value: ValueExpression;
	typeGuard?: TypeExpression;
	description?: string;
}

export interface DestructuringDefinition extends Positioned {
	type: 'destructuring';
	names: DefinitionNames;
	value: ValueExpression;
}

export interface Branching extends Positioned {
	type: 'branching';
	value: ValueExpression;
	// TODO check FunctionExpression
	branches: ValueExpression[];
}