import type { TestLocation } from '../runtime/test-runtime.js';
import type { SourceMapping } from './emitter.js';

/**
 * Ein geladenes Modul des Programms: woraus es übersetzt wurde und wie die Positionen zusammenhängen.
 */
export interface LoadedSourceFile {
	sourceFilePath: string;
	/** Nach Position im erzeugten JS sortiert, wie der Emitter sie liefert. */
	mappings: SourceMapping[];
}

/**
 * Die erste Stelle im Stack, die in eine Datei des Programms zeigt, umgerechnet auf den Quelltext.
 * Browser wenden Source Maps nicht auf error.stack an, dort stehen die URLs der geladenen Module
 * mit Zeile und Spalte im erzeugten JS. Frames in Modulen, die getFile nicht kennt (Runtime), und
 * Stellen vor der ersten Zuordnung (Importe) werden übergangen.
 * Versteht die Formate von V8 (`at f (url:3:5)`) und Firefox/Safari (`f@url:3:5`).
 *
 * @param getFile URL eines geladenen Moduls → seine Quelle, undefined bei fremden Modulen
 */
export function getSourceLocationFromStack(
	stack: string,
	getFile: (url: string) => LoadedSourceFile | undefined,
): TestLocation | undefined {
	for (const frame of stack.split('\n')) {
		const match = /([^\s()@]+):(\d+):(\d+)/.exec(frame);
		if (!match) {
			continue;
		}
		const [, url, row, column] = match;
		const file = getFile(url!);
		if (!file) {
			continue;
		}
		// Im Stack 1-basiert, in den Zuordnungen 0-basiert.
		const mapping = findMapping(file.mappings, Number(row) - 1, Number(column) - 1);
		if (mapping) {
			return {
				file: file.sourceFilePath,
				row: mapping.sourceLine + 1,
				column: mapping.sourceColumn + 1,
			};
		}
	}
	return undefined;
}

/**
 * Die letzte Zuordnung an oder vor der Stelle im erzeugten JS.
 */
function findMapping(mappings: SourceMapping[], line: number, column: number): SourceMapping | undefined {
	let found: SourceMapping | undefined;
	for (const mapping of mappings) {
		if (mapping.generatedLine > line
			|| (mapping.generatedLine === line && mapping.generatedColumn > column)) {
			break;
		}
		found = mapping;
	}
	return found;
}
