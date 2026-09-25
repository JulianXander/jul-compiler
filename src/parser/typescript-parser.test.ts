import { expect } from 'chai';
import { join, resolve } from 'path';
import { parseTsCode } from './typescript-parser.js';
import { parseCode } from './parser.js';
import { checkTypes, ParsedDocuments, typeToString } from '../checker/checker.js';
import { ErrorCode } from '../compiler-errors.js';
import { createInMemoryHost, loadFile } from '../project-loader.js';
import { ParsedFile, ParseSingleDefinition } from '../syntax-tree.js';
import { reportAtCaller } from '../test-util.js';

describe('TypeScript Parser', () => {
	it('sollte Zeile/Spalte statt rohem Zeichen-Offset für die Position einer Funktionsdeklaration liefern', () => {
		const code = 'export function foo() {\n\treturn 1;\n}\n';
		const result = parseTsCode(code);
		const definition = result.expressions![0] as ParseSingleDefinition;
		expect(definition.name).to.deep.include({
			startRowIndex: 0,
			startColumnIndex: 16,
			endRowIndex: 0,
			endColumnIndex: 19,
		});
	});

	//#region Typannotationen

	/**
	 * Parst und prüft den TS-Code und liefert den Typ der Definition f als Text.
	 * Fehler dürfen keine entstehen: eine nicht übersetzbare Annotation fällt still auf Any zurück.
	 */
	function typeOfF(code: string): string | undefined {
		const parsed = parseCode(code, 'test.ts');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
		const definition = parsed.checked?.expressions?.find((expression): expression is ParseSingleDefinition =>
			expression.type === 'definition' && expression.name.name === 'f');
		const type = definition?.value?.typeInfo?.type;
		return type && typeToString(type, 0, 3);
	}

	const expectTypeOfF = reportAtCaller((code: string, result: string) => {
		expect(typeOfF(code)).to.equal(result);
	});
	describe('Rückgabetyp', () => {
		it('bigint', () => expectTypeOfF('export function f(): bigint { return 1n; }', '() :> Integer'));
		it('number', () => expectTypeOfF('export function f(): number { return 1; }', '() :> Float'));
		it('string', () => expectTypeOfF('export function f(): string { return ""; }', '() :> Text'));
		it('boolean', () => expectTypeOfF('export function f(): boolean { return true; }', '() :> Boolean'));
		it('void', () => expectTypeOfF('export function f(): void {}', '() :> Empty'));
		it('any', () => expectTypeOfF('export function f(): any {}', '() :> Any'));
		it('union mit undefined', () => expectTypeOfF('export function f(): bigint | undefined {}', '() :> Or(Empty Integer)'));
		it('array', () => expectTypeOfF('export function f(): string[] {}', '() :> List(Text)'));
		it('Array<T>', () => expectTypeOfF('export function f(): Array<bigint> {}', '() :> List(Integer)'));
		it('array mit undefined', () => expectTypeOfF('export function f(): string[] | undefined {}', '() :> Or(Empty List(Text))'));
		it('index signature', () => expectTypeOfF('export function f(): { [key: string]: any; } {}', '() :> Dictionary(Any)'));
		it('index signature mit undefined', () => expectTypeOfF('export function f(): { [key: string]: any; } | undefined {}', '() :> Or(Empty Dictionary(Any))'));
		it('Record', () => expectTypeOfF('export function f(): Record<string, number> {}', '() :> Dictionary(Float)'));
		it('Objekt-Typliteral mit optionalem Feld und Error', () => {
			expectTypeOfF('export function f(): { main: string[] | undefined, extra?: bigint } | Error {}', `() :> Or([
  main: Or(Empty List(Text))
  extra: Or(Empty Integer)
] Error)`);
		});
		it('Literaltypen', () => expectTypeOfF('export function f(): \'a\' | 1n | 2 | true {}', '() :> Or(§a§ 1 2f true)'));
		it('Klammertyp', () => expectTypeOfF('export function f(): (bigint) {}', '() :> Integer'));
		it('ArrowFunction', () => expectTypeOfF('export const f = (): bigint => 1n;', '() :> Integer'));
		it('ohne Annotation', () => expectTypeOfF('export function f() { return 1n; }', '() :> Any'));
		it('generisch', () => expectTypeOfF('export function f<T>(): T {}', '() :> Any'));
		it('Promise', () => expectTypeOfF('export function f(): Promise<number> {}', '() :> Any'));
		it('Funktionstyp', () => expectTypeOfF('export function f(): () => void {}', '() :> Any'));
		it('Union mit nicht übersetzbarem Glied', () => expectTypeOfF('export function f(): bigint | Foo {}', '() :> Any'));
		it('verschachtelt nicht übersetzbar', () => expectTypeOfF('export function f(): Foo[] {}', '() :> List(Any)'));
	});

	describe('Parametertyp', () => {
		it('einfacher Parameter', () => expectTypeOfF('export function f(a: bigint) {}', '(a: Integer) :> Any'));
		it('optionaler Parameter', () => {
			expectTypeOfF('export function f(a: bigint, b?: string) {}', '(\n  a: Integer\n  b: Or(Empty Text)\n) :> Any');
		});
		it('optionaler Parameter mit Union', () => expectTypeOfF('export function f(a?: bigint | string) {}', '(a: Or(Empty Integer Text)) :> Any'));
		it('Default mit Annotation', () => expectTypeOfF('export function f(a: bigint = 1n) {}', '(a: Or(Empty Integer)) :> Any'));
		it('Default ohne Annotation', () => expectTypeOfF('export function f(a = 1n) {}', '(a: Any) :> Any'));
		it('ohne Annotation', () => expectTypeOfF('export function f(a) {}', '(a: Any) :> Any'));
		it('Callback bleibt ungetypt', () => expectTypeOfF('export function f(cb: (x: any) => boolean) {}', '(cb: Any) :> Any'));
		it('optionaler Callback bleibt ungetypt', () => expectTypeOfF('export function f(cb?: () => void) {}', '(cb: Any) :> Any'));
		// Ein Aufruf ohne Rest-Argumente kommt in JUL als Empty an, und TS kann das am
		// Rest-Parameter nicht mit | undefined annotieren - deshalb hier Empty zusätzlich.
		it('Rest-Parameter', () => expectTypeOfF('export function f(...args: bigint[]) {}', '(...args: Or(Empty List(Integer))) :> Any'));
		it('Rest-Parameter nach Einzelparameter', () => {
			expectTypeOfF('export function f(a: string, ...args: bigint[]) {}', '(\n  a: Text\n  ...args: Or(Empty List(Integer))\n) :> Any');
		});
		it('Rest-Parameter ohne Annotation', () => expectTypeOfF('export function f(...args) {}', '(...args: Any) :> Any'));
		// this ist in TS eine reine Typangabe, kein Argument
		it('this-Parameter entfällt', () => expectTypeOfF('export function f(this: Window, a: bigint) {}', '(a: Integer) :> Any'));
		it('ArrowFunction', () => expectTypeOfF('export const f = (a: bigint): bigint => a;', '(a: Integer) :> Integer'));
	});

	it('JUL-Aufruf mit falschem Argumenttyp wird gemeldet', () => {
		const folder = resolve('/typescript-parser-test');
		const mainPath = join(folder, 'main.jul');
		const documents: ParsedDocuments = {};
		const main = loadFile(mainPath, documents, createInMemoryHost({
			[mainPath]: '(double) = import(§./util.ts§)\nwrong = double(§x§)',
			[join(folder, 'util.ts')]: 'export function double(a: bigint): bigint { return a * 2n; }',
		}, { cloneUnchecked: false }));
		expect(typeof main).to.not.equal('string');
		expect((main as ParsedFile).checked?.errors.map(error => error.code)).to.deep.equal([ErrorCode.argumentTypeMismatch]);
	});

	//#endregion Typannotationen
});
