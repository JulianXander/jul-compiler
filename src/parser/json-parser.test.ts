

import { expect } from 'chai';

import { ParseDictionaryLiteral, ParseDictionaryTypeLiteral, ParseExpression, ParseFunctionLiteral, ParseListLiteral, ParseNestedReference, ParseSingleDictionaryField, ParseSingleDictionaryTypeField } from '../syntax-tree.js';
import { ParserError } from './parser-combinator.js';
import { parseCode } from './parser.js';

const expectedResults: {
	name?: string;
	code: string;
	result?: ParseExpression[];
	errors?: ParserError[];
}[] = [
		{
			name: 'newline',
			code: '"hallo\\nWelt"',
			result: [
				{
					"endColumnIndex": 0,
					"endRowIndex": 0,
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"type": "text",
					"values": [
						{
							"type": "textToken",
							"value": "hallo\nWelt",
						},
					],
				},
			],
		}
	];

describe('JSON Parser', () => {
	expectedResults.forEach(({ name, code, result, errors }) => {
		it(name ?? code, () => {
			const parserResult = parseCode(code, 'dummy.json');
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