import { ParserError, Positioned } from './parser-combinator';
import { Type } from './runtime';
import { NonEmptyArray } from './util';

//#region ParseTree

export interface ParsedFile {
	errors: ParserError[];
	expressions?: ParseExpression[];
	symbols: SymbolTable;
}

export interface SymbolTable {
	[symbol: string]: SymbolDefinition;
}

export interface SymbolDefinition extends Positioned {
	description?: string;
	typeExpression: ParseValueExpression;
	// TODO inferred type aus dem value? oder normalize typeguard?
	normalizedType?: Type;
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
	| ParseFunctionTypeLiteral
	| ParseStringLiteral
	| Reference
	;

export type ParseValueExpressionBase =
	| ParseBranching
	| ParseFunctionLiteral
	| ParseFunctionTypeLiteral
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
	| ParseDictionaryTypeField
	| ParseExpression
	| ParseFieldBase
	| ParseParameterFields
	| ParseParameterField
	;

export type TypedExpression =
	| ParseExpression
	| ParseParameterFields
	| ParseParameterField
	;

// TODO beil allen parseExpression oder nur bei value expressions?
interface ParseExpressionBase extends Positioned {
	inferredType?: Type;
}

export interface ParseSingleDefinition extends ParseExpressionBase {
	type: 'definition';
	description?: string;
	// TODO spread?
	name: Name;
	typeGuard?: ParseValueExpression;
	normalizedTypeGuard?: Type;
	value: ParseValueExpression;
	fallback?: ParseValueExpression;
	inferredType?: Type;
}

export interface ParseDestructuringDefinition extends ParseExpressionBase {
	type: 'destructuring';
	fields: BracketedExpressionBase;
	value: ParseValueExpression;
}

//#region Bracketed

export type BracketedExpression =
	| ParseEmptyLiteral
	| ParseListLiteral
	| ParseDictionaryLiteral
	| ParseDictionaryTypeLiteral
	| BracketedExpressionBase
	;

export interface ParseEmptyLiteral extends ParseExpressionBase {
	type: 'empty';
}

export interface ParseListLiteral extends ParseExpressionBase {
	type: 'list';
	/**
	 * niemals leeres array (stattdessen EmptyLiteral)
	 * TODO list spread
	 */
	values: NonEmptyArray<ParseValueExpression>;
}

//#region Dictionary

export interface ParseDictionaryLiteral extends ParseExpressionBase {
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

//#region DictionaryType

export interface ParseDictionaryTypeLiteral extends ParseExpressionBase {
	type: 'dictionaryType';
	/**
	 * niemals leeres array (stattdessen EmptyLiteral)
	 */
	fields: NonEmptyArray<ParseDictionaryTypeField>;
}

export type ParseDictionaryTypeField =
	| ParseSingleDictionaryTypeField
	| ParseSpreadDictionaryTypeField
	;

export interface ParseSingleDictionaryTypeField extends Positioned {
	type: 'singleDictionaryTypeField';
	name: ParseValueExpressionBase;
	typeGuard?: ParseValueExpression;
}

export interface ParseSpreadDictionaryTypeField extends Positioned {
	type: 'spreadDictionaryTypeField';
	value: ParseValueExpression;
}

//#endregion DictionaryType

export interface BracketedExpressionBase extends ParseExpressionBase {
	type: 'bracketed';
	fields: ParseFieldBase[];
}

//#endregion Bracketed

export interface ParseBranching extends ParseExpressionBase {
	type: 'branching';
	value: ParseValueExpression;
	// TODO check FunctionExpression: exclude number, string, object, dictionaryType? oder primitives/types als function auswerten?
	branches: ParseValueExpression[];
}

export interface ParseStringLiteral extends ParseExpressionBase {
	type: 'string';
	values: (StringToken | ParseValueExpression)[];
}

export interface StringToken {
	type: 'stringToken';
	value: string;
}

export interface NumberLiteral extends ParseExpressionBase {
	type: 'number';
	value: number;
}

export interface ParseFieldBase extends ParseExpressionBase {
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

export interface ParseFunctionCall extends ParseExpressionBase {
	type: 'functionCall';
	// TODO functionReference mit Reference, für position
	functionReference: Reference;
	// TODO primitive value direkt als arguments?
	arguments: BracketedExpression;
}

//#region FunctionLiteral

export interface ParseFunctionLiteral extends ParseExpressionBase {
	type: 'functionLiteral';
	// TODO functionName? für StackTrace
	params: SimpleExpression | ParseParameterFields;
	returnType?: ParseValueExpression;
	body: ParseExpression[];
	symbols: SymbolTable;
	// TODO impure functions mit !=> ?
	// pure: boolean;
}

export interface ParseParameterFields extends ParseExpressionBase {
	type: 'parameters';
	singleFields: ParseParameterField[];
	// TODO rest ohne fallback?
	rest?: ParseParameterField;
}

export interface ParseParameterField extends ParseExpressionBase {
	type: 'parameter';
	name: Name;
	typeGuard?: ParseValueExpression;
	fallback?: ParseValueExpression;
}

export interface ParseFunctionTypeLiteral extends ParseExpressionBase {
	type: 'functionTypeLiteral';
	params: BracketedExpressionBase | ParseParameterFields;
	returnType: ParseValueExpression;
	symbols: SymbolTable;
}

//#endregion FunctionLiteral

export interface Reference extends ParseExpressionBase {
	type: 'reference';
	path: ReferencePath;
}

export type ReferencePath = [Name, ...(Name | Index)[]];

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
	| CheckedDictionaryTypeLiteral
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

//#region Dictionary

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

//#endregion Dictionary

//#endregion Object

//#region DictionaryType

export interface CheckedDictionaryTypeLiteral {
	type: 'dictionaryType';
	/**
	 * niemals leeres array (stattdessen EmptyLiteral)
	 */
	fields: NonEmptyArray<CheckedDictionaryTypeField>;
}

export type CheckedDictionaryTypeField =
	| CheckedSingleDictionaryTypeField
	| CheckedSpreadDictionaryTypeField
	;

export interface CheckedSingleDictionaryTypeField {
	type: 'singleDictionaryTypeField';
	name: string;
	typeGuard?: CheckedValueExpression;
}

export interface CheckedSpreadDictionaryTypeField {
	type: 'spreadDictionaryTypeField';
	value: CheckedValueExpression;
}

//#endregion DictionaryType

//#endregion CheckedTree