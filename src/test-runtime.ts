// Laufzeit für `jul test`: Register, Instrumentierung und Ausgabe der Tests.
// Getrennt von runtime.ts, damit nichts davon in einen normalen Build gelangt. Importiert wird
// dieses Modul nur von *.test.jul-Dateien (siehe Emitter) und vom Compiler, der _runTests aufruft -
// beide über denselben Pfad, sonst hätten sie getrennte Register.

import { _createFunction, _Function, _julTypeSymbol, _StreamClass, _Text, _typeToString } from './runtime.js';

/**
 * Stelle des test-Aufrufs im .jul-Quelltext, 1-basiert. Setzt der Emitter als drittes Argument,
 * es gehört nicht zur Signatur in der core-lib.
 */
interface TestLocation {
	file: string;
	row: number;
	column: number;
}
interface RegisteredTest {
	message: string;
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
export const test = (message: string, callback: () => unknown, location?: TestLocation) => {
	registeredTests.push({ message, callback, location });
};
_createFunction(
	test,
	{
		singleNames: [
			{
				name: 'message',
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
/**
 * Führt alle bisher registrierten Tests aus und entfernt sie aus dem Register.
 * Liefert, ob alle bestanden haben.
 */
export function _runTests(writeLine: (line: string) => void = console.log): boolean {
	const tests = registeredTests.splice(0);
	let failedCount = 0;
	for (const registered of tests) {
		lastTestCall = undefined;
		let result: unknown;
		let thrown: { error: unknown; } | undefined;
		try {
			result = registered.callback();
		}
		catch (error) {
			thrown = { error };
		}
		if (!thrown && result === true) {
			writeLine(`✓ ${registered.message}`);
			continue;
		}
		failedCount++;
		const location = registered.location;
		const locationText = location
			? ` (${location.file}:${location.row}:${location.column})`
			: '';
		writeLine(`✗ ${registered.message}${locationText}`);
		writeLine(`    ${getTestFailureText(result, thrown, lastTestCall)}`);
	}
	writeLine(`${tests.length} ${tests.length === 1 ? 'test' : 'tests'}, ${failedCount} failed`);
	return failedCount === 0;
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
