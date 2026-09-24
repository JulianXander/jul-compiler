import { existsSync } from 'fs';
import { checkTypes, ParsedDocuments } from './checker/checker.js';
import { ReferenceIndex } from './checker/reference-index.js';
import { ErrorCode } from './compiler-errors.js';
import { parseCode } from './parser/parser.js';
import { ParsedFile } from './syntax-tree.js';
import { readTextFile } from './util.js';

/**
 * Der einzige Weg von einer Datei zum geprüften Baum samt Abhängigkeiten - für CLI, Language
 * Server, Bench und Tests. Parser und Checker greifen selbst nicht aufs Dateisystem zu, gelesen
 * wird nur über den ProjectHost. Ausnahme ist die core-lib, die der Checker beim Modul-Load selbst
 * liest (siehe checker.ts).
 */

export type SourceReadResult =
	| { type: 'code'; code: string; }
	| { type: 'notFound'; }
	/**
	 * Vorhanden, aber absichtlich nicht geladen (Language Server: zu groß). Kein Fehler, der
	 * Import liefert Any.
	 */
	| { type: 'skipped'; };

export interface ProjectHost {
	readSource(filePath: string): SourceReadResult;
	/**
	 * Wird bei jedem checkTypes-Lauf mitgegeben (siehe dort).
	 */
	referenceIndex?: ReferenceIndex;
	/**
	 * Nach dem Parsen, vor dem Laden der Abhängigkeiten. previous ist der ersetzte Stand, falls
	 * die Datei schon in documents stand - der Language Server pflegt damit seinen
	 * Abhängigkeitsgraphen.
	 */
	onParsed?(parsed: ParsedFile, previous: ParsedFile | undefined): void;
}

/**
 * Parst filePath, lädt die Abhängigkeiten rekursiv und checkt danach die Datei - jede Endung,
 * nicht nur .jul, sonst käme beim Importeur nur Any an.
 * Mit code wird dieser Text statt readSource geparst, auch wenn die Datei schon in documents
 * steht (Language Server: geänderter Editor-Inhalt). Ohne code wird eine vorhandene Datei nicht
 * neu gelesen, nur nachgecheckt, falls sie noch ungecheckt ist.
 */
export function loadFile(
	filePath: string,
	documents: ParsedDocuments,
	host: ProjectHost,
	code: string,
): ParsedFile;
export function loadFile(
	filePath: string,
	documents: ParsedDocuments,
	host: ProjectHost,
	code?: string,
): ParsedFile | 'notFound' | 'skipped';
export function loadFile(
	filePath: string,
	documents: ParsedDocuments,
	host: ProjectHost,
	code?: string,
): ParsedFile | 'notFound' | 'skipped' {
	return loadFileRecursive(filePath, documents, host, code, new Set());
}

function loadFileRecursive(
	filePath: string,
	documents: ParsedDocuments,
	host: ProjectHost,
	code: string | undefined,
	/**
	 * Dateien, deren Abhängigkeiten gerade geladen werden. Ein Zyklus trifft hier auf eine
	 * Datei, die noch nicht fertig ist - sie wird weder erneut betreten noch vorzeitig gecheckt,
	 * der Import im Zyklus liefert Any.
	 */
	loading: Set<string>,
): ParsedFile | 'notFound' | 'skipped' {
	const previous = documents[filePath];
	if (previous
		&& code === undefined) {
		if (!previous.checked
			&& !loading.has(filePath)) {
			checkTypes(previous, documents, host.referenceIndex);
		}
		return previous;
	}
	let sourceCode = code;
	if (sourceCode === undefined) {
		const readResult = host.readSource(filePath);
		if (readResult.type !== 'code') {
			return readResult.type;
		}
		sourceCode = readResult.code;
	}
	const parsed = parseCode(sourceCode, filePath);
	documents[filePath] = parsed;
	host.onParsed?.(parsed, previous);
	loading.add(filePath);
	parsed.dependencies?.forEach(dependency => {
		const loaded = loadFileRecursive(dependency.fullPath, documents, host, undefined, loading);
		if (loaded === 'notFound') {
			// In unchecked, damit der Fehler wie ein Parse-Fehler behandelt wird: checkTypes
			// übernimmt ihn per Klon nach checked, die CLI emittiert nicht.
			parsed.unchecked.errors.push({
				code: ErrorCode.fileNotFound,
				message: `File not found: ${dependency.fullPath}`,
				...dependency.source,
			});
		}
	});
	loading.delete(filePath);
	checkTypes(parsed, documents, host.referenceIndex);
	return parsed;
}

//#region Hosts

/**
 * Liest jede Datei höchstens einmal: spätere Abfragen (Fehlerausschnitt, Emit) bekommen genau
 * den Stand, der geprüft wurde. Deshalb nur für einen einzelnen Lauf gedacht, nicht für
 * langlebige Prozesse - dort würden Änderungen auf der Platte nicht mehr gesehen.
 */
export function createFileSystemHost(referenceIndex?: ReferenceIndex): ProjectHost {
	const cache = new Map<string, SourceReadResult>();
	return {
		readSource: filePath => {
			const cached = cache.get(filePath);
			if (cached) {
				return cached;
			}
			const readResult: SourceReadResult = existsSync(filePath)
				? { type: 'code', code: readTextFile(filePath) }
				: { type: 'notFound' };
			cache.set(filePath, readResult);
			return readResult;
		},
		referenceIndex: referenceIndex,
	};
}

/**
 * Für Tests: Dateien im Speicher. Die Schlüssel mit join bilden, wie getPathFromImport die
 * Importpfade auflöst - sonst passen sie unter Windows nicht zusammen.
 */
export function createInMemoryHost(files: { [filePath: string]: string; }, referenceIndex?: ReferenceIndex): ProjectHost {
	return {
		readSource: filePath => {
			const code = files[filePath];
			return code === undefined
				? { type: 'notFound' }
				: { type: 'code', code: code };
		},
		referenceIndex: referenceIndex,
	};
}

//#endregion Hosts
