# Plan: assume unter `jul test` prüfen

Umgesetzt am 2026-11-03. Setzt den Teil „throw bei violated assume“ aus dem TODO-Punkt „debug mode“
um. Type Guards (der zweite Teil des Punkts) sind nicht Teil dieses Plans, nutzen aber denselben
Schalter.

Stand in yugioh nach der Umsetzung: 283 von 359 Tests rot, zwei Testdateien lassen sich nicht laden
(`game-logic.test.jul`, `invariants.test.jul`). 157 der roten Tests gehen auf eine Stelle zurück,
`game-logic.jul:190` (`gameCard/effect` ist leer, behauptet ist `CardEffect`). Die Kosten von +8 %
lassen sich erst wieder messen, wenn die Tests grün sind, ein Bruch bricht den Test vorher ab.

## Ziel

`assume(value Type)` bleibt im normalen Build die ungeprüfte Identität. Unter `jul test` prüft jeder
`assume`-Aufruf, den der Lauf erreicht, ob der Wert die Behauptung erfüllt. Das gilt in den
`*.test.jul` und in jeder Datei, die sie importieren. Ein Bruch lässt den laufenden Test
fehlschlagen, mit eigener Meldung und Stelle:

```
✗ legal inputs after summon (legal-inputs.test.jul:105:1)
    assume violated: [] is not GameCardId (legal-inputs.test.jul:108:9)
```

## Entscheidungen

1. **Fehlschlagen, nicht überspringen.** `assume` ist ein Cast, kein Filter wie in JUnit oder
   Hypothesis. Ein verletzter Cast heißt, dass der Code oder der Testaufbau falsch ist.
2. **Nur unter `jul test`.** `compileProject` emittiert unverändert, der Runtime-Bench und die
   Ausgabe in yugioh bleiben gleich. Ein Debug-Modus für normale Builds kommt später und nutzt
   denselben Emitter-Schalter.
3. **Die Prüfung ändert keinen Wert.** Die Prüfung gibt den Wert unverändert zurück oder wirft. Ein
   Test, der mit Prüfung grün ist, wäre es auch ohne.
4. **Geprüft wird nur, was der Checker nicht schon weiß.** Der Emitter vertraut dem statischen Typ
   des Werts, wie beim Branch-Dispatch von `?` (`branch-dispatch.ts`). Zur Laufzeit wird nur noch
   entschieden, welcher der laut Typ möglichen Fälle vorliegt. Bei `assume(x GameCard)` mit `x:
   Or([] GameCard)` ist das `x !== undefined`. Je `assume` gibt es drei Ergebnisse:
   - **Keine Prüfung**, wenn der statische Typ schon passt. Das deckt JUL2503 ab, aber auch ein
     verbreitertes Literal wie `assume(5 Integer)`, für das JUL2503 absichtlich schweigt.
   - **Billiger Test** (Laufzeitart, Literal, unterscheidendes Feld, Grenze), wenn `getBranchStep`
     die Glieder des statischen Typs sauber in „passt“ und „passt nicht“ teilt.
   - **Volle Prüfung** mit `_isOfType` sonst, vor allem bei einem Wert vom Typ `Any`. Sie entfällt,
     wenn der Zieltyp `Any` ist oder von einem Parameter abhängt (`parameterReference`, z.B.
     `assume(1 TypeOf(values)/ElementType)`). Dessen emittierter Ausdruck ist zur Laufzeit
     vermutlich kein gültiger Typ, weil der Runtime-Wert von `TypeOf` kein Feld `ElementType` hat.
     Das sichert ein Emitter-Test ab, bevor die Regel steht. Funktionstypen prüft `_isOfType` nur
     als „ist eine Funktion“. Die öffentliche Doku nennt beide Grenzen.

   Folge: Erfüllt ein Wert schon seinen statischen Typ nicht (eine Lücke im Checker, falsche Daten
   aus JS-Interop), sieht das der billige Test nicht. Das ist gewollt: Geprüft wird die Behauptung
   des `assume`, nicht die Korrektheit des Checkers. Die tiefe Prüfung im Prototyp hat solche Fälle
   gefunden (siehe Offene Fragen, Punkt 1).
5. **`assume` darf nur direkt aufgerufen werden**, wie `test` (JUL2704) und `import` (JUL3140).
   Ein weitergereichtes `assume` (`f = assume`, `list.map(assume)`) erreicht den Sonderfall im
   Emitter nicht und würde unter `jul test` nie geprüft. Neuer Fehlercode **JUL2504
   `assumeNotCalled`**, Schwere `error`, neben JUL2503. In yugioh gibt es keine solche Stelle
   (gesucht nach `= assume`, `(assume)`, `map(assume`), eine Migration ist also nicht nötig. Die
   Färbung als Keyword in Grammatik und Semantic Tokens ist schon umgesetzt.
6. **Ohne Schalter.** `jul test` prüft immer. Heute bricht die Prüfung in yugioh an 126 Stellen
   (siehe Messung), die betroffenen Tests sind danach rot, bis die Stellen in yugioh repariert sind.
7. **Kostenschwelle: 20 %** mehr Testzeit in yugioh. Gemessen sind +8 %.

## Messung (erledigt, 2026-11-03)

Wegwerf-Prototyp (nicht im Repo), gemessen in yugioh mit 405 Tests, reine Testzeit ohne den
Schritt „compiling“, je drei Läufe, Streuung höchstens ±1 s bei der tiefen Prüfung, sonst ±0,05 s.

| Variante | Testzeit | gegenüber ohne |
|---|---|---|
| ohne Prüfung | 2,3 s | — |
| tiefe Prüfung bei jedem Aufruf | 49,3 s | ×21 |
| dazu Cache über die Objektidentität (oberste Ebene) | 4,8 s | +110 % |
| billiger Test nach Entscheidung 4, sonst voll | 3,75 s | +64 % |
| dasselbe nach dem Umbau in `lookahead-ai.jul` | 2,51 s | **+8 %** |

- **Die tiefe Prüfung ist zu teuer.** 89 % der Kosten machte eine Stelle aus: `assume(gameCard
  GameCard)` in `getGameCard`, 9,8 Mio. Aufrufe zu je 4,2 µs. Der Wert ist dort `Or([] GameCard)`,
  behauptet wird nur „nicht Empty“.
- **Der billige Test kostet fast nichts.** Über ihn liefen 11,6 Mio. Aufrufe in zusammen etwa
  0,1 s. Von den emittierten `assume` in yugioh brauchen 4 keine Prüfung, 92 einen billigen Test und
  252 die volle.
- **Die übrige volle Prüfung hing an einer Stelle:** `assume(nodeGameState GameState)` in
  `lookahead-ai.jul`, 2452 Aufrufe zu je 0,5 ms. Ursache: Jul kennt keine Typparameter, der TS-Import
  macht `State` aus `memoizeSearch<State>` zu `Any` (yugioh-Finding 52). Umgebaut in yugioh: einmal
  der Funktionstyp an der Grenze (`memoizeGameStateSearch`), der Callback bekommt `GameState` aus
  dem erwarteten Parametertyp. Danach kostet die volle Prüfung insgesamt 0,12 s.
- **Brüche:** 126 Stellen mit mindestens einem verletzten `assume`.
  - Empty, wo der Typ es ausschließt, z.B. `game-logic.jul:190`: 301 364-mal ist `gameCard/effect`
    leer, behauptet ist `CardEffect`.
  - Geschlossene Records als Teilsicht, z.B. `scripted-ai.jul:87`: `assume(input [gameCardId:
    GameCardId])` auf eine vollständige `PlayerInput`.
  - Etwa 110 Stellen `assume(<szenario> Scenario)` in `scenarios.test.jul`, Ursache offen.

## Umsetzung

### 1. JUL2504 `assumeNotCalled`

Unabhängig vom Rest, kann zuerst kommen.

- `compiler-errors.ts`: `assumeNotCalled = 2504` mit Kommentar, Eintrag `{ type: 'semantic',
  severity: 'error' }`.
- `checker.ts`: im selben Zweig wie `testNotCalled` (bei der Referenz, `isBuiltIn &&
  !isCalledFunction(expression)`) die Meldung `'assume' can only be called directly.` Die Bedingung
  für `test` und `assume` wird zusammengelegt, nicht kopiert.
- Die Deklaration in `core-lib.jul` (`assume = nativeFunction(…)`) ist eine Definition, keine
  Referenz, und meldet nichts.
- `jul-homepage/docs/docs/documentation/error-codes.md`: Abschnitt für JUL2504 nach dem Muster von
  JUL2704.
- Checker-Snapshot und Zähler-Gate neu schreiben, ansehen, übernehmen.

### 2. Welcher Test (`src/checker/branch-dispatch.ts`)

```ts
export function getAssumeTest(valueType: CompileTimeType, targetType: CompileTimeType): BranchTest | undefined
```

- Zerlegt `valueType` mit `getMembers`, bildet aus `targetType` die Anforderung
  (`getRequirementForType`) und fragt `getBranchStep`. Bleibt kein Glied übrig, ist das Ergebnis
  `always`, also keine Prüfung. `undefined` heißt volle Prüfung.
- Lebt neben `getBranchDispatch`, weil es dieselbe Frage für einen Zweig stellt. Wie dort ruft es nur
  der Emitter auf, der Language Server zahlt nichts.
- Ob der Zieltyp von einem Parameter abhängt, beantwortet eine kleine Funktion in der Typalgebra
  (`containsParameterReference`), die nichts aus `checker.ts` importiert.

### 3. Runtime (`src/runtime/runtime.ts`)

```ts
export function _checkAssume(value, type, file, row, column, typeText): unknown
export function _checkAssumeTest(value, test: (value) => boolean, file, row, column, typeText): unknown
```

- Beide geben `value` zurück, wenn die Prüfung passt (`_isOfType` bzw. `test`). Sonst werfen sie
  einen `Error`. Wert und Stelle liest die Test-Runtime über `_takeAssumeViolation` aus der
  Modulvariable, nicht aus dem Error. Die Meldung baut die Test-Runtime, weil `valueToString` dort
  liegt.
- Die Stelle geht als einzelne Literale mit, nicht als Objekt: Ein Objektliteral würde bei jedem
  Aufruf neu angelegt, und die heißen Stellen laufen millionenfach. `typeText` ist der Quelltext des
  Typarguments.
- Der Bruch wird zusätzlich in einer Modulvariable abgelegt (`lastAssumeViolation`). Fängt
  JS-Interop-Code die Exception ab, schlägt der Test trotzdem fehl.
- Der billige Test kommt als Arrow mit (`(v) => v !== undefined`), so wie im Prototyp gemessen. Ein
  Inline-Ausdruck mit Hilfsvariable wäre die Alternative, falls die Messung nach der Umsetzung das
  nahelegt.
- Einfache Funktionsdeklarationen ohne Aufruf beim Laden, für das Tree-Shaking unbedenklich. Im
  normalen Build referenziert sie niemand. Danach `npm run check-runtime-purity`.

### 4. Test-Runtime (`src/runtime/test-runtime.ts`)

- `_runTests` setzt `lastAssumeViolation` vor jedem Test zurück und prüft die Variable nach dem
  Callback.
- `getTestFailureText` meldet einen Bruch als `assume violated: <Wert> is not <typeText>`, nicht als
  `threw …`. `failureLocation` ist die Stelle des `assume`, nicht die erste `.jul`-Stelle im Stack.
- Ein Bruch geht vor dem Ergebnis des Callbacks: Liefert der Test nach einem abgefangenen Bruch
  `true`, schlägt er trotzdem fehl.

### 5. Emitter (`src/compiler/emitter.ts`)

- Neuer Modus-Schalter `checkAssumes` (wie `useTypeInfo` und `emitSourcePositions` als Variable
  auf Modulebene), gesetzt über einen Parameter von `syntaxTreeToJsWithMappings`.
- Im `assume`-Zweig von `functionCallToJs`, für die Präfix- und die Listenform: Typ des Werts aus
  `getTypeInfo`, Zieltyp über `valueOf` aus dem Typ des Typarguments, dann `getAssumeTest`.
  - `always`: nur der Wert, wie heute.
  - ein anderer Test: `_checkAssumeTest(<value>, (_v) => <branchTestToJs(test, '_v')>, …)`.
  - `undefined`: `_checkAssume(<value>, <type>, …)`, außer der Zieltyp ist `Any` oder hängt von einem
    Parameter ab, dann nur der Wert.
- Beide Helfer kommen über `getUsedRuntimeNames` von selbst in den Runtime-Import, auch in Dateien,
  die keine Testdateien sind.

### 6. Compiler

- `emitToJs` bekommt eine Option `checkAssumes`. Nur `testProject` setzt sie, immer, `emitFile` nicht.
- `testProject` fängt Exceptions beim `import` einer Testdatei ab. Ein `assume` auf oberster Ebene
  eines importierten Moduls läuft beim Laden, und heute bräche ein Throw dort den ganzen Lauf ab.
  Gemeldet wird er als fehlgeschlagene Datei mit Meldung und Stelle, die übrigen Dateien laufen
  weiter, im Report als eigenes Ereignis `loadFailed`.
- Der Test Explorer in `vscode-jul-language-service` liest den Report: `loadFailed` dort anzeigen,
  sonst geht der Fehler im Explorer verloren.

### 7. Doku

- `jul-homepage/docs`: Bei `assume` steht, dass `jul test` die Behauptung prüft, mit
  Beispiel und den Grenzen (nur was der statische Typ offen lässt, Funktionstypen nur als Funktion,
  Typen, die von Parametern abhängen, gar nicht).
- Kommentar über `assume` in `core-lib.jul` anpassen.
- `jul-compiler/TODO`: Den Punkt „debug mode“ auf die Type Guards kürzen.

## Tests

Alle in der Mocha-Suite, ohne IO, ein `it` pro Fall.

- **Welcher Test** (`branch-dispatch.test.ts` oder neben den bestehenden Dispatch-Tests):
  `Or([] Integer)` mit Ziel `Integer` ergibt den Test auf `undefined`. `Integer` mit Ziel `Integer`
  ergibt `always`. `Any` mit Ziel `Integer` ergibt `undefined`. Eine Literal-Union `Or(1 2 3)` mit Ziel
  `Or(1 2)` ergibt einen Literal-Test. Eine Tagged Union ergibt einen Feld-Test.
- **Emitter** (`emitter.test.ts`, Code über `createInMemoryHost`):
  - Mit Schalter: `f = (a: Or([] Integer)) => assume(a Integer)` emittiert `_checkAssumeTest` mit
    dem Test auf `undefined`. `f = (a: Any) => assume(a Integer)` emittiert `_checkAssume`. Beides
    auch in der Präfixform.
  - Mit Schalter, ohne Prüfung: bewiesener Typ (`(a: Integer) => assume(a Integer)`), verbreitertes
    Literal (`assume(5 Integer)`), Zieltyp `Any`, Zieltyp abhängig vom Parameter
    (`(values: List(Any)) :> … => assume(1 TypeOf(values)/ElementType)`).
  - Ohne Schalter: dieselben Dateien emittieren nur den Wert, wie heute.
  - Mit Schalter in einer Datei, die keine Testdatei ist: der Helfer steht im Runtime-Import.
- **Runtime** (`runtime.test.ts`): Beide Helfer geben einen passenden Wert identisch zurück und
  werfen bei einem unpassenden einen Fehler mit Symbol, Wert und Stelle.
- **Test-Runtime** (`test-runtime.test.ts`): Ein Bruch im Callback ergibt `assume violated: …` mit
  der Stelle des `assume`. Ein abgefangener Bruch mit Ergebnis `true` schlägt trotzdem fehl. Der
  nächste Test startet ohne alten Bruch.
- **Gates**: Checker-Snapshot und Zähler-Gate ändern sich nur durch JUL2504.

## Messen nach der Umsetzung

- `jul test` in yugioh, drei Läufe, gegen drei Läufe mit dem Stand davor. Erwartet etwa +8 %,
  Grenze nach Entscheidung 7. Gemessen wird die Testzeit, auch wenn Tests rot sind: Ein Bruch bricht
  den Test ab und macht ihn eher kürzer, die Zahl ist also eine untere Schranke. Die Messung im
  Prototyp lief ohne Abbruch.
- `npm run bench-runtime -- --save --note "assume check"`: muss unverändert sein, der normale Build
  emittiert nichts Neues. Eine Abweichung hieße, dass der Schalter durchsickert.
- `npm run bench -- --save` im Compiler: nur zur Kontrolle, der Checker ändert sich kaum.

## Migration in yugioh

Keine Syntaxänderung, kein Migrationswerkzeug. Die 126 Stellen mit Bruch werden im bestehenden
Abbauplan von yugioh bearbeitet (`yugioh/docs/assume-plan.md`, ein `assume` je Durchgang, der Nutzer
entscheidet). Bis dahin sind die betroffenen Tests rot (Entscheidung 6), `jul test` liefert die
Liste. Funde für den Compiler kommen in `yugioh/docs/jul-findings.md`.

## Offene Fragen

1. **Werte, die ihren statischen Typ nicht erfüllen.** Die tiefe Prüfung im Prototyp fand sieben
   Stellen, an denen die Behauptung des `assume` stimmt, der Wert aber tief nicht zu seinem
   statischen Typ passt: `game-logic.jul:160` (`GameCard`, 243-mal) und sechs `GameHistory`-Stellen
   in `game-logic.test.jul`. Ursache offen: eine Lücke im Checker, eine Abweichung von `_isOfType`
   oder falsche Daten aus JS-Interop. Gehört nach der Untersuchung in `CHECKER-AUDIT.md` oder in die
   yugioh-Findings, nicht in diesen Plan.
2. **Später ein Schalter für normale Builds** (`jul-config.yaml`, z.B. `checkAssumes: true`)? Nicht in
   diesem Plan, der Emitter-Schalter ist dafür vorbereitet.

## Aufwand

Etwa anderthalb Tage:
- JUL2504: zwei Stunden.
- `getAssumeTest` und Emitter mit Tests: ein halber Tag.
- Runtime und Test-Runtime mit Tests: ein halber Tag.
- `loadFailed` mit Test Explorer und Doku: zwei Stunden.

Dazu die Messung. Der Abbau der Brüche in yugioh ist eigene Arbeit nach dem yugioh-Plan.
