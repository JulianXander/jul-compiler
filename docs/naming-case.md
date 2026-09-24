# Groß-/Kleinschreibung von Namen

Typen und höhere Typen (Funktionen, die einen Typ liefern) beginnen mit einem Großbuchstaben,
alles, was sicher kein Typ ist, mit einem Kleinbuchstaben. Der Checker meldet Verstöße als
Warnung.

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
`resolveAlias`. Ein `isUnresolvedPlaceholder` ergibt `unknown`. Rekursive Typen (`Tree =
[children: List(Tree)]`) brauchen einen Rekursionsschutz.

| statischer Typ | Ergebnis |
|---|---|
| `typeOf`, `type` | `type` |
| `boolean`, `integer`, `float`, `text`, `date`, `blob`, `error`, deren Literale, `empty`, `stream`, `greater`, `lengthOf`, `range` | `value` |
| `tuple`, `list`, `dictionary`, `dictionaryLiteral` | `type`, wenn alle Elemente `type` sind; `value`, wenn alle `value` sind; sonst `unknown` |
| `or` | wie bei den Kollektionen, über die Choices |
| `function` | Einteilung des `ReturnType`; `type` heißt höherer Typ |
| `function` mit `predicate` | `unknown` (Prädikate sind vorerst ausgenommen) |
| `parameterReference` | über `dereferenceParameterTypeFromFunctionRef` auf den deklarierten Parametertyp, dann dieser |
| `any`, `never`, `and`, `not`, `conditional`, `tupleOf`, `concat`, `withElementAt`, `nestedReference`, `parametersType` | `unknown` |

`unknown` wird nie gemeldet.

Stichprobe mit dem heutigen Checker:

| Definition | statischer Typ | Einteilung |
|---|---|---|
| `Pair = [Integer Text]` | `tuple[typeOf typeOf]` | type |
| `Point = [x: Integer y: Integer]` | `typeOf(dictionaryLiteral)` | type |
| `MyNum = Or(Integer Text)` | `typeOf(or)` | type |
| `Mixed = [Integer 4]` | `tuple[typeOf integerLiteral]` | unknown |
| `x = 4`, `list = [1 2]`, `dict = [a = 1]`, `e = []` | Literale | value |
| `f = (x: Integer) => x` | `function -> parameterReference(x: Integer)` | value |
| `H = (T: Type) => T` | `function -> parameterReference(T: Type)` | type |
| `G = (T: Type) => List(T)`, `Greater`, `Without` | `function -> typeOf` bzw. `type` | type |
| `s = (x: Any) => x` | `function -> parameterReference(x: Any)` | unknown |
| `map` | `function -> tupleOf` | unknown |

Die Rückgabe eines Funktionsliterals ist oft eine `parameterReference`, deshalb ist deren
Auflösung Pflicht, sonst fielen fast alle Funktionen auf `unknown`.

## Wo geprüft wird

Wo ein Name eingeführt wird, jeweils am Namensknoten:

- `case 'definition'` in `setInferredType`: Hat die Definition einen Typguard, zählt dessen
  `valueOf`, sonst das endgültige `typeInfo` (einschließlich `coreBuiltInSymbolTypes`).
- `case 'destructuring'`: der aufgelöste `fieldType` je Feld, geprüft am lokalen Namen
  (`field.name`), auch beim Import.
- `case 'parameter'`: der schon berechnete `inferredType`. `T: Type` ergibt `type`, ein
  Parameter ohne Typguard und ohne erwarteten Typ ergibt `Any` und bleibt frei. Auch der
  Rest-Parameter wird geprüft (`...ChoiceTypes: List(Type)` ergibt `type`).

Nicht geprüft werden vorerst Dictionary-Felder und Namen, die nicht mit einem Buchstaben beginnen
oder escaped sind. Groß und klein werden über `\p{Lu}` und `\p{Ll}` bestimmt.

## Fehlercode

`namingCase = 2600` im Abschnitt „2000 semantic: Sprachregeln“, `{ type: 'semantic', severity:
'warning' }`. Meldungen:

- `'foo' is a type and should start with an uppercase letter.`
- `'Foo' is not a type and should start with a lowercase letter.`

Dazu, laut Kopfkommentar in `compiler-errors.ts`, ein Abschnitt in
`jul-homepage/docs/docs/documentation/error-codes.md` mit Beispiel. Die englische i18n muss
ebenfalls ergänzt werden.

## Umsetzungsschritte

1. `npm run bench -- --save --note "vor Namensprüfung"`
2. `classifyTypeness` mit tabellengetriebenen Unit-Tests über die Fälle der Stichprobe oben.
3. Prüfung an den drei Stellen, dazu `checker.test.ts`-Fälle je Stelle, je Richtung und je
   `unknown`-Fall (keine Meldung).
4. Bestehende Tests, die jetzt eine Warnung bekommen, auf regelkonforme Namen umstellen, statt
   die Warnung in die Erwartung aufzunehmen, sofern der Test nicht die Namen selbst prüft.
5. `npm run test-update-snapshot` und die Änderung an beiden Baselines ansehen. Neue Warnungen im
   Checker-Snapshot sind zu erwarten und dienen zugleich als Bestandsaufnahme.
6. Fehlercode dokumentieren (Homepage de und en).
7. `npm run bench -- --save --note "Namensprüfung"`, dann `build-all` und im Language Server
   `npm run test-snapshot`.

Bestehender Code in `jul-examples` und yugioh wird nicht migriert, die Warnungen bleiben dort
stehen.

## Später

- Quick-Fix im Language Server, der über das vorhandene Rename umbenennt.
- Prädikate einteilen. Sie sind Funktionen, die `Boolean` liefern, sind aber als Typ verwendbar.
- `tupleOf` und `conditional` genauer einteilen (`map` wäre dann `value`).
- Dictionary-Felder.
