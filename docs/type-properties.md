# Typeigenschaften sind Typwerte

`List(Integer)/ElementType`, `s$/ValueType`, `callback/ReturnType` und die Feldtypen eines
DictionaryType bezeichnen einen Typ. Der Checker führt das Ergebnis heute aber als Wert dieses Typs.
Dieses Dokument beschreibt die Umstellung: Eine Typeigenschaft ergibt einen Typwert mit dem Typ
`TypeOf(T)`, ausgepackt wird erst dort, wo ein Wert als Typ gelesen wird.

**Stand:** Schritte 1 bis 4 umgesetzt. Offen ist Schritt 5. Voraussetzung für
[mapped-tuples.md](mapped-tuples.md).

## Heute

```jul
y: Integer = Integer                           # Fehler: Can not assign TypeOf(Integer) to Integer.
a = List(Integer)/ElementType                  # a: Integer, gemeint ist der Typ Integer
x: Integer = List(Integer)/ElementType         # kein Fehler
T = List(Integer)/ElementType                  # JUL2600: 'T' is not a type …
```

Derselbe Wert hat je nach Schreibweise verschiedene Typen: `pick(Integer)` ergibt `TypeOf(Integer)`,
`pick(List(Integer)/ElementType)` ergibt `Integer`. Aufrufe mit einer Typeigenschaft als Argument
werden sogar gefaltet, als stünde dort eine Zahl (`inc(List(5)/ElementType)` ergibt `6`).

Das Auspacken funktioniert in Signaturen nur, weil `valueOf` Nicht-TypeOf unverändert durchreicht:

```jul
first = (values: List(Any)) :> TypeOf(values)/ElementType => values.getElement(1)
r = first([1 2])                               # r: 1, muss so bleiben
```

Zur Laufzeit gilt schon die strenge Bedeutung: `List()` und `Dictionary()` behalten `ElementType`,
`List(Integer)/ElementType` liefert den Typ Integer. `Stream()` und Funktionen tragen keinen
`ValueType` bzw. `ReturnType`, diese Zugriffe kommen nur in Signaturen vor, die nie emittiert werden.

## Ziel

| Ausdruck | heute | danach |
|---|---|---|
| `List(Integer)/ElementType` | `Integer` | `TypeOf(Integer)` |
| `Stream(Text)/ValueType` | `Any` | `TypeOf(Text)` |
| `TypeOf(s$)/ValueType`, `TypeOf(cb)/ReturnType` | `Any` | `TypeOf(…)` |
| `s$/ValueType`, `cb/ReturnType` | ausgepackt | `TypeOf(…)` |
| `first([1 2])` mit `:> TypeOf(values)/ElementType` | `1` | `1` |

Ausgepackt wird an den Grenzen, die das schon heute über `valueOf` tun: Annotationen von Definition,
Parameter und Rückgabe, Argumente von Typfunktionen (`List`, `Or`, `Stream`, `TupleOf` …),
Typguards in Branches und beim Destructuring. Für Anwender ändert sich an der Schreibweise nichts.

## Ansatz

**Die Zugriffstabellen bleiben ausgepackt.** `typePropertyAccess` und `valueFieldAccess` sind das
Gerüst für Lesen und Ersetzen, `substituteProjection` braucht diese Symmetrie. Neu ist nur das
Wissen, welche Namen Typeigenschaften sind: alle Einträge von `typePropertyAccess`, dazu
`ParamsType`, `ReturnType` und `PredicateIfTrue` bei Funktionen und `ValueType` bei Streams.

**Eingepackt wird genau einmal, beim Lesen der Eigenschaft**, an zwei Stellen:

1. `dereferenceNameFromObjectType` packt das Ergebnis in `TypeOf` ein. `typePropertyAccess` bekommt
   die fehlenden Einträge `stream`, `function` und `parameters`.
2. `dereferenceNameFromObject` leitet Typeigenschaften von Funktionen und Streams an
   `dereferenceNameFromObjectType` weiter. `getValue` und Dictionary-Felder bleiben Wertzugriffe.
   `s$/ValueType` und `TypeOf(s$)/ValueType` haben damit eine Implementierung und dieselbe Bedeutung.

Nie „nur einpacken, wenn noch kein TypeOf“: `TypeOf([Integer])/ElementType` ist zu Recht
`TypeOf(TypeOf(Integer))`.

**Ausgepackt wird auch aufgeschoben.** Heute reicht `valueOf` eine `nestedReference` unverändert
durch (dort steht `TODO?`), ein erst am Aufruf aufgelöstes `TypeOf(values)/ElementType` käme
eingepackt an. Deshalb:

- `NestedReferenceType` bekommt `deferValueOf`, wie `parameterReference`. `valueOf` setzt das Flag,
  idempotent.
- `traversePlaceholders` wendet nach dem Auflösen `valueOf` an, wenn das Flag gesetzt ist. Bei einer
  Kette `TypeOf(x)/ElementType/ValueType` trägt nur der äußere Knoten das Flag.
- `typeEquals` vergleicht das Flag.
- `valueOf` verteilt über `or`. Das Einpacken bei einer Union als Quelle liefert `Or(TypeOf(A) TypeOf(B))`.
  Das behebt nebenbei einen bestehenden Fehler:
  `(T: Or(TypeOf(Integer) TypeOf(Text))) => (x: T = 5)` meldet heute, dass 5 nicht an
  `TypeOf(Integer)` passt.
- `substituteProjection` setzt am Blatt ausgepackt ein, sonst bekäme
  `f = (s$: Stream(Any)) => s$/ValueType` beim Aufruf einen Parameter `Stream(TypeOf(Integer))`.

### Verworfen

- **Einpacken in den Tabellen selbst.** Bricht die Symmetrie von Lesen und Ersetzen, Ketten über
  TypeOf-Werte bräuchten eigene Tabelleneinträge für `typeOf`.
- **Einpacken nur im Ausdrucksfall `nestedReference`.** Die aufgeschobene Auflösung bliebe
  ausgepackt, derselbe Ausdruck hätte direkt und am Aufruf verschiedene Bedeutung.
- **Alles ausgepackt lassen.** Widerspricht `y: Integer = Integer`, übersieht Fehler, meldet JUL2600
  falsch und trennt `pick(Integer)` von `pick(List(Integer)/ElementType)`.

## Schritte

Jeder Schritt beginnt mit einem roten Test. Vorher und nachher `npm run bench -- --save`.

1. **`valueOf` verteilt über `or`.** Test: der Fall mit `T: Or(TypeOf(Integer) TypeOf(Text))`
   meldet nichts. Snapshot und Zähler bleiben unverändert.
2. **Fehlende Einträge in `typePropertyAccess`**, noch ausgepackt. Die Tests prüfen an der
   Annotationsgrenze und bleiben deshalb nach Schritt 3 gültig:
   - `x: TypeOf(s$)/ValueType = §a§` mit `s$: Stream(Integer)` meldet `§a§` gegen `Integer`
   - `x: TypeOf(cb)/ReturnType = 5` mit `cb: (q: Integer) :> Text` meldet `5` gegen `Text`
   - `n: Stream(Text)/ValueType = 5` meldet `5` gegen `Text`
3. **Einpacken und aufgeschobenes Auspacken**, nur zusammen möglich: Aufschieben ohne Einpacken
   macht aus einem Funktionstyp ein Prädikat, Einpacken ohne Aufschieben macht `first([1 2])` zu
   `TypeOf(1)`. Dazu gehört flatten in der core-lib: `TypeOf(TypeOf(values)/ElementType)/ElementType`
   wird zu `TypeOf(values)/ElementType/ElementType`. Leittests:
   - `x: Integer = List(Integer)/ElementType` meldet `TypeOf(Integer)`
   - `x: Integer = Stream(Text)/ValueType` meldet `TypeOf(Text)`
   - `x: Integer = s$/ValueType` mit `s$: Stream(Text)` meldet `TypeOf(Text)`
   - `T = List(Integer)/ElementType` meldet nichts
   - `x: Integer = f(a$)` mit `f = (s$: Stream(Any)) => s$/ValueType` meldet nur `TypeOf(Integer)`,
     keinen Argumentfehler

   Gegenproben, die grün bleiben müssen: `first([1 2])` ergibt `1`, push, die flatten-Tests, map
   mit Funktionen als Rückgabe (kein Prädikat), `combine$` und `flatMergeMap$` unverändert, im
   Language Server bleibt der Callback-Parameter bei der Completion ein Literal.
4. **Baselines.** Snapshot-Diff ansehen, erwartet ist keine Änderung. `build-all`, im Language
   Server `npm test` und `test-snapshot`, `jul check` in yugioh.
5. **Optional, getrennt:** Completion nach `List(Integer)/`, Anzeige von `TypeOf(…)` im Detail.
   Ob die Wertform `s$/ValueType` neben `TypeOf(s$)/ValueType` bestehen bleibt.

## Risiken

- **Snapshot und yugioh.** Kein Nutzercode liest Typeigenschaften, alle Signaturen packen an einer
  Grenze aus. Erwartet ist keine Änderung, jede Abweichung ist ein Fehler im Umbau. Am ehesten
  betroffen sind die Aufrufe von flatten, push und subscribe.
- **Zähler.** Die Verteilung über `or` kann `getTypeError` erhöhen, deshalb nur neu bauen, wenn sich
  ein Choice ändert.
- **Language Server.** Wo der Hover Platzhalter auflöst, steht künftig `TypeOf(X)` statt `X`. Das
  ist gewollt.
- **Constant Folding.** Typeigenschaften als Argument werden nicht mehr gefaltet. Das ist richtig.
- **Prädikate.** `valueOf` einer Funktion ergibt ein Prädikat, ein ausgepacktes `TypeOf(F)` dagegen
  den Funktionstyp. Das ist richtiger als heute, `filter` und `findFirst` mit `PredicateIfTrue` aber
  im Blick behalten.
- **Stellen, die still ausgepackt liefern:** `dereferenceParameterFromArgumentType` im Fall
  `function` (liefert `ReturnType` direkt) und bei benannten Argumenten. Prüfen, ob sie erreichbar
  sind.
