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

## Wer aus der Prüfung etwas folgert

Stand der Analyse, Zeilen in `checker.ts` bzw. `branch-dispatch.ts`:

**Meldet Fehler**, braucht nur „passt nicht": Zuweisung (3628), Typ-Guard (3737), Argumente
(4035), Rückgabetyp (4267), Typ-Guard gegen `Type` (9496), Funktion erwartet (9524). Alle gehen
über `areArgsAssignableTo`, das noch einen String liefert.

**Folgert aus „kein Fehler"**, braucht „passt" und darf „unbekannt" nicht so lesen:
- `removeSubtypes` beim Normalisieren einer Union, geschützt über `hasReliableTypeError` und
  `isUnresolvedPlaceholderType`
- die Vereinfachung für Teilmengen in `createNormalizedIntersectionType`, geschützt über
  `hasReliableTypeError`
- `isNotAssignableTo`, genutzt von `typesOverlap` und den `Not`-Regeln, geschützt über
  `hasReliableTypeError`
- die Erreichbarkeit von Branches (3467), geschützt über `hasReliableTypeError`
- `containsAny` (5473), liest `hasReliableTypeError` direkt
- `isSubtype` in [branch-dispatch.ts](../src/checker/branch-dispatch.ts): war ungeschützt und wertete
  `!getTypeError(…)` als Teilmenge. Das ließ einen Laufzeittest weg, der nötig war:
  `?(x) [List(isEven)] => …` mit `x: Or(Text List(Integer))` wurde zu `typeof x !== 'string'`, und
  `[1 3]` lief in den ersten Branch. **Umgestellt** auf `isSubtypeOf`.

## Modell

Gefragt ist: Liegt jeder Wert der Quelle im Ziel?

- **yes:** bewiesen, jeder Wert liegt darin.
- **no:** bewiesen, mindestens ein Wert liegt nicht darin.
- **unknown:** nicht entscheidbar.

Gefolgert wird nur aus yes. Gemeldet wird no als Fehler und unknown als Warnung (siehe Abschnitt
„Warnung bei unknown"): Was der Checker nicht beweisen kann, kann zur Laufzeit schiefgehen.

Der Kern ist `isTypeAssignable` (umgesetzt, siehe Stand), `getTypeError` ist eine Hülle darum:

```ts
type TypeAssignability =
	| { assignable: false; error: TypeError; }                // no
	| { assignable: true; }                                   // yes
	| { assignable: undefined; warning: TypeError; };         // unknown, warning noch anzulegen

function isTypeAssignable(prefixArgumentType, argumentsType, targetType): TypeAssignability;

// Melden (Prinzip Freiheit): nur ein sicheres Nein ist ein Fehler.
getTypeError = (…) => assignability.assignable === false ? assignability.error : undefined;
// Folgern: nur ein sicheres Ja ist eine Teilmenge (isSubtypeOf, angelegt), nur ein sicheres Nein
// keine (isNotSubtypeOf, noch anzulegen).
isSubtypeOf = (…) => assignability.assignable === true;
isNotSubtypeOf = (…) => assignability.assignable === false;
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

### Phase 2: yes einordnen (begonnen)

Was schon yes liefert, steht im Stand. Offen, jeweils heute unknown, obwohl sich yes zeigen ließe:

- **Verknüpfungen, die noch zweiwertig über `getTypeError` laufen:** Quelle `And` (ein Choice yes),
  Quelle `Or`, Ziel `And`, Ziel `Or` (Best-Match-Meldung beibehalten), die exakte Regel
  `And(A Not(B))` (liefert bei Erfolg unknown, ist aber exakt, also yes). Die Dictionary-Felder
  sind umgestellt (`isTypeAssignableForDictionaryLiteral`, `isTypeAssignableForField`,
  `joinFieldAssignabilities`): ein fehlendes Feld in einem unvollständigen Dictionary ist
  unknown, ein fehlendes optionales Feld yes.
- **Einzelfälle:** Ziel `booleanLiteral` bei gleichem Literal liefert unknown, die anderen
  Literale yes; die Parameterprüfungen enden immer mit unknown, auch wenn jeder Parameter yes war;
  ein Prädikat als Typ (Ziel `Type`) liefert unknown.
- **Rekursive Aliase:** Das Paar auf dem Stapel (`aliasComparisonsInProgress`) liefert yes statt
  unknown, siehe Einordnung.
- Nach jedem Switch die Suite. Solange die Folgernden noch über `hasReliableTypeError` gehen,
  ändert sich das Verhalten nicht.
- `Never` als Quelle wird yes (siehe Abschnitt `Never`).
- **Eigener Schritt: `Not` als Quelle genau machen.** `Not(A)` liegt genau dann in `T`, wenn `T`
  alles außer `A` abdeckt: yes bei `Any`, bei `Not(B)` mit `B ⊆ A` (gibt es schon) und bei einem
  `Or`, das `A` und den Rest enthält; sonst no. Die exakten Regeln für `And(A Not(B))` bleiben.
  Das ändert Verhalten: Bisher fehlerfreier Code wie `(a: Not(0)) => a.add(1)` meldet jetzt einen
  Fehler. Bricht dabei Code, in dem die Inferenz ein `Not` ohne seinen Grundtyp liefert, ist die
  Inferenz zu korrigieren, nicht die Regel. Abnahme: Suite, Snapshot, yugioh, jul-examples.

### Phase 3: Folgernde umstellen

- `removeSubtypes`, Vereinfachung für Teilmengen, `isNotAssignableTo`, Erreichbarkeit der
  Branches und `containsAny` fragen `isSubtypeOf` bzw. `isNotSubtypeOf` statt `!getTypeError(…)`
  plus `hasReliableTypeError`. `branch-dispatch.ts` ist schon umgestellt.
- Vorsicht: Wo Phase 2 eine Teilmenge noch nicht als yes einordnet, normalisiert der Checker nach
  der Umstellung schwächer. So hat sich das schon bei `branch-dispatch.ts` gezeigt (Dictionaries).
  Deshalb Phase 2 möglichst vorher abschließen.
- `hasReliableTypeError` entfällt. Wo `isUnresolvedPlaceholderType` nur deshalb danebensteht,
  entfällt es ebenfalls.
- Hier ändert sich Verhalten: Wo ein Fall fälschlich als unknown eingeordnet blieb, normalisiert
  der Checker schwächer. Das zeigt sich im Snapshot als längere Typen und ist dann in Phase 2
  nachzutragen.

### Phase 4: `lengthOf` und die core-lib

- Zielregel für `lengthOf` wie oben.
- `forEach`, `repeat` und `range` schreiben die obere Grenze als `Or(end LessInteger(end))`.
  Der Abschnitt „Ausnahme" in [number-ranges.md](number-ranges.md) und der TODO-Eintrag entfallen.

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
