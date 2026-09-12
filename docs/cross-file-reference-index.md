# Persistenter Cross-File Symbol-Index (Rename + Find All References)

> **Umgesetzt.** Zwei Abweichungen gegenüber dem ursprünglichen Plan, beide während der
> Implementierung entschieden:
> - Ein Alias-Binding (`local = source` in einer Import-Destructuring-Zeile) ist eine **eigene
>   Identität**, unabhängig vom Ursprung - `resolveCanonicalSymbol` folgt nur unaliasierten
>   Import-Bindings weiter. Renamen des Ursprungs zieht `source` mit, nicht den lokalen Alias-Namen
>   und dessen Nutzungen; renamen des Alias bleibt lokal. Ohne diese Unterscheidung hätte Rename auf
>   einem Alias fälschlich auch dessen Ursprung (und alle anderen Importeure) mitgezogen.
> - Transitive Invalidierung läuft nur beim Speichern (`onDidChangeWatchedFiles`), nicht bei jedem
>   Tastendruck (`onDidChangeContent`): ein Test mit voller Rechecking-Kaskade beim Tippen führte im
>   Schnelltest über den Beispielordner zu spürbar mehr Rechecks pro Tastenanschlag. Beim Tippen wird
>   weiterhin nur die editierte Datei neu gecheckt (wie vorher); Cross-File-Auswirkungen (Rename,
>   Find-All-References, importierte Typen) sind erst nach dem Speichern der abhängigen Datei
>   vollständig aktuell. Ein späterer Ausbau (z.B. nur bei Änderung der exportierten Symbolform
>   invalidieren statt bei jeder Änderung) ist offen.

## Context

Rename funktioniert aktuell nur innerhalb einer Datei (`// TODO rename across multiple files`,
[server.ts:1135](../../jul-language-server/src/server.ts#L1135)). Go-to-Definition musste kürzlich einen
eigenen Ad-hoc-Resolver (`resolveThroughImports`) bekommen, um durch Importe hindurch in einem statt
zwei Schritten zur echten Quelle zu springen. Beides ist Symptom desselben Lochs: der Checker löst
jede Referenz beim Type-Checking zwar korrekt auf, wirft das Ergebnis danach aber weg
(`checkTypes` klont bei jedem Lauf frisch, siehe [checker.ts:1254](../src/checker/checker.ts#L1254)) —
nichts von dem, was aufgelöst wurde, bleibt über eine Datei hinaus erhalten.

Ziel dieses Plans ist der langfristig beste Endzustand (Migrationskosten explizit ausgeklammert),
performance-getrieben: ein persistenter, inkrementell gepflegter projektweiter Referenz-Index, der
Teil des Checkers ist — analog zu tsserver/rust-analyzer/Roslyn. Rename und ein neues Find-All-References-
Feature werden dann zu reinen Index-Lookups (`O(Treffer)`) statt Suchen (`O(Projekt)`).

## Zielarchitektur

### 1. Stabile Symbol-Identität

`SymbolDefinition` ([syntax-tree.ts:32](../src/syntax-tree.ts#L32)) bekommt ein Feld
`symbolId: string`, vergeben beim Parsen an der Stelle, wo `SymbolTable`s befüllt werden
(`defineSymbol` in [parser-utils.ts:155](../src/parser/parser-utils.ts#L155), plus die
wenigen Inline-Stellen in `parser.ts`). Format: `${filePath}#${startOffsetDerDefinition}`.

Da `checkTypes` nur `structuredClone(document.unchecked)` macht
([checker.ts:1254](../src/checker/checker.ts#L1254)), wird eine beim Parsen vergebene ID
beim Clonen automatisch mitkopiert — der Checker muss dafür nichts Neues tun. Die ID ist nicht über
beliebige Edits hinweg stabil (Offsets verschieben sich, wenn sich Code darüber ändert), aber das ist
unkritisch: sie muss nur für die Lebensdauer eines Check-Laufs eindeutig sein, und genau dann, wenn
sich das ändert (Datei wird neu geparst), wird ihr Index-Shard ohnehin komplett neu aufgebaut (Punkt 3).

### 2. Referenzauflösung festhalten statt verwerfen

Der Checker löst jede `reference`/`name` bereits über `findSymbolInScopesWithBuiltIns`
([checker.ts:627](../src/checker/checker.ts#L627)) auf. Die Cross-File-Auflösung (Import →
Quellsymbol, inkl. Re-Export-Ketten) existiert bisher nur als LSP-Ad-hoc-Logik im Language Server
(`getImportedSymbol`, `resolveThroughImports`, [server.ts](../../jul-language-server/src/server.ts)).

Diese Import-Verfolgung wandert in den Checker (`checker.ts`): beim Auflösen eines
`destructuringField`-Imports wird direkt die kanonische `symbolId` der Ursprungsdeklaration ermittelt
(gleiche Logik wie `resolveThroughImports`, nur auf `symbolId` statt auf dem für LSP-Antworten gebauten
`SymbolInfo`-Shape). An jeder Stelle, an der eine Referenz erfolgreich auflöst (lokal oder cross-file),
wird das Ergebnis zusätzlich in den Index geschrieben — kein neuer Resolve-Aufwand, nur ein Seiteneffekt
auf einer ohnehin stattfindenden Auflösung.

### 3. Persistenter, dateigeshardeter Index

Neues Modul `jul-compiler/src/checker/reference-index.ts`:

```ts
recordReference(symbolId: string, location: { filePath: string; range: Range }): void
getReferences(symbolId: string): Location[]
clearReferencesFromFile(filePath: string): void
```

Intern zwei synchron gehaltene Maps: `referenceFilePath -> Set<{symbolId, location}>` (zum gezielten
Löschen) und `symbolId -> Set<location>` (für schnelle Lookups). Der Index lebt an derselben Stelle
wie `ParsedDocuments` (gleicher Besitzer/Lifetime) — als zusätzliches Feld, nicht als separat
durchgereichtes Objekt, damit Aufrufstellen einfach bleiben.

**Update-Regel:** bevor eine Datei `F` (neu) gecheckt wird, zuerst `clearReferencesFromFile(F)`
aufrufen, dann erst `inferFileTypes` laufen lassen. Gleiches Muster wie das bestehende
"komplett ersetzen statt mergen" bei `parsedDocuments[path]` ([server.ts:188](../../jul-language-server/src/server.ts#L188))
und `document.checked` ([checker.ts:1255](../src/checker/checker.ts#L1255)).

### 4. Transitive Invalidierung über Dateigrenzen

Heute macht `onDidChangeWatchedFiles` ([server.ts:220-259](../../jul-language-server/src/server.ts#L220-L259))
bereits einen naiven Reverse-Dependency-Scan über alle `parsedDocuments`, aber nur eine Ebene tief und
nur beim Speichern — beim Tippen (`onDidChangeContent`) gar nicht (offener TODO,
[server.ts:193-194](../../jul-language-server/src/server.ts#L193-L194)). Für einen korrekten Index muss
das:
- **transitiv** werden (Re-Export-Ketten: A importiert aus B importiert aus C),
- bei **jeder relevanten Änderung** laufen, nicht nur beim Speichern.

Es gibt aktuell keine Reverse-Dependency-Map im Code (nur das Forward-Feld `ParsedFile.dependencies`,
[syntax-tree.ts:16](../src/syntax-tree.ts#L16)). Sie wird als `dependents: Map<filePath,
Set<filePath>>` neu eingeführt und an den bestehenden `parsedDocuments[path] = ...`-Zuweisungsstellen
inkrementell mitgepflegt (kein Full-Scan). Invalidierung dann: Datei F ändert sich → F neu checken →
`dependents` transitiv traversieren (mit Visited-Set gegen Zyklen, gleiches Muster wie
`resolveThroughImports`) → jede betroffene Datei neu checken (baut ihren Index-Shard automatisch neu
auf, siehe Punkt 3).

### 5. Rename und Find All References als dünne Consumer

- **Find All References** (neu, `connection.onReferences`): Symbol unter Cursor auf `symbolId`
  auflösen (Erweiterung der bestehenden `getSymbolDefinition`/`resolveThroughImports`-Kette in
  `server.ts`), dann `getReferences(symbolId)` — direkter Index-Lookup.
- **Rename** ([server.ts:1128](../../jul-language-server/src/server.ts#L1128)): gleiche Auflösung, dann pro
  Fundstelle den passenden Edit erzeugen — normale Referenz bekommt `newName` direkt; ein
  `destructuringField` mit `source`-Alias bekommt nur `source` umbenannt, der lokale Alias-Name bleibt
  unangetastet. Ergebnisse aller Dateien in `WorkspaceEdit.changes` sammeln (bereits die richtige Form,
  `{[uri]: TextEdit[]}`, aktuell nur auf `documentUri` beschränkt,
  [server.ts:1148-1157](../../jul-language-server/src/server.ts#L1148-L1157)).
- Eine gemeinsame Hilfsfunktion `resolveSymbolId(expression, scopes, folderPath): string | undefined`
  ersetzt die bisherige Ad-hoc-Auflösung pro Feature.

## Betroffene Dateien (repräsentativ)

- `jul-compiler/src/syntax-tree.ts` — `symbolId` auf `SymbolDefinition`; Index + `dependents` als
  Teil von/neben `ParsedDocuments`.
- `jul-compiler/src/parser/parser-utils.ts` (`defineSymbol`) + wenige Inline-Stellen in `parser.ts` —
  `symbolId` vergeben.
- `jul-compiler/src/checker/checker.ts` — Referenz-Aufzeichnung an bestehenden Auflösungsstellen;
  `clearReferencesFromFile` zu Beginn von `checkTypes`; Import-Ketten-Auflösung hierher verschoben.
- `jul-compiler/src/checker/reference-index.ts` (neu).
- `jul-language-server/src/server.ts` — `dependents` pflegen; `onDidChangeWatchedFiles`-Invalidierung
  transitiv machen und auch für `onDidChangeContent` greifen lassen; `connection.onReferences` neu;
  `onRenameRequest` auf Index umbauen; `getSymbolDefinition` erweitert um `symbolId`.
- `jul-compiler/src/checker/checker-snapshot.test.ts` (bestehendes Multi-File-Test-Setup als Vorbild)
  + neue `reference-index.test.ts` — Fixtures: Definition + Import in Datei A, Re-Export in B, Nutzung
  in C; Alias vs. Nicht-Alias; Zyklensicherheit; Invalidierung bei Änderung von B.

## Verifikation

- `npm test` in `jul-compiler` (Mocha, tabellengetrieben wie üblich) — neue Fälle für den Index wie
  oben beschrieben, inklusive: Datei ändern → alte Index-Einträge verschwinden, neue sind korrekt.
- Manuell über `vscode-jul-language-service` (`npm run test-deploy`) in einem Mehrdatei-Beispiel aus
  `jul-examples`: Rename eines importierten Symbols (aliasiert und nicht-aliasiert) über mehrere
  Dateien; Find-All-References auf einem exportierten, mehrfach genutzten Symbol.
- `npm run bench` vor/nach in `jul-compiler` (siehe CLAUDE.md-Vorgabe „vor und nach jedem Umbau am
  Checker messen, mit `--save`") — jede Referenzauflösung schreibt jetzt zusätzlich in den Index,
  das liegt im heißen Pfad des Checkers und muss gegen die Baseline verglichen werden.
