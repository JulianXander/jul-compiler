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
