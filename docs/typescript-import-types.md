# TS-Typannotationen in importierte JUL-Typen übernehmen

## Context

Aus `.ts`/`.js` importierte Funktionen haben in JUL heute immer den Typ `(a b …) :> Any`.
[typescript-parser.ts](jul-compiler/src/parser/typescript-parser.ts) liest nur Namen und
Parameternamen, übergibt `returnType: undefined` und einen Dummy-Rumpf `nativeValue(§[...]§)`.
Anlass ist `countPreviousConsecutive` aus `yugioh/src/util.ts`: annotiert mit `): bigint`, in JUL
trotzdem `Any`. Laut `jul-compiler/TODO` (Punkt „yugioh: ein Any-Operand ergibt Or(Integer Fraction)“)
landen dadurch 6 Stellen in `game-logic.jul` bei `Or(Integer Fraction)` statt `Integer`.

Ziel: TS-Annotationen **syntaktisch** in JUL-Typausdrücke übersetzen, ohne den TS-TypeChecker.
Die Annotation wird **ungeprüft vertraut**, genau wie ein deklarierter Typ an `nativeValue` in
der core-lib.

- **Stufe 1:** nur der Rückgabetyp.
- **Stufe 2:** zusätzlich die Parametertypen.
- **Spätere Ausbaustufe, nicht Teil dieses Plans:** Funktionstypen (Callbacks). Offene Frage:
  JUL vergleicht Parameternamen von Funktionstypen (JUL5050 „Parameter name mismatch“), TS
  vergleicht nur positional. `predicate: (element: any) => boolean` würde jeden JUL-Aufrufer
  mit `(value) => …` brechen (yugioh: `countPreviousConsecutive`, `mapDictionary`).

## Stand

- **Stufe 1 umgesetzt.** Im Checker und im Language Server kam der Typ sofort an, in der CLI
  erst nach [project-loader.md](project-loader.md): Die CLI checkte nur `.jul`-Dateien, der
  Import aus der ungecheckten `.ts`-Datei lieferte `Any`. Seitdem sind die beiden
  `countPreviousConsecutive`-Stellen in yugioh (`game-logic.jul` 211, 235) behoben.
- Neu in yugioh, dieselbe Ursache an 5 Stellen (`game-logic.jul` 656, 668, 723, 2043, 2060):
  `mapDictionary` ist mit `{ [key: string]: U; } | undefined` annotiert, also
  `Or(Empty Dictionary(Any))`, `GameState/cards` verlangt `Dictionary(GameCard)`. Die Annotation
  ist gröber als das Verhalten (`undefined` nur bei `undefined`-Eingabe). Das ist eine echte
  Diskrepanz auf TS-Seite, kein Übersetzungsfehler. Wie sie aufgelöst wird, ist offen.
- **Stufe 2** folgt.

## Was schon da ist (keine Checker-Änderung nötig)

[checker.ts:2832-2877](jul-compiler/src/checker/checker.ts#L2832-L2877): Liefert der Rumpf
`Any` (bei `nativeValue` immer), wird der deklarierte `returnType` des Funktionsliterals
übernommen. `createParseFunctionLiteral(params, returnType, …)` in
[parser-utils.ts:47](jul-compiler/src/parser/parser-utils.ts#L47) nimmt ihn schon entgegen.
Builtins sind im Scope einer TS-Datei sichtbar. Belegt ist das dadurch, dass eine TS-Funktion
namens `Integer` heute JUL4003 „already defined in upper scope“ erzeugt: eine Referenz auf
`Integer` löst also garantiert auf das Builtin auf.

Parameter-Typen landen in `ParseParameterField.typeGuard`, Rest-Parameter in
`createParseParameters(singleFields, rest, …)` ([parser-utils.ts:5](jul-compiler/src/parser/parser-utils.ts#L5)).

## Umsetzung

### Kern: `tsTypeToJulType(typeNode, sourceFile): ParseValueExpression | undefined`

Neue Funktion in `typescript-parser.ts`. Sie erzeugt denselben Parse-Baum, den der JUL-Parser für
den geschriebenen Typ erzeugen würde. Alle synthetischen Knoten bekommen die Position des
TS-Typknotens (`getPositionFromTsNode`). Kleine Helfer: `createReference(name, position)` und
`createCall(name, args, position)` für `Or(…)`, `List(…)`, `Dictionary(…)`.

| TS | JUL |
|---|---|
| `bigint` | `Integer` |
| `number` | `Float` |
| `string` | `Text` |
| `boolean` | `Boolean` |
| `any`, `unknown` | `Any` |
| `null`, `undefined`, `void` | `[]` (`empty`) |
| `T[]`, `readonly T[]`, `Array<T>`, `ReadonlyArray<T>` | `Or([] List(T))`, weil TS-Arrays leer sein dürfen |
| `{ [key: string]: T }`, `Record<string, T>` | `Or([] Dictionary(T))` |
| `{ a: T; b?: U }` (Objekt-Typliteral) | `[a: T b: Or([] U)]` (`dictionaryType`, Aufbau wie [parser.ts:3020-3043](jul-compiler/src/parser/parser.ts#L3020-L3043), inkl. `fillSymbolTableWithFields`) |
| `A \| B` | `Or(A B)` |
| `'x'`, `1n`, `1`, `true`/`false` | `§x§`, `1`, `1f`, `true`/`false` |
| `(T)` (Klammertyp) | `T` |
| `Error` (Typreferenz) | `Error` |

**Nicht übersetzbar:** Funktionstypen, Generics (`T`), Interfaces, Typ-Aliase, DOM-Typen,
`Promise`, Tuples, Intersection und alles Übrige. Auf oberster Ebene gibt die Funktion dann
`undefined` zurück; es bleibt beim heutigen Verhalten, `Any` aus dem Rumpf. Verschachtelt wird
`Any` eingesetzt: `Foo[]` → `Or([] List(Any))`. Eine unbekannte Typreferenz wird **nie** als
JUL-Referenz ausgegeben, sonst gäbe `T` einen JUL-Fehler „not defined“. Ein Union mit einem
nicht übersetzbaren Glied wird im Ganzen zu `Any`/`undefined`, weil `Or(X Any)` ohnehin `Any` ist.

### Stufe 1: Rückgabetyp

- `tsFunctionToJulAst` bekommt zusätzlich den `returnType`-Knoten (`FunctionDeclaration.type`
  bzw. `ArrowFunction.type`) und reicht `tsTypeToJulType(...)` an `createParseFunctionLiteral` durch.
- Ohne Annotation bleibt alles wie bisher.

### Stufe 2: Parametertypen

- `tsParametersToJulParameters`: `typeGuard = tsTypeToJulType(tsParameter.type)`.
- Optional (`x?: T`) oder mit Default (`x = 1`): `Or([] T)`. Ohne Annotation, aber mit Default:
  kein typeGuard.
- Funktionstypen: kein typeGuard, der Parameter bleibt ungetypt (siehe spätere Ausbaustufe).
- Rest-Parameter (`...args: T[]`): heute fälschlich als normaler Einzelparameter übernommen.
  Er wandert nach `rest`, mit typeGuard `List(T)`, wie in der core-lib (`...args: List(Boolean)`).

## Tests

In [typescript-parser.test.ts](jul-compiler/src/parser/typescript-parser.test.ts), im
Bestandsstil tabellengetrieben (`expectedResults` + Schleife mit `it`). Jeder Fall: TS-Code →
Definitionsname → erwarteter `typeToString`. Ablauf: `parseCode(code, 'test.ts')` +
`checkTypes(parsed, {})`, der Typ wird am `definition.value.typeInfo` abgelesen; außerdem wird
geprüft, dass `checked.errors` leer ist.

Stufe 1, Fälle:
- `function f(): bigint` → `() :> Integer`; analog `number`, `string`, `boolean`, `void`.
- `bigint | undefined` → `Or([] Integer)`, `string[]` → `Or([] List(Text))`
- `{ [key: string]: any } | undefined`, `Record<string, number>`
- Objekt-Typliteral mit optionalem Feld (das `parseYdk`-Muster, inkl. `| Error`)
- Literaltypen, Klammertyp
- `const f = (): bigint => 1n` (ArrowFunction im VariableStatement)
- nicht übersetzbar: generisches `T`, `Promise<number>`, Funktionstyp → bleibt `Any`, **ohne** Fehler
- verschachtelt nicht übersetzbar: `Foo[]` → `Or([] List(Any))`
- ohne Annotation: unverändert `Any`

Stufe 2, Fälle:
- `(a: bigint, b?: string)` → `(a: Integer b: Or([] Text))`
- Default-Wert ohne Annotation → ungetypt
- Callback-Parameter `(cb: (x: any) => boolean)` → `cb` ungetypt
- `(...args: bigint[])` → Rest-Parameter `...args: List(Integer)`
- JUL-Aufruf mit falschem Argument meldet JUL5050. Braucht eine Datei auf der Platte, Muster wie
  der E6-Test in [checker.test.ts:3280](jul-compiler/src/checker/checker.test.ts#L3280):
  TS-Datei nach `tmpdir()`, JUL-Code importiert sie, `f(§x§)` gegen `(a: Integer)` → Fehler.
  Derselbe Aufbau prüft für Stufe 1, dass der Rückgabetyp beim JUL-Aufrufer als `Integer` ankommt.

Reihenfolge je Stufe: Tests zuerst schreiben, roten Lauf zeigen, dann implementieren. Das ist
ein Feature, kein Bugfix; ich halte dort also nicht an, außer du willst es.

## Folgen außerhalb der Unit-Tests

- **Checker-Snapshot** (`jul-examples`): `import/ts-file.ts` (`testfn1(par1: string)`) und die
  `dom.ts`-Dateien ändern ihre Typen, spätestens in Stufe 2. `npm run test-update-snapshot`,
  den Diff der beiden Baselines ansehen und nur erwartete Typänderungen übernehmen.
  LSP-Snapshot (`jul-language-server`, `npm run test-snapshot` nach `build-all`) analog.
- **yugioh:** nach `npm run build-all` jeweils
  `node ../JUL/jul-compiler/out/cli.js jul-config.yaml --check`. Erwartet wird, dass die 6
  `Or(Integer Fraction)`-Stellen zu `Integer` werden und keine neuen Fehler entstehen. Neue
  Fehler einzeln einordnen: echte TS/JUL-Diskrepanz (dann in yugioh anpassen) oder
  Übersetzungsfehler (dann im Parser beheben). Kandidaten für Stufe 2: `setUrlHash`, `setHtml`,
  `indexOf`, `saveRecordToDb` (`TableName` ist ein Alias → Any, unkritisch).
- **Bench:** Vor Stufe 1 und nach jeder Stufe
  `npm run bench -- --save --note "…"` im Compiler (Parser-Umbau, laut CLAUDE.md Pflicht).

## Doku

- Nach Freigabe diesen Plan als `jul-compiler/docs/typescript-import-types.md` ablegen,
  inklusive der offenen Frage zur Callback-Ausbaustufe.
- `jul-compiler/TODO`: Den yugioh-Punkt zu `countPreviousConsecutive` nach der Umsetzung
  aktualisieren. Neuer Punkt „TS-Callback-Typen übersetzen: Parameternamen-Vergleich klären“
  mit Verweis auf das Dokument.
- `jul-homepage`: Die Übersicht nennt TypeScript nur als Stichpunkt. Gibt es keine eigene Seite
  zu TS-Importen, bleibt die Homepage unverändert.

## Kritische Dateien

- `jul-compiler/src/parser/typescript-parser.ts` (einzige Code-Datei mit Logik-Änderung)
- `jul-compiler/src/parser/typescript-parser.test.ts`
- `jul-compiler/src/checker/checker-snapshot.baseline.txt`, `checker-stats.baseline.txt`
- `jul-language-server/scripts/snapshot.baseline.txt`
