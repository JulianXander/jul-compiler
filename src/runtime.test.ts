import { expect } from 'chai';
import {
	_branch, _createFunction, add, addDate, and, combine$, completed$, create$, deepEqual,
	findLastIndex, multiply, or, parseJson, push, rationalToFloat, regex, subscribe, subtract, take$, toJson,
} from './runtime.js';

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

//#region toJson

const expectedToJsonResults: {
	value: any;
	result: string;
}[] = [
		{ value: undefined, result: 'null' },
		{ value: true, result: 'true' },
		{ value: 12n, result: '12' },
		{ value: 'ab', result: '"ab"' },
		{ value: [1n, 2n], result: '[1,2]' },
		{ value: { a: 'b' }, result: '{"a":"b"}' },
	];

describe('toJson', () => {
	expectedToJsonResults.forEach(({ value, result }) => {
		it(result, () => {
			expect(toJson(value)).to.equal(result);
		});
	});
});

//#endregion toJson

//#region Boolean

describe('and', () => {
	it('returns true when all args are true', () => {
		expect(and(true, true)).to.equal(true);
	});
	it('returns false when one arg is false', () => {
		expect(and(true, false)).to.equal(false);
	});
});

describe('or', () => {
	it('returns true when one arg is true', () => {
		expect(or(false, true)).to.equal(false || true);
	});
	it('returns false when all args are false', () => {
		expect(or(false, false)).to.equal(false);
	});
});

//#endregion Boolean

//#region Rational

describe('add', () => {
	it('adds two integers', () => {
		expect(add(2n, 3n)).to.equal(5n);
	});
	it('adds an integer and a fraction', () => {
		expect(add(1n, { numerator: 1n, denominator: 2n })).to.deep.equal({ numerator: 3n, denominator: 2n });
	});
});

describe('subtract', () => {
	it('subtracts two integers', () => {
		expect(subtract(5n, 3n)).to.equal(2n);
	});
	it('subtracts a fraction from an integer', () => {
		expect(subtract(1n, { numerator: 1n, denominator: 2n })).to.deep.equal({ numerator: 1n, denominator: 2n });
	});
});

// Brueche werden beim Rechnen nicht gekuerzt (TODO in add/subtract/multiply), deshalb haengt
// der Bruch vom Rechenweg ab statt vom Wert: 0.25+0.25 und 0.5 sind mathematisch gleich, aber
// strukturell verschieden - deepEqual sagt false. Sobald das Ergebnis als Literaltyp in den
// Checker zurueckfliesst (constant folding), bricht das die Annahme 'gleiche Werte, gleiche
// Typen'. Ein Bruch mit Nenner 1 wird zum Integer normalisiert, vgl. Rational = Or(Integer Fraction).
describe('Bruch kuerzen', () => {
	const half = { numerator: 1n, denominator: 2n };
	const quarter = { numerator: 1n, denominator: 4n };
	it('add kuerzt das Ergebnis', () => {
		expect(add(quarter, quarter)).to.deep.equal(half);
	});
	it('add normalisiert einen ganzzahligen Bruch zum Integer', () => {
		expect(add(half, half)).to.equal(1n);
	});
	it('subtract kuerzt das Ergebnis', () => {
		expect(subtract({ numerator: 3n, denominator: 4n }, quarter)).to.deep.equal(half);
	});
	it('multiply kuerzt das Ergebnis', () => {
		expect(multiply(half, { numerator: 2n, denominator: 3n })).to.deep.equal({ numerator: 1n, denominator: 3n });
	});
	it('deepEqual gleicher Werte ist true', () => {
		expect(deepEqual(add(quarter, quarter), half)).to.equal(true);
	});
});

describe('rationalToFloat', () => {
	it('converts an integer', () => {
		expect(rationalToFloat(4n)).to.equal(4);
	});
	it('converts a fraction', () => {
		expect(rationalToFloat({ numerator: 1n, denominator: 4n })).to.equal(0.25);
	});
});

//#endregion Rational

//#region Any

describe('deepEqual', () => {
	it('compares primitives by value', () => {
		expect(deepEqual(1n, 1n)).to.equal(true);
	});
	it('compares lists element-wise', () => {
		expect(deepEqual([1n, 2n], [1n, 2n])).to.equal(true);
		expect(deepEqual([1n, 2n], [1n, 3n])).to.equal(false);
	});
	it('compares dictionaries field-wise', () => {
		expect(deepEqual({ a: 1n }, { a: 1n })).to.equal(true);
		expect(deepEqual({ a: 1n }, { a: 2n })).to.equal(false);
		expect(deepEqual({ a: 1n }, { a: 1n, b: 2n })).to.equal(false);
	});
});

//#endregion Any

//#region List

describe('findLastIndex', () => {
	it('finds the index of the last matching element (1-based)', () => {
		const result = findLastIndex([1n, 2n, 3n, 2n], (value: bigint) => value === 2n);
		expect(result).to.equal(4n);
	});
	it('returns undefined when nothing matches', () => {
		const result = findLastIndex([1n, 2n], (value: bigint) => value === 9n);
		expect(result).to.equal(undefined);
	});
});

//#endregion List

//#region Text

describe('regex', () => {
	it('reports a match with captures', () => {
		const result: any = regex('2024-01-02', '(?<year>\\d+)-(?<month>\\d+)-(?<day>\\d+)');
		expect(result.isMatch).to.equal(true);
		expect(result.namedCaptures).to.deep.equal({ year: '2024', month: '01', day: '02' });
	});
	it('reports no match', () => {
		const result: any = regex('abc', '\\d+');
		expect(result.isMatch).to.equal(false);
	});
	it('returns an Error for an invalid pattern', () => {
		const result = regex('abc', '(');
		expect(result).to.be.instanceOf(Error);
	});
});

//#endregion Text

//#region Date

describe('addDate', () => {
	it('adds years, months and days', () => {
		const date = new Date(2020, 0, 1);
		const result = addDate(date, 1n, 1n, 1n, undefined, undefined, undefined, undefined);
		expect(result).to.deep.equal(new Date(2021, 1, 2));
	});
});

//#endregion Date

//#region Stream

describe('create$/push/subscribe', () => {
	it('notifies subscribers of pushed values, starting with the initial value', () => {
		const stream$ = create$(undefined, 1n);
		const values: bigint[] = [];
		subscribe(stream$, (value: bigint) => values.push(value));
		push(stream$, 2n);
		push(stream$, 3n);
		expect(values).to.deep.equal([1n, 2n, 3n]);
	});
});

describe('completed$', () => {
	it('creates an already completed stream with the initial value', () => {
		const stream$: any = completed$(5n);
		expect(stream$.completed).to.equal(true);
		expect(stream$.lastValue).to.equal(5n);
	});
});

describe('take$', () => {
	it('completes after the given amount of values', () => {
		const source$ = create$(undefined, 1n);
		const taken$ = take$(source$, 2n);
		const values: bigint[] = [];
		subscribe(taken$, (value: bigint) => values.push(value));
		push(source$, 2n);
		push(source$, 3n);
		expect(values).to.deep.equal([1n, 2n, 3n]);
		expect((taken$ as any).completed).to.equal(true);
	});
});

describe('combine$', () => {
	it('combines the latest values of all sources', () => {
		const first$ = create$(undefined, 1n);
		const second$ = create$(undefined, 'a');
		const combined$ = combine$(first$, second$);
		const values: any[] = [];
		subscribe(combined$, (value: any) => values.push(value));
		push(first$, 2n);
		expect(values).to.deep.equal([[1n, 'a'], [2n, 'a']]);
	});
});

//#endregion Stream