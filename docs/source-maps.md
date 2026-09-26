# Source Maps und Breakpoints

## Kontext

Das erzeugte JS hat heute keine Source Maps. Zwei Folgen:

- **Stacktraces zeigen auf das erzeugte JS**, im Build auf eine Zeile in `out/bundle.js`, im
  Testlauf auf das im Speicher erzeugte `x.js`. Die zugehörige `.jul`-Stelle sucht man von Hand.
- **Breakpoints gehen nur im erzeugten JS**, nicht in der `.jul`-Datei.

Tests und ein ausführlicher Reporter decken vieles ab, was man sonst mit dem Debugger untersucht
(siehe [test-instrumentation.md](test-instrumentation.md)). Laufzeitfehler an der richtigen Stelle
und ein interaktiver Rückfall, wenn der Reporter nicht reicht, brauchen aber ein Mapping. Andere
Sprachen, die nach JS kompilieren, landen fast alle dort (TypeScript, Kotlin/JS, Scala.js,
ClojureScript, Dart; CoffeeScript erst nachträglich). Ohne kommen vor allem Sprachen aus, deren
Ausgabe bewusst wie handgeschriebenes JS aussieht (ReScript), oder die den Debugger über Purity und
eigene Werkzeuge ersetzen (Elm).

## Entscheidungen

- **Mapping auf Statement-Ebene.** Gemappt werden die Top-Level-Ausdrücke einer Datei und jeder
  Ausdruck in einem Funktionsrumpf, jeweils auf seinen Anfang. Das reicht für Stacktraces mit der
  richtigen Zeile und für Breakpoints pro Zeile. Das Mapping auf Ausdrucksebene ist eine optionale
  spätere Stufe (siehe unten).
- **Marker im erzeugten String statt `SourceNode`.** Der Emitter setzt Strings zusammen
  (`expressionToJs` liefert `string`, ~900 Zeilen). Die übliche Lösung wäre, alle Rückgabetypen auf
  `SourceNode` (Paket `source-map`) umzustellen, weil auch ein Statement tief in einem
  Funktionsliteral seine Position durch alle umgebenden Strings hindurch tragen muss. Stattdessen
  schreibt der Emitter an jedem Statement-Anfang einen unsichtbaren Marker mit der Quellposition in
  den String. Nach dem Zusammensetzen entfernt ein Durchlauf die Marker und schreibt dabei die
  Zuordnung erzeugte Position → Quellposition in die Map. Der Emitter bleibt stringbasiert, der
  Umbau ist klein, und die spätere Stufe auf Ausdrucksebene heißt nur, mehr Marker zu setzen.
  Voraussetzung: Das Markerzeichen darf sonst nirgends im erzeugten JS vorkommen (siehe Schritt 1).
- **Im Build externe `.map`-Dateien, im Testlauf inline.** Der Testlauf schreibt nichts auf die
  Platte ([testing.md](testing.md)), die Map hängt dort als Data-URL am erzeugten Modul.
- **Debuggen über das JavaScript Debug Terminal von VSCode.** Es hängt sich an jeden Node-Prozess,
  der darin startet, also auch an `jul test --name …` und `node out/bundle.js`. Eine eigene
  Launch-Konfiguration oder ein eigener Debug-Adapter ist dafür nicht nötig.

## Umsetzung

### 1. Emitter — [emitter.ts](../src/emitter.ts)

- Markerform: `\u0001<row>:<column>\u0002` (0-basiert, wie intern üblich). Die Steuerzeichen stehen
  in gültigem JS-Quelltext nur innerhalb von String- oder Template-Literalen, und dorthin kommen sie
  nur über `escapeStringForBacktickJs`/`escapeStringForSingleQuoteJs`. Beide escapen `\u0001` und
  `\u0002` zusätzlich als `\\u0001`/`\\u0002`. JS in `§js … §` von `nativeFunction` wird wörtlich
  übernommen; rohe Steuerzeichen darin sind kein realistischer Fall und werden nicht behandelt.
- Neuer modulweiter Schalter `emitSourcePositions` analog zu `useTypeInfo`, gesetzt nur in
  `syntaxTreeToJs`. `functionLiteralToEvaluableJs` (constant folding) emittiert damit weiterhin
  ohne Marker.
- Marker setzen: in `syntaxTreeToJs` vor jedem Top-Level-Ausdruck, in `functionBodyToJs` vor jedem
  Ausdruck des Rumpfs, beim letzten vor dem `return`. Position ist `startRowIndex`/`startColumnIndex`
  des Ausdrucks.
- `syntaxTreeToJs` bekommt als Ergebnis `{ js, map }` statt `string`. Der Durchlauf über den
  fertigen String baut die Map mit `SourceMapGenerator` aus `source-map`. `source-map@0.6.1` liegt
  schon über webpack/terser im Baum; es wird als direkte Abhängigkeit eingetragen, damit der
  Compiler nicht von einer transitiven Version abhängt. `sources` ist der Pfad der `.jul`-Datei
  relativ zur Ausgabedatei, `sourcesContent` der Quelltext, damit die Map auch dann stimmt, wenn der
  Pfad aus Sicht des Debuggers nicht auflöst. Der Quelltext liegt in `emitToJs` schon vor.

### 2. Compiler — [compiler.ts](../src/compiler.ts)

- `emitToJs` liefert zusätzlich `sourceMap?: string`:
  - `.jul`: die Map aus Schritt 1.
  - `.ts`: `transpileModule` mit `sourceMap: true` und `fileName`, Ergebnis `sourceMapText`.
  - `.js`, `.json`, `.yaml`: keine Map.
- `emitFile` schreibt die Map als `x.js.map` neben `x.js` und hängt
  `//# sourceMappingURL=x.js.map` an. Der Shebang verschiebt alle Zeilen um eins; die Mappings
  bekommen dafür ein führendes `;`.
- `testProject` hängt die Map inline an (`//# sourceMappingURL=data:application/json;base64,…`) und
  ruft vor dem ersten `import` `process.setSourceMapsEnabled(true)` auf. Node wendet Source Maps nur
  auf Module an, die danach geladen werden, die Testmodule kommen also rechtzeitig. Beim Umsetzen
  prüfen, dass Node die Data-URL auch bei Modulen auswertet, die über `registerHooks` aus dem
  Speicher kommen.
- webpack: `devtool: 'source-map'` und eine Regel mit `source-map-loader` (`enforce: 'pre'`) für die
  erzeugten `.js`, damit die Maps der einzelnen Dateien in die Map des Bundles übernommen werden.
  Ohne den Loader zeigte `bundle.js.map` nur auf die Zwischendateien in `out/`. `source-map-loader`
  wird Abhängigkeit (nicht devDependency), webpack läuft im CLI. Ergebnis: `out/bundle.js.map`.

### 3. Stacktraces im Build

Für das Bundle greift `process.setSourceMapsEnabled(true)` zu spät: Es liefe in `bundle.js` selbst,
und das ist dann schon geladen. Nötig ist `node --enable-source-maps out/bundle.js`. Offen beim
Umsetzen, wie das ohne Zutun des Nutzers gesetzt wird:

- Bei `cli: true` Shebang `#!/usr/bin/env -S node --enable-source-maps`. Unter Linux/macOS geht
  das; prüfen, ob die Windows-Shims von `npm i -g` die zusätzlichen Argumente übernehmen.
- Sonst dokumentieren, dass man `--enable-source-maps` selbst übergibt.

Im Debugger ist das egal, js-debug liest die Maps selbst.

### 4. Testlauf: Fehlerstelle bei Exceptions — [test-runtime.ts](../src/test-runtime.ts)

`getTestFailureText` nennt bei einer Exception heute nur `error.message`. Mit Source Maps steht im
Stack die `.jul`-Stelle. Die Meldung bekommt deshalb den ersten Stack-Frame, der in eine `.jul`-Datei
zeigt, als ` (datei.jul:zeile:spalte)`. Frames in `runtime.js`, `test-runtime.js` und im Compiler
werden dabei übersprungen.

### 5. VSCode-Extension — [package.json](../../vscode-jul-language-service/package.json)

- `contributes.breakpoints: [{ "language": "jul" }]`. Ohne diesen Eintrag lässt VSCode in `.jul`
  keine Breakpoints setzen.
- `skipFiles` für das Debug Terminal, damit „Step into“ nicht in `_callFunction` und im Compiler
  landet: `debug.javascript.terminalOptions` mit
  `"skipFiles": ["<node_internals>/**", "**/jul-compiler/out/**"]`. Prüfen, ob die Extension das über
  `contributes.configurationDefaults` vorbelegen darf; sonst in der Doku als Einstellung angeben.
  `jul test` läuft im Prozess des Compilers, deshalb der ganze `out`-Ordner des Compilers und nicht
  nur `runtime.js`.

### 6. Tests (Mocha)

- [emitter.test.ts](../src/emitter.test.ts), eigener `describe('source map')`, Prüfung mit
  `SourceMapConsumer` aus `source-map`:
  - Top-Level-Definition in Zeile 3 → erzeugte Position mappt auf Zeile 3, Spalte 0.
  - Ausdruck in einem Funktionsrumpf → mappt auf seine eigene Zeile, nicht auf die der Definition.
  - Letzter Rumpfausdruck (`return …`) → mappt auf seine Zeile.
  - Text-Literal mit `\u0001` im Inhalt → erzeugtes JS enthält kein rohes `\u0001`, der Wert zur
    Laufzeit ist unverändert.
  - Kein Marker bleibt im Ergebnis von `syntaxTreeToJs` stehen.
  - `functionLiteralToEvaluableJs` enthält keine Marker.
- [compiler.test.ts](../src/compiler.test.ts) bzw. [test-runtime.test.ts](../src/test-runtime.test.ts):
  Ein Test, der in einer aufgerufenen JUL-Funktion wirft, meldet die `.jul`-Zeile der werfenden
  Stelle.
- Checker-Snapshot und Zähler-Baseline bleiben unverändert (nur Emitter und Compiler betroffen).

### 7. Doku

- `jul-homepage/docs/docs/documentation/handbook.md`: Abschnitt „Debuggen“, nur Verhalten:
  Breakpoints in `.jul`, JavaScript Debug Terminal, `jul test --name …` darin starten,
  `--enable-source-maps` für Stacktraces im Build (falls Schritt 3 das nicht automatisch löst).
- `jul-compiler/TODO`: Punkt „debug experience verbessern“ auf dieses Dokument verweisen lassen.

## Verifikation

1. Vorher und nachher `npm run bench-runtime -- --save --note "..."`. Das erzeugte JS ändert sich
   nur um den Kommentar mit der Map, erwartet wird keine Änderung.
2. `npm run typecheck && node --run test` in `jul-compiler`.
3. `npm run build`, dann in `jul-examples/fibonacci`:
   - Einen Test so ändern, dass er in `fibonacci.jul` wirft → Meldung nennt `fibonacci.jul:zeile`.
   - Im VSCode-Debug-Terminal `jul test --name "die 12. Zahl ist 144"` mit Breakpoint in
     `fibonacci.jul` → hält dort, Variablen tragen die JUL-Namen, „Step into“ überspringt die Runtime.
   - `jul` (Build) → `out/bundle.js.map` existiert; ein Wurf im Programm zeigt mit
     `--enable-source-maps` auf die `.jul`-Zeile.
4. `npm run build-all`, `npm run test-deploy` in der Extension, Breakpoint in einer `.jul`-Datei
   lässt sich setzen.
5. `cd jul-language-server && npm test && npm run test-snapshot` (der Language Server emittiert nicht,
   Absicherung gegen Seiteneffekte der geänderten Signatur von `syntaxTreeToJs`).

## Optional, für später

Nicht Teil dieses Plans. Hier festgehalten, damit die Umsetzung sie nicht verbaut.

### Stream-Testquellen und Stream-Inspektor

Streams sind push-basiert und synchron, eine Quelle, die aus einer Liste pusht, und ein Sammler, der
die Emissionen als Liste liefert, reichen für deterministische Tests (Marble Testing wie beim
`TestScheduler` von RxJS). Glitch-Freiheit lässt sich so direkt prüfen: `combine$` über zwei `map$`
derselben Quelle emittiert pro Push einmal. Für `timer$` braucht es zusätzlich virtuelle Zeit (steht
schon im TODO unter „tests“).

Darauf aufbauend ein Stream-Inspektor: Ein Aufzeichnungsmodus in `StreamClass.push`
([runtime.ts](../src/runtime.ts)) schreibt jeden Push mit Stream-Name, `processId` und Wert als
Zeitleiste. Der Emitter müsste dafür bei `name$ = …` den Namen der Definition mitgeben, Streams sind
heute anonym. Zeichnet man nur die Pushes in Quellen auf, lässt sich eine Session als Stream-Test mit
festen Listen exportieren. Dieselbe Mechanik wie die Testquellen.

Time Travel wie in Elm (`elm make --debug`: alle Messages als Liste, Klick springt Model und
Oberfläche auf diesen Stand) wäre der nächste Schritt: den Graphen neu aufbauen und die
aufgezeichneten Quell-Pushes bis zum Stand N erneut abspielen. Verlässlich wird das erst, wenn beim
erneuten Abspielen keine Effekte doppelt feuern, also Callbacks mit Effekten von reinen
unterschieden werden. Die Purity-Pfeile ([pure-functions.md](pure-functions.md)) sind dafür die
Grundlage. Weitere offene Punkte: unreine Werte außerhalb von Streams (`currentDate`, Zufall) mit
aufzeichnen, dynamisch erzeugte Quellen in `flatSwitchMap$` beim erneuten Abspielen wieder
zuordnen.

### Mapping auf Ausdrucksebene

Marker zusätzlich in `expressionToJs` für Aufrufe, Referenzen und Literale setzen. Das bringt
Spalten-Breakpoints und genaue Fehlerstellen in verschachtelten Aufrufen. Bewusst zuordnen muss man
dabei synthetisierten Code (`branchDispatchToJs`, `namedArgumentsToDirectCallJs`, die Arrow-Hülle um
ein nicht triviales Branching-Argument). Erst angehen, wenn Breakpoints pro Zeile im Alltag zu grob
sind.

### Werte im Debugger in JUL-Schreibweise

js-debug erlaubt über `customDescriptionGenerator` eine eigene Darstellung der Werte im
Variablenfenster. Damit könnten bigint ohne `n`, Fraction, Streams (mit `lastValue`) und Funktionen
(mit Typ) wie in JUL erscheinen, etwa über die `typeToString` der Runtime.
