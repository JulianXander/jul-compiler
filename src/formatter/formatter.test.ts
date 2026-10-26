import { expect } from 'chai';

import { parseCode } from '../parser/parser.js';
import { reportAtCaller } from '../test-util.js';
import { formatCode, getFormatEdits } from './formatter.js';

/**
 * Ohne expected bleibt der Code unverändert. Mit expected muss das Ergebnis fehlerfrei parsen und
 * ein zweiter Lauf nichts mehr ändern.
 */
const expectFormat = reportAtCaller((code: string, expected?: string) => {
	const formatted = formatCode(code, 'dummy.jul');
	expect(formatted).to.equal(expected ?? code);
	if (expected !== undefined) {
		expect(parseCode(formatted, 'dummy.jul').unchecked.errors, 'Ergebnis muss fehlerfrei sein').to.deep.equal([]);
		expect(formatCode(formatted, 'dummy.jul'), 'zweiter Lauf').to.equal(formatted);
	}
});

describe('Formatter', () => {
	//#region umbrechen
	it('alle Felder in einer Zeile', () => {
		expectFormat('x = [\n\t1 2 3\n]', 'x = [\n\t1\n\t2\n\t3\n]');
	});
	it('Klammer hinter den Feldern', () => {
		expectFormat('x = f(\n\ta b c)', 'x = f(\n\ta\n\tb\n\tc\n)');
	});
	it('nur eine Zeile mit mehreren Feldern', () => {
		expectFormat('x = [\n\t1\n\t2 3\n]', 'x = [\n\t1\n\t2\n\t3\n]');
	});
	it('benannte Felder', () => {
		expectFormat('x = [\n\ta = 1 b = 2\n]', 'x = [\n\ta = 1\n\tb = 2\n]');
	});
	it('Destructuring', () => {
		expectFormat('(\n\ta b\n) = x', '(\n\ta\n\tb\n) = x');
	});
	it('Parameterliste', () => {
		expectFormat('f = (\n\ta: Integer b: Integer\n) => a', 'f = (\n\ta: Integer\n\tb: Integer\n) => a');
	});
	it('Kommentar bleibt vor seinem Feld', () => {
		expectFormat('x = [\n\t# erstes\n\t1 2\n]', 'x = [\n\t# erstes\n\t1\n\t2\n]');
	});
	it('Leerzeile bleibt erhalten', () => {
		expectFormat('x = [\n\t1\n\n\t2 3\n]', 'x = [\n\t1\n\n\t2\n\t3\n]');
	});
	it('eingerückte Liste', () => {
		expectFormat('f = () =>\n\tx = [\n\t\t1 2\n\t]\n\tx', 'f = () =>\n\tx = [\n\t\t1\n\t\t2\n\t]\n\tx');
	});
	it('Lambda mit Blockrumpf erzwingt mehrzeilig', () => {
		expectFormat('x = [].map((value) =>\n\t§test§)', 'x = [].map(\n\t(value) =>\n\t\t§test§\n)');
	});
	it('Lambda mit Blockrumpf nach einem Argument', () => {
		expectFormat('x = [].map(a (value) =>\n\t§test§\n)', 'x = [].map(\n\ta\n\t(value) =>\n\t\t§test§\n)');
	});
	it('Branching erzwingt mehrzeilig', () => {
		expectFormat('x = 2.add(?(1)\n\t() => 1)', 'x = 2.add(\n\t?(1)\n\t\t() => 1\n)');
	});
	//#endregion umbrechen

	//#region zusammenziehen
	it('Felder in Folgezeilen', () => {
		expectFormat('x = [a\n\tb\n\tc\n]', 'x = [a b c]');
	});
	it('Feld in der Folgezeile, Klammer dahinter', () => {
		expectFormat('x = f(a b\n\tc)', 'x = f(a b c)');
	});
	it('mehrzeiliges Feld wird ausgerückt', () => {
		expectFormat('x = f(a\n\t[\n\t\tb\n\t]\n)', 'x = f(a [\n\tb\n])');
	});
	it('mehrzeiliger Text wird ausgerückt', () => {
		expectFormat('x = f(a\n\t§\n\t\ttext\n\t§\n)', 'x = f(a §\n\ttext\n§)');
	});
	it('Kommentar zwischen Feldern verhindert das Zusammenziehen', () => {
		expectFormat('x = f(a\n\t# Kommentar\n\tb\n)');
	});
	//#endregion zusammenziehen

	//#region verschachtelt
	it('innere einzeilige Liste bleibt einzeilig', () => {
		expectFormat('x = [\n\t1 [2 3] 4\n]', 'x = [\n\t1\n\t[2 3]\n\t4\n]');
	});
	it('äußere und innere Liste falsch', () => {
		expectFormat('x = [\n\t1 [2\n\t\t3]\n]', 'x = [\n\t1\n\t[2 3]\n]');
	});
	it('innere mehrzeilige Liste wird beim Umbrechen mitgenommen', () => {
		expectFormat('x = [\n\ta [\n\t\tb\n\t]\n]', 'x = [\n\ta\n\t[\n\t\tb\n\t]\n]');
	});
	it('falsche Liste im Argument eines Felds', () => {
		expectFormat('x = [\n\tf(\n\t\t1 2\n\t)\n]', 'x = [\n\tf(\n\t\t1\n\t\t2\n\t)\n]');
	});
	//#endregion verschachtelt

	//#region unverändert
	it('einzeilige Liste', () => {
		expectFormat('x = [1 2 3]');
	});
	it('mehrzeilige Liste', () => {
		expectFormat('x = [\n\t1\n\t2\n]');
	});
	it('mehrzeiliges Feld mitten in einzeiliger Liste', () => {
		expectFormat('x = f(a [\n\tb\n] c)');
	});
	it('Lambda in eigener Zeile', () => {
		expectFormat('x = [].map(\n\t(value) =>\n\t\t§test§\n)');
	});
	it('Klammer hinter schließender Klammer', () => {
		expectFormat('x = [\n\t[\n\t\t1\n\t]\n]');
	});
	it('fehlende Klammer', () => {
		expectFormat('x = [1 2');
	});
	//#endregion unverändert

	//#region nur die Liste an einer Stelle
	it('Liste an der Stelle mehrzeilig', () => {
		expect(formatCode('x = f(a b c)', 'dummy.jul', { at: { rowIndex: 0, columnIndex: 8 }, multiline: true }))
			.to.equal('x = f(\n\ta\n\tb\n\tc\n)');
	});
	it('Stelle am Anfang des ersten Felds', () => {
		expect(formatCode('x = f(a b)', 'dummy.jul', { at: { rowIndex: 0, columnIndex: 6 }, multiline: true }))
			.to.equal('x = f(\n\ta\n\tb\n)');
	});
	it('innerste Liste an der Stelle', () => {
		expect(formatCode('x = [1 [2 3] 4]', 'dummy.jul', { at: { rowIndex: 0, columnIndex: 9 }, multiline: true }))
			.to.equal('x = [1 [\n\t2\n\t3\n] 4]');
	});
	it('Stelle mitten in einem Text', () => {
		expect(formatCode('x = f(§ab c§ d)', 'dummy.jul', { at: { rowIndex: 0, columnIndex: 9 }, multiline: true }))
			.to.equal('x = f(§ab c§ d)');
	});
	it('andere Listen bleiben unverändert', () => {
		expect(formatCode('x = [\n\t1 2\n]\ny = f(a b)', 'dummy.jul', { at: { rowIndex: 3, columnIndex: 7 }, multiline: true }))
			.to.equal('x = [\n\t1 2\n]\ny = f(\n\ta\n\tb\n)');
	});
	it('ohne multiline nach dem Zeichen hinter der Klammer', () => {
		expect(formatCode('x = [a\n\tb]\ny = [\n\t1 2\n]', 'dummy.jul', { at: { rowIndex: 0, columnIndex: 6 } }))
			.to.equal('x = [a b]\ny = [\n\t1 2\n]');
	});
	it('verschachtelte Liste in der Liste an der Stelle', () => {
		expect(formatCode('x = f(a [1\n\t2])', 'dummy.jul', { at: { rowIndex: 0, columnIndex: 7 }, multiline: true }))
			.to.equal('x = f(\n\ta\n\t[1 2]\n)');
	});
	//#endregion nur die Liste an einer Stelle

	//#region Edits
	it('ein Edit nur über den geänderten Bereich', () => {
		expect(getFormatEdits('a = 1\nx = [\n\t1 2\n]\nb = 2', 'dummy.jul')).to.deep.equal([{
			startRowIndex: 2,
			startColumnIndex: 2,
			endRowIndex: 2,
			endColumnIndex: 3,
			newText: '\n\t',
		}]);
	});
	it('keine Edits ohne Änderung', () => {
		expect(getFormatEdits('x = [1 2]', 'dummy.jul')).to.deep.equal([]);
	});
	//#endregion Edits
});
