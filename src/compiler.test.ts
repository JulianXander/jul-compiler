import { expect } from 'chai';
import { parseCode } from './parser';
import { astToJs, importLine } from './emitter'

const expectedResults: {
	code: string;
	result: string;
}[] = [
		{
			code: '# Destructuring import\n§a§',
			// TODO parse comments
			// result: '// Destructuring import\n"a"'
			result: '"a"'
		},
		{
			code: '§12§',
			result: '"12"'
		},
		{
			code: '12',
			result: '12'
		},
		{
			code: '(1 2)',
			result: '[\n1,\n2,\n]'
		},
		// {
		// 	code: '(\n\t1\n\t2\n)\n',
		// 	result: [1, 2]
		// },
		{
			code: 'someVar = 12',
			result: 'const someVar = 12;'
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
		// {
		// 	code: '(a b) => log(a)',
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
		// 		]
		// 	},
		// },
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
	]

describe('Compiler', () => {
	expectedResults.forEach(({ code, result }) => {
		it(code, () => {
			const parsed = parseCode(code);
			const compiled = astToJs(parsed.parsed!);
			expect(compiled).to.equal(importLine + result);
		});
	});
});