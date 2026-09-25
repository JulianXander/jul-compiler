# Groß-/Kleinschreibung von Namen

Typen und höhere Typen (Funktionen, die einen Typ liefern) beginnen mit einem Großbuchstaben,
alles, was sicher kein Typ ist, mit einem Kleinbuchstaben. Der Checker meldet Verstöße als
Warnung `JUL2600`.

## Warum semantisch und nicht in der Grammatik

In Haskell und Elm erzwingt die Grammatik die Schreibweise. Das geht dort nur, weil Typ- und
Wertebene getrennt sind und die Position im Quelltext die Rolle festlegt. In JUL leben Werte und
Typen im selben Namensraum, und jeder Wert ist als Typ verwendbar: `getTypeError` lässt beim Ziel
`Type` auch `4`, `§a§`, `true` und `[]` durch. Ob `Foo = bar(1)` einen Typ definiert, weiß erst
der Checker.

Das nächste Vorbild ist Zig: Typen sind dort ebenfalls Werte, und der Styleguide schreibt Typen
und Funktionen, die einen Typ liefern, groß, alles andere klein. Zig erzwingt das nicht. Rust
prüft seine Namenskonventionen als Compiler-Lint, also als Warnung. Das übernimmt JUL.

Kriterium ist deshalb nicht, ob ein Wert auf `Type` passt, sondern der **statische Typ des
Symbols**.

Warnung statt Fehler: Die Einteilung hängt an der Inferenz. Wird der Checker genauer und aus einem
`Any` wird ein `typeOf`, bekäme Code, der vorher fehlerfrei war, einen Fehler.

## Einteilung

`classifyTypeness(type): 'type' | 'value' | 'unknown'` im Checker, auf dem statischen Typ nach
`resolveAlias`. Die Rekursion ist über `maxTypenessDepth` begrenzt.

| statischer Typ | Ergebnis |
|---|---|
| `typeOf`, `type` | `type` |
| `boolean`, `integer`, `float`, `text`, `date`, `blob`, `error`, deren Literale, `empty`, `stream`, `greater`, `lengthOf`, `range` | `value` |
| `list`, `dictionary` | Einteilung des Elementtyps |
| `tuple`, `dictionaryLiteral`, `or` | `type`, wenn alle Teile `type` sind; `value`, wenn alle `value` sind; sonst `unknown` |
| `and` | eindeutig, sobald ein Operand eindeutig ist und keiner widerspricht (der Schnitt ist Teilmenge jedes Operanden) |
| `function` | Einteilung des `ReturnType`; `type` heißt höherer Typ |
| `function` mit `predicate` | `unknown` (Prädikate sind vorerst ausgenommen) |
| `parameterReference` | `value`, wenn der deklarierte Parametertyp `value` ist, sonst `unknown` |
| `any`, `never`, `not`, `conditional`, `tupleOf`, `concat`, `withElementAt`, `nestedReference`, `parameters` | `unknown` |

`unknown` wird nie gemeldet.

**`parameterReference` ist mehrdeutig.** In `(T: Type) => T` steht die Rückgabe für das Argument
selbst, in `(T: Type v: T) => v` hat `v` den Typ `parameterReference(T)` und steht damit für einen
Wert aus T. Ist das Argument ein Wert, fallen beide Lesarten zusammen (ein Wert als Typ ist ein
Singleton), bei einem Typ nicht. Deshalb bleibt `H = (T: Type) => T` frei. `f = (x: Integer) => x`
wird dagegen als Wert erkannt. Ohne diese Auflösung wären fast alle Funktionsliterale `unknown`,
weil ihr Rückgabetyp meist eine `parameterReference` ist.

Stichprobe:

| Definition | statischer Typ | Einteilung |
|---|---|---|
| `Pair = [Integer Text]` | `tuple[typeOf typeOf]` | type |
| `Point = [x: Integer y: Integer]` | `typeOf(dictionaryLiteral)` | type |
| `MyNum = Or(Integer Text)` | `typeOf(or)` | type |
| `Mixed = [Integer 4]` | `tuple[typeOf integerLiteral]` | unknown |
| `x = 4`, `list = [1 2]`, `dict = [a = 1]`, `e = []` | Literale | value |
| `f = (x: Integer) => x` | `function -> parameterReference(x: Integer)` | value |
| `H = (T: Type) => T` | `function -> parameterReference(T: Type)` | unknown |
| `G = (T: Type) => List(T)`, `Greater`, `Without` | `function -> typeOf` bzw. `type` | type |
| `s = (x: Any) => x` | `function -> parameterReference(x: Any)` | unknown |
| `map` | `function -> tupleOf` | unknown |

## Wo geprüft wird

Wo ein Name eingeführt wird, jeweils am Namensknoten, über `checkNamingCase`:

- `case 'definition'`: Hat die Definition einen TypeGuard, zählt dessen `valueOf`, sonst das
  endgültige `typeInfo` (einschließlich `coreBuiltInSymbolTypes`).
- `case 'destructuring'`: der aufgelöste `fieldType` je Feld, geprüft am lokalen Namen, auch beim
  Import.
- `case 'parameter'`: der schon berechnete `inferredType`, auch beim Rest-Parameter. Ein Parameter
  ohne TypeGuard und ohne erwarteten Typ ist `Any` und bleibt frei.

Dictionary-Felder werden vorerst nicht geprüft. Groß und klein werden über `\p{Lu}` und `\p{Ll}`
bestimmt, ein Name, der mit keinem von beiden beginnt, bleibt frei.

## Umgesetzt

- `ErrorCode.namingCase = 2600`, `semantic`, `warning`.
- Tests im Abschnitt „Schreibweise“ in `checker.test.ts`, je Prüfstelle, je Richtung und für die
  freien Fälle. Bestehende Tests mit nicht regelkonformen Namen wurden umbenannt.
- Checker-Snapshot: zehn neue Warnungen in `jul-examples` (`type-checking-test.jul`, `types.jul`),
  die Zähler-Baseline ist unverändert.
- Abschnitt `JUL2600` in `jul-homepage/docs/docs/documentation/error-codes.md` (eine englische
  Fassung der Seite gibt es nicht).

Bestehender Code in `jul-examples` und yugioh wird nicht migriert, die Warnungen bleiben dort
stehen.

## core-lib

Drei Parameter wurden umbenannt, jeweils auch im JS-Rumpf und bei `Greater` und `ElementAt` in
den Parameternamen, die `runtime.ts` über `_createFunction` hinterlegt:

- `Greater(value: Or(Integer Float))`, vorher `Value`: ein Wert.
- `Concat(...Sources: List(Type))`, vorher `sources`: Typen.
- `ElementAt(Source Index: Or(Integer Type))`, vorher `index`: `Or(Integer Type)` wird zu `Type`
  normalisiert, denn jede Zahl ist als Typ verwendbar. Gemeint war „Position oder Typ“, für die
  Typfunktion `ElementAt` ist der Index aber tatsächlich ein Typ. Es ist der eine Fall, in dem die
  Normalisierung die ursprüngliche Absicht verdeckt.

## Später

- Quick-Fix im Language Server, der über das vorhandene Rename umbenennt.
- Prädikate einteilen. Sie sind Funktionen, die `Boolean` liefern, sind aber als Typ verwendbar.
- `tupleOf` und `conditional` genauer einteilen (`map` wäre dann `value`).
- Dictionary-Felder.
