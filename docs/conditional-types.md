# Bedingte Typen: `:?`

Ziel: `add` und `subtract` in der core-lib liefern für Integer-Argumente `Integer` statt
`Rational`. Damit entfallen `addInteger` und `subtractInteger` ersatzlos. `subtractFloat` und
`maxInteger` bleiben (Float ist kein Rational, `max` braucht den Elementtyp eines Tuples, siehe
unten).

Prinzip dahinter: [design-principles.md](design-principles.md), „Keine Magie für Typen“. Das
Never-Idiom (`SumType` in `jul-examples/test1.jul`) trägt für `subtract`, aber nicht für
variadische Funktionen: `TypeOf(args)` ist dort ein Tuple, und `And`/`Or` behalten die Form ihrer
Eingabe, aus einem Tuple wird nie ein Skalar.

## Zielbild

```jul
add = nativeFunction(
	(...args: List(Rational))
		->
			:?(TypeOf(args))
				[List(Integer)] => Integer
				() => Fraction
	§js … §
)
subtract = nativeFunction(
	(minuend: Rational subtrahend: Rational)
		->
			:?(TypeOf(minuend) TypeOf(subtrahend))
				[Integer Integer] => Integer
				() => Fraction
	§js … §
)
```

| Aufruf | Ergebnis |
|---|---|
| `subtract(Integer Integer)` | `Integer` |
| `subtract(Fraction Integer)` | `Fraction` |
| `subtract(Rational Integer)` | `Or(Integer Fraction)` |
| `add(Integer Integer Integer)` | `Integer` |
| `add(Integer Fraction)` | `Fraction` |
| `add(Integer Rational)` | `Or(Integer Fraction)` |
| `add(...xs)` mit `xs: List(Rational)` | `Or(Integer Fraction)` |
| `add(2 3)` | `5` (constant folding wie bisher bei `addInteger`) |

## Semantik

`:?(Operanden)` bildet wie `?` eine Argumentkollektion aus **Typen** und prüft sie der Reihe
nach gegen die Köpfe der Zweige. Pro Zweig gibt es drei Fälle:

| Kollektion ↔ Kopf | Wirkung |
|---|---|
| Teilmenge | Ergebnis des Zweigs aufnehmen, fertig |
| disjunkt (Schnitt ist `Never`) | Zweig überspringen |
| überlappend | Ergebnis des Zweigs aufnehmen, weiter mit dem nächsten Zweig |

Das Ergebnis ist die Union der aufgenommenen Zweig-Ergebnisse.

- Die Teilmenge wird geprüft, nicht die Zuweisbarkeit eines Werts. Sonst fiele `PositiveInteger`
  an `Integer` vorbei in den catchAll.
- Der Überlappungsfall ersetzt das „über Unions verteilen“ aus dem TODO. Er ist nötig, weil sich
  Unions innerhalb eines Tuples (`[Integer Rational]`) oder in `List(Rational)` nicht auf oberster
  Ebene verteilen lassen. Ohne ihn landen diese Fälle im catchAll und liefern fälschlich
  `Fraction`, also einen falschen und nicht bloß ungenauen Typ.
- Ein Typ, der noch Platzhalter enthält, bleibt als Knoten stehen, bis die Argumente bekannt sind.
  Wird er vorher gebraucht (Anzeige, Prüfung), löst `resolvePlaceholders` die Platzhalter wie
  überall über ihre Deklaration auf (`TypeOf(a)` mit `a: Rational` wird zu `Rational`), und
  danach wird normal ausgewertet. Was dann noch unbekannt ist, wird `Any`. `Any` überlappt jeden
  Kopf, ohne Teilmenge zu sein, und ergibt damit von selbst die Union aller Zweig-Ergebnisse, nie
  „passt nicht“. Einen Sonderfall braucht es dafür nicht.

## Umsetzung

### 1. Typknoten `conditional` (syntax-tree.ts)

Neuer `CompileTimeConditionalType` mit `Operands: CompileTimeType[]` und
`Branches: { Head: CompileTimeType; Result: CompileTimeType }[]`,
`isUnresolvedPlaceholder: true`. Vorlage ist `withElementAt`, das genauso wartet, bis seine
Eingaben feststehen.

### 2. Auswertung (checker.ts)

- `createConditionalType(operands, branches)`: sind alle Operanden frei von Platzhaltern, wird
  sofort nach den drei Fällen oben ausgewertet, sonst entsteht der Knoten.
- Teilmenge über `getTypeError(undefined, kollektion, kopf)`, disjunkt über
  `createNormalizedIntersectionType([kollektion, kopf])` = `Never`, dazu die Verlässlichkeit
  aus `hasReliableTypeError`, damit eine unbestimmte Bedingung nicht vorzeitig wegfällt (dasselbe
  Problem, das beim Never-Idiom schon einmal aufgetreten ist).
- `traversePlaceholders`: Fall `conditional` löst die Operanden auf und ruft
  `createConditionalType` neu auf. Darüber greift der Mechanismus, der `SumType(TypeOf(a) …)`
  heute am Aufruf konkret macht (`dereferenceArgumentTypesNested`), ohne weitere Änderung.
- Ohne Argumentkontext (`resolvePlaceholders`) läuft derselbe Fall: Die Operanden werden über
  ihre Deklaration aufgelöst, dann wird ausgewertet. Daher kommt das Verhalten für Hover
  (Frage 9) und Rumpfprüfung (Frage 11), und `(x: PositiveInteger) => subtract(x 1)` wird
  präzise `Integer`, nicht die Union.
- **Spread in Rest-Parameter:** Bei `add(...ys)` mit `ys: List(Integer)` liefert
  `dereferenceParameterFromArgumentType` heute `Any` für `TypeOf(args)`, weil
  `getAllArgTypes` nur Tuples kennt (nachgemessen: `g(...ys)` mit `-> TypeOf(xs)` ergibt `Any`).
  Mit `:?` gäbe das `Or(Integer Fraction)`, `addInteger(...ys)` liefert heute aber `Integer`.
  Beim Ablösen wäre das eine Regression. Fix: Ist der Rest-Parameter der einzige Parameter und
  das Argument eine List ohne Präfix, ist der Rest-Typ diese List.
- Alle übrigen `switch (julType)` bekommen den Fall (der Compiler meldet sie über den
  `never`-Check): `typeToString`, `getTypeError`, Normalisierung, Language-Server-Hover.

### 3. Parser

`:?` als Präfix-Token neben `?`, in `valueExpressionBaseParser` vor der simpleExpression.
`branchingParser` wird mit dem Token parametrisiert und erzeugt für `:?` den eigenen AST-Knoten
`typeBranching` (Frage 7). Die Zweige bleiben Funktionsliterale.
`:?` steht als Rückgabetyp immer im Block unter einem umgebrochenen Rückgabepfeil
([multiline-function-head.md](multiline-function-head.md)). Der Typblock endet an der Einrückung,
also vor dem nächsten Argument (`§js`). Im Typblock kennt der Parser `:?` noch nicht, das Token
kommt dort mit diesem Schritt hinzu. In der Kopfzeile hinter dem Pfeil (`-> :?(…)`) erkennt er es
schon und meldet JUL1107.

### 4. Checker-Fall für den AST-Knoten

Die Operanden werden inferiert und per `valueOf` zu Typen gemacht, die Köpfe der Zweige genauso.
Die Rümpfe werden inferiert und ebenfalls per `valueOf` ausgepackt, genau wie der Ausdruck
hinter `->` ([checker.ts](../src/checker/checker.ts), `functionType.ReturnType =
valueOf(inferredReturnType)`). Eine eigene Prüfung „Zweig liefert keinen Typ“ gibt es nicht, weil
jeder Wert sein eigener Singleton-Typ ist. Daraus entsteht `createConditionalType`, und der
Ausdruck hat den Typ `TypeOf(<conditional>)`, analog zu `And` in
`getReturnTypeFromFunctionCall`.

Neue Fehlercodes in `compiler-errors.ts`, samt Eintrag in `errorInfos` und Abschnitt in
`jul-homepage/docs/docs/documentation/error-codes.md`:

| Code | Name | Wann |
|---|---|---|
| JUL5153 | `typeBranchingOutsideReturnType` | `:?` steht nicht als Rückgabetyp (Frage 5) |
| JUL5154 | `typeBranchHeadBinding` | ein Zweig-Kopf bindet einen Namen (`(x: Integer) => …`) |

Die Zweige laufen als Funktionsliterale durch die normale Inferenz: `ParamsType` ist der Kopf,
`valueOf(ReturnType)` das Ergebnis. Weil ihr `parent` kein `branching` ist, greifen das
Narrowing, `getPredicateFacts` und die Unreachable-Prüfung von `?` nicht. Eine Bindung im Kopf
(`(x: Integer) => …`) ist im MVP ein Fehler, damit sie für ihre Bedeutung auf Typebene frei
bleibt (siehe Ausbaustufen).

Weitere Stellen, die der `never`-Check für den neuen Knoten meldet: `forEachChild`, den
Purity-Walk (`:?` ist immer rein), den Emitter (Fehlerfall, nie emittiert) und im Language
Server die DocumentSymbols und den zweiten Switch in `server.ts`.

### 5. Emitter und Runtime

Der Emitter gibt Rückgabetypen nicht aus. Im MVP ist `:?` deshalb **nur im Rückgabetyp**
erlaubt, anderswo gibt es einen Checker-Fehler. Ein allgemeines `:?` ist eine spätere
Ausbaustufe.

### 6. core-lib

- `add` und `subtract` wie im Zielbild.
- `addInteger` und `subtractInteger` aus `core-lib.jul` und `runtime.ts` entfernen.

### 7. Migration

| Ort | Stellen |
|---|---|
| `C:\Projects\privat\yugioh\src\game-logic\game-logic.jul` | 16 Aufrufe (`.addInteger(`, `.subtractInteger(`) |
| `jul-homepage/docs/docs/documentation/handbook.md:88` | `myAdd`-Beispiel |
| `src/checker/checker.test.ts` | Folding- und Purity-Tests auf `addInteger` (3224, 3532–3589, 3689) |
| `src/runtime.test.ts:331-338` | `_callFunction(addInteger …)` |

Es ist eine reine Umbenennung ohne Syntaxänderung, ein Migrationsskript unter `scripts/` braucht
es nicht. Abnahme: yugioh checkt mit dem neuen Compiler fehlerfrei, und die Stellen, die
`Integer` erwarten (`slice`, `lifePoints`), bekommen es weiterhin.

### Reihenfolge und Tests

1. `npm run bench -- --save --note "vor :?"` (Compiler und LSP).
2. Rote Tests, tabellengetrieben in `checker.test.ts`: alle Zeilen der Tabelle im Zielbild,
   dazu `PositiveInteger`, Platzhalter im generischen Kontext und `add()` ohne Argumente (bleibt JUL5050).
   Außerdem eine eigene Funktion mit `-> :?(…)`: Ihr Rumpf wird gegen die Union geprüft, und am
   Aufruf wird ihr Rückgabetyp aufgelöst (Frage 11).
   Anhalten und den roten Zustand zeigen.
3. Typknoten und Auswertung (Schritte 1, 2), zuerst über einen Unit-Test direkt auf
   `createConditionalType`, noch ohne Parser.
4. Parser und Checker-Fall (Schritte 3, 4).
5. core-lib umstellen, Integer-Varianten entfernen, Tests und Handbuch migrieren.
6. `npm test`, `npm run typecheck`, `npm run test-update-snapshot`, die Änderungen an der
   Baseline durchsehen. Im LSP `test-snapshot`, Hover auf `add` prüfen.
7. yugioh migrieren und checken, danach `bench --save --note "nach :?"`.
8. TODO: den Eintrag zu bedingten Typen auf den Stand bringen, auch die Aussage „variadisch
   nicht erreichbar“ für `add` korrigieren.

## Offene Fragen

1. ~~**Syntax oder Typfunktion?**~~ Entschieden: `:?` als Syntax. Eine Typfunktion bräuchte
   Funktionsliterale als Argumente und läse sich nicht besser als das Never-Idiom. Die Syntax
   verwendet den Parser von `?` wieder.
2. ~~**Typkonstruktor oder auswählendes `?`?**~~ Entschieden: Typkonstruktor (A), das auswählende
   `?` (B) ist eine spätere Option, siehe unten. Unter A werden die Zweig-Ergebnisse mit `valueOf`
   ausgepackt, vereinigt und einmal in `TypeOf` gewickelt, wie bei `And`. Ein Zweig-Ergebnis
   wird dabei gelesen wie der Ausdruck hinter `->`. `=> §ganz§` ist also der Literaltyp
   `§ganz§`, genau wie `-> §ganz§`, und braucht keine eigene Fehlermeldung. B dagegen wäre die
   Union der Rumpftypen wie bei `?`, also
   `Or(TypeOf(Integer) TypeOf(Fraction))`. Daran scheitert der Rückgabetyp, weil `valueOf`
   bewusst nicht in `or` absteigt.
3. ~~**Überlappungsregel wie oben?**~~ Keine Wahl, sondern Voraussetzung für Korrektheit. Die
   einzige Alternative behandelt eine Überlappung wie „passt nicht“ und liefert dann falsche
   Typen: `:?(Rational)` mit `[Integer] => Integer` und `() => Fraction` ergäbe `Fraction`,
   obwohl `5` ein Rational ist. `add` ließe sich damit nur retten, wenn der catchAll von Hand
   `Rational` liefert. Die Korrektheit hinge dann an der Sorgfalt des Autors, und
   `add(Integer Fraction)` verlöre `Fraction`.
4. ~~**Wird nach einer Überlappung der Rest abgezogen?**~~ Entschieden: im MVP nicht. Für
   `add`/`subtract` reicht das, weil der zweite Zweig ohnehin der catchAll ist. Das Abziehen ist
   als spätere Ausbaustufe vorgemerkt, siehe unten.
5. ~~**Wo ist `:?` erlaubt?**~~ Entschieden: vorerst nur im Rückgabetyp, anderswo ist es ein
   Checker-Fehler. Dort braucht es weder Emitter noch Runtime, und nur dort bleibt ein späterer
   Wechsel auf B folgenlos (Frage 2). Das Lockern ist eine optionale Ausbaustufe, siehe unten.
6. ~~**Was gilt, wenn kein Zweig greift?**~~ Entschieden für den MVP: still. Ein Wert, den kein
   Zweig trifft, trägt nichts bei, im Extremfall ist das Ergebnis `Never`. Es gibt keine
   Diagnose und keine catchAll-Pflicht. Wie es später weitergeht, ist noch offen, siehe
   Ausbaustufen.
7. ~~**AST-Knoten: `branching` mit Kennzeichen oder eigener Typ?**~~ Entschieden: eigener Typ
   `typeBranching`, die Zweige bleiben Funktionsliterale. `?` prüft, ob ein Wert im Kopf liegt,
   `:?` prüft, ob ein Typ Teilmenge des Kopfs ist. Mit einem Kennzeichen müsste jede Stelle, die
   `branching` prüft, zusätzlich das Kennzeichen abfragen. Das betrifft das Narrowing, die
   Prädikate, `_branch` und die Unreachable-Prüfung, und der `never`-Check fände eine vergessene
   Abfrage nicht. Sonst verengte das Narrowing einen Typ-Operanden `A` zu „A ist ein
   Integer-Wert“. Der eigene Typ kostet etwa acht Stellen, überwiegend einzeilig, und die meldet
   der Compiler. Geteilt werden Funktionen (Parser, später die Abdeckungsrechnung), nicht der
   Knoten.
8. ~~**Wird `add()` ohne Argumente gebraucht?**~~ Geklärt: `add()` und `multiply()` sind schon
   heute JUL5050 („Can not assign Empty to List(Rational)“). Der Kopf `[List(Integer)]` reicht,
   `Empty` braucht keinen Zweig.
9. ~~**Anzeige.**~~ Entschieden: Der Hover auf das Symbol zeigt die aufgelöste Union
   (`add: (...args: List(Rational)) -> Or(Integer Fraction)`), nicht die `:?`-Zweige. Das ist
   lesbarer, und die Zweige helfen einem Aufrufer nicht. Den genauen Typ sieht er am Aufruf. So
   werden heute schon alle offenen Signaturen angezeigt (`getElement -> Any`,
   `setElement -> List(Any)`, der Hover löst per `resolvePlaceholders` auf). Schritt 2 bleibt
   deshalb, wie er ist. Zu prüfen ist dabei, ob der Alias-Name erhalten bleibt. Der Hover auf
   `mySubtract` in `jul-examples/test1.jul` schreibt `Fraction` heute als
   `[numerator: Integer denominator: Integer]` aus.
10. ~~**`multiply` gleich mit?**~~ Entschieden: spätere Ausbaustufe, siehe unten.
11. ~~**Wie wird der Rumpf einer eigenen Funktion mit `-> :?(…)` geprüft?**~~ Entschieden: gegen
    die Union aller Zweige, ohne zusätzlichen Code. Der Fall `functionLiteral` prüft den Rumpf
    schon heute gegen `resolvePlaceholders(deklariert)`. Ist der deklarierte Typ ein offener
    Platzhalter, behält er ihn als Rückgabetyp und löst ihn je Aufruf neu auf. `conditional`
    fällt da hinein, genau wie heute `SumType` und `Concat(TypeOf(a) TypeOf(b))`. Ein Test
    sichert das ab. Die Prüfung ist dafür großzügig: Ein Rumpf `=> 1/2` gegen
    `[Integer Integer] => Integer` und `() => Fraction` geht durch, weil `Fraction` in der Union
    liegt. Genauer geht es mit der Prüfung je Zweig, siehe Ausbaustufen.

## Spätere Ausbaustufen

- **`multiply`:** Es hat dieselbe Form wie `add` (`(...args: List(Rational)) -> Rational`) und
  bekommt denselben Rückgabetyp `:?(TypeOf(args))` mit `[List(Integer)] => Integer` und
  `() => Fraction`. Eine `multiplyInteger` gibt es nicht zu entfernen, der Gewinn liegt allein
  im genaueren Typ an den Aufrufstellen. `divide` bleibt außen vor, Integer durch Integer
  ergibt Fraction.
- **Rest nach einer Überlappung abziehen:** Statt mit der ganzen Kollektion wird mit
  `Without(kollektion kopf)` weitergeprüft. Ohne Abziehen ist das Ergebnis korrekt, kann aber
  zu weit sein, weil unerreichbare Zweige mitgezählt werden:

  ```jul
  :?(Rational)
  	[Integer] => A
  	[Fraction] => B
  	() => C
  ```

  Ohne Abziehen ergibt das `Or(A B C)`, mit Abziehen `Or(A B)`: Nach `[Integer]` bleibt
  `Fraction` übrig, das ist eine Teilmenge von `[Fraction]`, und `()` wird nicht mehr
  erreicht. Voraussetzung ist ein belastbarer Schnitt mit Komplement auch für Tuples und Lists
  (`[Rational Integer]` ohne `[Integer Integer]` ergibt `[Fraction Integer]`). Ist der Rest
  `Never`, sind alle folgenden Zweige unerreichbar. Das ist dieselbe Rechnung wie bei der
  Exhaustiveness von `?` (Frage 6) und sollte mit ihr zusammen umgesetzt werden.
- **Auswählendes `?` (B) statt Typkonstruktor (A):** Der Typ von `:?` wäre dann die Union der
  gewählten Rumpftypen. Die Laufzeitsemantik wäre dann genau: Zur Laufzeit greift immer genau
  ein Zweig. A fasst die Zweige dagegen zu einem Typwert zusammen, den es zur Laufzeit nie gibt.
  Für Literal-Ergebnisse (`[Integer] => §ganz§`) unterscheiden sich A und B nicht, weil ein
  Wert zugleich sein eigener Singleton-Typ ist. Einen Unterschied gibt es nur, wenn die Zweige
  Typen liefern.

  Der Wechsel bricht keinen bestehenden Code, solange `:?` nur im Rückgabetyp steht (Frage 5).
  Dort wird der Ausdruck ohnehin zu seiner Wertemenge ausgepackt, und die ist unter A und B
  gleich. Voraussetzung ist, dass dieses Auspacken für `conditional` die Union der `TypeOf`
  auflöst. Das muss lokal geschehen, nicht durch eine Änderung von `valueOf`, das bewusst nicht
  in `or` absteigt. Ohne diese Einschränkung würde der Wechsel die Bedeutung von
  `T = :?(…)` ändern: aus dem einen Typwert `Or(Integer Fraction)` würde „`Integer` oder
  `Fraction`“.

  B gehört deshalb mit dem Lockern von Frage 5 zusammen. Wer `:?` außerhalb des Rückgabetyps
  erlaubt, sollte vorher auf B wechseln, sonst entsteht Code, dessen Bedeutung sich später
  ändert.
- **`:?` außerhalb des Rückgabetyps (optional):** Das betrifft etwa einen benannten Hilfstyp
  `DifferenceType = (A: Type B: Type) => :?(A B) …` oder `T = :?(…)`. Solcher Code wird
  emittiert und braucht eine Runtime-Implementierung, einen Helfer neben `_branch`, der die
  Zweig-Köpfe per Teilmengenprüfung auf `RuntimeType` gegen die Operanden prüft. Zur Laufzeit
  sind die Operanden meist Singleton-Typen (`TypeOf(5)`), dann greift genau ein Zweig. Setzt
  den Wechsel auf B voraus, siehe dort. Lohnt sich erst, wenn ein Hilfstyp an mehreren Stellen
  gebraucht wird. Für `add` und `subtract` reicht der Rückgabetyp.
- **Bindung im Kopf (Typebene):** In `(x: List(Integer)) => x` wäre `x` der Operandentyp,
  geschnitten mit dem Kopf, also `And(A List(Integer))`, und nicht wie bei `?` ein Wert. Das
  entspricht `infer` in TypeScript und ist der Weg zu einem `ElementType` und damit zu `max`/`min`
  (`maxInteger` entfällt dann). Außer der Bindung braucht es dafür noch einen Zugriff auf den
  Elementtyp. Umgesetzt wird es in der eigenen Logik von `typeBranching`, nicht über das Narrowing
  von `?`.
- **Diagnose für nicht abgedeckte Fälle (offene Frage):** Im MVP bleibt ein fehlender Treffer
  still. Bekanntes Risiko ist der Teiltreffer: Ohne catchAll ergibt `(a: Rational) -> :?(TypeOf(a))`
  mit nur `[Integer] => Integer` das Ergebnis `Integer`, denn die Überlappung wird aufgenommen und
  die Fraction-Werte fallen still heraus. Das ist ein falscher, plausibel aussehender Typ. Bei
  `nativeFunction` fällt er erst zur Laufzeit auf. Optionen:
  - **catchAll-Pflicht:** Der letzte Zweig muss `()` oder `Any` sein. Das ist billig und immer
    korrekt, erzwingt aber einen sinnlosen Zweig, wenn die Köpfe ohnehin alles abdecken.
  - **Abdeckungsprüfung an der Definition:** Geprüft wird, ob der deklarierte Operandentyp
    Teilmenge von `Or(alle Köpfe)` ist. Das ist präzise, braucht aber dieselbe Tuple-Algebra wie
    „Rest abziehen“ und die Exhaustiveness von `?`, und alle drei sollten zusammen kommen.
  - **Fehler am Aufruf:** So lösen es Scala (match types) und Haskell (closed type families).
    Der Fehler landet dabei beim Nutzer statt beim Autor, und `traversePlaceholders` bräuchte
    einen Fehlerkanal.

  Jede dieser Optionen verschärft nachträglich und bricht damit Code ohne catchAll, der bis dahin
  entstanden ist. Bis zur Entscheidung sollte die core-lib deshalb immer einen catchAll schreiben.
- **Rumpf je Zweig prüfen:** Statt gegen die Union aller Zweige wird der Rumpf je Zweig
  geprüft, mit den Parametern auf dessen Kopf verengt. Für `[Integer Integer] => Integer` gilt
  der Rumpf dann mit `a: Integer b: Integer` und muss `Integer` liefern. Das fängt `=> 1/2` ab,
  das heute gegen `Or(Integer Fraction)` durchgeht. Die Verengung auf Typebene ist dieselbe wie
  bei der Bindung im Kopf, beide gehören deshalb zusammen. Schwierig wird es, wenn die Operanden
  keine direkten Parameterreferenzen sind (`TypeOf(a/x)`, `LengthOf(values)`): Dann lässt sich
  der Kopf nicht auf einen Parameter zurückführen. An dieser Stelle braucht TypeScript Casts.
  Ein solcher Zweig wird dann weiterhin gegen die Union geprüft.
