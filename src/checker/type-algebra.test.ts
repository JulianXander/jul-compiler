import { expect } from 'chai';

import {
	builtinAny,
	builtinBlob,
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
	createCompileTimeStreamType,
	createCompileTimeTupleType,
	createCompileTimeTypeOfType,
	createFloatLiteral,
	createIntegerLiteral,
} from '../syntax-tree.js';
import { reportAtCaller } from '../test-util.js';
import {
	createNormalizedIntersectionType,
	createNormalizedUnionType,
	dereferenceIndexFromObject,
	isTypeAssignable,
	typeToString,
	valueOf,
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

	//#region Not: obere Grenzen
	// Eine obere Grenze darf nur gegen eine gleich große oder größere obere Grenze passen:
	// Not(A) liegt genau dann in Not(B), wenn B in A liegt.
	it('upper-bound-fits-larger-upper-bound', () => {
		expectAssignable(not(greaterInteger(2)), not(greaterInteger(3)));
	});
	it('upper-bound-does-not-fit-smaller-upper-bound', () => {
		expectNotAssignable(not(greaterInteger(3)), not(greaterInteger(2)));
	});
	it('integer-upper-bound-fits-larger-integer-upper-bound', () => {
		expectAssignable(
			and([builtinInteger, not(greaterInteger(2))]),
			and([builtinInteger, not(greaterInteger(3))]),
		);
	});
	// Das Ziel-And wird zerlegt, für Not(GreaterInteger(2)) muss dann die Überlappung von
	// "höchstens 3" mit "größer als 2" erkannt werden: 3 liegt in beiden.
	it('integer-upper-bound-does-not-fit-smaller-integer-upper-bound', () => {
		expectNotAssignable(
			and([builtinInteger, not(greaterInteger(3))]),
			and([builtinInteger, not(greaterInteger(2))]),
		);
	});
	// Der Teilmengen-Shortcut And(A B) => A darf hier nicht greifen, sonst geht Integer verloren
	// und ein Text wäre zuweisbar.
	it('and-with-complement-keeps-both-choices', () => {
		expectNotAssignable(builtinText, and([not(integerLiteral(0)), builtinInteger]));
	});
	//#endregion Not: obere Grenzen

	//#region Grenzen
	// Blob ist ein Basistyp wie Date, kein Any.
	it('blob-rejects-integer', () => {
		expectNotAssignable(integerLiteral(5), builtinBlob);
	});
	it('greater-integer-accepts-larger-integer', () => {
		expectAssignable(integerLiteral(1), greaterInteger(0));
	});
	it('greater-integer-is-strict', () => {
		expectNotAssignable(integerLiteral(0), greaterInteger(0));
	});
	// Die Familie steht im Namen: 1f ist größer als 0, aber keine ganze Zahl.
	it('greater-integer-rejects-float', () => {
		expectNotAssignable(createFloatLiteral(1), greaterInteger(0));
	});
	it('less-integer-accepts-smaller-integer', () => {
		expectAssignable(integerLiteral(2), lessInteger(3));
	});
	it('less-integer-is-strict', () => {
		expectNotAssignable(integerLiteral(3), lessInteger(3));
	});
	it('literals-below-bound-fit-less-integer', () => {
		expectAssignable(or([integerLiteral(1), integerLiteral(2)]), lessInteger(3));
	});
	it('less-integer-does-not-fit-greater-integer', () => {
		expectNotAssignable(lessInteger(3), greaterInteger(0));
	});
	// Über ganze Zahlen ist > -1 dasselbe wie ≥ 0.
	it('strict-bound-fits-inclusive-bound', () => {
		expectAssignable(greaterInteger(-1), or([integerLiteral(0), greaterInteger(0)]));
	});
	it('inclusive-bound-fits-strict-bound', () => {
		expectAssignable(or([integerLiteral(0), greaterInteger(0)]), greaterInteger(-1));
	});
	it('range-fits-listed-values', () => {
		const range = and([greaterInteger(0), lessInteger(4)]);
		expectAssignable(range, or([integerLiteral(1), integerLiteral(2), integerLiteral(3)]));
	});
	it('listed-values-fit-range', () => {
		const range = and([greaterInteger(0), lessInteger(4)]);
		expectAssignable(or([integerLiteral(1), integerLiteral(2), integerLiteral(3)]), range);
	});
	it('range-does-not-fit-listed-values-with-gap', () => {
		const range = and([greaterInteger(0), lessInteger(4)]);
		expectNotAssignable(range, or([integerLiteral(1), integerLiteral(3)]));
	});
	//#endregion Grenzen

	//#region Stream, Liste, Typwert
	// FiniteStream fordert mehr als Stream und ist deshalb überall einsetzbar, wo Stream verlangt wird.
	it('finite-stream-is-assignable-to-stream', () => {
		expectAssignable(createCompileTimeStreamType(builtinInteger, true), createCompileTimeStreamType(builtinInteger, false));
	});
	it('stream-is-not-assignable-to-finite-stream', () => {
		expectNotAssignable(createCompileTimeStreamType(builtinInteger, false), createCompileTimeStreamType(builtinInteger, true));
	});
	// Eine Union aus Streams wird zu einem Stream zusammengefasst, endlich nur, wenn jeder Choice
	// endlich ist.
	it('union-of-finite-stream-and-stream-is-not-finite', () => {
		const union = or([
			createCompileTimeStreamType(builtinInteger, true),
			createCompileTimeStreamType(builtinText, false),
		]);
		expectNotAssignable(union, createCompileTimeStreamType(builtinAny, true));
		expect(typeToString(union, 0, 5)).to.equal('Stream(Or(Integer Text))');
	});
	// Gegenprobe: ohne Prädikat wird List(Or(Integer Text)) zurecht nicht als Or([] List(Integer)) akzeptiert.
	it('list-or-text-not-assignable-to-list-or-integer', () => {
		expectNotAssignable(
			createCompileTimeListType(or([builtinInteger, builtinText])),
			or([builtinEmpty, createCompileTimeListType(builtinInteger)]),
		);
	});
	// Ein Or aus zwei Typwerten, gelesen als Annotation, verteilt sich: 5 passt zum ersten Choice.
	it('value-of-union-of-type-values', () => {
		const typeValues = or([createCompileTimeTypeOfType(builtinInteger), createCompileTimeTypeOfType(builtinText)]);
		expectAssignable(integerLiteral(5), valueOf(typeValues));
	});
	//#endregion Stream, Liste, Typwert

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
