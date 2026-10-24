# Plan: Laufzeit-Performance des JS-Backends

Entwurf, keine Entscheidung. Ziel: möglichst schnelles JS aus unverändertem JUL-Code, ohne neue Syntax,
gemessen an den KI-Simulationen in `C:\Projects\privat\yugioh`. Das erste Profil der Lookahead-KI steht in
[backlog/profil-yugioh-lookahead.md](backlog/profil-yugioh-lookahead.md).

## Erledigt

| Schritt | Gewinn im yugioh-Match |
|---|---|
| Benannte Argumente als direkte Aufrufe, `params` nur wo die Laufzeit sie liest ([backlog/typed-emission.md](backlog/typed-emission.md)) | −9,8 % |
| Branching-Diskriminatoren statt `_branch` mit vollem Typcheck (ebenda) | Fixtures um Faktor 500 bis 1000 |
| Listenfunktionen mit Funktionsliteral als Schleife an der Aufrufstelle (`inlinedListCallToJs`: `exists`, `filter`, `map`, `filterMap`, `all`, `findFirst`, `aggregate`) | −15,6 % |
| History aus der Spiellogik entfernt (in yugioh, ohne Compiler-Änderung, [backlog/inplace-mutationen.md](backlog/inplace-mutationen.md)) | −5,6 % |

**Gemessen, kein Gewinn:**
- `equal`, `not` und `getElement` direkt ausschreiben: V8 inlinet die Wrapper selbst.
- `add` mit Rest-Parametern und `reduce` gegen direktes `a + b`: im Mikrotest 25 gegen 14 ms je 2 Mio. Aufrufe, im Match bedeutungslos.
- Den Index nur bilden, wenn der Callback ihn nimmt (`fn.length`): langsamer, der Zugriff auf `length` kostet mehr als der BigInt.
- Records im Spread ausgeschriebenes Literal statt `{...s, turn}`: höchstens etwa 4 % am Match und semantisch falsch, weil ein Wert mehr Felder haben darf, als sein Typ nennt.
- Stufe 1 der In-place-Mutation (frische lokale Werte): nur 0,2 % der kopierten Felder.

## Profil

Tick-Profil (`--prof`), aufgenommen am 24.10.2026 mit Node 24.19 auf yugioh `cb16121`. Gemessen wurde `node out-bench/bundle.js 1 lookahead greedy`. Unter Windows kamen nur etwa 1000 Ticks zustande, die Anteile passen aber zum früheren Profil mit 11,6 Mio. Ticks.

| Anteil | Posten | Ursache |
|---|---|---|
| etwa 10,5 % | `LoadIC_Megamorphic`, `LoadICTrampoline_Megamorphic` | Objekte desselben Typs in vielen Hidden Classes, siehe unten |
| etwa 8 % | `CreateDataProperty`, `CloneObjectIC(_Slow)`, `DefineNamedOwnIC` | Spread-Kopien in Zustandsupdates. Den langsamen Pfad wählt V8 auch wegen der wechselnden Formen. |
| etwa 4,5 % | `ArrayPrototypeFlatMap`, `FlattenIntoArrayWithoutMapFn` | `flatten` in der Runtime (`values.flatMap(...)`), in V8 ein C++-Pfad. Aufrufer: `getController`, `evaluateCardQuery`, Synchro-Materialien. |
| etwa 5,4 % | GC | |
| etwa 2,4 % | `StrictEqual` | `===` auf BigInt |
| etwa 2,1 % | `getSearchKey` | Schlüssel der Transpositionstabelle in der KI, Nutzercode |
| etwa 1,4 % | `FastNewClosure` | Branches als sofort aufgerufene Arrows, verbliebene Callbacks |

**Hidden Classes** (`--log-ic` sowie Zählung der Schlüsselfolgen am Eingang von `applyToGameState`):
- **GameState** hat 78 verschiedene Schlüsselfolgen, Zugriffsstellen auf `boards` und `turnPlayer` sehen je 87 Maps.
- **Karten** haben 23 Formen mit 5 bis 18 Feldern.
- **Ursache** ist nicht die Feldreihenfolge in den Literalen. Optionale Felder fehlen in manchen Objekten und kommen in anderen per Spread hinzu, in wechselnder Reihenfolge. Bei GameState betrifft das `resolvingEffectStepIndex`, `winner` und `chain`, bei Karten `face`, `battlePosition`, `def`, `level` und `effectsNegated`.
- **Am häufigsten megamorph** sind die Zugriffe auf `boards`, `priority`, `chain`, `turnPlayer`, `cards` und `pendingSummon`.

## Offen, nach erwartetem Gewinn geordnet

Je Punkt erst die Fixture in `scripts/bench-runtime` auf dem ungeänderten Compiler messen und mit
`--save` protokollieren, dann ändern. Der yugioh-Bench streut um etwa 10 % und bestätigt danach nur,
dass der Gewinn im echten Lauf ankommt. Gewinne unter etwa 5 % lassen sich dort nur mit mehreren
abwechselnden Läufen nachweisen.

1. **Stabile Objektformen: geschätzt 5 bis 12 %.**
   - **Idee:** Der Emitter schreibt jedes Dictionary-Literal mit bekanntem Typ vollständig und in Typreihenfolge aus und setzt fehlende optionale Felder auf `undefined`. Ein späterer Spread überschreibt dann nur noch und hängt nichts an, die Hidden Class bleibt gleich.
   - **Gewinn:** Die megamorphen Zugriffe werden weitgehend monomorph. Die Spread-Kopien können den schnellen Pfad von `CloneObjectIC` nutzen.
   - **Haken 1, die Semantik:** Heute unterscheidet `deepEqual` zwischen „Feld fehlt“ und „Feld ist Empty“ (`isDeepEqual` in `runtime.ts`). Dasselbe gilt für alles, was über Schlüssel iteriert: `mapDictionary`, `findField`, `findKey` und die Textausgabe. Nötig ist also die Sprachentscheidung, dass ein Feld mit Empty einem fehlenden gleichsteht. Danach überspringen diese Builtins `undefined`.
   - **Haken 2, nicht normierte Quellen:** Objekte aus JSON- und TS-Importen sowie aus `setField` mit neuem Schlüssel bleiben unnormiert. Ein Rest an Polymorphie bleibt.
   - **Haken 3, größere Objekte:** Karten hätten immer 18 statt 5 bis 11 Felder, jede Kopie wird etwas teurer.
   - **Vorgehen:** erst ein Prototyp hinter einem Env-Flag im Emitter (wie `JUL_COUNT_COPIES`), der die Spanne im Match misst. Die Semantik wird erst danach entschieden.
   - Fixture: `field-access.jul` (`unitScore`, Feld `hp` in vier Formen).
2. **Langsame Array-Builtins in der Runtime ersetzen: geschätzt 3 bis 4 %.**
   - `flatten` als Schleife statt `flatMap`. Mikrotest mit 2 Mio. Aufrufen auf kleinen Listen: 250 ms gegen 60 ms.
   - `_combineObject` (Verkettung `[...a ...b]`) ohne Rest-Parameter, `filter` und `concat`. Mikrotest für zwei Listen: 160 ms gegen 45 ms. Das Gewicht im Match ist klein. Ist der Typ als List bekannt, kann der Emitter direkt eine Listenverkettung schreiben.
   - Die übrigen Builtins, die yugioh importiert, auf dieselben Muster durchsehen (`flatMap`, `reduce`, `concat` mit Spread, `Object.assign`).
   - Reine Runtime-Änderung ohne Semantikfrage.
3. **Branches ohne sofort aufgerufene Arrows: geschätzt 1 bis 3 %.**
   - Heute erzeugt jeder Branch `(() => { return x })()`, und ein Argument ohne Referenz wird zu `((_arg) => …)(y)`.
   - Besteht ein Branch nur aus einem Ausdruck, kommt dieser direkt in die `?:`-Kette. An Statement-Position wird daraus `if`/`else` mit Blöcken.
   - TurboFan inlinet die Arrows im optimierten Code meist ohnehin. Der Gewinn liegt in der Aufwärmphase, bei den Closure-Allokationen und in der Codegröße.
   - Fixture: `branching`.
4. **In-place für den Akkumulator von `aggregate`: geschätzt 1 bis 3 %.**
   - Den Startwert einmal kopieren, danach in-place weiterarbeiten. Das gilt, solange der Callback den Akkumulator nur als Quelle von `setElement`, `setField` oder Spread verwendet oder unverändert zurückgibt.
   - Aus `setElement` in der Schleife wird so O(n) statt O(n²). Größte Stelle: `accumulator.setElement(gameCardId newCard)` in `game-logic.jul`.
   - Entwurf und Absicherung: [backlog/inplace-mutationen.md](backlog/inplace-mutationen.md). Stufe 2 dort (Besitz über Funktionsgrenzen) nur, wenn die Spreads aus Parametern nach Punkt 1 noch oben im Profil stehen.
   - Fixture: `record-update.jul`.
5. **Konstante Literale aus Funktionen herausziehen: höchstens etwa 1 %.**
   - Beispiel: `getController` baut bei jedem Aufruf ein neues `fieldQuery`-Objekt.
   - **Haken:** `equal` vergleicht mit `===`, die Identität ist also beobachtbar. Zwei Aufrufe lieferten danach dasselbe Objekt.
6. **`params` der Builtins entfernen.** Rund 540 `_createFunction`-Aufrufe in `runtime.ts`, die Vorbedingungen stehen im `TODO`. Betrifft nur Ladezeit und Bundle-Größe, im Lauf ist kein Gewinn zu erwarten.

**Außerhalb des Emitters:**
- **Parallelisierung:** Die Paare eines Matches sind je Seed unabhängig. Auf mehrere Prozesse oder `worker_threads` verteilt, ist das der größte Hebel für die Paare-Läufe (22 Kerne). Ein erster Schritt braucht keine Sprachänderung: mehrere Prozesse mit getrennten Seed-Bereichen, gestartet aus `measure-ai.js`.
- **`getSearchKey`** in der KI baut einen Text als Schlüssel, das ist Nutzercode.

**Zurückgestellt: Integer als `number`.**
- Würde `StrictEqual` und die BigInt-Arithmetik treffen, zusammen geschätzt 3 bis 5 %.
- Größte Änderung der Liste: Emitter, Runtime, Gleichheit, Textausgabe, JSON und die `§js§`-Blöcke der core-lib.
- Mit kleinerem Radius ginge es nur dort, wo der Checker den Wertebereich beweisen kann (Zusammenhang mit [backlog/integer-range.md](backlog/integer-range.md)).

**Kein Gewinn zu erwarten:**
- `?.['x']` durch `.x` ersetzen, wo der Typ nicht optional ist: V8 faltet die Prüfung.
- Minifizierung.
- Wasm: Die Zeit steckt in Objektformen und Kopien, nicht in Zahlen.

## Grenzen der Fixtures

`record-update` und `field-access` liefern nur einen Wert aus dem neuen Record, V8 kann die Kopie daher
teilweise wegoptimieren. Zeigt sich bei einer Änderung dort kein Effekt, aber im yugioh-Profil schon, ist
die Fixture zu optimistisch und bekommt ein Ergebnis, das den Record behält (`select` in
`bench-runtime.ts`). `countAbove` hat 100 Elemente je Aufruf und zeigt keine Closure-Kosten, dafür gibt es
`countSmall`.

## Abnahme je Schritt

`node --run test`, `npm run typecheck`, `npm run bench` und `npm run bench-runtime` mit `--save`,
`npm run check-runtime-purity` nach Änderungen an `runtime.ts`, yugioh bauen und `jul test`
(ungepinnter Compiler, bricht bei Änderungen sofort sichtbar), danach den yugioh-Bench.
