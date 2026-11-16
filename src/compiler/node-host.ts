import typescript from 'typescript';
import { join } from 'path';
import { CheckOptions, initCoreLib } from '../checker/checker.js';
import { coreLibFileName, parseCode } from '../parser/parser.js';
import { ParsedFile } from '../syntax-tree.js';
import { setTypeScript } from '../typescript-module.js';
import { executingDirectory, readTextFile } from '../node-util.js';
import { ProjectHost, SourceReadResult } from './project-loader.js';

/**
 * Der Zugang des Compilers zum Dateisystem unter Node. Parser, Checker und Loader lesen selbst
 * nichts, sie laufen auch im Browser (browser.ts).
 *
 * Beim Laden dieses Moduls werden die core-lib geprüft und TypeScript gesetzt. Jeder Node-Einstieg
 * (CLI, Language Server, Bench, Tests) importiert es deshalb vor dem ersten loadFile.
 */

export const coreLibPath = join(executingDirectory, 'runtime', coreLibFileName);

initCoreLib(readTextFile(coreLibPath), coreLibPath);
setTypeScript(typescript);

/**
 * @throws Wirft Error wenn Datei nicht gelesen werden kann.
 */
export function parseFile(filePath: string): ParsedFile {
	const code = readTextFile(filePath);
	const result = parseCode(code, filePath);
	return result;
}

/**
 * Liest eine Quelldatei. Ohne vorherige Existenzprüfung: Unter Windows kostet existsSync je Datei
 * etwa so viel wie das Lesen selbst. Fehlt die Datei, ist das ENOENT (oder ENOTDIR bei einem Pfad
 * durch eine Datei hindurch), jeder andere Fehler bleibt ein Fehler.
 */
function readSourceFile(filePath: string): SourceReadResult {
	try {
		return { type: 'code', code: readTextFile(filePath) };
	}
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') {
			return { type: 'notFound' };
		}
		throw error;
	}
}

/**
 * Liest jede Datei höchstens einmal: spätere Abfragen (Fehlerausschnitt, Emit) bekommen genau
 * den Stand, der geprüft wurde. Deshalb nur für einen einzelnen Lauf gedacht, nicht für
 * langlebige Prozesse - dort würden Änderungen auf der Platte nicht mehr gesehen.
 */
export function createFileSystemHost(options: CheckOptions = {}): ProjectHost {
	const cache = new Map<string, SourceReadResult>();
	return {
		readSource: filePath => {
			const cached = cache.get(filePath);
			if (cached) {
				return cached;
			}
			const readResult = readSourceFile(filePath);
			cache.set(filePath, readResult);
			return readResult;
		},
		...options,
	};
}
