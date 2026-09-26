import { expect } from 'chai';

import {
	builtinEmpty,
	createCompileTimeDictionaryLiteralType,
	createCompileTimeFunctionType,
	createCompileTimeListType,
	createCompileTimeTupleType,
	createParameterReference,
	forEachChild,
	ParseExpression,
	ParseFunctionCall,
	ParseFunctionLiteral,
	ParseSingleDefinition,
	PositionedExpression,
	Purity,
	TypePurity,
} from '../syntax-tree.js';
import { CompilerError, ErrorCode } from '../compiler-errors.js';
import { reportAtCaller } from '../test-util.js';
import { coreLibPath, parseCode, parseFile } from '../parser/parser.js';
import { checkTypes } from './checker.js';
import { builtInSymbols, getCallPurity, getCallPurityInfo, inferBodyPurity, isFunctionType, resolvePlaceholders, typeToString } from './checker.js';

const expectCheck = reportAtCaller((code: string, { result, errors, filePath }: {
	result?: ParseExpression[];
	errors?: CompilerError[];
	filePath?: string;
} = {}) => {
	const parserResult = parseCode(code, filePath ?? 'dummy.jul');
	// Sonst gilt ein Syntaxfehler als bestandener Checker Test, weil der Checker auf dem
	// unvollständigen Baum schlicht nichts zu melden hat. Vor dem Check, weil ohne Klon
	// danach auch die Checker-Fehler in unchecked stehen.
	expect(parserResult.unchecked.errors).to.deep.equal([]);
	checkTypes(parserResult, {}, { cloneUnchecked: false });
	expect(parserResult.checked?.errors).to.deep.equal(errors ?? []);
	if (result) {
		expect(parserResult.checked?.expressions).to.deep.equal(result);
	}
});

describe('Checker', () => {
	it('text-interpolation-reference-error', () => {
		expectCheck('§§(a)§', {
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
		});
	});
	it('used-before-defined-error', () => {
		expectCheck(`a
a = 5`, {
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
		});
	});
	// Position zeigt über findInnermostErrorPosition auf das falsche Element (4),
	// nicht mehr auf die ganze Definition.
	it('list-type-error', () => {
		expectCheck('a: List(Text) = [4]', {
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
		});
	});
	//#region Params-Typ
	// Ein Typ als Params-Typ ist zulässig, die Funktion bleibt aufrufbar.
	it('type-function', () => {
		expectCheck(`t = Any => []
t(1)`);
	});
	// Der Params-Typ wird gegen die Argumentkollektion geprüft, und die ist List,
	// Dictionary oder Empty. Integer kann das nie sein, die Funktion ist also nicht
	// aufrufbar — unabhängig davon, ob sie je in einem branching auftaucht.
	it('params-type-must-be-collection', () => {
		expectCheck('f = Integer => 0', {
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
		});
	});
	// Gegenprobe: gewickelt ist derselbe Typ aufrufbar.
	it('params-type-collection-is-callable', () => {
		expectCheck(`f = [Integer] => 0
f(1)`);
	});
	// Dieselbe Regel am branch: ein Kopf, der keine Argumentkollektion sein kann, ist
	// eine nicht aufrufbare Funktion — gemeldet an der Funktion, nicht am branching.
	it('branch-head-must-be-collection', () => {
		expectCheck(`f = (x: Integer) =>
	?(x)
		Integer => 0
		() => 1`, {
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
		});
	});
	// Empty ist die Kollektion eines Aufrufs ohne Argumente und damit gültig.
	it('params-type-empty-is-collection', () => {
		expectCheck(`f = Empty => 0
f()`);
	});
	// Never ist unbewohnt, es gibt also keinen Wert, der keine Kollektion sein könnte.
	// Schreibbar ist Never nicht, es entsteht nur aus Typarithmetik — ein Fehler hier
	// träfe niemanden, der etwas Falsches geschrieben hat.
	it('params-type-never-is-not-reported', () => {
		expectCheck('f = And(Integer Text) => 0');
	});
	// Unwissen ist keine Ablehnung: ein nicht auflösbarer Params-Typ darf nicht gemeldet
	// werden, sonst wird aus "nicht entscheidbar" ein "passt nicht".
	it('params-type-unknown-is-not-reported', () => {
		expectCheck(`T = Any
f = T => 0`);
	});
	//#endregion Params-Typ
	//#region branching: Bindung
	// ? ist ein Präfix-Operator mit runder Argumentliste: ein Kopf prüft ausnahmslos gegen
	// die Argumentkollektion, und der gebranchte Wert ist deren Element 0.
	// Ein branch ist eine Funktion — ein anderer Wert kann nicht matchen.
	it('branch-non-function-error', () => {
		expectCheck('?([])\n\t4', {
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
		});
	});
	// Kein Auto-Spread mehr: ein geschriebenes Argument bleibt ein Argument, auch wenn
	// es eine Collection ist. Der 1. Parameter bekommt die ganze Liste.
	it('branch-binds-whole-collection', () => {
		expectCheck(`h = (x: List(Integer)) => x
f = (someVar: List(Integer)) =>
	?(someVar)
		(a: List(Integer)) => h(a)
		() => []`);
	});
	// Gegenstück: gespreadet wird nur mit geschriebenem ..., dann beschreiben die
	// Parameter die Elemente.
	it('branch-spread-binds-elements', () => {
		expectCheck(`g = (x: Integer) => x
f = (pair: [Integer Integer]) =>
	?(...pair)
		(a: Integer b: Integer) => g(a)
		() => 0`);
	});
	// Ein leerer Wert ist kein leeres Argument: ?(value) schreibt ein Argument, die
	// Kollektion ist also [()] und der passende Kopf [Empty], nicht Empty.
	it('branch-empty-value-is-one-argument', () => {
		expectCheck(`f = (value: Or([] Integer)) =>
	?(value)
		[Empty] => 0
		Any => 1`);
	});
	// Umgekehrt: ohne geschriebenes Argument ist die Kollektion selbst Empty.
	it('branch-empty-collection-matches-empty-head', () => {
		expectCheck(`?()
	Empty => 0
	() => 1`);
	});
	//#endregion branching: Bindung
	//#region branching: Verengung
	// Die Verengung schneidet (sie ersetzt nicht) und wirkt auf den gebundenen Wert.
	// Der catchAll () => ... bindet nichts und matcht jeden Wert, sagt über den Wert
	// also nichts aus. countdown behält daher Integer und ist weiter an einen
	// Integer-Parameter zuweisbar. Vgl. jul-examples/fibonacci/fibonacci.jul.
	it('branch-narrowing-catch-all', () => {
		expectCheck(`g = (x: Integer) => x
f = (countdown: Integer) =>
	?(countdown)
		[0] => 0
		() => g(countdown)`);
	});
	// Die Parameterliste beschreibt die Argumentkollektion, der 1. Parameter bekommt
	// also das 1. Argument. Verengt wird auf dessen Typ, nicht auf die Liste als Ganzes.
	it('branch-narrowing-named-param', () => {
		expectCheck(`g = (x: Integer) => x
f = (countdown: Integer) =>
	?(countdown)
		[0] => 0
		(y: Integer) => g(countdown)`);
	});
	// Ohne Einzelparameter bekommt der rest die ganze Kollektion, also [countdown].
	// Verengt wird daher auf den Elementtyp der rest-Liste, hier Integer.
	it('branch-narrowing-rest-param', () => {
		expectCheck(`g = (x: Integer) => x
f = (countdown: Integer) =>
	?(countdown)
		[0] => 0
		(...rest: List(Integer)) => g(countdown)`);
	});
	// Ein Parameter ohne TypeGuard hat den Typ Any, das darf nicht verbreitern.
	it('branch-narrowing-untyped-param', () => {
		expectCheck(`g = (x: Integer) => x
f = (countdown: Integer) =>
	?(countdown)
		[0] => 0
		(y) => g(countdown)`);
	});
	// Any matcht auch die Kollektion und bleibt daher ungewickelt. Verbreitern darf
	// es nicht, der Schnitt behält Integer.
	it('branch-narrowing-any-branch', () => {
		expectCheck(`g = (x: Integer) => x
f = (countdown: Integer) =>
	?(countdown)
		[0] => 0
		Any => g(countdown)`);
	});
	// Ein Typ-Kopf bindet nichts und prüft die Kollektion. Verengt wird auf sein
	// Element 0: someVar wird hier zu Integer.
	it('branch-narrowing-type-param', () => {
		expectCheck(`g = (x: Integer) => x
f = (someVar: Any) =>
	?(someVar)
		[Integer] => g(someVar)
		() => 0`);
	});
	// Distributivgesetz: And(Or(Text Integer) Text) => Or(Text Never) => Text
	it('branch-narrowing-union', () => {
		expectCheck(`t = (x: Text) => x
f = (someVar: Or(Text Integer)) =>
	?(someVar)
		(y: Text) => t(someVar)
		() => §§`);
	});
	// Gegenprobe: die Verengung muss auch wirklich greifen. Im Text-Branch ist someVar
	// auf Text verengt und damit nicht mehr an einen Integer-Parameter zuweisbar.
	it('branch-narrowing-applies', () => {
		expectCheck(`g = (x: Integer) => x
f = (someVar: Or(Text Integer)) =>
	?(someVar)
		(y: Text) => g(someVar)
		() => 0`, {
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 24,
					"endRowIndex": 3,
					"message": "Argument type mismatch.\nInvalid value for parameter 'x'\n  Can not assign Text to Integer.",
					"startColumnIndex": 17,
					"startRowIndex": 3,
				},
			],
		});
	});
	// _branch probiert die branches der Reihe nach. Wer den Empty-branch passiert hat,
	// kann kein Empty mehr sein — die Verengung muss die Typen der vorherigen branches
	// also abziehen.
	it('branch-narrowing-excludes-previous-branches', () => {
		expectCheck(`g = (x: Integer) => x
f = (value: Or([] Integer)) =>
	?(value)
		[Empty] => 0
		Any => g(value)`);
	});
	// Gegenprobe: ohne vorherigen branch bleibt Empty möglich und muss gemeldet werden.
	// Die Verengung darf also nicht pauschal Empty abziehen.
	it('branch-narrowing-keeps-unhandled-types', () => {
		expectCheck(`g = (x: Integer) => x
f = (value: Or([] Integer)) =>
	?(value)
		Any => g(value)`, {
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 16,
					"endRowIndex": 3,
					"message": "Argument type mismatch.\nInvalid value for parameter 'x'\n  Can not assign Empty to Integer.",
					"startColumnIndex": 11,
					"startRowIndex": 3,
				},
			],
		});
	});
	// Branching über mehrere Werte: Element i des Kopfes verengt das i-te Argument.
	it('branch-narrowing-multiple-values', () => {
		expectCheck(`g = (x: Integer y: Integer) => x
f = (a: Or(Text Integer) b: Or(Text Integer)) =>
	?(a b)
		[Integer Integer] => g(a b)
		() => 0`);
	});
	// Ohne Parameternamen ist bei mehreren Argumenten nicht erkennbar, welches falsch ist -
	// Fund an einem echten Aufruf mit mehreren Kandidaten-Fehlern ohne Zuordnung
	// (game-logic.jul: 3 "Can not assign"-Zeilen, keine sagt welches Argument gemeint ist).
	it('argument-type-mismatch-names-the-parameter', () => {
		expectCheck(`f = (a: Integer b: Greater(0)) => a
f(1 0)`, {
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 5,
					"endRowIndex": 1,
					"message": "Argument type mismatch.\nInvalid value for parameter 'b'\n  Can not assign 0 to Greater(0).",
					"startColumnIndex": 4,
					"startRowIndex": 1,
				},
			],
		});
	});
	// Ein Feldpfad als Branch-Argument verengt die Quelle: im Integer-Zweig ist d/a auf
	// Integer verengt, also auch beim erneuten Lesen.
	it('branch-narrowing-through-field-path', () => {
		expectCheck(`f = (d: [a: Or(Text Integer)]) =>
	?(d/a)
		(y: Integer) =>
			narrowed: Integer = d/a
			narrowed
		() => 0`);
	});
	// Die Verengung wirkt auch rückwärts auf die Quelle: dass stepType ein Text ist,
	// beweist, dass step nicht empty ist — Empty hat kein Feld type. Auch über die
	// Zwischenvariable hinweg, denn ein Name bezeichnet in JUL genau einen Wert.
	it('branch-narrowing-reaches-source-of-field', () => {
		expectCheck(`g = (q: Text) => q
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
		() => §§`);
	});
	// Das Feld der Quelle wählt die Choice aus: im Zweig §a§ bleibt von step nur die
	// Choice mit type §a§ übrig, die andere fällt weg. Die Zuweisung an Empty macht den
	// verengten Typ sichtbar.
	it('branch-narrowing-field-selects-choice-of-source', () => {
		expectCheck(`f = (step: Or([type: §a§ amount: Integer] [type: §b§])) =>
	t = step/type
	?(t)
		[§a§] =>
			narrowed: Empty = step
			narrowed
		[§b§] => []`, {
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 25,
					"endRowIndex": 4,
					"message": "Definition type mismatch.\nCan not assign [\n  type: §a§\n  amount: Integer\n] to Empty.",
					"startColumnIndex": 3,
					"startRowIndex": 4,
				},
			],
		});
	});
	// Dasselbe als Argument: mit Any statt Integer wählte der bedingte Rückgabetyp von add
	// den Rational-Zweig.
	it('branch-narrowing-field-selects-choice-of-source-as-argument', () => {
		expectCheck(`f = (step: Or([type: §a§ amount: Integer] [type: §b§])) =>
	t = step/type
	?(t)
		[§a§] =>
			sum: Integer = assume(3 Integer).add(step/amount)
			sum
		[§b§] => 0`);
	});
	// Gegenprobe: die Verengung darf nur an einem Namen hängen. Zwei Aufrufe sind zwei
	// Werte — vom Typ des einen folgt nichts über den anderen.
	it('branch-narrowing-needs-a-name-as-source', () => {
		expectCheck(`g = (q: Text) => q
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
		() => §§`, {
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 33,
					"endRowIndex": 14,
					"message": "Argument type mismatch.\nInvalid value for parameter 'q'\n  Can not assign Empty to Text.",
					"startColumnIndex": 14,
					"startRowIndex": 14,
				},
			],
		});
	});
	// Gegenprobe: jeder branch verengt für sich. Im Text-Zweig ist d/a Text und damit
	// nicht an Integer zuweisbar, obwohl ein vorheriger Zweig auf Integer verengt hat.
	it('branch-narrowing-field-path-is-per-branch', () => {
		expectCheck(`f = (d: [a: Or(Text Integer)]) =>
	?(d/a)
		(y: Integer) => 0
		(y: Text) =>
			narrowed: Integer = d/a
			narrowed
		() => 0`, {
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
		});
	});
	// Gegenprobe: Any sagt über den Wert nichts aus, der Schnitt darf also nicht
	// verbreitern — d/a bleibt Or(Text Integer).
	it('branch-narrowing-field-path-any-does-not-widen', () => {
		expectCheck(`f = (d: [a: Or(Text Integer)]) =>
	?(d/a)
		(y: Any) =>
			narrowed: Integer = d/a
			narrowed
		() => 0`, {
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
		});
	});
	// Gegenprobe: die Verengung gilt nur im Rumpf des branches. Danach ist d/a wieder
	// Or(Text Integer) — das verengte Symbol liegt im Scope des branches, nicht außen.
	it('branch-narrowing-field-path-ends-with-the-branch', () => {
		expectCheck(`f = (d: [a: Or(Text Integer)]) =>
	?(d/a)
		(y: Integer) => 0
		() => 0
	narrowed: Integer = d/a
	narrowed`, {
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
		});
	});
	// Ein innerer branch sieht die Verengung des äußeren.
	it('branch-narrowing-field-path-in-nested-branching', () => {
		expectCheck(`g = (n: Integer) => n
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
		() => 0`);
	});
	// Auch ein mehrstufiger Pfad verengt: der Fakt liegt auf d/a/b, gelesen wird
	// derselbe Pfad.
	it('branch-narrowing-deep-field-path', () => {
		expectCheck(`g = (n: Integer) => n
getD = (flag: Boolean) =>
	?(flag)
		[true] => [a = [b = 1]]
		() => [a = [b = §x§]]
f = (flag: Boolean) =>
	d = getD(flag)
	?(d/a/b)
		(y: Integer) => g(d/a/b)
		() => 0`);
	});
	// Ist die Quelle vom Typ Any, weiß der Checker über ihre Felder nichts. Der
	// Schnitt aus Any und dem Fakt [index: ...] darf daher nicht heißen, dass s nur
	// noch dieses eine Feld hat - sonst gilt jedes andere Feld (hier boards) als Empty.
	it('branch-narrowing-through-any-source-keeps-other-fields', () => {
		expectCheck(`start: [boards: Integer index: Or([] Integer)] = [boards = 1 index = 1]
s = assume(start Any)
?(s/index)
	[Integer] => 0
	() =>
		boardsValue: Integer = s/boards`, {
			errors: [],
		});
	});
	// Der Schnitt aus einem vollständig bekannten Typ und einem unvollständigen Fakt
	// (aus der Verengung über einen Feldpfad) darf den vollständigen Typ nicht ersetzen.
	// card/face wird auf §up§ verengt, das erzeugt für card den Fakt [face: §up§] mit
	// complete: false. Der ist "zuweisbar an" Card (fehlende Felder gelten als unbekannt),
	// der Teilmengen-Shortcut in createNormalizedIntersectionType gibt ihn deshalb
	// wholesale zurück statt die Felder zu vereinigen - dataId geht beim Spread verloren.
	it('branch-narrowing-field-fact-does-not-replace-known-type', () => {
		expectCheck(`Card = [
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
	() => card`, {
			errors: [],
		});
	});
	// Not(X), das durch Branch-Narrowing auf einem Any-Ursprung entsteht, ist genauso
	// unwissend wie das Any davor - Any ist überall sonst permissiv als Quelle
	// (getTypeError gibt bei julType 'any' sofort undefined zurück). Hier wird aus dem
	// Nichtwissen "könnte alles außer Integer sein" fälschlich eine harte Ablehnung,
	// weil Not(Integer) einzeln gegen Empty und gegen Integer geprüft wird statt die
	// Any-Herkunft weiterzutragen. aggregate (core-lib.jul, Akkumulator: Any) zeigt
	// denselben Fehler, weil sein Rückgabetyp ebenfalls durch Any erzeugt wird.
	it('narrowed-not-type-from-any-source-is-not-checked', () => {
		expectCheck(`combined = assume([] Any)
?(combined/index)
	[Integer] => 0
	() =>
		result: Or([] Integer) = combined/index
		result`, {
			errors: [],
		});
	});
	// Gegenprobe zu narrowed-not-type-from-any-source-is-not-checked: Not(X) darf nur
	// dann permissiv sein, wenn das Ziel mehr als X zulässt. Ziel = Integer ist eine
	// Teilmenge von X = Integer, der Wert wäre also garantiert ausgeschlossen.
	it('narrowed-not-type-still-errors-when-target-is-subset-of-excluded', () => {
		expectCheck(`combined = assume([] Any)
?(combined/index)
	[Integer] => 0
	() =>
		result: Integer = combined/index
		result`, {
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
		});
	});
	// Ein Prädikat als Typ-Kopf: _branch ruft es über getTypeError auf (runtime.ts, case
	// 'function'). Im branch selbst wird mit dem geschnitten, was das Prädikat höchstens
	// durchlässt: aus isInteger(x) == true folgt x ist Integer.
	it('branch-narrowing-predicate-head', () => {
		expectCheck(`isInteger = (x: Any) :> Boolean =>
	?(x)
		[Integer] => true
		() => false
g = (n: Integer) => n
f = (someVar: Or(Integer Text)) =>
	?(someVar)
		[isInteger] => g(someVar)
		() => 0`, {
			errors: [],
		});
	});
	// Gegenrichtung: was ein späterer branch NICHT mehr sein kann. Dafür reicht
	// narrowsTo nicht - das sagt nur "höchstens diese Werte liefern true". Abziehen
	// darf man nur, was nachweislich true liefert: branches mit Rückgabetyp literal
	// true, abzüglich dessen, was frühere branches des Prädikats abfangen. Hier deckt
	// [Integer] => true ganz Integer ab, im catchAll bleibt also Text.
	it('branch-narrowing-predicate-head-false-branch', () => {
		expectCheck(`isInteger = (x: Any) :> Boolean =>
	?(x)
		[Integer] => true
		() => false
g = (t: Text) => t
f = (someVar: Or(Integer Text)) =>
	?(someVar)
		[isInteger] => 0
		() => g(someVar)`, {
			errors: [],
		});
	});
	// Ein Prädikat ist ein Type-Wert und geht deshalb als Argument für einen Type-Parameter durch.
	it('predicate-assignable-to-type-1a', () => {
		expectCheck(`isInteger = (x: Any) :> Boolean =>
	?(x)
		[Integer] => true
		() => false
useType = (T: Type) => T
useType(isInteger)`, {
			errors: [],
		});
	});
	// Auch ein Boolean-Callback ohne erkannte Branching-Form ist ein Typ: Die Laufzeit ruft es in
	// Typ-Position auf. Der Checker weiß darüber nur nichts.
	it('arbitrary-boolean-function-assignable-to-type', () => {
		expectCheck(`isLegal = (x: Any) :> Boolean => true
useType = (T: Type) => T
useType(isLegal)`);
	});
	//#endregion branching: Verengung

	//#region branching: Erreichbarkeit
	it('unreachable-branch-is-detected', () => {
		expectCheck(`f = (value: Integer) =>
	?(value)
		[Integer] => 1
		[Integer] => 2`, {
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
		});
	});
	it('orthogonal-branches-are-not-unreachable', () => {
		expectCheck(`f = (value: Or(Integer Empty)) =>
	?(value)
		[Integer] => 1
		() => 2`, {
			errors: [],
		});
	});
	it('subset-branch-is-unreachable', () => {
		expectCheck(`f = (value: Integer) =>
	?(value)
		[Integer] => 1
		[0] => 2`, {
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
		});
	});
	//#endregion branching: Erreichbarkeit

	//#region Prädikate als Typ
	// Ein Funktionswert in Typ-Position ist ein Prädikat: Er beschreibt die Werte, für die er
	// true liefert, nicht die Funktionen mit seiner Signatur. isEven wird vom Checker nicht als
	// Prädikat erkannt, bekannt ist nur sein Parametertyp Integer.
	it('predicate-as-parameter-type', () => {
		expectCheck(`isEven = (n: Integer) => n.modulo(2).equal(0)
g = (n: Integer) => n
f = (a: isEven) => g(a)
f(2)`);
	});
	it('predicate-as-return-type', () => {
		expectCheck(`isEven = (n: Integer) => n.modulo(2).equal(0)
f = (a: Integer) :> isEven => 2`);
	});
	it('predicate-as-definition-type', () => {
		expectCheck(`isEven = (n: Integer) => n.modulo(2).equal(0)
x: isEven = 2`);
	});
	it('predicate-in-type-functions', () => {
		expectCheck(`isEven = (n: Integer) => n.modulo(2).equal(0)
f = (a: List(isEven)) => a
g = (a: Or(isEven Text)) => a
h = (a: And(Integer isEven)) => a
f([2 4])
g(§x§)
g(2)
h(2)`);
	});
	// Ein Wert außerhalb des Parametertyps kann das Prädikat nie erfüllen.
	it('predicate-rejects-value-outside-parameter-type', () => {
		expectCheck(`isEven = (n: Integer) => n.modulo(2).equal(0)
f = (a: isEven) => a
f(§x§)`, {
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nInvalid value for parameter \'a\'\n  Can not assign §x§ to isEven.',
					startRowIndex: 2,
					startColumnIndex: 2,
					endRowIndex: 2,
					endColumnIndex: 5,
				},
			],
		});
	});
	// Ob ein beliebiger Integer gerade ist, weiß der Checker nicht. Das prüft die Laufzeit.
	it('predicate-accepts-unknown-value-inside-parameter-type', () => {
		expectCheck(`isEven = (n: Integer) => n.modulo(2).equal(0)
f = (a: isEven) => a
g = (n: Integer) => f(n)`);
	});
	// Ein Literal rechnet der Checker aus, wenn das Prädikat faltbar ist.
	it('predicate-rejects-folded-constant', () => {
		expectCheck(`isFive = (dividend: Integer) => dividend.modulo(5).equal(0)
x: isFive = 45
y: isFive = 44`, {
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nCan not assign 44 to isFive.',
					startRowIndex: 2,
					startColumnIndex: 0,
					endRowIndex: 2,
					endColumnIndex: 14,
				},
			],
		});
	});
	// Ein Prädikat, das ein Aufruf liefert, ist nur faltbar, wenn sein Funktionstyp das
	// gebundene Argument kennt.
	it('predicate-with-bound-argument-rejects-folded-constant', () => {
		expectCheck(`divisibleBy = (divisor: NonZeroInteger) =>
	(dividend: Integer) =>
		dividend.modulo(divisor).equal(0)
x: divisibleBy(5) = 45
y: divisibleBy(5) = 44`, {
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nCan not assign 44 to divisibleBy(5).',
					startRowIndex: 4,
					startColumnIndex: 0,
					endRowIndex: 4,
					endColumnIndex: 22,
				},
			],
		});
	});
	// Not dreht die Richtung um: 3 ist nicht gerade und kein Text, 4 ist gerade.
	it('predicate-nested-in-not', () => {
		expectCheck(`isEven = (n: Integer) => n.modulo(2).equal(0)
h = (v: Not(Or(isEven Text))) => v
h(3)
h(4)`, {
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nInvalid value for parameter \'v\'\n  Can not assign 4 to Not(Or(isEven Text)).',
					startRowIndex: 3,
					startColumnIndex: 2,
					endRowIndex: 3,
					endColumnIndex: 3,
				},
			],
		});
	});
	// Im catchAll ist der isEven-Anteil schon abgefangen, übrig bleibt Text. Dafür muss der
	// Checker erkennen, dass Parametertyp und Kopf dasselbe Prädikat sind.
	it('predicate-identity-subtracts-in-catch-all', () => {
		expectCheck(`isEven = (n: Integer) => n.modulo(2).equal(0)
g = (t: Text) => t
f = (v: Or(isEven Text)) =>
	?(v)
		[isEven] => 0
		() => g(v)`);
	});
	it('predicate-identity-through-stored-value', () => {
		expectCheck(`isEven = (n: Integer) => n.modulo(2).equal(0)
even = isEven
g = (t: Text) => t
f = (v: Or(even Text)) =>
	?(v)
		[isEven] => 0
		() => g(v)`);
	});
	it('predicate-identity-with-bound-argument', () => {
		expectCheck(`divisibleBy = (divisor: NonZeroInteger) =>
	(dividend: Integer) =>
		dividend.modulo(divisor).equal(0)
g = (t: Text) => t
f = (v: Or(divisibleBy(5) Text)) =>
	?(v)
		[divisibleBy(5)] => 0
		() => g(v)`);
	});
	// Gleiches Verhalten ist nicht dasselbe Prädikat: zwei Literale sind nie gleich. Sichtbar wird
	// das an der Erschöpfung - [isEvenB] fängt den isEvenA-Anteil nicht sicher ab, also bleibt
	// Error im Rückgabetyp. Mit [isEvenA] ist dasselbe branching erschöpfend
	// (predicate-or-empty-is-exhaustive).
	it('predicate-identity-needs-same-literal', () => {
		expectCheck(`isEvenA = (n: Integer) => n.modulo(2).equal(0)
isEvenB = (n: Integer) => n.modulo(2).equal(0)
f = (v: Or(isEvenA Empty)) :> Integer =>
	?(v)
		[isEvenB] => 1
		[Empty] => 2`, {
			errors: [
				{
					code: ErrorCode.returnTypeMismatch,
					message: 'Return type mismatch.\nCan not assign Error to Integer.',
					startRowIndex: 3,
					startColumnIndex: 1,
					endRowIndex: 6,
					endColumnIndex: 2,
					relatedInformation: {
						message: 'Declared as Integer here.',
						startRowIndex: 2,
						startColumnIndex: 30,
						endRowIndex: 2,
						endColumnIndex: 37,
					},
				},
			],
		});
	});
	it('predicate-and-its-complement-are-exhaustive', () => {
		expectCheck(`isEven = (n: Integer) => n.modulo(2).equal(0)
f = (n: Integer) :> Text =>
	?(n)
		[isEven] => §gerade§
		[Not(isEven)] => §ungerade§`);
	});
	it('predicate-or-empty-is-exhaustive', () => {
		expectCheck(`isEven = (n: Integer) => n.modulo(2).equal(0)
f = (v: Or(isEven Empty)) :> Integer =>
	?(v)
		[isEven] => 1
		[Empty] => 2`);
	});
	// Das Funktionstyp-Literal ist davon nicht betroffen: Es verlangt weiter eine Funktion.
	it('function-type-literal-still-requires-function', () => {
		expectCheck(`isAnything = (x: Any) => true
f = (callback: (x: Any) :> Boolean) => callback
f(isAnything)
f(5)`, {
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nInvalid value for parameter \'callback\'\n  Can not assign 5 to (x: Any) :> Boolean.',
					startRowIndex: 3,
					startColumnIndex: 2,
					endRowIndex: 3,
					endColumnIndex: 3,
				},
			],
		});
	});
	// Identität und Faltung setzen voraus, dass das Prädikat für denselben Wert immer dasselbe
	// liefert.
	it('impure-predicate-rejected-as-type-guard', () => {
		expectCheck(`isChecked = (x: Integer) ~> Boolean => true
f = (a: isChecked) => a`, {
			errors: [
				{
					code: ErrorCode.typeGuardIsNotType,
					message: 'A predicate used as a type must be pure.',
					startRowIndex: 1,
					startColumnIndex: 8,
					endRowIndex: 1,
					endColumnIndex: 17,
				},
			],
		});
	});
	it('impure-predicate-rejected-as-branch-head', () => {
		expectCheck(`isChecked = (x: Integer) ~> Boolean => true
f = (a: Integer) =>
	?(a)
		[isChecked] => 1
		() => 2`, {
			errors: [
				{
					code: ErrorCode.typeGuardIsNotType,
					message: 'A predicate used as a type must be pure.',
					startRowIndex: 3,
					startColumnIndex: 3,
					endRowIndex: 3,
					endColumnIndex: 12,
				},
			],
		});
	});
	// Unbekannte Reinheit ist keine Ablehnung, es wird dann nur nicht gefaltet.
	it('predicate-with-unknown-purity-is-accepted', () => {
		expectCheck(`f = (p: (x: Integer) :> Boolean v: Integer) =>
	g = (a: p) => a
	g(v)`);
	});
	//#endregion Prädikate als Typ

	//#region Not
	// Not(X) schließt X aus. NonZeroInteger ist Integer.Without(0), also
	// And(Integer Not(0)) — 0 muss daran scheitern, obwohl es zu Integer passt.
	it('not-type-is-checked', () => {
		expectCheck('a: NonZeroInteger = 0', {
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
		});
	});
	// Gegenprobe: die Prüfung darf nicht zu streng werden
	it('not-type-accepts-other-values', () => {
		expectCheck('a: NonZeroInteger = 5');
	});
	// Not(X) muss auch für Mengentypen greifen, nicht nur für Literale. Der Unterschied:
	// verboten ist alles, was X überlappt — bei einem Literal ist das dasselbe wie
	// "ist Teilmenge von X", bei Integer gegen Not(0) nicht. Integer ist keine Teilmenge
	// von 0, enthält 0 aber, ist also unzulässig. Deshalb dieser Fall zusätzlich zu
	// not-type-is-checked.
	it('not-type-is-checked-for-set-types', () => {
		expectCheck('f = (x: Integer) => modulo(1 x)', {
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 30,
					"endRowIndex": 0,
					"message": "Argument type mismatch.\nInvalid value for parameter 'divisor'\n  Can not assign Integer to Not(0).",
					"startColumnIndex": 29,
					"startRowIndex": 0,
				},
			],
		});
	});
	// PositiveInteger ist And(Integer Greater(0)) und damit nie 0, passt also zu
	// NonZeroInteger. Kein einzelner der beiden Choices reicht dafür aus: Integer
	// scheitert an Not(0), Greater(0) an Integer. Erst das Zerlegen des targets zeigt es.
	it('not-type-accepts-intersection-without-single-matching-choice', () => {
		expectCheck('f = (x: PositiveInteger) => modulo(1 x)');
	});
	// Bug: getTypeError zerlegt bei args='and'/target='or' nur die args Choices
	// (Integer, Greater(0)) und prüft jeden einzeln gegen das GANZE target - keiner
	// reicht dafür, weil weder Integer noch Greater(0) allein Empty oder PositiveInteger
	// erfüllt. Das target selbst wird dabei nie zerlegt (anders als beim symmetrischen
	// Fall target='and', siehe not-type-accepts-intersection-without-single-matching-
	// choice), obwohl PositiveInteger als zweiter Choice von Or([] PositiveInteger)
	// exakt passt.
	it('and-type-accepts-or-target-containing-same-intersection', () => {
		expectCheck('f = (x: PositiveInteger) :> Or([] PositiveInteger) => x');
	});
	// getTypeFamily ordnet 'greater' bewusst keiner Familie zu (Integer oder Float
	// möglich, daher keine Aussage) - dadurch liefert typesOverlap(Greater(0) 5)
	// undefined, und Not(5) prüft das fälschlich nicht: 5 erfüllt Greater(0), Not(5)
	// müsste es also ausschließen.
	it('not-type-is-not-checked-against-greater', () => {
		expectCheck('f = (positive: Greater(0)) :> Not(5) => positive', {
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
		});
	});
	// Für And genügt ein passender Choice. Not(0) passt als Quelle aber fast überall, weil es
	// absichtlich permissiv ist - das darf nicht als "passt" zählen, sonst ist ein Integer
	// ohne die 0 einem Text zuweisbar.
	// Not(1) als Quelle ist permissiv, "kein Fehler" heißt dort nicht "Teilmenge". Die 2 trifft
	// den zweiten branch, er ist also erreichbar.
	it('complement-head-after-literal-is-reachable', () => {
		expectCheck(`f = (n: Integer) =>
	?(n)
		[0] => 1
		[Not(1)] => 2
		() => 3`);
	});
	// Aus demselben Grund darf der Teilmengen-Shortcut And(A B) => A hier nicht greifen, sonst
	// geht Integer verloren und ein Text wäre zuweisbar.
	it('and-with-complement-keeps-both-choices', () => {
		expectCheck(`f = (n: And(Not(0) Integer)) => n
f(§x§)`, {
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nInvalid value for parameter \'n\'\n  Can not assign §x§ to Integer.',
					startRowIndex: 1,
					startColumnIndex: 2,
					endRowIndex: 1,
					endColumnIndex: 5,
				},
			],
		});
	});
	it('and-with-complement-is-not-assignable-to-unrelated-type', () => {
		expectCheck(`g = (t: Text) => t
h = (n: And(Integer Not(0))) => g(n)`, {
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nInvalid value for parameter \'t\'\n  Can not assign And(Integer Not(0)) to Text.',
					startRowIndex: 1,
					startColumnIndex: 34,
					endRowIndex: 1,
					endColumnIndex: 35,
				},
			],
		});
	});
	//#endregion Not
	//#region generische Rückgabetypen
	// slice liefert eine Teilliste, der Elementtyp bleibt also erhalten: aus
	// List(Integer) wird Or([] List(Integer)), nicht Or([] List(Any)).
	// Der Verlust wird erst über filterMap sichtbar, dessen Rückgabetyp
	// Or([] List(Without(callback/ReturnType []))) ist: aus einem Any wird dabei
	// Not(Empty), und das passt zu keinem konkreten Elementtyp mehr.
	it('slice-keeps-element-type', () => {
		expectCheck(`f = (values: List(Integer)) :> Or([] List(Integer)) =>
	sliced = values.slice(1)
	sliced.filterMap((value) => value)`);
	});
	// Der Elementtyp bleibt erhalten (slice-keeps-element-type), die Länge nicht: bei
	// einem Tuple mit Literalgrenzen steht sie aber fest. [1 2 3] ab 2 bis 3 (1-basiert,
	// beide inklusive) sind genau zwei Elemente - dieselbe Arity-Erhaltung, die map
	// schon leistet (map-keeps-tuple-arity). Weil die Länge damit feststeht und größer
	// 0 ist, gehört auch kein Empty ins Ergebnis.
	it('slice-keeps-tuple-arity-for-literal-bounds', () => {
		expectCheck('x: [Integer Integer] = [1 2 3].slice(2 3)');
	});
	// flatten löst eine Ebene Verschachtelung auf und erhält dabei den Elementtyp
	// (analog zu slice-keeps-element-type): aus List(List(Integer)) wird
	// Or([] List(Integer)), nicht Or([] List(Any)).
	it('flatten-keeps-element-type', () => {
		expectCheck(`f = (values: List(List(Integer))) :> Or([] List(Integer)) =>
	values.flatten()`);
	});
	// Leere innere Listen (Or([] List(...)) als Elementtyp) tragen nichts zum
	// Ergebnis bei, sind aber ein gültiges Element der äußeren Liste.
	it('flatten-accepts-empty-inner-lists', () => {
		expectCheck('x: Or([] List(Integer)) = [[1 2] [] [3]].flatten()');
	});
	// Wie filter-return-type-accounts-for-possibly-empty-result: flatten kann die
	// Liste leeren (alle inneren Listen sind Empty), ein deklarierter Rückgabetyp ohne
	// Or([] ...) muss daran scheitern.
	it('flatten-return-type-accounts-for-possibly-empty-result', () => {
		expectCheck(`f = (values: List(List(Integer))) :> List(Integer) =>
	values.flatten()`, {
			errors: [
				{
					code: ErrorCode.returnTypeMismatch,
					message: 'Return type mismatch.\nCan not assign Empty to List(Integer).',
					startRowIndex: 1,
					startColumnIndex: 1,
					endRowIndex: 1,
					endColumnIndex: 17,
					relatedInformation: {
						message: 'Declared as List(Integer) here.',
						startRowIndex: 0,
						startColumnIndex: 37,
						endRowIndex: 0,
						endColumnIndex: 50,
					},
				},
			],
		});
	});
	// Fund (Session 2026-09-10, echter yugioh-Fehler activatableGameCardIds): filter
	// kann die Liste genau wie slice leeren (Laufzeit: `return filtered.length ?
	// filtered : undefined`) - die Signatur in core-lib.jul deklariert das inzwischen
	// korrekt als `Or([] TypeOf(values))`. Dieser Test prüft genau das: ein deklarierter
	// Rückgabetyp ohne Or([] ...) (List(Integer) statt Or([] List(Integer))) muss am
	// möglichen Empty-Ergebnis scheitern.
	it('filter-return-type-accounts-for-possibly-empty-result', () => {
		expectCheck(`f = (values: List(Integer)) :> List(Integer) =>
	values.filter((value) => true)`, {
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
		});
	});
	// Schritt 4 (predicate-types-and-filter-narrowing.md): der auslösende yugioh-Fall.
	// isInteger hat die erkannte Branching-Form (PredicateFacts.ifTrue = Integer).
	// filters Signatur soll den ElementType daher auf Integer schneiden, statt ihn
	// unverändert als Or(Integer Text) durchzureichen.
	it('filter-narrows-element-type-through-predicate', () => {
		expectCheck(`isInteger = (value: Any) :> Boolean =>
	?(value)
		[Integer] => true
		() => false
f = (values: List(Or(Integer Text))) :> Or([] List(Integer)) =>
	values.filter(isInteger)`, {
			errors: [],
		});
	});
	// Gegenprobe: ohne erkannte Prädikat-Form bleibt der ElementType unverändert -
	// predicate/PredicateIfTrue muss dann neutral (Any) sein, sonst würde And(...)
	// den ElementType fälschlich einschränken.
	it('filter-keeps-element-type-without-recognized-predicate', () => {
		expectCheck(`isLegal = (value: Any) :> Boolean => true
f = (values: List(Integer)) :> Or([] List(Integer)) =>
	values.filter(isLegal)`, {
			errors: [],
		});
	});
	// findFirst hat dieselbe Lücke wie filter vor Schritt 4: die Signatur liefert
	// bisher stur Or([] TypeOf(values)/ElementType) statt mit
	// predicate/PredicateIfTrue zu schneiden.
	it('find-first-narrows-element-type-through-predicate', () => {
		expectCheck(`isInteger = (value: Any) :> Boolean =>
	?(value)
		[Integer] => true
		() => false
f = (values: List(Or(Integer Text))) :> Or([] Integer) =>
	values.findFirst(isInteger)`, {
			errors: [],
		});
	});
	// findLast hat denselben Fix und dasselbe Narrowing wie findFirst.
	it('find-last-narrows-element-type-through-predicate', () => {
		expectCheck(`isInteger = (value: Any) :> Boolean =>
	?(value)
		[Integer] => true
		() => false
f = (values: List(Or(Integer Text))) :> Or([] Integer) =>
	values.findLast(isInteger)`, {
			errors: [],
		});
	});
	// Lücke (Session 2026-09-15, predicate-types-and-filter-narrowing Vorarbeit):
	// ein unbenanntes Klammer-Pattern wie `[Integer] => true` (dieselbe Form, die als
	// ?-Branch-Arm überall funktioniert) bekommt beim Checken einen 'tuple'-förmigen
	// ParamsType (aus bracketedExpressionToValueExpression), filter verlangt für
	// predicate aber die 'parameters'-förmige Form `(value: X index: Y) :> Boolean`.
	// getTupleTypeError kennt keinen case 'parameters' und fällt auf den generischen
	// Fehler zurück - die Brücke fehlt komplett. Bisher gibt es dafür auch keinen
	// funktionierenden Beleg in jul-examples oder yugioh.
	it('unnamed-tuple-predicate-is-assignable-to-named-filter-predicate', () => {
		expectCheck(`f = (values: List(Integer)) :> Or([] List(Integer)) =>
	values.filter([Integer] => true)`, {
			errors: [],
		});
	});
	// Ein generischer Rückgabetyp muss auch dann noch auflösbar sein, wenn der Wert
	// vorher durch ein branching gelaufen ist. Die Union der branch Rückgabetypen
	// enthält im rawType noch das unaufgelöste TypeOf(values)/ElementType aus slice,
	// und der folgende filterMap-Aufruf leitet seinen Callback-Parametertyp aus genau
	// diesem rawType ab. Scheitert das, wird der Elementtyp zu Any und über
	// Without(Any []) zu Not(Empty).
	it('generic-return-type-survives-branching', () => {
		expectCheck(`f = (values: List(Integer) flag: Boolean) :> Or([] List(Integer)) =>
	picked = ?(flag)
		[true] => values.slice(1)
		[false] => values
	picked.filterMap((value) => value)`);
	});
	// Präfix-Argument (values in values.first()) referenzierte beim Type-Checken den
	// eigenen Parameter nur als abstrakte parameterReference (zeigt auf f), nicht als
	// deren konkreten deklarierten Typ List(Text). Die unaufgelöste Referenz floss in
	// firsts generische Rückgabetyp-Auflösung (TypeOf(values)/ElementType) und blieb
	// dort hängen - getTypeErrors laxe nestedReference-Rückfallregel verschluckte den
	// Fehler lautlos. Fix: resolvePlaceholders auf prefixArgumentType vor der Verwendung.
	// Wie core-lib (slice, filter, ...) via nativeFunction deklariert - eine reine
	// Signatur ohne Rumpf (case 'functionTypeLiteral'), damit der generische
	// Rückgabetyp nicht wie bei einer echten Funktion mit Rumpf (case 'functionLiteral')
	// schon bei der Deklaration über resolvePlaceholders fest verdrahtet wird.
	it('prefix-argument-resolves-to-declared-type-in-generic-return', () => {
		expectCheck(`first = nativeFunction(
	(values: List(Any)) :> TypeOf(values)/ElementType
	§js values => values[0]§
)
g = (n: Integer) => n
f = (values: List(Text)) =>
	g(values.first())`, {
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nInvalid value for parameter \'n\'\n  Can not assign Text to Integer.',
					startRowIndex: 6,
					startColumnIndex: 3,
					endRowIndex: 6,
					endColumnIndex: 17,
				},
			],
		});
	});
	// Anderer Fall als oben, nicht dieselbe Ursache: first hat hier einen echten Rumpf
	// (case 'functionLiteral' statt 'functionTypeLiteral') mit einem Any-Fallback
	// (assume(1 Any)) statt einer functionTypeLiteral-Deklaration - der deklarierte
	// Rückgabetyp TypeOf(values)/ElementType wird dadurch über einen anderen Codepfad
	// aufgelöst als in der Signatur-Variante oben.
	it('generic-return-type-is-frozen-at-declaration-for-function-literal', () => {
		expectCheck(`first = (values: List(Any)) :> TypeOf(values)/ElementType => assume(1 Any)
g = (n: Integer) => n
f = (values: List(Text)) =>
	g(values.first())`, {
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nInvalid value for parameter \'n\'\n  Can not assign Text to Integer.',
					startRowIndex: 3,
					startColumnIndex: 3,
					endRowIndex: 3,
					endColumnIndex: 17,
				},
			],
		});
	});
	// Ursprünglicher Fund (Vorarbeit zu Schritt 3, Callback-Konsumstelle): derselbe Bug
	// wie oben, hier am echten core-lib-Fall slice statt am minimalen Repro first.
	it('chained-generic-call-checks-element-type', () => {
		expectCheck(`g = (n: Or(List(Integer) [])) => n
f = (values: List(Or(Integer Text))) =>
	g(values.slice(1))`, {
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nInvalid value for parameter \'n\'\n  Can not assign List(Or(Integer Text)) to Or(List(Integer) Empty).\n    Can not assign List(Or(Integer Text)) to List(Integer).\n      Can not assign Text to Integer.',
					startRowIndex: 2,
					startColumnIndex: 3,
					endRowIndex: 2,
					endColumnIndex: 18,
				},
			],
		});
	});
	// Gegenprobe zum vorigen Fund: derselbe Zieltyp meldet den Fehler korrekt, wenn
	// der Wert nicht durch eine Aufrufkette läuft.
	it('direct-value-checks-element-type-without-chaining', () => {
		expectCheck(`g = (n: Or(List(Integer) [])) => n
f = (value: Or([] List(Or(Integer Text)))) =>
	g(value)`, {
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nInvalid value for parameter \'n\'\n  Can not assign List(Or(Integer Text)) to Or(List(Integer) Empty).\n    Can not assign List(Or(Integer Text)) to List(Integer).\n      Can not assign Text to Integer.',
					startRowIndex: 2,
					startColumnIndex: 3,
					endRowIndex: 2,
					endColumnIndex: 8,
				},
			],
		});
	});
	// Gegenprobe zum vorigen Test: OHNE Prädikat wird Or([] List(Or(Integer Text)))
	// zurecht NICHT als Or([] List(Integer)) akzeptiert. Zeigt, dass ein grüner
	// vorheriger Test tatsächlich an einer echten Verengung liegt (nicht an einer
	// generell laxen Prüfung).
	it('list-or-text-not-assignable-to-list-or-integer', () => {
		expectCheck(`g = (n: Or([] List(Integer))) => n
f = (values: List(Or(Integer Text))) =>
	g(values)`, {
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nInvalid value for parameter \'n\'\n  Can not assign List(Or(Integer Text)) to Or(Empty List(Integer)).\n    Can not assign List(Or(Integer Text)) to List(Integer).\n      Can not assign Text to Integer.',
					startRowIndex: 2,
					startColumnIndex: 3,
					endRowIndex: 2,
					endColumnIndex: 9,
				},
			],
		});
	});
	// Branching innerhalb des filterMap-callback selbst: callback/ReturnType wird zu
	// Or(Integer Empty), Without(... Empty) muss davon Integer übrig lassen. Statt
	// dessen wird der Parametertyp offenbar zu Never aufgelöst, sobald values ein
	// Funktionsparameter ist (ein Literal oder eine lokale Variable mit derselben
	// Deklaration lösen den Fehler nicht aus).
	it('generic-return-type-survives-branching-inside-callback', () => {
		expectCheck(`f = (values: List(Integer)) :> Or([] List(Integer)) =>
	values.filterMap(
		(value) =>
			?(value)
				[Integer] => value
				() => []
	)`);
	});
	// map liefert laut Implementierung nur dann empty, wenn schon die Eingabe empty war.
	// Empty ist ein eigener Typ, List und Tuple schließen es also aus: für beide darf
	// im Ergebnis kein Empty stehen.
	it('map-adds-no-empty-for-list', () => {
		expectCheck(`f = (values: List(Integer)) :> List(Integer) =>
	values.map((value) => value)`);
	});
	// Zusätzlich zum Empty muss bei einem Tuple die Arity erhalten bleiben: map bildet
	// elementweise ab, die Länge ändert sich nicht.
	it('map-keeps-tuple-arity', () => {
		expectCheck(`T = [Integer Integer]
f = (values: T) :> T =>
	values.map((value) => value)`);
	});
	// Die Arity darf nicht am geschriebenen Namen hängen: über einen Alias trifft kein
	// Namens-Sonderfall mehr, die Deklaration muss sie allein tragen.
	it('map-keeps-tuple-arity-via-alias', () => {
		expectCheck(`T = [Integer Integer]
m = map
f = (values: T) :> T =>
	m(values (value) => value)`);
	});
	// Gegenprobe: kann die Eingabe empty sein, ist das Empty im Ergebnis korrekt.
	it('map-keeps-empty-for-possibly-empty-input', () => {
		expectCheck(`f = (values: Or([] List(Integer))) :> Or([] List(Integer)) =>
	values.map((value) => value)`);
	});
	// Bug #2, Kandidat lastElement: bei garantiert nicht-leerer Eingabe deklariert
	// lastElement dennoch Or([] TypeOf(values)/ElementType) unconditioned - map macht es
	// mit And(TypeOf(values) []) richtig (siehe map-adds-no-empty-for-list oben).
	it('last-element-adds-no-empty-for-list', () => {
		expectCheck(`f = (values: List(Integer)) :> Integer =>
	values.lastElement()`);
	});
	// TypeOf(value) meint den Typ des Arguments, ein nacktes T das Argument als Typ. Wird
	// beides zum selben Platzhalter, bekommt ein Typ als Argument den Typ "ist ein Integer"
	// statt TypeOf(Integer). Geprüft wird über die Zuweisung an Integer: Ein Typ ist kein
	// Integer. Die Zuweisung an Type taugt dafür nicht, die nimmt auch Integer an.
	it('type-of-parameter-keeps-type-value', () => {
		expectCheck(`typeOfValue = (value: Any) :> TypeOf(value) => value
x: Integer = typeOfValue(Integer)`, {
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nCan not assign TypeOf(Integer) to Integer.',
					startRowIndex: 1,
					startColumnIndex: 0,
					endRowIndex: 1,
					endColumnIndex: 33,
				},
			],
		});
	});
	it('element-type-keeps-type-value', () => {
		expectCheck('x: Integer = [Integer 5].getElement(1)', {
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nCan not assign TypeOf(Integer) to Integer.',
					startRowIndex: 0,
					startColumnIndex: 0,
					endRowIndex: 0,
					endColumnIndex: 38,
				},
			],
		});
	});
	// Eine Funktion als Argument bleibt ein Funktionswert und wird nicht zum Prädikat.
	it('type-of-parameter-keeps-function-type', () => {
		expectCheck(`typeOfValue = (value: Any) :> TypeOf(value) => value
f = (x: Integer) => x
b: (x: Integer) :> Integer = typeOfValue(f)
s: Stream((x: Integer) :> Integer) = completed$(f)`);
	});
	//#endregion generische Rückgabetypen
	//#region dereference
	// Ein Feld, das der Dictionary-Typ nicht hat, ist ein Fehler und nicht Any.
	// Der stille Rückfall auf Any schaltet in getTypeError alle Folgeprüfungen ab,
	// ein einziger blinder Ausdruck macht damit die ganze Kette darunter blind.
	// Der Fehler sitzt auf dem Schlüssel, wie beim Destructuring.
	it('unknown-dictionary-field', () => {
		expectCheck(`d = [a = 1]
d/b`, {
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
		});
	});
	// Gegenprobe: ein vorhandenes Feld darf nicht melden.
	it('known-dictionary-field', () => {
		expectCheck(`d = [a = 1]
d/a`);
	});
	// Gegenprobe: bei Any kann der Checker nicht wissen, ob es das Feld gibt.
	// "weiß ich nicht" darf nicht zu "gibt es nicht" werden.
	it('dictionary-field-on-unknown-type', () => {
		expectCheck(`f = (d: Any) => d/b`);
	});
	// Keiner der beiden Choices hat das Feld 'b': Empty liefert bei JEDEM Feldnamen vakuos
	// Empty zurück (dereferenceNameFromObject, case 'empty'), [a: Integer] hat 'b' nicht.
	// dereferenceNameFromObject's 'or'-Fall muss deshalb prüfen, ob ALLE Choices das Feld
	// haben, statt nur die erfolgreichen herauszufiltern und zu vereinigen - sonst
	// verschluckt der vakuose Erfolg von Empty den echten Fehler von [a: Integer]
	// (Fund: yugioh game-logic.jul:2194, targets: Or([] SelectInputTargets), targets/gameCardId
	// - SelectInputTargets hat nur gameCardIds, nicht gameCardId).
	it('unknown-field-on-union-with-empty-choice', () => {
		expectCheck(`f = (d: Or([] [a: Integer])) => d/b`, {
			errors: [
				{
					code: ErrorCode.dereferenceFailed,
					message: "Failed to dereference field 'b' in type Or(Empty [a: Integer])",
					startRowIndex: 0,
					startColumnIndex: 34,
					endRowIndex: 0,
					endColumnIndex: 35,
				},
			],
		});
	});
	// Ein fehlendes Feld sah bisher identisch aus wie ein vorhandenes Feld vom Typ
	// Empty ("Can not assign Empty to Text."), weil ein fehlendes Feld intern durch
	// Empty ersetzt wurde. Das verschleiert beim Suchen, ob ein Feld wirklich fehlt oder
	// ob sein Wert tatsächlich Empty ist - deshalb eine eigene, eindeutige Meldung.
	// KEINE zusätzliche Elaboration (anders als bei falschen Feldwerten): fehlt ein Feld,
	// gibt es keinen Feld-Ausdruck, auf den man präziser zeigen könnte, als es die
	// Hauptmeldung schon tut (dieselbe Literal-Klammer) - eine zweite CompilerError mit
	// identischem Text an fast derselben Position wäre reine Verdopplung, besonders
	// sichtbar seit dem Rust-Code-Frame (C2): zwei fast gleiche mehrzeilige Frames statt
	// einem. Fund: docs/error-message-elaboration.md, Session 2026-09-10.
	it('missing-dictionary-field-has-distinct-message', () => {
		expectCheck(`T = [a: Integer b: Text]
x: T = [a = 1]`, {
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
		});
	});
	// Gegenprobe: ein tatsächlich vorhandenes Empty-Feld bleibt bei der bisherigen
	// Meldung - der Unterschied ist nur, ob das Feld überhaupt geschrieben wurde. Eine
	// Diagnose, Position am Feldwert [] (TypeScript/Rust/Elm-Vorbild, Session 2026-09-10).
	it('present-empty-dictionary-field-keeps-assignment-message', () => {
		expectCheck(`T = [a: Integer b: Text]
x: T = [a = 1 b = []]`, {
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
		});
	});
	// Wie present-empty-dictionary-field-keeps-assignment-message, aber Ziel ist ein
	// generisches Dictionary(T) statt eines dictionaryLiteral mit benannten Feldern -
	// der Abstieg geht hier durch ZWEI Ebenen (Eintrag "bad", darin Feld "a") bis zum
	// tatsächlichen Wert §wrong§.
	it('generic-dictionary-target-elaborates-per-entry', () => {
		expectCheck(`T = [a: Integer]
x: Dictionary(T) = [
	bad = [a = §wrong§]
]`, {
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
		});
	});
	// Or([] X) ist das Idiom für optionale Felder (CLAUDE.md) - Weglassen muss dafür
	// erlaubt bleiben, wie vor der "Missing field"-Verbesserung. Nur ein Feld, dessen
	// Typ Empty nicht zulässt, darf beim Fehlen gemeldet werden.
	it('optional-field-with-or-empty-type-may-be-omitted', () => {
		expectCheck(`T = [a: Integer b: Or([] Text)]
x: T = [a = 1]`, {
			errors: [],
		});
	});
	// Ein aliasierter Callback-Parameter ("item = value") referenziert sich im Rumpf
	// über eine ParameterReference mit dem LOKALEN Namen ("item"). Deren Auflösung
	// (dereferenceParameterTypeFromFunctionRef) suchte bisher per Name in ParamsType,
	// wo der Parameter aber unter dem QUELLNAMEN ("value") steht - bei einem Alias
	// liefen beide auseinander und der Typ fiel still auf Any zurück. Fund/Ursache
	// eines falschen returnTypeMismatch bei draw() in yugioh/game-logic.jul.
	it('map-callback-parameter-infers-element-type-through-alias', () => {
		expectCheck(`T = [a: Integer]
f = (values: List(T)) :> Text =>
	newValues = values.map(
		(item = value) => item
	)
	newValues`, {
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
		});
	});
	// Aufgeschobener Zugriff: beim Prüfen von f ist d noch ein Platzhalter, der Zugriff
	// bleibt als Knoten stehen und wird erst am Aufruf aufgelöst. Ein bekanntes Feld
	// muss dabei seinen genauen Typ behalten.
	it('deferred-dictionary-field-keeps-exact-type', () => {
		expectCheck(`f = (d: [a: Integer b: Text]) => d/b
y: Text = f([a = 1 b = §x§])`);
	});
	// Gegenprobe zum vorigen: aufgelöst wird gegen den Argumenttyp, das Ergebnis ist
	// also das Textliteral und nicht die Vereinigung aller Felder.
	it('deferred-dictionary-field-is-not-union-of-all-fields', () => {
		expectCheck(`f = (d: [a: Integer b: Text]) => d/b
y: Integer = f([a = 1 b = §x§])`, {
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
		});
	});
	// Die Länge eines Tuples ist bekannt, ein Zugriff dahinter also nachweisbar falsch.
	// Indizes sind 1-basiert.
	it('index-out-of-tuple-range', () => {
		expectCheck(`a = [1 2]
a/5`, {
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
		});
	});
	// Gegenprobe: ein gültiger Index darf nicht melden.
	it('index-in-tuple-range', () => {
		expectCheck(`a = [1 2]
a/2`);
	});
	// Gegenprobe: eine List hat keine bekannte Länge, dort ist kein Index zu weit.
	it('index-on-list', () => {
		expectCheck(`f = (x: List(Integer)) => x/5`);
	});
	// Ohne bekannte Länge ist die Position aber auch nicht beweisbar vorhanden: eine
	// List kann ein einziges Element haben, Empty gehört also in den Typ.
	it('index-on-list-may-be-empty', () => {
		expectCheck(`f = (x: List(Integer)) => x/5
y: Integer = f([1 2])`, {
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
		});
	});
	// Eine positionale Kollektion trägt keine benannten Felder. Der Name kann dort nicht
	// danebenliegen, er passt gar nicht zur Art der Quelle - beweisbar falsch, nicht unbekannt.
	// Die Meldung nennt die Anforderung des Zugriffs, nicht die Beschaffenheit der Quelle:
	// sonst bräuchte jede Quellart eine eigene Variante.
	it('field-name-on-positional-collection', () => {
		expectCheck(`a = [1 5]
a/name`, {
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
		});
	});
	// Gegenstück: ein Dictionary hat keine Positionen.
	it('index-on-dictionary', () => {
		expectCheck(`dict = [key = 5]
dict/1`, {
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
		});
	});
	// Ein Primitive trägt weder Felder noch Positionen - dieselben beiden Meldungen greifen,
	// ohne dass der Typ in ihnen vorkommt.
	it('field-name-on-primitive', () => {
		expectCheck(`n = 5
n/name`, {
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
		});
	});
	it('index-on-primitive', () => {
		expectCheck(`n = 5
n/1`, {
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
		});
	});
	//#endregion dereference
	//#region Zugriffstypen
	// getElement deklariert seinen Rückgabetyp über ElementAt, die Präzision hängt also
	// nicht mehr am Funktionsnamen. Von der genauesten Lage zur unbestimmtesten sortiert.
	// Ein Literal-Index in ein Tuple kennt seine Position exakt: Text, nicht die
	// Vereinigung aller Positionen und kein Empty.
	it('get-element-literal-index-in-tuple', () => {
		expectCheck(`x: Text = [1 §a§].getElement(2)`);
	});
	// Ein Literal-Index hinter dem Ende eines bekannten Tuples trifft nachweisbar
	// nichts. getElement meldet das nicht (ein berechneter Index darf danebenliegen),
	// liefert aber Empty statt der Vereinigung aller Positionen.
	it('get-element-index-out-of-tuple-range-is-empty', () => {
		expectCheck(`x: [] = [1 §a§].getElement(5)`);
	});
	// Jeder Choice eines Union-Index ist ein eigener Zugriff. Trifft jeder von ihnen
	// eine vorhandene Position, gehört kein Empty ins Ergebnis. Der Index muss dafür
	// als Variable mit Union-Typ ankommen — ein Literal-Argument wäre schon verengt.
	it('get-element-union-index-in-tuple-range', () => {
		expectCheck(`f = (index: Or(1 2)) =>
	values: [Integer Text] = [1 §a§]
	element: Or(Integer Text) = values.getElement(index)
	element`);
	});
	// Gegenprobe: liegt ein Choice daneben, steuert er Empty bei.
	it('get-element-union-index-partly-out-of-range', () => {
		expectCheck(`f = (index: Or(2 5)) =>
	values: [Integer Text] = [1 §a§]
	element: Or([] Text) = values.getElement(index)
	element`);
	});
	// Ohne Literal-Index steht die Position nicht fest: Vereinigung aller Positionen,
	// dazu Empty, weil der Index danebenliegen kann.
	it('get-element-non-literal-index', () => {
		expectCheck(`f = (values: [Integer Text] index: PositiveInteger) => values.getElement(index)
y: Or([] Integer Text) = f([1 §a§] 1)`);
	});
	// Kann die Quelle selbst empty sein, bleibt Empty im Ergebnis.
	it('get-element-on-possibly-empty-list', () => {
		expectCheck(`f = (values: Or([] List(Integer))) => values.getElement(1)
y: Or([] Integer) = f([1])`);
	});
	// ElementAt faltet den Zugriff schon in der Typposition.
	it('element-at-in-type-position', () => {
		expectCheck(`x: ElementAt([Integer Text] 2) = §a§`);
	});
	// Dieselbe Präzision steht Nutzercode offen: ein eigener Wrapper kann den genauen
	// Rückgabetyp deklarieren, statt ihn an getElement zu binden.
	it('element-at-in-user-function', () => {
		expectCheck(`second = (values: List(Any)) :> ElementAt(TypeOf(values) 2) => values.getElement(2)
y: Text = [1 §a§].second()`);
	});
	// Ein Spread im Literal setzt die Folgen schon heute genau zusammen ([...a ...b] auf
	// zwei Tupeln ergibt deren Aneinanderreihung). Diese Faltung ist von einer
	// Deklaration aus aber nicht erreichbar - Concat gibt ihr einen Namen.
	it('concat-in-type-position', () => {
		expectCheck(`x: Concat([Integer Text] [Boolean]) = [1 §a§ true]`);
	});
	// Der eigentliche Fund: über die Funktionsgrenze geht die Zusammensetzung verloren.
	// Der Rumpf wird einmal mit den deklarierten Parametertypen inferiert, hier also zu
	// List(Any); nur ein deklarierter Rückgabetyp aus aufschiebbaren Konstruktoren wird
	// je Aufruf neu aufgelöst.
	it('concat-in-user-function', () => {
		expectCheck(`myConcat = (a: List(Any) b: List(Any)) :> Concat(TypeOf(a) TypeOf(b)) => [...a ...b]
y: [Integer Text Boolean] = myConcat([1 §a§] [true])`);
	});
	// Gegenprobe: bei Listen steht die Länge nicht fest, also bleibt nur eine List -
	// aber eine nicht-leere, denn beide Teile sind es.
	it('concat-of-lists-keeps-element-types', () => {
		expectCheck(`f = (a: List(Integer) b: List(Text)) :> Concat(TypeOf(a) TypeOf(b)) => [...a ...b]
y: List(Or(Integer Text)) = f([1] [§a§])`);
	});
	// Ohne Annotation: Spread im Rumpf faltet heute eager mit resolvePlaceholders auf den
	// deklarierten Parametertyp (List(Any)), statt wie am Aufrufort mit
	// dereferenceArgumentTypesNested die konkreten Argumenttypen einzusetzen - die
	// Tuple-Arität geht verloren, obwohl Concat sie mit Annotation exakt berechnet
	// (siehe concat-in-user-function). Red test für
	// docs/generic-types-through-function-body.md.
	it('concat-in-user-function-without-annotation', () => {
		expectCheck(`myConcat = (a: List(Any) b: List(Any)) => [...a ...b]
y: [Integer Text Boolean] = myConcat([1 §a§] [true])`);
	});
	//#endregion Zugriffstypen
	//#region Aufruf
	// Infix-Aufruf: das prefixArgument wird zum 1. Argument.
	it('prefix-function-call', () => {
		expectCheck('4.log()');
	});
	// Ein Wert, der keine Funktion ist, kann nicht aufgerufen werden. Heute liefert
	// getParamsType dafür Any, damit ist auch die Argumentprüfung wirkungslos und der
	// Fehler bleibt still. Die Meldung folgt dem Muster von branchIsNotFunction.
	// Der Fehler sitzt auf dem aufgerufenen Ausdruck, nicht auf dem ganzen Aufruf.
	it('call-of-non-function', () => {
		expectCheck(`a = 1
a(1)`, {
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
		});
	});
	// Gegenprobe: der Aufruf einer Funktion darf nicht melden.
	it('call-of-function', () => {
		expectCheck(`a = (x: Integer) => x
a(1)`);
	});
	// Gegenprobe: bei Any kann der Checker nicht wissen, ob der Wert aufrufbar ist.
	it('call-of-unknown-type', () => {
		expectCheck(`f = (a: Any) => a(1)`);
	});
	// Argumente werden auch dann geprüft, wenn der Aufruf selbst ungültig ist —
	// sie sind eigene Ausdrücke mit eigenen Fehlern.
	it('call-of-non-function-still-checks-arguments', () => {
		expectCheck(`g = (x: Text) => x
a = 1
a(g(5))`, {
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
					"endColumnIndex": 5,
					"endRowIndex": 2,
					"message": "Argument type mismatch.\nInvalid value for parameter 'x'\n  Can not assign 5 to Text.",
					"startColumnIndex": 4,
					"startRowIndex": 2,
				},
			],
		});
	});
	//#endregion Aufruf
	//#region Callback-Parametertypen
	// Kontravarianz an der Parameterposition: der Callback muss alles annehmen, was der
	// Aufrufer ihm übergibt. Fordert er PositiveInteger, wo Integer durchgereicht wird,
	// bleibt die 0 (und jede negative Zahl) unversorgt.
	// Beschriftet wird der TYP des Parameters, nicht ein Wert: hier steht die Signatur des
	// Callbacks zur Prüfung, kein Argument, das an 'value' übergeben würde.
	it('callback-parameter-type-narrower-than-declared', () => {
		expectCheck(`f = (callback: (value: Integer) :> Any) => callback(1)
f((value: PositiveInteger) => value)`, {
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 35,
					"endRowIndex": 1,
					"message": "Argument type mismatch.\nInvalid value for parameter 'callback'\n  Invalid type for parameter 'value'\n    Can not assign Integer to Greater(0).",
					"startColumnIndex": 2,
					"startRowIndex": 1,
				},
			],
		});
	});
	// Gegenprobe: fordert der Callback weniger, als der Aufrufer zusichert, ist alles gut.
	it('callback-parameter-type-wider-than-declared', () => {
		expectCheck(`f = (callback: (value: PositiveInteger) :> Any) => callback(1)
f((value: Integer) => value)`);
	});
	// Bug: anders als bei einem Parameter (siehe callback-parameter-type-narrower-
	// than-declared, "Invalid value for parameter 'value'") bekommt der Rückgabetyp
	// keine eigene Beschriftung - der Leser sieht nur "Can not assign 0 to Text." unter
	// 'callback' und muss selbst erschliessen, dass damit der Rückgabewert gemeint ist.
	it('callback-return-type-mismatch-names-the-return-value', () => {
		expectCheck(`f = (callback: (value: Integer) :> Text) => callback(1)
f((value: Integer) => 0)`, {
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: "Argument type mismatch.\nInvalid value for parameter 'callback'\n  Invalid return value\n    Can not assign 0 to Text.",
					startColumnIndex: 2,
					startRowIndex: 1,
					endColumnIndex: 23,
					endRowIndex: 1,
				},
			],
		});
	});
	// Derselbe Fall über einen generischen Elementtyp: aggregate reicht die Elemente von
	// [0 1 2] durch, der Callback fordert aber PositiveInteger - die 0 passt nicht.
	it('callback-parameter-type-narrower-than-passed-element', () => {
		expectCheck(`aggregate(
	[0 1 2]
	0
	(accumulator value: PositiveInteger) => value
)`, {
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 46,
					"endRowIndex": 3,
					"message": "Argument type mismatch.\nInvalid value for parameter 'callback'\n  Invalid type for parameter 'value'\n    Can not assign 0 to Greater(0).",
					"startColumnIndex": 1,
					"startRowIndex": 3,
				},
			],
		});
	});
	// Gegenprobe: fordert der Callback nur Integer, passt jedes Element.
	it('callback-parameter-type-wide-enough', () => {
		expectCheck(`aggregate(
	[0 1 2]
	0
	(accumulator value: Integer) => value
)`);
	});
	//#endregion Callback-Parametertypen
	//#region erwarteter Typ
	// Ein Funktionsliteral bekommt die Typen seiner untypisierten Parameter aus dem erwarteten
	// Typ der Stelle, an der es steht - nicht nur als direktes Argument eines Aufrufs. Der Rumpf
	// wird dann gegen diesen Typ geprüft: x ist Integer, der Rückgabewert also kein Text.
	// Die erwarteten Meldungen entsprechen denen mit ausgeschriebenem (x: Integer).
	it('expected-type-definition-type-guard', () => {
		expectCheck('f: (x: Integer) :> Text = (x) => x', {
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 34,
					"endRowIndex": 0,
					"message": "Definition type mismatch.\nInvalid return value\n  Can not assign Integer to Text.",
					"startColumnIndex": 0,
					"startRowIndex": 0,
				},
			],
		});
	});
	it('expected-type-dictionary-field-behind-type-guard', () => {
		expectCheck('h: [cb: (x: Integer) :> Text] = [cb = (x) => x]', {
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 46,
					"endRowIndex": 0,
					"message": "Definition type mismatch.\nCan not assign [cb: (x: Integer) -> Integer] to [cb: (x: Integer) :> Text].\n  Invalid value for field 'cb'\n    Invalid return value\n      Can not assign Integer to Text.",
					"startColumnIndex": 38,
					"startRowIndex": 0,
				},
			],
		});
	});
	it('expected-type-dictionary-argument', () => {
		expectCheck(`g = (o: [cb: (x: Integer) :> Text]) => o
g([cb = (x) => x])`, {
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 16,
					"endRowIndex": 1,
					"message": "Argument type mismatch.\nInvalid value for parameter 'o'\n  Can not assign [cb: (x: Integer) -> x] to [cb: (x: Integer) :> Text].\n    Invalid value for field 'cb'\n      Invalid return value\n        Can not assign Integer to Text.",
					"startColumnIndex": 8,
					"startRowIndex": 1,
				},
			],
		});
	});
	it('expected-type-list-element', () => {
		expectCheck('l: List((x: Integer) :> Text) = [(x) => x]', {
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 41,
					"endRowIndex": 0,
					"message": "Definition type mismatch.\nInvalid return value\n  Can not assign Integer to Text.",
					"startColumnIndex": 33,
					"startRowIndex": 0,
				},
			],
		});
	});
	// Bei List(X) verlangt jede Position dasselbe, ein Spread davor ändert daran nichts.
	it('expected-type-list-element-after-spread', () => {
		expectCheck(`others: List((x: Integer) :> Text) = [(x: Integer) => §a§]
l: List((x: Integer) :> Text) = [...others (x) => x]`, {
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 51,
					"endRowIndex": 1,
					"message": "Definition type mismatch.\nInvalid return value\n  Can not assign Integer to Text.",
					"startColumnIndex": 43,
					"startRowIndex": 1,
				},
			],
		});
	});
	// Hinter einem Spread ist die Position unbekannt, das Argument landet aber in jedem Fall
	// im Rest-Parameter, wenn der Spread erst dort beginnt.
	it('expected-type-rest-argument-after-spread', () => {
		expectCheck(`g = (...cbs: List((x: Integer) :> Text)) => cbs
others: List((x: Integer) :> Text) = [(x: Integer) => §a§]
g(...others (x) => x)`, {
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 20,
					"endRowIndex": 2,
					"message": "Argument type mismatch.\nInvalid value for parameter 'cbs'\n  Invalid return value\n    Can not assign Integer to Text.",
					"startColumnIndex": 12,
					"startRowIndex": 2,
				},
			],
		});
	});
	// Benannte Argumente werden über den Namen zugeordnet, nicht über die Position.
	it('expected-type-named-argument', () => {
		expectCheck(`g = (a: Integer cb: (x: Integer) :> Text) => a
g(cb = (x) => x a = 1)`, {
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 15,
					"endRowIndex": 1,
					"message": "Argument type mismatch.\nInvalid value for parameter 'cb'\n  Invalid return value\n    Can not assign Integer to Text.",
					"startColumnIndex": 7,
					"startRowIndex": 1,
				},
			],
		});
	});
	// Das Präfix-Argument ist das erste Argument, es erwartet den ersten Parameter.
	it('expected-type-prefix-argument', () => {
		expectCheck(`g = (o: [cb: (v: Integer) :> Text]) => o
x = [cb = (v) => v].g()`, {
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 18,
					"endRowIndex": 1,
					"message": "Argument type mismatch.\nInvalid value for parameter 'o'\n  Can not assign [cb: (v: Integer) -> Integer] to [cb: (v: Integer) :> Text].\n    Invalid value for field 'cb'\n      Invalid return value\n        Can not assign Integer to Text.",
					"startColumnIndex": 10,
					"startRowIndex": 1,
				},
			],
		});
	});
	it('expected-type-declared-return-type', () => {
		expectCheck(`k = ()
	:>
		(x: Integer) :> Text
	=>
		(x) => x`, {
			errors: [
				{
					"code": ErrorCode.returnTypeMismatch,
					"endColumnIndex": 10,
					"endRowIndex": 4,
					"message": "Return type mismatch.\nInvalid return value\n  Can not assign Integer to Text.",
					"relatedInformation": {
						"endColumnIndex": 22,
						"endRowIndex": 2,
						"message": "Declared as (x: Integer) :> Text here.",
						"startColumnIndex": 2,
						"startRowIndex": 2,
					},
					"startColumnIndex": 2,
					"startRowIndex": 4,
				},
			],
		});
	});
	it('expected-type-nested-dictionary', () => {
		expectCheck('h: [outer: [cb: (x: Integer) :> Text]] = [outer = [cb = (x) => x]]', {
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 64,
					"endRowIndex": 0,
					"message": "Definition type mismatch.\nCan not assign [outer: [cb: (x: Integer) -> Integer]] to [outer: [cb: (x: Integer) :> Text]].\n  Invalid value for field 'outer'\n    Can not assign [cb: (x: Integer) -> Integer] to [cb: (x: Integer) :> Text].\n      Invalid value for field 'cb'\n        Invalid return value\n          Can not assign Integer to Text.",
					"startColumnIndex": 56,
					"startRowIndex": 0,
				},
			],
		});
	});
	// Ein Platzhalter auf einen Parameter der umgebenden Funktion bleibt im erwarteten Typ
	// stehen und wird erst beim Prüfen über dessen Deklaration aufgelöst.
	it('expected-type-placeholder-of-enclosing-function', () => {
		expectCheck(`f = (values: List(Integer)) =>
	h: [cb: (x: TypeOf(values)/ElementType) :> Text] = [cb = (x) => x]
	h`, {
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 66,
					"endRowIndex": 1,
					"message": "Definition type mismatch.\nCan not assign [cb: (x: Integer) -> Integer] to [cb: (x: Integer) :> Text].\n  Invalid value for field 'cb'\n    Invalid return value\n      Can not assign Integer to Text.",
					"startColumnIndex": 58,
					"startRowIndex": 1,
				},
			],
		});
	});
	// Aus einer Union zählen nur die Zweige, die ein Funktionsliteral aufnehmen können.
	it('expected-type-optional-callback-argument', () => {
		expectCheck(`g = (cb: Or([] (x: Integer) :> Text)) => 1
g((x) => x)`, {
			errors: [
				{
					"code": ErrorCode.argumentTypeMismatch,
					"endColumnIndex": 10,
					"endRowIndex": 1,
					"message": "Argument type mismatch.\nInvalid value for parameter 'cb'\n  Can not assign (x: Integer) -> x to Or(Empty (x: Integer) :> Text).\n    Invalid return value\n      Can not assign Integer to Text.",
					"startColumnIndex": 2,
					"startRowIndex": 1,
				},
			],
		});
	});
	it('expected-type-optional-callback-type-guard', () => {
		expectCheck('f: Or([] (x: Integer) :> Text) = (x) => x', {
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 41,
					"endRowIndex": 0,
					"message": "Definition type mismatch.\nCan not assign (x: Integer) -> Integer to Or(Empty (x: Integer) :> Text).\n  Invalid return value\n    Can not assign Integer to Text.",
					"startColumnIndex": 0,
					"startRowIndex": 0,
				},
			],
		});
	});
	// Die schon geschriebenen Felder des Literals sortieren die Zweige aus: kind = §a§
	// passt nur zum ersten, cb erwartet also (x: Integer) :> Text. Markiert wird deshalb cb.
	it('expected-type-discriminated-union', () => {
		expectCheck('h: Or([kind: §a§ cb: (x: Integer) :> Text] [kind: §b§ cb: (x: Text) :> Text]) = [kind = §a§ cb = (x) => x]', {
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 105,
					"endRowIndex": 0,
					"message": "Definition type mismatch.\nInvalid value for field 'cb'\n  Invalid return value\n    Can not assign Integer to Text.\nInvalid value for field 'kind'\n  Can not assign §a§ to §b§.\nInvalid value for field 'cb'\n  Invalid type for parameter 'x'\n    Can not assign Text to Integer.",
					"startColumnIndex": 97,
					"startRowIndex": 0,
				},
			],
		});
	});
	// Ein Zweig, der ein im Literal fehlendes Feld verlangt, fällt weg: species fehlt, also
	// erwartet cb (v: Integer) :> Text. Markiert wird deshalb cb.
	it('expected-type-union-branch-with-missing-field', () => {
		expectCheck('x: Or([name: Text age: Integer cb: (v: Integer) :> Text] [name: Text species: Text cb: (v: Text) :> Text]) = [name = §Ada§ age = 36 cb = (v) => v]', {
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 145,
					"endRowIndex": 0,
					"message": "Definition type mismatch.\nInvalid value for field 'cb'\n  Invalid return value\n    Can not assign Integer to Text.\nMissing field 'species'.\nInvalid value for field 'cb'\n  Invalid type for parameter 'v'\n    Can not assign Text to Integer.",
					"startColumnIndex": 137,
					"startRowIndex": 0,
				},
			],
		});
	});
	// Gegenprobe: ein Feld, dessen Typ Empty zulässt, darf fehlen - der Zweig bleibt, es
	// bleiben also zwei Funktionszweige und v ohne Typ.
	it('expected-type-union-branch-with-optional-field-stays', () => {
		expectCheck('x: Or([name: Text age: Integer cb: (v: Integer) :> Text] [name: Text species: Or([] Text) cb: (v: Text) :> Text]) = [name = §Ada§ age = 36 cb = (v) => v]');
	});
	// Gegenprobe: ohne erwarteten Typ bleibt ein untypisierter Parameter Any.
	it('expected-type-absent-leaves-parameter-untyped', () => {
		expectCheck('f = (x) => x');
	});
	// Gegenprobe: ein passender Rumpf bleibt ohne Meldung.
	it('expected-type-matching-body', () => {
		expectCheck('f: (x: Integer) :> Integer = (x) => x');
	});
	// Gegenprobe: ein geschriebener Parametertyp geht dem erwarteten vor, gemeldet wird die
	// Kontravarianz.
	it('expected-type-written-parameter-type-wins', () => {
		expectCheck('f: (x: Integer) :> Text = (x: Text) => x', {
			errors: [
				{
					"code": ErrorCode.definitionTypeMismatch,
					"endColumnIndex": 40,
					"endRowIndex": 0,
					"message": "Definition type mismatch.\nInvalid type for parameter 'x'\n  Can not assign Integer to Text.",
					"startColumnIndex": 0,
					"startRowIndex": 0,
				},
			],
		});
	});
	// Gegenprobe: bleiben nach dem Aussortieren mehrere Funktionszweige, gibt es keinen
	// erwarteten Parametertyp, x bleibt Any.
	it('expected-type-several-function-branches-leave-parameter-untyped', () => {
		expectCheck(`g = (cb: Or((x: Integer) :> Text (x: Text) :> Text)) => 1
g((x) => x)`);
	});
	//#endregion erwarteter Typ
	//#region verworfene Werte
	// Ein längerer Wert ist zulässig - ein Typ nennt Anforderungen, kein vollständiges
	// Bild. Die 2 steht aber im Quelltext und kommt nirgends an. Gemeldet wird der
	// überzählige Ausdruck selbst, damit der Leser sieht, was er löschen kann.
	it('call-surplus-argument-is-discarded', () => {
		expectCheck(`f = (a: Integer) => a
f(1 2)`, {
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
		});
	});
	// Jeder überzählige Ausdruck ist einzeln löschbar und wird einzeln gemeldet.
	it('every-surplus-argument-is-reported', () => {
		expectCheck(`f = (a: Integer) => a
f(1 2 3)`, {
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
		});
	});
	// Ein Spread verschiebt die Zuordnung unbekannt weit: welcher Wert überzählig wäre,
	// steht nicht im Quelltext, und zu löschen gäbe es nichts.
	it('spread-argument-is-not-discarded', () => {
		expectCheck(`values = [1 2 3]
f = (a: Integer) => a
f(...values)`);
	});
	// War CHECKER-AUDIT.md #6: eine reine Spread-Argumentliste (kein Feld/Element daneben)
	// parst zu 'object' statt zu 'list' (ParseUnknownObjectLiteral - Liste oder
	// Dictionary, je nach Typ der Quelle), und case 'object' löste das nie auf, sondern
	// gab immer Any zurück. Fix: Auflösung wie in case 'list' über getSpreadElementTypes.
	it('spread-argument-is-not-type-checked', () => {
		expectCheck(`values = [§x§]
f = (a: Integer) => a
f(...values)`, {
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nInvalid value for parameter \'a\'\n  Can not assign §x§ to Integer.',
					startRowIndex: 2,
					startColumnIndex: 0,
					endRowIndex: 2,
					endColumnIndex: 12,
				},
			],
		});
	});
	// Gegenstück zu spread-argument-is-not-type-checked: eine reine Spread-Argumentliste
	// kann laut ParseUnknownObjectLiteral auch ein Dictionary werden (benannte Argumente) -
	// case 'object' muss also denselben Fehler melden wie derselbe Wert direkt geschrieben
	// (f(a = §x§)), nicht nur case 'list'.
	it('dictionary-spread-argument-is-not-type-checked', () => {
		expectCheck(`namedArgs = [a = §x§]
f = (a: Integer) => a
f(...namedArgs)`, {
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: 'Argument type mismatch.\nInvalid value for parameter \'a\'\n  Can not assign §x§ to Integer.',
					startRowIndex: 2,
					startColumnIndex: 0,
					endRowIndex: 2,
					endColumnIndex: 15,
				},
			],
		});
	});
	// Der Spread einer Union verteilt sich über ihre Choices: jede Choice ergibt ein eigenes
	// Dictionary mit den zusätzlichen Feldern. Die Zuweisung an Empty macht den Typ sichtbar.
	it('dictionary-spread-of-union-distributes-over-choices', () => {
		expectCheck(`f = (s: Or([a: Integer] [b: Text])) =>
	x: Empty = [...s c = 1]
	x`, {
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nCan not assign [\n  a: Integer\n  c: 1\n] to Empty.\nCan not assign [\n  b: Text\n  c: 1\n] to Empty.',
					startRowIndex: 1,
					startColumnIndex: 1,
					endRowIndex: 1,
					endColumnIndex: 24,
				},
			],
		});
	});
	// Empty trägt beim Spread keine Felder bei. Aus Or([] [a: Integer]) werden [c: 1] und
	// [a: Integer c: 1], zusammengefasst [c: 1].
	it('dictionary-spread-of-possibly-empty-value', () => {
		expectCheck(`f = (s: Or([] [a: Integer])) =>
	x: Empty = [...s c = 1]
	x`, {
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nCan not assign [c: 1] to Empty.',
					startRowIndex: 1,
					startColumnIndex: 1,
					endRowIndex: 1,
					endColumnIndex: 24,
				},
			],
		});
	});
	// Wechsel des Diskriminators per Spread: kommt der Wert aus einer Choice ohne
	// attackerId, fehlt das Feld, das die Ziel-Choice zu §attack§ verlangt.
	it('dictionary-spread-of-union-checks-each-choice', () => {
		expectCheck(`State = Or([status: []] [status: §attack§ attackerId: Integer])
f = (s: State) =>
	x: State = [...s status = §attack§]
	x`, {
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nCan not assign [status: §attack§] to [status: Empty].\n  Invalid value for field \'status\'\n    Can not assign §attack§ to Empty.\nMissing field \'attackerId\'.',
					startRowIndex: 2,
					startColumnIndex: 1,
					endRowIndex: 2,
					endColumnIndex: 36,
				},
			],
		});
	});
	// Eine Variable darf legitim mehr enthalten, als die Parameterliste fordert - das ist
	// die Regel der Sprache, und im Quelltext steht an dieser Stelle nichts zu löschen.
	it('variable-with-longer-tuple-is-not-discarded', () => {
		expectCheck(`v = [1 2 3]
f = (a: Integer) => a
f(...v)`);
	});
	// Die Werteliste gehört dem branching, nicht einem einzelnen branch: ein späterer
	// branch darf das zweite Element aufnehmen.
	it('branch-value-list-is-not-discarded', () => {
		expectCheck(`x = ?(1 2)
	(a: Integer) => a`);
	});
	// Der Rest-Parameter nimmt alles auf, überzählig ist damit nichts.
	it('rest-parameter-consumes-surplus', () => {
		expectCheck(`f = (...args: Or([] List(Integer))) => args
f(1 2 3)`);
	});
	// Gegenprobe: genau so viele Argumente wie Parameter meldet nicht.
	it('matching-argument-count-is-not-discarded', () => {
		expectCheck(`f = (a: Integer b: Integer) => a
f(1 2)`);
	});
	// Dasselbe für ein Dictionary-Literal als Argumentkollektion: b kommt nirgends an,
	// weil die Parameterliste kein b hat. Gemeldet wird das ganze Feld, denn das ist
	// die Einheit, die gelöscht wird.
	it('call-surplus-named-argument-is-discarded', () => {
		expectCheck(`f = (a: Integer) => a
f(a = 1 b = 2)`, {
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
		});
	});
	// Eine Zuweisung verwirft nichts: der TypeGuard prüft, er formt nicht um. x behält
	// den Typ des Werts samt drittem Element, x/3 bleibt lesbar und das emittierte JS
	// enthält alle drei. Nur der Aufruf lässt überzählige Werte fallen.
	it('assignment-discards-nothing', () => {
		expectCheck('x: [Integer Integer] = [1 2 3]');
	});
	// Dasselbe für Felder: x behält b, der TypeGuard schneidet es nicht weg.
	// Vgl. jul-examples/type-checking-test.jul testDictionaryLiteral3a.
	it('assignment-keeps-surplus-field', () => {
		expectCheck('x: [a: Integer] = [a = 1 b = 2]');
	});
	// Gegenprobe: ein Feld, das die Parameterliste kennt, meldet nicht.
	it('known-named-argument-is-not-discarded', () => {
		expectCheck(`f = (a: Integer b: Integer) => a
f(a = 1 b = 2)`);
	});
	// Ein Prefix-Argument bindet schon Parameter — eine gleichnamige explizite
	// Bindung sollte als discarded gemeldet werden, tut es aber nicht.
	// Beispiel: 1.f(a = 2) bindet a = 1 positionell, a = 2 ist überzählig.
	it('prefix-argument-overrides-same-named-argument', () => {
		expectCheck(`f = (a: Integer) => a
1.f(a = 2)`, {
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
		});
	});
	// Benannte Argumente gegen einen rest-Parameter sind nicht umgesetzt: der Checker
	// meldet es, und tryAssignArgs wirft zur Laufzeit. Der Test hält den Zustand fest -
	// verschwindet die Meldung, ist die Lücke geschlossen.
	it('named-arguments-with-rest-parameter-are-not-supported', () => {
		expectCheck(`f = (a: Integer ...args: Or([] List(Any))) => a
f(a = 1 b = 2)`, {
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
		});
	});
	// Beim Destructuring hält keine Variable den ganzen Wert: _temp ist blocklokal, nur
	// die gebundenen Namen kommen heraus. b ist danach unerreichbar.
	it('destructuring-surplus-field-is-discarded', () => {
		expectCheck('(a) = [a = 1 b = 2]\nc = a', {
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
		});
	});
	// Gelesen wird über die Quelle, nicht über den neuen Namen: (x = a) bindet a.
	it('destructuring-alias-uses-source-name', () => {
		expectCheck('(x = a) = [a = 1 b = 2]\nc = x', {
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
		});
	});
	// Gegenprobe: alle Felder werden gebunden.
	it('destructuring-known-fields-are-not-discarded', () => {
		expectCheck('(a b) = [a = 1 b = 2]\nc = [a b]');
	});
	// Positionelles Destructuring: die Liste hat keine Felder namens a/b, nur Indizes.
	// Die Laufzeit löst das über die Position auf (_isArray ? _temp[0] : _temp.a), der
	// Checker sucht bisher nur über den Namen und meldet fälschlich dereferenceFailed.
	it('positional-destructuring-from-list', () => {
		expectCheck('(a b) = [1 2]\nc = [a b]');
	});
	// Im Rumpf ist a noch ein Parameter, der Spread bleibt deshalb ein unaufgelöstes Concat.
	// Auch daraus sind die Positionen lesbar, das Destructuring darf nicht scheitern.
	it('positional-destructuring-from-spread-of-generic-list-parameter', () => {
		expectCheck(`myFn = (a: List(Integer)) =>
	(x y) = [...a 1]
	[x y]`);
	});
	// Position 1 existiert in einer List immer, x ist also Integer und nicht Or(Empty Integer).
	// Die Position darf nicht verloren gehen, nur weil die Quelle ein Parameter ist.
	it('positional-destructuring-from-generic-list-parameter-keeps-first-position', () => {
		expectCheck(`f = (i: Integer) => i
myFn = (a: List(Integer)) =>
	(x y) = a
	[f(x) y]`);
	});
	// Eine Variable darf legitim mehr Felder haben, und zu löschen gäbe es hier nichts.
	it('destructuring-from-variable-is-not-discarded', () => {
		expectCheck(`v = [a = 1 b = 2]
(a) = v
c = a`);
	});
	// Löst ein gewünschter Name nicht auf, ist das die Ursache - dass a übrig bleibt,
	// ist nur ihre Folge. Gemeldet wird deshalb nur der Name, nicht zusätzlich das Feld.
	it('unresolved-destructuring-name-suppresses-discarded-warning', () => {
		expectCheck('(myA1 b) = [a = 1 b = 2]\nc = [myA1 b]', {
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
		});
	});
	//#endregion verworfene Werte
	//#region Schreibweise
	const namingCaseWarning = (name: string, isType: boolean, row: number, column: number): CompilerError => ({
		code: ErrorCode.namingCase,
		message: isType
			? `'${name}' is a type and should start with an uppercase letter.`
			: `'${name}' is not a type and should start with a lowercase letter.`,
		startRowIndex: row,
		startColumnIndex: column,
		endRowIndex: row,
		endColumnIndex: column + name.length,
	});
	it('naming-case-conforming', () => {
		expectCheck(`Pair = [Integer Text]
Point = [x: Integer y: Integer]
Number = Or(Integer Float)
Wrap = (T: Type) => List(T)
x = 4
values = [1 2]
f = (value: Integer) => value`);
	});
	it('naming-case-tuple-type-lowercase', () => {
		expectCheck('pair = [Integer Text]', {
			errors: [namingCaseWarning('pair', true, 0, 0)],
		});
	});
	it('naming-case-dictionary-type-lowercase', () => {
		expectCheck('point = [x: Integer y: Integer]', {
			errors: [namingCaseWarning('point', true, 0, 0)],
		});
	});
	it('naming-case-alias-lowercase', () => {
		expectCheck('number = Integer', {
			errors: [namingCaseWarning('number', true, 0, 0)],
		});
	});
	it('naming-case-value-uppercase', () => {
		expectCheck('X = 4', {
			errors: [namingCaseWarning('X', false, 0, 0)],
		});
	});
	it('naming-case-list-value-uppercase', () => {
		expectCheck('Values = [1 2]', {
			errors: [namingCaseWarning('Values', false, 0, 0)],
		});
	});
	// Eine Funktion, die sicher einen Typ liefert, ist ein höherer Typ.
	it('naming-case-higher-type-lowercase', () => {
		expectCheck('wrap = (T: Type) => List(T)', {
			errors: [namingCaseWarning('wrap', true, 0, 0)],
		});
	});
	it('naming-case-function-value-uppercase', () => {
		expectCheck('F = (x: Integer) => x', {
			errors: [namingCaseWarning('F', false, 0, 0)],
		});
	});
	it('naming-case-parameter-type-lowercase', () => {
		expectCheck('f = (t: Type) => []', {
			errors: [namingCaseWarning('t', true, 0, 5)],
		});
	});
	it('naming-case-parameter-value-uppercase', () => {
		expectCheck('f = (X: Integer) => []', {
			errors: [namingCaseWarning('X', false, 0, 5)],
		});
	});
	// And ist Teilmenge jedes Operanden, Integer genügt für die Einteilung.
	it('naming-case-parameter-intersection-uppercase', () => {
		expectCheck('f = (N: PositiveInteger) => []', {
			errors: [namingCaseWarning('N', false, 0, 5)],
		});
	});
	it('naming-case-rest-parameter-lowercase', () => {
		expectCheck('f = (...types: List(Type)) => []', {
			errors: [namingCaseWarning('types', true, 0, 8)],
		});
	});
	it('naming-case-destructuring', () => {
		expectCheck(`(t N) = [Integer 4]
[t N]`, {
			errors: [
				namingCaseWarning('t', true, 0, 1),
				namingCaseWarning('N', false, 0, 3),
			],
		});
	});
	// Der TypeGuard ist die erklärte Absicht: Any sagt nichts, also keine Meldung.
	it('naming-case-type-guard-wins', () => {
		expectCheck('x: Any = Integer');
	});
	// Ohne TypeGuard ist der Parameter Any, und die Rückgabe damit auch.
	it('naming-case-any-is-free', () => {
		expectCheck(`F = (x) => x
g = (X) => X`);
	});
	it('naming-case-mixed-tuple-is-free', () => {
		expectCheck(`Mixed = [Integer 4]
mixed = [Integer 4]`);
	});
	// T kann das Argument selbst sein oder für die Werte stehen, die es beschreibt.
	it('naming-case-generic-return-is-free', () => {
		expectCheck(`H = (T: Type) => T
h = (T: Type) => T
P = (T: Type v: T) => v
p = (T: Type v: T) => v`);
	});
	// Ein Prädikat liefert einen Boolean und wird deshalb klein geschrieben wie or und equal,
	// auch wenn der Checker es als Prädikat erkennt.
	it('naming-case-predicate-is-lowercase', () => {
		expectCheck(`IsInteger = (x: Any) :> Boolean =>
	?(x)
		[Integer] => true
		() => false`, {
			errors: [
				namingCaseWarning('IsInteger', false, 0, 0),
			],
		});
	});
	//#endregion Schreibweise
	// Ein generischer Parameter vom Typ Type muss als Typargument zulässig sein.
	it('type-parameter-as-type-argument', () => {
		expectCheck('F = (T: Type) => Stream(T)');
	});
	// Der functionType wird mit Platzhaltern erzeugt, an die Parameter-Symbole gehängt und
	// erst danach mutiert (ParamsType, ReturnType). Wer ihn zwischendurch auflöst - hier die
	// Selbstreferenz im body - darf kein Zwischenergebnis festhalten.
	it('recursive-function-return-type', () => {
		expectCheck(`f = (x: Integer) :> Integer =>
	?(x)
		[0] => 0
		() => f(x)
g: Integer = f(3)`);
	});
	// Fix im functionLiteral-Fall: bei Any als inferiertem Rückgabetyp (hier durch die
	// Selbstreferenz im body verursacht) wird auf den geprüften deklarierten Rückgabetyp
	// zurückgefallen statt Any durchzureichen. g: Text = f(3) meldet das jetzt korrekt.
	it('recursive-function-return-type-is-not-checked', () => {
		expectCheck(`f = (x: Integer) :> Integer =>
	?(x)
		[0] => 0
		() => f(x)
g: Text = f(3)`, {
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
		});
	});
	// Gegenprobe zu isCoreLibPath: in einer normalen Datei muss das Überschreiben
	// eines core-lib Namens weiterhin ein Fehler sein.
	it('redefinition-of-core-lib-name-still-errors', () => {
		expectCheck('add = 4', {
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
		});
	});
	// Fund in jul-examples/types.jul (addNums): der letzte Ausdruck im Funktionsrumpf war
	// ein mehrzeiliges branching. returnTypeMismatch markierte davor die GANZE Funktion
	// (Zeile 0 bis Ende des branchings) statt nur des branchings selbst, das den
	// tatsächlich zurückgegebenen Wert bildet.
	it('return-type-mismatch-marks-only-the-last-body-expression', () => {
		expectCheck(`f = (x: Integer) :> Integer =>
	?(x)
		[0] => true
		() => 1`, {
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
		});
	});
	// Fund in jul-examples/yugioh/game-logic.jul: fehlende Tupel-Elemente werden alle als
	// Empty behandelt (getTupleTypeError2, `argumentElementTypes[index] ?? { julType:
	// 'empty' }`) - bei mehreren fehlenden Elementen mit demselben Zieltyp entsteht so
	// dieselbe Meldung mehrfach hintereinander, ohne neue Information je Wiederholung.
	// Deduplikation nach demselben Muster wie beim 'and'-Fall in getTypeError
	// (`new Set(subErrors.map(typeErrorToString))`).
	it('duplicate-tuple-element-errors-are-deduplicated', () => {
		expectCheck('x: [Integer Integer Integer] = [1]', {
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
		});
	});
	// Nachbar-Fall zu 'duplicate-tuple-element-errors-are-deduplicated': Ziel List(X) mit
	// Tupel-Literal als Wert (case 'list' => case 'tuple' in getTypeError) hatte denselben
	// Dedup-Fehler, nur ohne den getTupleTypeError2-Fix von oben. Fund im selben
	// yugioh-Beispiel: eine List(GameBoard) mit mehreren strukturell identischen Boards
	// erzeugte denselben mehrzeiligen Fehler mehrfach hintereinander.
	// Seit constant folding für Nutzerfunktionen faltet f(...) zum präzisen Tupel-Typ
	// statt zu List(Text) - mit zwei unterschiedlichen
	// Argumenten dedupte die Meldung deshalb nicht mehr (zwei verschiedene Literale). Mit
	// demselben Argument zweimal bleiben beide Elemente dasselbe Literal und die Meldung
	// dedupt weiterhin - das ist der eigentliche Testzweck.
	it('duplicate-list-element-errors-are-deduplicated', () => {
		expectCheck('f = (a: Text b: Text) => [a b]\nx: List(Integer) = f(§a§ §a§)', {
			errors: [
				{
					code: ErrorCode.definitionTypeMismatch,
					message: 'Definition type mismatch.\nCan not assign §a§ to Integer.',
					startRowIndex: 1,
					startColumnIndex: 0,
					endRowIndex: 1,
					endColumnIndex: 29,
				},
			],
		});
	});
	// Kontravarianz bei Parametern: map erwartet (value: X, index: PositiveInteger) => Y.
	// Wer eine Funktion mit anderslautenden Parameternamen schreibt, bricht den Contract.
	// Die Fehlermeldung muss "Got 'i' but expected 'value'" sagen (an Position 1 wird
	// 'value' erwartet, wir geben aber 'i') - nicht umgekehrt.
	it('parameter-name-mismatch-reports-names-in-wrong-order', () => {
		expectCheck(`x = map([1 2] (i: Integer value: Integer) => i)`, {
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: "Argument type mismatch.\nInvalid value for parameter 'callback'\n  Parameter name mismatch. Got 'i' but expected 'value'",
					startRowIndex: 0,
					startColumnIndex: 14,
					endRowIndex: 0,
					endColumnIndex: 46,
				},
			],
		});
	});
	// Ein Spread einer Liste unbekannter Länge macht die Argumentliste selbst zu einem
	// Listentyp. Gegen einen Rest-Parameter ist das gültig, solange der Elementtyp passt:
	// List(Integer) erfüllt ...args: List(Rational).
	it('spread-list-into-rest-parameter', () => {
		expectCheck(`myFn = (a: List(Integer)) =>
	c = add(...a)`, {
			errors: [],
		});
	});
	// Ein Funktionsliteral ohne Ausdruck im Rumpf ist ungültig. Der Parser meldet expectedExpression,
	// liefert den Knoten aber mit leerem body. Früher warf der Checker daran:
	// "Cannot read properties of undefined (reading 'type')" in case 'functionLiteral',
	// weil last(expression.body) undefined ist und das ! darüber hinwegtäuscht.
	// Prinzip 8: halbfertiger Code ist der Normalfall, der Checker darf nicht werfen.
	// Beim Tippen entsteht der Zustand bei jedem Funktionsliteral, und im Sprachserver
	// fällt dann die Diagnostik für die ganze Datei aus. Vgl. jul-examples/ui/dialog/dialog.jul.
	// Eigener Test, weil expectCheck fehlerfreies Parsen voraussetzt.
	const expectEmptyBodyDoesNotThrow = reportAtCaller((code: string) => {
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors.map(error => error.code)).to.deep.equal([ErrorCode.expectedExpression]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
	});
	it('function-with-empty-body-does-not-throw: "f = () =>\\n\\t# TODO"', () => {
		expectEmptyBodyDoesNotThrow('f = () =>\n\t# TODO');
	});
	it('function-with-empty-body-does-not-throw: "f = () =>"', () => {
		expectEmptyBodyDoesNotThrow('f = () =>');
	});
	// Der Parser meldet Import-Fehler schon beim Auflösen der Abhängigkeiten. checked ist ein Klon
	// von unchecked und enthält sie also bereits - der Checker darf sie nicht ein zweites Mal
	// anhängen, sonst steht jede Meldung doppelt im Editor und in der CLI. fileNotFound meldet der
	// Loader, dafür siehe project-loader.test.ts.
	it('import-error-reported-once', () => {
		const parsed = parseCode('(a) = import(§./datei.txt§)\nb = a', 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors.map(error => error.code)).to.deep.equal([ErrorCode.invalidImportExtension]);
	});
	// Ein verschachtelter Import ist keine Abhängigkeit, getImportedPaths meldet ihn nicht - hier
	// bleibt die Meldung des Checkers die einzige.
	it('nested-import-error-reported-by-checker', () => {
		const parsed = parseCode('a = [import(§./datei.txt§)]', 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors.map(error => error.code)).to.include(ErrorCode.invalidImportExtension);
		expect(parsed.checked?.errors.filter(error => error.code === ErrorCode.invalidImportExtension)).to.have.lengthOf(1);
	});
	//#region Mehrzeiliger Funktionskopf
	// Eigene Tests, weil nur Code und Position der Meldungen geprüft werden, nicht ihr Wortlaut.
	const expectMultilineHead = reportAtCaller((
		code: string,
		errors: { code: ErrorCode; startRowIndex: number; startColumnIndex: number; }[],
	) => {
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors?.map(error => ({
			code: error.code,
			startRowIndex: error.startRowIndex,
			startColumnIndex: error.startColumnIndex,
		}))).to.deep.equal(errors);
	});
	it('C1 Rückgabetyp im Typblock wird gegen den Rumpf geprüft', () => {
		expectMultilineHead('f = (a: Integer)\n\t->\n\t\tText\n\t=> a', [{ code: ErrorCode.returnTypeMismatch, startRowIndex: 3, startColumnIndex: 4 }]);
	});
	it('C2 Parameter im Typblock auflösbar', () => {
		expectMultilineHead('f = (a: Integer)\n\t->\n\t\tTypeOf(a)\n\t=> a', []);
	});
	it('C3 Funktionstyp als Rückgabetyp', () => {
		expectMultilineHead('F = (a: Integer)\n\t:>\n\t\t(b: Integer) :> Integer\nf: F = (a: Integer) => (b: Integer) => b', []);
	});
	//#endregion Mehrzeiliger Funktionskopf
	// Passt der Elementtyp des gespreadeten Listentyps nicht zum Rest-Parameter, muss ein
	// echter Typfehler kommen - keine Platzhaltermeldung über eine nicht behandelte Form.
	// Eigener Test, weil nur die Meldung geprüft wird, nicht ihr genauer Wortlaut.
	it('spread-list-with-wrong-element-type-reports-real-error', () => {
		const code = `myFn = (a: List(Text)) =>
	c = add(...a)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		const errors = parsed.checked!.errors!;
		expect(errors, 'Typfehler erwartet').to.have.lengthOf(1);
		expect(errors[0]!.message).to.not.contain('not implemented');
	});
	// Ein Index kleiner 1 ist ungültig, nicht "daneben" - der Parser meldet das bereits
	// (parser.test.ts: index-zero). Der Checker darf nicht zusätzlich dereferenceFailed melden.
	// Eigener Test, weil expectCheck fehlerfrei parsenden Code voraussetzt.
	it('index-zero-reports-once', () => {
		const parsed = parseCode('a = [1 2]\na/0', 'dummy.jul');
		const parseErrors = parsed.unchecked.errors;
		expect(parseErrors, 'Parse-Fehler erwartet').to.have.lengthOf(1);
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	it('last-element-via-alias-keeps-empty-for-possibly-empty-input', () => {
		// Gegenprobe: kann die Eingabe empty sein, bleibt Empty im Ergebnis korrekt - sonst
		// hätte der Fix die Bedingung nur entfernt statt sie an TypeOf(values) zu knüpfen.
		const code = `le = lastElement
f = (values: Or([] List(Integer))) :> Or([] Integer) =>
	le(values)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// Die Fallunterscheidung steckt in And/Or: And(Integer And(A B)) ist genau dann nicht Never,
	// wenn beide Operanden Integer sind, And(Fraction Or(A B)) genau dann nicht Never, wenn
	// mindestens einer Fraction ist. Fraction minus Integer muss damit exakt Fraction ergeben.
	// Dreistellig geschrieben trifft der Checker das heute (Gegenprobe unten) - nur weil die
	// Normalisierung erst ab genau zwei Choices anläuft. Sobald dieselbe Bedingung paarweise
	// geschachtelt steht, kürzt der Teilmengen-Shortcut das noch unbestimmte And(A B) weg und
	// übrig bleibt Or(Integer Fraction).
	it('nested-condition-keeps-fraction-precise', () => {
		const code = `mySubtract = (a: Rational b: Rational) -> Or(And(Integer And(TypeOf(a) TypeOf(b))) And(Fraction Or(TypeOf(a) TypeOf(b)))) => subtract(a b)
f = (x: Fraction y: Integer) :> Fraction =>
	mySubtract(x y)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// Dieselbe Bedingung hinter einem Namen. Ohne tragende Abstraktion müsste die Formel an jeder
	// Signatur ausgeschrieben werden, die Fallunterscheidung wäre also nur theoretisch verfügbar.
	it('type-function-keeps-condition-until-arguments-are-known', () => {
		const code = `SumType = (A: Type B: Type) => Or(And(Integer And(A B)) And(Fraction Or(A B)))
mySubtract = (a: Rational b: Rational) -> SumType(TypeOf(a) TypeOf(b)) => subtract(a b)
f = (x: Fraction y: Integer) :> Fraction =>
	mySubtract(x y)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// Gegenprobe, heute grün: dieselbe Bedingung dreistellig statt geschachtelt. Sie hält die
	// beiden Tests darüber ehrlich - scheitert sie mit, liegt es nicht am Teilmengen-Shortcut,
	// sondern daran, dass die Formel selbst nicht ausdrückt, was sie ausdrücken soll.
	it('flat-condition-keeps-fraction-precise', () => {
		const code = `mySubtract = (a: Rational b: Rational) -> Or(And(Integer TypeOf(a) TypeOf(b)) And(Fraction Or(TypeOf(a) TypeOf(b)))) => subtract(a b)
f = (x: Fraction y: Integer) :> Fraction =>
	mySubtract(x y)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// Bug: kommt die List nicht als Parameter selbst, sondern über einen Feldzugriff
	// (history/gameStates), bricht die Identitätserkennung weg. getLengthFromType kennt
	// nur 'list', 'tuple', 'empty', 'or' und 'parameterReference' - ein Feldzugriff hat an
	// dieser Stelle den Typ 'nestedReference' und fällt auf den default-Zweig zurück, der ein
	// anonymes Integer statt eines an die Quelle gebundenen lengthOf liefert. Damit erkennt
	// dereferenceNestedKeyFromObject den Index nicht mehr als "Länge genau dieser Quelle" und
	// hängt fälschlich Empty an (siehe yugioh: game-logic.jul, getCurrentGameState).
	it('last-element-via-field-access-adds-no-empty-for-list', () => {
		const code = `f = (history: [gameStates: List(Integer)]) :> Integer =>
	lastElement(history/gameStates)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	it('element-at-plus-length-keeps-empty-for-different-source', () => {
		// Gegenprobe: die Länge einer ANDEREN Liste beweist nichts über die Position in dieser -
		// die Identitätserkennung darf nur bei derselben Quelle greifen.
		const code = `f = (values: List(Integer) other: List(Integer)) :> Or([] Integer) =>
	getElement(values length(other))`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// Bug (gefunden 2026-09-13): List(X) schliesst Empty als Typ aus (CLAUDE.md), ein Wert
	// dieses Typs hat also immer mindestens ein Element - Index 1 existiert beweisbar.
	// dereferenceIndexFromObject liefert für JEDEN Index auf 'list' pauschal Or(Empty X),
	// unabhängig vom Index. Für Index 1 ist das zu grob.
	it('index-one-on-list-adds-no-empty', () => {
		const code = `f = (l: List(Integer)) :> Integer =>
	x = l/1`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([
			{
				code: ErrorCode.argumentTypeMismatch,
				message: 'Argument type mismatch.\nInvalid value for parameter \'index\'\n  Can not assign 0 to Greater(0).',
				startRowIndex: 1,
				startColumnIndex: 19,
				endRowIndex: 1,
				endColumnIndex: 33,
			},
		]);
	});
	// Dieselbe Komposition, die lastElement in core-lib benutzt, in Nutzercode nachgebaut: der
	// Rückgabetyp wird in der eigenen Deklaration aus ElementAt und length zusammengesetzt. Weil
	// kein Namens-Sonderfall mehr existiert, muss die Deklaration allein tragen - auch durch einen
	// Alias hindurch, der jeden Namensbezug kappt.
	it('element-at-plus-length-composed-in-declaration-survives-alias', () => {
		const code = `myLast = (values: List(Any)) :> ElementAt(TypeOf(values) length(values)) =>
	getElement(values length(values))
alias = myLast
f = (values: List(Integer)) :> Integer =>
	alias(values)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// length deklariert seinen Rückgabetyp über LengthOf(TypeOf(values)) und hat keinen
	// Namens-Sonderfall im Checker. Nur deshalb entsteht der lengthOf-Knoten auch hinter einem
	// Alias, und nur mit ihm erkennt ElementAt, dass der Index genau die Länge dieser Quelle ist -
	// sonst bliebe fälschlich ein Empty im Ergebnis.
	it('length-via-alias-keeps-length-identity', () => {
		const code = `len = length
f = (values: List(Integer)) :> Integer =>
	getElement(values len(values))`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// Bug: setElement liefert innerhalb der eigenen Funktionsdefinition (also ohne konkreten
	// Aufrufkontext) ein ungefaltetes WithElementAt(...) - Source und Index sind ja gerade erst
	// die eigenen Parameter (siehe withElementAtFromTypes: Platzhalter bleibt stehen, bis
	// Source/Index feststehen). Solange dieser Wert die Funktion nur verlässt und direkt
	// zurückgegeben wird, fällt das nicht auf. Erst wenn er an einer WEITEREN Stelle erneut als
	// Argument geprüft wird (hier useRow, in yugioh: reduceLifePoints), schlägt getTypeError zu:
	// es behandelt ein unaufgelöstes WithElementAt als Argument nicht permissiv - nur als Zieltyp
	// (getTypeError, case 'withElementAt' im zweiten switch)
	// (siehe yugioh: game-logic.jul:1105, spellTraps = oldBoard2/spellTraps.setElement(...)).
	it('set-element-with-unresolved-index-assigns-via-nested-call', () => {
		const code = `useRow = (row: List(Integer)) :> List(Integer) =>
	row
f = (row: List(Integer) index: PositiveInteger value: Integer) :> List(Integer) =>
	newRow = row.setElement(index value)
	useRow(newRow)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// Bug: dasselbe Muster wie bei withElementAt, diesmal bei Concat. Innerhalb der eigenen
	// Funktionsdefinition ist chain noch der eigene, offene Parameter (parameterReference) -
	// [...chain value] bleibt deshalb als Concat(...) stehen (concatFromTypes:
	// isUnresolvedPlaceholderType-Guard). Solange dieser Wert die Funktion nur verlässt und
	// direkt zurückgegeben wird, fällt das nicht auf. Erst wenn er an einer WEITEREN Stelle
	// erneut als Argument geprüft wird (hier useChain, in yugioh: getController), schlägt
	// getTypeError zu: es behandelt ein unaufgelöstes Concat als Argument nicht permissiv - nur
	// als Zieltyp (siehe yugioh: game-logic.jul, addChainLink: chain = [...oldChain chainLink],
	// zugewiesen an chain: Or([] List(ChainLink)), Fehler beim nachfolgenden
	// getController(newGameState5 ...)).
	it('concat-with-unresolved-source-assigns-via-nested-call', () => {
		const code = `useChain = (chain: List(Integer)) :> List(Integer) =>
	chain
f = (chain: Or([] List(Integer)) value: Integer) :> List(Integer) =>
	newChain = [
		...chain
		value
	]
	useChain(newChain)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// Dasselbe Muster wie bei Concat, diesmal bei TupleOf. map liefert
	// TupleOf(LengthOf(cards) Integer); solange cards der eigene, offene Parameter ist, bleibt
	// der Knoten stehen (tupleOfFromTypes: isUnresolvedPlaceholderType-Guard). getTypeError
	// muss tupleOf deshalb auch auf der Argumentseite permissiv behandeln (nicht nur als Zieltyp) -
	// ein Tuple beliebiger Länge aus Integern ist an List(Integer) aber sehr wohl zuweisbar.
	it('tuple-of-with-unresolved-count-assigns-to-list', () => {
		const code = `g = (b: Or([] List(Integer))) => b
f = (cards: List(Integer)) =>
	g(cards.map((value: Integer index: Integer) => value))`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// Bug: withElementAtFromTypes ignoriert bei Source Empty den tatsächlichen Index und liefert
	// immer ein 1-elementiges Tuple [valueType] (siehe checker.ts, case 'empty' in
	// withElementAtFromTypes) - der Wert landet damit an Position 1 statt an der wirklichen
	// Position (hier 2). Zur Laufzeit legt setElement auf einem leeren Array ein Array der Länge
	// index an (core-lib.jul: copy[Number(index) - 1] = value) - bei index 2 also mit einer Lücke
	// an Position 1 und dem Wert an Position 2. Der Zieltyp [[] Integer] bildet genau das ab (nur
	// eine Position gesetzt), ist also selbst korrekt/sound - der Fehler zeigt trotzdem, dass die
	// Positionen vertauscht sind: "Can not assign 5 to Empty" (Wert an Position 1 statt Position 2)
	// und "Can not assign Empty to Integer" (Position 2 fehlt)
	// (siehe yugioh: game-logic.jul:1332, newBoards = [].setElement(defender ...).setElement(attacker ...)).
	it('set-element-on-empty-at-literal-index-two-keeps-value-at-correct-position', () => {
		const code = `x: [[] Integer] = [].setElement(2 5)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// Bug: withElementAtFromTypes' case 'empty'/'tuple' setzt bei literalem Index über das
	// bisherige Ende hinaus nur elementTypes[position - 1] = valueType - dabei bleibt ein rohes
	// JS-Array-Loch (kein {julType: 'empty'}-Objekt) an den übersprungenen Positionen. Beim
	// nächsten verketteten setElement wird dieses Tuple erneut per Spread kopiert
	// ([...existingElementTypes]); Spread "verdichtet" Löcher zu echten undefined-Werten, die
	// keine CompileTimeType-Objekte sind. Erzwingt man hier einen Typfehler (Zuweisung an
	// Integer), baut getTypeError die Fehlermeldung über typeToString, das jedes Element per
	// .map() direkt anfasst - für ein derartiges undefined-Element crasht das mit
	// "Cannot read properties of undefined (reading 'julType')" statt eine Fehlermeldung zu
	// bilden. Trat live als Absturz beim Hovern über eine solche Stelle auf.
	it('set-element-chained-on-empty-with-union-index-does-not-crash', () => {
		const code = `f = (x: Or(1 2)) :> Integer =>
	[].setElement(x true).setElement(x false)`;
		const parsed = parseCode(code, 'dummy.jul');
		expect(() => checkTypes(parsed, {}, { cloneUnchecked: false })).not.to.throw();
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);

		const definition = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const functionType = definition.value?.typeInfo?.type;
		const returnType = functionType?.julType === 'function' ? functionType.ReturnType : undefined;
		expect(returnType?.julType).to.equal('integer',
			'Deklarierter Rückgabetyp Integer sollte gelten, tatsächlich: ' + returnType?.julType);
	});
	// Ein Spread innerhalb eines List-Literals muss den tatsächlichen Elementtyp der gespreadeten
	// Quelle übernehmen (nicht zu Any verbreitern) - sonst ein falscher returnTypeMismatch wie in
	// yugioh/game-logic.jul (updatePendingTriggers, activatableGameCardIds).
	it('list-literal-spread-collapses-to-list', () => {
		// List-Spreads sollten sich zu einer List zusammensetzen (unbekannte Länge bleibt unbekannt)
		const code = `f = (values: List(Integer)) =>
	[
		...values
		§"hello"§
	]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);

		const definition = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const functionType = definition.value?.typeInfo?.type;
		const rawReturnType = functionType && functionType.julType === 'function' ? functionType.ReturnType : undefined;
		// Ohne Annotation bleibt der Rückgabetyp ein aufschiebbarer Concat-Knoten (für die
		// präzise Auflösung am Aufrufort) - resolvePlaceholders liefert die deklarationsseitige,
		// verbreiterte Anzeige, wie beim Hover über die Funktion selbst.
		const returnType = rawReturnType && resolvePlaceholders(rawReturnType);

		// Erwartet: List(Union(Integer, Text))
		expect(returnType?.julType).to.equal('list',
			'List-Spread sollte zu einer List werden, tatsächlich: ' + returnType?.julType);
		if (returnType && returnType.julType === 'list') {
			expect(returnType.ElementType.julType).to.equal('or',
				'ElementType sollte Union sein (Integer | Text), tatsächlich: ' + returnType.ElementType.julType);
		}
	});

	// Fund in yugioh (game-logic.jul, allGameCardIds): Or([] List(X)) ist das Idiom für eine
	// möglicherweise leere Liste (CLAUDE.md) - ihr julType ist 'or', nicht 'list'. Umgesetzt in
	// getSpreadElementTypes (checker.ts): schaut durch die Or-Choices hindurch und erkennt an
	// unterschiedlichen Choice-Längen, dass die Gesamtlänge unbestimmt ist.
	it('possibly-empty-list-spread-collapses-to-list', () => {
		const code = `f = (hand: Or([] List(Integer)) spellTraps: [Integer Integer] field: Integer) =>
	[
		...hand
		...spellTraps
		field
	]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
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

	// a.filterMap(...) und [...a].filterMap(...) müssen denselben Elementtyp liefern - a wird nur
	// zwischenzeitlich in ein neues List-Literal gespreadet, nicht verändert. Der Spread-Zweig
	// (checker.ts, case 'list') bestimmt den ElementType für das neue Literal über a's Typ, und a
	// ist als Parameter der noch nicht aufgerufenen Funktion ein unaufgelöster Platzhalter - der
	// darf dabei nicht auf Any verbreitert werden.
	it('spread-of-generic-list-parameter-keeps-element-type', () => {
		const code = `myFn = (a: List(Or([] Integer))) =>
	c = a.filterMap((value) => value)
	b = [...a].filterMap((value) => value)
	[b c]
`;
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);

		const fnDef = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const fnLiteral = fnDef.value as ParseFunctionLiteral;
		const cDef = fnLiteral.body[0] as ParseSingleDefinition;
		const bDef = fnLiteral.body[1] as ParseSingleDefinition;

		const cType = cDef.value?.typeInfo?.type;
		const bType = bDef.value?.typeInfo?.type;

		expect(cType && typeToString(resolvePlaceholders(cType), 0, 5)).to.equal(
			'Or(Empty List(Integer))');
		expect(bType && typeToString(resolvePlaceholders(bType), 0, 5)).to.equal(
			'Or(Empty List(Integer))');
	});

	// Der Parser kürzt Bruchliterale nicht (TODO in parser.ts), deshalb bekommen zwei
	// Schreibweisen derselben Zahl verschiedene Typen. Das verletzt 'gleiche Werte, gleiche
	// Typen' schon ohne constant folding und würde mit der Faltung in den Checker
	// durchschlagen. Erwartet wird der gekürzte Bruch, bei Nenner 1 ein Integer-Literal.
	it('fraction-literals-are-reduced', () => {
		const code = `a = 0.5
b = 0.50
c = 1.0`;
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		const typeOf = (index: number) => {
			const def = parsed.checked?.expressions?.[index] as ParseSingleDefinition;
			const type = def.value?.typeInfo?.type;
			return type && typeToString(resolvePlaceholders(type), 0, 5);
		};
		expect(typeOf(0)).to.equal(typeOf(1));
		expect(typeOf(2)).to.equal('1');
	});

	// Grosser Zieltyp (Dictionary mit vielen Feldern) in der Fehlermeldung wird gekürzt
	// (checker.ts maxFieldsInTypeDump) statt alle Felder aufzulisten. Wert ist ein Integer
	// statt eines dictionaryLiteral, damit keine Feld-Elaboration greift und der Zieltyp
	// direkt (ungekürzt wäre er 20 Zeilen lang) in den Header gerendert wird.
	it('large-dictionary-type-in-error-message-is-truncated', () => {
		const fieldNames = Array(20).fill(null).map((_, i) => `field${i}`);
		const fieldDeclarations = fieldNames.map(name => `${name}: Integer`).join(' ');
		const code = `x: [${fieldDeclarations}] = 5`;

		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		const error = parsed.checked?.errors?.[0];

		expect(error?.message).to.include('(and 15 more fields)',
			`Zieltyp sollte nach maxFieldsInTypeDump gekuerzt sein:\n${error?.message}`);
	});

	// Fund in yugioh (draw() liefert GameState statt des deklarierten GameBoard): fehlt einem
	// Dictionary-Ziel ein Feld komplett, gibt es keinen Wert zum Vergleichen - der erwartete Typ
	// steht bereits an der Zieltyp-Deklaration selbst. TypeScript/Rust/Elm/GHC schreiben ihn dort
	// deshalb nicht noch einmal aus, TypeScript sammelt mehrere fehlende Felder zusätzlich in
	// einer Zeile. Siehe docs/missing-field-message-format.md. Keine separate Elaboration-Zeile
	// je fehlendem Feld (Fund Session 2026-09-10): ohne Feld-Ausdruck gibt es keine präzisere
	// Position als die Hauptmeldung schon zeigt - eine zweite CompilerError wäre nur Verdopplung.
	it('missing-fields-are-collected-in-one-line', () => {
		const code = `T = [a: Integer b: Text c: Boolean]
x: T = [a = 1]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		const messages = parsed.checked?.errors.map(error => error.message);
		expect(messages).to.deep.equal([
			'Definition type mismatch.\nCan not assign [a: 1] to T.\n  Missing fields: \'b\', \'c\'.',
		]);
	});
	// Fund in jul-examples/yugioh/game-logic.jul (Session 2026-09-10): bei verschachtelten
	// Dictionary-Literalen erzeugte das frühere Zwei-Diagnosen-Modell (volle Kette an der
	// AEUSSEREN Position + Elaboration mit dem inneren Teil der Kette an der PRÄZISEN Position)
	// denselben Text zweimal - bei mehreren Verschachtelungsebenen mit dem Rust-Code-Frame (C2)
	// zwei fast komplette, sich überlappende Frames. TypeScript/Rust/Elm lösen das strukturell
	// anders (siehe docs/error-message-elaboration.md): EINE Diagnose, deren Position beim
	// rekursiven Abstieg durch die Literale auf die innerste noch vorhandene, tatsächlich
	// falsche Stelle wandert (hier: der Wert §wrong§ im inneren Literal) - die Kette bleibt
	// vollständig, aber nur einmal (findInnermostErrorPosition in checker.ts).
	//
	// Außerdem (echtes yugioh-Fehlerbild): die Typ-Kette liest sich aussen nach innen ("Can not
	// assign X to Outer." vor "... to Inner." vor "... to Integer."), aber die "Invalid value for
	// field"-Zeilen hängen alle ans Ende, in umgekehrter Verschachtelungs-Reihenfolge (innerstes
	// Feld zuerst) - man muss sie im Kopf wieder der richtigen Ebene der Typ-Kette zuordnen statt
	// sie direkt an der Stelle zu lesen, wo sie hingehören. TypeScript interleaved das (Feldname
	// direkt vor dem Fehler, den er erklärt) UND rückt jede Zeile eine Ebene tiefer ein, je
	// weiter man in die Verschachtelung absteigt - ohne Einrückung bleibt bei 3+ Ebenen (wie im
	// echten Fund: GameState -> boards -> GameBoard -> activatableGameCardIds) unklar, welche
	// Zeile zu welcher Tiefe gehört. Umgesetzt in getDictionaryFieldError/indentLines.
	it('field-name-precedes-the-type-mismatch-it-explains', () => {
		const code = `Inner = [a: Integer]
Outer = [inner: Inner]
x: Outer = [inner = [a = §wrong§]]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
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

	// Fund im echten yugioh-Fehlerbild (Session 2026-09-10): typeToString hat für mehrzeilige
	// Typen (Tupel/Dictionary) eine EIGENE Einrückung (`bracketedExpressionToString`, Tabs, own
	// depth-Zähler ab 0), die nichts von der Kettentiefe weiss, in die sie via indentLines
	// eingebettet wird - Tabs und Leerzeichen mischen sich, die Verschachtelung sieht zufällig
	// aus statt konsistent. Ziel: typeToString nutzt dieselbe Leerzeichen-Einheit wie indentLines
	// (2 Leerzeichen), dann fügt sich die eigene Einrückung sauber in jede Einbettungstiefe.
	// Umgesetzt in bracketedExpressionToString (indentUnit).
	it('multiline-type-dump-uses-the-same-indent-unit-as-the-surrounding-chain', () => {
		const code = `Inner = [a: [Integer Integer Integer Integer Integer Integer]]
x: Inner = [a = []]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
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

	// Dieselbe Elaboration am Aufruf: ein falsches Argument markiert nur dieses Argument,
	// nicht den ganzen Aufruf samt Argumentliste.
	it('argument-error-points-at-the-argument-not-the-whole-call', () => {
		const code = `f = (a: Integer b: Greater(0)) => a
f(1 0)`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([
			{
				code: ErrorCode.argumentTypeMismatch,
				message: 'Argument type mismatch.\nInvalid value for parameter \'b\'\n  Can not assign 0 to Greater(0).',
				startRowIndex: 1,
				startColumnIndex: 4,
				endRowIndex: 1,
				endColumnIndex: 5,
			},
		]);
	});

	// Die Fehlerposition folgt dem Typ, den die Stelle verlangt: auch hinter einem Spread, solange
	// jede Position dasselbe verlangt, und in einer Union, wenn nur ein Zweig passen kann.
	// marked ist der Text, den die einzige Meldung markieren soll.
	const expectErrorMarks = reportAtCaller((code: string, marked: string) => {
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		const errors = parsed.checked?.errors ?? [];
		expect(errors).to.have.length(1);
		const error = errors[0]!;
		const rows = code.split('\n');
		const markedText = error.startRowIndex === error.endRowIndex
			? rows[error.startRowIndex]!.slice(error.startColumnIndex, error.endColumnIndex)
			: '(mehrzeilig)';
		expect(markedText).to.equal(marked);
	});
	it('error-position-list-element-after-spread', () => {
		expectErrorMarks('xs: List(Integer) = [1]\nl: List(Integer) = [...xs §x§]', '§x§');
	});
	it('error-position-rest-argument-after-spread', () => {
		expectErrorMarks('g = (...ns: List(Integer)) => ns\nxs: List(Integer) = [1]\ng(...xs §x§)', '§x§');
	});
	it('error-position-dictionary-field-in-union', () => {
		expectErrorMarks('h: Or([] [a: Integer]) = [a = §x§]', '§x§');
	});
	it('error-position-list-element-in-union', () => {
		expectErrorMarks('l: Or([] List(Integer)) = [1 §x§]', '§x§');
	});
	it('error-position-argument-field-in-union', () => {
		expectErrorMarks('g = (o: Or([] [a: Integer])) => o\ng([a = §x§])', '§x§');
	});
	it('error-position-prefix-argument-field', () => {
		expectErrorMarks('g = (o: [a: Integer]) => o\nx = [a = §x§].g()', '§x§');
	});

	// Der Aufruf wird gegen den ungelösten Argumenttyp geprüft (areArgsAssignableTo bekommt
	// argsType bewusst ungelöst). Suchte die Positionssuche nur auf dem gelösten Typ, fände sie
	// den gemeldeten Fehler nicht wieder und fiele auf den ganzen Aufruf zurück.
	it('argument-error-points-at-the-argument-for-unresolved-argument-types', () => {
		const code = `g = (b: Or([] List(Text))) => b
f = (cards: List(Integer)) =>
	g(cards.map((value: Integer index: Integer) => value))`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		const error = parsed.checked?.errors[0];
		expect(error?.code).to.equal(ErrorCode.argumentTypeMismatch);
		expect([error?.startColumnIndex, error?.endColumnIndex]).to.deep.equal([3, 54]);
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		// ist der Name der Definition, die den Wert hält, kein Typname. aliasName wird für
		// jede Dictionary-Definition gesetzt (auch für normale Werte), aber beim Ausdrucken
		// der argumentsType-Seite (der tatsächliche Wert) darf er nicht verwendet werden -
		// nur die targetType-Seite (der erwartete Typ) darf ihren Alias zeigen.
		const code = `GameState = [board: Integer]
newGameState: GameState = [
	board = []
]`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		const error = parsed.checked?.errors?.[0];

		expect(error?.message).not.to.include('newGameState to GameState',
			`Definitionsname darf nicht als Typ auf der linken Seite erscheinen: ${error?.message}`);
	});

	// Fund im echten yugioh-Fehlerbild (Session 2026-09-10): Ziel Or(Empty List(Integer)),
	// Wert List(Text) - der List-gegen-List-Zweig in getTypeError gibt den Element-Fehler
	// unverändert durch, ohne ihn als "Can not assign List(X) to List(Y)." zu umhüllen (anders
	// als der dictionaryLiteral-Fall). Im Or-Ziel stehen dadurch zwei Fehler ohne erkennbaren
	// Zusammenhang nebeneinander: "Can not assign List(Text) to Empty." (Choice Empty) und roh
	// "Can not assign Text to Integer." (Choice List(Integer), ohne "das war in einer Liste").
	it('list-element-error-is-wrapped-with-the-enclosing-list-types', () => {
		const code = `f = (y: List(Text)) =>
	x: List(Integer) = y
	x`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		const error = parsed.checked?.errors?.[0];
		expect(error?.message).to.include('Can not assign List(Text) to List(Integer).',
			`Element-Fehler sollte mit dem umschliessenden List-Typ-Paar eingeleitet werden: ${error?.message}`);
	});

	// Fund im echten yugioh-Fehlerbild (Session 2026-09-10): Ziel Or(Empty List(Integer))
	// (Idiom "möglicherweise leere Liste"), Wert List(Or(Integer Empty)) (Idiom "Liste mit
	// möglicherweise fehlenden Einträgen") - strukturell verschieden, aber leicht zu verwechseln.
	// Bisher wurden ALLE Or-Choices einzeln gegen den Wert geprüft und ALLE Fehler gezeigt,
	// auch der triviale/uninteressante ("List ist kein Empty") - der eigentlich relevante Choice
	// (List(Integer)) ging darin unter, und der volle Or-Zieltyp war nirgends sichtbar (TS/Flow-
	// Vorbild: Ziel-Union vollständig im Kopf zeigen, dann nur den strukturell nächsten Choice
	// vertiefen statt alle Choices einzeln durchzukauen).
	it('or-target-shows-full-union-and-elaborates-only-the-closest-choice', () => {
		const code = `f = (y: List(Or(Integer Empty))) =>
	x: Or(Empty List(Integer)) = y
	x`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
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
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);

		const targetDef = parsed.checked?.expressions?.[1] as ParseSingleDefinition;
		const targetType = targetDef.value?.typeInfo?.type;
		expect(targetType && typeToString(resolvePlaceholders(targetType), 0, 0)).to.equal(
			'TypeOf([\n  x: Integer\n  y: Text\n  z: Boolean\n])');
	});
	// Die Tiefenregel in typeToString (nur die äußerste Ebene ausschreiben, darunter den Namen
	// zeigen) greift nur, wenn der Typ einen aliasName trägt. Gesetzt wird der bisher allein für
	// Dictionary- und Funktionstypen - ein per Or/And definierter Typ verliert seinen Namen und
	// wird in jeder Position voll ausgepackt, obwohl er genauso benannt geschrieben wurde.
	it('type-alias-name-survives-for-union-definitions', () => {
		const code = `ZoneIndex = Or(1 2 3)
Target = [
	zone: ZoneIndex
	zones: List(ZoneIndex)
]`;
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);

		const targetDef = parsed.checked?.expressions?.[1] as ParseSingleDefinition;
		const targetType = targetDef.value?.typeInfo?.type;
		expect(targetType && typeToString(resolvePlaceholders(targetType), 0, 0)).to.equal(
			'TypeOf([\n  zone: ZoneIndex\n  zones: List(ZoneIndex)\n])');
	});
	// Ein benannter Union-Typ als Choice einer weiteren Union verliert seinen Namen trotzdem:
	// createNormalizedUnionType zieht die inneren Choices in die äußere Union hinein, danach gibt
	// es keinen Typ mehr, an dem der Name hängen könnte. Or([] X) ist die Standardschreibweise
	// für "optional", der Fall trifft also fast jedes optionale Feld.
	it('type-alias-name-survives-flattening-into-an-outer-union', () => {
		const code = `ZoneIndex = Or(1 2 3)
Target = [
	zone: Or([] ZoneIndex)
	other: Integer
]`;
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);

		const targetDef = parsed.checked?.expressions?.[1] as ParseSingleDefinition;
		const targetType = targetDef.value?.typeInfo?.type;
		expect(targetType && typeToString(resolvePlaceholders(targetType), 0, 0)).to.equal(
			'TypeOf([\n  zone: Or(Empty ZoneIndex)\n  other: Integer\n])');
	});
	// Ein Typalias, der sich selbst nennt, fällt lautlos auf Any zurück: beim Konstruieren seines
	// Werts ist die Definition noch nicht fertig, es gibt nichts einzusetzen. Kein Fehler, kein
	// sichtbarer Unterschied - die Rekursion verschwindet einfach aus dem Typ, und jeder Zugriff
	// über children liefert danach Any statt eines Baumknotens.
	it('recursive-type-alias-keeps-the-self-reference', () => {
		const code = `Tree = [
	value: Integer
	children: Or([] List(Tree))
]`;
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);

		const treeDef = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const treeType = treeDef.value?.typeInfo?.type;
		expect(treeType && typeToString(resolvePlaceholders(treeType), 0, 0)).to.equal(
			'TypeOf([\n  value: Integer\n  children: Or(Empty List(Tree))\n])');
	});
	// Gegenstück zum Tree-Test: eine Selbstreferenz, die durch keinen datentragenden Konstruktor
	// läuft, beschreibt keinen Typ. Die Gleichung Bad = Or(Integer Bad) wird von jeder Obermenge
	// von Integer erfüllt, hat also keine eindeutige Lösung. Nichts wird beim Prüfen kleiner,
	// weshalb derselbe Fall auch die Endlosrekursion wäre. Heute bleibt er stumm und liefert Any.
	it('unproductive-type-cycle-is-reported', () => {
		const code = 'Bad = Or(Integer Bad)';
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.have.lengthOf(1);
		expect(parsed.checked?.errors[0]?.message).to.equal(
			'Circular type definition \'Bad\'. A type can only refer to itself through a field, list, tuple, stream or function.');
	});
	// Ein rekursiver Typ macht den Typ zum Graph mit Zyklus. Werden zwei davon verglichen, landet
	// jeder Schritt über die Alias-Knoten wieder beim selben Paar - ohne Besuchsmenge endet das im
	// Stack Overflow, im Language Server also als Absturz beim Tippen. Die einzige Annahme, unter
	// der der Vergleich terminiert: ein Paar, das bereits geprüft wird, gilt als zuweisbar.
	it('comparing-two-recursive-types-terminates', () => {
		const code = `Tree = [
	value: Integer
	children: Or([] List(Tree))
]
Tree2 = [
	value: Integer
	children: Or([] List(Tree2))
]
f = (t: Tree) => t
g = (t: Tree2) => f(t)`;
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// Dieselbe Zyklusfalle auf dem zweiten Vergleichspfad: createNormalizedUnionType dedupliziert
	// über typeEquals, und das steigt bei zwei rekursiven Choices genauso im Kreis ab. Eigener
	// Test, weil getTypeError und typeEquals getrennte Rekursionen sind - ein Schutz im einen
	// deckt den anderen nicht ab.
	it('deduplicating-recursive-types-in-a-union-terminates', () => {
		const code = `Tree = [
	value: Integer
	children: Or([] List(Tree))
]
Tree2 = [
	value: Integer
	children: Or([] List(Tree2))
]
Both = Or(Tree Tree2)`;
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	// Die Besuchsmenge deckt nur Zyklen ab; eine sehr tiefe, nicht zyklische Verschachtelung läuft
	// an ihr vorbei und kippt irgendwann in den Stack Overflow (gemessen: ab rund 4000 Ebenen,
	// plattformabhängig). Die Notbremse muss vorher greifen und eine Diagnose liefern, statt den
	// Language Server zu killen. 150 Ebenen liegen weit jenseits jeder realen Verschachtelung.
	it('excessively-deep-type-comparison-is-reported', () => {
		const depth = 150;
		let code = 'T0 = [a: Integer]\n';
		for (let index = 1; index <= depth; index++) {
			code += `T${index} = [a: T${index - 1}]\n`;
		}
		code += 'U0 = [a: Integer]\n';
		for (let index = 1; index <= depth; index++) {
			code += `U${index} = [a: U${index - 1}]\n`;
		}
		code += `f = (t: T${depth}) => t\n`;
		code += `g = (u: U${depth}) => f(u)`;
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		const messages = parsed.checked?.errors.map(error => error.message) ?? [];
		expect(messages.some(message => message.includes('excessively deep'))).to.equal(
			true,
			`Erwartete Tiefen-Diagnose, bekam: ${JSON.stringify(messages)}`);
	});
	// Präfix-Argument eines Methodenaufrufs im Funktionsrumpf: `values` ist dort ein
	// parameterReference, wird aber eager über resolvePlaceholders auf den deklarierten Typ
	// List(Any) zurückgefaltet. Damit steht der Rückgabetyp von `second` schon bei der
	// Deklaration als Any fest, und der Aufruf mit einem konkreten Tuple kann die Präzision
	// nicht mehr zurückholen - obwohl getElement sie über ElementAt(TypeOf(values) index)
	// exakt berechnen könnte. Geprüft wird der Typ, nicht die Fehlerliste: über Fehler ist
	// die Lücke unsichtbar.
	it('prefix-argument-keeps-precision-until-call', () => {
		const code = `second = (values: List(Any)) =>
	values.getElement(2)
result = [1 §a§].second()`;
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });

		const resultDef = parsed.checked?.expressions?.[1] as ParseSingleDefinition;
		const resultType = resultDef.value?.typeInfo?.type;
		expect(resultType && typeToString(resolvePlaceholders(resultType), 0, 0)).to.equal('§a§');
	});
	// Gegenstück: der Index-/Namenszugriff hält den Platzhalter bereits, weil
	// dereferenceIndexFromObject/dereferenceNameFromObject den rohen Typ zuerst probieren.
	// Beide Zugriffsarten müssen dieselbe Präzision liefern - sonst stünde die willkürliche
	// Grenze "Methodenaufruf ist schlau, Feldzugriff nicht".
	it('index-access-keeps-precision-until-call', () => {
		const code = `second = (values: List(Any)) =>
	values/2
result = [1 §a§].second()`;
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });

		const resultDef = parsed.checked?.expressions?.[1] as ParseSingleDefinition;
		const resultType = resultDef.value?.typeInfo?.type;
		expect(resultType && typeToString(resolvePlaceholders(resultType), 0, 0)).to.equal('§a§');
	});
	it('field-access-keeps-precision-until-call', () => {
		const code = `getX = (o: [x: Any]) =>
	o/x
result = [x = §a§].getX()`;
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });

		const resultDef = parsed.checked?.expressions?.[1] as ParseSingleDefinition;
		const resultType = resultDef.value?.typeInfo?.type;
		expect(resultType && typeToString(resolvePlaceholders(resultType), 0, 0)).to.equal('§a§');
	});
	// Fund aus yugioh/game-logic.jul:136 (10.09.2026): cardEffect/mandatoryTriggers.getElement(
	// effectIndex), effectIndex kommt aus einem Feld, das als Integer deklariert ist, nicht als
	// PositiveInteger. Vorher lautlos verschluckt: der Feldzugriff auf einen Parameter bleibt
	// bis zur Auflösung ein nestedReference, und getTypeError war dafür permissiv (kein Fehler
	// bedeutete dort nicht "zuweisbar"). Jetzt wird vor der Prüfung aufgelöst (wie bei concat/
	// withElementAt), der Fehler wird sichtbar.
	it('field-access-on-parameter-reports-mismatch-after-resolving', () => {
		const code = `PendingTrigger = [effectIndex: Integer]
getEffect = (values: List(Any) trigger: PendingTrigger) =>
	values.getElement(trigger/effectIndex)`;
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.have.lengthOf(1);
		expect(parsed.checked?.errors[0]?.message).to.equal(
			'Argument type mismatch.\nInvalid value for parameter \'index\'\n  Can not assign Integer to Greater(0).');
	});
	// Gegenstück zu 'core-lib parses without errors' für die Checker Stufe.
	// Regression: Die core-lib definiert die builtInSymbols selbst und muss daher ohne oberen
	// Scope gecheckt werden. Sonst stand ihre Symboltabelle doppelt im Scope Stack und jede
	// Definition wurde als alreadyDefinedInUpperScope gemeldet (94 Scheinfehler im Editor).
	it('core-lib checks without errors', () => {
		const parsed = parseFile(coreLibPath);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked!.errors).to.deep.equal([]);
	});
	// Hält den Befund fest, der zu den Purity-Pfeilen geführt hat (docs/pure-functions.md,
	// "Stand"): früher trug jede core-lib-Funktion pure: true, weil functionTypeLiteral das
	// hart setzte - auch log und currentDate, die offensichtlich nicht pure sind. Seit der
	// Migration kommt die Purity aus dem geschriebenen Pfeil.
	function purityOf(name: string): TypePurity | undefined {
		const type = builtInSymbols[name]?.typeInfo?.type;
		return type && isFunctionType(type) ? type.purity : undefined;
	}

	it('core-lib: log und currentDate sind nicht pure', () => {
		expect(purityOf('log')).to.equal('impure');
		expect(purityOf('currentDate')).to.equal('impure');
		expect(purityOf('add')).to.equal('pure');
	});
	// Seit Schritt 3 (docs/pure-inference-umsetzung.md) wird der Rumpf inferiert und der
	// geschriebene Pfeil nach der E3-Tabelle damit abgeglichen - kein reines Durchreichen mehr.
	function purityOfDefinition(code: string, name: string): TypePurity | undefined {
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		const type = parsed.checked?.expressions
			?.find((expression): expression is ParseSingleDefinition =>
				expression.type === 'definition' && expression.name.name === name)
			?.value?.typeInfo?.type;
		return type && isFunctionType(type) ? type.purity : undefined;
	}
	// Für die beiden "Rumpf unbekannt"-Fälle der Tabelle: nur über eine Closure erreichbar
	// (E2, "outer"s Parameter ist für die zurückgegebene innere Funktion fremd), da eine
	// Top-Level-Funktion den eigenen Parameter immer als rein zählen darf (E1).
	function innerPurityOf(code: string): TypePurity | undefined {
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		const outer = parsed.checked?.expressions
			?.find((expression): expression is ParseSingleDefinition =>
				expression.type === 'definition' && expression.name.name === 'outer')
			?.value;
		const inner = outer?.type === 'functionLiteral' ? outer.body[outer.body.length - 1] : undefined;
		const type = inner?.typeInfo?.type;
		return type && isFunctionType(type) ? type.purity : undefined;
	}

	// E3-Tabelle, Zeile "-> ": beweisbar rein bleibt stumm pure, beweisbar unrein wird zu impure
	// und meldet JUL5101 (Schritt 4, eigene Tests weiter unten), unbekannt bleibt stumm pure
	// (ungeprüfte Zusicherung).
	it('-> mit beweisbar reinem Rumpf bleibt pure', () => {
		expect(purityOfDefinition('f = (a: Integer) -> Integer => a', 'f')).to.equal('pure');
	});
	it('-> mit beweisbar unreinem Rumpf wird zu impure', () => {
		expect(purityOfDefinition('f = () -> Any => log()', 'f')).to.equal('impure');
	});
	it('-> mit unentscheidbarem Rumpf bleibt pure (ungeprüfte Zusicherung)', () => {
		expect(innerPurityOf('outer = (cb: () :> Any) => () -> Any => cb()')).to.equal('pure');
	});
	// E3-Tabelle, Zeile "~>": bleibt immer impure, unabhängig vom Rumpf.
	it('~> bleibt impure, auch bei beweisbar reinem Rumpf', () => {
		expect(purityOfDefinition('f = () ~> Integer => 1', 'f')).to.equal('impure');
	});
	// E3-Tabelle, Zeile ":> oder kein Pfeil": das Inferenzergebnis ersetzt die Zusicherung.
	it(':> mit beweisbar reinem Rumpf wird zu pure', () => {
		expect(purityOfDefinition('f = (a: Integer) :> Integer => a', 'f')).to.equal('pure');
	});
	it('Funktion ohne Pfeil mit beweisbar reinem Rumpf wird zu pure', () => {
		expect(purityOfDefinition('f = (a) => a', 'f')).to.equal('pure');
	});
	it('Funktion ohne Pfeil mit beweisbar unreinem Rumpf wird zu impure', () => {
		expect(purityOfDefinition('f = () => log()', 'f')).to.equal('impure');
	});
	it('Funktion ohne Pfeil mit unentscheidbarem Rumpf bleibt unknown', () => {
		expect(innerPurityOf('outer = (cb: () :> Any) => () => cb()')).to.equal('unknown');
	});
	// Ein fremder (aus einer äußeren Funktion geschlossener) Parameter macht die Weitergabe nicht
	// pauschal unentscheidbar, sondern nur so weit, wie sein deklarierter Typ überhaupt eine
	// Funktion sein kann - ein Integer ist nie aufrufbar und kann die Weitergabe nicht unrein
	// machen. Ohne diese Unterscheidung wäre praktisch jede geschachtelte Funktion, die einen
	// äußeren Wert weiterreicht, unentscheidbar.
	it('fremder Parameter mit nicht-funktionalem Typ ist rein weitergebbar (nested)', () => {
		expect(innerPurityOf('outer = (a: Integer) => () => a.add(1)')).to.equal('pure');
	});
	// Derselbe Fall in der Branch-Variante - das ist die Struktur von
	// jul-examples/fibonacci/fibonacci.jul, hier ohne Rekursion. Eine zweite, unabhängige Ursache:
	// im Branch ist a durch das Narrowing kein parameterReference mehr, sondern der verengte Typ
	// (And(a Not(0))) - getArgumentPurity muss auch in and/or absteigen.
	it('fremder Parameter mit nicht-funktionalem Typ ist rein weitergebbar (branch)', () => {
		expect(purityOfDefinition(`f = (a: Integer) =>
	?(a)
		[0] => 0
		() => subtract(a 1)`, 'f')).to.equal('pure');
	});
	// Der Dummy-Rumpf (nativeValue) importierter TS-Funktionen darf nicht als beweisbar unrein
	// gewertet werden - für sie greift die Inferenz nicht, ihr Typ bleibt unknown.
	it('aus TypeScript importierte Funktion bleibt unknown', () => {
		const tsPath = 'imported.ts';
		const parsed = parseCode('export function imported(x: number): number { return x; }\n', tsPath);
		checkTypes(parsed, { [tsPath]: parsed }, { cloneUnchecked: false });
		const type = parsed.checked?.expressions
			?.find((expression): expression is ParseSingleDefinition =>
				expression.type === 'definition' && expression.name.name === 'imported')
			?.value?.typeInfo?.type;
		expect(type && isFunctionType(type) ? type.purity : undefined).to.equal('unknown');
	});
	// Schritt 4 (docs/pure-inference-umsetzung.md): JUL5101, gemeldet nur gegen einen echten
	// Widerspruch, nicht gegen einen bloß unentscheidbaren Rumpf.
	it('JUL5101: -> mit beweisbar unreinem Rumpf wird gemeldet', () => {
		const parsed = parseCode('f = () -> Any => log()', 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.have.lengthOf(1);
		expect(parsed.checked?.errors?.[0]?.code).to.equal(ErrorCode.purityMismatch);
	});
	it('JUL5101: -> über einem unentscheidbaren Rumpf meldet nichts', () => {
		const parsed = parseCode('outer = (cb: () :> Any) => () -> Any => cb()', 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
	});
	it('JUL5101: der Fehler steht an der Aufrufstelle, nicht an der ganzen Funktion', () => {
		const code = `f = () -> Any =>
	1
	log()`;
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		const error = parsed.checked?.errors?.find(e => e.code === ErrorCode.purityMismatch);
		expect(error).to.not.equal(undefined);
		// Die Funktion selbst spannt Zeile 0-2 auf - steht der Fehler an "log()" (Zeile 2), nicht
		// an der ganzen Funktion (die bei Zeile 0 begänne), ist die Position korrekt verengt.
		expect(error?.startRowIndex).to.equal(2);
		expect(error?.relatedInformation?.message).to.equal('Declared as pure here.');
	});

	// Schritt 7: die Argument-Regel hat in dieser Hälfte noch keinen Konsumenten (der kommt erst
	// mit dem Constant Folding) - getCallPurity wird deshalb direkt getestet, an einem
	// functionCall-Knoten, den letzten im Code, statt über einen sichtbaren Effekt.
	function callPurityOf(code: string): Purity | undefined {
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		function findLastCall(expression: PositionedExpression): ParseFunctionCall | undefined {
			return forEachChild(expression, findLastCall)
				?? (expression.type === 'functionCall' ? expression : undefined);
		}
		let lastCall: ParseFunctionCall | undefined;
		parsed.checked?.expressions?.forEach(expression => {
			lastCall = findLastCall(expression) ?? lastCall;
		});
		const functionType = lastCall?.functionExpression?.typeInfo?.type;
		const prefixArgumentType = lastCall?.prefixArgument?.typeInfo?.type;
		const argsType = lastCall?.arguments?.typeInfo?.type;
		if (!functionType || !isFunctionType(functionType) || !argsType) {
			return undefined;
		}
		return getCallPurity(functionType, prefixArgumentType, argsType);
	}

	it('map(add ...) ist pure', () => {
		expect(callPurityOf('map([1 2] add)')).to.equal('pure');
	});
	it('map(log ...) ist impure', () => {
		expect(callPurityOf('map([1 2] log)')).to.equal('impure');
	});
	it('map(myFn ...) mit unknown Callback ist impure (konservativ)', () => {
		expect(callPurityOf(`someFn = () ~> Any => log()
myFn = () :> Any => someFn()
map([1 2] myFn)`)).to.equal('impure');
	});
	it('toDictionary mit einem reinen und einem unreinen Callback ist impure', () => {
		expect(callPurityOf(`toDictionary(
	[§a§ §b§]
	(value index) -> value
	(value index) ~> log(value)
)`)).to.equal('impure');
	});
	it('add(2 3) ist pure (keine Funktionsargumente)', () => {
		expect(callPurityOf('add(2 3)')).to.equal('pure');
	});
	it('f = map, dann f(add ...) ist pure (die Regel arbeitet am Typ, nicht am Symbol)', () => {
		expect(callPurityOf(`f = map
f([1 2] add)`)).to.equal('pure');
	});
	// Schritt 1: die drei Lücken der bisherigen Argument-Regel.
	it('unreine Funktion im Prefix-Argument ist impure', () => {
		expect(callPurityOf(`imp = () ~> Any => 1
apply = (cb: () :> Any) -> Any => cb()
imp.apply()`)).to.equal('impure');
	});
	// Direkt an getCallPurityInfo statt über Quelltext: eine bedingt reine Zielfunktion ist
	// Voraussetzung dafür, dass die Argument-Regel überhaupt greift (nur pureIfArgsPure löst sie
	// aus, nicht mehr jede -> Funktion unabhängig davon, ob sie ihr Argument überhaupt benutzt).
	it('getCallPurityInfo: unreine Funktion in einem Dictionary-Argument ist impure', () => {
		const conditionallyPureFunctionType = createCompileTimeFunctionType(builtinEmpty, builtinEmpty, 'pureIfArgsPure');
		const impureFieldType = createCompileTimeFunctionType(builtinEmpty, builtinEmpty, 'impure');
		const dictionaryArgType = createCompileTimeDictionaryLiteralType({ cb: impureFieldType }, true);
		const argsType = createCompileTimeTupleType([dictionaryArgType]);
		expect(getCallPurityInfo(conditionallyPureFunctionType, undefined, argsType)).to.equal('impure');
	});
	// Eine Spread-Argumentliste wird zu List(Type), nicht zu einem Tuple mit einem Element je
	// Position - getArgumentPurity kann dann nicht mehr in die einzelnen Argumente absteigen und
	// bleibt bei 'unknown', selbst wenn jedes einzelne Element für sich pure wäre. getCallPurity
	// faltet das zweiwertig auf 'impure' ab, weil nur ein Beweis als pure zählt.
	it('getCallPurity: Spread-Argumentliste (List, kein Tuple) ist impure, weil sie nicht mehr durchrutscht', () => {
		const conditionallyPureFunctionType = createCompileTimeFunctionType(builtinEmpty, builtinEmpty, 'pureIfArgsPure');
		const pureFieldType = createCompileTimeFunctionType(builtinEmpty, builtinEmpty, 'pure');
		const listArgsType = createCompileTimeListType(pureFieldType);
		expect(getCallPurity(conditionallyPureFunctionType, undefined, listArgsType)).to.equal('impure');
	});
	it('getCallPurityInfo: Spread-Argumentliste ist unknown, nicht impure', () => {
		const conditionallyPureFunctionType = createCompileTimeFunctionType(builtinEmpty, builtinEmpty, 'pureIfArgsPure');
		const listArgsType = createCompileTimeListType(builtinEmpty);
		expect(getCallPurityInfo(conditionallyPureFunctionType, undefined, listArgsType)).to.equal('unknown');
	});
	it('getCallPurityInfo: Weitergabe des eigenen Parameters ist pure', () => {
		const ownFunctionType = createCompileTimeFunctionType(builtinEmpty, builtinEmpty, 'pureIfArgsPure');
		const ownParameter = createParameterReference('cb', 0);
		ownParameter.functionRef = ownFunctionType;
		const argsType = createCompileTimeTupleType([ownParameter]);
		expect(getCallPurityInfo(ownFunctionType, undefined, argsType, ownFunctionType)).to.equal('pure');
	});
	it('getCallPurityInfo: Weitergabe eines Parameters ohne Eigentümer-Kontext ist unknown', () => {
		const ownFunctionType = createCompileTimeFunctionType(builtinEmpty, builtinEmpty, 'pureIfArgsPure');
		const someParameter = createParameterReference('cb', 0);
		someParameter.functionRef = ownFunctionType;
		const argsType = createCompileTimeTupleType([someParameter]);
		expect(getCallPurityInfo(ownFunctionType, undefined, argsType)).to.equal('unknown');
	});
	it('getCallPurityInfo: Weitergabe eines fremden Parameters ist unknown', () => {
		const ownFunctionType = createCompileTimeFunctionType(builtinEmpty, builtinEmpty, 'pureIfArgsPure');
		const otherFunctionType = createCompileTimeFunctionType(builtinEmpty, builtinEmpty, 'pureIfArgsPure');
		const foreignParameter = createParameterReference('cb', 0);
		foreignParameter.functionRef = otherFunctionType;
		const argsType = createCompileTimeTupleType([foreignParameter]);
		expect(getCallPurityInfo(ownFunctionType, undefined, argsType, ownFunctionType)).to.equal('unknown');
	});

	// Vierter Purity-Zustand pureIfArgsPure: rein, sofern die übergebenen Funktionsargumente
	// rein sind. Trägt künftig, was heute unsichtbar in getCallPurityInfo steckt.
	it('map trägt bedingte Purity, kein pure', () => {
		expect(purityOf('map')).to.equal('pureIfArgsPure');
	});
	it('map(add ...) bleibt pure', () => {
		expect(callPurityOf('map([1 2] add)')).to.equal('pure');
	});
	it('map(log ...) bleibt impure', () => {
		expect(callPurityOf('map([1 2] log)')).to.equal('impure');
	});
	it('-> ignoriert die Argumente: unbedingte Zusicherung', () => {
		expect(callPurityOf(`imp = () ~> Any => 1
f = (cb: () :> Any) -> Any => 1
f(imp)`)).to.equal('pure');
	});
	it('Nutzer-HOF, die den eigenen Parameter aufruft, wird bedingt rein', () => {
		expect(purityOfDefinition('apply = (cb: () :> Any) -> Any => cb()', 'apply')).to.equal('pureIfArgsPure');
	});
	it('bedingt reine Nutzer-HOF mit unreinem Argument ist impure', () => {
		expect(callPurityOf(`imp = () ~> Any => 1
apply = (cb: () :> Any) -> Any => cb()
imp.apply()`)).to.equal('impure');
	});
	// Anders als im vorigen Test ruft f hier cb tatsächlich auf und wird dadurch selbst
	// pureIfArgsPure - erst das macht die Argument-Regel an dieser Aufrufstelle scharf: map ist
	// selbst pureIfArgsPure und zählt als Argument-Wert (nicht als Aufruf) wie unknown.
	it('bedingt reine Funktion als Wert weitergegeben zählt als unknown', () => {
		expect(callPurityOf(`f = (cb: () :> Any) -> Any => cb()
f(map)`)).to.equal('impure');
	});
	it('unbekannter Callback bleibt unknown, auch bei reinen Datenargumenten', () => {
		expect(innerPurityOf('outer = (cb: (x: Integer) :> Any) => () => cb(5)')).to.equal('unknown');
	});

	// docs/pure-inference-umsetzung.md Schritt 2: der Rumpf-Walker. Läuft direkt auf dem bereits
	// geprüften Baum, unabhängig von der Verdrahtung in case 'functionLiteral' (Schritt 3).
	function bodyPurityOf(code: string, definitionName = 'f'): Purity | undefined {
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		const definition = parsed.checked?.expressions
			?.find((expression): expression is ParseSingleDefinition =>
				expression.type === 'definition' && expression.name.name === definitionName);
		const value = definition?.value;
		if (value?.type !== 'functionLiteral') {
			return undefined;
		}
		const functionType = value.typeInfo?.type;
		if (!functionType || !isFunctionType(functionType)) {
			return undefined;
		}
		return inferBodyPurity(value.body, functionType).purity;
	}

	// Für die Closure-Fälle (E2): der Rumpf, dessen Purity geprüft wird, ist die ZURÜCKGEGEBENE
	// innere Funktion von "outer", nicht "outer" selbst.
	function innerBodyPurityOf(code: string): Purity | undefined {
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		const definition = parsed.checked?.expressions
			?.find((expression): expression is ParseSingleDefinition =>
				expression.type === 'definition' && expression.name.name === 'outer');
		const outerValue = definition?.value;
		if (outerValue?.type !== 'functionLiteral') {
			return undefined;
		}
		const inner = outerValue.body[outerValue.body.length - 1];
		if (inner?.type !== 'functionLiteral') {
			return undefined;
		}
		const functionType = inner.typeInfo?.type;
		if (!functionType || !isFunctionType(functionType)) {
			return undefined;
		}
		return inferBodyPurity(inner.body, functionType).purity;
	}

	it('konstanter Rumpf ist pure', () => {
		expect(bodyPurityOf('f = (a: Integer) => a')).to.equal('pure');
	});
	it('Aufruf von log ist impure', () => {
		expect(bodyPurityOf('f = () => log()')).to.equal('impure');
	});
	// Kein Fall mehr "Aufruf einer :>-Funktion ist unknown" mit einem einfachen (nicht über eine
	// Closure oder TypeScript geschlossenen) g: seit der Verdrahtung in Schritt 3 wird jedes
	// beweisbar reine g selbst zu -> - :> überlebt nur noch als Closure über einen fremden
	// Parameter (E2, siehe unten) oder als TypeScript-Import (E6, siehe "Verdrahtung"-Suite unten).
	it('erzeugtes, aber nicht aufgerufenes unreines Literal ist pure', () => {
		expect(bodyPurityOf('f = () => () ~> Any => log()')).to.equal('pure');
	});
	it('sofort aufgerufenes unreines Literal ist impure', () => {
		expect(bodyPurityOf(`f = () =>
	g = () ~> Any => log()
	g()`)).to.equal('impure');
	});
	it('Branching mit einem unreinen Zweig ist impure', () => {
		expect(bodyPurityOf(`f = (x: Or(1 2)) => ?(x)
	[1] -> Integer => 1
	[2] ~> Integer => log(2)`)).to.equal('impure');
	});
	it('Branching mit einer unreinen Referenz als Zweig ist impure', () => {
		expect(bodyPurityOf(`onOne = (n: 1) -> Integer => 1
onTwo = (n: 2) ~> Integer => log(n)
f = (x: Or(1 2)) => ?(x)
	onOne
	onTwo`)).to.equal('impure');
	});
	it('Closure über einen fremden Parameter als Wert ist pure', () => {
		expect(innerBodyPurityOf('outer = (cb: () :> Any) => () => cb')).to.equal('pure');
	});
	it('Closure über einen fremden Parameter als Aufruf ist unknown', () => {
		expect(innerBodyPurityOf('outer = (cb: () :> Any) => () => cb()')).to.equal('unknown');
	});
	it('direkte Rekursion ohne log ist pure', () => {
		expect(bodyPurityOf('f = (n: Integer) => f(n)')).to.equal('pure');
	});
	it('direkte Rekursion mit log ist impure', () => {
		expect(bodyPurityOf('f = (n: Integer) => f(log(n))')).to.equal('impure');
	});
	it('Weitergabe des eigenen Parameters an map ist pure', () => {
		expect(bodyPurityOf('f = (cb: () :> Any) => map([1 2] cb)')).to.equal('pure');
	});
	// id gibt x nur zurück, ruft es nicht auf - id selbst bleibt beweisbar pure (-> ist eine
	// unbedingte Zusicherung, keine Argumentprüfung), auch wenn das übergebene Dictionary
	// eine unreine Funktion enthält. Unrein wäre erst ein Aufruf des Rückgabewerts.
	it('log tief in einem Dictionary-Argument bleibt pure, weil id es nur durchreicht', () => {
		expect(bodyPurityOf(`id = (x) -> Any => x
f = () => id([cb = log])`)).to.equal('pure');
	});
});

// Der letzte Ausdruck ist immer `r = <Aufruf>`, geprüft wird der Typ von r - Faltung meldet nie
// etwas, deshalb ist "keine neue Diagnose" jeweils Teil der Prüfung (errors muss leer bleiben).
describe('constant folding', () => {
	function typeOfLastDefinition(code: string): string | undefined {
		const parsed = parseCode(code, 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
		const expressions = parsed.checked?.expressions ?? [];
		const last = expressions[expressions.length - 1] as ParseSingleDefinition;
		const type = last.value?.typeInfo?.type;
		return type && typeToString(resolvePlaceholders(type), 0, 5);
	}

	//#region 5a Faltung greift

	it('subtract(5 3) faltet zu 2', () => {
		expect(typeOfLastDefinition('r = subtract(5 3)')).to.equal('2');
	});
	it('Variablen tragen ihren Literaltyp: add(x 3) faltet zu 8', () => {
		expect(typeOfLastDefinition('x = 5\nr = add(x 3)')).to.equal('8');
	});
	it('combineTexts faltet Text-Argumente', () => {
		expect(typeOfLastDefinition('r = combineTexts([§x§ §y§] §-§)')).to.equal('§x-y§');
	});
	it('Prefixargument wird mitgefaltet', () => {
		expect(typeOfLastDefinition('r = 2.add(3)')).to.equal('5');
	});
	it('Rest-Parameter wird gefaltet', () => {
		expect(typeOfLastDefinition('r = add(2 3)')).to.equal('5');
	});
	it('parseFloat faltet einen validen Text', () => {
		expect(typeOfLastDefinition('r = parseFloat(§1.5§)')).to.equal('1.5f');
	});
	it('parseFloat faltet zu Error bei ungültigem Text (zurückgegebener Error, kein Wurf)', () => {
		expect(typeOfLastDefinition('r = parseFloat(§abc§)')).to.equal('Error');
	});
	it('slice faltet zu einem präzisen Tuple statt Or(Empty ...)', () => {
		expect(typeOfLastDefinition('r = [1 2 3].slice(2)')).to.equal('[2 3]');
	});
	it('slice außerhalb des Bereichs faltet zu Empty', () => {
		expect(typeOfLastDefinition('r = [1 2 3].slice(9)')).to.equal('Empty');
	});
	it('filter faltet mit predicate', () => {
		expect(typeOfLastDefinition(`x = [1 2 3 [] §asdf§].filter(
	(value) =>
		?(value)
			[Integer] => true
			() => false
)`)).to.equal('[1 2 3]');
	});
	//#endregion 5a Faltung greift

	//#region 5b Faltung unterbleibt

	it('faltet nicht bei nicht-konstantem Argument (Funktionsparameter statt Literal)', () => {
		// Der Pfeil ist hier :> geschrieben, wird aber seit Schritt 3 durch den beweisbar reinen
		// Rumpf ersetzt (E3) - das ist nicht der Punkt dieses Tests, nur die Signatur zur
		// Identifikation. Worum es geht: add(x 3) faltet trotz Purity nicht, weil x kein
		// konstanter Wert ist.
		expect(typeOfLastDefinition('f = (x: Integer) :> Integer => add(x 3)'))
			.to.equal('(x: Integer) -> Integer');
	});
	it('faltet nicht bei log (purity impure)', () => {
		expect(typeOfLastDefinition('r = log(1)')).to.equal('Empty');
	});
	it('faltet nicht bei currentDate (purity impure)', () => {
		expect(typeOfLastDefinition('r = currentDate()')).to.equal('Date');
	});
	it('faltet nicht bei einem Callback-Argument, das nicht beweisbar rein ist (map(log ...))', () => {
		expect(typeOfLastDefinition('r = map([1 2] log)')).to.equal('[Empty Empty]');
	});
	it('faltet nicht bei einem Aufruf mit Argumenttypfehler', () => {
		// Eine Funktion mit festem Rückgabetyp, damit das Ergebnis nicht von den Argumenten abhängt.
		const parsed = parseCode('r = subtractFloat(§abc§ 1.5f)', 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.have.lengthOf(1);
		const def = parsed.checked?.expressions?.[0] as ParseSingleDefinition;
		const type = def.value?.typeInfo?.type;
		expect(type && typeToString(resolvePlaceholders(type), 0, 5)).to.equal('Float');
	});

	//#endregion 5b

	//#region 5c Abgleich mit den abhängigen Rückgabetypen

	// getElement, setElement, getField deklarieren ihren Rückgabetyp generisch über den
	// Aufrufort (ElementAt/WithElementAt/TypeOf(...)/ElementType); dieselben Aufrufe sind
	// zugleich mit konstanten Argumenten faltbar. Beide Mechanismen müssen übereinstimmen -
	// das ist der Riegel gegen stilles Auseinanderlaufen, den Schritt 4 sonst nicht hätte.
	it('getElement: gefalteter Wert stimmt mit dem abhängigen Typ überein', () => {
		expect(typeOfLastDefinition('r = [1 2 3].getElement(2)')).to.equal('2');
	});
	it('getElement außerhalb des Bereichs: beide Wege liefern Empty', () => {
		expect(typeOfLastDefinition('r = [1 2 3].getElement(5)')).to.equal('Empty');
	});
	it('setElement: gefalteter Wert stimmt mit dem abhängigen Typ überein', () => {
		expect(typeOfLastDefinition('r = [].setElement(2 5)')).to.equal('[Empty 5]');
	});
	it('getField: gefalteter Wert stimmt mit dem abhängigen Typ überein', () => {
		expect(typeOfLastDefinition('r = [a = 1 b = 2].getField(§a§)')).to.equal('1');
	});

	//#endregion 5c

	//#region 5d Nutzerfunktionen

	it('Nutzerfunktion mit konstantem Argument faltet', () => {
		// Eröffnungsfall, zugleich Gegenprobe zur Faltbarkeitsregel: multiply ist eine
		// nativeFunction, und double ist trotzdem faltbar - die Regel hängt am emittierten
		// Slice, nicht am Aufrufgraphen.
		expect(typeOfLastDefinition(`double = (a: Integer) => a.multiply(2)
r = double(21)`)).to.equal('42');
	});

	it('freie Referenz auf eine Konstante wird in die Umgebung gebunden', () => {
		expect(typeOfLastDefinition(`factor = 3
triple = (a: Integer) => a.multiply(factor)
r = triple(7)`)).to.equal('21');
	});

	it('freie Referenz auf einen nicht konstanten Wert verhindert die Faltung', () => {
		expect(typeOfLastDefinition(`stamp = currentDate()
f = () => stamp
r = f()`)).to.equal('Date');
	});

	it('Rekursion mit Abbruchbedingung faltet', () => {
		// Wortgleich zu jul-examples/fibonacci/fibonacci.jul, damit die Rekursion echt ist.
		expect(typeOfLastDefinition(`fibonacciHelper = (
	countdown: Integer
	current: Integer
	previous: Integer
) =>
	?(countdown)
		[0] => previous
		() => fibonacciHelper(subtract(countdown 1) add(current previous) current)
r = fibonacciHelper(10 1 0)`)).to.equal('55');
	});

	it('Nutzerfunktion ohne konstantes Argument faltet nicht', () => {
		// Ungefaltet bleibt der Rückgabetyp von multiply stehen: Integer für Integer-Operanden,
		// kein Literal.
		expect(typeOfLastDefinition(`double = (a: Integer) => a.multiply(2)
r = (x: Integer) => double(x)`)).to.equal('(x: Integer) -> Integer');
	});

	it('eine per nativeFunction definierte Funktion wird nicht gefaltet', () => {
		// myFn behauptet -> (ungeprüft, per nativeFunction definiert), f ist damit rein und
		// enthält selbst kein nativeFunction-Literal. Die Faltung wird also versucht und muss am
		// Umgebungsaufbau scheitern: myFn trägt weder literal noch einen Runtime-Export-Namen.
		expect(typeOfLastDefinition(`myFn = nativeFunction(
	(a: Integer) -> Integer
	§js
		(a) => a
	§
)
f = (a: Integer) => myFn(a)
r = f(21)`)).to.equal('Integer');
	});

	it('nicht terminierende Rekursion faltet nicht und meldet nichts', () => {
		// Budget. Das Listen-Argument ist wesentlich: mit Dictionary-Argument liefe der Aufruf
		// über _callFunction, und der Test wäre auch mit einem Budget an der falschen Stelle
		// grün. Der erwartete Typ ist der ungefaltete Rückgabetyp - aus dem roten Lauf
		// ablesen.
		expect(typeOfLastDefinition(`spin = (n: Integer) => spin(add(n 1))
r = spin(0)`)).to.equal('Any');
	});

	it('Nutzerfunktion mit konstanten Argumenten faltet (Runtime-Export ist keine Voraussetzung mehr)', () => {
		expect(typeOfLastDefinition(
			'f = (a: Integer b: Integer) -> Integer => add(a b)\nr = f(2 3)'))
			.to.equal('5');
	});

	// Ein Parameter mit gleichem Namen wie eine äußere Definition ('factor = 99\nf = (factor:
	// Integer) => ...') ist in JUL nicht schreibbar - jede Überdeckung eines Namens aus einem
	// oberen Scope ist JUL4003, ganz unabhängig davon, ob es sich um einen Parameter oder eine
	// Definition handelt. Der Sammler kann eine solche Kollision also nie beobachten; die
	// Namensgleichheit selbst ist bereits durch den Checker ausgeschlossen.
	it('ein Parameter mit gleichem Namen wie eine äußere Definition ist JUL4003', () => {
		const parsed = parseCode('factor = 99\nf = (factor: Integer) => factor.multiply(2)\nr = f(4)', 'dummy.jul');
		expect(parsed.unchecked.errors).to.deep.equal([]);
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.have.lengthOf(1);
		expect(parsed.checked?.errors?.[0]?.code).to.equal(ErrorCode.alreadyDefinedInUpperScope);
	});

	it('eine lokale Definition ist keine freie Referenz', () => {
		expect(typeOfLastDefinition(`f = (a: Integer) =>
	step = 3
	a.multiply(step)
r = f(4)`)).to.equal('12');
	});

	// Die Typangabe eines Branches steht in dessen Parameterliste, nicht im Rumpf - eine freie
	// Referenz dort muss genauso in die Umgebung wie eine im Rumpf.
	it('freie Referenz in der Typangabe eines Branches wird in die Umgebung gebunden', () => {
		expect(typeOfLastDefinition(`isFive = (n: Integer) => n.equal(5)
f = (index: Integer) =>
	?(index)
		[isFive] => §five§
		Any => index
r = f(5)`)).to.equal('§five§');
	});

	it('Aufruf in der Typangabe eines Branches faltet (fizz-buzz)', () => {
		expect(typeOfLastDefinition(`divisibleBy = (divisor: NonZeroInteger) =>
	(dividend: Integer) =>
		dividend.modulo(divisor).equal(0)
fizzBuzzMessage = (index: Integer) =>
	?(index)
		[divisibleBy(15)] => §FizzBuzz§
		[divisibleBy(5)] => §Buzz§
		[divisibleBy(3)] => §Fizz§
		Any => index
r = fizzBuzzMessage(12)`)).to.equal('§Fizz§');
	});

	//#endregion 5d

	//#region 5e HOF mit Nutzerfunktionen (typeToConstantValue.case 'function')

	it('map mit Nutzer-Callback faltet', () => {
		// map erwartet den Callback-Parameter namentlich als 'value' (Kontravarianz-Vertrag,
		// siehe parameter-name-mismatch-reports-names-in-wrong-order oben).
		expect(typeOfLastDefinition(`double = (value: Integer) => value.multiply(2)
r = map([1 2 3] double)`)).to.equal('[2 4 6]');
	});

	it('map mit nicht faltbarem Callback faltet nicht', () => {
		expect(typeOfLastDefinition(`stamp = currentDate()
tag = (value: Integer) => stamp
r = map([1 2] tag)`)).to.equal('[Date Date]');
	});

	it('toDictionary mit zwei Nutzer-Callbacks faltet', () => {
		// Beide Callbacks müssen materialisiert werden, nicht nur der erste.
		expect(typeOfLastDefinition(`getKey = (value: Integer index: PositiveInteger) =>
	?(index)
		[1] => §first§
		() => §rest§
getValue = (value: Integer index: PositiveInteger) => value.multiply(10)
r = toDictionary([1 2] getKey getValue)`)).to.equal('[\n  first: 10\n  rest: 20\n]');
	});

	//#endregion 5e
});

//#region Bedingte Typen

// Die Definitionen f, d, s, g und n hängen nicht an der core-lib, S bis E laufen also unabhängig
// von deren Umstellung. Jeder Fall hängt h an, geprüft wird der Rückgabetyp von h.
const conditionalOneOperand = 'f = (a: Rational)\n\t->\n\t\t:?(TypeOf(a))\n\t\t\t[Integer] => Integer\n\t\t\t() => Fraction\n\t=> a';
const conditionalTwoOperands = 'd = (a: Rational b: Rational)\n\t->\n\t\t:?(TypeOf(a) TypeOf(b))\n\t\t\t[Integer Integer] => Integer\n\t\t\t() => Fraction\n\t=> a';
const conditionalVariadic = 's = (...xs: List(Rational))\n\t->\n\t\t:?(TypeOf(xs))\n\t\t\t[List(Integer)] => Integer\n\t\t\t() => Fraction\n\t=> 1';
const conditionalFirstMatch = 'g = (a: Rational)\n\t->\n\t\t:?(TypeOf(a))\n\t\t\t[PositiveInteger] => Text\n\t\t\t[Integer] => Integer\n\t\t\t() => Fraction\n\t=> a';
const conditionalWithoutCatchAll = 'n = (a: Rational)\n\t->\n\t\t:?(TypeOf(a))\n\t\t\t[Integer] => Integer\n\t=> 1';

describe('bedingte Typen', () => {
	function check(code: string) {
		const parsed = parseCode(code, 'dummy.jul');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		return parsed;
	}

	/**
	 * Rückgabetyp der letzten Definition, deren Wert eine Funktion ist. Tiefe 5 wie bei
	 * typeOfLastDefinition, damit Alias-Namen (Fraction) erscheinen.
	 */
	function returnTypeOfLastDefinition(expressions: ParseExpression[]): string | undefined {
		const definitions = expressions.filter((expression): expression is ParseSingleDefinition =>
			expression.type === 'definition');
		for (let index = definitions.length - 1; index >= 0; index--) {
			const type = definitions[index]!.value?.typeInfo?.type;
			if (isFunctionType(type)) {
				return typeToString(resolvePlaceholders(type.ReturnType), 0, 5);
			}
		}
		return undefined;
	}

	function typeOfLastDefinition(expressions: ParseExpression[]): string | undefined {
		const last = expressions[expressions.length - 1] as ParseSingleDefinition;
		const type = last.value?.typeInfo?.type;
		return type && typeToString(resolvePlaceholders(type), 0, 5);
	}

	const expectConditional = reportAtCaller((code: string, { returnType, type, errors }: {
		/** Rückgabetyp der letzten Funktionsdefinition. */
		returnType?: string;
		/** Typ der letzten Definition, für Aufrufe auf oberster Ebene. */
		type?: string;
		/** Ohne errors gilt: fehlerfrei. Die Parserfehler sind in den Checker-Fehlern enthalten. */
		errors?: { code: ErrorCode; startRowIndex: number; startColumnIndex: number; }[];
	} = {}) => {
		const parsed = check(code);
		expect(parsed.checked?.errors?.map(error => ({
			code: error.code,
			startRowIndex: error.startRowIndex,
			startColumnIndex: error.startColumnIndex,
		}))).to.deep.equal(errors ?? []);
		const expressions = parsed.checked?.expressions ?? [];
		if (returnType !== undefined) {
			expect(returnTypeOfLastDefinition(expressions)).to.equal(returnType);
		}
		if (type !== undefined) {
			expect(typeOfLastDefinition(expressions)).to.equal(type);
		}
	});
	//#region S: Semantik, ein Operand
	it('S1 Teilmenge', () => expectConditional(`${conditionalOneOperand}\nh = (x: Integer) => f(x)`, { returnType: 'Integer' }));
	it('S2 Teilmenge über Untertyp', () => expectConditional(`${conditionalOneOperand}\nh = (x: PositiveInteger) => f(x)`, { returnType: 'Integer' }));
	it('S3 disjunkt', () => expectConditional(`${conditionalOneOperand}\nh = (x: Fraction) => f(x)`, { returnType: 'Fraction' }));
	it('S4 Überlappung', () => expectConditional(`${conditionalOneOperand}\nh = (x: Rational) => f(x)`, { returnType: 'Or(Integer Fraction)' }));
	it('S5 Literal wird über das reine f gefaltet', () => expectConditional(`${conditionalOneOperand}\nh = () => f(5)`, { returnType: '5' }));
	it('S6 Teilmenge beendet', () => expectConditional(`${conditionalFirstMatch}\nh = (x: PositiveInteger) => g(x)`, { returnType: 'Text' }));
	it('S7 Überlappung, dann Teilmenge', () => expectConditional(`${conditionalFirstMatch}\nh = (x: Integer) => g(x)`, { returnType: 'Or(Text Integer)' }));
	it('S8 zwei Mal disjunkt', () => expectConditional(`${conditionalFirstMatch}\nh = (x: Fraction) => g(x)`, { returnType: 'Fraction' }));
	// Kein Treffer bleibt still, auch der Teiltreffer ohne catchAll (bekanntes Risiko).
	it('S9 kein Treffer', () => expectConditional(`${conditionalWithoutCatchAll}\nh = (x: Fraction) => n(x)`, { returnType: 'Never' }));
	it('S10 Teiltreffer, bekanntes Risiko', () => expectConditional(`${conditionalWithoutCatchAll}\nh = (x: Rational) => n(x)`, { returnType: 'Integer' }));
	//#endregion S: Semantik, ein Operand
	//#region M: zwei Operanden
	it('M1', () => expectConditional(`${conditionalTwoOperands}\nh = (x: Integer y: Integer) => d(x y)`, { returnType: 'Integer' }));
	it('M2', () => expectConditional(`${conditionalTwoOperands}\nh = (x: Fraction y: Integer) => d(x y)`, { returnType: 'Fraction' }));
	it('M3', () => expectConditional(`${conditionalTwoOperands}\nh = (x: Rational y: Integer) => d(x y)`, { returnType: 'Or(Integer Fraction)' }));
	it('M4', () => expectConditional(`${conditionalTwoOperands}\nh = (x: PositiveInteger y: Integer) => d(x y)`, { returnType: 'Integer' }));
	it('M5 Präfix', () => expectConditional(`${conditionalTwoOperands}\nh = (x: Integer y: Integer) => x.d(y)`, { returnType: 'Integer' }));
	//#endregion M: zwei Operanden
	//#region V: variadisch
	it('V1', () => expectConditional(`${conditionalVariadic}\nh = (x: Integer y: Integer z: Integer) => s(x y z)`, { returnType: 'Integer' }));
	it('V2', () => expectConditional(`${conditionalVariadic}\nh = (x: Integer y: Fraction) => s(x y)`, { returnType: 'Fraction' }));
	it('V3', () => expectConditional(`${conditionalVariadic}\nh = (x: Integer y: Rational) => s(x y)`, { returnType: 'Or(Integer Fraction)' }));
	it('V4 Spread Integer', () => expectConditional(`${conditionalVariadic}\nh = (ys: List(Integer)) => s(...ys)`, { returnType: 'Integer' }));
	it('V5 Spread Rational', () => expectConditional(`${conditionalVariadic}\nh = (ys: List(Rational)) => s(...ys)`, { returnType: 'Or(Integer Fraction)' }));
	it('V6 Präfix', () => expectConditional(`${conditionalVariadic}\nh = (x: Integer) => x.s(1)`, { returnType: 'Integer' }));
	//#endregion V: variadisch
	//#region P: offene Signatur und Weitergabe
	it('P1 Hover-Form', () => expectConditional(conditionalOneOperand, { returnType: 'Or(Integer Fraction)' }));
	// Trägt der vorhandene Mechanismus ein offenes :? durch eine Funktion ohne deklarierten Rückgabetyp?
	it('P2 generische Weitergabe', () => expectConditional(`${conditionalOneOperand}\nk = (y: Rational) => f(y)\nh = (x: Integer) => k(x)`, { returnType: 'Integer' }));
	//#endregion P: offene Signatur und Weitergabe
	//#region R: Rumpfprüfung gegen die Union aller Zweige
	it('R1 Rumpf in der Union', () => expectConditional(conditionalOneOperand));
	it('R2 Rumpf außerhalb der Union', () => {
		expectConditional('f = (a: Rational)\n\t->\n\t\t:?(TypeOf(a))\n\t\t\t[Integer] => Integer\n\t\t\t() => Fraction\n\t=> §x§', {
			errors: [{ code: ErrorCode.returnTypeMismatch, startRowIndex: 5, startColumnIndex: 4 }],
		});
	});
	// Großzügig: d(1 2) sagt Integer zu, der Rumpf liefert eine Fraction.
	it('R3 bekannte Großzügigkeit', () => {
		expectConditional('d = (a: Rational b: Rational)\n\t->\n\t\t:?(TypeOf(a) TypeOf(b))\n\t\t\t[Integer Integer] => Integer\n\t\t\t() => Fraction\n\t=> 0.5');
	});
	// Rational liegt nicht in Integer: Die Rumpfprüfung fängt den fehlenden catchAll teilweise auf.
	it('R4 Teiltreffer im Rumpf', () => {
		expectConditional('n = (a: Rational)\n\t->\n\t\t:?(TypeOf(a))\n\t\t\t[Integer] => Integer\n\t=> a', {
			errors: [{ code: ErrorCode.returnTypeMismatch, startRowIndex: 4, startColumnIndex: 4 }],
		});
	});
	//#endregion R: Rumpfprüfung gegen die Union aller Zweige
	//#region E: Fehler
	it('E1 außerhalb des Rückgabetyps', () => {
		expectConditional('X = :?(Integer)\n\t[Integer] => Integer', {
			errors: [{ code: ErrorCode.typeBranchingOutsideReturnType, startRowIndex: 0, startColumnIndex: 4 }],
		});
	});
	it('E2 Bindung im Kopf', () => {
		expectConditional('f = (a: Rational)\n\t->\n\t\t:?(TypeOf(a))\n\t\t\t(x: Integer) => Integer\n\t\t\t() => Fraction\n\t=> a', {
			errors: [{ code: ErrorCode.typeBranchHeadBinding, startRowIndex: 3, startColumnIndex: 3 }],
		});
	});
	it('E3 in der Kopfzeile', () => {
		expectConditional('F = (a: Integer) -> :?(TypeOf(a))\n\t[Integer] => Integer', {
			errors: [{ code: ErrorCode.returnTypeRequiresBlock, startRowIndex: 0, startColumnIndex: 20 }],
		});
	});
	//#endregion E: Fehler
	//#region K: core-lib
	it('K1', () => expectConditional('h = (x: Integer y: Integer) => subtract(x y)', { returnType: 'Integer' }));
	it('K2', () => expectConditional('h = (x: Fraction y: Integer) => subtract(x y)', { returnType: 'Fraction' }));
	it('K3', () => expectConditional('h = (x: Rational y: Integer) => subtract(x y)', { returnType: 'Rational' }));
	it('K4', () => expectConditional('h = (x: Integer y: Integer z: Integer) => add(x y z)', { returnType: 'Integer' }));
	// Nicht Fraction: ein Tuple-Kopf nennt nur Mindestpositionen, [Integer Fraction] passte
	// auch auf [Integer Fraction Fraction], und das kann ein Integer sein.
	it('K5', () => expectConditional('h = (x: Integer y: Fraction) => add(x y)', { returnType: 'Rational' }));
	it('K6', () => expectConditional('h = (x: Integer y: Rational) => add(x y)', { returnType: 'Rational' }));
	it('K7', () => expectConditional('h = (ys: List(Integer)) => add(...ys)', { returnType: 'Integer' }));
	it('K8 Präfix', () => expectConditional('h = (x: Integer) => x.add(1)', { returnType: 'Integer' }));
	it('K9 Länge minus eins', () => expectConditional('h = (xs: List(Integer)) => xs.length().subtract(1)', { returnType: 'Integer' }));
	it('K10 Faltung add', () => expectConditional('r = add(2 3)', { type: '5' }));
	it('K10 Faltung subtract', () => expectConditional('r = subtract(5 3)', { type: '2' }));
	// Zwei Fractions können einen Integer ergeben: 1/2 + 1/2 = 1, 1/2 - 1/2 = 0.
	it('K13 Fraction plus Fraction', () => expectConditional('h = (x: Fraction y: Fraction) => add(x y)', { returnType: 'Rational' }));
	it('K14 Fraction minus Fraction', () => expectConditional('h = (x: Fraction y: Fraction) => subtract(x y)', { returnType: 'Rational' }));
	it('K15 Integer minus Fraction', () => expectConditional('h = (x: Integer y: Fraction) => subtract(x y)', { returnType: 'Fraction' }));
	it('K16 Faltung add normalisiert', () => expectConditional('r = add(0.5 0.5)', { type: '1' }));
	it('K16 Faltung subtract normalisiert', () => expectConditional('r = subtract(0.5 0.5)', { type: '0' }));
	it('K17 multiply Integer', () => expectConditional('h = (x: Integer y: Integer z: Integer) => multiply(x y z)', { returnType: 'Integer' }));
	// Auch ein Integer mal eine Fraction kann ein Integer sein: 2 * 1/2 = 1.
	it('K18 multiply mit Fraction', () => expectConditional('h = (x: Integer y: Fraction) => multiply(x y)', { returnType: 'Rational' }));
	it('K19 multiply Spread Integer', () => expectConditional('h = (ys: List(Integer)) => multiply(...ys)', { returnType: 'Integer' }));
	it('K20 multiply Präfix', () => expectConditional('h = (x: Integer) => x.multiply(2)', { returnType: 'Integer' }));
	it('K21 Faltung multiply', () => expectConditional('r = multiply(2 3)', { type: '6' }));
	it('K21 Faltung multiply normalisiert', () => expectConditional('r = multiply(0.5 2)', { type: '1' }));
	it('K11 ohne Argumente', () => {
		expectConditional('r = add()', {
			errors: [{ code: ErrorCode.argumentTypeMismatch, startRowIndex: 0, startColumnIndex: 4 }],
		});
	});
	//#endregion K: core-lib

	// Beim Tippen: wirft nicht und meldet dasselbe wie ein halbes ?(.
	it('E4 unvollständig', () => {
		const errorCodes = (code: string) => check(code).checked?.errors?.map(error => error.code);
		expect(errorCodes('F = (a: Integer)\n\t->\n\t\t:?('))
			.to.deep.equal(errorCodes('F = (a: Integer)\n\t->\n\t\t?('));
	});

	// Der Hover zeigt die aufgelöste Union, mit Alias statt ausgeschriebenem Dictionary.
	it('K12 Hover', () => {
		const type = builtInSymbols['add']?.typeInfo?.type;
		expect(type && typeToString(resolvePlaceholders(type), 0, 0))
			.to.equal('(...args: List(Rational)) -> Rational');
	});
});

//#endregion Bedingte Typen
//#region Ungenutzte Definitionen

describe('ungenutzte Definitionen', () => {
	/**
	 * Erwartet genau die Hinweise auf diese Namen, an Zeile und Spalte ihrer Bindung, und keine
	 * weiteren Fehler.
	 */
	const expectUnused = reportAtCaller((code: string, unused: [name: string, rowIndex: number, columnIndex: number][]) => {
		expectCheck(code, {
			errors: unused.map(([name, rowIndex, columnIndex]) => ({
				code: ErrorCode.unusedDefinition,
				message: `'${name}' is defined but never used.`,
				startRowIndex: rowIndex,
				startColumnIndex: columnIndex,
				endRowIndex: rowIndex,
				endColumnIndex: columnIndex + name.length,
			})),
		});
	});

	it('ungenutzte Definition im Rumpf', () => {
		expectUnused('f = (a: Integer) =>\n\tunused = 1\n\tresult = a', [['unused', 1, 1]]);
	});
	it('letzte Definition ist der Rückgabewert', () => {
		expectUnused('f = () =>\n\tx = 1', []);
	});
	it('Top-Level-Definition ist exportiert', () => {
		expectUnused('x = 1', []);
	});
	it('ungenutzter Parameter', () => {
		expectUnused('f = (a: Integer) => 1', []);
	});
	it('Dictionary-Felder sind keine Bindungen', () => {
		expectUnused('f = () =>\n\tx = [a = 1 b = 2]\n\tx', []);
	});
	it('Nutzung in verschachteltem Lambda', () => {
		expectUnused('f = (a: Integer) =>\n\tx = a\n\tg = () => x\n\tg', []);
	});
	it('Nutzung im TypeGuard', () => {
		expectUnused('f = (a: Integer) =>\n\tT = Integer\n\tx: T = a\n\tx', []);
	});
	it('Nutzung in Interpolation', () => {
		expectUnused('f = () =>\n\tx = 1\n\t§§(x)§', []);
	});
	it('Nutzung als Quelle von a/b', () => {
		expectUnused('f = () =>\n\tx = [b = 1]\n\tx/b', []);
	});
	it('ungenutzte Definition in ?-Zweig', () => {
		expectUnused('f = (a: Integer) =>\n\t?(a)\n\t\t(x: Integer) =>\n\t\t\tunused = 1\n\t\t\tx', [['unused', 3, 3]]);
	});
	it('teilweise genutztes Destructuring', () => {
		expectUnused('f = () =>\n\t(a b) = [a = 1 b = 2]\n\ta', [['b', 1, 4]]);
	});
	// Zurückgegeben wird der ganze Wert, nicht die Felder.
	it('Destructuring am Ende des Rumpfs', () => {
		expectUnused('f = () =>\n\t(a b) = [a = 1 b = 2]', [['a', 1, 2], ['b', 1, 4]]);
	});
	it('Top-Level-Destructuring ist nicht exportiert', () => {
		expectUnused('(a b) = [a = 1 b = 2]\nc = a', [['b', 0, 3]]);
	});
	it('Referenz in der eigenen Definition zählt nicht', () => {
		expectUnused('f = () =>\n\tg = (n: Integer) => g(n)\n\t1', [['g', 1, 1]]);
	});
	it('Rekursion zählt nicht, Aufruf von außen schon', () => {
		expectUnused('f = () =>\n\tg = (n: Integer) => g(n)\n\tg(1)', []);
	});
});

//#endregion Ungenutzte Definitionen

//#region test

describe('test builtin', () => {
	it('test-outside-test-file', () => {
		expectCheck('test(§a§ () => true)', {
			errors: [
				{
					code: ErrorCode.testOutsideTestFile,
					message: `'test' is only allowed in *.test.jul files.`,
					startRowIndex: 0,
					startColumnIndex: 0,
					endRowIndex: 0,
					endColumnIndex: 20,
				},
			],
		});
	});
	it('folded-false-fails-with-arguments', () => {
		expectCheck('test(§a§ () => equal(1 2))', {
			filePath: 'dummy.test.jul',
			errors: [
				{
					code: ErrorCode.testFails,
					message: 'Test fails.\nequal(1 2) returns false.',
					startRowIndex: 0,
					startColumnIndex: 15,
					endRowIndex: 0,
					endColumnIndex: 25,
				},
			],
		});
	});
	it('folded-true-passes', () => {
		expectCheck('test(§a§ () => equal(1 1))', { filePath: 'dummy.test.jul' });
	});
	// Erst die Laufzeit kennt das Ergebnis, statisch ist es nur Boolean.
	it('impure-callback-is-not-reported', () => {
		expectCheck('test(§a§ () => equal(toIsoDateText(currentDate()) §x§))', { filePath: 'dummy.test.jul' });
	});
	// Ohne äußersten Aufruf gibt es keine Argumente zu nennen.
	it('false-literal-fails-without-call', () => {
		expectCheck('test(§a§ () => false)', {
			filePath: 'dummy.test.jul',
			errors: [
				{
					code: ErrorCode.testFails,
					message: 'Test fails.\nThe callback returns false.',
					startRowIndex: 0,
					startColumnIndex: 9,
					endRowIndex: 0,
					endColumnIndex: 20,
				},
			],
		});
	});
	// Das Präfix-Argument ist das erste Argument, genannt werden die gefalteten Werte.
	it('prefix-call-names-folded-arguments', () => {
		expectCheck('f = (x: Integer) => x.add(1)\ntest(§a§ () => f(2).equal(4))', {
			filePath: 'dummy.test.jul',
			errors: [
				{
					code: ErrorCode.testFails,
					message: 'Test fails.\nequal(3 4) returns false.',
					startRowIndex: 1,
					startColumnIndex: 15,
					endRowIndex: 1,
					endColumnIndex: 28,
				},
			],
		});
	});
	it('named-callback-argument', () => {
		expectCheck('test(name = §a§ callback = () => equal(1 2))', {
			filePath: 'dummy.test.jul',
			errors: [
				{
					code: ErrorCode.testFails,
					message: 'Test fails.\nequal(1 2) returns false.',
					startRowIndex: 0,
					startColumnIndex: 33,
					endRowIndex: 0,
					endColumnIndex: 43,
				},
			],
		});
	});
	// Ein Nicht-Boolean meldet die normale Argumentprüfung, nicht die Test-Prüfung.
	it('non-boolean-callback-is-argument-mismatch', () => {
		expectCheck('test(§a§ () => 5)', {
			filePath: 'dummy.test.jul',
			errors: [
				{
					code: ErrorCode.argumentTypeMismatch,
					message: "Argument type mismatch.\nInvalid value for parameter 'callback'\n  Invalid return value\n    Can not assign 5 to Boolean.",
					startRowIndex: 0,
					startColumnIndex: 9,
					endRowIndex: 0,
					endColumnIndex: 16,
				},
			],
		});
	});
});

//#endregion test
