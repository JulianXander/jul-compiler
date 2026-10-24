# Geschlossene Tupel

Ein Tupeltyp (`[Integer]`, `[GameBoard GameBoard]`) hat genau so viele Elemente, wie er nennt.
Ein unbenannter Kopf (`[Integer] => …`, Branch-Arm) ist dagegen eine Parameterliste und bleibt
offen: Er nennt die Argumente, die er braucht, und lässt weitere zu.

Status: umgesetzt (Schritte 1 bis 3, 2026-10-24). Offen: `design-principles.md` und CLAUDE.md nachziehen (Schritt 4).

## Problem

Ein Tupeltyp hat heute zwei Bedeutungen, die sich widersprechen.

- **Offen** bei der Zuweisbarkeit: `isTypeAssignableForTuple` lässt ein längeres Tupel zu, und
  `List(X)` gilt als Teilmenge von `[X]`.
- **Exakt** bei allem, was rechnet: `getLengthFromType` liefert für ein Tupel die feste Länge,
  `dereferenceIndexFromObject` meldet für einen Index dahinter `Empty`.

Die Union-Normalisierung verbindet beide. `removeSubtypes` wirft mit der offenen Bedeutung
`List(Integer)` neben `[Integer]` weg, danach rechnet der Checker mit der exakten weiter:

```
x = ?(b)
	[true] => [n]
	[false] => l          # l: List(Integer)
x.length().greater(1)     # Typ: false, JUL5152 Unreachable branch
x.getElement(2)           # Typ: Empty, obwohl l zwei Elemente haben kann
```

Derselbe Fehler entsteht über den Spread (`[...l entry]` mit `l: Or([] List(Integer))`) und über
jedes `Or` im Rückgabetyp. Ein Fix in `concatFromTypes` allein schlösse nur einen Weg.

## Entscheidung

Tupeltypen sind geschlossen. Das schließt den Widerspruch, ohne Flag und ohne neue Syntax.

- `[X]` ist Teilmenge von `List(X)`, nicht umgekehrt.
- `x: [Integer Integer] = [1 2 3]` und `x: [Integer] = liste` sind Fehler.
- Länge und Index eines Tupeltyps bleiben exakt, wie sie heute schon gerechnet werden.
- Der Elementtyp von `[Integer Text]` bleibt `Or(Integer Text)`.

Records bleiben offen (`x: [a: Integer] = [a = 1 b = 2]` gilt weiter). Ein Tupel wird über seine
Positionen bestimmt, ein Record über Namen: Eine Position ohne Namen hat kein Gegenstück, das man
weglassen könnte, ohne dass sich die Bedeutung der übrigen ändert.

## Ein Kopf ist eine Parameterliste

Ein Branch-Kopf und `[Integer] => …` binden, sie beschreiben keine Daten. Die Klammer-Regel
(CLAUDE.md) sagt, dass Bindungsstellen rund sind und Daten eckig. Der Kopf wird eckig geschrieben,
weil er ein Typ-Kopf ist, intern ist er aber bisher ein Tupel.

Heute ergibt der Parser für den Kopf eine `list`, der Checker ein Tupel von Typwerten, der Emitter
`{ type: [...] }`. Die Runtime prüft ihn mit `_isOfType(args, type)` über `isTupleOfType`, und das
nimmt ein längeres Argument-Array an (`?(a b)` mit Kopf `[Integer]` prüft nur `a`). Der Checker
vergleicht dort ebenfalls nur die Positionen des Kopfs
(`isBranchDisjointToArgs`, `isTypeAssignableForTupleArgAndTupleTarget`).

Wird das Tupel geschlossen, müsste ein Kopf ohne diesen Schritt exakt passen, und `?(a b)` mit
einem Kopf `[Integer]` träfe nie. Außerdem bräche `values.map([Integer] => 1)`: Dort trifft ein
Kopf (Tupel) auf die zweistellige Signatur von `map`.

Deshalb bekommt der unbenannte Kopf den Parametertyp `parameters` mit Positionen ohne Namen.
`Parameter.name` ist heute ein Pflichtfeld, die Positionen heißen intern leer.

## Gemessen

Instrumentierte Kopie des Compilers, yugioh und alle jul-examples (Stand 2026-10-24).

| | offen (heute) | geschlossen |
|---|---|---|
| Diagnosen in yugioh und jul-examples | 136 | identisch |
| yugioh-Tests, Checker und Runtime geschlossen | 399 grün | 399 grün |
| Laufzeit: längerer Wert trifft einen Tupeltyp | 0 von 399 Tests | – |

Im Checker nutzt vor allem `isSubtypeOf` (Union-Normalisierung) die Offenheit, ohne dass es eine
sichtbare Diagnose ändert. In der Compiler-Suite kippt `assignment-discards-nothing`, mit
geschlossenen Parameterlisten zusätzlich
`unnamed-tuple-predicate-is-assignable-to-named-filter-predicate`.

## Schritte

1. **Parameterliste für den Kopf.** Der Checker bildet den Kopf auf `parameters` mit
   unbenannten Positionen ab statt auf ein Tupel (`case 'functionLiteral'` und
   `'functionTypeLiteral'`). Betroffen sind `getRawBranchArgumentType`, `getBranchHeadLength`,
   `getFirstParameterType`, `typeBranching`, `getRequirementForType` in `branch-dispatch.ts`.
   Verhalten unverändert, die Suite muss grün bleiben.
2. **Runtime.** `Params` bekommt das Feld `head` (Positionen, ohne Namen). `tryAssignArgs` prüft
   es selbst mit Präfix-Vergleich (`isHeadOfTypes`), nicht über `isTupleOfType`. Der Emitter
   schreibt einen Kopf, dem der Checker einen Tupeltyp gegeben hat, unter `head`, jeden anderen unter
   `type`. Ein Alias auf ein Tupel (`Pair => …`) bleibt ein Typ-Kopf: Zur Laufzeit ist er ein Array
   wie das Listenliteral, nur das Feld unterscheidet die beiden. Ein eigenes Feld statt `singleNames`
   mit leeren Namen, damit sich das Matching nicht ändert (ein zu kurzes Array, ein Dictionary und ein
   `Any` hinter dem Ende hätten sonst anders gematcht).
3. **Schließen.** `isTypeAssignableForTuple` lehnt ein längeres Tupel und eine `List` ab,
   `isTupleOfType` vergleicht die Länge exakt. Die Parameterliste ersetzt die Sonderfälle in
   `isTypeAssignableForTuple` (`case 'parameters'`) und `isTypeAssignableForParameters` (`case
   'tuple'`).
4. **Aufräumen.** `design-principles.md` ändert das Beispiel „Typen und Länge“ (es nennt genau
   das Gegenteil), `CLAUDE.md` den Absatz zur Zuweisung, und die Tests `assignment-discards-nothing`
   und `…-annotated-tuple` folgen der neuen Regel.
5. **Messen.** `npm run bench -- --save` vor und nach dem Umbau, dazu yugioh.

## Umgesetzt

- Schritt 1: `createUnnamedParametersType` (type-algebra.ts), `getHeadParamsType` im Checker. Der
  Namensvergleich zweier Parameterlisten und `:?` (typeBranching) lassen unbenannte Positionen aus.
- Schritt 2: `head` in Laufzeit und Emitter.
- Schritt 3: `isTypeAssignableForTuple` lehnt `List` und ein längeres Tupel ab, `isTupleOfType` prüft
  die Länge exakt. Ein zu kurzes Tupel scheitert weiter erst am Elementtyp (eine fehlende Position
  zählt als `Empty`), `Or([] X)` an einer Tupelposition lässt sie also zu.
- Zähler (yugioh): `getTypeError` 2 091 150 → 2 054 811, `resolvePlaceholders` 2 261 147 → 2 273 495
  (+0,5 %), `inferType` gleich. Die Zeitmessungen schwanken stärker als der Effekt (der unveränderte
  Parser war bei der letzten Messung +16 %).
- yugioh: gleiche 18 Meldungen, 399 Tests grün. jul-examples: Snapshot unverändert, die Tests der
  vier Beispiele mit Tests grün.

## Offen

- JSON und TypeScript-Importe können längere Arrays liefern, mit `TypeOf`-Tupeln aus solchen
  Quellen gäbe das neue Fehler. Bei der Zählung ist keiner aufgefallen, ausgeführt wurden die
  jul-examples aber nicht.
- Records tragen die Vermischung von „Anforderung“ und „vollständig“ ebenfalls
  (`complete = true` bei einer Annotation). Eigenes Thema.
- `isBranchingExhaustive` und die Prüfung gegen frühere Branches schauen nur auf Position 0, auch
  bei mehreren Operanden. Mit der Parameterliste wäre das nachzuziehen.
