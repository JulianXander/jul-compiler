import { readdirSync, readFileSync, statSync } from 'fs';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { basename, join, resolve } from 'path';

import { checkerStats, checkTypes, ParsedDocuments, resetCheckerStats } from '../src/checker/checker.js';
import { parseCode } from '../src/parser/parser.js';
import {
	alarmingDeviation,
	appendEntries,
	BenchResult,
	formatResult,
	getDeviation,
	getDrift,
	getMachine,
	isComparable,
	noticeableDeviation,
	parseArgs,
	readPrevious,
	stats,
} from './bench-log.js';

/**
 * Wall-Clock Messung von parse + check. Kein Test-Gate, nur Beleg für Umbauten am Checker.
 * Aufruf: npm run bench [--save] [--note "grund"] [ordner...]
 * Mit --save wird die Messung an scripts/bench-log-compiler.tsv angehängt, ohne nur verglichen.
 */

const runCount = 5;
const logPath = resolve(import.meta.dirname, 'bench-log-compiler.tsv');
const chartScript = resolve(import.meta.dirname, 'bench-chart.mjs');
// jul-examples ist mit 886 Zeilen zu klein: dort schwankt der Median um mehr als die Alarmschwelle
const preferredTarget = resolve('C:/Projects/privat/yugioh');
const fallbackTarget = resolve(import.meta.dirname, '../../jul-examples');

function findJulFiles(folder: string): string[] {
	return readdirSync(folder).flatMap(entry => {
		const fullPath = join(folder, entry);
		if (statSync(fullPath).isDirectory()) {
			return entry === 'out' || entry === 'node_modules' || entry === '.git'
				? []
				: findJulFiles(fullPath);
		}
		return fullPath.endsWith('.jul')
			? [fullPath]
			: [];
	});
}

function parseAndCheck(filePath: string, parsedDocuments: ParsedDocuments): void {
	if (parsedDocuments[filePath]) {
		return;
	}
	const parsed = parseCode(readFileSync(filePath, { encoding: 'utf8' }), filePath);
	parsedDocuments[filePath] = parsed;
	parsed.dependencies?.forEach(dependencyPath => {
		if (existsSync(dependencyPath)) {
			parseAndCheck(dependencyPath, parsedDocuments);
		}
	});
	checkTypes(parsed, parsedDocuments);
}

function benchFolder(folder: string, save: boolean, note: string): void {
	if (!existsSync(folder)) {
		console.log(`${folder}: nicht gefunden, übersprungen`);
		return;
	}
	const julFiles = findJulFiles(folder);
	const lineCount = julFiles.reduce((sum, filePath) =>
		sum + readFileSync(filePath, { encoding: 'utf8' }).split('\n').length, 0);
	const durations: number[] = [];
	for (let run = 0; run < runCount; run++) {
		resetCheckerStats();
		const start = performance.now();
		julFiles.forEach(filePath => {
			try {
				parseAndCheck(filePath, {});
			}
			catch {
				// Fehlerhafte Beispiele sind im Snapshot festgehalten, hier nur Laufzeit relevant
			}
		});
		durations.push(performance.now() - start);
	}
	const target = basename(folder);
	const machine = getMachine();
	const results: BenchResult[] = [{
		label: 'parse+check',
		values: stats(durations),
	}];
	const previous = readPrevious(logPath, target, machine);

	console.log(folder);
	console.log(`  ${julFiles.length} Dateien, ${lineCount} Zeilen, ${runCount} Durchläufe`);
	results.forEach(({ label, values }) =>
		console.log(formatResult(label, values, previous?.[label])));
	console.log(`  inferType ${checkerStats.inferType}, resolvePlaceholders ${checkerStats.resolvePlaceholders}, getTypeError ${checkerStats.getTypeError}`);

	results.forEach(({ label, values }) => {
		const drift = getDrift(logPath, target, machine, label, values);
		if (drift && Math.abs(drift.deviation) >= noticeableDeviation) {
			const sign = drift.deviation >= 0 ? '+' : '';
			console.log(`  seit ${drift.first.timestamp} (${drift.first.commit}):`
				+ ` ${drift.first.median.toFixed(2)} ms -> ${values.median.toFixed(2)} ms`
				+ ` (${sign}${(drift.deviation * 100).toFixed(0)}%)`);
		}
	});

	const alarming = previous
		? results.filter(({ label, values }) =>
			previous[label]
			&& isComparable(values, previous[label]!)
			&& getDeviation(values, previous[label]!) >= alarmingDeviation)
		: [];
	if (alarming.length) {
		console.log(`  ALARM: ${alarming.map(result => result.label).join(', ')}`
			+ ` über ${(alarmingDeviation * 100).toFixed(0)}% langsamer als die letzte Messung.`
			+ ' Wall-Clock schwankt, aber nicht so weit - vor dem Protokollieren prüfen.');
	}

	if (save) {
		appendEntries(logPath, results, target, note);
		console.log(`  protokolliert: ${logPath}`);
		execFileSync(process.execPath, [chartScript], { stdio: 'inherit' });
	}
	else {
		console.log('  zum Protokollieren: npm run bench -- --save --note "grund"');
	}
}

const { save, note, targets: folders } = parseArgs(process.argv.slice(2));
const targets = folders.length
	? folders.map(folder => resolve(folder))
	: [existsSync(preferredTarget) ? preferredTarget : fallbackTarget];
targets.forEach(folder => benchFolder(folder, save, note));
