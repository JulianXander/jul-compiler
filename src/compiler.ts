import { writeFileSync, copyFileSync, rmSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import webpack from 'webpack';
import { syntaxTreeToJs } from './emitter.js';
import { ParsedDocuments } from './checker/checker.js';
import { CompilerError, CompilerErrorSeverity, CompilerErrorType, errorInfos, Positioned } from './compiler-errors.js';
import { createFileSystemHost, loadFile, ProjectHost } from './project-loader.js';
import { ParsedFile } from './syntax-tree.js';
import { Extension, changeExtension, executingDirectory, tryReadTextFile, tryCreateDirectory } from './util.js';
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

	//#region 2. load
	// Parst und checkt alle Dateien samt Abhängigkeiten, jede Endung - derselbe Weg wie im
	// Language Server (project-loader.ts). Die gelesenen Texte bleiben für den Emit erhalten.
	renderer.startStep('compiling');
	const sourceCodes = new Map<string, string>();
	const fileSystemHost = createFileSystemHost();
	const host: ProjectHost = {
		readSource: filePath => {
			// Einzelne Dateien sind kein eigener Checklisten-Schritt (das bleibt den großen
			// Schritten wie "compiling" und "bundling" vorbehalten), sondern nur die
			// Detailanzeige neben dem laufenden Schritt.
			renderer.updateDetail(filePath);
			const readResult = fileSystemHost.readSource(filePath);
			if (readResult.type === 'code') {
				sourceCodes.set(filePath, readResult.code);
			}
			return readResult;
		},
	};
	const documents: ParsedDocuments = {};
	const entry = loadFile(entryFilePath, documents, host);
	//#endregion 2. load

	//#region 3. report errors
	// Die Fehler aller Dateien, nicht nur die der ersten fehlerhaften (wie tsc). checked enthält
	// die Parse-Fehler schon (Klon von unchecked), deshalb nicht beide Listen.
	// Gezählt für die Abschlusszeile. Hinweise zählen nicht mit, sie sind keine Beanstandung.
	let errorCount = entry === 'notFound' ? 1 : 0;
	let warningCount = 0;
	const formattedErrors = entry === 'notFound'
		? [`File not found: ${entryFilePath}`]
		: [];
	Object.values(documents).forEach(document => {
		const errors = document.checked?.errors ?? document.unchecked.errors;
		if (!errors.length) {
			return;
		}
		// Warnungen sagen etwas über den Code, machen das Ergebnis aber nicht unbrauchbar.
		errors.forEach(error => {
			const { severity } = errorInfos[error.code];
			if (severity === 'error') {
				errorCount++;
			}
			else if (severity === 'warning') {
				warningCount++;
			}
		});
		formattedErrors.push(formatErrors(document.filePath, errors));
	});
	const hasError = errorCount > 0;
	const summary = formatSummary(Object.keys(documents).length, errorCount, warningCount);
	renderer.finishStep(hasError ? 'failed' : 'done');
	// Mehrzeiliger, detaillierter Fehlertext gehört wie Warnungen ins Scrollback oberhalb des
	// Frames (siehe log()) - nur die kurze Statuszeile (mit Dauer) steht im Frame, analog zu
	// "build/check finished successfully" im Erfolgsfall.
	if (formattedErrors.length) {
		renderer.log(formattedErrors.join('\n'));
	}
	if (hasError) {
		renderer.finish([`${colorize('compiling failed', ConsoleColor.lightRed)} ${summary} ${durationSuffix(startTime)}`]);
		process.exitCode = 1;
		return;
	}
	if (checkOnly) {
		renderer.finish([`${colorize('check finished successfully', ConsoleColor.green)} ${summary} ${durationSuffix(startTime)}`]);
		return;
	}
	//#endregion 3. report errors

	//#region 4. emit
	renderer.startStep('emitting');
	const runtimePath = resolve(join(outputFolderPath, runtimeFileName));
	let outFilePath: string | undefined;
	Object.values(documents).forEach(document => {
		const isEntry = document.filePath === entryFilePath;
		const fileOutPath = emitFile(document, sourceCodes.get(document.filePath)!, outputFolderPath, runtimePath, cli && isEntry);
		if (isEntry) {
			outFilePath = fileOutPath;
		}
	});
	renderer.finishStep('done');
	//#endregion 4. emit

	//#region 5. copy runtime
	const runtimeSourcePath = join(executingDirectory, runtimeFileName);
	copyFileSync(runtimeSourcePath, runtimePath);
	//#endregion 5. copy runtime

	//#region 6. bundle
	renderer.startStep('bundling');
	const absoluteOutFilePath = resolve(outFilePath!);
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
			renderer.finish([`${colorize('bundling failed', ConsoleColor.lightRed)} ${summary} ${durationSuffix(startTime)}`]);
			console.error(stats?.compilation.errors);
			process.exitCode = 1;
		}
		else {
			// Pfad und Größe des Ergebnisses, damit ein unerwartet großes Bundle (z.B. ein
			// versehentlich mitgebündelter Import) sofort auffällt.
			const bundlePath = join(absoluteFolderPath, 'bundle.js');
			const bundleSize = formatBytes(statSync(bundlePath).size);
			renderer.finish([
				`${colorize('build finished successfully', ConsoleColor.green)} ${summary} ${durationSuffix(startTime)}`,
				`${relative(process.cwd(), bundlePath)}  ${colorize(bundleSize, ConsoleColor.cyan)}`,
			]);
		}
	});
	//#endregion 6. bundle
}

/**
 * Schreibt die Ausgabe einer geladenen, fehlerfreien Datei und liefert deren Pfad.
 */
function emitFile(
	parsed: ParsedFile,
	sourceCode: string,
	outputFolderPath: string,
	runtimePath: string,
	shebang: boolean,
): string {
	const sourceFilePath = parsed.filePath;
	let compiled: string;
	let outFilePath: string;
	const extension = parsed.extension;
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
			throw new Error(`Unexpected extension for emitFile: ${assertNever}`);
		}
	}
	const outDir = dirname(outFilePath);
	tryCreateDirectory(outDir);
	writeFileSync(outFilePath, (shebang ? '#!/usr/bin/env node\n' : '') + compiled);
	return outFilePath;
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
 * Kurzfassung für die Abschlusszeile, z.B. "- 3 files, 2 warnings". Fehler und Warnungen erscheinen
 * nur, wenn es welche gibt, damit die Erfolgszeile im Normalfall kurz bleibt.
 */
function formatSummary(fileCount: number, errorCount: number, warningCount: number): string {
	const parts = [pluralize(fileCount, 'file')];
	if (errorCount) {
		parts.push(pluralize(errorCount, 'error'));
	}
	if (warningCount) {
		parts.push(pluralize(warningCount, 'warning'));
	}
	return `- ${parts.join(', ')}`;
}

function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Dezimale Einheiten (1 kB = 1000 B) wie bei esbuild und Vite.
 */
function formatBytes(byteCount: number): string {
	return byteCount < 1000
		? `${byteCount} B`
		: `${(byteCount / 1000).toFixed(1)} kB`;
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
	'        ▄▄▄▄    ▄▄▄▄',
	'        ████    ████',
	'        ████    ████',
	'        ████    ████',
	'████▄  ▄████▄  ▄████▄',
	'▝███████████████████████████',
	'  ▔x▀▀▀▀x  x▀▀▀▀x  x▀▀▀▀▀▀▀▀',
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
const spinnerCharacters = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const spinnerFrameMs = 100;

//#region Farbwelle

/**
 * Über das Logo wandert diagonal ein heller Streifen auf der Grundfarbe. Die Position eines
 * Zeichens zählt die Zeile doppelt, weil Terminalzellen etwa doppelt so hoch wie breit sind -
 * sonst wäre die Diagonale zu steil.
 */
type Rgb = readonly [number, number, number];
const waveBaseColor: Rgb = [230, 200, 0];
const waveHighlightColor: Rgb = [255, 250, 180];
/** Zellen pro Sekunde */
const waveSpeed = 35;
/**
 * Abstand zweier Streifen in Zellen: genau die diagonale Ausdehnung des Logos (siehe
 * waveIntensity), damit der nächste Streifen oben links einsetzt, wenn der vorige unten rechts
 * austritt - ohne Pause dazwischen.
 */
const wavePeriod = logoWidth + 2 * logoLines.length;
/** Standardabweichung der Glockenkurve, die den Streifen formt, in Zellen */
const waveWidth = 4;
const waveFrameMs = 40;

/**
 * 0 = Grundfarbe, 1 = Mitte des Streifens.
 */
function waveIntensity(column: number, row: number, elapsedMs: number): number {
	const position = column + 2 * row;
	const offset = position - waveSpeed * elapsedMs / 1000;
	const wrapped = ((offset % wavePeriod) + wavePeriod) % wavePeriod;
	// Abstand zur nächstgelegenen Streifenmitte, egal ob davor oder dahinter
	const distance = Math.min(wrapped, wavePeriod - wrapped);
	return Math.exp(-(distance ** 2) / (2 * waveWidth ** 2));
}

function mixColor(intensity: number): Rgb {
	return waveBaseColor.map((base, i) =>
		Math.round(base + (waveHighlightColor[i]! - base) * intensity)) as unknown as Rgb;
}

/**
 * Vordergrundfarbe passend zur Farbtiefe des Terminals: Truecolor, sonst der 6x6x6-Würfel der
 * 256er-Palette, sonst nur Gelb und helles Gelb.
 */
function foregroundCode(intensity: number, colorDepth: number): string {
	if (colorDepth < 8) {
		return intensity > 0.5 ? '\x1b[93m' : '\x1b[33m';
	}
	const [r, g, b] = mixColor(intensity);
	if (colorDepth >= 24) {
		return `\x1b[38;2;${r};${g};${b}m`;
	}
	const toCube = (value: number) => Math.round(value / 255 * 5);
	return `\x1b[38;5;${16 + 36 * toCube(r) + 6 * toCube(g) + toCube(b)}m`;
}

/**
 * elapsedMs undefined zeichnet das ruhende Logo, einheitlich in der Grundfarbe der Welle.
 */
function renderLogoLine(row: number, elapsedMs: number | undefined, colorDepth: number): string {
	const line = logoLines[row]!.padEnd(logoWidth, ' ');
	let result = '';
	for (let column = 0; column < line.length; column++) {
		const character = line[column]!;
		if (character === ' ') {
			result += ' ';
			continue;
		}
		const intensity = elapsedMs === undefined ? 0 : waveIntensity(column, row, elapsedMs);
		result += foregroundCode(intensity, colorDepth)
			+ (character === 'x' ? upperQuarterBlock : character);
	}
	return result + '\x1b[39m';
}

//#endregion Farbwelle

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
	// getColorDepth gibt es nur an echten TTY-Streams, nicht an einem nachträglich als TTY
	// markierten Stream (z.B. im Test) - dann bleibt es bei den 16 Grundfarben.
	private readonly colorDepth = this.isTty ? process.stdout.getColorDepth?.() ?? 4 : 1;
	private readonly animationStartTime = performance.now();
	private spinnerTimer: NodeJS.Timeout | undefined;
	private animationFinished = false;
	private frameHeight = 0;

	start(entryFilePath: string): void {
		this.entryLine = `entry file: ${entryFilePath}`;
		if (!this.isTty) {
			console.log(`Compiler started with entry file ${entryFilePath} ...`);
			return;
		}
		this.spinnerTimer = setInterval(() => {
			this.render();
		}, waveFrameMs);
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
			// Letzter Frame mit ruhendem Logo, sonst bliebe die Welle an einer zufälligen Stelle
			// stehen.
			this.animationFinished = true;
			this.render();
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
		const elapsedMs = performance.now() - this.animationStartTime;
		const checklist = [this.entryLine, ...this.doneSteps];
		if (this.currentStepLabel) {
			const spinnerIndex = Math.floor(elapsedMs / spinnerFrameMs);
			const spinnerChar = spinnerCharacters[spinnerIndex % spinnerCharacters.length];
			const detailSuffix = this.currentDetail ? ` (${this.currentDetail})` : '';
			checklist.push(`${spinnerChar} ${this.currentStepLabel}${detailSuffix} ...`);
		}
		const rowCount = Math.max(logoLines.length, checklist.length);
		const lines: string[] = [];
		for (let i = 0; i < rowCount; i++) {
			const checklistPart = checklist[i] ?? '';
			if (i < logoLines.length) {
				const logoPart = renderLogoLine(i, this.animationFinished ? undefined : elapsedMs, this.colorDepth);
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
		const lines = this.buildLines();
		const eraseSequence = this.frameHeight > 0 ? `\x1b[${this.frameHeight}A\x1b[0J` : '';
		// Synchronized Output (DEC 2026): das Terminal zeigt Löschen und Neuzeichnen als einen
		// Frame an, sonst flackert das Logo bei jedem Farbwechsel. Terminals ohne Unterstützung
		// ignorieren die Sequenz.
		process.stdout.write(`\x1b[?2026h${eraseSequence}${lines.join('\n')}\n\x1b[?2026l`);
		this.frameHeight = lines.length;
	}
}

//#endregion rendering