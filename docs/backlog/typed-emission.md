# Typgestützte Emission: Branching-Diskriminatoren und direkte Aufrufe

## Ausgangslage

`?(x)` wird zu `_branch(args, b1, b2, …)` ([emitter.ts](../src/emitter.ts), `case 'branching'`).
`_branch` ([runtime.ts](../src/runtime.ts)) probiert jeden Branch mit `tryAssignArgs`, also mit einem
vollständigen strukturellen Typcheck (`getTypeError`). Bei `x: Or([] MyComplexType)` wird so
`MyComplexType` Feld für Feld geprüft, obwohl nur `x !== undefined` zu entscheiden ist.

Benannte Argumente liefen ursprünglich über `_callFunction` → `assignArgs`: Der Emitter baute ein Dictionary, das die
Laufzeit wieder auf Positionen verteilte. Positionale Aufrufe (`f(1 2)`) sind direkte JS-Aufrufe. Seit Schritt 2 sind
es auch die benannten, `_callFunction` und `assignArgs` gibt es nicht mehr.

## Entscheidungen

- **Der Emitter vertraut den statischen Typen.** Das ist ein Implementierungsdetail, kein Sprachprinzip.
  Zur Laufzeit wird nur geprüft, was der statische Typ offen lässt (Any, Unknown). Falsche Deklarationen,
  etwa ein `nativeFunction` mit falschem Rückgabetyp oder ein `.ts`-Import, führen deshalb zu stillem
  Fehlverhalten statt zu einem Laufzeitfehler.
- **Die Laufzeitprüfung entscheidet nur noch, sie sichert nicht ab.** Welcher Branch gilt, steht erst zur
  Laufzeit fest. Dafür reicht der billigste Test, der die im Restbereich möglichen Fälle trennt. Die Optimierung
  lohnt sich auch bei der bestmöglichen Schreibweise, weil `_branch`, Closures und Argument-Arrays ebenfalls
  wegfallen. Eine Warnung, die zur billigeren Schreibweise rät, ersetzt sie deshalb nicht.
- **Benannte Argumente stehen in der Reihenfolge der Parameter.** Ein Aufruf mit Namen ist ein positionaler
  Aufruf mit Beschriftung: Der Checker prüft die Namen und ihre Reihenfolge (JUL2501), zur Laufzeit ordnet nichts
  zu. Auslassen bleibt erlaubt, wo der Parametertyp Empty zulässt. Das ersetzt die frühere Entscheidung „freie
  Reihenfolge wie in Python, C# und Kotlin": Sie brauchte `params` an jeder Closure (die Laufzeit musste nach Namen
  zuordnen) oder Temporaries, damit die Auswertung in geschriebener Reihenfolge blieb, und nirgends in yugioh
  oder den Beispielen wurde sie gebraucht. Ein Spread in der Argumentliste ist nur noch mit einer List zulässig
  (JUL2502), ein Dictionary hat keine Reihenfolge. Der Aufruf eines `Any`-Werts bekommt eine Warnung (JUL5011),
  benannte Argumente gehen dort der Reihe nach, ohne Namen.
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
Checker-Snapshot und Zähler-Gate bleiben unberührt. Der Emitter nutzt es nur beim Emittieren einer ganzen
Datei (`syntaxTreeToJs`), nicht beim Constant Folding mitten im Checklauf (`functionLiteralToEvaluableJs`).

`getBranchDispatch(branching)` liefert je Branch einen Test und ob das Branching erschöpfend ist, oder
`undefined` für den Rückfall auf `_branch`:

| Test | bedeutet | JS |
|---|---|---|
| `always` | fängt alles, was noch möglich ist; folgende Branches entfallen | kein Test |
| `never` | fängt nichts mehr von dem, was noch möglich ist | Branch entfällt |
| `jsKind` | Laufzeitart, direkt oder negiert | `x !== undefined`, `typeof x === 'string'`, `Array.isArray(x)`, `x instanceof Date` |
| `literal` | Literal-Kopf | `x === 1n`, `x === 'a'` |
| `field` | unterscheidendes Feld mit Literaltyp | `x?.['kind'] === 'circle'` |

**Rechnung.** Der Argumenttyp wird in seine Glieder zerlegt (Or aufgelöst, Aliase aufgelöst, Never entfernt).
Je Branch mit gefordertem Typ `P` wird jedes noch mögliche Glied eingeordnet:

- Seine Laufzeitart kommt in `P` nicht vor: sicher **verfehlt**.
- Es ist Teilmenge von `P`: sicher **gefangen**.
- Sonst **unentschieden**.

Aus den gefangenen und verfehlten Gliedern ergibt sich der Test. Die gefangenen scheiden danach aus, der Rest
geht an den nächsten Branch. Bleibt nach einem Branch nichts übrig, wird sein Test zu `always`, auch wenn der
Test allein das nicht sagt (letztes Literal einer Literal-Union).

- **Literal-Kopf:** `x === literal` ist für jeden Wert exakt. Der Rest bleibt dabei bewusst zu groß (Integer statt
  Integer ohne 1): ein Test, der auf einer Obermenge exakt ist, ist es auch auf dem Rest.
- **Art-Test:** nur ohne unentschiedene Glieder und wenn gefangene und verfehlte Glieder keine Laufzeitart teilen.
  Getestet wird die billigere Seite (undefined vor typeof vor `Array.isArray`/`instanceof`), bei Gleichstand die
  gefangene. `object` hat keinen exakten Einzeltest, auch Array, Date und Error sind Objekte; die Seite mit `object`
  scheidet deshalb aus.
- **Feld-Test:** wenn alle noch möglichen Glieder Dictionaries sind und `P` ein Feld mit Literaltyp fordert, das jedes
  Glied als Literal festlegt. Gleiches Literal gilt als gefangen, sofern das Glied `P` ganz erfüllt.
- Sonst Rückfall auf `_branch` für das ganze Branching.

**Any macht ein Glied unbrauchbar.** Die Teilmengenprüfung des Checkers ist für `Any` permissiv, sie hält
`[a: Any]` für eine Teilmenge von `[a: Integer]`. Ein Glied, das irgendwo `Any` oder einen unbekannten Typ enthält,
führt deshalb zum Rückfall.

Laufzeitarten, passend zu `getTypeError` in der Runtime: `empty→undefined`, `boolean(Literal)→boolean`,
`integer(Literal)→bigint`, `float(Literal)→number`, `text(Literal)→string`, `list/tuple→array`, `function→function`,
`date/blob/error→instanceof`, `dictionary/dictionaryLiteral/stream→object`. Alles andere ist unbestimmt. Fraction ist
zur Laufzeit ein einfaches Objekt und fällt mit Dictionary unter `object`.

### Emitter

- Eine `?:`-Kette, flach hintereinander. Ist das Argument eine `reference`, wird dessen JS direkt verwendet. Sonst
  `((_arg) => …)(argJs)`, damit es genau einmal ausgewertet wird.
- Jeder Branch wird als Arrow an Ort und Stelle aufgerufen, ohne `_createFunction`: mit `(argJs)`, wenn er einen
  Parameter bindet, sonst mit `()`.
- Ist das Branching nicht erschöpfend, endet die Kette mit `_noBranchMatched(argJs)`, einem Runtime-Helper mit der
  bisherigen Meldung aus `_branch`.
- `compiler.ts` emittiert aus `parsed.checked ?? parsed.unchecked`. Im CLI ist das dasselbe Objekt
  (`cloneUnchecked: false`), aber so ist sichtbar, dass die typeInfo gebraucht wird.

## Schritt 2: Direkte Aufrufe bei benannten Argumenten (umgesetzt)

In `case 'functionCall'` mit einem Dictionary als Argumentliste schreibt der Emitter `f(…)` positional
(`namedArgumentsToDirectCallJs`). Die Namen kommen vom Checker (`calledParameterNames`: die Parameternamen des
aufgerufenen Funktionstyps, `source ?? name`), also für jede Funktion mit bekannter Signatur: JUL-Literal,
Builtin, Funktionswert, importierte Funktion. Bei einem rekursiven Aufruf, dessen eigener Typ noch nicht feststeht,
kommen sie vom Funktionsliteral.

- Das prefixArgument belegt den ersten Parameter, ein benanntes Argument für ihn fällt weg (JUL2500).
- Ein ausgelassener Parameter in der Mitte wird `undefined`, am Ende entfällt er.
- Die Namen stehen in Parameterreihenfolge, die Auswertung folgt also der geschriebenen. Nur ein Argument ohne
  Parameter (JUL2500) muss trotzdem ausgewertet werden: Steht ein nicht-triviales davon im Aufruf, gehen alle
  Argumente in geschriebener Reihenfolge an ein Arrow, das sie weiterreicht.
- Ohne bekannte Parameterliste (Typ `Any`) gehen die Werte der Reihe nach an die Funktion.
- Ein Funktionsliteral bekommt `params` nur noch, wenn die Laufzeit sie liest (`needsRuntimeParams`): bei
  Typ-Kopf, Parametertypen und als Branch von `_branch`. Alle anderen sind nackte Arrows.

## Messung

`npm run bench-runtime` (ms je eine Million Aufrufe, Median):

| Fall | vorher | Schritt 1 | Schritt 2 |
|---|---|---|---|
| `emptyOrComplex` | 3783 | 4,8 | 3,8 |
| `textListOrDictionary` | 8922 | 7,8 | 6,8 |
| `tagField` | 4462 | 8,3 | 7,7 |
| `positional` | 8,1 | 7,9 | 6,5 |
| `namedInOrder` | 38,7 | 34,7 | 6,0 |
| `namedSwapped` | 39,1 | 35,6 | 6,2 |

Der Fall `namedSwapped` ist entfallen (umsortierte Argumente sind seit JUL2501 ein Fehler). In yugioh laufen nach
Schritt 1 70 von 249 Branchings weiter über `_branch`.

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
