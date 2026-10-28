import { expect } from 'chai';

import { checkTypes } from './checker.js';
import { getTypeInfo } from './check-result.js';
import { parseCode } from '../parser/parser.js';
import { typeToString } from './type-algebra.js';

describe('CheckResult', () => {
	it('liest den Typ eines Knotens der eigenen Datei', () => {
		const parsed = parseCode('x = 1', 'a.jul');
		checkTypes(parsed, {});
		expect(getTypeInfo(parsed.checkResult!, parsed.syntax.expressions![0])).to.not.equal(undefined);
	});
	// Die Ids sind je Datei dicht, mit dem Ergebnis einer anderen Datei läse der Zugriff still den
	// Typ eines fremden Knotens. In den Tests prüft der Zugriff das (test-setup.mjs).
	it('wirft beim Zugriff mit dem Ergebnis einer anderen Datei', () => {
		const a = parseCode('x = 1', 'a.jul');
		const b = parseCode('y = §b§', 'b.jul');
		checkTypes(a, {});
		checkTypes(b, {});
		expect(() => getTypeInfo(a.checkResult!, b.syntax.expressions![0])).to.throw('does not belong');
	});
	// Der Checker schreibt nichts mehr in den Baum: Ein zweiter Check desselben Baums sieht weder
	// Symboltypen noch Verwendungen aus dem ersten. Vorwärtsreferenz (Symbol noch ohne Typ) und
	// ungenutzte Definition (isSymbolUsed) hingen früher daran.
	it('liefert beim zweiten Check desselben Baums dasselbe Ergebnis', () => {
		const code = [
			'f = () =>',
			'	unused = 1',
			'	used = 2',
			'	used',
			'x = y',
			'y = 1',
			'',
		].join('\n');
		const parsed = parseCode(code, 'a.jul');
		checkTypes(parsed, {});
		const firstResult = parsed.checkResult!;
		const firstErrors = parsed.checked!.errors.map(error => `${error.code} ${error.startRowIndex}:${error.startColumnIndex}`);
		const firstType = getTypeInfo(firstResult, parsed.syntax.expressions![0]);
		checkTypes(parsed, {});
		const secondErrors = parsed.checked!.errors.map(error => `${error.code} ${error.startRowIndex}:${error.startColumnIndex}`);
		expect(parsed.checkResult).to.not.equal(firstResult);
		expect(firstErrors).to.have.length.greaterThan(1);
		expect(secondErrors).to.deep.equal(firstErrors);
		// Funktionstypen sind nicht interniert, jeder Lauf erzeugt neue: verglichen wird die Textform.
		expect(typeToString(getTypeInfo(parsed.checkResult!, parsed.syntax.expressions![0])!.type, 0, 0))
			.to.equal(typeToString(firstType!.type, 0, 0));
	});
	it('trennt Parse-Fehler von den Fehlern des Checks', () => {
		const parsed = parseCode('x = undefinedName', 'a.jul');
		checkTypes(parsed, {});
		expect(parsed.syntax.errors).to.deep.equal([]);
		expect(parsed.checked!.errors).to.have.length(1);
		expect(parsed.checkResult!.errors).to.equal(parsed.checked!.errors);
	});
});
