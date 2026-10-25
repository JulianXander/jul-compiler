# Audit des Typsystems

Stand 2026-10-25. Grundlage: `syntax-tree.ts` (Typdarstellung) und `checker/type-algebra.ts`
(Platzhalter, Normalisierung, `typeEquals`, Zuweisbarkeit, Caches), `checker.ts` nur stichprobenartig.
Was [kritische-bewertung.md](backlog/kritische-bewertung.md) und [CHECKER-AUDIT.md](CHECKER-AUDIT.md)
schon festhalten, steht hier nicht noch einmal. Jedes Repro ist gegen den Stand dieses Datums geprüft.

Aus dem Audit bereits umgesetzt, siehe [offene-rechnungen.md](offene-rechnungen.md): rigide offene
Typen als Ziel (`TypeOf(x)` im Rumpf ist nicht seine Schranke), Prüfung der Argumente beim Aufruf
einer übergebenen Funktion, einheitliches Aufschieben von Zugriffen auf offene Rechnungen,
`valueAsType` statt `deferValueOf`. `And` mit mehr als zwei Operanden wird inzwischen normalisiert.

## Soundness-Lücken

Falscher Code geht ohne Meldung durch, oder der Checker behauptet einen Typ, den die Laufzeit nicht
liefert.

| # | Repro | Ursache |
|---|---|---|
| 1 | `f = (g: (x: Integer) -> Integer) => g(1)` und `f((x: Integer) => [currentDate() x]/2)`: keine Meldung | Die Reinheit (`->`, `~>`, `:>`) zählt in der Zuweisbarkeit von Funktionen nicht (`isTypeAssignableByStructure`, Fall `function`), nur in `typeEquals`. Eine unreine Funktion passt auf einen reinen Parameter. Ungeprüft: ob das Constant Folding sie dann zur Compilezeit auswertet. |
| 2 | `first = (a: Integer ...rest: Any) :> TypeOf(a) => a`, `pick = (xs: [Integer Text]) => first(...xs)`: Rückgabetyp `Concat(TypeOf(xs))`, also die ganze Kollektion statt ihres ersten Elements | `dereferenceParameterFromArgumentType` gibt im `default`-Zweig die ganze Argumentkollektion als Typ des Parameters zurück, etwa wenn sie ein `concat` aus einem Spread ist. Mit konstanten Argumenten verdeckt das Constant Folding den Fehler (`pick([1 2])` ergibt `1`). Derselbe Zweig behandelt auch `or` falsch: Eine Union von Kollektionen müsste sich über ihre Choices verteilen. |
| 3 | `(d: Dictionary(Integer)) => d/b` ergibt am Aufruf mit einem `Dictionary(Integer)` den Typ `Integer` | `valueFieldAccess.dictionary.get` liefert den Elementtyp ohne `Empty` (TODO dort). Widerspricht der Regel „Abwesenheit schreiben“. Vorher messen, die Union mit `Empty` erreicht viele Stellen. |
| 4 | `Or(Stream(1) Stream(2))` wird zu `Stream(Or(1 2))` | Das Zusammenfassen in `createNormalizedUnionTypeUncached` ist laut eigenem Kommentar inhaltlich falsch. Wer liest, bekommt eine Obermenge, das ist harmlos. Zusammen mit Punkt 5 ist es nur deshalb harmlos, weil ein offener Werttyp als Ziel jetzt rigide ist. |
| 5 | `Stream` wird kovariant geprüft (Fall `stream` in `isTypeAssignableByStructure`), obwohl `push` in ihn schreibt | Seit den rigiden Zielen geschlossen, soweit gemessen: `push(s$ §a§)` mit `s$: Stream(Or(Integer Text))` meldet jetzt, dass `§a§` nicht zu `TypeOf(s$)/ValueType` passt. Folge: In einen Stream-Parameter lässt sich nur ein Wert vom Typ `TypeOf(s$)/ValueType` schieben, nicht einer seiner Schranke. Offen ist, ob eine andere schreibende Stelle die Kovarianz noch ausnutzt. |

## Inkonsistenzen

- **Die Tiefenbremse in `isTypeAssignable` lehnt ab.** Bei zu tiefem Vergleich kommt
  `assignable: false` mit der Meldung „Type comparison is excessively deep“. Das verletzt „nicht
  entscheidbar darf nie zu passt nicht werden“. `typeEquals` macht es an derselben Stelle richtig.
  Richtig wäre `undefined`.
- **`typeEquals` übersieht, zu welcher Funktion ein Parameterverweis gehört.** Verglichen werden nur
  Name und Index, nicht `functionRef`. Gleichnamige Parameter verschiedener Funktionen gelten als
  gleich. Seit den rigiden Zielen wiegt das schwerer: `isRigidType` lässt einen gleichen offenen Typ
  durch, ein Verweis auf den Parameter `x` einer anderen Funktion zählt dann als derselbe. Nicht
  reproduziert.
- **Eine Rechenregel fehlt zwischen offenen Typen.** `xs/1` gegen `TypeOf(xs)/ElementType` ist für
  eine List dasselbe Element, gilt aber nur als unbekannt. Solange das so bleibt, bleibt auch die
  Prüfung im Rumpf an solchen Stellen stumm.
- **„Offen“ hat zwei Antworten.** `isDeferred` fragt „wartet der Typ als Ganzes?“, `hasArgumentSubstitution`
  „enthält er etwas, das ein Aufruf ersetzt?“. Ein Dictionary-Literal setzt `isDeferred` bewusst nie,
  auch wenn ein Feld offen ist. Wer das Flag liest, muss wissen, welche Frage er stellt.

## Architektur

- **Die Typalgebra hängt am Codegenerator und an der Runtime.** `type-algebra.ts` importiert
  `constant-folding.ts`, das `emitter.ts` und `runtime.ts` importiert. `tryFoldPredicate` führt während
  einer Zuweisbarkeitsprüfung Nutzercode aus. Damit hängt die Antwort auf „passt A zu B?“ am
  erzeugten JS.
- **Cachebarkeit über einen globalen Zähler.** `resultContext.dependence` wird an über 20 Stellen
  erhöht, dazu kommen Tiefenzähler, Alias-Stapel und Expansionsbudgets als Modulvariablen. Fehlt ein
  `++`, landet still ein falscher Eintrag im Cache, und kein Test bemerkt es zuverlässig.
- **Anzeigedaten stecken im Schlüssel fürs Interning.** `aliasName` und `declaration` gehören zum
  Schlüssel. Strukturell gleiche Typen sind deshalb verschiedene Objekte, `===` und die Caches nach
  Id treffen nicht, und `typeEquals` bleibt überall nötig. Funktionstypen werden gar nicht interniert,
  `getStreamGetValueType` baut bei jedem `s$/getValue` einen neuen.

## Performance

- **Die Deduplizierung einer Union ist ohne Obergrenze quadratisch.** `subtypeReductionLimit` begrenzt
  nur `removeSubtypes`, nicht die paarweisen `typeEquals` davor. An dieser Stelle lag der Vorfall
  3,6 s → 14,4 s (CHECKER-AUDIT). Die Choices werden zudem nicht sortiert: `Or(1 2)` und `Or(2 1)`
  sind verschiedene Objekte mit verschiedenen Cache-Schlüsseln. Mit Interning ohne Anzeigedaten und
  sortierten Choices ginge die Deduplizierung über ein Set in linearer Zeit.
- **Vergleiche rekursiver Typen werden nie gecacht.** Jede koinduktive Annahme erhöht `dependence`,
  damit fällt auch der ganze äußere Vergleich aus dem Cache. Typen wie ein Baum oder JSON werden bei
  jedem Vergleich neu durchgerechnet. TypeScript merkt sich solche Ergebnisse, sobald der äußerste
  Vergleich fertig ist.
- **Die Ids wachsen im Language Server ohne Ende.** `nextTypeId` wird nie zurückgesetzt, ab
  `maxCacheableId = 2^26` schalten sich Union- und Intersection-Cache still ab. Gemessen an yugioh:
  81.627 Ids je vollem Lauf, 6.004 je Neuprüfung von `main.jul`. Das reicht für rund 800 volle Läufe
  oder grob 11.000 Änderungen in einer Sitzung.
- **Jeder `loadFile` leert alle Caches.** Im Language Server beginnt damit jeder Tastendruck mit
  leerem Cache, und die Typen der core-lib sind danach nicht mehr dieselben Objekte wie neu gebaute.

## Nebenbei

[kritische-bewertung.md](backlog/kritische-bewertung.md) nennt für `checker.ts` noch rund 8.900 Zeilen.
Am Stand dieses Audits waren es rund 5.000, dazu rund 5.650 in `type-algebra.ts`.
