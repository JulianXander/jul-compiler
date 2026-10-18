# Plan: Laufzeit-Performance des JS-Backends (Profilierung und billige Gewinne)

Entwurf, keine Entscheidung. Ziel: KI-Simulationen wie in `C:\Projects\privat\yugioh` schneller
machen, ohne WebAssembly. Ob Wasm danach noch lohnt, entscheidet erst das Profil
(siehe Ausgangslage unten).

## Ausgangslage

- Integer sind `bigint`, der Emitter schreibt Literale als `1n` (`emitter.ts`, `case 'integer'`).
- `_branch` und `_callFunction` prüfen strukturell zur Laufzeit. Für Branching mit einem Argument
  gibt es schon typgestützte Diskriminatoren (`checker/branch-dispatch.ts`), benannte Argumente
  sind teils noch offen ([typed-emission.md](backlog/typed-emission.md)).
- Selbstaufrufe in Tail-Position werden zu `while (true)` (`analyzeTailCalls`).
- Es gibt `npm run bench-runtime` (Fixtures in `scripts/bench-runtime`: branching, deep-equal, json,
  named-arguments, recursion). Es gibt noch keine Fixture für Integer-Arithmetik, Listen-Updates
  oder Dictionary-Updates, und keine für ein echtes Simulationsprogramm.

## Phase 1: Profilierung

Ziel ist eine Rangliste der heißen Stellen mit Anteilen, nicht schon ein Umbau.

1. **Repräsentative Last festlegen.** Einen yugioh-Lauf wählen (KI-Simulation, mehrere Sekunden,
   deterministisch). Falls er sich nicht per CLI starten lässt, ein kleines Skript in
   `scripts/` schreiben, das ihn über `loadFile` + Emitter lädt wie `bench-runtime.ts`.
2. **Baseline messen.** Wall-Clock mehrfach (Median), mit `--save --note "baseline"` in die
   bestehenden Bench-Logs, wo es passt.
3. **CPU-Profil.** `node --cpu-prof --cpu-prof-interval 200` auf den erzeugten Code
   (emittiert gegen `src/runtime/runtime.ts` oder gegen `out`). Auswertung nach Self-Time je
   Funktion, aufgeteilt in: Nutzercode, `_branch`/`_callFunction`/`assignArgs`/`getTypeError`,
   BigInt-Operationen, Kollektionsoperationen (`map`, `slice`, Spread, Copy), GC.
4. **GC und Allokation getrennt betrachten.** `--trace-gc` (Anzahl und Pausen) und optional
   `--heap-prof`. Das trennt „zu viel Rechnen" von „zu viel Allokieren".
5. **BigInt isolieren.** Eine Fixture `integer-arithmetic.jul` (Schleife mit `add`, `subtract`,
   `multiply`, Vergleich) und dieselbe Schleife in handgeschriebenem JS mit `number` als Obergrenze.
   Das beziffert, was die Zahlendarstellung maximal bringen kann.
6. **Ergebnis festhalten.** Ein kurzes Dokument (Profil-Tabelle, Hypothesen bestätigt/widerlegt) in
   `docs/backlog/`. Die Reihenfolge von Phase 2 richtet sich danach.

Abbruchkriterium: Dominiert eine Stelle mit über etwa 30 %, zuerst diese angehen. Liegt der Hauptteil
in handgeschriebenem numerischem Kern ohne Allokation, ist das die Datenlage für eine spätere
Wasm-Prüfung.

## Phase 2: Billige Gewinne (Reihenfolge nach Profil, Kandidaten)

Jeder Punkt einzeln: Bench vorher und nachher mit `--save`, Snapshot- und Zähler-Gate ansehen,
`check-runtime-purity` nach Änderungen an `runtime.ts`, yugioh gegenprüfen.

### A. Typgestützte Emission ausbauen (bereits begonnen)

- Restliche Fälle aus [typed-emission.md](backlog/typed-emission.md): benannte Argumente als direkte Aufrufe
  statt Dictionary + `assignArgs`, Branching mit mehreren Argumenten, wo korrekt ableitbar.
- Aufrufe bekannter Builtins mit statisch bekannten Typen direkt auf die native Implementierung,
  ohne `_callFunction`.
- Messbar mit den vorhandenen Fixtures `branching` und `named-arguments`.

### B. Integer als `number`, wenn sicher

- Idee: kleine Integer als JS-`number`, Überlauf fällt auf `bigint`. Das ist die größte Änderung
  der Liste und berührt Emitter, Runtime, Gleichheit, Textausgabe, JSON und die `nativeFunction`-
  Schnittstellen (`§js§`-Blöcke in der core-lib sehen sonst zwei Darstellungen).
- Vorab prüfen (Phase 1, Schritt 5), ob der Gewinn die Komplexität trägt.
- Alternative mit kleinerem Radius: nur dort `number` verwenden, wo der Checker den Bereich
  beweisen kann (Zusammenhang mit [integer-range.md](backlog/integer-range.md) und den vorhandenen
  Grenzen `GreaterInteger`/`LessInteger`), etwa Schleifenzähler und Indizes.
- Entscheidung erst nach Messung, gegebenenfalls als eigenes Designdokument.

### C. Kopien bei Updates vermeiden

- Profil zeigt, ob Listen- und Dictionary-Updates (Spread, `slice`, `map`) die Allokation treiben.
- Kandidaten: Updates im Emitter in-place, wenn der alte Wert nachweislich nicht mehr gelesen
  wird (letzte Verwendung, kein Alias), oder persistente Datenstrukturen für große Listen.
- Erst nach der Analyse, wo die Kopien entstehen, und mit einem Test, dass Aliasing nie
  beobachtbar ist.

### D. Laufzeitprüfungen weglassen, wo der Typ sie erübrigt

- Der Emitter vertraut den statischen Typen (Entscheidung in `typed-emission.md`). Offene Stellen
  im Profil suchen: `getTypeError`-Aufrufe in heißen Pfaden, `_createFunction`-Wrapper ohne Bedarf.

### E. Parallelisierung der Simulationen

- Unabhängige Simulationsläufe auf `worker_threads` verteilen. Das ist unabhängig vom Compiler und
  oft der größte Hebel. Braucht eine Entscheidung auf Sprachebene: Wie bekommt ein JUL-Programm
  Zugang zu Workern (Builtin, Library oder nur Tooling von außen)? Zunächst als reines
  Mess-Experiment in `scripts/`, ohne Sprachänderung: dieselbe kompilierte Funktion in N Workern.

## Runtime-Benches je Schritt

Der yugioh-Bench streut um etwa 10 % und ist größer als der erwartete Gewinn einzelner Schritte.
Deshalb gilt je Phase-2-Punkt: Erst die Fixture in `scripts/bench-runtime`, gemessen auf dem
ungeänderten Compiler und mit `--save` protokolliert, dann die Änderung. Der yugioh-Bench bestätigt
danach nur, dass der Gewinn im echten Lauf ankommt.

| Punkt | Fixture | Stand |
|---|---|---|
| `params` hochziehen oder weglassen (D) | `callbacks.jul`: `countSmall` (kurze Liste, zwei Closures je Aufruf); `countAbove` hat 100 Elemente je Aufruf und zeigt den Effekt nicht | **umgesetzt** |
| Index nur bei Bedarf (HOFs) | `callbacks.jul`: `sumWithIndex` gegen `sumWithoutIndex` | Baseline gemessen |
| Spread-Kopien reduzieren (C) | `record-update.jul`: `nextTurn`, `nextTwice` (Record mit 12 Feldern) | Baseline gemessen |
| Megamorphe Zugriffe | `field-access.jul`: `unitScore` (Feld `hp` in vier Formen) | Baseline gemessen |
| Typgestützte Emission (A) | vorhandene `branching` und `named-arguments` | vorhanden |

Grenzen der Fixtures: `record-update` und `field-access` liefern nur einen Wert aus dem neuen
Record, V8 kann die Kopie daher teilweise wegoptimieren. Zeigt sich bei einer Änderung dort kein
Effekt, aber im yugioh-Profil schon, ist die Fixture zu optimistisch und bekommt ein Ergebnis, das
den Record behält (`select` in `bench-runtime.ts`).

## Stand Phase 2

**Punkt 1 (`params` hochziehen), umgesetzt.** Konstante Parameterlisten (ohne Typen) von Funktionsliteralen,
die in einer anderen Funktion stehen, werden bei der Dateiemission zu Modulkonstanten (`_params1`, …),
gleiche Listen teilen eine Konstante (`emitter.ts`, `hoistedParams`). Parameterlisten mit Typen bleiben am
Aufruf, weil ein Typ einen Namen aus dem Umfeld nennen kann. Das constant folding emittiert weiter
eingebettet. Funktionen auf oberster Ebene bleiben unverändert, sie werden nur einmal erzeugt.

| Messung | vorher | nachher |
|---|---|---|
| `bench-runtime` `callbacks/countSmall` (ms je 1 Mio.) | 93 bis 99 | 75 bis 77 (etwa -22 %) |
| yugioh Match (3 Läufe, Median) | 7,74 s | 7,07 s (-8,6 %) |
| übrige `bench-runtime`-Fälle | | im Rauschen |

Die Schätzung aus dem Profil (3 bis 8 %) war damit etwas vorsichtig. Die yugioh-Tests (250) laufen mit dem
neuen Compiler grün. Offen für diesen Punkt: Callbacks, die nie über `_callFunction`/`_branch` laufen, könnten
`params` ganz weglassen, das setzt eine Escape-Analyse im Emitter voraus und wurde nicht angegangen.

**Nachtrag zu Punkt 1.** Das Hoisting ist wieder entfernt: Mit der festen Argumentreihenfolge
(feste Argumentreihenfolge, Entscheidung in [backlog/typed-emission.md](backlog/typed-emission.md)) lesen nur noch Branches,
Typ-Köpfe und Parametertypen die `params`, alle anderen Funktionsliterale sind nackte Arrows. Das spart
Parameterliste und Zuweisung vollständig: `callbacks/countSmall` 95 ms ursprünglich, 76 ms mit Hoisting, jetzt 60 bis
62 ms, yugioh Match 7,74 s, 7,07 s, jetzt 6,98 s (-9,8 % gegenüber dem Ausgangswert).

## Reihenfolge und Abnahme

1. Phase 1 komplett, Profil dokumentieren.
2. Danach den größten Posten aus A bis E, je einzeln.
3. Nach jedem Schritt: `node --run test`, `npm run typecheck`, `bench` und `bench-runtime` mit
   `--save`, yugioh bauen (ungepinnter Compiler, bricht bei Änderungen sofort sichtbar).
4. Nach Phase 2 neu entscheiden, ob ein Wasm-Backend noch erwogen wird, mit den dann
   gemessenen Zahlen.
