import { expect } from 'chai';

import { ParseExpression } from './syntax-tree.js';
import { ParserError } from './parser/parser-combinator.js';
import { parseCode } from './parser/parser.js';
import { checkTypes } from './checker.js'

const expectedResults: {
	name?: string;
	code: string;
	result: ParseExpression[];
	errors?: ParserError[];
}[] = [
		{
			name: 'text-interpolation-reference-error',
			code: '§§(a)§',
			result: [
				{
					"endColumnIndex": 6,
					"endRowIndex": 0,
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"type": "text",
					"inferredType": {
						"type": "text",
					},
					"values": [
						{
							"endColumnIndex": 4,
							"endRowIndex": 0,
							"inferredType": {
								"type": "any",
							},
							"name": {
								"endColumnIndex": 4,
								"endRowIndex": 0,
								"name": "a",
								"startColumnIndex": 3,
								"startRowIndex": 0,
								"type": "name",
							},
							"startColumnIndex": 3,
							"startRowIndex": 0,
							"type": "reference",
						},
					],
				},
			],
			errors: [
				{
					"endColumnIndex": 4,
					"endRowIndex": 0,
					"message": "a is not defined",
					"startColumnIndex": 3,
					"startRowIndex": 0,
				},
			],
		},
		{
			name: 'branch-non-function-error',
			code: '() ?\n\t4',
			result: [
				{
					"branches": [
						{
							"endColumnIndex": 2,
							"endRowIndex": 1,
							"inferredType": 4n,
							"startColumnIndex": 1,
							"startRowIndex": 1,
							"type": "integer",
							"value": 4n,
						},
					],
					"endColumnIndex": 1,
					"endRowIndex": 2,
					"inferredType": {
						"choiceTypes": [
							{
								"type": "any",
							},
						],
						"type": "or",
					},
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"type": "branching",
					"value": {
						"endColumnIndex": 2,
						"endRowIndex": 0,
						"fields": [],
						"inferredType": {
							"type": "any",
						},
						"startColumnIndex": 0,
						"startRowIndex": 0,
						"type": "bracketed",
					},
				},
			],
			errors: [
				{
					"endColumnIndex": 2,
					"endRowIndex": 1,
					"message": "Expected branch to be a function.\nCan not assign 4 to Any => Any.",
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
	];

describe('Checker', () => {
	expectedResults.forEach(({ name, code, result, errors }) => {
		it(name ?? code, () => {
			const parserResult = parseCode(code, 'dummy.jul');
			// if (parserResult.errors?.length) {
			// 	console.log(parserResult.errors);
			// }
			checkTypes(parserResult, {});
			expect(parserResult.checked?.errors).to.deep.equal(errors ?? []);
			expect(parserResult.checked?.expressions).to.deep.equal(result);
		});
	});
});