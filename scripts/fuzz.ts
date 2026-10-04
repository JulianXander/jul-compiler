import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { isMainThread, parentPort, Worker, workerData } from 'worker_threads';

import { createInMemoryHost, loadFile } from '../src/compiler/project-loader.js';
import type { CompilerError } from '../src/compiler-errors.js';

/**
 * Mutations-Fuzzer für Parser und Checker. Kein Test-Gate, sondern eine Suche nach Eingaben, bei
 * denen parse + check eine Exception werfen, nicht in endlicher Zeit fertig werden oder
 * Fehlerpositionen außerhalb der Datei melden. Die Zusage "nur Diagnostics, nie ein Throw" trägt
 * den Language Server beim Tippen.
 * Aufruf: npm run fuzz [-- --seed 42 --seconds 20 --timeout 1000 ordner]
 * Gleicher Seed, gleiche Eingaben (solange der Korpus gleich bleibt). Funde landen verkleinert
 * unter scripts/fuzz-findings, Exit-Code 1 bei Funden.
 */

//#region Typen

type FindingKind = 'exception' | 'hang' | 'position';

interface Finding {
	kind: FindingKind;
	/** Gruppiert gleichartige Funde, damit nicht jede Mutation derselben Ursache gespeichert wird */
	signature: string;
	detail: string;
}

type WorkerRequest = { path: string; code: string; };
type WorkerResponse = Finding | undefined;

//#endregion Typen

//#region Worker

/**
 * Eine Eingabe laden und prüfen. Läuft im Worker, damit eine Endlosschleife den Fuzzer nicht
 * blockiert: Der Hauptthread beendet den Worker nach dem Timeout.
 */
function checkInput(files: { [path: string]: string; }, request: WorkerRequest): WorkerResponse {
	const allFiles = { ...files, [request.path]: request.code };
	const host = createInMemoryHost(allFiles, { cloneUnchecked: false });
	try {
		const parsed = loadFile(request.path, {}, host, request.code);
		const rows = request.code.split('\n');
		const errors: CompilerError[] = [
			...parsed.unchecked.errors,
			...parsed.checked?.errors ?? [],
		];
		for (const error of errors) {
			const problem = getPositionProblem(error, rows);
			if (problem) {
				return {
					kind: 'position',
					signature: `position ${error.code} ${problem}`,
					detail: `${problem}: ${JSON.stringify(error)}`,
				};
			}
		}
		return undefined;
	}
	catch (error) {
		const stack = error instanceof Error
			? error.stack ?? error.message
			: String(error);
		const [message = '', ...frames] = stack.split('\n');
		return {
			kind: 'exception',
			// Meldung plus oberste Stelle: dieselbe Ursache soll nicht für jede Eingabe neu zählen
			signature: `exception ${message.replace(/\d+/g, 'N')} ${frames[0]?.trim() ?? ''}`,
			detail: stack,
		};
	}
}

function getPositionProblem(error: CompilerError, rows: string[]): string | undefined {
	const { startRowIndex, startColumnIndex, endRowIndex, endColumnIndex } = error;
	// Ein Ende darf am Anfang der Zeile hinter der Datei stehen (Ende ist exklusiv, z.B. bei `?()`)
	const endsAfterFile = endRowIndex === rows.length && endColumnIndex === 0;
	if (startRowIndex < 0 || startRowIndex >= rows.length || (endRowIndex >= rows.length && !endsAfterFile)) {
		return 'Zeile außerhalb der Datei';
	}
	if (startColumnIndex < 0 || startColumnIndex > rows[startRowIndex]!.length
		|| (!endsAfterFile && endColumnIndex > rows[endRowIndex]!.length)) {
		return 'Spalte außerhalb der Zeile';
	}
	if (startRowIndex > endRowIndex
		|| (startRowIndex === endRowIndex && startColumnIndex > endColumnIndex)) {
		return 'Ende vor Anfang';
	}
	return undefined;
}

if (!isMainThread) {
	// Das Limit ist in Node 10, dieselbe Einstellung wie in CLI, Language Server und Tests
	Error.stackTraceLimit = 10;
	const files = workerData as { [path: string]: string; };
	parentPort!.on('message', (request: WorkerRequest) => {
		parentPort!.postMessage(checkInput(files, request));
	});
}

//#endregion Worker

//#region Zufall und Mutationen

/** mulberry32: kleiner Generator mit Seed, damit ein Lauf reproduzierbar bleibt */
function createRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6D2B79F5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

/** Bausteine, die die Syntax tragen. Mehrzeichen-Stücke, weil die Sprache an Wörtern hängt. */
const snippets = [
	'(', ')', '[', ']', '§', '?', ':', '=', '=>', '->', '...', '.', ',', '\t', '\n', ' ',
	'a', 'b', 'x', 'Integer', 'Text', 'Or', 'And', 'Not', 'TypeOf', 'List', '0', '1', '-1', '1.5',
	'§a§', '[]', '()', '\n\t', '\n\t\t', ' = ', ': ', '#', 'import', '(a: Integer) => a',
];

function mutate(code: string, random: () => number): string {
	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
	const int = (max: number): number => Math.floor(random() * (max + 1));
	const mutationCount = 1 + int(2);
	let result = code;
	for (let index = 0; index < mutationCount; index++) {
		const rows = result.split('\n');
		switch (pick(['delete', 'insert', 'insert', 'dupRow', 'delRow', 'swapRows', 'indent', 'truncate'])) {
			case 'delete': {
				const start = int(result.length);
				const length = 1 + int(Math.min(20, result.length - start));
				result = result.slice(0, start) + result.slice(start + length);
				break;
			}
			case 'insert': {
				const at = int(result.length);
				result = result.slice(0, at) + pick(snippets) + result.slice(at);
				break;
			}
			case 'dupRow': {
				const row = int(rows.length - 1);
				rows.splice(row, 0, rows[row]!);
				result = rows.join('\n');
				break;
			}
			case 'delRow': {
				rows.splice(int(rows.length - 1), 1);
				result = rows.join('\n');
				break;
			}
			case 'swapRows': {
				const first = int(rows.length - 1);
				const second = int(rows.length - 1);
				[rows[first], rows[second]] = [rows[second]!, rows[first]!];
				result = rows.join('\n');
				break;
			}
			case 'indent': {
				const row = int(rows.length - 1);
				rows[row] = random() < 0.5
					? '\t' + rows[row]
					: rows[row]!.replace(/^\t/, '');
				result = rows.join('\n');
				break;
			}
			case 'truncate': {
				result = result.slice(0, int(result.length));
				break;
			}
		}
	}
	return result;
}

//#endregion Zufall und Mutationen

//#region Hauptprogramm

interface Options {
	seed: number;
	seconds: number;
	timeout: number;
	folder: string;
}

function parseArguments(argv: string[]): Options {
	const getValue = (name: string): string | undefined => {
		const index = argv.indexOf(name);
		return index >= 0
			? argv[index + 1]
			: undefined;
	};
	const flagValues = new Set(['--seed', '--seconds', '--timeout'].flatMap(name => {
		const index = argv.indexOf(name);
		return index >= 0
			? [index, index + 1]
			: [];
	}));
	return {
		seed: Number(getValue('--seed') ?? Date.now() % 1000000),
		seconds: Number(getValue('--seconds') ?? 20),
		timeout: Number(getValue('--timeout') ?? 1000),
		folder: resolve(argv.find((_arg, index) => !flagValues.has(index)) ?? join(import.meta.dirname, '../../jul-examples')),
	};
}

function findJulFiles(folder: string): string[] {
	return readdirSync(folder).flatMap(entry => {
		const fullPath = join(folder, entry);
		if (statSync(fullPath).isDirectory()) {
			return entry === 'out' || entry === 'node_modules' || entry === '.git'
				? []
				: findJulFiles(fullPath);
		}
		return fullPath.endsWith('.jul')
			? [fullPath]
			: [];
	});
}

/** Ein Worker, der nach einem Timeout ersetzt wird. Das Starten kostet, weil der Checker die core-lib lädt. */
class Runner {
	private worker: Worker | undefined;

	constructor(
		private readonly files: { [path: string]: string; },
		private readonly timeout: number,
	) { }

	run(request: WorkerRequest): Promise<WorkerResponse> {
		const worker = this.worker ??= new Worker(new URL(import.meta.url), { workerData: this.files });
		return new Promise<WorkerResponse>(resolvePromise => {
			const timer = setTimeout(() => {
				cleanup();
				this.worker = undefined;
				void worker.terminate();
				resolvePromise({
					kind: 'hang',
					signature: 'hang',
					detail: `Keine Antwort nach ${this.timeout} ms`,
				});
			}, this.timeout);
			const onMessage = (response: WorkerResponse): void => {
				cleanup();
				resolvePromise(response);
			};
			const onError = (error: Error): void => {
				cleanup();
				this.worker = undefined;
				resolvePromise({
					kind: 'exception',
					signature: `worker ${error.message}`,
					detail: error.stack ?? error.message,
				});
			};
			const cleanup = (): void => {
				clearTimeout(timer);
				worker.off('message', onMessage);
				worker.off('error', onError);
			};
			worker.once('message', onMessage);
			worker.once('error', onError);
			worker.postMessage(request);
		});
	}

	close(): Promise<number> | undefined {
		return this.worker?.terminate();
	}
}

/**
 * Verkleinert die Eingabe, solange derselbe Fund bleibt: erst ganze Zeilen, dann kleiner werdende
 * Zeichenblöcke. Mit Budget, weil bei einem Hang jeder Versuch den Timeout kostet.
 */
async function minimize(runner: Runner, path: string, code: string, signature: string, budget: number): Promise<string> {
	let best = code;
	let attempts = 0;
	const stillFails = async (candidate: string): Promise<boolean> => {
		attempts++;
		const finding = await runner.run({ path: path, code: candidate });
		return finding?.signature === signature;
	};
	const rows = best.split('\n');
	for (let index = rows.length - 1; index >= 0 && attempts < budget; index--) {
		const candidate = [...rows.slice(0, index), ...rows.slice(index + 1)].join('\n');
		if (await stillFails(candidate)) {
			rows.splice(index, 1);
			best = candidate;
		}
	}
	for (let size = Math.max(1, best.length >> 1); size >= 1 && attempts < budget; size >>= 1) {
		for (let start = best.length - size; start >= 0 && attempts < budget; start -= size) {
			const candidate = best.slice(0, start) + best.slice(start + size);
			if (await stillFails(candidate)) {
				best = candidate;
			}
		}
	}
	return best;
}

async function main(): Promise<void> {
	const options = parseArguments(process.argv.slice(2));
	const filePaths = findJulFiles(options.folder);
	if (!filePaths.length) {
		console.log(`${options.folder}: keine .jul-Dateien gefunden`);
		process.exit(1);
	}
	const files = Object.fromEntries(filePaths.map(filePath =>
		[filePath, readFileSync(filePath, { encoding: 'utf8' })]));
	const findingsFolder = resolve(import.meta.dirname, 'fuzz-findings');
	const random = createRandom(options.seed);
	const runner = new Runner(files, options.timeout);

	console.log(`${options.folder}: ${filePaths.length} Dateien, Seed ${options.seed}, ${options.seconds} s, Timeout ${options.timeout} ms`);
	const start = performance.now();
	const counts = new Map<string, { finding: Finding; count: number; }>();
	let rounds = 0;

	// Die erste Runde ohne Mutation: ein Fund dort ist ein Fehler im Korpus, nicht in der Mutation
	while (performance.now() - start < options.seconds * 1000) {
		const path = filePaths[Math.floor(random() * filePaths.length)]!;
		const code = rounds === 0
			? files[path]!
			: mutate(files[path]!, random);
		rounds++;
		const finding = await runner.run({ path: path, code: code });
		if (!finding) {
			continue;
		}
		const known = counts.get(finding.signature);
		if (known) {
			known.count++;
			continue;
		}
		counts.set(finding.signature, { finding: finding, count: 1 });
		const minimized = await minimize(runner, path, code, finding.signature, finding.kind === 'hang' ? 40 : 400);
		mkdirSync(findingsFolder, { recursive: true });
		const fileName = `${options.seed}-${rounds}-${finding.kind}.jul`;
		writeFileSync(join(findingsFolder, fileName), minimized);
		// Der Detailtext gehört zur verkleinerten Eingabe, nicht zur ursprünglichen
		const minimizedFinding = await runner.run({ path: path, code: minimized });
		writeFileSync(join(findingsFolder, fileName + '.txt'), `${path}\n${finding.signature}\n\n${(minimizedFinding ?? finding).detail}\n`);
		console.log(`FUND ${finding.kind}: ${fileName} (${code.length} -> ${minimized.length} Zeichen)`);
		console.log(`  ${finding.signature}`);
	}
	await runner.close();

	const seconds = (performance.now() - start) / 1000;
	console.log(`${rounds} Eingaben in ${seconds.toFixed(1)} s (${(rounds / seconds).toFixed(0)}/s), ${counts.size} verschiedene Funde`);
	counts.forEach(({ finding, count }) => console.log(`  ${count}x ${finding.signature}`));
	process.exit(counts.size ? 1 : 0);
}

if (isMainThread) {
	void main();
}

//#endregion Hauptprogramm
