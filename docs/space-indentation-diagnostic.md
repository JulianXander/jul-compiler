# Space-Einrückung: spezifische Fehlermeldung + Quick Fix

## Status

Konzept (dritter Entwurf) steht, Implementierung offen. Zwei Vorversionen sind gescheitert, ihre
Ursachen stehen unter [Was schiefging](#was-schiefging) - der Abschnitt ist der eigentliche Wert
dieses Dokuments, jeder neue Ansatz muss gegen beide Fehler bestehen.

Im Code liegen aktuell: `ErrorCode.spaceIndentation = 1103` in `compiler-errors.ts` (samt
`errorInfos`-Eintrag und optionalem Feld `expectedIndent` auf `CompilerError`, beides noch
ungenutzt), der Doku-Abschnitt JUL1103 in `jul-homepage/docs/docs/documentation/error-codes.md`,
und zwei **rote** Tests in `parser.test.ts` (Region Einrückung) als Zielvorgabe:
`space-indentation-single-line` und `space-indentation-nested-with-dedent`. `parser.ts` ist
unverändert im Ausgangszustand.

## Context

JUL erzwingt Tab-Einrückung. Beim Einfügen von Code aus KI-Chats kommen häufig Leerzeichen statt
Tabs. Heute gibt es dafür keine verständliche Meldung: `indentParser`
([parser.ts:370-383](../src/parser/parser.ts)) matcht Einrückung als exakten Tab-Token
(`tokenParser('\t'.repeat(indent))`), und `multilineParser`
([parser.ts:415-431](../src/parser/parser.ts)) wertet **jedes** Fehlschlagen davon als "Ende des
Blocks". Der Nutzer sieht dadurch nur Folgefehler (`unparsedRestOfRow`, `expectedOneOf`) an
Stellen, die mit der Ursache nichts zu tun haben.

Ziel: eine spezifische Meldung an der betroffenen Zeile, plus ein VSCode Quick Fix, der die
Einrückung auf Tabs umstellt.

## Was schiefging

**Versuch 1 - Fehler im Blockende-Zweig von `multilineParser` melden.** Blieb wirkungslos: dieser
Zweig wird nur bei `hasParsed: false` erreicht, und Fehlschläge werden beim Backtracking verworfen.
`multiplicationParser` ([parser-combinator.ts:195-203](../src/parser/parser-combinator.ts)) gibt bei
`minOccurs = 0` einen Erfolg mit den *vorher* gesammelten Fehlern zurück - die des gescheiterten
Versuchs werden nie übernommen. `choiceParser` verwirft ebenso jede erfolglose Alternative. Da
`foo(` notfalls als bloße Referenz `foo` durchgeht, verschwand der Fehler restlos.

> **Regel daraus:** Eine Diagnose überlebt nur auf einem **erfolgreichen** Parse-Pfad. Was im
> Fehlschlag entsteht, ist verloren, sobald irgendeine Alternative greift.

**Versuch 2 - `indentParser` tolerant: Whitespace an der Mismatch-Stelle ⇒ Erfolg, gesamte führende
Whitespace-Sequenz konsumieren.** Erfüllte die Regel oben, war aber fachlich falsch. Die Annahme
"ein echtes Dedent beginnt nie mit Whitespace" gilt nur, solange der Rest der Datei korrekt
eingerückt ist. Ist die **ganze Datei** auf Leerzeichen umgestellt, beginnt jede Zeile mit
Leerzeichen - auch echte Dedents wie eine schließende Klammer. Die Regel konnte "gleiche Ebene,
falsches Zeichen" nicht von "flachere Ebene, falsches Zeichen" unterscheiden, ordnete jede Zeile
der aktuellen Ebene zu und zerstörte damit die Struktur. Realtest an
`C:\Projects\privat\yugioh\src\game-logic\game-logic.jul` (2856 Zeilen, komplett auf Leerzeichen
umgestellt): Hänger. Synthetisch: Tiefe 10 rund 60x langsamer, ab Tiefe 30 praktisch stehend.

> **Regel daraus:** Die Entscheidung ist keine Zeichenfrage ("ist das ein Leerzeichen?"), sondern
> eine **Ebenenfrage** ("auf welcher Tiefe steht diese Zeile?"). Und sie darf nicht davon ausgehen,
> dass der Rest der Datei sauber ist.

## Neues Konzept

### Kernidee

Heute vermischt `indentParser` zwei Dinge in einem `tokenParser`-Aufruf: das **Messen** der
Einrückung und das **Vergleichen** mit der erwarteten Tiefe. Bei Tabs fällt das zusammen, weil ein
Zeichen genau einer Ebene entspricht. Bei Leerzeichen fehlt dieser Umrechnungsfaktor - genau da
klafft die Lücke. Das Konzept trennt deshalb:

1. **Breite ermitteln** (einmal pro Datei, außerhalb des Parsens),
2. **Zeile messen** (Zeichen → Ebene, rein lexikalisch),
3. **Vergleichen** (Ebene gegen erwartete Tiefe).

### 1. Einrückungsbreite: ein Vorlauf, kein Parser-Zustand

Die Breite (Leerzeichen pro Ebene) ist eine Eigenschaft der **Datei**, keine der Parse-Position.
Jede Ermittlung *während* des Parsens wäre reihenfolge- und backtracking-abhängig - also wieder
genau die Fehlerklasse aus Versuch 1. Deshalb: ein deterministischer Vorlauf über `rows`.

- Für jede Zeile die führende `[ \t]*`-Sequenz nehmen, davon die **reinen Leerzeichen-Längen**
  sammeln.
- Breite = **größter gemeinsamer Teiler** dieser Längen (2-Space-Datei → 2, 4-Space-Datei → 4).
- **Guard:** Ergibt der ggT 1, obwohl längere Sequenzen vorkommen, gilt die Breite als *unbekannt*
  (typisch bei gemischten Dateien oder wenn Textliteral-Inhalt die Messung verfälscht). Dann greift
  die Erkennung gar nicht und es bleibt exakt beim heutigen Verhalten.

`rows` wird genau einmal pro Parse-Lauf erzeugt ([parser.ts:180](../src/parser/parser.ts)), also
lässt sich das Ergebnis über eine `WeakMap<string[], number | undefined>` memoisieren - ohne die
`Parser`-Signatur zu erweitern und ohne globalen veränderlichen Zustand.

### 2. Zeile messen: zeichenweise bis zur erwarteten Tiefe

Statt eines Token-Vergleichs läuft `indentParser` die führende Einrückung entlang und zählt Ebenen,
**bis die erwartete Tiefe erreicht ist** - nicht weiter:

```
level = 0, i = startColumnIndex, sawSpaces = false
solange level < indent:
    row[i] === '\t'                  → i += 1;      level += 1
    row[i] === ' ' und Breite bekannt
       und >= Breite Leerzeichen da  → i += Breite; level += 1; sawSpaces = true
    sonst                            → kein Treffer
Treffer: endColumnIndex = i
```

Das frühe Stoppen ist wesentlich: Alles hinter der erreichten Tiefe bleibt **Inhalt**. Damit bleibt
mehrzeiliger Text (`§...§`) unangetastet - eine Zeile `\t\t   hallo` bei `indent = 2` konsumiert
weiterhin nur die zwei Tabs, die drei Leerzeichen davor... bleiben Inhalt, exakt wie heute. Ein
Ansatz, der "die ganze führende Whitespace-Sequenz" schluckt (Versuch 2), hätte hier den Textinhalt
beschädigt.

Nebenbei erledigt sich damit die Frage nach der Zeichenklasse: erkannt werden nur `'\t'` und `' '`,
alles andere beendet den Lauf. Kein `/\s/`, keine Sonderfälle für `\r` & Co.

### 3. Vergleichen: drei Ausgänge statt zwei

| Fall | Ergebnis | Diagnose |
| --- | --- | --- |
| Tiefe erreicht, nur Tabs | Erfolg (wie heute) | keine |
| Tiefe erreicht, mit Leerzeichen | **Erfolg** | `spaceIndentation`, Range = konsumierte Einrückung, `expectedIndent = indent` |
| Tiefe nicht erreichbar (Zeile flacher, oder Breite unbekannt) | Fehlschlag (wie heute) | keine - das ist das Dedent-/Blockende-Signal |

Der mittlere Fall ist ein Erfolg, damit die Diagnose das Backtracking überlebt (Regel aus
Versuch 1). Der untere Fall bleibt unverändert Fehlschlag, damit Dedents weiterhin erkannt werden
(Regel aus Versuch 2). `multilineParser` braucht nur eine Ergänzung: `indentResult.errors` im
Erfolgsfall in die eigene Fehlerliste übernehmen.

### Probe am bisher fehlschlagenden Fall

```
0: foo(          Ebene 0
1:   a = bar(    Ebene 1
2:     x = 1     Ebene 2
3:     y = 2     Ebene 2
4:   )           Ebene 1
5:   b = 3       Ebene 1
6: )             Ebene 0
```

Breite = ggT(2, 4, 4, 2, 2) = 2. Zeile 4 (`  )`) wird von der inneren Feldliste (`indent = 2`)
gemessen: eine Ebene erreichbar, zweite nicht → Fehlschlag → Blockende, `bar(...)` schließt korrekt.
Anschließend prüft dieselbe Zeile die äußere Ebene (`indent = 1`) → Treffer mit `spaceIndentation` →
`)` matcht. Genau daran ist Versuch 2 gescheitert. Ergebnis: fünf `spaceIndentation`-Fehler in den
Zeilen 1-5 mit `expectedIndent` 1, 2, 2, 1, 1 - **das ist exakt die Erwartung des roten Tests**
`space-indentation-nested-with-dedent`. Der einzeilige Test fällt mit Breite 4 genauso.

### Sprachdesign: was sich nicht ändert

Tabs bleiben die einzige gültige Einrückung; Leerzeichen bleiben ein **Fehler** (`severity: error`),
keine erlaubte Variante. Neu ist allein, dass der Parser den Fall benennt und weiterarbeitet, statt
die Struktur zu verlieren - dieselbe Haltung wie bei unvollständigen Ausdrücken, die Parser und
Checker schon heute bewusst tolerieren, damit der Language Server weiterläuft.

## Umsetzungsschritte

1. **Bench-Vormessung** auf sauberem Stand: `npm run bench -- --save --note "vor space-indentation"`.
   (Bei den Vorversionen ausgelassen - genau dieser Umbau am Parser ist der Fall, für den das
   Protokoll in `CLAUDE.md` gedacht ist.)
2. `getIndentUnit(rows)` samt `WeakMap`-Memoisierung und ggT-Guard, in `parser.ts` neben
   `indentParser`.
3. `indentParser` auf den Messlauf aus Abschnitt 2 umstellen, drei Ausgänge aus Abschnitt 3.
4. `multilineParser`: `indentResult.errors` im Erfolgsfall übernehmen.
5. Language Server: `Diagnostic.data = { expectedIndent }` in `sendDiagnosticsForFile`,
   `codeActionProvider`-Capability, `connection.onCodeAction` mit Quick Fix "Convert indentation to
   tabs" (`TextEdit` über `diagnostic.range`, `newText: '\t'.repeat(expectedIndent)`). Vorlage für
   Handler-Aufbau: `connection.onRenameRequest`.

## Verifikation

1. Die zwei roten Tests in `parser.test.ts` werden grün, ohne dass ihre Erwartungswerte angepasst
   werden. Werden sie angepasst, ist das ein Warnsignal - sie beschreiben Tab-äquivalentes
   Verhalten.
2. `npm run typecheck && npm test` - insbesondere `core-lib parses without errors` (reine
   Tab-Datei, darf keine neue Diagnose bekommen) und die bestehenden Dedent-Fälle
   (`branching-error`, `function-multiline-params`).
3. Realtest: `C:\Projects\privat\yugioh\src\game-logic\game-logic.jul` in der auf Leerzeichen
   umgestellten Fassung muss in derselben Größenordnung durchlaufen wie die Tab-Fassung (heute
   ~230ms) und `spaceIndentation` statt `expectedOneOf` melden. Dieser Fall hat Versuch 2
   aufgedeckt.
4. **Bench-Nachmessung** mit `--save`, Vergleich gegen Schritt 1.
5. `npm run build-all-and-deploy`, dann in VSCode: Diagnose erscheint, Quick Fix stellt die Zeile
   auf Tabs um, Datei ist danach fehlerfrei.
