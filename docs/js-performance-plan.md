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
| `flatten` und `_combineObject` als Schleifen statt `flatMap`, `filter`, `concat` und `Object.assign` mit Spread | −10,7 % |

**`flatten` und `_combineObject`** (24.10.2026):
- **Fixture `list-concat`** (ms je 1 Mio. Aufrufe): `flattenShort` 192 auf 26, `concatLists` 54 auf 25, `mergeDictionaries` 67 auf 37. Beim Dictionary hilft vor allem, das erste Teil per Spread zu klonen statt per `Object.assign` in ein leeres Objekt.
- **yugioh-Match**, sechs abwechselnde Läufe mit identischem Compiler: Median 12 091 ms auf 10 801 ms. Jeder neue Lauf war schneller als jeder alte, das Spielergebnis blieb gleich.
- Das Tick-Profil hatte etwa 3 bis 4 % erwarten lassen. Unter Windows unterschätzt es Posten, die in V8-Builtins und C++ laufen.
- Die übrigen Listen-Builtins (`map`, `filter`, `some`, `every`, `findIndex`, `forEach`) inlinet TurboFan selbst, sie brauchen keinen Umbau.

**Gemessen, kein Gewinn:**
- `equal`, `not` und `getElement` direkt ausschreiben: V8 inlinet die Wrapper selbst.
- `add` mit Rest-Parametern und `reduce` gegen direktes `a + b`: im Mikrotest 25 gegen 14 ms je 2 Mio. Aufrufe, im Match bedeutungslos.
- Den Index nur bilden, wenn der Callback ihn nimmt (`fn.length`): langsamer, der Zugriff auf `length` kostet mehr als der BigInt.
- Records im Spread ausgeschriebenes Literal statt `{...s, turn}`: höchstens etwa 4 % am Match. Mit geschlossenen Record-Typen ist es semantisch zulässig, weil ein Wert keine weiteren Felder mit Wert haben darf, der Gewinn bleibt aber klein.
- Stufe 1 der In-place-Mutation (frische lokale Werte): nur 0,2 % der kopierten Felder.

## Profil

Tick-Profil (`--prof`), aufgenommen am 24.10.2026 mit Node 24.19 auf yugioh `cb16121`. Gemessen wurde `node out-bench/bundle.js 1 lookahead greedy`. Unter Windows kamen nur etwa 1000 Ticks zustande, die Anteile passen aber zum früheren Profil mit 11,6 Mio. Ticks.

| Anteil | Posten | Ursache |
|---|---|---|
| etwa 10,5 % | `LoadIC_Megamorphic`, `LoadICTrampoline_Megamorphic` | Objekte desselben Typs in vielen Hidden Classes, siehe unten |
| etwa 8 % | `CreateDataProperty`, `CloneObjectIC(_Slow)`, `DefineNamedOwnIC` | Spread-Kopien in Zustandsupdates. Den langsamen Pfad wählt V8 auch wegen der wechselnden Formen. |
| etwa 4,5 % | `ArrayPrototypeFlatMap`, `FlattenIntoArrayWithoutMapFn` | `flatten` in der Runtime, inzwischen behoben (siehe oben) |
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

1. **Stabile Objektformen: im Prototyp etwa −24 % im yugioh-Match.**
   - **Idee:** Ein Literal nennt jedes Feld ohne `?` (auch als `b = []`), nur `b?: X` darf fehlen. Alle Werte eines Typs haben dieselbe Hidden Class, ein überschreibender Spread erhält sie. Das alphabetische Sortieren der Schlüssel und das Ausschreiben der Spreads im Emitter brachten im Match nichts (gemessen, verworfen). Gewonnen hat die Migration selbst: `GameCard` und `GameState` haben immer alle Felder.
   - **Prototyp** (inzwischen entfernt) hinter `JUL_STABLE_SHAPES=1` (noch Typreihenfolge mit Auffüllen, für die Form gleichwertig), Fixture `object-shapes.jul`: `attackRound` 1350 auf 365 ms, yugioh-Match 166 bis 175 s auf 126 bis 137 s bei gleichem Ergebnis.
   - **Voraussetzung:** die Syntax `b?: X` und die strenge Prüfung fehlender Felder, auch für JSON. Das macht nebenbei JSON-`null` gegen fehlenden Schlüssel ausdrückbar.
   - Ausgearbeitet mit Messungen und Schritten in [backlog/stabile-objektformen.md](backlog/stabile-objektformen.md).
2. **Branches ohne sofort aufgerufene Arrows: geschätzt 1 bis 3 %.**
   - Heute erzeugt jeder Branch `(() => { return x })()`, und ein Argument ohne Referenz wird zu `((_arg) => …)(y)`.
   - Besteht ein Branch nur aus einem Ausdruck, kommt dieser direkt in die `?:`-Kette. An Statement-Position wird daraus `if`/`else` mit Blöcken.
   - TurboFan inlinet die Arrows im optimierten Code meist ohnehin. Der Gewinn liegt in der Aufwärmphase, bei den Closure-Allokationen und in der Codegröße.
   - Fixture: `branching`.
3. **In-place für den Akkumulator von `aggregate`: geschätzt 1 bis 3 %.**
   - Den Startwert einmal kopieren, danach in-place weiterarbeiten. Das gilt, solange der Callback den Akkumulator nur als Quelle von `setElement`, `setField` oder Spread verwendet oder unverändert zurückgibt.
   - Aus `setElement` in der Schleife wird so O(n) statt O(n²). Größte Stelle: `accumulator.setElement(gameCardId newCard)` in `game-logic.jul`.
   - Entwurf und Absicherung: [backlog/inplace-mutationen.md](backlog/inplace-mutationen.md). Stufe 2 dort (Besitz über Funktionsgrenzen) nur, wenn die Spreads aus Parametern nach Punkt 1 noch oben im Profil stehen.
   - Fixture: `record-update.jul`.
4. **Konstante Literale aus Funktionen herausziehen: höchstens etwa 1 %.**
   - Beispiel: `getController` baut bei jedem Aufruf ein neues `fieldQuery`-Objekt.
   - **Haken:** `equal` vergleicht mit `===`, die Identität ist also beobachtbar. Zwei Aufrufe lieferten danach dasselbe Objekt.
5. **`params` der Builtins entfernen.** Rund 540 `_createFunction`-Aufrufe in `runtime.ts`, die Vorbedingungen stehen im `TODO`. Betrifft nur Ladezeit und Bundle-Größe, im Lauf ist kein Gewinn zu erwarten.

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
