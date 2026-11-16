# Plan: Lernressourcen mit eingebettetem Compiler

Ziel: Die Doku-Seite (`jul-homepage/docs`, Docusaurus) bekommt ein interaktives Tutorial und
Beispiele, die im Browser geprüft und ausgeführt werden, mit demselben Syntax-Highlighting wie in
VSCode. Kein Server, alles läuft im Browser des Lesers.

## Entscheidungen

- **Kein VSCode im Browser.** Editor ist Monaco (`@monaco-editor/react`). Ein ganzes VSCode
  (`monaco-vscode-api`, `monaco-languageclient`) wäre nur nötig, um `server.ts` unverändert zu
  betreiben, und kostet mehrere MB. Stattdessen werden die Feature-Module des Language Servers
  (`hover`, `completion`, `symbol-lookup`, …) direkt aufgerufen, sie hängen nicht an der
  LSP-Verbindung.
- **Eine Grammatik.** `vscode-jul-language-service/syntaxes/jul.tmLanguage.json` bleibt die
  einzige Quelle. Statische Codeblöcke über Shiki (`@shikijs/rehype`), der Editor über
  `@shikijs/monaco`. Prism, der Standard in Docusaurus, versteht keine TextMate-Grammatik und
  fällt weg.
- **Im Browser wird nicht gebündelt.** webpack läuft nur in der CLI. Der Playground führt das
  emittierte JS als ESM-Modul aus, das die vorgebaute Runtime importiert.
- **Der Compiler läuft in einem Web Worker,** nicht im Haupt-Thread: Der Modul-Load prüft die
  core-lib, und das Prüfen beim Tippen soll die Seite nicht blockieren. Die Ausführung des
  Nutzercodes läuft in einem eigenen Worker, der bei Timeout beendet wird (Endlosschleifen).

## Ausgangslage

Parser und Checker lesen schon nur über den `ProjectHost` (`createInMemoryHost`), die Runtime hat
keine Imports. Was den Browser heute verhindert:

| Hindernis | Stelle |
|---|---|
| Checker parst `core-lib.jul` beim Modul-Load per Dateipfad | `checker.ts` (`parseFile(coreLibPath)`), `parser.ts` (`coreLibPath` über `executingDirectory`) |
| `fs`, `url` in `util.ts`, von Parser und Loader importiert | `readTextFile`, `tryCreateDirectory`, `executingDirectory` |
| `path` in Parser, Checker, Emitter, `reference-index.ts`, `test-runtime.ts` | `join`, `dirname`, `extname`, `basename`, `isAbsolute`, `relative` |
| `process.platform` | `isCoreLibPath` |
| `typescript` statisch importiert in `typescript-parser.ts` und `compiler.ts` | nur für `.ts`-Dateien, lädt aber immer mit |
| `js-yaml` im Parser | unkritisch, läuft im Browser |
| Docusaurus 2.4.1, React 17, MDX 1 | `jul-homepage/docs/package.json` |

Auf der Seite liegen außerdem noch die Vorlagen-Seiten von Docusaurus (`tutorial-basics`,
`tutorial-extras`, Blog), auch in `i18n/en`.

## Schritte

### 1. Docusaurus 3 und Shiki

- Upgrade auf Docusaurus 3 (React 18, MDX 3). Danach `npm run build` für `de` und `en` ohne
  Fehler, MDX-3-Brüche in den bestehenden Seiten beheben.
- `@shikijs/rehype` als Rehype-Plugin, die Grammatik aus der Extension laden (Pfad relativ, kein
  Kopieren, sonst laufen zwei Fassungen auseinander). Themes für hell und dunkel passend zum
  Docusaurus-Farbmodus.
- Vorlagen-Seiten und Beispiel-Blog löschen.

Ergebnis: Alle ` ```jul`-Blöcke sind statisch hervorgehoben. Kein Compiler nötig.

Umgesetzt mit Docusaurus 3.10, Config als `docusaurus.config.mjs` (Shiki ist reines ESM). Blöcke
ohne Sprachangabe gelten als JUL (`defaultLanguage`), Konsolenausgaben sind als `text` bzw.
`shell` markiert. Offen: Von Shiki erzeugte Blöcke rendert Docusaurus als JSX-Inhalt, damit
fehlen Kopier-Button und `title`. Lösbar mit einem geswizzelten `CodeBlock`, der den Quelltext
aus einem Shiki-Transformer bekommt, oder erledigt sich für ` ```jul live` durch den Playground.

### 2. Compiler browserfähig

- **core-lib injizierbar.** Der Checker bekommt den core-lib-Text statt eines Pfads. Node-Einstieg
  liest die Datei wie bisher, der Browser-Einstieg bündelt sie als String (`?raw`/Asset). Die
  Initialisierung bleibt einmalig, darf aber nicht mehr am Modul-Load hängen, der einen Dateizugriff
  voraussetzt.
- **`util.ts` aufteilen** in reine Helfer und Node-Helfer (`fs`, `executingDirectory`). Parser,
  Checker, Loader und Emitter importieren nur die reinen.
- **Pfade:** eigenes `path-util.ts` (siehe unten).
- **`isCoreLibPath`** ohne `process`: im Browser case-sensitiv vergleichen.
- **TypeScript nachladen.** Gebraucht werden nur `createSourceFile` (Parser) und `transpileModule`
  (Emitter), beide laufen im Browser. Das Paket ist aber groß (`typescript.js` 9,1 MB, gezippt
  1,6 MB) und kommt deshalb hinter einen dynamischen Import: geladen erst, wenn die Dateimenge eine
  `.ts`-Datei enthält. Da Parsen synchron ist, lädt der Einstieg TypeScript vor dem Parsen, statt
  dass der Parser selbst wartet.
- **Einstieg `src/browser.ts`** mit genau dem, was die Seite braucht:
  - `check(files)` → Fehler je Datei (für Monaco-Marker)
  - `compile(files)` → emittiertes JS je Datei, nur wenn kein `error`
  - Zugriff auf `ParsedDocuments` für Hover und Vervollständigung (Schritt 4)
- **Absicherung:** Ein Build-Skript bündelt `browser.ts` für den Browser und schlägt fehl, sobald ein Node-Builtin hineinrutscht. In `build-all` einhängen, sonst merkt es
  niemand. Bundle-Größe dabei ausgeben.
- Bench vor und nach dem Umbau (yugioh, `--save`), die core-lib-Initialisierung berührt den
  Checker-Start.

Umgesetzt, mit diesen Ergänzungen:

- **`path-util.ts`** statt `import 'path'`: Unter Node das eingebaute `path` über
  `process.getBuiltinModule`, damit unter Windows `join` weiter `\` liefert (darauf verlassen sich
  Importauflösung und Language Server). Im Browser eigener POSIX-Code ohne Arbeitsverzeichnis.
  Kein Polyfill und keine Bundler-Konfiguration nötig. Node ohne `getBuiltinModule` (vor 20.16 bzw.
  22.3) bricht mit Meldung ab, statt still auf POSIX zu fallen. Die Extension erlaubt laut `engines`
  noch VS Code 1.91 (Node 20.9), das müsste angehoben werden.
- **core-lib:** `initCoreLib(code)` im Checker. Unter Node ruft es `compiler/node-host.ts` beim
  Laden auf (dort auch `createFileSystemHost`, `coreLibPath`, `parseFile`), im Browser
  `initCompiler(coreLibCode)`. `loadFile` meldet einen fehlenden Aufruf mit klarer Meldung.
- **TypeScript** über `typescript-module.ts` (`setTypeScript`/`getTypeScript`), auch für `.js`,
  die der Parser über TypeScript liest. `emitToJs` steht jetzt in `compiler/emit-file.ts`.
- **test-runtime.ts** war schon jetzt dran, weil der Emitter sie importiert:
  `getJulStackLocation` liefert die Stelle wie im Stack, relativ zum Arbeitsverzeichnis macht sie
  `compiler.ts` (`toCwdRelativeLocation`).
- **Prüfung:** `npm run check-browser` (in `build-all`, nach dem Build) bündelt `out/browser.js` mit
  webpack (schon Dependency, ohne Node-Polyfills) und führt das Bündel zusätzlich in einem leeren
  VM-Kontext ohne `process`/`Buffer` aus, mit einer Probe aus zwei Dateien. Größe: 353 kB
  minifiziert ohne TypeScript.
- Die Tests des Language Servers laufen unter tsx als CommonJS mit eigener Instanz der
  Compiler-Module, `test-setup.mjs` lädt `node-host` dort deshalb per `require`.

### 3. Playground-Komponente

- React-Komponente `JulPlayground` in `jul-homepage/docs/src/components`, eingebettet über
  `<BrowserOnly>` (Monaco rendert nicht serverseitig), lazy geladen, damit Seiten ohne Playground
  kein Monaco laden.
- **Compiler-Worker:** bekommt den Code, antwortet mit Fehlern und JS. Prüfen entprellt beim
  Tippen, Fehler als Monaco-Marker.
- **Ausführungs-Worker:** importiert die vorgebaute Runtime und das emittierte Modul (Blob-URL),
  leitet `console` und Rückgabewerte in die Ausgabe-Box. Timeout, danach `terminate()` und neuer
  Worker. Runtime-Pfad im emittierten Code (`getRuntimeImportJs`) zeigt auf das Runtime-Asset.
- Webpack-Anpassungen (Worker, Raw-Import der core-lib) über ein kleines Docusaurus-Plugin mit
  `configureWebpack`.
- **Einbindung in MDX:** Ein Remark-Plugin macht aus ` ```jul live` einen Playground mit dem
  Blockinhalt als Startcode. Normale ` ```jul`-Blöcke bleiben statisch.
- **Mehrere Dateien** (Importe, `.json`/`.yaml` als Daten, `.ts`): Der Playground nimmt immer eine
  Dateimenge. Bei einer Datei gibt es keinen Dateinamen. Mehrere Dateien stehen untereinander,
  jede in einem eigenen Monaco-Editor mit dem Dateinamen als Kopfzeile und so hoch wie ihr Inhalt
  (bis zu einer Höchsthöhe), alle am selben Compiler-Worker. Reiter gibt es nicht: Tutorial und
  Beispiele haben wenige, kurze Dateien, und so steht alles gleichzeitig im Blick. Schreibschutz
  gilt je Editor, also je Datei. Anlegen und Umbenennen durch den Leser
  gibt es nicht. In MDX folgen die Dateien als aufeinanderfolgende `live`-Blöcke mit
  Dateiname im Meta (` ```yaml live title="data.yaml"`), die das Remark-Plugin zu einem Playground zusammenfasst.
  Beim Ausführen zeigen die Importpfade im erzeugten JS über eine Import-Map auf Blob-URLs.

Umgesetzt in `jul-homepage/docs/src/components/JulPlayground` und `plugins/jul-playground`, mit
diesen Abweichungen und Ergänzungen:

- **Ausführung ohne Import-Map:** In Workern gelten Import-Maps nicht. `link-modules.js` gibt jedem
  Modul eine Blob-URL und ersetzt die Importpfade im Code mit `es-module-lexer` (nur statische
  Importe, Text bleibt unberührt), Abhängigkeiten zuerst. Die Runtime importiert der erzeugte Code
  über die nackten Bezeichner `jul-runtime`/`jul-test-runtime`, die Runtime kommt als Text (`?raw`)
  in den Worker.
- **JSON/YAML:** Der Emitter importiert Felder einzeln (`import {a} from './x.yaml.json' with
  { type: 'json' }`). Browser kennen bei JSON-Modulen nur den Default-Export, deshalb wird eine
  JSON-Datei zu einem JS-Modul mit Default- und benannten Exporten, das `with` fällt weg.
- **Ausführen** läuft automatisch nach jeder fehlerfreien Prüfung (entprellt 300 ms), ohne Knopf.
  Der Timeout (3 s) zählt ab dem Laden der Module, nicht ab dem Start des Workers. Bei Fehlern steht
  statt der Ausgabe die Fehlerliste. „Zurücksetzen“ stellt den Startcode wieder her.
- **Monaco** ohne die mitgelieferten Sprachen (`editor.api` + `features/register.all`),
  Hervorhebung über `@shikijs/monaco` mit Grammatik und Themes der statischen Blöcke. Bundle:
  Monaco 4 MB (gzip ~1 MB), Compiler-Worker 340 kB, TypeScript 3,5 MB nur bei `.ts`/`.js`. Auf dem
  Server wird der Playground nicht gebündelt (`IgnorePlugin`), dort steht der Code statisch.
- **Compiler** per webpack-Alias `jul-compiler` → `jul-compiler/out`, ohne `file:`-Dependency.
  Babel läuft nicht über Compiler und Runtime. `browser.ts` liefert die Meldungen jetzt auch bei
  Erfolg (Warnungen) und exportiert `errorInfos` für den Schweregrad.
- **Absicherung:** `check-browser` führt das übersetzte Probeprojekt samt Runtime und einem Test
  über `_runTests` zusätzlich gebündelt im leeren VM-Kontext aus.
- Marker verlinken den Fehlercode auf die Seite der Fehlercodes.

### 4. Sprachfeatures im Playground

Die Features des Language Servers kommen in den Playground, aber ohne LSP-Protokoll: Die
Feature-Module aus `jul-language-server/src` laufen im Compiler-Worker, eine dünne Schicht setzt
ihre Ergebnisse auf die Monaco-Provider um (Positionen dort 1-basiert). `monaco-languageclient`
mit dem unveränderten Server scheidet aus, weil es `monaco-vscode-api` voraussetzt, also VSCode im
Browser.

Für ein Tutorial am wichtigsten ist **Hover**: Der Leser sieht an jeder Stelle, welchen Typ der
Checker ableitet. Vorhanden als eigenes Modul, direkt anschließbar:

| Feature | Modul | Monaco |
|---|---|---|
| Diagnosen | Checker (Schritt 3) | `setModelMarkers` |
| Hover | `hover.ts` | `registerHoverProvider` |
| Vervollständigung | `completion.ts` | `registerCompletionItemProvider` |
| Signaturhilfe | `signature-help.ts` | `registerSignatureHelpProvider` |
| Semantische Tokens | `semantic-tokens.ts` | `registerDocumentSemanticTokensProvider` |
| Faltung | `folding.ts` | `registerFoldingRangeProvider` |
| Formatierung | `formatting.ts` | `registerDocumentFormattingEditProvider` |
| Quick Fix (Ignorier-Kommentar) | `ignore-comment.ts` | `registerCodeActionProvider` |
| Referenzen, Umbenennen | `references.ts` | `registerReferenceProvider`, `registerRenameProvider` |

Noch in `server.ts` und erst herauszulösen (deckt sich mit dem Ziel, `server.ts` schrumpfen zu
lassen): Gehe zu Definition, Hervorheben gleicher Symbole, Dokumentsymbole. Bei mehreren Dateien
scrollt Gehe zu Definition zum Editor der anderen Datei und setzt dort den Cursor.

Nicht im Playground: `auto-import.ts` (Dateien sind fest vorgegeben), `test-discovery.ts` (Tests
laufen über den „Prüfen“-Knopf).

Voraussetzungen für den Browser:

- Die Module importieren Typen und Hilfsklassen aus `vscode-languageserver`. Dessen Browser-Fassung
  löst der Bundler über das `browser`-Feld auf; sauberer ist, direkt aus
  `vscode-languageserver-types` bzw. `-protocol` zu importieren.
- `path` in `auto-import.ts` und `symbol-lookup.ts` wie im Compiler ersetzen.
- Ein Test-Bundle wie in Schritt 2 sichert ab, dass kein Node-Builtin hineinrutscht.

Umgesetzt, mit diesen Abweichungen und Ergänzungen:

- **Einstieg `jul-language-server/src/browser.ts`:** je Feature eine Funktion auf einem `Workspace`
  (`documents` + `ReferenceIndex` aus demselben Lauf), Positionen 0-basiert, Dateien als Pfad, nur
  reine Daten als Ergebnis (sie gehen per `postMessage` aus dem Worker). Im Importpfad schlägt die
  Vervollständigung die anderen Dateien des Playgrounds vor statt Dateien von der Platte.
  `browser.ts` des Compilers nimmt dafür einen `referenceIndex` an.
- **Aus `server.ts` herausgelöst:** `definition.ts` (Gehe zu Definition), `document-symbols.ts`,
  in `references.ts` die Rename-Ziele (`getTargetsAt`), `getRenameRange` und
  `getDocumentHighlightLocations`, `isImportPath` nach `symbol-lookup.ts`. Snapshot unverändert.
- **Imports:** Die Feature-Module importieren aus `vscode-languageserver-types` (jetzt direkte
  Dependency), `semantic-tokens.ts` kodiert ohne `SemanticTokensBuilder`. `path` nur noch in
  `server.ts` und `auto-import.ts`, die der Playground nicht braucht.
- **Absicherung:** `npm run check-browser` im Language Server (in `build-all` des Compilers)
  bündelt beide Browser-Einstiege und fragt Hover, Vervollständigung, Definition und Referenzen im
  leeren VM-Kontext ab. Zusammen 404 kB minifiziert, 50 kB mehr als der Compiler allein.
- **Worker:** Der Compiler-Worker hält je Playground den letzten geprüften Stand. Eine Anfrage
  bringt den aktuellen Code aller Dateien mit; weicht er ab (Tippen vor der entprellten Prüfung),
  wird vorher neu geprüft. Die Homepage bindet `jul-language-server/out` per Alias ein, der
  Compiler-Alias zeigt jetzt auf den Paketordner, damit beide denselben Compiler sehen.
- **Monaco** (`language-features.js`): Hover, Vervollständigung, Signaturhilfe, Gehe zu Definition
  (über einen Editor-Opener in den Editor der anderen Datei), Referenzen, Hervorheben, Umbenennen
  (abgelehnt, wenn es eine schreibgeschützte Datei träfe), Gliederung, Faltung, Formatieren und der
  Quick Fix für `#ignore`. Ziele in der core-lib werden nicht angesprungen.
- **Semantische Tokens nicht eingebunden:** Monaco im Standalone-Betrieb färbt einen Tokentyp ohne
  passende Theme-Regel in der Standardfarbe, statt die Farbe der Grammatik zu lassen, und die
  Playgrounds sähen anders aus als die statischen Blöcke daneben. Bräuchte eigene Theme-Regeln je
  Tokentyp, aus den Scopes der Shiki-Themes abgeleitet.
- **Rename aus YAML/JSON:** Ein importierter Schlüssel einer Datendatei wurde nur lokal umbenannt
  und brach den Import. Jetzt schreibt der Rename einen Alias (`(gruss = greeting) = import(…)`),
  die Datendatei bleibt (sie hat ohnehin keine Positionen, siehe `TODO`).
- **Aufgefallen, offen (`TODO`):** Die Signaturhilfe kommt in `f(` und `f()`, aber nicht, sobald
  ein Argument dasteht.

### 5. Tests im Playground

`_runTests(report)` liefert je Test ein `TestResult` (Name, Stelle des `test`-Aufrufs, Fehlertext
mit den ausgewerteten Argumenten, Fehlerstelle, Dauer) und überlässt die Darstellung dem Aufrufer.
Der Playground stellt es so dar:

- **Im Editor** wie im Test Explorer von VSCode: CodeLens „▶ Ausführen“ über jedem `test(...)`
  (Stellen aus `findTests` in `test-discovery.ts`, `registerCodeLensProvider`), nach dem Lauf ✓
  oder ✗ am Rand. Ein fehlgeschlagener Test bekommt einen Marker an der Fehlerstelle, ohne
  Fehlerstelle am `test`-Aufruf, mit dem Fehlertext als Hover.
- **Reiter „Tests“** neben „Ausgabe“: je Test ✓/✗, Name, Dauer, bei ✗ der Fehlertext darunter,
  am Ende „3 von 4 bestanden“. Ein Klick springt zur Stelle.
- **Übungen** mit sichtbarer Testdatei direkt unter der Lösung, wie jeder Playground mit mehreren
  Dateien (Schritt 3): oben die Lösung zum Bearbeiten, darunter die Tests schreibgeschützt. Die
  Tests sind die Aufgabe als Code, stehen beim Schreiben im Blick und zeigen nebenbei, wie Tests in
  JUL aussehen. Die Testnamen stehen schon vor dem ersten Lauf als Checkliste der Anforderungen da,
  „Prüfen“ hakt sie ab.
- **Beispielseiten** zeigen die Testausgabe statisch wie den Abschnitt „Output“ bei Roc,
  aufgenommen beim Erzeugen der Seite.

Technisch:

- Der Ausführungs-Worker lädt die Module und ruft `_runTests` auf. Das Register in
  `test-runtime.ts` ist modulglobal, ein frischer Worker je Lauf hält es leer.
- `test-runtime.ts` ohne Node: `getJulStackLocation` nutzt `fileURLToPath`, `relative` und
  `process.cwd()`, das wird herausgelöst oder vom Aufrufer übergeben.
- Fehlerstelle bei Exceptions: Node rechnet den Stack über Source Maps auf die `.jul`-Datei um,
  Browser tun das für `error.stack` nicht, dort stehen Blob-URLs und JS-Zeilen. Der Playground
  rechnet über die Zuordnungen aus `syntaxTreeToJsWithMappings` selbst zurück. Verletzte
  `assert`/`assume` bringen ihre Stelle schon mit.
- `test` steht nur in `*.test.jul`. Ein Playground mit einer einzigen Datei, die Tests enthält,
  nennt sie intern `main.test.jul`, sichtbar ist der Name nicht.

### 6. Aufbau der Seite

Vorlage ist roc-lang.org:

- **Startseite** mit einem kurzen lauffähigen Snippet im Playground, gleich im ersten Bildschirm.
- **Tutorial** in Kapiteln statt wie bei Roc auf einer langen Seite, etwa 6 bis 10, jedes eine
  geschlossene Lerneinheit mit Übung am Ende. Innerhalb eines Kapitels wie bei Roc:
  Inhaltsverzeichnis „Auf dieser Seite“, Hinweis- und Tipp-Kästen, erwartete Ausgabe direkt nach
  jedem Codeblock. Anders als bei Roc, das auf `roc repl` lokal verweist, sind die Codeblöcke
  selbst Playgrounds. Kapitel halten die Zahl der Playgrounds je Seite klein, und weil Docusaurus
  beim Kapitelwechsel nicht neu lädt, läuft der Compiler-Worker über alle Kapitel weiter.
- **Suche** über die ganze Seite (`docusaurus-search-local` o. ä.), für Tutorial, Handbuch und
  Fehlercodes.
- **Beispiele** als Übersicht nach Kategorien (Einstieg, Typen und Funktionen, Kollektionen,
  Fehlerbehandlung, Parsen, Code organisieren, …), je Eintrag Titel und ein Satz. Jede
  Beispielseite: Aufgabe, Code, Ausgabe, Link auf die Quelle und die Compiler-Version, mit der es
  geprüft wurde. Quelle sind die Projekte in `jul-examples`, die Seite wird daraus erzeugt, nicht
  von Hand kopiert, und beim Erzeugen gebaut und ausgeführt, damit kein Beispiel veraltet.

### 7. Tutorial-Inhalte

- Kapitel als Docs-Seiten unter `docs/tutorial`, jedes mit kurzer Erklärung, Playground und Übung.
- **Übungen** mit „Prüfen“-Knopf: Unter der Lösung steht die schreibgeschützte
  Testdatei, der Playground führt Lösung und Tests zusammen aus (Schritt 5).
- Reihenfolge der Kapitel grob: Werte und Text, Funktionen und Aufrufe, Klammern (Bindung vs.
  Daten), Listen und Dictionaries, Typen und `Empty`, Branching mit `?`, Records und Tupel,
  Tests, Streams.
- Inhalte folgen den Regeln für `jul-homepage/docs`: Verhalten mit Beispiel, keine Begründungen.
- Übersetzung nach `i18n/en` erst, wenn die deutschen Kapitel stehen.

## Hosting

Vorerst nur lokal (`npm start` / `npm run serve`), später vielleicht GitHub Pages, noch später
selbst gehostet. Die Seite bleibt deshalb rein statisch, ohne Server-Funktion, und läuft so in
allen drei Fällen. Der Unterschied ist nur `baseUrl` in `docusaurus.config.js`.

Compiler-Bundle und Runtime kommen aus dem lokalen Build von `jul-compiler` (wie beim Language
Server per `file:`), nicht aus einem veröffentlichten npm-Paket. Die Seite zeigt also immer den
Stand des Compilers, gegen den sie gebaut wurde; Änderungen am Compiler wirken erst nach dessen
Build.
