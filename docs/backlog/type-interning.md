# Interning von Typen

Idee ohne Entscheidung. Angeregt durch die Performance-Untersuchung vom 10.10.2026 (yugioh,
`legal-inputs.jul`).

## Ausgangslage

Typen sind Objekte ohne Identität über ihre Struktur: Dieselbe Union, etwa die sieben
Varianten von `PlayerInput`, entsteht bei jeder Instanziierung einer Funktion als neue Objekte.
Alles, was Typen vergleicht oder zusammenfasst, rechnet deshalb dasselbe immer wieder neu.

Gemessen an `main.jul` aus yugioh nach dem `concatFromTypes`-Fix:

- `createNormalizedUnionType` kostet 33,7 % der Zeit, davon `removeSubtypes` 30,2 %.
- `removeSubtypes` wird 14 060 Mal aufgerufen, mit nur 776 strukturell verschiedenen Eingaben
  (ca. 94,5 % Wiederholung). Der Schlüssel war `typeToString` ohne Alias-Namen, die Zahl ist also
  eine Größenordnung, kein exakter Wert.
- Die Dublettenprüfung in `createNormalizedUnionType` (`typeEquals`) kostet nur 3,9 %.

## Idee

**Volles Interning (wie TypeScript):** Jeder Typ bekommt beim Erzeugen eine ID, strukturell
gleiche Typen sind dasselbe Objekt. Gleichheit ist dann `===`, Unions und Zuweisbarkeit sind über
ID-Schlüssel cachebar.

**Mittelweg:** Pro Typ ein lazy berechneter struktureller Hash, an das Objekt gehängt.
`createNormalizedUnionType` und `removeSubtypes` werden mit dem Hash der Choices memoisiert. Am
Rest des Checkers ändert sich nichts. Gecacht würden nur Typen ohne ungelöste Aliase und
Platzhalter.

## Kosten und Risiken

- **Umbau:** Alle `createCompileTime…`-Funktionen (25 in `syntax-tree.ts`) müssten über einen
  Pool laufen, dazu jede Stelle, die einen Typ direkt als Objektliteral baut.
- **Identität, die nicht zur Struktur gehört:** `aliasName`, `declaration` und Platzhalter
  (`parameterReference`, `isUnresolvedPlaceholder`) dürfen nicht verschmelzen, sonst ändern sich
  Hover-Texte und Fehlermeldungen. Der Alias-Stack (`aliasComparisonsInProgress`) und
  `isPendingAlias` hängen an Objektidentität.
- **Veränderliche Auflösung:** Aliase lösen lazy über `symbol.typeInfo` auf. Ein reines
  Struktur-Interning deckt das nicht ab.
- **Speicher:** Ein Pool hält Typen am Leben, im Language Server über Neuprüfungen hinweg. Er
  bräuchte schwache Referenzen oder einen Neustart pro Check.
- **Nicht jede Rechnung geht auf:** Ein Cache der Zuweisbarkeit nach Objektidentität senkte
  `getTypeError` von 17,8 M auf 6,5 M, brachte aber keine Zeitersparnis (5,1–5,6 s gegen 4,7 s),
  weil der Zugriff über `WeakMap` so viel kostete wie die gesparten Vergleiche.

## Vorgehen, falls es angegangen wird

Zuerst der Mittelweg, zunächst nur für `removeSubtypes`, mit Bench auf yugioh vor und nach der
Änderung. Volles Interning erst, wenn der Mittelweg trägt und die Frage der Alias- und
Platzhalter-Identität geklärt ist.

## Verworfene Vorarbeiten

- Tag-Disjunktheit (`typesOverlap`) vor der Teilmengenprüfung in `removeSubtypes`: senkte die
  Zähler, aber nicht die Zeit, weil `typesOverlap` selbst teuer ist.
