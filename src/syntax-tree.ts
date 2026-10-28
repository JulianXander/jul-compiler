import { CompilerError, Positioned } from './compiler-errors.js';
import type { JsonValue } from './runtime/runtime.js';
import { Extension, NonEmptyArray } from './util.js';

export interface ParsedFile {
	filePath: string;
	extension: Extension;
	sourceFolder: string;
	unchecked: ParsedExpressions2;
	/**
	 * Zeilen des Quelltexts, nur bei .jul gezählt, sonst 0.
	 */
	lineCount: number;
	/**
	 * Wird vom checker gesetzt.
	 */
	checked?: ParsedExpressions2;
	/**
	 * nur für .jul Dateien
	 */
	dependencies?: ImportedDependency[];
	/**
	 * Die Quelle ist größer als maxTypedFileSize (project-loader.ts): Der Importeur bekommt Any
	 * statt des Typs. Die Datei selbst wird trotzdem geladen, damit der Emitter sie hat.
	 */
	untyped?: boolean;
	/**
	 * Nur bei einer untypisierten .json: der geparste Wert statt eines Syntaxbaums. Der Emitter
	 * erzeugt das JS direkt daraus (jsonValueToJs).
	 */
	jsonValue?: JsonValue;
}

export interface ImportedDependency {
	fullPath: string;
	/**
	 * Das Pfad-Textliteral im import - dort meldet der Loader, wenn die Datei fehlt.
	 */
	source: Positioned;
}

export interface ParsedExpressions2 extends ParsedExpressions {
	symbols: SymbolTable;
}

export interface ParsedExpressions {
	errors: CompilerError[];
	expressions?: ParseExpression[];
	/**
	 * Nur bei .jul: die Kommentare `#ignore JUL<nr>`, angewendet am Ende von checkTypes.
	 */
	ignoreComments?: IgnoreComment[];
	/**
	 * Nur bei .jul: die Zeilen des Quelltexts.
	 */
	lineCount?: number;
}

/**
 * `#ignore JUL<nr> erklärung`: unterdrückt Warnungen mit diesem Code, die in der nächsten
 * Zeile beginnen, die weder leer noch ein Kommentar ist.
 */
export interface IgnoreComment extends Positioned {
	/**
	 * undefined, wenn kein Code der Form JUL<nr> dasteht.
	 */
	code: number | undefined;
	/**
	 * undefined, wenn nach dem Kommentar keine Zeile mit Code mehr kommt.
	 */
	targetRowIndex: number | undefined;
}

export interface SymbolTable {
	[symbol: string]: SymbolDefinition;
}

/**
 * Ohne Prototyp, sonst findet eine Abfrage mit einem Namen wie toString oder constructor
 * Eigenschaften von Object.prototype statt eines Symbols.
 */
export function createSymbolTable(): SymbolTable {
	return Object.create(null);
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
	/**
	 * Wird vom checker gesetzt, sobald eine Referenz außerhalb der eigenen Definition das Symbol
	 * findet. Gilt nur für den Checklauf, der den Baum erzeugt hat: checked entsteht dafür jedes
	 * Mal frisch.
	 */
	isUsed?: true;
	//#region FunctionParameter
	functionRef?: FunctionIdentity;
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
	| ParseTypeBranching
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
	/**
	 * Der Typ, den die Stelle verlangt, an der der Ausdruck steht (Typguard, Parameter,
	 * Rückgabetyp, Feld oder Element eines solchen). Mit den Argumenten des Aufrufs instanziiert,
	 * aber nicht über Deklarationen aufgelöst. undefined, wenn die Stelle nichts verlangt.
	 * Eigenes Feld statt Teil von TypeInfo, weil TypeInfo-Objekte zwischen Ausdrücken und Symbolen
	 * geteilt werden. Wird vom checker gesetzt.
	 */
	expectedType?: CompileTimeType;
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
	/**
	 * `b?: X`: das Feld darf im Wert fehlen.
	 */
	optional?: boolean;
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

/**
 * `:?`: wählt den Zweig nicht nach einem Wert, sondern danach, ob die Operanden als Typ Teilmenge
 * des Kopfs sind. Eigener Knoten, damit Narrowing und Prädikate von `?` hier nie greifen.
 */
export interface ParseTypeBranching extends ParseExpressionBase {
	type: 'typeBranching';
	/** Die Operanden, als Kollektion wie die args von `?`. */
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
	 * `b?: X`, nur im Dictionary-Typ erlaubt
	 */
	optional?: boolean;
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
	/**
	 * Vom Checker gesetzt: der Typ der aufgerufenen Funktion, verengt auf diesen Aufruf.
	 * Parametertypen, die auf ein Argument verweisen (`TypeOf(stream$)/ValueType`), sind gegen die
	 * Argumente aufgelöst, ebenso der Rückgabetyp. Der typeInfo der functionExpression bleibt
	 * dagegen der Typ des Werts: dieselbe Funktion, unabhängig vom Aufruf.
	 */
	calledFunctionType?: CompileTimeFunctionType;
	/**
	 * Vom Checker gesetzt, wenn die Argumente ein Dictionary sind: die Parameternamen des
	 * aufgerufenen Funktionstyps in deklarierter Reihenfolge (source ?? name). Nicht gesetzt bei
	 * Rest-Parameter oder unbekannter Signatur. Der Emitter schreibt damit benannte Argumente als
	 * positionalen Aufruf: Die Reihenfolge der Namen hat der Checker schon geprüft.
	 */
	calledParameterNames?: string[];
}

//#region FunctionLiteral

/** Der geschriebene Pfeil bzw. die daraus folgende Purity-Aussage. */
export type Purity =
	| 'unknown'  // :>
	| 'pure'     // ->
	| 'impure';  // ~>

/**
 * Purity am Typ: zusätzlich der bedingte Fall, den kein Pfeil direkt schreibt - rein, sofern die
 * übergebenen Funktionsargumente rein sind. Entsteht an der äußersten Signatur eines
 * nativeFunction-Aufrufs mit :> und aus der Rumpf-Inferenz, wenn ein Rumpf nur deshalb
 * unentscheidbar ist, weil er eigene funktionswertige Parameter aufruft.
 */
export type TypePurity = Purity | 'pureIfArgsPure';

export interface ParseFunctionLiteral extends ParseExpressionBase {
	type: 'functionLiteral';
	params: SimpleExpression | ParseParameterFields;
	returnType?: ParseValueExpression;
	body: ParseExpression[];
	/**
	 * Die Variablen aus den Parametern sowie dem body.
	 */
	symbols: SymbolTable;
	/**
	 * Der geschriebene Pfeil. Fehlt bei Funktionen ohne Rückgabetyp ((a) => a)
	 * und bei aus TypeScript importierten Funktionen.
	 */
	arrow?: Purity;
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
	source?: Name;
}

export interface ParseFunctionTypeLiteral extends ParseExpressionBase {
	type: 'functionTypeLiteral';
	params: SimpleExpression | ParseParameterFields;
	returnType: ParseValueExpression;
	symbols: SymbolTable;
	arrow?: Purity;
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
		case 'typeBranching':
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

/**
 * Ein Feld eines Dictionary-Literal-Typs. optional: das Feld darf im Wert fehlen (`b?: X`), der Schlüssel
 * ist dann nicht vorhanden. Ein Feld ohne optional ist immer als Schlüssel da, auch mit Empty.
 */
export interface CompileTimeField {
	readonly type: CompileTimeType;
	readonly optional: boolean;
}

export interface CompileTimeFields { [key: string]: CompileTimeField; }

/**
 * Lauter Pflichtfelder aus Namen und Typen.
 */
export function toRequiredFields(fieldTypes: CompileTimeDictionary): CompileTimeFields {
	const fields: CompileTimeFields = {};
	for (const name in fieldTypes) {
		fields[name] = { type: fieldTypes[name]!, optional: false };
	}
	return fields;
}

/**
 * Nur die Typen der Felder, ohne das Optional-Kennzeichen.
 */
/**
 * Dieselben Felder mit neuen Typen, das Optional-Kennzeichen bleibt.
 */
export function mapFieldTypes(fields: CompileTimeFields, map: (type: CompileTimeType, name: string) => CompileTimeType): CompileTimeFields {
	const mapped: CompileTimeFields = {};
	for (const name in fields) {
		const field = fields[name]!;
		mapped[name] = { type: map(field.type, name), optional: field.optional };
	}
	return mapped;
}

export function toFieldTypes(fields: CompileTimeFields): CompileTimeDictionary {
	const fieldTypes: CompileTimeDictionary = {};
	for (const name in fields) {
		fieldTypes[name] = fields[name]!.type;
	}
	return fieldTypes;
}

/**
 * Nur ein eigenes Feld, damit ein Name wie constructor nicht über Object.prototype gefunden wird.
 */
export function getOwnField(fields: CompileTimeDictionary, name: string): CompileTimeType | undefined {
	return Object.hasOwn(fields, name) ? fields[name] : undefined;
}

/**
 * Nur ein eigenes Feld eines Dictionary-Literal-Typs, siehe getOwnField.
 */
export function getOwnLiteralField(fields: CompileTimeFields, name: string): CompileTimeField | undefined {
	return Object.hasOwn(fields, name) ? fields[name] : undefined;
}

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
	 * Gecachtes Ergebnis von isDeferredType: wartet dieser Typ als Ganzes noch auf den Aufrufort,
	 * ist er also noch nicht vergleichbar, übersetzbar oder normalisierbar? Das ist NICHT "enthält
	 * irgendwo einen Platzhalter": dictionaryLiteral, parameters und lengthOf setzen es bewusst auf
	 * false (als Ganzes verwendbar, auch mit offenen Feldern), ein alias erbt es nur aus seinen
	 * Argumenten. Ob eine Ersetzung per argumentContext etwas ändern würde, beantwortet
	 * hasArgumentSubstitution in type-algebra.ts, nicht dieses Flag.
	 * Pflichtfeld, damit der Compiler jede Konstruktionsstelle erzwingt - wer es vergisst, bekäme
	 * sonst still `undefined` und damit "verwendbar".
	 */
	isDeferred: boolean;
	/**
	 * Eindeutige Nummer des Objekts, vergeben bei der Erzeugung (siehe internType). Strukturell
	 * gleiche Typen sind dasselbe Objekt und haben dieselbe Nummer, damit steht sie für den Typ
	 * als Schlüssel von Caches und Interning.
	 */
	readonly id: number;
}

export interface TypeDeclaration {
	expression: ParseDictionaryTypeLiteral | ParseDictionaryLiteral;
	/**
	 * Leerstring, wenn builtin.
	 */
	filePath: string;
}

//#region Interning

/**
 * Strukturell gleiche Typen sind dasselbe Objekt: Wer einen Typ baut, bekommt einen vorhandenen
 * mit denselben Bestandteilen zurück. Damit greift die Prüfung auf Identität (===) überall,
 * ohne den Typbaum zu durchlaufen, und die Nummer (id) taugt als Schlüssel für Caches.
 * Zum Bestandteil zählt alles, was den Typ von einem anderen unterscheidet, auch Aliasname und
 * Herkunft (declaration): zwei Typen, die sich in der Anzeige unterscheiden, bleiben zwei Objekte.
 * Nicht interniert werden Typen mit eigener Identität: Funktionstypen (FunctionIdentity) und
 * ParameterReference, die nach dem Erzeugen ihre Funktion bekommt.
 * Korrektheit hängt nirgends an der Identität. Die Tabelle wird bei zu vielen Einträgen geleert
 * (ein Language Server läuft lange), danach entstehen gleiche Typen als neue Objekte, und
 * typeEquals entscheidet weiter strukturell.
 */
const maxInternedTypes = 500_000;
const internedTypes = new Map<string, CompileTimeType>();
const dictionaryLiterals = new Map<number, DictionaryLiteralEntry[]>();
/** Kleine Nummern für Feld- und Aliasnamen, damit der Hash keine Strings durchlaufen muss. */
const nameIds = new Map<string, number>();

function getNameId(name: string): number {
	let id = nameIds.get(name);
	if (id === undefined) {
		id = nameIds.size + 1;
		nameIds.set(name, id);
	}
	return id;
}
let nextTypeId = 1;

export function createTypeId(): number {
	return nextTypeId++;
}

function internType<T extends CompileTimeType>(key: string, create: (id: number) => T): T {
	const existing = internedTypes.get(key);
	if (existing) {
		return existing as T;
	}
	if (internedTypes.size >= maxInternedTypes) {
		internedTypes.clear();
	}
	const type = create(nextTypeId++);
	internedTypes.set(key, type);
	return type;
}

/**
 * Leert die Tabellen, damit sie nicht über die Prüfung hinaus wachsen: Ein Typ hält über sein
 * Symbol den Syntaxbaum seiner Datei, ein Language Server prüft ständig neu. Gleiche Typen aus
 * früheren Prüfungen bleiben gültig, sind aber nicht mehr dasselbe Objekt wie neu gebaute -
 * typeEquals entscheidet dann strukturell.
 */
export function clearInternedTypes(): void {
	internedTypes.clear();
	dictionaryLiterals.clear();
	nameIds.clear();
	integerLiterals.clear();
	textLiterals.clear();
	// Danach entsteht für denselben Pfad ein neuer Term. Alte Typen verlieren damit nur den
	// Längenbeweis, nie die Soundness.
	pathLengthTerms.clear();
}

const objectIds = new WeakMap<object, number>();

/** Nummer eines Objekts, das selbst kein Typ ist (Herkunft, Symbol), für den Schlüssel eines Typs. */
function getObjectId(value: object | undefined): number {
	if (!value) {
		return 0;
	}
	let id = objectIds.get(value);
	if (id === undefined) {
		id = nextTypeId++;
		objectIds.set(value, id);
	}
	return id;
}

function getIds(types: readonly CompileTimeType[]): string {
	let key = '';
	for (let index = 0; index < types.length; index++) {
		key += (index ? ',' : '') + types[index]!.id;
	}
	return key;
}

//#endregion Interning

export type CompileTimeType =
	| NeverType
	| AnyType
	| InvalidType
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
	| CompileTimeBoundType
	| CompileTimeLengthOfType
	| CompileTimeWithElementAtType
	| CompileTimeConditionalType
	| CompileTimeIndexRangeType
	| CompileTimeMapElementsType
	| CompileTimeConcatType
	| CompileTimeAddType
	| CompileTimeSubtractType
	| CompileTimeListType
	| CompileTimeTupleType
	| CompileTimeDictionaryType
	| CompileTimeDictionaryLiteralType
	| CompileTimeStreamType
	| CompileTimeFunctionType
	| CompileTimeIntersectionType
	| CompileTimeUnionType
	| CompileTimeComplementType
	| CompileTimePredicateType
	| CompileTimeTypeOfType
	| NestedReferenceType
	| ParameterReference
	| CompileTimeValueAsType
	| CompileTimeAliasType
	| ParametersType
	;

/**
 * Ein Typ, der garantiert kein Alias mehr ist.
 * Funktionen, die einen Typ strukturell untersuchen (Felder, Elemente, Choices, Überlappung),
 * deklarieren diesen Typ statt CompileTimeType - dann erzwingt der Compiler an jeder Aufrufstelle
 * ein resolveAlias, statt dass ein übersehener Alias still in einen default-Zweig fällt.
 * Vorbild: mypys ProperType.
 */
export type ResolvedType = Exclude<CompileTimeType, CompileTimeAliasType>;

/**
 * Eine offene Rechnung: die Anwendung einer Typoperation, die sich nicht ausrechnen ließ, meist weil
 * ein Operand noch auf den Aufrufort wartet. Am Aufruf werden die Operanden eingesetzt, und die
 * Operation wird neu ausgerechnet. Die Relationen behandeln alle Varianten in einem einzigen Fall,
 * siehe docs/offene-rechnungen.md.
 */
export type CompileTimeOperationType =
	| NestedReferenceType
	| CompileTimeAddType
	| CompileTimeSubtractType
	| CompileTimeConcatType
	| CompileTimeMapElementsType
	| CompileTimeWithElementAtType
	| CompileTimeConditionalType
	| CompileTimeValueAsType
	;

export function isOperationType(type: CompileTimeType): type is CompileTimeOperationType {
	switch (type.julType) {
		case 'nestedReference':
		case 'add':
		case 'subtract':
		case 'concat':
		case 'mapElements':
		case 'withElementAt':
		case 'conditional':
		case 'valueAsType':
			return true;
		default:
			return false;
	}
}

/**
 * Die Typen, aus denen eine offene Rechnung ausgerechnet wird. Bei einem bedingten Typ folgen auf die
 * Operanden Kopf und Ergebnis jedes Zweigs.
 */
export function getOperands(type: CompileTimeOperationType): CompileTimeType[] {
	switch (type.julType) {
		case 'nestedReference':
			return typeof type.nestedKey === 'object'
				? [type.source, type.nestedKey]
				: [type.source];
		case 'add':
			return [type.ArgsType];
		case 'subtract':
			return [type.MinuendType, type.SubtrahendType];
		case 'concat':
			return type.Sources;
		case 'mapElements':
			return [type.Source, type.Callback];
		case 'withElementAt':
			return [type.Source, type.Index, type.Value];
		case 'conditional':
			return [
				...type.Operands,
				...type.Branches.flatMap(branch => [branch.Head, branch.Result]),
			];
		case 'valueAsType':
			return [type.Source];
		default: {
			const assertNever: never = type;
			throw new Error('Unexpected julType: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

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

/**
 * Ein Ausdruck, für den schon ein Fehler gemeldet ist. Anders als Any ist der Typ nicht unbekannt,
 * sondern ungültig: Er ist in jeder Zuweisung zulässig und macht jeden Typ, in dem er vorkommt,
 * ebenfalls ungültig, damit der Fehler keine Folgefehler erzeugt. Der Nutzer kann ihn nicht
 * schreiben.
 */
export interface InvalidType extends CompileTimeTypeBase {
	readonly julType: 'invalid';
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

export interface ErrorType extends CompileTimeTypeBase {
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
	return internType(`not:${SourceType.id}`, id => ({
		julType: 'not',
		SourceType: SourceType,
		isDeferred: SourceType.isDeferred,
		id: id,
	}));
}

/**
 * Ein Funktionswert in Typ-Position: die Menge der Werte, für die die Funktion true liefert.
 * Nicht zu verwechseln mit dem Funktionstyp, der die Menge der Funktionen mit einer Signatur
 * ist. Was die Funktion für einen Wert liefert, lässt sich im Allgemeinen nicht vorhersagen,
 * bekannt sind nur die beiden Schranken UpperBound ⊇ Prädikat ⊇ LowerBound.
 * Ist nicht gleich seiner Obermenge und wird deshalb nicht wie ein Alias aufgelöst: isEven
 * ist nicht Integer.
 */
export interface CompileTimePredicateType extends CompileTimeTypeBase {
	readonly julType: 'predicate';
	FunctionType: CompileTimeFunctionType;
	/** Werte, für die die Funktion true liefern kann: erster Parametertyp und predicate.ifTrue. */
	UpperBound: CompileTimeType;
	/** Werte, für die die Funktion nachweislich true liefert: predicate.excludedIfFalse. */
	LowerBound: CompileTimeType;
	/** Für die Anzeige: der Name, unter dem das Prädikat in Typ-Position geschrieben wurde. */
	name?: string;
}

export function createCompileTimePredicateType(
	FunctionType: CompileTimeFunctionType,
	UpperBound: CompileTimeType,
	LowerBound: CompileTimeType,
	name: string | undefined,
): CompileTimePredicateType {
	return internType(`pred:${FunctionType.id},${UpperBound.id},${LowerBound.id},${name ?? ''}`, id => ({
		julType: 'predicate',
		FunctionType: FunctionType,
		UpperBound: UpperBound,
		LowerBound: LowerBound,
		name: name,
		isDeferred: FunctionType.isDeferred,
		id: id,
	}));
}

/**
 * Menge aller Zahlen einer Familie, die größer bzw. kleiner als Value sind, beide strikt.
 * Entsteht aus GreaterInteger, LessInteger usw. Family steht im Namen und wird nicht aus Value
 * abgeleitet: bei GreaterInteger(count) ist count ein beliebiger Integer.
 * Was Relation und Family bedeuten, werten nur die Bereichssicht (getIntegerRange) und getTypeFamily
 * aus, Vergleich und Ausgabe reichen sie nur durch. Sonst behandelt eine vergessene Unterscheidung
 * LessInteger still wie GreaterInteger.
 */
export interface CompileTimeBoundType extends CompileTimeTypeBase {
	readonly julType: 'bound';
	Relation: 'greater' | 'less';
	Family: 'integer' | 'float';
	Value: CompileTimeType;
}

export function createCompileTimeBoundType(
	Relation: CompileTimeBoundType['Relation'],
	Family: CompileTimeBoundType['Family'],
	Value: CompileTimeType,
): CompileTimeBoundType {
	return internType(`bound:${Relation},${Family},${Value.id}`, id => ({
		julType: 'bound',
		Relation: Relation,
		Family: Family,
		Value: Value,
		isDeferred: Value.isDeferred,
		id: id,
	}));
}

/**
 * Die Anzahl der Elemente von Source, solange Source nicht als Tuple/Empty feststeht (dort
 * faltet getLengthFromType direkt zu einem Literal). Trägt die Quelle weiter, damit ElementAt
 * erkennen kann, wenn ein Index exakt die Länge derselben Quelle ist - dann ist er nie außerhalb
 * des Bereichs. Überall sonst verhält sich lengthOf wie PositiveInteger/NonZeroInteger.
 */
export interface CompileTimeLengthOfType extends CompileTimeTypeBase {
	readonly julType: 'lengthOf';
	Source: CompileTimeType;
	/**
	 * Ein fester Abstand zur Länge: LengthOf(Source) + Offset, etwa -1 aus length(values).subtract(1)
	 * (docs/backlog/laengen-terme.md, Schritt 3).
	 */
	Offset: bigint;
}

export function createCompileTimeLengthOfType(Source: CompileTimeType, Offset = 0n): CompileTimeLengthOfType {
	return internType(Offset ? `len:${Source.id}:${Offset}` : `len:${Source.id}`, id => ({
		julType: 'lengthOf',
		Source: Source,
		Offset: Offset,
		// Die Länge selbst wartet nicht: sie ist immer ein Integer, egal wie offen die Quelle noch
		// ist. Wer die Quelle meint, prüft sie ausdrücklich.
		isDeferred: false,
		id: id,
	}));
}

/**
 * Source, aber an Position Index steht Value. Bleibt stehen, solange Source oder Index noch
 * Platzhalter sind - erst mit festem Index lässt sich sagen, welche Position sich ändert.
 * Das Gegenstück zum lesenden Zugriff (docs/type-level-sequence-algebra.md).
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
	return internType(`wea:${Source.id},${Index.id},${Value.id}`, id => ({
		julType: 'withElementAt',
		Source: Source,
		Index: Index,
		Value: Value,
		isDeferred: true,
		id: id,
	}));
}

/**
 * Bedingter Typ `:?(Operanden)`: die Union der Ergebnisse der Zweige, deren Kopf die Kollektion
 * der Operanden trifft. Entsteht nur, solange ein Operand noch Platzhalter enthält - sonst wird
 * sofort ausgewertet (createConditionalType im Checker). Die Operanden sind Wertemengen, keine
 * Typwerte, genauso Kopf und Ergebnis jedes Zweigs.
 */
export interface CompileTimeConditionalType extends CompileTimeTypeBase {
	readonly julType: 'conditional';
	Operands: CompileTimeType[];
	Branches: ConditionalTypeBranch[];
}

export interface ConditionalTypeBranch {
	Head: CompileTimeType;
	Result: CompileTimeType;
}

export function createCompileTimeConditionalType(
	Operands: CompileTimeType[],
	Branches: ConditionalTypeBranch[],
): CompileTimeConditionalType {
	const branchKey = Branches.map(branch => `${branch.Head.id}>${branch.Result.id}`).join(';');
	return internType(`cond:${getIds(Operands)}|${branchKey}`, id => ({
		julType: 'conditional',
		Operands: Operands,
		Branches: Branches,
		isDeferred: true,
		id: id,
	}));
}

/**
 * Die Positionen Start bis End, beide inklusive, 1-basiert. End Empty heißt "bis zum Ende".
 * Nur als Schlüssel eines Zugriffs sinnvoll: dort wird daraus die Teilfolge der Quelle.
 */
export interface CompileTimeIndexRangeType extends CompileTimeTypeBase {
	readonly julType: 'indexRange';
	Start: CompileTimeType;
	End: CompileTimeType;
}

export function createCompileTimeIndexRangeType(
	Start: CompileTimeType,
	End: CompileTimeType,
): CompileTimeIndexRangeType {
	return internType(`range:${Start.id},${End.id}`, id => ({
		julType: 'indexRange',
		Start: Start,
		End: End,
		isDeferred: Start.isDeferred || End.isDeferred,
		id: id,
	}));
}

/**
 * Source, jede Position abgebildet durch Callback: bei einem Tuple der Rückgabetyp des Callbacks
 * je Position, mit dem Element und seinem Index als Argumenten. Bleibt stehen, solange Source oder
 * Callback noch nicht feststehen.
 */
export interface CompileTimeMapElementsType extends CompileTimeTypeBase {
	readonly julType: 'mapElements';
	Source: CompileTimeType;
	Callback: CompileTimeType;
}

export function createCompileTimeMapElementsType(
	Source: CompileTimeType,
	Callback: CompileTimeType,
): CompileTimeMapElementsType {
	return internType(`map:${Source.id},${Callback.id}`, id => ({
		julType: 'mapElements',
		Source: Source,
		Callback: Callback,
		isDeferred: true,
		id: id,
	}));
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
	return internType(`concat:${getIds(Sources)}`, id => ({
		julType: 'concat',
		Sources: Sources,
		isDeferred: Sources.some(s => s.isDeferred),
		id: id,
	}));
}

/**
 * Die möglichen Summen der Integer-Argumente ArgsType (Tuple oder List). Bleibt nur stehen,
 * solange ArgsType noch Platzhalter enthält (siehe addFromTypes im Checker).
 */
export interface CompileTimeAddType extends CompileTimeTypeBase {
	readonly julType: 'add';
	ArgsType: CompileTimeType;
}

export function createCompileTimeAddType(ArgsType: CompileTimeType): CompileTimeAddType {
	return internType(`add:${ArgsType.id}`, id => ({
		julType: 'add',
		ArgsType: ArgsType,
		isDeferred: true,
		id: id,
	}));
}

/**
 * Die möglichen Differenzen der Integer MinuendType und SubtrahendType. Bleibt nur stehen,
 * solange einer von beiden noch Platzhalter enthält (siehe subtractFromTypes im Checker).
 */
export interface CompileTimeSubtractType extends CompileTimeTypeBase {
	readonly julType: 'subtract';
	MinuendType: CompileTimeType;
	SubtrahendType: CompileTimeType;
}

export function createCompileTimeSubtractType(
	MinuendType: CompileTimeType,
	SubtrahendType: CompileTimeType,
): CompileTimeSubtractType {
	return internType(`sub:${MinuendType.id},${SubtrahendType.id}`, id => ({
		julType: 'subtract',
		MinuendType: MinuendType,
		SubtrahendType: SubtrahendType,
		isDeferred: true,
		id: id,
	}));
}

export interface CompileTimeDictionaryLiteralType extends CompileTimeTypeBase {
	readonly julType: 'dictionaryLiteral';
	Fields: CompileTimeFields;
	/**
	 * Name und Typ der Felder ohne das Optional-Kennzeichen, beim Erzeugen aus Fields abgeleitet. Für
	 * Stellen, die nur Typen lesen. Wer Felder kopiert oder mischt, braucht Fields, sonst geht das
	 * Kennzeichen verloren.
	 */
	readonly FieldTypes: CompileTimeDictionary;
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
	Fields: CompileTimeFields,
	complete: boolean,
	declaration?: TypeDeclaration,
	aliasName?: string,
): CompileTimeDictionaryLiteralType {
	// Ein Hash aus den Ids statt eines Schlüssel-Strings: Große Dictionaries (Spielzustand, Daten aus
	// JSON) hätten bei jeder Erzeugung einen langen String gebaut und gehasht.
	let hash = (complete ? 1 : 2) + Math.imul(getObjectId(declaration), 0x9e3779b1);
	if (aliasName !== undefined) {
		hash = Math.imul(hash ^ getNameId(aliasName), 0x85ebca6b);
	}
	let fieldCount = 0;
	for (const name in Fields) {
		hash = Math.imul(hash ^ getNameId(name), 0x85ebca6b);
		const field = Fields[name]!;
		hash = Math.imul(hash ^ (field.optional ? ~field.type.id : field.type.id), 0xc2b2ae35);
		hash ^= hash >>> 15;
		fieldCount++;
	}
	const candidates = dictionaryLiterals.get(hash);
	if (candidates) {
		for (const candidate of candidates) {
			if (isSameDictionaryLiteral(candidate, Fields, fieldCount, complete, declaration, aliasName)) {
				return candidate.type;
			}
		}
	}
	if (dictionaryLiterals.size >= maxInternedTypes) {
		dictionaryLiterals.clear();
	}
	const type: CompileTimeDictionaryLiteralType = {
		julType: 'dictionaryLiteral',
		Fields: Fields,
		FieldTypes: toFieldTypes(Fields),
		complete: complete,
		declaration: declaration,
		aliasName: aliasName,
		// Felder zählen nicht mit: ein Dictionary ist als Ganzes zuweisbar, auch wenn einzelne
		// Feldtypen noch offen sind.
		isDeferred: false,
		id: nextTypeId++,
	};
	const entry: DictionaryLiteralEntry = { type: type, fieldNames: Object.keys(Fields) };
	if (candidates) {
		candidates.push(entry);
	}
	else {
		dictionaryLiterals.set(hash, [entry]);
	}
	return type;
}

interface DictionaryLiteralEntry {
	type: CompileTimeDictionaryLiteralType;
	/** Die Reihenfolge der Felder gehört zum Typ (Anzeige, Ausgabe), der Vergleich prüft sie mit. */
	fieldNames: string[];
}

/** Treffer gleichen Hashs sind nicht zwingend gleich: Felder, Reihenfolge und Merkmale prüfen. */
function isSameDictionaryLiteral(
	entry: DictionaryLiteralEntry,
	Fields: CompileTimeFields,
	fieldCount: number,
	complete: boolean,
	declaration: TypeDeclaration | undefined,
	aliasName: string | undefined,
): boolean {
	const { type, fieldNames } = entry;
	if (type.complete !== complete
		|| type.declaration !== declaration
		|| type.aliasName !== aliasName
		|| fieldNames.length !== fieldCount) {
		return false;
	}
	let index = 0;
	for (const name in Fields) {
		if (fieldNames[index++] !== name
			|| type.Fields[name]!.type !== Fields[name]!.type
			|| type.Fields[name]!.optional !== Fields[name]!.optional) {
			return false;
		}
	}
	return true;
}

export interface CompileTimeDictionaryType extends CompileTimeTypeBase {
	readonly julType: 'dictionary';
	ElementType: CompileTimeType;
}

export function createCompileTimeDictionaryType(
	ElementType: CompileTimeType,
	aliasName?: string,
): CompileTimeDictionaryType {
	return internType(`dict:${ElementType.id},${aliasName === undefined ? '-' : aliasName.length + ':' + aliasName}`, id => ({
		julType: 'dictionary',
		ElementType: ElementType,
		aliasName: aliasName,
		isDeferred: ElementType.isDeferred,
		id: id,
	}));
}

/**
 * Identität einer Funktion, die vor dem Funktionstyp existiert: parameterReference und Parameter-Symbole
 * zeigen darauf statt auf den Funktionstyp, der erst nach dem Rumpf angelegt wird. Trägt nur, was der
 * Rumpf über die Funktion lesen darf.
 */
export interface FunctionIdentity {
	/** Marke, damit ein Funktionstyp nicht versehentlich als Identität durchgeht. */
	readonly isFunctionIdentity: true;
	ParamsType: CompileTimeType;
	/**
	 * Die ParamsType steht fest. Beim Prüfen eines Funktionsliterals ist sie bis nach den Parametern
	 * noch ein Platzhalter: Was in dieser Zeit aus den Parameterverweisen gelesen wird, ist
	 * vorläufig und darf nicht gemerkt werden (siehe resultContext).
	 */
	sealed: boolean;
}

export function createFunctionIdentity(ParamsType: CompileTimeType, sealed = true): FunctionIdentity {
	return { isFunctionIdentity: true, ParamsType: ParamsType, sealed: sealed };
}

export interface CompileTimeFunctionType extends CompileTimeTypeBase {
	readonly julType: 'function';
	readonly identity: FunctionIdentity;
	readonly ParamsType: CompileTimeType;
	readonly ReturnType: CompileTimeType;
	readonly purity: TypePurity;
	readonly predicate?: PredicateFacts;
	/**
	 * Nur bei einer nativeFunction-Signatur mit Is(...) als Rückgabetyp. Getrennt von predicate, weil der
	 * Typ Platzhalter auf die eigenen Parameter enthält: Nur die Herleitung in getPredicateFacts setzt
	 * die Argumente eines Aufrufs ein, PredicateIfTrue würde sie gegen den falschen Aufruf auflösen.
	 */
	readonly contract?: PredicateContract;
	/**
	 * Nur bei Funktionsliteralen aus .jul-Dateien gesetzt (siehe 'functionLiteral' im Checker).
	 * Rückverweis für constant folding: von hier aus wird bei Bedarf emittiert und ausgewertet.
	 */
	readonly literal?: ParseFunctionLiteral;
	/**
	 * Nur gesetzt, wenn literal gesetzt ist: der Rumpf enthält kein nativeFunction-/nativeValue-
	 * Literal (die Sicherheitsgrenze, siehe containsNativeLiteral im Checker) und stammt nicht aus
	 * einer .ts/.js-Datei. Sagt allein noch nichts über die freien Referenzen des Rumpfs - die
	 * prüft der Auswerter je Aufrufstelle, weil sie von der jeweiligen Umgebung abhängen
	 * (constant-folding.ts, buildEnvironment).
	 */
	readonly foldable?: boolean;
	/**
	 * Nur gesetzt, wenn literal in einer anderen Funktion steht und ein Aufruf dieser Funktion mit
	 * konstanten Argumenten den Funktionstyp geliefert hat: woran die Parameter der umgebenden
	 * Funktionen gebunden sind. Ohne das wäre divisibleBy(5) nicht von divisibleBy(3) zu
	 * unterscheiden und nicht faltbar, denn beide teilen den deklarierten Rückgabetyp.
	 */
	readonly boundArguments?: BoundArguments;
}

export interface BoundArguments {
	/** JS-Werte je Parametername, wie typeToConstantValue sie liefert. */
	values: { [name: string]: unknown; };
	/** Der Aufruf für die Anzeige, z.B. divisibleBy(5). */
	display: string;
}

/**
 * Was aus dem Ergebnis eines Prädikats folgt, je Richtung getrennt - beide Richtungen sind
 * verschiedene Mengen, keine Umkehrung voneinander (Typed Racket: φ⁺ | φ⁻).
 */
export interface PredicateFacts {
	/** true ⟹ der Wert liegt hierin. Obermenge, nur zum Schneiden im true-Zweig. */
	ifTrue: CompileTimeType;
	/** Werte hierin liefern nachweislich true. Untermenge, nur zum Abziehen im false-Zweig. */
	excludedIfFalse?: CompileTimeType;
}

/**
 * Was ein natives Builtin über einen seiner Parameter zusichert: true heißt, der Wert liegt in type,
 * false, dass er nicht darin liegt. Wird nicht gegen die Implementierung geprüft.
 */
export interface PredicateContract {
	parameterIndex: number;
	type: CompileTimeType;
}

/** Was ein Funktionstyp über seinen Wert festhält, nicht über seine Signatur. */
export type FunctionTypeFacts = Pick<CompileTimeFunctionType, 'predicate' | 'contract' | 'literal' | 'foldable' | 'boundArguments'>;

export interface FunctionTypeExtras extends FunctionTypeFacts {
	/** Ohne Angabe bekommt der Funktionstyp eine neue Identität. */
	identity?: FunctionIdentity;
}

/** Die Fakten von functionType für einen Neubau, bei dem sich die Signatur ändert. */
export function getFunctionTypeFacts(functionType: CompileTimeFunctionType): FunctionTypeFacts {
	return {
		predicate: functionType.predicate,
		contract: functionType.contract,
		literal: functionType.literal,
		foldable: functionType.foldable,
		boundArguments: functionType.boundArguments,
	};
}

/**
 * Alles, was den Funktionstyp ausmacht, wird hier gesetzt: er ist danach unveränderlich. Nur gesetzte
 * Fakten werden übernommen, damit die Objekte ohne sie nicht um leere Eigenschaften wachsen.
 */
export function createCompileTimeFunctionType(
	ParamsType: CompileTimeType,
	ReturnType: CompileTimeType,
	purity: TypePurity,
	aliasName?: string,
	extras?: FunctionTypeExtras,
): CompileTimeFunctionType {
	const functionType: Mutable<CompileTimeFunctionType> = {
		julType: 'function',
		identity: extras?.identity ?? createFunctionIdentity(ParamsType),
		ParamsType: ParamsType,
		ReturnType: ReturnType,
		purity: purity,
		aliasName: aliasName,
		isDeferred: ParamsType.isDeferred || ReturnType.isDeferred,
		id: nextTypeId++,
	};
	if (extras?.predicate) {
		functionType.predicate = extras.predicate;
	}
	if (extras?.contract) {
		functionType.contract = extras.contract;
	}
	if (extras?.literal) {
		functionType.literal = extras.literal;
	}
	if (extras?.foldable !== undefined) {
		functionType.foldable = extras.foldable;
	}
	if (extras?.boundArguments) {
		functionType.boundArguments = extras.boundArguments;
	}
	return functionType;
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

export interface CompileTimeIntersectionType extends CompileTimeTypeBase {
	readonly julType: 'and';
	ChoiceTypes: CompileTimeType[];
}

export function createCompileTimeIntersectionType(ChoiceTypes: CompileTimeType[]): CompileTimeIntersectionType {
	return internType(`and:${getIds(ChoiceTypes)}`, id => ({
		julType: 'and',
		ChoiceTypes: ChoiceTypes,
		isDeferred: ChoiceTypes.some(t => t.isDeferred),
		id: id,
	}));
}

export interface CompileTimeListType extends CompileTimeTypeBase {
	readonly julType: 'list';
	ElementType: CompileTimeType;
	/**
	 * Die Länge genau dieses Werts (docs/backlog/laengen-terme.md). Nur ein Index, der über
	 * dieselbe Länge gebildet ist, beweist eine Position. Fehlt sie, ist über die Länge nichts
	 * bekannt.
	 */
	Length: LengthTerm | undefined;
}

export function createCompileTimeListType(ElementType: CompileTimeType, Length?: LengthTerm): CompileTimeListType {
	return internType(Length ? `list:${ElementType.id}:${Length.id}` : `list:${ElementType.id}`, id => ({
		julType: 'list',
		ElementType: ElementType,
		Length: Length,
		isDeferred: ElementType.isDeferred,
		id: id,
	}));
}

/**
 * Bezeichnet die Länge eines bestimmten Listenwerts: über den Pfad einer Bindung (Symbol und
 * Feldschlüssel, unveränderlich, also immer derselbe Wert) oder frisch für einen einzelnen Ausdruck.
 * Gleich sind zwei Terme nur als dasselbe Objekt.
 */
export interface LengthTerm {
	readonly id: number;
	/** Nur zur Anzeige und Fehlersuche. */
	readonly name: string;
}

let nextLengthTermId = 1;
const pathLengthTerms = new Map<string, LengthTerm>();

/** Die Länge des Werts, den Symbol und Feldschlüssel bezeichnen. */
export function getPathLengthTerm(symbol: object, keys: (string | number)[], name: string): LengthTerm {
	const symbolId = getObjectId(symbol);
	const key = keys.length
		? `${symbolId}/${keys.join('/')}`
		: `${symbolId}`;
	const existing = pathLengthTerms.get(key);
	if (existing) {
		return existing;
	}
	const term: LengthTerm = { id: nextLengthTermId++, name: name };
	pathLengthTerms.set(key, term);
	return term;
}

/** Eine Länge, die nur dieser eine Ausdruck hat. */
export function createFreshLengthTerm(name: string): LengthTerm {
	return { id: nextLengthTermId++, name: name };
}

export interface CompileTimeStreamType extends CompileTimeTypeBase {
	readonly julType: 'stream';
	ValueType: CompileTimeType;
	/**
	 * Geschrieben als FiniteStream(ValueType): Der Stream endet, der Empfänger muss ihn nicht
	 * beenden. Ohne das Merkmal sagt der Typ über das Ende nichts zu. Zur Laufzeit nicht prüfbar.
	 */
	finite: boolean;
}

export function createCompileTimeStreamType(ValueType: CompileTimeType, finite: boolean): CompileTimeStreamType {
	return internType(`stream:${ValueType.id},${finite ? 1 : 0}`, id => ({
		julType: 'stream',
		ValueType: ValueType,
		finite: finite,
		isDeferred: ValueType.isDeferred,
		id: id,
	}));
}

export interface CompileTimeTupleType extends CompileTimeTypeBase {
	readonly julType: 'tuple';
	// TODO nonEmpty?
	ElementTypes: CompileTimeType[];
}

export function createCompileTimeTupleType(ElementTypes: CompileTimeType[]): CompileTimeTupleType {
	return internType(`tuple:${getIds(ElementTypes)}`, id => ({
		julType: 'tuple',
		ElementTypes: ElementTypes,
		isDeferred: ElementTypes.some(t => t.isDeferred),
		id: id,
	}));
}

export interface CompileTimeTypeOfType extends CompileTimeTypeBase {
	readonly julType: 'typeOf';
	value: CompileTimeType;
}

export function createCompileTimeTypeOfType(value: CompileTimeType): CompileTimeTypeOfType {
	return internType(`typeOf:${value.id}`, id => ({
		julType: 'typeOf',
		value: value,
		isDeferred: value.isDeferred,
		id: id,
	}));
}

export interface CompileTimeUnionType extends CompileTimeTypeBase {
	readonly julType: 'or';
	ChoiceTypes: CompileTimeType[];
}

export function createCompileTimeUnionType(ChoiceTypes: CompileTimeType[]): CompileTimeUnionType {
	return internType(`or:${getIds(ChoiceTypes)}`, id => ({
		julType: 'or',
		ChoiceTypes: ChoiceTypes,
		isDeferred: ChoiceTypes.some(t => t.isDeferred),
		id: id,
	}));
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
	const keyId = typeof nestedKey === 'object'
		? `t${nestedKey.id}`
		: typeof nestedKey === 'number'
			? `n${nestedKey}`
			: `s${nestedKey}`;
	return internType(`nested:${source.id},${keyId}`, id => ({
		julType: 'nestedReference',
		source: source,
		nestedKey: nestedKey,
		// Der Knoten entsteht nur, wenn der Zugriff nicht gefaltet werden konnte - er wartet also
		// noch, unabhängig davon, wie aufgelöst Quelle und Schlüssel einzeln aussehen.
		isDeferred: true,
		id: id,
	}));
}

/**
 * Der Typ des Arguments, das ein Aufruf an diesen Parameter übergibt: TypeOf(x) im Rumpf. Das
 * Argument selbst als Typ gelesen (ein nacktes T) ist die offene Rechnung valueOf darauf.
 */
export interface ParameterReference extends CompileTimeTypeBase {
	readonly julType: 'parameterReference';
	name: string;
	index: number;
	/**
	 * Muss nach dem Erzeugen gesetzt werden.
	 */
	functionRef?: FunctionIdentity;
}

/**
 * Ein Wert als Typ gelesen, solange der Wert noch auf den Aufruf wartet: `T` in `(T: Type v: T)`,
 * `TypeOf(xs)/ElementType` als Parametertyp. Am Aufruf wird valueOf auf das Eingesetzte angewendet.
 */
export interface CompileTimeValueAsType extends CompileTimeTypeBase {
	readonly julType: 'valueAsType';
	Source: CompileTimeType;
}

export function createCompileTimeValueAsType(Source: CompileTimeType): CompileTimeValueAsType {
	return internType(`valueAsType:${Source.id}`, id => ({
		julType: 'valueAsType',
		Source: Source,
		isDeferred: Source.isDeferred,
		id: id,
	}));
}

export function createParameterReference(name: string, index: number): ParameterReference {
	return {
		julType: 'parameterReference',
		name: name,
		index: index,
		isDeferred: true,
		id: nextTypeId++,
	};
}

/**
 * Ein Typ unter dem Namen, unter dem er an dieser Stelle geschrieben wurde.
 * Hält eine Symbolreferenz statt eines Typs - nur so ist eine Definition beschreibbar, die sich
 * selbst nennt: das Ziel wird erst beim Zugriff gelesen, wenn das Symbol fertig ist.
 */
export interface CompileTimeAliasType extends CompileTimeTypeBase {
	readonly julType: 'alias';
	name: string;
	symbol: SymbolDefinition;
	/**
	 * Nur bei der Anwendung einer Typfunktion auf sich selbst (`Tree(T)` im Rumpf von Tree): die
	 * Argumente, mit denen der Rückgabetyp beim Auflösen berechnet wird.
	 */
	args?: CompileTimeType;
}

export function createCompileTimeAliasType(name: string, symbol: SymbolDefinition, args?: CompileTimeType): CompileTimeAliasType {
	return internType(`alias:${name.length}:${name},${getObjectId(symbol)},${args?.id ?? 0}`, id => ({
		julType: 'alias',
		name: name,
		symbol: symbol,
		args: args,
		// Ein Alias ist immer auflösbar, nur nicht sofort - anders als parameterReference, der auf
		// einen Aufrufort wartet, der nie kommen muss. Als unaufgelöst gemeldet würde er jeden
		// Konsumenten verteuern, ohne dass er je auf etwas wartet. Offene Argumente warten dagegen
		// sehr wohl auf den Aufruf der umgebenden Typfunktion.
		isDeferred: args?.isDeferred ?? false,
		id: id,
	}));
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
	const parameterKey = (parameter: Parameter | undefined) => parameter
		? `${parameter.name.length}:${parameter.name}=${parameter.type?.id ?? 0}`
		: '-';
	return internType(`params:${singleNames.map(parameterKey).join(';')}|${parameterKey(rest)}`, id => ({
		julType: 'parameters',
		singleNames: singleNames,
		rest: rest,
		// Eine Parameterliste steht als Ganzes fest; offene Parametertypen macht getTypeError
		// einzeln permissiv (hasReliableTypeError).
		isDeferred: false,
		id: id,
	}));
}

export interface Parameter {
	name: string;
	type?: CompileTimeType;
}

/**
 * Ruft callback für jeden direkt enthaltenen Typ auf, auch in Funktions- und Parametertypen.
 * Steigt nicht in das Ziel eines Alias ab (ein rekursiver Typ terminierte sonst nicht), nur in
 * seine Argumente, und nicht in die Funktion eines Prädikats (sie ist ein Wert, keine Typangabe).
 */
export function forEachChildType(type: CompileTimeType, callback: (child: CompileTimeType) => void): void {
	if (isOperationType(type)) {
		getOperands(type).forEach(callback);
		return;
	}
	switch (type.julType) {
		case 'any':
		case 'invalid':
		case 'blob':
		case 'boolean':
		case 'booleanLiteral':
		case 'date':
		case 'empty':
		case 'error':
		case 'float':
		case 'floatLiteral':
		case 'integer':
		case 'integerLiteral':
		case 'never':
		case 'text':
		case 'textLiteral':
		case 'type':
		case 'parameterReference':
			return;
		case 'alias':
			if (type.args) {
				callback(type.args);
			}
			return;
		case 'and':
		case 'or':
			type.ChoiceTypes.forEach(callback);
			return;
		case 'dictionary':
		case 'list':
			callback(type.ElementType);
			return;
		case 'dictionaryLiteral':
			Object.values(type.FieldTypes).forEach(callback);
			return;
		case 'function':
			callback(type.ParamsType);
			callback(type.ReturnType);
			return;
		case 'bound':
			callback(type.Value);
			return;
		case 'lengthOf':
			callback(type.Source);
			return;
		case 'not':
			callback(type.SourceType);
			return;
		case 'parameters':
			type.singleNames.forEach(parameter => {
				if (parameter.type) {
					callback(parameter.type);
				}
			});
			if (type.rest?.type) {
				callback(type.rest.type);
			}
			return;
		case 'predicate':
			callback(type.UpperBound);
			callback(type.LowerBound);
			return;
		case 'indexRange':
			callback(type.Start);
			callback(type.End);
			return;
		case 'stream':
			callback(type.ValueType);
			return;
		case 'tuple':
			type.ElementTypes.forEach(callback);
			return;
		case 'typeOf':
			callback(type.value);
			return;
		default: {
			const assertNever: never = type;
			throw new Error('Unexpected julType: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

//#endregion CompileTimeType

//#region Blatt-Typ Factories - für O(1) Zugriff ohne Rekursion

/**
 * Gecachte Instanzen für häufig verwendete Blatt-Typen - alle haben isDeferred: false
 */
export const builtinAny: AnyType = { julType: 'any', isDeferred: false, id: createTypeId() };
export const builtinInvalid: InvalidType = { julType: 'invalid', isDeferred: false, id: createTypeId() };
export const builtinNever: NeverType = { julType: 'never', isDeferred: false, id: createTypeId() };
export const builtinEmpty: EmptyType = { julType: 'empty', isDeferred: false, id: createTypeId() };
export const builtinBoolean: BooleanType = { julType: 'boolean', isDeferred: false, id: createTypeId() };
export const builtinInteger: IntegerType = { julType: 'integer', isDeferred: false, id: createTypeId() };
export const builtinFloat: FloatType = { julType: 'float', isDeferred: false, id: createTypeId() };
export const builtinText: TextType = { julType: 'text', isDeferred: false, id: createTypeId() };
export const builtinDate: DateType = { julType: 'date', isDeferred: false, id: createTypeId() };
export const builtinBlob: BlobType = { julType: 'blob', isDeferred: false, id: createTypeId() };
export const builtinType: TypeType = { julType: 'type', isDeferred: false, id: createTypeId() };
export const builtinError: ErrorType = { julType: 'error', isDeferred: false, id: createTypeId() };

export function createBooleanLiteral(value: boolean): BooleanLiteralType {
	return internType(`boolean-literal:${value}`, id => ({ julType: 'booleanLiteral', value, isDeferred: false, id: id }));
}

// Eigene Tabellen ohne zusammengesetzten Schlüssel: Die Literale sind zahlreich (Daten aus JSON), und ein
// langer Text als Schlüssel würde bei jeder Erzeugung neu gehasht.
const integerLiterals = new Map<bigint, IntegerLiteralType>();
const textLiterals = new Map<string, TextLiteralType>();

export function createIntegerLiteral(value: bigint): IntegerLiteralType {
	let literal = integerLiterals.get(value);
	if (!literal) {
		if (integerLiterals.size >= maxInternedTypes) {
			integerLiterals.clear();
		}
		literal = { julType: 'integerLiteral', value, isDeferred: false, id: createTypeId() };
		integerLiterals.set(value, literal);
	}
	return literal;
}

export function createFloatLiteral(value: number): FloatLiteralType {
	return internType(`float-literal:${Object.is(value, -0) ? '-0' : value}`, id => ({ julType: 'floatLiteral', value, isDeferred: false, id: id }));
}

export function createTextLiteral(value: string): TextLiteralType {
	let literal = textLiterals.get(value);
	if (!literal) {
		if (textLiterals.size >= maxInternedTypes) {
			textLiterals.clear();
		}
		literal = { julType: 'textLiteral', value, isDeferred: false, id: createTypeId() };
		textLiterals.set(value, literal);
	}
	return literal;
}

//#endregion Blatt-Typ Factories
//#region Kopien

/**
 * Eine Kopie des Funktionstyps mit geänderten Eigenschaften, die Identität (FunctionIdentity) bleibt.
 * Eigene Nummer, denn Funktionstypen werden nicht interniert.
 */
export function copyFunctionType(
	functionType: CompileTimeFunctionType,
	changes: Partial<Pick<CompileTimeFunctionType, 'ParamsType' | 'ReturnType' | 'purity' | 'aliasName' | 'isDeferred'>>,
): CompileTimeFunctionType {
	return { ...functionType, ...changes, id: nextTypeId++ };
}

//#endregion Kopien
