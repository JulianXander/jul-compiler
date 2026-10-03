import { expect } from 'chai';
import { constantValueToType, maxFoldedTupleLength, typeToConstantValue } from './constant-folding.js';
import { _julTypeSymbol } from '../runtime/runtime.js';
import {
	builtinEmpty,
	builtinError,
	builtinInteger,
	builtinText,
	createCompileTimeTypeOfType,
	createBooleanLiteral,
	createCompileTimeDictionaryLiteralType,
	createCompileTimeTupleType,
	createFloatLiteral,
	createIntegerLiteral,
	createTextLiteral,
} from '../syntax-tree.js';

describe('typeToConstantValue', () => {
	it('liest ein Integer-Literal', () => {
		expect(typeToConstantValue(createIntegerLiteral(5n))).to.deep.equal({ value: 5n });
	});
	it('liest ein Float-Literal', () => {
		expect(typeToConstantValue(createFloatLiteral(1.5))).to.deep.equal({ value: 1.5 });
	});
	it('liest ein Text-Literal', () => {
		expect(typeToConstantValue(createTextLiteral('abc'))).to.deep.equal({ value: 'abc' });
	});
	it('liest ein Boolean-Literal', () => {
		expect(typeToConstantValue(createBooleanLiteral(true))).to.deep.equal({ value: true });
	});
	it('liest Empty als undefined', () => {
		expect(typeToConstantValue(builtinEmpty)).to.deep.equal({ value: undefined });
	});
	it('liest ein Tuple aus Literalen', () => {
		const tuple = createCompileTimeTupleType([createIntegerLiteral(1n), createIntegerLiteral(2n)]);
		expect(typeToConstantValue(tuple)).to.deep.equal({ value: [1n, 2n] });
	});
	it('liest ein Dictionary-Literal aus Literalen (Bruch)', () => {
		const fraction = createCompileTimeDictionaryLiteralType({
			numerator: createIntegerLiteral(1n),
			denominator: createIntegerLiteral(2n),
		}, true);
		expect(typeToConstantValue(fraction)).to.deep.equal({ value: { numerator: 1n, denominator: 2n } });
	});
	// Ein Typ als Argument (Integer in aggregate(values Integer ...)) hat den Typ TypeOf(Integer);
	// sein Wert ist das Laufzeitobjekt des Typs.
	it('liest TypeOf(Integer) als Laufzeittyp integer', () => {
		expect(typeToConstantValue(createCompileTimeTypeOfType(builtinInteger))).to.deep.equal({
			value: { [_julTypeSymbol]: 'integer' },
		});
	});
	it('liest TypeOf(Text) als Laufzeittyp text', () => {
		expect(typeToConstantValue(createCompileTimeTypeOfType(builtinText))).to.deep.equal({
			value: { [_julTypeSymbol]: 'text' },
		});
	});
	it('ist nicht faltbar für einen nicht-literalen Typ', () => {
		expect(typeToConstantValue(builtinInteger)).to.equal(undefined);
	});
	it('ist nicht faltbar, wenn ein Tuple-Element nicht konstant ist', () => {
		const tuple = createCompileTimeTupleType([createIntegerLiteral(1n), builtinInteger]);
		expect(typeToConstantValue(tuple)).to.equal(undefined);
	});
	it('ist nicht faltbar, wenn ein Dictionary-Feld nicht konstant ist', () => {
		const dictionary = createCompileTimeDictionaryLiteralType({ a: builtinInteger }, true);
		expect(typeToConstantValue(dictionary)).to.equal(undefined);
	});
});

describe('constantValueToType', () => {
	it('übersetzt einen bigint zu einem Integer-Literal', () => {
		expect(constantValueToType(5n)).to.deep.equal(createIntegerLiteral(5n));
	});
	it('übersetzt eine number zu einem Float-Literal', () => {
		expect(constantValueToType(1.5)).to.deep.equal(createFloatLiteral(1.5));
	});
	it('faltet NaN nicht', () => {
		expect(constantValueToType(NaN)).to.equal(undefined);
	});
	it('faltet Infinity nicht', () => {
		expect(constantValueToType(Infinity)).to.equal(undefined);
	});
	it('faltet -Infinity nicht', () => {
		expect(constantValueToType(-Infinity)).to.equal(undefined);
	});
	it('übersetzt einen string zu einem Text-Literal', () => {
		expect(constantValueToType('abc')).to.deep.equal(createTextLiteral('abc'));
	});
	it('übersetzt einen boolean zu einem Boolean-Literal', () => {
		expect(constantValueToType(true)).to.deep.equal(createBooleanLiteral(true));
	});
	it('übersetzt undefined zu Empty', () => {
		expect(constantValueToType(undefined)).to.equal(builtinEmpty);
	});
	it('übersetzt einen zurückgegebenen Error zu Error', () => {
		expect(constantValueToType(new Error('invalid'))).to.equal(builtinError);
	});
	it('übersetzt ein Array zu einem Tuple', () => {
		expect(constantValueToType([1n, 2n])).to.deep.equal(
			createCompileTimeTupleType([createIntegerLiteral(1n), createIntegerLiteral(2n)]));
	});
	it('übersetzt ein Array mit der maximalen Länge noch zu einem Tuple', () => {
		const type = constantValueToType(new Array(maxFoldedTupleLength).fill(1n));
		expect(type?.julType).to.equal('tuple');
	});
	it('faltet ein Array über der maximalen Länge nicht', () => {
		expect(constantValueToType(new Array(maxFoldedTupleLength + 1).fill(1n))).to.equal(undefined);
	});
	it('übersetzt ein Objekt zu einem vollständigen Dictionary-Literal (Bruch)', () => {
		expect(constantValueToType({ numerator: 1n, denominator: 2n })).to.deep.equal(
			createCompileTimeDictionaryLiteralType({
				numerator: createIntegerLiteral(1n),
				denominator: createIntegerLiteral(2n),
			}, true));
	});
});
