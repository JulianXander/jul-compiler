import { expect } from 'chai';
import { join, resolve } from 'path';
import { parseTsCode } from './typescript-parser.js';
import { parseCode } from './parser.js';
import { checkTypes, ParsedDocuments, typeToString } from '../checker/checker.js';
import { ErrorCode } from '../compiler-errors.js';
import { createInMemoryHost, loadFile } from '../project-loader.js';
import { ParsedFile, ParseSingleDefinition } from '../syntax-tree.js';

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

	const expectedReturnTypes: {
		name: string;
		code: string;
		result: string;
	}[] = [
			{ name: 'bigint', code: 'export function f(): bigint { return 1n; }', result: '() :> Integer' },
			{ name: 'number', code: 'export function f(): number { return 1; }', result: '() :> Float' },
			{ name: 'string', code: 'export function f(): string { return ""; }', result: '() :> Text' },
			{ name: 'boolean', code: 'export function f(): boolean { return true; }', result: '() :> Boolean' },
			{ name: 'void', code: 'export function f(): void {}', result: '() :> Empty' },
			{ name: 'any', code: 'export function f(): any {}', result: '() :> Any' },
			{ name: 'union mit undefined', code: 'export function f(): bigint | undefined {}', result: '() :> Or(Empty Integer)' },
			{ name: 'array', code: 'export function f(): string[] {}', result: '() :> List(Text)' },
			{ name: 'Array<T>', code: 'export function f(): Array<bigint> {}', result: '() :> List(Integer)' },
			{ name: 'array mit undefined', code: 'export function f(): string[] | undefined {}', result: '() :> Or(Empty List(Text))' },
			{ name: 'index signature', code: 'export function f(): { [key: string]: any; } {}', result: '() :> Dictionary(Any)' },
			{ name: 'index signature mit undefined', code: 'export function f(): { [key: string]: any; } | undefined {}', result: '() :> Or(Empty Dictionary(Any))' },
			{ name: 'Record', code: 'export function f(): Record<string, number> {}', result: '() :> Dictionary(Float)' },
			{
				name: 'Objekt-Typliteral mit optionalem Feld und Error',
				code: 'export function f(): { main: string[] | undefined, extra?: bigint } | Error {}',
				result: `() :> Or([
  main: Or(Empty List(Text))
  extra: Or(Empty Integer)
] Error)`,
			},
			{ name: 'Literaltypen', code: 'export function f(): \'a\' | 1n | 2 | true {}', result: '() :> Or(§a§ 1 2f true)' },
			{ name: 'Klammertyp', code: 'export function f(): (bigint) {}', result: '() :> Integer' },
			{ name: 'ArrowFunction', code: 'export const f = (): bigint => 1n;', result: '() :> Integer' },
			{ name: 'ohne Annotation', code: 'export function f() { return 1n; }', result: '() :> Any' },
			{ name: 'generisch', code: 'export function f<T>(): T {}', result: '() :> Any' },
			{ name: 'Promise', code: 'export function f(): Promise<number> {}', result: '() :> Any' },
			{ name: 'Funktionstyp', code: 'export function f(): () => void {}', result: '() :> Any' },
			{ name: 'Union mit nicht übersetzbarem Glied', code: 'export function f(): bigint | Foo {}', result: '() :> Any' },
			{ name: 'verschachtelt nicht übersetzbar', code: 'export function f(): Foo[] {}', result: '() :> List(Any)' },
		];
	describe('Rückgabetyp', () => {
		expectedReturnTypes.forEach(({ name, code, result }) => {
			it(name, () => {
				expect(typeOfF(code)).to.equal(result);
			});
		});
	});

	const expectedParameterTypes: {
		name: string;
		code: string;
		result: string;
	}[] = [
			{ name: 'einfacher Parameter', code: 'export function f(a: bigint) {}', result: '(a: Integer) :> Any' },
			{
				name: 'optionaler Parameter',
				code: 'export function f(a: bigint, b?: string) {}',
				result: '(\n  a: Integer\n  b: Or(Empty Text)\n) :> Any',
			},
			{ name: 'optionaler Parameter mit Union', code: 'export function f(a?: bigint | string) {}', result: '(a: Or(Empty Integer Text)) :> Any' },
			{ name: 'Default mit Annotation', code: 'export function f(a: bigint = 1n) {}', result: '(a: Or(Empty Integer)) :> Any' },
			{ name: 'Default ohne Annotation', code: 'export function f(a = 1n) {}', result: '(a: Any) :> Any' },
			{ name: 'ohne Annotation', code: 'export function f(a) {}', result: '(a: Any) :> Any' },
			{ name: 'Callback bleibt ungetypt', code: 'export function f(cb: (x: any) => boolean) {}', result: '(cb: Any) :> Any' },
			{ name: 'optionaler Callback bleibt ungetypt', code: 'export function f(cb?: () => void) {}', result: '(cb: Any) :> Any' },
			// Ein Aufruf ohne Rest-Argumente kommt in JUL als Empty an, und TS kann das am
			// Rest-Parameter nicht mit | undefined annotieren - deshalb hier Empty zusätzlich.
			{ name: 'Rest-Parameter', code: 'export function f(...args: bigint[]) {}', result: '(...args: Or(Empty List(Integer))) :> Any' },
			{
				name: 'Rest-Parameter nach Einzelparameter',
				code: 'export function f(a: string, ...args: bigint[]) {}',
				result: '(\n  a: Text\n  ...args: Or(Empty List(Integer))\n) :> Any',
			},
			{ name: 'Rest-Parameter ohne Annotation', code: 'export function f(...args) {}', result: '(...args: Any) :> Any' },
			// this ist in TS eine reine Typangabe, kein Argument
			{ name: 'this-Parameter entfällt', code: 'export function f(this: Window, a: bigint) {}', result: '(a: Integer) :> Any' },
			{ name: 'ArrowFunction', code: 'export const f = (a: bigint): bigint => a;', result: '(a: Integer) :> Integer' },
		];
	describe('Parametertyp', () => {
		expectedParameterTypes.forEach(({ name, code, result }) => {
			it(name, () => {
				expect(typeOfF(code)).to.equal(result);
			});
		});
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
