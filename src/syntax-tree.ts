import { ParserError, Positioned } from "./parser-combinator";
import { NonEmptyArray } from './util';

//#region ParseTree

export interface ParsedFile {
	errors?: ParserError[];
	expressions?: ParseExpression[];
	symbols: SymbolTable;
}

export interface SymbolTable {
	[symbol: string]: SymbolDefinition;
}

export interface SymbolDefinition extends Positioned {
	description?: string;
	type: ParseValueExpression;
}

export type ParseExpression =
	| ParseDestructuringDefinition
	| ParseFieldBase
	| ParseSingleDefinition
	| ParseValueExpression
	;

export type ParseValueExpression =
	| BracketedExpression
	| NumberLiteral
	| ParseBranching
	| ParseFunctionCall
	| ParseFunctionLiteral
	| ParseStringLiteral
	| Reference
	;

export type ParseValueExpressionBase =
	| ParseBranching
	| ParseFunctionLiteral
	| SimpleExpression
	;

export type SimpleExpression =
	| BracketedExpressionBase
	| NumberLiteral
	| ParseFunctionCall
	| ParseStringLiteral
	| Reference
	;

export type PositionedExpression =
	| Index
	| Name
	| ParseDictionaryField
	| ParseExpression
	| ParseFieldBase
	;

export interface ParseSingleDefinition extends Positioned {
	type: 'definition';
	description?: string;
	// TODO spread?
	name: Name;
	typeGuard?: ParseValueExpression;
	value: ParseValueExpression;
	fallback?: ParseValueExpression;
}

export interface ParseDestructuringDefinition extends Positioned {
	type: 'destructuring';
	fields: BracketedExpressionBase;
	value: ParseValueExpression;
}


//#region Bracketed

export type BracketedExpression =
	| ParseEmptyLiteral
	| ParseListLiteral
	| ParseDictionaryLiteral
	| BracketedExpressionBase
	;

export interface ParseEmptyLiteral extends Positioned {
	type: 'empty';
}

export interface ParseListLiteral extends Positioned {
	type: 'list';
	/**
	 * niemals leeres array (stattdessen EmptyLiteral)
	 */
	values: NonEmptyArray<ParseValueExpression>;
}

//#region Dictionary

export interface ParseDictionaryLiteral extends Positioned {
	type: 'dictionary';
	/**
	 * niemals leeres array (stattdessen EmptyLiteral)
	 */
	fields: NonEmptyArray<ParseDictionaryField>;
}

export type ParseDictionaryField =
	| ParseSingleDictionaryField
	| ParseSpreadDictionaryField
	// | ParseFieldBase // TODO ?
	;

export interface ParseSingleDictionaryField extends Positioned {
	type: 'singleDictionaryField';
	name: ParseValueExpressionBase;
	typeGuard?: ParseValueExpression;
	value: ParseValueExpression;
	fallback?: ParseValueExpression;
}

export interface ParseSpreadDictionaryField extends Positioned {
	type: 'spreadDictionaryField';
	value: ParseValueExpression;
}

//#endregion Dictionary

// TODO DictionaryType: Dictionary ohne value, fallback?

export interface BracketedExpressionBase extends Positioned {
	type: 'bracketed';
	fields: ParseFieldBase[];
}

//#endregion Bracketed

export interface ParseBranching extends Positioned {
	type: 'branching';
	value: ParseValueExpression;
	// TODO check FunctionExpression: exclude number, string, object, dictionaryType? oder primitives/types als function auswerten?
	branches: ParseValueExpression[];
}

export interface ParseStringLiteral extends Positioned {
	type: 'string';
	values: (StringToken | ParseValueExpression)[];
}

export interface StringToken {
	type: 'stringToken';
	value: string;
}

export interface NumberLiteral extends Positioned {
	type: 'number';
	value: number;
}

export interface ParseFieldBase extends Positioned {
	type: 'field';
	description?: string;
	// TODO List/Dictionary
	// isList: boolean;
	/**
	 * spread/rest
	 */
	spread: boolean;
	/**
	 * name/single value/definitionNames
	 */
	name: ParseValueExpressionBase;
	typeGuard?: ParseValueExpression;
	/**
	 * source/assignedValue
	 */
	assignedValue?: ParseValueExpression;
	fallback?: ParseValueExpression;
}

export interface ParseFunctionCall extends Positioned {
	type: 'functionCall';
	// TODO functionReference mit Reference, für position
	functionReference: Reference;
	// TODO primitive value direkt als arguments?
	arguments: BracketedExpression;
}

export interface ParseFunctionLiteral extends Positioned {
	type: 'functionLiteral';
	// TODO functionName? für StackTrace
	params: SimpleExpression;
	body: ParseExpression[];
	symbols: SymbolTable;
	// TODO impure functions mit !=> ?
	// pure: boolean;
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

//#endregion ParseTree

//#region CheckedTree

export type CheckedExpression =
	| CheckedSingleDefinition
	| CheckedDestructuringDefinition
	| CheckedValueExpression
	;

export type CheckedValueExpression =
	| CheckedBranching
	| CheckedFunctionCall
	| CheckedFunctionLiteral
	| CheckedStringLiteral
	| DictionaryTypeLiteral
	| NumberLiteral
	| ObjectLiteral
	| Reference
	;

export interface CheckedBranching {
	type: 'branching';
	value: CheckedValueExpression;
	// TODO check FunctionExpression: exclude number, string, object, dictionaryType? oder primitives/types als function auswerten?
	branches: CheckedValueExpression[];
}

export interface CheckedSingleDefinition {
	type: 'definition';
	// TODO spread?
	name: string;
	typeGuard?: CheckedValueExpression;
	value: CheckedValueExpression;
	fallback?: CheckedValueExpression;
}

//#region destructuring

export interface CheckedDestructuringDefinition {
	type: 'destructuring';
	fields: CheckedDestructuringField[];
	value: CheckedValueExpression;
}

export interface CheckedDestructuringField {
	// TODO spread als eigener Typ ohne source, fallback, typeguard?
	spread: boolean;
	name: string;
	typeGuard?: CheckedValueExpression;
	source?: string;
	fallback?: CheckedValueExpression;
}

//#endregion destructuring

export interface CheckedFunctionCall {
	type: 'functionCall';
	// TODO functionReference mit Reference, für position
	functionReference: Reference;
	// TODO primitive value direkt als arguments?
	arguments: ObjectLiteral;
}

//#region FunctionLiteral

export interface CheckedFunctionLiteral {
	type: 'functionLiteral';
	// TODO functionName? für StackTrace
	params: CheckedValueExpression | CheckedParameterFields;
	body: CheckedExpression[];
}

export interface CheckedParameterFields {
	type: 'parameters';
	singleFields: CheckedParameterField[];
	// TODO rest ohne fallback?
	rest?: CheckedParameterField;
}

export interface CheckedParameterField {
	name: string;
	typeGuard?: CheckedValueExpression;
	fallback?: CheckedValueExpression;
}

//#endregion FunctionLiteral

export interface CheckedStringLiteral {
	type: 'string';
	values: (StringToken | CheckedValueExpression)[];
}

//#region Object

export type ObjectLiteral =
	| CheckedEmptyLiteral
	| CheckedListLiteral
	| CheckedDictionaryLiteral
	;

export interface CheckedEmptyLiteral {
	type: 'empty';
}

export interface CheckedListLiteral {
	type: 'list';
	/**
	 * niemals leeres array (stattdessen EmptyLiteral)
	 */
	values: NonEmptyArray<CheckedValueExpression>;
}

export interface CheckedDictionaryLiteral {
	type: 'dictionary';
	/**
	 * niemals leeres array (stattdessen EmptyLiteral)
	 */
	fields: NonEmptyArray<CheckedDictionaryField>;
}

export type CheckedDictionaryField =
	| CheckedSingleDictionaryField
	| CheckedSpreadDictionaryField
	;

export interface CheckedSingleDictionaryField {
	type: 'singleDictionaryField';
	name: string;
	typeGuard?: CheckedValueExpression;
	value: CheckedValueExpression;
	fallback?: CheckedValueExpression;
}

export interface CheckedSpreadDictionaryField {
	type: 'spreadDictionaryField';
	value: CheckedValueExpression;
}

//#endregion Object

export interface DictionaryTypeLiteral {
	type: 'dictionaryType';
	singleFields: TypeField[];
	rest?: TypeField;
}

export interface TypeField {
	name: string;
	typeGuard?: CheckedValueExpression;
}

//#endregion CheckedTree