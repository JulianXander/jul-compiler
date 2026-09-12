import { expect } from 'chai';

import { ParseExpression, ParseSingleDefinition } from '../syntax-tree.js';
import { CompilerError, ErrorCode } from '../compiler-errors.js';
import { coreLibPath, parseCode, parseFile } from '../parser/parser.js';
import { checkTypes } from './checker.js';
import { resolvePlaceholders, typeToString } from './checker.js';

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
					"message": "'a' is not defined.",
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
					"message": "'a' is used before it is defined.",
					"startColumnIndex": 0,
					"startRowIndex": 0,
				},
			],
		},
		{
			// Position zeigt seit findInnermostElementErrorPosition auf das falsche Element (4),
			// nicht mehr auf die ganze Definition.
			name: 'list-type-error',
			code: 'a: List(Text) = [4]',
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 18,
					"endRowIndex": 0,
					"message": "Definition type mismatch.\nCan not assign 4 to Text.",
					"startColumnIndex": 17,
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
					"message": "Argument type mismatch.\nCan not assign Text to Integer.",
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
					"message": "Argument type mismatch.\nCan not assign Empty to Integer.",
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
					"message": "Argument type mismatch.\nCan not assign Empty to Text.",
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
					"message": "Definition type mismatch.\nCan not assign Text to Integer.",
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
					"message": "Definition type mismatch.\nCan not assign Text to Integer.",
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
					"message": "Definition type mismatch.\nCan not assign Text to Integer.",
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
			// Not(X), das durch Branch-Narrowing auf einem Any-Ursprung entsteht, ist genauso
			// unwissend wie das Any davor - Any ist ueberall sonst permissiv als Quelle
			// (getTypeError gibt bei julType 'any' sofort undefined zurueck). Hier wird aus dem
			// Nichtwissen "koennte alles ausser Integer sein" faelschlich eine harte Ablehnung,
			// weil Not(Integer) einzeln gegen Empty und gegen Integer geprueft wird statt die
			// Any-Herkunft weiterzutragen. aggregate (core-lib.jul, Akkumulator: Any) zeigt
			// denselben Fehler, weil sein Rueckgabetyp ebenfalls durch Any erzeugt wird.
			name: 'narrowed-not-type-from-any-source-is-not-checked',
			code: `combined = assume([] Any)
?(combined/index)
	[Integer] => 0
	() =>
		result: Or([] Integer) = combined/index
		result`,
			errors: [],
		},
		{
			// Gegenprobe zu narrowed-not-type-from-any-source-is-not-checked: Not(X) darf nur
			// dann permissiv sein, wenn das Ziel mehr als X zulaesst. Ziel = Integer ist eine
			// Teilmenge von X = Integer, der Wert waere also garantiert ausgeschlossen.
			name: 'narrowed-not-type-still-errors-when-target-is-subset-of-excluded',
			code: `combined = assume([] Any)
?(combined/index)
	[Integer] => 0
	() =>
		result: Integer = combined/index
		result`,
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nCan not assign Not(Integer) to Integer.',
					startRowIndex: 4,
					startColumnIndex: 2,
					endRowIndex: 4,
					endColumnIndex: 34,
				},
			],
		},
		{
			// Ein Prädikat als Typ-Kopf. Die Laufzeit matcht hier bereits korrekt: _branch prüft
			// über getTypeError, und dort wird ein Funktionswert in Typ-Position aufgerufen
			// (runtime.ts, case 'function'). Der Checker schneidet stattdessen Or(Integer Text)
			// mit dem Funktionstyp und kommt auf Never - er erklärt den erreichbaren branch für
			// unerreichbar und meldet an lauffähigem Code JUL5050.
			// Verengt wird nur der true-Zweig: aus isInteger(x) == true folgt x ist Integer.
			// Die Gegenrichtung gilt nicht, deshalb sagt der catchAll darunter nichts aus.
			name: 'branch-narrowing-predicate-head',
			code: `isInteger = (x: Any) :> Boolean =>
	?(x)
		[Integer] => true
		() => false
g = (n: Integer) => n
f = (someVar: Or(Integer Text)) =>
	?(someVar)
		[isInteger] => g(someVar)
		() => 0`,
			errors: [],
		},
		{
			// Gegenrichtung: was ein späterer branch NICHT mehr sein kann. Dafür reicht
			// narrowsTo nicht - das sagt nur "höchstens diese Werte liefern true". Abziehen
			// darf man nur, was nachweislich true liefert: branches mit Rückgabetyp literal
			// true, abzüglich dessen, was frühere branches des Prädikats abfangen. Hier deckt
			// [Integer] => true ganz Integer ab, im catchAll bleibt also Text.
			name: 'branch-narrowing-predicate-head-false-branch',
			code: `isInteger = (x: Any) :> Boolean =>
	?(x)
		[Integer] => true
		() => false
g = (t: Text) => t
f = (someVar: Or(Integer Text)) =>
	?(someVar)
		[isInteger] => 0
		() => g(someVar)`,
			errors: [],
		},
		{
			// Phase 1a, nur Type-Akzeptanz (kein Narrowing): isInteger hat exakt die
			// erkannte Branching-Form (siehe branch-narrowing-predicate-head) und soll dort
			// als Type-Wert durchgehen, wo ein Type-Wert verlangt wird - hier als Argument
			// für einen Type-Parameter. Aktuell prüft checkTypeGuardIsType nur gegen
			// { julType: 'type' } und kennt PredicateFacts an Funktionstypen nicht, meldet
			// also JUL5002. Narrowing über diesen Weg (z.B. useType(isInteger) als Typ-Kopf
			// weiterverwenden) ist bewusst ein späterer Schritt.
			name: 'predicate-assignable-to-type-1a',
			code: `isInteger = (x: Any) :> Boolean =>
	?(x)
		[Integer] => true
		() => false
useType = (t: Type) => t
useType(isInteger)`,
			errors: [],
		},
		{
			// Gegenprobe: ein beliebiges Boolean-Callback ohne die erkannte Branching-Form
			// bleibt kein Type-Wert - genau die Grenze aus getPredicateFacts (Satz von Rice,
			// siehe predicate-types-and-filter-narrowing.md).
			name: 'arbitrary-boolean-function-not-assignable-to-type',
			code: `isLegal = (x: Any) :> Boolean => true
useType = (t: Type) => t
useType(isLegal)`,
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nCan not assign (x: Any) :> true to Type.',
					startRowIndex: 2,
					startColumnIndex: 0,
					endRowIndex: 2,
					endColumnIndex: 16,
				},
			],
		},
		//#endregion branching: Verengung

		//#region branching: Erreichbarkeit
		{
			name: 'unreachable-branch-is-detected',
			code: `f = (value: Integer) =>
	?(value)
		[Integer] => 1
		[Integer] => 2`,
			errors: [
				{
					code: ErrorCode.unreachableBranch,
					message: 'Unreachable branch detected.',
					startRowIndex: 3,
					startColumnIndex: 2,
					endRowIndex: 3,
					endColumnIndex: 16,
				},
			],
		},
		{
			name: 'orthogonal-branches-are-not-unreachable',
			code: `f = (value: Or(Integer Empty)) =>
	?(value)
		[Integer] => 1
		() => 2`,
			errors: [],
		},
		{
			name: 'subset-branch-is-unreachable',
			code: `f = (value: Integer) =>
	?(value)
		[Integer] => 1
		[0] => 2`,
			errors: [
				{
					code: ErrorCode.unreachableBranch,
					message: 'Unreachable branch detected.',
					startRowIndex: 3,
					startColumnIndex: 2,
					endRowIndex: 3,
					endColumnIndex: 10,
				},
			],
		},
		//#endregion branching: Erreichbarkeit

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
					"message": "Definition type mismatch.\nCan not assign 0 to Not(0).",
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
					"message": "Argument type mismatch.\nCan not assign Integer to Not(0).",
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
		{
			// getTypeFamily ordnet 'greater' bewusst keiner Familie zu (Integer oder Float
			// möglich, daher keine Aussage) - dadurch liefert typesOverlap(Greater(0) 5)
			// undefined, und Not(5) prüft das fälschlich nicht: 5 erfüllt Greater(0), Not(5)
			// müsste es also ausschließen.
			name: 'not-type-is-not-checked-against-greater',
			code: 'f = (positive: Greater(0)) :> Not(5) => positive',
			errors: [
				{
					code: ErrorCode.returnTypeMismatch,
					message: 'Return type mismatch.\nCan not assign Greater(0) to Not(5).',
					startColumnIndex: 40,
					startRowIndex: 0,
					endColumnIndex: 48,
					endRowIndex: 0,
					relatedInformation: {
						message: 'Declared as Not(5) here.',
						startColumnIndex: 30,
						startRowIndex: 0,
						endColumnIndex: 36,
						endRowIndex: 0,
					},
				},
			],
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
			// Der Elementtyp bleibt erhalten (slice-keeps-element-type), die Laenge nicht: bei
			// einem Tuple mit Literalgrenzen steht sie aber fest. [1 2 3] ab 2 bis 3 (1-basiert,
			// beide inklusive) sind genau zwei Elemente - dieselbe Arity-Erhaltung, die map
			// schon leistet (map-keeps-tuple-arity). Weil die Laenge damit feststeht und groesser
			// 0 ist, gehoert auch kein Empty ins Ergebnis.
			name: 'slice-keeps-tuple-arity-for-literal-bounds',
			code: 'x: [Integer Integer] = [1 2 3].slice(2 3)',
		},
		{
			// Fund (Session 2026-09-10, echter yugioh-Fehler activatableGameCardIds): filter
			// kann die Liste genau wie slice leeren (Laufzeit: `return filtered.length ?
			// filtered : undefined`) - die Signatur in core-lib.jul deklariert das inzwischen
			// korrekt als `Or([] TypeOf(values))`. Dieser Test prueft genau das: ein deklarierter
			// Rueckgabetyp ohne Or([] ...) (List(Integer) statt Or([] List(Integer))) muss am
			// moeglichen Empty-Ergebnis scheitern.
			name: 'filter-return-type-accounts-for-possibly-empty-result',
			code: `f = (values: List(Integer)) :> List(Integer) =>
	values.filter((value) => true)`,
			errors: [
				{
					code: ErrorCode.returnTypeMismatch,
					message: 'Return type mismatch.\nCan not assign Empty to List(Integer).',
					startRowIndex: 1,
					startColumnIndex: 1,
					endRowIndex: 1,
					endColumnIndex: 31,
					relatedInformation: {
						message: 'Declared as List(Integer) here.',
						startRowIndex: 0,
						startColumnIndex: 31,
						endRowIndex: 0,
						endColumnIndex: 44,
					},
				},
			],
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
			// Praefix-Argument (values in values.first()) referenzierte beim Type-Checken den
			// eigenen Parameter nur als abstrakte parameterReference (zeigt auf f), nicht als
			// deren konkreten deklarierten Typ List(Text). Die unaufgeloeste Referenz floss in
			// firsts generische Rueckgabetyp-Aufloesung (TypeOf(values)/ElementType) und blieb
			// dort haengen - getTypeErrors laxe nestedReference-Rueckfallregel verschluckte den
			// Fehler lautlos. Fix: resolvePlaceholders auf prefixArgumentType vor der Verwendung.
			// Wie core-lib (slice, filter, ...) via nativeFunction deklariert - eine reine
			// Signatur ohne Rumpf (case 'functionTypeLiteral'), damit der generische
			// Rueckgabetyp nicht wie bei einer echten Funktion mit Rumpf (case 'functionLiteral')
			// schon bei der Deklaration ueber resolvePlaceholders fest verdrahtet wird.
			name: 'prefix-argument-resolves-to-declared-type-in-generic-return',
			code: `first = nativeFunction(
	(values: List(Any)) :> TypeOf(values)/ElementType
	true
	§js values => values[0]§
)
g = (n: Integer) => n
f = (values: List(Text)) =>
	g(values.first())`,
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nCan not assign Text to Integer.',
					startRowIndex: 7,
					startColumnIndex: 1,
					endRowIndex: 7,
					endColumnIndex: 18,
				},
			],
		},
		{
			// Anderer Fall als oben, nicht dieselbe Ursache: first hat hier einen echten Rumpf
			// (case 'functionLiteral' statt 'functionTypeLiteral'). assume(1 Any) inferiert Any
			// als Rueckgabetyp, und der Any-Fallback loest den deklarierten Rueckgabetyp
			// TypeOf(values)/ElementType schon an der Deklaration auf - mit dem dort deklarierten
			// values: List(Any), nicht mit dem Typ am jeweiligen Aufruf. functionType.ReturnType
			// traegt danach fest Any statt des unaufgeloesten Platzhalters, jeder Aufruf sieht
			// also Any statt seines eigenen Elementtyps. BUG, aktuell rot: der Fehler bleibt aus.
			name: 'generic-return-type-is-frozen-at-declaration-for-function-literal',
			code: `first = (values: List(Any)) :> TypeOf(values)/ElementType => assume(1 Any)
g = (n: Integer) => n
f = (values: List(Text)) =>
	g(values.first())`,
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nCan not assign Text to Integer.',
					startRowIndex: 3,
					startColumnIndex: 1,
					endRowIndex: 3,
					endColumnIndex: 18,
				},
			],
		},
		{
			// Urspruenglicher Fund (Vorarbeit zu Schritt 3, Callback-Konsumstelle): derselbe Bug
			// wie oben, hier am echten core-lib-Fall slice statt am minimalen Repro first.
			name: 'chained-generic-call-checks-element-type',
			code: `g = (n: Or(List(Integer) [])) => n
f = (values: List(Or(Integer Text))) =>
	g(values.slice(1))`,
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nCan not assign List(Or(Integer Text)) to Or(List(Integer) Empty).\n  Can not assign List(Or(Integer Text)) to List(Integer).\n    Can not assign Text to Integer.',
					startRowIndex: 2,
					startColumnIndex: 1,
					endRowIndex: 2,
					endColumnIndex: 19,
				},
			],
		},
		{
			// Gegenprobe zum vorigen Fund: derselbe Zieltyp meldet den Fehler korrekt, wenn
			// der Wert nicht durch eine Aufrufkette läuft.
			name: 'direct-value-checks-element-type-without-chaining',
			code: `g = (n: Or(List(Integer) [])) => n
f = (value: Or([] List(Or(Integer Text)))) =>
	g(value)`,
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nCan not assign List(Or(Integer Text)) to Or(List(Integer) Empty).\n  Can not assign List(Or(Integer Text)) to List(Integer).\n    Can not assign Text to Integer.',
					startRowIndex: 2,
					startColumnIndex: 1,
					endRowIndex: 2,
					endColumnIndex: 9,
				},
			],
		},
		{
			// Gegenprobe zum vorigen Test: OHNE Prädikat wird Or([] List(Or(Integer Text)))
			// zurecht NICHT als Or([] List(Integer)) akzeptiert. Zeigt, dass ein grüner
			// vorheriger Test tatsächlich an einer echten Verengung liegt (nicht an einer
			// generell laxen Prüfung).
			name: 'list-or-text-not-assignable-to-list-or-integer',
			code: `g = (n: Or([] List(Integer))) => n
f = (values: List(Or(Integer Text))) =>
	g(values)`,
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nCan not assign List(Or(Integer Text)) to Or(Empty List(Integer)).\n  Can not assign List(Or(Integer Text)) to List(Integer).\n    Can not assign Text to Integer.',
					startRowIndex: 2,
					startColumnIndex: 1,
					endRowIndex: 2,
					endColumnIndex: 10,
				},
			],
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
			// Die Arity darf nicht am geschriebenen Namen hängen: über einen Alias trifft kein
			// Namens-Sonderfall mehr, die Deklaration muss sie allein tragen.
			name: 'map-keeps-tuple-arity-via-alias',
			code: `T = [Integer Integer]
m = map
f = (values: T) :> T =>
	m(values (value) => value)`,
		},
		{
			// Gegenprobe: kann die Eingabe empty sein, ist das Empty im Ergebnis korrekt.
			name: 'map-keeps-empty-for-possibly-empty-input',
			code: `f = (values: Or([] List(Integer))) :> Or([] List(Integer)) =>
	values.map((value) => value)`,
		},
		{
			// Bug #2, Kandidat lastElement: bei garantiert nicht-leerer Eingabe deklariert
			// lastElement dennoch Or([] TypeOf(values)/ElementType) unconditioned - map macht es
			// mit And(TypeOf(values) []) richtig (siehe map-adds-no-empty-for-list oben).
			name: 'last-element-adds-no-empty-for-list',
			code: `f = (values: List(Integer)) :> Integer =>
	values.lastElement()`,
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
					"message": "Failed to dereference field 'b' in type [a: 1]",
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
			// Ein fehlendes Feld sah bisher identisch aus wie ein vorhandenes Feld vom Typ
			// Empty ("Can not assign Empty to Text."), weil ein fehlendes Feld intern durch
			// Empty ersetzt wurde. Das verschleiert beim Suchen, ob ein Feld wirklich fehlt oder
			// ob sein Wert tatsächlich Empty ist - deshalb eine eigene, eindeutige Meldung.
			// KEINE zusätzliche Elaboration (anders als bei falschen Feldwerten): fehlt ein Feld,
			// gibt es keinen Feld-Ausdruck, auf den man praeziser zeigen koennte, als es die
			// Hauptmeldung schon tut (dieselbe Literal-Klammer) - eine zweite CompilerError mit
			// identischem Text an fast derselben Position waere reine Verdopplung, besonders
			// sichtbar seit dem Rust-Code-Frame (C2): zwei fast gleiche mehrzeilige Frames statt
			// einem. Fund: docs/error-message-elaboration.md, Session 2026-09-10.
			name: 'missing-dictionary-field-has-distinct-message',
			code: `T = [a: Integer b: Text]
x: T = [a = 1]`,
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nCan not assign [a: 1] to T.\n  Missing field \'b\'.',
					startRowIndex: 1,
					startColumnIndex: 0,
					endRowIndex: 1,
					endColumnIndex: 14,
				},
			],
		},
		{
			// Gegenprobe: ein tatsächlich vorhandenes Empty-Feld bleibt bei der bisherigen
			// Meldung - der Unterschied ist nur, ob das Feld überhaupt geschrieben wurde. Eine
			// Diagnose, Position am Feldwert [] (TypeScript/Rust/Elm-Vorbild, Session 2026-09-10).
			name: 'present-empty-dictionary-field-keeps-assignment-message',
			code: `T = [a: Integer b: Text]
x: T = [a = 1 b = []]`,
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nInvalid value for field \'b\'\n  Can not assign Empty to Text.',
					startRowIndex: 1,
					startColumnIndex: 18,
					endRowIndex: 1,
					endColumnIndex: 20,
				},
			],
		},
		{
			// Wie present-empty-dictionary-field-keeps-assignment-message, aber Ziel ist ein
			// generisches Dictionary(T) statt eines dictionaryLiteral mit benannten Feldern -
			// der Abstieg geht hier durch ZWEI Ebenen (Eintrag "bad", darin Feld "a") bis zum
			// tatsaechlichen Wert §wrong§.
			name: 'generic-dictionary-target-elaborates-per-entry',
			code: `T = [a: Integer]
x: Dictionary(T) = [
	bad = [a = §wrong§]
]`,
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nInvalid value for field \'bad\'\n  Can not assign [a: §wrong§] to T.\n    Invalid value for field \'a\'\n      Can not assign §wrong§ to Integer.',
					startRowIndex: 2,
					startColumnIndex: 12,
					endRowIndex: 2,
					endColumnIndex: 19,
				},
			],
		},
		{
			// Or([] X) ist das Idiom fuer optionale Felder (CLAUDE.md) - Weglassen muss dafuer
			// erlaubt bleiben, wie vor der "Missing field"-Verbesserung. Nur ein Feld, dessen
			// Typ Empty nicht zulaesst, darf beim Fehlen gemeldet werden.
			name: 'optional-field-with-or-empty-type-may-be-omitted',
			code: `T = [a: Integer b: Or([] Text)]
x: T = [a = 1]`,
			errors: [],
		},
		{
			// Ein aliasierter Callback-Parameter ("item = value") referenziert sich im Rumpf
			// über eine ParameterReference mit dem LOKALEN Namen ("item"). Deren Auflösung
			// (dereferenceParameterTypeFromFunctionRef) suchte bisher per Name in ParamsType,
			// wo der Parameter aber unter dem QUELLNAMEN ("value") steht - bei einem Alias
			// liefen beide auseinander und der Typ fiel still auf Any zurück. Fund/Ursache
			// eines falschen returnTypeMismatch bei draw() in yugioh/game-logic.jul.
			name: 'map-callback-parameter-infers-element-type-through-alias',
			code: `T = [a: Integer]
f = (values: List(T)) :> Text =>
	newValues = values.map(
		(item = value) => item
	)
	newValues`,
			errors: [
				{
					code: ErrorCode.returnTypeMismatch,
					message: 'Return type mismatch.\nCan not assign List(T) to Text.',
					startRowIndex: 5,
					startColumnIndex: 1,
					endRowIndex: 5,
					endColumnIndex: 10,
					relatedInformation: {
						message: 'Declared as Text here.',
						startRowIndex: 1,
						startColumnIndex: 25,
						endRowIndex: 1,
						endColumnIndex: 29,
					},
				},
			],
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
					"message": "Definition type mismatch.\nCan not assign §x§ to Integer.",
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
					"message": "Failed to dereference index 5 in type [1 2]",
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
					"message": "Definition type mismatch.\nCan not assign Empty to Integer.",
					"startColumnIndex": 0,
					"startRowIndex": 1,
				},
			],
		},
		{
			// Eine positionale Kollektion trägt keine benannten Felder. Der Name kann dort nicht
			// danebenliegen, er passt gar nicht zur Art der Quelle - beweisbar falsch, nicht unbekannt.
			// Die Meldung nennt die Anforderung des Zugriffs, nicht die Beschaffenheit der Quelle:
			// sonst bräuchte jede Quellart eine eigene Variante.
			name: 'field-name-on-positional-collection',
			code: `a = [1 5]
a/name`,
			errors: [
				{
					"code": ErrorCode.dereferenceFailed,
					"endColumnIndex": 6,
					"endRowIndex": 1,
					"message": "Failed to dereference field 'name' in type [1 5]. A field name needs a Dictionary.",
					"startColumnIndex": 2,
					"startRowIndex": 1,
				},
			],
		},
		{
			// Gegenstück: ein Dictionary hat keine Positionen.
			name: 'index-on-dictionary',
			code: `dict = [key = 5]
dict/1`,
			errors: [
				{
					"code": ErrorCode.dereferenceFailed,
					"endColumnIndex": 6,
					"endRowIndex": 1,
					"message": "Failed to dereference index 1 in type [key: 5]. An index needs a List.",
					"startColumnIndex": 5,
					"startRowIndex": 1,
				},
			],
		},
		{
			// Ein Primitive trägt weder Felder noch Positionen - dieselben beiden Meldungen greifen,
			// ohne dass der Typ in ihnen vorkommt.
			name: 'field-name-on-primitive',
			code: `n = 5
n/name`,
			errors: [
				{
					"code": ErrorCode.dereferenceFailed,
					"endColumnIndex": 6,
					"endRowIndex": 1,
					"message": "Failed to dereference field 'name' in type 5. A field name needs a Dictionary.",
					"startColumnIndex": 2,
					"startRowIndex": 1,
				},
			],
		},
		{
			name: 'index-on-primitive',
			code: `n = 5
n/1`,
			errors: [
				{
					"code": ErrorCode.dereferenceFailed,
					"endColumnIndex": 3,
					"endRowIndex": 1,
					"message": "Failed to dereference index 1 in type 5. An index needs a List.",
					"startColumnIndex": 2,
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
		{
			// Ein Spread im Literal setzt die Folgen schon heute genau zusammen ([...a ...b] auf
			// zwei Tupeln ergibt deren Aneinanderreihung). Diese Faltung ist von einer
			// Deklaration aus aber nicht erreichbar - Concat gibt ihr einen Namen.
			name: 'concat-in-type-position',
			code: `x: Concat([Integer Text] [Boolean]) = [1 §a§ true]`,
		},
		{
			// Der eigentliche Fund: über die Funktionsgrenze geht die Zusammensetzung verloren.
			// Der Rumpf wird einmal mit den deklarierten Parametertypen inferiert, hier also zu
			// List(Any); nur ein deklarierter Rückgabetyp aus aufschiebbaren Konstruktoren wird
			// je Aufruf neu aufgelöst.
			name: 'concat-in-user-function',
			code: `myConcat = (a: List(Any) b: List(Any)) :> Concat(TypeOf(a) TypeOf(b)) => [...a ...b]
y: [Integer Text Boolean] = myConcat([1 §a§] [true])`,
		},
		{
			// Gegenprobe: bei Listen steht die Länge nicht fest, also bleibt nur eine List -
			// aber eine nicht-leere, denn beide Teile sind es.
			name: 'concat-of-lists-keeps-element-types',
			code: `f = (a: List(Integer) b: List(Text)) :> Concat(TypeOf(a) TypeOf(b)) => [...a ...b]
y: List(Or(Integer Text)) = f([1] [§a§])`,
		},
		{
			// Ohne Annotation: Spread im Rumpf faltet heute eager mit resolvePlaceholders auf den
			// deklarierten Parametertyp (List(Any)), statt wie am Aufrufort mit
			// dereferenceArgumentTypesNested die konkreten Argumenttypen einzusetzen - die
			// Tuple-Arität geht verloren, obwohl Concat sie mit Annotation exakt berechnet
			// (siehe concat-in-user-function). Red test fuer
			// docs/generic-types-through-function-body.md.
			name: 'concat-in-user-function-without-annotation',
			code: `myConcat = (a: List(Any) b: List(Any)) => [...a ...b]
y: [Integer Text Boolean] = myConcat([1 §a§] [true])`,
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
					"message": "Argument type mismatch.\nCan not assign 5 to Text.",
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
			// War CHECKER-AUDIT.md #6: eine reine Spread-Argumentliste (kein Feld/Element daneben)
			// parst zu 'object' statt zu 'list' (ParseUnknownObjectLiteral - Liste oder
			// Dictionary, je nach Typ der Quelle), und case 'object' loeste das nie auf, sondern
			// gab immer Any zurueck. Fix: Auflösung wie in case 'list' über getSpreadElementTypes.
			name: 'spread-argument-is-not-type-checked',
			code: `values = [§x§]
f = (a: Integer) => a
f(...values)`,
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nCan not assign §x§ to Integer.',
					startRowIndex: 2,
					startColumnIndex: 0,
					endRowIndex: 2,
					endColumnIndex: 12,
				},
			],
		},
		{
			// Gegenstück zu spread-argument-is-not-type-checked: eine reine Spread-Argumentliste
			// kann laut ParseUnknownObjectLiteral auch ein Dictionary werden (benannte Argumente),
			// das löst case 'object' bisher nicht auf (nur den Listen-Fall). Aktuell rot: der
			// Fehler bleibt aus, obwohl derselbe Wert direkt geschrieben (f(a = §x§)) ihn meldet.
			name: 'dictionary-spread-argument-is-not-type-checked',
			code: `namedArgs = [a = §x§]
f = (a: Integer) => a
f(...namedArgs)`,
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nCan not assign §x§ to Integer.',
					startRowIndex: 2,
					startColumnIndex: 0,
					endRowIndex: 2,
					endColumnIndex: 15,
				},
			],
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
					"message": "This value is discarded. There is no parameter named 'b'.",
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
			// Ein Prefix-Argument bindet schon Parameter — eine gleichnamige explizite
			// Bindung sollte als discarded gemeldet werden, tut es aber nicht.
			// Beispiel: 1.f(a = 2) bindet a = 1 positionell, a = 2 ist überzählig.
			name: 'prefix-argument-overrides-same-named-argument',
			code: `f = (a: Integer) => a
1.f(a = 2)`,
			errors: [
				{
					code: ErrorCode.discardedValue,
					message: "This value is discarded. Parameter 'a' is already bound by the prefix argument.",
					startRowIndex: 1,
					startColumnIndex: 4,
					endRowIndex: 1,
					endColumnIndex: 9,
				},
			],
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
					"message": "Argument type mismatch.\nCan not assign dictionary to rest parameter",
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
					"message": "This value is discarded. 'b' is not destructured.",
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
					"message": "This value is discarded. 'b' is not destructured.",
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
			// Positionelles Destructuring: die Liste hat keine Felder namens a/b, nur Indizes.
			// Die Laufzeit löst das über die Position auf (_isArray ? _temp[0] : _temp.a), der
			// Checker sucht bisher nur über den Namen und meldet fälschlich dereferenceFailed.
			name: 'positional-destructuring-from-list',
			code: '(a b) = [1 2]',
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
					"message": "Failed to dereference 'myA1' in type [\n  a: 1\n  b: 2\n]",
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
			// Fix im functionLiteral-Fall: bei Any als inferiertem Rückgabetyp (hier durch die
			// Selbstreferenz im body verursacht) wird auf den geprüften deklarierten Rückgabetyp
			// zurückgefallen statt Any durchzureichen. g: Text = f(3) meldet das jetzt korrekt.
			name: 'recursive-function-return-type-is-not-checked',
			code: `f = (x: Integer) :> Integer =>
	?(x)
		[0] => 0
		() => f(x)
g: Text = f(3)`,
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nCan not assign Integer to Text.',
					startRowIndex: 4,
					startColumnIndex: 0,
					endRowIndex: 4,
					endColumnIndex: 14,
				},
			],
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
					"message": "'add' is already defined in upper scope",
					"startColumnIndex": 0,
					"startRowIndex": 0,
				},
			],
		},
		{
			// Fund in jul-examples/types.jul (addNums): der letzte Ausdruck im Funktionsrumpf war
			// ein mehrzeiliges branching. returnTypeMismatch markierte davor die GANZE Funktion
			// (Zeile 0 bis Ende des branchings) statt nur des branchings selbst, das den
			// tatsächlich zurückgegebenen Wert bildet.
			name: 'return-type-mismatch-marks-only-the-last-body-expression',
			code: `f = (x: Integer) :> Integer =>
	?(x)
		[0] => true
		() => 1`,
			errors: [
				{
					code: ErrorCode.returnTypeMismatch,
					message: 'Return type mismatch.\nCan not assign true to Integer.',
					startRowIndex: 1,
					startColumnIndex: 1,
					endRowIndex: 4,
					endColumnIndex: 2,
					relatedInformation: {
						message: 'Declared as Integer here.',
						startRowIndex: 0,
						startColumnIndex: 20,
						endRowIndex: 0,
						endColumnIndex: 27,
					},
				},
			],
		},
		{
			// Fund in jul-examples/yugioh/game-logic.jul: fehlende Tupel-Elemente werden alle als
			// Empty behandelt (getTupleTypeError2, `argumentElementTypes[index] ?? { julType:
			// 'empty' }`) - bei mehreren fehlenden Elementen mit demselben Zieltyp entsteht so
			// dieselbe Meldung mehrfach hintereinander, ohne neue Information je Wiederholung.
			// Deduplikation nach demselben Muster wie beim 'and'-Fall in getTypeError
			// (`new Set(subErrors.map(typeErrorToString))`).
			name: 'duplicate-tuple-element-errors-are-deduplicated',
			code: 'x: [Integer Integer Integer] = [1]',
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nCan not assign Empty to Integer.',
					startRowIndex: 0,
					startColumnIndex: 0,
					endRowIndex: 0,
					endColumnIndex: 34,
				},
			],
		},
		{
			// Nachbar-Fall zu 'duplicate-tuple-element-errors-are-deduplicated': Ziel List(X) mit
			// Tupel-Literal als Wert (case 'list' => case 'tuple' in getTypeError) hatte denselben
			// Dedup-Fehler, nur ohne den getTupleTypeError2-Fix von oben. Fund im selben
			// yugioh-Beispiel: eine List(GameBoard) mit mehreren strukturell identischen Boards
			// erzeugte denselben mehrzeiligen Fehler mehrfach hintereinander.
			name: 'duplicate-list-element-errors-are-deduplicated',
			code: 'f = (a: Text b: Text) => [a b]\nx: List(Integer) = f(§a§ §b§)',
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nCan not assign Text to Integer.',
					startRowIndex: 1,
					startColumnIndex: 0,
					endRowIndex: 1,
					endColumnIndex: 29,
				},
			],
		},
		{
			// Kontravarianz bei Parametern: map erwartet (value: X, index: PositiveInteger) => Y.
			// Wer eine Funktion mit anderslautenden Parameternamen schreibt, bricht den Contract.
			// Die Fehlermeldung sagt derzeit "Got 'value' but expected 'i'" - das ist verkehrt herum.
			// Korrekt sollte sie "Got 'i' but expected 'value'" sagen (was auch der Wirklichkeit
			// entspricht: an Position 1 wird 'value' erwartet, wir geben aber 'i').
			// Red test für CHECKER-AUDIT #4.
			name: 'parameter-name-mismatch-reports-names-in-wrong-order',
			code: `x = map([1 2] (i: Integer value: Integer) => i)`,
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: "Argument type mismatch.\nParameter name mismatch. Got 'i' but expected 'value'",
					startRowIndex: 0,
					startColumnIndex: 4,
					endRowIndex: 0,
					endColumnIndex: 47,
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
	// lastElement deklariert seinen Rückgabetyp über ElementAt(TypeOf(values) length(values)) und
	// hat keinen Namens-Sonderfall im Checker. Die Präzision hängt damit an der Deklaration, nicht
	// am geschriebenen Namen - über einen Alias muss sie deshalb genauso erhalten bleiben.
	it('last-element-via-alias-adds-no-empty-for-list', () => {
		const code = `le = lastElement
f = (values: List(Integer)) :> Integer =>
	le(values)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	it('last-element-via-alias-keeps-empty-for-possibly-empty-input', () => {
		// Gegenprobe: kann die Eingabe empty sein, bleibt Empty im Ergebnis korrekt - sonst
		// hätte der Fix die Bedingung nur entfernt statt sie an TypeOf(values) zu knüpfen.
		const code = `le = lastElement
f = (values: Or([] List(Integer))) :> Or([] Integer) =>
	le(values)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// getElement(values length(values)) liefert bei garantiert nicht-leerer List präzise Integer,
	// ohne dass es dafür einen Sonderfall im Checker braucht: length(List(T)) faltet zu
	// lengthOf(List(T)); ElementAt erkennt, dass der Index exakt die Länge derselben Quelle ist,
	// und lässt Empty weg.
	it('element-at-plus-length-adds-no-empty-for-list', () => {
		const code = `f = (values: List(Integer)) :> Integer =>
	getElement(values length(values))`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	it('element-at-plus-length-keeps-empty-for-different-source', () => {
		// Gegenprobe: die Länge einer ANDEREN Liste beweist nichts über die Position in dieser -
		// die Identitätserkennung darf nur bei derselben Quelle greifen.
		const code = `f = (values: List(Integer) other: List(Integer)) :> Or([] Integer) =>
	getElement(values length(other))`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	it('element-at-plus-length-keeps-empty-for-possibly-empty-input', () => {
		// Gegenprobe, die zeigt, dass die Erkennung gar nicht erst greifen kann, wenn values
		// selbst empty sein könnte: length(values) wäre dann Or(0 lengthOf(...)), und die 0 aus
		// dem Empty-Zweig scheitert schon an getElements eigenem index: PositiveInteger, bevor
		// die Identitätserkennung überhaupt zum Zug kommt. lengthOf.Source ist also nie
		// Or([] List(T)), sondern per Konstruktion (getLengthFromType, case 'or') immer schon
		// der reine List-Zweig - die Erkennung kann Empty nicht fälschlich unterschlagen.
		const code = `f = (values: Or([] List(Integer))) :> Or([] Integer) =>
	getElement(values length(values))`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([
			{
				code: ErrorCode.argumentTypeMismatch,
				message: 'Argument type mismatch.\nCan not assign 0 to Greater(0).',
				startRowIndex: 1,
				startColumnIndex: 1,
				endRowIndex: 1,
				endColumnIndex: 34,
			},
		]);
	});
	// Dieselbe Komposition, die lastElement in core-lib benutzt, in Nutzercode nachgebaut: der
	// Rueckgabetyp wird in der eigenen Deklaration aus ElementAt und length zusammengesetzt. Weil
	// kein Namens-Sonderfall mehr existiert, muss die Deklaration allein tragen - auch durch einen
	// Alias hindurch, der jeden Namensbezug kappt.
	it('element-at-plus-length-composed-in-declaration-survives-alias', () => {
		const code = `myLast = (values: List(Any)) :> ElementAt(TypeOf(values) length(values)) =>
	getElement(values length(values))
alias = myLast
f = (values: List(Integer)) :> Integer =>
	alias(values)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// length deklariert seinen Rueckgabetyp ueber LengthOf(TypeOf(values)) und hat keinen
	// Namens-Sonderfall im Checker. Nur deshalb entsteht der lengthOf-Knoten auch hinter einem
	// Alias, und nur mit ihm erkennt ElementAt, dass der Index genau die Laenge dieser Quelle ist -
	// sonst bliebe faelschlich ein Empty im Ergebnis.
	it('length-via-alias-keeps-length-identity', () => {
		const code = `len = length
f = (values: List(Integer)) :> Integer =>
	getElement(values len(values))`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// setElement deklariert nur :> List(Any) und bekommt seine Präzision ausschließlich aus dem
	// Namens-Sonderfall setElementFromTypes. Hinter einem Alias trifft der nicht mehr, und
	// List(Any) nimmt jeden Wert an - das ist kein Präzisionsverlust, sondern ein Loch in der
	// Prüfung: derselbe Aufruf meldet direkt geschrieben korrekt einen Fehler.
	it('set-element-via-alias-keeps-value-type-check', () => {
		const code = `se = setElement
f = (values: List(Integer)) :> List(Integer) =>
	se(values 1 §kaputt§)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		const messages = (parsed.checked?.errors ?? []).map(error => error.message).join('\n');
		expect(messages).to.include('Can not assign §kaputt§ to Integer.',
			'Ein Text an einer List(Integer)-Position muss auch hinter einem Alias auffallen');
	});
	// Die Deklaration kann den Elementtyp erhalten, aber nicht die Tuple-Arity: an welcher Position
	// ersetzt wurde, steht nur bei literalem Index fest, und dafür gibt es kein Vokabular außer
	// einem Typkonstruktor (WithElementAt, docs/type-level-sequence-algebra.md). Direkt greift
	// noch der Namens-Sonderfall, über einen Alias fällt die Präzision auf List(Or(...)) zurück.
	it('set-element-via-alias-keeps-tuple-arity', () => {
		const code = `se = setElement
x: [1 5] = se([1 §a§] 2 5)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);
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
	// functionType.ReturnType wird beim functionLiteral immer auf inferredReturnType gesetzt,
	// auch wenn ein deklarierter Rückgabetyp vorhanden und die Prüfung fehlerfrei ist (die
	// Prüfung vergleicht nur, sie ersetzt nichts). Ist der inferierte Typ Any (weil irgendwo im
	// Rumpf etwas nicht aufgelöst werden konnte), sehen alle Aufrufer Any statt des engeren
	// deklarierten Typs - und Any ist bei jeder Zuweisbarkeitsprüfung permissiv, ein Fehler
	// bleibt also aus. Deshalb hier eine direkte Typ-Inspektion statt einer Fehlerprüfung.
	it('function-return-type-uses-declared-type-not-inferred-any', () => {
		const code = `f = () :> Integer =>
	x = assume(1 Any)
	x`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);

		const definition = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const functionType = definition.value?.typeInfo?.type;
		const returnType = functionType?.julType === 'function' ? functionType.ReturnType : undefined;
		expect(returnType?.julType).to.equal('integer',
			'Deklarierter Rückgabetyp Integer sollte gelten, tatsächlich: ' + returnType?.julType);
	});
	// Bekannte Lücke (checker.ts case 'list', Kommentar "TODO flatten spread tuple value type"):
	// ein Spread innerhalb eines List-Literals wird nicht aufgelöst, das Element wird zu Any -
	// unabhängig vom tatsächlichen Elementtyp der gespreadeten Quelle. Ursache eines falschen
	// returnTypeMismatch in yugioh/game-logic.jul (updatePendingTriggers, activatableGameCardIds).
	it('list-literal-spread-collapses-to-list', () => {
		// List-Spreads sollten sich zu einer List zusammensetzen (unbekannte Länge bleibt unbekannt)
		const code = `f = (values: List(Integer)) =>
	[
		...values
		§"hello"§
	]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);

		const definition = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const functionType = definition.value?.typeInfo?.type;
		const rawReturnType = functionType && functionType.julType === 'function' ? functionType.ReturnType : undefined;
		// Ohne Annotation bleibt der Rueckgabetyp ein aufschiebbarer Concat-Knoten (fuer die
		// praezise Aufloesung am Aufrufort) - resolvePlaceholders liefert die deklarationsseitige,
		// verbreiterte Anzeige, wie beim Hover ueber die Funktion selbst.
		const returnType = rawReturnType && resolvePlaceholders(rawReturnType);
		
		// Erwartet: List(Union(Integer, Text))
		expect(returnType?.julType).to.equal('list',
			'List-Spread sollte zu einer List werden, tatsächlich: ' + returnType?.julType);
		if (returnType && returnType.julType === 'list') {
			expect(returnType.ElementType.julType).to.equal('or',
				'ElementType sollte Union sein (Integer | Text), tatsächlich: ' + returnType.ElementType.julType);
		}
	});

	// Fund in yugioh (game-logic.jul, allGameCardIds): Or([] List(X)) ist das Idiom fuer eine
	// moeglicherweise leere Liste (CLAUDE.md) - ihr julType ist 'or', nicht 'list'. Umgesetzt in
	// getSpreadElementTypes (checker.ts): schaut durch die Or-Choices hindurch und erkennt an
	// unterschiedlichen Choice-Laengen, dass die Gesamtlaenge unbestimmt ist.
	it('possibly-empty-list-spread-collapses-to-list', () => {
		const code = `f = (hand: Or([] List(Integer)) spellTraps: [Integer Integer] field: Integer) =>
	[
		...hand
		...spellTraps
		field
	]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);

		const definition = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const functionType = definition.value?.typeInfo?.type;
		const rawReturnType = functionType && functionType.julType === 'function' ? functionType.ReturnType : undefined;
		const returnType = rawReturnType && resolvePlaceholders(rawReturnType);

		expect(returnType?.julType).to.equal('list',
			'Or([] List)-Spread sollte zu einer List werden, tatsächlich: ' + returnType?.julType);
		if (returnType && returnType.julType === 'list') {
			expect(returnType.ElementType.julType).to.equal('integer',
				'ElementType sollte Integer sein, tatsächlich: ' + returnType.ElementType.julType);
		}
	});

	// Grosser Zieltyp (Dictionary mit vielen Feldern) in der Fehlermeldung wird gekuerzt
	// (checker.ts maxFieldsInTypeDump) statt alle Felder aufzulisten. Wert ist ein Integer
	// statt eines dictionaryLiteral, damit keine Feld-Elaboration greift und der Zieltyp
	// direkt (ungekuerzt waere er 20 Zeilen lang) in den Header gerendert wird.
	it('large-dictionary-type-in-error-message-is-truncated', () => {
		const fieldNames = Array(20).fill(null).map((_, i) => `field${i}`);
		const fieldDeclarations = fieldNames.map(name => `${name}: Integer`).join(' ');
		const code = `x: [${fieldDeclarations}] = 5`;

		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		const error = parsed.checked?.errors?.[0];

		expect(error?.message).to.include('(and 15 more fields)',
			`Zieltyp sollte nach maxFieldsInTypeDump gekuerzt sein:\n${error?.message}`);
	});

	// Fund in yugioh (draw() liefert GameState statt des deklarierten GameBoard): fehlt einem
	// Dictionary-Ziel ein Feld komplett, gibt es keinen Wert zum Vergleichen - der erwartete Typ
	// steht bereits an der Zieltyp-Deklaration selbst. TypeScript/Rust/Elm/GHC schreiben ihn dort
	// deshalb nicht noch einmal aus, TypeScript sammelt mehrere fehlende Felder zusätzlich in
	// einer Zeile. Siehe docs/missing-field-message-format.md. Keine separate Elaboration-Zeile
	// je fehlendem Feld (Fund Session 2026-09-10): ohne Feld-Ausdruck gibt es keine praezisere
	// Position als die Hauptmeldung schon zeigt - eine zweite CompilerError waere nur Verdopplung.
	it('missing-fields-are-collected-in-one-line', () => {
		const code = `T = [a: Integer b: Text c: Boolean]
x: T = [a = 1]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		const messages = parsed.checked?.errors.map(error => error.message);
		expect(messages).to.deep.equal([
			'Definition type mismatch.\nCan not assign [a: 1] to T.\n  Missing fields: \'b\', \'c\'.',
		]);
	});
	// Fund in jul-examples/yugioh/game-logic.jul (Session 2026-09-10): bei verschachtelten
	// Dictionary-Literalen erzeugte das fruehere Zwei-Diagnosen-Modell (volle Kette an der
	// AEUSSEREN Position + Elaboration mit dem inneren Teil der Kette an der PRAEZISEN Position)
	// denselben Text zweimal - bei mehreren Verschachtelungsebenen mit dem Rust-Code-Frame (C2)
	// zwei fast komplette, sich ueberlappende Frames. TypeScript/Rust/Elm loesen das strukturell
	// anders (siehe docs/error-message-elaboration.md): EINE Diagnose, deren Position beim
	// rekursiven Abstieg durch die Literale auf die innerste noch vorhandene, tatsaechlich
	// falsche Stelle wandert (hier: der Wert §wrong§ im inneren Literal) - die Kette bleibt
	// vollstaendig, aber nur einmal (findInnermostErrorPosition in checker.ts).
	//
	// Ausserdem (echtes yugioh-Fehlerbild): die Typ-Kette liest sich aussen nach innen ("Can not
	// assign X to Outer." vor "... to Inner." vor "... to Integer."), aber die "Invalid value for
	// field"-Zeilen haengen alle ans Ende, in umgekehrter Verschachtelungs-Reihenfolge (innerstes
	// Feld zuerst) - man muss sie im Kopf wieder der richtigen Ebene der Typ-Kette zuordnen statt
	// sie direkt an der Stelle zu lesen, wo sie hingehoeren. TypeScript interleaved das (Feldname
	// direkt vor dem Fehler, den er erklaert) UND rueckt jede Zeile eine Ebene tiefer ein, je
	// weiter man in die Verschachtelung absteigt - ohne Einrueckung bleibt bei 3+ Ebenen (wie im
	// echten Fund: GameState -> boards -> GameBoard -> activatableGameCardIds) unklar, welche
	// Zeile zu welcher Tiefe gehoert. Umgesetzt in getDictionaryFieldError/indentLines.
	it('field-name-precedes-the-type-mismatch-it-explains', () => {
		const code = `Inner = [a: Integer]
Outer = [inner: Inner]
x: Outer = [inner = [a = §wrong§]]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		const messages = parsed.checked?.errors.map(error => error.message);
		expect(messages).to.deep.equal([
			[
				'Definition type mismatch.',
				'Can not assign [inner: [a: §wrong§]] to Outer.',
				'  Invalid value for field \'inner\'',
				'    Can not assign [a: §wrong§] to Inner.',
				'      Invalid value for field \'a\'',
				'        Can not assign §wrong§ to Integer.',
			].join('\n'),
		]);
	});

	// Fund im echten yugioh-Fehlerbild (Session 2026-09-10): typeToString hat fuer mehrzeilige
	// Typen (Tupel/Dictionary) eine EIGENE Einrueckung (`bracketedExpressionToString`, Tabs, own
	// depth-Zaehler ab 0), die nichts von der Kettentiefe weiss, in die sie via indentLines
	// eingebettet wird - Tabs und Leerzeichen mischen sich, die Verschachtelung sieht zufaellig
	// aus statt konsistent. Ziel: typeToString nutzt dieselbe Leerzeichen-Einheit wie indentLines
	// (2 Leerzeichen), dann fuegt sich die eigene Einrueckung sauber in jede Einbettungstiefe.
	// Umgesetzt in bracketedExpressionToString (indentUnit).
	it('multiline-type-dump-uses-the-same-indent-unit-as-the-surrounding-chain', () => {
		const code = `Inner = [a: [Integer Integer Integer Integer Integer Integer]]
x: Inner = [a = []]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		const messages = parsed.checked?.errors.map(error => error.message);
		expect(messages).to.deep.equal([
			[
				'Definition type mismatch.',
				'Can not assign [a: Empty] to Inner.',
				'  Invalid value for field \'a\'',
				'    Can not assign Empty to [',
				'      Integer',
				'      Integer',
				'      Integer',
				'      Integer',
				'      Integer',
				'      Integer',
				'    ].',
			].join('\n'),
		]);
	});

	// Fund/Plan Session 2026-09-10 (docs/error-message-elaboration.md): Tupel-/Listen-Literale
	// bekommen dieselbe Elaboration wie Dictionary-Literale - ein falsches Element markiert
	// nur das Element selbst, nicht die ganze Definition (findInnermostErrorPosition, Fall
	// value.type === 'list').
	it('tuple-literal-element-error-points-at-the-element-not-the-whole-definition', () => {
		const code = 'x: [Integer Integer Integer] = [1 §wrong§ 3]';
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([
			{
				code: ErrorCode.definitionTypeMismatch,
				message: 'Definition type mismatch.\nCan not assign §wrong§ to Integer.',
				startRowIndex: 0,
				startColumnIndex: 34,
				endRowIndex: 0,
				endColumnIndex: 41,
			},
		]);
	});

	// Fund: Fehlermeldung für Definitions mit verschachtelten Type-Mismatch ist verwirrend.
	// Sie sagt "Can not assign newGameState to [...]", aber newGameState ist der Name
	// der Definition, nicht der Wert, der zugewiesen wird. Das Problem liegt tiefer in
	// einem Feld, und die erste Zeile sollte nicht vom Definitionsnamen sprechen.
	// Umgesetzt: wenn detaillierte Fehler vorhanden sind (z.B. "Invalid value for field X"),
	// skippen wir die erste "Can not assign X to Y" Zeile, die verwirrend ist.
	it('definition-error-first-line-should-not-name-the-definition', () => {
		// Vereinfacht aus dem yugioh-Fehler: newGameState mit einem fehlerhaften Feld boards
		const code = `newGameState: [boards: [a: Integer b: Integer]] = [
	boards = []
]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		const error = parsed.checked?.errors?.[0];
		
		// Nach dem Fix: erste Zeile nach "Definition type mismatch." sollte mit
		// "Invalid value for field" anfangen, nicht "Can not assign newGameState"
		const lines = error?.message.split('\n') ?? [];
		const secondLine = lines[1] ?? '';
		expect(secondLine).to.include('Invalid value for field',
			`Zweite Zeile sollte "Invalid value for field" sein, aber ist: ${secondLine}\nGanze Message:\n${error?.message}`);
	});

	it('assigned-value-alias-name-should-not-appear-as-type-name', () => {
		// Realer yugioh-Fehler: "Can not assign newGameState to GameState." - newGameState
		// ist der Name der Definition, die den Wert haelt, kein Typname. aliasName wird fuer
		// jede Dictionary-Definition gesetzt (auch fuer normale Werte), aber beim Ausdrucken
		// der argumentsType-Seite (der tatsaechliche Wert) darf er nicht verwendet werden -
		// nur die targetType-Seite (der erwartete Typ) darf ihren Alias zeigen.
		const code = `GameState = [board: Integer]
newGameState: GameState = [
	board = []
]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		const error = parsed.checked?.errors?.[0];

		expect(error?.message).not.to.include('newGameState to GameState',
			`Definitionsname darf nicht als Typ auf der linken Seite erscheinen: ${error?.message}`);
	});

	// Fund im echten yugioh-Fehlerbild (Session 2026-09-10): Ziel Or(Empty List(Integer)),
	// Wert List(Text) - der List-gegen-List-Zweig in getTypeError gibt den Element-Fehler
	// unveraendert durch, ohne ihn als "Can not assign List(X) to List(Y)." zu umhuellen (anders
	// als der dictionaryLiteral-Fall). Im Or-Ziel stehen dadurch zwei Fehler ohne erkennbaren
	// Zusammenhang nebeneinander: "Can not assign List(Text) to Empty." (Choice Empty) und roh
	// "Can not assign Text to Integer." (Choice List(Integer), ohne "das war in einer Liste").
	it('list-element-error-is-wrapped-with-the-enclosing-list-types', () => {
		const code = `f = (y: List(Text)) =>
	x: List(Integer) = y
	x`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		const error = parsed.checked?.errors?.[0];
		expect(error?.message).to.include('Can not assign List(Text) to List(Integer).',
			`Element-Fehler sollte mit dem umschliessenden List-Typ-Paar eingeleitet werden: ${error?.message}`);
	});

	// Fund im echten yugioh-Fehlerbild (Session 2026-09-10): Ziel Or(Empty List(Integer))
	// (Idiom "moeglicherweise leere Liste"), Wert List(Or(Integer Empty)) (Idiom "Liste mit
	// moeglicherweise fehlenden Eintraegen") - strukturell verschieden, aber leicht zu verwechseln.
	// Bisher wurden ALLE Or-Choices einzeln gegen den Wert geprueft und ALLE Fehler gezeigt,
	// auch der triviale/uninteressante ("List ist kein Empty") - der eigentlich relevante Choice
	// (List(Integer)) ging darin unter, und der volle Or-Zieltyp war nirgends sichtbar (TS/Flow-
	// Vorbild: Ziel-Union vollstaendig im Kopf zeigen, dann nur den strukturell naechsten Choice
	// vertiefen statt alle Choices einzeln durchzukauen).
	it('or-target-shows-full-union-and-elaborates-only-the-closest-choice', () => {
		const code = `f = (y: List(Or(Integer Empty))) =>
	x: Or(Empty List(Integer)) = y
	x`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		const error = parsed.checked?.errors?.[0];

		expect(error?.message).to.include('Or(Empty List(Integer))',
			`Der volle Or-Zieltyp sollte sichtbar bleiben: ${error?.message}`);
		expect(error?.message).not.to.include('to Empty.',
			`Der triviale/uninteressante Choice (List ist kein Empty) sollte nicht als eigene Zeile erscheinen: ${error?.message}`);
	});

	it('tuple-literal-spread-flattens-elements', () => {
		// Tuple-Spreads sollten Element-für-Element eingefügt werden
		const code = `f = (myTuple: [Integer Text]) =>
	[
		...myTuple
		[a = 1]
	]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);

		const definition = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const functionType = definition.value?.typeInfo?.type;
		const rawReturnType = functionType && functionType.julType === 'function' ? functionType.ReturnType : undefined;
		const returnType = rawReturnType && resolvePlaceholders(rawReturnType);
		
		// Erwartet: [Integer, Text, [a: Integer]]
		if (!returnType || returnType.julType !== 'tuple') {
			throw new Error(`Return type sollte Tuple sein, ist aber: ${returnType?.julType}`);
		}
		expect(returnType.ElementTypes.length).to.equal(3, 'Tuple sollte 3 Elemente haben (2 aus Spread + 1 literal)');
		expect(returnType.ElementTypes[0]?.julType).to.equal('integer', 'Element 0 sollte integer sein');
		expect(returnType.ElementTypes[1]?.julType).to.equal('text', 'Element 1 sollte text sein');
		expect(returnType.ElementTypes[2]?.julType).to.equal('dictionaryLiteral', 'Element 2 sollte dictionaryLiteral sein');
	});
	it('dictionary-literal-spread-merges-fields', () => {
		// Dictionary-Spreads sollten Felder aus dem Source in den Target mergen
		const code = `T = [a: Integer b: Text]
f = (source: T) => [
	...source
	c = true
]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);

		const definition = parsed.checked?.expressions?.[1] as ParseSingleDefinition;
		const functionType = definition.value?.typeInfo?.type;
		const returnType = functionType && functionType.julType === 'function' ? functionType.ReturnType : undefined;
		
		// Erwartet: dictionaryLiteral mit 3 Feldern: [a: Integer, b: Text, c: Boolean]
		expect(returnType?.julType).to.equal('dictionaryLiteral',
			'Return type sollte dictionaryLiteral sein, tatsächlich: ' + returnType?.julType);
		if (returnType && returnType.julType === 'dictionaryLiteral') {
			expect(Object.keys(returnType.Fields).length).to.equal(3,
				'Sollte 3 Felder haben (a, b, c)');
			expect(returnType.Fields['a']?.julType).to.equal('integer',
				'Feld a sollte integer sein');
			expect(returnType.Fields['b']?.julType).to.equal('text',
				'Feld b sollte text sein');
			expect(returnType.Fields['c']?.julType).to.equal('booleanLiteral',
				'Feld c sollte booleanLiteral sein');
		}
	});
	it('dictionary-type-spread-merges-fields', () => {
		const code = `SourceType = [x: Integer y: Text]
TargetType = [...SourceType z: Boolean]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {});
		expect(parsed.checked?.errors).to.deep.equal([]);

		const targetDef = parsed.checked?.expressions?.[1] as ParseSingleDefinition;
		const targetType = targetDef.value?.typeInfo?.type;
		expect(targetType && typeToString(resolvePlaceholders(targetType), 0, 0)).to.equal(
			'TypeOf([\n  x: Integer\n  y: Text\n  z: Boolean\n])');
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