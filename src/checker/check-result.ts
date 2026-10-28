import type { BranchCoverage } from './branch-coverage.js';
import { CompilerError } from '../compiler-errors.js';
import { CompileTimeAliasType, CompileTimeFunctionType, CompileTimeType, forEachChild, FunctionIdentity, getNodeSymbols, ParsedFile, ParseExpressionBase, ParseFunctionCall, PositionedExpression, PositionedExpressionBase, SymbolDefinition, SymbolTable, TypeInfo } from '../syntax-tree.js';

/**
 * Was ein Prüflauf über eine Datei herausfindet: Typen der Ausdrücke und Symbole, was an Aufrufen
 * aufgelöst wurde, und die Fehler. Typen, Aufrufe und Symbole werden nur über die Funktionen hier
 * gelesen und geschrieben (docs/backlog/immutable-syntax-tree.md).
 *
 * Die Tabellen sind über die Ids indiziert, die der Parser je Datei dicht ab 0 an Knoten und,
 * getrennt gezählt, an Symbole vergibt (setParentsAndIds, setFileSymbolIds). Sie gelten deshalb nur
 * für Knoten und Symbole der eigenen Datei: Einer aus einer anderen Datei liest still den Eintrag
 * eines fremden. Typen, die auf den Baum einer anderen Datei zeigen, tragen das Ergebnis ihrer Datei
 * mit (CompileTimeFunctionType.literalResult, TypeDeclaration.result,
 * CompileTimeAliasType.symbolResult).
 */
export interface CheckResult {
	/**
	 * Laufende Nummer je Prüflauf, für Schlüssel wie das Interning von CompileTimeAliasType.
	 */
	readonly id: number;
	readonly filePath: string;
	readonly typeInfos: (TypeInfo | undefined)[];
	readonly expectedTypes: (CompileTimeType | undefined)[];
	readonly calledFunctionTypes: (CompileTimeFunctionType | undefined)[];
	readonly calledParameterNames: (string[] | undefined)[];
	/**
	 * Je Symbol der aus dem Wert inferierte Typ. undefined, solange das Symbol nicht geprüft ist:
	 * Eine Referenz darauf ist dann eine Selbst- oder Vorwärtsreferenz.
	 */
	readonly symbolTypeInfos: (TypeInfo | undefined)[];
	/**
	 * Je Parameter-Symbol die Identität der Funktion, zu der es gehört.
	 */
	readonly functionRefs: (FunctionIdentity | undefined)[];
	/**
	 * Je Symbol, ob eine Referenz außerhalb der eigenen Definition es gefunden hat.
	 */
	readonly usedSymbols: boolean[];
	/**
	 * Was vor diesem branch noch ankommen kann, gesetzt in case 'branching' vor dem Inferieren des
	 * branches. Die Verengung in seinem Rumpf liest es. Schlüssel ist die Knoten-Id des branches.
	 */
	readonly coverageBeforeBranch: Map<number, BranchCoverage>;
	/**
	 * Alle Fehler der Datei: die des Parsers (syntax.errors) und des Loaders (loadErrors), dann die
	 * des Checks, nach den #ignore-Kommentaren. checked.errors ist dasselbe Array.
	 */
	readonly errors: CompilerError[];
	/**
	 * Nur mit verifyNodeOwnership: die obersten Ausdrücke der Datei, gegen die jeder Zugriff prüft.
	 */
	readonly roots: Set<PositionedExpression> | undefined;
	/**
	 * Nur mit verifyNodeOwnership: alle Symbole der Datei.
	 */
	readonly symbols: Set<SymbolDefinition> | undefined;
}

/**
 * Für die Tests: Jeder Zugriff prüft, ob der Knoten oder das Symbol zur Datei des Ergebnisses gehört
 * (Knoten über die parent-Kette). Kostet eine Schleife je Zugriff, deshalb nur mit
 * JUL_VERIFY_NODE_OWNERSHIP=1 (test-setup.mjs). Beim Modul-Load gelesen, weil der Checker die
 * core-lib dann schon prüft.
 */
const verifyNodeOwnership = process.env.JUL_VERIFY_NODE_OWNERSHIP === '1';

let nextCheckResultId = 1;

/**
 * Ein leeres Ergebnis für die Datei, die Tabellen schon auf die Zahl ihrer Knoten bzw. Symbole
 * angelegt: In beliebiger Reihenfolge geschrieben, bleibt ein vorab angelegtes Array dicht, ein
 * wachsendes würde bei Lücken zum Wörterbuch.
 */
export function createCheckResult(file: ParsedFile): CheckResult {
	const { nodeCount, symbolCount } = file;
	return {
		id: nextCheckResultId++,
		filePath: file.filePath,
		typeInfos: createTable(nodeCount, undefined),
		expectedTypes: createTable(nodeCount, undefined),
		calledFunctionTypes: createTable(nodeCount, undefined),
		calledParameterNames: createTable(nodeCount, undefined),
		symbolTypeInfos: createTable(symbolCount, undefined),
		functionRefs: createTable(symbolCount, undefined),
		usedSymbols: createTable(symbolCount, false),
		coverageBeforeBranch: new Map(),
		errors: [...file.syntax.errors, ...file.loadErrors ?? []],
		roots: verifyNodeOwnership
			? new Set<PositionedExpression>(file.syntax.expressions)
			: undefined,
		symbols: verifyNodeOwnership
			? collectSymbols(file)
			: undefined,
	};
}

/**
 * Per push statt new Array(length).fill: So ist das Array gepackt, ohne Prüfung auf Lücken beim
 * Lesen. new Array mit großer Länge legt V8 zudem gleich als Wörterbuch an.
 */
function createTable<T>(length: number, initial: T): T[] {
	const table: T[] = [];
	for (let index = 0; index < length; index++) {
		table.push(initial);
	}
	return table;
}

/**
 * Dieselben Symboltabellen wie setParentsAndIds und setFileSymbolIds.
 */
function collectSymbols(file: ParsedFile): Set<SymbolDefinition> {
	const symbols = new Set<SymbolDefinition>();
	const add = (table: SymbolTable): void => {
		for (const name in table) {
			symbols.add(table[name]!);
		}
	};
	const visit = (expression: PositionedExpression): undefined => {
		const nodeSymbols = getNodeSymbols(expression);
		if (nodeSymbols) {
			add(nodeSymbols);
		}
		forEachChild(expression, visit);
		return undefined;
	};
	add(file.syntax.symbols);
	file.syntax.expressions?.forEach(visit);
	return symbols;
}

/**
 * Das Ergebnis des letzten Checks der Datei. Für eine nie geprüfte Datei ein leeres: Die Zugriffe
 * liefern dann undefined.
 */
export function getFileCheckResult(file: ParsedFile): CheckResult {
	return file.checkResult ?? createCheckResult(file);
}

function getId(result: CheckResult, expression: PositionedExpressionBase): number {
	const id = expression.id;
	if (id === undefined) {
		throw new Error(`Expression at ${expression.startRowIndex}:${expression.startColumnIndex} without id, not created by parseFile.`);
	}
	// Die Modulkonstante statt result.roots: Ohne Prüfung kostet der Zugriff so keinen Ladebefehl.
	if (verifyNodeOwnership) {
		checkOwnership(result, expression);
	}
	return id;
}

function checkOwnership(result: CheckResult, expression: PositionedExpressionBase): void {
	let root: PositionedExpressionBase = expression;
	while (root.parent) {
		root = root.parent;
	}
	if (!result.roots!.has(root as PositionedExpression)) {
		throw new Error(`Expression at ${expression.startRowIndex}:${expression.startColumnIndex} does not belong to the check result of ${result.filePath}.`);
	}
}

function getSymbolId(result: CheckResult, symbol: SymbolDefinition): number {
	const id = symbol.id;
	if (id === undefined) {
		throw new Error(`Symbol at ${symbol.startRowIndex}:${symbol.startColumnIndex} without id, not created by parseFile.`);
	}
	if (verifyNodeOwnership
		&& !result.symbols!.has(symbol)) {
		throw new Error(`Symbol at ${symbol.startRowIndex}:${symbol.startColumnIndex} does not belong to the check result of ${result.filePath}.`);
	}
	return id;
}

//#region Ausdrücke

/**
 * Der Typ mit intakten Platzhaltern, siehe TypeInfo. undefined, solange der Ausdruck nicht
 * geprüft ist.
 */
export function getTypeInfo(result: CheckResult, expression: ParseExpressionBase | undefined): TypeInfo | undefined {
	return expression && result.typeInfos[getId(result, expression)];
}

export function setTypeInfo(result: CheckResult, expression: ParseExpressionBase, typeInfo: TypeInfo): void {
	result.typeInfos[getId(result, expression)] = typeInfo;
}

/**
 * Der Typ, den die Stelle verlangt, an der der Ausdruck steht (Typguard, Parameter, Rückgabetyp,
 * Feld oder Element eines solchen). Mit den Argumenten des Aufrufs instanziiert, aber nicht über
 * Deklarationen aufgelöst. undefined, wenn die Stelle nichts verlangt. Eigene Tabelle statt Teil von
 * TypeInfo, weil TypeInfo-Objekte zwischen Ausdrücken und Symbolen geteilt werden.
 */
export function getExpectedType(result: CheckResult, expression: ParseExpressionBase | undefined): CompileTimeType | undefined {
	return expression && result.expectedTypes[getId(result, expression)];
}

export function setExpectedType(result: CheckResult, expression: ParseExpressionBase, expectedType: CompileTimeType): void {
	result.expectedTypes[getId(result, expression)] = expectedType;
}

/**
 * Der Typ der aufgerufenen Funktion, verengt auf diesen Aufruf. Parametertypen, die auf ein
 * Argument verweisen (`TypeOf(stream$)/ValueType`), sind gegen die Argumente aufgelöst, ebenso der
 * Rückgabetyp. Die TypeInfo der functionExpression bleibt dagegen der Typ des Werts: dieselbe
 * Funktion, unabhängig vom Aufruf.
 */
export function getCalledFunctionType(result: CheckResult, call: ParseFunctionCall | undefined): CompileTimeFunctionType | undefined {
	return call && result.calledFunctionTypes[getId(result, call)];
}

export function setCalledFunctionType(result: CheckResult, call: ParseFunctionCall, functionType: CompileTimeFunctionType): void {
	result.calledFunctionTypes[getId(result, call)] = functionType;
}

/**
 * Wenn die Argumente ein Dictionary sind: die Parameternamen des aufgerufenen Funktionstyps in
 * deklarierter Reihenfolge (source ?? name). undefined bei Rest-Parameter oder unbekannter
 * Signatur. Der Emitter schreibt damit benannte Argumente als positionalen Aufruf: Die Reihenfolge
 * der Namen hat der Checker schon geprüft.
 */
export function getCalledParameterNames(result: CheckResult, call: ParseFunctionCall | undefined): string[] | undefined {
	return call && result.calledParameterNames[getId(result, call)];
}

export function setCalledParameterNames(result: CheckResult, call: ParseFunctionCall, names: string[] | undefined): void {
	result.calledParameterNames[getId(result, call)] = names;
}

//#endregion Ausdrücke

//#region Symbole

/**
 * Der aus dem Wert inferierte Typ des Symbols. undefined, solange es nicht geprüft ist.
 */
export function getSymbolTypeInfo(result: CheckResult, symbol: SymbolDefinition | undefined): TypeInfo | undefined {
	return symbol && result.symbolTypeInfos[getSymbolId(result, symbol)];
}

export function setSymbolTypeInfo(result: CheckResult, symbol: SymbolDefinition, typeInfo: TypeInfo): void {
	result.symbolTypeInfos[getSymbolId(result, symbol)] = typeInfo;
}

/**
 * Der Typ des Symbols hinter dem Alias, aus dem Ergebnis der Datei des Symbols.
 */
export function getAliasSymbolType(alias: CompileTimeAliasType): CompileTimeType | undefined {
	return getSymbolTypeInfo(alias.symbolResult, alias.symbol)?.type;
}

export function getFunctionRef(result: CheckResult, symbol: SymbolDefinition): FunctionIdentity | undefined {
	return result.functionRefs[getSymbolId(result, symbol)];
}

export function setFunctionRef(result: CheckResult, symbol: SymbolDefinition, functionRef: FunctionIdentity): void {
	result.functionRefs[getSymbolId(result, symbol)] = functionRef;
}

export function isSymbolUsed(result: CheckResult, symbol: SymbolDefinition): boolean {
	return result.usedSymbols[getSymbolId(result, symbol)]!;
}

export function markSymbolUsed(result: CheckResult, symbol: SymbolDefinition): void {
	result.usedSymbols[getSymbolId(result, symbol)] = true;
}

//#endregion Symbole
