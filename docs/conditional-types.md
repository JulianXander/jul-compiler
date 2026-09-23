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
(`1/2 + 1/2`, `1/2 - 1/2`). Sicher eine Fraction ist das Ergebnis nur bei genau einer Fraction
unter Integern. `subtract` zählt diese Fälle auf, `add` kann das nicht, denn ein Tuple-Kopf nennt
nur Mindestpositionen: `[Integer Fraction]` passte auch auf `[Integer Fraction Fraction]`. Damit
der Wert zum Typ passt, normalisiert das `§js` von `add` und `subtract` das Ergebnis zweier
Fractions (`normalizeRational`), sonst entstünde `{numerator: 2, denominator: 2}` statt `1`.

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
| `add(2 3)` | `5` (constant folding wie bisher bei `addInteger`) |
| `add(0.5 0.5)` | `1` |

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
  `typesOverlap(kollektion, kopf) === false`. Die Kollektion ist immer ein Tuple, und für
  Tuples und Lists gab `typesOverlap` bisher nur „unbekannt“ zurück, damit wäre jeder disjunkte
  Fall als Überlappung durchgegangen. `typesOverlap` vergleicht Tuples und Lists deshalb jetzt
  Position für Position, und das gilt überall, auch für `And` und die Unreachable-Prüfung von `?`.
  Die Teilmenge zählt nur, wenn in der Kollektion kein `Any` steckt (`containsAny`), denn
  `hasReliableTypeError` steigt nicht in Tuples ab und hielte `[Any]` für eine Teilmenge von
  `[Integer]`.
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

## Testfälle

Alle Tests entstehen zuerst und laufen gemeinsam rot, dann wird angehalten (Reihenfolge unten).
Tabellengetrieben wie im Bestand. Codebeispiele stehen hier mehrzeilig, im Test als `'…\n\t…'`.

### Hilfsmittel

- **Parser** (`parser.test.ts`, `expectedResults`): neue Region „gültig: bedingter Typ im
  Typblock“ neben G10, mit `check` bzw. `errors` wie dort.
- **Checker** (`checker.test.ts`): neuer `describe('bedingte Typen')` mit einer Tabelle
  `{ name, code, returnType?, errors? }`. `returnType` wird über einen neuen Helfer
  `returnTypeOfLastDefinition(code)` geprüft: letzte Definition, deren Wert ein Funktionstyp ist,
  `typeToString(resolvePlaceholders(ReturnType), 0, 5)`. Tiefe 5 wie `typeOfLastDefinition`,
  damit Alias-Namen (`Fraction`) erscheinen. `errors` wird als `{ code, startRowIndex,
  startColumnIndex }` verglichen wie `multilineHeadCases`. Ohne `errors` gilt: fehlerfrei.
- Die Reihenfolge in erwarteten Unions (`Or(Integer Fraction)`) ist die der Zweige. Gibt
  `createNormalizedUnionType` sie anders aus, wird die Erwartung angepasst, nicht der Test
  gelockert.

### Gemeinsame Definitionen

Die Tests S, M, V, P und R hängen nicht an der core-lib, sie laufen also schon vor deren
Umstellung.

```jul
# f: ein Operand
f = (a: Rational)
	->
		:?(TypeOf(a))
			[Integer] => Integer
			() => Fraction
	=> a

# d: zwei Operanden
d = (a: Rational b: Rational)
	->
		:?(TypeOf(a) TypeOf(b))
			[Integer Integer] => Integer
			() => Fraction
	=> a

# s: variadisch
s = (...xs: List(Rational))
	->
		:?(TypeOf(xs))
			[List(Integer)] => Integer
			() => Fraction
	=> 1
```

Jeder Fall hängt `h = (…) => …` an. Geprüft wird der Rückgabetyp von `h`.

### S: Semantik, ein Operand

| Name | `h` | Rückgabetyp von `h` |
|---|---|---|
| S1 Teilmenge | `(x: Integer) => f(x)` | `Integer` |
| S2 Teilmenge über Untertyp | `(x: PositiveInteger) => f(x)` | `Integer` |
| S3 disjunkt | `(x: Fraction) => f(x)` | `Fraction` |
| S4 Überlappung | `(x: Rational) => f(x)` | `Or(Integer Fraction)` |
| S5 Literal | `() => f(5)` | `5` (constant folding über das reine `f`) |

Erster Treffer gewinnt, mit eigener Definition:

```jul
g = (a: Rational)
	->
		:?(TypeOf(a))
			[PositiveInteger] => Text
			[Integer] => Integer
			() => Fraction
	=> a
```

| Name | `h` | Rückgabetyp |
|---|---|---|
| S6 Teilmenge beendet | `(x: PositiveInteger) => g(x)` | `Text` |
| S7 Überlappung, dann Teilmenge | `(x: Integer) => g(x)` | `Or(Text Integer)` |
| S8 zwei Mal disjunkt | `(x: Fraction) => g(x)` | `Fraction` |

Kein Treffer bleibt still (Frage 6). Die Tests halten das MVP-Verhalten fest, einschließlich
des bekannten Risikos:

```jul
n = (a: Rational)
	->
		:?(TypeOf(a))
			[Integer] => Integer
	=> 1
```

| Name | `h` | Rückgabetyp |
|---|---|---|
| S9 kein Treffer | `(x: Fraction) => n(x)` | `Never` |
| S10 Teiltreffer, bekanntes Risiko | `(x: Rational) => n(x)` | `Integer` |

### M: zwei Operanden (`d`)

| Name | `h` | Rückgabetyp |
|---|---|---|
| M1 | `(x: Integer y: Integer) => d(x y)` | `Integer` |
| M2 | `(x: Fraction y: Integer) => d(x y)` | `Fraction` |
| M3 | `(x: Rational y: Integer) => d(x y)` | `Or(Integer Fraction)` |
| M4 | `(x: PositiveInteger y: Integer) => d(x y)` | `Integer` |
| M5 Präfix | `(x: Integer y: Integer) => x.d(y)` | `Integer` |

### V: variadisch (`s`)

| Name | `h` | Rückgabetyp |
|---|---|---|
| V1 | `(x: Integer y: Integer z: Integer) => s(x y z)` | `Integer` |
| V2 | `(x: Integer y: Fraction) => s(x y)` | `Fraction` |
| V3 | `(x: Integer y: Rational) => s(x y)` | `Or(Integer Fraction)` |
| V4 Spread Integer | `(ys: List(Integer)) => s(...ys)` | `Integer` (braucht den Spread-Fix aus Schritt 2) |
| V5 Spread Rational | `(ys: List(Rational)) => s(...ys)` | `Or(Integer Fraction)` |
| V6 Präfix | `(x: Integer) => x.s(1)` | `Integer` |

### P: offene Signatur und Weitergabe

| Name | Code | Erwartung |
|---|---|---|
| P1 Hover-Form | nur `f` | `returnTypeOfLastDefinition` ergibt `Or(Integer Fraction)` (Frage 9) |
| P2 generische Weitergabe | `k = (y: Rational) => f(y)`, dann `h = (x: Integer) => k(x)` | `Integer` |

P2 prüft, ob der vorhandene Mechanismus ein offenes `:?` durch eine Funktion ohne deklarierten
Rückgabetyp trägt. Schlägt der Test nach der Umsetzung aus diesem Grund fehl und nicht wegen
`:?`, wird das besprochen, bevor die Erwartung geändert wird.

### R: Rumpfprüfung (Frage 11)

| Name | Code | Erwartung |
|---|---|---|
| R1 Rumpf in der Union | `f` wie oben | fehlerfrei |
| R2 Rumpf außerhalb | wie `f`, aber `=> §x§` | `returnTypeMismatch` am Rumpf |
| R3 bekannte Großzügigkeit | wie `d`, aber `=> 0.5` | fehlerfrei, obwohl `d(1 2)` `Integer` zusagt |
| R4 Teiltreffer im Rumpf | wie `n`, aber `=> a` | `returnTypeMismatch`: `Rational` liegt nicht in `Integer` |

R4 zeigt, dass die Rumpfprüfung bei eigenen Funktionen einen fehlenden catchAll teilweise
auffängt. Bei `nativeFunction` fehlt dieser Schutz.

### E: Fehler

| Name | Code | Erwartung |
|---|---|---|
| E1 außerhalb des Rückgabetyps | `x = :?(Integer)` mit Zweig `[Integer] => Integer` | JUL5153 an `:?` |
| E2 Bindung im Kopf | wie `f`, aber Zweig `(x: Integer) => Integer` | JUL5154 am Zweig |
| E3 Kopfzeile | `F = (a: Integer) -> :?(TypeOf(a))` mit Zweigen darunter | JUL1107 (Parser, vorhanden) |
| E4 unvollständig | `F = (a: Integer)`, `->`, `:?(` beim Tippen | wirft nicht, dieselbe Parser-Meldung wie bei `?(` |

### PA: Parser

| Name | Code | Erwartung |
|---|---|---|
| PA1 Typblock | `F = (a: Integer)`, `->`, `:?(TypeOf(a))` mit `[Integer] => Integer` und `() => Text` | `returnType.type === 'typeBranching'`, 2 Zweige, beide `functionLiteral` |
| PA2 zwei Operanden | `F = (a: Integer b: Integer)`, `->`, `:?(TypeOf(a) TypeOf(b))`, ein Zweig | `args` mit 2 Elementen |
| PA3 in `nativeFunction` | Aufruf mit Funktionskopf und `:?`-Typblock, danach `§js … §` als zweites Argument | Aufruf hat 2 Argumente, das erste ist ein `functionTypeLiteral` mit `typeBranching` als Rückgabetyp |
| PA4 `?` unverändert | G10 | bleibt `branching` |

### K: core-lib (nach Schritt 6)

| Name | Code | Erwartung |
|---|---|---|
| K1 | `h = (x: Integer y: Integer) => subtract(x y)` | `Integer` |
| K2 | `h = (x: Fraction y: Integer) => subtract(x y)` | `Fraction` |
| K3 | `h = (x: Rational y: Integer) => subtract(x y)` | `Rational` |
| K4 | `h = (x: Integer y: Integer z: Integer) => add(x y z)` | `Integer` |
| K5 | `h = (x: Integer y: Fraction) => add(x y)` | `Rational` (variadisch nicht genauer ausdrückbar) |
| K6 | `h = (x: Integer y: Rational) => add(x y)` | `Rational` |
| K7 | `h = (ys: List(Integer)) => add(...ys)` | `Integer` |
| K8 Präfix | `h = (x: Integer) => x.add(1)` | `Integer` |
| K9 Länge (yugioh-Muster) | `h = (xs: List(Integer)) => xs.length().subtract(1)` | `Integer` |
| K10 Folding | `r = add(2 3)` bzw. `r = subtract(5 3)` | `5` bzw. `2` (`typeOfLastDefinition`) |
| K11 ohne Argumente | `r = add()` | JUL5050 wie bisher |
| K12 Hover | Symbol `add` | `Rational`, als Alias statt ausgeschriebenem Dictionary |
| K13, K14 | `Fraction` plus bzw. minus `Fraction` | `Rational` |
| K15 | `h = (x: Integer y: Fraction) => subtract(x y)` | `Fraction` |
| K16 Normalisierung | `r = add(0.5 0.5)` bzw. `r = subtract(0.5 0.5)` | `1` bzw. `0` |

Umgestellt werden außerdem die vorhandenen Tests auf `addInteger` (siehe Migration). Die
Folding-Tests laufen danach mit `add` und müssen dieselben Werte liefern.

## Reihenfolge

1. `npm run bench -- --save --note "vor :?"` in `jul-compiler` und `jul-language-server`.
2. Alle Tests oben schreiben (S, M, V, P, R, E, PA, K). Das Paket muss typechecken, deshalb
   stehen die Fehlercodes JUL5153/5154 schon im Enum, noch ohne Verwendung. `npm test` laufen
   lassen, den roten Output zeigen und **anhalten**.
3. Typknoten `conditional` und Auswertung (Schritte 1, 2) samt Spread-Fix.
4. Parser (Schritt 3), dann PA grün.
5. Checker-Fall und Fehlercodes (Schritt 4), dann S, M, V, P, R, E grün.
6. core-lib umstellen (Schritt 6), `addInteger`/`subtractInteger` entfernen, bestehende Tests
   migrieren, dann K grün.
7. `npm test`, `npm run typecheck`, `npm run test-update-snapshot`, die Änderungen an der
   Baseline durchsehen. `npm run build-all`, dann im LSP `npm test` und `npm run test-snapshot`.
8. Öffentliche Doku: `jul-homepage/docs/docs/documentation/handbook.md` bekommt einen Abschnitt
   „Bedingte Typen“ (Verhalten mit Beispiel, ohne Begründungen), das `myAdd`-Beispiel wird auf
   `add` umgestellt, und `error-codes.md` bekommt JUL5153 und JUL5154.
9. yugioh migrieren (16 Aufrufe) und mit `--check` prüfen, danach
   `bench --save --note "nach :?"` in beiden Projekten.
10. `jul-compiler/TODO`: Den Eintrag zu bedingten Typen auf den Stand bringen, auch die Aussage
    „variadisch nicht erreichbar“ für `add` korrigieren.

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
   (`add: (...args: List(Rational)) -> Rational`), nicht die `:?`-Zweige. Das ist
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
