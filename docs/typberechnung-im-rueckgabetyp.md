# Typberechnung im Rückgabetyp

Ausgangsfall aus yugioh (`game-logic.jul`):

```jul
nextGameCardId$ = create$(GameCardId 1)      # GameCardId = PositiveInteger = And(Integer Greater(0))
…
nextGameCardId$.push(gameCardId.add(1))      # JUL5050: Can not assign Integer to Greater(0).
```

`add` deklariert für Integer-Argumente nur `[List(Integer)] => Integer`. Die untere Grenze geht
verloren, obwohl die Summe zweier positiver Integer positiv ist. Abgesichert durch den Test
„K22 add erhält die Untergrenze“ in `checker.test.ts`.

## Optionen

| | Wo | Allgemeinheit | Bewertung |
|---|---|---|---|
| A `assume` im Nutzercode | Nutzercode | — | Laufzeitprüfung und Rauschen an jedem Zählermuster `n.add(1)`; verworfen |
| B weitere Zweige in `add` (`[List(PositiveInteger)] => PositiveInteger`) | core-lib | nur feste Kategorien | wie `+` in Typed Racket: die Zweige wachsen kombinatorisch, `Greater(5)` bleibt unerreichbar; verworfen |
| C Grenzen im Checker mitrechnen, ohne dass die core-lib es sagt | checker.ts | beliebige Grenzen | der Checker wüsste still, was `add` tut, zwei Quellen der Wahrheit; widerspricht „Keine Magie für Typen“ ([design-principles.md](design-principles.md)); verworfen |
| D die core-lib nennt eine Typfunktion, die den Rückgabetyp berechnet | core-lib + Typfunktion | beliebige Grenzen | gewählt |

Refinement Types mit Solver (Liquid Haskell, F\*) wären präziser, sind aber unverhältnismäßig
(Solver, Meldungen, Checkzeiten).

## Entscheidung: D mit der Typfunktion `Add`

```jul
add = nativeFunction(
	(...args: List(Rational))
		->
			:?(TypeOf(args))
				[List(Integer)] => Add(TypeOf(args))
				() => Rational
	§js … §
)
```

`Add` ist `add`, auf Mengen gehoben: Es bekommt die Menge der möglichen Argumente und liefert die
Menge der möglichen Summen. Der Name folgt der Schreibung von Typen, wie `Greater` neben `greater`.

| `TypeOf(args)` | `Add(…)` |
|---|---|
| `[PositiveInteger 1]` | `And(Integer Greater(1))` |
| `[Integer 1]` | `Integer` |

### Im Checker, wie `TupleOf` und `Concat`

`Add` wird gebaut wie die vorhandenen Typfunktionen `TupleOf`, `Concat`, `ElementAt` und
`WithElementAt`: Die core-lib deklariert sie, der Checker wertet sie in
`getReturnTypeFromFunctionCall` aus (`addFromTypes`). Solange das Argument noch Platzhalter
enthält, bleibt ein Knoten `add` stehen, den `traversePlaceholders` am Aufrufort neu faltet. So
bleibt `Add(TypeOf(args))` in `add` bis zum Aufruf offen, wie `TupleOf(length(values) …)` in
`map`. Anders als bei C steht in der core-lib sichtbar, dass `add` seinen Typ über `Add` berechnet.

Verworfen:

- **`Add` in `runtime.ts` und die Typen zum Falten übersetzen.** Bisher faltet die Runtime nur
  Werte. Typwerte zu falten hätte eine Übersetzung CompileTimeType ↔ RuntimeType gebraucht und
  ein eigenes Problem mitgebracht: `TypeOf(args)` ist zur Prüfzeit eine Obermenge des
  Laufzeitwerts, keine Konstante. Der Checker rechnet dagegen ohnehin auf Mengen.
- **Ein allgemeiner aufgeschobener Aufruf im Rückgabetyp**, der `-> Greater(add(a 1))` am
  Aufrufort faltet. Für `add` nicht nötig, weil `Add` seinen eigenen Knoten hat; ohne zweiten
  Anwendungsfall nur zusätzlicher Code.
- **`And(Integer Greater(add(...LowerBounds(TypeOf(args)))))`.** Dort rechnet zwar das echte
  `add`, aber nur `0 + 0`; das Wissen über Grenzen steckt trotzdem in `LowerBounds`. Dafür bräuchte
  es verschachtelte aufgeschobene Aufrufe und einen Schutz gegen die Rekursion durch den
  Selbstbezug von `add` in seinem eigenen Rückgabetyp.

Der Preis: Die Summe steht zweimal, in `add` und als Mengenregel in `Add`, und jede weitere
Operation braucht ihre eigene Typfunktion. Jede Operation hat ohnehin eigene Regeln (Vorzeichen
bei `multiply`, obere Grenzen bei `subtract`).

### Rechenregel

`Add` sieht im Zweig `[List(Integer)]` nur Integer und rechnet deshalb mit einem Mindestwert
„x ≥ m“ je Element:

| Element | m |
|---|---|
| Literal `c` | `c` |
| `Greater(a)` mit Integer-Literal `a` | `a + 1` |
| `And(…)` | größtes m seiner Teile |
| `Or(…)` | kleinstes m seiner Choices, keine Grenze, wenn eine fehlt |
| Länge (`length(xs)`) | `1` |
| Alias | m des aufgelösten Typs |
| alles andere | keine Grenze |

Hat jedes Element eine Grenze, ist die Summe `≥ Σm`, das Ergebnis also `And(Integer Greater(Σm − 1))`.
Sonst ist es `Integer`. Eine `List(T)` zählt wie ein Element vom Typ `T`: Sie ist nie leer, und
jedes weitere Element erhöht die Summe nur, solange `m ≥ 0` ist. Für `m < 0` ist die Summe nach
unten offen, das Ergebnis dann `Integer`.

Die Regel für `Greater(a)` gilt nur für Integer. Ist ein Element nicht sicher Integer, ist das
Ergebnis `Integer`. Das kommt vor, wenn der Zweig `[List(Integer)]` nur überlappt (`add(x y)` mit
`y: Rational`), und entspricht dem Verhalten vor `Add`: Der catchAll `() => Rational` deckt den
Rest ab.

`Add` hat wie `Concat` keine Laufzeit-Implementierung, ein Aufruf zur Laufzeit wirft.

## MVP

- Nur `add`.
- Die Formen der Tabelle oben; Argument ist ein Tuple oder eine List.
- `Greater` mit einer Fraction oder einem Float als Wert zählt als keine Grenze.

### Schritte

Vorab: `bench`, `bench-runtime` (jul-compiler) und `bench` (jul-language-server) mit `--save`.

1. **Rote Tests** in `checker.test.ts` (Block „bedingte Typen“, K-Fälle): K22 und die Regeln der
   Tabelle über `add`.
2. **`Add` in `core-lib.jul`** mit einer Laufzeit-Implementierung im `§js`, wie bei `TupleOf`.
3. **Checker:** Knoten `add` in `syntax-tree.ts`, Sonderfall `Add` in
   `getReturnTypeFromFunctionCall`, `addFromTypes`, Fall `add` in `traversePlaceholders` und in den
   übrigen `switch (julType)`-Stellen wie `tupleOf`.
4. **`add` umstellen**, die Tests werden grün, die übrigen K-Fälle bleiben grün.
5. **Abschluss.** `test-update-snapshot` samt Diff-Durchsicht, `test-snapshot` im Language
   Server, Benches mit `--save`, `jul check` in yugioh (Zeile 75 fehlerfrei), Ausbaustufe in
   [backlog/conditional-types.md](backlog/conditional-types.md) nachtragen, Offenes nach `TODO`.

## Nach dem MVP

- Literal-Unions: `Or(1 2) + 1` = `Or(2 3)`.
- `Multiply` (Vorzeichenregeln), `Subtract` (braucht obere Grenzen).
- `Greater` mit Fraction- oder Float-Wert als Grenze.
- `-> Greater(add(a 1))` faltet nicht am Aufrufort: Ein Aufruf im Rückgabetyp wird bei der
  Definition ausgewertet (`Greater(Integer)`). `Greater` mit nicht konstantem Wert ist zudem
  bedeutungslos und wird still akzeptiert.
- Anzeige: `And(Integer Greater(0))` als `PositiveInteger` wiedererkennen.
