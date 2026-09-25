import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import { pathToFileURL } from 'url';

import { errorInfos } from '../src/compiler-errors.js';
import { syntaxTreeToJs } from '../src/emitter.js';
import { createFileSystemHost, loadFile } from '../src/project-loader.js';
import { ParsedDocuments } from '../src/checker/checker.js';
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
 * Emittiert wird gegen src/runtime.ts (über tsx), also ohne Build und ohne webpack.
 * Aufruf: npm run bench-runtime [--save] [--note "grund"]
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
const runtimeUrl = pathToFileURL(resolve(import.meta.dirname, '../src/runtime.ts')).href;

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
}

const complexValue = {
	a: 1n,
	b: {
		c: 'c',
		d: Array.from({ length: 20 }, (_, index) => BigInt(index)),
	},
};
const cases: BenchCase[] = [
	{
		file: 'branching.jul',
		functionName: 'emptyOrComplex',
		inputs: [undefined, complexValue],
		expected: [2n, 1n],
		calls: 200_000,
	},
	{
		file: 'branching.jul',
		functionName: 'textListOrDictionary',
		inputs: ['text', Array.from({ length: 50 }, (_, index) => BigInt(index)), { name: 'name' }],
		expected: [1n, 2n, 3n],
		calls: 200_000,
	},
	{
		file: 'branching.jul',
		functionName: 'tagField',
		inputs: [{ kind: 'circle', radius: 1.5 }, { kind: 'rect', width: 1.5, height: 2.5 }],
		expected: [1n, 2n],
		calls: 200_000,
	},
	{
		file: 'named-arguments.jul',
		functionName: 'positional',
		inputs: [1n],
		expected: [1n],
		calls: 1_000_000,
	},
	{
		file: 'named-arguments.jul',
		functionName: 'namedInOrder',
		inputs: [1n],
		expected: [1n],
		calls: 1_000_000,
	},
	{
		file: 'named-arguments.jul',
		functionName: 'namedSwapped',
		inputs: [1n],
		expected: [1n],
		calls: 1_000_000,
	},
];

async function compileFixture(file: string, outFolder: string): Promise<{ [name: string]: unknown; }> {
	const filePath = join(fixtureFolder, file);
	const documents: ParsedDocuments = {};
	loadFile(filePath, documents, createFileSystemHost({ cloneUnchecked: false }));
	const parsed = documents[filePath]!;
	const expressions = parsed.checked ?? parsed.unchecked;
	const errors = expressions.errors.filter(error => errorInfos[error.code].severity === 'error');
	if (errors.length) {
		throw new Error(`${file}: ${errors.map(error => `${error.startRowIndex + 1}: ${error.message}`).join('\n')}`);
	}
	const outPath = join(outFolder, basename(file, '.jul') + '.mjs');
	writeFileSync(outPath, syntaxTreeToJs(expressions.expressions ?? [], runtimeUrl));
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

const { save, note } = parseArgs(process.argv.slice(2));
const outFolder = mkdtempSync(join(tmpdir(), 'jul-bench-runtime-'));
try {
	const modules: { [file: string]: { [name: string]: unknown; }; } = {};
	for (const benchCase of cases) {
		modules[benchCase.file] ??= await compileFixture(benchCase.file, outFolder);
	}
	const results: BenchResult[] = cases.map(benchCase => {
		const fn = modules[benchCase.file]![benchCase.functionName];
		if (typeof fn !== 'function') {
			throw new Error(`${benchCase.file}: ${benchCase.functionName} ist keine Funktion`);
		}
		verify(benchCase, fn);
		return {
			label: `${basename(benchCase.file, '.jul')}/${benchCase.functionName}`,
			values: stats(measure(benchCase, fn)),
		};
	});
	const previous = readPrevious(logPath, target, getMachine());
	console.log(fixtureFolder);
	console.log(`  ${cases.length} Fälle, je ${runCount} Durchläufe, ms je ${normCalls} Aufrufe`);
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
