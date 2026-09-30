# Zahlenbereiche als Typen

Umsetzungsplan. Ersetzt die Idee in [backlog/integer-range.md](backlog/integer-range.md), die dort
offen gebliebenen Fragen sind hier entschieden oder als Entscheidungspunkt markiert.

## Ziel

Obere und untere Grenzen sollen sich so schreiben und prüfen lassen wie heute nur die untere:

```jul
PositiveInteger = GreaterInteger(0)
index: And(GreaterInteger(0) Or(count LessInteger(count)))
ratio: And(GreaterFloat(0f) LessFloat(1f))
```

Der Checker soll dabei jede Schreibweise desselben Bereichs gleich behandeln:
`And(GreaterInteger(0) LessInteger(4))`, `Or(1 2 3)` und `And(Or(1 GreaterInteger(1)) Or(3 LessInteger(3)))`
sind dieselbe Menge und müssen in beide Richtungen zueinander passen.

## Ausgangslage

- **Oberfläche:** Es gibt nur `Greater(value)` (strikt, `value: Or(Integer Float)`), und es
  enthält Werte beider Familien. Eine obere Grenze entsteht über `Not(Greater(y))`, eine inklusive
  untere über `Or(y Greater(y))`. `range`, `repeat` und `forEach` schreiben ihre Grenzen so aus.
- **`Not(Greater(y))` ist kein Zahlentyp**, es enthält auch `§a§`. Deshalb steht überall ein
  `Integer` im `And` daneben.
- **`Greater` hat keine Familie:** `getTypeFamily` liefert dafür nichts, `greaterOverlapsWith` ist
  ein Sonderfall, gemischte Grenzen (`Greater(2)` gegen `Greater(2.5f)`) bleiben unentschieden.
  Brüche liegen trotz des Namens nie darin, die Laufzeit prüft `value > Value`.
- **Checker:** Zwei getrennte Helfer lesen Grenzen ab: `getIntegerMinimum` (für den Rückgabetyp von
  `add`) und `getIntegerRange` (Teilmenge und Überlappung, nur Integer, nur `Greater`,
  `Not(Greater)`, Literale und `And`). Die Regeln für `greater` in `getTypeErrorByStructure`,
  `typesOverlap`/`greaterOverlapsWith` und `typeEqualsAtDepth` arbeiten daneben einzeln weiter.
- **Offene Lücken** (siehe `TODO`): `Not(n)` an der Grenze wird nicht verrechnet,
  `Or(n Greater(n))` nicht als untere Grenze gelesen, `Or(1 2 3)` nicht als Bereich erkannt, ein
  leerer Bereich nicht zu `Never`. Für Floats erkennt der Checker kaum etwas.
- **Laufzeit:** [runtime.ts](../src/runtime.ts) kennt `greater` in `getTypeError` und
  `typeToString`.
- **Verwendung:** `Greater` steht nur in der core-lib (fünf Stellen, alle mit Integer-Grenze),
  nicht in yugioh, jul-examples oder der Homepage-Doku.

## Entscheidungen

### Eine Familie je Grenze, im Namen

Ein Vergleich über zwei Familien ergibt in JUL keinen Sinn: `2` und `2f` sind verschiedene Werte,
Integer und Float sind disjunkt. Jede Grenze gehört deshalb zu genau einer Familie, und die steht
im Namen:

| Name | Menge |
|---|---|
| `GreaterInteger(value: Integer)` | ganze Zahlen > value |
| `LessInteger(value: Integer)` | ganze Zahlen < value |
| `GreaterFloat(value: Float)` | Floats > value |
| `LessFloat(value: Float)` | Floats < value |

`Greater` entfällt ersatzlos. Zwei Schreibweisen für dieselbe Sache wären gegen die
Einheitlichkeit.

Die Familie aus dem Typ der Grenze abzuleiten (`Greater(0)` Integer, `Greater(0f)` Float) wäre
kürzer, verstößt aber gegen die Klarheit: Bei `Greater(count)` hängt die Bedeutung am Typ von
`count`, der woanders steht, bei einem Import in einer anderen Datei. Die Benennung folgt dem
Bestand (`PositiveInteger`, `NonZeroInteger`/`NonZeroFloat`, `maxInteger`/`maxFloat`).

Die Grundformen sind strikt. Bei Floats lässt sich `< y` nicht in `≤ y − 1` umrechnen, zwei
strikte Formen erreichen aber mit `Or` beide Striktheiten. Scala *refined* ist ebenso aufgebaut
(`Greater`, `Less`, inklusive als abgeleitete Formen).

Inklusive Grenzen werden vorerst mit `Or` ausgeschrieben:

```jul
# ≥ start
Or(start GreaterInteger(start))
# ≤ end
Or(end LessInteger(end))
```

Das bleibt ein Zahlentyp, anders als `Not(GreaterInteger(end))`.

**Ausnahme, offen (siehe `TODO`):** Hängt die Grenze an einem Aufruf, der erst am Aufrufort feststeht, geht
die `Or`-Form heute verloren. `And(PositiveInteger Or(length(values) LessInteger(length(values))))`
im Parametertyp von `forEach` wird schon bei der Deklaration zu `PositiveInteger`: Das `And`
wird über das `Or` verteilt, und die Normalisierung der Union behandelt den offenen Wert
`length(values)` wie `PositiveInteger`, das den Rest verschluckt. Die oberen Grenzen in der
core-lib stehen deshalb vorerst als `Not(GreaterInteger(…))`. Im `And` mit `PositiveInteger`
schadet das nicht, das `And` schneidet die Nicht-Zahlen ab.

Inklusive Grenzen kommen heute an vier Stellen vor, alle in der core-lib. Kurzformen (`AtLeast`/`AtMost` oder `IntegerRange(start end)`) kommen
erst, wenn Nutzercode sie braucht. Der Checker braucht für sie keine eigene Regel, denn er liest
das `Or` ohnehin als Bereich.

Die Wertfunktion `greater(first second)` ist davon getrennt und bleibt vorerst unverändert.

### Eine Sicht statt eines neuen Knotens

Der Checker bekommt **keinen** eigenen Typknoten für Bereiche. Ein solcher Knoten bräuchte Fälle
in rund fünfzehn Switches des Checkers, in `forEachChildType` und in der Laufzeit, und müsste
trotzdem neben den Grenzen, `Not` und `Or` bestehen, weil der Nutzer diese weiter schreiben kann.

Stattdessen gibt es **eine** Funktion, die einen Typ als Bereich liest, und alle Regeln fragen nur
diese. Sie ersetzt `getIntegerRange` und `getIntegerMinimum`:

```ts
interface NumberRange {
	family: 'integer' | 'float';
	/** Enthält der Typ außer Zahlen dieser Familie noch anderes (Not(...) enthält Text)? */
	hasOtherValues: boolean;
	lower?: { value: bigint | number; inclusive: boolean; };
	upper?: { value: bigint | number; inclusive: boolean; };
}
function getNumberRange(type: CompileTimeType): NumberRange | undefined;
```

Gelesen werden: `Integer`, `Float`, Literale, die vier Grenzen, `Not` über einem davon, `And`
(Schnitt der Grenzen) und `Or`, **wenn** die Vereinigung wieder ein Bereich ist (überlappend oder
angrenzend, bei Integer auch `max + 1 = min`). Aus `Or(1 2 3)` wird so `[1, 3]` und aus
`Or(0 GreaterInteger(0))` wird `[0, ∞)`. `undefined` heißt wie bisher: nicht lesbar, die Aufrufer
bleiben permissiv. Verschiedene Familien sind disjunkt, das beantwortet die Familienprüfung, nicht
die Sicht.

Die Grenze bekommt eine Familie: `getTypeFamily` ordnet `GreaterInteger`/`LessInteger` der Familie
Integer zu und die Float-Formen der Familie Float. Damit fällt der Sonderfall in `typesOverlap` weg.

Ein Knoten bleibt die spätere Option, falls die Anzeige (Phase 4) ihn doch braucht. Mit der Sicht
als einziger Stelle wäre der Umstieg lokal.

## Phasen

Jede Phase ist für sich abnehmbar. Vor und nach jeder Phase `npm run bench -- --save`, jeweils mit
Notiz, und die Snapshot-Diffs ansehen.

### Phase 1: `GreaterInteger`, `LessInteger` statt `Greater`

- `syntax-tree.ts`: Der Knoten `greater` wird zu **einem** Knoten für alle vier Grenzen:

  ```ts
  interface CompileTimeBoundType {
  	julType: 'bound';
  	Relation: 'greater' | 'less';
  	Family: 'integer' | 'float';
  	Value: CompileTimeType;
  }
  ```

  Vorbild ist der Funktionstyp, der die drei Pfeile als ein Knoten mit `purity` trägt. Zwei
  Knoten hätten keine Stelle, an der sich die Richtungen verschieden verhalten: Neun der
  bisherigen `greater`-Fälle sind reine Fall-Listen, fünf strukturell (durchlaufen, vergleichen,
  ausgeben) und würden nur kopiert, die semantischen gehen in `getNumberRange` auf. `Family` ist
  ein Feld und wird nicht aus `Value` abgeleitet, denn bei `GreaterInteger(count)` bestimmt der
  Name die Familie. **Regel:** Außer `getNumberRange` und `getTypeFamily` liest niemand `Relation`
  oder `Family`, sonst behandelt eine vergessene Unterscheidung `LessInteger` still wie
  `GreaterInteger`.
- `checker.ts`: Faltung der Aufrufe `GreaterInteger`/`LessInteger` statt des Falls `'Greater'`;
  `bound` statt `greater` in `traversePlaceholders`, `typeEqualsAtDepth` (vergleicht auch die
  Felder), `typeToString` (setzt den Namen aus `Relation` und `Family` zusammen),
  `hasReliableTypeError`, `valueOf`, `isDefinitelyNotCollectionType`, `classifyTypenessOnPath`
  und den `dereference…`-Funktionen; `getTypeFamily` liefert `Family`, und `greaterOverlapsWith`
  entfällt.
- `runtime.ts`: derselbe Knoten (`[_julTypeSymbol]: 'bound'`), `getTypeError` prüft erst die
  Familie (`typeof value === 'bigint'` bzw. `'number'`), dann den Vergleich; `typeToString` wie im
  Checker; `PositiveInteger` dort über `GreaterInteger(0n)`. Danach `npm run check-runtime-purity`.
- Der `§js`-Text in der core-lib läuft nie (siehe Kommentar über den Builtins in `runtime.ts`),
  ausgeführt wird der Export in `runtime.ts`. Die neuen Formen verweisen deshalb nur auf ihn
  (`§js GreaterInteger §`, wie `repeat`), statt eine zweite Implementierung als Text mitzuführen.
- `core-lib.jul`: Deklarationen, `Greater` entfernen, `PositiveInteger = GreaterInteger(0)`, die
  Grenzen von `range`, `repeat` und `forEach` umstellen: untere als `Or(… GreaterInteger(…))`,
  obere vorerst als `Not(GreaterInteger(…))` (siehe Ausnahme oben), das `Integer` im `And`
  fällt weg. Das `#TODO Greater Rational vs GreaterInteger, GreaterFloat` ist damit erledigt.
  **Umgesetzt.**
- `getIntegerRange` liest die neuen Knoten, damit die bestehenden Tests gleich bleiben.
- Tests: `x: GreaterInteger(0) = 1`, `= 0` ist Fehler, `= 1f` ist Fehler, `LessInteger(3)` gegen
  `Or(1 2)`, die bestehenden `range`-, `repeat`-, `forEach`- und `upper-bound`-Tests in neuer
  Schreibweise. Laufzeit über einen Branch mit `(x: LessInteger(0)) => …`. In `checker.test.ts`
  steht `Greater` an 47 Stellen (Code und erwartete Meldungen), die alle umzuschreiben sind.
- Homepage: `GreaterInteger` und `LessInteger` in der öffentlichen Doku, dort ist heute keine
  Grenze beschrieben.

### Phase 2: `getNumberRange` für Integer, ersetzt die beiden Helfer

- `getNumberRange` mit inklusiven Grenzen als Normalform für Integer (strikt wird beim Lesen
  umgerechnet: `GreaterInteger(2)` → `lower 3`).
- In `And`: ein `Not(n)` genau auf einer Grenze verschiebt sie (`≤ 3 ∧ ≠ 3` → `≤ 2`), bis sich
  nichts mehr ändert. Ein `Not(n)` im Inneren macht den Typ unlesbar (`undefined`), denn der
  Bereich hätte ein Loch.
- In `Or`: Vereinigung, wenn angrenzend oder überlappend.
- In `createNormalizedIntersectionType`: ein leerer Bereich wird `Never`, auch über mehr als zwei
  Choices.

**Umgesetzt**, mit zwei Abweichungen:
- Die Funktion heißt weiter `getIntegerRange`, denn sie liest nur Integer. Der Name
  `getNumberRange` kommt mit Phase 3.
- `getIntegerMinimum` bleibt. Es beantwortet eine andere Frage: die kleinste mögliche Zahl, auch
  für `Or(1 3)` mit Lücke und für eine noch offene Länge (`lengthOf`, mindestens 1). Beides ist
  kein Bereich, als Bereich gelesen würde `Or(1 3)` die 2 enthalten.

Tests, jeweils in beide Richtungen, wo es passt:
- `And(Integer Not(GreaterInteger(3)) Not(3))` passt zu `Not(GreaterInteger(2))`
- `GreaterInteger(-1)` passt zu `Or(0 GreaterInteger(0))`
- `And(GreaterInteger(0) LessInteger(4))` passt zu `Or(1 2 3)` und umgekehrt
- `repeat(3 (index: Or(1 2 3)) => [])` ist fehlerfrei
- `And(GreaterInteger(2) LessInteger(2))` wird `Never`
- `And(Integer Not(GreaterInteger(5)) Not(3))` bleibt unlesbar und wird nicht fälschlich angenommen
- Gegenproben: die Tests aus Phase 1 bleiben grün

Damit sind die vier Punkte der TODO unter „teilmengen mit integer-grenzen" erledigt.

### Phase 3: Floats

- `GreaterFloat`, `LessFloat` wie in Phase 1.
- `getNumberRange` für `family: 'float'`, Grenzen mit `inclusive`-Flag, denn hier gibt es keine
  Umrechnung.

**NaN gehört nicht zu `Float`.** Die Regeln gelten also exakt, `Not(GreaterFloat(y))` ist über
Floats dasselbe wie `Or(y LessFloat(y))`. Heute kann ein `Float` zur Laufzeit trotzdem NaN sein:
`divideFloat` schließt zwar den Divisor 0 aus, aber `addFloat`/`subtractFloat` liefern NaN aus
`Infinity - Infinity` nach einem Überlauf, und Importe aus `.ts`/`.js` können NaN liefern. Das
auszuschließen steht in der `TODO` und ist nicht Teil dieses Plans.

Tests: `And(GreaterFloat(0f) LessFloat(1f))` gegen `GreaterFloat(-1f)`, Überlappung
`LessFloat(1f)` mit `GreaterFloat(0f)`, `GreaterFloat(0f)` gegen `GreaterInteger(0)` disjunkt.

### Phase 4: Anzeige

`typeToString` gibt einen lesbaren Bereich in der kürzesten Form aus, etwa `PositiveInteger` statt
`GreaterInteger(0)`, wo der Alias passt. Der Alias bleibt vorrangig, wenn einer geschrieben wurde.
Das erledigt auch den TODO-Punkt „And(Integer Greater(0)) als PositiveInteger wiedererkennen".

Hier fällt die Entscheidung, ob die Sicht reicht oder ein Knoten nötig wird: Wenn die Anzeige für
normalisierte Typen nicht mehr zuverlässig vom Original abzuleiten ist, lohnt der Knoten.

## Nicht Teil dieses Plans

- Inklusive Kurzformen (`AtLeast`, `AtMost`, `IntegerRange`), erst bei Bedarf in Nutzercode.
- Grenzen aus Aufrufen (`GreaterInteger(add(a 1))`) falten, siehe TODO „grenzen in der arithmetik".
- Grenzen für `Fraction`.
- Die Wertfunktion `greater` und ein Gegenstück `less`.
- Bereiche mit Löchern (`And(Integer Not(GreaterInteger(5)) Not(3))`) bleiben unlesbar.
