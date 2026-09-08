import { strict as assert } from 'assert';
import { forEachChild, PositionedExpression } from './syntax-tree.js';
import { parseCode } from './parser/parser.js';
import { checkTypes } from './checker.js';

/**
 * forEachChild ist die einzige Stelle, die die Kinder eines Knotens kennt. Ein vergessenes Kind
 * fällt sonst nur indirekt auf, etwa als nicht gefundene Definition im language server.
 */

function parse(code: string): PositionedExpression[] {
	const parsed = parseCode(code, 'test.jul');
	checkTypes(parsed, {});
	return parsed.checked!.expressions ?? [];
}

/** Knotentypen in Besuchsreihenfolge, Wurzel zuerst */
function collectTypes(expression: PositionedExpression): string[] {
	const types: string[] = [expression.type];
	forEachChild(expression, child => {
		types.push(...collectTypes(child));
		return undefined;
	});
	return types;
}

function collectAll(code: string): string {
	return parse(code).flatMap(collectTypes).join(' ');
}

const expectedResults: { code: string; types: string; }[] = [
	{
		code: 'a = 1',
		types: 'definition name integer',
	},
	{
		code: 'a: Integer = 1',
		types: 'definition name reference integer',
	},
	{
		code: 'f(1 2)',
		types: 'functionCall reference list integer integer',
	},
	{
		code: '[a = 1]',
		types: 'dictionary singleDictionaryField name integer',
	},
	{
		code: '[a: Integer]',
		types: 'dictionaryType singleDictionaryTypeField name reference',
	},
	{
		code: '[1 2]',
		types: 'list integer integer',
	},
	{
		code: '[]',
		types: 'empty',
	},
	{
		code: '(a: Integer) => a',
		types: 'functionLiteral parameters parameter name reference reference',
	},
	{
		code: '(a b) = [1 2]',
		types: 'destructuring destructuringFields destructuringField name destructuringField name list integer integer',
	},
	{
		code: 'a/b',
		types: 'nestedReference reference name',
	},
];

describe('forEachChild', () => {
	expectedResults.forEach(({ code, types }) => {
		it(code, () => {
			assert.equal(collectAll(code), types);
		});
	});

	it('bricht beim ersten Treffer ab', () => {
		const [expression] = parse('f(1 2)');
		const visited: string[] = [];
		const found = forEachChild(expression!, child => {
			visited.push(child.type);
			return child.type;
		});
		assert.equal(found, 'reference');
		assert.deepEqual(visited, ['reference']);
	});

	it('besucht alle Kinder, wenn der callback undefined liefert', () => {
		const [expression] = parse('f(1 2)');
		const visited: string[] = [];
		const found = forEachChild(expression!, child => {
			visited.push(child.type);
			return undefined;
		});
		assert.equal(found, undefined);
		assert.deepEqual(visited, ['reference', 'list']);
	});
});
