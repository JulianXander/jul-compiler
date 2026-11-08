import { expect } from 'chai';
import { reportAtCaller } from '../test-util.js';
import {
	_branch, _checkAssume, _checkAssumeTest, _combineObject, _createFunction, _takeAssumeViolation, add, addDate, and, combine$, combineTexts, compareOrdinal, complete, splitText,
	completed$, create$, deepEqual, delay$, divide, findFirstIndex, findLastIndex, flatten, getElement, GreaterInteger, httpTextRequest$, Integer, LessInteger, multiply, or, parseJson, push, rationalToFloat, removeField, roundUp, floatToInteger,
	regex, setElement, sort, subscribe, subtract, take$, takeUntil$, interval$, toJson, _julTypeSymbol, _optionalField, _Text, Or,
	_addInteger, _subtractInteger, _multiplyInteger, _toCanonicalInteger, _isInteger, _fromTs, _isOfType, Float, length, range, modulo,
} from './runtime.js';

//#region kanonische Integer

// docs/backlog/integer-als-number.md: number im sicheren Bereich, sonst bigint
describe('kanonische Integer', () => {
	const maxSafe = Number.MAX_SAFE_INTEGER;
	const maxSafeBig = BigInt(maxSafe);
	const isCanonical = (value: unknown) => typeof value === 'number'
		? Number.isSafeInteger(value) && !Object.is(value, -0)
		: typeof value === 'bigint' && (value > maxSafeBig || value < -maxSafeBig);
	it('normalisiert bigint im sicheren Bereich zu number', () => {
		expect(_toCanonicalInteger(5n)).to.equal(5);
		expect(_toCanonicalInteger(maxSafeBig)).to.equal(maxSafe);
		expect(_toCanonicalInteger(maxSafeBig + 1n)).to.equal(maxSafeBig + 1n);
		expect(_toCanonicalInteger(-maxSafeBig - 1n)).to.equal(-maxSafeBig - 1n);
	});
	it('rechnet über die Grenze exakt und kehrt zurück', () => {
		expect(_addInteger(maxSafe, 1)).to.equal(maxSafeBig + 1n);
		expect(_subtractInteger(maxSafeBig + 1n, 1)).to.equal(maxSafe);
		expect(_multiplyInteger(maxSafe, 2)).to.equal(maxSafeBig * 2n);
		expect(_subtractInteger(-maxSafe, 1)).to.equal(-maxSafeBig - 1n);
	});
	it('liefert keine negative Null', () => {
		expect(Object.is(_multiplyInteger(-1, 0), 0)).to.equal(true);
		expect(Object.is(modulo(-4, 2), 0)).to.equal(true);
	});
	it('stimmt um die Grenze mit einer bigint-Referenz überein', () => {
		const samples = [0n, 1n, -1n, 2n, 1000n, maxSafeBig - 2n, maxSafeBig - 1n, maxSafeBig, maxSafeBig + 1n, maxSafeBig * 3n, 2n ** 60n];
		const values = [...samples, ...samples.map(sample => -sample)];
		for (const first of values) {
			for (const second of values) {
				const canonicalFirst = _toCanonicalInteger(first);
				const canonicalSecond = _toCanonicalInteger(second);
				for (const [result, expected] of [
					[_addInteger(canonicalFirst, canonicalSecond), first + second],
					[_subtractInteger(canonicalFirst, canonicalSecond), first - second],
					[_multiplyInteger(canonicalFirst, canonicalSecond), first * second],
				] as const) {
					expect(isCanonical(result), `${first} ${second}: ${String(result)}`).to.equal(true);
					expect(BigInt(result), `${first} ${second}`).to.equal(expected);
				}
			}
		}
	});
	it('2.5 ist kein Integer, eine ganzzahlige number erfüllt Integer und Float', () => {
		expect(_isInteger(2)).to.equal(true);
		expect(_isInteger(2.5)).to.equal(false);
		expect(_isInteger(2n ** 60n)).to.equal(true);
		expect(_isOfType(2, Integer)).to.equal(true);
		expect(_isOfType(2, Float)).to.equal(true);
		expect(_isOfType(2.5, Integer)).to.equal(false);
	});
	it('Listen liefern Längen und Indizes als number', () => {
		expect(length([1, 2, 3])).to.equal(3);
		expect(getElement([7, 8], 2)).to.equal(8);
		expect(getElement([7, 8], 2n ** 60n)).to.equal(undefined);
		expect(range(1, 3)).to.deep.equal([1, 2, 3]);
		expect(range(maxSafeBig, maxSafeBig + 1n)).to.deep.equal([maxSafe, maxSafeBig + 1n]);
	});
});

describe('_fromTs', () => {
	it('wandelt Argumente nach bigint und das Ergebnis kanonisch', () => {
		const tsFunction = (value: bigint) => ({ next: value + 1n, text: typeof value });
		const wrapped = _fromTs(tsFunction, ['f', ['i'], null, ['d', { next: 'i' }]]);
		expect(wrapped(41)).to.deep.equal({ next: 42, text: 'bigint' });
	});
	it('wandelt Callbacks in Gegenrichtung', () => {
		const tsFunction = (callback: (value: bigint) => bigint) => callback(2n);
		const wrapped = _fromTs(tsFunction, ['f', [['f', ['i'], null, 'i']], null, 'i']);
		expect(wrapped((value: unknown) => {
			expect(value).to.equal(2);
			return 3;
		})).to.equal(3);
	});
	it('lässt Werte ohne Integer und leere Werte unverändert', () => {
		const wrapped = _fromTs((value: bigint | undefined) => value, ['f', ['i'], null, 'i']);
		expect(wrapped(undefined)).to.equal(undefined);
		expect(wrapped('text')).to.equal('text');
	});
});

//#endregion kanonische Integer

//#region _branch

describe('_branch', () => {
	// Ein rest ohne Typ darf nicht wie ein Typfehler behandelt werden (CHECKER-AUDIT.md #4).
	it('matches a branch with an untyped rest parameter', () => {
		const branch = _createFunction(
			(...args: unknown[]) => args,
			{ rest: {} },
		);
		const result = _branch([1, 2], branch);
		expect(result).to.deep.equal([1, 2]);
	});
});

describe('Prädikat als Typ', () => {
	const fallback = _createFunction(() => 'fallback', {});
	const branchWithType = (type: unknown) => _createFunction(
		() => 'matched',
		{ singleNames: [{ name: 'x', type: type as any }] },
	);
	// Ein truthy Ergebnis wie 5 oder ein Error ist kein true.
	it('matches only on true', () => {
		const predicate = _createFunction(() => 5, { singleNames: [{ name: 'x' }] });
		expect(_branch([1], branchWithType(predicate), fallback)).to.equal('fallback');
	});
	// Der Parametertyp des Prädikats gehört zu dem, was es beschreibt.
	it('checks the parameter type of the predicate', () => {
		const predicate = _createFunction(() => true, { singleNames: [{ name: 'x', type: Integer }] });
		expect(_branch(['a'], branchWithType(predicate), fallback)).to.equal('fallback');
	});
	// Eine Funktion mit Typ-Kopf wie [Integer] => true bekommt ihr Argument nicht positional,
	// sondern über ihre Parameterbindung.
	it('binds the value to a predicate with a type head', () => {
		const predicate = _createFunction(() => true, { type: [Integer] });
		expect(_branch(['a'], branchWithType(predicate), fallback)).to.equal('fallback');
		expect(_branch([1], branchWithType(predicate), fallback)).to.equal('matched');
	});
	// Ein Kopf aus Positionen ([Integer] => …) nennt nur die Argumente, die er braucht: Er prüft sie
	// der Reihe nach und lässt weitere zu. Das unterscheidet ihn von einem Typ-Kopf (`type`), der die
	// ganze Argumentkollektion beschreibt.
	describe('Kopf aus Positionen', () => {
		const headBranch = (...head: unknown[]) => _createFunction(() => 'matched', { head: head as any });
		it('matches the named position', () => {
			expect(_branch([1], headBranch(Integer), fallback)).to.equal('matched');
		});
		it('does not match another type at the named position', () => {
			expect(_branch(['a'], headBranch(Integer), fallback)).to.equal('fallback');
		});
		it('allows more arguments than positions', () => {
			expect(_branch([1, 'a'], headBranch(Integer), fallback)).to.equal('matched');
		});
		it('checks only the named positions', () => {
			expect(_branch(['a', 1], headBranch(Integer), fallback)).to.equal('fallback');
		});
		it('does not match fewer arguments than positions', () => {
			expect(_branch([1], headBranch(Integer, Integer), fallback)).to.equal('fallback');
		});
		it('does not match a dictionary', () => {
			expect(_branch({ a: 1 }, headBranch(Integer), fallback)).to.equal('fallback');
		});
		it('binds nothing', () => {
			const branch = _createFunction((...bound: unknown[]) => bound.length, { head: [Integer] });
			expect(_branch([1, 2], branch, fallback)).to.equal(0);
		});
		it('gives a predicate its value', () => {
			const predicate = _createFunction(() => true, { head: [Integer] });
			expect(_branch(['a'], branchWithType(predicate), fallback)).to.equal('fallback');
			expect(_branch([1], branchWithType(predicate), fallback)).to.equal('matched');
		});
	});
	// Eine JS-Funktion ohne Parameterbindung wird weiter direkt aufgerufen.
	it('calls a plain JS function directly', () => {
		const predicate = (value: unknown) => value === 1;
		expect(_branch([1], branchWithType(predicate), fallback)).to.equal('matched');
		expect(_branch([2], branchWithType(predicate), fallback)).to.equal('fallback');
	});
});

describe('Grenze als Typ', () => {
	const fallback = _createFunction(() => 'fallback', {});
	const branchWithType = (type: unknown) => _createFunction(
		() => 'matched',
		{ singleNames: [{ name: 'x', type: type as any }] },
	);
	it('matches an integer below the bound', () => {
		expect(_branch([-1], branchWithType(LessInteger(0)), fallback)).to.equal('matched');
	});
	it('does not match the bound itself', () => {
		expect(_branch([0], branchWithType(LessInteger(0)), fallback)).to.equal('fallback');
	});
	// -1f ist kleiner als 0, gehört aber nicht zur Familie Integer.
	it('does not match a float', () => {
		expect(_branch([-1.5], branchWithType(LessInteger(0)), fallback)).to.equal('fallback');
	});
	it('matches an integer above the bound', () => {
		expect(_branch([1], branchWithType(GreaterInteger(0)), fallback)).to.equal('matched');
	});
});

describe('Record als Typ', () => {
	const fallback = _createFunction(() => 'fallback', {});
	const recordType = { [_julTypeSymbol]: 'dictionaryLiteral', Fields: { a: Integer } };
	const branchWithType = _createFunction(
		() => 'matched',
		{ singleNames: [{ name: 'x', type: recordType as any }] },
	);
	it('matches exactly the named fields', () => {
		expect(_branch([{ a: 1 }], branchWithType, fallback)).to.equal('matched');
	});
	// Ein Record-Typ ist geschlossen: ein weiterer Schlüssel mit Wert passt nicht.
	it('does not match a surplus field with a value', () => {
		expect(_branch([{ a: 1, b: 2 }], branchWithType, fallback)).to.equal('fallback');
	});
	// Ein Schlüssel mit undefined ist dasselbe wie ein fehlender.
	it('matches a surplus field with undefined', () => {
		expect(_branch([{ a: 1, b: undefined }], branchWithType, fallback)).to.equal('matched');
	});
	// b?: Text: der Schlüssel darf fehlen, ist er da, muss der Wert zum Typ passen.
	it('matches an optional field that is missing', () => {
		const optionalType = { [_julTypeSymbol]: 'dictionaryLiteral', Fields: { a: Integer, b: _optionalField(_Text) } };
		const branch = _createFunction(() => 'matched', { singleNames: [{ name: 'x', type: optionalType as any }] });
		expect(_branch([{ a: 1 }], branch, fallback)).to.equal('matched');
		expect(_branch([{ a: 1, b: 's' }], branch, fallback)).to.equal('matched');
	});
	// Ein Pflichtfeld muss als Schlüssel da sein, auch wenn sein Typ Empty zulässt.
	it('does not match a missing key of a required field that allows empty', () => {
		const emptyType = { [_julTypeSymbol]: 'dictionaryLiteral', Fields: { a: Integer, b: Or(undefined, _Text) } };
		const branch = _createFunction(() => 'matched', { singleNames: [{ name: 'x', type: emptyType as any }] });
		expect(_branch([{ a: 1 }], branch, fallback)).to.equal('fallback');
		expect(_branch([{ a: 1, b: undefined }], branch, fallback)).to.equal('matched');
		expect(_branch([{ a: 1, b: 's' }], branch, fallback)).to.equal('matched');
	});
	it('does not match an optional field with the wrong value or with undefined', () => {
		const optionalType = { [_julTypeSymbol]: 'dictionaryLiteral', Fields: { a: Integer, b: _optionalField(_Text) } };
		const branch = _createFunction(() => 'matched', { singleNames: [{ name: 'x', type: optionalType as any }] });
		expect(_branch([{ a: 1, b: 2 }], branch, fallback)).to.equal('fallback');
		expect(_branch([{ a: 1, b: undefined }], branch, fallback)).to.equal('fallback');
	});
});

//#endregion _branch

//#region assume

describe('_checkAssume', () => {
	beforeEach(() => {
		_takeAssumeViolation();
	});
	it('gibt einen passenden Wert identisch zurück', () => {
		const value = { a: 1 };
		const recordType = { [_julTypeSymbol]: 'dictionaryLiteral', Fields: { a: Integer } };
		expect(_checkAssume(value, recordType as any, 'a.jul', 2, 3, '[a: Integer]')).to.equal(value);
		expect(_takeAssumeViolation()).to.equal(undefined);
	});
	it('wirft bei einem unpassenden Wert und merkt sich Wert und Stelle', () => {
		expect(() => _checkAssume('x', Integer, 'a.jul', 2, 3, 'Integer'))
			.to.throw('assume violated: value is not Integer (a.jul:2:3)');
		expect(_takeAssumeViolation()).to.deep.equal({ value: 'x', file: 'a.jul', row: 2, column: 3, typeText: 'Integer' });
	});
	// Nur der erste Bruch zählt, und nach dem Abholen ist keiner mehr da.
	it('behält den ersten Bruch bis zum Abholen', () => {
		expect(() => _checkAssume('x', Integer, 'a.jul', 2, 3, 'Integer')).to.throw();
		expect(() => _checkAssume('y', Integer, 'a.jul', 5, 1, 'Integer')).to.throw();
		expect(_takeAssumeViolation()?.value).to.equal('x');
		expect(_takeAssumeViolation()).to.equal(undefined);
	});
});

describe('_checkAssumeTest', () => {
	beforeEach(() => {
		_takeAssumeViolation();
	});
	it('gibt den Wert zurück, wenn der Test passt', () => {
		expect(_checkAssumeTest(1, value => value !== undefined, 'a.jul', 1, 1, 'Integer')).to.equal(1);
	});
	it('wirft, wenn der Test nicht passt', () => {
		expect(() => _checkAssumeTest(undefined, value => value !== undefined, 'a.jul', 1, 1, 'Integer'))
			.to.throw('assume violated: value is not Integer (a.jul:1:1)');
		expect(_takeAssumeViolation()).to.deep.equal({ value: undefined, file: 'a.jul', row: 1, column: 1, typeText: 'Integer' });
	});
});

//#endregion assume

//#region parseJson

const expectParseJson = reportAtCaller((json: string, result?: any) => {
	const parserResult = parseJson(json);
	expect(parserResult).to.deep.equal(result);
});
// Die Meldung hängt von der JS-Engine ab und wird deshalb nicht geprüft
const expectParseJsonError = reportAtCaller((json: string) => {
	expect(parseJson(json)).to.be.instanceOf(Error);
});

describe('parseJson', () => {
	// null und leere Kollektionen werden zu Empty, vgl. Prinzip 6
	it('null', () => {
		expectParseJson('null', undefined);
	});
	it('true', () => {
		expectParseJson('true', true);
	});
	it('false', () => {
		expectParseJson('false', false);
	});
	it('12', () => {
		expectParseJson('12', 12);
	});
	it('12.3', () => {
		expectParseJson('12.3', { numerator: 123, denominator: 10 });
	});
	it('-12.3', () => {
		expectParseJson('-12.3', { numerator: -123, denominator: 10 });
	});
	it('-12.3e-4', () => {
		expectParseJson('-12.3e-4', { numerator: -123, denominator: 100000 });
	});
	it('-12.3e+4', () => {
		expectParseJson('-12.3e+4', -123000);
	});
	it('"12"', () => {
		expectParseJson('"12"', '12');
	});
	it('   "12"  	\n\r', () => {
		expectParseJson('   "12"  	\n\r', '12');
	});
	it('"\\\\"', () => {
		expectParseJson('"\\\\"', '\\');
	});
	it('"\\u1234"', () => {
		expectParseJson('"\\u1234"', 'ሴ');
	});
	it('[  ]', () => {
		expectParseJson('[  ]', undefined);
	});
	it('[1]', () => {
		expectParseJson('[1]', [1]);
	});
	it('{"a":"b"}', () => {
		expectParseJson('{"a":"b"}', { a: 'b' });
	});
	it('[{"a":"b"}]', () => {
		expectParseJson('[{"a":"b"}]', [{ a: 'b' }]);
	});
	it('{}', () => {
		expectParseJson('{}', undefined);
	});
	// Das Feld bleibt mit Empty erhalten: der Import einer .json-Datei macht daraus ein
	// Dictionary-Feld, fehlte es, wäre der Zugriff darauf ein Typfehler.
	// deep.equal unterscheidet bei Objekten fehlenden Schlüssel und undefined.
	it('{"a":null}', () => {
		expectParseJson('{"a":null}', { a: undefined });
	});
	it('{"a":[]}', () => {
		expectParseJson('{"a":[]}', { a: undefined });
	});
	it('{"a":{}}', () => {
		expectParseJson('{"a":{}}', { a: undefined });
	});
	it('{"a":{"b":null}}', () => {
		expectParseJson('{"a":{"b":null}}', { a: { b: undefined } });
	});
	it('[1,null,2]', () => {
		const result = parseJson('[1,null,2]');
		expect(result).to.deep.equal([1, undefined, 2]);
		// deep.equal hält eine Lücke im Array für gleich
		expect(1 in (result as unknown[])).to.be.true;
	});
	// Fractions werden gekürzt wie Zahlenliterale in JUL
	it('0.5', () => {
		expectParseJson('0.5', { numerator: 1, denominator: 2 });
	});
	it('1.50', () => {
		expectParseJson('1.50', { numerator: 3, denominator: 2 });
	});
	it('2.0', () => {
		expectParseJson('2.0', 2);
	});
	it('-2.5e-1', () => {
		expectParseJson('-2.5e-1', { numerator: -1, denominator: 4 });
	});
	it('1e3', () => {
		expectParseJson('1e3', 1000);
	});
	it('-0', () => {
		expectParseJson('-0', 0);
	});
	it('12345678901234567890', () => {
		expectParseJson('12345678901234567890', 12345678901234567890n);
	});
	it('"a\\r\\nb"', () => {
		expectParseJson('"a\\r\\nb"', 'a\r\nb');
	});
	it('{"a":}', () => {
		expectParseJsonError('{"a":}');
	});
	it('[1,', () => {
		expectParseJsonError('[1,');
	});
	it("'x'", () => {
		expectParseJsonError("'x'");
	});
	// Steuerzeichen müssen in JSON-Strings escaped sein
	it('"a<U+0001>b"', () => {
		expectParseJsonError('"a\u0001b"');
	});
	it('"a<Zeilenumbruch>b"', () => {
		expectParseJsonError('"a\nb"');
	});
	it('"\\x"', () => {
		const result = parseJson('"\\x"');
		expect(result).to.be.instanceOf(Error);
		expect((result as Error).message).to.not.be.empty;
	});
	// Der Schlüssel darf nicht den Prototyp setzen, sonst verändert fremdes JSON (z.B. eine
	// HTTP-Antwort) das Verhalten des Objekts
	it('{"__proto__":{"a":1}}', () => {
		const result = parseJson('{"__proto__":{"a":1}}');
		expect(Object.getPrototypeOf(result)).to.equal(Object.prototype);
		expect(Object.keys(result as object)).to.deep.equal(['__proto__']);
		expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).to.deep.equal({ a: 1 });
	});
});

//#endregion parseJson

//#region toJson

const expectToJson = reportAtCaller((value: any, result: string) => {
	expect(toJson(value)).to.equal(result);
});

describe('toJson', () => {
	it('null', () => expectToJson(undefined, 'null'));
	it('true', () => expectToJson(true, 'true'));
	it('12', () => expectToJson(12, '12'));
	it('"ab"', () => expectToJson('ab', '"ab"'));
	it('[1,2]', () => expectToJson([1, 2], '[1,2]'));
	it('{"a":"b"}', () => expectToJson({ a: 'b' }, '{"a":"b"}'));
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
		expect(add(2, 3)).to.equal(5);
	});
	it('adds an integer and a fraction', () => {
		expect(add(1, { numerator: 1, denominator: 2 })).to.deep.equal({ numerator: 3, denominator: 2 });
	});
});

describe('subtract', () => {
	it('subtracts two integers', () => {
		expect(subtract(5, 3)).to.equal(2);
	});
	it('subtracts a fraction from an integer', () => {
		expect(subtract(1, { numerator: 1, denominator: 2 })).to.deep.equal({ numerator: 1, denominator: 2 });
	});
});

// Brüche werden beim Rechnen nicht gekürzt (TODO in add/subtract/multiply), deshalb hängt
// der Bruch vom Rechenweg ab statt vom Wert: 0.25+0.25 und 0.5 sind mathematisch gleich, aber
// strukturell verschieden - deepEqual sagt false. Sobald das Ergebnis als Literaltyp in den
// Checker zurückfließt (constant folding), bricht das die Annahme 'gleiche Werte, gleiche
// Typen'. Ein Bruch mit Nenner 1 wird zum Integer normalisiert, vgl. Rational = Or(Integer Fraction).
describe('Bruch kuerzen', () => {
	const half = { numerator: 1, denominator: 2 };
	const quarter = { numerator: 1, denominator: 4 };
	it('add kuerzt das Ergebnis', () => {
		expect(add(quarter, quarter)).to.deep.equal(half);
	});
	it('add normalisiert einen ganzzahligen Bruch zum Integer', () => {
		expect(add(half, half)).to.equal(1);
	});
	it('subtract kuerzt das Ergebnis', () => {
		expect(subtract({ numerator: 3, denominator: 4 }, quarter)).to.deep.equal(half);
	});
	it('multiply kuerzt das Ergebnis', () => {
		expect(multiply(half, { numerator: 2, denominator: 3 })).to.deep.equal({ numerator: 1, denominator: 3 });
	});
	it('deepEqual gleicher Werte ist true', () => {
		expect(deepEqual(add(quarter, quarter), half)).to.equal(true);
	});
});

describe('divide', () => {
	const half = { numerator: 1, denominator: 2 };
	it('divides two integers exactly', () => {
		expect(divide(1, 2)).to.deep.equal(half);
	});
	it('returns an integer for a whole result', () => {
		expect(divide(6, 3)).to.equal(2);
	});
	it('divides an integer by a fraction', () => {
		expect(divide(1, half)).to.equal(2);
	});
	it('divides a fraction by an integer', () => {
		expect(divide(half, 2)).to.deep.equal({ numerator: 1, denominator: 4 });
	});
	it('divides two fractions and reduces the result', () => {
		expect(divide(half, { numerator: 3, denominator: 4 })).to.deep.equal({ numerator: 2, denominator: 3 });
	});
	it('keeps the sign in the numerator for a negative divisor', () => {
		expect(divide(1, -2)).to.deep.equal({ numerator: -1, denominator: 2 });
	});
	it('divides zero to zero', () => {
		expect(divide(0, 5)).to.equal(0);
	});
});

describe('roundUp', () => {
	const fraction = (numerator: number, denominator: number) => ({ numerator, denominator });
	it('returns an integer unchanged', () => {
		expect(roundUp(3)).to.equal(3);
	});
	it('rounds a positive fraction up', () => {
		expect(roundUp(fraction(1, 2))).to.equal(1);
	});
	it('rounds a negative fraction up towards zero', () => {
		expect(roundUp(fraction(-3, 2))).to.equal(-1);
	});
	it('rounds a negative fraction between -1 and 0 to zero', () => {
		expect(roundUp(fraction(-1, 2))).to.equal(0);
	});
	it('handles a negative denominator', () => {
		expect(roundUp(fraction(1, -2))).to.equal(0);
	});
	it('handles a negative numerator and denominator', () => {
		expect(roundUp(fraction(-1, -2))).to.equal(1);
	});
});

describe('rationalToFloat', () => {
	it('converts an integer', () => {
		expect(rationalToFloat(4)).to.equal(4);
	});
	it('converts a fraction', () => {
		expect(rationalToFloat({ numerator: 1, denominator: 4 })).to.equal(0.25);
	});
});

describe('floatToInteger', () => {
	it('rounds down', () => {
		expect(floatToInteger(1.7, 'down')).to.equal(1);
		expect(floatToInteger(-1.2, 'down')).to.equal(-2);
	});
	it('rounds up', () => {
		expect(floatToInteger(1.2, 'up')).to.equal(2);
		expect(floatToInteger(-1.7, 'up')).to.equal(-1);
	});
	it('truncates toward zero', () => {
		expect(floatToInteger(1.7, 'towardZero')).to.equal(1);
		expect(floatToInteger(-1.7, 'towardZero')).to.equal(-1);
	});
	it('rounds half away from zero', () => {
		expect(floatToInteger(2.5, 'nearest')).to.equal(3);
		expect(floatToInteger(-2.5, 'nearest')).to.equal(-3);
		expect(floatToInteger(-2.4, 'nearest')).to.equal(-2);
		expect(floatToInteger(-0.2, 'nearest')).to.equal(0);
	});
	it('keeps integral values and large values exact', () => {
		expect(floatToInteger(4, 'nearest')).to.equal(4);
		expect(floatToInteger(2 ** 60, 'down')).to.equal(2n ** 60n);
	});
});

//#endregion Rational

//#region Any

describe('deepEqual', () => {
	it('compares primitives by value', () => {
		expect(deepEqual(1, 1)).to.equal(true);
	});
	it('compares lists element-wise', () => {
		expect(deepEqual([1, 2], [1, 2])).to.equal(true);
		expect(deepEqual([1, 2], [1, 3])).to.equal(false);
	});
	it('compares dictionaries field-wise', () => {
		expect(deepEqual({ a: 1 }, { a: 1 })).to.equal(true);
		expect(deepEqual({ a: 1 }, { a: 2 })).to.equal(false);
		expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).to.equal(false);
	});
	it('dictionaries with different keys are not equal, even if the values are undefined', () => {
		expect(deepEqual({ a: undefined }, { b: undefined })).to.equal(false);
	});
});

//#endregion Any

//#region List

describe('_combineObject', () => {
	it('concatenates lists and skips empty parts', () => {
		const result = _combineObject(undefined, [1, 2], undefined, [3]);
		expect(result).to.deep.equal([1, 2, 3]);
	});
	// Auch ein einzelner Teil wird kopiert, nicht durchgereicht.
	it('copies a single list part', () => {
		const part = [1, 2];
		const result = _combineObject(part, undefined);
		expect(result).to.deep.equal([1, 2]);
		expect(result).not.to.equal(part);
	});
	it('merges dictionaries, later fields win', () => {
		const result = _combineObject(undefined, { a: 1, b: 2 }, { b: 20, c: 3 });
		expect(result).to.deep.equal({ a: 1, b: 20, c: 3 });
	});
	it('copies a single dictionary part', () => {
		const part = { a: 1 };
		const result = _combineObject(part);
		expect(result).to.deep.equal({ a: 1 });
		expect(result).not.to.equal(part);
	});
	it('returns undefined when all parts are empty', () => {
		expect(_combineObject(undefined, undefined)).to.equal(undefined);
	});
});

describe('flatten', () => {
	it('flattens one level and skips empty inner lists', () => {
		const result = flatten([[1, 2], undefined, [3, [4]]]);
		expect(result).to.deep.equal([1, 2, 3, [4]]);
	});
	it('returns undefined when every inner list is empty', () => {
		expect(flatten([undefined, undefined])).to.equal(undefined);
	});
	it('returns undefined for an empty value', () => {
		expect(flatten(undefined)).to.equal(undefined);
	});
});

describe('findFirstIndex', () => {
	it('finds the index of the first matching element (1-based)', () => {
		const result = findFirstIndex([1, 2, 3, 2], (value: number) => value === 2);
		expect(result).to.equal(2);
	});
	it('returns undefined when nothing matches', () => {
		const result = findFirstIndex([1, 2], (value: number) => value === 9);
		expect(result).to.equal(undefined);
	});
	it('returns undefined for an empty value', () => {
		const result = findFirstIndex(undefined, () => true);
		expect(result).to.equal(undefined);
	});
});

describe('findLastIndex', () => {
	it('finds the index of the last matching element (1-based)', () => {
		const result = findLastIndex([1, 2, 3, 2], (value: number) => value === 2);
		expect(result).to.equal(4);
	});
	it('returns undefined when nothing matches', () => {
		const result = findLastIndex([1, 2], (value: number) => value === 9);
		expect(result).to.equal(undefined);
	});
});

describe('splitText', () => {
	it('zerlegt am Separator', () => {
		expect(splitText('a-b-c', '-')).to.deep.equal(['a', 'b', 'c']);
	});
	it('liefert den ganzen Text, wenn der Separator fehlt', () => {
		expect(splitText('abc', '-')).to.deep.equal(['abc']);
	});
	it('liefert bei leerem Text eine Liste mit einem leeren Text', () => {
		expect(splitText('', '-')).to.deep.equal(['']);
	});
	it('behält leere Teile bei aufeinanderfolgenden Separatoren', () => {
		expect(splitText('a--b', '-')).to.deep.equal(['a', '', 'b']);
	});
	it('zerlegt bei leerem Separator in einzelne Zeichen', () => {
		expect(splitText('abc', '')).to.deep.equal(['a', 'b', 'c']);
	});
});

describe('compareOrdinal', () => {
	it('liefert less, equal und greater', () => {
		expect(compareOrdinal('a', 'b')).to.equal('less');
		expect(compareOrdinal('b', 'b')).to.equal('equal');
		expect(compareOrdinal('c', 'b')).to.equal('greater');
	});
	it('ordnet Großbuchstaben vor Kleinbuchstaben', () => {
		expect(compareOrdinal('B', 'a')).to.equal('less');
	});
	it('vergleicht Ziffern als Text, nicht als Zahl', () => {
		expect(compareOrdinal('a10', 'a2')).to.equal('less');
	});
});

describe('sort', () => {
	const compareNumbers = (first: number, second: number) => first < second
		? 'less'
		: first > second
			? 'greater'
			: 'equal';
	it('sortiert aufsteigend', () => {
		expect(sort([3, 1, 2], compareNumbers)).to.deep.equal([1, 2, 3]);
	});
	it('mutiert die Eingabe nicht', () => {
		const values = [3, 1, 2];
		sort(values, compareNumbers);
		expect(values).to.deep.equal([3, 1, 2]);
	});
	it('ist stabil bei gleichen Schlüsseln', () => {
		const values = [
			{ key: 2, name: 'a' },
			{ key: 1, name: 'b' },
			{ key: 2, name: 'c' },
			{ key: 1, name: 'd' },
		];
		const sorted = sort(values, (first, second) => compareNumbers(first.key, second.key));
		expect(sorted!.map(value => value.name)).to.deep.equal(['b', 'd', 'a', 'c']);
	});
	it('liefert empty für empty', () => {
		expect(sort(undefined, compareNumbers)).to.equal(undefined);
	});
});

/**
 * Die Namen der Einzelparameter, die _createFunction an die Funktion gehängt hat, undefined ohne params.
 */
function getParamNames(fn: Function): string[] | undefined {
	return (fn as { params?: { singleNames?: { name: string; }[]; }; }).params?.singleNames?.map(param => param.name);
}

describe('getElement/setElement', () => {
	it('getElement hat die Parameter values und index', () => {
		expect(getParamNames(getElement)).to.deep.equal(['values', 'index']);
	});
	it('setElement hat die Parameter values, index und value', () => {
		expect(getParamNames(setElement)).to.deep.equal(['values', 'index', 'value']);
	});
});

//#endregion List

//#region Dictionary

describe('removeField', () => {
	it('removes the field and keeps the others', () => {
		const dictionary = { a: 1, b: 2 };
		const result = removeField(dictionary, 'a');
		expect(result).to.deep.equal({ b: 2 });
		expect(dictionary).to.deep.equal({ a: 1, b: 2 });
	});
	it('keeps the content when the key is missing', () => {
		const result = removeField({ a: 1 }, 'x');
		expect(result).to.deep.equal({ a: 1 });
	});
	it('returns undefined when no field is left', () => {
		const result = removeField({ a: 1 }, 'a');
		expect(result).to.equal(undefined);
	});
	it('returns undefined for an empty value', () => {
		const result = removeField(undefined, 'a');
		expect(result).to.equal(undefined);
	});
});

//#endregion Dictionary

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
		const result = addDate(date, 1, 1, 1, undefined, undefined, undefined, undefined);
		expect(result).to.deep.equal(new Date(2021, 1, 2));
	});
});

//#endregion Date

//#region Stream

describe('create$/push/subscribe', () => {
	it('notifies subscribers of pushed values, starting with the initial value', () => {
		const stream$ = create$(undefined, 1);
		const values: bigint[] = [];
		subscribe(stream$, (value: bigint) => values.push(value));
		push(stream$, 2);
		push(stream$, 3);
		expect(values).to.deep.equal([1, 2, 3]);
	});
	it('notifies all listeners even if one unsubscribes during the notification', () => {
		const stream$ = create$(undefined, 1);
		const values: number[] = [];
		const unsubscribe = subscribe(stream$, (value: number) => {
			if (value === 2) {
				unsubscribe();
			}
		});
		subscribe(stream$, (value: number) => values.push(value));
		push(stream$, 2);
		expect(values).to.deep.equal([1, 2]);
	});
});

describe('completed$', () => {
	it('creates an already completed stream with the initial value', () => {
		const stream$: any = completed$(5);
		expect(stream$.completed).to.equal(true);
		expect(stream$.lastValue).to.equal(5);
	});
});

describe('take$', () => {
	it('completes after the given amount of values', () => {
		const source$ = create$(undefined, 1);
		const taken$ = take$(source$, 2);
		const values: bigint[] = [];
		subscribe(taken$, (value: bigint) => values.push(value));
		push(source$, 2);
		push(source$, 3);
		expect(values).to.deep.equal([1, 2, 3]);
		expect((taken$ as any).completed).to.equal(true);
	});
});

describe('takeUntil$', () => {
	it('follows the source until the signal pushes a value', () => {
		const source$ = create$(undefined, 1);
		const signal$ = create$(undefined, 'start');
		const taken$ = takeUntil$(source$, signal$);
		const values: bigint[] = [];
		subscribe(taken$, (value: bigint) => values.push(value));
		push(source$, 2);
		push(signal$, 'stop');
		push(source$, 3);
		expect(values).to.deep.equal([1, 2]);
		expect((taken$ as any).completed).to.equal(true);
	});
	// Nur ein neuer Wert beendet, nicht der, den das Signal beim Anlegen schon hat.
	it('is not ended by the current value of the signal', () => {
		const source$ = create$(undefined, 1);
		const signal$ = create$(undefined, 'start');
		const taken$ = takeUntil$(source$, signal$);
		expect((taken$ as any).completed).to.equal(false);
	});
	it('completes when the signal completes', () => {
		const source$ = create$(undefined, 1);
		const signal$ = create$(undefined, 'start');
		const taken$ = takeUntil$(source$, signal$);
		complete(signal$);
		expect((taken$ as any).completed).to.equal(true);
	});
	it('completes immediately with an already completed signal', () => {
		const source$ = create$(undefined, 1);
		const taken$ = takeUntil$(source$, completed$('stop'));
		expect((taken$ as any).completed).to.equal(true);
	});
	it('completes when the source completes', () => {
		const source$ = create$(undefined, 1);
		const signal$ = create$(undefined, 'start');
		const taken$ = takeUntil$(source$, signal$);
		complete(source$);
		expect((taken$ as any).completed).to.equal(true);
	});
	// Beendet wird nur der neue Stream: die Quelle läuft weiter, hält aber keinen Listener mehr.
	it('unsubscribes from source and signal when ended, without completing the source', () => {
		const source$ = create$(undefined, 1);
		const signal$ = create$(undefined, 'start');
		const taken$ = takeUntil$(source$, signal$);
		subscribe(taken$, () => { });
		push(signal$, 'stop');
		expect((source$ as any).completed).to.equal(false);
		expect((source$ as any).listeners).to.have.length(0);
		expect((signal$ as any).listeners).to.have.length(0);
	});
	// Das Signal kann weitere Abonnenten haben, die denselben Wert erwarten.
	it('lets other subscribers of the signal receive the value that ends it', () => {
		const source$ = create$(undefined, 1);
		const signal$ = create$(undefined, 'start');
		takeUntil$(source$, signal$);
		const values: string[] = [];
		subscribe(signal$, (value: string) => values.push(value));
		push(signal$, 'stop');
		expect(values).to.deep.equal(['start', 'stop']);
	});
});

describe('interval$', () => {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	// Die laufenden Intervalle, ein Tick wird von Hand ausgelöst.
	let activeIntervals: Map<number, () => void>;
	beforeEach(() => {
		activeIntervals = new Map();
		let nextIntervalId = 1;
		globalThis.setInterval = ((callback: () => void) => {
			const intervalId = nextIntervalId++;
			activeIntervals.set(intervalId, callback);
			return intervalId;
		}) as any;
		globalThis.clearInterval = ((intervalId: number) => {
			activeIntervals.delete(intervalId);
		}) as any;
	});
	afterEach(() => {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	});
	const tick = () => {
		[...activeIntervals.values()][0]!();
	};
	it('starts at 0 and counts the elapsed intervals', () => {
		const ticks$ = interval$(1000);
		const values: number[] = [];
		subscribe(ticks$, (value: number) => values.push(value));
		tick();
		tick();
		expect(values).to.deep.equal([0, 1, 2]);
		complete(ticks$);
	});
	it('completes after count intervals', () => {
		const ticks$ = interval$(1000, 2);
		const values: number[] = [];
		subscribe(ticks$, (value: number) => values.push(value));
		tick();
		tick();
		expect(values).to.deep.equal([0, 1, 2]);
		expect((ticks$ as any).completed).to.equal(true);
		expect([...activeIntervals.keys()]).to.deep.equal([]);
	});
	// Mit count 0 ist nichts abzuwarten: Startwert 0, sofort beendet, kein Intervall.
	it('completes immediately with count 0', () => {
		const ticks$ = interval$(1000, 0);
		expect((ticks$ as any).lastValue).to.equal(0);
		expect((ticks$ as any).completed).to.equal(true);
		expect([...activeIntervals.keys()]).to.deep.equal([]);
	});
	it('clears its interval when completed', () => {
		const ticks$ = interval$(1000);
		complete(ticks$);
		expect([...activeIntervals.keys()]).to.deep.equal([]);
	});
	// Beendet ein Listener den Stream beim Tick, läuft das Intervall nicht weiter.
	it('clears its interval when a listener completes it on a tick', () => {
		const ticks$ = interval$(1000);
		subscribe(ticks$, (value: number) => {
			if (value === 1) {
				complete(ticks$);
			}
		});
		tick();
		expect([...activeIntervals.keys()]).to.deep.equal([]);
	});
});

describe('delay$', () => {
	it('starts empty, delivers the value after the delay and completes', async () => {
		const delayed$ = delay$(1, 'value');
		const values: unknown[] = [];
		subscribe(delayed$, (value: unknown) => values.push(value));
		expect(values).to.deep.equal([undefined]);
		await new Promise(resolve => (delayed$ as any).onCompleted(resolve));
		expect(values).to.deep.equal([undefined, 'value']);
	});
	// Früh beendet: kein push auf den beendeten Stream, der Timeout ist gelöscht.
	it('clears the timeout and delivers nothing when completed early', async () => {
		const delayed$ = delay$(1, 'value');
		const values: unknown[] = [];
		subscribe(delayed$, (value: unknown) => values.push(value));
		complete(delayed$);
		await new Promise(resolve => setTimeout(resolve, 5));
		expect(values).to.deep.equal([undefined]);
	});
});

describe('httpTextRequest$', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});
	// Ein Server, der nie antwortet: fetch endet erst, wenn die Anfrage abgebrochen wird.
	function fetchNeverAnswering(): typeof fetch {
		return (_input, init) => new Promise((_resolve, reject) => {
			init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
		});
	}
	it('ends with an error when no answer arrives within the timeout', async () => {
		globalThis.fetch = fetchNeverAnswering();
		const response$ = httpTextRequest$('https://example.org', 'get', 1, undefined, undefined);
		await new Promise(resolve => (response$ as any).onCompleted(resolve));
		const value = (response$ as any).lastValue;
		expect(value).to.be.instanceOf(Error);
		expect(value.message).to.equal('Timeout after 1 ms');
	});
	it('delivers the answer that arrives before the timeout', async () => {
		globalThis.fetch = async () => new Response('answer');
		const response$ = httpTextRequest$('https://example.org', 'get', 1000, undefined, undefined);
		await new Promise(resolve => (response$ as any).onCompleted(resolve));
		expect((response$ as any).lastValue).to.equal('answer');
	});
});

describe('combine$', () => {
	it('combines the latest values of all sources', () => {
		const first$ = create$(undefined, 1);
		const second$ = create$(undefined, 'a');
		const combined$ = combine$(first$, second$);
		const values: any[] = [];
		subscribe(combined$, (value: any) => values.push(value));
		push(first$, 2);
		expect(values).to.deep.equal([[1, 'a'], [2, 'a']]);
	});
	it('completes when all sources complete', () => {
		const first$ = create$(undefined, 1);
		const second$ = create$(undefined, 'a');
		const combined$ = combine$(first$, second$);
		complete(first$);
		expect((combined$ as any).completed).to.equal(false);
		complete(second$);
		expect((combined$ as any).completed).to.equal(true);
	});
	// Ohne Quellen enden alle Quellen von Anfang an, der Stream liefert seinen Wert und ist beendet.
	it('delivers its value and completes without sources', () => {
		const combined$ = combine$();
		const values: any[] = [];
		subscribe(combined$, (value: any) => values.push(value));
		expect(values).to.deep.equal([[]]);
		expect((combined$ as any).completed).to.equal(true);
	});
});

//#endregion Stream
