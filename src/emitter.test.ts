import { expect } from 'chai';
import { parseCode } from './parser/parser.js';
import { getRuntimeImportJs, syntaxTreeToJs } from './emitter.js';

const expectedResults: {
	name?: string;
	code: string;
	result: string;
}[] = [
		{
			code: 'true',
			result: 'export default true'
		},
		{
			code: 'Any',
			result: 'export default Any'
		},
		{
			code: 'String',
			result: 'export default _String'
		},
		{
			code: '# Destructuring import\n§a§',
			// TODO parse comments
			// result: '// Destructuring import\n"a"'
			result: 'export default `a`'
		},
		{
			code: '§12§',
			result: 'export default `12`'
		},
		{
			code: '12',
			result: 'export default 12n'
		},
		{
			code: '[1 2]',
			result: `export default [
	1n,
	2n,
]`
		},
		{
			code: 'someVar = 12',
			result: 'export const someVar = 12n;'
		},
		{
			code: 'log()',
			result: 'export default log()'
		},
		{
			name: 'log-empty',
			code: 'log([])',
			result: `export default log(undefined)`
		},
		{
			code: 'log(1)',
			result: `export default log(1n)`
		},
		{
			name: 'functionCall-unknown-object',
			code: 'log(...[])',
			result: `export default _callFunction(
	log,
	undefined,
	_combineObject(undefined),
)`
		},
		{
			code: '1.log()',
			result: 'export default log(1n)'
		},
		{
			code: '1.log(1)',
			result: `export default log(
	1n,
	1n,
)`
		},
		{
			name: 'function-call-named-args',
			code: 'log(a = 1)',
			result: `export default _callFunction(
	log,
	undefined,
	{'a': 1n},
)`
		},
		{
			name: 'text-argument',
			code: 'log(§hallo welt§)',
			result: 'export default log(`hallo welt`)'
		},
		{
			code: 'someVar/1/test',
			result: 'export default someVar?.[1 - 1]?.[\'test\']'
		},
		{
			name: 'functionLiteral',
			code: '(a b) => log(a)',
			result: `export default _createFunction(
	(a, b) => {
		return log(a)
	},
	{singleNames: [
		{name: 'a'},
		{name: 'b'},
	]},
)`,
		},
		{
			name: 'function-return-type-check',
			code: `() =>
	a: Integer = 1`,
			result: `export default _createFunction(
	() => {
		const a = 1n;
		return a;
	},
	{},
)`,
		},
		{
			name: 'multiline-function-body',
			code: '(a b) =>\n\tlog(a)\n\tlog(b)',
			result: `export default _createFunction(
	(a, b) => {
		log(a)
		return log(b)
	},
	{singleNames: [
		{name: 'a'},
		{name: 'b'},
	]},
)`,
		},
		{
			name: 'branching',
			code: '?(4)\n\t(a) => log(a)\n\t(b) => log(b)',
			result: `export default _branch(
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
)`,
		},
		{
			code: '[a: String]',
			result: `export default {
	[_julTypeSymbol]: 'dictionaryLiteral',
	Fields: {'a': _String},
}`
		},
		{
			code: '[a: String b]',
			result: `export default {
	[_julTypeSymbol]: 'dictionaryLiteral',
	Fields: {
		'a': _String,
		'b': Any,
	},
}`
		},
		{
			code: '[1 ...a ...b]',
			result: `export default [
	1n,
	...a ?? [],
	...b ?? [],
]`
		},
		{
			code: '(testVar) = import(§./some-file.jul§)',
			result: 'export default import {testVar} from \'./some-file.js\';\n'
		},
		{
			name: 'type-function',
			code: 'Any => []',
			result: `export default _createFunction(
	() => {
		return undefined
	},
	{type: Any},
)`,
		},
		{
			name: 'empty-type-function',
			code: 'Empty => []',
			result: `export default _createFunction(
	() => {
		return undefined
	},
	{type: Empty},
)`,
		},
	];

describe('Emitter', () => {
	expectedResults.forEach(({ name, code, result }) => {
		it(name ?? code, () => {
			const parsed = parseCode(code, 'dummy.jul');
			const syntaxTree = parsed.unchecked.expressions!;
			const compiled = syntaxTreeToJs(syntaxTree, '');
			expect(compiled).to.equal(getRuntimeImportJs('') + result);
		});
	});
});