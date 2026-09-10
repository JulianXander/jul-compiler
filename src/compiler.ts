import { writeFileSync, copyFileSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import webpack from 'webpack';
import { syntaxTreeToJs } from './emitter.js';
import { ParsedDocuments, checkTypes } from './checker/checker.js';
import { parseCode } from './parser/parser.js';
import { CompilerError, CompilerErrorSeverity, CompilerErrorType, errorInfos, Positioned } from './compiler-errors.js';
import { Extension, changeExtension, executingDirectory, readTextFile, tryReadTextFile, tryCreateDirectory } from './util.js';
import { load } from 'js-yaml';
import typescript from 'typescript';
import ShebangPlugin from 'webpack-shebang-plugin';
const { ModuleKind, transpileModule } = typescript;

const runtimeFileName = 'runtime.js';

export function compileProject(
	entryFilePath: string,
	outputFolderPath: string,
	cli: boolean = false,
): void {
	const startTime = performance.now();
	//#region 1. cleanup out
	rmSync(outputFolderPath, { recursive: true, force: true });
	//#endregion 1. cleanup out

	//#region 2. compile
	const runtimePath = resolve(join(outputFolderPath, runtimeFileName));
	const { outFilePath, error } = compileFile({
		sourceFilePath: entryFilePath,
		outputFolderPath: outputFolderPath,
		runtimePath: runtimePath,
		shebang: cli,
	}, {});
	if (error) {
		console.error(error);
		console.log(formatDuration(startTime));
		process.exitCode = 1;
		return;
	}
	if (!outFilePath) {
		console.log(formatDuration(startTime));
		return;
	}
	//#endregion 2. compile

	//#region 3. copy runtime
	const runtimeSourcePath = join(executingDirectory, runtimeFileName);
	copyFileSync(runtimeSourcePath, runtimePath);
	//#endregion 3. copy runtime

	//#region 4. bundle
	process.stdout.write('bundling ');
	const stopSpinner = busySpinner();
	const absoluteOutFilePath = resolve(outFilePath);
	const absoluteFolderPath = resolve(outputFolderPath);
	const bundler = webpack({
		// mode: 'none',
		entry: absoluteOutFilePath,
		optimization: {
			minimize: false
		},
		output: {
			path: absoluteFolderPath,
			filename: 'bundle.js',
		},
		plugins: [
			new ShebangPlugin(),
		],
		target: 'node',
		// resolve: {
		// 	modules: ['node_modules']
		// }
	});
	bundler.run((error, stats) => {
		// console.log(error, stats);
		const hasErrors = stats?.hasErrors();
		stopSpinner();
		if (hasErrors) {
			console.error(colorize('bundling failed.', ConsoleColor.lightRed));
			console.error(stats?.compilation.errors);
			process.exitCode = 1;
		}
		else {
			console.log(colorize('build finished successfully', ConsoleColor.green));
		}
		console.log(formatDuration(startTime));
	});
	//#endregion 4. bundle
}

interface JulCompilerOptions {
	sourceFilePath: string;
	outputFolderPath: string;
	runtimePath: string;
	shebang: boolean;
}

function compileFile(
	options: JulCompilerOptions,
	compiledDocuments: ParsedDocuments,
): {
	/**
	 * undefined wenn schon compiled und bei error.
	 */
	outFilePath?: string;
	error?: string;
} {
	const {
		sourceFilePath,
		outputFolderPath,
		runtimePath,
		shebang,
	} = options;
	if (compiledDocuments[sourceFilePath]) {
		return {};
	}
	console.log(`compiling ${sourceFilePath} ...`);

	//#region 1. read
	const sourceCode = readTextFile(sourceFilePath);
	//#endregion 1. read

	//#region 2. parse
	const parsed = parseCode(sourceCode, sourceFilePath);
	compiledDocuments[sourceFilePath] = parsed;
	const extension = parsed.extension;
	//#endregion 2. parse

	//#region 2b. check parse errors
	// Abbrechen, bevor der Emitter einen unvollständigen Baum zu sehen bekommt.
	// Parser und Checker tolerieren unvollständige Ausdrücke bewusst, damit der Language Server
	// beim Tippen weiterarbeiten kann - für die CLI gilt das nicht.
	// Enthält nicht nur syntax, sondern auch semantic (z.B. File not found, already defined).
	const parseErrors = parsed.unchecked.errors;
	if (parseErrors?.length) {
		return {
			error: formatErrors(parsed.filePath, parseErrors),
		};
	}
	//#endregion 2b. check parse errors

	//#region 3. compile
	let compiled;
	let outFilePath;
	switch (extension) {
		case Extension.js: {
			// copy js file to output folder
			compiled = sourceCode;
			outFilePath = join(outputFolderPath, sourceFilePath);
			break;
		}
		case Extension.json:
		// parse json and write to js in output folder
		case Extension.jul: {
			const expressions = parsed.unchecked.expressions ?? [];
			compiled = syntaxTreeToJs(expressions, runtimePath);
			const jsFileName = changeExtension(sourceFilePath, Extension.js);
			outFilePath = join(outputFolderPath, jsFileName);
			break;
		}
		case Extension.ts: {
			const js = transpileModule(sourceCode, {
				compilerOptions: {
					module: ModuleKind.ESNext
				}
			});
			compiled = js.outputText;
			const jsFileName = changeExtension(sourceFilePath, Extension.js);
			outFilePath = join(outputFolderPath, jsFileName);
			break;
		}
		case Extension.yaml: {
			// parse yaml and write to json in output folder
			// TODO compile
			const parsedYaml = load(sourceCode);
			compiled = JSON.stringify(parsedYaml);
			outFilePath = join(outputFolderPath, sourceFilePath + Extension.json);
			break;
		}
		default: {
			const assertNever: never = extension;
			return { error: `Unexpected extension for compileFile: ${assertNever}` };
		}
	}
	//#endregion 3. compile

	//#region 4. write
	const outDir = dirname(outFilePath);
	tryCreateDirectory(outDir);
	writeFileSync(outFilePath, (shebang ? '#!/usr/bin/env node\n' : '') + compiled);
	//#endregion 4. write

	if (extension === Extension.jul) {
		//#region 5. compile dependencies
		// TODO check cyclic dependencies? sind cyclic dependencies erlaubt/technisch möglich/sinnvoll?
		const importedFilePaths = parsed.dependencies;
		if (importedFilePaths) {
			for (const importedPath of importedFilePaths) {
				const importedResult = compileFile({
					...options,
					shebang: false,
					sourceFilePath: importedPath,
				}, compiledDocuments);
				if (importedResult.error) {
					return importedResult;
				}
			}
		}
		//#endregion 5. compile dependencies

		//#region 6. check
		checkTypes(parsed, compiledDocuments);
		const errors = parsed.checked?.errors;
		if (errors?.length) {
			const formattedErrors = formatErrors(parsed.filePath, errors);
			// Warnungen sagen etwas über den Code, machen das Ergebnis aber nicht unbrauchbar.
			if (errors.some(error => errorInfos[error.code].severity === 'error')) {
				return {
					error: formattedErrors,
				};
			}
			console.log(formattedErrors);
		}
		//#endregion 6. check
	}
	return { outFilePath: outFilePath };
}

/**
 * Anzeigenamen der Fehlerkategorien für die Konsolenausgabe.
 * Als Record über CompilerErrorType, damit eine neue Kategorie hier einen Compile-Fehler erzwingt.
 */
const errorTypeLabels: { [Type in CompilerErrorType]: string; } = {
	syntax: 'Syntax',
	semantic: 'Semantic',
	type: 'Type',
};

const errorSeverityLabels: { [Severity in CompilerErrorSeverity]: string; } = {
	error: 'Error',
	warning: 'Warning',
	hint: 'Hint',
};

/**
 * Formatiert Fehler für die Konsolenausgabe.
 * Row/Column sind intern 0-basiert (Array-Indizes), für die Ausgabe 1-basiert wie in Editoren.
 * Quellcode-Ausschnitt im Rust-Stil: die Position steht nur einmal, in der `-->`-Zeile - nicht
 * zusätzlich in der Kopfzeile (die hatte das vor der Rust-Umstellung, das wäre jetzt Dopplung).
 * `relatedInformation` bekommt keine eigene `-->`-Zeile - ihre Position steckt in der Lage der
 * Markierung selbst, das Label steht direkt hinter dem Marker der zugehörigen Quellzeile.
 */
export function formatErrors(filePath: string, errors: CompilerError[]): string {
	return errors.map(error => {
		const { type, severity } = errorInfos[error.code];
		const errorLabel = colorize(errorTypeLabels[type] + errorSeverityLabels[severity], ConsoleColor.lightRed);
		const errorCode = colorize(`JUL${error.code}`, ConsoleColor.lightRed);
		const mainLine = `${errorLabel} ${errorCode}: ${error.message}`;
		const related = error.relatedInformation;
		const relatedFilePath = related?.filePath ?? filePath;
		const spans: { positioned: Positioned; label: string | undefined; filePath: string }[] = [
			{ positioned: error, label: undefined, filePath },
		];
		if (related) {
			spans.push({ positioned: related, label: related.message, filePath: relatedFilePath });
		}
		// Nach Zeile sortiert, damit relatedInformation vor oder nach der Hauptstelle erscheint,
		// je nachdem, was im Quelltext zuerst steht.
		spans.sort((a, b) => a.positioned.startRowIndex - b.positioned.startRowIndex);
		const gutterWidth = Math.max(...spans.map(span => (span.positioned.endRowIndex + 1).toString().length));
		const lines = [
			mainLine,
			` --> ${filePath}:${error.startRowIndex + 1}:${error.startColumnIndex + 1}`,
			`${' '.repeat(gutterWidth)} |`,
		];
		for (const span of spans) {
			lines.push(...formatSpanLines(getSourceLines(span.filePath), span.positioned, span.label, gutterWidth));
		}
		return lines.join('\n');
	}).join('\n');
}

/**
 * Cache je Datei, damit bei mehreren Fehlern in derselben Datei nicht mehrfach gelesen wird -
 * läuft nur im Fehlerfall, ein Compiler-Lauf ist ohnehin kurzlebig, kein Invalidieren nötig.
 */
const sourceLinesCache = new Map<string, string[]>();
function getSourceLines(filePath: string): string[] {
	const cached = sourceLinesCache.get(filePath);
	if (cached) {
		return cached;
	}
	const lines = tryReadTextFile(filePath)?.split('\n') ?? [];
	sourceLinesCache.set(filePath, lines);
	return lines;
}

/**
 * Quellcode-Zeilen mit Markierung (Rust-Stil): einzeilige Spans bekommen `^^^^^` unter der
 * exakten Spaltenbreite, das optionale Label direkt dahinter. Mehrzeilige Spans bekommen die
 * volle Klammerung mit `|`-Verbindern am linken Rand wie bei rustc.
 */
function formatSpanLines(
	sourceLines: string[],
	positioned: Positioned,
	label: string | undefined,
	gutterWidth: number,
): string[] {
	const startLine = sourceLines[positioned.startRowIndex];
	if (startLine === undefined) {
		return [];
	}
	const pad = (lineNumber: number) => lineNumber.toString().padStart(gutterWidth, ' ');
	const blankGutter = ' '.repeat(gutterWidth);
	const labelSuffix = label ? ` ${label}` : '';
	if (positioned.endRowIndex === positioned.startRowIndex) {
		const markerLength = Math.max(1, positioned.endColumnIndex - positioned.startColumnIndex);
		const marker = '^'.repeat(markerLength) + labelSuffix;
		return [
			`${colorize(pad(positioned.startRowIndex + 1), ConsoleColor.cyan)} | ${startLine}`,
			`${blankGutter} | ${' '.repeat(positioned.startColumnIndex)}${colorize(marker, ConsoleColor.lightRed)}`,
		];
	}
	// Mehrzeiliger Span: Start- und Endzeile bekommen je eine Markierungszeile, die
	// Zwischenzeilen nur den "| |"-Verbinder am linken Rand. Die Markierungszeilen müssen exakt
	// dieselbe Präfixbreite wie die zugehörige Inhaltszeile haben ("|   " bzw. "| | "), sonst
	// verschiebt sich das "^" um eine Spalte gegenüber dem Zeichen, das es markieren soll.
	const resultLines: string[] = [
		`${colorize(pad(positioned.startRowIndex + 1), ConsoleColor.cyan)} |   ${startLine}`,
		`${blankGutter} |   ${colorize('_'.repeat(positioned.startColumnIndex) + '^', ConsoleColor.lightRed)}`,
	];
	const connectorPipe = colorize('|', ConsoleColor.lightRed);
	for (let row = positioned.startRowIndex + 1; row <= positioned.endRowIndex; row++) {
		const line = sourceLines[row];
		if (line === undefined) {
			continue;
		}
		resultLines.push(`${colorize(pad(row + 1), ConsoleColor.cyan)} | ${connectorPipe} ${line}`);
		if (row === positioned.endRowIndex) {
			const marker = `${'_'.repeat(positioned.endColumnIndex)}^${labelSuffix}`;
			resultLines.push(`${blankGutter} | ${connectorPipe} ${colorize(marker, ConsoleColor.lightRed)}`);
		}
	}
	return resultLines;
}
function formatDuration(startTime: number): string {
	const duration = performance.now() - startTime;
	const formatted = duration < 1000
		? `${duration.toFixed(0)}ms`
		: `${(duration / 1000).toFixed(2)}s`;
	return colorize(`compiler took ${formatted}`, ConsoleColor.cyan);
}

function busySpinner() {
	let step = 0;
	// const characters = '⡀⠄⠂⠁⠈⠐⠠⢀';
	const characters = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
	process.stdout.write(characters[0] + ' ');
	const timer = setInterval(() => {
		step++;
		process.stdout.write(`\b\b${characters[step % characters.length]!} `);
		// move back: \x1b[1D
	}, 100);
	return () => {
		clearInterval(timer);
		process.stdout.write('\b\b  \n');
	};
}

// https://askubuntu.com/questions/558280/changing-colour-of-text-and-background-of-terminal
enum ConsoleColor {
	// red = 31,
	green = 32,
	yellow = 33,
	// blue = 34,
	// purple = 35,
	cyan = 36,
	// lightGray = 37,
	// darkGrey = 90,
	lightRed = 91,
	// lightBlue = 94,
	// lightCyan = 96,
}

function colorize(text: any, color: ConsoleColor): string {
	return `\x1b[${color}m${text}\x1b[0m`;
}
