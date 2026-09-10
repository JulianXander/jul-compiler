import { expect } from 'chai';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { formatErrors } from './compiler.js';
import { CompilerError, ErrorCode } from './compiler-errors.js';

// eslint-disable-next-line no-control-regex
const ansiPattern = /\x1b\[[0-9;]*m/g;
function stripAnsi(text: string): string {
	return text.replace(ansiPattern, '');
}

describe('formatErrors', () => {
	// Rust-Stil (docs/error-message-elaboration.md, Option C2): der Quellcode-Ausschnitt mit
	// ^^^^^-Markierung braucht eine echte Datei auf der Platte, formatErrors liest sie selbst.
	// ANSI-Farbcodes werden vor dem Vergleich entfernt, sonst wäre der erwartete String voller
	// unsichtbarer Steuerzeichen und schon bei harmlosen Farbänderungen im Code hinfällig.
	let filePath: string;

	beforeEach(() => {
		filePath = join(tmpdir(), `jul-compiler-formatErrors-test-${Date.now()}.jul`);
		writeFileSync(filePath, 'a: Integer = 4\nb: Text = 5\n');
	});

	afterEach(() => {
		unlinkSync(filePath);
	});

	it('shows the exact source line with a caret marker under the error position', () => {
		const errors: CompilerError[] = [
			{
				code: ErrorCode.definitionTypeMismatch,
				message: 'Definition type mismatch.\nCan not assign 5 to Text.',
				startRowIndex: 1,
				startColumnIndex: 0,
				endRowIndex: 1,
				endColumnIndex: 11,
			},
		];
		const output = stripAnsi(formatErrors(filePath, errors));
		expect(output).to.equal([
			'TypeError JUL5000: Definition type mismatch.',
			'Can not assign 5 to Text.',
			` --> ${filePath}:2:1`,
			'  |',
			'2 | b: Text = 5',
			'  | ^^^^^^^^^^^',
		].join('\n'));
	});

	// Rust-Stil: nur eine `-->`-Zeile für die Hauptstelle. relatedInformation bekommt keine
	// eigene Positionsangabe als Text - die Position steckt in der Lage der Markierung selbst,
	// das Label steht direkt hinter dem Marker der zugehörigen Quellzeile. Fixture bewusst eine
	// echte Funktion mit deklariertem Rückgabetyp, nicht nur beliebige Definitionen - sonst passt
	// der Code nicht zum simulierten returnTypeMismatch.
	it('adds a second frame for relatedInformation without a separate position line', () => {
		writeFileSync(filePath, 'f = () :> Integer =>\n\t§hello§\n');
		const errors: CompilerError[] = [
			{
				code: ErrorCode.returnTypeMismatch,
				message: 'Return type mismatch.\nCan not assign Text to Integer.',
				startRowIndex: 1,
				startColumnIndex: 1,
				endRowIndex: 1,
				endColumnIndex: 8,
				relatedInformation: {
					message: 'Declared as Integer here.',
					startRowIndex: 0,
					startColumnIndex: 10,
					endRowIndex: 0,
					endColumnIndex: 17,
				},
			},
		];
		const output = stripAnsi(formatErrors(filePath, errors));
		expect(output).to.equal([
			'TypeError JUL5100: Return type mismatch.',
			'Can not assign Text to Integer.',
			` --> ${filePath}:2:2`,
			'  |',
			'1 | f = () :> Integer =>',
			'  |           ^^^^^^^ Declared as Integer here.',
			'2 | \t§hello§',
			'  |  ^^^^^^^',
		].join('\n'));
	});

	// Bisher ungetestet: mehrzeiliger Span braucht die volle Klammerung mit "|"-Verbindern am
	// linken Rand (Rust-Stil), nicht nur die erste Zeile - Entscheidung in der Session 2026-09-10.
	// Variable heißt bewusst nicht "returnType" (liest sich sonst wie ein Rückgabetyp) und die
	// Meldung trägt das reale "Definition type mismatch."-Präfix, das checker.ts hier voranstellt.
	// Position deckt die GANZE Definition ab (Spalte 0), nicht nur den Aufruf f(...) - so setzt
	// checker.ts es tatsächlich (expression.startRowIndex/endRowIndex der ganzen Definition),
	// sonst sähe es aus wie eine gezielte Markierung des Aufrufs (Argument type mismatch).
	it('brackets a multiline span with connector bars like rustc', () => {
		writeFileSync(filePath, 'f = (x: Integer) =>\n\tx\nresult: Text = f(\n\t1\n)\n');
		const errors: CompilerError[] = [
			{
				code: ErrorCode.definitionTypeMismatch,
				message: 'Definition type mismatch.\nCan not assign Integer to Text.',
				startRowIndex: 2,
				startColumnIndex: 0,
				endRowIndex: 4,
				endColumnIndex: 1,
			},
		];
		const output = stripAnsi(formatErrors(filePath, errors));
		expect(output).to.equal([
			'TypeError JUL5000: Definition type mismatch.',
			'Can not assign Integer to Text.',
			` --> ${filePath}:3:1`,
			'  |',
			'3 |   result: Text = f(',
			'  |   ^',
			'4 | | \t1',
			'5 | | )',
			'  | | _^',
		].join('\n'));
	});

	it('brackets a multiline argument list for an argument type mismatch', () => {
		writeFileSync(filePath, 'myFunc = (x: Text) => x\nresult = myFunc(\n\t5\n)\n');
		const errors: CompilerError[] = [
			{
				code: ErrorCode.argumentTypeMismatch,
				message: 'Argument type mismatch.\nCan not assign 5 to Text.',
				startRowIndex: 1,
				startColumnIndex: 9,
				endRowIndex: 3,
				endColumnIndex: 1,
			},
		];
		const output = stripAnsi(formatErrors(filePath, errors));
		expect(output).to.equal([
			'TypeError JUL5050: Argument type mismatch.',
			'Can not assign 5 to Text.',
			` --> ${filePath}:2:10`,
			'  |',
			'2 |   result = myFunc(',
			'  |   _________^',
			'3 | | \t5',
			'4 | | )',
			'  | | _^',
		].join('\n'));
	});
});
