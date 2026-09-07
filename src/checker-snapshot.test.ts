import { expect } from 'chai';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';
import { join, relative, resolve } from 'path';

import { checkerStats, checkTypes, resetCheckerStats, typeToString } from './checker.js';
import { parseCode } from './parser/parser.js';
import { ParsedDocuments, ParsedFile } from './syntax-tree.js';

/**
 * Hält das nutzersichtbare Checker-Verhalten über alle Beispiele fest: inferierter Typ je
 * Top-Level-Symbol und alle Fehler. Zweck ist der Vergleich vor/nach einem Umbau des Checkers -
 * die tabellengetriebenen Tests decken nur ausgewählte Fälle ab.
 *
 * Baseline neu schreiben: UPDATE_SNAPSHOT=1 npm test
 */

const examplesFolder = resolve(import.meta.dirname, '../../jul-examples');
const baselinePath = join(import.meta.dirname, 'checker-snapshot.baseline.txt');
const statsBaselinePath = join(import.meta.dirname, 'checker-stats.baseline.txt');

function findJulFiles(folder: string): string[] {
	const entries = readdirSync(folder);
	const files = entries.flatMap(entry => {
		const fullPath = join(folder, entry);
		if (statSync(fullPath).isDirectory()) {
			return entry === 'out' || entry === 'node_modules'
				? []
				: findJulFiles(fullPath);
		}
		return fullPath.endsWith('.jul')
			? [fullPath]
			: [];
	});
	return files.sort();
}

/**
 * Parst rekursiv inklusive Importe und checkt, analog zum language server.
 */
function parseAndCheck(filePath: string, parsedDocuments: ParsedDocuments): ParsedFile {
	const existing = parsedDocuments[filePath];
	if (existing) {
		if (!existing.checked) {
			checkTypes(existing, parsedDocuments);
		}
		return existing;
	}
	const code = readFileSync(filePath, { encoding: 'utf8' });
	const parsed = parseCode(code, filePath);
	parsedDocuments[filePath] = parsed;
	parsed.dependencies?.forEach(dependencyPath => {
		if (existsSync(dependencyPath)) {
			parseAndCheck(dependencyPath, parsedDocuments);
		}
	});
	checkTypes(parsed, parsedDocuments);
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
			? typeToString(typeInfo.dereferencedType, 0, 0)
			: 'NO TYPE';
		lines.push(`${name}: ${typeString.replaceAll('\n', ' ')}`);
	});
	checked.errors.forEach(error => {
		const position = `${error.startRowIndex + 1}:${error.startColumnIndex + 1}`;
		lines.push(`  error ${error.code} at ${position} ${error.message.replaceAll('\n', ' | ')}`);
	});
	return lines;
}

describe('checker snapshot', () => {
	it('matches the baseline', () => {
		const julFiles = findJulFiles(examplesFolder);
		expect(julFiles.length, 'no example files found').to.be.greaterThan(0);
		const actual = julFiles.flatMap(snapshotFile).join('\n') + '\n';
		if (process.env['UPDATE_SNAPSHOT'] || !existsSync(baselinePath)) {
			writeFileSync(baselinePath, actual);
			return;
		}
		const expected = readFileSync(baselinePath, { encoding: 'utf8' });
		expect(actual).to.equal(expected);
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
		if (process.env['UPDATE_SNAPSHOT'] || !existsSync(statsBaselinePath)) {
			writeFileSync(statsBaselinePath, actual);
			return;
		}
		const expected = readFileSync(statsBaselinePath, { encoding: 'utf8' });
		expect(actual).to.equal(expected);
	});
});
