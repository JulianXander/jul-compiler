import { expect } from 'chai';
import { deepEqual, equal } from './runtime.js';
import { _runTests, _testCall, test } from './test-runtime.js';
import { reportAtCaller } from './test-util.js';

/**
 * Registriert über register und prüft die Ausgabe von _runTests samt Ergebnis.
 */
const expectTestRun = reportAtCaller((register: () => void, lines: string[], passed: boolean) => {
	register();
	const output: string[] = [];
	expect(_runTests(line => output.push(line))).to.equal(passed);
	expect(output).to.deep.equal(lines);
});

const location = { file: 'a.test.jul', row: 3, column: 1 };

describe('_runTests', () => {
	it('passes-on-true', () => {
		expectTestRun(
			() => test('a', () => true, location),
			['✓ a', '1 test, 0 failed'],
			true);
	});
	// Wie beim Branching gilt nur true, nicht jeder truthy Wert.
	it('fails-on-truthy-value', () => {
		expectTestRun(
			() => test('a', () => 5n, location),
			['✗ a (a.test.jul:3:1)', '    returned 5', '1 test, 1 failed'],
			false);
	});
	it('names-arguments-of-instrumented-call', () => {
		expectTestRun(
			() => test('a', () => _testCall('equal', equal, [1n, 2n]), location),
			['✗ a (a.test.jul:3:1)', '    equal(1 2) returned false', '1 test, 1 failed'],
			false);
	});
	it('formats-collections-in-jul-notation', () => {
		expectTestRun(
			() => test('a', () => _testCall('deepEqual', deepEqual, [[1n, 'x'], { b: 2n }]), location),
			['✗ a (a.test.jul:3:1)', '    deepEqual([1 §x§] [b = 2]) returned false', '1 test, 1 failed'],
			false);
	});
	it('reports-exception-and-continues', () => {
		expectTestRun(
			() => {
				test('a', () => { throw new Error('kaputt'); }, location);
				test('b', () => true, location);
			},
			['✗ a (a.test.jul:3:1)', '    threw kaputt', '✓ b', '2 tests, 1 failed'],
			false);
	});
	// Das Register wird geleert, ein zweiter Lauf wiederholt nichts.
	it('runs-each-test-once', () => {
		test('a', () => true, location);
		_runTests(() => { });
		expectTestRun(() => { }, ['0 tests, 0 failed'], true);
	});
});
