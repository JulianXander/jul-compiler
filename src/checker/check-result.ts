import { CompileTimeFunctionType, CompileTimeType, ParsedFile, ParseExpressionBase, ParseFunctionCall, TypeInfo } from '../syntax-tree.js';

/**
 * Was ein Prüflauf über eine Datei herausfindet: Typen der Ausdrücke und was an Aufrufen aufgelöst
 * wurde. Gelesen und geschrieben wird nur über die Funktionen hier, nie über Felder am Knoten
 * (docs/backlog/immutable-syntax-tree.md).
 *
 * Schritt 2 des Umbaus: Die Zugriffe lesen und schreiben noch die Felder am Knoten, das Ergebnis
 * wird nur durchgereicht. Ab Schritt 3 liegen die Tabellen hier, indiziert über die Knoten-Id.
 */
export interface CheckResult {
	readonly filePath: string;
}

export function createCheckResult(filePath: string): CheckResult {
	return { filePath: filePath };
}

/**
 * Das Ergebnis des letzten Checks der Datei. Für eine nie geprüfte Datei ein leeres: Die Zugriffe
 * liefern dann undefined, wie der Baum ohne typeInfo.
 */
export function getFileCheckResult(file: ParsedFile): CheckResult {
	return file.checkResult ?? createCheckResult(file.filePath);
}

/**
 * Der Typ mit intakten Platzhaltern, siehe TypeInfo. undefined, solange der Ausdruck nicht
 * geprüft ist.
 */
export function getTypeInfo(_result: CheckResult, expression: ParseExpressionBase | undefined): TypeInfo | undefined {
	return expression?.typeInfo;
}

export function setTypeInfo(_result: CheckResult, expression: ParseExpressionBase, typeInfo: TypeInfo): void {
	expression.typeInfo = typeInfo;
}

/**
 * Der Typ, den die Stelle verlangt, an der der Ausdruck steht (Typguard, Parameter, Rückgabetyp,
 * Feld oder Element eines solchen). undefined, wenn die Stelle nichts verlangt.
 */
export function getExpectedType(_result: CheckResult, expression: ParseExpressionBase | undefined): CompileTimeType | undefined {
	return expression?.expectedType;
}

export function setExpectedType(_result: CheckResult, expression: ParseExpressionBase, expectedType: CompileTimeType): void {
	expression.expectedType = expectedType;
}

/**
 * Der Typ der aufgerufenen Funktion, verengt auf diesen Aufruf. Parametertypen, die auf ein
 * Argument verweisen (`TypeOf(stream$)/ValueType`), sind gegen die Argumente aufgelöst, ebenso der
 * Rückgabetyp. Die TypeInfo der functionExpression bleibt dagegen der Typ des Werts.
 */
export function getCalledFunctionType(_result: CheckResult, call: ParseFunctionCall | undefined): CompileTimeFunctionType | undefined {
	return call?.calledFunctionType;
}

export function setCalledFunctionType(_result: CheckResult, call: ParseFunctionCall, functionType: CompileTimeFunctionType): void {
	call.calledFunctionType = functionType;
}

/**
 * Wenn die Argumente ein Dictionary sind: die Parameternamen des aufgerufenen Funktionstyps in
 * deklarierter Reihenfolge (source ?? name). undefined bei Rest-Parameter oder unbekannter
 * Signatur. Der Emitter schreibt damit benannte Argumente als positionalen Aufruf.
 */
export function getCalledParameterNames(_result: CheckResult, call: ParseFunctionCall | undefined): string[] | undefined {
	return call?.calledParameterNames;
}

export function setCalledParameterNames(_result: CheckResult, call: ParseFunctionCall, names: string[] | undefined): void {
	call.calledParameterNames = names;
}
