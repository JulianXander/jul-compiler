import { expect } from 'chai';

import { ParseExpression, ParseSingleDefinition } from '../syntax-tree.js';
import { CompilerError, ErrorCode } from '../compiler-errors.js';
import { coreLibPath, parseCode, parseFile } from '../parser/parser.js';
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
		//#region Params-Typ
		{
			// Ein Typ als Params-Typ ist zulässig, die Funktion bleibt aufrufbar.
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
			// Dieselbe Regel am branch: ein Kopf, der keine Argumentkollektion sein kann, ist
			// eine nicht aufrufbare Funktion — gemeldet an der Funktion, nicht am branching.
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
		//#endregion Params-Typ
		//#region branching: Bindung
		// ? ist ein Präfix-Operator mit runder Argumentliste: ein Kopf prüft ausnahmslos gegen
		// die Argumentkollektion, und der gebranchte Wert ist deren Element 0.
		{
			// Ein branch ist eine Funktion — ein anderer Wert kann nicht matchen.
			name: 'branch-non-function-error',
			code: '?([])\n\t4',
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
		//#endregion branching: Bindung
		//#region branching: Verengung
		// Die Verengung schneidet (sie ersetzt nicht) und wirkt auf den gebundenen Wert.
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
			// also abziehen.
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
			// Branching über mehrere Werte: Element i des Kopfes verengt das i-te Argument.
			name: 'branch-narrowing-multiple-values',
			code: `g = (x: Integer y: Integer) => x
f = (a: Or(Text Integer) b: Or(Text Integer)) =>
	?(a b)
		[Integer Integer] => g(a b)
		() => 0`,
		},
		{
			// Ein Feldpfad als Branch-Argument verengt die Quelle: im Integer-Zweig ist d/a auf
			// Integer verengt, also auch beim erneuten Lesen.
			name: 'branch-narrowing-through-field-path',
			code: `f = (d: [a: Or(Text Integer)]) =>
	?(d/a)
		(y: Integer) =>
			narrowed: Integer = d/a
			narrowed
		() => 0`,
		},
		{
			// Die Verengung wirkt auch rückwärts auf die Quelle: dass stepType ein Text ist,
			// beweist, dass step nicht empty ist — Empty hat kein Feld type. Auch über die
			// Zwischenvariable hinweg, denn ein Name bezeichnet in JUL genau einen Wert.
			name: 'branch-narrowing-reaches-source-of-field',
			code: `g = (q: Text) => q
Step = [
	type: Text
	query: Text
]
getStep = (flag: Boolean) :> Or([] Step) =>
	?(flag)
		[true] => [
			type = §a§
			query = §b§
		]
		() => []
f = (flag: Boolean) =>
	step = getStep(flag)
	stepType = step/type
	?(stepType)
		[Text] => g(step/query)
		() => §§`,
		},
		{
			// Gegenprobe: die Verengung darf nur an einem Namen hängen. Zwei Aufrufe sind zwei
			// Werte — vom Typ des einen folgt nichts über den anderen.
			name: 'branch-narrowing-needs-a-name-as-source',
			code: `g = (q: Text) => q
Step = [
	type: Text
	query: Text
]
getStep = (flag: Boolean) :> Or([] Step) =>
	?(flag)
		[true] => [
			type = §a§
			query = §b§
		]
		() => []
f = (flag: Boolean) =>
	?(getStep(flag)/type)
		[Text] => g(getStep(flag)/query)
		() => §§`,
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 34,
					"endRowIndex": 14,
					"message": "Can not assign Empty to Text.",
					"startColumnIndex": 12,
					"startRowIndex": 14,
				},
			],
		},
		{
			// Gegenprobe: jeder branch verengt für sich. Im Text-Zweig ist d/a Text und damit
			// nicht an Integer zuweisbar, obwohl ein vorheriger Zweig auf Integer verengt hat.
			name: 'branch-narrowing-field-path-is-per-branch',
			code: `f = (d: [a: Or(Text Integer)]) =>
	?(d/a)
		(y: Integer) => 0
		(y: Text) =>
			narrowed: Integer = d/a
			narrowed
		() => 0`,
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 26,
					"endRowIndex": 4,
					"message": "Can not assign Text to Integer.",
					"startColumnIndex": 3,
					"startRowIndex": 4,
				},
			],
		},
		{
			// Gegenprobe: Any sagt über den Wert nichts aus, der Schnitt darf also nicht
			// verbreitern — d/a bleibt Or(Text Integer).
			name: 'branch-narrowing-field-path-any-does-not-widen',
			code: `f = (d: [a: Or(Text Integer)]) =>
	?(d/a)
		(y: Any) =>
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
			// Gegenprobe: die Verengung gilt nur im Rumpf des branches. Danach ist d/a wieder
			// Or(Text Integer) — das verengte Symbol liegt im Scope des branches, nicht außen.
			name: 'branch-narrowing-field-path-ends-with-the-branch',
			code: `f = (d: [a: Or(Text Integer)]) =>
	?(d/a)
		(y: Integer) => 0
		() => 0
	narrowed: Integer = d/a
	narrowed`,
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 24,
					"endRowIndex": 4,
					"message": "Can not assign Text to Integer.",
					"startColumnIndex": 1,
					"startRowIndex": 4,
				},
			],
		},
		{
			// Ein innerer branch sieht die Verengung des äußeren.
			name: 'branch-narrowing-field-path-in-nested-branching',
			code: `g = (n: Integer) => n
getD = (flag: Boolean) =>
	?(flag)
		[true] => [a = 1]
		() => [a = §x§]
f = (flag: Boolean) =>
	d = getD(flag)
	?(d/a)
		(y: Integer) =>
			?(flag)
				[true] => g(d/a)
				() => 0
		() => 0`,
		},
		{
			// Auch ein mehrstufiger Pfad verengt: der Fakt liegt auf d/a/b, gelesen wird
			// derselbe Pfad.
			name: 'branch-narrowing-deep-field-path',
			code: `g = (n: Integer) => n
getD = (flag: Boolean) =>
	?(flag)
		[true] => [a = [b = 1]]
		() => [a = [b = §x§]]
f = (flag: Boolean) =>
	d = getD(flag)
	?(d/a/b)
		(y: Integer) => g(d/a/b)
		() => 0`,
		},
		{
			// Ist die Quelle vom Typ Any, weiß der Checker über ihre Felder nichts. Der
			// Schnitt aus Any und dem Fakt [index: ...] darf daher nicht heißen, dass s nur
			// noch dieses eine Feld hat - sonst gilt jedes andere Feld (hier boards) als Empty.
			name: 'branch-narrowing-through-any-source-keeps-other-fields',
			code: `start: [boards: Integer index: Or([] Integer)] = [boards = 1 index = 1]
s = assume(start Any)
?(s/index)
	[Integer] => 0
	() =>
		boardsValue: Integer = s/boards`,
			errors: [],
		},
		{
			// Der Schnitt aus einem vollstaendig bekannten Typ und einem unvollstaendigen Fakt
			// (aus der Verengung ueber einen Feldpfad) darf den vollstaendigen Typ nicht ersetzen.
			// card/face wird auf §up§ verengt, das erzeugt fuer card den Fakt [face: §up§] mit
			// complete: false. Der ist "zuweisbar an" Card (fehlende Felder gelten als unbekannt),
			// der Teilmengen-Shortcut in createNormalizedIntersectionType gibt ihn deshalb
			// wholesale zurueck statt die Felder zu vereinigen - dataId geht beim Spread verloren.
			name: 'branch-narrowing-field-fact-does-not-replace-known-type',
			code: `Card = [
	dataId: Text
	face: Or([] Text)
]
getCard = () :> Card =>
	assume([dataId = §a§ face = []] Card)
card = getCard()
?(card/face)
	[§up§] =>
		newCard: Card = [
			...card
			face = §up§
		]
	() => card`,
			errors: [],
		},
		{
			// Bekannte Luecke: aggregate (core-lib.jul) ist nicht generisch ueber den
			// Akkumulator (initialValue: Any, callback: (accumulator: Any ...) :> Any). Ein
			// konkret getypter Startwert wird beim Durchreichen zu Any, ein darauf gebranchtes
			// Feld kennt danach nur noch Not(X) statt seines echten deklarierten Typs - der
			// Teilmengen-Merge von oben kann das nicht heilen, weil hier gar kein zweiter,
			// vollstaendig bekannter Typ mehr da ist, mit dem zusammengefuehrt werden koennte.
			name: 'aggregate-erases-accumulator-type-through-any',
			code: `State = [index: Or([] Integer)]
getState = () :> State => assume([] State)
values = [1 2 3]
combined = values.aggregate(getState() (accumulator value index) => accumulator)
?(combined/index)
	[Integer] => 0
	() =>
		result: Or([] Integer) = combined/index
		result`,
			errors: [],
		},
		//#endregion branching: Verengung
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
			name: 'generic-return-type-survives-branching',
			code: `f = (values: List(Integer) flag: Boolean) :> Or([] List(Integer)) =>
	picked = ?(flag)
		[true] => values.slice(1)
		[false] => values
	picked.filterMap((value) => value)`,
		},
		{
			// Branching innerhalb des filterMap-callback selbst: callback/ReturnType wird zu
			// Or(Integer Empty), Without(... Empty) muss davon Integer übrig lassen. Statt
			// dessen wird der Parametertyp offenbar zu Never aufgelöst, sobald values ein
			// Funktionsparameter ist (ein Literal oder eine lokale Variable mit derselben
			// Deklaration lösen den Fehler nicht aus).
			name: 'generic-return-type-survives-branching-inside-callback',
			code: `f = (values: List(Integer)) :> Or([] List(Integer)) =>
	values.filterMap(
		(value) =>
			?(value)
				[Integer] => value
				() => []
	)`,
		},
		{
			// map liefert laut Implementierung nur dann empty, wenn schon die Eingabe empty war.
			// Empty ist ein eigener Typ, List und Tuple schließen es also aus: für beide darf
			// im Ergebnis kein Empty stehen.
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
			// Aufgeschobener Zugriff: beim Prüfen von f ist d noch ein Platzhalter, der Zugriff
			// bleibt als Knoten stehen und wird erst am Aufruf aufgelöst. Ein bekanntes Feld
			// muss dabei seinen genauen Typ behalten.
			name: 'deferred-dictionary-field-keeps-exact-type',
			code: `f = (d: [a: Integer b: Text]) => d/b
y: Text = f([a = 1 b = §x§])`,
		},
		{
			// Gegenprobe zum vorigen: aufgelöst wird gegen den Argumenttyp, das Ergebnis ist
			// also das Textliteral und nicht die Vereinigung aller Felder.
			name: 'deferred-dictionary-field-is-not-union-of-all-fields',
			code: `f = (d: [a: Integer b: Text]) => d/b
y: Integer = f([a = 1 b = §x§])`,
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 31,
					"endRowIndex": 1,
					"message": "Can not assign §x§ to Integer.",
					"startColumnIndex": 0,
					"startRowIndex": 1,
				},
			],
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
			// Ohne bekannte Länge ist die Position aber auch nicht beweisbar vorhanden: eine
			// List kann ein einziges Element haben, Empty gehört also in den Typ.
			name: 'index-on-list-may-be-empty',
			code: `f = (x: List(Integer)) => x/5
y: Integer = f([1 2])`,
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 21,
					"endRowIndex": 1,
					"message": "Can not assign Empty to Integer.",
					"startColumnIndex": 0,
					"startRowIndex": 1,
				},
			],
		},
		//#endregion dereference
		//#region Zugriffstypen
		// getElement deklariert seinen Rückgabetyp über ElementAt, die Präzision hängt also
		// nicht mehr am Funktionsnamen. Von der genauesten Lage zur unbestimmtesten sortiert.
		{
			// Ein Literal-Index in ein Tuple kennt seine Position exakt: Text, nicht die
			// Vereinigung aller Positionen und kein Empty.
			name: 'get-element-literal-index-in-tuple',
			code: `x: Text = [1 §a§].getElement(2)`,
		},
		{
			// Ein Literal-Index hinter dem Ende eines bekannten Tuples trifft nachweisbar
			// nichts. getElement meldet das nicht (ein berechneter Index darf danebenliegen),
			// liefert aber Empty statt der Vereinigung aller Positionen.
			name: 'get-element-index-out-of-tuple-range-is-empty',
			code: `x: [] = [1 §a§].getElement(5)`,
		},
		{
			// Jeder Choice eines Union-Index ist ein eigener Zugriff. Trifft jeder von ihnen
			// eine vorhandene Position, gehört kein Empty ins Ergebnis. Der Index muss dafür
			// als Variable mit Union-Typ ankommen — ein Literal-Argument wäre schon verengt.
			name: 'get-element-union-index-in-tuple-range',
			code: `f = (index: Or(1 2)) =>
	values: [Integer Text] = [1 §a§]
	element: Or(Integer Text) = values.getElement(index)
	element`,
		},
		{
			// Gegenprobe: liegt ein Choice daneben, steuert er Empty bei.
			name: 'get-element-union-index-partly-out-of-range',
			code: `f = (index: Or(2 5)) =>
	values: [Integer Text] = [1 §a§]
	element: Or([] Text) = values.getElement(index)
	element`,
		},
		{
			// Ohne Literal-Index steht die Position nicht fest: Vereinigung aller Positionen,
			// dazu Empty, weil der Index danebenliegen kann.
			name: 'get-element-non-literal-index',
			code: `f = (values: [Integer Text] index: PositiveInteger) => values.getElement(index)
y: Or([] Integer Text) = f([1 §a§] 1)`,
		},
		{
			// Kann die Quelle selbst empty sein, bleibt Empty im Ergebnis.
			name: 'get-element-on-possibly-empty-list',
			code: `f = (values: Or([] List(Integer))) => values.getElement(1)
y: Or([] Integer) = f([1])`,
		},
		{
			// ElementAt faltet den Zugriff schon in der Typposition.
			name: 'element-at-in-type-position',
			code: `x: ElementAt([Integer Text] 2) = §a§`,
		},
		{
			// Dieselbe Präzision steht Nutzercode offen: ein eigener Wrapper kann den genauen
			// Rückgabetyp deklarieren, statt ihn an getElement zu binden.
			name: 'element-at-in-user-function',
			code: `second = (values: List(Any)) :> ElementAt(TypeOf(values) 2) => values.getElement(2)
y: Text = [1 §a§].second()`,
		},
		//#endregion Zugriffstypen
		//#region Aufruf
		{
			// Infix-Aufruf: das prefixArgument wird zum 1. Argument.
			name: 'prefix-function-call',
			code: '4.log()',
		},
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
		//#region verworfene Werte
		{
			// Ein längerer Wert ist zulässig - ein Typ nennt Anforderungen, kein vollständiges
			// Bild. Die 2 steht aber im Quelltext und kommt nirgends an. Gemeldet wird der
			// überzählige Ausdruck selbst, damit der Leser sieht, was er löschen kann.
			name: 'call-surplus-argument-is-discarded',
			code: `f = (a: Integer) => a
f(1 2)`,
			errors: [
				{
					"code": ErrorCode.discardedValue,
					"endColumnIndex": 5,
					"endRowIndex": 1,
					"message": "This value is discarded. Expected 1 argument, got 2.",
					"startColumnIndex": 4,
					"startRowIndex": 1,
				},
			],
		},
		{
			// Jeder überzählige Ausdruck ist einzeln löschbar und wird einzeln gemeldet.
			name: 'every-surplus-argument-is-reported',
			code: `f = (a: Integer) => a
f(1 2 3)`,
			errors: [
				{
					"code": ErrorCode.discardedValue,
					"endColumnIndex": 5,
					"endRowIndex": 1,
					"message": "This value is discarded. Expected 1 argument, got 3.",
					"startColumnIndex": 4,
					"startRowIndex": 1,
				},
				{
					"code": ErrorCode.discardedValue,
					"endColumnIndex": 7,
					"endRowIndex": 1,
					"message": "This value is discarded. Expected 1 argument, got 3.",
					"startColumnIndex": 6,
					"startRowIndex": 1,
				},
			],
		},
		{
			// Ein Spread verschiebt die Zuordnung unbekannt weit: welcher Wert überzählig wäre,
			// steht nicht im Quelltext, und zu löschen gäbe es nichts.
			name: 'spread-argument-is-not-discarded',
			code: `values = [1 2 3]
f = (a: Integer) => a
f(...values)`,
		},
		{
			// Eine Variable darf legitim mehr enthalten, als die Parameterliste fordert - das ist
			// die Regel der Sprache, und im Quelltext steht an dieser Stelle nichts zu löschen.
			name: 'variable-with-longer-tuple-is-not-discarded',
			code: `v = [1 2 3]
f = (a: Integer) => a
f(...v)`,
		},
		{
			// Die Werteliste gehört dem branching, nicht einem einzelnen branch: ein späterer
			// branch darf das zweite Element aufnehmen.
			name: 'branch-value-list-is-not-discarded',
			code: `x = ?(1 2)
	(a: Integer) => a`,
		},
		{
			// Der Rest-Parameter nimmt alles auf, überzählig ist damit nichts.
			name: 'rest-parameter-consumes-surplus',
			code: `f = (...args: Or([] List(Integer))) => args
f(1 2 3)`,
		},
		{
			// Gegenprobe: genau so viele Argumente wie Parameter meldet nicht.
			name: 'matching-argument-count-is-not-discarded',
			code: `f = (a: Integer b: Integer) => a
f(1 2)`,
		},
		{
			// Dasselbe für ein Dictionary-Literal als Argumentkollektion: b kommt nirgends an,
			// weil die Parameterliste kein b hat. Gemeldet wird das ganze Feld, denn das ist
			// die Einheit, die gelöscht wird.
			name: 'call-surplus-named-argument-is-discarded',
			code: `f = (a: Integer) => a
f(a = 1 b = 2)`,
			errors: [
				{
					"code": ErrorCode.discardedValue,
					"endColumnIndex": 13,
					"endRowIndex": 1,
					"message": "This value is discarded. There is no parameter named b.",
					"startColumnIndex": 8,
					"startRowIndex": 1,
				},
			],
		},
		{
			// Eine Zuweisung verwirft nichts: der TypeGuard prüft, er formt nicht um. x behält
			// den Typ des Werts samt drittem Element, x/3 bleibt lesbar und das emittierte JS
			// enthält alle drei. Nur der Aufruf lässt überzählige Werte fallen.
			name: 'assignment-discards-nothing',
			code: 'x: [Integer Integer] = [1 2 3]',
		},
		{
			// Dasselbe für Felder: x behält b, der TypeGuard schneidet es nicht weg.
			// Vgl. jul-examples/type-checking-test.jul testDictionaryLiteral3a.
			name: 'assignment-keeps-surplus-field',
			code: 'x: [a: Integer] = [a = 1 b = 2]',
		},
		{
			// Gegenprobe: ein Feld, das die Parameterliste kennt, meldet nicht.
			name: 'known-named-argument-is-not-discarded',
			code: `f = (a: Integer b: Integer) => a
f(a = 1 b = 2)`,
		},
		{
			// Benannte Argumente gegen einen rest-Parameter sind nicht umgesetzt: der Checker
			// meldet es, und tryAssignArgs wirft zur Laufzeit. Der Test hält den Zustand fest -
			// verschwindet die Meldung, ist die Lücke geschlossen.
			name: 'named-arguments-with-rest-parameter-are-not-supported',
			code: `f = (a: Integer ...args: Or([] List(Any))) => a
f(a = 1 b = 2)`,
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 14,
					"endRowIndex": 1,
					"message": "Can not assign dictionary to rest parameter",
					"startColumnIndex": 0,
					"startRowIndex": 1,
				},
			],
		},
		{
			// Beim Destructuring hält keine Variable den ganzen Wert: _temp ist blocklokal, nur
			// die gebundenen Namen kommen heraus. b ist danach unerreichbar.
			name: 'destructuring-surplus-field-is-discarded',
			code: '(a) = [a = 1 b = 2]',
			errors: [
				{
					"code": ErrorCode.discardedValue,
					"endColumnIndex": 18,
					"endRowIndex": 0,
					"message": "This value is discarded. b is not destructured.",
					"startColumnIndex": 13,
					"startRowIndex": 0,
				},
			],
		},
		{
			// Gelesen wird über die Quelle, nicht über den neuen Namen: (x = a) bindet a.
			name: 'destructuring-alias-uses-source-name',
			code: '(x = a) = [a = 1 b = 2]',
			errors: [
				{
					"code": ErrorCode.discardedValue,
					"endColumnIndex": 22,
					"endRowIndex": 0,
					"message": "This value is discarded. b is not destructured.",
					"startColumnIndex": 17,
					"startRowIndex": 0,
				},
			],
		},
		{
			// Gegenprobe: alle Felder werden gebunden.
			name: 'destructuring-known-fields-are-not-discarded',
			code: '(a b) = [a = 1 b = 2]',
		},
		{
			// Eine Variable darf legitim mehr Felder haben, und zu löschen gäbe es hier nichts.
			name: 'destructuring-from-variable-is-not-discarded',
			code: `v = [a = 1 b = 2]
(a) = v`,
		},
		{
			// Löst ein gewünschter Name nicht auf, ist das die Ursache - dass a übrig bleibt,
			// ist nur ihre Folge. Gemeldet wird deshalb nur der Name, nicht zusätzlich das Feld.
			name: 'unresolved-destructuring-name-suppresses-discarded-warning',
			code: '(myA1 b) = [a = 1 b = 2]',
			errors: [
				{
					"code": ErrorCode.dereferenceFailed,
					"endColumnIndex": 5,
					"endRowIndex": 0,
					"message": "Failed to dereference myA1 in type [\n\ta: 1\n\tb: 2\n]",
					"startColumnIndex": 1,
					"startRowIndex": 0,
				},
			],
		},
		//#endregion verworfene Werte
		{
			// Ein generischer Parameter vom Typ Type muss als Typargument zulässig sein.
			name: 'type-parameter-as-type-argument',
			code: 'f = (T: Type) => Stream(T)',
		},
		{
			// Der functionType wird mit Platzhaltern erzeugt, an die Parameter-Symbole gehängt und
			// erst danach mutiert (ParamsType, ReturnType). Wer ihn zwischendurch auflöst - hier die
			// Selbstreferenz im body - darf kein Zwischenergebnis festhalten.
			name: 'recursive-function-return-type',
			code: `f = (x: Integer) :> Integer =>
	?(x)
		[0] => 0
		() => f(x)
g: Integer = f(3)`,
		},
		{
			// Noch nicht umgesetzt: bei der Selbstreferenz im body ist das Symbol f noch nicht
			// inferiert, dereferenceType fällt auf Any zurück (vgl. das TODO dort) und der
			// deklarierte Rückgabetyp wird nicht durchgereicht. g: Text = f(3) müsste melden.
			// Der Test hält die Lücke fest — fängt er an zu melden, ist sie geschlossen.
			name: 'recursive-function-return-type-is-not-checked',
			code: `f = (x: Integer) :> Integer =>
	?(x)
		[0] => 0
		() => f(x)
g: Text = f(3)`,
		},
		{
			// Ein Funktionsliteral, dessen body nur aus einem Kommentar besteht, ist ungültig -
			// der Parser meldet das aber nicht, und der Checker wirft daran:
			// "Cannot read properties of undefined (reading 'type')" in case 'functionLiteral',
			// weil last(expression.body) undefined ist und das ! darüber hinwegtäuscht.
			// Prinzip 8: halbfertiger Code ist der Normalfall, der Checker darf nicht werfen.
			// Beim Tippen entsteht der Zustand bei jedem Funktionsliteral, und im Sprachserver
			// fällt dann die Diagnostik für die ganze Datei aus.
			// Vgl. jul-examples/ui/dialog/dialog.jul, das deshalb nicht gecheckt werden kann.
			// Abgrenzung in parser.test.ts: function-without-body - ohne Folgezeile greift der Parser.
			name: 'function-with-only-comment-body-does-not-throw',
			code: 'f = () =>\n\t# TODO',
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
	expectedResults.forEach(({ name, code, result, errors }) => {
		it(name ?? code, () => {
			const parserResult = parseCode(code, 'dummy.jul');
			checkTypes(parserResult, {});
			// Sonst gilt ein Syntaxfehler als bestandener Checker Test, weil der Checker auf dem
			// unvollständigen Baum schlicht nichts zu melden hat.
			expect(parserResult.unchecked.errors).to.deep.equal([]);
			expect(parserResult.checked?.errors).to.deep.equal(errors ?? []);
			if (result) {
				expect(parserResult.checked?.expressions).to.deep.equal(result);
			}
		});
	});
	// Ein Index kleiner 1 ist ungültig, nicht "daneben" - der Parser meldet das bereits
	// (parser.test.ts: index-zero). Der Checker darf nicht zusätzlich dereferenceFailed melden.
	// Eigener Test, weil die Tabelle oben fehlerfrei parsenden Code voraussetzt.
	it('index-zero-reports-once', () => {
		const parsed = parseCode('a = [1 2]\na/0', 'dummy.jul');
		const parseErrors = parsed.unchecked.errors;
		expect(parseErrors, 'Parse-Fehler erwartet').to.have.lengthOf(1);
		checkTypes(parsed, {});
		expect(parsed.checked!.errors).to.deep.equal(parseErrors);
	});
	it('union-deduplicates-function-types', () => {
		// Zwei branches mit identischer Funktion als Rückgabetyp sollten nicht zu
		// Or(FunctionType FunctionType) führen, sondern zu einer einzigen FunctionType.
		// catchAll im 2. branch, damit das Ergebnis nicht durch das Error-in-Union-Verhalten
		// (branching ohne catchAll) verfälscht wird - das ist hier nicht das Thema des Tests.
		const code = `x = ?(5)
	[1] => (a) => a
	() => (a) => a`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);
		
		// Prüfe, dass der Rückgabetyp des Branchings kein 'or' Typ ist
		const definition = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		expect(definition).to.exist;
		expect(definition.value?.typeInfo?.type.julType).to.not.equal('or', 
			'Union sollte dedupliziert werden — erwarteter Typ: function, tatsächlich: ' + definition.value?.typeInfo?.type.julType);
		expect(definition.value?.typeInfo?.type.julType).to.equal('function');
	});
	// createNormalizedUnionType entfernt bisher nur exakte Duplikate (typeEquals), keine
	// Teilmengen wie booleanLiteral in Boolean: Or(Boolean False) bleibt 'or' statt zu 'boolean'
	// zu kollabieren. Sichtbar geworden über die Exhaustivitätsprüfung für branching ohne
	// catchAll: eine Boolean-wertige Prüfung schlug fehl, weil der Typ nicht als 'boolean'
	// erkannt wurde.
	it('union-collapses-boolean-literal-into-boolean', () => {
		const code = 'f = (x: Or(Boolean false)) => x';
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);

		const definition = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const paramsType = definition.value?.typeInfo?.type.julType === 'function'
			? definition.value.typeInfo.type.ParamsType
			: undefined;
		const paramType = paramsType?.julType === 'parameters' ? paramsType.singleNames[0]?.type : undefined;
		expect(paramType?.julType).to.equal('boolean',
			'Or(Boolean False) sollte zu Boolean kollabieren, tatsächlich: ' + paramType?.julType);
	});
	// createNormalizedUnionType entfernt Teilmengen nicht nur für Boolean, sondern allgemein.
	it('union-collapses-integer-literal-into-integer', () => {
		const code = 'f = (x: Or(Integer 5)) => x';
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);

		const definition = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const paramsType = definition.value?.typeInfo?.type.julType === 'function'
			? definition.value.typeInfo.type.ParamsType
			: undefined;
		const paramType = paramsType?.julType === 'parameters' ? paramsType.singleNames[0]?.type : undefined;
		expect(paramType?.julType).to.equal('integer',
			'Or(Integer 5) sollte zu Integer kollabieren, tatsächlich: ' + paramType?.julType);
	});
	// Gegenprobe: nicht verwandte Typen dürfen nicht fälschlich kollabiert werden.
	it('union-keeps-unrelated-choices', () => {
		const code = 'f = (x: Or(Text Integer)) => x';
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);

		const definition = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const paramsType = definition.value?.typeInfo?.type.julType === 'function'
			? definition.value.typeInfo.type.ParamsType
			: undefined;
		const paramType = paramsType?.julType === 'parameters' ? paramsType.singleNames[0]?.type : undefined;
		expect(paramType?.julType).to.equal('or',
			'Text und Integer dürfen nicht kollabieren, tatsächlich: ' + paramType?.julType);
	});
	// Fehlt ein catchAll-Branch, kann `_branch` zur Laufzeit ein Error zurückgeben (siehe
	// runtime.ts). Der Rückgabetyp muss das zeigen.
	it('branching-without-catchall-adds-error-to-union', () => {
		const code = `x = ?(5)
	[1] => §eins§
	[2] => §zwei§`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);

		const definition = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const type = definition.value?.typeInfo?.type;
		expect(type?.julType).to.equal('or',
			'Ohne catchAll muss Error Teil der Union sein — tatsächlich: ' + type?.julType);
		const choiceTypes = type?.julType === 'or' ? type.ChoiceTypes : [];
		expect(choiceTypes.some(choice => choice.julType === 'error')).to.equal(true,
			'Error fehlt in der Union: ' + choiceTypes.map(choice => choice.julType).join(', '));
	});
	// Gegenstück: Mit catchAll ist _branch nie ohne Match, Error gehört also nicht in den Typ.
	it('branching-with-catchall-has-no-error-in-union', () => {
		const code = `x = ?(5)
	[1] => §eins§
	() => §andere§`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);

		const definition = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const type = definition.value?.typeInfo?.type;
		// Zwei verschiedene Textliterale ergeben unabhängig vom catchAll ein 'or' — geprüft wird
		// hier nur, dass darin kein 'error' als Choice auftaucht.
		const choiceTypes = type?.julType === 'or' ? type.ChoiceTypes : [type];
		expect(choiceTypes.some(choice => choice?.julType === 'error')).to.equal(false,
			'Mit catchAll darf kein Error in der Union stehen: ' + choiceTypes.map(choice => choice?.julType).join(', '));
	});
	// Ohne catchAll, aber die branches decken den ganzen deklarierten Eingabetyp bereits ab -
	// _branch kann dann nie Error zurückgeben, das muss der Checker beweisen können.
	it('branching-without-catchall-but-exhaustive-has-no-error-in-union', () => {
		const code = `f = (x: Or(1 2)) => ?(x)
	[1] => §eins§
	[2] => §zwei§`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);

		const definition = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const returnType = definition.value?.typeInfo?.type.julType === 'function'
			? definition.value.typeInfo.type.ReturnType
			: undefined;
		const choiceTypes = returnType?.julType === 'or' ? returnType.ChoiceTypes : [returnType];
		expect(choiceTypes.some(choice => choice?.julType === 'error')).to.equal(false,
			'Vollständig abgedeckter Eingabetyp darf kein Error erzeugen: ' + choiceTypes.map(choice => choice?.julType).join(', '));
	});
	// Motivbeispiel: Fall 3 fehlt, ohne catchAll.
	it('branching-without-catchall-non-exhaustive-has-error-in-union', () => {
		const code = `f = (x: Or(1 2 3)) => ?(x)
	[1] => §eins§
	[2] => §zwei§`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);

		const definition = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const returnType = definition.value?.typeInfo?.type.julType === 'function'
			? definition.value.typeInfo.type.ReturnType
			: undefined;
		const choiceTypes = returnType?.julType === 'or' ? returnType.ChoiceTypes : [returnType];
		expect(choiceTypes.some(choice => choice?.julType === 'error')).to.equal(true,
			'Fall 3 fehlt, Error muss im Rückgabetyp stehen: ' + choiceTypes.map(choice => choice?.julType).join(', '));
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