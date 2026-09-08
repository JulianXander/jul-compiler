# Semantic Highlighting und das Empty-Literal

**Offen.** Internes Arbeitsdokument, Aufbau nach
[design-principles.md](design-principles.md). Ausgangspunkt war eine Kleinigkeit: `[]` wird im
Editor gefärbt wie ein leeres Klammernpaar, obwohl es ein eigener Wert ist. Der Weg dorthin
führt über ein Feature, das ohnehin fehlt.

---

## 1. Warum die Grammatik das nicht lösen kann

VS Code färbt in drei Schichten, jede überschreibt die vorherige:

1. TextMate-Grammatik → Scope → Theme-Farbe
2. Semantic Tokens vom Language Server
3. Bracket Pair Colorization

Eine Regel in `jul.tmLanguage.yaml`, die `[]` den Scope `constant.language.empty.jul` gibt,
greift nachweislich — der Token-Inspector zeigt sie samt Farbe an. Sichtbar wird sie trotzdem
nicht: Ein leeres Paar besteht nur aus den zwei Klammerzeichen, und genau die übermalt Schicht 3.

**Semantic Tokens lösen das nicht.** Sie ersetzen Schicht 1, liegen also ebenfalls unter der
Bracket-Colorization. Wer die Färbung von `[]` über Semantic Tokens erwartet, irrt.

### Verworfene Auswege

**`colorizedBracketPairs` auf `( )` beschränken.** Wirkt, nimmt aber allen Listen,
Dictionaries und DictionaryTypes die Regenbogenfarben. Zu teuer für den Zweck.

**`tokenTypes` in der Grammar-Contribution.** Ein Mapping
`{"constant.language.empty.jul": "string"}` setzt für dieses eine Token den Standard-Token-Typ
auf String; der Bracket-Parser überspringt String-Tokens, die Farbe wird sichtbar. Der Preis
trifft aber genau den Zustand „Cursor zwischen den Klammern eines frisch geöffneten Paars":
`§` schließt dort nicht mehr automatisch (`notIn: ["string"]` in der Language-Configuration),
und Quick Suggestions bleiben aus (`editor.quickSuggestions.strings` ist per Default `off`).
Beides trifft den häufigen Fall „Liste anfangen zu tippen". Ausprobiert und wieder entfernt.

### Der verbleibende Weg

Eine **Decoration** aus der Extension. Decorations werden nach der Bracket-Colorization
gezeichnet und überschreiben sie. Sie brauchen die echten Positionen der Empty-Literale —
eine Regex über den Dokumenttext scheidet aus, weil sie die Textliteral- und Kommentarsyntax
nachbauen müsste und damit doppelt pflegen.

Die Positionen liefert ein Custom-Request an den Server, etwa `jul/emptyLiterals`, analog zum
bereits vorhandenen `jul/coreLibContent`. Der Server hat den Syntaxbaum ohnehin im Speicher.

**Semantic Tokens könnten dieselben Positionen liefern, sind dafür aber der Umweg.** Sie bräuchten
Legend-Vokabular, Client-Capability und Delta-Protokoll, um am Ende dasselbe zu sagen. Das
Feature hat eigenen Wert (Abschnitt 2), ist aber keine Voraussetzung.

---

## 2. Semantic Highlighting, nachgelagert

In [extension.ts](../../vscode-jul-language-service/src/extension.ts) liegt ein auskommentierter
Prototyp mit `SemanticTokensLegend`; der Server registriert weder Capability noch Handler.

Der Gewinn ist unabhängig vom Empty-Literal, aber auch nicht dringend. Die TextMate-Grammatik
rät an der Schreibweise — Großbuchstabe heißt Typ, `$` heißt Stream, Kleinbuchstabe heißt
Referenz — und liegt damit fast immer richtig, weil die Konvention eingehalten wird. Falsch
liegt sie bei einem klein geschriebenen Typ, bei einem als Wert übergebenen Typ und bei der
Unterscheidung Parameter / lokale Definition / Import / Builtin. Das ist in einer Sprache, in
der Werte und Typen denselben Namensraum teilen, ein realer Fall — aber ein kosmetischer.
Fehler zeigen die Diagnostics, Bedeutung zeigt der Hover.

Deshalb steht es hinten: erst wenn der Visitor aus Abschnitt 3 ohnehin existiert, ist der
Provider ein kleiner Nachtrag.

---

## 3. Die Traversierung ist schon da

Beide Wege brauchen einen vollständigen Baumdurchlauf — der Custom-Request, um alle
`empty`-Knoten einzusammeln, der Semantic-Tokens-Provider, um jedem Bezeichner einen Typ zu
geben. Diese Fallunterscheidung existiert im Workspace bereits dreifach, nur nirgends
wiederverwendbar:

- [server.ts](../../jul-language-server/src/server.ts) `findExpressionInExpression` — vollständiger
  `switch` über alle Ausdrucksarten inklusive `case 'empty'`, kennt für jeden Knoten dessen
  Kinder, steigt per `isPositionInRange` aber nur in den Zweig ab, der die Cursorposition enthält
- [checker.ts](../src/checker.ts) — vollständig, setzt Typen
- [emitter.ts](../src/emitter.ts) — vollständig, erzeugt JS

Es fehlt also keine Kenntnis der Baumstruktur, sondern nur die Verallgemeinerung von „steig in
das Kind ab, das die Position enthält" zu „besuche alle Kinder". Derselbe `switch`, mit dem
Positionsfilter als Prädikat statt fest verdrahtet.

---

## 4. Kostet der Umbau Performance?

Zwei Fragen, die auseinanderzuhalten sind.

### 4a. Wird die positionsbasierte Suche langsamer?

Sie ist heute O(Tiefe): pro Ebene ein Zweig. Das bleibt so, **sofern der Visitor „nicht
absteigen" ausdrücken kann**. Ein Visitor, der immer alle Kinder besucht und den Aufrufer
filtern lässt, macht aus O(Tiefe) ein O(Knoten) — und das bei jedem Hover, jedem Tastendruck
in der Completion, jedem SignatureHelp. Das wäre die eigentliche Regression.

Zwei Fallstricke im Umbau:

- **Kein `getChildren(): Expression[]`.** Ein Array pro Knoten allokiert auf einem Pfad, der
  pro Tastendruck läuft. Die Kinder stattdessen einzeln an einen Callback geben.
- **Abbruch muss möglich sein.** Der Callback braucht ein Signal „hier nicht weiter" bzw.
  „fertig", sonst ist der Positionsfilter nur noch ein Filter und keine Beschneidung mehr.

Erfüllt der Visitor beides, bleibt als Mehrkosten ein Funktionsaufruf pro besuchtem Knoten statt
eines Inline-Vergleichs. Auf einem Pfad der Länge Baumtiefe ist das nicht messbar.

### 4b. Was kostet das Feature selbst?

Semantic Tokens sind O(Knoten) pro Dokument und werden nach jeder Änderung angefordert. Das
kommt **zusätzlich** zu `parseCode` + `checkTypes`, die heute schon bei jeder Änderung über
dieselbe Datei laufen. Ein reiner Baumdurchlauf ohne Typauflösung ist gegenüber dem Checker
billig; die Größenordnung ist ein Bruchteil dessen, was ohnehin pro Tastendruck passiert.

Was zu beachten bleibt:

- Der Server überspringt Dateien über 100 kB bereits aus Performancegründen — dieselbe Grenze
  muss für Semantic Tokens gelten, sonst fällt sie hinten wieder um.
- LSP erlaubt `full/delta`. Erst bauen, wenn eine Messung es rechtfertigt.
- Die Decoration in der Extension darf nicht bei jedem Scroll neu anfragen, sondern muss die
  Tokens cachen und bei Dokumentänderung invalidieren.

Der sichtbare Effekt ist eher UX als Performance: Semantic Tokens kommen asynchron, Bezeichner
können also kurz nach dem Tippen die Farbe wechseln. Das lässt sich nicht wegoptimieren, nur
dadurch abmildern, dass die Grammatik schon nah am Ergebnis liegt.

### Zu messen

`scripts/bench.ts` deckt den Compiler ab, nicht den Server. Für den Server gibt es jetzt
[jul-language-server/scripts/bench.mjs](../../jul-language-server/scripts/bench.mjs) (`npm run bench`
dort): ein minimaler LSP-Client über Node-IPC, der einen echten Serverprozess startet und misst,
was der Editor merkt — Zeit von `didOpen` bzw. `didChange` bis `publishDiagnostics` und die
Antwortzeit der positionsbasierten Features an vielen Positionen der größten Datei.

Baseline vor dem Umbau, gegen `C:\Projects\privat\yugioh` (10 Dateien, größte 2856 Zeilen):

```
didOpen -> diagnostics    median  10.78 ms   p95 123.98 ms
didChange -> diagnostics  median  67.24 ms   p95 109.23 ms
hover                     median   0.12 ms   p95   0.27 ms
definition                median   0.11 ms   p95   0.25 ms
completion                median   2.13 ms   p95   3.15 ms
signatureHelp             median   0.06 ms   p95   0.18 ms
documentSymbol            median   4.16 ms   p95   4.48 ms
```

Das ordnet beide Fragen ein. **Parse und Check dominieren mit Abstand**: 67 ms pro Änderung
gegen 0,1 ms für eine positionsbasierte Suche. Ein zusätzlicher vollständiger Baumdurchlauf für
Semantic Tokens liegt zwischen beiden Größenordnungen und ist gegenüber den 67 ms, die ohnehin
pro Tastendruck anfallen, nicht der bestimmende Posten. Und selbst ein versehentlich zu
O(Knoten) verallgemeinertes `findExpressionInExpression` bliebe absolut gesehen unter der
Wahrnehmungsschwelle — es wäre unsauber, aber kein spürbarer Schaden. Die Sorge aus 4a ist damit
kleiner als zunächst gedacht.

Auffällig ist stattdessen `completion` mit 2,13 ms Median, rund zwanzigmal teurer als `hover`
bei gleicher Baumsuche. Das ist ein eigener Faden, nicht Teil dieses Dokuments.

---

## 5. Was zu tun ist

0. **Erledigt:** Server-Bench und Baseline, siehe Abschnitt 4. Vor und nach jedem folgenden
   Schritt wiederholen.
1. `findExpressionInExpression` zu einem Visitor verallgemeinern, der beide Nutzungen bedient —
   mit Abbruchsignal und ohne Kind-Arrays
2. Custom-Request `jul/emptyLiterals` im Server, Decoration in der Extension, Farbe als
   `ThemeColor` mit Contribution in `package.json`, damit es themefest bleibt
3. Danach, unabhängig: Semantic-Tokens-Provider im Server, Capability in der Extension,
   100-kB-Grenze übernehmen

Stand heute ist nur die Grammatik-Regel `constant.language.empty.jul` vorhanden. Sie ist
wirkungslos, solange Schritt 2 fehlt — und wird von der Decoration auch nicht gebraucht.

Stand heute ist nur die Grammatik-Regel `constant.language.empty.jul` vorhanden. Sie ist
wirkungslos, solange Schritt 3 fehlt.
