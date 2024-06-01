import { expect } from 'chai';

import { ParseExpression, ParseSingleDefinition } from './syntax-tree.js';
import { ParserError } from './parser/parser-combinator.js';
import { parseCode } from './parser/parser.js';
import { checkTypes } from './checker.js';

const expectedResults: {
	name?: string;
	code: string;
	result?: ParseExpression[];
	errors?: ParserError[];
}[] = [
		{
			name: 'text-interpolation-reference-error',
			code: '§§(a)§',
			errors: [
				{
					"endColumnIndex": 4,
					"endRowIndex": 0,
					"message": "a is not defined.",
					"startColumnIndex": 3,
					"startRowIndex": 0,
				},
			],
		},
		{
			name: 'branch-non-function-error',
			code: '() ?\n\t4',
			// result: [
			// 	{
			// 		"branches": [
			// 			{
			// 				"endColumnIndex": 2,
			// 				"endRowIndex": 1,
			// 				"inferredType": 4n,
			// 				"startColumnIndex": 1,
			// 				"startRowIndex": 1,
			// 				"type": "integer",
			// 				"value": 4n,
			// 			},
			// 		],
			// 		"endColumnIndex": 1,
			// 		"endRowIndex": 2,
			// 		"inferredType": {
			// 			"ChoiceTypes": [
			// 				{
			// 					"type": "any",
			// 				},
			// 			],
			// 			"type": "or",
			// 		},
			// 		"startColumnIndex": 0,
			// 		"startRowIndex": 0,
			// 		"type": "branching",
			// 		"value": {
			// 			"endColumnIndex": 2,
			// 			"endRowIndex": 0,
			// 			"fields": [],
			// 			"inferredType": {
			// 				"type": "any",
			// 			},
			// 			"startColumnIndex": 0,
			// 			"startRowIndex": 0,
			// 			"type": "bracketed",
			// 		},
			// 	},
			// ],
			errors: [
				{
					"endColumnIndex": 2,
					"endRowIndex": 1,
					"message": "Expected branch to be a function.\nCan not assign 4 to Any :> Any.",
					"startColumnIndex": 1,
					"startRowIndex": 1,
				},
			],
		},
		// {
		// 	name: 'prefix-function-call',
		// 	code: '4.log()',
		// 	result: [],
		// },
		// {
		// 	name: 'redefine-corelib',
		// 	code: 'add = 1',
		// 	result: [],
		// 	errors: [
		// 		{
		// 			"endColumnIndex": 7,
		// 			"endRowIndex": 0,
		// 			"message": "add is already defined in upper scope",
		// 			"startColumnIndex": 0,
		// 			"startRowIndex": 0,
		// 		},
		// 	],
		// },
		{
			name: 'used-before-defined-error',
			code: `a
a = 5`,
			errors: [
				{
					"endColumnIndex": 1,
					"endRowIndex": 0,
					"message": "a is used before it is defined.",
					"startColumnIndex": 0,
					"startRowIndex": 0,
				},
			],
		},
		{
			name: 'list-type-error',
			code: 'a: List(Text) = (4)',
			errors: [
				{
					"endColumnIndex": 19,
					"endRowIndex": 0,
					"message": "Can not assign 4 to Text.",
					"startColumnIndex": 0,
					"startRowIndex": 0,
				},
			],
		},
		{
			name: 'type-function',
			code: `t = Any => ()
t(1)`,
		},
	];

describe('Checker', () => {
	expectedResults.forEach(({ name, code, result, errors }) => {
		it(name ?? code, () => {
			const parserResult = parseCode(code, 'dummy.jul');
			checkTypes(parserResult, {});
			expect(parserResult.checked?.errors).to.deep.equal(errors ?? []);
			if (result) {
				expect(parserResult.checked?.expressions).to.deep.equal(result);
			}
		});
	});
});