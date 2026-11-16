import { load } from 'js-yaml';
import { basename, dirname, extname, join, relative } from '../path-util.js';
import { RawSourceMap, SourceMapGenerator } from 'source-map';
import { getFileCheckResult } from '../checker/check-result.js';
import { ParsedDocuments } from '../checker/checker.js';
import { ParsedFile } from '../syntax-tree.js';
import { getTypeScript } from '../typescript-module.js';
import { changeExtension, Extension } from '../util.js';
import { EmitOptions, jsonValueToJs, SourceMapping, syntaxTreeToJsWithMappings } from './emitter.js';

/**
 * Der Emit einer einzelnen geladenen Datei, ohne Dateisystem: für die CLI (compiler.ts) und den
 * Browser (browser.ts).
 */

/**
 * Die Map einer emittierten .jul-Datei. sources ist relativ zur Ausgabedatei, sourcesContent trägt
 * den Quelltext mit, damit die Map auch dann stimmt, wenn der Pfad aus Sicht des Debuggers nicht
 * auflöst.
 */
export function createSourceMap(
	mappings: SourceMapping[],
	sourceFilePath: string,
	outFilePath: string,
	sourceCode: string,
): RawSourceMap {
	const source = getSourceMapSource(sourceFilePath, outFilePath);
	const generator = new SourceMapGenerator({ file: basename(outFilePath) });
	generator.setSourceContent(source, sourceCode);
	mappings.forEach(mapping => {
		generator.addMapping({
			source: source,
			generated: { line: mapping.generatedLine + 1, column: mapping.generatedColumn },
			original: { line: mapping.sourceLine + 1, column: mapping.sourceColumn },
		});
	});
	// toJSON fehlt in den Typen von source-map 0.6, toString ist dessen JSON.stringify.
	return JSON.parse(generator.toString());
}

function getSourceMapSource(sourceFilePath: string, outFilePath: string): string {
	return relative(dirname(outFilePath), sourceFilePath).replaceAll('\\', '/');
}

/**
 * Die Ausgabe einer geladenen, fehlerfreien Datei und wohin sie gehört, ohne zu schreiben.
 * sourceMap nur für .jul und .ts, das angehängte sourceMappingURL ist Sache des Aufrufers.
 */
export function emitToJs(
	parsed: ParsedFile,
	sourceCode: string,
	outputFolderPath: string,
	runtimeImportPath: string,
	testRuntimeImportPath: string,
	documents: ParsedDocuments,
	options: Omit<EmitOptions, 'hasDefaultExport'> = {},
): { outFilePath: string; compiled: string; sourceMap?: RawSourceMap; runtimeNames: string[]; } {
	const sourceFilePath = parsed.filePath;
	let compiled: string;
	// Nur .jul und .json importieren die Runtime.
	let runtimeNames: string[] = [];
	const outFilePath = getOutFilePath(sourceFilePath, outputFolderPath);
	let sourceMap: RawSourceMap | undefined;
	const extension = parsed.extension;
	switch (extension) {
		case Extension.js: {
			// copy js file to output folder
			compiled = sourceCode;
			break;
		}
		case Extension.json:
		// parse json and write to js in output folder
		case Extension.jul: {
			if (parsed.untyped
				&& extension === Extension.json) {
				// Kein Syntaxbaum, das JS entsteht direkt aus dem geparsten Wert.
				compiled = jsonValueToJs(parsed.jsonValue);
				break;
			}
			// checkResult trägt die typeInfo, die der Emitter für billigere Laufzeittests braucht. Ohne
			// Check ein leeres Ergebnis: dann ohne Typen.
			const expressions = (parsed.checked ?? parsed.syntax).expressions ?? [];
			const emitted = syntaxTreeToJsWithMappings(getFileCheckResult(parsed), expressions, runtimeImportPath, sourceFilePath, testRuntimeImportPath, {
				...options,
				// Der Loader hat jede importierte Datei vor dem Emit geladen, unter demselben Pfad.
				hasDefaultExport: importedPath => {
					const imported = documents[join(parsed.sourceFolder, importedPath)];
					if (!imported) {
						throw new Error(`Imported file not loaded: ${importedPath}`);
					}
					return imported.hasDefaultExport;
				},
			});
			compiled = emitted.js;
			runtimeNames = emitted.runtimeNames;
			if (extension === Extension.jul) {
				sourceMap = createSourceMap(emitted.mappings, sourceFilePath, outFilePath, sourceCode);
			}
			break;
		}
		case Extension.ts: {
			const { ModuleKind, transpileModule } = getTypeScript();
			const js = transpileModule(sourceCode, {
				compilerOptions: {
					module: ModuleKind.ESNext,
					sourceMap: true,
				},
				fileName: basename(sourceFilePath),
			});
			// transpileModule hängt selbst ein sourceMappingURL an, auf eine Datei, die es nicht
			// schreibt.
			compiled = js.outputText.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
			const tsSourceMap: RawSourceMap = JSON.parse(js.sourceMapText!);
			sourceMap = {
				...tsSourceMap,
				file: basename(outFilePath),
				sources: [getSourceMapSource(sourceFilePath, outFilePath)],
				sourcesContent: [sourceCode],
			};
			break;
		}
		case Extension.yaml: {
			// parse yaml and write to json in output folder
			// TODO compile
			const parsedYaml = load(sourceCode);
			compiled = JSON.stringify(parsedYaml);
			break;
		}
		default: {
			const assertNever: never = extension;
			throw new Error(`Unexpected extension for emitToJs: ${assertNever}`);
		}
	}
	return { outFilePath: outFilePath, compiled: compiled, sourceMap: sourceMap, runtimeNames: runtimeNames };
}

/**
 * Pfad der Ausgabedatei zu einer Quelldatei: .js wird kopiert, .yaml wird zu .yaml.json, alles
 * andere zu .js. Gegenstück zum Umschreiben der Importpfade im Emitter (getPathFromImport).
 */
export function getOutFilePath(sourceFilePath: string, outputFolderPath: string): string {
	const extension = extname(sourceFilePath);
	switch (extension) {
		case Extension.js:
			return join(outputFolderPath, sourceFilePath);
		case Extension.yaml:
			return join(outputFolderPath, sourceFilePath + Extension.json);
		default:
			return join(outputFolderPath, changeExtension(sourceFilePath, Extension.js));
	}
}
