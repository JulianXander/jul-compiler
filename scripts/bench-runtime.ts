import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import { pathToFileURL } from 'url';

import { errorInfos } from '../src/compiler-errors.js';
import { syntaxTreeToJs } from '../src/compiler/emitter.js';
import { loadFile } from '../src/compiler/project-loader.js';
import { createFileSystemHost } from '../src/compiler/node-host.js';
import { ParsedDocuments } from '../src/checker/checker.js';
import { getFileCheckResult } from '../src/checker/check-result.js';
import {
	appendEntries,
	BenchResult,
	formatResult,
	getMachine,
	parseArgs,
	readPrevious,
	stats,
} from './bench-log.js';

/**
 * Wall-Clock Messung des erzeugten Codes, nicht des Compilers: die Fixtures unter
 * scripts/bench-runtime werden geparst, gecheckt und emittiert, danach ruft der Bench ihre
 * exportierten Funktionen in einer heißen Schleife auf. Kein Test-Gate, nur Beleg für Umbauten
 * am Emitter und an der Runtime.
 * Emittiert wird gegen src/runtime/runtime.ts (über tsx), also ohne Build und ohne webpack.
 * Aufruf: npm run bench-runtime [--save] [--note "grund"] [fixture ...]
 * Mit --save wird die Messung an scripts/bench-log-runtime.tsv angehängt, sonst nur verglichen.
 * Protokolliert werden ms je normCalls Aufrufe, unabhängig davon, wie viele ein Durchlauf macht:
 * so bleibt ein Fall vergleichbar, wenn seine Aufrufzahl später angepasst werden muss.
 */

const runCount = 15;
const normCalls = 1_000_000;
const target = 'bench-runtime';
const fixtureFolder = resolve(import.meta.dirname, 'bench-runtime');
const logPath = resolve(import.meta.dirname, 'bench-log-runtime.tsv');
const chartScript = resolve(import.meta.dirname, 'bench-chart.mjs');
const runtimeUrl = pathToFileURL(resolve(import.meta.dirname, '../src/runtime/runtime.ts')).href;

interface BenchCase {
	file: string;
	functionName: string;
	/** Werte in Laufzeitdarstellung; die Schleife wechselt zwischen ihnen, damit jeder Branch drankommt */
	inputs: unknown[];
	/** Ergebnis je Eingabe: eine Optimierung, die den Branch verwechselt, soll hier auffallen, nicht erst in der Zeit */
	expected: unknown[];
	/**
	 * Aufrufe je Durchlauf. Je Fall eigens gewählt: genug, dass ein Durchlauf nicht im Rauschen
	 * des Timers liegt, ohne dass teure Fälle den Bench in die Länge ziehen.
	 */
	calls: number;
	/** Name im Protokoll, wenn datei/funktion nicht eindeutig ist (dieselbe Funktion mit anderen Eingaben) */
	label?: string;
	/**
	 * Zieht aus dem Ergebnis den Wert, der mit expected verglichen wird. Nötig, wenn die Funktion
	 * bei jedem Aufruf ein neues Objekt liefert: das wäre nie identisch mit expected.
	 */
	select?: (result: any) => unknown;
}

const complexValue = {
	a: 1,
	b: {
		c: 'c',
		d: Array.from({ length: 20 }, (_, index) => index),
	},
};
// Wie ein Spielzustand mit Karten-Ids (PositiveInteger): 60 Karten, jede mit eigenem Record
const boundState = {
	turn: 3,
	cards: Array.from({ length: 60 }, (_, index) => ({
		id: index + 1,
		name: `Karte ${index}`,
		atk: index % 3 ? 1800 : undefined,
	})),
};
// Dasselbe ohne Schlüssel mit undefined: Die volle Laufzeitprüfung (_branch) lehnt atk: undefined bei atk?: Integer ab,
// boundState ist für sie kein BoundState. Für den Vergleich mit _branch braucht es einen gültigen Wert.
const validBoundState = {
	turn: boundState.turn,
	cards: boundState.cards.map(({ atk, ...card }) => atk === undefined ? card : { ...card, atk: atk }),
};
const hundredIntegers = Array.from({ length: 100 }, (_, index) => index + 1);
const fiftyIntegers = Array.from({ length: 50 }, (_, index) => index + 1);
// Wie ein Spielzustand: ein Record mit vielen Feldern, ein Feld ändert sich je Update
const createGameLike = (turn: number) => ({
	turn,
	phase: 'main1',
	priority: 1,
	turnPlayer: 1,
	life1: 8000,
	life2: 8000,
	deck1: fiftyIntegers,
	deck2: fiftyIntegers,
	hand1: [1, 2, 3, 4, 5],
	hand2: [6, 7, 8, 9, 10],
	events: ['draw', 'summon'],
	chain: [1],
});
// Gleiches Feld hp in vier Formen (andere Feldreihenfolge und andere Felder)
const unitShapes = [
	{ name: 'a', hp: 10, atk: 1 },
	{ hp: 20, name: 'b', def: 2 },
	{ atk: 3, hp: 30, level: 4, name: 'c' },
	{ level: 5, hp: 40 },
];
// Deckt alles ab, was der JSON-Parser für JUL umwandelt: Integer, Dezimalzahl und Exponent,
// null und leere Kollektionen (Empty), Escapes
const smallJson = JSON.stringify({
	marker: 7,
	id: 12345,
	name: 'Beispiel "klein"',
	active: true,
	price: 19.99,
	tags: ['a', 'b', 'c'],
	owner: null,
	meta: {},
	history: [],
	address: { street: 'Hauptstraße 1', city: 'Köln', zip: '50667' },
});
const largeJson = JSON.stringify({
	marker: 42,
	records: Array.from({ length: 1000 }, (_, index) => ({
		id: index,
		name: `Eintrag ${index}\n"zitiert"\r\nmit é`,
		value: index * 1.25,
		scale: 'EXPONENT',
		big: 'BIG',
		enabled: index % 2 === 0,
		parent: index % 3 ? null : index - 1,
		children: index % 5 ? [] : [index + 1, index + 2],
		extra: index % 7 ? {} : { note: 'selten' },
	})),
})
	// JSON.stringify schreibt weder Exponenten noch Zahlen über 2^53
	.replaceAll('"EXPONENT"', '1.5e3')
	.replaceAll('"BIG"', '12345678901234567890');
// Lange Texte wie Beschreibungen in Stammdaten: hier zählt das Stringparsing
const textJson = JSON.stringify({
	marker: 3,
	texts: Array.from({ length: 1000 }, (_, index) =>
		`Beschreibung ${index}: ein längerer Text mit Inhalt, wie er in Stammdaten steht. `.repeat(2)
		+ (index % 10 ? '' : '\n"mit Escapes"\té')),
});
// Paare frischer Kopien: nie identisch, damit der === Kurzschluss nicht greift
const createDeepValue = (): any => ({
	id: 1,
	name: 'name',
	tags: ['a', 'b', 'c'],
	nested: { x: 1, y: 2, list: Array.from({ length: 10 }, (_, index) => index) },
});
const deepChanged = createDeepValue();
deepChanged.nested.list[9] = 99;
const deepEqualPairs = {
	lists: [
		{ first: [1, 2, 3, 4, 5, 6, 7, 8], second: [1, 2, 3, 4, 5, 6, 7, 8] },
		{ first: [1, 2, 3, 4, 5, 6, 7, 8], second: [1, 2, 3, 4, 5, 6, 7, 9] },
	],
	dictionaries: [
		{ first: { a: 1, b: 2, c: 3, d: 4 }, second: { a: 1, b: 2, c: 3, d: 4 } },
		{ first: { a: 1, b: 2, c: 3, d: 4 }, second: { a: 1, b: 2, c: 3, d: 5 } },
		{ first: { a: 1, b: 2, c: 3, d: 4 }, second: { a: 1, b: 2, c: 3 } },
		{ first: { a: 1, b: 2, c: 3, d: 4 }, second: { a: 1, b: 2, c: 3, e: 4 } },
	],
	nested: [
		{ first: createDeepValue(), second: createDeepValue() },
		{ first: createDeepValue(), second: deepChanged },
	],
};
const cases: BenchCase[] = [
	{
		file: 'deep-equal.jul',
		functionName: 'equalPair',
		label: 'deep-equal/lists',
		inputs: deepEqualPairs.lists,
		expected: [true, false],
		calls: 500_000,
	},
	{
		file: 'deep-equal.jul',
		functionName: 'equalPair',
		label: 'deep-equal/dictionaries',
		inputs: deepEqualPairs.dictionaries,
		expected: [true, false, false, false],
		calls: 500_000,
	},
	{
		file: 'deep-equal.jul',
		functionName: 'equalPair',
		label: 'deep-equal/nested',
		inputs: deepEqualPairs.nested,
		expected: [true, false],
		calls: 200_000,
	},
	{
		file: 'recursion.jul',
		functionName: 'sumTo',
		inputs: [2000],
		expected: [2001000],
		calls: 2_000,
	},
	{
		file: 'branching.jul',
		functionName: 'emptyOrComplex',
		inputs: [undefined, complexValue],
		expected: [2, 1],
		calls: 200_000,
	},
	{
		file: 'branching.jul',
		functionName: 'textListOrDictionary',
		inputs: ['text', Array.from({ length: 50 }, (_, index) => index), { name: 'name' }],
		expected: [1, 2, 3],
		calls: 200_000,
	},
	{
		file: 'branching.jul',
		functionName: 'tagField',
		inputs: [{ kind: 'circle', radius: 1.5 }, { kind: 'rect', width: 1.5, height: 2.5 }],
		expected: [1, 2],
		calls: 200_000,
	},
	{
		file: 'branching.jul',
		functionName: 'literalUnion',
		inputs: ['draw', 'main2', 'battle', 'end'],
		expected: [1, 2, 3, 4],
		calls: 200_000,
	},
	{
		file: 'branching.jul',
		functionName: 'emptyOrIntegerUnion',
		inputs: [undefined, 3, 6, 8],
		expected: [0, 0, 1, 2],
		calls: 200_000,
	},
	{
		file: 'branching.jul',
		functionName: 'errorOrBoundState',
		inputs: [new Error('fehler'), boundState],
		expected: [1, 2],
		calls: 200_000,
	},
	{
		file: 'branching.jul',
		functionName: 'notGuard',
		inputs: [undefined, 3],
		expected: [0, 1],
		calls: 200_000,
	},
	{
		file: 'branching.jul',
		functionName: 'notRecordGuard',
		inputs: [undefined, validBoundState],
		expected: [1, 2],
		calls: 200_000,
	},
	{
		file: 'branching.jul',
		functionName: 'emptyOrBoundState',
		inputs: [undefined, boundState],
		expected: [1, 2],
		calls: 200_000,
	},
	{
		file: 'branching.jul',
		functionName: 'boundStateHead',
		inputs: [undefined, boundState],
		expected: [2, 1],
		calls: 200_000,
	},
	{
		file: 'branching.jul',
		functionName: 'boundHead',
		inputs: [0, 5],
		expected: [2, 1],
		calls: 200_000,
	},
	{
		file: 'branching.jul',
		functionName: 'textOrBoundHead',
		inputs: ['5', 0, 5],
		expected: [2, 2, 1],
		calls: 200_000,
	},
	{
		file: 'branching.jul',
		functionName: 'greaterCall',
		inputs: [0, 5],
		expected: [false, true],
		calls: 200_000,
	},
	{
		file: 'named-arguments.jul',
		functionName: 'positional',
		inputs: [1],
		expected: [1],
		calls: 1_000_000,
	},
	{
		file: 'named-arguments.jul',
		functionName: 'namedInOrder',
		inputs: [1],
		expected: [1],
		calls: 1_000_000,
	},
	{
		file: 'callbacks.jul',
		functionName: 'countAbove',
		inputs: [{ limit: 50, values: hundredIntegers }, { limit: 0, values: hundredIntegers }],
		expected: [50, 100],
		calls: 100_000,
	},
	{
		file: 'comparison.jul',
		functionName: 'countEqual',
		inputs: [hundredIntegers],
		expected: [1],
		calls: 100_000,
	},
	{
		file: 'comparison.jul',
		functionName: 'countDifferent',
		inputs: [hundredIntegers],
		expected: [99],
		calls: 100_000,
	},
	{
		file: 'callbacks.jul',
		functionName: 'countSmall',
		inputs: [{ limit: 1, values: [1, 2, 3] }, { limit: 5, values: [1, 2, 3] }],
		expected: [2, 0],
		calls: 500_000,
	},
	{
		file: 'callbacks.jul',
		functionName: 'sumWithIndex',
		inputs: [fiftyIntegers],
		expected: [2550],
		calls: 100_000,
	},
	{
		file: 'callbacks.jul',
		functionName: 'sumWithoutIndex',
		inputs: [fiftyIntegers],
		expected: [1275],
		calls: 100_000,
	},
	{
		file: 'list-search.jul',
		functionName: 'containsBoth',
		inputs: [[1, 2, 3, 4, 5, 6, 7, 8]],
		expected: [true],
		calls: 500_000,
	},
	{
		file: 'list-concat.jul',
		functionName: 'flattenShort',
		inputs: [
			[[1, 2], undefined, [3, 4, 5], [6], undefined, [7, 8]],
			[undefined, [1], undefined],
		],
		expected: [8, 1],
		calls: 500_000,
	},
	{
		file: 'list-concat.jul',
		functionName: 'concatLists',
		inputs: [
			{ first: [1, 2, 3, 4, 5], second: [6, 7] },
			{ first: [1, 2, 3], second: undefined },
			{ first: undefined, second: [1, 2] },
		],
		expected: [7, 3, 2],
		calls: 500_000,
	},
	{
		file: 'list-concat.jul',
		functionName: 'mergeDictionaries',
		inputs: [
			{ first: { a: 1, b: 2, c: 3 }, second: { b: 20, d: 4 } },
			{ first: { a: 1, b: 2 }, second: { c: 3 } },
		],
		expected: [20, 2],
		calls: 500_000,
	},
	{
		file: 'record-update.jul',
		functionName: 'nextTurn',
		inputs: [createGameLike(3), createGameLike(10)],
		expected: [4, 11],
		calls: 500_000,
	},
	{
		file: 'record-update.jul',
		functionName: 'nextTwice',
		inputs: [createGameLike(3)],
		expected: [7900],
		calls: 500_000,
	},
	{
		file: 'field-access.jul',
		functionName: 'unitScore',
		inputs: unitShapes,
		expected: [11, 21, 31, 41],
		calls: 1_000_000,
	},
	{
		file: 'object-shapes.jul',
		functionName: 'sumAtk',
		inputs: [0, 1],
		expected: [12800, 12801],
		calls: 500_000,
	},
	{
		file: 'object-shapes.jul',
		functionName: 'attackRound',
		inputs: [0, 1],
		expected: [12800, 12801],
		calls: 200_000,
	},
	{
		file: 'json.jul',
		functionName: 'parseJsonText',
		label: 'json/small',
		inputs: [smallJson],
		expected: [7],
		select: result => result.marker,
		calls: 20_000,
	},
	{
		file: 'json.jul',
		functionName: 'parseJsonText',
		label: 'json/large',
		inputs: [largeJson],
		expected: [42],
		select: result => result.marker,
		calls: 50,
	},
	{
		file: 'json.jul',
		functionName: 'parseJsonText',
		label: 'json/texts',
		inputs: [textJson],
		expected: [3],
		select: result => result.marker,
		calls: 200,
	},
	// Kurze Zahlen wie Positionen, Level und ATK aus Eingabefeldern oder der URL
	{
		file: 'parsing.jul',
		functionName: 'parseIntegerText',
		label: 'parsing/shortInteger',
		inputs: ['7', '1800', '-3', '2500'],
		expected: [7, 1800, -3, 2500],
		calls: 1_000_000,
	},
	// Jenseits von 2^53 - 1: Ergebnis bigint
	{
		file: 'parsing.jul',
		functionName: 'parseIntegerText',
		label: 'parsing/hugeInteger',
		inputs: ['9007199254740993', '-123456789012345678901'],
		expected: [9007199254740993n, -123456789012345678901n],
		calls: 1_000_000,
	},
	// 16 Ziffern im sicheren Bereich
	{
		file: 'parsing.jul',
		functionName: 'parseIntegerText',
		label: 'parsing/longInteger',
		inputs: ['9007199254740991', '-1234567890123456'],
		expected: [9007199254740991, -1234567890123456],
		calls: 1_000_000,
	},
];

async function compileFixture(file: string, outFolder: string): Promise<{ [name: string]: unknown; }> {
	const filePath = join(fixtureFolder, file);
	const documents: ParsedDocuments = {};
	loadFile(filePath, documents, createFileSystemHost());
	const parsed = documents[filePath]!;
	const expressions = parsed.checked ?? parsed.syntax;
	const errors = expressions.errors.filter(error => errorInfos[error.code].severity === 'error');
	if (errors.length) {
		throw new Error(`${file}: ${errors.map(error => `${error.startRowIndex + 1}: ${error.message}`).join('\n')}`);
	}
	const outPath = join(outFolder, basename(file, '.jul') + '.mjs');
	writeFileSync(outPath, syntaxTreeToJs(getFileCheckResult(parsed), expressions.expressions ?? [], runtimeUrl));
	return import(pathToFileURL(outPath).href);
}

function verify(benchCase: BenchCase, fn: Function): void {
	benchCase.inputs.forEach((input, index) => {
		const result = fn(input);
		const expected = benchCase.expected[index];
		if (result !== expected) {
			throw new Error(`${benchCase.file} ${benchCase.functionName}(${String(input)}): ${String(result)} statt ${String(expected)}`);
		}
	});
}

function measure(benchCase: BenchCase, fn: Function): number[] {
	const { inputs, expected } = benchCase;
	const durations: number[] = [];
	// erster Lauf wärmt den JIT auf und zählt nicht
	for (let run = 0; run <= runCount; run++) {
		// Jedes Ergebnis wird verwendet: ein unbenutztes darf der JIT samt Aufruf wegwerfen, dann
		// misst die Schleife nichts mehr.
		let mismatches = 0;
		const start = performance.now();
		for (let call = 0; call < benchCase.calls; call++) {
			const index = call % inputs.length;
			if (fn(inputs[index]) !== expected[index]) {
				mismatches++;
			}
		}
		const duration = performance.now() - start;
		if (mismatches) {
			throw new Error(`${benchCase.file} ${benchCase.functionName}: ${mismatches} falsche Ergebnisse`);
		}
		if (run) {
			durations.push(duration * normCalls / benchCase.calls);
		}
	}
	return durations;
}

const { save, note, targets } = parseArgs(process.argv.slice(2));
// Weitere Argumente wählen Fixtures aus (Dateiname ohne .jul), für abwechselnde Läufe einzelner Fälle
const selectedCases = targets.length
	? cases.filter(benchCase => targets.includes(basename(benchCase.file, '.jul')))
	: cases;
const outFolder = mkdtempSync(join(tmpdir(), 'jul-bench-runtime-'));
try {
	const modules: { [file: string]: { [name: string]: unknown; }; } = {};
	for (const benchCase of selectedCases) {
		modules[benchCase.file] ??= await compileFixture(benchCase.file, outFolder);
	}
	const results: BenchResult[] = selectedCases.map(benchCase => {
		const fn = modules[benchCase.file]![benchCase.functionName];
		if (typeof fn !== 'function') {
			throw new Error(`${benchCase.file}: ${benchCase.functionName} ist keine Funktion`);
		}
		// Nur bei Fällen mit select eingewickelt: die übrigen messen weiter den nackten Aufruf
		const { select } = benchCase;
		const measured = select
			? (input: unknown) => select(fn(input))
			: fn;
		verify(benchCase, measured);
		return {
			label: benchCase.label ?? `${basename(benchCase.file, '.jul')}/${benchCase.functionName}`,
			values: stats(measure(benchCase, measured)),
		};
	});
	const previous = readPrevious(logPath, target, getMachine());
	console.log(fixtureFolder);
	console.log(`  ${selectedCases.length} Fälle, je ${runCount} Durchläufe, ms je ${normCalls} Aufrufe`);
	results.forEach(({ label, values }) =>
		console.log(formatResult(label, values, previous?.[label])));
	if (save) {
		appendEntries(logPath, results, target, note);
		console.log(`  protokolliert: ${logPath}`);
		if (existsSync(logPath)) {
			execFileSync(process.execPath, [chartScript, '--log', logPath, '--machine', getMachine()], { stdio: 'inherit' });
		}
	}
	else {
		console.log('  zum Protokollieren: npm run bench-runtime -- --save --note "grund"');
	}
}
finally {
	rmSync(outFolder, { recursive: true, force: true });
}
