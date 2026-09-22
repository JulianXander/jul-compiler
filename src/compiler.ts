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
	checkOnly: boolean = false,
): void {
	const startTime = performance.now();
	const renderer = new LiveRenderer();
	renderer.start(entryFilePath);
	//#region 1. cleanup out
	// Bei checkOnly entsteht kein Output, also auch nichts aufzuräumen.
	if (!checkOnly) {
		rmSync(outputFolderPath, { recursive: true, force: true });
	}
	//#endregion 1. cleanup out

	//#region 2. compile
	const runtimePath = resolve(join(outputFolderPath, runtimeFileName));
	renderer.startStep('compiling');
	const { outFilePath, error } = compileFile({
		sourceFilePath: entryFilePath,
		outputFolderPath: outputFolderPath,
		runtimePath: runtimePath,
		shebang: cli,
		checkOnly,
	}, {}, renderer);
	renderer.finishStep(error ? 'failed' : 'done');
	if (error) {
		// Mehrzeiliger, detaillierter Fehlertext gehört wie Warnungen ins Scrollback oberhalb des
		// Frames (siehe log()) - nur die kurze Statuszeile (mit Dauer) steht im Frame, analog zu
		// "build/check finished successfully" im Erfolgsfall.
		renderer.log(error);
		renderer.finish([`${colorize('compiling failed.', ConsoleColor.lightRed)} ${durationSuffix(startTime)}`]);
		process.exitCode = 1;
		return;
	}
	if (checkOnly) {
		renderer.finish([`${colorize('check finished successfully', ConsoleColor.green)} ${durationSuffix(startTime)}`]);
		return;
	}
	if (!outFilePath) {
		renderer.finish([durationSuffix(startTime)]);
		return;
	}
	//#endregion 2. compile

	//#region 3. copy runtime
	const runtimeSourcePath = join(executingDirectory, runtimeFileName);
	copyFileSync(runtimeSourcePath, runtimePath);
	//#endregion 3. copy runtime

	//#region 4. bundle
	renderer.startStep('bundling');
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
		renderer.finishStep(hasErrors ? 'failed' : 'done');
		if (hasErrors) {
			renderer.finish([`${colorize('bundling failed.', ConsoleColor.lightRed)} ${durationSuffix(startTime)}`]);
			console.error(stats?.compilation.errors);
			process.exitCode = 1;
		}
		else {
			renderer.finish([`${colorize('build finished successfully', ConsoleColor.green)} ${durationSuffix(startTime)}`]);
		}
	});
	//#endregion 4. bundle
}

interface JulCompilerOptions {
	sourceFilePath: string;
	outputFolderPath: string;
	runtimePath: string;
	shebang: boolean;
	/**
	 * Nur parsen und checken, kein JS erzeugen/schreiben und kein Bundling.
	 */
	checkOnly: boolean;
}

interface CompileFileResult {
	/**
	 * undefined wenn schon compiled und bei error.
	 */
	outFilePath?: string;
	error?: string;
}

function compileFile(
	options: JulCompilerOptions,
	compiledDocuments: ParsedDocuments,
	renderer: LiveRenderer,
): CompileFileResult {
	const {
		sourceFilePath,
		outputFolderPath,
		runtimePath,
		shebang,
		checkOnly,
	} = options;
	if (compiledDocuments[sourceFilePath]) {
		return {};
	}
	// Einzelne Dateien sind kein eigener Checklisten-Schritt (das bleibt den großen Schritten wie
	// "compiling" und "bundling" vorbehalten), sondern nur die Detailanzeige neben dem laufenden
	// Schritt.
	renderer.updateDetail(sourceFilePath);

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
	// Bei checkOnly entfallen Emit und Write komplett - nur .jul-Dateien werden unten noch
	// dependency-rekursiv geparst und gecheckt, für die anderen Extensions gibt es ohne Emit
	// nichts zu tun (sie werden sonst nur unverändert bzw. transpiliert kopiert).
	let outFilePath: string | undefined;
	if (!checkOnly) {
		let compiled;
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
	}

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
				}, compiledDocuments, renderer);
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
			renderer.log(formattedErrors);
		}
		//#endregion 6. check
	}
	return { outFilePath: outFilePath };
}

//#region rendering

// https://askubuntu.com/questions/558280/changing-colour-of-text-and-background-of-terminal
export enum ConsoleColor {
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
 * Farbe je Fehler-Schweregrad für die Konsolenausgabe.
 * Als Record über CompilerErrorSeverity, damit eine neue Stufe hier einen Compile-Fehler erzwingt.
 */
const errorSeverityColors: { [Severity in CompilerErrorSeverity]: ConsoleColor; } = {
	error: ConsoleColor.lightRed,
	warning: ConsoleColor.yellow,
	hint: ConsoleColor.green,
};

/**
 * Formatiert Fehler für die Konsolenausgabe.
 * Row/Column sind intern 0-basiert (Array-Indizes), für die Ausgabe 1-basiert wie in Editoren.
 * Position steht sowohl am Ende der ersten Zeile als auch in der `-->`-Zeile: bei kurzen
 * Meldungen wäre das Dopplung, aber die mehrzeiligen, verschachtelten Ketten liegen oft 5+
 * Zeilen von der `-->`-Zeile entfernt - ohne Wiederholung liesse die Kopfzeile allein keinen
 * Rückschluss auf die Stelle zu (Session 2026-09-10). Am Zeilenende statt davor, damit die
 * eigentliche Meldung zuerst lesbar ist.
 * `relatedInformation` bekommt keine eigene `-->`-Zeile - ihre Position steckt in der Lage der
 * Markierung selbst, das Label steht direkt hinter dem Marker der zugehörigen Quellzeile.
 */
export function formatErrors(filePath: string, errors: CompilerError[]): string {
	return errors.map(error => {
		const { type, severity } = errorInfos[error.code];
		const severityColor = errorSeverityColors[severity];
		const errorLabel = colorize(errorTypeLabels[type] + errorSeverityLabels[severity], severityColor);
		const errorCode = colorize(`JUL${error.code}`, severityColor);
		const position = colorize(`${filePath}:${error.startRowIndex + 1}:${error.startColumnIndex + 1}`, ConsoleColor.cyan);
		// Position steht hier zusätzlich zur `-->`-Zeile unten - bei den mehrzeiligen,
		// verschachtelten Ketten (elaborateDictionaryLiteralError-Nachfolger) liegen oft 5+
		// Zeilen dazwischen, die Kopfzeile allein liesse dann keinen Rückschluss auf die Stelle
		// zu. Redundanz ist hier bewusst in Kauf genommen (Session 2026-09-10). Steht am Ende der
		// ersten Zeile (nicht davor), damit die Meldung selbst zuerst lesbar ist.
		const [firstMessageLine, ...restMessageLines] = error.message.split('\n');
		const mainLine = [
			`${errorLabel} ${errorCode}: ${firstMessageLine} ${position}`,
			...restMessageLines,
		].join('\n');
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
			` --> ${colorize(`${filePath}:${error.startRowIndex + 1}:${error.startColumnIndex + 1}`, ConsoleColor.cyan)}`,
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
 * JUL-Quellcode ist tabseingerückt (CLAUDE.md), Tabs stehen aber nur am Zeilenanfang - reine
 * Zeichenbreite von 1 pro Tab reicht deshalb nicht: das Terminal expandiert jeden Tab auf mehrere
 * Spalten, die interne Spaltenposition (1 Zeichen = 1 Spalte) läuft dann dem sichtbaren Text
 * davon. `visualColumn` rechnet eine Roh-Spaltenposition in die sichtbare Spalte um, `expandTabs`
 * macht dasselbe für die dargestellte Zeile.
 */
const tabWidth = 2; // editor.tabSize der vscode-Extension (package.json)
function expandTabs(line: string): string {
	return line.replaceAll('\t', ' '.repeat(tabWidth));
}
function visualColumn(line: string, columnIndex: number): number {
	let column = 0;
	for (let i = 0; i < columnIndex; i++) {
		column += line[i] === '\t' ? tabWidth : 1;
	}
	return column;
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
		const startColumn = visualColumn(startLine, positioned.startColumnIndex);
		const endColumn = visualColumn(startLine, positioned.endColumnIndex);
		const markerLength = Math.max(1, endColumn - startColumn);
		const marker = '^'.repeat(markerLength) + labelSuffix;
		return [
			`${colorize(pad(positioned.startRowIndex + 1), ConsoleColor.cyan)} | ${expandTabs(startLine)}`,
			`${blankGutter} | ${' '.repeat(startColumn)}${colorize(marker, ConsoleColor.lightRed)}`,
		];
	}
	// Mehrzeiliger Span: Start- und Endzeile bekommen je eine Markierungszeile, die
	// Zwischenzeilen nur den "| |"-Verbinder am linken Rand. Die Markierungszeilen müssen exakt
	// dieselbe Präfixbreite wie die zugehörige Inhaltszeile haben ("|   " bzw. "| | "), sonst
	// verschiebt sich das "^" um eine Spalte gegenüber dem Zeichen, das es markieren soll.
	const resultLines: string[] = [
		`${colorize(pad(positioned.startRowIndex + 1), ConsoleColor.cyan)} |   ${expandTabs(startLine)}`,
		`${blankGutter} |   ${colorize('_'.repeat(visualColumn(startLine, positioned.startColumnIndex)) + '^', ConsoleColor.lightRed)}`,
	];
	const connectorPipe = colorize('|', ConsoleColor.lightRed);
	for (let row = positioned.startRowIndex + 1; row <= positioned.endRowIndex; row++) {
		const line = sourceLines[row];
		if (line === undefined) {
			continue;
		}
		resultLines.push(`${colorize(pad(row + 1), ConsoleColor.cyan)} | ${connectorPipe} ${expandTabs(line)}`);
		if (row === positioned.endRowIndex) {
			// endColumnIndex ist exklusiv, der Caret gehört unter das letzte Zeichen des Spans.
			const lastColumn = positioned.endColumnIndex > 0
				? visualColumn(line, positioned.endColumnIndex - 1)
				: 0;
			const marker = `${'_'.repeat(lastColumn)}^${labelSuffix}`;
			resultLines.push(`${blankGutter} | ${connectorPipe} ${colorize(marker, ConsoleColor.lightRed)}`);
		}
	}
	return resultLines;
}

function formatMs(durationMs: number): string {
	return durationMs < 1000
		? `${durationMs.toFixed(0)}ms`
		: `${(durationMs / 1000).toFixed(2)}s`;
}

/**
 * Dauer seit startTime, in Klammern und cyan - das Suffix, das sowohl je Checklisten-Schritt
 * (LiveRenderer.finishStep) als auch an den Abschlusszeilen in compileProject angehängt wird.
 */
function durationSuffix(startTime: number): string {
	return colorize(`(${formatMs(performance.now() - startTime)})`, ConsoleColor.cyan);
}


export function colorize(text: any, color: ConsoleColor): string {
	if (!process.stdout.isTTY) {
		return String(text);
	}
	return `\x1b[${color}m${text}\x1b[0m`;
}

const logoLines = [
	'        ████    ████',
	'        ████    ████',
	'        ████    ████',
	'        ████    ████',
	'████    ████    ████',
	'y███▄  ▄████▄  ▄████▄',
	'▝███████████████████████████',
	'  xx▀▀▀▀x  x▀▀▀▀x  x▀▀▀▀▀▀▀▀',
];
const logoWidth = Math.max(...logoLines.map(line => line.length));

/**
 * "Oberes Viertel"-Blockzeichen (U+1FB82) fehlt in vielen Terminal-Fonts, weil es erst mit
 * Unicode 13 im Legacy-Computing-Block nachgereicht wurde. Ersatz: das überall vorhandene
 * komplementäre Zeichen ▆ (unteres Dreiviertel, U+2586) mit Reverse-Video (SGR 7) umgekehrt -
 * dadurch tauschen Vorder- und Hintergrund, ohne dass die Terminal-Hintergrundfarbe bekannt sein
 * muss. `x` in logoLines ist der Platzhalter dafür.
 */
const upperQuarterBlock = '\x1b[7m▆\x1b[27m';
/**
 * "Rechtes Dreiviertel"-Block gibt es gar nicht als eigenes Unicode-Zeichen - der Block-Elements-
 * Bereich hat rechtsseitig nur Half und One-Eighth. Ersatz nach demselben Reverse-Video-Prinzip:
 * das komplementäre ▎ (linkes Viertel, U+258E) umgekehrt. `y` in logoLines ist der Platzhalter.
 */
const rightThreeQuarterBlock = '\x1b[7m▎\x1b[27m';
const spinnerCharacters = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

/**
 * Zeichnet während eines Compile-Laufs einen Frame mit dem Logo links und einer daneben
 * wachsenden Häkchen-Liste. Checklisten-Einträge sind nur die großen Schritte ("compiling",
 * "bundling"); einzelne kompilierte Dateien sind kein eigener Schritt, sondern nur ein
 * Status-Detail neben dem laufenden Schritt (siehe updateDetail) - sonst würde die Liste bei
 * vielen Dateien unübersichtlich wachsen. Nur die aktuell laufende Zeile wird per Spinner
 * überschrieben. Im nicht-interaktiven Fall (kein TTY, z.B. CI/Umleitung) degradiert das auf
 * einfache, sequentielle Zeilen ohne Logo/Cursor-Codes, weil ANSI-Cursorbewegung dort nicht
 * sinnvoll ist.
 */
export class LiveRenderer {
	private readonly isTty = !!process.stdout.isTTY;
	private entryLine = '';
	private readonly doneSteps: string[] = [];
	private currentStepLabel: string | undefined;
	private currentDetail: string | undefined;
	private currentStepStartTime = 0;
	private spinnerIndex = 0;
	private spinnerTimer: NodeJS.Timeout | undefined;
	private frameHeight = 0;

	start(entryFilePath: string): void {
		this.entryLine = `entry file: ${entryFilePath}`;
		if (!this.isTty) {
			console.log(`Compiler started with entry file ${entryFilePath} ...`);
			return;
		}
		this.spinnerTimer = setInterval(() => {
			this.spinnerIndex++;
			this.render();
		}, 100);
		this.render();
	}

	startStep(label: string): void {
		this.currentStepLabel = label;
		this.currentDetail = undefined;
		this.currentStepStartTime = performance.now();
		if (!this.isTty) {
			console.log(`${label} ...`);
			return;
		}
		this.render();
	}

	/**
	 * Aktualisiert die Detailanzeige neben dem laufenden Schritt (z.B. die aktuell kompilierte
	 * Datei), ohne einen eigenen Checklisten-Eintrag zu erzeugen.
	 */
	updateDetail(detail: string): void {
		this.currentDetail = detail;
		if (!this.isTty) {
			console.log(`${this.currentStepLabel} ${detail} ...`);
			return;
		}
		this.render();
	}

	finishStep(status: 'done' | 'failed'): void {
		const label = this.currentStepLabel;
		const duration = durationSuffix(this.currentStepStartTime);
		this.currentStepLabel = undefined;
		this.currentDetail = undefined;
		if (!this.isTty || !label) {
			return;
		}
		const icon = status === 'done' ? colorize('✓', ConsoleColor.green) : colorize('✗', ConsoleColor.lightRed);
		this.doneSteps.push(`${icon} ${label} ${duration}`);
		this.render();
	}

	/**
	 * Für Ausgaben, die dauerhaft im Scrollback stehen bleiben sollen (z.B. Warnungen), während
	 * der Live-Frame darunter weiterläuft.
	 */
	log(text: string): void {
		if (!this.isTty) {
			console.log(text);
			return;
		}
		this.erase();
		console.log(text);
		// erase() hat den alten Frame bereits gelöscht - frameHeight zurücksetzen, sonst würde
		// render() gleich erneut (mit der alten Höhe) nach oben löschen und dabei den gerade
		// gedruckten Text mit abschneiden.
		this.frameHeight = 0;
		this.render();
	}

	stop(): void {
		if (this.spinnerTimer) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = undefined;
		}
	}

	/**
	 * Beendet den Live-Frame: die übergebenen Abschlusszeilen (Erfolgs-/Fehlermeldung, Dauer)
	 * werden noch in denselben Frame aufgenommen, direkt unter der Checkliste rechts neben dem
	 * Logo (bzw. darunter, sobald das Logo aufgebraucht ist) - nicht als separate Ausgabe danach.
	 */
	finish(lines: string[]): void {
		this.stop();
		if (!this.isTty) {
			for (const line of lines) {
				console.log(line);
			}
			return;
		}
		for (const line of lines) {
			this.doneSteps.push(...line.split('\n'));
		}
		this.render();
	}

	private buildLines(): string[] {
		const checklist = [this.entryLine, ...this.doneSteps];
		if (this.currentStepLabel) {
			const spinnerChar = spinnerCharacters[this.spinnerIndex % spinnerCharacters.length];
			const detailSuffix = this.currentDetail ? ` (${this.currentDetail})` : '';
			checklist.push(`${spinnerChar} ${this.currentStepLabel}${detailSuffix} ...`);
		}
		const rowCount = Math.max(logoLines.length, checklist.length);
		const lines: string[] = [];
		for (let i = 0; i < rowCount; i++) {
			const checklistPart = checklist[i] ?? '';
			if (i < logoLines.length) {
				// x/y-Platzhalter erst NACH padEnd ersetzen, damit die Breitenberechnung auf den
				// reinen Zeichen basiert statt auf den unsichtbaren ANSI-Codes der Ersatzzeichen.
				const logoText = logoLines[i]!.padEnd(logoWidth, ' ')
					.replaceAll('x', upperQuarterBlock)
					.replaceAll('y', rightThreeQuarterBlock);
				const logoPart = colorize(logoText, ConsoleColor.yellow);
				lines.push(checklistPart ? `${logoPart}  ${checklistPart}` : logoPart);
			}
			else {
				lines.push(checklistPart);
			}
		}
		return lines;
	}

	private erase(): void {
		if (this.frameHeight > 0) {
			process.stdout.write(`\x1b[${this.frameHeight}A\x1b[0J`);
		}
	}

	private render(): void {
		this.erase();
		const lines = this.buildLines();
		process.stdout.write(lines.join('\n') + '\n');
		this.frameHeight = lines.length;
	}
}

//#endregion rendering