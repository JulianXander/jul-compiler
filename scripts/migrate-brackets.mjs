// Migriert JUL-Datenliterale von runden auf eckige Klammern: (1 2) -> [1 2].
//
// Hintergrund: Seit der "Datenklammer"-Aenderung sind ( ) Bindungsstellen
// (Aufruf-Argumentliste, Parameterliste, Destructuring-Ziel) und [ ] Datenliterale
// (List, Dictionary, DictionaryType, Empty, UnknownObject).
//
// Das Skript arbeitet AST-basiert, nicht per Regex: Es parst jede Datei mit dem ALTEN
// Parser, sammelt die Datenliteral-Knoten und tauscht genau deren Klammerzeichen.
// Argumentlisten werden ueber Objektidentitaet ausgenommen und bleiben rund.
// Da ( und [ gleich breit sind, bleiben alle Positionen im AST unveraendert - daraus
// folgt die Abnahme: AST und emittiertes JS muessen vor und nach der Migration
// byte-identisch sein.
//
// Aufruf:
//   node scripts/migrate-brackets.mjs --compiler <altes-out-verzeichnis> [--write] <ziel...>
//
// <ziel> sind Dateien oder Verzeichnisse (rekursiv nach *.jul durchsucht).
// Ohne --write bleiben die Quellen unberuehrt; das Ergebnis landet als Vorschau in
// einem Schattenbaum unter dem Temp-Verzeichnis (Pfad steht am Ende der Ausgabe,
// abweichend waehlbar mit --shadow <verzeichnis>).
// Bereits eckige Datenliterale werden uebersprungen, das Skript ist also idempotent
// und laeuft auch auf teilweise migrierten Codebasen.
//
// Das alte out-Verzeichnis bekommt man aus der Versionsgeschichte:
//   git checkout <commit-vor-der-umstellung> && npm run build
// und die entstandene out-Kopie beiseitelegen. Sie muss ein node_modules erreichen
// koennen, weil der Parser typescript statisch importiert.

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
// Ausserhalb des Repos, damit ein Trockenlauf auf eine fremde Codebasis nicht
// das Verzeichnis verschmutzt, aus dem das Skript aufgerufen wird.
const shadowDir = shadowIndex < 0
	? join(tmpdir(), 'jul-migrate-shadow')
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
		if (entry === 'node_modules' || entry === 'out' || entry === '.git') {
			continue;
		}
		collectJulFiles(join(target, entry), acc);
	}
	return acc;
}

const { parseCode } = await import(pathToFileURL(join(compilerDir, 'parser/parser.js')).href);

/** Knotentypen, die ein Datenliteral darstellen und damit eckig werden. */
const dataTypes = new Set(['list', 'dictionary', 'dictionaryType', 'empty', 'object']);
/** parent erzeugt Zyklen, typeInfo kommt erst vom Checker. */
const skipKeys = new Set(['parent', 'typeInfo']);

/**
 * Sammelt die zu migrierenden Datenliteral-Knoten sowie die unaufgeloesten
 * Klammerknoten (nur zur Warnung, werden nie angefasst).
 */
function analyse(root) {
	const argumentLists = new Set();
	const hits = [];
	const leftovers = [];
	// 1. Durchlauf: Argumentlisten ueber Objektidentitaet ausnehmen.
	// Positionsbasiert ginge nicht, weil der arguments-Knoten selbst ein Datenknoten ist.
	const seenExempt = new WeakSet();
	(function markArgumentLists(node) {
		if (!node || typeof node !== 'object' || seenExempt.has(node)) {
			return;
		}
		seenExempt.add(node);
		if (Array.isArray(node)) {
			node.forEach(markArgumentLists);
			return;
		}
		if (node.type === 'functionCall' && node.arguments) {
			argumentLists.add(node.arguments);
		}
		for (const key of Object.keys(node)) {
			if (!skipKeys.has(key)) {
				markArgumentLists(node[key]);
			}
		}
	})(root);
	// 2. Durchlauf: Zielknoten einsammeln
	const seenCollect = new WeakSet();
	(function collect(node) {
		if (!node || typeof node !== 'object' || seenCollect.has(node)) {
			return;
		}
		seenCollect.add(node);
		if (Array.isArray(node)) {
			node.forEach(collect);
			return;
		}
		if (typeof node.type === 'string' && typeof node.startRowIndex === 'number') {
			if (dataTypes.has(node.type) && !argumentLists.has(node)) {
				hits.push(node);
			}
			if (node.type === 'bracketed') {
				leftovers.push(node);
			}
		}
		for (const key of Object.keys(node)) {
			if (!skipKeys.has(key)) {
				collect(node[key]);
			}
		}
	})(root);
	return { hits, leftovers };
}

function migrateFile(filePath) {
	const code = readFileSync(filePath, 'utf8');
	const rows = code.split('\n');
	const parsed = parseCode(code, filePath);
	const { hits, leftovers } = analyse(parsed.unchecked.expressions);

	// Ersetzungen als Einzelkoordinaten. ( -> [ ist laengenneutral, daher ist die
	// Reihenfolge egal und verschachtelte Klammern kollidieren nie.
	// Die Map dedupliziert, weil Symboltabellen dieselben Knoten mehrfach referenzieren.
	const edits = new Map();
	let alreadySquare = 0;
	for (const node of hits) {
		const opening = rows[node.startRowIndex]?.[node.startColumnIndex];
		const closing = rows[node.endRowIndex]?.[node.endColumnIndex - 1];
		// Schon migriert: ueberspringen, damit das Skript idempotent bleibt und auch
		// auf teilweise migrierten Codebasen laeuft.
		if (opening === '[' && closing === ']') {
			alreadySquare++;
			continue;
		}
		if (opening !== '(' || closing !== ')') {
			throw new Error(`${filePath}:${node.startRowIndex + 1} ${node.type}: erwartet ( ), gefunden ${opening} ${closing}`);
		}
		edits.set(`${node.startRowIndex}:${node.startColumnIndex}`, [node.startRowIndex, node.startColumnIndex, '[']);
		edits.set(`${node.endRowIndex}:${node.endColumnIndex - 1}`, [node.endRowIndex, node.endColumnIndex - 1, ']']);
	}
	for (const [rowIndex, columnIndex, char] of edits.values()) {
		const row = rows[rowIndex];
		rows[rowIndex] = row.slice(0, columnIndex) + char + row.slice(columnIndex + 1);
	}
	const migrated = rows.join('\n');

	// Invarianten: laengenneutral und ausschliesslich Klammern getauscht.
	if (migrated.length !== code.length) {
		throw new Error(`${filePath}: Laenge veraendert`);
	}
	for (let index = 0; index < migrated.length; index++) {
		if (migrated[index] === code[index]) {
			continue;
		}
		const isBracketSwap = (code[index] === '(' && migrated[index] === '[')
			|| (code[index] === ')' && migrated[index] === ']');
		if (!isBracketSwap) {
			throw new Error(`${filePath}: unerwartete Aenderung an Offset ${index}: ${code[index]} -> ${migrated[index]}`);
		}
	}
	return { migrated, hits, leftovers, alreadySquare };
}

const files = targets.flatMap(target => collectJulFiles(target));
// Der Schattenbaum ist die Vorschau des Trockenlaufs. Beim Schreiben waere er
// redundant - dort zeigt die Versionsverwaltung den Unterschied besser.
if (!write) {
	rmSync(shadowDir, { recursive: true, force: true });
	mkdirSync(shadowDir, { recursive: true });
}

let totalHits = 0;
let totalWarnings = 0;
let totalAlreadySquare = 0;
const report = [];
for (const filePath of files) {
	const { migrated, hits, leftovers, alreadySquare } = migrateFile(filePath);
	if (write) {
		writeFileSync(filePath, migrated, 'utf8');
	}
	else {
		const shadowName = toPosix(filePath).replace(/^[A-Za-z]:/, '').split('/').filter(Boolean).join('__');
		writeFileSync(join(shadowDir, shadowName), migrated, 'utf8');
	}
	for (const leftover of leftovers) {
		console.warn(`  WARN unaufgeloeste Klammer, manuell pruefen: ${filePath}:${leftover.startRowIndex + 1}`);
	}
	totalHits += hits.length - alreadySquare;
	totalAlreadySquare += alreadySquare;
	totalWarnings += leftovers.length;
	report.push([hits.length - alreadySquare, leftovers.length, filePath]);
}
report.sort((a, b) => b[0] - a[0]);
for (const [count, warnings, filePath] of report) {
	if (count || warnings) {
		console.log(String(count).padStart(5), warnings ? `warn=${warnings}` : '      ', filePath);
	}
}
const alreadyInfo = totalAlreadySquare
	? ` | ${totalAlreadySquare} bereits eckig`
	: '';
console.log(`\n${files.length} Dateien | ${totalHits} Datenliterale${alreadyInfo} | ${totalWarnings} Warnungen | ${write ? 'GESCHRIEBEN' : 'DRY-RUN (nur Schattenbaum)'}`);
if (!write) {
	console.log(`Schattenbaum: ${shadowDir}`);
}
