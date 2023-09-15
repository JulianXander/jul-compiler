import { expect } from 'chai';

import { ParseExpression } from '../syntax-tree.js';
import { Extension } from '../util.js';
import { ParserError } from './parser-combinator.js';
import { parseCode } from './parser.js';

const expectedResults: {
	code: string;
	result: ParseExpression[];
	errors?: ParserError[];
}[] = [
		// {
		// 	code: 'true',
		// 	result: [{
		// 		type: 'reference',
		// 		name: {
		// 			type: 'name',
		// 			name: 'true',
		// 			startRowIndex: 0,
		// 			startColumnIndex: 0,
		// 			endRowIndex: 0,
		// 			endColumnIndex: 4,
		// 		},
		// 		startRowIndex: 0,
		// 		startColumnIndex: 0,
		// 		endRowIndex: 0,
		// 		endColumnIndex: 4,
		// 	}]
		// },
		// {
		// 	code: '§\n\t§#\n§',
		// 	result: [{
		// 		type: 'string',
		// 		values: [{ type: 'stringToken', value: '#\n' }],
		// 		startRowIndex: 0,
		// 		startColumnIndex: 0,
		// 		endRowIndex: 2,
		// 		endColumnIndex: 1,
		// 	}]
		// },
		// {
		// 	code: '§\n\t12\n§',
		// 	result: [{
		// 		type: 'string',
		// 		values: [{ type: 'stringToken', value: '12\n' }],
		// 		startRowIndex: 0,
		// 		startColumnIndex: 0,
		// 		endRowIndex: 2,
		// 		endColumnIndex: 1,
		// 	}]
		// },
		// {
		// 	code: 'a: 4 = 4',
		// 	result: [{
		// 		type: 'integer',
		// 		value: 12n,
		// 		startRowIndex: 0,
		// 		startColumnIndex: 0,
		// 		endRowIndex: 0,
		// 		endColumnIndex: 2,
		// 	}]
		// },
		// {
		// 	code: '12',
		// 	result: [{
		// 		type: 'integer',
		// 		value: 12n,
		// 		startRowIndex: 0,
		// 		startColumnIndex: 0,
		// 		endRowIndex: 0,
		// 		endColumnIndex: 2,
		// 	}]
		// },
		// {
		// 	code: '12.34f',
		// 	result: [{
		// 		type: 'float',
		// 		value: 12.34,
		// 		startRowIndex: 0,
		// 		startColumnIndex: 0,
		// 		endRowIndex: 0,
		// 		endColumnIndex: 6,
		// 	}]
		// },
		// {
		// 	code: '12.34',
		// 	result: [{
		// 		type: 'fraction',
		// 		numerator: 1234n,
		// 		denominator: 100n,
		// 		startRowIndex: 0,
		// 		startColumnIndex: 0,
		// 		endRowIndex: 0,
		// 		endColumnIndex: 5,
		// 	}]
		// },
		// {
		// 	code: '(delayMs: Float): Stream(Float)',
		// 	result: []
		// },
		// {
		// 	code: 'x: (b: B c: C) => () = ()',
		// 	result: []
		// },
		// {
		// 	code: '(\n\t#\n\ta = b\n\t#\n)',
		// 	result: [{
		// 		type: 'dictionaryType',
		// 		singleFields: [{
		// 			type: 'field',
		// 			name: {
		// 				type: 'name',
		// 				name: 'a',
		// 				startRowIndex: 2,
		// 				startColumnIndex: 1,
		// 				endRowIndex: 2,
		// 				endColumnIndex: 2,
		// 			},
		// 			typeGuard: undefined,
		// 			source: {
		// 				type: 'name',
		// 				name: 'b',
		// 				startRowIndex: 2,
		// 				startColumnIndex: 5,
		// 				endRowIndex: 2,
		// 				endColumnIndex: 6,
		// 			},
		// 			fallback: undefined,
		// 			startRowIndex: 2,
		// 			startColumnIndex: 1,
		// 			endRowIndex: 2,
		// 			endColumnIndex: 6,
		// 		}],
		// 		rest: undefined,
		// 		startRowIndex: 0,
		// 		startColumnIndex: 0,
		// 		endRowIndex: 4,
		// 		endColumnIndex: 1,
		// 	}],
		// },
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
		// 	code: '(\n\tsomeKey = 5\n)\n',
		// 	result: [{
		// 		type: 'dictionary',
		// 		values: [
		// 			{
		// 				name: 'someKey',
		// 				typeGuard: undefined,
		// 				value: { type: 'number', value: 5 },
		// 			}
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
		// 	code: '(var var2) = (4 5)',
		// 	result: [
		// 		{
		// 			type: 'destructuring',
		// 			names: {
		// 				singleNames: [
		// 					{
		// 						type: 'name',
		// 						name: 'var',
		// 						fallback: undefined,
		// 						source: undefined,
		// 						typeGuard: undefined,
		// 					},
		// 					{
		// 						type: 'name',
		// 						name: 'var2',
		// 						fallback: undefined,
		// 						source: undefined,
		// 						typeGuard: undefined,
		// 					}
		// 				],
		// 				rest: undefined
		// 			},
		// 			value: {
		// 				type: 'list',
		// 				values: [
		// 					{ type: 'number', value: 4 },
		// 					{ type: 'number', value: 5 }
		// 				]
		// 			},
		// 		},
		// 	]
		// },
		// {
		// 	code: 'log(§hallo welt§)',
		// 	result: [
		// 		{
		// 			type: 'functionCall',
		// 			functionReference: {
		// 				type: 'reference',
		// 				names: [{
		// 					type: 'name',
		// 					name: 'log',
		// 					startRowIndex: 0,
		// 					startColumnIndex: 0,
		// 					endRowIndex: 0,
		// 					endColumnIndex: 3,
		// 				}],
		// 				startRowIndex: 0,
		// 				startColumnIndex: 0,
		// 				endRowIndex: 0,
		// 				endColumnIndex: 3,
		// 			},
		// 			arguments: {
		// 				type: 'list',
		// 				values: [{
		// 					type: 'string',
		// 					values: [{
		// 						type: 'stringToken',
		// 						value: 'hallo welt',
		// 					}],
		// 					startRowIndex: 0,
		// 					startColumnIndex: 4,
		// 					endRowIndex: 0,
		// 					endColumnIndex: 16,
		// 				}],
		// 				startRowIndex: 0,
		// 				startColumnIndex: 3,
		// 				endRowIndex: 0,
		// 				endColumnIndex: 17,
		// 			},
		// 			startRowIndex: 0,
		// 			startColumnIndex: 0,
		// 			endRowIndex: 0,
		// 			endColumnIndex: 17,
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
		// {
		// 	code: '(\n\ta\n\t...restArg\n) =>\n\trestArg',
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
		// },
		// {
		// 	code: 'myFunc(\n§someValue§)',
		// 	result: [
		// 		{
		// 			"endColumnIndex": 6,
		// 			"endRowIndex": 0,
		// 			"name": {
		// 				"endColumnIndex": 6,
		// 				"endRowIndex": 0,
		// 				"name": "myFunc",
		// 				"startColumnIndex": 0,
		// 				"startRowIndex": 0,
		// 				"type": "name",
		// 			},
		// 			"startColumnIndex": 0,
		// 			"startRowIndex": 0,
		// 			"type": "reference",
		// 		},
		// 		{
		// 			"endColumnIndex": 11,
		// 			"endRowIndex": 1,
		// 			"startColumnIndex": 0,
		// 			"startRowIndex": 1,
		// 			"type": "string",
		// 			"values": [
		// 				{
		// 					"type": "stringToken",
		// 					"value": "someValue",
		// 				},
		// 			],
		// 		},
		// 	],
		// 	errors: [
		// 		{
		// 			"endColumnIndex": 6,
		// 			"endRowIndex": 0,
		// 			"message": "multilineParser should parse until end of row",
		// 			"startColumnIndex": 6,
		// 			"startRowIndex": 0,
		// 		},
		// 		{
		// 			"endColumnIndex": 11,
		// 			"endRowIndex": 1,
		// 			"message": "multilineParser should parse until end of row",
		// 			"startColumnIndex": 11,
		// 			"startRowIndex": 1,
		// 		}
		// 	]
		// },
		{
			code: '4 ?\n\t4 =>\n\t\tlog(\n\t\t\t4)',
			result: [],
			errors: [],
		},
		// {
		// 	code: '(): () => ()',
		// 	result: []
		// },
	];

describe('Parser', () => {
	expectedResults.forEach(({ code, result, errors }) => {
		it(code, () => {
			const parserResult = parseCode(code, Extension.jul);
			// if (parserResult.errors?.length) {
			// 	console.log(parserResult.errors);
			// }
			expect(parserResult.errors).to.deep.equal(errors ?? []);
			expect(parserResult.expressions).to.deep.equal(result);
		});
	});
});