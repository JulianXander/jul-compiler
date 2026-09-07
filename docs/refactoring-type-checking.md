# Aufräumung Type Checking

Internes Arbeitsdokument mit begrenzter Lebensdauer: Nach Abschluss von Phase 2 wird es gelöscht,
der bleibende Ertrag wandert in [design-principles.md](design-principles.md) und die offen
gebliebenen Punkte in [TODO](../TODO).

Zweck: den Umbau von `TypeInfo` und der Typ-Auflösung in eine Reihenfolge bringen, die einzeln
committbar ist und sich für die geplanten LSP-Features nichts verbaut.

Bezug: [design-principles.md](design-principles.md), [TODO](../TODO) (Zeile 1: „refactor CompileTimeType
TypeInfo").

## Der Befund

`TypeInfo` hat zwei Typfelder, deren dokumentierter Anspruch („rawType = wie geschrieben,
dereferencedType = aufgelöst") den tatsächlichen Unterschied nicht trifft:

- **`rawType` ist nicht die geschriebene Form.** `dereferenceType` löst Referenzen sofort auf und
  gibt `referencedType.rawType` zurück. Ein `reference`-Knoten trägt nie einen Referenz-Typ.
  Unaufgelöst bleiben nur `parameterReference` und `nestedReference` — der Unterschied der beiden
  Felder betrifft also ausschließlich diese Platzhalter.
- **`dereferencedType` ist verlustbehaftet.** In `dereferenceNested`, case `parameterReference`,
  steht `return { julType: 'any' }`, wenn die Auflösung scheitert. Das Feld taugt daher nur für
  Prüfung und Anzeige, nie zur Weiterverarbeitung.
- **Es gibt keine Invariante, wer welches Feld nimmt** — und die Namen verraten sie nicht. Die
  Entscheidung fällt an 65 Stellen an und ist nur mit Hintergrundwissen zu treffen.

Die eigentliche Aufgabe ist damit nicht, ein Feld zu streichen, sondern die Rollen sichtbar zu
machen: eine verlustfreie Wahrheit am Ausdruck, eine benannte Operation für die verlustbehaftete
Auflösung. Siehe Phase 2.

Ein zweiter, davon unabhängiger Punkt: `rawType` trägt zusätzlich **Herkunftsinformation** — `name`,
`expression`, `filePath` — und die ist unehrlich verteilt. `name` steht in `CompileTimeTypeBase`,
gilt also formal für alle 28 Typen; gesetzt wird er aber nur an zwei Stellen (checker.ts 1108 und
1154), beide Male auf einem `dictionaryLiteral` über `getNameFromValue`. Die name-Parameter von
`createCompileTimeDictionaryType` und `createCompileTimeFunctionType` existieren ausschließlich, damit
`dereferenceNested` etwas weiterreichen kann, das dort nie ankommt. `expression`/`filePath` sitzen
wieder woanders, nämlich nur in `CompileTimeDictionaryLiteralType`. Das war Phase 1.

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
## Phase 1 — Herkunft bündeln (erledigt)

Vor Phase 2, weil dort dieselben `dereferenceNested`-Zweige angefasst werden.

```ts
interface CompileTimeTypeBase {
	/** Der Name der Definition, unter der der Typ an dieser Stelle geschrieben wurde. */
	aliasName?: string;
	/** Woher die Struktur stammt — die einzige Brücke vom Typ zurück zu Symbolen. */
	declaration?: TypeDeclaration;
}

interface TypeDeclaration {
	expression: ParseDictionaryTypeLiteral | ParseDictionaryLiteral;
	/** Leerstring, wenn builtin. */
	filePath: string;
}
```

- `name` sowie `expression`/`filePath` in `CompileTimeDictionaryLiteralType` sind entfallen.
- `createCompileTimeDictionaryLiteralType` hat statt vier Parametern noch drei, davon zwei optional.
- `typeToString` liest `aliasName`, `getSymbolFromDictionaryType` im Server liest `declaration`.

Nebenbei aufgelöst: `ParameterReference` deklariert ein eigenes `name` (den Parameternamen) und
überschrieb damit das gleichnamige Basisfeld. Ein `parameterReference` konnte also nie einen Alias
tragen, und `typeToString` gab an der Alias-Stelle in Wahrheit den Parameternamen zurück. Nach der
Umbenennung sind beide Bedeutungen getrennt.

**Nicht umgesetzt:** die im ursprünglichen Plan vorgesehene *uniforme* Weitergabe der Herkunft in
allen `dereferenceNested`-Zweigen. Sie war mit dem vermuteten Alias-Verlust begründet, und der ist
widerlegt — `list`, `tuple`, `or` und `and` bekommen nie einen Alias. Acht zusätzliche
Durchreichungen, die nie greifen, wären spekulativ.

Belegt durch den Snapshot (unverändert) und die Zählmetrik (identisch: inferType 1982,
dereferenceNested 5158, getTypeError 2179).

## Phase 2 — Ein Feld und eine benannte Operation (erledigt)

### Ergebnis

```
                        vorher      nachher
jul-examples             99 ms        22 ms   4,5x
yugioh                11064 ms      3800 ms   2,9x
apparentType (yugioh) 8449426      2664581    -68%
getTypeError (yugioh)  230343       194158    -16%
```

Der Snapshot ist bis auf eine Zeile unverändert: die Ausnahme in `ui/dialog/dialog.jul` (ein
bestehender Bug, den der Snapshot seit Phase 0 dokumentiert) nennt in ihrer Meldung jetzt den
umbenannten Feldnamen. Kein Verhaltensunterschied.

`getTypeError` sinkt mit, weil Prüfungen jetzt teils auf unaufgelösten Typen laufen, die weniger
Choices haben als ihre Auflösung.

**Kein Cache gebaut.** Der Plan sah vor, erst zu messen, ob die bedarfsgetriebene Auswertung allein
reicht. Sie reicht: 2,9x ohne Cache, und das ungelöste Mutations-Risiko (siehe unten) bleibt damit
aus dem Weg. `apparentType` läuft in yugioh noch rund zehnmal pro inferiertem Ausdruck — ob ein
Cache das weiter senkt, ist eine eigene Messung wert, aber keine Voraussetzung mehr.

### Umgesetzt

- `dereferenceNested` heißt `apparentType`, ist exportiert und dokumentiert den `Any`-Verlust.
- `TypeInfo` hat nur noch `type` — die verlustfreie Form mit intakten Platzhaltern.
- Die rund 30 Doppelrückgaben in `inferType` sind einzeilige `{ type: … }`.
- Im Server decken zwei Helfer die wiederkehrenden Muster ab: `getApparentType(typeInfo)` und
  `getDeclaredApparentType(expression)`.
- Vier `// TODO? woher rawType?` in `getDeclaredType` haben sich erledigt: die Frage entstand nur,
  weil zwei Felder zu füllen waren.
- Ein weiterer vergessener `console.log(type)` in `getTypeMarkdown` ist raus.



Die ursprüngliche Annahme „es gibt nur drei `rawType`-Leser, das zweite Feld ist redundant" ist
falsch. Ausgezählt: **28 Leser von `rawType`** (26 checker, 2 server) und **37 von
`dereferencedType`** (12 checker, 25 server). Beide Felder werden benutzt, und zwar mit sauber
getrennten Aufgaben:

| | wird gelesen für |
|---|---|
| `rawType` | Typkonstruktion und Weitergabe: `functionType.ReturnType = …`, Argumenttypen, Feldtypen |
| `dereferencedType` | Prüfung und Anzeige: `areArgsAssignableTo`, `typeToString` in Meldungen, im Server fast alles |

Der Grund steht in `dereferenceNested`, case `parameterReference`: die Referenz wird durch den
deklarierten Parametertyp ersetzt, und wenn das nicht gelingt, `return { julType: 'any' }`.
**`dereferencedType` wirft Generizität weg.** Wer einen Typ weiterverarbeitet, *muss* `rawType`
nehmen, sonst wird aus einem Typparameter `Any`.

Die Trennung ist also berechtigt. Falsch ist nur, dass sie als zwei gleichrangige Felder auftritt,
deren Namen die Rollen nicht verraten — die Entscheidung „welches nehme ich" fällt an 65 Stellen an
und ist nur mit Hintergrundwissen zu treffen.

### Zielbild

```ts
export interface TypeInfo {
	/** Der Typ mit intakten Platzhaltern (parameterReference, nestedReference). Die eine Wahrheit. */
	type: CompileTimeType;
}

/**
 * Löst Platzhalter über ihre Deklaration auf. Nicht Auflösbares wird zu Any — daher nur für
 * Prüfung und Anzeige geeignet, nie zur Weiterverarbeitung.
 */
export function apparentType(type: CompileTimeType): CompileTimeType;
```

`TypeInfo` behält ein Feld, und zwar das **rohe** — die verlustfreie Form. Die verlustbehaftete
Auflösung wird zur benannten Funktion, die dort steht, wo sie gebraucht wird.

Was das besser macht als zwei Felder plus erklärendem Kommentar:

1. **Beim Lesen gibt es keine Wahl mehr.** `info.type` ist der Typ; wer auflösen will, schreibt es
   hin.
2. **Die Rolle steht am Aufrufort**, nicht in der Datenstruktur. Vorbild Scala 3 (`.dealias`,
   `.widen`, `.underlying`) und TypeScript (`getApparentType`) — beide haben aus gutem Grund kein
   zweites Typfeld am Ausdruck.
3. **Der `Any`-Verlust wird sichtbar.** Heute steckt er in einem Feldnamen, der nach „dasselbe, nur
   aufgelöst" klingt.
4. **Die Auswertung wird bedarfsgetrieben.** Der eager-Pass entfällt damit von selbst: berechnet
   wird nur, was gelesen wird.

Zum Namen: `apparentType` ist bei TypeScript etabliert für „die Form, auf der man arbeitet, wenn man
einen Typ inspiziert", dort aber semantisch etwas anderes (Primitiv → Wrapper). Alternative mit
weniger Vorbelastung: `resolvePlaceholders`. Zu entscheiden beim Bauen; der Doc-Kommentar trägt die
Bedeutung in beiden Fällen.

### Reihenfolge

1. `apparentType` neben `dereferenceNested` anlegen (zunächst identisch), exportieren.
2. **Nur checker.ts umstellen** — 12 Leser. Messen und Snapshot prüfen. Erst danach entscheiden, ob
   der Server folgt. Drei Planannahmen sind in dieser Umbau-Sitzung bei der Umsetzung gefallen;
   eine Probe an einer Datei ist billiger als eine Rücknahme über zwei Projekte.
3. `dereferencedType` aus den `inferType`-Rückgaben entfernen, `TypeInfo` auf `type` reduzieren.
4. server.ts nachziehen (25 Leser, plus die TypeInfo-Literale in `getDeclaredType`).

### Cache — mit offenem Risiko

Der Checker hat heute keinen Cache. Was es gibt: Memoisierung pro AST-Knoten (`setInferredType`
bricht bei gesetztem `typeInfo` ab) und Strukturteilung über Identitätsvergleich in
`dereferenceNested` — letzteres spart Allokation, nicht Berechnung.

Ein `WeakMap<CompileTimeType, CompileTimeType>` in `apparentType` ist naheliegend, hat aber ein
ungelöstes Problem: **Typen sind nicht immutable.** Ein `functionType` wird mit Platzhaltern
erzeugt, an die Parameter-Symbole gehängt (damit `parameterReference.functionRef` darauf zeigt) und
erst danach mutiert — `functionType.ParamsType = …`, `functionType.ReturnType = …`. Wird ein Typ
aufgelöst und gecacht, *bevor* diese Mutation stattfindet, hält der Cache ein falsches Ergebnis fest.

Heute ist das unkritisch, weil `dereferenceNested` unmittelbar nach der Mutation läuft. Lazy
verschiebt die Auswertung nach hinten (tendenziell sicherer), ein Cache macht sie dagegen einmalig
(riskanter). Optionen: Cache pro `checkTypes`-Durchlauf leeren, Typen ohne `parameterReference` vom
Cache ausnehmen, oder die Mutation beseitigen. **Nicht vorab entscheiden** — erst messen, ob die
Lazy-Auswertung allein reicht.

Der zweite Cache-Kandidat bleibt davon unberührt: **Relations-Cache** für
`areArgsAssignableTo`/`getTypeError`. Dieselbe Typpaarung wird heute mehrfach geprüft (jeder Branch
gegen die Argumente, zusätzlich verteilt über `Or`/`And`). Unabhängig vom Umbau nachrüstbar.

**Bedingung:** `dereferenceArgumentTypesNested` darf nicht „mit aufgeräumt" werden. Es ist nicht
redundant zu `apparentType`, sondern die Substitution im *Aufrufkontext* und damit die Grundlage für
mapped types und bedingte Typen. Werden beide Pfade als „das Gleiche" zusammengelegt, sind diese
Features blockiert.

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
