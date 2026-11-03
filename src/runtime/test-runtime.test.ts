import { expect } from 'chai';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { _checkAssumeTest, deepEqual, equal } from './runtime.js';
import { _getLoadFailure, _runTests, _testCall, test, TestLocation, TestResult } from './test-runtime.js';
import { reportAtCaller } from '../test-util.js';

/**
 * Registriert über register und prüft die gemeldeten Ergebnisse von _runTests samt Zählung.
 * Für jedes Ergebnis steht die Fehlschlagsmeldung, bei einem bestandenen Test undefined.
 */
const expectTestRun = reportAtCaller((
	register: () => void,
	failures: (string | undefined)[],
	failedCount: number,
) => {
	register();
	const results: TestResult[] = [];
	const counts = _runTests(result => results.push(result));
	expect(results.map(result => result.failure)).to.deep.equal(failures);
	expect(counts).to.deep.equal({ testCount: failures.length, failedCount: failedCount, skippedCount: 0 });
});

/**
 * Registriert über register, führt nur die Tests mit einem der filterNames aus und prüft die Namen
 * der gemeldeten Ergebnisse samt Zahl der übersprungenen.
 */
const expectFilteredRun = reportAtCaller((
	register: () => void,
	filterNames: string[],
	names: string[],
	skippedCount: number,
) => {
	register();
	const results: TestResult[] = [];
	const counts = _runTests(result => results.push(result), filterNames);
	expect(results.map(result => result.name)).to.deep.equal(names);
	expect(counts).to.deep.equal({ testCount: names.length, failedCount: 0, skippedCount: skippedCount });
});

/**
 * Registriert über register und prüft die Stelle der Exception des einzigen Tests.
 */
const expectFailureLocation = reportAtCaller((
	register: () => void,
	failureLocation: TestLocation | undefined,
) => {
	register();
	const results: TestResult[] = [];
	_runTests(result => results.push(result));
	expect(results.map(result => result.failureLocation)).to.deep.equal([failureLocation]);
});

const location = { file: 'a.test.jul', row: 3, column: 1 };

describe('_runTests', () => {
	it('passes-on-true', () => {
		expectTestRun(
			() => test('a', () => true, location),
			[undefined],
			0);
	});
	// Wie beim Branching gilt nur true, nicht jeder truthy Wert.
	it('fails-on-truthy-value', () => {
		expectTestRun(
			() => test('a', () => 5n, location),
			['returned 5'],
			1);
	});
	it('names-arguments-of-instrumented-call', () => {
		expectTestRun(
			() => test('a', () => _testCall('equal', equal, [1n, 2n]), location),
			['equal(1 2) returned false'],
			1);
	});
	it('formats-collections-in-jul-notation', () => {
		expectTestRun(
			() => test('a', () => _testCall('deepEqual', deepEqual, [[1n, 'x'], { b: 2n }]), location),
			['deepEqual([1 §x§] [b = 2]) returned false'],
			1);
	});
	it('reports-exception-and-continues', () => {
		expectTestRun(
			() => {
				test('a', () => { throw new Error('kaputt'); }, location);
				test('b', () => true, location);
			},
			['threw kaputt', undefined],
			1);
	});
	// Mit Source Maps steht die .jul-Stelle im Stack. Frames davor (Runtime) zählen nicht.
	it('reports-jul-location-of-exception', () => {
		const error = new Error('kaputt');
		error.stack = [
			'Error: kaputt',
			`    at _callFunction (${pathToFileURL(resolve('out/runtime.js')).href}:10:5)`,
			`    at fibonacci (${pathToFileURL(resolve('src/fibonacci.jul')).href}:4:3)`,
			`    at test (${pathToFileURL(resolve('fibonacci.test.jul')).href}:2:1)`,
		].join('\n');
		expectFailureLocation(
			() => test('a', () => { throw error; }, location),
			{ file: join('src', 'fibonacci.jul'), row: 4, column: 3 });
	});
	it('reports-jul-location-of-exception-with-windows-path', () => {
		const error = new Error('kaputt');
		error.stack = `Error: kaputt\n    at fibonacci (${resolve('fibonacci.jul')}:4:3)`;
		expectFailureLocation(
			() => test('a', () => { throw error; }, location),
			{ file: 'fibonacci.jul', row: 4, column: 3 });
	});
	// Die Stelle steht nicht mehr in der Meldung, die setzt erst die Ausgabe zusammen.
	it('keeps-failure-text-without-location', () => {
		const error = new Error('kaputt');
		error.stack = `Error: kaputt
    at fibonacci (${resolve('fibonacci.jul')}:4:3)`;
		expectTestRun(
			() => test('a', () => { throw error; }, location),
			['threw kaputt'],
			1);
	});
	// Eine .jul-Stelle in der Meldung selbst ist kein Frame.
	it('ignores-jul-location-in-message', () => {
		const error = new Error('a.jul:1:1');
		error.stack = 'Error: a.jul:1:1\n    at f (C:\\x\\runtime.js:1:1)';
		expectFailureLocation(
			() => test('a', () => { throw error; }, location),
			undefined);
	});
	it('reports-name-and-location', () => {
		test('a', () => false, location);
		const results: TestResult[] = [];
		_runTests(result => results.push(result));
		expect(results.map(({ durationMs, ...result }) => result)).to.deep.equal([{ name: 'a', location: location, failure: 'returned false' }]);
	});
	it('reports-duration', () => {
		test('a', () => true, location);
		const results: TestResult[] = [];
		_runTests(result => results.push(result));
		expect(results[0]!.durationMs).to.be.a('number').and.at.least(0);
	});
	// Das Register wird geleert, ein zweiter Lauf wiederholt nichts.
	it('runs-each-test-once', () => {
		test('a', () => true, location);
		_runTests(() => { });
		expectTestRun(() => { }, [], 0);
	});
	it('runs-only-tests-with-name', () => {
		expectFilteredRun(
			() => {
				test('a', () => true, location);
				test('b', () => true, location);
			},
			['b'],
			['b'],
			1);
	});
	it('runs-tests-with-any-of-the-names', () => {
		expectFilteredRun(
			() => {
				test('a', () => true, location);
				test('b', () => true, location);
				test('c', () => true, location);
			},
			['a', 'c'],
			['a', 'c'],
			1);
	});
	// In verschiedenen Dateien dürfen Namen gleich sein, ausgeführt werden dann alle gleichnamigen.
	it('runs-all-tests-with-same-name', () => {
		expectFilteredRun(
			() => {
				test('a', () => true, location);
				test('b', () => true, location);
				test('a', () => true, location);
			},
			['a'],
			['a', 'a'],
			1);
	});
	// Kein Teilstring-Treffer: 'a' wählt 'ab' nicht aus.
	it('matches-name-exactly', () => {
		expectFilteredRun(
			() => test('ab', () => true, location),
			['a'],
			[],
			1);
	});
	// Das Register wird auch ohne Treffer geleert.
	it('clears-skipped-tests', () => {
		test('a', () => true, location);
		_runTests(() => { }, ['b']);
		expectTestRun(() => { }, [], 0);
	});
});

describe('_runTests mit assume', () => {
	const violatingCall = () => _checkAssumeTest(undefined, value => value !== undefined, 'b.jul', 7, 2, 'GameCard');
	it('meldet einen Bruch mit Wert und behauptetem Typ', () => {
		expectTestRun(
			() => test('a', () => violatingCall() === 1n, location),
			['assume violated: [] is not GameCard'],
			1);
	});
	it('meldet die Stelle des assume', () => {
		expectFailureLocation(
			() => test('a', () => violatingCall() === 1n, location),
			{ file: 'b.jul', row: 7, column: 2 });
	});
	// JS-Code kann die Exception abfangen, der Test liefert dann true.
	it('ein abgefangener Bruch lässt den Test trotzdem fehlschlagen', () => {
		expectTestRun(
			() => test('a', () => {
				try {
					violatingCall();
				}
				catch {
				}
				return true;
			}, location),
			['assume violated: [] is not GameCard'],
			1);
	});
	it('der nächste Test startet ohne den Bruch', () => {
		expectTestRun(
			() => {
				test('a', () => violatingCall() === 1n, location);
				test('b', () => true, location);
			},
			['assume violated: [] is not GameCard', undefined],
			1);
	});
	// Ein Bruch beim Laden der Module gehört zu keinem Test.
	it('ein Bruch vor dem Lauf zählt nicht für den ersten Test', () => {
		expect(violatingCall).to.throw();
		expectTestRun(
			() => test('a', () => true, location),
			[undefined],
			0);
	});
	it('kürzt einen langen Wert', () => {
		const value = { text: 'x'.repeat(300) };
		expectTestRun(
			() => test('a', () => _checkAssumeTest(value, () => false, 'b.jul', 1, 1, 'Integer') === 1n, location),
			[`assume violated: [text = §${'x'.repeat(191)}… is not Integer`],
			1);
	});
});

describe('_getLoadFailure', () => {
	it('meldet ein verletztes assume beim Laden mit seiner Stelle', () => {
		let error: unknown;
		try {
			_checkAssumeTest(undefined, value => value !== undefined, 'b.jul', 7, 2, 'GameCard');
		}
		catch (thrown) {
			error = thrown;
		}
		expect(_getLoadFailure(error)).to.deep.equal({
			failure: 'assume violated: [] is not GameCard',
			failureLocation: { file: 'b.jul', row: 7, column: 2 },
		});
	});
	it('meldet eine andere Exception wie ein Test', () => {
		expect(_getLoadFailure(new Error('kaputt'))).to.deep.equal({ failure: 'threw kaputt' });
	});
});
