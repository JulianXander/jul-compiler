import { ParserError, Positioned } from './parser/parser-combinator.js';
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
	typeInfo?: TypeInfo;
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
	| ParseReference
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
export interface ParseExpressionBase extends PositionedExpressionBase {
	/**
	 * Wird vom checker gesetzt.
	 */
	typeInfo?: TypeInfo;
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

export interface ParseReference extends ParseExpressionBase {
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

export interface TypeInfo {
	// symbol?: SymbolDefinition;
	// TODO?
	// filePath: string;
	// TODO?
	// typeExpression?: ParseValueExpression;
	rawType: CompileTimeType;
	/**
	 * rawType mit aufgelösten References, ParameterReferences.
	 */
	dereferencedType: CompileTimeType;
}

export interface CompileTimeDictionary { [key: string]: CompileTimeType; }

export type CompileTimeCollection =
	| CompileTimeType[]
	| CompileTimeDictionary
	;

interface CompileTimeTypeBase {
	/**
	 * Der Name der Definition, wenn der Typ als Wert einer Definition verwendet wird.
	 */
	name?: string;
}

export type CompileTimeType =
	| NeverType
	| AnyType
	| EmptyType
	| BooleanLiteralType
	| IntegerLiteralType
	| FloatLiteralType
	| TextLiteralType
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
	| CompileTimeIntersectionType
	| CompileTimeUnionType
	| CompileTimeComplementType
	| CompileTimeTypeOfType
	| NestedReferenceType
	| ParameterReference
	| ParametersType
	;

export interface NeverType extends CompileTimeTypeBase {
	readonly julType: 'never';
}

export interface AnyType extends CompileTimeTypeBase {
	readonly julType: 'any';
}

//#region Primitive

interface EmptyType extends CompileTimeTypeBase {
	readonly julType: 'empty';
}

interface BooleanLiteralType extends CompileTimeTypeBase {
	julType: 'booleanLiteral';
	value: boolean;
}

interface FloatLiteralType extends CompileTimeTypeBase {
	julType: 'floatLiteral';
	value: number;
}

interface FloatLiteralType extends CompileTimeTypeBase {
	julType: 'floatLiteral';
	value: number;
}

interface IntegerLiteralType extends CompileTimeTypeBase {
	julType: 'integerLiteral';
	value: bigint;
}

export interface TextLiteralType extends CompileTimeTypeBase {
	julType: 'textLiteral';
	value: string;
}

//#endregion Primitive

export interface BooleanType extends CompileTimeTypeBase {
	readonly julType: 'boolean';
}

export interface IntegerType extends CompileTimeTypeBase {
	readonly julType: 'integer';
}

export interface FloatType extends CompileTimeTypeBase {
	readonly julType: 'float';
}

export interface TextType extends CompileTimeTypeBase {
	readonly julType: 'text';
}

export interface DateType extends CompileTimeTypeBase {
	readonly julType: 'date';
}

export interface BlobType extends CompileTimeTypeBase {
	readonly julType: 'blob';
}

interface ErrorType extends CompileTimeTypeBase {
	readonly julType: 'error';
}

export interface TypeType extends CompileTimeTypeBase {
	readonly julType: 'type';
}

export interface CompileTimeComplementType extends CompileTimeTypeBase {
	readonly julType: 'not';
	SourceType: CompileTimeType;
}

export function createCompileTimeComplementType(SourceType: CompileTimeType): CompileTimeComplementType {
	return {
		julType: 'not',
		SourceType: SourceType,
	};
}

export interface CompileTimeGreaterType extends CompileTimeTypeBase {
	readonly julType: 'greater';
	Value: CompileTimeType;
}

export function createCompileTimeGreaterType(Value: CompileTimeType): CompileTimeGreaterType {
	return {
		julType: 'greater',
		Value: Value,
	};
}

export interface CompileTimeDictionaryLiteralType extends CompileTimeTypeBase {
	readonly julType: 'dictionaryLiteral';
	Fields: CompileTimeDictionary;
	expression?: ParseDictionaryTypeLiteral | ParseDictionaryLiteral;
	/**
	 * Leerstring, wenn builtin.
	 */
	filePath?: string;
}

export function createCompileTimeDictionaryLiteralType(
	Fields: CompileTimeDictionary,
	expression?: ParseDictionaryTypeLiteral | ParseDictionaryLiteral,
	filePath?: string,
	name?: string,
): CompileTimeDictionaryLiteralType {
	return {
		julType: 'dictionaryLiteral',
		Fields: Fields,
		expression: expression,
		filePath: filePath,
		name: name,
	};
}

export interface CompileTimeDictionaryType extends CompileTimeTypeBase {
	readonly julType: 'dictionary';
	ElementType: CompileTimeType;
}

export function createCompileTimeDictionaryType(
	ElementType: CompileTimeType,
	name?: string,
): CompileTimeDictionaryType {
	return {
		julType: 'dictionary',
		ElementType: ElementType,
		name: name,
	};
}

export interface CompileTimeFunctionType extends CompileTimeTypeBase {
	readonly julType: 'function';
	ParamsType: CompileTimeType;
	ReturnType: CompileTimeType;
	pure: boolean;
}

export function createCompileTimeFunctionType(
	ParamsType: CompileTimeType,
	ReturnType: CompileTimeType,
	pure: boolean,
	name?: string,
): CompileTimeFunctionType {
	return {
		julType: 'function',
		ParamsType: ParamsType,
		ReturnType: ReturnType,
		pure: pure,
		name: name,
	};
}

export interface CompileTimeIntersectionType extends CompileTimeTypeBase {
	readonly julType: 'and';
	ChoiceTypes: CompileTimeType[];
}

export interface CompileTimeListType extends CompileTimeTypeBase {
	readonly julType: 'list';
	ElementType: CompileTimeType;
}

export function createCompileTimeListType(ElementType: CompileTimeType): CompileTimeListType {
	return {
		julType: 'list',
		ElementType: ElementType,
	};
}

export interface CompileTimeStreamType extends CompileTimeTypeBase {
	readonly julType: 'stream';
	ValueType: CompileTimeType;
}

export function createCompileTimeStreamType(ValueType: CompileTimeType): CompileTimeStreamType {
	return {
		julType: 'stream',
		ValueType: ValueType,
	};
}

export interface CompileTimeTupleType extends CompileTimeTypeBase {
	readonly julType: 'tuple';
	// TODO nonEmpty?
	ElementTypes: CompileTimeType[];
}

export function createCompileTimeTupleType(ElementTypes: CompileTimeType[]): CompileTimeTupleType {
	return {
		julType: 'tuple',
		ElementTypes: ElementTypes,
	};
}

export interface CompileTimeTypeOfType extends CompileTimeTypeBase {
	readonly julType: 'typeOf';
	value: CompileTimeType;
}

export function createCompileTimeTypeOfType(value: CompileTimeType): CompileTimeTypeOfType {
	return {
		julType: 'typeOf',
		value: value,
	};
}

export interface CompileTimeUnionType extends CompileTimeTypeBase {
	readonly julType: 'or';
	ChoiceTypes: CompileTimeType[];
}

export interface NestedReferenceType extends CompileTimeTypeBase {
	readonly julType: 'nestedReference';
	source: CompileTimeType;
	nestedKey: string | number;
}

export function createNestedReference(source: CompileTimeType, nestedKey: string | number): NestedReferenceType {
	return {
		julType: 'nestedReference',
		source: source,
		nestedKey: nestedKey,
	};
}

/**
 * Wird aktuell nur als CompileTimeType benutzt
 */
export interface ParameterReference extends CompileTimeTypeBase {
	readonly julType: 'parameterReference';
	name: string;
	index: number;
	/**
	 * Muss nach dem Erzeugen gesetzt werden.
	 */
	functionRef?: CompileTimeFunctionType;
}

export function createParameterReference(name: string, index: number): ParameterReference {
	return {
		julType: 'parameterReference',
		name: name,
		index: index,
	};
}

/**
 * Wird aktuell nur als CompileTimeType benutzt
 */
export interface ParametersType extends CompileTimeTypeBase {
	readonly julType: 'parameters';
	singleNames: Parameter[];
	rest?: Parameter;
}

export function createParametersType(singleNames: Parameter[], rest?: Parameter): ParametersType {
	return {
		julType: 'parameters',
		singleNames: singleNames,
		rest: rest,
	};
}

export interface Parameter {
	name: string;
	type?: CompileTimeType;
}

//#endregion CompileTimeType