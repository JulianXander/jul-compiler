# Integer zur Laufzeit

`Integer` ist in der Sprache unbeschränkt. Im JS-Target wählt der Compiler die Darstellung nach dem Wert, ohne neuen
Typ, neues Literal oder Umwandlung im Jul-Code. Umgesetzt 2026-11-08, vorher war jeder Integer ein `bigint`.

## Invariante

> Ein Integer-Wert `v` ist genau dann eine `number`, wenn `-(2^53 - 1) ≤ v ≤ 2^53 - 1`. Sonst ist er ein `bigint`.

Die Darstellung hängt am Wert, nicht am Typ:

- Keine Umwandlung bei Subtypen: Eine `List(GameCardId)` ist ohne Kopie eine `List(Integer)`.
- `===`, `isDeepEqual` und Dictionary-Schlüssel bleiben korrekt, denn derselbe Wert hat immer dieselbe Darstellung
  (`5` und `5n` kommen nie beide vor).
- `<`, `>`, `<=`, `>=` funktionieren in JS auch gemischt.
- Gemischte Arithmetik wirft in JS (`1n + 1`). Jede Rechnung, deren Operanden `bigint` sein könnten, geht deshalb über
  einen Helfer.

Jede Stelle, die einen Integer erzeugt, stellt die Invariante her: Literale (`integerToJs` im Emitter), Arithmetik,
Runtime-Funktionen, `parseJson`, JSON-Import, Constant Folding, die TS-Grenze. Zentral sind die Helfer der Region
„kanonische Integer“ in `runtime.ts` (`_toCanonicalInteger`, `_toBigInt`, `_isInteger`).

## Arithmetik

| Operanden laut Typ | Emission |
|---|---|
| Integer, beide Operanden und Ergebnis laut Bereich im sicheren Bereich | `(a + b)`, `(a - b)`, `(a * b)` |
| Integer, Bereich unbekannt | `_addInteger(a, b)`, `_subtractInteger`, `_multiplyInteger` |
| ein Operand kann Fraction sein, `Any`, Spread, benannte Argumente | generisches `add(...)` usw. |

Die Helfer rechnen mit `number` und weichen nur bei Überlauf auf `bigint` aus. Die Prüfung nach der Rechnung ist für
`+ − ×` exakt: Liegt das echte Ergebnis außerhalb, liegt auch das gerundete außerhalb. Kein Helfer liefert `-0`.

Den Bereich liest der Emitter aus dem Typ (`getIntegerBounds`): Literale, `GreaterInteger`/`LessInteger` (auch mit
einem Typ als Grenze, etwa `Not(GreaterInteger(length(values)))` im Callback-Index), `And`, `Or` und `LengthOf`. Dass
eine Länge höchstens 2^32 − 1 ist, weiß nur der Emitter: Die Grenze hängt vom Target ab und gehört nicht in angezeigte
Typen. Ein Produkt, das `-0` sein kann, bekommt `+ 0`. Variadische Aufrufe werden linksassoziativ verschachtelt und
entscheiden je Schritt.

`Integer / Integer` ergibt ein `Rational` und bleibt generisch, ebenso `modulo`.

## Integer und Float

Kleine Integer und Float sind beide `number`, `2` und `2.0` sind zur Laufzeit nicht unterscheidbar. Die Unterscheidung
ist statisch. Wo sie zur Laufzeit nötig ist (Branching über `Or(Integer Float)`, `_isOfType`, `assume`, `parseJson`),
heißt `Integer` „`bigint` oder ganzzahlige `number` im sicheren Bereich“ und `Float` „`number`“. Ein ganzzahliger Float
erfüllt also beide, ein `[Integer]`-Branch vor einem `[Float]`-Branch fängt ihn. Bemerkbar ist das nur, wenn der Zweig
danach etwas tut, das sich unterscheidet (Division: Bruch statt Float). Ein Compiler-Fehler für diesen Fall wurde
erwogen und verworfen, weil er gültigen Code ablehnen würde.

Verworfen: Float anders darstellen (Box oder Brand). Das verschiebt die Kosten auf Float und erschwert Interop.

## Fraction

Zähler und Nenner sind selbst kanonische Integer, denn ein Bruch ist ein Jul-Wert mit Integer-Feldern und muss mit
`deepEqual` vergleichbar sein. Die Bruchrechnung wandelt über `getRationalParts` nach `bigint` und das Ergebnis zurück
(`normalizeRational`). Bei Nenner 1 entsteht ein kanonischer Integer.

## TypeScript-Grenze

- TS-Typ `bigint` in einer importierten Signatur wird an der Grenze umgewandelt: Argumente nach `bigint`, Ergebnisse
  kanonisch, Callbacks in Gegenrichtung. Der Emitter erzeugt dafür aus dem Typ eine Beschreibung
  (`getTsConversionSpec`) und umhüllt den Import mit `_fromTs(wert, spec)`, beim Destructuring je Export, beim
  Modul-Import (`x = import(§….ts§)`) das ganze Modul. Exporte ohne Integer im Typ bleiben unverändert.
- TS-Typ `CanonicalInteger` (in TS als `number | bigint` zu definieren) wird auf den Corelib-Alias
  `CanonicalInteger = Integer` abgebildet und nicht umgewandelt. Für heiße Funktionen: Die Umwandlung kostet je Aufruf,
  in yugioh mehr, als der Umbau in der KI gewann. Die TS-Funktion muss die Invariante dann selbst halten.

## Andere Targets (LLVM, WebAssembly)

Die Invariante ist das übliche Modell für unbeschränkte Ganzzahlen: kleine Werte direkt, große als Bignum (Fixnum und
Bignum in Lisp, `Integer` in Haskell, Zarith in OCaml, `int` in Python). Nur die Grenze hängt vom Target ab:

| Target | kleine Darstellung | Überlaufprüfung | große Darstellung |
|---|---|---|---|
| JS | `number`, \|v\| ≤ 2^53 − 1 | Bereichsvergleich nach der Rechnung | `bigint` |
| LLVM | `i64` ungeboxt oder getaggt (63 Bit mit Tag-Bit) | `llvm.sadd.with.overflow` | Zeiger auf Bignum |
| WebAssembly | `i64`, mit WasmGC `i31ref` für getaggte kleine Werte | Vergleich | Bignum im linearen Speicher oder GC-Objekt |

Die Bereichsrechnung ist auf allen Targets der Hebel: Ein Typ mit bekanntem Bereich lässt sich ungeboxt als
`i32`/`i64` emittieren, ohne Tag und Prüfung. Ein eigener Index-Typ auf Basis von `Float` wäre dagegen nur in JS
sinnvoll und trüge eine Eigenheit des JS-Targets in die Sprache.

## Messungen (yugioh, 2026-11-08)

Engine-Benchmark, A/B gegen Integer-Arithmetik inline mit `bigint`: `applyToGameState` −14,6 %, `getLegalInputs`
−17,5 %, Partie Greedy gegen Greedy −16,9 %. Arithmetik ohne Prüfung bei bekanntem Bereich trifft 42 von 218
Rechnungen im Bundle. Ein Gewinn ist nicht messbar, denn V8 inlinet die Helfer, und sie stehen nicht unter den 25
Funktionen mit der meisten Eigenzeit. Obergrenzen für Domänentypen lohnen sich für die Laufzeit deshalb derzeit nicht.
