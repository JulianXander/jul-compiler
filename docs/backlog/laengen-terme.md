# Längen-Terme: Indexbeweise über die Länge eines bestimmten Werts

Entwurf. Angestoßen vom assume-Abbau in yugioh (Funde 57 und 59 in `yugioh/docs/jul-findings.md`).

**Stand 2026-10-28:** Schritte 1 bis 3 umgesetzt. Schritt 3: `CompileTimeLengthOfType.Offset` (Länge + Konstante), `subtractFromTypes` verschiebt den Abstand und lässt die Zahlengrenzen daneben stehen, `isIndexWithinLength` verlangt denselben Term, Abstand ≤ 0 und Minimum ≥ 1. Zu Schritt 1 und 2, mit diesen Abweichungen vom Entwurf:

- Keine frischen Terme für Ausdrücke ohne Pfad. Eine Liste ohne Länge beweist nichts mehr
  (`dereferenceNestedKeyFromObject` verlangt `Length`), frische Terme wären also nur Präzision und
  kosteten Cache-Treffer. Aufrufergebnisse verlieren eine durchgereichte Länge
  (`withExpressionListLength` in `checker.ts`).
- Im Rumpf ist ein Parameter ein `parameterReference`. Seine Länge entsteht beim Auflösen
  (`case 'parameterReference'` in `traversePlaceholdersUncached`), ein Feldpfad darauf in
  `traverseOperation`. Am Aufruf (`argumentContext`) gilt ein Term je Aufruf
  (`getArgumentLengthTerm`).
- `isTypeAssignable` entfernt die Länge des Arguments, wenn das Ziel keine verlangt, damit der
  Cache trifft.
- Kosten (A/B direkt hintereinander, yugioh): parse+check 11 878 → 12 625 ms (+6 %), geteilt
  828 → 858 ms (+4 %), `getTypeError` +3,7 %. Direkt zuzuordnen sind etwa 3 %, der Rest kommt von
  mehr verschiedenen Listentypen (Caches).

## Ausgangspunkt

`getElement(values length(values))` liefert bei `values: List(T)` den Typ `T` ohne `Empty`. Möglich
macht das der Knoten `lengthOf`: `length` ist als `LengthOf(TypeOf(values))` deklariert, und
`dereferenceNestedKeyFromObject` ([type-algebra.ts](../../src/checker/type-algebra.ts),
`case 'lengthOf'`) lässt `Empty` weg, wenn der Index `lengthOf(S)` ist und `typeEquals(S, Quelle)`
gilt.

Der Vergleich läuft über den **Typ**, gemeint ist aber **der Wert**. Das hat zwei Folgen.

**Unsound.** Die Länge einer anderen Liste gleichen Typs gilt als Beweis. Beide Fälle bauen ohne
Meldung und liefern zur Laufzeit `Empty` (rote Tests in [checker.test.ts](../../src/checker/checker.test.ts),
`element-at-plus-length-of-other-list-with-same-type-keeps-empty` und
`…-of-same-field-in-other-record-keeps-empty`):

```jul
f = (values: List(Integer) other: List(Integer)) :> Integer =>
	getElement(values length(other))

History = [past: List(Integer)]
g = (a: History b: History) :> Integer =>
	getElement(a/past length(b/past))
```

**Zu ungenau.** Alles, was nicht exakt `lengthOf(S)` ist, verliert den Bezug:

```jul
count = values.length()
?(count)
	[GreaterInteger(1)] =>
		values.getElement(count.subtract(1))   # Or(Empty T), obwohl 1 ≤ count - 1 ≤ Länge
```

`subtractFromTypes` rechnet nur mit Zahlengrenzen, aus `count - 1` wird `GreaterInteger(0)`. In
yugioh steht deshalb an zwei Stellen eine `[Empty]`-Prüfung, die nie greift (Schritt `negate`,
`renderTransitionHints`). Ebenso weiß der Checker nicht, dass `values.map(f)` dieselbe Länge hat
wie `values`.

In Signaturen ist die Identität dagegen sauber gelöst: `parameterReference` steht für „das Argument
an Position i". `lastElement` (`ElementAt(TypeOf(values) length(values))`) ist deshalb korrekt. Für
lokale Bindungen und Feldpfade fehlt ein solches Mittel.

## Wie andere Sprachen das lösen

| Ansatz | Beispiele | Identität | `length - 1` | Kosten |
|---|---|---|---|---|
| Laufzeitprüfung, `T \| undefined` | TypeScript, Rust, Java | – | – | keine, aber keine Präzision |
| Nicht-leere Liste als Typ | Haskell `NonEmpty`, TS `[T, ...T[]]` | – | – | gering; JUL hat das mit `List(X)` |
| Länge im Typ, frische Variable je Wert | Idris/Agda `Vect n`/`Fin n` | über die Länge | ja | abhängige Typen |
| Branding | Rust-Crate `indexing`, „Ghosts of Departed Proofs" | Marke je Container | nein | umständliche API |
| Pfadabhängige Typen | Scala `x.type` | Wert/Pfad | nein | Knoten an jedem Wert |
| Refinement Types | Liquid Haskell, Flux, F* | Terme über Variablen | ja | SMT-Solver |

Der Entwurf übernimmt von Liquid Types die Terme über unveränderliche Variablen und von `Vect n`
die Länge als Teil des Listentyps, ohne Solver: Verglichen werden nur Terme mit konstantem Abstand.

## Entwurf

### 1. Längen-Term

Ein Längen-Term bezeichnet die Länge eines bestimmten Werts:

- **Pfad:** ein Symbol (die Definition, wie in `NarrowedTypes`) plus Feldschlüssel, etwa `values`
  oder `a/past`. JUL-Bindungen sind unveränderlich, derselbe Pfad bezeichnet im selben Gültigkeitsbereich
  also immer denselben Wert. In-place-Mutation ([inplace-mutationen.md](inplace-mutationen.md))
  ändert daran nichts, sie ist nur eine Emitter-Optimierung ohne sichtbare Wirkung.
- **Parameter:** In Signaturen bleibt `parameterReference` die Quelle, wie heute.

### 2. Die Liste trägt ihre Länge

`CompileTimeListType` bekommt ein optionales Feld `Length` mit einem Längen-Term. Es entsteht dort,
wo der Checker einen Pfad typisiert:

- `case 'reference'` in `checker.ts`: Hat das Symbol einen Listentyp, wird daraus `List(T)` mit
  `Length = len(symbol)`. Bei `Or([] List(T))` bekommt der Listenzweig die Länge.
- Feldzugriff `a/past`: Der Pfad wird um den Schlüssel verlängert.
- Verengung: Der eingeengte Typ behält die Länge, weil er aus demselben Pfad kommt.
- Eine lokale Definition `x = values` übernimmt den Typ ihres Werts und damit `len(values)`. Ein
  Alias kostet also keine Präzision.

`length(x)` liest dann nicht mehr den Typ, sondern dessen Länge: `getLengthFromType` liefert bei
einer Liste mit `Length` den Term statt eines anonymen `lengthOf`. Die Liste hat damit die Identität,
nicht der Index. Den Nebenkanal, den ein Vergleich nur am `lengthOf` bräuchte, gibt es nicht.

**Zuweisbarkeit:** `List(T)` mit Länge ist `List(T)` ohne Länge zuweisbar, umgekehrt nicht. Zwei
Längen sind nur bei gleichem Term verträglich. Fehlt die Länge (Ergebnis eines Aufrufs ohne
längenerhaltende Signatur, Literal unbekannter Länge), verhält sich alles wie heute ohne `lengthOf`.
Das ist ein Präzisionsverlust, nie ein Soundness-Verlust.

### 3. Integer-Grenzen mit Termen

Eine Grenze (`bound`) darf heute schon einen beliebigen Typ als `Value` haben. Neu ist die Form
**Term plus Konstante**: `len(values) + k` mit ganzzahligem `k`.

- `getIntegerRange`, `getIntegerMinimum` und `getIntegerMaximum` liefern neben Zahlengrenzen eine
  symbolische Grenze `{ term, offset }`. Zwei symbolische Grenzen vergleichen sie nur bei gleichem
  Term. Sonst gilt, was über den Term an Zahlen bekannt ist: Die Länge einer `List(T)` ist ≥ 1.
- `add`/`subtract` mit einer Konstanten verschieben den Offset. Mit einem Nicht-Konstanten fallen sie
  auf die Zahlengrenzen zurück, wie heute.
- Die Verengung `?(count) [GreaterInteger(1)]` schneidet die Zahlengrenze in den Typ von `count`,
  der Term bleibt erhalten. `count.subtract(1)` ist dann `1 ≤ i ≤ len(values) - 1`.

Gleichungen zwischen verschiedenen Termen (`len(a) = len(b)`) gibt es nicht. Ein Vergleich wie
`?(a.length().equal(b.length()))` beweist also nichts, dafür bräuchte es einen Solver.

### 4. Zugriff

`getElement(xs i)` liefert das Element ohne `Empty`, wenn `xs` eine Länge `L` trägt und der Bereich
von `i` zwischen `1` und `L + k` mit `k ≤ 0` liegt. Das ersetzt den `typeEquals`-Vergleich in
`dereferenceNestedKeyFromObject`. Dieselbe Regel gilt für `ElementAt`, `setElement`/`WithElementAt`
und die Indexbereiche von `slice`.

### 5. Längenerhaltende Operationen

`map`, `setElement`, `sort` und `reverse` liefern eine Liste mit derselben Länge wie ihre Eingabe.
Ihre Signaturen bekommen das ausdrücklich, etwa über `MapElements`, das die Länge weiterreicht. Damit
gilt `values.map(f).getElement(values.length())` ohne `Empty`.

### 6. Terme verlassen ihren Gültigkeitsbereich nicht

Ein Term über ein lokales Symbol ist außerhalb der Funktion sinnlos. Beim Ableiten eines
Rückgabetyps:

- wird `len(parameter)` zu `length(parameter)` über `parameterReference`, damit der Aufrufer die
  Länge seines Arguments einsetzen kann (wie heute bei `lastElement`),
- wird jeder andere Term vergessen und durch die Zahlengrenzen ersetzt.

Closures dürfen Terme äußerer Symbole behalten, solange sie im Gültigkeitsbereich bleiben.

## Betroffene Stellen

- [syntax-tree.ts](../../src/syntax-tree.ts): `CompileTimeListType` mit `Length`, Längen-Term als Knoten
  oder als Form von `lengthOf`. Der Intern-Schlüssel enthält den Term.
- [type-algebra.ts](../../src/checker/type-algebra.ts): `getLengthFromType`,
  `dereferenceNestedKeyFromObject` (`lengthOf`), `getIntegerRange`/`-Minimum`/`-Maximum`,
  `addFromTypes`/`subtractFromTypes`, Zuweisbarkeit und Gleichheit von Listen, `traversePlaceholders`,
  `typeToString`.
- [checker.ts](../../src/checker/checker.ts): `case 'reference'`, Feldzugriff, `getNarrowedType`,
  Ableitung des Rückgabetyps (Terme entfernen bzw. umschreiben).
- [core-lib.jul](../../src/runtime/core-lib.jul): Signaturen der längenerhaltenden Funktionen.

## Schritte

Jeder Schritt mit Bench vorher und nachher auf yugioh und mit Tests vor dem Fix.

1. **Länge an der Liste, Zugriff nur bei gleichem Term.** Schließt die Lücke aus Fund 57, macht die
   beiden roten Tests grün. Yugioh muss danach weiter bauen. Jede neue Meldung dort ist eine echte
   Lücke.
2. **Terme beim Verlassen des Gültigkeitsbereichs umschreiben oder entfernen** (Punkt 6). Gehört
   eigentlich zu Schritt 1, sonst landen lokale Terme in abgeleiteten Rückgabetypen.
3. **Term plus Konstante, Verengung über die Länge.** Macht `getElement(count.subtract(1))` sicher.
   In yugioh entfallen die `[Empty]`-Prüfungen in `negate` und `renderTransitionHints`.
4. **Längenerhaltende Signaturen** (`map` usw.).

## Offene Fragen

- **Performance:** Jede Referenz auf eine Liste erzeugt einen eigenen interning-Schlüssel. Wie stark
  wachsen Typanzahl und Cache-Fehlschläge auf yugioh? Messen ab Schritt 1.
- **Fehlermeldungen:** `typeToString` sollte die Länge meist weglassen. Wann ist `List(Text)` mit
  `len(values)` für den Leser nötig, etwa in der Meldung zu `getElement`?
- **`Or([] List(T))` mit eingeengter Länge:** Wird nur die Länge eingeengt (`?(length) [PositiveInteger]`),
  bleibt die Liste selbst `Or([] List(T))`. Ob die Länge ≥ 1 die Liste auf `List(T)` einengen darf, ist
  eine eigene Regel (Verengung über abgeleitete Werte).
- **Tupel:** Sie haben eine feste Länge und brauchen keinen Term. Ein Tupel als Pfad ändert nichts.
- **Snapshot:** Der Checker-Snapshot ändert sich vermutlich an vielen Stellen, die Baseline ist
  anzusehen, nicht blind zu übernehmen.
