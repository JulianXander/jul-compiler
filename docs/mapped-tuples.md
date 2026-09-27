# map über Tupel je Position

`map` über ein Tupel liefert heute zwar die richtige Stelligkeit, aber an jeder Position denselben
Typ: die Union aller Elemente. Dieses Dokument beschreibt, wie der Checker den Callback je Position
auswertet, sodass das Ergebnis wieder ein Tupel mit den Typen der einzelnen Positionen ist.

**Stand:** Plan, nicht umgesetzt. Setzt [type-properties.md](type-properties.md) voraus. Roter
Zieltest: `map-over-stream-types-reads-value-type-per-position`.

## Ausgangslage

map ist deklariert als

```jul
map = nativeFunction(
	(
		values: Or([] List(Any))
		callback: (
			value: TypeOf(values)/ElementType
			index: PositiveInteger
		) :> Any
	) :> TupleOf(length(values) callback/ReturnType)
	…
```

- `TypeOf(values)/ElementType` ist bei einem Tupel die Union seiner Elemente
  (`typePropertyAccess.tuple`). Mit diesem Typ wird der Rumpf des Callbacks einmal inferiert.
- `TupleOf` füllt die Positionen mit demselben `callback/ReturnType` (`tupleOfFromTypes`).
- Konstante Argumente faltet das Constant Folding je Position (`[1 2].map(…)` ergibt `[2 3]`).
  Für Streams, Typen und Parameter greift das nicht.

Der Anwendungsfall ist `combine$`: `combine$(a$ b$ c$)` ergibt heute
`Stream(Or([] List(Or(A B C))))`, beim Destructuring verliert jede Position ihren Typ
(`jul-examples/ui/dynamic-form`).

## Ansatz: ReturnType je Position instanziieren, nicht den Rumpf neu inferieren

Der ReturnType eines Callback-Literals bleibt schon heute generisch in dessen eigenen Parametern.
`(value) => value/ValueType` hat den ReturnType `value/ValueType` mit `value` als Verweis auf den
Parameter, `(value index) => [value index]` hat `[value index]`. Es genügt also, diese Verweise je
Position durch den Elementtyp und den Index zu ersetzen. Das ist derselbe Mechanismus, mit dem ein
generischer Rückgabetyp am Aufruf aufgelöst wird (`dereferenceArgumentTypesNested`), nur mit dem
Callback als aufgerufener Funktion.

Neue Typfunktion `MapElements(Source Callback)` (Knoten `mapElements`), map wird zu

```jul
	) :> MapElements(TypeOf(values) TypeOf(callback))
```

`TypeOf(callback)`, weil eine Funktion in Typ-Position sonst zum Prädikat wird.

Auflösung `mapElementsFromTypes`:

| Source | Ergebnis |
|---|---|
| Tupel `[e1 … en]` | Tupel, Position i = ReturnType mit `value = ei`, `index = i` |
| 0-Tupel, Empty | Empty |
| `List(E)` | `List(ReturnType mit value = E, index = PositiveInteger)`, wie heute |
| Or, Alias | verteilt |
| Platzhalter (Parameter, offenes Concat, …) | Knoten bleibt stehen, aufgelöst am Aufruf |
| sonst (Any …) | `List(ReturnType)`, wie heute |

Damit wird combine$ typisierbar, ohne Sonderfall:

```jul
combine$ = nativeFunction(
	(
		...sources: Or([] List(Stream(Any)))
	) ~> Stream(sources.map((value) => value/ValueType))
	…
```

`value` ist hier ein Stream-Wert, JUL2600 greift also nicht. Rückgabetypen werden nie emittiert,
das `map` im Rückgabetyp läuft nicht zur Laufzeit.

### Verworfen

- **Rumpf je Position neu inferieren.** Kostet `inferType` n-fach, meldet Fehler n-fach, und weil
  der Checker `typeInfo` in den Baum schreibt, zeigt der Hover die zuletzt geprüfte Position. Gewinn
  nur bei Rümpfen, die sich durch Verengung je Position konkretisieren.
- **`TypeOf(sources).map(…)`.** `TypeOf([A B])` ist nicht an `List(Any)` zuweisbar, und `value`
  hielte einen Typ: map schreibt den Namen `value` vor, JUL2600 verlangt Großschreibung.

## Mitzubehebende Lücke

**Leere Union wird Never.** `dereferenceNameFromObject` und `dereferenceNameFromObjectType`,
jeweils Fall `or`, lassen unentschiedene Choices weg. Bleibt keiner übrig, entsteht Never, das
überall zuweisbar ist und Fehler verdeckt. Richtig ist unbekannt (Any).

`Stream(X)/ValueType` auf Typebene und die Frage, ob eine Typeigenschaft `T` oder `TypeOf(T)`
ergibt, regelt [type-properties.md](type-properties.md): `TypeOf(T)`. Deshalb erwartet der
Zieltest `[TypeOf(Text) TypeOf(Integer)]`.

Unter dieser Semantik ist combine$ erst wirklich korrekt: je Position ergibt `value/ValueType`
`TypeOf(Ai)`, und `Stream(…)` packt das Tupel elementweise aus. `MapElements` liest den
ReturnType des Callbacks direkt vom Funktionstyp, nicht über `dereferenceNameFromObject`.

## Schritte

Jeder Schritt beginnt mit einem roten Test. Vorher und nachher `npm run bench -- --save`.

1. **Leere Union → Any.** `f = (T: Or(TypeOf(Integer) TypeOf(Text))) :> Integer => [T/Foo]`
   meldet `[Any]` statt `[Never]`, analog über `TypeOf(x)/Foo`.
2. **`MapElements` und die neue map-Deklaration.** Neben dem Zieltest:
   - `[Integer Text].map((value index) => [value index])` ergibt
     `[[TypeOf(Integer) 1] [TypeOf(Text) 2]]`
   - `t.map((value) => [value])` mit `t: [Integer Text]` ergibt `[[Integer] [Text]]`
   - `t.map((value index) => index)` ergibt `[1 2]`
   - `[a$ b$].map((value) => value/ValueType)` ergibt `[TypeOf(Integer) TypeOf(Text)]`
   - `t: Or([] [Integer Text])` ergibt `Or([] [[Integer] [Text]])`
   - Gegenproben: `List(Integer)` bleibt `List([Integer])`, ein Callback-Parameter statt Literal
     liefert n gleiche Positionen, ein Fehler im Rumpf kommt genau einmal.
3. **combine$.** `combine$(a$ b$ c$)` ergibt `Stream([Text Or([] Integer) Boolean])`,
   `combine$()` ergibt `Stream(Empty)`.
4. **Baselines.** Snapshot-Diff ansehen: erwartet sind nur engere Typen (`dynamic-form`,
   `stream.jul`), kein neues Never, keine neuen Fehler. `build-all`, LSP-Snapshot, `jul check` in
   yugioh.
5. **Optional, getrennt gemessen:** `TupleOf` entfernen, es wird nur von map benutzt. Das
   gemeinsame Gerüst der Typfunktionen (über Or verteilen, Platzhalter aufschieben, bei List
   zurückfallen) als Helfer herausziehen.

## Stellen

- `core-lib.jul`: map, combine$, später TupleOf
- `runtime.ts`: `MapElements` als `/*#__PURE__*/`-Export, der wirft (nur Typebene), danach
  `npm run check-runtime-purity`
- `syntax-tree.ts`: Knoten `mapElements` samt Konstruktor und `forEachChildType`
- `checker.ts`: `dereferenceNameFromObject(Type)`, `case 'MapElements'` in
  `getReturnTypeFromFunctionCall` neben `TupleOf`, `mapElementsFromTypes` neben `tupleOfFromTypes`,
  `traversePlaceholders` sowie alle erschöpfenden Switches, die `tupleOf` kennen

## Risiken

- **Identität des Callbacks.** Der Verweis `value` zeigt auf das ursprüngliche Funktionsobjekt und
  wird per Identität ersetzt. `resolvePlaceholders` kopiert Funktionen, deshalb darf
  `traversePlaceholders` den Callback im Knoten nicht kopieren. Sonst fällt die Auswertung still auf
  die Union zurück, ohne Fehler, aber ungenau.
- **Performance.** Je Position wird nur der ReturnType traversiert. Teurer sind n verschiedene
  statt n gleiche Typen weiter hinten, etwa in `removeSubtypes`. Grenze `maxMappedPositions`
  (Startwert etwa 50, am Bench festlegen), darüber das heutige Verhalten.
- **Rumpf gegen die Union.** Ein Rumpf, der nur je Position gültig ist, meldet weiterhin einen
  Fehler gegen die Union. Das löste nur das verworfene Neu-Inferieren.
- **yugioh** hängt ungepinnt am Compiler. Engere Typen können dort neue Fehler auslösen.
