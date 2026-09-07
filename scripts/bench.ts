import { readdirSync, readFileSync, statSync } from 'fs';
import { existsSync } from 'fs';
import { join, resolve } from 'path';

import { checkerStats, checkTypes, ParsedDocuments, resetCheckerStats } from '../src/checker.js';
import { parseCode } from '../src/parser/parser.js';

/**
 * Wall-Clock Messung von parse + check. Kein Test-Gate, nur Beleg für Umbauten am Checker.
 * Aufruf: npm run bench [ordner...]  (Default: jul-examples)
 */

const runCount = 5;

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

function benchFolder(folder: string): void {
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
	durations.sort((a, b) => a - b);
	const median = durations[Math.floor(runCount / 2)]!;
	console.log(`${folder}`);
	console.log(`  ${julFiles.length} Dateien, ${lineCount} Zeilen`);
	console.log(`  median ${median.toFixed(1)} ms  (min ${durations[0]!.toFixed(1)}, max ${durations[runCount - 1]!.toFixed(1)})`);
	console.log(`  inferType ${checkerStats.inferType}, dereferenceNested ${checkerStats.dereferenceNested}, getTypeError ${checkerStats.getTypeError}`);
}

const folders = process.argv.slice(2);
const targets = folders.length
	? folders.map(folder => resolve(folder))
	: [resolve(import.meta.dirname, '../../jul-examples')];
targets.forEach(benchFolder);
