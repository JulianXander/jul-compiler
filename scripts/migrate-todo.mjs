// Migriert TODO-Kommentare auf die Anweisung #TODO: "# TODO", "# todo", "#todo" -> "#TODO".
//
// Hintergrund: #TODO ist eine Anweisung im Kommentar und erscheint als Hinweis im Editor (JUL2903).
// Jede andere Schreibweise am Anfang eines Kommentars ist eine Warnung (JUL2904).
//
// Das Skript arbeitet über den Parser, nicht per Regex über die ganze Datei: Es parst jede Datei
// mit dem gebauten Compiler aus ../out und ändert genau die Zeilen, für die der Parser JUL2904
// meldet. Eine Zeile in einem mehrzeiligen Text-Literal, die zufällig mit "# todo" beginnt, bleibt
// deshalb unberührt. Der Rest der Zeile nach "todo" bleibt, wie er ist.
//
// Aufruf (vorher im Compiler npm run build):
//   node scripts/migrate-todo.mjs [--write] <ziel...>
//
// <ziel> sind Dateien oder Verzeichnisse (rekursiv nach *.jul durchsucht, ohne node_modules und
// out). Ohne --write bleiben die Quellen unberührt, ausgegeben wird nur, was sich ändern würde.
// Das Skript ist idempotent.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ErrorCode } from '../out/compiler-errors.js';
import { parseCode } from '../out/parser/parser.js';

const args = process.argv.slice(2);
const write = args.includes('--write');
const targets = args.filter(arg => arg !== '--write');
if (!targets.length) {
	console.error('Aufruf: node scripts/migrate-todo.mjs [--write] <ziel...>');
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

let changedRows = 0;
for (const file of targets.flatMap(collectJulFiles)) {
	const code = readFileSync(file, 'utf8');
	const rowIndexes = new Set(parseCode(code, file).unchecked.errors
		.filter(error => error.code === ErrorCode.todoSpelling)
		.map(error => error.startRowIndex));
	if (!rowIndexes.size) {
		continue;
	}
	const rows = code.split('\n');
	rowIndexes.forEach(rowIndex => {
		const migrated = rows[rowIndex].replace(/^(\t*)# ?todo/i, '$1#TODO');
		console.log(`${file}:${rowIndex + 1}\n  - ${rows[rowIndex].trim()}\n  + ${migrated.trim()}`);
		rows[rowIndex] = migrated;
	});
	changedRows += rowIndexes.size;
	if (write) {
		writeFileSync(file, rows.join('\n'));
	}
}
console.log(`${changedRows} Zeilen${write ? ' geändert' : ' würden geändert, mit --write schreiben'}.`);
