import { expect } from 'chai';

import {
	builtinBoolean,
	builtinEmpty,
	builtinInteger,
	builtinNever,
	builtinText,
	CompileTimeType,
	createBooleanLiteral,
	createCompileTimeBoundType,
	createCompileTimeComplementType,
	createCompileTimeListType,
	createCompileTimeTupleType,
	createIntegerLiteral,
} from '../syntax-tree.js';
import { reportAtCaller } from '../test-util.js';
import {
	createNormalizedIntersectionType,
	createNormalizedUnionType,
	dereferenceIndexFromObject,
	isTypeAssignable,
	typeToString,
} from './type-algebra.js';

const integerLiteral = (value: number) => createIntegerLiteral(BigInt(value));
const not = createCompileTimeComplementType;
const greaterInteger = (value: number) => createCompileTimeBoundType('greater', 'integer', integerLiteral(value));
const lessInteger = (value: number) => createCompileTimeBoundType('less', 'integer', integerLiteral(value));
const and = createNormalizedIntersectionType;
const or = createNormalizedUnionType;
// Wie in core-lib.jul: NonZeroInteger = Integer.Without(0), PositiveInteger = GreaterInteger(0)
const nonZeroInteger = and([builtinInteger, not(integerLiteral(0))]);
const positiveInteger = greaterInteger(0);

const expectAssignable = reportAtCaller((type: CompileTimeType, target: CompileTimeType) => {
	const assignability = isTypeAssignable(type, target);
	expect(assignability.assignable).to.equal(true,
		`${typeToString(type, 0, 5)} sollte zu ${typeToString(target, 0, 5)} passen`);
});
const expectNotAssignable = reportAtCaller((type: CompileTimeType, target: CompileTimeType) => {
	const assignability = isTypeAssignable(type, target);
	expect(assignability.assignable).to.equal(false,
		`${typeToString(type, 0, 5)} sollte nicht zu ${typeToString(target, 0, 5)} passen`);
});

describe('Typalgebra', () => {
	//#region Union
	it('union-collapses-boolean-literal-into-boolean', () => {
		expect(or([builtinBoolean, createBooleanLiteral(false)]).julType).to.equal('boolean');
	});
	it('union-collapses-integer-literal-into-integer', () => {
		expect(or([builtinInteger, integerLiteral(5)]).julType).to.equal('integer');
	});
	// Gegenprobe: nicht verwandte Typen dürfen nicht kollabieren.
	it('union-keeps-unrelated-choices', () => {
		expect(or([builtinText, builtinInteger]).julType).to.equal('or');
	});
	//#endregion Union

	//#region Not
	it('not-type-rejects-excluded-literal', () => {
		expectNotAssignable(integerLiteral(0), nonZeroInteger);
	});
	it('not-type-accepts-other-values', () => {
		expectAssignable(integerLiteral(5), nonZeroInteger);
	});
	// Verboten ist alles, was X überlappt: Integer ist keine Teilmenge von 0, enthält 0 aber.
	it('not-type-rejects-set-type-overlapping-the-excluded-value', () => {
		expectNotAssignable(builtinInteger, not(integerLiteral(0)));
	});
	// Kein einzelner Choice von And(Integer GreaterInteger(0)) reicht für And(Integer Not(0)),
	// erst das Zerlegen des Ziels zeigt es.
	it('not-type-accepts-intersection-without-single-matching-choice', () => {
		expectAssignable(positiveInteger, nonZeroInteger);
	});
	it('and-type-accepts-or-target-containing-same-intersection', () => {
		expectAssignable(positiveInteger, or([builtinEmpty, positiveInteger]));
	});
	it('and-with-complement-is-not-assignable-to-unrelated-type', () => {
		expectNotAssignable(and([builtinInteger, not(integerLiteral(0))]), builtinText);
	});
	// Not(0) enthält auch Text, ist also kein Integer.
	it('complement-does-not-fit-base-type', () => {
		expectNotAssignable(not(integerLiteral(0)), builtinInteger);
	});
	// Eine ausgenommene Grenze verschiebt die Grenze: ohne die 3 bleibt höchstens 2 übrig.
	it('excluded-bound-moves-the-bound', () => {
		const type = and([builtinInteger, not(greaterInteger(3)), not(integerLiteral(3))]);
		expectAssignable(type, not(greaterInteger(2)));
	});
	// Eine ausgenommene Zahl im Inneren ist eine Lücke, kein kleinerer Bereich: die 5 bleibt drin.
	it('excluded-inner-value-does-not-move-the-bound', () => {
		const type = and([builtinInteger, not(greaterInteger(5)), not(integerLiteral(3))]);
		expectNotAssignable(type, not(greaterInteger(4)));
	});
	//#endregion Not

	//#region Never
	it('empty-range-is-never', () => {
		const type = and([greaterInteger(2), lessInteger(2)]);
		expect(type).to.equal(builtinNever);
		expectNotAssignable(integerLiteral(2), type);
	});
	it('empty-range-of-three-choices-is-never', () => {
		const type = and([builtinInteger, greaterInteger(2), lessInteger(2)]);
		expect(type).to.equal(builtinNever);
		expectNotAssignable(integerLiteral(2), type);
	});
	// Die leere Menge liegt in jedem Typ.
	it('never-fits-every-type', () => {
		expectAssignable(and([greaterInteger(2), lessInteger(2)]), builtinText);
	});
	//#endregion Never

	//#region Index
	it('index-out-of-tuple-range', () => {
		const tuple = createCompileTimeTupleType([integerLiteral(1), integerLiteral(2)]);
		expect(dereferenceIndexFromObject(5, tuple)).to.equal(undefined);
	});
	// Gegenprobe: ein gültiger Index liefert den Elementtyp.
	it('index-in-tuple-range', () => {
		const tuple = createCompileTimeTupleType([integerLiteral(1), integerLiteral(2)]);
		expect(dereferenceIndexFromObject(2, tuple)).to.deep.equal(integerLiteral(2));
	});
	// Eine List hat keine bekannte Länge, dort ist kein Index zu weit - die Position ist ab
	// Index 2 aber nicht beweisbar vorhanden, Empty gehört also in den Typ.
	it('index-on-list-may-be-empty', () => {
		const element = dereferenceIndexFromObject(5, createCompileTimeListType(builtinInteger));
		expect(element).to.not.equal(undefined);
		expectNotAssignable(element!, builtinInteger);
		expectAssignable(element!, or([builtinEmpty, builtinInteger]));
	});
	// List(X) schließt Empty aus, Index 1 existiert also beweisbar.
	it('index-one-on-list-adds-no-empty', () => {
		const element = dereferenceIndexFromObject(1, createCompileTimeListType(builtinInteger));
		expect(element).to.equal(builtinInteger);
	});
	//#endregion Index
});
