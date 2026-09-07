// Migriert JUL-Branchings von Infix auf Praefix mit Argumentliste und wickelt die Typ-Koepfe:
//   x ?              ->   ?(x)
//     true => 1             [true] => 1
//     () => 2               () => 2
//
// Hintergrund: Der ?-Operator bekommt eine runde Argumentliste (Bindungsstelle), und ein
// Typ-Kopf wird ausnahmslos gegen die Argumentkollektion geprueft - einstellige Koepfe
// werden damit zu Tupeln. Siehe auto-spread-branching.md.
//
// AST-basiert wie migrate-brackets.mjs: jede Datei wird mit dem ALTEN Parser geparst, die
// Branching-Knoten eingesammelt und genau deren Zeichen getauscht.
//
// Anders als bei den Klammern ist diese Migration NICHT laengenneutral. Die Abnahme ist
// daher nicht Byte-Identitaet, sondern: das Ergebnis parst mit dem NEUEN Compiler fehlerfrei.
//
// Nicht gewickelt werden:
//   ()  => ...   Parameterliste, kein Typ-Kopf
//   Any => ...   matcht auch die Kollektion; [Any] wuerde auf einstellige verengen
//
// Aufruf:
//   node scripts/migrate-branching.mjs --compiler <altes-out-verzeichnis> [--write] <ziel...>
//
// Nicht idempotent: bereits migrierte Dateien parst der alte Compiler nicht mehr, sie werden
// mit Warnung uebersprungen. Das ist zugleich der Schutz gegen einen zweiten Lauf.
//
// Das alte out-Verzeichnis bekommt man aus der Versionsgeschichte:
//   git worktree add <tmp> <commit-vor-der-umstellung>, dort node_modules verlinken,
//   npm run build, das entstandene out beiseitelegen. Es muss ein node_modules erreichen
//   koennen, weil der Parser typescript statisch importiert.

import { pathToFileURL } from 'url';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const backslash = String.fromCharCode(92);
const toPosix = path => path.split(backslash).join('/');

//#region Argumente
const argv = process.argv.slice(2);
const write = argv.includes('--write');
const compilerIndex = argv.indexOf('--compiler');
if (compilerIndex < 0) {
	console.error('Fehlt: --compiler <altes-out-verzeichnis>');
	process.exit(1);
}
const compilerDir = resolve(argv[compilerIndex + 1]);
const shadowIndex = argv.indexOf('--shadow');
const shadowDir = shadowIndex < 0
	? join(tmpdir(), 'jul-migrate-branching-shadow')
	: resolve(argv[shadowIndex + 1]);
const targets = argv.filter((arg, index) =>
	!arg.startsWith('--')
	&& index !== compilerIndex + 1
	&& index !== shadowIndex + 1);
if (!targets.length) {
	console.error('Keine Ziele angegeben.');
	process.exit(1);
}
//#endregion Argumente

function collectJulFiles(target, acc = []) {
	if (!statSync(target).isDirectory()) {
		if (target.endsWith('.jul')) {
			acc.push(toPosix(resolve(target)));
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

const { parseCode } = await import(pathToFileURL(join(compilerDir, 'parser/parser.js')).href);

/** parent erzeugt Zyklen, typeInfo kommt erst vom Checker. */
const skipKeys = new Set(['parent', 'typeInfo']);

/**
 * Params-Arten, die bereits eine Bindungsstelle sind und daher kein Typ-Kopf:
 * parameters ist die aufgeloeste Parameterliste, binding die nicht aufgeloeste.
 */
const bindingParamTypes = new Set(['parameters', 'binding']);

function isTypeHead(params) {
	if (!params || bindingParamTypes.has(params.type)) {
		return false;
	}
	// Any matcht auch die Kollektion und bleibt ungewickelt.
	return !(params.type === 'reference' && params.name?.name === 'Any');
}

function collectBranchings(root) {
	const branchings = [];
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
		if (node.type === 'branching') {
			branchings.push(node);
		}
		for (const key of Object.keys(node)) {
			if (!skipKeys.has(key)) {
				walk(node[key]);
			}
		}
	})(root);
	return branchings;
}

/**
 * Ersetzungen als Punktoperationen: an (rowIndex, columnIndex) deleteLength Zeichen durch
 * text ersetzen. Pro Zeile von rechts nach links angewandt, damit sich die Spalten der noch
 * ausstehenden Ersetzungen nicht verschieben.
 */
function applyEdits(rows, edits) {
	const byRow = new Map();
	for (const edit of edits) {
		const list = byRow.get(edit.rowIndex) ?? [];
		list.push(edit);
		byRow.set(edit.rowIndex, list);
	}
	for (const [rowIndex, list] of byRow) {
		list.sort((a, b) => b.columnIndex - a.columnIndex);
		let row = rows[rowIndex];
		for (const { columnIndex, deleteLength, text } of list) {
			row = row.slice(0, columnIndex) + text + row.slice(columnIndex + deleteLength);
		}
		rows[rowIndex] = row;
	}
}

function migrateFile(filePath) {
	const code = readFileSync(filePath, 'utf8');
	const parsed = parseCode(code, filePath);
	// Bereits migrierte Dateien scheitern am alten Parser - unveraendert lassen.
	if (parsed.unchecked.errors.length) {
		return { migrated: code, branchings: 0, heads: 0, skipped: true };
	}
	const rows = code.split('\n');
	const branchings = collectBranchings(parsed.unchecked.expressions);
	const edits = [];
	let heads = 0;
	for (const branching of branchings) {
		const value = branching.value;
		if (!value) {
			throw new Error(`${filePath}:${branching.startRowIndex + 1} branching ohne value`);
		}
		// Das Infix-Token ' ?' steht unmittelbar hinter dem gebranchten Wert.
		const token = rows[value.endRowIndex]?.slice(value.endColumnIndex, value.endColumnIndex + 2);
		if (token !== ' ?') {
			throw new Error(`${filePath}:${value.endRowIndex + 1} erwartet ' ?', gefunden '${token}'`);
		}
		edits.push({ rowIndex: value.startRowIndex, columnIndex: value.startColumnIndex, deleteLength: 0, text: '?(' });
		edits.push({ rowIndex: value.endRowIndex, columnIndex: value.endColumnIndex, deleteLength: 2, text: ')' });
		for (const branch of branching.branches) {
			if (branch.type !== 'functionLiteral') {
				continue;
			}
			const params = branch.params;
			if (!isTypeHead(params)) {
				continue;
			}
			heads++;
			edits.push({ rowIndex: params.startRowIndex, columnIndex: params.startColumnIndex, deleteLength: 0, text: '[' });
			edits.push({ rowIndex: params.endRowIndex, columnIndex: params.endColumnIndex, deleteLength: 0, text: ']' });
		}
	}
	applyEdits(rows, edits);
	return { migrated: rows.join('\n'), branchings: branchings.length, heads: heads, skipped: false };
}

const files = targets.flatMap(target => collectJulFiles(target));
if (!write) {
	rmSync(shadowDir, { recursive: true, force: true });
	mkdirSync(shadowDir, { recursive: true });
}

let totalBranchings = 0;
let totalHeads = 0;
let totalSkipped = 0;
const report = [];
for (const filePath of files) {
	const { migrated, branchings, heads, skipped } = migrateFile(filePath);
	if (skipped) {
		totalSkipped++;
		console.warn(`  WARN parst nicht mit dem alten Compiler, uebersprungen: ${filePath}`);
		continue;
	}
	if (write) {
		writeFileSync(filePath, migrated, 'utf8');
	}
	else {
		const shadowName = toPosix(filePath).replace(/^[A-Za-z]:/, '').split('/').filter(Boolean).join('__');
		writeFileSync(join(shadowDir, shadowName), migrated, 'utf8');
	}
	totalBranchings += branchings;
	totalHeads += heads;
	report.push([branchings, heads, filePath]);
}
report.sort((a, b) => b[0] - a[0]);
for (const [branchings, heads, filePath] of report) {
	if (branchings) {
		console.log(String(branchings).padStart(5), `heads=${heads}`.padStart(10), filePath);
	}
}
console.log(`\n${files.length} Dateien | ${totalBranchings} Branchings | ${totalHeads} Koepfe | ${totalSkipped} uebersprungen | ${write ? 'GESCHRIEBEN' : 'DRY-RUN (nur Schattenbaum)'}`);
if (!write) {
	console.log(`Schattenbaum: ${shadowDir}`);
}
