// Migriert JUL-Code auf den Rest des Blocks als Default-Fall:
//
//   ?(x)                         ?(x)
//   	[A] => a                  	[A] => a
//   	() =>                ->   b
//   		b                       c
//   		c
//
// Ein Branching als Anweisung verlässt nach der Umstellung die Funktion, wenn ein Arm passt, und
// sein catchAll ist ein Fehler. Deshalb:
// - Das Branching am Ende eines Rumpfs verliert seinen catchAll-Arm (`() =>`, `Any =>`, Parameter
//   ohne Typ), dessen Rumpf rückt hinter das Branching. Ein benannter catchAll über einem anderen
//   Ausdruck bekommt vorher eine Bindung (`x = …`).
// - Ebenso ein `[true]`/`[false]`-Paar, dessen `[false]`-Arm wieder mit einem Branching als
//   Anweisung beginnt (Kaskade). Ein anderes Paar bleibt, wie es ist.
// - Ein Branching mitten im Rumpf war ein bedingter Seiteneffekt und bekommt `_ = ` davor, damit
//   es weiter einer bleibt. Ebenso jedes Branching als Anweisung auf oberster Dateiebene.
//
// AST-basiert wie migrate-branching.mjs: Jede Datei wird mit dem ALTEN Parser geparst, alle
// Änderungen kommen aus diesem einen Baum und werden zeilenweise zusammengesetzt (Einrückung
// verringern, Kopfzeile löschen oder ersetzen, Präfix einfügen). Ein zweiter Lauf auf schon
// migriertem Code wäre falsch, weil der alte Parser jedes Branching mitten im Rumpf für einen
// Seiteneffekt hält. Dateien, die der alte Parser nicht fehlerfrei liest, werden übersprungen.
//
// Was sich nicht mechanisch umformen lässt, steht am Ende als "von Hand" im Bericht: ein catchAll,
// der nicht der letzte Arm ist, und ein catchAll mit mehreren Namen oder Rest-Parameter.
//
// Aufruf:
//   node scripts/migrate-early-return.mjs --compiler <altes-out-verzeichnis> [--write] <ziel...>
//
// Das alte out-Verzeichnis ist der Build vor der Umstellung. Es muss ein node_modules erreichen
// können, weil der Parser typescript statisch importiert, also z.B. als jul-compiler/out-old.

import { pathToFileURL } from 'url';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

//#region Umformung

const skipKeys = new Set(['parent', 'typeInfo', 'symbols']);

/**
 * @param code der Quelltext in alter Schreibweise
 * @param parseCode parseCode des alten Compilers
 * @returns code: neuer Quelltext, manual: Stellen, die von Hand umzustellen sind, changes: Anzahl
 * der Umformungen, skipped: Der alte Parser meldet Fehler, der Code bleibt unverändert.
 */
export function migrateCode(code, parseCode) {
	const parsed = parseCode(code, 'migrate.jul');
	// Nur Syntaxfehler (1xxx) machen den Baum unbrauchbar, semantische Meldungen stören nicht.
	if (parsed.syntax.errors.some(error => error.code < 2000)) {
		return { code: code, manual: [], changes: 0, skipped: true };
	}
	const rows = code.split('\n');
	const rowOps = rows.map(() => ({
		dedent: 0,
		deleted: false,
		/** Ersetzt den Text der Zeile ohne Einrückung, mit eigener Einrückung (vor dedent). */
		replacement: undefined,
		prefix: '',
		/** Ganze Zeilen vor dieser Zeile, mit eigener Einrückung (vor dedent). */
		insertBefore: [],
	}));
	const manual = [];
	let changes = 0;

	const indentOf = rowIndex => rows[rowIndex].match(/^\t*/)[0].length;
	const addPrefix = expression => {
		rowOps[expression.startRowIndex].prefix = '_ = ';
		changes++;
	};
	const dedentRange = (fromRow, toRow, amount, armIndent) => {
		// Ein Ausdruck am Dateiende endet hinter der letzten Zeile.
		let endRow = Math.min(toRow, rows.length - 1);
		// Leerzeilen und tiefer eingerückte Kommentare direkt dahinter gehören noch zum Arm.
		while (endRow + 1 < rows.length) {
			const next = rows[endRow + 1];
			const trimmed = next.trim();
			if (trimmed === '' || (trimmed.startsWith('#') && indentOf(endRow + 1) > armIndent)) {
				endRow++;
				continue;
			}
			break;
		}
		// Eine abschließende Leerzeile bleibt, wo sie ist.
		while (endRow > toRow && rows[endRow].trim() === '') {
			endRow--;
		}
		for (let rowIndex = fromRow; rowIndex <= endRow; rowIndex++) {
			rowOps[rowIndex].dedent += amount;
		}
	};

	/** Hängt den Rumpf des Arms hinter das Branching. */
	const liftBranch = (branching, branch) => {
		const branchingIndent = indentOf(branching.startRowIndex);
		const armRow = branch.startRowIndex;
		const armIndent = indentOf(armRow);
		const body = branch.body;
		const firstBody = body[0];
		// Ein benannter catchAll: der Name muss im Rest weiter gelten.
		const params = branch.params;
		if (params.type === 'parameters' && params.singleFields.length === 1) {
			const name = params.singleFields[0].name.name;
			const argsText = getSingleArgumentText(branching, rows);
			if (argsText === undefined) {
				manual.push({ rowIndex: armRow, reason: 'benannter catchAll über mehrzeiligem oder mehrfachem Argument' });
				return;
			}
			if (argsText !== name && isNameUsed(body, name)) {
				rowOps[firstBody.startRowIndex === armRow ? armRow : firstBody.startRowIndex].insertBefore.push({
					indent: firstBody.startRowIndex === armRow ? branchingIndent : armIndent + 1,
					text: `${name} = ${argsText}`,
				});
			}
		}
		// Ein Branching, das nur aus dem catchAll bestand, bleibt nicht leer zurück: Es entfällt.
		if (branching.branches.length === 1) {
			if (branching.args?.endRowIndex !== branching.startRowIndex) {
				manual.push({ rowIndex: branching.startRowIndex, reason: 'Branching nur mit catchAll und mehrzeiligem Argument' });
				return;
			}
			rowOps[branching.startRowIndex].deleted = true;
		}
		if (firstBody.startRowIndex === armRow) {
			// () => x: x ersetzt die Kopfzeile, Folgezeilen eines mehrzeiligen x rücken eine Ebene aus.
			rowOps[armRow].replacement = {
				indent: branchingIndent,
				text: rows[armRow].slice(firstBody.startColumnIndex),
			};
			if (branch.endRowIndex > armRow) {
				dedentRange(armRow + 1, branch.endRowIndex, armIndent - branchingIndent, armIndent);
			}
		}
		else {
			rowOps[armRow].deleted = true;
			dedentRange(armRow + 1, branch.endRowIndex, armIndent + 1 - branchingIndent, armIndent);
		}
		changes++;
	};

	const visitBody = (body, isTopLevel) => {
		body.forEach((statement, index) => {
			if (statement.type !== 'branching') {
				return;
			}
			if (isTopLevel || index < body.length - 1) {
				addPrefix(statement);
				return;
			}
			const branches = statement.branches;
			const catchAllIndex = branches.findIndex(isCatchAllBranch);
			if (catchAllIndex >= 0) {
				if (catchAllIndex !== branches.length - 1) {
					manual.push({ rowIndex: branches[catchAllIndex].startRowIndex, reason: 'catchAll ist nicht der letzte Arm' });
					return;
				}
				const params = branches[catchAllIndex].params;
				if (params.type === 'parameters' && (params.rest || params.singleFields.length > 1)) {
					manual.push({ rowIndex: branches[catchAllIndex].startRowIndex, reason: 'catchAll mit mehreren Namen oder Rest-Parameter' });
					return;
				}
				liftBranch(statement, branches[catchAllIndex]);
				return;
			}
			if (isBooleanCascade(statement)) {
				liftBranch(statement, branches[1]);
			}
		});
	};

	visitBody(parsed.syntax.expressions ?? [], true);
	const seen = new WeakSet();
	(function walk(node) {
		if (!node || typeof node !== 'object' || seen.has(node)) {
			return;
		}
		seen.add(node);
		if (Array.isArray(node)) {
			node.forEach(walk);
			return;
		}
		if (node.type === 'functionLiteral' && Array.isArray(node.body)) {
			visitBody(node.body, false);
		}
		for (const key of Object.keys(node)) {
			if (!skipKeys.has(key)) {
				walk(node[key]);
			}
		}
	})(parsed.syntax.expressions);

	if (!changes) {
		return { code: code, manual: manual, changes: 0, skipped: false };
	}
	const output = [];
	rows.forEach((row, rowIndex) => {
		const op = rowOps[rowIndex];
		const shift = indent => {
			const newIndent = indent - op.dedent;
			if (newIndent < 0) {
				throw new Error(`Zeile ${rowIndex + 1}: Einrückung würde negativ`);
			}
			return '\t'.repeat(newIndent);
		};
		op.insertBefore.forEach(line => output.push(shift(line.indent) + line.text));
		if (op.deleted) {
			return;
		}
		if (row.trim() === '') {
			output.push(row);
			return;
		}
		const indent = op.replacement ? op.replacement.indent : indentOf(rowIndex);
		const text = op.replacement ? op.replacement.text : row.slice(indentOf(rowIndex));
		output.push(shift(indent) + op.prefix + text);
	});
	return { code: output.join('\n'), manual: manual, changes: changes, skipped: false };
}

/** Wie isCatchAllBranch in parser-utils.ts, auf dem alten Baum. */
function isCatchAllBranch(branch) {
	if (branch.type !== 'functionLiteral') {
		return false;
	}
	const params = branch.params;
	switch (params.type) {
		case 'reference':
			return params.name.name === 'Any';
		case 'parameters': {
			const fields = params.rest ? [...params.singleFields, params.rest] : params.singleFields;
			return fields.every(field => !field.typeGuard
				|| (field.typeGuard.type === 'reference' && field.typeGuard.name.name === 'Any'));
		}
		default:
			return false;
	}
}

/** [true] => … und danach [false] =>, dessen Rumpf in eigenen Zeilen mit einem Branching beginnt. */
function isBooleanCascade(branching) {
	const branches = branching.branches;
	if (branches.length !== 2
		|| getSingleHeadName(branches[0]) !== 'true'
		|| getSingleHeadName(branches[1]) !== 'false') {
		return false;
	}
	const falseBody = branches[1].body;
	return falseBody[0]?.type === 'branching'
		&& falseBody[0].startRowIndex > branches[1].startRowIndex;
}

function getSingleHeadName(branch) {
	if (branch.type !== 'functionLiteral') {
		return undefined;
	}
	const params = branch.params;
	if (params.type !== 'list' || params.values.length !== 1) {
		return undefined;
	}
	const value = params.values[0];
	return value.type === 'reference' ? value.name.name : undefined;
}

/** Kommt name im Rumpf als Referenz vor? Eine Verdeckung in einer inneren Funktion zählt mit. */
function isNameUsed(body, name) {
	const seen = new WeakSet();
	let used = false;
	(function walk(node) {
		if (used || !node || typeof node !== 'object' || seen.has(node)) {
			return;
		}
		seen.add(node);
		if (Array.isArray(node)) {
			node.forEach(walk);
			return;
		}
		if (node.type === 'reference' && node.name.name === name) {
			used = true;
			return;
		}
		for (const key of Object.keys(node)) {
			if (!skipKeys.has(key)) {
				walk(node[key]);
			}
		}
	})(body);
	return used;
}

/** Der Quelltext des einzigen Arguments von ?(…), wenn es in einer Zeile steht. */
function getSingleArgumentText(branching, rows) {
	const args = branching.args;
	const values = args?.type === 'list' ? args.values : undefined;
	if (values?.length !== 1) {
		return undefined;
	}
	const value = values[0];
	if (value.startRowIndex !== value.endRowIndex) {
		return undefined;
	}
	return rows[value.startRowIndex].slice(value.startColumnIndex, value.endColumnIndex);
}

//#endregion Umformung

//#region Aufruf

function collectJulFiles(target, acc = []) {
	if (!statSync(target).isDirectory()) {
		if (target.endsWith('.jul')) {
			acc.push(resolve(target));
		}
		return acc;
	}
	for (const entry of readdirSync(target)) {
		if (entry === 'node_modules' || entry === 'out' || entry === 'out-old' || entry === '.git') {
			continue;
		}
		collectJulFiles(join(target, entry), acc);
	}
	return acc;
}

async function main() {
	const argv = process.argv.slice(2);
	const write = argv.includes('--write');
	const compilerIndex = argv.indexOf('--compiler');
	if (compilerIndex < 0) {
		console.error('Fehlt: --compiler <altes-out-verzeichnis>');
		process.exit(1);
	}
	const compilerDir = resolve(argv[compilerIndex + 1]);
	const targets = argv.filter((arg, index) => !arg.startsWith('--') && index !== compilerIndex + 1);
	if (!targets.length) {
		console.error('Keine Ziele angegeben.');
		process.exit(1);
	}
	const { parseCode } = await import(pathToFileURL(join(compilerDir, 'parser/parser.js')).href);
	let totalChanges = 0;
	let changedFiles = 0;
	const manual = [];
	const skipped = [];
	for (const filePath of targets.flatMap(target => collectJulFiles(target))) {
		const code = readFileSync(filePath, 'utf8');
		const result = migrateCode(code, parseCode);
		if (result.skipped) {
			skipped.push(filePath);
			continue;
		}
		result.manual.forEach(entry => manual.push(`${filePath}:${entry.rowIndex + 1}  ${entry.reason}`));
		if (!result.changes) {
			continue;
		}
		totalChanges += result.changes;
		changedFiles++;
		console.log(String(result.changes).padStart(5), filePath);
		if (write) {
			writeFileSync(filePath, result.code, 'utf8');
		}
	}
	if (skipped.length) {
		console.log('\nÜbersprungen, der alte Parser meldet Fehler:');
		skipped.forEach(filePath => console.log(`  ${filePath}`));
	}
	if (manual.length) {
		console.log('\nVon Hand:');
		manual.forEach(line => console.log(`  ${line}`));
	}
	console.log(`\n${changedFiles} Dateien, ${totalChanges} Umformungen, ${write ? 'geschrieben' : 'nicht geschrieben (--write)'}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}

//#endregion Aufruf
