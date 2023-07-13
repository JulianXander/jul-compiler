import { expect } from 'chai';
import { parseJson } from './runtime.js';

//#region parseJson

const expectedParseJsonResults: {
	json: string;
	result: any;
}[] = [
		// {
		// 	json: 'null',
		// 	result: null,
		// },
		// {
		// 	json: 'true',
		// 	result: true,
		// },
		// {
		// 	json: 'false',
		// 	result: false,
		// },
		// {
		// 	json: '12',
		// 	result: 12n,
		// },
		// {
		// 	json: '12.3',
		// 	result: { numerator: 123n, denominator: 10n },
		// },
		// {
		// 	json: '-12.3',
		// 	result: { numerator: -123n, denominator: 10n },
		// },
		// {
		// 	json: '-12.3e-4',
		// 	result: { numerator: -123n, denominator: 100000n },
		// },
		// {
		// 	json: '-12.3e+4',
		// 	result: -123000n,
		// },
		// {
		// 	json: '"12"',
		// 	result: '12',
		// },
		// {
		// 	json: '   "12"  	\n\r',
		// 	result: '12',
		// },
		// {
		// 	json: '"\\\\"',
		// 	result: '\\',
		// },
		// {
		// 	json: '"\\u1234"',
		// 	result: 'ሴ',
		// },
		// {
		// 	json: '[  ]',
		// 	result: [],
		// },
		// {
		// 	json: '[1]',
		// 	result: [1n],
		// },
		{
			json: '{"a":"b"}',
			result: { a: 'b' },
		},
		// {
		// 	json: '[{"a":"b"}]',
		// 	result: [{ a: 'b' }],
		// },
	];

describe('parseJson', () => {
	expectedParseJsonResults.forEach(({ json, result }) => {
		it(json, () => {
			const parserResult = parseJson(json);
			expect(parserResult).to.deep.equal(result);
		});
	});
});

//#endregion parseJson