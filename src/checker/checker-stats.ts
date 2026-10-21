/**
 * Zählt die Arbeit des Checkers, damit ein Umbau der Typauflösung messbar bleibt.
 * Deterministisch, im Gegensatz zu einer Zeitmessung.
 */
export const checkerStats = {
	/** Bezugsgröße: inferierte Ausdrücke. */
	inferType: 0,
	/** Auflösung von Platzhaltern für Prüfung und Anzeige. */
	resolvePlaceholders: 0,
	/** Relationsprüfungen inklusive Rekursion über Choices. */
	getTypeError: 0,
	/** Aufrufstellen, an denen constant folding tatsächlich gegriffen hat (siehe tryFoldCall). */
	foldableCall: 0,
};

export function resetCheckerStats(): void {
	checkerStats.inferType = 0;
	checkerStats.resolvePlaceholders = 0;
	checkerStats.getTypeError = 0;
	checkerStats.foldableCall = 0;
}

/**
 * Zählt, wann ein Ergebnis nicht allein von seinen Eingaben abhängt: es hat eine koinduktive
 * Annahme eines umgebenden Vergleichs gebraucht, eine Notbremse (Tiefe, Aufblähung, Faltbudget)
 * ausgelöst oder den veränderlichen Zustand einer Funktion gelesen (getParameterUpperBound).
 * Ein Ergebnis, bei dem der Zähler unverändert blieb, ist geschlossen und darf nach den Ids seiner
 * Eingaben gemerkt werden.
 */
export const resultContext = { dependence: 0 };
