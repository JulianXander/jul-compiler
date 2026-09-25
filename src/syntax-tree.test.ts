import { strict as assert } from 'assert';
import { forEachChild, PositionedExpression } from './syntax-tree.js';
import { parseCode } from './parser/parser.js';
import { checkTypes } from './checker/checker.js';
import { reportAtCaller } from './test-util.js';

/**
 * forEachChild ist die einzige Stelle, die die Kinder eines Knotens kennt. Ein vergessenes Kind
 * fällt sonst nur indirekt auf, etwa als nicht gefundene Definition im language server.
 */

function parse(code: string): PositionedExpression[] {
	const parsed = parseCode(code, 'test.jul');
	checkTypes(parsed, {}, { cloneUnchecked: false });
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

const expectTypes = reportAtCaller((code: string, types: string) => {
	assert.equal(collectAll(code), types);
});

describe('forEachChild', () => {
	it('a = 1', () => {
		expectTypes('a = 1', 'definition name integer');
	});
	it('a: Integer = 1', () => {
		expectTypes('a: Integer = 1', 'definition name reference integer');
	});
	it('f(1 2)', () => {
		expectTypes('f(1 2)', 'functionCall reference list integer integer');
	});
	it('[a = 1]', () => {
		expectTypes('[a = 1]', 'dictionary singleDictionaryField name integer');
	});
	it('[a: Integer]', () => {
		expectTypes('[a: Integer]', 'dictionaryType singleDictionaryTypeField name reference');
	});
	it('[1 2]', () => {
		expectTypes('[1 2]', 'list integer integer');
	});
	it('[]', () => {
		expectTypes('[]', 'empty');
	});
	it('(a: Integer) => a', () => {
		expectTypes('(a: Integer) => a', 'functionLiteral parameters parameter name reference reference');
	});
	it('(a b) = [1 2]', () => {
		expectTypes('(a b) = [1 2]', 'destructuring destructuringFields destructuringField name destructuringField name list integer integer');
	});
	it('a/b', () => {
		expectTypes('a/b', 'nestedReference reference name');
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
