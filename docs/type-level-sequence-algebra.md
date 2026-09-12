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
| lesen an Position, und Teilfolge | `ElementAt(Source key)` | `getElement`, `lastElement`, `slice` | fertig |
| Länge | `LengthOf(Source)` | `length` | fertig |
| schreiben an Position | `WithElementAt(Source index value)` | `setElement` | fertig |
| füllen (N × T) | `TupleOf(count elementType)` | `map` | fertig |

Lesen und Teilfolge sind **ein** Konstruktor: die Ergebnisform folgt der Schlüsselform (siehe
unten). Ein eigenes `ElementsAt` wäre Redundanz.

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

## Ableitbarkeit von `TupleOf`: geprüft und verworfen

Naheliegend wäre, `TupleOf` über den Folgen-Schlüssel auszudrücken — „N Kopien von T" als „die
Positionen 1..N von `List(T)`":

```
TupleOf(N T)  ≟  ElementAt(List(T) Range(1 N))
```

**Das trägt nicht.** `List(T)` heißt „ein oder mehr T", die Länge steht nicht fest. `Range(1 N)`
wählt daher *höchstens* N Positionen aus — ob Position N existiert, ist unbekannt. Das Ergebnis ist
korrekt `List(T)` und nicht `[T … T]`.

Die Nichtleerheit ließe sich zwar beweisen (Start 1 und ein Ende, das mindestens 1 erreicht), aber
`map` braucht die **Arity**, und das ist die stärkere Aussage. Eine Quelle, die N Positionen
garantiert, gibt es ohne genau dieses Konstrukt nicht — die Ableitung ist zirkulär.

`TupleOf` bleibt deshalb als eigene Operation nötig.

## Zieldeklarationen

```jul
map        :> TupleOf(length(values) callback/ReturnType)
setElement :> WithElementAt(TypeOf(values) index TypeOf(value))
slice      :> ElementAt(TypeOf(values) Range(start end))
```

Die Liste der Werte-Builtins, die der Checker am Namen kennt, ist damit leer.

Bei `map` entfällt dabei die frühere `And(TypeOf(values) [])`-Konditionierung: `TupleOf` liefert bei
Länge 0 selbst `Empty`, und `length(Empty)` ist 0.

## Warum das nötig ist, nicht nur schöner

Ein Namens-Sonderfall greift nur beim wörtlich geschriebenen Namen. Hinter einem Alias fällt der
Aufruf auf die core-lib-Deklaration zurück — ist die zu grob, verschwindet die Prüfung. Belegt für

- `length`: verlor die Längen-Identität, `Empty` blieb fälschlich stehen
  (`length-via-alias-keeps-length-identity`)
- `setElement`: fiel auf `List(Any)` zurück, ein Text an einer `List(Integer)`-Position ging still
  durch (`set-element-via-alias-keeps-value-type-check`)
- `map`: verlor die Tuple-Arity (`map-keeps-tuple-arity-via-alias`)

Das zweite war kein Präzisionsverlust, sondern ein Loch in der Prüfung.

## Faltung wartet nur, solange sich etwas auflösen kann

Ein aufschiebbarer Knoten wird permissiv geprüft. Bleibt er stehen, obwohl er sich nie mehr
auflösen kann, verschwindet die Prüfung lautlos — zweimal beim Bau passiert:

- `slice(1)` übergibt kein `end`, der Parameter bleibt also für immer `parameterReference`. Deshalb
  entscheidet der Bereichszugriff seine Grenzen, sobald die **Quelle** feststeht, statt auf die
  Grenzen zu warten.
- `TupleOf` darf nicht auf jede unaufgelöste Anzahl warten: `LengthOf` über einer bekannten `List`
  wird nie ein Literal. Gewartet wird nur, solange die Quelle der Länge selbst offen ist.

## Offen

- **Die Faltungsregel für den nie literal werdenden Schlüssel.** Ein aufgeschobener Knoten gilt als
  Platzhalter und wird permissiv geprüft. Das ist richtig, solange er sich noch auflösen kann; löst
  er sich nie auf (`index: PositiveInteger`), muss er stattdessen über alle Positionen vereinigen.
  Betrifft den Folgen-Schlüssel und `Range` unmittelbar und ist seit der Einführung von `ElementAt`
  offen.
- **Performance.** Gemessen je Schritt (yugioh, 5848 Zeilen). `WithElementAt`: Laufzeit im Rauschen
  (+1 bis +3 %), aber `getTypeError` rund +50 %. `Range` und `TupleOf` zusammen kosteten dagegen
  nichts mehr — Laufzeit +1 %, `resolvePlaceholders` leicht gefallen, `getTypeError` unverändert.
  Der Zuwachs hängt also nicht an der Zahl aufschiebbarer Formen.
  Nachträglich untersucht (Zähler-Instrumentierung, Vorher/Nachher unter einer Harness): Ursache
  ist nicht die Teilmengen-Elimination, nicht Mehrfachfaltung und nicht tiefere Rekursion, sondern
  dass ein aufschiebbarer Knoten als unaufgelöst gilt — jeder Konsument löst zusätzlich auf, und
  die Ergebnistypen haben mehr Choices. Inhärenter Preis der aufgeschobenen Präzision. Zahlen und
  widerlegte Hypothesen im TODO.
