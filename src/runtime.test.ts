import { expect } from 'chai';
import { _branch, _createFunction, parseJson } from './runtime.js';

//#region _branch

describe('_branch', () => {
	// Ein rest ohne Typ darf nicht wie ein Typfehler behandelt werden (CHECKER-AUDIT.md #4).
	it('matches a branch with an untyped rest parameter', () => {
		const branch = _createFunction(
			(...args: unknown[]) => args,
			{ rest: {} },
		);
		const result = _branch([1n, 2n], branch);
		expect(result).to.deep.equal([1n, 2n]);
	});
});

//#endregion _branch

//#region parseJson

const expectedParseJsonResults: {
	json: string;
	result: any;
}[] = [
		{
			// null und leere Kollektionen werden zu Empty, vgl. Prinzip 6
			json: 'null',
			result: undefined,
		},
		{
			json: 'true',
			result: true,
		},
		{
			json: 'false',
			result: false,
		},
		{
			json: '12',
			result: 12n,
		},
		{
			json: '12.3',
			result: { numerator: 123n, denominator: 10n },
		},
		{
			json: '-12.3',
			result: { numerator: -123n, denominator: 10n },
		},
		{
			json: '-12.3e-4',
			result: { numerator: -123n, denominator: 100000n },
		},
		{
			json: '-12.3e+4',
			result: -123000n,
		},
		{
			json: '"12"',
			result: '12',
		},
		{
			json: '   "12"  	\n\r',
			result: '12',
		},
		{
			json: '"\\\\"',
			result: '\\',
		},
		{
			json: '"\\u1234"',
			result: 'ሴ',
		},
		{
			json: '[  ]',
			result: undefined,
		},
		{
			json: '[1]',
			result: [1n],
		},
		{
			json: '{"a":"b"}',
			result: { a: 'b' },
		},
		{
			json: '[{"a":"b"}]',
			result: [{ a: 'b' }],
		},
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