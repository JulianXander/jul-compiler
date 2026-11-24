// Laufzeit für `jul test`: Register, Instrumentierung und Ausgabe der Tests.
// Getrennt von runtime.ts, damit nichts davon in einen normalen Build gelangt. Importiert wird
// dieses Modul nur von *.test.jul-Dateien (siehe Emitter) und vom Compiler, der _runTests aufruft -
// beide über denselben Pfad, sonst hätten sie getrennte Register.

import { _createFunction, _Function, _julTypeSymbol, _StreamClass, _takeAssertionViolation, _Text } from './runtime.js';
import type { AssertionViolation, BuiltInType, RuntimeDictionary, RuntimeType } from './runtime.js';

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
const registeredTests: RegisteredTest[] = [];
/**
 * Registriert nur, ausgeführt wird erst über _runTests. Ein Test ist bestanden, wenn der Callback
 * durchläuft, ohne ein assume oder assert zu verletzen. Was er liefert, zählt nicht.
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
export interface TestResult {
	name: string;
	location: TestLocation | undefined;
	/**
	 * Nur bei einem Fehlschlag: das verletzte assert oder assume oder die Exception, z.B.
	 * `assert failed: Summe: equal(1 2) returned false`.
	 */
	failure: string | undefined;
	/**
	 * Nur bei einer Exception: wo sie im .jul-Quelltext entstand (siehe ErrorLocator).
	 */
	failureLocation?: TestLocation;
	durationMs: number;
}

/**
 * Die Stelle im .jul-Quelltext, an der eine Exception entstand. Ohne Angabe die erste Stelle im
 * Stack, die in eine .jul-Datei zeigt. Die gibt es nur, wenn die Laufzeit Source Maps auf den Stack
 * anwendet (Node). Im Browser rechnet der Aufrufer selbst zurück.
 */
export type ErrorLocator = (error: Error) => TestLocation | undefined;

/**
 * Führt alle bisher registrierten Tests aus und entfernt sie aus dem Register. Jedes Ergebnis geht
 * an report, sobald es feststeht; wie es dargestellt wird, entscheidet der Aufrufer.
 * Mit names nur die Tests, deren Name genau einer davon ist, die übrigen werden übersprungen.
 */
export function _runTests(
	report: (result: TestResult) => void,
	names?: string[],
	getErrorLocation: ErrorLocator = getJulStackLocation,
): { testCount: number; failedCount: number; skippedCount: number; } {
	const allTests = registeredTests.splice(0);
	const tests = names === undefined
		? allTests
		: allTests.filter(candidate => names.includes(candidate.name));
	let failedCount = 0;
	for (const registered of tests) {
		// Ein Bruch aus dem Laden der Module oder einem früheren Test gehört nicht zu diesem.
		_takeAssertionViolation();
		let thrown: { error: unknown; } | undefined;
		const startTime = performance.now();
		try {
			registered.callback();
		}
		catch (error) {
			thrown = { error };
		}
		const durationMs = performance.now() - startTime;
		// Auch wenn JS-Code die Exception abgefangen hat und der Test danach durchläuft.
		const violation = _takeAssertionViolation();
		const passed = !violation && !thrown;
		if (!passed) {
			failedCount++;
		}
		const failureLocation = violation
			? getViolationLocation(violation)
			: thrown?.error instanceof Error
				? getErrorLocation(thrown.error)
				: undefined;
		report({
			name: registered.name,
			location: registered.location,
			failure: passed
				? undefined
				: violation
					? getAssertionViolationText(violation)
					: getThrownText(thrown!.error),
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

function getThrownText(error: unknown): string {
	return `threw ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Höchstlänge eines Werts in der Meldung eines verletzten assume oder assert: Behauptet und geprüft
 * werden oft ganze Spielzustände.
 */
const maxViolationValueLength = 200;

function getAssertionViolationText(violation: AssertionViolation): string {
	if (violation.kind === 'assume') {
		return `assume violated: ${shortValueToString(violation.value)} is not ${violation.typeText}`;
	}
	const call = violation.call;
	const callText = call
		? `: ${call.name}(${call.args.map(shortValueToString).join(' ')}) returned false`
		: '';
	return `assert failed: ${violation.message}${callText}`;
}

function shortValueToString(value: unknown): string {
	const valueText = valueToString(value);
	return valueText.length > maxViolationValueLength
		? valueText.slice(0, maxViolationValueLength) + '…'
		: valueText;
}

function getViolationLocation(violation: AssertionViolation): TestLocation {
	return { file: violation.file, row: violation.row, column: violation.column };
}

/**
 * Was beim Laden einer Testdatei schiefging, im Format eines fehlgeschlagenen Tests: ein verletztes
 * assume oder assert auf oberster Ebene eines geladenen Moduls oder eine andere Exception.
 */
export function _getLoadFailure(
	error: unknown,
	getErrorLocation: ErrorLocator = getJulStackLocation,
): { failure: string; failureLocation?: TestLocation; } {
	const violation = _takeAssertionViolation();
	if (violation) {
		return { failure: getAssertionViolationText(violation), failureLocation: getViolationLocation(violation) };
	}
	const failureLocation = error instanceof Error
		? getErrorLocation(error)
		: undefined;
	return {
		failure: getThrownText(error),
		...failureLocation && { failureLocation: failureLocation },
	};
}

/**
 * Die erste Stelle im Stack, die in eine .jul-Datei zeigt. Die gibt es nur mit Source Maps (siehe
 * testProject). Frames in der Runtime und im Compiler fallen so von selbst heraus. Die erste Zeile
 * des Stacks ist die Meldung und wird übergangen. Die Datei steht so da wie im Stack, als Pfad oder
 * file-URL: Die Runtime läuft auch im Browser und kennt kein Arbeitsverzeichnis, relativ macht sie
 * der Aufrufer.
 */
function getJulStackLocation(error: Error): TestLocation | undefined {
	const frames = error.stack?.split('\n').slice(1) ?? [];
	for (const frame of frames) {
		const match = /((?:file:\/\/)?[^\s()]+\.jul):(\d+):(\d+)/.exec(frame);
		if (match) {
			const [, pathOrUrl, row, column] = match;
			return {
				file: pathOrUrl!,
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
			// Kleine Integer und Float sind beide number. Ganzzahlig gilt sie wie zur Laufzeit als
			// Integer (docs/integer-darstellung.md), nur ein gebrochener Wert ist sicher ein Float.
			return Number.isInteger(type)
				? type.toString()
				: type.toString() + 'f';
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
					case 'optionalField':
						return typeToString(type.Type, indent);
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
					// Die Schlüssel ausgeschrieben wären bei card-data.json zehntausende.
					case 'keyOf':
						return 'KeyOf(…)';
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
			const optional = typeof element === 'object'
				&& element !== null
				&& (element as { [_julTypeSymbol]?: string; })[_julTypeSymbol] === 'optionalField';
			return `${key}${optional ? '?' : ''}${nameSeparator}${typeToString(element, newIndent)}`;
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
