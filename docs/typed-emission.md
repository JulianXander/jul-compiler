# Typgestützte Emission: Branching-Diskriminatoren und direkte Aufrufe

## Ausgangslage

`?(x)` wird zu `_branch(args, b1, b2, …)` ([emitter.ts](../src/emitter.ts), `case 'branching'`).
`_branch` ([runtime.ts](../src/runtime.ts)) probiert jeden Branch mit `tryAssignArgs`, also mit einem
vollständigen strukturellen Typcheck (`getTypeError`). Bei `x: Or([] MyComplexType)` wird so
`MyComplexType` Feld für Feld geprüft, obwohl nur `x !== undefined` zu entscheiden ist.

Benannte Argumente laufen über `_callFunction` → `assignArgs`: Der Emitter baut ein Dictionary, das die
Laufzeit wieder auf Positionen verteilt. Positionale Aufrufe (`f(1 2)`) sind schon direkte JS-Aufrufe.
`assignArgs` prüft keine Typen, Schritt 2 spart also das Umverteilen, keine Prüfung.

## Entscheidungen

- **Der Emitter vertraut den statischen Typen.** Das ist ein Implementierungsdetail, kein Sprachprinzip.
  Zur Laufzeit wird nur geprüft, was der statische Typ offen lässt (Any, Unknown). Falsche Deklarationen,
  etwa ein `nativeFunction` mit falschem Rückgabetyp oder ein `.ts`-Import, führen deshalb zu stillem
  Fehlverhalten statt zu einem Laufzeitfehler.
- **Die Laufzeitprüfung entscheidet nur noch, sie sichert nicht ab.** Welcher Branch gilt, steht erst zur
  Laufzeit fest. Dafür reicht der billigste Test, der die im Restbereich möglichen Fälle trennt. Die Optimierung
  lohnt sich auch bei der bestmöglichen Schreibweise, weil `_branch`, Closures und Argument-Arrays ebenfalls
  wegfallen. Eine Warnung, die zur billigeren Schreibweise rät, ersetzt sie deshalb nicht.
- **Benannte Argumente bleiben in freier Reihenfolge erlaubt**, wie in Python, C# und Kotlin. Der Inhalt der
  Argumentliste ist ein Dictionary, und Dictionaries sind ungeordnet. Die Auswertung folgt der geschriebenen
  Reihenfolge, umsortiert wird nur die Übergabe (wie in C#).
- Reihenfolge der Umsetzung: erst Branching, dann benannte Argumente.

## Schritt 1: Branching-Diskriminatoren

### Umfang (alles andere bleibt `_branch`)

- Genau ein geschriebenes Argument ohne Spread (`?(x)`), derselbe Fall wie `isBranchingExhaustive`.
  Bei mehreren Argumenten ist der Abzug früherer Branches je Index nicht korrekt, weil ein früherer Branch
  nur dann fängt, wenn *alle* Positionen passen.
- Jeder Branch ist ein `functionLiteral`, entweder mit Typ-Kopf (`[T] =>`) oder mit höchstens einem Parameter
  ohne rest (`(a: T) =>`, `() =>`).
- Kein Prädikat-Kopf (Funktionswert in Typ-Position, `getBranchPredicateFacts`).
- `args.typeInfo` ist vorhanden, der Argumenttyp ist weder Any noch unaufgelöst.

### `src/checker/branch-dispatch.ts`

Das Modul wird vom Emitter aufgerufen, nicht vom Checker. So kostet es im Language Server nichts, und
Checker-Snapshot und Zähler-Gate bleiben unberührt.

```ts
type BranchTest =
	| { kind: 'always' }                         // R_i ⊆ P_i
	| { kind: 'jsKind'; kinds: JsKind[] }       // typeof/Array.isArray/instanceof/=== undefined
	| { kind: 'literal'; value: bigint | string | boolean | number }
	| { kind: 'field'; name: string; test: BranchTest }; // unterscheidendes Feld (Stufe 1b)
export function getBranchDispatch(branching: ParseBranching): { tests: BranchTest[]; exhaustive: boolean } | undefined
```

Rechnung je Branch i, mit Funktionen aus [checker.ts](../src/checker/checker.ts), die dafür exportiert werden:

- `T` = `getElementTypeAtIndex(resolvePlaceholders(args.typeInfo.type), 0)`
- `P_i` = `getBranchArgumentType(getParamsType(…branch.typeInfo…), 0)`, undefined = catchAll
- `R_i` = `narrowBranchedType(T, undefined, getPreviousBranchArgumentType(branching, branch, 0))`
- Gilt `R_i ⊆ P_i` (`areArgsAssignableTo(undefined, R_i, P_i)` ohne Fehler) oder ist `P_i` catchAll, dann `always`.
  Alle folgenden Branches sind unerreichbar und werden nicht emittiert, `exhaustive = true`.
- Ist `P_i` ein Literaltyp, dann `literal`.
- Sonst werden `jsKinds(R_i ∩ P_i)` und `jsKinds(R_i ∩ ¬P_i)` berechnet. Sind beide bekannt und disjunkt, dann `jsKind`.
- Sonst `undefined` für das ganze Branching, also Rückfall auf `_branch`.

`jsKinds(type)` bildet auf JS-Laufzeitarten ab, passend zu `getTypeError`. Unbekannt ist konservativ `undefined`:
`empty→undefined`, `boolean(Literal)→boolean`, `integer(Literal)→bigint`, `float(Literal)→number`,
`text(Literal)→string`, `list/tuple/tupleOf→array`, `function→function`, `date/blob/error→instanceof`,
`dictionary/dictionaryLiteral/stream→object`, `or→Vereinigung`, `alias→auflösen`, `never→∅`,
alles andere (any, type, greater, and, not, Platzhalter, …) → `undefined`. Fraction ist zur Laufzeit ein
einfaches Objekt und fällt mit Dictionary unter `object`, beide lassen sich also nicht trennen.

Der Test muss nur auf `R_i` exakt sein. Getestet wird die Seite, deren Test ohne Ausschlüsse auskommt:
`object` allein ist nicht exakt, sobald die andere Seite Error, Date oder Blob enthält, denn auch das sind
Objekte. Dann wird die andere Seite negiert getestet (`!(x instanceof Error)`). Enthalten beide Seiten `object`,
geht es mit Stufe 1b weiter oder zurück auf `_branch`.

**Stufe 1b:** Feld-Diskriminator. Sind beide Seiten `object`, wird ein Feld gesucht, dessen Typen auf beiden
Seiten disjunkte Literale oder `jsKinds` haben. Daraus entsteht z. B. `s?.['kind'] === 'circle'` oder `s?.['z'] !== undefined`.

### Emitter

- Liefert `getBranchDispatch` ein Ergebnis, entsteht eine `?:`-Kette:
  - Ist das Argument eine `reference`, wird dessen JS direkt verwendet. Sonst `((_arg) => …)(argJs)`, damit es nur einmal ausgewertet wird.
  - Jeder Branch wird als Arrow aus `functionLiteralToJsParts(...).functionJs` aufgerufen, ohne `_createFunction`:
    mit `(argJs)`, beim Typ-Kopf mit `()`.
  - Ist der letzte Test nicht `always`, folgt `: _noBranchMatched(argJs)`. Das ist ein neuer Runtime-Helper mit der
    bisherigen Meldung aus `_branch`.
- Test-JS: `x !== undefined`, `typeof x === 'string'`, `Array.isArray(x)`, `x instanceof Date`, `x === 1n`,
  `x?.['kind'] === 'circle'`.
- `compiler.ts` emittiert aus `parsed.checked ?? parsed.unchecked`. Im CLI ist das dasselbe Objekt
  (`cloneUnchecked: false`), aber so ist sichtbar, dass die typeInfo gebraucht wird. Ohne typeInfo läuft alles wie bisher.

### Tests

Ein neuer Helfer `expectCheckedEmit(code, result)` in `emitter.test.ts` (`parseCode` → `checkTypes` →
`syntaxTreeToJs(parsed.checked.expressions)`), je ein `it`:

- Empty vs. komplexer Typ → `x !== undefined ? … : …`
- Text / List / Dictionary → `typeof` / `Array.isArray` / Rest
- Literal-Kopf → `=== 1n`
- nicht erschöpfend → `_noBranchMatched`
- Rückfälle: Prädikat-Kopf, zwei Argumente, untypisiertes Argument → weiter `_branch(`
- Stufe 1b: Tag-Feld → `x?.['kind'] === 'circle'`
- `getBranchDispatch` selbst in `checker/branch-dispatch.test.ts`

## Schritt 2: Direkte Aufrufe bei benannten Argumenten

In `case 'functionCall'` mit `args.type === 'dictionary'` wird statt `_callFunction(f, prefix, {…})` direkt
`f(prefix, a, b)` emittiert, wenn alles Folgende gilt:

- Die aufgerufene Funktion ist nachweislich eine **JUL-Funktion**. Eine JS-Funktion (`nativeFunction`) bekommt
  von `_callFunction` das Dictionary selbst. Erkennungsmerkmal ist `CompileTimeFunctionType.literal`
  ([syntax-tree.ts](../src/syntax-tree.ts)): Es ist nur bei Funktionsliteralen aus `.jul` gesetzt, und das Symbol
  behält den Typ des Werts. Der aufgelöste Typ von `functionExpression` muss also eine Funktion mit `literal` sein,
  deren `params.type === 'parameters'` ist und die keinen rest hat. Funktionswertige Parameter (deklarierter Typ, kein
  `literal`) und Unions von Funktionen fallen auf `_callFunction` zurück.
- Das Dictionary hat keine Spread-Felder.
- Zugeordnet wird nach `source ?? name`. Genau das legt der Checker als `ParametersType.singleNames[].name` ab, und die
  Laufzeit ordnet genauso zu (`assignArgs`). Fehlende Parameter werden zu `undefined`, überzählige Argumente fallen weg.
- Die Auswertung folgt der geschriebenen Reihenfolge. Weicht die Parameterreihenfolge ab und ist ein Argument weder
  Referenz noch Literal, werden die Ausdrücke in geschriebener Reihenfolge an ein Arrow übergeben, das sie in
  Parameterreihenfolge weiterreicht: `f(b = x() a = y())` → `((_b, _a) => f(_a, _b))(x(), y())`. Überzählige Argumente
  werden dabei trotzdem ausgewertet. Sonst entsteht direkt `f(a, b)`.
- Tests über `expectCheckedEmit`: gleiche Reihenfolge, umsortiert, fehlender Parameter, prefixArgument, `nativeFunction`
  (`log(a = 1)` bleibt `_callFunction`), nicht-triviales Argument in abweichender Reihenfolge, überzähliges nicht-triviales Argument.

## Später: Hinweis bei unvermeidbarer voller Prüfung

Findet `getBranchDispatch` auch mit Typwissen keinen billigen Test, bekommt der Branch einen Hinweis (Schweregrad Hint).
Ein Beispiel ist `Or(List(Integer) List(Or(Integer Text)))` mit Kopf `[List(Integer)]`: Die Entscheidung braucht jedes Element.
Die Meldung schlägt ein unterscheidendes Feld vor. Sie nutzt dieselbe Analyse und erscheint nie, wenn der Emitter einen
billigen Test gefunden hat.

## Verifikation

1. `node --run test` und `npm run typecheck`. Checker-Snapshot und Zähler-Gate bleiben unverändert.
2. `npm run build-all`, dann einige `jul-examples` bauen und ausführen und die Ausgaben vorher und nachher vergleichen.
3. `C:\Projects\privat\yugioh` bauen und ausführen, das Verhalten muss gleich bleiben.
4. `npm run bench-runtime -- --save` vor und nach jedem Schritt. Der Bench wertet die Fixtures unter
   `scripts/bench-runtime/` aus und misst die Laufzeit des erzeugten Codes, nicht Parse und Check.
5. `jul-language-server`: `npm test` und `npm run test-snapshot`.
