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
