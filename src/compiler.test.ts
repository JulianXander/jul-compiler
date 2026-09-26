import { expect } from 'chai';
import { join, resolve } from 'path';
import { SourceMapConsumer } from 'source-map';

import { createSourceMap, formatErrors, LiveRenderer } from './compiler.js';
import { CompilerError, ErrorCode } from './compiler-errors.js';
import { createInMemoryHost } from './project-loader.js';

// eslint-disable-next-line no-control-regex
const ansiPattern = /\x1b\[[0-9;]*m/g;
function stripAnsi(text: string): string {
	return text.replace(ansiPattern, '');
}

describe('formatErrors', () => {
	// Rust-Stil (docs/error-message-elaboration.md, Option C2): der Quellcode-Ausschnitt mit
	// ^^^^^-Markierung kommt aus dem übergebenen Host, hier aus dem Speicher.
	// ANSI-Farbcodes werden vor dem Vergleich entfernt, sonst wäre der erwartete String voller
	// unsichtbarer Steuerzeichen und schon bei harmlosen Farbänderungen im Code hinfällig.
	const filePath = join(resolve('/format-errors-test'), 'main.jul');
	function hostWith(code: string) {
		return createInMemoryHost({ [filePath]: code }, { cloneUnchecked: false });
	}
	const defaultHost = hostWith('a: Integer = 4\nb: Text = 5\n');

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
		const output = stripAnsi(formatErrors(filePath, errors, defaultHost));
		expect(output).to.equal([
			`TypeError JUL5000: Definition type mismatch. ${filePath}:2:1`,
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
		const host = hostWith('f = () :> Integer =>\n\t§hello§\n');
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
		const output = stripAnsi(formatErrors(filePath, errors, host));
		expect(output).to.equal([
			`TypeError JUL5100: Return type mismatch. ${filePath}:2:2`,
			'Can not assign Text to Integer.',
			` --> ${filePath}:2:2`,
			'  |',
			'1 | f = () :> Integer =>',
			'  |           ^^^^^^^ Declared as Integer here.',
			'2 |   §hello§',
			'  |   ^^^^^^^',
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
		const host = hostWith('f = (x: Integer) =>\n\tx\nresult: Text = f(\n\t1\n)\n');
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
		const output = stripAnsi(formatErrors(filePath, errors, host));
		expect(output).to.equal([
			`TypeError JUL5000: Definition type mismatch. ${filePath}:3:1`,
			'Can not assign Integer to Text.',
			` --> ${filePath}:3:1`,
			'  |',
			'3 |   result: Text = f(',
			'  |   ^',
			'4 | |   1',
			'5 | | )',
			'  | | ^',
		].join('\n'));
	});

	it('brackets a multiline argument list for an argument type mismatch', () => {
		const host = hostWith('myFunc = (x: Text) => x\nresult = myFunc(\n\t5\n)\n');
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
		const output = stripAnsi(formatErrors(filePath, errors, host));
		expect(output).to.equal([
			`TypeError JUL5050: Argument type mismatch. ${filePath}:2:10`,
			'Can not assign 5 to Text.',
			` --> ${filePath}:2:10`,
			'  |',
			'2 |   result = myFunc(',
			'  |   _________^',
			'3 | |   5',
			'4 | | )',
			'  | | ^',
		].join('\n'));
	});

	// Fund (Session 2026-09-10): reale Meldung aus yugioh/game-logic.jul zeigte einen zu kurzen
	// Konnektor bei tief eingerücktem, mehrzeiligem Span. Ursache: 1 Tab = 1 Spalte intern, aber
	// mehrere sichtbare Spalten im Terminal - ohne Umrechnung läuft der Marker dem Text davon,
	// sobald die Zeile mit Tabs eingerückt ist (expandTabs/visualColumn in compiler.ts).
	it('aligns connector markers under tab-indented, nested multiline content', () => {
		const host = hostWith('f = (values: List(Integer)) =>\n\tnewBoard: Text = [\n\t\t...values\n\t]\n\tnewBoard\n');
		const errors: CompilerError[] = [
			{
				code: ErrorCode.definitionTypeMismatch,
				message: 'Definition type mismatch.\nCan not assign List(Integer) to Text.',
				startRowIndex: 1,
				startColumnIndex: 1,
				endRowIndex: 3,
				endColumnIndex: 2,
			},
		];
		const output = stripAnsi(formatErrors(filePath, errors, host));
		expect(output).to.equal([
			`TypeError JUL5000: Definition type mismatch. ${filePath}:2:2`,
			'Can not assign List(Integer) to Text.',
			` --> ${filePath}:2:2`,
			'  |',
			'2 |     newBoard: Text = [',
			'  |   __^',
			'3 | |     ...values',
			'4 | |   ]',
			'  | | __^',
		].join('\n'));
	});

	// Fund: der Marker der Schlusszeile stand eine Spalte hinter dem letzten Zeichen des Spans.
	// endColumnIndex ist exklusiv (die einzeilige Markierung rechnet damit), der Caret gehört
	// also unter das Zeichen davor - hier unter das schliessende ']', nicht unter das ')'.
	it('marks the last character of a multiline span, not the one behind it', () => {
		const host = hostWith('f = (t: Text) => t\nf([\n\t1\n])\n');
		const errors: CompilerError[] = [
			{
				code: ErrorCode.argumentTypeMismatch,
				message: 'Argument type mismatch.\nCan not assign [1] to Text.',
				startRowIndex: 1,
				startColumnIndex: 2,
				endRowIndex: 3,
				endColumnIndex: 1,
			},
		];
		const output = stripAnsi(formatErrors(filePath, errors, host));
		expect(output).to.equal([
			`TypeError JUL5050: Argument type mismatch. ${filePath}:2:3`,
			'Can not assign [1] to Text.',
			` --> ${filePath}:2:3`,
			'  |',
			'2 |   f([',
			'  |   __^',
			'3 | |   1',
			'4 | | ])',
			'  | | ^',
		].join('\n'));
	});

	// Fund: formatErrors färbt Label und Code immer mit ConsoleColor.lightRed, unabhängig von
	// severity - eine Warning (z.B. unreachableBranch) erscheint dadurch genauso rot wie ein
	// Error. Deshalb hier bewusst OHNE stripAnsi: der Test soll gerade die Farbcodes prüfen.
	// colorize färbt nur bei TTY-Ausgabe (siehe compiler.ts) - der Testrunner selbst ist kein TTY,
	// isTTY wird deshalb für die Dauer des Tests erzwungen.
	it('colors a warning severity error yellow, not red', () => {
		const originalIsTty = process.stdout.isTTY;
		(process.stdout as any).isTTY = true;
		try {
			const errors: CompilerError[] = [
				{
					code: ErrorCode.unreachableBranch,
					message: 'Unreachable branch detected.',
					startRowIndex: 0,
					startColumnIndex: 0,
					endRowIndex: 0,
					endColumnIndex: 1,
				},
			];
			const output = formatErrors(filePath, errors, defaultHost);
			const firstLine = output.split('\n')[0]!;
			expect(firstLine).to.include('\x1b[33m', 'Warning sollte gelb (33) statt rot (91) gefärbt sein');
			expect(firstLine).not.to.include('\x1b[91m');
		}
		finally {
			(process.stdout as any).isTTY = originalIsTty;
		}
	});
});

describe('LiveRenderer', () => {
	// Kein g-Flag: mit /g würde .test() über den lastIndex-State zwischen Aufrufen Treffer
	// verschlucken.
	const eraseRegex = /\x1b\[\d+A\x1b\[0J/;

	// Fund: log() löschte den alten Frame selbst, rief danach aber render() auf, das intern
	// nochmal löschte - mit der noch alten, nicht zurückgesetzten frameHeight. Das zweite Löschen
	// sprang dadurch über den gerade gedruckten Text hinaus und schnitt ihn ab (Session
	// 2026-09-22). Test schreibt direkt auf process.stdout, deshalb kein stripAnsi-Vergleich
	// gegen einen einzelnen String, sondern eine Prüfung der einzelnen write()-Aufrufe.
	it('erases only once per log() call, otherwise the just-printed text gets cut off', () => {
		const writes: string[] = [];
		const originalIsTty = process.stdout.isTTY;
		const originalWrite = process.stdout.write;
		(process.stdout as any).isTTY = true;
		(process.stdout as any).write = (chunk: any) => {
			writes.push(String(chunk));
			return true;
		};
		let renderer: LiveRenderer | undefined;
		try {
			renderer = new LiveRenderer();
			renderer.start('entry.jul');
			renderer.startStep('compiling');
			renderer.finishStep('failed');
			writes.length = 0; // nur den log()-Aufruf selbst betrachten
			renderer.log('line-one\nline-two');
			const eraseCount = writes.filter(write => eraseRegex.test(write)).length;
			expect(eraseCount).to.equal(1, 'log() darf pro Aufruf nur einmal löschen');
			expect(writes.some(write => stripAnsi(write).includes('line-one'))).to.be.true;
			expect(writes.some(write => stripAnsi(write).includes('line-two'))).to.be.true;
		}
		finally {
			renderer?.stop();
			(process.stdout as any).isTTY = originalIsTty;
			process.stdout.write = originalWrite;
		}
	});
});

describe('createSourceMap', () => {
	const mappings = [{ generatedLine: 1, generatedColumn: 2, sourceLine: 4, sourceColumn: 1 }];
	// source-map ist 1-basiert bei Zeilen, 0-basiert bei Spalten.
	it('maps-generated-to-source-position', () => {
		const consumer = new SourceMapConsumer(createSourceMap(mappings, join('src', 'a.jul'), join('out', 'src', 'a.js'), 'code'));
		expect(consumer.originalPositionFor({ line: 2, column: 2 })).to.deep.equal({
			source: '../../src/a.jul',
			line: 5,
			column: 1,
			name: null,
		});
	});
	it('source-is-relative-to-out-file-with-forward-slashes', () => {
		const sourceMap = createSourceMap(mappings, join('src', 'a.jul'), join('out', 'b', 'a.js'), 'code');
		expect(sourceMap.sources).to.deep.equal(['../../src/a.jul']);
	});
	it('contains-source-code', () => {
		const sourceMap = createSourceMap(mappings, 'a.jul', 'a.js', 'code');
		expect(sourceMap.sourcesContent).to.deep.equal(['code']);
	});
});
