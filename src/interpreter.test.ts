import { expect } from 'chai';

import { parseCode } from './parser';
// import { interpreteAst } from './interpreter';

const expectedResults: {
	code: string;
	result: any;
}[] = [
		// {
		// 	code: '# Destructuring import\n§a§',
		// 	result: 'a'
		// },
		// {
		// 	code: '§12§',
		// 	result: '12'
		// },
		// {
		// 	code: '12',
		// 	result: 12
		// },
		// {
		// 	code: '(1 2)',
		// 	result: [1, 2]
		// },
		// {
		// 	code: '(\n\t1\n\t2\n)\n',
		// 	result: [1, 2]
		// },
		// {
		// 	code: 'someVar = 12',
		// 	result: 12
		// },
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
		{
			code: 'test = 4\ntest ?\n\t(a) => log(a)\n\t(b) => log(b)',
			result: null
		},
		{
			code: 'test = 4\ntest ?\n\t(a:String) => log(a)\n\t(b) => log(b)',
			result: null
		},
		{
			code: 'fibonacci = (countdown current previous) =>\n\t(countdown) ?\n\t\t(x:0) => previous\n\t\t(x) => fibonacci(subtract(countdown 1) sum(current previous) current)\nfibonacci(12 1 0)',
			result: 144
		},
	];;

// describe('Interpreter', () => {
// 	expectedResults.forEach(({ code, result }) => {
// 		it(code, () => {
// 			const parsed = parseCode(code)
// 			const interpreted = interpreteAst(parsed.parsed!);
// 			expect(interpreted.value).to.deep.equal(result);
// 		});
// 	});
// });