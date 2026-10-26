# Plan: Formatter für Klammerlisten

Ziel: Eine Klammerliste zwischen einzeiliger und mehrzeiliger Form umstellen, ohne jedes Feld von
Hand umzubrechen. Der Nutzer gibt die Form mit einem Zeichen vor, der Formatter erledigt den Rest
(wie die „magic trailing comma“ bei Black).

## Signal

Das Zeichen direkt hinter der öffnenden Klammer entscheidet:

- **Zeilenumbruch:** mehrzeilig. Jedes Feld steht in einer eigenen Zeile, eine Ebene tiefer
  eingerückt, die schließende Klammer in einer eigenen Zeile.
- **Sonst:** einzeilig. Die Felder stehen mit Leerzeichen getrennt in der Zeile der öffnenden
  Klammer.

Umbrechen heißt also Enter hinter `(`, zusammenziehen heißt den Umbruch hinter `(` löschen. Eine
Zeilenbreite gibt es nicht. Verschachtelte Klammerlisten folgen jeweils ihrem eigenen Signal.

Ein mehrzeiliges Feld (Klammerliste mit eigenem Umbruch, mehrzeiliger Text) darf in einer
einzeiligen Liste stehen, auch mitten darin. Die Klammer steht direkt hinter ihm, so wie es heute
schon gültig ist:

```jul
x = f(a [
	b
] c)
```

Ein Lambda oder Branching mit Blockrumpf darf nicht inline stehen (JUL1108). Es erzwingt die
mehrzeilige Form unabhängig vom Signal, weil es keine einzeilige gibt.

## Schritte

### 1. Parser: beide Abweichungen vollständig wiederherstellen (erledigt)

Umgesetzt in `fieldsInRowParser` (mehrzeiliger Zweig) und in der Feldschleife von
`createBracketedInlineParser`, Tests unter „Klammerlisten mit Feldern abweichend vom Umbruch“.
`parse` im yugioh-Bench ohne Verschlechterung (67,7 ms vorher, 60,7 ms nachher, im Rauschen).
Nicht abgedeckt: Kommentar- und Leerzeilen zwischen den Folgezeilen einer einzeiligen Liste, dort
bleibt es bei JUL1110.

Vorher verlor der Parser Felder, sobald die Form nicht zum Signal passte:

| Eingabe | Vorher |
|---|---|
| `f(⏎⇥a b c)` | kein Ausdruck, Folgefehler bis zum Dateiende |
| `[⏎⇥1 2 3⏎]` | Liste nur mit `1` (JUL1102) |
| `[a b⏎⇥c]` | Liste `a b`, JUL1110 und JUL1050 je Folgezeile |

Beide Fälle werden mit eigenem Fehler geparst, der Baum enthält alle Felder:

- **JUL1112** mehrere Felder in einer Zeile einer mehrzeiligen Klammerliste. Gilt nur in
  Klammerlisten, nicht in Funktionsrümpfen, dort bleibt es bei JUL1102.
- **JUL1113** Felder einer einzeiligen Klammerliste in Folgezeilen. Nur wenn die Folgezeilen tiefer
  eingerückt sind, ein offenes `[a` über einer Zeile auf gleicher Ebene bleibt JUL1110.

Beide sind `error`: Die kanonische Form bleibt eindeutig, der Formatter stellt sie her.

### 2. Formatter im Compiler (erledigt)

`src/formatter/formatter.ts` ohne IO, `formatCode(code, filePath)` und `getFormatEdits` (ein Edit
über den geänderten Bereich). Statt eines rekursiven Renderers in Durchgängen:

- Je Durchgang wird die äußerste Klammerliste je Pfad neu geschrieben, die nicht in ihrer Form
  steht, danach wird neu geparst, bis kein Edit mehr entsteht. Verschachtelte Listen kommen so im
  nächsten Durchgang dran, Edits überlappen nie.
- Die Form folgt dem Signal (bzw. dem Blockrumpf eines Felds).
- Felder werden wörtlich aus dem Quelltext übernommen, ihre Folgezeilen um die Differenz zur
  Einrückung ihrer Startzeile verschoben. Leer- und Kommentarzeilen zwischen den Feldern bleiben
  in der mehrzeiligen Form erhalten.
- Weicht der Syntaxbaum ohne Positionen danach ab, bleibt der Code unverändert.

Über yugioh, `jul-examples` und die core-lib (79 Dateien, 120 ms) ändert er nur `test1.jul`, die
einzige Datei mit Formfehlern.

Wird nicht zusammengezogen (Knoten bleibt unverändert, der Fehler bleibt stehen):

- Kommentare zwischen den Feldern, sie werden zu Beschreibungen und laufen bis zum Zeilenende.
- Ein Feld mit Blockrumpf, siehe oben.

### 3. Language Server und Extension (erledigt)

Modul `formatting.ts` im Language Server mit Unit-Tests, in `server.ts` nur die Verdrahtung, für
`.jul`-Dateien:

- `textDocument/formatting`: Dokument formatieren und Format-on-save.
- `textDocument/onTypeFormatting` mit Auslöser `\n`: Enter in einer Klammerliste bricht sie um, hinter
  der öffnenden Klammer wie zwischen zwei Feldern. Der Server nimmt den getippten Umbruch zurück und
  schreibt nur die Liste an dieser Stelle mehrzeilig (`FormatOptions.at` und `multiline`), weil
  VSCode die neue Zeile zwischen zwei Feldern nicht tiefer einrückt. Eine leere neue Zeile und ein
  Umbruch mitten in einem Feld lassen alles, wie es ist. In der Extension
  `"[jul]": { "editor.formatOnType": true }` als `configurationDefaults`.
- Zusammenziehen löst kein getipptes Zeichen aus, es läuft über Format-on-save oder „Dokument
  formatieren“.

Keine QuickFixes für die Formfehler, das Formatieren deckt sie ab.

Optional `jul format [--write]` in der CLI.

### 4. Absicherung

- Gleicher AST ohne Positionen vor und nach dem Formatieren, in Tests als Prüfung und im Formatter
  als Sicherheitsnetz (Edit verwerfen bei Abweichung).
- Idempotenz: Ein zweiter Lauf liefert keine Edits.
- Roundtrip: umbrechen, Signal entfernen, zusammenziehen ergibt den Ausgangstext.
- `fuzz` und ein Lauf über alle Dateien in yugioh. Eine Migration ist nicht nötig, die Syntax
  ändert sich nicht.

Bench vor und nach Schritt 1, `multilineBlock` liegt im heißen Pfad.

## Später nach demselben Muster

- JUL1104 Windows-Zeilenende: `\r` entfernen.
- JUL1103 Leerzeichen-Einrückung: Der Fehler trägt `expectedIndent`, Leerzeichen durch Tabs ersetzen.
- Imports sortieren, siehe [backlog/imports-sortieren.md](backlog/imports-sortieren.md).
