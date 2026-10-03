# `IntegerRange(start end)` als Typ

Idee, keine Entscheidung. Ein Typ für die ganzen Zahlen von `start` bis `end`, beide inklusive.

Aufgegangen in [number-ranges.md](../number-ranges.md): Grenzen je Familie und eine gemeinsame
Bereichssicht des Checkers, ohne eigenen Knotentyp. `IntegerRange` ist dort als spätere Kurzform
zurückgestellt.

## Ausgangspunkt

`range` schreibt seinen Elementtyp heute aus
([core-lib.jul](../../src/runtime/core-lib.jul)):

```jul
) -> Or([] List(And(
	Integer
	# >= start
	Or(start Greater(start))
	# <= end
	Not(Greater(end))
)))
```

Das stimmt: `range(1 n)` passt auf `List(PositiveInteger)`, `range(0 n)` nicht, und eine
unbekannte Grenze wird nicht zu eng gelesen. Nur der Hover ist schwer lesbar, etwa
`And(Integer Or(1 Greater(1)) Not(Greater(1001)))`. Mit `IntegerRange` hieße der Rückgabetyp
`Or([] List(IntegerRange(start end)))`.

## Was der Typ bedeuten würde

```jul
x: IntegerRange(2 4) = 3     # ok
x: IntegerRange(2 4) = 5     # Fehler
IntegerRange(1 [])           # nach oben offen: PositiveInteger
IntegerRange(5 3)            # keine Zahl liegt dazwischen: Never
```

`IntegerRange(2 4)` ist dieselbe Menge wie `Or(2 3 4)`. `start > end` ergibt Never, nicht Empty:
Es ist ein Typ ohne Werte, keine leere Kollektion.

## Warum nicht `IndexRange` erweitern

`IndexRange` beschreibt keine Werte, sondern einen Ausschnitt. Als Index von `ElementAt` liefert
es die Teilfolge. Eine Menge von Zahlen als Index liefert dagegen ein Element, weil jeder Fall
eines `Or`-Schlüssels einzeln aufgelöst wird
([checker.ts](../../src/checker/checker.ts), `dereferenceNestedKeyFromObject`):

```jul
T = [§a§ §b§ §c§ §d§ §e§]
ElementAt(T IndexRange(2 4))     # [§b§ §c§ §d§]      die Teilfolge
ElementAt(T IntegerRange(2 4))   # Or(§b§ §c§ §d§)    ein Element an Position 2, 3 oder 4
```

Wären beide derselbe Typ, müsste `ElementAt` gleiche Typen verschieden behandeln. Auch das offene
Ende unterscheidet sich: Bei `IndexRange` reicht es bis zum Ende der Quelle, bei `IntegerRange`
bis unendlich.

Ada und Pascal kennen beides, Teilbereichstypen (`subtype Index is Integer range 1 .. 10`) und
Slices mit derselben Schreibweise (`A(2 .. 3)`). Dort trennt die Grammatik die beiden
Bedeutungen. In JUL sind Typen Werte, diese Trennung steht also nicht zur Verfügung.

## Offen

- Ein eigener Knotentyp mit Teilmengenregeln gegen `Integer`, Literale, `Greater` und
  `And`/`Or`/`Not`, dazu Fälle für Platzhalter, `typeEquals` und `typeToString`.
- Wird `IntegerRange(1 [])` als gleich zu `PositiveInteger` (`And(Integer Greater(0))`) erkannt,
  in beide Richtungen?
- Darf auch `start` offen sein (`IntegerRange([] 0)` für alle Zahlen ≤ 0)?
- Lohnt der Aufwand, solange `range` die einzige Stelle ist? Nur für die Anzeige würde es reichen,
  wenn der Hover die `And`-Form als `PositiveInteger` wiedererkennt.
