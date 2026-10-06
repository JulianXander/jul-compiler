# Formatter über Diagnosen

Idee ohne Entscheidung. Angeregt durch die tolerant geparsten Fehler JUL1108 (Block nicht in
eigener Zeile) und JUL1109 (schließende Klammer nicht in eigener Zeile).

## Ausgangslage

Der Parser liest diese Formen trotz Fehler als vollständigen Baum und meldet sie genau an der
Abweichung. Es gibt noch nichts, was sie behebt:

```jul
[].map(a (value) =>
	§test§)
```

Die gültige Form ist:

```jul
[].map(
	a
	(value) =>
		§test§
)
```

Im Language Server gibt es einen QuickFix-Weg (`codeActionProvider`, `ignore-comment.ts`). In
`jul-compiler/scripts` arbeiten die `migrate-*.mjs` nach demselben Muster: Der Parser meldet, die
Skripte ändern genau diese Stellen.

## Idee

Kein Formatter über den ganzen AST, sondern einer, der die **Diagnosen** behebt. Jeder fixbare
Fehlercode bekommt einen Fixer, der aus Quelltext und Fehler einen Text-Edit liefert.

### Fixer für JUL1108 und JUL1109

Beide haben dieselbe Korrektur: Die umschließende Klammerliste wird in die mehrzeilige Form
gebracht. Der Text wird aus den Schnipseln des Quelltexts zusammengesetzt, nicht aus dem AST neu
gedruckt:

1. Die kleinste Klammerliste (`binding` oder `data`) finden, die die Fehlerposition enthält. Ihr
   Bereich reicht vom öffnenden bis zum schließenden Zeichen, auch mitten in einer Zeile.
2. Neuer Text: öffnendes Zeichen, Zeilenumbruch, jedes Feld in einer eigenen Zeile mit dem Einzug
   der öffnenden Zeile plus einem Tab, Zeilenumbruch, Einzug der öffnenden Zeile, schließendes
   Zeichen.
3. Der Text eines Felds kommt aus dem Quelltext (Start bis Ende laut AST). Seine Folgezeilen
   bekommen einen Tab mehr, leere Zeilen bleiben leer.
4. Das Ergebnis ist ein Text-Edit über den Bereich der Liste.

Das deckt auch Felder vor dem Block, `]` statt `)`, Branching statt Lambda und die Klammer hinter
dem letzten Feld einer schon mehrzeiligen Liste ab.

### Weitere Fixer nach demselben Muster

- JUL1104 Windows-Zeilenende: `\r` am Zeilenende entfernen.
- JUL1103 Leerzeichen-Einrückung: Der Fehler trägt `expectedIndent`, Leerzeichen durch Tabs
  ersetzen.

### Vom Quick-Fix zum Formatter

Ein „Dokument formatieren“ wäre die Summe der Fixer: parsen, alle fixbaren Fehler beheben, neu
parsen, bis kein fixbarer Fehler mehr da ist. Überlappende Bereiche (verschachtelte Listen wie
`[⏎⇥[⏎⇥⇥1⏎⇥]]`) werden nicht verrechnet: Pro Durchgang gelten nur nicht überlappende Edits, danach
wird neu geparst.

## Wo es leben würde

Eigenes Modul im Compiler ohne IO und ohne LSP-Anbindung, z. B. `getFixEdits(code, errors)` →
`{ range, newText }[]`, getestet über `parseCode` bzw. `createInMemoryHost`. Der Language Server
ruft es aus `codeAction` (QuickFix je Diagnose) und aus einem `documentFormattingProvider` auf,
die CLI optional als `format [--write]` wie bei den Migrationsskripten.

## Zu prüfen

- **Mehrzeilige Text-Literale** in einem verschobenen Feld: Der zusätzliche Tab auf den
  Folgezeilen darf den Textinhalt nicht ändern.
- **Kommentare** zwischen Feldern: In Inline-Listen gibt es keine, in mehrzeiligen bleiben die
  Zeilen unberührt, solange nur das Ende angefasst wird.
- **Idempotenz**: Nach dem Fix parst der Code ohne diese Fehler, ein zweiter Lauf ändert nichts.
- **Gleicher AST** (ohne Positionen) vor und nach dem Fix, wie ihn die `equivalentTo`-Tests der
  Klammerlisten heute schon prüfen.

## Reihenfolge

1. Fixer für JUL1108 und JUL1109 als reine Funktion mit Unit-Tests.
2. QuickFix im Language Server.
3. Danach `documentFormattingProvider` und CLI, falls gewünscht, samt der weiteren Fixer.

## Offen

Zuerst nur der QuickFix für JUL1108/JUL1109, oder gleich ein generelles „Dokument formatieren“,
das alle fixbaren Fehler behebt?
