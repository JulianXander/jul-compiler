# Tests: ein `it` pro Fall

## Problem

Die tabellengetriebenen Tests (Array `expectedResults`, darüber `forEach` mit `it(...)`) melden
einen roten Fall mit einem Stack, der auf die `expect`-Zeile in der Schleife zeigt, nicht auf den
Tabelleneintrag. Den Fall findet man nur über seinen Namen. Das betrifft jede verbreitete Form
parametrisierter Tests (Jest/Vitest `test.each`, pytest `parametrize`, JUnit `@ParameterizedTest`,
Go-Tabellen mit `t.Run`).

## Entscheidung

Zwei Schritte, der erste steht für sich.

### Schritt 1: ein `it` pro Fall, Prüfung im Helfer

```ts
it('reference-true', () => {
	expectParse('true');
});
it('function-call-multiline-argument-with-crlf', () => {
	expectParse('myFunc(\r\n\t§someValue§\r\n)', {
		errors: [...],
	});
});
```

- Die Prüflogik steht einmal im Helfer, die erwarteten Werte bleiben unverändert.
- Der Helfer wird mit `reportAtCaller` aus `src/test-util.ts` erzeugt. Scheitert eine Prüfung
  darin, wird der Stack ab der Aufrufstelle neu aufgenommen (`Error.captureStackTrace`), der
  oberste Frame ist also die Zeile des Falls. Das entspricht `t.Helper()` in Go und
  `#[track_caller]` in Rust.
- Einzeilige Tabelleneinträge werden einzeilige `it`, mehrzeilige werden Blöcke.
- Umgestellt werden alle Tabellen, damit die Tests einheitlich sind: checker, parser, emitter,
  json-parser, typescript-parser, syntax-tree, project-loader, runtime, reference-index samt
  Nebentabellen.
- Abnahme: vorher und nachher dieselben Testtitel, alle grün; ein absichtlich roter Fall
  verlinkt auf seine eigene Zeile.

### Schritt 2 (später): Expect-Tests

Das zweite Argument des Helfers wird Text statt Objekt (AST-Dump, Fehler als
`zeile:spalte code: meldung`), ein Update-Modus schreibt es an der Aufrufstelle in den Quelltext
zurück, wie `expect-test` (rust-analyzer) oder `toMatchInlineSnapshot`. Offen sind das Textformat,
das Zurückschreiben (Backticks, `${`, Tabs im JUL-Code) und ein Modus „nur Fehler“ für die Fälle,
die heute absichtlich kein `result` haben.
