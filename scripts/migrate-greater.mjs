// Migriert greater auf greaterInteger.
//
// Hintergrund: greater nahm Or(Integer Float) und vermischte damit exakte und Fließkommazahlen, die
// die übrige core-lib trennt (multiply/multiplyFloat). Jetzt gibt es greaterInteger für Integer und
// greaterFloat für Float, beide mit einer Zusicherung, über die filter & Co. verengen.
//
// Das Skript arbeitet AST-basiert: Es parst jede Datei mit dem gebauten Parser aus ../out und
// ersetzt jede Referenz namens greater durch greaterInteger, an genau ihrer Textstelle. Ein Text
// oder Kommentar, in dem greater vorkommt, bleibt unberührt. Eine eigene Definition namens greater
// gibt es nicht, core-lib-Namen lassen sich nicht überdecken (JUL3203).
//
// Ein Aufruf mit Float-Argumenten gehört zu greaterFloat. Das sieht das Skript nicht, es kennt
// keine Typen: Nach der Migration meldet der Checker diese Stellen (Float statt Integer), sie sind
// von Hand auf greaterFloat umzustellen.
//
// Aufruf (vorher im Compiler npm run build):
//   node scripts/migrate-greater.mjs [--write] <ziel...>
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

const oldName = 'greater';
const newName = 'greaterInteger';

const args = process.argv.slice(2);
const write = args.includes('--write');
const targets = args.filter(arg => arg !== '--write');
if (!targets.length) {
	console.error('Aufruf: node scripts/migrate-greater.mjs [--write] <ziel...>');
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

function collectReferences(expression, references) {
	if (expression.type === 'reference'
		&& expression.name.name === oldName) {
		references.push(expression.name);
	}
	forEachChild(expression, child => {
		collectReferences(child, references);
	});
}

let changedCount = 0;
for (const file of targets.flatMap(collectJulFiles)) {
	const code = readFileSync(file, 'utf8');
	const references = [];
	parseCode(code, file).syntax.expressions?.forEach(expression => {
		collectReferences(expression, references);
	});
	if (!references.length) {
		continue;
	}
	const rows = code.split('\n');
	// Von hinten, damit frühere Spalten derselben Zeile gültig bleiben.
	references
		.sort((first, second) => second.startRowIndex - first.startRowIndex || second.startColumnIndex - first.startColumnIndex)
		.forEach(name => {
			const row = rows[name.startRowIndex];
			const column = name.startColumnIndex;
			if (row.slice(column, column + oldName.length) !== oldName) {
				throw new Error(`${file}:${name.startRowIndex + 1}:${column + 1}: erwartet ${oldName}`);
			}
			rows[name.startRowIndex] = row.slice(0, column) + newName + row.slice(column + oldName.length);
			console.log(`${file}:${name.startRowIndex + 1}: ${rows[name.startRowIndex].trim()}`);
		});
	changedCount += references.length;
	if (write) {
		writeFileSync(file, rows.join('\n'));
	}
}
console.log(`${changedCount} Referenzen${write ? ' ersetzt' : ' würden ersetzt, mit --write schreiben'}.`);
