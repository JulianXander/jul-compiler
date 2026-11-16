import { initCoreLib, ParsedDocuments } from './checker/checker.js';
import { CompilerError, errorInfos } from './compiler-errors.js';
import { emitToJs } from './compiler/emit-file.js';
import { createInMemoryHost, loadFile } from './compiler/project-loader.js';
import { isTypeScriptLoaded, setTypeScript } from './typescript-module.js';
import { Extension } from './util.js';

/**
 * Einstieg für den Compiler im Browser (Playground der Homepage). Ohne Dateisystem: Die Dateien
 * kommen als Text, das Ergebnis geht als Text zurück. Unter Node gilt stattdessen node-host.ts.
 */

/**
 * Dateipfad → Quelltext, mit / als Trenner (main.jul, lib/math.jul). Die Schlüssel mit join bilden,
 * wie getPathFromImport die Importpfade auflöst, sonst findet ein Import seine Datei nicht.
 */
export type SourceFiles = { [filePath: string]: string; };

export interface CheckOutput {
	documents: ParsedDocuments;
	/** Alle Meldungen je Datei, jeder Schweregrad. */
	errors: { [filePath: string]: CompilerError[]; };
}

export type CompileOutput =
	| {
		type: 'success';
		documents: ParsedDocuments;
		files: { [filePath: string]: EmittedFile; };
	}
	| {
		type: 'error';
		documents: ParsedDocuments;
		errors: { [filePath: string]: CompilerError[]; };
	};

export interface EmittedFile {
	/**
	 * Pfad der Ausgabe, auf den die Importe im erzeugten JS zeigen (aus a.jul wird a.js, aus
	 * data.yaml data.yaml.json).
	 */
	outFilePath: string;
	js: string;
}

export interface CompileOptions {
	/** Importpfad der Runtime im erzeugten JS. */
	runtimeImportPath: string;
	/** Importpfad der Test-Runtime im erzeugten JS, gebraucht nur von *.test.jul. */
	testRuntimeImportPath: string;
	checkAssertions?: boolean;
}

/**
 * Einmal vor allem anderen aufrufen.
 * @param coreLibCode Inhalt von core-lib.jul (out/runtime/core-lib.jul)
 */
export function initCompiler(coreLibCode: string): void {
	initCoreLib(coreLibCode);
}

/**
 * Parst und prüft alle Dateien samt ihren Importen untereinander.
 */
export async function check(files: SourceFiles): Promise<CheckOutput> {
	await loadTypeScriptIfNeeded(files);
	const documents = loadAll(files);
	return {
		documents: documents,
		errors: getErrors(documents),
	};
}

/**
 * Prüft alle Dateien und erzeugt JS, aber nur, wenn keine Datei einen Fehler mit Schweregrad
 * error hat.
 */
export async function compile(files: SourceFiles, options: CompileOptions): Promise<CompileOutput> {
	await loadTypeScriptIfNeeded(files);
	const documents = loadAll(files);
	const errors = getErrors(documents);
	const hasError = Object.values(errors).some(fileErrors =>
		fileErrors.some(error => errorInfos[error.code].severity === 'error'));
	if (hasError) {
		return { type: 'error', documents: documents, errors: errors };
	}
	const emitted: { [filePath: string]: EmittedFile; } = {};
	Object.values(documents).forEach(document => {
		const { outFilePath, compiled } = emitToJs(
			document,
			files[document.filePath]!,
			'',
			options.runtimeImportPath,
			options.testRuntimeImportPath,
			documents,
			{ checkAssertions: options.checkAssertions });
		emitted[document.filePath] = { outFilePath: outFilePath, js: compiled };
	});
	return { type: 'success', documents: documents, files: emitted };
}

function loadAll(files: SourceFiles): ParsedDocuments {
	const host = createInMemoryHost(files);
	const documents: ParsedDocuments = {};
	Object.keys(files).forEach(filePath => {
		if (!documents[filePath]) {
			loadFile(filePath, documents, host);
		}
	});
	return documents;
}

function getErrors(documents: ParsedDocuments): { [filePath: string]: CompilerError[]; } {
	const errors: { [filePath: string]: CompilerError[]; } = {};
	Object.values(documents).forEach(document => {
		errors[document.filePath] = document.checked?.errors ?? document.syntax.errors;
	});
	return errors;
}

/**
 * TypeScript ist groß (mehrere MB) und wird nur für .ts und .js gebraucht, die der Parser über
 * TypeScript liest. Deshalb erst hier nachgeladen; der Bundler legt es in einen eigenen Chunk.
 */
async function loadTypeScriptIfNeeded(files: SourceFiles): Promise<void> {
	if (isTypeScriptLoaded()) {
		return;
	}
	const needsTypeScript = Object.keys(files).some(filePath =>
		filePath.endsWith(Extension.ts) || filePath.endsWith(Extension.js));
	if (!needsTypeScript) {
		return;
	}
	const module = await import('typescript');
	setTypeScript(module.default);
}
