# Punkt 4: Weitere core-lib-Funktionen mit zu grobem Rückgabetyp

## Stand

`filterMap` ist korrekt typisiert — der ursprüngliche rote Test dafür war falsch, nicht der Checker.
Siehe [Ergebnis filterMap](#ergebnis-filtermap).

Die verbleibenden Kandidaten aus der ursprünglichen Audit-Zeile (`findFirst`, `lastElement`, `toDictionary`, `toList`, ggf. weitere) sind noch nicht einzeln geprüft — dafür ist das Kriterium unten gedacht.

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
  Nebenarbeit von Punkt 4. Deckt weniger ab als es scheint: `getElement`s Sonderfall ist zu allem
  Wesentlichen ein Indexzugriff, kein bedingter Typ. Steht die Position fest, folgt das bedingte
  `Empty` daraus (Index im Tuple → Elementtyp, Index daneben → `Empty`); steht sie nicht fest, ist
  unconditioned `Empty` ohnehin korrekt. `:?` allein würde den Sonderfall also stehen lassen.
- **C — Ein Konstrukt, aber noch nativ.** Statt fünf benannter Sonderfälle ein einziger generischer
  Mechanismus (z. B. eine native Hilfsfunktion, die „Element bei Index, sonst Empty" bzw.
  „bilde jede Tuple-Position ab" allgemein beschreibt), den alle fünf Builtins gleich nutzen. Kein
  neuer Syntax-Entwurf, aber die Ausnahmenliste schrumpft auf einen Fall statt fünf.
- **D — Typkonstruktoren als Pendant zu den Werte-Builtins.** Für jede *allgemeine Typoperation*
  ein Konstruktor neben `And`/`Or`/`Not`/`TypeOf`/`Greater`, mit dem die Werte-Builtins ihren
  Rückgabetyp selbst deklarieren: `getElement` bekäme `:> ElementAt(TypeOf(values) index)` statt
  eines `case 'getElement'`. Siehe [Option D im Detail](#option-d-im-detail).

### Entscheidung

Noch offen; D ist der aussichtsreichste Kandidat. Wichtig für die Reihenfolge: erst diese
Architekturfrage klären, dann die Kandidaten aus der Tabelle unten abarbeiten — sonst entsteht bei
jedem bestätigten Fund erneut derselbe Sonderfall, den design-principles.md schon als falsch
markiert hat.

### Option D im Detail

**Warum die Kategorie stimmt.** Oben stehen zwei Kategorien: Typkonstruktoren dürfen nativ sein,
Werte-Builtins nicht. D verschiebt die Logik von der zweiten in die erste — der Checker kennt
danach den Namen `getElement` nicht mehr, nur noch `ElementAt`.

**Der Mechanismus existiert bereits.** `index` steht bei `ElementAt(TypeOf(values) index)` an der
Argumentposition eines gewöhnlichen Aufrufs, ist also ein normaler `parameterReference` — dieselbe
Auflösung wie `TypeOf(values)` über `dereferenceArgumentTypesNested`. Ist das Argument das Literal
`2`, ist sein Typ `integerLiteral 2` und `dereferenceIndexFromObject` greift. `And`/`Or` machen das
Muster vor: sie bauen einen Knoten, der mit unaufgelöstem Platzhalter darin überlebt und später von
`resolvePlaceholders` gefaltet wird.

**Der Knoten existiert schon: `nestedReference`.** `NestedReferenceType`
([syntax-tree.ts:836](../src/syntax-tree.ts#L836)) trägt genau die Signatur, die
`ElementAt` braucht — Quelle plus Schlüssel — und ist aus core-lib heraus bereits erzeugbar:
`TypeOf(values)/ElementType` in `map`s Deklaration *ist* ein `nestedReference`, der bis zum Aufruf
ungefaltet überlebt und dann von `resolvePlaceholders` aufgelöst wird
([checker.ts:760](../src/checker.ts#L760)). D kostet also **keinen** neuen `CompileTimeType`.
Es bleiben zwei Lücken:

1. **`nestedKey` ist `string | number`** und müsste einen `CompileTimeType` aufnehmen können.
   `ElementAt` wäre dann eine kleine `nativeFunction` in core-lib, die diesen Knoten baut —
   strukturell wie `Not` ([core-lib.jul:44](../src/core-lib.jul#L44)), das seinen `not`-Knoten
   auch nur konstruiert. Folgeänderungen in den Switches, die `nestedKey` anfassen: Gleichheit
   ([checker.ts:2447](../src/checker.ts#L2447)), `typeToString`
   ([checker.ts:3563](../src/checker.ts#L3563)), `dereferenceNestedKeyFromObject`.
2. **Eine Faltungsregel für den nie literal werdenden Schlüssel** — der eigentlich offene Punkt.
   `nestedReference` gilt heute als Platzhalter: `isUnresolvedPlaceholderType` liefert `true`,
   `getTypeError` ist permissiv. Das ist richtig, solange sich der Schlüssel noch auflösen kann.
   Bei `getElement(values index)` mit `index: PositiveInteger` löst er sich nie zu einem Literal
   auf, und dann darf das Ergebnis nicht permissiv „unbekannt" sein, sondern muss
   `Or([] ...ElementTypes)` werden — was `getElementFromTypes` im `case 'tuple'` heute schon tut
   ([checker.ts:1849](../src/checker.ts#L1849)). Der Knoten braucht also neben „aufschieben" ein
   „so weit falten wie möglich, sonst über alle Positionen vereinigen".

**Der Name wird dadurch falsch.** Heute entsteht der Knoten nur, wenn die *Quelle* unaufgelöst ist
(`createNestedReference` wird ausschließlich im `case 'nestedReference' | 'parameterReference'`
gerufen, [checker.ts:333](../src/checker.ts#L333), [checker.ts:436](../src/checker.ts#L436));
„nested **reference**" heißt also wörtlich „aufgeschobene Referenz" und gruppiert sich zu Recht mit
`parameterReference`. Mit typwertigem Schlüssel kommt der Fall „Quelle bekannt, Schlüssel
unaufgelöst" dazu — dann ist es keine Referenz mehr, sondern eine Typoperation. `ElementAt` als
Knotenname wäre aber der umgekehrte Fehler: `nestedKey` trägt Feld- *und* Indexzugriff, und
`TypeOf(values)/ElementType` ist ein Feldzugriff. Zuschnitt deshalb: **ein** Knoten mit neutralem
Namen (`memberAccess`/`keyOf`), darauf **zwei** Konstruktoren `ElementAt(source index)` und
`FieldOf(source §name§)` — geteilte Auflösungslogik wie in `dereferenceNestedKeyFromObject`
([checker.ts:270](../src/checker.ts#L270)), getrennte Oberfläche, weil JUL Index und Name auch im
`nestedKey`-Union unterscheidet ([syntax-tree.ts:423](../src/syntax-tree.ts#L423)).

**Ein Knoten oder zwei?** Für **einen**: er ist der Status quo (zwei Knoten teilen ~55 Stellen auf,
die den Fall heute einheitlich behandeln); die Faltung ist ohnehin geteilt,
`dereferenceNestedKeyFromObject` ist eine Zeile Verzweigung, alles darüber — Rekursion in die
Quelle, `or`-Verteilung, Platzhalterbehandlung, `typeToString` — ist identisch; und zwei Knoten
kosten in gut 30 `julType`-Switches je einen fast gleichen Zweig. Ausschlaggebend: der einzige echte
Nutzen zweier Knoten wäre frühe Fallunterscheidung, und die gibt es nicht — um zu falten, muss der
**aufgelöste** Schlüssel inspiziert werden (`integerLiteral 2` → Position, `textLiteral` → Feld);
ein eigener Knoten erspart diese Prüfung nicht, er dupliziert sie nach oben.

Für **zwei**: unmögliche Zustände wären nicht darstellbar (`elementAt.key: IntegerType` vs.
`fieldOf.key: TextType`); die Fehlerpfade sind verschieden („Feld existiert nicht" mit
`hasKnownFields` gegen „Index liegt daneben" mit `hasKnownLength`,
[checker.ts:277](../src/checker.ts#L277)); und die gültigen Quelltypen überschneiden sich kaum
(Index auf `tuple`/`list`, Feld auf `dictionaryLiteral`/`function`/`stream`/`parameters`).

Kein Argument ist „bei berechnetem Schlüssel kennt man die Art nicht" — man kennt sie am
Konstruktor wie an der Syntax.

Auch die Verträglichkeit von Schlüsselart und Quelltyp taugt nicht als Argument für zwei Knoten.
Der Schlüsselwert selbst wird ohnehin geprüft, weil die Konstruktoren gewöhnliche Funktionen sind
und `index: Integer` bzw. `name: Text` deklarieren. Die Beziehung Quelle↔Schlüssel (Index in ein
Dictionary, Feldname in eine List) hängt dagegen am `julType` der Quelle, und den kann keine
core-lib-Deklaration einschränken: `source: Type` lässt sich nicht auf „Tuple oder List" verengen.
Diese Prüfung bleibt nativ in der Faltung — bei einem Knoten wie bei zweien. Zwei Knoten machen den
Mismatch nur im Schlüsselfeld undarstellbar, nicht dort, wo das Risiko sitzt. Sie fehlt heute schon
(zwei TODOs in `dereferenceNameFromObject`/`dereferenceIndexFromObject`) und steht als eigener
Punkt im Checker-Audit.

**Empfehlung: ein Knoten.** Das stärkste Gegenargument ist der verlorene `string | number`-Schutz,
und der lässt sich billiger auffangen: `nestedKey` wird nicht auf `CompileTimeType` geweitet,
sondern auf `string | number | CompileTimeType`. Der aufgelöste Fall behält seine enge Form, jede
heutige Stelle bleibt gültig, neu zu behandeln ist genau der noch unaufgelöste dritte Fall.

Die Umbenennung ist mechanisch (rund 55 Stellen in checker.ts und server.ts) und berührt die Baselines
nicht, weil `typeToString` weiterhin `source/key` ausgibt.

**Verhältnis zur `/`-Schreibweise.** Derselbe Knoten, aber **nicht** dieselbe Oberfläche: `/` wird
kein Zucker für `ElementAt`. Geteilt wird die Faltung — heute schon laufen beide Wege in
`dereferenceIndexFromObject` (`/` über `case 'index'`, `getElement` über `getElementFromTypes`);
`ElementAt` gibt dieser Faltung nur einen Namen, unter dem core-lib sie aufrufen kann. Ein Zuwachs
entsteht dabei: die `/`-Auswertung ist heute eifrig (faltet sofort oder liefert `Any` samt
`dereferenceFailed`), ein `ElementAt`-Knoten könnte unaufgelöst überleben und später gefaltet werden
— was `nestedReference` für die Quelle bereits tut, für den Schlüssel aber nicht kann.

Eine Desugarung von `/` in den Aufruf verlöre dagegen drei Dinge:

- **Der Schlüssel ist literal, nicht ausgewertet.** `a/index` heißt „Feld namens `index`"; als
  Aufrufargument wäre `index` eine Referenz und würde ausgewertet. Dieselbe Schreibweise kann nicht
  beides — genau deshalb bräuchte eine reine Pfad-Lösung eine *neue* Notation für den berechneten
  Schlüssel.
- **`/` ist auch ein Werteausdruck**, aus dem der Emitter einen Laufzeitzugriff erzeugt. Ein
  Typkonstruktor hat keinen Laufzeitwert; der Zucker gälte also nur im Typkontext.
- **Der Schlüssel verlöre seine Identität für Diagnose und LSP.** Er ist ein `Name`-Knoten mit
  eigener Position: `dereferenceFailed` zeigt auf ihn (mit `hasKnownFields`/`hasKnownLength` als
  Wächter gegen Falschfehler), der Server färbt ihn als `property`, vervollständigt nach `/` die
  Felder des Quelltyps und löst Definition/Hover darüber auf.

Zuschnitt also: `/` bleibt eigene Syntax mit literalem Schlüssel, `ElementAt` ist der benennbare
Konstruktor für den berechneten Fall, beide teilen sich eine Faltungsfunktion.

**Was D über die Pfad-Schreibweise hinaus kann.** Erstens `setElement` und `map`: „bilde jede
Tuple-Position ab" ist über einen Pfadzugriff prinzipiell nicht ausdrückbar, die Fünferliste fällt
also ganz statt nur zu zweien. Zweitens steht der Konstruktor **Nutzercode** offen — wer heute
`getElement` umwickelt, kann den präzisen Rückgabetyp nicht ausdrücken, weil der Sonderfall am
Namen `getElement` hängt.

**Die Gefahr.** Ein Konstruktor pro Standardbibliotheksfunktion wäre dieselbe Ausnahmenliste, nur
großgeschrieben. Schwelle deshalb: nur für allgemeine Typoperationen, nicht pro Funktion. Nach dem
Maßstab bleiben drei — zugreifen (`ElementAt`/`FieldOf` auf einem Knoten), Länge, Tuple-weise
abbilden —, und die bedienen alle fünf
heutigen Sonderfälle.

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
`map` selbst kennen müsste. Das spricht für Option B/D: das fehlende Konstrukt nachzurüsten, statt
jede Fundstelle einzeln im Checker zu behandeln.

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
typing über Pattern-Matches) statt eine Liste bekannter Namen im Compiler. Das stützt Option B/C/D
aus der Architekturfrage gegenüber Option A — ist aber kein Argument, die Kandidaten-Prüfung unten
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

## Entscheidung und Priorisierung

1. **Zuerst die Architekturfrage** (siehe [Architekturfrage](#architekturfrage-sonderbehandlung-im-checker-vs-typsystem)): Sonderbehandlung je Builtin fortführen (A), bedingte Typen als Sprachkonstrukt einführen (B), ein einziger nativer Mechanismus statt fünf (C) oder Typkonstruktoren als Pendant zu den Werte-Builtins (D). Betrifft vor allem zukünftige Funde, die wie `map`s Tuple-Fall echte Typ-Transformation brauchen — die `And(TypeOf(values) [])`-Konditionierung selbst ist schon heute rein in core-lib ausdrückbar und braucht keinen Checker-Sonderfall.

2. **Dann die Kandidaten:** `lastElement`, `toDictionary` und `toList` sind die wahrscheinlichsten Kandidaten für einen echten Fund — mit der `And(TypeOf(values) [])`-Konditionierung ließen sie sich voraussichtlich ohne Architekturentscheidung (Option A/B/C/D) fixen, rein in core-lib.jul.
