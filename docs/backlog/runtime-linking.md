# Runtime nur teilweise ausliefern

Reine Ideensammlung, keine Entscheidung getroffen.

Der naheliegende Weg, die Runtime im Bundle zu verkleinern, ist Tree-Shaking durch den Bundler
mit einer seiteneffektfreien Runtime und Imports nur der benutzten Builtins. Das ist in
[../runtime-tree-shaking.md](../runtime-tree-shaking.md) geplant. Hier stehen drei weitergehende
Ansätze. Sie werden interessant, wenn JUL auch ohne Bundler kleine Ausgaben liefern soll, wenn
webpack ersetzt wird, oder wenn sich das Tree-Shaking im Bundler als zu fragil erweist.

Alle drei setzen voraus, dass der Emitter weiß, welche Runtime-Namen eine Datei benutzt. Das
liefert Teil B des Plans oben.

## C: eigener Linker im Compiler

### Idee

Der Compiler entscheidet selbst, welche Teile der Runtime ins Ergebnis kommen, statt das dem
Bundler zu überlassen:

1. Beim Build des Compilers wird `runtime.ts` bzw. das gebaute `runtime.js` mit einem JS-Parser
   zerlegt, in Top-Level-Definitionen samt den Namen, die jede Definition referenziert. Daraus
   entsteht ein Abhängigkeitsgraph, der zusammen mit dem Quelltext jeder Definition als Datei
   nach `out` geschrieben wird.
2. Beim Emittieren eines Projekts: die benutzten Runtime-Namen aller Dateien vereinigen (Teil B),
   die transitive Hülle im Graphen bilden und nur diese Definitionen in ihrer ursprünglichen
   Reihenfolge als `runtime.js` schreiben.

### Vorteile

- Unabhängig vom Bundler. Wirkt auch für die emittierten Einzeldateien, für `jul test` und für
  einen späteren Wechsel zu esbuild, Rollup oder gar keinem Bundler.
- Deterministisch und ohne IO testbar: Graph plus Namensmenge rein, Liste von Definitionen raus.
- Keine `/*#__PURE__*/`-Markierungen nötig. Der Linker weiß selbst, dass
  `_createFunction(map, …)` zu `map` gehört, wenn der Graph so gebaut wird. Nachgestellte
  Aufrufe werden der Definition zugeschlagen, deren Namen sie als erstes Argument haben.

### Nachteile

- Spürbarer eigener Code: Parser für die Runtime, Graph, Serialisierung, Zuordnung der
  nachgestellten Aufrufe.
- Die Zuordnung ist eine Konvention, die die Runtime einhalten muss. Das ist dieselbe Disziplin
  wie die PURE-Markierungen, nur in anderer Form.
- Granularität: Klassen wie `StreamClass` kommen immer ganz. Das tut der Bundler aber auch.

### Dynamischer Zugriff

Bei Linkern anderer Sprachen ist Reflexion die typische Bruchstelle. Go schaltet das Entfernen
teilweise ab, sobald `reflect` Methoden dynamisch aufruft, Scala.js verlangt Annotationen. In
JUL ist das derzeit kein Problem:

- `runJs` ist `_createFunction(eval, …)`, also ein indirektes `eval`. Das läuft im globalen
  Scope und sieht weder die Bindungen im Bundle noch die Importe der emittierten Datei.
- Der JS-Text in `nativeFunction`/`nativeValue` steht nur in `core-lib.jul` und wird nie
  emittiert (siehe Kommentar im Abschnitt „builtins“ von `runtime.ts`).

Das kippt, falls es einmal eingebettetes JS im Nutzercode gibt, das auf Runtime-Namen zugreift,
etwa `nativeFunction` in Bibliotheken. Dann müsste der Linker diesen JS-Text ebenfalls parsen,
oder eine solche Datei zieht die ganze Runtime nach sich.

### Vorbilder

Elm (Dead-Code-Entfernen auf Funktionsebene über das ganze Programm, funktioniert gut, weil die
Sprache pur ist), die Linker von Scala.js und Kotlin/JS (auf der Zwischendarstellung vor der
JS-Ausgabe), dart2js, und auf Maschinenebene `--gc-sections` bzw. der Go-Linker.

## D: Runtime in Module aufteilen

### Idee

`runtime.ts` wird nach Funktionsgruppen aufgeteilt, etwa `runtime/core.ts` (`_callFunction`,
`_branch`, `_createFunction`, `_isOfType`, Typen), `runtime/stream.ts`, `runtime/json.ts`,
`runtime/list.ts`, `runtime/date.ts`, `runtime/http.ts`. Der Emitter importiert je Datei nur die
Module, aus denen sie Namen benutzt, und nur diese werden nach `out` kopiert.

### Vorteile

- Einfach zu verstehen, keine Annotationen, kein eigener Linker.
- Wirkt auch ohne Bundler.
- Allein `stream.ts` wäre ein großer Brocken: rund 700 Zeilen, die ein Programm ohne Streams nie
  braucht.

### Nachteile

- Grob: Wer `map` benutzt, bekommt ganz `list.ts`.
- Querverweise ziehen Module nach sich. `_isOfType` und die Typdarstellung werden überall
  gebraucht und landen im Kernmodul, das immer mitkommt. Wie groß der Kern tatsächlich wird,
  müsste man erst messen.
- Die Zuordnung Name → Modul muss der Emitter kennen, aus einem Index, der beim Build entsteht.
- Kombinierbar mit A: Der Bundler shakt innerhalb der Module weiter.

### Vorbild

Babel mit `core-js` und `useBuiltIns: 'usage'`: Die Nutzung wird im Code ermittelt, importiert
werden nur die passenden Polyfill-Module. Das ist sehr nah an JUL.

## E: Runtime nicht einbetten, sondern als Paket referenzieren

### Idee

Statt `runtime.js` nach `out` zu kopieren, importiert der emittierte Code ein Paket, etwa
`jul-runtime`. Das Projekt hängt davon ab wie ein TypeScript-Projekt mit `importHelpers` an
`tslib`.

### Vorteile

- Mehrere JUL-Bundles bzw. Bibliotheken teilen sich eine Runtime, statt sie jeweils mitzubringen.
  Relevant, sobald es JUL-Bibliotheken gibt, siehe „shared code? libraries?“ im TODO.
- Die Runtime kann unabhängig vom Compiler aktualisiert werden.

### Nachteile

- Verkleinert nichts, solange ohnehin gebündelt wird. Mit einem Bundler landet das Paket wieder
  im Bundle, das Tree-Shaking aus dem Plan braucht es dann weiterhin.
- Versionskopplung: Emitter und Runtime müssen zusammenpassen. Das bräuchte eine Versionsprüfung
  oder eine exakt gepinnte Abhängigkeit. Heute ist das trivial, weil die Runtime aus demselben
  Build stammt.
- Projekte ohne `package.json` (yugioh) bräuchten eine Installation oder einen Rückfall aufs
  Kopieren.

### Vorbilder

TypeScript (`importHelpers` → `tslib`), Babel (`@babel/plugin-transform-runtime` →
`@babel/runtime`), Kotlin/JS mit der Standardbibliothek als eigenem Modul.

## Abwägung

| | wirkt ohne Bundler | Aufwand | Granularität | eigene Konvention in der Runtime |
|---|---|---|---|---|
| Plan (A + B) | nein | klein | Definition | PURE-Markierungen |
| C Linker | ja | groß | Definition | Zuordnung nachgestellter Aufrufe |
| D Module | ja | mittel | Modul | Aufteilung pflegen |
| E Paket | – | mittel | – | Versionierung |

Wann es sich lohnt: C, wenn der Bundler wegfallen oder austauschbar werden soll. D, wenn A sich
als zu fragil erweist und eine grobe, robuste Lösung reicht. E erst mit JUL-Bibliotheken, die
eine gemeinsame Runtime teilen sollen.
