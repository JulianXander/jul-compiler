import { expect } from 'chai';

import { ParseDictionaryLiteral, ParseDictionaryTypeLiteral, ParseExpression, ParseListLiteral, ParseSingleDictionaryField, ParseSingleDictionaryTypeField } from '../syntax-tree.js';
import { ParserError } from './parser-combinator.js';
import { parseCode } from './parser.js';

const expectedResults: {
	name?: string;
	code: string;
	result?: ParseExpression[];
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
		{
			name: 'field-description',
			code: '(\n\t# hallo\n\tsomeKey = 5\n)\n',
			result: (() => {
				const field: ParseSingleDictionaryField = {
					"description": " hallo",
					"endColumnIndex": 12,
					"endRowIndex": 2,
					"fallback": undefined,
					"name": {
						"endColumnIndex": 8,
						"endRowIndex": 2,
						"name": "someKey",
						"startColumnIndex": 1,
						"startRowIndex": 2,
						"type": "name",
					},
					"startColumnIndex": 1,
					"startRowIndex": 2,
					"type": "singleDictionaryField",
					"typeGuard": undefined,
					"value": {
						"endColumnIndex": 12,
						"endRowIndex": 2,
						"startColumnIndex": 11,
						"startRowIndex": 2,
						"type": "integer",
						"value": 5n,
					},
				};
				field.name.parent = field;
				const dictionary: ParseDictionaryLiteral = {
					"endColumnIndex": 1,
					"endRowIndex": 3,
					"fields": [
						field,
					],
					"symbols": {
						"someKey": {
							"description": " hallo",
							"endColumnIndex": 8,
							"endRowIndex": 2,
							"functionParameterIndex": undefined,
							"startColumnIndex": 1,
							"startRowIndex": 2,
							"typeExpression": undefined as any,
						},
					},
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"type": "dictionary",
				};
				dictionary.fields[0].parent = dictionary;
				const result: ParseExpression[] = [
					dictionary,
				];
				return result;
			})(),
		},
		{
			name: 'escaped-field',
			code: '(\n\t§someKey§ = 5\n)\n',
			result: (() => {
				const field: ParseSingleDictionaryField = {
					"description": undefined,
					"endColumnIndex": 14,
					"endRowIndex": 1,
					"fallback": undefined,
					"name": {
						"endColumnIndex": 10,
						"endRowIndex": 1,
						"startColumnIndex": 1,
						"startRowIndex": 1,
						"type": "text",
						values: [
							{
								type: "textToken",
								value: "someKey"
							}
						]
					},
					"startColumnIndex": 1,
					"startRowIndex": 1,
					"type": "singleDictionaryField",
					"typeGuard": undefined,
					"value": {
						"endColumnIndex": 14,
						"endRowIndex": 1,
						"startColumnIndex": 13,
						"startRowIndex": 1,
						"type": "integer",
						"value": 5n,
					},
				};
				field.name.parent = field;
				const dictionary: ParseDictionaryLiteral = {
					"endColumnIndex": 1,
					"endRowIndex": 2,
					"fields": [
						field,
					],
					"symbols": {
						"someKey": {
							"description": undefined,
							"endColumnIndex": 10,
							"endRowIndex": 1,
							"functionParameterIndex": undefined,
							"startColumnIndex": 1,
							"startRowIndex": 1,
							"typeExpression": undefined as any,
						},
					},
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"type": "dictionary",
				};
				dictionary.fields[0].parent = dictionary;
				const result: ParseExpression[] = [
					dictionary,
				];
				return result;
			})(),
		},
		{
			name: 'dictionary-type',
			code: '(\n\tsomeKey: Text\n)',
			result: (() => {
				const field: ParseSingleDictionaryTypeField = {
					"endColumnIndex": 14,
					"endRowIndex": 1,
					"name": {
						"endColumnIndex": 8,
						"endRowIndex": 1,
						"name": "someKey",
						"startColumnIndex": 1,
						"startRowIndex": 1,
						"type": "name",
					},
					"startColumnIndex": 1,
					"startRowIndex": 1,
					"type": "singleDictionaryTypeField",
					"typeGuard": {
						"endColumnIndex": 14,
						"endRowIndex": 1,
						"name": {
							"endColumnIndex": 14,
							"endRowIndex": 1,
							"name": "Text",
							"startColumnIndex": 10,
							"startRowIndex": 1,
							"type": "name",
						},
						"startColumnIndex": 10,
						"startRowIndex": 1,
						"type": "reference",
					},
				}
				field.name.parent = field;
				const dictionaryType: ParseDictionaryTypeLiteral = {
					"endColumnIndex": 1,
					"endRowIndex": 2,
					"fields": [
						field
					],
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"symbols": {
						"someKey": {
							"description": undefined,
							"endColumnIndex": 8,
							"endRowIndex": 1,
							"functionParameterIndex": undefined,
							"startColumnIndex": 1,
							"startRowIndex": 1,
							"typeExpression": {
								"endColumnIndex": 14,
								"endRowIndex": 1,
								"name": {
									"endColumnIndex": 14,
									"endRowIndex": 1,
									"name": "Text",
									"startColumnIndex": 10,
									"startRowIndex": 1,
									"type": "name",
								},
								"startColumnIndex": 10,
								"startRowIndex": 1,
								"type": "reference",
							},
						},
					},
					"type": "dictionaryType",
				};
				dictionaryType.fields[0].parent = dictionaryType;
				const result: ParseExpression[] = [
					dictionaryType,
				];
				return result;
			})(),
		},
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
		// 	code: 'number ?\n\t(n:0) => 1\n\t(n:1) => 1\n\t(n) => add(fibonacci(subtract(n 2)) fibonacci(subtract(n 1)))\nfibonacci(7)',
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
			name: 'branching-error',
			code: '4 ?\n\t4 =>\n\t\tlog(\n\t\t\t4)',
			// result: [
			// 	{
			// 		type: "branching",
			// 		value: {
			// 			type: "integer",
			// 			value: 4n,
			// 			startRowIndex: 0,
			// 			startColumnIndex: 0,
			// 			endRowIndex: 0,
			// 			endColumnIndex: 1,
			// 		},
			// 		branches: [
			// 			{
			// 				type: "functionLiteral",
			// 				params: {
			// 					type: "integer",
			// 					value: 4n,
			// 					startRowIndex: 1,
			// 					startColumnIndex: 1,
			// 					endRowIndex: 1,
			// 					endColumnIndex: 2,
			// 				},
			// 				returnType: undefined,
			// 				body: [
			// 					{
			// 						type: "reference",
			// 						name: {
			// 							type: "name",
			// 							name: "log",
			// 							startRowIndex: 2,
			// 							startColumnIndex: 2,
			// 							endRowIndex: 2,
			// 							endColumnIndex: 5,
			// 						},
			// 						startRowIndex: 2,
			// 						startColumnIndex: 2,
			// 						endRowIndex: 2,
			// 						endColumnIndex: 5,
			// 					},
			// 				],
			// 				symbols: {
			// 				},
			// 				startRowIndex: 1,
			// 				startColumnIndex: 1,
			// 				endRowIndex: 4,
			// 				endColumnIndex: 2,
			// 			},
			// 		],
			// 		startRowIndex: 0,
			// 		startColumnIndex: 0,
			// 		endRowIndex: 4,
			// 		endColumnIndex: 1,
			// 	},
			// ],
			errors: [
				{
					message: "multilineParser should parse until end of row",
					startRowIndex: 2,
					startColumnIndex: 5,
					endRowIndex: 2,
					endColumnIndex: 5,
				},
				{
					startRowIndex: 3,
					startColumnIndex: 2,
					endRowIndex: 3,
					endColumnIndex: 2,
					message: "Expected one of: bracketedBaseParser,numberParser,,referenceParser",
				},
			],
		},
		{
			name: 'function-literal-return-type',
			code: '(): () => ()',
			result: [
				{
					"body": [
						{
							"endColumnIndex": 12,
							"endRowIndex": 0,
							"startColumnIndex": 10,
							"startRowIndex": 0,
							"type": "empty",
						},
					],
					"endColumnIndex": 12,
					"endRowIndex": 0,
					"params": {
						"endColumnIndex": 2,
						"endRowIndex": 0,
						"rest": undefined,
						"singleFields": [],
						"startColumnIndex": 0,
						"startRowIndex": 0,
						symbols: {},
						"type": "parameters",
					},
					"returnType": {
						"endColumnIndex": 6,
						"endRowIndex": 0,
						"fields": [],
						"startColumnIndex": 4,
						"startRowIndex": 0,
						"type": "bracketed",
					},
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"symbols": {},
					"type": "functionLiteral",
				},
			],
		},
		{
			name: 'uncomplete-nested-reference',
			code: 'a/',
			result: [
				{
					"endColumnIndex": 2,
					"endRowIndex": 0,
					"nestedKey": undefined,
					"source": {
						"endColumnIndex": 1,
						"endRowIndex": 0,
						"name": {
							"endColumnIndex": 1,
							"endRowIndex": 0,
							"name": "a",
							"startColumnIndex": 0,
							"startRowIndex": 0,
							"type": "name",
						},
						"startColumnIndex": 0,
						"startRowIndex": 0,
						"type": "reference",
					},
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"type": "nestedReference",
				},
			],
			errors: [
				{
					"endColumnIndex": 2,
					"endRowIndex": 0,
					"message": "Expected a nested key",
					"startColumnIndex": 1,
					"startRowIndex": 0,
				},
			],
		},
		{
			name: 'uncomplete-list',
			code: '(4 )',
			result: (() => {
				const list: ParseListLiteral = {
					"endColumnIndex": 4,
					"endRowIndex": 0,
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"type": "list",
					"values": [
						{
							"endColumnIndex": 2,
							"endRowIndex": 0,
							"startColumnIndex": 1,
							"startRowIndex": 0,
							"type": "integer",
							"value": 4n,
						},
					],
				};
				list.values[0].parent = list;
				return [list];
			})(),
			errors: [
				{
					"endColumnIndex": 3,
					"endRowIndex": 0,
					"message": "expression expected",
					"startColumnIndex": 3,
					"startRowIndex": 0,
				},
			],
		},
		{
			name: 'uncomplete-dictionary-field',
			code: '(\n\ta = \n)',
			result: (() => {
				const dictionary: ParseDictionaryLiteral = {
					"endColumnIndex": 1,
					"endRowIndex": 2,
					"fields": [
						{
							"description": undefined,
							"endColumnIndex": 5,
							"endRowIndex": 1,
							"fallback": undefined,
							"name": {
								"endColumnIndex": 2,
								"endRowIndex": 1,
								"name": "a",
								// "parent": [Circular],
								"startColumnIndex": 1,
								"startRowIndex": 1,
								"type": "name",
							},
							// "parent": [Circular],
							"startColumnIndex": 1,
							"startRowIndex": 1,
							"type": "singleDictionaryField",
							"typeGuard": undefined,
							"value": undefined,
						},
					],
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"symbols": {
						"a": {
							"description": undefined,
							"endColumnIndex": 2,
							"endRowIndex": 1,
							"functionParameterIndex": undefined,
							"startColumnIndex": 1,
							"startRowIndex": 1,
							"typeExpression": undefined,
						},
					},
					"type": "dictionary",
				};
				dictionary.fields[0].parent = dictionary;
				(dictionary.fields[0] as any).name.parent = dictionary.fields[0];
				return [
					dictionary,
				];
			})(),
			errors: [
				{
					"endColumnIndex": 5,
					"endRowIndex": 1,
					"message": "assignedValue missing for singleDictionaryField",
					"startColumnIndex": 1,
					"startRowIndex": 1,
				},
			],
		},
	];

describe('Parser', () => {
	expectedResults.forEach(({ name, code, result, errors }) => {
		it(name ?? code, () => {
			const parserResult = parseCode(code, 'dummy.jul');
			// if (parserResult.errors?.length) {
			// 	console.log(parserResult.errors);
			// }
			expect(parserResult.unchecked.errors).to.deep.equal(errors ?? []);
			if (result) {
				expect(parserResult.unchecked.expressions).to.deep.equal(result);
			}
		});
	});
});