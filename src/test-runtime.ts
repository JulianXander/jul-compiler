// Laufzeit für `jul test`: Register, Instrumentierung und Ausgabe der Tests.
// Getrennt von runtime.ts, damit nichts davon in einen normalen Build gelangt. Importiert wird
// dieses Modul nur von *.test.jul-Dateien (siehe Emitter) und vom Compiler, der _runTests aufruft -
// beide über denselben Pfad, sonst hätten sie getrennte Register.

import { relative } from 'path';
import { fileURLToPath } from 'url';
import { _createFunction, _Function, _julTypeSymbol, _StreamClass, _Text, _typeToString } from './runtime.js';

/**
 * Stelle des test-Aufrufs im .jul-Quelltext, 1-basiert. Setzt der Emitter als drittes Argument,
 * es gehört nicht zur Signatur in der core-lib.
 */
export interface TestLocation {
	file: string;
	row: number;
	column: number;
}
interface RegisteredTest {
	name: string;
	callback: () => unknown;
	location: TestLocation | undefined;
}
/**
 * Der äußerste Aufruf im Rumpf eines Test-Callbacks, samt ausgewerteten Argumenten. Schreibt
 * _testCall, gelesen wird er nur, wenn der Test fehlschlägt.
 */
interface TestCall {
	name: string;
	args: unknown[];
}
const registeredTests: RegisteredTest[] = [];
let lastTestCall: TestCall | undefined;
/**
 * Registriert nur, ausgeführt wird erst über _runTests. Ein Test ist bestanden, wenn der Callback
 * true liefert.
 */
export const test = (name: string, callback: () => unknown, location?: TestLocation) => {
	registeredTests.push({ name, callback, location });
};
_createFunction(
	test,
	{
		singleNames: [
			{
				name: 'name',
				type: _Text
			},
			{
				name: 'callback',
				type: _Function
			},
		]
	}
);
/**
 * Um den äußersten Aufruf im Callback eines test gelegt (siehe Emitter), damit eine
 * Fehlschlagsmeldung die ausgewerteten Argumente nennen kann.
 */
export function _testCall(name: string, fn: Function, args: unknown[]): unknown {
	// Vor dem Aufruf, damit auch eine Exception die Argumente nennen kann.
	lastTestCall = { name, args };
	return fn(...args);
}
export interface TestResult {
	name: string;
	location: TestLocation | undefined;
	/**
	 * Nur bei einem Fehlschlag: was stattdessen herauskam, z.B. `equal(1 2) returned false`.
	 */
	failure: string | undefined;
	/**
	 * Nur bei einer Exception: die erste Stelle im Stack, die in eine .jul-Datei zeigt.
	 */
	failureLocation?: TestLocation;
	durationMs: number;
}

/**
 * Führt alle bisher registrierten Tests aus und entfernt sie aus dem Register. Jedes Ergebnis geht
 * an report, sobald es feststeht; wie es dargestellt wird, entscheidet der Aufrufer.
 * Mit names nur die Tests, deren Name genau einer davon ist, die übrigen werden übersprungen.
 */
export function _runTests(
	report: (result: TestResult) => void,
	names?: string[],
): { testCount: number; failedCount: number; skippedCount: number; } {
	const allTests = registeredTests.splice(0);
	const tests = names === undefined
		? allTests
		: allTests.filter(candidate => names.includes(candidate.name));
	let failedCount = 0;
	for (const registered of tests) {
		lastTestCall = undefined;
		let result: unknown;
		let thrown: { error: unknown; } | undefined;
		const startTime = performance.now();
		try {
			result = registered.callback();
		}
		catch (error) {
			thrown = { error };
		}
		const durationMs = performance.now() - startTime;
		const passed = !thrown && result === true;
		if (!passed) {
			failedCount++;
		}
		const failureLocation = thrown?.error instanceof Error
			? getJulStackLocation(thrown.error)
			: undefined;
		report({
			name: registered.name,
			location: registered.location,
			failure: passed
				? undefined
				: getTestFailureText(result, thrown, lastTestCall),
			...failureLocation && { failureLocation: failureLocation },
			durationMs: durationMs,
		});
	}
	return {
		testCount: tests.length,
		failedCount: failedCount,
		skippedCount: allTests.length - tests.length,
	};
}

function getTestFailureText(
	result: unknown,
	thrown: { error: unknown; } | undefined,
	call: TestCall | undefined,
): string {
	const callText = call
		? `${call.name}(${call.args.map(valueToString).join(' ')}) `
		: '';
	if (thrown) {
		const error = thrown.error;
		return `${callText}threw ${error instanceof Error ? error.message : String(error)}`;
	}
	return `${callText}returned ${valueToString(result)}`;
}

/**
 * Die erste Stelle im Stack, die in eine .jul-Datei zeigt, relativ zum Arbeitsverzeichnis. Die gibt
 * es nur mit Source Maps (siehe testProject). Frames in der Runtime und im Compiler fallen so von
 * selbst heraus. Die erste Zeile des Stacks ist die Meldung und wird übergangen.
 */
function getJulStackLocation(error: Error): TestLocation | undefined {
	const frames = error.stack?.split('\n').slice(1) ?? [];
	for (const frame of frames) {
		const match = /((?:file:\/\/)?[^\s()]+\.jul):(\d+):(\d+)/.exec(frame);
		if (match) {
			const [, pathOrUrl, row, column] = match;
			const path = pathOrUrl!.startsWith('file://')
				? fileURLToPath(pathOrUrl!)
				: pathOrUrl!;
			return {
				file: relative(process.cwd(), path),
				row: Number(row),
				column: Number(column),
			};
		}
	}
	return undefined;
}

/**
 * Laufzeitwert in JUL-Schreibweise, einzeilig. Für Skalare genügt _typeToString, weil Literale in
 * JUL auch Typen sind. Kollektionen, Funktionen und Objekte wie Date würde _typeToString dagegen
 * als Typ lesen.
 */
function valueToString(value: unknown): string {
	if (typeof value === 'function') {
		return 'Function';
	}
	if (value instanceof Error) {
		return `Error(${valueToString(value.message)})`;
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (value instanceof _StreamClass) {
		return 'Stream';
	}
	if (Array.isArray(value)) {
		return `[${value.map(valueToString).join(' ')}]`;
	}
	if (typeof value === 'object'
		&& value !== null
		&& !(_julTypeSymbol in value)) {
		return `[${Object.entries(value).map(([key, fieldValue]) => `${key} = ${valueToString(fieldValue)}`).join(' ')}]`;
	}
	return _typeToString(value as Parameters<typeof _typeToString>[0], 0);
}
