# Punkt 4: Weitere core-lib-Funktionen mit zu grobem Rückgabetyp

## Stand

`filterMap` ist geprüft und **kein Fund**: der rote Test dafür war falsch, nicht der Checker. Siehe
[Ergebnis filterMap](#ergebnis-filtermap). Die verbleibenden Kandidaten aus der Audit-Zeile
(`findFirst`, `lastElement`, `toDictionary`, `toList`, ggf. weitere) sind noch nicht einzeln
geprüft — dafür ist das Kriterium unten gedacht.

Neben dem konkreten Typverhalten je Builtin ist eine zweite, unabhängige Frage offen: **wo der Fix
für einen bestätigten Fund reinkommt** — siehe
[Architekturfrage](#architekturfrage-sonderbehandlung-im-checker-vs-typsystem).

## Architekturfrage: Sonderbehandlung im Checker vs. Typsystem

`getReturnTypeFromFunctionCall` ([checker.ts:1640](../src/checker.ts#L1640)) hat einen
`switch (functionName)` mit eigenem TypeScript-Code je Builtin: `getElement`, `lastElement`,
`length`, `setElement`, `map` (nur der Tuple-Arity-Fall), dazu `And`, `Not`, `Or`, `TypeOf`,
`Greater`. Das ist bereits als Problem erkannt — [design-principles.md](design-principles.md#3-einheitlichkeit),
Abschnitt Einheitlichkeit, nennt genau diese Gruppe als Beispiel für eine Ausnahmenliste: *„Fünf
separate Funktionen (`getElement`, `lastElement`, `length`, `setElement`, `map`), die alle über `Or`
verteilen und bei Unbekanntem zurückfallen — war eine Ausnahmenliste. Richtig wäre ein Konstrukt
statt fünf Fällen."*

**Zwei Kategorien, die nicht verwechselt werden dürfen:**

- `And`, `Not`, `Or`, `TypeOf`, `Greater` bauen Typen selbst (Typkonstruktoren). Die müssen nativ
  sein, sie *sind* die Bausteine, mit denen core-lib überhaupt Typen ausdrückt — keine Ausnahme.
- `getElement`, `lastElement`, `length`, `setElement`, `map` sind gewöhnliche Werte-Builtins, deren
  generisches Rückgabetyp-Verhalten heute nur über einen TS-Sonderfall im Checker geht, **nicht**
  über die core-lib-Deklaration allein. Genau die fünf, die design-principles.md schon als
  Ausnahmenliste markiert. Jeder weitere Kandidat aus diesem Dokument (`lastElement` steht schon
  in der Liste, `toDictionary`/`toList` vermutlich auch), der einen echten Fund hat, würde nach
  heutigem Stand ein sechster, siebter, achter Sonderfall.

**Die Wurzel:** core-lib kann bedingte Typen heute nur als verschachteltes `Or(And(...) ...)`
ausdrücken (siehe design-principles.md, Beispiel „Keine Magie für Typen"). Für `map`s
Tuple-Arity (ein Ergebnistyp pro Tupel-Position, abgeleitet aus `callback/ReturnType`) reicht das
nicht — es gibt keinen Weg, „für jede Position im Tuple denselben Typ einsetzen" rein deklarativ zu
schreiben. Deshalb der TS-Sonderfall.

### Optionen

- **A — Sonderbehandlung fortführen.** Jeder bestätigte Fund bekommt seinen eigenen `case` in
  `getReturnTypeFromFunctionCall`. Aufwand pro Fall klein (das ist auch die Aufwandsschätzung in
  [CHECKER-AUDIT.md](CHECKER-AUDIT.md) für Punkt 4), aber die Ausnahmenliste wächst weiter und
  widerspricht dem bereits notierten Soll-Zustand.
- **B — Bedingte Typen als Sprachkonstrukt.** core-lib bekommt einen echten Mechanismus für
  „Typ abhängig von einem anderen Typ", mit dem `getElement`, `lastElement`, `length`,
  `setElement` und `map` (und potenziell die neuen Kandidaten) rein in core-lib deklariert werden,
  ohne Namens-Sonderfall im Checker. Das ist der in design-principles.md als Schwelle genannte Fall
  für neue Typ-Syntax (dort mit `:?` angedeutet) — ein eigener, größerer Sprachentwurf, keine
  Nebenarbeit von Punkt 4.
- **C — Ein Konstrukt, aber noch nativ.** Statt fünf benannter Sonderfälle ein einziger generischer
  Mechanismus (z. B. eine native Hilfsfunktion, die „Element bei Index, sonst Empty" bzw.
  „bilde jede Tuple-Position ab" allgemein beschreibt), den alle fünf Builtins gleich nutzen. Kein
  neuer Syntax-Entwurf, aber die Ausnahmenliste schrumpft auf einen Fall statt fünf.

### Entscheidung

Noch offen. Wichtig für die Reihenfolge: erst diese Architekturfrage klären, dann die Kandidaten aus
der Tabelle unten abarbeiten — sonst entsteht bei jedem bestätigten Fund erneut derselbe Sonderfall,
den design-principles.md schon als falsch markiert hat.

## Prinzip: je genauer der Typ, desto besser

Zusätzlich zum Empty-Kriterium gilt allgemeiner: statisch Auswertbares gehört ins Typsystem gefaltet,
nicht als grober Typ liegen gelassen. Ein Index-Zugriff mit bekanntem Literal-Index auf ein Tuple mit
bekannten Elementtypen kennt seinen Ergebnistyp exakt — `[Integer Text]/2` sollte `Text` sein, nicht
`Or(Integer Text)`. `dereferenceIndexFromObject` macht das für den direkten Fall (`case 'tuple':
return sourceObjectType.ElementTypes[index - 1]`) bereits richtig; das generische
`TypeOf(values)/ElementType` (ohne konkreten Index, z. B. in `map`s Deklaration) vereinigt dagegen
notwendigerweise alle Positionen (`createNormalizedUnionType(innerType.ElementTypes)`) — das ist der
Preis der Generizität, nicht ein Fehler. Präziser wäre nur eine Variante, die den tatsächlichen Index
kennt (z. B. `getElement` mit Integer-Literal als zweitem Argument), analog zum bereits vorhandenen
`case 'integerLiteral'` in `getElementFromTypes`.

Das Prinzip ist nicht neu für dieses Dokument, sondern erklärt einen Teil der Fälle aus der
Architekturfrage: `getElement` bei Literal-Index und `map` bei Tuple sind beides Fälle, in denen der
Checker mehr weiß, als eine rein generische core-lib-Deklaration ausdrücken kann — deshalb die
Sonderbehandlung. Die Frage ist also nicht nur *ob* gefaltet wird, sondern *wo*: im Typsystem selbst
(Option B) oder als weiterer Checker-Sonderfall (Option A/C).

### Vergleich mit anderen Sprachen

**TypeScript** faltet genau das über *conditional types* (`T extends U ? X : Y`), *indexed access
types* (`Tuple[number]` bzw. `Tuple[2]` für eine konkrete Position) und *mapped types*
(`{ [K in keyof T]: ... }`), alles zur Compile-Zeit rekursiv ausgewertet — das Typsystem ist
turing-vollständig und im Kern eine kleine funktionale Sprache über Typen, sehr nah an dem, was
core-lib mit `Or`/`And`/`Not`/`TypeOf` schon versucht. Der Unterschied zu JUL: TS hat für „bilde
jede Position ab" (`map`s Fall) mit *mapped tuple types* ein eigenes Sprachkonstrukt, keinen
Compiler-Sonderfall pro Standardbibliotheksfunktion — `Array.prototype.map` selbst ist in `lib.d.ts`
ganz gewöhnlich mit einem generischen Typparameter deklariert, ohne dass der TS-Compiler den Namen
`map` kennen müsste. Das spricht für Option B: das fehlende Konstrukt nachzurüsten, statt jede
Fundstelle einzeln im Checker zu behandeln.

**Elixir** hat mit dem neuen satztheoretischen Typsystem (Elixir ≥ 1.17, nach Castagna/Duboc, „set-
theoretic types") eine Typalgebra, die `Or`/`And`/`Not` in JUL sehr ähnelt (Union-, Intersection- und
Negativtypen als Grundbausteine, nicht als Sonderfälle). Der für dieses Dokument relevante Teil ist
*occurrence typing*: ein `case`/Pattern-Match verengt den Typ einer Variablen in jedem Zweig auf das,
was das jeweilige Pattern beweist — ohne eigene Syntax dafür, das Verengen ist Teil der normalen
Auswertung von Pattern-Matches. Das ist strukturell dasselbe Feature wie JULs branch narrowing
(bereits umgesetzt, siehe die Tests im Abschnitt „branch narrowing" in
[checker.test.ts](../src/checker.test.ts)) — Elixir bestätigt also, dass die Verengung selbst als
allgemeiner Mechanismus (nicht pro Builtin) der richtige Ort ist, und dass ein satztheoretisches
Typsystem sich gut mit Pattern-Match-getriebener Präzisierung verträgt.

**Einordnung für Punkt 4:** Beide Sprachen zeigen, dass „möglichst präziser Typ" dort skaliert, wo
die Faltung ein allgemeines Sprachkonstrukt ist (TS: mapped/conditional types; Elixir: occurrence
typing über Pattern-Matches) statt eine Liste bekannter Namen im Compiler. Das stützt Option B/C aus
der Architekturfrage gegenüber Option A — ist aber kein Argument, die Kandidaten-Prüfung unten
deswegen aufzuschieben: die `And(TypeOf(values) [])`-Konditionierung für `lastElement`/
`toDictionary`/`toList` braucht keine dieser Optionen, nur präzisere core-lib-Deklarationen mit dem
schon vorhandenen Vokabular.

## Kriterium: wann gehört Empty unconditioned in den Rückgabetyp?

Die Analyse von `filterMap` zeigt, dass "`Empty` zu grob" zwei ganz unterschiedliche Ursachen haben
kann, die unterschiedlich behandelt werden:

- **Kardinalitätserhaltende Operationen** (map: genau ein Ergebnis pro Element, keine Filterung)
  dürfen Empty nur dann im Rückgabetyp haben, wenn die Eingabe selbst leer sein kann. Das ist die
  Klasse, die `map` bereits richtig macht: `Or(And(TypeOf(values) []) List(callback/ReturnType))`.
  Bei bekannt nicht-leerer Eingabe (z. B. `[1 2 3]`) entfällt der `And(TypeOf(values) [])`-Zweig zu
  `Never` und damit aus der Union.
- **Filternde/suchende Operationen** (predicate/callback entscheidet pro Element, ob etwas ins
  Ergebnis kommt oder nicht) können unabhängig von der Eingabelänge auf null Treffer kommen.
  Dort ist `Empty` **unconditioned** korrekt — bei ihnen zeigt sich der grobe Rückgabetyp nicht am
  `Empty`-Anteil, sondern daran, ob der Elementtyp erhalten bleibt (das war der eigentliche Fund
  bei `slice`).

Die Einordnung eines Kandidaten in eine der beiden Klassen entscheidet, welcher der beiden Fixes
(falls überhaupt einer) zutrifft.

## Ergebnis filterMap

`filterMap` gehört zur zweiten Klasse: der Callback entscheidet pro Element per `undefined`, ob das
Element ins Ergebnis kommt. Auch wenn `callback/ReturnType` selbst nie `Empty` enthält (z. B.
`:> Integer`) und `values` garantiert nicht-leer ist, bleibt der deklarierte Rückgabetyp
`Or([] List(Without(callback/ReturnType [])))` mit unconditioned `[]` **korrekt**. Der ursprüngliche
rote Test erwartete fälschlich `List(Integer)` als Zieltyp — das wäre unsound, denn `filterMap` darf
immer `Empty` liefern. Der Test testete damit keinen Fehler mehr und wurde ersatzlos aus
[checker.test.ts](../src/checker.test.ts) entfernt. Kein Code-Fix nötig, die generische
Dereferenzierung (`dereferenceArgumentTypesNested`) funktioniert bereits korrekt, auch über eine
Zwischenfunktion hinweg (Parameter, der seinerseits ein Callback weiterreicht).

## Offene Kandidaten und Einordnung (Hypothese, noch zu verifizieren)

| Funktion | Klasse | Hypothese | Nächster Schritt |
|---|---|---|---|
| `lastElement` ([core-lib.jul:642](../src/core-lib.jul#L642)) | kardinalitätserhaltend (genau ein Element, wenn `values` nicht leer) | **Verdacht**: `Or([] TypeOf(values)/ElementType)` ist unconditioned, sollte wie `map` auf `TypeOf(values)` konditioniert sein | Minimalrepro mit `values: List(Integer)` (garantiert nicht leer) gegen Zieltyp `Integer` |
| `findFirst`, `findLast` ([core-lib.jul:590](../src/core-lib.jul#L590), [:609](../src/core-lib.jul#L609)) | filternd/suchend | vermutlich unproblematisch (`Empty` gehört unconditioned dazu, predicate kann immer 0 Treffer haben) | nur Elementtyp-Erhalt prüfen, kein Empty-Fix erwartet |
| `findLastIndex` ([core-lib.jul:628](../src/core-lib.jul#L628)) | filternd/suchend | unproblematisch, analog zu `findFirst` | keiner |
| `toDictionary` ([core-lib.jul:710](../src/core-lib.jul#L710)) | kardinalitätserhaltend (jedes Element wird zu einem Eintrag) | **Verdacht**: `Or([] Dictionary(Any))` unconditioned, Elementtyp zusätzlich zu `Any` verallgemeinert statt `callback`-Rückgabetyp | Minimalrepro wie bei `lastElement`, zusätzlich Elementtyp-Erhalt prüfen |
| `toList` ([core-lib.jul:797](../src/core-lib.jul#L797)) | kardinalitätserhaltend (jeder Dictionary-Eintrag wird zu einem Listenelement) | **Verdacht**: gleiche Klasse wie `toDictionary` | wie oben |
| `getField` ([core-lib.jul:770](../src/core-lib.jul#L770)) | eigene Klasse: Feld kann fehlen, unabhängig von "leer" | vermutlich kein Fund dieser Art — betrifft eher "bekannte vs. unbekannte Felder", nicht `Empty` durch Kardinalität | eigenständig einordnen, nicht Teil dieses Kriteriums |
| `getElement` ([core-lib.jul:448](../src/core-lib.jul#L448)) | index-basiert, kann immer außerhalb liegen | unproblematisch, `Empty` gehört unconditioned dazu | keiner |

## Vorgehen (wie im Audit-Dokument etabliert)

Schritt für Schritt, ein Kandidat nach dem anderen:

1. Minimalrepro mit garantiert nicht-leerer/bekannter Eingabe bauen.
2. Gegen den aktuellen Stand prüfen: meldet der Checker einen Fehler, wo laut obigem Kriterium
   keiner sein dürfte?
3. Nur bei bestätigtem Fund: roter Test mit vollständigem `errors`-Objekt, dann Fix analog zu
   `map` (`And(TypeOf(values) [])`-Konditionierung).
4. Verifikation wie in [CHECKER-AUDIT.md](CHECKER-AUDIT.md#verifikation-nach-jedem-schritt).

## Entscheidung

Noch offen, auf zwei Ebenen:

1. **Architekturfrage** (siehe oben): Sonderbehandlung je Builtin fortführen (A), bedingte Typen als
   Sprachkonstrukt einführen (B), oder ein einziger nativer Mechanismus statt fünf (C). Betrifft vor
   allem zukünftige Funde, die wie `map`s Tuple-Fall echte Typ-Transformation brauchen — die
   `And(TypeOf(values) [])`-Konditionierung selbst ist schon heute rein in core-lib ausdrückbar und
   braucht keinen Checker-Sonderfall.
2. **Je Kandidat**: ob überhaupt ein Fund vorliegt, bevor Zeit in einen Fix fließt. `lastElement`,
   `toDictionary` und `toList` sind die wahrscheinlichsten Kandidaten für einen echten Fund und
   sollten zuerst geprüft werden — mit der `And(TypeOf(values) [])`-Konditionierung ließen sie sich
   voraussichtlich ohne Architekturentscheidung (Option A/B/C) fixen, rein in core-lib.jul.
