// Migriert das Idiom für optionale Felder: `name: Or([] X)` im Dictionary-Typ wird zu `name?: X`.
//
// Hintergrund: Ein Feld ohne ? muss im Wert stehen, auch wenn sein Typ Empty zulässt
// (docs/backlog/stabile-objektformen.md). Wer ein Feld weglassen will, schreibt `name?: X`.
// Das Skript ersetzt das alte Idiom überall, wo es als Typ eines Dictionary-Typ-Felds steht.
// Es erhält damit das bisherige Verhalten: Das Feld darf weiter fehlen, und gelesen ergibt es
// weiter Empty oder den Wert. Eine Zuweisung `name = []` ist danach ein Fehler, weil Empty kein
// X ist, solche Stellen bleiben von Hand zu klären (Feld weglassen oder `name?: Or([] X)`).
//
// Das Skript arbeitet AST-basiert: Es parst jede Datei mit dem aktuellen Parser, sucht die
// Felder `name: Or(... [] ...)` und schreibt an genau deren Textstellen. Bleibt nach dem
// Entfernen von Empty ein Argument, steht es allein (`Or([] X)` wird `X`), sonst bleibt `Or(...)`
// mit den übrigen. Es ist idempotent, ein Feld mit ? wird nicht noch einmal angefasst.
//
// Ein Feldname, der irgendwo als `name = []` geschrieben wird, braucht für Empty einen Platz im Typ.
// Mit --written-empty bekommen alle Felder mit ?, deren Name so geschrieben wird, Empty zurück
// (`name?: X` wird `name?: Or([] X)`). Das ist die vorsichtige Lesart, ein Name gilt über alle Typen.
// Dieser Modus sammelt die Namen über alle Ziele, bevor er etwas ändert.
// Mit --all-empty gilt jeder Name als so geschrieben (`name?: Or([] X)` für alle ?-Felder): Ein Feld
// wird nicht nur als literales `[]` geschrieben, sondern auch aus einem gelesenen Wert kopiert
// (`name = other/name`), der Empty sein kann. Das ist die verhaltenserhaltende Migration.
//
// Aufruf:
//   node scripts/migrate-optional-fields.mjs [--write] [--keep Typ1,Typ2] [--written-empty] <ziel...>
//
// <ziel> sind Dateien oder Verzeichnisse (rekursiv nach *.jul durchsucht). Ohne --write bleibt
// alles unberührt, das Skript zählt nur. --keep nennt Typen, deren Felder ausgelassen werden, weil
// sie ohne ? bleiben sollen (stabile Objektform), etwa GameCard.

import { pathToFileURL } from 'url';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const out = resolve(import.meta.dirname, '../out');
const { parseCode } = await import(pathToFileURL(join(out, 'parser/parser.js')).href);
const { forEachChild } = await import(pathToFileURL(join(out, 'syntax-tree.js')).href);

//#region Argumente
const argv = process.argv.slice(2);
const write = argv.includes('--write');
const allEmptyMode = argv.includes('--all-empty');
const writtenEmptyMode = allEmptyMode || argv.includes('--written-empty');
const keepIndex = argv.indexOf('--keep');
const keep = new Set(keepIndex < 0 ? [] : argv[keepIndex + 1].split(','));
const targets = argv.filter((arg, index) =>
	!arg.startsWith('--')
	&& index !== keepIndex + 1);
if (!targets.length) {
	console.error('Keine Ziele angegeben.');
	process.exit(1);
}
//#endregion Argumente

function collectFiles(path, files) {
	if (statSync(path).isDirectory()) {
		for (const entry of readdirSync(path)) {
			if (entry === 'node_modules' || entry === 'out' || entry.startsWith('out-')) {
				continue;
			}
			collectFiles(join(path, entry), files);
		}
	}
	else if (path.endsWith('.jul')) {
		files.push(path);
	}
	return files;
}

/** Der Name der Definition, in der der Ausdruck steht (der Typname). */
function getDefinitionName(expression) {
	for (let current = expression; current; current = current.parent) {
		if (current.type === 'definition') {
			return current.name.name;
		}
	}
	return undefined;
}

/** Namen aller Dictionary-Felder, die irgendwo als `name = []` geschrieben werden. */
function collectWrittenEmptyNames(path, names) {
	const parsed = parseCode(readFileSync(path, 'utf8'), path);
	const visit = expression => {
		if (expression?.type === 'singleDictionaryField'
			&& expression.value?.type === 'empty'
			&& expression.name?.name !== undefined) {
			names.add(expression.name.name);
		}
		forEachChild(expression, visit);
	};
	(parsed.unchecked.expressions ?? []).forEach(visit);
}

function migrateFile(path, writtenEmptyNames) {
	const code = readFileSync(path, 'utf8');
	const lineStarts = [0];
	for (let index = 0; index < code.length; index++) {
		if (code[index] === '\n') {
			lineStarts.push(index + 1);
		}
	}
	const offsetOf = (row, column) => lineStarts[row] + column;
	const parsed = parseCode(code, path);
	const edits = [];
	const visit = expression => {
		if (writtenEmptyMode) {
			// Ein ?-Feld, dessen Name als `= []` geschrieben wird: Empty zurück in den Typ
			if (expression?.type === 'singleDictionaryTypeField'
				&& expression.optional
				&& expression.typeGuard
				&& writtenEmptyNames.has(expression.name.name)
				&& !keep.has(getDefinitionName(expression))) {
				const guard = expression.typeGuard;
				const start = offsetOf(guard.startRowIndex, guard.startColumnIndex);
				const end = offsetOf(guard.endRowIndex, guard.endColumnIndex);
				const isOr = guard.type === 'functionCall'
					&& guard.functionExpression?.type === 'reference'
					&& guard.functionExpression.name.name === 'Or'
					&& guard.arguments?.type === 'list';
				if (isOr && guard.arguments.values.some(value => value.type === 'empty')) {
					// schon Empty im Typ
				}
				else if (isOr) {
					const first = guard.arguments.values[0];
					const insertAt = offsetOf(first.startRowIndex, first.startColumnIndex);
					// Steht das erste Argument in einer eigenen Zeile, bekommt Empty ebenfalls eine, mit derselben Einrückung
					const emptyText = first.startRowIndex !== guard.startRowIndex
						? `[]
${code.slice(lineStarts[first.startRowIndex], insertAt)}`
						: '[] ';
					edits.push({ start: insertAt, end: insertAt, text: emptyText });
				}
				else {
					edits.push({ start: start, end: end, text: `Or([] ${code.slice(start, end)})` });
				}
			}
			forEachChild(expression, visit);
			return;
		}
		if (expression?.type === 'singleDictionaryTypeField'
			&& !expression.optional
			&& expression.typeGuard?.type === 'functionCall'
			&& expression.typeGuard.functionExpression?.type === 'reference'
			&& expression.typeGuard.functionExpression.name.name === 'Or'
			&& expression.typeGuard.arguments?.type === 'list'
			&& !keep.has(getDefinitionName(expression))) {
			const call = expression.typeGuard;
			const values = call.arguments.values;
			const emptyIndex = values.findIndex(value => value.type === 'empty');
			if (emptyIndex >= 0) {
				const callStart = offsetOf(call.startRowIndex, call.startColumnIndex);
				const callEnd = offsetOf(call.endRowIndex, call.endColumnIndex);
				const remaining = values.filter((_, index) => index !== emptyIndex);
				let newCallText;
				if (remaining.length === 1) {
					const only = remaining[0];
					newCallText = code.slice(
						offsetOf(only.startRowIndex, only.startColumnIndex),
						offsetOf(only.endRowIndex, only.endColumnIndex));
				}
				else {
					// Empty samt dem Leerraum dahinter (oder davor, wenn es das letzte Argument ist) entfernen
					const empty = values[emptyIndex];
					let removeStart = offsetOf(empty.startRowIndex, empty.startColumnIndex);
					let removeEnd = offsetOf(empty.endRowIndex, empty.endColumnIndex);
					const next = values[emptyIndex + 1];
					if (next) {
						removeEnd = offsetOf(next.startRowIndex, next.startColumnIndex);
					}
					else {
						const previous = values[emptyIndex - 1];
						removeStart = offsetOf(previous.endRowIndex, previous.endColumnIndex);
					}
					newCallText = code.slice(callStart, removeStart) + code.slice(removeEnd, callEnd);
				}
				edits.push({
					start: callStart,
					end: callEnd,
					text: newCallText,
				});
				edits.push({
					start: offsetOf(expression.name.endRowIndex, expression.name.endColumnIndex),
					end: offsetOf(expression.name.endRowIndex, expression.name.endColumnIndex),
					text: '?',
				});
			}
		}
		forEachChild(expression, visit);
	};
	(parsed.unchecked.expressions ?? []).forEach(visit);
	// Eine Ersetzung, die eine andere umschließt (ein Feld im Typ eines Felds), schreibt den Text der
	// inneren aus dem Original und würde sie überschreiben. Die innere entfällt, ein weiterer Durchgang
	// holt sie nach.
	const applicable = edits.filter(edit => !edits.some(other =>
		other !== edit
		&& other.end > other.start
		&& other.start <= edit.start
		&& edit.end <= other.end
		&& !(other.start === edit.start && other.end === edit.end)));
	if (!applicable.length) {
		return 0;
	}
	const editCount = writtenEmptyMode ? applicable.length : applicable.length / 2;
	// Von hinten nach vorn, damit die Offsets der übrigen gelten
	applicable.sort((first, second) => second.start - first.start);
	let result = code;
	for (const edit of applicable) {
		result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
	}
	if (write) {
		writeFileSync(path, result);
	}
	return editCount;
}

let total = 0;
const files = targets.flatMap(target => collectFiles(resolve(target), []));
const writtenEmptyNames = new Set();
if (writtenEmptyMode) {
	files.forEach(file => collectWrittenEmptyNames(file, writtenEmptyNames));
}
if (allEmptyMode) {
	// Jeder Name gilt als geschrieben: Das Feld kann auch Empty aus einem gelesenen Wert bekommen
	writtenEmptyNames.has = () => true;
}
for (const file of files) {
	let count = migrateFile(file, writtenEmptyNames);
	if (write) {
		// Durchgänge, bis keine verschachtelte Stelle mehr übrig ist
		for (let more = count; more; ) {
			more = migrateFile(file, writtenEmptyNames);
			count += more;
		}
	}
	if (count) {
		console.log(`${count}\t${file}`);
		total += count;
	}
}
console.log(`${total} Felder${write ? ' migriert' : ' (Trockenlauf, --write schreibt)'}`);
