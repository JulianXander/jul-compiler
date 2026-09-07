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
	/** Erwartete Parse-Fehler. Ohne Angabe muss der Code fehlerfrei parsen. */
	parseErrors?: CompilerError[];
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
			code: '?([])\n\t4',
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
		{
			// Der Params-Typ wird gegen die Argumentkollektion geprüft, und die ist List,
			// Dictionary oder Empty. Integer kann das nie sein, die Funktion ist also nicht
			// aufrufbar — unabhängig davon, ob sie je in einem branching auftaucht.
			name: 'params-type-must-be-collection',
			code: 'f = Integer => 0',
			errors: [
				{
					"code": ErrorCode.paramsTypeIsNotCollection,
					"endColumnIndex": 11,
					"endRowIndex": 0,
					"message": "Expected the params type to describe an argument collection. Did you mean [Integer]?",
					"startColumnIndex": 4,
					"startRowIndex": 0,
				},
			],
		},
		{
			// Gegenprobe: gewickelt ist derselbe Typ aufrufbar.
			name: 'params-type-collection-is-callable',
			code: `f = [Integer] => 0
f(1)`,
		},
		{
			// Empty ist die Kollektion eines Aufrufs ohne Argumente und damit gültig.
			name: 'params-type-empty-is-collection',
			code: `f = Empty => 0
f()`,
		},
		{
			// Never ist unbewohnt, es gibt also keinen Wert, der keine Kollektion sein könnte.
			// Schreibbar ist Never nicht, es entsteht nur aus Typarithmetik — ein Fehler hier
			// träfe niemanden, der etwas Falsches geschrieben hat.
			name: 'params-type-never-is-not-reported',
			code: 'f = And(Integer Text) => 0',
		},
		{
			// Unwissen ist keine Ablehnung: ein nicht auflösbarer Params-Typ darf nicht gemeldet
			// werden, sonst wird aus "nicht entscheidbar" ein "passt nicht".
			name: 'params-type-unknown-is-not-reported',
			code: `T = Any
f = T => 0`,
		},
		//#region branch narrowing
		// ? ist ein Präfix-Operator mit runder Argumentliste, ein Typ-Kopf prüft ausnahmslos
		// gegen die Argumentkollektion, und der gebranchte Wert ist deren Element 0.
		// Die Verengung schneidet (sie ersetzt nicht).
		{
			// Der catchAll () => ... bindet nichts und matcht jeden Wert, sagt über den Wert
			// also nichts aus. countdown behält daher Integer und ist weiter an einen
			// Integer-Parameter zuweisbar. Vgl. jul-examples/fibonacci/fibonacci.jul.
			name: 'branch-narrowing-catch-all',
			code: `g = (x: Integer) => x
f = (countdown: Integer) =>
	?(countdown)
		[0] => 0
		() => g(countdown)`,
		},
		{
			// Die Parameterliste beschreibt die Argumentkollektion, der 1. Parameter bekommt
			// also das 1. Argument. Verengt wird auf dessen Typ, nicht auf die Liste als Ganzes.
			name: 'branch-narrowing-named-param',
			code: `g = (x: Integer) => x
f = (countdown: Integer) =>
	?(countdown)
		[0] => 0
		(y: Integer) => g(countdown)`,
		},
		{
			// Ohne Einzelparameter bekommt der rest die ganze Kollektion, also [countdown].
			// Verengt wird daher auf den Elementtyp der rest-Liste, hier Integer.
			name: 'branch-narrowing-rest-param',
			code: `g = (x: Integer) => x
f = (countdown: Integer) =>
	?(countdown)
		[0] => 0
		(...rest: List(Integer)) => g(countdown)`,
		},
		{
			// Ein Parameter ohne TypeGuard hat den Typ Any, das darf nicht verbreitern.
			name: 'branch-narrowing-untyped-param',
			code: `g = (x: Integer) => x
f = (countdown: Integer) =>
	?(countdown)
		[0] => 0
		(y) => g(countdown)`,
		},
		{
			// Any matcht auch die Kollektion und bleibt daher ungewickelt. Verbreitern darf
			// es nicht, der Schnitt behält Integer.
			name: 'branch-narrowing-any-branch',
			code: `g = (x: Integer) => x
f = (countdown: Integer) =>
	?(countdown)
		[0] => 0
		Any => g(countdown)`,
		},
		{
			// Ein Typ-Kopf bindet nichts und prüft die Kollektion. Verengt wird auf sein
			// Element 0: someVar wird hier zu Integer.
			name: 'branch-narrowing-type-param',
			code: `g = (x: Integer) => x
f = (someVar: Any) =>
	?(someVar)
		[Integer] => g(someVar)
		() => 0`,
		},
		{
			// Distributivgesetz: And(Or(Text Integer) Text) => Or(Text Never) => Text
			name: 'branch-narrowing-union',
			code: `t = (x: Text) => x
f = (someVar: Or(Text Integer)) =>
	?(someVar)
		(y: Text) => t(someVar)
		() => §§`,
		},
		{
			// Kein Auto-Spread mehr: ein geschriebenes Argument bleibt ein Argument, auch wenn
			// es eine Collection ist. Der 1. Parameter bekommt die ganze Liste.
			name: 'branch-binds-whole-collection',
			code: `h = (x: List(Integer)) => x
f = (someVar: List(Integer)) =>
	?(someVar)
		(a: List(Integer)) => h(a)
		() => []`,
		},
		{
			// Gegenstück: gespreadet wird nur mit geschriebenem ..., dann beschreiben die
			// Parameter die Elemente.
			name: 'branch-spread-binds-elements',
			code: `g = (x: Integer) => x
f = (pair: [Integer Integer]) =>
	?(...pair)
		(a: Integer b: Integer) => g(a)
		() => 0`,
		},
		{
			// Gegenprobe: die Verengung muss auch wirklich greifen. Im Text-Branch ist someVar
			// auf Text verengt und damit nicht mehr an einen Integer-Parameter zuweisbar.
			name: 'branch-narrowing-applies',
			code: `g = (x: Integer) => x
f = (someVar: Or(Text Integer)) =>
	?(someVar)
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
		{
			// _branch probiert die branches der Reihe nach. Wer den Empty-branch passiert hat,
			// kann kein Empty mehr sein — die Verengung muss die Typen der vorherigen branches
			// also abziehen. Siehe yugioh/src/main.jul beim loadGame-Event.
			name: 'branch-narrowing-excludes-previous-branches',
			code: `g = (x: Integer) => x
f = (value: Or([] Integer)) =>
	?(value)
		[Empty] => 0
		Any => g(value)`,
		},
		{
			// Gegenprobe: ohne vorherigen branch bleibt Empty möglich und muss gemeldet werden.
			// Die Verengung darf also nicht pauschal Empty abziehen.
			name: 'branch-narrowing-keeps-unhandled-types',
			code: `g = (x: Integer) => x
f = (value: Or([] Integer)) =>
	?(value)
		Any => g(value)`,
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 17,
					"endRowIndex": 3,
					"message": "Can not assign Empty to Integer.",
					"startColumnIndex": 9,
					"startRowIndex": 3,
				},
			],
		},
		{
			// Ein leerer Wert ist kein leeres Argument: ?(value) schreibt ein Argument, die
			// Kollektion ist also [()] und der passende Kopf [Empty], nicht Empty.
			name: 'branch-empty-value-is-one-argument',
			code: `f = (value: Or([] Integer)) =>
	?(value)
		[Empty] => 0
		Any => 1`,
		},
		{
			// Umgekehrt: ohne geschriebenes Argument ist die Kollektion selbst Empty.
			name: 'branch-empty-collection-matches-empty-head',
			code: `?()
	Empty => 0
	() => 1`,
		},
		{
			// Ein Kopf, der keine Argumentkollektion sein kann, ist eine nicht aufrufbare
			// Funktion — gemeldet wird das an der Funktion, nicht am branching.
			name: 'branch-head-must-be-collection',
			code: `f = (x: Integer) =>
	?(x)
		Integer => 0
		() => 1`,
			errors: [
				{
					"code": ErrorCode.paramsTypeIsNotCollection,
					"endColumnIndex": 9,
					"endRowIndex": 2,
					"message": "Expected the params type to describe an argument collection. Did you mean [Integer]?",
					"startColumnIndex": 2,
					"startRowIndex": 2,
				},
			],
		},
		{
			// Noch nicht umgesetzt: die Verengung hängt an einem einfachen Namen, ein Feldpfad
			// ist ein nestedReference und hat kein Symbol zum Shadowen (TODO Zeile 34).
			// Der erwartete Fehler dokumentiert die Lücke — fällt er weg, ist sie geschlossen
			// und dieser Test gehört auf "keine Fehler" umgestellt.
			name: 'branch-narrowing-field-path-is-missing',
			code: `f = (d: [a: Or(Text Integer)]) =>
	?(d/a)
		(y: Integer) =>
			narrowed: Integer = d/a
			narrowed
		() => 0`,
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 26,
					"endRowIndex": 3,
					"message": "Can not assign Text to Integer.",
					"startColumnIndex": 3,
					"startRowIndex": 3,
				},
			],
		},
		{
			// Branching über mehrere Werte: Element i des Kopfes verengt das i-te Argument.
			name: 'branch-narrowing-multiple-values',
			code: `g = (x: Integer y: Integer) => x
f = (a: Or(Text Integer) b: Or(Text Integer)) =>
	?(a b)
		[Integer Integer] => g(a b)
		() => 0`,
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
		{
			// Ein generischer Rückgabetyp muss auch dann noch auflösbar sein, wenn der Wert
			// vorher durch ein branching gelaufen ist. Die Union der branch Rückgabetypen
			// enthält im rawType noch das unaufgelöste TypeOf(values)/ElementType aus slice,
			// und der folgende filterMap-Aufruf leitet seinen Callback-Parametertyp aus genau
			// diesem rawType ab. Scheitert das, wird der Elementtyp zu Any und über
			// Without(Any []) zu Not(Empty).
			// Siehe yugioh/src/game-logic/game-logic.jul getThisTurnInputs.
			name: 'generic-return-type-survives-branching',
			code: `f = (values: List(Integer) flag: Boolean) :> Or([] List(Integer)) =>
	picked = ?(flag)
		[true] => values.slice(1)
		[false] => values
	picked.filterMap((value) => value)`,
		},
		{
			// map liefert laut Implementierung nur dann empty, wenn schon die Eingabe empty war.
			// Empty ist ein eigener Typ, List und Tuple schließen es also aus: für beide darf
			// im Ergebnis kein Empty stehen.
			// Siehe yugioh/src/game-logic/game-logic.jul removeGameCardIdsFromCardRow.
			name: 'map-adds-no-empty-for-list',
			code: `f = (values: List(Integer)) :> List(Integer) =>
	values.map((value) => value)`,
		},
		{
			// Zusätzlich zum Empty muss bei einem Tuple die Arity erhalten bleiben: map bildet
			// elementweise ab, die Länge ändert sich nicht.
			name: 'map-keeps-tuple-arity',
			code: `T = [Integer Integer]
f = (values: T) :> T =>
	values.map((value) => value)`,
		},
		{
			// Gegenprobe: kann die Eingabe empty sein, ist das Empty im Ergebnis korrekt.
			name: 'map-keeps-empty-for-possibly-empty-input',
			code: `f = (values: Or([] List(Integer))) :> Or([] List(Integer)) =>
	values.map((value) => value)`,
		},
		//#endregion generische Rückgabetypen
		//#region dereference
		{
			// Ein Feld, das der Dictionary-Typ nicht hat, ist ein Fehler und nicht Any.
			// Der stille Rückfall auf Any schaltet in getTypeError alle Folgeprüfungen ab,
			// ein einziger blinder Ausdruck macht damit die ganze Kette darunter blind.
			// Der Fehler sitzt auf dem Schlüssel, wie beim Destructuring.
			name: 'unknown-dictionary-field',
			code: `d = [a = 1]
d/b`,
			errors: [
				{
					"code": ErrorCode.dereferenceFailed,
					"endColumnIndex": 3,
					"endRowIndex": 1,
					"message": "Failed to dereference b in type [a: 1]",
					"startColumnIndex": 2,
					"startRowIndex": 1,
				},
			],
		},
		{
			// Gegenprobe: ein vorhandenes Feld darf nicht melden.
			name: 'known-dictionary-field',
			code: `d = [a = 1]
d/a`,
		},
		{
			// Gegenprobe: bei Any kann der Checker nicht wissen, ob es das Feld gibt.
			// "weiß ich nicht" darf nicht zu "gibt es nicht" werden.
			name: 'dictionary-field-on-unknown-type',
			code: `f = (d: Any) => d/b`,
		},
		{
			// Die Länge eines Tuples ist bekannt, ein Zugriff dahinter also nachweisbar falsch.
			// Indizes sind 1-basiert.
			name: 'index-out-of-tuple-range',
			code: `a = [1 2]
a/5`,
			errors: [
				{
					"code": ErrorCode.dereferenceFailed,
					"endColumnIndex": 3,
					"endRowIndex": 1,
					"message": "Failed to dereference 5 in type [1 2]",
					"startColumnIndex": 2,
					"startRowIndex": 1,
				},
			],
		},
		{
			// Gegenprobe: ein gültiger Index darf nicht melden.
			name: 'index-in-tuple-range',
			code: `a = [1 2]
a/2`,
		},
		{
			// Gegenprobe: eine List hat keine bekannte Länge, dort ist kein Index zu weit.
			name: 'index-on-list',
			code: `f = (x: List(Integer)) => x/5`,
		},
		{
			// Ein Index kleiner 1 ist ungültig, nicht "daneben" — der Parser meldet das bereits.
			// Der Checker darf nicht zusätzlich dereferenceFailed melden.
			name: 'index-zero-reports-once',
			code: `a = [1 2]
a/0`,
			parseErrors: [
				{
					"code": ErrorCode.invalidIndexSyntax,
					"endColumnIndex": 3,
					"endRowIndex": 1,
					"message": "Invalid index 0, indexes start at 1",
					"startColumnIndex": 2,
					"startRowIndex": 1,
				},
			],
			errors: [
				{
					"code": ErrorCode.invalidIndexSyntax,
					"endColumnIndex": 3,
					"endRowIndex": 1,
					"message": "Invalid index 0, indexes start at 1",
					"startColumnIndex": 2,
					"startRowIndex": 1,
				},
			],
		},
		//#endregion dereference
		//#region Aufruf
		{
			// Ein Wert, der keine Funktion ist, kann nicht aufgerufen werden. Heute liefert
			// getParamsType dafür Any, damit ist auch die Argumentprüfung wirkungslos und der
			// Fehler bleibt still. Die Meldung folgt dem Muster von branchIsNotFunction.
			// Der Fehler sitzt auf dem aufgerufenen Ausdruck, nicht auf dem ganzen Aufruf.
			name: 'call-of-non-function',
			code: `a = 1
a(1)`,
			errors: [
				{
					"code": ErrorCode.valueIsNotFunction,
					"endColumnIndex": 1,
					"endRowIndex": 1,
					"message": "Expected a function to call.\nCan not assign 1 to Any :> Any.",
					"startColumnIndex": 0,
					"startRowIndex": 1,
				},
			],
		},
		{
			// Gegenprobe: der Aufruf einer Funktion darf nicht melden.
			name: 'call-of-function',
			code: `a = (x: Integer) => x
a(1)`,
		},
		{
			// Gegenprobe: bei Any kann der Checker nicht wissen, ob der Wert aufrufbar ist.
			name: 'call-of-unknown-type',
			code: `f = (a: Any) => a(1)`,
		},
		{
			// Argumente werden auch dann geprüft, wenn der Aufruf selbst ungültig ist —
			// sie sind eigene Ausdrücke mit eigenen Fehlern.
			name: 'call-of-non-function-still-checks-arguments',
			code: `g = (x: Text) => x
a = 1
a(g(5))`,
			errors: [
				{
					"code": ErrorCode.valueIsNotFunction,
					"endColumnIndex": 1,
					"endRowIndex": 2,
					"message": "Expected a function to call.\nCan not assign 1 to Any :> Any.",
					"startColumnIndex": 0,
					"startRowIndex": 2,
				},
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 6,
					"endRowIndex": 2,
					"message": "Can not assign 5 to Text.",
					"startColumnIndex": 2,
					"startRowIndex": 2,
				},
			],
		},
		//#endregion Aufruf
		{
			// Ein generischer Parameter vom Typ Type muss als Typargument zulässig sein.
			name: 'type-parameter-as-type-argument',
			code: 'f = (T: Type) => Stream(T)',
		},
		{
			// Gegenprobe zu isCoreLibPath: in einer normalen Datei muss das Überschreiben
			// eines core-lib Namens weiterhin ein Fehler sein.
			name: 'redefinition-of-core-lib-name-still-errors',
			code: 'add = 4',
			errors: [
				{
					"code": ErrorCode.alreadyDefinedInUpperScope,
					"endColumnIndex": 7,
					"endRowIndex": 0,
					"message": "add is already defined in upper scope",
					"startColumnIndex": 0,
					"startRowIndex": 0,
				},
			],
		},
	];

describe('Checker', () => {
	expectedResults.forEach(({ name, code, result, errors, parseErrors }) => {
		it(name ?? code, () => {
			const parserResult = parseCode(code, 'dummy.jul');
			checkTypes(parserResult, {});
			// Sonst gilt ein Syntaxfehler als bestandener Checker Test, weil der Checker auf dem
			// unvollständigen Baum schlicht nichts zu melden hat.
			expect(parserResult.unchecked.errors).to.deep.equal(parseErrors ?? []);
			expect(parserResult.checked?.errors).to.deep.equal(errors ?? []);
			if (result) {
				expect(parserResult.checked?.expressions).to.deep.equal(result);
			}
		});
	});
	// Gegenstück zu 'core-lib parses without errors' für die Checker Stufe.
	// Regression: Die core-lib definiert die builtInSymbols selbst und muss daher ohne oberen
	// Scope gecheckt werden. Sonst stand ihre Symboltabelle doppelt im Scope Stack und jede
	// Definition wurde als alreadyDefinedInUpperScope gemeldet (94 Scheinfehler im Editor).
	it('core-lib checks without errors', () => {
		const parsed = parseFile(coreLibPath);
		checkTypes(parsed, {});
		expect(parsed.checked!.errors).to.deep.equal([]);
	});
});