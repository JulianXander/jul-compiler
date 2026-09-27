# Runtime-Tree-Shaking im Bundle

Ziel: `out/bundle.js` enthält nur den Teil von [runtime.ts](../src/runtime.ts), den das Programm
tatsächlich erreicht. Heute landet die Runtime immer vollständig im Bundle, auch wenn ein Programm
nur `subscribe` und `timer$` benutzt.

Zwei Teile:

- **A**, Tree-Shaking im Bundler: Die Runtime wird so umgebaut, dass ein Minifier ungenutzte
  Definitionen entfernen darf. Dann wird das Entfernen eingeschaltet.
- **B**, nur benutzte Builtins importieren: Der Emitter importiert nicht mehr alle
  Runtime-Exporte, sondern nur die, die die Datei verwendet.

Weitergehende Ideen, die nicht Teil dieses Plans sind (eigener Linker, Aufteilung in Module,
Runtime als Paket): [backlog/runtime-linking.md](backlog/runtime-linking.md).

**Stand:** A und B sind umgesetzt. Das Entfernen erledigt am Ende nicht terser, sondern der Compiler
selbst beim Schreiben von `runtime.js`, siehe [A7](#a7-terser-ersetzt-durch-shakeruntime). A1 bis A6
beschreiben den Weg dahin. Der Umbau der Runtime (A2 bis A4) ist Voraussetzung für beide Varianten.

## Ausgangslage

- webpack läuft ohne `mode`, also im Production-Modus. Module Concatenation ist aktiv, die
  Runtime steht im Bundle als lokaler Code in derselben IIFE wie das Programm. webpack markiert
  unbenutzte Exporte, entfernt sie aber nicht, weil `optimization.minimize: false` gesetzt ist
  ([compiler.ts](../src/compiler.ts), Abschnitt „6. bundle“).
- Versuch mit terser (`compress` mit `unused` und `dead_code`, ohne `mangle`) auf das fertige
  `jul-examples/ui/preserve-dom/out/bundle.js`: 72,7 kB → 59,9 kB, obwohl das Programm nur drei
  Runtime-Funktionen braucht. Fast alle Builtins bleiben stehen.
- Grund 1: 69 Builtins bekommen ihre `params` durch einen eigenen Aufruf nach der Definition:

  ```ts
  export const map = (values, callback) => { … };
  _createFunction(map, { singleNames: [ … ] });
  ```

  `_createFunction` schreibt `params` an die Funktion. Das ist für den Minifier ein Seiteneffekt,
  er darf weder den Aufruf noch `map` entfernen. Über die `params` hängen daran wiederum
  `List`, `Or`, `_Function` usw.
- Grund 2: Konstanten, die auf oberster Ebene durch einen Aufruf berechnet werden
  (`PositiveInteger = And(Integer, Greater(0n))`, `Rational = Or(Integer, Fraction)`, …),
  gelten als möglicherweise seiteneffektbehaftet und bleiben stehen.
- Der Emitter importiert in jede Datei alle Runtime-Exporte (`runtimeKeys` in
  [emitter.ts](../src/emitter.ts)). Für die Bundle-Größe ist das egal, denn webpack verfolgt die
  tatsächlich benutzten Bezeichner. Es bläht aber jede emittierte Datei auf, und ohne Bundler
  (`jul test`, einzelne Dateien) gibt es gar kein Entfernen.
- Laut TODO bringt `minify` auf yugioh nur −9 % nach gzip, weil dort `card-data.json` 84 % des
  Bundles ausmacht. Dieser Plan richtet sich vor allem an Programme ohne große Datenimporte.
  Für yugioh zählt eher, wie lange der Build dauert (siehe Risiken).

## Teil A: Tree-Shaking im Bundler

### A0: Messbasis

Vor jedem Umbau:

- Bundle-Größe roh und gzip für `jul-examples/ui/preserve-dom`, `jul-examples/fizz-buzz`,
  `jul-examples/cli` und yugioh notieren.
- Build-Dauer von yugioh (`jul` ohne Kommando) messen, dreimal, Median.
- `npm run bench-runtime -- --save --note "vor runtime-tree-shaking"`.

### A1: Spike an einem Builtin

Bevor alle 69 Stellen umgebaut werden, an `map` allein prüfen, ob die Kette trägt:

1. `map` auf die Form aus A3 umstellen.
2. In der webpack-Konfiguration `minimize: true` mit `TerserPlugin` (kommt mit webpack) und
   diesen Optionen:
   ```js
   terserOptions: {
   	compress: { defaults: false, unused: true, dead_code: true, side_effects: true, toplevel: true },
   	mangle: false,
   	format: { beautify: true, comments: 'some' },
   }
   ```
   `defaults: false` hält die Ausgabe nah am Eingang: keine Umformungen von Ausdrücken, nur
   Entfernen. `side_effects` lässt mit `/*#__PURE__*/` markierte Aufrufe fallen, deren Ergebnis
   keiner benutzt. Ob `toplevel` nötig ist, klärt der Spike: Nach der Concatenation liegt alles
   in einer IIFE, dort sind es Funktionsvariablen und keine Top-Level-Variablen.
3. Prüfen: `map` fehlt im Bundle von `preserve-dom` und steht im Bundle eines Programms, das
   `map` benutzt.
4. Prüfen, dass `bundle.js.map` weiter stimmt: Breakpoint in einer `.jul`-Datei, Stacktrace
   zeigt auf die `.jul`-Zeile ([source-maps.md](backlog/source-maps.md)).
5. Build-Dauer von yugioh mit eingeschaltetem terser messen. Ist sie deutlich schlechter, als
   Alternative ausprobieren: esbuild (liegt schon in `node_modules`) als Minimizer, oder den
   JSON-Teil ausnehmen. Die Entscheidung fällt hier und wird in diesem Dokument nachgetragen.

**Befund des Spikes:**

- Das installierte webpack bringt den Minimizer selbst mit, die Optionen gehen über
  `optimization.minimizeOptions.javascript`. Ein zusätzliches Paket ist nicht nötig.
- `toplevel` ist nicht nötig, `unused` entfernt auch Variablen in der IIFE.
- **`eval` blockiert alles.** `runJs` war `_createFunction(eval, …)`. Sobald der Bezeichner `eval`
  im Bundle steht, entfernt terser in diesem Scope keine einzige Variable mehr, denn ein direktes
  `eval` könnte jede erreichen. Das erklärt, warum der erste Versuch nur 18 % brachte. `runJs`
  ruft jetzt `globalThis.eval(js)` auf, das ist ebenfalls ein indirektes `eval` mit demselben
  Verhalten.
- **Kompakt statt eingerückt.** Mit `beautify` wächst das yugioh-Bundle um 15 % (2039 → 2342 kB),
  weil terser das große JSON-Literal auf eine Eigenschaft pro Zeile umbricht. Getrennt einrücken
  lässt sich das nicht, terser formatiert den ganzen Chunk. Die Ausgabe ist deshalb kompakt,
  gelesen wird über die Source Map. Lesbarer Code mit kompaktem JSON ginge nur mit einem eigenen
  Chunk für große JSON-Importe (TODO beim Bundling).
- **Keine `names` in der Source Map.** terser trägt Namen für Bezeichner in die Map ein. Node
  benennt Stackframes danach, und zwar über die Aufrufstelle im vorherigen Frame. Das Ergebnis
  war falsch: `at a (main.jul:5:2)`, wobei `a` das Argument aus `log(a)` ist, statt
  `at boom (main.jul:5:2)`. Da nichts umbenannt wird, kennt V8 die richtigen Namen schon selbst.
  `removeSourceMapNames` in [compiler.ts](../src/compiler.ts) schreibt `bundle.js.map` nach dem
  Bündeln ohne `names` neu (rund 120 ms bei yugioh). Die Stacktraces sehen damit genau aus wie
  vor dem Minimizer.
- esbuild wurde nicht ausprobiert, terser war schnell genug (siehe Ergebnis).

### A2: Signatur von `_createFunction`

`_createFunction(fn: Function, params): JulFunction` verliert den TypeScript-Typ der Funktion.
Solange nur das Ergebnis weggeworfen wurde, war das egal. Künftig ist das Ergebnis die exportierte
Definition, und Aufrufer innerhalb der Runtime brauchen die ursprüngliche Signatur:

```ts
export function _createFunction<F extends Function>(fn: F, params: Params): F & JulFunction
```

Der Laufzeitcode bleibt unverändert. Die generierten Aufrufe im Emitter und in
`constant-folding.ts` (`createBudgetedCreateFunction`) prüfen, ob die Signatur weiter passt.

### A3: Runtime umstellen

Jede Definition wird ein einzelner Ausdruck ohne Seiteneffekt beim Laden:

```ts
export const map = /*#__PURE__*/ _createFunction(
	<T, U>(values: T[] | undefined, callback: (value: T, index: bigint) => U): U[] | undefined => { … },
	{ singleNames: [ … ] },
);
```

- Alle 69 nachgestellten `_createFunction(x, …)` in [runtime.ts](../src/runtime.ts) umbauen,
  dazu die in [test-runtime.ts](../src/test-runtime.ts) (`test`).
- Aufrufe **innerhalb** der `params` ebenfalls markieren, etwa `type: /*#__PURE__*/ List(Type)`.
  Terser verwirft einen PURE-Aufruf, behält aber Argumente, die selbst Seiteneffekte haben
  könnten. Ohne Markierung bliebe also `List(Type)` stehen und mit ihm `List`.
- Berechnete Konstanten auf oberster Ebene markieren: `NonZeroFloat`, `NonZeroInteger`,
  `PositiveInteger`, `Rational`, `_julTypeSymbol` (`Symbol.for`) usw.
- Aus `function`-Deklarationen, die bisher nachträglich `params` bekamen, werden `const`. Die
  sind nicht mehr gehoistet. Greift beim Laden etwas auf eine weiter unten definierte Funktion
  zu, fällt das beim ersten Import als `ReferenceError` auf, also schon bei jedem Testlauf.
  Dann umsortieren.
- `/*#__PURE__*/` übersteht tsc (`removeComments` ist nicht gesetzt) und die Concatenation von
  webpack.
- Den Kommentar über dem Abschnitt „builtins“ in `runtime.ts` anpassen. Er beschreibt den
  pauschalen Import aller Exporte, der mit B wegfällt.

**Umsetzung:**

- Umgebaut per AST-Skript, nicht von Hand. Es war ein Einmal-Werkzeug und liegt nicht im Repo.
- **Benannte Funktionen statt Arrow.** Eine Arrow-Funktion als Argument bekommt keinen Namen:
  `map.name` war `''`, und im Stacktrace fehlte `at map`. Deshalb
  `_createFunction(function map(…) {…}, …)`.
- `Or` und `Not` standen vor `List`, das ihre `params` brauchen. Sie wurden an ihre
  `params`-Stelle verschoben, beim Laden benutzt sie vorher niemand.
- `deepEqual` wird in der Runtime als gehoistete Funktion gebraucht. Sie heißt intern jetzt
  `isDeepEqual`, der Export `deepEqual` ist `_createFunction(isDeepEqual, …)`.
- **Vorhandener Fehler, beim Umbau unverändert übernommen:** Der `_createFunction`-Aufruf nach
  `setElement` nannte `getElement`. `getElement` hat deshalb die `params` von `setElement`, und
  `setElement` hatte keine. Beim Umbau wurde das Verhalten genau übernommen und danach separat
  behoben, mit Tests, die zuerst rot waren (`getElement/setElement` in `runtime.test.ts`). Ohne
  `params` bekam `setElement` bei benannten Argumenten das ganze Dictionary als `values`.
- Typecheck: Mit der generischen Signatur aus A2 haben die Builtins in `runtime.test.ts` jetzt
  ihre echten Typen. Drei Stellen brauchten eine explizite Verengung (`parseJson`).

### A4: Prüfskript gegen Rückfälle

Eine einzige vergessene Markierung reicht, und die ganze Kette daran bleibt im Bundle, ohne dass
etwas rot wird. Deshalb ein statisches Prüfskript `scripts/check-runtime-purity.mjs`. Es ist
**kein Test in der Suite**: Es liest und parst bei jedem Lauf rund 3300 Zeilen TypeScript, das
wäre im Verhältnis zur restlichen Testzeit teuer. Es wird von Hand aufgerufen, wenn sich die
Runtime ändert, so wie die Benches.

- Parst `runtime.ts` und `test-runtime.ts` mit der TypeScript-API. Die ist ohnehin eine
  Abhängigkeit, wegen [typescript-parser.ts](../src/parser/typescript-parser.ts).
- Erlaubt auf oberster Ebene: Imports, Typen und Interfaces, `function`- und
  `class`-Deklarationen, `export { … }`, Variablendeklarationen. Ein Aufruf in einem
  Initialisierer ist nur erlaubt, wenn direkt davor `/*#__PURE__*/` steht, und das rekursiv,
  aber nicht innerhalb von Funktionsrümpfen.
- Einzelne bewusste Ausnahmen stehen in einer Liste im Skript, jede mit Begründung.
- Eine Zeile pro Verstoß mit Zeilennummer, Exit-Code ungleich 0, wenn es Verstöße gibt. So ist
  direkt sichtbar, welche Definition nachzuziehen ist.
- Als `npm run check-runtime-purity` in die `package.json` aufnehmen und in der CLAUDE.md
  neben den Benches erwähnen: aufrufen nach jeder Änderung an `runtime.ts`.

Die Bundle-Größe selbst wird nur einmalig von Hand gemessen (A1, A6), nicht dauerhaft geprüft.

### A5: Minimizer einschalten

Die Konfiguration aus A1 übernehmen, mit der Entscheidung aus A1.5. Immer an, kein Opt-in. Den
Unterpunkt „minify als opt-in“ im TODO beim Bundling danach neu fassen. Echtes Minifizieren (mit
`mangle`) bleibt eine eigene Frage.

Umgesetzt in [compiler.ts](../src/compiler.ts):

```js
optimization: {
	minimize: true,
	minimizeOptions: {
		javascript: {
			compress: { defaults: false, unused: true, dead_code: true, side_effects: true },
			mangle: false,
		},
	},
},
```

Ohne `beautify` (siehe Befund A1), dazu `removeSourceMapNames` nach dem Lauf.

### A6: Nachmessung

Dieselben Messungen wie in A0, dazu
`npm run bench-runtime -- --save --note "nach runtime-tree-shaking"`. Erwartet wird kein
Unterschied in der Laufzeit, denn `_createFunction` liefert dieselbe Funktion zurück. Ergebnis
in diesem Dokument unter „Ergebnis“ nachtragen.

### A7: terser ersetzt durch shakeRuntime

Mit terser dauerte der yugioh-Build 2,6 statt 1,6 s. Gemessen entfielen davon etwa 0,8 s auf
terser selbst, 0,15 s auf die Source Map des minimierten Codes und 0,1 s auf
`removeSourceMapNames`. terser arbeitete das ganze Bundle durch, das zu 88 % aus dem JSON-Import
besteht. Entfernen sollte es aber nur Teile der Runtime.

Die Startmenge dafür kennt der Compiler schon: Nach B liefert der Emitter je Datei die
importierten Runtime-Namen. Und nach A3/A4 besteht die Runtime auf oberster Ebene nur aus
Deklarationen ohne Seiteneffekt beim Laden. Damit reicht ein Graph über Namen:

- [runtime-shaking.ts](../src/runtime-shaking.ts) `shakeRuntime(runtimeJs, usedNames)` parst
  `runtime.js` mit der TypeScript-API, sammelt je Deklaration die referenzierten Namen der obersten
  Ebene (ohne Feld- und Methodennamen, `values.map` hält `map` nicht), bildet die transitive Hülle ab
  `usedNames` und lässt den Rest weg.
- Eine weggelassene Deklaration wird durch ihre Zeilenumbrüche ersetzt. Alle Zeilennummern in
  `runtime.js` bleiben gleich, Source Maps und Stacktraces sind unberührt.
- `compileProject` sammelt die Namen aller emittierten Dateien und schreibt `runtime.js` damit,
  statt sie zu kopieren. webpack läuft wieder mit `minimize: false`. `removeSourceMapNames` und die
  kompakte Ausgabe entfallen.
- Erreichbarkeit nach Namen statt nach Bindungen schätzt nach oben ab. Ein lokaler Bezeichner wie
  eine Definition der obersten Ebene hält diese am Leben. Das ist harmlos.
- Tests in [runtime-shaking.test.ts](../src/runtime-shaking.test.ts), ohne Dateizugriff.
- Einmalig geprüft: Für jeden der 102 Runtime-Exporte einzeln verkleinert, danach hatte keine
  Variante eine unaufgelöste Referenz, die die volle Runtime nicht auch hat (Scope-Analyse von
  terser).

`/*#__PURE__*/` und das Prüfskript bleiben. Die Markierung ist jetzt die Zusicherung, dass ein
Aufruf nichts außer seinem Ergebnis bewirkt. Darauf verlässt sich `shakeRuntime`, wenn es eine
Deklaration weglässt. Ein Minimizer würde dieselbe Schreibweise verstehen.

Der Frame-Name von `runJs` im Stacktrace stimmt jetzt auch (`at runJs` statt
`_createFunction.singleNames.name`). Den falschen Namen gab es schon vor dem Umbau, er kam aus der
Namensauflösung über die Source Map des Bundles.

## Teil B: nur benutzte Builtins importieren

### B1: Benutzte Namen ermitteln

In `syntaxTreeToJsWithMappings` ([emitter.ts](../src/emitter.ts)) zuerst den Rumpf erzeugen,
dann den Import davor setzen. Die benutzten Namen findet ein Scan über das erzeugte JS: alle
Bezeichner, die in `runtimeKeys` vorkommen.

Warum ein Scan und keine Sammlung beim Emittieren: Der Emitter erzeugt Hilfsaufrufe
(`_branch`, `_callFunction`, `_createFunction`, `_combineObject`, `_isOfType`,
`_noBranchMatched`, …) an vielen Stellen als festen Text. Eine explizite Sammlung müsste jede
davon anfassen, und eine vergessene Stelle fiele erst zur Laufzeit als `ReferenceError` auf, und
zwar nur, wenn der Zweig tatsächlich läuft. Der Scan sieht alles, was im Text steht.

Er schätzt dabei nach oben ab. Ein Wort wie `map` in einem Textliteral erzeugt einen
überflüssigen Import. Das ist harmlos, webpack entfernt ihn im Bundle wieder. Überdeckung ist
keine Fehlerquelle: Ein lokaler Name gleich einem Builtin ist JUL4003, und `true`/`false` sind
keine Runtime-Exporte.

Gleiches für `testRuntimeKeys` in `*.test.jul`-Dateien.

### B2: Import-Zeile

- `getRuntimeImportJs(runtimePath, names)` bekommt die Namen, sortiert, damit die Ausgabe
  stabil bleibt.
- Ohne benutzte Namen gibt es keine Import-Zeile.
- Die Source Mappings entstehen erst in `extractSourceMappings` über Marker im fertigen Text,
  also ist die Reihenfolge „Rumpf zuerst, dann Import davor“ unkritisch. Mit einem Test
  absichern: Mapping-Positionen für eine Datei mit und ohne Import.
- Das TODO im Emitter („nur benutzte builtins importieren?“) entfernen.

### B3: Nicht betroffen

- `constant-folding.ts` bindet für das Falten weiter die ganze Runtime (`tryBuildCallable`).
  Dort geht es nicht um ausgelieferten Code.
- Language Server: emittiert nicht.
- `jul test` ([compiler.ts](../src/compiler.ts), `emitToJs` ohne Bundle): profitiert von B, von
  A nicht.

### B4: Tests

Diese Tests gehören in die Suite. Sie laufen ohne Dateizugriff und ohne Bundler: Code parsen
(und wo Typen nötig sind, über `createInMemoryHost` checken), `syntaxTreeToJs` aufrufen, die
Import-Zeile prüfen. Das kostet nicht mehr als die übrigen Emitter-Tests.

Der Prüf-Helfer in [emitter.test.ts](../src/emitter.test.ts) vergleicht heute mit
`getRuntimeImportJs('') + result`. Neu:

- Der Helfer vergleicht nur den Rumpf, die Import-Zeile wird vorher abgetrennt. Die bestehenden
  Fälle bleiben dadurch unverändert.
- Eigene Fälle für den Import, ein `it` pro Fall:
  - Referenz auf ein Builtin → genau dieses im Import
  - `?`-Branching → `_branch` bzw. der Hilfsaufruf, den die Dispatch-Form erzeugt
  - Funktionsliteral → `_createFunction`
  - Typ-Guard mit Builtin-Typ (`(a: Integer) => a`) → `Integer`
  - Datei ohne Runtime-Bezug (nur Zahlenliterale) → keine Import-Zeile
  - `*.test.jul` → Test-Runtime-Import nur mit den benutzten Namen
  - Builtin-Name in einem Textliteral → zusätzlicher Import, dokumentiert die Abschätzung nach
    oben

## Reihenfolge

1. A0 Messbasis
2. B komplett. B ist unabhängig von A, klein, und macht beim Spike die emittierten Dateien lesbar.
3. A1 Spike, danach Entscheidung über den Minimizer
4. A2, A4, A3 (Prüfskript zuerst schreiben: Es schlägt an und listet die Stellen, die A3
   abarbeitet)
5. A5, A6: einmaliger Test des reduzierten Bundles von Hand

## Abnahme

- `node --run test` und `npm run typecheck` in `jul-compiler` grün, einschließlich der neuen
  Emitter-Tests aus B4
- `npm run check-runtime-purity` ohne Verstöße
- `npm run build-all`, dann `npm run test-snapshot` im Language Server unverändert
- Von Hand bauen und ausführen: `jul-examples/fizz-buzz`, `jul-examples/cli`,
  `jul-examples/ui/preserve-dom` (im Browser), `jul test` in `jul-examples/fibonacci`, yugioh
  bauen und im Browser starten
- Breakpoint in einer `.jul`-Datei im Bundle greift weiterhin
- Messwerte aus A6 unter „Ergebnis“ eingetragen

## Risiken

- **Build-Dauer:** terser über das yugioh-Bundle, das zu 84 % aus JSON besteht. Eingetreten:
  +1 s. Behoben mit A7, terser läuft nicht mehr.
- **Terser formt Code um:** Mit `defaults: false` sind nur die ausdrücklich eingeschalteten
  Durchläufe aktiv. Dennoch Source Maps und Stacktraces in A1 prüfen.
- **Zu viel entfernt:** Denkbar wäre Code, der nur über einen dynamischen Zugriff erreicht wird.
  `runJs` ist ein indirektes `eval`, das im globalen Scope läuft und die Bindungen im Bundle
  schon heute nicht sieht. Das Verhalten ändert sich also nicht. Andere dynamische Zugriffe auf
  Runtime-Namen gibt es im emittierten Code nicht.
- **Vergessene Markierung:** fällt nur auf, wenn jemand das Prüfskript aus A4 aufruft. Es gibt
  keine CI, also dieselbe Disziplin wie bei den Benches.

## Ergebnis

Gemessen am 2026-09-27, einmalig von Hand. Build-Dauer ist der Median aus drei Läufen von `jul`
ohne Kommando (kleine Projekte: ein Lauf).

| Projekt | vorher roh / gzip | mit terser (A5) | mit shakeRuntime (A7) | Build vorher → terser → A7 |
|---|---|---|---|---|
| `jul-examples/ui/preserve-dom` | 74,8 / 13,1 kB | 29,1 / 6,1 kB | 12,1 / 3,5 kB | 1,03 → 1,02 → 0,80 s |
| `jul-examples/fizz-buzz` | 75,2 / 13,2 kB | 37,9 / 8,0 kB | 30,5 / 6,4 kB | 0,79 → 1,08 → 0,79 s |
| `jul-examples/cli` | 74,4 / 13,0 kB | 28,9 / 6,1 kB | 7,0 / 2,2 kB | 0,77 → 1,03 → 0,77 s |
| yugioh | 2039 / 321 kB | 1635 / 294 kB | 2013 / 317 kB | 1,62 → 2,60 → 1,63 s |

- Mit A7 schrumpfen kleine Programme auf 10 bis 40 %, stärker als mit terser. terser hat mit den
  gewählten Optionen einen Teil der unerreichbaren Definitionen stehen lassen.
- Die Build-Dauer ist wieder auf dem Stand von vorher.
- yugioh wird nur um die Runtime kleiner. Der Gewinn mit terser kam dort aus der kompakten Ausgabe
  des JSON-Imports, und darauf wurde bewusst verzichtet.
- `bench-runtime`: keine Veränderung, alle Fälle zwischen −9 % und +1 %, also im Rauschen.
  Gemessen nach A3, A7 ändert `runtime.ts` nicht.
- Stacktraces zeigen dieselben Positionen wie vor der Umstellung, der Name von `runJs` ist jetzt
  sogar richtig.
- Nicht im Browser geprüft: `ui/preserve-dom`, `ui/todo-list`, `counter` und yugioh bauen, laufen
  aber nur mit DOM. In Node laden sie bis zum ersten Zugriff auf `document` ohne Fehler.
