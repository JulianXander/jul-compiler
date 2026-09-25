import { expect } from 'chai';
import { parseCode } from './parser/parser.js';
import { getRuntimeImportJs, syntaxTreeToJs } from './emitter.js';
import { reportAtCaller } from './test-util.js';

const expectEmit = reportAtCaller((code: string, result: string) => {
	const parsed = parseCode(code, 'dummy.jul');
	const syntaxTree = parsed.unchecked.expressions!;
	const compiled = syntaxTreeToJs(syntaxTree, '');
	expect(compiled).to.equal(getRuntimeImportJs('') + result);
});

describe('Emitter', () => {
	it('true', () => {
		expectEmit('true', 'export default true');
	});
	it('Any', () => {
		expectEmit('Any', 'export default Any');
	});
	it('String', () => {
		expectEmit('String', 'export default _String');
	});
	// TODO parse comments
	// result: '// Destructuring import\n"a"'
	it('# Destructuring import\n§a§', () => {
		expectEmit('# Destructuring import\n§a§', 'export default `a`');
	});
	it('§12§', () => {
		expectEmit('§12§', 'export default `12`');
	});
	it('12', () => {
		expectEmit('12', 'export default 12n');
	});
	it('[1 2]', () => {
		expectEmit('[1 2]', `export default [
	1n,
	2n,
]`);
	});
	it('someVar = 12', () => {
		expectEmit('someVar = 12', 'export const someVar = 12n;');
	});
	it('log()', () => {
		expectEmit('log()', 'export default log()');
	});
	it('log-empty', () => {
		expectEmit('log([])', `export default log(undefined)`);
	});
	it('log(1)', () => {
		expectEmit('log(1)', `export default log(1n)`);
	});
	it('functionCall-unknown-object', () => {
		expectEmit('log(...[])', `export default _callFunction(
	log,
	undefined,
	_combineObject(undefined),
)`);
	});
	it('1.log()', () => {
		expectEmit('1.log()', 'export default log(1n)');
	});
	it('1.log(1)', () => {
		expectEmit('1.log(1)', `export default log(
	1n,
	1n,
)`);
	});
	it('function-call-named-args', () => {
		expectEmit('log(a = 1)', `export default _callFunction(
	log,
	undefined,
	{'a': 1n},
)`);
	});
	it('text-argument', () => {
		expectEmit('log(§hallo welt§)', 'export default log(`hallo welt`)');
	});
	it('someVar/1/test', () => {
		expectEmit('someVar/1/test', 'export default someVar?.[1 - 1]?.[\'test\']');
	});
	it('functionLiteral', () => {
		expectEmit('(a b) => log(a)', `export default _createFunction(
	(a, b) => {
		return log(a)
	},
	{singleNames: [
		{name: 'a'},
		{name: 'b'},
	]},
)`);
	});
	it('function-return-type-check', () => {
		expectEmit(`() =>
	a: Integer = 1`, `export default _createFunction(
	() => {
		const a = 1n;
		return a;
	},
	{},
)`);
	});
	it('multiline-function-body', () => {
		expectEmit('(a b) =>\n\tlog(a)\n\tlog(b)', `export default _createFunction(
	(a, b) => {
		log(a)
		return log(b)
	},
	{singleNames: [
		{name: 'a'},
		{name: 'b'},
	]},
)`);
	});
	it('branching', () => {
		expectEmit('?(4)\n\t(a) => log(a)\n\t(b) => log(b)', `export default _branch(
	[4n],
	_createFunction(
		(a) => {
			return log(a)
		},
		{singleNames: [{name: 'a'}]},
	),
	_createFunction(
		(b) => {
			return log(b)
		},
		{singleNames: [{name: 'b'}]},
	),
)`);
	});
	it('[a: String]', () => {
		expectEmit('[a: String]', `export default {
	[_julTypeSymbol]: 'dictionaryLiteral',
	Fields: {'a': _String},
}`);
	});
	it('[a: String b]', () => {
		expectEmit('[a: String b]', `export default {
	[_julTypeSymbol]: 'dictionaryLiteral',
	Fields: {
		'a': _String,
		'b': Any,
	},
}`);
	});
	// Der gespreadete Typ ist selbst ein Typobjekt, übernommen werden seine Fields.
	it('dictionary-type-spread', () => {
		expectEmit('[...a b: String]', `export default {
	[_julTypeSymbol]: 'dictionaryLiteral',
	Fields: {
		...a.Fields,
		'b': _String,
	},
}`);
	});
	it('[1 ...a ...b]', () => {
		expectEmit('[1 ...a ...b]', `export default [
	1n,
	...a ?? [],
	...b ?? [],
]`);
	});
	it('(testVar) = import(§./some-file.jul§)', () => {
		expectEmit('(testVar) = import(§./some-file.jul§)', 'export default import {testVar} from \'./some-file.js\';\n');
	});
	it('type-function', () => {
		expectEmit('Any => []', `export default _createFunction(
	() => {
		return undefined
	},
	{type: Any},
)`);
	});
	it('empty-type-function', () => {
		expectEmit('Empty => []', `export default _createFunction(
	() => {
		return undefined
	},
	{type: Empty},
)`);
	});
});