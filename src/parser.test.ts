import { expect } from 'chai';
import { Expression } from './abstract-syntax-tree';

import { parseCode } from './parser';

const expectedResults: {
	code: string;
	result: Expression[];
}[] = [
		// {
		// 	code: '# Destructuring import\n§a§',
		// 	result: [{
		// 		type: 'string',
		// 		values: [{ type: 'stringToken', value: 'a' }]
		// 	}]
		// },
		// {
		// 	code: '§12§',
		// 	result: [{
		// 		type: 'string',
		// 		values: [{ type: 'stringToken', value: '12' }]
		// 	}]
		// },
		// {
		// 	code: '12',
		// 	result: [{ type: 'number', value: 12 }]
		// },
		// {
		// 	code: '(1 2)',
		// 	result: [{
		// 		type: 'list',
		// 		values: [
		// 			{ type: 'number', value: 1 },
		// 			{ type: 'number', value: 2 }
		// 		]
		// 	}]
		// },
		// {
		// 	code: '(\n\t1\n\t2\n)\n',
		// 	result: [{
		// 		type: 'list',
		// 		values: [
		// 			{ type: 'number', value: 1 },
		// 			{ type: 'number', value: 2 }
		// 		]
		// 	}]
		// },
		// {
		// 	code: 'someVar = 12',
		// 	result: [{
		// 		type: 'definition',
		// 		name: 'someVar',
		// 		value: { type: 'number', value: 12 },
		// 		typeGuard: undefined
		// 	}]
		// },
		// {
		// 	code: 'someVar = (1 2)',
		// 	result: [{
		// 		type: 'definition',
		// 		name: 'someVar',
		// 		value: {
		// 			type: 'list',
		// 			values: [
		// 				{ type: 'number', value: 1 },
		// 				{ type: 'number', value: 2 }
		// 			]
		// 		},
		// 		typeGuard: undefined
		// 	}]
		// },
		// {
		// 	code: 'someVar = (1 2)\ntest = 4',
		// 	result: [
		// 		{
		// 			type: 'definition',
		// 			name: 'someVar',
		// 			value: {
		// 				type: 'list',
		// 				values: [
		// 					{ type: 'number', value: 1 },
		// 					{ type: 'number', value: 2 }
		// 				]
		// 			},
		// 			typeGuard: undefined
		// 		},
		// 		{
		// 			type: 'definition',
		// 			name: 'test',
		// 			value: { type: 'number', value: 4 },
		// 			typeGuard: undefined
		// 		},
		// 	]
		// },
		// {
		// 	code: 'log(§hallo welt§)',
		// 	result: [
		// 		{
		// 			type: 'functionCall',
		// 			functionReference: ['log'],
		// 			params: {
		// 				type: 'list',
		// 				values: [{
		// 					type: 'string',
		// 					values: [{
		// 						type: 'stringToken',
		// 						value: 'hallo welt'
		// 					}]
		// 				}]
		// 			},
		// 		},
		// 	]
		// },
		// {
		// 	code: '(a b) => log(a)',
		// 	result: [
		// 		{
		// 			type: 'functionLiteral',
		// 			pure: true,
		// 			params: {
		// 				singleNames: [
		// 					{
		// 						type: 'name',
		// 						name: 'a',
		// 						fallback: undefined,
		// 						source: undefined,
		// 						typeGuard: undefined,
		// 					},
		// 					{
		// 						type: 'name',
		// 						name: 'b',
		// 						fallback: undefined,
		// 						source: undefined,
		// 						typeGuard: undefined,
		// 					}
		// 				],
		// 				rest: undefined
		// 			},
		// 			body: [
		// 				{
		// 					type: 'functionCall',
		// 					functionReference: ['log'],
		// 					params: {
		// 						type: 'list',
		// 						values: [{
		// 							type: 'reference',
		// 							names: ['a']
		// 						}],
		// 					},
		// 				},
		// 			]
		// 		},
		// 	]
		// },
		// {
		// 	code: '(a b) =>\n\tlog(a)\n\tlog(b)',
		// 	result: [
		// 		{
		// 			type: 'functionLiteral',
		// 			pure: true,
		// 			params: {
		// 				singleNames: [
		// 					{
		// 						type: 'name',
		// 						name: 'a',
		// 						fallback: undefined,
		// 						source: undefined,
		// 						typeGuard: undefined,
		// 					},
		// 					{
		// 						type: 'name',
		// 						name: 'b',
		// 						fallback: undefined,
		// 						source: undefined,
		// 						typeGuard: undefined,
		// 					}
		// 				],
		// 				rest: undefined
		// 			},
		// 			body: [
		// 				{
		// 					type: 'functionCall',
		// 					functionReference: ['log'],
		// 					params: {
		// 						type: 'list',
		// 						values: [{
		// 							type: 'reference',
		// 							names: ['a']
		// 						}],
		// 					},
		// 				},
		// 				{
		// 					type: 'functionCall',
		// 					functionReference: ['log'],
		// 					params: {
		// 						type: 'list',
		// 						values: [{
		// 							type: 'reference',
		// 							names: ['b']
		// 						}],
		// 					},
		// 				},
		// 			]
		// 		},
		// 	]
		// },
		// {
		// 	code: 'test = 4\ntest ?\n\t(a) => log(a)\n\t(b) => log(b)',
		// 	result: [
		// 		{
		// 			type: 'definition',
		// 			name: 'test',
		// 			value: { type: 'number', value: 4 },
		// 			typeGuard: undefined
		// 		},
		// 		{
		// 			type: 'branching',
		// 			value: {
		// 				type: 'reference',
		// 				names: ['test']
		// 			},
		// 			branches: [
		// 				{
		// 					type: 'functionLiteral',
		// 					pure: true,
		// 					params: {
		// 						singleNames: [
		// 							{
		// 								type: 'name',
		// 								name: 'a',
		// 								fallback: undefined,
		// 								source: undefined,
		// 								typeGuard: undefined,
		// 							},
		// 						],
		// 						rest: undefined
		// 					},
		// 					body: [
		// 						{
		// 							type: 'functionCall',
		// 							functionReference: ['log'],
		// 							params: {
		// 								type: 'list',
		// 								values: [{
		// 									type: 'reference',
		// 									names: ['a']
		// 								}],
		// 							},
		// 						},
		// 					]
		// 				},
		// 				{
		// 					type: 'functionLiteral',
		// 					pure: true,
		// 					params: {
		// 						singleNames: [
		// 							{
		// 								type: 'name',
		// 								name: 'b',
		// 								fallback: undefined,
		// 								source: undefined,
		// 								typeGuard: undefined,
		// 							}
		// 						],
		// 						rest: undefined
		// 					},
		// 					body: [
		// 						{
		// 							type: 'functionCall',
		// 							functionReference: ['log'],
		// 							params: {
		// 								type: 'list',
		// 								values: [{
		// 									type: 'reference',
		// 									names: ['b']
		// 								}],
		// 							},
		// 						},
		// 					]
		// 				},
		// 			]
		// 		},
		// 	]
		// },
		// {
		// 	code: '(a b) ?\n\t(a) => log(a)\n\t(b) => log(b)',
		// 	result: [
		// 		{
		// 			type: 'branching',
		// 			value: {
		// 				type: 'list',
		// 				values: [
		// 					{
		// 						type: 'reference',
		// 						names: ['a']
		// 					},
		// 					{
		// 						type: 'reference',
		// 						names: ['b']
		// 					}
		// 				]
		// 			},
		// 			branches: [
		// 				{
		// 					type: 'functionLiteral',
		// 					pure: true,
		// 					params: {
		// 						singleNames: [
		// 							{
		// 								type: 'name',
		// 								name: 'a',
		// 								fallback: undefined,
		// 								source: undefined,
		// 								typeGuard: undefined,
		// 							},
		// 						],
		// 						rest: undefined
		// 					},
		// 					body: [
		// 						{
		// 							type: 'functionCall',
		// 							functionReference: ['log'],
		// 							params: {
		// 								type: 'list',
		// 								values: [{
		// 									type: 'reference',
		// 									names: ['a']
		// 								}],
		// 							},
		// 						},
		// 					]
		// 				},
		// 				{
		// 					type: 'functionLiteral',
		// 					pure: true,
		// 					params: {
		// 						singleNames: [
		// 							{
		// 								type: 'name',
		// 								name: 'b',
		// 								fallback: undefined,
		// 								source: undefined,
		// 								typeGuard: undefined,
		// 							}
		// 						],
		// 						rest: undefined
		// 					},
		// 					body: [
		// 						{
		// 							type: 'functionCall',
		// 							functionReference: ['log'],
		// 							params: {
		// 								type: 'list',
		// 								values: [{
		// 									type: 'reference',
		// 									names: ['b']
		// 								}],
		// 							},
		// 						},
		// 					]
		// 				},
		// 			]
		// 		},
		// 	]
		// },
		// {
		// 	code: '(a:String) => a',
		// 	result: [
		// 		{
		// 			type: 'functionLiteral',
		// 			pure: true,
		// 			params: {
		// 				singleNames: [
		// 					{
		// 						type: 'name',
		// 						name: 'a',
		// 						fallback: undefined,
		// 						source: undefined,
		// 						typeGuard: {
		// 							type: 'reference',
		// 							names: ['String']
		// 						},
		// 					},
		// 				],
		// 				rest: undefined
		// 			},
		// 			body: [
		// 				{
		// 					type: 'reference',
		// 					names: ['a']
		// 				}
		// 			]
		// 		},
		// 	]
		// },
		// {
		// 	code: '(a ...restArg) => restArg',
		// 	result: [
		// 		{
		// 			type: 'functionLiteral',
		// 			pure: true,
		// 			params: {
		// 				singleNames: [
		// 					{
		// 						type: 'name',
		// 						name: 'a',
		// 						fallback: undefined,
		// 						source: undefined,
		// 						typeGuard: undefined,
		// 					},
		// 				],
		// 				rest: {
		// 					name: 'restArg',
		// 				}
		// 			},
		// 			body: [
		// 				{
		// 					type: 'reference',
		// 					names: ['restArg']
		// 				}
		// 			]
		// 		},
		// 	]
		// },
		// {
		// 	code: '(\n\ta\n) =>\n\trestArg',
		// 	result: [
		// 		{
		// 			type: 'functionLiteral',
		// 			pure: true,
		// 			params: {
		// 				singleNames: [
		// 					{
		// 						type: 'name',
		// 						name: 'a',
		// 						fallback: undefined,
		// 						source: undefined,
		// 						typeGuard: undefined,
		// 					},
		// 				],
		// 				rest: undefined
		// 			},
		// 			body: [
		// 				{
		// 					type: 'reference',
		// 					names: ['restArg']
		// 				}
		// 			]
		// 		},
		// 	]
		// },
		{
			code: '(\n\ta\n\t...restArg\n) =>\n\trestArg',
			result: [
				{
					type: 'functionLiteral',
					pure: true,
					params: {
						singleNames: [
							{
								type: 'name',
								name: 'a',
								fallback: undefined,
								source: undefined,
								typeGuard: undefined,
							},
						],
						rest: {
							name: 'restArg',
						}
					},
					body: [
						{
							type: 'reference',
							names: ['restArg']
						}
					]
				},
			]
		},
		// {
		// 	code: 'number ?\n\t(n:0) => 1\n\t(n:1) => 1\n\t(n) => sum(fibonacci(subtract(n 2)) fibonacci(subtract(n 1)))\nfibonacci(7)',
		// 	result: [
		// 		{
		// 			type: 'branching',
		// 			value: { type: 'reference', names: ['number'] },
		// 			branches: [
		// 				{
		// 					type: 'functionLiteral',
		// 					pure: true,
		// 					params: {
		// 						singleNames: [{
		// 							type: 'name',
		// 							name: 'n',
		// 							fallback: undefined,
		// 							source: undefined,
		// 							typeGuard: {
		// 								type: 'number',
		// 								value: 0
		// 							},
		// 						}],
		// 						rest: undefined
		// 					},
		// 					body: [
		// 						{
		// 							type: 'number',
		// 							value: 1
		// 						}
		// 					]
		// 				},
		// 				{
		// 					type: 'functionLiteral',
		// 					pure: true,
		// 					params: {
		// 						singleNames: [{
		// 							type: 'name',
		// 							name: 'n',
		// 							fallback: undefined,
		// 							source: undefined,
		// 							typeGuard: {
		// 								type: 'number',
		// 								value: 1
		// 							},
		// 						}],
		// 						rest: undefined
		// 					},
		// 					body: [
		// 						{
		// 							type: 'number',
		// 							value: 1
		// 						}
		// 					]
		// 				},
		// 				{
		// 					type: 'functionLiteral',
		// 					pure: true,
		// 					params: {
		// 						singleNames: [{
		// 							type: 'name',
		// 							name: 'n',
		// 							fallback: undefined,
		// 							source: undefined,
		// 							typeGuard: undefined,
		// 						}],
		// 						rest: undefined
		// 					},
		// 					body: [
		// 						{
		// 							type: 'functionCall',
		// 							functionReference: ['sum'],
		// 							params: {
		// 								type: 'list',
		// 								values: [
		// 									{
		// 										type: 'functionCall',
		// 										functionReference: ['fibonacci'],
		// 										params: {
		// 											type: 'list',
		// 											values: [
		// 												{
		// 													type: 'functionCall',
		// 													functionReference: ['subtract'],
		// 													params: {
		// 														type: 'list',
		// 														values: [
		// 															{
		// 																type: 'reference',
		// 																names: ['n']
		// 															},
		// 															{
		// 																type: 'number',
		// 																value: 2
		// 															}
		// 														]
		// 													}
		// 												}
		// 											]
		// 										}
		// 									},
		// 									{
		// 										type: 'functionCall',
		// 										functionReference: ['fibonacci'],
		// 										params: {
		// 											type: 'list',
		// 											values: [
		// 												{
		// 													type: 'functionCall',
		// 													functionReference: ['subtract'],
		// 													params: {
		// 														type: 'list',
		// 														values: [
		// 															{
		// 																type: 'reference',
		// 																names: ['n']
		// 															},
		// 															{
		// 																type: 'number',
		// 																value: 1
		// 															}
		// 														]
		// 													}
		// 												}
		// 											]
		// 										}
		// 									}
		// 								]
		// 							}
		// 						}
		// 					]
		// 				},
		// 			]
		// 		},
		// 		{
		// 			type: 'functionCall',
		// 			functionReference: ['fibonacci'],
		// 			params: {
		// 				type: 'list',
		// 				values: [
		// 					{
		// 						type: 'number',
		// 						value: 7
		// 					}
		// 				]
		// 			}
		// 		}
		// 	]
		// }
	]

describe('Parser', () => {

	// it('defer rejects when callback throws', () =>
	// {
	//     return expect(defer(() => { throw new Error('callbackError') }, 0)).to.eventually.be.rejectedWith('callbackError');
	// })

	expectedResults.forEach(({ code, result }) => {
		it(code, () => {
			const parserResult = parseCode(code)
			if (parserResult.errors?.length) {
				console.log(parserResult.errors)
			}
			expect(parserResult.errors ?? []).to.deep.equal([])
			expect(parserResult.parsed).to.deep.equal(result)
		})
	})

})