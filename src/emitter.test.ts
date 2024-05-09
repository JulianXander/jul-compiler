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
			code: '(1 2)',
			result: 'export default [\n1n,\n2n,\n]'
		},
		// {
		// 	code: '(\n\t1\n\t2\n)\n',
		// 	result: [1, 2]
		// },
		{
			code: 'someVar = 12',
			result: 'export const someVar = 12n;'
		},
		// {
		// 	code: 'someVar = (1 2)',
		// 	result: [1, 2]
		// },
		// {
		// 	code: 'someVar = (1 2)\ntest = 4',
		// 	result: 4
		// },
		{
			code: 'log()',
			result: 'export default _callFunction(log, undefined, null)'
		},
		{
			code: 'log(())',
			result: 'export default _callFunction(log, undefined, [\nnull,\n])'
		},
		{
			code: 'log(1)',
			result: 'export default _callFunction(log, undefined, [\n1n,\n])'
		},
		// {
		// 	code: 'log(§hallo welt§)',
		// 	result: null
		// },
		{
			code: 'someVar/1/test',
			result: 'export default ((someVar?.[1 - 1] ?? null)?.[\'test\'] ?? null)'
		},
		{
			code: '(a b) => log(a)',
			result: `export default _createFunction((a, b) => {
return _callFunction(log, undefined, [
a,
])
}, {
singleNames: [
{
name: 'a'},
{
name: 'b'}
],
})`,
		},
		{
			name: 'function-return-type-check',
			code: `() =>
	a: Integer = 1`,
			result: `export default _createFunction(() => {
const a = _checkType(Integer, 1n);
return a;
}, {
})`,
		},
		// {
		// 	code: '(a b) =>\n\tlog(a)\n\tlog(b)',
		// 	result: {
		// 		type: 'functionLiteral',
		// 		pure: true,
		// 		params: {
		// 			singleNames: [
		// 				{
		// 					type: 'name',
		// 					name: 'a',
		// 					source: undefined,
		// 					typeGuard: undefined,
		// 				},
		// 				{
		// 					type: 'name',
		// 					name: 'b',
		// 					source: undefined,
		// 					typeGuard: undefined,
		// 				}
		// 			],
		// 			rest: undefined
		// 		},
		// 		body: [
		// 			{
		// 				type: 'functionCall',
		// 				functionReference: ['log'],
		// 				params: {
		// 					type: 'list',
		// 					values: [{
		// 						type: 'reference',
		// 						names: ['a']
		// 					}],
		// 				},
		// 			},
		// 			{
		// 				type: 'functionCall',
		// 				functionReference: ['log'],
		// 				params: {
		// 					type: 'list',
		// 					values: [{
		// 						type: 'reference',
		// 						names: ['b']
		// 					}],
		// 				},
		// 			},
		// 		]
		// 	},
		// },
		// {
		// 	code: '4 ?\n\t(a) => log(a)\n\t(b) => log(b)',
		// 	result: 'null'
		// },
		// {
		// 	code: 'test = 4\ntest ?\n\t(a:String) => log(a)\n\t(b) => log(b)',
		// 	result: null
		// },
		// {
		// 	code: 'fibonacci = (number:NonNegativeInteger) =>\n\tnumber ?\n\t\t(n:0) => 0\n\t\t(n:1) => 1\n\t\t(n) => add(fibonacci(subtract(n 2)) fibonacci(subtract(n 1)))\nfibonacci(12)',
		// 	result: 144
		// },
		{
			code: '(a: String)',
			result: 'export default new DictionaryLiteralType({\n\'a\': _String,\n})'
		},
		{
			code: '(a: String b)',
			result: 'export default new DictionaryLiteralType({\n\'a\': _String,\n\'b\': Any,\n})'
		},
		{
			code: '(1 ...a ...b)',
			result: 'export default [\n1n,\n...a ?? [],\n...b ?? [],\n]'
		},
		{
			code: '(testVar) = import(§./some-file.jul§)',
			result: 'export default import {testVar} from \'./some-file.js\';\n'
		},
		{
			name: 'type-function',
			code: 'Any => ()',
			result: `export default _createFunction(() => {
return null
}, {type:Any})`,
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