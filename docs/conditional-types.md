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
	(...args: List(Rational)) -> :?(TypeOf(args))
		[Or([] List(Integer))] => Integer
		() => Fraction
	§js … §
)
subtract = nativeFunction(
	(minuend: Rational subtrahend: Rational) -> :?(TypeOf(minuend) TypeOf(subtrahend))
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
  Wird er vorher gebraucht (Anzeige, Prüfung), gilt er als überlappend mit jedem Zweig. Damit
  ergibt sich die Union aller Zweig-Ergebnisse, nie „passt nicht“.

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
- `resolvePlaceholders` ohne Argumentkontext liefert die Union aller Zweig-Ergebnisse.
- Alle übrigen `switch (julType)` bekommen den Fall (der Compiler meldet sie über den
  `never`-Check): `typeToString`, `getTypeError`, Normalisierung, Language-Server-Hover.

### 3. Parser

`:?` als Präfix-Token neben `?`, in `valueExpressionBaseParser` vor der simpleExpression.
`branchingParser` wird mit dem Token parametrisiert, der AST-Knoten bekommt ein Kennzeichen
(`type: 'branching'` mit `kind: 'type'` oder eigener Typ `typeBranching`, siehe Fragen).
Nachzuweisen ist, dass ein mehrzeiliger Ausdruck im Rückgabetyp hinter `->` und vor dem
nächsten Argument (`§js`) sauber endet. Einen eingerückten Block an dieser Stelle gibt es heute
noch nicht.

### 4. Checker-Fall für den AST-Knoten

Die Operanden werden inferiert und per `valueOf` zu Typen gemacht, die Köpfe der Zweige genauso.
Die Rümpfe werden inferiert, ihr Ergebnis gilt als Typ. Daraus entsteht `createConditionalType`,
und der Ausdruck hat den Typ `TypeOf(<conditional>)`, analog zu `And` in
`getReturnTypeFromFunctionCall`.

### 5. Emitter und Runtime

Der Emitter gibt Rückgabetypen nicht aus. Im MVP ist `:?` deshalb **nur im Rückgabetyp**
erlaubt, anderswo gibt es einen Checker-Fehler. Ein allgemeines `:?` bräuchte eine
Runtime-Implementierung mit Teilmengenprüfung auf `RuntimeType` (siehe Fragen).

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
   dazu `PositiveInteger`, Platzhalter im generischen Kontext und `add()` ohne Argumente.
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
2. **Liefern die Zweige Typen oder Typwerte?** Heute liefert `F(Integer)` den Typwert
   `TypeOf(Integer)`. Empfehlung: Der Rumpf ist ein Typausdruck wie der Rückgabetyp hinter `->`.
   `=> Integer` bedeutet also den Typ `Integer`.
3. ~~**Überlappungsregel wie oben?**~~ Keine Wahl, sondern Voraussetzung für Korrektheit. Die
   einzige Alternative behandelt eine Überlappung wie „passt nicht“ und liefert dann falsche
   Typen: `:?(Rational)` mit `[Integer] => Integer` und `() => Fraction` ergäbe `Fraction`,
   obwohl `5` ein Rational ist. `add` ließe sich damit nur retten, wenn der catchAll von Hand
   `Rational` liefert. Die Korrektheit hinge dann an der Sorgfalt des Autors, und
   `add(Integer Fraction)` verlöre `Fraction`.
4. ~~**Wird nach einer Überlappung der Rest abgezogen?**~~ Entschieden: im MVP nicht. Für
   `add`/`subtract` reicht das, weil der zweite Zweig ohnehin der catchAll ist. Das Abziehen ist
   als spätere Ausbaustufe vorgemerkt, siehe unten.
5. **Wo ist `:?` erlaubt?** Im MVP nur im Rückgabetyp, dort gibt es keinen Emitter und keine
   Runtime. Ein benannter Hilfstyp wie `DifferenceType = (A: Type B: Type) => :?(A B) …` ist eine
   normale Funktion, wird also emittiert und bräuchte eine Runtime-Implementierung. Später
   nachziehen?
6. **Was gilt, wenn kein Zweig greift?** Im MVP ergibt das `Never`, ohne Diagnose. Soll ein
   fehlender catchAll wie bei der Exhaustiveness von `?` gemeldet werden? Die Rechnung dafür ist
   dieselbe.
7. **AST-Knoten: `branching` mit Kennzeichen oder eigener Typ?** Das Kennzeichen spart Code im
   Language Server (Symbole, Faltung). Ein eigener Typ verhindert, dass `?`-Logik (Narrowing,
   Prädikate, `_branch`) versehentlich auf `:?` greift. Empfehlung: eigener Typ.
8. **Wird `add()` ohne Argumente gebraucht?** Die Runtime liefert `0n`. `List(Rational)` schließt
   Empty aus, der Aufruf wäre also schon heute ein Fehler. Falls nicht, deckt der Kopf
   `[Or([] List(Integer))]` den Fall ab.
9. **Anzeige.** Der Hover auf `add` zeigt vor dem Aufruf den Knoten. Soll `:?(…)` samt Zweigen
   erscheinen oder nur die aufgelöste Union `Rational`?
10. ~~**`multiply` gleich mit?**~~ Entschieden: spätere Ausbaustufe, siehe unten.

## Spätere Ausbaustufen

- **`multiply`:** Es hat dieselbe Form wie `add` (`(...args: List(Rational)) -> Rational`) und
  bekommt denselben Rückgabetyp `:?(TypeOf(args))` mit `[Or([] List(Integer))] => Integer` und
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
