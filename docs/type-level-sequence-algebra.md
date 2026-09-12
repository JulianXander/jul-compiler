# Typ-Ebene Sequenz-Algebra

Ein Tupel-Typ ist eine Sequenz von Typen. Die Typoperationen, die core-lib braucht, um ihre
Rückgabetypen selbst zu deklarieren, sind genau die klassischen Sequenz-Operationen. Dieses
Dokument hält fest, welche das sind, wie sie im Checker dargestellt werden und in welcher
Reihenfolge sie gebaut werden.

Die Motivation steht in [core-lib-empty-return-types.md](core-lib-empty-return-types.md),
Abschnitt „Architekturfrage": Werte-Builtins dürfen im Checker nicht am Namen erkannt werden,
Typkonstruktoren dürfen nativ sein. Dieses Dokument ist die Ausarbeitung von Option D für die
verbliebenen Fälle.

## Warum das keine Ausnahmenliste ist

Die Schwelle aus der Architekturfrage lautet: *nur für allgemeine Typoperationen, nicht pro
Funktion*. „An Position schreiben" ist das Duale zu „an Position lesen", nicht „der Typ von
`setElement`" — jede dieser Operationen steht Nutzercode offen, unabhängig davon, welche
core-lib-Funktion sie zufällig zuerst braucht.

Die Doku nannte dort drei Operationen („zugreifen, Länge, Tuple-weise abbilden"). Das war zu
niedrig gezählt: „abbilden" deckt `map` ab, aber weder Update noch Teilfolge. Der Maßstab bleibt
gültig, die Aufzählung wird hier korrigiert.

## Die Operationen

| Operation | Konstruktor | Werte-Builtin | Stand |
|---|---|---|---|
| lesen an Position, und Teilfolge | `ElementAt(Source key)` | `getElement`, `lastElement`, `slice` | teilweise |
| Länge | `LengthOf(Source)` | `length` | fertig |
| schreiben an Position | `WithElementAt(Source index value)` | `setElement` | offen |
| füllen (N × T) | `TupleOf(count elementType)` | `map` | offen, evtl. ableitbar |

Lesen und Teilfolge sind **ein** Konstruktor: die Ergebnisform folgt der Schlüsselform (siehe
unten). Ein eigenes `ElementsAt` wäre Redundanz.

Ob `TupleOf` überhaupt nötig ist, steht unter [Ableitbarkeit](#ableitbarkeit-von-tupleof).

## Darstellung

Der **Zugriff** braucht keinen neuen Knoten. `nestedReference` trägt bereits Quelle plus Schlüssel,
und `nestedKey` ist auf `string | number | CompileTimeType` geweitet — die reicheren Schlüsselformen
sind damit schon darstellbar.

Neu ist nur das **Schreiben**:

```ts
interface CompileTimeWithElementAtType extends CompileTimeTypeBase {
	readonly julType: 'withElementAt';
	readonly Source: CompileTimeType;
	readonly Index: CompileTimeType;
	readonly Value: CompileTimeType;
}
```

Ein früherer Entwurf sah einen gemeinsamen Knoten mit `op: 'fill' | 'update' | 'select'` vor. Nachdem
`select` im Zugriffsknoten aufgeht und `fill` möglicherweise ableitbar ist, bliebe ein Diskriminator
mit einem einzigen Wert übrig — dafür lohnt er nicht. Sollte sich `fill` doch als eigener Knoten
nötig erweisen, wird dann entschieden, ob die beiden zusammengelegt werden.

## Faltung

### `TupleOf(count elementType)`

| count | Ergebnis |
|---|---|
| `integerLiteral N` | Tuple aus N × elementType |
| `0` | `Empty` |
| `lengthOf(…)` oder unaufgelöst | `List(elementType)` |

### `WithElementAt(Source index value)`

| Source | index | Ergebnis |
|---|---|---|
| tuple | Literal | Kopie mit ersetzter Position |
| tuple | nicht-Literal | jede Position `Or(orig value)` |
| list | beliebig | `List(Or(ElementType value))` |
| or | — | über die Choices verteilen |

Entspricht dem heutigen `setElementFromTypes`; der Umzug ändert die Ergebnisse nicht.

### `ElementAt(Source key)`

Die Ergebnisform folgt der Schlüsselform:

| Schlüssel | bedeutet | Ergebnis |
|---|---|---|
| `2` | eine Position | Elementtyp |
| `Or(1 2)` | eine *von* mehreren | `Or` der Elementtypen |
| `[2 3]` | *alle*, der Reihe nach | Tuple der Elementtypen |

`Or` bedeutet Alternative, ein Tuple eine Folge — die Ergebnisform ist damit keine zusätzliche
Konvention, sondern die Bedeutung, die beide Schlüsseltypen ohnehin tragen. Die ersten beiden Zeilen
gelten heute schon (`dereferenceNestedKeyFromObject`); neu ist nur die dritte.

`Range(start end)` baut den Folgen-Schlüssel: beide Enden inklusiv, `end: []` heißt „bis zum Ende",
`start > end` ergibt `Empty`. Zur Deklarationszeit sind `start`/`end` `parameterReference`s und
können nie falten — `Range` muss deshalb aufschiebbar sein.

## Ableitbarkeit von `TupleOf`

„N Kopien von T" ist dasselbe wie „die Positionen 1..N von `List(T)`", denn jede Position einer
`List(T)` hat den Typ `T`:

```
TupleOf(N T)  ≡  ElementAt(List(T) Range(1 N))
```

Damit wäre `TupleOf` überflüssig. Zwei Dinge sprechen dagegen, das sofort festzulegen:

- **Lesbarkeit.** Die Absicht „`map` erhält die Länge" verschwindet hinter einer Konstruktion, die
  man erst rückübersetzen muss. Ein abgeleitetes `TupleOf` in core-lib hilft nicht: Typkonstruktoren
  deklarieren `:> Type`, die Faltung steckt im Checker — eine abgeleitete Deklaration liefert keine
  Kompilierzeit-Präzision.
- **Die Empty-Frage wird subtiler.** Derselbe Ausdruck muss zwei Ergebnisse liefern: bei `slice`
  (freie Grenzen) kann die Auswahl leer sein, bei `map` (`Range(1 length(values))`) nicht. Das ist
  entscheidbar, aber nur über einen Nichtleerheits-Nachweis für den Bereich — der auf derselben
  `lengthOf`-Identität beruht, die `ElementAt` schon nutzt.

Entschieden wird das bei Schritt 2: Wird die Nichtleerheits-Regel für `slice` ohnehin gebraucht, ist
`TupleOf` tatsächlich überflüssig; sonst ist ein kleines eigenes `fill` billiger als die Subtilität.

## Zieldeklarationen

```jul
map        :> Or(And(TypeOf(values) []) TupleOf(length(values) callback/ReturnType))
setElement :> WithElementAt(TypeOf(values) index TypeOf(value))
slice      :> ElementAt(TypeOf(values) Range(start end))
```

Danach ist die Liste der Werte-Builtins, die der Checker am Namen kennt, leer.

## Warum das nötig ist, nicht nur schöner

Ein Namens-Sonderfall greift nur beim wörtlich geschriebenen Namen. Hinter einem Alias fällt der
Aufruf auf die core-lib-Deklaration zurück — ist die zu grob, verschwindet die Prüfung. Belegt für

- `length`: verlor die Längen-Identität, `Empty` blieb fälschlich stehen
  (`length-via-alias-keeps-length-identity`)
- `setElement`: fiel auf `List(Any)` zurück, ein Text an einer `List(Integer)`-Position ging still
  durch (`set-element-via-alias-keeps-value-type-check`)

Das zweite war kein Präzisionsverlust, sondern ein Loch in der Prüfung.

## Reihenfolge

1. **`WithElementAt`** — reiner Umzug bekannter Faltungslogik, etabliert den Knoten ohne
   gleichzeitig offene Semantikfragen zu klären.
2. **`TupleOf`** — klein, nutzt `LengthOf`. Danach ist die Ausnahmenliste leer.
3. **Folgen-Schlüssel + `Range`** — zuletzt, weil hier der offene Punkt unten mitentschieden wird.

Je Schritt: roter Test davor, Bench vorher und nachher als getrennte Schritte.

## Offen

- **Die Faltungsregel für den nie literal werdenden Schlüssel.** Ein aufgeschobener Knoten gilt als
  Platzhalter und wird permissiv geprüft. Das ist richtig, solange er sich noch auflösen kann; löst
  er sich nie auf (`index: PositiveInteger`), muss er stattdessen über alle Positionen vereinigen.
  Betrifft den Folgen-Schlüssel und `Range` unmittelbar und ist seit der Einführung von `ElementAt`
  offen.
- **Performance.** Gemessen beim Schritt `WithElementAt` (yugioh, 5848 Zeilen): Laufzeit im
  Rauschen (+1 bis +3 %), aber `getTypeError` von 569k auf 935k Aufrufe (+64 %) und
  `resolvePlaceholders` von 5,29 Mio auf 5,54 Mio (+5 %). Ursache ist die Faltung selbst: sie baut
  normalisierte Unions, und deren Teilmengen-Elimination ruft `getTypeError`. Ein aufschiebbarer
  Knoten wird zudem an mehreren Stellen erneut gefaltet statt einmal am Aufruf.
  Die Zeit trägt das, weil die zusätzlichen Aufrufe früh zurückkehren — bei zwei weiteren
  aufschiebbaren Formen (`Range`, evtl. `fill`) ist aber nicht selbstverständlich, dass das so
  bleibt. Vor Schritt 2 und 3 jeweils messen und die Zähler mitlesen, nicht nur den Median.
