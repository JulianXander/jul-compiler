// Migriert x/getValue() auf x.getCurrentValue().
//
// Hintergrund: Ein Stream hatte als einziges Feld getValue, alles andere (push, complete,
// subscribe, map$) sind Funktionen der core-lib, aufgerufen mit `.`. Den aktuellen Wert liefert
// jetzt die core-lib-Funktion getCurrentValue, ein Stream hat keine Felder mehr.
//
// Das Skript arbeitet AST-basiert: Es parst jede Datei mit dem gebauten Parser aus ../out und sucht
// Aufrufe ohne Argumente, deren Funktion ein Feldzugriff namens getValue ist. Den Text zwischen
// dem Ende der Quelle und dem Ende des Aufrufs (`/getValue()`) ersetzt es durch
// `.getCurrentValue()`. Ein Text oder Kommentar, in dem getValue vorkommt, bleibt unberührt, ein
// Parameter oder eine Definition namens getValue ebenfalls.
//
// Ein Feldzugriff /getValue ohne Aufruf (als Funktionswert weitergereicht) wird nicht ersetzt,
// sondern gemeldet: Er ist von Hand auf () => x.getCurrentValue() umzustellen. Das Skript kennt
// keine Typen und ersetzt /getValue() auch bei einem Record mit einem Feld getValue. Solche
// Stellen meldet nach der Migration der Checker.
//
// Aufruf (vorher im Compiler npm run build):
//   node scripts/migrate-stream-get-value.mjs [--write] <ziel...>
//
// <ziel> sind Dateien oder Verzeichnisse (rekursiv nach *.jul durchsucht, ohne node_modules und
// out). Ohne --write bleiben die Quellen unberührt, ausgegeben wird nur, was sich ändern würde.
// Das Skript ist idempotent.

import { pathToFileURL } from 'url';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const out = resolve(import.meta.dirname, '../out');
const { parseCode } = await import(pathToFileURL(join(out, 'parser/parser.js')).href);
const { forEachChild } = await import(pathToFileURL(join(out, 'syntax-tree.js')).href);

const oldText = '/getValue()';
const newText = '.getCurrentValue()';

const args = process.argv.slice(2);
const write = args.includes('--write');
const targets = args.filter(arg => arg !== '--write');
if (!targets.length) {
	console.error('Aufruf: node scripts/migrate-stream-get-value.mjs [--write] <ziel...>');
	process.exit(1);
}

function collectJulFiles(path) {
	if (statSync(path).isFile()) {
		return path.endsWith('.jul') ? [path] : [];
	}
	return readdirSync(path)
		.filter(name => name !== 'node_modules' && name !== 'out')
		.flatMap(name => collectJulFiles(join(path, name)));
}

function isGetValueReference(expression) {
	return expression?.type === 'nestedReference'
		&& expression.nestedKey?.type === 'name'
		&& expression.nestedKey.name === 'getValue';
}

/**
 * calls: Aufrufe x/getValue(), ersetzt wird von der Quelle bis zum Ende des Aufrufs.
 * uncalled: Feldzugriffe /getValue ohne Aufruf.
 */
function collect(expression, calls, uncalled, isCalledFunction) {
	if (expression.type === 'functionCall'
		&& !expression.prefixArgument
		&& isGetValueReference(expression.functionExpression)
		&& !expression.arguments?.fields?.length) {
		calls.push({
			source: expression.functionExpression.source,
			call: expression,
		});
	}
	else if (isGetValueReference(expression) && !isCalledFunction) {
		uncalled.push(expression.nestedKey);
	}
	forEachChild(expression, child => {
		collect(
			child,
			calls,
			uncalled,
			expression.type === 'functionCall' && child === expression.functionExpression);
	});
}

let changedCount = 0;
let uncalledCount = 0;
for (const file of targets.flatMap(collectJulFiles)) {
	const code = readFileSync(file, 'utf8');
	const calls = [];
	const uncalled = [];
	parseCode(code, file).syntax.expressions?.forEach(expression => {
		collect(expression, calls, uncalled, false);
	});
	uncalled.forEach(name => {
		console.log(`${file}:${name.startRowIndex + 1}:${name.startColumnIndex + 1}: /getValue ohne Aufruf, von Hand umstellen`);
	});
	uncalledCount += uncalled.length;
	if (!calls.length) {
		continue;
	}
	const rows = code.split('\n');
	// Von hinten, damit frühere Spalten derselben Zeile gültig bleiben.
	calls
		.sort((first, second) => second.call.endRowIndex - first.call.endRowIndex || second.call.endColumnIndex - first.call.endColumnIndex)
		.forEach(({ source, call }) => {
			const rowIndex = call.endRowIndex;
			const row = rows[rowIndex];
			const start = source.endColumnIndex;
			if (source.endRowIndex !== rowIndex
				|| row.slice(start, call.endColumnIndex) !== oldText) {
				throw new Error(`${file}:${rowIndex + 1}:${start + 1}: erwartet ${oldText}`);
			}
			rows[rowIndex] = row.slice(0, start) + newText + row.slice(call.endColumnIndex);
			console.log(`${file}:${rowIndex + 1}: ${rows[rowIndex].trim()}`);
		});
	changedCount += calls.length;
	if (write) {
		writeFileSync(file, rows.join('\n'));
	}
}
console.log(`${changedCount} Aufrufe${write ? ' ersetzt' : ' würden ersetzt, mit --write schreiben'}.`);
if (uncalledCount) {
	console.log(`${uncalledCount} Feldzugriffe ohne Aufruf, von Hand umstellen.`);
}
