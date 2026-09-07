# Aufräumung Type Checking

Internes Arbeitsdokument. Zweck: den Umbau von `TypeInfo` und der Typ-Auflösung in eine Reihenfolge
bringen, die einzeln committbar ist und sich für die geplanten LSP-Features nichts verbaut.

Bezug: [design-principles.md](design-principles.md), [TODO](TODO) (Zeile 1: „refactor CompileTimeType
TypeInfo").

## Der Befund

`TypeInfo` hat zwei Typfelder, deren dokumentierter Anspruch („rawType = wie geschrieben,
dereferencedType = aufgelöst") vom Code nicht eingehalten wird:

- **`rawType` ist nicht die geschriebene Form.** `dereferenceType` löst Referenzen sofort auf und
  gibt `referencedType.rawType` zurück. Ein `reference`-Knoten trägt nie einen Referenz-Typ.
  Unaufgelöst bleiben nur `parameterReference` und `nestedReference`.
- **`dereferencedType` ist nicht lazy.** `dereferenceNested(rawType)` läuft eager bei jedem
  `inferType` — an rund 25 Stellen. Der einzige Grund für ein zweites Feld (Auflösung aufschieben,
  bis der Aufrufkontext bekannt ist) entfällt damit, die Kosten bleiben.
- **Es gibt keine Invariante, wer welches Feld nimmt.** Zuweisbarkeit nutzt `dereferencedType`,
  Branch-Narrowing `rawType` (checker.ts, case 'branching'), SignatureHelp im Server greift auf
  `rawType.name` zu, um darüber ein Symbol zu suchen.

`rawType` wird faktisch nicht als unaufgelöster Typ gebraucht, sondern als Träger von
**Herkunftsinformation** — `name`, `expression`, `filePath`. Zwei verschiedene Sachen in einem
Feldpaar: Auflösungsstand und Herkunft.

Die Herkunft ist dabei nicht kaputt, aber unehrlich verteilt: `name` steht in `CompileTimeTypeBase`,
gilt also formal für alle 28 Typen — gesetzt wird er aber nur an zwei Stellen (checker.ts 1108 und
1154), beide Male auf einem `dictionaryLiteral` über `getNameFromValue`. Die name-Parameter von
`createCompileTimeDictionaryType` und `createCompileTimeFunctionType` existieren ausschließlich, damit
`dereferenceNested` etwas weiterreichen kann, das dort nie ankommt. `expression`/`filePath` sitzen
wieder woanders, nämlich nur in `CompileTimeDictionaryLiteralType`.

Ein früher vermuteter Alias-Verlust in den Zweigen `list`, `tuple`, `or`, `and` ist **nicht**
reproduzierbar: diese Knoten tragen nie einen Namen. Der Snapshot belegt das Gegenteil —
`myFunction1: (a: MyType) :> Empty` zeigt den Alias korrekt an.

## Herkunft bleibt am Typknoten

Ein früherer Vorschlag, `name`/`expression`/`filePath` nach `TypeInfo` zu verschieben, ist falsch:
`getSymbolFromDictionaryType` im Language Server liest `expression?.symbols[name]` auf einem
**verschachtelten** Typknoten, nicht auf dem Typ des Ausdrucks. Verschoben ginge Go-to-Definition auf
Feldern kaputt, und die geplante Feld-Completion mit Descriptions wäre nicht baubar.

Vorbild TypeScript: `type.symbol` (Struktur-Deklaration) und `type.aliasSymbol` (Alias an dieser
Schreibstelle) sind getrennt, weil sie verschiedene Lebensdauern haben. Beim Dereferenzieren muss der
Alias verworfen werden können, die Strukturherkunft nie.

## Phase 0 — Sicherheitsnetz

Der Umbau ist verhaltenserhaltend gemeint und betrifft jeden Typknoten. Ohne Baseline ist eine
Regression nicht von Absicht zu unterscheiden.

1. **Snapshot-Test über `typeToString`** — läuft über `jul-examples`, gibt je Top-Level-Definition den
   gerenderten Typ und alle Fehlercodes aus, vergleicht gegen eine eingecheckte Baseline. Die
   tabellengetriebenen Tests in `checker.test.ts` decken nur ausgewählte Fälle ab.
2. **Zählmetrik als regulärer Test** — erzeugte Typobjekte und Auflösungsaufrufe beim Checken einer
   festen Datei, gegen eine eingecheckte Zahl. Zweck ist ausschließlich Performance-Regression:
   Phase 2 verschiebt Arbeit von „einmal eager pro Knoten" zu „on demand, evtl. mehrfach", und ohne
   Zahl ist nicht feststellbar, ob das netto gewinnt. Deterministisch, daher CI-tauglich — anders als
   eine Zeitmessung.
3. **`npm run bench`** — Wall-Clock über die Beispiele und über `C:\Projects\privat\yugioh`
   (~5800 Zeilen, der einzige realistisch große Datensatz). Kein Test-Gate, nur Beleg. Einmal vor
   Phase 1 laufen lassen.
4. **Vergessene `console.log` entfernen** — checker.ts 201 (`'functionRef missing'`) und 457
   (`console.log(scopes)`). Sie verfälschen jede Messung und landen in CLI-Ausgabe und LSP-Kanal.
### Baseline vom 2026-09-07

```
jul-examples    27 Dateien,  885 Zeilen   median    99 ms
                inferType 1982, dereferenceNested 5158, getTypeError 2179
yugioh          10 Dateien, 5847 Zeilen   median 11064 ms
                inferType 273148, dereferenceNested 8449426, getTypeError 230343
```

Das rechtfertigt Phase 2 empirisch: `dereferenceNested` läuft in yugioh **31 mal pro inferiertem
Ausdruck**, in den Beispielen nur 2,6 mal. Bei 6,6-facher Zeilenzahl steigt `inferType` um Faktor 138,
`dereferenceNested` aber um Faktor 1638 — der eager Pass wächst also nochmal um eine Größenordnung
schneller als die Menge der Ausdrücke. Die große Streuung (min 4,4 s, max 14,2 s) deutet auf
GC-Druck durch die erzeugten Typobjekte.

11 Sekunden für 5800 Zeilen erklären zugleich, warum der Language Server bei größeren Projekten
träge wird.
## Phase 1 — Herkunft bündeln

Vor Phase 2, weil dort dieselben `dereferenceNested`-Zweige angefasst werden.

```ts
interface CompileTimeTypeBase {
	/** Alias-Name der Definition, unter der der Typ an dieser Stelle geschrieben wurde. */
	aliasName?: string;
	/** Struktur-Herkunft: Feld-Symbole, Descriptions, Go-to-Definition. */
	declaration?: TypeDeclaration;
}

interface TypeDeclaration {
	expression: ParseDictionaryTypeLiteral | ParseDictionaryLiteral;
	/** Leerstring, wenn builtin. */
	filePath: string;
}
```

- `name` sowie `expression`/`filePath` in `CompileTimeDictionaryLiteralType` entfallen.
- Die `create…`-Funktionen verlieren ihre angehängten Herkunftsparameter;
  `createCompileTimeDictionaryLiteralType` schrumpft von vier Parametern auf zwei.
- `dereferenceNested` reicht die Herkunft **uniform** in jedem Zweig weiter, statt sie pro Fall
  unterschiedlich zu behandeln.
- `typeToString` liest `aliasName`, `getSymbolFromDictionaryType` liest `declaration`.

Gewinn: Herkunft wird zu einer Sache mit einer Weitergaberegel statt vier Feldern mit acht
Sonderfällen (Prinzip 2).

## Phase 2 — Ein Typfeld

1. **Die drei verbleibenden `rawType`-Leser umstellen.**
   - Branch-Narrowing (checker.ts, case 'branching') nimmt bewusst `rawType`. Prüfen, ob das Absicht
     ist — Narrowing auf einem unaufgelösten `parameterReference` verengt vermutlich nichts.
   - `dereferenceType` gibt `referencedType.rawType` zurück. Das ist die einzige Stelle, an der die
     unaufgelöste Form wirklich gebraucht wird.
   - SignatureHelp sucht ein Symbol über `rawType.name`. Diese Krücke ersetzt `declaration` aus
     Phase 1 — der Name muss nicht mehr per Scope-Suche zurückübersetzt werden.
2. **`TypeInfo` auf ein Feld reduzieren.** Ob das Interface dann noch bleibt, ist bewusst zu
   entscheiden (Anker für spätere Erweiterung, vgl. TODO Zeile 2) — nicht mitzuschleppen.
3. **Statt `dereferencedType` benannte Operationen.** Vorbild Scala 3 (`.dealias`, `.widen`,
   `.underlying`) und TypeScript (`instantiateType`, `getApparentType`): die Rolle steht am
   Aufrufort, nicht in der Datenstruktur.
   - `instantiate(type, args)` — die Substitution im Aufrufkontext, heute
     `dereferenceArgumentTypesNested`
   - `apparentType(type)` — die Form, auf der Feldzugriff und Zuweisbarkeit arbeiten
4. **Eager-Pass entfernen.** `dereferenceNested(rawType)` verschwindet aus den `inferType`-Rückgaben.
   Nicht auflösbare `parameterReference`/`nestedReference` bleiben als Knoten stehen — bereits heute
   das Verhalten, und deckungsgleich mit Prinzip 4.
5. **Memoisierung.** Der Checker hat heute keinen einzigen Cache. Was es gibt, ist Memoisierung pro
   AST-Knoten (`setInferredType` bricht bei gesetztem `typeInfo` ab) und Strukturteilung über
   Identitätsvergleich in `dereferenceNested` — letzteres spart Allokation, nicht Berechnung.
   Zwei Kandidaten, beide bei TS vorhanden (`instantiations`, `assignableRelation`/`subtypeRelation`):
   - **Instanziierungs-Cache** für `instantiate`. Ohne ihn kann on-demand-Auflösung im schlechten
     Fall mehr Arbeit bedeuten als der heutige eager-Pass — genau das misst die Zählmetrik.
   - **Relations-Cache** für `areArgsAssignableTo`/`getTypeError`. Dieselbe Typpaarung wird heute
     mehrfach geprüft: jeder Branch gegen die Argumente, zusätzlich verteilt über `Or`/`And`.
     Unabhängig vom Umbau nachrüstbar, deshalb erst nach der Bench-Zahl entscheiden.

**Bedingung:** `dereferenceArgumentTypesNested` darf nicht „mit aufgeräumt" werden. Es ist nicht
redundant zum eager-Pass, sondern die Grundlage für mapped types und bedingte Typen. Werden beide
Pfade als „das Gleiche" zusammengelegt, sind diese Features blockiert.

## Nachgelagert

- **Mapped types über Tuples** — ersetzt die fünf Sonderfälle `getElement`, `lastElement`, `length`,
  `setElement`, `map`. Ändert, *was* das Typsystem ausdrücken kann, nicht *wie* Typen gespeichert
  werden; nach Phase 2 sauber nachlagerbar, solange die Bedingung oben eingehalten wird.
- **Cross-file Rename** — heute nicht gebaut (`// TODO rename across multiple files` in server.ts).
  Fehlt: `filePath` an `SymbolDefinition` (Identität hängt an Objektidentität der `definition`), ein
  Reverse-Index „wer importiert mich" (`dependencies` zeigt nur vorwärts), und die Behandlung des
  Import-Alias (`destructuringField` mit `source`). Derselbe Reverse-Index wird für Find-References
  und Document Highlight gebraucht.

## Verworfen

- **Eigener `unknown`-Typ neben `Any`** für „Checker hat aufgegeben" vs. „bewusst untypisiert".
  Begründet wurde er mit Fehlerkaskaden, Hover-Auskunft und Metrik. Die Kaskaden gibt es nicht:
  `dereferenceNameFromObject` hat einen `case 'any'`, `hasKnownFields` schließt `Any` aus,
  `isDefinitelyNotCollectionType` fällt im Default auf `false`, `checkIsFunction` läuft über
  `areArgsAssignableTo` — `Any` unterdrückt zuverlässig. Die Metrik hätte keinen Adressaten. Bleibt
  eine Hover-Nuance, und dafür wäre ein Typ, der sich in der Zuweisbarkeit identisch zu `Any`
  verhält, ein zweiter Weg für dieselbe Sache (Prinzip 3). `Any` heißt bereits „kann alles sein".
- **Typeguards an der Any-Grenze zur Laufzeit prüfen.** `_callFunction` nutzt `assignArgs` ohne
  Check, `_branch` nutzt `tryAssignArgs` mit Check — JUL prüft also beim Branch-Matching, beim
  direkten Aufruf nicht. Das ist ein Laufzeit-Thema (graduelle Typisierung) und gehört nicht in eine
  Aufräumung der Compilezeit-Repräsentation.

## Reihenfolge

Phase 0 → Phase 1 → Phase 2 → Bench-Vergleich → danach frei: Reverse-Index/Rename oder mapped types.
