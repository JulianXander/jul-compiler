# `#todo` und `todo(…)`

Idee, keine Entscheidung. Zwei Richtungen, die sich nicht ausschließen: eine Anweisung im
Kommentar, die Werkzeuge auswerten, und ein Ausdruck, der unfertigen Code übersetzbar macht.

## `#TODO` als Anweisung im Kommentar

```jul
#TODO Fehlerbehandlung für leere Antworten
response$ = httpTextRequest$(url §get§ 5000f)
```

**Umgesetzt:** `#TODO` ist eine Anweisung (siehe
[comment-directives.ts](../../src/parser/comment-directives.ts)) und erscheint als Information
JUL2903 mit dem Text des Kommentars, im Editor also in der Liste der Probleme, in der Ausgabe der
CLI nicht. Jede andere Schreibweise am Anfang eines Kommentars (`# TODO`, `#todo`) ist die Warnung
JUL2904, umstellen lässt sich eine Codebasis mit
[migrate-todo.mjs](../../scripts/migrate-todo.mjs). Ein `#TODO` wird nicht zur Beschreibung der
folgenden Definition.

Was darüber hinaus möglich wäre:

- `jul check` nennt die Zahl offener TODOs, ein Befehl wie `jul todos` listet sie mit Datei und
  Zeile.
- Ein Schalter wie `--no-todo` macht jedes `#todo` zum Fehler, etwa in CI.
- Optional ein Zuständiger: `#todo(julian) …`.

Vorbilder:

- Visual Studio (C#), Eclipse, IntelliJ: Kommentar-Token wie `TODO`, `HACK`, `FIXME` in einer
  eigenen Aufgabenliste. Das leistet die IDE, nicht der Compiler.
- Swift und C/C#: `#warning("…")` und `#error("…")` als Direktiven, die der Compiler als Warnung
  bzw. Fehler ausgibt.
- Go: die Konvention `// TODO(name):`.
- VS Code: Erweiterungen wie Todo Tree durchsuchen den Text.
- Elm: `--optimize` verweigert den Build, solange `Debug` benutzt wird.

Abwägung:

- ➕ Vom Compiler gekannt, verhält es sich in jedem Editor und in der CLI gleich, lässt sich
  zählen und in CI verweigern.
- ➖ Vieles davon kann schon der Editor. Den Unterschied macht nur, was die CLI damit tut.

## `todo(…)` als Ausdruck vom Typ `Never`

```jul
parseCard = (text: Text) :> Card =>
	?(text)
		(json: JsonText) => …
		() => todo(§andere Formate§)
```

`todo` liefert `Never`. Weil `Never` in jeden Typ passt, besteht der unfertige Zweig die Prüfung.
Zur Laufzeit wirft er mit der Meldung.

Vorbilder:

- Rust: `todo!()` und `unimplemented!()` mit dem Typ `!`, brechen zur Laufzeit ab.
- Kotlin: `TODO("…")` mit dem Rückgabetyp `Nothing`, wirft `NotImplementedError`.
- Scala: `???`.
- Haskell: `undefined`, dazu Typed Holes (`_`): Der Compiler meldet den Typ, der an der Stelle
  erwartet wird.
- Elm: `Debug.todo "…"`, von `--optimize` verweigert.
- Python, Java: `raise NotImplementedError` bzw. `throw new UnsupportedOperationException()`, ohne
  Unterstützung durch den Typ.

Abwägung:

- ➕ Code skizzieren, der schon übersetzt wird. `Never` gibt es bereits, der Aufwand ist ein
  Builtin in core-lib und Runtime.
- ➕ Der Checker kann jede Verwendung melden, damit ein `todo` nicht still ausgeliefert wird, und
  dabei wie bei den Typed Holes den erwarteten Typ nennen: „todo: expected Card here“. Den kennt
  er über den erwarteten Typ je Ausdruck.
- ➖ Anders als ein Kommentar wirkt es zur Laufzeit. Übersehen, liefert man einen Absturz aus.
  Dagegen hilft die Meldung, besser ein Fehler in einem Build-Modus für die Auslieferung, den es
  heute nicht gibt.

## Einschätzung

Einen Mehrwert, den nur der Compiler bieten kann, hat vor allem `todo(…)`: Typ `Never`, eine
Meldung mit dem erwarteten Typ, später vielleicht ein Fehler beim Build für die Auslieferung.
Bei `#TODO` bringt der nächste Schritt erst etwas, wenn die CLI damit arbeitet: zählen, auflisten,
in CI verweigern.
