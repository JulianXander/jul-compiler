import { expect } from 'chai';
import { parseTsCode } from './typescript-parser.js';
import { parseCode } from './parser.js';
import { checkTypes, typeToString } from '../checker/checker.js';
import { ParseSingleDefinition } from '../syntax-tree.js';

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
		checkTypes(parsed, {});
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
			{ name: 'array', code: 'export function f(): string[] {}', result: '() :> Or(Empty List(Text))' },
			{ name: 'Array<T>', code: 'export function f(): Array<bigint> {}', result: '() :> Or(Empty List(Integer))' },
			{ name: 'index signature', code: 'export function f(): { [key: string]: any; } | undefined {}', result: '() :> Or(Empty Dictionary(Any))' },
			{ name: 'Record', code: 'export function f(): Record<string, number> {}', result: '() :> Or(Empty Dictionary(Float))' },
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
			{ name: 'verschachtelt nicht übersetzbar', code: 'export function f(): Foo[] {}', result: '() :> Or(Empty List(Any))' },
		];
	describe('Rückgabetyp', () => {
		expectedReturnTypes.forEach(({ name, code, result }) => {
			it(name, () => {
				expect(typeOfF(code)).to.equal(result);
			});
		});
	});

	//#endregion Typannotationen
});
