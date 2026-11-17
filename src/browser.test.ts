import { expect } from 'chai';
import { compile } from './browser.js';
import { ErrorCode } from './compiler-errors.js';

const options = { runtimeImportPath: 'jul-runtime', testRuntimeImportPath: 'jul-test-runtime' };

describe('compile', () => {
	it('liefert JS auch bei einem Typfehler', async () => {
		const output = await compile({ 'main.jul': 'x: Text = 1\nlog(x)' }, options);
		expect(output.errors['main.jul']!.map(error => error.code)).to.deep.equal([ErrorCode.definitionTypeMismatch]);
		expect(output.files['main.jul']!.js).to.contain('export const x = 1;');
	});
	it('liefert JS auch bei einem Syntaxfehler', async () => {
		const output = await compile({ 'main.jul': 'y = add(1\nlog(2)' }, options);
		expect(output.errors['main.jul']!.map(error => error.code)).to.deep.equal([ErrorCode.closingBracketMissing]);
		expect(output.files['main.jul']!.js).to.contain('log(2)');
	});
});
