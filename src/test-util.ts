import type { ParsedDocuments } from './checker/checker.js';
import { errorInfos } from './compiler-errors.js';
import { forEachChild, PositionedExpression, TypeInfo } from './syntax-tree.js';

/**
 * Macht aus einer Prüffunktion einen Test-Helfer, der Fehler an der Aufrufstelle meldet, wie
 * t.Helper() in Go. Scheitert eine Prüfung im Helfer, beginnt der Stack beim Aufrufer - der
 * oberste Frame im Testoutput ist dann die Zeile des Falls, nicht die expect-Zeile im Helfer.
 */
export function reportAtCaller<A extends unknown[]>(helper: (...args: A) => void): (...args: A) => void {
	const wrapped = (...args: A): void => {
		try {
			helper(...args);
		}
		catch (error) {
			if (error instanceof Error) {
				Error.captureStackTrace(error, wrapped);
			}
			throw error;
		}
	};
	return wrapped;
}

/**
 * Prüft die Herkunftsregel von Invalid: Der Typ entsteht nur, wo schon ein Fehler gemeldet ist.
 * Liefert die Positionen (datei:zeile:spalte, 1-basiert) aller Ausdrücke mit Typ Invalid, wenn in
 * keiner der geprüften Dateien ein Fehler mit Schweregrad error steht. Der Fehler darf in einer
 * anderen Datei stehen, weil ein Import den Typ in die importierende Datei trägt.
 */
export function findInvalidWithoutError(documents: ParsedDocuments): string[] {
	const files = Object.values(documents).filter(file => file.checked);
	const hasError = files.some(file => file.checked!.errors.some(error => errorInfos[error.code].severity === 'error'));
	if (hasError) {
		return [];
	}
	const positions: string[] = [];
	const visit = (filePath: string, expression: PositionedExpression): undefined => {
		const typeInfo = (expression as { typeInfo?: TypeInfo; }).typeInfo;
		if (typeInfo?.type.julType === 'invalid') {
			positions.push(`${filePath}:${expression.startRowIndex + 1}:${expression.startColumnIndex + 1}`);
		}
		forEachChild(expression, child => visit(filePath, child));
		return undefined;
	};
	files.forEach(file => {
		file.checked!.expressions?.forEach(expression => visit(file.filePath, expression));
	});
	return positions;
}
