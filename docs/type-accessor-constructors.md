# Umsetzungsplan: Zugriffs-Typkonstruktor `ElementAt`

Umsetzung von Option D aus [core-lib-empty-return-types.md](core-lib-empty-return-types.md), in der
Variante **ein Knoten**. Dort steht das Warum; hier steht nur, was zu tun ist und in welcher
Reihenfolge.

## Ziel

`getElement` und `lastElement` verlieren ihren `case` in `getReturnTypeFromFunctionCall` und
deklarieren ihren Rückgabetyp in core-lib selbst:

```
getElement = nativeFunction(
	(values: Or([] List(Any)) index: PositiveInteger) :> ElementAt(TypeOf(values) index)
	…
lastElement = nativeFunction(
	(values: Or([] List(Any))) :> ElementAt(TypeOf(values) TypeOf(values)/Length)
	…
```

`lastElement` braucht dafür `Length` als Typ-Eigenschaft — deshalb steht es in Schritt 8 und nicht
im ersten Durchgang. Erreicht sein soll am Ende: der Checker kennt die Namen `getElement` und
`lastElement` nicht mehr, und Nutzercode kann dieselbe Präzision ausdrücken.

**Nicht in diesem Plan:** `map`s Tuple-Arity und `setElement` (brauchen „bilde jede Position ab",
eine andere Operation), bedingte Typen, Änderungen an der `/`-Syntax.

## Die Faltungsregel

Der Zugriffstyp hängt allein davon ab, was **beweisbar** ist:

| Lage | Ergebnis |
|---|---|
| Position beweisbar vorhanden (Literal-Index in bekanntem Tuple) | der Elementtyp, ohne `Empty` |
| Position beweisbar nicht vorhanden (`a/5` auf einem Zweituple) | `Empty` |
| nicht entscheidbar (nicht-literaler Index; oder List statt Tuple) | `Or([] …ElementTypes)` |

Das gilt für **beide** Erzeuger des Knotens. Der Unterschied zwischen `a/5` und `getElement(a 5)`
ist keine Typfrage, sondern eine Meldeentscheidung: `/` behauptet, dass die Position existiert, und
meldet `dereferenceFailed`, wenn das widerlegt ist; `getElement` meldet nicht, weil ein berechneter
Index legitim danebenliegen darf. Der Typ ist in beiden Fällen derselbe. Der Knoten braucht deshalb
**kein** Unterscheidungsfeld und keinen zweiten `julType`, und das `Any` nach einer Meldung bleibt,
wo es ist — als bewusstes „nach einem Fehler still sein" im eifrigen Pfad, nicht als Ergebnis der
Faltung.

### Zwei beabsichtigte Verhaltensänderungen

Beide korrigieren heutiges unsoundes bzw. zu grobes Verhalten und sind gewollt, nicht zu vermeiden:

1. **`a/2` auf `List(Integer)` liefert `Or([] Integer)` statt `Integer`.** Eine List kann ein
   Element haben; die zweite Position ist nicht beweisbar vorhanden. Das heutige `Integer` ist
   unsound. Kann im Bestand neue „Can not assign Empty"-Meldungen auslösen — Umfang misst Schritt 1.
2. **Literal-Index außerhalb eines bekannten Tuples liefert `Empty` statt der Union aller
   Positionen.** Betrifft `getElement`; entspricht dem TODO über der heutigen Deklaration in
   [core-lib.jul:447](../src/core-lib.jul#L447) („empty nur geliefert wird, wenn index >
   values.Length").

## Schritte

### 1. Regressionsnetz (grün, vor jeder Änderung)

Es gibt heute **keinen** Test für die Präzision von `getElement` und keinen für `/` auf einer List
([checker.test.ts](../src/checker.test.ts) enthält nur `a/2` in einem anderen Zusammenhang). Ohne
Netz ist nicht belegbar, was der Umbau erhält und was er absichtlich ändert. Zu erfassen ist das
heutige Verhalten, tabellengetrieben wie im Bestand — die beiden mit ▲ markierten Zeilen sind die
oben beschriebenen beabsichtigten Änderungen und werden in Schritt 5 bewusst umgeschrieben:

- `getElement` mit Literal-Index in ein Tuple → exakte Position, kein `Empty`
- ▲ `getElement` mit Literal-Index außerhalb → heute Union aller Positionen, künftig `Empty`
- `getElement` mit nicht-literalem Index → `Or([] …)`
- `getElement` auf `Or([] List(X))` → `Empty` bleibt drin
- `getElement` über eine Zwischenfunktion hinweg (generischer Parameter)
- `a/2` auf Tuple, außerhalb der Länge (`dereferenceFailed`)
- ▲ `a/2` auf List → heute `Integer`, künftig `Or([] Integer)`

Zusätzlich vor Schritt 5 einmal die Beispiele und das große Fremdprojekt durchlaufen lassen und die
Meldungen
festhalten: nur so ist danach unterscheidbar, ob eine neue `Empty`-Meldung die beabsichtigte
Korrektur ist oder ein Folgefehler.


Diese Tests bleiben bis zum Ende unverändert. Ändert sich einer, ist das eine bewusste
Entscheidung und keine Nebenwirkung.

### 2. Roter Test (die neue Fähigkeit)

Zwei Fälle, beide heute rot mit `ElementAt is not defined`:

```jul
# element-at-in-type-position
x: ElementAt([Integer Text] 2) = §a§
```
und derselbe mit `= 1`, der `Can not assign 1 to Text.` melden muss.

```jul
# element-at-in-user-function
second = (values: List(Any)) :> ElementAt(TypeOf(values) 2) => values.getElement(2)
x: Text = [1 §a§].second()
```

Der zweite ist der eigentliche Beleg: er ist heute nicht ausdrückbar, weil die Präzision am Namen
`getElement` hängt. Wie im Bestand mit vollständigem `errors`-Objekt.

### 3. Vorher-Messung

`npm run bench -- --save --note "vor <Umbau>"`. **Vor** der ersten Codeänderung, nicht danach:
ohne sie vergleicht die nächste Messung über zwei Änderungen hinweg. Die Faltung liegt im heißen
Pfad, ein Sprung ist zu erwarten und muss zuzuordnen sein.

Für Bisect zwischendurch reicht ein Einzeldurchlauf mit Ausgabe von `checkerStats` — Sekunden
statt Minuten. Der volle Bench nur fürs Protokoll.

### 4. Knoten erweitern

`NestedReferenceType.nestedKey` von `string | number` auf `string | number | CompileTimeType`
([syntax-tree.ts:839](../src/syntax-tree.ts#L839)). Der aufgelöste Fall behält die enge Form, jede
heutige Stelle bleibt gültig; neu zu behandeln ist nur der noch unaufgelöste dritte Fall in:

- `dereferenceNestedKeyFromObject` ([checker.ts:270](../src/checker.ts#L270)) — die Verzweigung
  nach Schlüsselart
- `typeToString` ([checker.ts:3563](../src/checker.ts#L3563))
- die Gleichheitsprüfung ([checker.ts:2447](../src/checker.ts#L2447)) — `first.nestedKey === second.nestedKey`
  trägt nicht mehr, sobald der Schlüssel ein Typ ist
- `resolvePlaceholders` ([checker.ts:760](../src/checker.ts#L760)) — Schlüssel **vor** der
  Dereferenzierung auflösen
- `isUnresolvedPlaceholderType` — auch ein unaufgelöster Schlüssel macht den Knoten unaufgelöst

### 5. Faltung umsetzen

Die Regel steht oben; hier die Zuordnung zum Code. Nach der Auflösung des Schlüssels:

- `integerLiteral` → `dereferenceIndexFromObject`, `textLiteral` → `dereferenceNameFromObject`
- liefert das `undefined` **und** kennt die Quelle ihre Form (`hasKnownLength`/`hasKnownFields`)
  → `Empty`, denn dann ist die Position beweisbar nicht vorhanden
- Schlüssel bleibt unaufgelöst oder Quelle kennt ihre Form nicht (List) → über alle Positionen bzw.
  Felder vereinigen, wie `getElementFromTypes` es im `case 'tuple'` tut
  ([checker.ts:1829](../src/checker.ts#L1829))
- Quelle unaufgelöst → Knoten stehen lassen

Der `/`-Ausdruck meldet zusätzlich `dereferenceFailed` im zweiten Fall — das bleibt im
`case 'nestedReference'` von `setInferredType`, wo es heute schon sitzt, und ist der einzige
Unterschied zwischen `/` und `ElementAt`.

Hier werden die beiden mit ▲ markierten Testzeilen aus Schritt 1 umgeschrieben.

### 6. Konstruktor und Abbau der Sonderfälle

`ElementAt` als `nativeFunction` in [core-lib.jul](../src/core-lib.jul) — strukturell wie `Not`
([core-lib.jul:44](../src/core-lib.jul#L44)), das seinen Knoten auch nur konstruiert. Der
Parametertyp `index: Integer` prüft den Schlüsselwert dabei von selbst mit, ohne dass die Faltung
etwas dazu tun muss.

Ein Pendant `FieldOf(source name: Text)` für berechnete **Feldnamen** braucht dieser Plan nicht —
alle drei umgestellten Funktionen greifen über einen Index zu. Es gehört zu `getField`, siehe
Folgearbeit unten.

Dann `getElement` in core-lib umdeklarieren und `case 'getElement'` samt `getElementFromTypes` aus
[checker.ts](../src/checker.ts#L1727) entfernen. Das Regressionsnetz aus Schritt 1 muss grün
bleiben.

### 7. Nachher-Messung

`npm run bench -- --save --note "nach <Umbau>"`, direkt nach Schritt 6 und vor allem Weiteren.
Bei einem Sprung erst die Ursache finden, dann weiterbauen — sonst mischt sich der nächste Schritt
in die Messung.

### 8. `Length` als Typ-Eigenschaft, dann `lastElement`

`lastElement` ist der Zugriff auf die letzte Position, braucht also die Länge als Typ. Die steckt
heute in `getLengthFromType` ([checker.ts:1884](../src/checker.ts#L1884)) hinter dem Namen `length`
und ist aus core-lib nicht erreichbar.

**Kein eigener Konstruktor und kein neuer Knoten.** Die Länge ist eine Eigenschaft des Typs, genau
wie `ElementType` — und `dereferenceNameFromObjectType` kennt `ElementType` für `tuple` und `list`
bereits ([checker.ts:1315](../src/checker.ts#L1315) ff.). `Length` kommt als weiterer Name daneben:
`tuple` → `integerLiteral` der Stelligkeit, `list` → `PositiveInteger`. Der `empty`-Fall (Länge `0`)
liegt heute in `getLengthFromType` und muss beim Umzug mitgenommen werden.

Damit sind beide Deklarationen schreibbar:

```
length      :> TypeOf(values)/Length
lastElement :> ElementAt(TypeOf(values) TypeOf(values)/Length)
```

Für ein Tuple faltet das zum exakten letzten Elementtyp, für eine List zum nicht entscheidbaren
Fall und damit zu `Or([] ElementType)` — beides deckt sich mit `getLastElementFromType`
([checker.ts:1862](../src/checker.ts#L1862)). Danach `case 'length'` und `case 'lastElement'`
entfernen.


### 9. Umbenennung (zuletzt)

`nestedReference` → `memberAccess`. Der alte Name stimmte, solange der Knoten nur entstand, wenn die
*Quelle* unaufgelöst war — eine aufgeschobene Referenz. Mit typwertigem Schlüssel kommt der Fall
„Quelle bekannt, Schlüssel unaufgelöst" dazu, und dann ist es keine Referenz mehr, sondern eine
Zugriffsoperation. `ElementAt` als Knotenname wäre zu eng: der Knoten trägt Index- *und*
Feldzugriff.

Rein mechanisch, rund 55 Stellen in [checker.ts](../src/checker.ts) und
[server.ts](../../jul-language-server/src/server.ts), Baselines unberührt, weil `typeToString`
weiter `source/key` ausgibt. Bewusst am Ende: der Umbau soll nicht in einem Umbenennungs-Diff
untergehen.

## Offene Punkte, die dieser Plan nicht löst

- **`getField` ist derselbe Fund für Feldnamen.** Sein Rückgabetyp ist
  `Or([] TypeOf(dictionary)/ElementType)` ([core-lib.jul:770](../src/core-lib.jul#L770)), also die
  Vereinigung aller Feldtypen, obwohl bei einem Literal-Schlüssel das genaue Feld bekannt wäre.
  Dafür ist `FieldOf(source name: Text)` da — derselbe Knoten, dieselbe Faltung, nur die andere
  Schlüsselart. Erst angehen, wenn dieser Plan durch ist.
- Schlüsselart passt nicht zum Quelltyp (Feldname auf List, Index in Dictionary) — Punkt 12 in
  [CHECKER-AUDIT.md](CHECKER-AUDIT.md). Die Faltung muss das prüfen, ist aber ein eigener Fall:
  dort ist der Zugriff nicht „nicht vorhanden", sondern gar nicht anwendbar.

## Verifikation nach jedem Schritt

Wie in [CHECKER-AUDIT.md](CHECKER-AUDIT.md#verifikation-nach-jedem-schritt): Checker-Tests,
`typecheck`, `npm test`, `build`, danach die Beispiele bauen und der Yugioh-Durchlauf. Zusätzlich
`npm run bench -- --save` als eigene Schritte 3 und 7, weil die Faltung im heißen Pfad liegt.
