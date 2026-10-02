import { expect } from 'chai';
import { shakeRuntime } from './runtime-shaking.js';
import { reportAtCaller } from '../test-util.js';

/**
 * Vergleicht zeilenweise ohne Leerzeilen am Rand. Dass die Zeilennummern gleich bleiben, prüft ein
 * eigener Fall.
 */
const expectShake = reportAtCaller((runtimeJs: string, usedNames: string[], expected: string) => {
	const shaken = shakeRuntime(runtimeJs, usedNames);
	const nonEmptyLines = shaken.split('\n').filter(line => line.trim());
	expect(nonEmptyLines).to.deep.equal(expected.split('\n').filter(line => line.trim()));
});

describe('shakeRuntime', () => {
	it('entfernt eine unbenutzte Definition', () => {
		expectShake('export const a = 1;\nexport const b = 2;', ['a'], 'export const a = 1;');
	});
	it('behält, was eine benutzte Definition referenziert', () => {
		expectShake(
			'const helper = 1;\nexport const a = () => helper;\nexport const b = 2;',
			['a'],
			'const helper = 1;\nexport const a = () => helper;');
	});
	it('folgt Referenzen transitiv', () => {
		expectShake(
			'const c = 1;\nconst b = () => c;\nexport const a = () => b();\nconst d = 4;',
			['a'],
			'const c = 1;\nconst b = () => c;\nexport const a = () => b();');
	});
	it('function-Deklaration, die vor ihrer Definition referenziert wird', () => {
		expectShake(
			'export const a = () => helper();\nfunction helper() { return 1; }\nfunction unused() {}',
			['a'],
			'export const a = () => helper();\nfunction helper() { return 1; }');
	});
	it('Klasse', () => {
		expectShake(
			'class Stream {}\nexport const a = () => new Stream();\nclass Unused {}',
			['a'],
			'class Stream {}\nexport const a = () => new Stream();');
	});
	it('Feldzugriff hält die gleichnamige Definition nicht', () => {
		expectShake(
			'export const map = 1;\nexport const a = (values) => values.map(x => x);',
			['a'],
			'export const a = (values) => values.map(x => x);');
	});
	it('Schlüssel im Objektliteral hält die gleichnamige Definition nicht', () => {
		expectShake(
			'const type = 1;\nexport const a = { type: 2 };',
			['a'],
			'export const a = { type: 2 };');
	});
	it('Kurzschreibweise im Objektliteral ist eine Referenz', () => {
		expectShake(
			'const type = 1;\nexport const a = { type };',
			['a'],
			'const type = 1;\nexport const a = { type };');
	});
	it('berechneter Schlüssel ist eine Referenz', () => {
		expectShake(
			'const symbol = Symbol.for("x");\nexport const a = { [symbol]: 1 };',
			['a'],
			'const symbol = Symbol.for("x");\nexport const a = { [symbol]: 1 };');
	});
	it('umbenannter Export hält die ursprüngliche Definition', () => {
		expectShake(
			'function typeToString() {}\nexport { typeToString as _typeToString };',
			['_typeToString'],
			'function typeToString() {}\nexport { typeToString as _typeToString };');
	});
	it('unbenutzter umbenannter Export entfällt samt Definition', () => {
		expectShake(
			'function typeToString() {}\nexport { typeToString as _typeToString };\nexport const a = 1;',
			['a'],
			'export const a = 1;');
	});
	it('ohne benutzte Namen bleibt nichts', () => {
		expectShake('export const a = 1;\nfunction b() {}', [], '');
	});
	it('Zeilennummern bleiben gleich', () => {
		const runtimeJs = 'export const a = {\n\tb: 1,\n};\nexport const c = 2;';
		const shaken = shakeRuntime(runtimeJs, ['c']);
		expect(shaken.split('\n')).to.have.length(runtimeJs.split('\n').length);
		expect(shaken.split('\n')[3]).to.equal('export const c = 2;');
	});
	it('Kommentare zwischen den Definitionen bleiben stehen', () => {
		expectShake('// Kommentar\nexport const a = 1;', [], '// Kommentar');
	});
});
