import { CompilerError, Positioned } from './compiler-errors.js';
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
	errors: CompilerError[];
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
	| ParseBindingExpression
	| ParseDataExpression
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

/**
 * Runde Klammer: eine Bindungsstelle.
 * Wird je nach Folgetoken zu Parameterliste, Destructuring-Ziel oder Argumentliste.
 * Bleibt nur im Fehlerfall unaufgelöst im Baum stehen.
 */
export interface ParseBindingExpression extends ParseExpressionBase {
	type: 'binding';
	fields: ParseFieldBase[];
}

/**
 * Eckige Klammer: ein Datenliteral.
 * Wird zu List, Dictionary, DictionaryType, Empty oder UnknownObject aufgelöst.
 * Bleibt nur im Fehlerfall unaufgelöst im Baum stehen.
 */
export interface ParseDataExpression extends ParseExpressionBase {
	type: 'data';
	fields: ParseFieldBase[];
}

//#endregion Bracketed

export interface ParseBranching extends ParseExpressionBase {
	type: 'branching';
	/** Die Argumentkollektion, gegen die die branches geprüft werden - wie die arguments eines Aufrufs. */
	args?: BracketedExpression;
	/** Nicht auf Funktionen eingeengt: der checker meldet den Rest als branchIsNotFunction. */
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

//#region forEachChild

/**
 * Die einzige Stelle, die weiß, welche Kinder ein Knoten hat. Ruft callback für jedes Kind in
 * Quelltextreihenfolge auf; liefert der callback etwas anderes als undefined, bricht die
 * Aufzählung ab und reicht den Wert durch.
 * Kinder werden einzeln übergeben und nicht als Array, weil die positionsbasierte Suche im
 * language server bei jedem Tastendruck läuft.
 */
export function forEachChild<T>(
	expression: PositionedExpression,
	callback: (child: PositionedExpression) => T | undefined,
): T | undefined {
	switch (expression.type) {
		case 'binding':
		case 'data':
		case 'destructuringFields':
		case 'dictionary':
		case 'dictionaryType':
			return forEachOf(expression.fields, callback);
		case 'branching':
			return visit(expression.args, callback)
				?? forEachOf(expression.branches, callback);
		case 'definition':
			return visit(expression.name, callback)
				?? visit(expression.typeGuard, callback)
				?? visit(expression.value, callback);
		case 'destructuring':
			return visit(expression.fields, callback)
				?? visit(expression.value, callback);
		case 'destructuringField':
			return visit(expression.name, callback)
				?? visit(expression.typeGuard, callback)
				?? visit(expression.source, callback);
		case 'empty':
		case 'float':
		case 'fraction':
		case 'index':
		case 'integer':
		case 'name':
		case 'reference':
			return undefined;
		case 'field':
			return visit(expression.name, callback)
				?? visit(expression.typeGuard, callback)
				?? visit(expression.assignedValue, callback);
		case 'functionCall':
			return visit(expression.prefixArgument, callback)
				?? visit(expression.functionExpression, callback)
				?? visit(expression.arguments, callback);
		case 'functionLiteral':
			return visit(expression.params, callback)
				?? visit(expression.returnType, callback)
				?? forEachOf(expression.body, callback);
		case 'functionTypeLiteral':
			return visit(expression.params, callback)
				?? visit(expression.returnType, callback);
		case 'list':
		case 'object':
			return forEachOf(expression.values, callback);
		case 'nestedReference':
			return visit(expression.source, callback)
				?? visit(expression.nestedKey, callback);
		case 'parameter':
			return visit(expression.name, callback)
				?? visit(expression.typeGuard, callback);
		case 'parameters':
			return forEachOf(expression.singleFields, callback)
				?? visit(expression.rest, callback);
		case 'singleDictionaryField':
			return visit(expression.name, callback)
				?? visit(expression.typeGuard, callback)
				?? visit(expression.value, callback);
		case 'singleDictionaryTypeField':
			return visit(expression.name, callback)
				?? visit(expression.typeGuard, callback);
		case 'spread':
			return visit(expression.value, callback);
		case 'text':
			return forEachOf(
				expression.values.filter((value): value is ParseValueExpression =>
					value.type !== 'textToken'),
				callback);
		default: {
			const assertNever: never = expression;
			throw new Error(`Unexpected expression.type: ${(assertNever as PositionedExpression).type}`);
		}
	}
}

function visit<T>(
	child: PositionedExpression | undefined,
	callback: (child: PositionedExpression) => T | undefined,
): T | undefined {
	return child && callback(child);
}

function forEachOf<T>(
	children: readonly PositionedExpression[],
	callback: (child: PositionedExpression) => T | undefined,
): T | undefined {
	for (let index = 0; index < children.length; index++) {
		const result = callback(children[index]!);
		if (result !== undefined) {
			return result;
		}
	}
	return undefined;
}

//#endregion forEachChild

//#endregion ParseExpression

//#region CompileTimeType

export interface TypeInfo {
	/**
	 * Der Typ mit intakten Platzhaltern (parameterReference, nestedReference).
	 * Für Prüfung und Anzeige stattdessen resolvePlaceholders() aufrufen - das löst die Platzhalter
	 * auf, wirft dabei aber Nicht-Auflösbares auf Any.
	 */
	type: CompileTimeType;
}

export interface CompileTimeDictionary { [key: string]: CompileTimeType; }

export type CompileTimeCollection =
	| CompileTimeType[]
	| CompileTimeDictionary
	;

interface CompileTimeTypeBase {
	/**
	 * Der Name der Definition, unter der der Typ an dieser Stelle geschrieben wurde.
	 * Gilt pro Schreibstelle und wird beim Auflösen verworfen, wenn der Typ ein anderer wird.
	 */
	aliasName?: string;
	/**
	 * Woher die Struktur des Typs stammt. Bleibt über Auflösungen hinweg erhalten und ist die
	 * einzige Brücke vom Typ zurück zu Symbolen, Descriptions und Positionen.
	 */
	declaration?: TypeDeclaration;
	/**
	 * Gecachtes Flag: true wenn dieser Typ oder ein Kind-Typ unaufgelöste Platzhalter enthält.
	 * Wird bei der Typ-Konstruktion berechnet und kann danach mutiert werden.
	 * Optional für inline-erzeugte Typen - der Fallback berechnet es bei Bedarf.
	 */
	isUnresolvedPlaceholder?: boolean;
}

export interface TypeDeclaration {
	expression: ParseDictionaryTypeLiteral | ParseDictionaryLiteral;
	/**
	 * Leerstring, wenn builtin.
	 */
	filePath: string;
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
	| CompileTimeLengthOfType
	| CompileTimeWithElementAtType
	| CompileTimeRangeType
	| CompileTimeTupleOfType
	| CompileTimeConcatType
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

/**
 * Untertyp von allem, erfüllt jede Anforderung. Kein Wert hat diesen Typ; er entsteht z.B. als
 * Ergebnis von unerreichbarem Code oder eines leeren `Or`.
 */
export interface NeverType extends CompileTimeTypeBase {
	readonly julType: 'never';
}

/**
 * Übertyp von allem, stellt keine Anforderung. Jeder Wert erfüllt diesen Typ.
 */
export interface AnyType extends CompileTimeTypeBase {
	readonly julType: 'any';
}

//#region Primitive

/**
 * Eigener Typ, keine leere Kollektion - List/Tuple/Dictionary schließen ihn aus.
 */
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

/**
 * Komplement/Negation von SourceType: erfüllt alles, was SourceType nicht erfüllt. Da sich das
 * nicht abschließend prüfen lässt, ist Not(X) beim Zuweisen wie Any permissiv – ein Fehler
 * entsteht nur, wenn der Wert nachweislich zwingend SourceType ist.
 */
export interface CompileTimeComplementType extends CompileTimeTypeBase {
	readonly julType: 'not';
	SourceType: CompileTimeType;
}

export function createCompileTimeComplementType(SourceType: CompileTimeType): CompileTimeComplementType {
	return {
		julType: 'not',
		SourceType: SourceType,
		isUnresolvedPlaceholder: SourceType.isUnresolvedPlaceholder,
	};
}

/**
 * Menge aller Werte, die größer als Value sind
 * (nur in Kombination mit einem anderen Typ sinnvoll,
 * z.B. And(Integer Greater(0)) für PositiveInteger).
 */
export interface CompileTimeGreaterType extends CompileTimeTypeBase {
	readonly julType: 'greater';
	Value: CompileTimeType;
}

export function createCompileTimeGreaterType(Value: CompileTimeType): CompileTimeGreaterType {
	return {
		julType: 'greater',
		Value: Value,
		isUnresolvedPlaceholder: Value.isUnresolvedPlaceholder,
	};
}

/**
 * Die Anzahl der Elemente von Source, solange Source nicht als Tuple/Empty feststeht (dort
 * faltet getLengthFromType direkt zu einem Literal). Traegt die Quelle weiter, damit ElementAt
 * erkennen kann, wenn ein Index exakt die Laenge derselben Quelle ist - dann ist er nie ausserhalb
 * des Bereichs. Ueberall sonst verhaelt sich lengthOf wie PositiveInteger/NonZeroInteger.
 */
export interface CompileTimeLengthOfType extends CompileTimeTypeBase {
	readonly julType: 'lengthOf';
	Source: CompileTimeType;
}

export function createCompileTimeLengthOfType(Source: CompileTimeType): CompileTimeLengthOfType {
	return {
		julType: 'lengthOf',
		Source: Source,
		isUnresolvedPlaceholder: true,
	};
}

/**
 * Source, aber an Position Index steht Value. Bleibt stehen, solange Source oder Index noch
 * Platzhalter sind - erst mit festem Index laesst sich sagen, welche Position sich aendert.
 * Das Gegenstueck zum lesenden Zugriff (docs/type-level-sequence-algebra.md).
 */
export interface CompileTimeWithElementAtType extends CompileTimeTypeBase {
	readonly julType: 'withElementAt';
	Source: CompileTimeType;
	Index: CompileTimeType;
	Value: CompileTimeType;
}

export function createCompileTimeWithElementAtType(
	Source: CompileTimeType,
	Index: CompileTimeType,
	Value: CompileTimeType,
): CompileTimeWithElementAtType {
	return {
		julType: 'withElementAt',
		Source: Source,
		Index: Index,
		Value: Value,
		isUnresolvedPlaceholder: true,
	};
}

/**
 * Die Positionen Start bis End, beide inklusive, 1-basiert. End Empty heisst "bis zum Ende".
 * Nur als Schluessel eines Zugriffs sinnvoll: dort wird daraus die Teilfolge der Quelle.
 */
export interface CompileTimeRangeType extends CompileTimeTypeBase {
	readonly julType: 'range';
	Start: CompileTimeType;
	End: CompileTimeType;
}

export function createCompileTimeRangeType(
	Start: CompileTimeType,
	End: CompileTimeType,
): CompileTimeRangeType {
	return {
		julType: 'range',
		Start: Start,
		End: End,
		isUnresolvedPlaceholder: Start.isUnresolvedPlaceholder || End.isUnresolvedPlaceholder,
	};
}

/**
 * Count Positionen, jede vom Typ ElementType. Steht Count als Literal fest, wird daraus ein
 * Tuple dieser Laenge, sonst eine List.
 */
export interface CompileTimeTupleOfType extends CompileTimeTypeBase {
	readonly julType: 'tupleOf';
	Count: CompileTimeType;
	ElementType: CompileTimeType;
}

export function createCompileTimeTupleOfType(
	Count: CompileTimeType,
	ElementType: CompileTimeType,
): CompileTimeTupleOfType {
	return {
		julType: 'tupleOf',
		Count: Count,
		ElementType: ElementType,
		isUnresolvedPlaceholder: true,
	};
}

/**
 * Die Aneinanderreihung mehrerer Quellen. Sind alle Quellen konkrete Tupel, wird das Ergebnis
 * ein Tuple ihrer Aneinanderreihung. Enthält eine Quelle eine List, bleibt nur List(Union der
 * Elementtypen). Empty bleibt immer Empty.
 */
export interface CompileTimeConcatType extends CompileTimeTypeBase {
	readonly julType: 'concat';
	Sources: CompileTimeType[];
}

export function createCompileTimeConcatType(
	Sources: CompileTimeType[],
): CompileTimeConcatType {
	return {
		julType: 'concat',
		Sources: Sources,
		isUnresolvedPlaceholder: Sources.some(s => s.isUnresolvedPlaceholder),
	};
}

export interface CompileTimeDictionaryLiteralType extends CompileTimeTypeBase {
	readonly julType: 'dictionaryLiteral';
	Fields: CompileTimeDictionary;
	/**
	 * true: Fields ist die vollständige Feldliste, ein fehlendes Feld gibt es nachweisbar nicht
	 * (z.B. ein geschriebenes Dictionary-Literal).
	 * false: Fields nennt nur einen bewiesenen Fakt, über andere Felder ist nichts bekannt
	 * (z.B. ein Fakt aus der Verengung eines branches). Ein fehlendes Feld ist dann unbekannt,
	 * nicht Empty.
	 */
	readonly complete: boolean;
}

export function createCompileTimeDictionaryLiteralType(
	Fields: CompileTimeDictionary,
	complete: boolean,
	declaration?: TypeDeclaration,
	aliasName?: string,
): CompileTimeDictionaryLiteralType {
	const isUnresolvedPlaceholder = Object.values(Fields).some(type => type.isUnresolvedPlaceholder);
	return {
		julType: 'dictionaryLiteral',
		Fields: Fields,
		complete: complete,
		declaration: declaration,
		aliasName: aliasName,
		isUnresolvedPlaceholder: isUnresolvedPlaceholder,
	};
}

export interface CompileTimeDictionaryType extends CompileTimeTypeBase {
	readonly julType: 'dictionary';
	ElementType: CompileTimeType;
}

export function createCompileTimeDictionaryType(
	ElementType: CompileTimeType,
	aliasName?: string,
): CompileTimeDictionaryType {
	return {
		julType: 'dictionary',
		ElementType: ElementType,
		aliasName: aliasName,
		isUnresolvedPlaceholder: ElementType.isUnresolvedPlaceholder,
	};
}

export interface CompileTimeFunctionType extends CompileTimeTypeBase {
	readonly julType: 'function';
	ParamsType: CompileTimeType;
	ReturnType: CompileTimeType;
	pure: boolean;
	predicate?: PredicateFacts;
}

/**
 * Was aus dem Ergebnis eines Praedikats folgt, je Richtung getrennt - beide Richtungen sind
 * verschiedene Mengen, keine Umkehrung voneinander (Typed Racket: φ⁺ | φ⁻).
 */
export interface PredicateFacts {
	/** true ⟹ der Wert liegt hierin. Obermenge, nur zum Schneiden im true-Zweig. */
	ifTrue: CompileTimeType;
	/** Werte hierin liefern nachweislich true. Untermenge, nur zum Abziehen im false-Zweig. */
	excludedIfFalse?: CompileTimeType;
}

export function createCompileTimeFunctionType(
	ParamsType: CompileTimeType,
	ReturnType: CompileTimeType,
	pure: boolean,
	aliasName?: string,
): CompileTimeFunctionType {
	return {
		julType: 'function',
		ParamsType: ParamsType,
		ReturnType: ReturnType,
		pure: pure,
		aliasName: aliasName,
		isUnresolvedPlaceholder: ParamsType.isUnresolvedPlaceholder || ReturnType.isUnresolvedPlaceholder,
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
		isUnresolvedPlaceholder: ElementType.isUnresolvedPlaceholder,
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
		isUnresolvedPlaceholder: ValueType.isUnresolvedPlaceholder,
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
		isUnresolvedPlaceholder: ElementTypes.some(t => t.isUnresolvedPlaceholder),
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
		isUnresolvedPlaceholder: value.isUnresolvedPlaceholder,
	};
}

export interface CompileTimeUnionType extends CompileTimeTypeBase {
	readonly julType: 'or';
	ChoiceTypes: CompileTimeType[];
}

export interface NestedReferenceType extends CompileTimeTypeBase {
	readonly julType: 'nestedReference';
	source: CompileTimeType;
	/**
	 * Literal, solange der Schlüssel geschrieben steht (a/2, a/name). Ein Typ, wenn er erst aus
	 * einem Argument folgt (ElementAt) und daher noch aufgelöst werden muss.
	 */
	nestedKey: string | number | CompileTimeType;
}

export function createNestedReference(source: CompileTimeType, nestedKey: string | number | CompileTimeType): NestedReferenceType {
	const isUnresolvedPlaceholder = source.isUnresolvedPlaceholder || (typeof nestedKey === 'object' && nestedKey.isUnresolvedPlaceholder);
	return {
		julType: 'nestedReference',
		source: source,
		nestedKey: nestedKey,
		isUnresolvedPlaceholder: isUnresolvedPlaceholder,
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
		isUnresolvedPlaceholder: true,
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
	const hasUnresolvedPlaceholder = singleNames.some(p => p.type && p.type.isUnresolvedPlaceholder) || (rest && rest.type && rest.type.isUnresolvedPlaceholder);
	return {
		julType: 'parameters',
		singleNames: singleNames,
		rest: rest,
		isUnresolvedPlaceholder: hasUnresolvedPlaceholder,
	};
}

export interface Parameter {
	name: string;
	type?: CompileTimeType;
}

//#endregion CompileTimeType

//#region Blatt-Typ Factories - für O(1) Zugriff ohne Rekursion

/**
 * Gecachte Instanzen für häufig verwendete Blatt-Typen - alle haben isUnresolvedPlaceholder: false
 */
export const builtinAny: AnyType = { julType: 'any', isUnresolvedPlaceholder: false };
export const builtinNever: NeverType = { julType: 'never', isUnresolvedPlaceholder: false };
export const builtinEmpty: EmptyType = { julType: 'empty', isUnresolvedPlaceholder: false };
export const builtinBoolean: BooleanType = { julType: 'boolean', isUnresolvedPlaceholder: false };
export const builtinInteger: IntegerType = { julType: 'integer', isUnresolvedPlaceholder: false };
export const builtinFloat: FloatType = { julType: 'float', isUnresolvedPlaceholder: false };
export const builtinText: TextType = { julType: 'text', isUnresolvedPlaceholder: false };
export const builtinDate: DateType = { julType: 'date', isUnresolvedPlaceholder: false };
export const builtinBlob: BlobType = { julType: 'blob', isUnresolvedPlaceholder: false };
export const builtinType: TypeType = { julType: 'type', isUnresolvedPlaceholder: false };

export function createBooleanLiteral(value: boolean): BooleanLiteralType {
	return { julType: 'booleanLiteral', value, isUnresolvedPlaceholder: false };
}

export function createIntegerLiteral(value: bigint): IntegerLiteralType {
	return { julType: 'integerLiteral', value, isUnresolvedPlaceholder: false };
}

export function createFloatLiteral(value: number): FloatLiteralType {
	return { julType: 'floatLiteral', value, isUnresolvedPlaceholder: false };
}

export function createTextLiteral(value: string): TextLiteralType {
	return { julType: 'textLiteral', value, isUnresolvedPlaceholder: false };
}

//#endregion Blatt-Typ Factories

/**
 * Fallback: Stellt sicher, dass ein Typ das isUnresolvedPlaceholder-Flag hat.
 * Wird verwendet, wenn ein Typ inline erzeugt wurde, ohne einen Konstruktor zu verwenden.
 * Gibt den Typ unverändert zurück, wenn das Flag bereits existiert.
 */
export function ensureTypeHasUnresolvedFlag(type: CompileTimeType): CompileTimeType {
	if (type.isUnresolvedPlaceholder === undefined) {
		// Fallback: Für inline-erzeugte Typen ohne Flag - markiere als false
		// (da diese meist Blatt-Typen oder vollständig aufgelöst sind)
		(type as any).isUnresolvedPlaceholder = false;
	}
	return type;
}