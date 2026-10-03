# Dreiwertige Zuweisbarkeit

Umsetzungsplan. Die Zuweisbarkeitsprüfung des Checkers soll neben „passt" und „passt nicht" ein
drittes Ergebnis kennen: „unbekannt".

## Problem

`getTypeError` ([checker.ts](../src/checker/checker.ts)) kennt zwei Ergebnisse: ein `TypeError`
oder `undefined`. `undefined` heißt dabei zweierlei:

- **Teilmenge:** `PositiveInteger` passt zu `Integer`.
- **Unbekannt, also nachsichtig:** Der Typ steht noch nicht fest (Platzhalter, `Any`), oder die
  Regel ist absichtlich nachsichtig (`Not` als Quelle, Prädikat als Ziel). Nach dem Prinzip
  Freiheit ([design-principles.md](design-principles.md)) darf „nicht entscheidbar" nie zu
  „passt nicht" werden, also wird kein Fehler gemeldet.

Für das Melden eines Fehlers ist das gleichwertig. Wer aus einem **ausbleibenden** Fehler etwas
folgert, muss die beiden Fälle aber unterscheiden. Heute geschieht das über eine Liste:
`hasReliableTypeError` nennt die Typen, bei denen „kein Fehler" nicht „Teilmenge" heißt. Jede neue
nachsichtige Regel, die dort fehlt, wird zur Falle. Drei Fehler dieser Art wurden gefunden und
behoben bzw. umgangen:

| Fall | Folge |
|---|---|
| `Not` als Quelle ist nachsichtig | `Not(GreaterInteger(3))` wurde als `Not(GreaterInteger(2))` angenommen |
| `And(A Not(B))` wurde zu `A`, sobald B keine Teilmenge von A war | `x: And(Integer Not(Greater(2))) = 3` war fehlerfrei |
| `lengthOf` als Ziel wird gegen `PositiveInteger` geprüft, gilt aber als verlässlich | `And(PositiveInteger Or(length(values) LessInteger(length(values))))` wird zu `PositiveInteger`, die obere Grenze geht verloren |

Der dritte Fall ist offen. Die core-lib umgeht ihn, indem sie obere Grenzen als
`Not(GreaterInteger(…))` schreibt (siehe [number-ranges.md](number-ranges.md)).

## Wer die Prüfung benutzt

`getTypeError` beantwortet „passt nicht sicher?", sein `undefined` heißt yes oder unknown. Jede
Stelle will aber eine von drei bestimmten Fragen beantwortet haben. Stand der Analyse, Funktionen
in `checker.ts` (Zeilen zur Orientierung):

| Frage | Ersatz | Stellen |
|---|---|---|
| **Melden:** welcher Fehler, später welche Warnung | `isTypeAssignable` direkt | `inferType`: Zuweisung (3628), Typ-Guard (3737), Argumente (4035), Rückgabetyp (4267); `checkTypeGuardIsType` (9508); `checkIsFunction` (9536); `isTypeAssignableForPredicateFunction`: kann true liefern (8488) |
| **Folgern:** bewiesen eine Teilmenge? | `isSubtypeOf` | ``inferType`: Erreichbarkeit von Branches (3469); `getPredicateFacts`: Rückgabetyp ist Boolean (3251); `addFromTypes`: Grenze nur für bewiesene Integer (5256); `createConditionalType`: Zweig greift ganz (5439); `removeSubtypes` (5517/5521); `createNormalizedIntersectionType`: Vereinfachung für Teilmengen (5794/5797) |
| **Ausschließen:** bewiesen keine Teilmenge? | `isSubtypeOf(…) === false` | `narrowExpectedTypeByFields`: Choice fällt wegen Feld weg (3080/3087); `isNotAssignableTo` (6305); `isFieldOptional` (8716); `hasExpectedTypeError`: Suche der Fehlerposition (8773); Completion im Language Server (`completion.ts`, Filter der Methoden) |

Die Zeile **Folgern** ist die gefährliche: Dort wertet `!getTypeError(…)` heute unknown als
bewiesen. Geschützt sind nur die Stellen mit `hasReliableTypeError` oder `containsAny` daneben,
ungeschützt sind `isBranchingExhaustive`, `getPredicateFacts` und `addFromTypes`.

Schon umgestellt: `isSubtype` in [branch-dispatch.ts](../src/checker/branch-dispatch.ts). Es war
ungeschützt und ließ einen nötigen Laufzeittest weg: `?(x) [List(isEven)] => …` mit
`x: Or(Text List(Integer))` wurde zu `typeof x !== 'string'`, und `[1 3]` lief in den ersten
Branch. Es fragt jetzt `isSubtypeOf`.

## Modell

Gefragt ist: Liegt jeder Wert der Quelle im Ziel?

- **yes:** bewiesen, jeder Wert liegt darin.
- **no:** bewiesen, mindestens ein Wert liegt nicht darin.
- **unknown:** nicht entscheidbar.

Gefolgert wird nur aus yes. Gemeldet wird no als Fehler und unknown als Warnung (siehe Abschnitt
„Warnung bei unknown"): Was der Checker nicht beweisen kann, kann zur Laufzeit schiefgehen.

Der Kern ist `isTypeAssignable` (umgesetzt, siehe Stand):

```ts
type TypeAssignability =
	| { assignable: false; error: TypeError; }                // no
	| { assignable: true; }                                   // yes
	| { assignable: undefined; warning: TypeError; };         // unknown, warning noch anzulegen

function isTypeAssignable(prefixArgumentType, argumentsType, targetType): TypeAssignability;

// Melden: das volle Ergebnis, bei no der Fehler.
// Folgern und Ausschließen: dreiwertig wie typesOverlap, immer mit === true / === false vergleichen.
function isSubtypeOf(type, superType): boolean | undefined;
```

Mehrere Ergebnisse verknüpft `joinTypeAssignabilities`: no, sobald eines no ist, sonst unknown,
sobald eines unknown ist, sonst yes. Das passt für Ziel `And`, Quelle `Or`, Tuple-Positionen und
Felder. Warnungen sammelt es wie Fehler.

Yes wird heute bei jedem Aufruf als neues Objekt erzeugt. Als Konstante (`assignableYes`) entfiele
das. Mit dem Bench prüfen, ob es sich lohnt.

Noch nicht umgesetzt ist `warning`. Das unknown trägt eine Meldung wie das no einen Fehler, und
zwar immer: Es gibt kein unknown ohne Grund, also auch kein stilles. Als Pflichtfeld meldet
TypeScript jede Stelle, die heute `{ assignable: undefined }` ohne Grund liefert, und das ist
zugleich die Liste für Phase 2. Die Meldung entsteht dort, wo die Unsicherheit entsteht, und nennt den Grund („Any an Integer", „hängt am
Parameter values", „Prädikat isEven wird erst zur Laufzeit geprüft"). Die Hüllen für Feld,
Parameter und Rückgabewert stellen ihr den Kontext voran wie beim Fehler. Nur die Prüfung selbst
kann das leisten, denn die Ursache kann verschachtelt sein (`[a = Any]` → `[a: Text]`). Die
Fehlermeldungen bleiben unverändert.

Kosten: Fehler entstehen nur bei no, also selten. Unknown ist häufiger, etwa bei Platzhaltern
während des Normalisierens, und dort fragt nur `isSubtypeOf`, das die Meldung nie liest. Falls der
Bench es zeigt, hält `warning` deshalb nur die Bestandteile (Grund, Quelle, Ziel), und der Text
entsteht erst an der meldenden Stelle.

### Verknüpfung

| Stelle | yes | no | sonst |
|---|---|---|---|
| Ziel `And` | alle Choices yes | ein Choice no | unknown |
| Ziel `Or` | ein Choice yes | alle Choices no | unknown |
| Quelle `Or` | alle Choices yes | ein Choice no | unknown |
| Quelle `And` | ein Choice yes | nur über die bestehenden exakten Regeln (Bereich, `And(A Not(B))`) | unknown |

### Einordnung der heutigen Fälle

Jedes `{ assignable: undefined }` in `isTypeAssignable` wird einzeln als yes oder unknown eingeordnet.
Das sind rund 63, davon 13 ausdrücklich als nachsichtig kommentiert.

- **yes:** Ziel `Any`, gleiche Referenz (`argumentsType === targetType`), alle heutigen
  Strukturregeln, die eine Teilmenge tatsächlich zeigen (Literal in Basistyp, Bereich in Bereich,
  Tuple elementweise usw.)
- **unknown:** Quelle `Any`, denn sie kommt aus Ungetyptem (übersprungene Datei, `runJs`, Import
  ohne Typen) und hat einen bestimmten, nur unbekannten Typ. Als no wäre jeder ungetypte Wert ein
  Fehler, als yes dürfte das Normalisieren `Or(Any Integer)` zu `Integer` machen. Das entspricht
  dem heutigen Verhalten. `parameterReference`, `nestedReference`, `parameters`, `concat`,
  `add`, `mapElements`, `conditional`, `withElementAt` auf beiden Seiten; Prädikat als Ziel,
  wenn der Wert nur in der Obermenge liegt (ein Prädikat ist ein Vertrag, den die Laufzeit
  prüft); das erschöpfte Budget (`maxTypeComparisonDepth`, `maxAliasApplicationExpansions`)
- **Rekursive Aliase:** Liegt das Paar schon auf dem Stapel (`aliasComparisonsInProgress`), ist
  das die übliche koinduktive Annahme und damit yes, nicht unknown. Sonst würde jeder rekursive
  Typ warnen. Heute liefert die Stelle unknown.
- **`Not` als Quelle** wird genau (Schritt in Phase 2): no, außer das Ziel deckt alles außer der
  Quelle des `Not` ab (`Any`, `Not(B)` mit `B ⊆ A`, `Or(A …)`), dann yes. Heute lässt die
  nachsichtige Regel `(a: Not(0)) => a.add(1)` ohne Fehler durch, obwohl `a` Text sein kann.
- **`lengthOf` als Ziel**, ein offener Einzelwert wie ein abstrakter Typ mit oberer Schranke:
  yes bei derselben Länge (`typeEquals`) und bei `Never`, no bei einer Quelle ohne Überschneidung
  mit `PositiveInteger` (`0`, Text), sonst unknown. Als Quelle bleibt es `PositiveInteger`.

Vorbild ist TypeScript: `isTypeRelatedTo` rechnet intern mit einem `Ternary` (`True`, `False`,
`Maybe`, `Unknown`), und ein Typparameter `T extends number` ist `number` zuweisbar, aber nicht
umgekehrt. `typesOverlap` arbeitet im Checker schon so (`true`/`false`/`undefined`).

## Phasen

Jede Phase für sich abnehmbar. Vor und nach jeder Phase `npm run bench -- --save` mit Notiz; der
Checker-Snapshot soll unverändert bleiben, jede Abweichung wird einzeln begründet.

## Stand

Umgesetzt (bis Commit `aad0b93`): `isTypeAssignable` mit `TypeAssignability`, `getTypeError` als
Hülle, `joinTypeAssignabilities`, und die Teilprüfungen für Tuple, Parameter, Funktion, Liste,
Stream und Typ liefern `TypeAssignability`. Yes ist schon gesetzt für: Ziel `Any`, gleiche
Referenz, gleiche Alias-Anwendung, Bereich in Bereich, Basistyp zu Basistyp (Boolean, Integer,
Float, Text, Empty), gleiche Literale (Integer, Float, Text), Grenzen, Funktionen mit yes für
Parameter und Rückgabe, Ziel `Type`, gleiches oder gefaltet wahres Prädikat.

Beim Umbau entstanden drei Fehler derselben Art, inzwischen korrigiert: Ein Ergebnis, das früher
`undefined` oder ein `TypeError` war, ist jetzt immer ein Objekt und damit immer wahr. Betroffen
waren das Prädikat als Ziel (`if (isTypeAssignable(…))`), der Fall „Bereich passt nicht"
(`… ?? { assignable: false … }`, das `??` griff nie) und sechs Stellen der Parameterprüfung
(`if (error) return error`, kehrte beim ersten Parameter zurück). Bei weiteren Umbauten auf
dieselbe Falle achten: Ein `TypeAssignability` immer über `.assignable` abfragen.

Außerdem schlägt `npm run typecheck` fehl, unabhängig von diesem Plan: `scripts/bench.ts` und
`scripts/bench-runtime.ts` importieren noch `../src/emitter.js` und `../src/project-loader.js`,
die mit der Umstrukturierung nach `src/compiler/` gewandert sind.

### Phase 0: Abnahmefälle (umgesetzt)

- `upper-bound-from-open-length-survives-and` (checker.test.ts):
  `And(PositiveInteger Or(length(values) LessInteger(length(values))))` im Parametertyp behält die
  obere Grenze. **Rot**, wird mit Phase 3 und 4 grün.
- `Rückfall: Prädikat im Elementtyp, die Teilmenge ist unbekannt` (emitter.test.ts): ein Branch
  `[List(isEven)]` fällt auf `_branch` zurück. **Grün**, seit `branch-dispatch.ts`
  `isSubtypeOf` nutzt. Dabei war die Zielregel für Dictionary-Literale auf drei Werte umzustellen,
  denn zwei Dispatch-Tests verzweigen über Dictionaries, und deren Teilmenge zeigte bisher nur das
  ausbleibende Fehlerobjekt.

Gegenproben, die heute grün sind und es bleiben müssen: die `upper-bound`-Tests, der Test zur
Vereinfachung von `And(A Not(B))`, die Grenzen-Tests.

### Phase 1: Kern einführen, ohne Verhaltensänderung (umgesetzt)

- Umgesetzt als `isTypeAssignable`, siehe Stand. Der Checker-Snapshot ist mit und ohne den Umbau
  gleich, `getTypeError` zählt 23 Aufrufe mehr, weil die Parameterprüfung jetzt jeden Parameter
  prüft.
- Messen: Die Hülle kostet einen Aufruf und einen Vergleich pro Prüfung, dazu ein Objekt je
  Ergebnis (siehe Konstanten im Modell).

### Phase 2: yes einordnen (umgesetzt)

- **Verknüpfungen:** Quelle `And` (ein Choice yes reicht), Quelle `Or` und Ziel `And` (über
  `joinTypeAssignabilities`, Meldungen unverändert, ohne Entfernen doppelter Zeilen), Ziel `Or`
  (ein Choice yes reicht, Best-Match-Meldung beibehalten), die exakte Regel `And(A Not(B))` gibt
  das Ergebnis des Rests weiter statt unknown. Die Dictionary-Felder sind umgestellt
  (`isTypeAssignableForDictionaryLiteral`, `isTypeAssignableForField`): ein fehlendes Feld in
  einem unvollständigen Dictionary ist unknown, ein fehlendes optionales Feld yes.
- **Einzelfälle:** Ziel `booleanLiteral` bei gleichem Literal ist yes, die Parameterprüfungen
  liefern yes, wenn jeder Parameter yes ist, ein Prädikat als Typ (Ziel `Type`) ist yes.
- **Rekursive Aliase:** Das Paar auf dem Stapel liefert yes (koinduktiv, siehe Einordnung).
- **`Never` als Quelle** ist yes (Test `never-fits-every-type`).
- **`Not` als Quelle ist genau:** gegen `Not(B)` das Ergebnis von `B` gegen `A`, gegen `And`,
  `Or` und Prädikat wird das Ziel zerlegt, gegen ein Ziel, das noch nicht feststeht, unknown, sonst
  no (Test `complement-does-not-fit-base-type`). Dabei kam der erwartete Fall heraus, in dem die
  Inferenz ein `Not` ohne Grundtyp liefert: Verengen eines `Any` ergab `Not(Integer)`, weil
  `And(Any Not(Integer))` das `Any` als neutrales Element strich. Korrigiert in
  `createNormalizedIntersectionType`: Neben einem `Not` bleibt `Any` stehen. Damit die Gegenprobe
  (`And(Any Not(Integer))` gegen `Integer` bleibt ein Fehler) hält, liefert die Regel
  `And(A Not(B))` no, wenn das Ziel ganz im Ausgeschlossenen liegt, auch wenn `A` unbekannt ist.
- **Noch nicht:** Die Tiefengrenze `maxTypeComparisonDepth` liefert weiter no mit der Meldung
  „excessively deep". Als unknown wäre sie bis zur Warnung still, und ein Test verlangt die Meldung
  (sie schützt den Language Server vor einem Stack Overflow). Sie wird zusammen mit der Warnung
  unknown.
- Ergebnis: Checker-Snapshot unverändert, Suite grün bis auf den Abnahmefall für Phase 3/4,
  yugioh und jul-examples fehlerfrei.

### Phase 3: `getTypeError` ersetzen (umgesetzt)

`getTypeError`, `areArgsAssignableTo`, `hasReliableTypeError`, `containsAny` und `isNotAssignableTo`
sind entfernt. Jede Stelle aus der Tabelle unter „Wer die Prüfung benutzt" stellt ihre Frage
ausdrücklich:

- **Melden:** `isTypeAssignable` direkt, bei no der Fehler. `tryFoldCall` bekommt `hasArgsError`.
- **Folgern und Ausschließen:** `isSubtypeOf`, dreiwertig (`true` / `false` / `undefined`) wie
  `typesOverlap`, immer mit `=== true` bzw. `=== false` verglichen. Ein eigenes `isNotSubtypeOf`
  gibt es deshalb nicht. Der Language Server filtert die Completion mit `!== false`.
- Der Zähler `checkerStats.getTypeError` heißt weiter so, sein Name steht im Bench-Protokoll.

Dabei kam heraus und ist korrigiert:
- **Ziel `Not`** lieferte bei bewiesen fehlender Überlappung unknown statt yes.
- **Vereinfachung für Teilmengen** kürzte `And(Any Not(Integer))` zu `Not(Integer)`, weil
  `Not(Integer)` in `Any` liegt. Sie überspringt jetzt `Any`, das hat die Regel für das neutrale
  Element schon entschieden.
- **Faltbudget:** `removeSubtypes` vergleicht jetzt auch Prädikate, das verdoppelte die Faltungen,
  und fizz-buzz mit 100 Elementen wurde nicht mehr gefaltet. `tryFoldPredicate` speichert sein
  Ergebnis je Funktionstyp und Wert (`predicateFoldCache`).
- **`isBranchingExhaustive`** gehört nicht zu den Folgernden: Nicht erschöpfend fügt `Error` in den
  Rückgabetyp ein, das wird an der Verwendung zum Fehler. Es darf also nur bei no gelten, unknown
  gilt als erschöpfend (Prinzip Freiheit). Sonst meldete yugioh zwei falsche Fehler.
- **Spread eines unvollständigen Dictionaries** ergab ein vollständiges, ein fehlendes Feld galt
  dann als bewiesen fehlend. Der Fehler bestand schon vorher, verdeckt durch `removeSubtypes`,
  das das unvollständige Dictionary über `!getTypeError` aus der Union warf. Test
  `dictionary-spread-of-incomplete-dictionary-stays-incomplete`.

Ergebnis: Checker-Snapshot unverändert, Suite grün bis auf den Abnahmefall für Phase 4, yugioh und
jul-examples fehlerfrei, Language Server grün.

### Phase 4: `lengthOf` und die core-lib (umgesetzt)

- Zielregel für `lengthOf`: dieselbe Länge ist yes (im Fall für die Quelle, der zuerst läuft und
  eine Länge sonst als `PositiveInteger` liest), eine Quelle ohne Überschneidung mit
  `PositiveInteger` no, sonst unknown. Der Abnahmefall `upper-bound-from-open-length-survives-and`
  ist grün.
- `range`, `repeat` und `forEach` schreiben die obere Grenze als `Or(end LessInteger(end))`.
  Meldungen und Anzeigen ändern sich dadurch, alle genauer oder gleichwertig: `repeat(3 …)` gegen
  `Not(GreaterInteger(2))` meldet jetzt `Can not assign 3 to …` statt des ganzen `And`, und
  `range(1 n)` mit unbekanntem `n` zeigt `Or(1 GreaterInteger(1))` statt einer Kette von `And`.
- Checker-Snapshot unverändert, yugioh, jul-examples und Language Server fehlerfrei, Bench im
  Wechsel gemessen gleich.

## Vorarbeit: unknown abbauen

Bevor jedes unknown an einer meldenden Stelle warnt, wurde gezählt, wie viele Warnungen das wären
(Zählung von Hand an Definition, Argument und Rückgabewert, Stand nach Phase 4):

| Projekt | Warnungen |
|---|---|
| yugioh | 215 (132 Argumente, 46 Definitionen, 37 Rückgabewerte) |
| jul-examples und core-lib | 30, davon 5 in der core-lib |

Die meisten melden kein Risiko im Programm, sondern Schwächen von Checker und core-lib:

- **Selbst erzeugtes Any.** In yugioh tragen 27 Fälle `cards: Dictionary(Any)` statt
  `Dictionary(GameCard)`, eine Funktion der core-lib verliert den Elementtyp. 13 stammen aus dem
  Akkumulator von `aggregate`, der als `Any` deklariert ist. Berechtigt sind die Rückgabewerte aus
  `dom.ts` und ähnliche Grenzen nach außen.
- **Platzhalter in Callbacks** (etwa 59): Ein Lambda ohne Typangabe bekommt für seinen Parameter
  `TypeOf(x)/ElementType`, der am Aufruf nicht aufgelöst wird.
- **Sonstiges:** Parameterverweise in Signaturen der core-lib, die nicht aufgelöst werden
  (`[count] → (value: Integer)` in `repeat`), `And(value Not(Empty))` als Callback-Parameter, und
  `Any` als Typwert, etwa `Or([] Any Error)` gegen `List(Type)`.

Deshalb vor der Warnung, jeweils mit neuer Zählung danach:

- **a. core-lib:** `aggregate` mit generischem Akkumulator, die Funktion finden, die
  `Dictionary(Any)` erzeugt, `Any` als Typwert als Typ behandeln, die unaufgelösten
  Parameterverweise in den eigenen Signaturen.
- **b. Checker:** Parameter von Callbacks, deren Typ aus dem erwarteten Typ kommt
  (`TypeOf(x)/ElementType`), am Aufruf auflösen.
- **c.** Neu zählen. Erst wenn fast nur noch echte Fälle übrig sind (DOM, `runJs`), die Warnung
  mit `warning` als Pflichtfeld einbauen.

## Anschluss: Warnung bei unknown

Nicht Teil dieses Plans, setzt aber auf ihm auf. **Jedes unknown an einer meldenden Stelle ist eine
Warnung**, mit der Meldung aus `isTypeAssignable`. Grundsatz: Was zur Laufzeit schiefgehen kann,
wird gemeldet. Meldende Stellen sind Definition mit Typ, Argument, Rückgabewert und Feldzugriff,
denn `x/name` ist wie der Aufruf von `getField`.

```jul
x = runJs(§…§)        # Any, keine Warnung
name = x/name         # Warnung: Any an den Feldzugriff, name ist Any
log(name)             # log erlaubt Any, keine Warnung
w: Text = name        # Warnung

# Typ, der vom Parameter abhängt: der Rumpf wird an keinem Aufrufort erneut geprüft
f = (values: List(Any) callback: (value: TypeOf(values)/ElementType) :> Any) =>
	callback(5)       # Warnung, heute still
r = f([§a§] (value: Text) => value)   # zur Laufzeit bekommt der Callback eine 5

# Prädikat: erst die Laufzeit prüft
isEven = (n: Integer) => n.modulo(2).equal(0)
g = (n: isEven) => n
h = (y: Integer) => g(y)                 # Warnung
k = (y: Integer) => ?(y) (e: isEven) => g(e)   # keine Warnung, verengt
```

Dass Typen, die erst am Aufrufort feststehen, still bleiben dürften, stimmt nur für die Argumente
eines Aufrufs: Dort sind die Platzhalter vor der Prüfung ersetzt, ein unknown aus ihnen entsteht
gar nicht. Ein Rumpf wird dagegen nur einmal geprüft. TypeScript meldet im Fall `callback(5)`
sogar einen Fehler (`number is not assignable to T`).

**Voraussetzung: Phase 2 ist abgeschlossen.** Solange echte Teilmengen noch unknown liefern
(Quelle `Or`, Ziel `And`, Parameterprüfungen, die immer mit unknown enden), würden auch korrekte
Programme warnen. Danach gegen core-lib, jul-examples, yugioh und den Snapshot laufen lassen und
jede Warnung einzeln ansehen. `Not` als Quelle ist nach Phase 2 genau und liefert no statt
unknown. Unknowns, die sich als Schwäche des Checkers herausstellen, werden über genaue Regeln zu
yes oder no, nicht über Ausnahmen bei der Warnung.

Ein eigener Typ `Unknown` (strenger oberster Typ wie in TypeScript) ist damit nicht nötig: `Any`
mit dieser Warnung verhält sich wie `unknown`, nur mit Warnung statt Fehler.

## `Never`

**Entschieden:** `Never` als Quelle ist überall yes, als leere Menge liegt es in jedem Typ. So
halten es auch TypeScript (`never`), Kotlin und Scala (`Nothing`) und Rust (`!`). Heute ist es
keinem Typ zuweisbar. Das wird in Phase 2 mit umgestellt, das Normalisieren braucht dann keinen
Sonderfall mehr für `Or(Never X)`. Als Ziel bleibt `Never` streng: Ein Wert passt nie hinein,
`f(5)` an `(a: Never)` bleibt ein Fehler.

Damit ein unmöglicher Typ trotzdem auffällt, wird er dort gemeldet, wo er entsteht, nicht wo er
benutzt wird. Eigener Schritt nach Phase 2:
- Warnung an einem Parameter, dessen Typ `Never` ist: Er kann keinen Wert annehmen, die Funktion
  ist nie aufrufbar.
- `:?` ohne passenden Zweig am Aufrufort: prüfen, ob es dafür schon eine Meldung gibt, sonst eine
  einführen.

Heute meldet stattdessen jede Verwendung (`Can not assign Never to Integer`), und gar nichts,
wenn der Parameter nur an `Any` geht:

```jul
# gemeint: 1 bis 9
inRange = (index: And(GreaterInteger(10) LessInteger(0))) =>
	log(index)        # heute nichts, danach nichts
	index.add(1)      # heute Fehler mit Never, danach nichts
# danach: eine Warnung an index
```

## Nicht Teil dieses Plans

- Die Laufzeitprüfung `getTypeError` in `runtime.ts`, sie prüft Werte, keine Typen.
- Neue Regeln, die heute unbekannte Fälle entscheiden, außer `lengthOf`.
- Die Struktur der Fehlermeldungen (`// TODO error struktur überdenken`).
