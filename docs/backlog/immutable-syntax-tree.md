# Unveränderlicher Syntaxbaum

## Stand

Der Checker schreibt seine Ergebnisse in den Syntaxbaum, den der Parser geliefert hat: `typeInfo` und
`expectedType` an jedem Ausdruck, `calledFunctionType` an Aufrufen, `typeInfo`, `functionRef` und
`isUsed` an den Symbolen. Damit der Parser-Baum (`ParsedFile.unchecked`) dabei unverändert bleibt,
klont `checkTypes` ihn vorher (`structuredClone`, Option `cloneUnchecked`). Der Language Server braucht
das, weil `recheckDependents` dieselbe Datei erneut prüft, ohne neu zu parsen. Die CLI setzt
`cloneUnchecked: false` und prüft den Baum direkt.

## Folgen

- Der Klon ist der größte Einzelposten im Check einer großen Datei: im Profil von `game-logic.jul`
  (2869 Zeilen) etwa 13 % Eigenzeit, rund 16 ms pro Check. Zum Vergleich: Parsen dauert dort etwa 15 ms,
  der Check insgesamt etwa 94 ms. Der Klon fällt bei jeder Änderung an und bei jedem Check eines
  Importeurs.
- Ein Baum, der nach dem Parsen unverändert bliebe, könnte ohne Klon von beliebig vielen Checks
  gelesen werden.
- `unchecked` und `checked` sind zwei Bäume mit derselben Form, aber unterschiedlichen Feldern. Wer
  einen Knoten in der Hand hält, muss wissen, aus welchem er stammt.

## Was der Checker schreibt und wer es liest

Gezählt wurde in `jul-compiler/src` und `jul-language-server/src`, ohne Tests.

| Feld | Geschrieben | Lesestellen |
|---|---|---|
| `expression.typeInfo` | `checker.ts` (`setInferredType`) | 98 in `checker.ts`, 13 in `semantic-tokens.ts`, 8 in `server.ts`, 6 in `util.ts`, 3 im Emitter, dazu `hover`, `completion`, `symbol-lookup`, `stream-lifetime`, `constant-folding`, `reference-index`, `branch-dispatch`, `type-algebra` |
| `expression.expectedType` | `checker.ts` | 18 in `checker.ts`, 3 im Language Server |
| `call.calledFunctionType` | `checker.ts` | `hover.ts` |
| `symbol.typeInfo`, `symbol.functionRef`, `symbol.isUsed` | `checker.ts` an den Symbolen | `checker.ts`, `server.ts`, `util.ts` und weitere |

Das sind rund 140 Lesestellen. Die Felder sind schmal, aber breit verteilt.

## Entwurf (Skizze, nicht entschieden)

1. **Der Parser liefert einen Baum, der danach nicht mehr verändert wird.** Jeder Knoten bekommt beim
   Parsen eine dichte numerische `id` (Reihenfolge des Parsens).
2. **Das Prüfergebnis ist ein eigener Wert:** `checkFile(syntaxTree, ergebnisseDerImporte)` liefert ein
   `CheckResult` mit `typeOf`, `expectedType`, `calledFunctionType` und den Symbolinformationen, indiziert
   über die Knoten-`id` (Arrays statt `Map`), dazu die Fehler. `ParsedFile.checked` hält dieses
   Ergebnis, nicht mehr einen zweiten Baum.
3. **Leser** (Checker selbst, Language Server, Emitter) fragen das Ergebnis, statt Felder am Knoten zu
   lesen: `checked.typeOf(expression)` statt `expression.typeInfo`. Die Felder verschwinden aus den
   AST-Typen.
4. **Der Klon entfällt**, weil `unchecked` nie verändert wird. Ein erneuter Check erzeugt nur ein neues
   `CheckResult`.

## Vorbilder

- **TypeScript:** Knoten bleiben nach dem Parsen praktisch unverändert. Der Checker schreibt in
  Seitentabellen, die über eine Knoten-`id` indiziert werden (`nodeLinks`, `symbolLinks`). Das Programm
  wird bei einer Änderung neu aufgebaut und verwendet unveränderte Quelldateien samt Syntaxbaum wieder.
- **Roslyn:** Syntaxbäume sind unveränderlich. Bindungsergebnisse leben in einem `SemanticModel`, das
  Knoten als Schlüssel nimmt.
- **rust-analyzer:** Inferenzergebnisse sind ein Rückgabewert (`InferenceResult` je Funktionsrumpf),
  keine Annotation am Baum.

## Risiken und Offenes

- **Leistung der Lesestellen:** Der Checker liest `typeInfo` an 98 Stellen in seiner heißen Schleife. Ein
  Arrayzugriff über die `id` ist langsamer als ein Objektfeld, ein `Map`-Zugriff erst recht. Ob die
  gesparten etwa 16 ms Klon mehr sind als die zusätzlichen Zugriffe, ist nicht gemessen. Vor einem
  Umbau sollte ein Versuch an einem Teil (zum Beispiel nur `typeInfo`) zeigen, ob die Rechnung
  aufgeht.
- **Referenzindex und Language Server** halten Knoten des gecheckten Baums und lesen deren Felder.
  Beide müssten auf Knoten-`id` und `CheckResult` umgestellt werden.
- **Symboltabellen:** Die Symbole hängen an Knoten (`expression.symbols`) und werden vom Parser
  aufgebaut. Der Checker ergänzt sie (`typeInfo`, `functionRef`, `isUsed`). Sie müssten zwischen
  Parser-Ergebnis (unveränderlich) und Prüfergebnis (an der Seite) aufgeteilt werden.
- **Entscheidung über den Weg des Klons:** Kleinere Alternative ohne Umbau des Baums: ein frisch
  geparster Baum wird direkt gecheckt (kein Klon), `ParsedFile` merkt sich den Quelltext, und ein
  erneuter Check parst neu, statt einen unveränderten Baum zu klonen. Das spart den Klon beim ersten
  Check einer Datei. Für den erneuten Check (Importeure) tauscht es Klon gegen Parse; bei
  `game-logic.jul` sind beide etwa gleich teuer (Parse 15 ms, Klon etwa 16 ms), bei den Importeuren
  nicht gemessen.

## Zusammenhang mit anderen Dokumenten

[immutable-function-types.md](immutable-function-types.md) macht die Typen selbst unveränderlich
(`FunctionIdentity`, Konstruktor mit Fakten). Das ist unabhängig von diesem Dokument: Dort geht es um
die Werte, hier um den Baum, an dem sie hängen.

## Nächste Schritte

1. Messen, was Klon und Parse pro Datei bei den fünf Importeuren des yugioh-Projekts kosten. Das
   entscheidet, ob die kleine Alternative genügt.
2. Wenn der Baum selbst unveränderlich werden soll: einen Versuch in einer Kopie für nur `typeInfo`
   machen und Zeit und Umfang gegen den Klon halten.
3. Entscheiden. Fällt die Entscheidung, gehört das Ergebnis in ein eigenes Dokument in `docs/`.
