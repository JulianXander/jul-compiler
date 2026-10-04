# Zahlenbereiche: offene Teile

Was von den Zahlenbereichen noch fehlt, zurückgestellt und ohne Termin. Für Integer ist alles
umgesetzt; diese Entscheidungen gelten dabei weiter:

- Jede Grenze gehört zu genau einer Familie, die im Namen steht: `GreaterInteger`, `LessInteger`,
  `GreaterFloat`, `LessFloat`. Ein Vergleich über Integer und Float ergibt keinen Sinn, sie sind
  disjunkt. Die Grundformen sind strikt, inklusive Grenzen werden mit `Or` ausgeschrieben
  (`Or(start GreaterInteger(start))`). Kurzformen (`AtLeast`, `AtMost`, `IntegerRange`) kommen erst,
  wenn Nutzercode sie braucht.
- Die Grenzen sind **ein** Knoten `bound` mit `Relation` und `Family`. Außer `getIntegerRange` und
  `getTypeFamily` liest niemand diese Felder, sonst behandelt eine vergessene Unterscheidung
  `LessInteger` still wie `GreaterInteger`.
- Es gibt keinen eigenen Knoten für Bereiche. `getIntegerRange` liest einen Typ als Bereich
  (`Integer`, Literale, Grenzen, `Not`, `And`, `Or`, wenn die Vereinigung wieder ein Bereich ist),
  und alle Regeln fragen nur diese Funktion. Ein Knoten bräuchte Fälle in rund fünfzehn Switches.
  Bereiche mit Löchern bleiben unlesbar, ein leerer Bereich wird `Never`.
- Ändert eine Normalisierung die Menge nicht, gibt sie den geschriebenen Typ zurück statt des
  aufgelösten, damit der Alias in der Anzeige bleibt (`And(Pos Integer)` zeigt `Pos`).

## Floats

Zurückgestellt, bis ein Programm Float-Grenzen braucht. Heute kommen nur Integer-Grenzen vor, in
der core-lib wie in yugioh und jul-examples. Der Knoten `bound` trägt die Familie schon, die Arbeit
bleibt damit lokal.

- `GreaterFloat`, `LessFloat` deklarieren und falten wie die Integer-Formen.
- `getIntegerRange` für `family: 'float'` erweitern (dann unter dem Namen `getNumberRange`), mit
  `inclusive`-Flag an den Grenzen, denn hier gibt es keine Umrechnung `< y` → `≤ y − 1`.
- Tests: `And(GreaterFloat(0f) LessFloat(1f))` gegen `GreaterFloat(-1f)`, Überlappung
  `LessFloat(1f)` mit `GreaterFloat(0f)`, `GreaterFloat(0f)` gegen `GreaterInteger(0)` disjunkt.

**NaN gehört nicht zu `Float`.** Die Regeln gelten also exakt, `Not(GreaterFloat(y))` ist über
Floats dasselbe wie `Or(y LessFloat(y))`. Zur Laufzeit kann ein `Float` trotzdem NaN sein:
`divideFloat` schließt zwar den Divisor 0 aus, aber `addFloat`/`subtractFloat` liefern NaN aus
`Infinity - Infinity` nach einem Überlauf, und Importe aus `.ts`/`.js` können NaN liefern. Das
auszuschließen steht in der `TODO`.

## Anzeige

Der Alias überlebt die Normalisierung, wo die Menge gleich bleibt. Was bleibt, ist die
**Rückübersetzung** eines normalisierten Typs in eine Kurzform:

- `And(Integer GreaterInteger(0))` zeigt `GreaterInteger(0)`, nicht `PositiveInteger`, weil der
  Name nie geschrieben wurde. Das ist der TODO-Punkt „And(Integer Greater(0)) als
  PositiveInteger wiedererkennen".
- `And(PositiveInteger Or(5 LessInteger(5)))` zeigt `Or(5 And(LessInteger(5) GreaterInteger(0)))`.
  Als Bereich gelesen wäre das `[1, 5]`.
- Eine Fehlermeldung zeigt `LessInteger(PositiveInteger)`, also einen Typ als Grenzwert, wenn die
  Grenze aus einer noch unbekannten Zahl folgt (`range(0 n)` mit `n: PositiveInteger`).

Dagegen spricht, dass die Rückübersetzung eine Heuristik mit vielen Sonderfällen ist (welcher
Alias gewinnt, wenn mehrere auf dieselbe Menge passen; inklusive oder strikte Grenzen) und den
Nutzer überraschen kann, der `And(GreaterInteger(0) LessInteger(4))` schreibt und `Or(1 2 3)`
zurückbekommt. Andere Sprachen (TypeScript, Ada, Scala *refined*, Liquid Haskell) merken sich, was
der Nutzer geschrieben hat, und rechnen keine kürzeste Schreibweise aus dem Normalisierten zurück.

Vor einer Umsetzung die Snapshot-Diffs der Meldungen ansehen: Sind sie nicht schlechter lesbar
geworden, entfällt der Punkt. Wird die Anzeige für normalisierte Typen nicht mehr zuverlässig vom
Original ableitbar, lohnt ein eigener Knoten für Bereiche statt der Sicht `getIntegerRange`.
