

import { expect } from 'chai';

import { ParseDictionaryLiteral, ParseDictionaryTypeLiteral, ParseExpression, ParseFunctionLiteral, ParseListLiteral, ParseNestedReference, ParseSingleDictionaryField, ParseSingleDictionaryTypeField } from '../syntax-tree.js';
import { CompilerError } from '../compiler-errors.js';
import { parseCode } from './parser.js';
import { reportAtCaller } from '../test-util.js';
import { setFileSymbolIds, setParentsAndIds } from './parser-utils.js';

const expectJsonParse = reportAtCaller((code: string, { result, errors }: {
	result?: ParseExpression[];
	errors?: CompilerError[];
} = {}) => {
	const parserResult = parseCode(code, 'dummy.json');
	// if (parserResult.errors?.length) {
	// 	console.log(parserResult.errors);
	// }
	expect(parserResult.syntax.errors).to.deep.equal(errors ?? []);
	if (result) {
		// Die Ids vergibt der Parser nachgelagert, im erwarteten Baum dieselben Funktionen. Die
		// Symboltabelle der Datei ist die gemessene, sie vergibt dieselben Ids erneut.
		setFileSymbolIds(parserResult.syntax.symbols, setParentsAndIds(result).symbolCount);
		expect(parserResult.syntax.expressions).to.deep.equal(result);
	}
});

describe('JSON Parser', () => {
	it('newline', () => {
		expectJsonParse('"hallo\\nWelt"', {
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
		});
	});
});