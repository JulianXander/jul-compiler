# Parser-Fehlermeldungen: gemessene Lücken

Entwurf ohne Entscheidung. Stand 2026-10-06, gemessen am gebauten Compiler (`out/`), 1261 Tests grün.

## Ausgangslage

Der Parser meldet bei ungültigem Code oft die Sammelmeldung `1102 multilineParser should parse until
end of row` statt der Ursache. Die Vorarbeit steht im [TODO](../../TODO) („fehlermeldungen für
ungültige syntax verbessern“). Dieses Dokument hält fest, **was nach den bisherigen Umbauten noch
offen ist** und wie es gemessen wurde.

### Bereits behoben

- `1110 Expected closing bracket )`/`]`: fehlende schließende Klammer, auch am Ende des Codes und
  bei Öffner ohne Feld (`[`, `f(`). Der Parser liefert den Knoten trotzdem, der Baum bleibt für den
  Language Server erhalten.
- `1111 Expected closing §.`: einzeiliger Text ohne schließendes `§`. Gemeldet wird die Ursache, nicht
  ein fehlender Wert.
- `choiceParser`/`discriminatedChoiceParser` tragen ihre Meldung explizit, statt sie aus
  `parser.name` zu bauen. Daher kein `numberParser,,referenceParser` mehr.
- `multiplicationParser` verwirft am Ende des Codes keine Fehler früherer Durchläufe mehr. Vorher
  wurde `[].map((value) =>\n\t§test§` ohne jede Meldung gelesen.
- `1108` nennt „A function with a block body“, nicht ein „field“.

## Messung

Zwei Reihen, beide gegen den gebauten Parser (`out/parser/parser.js`, `parseCode`):

1. **Mutation.** Aus jeder `.jul`-Datei in `jul-examples` und der core-lib (Dateien über 20 kB
   ausgenommen) pro Lauf eine zufällige Zeile gewählt und ein Zeichen aus `()[]§=:/.?` gelöscht,
   Kommentarzeilen ausgenommen. 2502 Mutationen, feste Seed. Betrachtet wurde der erste Fehler, der
   gegenüber der unveränderten Datei neu ist.
2. **Gezielte Fälle.** 26 handgeschriebene Eingaben.

| erste neue Meldung | Anteil |
|---|---|
| `1102` Sammelmeldung | ca. 32 % |
| `1050` Expected a bracket, number, text or reference | ca. 11 % |
| `1001` End of code reached while looking for … | ca. 3 % |
| kein neuer Fehler | ca. 9 % |

## Offene Lücken

### 1. `1102` deckt unterschiedliche Fälle ab (größter Hebel)

Der Ausdruck ist fertig, in der Zeile bleibt Rest ([parser.ts](../../src/parser/parser.ts),
`multilineParser`, `unparsedRestOfRow`). Das erste Zeichen des Rests sagt, was los ist:

| Eingabe | Rest | passende Meldung |
|---|---|---|
| `a = 1 `, `a = 1\t` | Leerzeichen oder Tab am Zeilenende | Whitespace am Zeilenende |
| `a  = 1` | doppeltes Leerzeichen | überzähliges Leerzeichen |
| `a = 1)`, `[1 2]]`, `a = f(1))` | schließende Klammer ohne Öffner | unerwartete schließende Klammer |
| `f(1 2]`, `[1 2)` | falsche Klammerart | `)` erwartet, `]` gefunden (heute `1110` plus `1102`) |
| `a b`, `a = 1x` | zweiter Ausdruck oder Zahlenrest | unerwartetes Zeichen hinter dem Ausdruck |
| `a =\nb = 1`, `a ?\n` | Wert fehlt | Wert nach `=` bzw. `?` erwartet |

Die Whitespace-Fälle haben dieselbe Ursache wie `[1 ` bei der fehlenden Klammer: Ein optionaler
Versuch („Leerzeichen, dann weiteres Feld“) scheitert, springt zurück und lässt das Leerzeichen als
Rest stehen.

### 2. Interne Begriffe in Meldungen

- `1001 End of code reached while looking for endOfLine`: nennt den Namen eines Parsers.
- `1001 End of code reached while looking for (`: nennt das Token, nicht das Konstrukt (Beispiel:
  `x.subscribe` ohne Argumentliste).

Quelle ist `endOfCodeError` in `parser-combinator.ts`, aufgerufen mit Token oder Parsername.

### 3. Mehrzeilige Konstrukte ohne Abschluss

- `f(\n\t1\n` (Klammer fehlt, Zeilen folgen): `1102` und zusätzlich `1050` bei Zeile 2. Der
  mehrzeilige Klammer-Zweig (`createBracketedMultilineParser`) scheitert weiter mit
  `hasParsed: false`, anders als der Inline-Zweig.
- `§\n\tabc` (mehrzeiliger Text ohne schließendes `§`): `1111` am Kopf, dazu `1050` bei Zeile 2. Die
  Meldung passt nur ungefähr, gemeint ist ein nicht geschlossener Block.

### 4. Folgefehler (`1050`)

Nach einem kaputten mehrzeiligen Konstrukt meldet jede Folgezeile erneut `1050`
(`bracketed-expression-example.jul`, Zeilen 12 bis 15 nach gelöschtem `[`). Das sind Kaskaden, kein
eigener Befund. Abhilfe wäre Recovery: nach dem ersten Fehler bis zum Ende des Konstrukts
überspringen.

### 5. Kleinigkeiten

- `[..a]` (zwei Punkte statt `...`) meldet `1050`, ein Hinweis auf `...` wäre näher an der Absicht.
- `a ?\n` und `a = ?` melden weiter `1102` (bzw. `2100` plus `1102`).
- `a/§x` (Text als verschachtelter Schlüssel) läuft über `nestedReferenceKeyParser` und toleriert
  einen offenen Text nicht.

## Keine Lücke: stille Akzeptanz

Die stillen Mutationen ergeben meist ein anderes **gültiges** Programm (`a/f1` → `af1`, `(b: Text)`
→ `(b Text)` als zwei Parameter). Das ist eine Frage des Checkers, nicht des Parsers (vgl. `1/2` im
TODO). Von 234 stillen Fällen wurden einzelne Beispiele angesehen, nicht alle. Die einzige echte
stille Lücke war das fehlende `)` am Code-Ende, siehe oben.

## Grenzen der Messung

- Nur das Löschen eines Zeichens aus einem festen Satz. Eingefügte oder vertauschte Zeichen,
  Einrückungsfehler und mehrzeilige Mutationen sind nicht abgedeckt.
- Korpus ist `jul-examples` und die core-lib. yugioh ist nicht dabei.
- Anteile sind auf ganze Prozent gerundet und hängen an der Seed.
- Das Messskript wurde nicht abgelegt. Der Aufbau steht oben, ein Wiederaufbau ist ein kurzes Skript
  auf `parseCode`. Eine dauerhafte Fassung läge nahe an `scripts/fuzz.ts`
  (siehe [fuzz-prototyp.md](fuzz-prototyp.md)).

## Reihenfolge

1. Lücke 1, weil sie rund ein Drittel der Fälle trifft und nur eine Verzweigung nach dem Zeichen am
   Restanfang braucht. Je Zeile der Tabelle ein roter Test.
2. Lücke 2 (`endOfCodeError` mit Konstrukt statt Token oder Parsername).
3. Lücke 3, zusammen mit der Frage, ob der mehrzeilige Klammer-Zweig ebenfalls tolerieren soll.
4. Lücken 4 und 5 nach Bedarf.
