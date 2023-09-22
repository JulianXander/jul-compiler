import { expect } from 'chai';

import { ParseExpression } from './syntax-tree.js';
import { Extension } from './util.js';
import { ParserError } from './parser/parser-combinator.js';
import { parseCode } from './parser/parser.js';
import { checkTypes } from './type-checker.js'

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
					"type": "string",
					"values": [
						{
							"endColumnIndex": 4,
							"endRowIndex": 0,
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
	];

describe('Parser', () => {
	expectedResults.forEach(({ name, code, result, errors }) => {
		it(name ?? code, () => {
			const parserResult = parseCode(code, Extension.jul);
			// if (parserResult.errors?.length) {
			// 	console.log(parserResult.errors);
			// }
			checkTypes(parserResult, {}, '');
			expect(parserResult.errors).to.deep.equal(errors ?? []);
			expect(parserResult.expressions).to.deep.equal(result);
		});
	});
});