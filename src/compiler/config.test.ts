import { expect } from 'chai';
import { parseConfig } from './config.js';

describe('Config', () => {
	it('config-minimal', () => {
		expect(parseConfig('entryFilePath: main.jul')).to.deep.equal({ entryFilePath: 'main.jul' });
	});
	it('config-warn-unknown-off', () => {
		expect(parseConfig('entryFilePath: main.jul\nwarnUnknown: false').warnUnknown).to.equal(false);
	});
	it('config-warn-unknown-must-be-boolean', () => {
		expect(() => parseConfig('entryFilePath: main.jul\nwarnUnknown: nein')).to.throw('does not match schema');
	});
	it('config-unknown-field-is-rejected', () => {
		expect(() => parseConfig('entryFilePath: main.jul\nwarnSomething: false')).to.throw('does not match schema');
	});
});
