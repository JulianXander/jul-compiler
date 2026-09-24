# Bedingte Typen: `:?`

`add`, `subtract` und `multiply` in der core-lib liefern für Integer-Argumente `Integer` statt
`Rational`.
Damit sind `addInteger` und `subtractInteger` ersatzlos entfallen. `subtractFloat` und
`maxInteger` bleiben (Float ist kein Rational, `max` braucht den Elementtyp eines Tuples, siehe
unten). `:?` ist nur als Rückgabetyp erlaubt (Frage 5).

Prinzip dahinter: [design-principles.md](design-principles.md), „Keine Magie für Typen“. Das
Never-Idiom (`SumType` in `jul-examples/test1.jul`) trägt für `subtract`, aber nicht für
variadische Funktionen: `TypeOf(args)` ist dort ein Tuple, und `And`/`Or` behalten die Form ihrer
Eingabe, aus einem Tuple wird nie ein Skalar.

## core-lib

```jul
add = nativeFunction(
	(...args: List(Rational))
		->
			:?(TypeOf(args))
				[List(Integer)] => Integer
				() => Rational
	§js … §
)
multiply = nativeFunction(
	(...args: List(Rational))
		->
			:?(TypeOf(args))
				[List(Integer)] => Integer
				() => Rational
	§js … §
)
subtract = nativeFunction(
	(minuend: Rational subtrahend: Rational)
		->
			:?(TypeOf(minuend) TypeOf(subtrahend))
				[Integer Integer] => Integer
				[Integer Fraction] => Fraction
				[Fraction Integer] => Fraction
				() => Rational
	§js … §
)
```

Der catchAll liefert `Rational`, nicht `Fraction`: Zwei Fractions können einen Integer ergeben
(`1/2 + 1/2`, `1/2 - 1/2`), bei `multiply` schon eine einzige (`2 * 1/2`). Sicher eine Fraction
ist das Ergebnis nur bei `add` und `subtract` mit genau einer Fraction unter Integern. `subtract` zählt diese Fälle auf, `add` kann das nicht, denn ein Tuple-Kopf nennt
nur Mindestpositionen: `[Integer Fraction]` passte auch auf `[Integer Fraction Fraction]`. Dass der
Wert zum Typ passt, hängt daran, dass die Implementierungen in `runtime.ts` normalisieren
(`normalizeRational`): `1/2 + 1/2` ergibt `1n`, nicht `{numerator: 2, denominator: 2}`.

| Aufruf | Ergebnis |
|---|---|
| `subtract(Integer Integer)` | `Integer` |
| `subtract(Fraction Integer)` | `Fraction` |
| `subtract(Fraction Fraction)` | `Rational` |
| `subtract(Rational Integer)` | `Rational` |
| `add(Integer Integer Integer)` | `Integer` |
| `add(Integer Fraction)` | `Rational` |
| `add(Integer Rational)` | `Rational` |
| `add(...xs)` mit `xs: List(Rational)` | `Rational` |
| `add(2 3)` | `5` (constant folding) |
| `add(0.5 0.5)` | `1` |
| `multiply(Integer Integer)` | `Integer` |
| `multiply(Integer Fraction)` | `Rational` |

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
- Der Überlappungsfall ersetzt ein Verteilen über Unions. Er ist nötig, weil sich
  Unions innerhalb eines Tuples (`[Integer Rational]`) oder in `List(Rational)` nicht auf oberster
  Ebene verteilen lassen. Ohne ihn landen diese Fälle im catchAll und liefern fälschlich
  `Fraction`, also einen falschen und nicht bloß ungenauen Typ.
- Ein Typ, der noch Platzhalter enthält, bleibt als Knoten stehen, bis die Argumente bekannt sind.
  Wird er vorher gebraucht (Anzeige, Prüfung), löst `resolvePlaceholders` die Platzhalter wie
  überall über ihre Deklaration auf (`TypeOf(a)` mit `a: Rational` wird zu `Rational`), und
  danach wird normal ausgewertet. Was dann noch unbekannt ist, wird `Any`. `Any` überlappt jeden
  Kopf, ohne Teilmenge zu sein, und ergibt damit von selbst die Union aller Zweig-Ergebnisse, nie
  „passt nicht“. Einen Sonderfall braucht es dafür nicht.

## Entscheidungen

1. **Syntax oder Typfunktion?** `:?` als Syntax. Eine Typfunktion bräuchte
   Funktionsliterale als Argumente und läse sich nicht besser als das Never-Idiom. Die Syntax
   verwendet den Parser von `?` wieder.
2. **Typkonstruktor oder auswählendes `?`?** Typkonstruktor (A), das auswählende
   `?` (B) ist eine spätere Option, siehe unten. Unter A werden die Zweig-Ergebnisse mit `valueOf`
   ausgepackt, vereinigt und einmal in `TypeOf` gewickelt, wie bei `And`. Ein Zweig-Ergebnis
   wird dabei gelesen wie der Ausdruck hinter `->`. `=> §ganz§` ist also der Literaltyp
   `§ganz§`, genau wie `-> §ganz§`, und braucht keine eigene Fehlermeldung. B dagegen wäre die
   Union der Rumpftypen wie bei `?`, also
   `Or(TypeOf(Integer) TypeOf(Fraction))`. Daran scheitert der Rückgabetyp, weil `valueOf`
   bewusst nicht in `or` absteigt.
3. **Überlappungsregel wie oben?** Keine Wahl, sondern Voraussetzung für Korrektheit. Die
   einzige Alternative behandelt eine Überlappung wie „passt nicht“ und liefert dann falsche
   Typen: `:?(Rational)` mit `[Integer] => Integer` und `() => Fraction` ergäbe `Fraction`,
   obwohl `5` ein Rational ist. Richtig bliebe es nur, wenn jeder catchAll von Hand die
   ganze Restmenge liefert. Die Korrektheit hinge dann an der Sorgfalt des Autors.
4. **Wird nach einer Überlappung der Rest abgezogen?** Im MVP nicht. Für
   `add`/`subtract` reicht das, weil der zweite Zweig ohnehin der catchAll ist. Das Abziehen ist
   als spätere Ausbaustufe vorgemerkt, siehe unten.
5. **Wo ist `:?` erlaubt?** Vorerst nur im Rückgabetyp, anderswo ist es ein
   Checker-Fehler. Dort braucht es weder Emitter noch Runtime, und nur dort bleibt ein späterer
   Wechsel auf B folgenlos (Frage 2). Das Lockern ist eine optionale Ausbaustufe, siehe unten.
6. **Was gilt, wenn kein Zweig greift?** Still. Ein Wert, den kein
   Zweig trifft, trägt nichts bei, im Extremfall ist das Ergebnis `Never`. Es gibt keine
   Diagnose und keine catchAll-Pflicht. Wie es später weitergeht, ist noch offen, siehe
   Ausbaustufen.
7. **AST-Knoten: `branching` mit Kennzeichen oder eigener Typ?** Eigener Typ
   `typeBranching`, die Zweige bleiben Funktionsliterale. `?` prüft, ob ein Wert im Kopf liegt,
   `:?` prüft, ob ein Typ Teilmenge des Kopfs ist. Mit einem Kennzeichen müsste jede Stelle, die
   `branching` prüft, zusätzlich das Kennzeichen abfragen. Das betrifft das Narrowing, die
   Prädikate, `_branch` und die Unreachable-Prüfung, und der `never`-Check fände eine vergessene
   Abfrage nicht. Sonst verengte das Narrowing einen Typ-Operanden `A` zu „A ist ein
   Integer-Wert“. Der eigene Typ kostet etwa acht Stellen, überwiegend einzeilig, und die meldet
   der Compiler. Geteilt werden Funktionen (Parser, später die Abdeckungsrechnung), nicht der
   Knoten.
8. **Wird `add()` ohne Argumente gebraucht?** `add()` und `multiply()` sind schon
   heute JUL5050 („Can not assign Empty to List(Rational)“). Der Kopf `[List(Integer)]` reicht,
   `Empty` braucht keinen Zweig.
9. **Anzeige.** Der Hover auf das Symbol zeigt die aufgelöste Union
   (`add: (...args: List(Rational)) -> Rational`), nicht die `:?`-Zweige. Das ist
   lesbarer, und die Zweige helfen einem Aufrufer nicht. Den genauen Typ sieht er am Aufruf. So
   werden heute schon alle offenen Signaturen angezeigt (`getElement -> Any`,
   `setElement -> List(Any)`, der Hover löst per `resolvePlaceholders` auf).
10. **`multiply` gleich mit?** Zunächst zurückgestellt, dann mit derselben Form wie `add`
    nachgezogen.
11. **Wie wird der Rumpf einer eigenen Funktion mit `-> :?(…)` geprüft?** Gegen
    die Union aller Zweige, ohne zusätzlichen Code. Der Fall `functionLiteral` prüft den Rumpf
    schon heute gegen `resolvePlaceholders(deklariert)`. Ist der deklarierte Typ ein offener
    Platzhalter, behält er ihn als Rückgabetyp und löst ihn je Aufruf neu auf. `conditional`
    fällt da hinein, genau wie heute `SumType` und `Concat(TypeOf(a) TypeOf(b))`. Ein Test
    sichert das ab. Die Prüfung ist dafür großzügig: Ein Rumpf `=> 1/2` gegen
    `[Integer Integer] => Integer` und `() => Fraction` geht durch, weil `Fraction` in der Union
    liegt. Genauer geht es mit der Prüfung je Zweig, siehe Ausbaustufen.

## Spätere Ausbaustufen

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
