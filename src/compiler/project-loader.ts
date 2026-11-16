import { CheckOptions, checkTypes, isCoreLibInitialized, ParsedDocuments } from '../checker/checker.js';
import { clearTypeCaches } from '../checker/type-algebra.js';
import { CompilerError, ErrorCode } from '../compiler-errors.js';
import { parseCode } from '../parser/parser.js';
import { ParsedFile } from '../syntax-tree.js';

/**
 * Der einzige Weg von einer Datei zum geprüften Baum samt Abhängigkeiten - für CLI, Language
 * Server, Bench und Tests. Parser und Checker greifen selbst nicht aufs Dateisystem zu, gelesen
 * wird nur über den ProjectHost. Die core-lib bekommt der Checker vorher über initCoreLib, unter
 * Node aus node-host.ts, im Browser aus browser.ts.
 */

/**
 * Schutz vor Riesendateien (z.B. generierter Code oder große JSON-Daten): Eine größere Quelle
 * liefert beim Importeur Any statt ihres Typs. Eine Grenze für CLI und Language Server, sonst
 * kennt der eine den Typ und der andere nicht, und ein `assume` wäre nur in einem von beiden
 * überflüssig. Der Language Server lädt Dateien darüber gar nicht erst, die CLI lädt sie für den
 * Emit. Die Grenze muss über echten Quelldateien liegen: Any erzeugt beim Importeur Folgewarnungen
 * (typeNotProven).
 */
export const maxTypedFileSize = 1000000;

export type SourceReadResult =
	| { type: 'code'; code: string; }
	| { type: 'notFound'; }
	/**
	 * Vorhanden, aber absichtlich nicht geladen (Language Server: zu groß). Kein Fehler, der
	 * Import liefert Any.
	 */
	| { type: 'skipped'; };

/**
 * Die CheckOptions werden bei jedem checkTypes-Lauf mitgegeben.
 */
export interface ProjectHost extends CheckOptions {
	readSource(filePath: string): SourceReadResult;
	/**
	 * Fehlt sie, gilt maxTypedFileSize. Nur für Tests, damit sie keine Megabyte-Quellen brauchen.
	 */
	maxTypedFileSize?: number;
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
	assertCoreLibInitialized();
	clearTypeCaches();
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
			checkTypes(previous, documents, host);
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
	const untyped = sourceCode.length > (host.maxTypedFileSize ?? maxTypedFileSize);
	const parsed = parseCode(sourceCode, filePath, untyped);
	if (untyped) {
		parsed.untyped = true;
	}
	documents[filePath] = parsed;
	host.onParsed?.(parsed, previous);
	loadDependencies(parsed, documents, host, loading);
	checkTypes(parsed, documents, host);
	return parsed;
}

/**
 * Prüft eine geladene Datei erneut, ohne sie neu zu parsen: Eine Datei, die sie importiert, hat sich
 * geändert (Language Server). Der Checker schreibt nichts in den Baum, ein neuer Lauf gibt ein neues
 * CheckResult. Die Abhängigkeiten werden wie beim Laden aufgelöst, eine inzwischen gelöschte meldet
 * fileNotFound, eine fehlende wird geladen, falls es sie jetzt gibt.
 */
export function recheckFile(file: ParsedFile, documents: ParsedDocuments, host: ProjectHost): void {
	assertCoreLibInitialized();
	// Wie loadFile, siehe clearTypeCaches.
	clearTypeCaches();
	loadDependencies(file, documents, host, new Set());
	checkTypes(file, documents, host);
}

/**
 * Lädt die Abhängigkeiten der Datei, soweit nicht schon in documents, und setzt ihre loadErrors.
 */
function loadDependencies(
	file: ParsedFile,
	documents: ParsedDocuments,
	host: ProjectHost,
	loading: Set<string>,
): void {
	const loadErrors: CompilerError[] = [];
	loading.add(file.filePath);
	file.dependencies?.forEach(dependency => {
		const loaded = loadFileRecursive(dependency.fullPath, documents, host, undefined, loading);
		if (loaded === 'notFound') {
			loadErrors.push({
				code: ErrorCode.fileNotFound,
				message: `File not found: ${dependency.fullPath}`,
				...dependency.source,
			});
		}
	});
	loading.delete(file.filePath);
	file.loadErrors = loadErrors;
}

//#region Hosts

/**
 * Für Tests: Dateien im Speicher. Die Schlüssel mit join bilden, wie getPathFromImport die
 * Importpfade auflöst - sonst passen sie unter Windows nicht zusammen.
 */
export function createInMemoryHost(files: { [filePath: string]: string; }, options: CheckOptions = {}): ProjectHost {
	return {
		readSource: filePath => {
			const code = files[filePath];
			return code === undefined
				? { type: 'notFound' }
				: { type: 'code', code: code };
		},
		...options,
	};
}

//#endregion Hosts

function assertCoreLibInitialized(): void {
	if (!isCoreLibInitialized()) {
		throw new Error('core-lib is not initialized. Node: import compiler/node-host.js, browser: call initCompiler.');
	}
}
