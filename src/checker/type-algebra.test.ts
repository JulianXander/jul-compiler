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
	createCompileTimeDictionaryLiteralType,
	createCompileTimeListType,
	createCompileTimeStreamType,
	createCompileTimeTupleType,
	createCompileTimeTypeOfType,
	createFloatLiteral,
	createIntegerLiteral,
	createParameterReference,
} from '../syntax-tree.js';
import { reportAtCaller } from '../test-util.js';
import {
	createNormalizedIntersectionType,
	createNormalizedUnionType,
	dereferenceIndexFromObject,
	isTypeAssignable,
	spreadDictionaryTypes,
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

const dictionary = (fields: Record<string, CompileTimeType>, complete = true) =>
	createCompileTimeDictionaryLiteralType(fields, complete);
const choicesOf = (type: CompileTimeType) =>
	type.julType === 'or'
		? type.ChoiceTypes
		: [type];

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
	// Or(1 Or(2 3)) => Or(1 2 3)
	it('union-flattens-nested-unions', () => {
		const type = or([integerLiteral(1), or([integerLiteral(2), integerLiteral(3)])]);
		expect(type.julType).to.equal('or');
		expect(choicesOf(type)).to.have.length(3);
	});
	it('union-with-any-is-any', () => {
		expect(or([builtinInteger, builtinAny])).to.equal(builtinAny);
	});
	it('union-drops-never', () => {
		expect(or([builtinInteger, builtinNever])).to.equal(builtinInteger);
	});
	it('union-of-only-never-is-never', () => {
		expect(or([builtinNever, builtinNever])).to.equal(builtinNever);
	});
	it('empty-union-is-never', () => {
		expect(or([])).to.equal(builtinNever);
	});
	it('union-removes-duplicates', () => {
		const type = or([integerLiteral(1), integerLiteral(1)]);
		expect(type).to.deep.equal(integerLiteral(1));
	});
	// Or(A Not(A)) => Any
	it('union-with-own-complement-is-any', () => {
		expect(or([builtinInteger, not(builtinInteger)])).to.equal(builtinAny);
	});
	// Gegenprobe: Not(0) deckt nicht alles ab, und keiner der beiden Choices ist Teilmenge des anderen.
	it('union-with-foreign-complement-stays', () => {
		expect(or([builtinInteger, not(integerLiteral(0))]).julType).to.equal('or');
	});
	// Integer liegt ganz in Not(Text): die Teilmengen-Reduktion lässt nur Not(Text) übrig.
	it('union-reduces-subtype-of-complement', () => {
		expect(or([builtinInteger, not(builtinText)]).julType).to.equal('not');
	});
	it('union-of-true-and-false-is-boolean', () => {
		expect(or([createBooleanLiteral(true), createBooleanLiteral(false)])).to.equal(builtinBoolean);
	});
	// Gegenprobe: nur ein Wert von Boolean bleibt ein Literal.
	it('union-of-true-and-integer-keeps-both', () => {
		expect(choicesOf(or([createBooleanLiteral(true), builtinInteger]))).to.have.length(2);
	});
	// Ein nicht aufgelöster Platzhalter wird nie verworfen und verwirft nichts.
	it('union-keeps-placeholder-and-does-not-reduce-with-it', () => {
		const placeholder = createParameterReference('a', 0);
		const type = or([placeholder, builtinInteger, integerLiteral(5)]);
		const choices = choicesOf(type);
		expect(choices).to.have.length(2);
		expect(choices).to.include(placeholder);
		expect(choices).to.include(builtinInteger);
	});
	it('union-reduces-subtypes-of-structured-types', () => {
		const list = createCompileTimeListType(builtinInteger);
		expect(or([list, createCompileTimeListType(integerLiteral(1))])).to.deep.equal(list);
	});
	// Über der Größenschwelle wird nicht mehr nach Teilmengen reduziert.
	it('union-above-limit-skips-subtype-reduction', () => {
		const literals = Array.from({ length: 25 }, (_, index) => integerLiteral(index));
		const type = or([...literals, builtinInteger]);
		expect(choicesOf(type)).to.have.length(26);
	});
	// Gegenprobe: darunter wird reduziert.
	it('union-below-limit-reduces-subtypes', () => {
		const literals = Array.from({ length: 5 }, (_, index) => integerLiteral(index));
		expect(or([...literals, builtinInteger])).to.equal(builtinInteger);
	});
	it('union-of-finite-streams-is-finite', () => {
		const union = or([
			createCompileTimeStreamType(builtinInteger, true),
			createCompileTimeStreamType(builtinText, true),
		]);
		expect(union.julType).to.equal('stream');
		expectAssignable(union, createCompileTimeStreamType(builtinAny, true));
	});
	it('union-collapses-streams-but-keeps-other-choices', () => {
		const type = or([
			createCompileTimeStreamType(builtinInteger, false),
			builtinText,
			createCompileTimeStreamType(builtinBoolean, false),
		]);
		const choices = choicesOf(type);
		expect(choices).to.have.length(2);
		expect(choices.map(choice => choice.julType)).to.have.members(['stream', 'text']);
	});
	//#endregion Union

	//#region Intersection
	it('intersection-with-never-is-never', () => {
		expect(and([builtinInteger, builtinNever])).to.equal(builtinNever);
		expect(and([builtinNever, builtinInteger])).to.equal(builtinNever);
	});
	it('intersection-with-any-is-neutral', () => {
		expect(and([builtinInteger, builtinAny])).to.equal(builtinInteger);
		expect(and([builtinAny, builtinInteger])).to.equal(builtinInteger);
	});
	// Neben einem Not bleibt Any stehen: unbekannter Wert, der nur kein Integer ist.
	it('intersection-of-any-and-complement-keeps-both', () => {
		expect(and([builtinAny, not(builtinInteger)]).julType).to.equal('and');
		expect(and([not(builtinInteger), builtinAny]).julType).to.equal('and');
	});
	// And(Or(A B) C) => Or(And(A C) And(B C)), egal auf welcher Seite die Union steht.
	it('intersection-distributes-over-union', () => {
		const union = or([integerLiteral(1), integerLiteral(2)]);
		expect(choicesOf(and([union, builtinInteger]))).to.have.length(2);
		expect(choicesOf(and([builtinInteger, union]))).to.have.length(2);
	});
	it('intersection-distribution-drops-disjoint-choices', () => {
		const union = or([builtinInteger, builtinText]);
		expect(and([union, integerLiteral(5)])).to.deep.equal(integerLiteral(5));
		expect(and([integerLiteral(5), union])).to.deep.equal(integerLiteral(5));
	});
	it('intersection-with-own-complement-is-never', () => {
		expect(and([builtinInteger, not(builtinInteger)])).to.equal(builtinNever);
	});
	// And(A Not(B)) => A, wenn B keine Schnittmenge mit A hat.
	it('intersection-with-disjoint-complement-is-source', () => {
		expect(and([builtinInteger, not(builtinText)])).to.equal(builtinInteger);
	});
	// Gegenprobe: B überschneidet A, beide Choices bleiben.
	it('intersection-with-overlapping-complement-keeps-both', () => {
		expect(and([builtinInteger, not(integerLiteral(0))]).julType).to.equal('and');
	});
	it('intersection-returns-subset', () => {
		expect(and([builtinInteger, integerLiteral(5)])).to.deep.equal(integerLiteral(5));
		expect(and([integerLiteral(5), builtinInteger])).to.deep.equal(integerLiteral(5));
	});
	it('intersection-of-equal-types-is-that-type', () => {
		expect(and([builtinInteger, builtinInteger])).to.equal(builtinInteger);
	});
	it('intersection-of-disjoint-types-is-never', () => {
		expect(and([builtinInteger, builtinText])).to.equal(builtinNever);
	});
	//#endregion Intersection

	//#region Dictionary
	// Ein Dictionary-Literal ist eine Struktur: Felder beider Seiten bleiben erhalten.
	it('intersection-merges-dictionary-fields', () => {
		const type = and([dictionary({ a: builtinInteger }), dictionary({ b: builtinText })]);
		expect(type.julType).to.equal('dictionaryLiteral');
		const fields = (type as ReturnType<typeof dictionary>).Fields;
		expect(Object.keys(fields)).to.have.members(['a', 'b']);
	});
	it('intersection-merges-same-dictionary-field', () => {
		const type = and([dictionary({ a: builtinInteger }), dictionary({ a: integerLiteral(5) })]);
		expect((type as ReturnType<typeof dictionary>).Fields.a).to.deep.equal(integerLiteral(5));
	});
	it('intersection-of-dictionaries-with-conflicting-field-is-never', () => {
		expect(and([dictionary({ a: builtinInteger }), dictionary({ a: builtinText })])).to.equal(builtinNever);
	});
	it('intersection-of-dictionaries-is-complete-if-either-side-is', () => {
		const incompleteBoth = and([dictionary({ a: builtinInteger }, false), dictionary({ b: builtinText }, false)]);
		const oneComplete = and([dictionary({ a: builtinInteger }, false), dictionary({ b: builtinText }, true)]);
		expect((incompleteBoth as ReturnType<typeof dictionary>).complete).to.equal(false);
		expect((oneComplete as ReturnType<typeof dictionary>).complete).to.equal(true);
	});
	it('intersection-of-dictionary-and-disjoint-type-is-never', () => {
		expect(and([dictionary({ a: builtinInteger }), builtinText])).to.equal(builtinNever);
	});
	//#endregion Dictionary

	//#region Spread
	const spread = (left: CompileTimeType, right: CompileTimeType) =>
		spreadDictionaryTypes(left, right, (fields, complete) => dictionary(fields, complete));
	it('spread-right-overrides-left', () => {
		const result = spread(
			dictionary({ a: builtinInteger, b: builtinText }),
			dictionary({ b: builtinBoolean, c: builtinInteger }),
		) as ReturnType<typeof dictionary>;
		expect(result.Fields).to.deep.equal({ a: builtinInteger, b: builtinBoolean, c: builtinInteger });
	});
	it('spread-is-complete-only-if-both-sides-are', () => {
		const incomplete = spread(dictionary({ a: builtinInteger }, false), dictionary({ b: builtinText })) as ReturnType<typeof dictionary>;
		const complete = spread(dictionary({ a: builtinInteger }), dictionary({ b: builtinText })) as ReturnType<typeof dictionary>;
		expect(incomplete.complete).to.equal(false);
		expect(complete.complete).to.equal(true);
	});
	it('spread-with-empty-returns-other-side', () => {
		const dict = dictionary({ a: builtinInteger });
		expect(spread(dict, builtinEmpty)).to.equal(dict);
		expect(spread(builtinEmpty, dict)).to.equal(dict);
	});
	it('spread-of-non-dictionary-is-undefined', () => {
		expect(spread(dictionary({ a: builtinInteger }), builtinInteger)).to.equal(undefined);
	});
	it('spread-distributes-over-union', () => {
		const result = spread(
			or([dictionary({ a: builtinInteger }), dictionary({ a: builtinText })]),
			dictionary({ b: builtinBoolean }),
		);
		expect(choicesOf(result!)).to.have.length(2);
	});
	it('spread-with-undecidable-union-choice-is-undefined', () => {
		const left = or([dictionary({ a: builtinInteger }), builtinInteger]);
		expect(spread(left, dictionary({ b: builtinBoolean }))).to.equal(undefined);
	});
	//#endregion Spread

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
