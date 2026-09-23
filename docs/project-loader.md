# Gemeinsamer Projekt-Loader ohne IO im Kern

## Context

Stufe 1 der TS-Typannotationen (siehe `jul-compiler/docs/typescript-import-types.md`) wirkt in der
CLI nicht. `compileFile` ([compiler.ts:223-256](jul-compiler/src/compiler.ts#L223-L256)) checkt nur
`.jul`-Dateien; importierte `.ts`/`.json`/`.yaml` bleiben ungecheckt, und ein Import aus einer
ungecheckten Datei liefert `Any` ([checker.ts:3368-3371](jul-compiler/src/checker/checker.ts#L3368-L3371)).
Der Language Server checkt jede Datei, er ist davon also nicht betroffen.

Die Ursache ist Duplikation. Den Ablauf „lesen → parsen → Abhängigkeiten rekursiv → checken“ gibt
es fünfmal, und nur die Kopie im Compiler weicht ab:

- [server.ts:319-349](jul-language-server/src/server.ts#L319-L349) (`parseDocumentByCode` / `parseDocumentByPath`)
- [bench.ts:49](jul-compiler/scripts/bench.ts#L49)
- [checker-snapshot.test.ts:45](jul-compiler/src/checker/checker-snapshot.test.ts#L45)
- [reference-index.test.ts:~18](jul-compiler/src/checker/reference-index.test.ts#L18)
- [compiler.ts:124](jul-compiler/src/compiler.ts#L124) `compileFile`

Zweiter Befund mit derselben Wurzel: Ein fehlender Import wird **doppelt** als JUL3020 gemeldet.
Einmal meldet ihn der Parser über `getImportedPaths`, dann der Checker, weil er
`getPathFromImport` erneut aufruft und den Fehler anhängt
([checker.ts:3359-3362](jul-compiler/src/checker/checker.ts#L3359-L3362)); `checked` ist ein
Klon von `unchecked` und enthält den Parse-Fehler schon. Mit einer Probe geprüft:
`[ '3020 13', '3020 13' ]`. IO (`existsSync`) steckt über `getPathFromImport`
([parser.ts:3231](jul-compiler/src/parser/parser.ts#L3231)) in Parser, Checker und `reference-index.ts`.

Ziel: Parser und Checker machen keine IO mehr. Ein einziger Loader liest die Dateien über einen
übergebenen Host; CLI, Language Server, Bench und Tests nutzen alle ihn. Tests laufen mit
Dateien im Speicher.

**Vorbild:** der `CompilerHost` von TypeScript. `createProgram` liest nur über den Host,
tsserver nutzt denselben Programmaufbau mit Snapshots der offenen Dateien, und „Cannot find
module“ meldet die Auflösung, nicht der Parser. rust-analyzer (VFS), Roslyn (Workspace-Snapshots)
und Go (`go/packages` mit Overlay) folgen demselben Muster.

## Stand

Umgesetzt wie unten beschrieben. Abweichung: Der Checker meldet Import-Fehler weiterhin für
verschachtelte Importe (`a = [import(§x.txt§)]`), denn die sammelt `getImportedPaths` nicht, und
ohne den Checker blieben sie ungemeldet (`isTopLevelImport` in parser.ts). Wirkung: Doppelte
JUL3010/JUL3020 sind weg (Checker-Snapshot: 2 Zeilen in `ui/dynamic-form`), der LSP-Snapshot ist
unverändert, in yugioh sind die `countPreviousConsecutive`-Fehler verschwunden.

## Entscheidungen

- **CLI meldet die Fehler aller Dateien** (wie tsc/csc) und gibt nichts aus, sobald irgendwo ein
  Fehler mit Schweregrad `error` steht. Warnungen werden ausgegeben, blockieren aber nicht (wie heute).
- **Der Language Server wird mit umgestellt**, als letzter Schritt.
- **`fileNotFound` meldet der Loader**, nicht der Parser: Nur er weiß, ob das Lesen gelungen ist.
  Der Fehler kommt in `unchecked.errors` der importierenden Datei, mit der Position des Imports.
  Weil `checkTypes` `unchecked` klont, steht er danach auch einmal in `checked.errors`.
- **Der Checker hängt die Fehler aus `getPathFromImport` nicht mehr an.** Der Parser hat sie
  schon gemeldet (ungültige Endung, dynamischer Import). Damit ist die Verdopplung auch für diese
  Codes behoben.
- Die core-lib lädt der Checker weiter selbst über `parseFile(coreLibPath)`
  ([checker.ts:314](jul-compiler/src/checker/checker.ts#L314)). Sie gehört zum Compiler, nicht
  zum Projekt. Nicht Teil dieses Umbaus.

## Umsetzung

### Schritt 0: roter Test für die doppelte Meldung (dann anhalten)

In [parser.test.ts](jul-compiler/src/parser/parser.test.ts) oder `checker.test.ts`:
`parseCode('(a) = import(§./gibtsnicht.jul§)', '<ausgedachter Pfad>/x.jul')` + `checkTypes`,
erwartet wird genau ein JUL3020. Roten Lauf zeigen, **anhalten**. Den CLI-Bug belegt schon der
rote `compileProject`-Test in [compiler.test.ts](jul-compiler/src/compiler.test.ts); dessen
Nachfolger ohne IO folgt in Schritt 3.

### Schritt 1: Parser und Checker ohne Dateizugriff

- `getPathFromImport` ([parser.ts:3186](jul-compiler/src/parser/parser.ts#L3186)): `existsSync`
  und `fileNotFound` fallen weg, übrig bleiben die Endungsprüfung und `dynamicImportNotAllowed`.
  Kommentar „Prüft extension und file exists“ anpassen.
- `ParsedFile.dependencies` ([syntax-tree.ts:16](jul-compiler/src/syntax-tree.ts#L16)) wird von
  `string[]` zu `ImportedDependency[]` = `{ fullPath: string; source: Positioned }`. `source` ist
  das Pfad-Textliteral des Imports, damit `fileNotFound` genau dort steht. `getImportedPaths`
  füllt beides.
- Checker, case `'import'`: `errors.push(error)` entfällt.
- Schritt 1 und 2 gehören zusammen: Dazwischen wäre `fileNotFound` ganz verschwunden.

### Schritt 2: `jul-compiler/src/project-loader.ts`

```ts
export type SourceReadResult =
	| { type: 'code'; code: string; }
	| { type: 'notFound'; }
	/** vorhanden, aber absichtlich nicht geladen (LSP: > 100 kB) - kein Fehler, der Import bleibt Any */
	| { type: 'skipped'; };

export interface ProjectHost {
	readSource(filePath: string): SourceReadResult;
	referenceIndex?: ReferenceIndex;
	/** Für den Language Server: Abhängigkeitsgraph pflegen. previous ist der ersetzte Stand. */
	onParsed?(parsed: ParsedFile, previous: ParsedFile | undefined): void;
}

/**
 * Parst filePath (mit code: diesen Text statt readSource), lädt die Abhängigkeiten rekursiv und
 * checkt danach die Datei - jede Endung, nicht nur .jul. Eine schon vorhandene Datei wird ohne
 * code nicht neu gelesen, nur nachgecheckt, falls sie noch ungecheckt ist.
 */
export function loadFile(
	filePath: string,
	documents: ParsedDocuments,
	host: ProjectHost,
	code?: string,
): ParsedFile | 'notFound' | 'skipped'
```

- Für eine Abhängigkeit mit `'notFound'` hängt der Loader `fileNotFound` an
  `parsed.unchecked.errors` an, Position `dependency.source`, Meldung wie bisher.
- Zyklen: Wie heute schützt der Eintrag in `documents` vor dem erneuten Betreten. Im Zyklus
  bleibt die Abhängigkeit ungecheckt, der Import liefert `Any`.
- Außerdem exportiert: `createFileSystemHost()` (über `tryReadTextFile` aus
  [util.ts](jul-compiler/src/util.ts)) und `createInMemoryHost(files: Record<string, string>)`.
  Letzteres dient den Tests beider Repos; die Schlüssel werden mit `join` gebildet, wie
  `getPathFromImport` es tut.

### Schritt 3: Tests ohne IO (`project-loader.test.ts`)

Tabellengetrieben, mit `createInMemoryHost`:

- TS-Abhängigkeit wird gecheckt: `util.ts` mit `count(): bigint`, `main.jul` mit
  `wrong: Text = count()` → JUL5000. Das ist der Nachfolger des roten CLI-Tests.
- Fehlende Abhängigkeit → genau ein JUL3020, an der Position des Pfad-Literals.
- `skipped` → kein Fehler, der Import ist `Any`.
- Raute (a → b, a → c, b → d, c → d): jede Datei wird genau einmal gelesen. Dafür zählt der
  In-Memory-Host die Lesezugriffe.
- Zyklus a ↔ b terminiert.
- `code` übergeben: Die Datei wird neu geparst, auch wenn sie schon in `documents` steht.

Der `compileProject`-Test mit Dateien in [compiler.test.ts](jul-compiler/src/compiler.test.ts)
wird gelöscht, die Imports dort auf den alten Stand zurückgesetzt.

### Schritt 4: Compiler auf den Loader umstellen

- `compileProject` ruft `loadFile(entry, documents, host)` auf. Der Host ist `createFileSystemHost`,
  mit einem Cache in einer `Map`, damit der Emit denselben Text bekommt.
- Danach wird über alle `documents` gesammelt: `checked?.errors ?? unchecked.errors`. Nicht beide
  nehmen, denn `checked` enthält die Parse-Fehler schon. Jede Datei wird mit `formatErrors`
  ausgegeben; ist einer der Fehler `severity === 'error'`, ist der Exit-Code 1 und es gibt
  keinen Emit.
- Emit: Der bisherige `switch (extension)` aus `compileFile` wird zu `emitFile(parsed, code, …)`
  und läuft über alle `documents`. Das Shebang bekommt nur die Entry-Datei.
- `compileFile` samt Rekursion entfällt. `LiveRenderer.updateDetail` zeigt die Datei weiterhin an:
  Dafür reicht ein kleiner Hook im CLI-Host bei `readSource`.
- Verhaltensänderung: Parse-Fehler brechen nicht mehr vor dem Checken ab. Die Checker-Fehler
  auf dem unvollständigen Baum erscheinen mit, wie heute schon im Editor.

### Schritt 5: übrige Kopien entfernen

- `bench.ts` und `checker-snapshot.test.ts`: ihr `parseAndCheck` wird durch
  `loadFile(…, createFileSystemHost())` ersetzt. Beide lesen echte Projekte, das ist dort der Zweck.
- `reference-index.test.ts`: `createInMemoryHost` statt eines temporären Ordners, sofern er nur
  dafür Dateien schreibt.

### Schritt 6: Language Server

- `lspHost.readSource`: `tryReadTextFile`, über `maxFileSize` → `skipped`.
  `onParsed`: `unregisterDependencies(previous?.dependencies)` / `registerDependencies`, jetzt mit
  `.fullPath`.
- `parseDocumentByCode(text, path)` → `loadFile(path, parsedDocuments, lspHost, text)`.
- `parseDocumentByPath(path)` → `loadFile(path, parsedDocuments, lspHost)`.
- `recheckDependents` und `onDidChangeWatchedFiles` bleiben unverändert über dem Loader.
- Import: `jul-compiler/out/project-loader.js`.

## Verifikation

- `jul-compiler`: `npm test`, `npm run typecheck`. Die Checker-Snapshot-Baselines dürfen sich nur
  dort ändern, wo JUL3020 bisher doppelt stand. Diff ansehen.
- `npm run build-all`, dann `jul-language-server`: `npm test`, `npm run typecheck`,
  `npm run test-snapshot`. Erwartet ist ein unveränderter Snapshot, bis auf eine doppelte
  JUL3020, falls die dort vorkommt.
- Bench mit `--save`:
  - Compiler: Der Messwert nach Stufe 1 ist die Vorher-Messung, die Nachher-Messung folgt nach Schritt 5.
  - LSP: vor Schritt 6 `build-all` + `npm run bench -- --save --note "vor Loader"`, nachher erneut.
- yugioh, nach `build-all`: `node ../JUL/jul-compiler/out/cli.js jul-config.yaml --check`. Jetzt
  erscheinen die Fehler aller Dateien, und JSON-/TS-Importe sind getypt. Erwartet wird, dass die
  `countPreviousConsecutive`-Stellen (game-logic.jul:211, 235) verschwinden. Neue Fehler einzeln
  einordnen: echte Diskrepanz, Übersetzungsfehler des TS-Parsers oder Folgefehler. Behoben wird
  in yugioh erst nach Rücksprache.

## Doku

- Diesen Plan als `jul-compiler/docs/project-loader.md` ablegen.
- `CLAUDE.md`, Abschnitt Architektur: Schritt 2 der Compiler-Pipeline („Abhängigkeiten rekursiv
  kompilieren“) und „Gehalten wird dieselbe Compiler-Pipeline im Speicher“ beim Language Server
  auf den Loader umschreiben; dazu der Hinweis, dass Parser und Checker keine IO machen.
- `jul-compiler/docs/typescript-import-types.md`: vermerken, dass die CLI-Wirkung von Stufe 1
  an diesem Umbau hing. Danach geht es dort mit Stufe 2 weiter.

## Kritische Dateien

- neu: `jul-compiler/src/project-loader.ts`, `project-loader.test.ts`
- `jul-compiler/src/parser/parser.ts` (`getImportedPaths`, `getPathFromImport`)
- `jul-compiler/src/syntax-tree.ts` (`ParsedFile.dependencies`)
- `jul-compiler/src/checker/checker.ts` (case `'import'`)
- `jul-compiler/src/compiler.ts` (`compileProject`, `compileFile` → `emitFile`)
- `jul-compiler/scripts/bench.ts`, `src/checker/checker-snapshot.test.ts`, `src/checker/reference-index.test.ts`
- `jul-language-server/src/server.ts`
