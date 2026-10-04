# Nicht-leere Ergebnisse von `flatten` und `range`

Idee, keine Entscheidung. Angestoßen vom Beispiel `jul-examples/ui/tic-tac-toe`
(`cellsOf`).

## Die Lücke

Ein Ergebnis, das nie leer sein kann, wird trotzdem als `Or([] List(...))` typisiert. Im Beispiel
muss deshalb der Rückgabetyp von `cellsOf` den Fall `Empty` mitführen, obwohl das Brett immer neun
Zellen hat, und jeder Aufrufer verzweigt oder reicht das `Or([] ...)` weiter:

```jul
cellsOf = (gameBoard: GameBoard) -> Or([] List(PositionedCell)) =>
	cellsByRow = range(1 3).map(
		(rowIndex = value) => range(1 3).map(
			(columnIndex = value) => [...]
		)
	)
	cellsByRow.flatten()
```

Das `Empty` hat zwei Ursachen, und beide müssen weg, damit der Typ schrumpft:

1. **`range`** ist als `Or([] List(...))` deklariert, weil `range(start end)` bei `start > end`
   `Empty` liefert. Mit Literalen wie `range(1 3)` ist das statisch widerlegbar, der Checker
   wertet es aber nicht aus.
2. **`flatten`** hat die feste Signatur
   `(values: Or([] List(Or([] List(Any))))) -> Or([] List(TypeOf(values)/ElementType/ElementType))`.
   Der Rückgabetyp enthält immer `Empty`, auch wenn der Parameter nicht leer sein kann.

`map` macht es schon richtig: `MapElements(TypeOf(values) TypeOf(transform))` erhält die
Nicht-Leere der Eingabe.

## Der Vorschlag

- **`flatten`** bekommt wie `map` einen Typ-Konstruktor, etwa `Flatten(TypeOf(values))`. Das
  Ergebnis ist nicht leer, wenn die äußere Liste nicht leer ist und mindestens eine innere Liste
  nicht leer sein kann. Wo `List(List(X))` schon `Empty` ausschließt, ergibt es `List(X)`.
- **`range`** wird für Literal-Argumente mit `start <= end` als nicht-leere Liste typisiert. Das
  hängt mit den Grenzfamilien in [integer-range.md](integer-range.md) zusammen und könnte dort
  entschieden werden.

## Umgehung im Beispiel

Statt über `range(1 3)` lässt sich über das `GameBoard` selbst iterieren
(`gameBoard.map((row = value rowIndex = index) => ...)`). Das Brett ist ein Tuple, `map` erhält
dessen Nicht-Leere. Es bliebe nur das feste `flatten`.

## Warum noch nicht

Es betrifft Checker und Typalgebra, nicht nur die core-lib. Ein Beispiel allein belegt nicht, wie
oft nicht-leere Ergebnisse gebraucht werden. Dafür spricht, dass die Typen sonst an jeder
Aufrufstelle `Empty` weiterreichen, obwohl es dort nie vorkommt.
