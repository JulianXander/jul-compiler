import { ParserError, Positioned } from './parser/parser-combinator.js';
import { AnyType, BlobType, BooleanType, BuiltInTypeBase, DateType, ErrorType, FloatType, Integer, IntegerType, Primitive, TextType, TypeType } from './runtime.js';
import { Extension, NonEmptyArray } from './util.js';

export interface ParsedFile {
	filePath: string;
	extension: Extension;
	sourceFolder: string;
	unchecked: ParsedExpressions2;
	/**
	 * Wird vom checker gesetzt.
	 */
	checked?: ParsedExpressions2;
	/**
	 * nur für .jul Dateien
	 */
	dependencies?: string[];
}

export interface ParsedExpressions2 extends ParsedExpressions {
	symbols: SymbolTable;
}

export interface ParsedExpressions {
	errors: ParserError[];
	expressions?: ParseExpression[];
}

export interface SymbolTable {
	[symbol: string]: SymbolDefinition;
}

export interface SymbolDefinition extends Positioned {
	definition?: DefinitionExpression;
	description?: string;
	/**
	 * undefined bei unvollständiger definition
	 */
	typeExpression?: ParseValueExpression;
	/**
	 * inferred type aus dem value
	 */
	inferredType?: CompileTimeType;
	dereferencedType?: CompileTimeType;
	//#region FunctionParameter
	functionRef?: CompileTimeFunctionType;
	functionParameterIndex?: number;
	//#endregion FunctionParameter
}

//#region ParseExpression

export type ParseExpression =
	| ParseDestructuringDefinition
	| ParseFieldBase
	| ParseSingleDefinition
	| ParseValueExpression
	;

export type ParseValueExpression =
	| ParseBranching
	| ParseFunctionLiteral
	| ParseFunctionTypeLiteral
	| SimpleExpression
	;

export type SimpleExpression =
	| BracketedExpression
	| NumberLiteral
	| ParseFunctionCall
	| ParseTextLiteral
	| Reference
	| ParseNestedReference
	;

export type DefinitionExpression =
	| ParseDestructuringField
	| ParseFieldBase
	| ParseParameterField
	| ParseSingleDefinition
	| ParseSingleDictionaryField
	| ParseSingleDictionaryTypeField
	;

export type PositionedExpression =
	| Index
	| Name
	| ParseDestructuringField
	| ParseDestructuringFields
	| ParseDictionaryField
	| ParseDictionaryTypeField
	| ParseExpression
	| ParseFieldBase
	| ParseParameterField
	| ParseParameterFields
	;

export type TypedExpression =
	| ParseExpression
	| ParseParameterFields
	| ParseParameterField
	;

export interface PositionedExpressionBase extends Positioned {
	/**
	 * Wird vom parser gesetzt.
	 */
	parent?: PositionedExpression;
}

// TODO bei allen parseExpressions oder nur bei value expressions?
interface ParseExpressionBase extends PositionedExpressionBase {
	/**
	 * Wird vom checker gesetzt.
	 */
	inferredType?: CompileTimeType;
	/**
	 * Wird vom checker gesetzt.
	 * inferredType mit aufgelösten ParamterReferences.
	 */
	dereferencedType?: CompileTimeType;
}

export interface ParseSpreadValueExpression extends PositionedExpressionBase {
	type: 'spread';
	value: ParseValueExpression;
}

export interface ParseSingleDefinition extends ParseExpressionBase {
	type: 'definition';
	description?: string;
	// TODO spread?
	name: Name;
	typeGuard?: ParseValueExpression;
	/**
	 * undefined bei unvollständiger Expression
	 */
	value?: ParseValueExpression;
}

export interface ParseDestructuringDefinition extends ParseExpressionBase {
	type: 'destructuring';
	fields: ParseDestructuringFields;
	/**
	 * undefined bei unvollständiger Expression
	 */
	value?: ParseValueExpression;
}

export interface ParseDestructuringFields extends ParseExpressionBase {
	type: 'destructuringFields';
	fields: ParseDestructuringField[];
	/**
	 * Die Felder
	 */
	symbols: SymbolTable;
}

export interface ParseDestructuringField extends ParseExpressionBase {
	type: 'destructuringField';
	description?: string;
	name: Name;
	typeGuard?: ParseValueExpression;
	source?: Name;
}

//#region Bracketed

export type BracketedExpression =
	| ParseEmptyLiteral
	| ParseUnknownObjectLiteral
	| ParseListLiteral
	| ParseDictionaryLiteral
	| ParseDictionaryTypeLiteral
	| BracketedExpressionBase
	;

export interface ParseEmptyLiteral extends ParseExpressionBase {
	type: 'empty';
}

/**
 * ListLiteral oder DictionaryLiteral (abhängig vom Typ des gespreadeten Werts)
 */
export interface ParseUnknownObjectLiteral extends ParseExpressionBase {
	type: 'object';
	/**
	 * niemals leeres array (stattdessen EmptyLiteral)
	 */
	values: NonEmptyArray<ParseSpreadValueExpression>;
}

export interface ParseListLiteral extends ParseExpressionBase {
	type: 'list';
	/**
	 * niemals leeres array (stattdessen EmptyLiteral)
	 */
	values: NonEmptyArray<ParseListValue>;
}

export type ParseListValue =
	| ParseValueExpression
	| ParseSpreadValueExpression
	;

//#region Dictionary

export interface ParseDictionaryLiteral extends ParseExpressionBase {
	type: 'dictionary';
	/**
	 * niemals leeres array (stattdessen EmptyLiteral)
	 */
	fields: NonEmptyArray<ParseDictionaryField>;
	/**
	 * Die Felder
	 */
	symbols: SymbolTable;
}

export type ParseDictionaryField =
	| ParseSingleDictionaryField
	| ParseSpreadValueExpression
	;

export interface ParseSingleDictionaryField extends PositionedExpressionBase {
	type: 'singleDictionaryField';
	description?: string;
	/**
	 * escapable
	 */
	name: ParseValueExpression | Name;
	typeGuard?: ParseValueExpression;
	/**
	 * undefined bei unvollständiger Expression
	 */
	value?: ParseValueExpression;
}

//#endregion Dictionary

//#region DictionaryType

export interface ParseDictionaryTypeLiteral extends ParseExpressionBase {
	type: 'dictionaryType';
	/**
	 * niemals leeres array (stattdessen EmptyLiteral)
	 */
	fields: NonEmptyArray<ParseDictionaryTypeField>;
	/**
	 * Die Felder
	 */
	symbols: SymbolTable;
}

export type ParseDictionaryTypeField =
	| ParseSingleDictionaryTypeField
	| ParseSpreadValueExpression
	;

export interface ParseSingleDictionaryTypeField extends PositionedExpressionBase {
	type: 'singleDictionaryTypeField';
	description?: string;
	/**
	 * escapable
	 */
	name: ParseValueExpression | Name;
	typeGuard?: ParseValueExpression;
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
	// TODO check FunctionExpression: exclude number, text, object, dictionaryType? oder primitives/types als function auswerten?
	branches: ParseValueExpression[];
}

export interface ParseTextLiteral extends ParseExpressionBase {
	type: 'text';
	language?: string;
	values: (TextToken | ParseValueExpression)[];
}

export interface TextToken {
	type: 'textToken';
	value: string;
}

//#region NumberLiteral

export type NumberLiteral =
	| IntegerLiteral
	| FloatLiteral
	| FractionLiteral
	;

export interface IntegerLiteral extends ParseExpressionBase {
	type: 'integer';
	value: bigint;
}

export interface FloatLiteral extends ParseExpressionBase {
	type: 'float';
	value: number;
}

export interface FractionLiteral extends ParseExpressionBase {
	type: 'fraction';
	numerator: bigint;
	denominator: bigint;
}

//#endregion NumberLiteral

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
	name: ParseValueExpression;
	typeGuard?: ParseValueExpression;
	/**
	 * definition token ' = '
	 */
	definition: boolean;
	/**
	 * source/assignedValue
	 */
	assignedValue?: ParseValueExpression;
}

export interface ParseFunctionCall extends ParseExpressionBase {
	type: 'functionCall';
	/**
	 * Nur bei InfixFunctionCall
	 */
	prefixArgument?: SimpleExpression;
	functionExpression?: SimpleExpression;
	// TODO primitive value direkt als arguments?
	arguments?: BracketedExpression;
}

//#region FunctionLiteral

export interface ParseFunctionLiteral extends ParseExpressionBase {
	type: 'functionLiteral';
	params: SimpleExpression | ParseParameterFields;
	returnType?: ParseValueExpression;
	body: ParseExpression[];
	/**
	 * Die Variablen aus den Parametern sowie dem body.
	 */
	symbols: SymbolTable;
	// TODO impure functions mit !=> ?
	// pure: boolean;
}

export interface ParseParameterFields extends ParseExpressionBase {
	type: 'parameters';
	singleFields: ParseParameterField[];
	rest?: ParseParameterField;
	symbols: SymbolTable;
}

export interface ParseParameterField extends ParseExpressionBase {
	type: 'parameter';
	description?: string;
	name: Name;
	typeGuard?: ParseValueExpression;
	source?: string;
	/**
	 * Wird vom checker gesetzt.
	 */
	inferredTypeFromCall?: CompileTimeType;
}

export interface ParseFunctionTypeLiteral extends ParseExpressionBase {
	type: 'functionTypeLiteral';
	params: SimpleExpression | ParseParameterFields;
	returnType: ParseValueExpression;
	symbols: SymbolTable;
}

//#endregion FunctionLiteral

export interface Reference extends ParseExpressionBase {
	type: 'reference';
	name: Name;
}

export interface ParseNestedReference extends ParseExpressionBase {
	type: 'nestedReference';
	source: ParseValueExpression;
	/**
	 * undefined, bei unvollständiger expression
	 * escapable, bei field reference
	 */
	nestedKey?: Name | ParseTextLiteral | Index;
}

export interface Name extends PositionedExpressionBase {
	type: 'name';
	name: string;
}

export interface Index extends PositionedExpressionBase {
	type: 'index';
	/**
	 * Startet mit 1
	 */
	name: number;
}

//#endregion ParseExpression

//#region CompileTimeType

export interface CompileTimeDictionary { [key: string]: CompileTimeType; }

export type CompileTimeCollection =
	| CompileTimeType[]
	| CompileTimeDictionary
	;

export type CompileTimeType =
	| Primitive
	| CompileTimeCollection
	| BuiltInCompileTimeType
	;

export type BuiltInCompileTimeType =
	| AnyType
	| BooleanType
	| IntegerType
	| FloatType
	| TextType
	| DateType
	| BlobType
	| ErrorType
	| TypeType
	| CompileTimeGreaterType
	| CompileTimeListType
	| CompileTimeTupleType
	| CompileTimeDictionaryType
	| CompileTimeDictionaryLiteralType
	| CompileTimeStreamType
	| CompileTimeFunctionType
	| NestedReference
	| ParameterReference
	| ParametersType
	| CompileTimeIntersectionType
	| CompileTimeUnionType
	| CompileTimeComplementType
	| CompileTimeTypeOfType
	;

export class CompileTimeComplementType extends BuiltInTypeBase {
	constructor(public SourceType: CompileTimeType) { super(); }
	readonly type = 'not';
}

export class CompileTimeGreaterType extends BuiltInTypeBase {
	constructor(public Value: CompileTimeType) { super(); }
	readonly type = 'greater';
}

export class CompileTimeDictionaryLiteralType extends BuiltInTypeBase {
	constructor(public Fields: CompileTimeDictionary) { super(); }
	readonly type = 'dictionaryLiteral';
}

export class CompileTimeDictionaryType extends BuiltInTypeBase {
	constructor(public ElementType: CompileTimeType) { super(); }
	readonly type = 'dictionary';
}

export class CompileTimeFunctionType extends BuiltInTypeBase {
	constructor(
		public ParamsType: CompileTimeType,
		public ReturnType: CompileTimeType,
		public pure: boolean,
	) {
		super();
	}
	readonly type = 'function';
}

export class CompileTimeIntersectionType extends BuiltInTypeBase {
	// TODO flatten nested IntersectionTypes?
	constructor(public ChoiceTypes: CompileTimeType[]) { super(); }
	readonly type = 'and';
}

export class CompileTimeListType extends BuiltInTypeBase {
	constructor(public ElementType: CompileTimeType) { super(); }
	readonly type = 'list';
}

export class CompileTimeStreamType extends BuiltInTypeBase {
	constructor(public ValueType: CompileTimeType) { super(); }
	readonly type = 'stream';
}

export class CompileTimeTupleType extends BuiltInTypeBase {
	constructor(public ElementTypes: CompileTimeType[]) { super(); }
	readonly type = 'tuple';
}

export class CompileTimeTypeOfType extends BuiltInTypeBase {
	constructor(public value: CompileTimeType) { super(); }
	readonly type = 'typeOf';
}

export class CompileTimeUnionType extends BuiltInTypeBase {
	constructor(public ChoiceTypes: CompileTimeType[]) { super(); }
	readonly type = 'or';
}

export class NestedReference extends BuiltInTypeBase {
	constructor(
		public source: CompileTimeType,
		public nestedKey: string | number,
	) { super(); }
	readonly type = 'nestedReference';
}

/**
 * Wird aktuell nur als CompileTimeType benutzt
 */
export class ParameterReference extends BuiltInTypeBase {
	constructor(
		public name: string,
		public index: number,
	) { super(); }
	readonly type = 'parameterReference';
	/**
	 * Muss nach dem Erzeugen gesetzt werden.
	 */
	functionRef?: CompileTimeFunctionType;
}

/**
 * Wird aktuell nur als CompileTimeType benutzt
 */
export class ParametersType extends BuiltInTypeBase {
	constructor(
		public singleNames: Parameter[],
		public rest?: Parameter,
	) {
		super();
	}
	readonly type = 'parameters';
}

export interface Parameter {
	name: string;
	type?: CompileTimeType;
}

export const CompileTimeNonZeroInteger = new CompileTimeIntersectionType([Integer, new CompileTimeComplementType(0n)]);

//#endregion CompileTimeType