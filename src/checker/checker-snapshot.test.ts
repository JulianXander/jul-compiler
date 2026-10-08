import { expect } from 'chai';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';
import { basename, join, relative, resolve } from 'path';

import { ParsedDocuments } from './checker.js';
import { checkerStats, resetCheckerStats } from './checker-stats.js';
import { checkTypes } from './checker.js';
import { resolvePlaceholders, typeToString } from './type-algebra.js';
import { errorInfos } from '../compiler-errors.js';
import { createFileSystemHost, loadFile } from '../compiler/project-loader.js';
import { builtinInvalid, ParsedFile } from '../syntax-tree.js';
import { parseCode } from '../parser/parser.js';
import { findInvalidWithoutError } from '../test-util.js';

/**
 * Hält das nutzersichtbare Checker-Verhalten über alle Beispiele fest: inferierter Typ je
 * Top-Level-Symbol und alle Fehler. Zweck ist der Vergleich vor/nach einem Umbau des Checkers -
 * die tabellengetriebenen Tests decken nur ausgewählte Fälle ab.
 *
 * Baseline neu schreiben: UPDATE_SNAPSHOT=1 npm test
 */

const examplesFolder = resolve(import.meta.dirname, '../../../jul-examples');
const baselinePath = join(import.meta.dirname, 'checker-snapshot.baseline.txt');
const statsBaselinePath = join(import.meta.dirname, 'checker-stats.baseline.txt');

// test1.jul ist ein Scratch-File zum manuellen Ausprobieren, kein stabiles Beispiel.
const excludedFiles = ['test1.jul'];

function findJulFiles(folder: string): string[] {
	const entries = readdirSync(folder);
	const files = entries.flatMap(entry => {
		const fullPath = join(folder, entry);
		if (statSync(fullPath).isDirectory()) {
			return entry === 'out' || entry === 'node_modules'
				? []
				: findJulFiles(fullPath);
		}
		return fullPath.endsWith('.jul') && !excludedFiles.includes(entry)
			? [fullPath]
			: [];
	});
	return files.sort();
}

/**
 * Parst rekursiv inklusive Importe und checkt, auf demselben Weg wie CLI und Language Server.
 */
function parseAndCheck(filePath: string, parsedDocuments: ParsedDocuments): ParsedFile {
	const parsed = loadFile(filePath, parsedDocuments, createFileSystemHost({ cloneUnchecked: false }));
	if (typeof parsed === 'string') {
		throw new Error(`${parsed}: ${filePath}`);
	}
	return parsed;
}

function snapshotFile(filePath: string): string[] {
	const relativePath = relative(examplesFolder, filePath).replaceAll('\\', '/');
	const lines = [`=== ${relativePath} ===`];
	let parsed: ParsedFile;
	try {
		parsed = parseAndCheck(filePath, {});
	}
	catch (error) {
		lines.push(`THREW ${error instanceof Error ? error.message : error}`);
		return lines;
	}
	const checked = parsed.checked;
	if (!checked) {
		lines.push('NOT CHECKED');
		return lines;
	}
	Object.keys(checked.symbols).sort().forEach(name => {
		const typeInfo = checked.symbols[name]!.typeInfo;
		const typeString = typeInfo
			? typeToString(resolvePlaceholders(typeInfo.type), 0, 0)
			: 'NO TYPE';
		lines.push(`${name}: ${typeString.replaceAll('\n', ' ')}`);
	});
	checked.errors.forEach(error => {
		const position = `${error.startRowIndex + 1}:${error.startColumnIndex + 1}`;
		const severity = errorInfos[error.code].severity;
		lines.push(`  ${severity} ${error.code} at ${position} ${error.message.replaceAll('\n', ' | ')}`);
	});
	return lines;
}

/**
 * Eine fehlende Baseline ist ein Fehler, kein Grund sie stillschweigend zu erzeugen -
 * sonst wird der Test grün, wenn die Datei nicht eingecheckt oder versehentlich gelöscht wurde.
 */
function compareToBaseline(actual: string, baselineFilePath: string): void {
	if (process.env['UPDATE_SNAPSHOT']) {
		writeFileSync(baselineFilePath, actual);
		return;
	}
	if (!existsSync(baselineFilePath)) {
		throw new Error(`Baseline ${basename(baselineFilePath)} fehlt. Neu schreiben mit: UPDATE_SNAPSHOT=1 npm test`);
	}
	const expected = readFileSync(baselineFilePath, { encoding: 'utf8' });
	expect(actual).to.equal(expected);
}

describe('checker snapshot', () => {
	it('matches the baseline', () => {
		const julFiles = findJulFiles(examplesFolder);
		expect(julFiles.length, 'no example files found').to.be.greaterThan(0);
		const actual = julFiles.flatMap(snapshotFile).join('\n') + '\n';
		compareToBaseline(actual, baselinePath);
	});

	it('matches the stats baseline', () => {
		const julFiles = findJulFiles(examplesFolder);
		resetCheckerStats();
		julFiles.forEach(filePath => {
			try {
				parseAndCheck(filePath, {});
			}
			catch {
				// im Snapshot festgehalten, hier irrelevant
			}
		});
		const actual = Object.entries(checkerStats)
			.map(([name, count]) => `${name}: ${count}`)
			.join('\n') + '\n';
		compareToBaseline(actual, statsBaselinePath);
	});
});

/**
 * Invalid entsteht nur, wo schon ein Fehler gemeldet ist (in dieser Datei oder in einer, die sie
 * importiert). Sonst verschwände ein Fehler still.
 */
describe('Herkunft von Invalid', () => {
	it('meldet einen Ausdruck mit Invalid, wenn nirgends ein Fehler steht', () => {
		const parsed = parseCode('x = 1\nx', 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		parsed.checked!.expressions!.at(-1)!.typeInfo = { type: builtinInvalid };
		const positions = findInvalidWithoutError({ 'dummy.jul': parsed });
		expect(positions).to.deep.equal(['dummy.jul:2:1']);
	});
	it('meldet nichts, wenn der Fehler gemeldet ist', () => {
		const parsed = parseCode('x = undefinedName\nx', 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(findInvalidWithoutError({ 'dummy.jul': parsed })).to.deep.equal([]);
	});
	it('gilt für alle Beispiele', () => {
		const violations = findJulFiles(examplesFolder).flatMap(filePath => {
			const parsedDocuments: ParsedDocuments = {};
			try {
				parseAndCheck(filePath, parsedDocuments);
			}
			catch {
				return [];
			}
			return findInvalidWithoutError(parsedDocuments);
		});
		expect(violations).to.deep.equal([]);
	});
});
