import { mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Helfer mit Dateisystemzugriff, nur für Node. Parser, Checker, Loader und Emitter laufen auch im
 * Browser und importieren deshalb nur aus util.ts.
 */

export const executingDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * @throws Wirft Error wenn Datei nicht gelesen werden kann.
 */
export function readTextFile(path: string): string {
	const file = readFileSync(path);
	const text = file.toString();
	return text;
}

export function tryCreateDirectory(path: string): void {
	mkdirSync(path, { recursive: true });
}
