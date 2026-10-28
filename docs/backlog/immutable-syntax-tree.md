# Unveränderlicher Syntaxbaum

Plan, entschieden am 2026-10-28. Schritt 0 umgesetzt, ab Schritt 1 offen.

## Stand

Der Checker schreibt seine Ergebnisse in den Syntaxbaum, den der Parser geliefert hat: `typeInfo` und
`expectedType` an jedem Ausdruck, `calledFunctionType` und `calledParameterNames` an Aufrufen,
`typeInfo`, `functionRef` und `isUsed` an den Symbolen, Fehler in `errors`. Ausdrücke, die schon eine
`typeInfo` haben, überspringt er (`setInferredType`). Wer dieselbe Datei ein zweites Mal prüfen will,
braucht deshalb einen frischen Baum.

Bis 2026-10-28 klonte der Language Server dafür bei **jedem** Check den Baum (`structuredClone`,
`cloneUnchecked: true`), obwohl nur das erneute Prüfen eines Importeurs ihn brauchte. Seit Schritt 0
gibt es keinen Klon mehr, auch die Option ist entfernt: `checkTypes` prüft immer den frisch geparsten
Baum direkt, und der Server parst für einen Recheck neu (`recheckDocument` in
`jul-language-server/src/server.ts`), aus dem Editor-Inhalt oder von der Platte. Tests, die eine Datei
erneut prüfen, laden sie dafür mit demselben Code neu (`reference-index.test.ts`).

Gemessen (`npm run bench` im Language Server, yugioh, Median):

| | vorher | nachher |
|---|---|---|
| didChange → diagnostics | 306 ms | 264 ms (−14 %) |
| tippen → diagnostics | 290 ms | 236 ms (−19 %) |
| dauertippen → diagnostics | 301 ms | 254 ms (−16 %) |
| tippen → importeure fertig | 865 ms | 809 ms (−6 %) |

## Warum trotzdem weiter

Nach Schritt 0 ist der verbleibende Leistungsgewinn klein: Ein Recheck spart noch das Parsen der
Importeure. Der Umbau ist vor allem eine Investition in die Architektur:

- **Ein Ergebnis je Prüflauf statt eines veränderten Baums.** Zwei Prüfläufe auf demselben Baum
  stören sich nicht. Der Server könnte Hover und Completion aus dem letzten fehlerfreien Ergebnis
  beantworten, während ein neuer Lauf rechnet.
- **Keine verdeckte Kopplung.** „Hat schon `typeInfo`, also überspringen", Fehler, die im Baum hängen
  bleiben, und Zustand in modulweiten `WeakMap`s über Knoten (`coverageBeforeBranch` in `checker.ts`)
  gelten heute stillschweigend nur für den ersten Lauf auf einem Baum.
- **Grundlage für inkrementelles Prüfen** je Definition (wie rust-analyzer). Erst das macht große
  Dateien wie `yugioh/src/game-logic/game-logic.jul` (5690 Zeilen) im Editor wirklich schnell.
- `unchecked` und `checked` sind heute dasselbe Objekt oder ein Klon mit anderen Feldern. Wer einen
  Knoten hält, muss wissen, aus welchem Baum er stammt.

## Vorbilder

- **TypeScript:** Knoten bleiben nach dem Binden praktisch unverändert. Der Checker schreibt in
  Seitentabellen, die über eine Knoten-`id` indiziert werden (`nodeLinks`, `symbolLinks`). Das Programm
  wird bei einer Änderung neu aufgebaut und verwendet unveränderte Quelldateien samt Syntaxbaum wieder.
- **Roslyn:** Syntaxbäume sind unveränderlich. Bindungsergebnisse leben in einem `SemanticModel`, das
  Knoten als Schlüssel nimmt.
- **rust-analyzer:** Inferenzergebnisse sind ein Rückgabewert (`InferenceResult` je Funktionsrumpf,
  über `ExprId`), keine Annotation am Baum. Salsa rechnet nur neu, was sich geändert hat.
- **Go (`go/types`):** `types.Info` mit Maps über `ast.Expr`.
- Gegenbeispiele mit Typen am Knoten (Swift, Clang, Kotlin FIR) parsen für einen neuen Lauf neu oder
  sperren je Phase. Das ist der heutige Stand von Jul.

## Was der Checker schreibt und wer es liest

Gezählt am 2026-10-28 in `jul-compiler/src` und `jul-language-server/src`.

| Feld | Geschrieben | Gelesen |
|---|---|---|
| `expression.typeInfo` | `setInferredType` | Checker (rund 100 Stellen, heiße Schleife), Language Server (`semantic-tokens`, `completion`, `util`, `hover`, `server`, `signature-help`, `symbol-lookup`), Emitter (2), `branch-dispatch`, `constant-folding`, `stream-lifetime`, `reference-index`, `type-algebra` |
| `expression.expectedType` | `setInferredType` | Checker, Language Server |
| `calledFunctionType`, `calledParameterNames` | `checker.ts` (Aufruf) | `hover.ts`, Checker |
| `symbol.typeInfo`, `symbol.functionRef`, `symbol.isUsed` | `checker.ts` | Checker, Language Server, `reference-index` |
| `errors` | Parser und Checker in dasselbe Array, `project-loader` (`fileNotFound`) | `compiler.ts`, Language Server |

Zusammen rund 190 Stellen außerhalb der Tests (147 im Compiler, 43 im Language Server), dazu
78 in Tests. Außerdem modulweiter Prüfzustand über Knoten in `checker.ts`: `coverageBeforeBranch`
(hängt von Typen ab, gehört ins Ergebnis), `completedNamesByScope` und `completedNamesByBody` (rein
syntaktisch, dürfen am Baum hängen bleiben).

Nicht betroffen: `FunctionIdentity` (`sealed`, `ParamsType`) ist Teil der Typen, nicht des Baums, siehe
[immutable-function-types.md](immutable-function-types.md).

## Zielbild

- `ParsedFile.syntax` (heute `unchecked`): der Baum aus dem Parser, nach dem Parsen nie verändert, in
  TypeScript `readonly`. Parse-Fehler gehören dazu.
- `ParsedFile.checked: CheckResult`: ein eigener Wert je Prüflauf mit `typeOf(expression)`,
  `expectedTypeOf(expression)`, `calledFunctionOf(call)`, `symbolTypeOf(symbol)`, `isUsed(symbol)`,
  den Prüffehlern und dem Prüfzustand, der heute in modulweiten `WeakMap`s steckt.
- `checkTypes(syntax, documents, options)` liefert das `CheckResult` zurück, statt den Baum zu
  verändern.
- Ein Recheck im Server ruft nur `checkTypes` erneut auf, ohne zu parsen.
- Importeure lesen die Typen einer importierten Datei aus deren `CheckResult`.

## Schritte

Jeder Schritt einzeln: Bench vor und nach (`npm run bench -- --save` im Compiler und im Language
Server), Suite und Snapshots grün, yugioh baut und testet.

### 0. Klon weg (umgesetzt 2026-10-28)

Siehe Stand. `structuredClone` und die Option `cloneUnchecked` sind gelöscht, der Server parst für
einen Recheck neu.

### 1. Versuch zur Leistung (Gate)

In einer Kopie nur `expression.typeInfo` im Checker auf eine Seitentabelle im `CheckContext` umstellen,
alles andere bleibt. Zwei Varianten gegeneinander und gegen den heutigen Stand messen, per A/B
abwechselnd auf demselben yugioh-Stand:

- a) `Map<Knoten, TypeInfo>` je Prüflauf, ohne Änderung am Parser.
- b) Dichte Knoten-`id` (für den Versuch in einem Durchlauf nach dem Parsen vergeben), Tabelle als
  Array.

Gate: höchstens +2 % auf parse+check (Median). Wird es von beiden Varianten verfehlt, endet der Plan
hier, Schritt 0 bleibt der Stand. Sonst die billigere Variante nehmen. Bei b) vergibt ab Schritt 3 der
Parser die `id` (rund 90 Stellen, die Knoten erzeugen, in `parser.ts`, `typescript-parser.ts` und
`json-parser.ts`).

### 2. Zugriffsschicht

Neues Modul `checker/check-result.ts` mit `CheckResult` und den Zugriffen aus dem Zielbild. Die erste
Umsetzung liest und schreibt weiter die Felder am Knoten, das Verhalten ändert sich nicht.

Alle Lese- und Schreibstellen auf die Zugriffe umstellen. Die eigentliche Arbeit ist, das `CheckResult`
überall hinzureichen:

- Checker: über den `CheckContext`.
- Emitter: aus `ParsedFile.checked`.
- Language Server: Funktionen in `util.ts`, `completion.ts`, `semantic-tokens.ts` usw., die heute nur
  einen Ausdruck bekommen, bekommen das Ergebnis dazu.
- Tests: ein Hilfszugriff je Testdatei.

Rein mechanisch, aber der größte Schritt. Der Bench muss unverändert bleiben (die Zugriffe werden
inline).

### 3. Ausdrücke umschalten

Die Zugriffe für Ausdrücke (`typeOf`, `expectedTypeOf`, `calledFunctionOf`) auf die Seitentabelle aus
Schritt 1 umstellen und die Felder aus den AST-Typen löschen: Was der TypeScript-Compiler danach noch
meldet, ist übersehen worden. `setInferredType` prüft die Tabelle statt des Felds.
`coverageBeforeBranch` zieht ins Ergebnis.

Fehler trennen: Parse-Fehler bleiben am Baum, Prüffehler kommen ins Ergebnis, der `fileNotFound` aus
`project-loader.ts` ebenfalls. Leser (`compiler.ts` zweimal, Language Server) verbinden beide Listen.

### 4. Symbole umschalten

`symbolTypeOf`, `functionRef`, `isUsed` an die Seite. Hier liegt der Teil über Dateigrenzen: Der
Checker liest die Typen importierter Symbole (`case` für `import` um `parsedDocuments[fullPath]` in
`checker.ts`), der Language Server in `symbol-lookup.ts`, `reference-index.ts` ebenso. Sie lesen aus
dem `CheckResult` der importierten Datei, nicht aus dem eigenen. Die core-lib wird beim Modul-Load einmal
geprüft, ihr Ergebnis bleibt modulweit.

### 5. Aufräumen

- Die Recheck-Tests in `reference-index.test.ts` prüfen wieder mit `checkTypes` statt neu zu laden.
- `recheckDocument` im Server ruft `checkTypes` auf dem vorhandenen Baum auf statt `loadFile` mit
  neuem Parsen. Dabei klären, welche Caches ein Recheck leeren muss: `loadFile` ruft heute
  `clearTypeCaches`, ein bloßes `checkTypes` nicht. Die Längen-Terme (`getPathLengthTerm`) hängen an
  der Identität der Symbole, die jetzt über Läufe hinweg gleich bleibt.
- `unchecked` in `syntax` umbenennen, AST-Typen `readonly`.
- Doku: Abschnitt „Architektur" in `JUL/CLAUDE.md` („Der Checker schreibt `checked`-Ausdrücke samt
  `TypeInfo` in dasselbe `ParsedFile` zurück") anpassen.

### 6. Später, eigener Entwurf

Hover und Completion aus dem letzten fehlerfreien Ergebnis, inkrementelles Prüfen je Definition.

## Risiken

- **Leistung der Lesestellen:** Der Gate in Schritt 1 entscheidet. Ein Feldzugriff ist das billigste,
  was V8 kann. Jede Tabelle kostet etwas, offen ist nur, wie viel.
- **Umfang von Schritt 2:** Rund 270 Stellen samt Tests. Mechanisch, aber nur sinnvoll in einem Zug je
  Paket, sonst existieren beide Zugriffsarten lange nebeneinander.
- **Speicher im Server:** Eine Tabelle je Datei statt Feldern am Baum. Bei Variante b) Arrays mit
  Lücken für Knoten ohne Typ.
- **Verdeckte Annahmen über frische Bäume:** Außer `coverageBeforeBranch` kann es Stellen geben, die
  sich darauf verlassen, dass jeder Lauf einen neuen Baum sieht (Caches über Knoten oder Symbole). Vor
  Schritt 5 gezielt suchen: `WeakMap`/`Map` mit Knoten- oder Symbolschlüssel, `getObjectId`.

## Zusammenhang mit anderen Dokumenten

[immutable-function-types.md](immutable-function-types.md) macht die Typen selbst unveränderlich
(`FunctionIdentity`, Konstruktor mit Fakten). Das ist unabhängig von diesem Dokument: Dort geht es um
die Werte, hier um den Baum, an dem sie hängen.
