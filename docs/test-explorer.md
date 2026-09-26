# Tests im VSCode Test Explorer

## Kontext

`jul test` läuft heute nur im Terminal. Debuggen geht über das JavaScript Debug Terminal oder eine
selbst geschriebene `launch.json` ([source-maps.md](source-maps.md)). Ziel ist die Anbindung an die
Testing API von VSCode:

- ▶ neben jedem `test(...)`, nach dem Lauf grün oder rot;
- „Run“ und „Debug“ für einen Test, eine Datei oder alles;
- ein Fehlschlag erscheint mit Meldung an der Stelle im Editor;
- der Test Explorer in der Seitenleiste.

## Stand

Umgesetzt wie unten beschrieben. Abweichungen und Nebenwirkungen:

- **Die Extension startet nicht das Shim `jul`, sondern dessen `cli.js` direkt mit `node`.** Sie
  sucht dafür im PATH das `jul.cmd` und nimmt die `cli.js` aus dem `node_modules` daneben (Windows),
  sonst den Symlink `jul`. Über die Shell müsste unter Windows jedes Argument von Hand gequotet
  werden, und Testnamen haben Leerzeichen. Der Debug-Modus bekommt die `cli.js` als `program`.
  Die Frage, ob js-debug sich über das `.cmd`-Shim anhängt, stellt sich damit nicht mehr.
- Name und Callback eines `test`-Aufrufs liest ein gemeinsamer Helfer `getTestCallArguments` in
  [parser-utils.ts](../src/parser/parser-utils.ts), daneben `getTestName`. Checker, Emitter und
  Language Server nutzen beide, die beiden eigenen Varianten in Checker und Emitter sind entfallen.
- `checkTestCall` braucht die Argumente nicht mehr als eigenen Parameter.
- Ein neu angelegter `*.test.jul` wird vom Language Server beim Anlegen geladen. Bisher lud der
  Server bei `onDidChangeWatchedFiles` nur schon bekannte Dateien neu, eine neue Testdatei hätte
  im Explorer gefehlt, bis sie jemand öffnet.
- Die Extension aktiviert sich zusätzlich bei `workspaceContains:**/*.test.jul`, damit der Explorer
  auch ohne geöffnete `.jul`-Datei gefüllt ist.
- Nicht geprüft, weil nur interaktiv möglich: der Test Explorer selbst (Baum, Run, Debug,
  Abbruch, Meldungen an der Stelle) und die Färbung in VSCode. Geprüft sind die CLI-Optionen, der
  Report, die Regeln im Checker, die Erkennung im Language Server (Unit-Tests) und der LSP-Snapshot
  (drei `test`-Tokens weniger).

## Entscheidungen

- **Testing API statt Code Lens.** Eine Code Lens bringt Run und Debug, aber keine Ergebnisse im
  Editor, keinen Explorer und kein Wiederholen fehlgeschlagener Tests. Kommt die Testing API
  später, wäre sie überflüssig, denn VSCode zeigt dann das ▶ am Zeilenrand. Die Lens liefe zwar
  auch in anderen Editoren, das Debuggen braucht aber ohnehin Code im Client.
- **Der Name eines Tests ist ein festes Text-Literal, `test` steht auf oberster Ebene, und in einer
  Datei ist jeder Name eindeutig.** Der Name ist die Identität eines Tests: für den Baum im
  Explorer, für `--name` und für die Zuordnung der Ergebnisse. Ein Name aus Interpolation oder
  Referenz, ein `test` in einer Funktion (mehrfach aufgerufen, gleicher Name) und doppelte Namen
  zerstören diese Identität. Sie hätten auch keinen Nutzen, der den Verlust aufwiegt: Ein Fall pro
  Test ist ohnehin die Konvention. Alle drei werden Checker-Fehler. Die bestehenden Tests
  (`jul-examples/fibonacci`, yugioh) erfüllen das schon. Gleiche Namen in verschiedenen Dateien
  bleiben erlaubt, die Identität ist Datei plus Name.
- **`test` ist wie `import` eine Funktion mit Sonderverhalten und wird wie ein Keyword behandelt.**
  Es darf nur direkt aufgerufen werden. Mit `helper = test` und `helper(…)` ließen sich sonst alle
  Regeln oben und die Erkennung im Explorer umgehen, und der Emitter setzte keine Stelle ein.
  Gefärbt wird `test` wie `import` als Keyword, nicht wie eine eingebaute Funktion.
- **Ausgeführt wird mit dem global installierten `jul`**, im Run- wie im Debug-Modus. Das ist
  dasselbe `jul` wie im Terminal und beim Build. Der Baum kommt dagegen vom Language Server, also von
  der Compiler-Kopie in der Extension. Weichen die Versionen ab, kann ein Test im Baum stehen, den
  das globale `jul` anders sieht. Das wird hingenommen.
- **Ergebnisse über eine Report-Datei, nicht über stdout.** `jul test --report <pfad>` schreibt je
  Ereignis eine JSON-Zeile. Das funktioniert im Debug-Modus genauso: Dort startet js-debug den
  Prozess, und die Extension sieht dessen stdout nicht. Die Terminalausgabe bleibt unverändert und
  landet im Run-Modus als Output in den Test Results.
- **Eine Auswahl geht als wiederholbare `--file` und `--name` an die CLI**, ein Prozess je Projekt
  und Art der Auswahl (siehe Schritt 5). Ein Prozess je Test würde jedes Mal das Projekt neu checken.
- **Die Tests findet der Language Server.** Er parst beim Start den ganzen Workspace
  (`onInitialized` in [server.ts](../../jul-language-server/src/server.ts)) und nach jeder Änderung
  neu, kennt also jeden `test(...)` mit Namen und Position. Die Zuordnung zum Projekt (nächste
  `jul-config.yaml` aufwärts) macht die Extension, denn nur sie führt aus.

## Optional, für später

**Ergebnisse live über eine Named Pipe.** Mit der Report-Datei liest die Extension die Ergebnisse
erst nach Prozessende, im Debug-Modus also erst, wenn die Session vorbei ist. Öffnet die Extension
stattdessen einen Pipe-Server (`\\.\pipe\…` unter Windows, ein Unix-Socket sonst) und übergibt
dessen Pfad als `--report`, kommen die Ereignisse, sobald sie feststehen. An der CLI ändert sich
nichts, `appendFileSync` schreibt in eine Pipe wie in eine Datei. Beim Umsetzen prüfen, dass jedes
`appendFileSync` die Pipe neu öffnet und der Server mehrere Verbindungen nacheinander annimmt.

## Umsetzung

### 1. Checker — [checker.ts](../src/checker/checker.ts), [compiler-errors.ts](../src/compiler-errors.ts)

Neue Fehlercodes im Bereich `2700–2799 semantic Tests`, je Enum und `errorInfos`-Eintrag,
Schweregrad `error`:

- `testNameNotLiteral = 2701`: `The name of a test must be a text literal without interpolation.`
  Gemeldet am Namensargument.
- `testNotTopLevel = 2702`: `'test' is only allowed at the top level of a file.` Gemeldet am Aufruf.
- `duplicateTestName = 2703`: `Duplicate test name '<name>' in this file.` Gemeldet am Namensargument
  jedes weiteren Vorkommens, nicht am ersten.
- `testNotCalled = 2704`: `'test' can only be called directly.` Gemeldet an jeder Referenz auf
  `test`, die nicht selbst die aufgerufene Funktion eines Aufrufs ist (`f = test`, `map(xs test)`).
  Die Präfixform `§name§.test(…)` bleibt erlaubt, der Emitter unterstützt sie schon.

2704 prüft der Checker im `case 'reference'`, am Namen wie die übrigen Sonderfälle (sicher wegen
JUL4003), über den `parent` der Referenz. 2701 und 2702 prüft `checkTestCall`, nach der bestehenden Prüfung auf JUL2700 und unabhängig von
`hasArgumentError`. „Oberste Ebene“ heißt: Der Aufruf ist selbst ein Top-Level-Ausdruck der Datei
(kein `parent`). Beim Umsetzen prüfen, ob der Parser das für Top-Level-Ausdrücke so setzt. 2703
braucht alle Tests der Datei: ein Durchlauf über die Top-Level-Ausdrücke am Ende von `checkTypes`,
nur für `*.test.jul`. Den Namen eines Aufrufs liest ein gemeinsamer Helfer (`getTestName`, gibt
`undefined` bei nicht literalem Namen), den auch der Language Server nutzt (Schritt 4).

### 2. Test-Runtime und Compiler — [test-runtime.ts](../src/test-runtime.ts), [compiler.ts](../src/compiler.ts)

- `TestResult` bekommt `failureLocation?: TestLocation` und `durationMs: number`.
  `getTestFailureText` hängt die Stelle nicht mehr an die Meldung, das macht `formatTestResult`.
  Die Terminalausgabe bleibt gleich (`threw boom (src\lib.jul:3:2)`).
- `_runTests(report, names?: string[])` statt eines einzelnen Namens.
- `testProject(rootFolder, outputFolderPath, { files, names, reportPath })`:
  - `files` schränkt ein, welche Testdateien geladen werden. Verglichen wird über `resolve`. Eine
    angegebene Datei, die keine `*.test.jul` unterhalb des Projekts ist, ist ein Fehler
    (Exit-Code 1).
  - Mit `reportPath` schreibt ein Report-Writer je Ereignis eine Zeile per `appendFileSync`, sofort
    und nicht erst am Ende. So bleiben die Ergebnisse bis zu einem Absturz erhalten. Die Datei wird
    zu Beginn geleert. Pfade sind absolut, Positionen 1-basiert wie in `TestLocation`:
    - `{ "type": "result", "file", "name", "location", "failure"?, "failureLocation"?, "durationMs" }`
    - `{ "type": "compileFailed", "errors": [{ "file", "row", "column", "message" }] }`, nur Fehler
      mit Schweregrad `error`. Dafür eine strukturierte Variante neben `reportErrors`.
    - `{ "type": "finished", "testCount", "failedCount", "skippedCount" }`
  - `file` ist die Testdatei. Die heutige `location.file` ist relativ zum Arbeitsverzeichnis und
    wird für den Report mit `resolve` absolut gemacht.

### 3. CLI — [cli.ts](../src/cli.ts)

- Optionen können wiederholbar sein: `knownOptions` bekommt `repeatable?: true`, `optionValues`
  wird `Record<string, string[]>`. Die Meldung „given more than once“ bleibt für die übrigen.
- `--name` wird wiederholbar: Ein Test läuft, wenn sein Name unter den angegebenen ist.
- Neu `--file <path>` (wiederholbar): nur diese Testdateien. Neu `--report <path>`: Ereignisse als
  JSON-Zeilen in diese Datei.
- Beide nur für `test`, Beschreibungen für `help` in `knownOptions`.

### 4. Language Server — neues Modul `test-discovery.ts`

- `findTests(parsed: ParsedFile): { name: string; range: Range; }[]`: die Top-Level-Aufrufe von
  `test` mit literalem Namen (über `getTestName` aus Schritt 1), `range` über den ganzen Aufruf.
  Nur für `*.test.jul`, sonst leer.
- In [server.ts](../../jul-language-server/src/server.ts) nur die Verdrahtung:
  - Request `jul/tests` → `{ uri, tests }[]` für alle geparsten Testdateien.
  - Notification `jul/testsChanged` → `{ uri, tests }` nach jedem Parse einer Testdatei, bei
    gelöschter Datei mit `tests: []`. Einhängen dort, wo der Server über `onParsed` schon den
    Abhängigkeitsgraphen pflegt.

### 5. Extension — neues Modul `src/test-explorer.ts`, aufgerufen aus [extension.ts](../../vscode-jul-language-service/src/extension.ts)

- `tests.createTestController('julTests', 'JUL')`. Je Testdatei ein Item (Label: Pfad relativ zum
  Workspace), darunter je Test ein Item mit `id = name` und `range`.
- Befüllen nach dem Start des Clients über `jul/tests`, danach über `jul/testsChanged`.
- Zwei Run Profiles, `Run` (Standard) und `Debug`, mit demselben Handler:
  1. Die angeforderten Items auflösen (`include`/`exclude`, ohne `include` alle) und je Projekt
     gruppieren. Projekt ist die nächste `jul-config.yaml` aufwärts von der Testdatei, innerhalb
     des Workspace-Ordners.
  2. Je Projekt bis zu zwei Aufrufe: ganze Dateien als `--file a --file b`, einzelne Tests als
     `--file x --name n1 --name n2`. Getrennt, weil `--name` sonst auch die ganzen Dateien
     einschränken würde. Gleich benannte Tests in anderen der gewählten Dateien laufen mit, ihre
     Ergebnisse werden ebenfalls eingetragen.
  3. Argumente: `test --config <cfg> --report <tmp> [--file …] [--name …]`, `cwd` ist der
     Projektordner. Die Report-Datei liegt in `os.tmpdir()` und wird danach gelöscht.
  4. Vorher `run.started` für alle betroffenen Items.
- **Run:** `spawn('jul', args, { cwd, shell: process.platform === 'win32' })`, weil `jul` unter
  Windows ein `.cmd`-Shim ist. stdout und stderr gehen über `run.appendOutput` in die Test Results
  (`\n` → `\r\n`, das Output-Terminal braucht es). Abbruch über das Token → `kill()`.
- **Debug:** `debug.startDebugging(workspaceFolder, { type: 'node', request: 'launch',
  runtimeExecutable: 'jul', args, cwd, skipFiles: [...], console: 'integratedTerminal' })`, dann
  auf `debug.onDidTerminateDebugSession` für genau diese Session warten. Abbruch über das Token →
  `debug.stopDebugging(session)`. Beim Umsetzen prüfen, dass js-debug sich über das `.cmd`-Shim an
  den Node-Prozess hängt. Wenn nicht: `program` auf `<npm root -g>/jul-compiler/out/cli.js`.
- **Auswertung** nach Prozess- bzw. Session-Ende, Zeile für Zeile aus der Report-Datei:
  - `result` → Item über Datei und Name. Bestanden: `run.passed(item, durationMs)`, sonst
    `run.failed(item, message, durationMs)` mit `message.location` = `failureLocation` ?? `location`
    (1-basiert → `Position` 0-basiert). Ein Ergebnis ohne Item (Baum noch nicht aktualisiert) wird
    angelegt.
  - `compileFailed` → `run.errored` für jedes angeforderte Item dieses Aufrufs, mit den Fehlern als
    Meldungen samt Stelle.
  - Angefordert, aber ohne Ergebnis → `run.skipped`.
  - Keine Report-Datei und Exit-Code ≠ 0 (etwa `jul` nicht gefunden) → `run.errored` mit dem Hinweis
    auf `npm i -g jul-compiler` und dem Output.

### 6. Färbung — [jul.tmLanguage.yaml](../../vscode-jul-language-service/syntaxes/jul.tmLanguage.yaml), [server.ts](../../jul-language-server/src/server.ts)

Wie bei `import`:

- Grammatik: eine Regel `test-call.jul` mit `begin: "\\b(test)\\("` (YAML-Schreibweise wie bei
  `import-call.jul`) und dem Scope `keyword.control.test.jul` für das Capture, vor der allgemeinen
  Regel `function-call.jul`. Sie greift auch bei der Präfixform `§a§.test(…)`. Dazu `test` ohne
  folgende Klammer (Deklaration in der core-lib) über eine Regel wie `keyword.control.import.jul`. Danach `npm run convert-grammar`, die YAML ist die Quelle.
- Semantic Tokens: `collectSemanticTokens` lässt `test` bei `reference` und `definition` aus, wie
  heute `import`. Sonst übermalte der Tokentyp einer eingebauten Funktion die Keyword-Farbe. Die
  beiden Namen in eine gemeinsame Liste ziehen, statt die Bedingung zu verdoppeln.

### 7. Tests (Mocha)

- [checker.test.ts](../src/checker/checker.test.ts), im bestehenden `describe('test builtin')`, je
  Fall ein `it`:
  - Name mit Interpolation → JUL2701; Name als Referenz → JUL2701; Text-Literal → keine Meldung.
  - `test` in einem Funktionsrumpf → JUL2702.
  - Zwei Tests gleichen Namens → JUL2703 am zweiten, nicht am ersten; verschiedene Namen → keine.
  - Gleicher Name in zwei Dateien → keine Meldung (über `createInMemoryHost`).
  - `f = test` → JUL2704; `test` als Argument → JUL2704; Präfixform `§a§.test(() => true)` →
    keine Meldung.
- [test-runtime.test.ts](../src/test-runtime.test.ts): `failureLocation` strukturiert statt in der
  Meldung; Filter mit mehreren Namen; `durationMs` vorhanden.
- [compiler.test.ts](../src/compiler.test.ts): `formatTestResult` hängt `failureLocation` an; der
  Report-Writer schreibt eine JSON-Zeile je Ereignis mit absoluten Pfaden (Datei in `os.tmpdir()`).
- Language Server: neues `test-discovery.test.ts` über `createInMemoryHost`: findet literale
  Namen samt Range; leer für Nicht-Testdateien; übergeht Aufrufe in Funktionen und nicht literale
  Namen.
- Semantic Tokens: `test` bekommt keinen Token (LSP-Snapshot `npm run test-snapshot` zeigt die
  Änderung, sofern ein Beispiel `test` enthält; sonst ein Fall in der Snapshot-Eingabe).
- Extension, Grammatik und CLI-Parsing haben keine Testinfrastruktur, dort Verifikation von Hand.

### 8. Doku

- `jul-homepage/docs/docs/documentation/handbook.md`, Abschnitt „Tests“: die drei Regeln, `--file`,
  mehrfaches `--name`, `--report` mit dem Format, ein Absatz zum Test Explorer in VSCode.
  Abschnitt „Debuggen“: Debug über den Test Explorer vor dem Debug Terminal nennen.
- `error-codes.md`: Abschnitte JUL2701–2704 im bestehenden Format.
- `jul-compiler/README.md` und Root-`CLAUDE.md` (CLI-Block): `--file`, `--report`.
- `jul-compiler/TODO`: die Punkte „code lens run test“ und „warnung bei doppelten testnamen“
  entfallen, stattdessen ein Verweis auf dieses Dokument.

## Verifikation

1. Vorher und nachher `npm run bench -- --save --note "..."` in `jul-compiler` (Checker-Umbau).
2. `npm run typecheck && node --run test` in `jul-compiler`; Checker-Snapshot und Zähler-Baseline
   ansehen (`npm run test-update-snapshot` nur mit Blick auf den Diff).
3. `npm run build-all`, `cd jul-language-server && npm test && npm run test-snapshot`.
4. CLI in `jul-examples/fibonacci`:
   - `jul test --name a --name b`, `jul test --file fibonacci.test.jul`, unbekannte `--file` →
     Exit-Code 1.
   - `jul test --report r.jsonl` → eine Zeile je Test plus `finished`; mit einem Kompilierfehler
     `compileFailed`.
5. `npm run install-cli`, `npm run test-deploy` in der Extension, dann in VSCode mit `jul-examples`
   als Workspace (mehrere Projekte) und mit yugioh:
   - `test` ist in `*.test.jul` als Keyword gefärbt, auch nach dem Nachladen der Semantic Tokens.
   - Baum zeigt alle Testdateien und Tests; Umbenennen eines Tests aktualisiert ihn.
   - Run für einen Test, eine Datei, alles; ein fehlschlagender Test zeigt die Meldung an der Stelle.
   - Debug für einen Test hält am Breakpoint in der `.jul`-Datei, danach steht das Ergebnis im Baum.
   - Kompilierfehler → Items als errored mit der Fehlerstelle.
   - Abbruch während eines Laufs beendet den Prozess bzw. die Debug-Session.
