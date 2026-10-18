# Plan: Laufzeit-Performance des JS-Backends

Entwurf, keine Entscheidung. Ziel: KI-Simulationen wie in `C:\Projects\privat\yugioh` schneller
machen, ohne WebAssembly. Das Profil der Lookahead-KI steht in
[backlog/profil-yugioh-lookahead.md](backlog/profil-yugioh-lookahead.md): Die Zeit steckt in
Objektallokation und Objektzugriffen, nicht in Zahlen. BigInt macht unter 1 % aus.

## Erledigt

- **Profilierung** (Phase 1). `--trace-gc` und `--heap-prof` wurden nicht gebraucht, die BigInt-Fixture
  entfällt, weil das V8-Profil BigInt schon als Nebensache zeigt.
- **Benannte Argumente als direkte Aufrufe, `params` nur wo nötig.** Entscheidung und Umsetzung in
  [backlog/typed-emission.md](backlog/typed-emission.md) (feste Argumentreihenfolge). Nur Branches,
  Typ-Köpfe und Parametertypen tragen noch `params`, alle anderen Funktionsliterale sind nackte Arrows.
  `_callFunction` und `assignArgs` gibt es nicht mehr.

| Messung | Ausgangslage | jetzt |
|---|---|---|
| `bench-runtime` `callbacks/countSmall` (ms je 1 Mio.) | 95 | 60 bis 62 |
| yugioh Match (3 Läufe, Median) | 7,74 s | 6,98 s (-9,8 %) |

- **Listenfunktionen mit Funktionsliteral als Schleife** (`exists`, `filter`, `map`, `filterMap`). Der Emitter
  schreibt den Aufruf als sofort aufgerufene Schleife an der Aufrufstelle aus: keine Callback-Closure, der
  Index nur, wenn das Literal ihn als zweiten Parameter nimmt (`inlinedListCallToJs`). Callbacks als Wert,
  mit Typ-Guard, Rest oder mehr als zwei Parametern bleiben Funktionsaufrufe. Gemessen im yugioh-Match
  (vier abwechselnde Läufe, Median): 7,68 s ohne, 6,79 s mit nur `exists` (-11,6 %), 6,48 s mit allen vier
  (-15,6 %). Fixture `list-search/containsBoth`: 50,8 auf 29,9 ms. `all`, `findFirst` und `aggregate` laufen
  über dasselbe Gerüst, brachten aber keinen messbaren Zusatzgewinn (Median 6,45 s gegen 6,47 s, vier
  abwechselnde Läufe), weil sie im Match selten sind.

## Offen, nach erwartetem Gewinn geordnet

Je Punkt: Erst die Fixture in `scripts/bench-runtime` auf dem ungeänderten Compiler messen und mit
`--save` protokollieren, dann die Änderung. Der yugioh-Bench streut um etwa 10 % und bestätigt danach nur,
dass der Gewinn im echten Lauf ankommt.

1. **Spread-Kopien in Zustandsupdates reduzieren.** Etwa 11 % im Profil (`CreateDataProperty`,
   `CloneObjectIC_Slow`), größter Aufrufer `declineOptionalEventTriggers`. Kandidaten: Updates im Emitter
   in-place, wenn der alte Wert nachweislich nicht mehr gelesen wird (letzte Verwendung, kein Alias),
   oder persistente Datenstrukturen für große Listen. Erst die Stellen analysieren, an denen die
   Kopien entstehen, und mit einem Test, dass Aliasing nie beobachtbar ist.
   Fixture: `record-update.jul` (`nextTurn`, `nextTwice`, Record mit 12 Feldern).
   **Obergrenze der Feld-Ausschreibung gemessen** (Mikro-Messung, 5 Mio. Updates, 12 Felder, zwei Formen im
   Umlauf): `{...s, turn}` 133 bis 155 ms, ausgeschriebenes Literal `{turn, phase: s.phase, ...}` 89 bis 92 ms,
   also etwa 40 % je Update. Auf die 11 % im yugioh-Profil angewandt wären das höchstens etwa 4 % am Match.
   Zusätzlich semantisch nicht sicher: Ein Wert darf mehr Felder haben als sein Typ nennt, das Ausschreiben
   würde sie verlieren. Nur mit dem Beweis, dass der Wert genau die Typfelder hat, zulässig. Daher nicht
   umgesetzt, bevor ein Weg gefunden ist, der Spread-Aufrufer ohne Typannahme beschleunigt.
2. **Megamorphe Feldzugriffe.** Etwa 9 % im Profil (`LoadIC_Megamorphic`), vor allem in
   `applyContinuousEffectsForPlayer`. Offen, ob der Emitter Objekte mit gleicher Feldreihenfolge und
   vollständigen Feldern erzeugen kann (stabile Hidden Classes).
   Fixture: `field-access.jul` (`unitScore`, Feld `hp` in vier Formen).
3. **Index nur bilden, wenn der Callback ihn nimmt: gemessen, kein Gewinn, zurückgenommen.** Umgesetzt war
   `callback.length === 1 ? callback(value) : callback(value, BigInt(index + 1))` in den elf HOFs von `runtime.ts`.
   Gemessen im yugioh-Match, abwechselnd gebaut: 7,1 bis 7,5 s ohne die Änderung, 7,6 bis 8,4 s mit ihr
   (zweite Variante mit einmal je Aufruf berechnetem `takesIndex`: 8,0 bis 9,3 s, unvollständig umgesetzt).
   Der BigInt je Element ist also billig, der Zugriff auf `fn.length` teuer (vermutlich ein Accessor auf
   Funktionsobjekten mit wechselnder Form). Fixture `callbacks.jul` (`sumWithIndex` gegen `sumWithoutIndex`)
   bleibt als Vergleich. Ein neuer Versuch bräuchte ein anderes Merkmal als `length`, etwa vom Emitter
   gesetzt, und ist nach diesem Ergebnis nicht aussichtsreich.
4. **Typgestützte Emission, Rest.** `_branch` mit mehreren Argumenten, wo korrekt ableitbar (im Profil
   1,8 Mio. Aufrufe je Match), und Aufrufe bekannter Builtins direkt auf die native Implementierung. Fixtures: `branching`, `named-arguments`.
5. **Worker-Parallelisierung der Simulationen.** Unabhängige Läufe auf `worker_threads` verteilen,
   unabhängig vom Compiler und vermutlich der größte Hebel für die Paare-Läufe. Braucht eine Entscheidung
   auf Sprachebene (Builtin, Library oder Tooling von außen). Zunächst als Mess-Experiment in
   `scripts/` ohne Sprachänderung: dieselbe kompilierte Funktion in N Workern.
6. **`params` der Builtins entfernen.** Rund 540 `_createFunction`-Aufrufe in `runtime.ts`, Vorbedingungen
   stehen im `TODO`. Nur Ladezeit und Bundle-Größe, kein Gewinn im Lauf erwartet.

**Zurückgestellt: Integer als `number`.** Das Profil hat die Annahme widerlegt (BigInt unter 1 %). Falls es
doch wieder aufkommt: größte Änderung der Liste (Emitter, Runtime, Gleichheit, Textausgabe, JSON und die
`§js§`-Blöcke der core-lib), mit kleinerem Radius nur dort, wo der Checker den Bereich beweisen kann
(Zusammenhang mit [backlog/integer-range.md](backlog/integer-range.md)).

**Wasm:** Die Entscheidung kommt nach den Punkten oben, mit den dann gemessenen Zahlen. Nach dem Profil ist
es für diese Last nicht indiziert, der Zeitanteil steckt nicht in Zahlen.

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
