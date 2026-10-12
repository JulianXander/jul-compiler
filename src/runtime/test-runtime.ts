// Laufzeit für `jul test`: Register, Instrumentierung und Ausgabe der Tests.
// Getrennt von runtime.ts, damit nichts davon in einen normalen Build gelangt. Importiert wird
// dieses Modul nur von *.test.jul-Dateien (siehe Emitter) und vom Compiler, der _runTests aufruft -
// beide über denselben Pfad, sonst hätten sie getrennte Register.

import { relative } from 'path';
import { fileURLToPath } from 'url';
import { _createFunction, _Function, _julTypeSymbol, _StreamClass, _Text } from './runtime.js';
import type { BuiltInType, RuntimeDictionary, RuntimeType } from './runtime.js';

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
export const test = /*#__PURE__*/ _createFunction(
	function test(name: string, callback: () => unknown, location?: TestLocation) {
		registeredTests.push({ name, callback, location });
	},
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
 * Laufzeitwert in JUL-Schreibweise, einzeilig. Für Skalare genügt typeToString, weil Literale in
 * JUL auch Typen sind. Kollektionen, Funktionen und Objekte wie Date würde typeToString dagegen
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
	return typeToString(value as RuntimeType, 0);
}

//#region Typen und Skalare als Text

function typeToString(type: RuntimeType, indent: number): string {
	switch (typeof type) {
		case 'bigint':
		case 'boolean':
			return type.toString();
		case 'function':
			return 'CustomType: ' + type;
		case 'number':
			return type.toString() + 'f';
		case 'object': {
			if (type === null) {
				// TODO throw error?
				return '[]';
			}
			if (Array.isArray(type)) {
				return arrayTypeToString(type, indent);
			}
			if (_julTypeSymbol in type) {
				switch (type[_julTypeSymbol]) {
					case 'and':
						return `And${arrayTypeToString(type.ChoiceTypes, indent, 'round')}`;
					case 'any':
						return 'Any';
					case 'blob':
						return 'Blob';
					case 'boolean':
						return 'Boolean';
					case 'date':
						return 'Date';
					case 'dictionary':
						return `Dictionary(${typeToString(type.ElementType, indent)})`;
					case 'dictionaryLiteral':
						return dictionaryTypeToString(type.Fields, ': ', indent);
					case 'empty':
						return 'Empty';
					case 'error':
						return 'Error';
					case 'float':
						return 'Float';
					case 'function':
						return 'Function';
					case 'bound':
						return `${type.Relation === 'greater' ? 'Greater' : 'Less'}${type.Family === 'integer' ? 'Integer' : 'Float'}(${typeToString(type.Value, indent)})`;
					case 'integer':
						return 'Integer';
					case 'list':
						return `List(${typeToString(type.ElementType, indent)})`;
					case 'not':
						return `Not(${typeToString(type.SourceType, indent)})`;
					case 'or':
						return `Or${arrayTypeToString(type.ChoiceTypes, indent, 'round')}`;
					case 'stream':
						return 'Stream';
					case 'text':
						return 'Text';
					case 'tuple':
						return arrayTypeToString(type.ElementTypes, indent);
					case 'type':
						return 'Type';
					case 'typeOf':
						return `TypeOf(${typeToString(type.value, indent)})`;
					case 'lazy':
						// Der Name statt des Typs: ausgeschrieben endete die Rekursion nicht.
						return type.name;
					default: {
						const assertNever: never = type;
						throw new Error(`Unexpected BuiltInType ${(assertNever as BuiltInType)[_julTypeSymbol]}`);
					}
				}
			}
			// Dictionary
			return dictionaryTypeToString(type, ' = ', indent);
		}
		case 'string':
			return `§${type.replaceAll('§', '§§')}§`;
		case 'undefined':
			return '[]';
		default: {
			const assertNever: never = type;
			throw new Error(`Unexpected type ${typeof assertNever}`);
		}
	}
}

const maxElementsPerLine = 5;
function arrayTypeToString(
	array: RuntimeType[],
	indent: number,
	kind: 'round' | 'square' = 'square',
): string {
	const multiline = array.length > maxElementsPerLine;
	const newIndent = multiline
		? indent + 1
		: indent;
	return bracketedExpressionToString(
		array.map(element =>
			typeToString(element, newIndent)),
		multiline,
		indent,
		kind);
}

function dictionaryTypeToString(
	dictionary: RuntimeDictionary,
	nameSeparator: string,
	indent: number,
): string {
	const multiline = Object.keys(dictionary).length > 1;
	const newIndent = multiline
		? indent + 1
		: indent;
	return bracketedExpressionToString(
		Object.entries(dictionary).map(([key, element]) => {
			return `${key}${nameSeparator}${typeToString(element, newIndent)}`;
		}),
		multiline,
		indent);
}

/**
 * @param kind Daten werden eckig geschrieben, die Argumentliste eines Typaufrufs
 * wie Or/And rund.
 */
function bracketedExpressionToString(
	elements: string[],
	multiline: boolean,
	indent: number,
	kind: 'round' | 'square' = 'square',
): string {
	const indentString = '\t'.repeat(indent + 1);
	const openingBracketSeparator = multiline
		? '\n' + indentString
		: '';
	const elementSeparator = multiline
		? '\n' + indentString
		: ' ';
	const closingBracketSeparator = multiline
		? '\n' + '\t'.repeat(indent)
		: '';
	const [opening, closing] = kind === 'round'
		? ['(', ')']
		: ['[', ']'];
	return `${opening}${openingBracketSeparator}${elements.join(elementSeparator)}${closingBracketSeparator}${closing}`;
}

//#endregion Typen und Skalare als Text
