# Stream-Faltung (`aggregate$` / `scan$`)

Idee, keine Entscheidung. Angestoßen vom Beispiel `jul-examples/ui/tic-tac-toe`.

## Die Lücke

Ein Zustand, der aus einem Strom von Änderungen (Deltas) aufgebaut wird, lässt sich in der
core-lib nicht ableiten. `map$` ist eine reine Projektion des aktuellen Werts und kennt den
vorherigen Ausgabewert nicht. `combine$` würde sich selbst als Eingabe brauchen.

Das Beispiel behilft sich mit einem Subscriber, der in einen `create$`-Stream pusht:

```jul
subscribe(
	delta$
	(delta = value) => gameState$.push(applyDelta(gameState$/getValue() delta))
)
```

Das funktioniert, hat aber zwei Nachteile: `gameState$` ist ein gewöhnlicher `create$`-Stream, in
den auch von außen gepusht werden kann, er ist also nicht garantiert aus den Deltas abgeleitet.
Und das Muster (Zustand = Faltung eines Event-Streams) muss jedes Mal von Hand gebaut werden.

## Der Vorschlag

Die Stream-Variante von `aggregate`, die nach jedem Eingabewert den aktuellen Zwischenstand
liefert:

```jul
gameState$ = aggregate$(delta$ GameState initialGameState applyDelta)
```

Parameter wie bei `aggregate`: Quelle, `AccumulatorType`, `initialValue`, `callback` mit
`accumulator` und `value`. Ergebnis ist `Stream(AccumulatorType)`. Umzusetzen sind eine Funktion
neben `map$` in `runtime.ts` (mit `/*#__PURE__*/`) und die Deklaration in `core-lib.jul`.

## Name

- **`aggregate$`**: folgt der Konvention, dass die Stream-Variante einer Listenfunktion `$`
  anhängt (`map` und `map$`). Bei uns hält ein Stream immer seinen aktuellen Wert, „laufend“ ist
  deshalb die natürliche Lesart.
- **`scan$`**: der verbreitete Name für die laufende Faltung (RxJS, RxJava, Kotlin Flow, Haskell
  `scanl`, Scala `scanLeft`, Elixir `scan`). Elm nannte es `foldp`.
- Gegen `aggregate$` spricht Rx.NET: Dort bedeutet `Aggregate` nur das Endergebnis, `Scan` den
  laufenden Stand. Wer von LINQ kommt, liest `aggregate$` anders.

## Warum noch nicht

Es spart im Beispiel kaum Code, nur den Fold-Subscriber. Der Gewinn ist die Garantie, dass der
Stream rein abgeleitet ist. Gebaut wird es, sobald ein zweiter Anwendungsfall zeigt, dass das
Muster häufig vorkommt.
