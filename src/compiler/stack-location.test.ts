import { expect } from 'chai';
import { TestLocation } from '../runtime/test-runtime.js';
import { reportAtCaller } from '../test-util.js';
import { SourceMapping } from './emitter.js';
import { getSourceLocationFromStack, LoadedSourceFile } from './stack-location.js';

const mainUrl = 'blob:http://localhost:3000/1111-aaaa';
const mathUrl = 'blob:http://localhost:3000/2222-bbbb';
const runtimeUrl = 'blob:http://localhost:3000/3333-cccc';

/** generatedLine:generatedColumn → sourceLine:sourceColumn, alles 0-basiert. */
function mapping(generated: string, source: string): SourceMapping {
	const [generatedLine, generatedColumn] = generated.split(':').map(Number);
	const [sourceLine, sourceColumn] = source.split(':').map(Number);
	return {
		generatedLine: generatedLine!,
		generatedColumn: generatedColumn!,
		sourceLine: sourceLine!,
		sourceColumn: sourceColumn!,
	};
}

const files: { [url: string]: LoadedSourceFile; } = {
	[mainUrl]: {
		sourceFilePath: 'main.test.jul',
		mappings: [
			mapping('2:0', '1:0'),
			mapping('3:4', '3:1'),
			mapping('3:20', '3:9'),
		],
	},
	[mathUrl]: {
		sourceFilePath: 'math.jul',
		mappings: [
			mapping('1:0', '0:0'),
			mapping('1:15', '0:11'),
		],
	},
};

const expectLocation = reportAtCaller((stack: string[], location: TestLocation | undefined) => {
	expect(getSourceLocationFromStack(stack.join('\n'), url => files[url])).to.deep.equal(location);
});

describe('getSourceLocationFromStack', () => {
	it('v8-frame', () => {
		expectLocation(
			[
				'Error: kaputt',
				`    at double (${mathUrl}:2:20)`,
			],
			{ file: 'math.jul', row: 1, column: 12 });
	});

	it('firefox-frame', () => {
		expectLocation(
			[
				`double@${mathUrl}:2:20`,
			],
			{ file: 'math.jul', row: 1, column: 12 });
	});

	it('frame-without-function-name', () => {
		expectLocation(
			[
				'Error: kaputt',
				`    at ${mainUrl}:4:10`,
			],
			{ file: 'main.test.jul', row: 4, column: 2 });
	});

	it('skips-runtime-frames', () => {
		expectLocation(
			[
				'Error: kaputt',
				`    at _callFunction (${runtimeUrl}:120:9)`,
				`    at ${mainUrl}:4:30`,
			],
			{ file: 'main.test.jul', row: 4, column: 10 });
	});

	it('innermost-program-frame-wins', () => {
		expectLocation(
			[
				'Error: kaputt',
				`    at double (${mathUrl}:2:1)`,
				`    at ${mainUrl}:4:10`,
			],
			{ file: 'math.jul', row: 1, column: 1 });
	});

	it('skips-position-before-first-mapping', () => {
		expectLocation(
			[
				'Error: kaputt',
				`    at ${mathUrl}:1:5`,
				`    at ${mainUrl}:3:1`,
			],
			{ file: 'main.test.jul', row: 2, column: 1 });
	});

	it('mapping-on-earlier-line', () => {
		expectLocation(
			[
				'Error: kaputt',
				`    at ${mainUrl}:4:2`,
			],
			{ file: 'main.test.jul', row: 2, column: 1 });
	});

	it('no-program-frame', () => {
		expectLocation(
			[
				'Error: kaputt',
				`    at _callFunction (${runtimeUrl}:120:9)`,
			],
			undefined);
	});
});
