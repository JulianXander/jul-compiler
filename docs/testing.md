# Test-MVP für JUL-Code

## Kontext

JUL hat bisher kein Testframework für in JUL geschriebenen Code (`jul-compiler/TODO`: „unit testing
konzept für jul"). Entschieden wurde im Gespräch:

- Ein Builtin `test(message: Text callback: () :> Boolean)` — ein Test ist eine Bedingung,
  Prüflogik baut man mit normalen Funktionen (`equal`, `deepEqual`, `and`, eigene Helfer).
- Der Checker meldet einen Fehler, wenn der Callback statisch zu `false` faltet (Feedback beim
  Tippen, weil constant folding für reine Aufrufe schon existiert).
- `jul --test` führt alle Tests zur Laufzeit aus und meldet Name, `.jul`-Position und die Werte
  der Argumente des äußersten Aufrufs im Callback (z. B. `equal(§Fizz§ §FizzBuzz§)`).
- Tests stehen ausschließlich in `*.test.jul`-Dateien (fest, kein Config-Eintrag); `test` in
  einer anderen Datei ist ein Fehler.
- Statisch fehlschlagender Test: Schweregrad `error`.
- Der normale Build enthält nie Testdateien: er lädt ohnehin nur Entry + Importe, und eine
  Nicht-Testdatei darf keine `*.test.jul` importieren (neuer Fehler).
- Der Testlauf schreibt nichts auf die Platte und bündelt nicht: das erzeugte JS wird im Speicher
  gehalten und über `module.registerHooks` (Node ≥ 22.15, hier Node 24) direkt im Compilerprozess
  geladen.

Bewusst **nicht** im MVP: `is` mit Checker-Regel, Reporter-Sonderbehandlung für `is`/`deepEqual`,
Stream-/Async-Tests, virtuelle Zeit, Code Lens, Instrumentierung tiefer als der äußerste Aufruf,
Aufrufe mit Dictionary-Argumenten instrumentieren.

## Stand

Umgesetzt wie unten beschrieben. Abweichungen und Nebenwirkungen:

- Register, `test`, `_testCall` und `_runTests` liegen nicht in `runtime.ts`, sondern in
  `test-runtime.ts`. Nur `*.test.jul`-Dateien importieren sie (der Emitter setzt den Import neben
  den der Runtime), dazu der Compiler für `_runTests`. Da Testdateien nie in einen normalen Build
  kommen, ist das Testgerüst dort nicht enthalten. Tree Shaking hätte das nicht geleistet: webpack
  läuft ohne Minifizierung, und `runtime.ts` hat Seiteneffekte auf Modulebene. `runtime.ts`
  exportiert dafür `_typeToString` und `_StreamClass`, die es intern ohnehin hat.
- JSON-/YAML-Importe werden jetzt mit `with { type: 'json' }` statt `assert` emittiert
  (`getImportJs`). Node 24 kennt `assert` nicht mehr, webpack verarbeitet `with` im normalen
  Build ebenso.
- Die Prüfung auf JUL3050 sitzt im Parser (`getImportedPaths`), nicht im Loader: Sie hängt nur an
  den beiden Pfaden.
- `test` ist ein neuer Name im obersten Scope. Wer ihn selbst definiert, bekommt JUL4003, auch in
  eingebundenen `.ts`/`.js`-Dateien. Umbenannt wurden deshalb `test` in
  `jul-examples/fibonacci/fibonacci.jul` und die Exporte `test` in
  `jul-examples/import/ts-file.ts` und `js-file.js`. yugioh war nicht betroffen.
- Beispiel: `jul-examples/fibonacci/fibonacci.test.jul`.

## Umsetzung

### 1. Fehlercodes — [compiler-errors.ts](../src/compiler-errors.ts)

- `testOutsideTestFile = 2700` (`semantic`, `error`): `'test' is only allowed in *.test.jul files.`
- `testFails = 5200` (`type`, `error`): `Test fails.\n<details>`
- `testFileImportedOutsideTests = 3050` (`semantic`, `error`):
  `A *.test.jul file can only be imported from another *.test.jul file.` — gemeldet am
  Pfad-Literal des Imports (Position liegt in `dependencies` vor). Prüfstelle: dort, wo der Checker
  bzw. Loader heute `fileNotFound`/`invalidImportExtension` meldet.
- Jeweils Enum + `errorInfos`-Eintrag; neue Bereichszeilen `2700–2799 semantic Tests` und
  `5200–5249 type Tests` in der Tabelle von `jul-homepage/docs/docs/documentation/error-codes.md`,
  dazu je ein Abschnitt im bestehenden Format (`### JUL2700 — … {#jul2700}`, Zeile
  `` `semantic` · `error` · `Message` ``, Beispiel).

### 2. core-lib und Runtime

[core-lib.jul](../src/core-lib.jul), neben `log`:
```jul
# Registriert einen Test, den `jul --test` ausführt. Nur in *.test.jul erlaubt.
test = nativeFunction(
	(message: Text callback: () :> Boolean) ~> []
	§js
		test
	§
)
```
`~>`, damit `tryFoldCall` den Aufruf selbst nie faltet.

[runtime.ts](../src/runtime.ts):
- Modulweites Register `const registeredTests: …[] = []`.
- `export const test = (message, callback, location?) => { registeredTests.push(...) }` mit
  `_createFunction`-Params wie bei `equal`. Außerhalb eines Testlaufs wird nie `_runTests`
  aufgerufen, das Register ist dann wirkungslos.
- `export function _testCall(name, fn, args)`: merkt sich `{ name, args }` des zuletzt
  instrumentierten Aufrufs und liefert `fn(...args)`.
- `export function _runTests(): boolean`: führt die Tests der Reihe nach aus, setzt vorher den
  gemerkten Aufruf zurück, fängt Exceptions ab. Ergebnis `true` = bestanden; `false`, anderer Wert
  oder Exception = fehlgeschlagen. Ausgabe (englisch wie die übrigen CLI-Meldungen):
  ```
  ✓ 12th number is 144
  ✗ 13th number is 234 (fibonacci.test.jul:5:1)
      fibonacci(13) returned 233      ← nicht instrumentiert: nur Ergebnis
  ✗ … 
      equal(233 234) returned false   ← instrumentiert
  3 tests, 1 failed
  ```
  Werte über die vorhandene `typeToString` der Runtime formatieren (Literale erscheinen dort schon in
  JUL-Schreibweise: `600`, `§x§`, `[1 2]`); als `valueToString` kapseln.

### 3. Checker — [checker.ts](../src/checker/checker.ts)

Im `case 'functionCall'` nach Argumentprüfung (um Zeile 3360), Muster wie die Namensfälle in
`getReturnTypeFromFunctionCall` (Name-Matching ist sicher wegen JUL4003):
`if (functionExpression.type === 'reference' && functionExpression.name.name === 'test') checkTestCall(...)`.

`checkTestCall`:
1. `context.filePath` endet nicht auf `.test.jul` → `testOutsideTestFile` am Aufruf, fertig.
2. Callback-Argument über `getArgValueExpressions(args)`; dessen Typ ist ein Funktionstyp. Ist
   `resolvePlaceholders(ReturnType)` ein `booleanLiteral` mit `value === false` → `testFails`
   am Aufruf.
   Kein eigenes Falten nötig: der Rumpf `equal(600 400)` wird beim Check des Literals schon
   bottom-up gefaltet.
3. Details der Meldung: ist der Callback ein Funktionsliteral und `last(body)` ein `functionCall`
   mit Referenz als Callee, dann `name(arg1 arg2)` aus `getAllArgTypes(prefixType, argsType)`
   mit `typeToString(resolvePlaceholders(t), 0, 1)`, gefolgt von ` is false.`; sonst nur
   `Returns false.`. Die Testnachricht voranstellen, wenn sie ein Text-Literal ist.

Fold-Budget erschöpft → nicht gefaltet → keine statische Meldung, der Laufzeitlauf fängt es.

### 4. Emitter — [emitter.ts](../src/emitter.ts)

- `syntaxTreeToJs` bekommt zusätzlich den Quellpfad der Datei (für die Positionen);
  Aufrufer `emitFile` in [compiler.ts](../src/compiler.ts) reicht ihn durch.
- Im `case 'functionCall'` ein Namensfall `isNamedFunction(functionExpression, 'test')` wie bei
  `assume` (Zeile 227): emittiert `test(messageJs, callbackJs, { file, row, column })`
  (1-basiert). Beim Emittieren des Callback-Literals wird dessen letzter Rumpfausdruck, falls
  `functionCall` mit Listenargumenten und Referenz-Callee, als
  `_testCall('equal', equal, [argsJs])` emittiert (Prefix-Argument vorn, wie
  `jsValues.unshift`). Markierung über eine modulweite Menge zu instrumentierender Knoten, analog
  zum bestehenden `useTypeInfo`-Schalter.
- `functionLiteralToEvaluableJs` (constant folding) bleibt unberührt; `test` ist `~>` und wird nie
  gefaltet.

### 5. CLI und Compiler

[cli.ts](../src/cli.ts): `--test` in `knownFlags`
(`'Check and run all *.test.jul files below the config folder.'`); `--test` zusammen mit `--check`
ist ein Fehler. Aufruf einer neuen Funktion `testProject(rootFolder, outputFolderPath)`.

[compiler.ts](../src/compiler.ts):
- Fehlerausgabe von `compileProject` (Zeilen 55–97) in eine gemeinsame Funktion ziehen, die über
  alle `documents` läuft statt an einem `entry` zu hängen.
- `testProject`:
  1. Testdateien suchen: `readdirSync(rootFolder, { recursive: true })`, Endung `.test.jul`,
     `node_modules` und den Out-Ordner auslassen. Pfade wie bei `loadFile` mit
     `join(rootFolder, rel)` bilden (sonst passen `documents`-Keys und Out-Pfade nicht).
     Keine Testdatei gefunden → Meldung, `exitCode = 1`.
  2. Jede Datei mit `loadFile` in dasselbe `documents` laden (Cache verhindert Doppelladen).
  3. Fehler melden wie beim Build; bei `error` abbrechen (dazu zählen statisch fehlschlagende Tests).
  4. JS im Speicher erzeugen: die Umwandlung aus `emitFile` (Zeilen 169–225) in eine Funktion
     `emitToJs(document, runtimePath): { outPath, js }` ziehen, die nur liefert statt zu schreiben;
     `emitFile` schreibt deren Ergebnis wie bisher. Ergebnis ist eine Map
     `file-URL → JS`, Schlüssel ist der Ausgabepfad **neben der Quelldatei**
     (`x.jul` → `x.js`), damit relative Importe (`./y.js`, siehe `getPathFromImport`) und
     Paketimporte aus eingebundenen `.js`/`.ts`-Dateien wie gewohnt auflösen.
     `runtimePath` ist die Runtime des Compilers selbst (`out/runtime.js`), nicht eine Kopie —
     so teilen sich Testmodule und Compiler dasselbe Register.
  5. `module.registerHooks({ load })`: für URLs aus der Map `{ format: 'module', source, shortCircuit: true }`,
     sonst `nextLoad`. Danach die Testdateien der Reihe nach per `await import(url)` laden
     (Registrierung beim Import), dann `_runTests()` aufrufen und bei `false`
     `process.exitCode = 1`. `testProject` wird dafür `async`.
  6. Offener Punkt beim Umsetzen prüfen: YAML-Abhängigkeiten werden heute als
     `import … assert { type: 'json' }` emittiert (`getImportJs`), das kennt Node 24 nicht mehr
     (`with`). Webpack verdeckt das im normalen Build. Für den Testlauf entweder auf `with`
     umstellen (prüfen, ob webpack das im normalen Build mitmacht) oder YAML wie JSON als JS-Modul
     emittieren.

  Kein Out-Ordner, kein webpack, keine Kindprozesse. Nebeneffekt: derselbe Weg taugt später für
  einen Testlauf aus dem Language Server heraus.

Language Server: keine Änderung nötig — `sendDiagnosticsForFile` reicht alle Checker-Fehler samt
Schweregrad aus `errorInfos` durch.

### 6. Beispiele und Baselines

- [jul-examples/fibonacci/fibonacci.jul](../../jul-examples/fibonacci/fibonacci.jul): `test = fibonacci(12)`
  in `result` umbenennen (sonst JUL4003, weil `test` jetzt Builtin ist). In yugioh kommt `test`
  nicht als Name vor.
- Neu `jul-examples/fibonacci/fibonacci.test.jul` mit einigen Tests, einer davon unrein bzw. nicht
  faltbar, damit beide Wege (statisch und Laufzeit) vorkommen. Der Import von `fibonacci.jul`
  führt dessen `log` einmal mit aus — hinnehmen oder die Definitionen in eine eigene Datei ziehen.
- Checker-Snapshot und Zähler-Baseline ändern sich (neue Beispieldatei, Umbenennung) →
  `npm run test-update-snapshot`, Diff ansehen.

### 7. Tests (Mocha)

- [checker.test.ts](../src/checker/checker.test.ts), eigener `describe('test builtin')`. `expectCheck`
  bekommt optional einen Dateipfad (heute fest `dummy.jul`), je Fall ein `it`:
  - `test` in `dummy.jul` → JUL2700
  - `test(§x§ () => equal(1 2))` in `dummy.test.jul` → JUL5200 mit `equal(1 2) is false.`
  - `test(§x§ () => equal(1 1))` → keine Meldung
  - Callback mit unreinem Aufruf → keine Meldung (Laufzeit)
  - Callback ohne Boolean-Rückgabe → bestehender `argumentTypeMismatch`
  - Import einer `*.test.jul` aus `dummy.jul` → JUL3050, aus `dummy.test.jul` → keine Meldung
    (über `createInMemoryHost` und `loadFile`)
- Runtime: `_testCall`/`_runTests`/Formatierung direkt in einem neuen `runtime.test.ts`
  (bestanden, `false`, Exception, instrumentierter vs. nicht instrumentierter Aufruf).
- Emitter: Test, dass ein `test`-Aufruf mit Position und `_testCall` emittiert wird.

### 8. Doku

- `jul-homepage/docs/docs/documentation/handbook.md`: neuer Abschnitt „Tests" (nur Verhalten mit
  Beispiel: `*.test.jul`, `test(...)`, `jul --test`, statische Meldung).
- `jul-compiler/README.md` (`## Cli ausführen`, nach `--check`) und Root-`CLAUDE.md` (CLI-Block):
  `--test`.
- `jul-compiler/TODO`: Punkt „unit testing konzept" auf die offenen Ausbauten umschreiben
  (`is`-Regel, Reporter für `is`/`deepEqual`, Streams, Code Lens).
- Dieser Plan als `jul-compiler/docs/testing.md`.

## Verifikation

1. Vorher und nachher: `npm run bench -- --save --note "..."` in `jul-compiler` (Checker-Umbau).
2. `cd jul-compiler && npm run typecheck && node --run test`; Snapshot-Diff prüfen.
3. `npm run build`, dann in `jul-examples/fibonacci`:
   - `node ../../jul-compiler/out/cli.js jul-config.yaml --test` → alle grün, Exit-Code 0.
   - Erwartung absichtlich falsch machen (statisch faltbar) → Fehler JUL5200 beim Checken, kein Lauf.
   - Nicht faltbaren Test absichtlich falsch machen → Laufzeitmeldung mit Argumentwerten, Exit-Code 1.
   - `test(...)` in `fibonacci.jul` → JUL2700.
   - Normaler Build `jul-config.yaml` läuft unverändert, `out/` enthält keine Testdatei.
   - Nach `--test` existiert kein neuer Ordner oder Datei.
4. `npm run build-all`, VSCode: statisch fehlschlagender Test erscheint rot im Editor.
5. `cd jul-language-server && npm test && npm run test-snapshot`.
