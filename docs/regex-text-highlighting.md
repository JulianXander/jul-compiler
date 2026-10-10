# Plan: mehrzeiliger `§regex`-Text mit Highlighting

## Ziel

`§regex` gefolgt von einer neuen Zeile ist ein mehrzeiliger Text mit Sprachkennung `regex`
(wie `§html` und `§js`). Sein Inhalt ist ein Regex in JS-Syntax und wird eingefärbt.

## Parser

Der Parser hängt in mehrzeiligen Texten an jede Zeile ein `\n` an. Für ein Regex wäre das Teil des
Patterns, ebenso die Einrückung tieferer Ebenen. Deshalb gilt für `language === 'regex'`:

- Die Zeilen werden ohne `\n` verbunden, auch ohne abschließendes.
- Führende Tabs jeder Zeile entfallen.
- Ein Zeilenumbruch im Regex wird als `\n` geschrieben, ein führendes Leerzeichen als `[ ]`
  oder `\x20`.
- Kommentarzeilen (`#`) bleiben Kommentare.

Die Regel steht im Parser, damit Checker, Emitter und Language Server denselben Text sehen.

## Grammatik (`vscode-jul-language-service`)

- Neue Regel `§regex` in `jul.tmLanguage.yaml`. Ein Eintrag in `embeddedLanguages` der
  `package.json` entfällt, weil keine fremde Grammatik eingebunden wird.
- Der Zustand läuft über Zeilen weiter, anders als bei `js` und `html`, weil Gruppen über
  mehrere Zeilen gehen.
- Eigene kleine Regex-Grammatik statt `source.js.regexp`: Gruppen enden zusätzlich vor einem
  `§` (`(?=§)`), eine offene Gruppe färbt so nicht den Rest der Datei ein. `§(...)` innerhalb
  einer Gruppe wird erkannt. Umfang: Escapes, Zeichenklassen, Gruppen, Lookarounds, Quantoren,
  Anker, `|`, benannte Captures.
- Danach `npm run convert-grammar`.

## Doku

Die Regel gehört in `jul-homepage/docs` als Verhaltensbeschreibung mit Beispiel, ohne
Begründung.

## Nicht enthalten

Einzeiliges `§regex§`, Highlighting für `regex(§…§)` im Aufruf, Validierung im Checker.
