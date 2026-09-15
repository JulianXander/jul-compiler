import { expect } from 'chai';
import { parseTsCode } from './typescript-parser.js';
import { ParseSingleDefinition } from '../syntax-tree.js';

describe('TypeScript Parser', () => {
	it('sollte Zeile/Spalte statt rohem Zeichen-Offset für die Position einer Funktionsdeklaration liefern', () => {
		const code = 'export function foo() {\n\treturn 1;\n}\n';
		const result = parseTsCode(code);
		const definition = result.expressions![0] as ParseSingleDefinition;
		expect(definition.name).to.deep.include({
			startRowIndex: 0,
			startColumnIndex: 16,
			endRowIndex: 0,
			endColumnIndex: 19,
		});
	});
});
