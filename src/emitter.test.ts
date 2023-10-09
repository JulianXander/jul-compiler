import { expect } from 'chai';
import { parseCode } from './parser/parser.js';
import { getRuntimeImportJs, syntaxTreeToJs } from './emitter.js';
import { Extension } from './util.js';

const expectedResults: {
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
		// {
		// 	code: 'log(§hallo welt§)',
		// 	result: null
		// },
		{
			code: '(a b) => log(a)',
			result: `export default _createFunction((a, b) => {return _callFunction(log, undefined, [
a,
])}, {
singleNames: [
{
name: 'a'},
{
name: 'b'}
],
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
		// 					fallback: undefined,
		// 					source: undefined,
		// 					typeGuard: undefined,
		// 				},
		// 				{
		// 					type: 'name',
		// 					name: 'b',
		// 					fallback: undefined,
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
		// 	code: 'test = 4\ntest ?\n\t(a) => log(a)\n\t(b) => log(b)',
		// 	result: null
		// },
		// {
		// 	code: 'test = 4\ntest ?\n\t(a:String) => log(a)\n\t(b) => log(b)',
		// 	result: null
		// },
		// {
		// 	code: 'fibonacci = (number:NonNegativeInteger) =>\n\tnumber ?\n\t\t(n:0) => 0\n\t\t(n:1) => 1\n\t\t(n) => sum(fibonacci(subtract(n 2)) fibonacci(subtract(n 1)))\nfibonacci(12)',
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
			result: 'export default [\n1n,\n...a,\n...b,\n]'
		},
		{
			code: '(testVar) = import(§./some-file.jul§)',
			result: 'export default import {testVar} from \'./some-file.js\';\n'
		},
	];

describe('Emitter', () => {
	expectedResults.forEach(({ code, result }) => {
		it(code, () => {
			const parsed = parseCode(code, Extension.jul);
			const syntaxTree = parsed.expressions!;
			const compiled = syntaxTreeToJs(syntaxTree, '');
			expect(compiled).to.equal(getRuntimeImportJs('') + result);
		});
	});
});