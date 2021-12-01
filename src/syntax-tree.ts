import { ParserError, Positioned } from "./parser-combinator";
import { NonEmptyArray } from './util';

export interface ParsedFile {
	errors?: ParserError[];
	expressions?: Expression[];
	symbols: SymbolTable;
}

export interface SymbolTable {
	[symbol: string]: SymbolDefinition;
}

export interface SymbolDefinition extends Positioned {
	description?: string;
	type: ValueExpression;
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
	| DictionaryTypeLiteral
	| FunctionCall
	| Reference
	;

export type PositionedExpression =
	| Expression
	| DictionaryValue
	| Field
	| Index
	| Name
	;

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
	name: Name;
	typeGuard?: ValueExpression;
	value: ValueExpression;
	fallback?: ValueExpression;
}

export interface FunctionLiteral extends Positioned {
	type: 'functionLiteral';
	// TODO functionName? für StackTrace
	params: ValueExpression;
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

export type ReferenceNames = [Name, ...(Name | Index)[]];

export interface Name extends Positioned {
	type: 'name';
	name: string;
}

export interface Index extends Positioned {
	type: 'index';
	name: number;
}

export interface DictionaryTypeLiteral extends Positioned {
	type: 'dictionaryType';
	singleFields: Field[];
	rest?: Field;
}

export interface Field extends Positioned {
	type: 'field';
	description?: string;
	// TODO List/Dictionary
	// isList: boolean;
	isRest: boolean;
	name: Name;
	typeGuard?: ValueExpression;
	source?: Name;
	fallback?: ValueExpression;
}

export interface SingleDefinition extends Positioned {
	type: 'definition';
	description?: string;
	name: Name;
	typeGuard?: ValueExpression;
	value: ValueExpression;
	fallback?: ValueExpression;
}

export interface DestructuringDefinition extends Positioned {
	type: 'destructuring';
	fields: DictionaryTypeLiteral;
	value: ValueExpression;
}

export interface Branching extends Positioned {
	type: 'branching';
	value: ValueExpression;
	// TODO check FunctionExpression: exclude number, string, object, dictionaryType? oder primitives/types als function auswerten?
	branches: ValueExpression[];
}