import { expect } from 'chai';

import { ParseExpression, ParseSingleDefinition } from './syntax-tree.js';
import { CompilerError, ErrorCode } from './compiler-errors.js';
import { coreLibPath, parseCode, parseFile } from './parser/parser.js';
import { checkTypes } from './checker.js';

const expectedResults: {
	name?: string;
	code: string;
	result?: ParseExpression[];
	errors?: CompilerError[];
}[] = [
		{
			name: 'text-interpolation-reference-error',
			code: '§§(a)§',
			errors: [
				{
					"code": ErrorCode.notDefined,
					"endColumnIndex": 4,
					"endRowIndex": 0,
					"message": "a is not defined.",
					"startColumnIndex": 3,
					"startRowIndex": 0,
				},
			],
		},
		{
			name: 'branch-non-function-error',
			code: '[] ?\n\t4',
			// result: [
			// 	{
			// 		"branches": [
			// 			{
			// 				"endColumnIndex": 2,
			// 				"endRowIndex": 1,
			// 				"inferredType": 4n,
			// 				"startColumnIndex": 1,
			// 				"startRowIndex": 1,
			// 				"type": "integer",
			// 				"value": 4n,
			// 			},
			// 		],
			// 		"endColumnIndex": 1,
			// 		"endRowIndex": 2,
			// 		"inferredType": {
			// 			"ChoiceTypes": [
			// 				{
			// 					"type": "any",
			// 				},
			// 			],
			// 			"type": "or",
			// 		},
			// 		"startColumnIndex": 0,
			// 		"startRowIndex": 0,
			// 		"type": "branching",
			// 		"value": {
			// 			"endColumnIndex": 2,
			// 			"endRowIndex": 0,
			// 			"fields": [],
			// 			"inferredType": {
			// 				"type": "any",
			// 			},
			// 			"startColumnIndex": 0,
			// 			"startRowIndex": 0,
			// 			"type": "bracketed",
			// 		},
			// 	},
			// ],
			errors: [
				{
					"code": ErrorCode.branchIsNotFunction,
					"endColumnIndex": 2,
					"endRowIndex": 1,
					"message": "Expected branch to be a function.\nCan not assign 4 to Any :> Any.",
					"startColumnIndex": 1,
					"startRowIndex": 1,
				},
			],
		},
		// {
		// 	name: 'prefix-function-call',
		// 	code: '4.log()',
		// 	result: [],
		// },
		// {
		// 	name: 'redefine-corelib',
		// 	code: 'add = 1',
		// 	result: [],
		// 	errors: [
		// 		{
		// 			"endColumnIndex": 7,
		// 			"endRowIndex": 0,
		// 			"message": "add is already defined in upper scope",
		// 			"startColumnIndex": 0,
		// 			"startRowIndex": 0,
		// 		},
		// 	],
		// },
		{
			name: 'used-before-defined-error',
			code: `a
a = 5`,
			errors: [
				{
					"code": ErrorCode.usedBeforeDefined,
					"endColumnIndex": 1,
					"endRowIndex": 0,
					"message": "a is used before it is defined.",
					"startColumnIndex": 0,
					"startRowIndex": 0,
				},
			],
		},
		{
			name: 'list-type-error',
			code: 'a: List(Text) = [4]',
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 19,
					"endRowIndex": 0,
					"message": "Can not assign 4 to Text.",
					"startColumnIndex": 0,
					"startRowIndex": 0,
				},
			],
		},
		{
			name: 'type-function',
			code: `t = Any => []
t(1)`,
		},
		//#region branch narrowing
		// Der gebranchte Name wird im Scope des jeweiligen Branches verengt. Die Verengung
		// schneidet (sie ersetzt nicht) und muss die auto wrap/spread Logik von _branch
		// abbilden: ein primitiver Wert wird zu [value] gewrappt und landet im 1. Parameter,
		// eine Collection wird auf die Parameter gespreadet.
		{
			// Der catchAll () => ... bindet nichts und matcht jeden Wert, sagt über den Wert
			// also nichts aus. countdown behält daher Integer und ist weiter an einen
			// Integer-Parameter zuweisbar. Vgl. jul-examples/fibonacci/fibonacci.jul.
			name: 'branch-narrowing-catch-all',
			code: `g = (x: Integer) => x
f = (countdown: Integer) =>
	countdown ?
		0 => 0
		() => g(countdown)`,
		},
		{
			// Ein primitiver Wert landet im 1. Parameter, verengt wird also auf dessen Typ —
			// nicht auf die Parameterliste als Ganzes. countdown wird Integer, nicht (y: Integer).
			name: 'branch-narrowing-named-param',
			code: `g = (x: Integer) => x
f = (countdown: Integer) =>
	countdown ?
		0 => 0
		(y: Integer) => g(countdown)`,
		},
		{
			// Ohne Einzelparameter bekommt der rest den auto wrapped Wert, also [countdown].
			// Verengt wird daher auf den Elementtyp der rest-Liste, hier Integer.
			name: 'branch-narrowing-rest-param',
			code: `g = (x: Integer) => x
f = (countdown: Integer) =>
	countdown ?
		0 => 0
		(...rest: List(Integer)) => g(countdown)`,
		},
		{
			// Ein Parameter ohne TypeGuard hat den Typ Any, das darf nicht verbreitern.
			name: 'branch-narrowing-untyped-param',
			code: `g = (x: Integer) => x
f = (countdown: Integer) =>
	countdown ?
		0 => 0
		(y) => g(countdown)`,
		},
		{
			// Any als branch Typ darf nicht verbreitern, der Schnitt behält Integer.
			name: 'branch-narrowing-any-branch',
			code: `g = (x: Integer) => x
f = (countdown: Integer) =>
	countdown ?
		0 => 0
		Any => g(countdown)`,
		},
		{
			// Bei Typ-Params wird der rohe Wert gegen den ParamsType geprüft und nichts gebunden,
			// der ParamsType ist also direkt der Branch-Typ: someVar wird hier zu Integer.
			name: 'branch-narrowing-type-param',
			code: `g = (x: Integer) => x
f = (someVar: Any) =>
	someVar ?
		Integer => g(someVar)
		() => 0`,
		},
		{
			// Distributivgesetz: And(Or(Text Integer) Text) => Or(Text Never) => Text
			name: 'branch-narrowing-union',
			code: `t = (x: Text) => x
f = (someVar: Or(Text Integer)) =>
	someVar ?
		(y: Text) => t(someVar)
		() => §§`,
		},
		{
			// Bei einem Collection Wert wird auf die Parameter gespreadet, die Parameter
			// beschreiben also die Elemente. Es darf nicht auf Integer verengt werden.
			name: 'branch-narrowing-collection',
			code: `h = (x: List(Integer)) => x
f = (someVar: List(Integer)) =>
	someVar ?
		(a: Integer) => h(someVar)
		() => []`,
		},
		{
			// Gegenprobe: die Verengung muss auch wirklich greifen. Im Text-Branch ist someVar
			// auf Text verengt und damit nicht mehr an einen Integer-Parameter zuweisbar.
			name: 'branch-narrowing-applies',
			code: `g = (x: Integer) => x
f = (someVar: Or(Text Integer)) =>
	someVar ?
		(y: Text) => g(someVar)
		() => 0`,
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 25,
					"endRowIndex": 3,
					"message": "Can not assign Text to Integer.",
					"startColumnIndex": 15,
					"startRowIndex": 3,
				},
			],
		},
		//#endregion branch narrowing
		//#region Not
		{
			// Not(X) schließt X aus. NonZeroInteger ist Integer.Without(0), also
			// And(Integer Not(0)) — 0 muss daran scheitern, obwohl es zu Integer passt.
			name: 'not-type-is-checked',
			code: 'a: NonZeroInteger = 0',
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 21,
					"endRowIndex": 0,
					"message": "Can not assign 0 to Not(0).",
					"startColumnIndex": 0,
					"startRowIndex": 0,
				},
			],
		},
		{
			// Gegenprobe: die Prüfung darf nicht zu streng werden
			name: 'not-type-accepts-other-values',
			code: 'a: NonZeroInteger = 5',
		},
		{
			// Not(X) muss auch für Mengentypen greifen, nicht nur für Literale. Der Unterschied:
			// verboten ist alles, was X überlappt — bei einem Literal ist das dasselbe wie
			// "ist Teilmenge von X", bei Integer gegen Not(0) nicht. Integer ist keine Teilmenge
			// von 0, enthält 0 aber, ist also unzulässig. Deshalb dieser Fall zusätzlich zu
			// not-type-is-checked.
			name: 'not-type-is-checked-for-set-types',
			code: 'f = (x: Integer) => modulo(1 x)',
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 31,
					"endRowIndex": 0,
					"message": "Can not assign Integer to Not(0).",
					"startColumnIndex": 20,
					"startRowIndex": 0,
				},
			],
		},
		{
			// PositiveInteger ist And(Integer Greater(0)) und damit nie 0, passt also zu
			// NonZeroInteger. Kein einzelner der beiden Choices reicht dafür aus: Integer
			// scheitert an Not(0), Greater(0) an Integer. Erst das Zerlegen des targets zeigt es.
			name: 'not-type-accepts-intersection-without-single-matching-choice',
			code: 'f = (x: PositiveInteger) => modulo(1 x)',
		},
		//#endregion Not
		//#region generische Rückgabetypen
		{
			// slice liefert eine Teilliste, der Elementtyp bleibt also erhalten: aus
			// List(Integer) wird Or([] List(Integer)), nicht Or([] List(Any)).
			// Der Verlust wird erst über filterMap sichtbar, dessen Rückgabetyp
			// Or([] List(Without(callback/ReturnType []))) ist: aus einem Any wird dabei
			// Not(Empty), und das passt zu keinem konkreten Elementtyp mehr.
			name: 'slice-keeps-element-type',
			code: `f = (values: List(Integer)) :> Or([] List(Integer)) =>
	sliced = values.slice(1)
	sliced.filterMap((value) => value)`,
		},
		//#endregion generische Rückgabetypen
	];

describe('Checker', () => {
	expectedResults.forEach(({ name, code, result, errors }) => {
		it(name ?? code, () => {
			const parserResult = parseCode(code, 'dummy.jul');
			checkTypes(parserResult, {});
			expect(parserResult.checked?.errors).to.deep.equal(errors ?? []);
			if (result) {
				expect(parserResult.checked?.expressions).to.deep.equal(result);
			}
		});
	});
	// Die core-lib ist der beste Einzelindikator für die Grammatik: gut 1000 Zeilen
	// realistischer JUL-Code mit Parameterlisten, FunctionTypeLiterals, DictionaryTypes,
	// Spread/Rest, Multiline und Interpolation. Fehler dort werden sonst still ignoriert.
	it('core-lib parses without errors', () => {
		expect(parseFile(coreLibPath).unchecked.errors).to.deep.equal([]);
	});
});