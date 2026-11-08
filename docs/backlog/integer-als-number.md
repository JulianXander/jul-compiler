# Integer als `number` im sicheren Bereich

Status (2026-11-08, nicht committet): Stufen 1 bis 3 umgesetzt, Stufe 4 für die heißen Funktionen in yugioh. Offen:
Float-Konflikt als Compiler-Fehler, Domänentypen mit Obergrenzen (lohnt laut Profil derzeit nicht). Abweichungen vom
Entwurf stehen unter „Umgesetzt“ am Ende.

## Ausgangslage

`Integer` ist zur Laufzeit immer ein `bigint`. Das ist exakt und unbeschränkt, aber teuer: Ein `BigInt` ist ein
Heap-Objekt, jede Rechnung legt ein neues an, und ein Listenzugriff braucht `Number(index)`. Dazu kommt, dass
Integer-Arithmetik heute gar nicht inline emittiert wird, sondern über die generischen Runtime-Funktionen `add`,
`subtract` und `multiply` läuft (variadisch, `reduce`, Fallunterscheidung Integer/Fraction). Im yugioh-Bundle sind das
99 `add`-, 74 `subtract`- und 25 `multiply`-Aufrufe.

Mikro-Benchmarks (Node 24, ns je Operation inklusive Schleife und Vergleich, die selbst etwa 1,5 ns kosten):

| Operation | heute | inline `bigint` | `number` mit Prüfung | `number` ohne Prüfung |
|---|---|---|---|---|
| Addition | 12,6 (`add(a, b)`) | 4,5 | 2,8 | 1,9 |
| Vergleich `===` | 3,3 | | | 1,9 |
| Listenzugriff `values[Number(i) - 1]` gegen `values[i - 1]` | 8,2 | | | 1,7 |

Im yugioh-Engine-Profil ist `getElement` mit 8,6 % Eigenzeit die teuerste einzelne Funktion (rund 72 Aufrufe je
Schritt über `getGameCard`). Dazu kommen Vergleiche von Karten-Ids und die Arithmetik in Engine und KI-Bewertung.

## Ziel

Ganze Zahlen im sicheren Bereich sind `number`, ohne Änderung der Sprache: kein neuer Typ, kein neues Literal, keine
Umwandlung im Jul-Code. Die Typen beschreiben weiter den Wertebereich, der Compiler wählt die Darstellung.

## Invariante: kanonische Darstellung

> Ein Integer-Wert `v` ist genau dann eine `number`, wenn `-(2^53 - 1) ≤ v ≤ 2^53 - 1`. Sonst ist er ein `bigint`.

Die Darstellung hängt am Wert, nicht am Typ. Daraus folgt:

- **Keine Umwandlung bei Subtypisierung.** Ein `PositiveInteger` als `Integer`, eine `List(GameCardId)` als
  `List(Integer)`: Die Darstellung ist schon richtig, nichts wird kopiert.
- **`===`, `isDeepEqual`, Dictionary-Schlüssel bleiben korrekt,** denn derselbe Wert hat immer dieselbe Darstellung
  (`5` und `5n` kommen nie beide vor).
- **Relationale Vergleiche** (`<`, `>`, `<=`, `>=`) funktionieren in JS auch gemischt (`5 < 10n` ist erlaubt).
- **Gemischte Arithmetik ist verboten** (`1n + 1` wirft `TypeError`): Jede Rechnung, deren Operanden `bigint` sein
  könnten, geht über einen Helfer, der beide Fälle kennt und das Ergebnis normalisiert.

Jede Stelle, die einen Integer erzeugt (Literale, Arithmetik, Runtime-Funktionen, JSON, Interop), muss die Invariante
herstellen. Das ist die eigentliche Arbeit dieses Umbaus.

## Entscheidungen

### Integer und Float zur Laufzeit

Mit der Invariante sind kleine Integer und Float beide `number`. `2` (Integer) und `2.0` (Float) sind zur Laufzeit
nicht unterscheidbar. Vorschlag:

1. **Die Unterscheidung ist statisch.** Ein Branching, dessen Argumenttyp Integer- und Float-Glieder hat, die sich nur
   zur Laufzeit trennen ließen (`Or(Integer Float)`, `Or(PositiveInteger Float)`), ist ein Compiler-Fehler (neuer
   Code). Mit `Any` und `JsonValue` als Argument gilt Punkt 2.
2. **Laufzeitprüfung gegen `Any`** (`_isOfType`, `assume`, `parseJson`): `Integer` heißt `bigint` oder ganzzahlige
   `number`, `Float` heißt `number`. Eine ganzzahlige `number` erfüllt also beide, ein `[Integer]`-Branch vor einem
   `[Float]`-Branch fängt sie. JSON kennt den Unterschied ohnehin nicht (`2` und `2.0` sind dasselbe).

Verworfen: Float anders darstellen (Box oder Brand). Das verschiebt den Overhead auf Float und macht Interop mit JS
schlechter.

Zu prüfen vor der Umsetzung: wie oft Jul-Code (Tests, Beispiele, yugioh) zur Laufzeit zwischen Integer und Float
verzweigt. In yugioh kommt `Float` dreimal in einer Datei vor, `Or(Integer Float)` gar nicht.

### Fraction

`Fraction` bleibt intern bei `bigint` für Zähler und Nenner, `normalizeRational` liefert bei Nenner 1 einen kanonischen
Integer (`toCanonicalInteger`). Brüche sind selten, eine zweite Darstellung lohnt dort nicht. Liest Jul-Code Zähler
oder Nenner, wird beim Zugriff normalisiert.

### TypeScript-Interop

Heute bildet `typescript-parser.ts` den TS-Typ `bigint` auf `Integer` ab, TS-Funktionen bekommen also `bigint`.
Vorschlag:

- **`bigint` in einer TS-Signatur bleibt erlaubt.** Der Compiler wandelt an der Grenze um: Argumente mit `BigInt(x)`,
  Ergebnisse mit `toCanonicalInteger`. Bestehender TS-Code läuft unverändert, die Umwandlung kostet nur an der Grenze.
- **Neu: `JulInteger` (`number | bigint`) aus der Runtime** für TS-Code, der schnell sein soll. Ohne Umwandlung, die
  TS-Funktion muss die Invariante selbst halten (Helfer `addInteger` usw. aus der Runtime exportieren).
- Beschränkte Typen im sicheren Bereich könnten in TS als `number` erscheinen. Das ist ein späterer Schritt, weil TS
  `number` heute auf `Float` abgebildet wird.

### JSON

- `parseJsonValue`: ganzzahlige Werte im sicheren Bereich als `number`, darüber `bigint`, Brüche wie bisher.
- `jsonValueToJsExpression` (JSON-Import im Emitter): `5` statt `5n` im sicheren Bereich.
- `_toJson`: unverändert (`toString()` für beide).

## Emission

### Literale

`emitter.ts` an drei Stellen (`case 'integer'`, `literalValueToJs`, `jsonValueToJsExpression`): Literal im sicheren
Bereich als `5`, darüber als `5n`. Gilt auch für Typ-Literale in `_createFunction`-Parametern und Branch-Tests
(`x === 1` statt `x === 1n`).

### Vergleiche

`equal`, `greaterInteger`, Literal-Köpfe im Branch-Dispatch: direkt `===` und `>`, nie eine Prüfung. Das folgt aus der
Invariante.

### Arithmetik

Der Checker kennt die Typen der Operanden. Daraus drei Fälle:

| Operanden laut Typ | Ergebnis laut Bereich | Emission |
|---|---|---|
| beide Integer, Ergebnis sicher im sicheren Bereich | | `a + b` |
| beide Integer, Bereich unbekannt | | `_addInteger(a, b)` |
| ein Operand kann Fraction sein (Rational) | | generisches `add(a, b)` wie heute |

`_addInteger` (ebenso `_subtractInteger`, `_multiplyInteger`):

```js
function _addInteger(a, b) {
	if (typeof a === 'number' && typeof b === 'number') {
		const r = a + b;
		if (r <= 9007199254740991 && r >= -9007199254740991) {
			return r;
		}
	}
	return _toCanonicalInteger(BigInt(a) + BigInt(b));
}
```

Die Prüfung nach der Rechnung ist für `+ − ×` exakt: Liegt das echte Ergebnis außerhalb, liegt auch das gerundete `r`
außerhalb. Variadische Aufrufe (`add(a b c)`) werden zu verschachtelten Aufrufen.

**Division und Modulo:** `Integer / Integer` ergibt in Jul ein `Rational`, bleibt also generisch. `modulo` braucht
Sorgfalt: `%` auf `number` ist exakt, aber V8 nimmt den schnellen Int32-Pfad nur, wenn beide Operanden als int32
bekannt sind, sonst `fmod` auf Double. Im Mikro-Benchmark war `%` auf `number` ohne diese Garantie langsamer als auf
`bigint`. Vorschlag: `a % b` nur, wenn beide Bereiche in int32 liegen, sonst ein Helfer. Vor der Festlegung messen.

**Ohne den Umbau ein eigener Schritt:** Schon inline mit `bigint` (`a + b` statt `add(a, b)`) sinkt die Addition von
12,6 auf 4,5 ns. Das ist der erste Schritt im Plan unten.

### Listen und Indizes (Runtime)

| Funktion | heute | neu |
|---|---|---|
| `length` | `BigInt(values.length)` | `values.length` |
| `getElement`, `setElement` | `values[Number(index) - 1]` | `values[index - 1]`, bei unbeschränktem Index mit `typeof index === 'number'` davor (ein `bigint`-Index liegt immer außerhalb der Liste) |
| `map`, `filter`, `filterMap`, `aggregate`, `exists`, `all`, `findFirst`, `forEach`, `toDictionary` | `BigInt(index + 1)` je Element | `index + 1` |
| `findFirstIndex`, `findLastIndex`, `slice`, `range`, `repeat` | `bigint` | `number` (`range` mit `bigint`-Grenzen jenseits des sicheren Bereichs: Helfer) |
| Inline-Schleifen im Emitter (`_listIndex`) | `BigInt(_listIndex + 1)` | `_listIndex + 1` |

### Übrige Runtime

Nach Fundstellen (`bigint`/`BigInt` je Funktion in `runtime.ts`, 96 insgesamt): `add`, `subtract`, `multiply`,
`divide`, `modulo`, `maxInteger`, `greaterInteger`, `floatToInteger`, `rationalToFloat`, `roundUp`,
`normalizeRational`, `isDeepEqual` (Fallunterscheidung `bigint`/`number`), `_isOfType` (`integer` und `bound` mit
`Family === 'integer'`), `parseJsonValue`, `_toJson`, `addDate`, die Typ-Konstruktoren mit Integer-Grenzen
(`GreaterInteger`, `LessInteger`, `LengthOf`, `ElementAt`, `IndexRange`, `_interval`). `floatToInteger` liefert
künftig eine kanonische Zahl (meist `Math.round(...)` direkt), `rationalToFloat` braucht bei `number` kein `Number()`.

## Typ-Algebra: Wertebereiche

Für die Emission ohne Prüfung braucht der Emitter den Bereich eines Ausdrucks. Vorhanden sind `getIntegerMinimum` und
`getIntegerMaximum` (Literale, Grenztypen, `And`, `Or`) und `IntegerRange` mit `min`/`max`. Neu:

- `isSafeIntegerType(type)`: Minimum und Maximum bekannt und beide im sicheren Bereich.
- Bereich eines Ergebnisses: für `add`/`subtract` Summe bzw. Differenz der Grenzen, für `multiply` die Extremwerte der
  vier Produkte. Die Operationstypen `add`/`subtract` (`CompileTimeAddType`) gibt es schon, sie müssten ihren Bereich
  liefern.
- Wie der übrige Dispatch läuft das im Emitter (`branch-dispatch.ts` als Vorbild), nicht im Checker: Der Language
  Server zahlt nichts.

**Corelib-Typen mit Grenzen**, damit Index-Code ohne Prüfung läuft:

- `length()`: `And(GreaterInteger(-1) LessInteger(4294967296))` (JS-Arrays haben höchstens 2^32 − 1 Elemente).
- Index-Parameter von `getElement`, `setElement`, Callback-Index von `map` usw.: `And(GreaterInteger(0)
  LessInteger(4294967296))`.

Ohne diese Grenzen funktioniert alles, nur mit `_addInteger` statt `+` bei Index-Rechnungen.

## Branch-Dispatch und Laufzeitprüfung

- `getJsKinds` (`branch-dispatch.ts`): `integer` und `integerLiteral` haben die Arten `number` und `bigint`, ein
  Integer-Typ im sicheren Bereich nur `number`. `bound` mit `Family === 'integer'` ebenso nach Bereich.
- Konflikt mit Float: Hat ein Argument Integer- und Float-Glieder mit gemeinsamer Art `number`, kann `getKindStep` sie
  nicht trennen. Heute fiele das auf `_branch` zurück, künftig ist es ein Compiler-Fehler (siehe Entscheidungen).
- `bound`-Test: Der Vergleich `x > 1` funktioniert für `number` und `bigint`, der Wächter `typeof x === 'bigint'` wird
  zu „`number` oder `bigint`“.

## Constant Folding

`constant-folding.ts` serialisiert `bigint` mit `n`-Suffix und wertet Ausdrücke im Checklauf aus. Die gefalteten
Werte müssen dieselbe Invariante erfüllen wie die Runtime, sonst unterscheidet sich ein gefaltetes Ergebnis von einem
zur Laufzeit berechneten (`5n` gegen `5`). Am einfachsten: Die Faltung nutzt die neuen Runtime-Helfer.

## Stufenplan

Jede Stufe mit Messung (`npm run bench-runtime`, yugioh `measure-engine.js` im A/B-Wechsel) und allen Tests.

0. **Obergrenze messen (optional, ohne Compiler-Änderung):** Kopie des yugioh-Bundles, in der `GameCardId`,
   `getElement` und die Index-Rechnungen von Hand auf `number` umgestellt sind, im A/B-Vergleich. Zeigt, ob sich der
   Umbau lohnt.
1. **Integer-Arithmetik inline, noch mit `bigint` (umgesetzt, `integerArithmeticCallToJs` im Emitter; im yugioh-Bundle 198 → 1 Runtime-Aufruf, Partie Greedy gegen Greedy −6,5 %):** Sind beide Operanden laut Typ Integer, `a + b`, `a - b`,
   `a * b` statt der generischen Runtime-Funktion. Klein, unabhängig, sofort messbar (12,6 → 4,5 ns je Addition).
2. **Kanonische Darstellung:** Runtime (Helfer, Normalisierung, Listen-Natives, `_isOfType`, JSON, `isDeepEqual`),
   Emitter (Literale, Arithmetik über `_addInteger` usw.), Branch-Dispatch (Arten), Interop (Umwandlung an der Grenze
   für `bigint`-Signaturen), Constant Folding. Der Float-Konflikt wird Compiler-Fehler. Größte Stufe.
3. **Bereiche:** `isSafeIntegerType` und Bereichsrechnung im Emitter, Corelib-Typen mit Grenzen. Arithmetik und
   Indizes mit bekanntem Bereich ohne Prüfung.
4. **Projekte nachziehen (yugioh):** Domänentypen mit Obergrenzen (`GameCardId`, Zonen-Indizes, ATK, LP, Zähler,
   Bewertungen), `util.ts` auf `JulInteger` oder bei `bigint` lassen (Umwandlung an der Grenze; heiße Funktionen wie
   `randomInteger`, `memoizeSearch`, `toSearchValue`, `getUcbScore` umstellen).

## Tests

- Emitter: Literale (`5`, `2^53 - 1`, `2^53`), Arithmetik je Fall (Bereich bekannt, unbekannt, Rational), Vergleiche,
  Branch-Tests mit Literal-Köpfen, Float-Konflikt als Fehler.
- Runtime: Helfer an der Grenze (`2^53 - 1 + 1`, negativ, Rückkehr in den sicheren Bereich, Produkt knapp über der
  Grenze), `isDeepEqual` über die Grenze, Listenfunktionen mit Index, `parseJson` mit großen Zahlen, `_isOfType` für
  `Integer`/`Float` gegen `Any`.
- Fuzz (`npm run fuzz`) mit Rechnungen um ±2^53, Vergleich mit einer reinen `bigint`-Referenz.
- Snapshots: Die Emitter-Erwartungen mit `1n` ändern sich großflächig, das sollte ein eigener Commit sein.

## Risiken

- **Grenzfehler um 2^53:** Normalisierung vergessen, gemischte Arithmetik (`TypeError`), Constant Folding mit anderer
  Darstellung als die Runtime. Gegenmittel: Helfer zentral in der Runtime, Fuzz gegen `bigint`-Referenz.
- **Polymorphe Stellen für den JIT:** Wo echte große Zahlen vorkommen, sieht V8 beide Arten. Solange nur kleine Werte
  vorkommen, bleibt jede Stelle monomorph.
- **Verhaltensänderung für `Integer`/`Float` gegen `Any`:** Eine ganzzahlige Float-Zahl gilt dort als Integer. Betrifft
  `parseJson` und Laufzeitprüfungen, nicht statisch getypten Code.
- **Großer Diff in den Tests** (Literale in Emitter-Erwartungen).

## Andere Targets (LLVM, WebAssembly)

Die Invariante ist kein JS-Trick, sondern das übliche Modell für unbeschränkte Ganzzahlen: kleine Werte direkt, große
als Bignum (Fixnum/Bignum in Lisp, `Integer` in Haskell mit GMP, Zarith in OCaml, `int` in Python). Nur die Grenze
hängt vom Target ab:

| Target | kleine Darstellung | Überlaufprüfung | große Darstellung |
|---|---|---|---|
| JS | `number`, \|v\| ≤ 2^53 − 1 | Bereichsvergleich nach der Rechnung | `bigint` |
| LLVM | `i64` ungeboxt, oder getaggt (z. B. 63 Bit mit Tag-Bit) | `llvm.sadd.with.overflow` (ein Sprung auf das Overflow-Flag) | Zeiger auf Bignum (GMP o. Ä.) |
| WebAssembly | `i64`, mit WasmGC `i31ref` für getaggte kleine Werte | Vergleich (kein Overflow-Flag in Wasm) | Bignum im linearen Speicher oder GC-Objekt |

Die Bereichsrechnung der Typ-Algebra (Stufe 3) ist auf allen Targets der Hebel: Ein Typ mit bekanntem Bereich wird
ungeboxt als `i32`/`i64` emittiert, ganz ohne Tag und Prüfung. Indizes und Längen werden so automatisch zu
Maschinen-Ganzzahlen, ohne eigenen Index-Typ in der Sprache.

Ein Index-Typ auf Basis von `Float` wäre dagegen nur in JS sinnvoll. Nativ und in Wasm müsste jeder Zugriff erst von
`f64` in eine Ganzzahl umwandeln. Er würde eine Eigenheit des JS-Targets in die Sprache tragen.

Auch die Entscheidung „Integer und Float nur statisch unterscheiden“ ist targetunabhängig: Nativ ließen sich beide über
Tags trennen, aber die Semantik der Sprache sollte auf allen Targets dieselbe sein. Die statische Unterscheidung ist
die, die jedes Target ohne Kosten einhalten kann.

## Umgesetzt (Stufen 1 und 2, 2026-11-08)

**Runtime (`runtime.ts`):** Region „kanonische Integer“ mit `RuntimeInteger`, `_isInteger`, `_toCanonicalInteger`,
`_toBigInt`, `_addInteger`, `_subtractInteger`, `_multiplyInteger` (ohne `-0`) und `moduloInteger`. `add`, `subtract`,
`multiply`, `divide`, `modulo`, `roundUp`, `floatToInteger`, `rationalToFloat` und `normalizeRational` liefern
kanonische Werte, `add`/`multiply` ohne `reduce` und ohne Startwert. Listenfunktionen mit `number`-Index und -Länge,
`range` mit Weg über `bigint` für Grenzen jenseits des sicheren Bereichs. `_isOfType`: `integer` und `bound`
(Integer-Familie) über `_isInteger`, `float` weiter `typeof number`. `NonZeroInteger`, `NonZeroRational` und
`PositiveInteger` mit kanonischen Literalen (`Not(0)`, sonst rutschte eine kanonische `0` durch). `parseJsonValue`
kanonisch, Streams (`_interval$`, `_take$`) und `repeat` zählen mit `number`.

**Emitter:** `integerToJs` für alle Integer-Literale (auch JSON-Import und Branch-Tests), Brüche mit kanonischen
Feldern, Index in inline erzeugten Schleifen `(_listIndex + 1)`. `integerArithmeticCallToJs` emittiert die Helfer
(`_addInteger(a, b)`), variadisch linksassoziativ verschachtelt.

**Branch-Dispatch:** Laufzeitarten als Mengen: Integer hat `number` und `bigint`, ein Integer-Literal genau eine. Der
Grenz-Test bekommt `jsKinds` (Wächter `(typeof x === 'number' || typeof x === 'bigint') && x > 1`). Ein Glied der
anderen Zahlfamilie (Float neben Integer-Grenze) führt zum Rückfall.

**Constant Folding:** `typeToConstantValue` liefert Integer-Literale kanonisch. `constantValueToType(value,
mayContainFloat)`: Eine ganzzahlige `number` wird zum Integer-Literal, außer der deklarierte Rückgabetyp kann
nachweislich einen Float enthalten (`typeMayContainFloat` in `checker.ts`), dann bleibt sie ungefaltet. Unbekannte
Rückgabetypen zählen als „kein Float“, sonst fiele das Falten von Nutzerfunktionen weg.

**TS-Grenze:** `_fromTs(wert, spec)` in der Runtime, `getTsConversionSpec` im Emitter erzeugt die Beschreibung aus dem
Typ des Exports (Integer, Listen, Tupel, Records, Dictionaries, Unions, Funktionen mit Callbacks in Gegenrichtung).
Nur Exporte mit Integer im Typ bekommen einen Wrapper (`const name = _fromTs(_ts_name, spec)`). Module-Importe
(`x = import(§….ts§)`) sind noch nicht abgedeckt, yugioh nutzt sie nicht.

Abweichungen vom Entwurf:

- **Brüche mit kanonischen Feldern** statt `bigint` intern: Ein Bruch ist ein Jul-Wert mit Integer-Feldern,
  `deepEqual` mit einem Bruch aus einem Record muss stimmen. Die Bruchrechnung wandelt über `getRationalParts` nach
  `bigint` und das Ergebnis zurück.
- **`CanonicalInteger` statt `JulInteger`:** Der TS-Typ `CanonicalInteger` (in TS als `number | bigint` definiert)
  wird auf den Corelib-Alias `CanonicalInteger = Integer` abgebildet. `getTsConversionSpec` wandelt einen Wert mit
  diesem Alias nicht um. Ohne das kostete die Grenze in heißen Pfaden mehr, als die Engine gewinnt: Mit `bigint` in
  `memoizeSearch`, `toSearchValue` und `getUcbScore` blieb die KI trotz schnellerer Engine gleich schnell.
- **Float-Konflikt noch kein Compiler-Fehler:** Ein Branching über `Or(Integer Float)` fällt auf `_branch` zurück, die
  Laufzeitprüfung entscheidet nach Punkt 2 der Entscheidungen. Der Fehler (Punkt 1) ist offen.

Messung in yugioh (Engine-Benchmark, A/B im Wechsel, gegen Stufe 1): `applyToGameState` −14,6 %, `getLegalInputs`
−17,5 %, Partie Greedy gegen Greedy −16,9 %, gleiche Zahl legaler Inputs. KI am ersten Zug (mit `CanonicalInteger` in
`util.ts`): Lookahead Tiefe 3 von 95 auf 90 ms, Monte Carlo von 476 auf 438 ms, MCTS von 282 auf 263 ms.
Compiler-Tests: 1954, davon neu „kanonische Integer“ (Grenze 2^53 gegen `bigint`-Referenz) und `_fromTs`.

## Umgesetzt (Stufe 3, 2026-11-08)

**Emitter:** `getIntegerBounds` liest Minimum und Maximum aus dem Typ eines Operanden: Literale, `GreaterInteger` und
`LessInteger` (auch mit einem Typ als Grenze, etwa `Not(GreaterInteger(length(values)))` im Callback-Index), `Not`
einer Grenze, `And`, `Or` und `LengthOf`. `integerOperationToJs` rechnet daraus den Bereich des Ergebnisses (Summe,
Differenz, Extremwerte der vier Produkte). Liegen beide Operanden und das Ergebnis im sicheren Bereich, wird der
JS-Operator ohne Prüfung emittiert (`(a + b)`), sonst der Helfer. Variadische Aufrufe entscheiden je Schritt. Ein
Produkt, das `-0` sein kann (ein Faktor kann 0, der andere negativ sein), bekommt `+ 0`.

Abweichungen vom Entwurf:

- **Keine geänderten Corelib-Typen:** Die Obergrenze einer Länge (2^32 − 1) kennt nur der Emitter (`maxJsLength` für
  `LengthOf`). In der Typ-Algebra stünde sie in jedem angezeigten Typ und hinge vom Target ab. Der Callback-Index von
  `map` usw. ist schon durch `length(values)` beschränkt, dadurch ist `index.add(1)` ohne Prüfung.
- **Kein eigenes `isSafeIntegerType`:** `isSafeIntegerBounds` auf den gelesenen Grenzen genügt.
- **`getElement` bleibt beim Runtime-Aufruf** mit `typeof`-Wächter, auch bei beschränktem Index.

Wirkung in yugioh: Von 218 Helfer-Aufrufen im Bundle laufen 42 ohne Prüfung (zuvor 103/91/24, jetzt 89/67/20 für
add/subtract/multiply). Die übrigen rechnen auf Domänenwerten ohne Grenze (ATK, LP, Zähler, `index: Integer`). Im
CPU-Profil der Engine stehen die Helfer nicht unter den 25 Funktionen mit der meisten Eigenzeit, V8 inlinet sie. Der
Engine-Gewinn ist daher nicht messbar, und Obergrenzen für Domänentypen (Stufe 4) lohnen sich für die Laufzeit derzeit
nicht. Für andere Targets (ungeboxte `i32`/`i64`, siehe oben) bleibt die Bereichsrechnung die Grundlage.

## Offene Fragen

1. Float-Konflikt: Fehler oder Warnung mit Rückfall auf Laufzeitprüfung nach Punkt 2 der Entscheidungen?
2. `JulInteger` in TS jetzt oder erst, wenn ein heißer Interop-Fall es verlangt?
3. Sollen beschränkte Typen im sicheren Bereich in TS als `number` erscheinen (ändert die Abbildung von TS `number`,
   heute `Float`)?
4. `modulo`: eigene Emission nach int32-Bereich oder immer Helfer? Erst messen.
