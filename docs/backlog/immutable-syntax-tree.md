# Unveränderlicher Syntaxbaum

Plan, entschieden am 2026-10-28. Schritt 0 umgesetzt, Schritt 1 (Gate) bestanden mit Knoten-Id und
Array, Schritte 2 bis 5 umgesetzt. Offen ist nur Schritt 6, ein eigener Entwurf.

## Stand

Bis Schritt 3 schrieb der Checker seine Ergebnisse in den Syntaxbaum, den der Parser geliefert hat:
`typeInfo` und `expectedType` an jedem Ausdruck, `calledFunctionType` und `calledParameterNames` an
Aufrufen, `typeInfo`, `functionRef` und `isUsed` an den Symbolen, Fehler in `errors`. Ausdrücke, die
schon eine `typeInfo` haben, überspringt er (`setInferredType`). Seit Schritt 4 steht all das im
`CheckResult`, der Checker schreibt nichts mehr in den Baum. Ein zweiter Check desselben Baums liefert
dasselbe Ergebnis (`check-result.test.ts`). Seit Schritt 5 prüfen Server und Tests einen Importeur
ohne Neuparsen (`recheckFile`), der Baum heißt `syntax` und seine Typen sind `readonly`.

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

### 1. Versuch zur Leistung (Gate, bestanden 2026-10-28)

Gate: höchstens +2 % auf parse+check (Median), sonst endet der Plan hier.

Versuch in einem Worktree auf Stand `6f39675`: Ein Codemod über die TypeScript-API ersetzte alle
171 Lesezugriffe auf die `typeInfo` von Ausdrücken (Checker, `branch-dispatch`, `constant-folding`,
`stream-lifetime`, `reference-index`, Emitter, Tests) durch `getTypeInfo(x)`, die eine Schreibstelle
in `setInferredType` durch `setTypeInfo`. Zugriffe auf Symbole blieben. Die Suite blieb grün
(1769 Tests, Checker-Snapshot und Zähler-Baseline unverändert), der Versuch prüft also identisch.

Gemessen A/B abwechselnd gegen das Feld am Knoten, yugioh, gemeinsame Dokumente, 7 Läufe je Runde:

| Variante | Runden | Median | Minimum |
|---|---|---|---|
| a0) globale `WeakMap` | 6 | +5,9 % | +4,6 % |
| a) `Map`, je Projektlauf neu (core-lib bleibt) | 6 | +2,9 % | +5,1 % |
| b) Knoten-Id und Array, je Projektlauf geleert | 6 | −0,6 % | +7,5 % |
| b) Wiederholung | 8 | +0,3 % | +6,2 % |

Das Minimum von b) hängt jeweils an einem einzelnen schnellen A-Lauf (733 bzw. 688 ms, die übrigen
A-Minima 754–844 ms). Der Median ist das belastbare Maß.

Entscheidung: **b), Knoten-Id und Array.** Im Versuch wurde die Id beim ersten Setzen an den Knoten
geschrieben (`nodeId`). Im Umbau vergibt sie der Parser beim Erzeugen (rund 90 Stellen in
`parser.ts`, `typescript-parser.ts` und `json-parser.ts`), damit bleibt die Form der Knoten stabil.
Die Ids sind je Datei dicht, die Tabelle gehört zum Prüfergebnis der Datei.

### 2. Zugriffsschicht (umgesetzt 2026-10-28, für Ausdrücke)

Neues Modul `checker/check-result.ts`: `CheckResult` und die Zugriffe `getTypeInfo`,
`getExpectedType`, `getCalledFunctionType`, `getCalledParameterNames` samt Settern, jeweils mit dem
Ergebnis als erstem Argument. Die Umsetzung liest und schreibt noch die Felder am Knoten.
`ParsedFile.checkResult` hält das Ergebnis des letzten Checks, `getFileCheckResult(file)` liefert es,
für eine nie geprüfte Datei ein leeres. Die Symbole folgen in Schritt 4.

Umgestellt über drei Skripte auf der TypeScript-API (Codemod der Lesestellen, Durchreichen als erster
Parameter bis zum Fixpunkt, Entfernen unbenutzter Parameter): im Compiler 182 Stellen, im Language
Server 27. Woher das Ergebnis kommt:

- Checker: `checkContext.result`. Funktionen ohne `checkContext` bekommen `checkResult` als ersten
  Parameter (21 in `checker.ts`).
- Emitter, `compiler.ts`, `bench-runtime.ts`: `getFileCheckResult(parsed)`.
- Language Server: `getHover`, `getSignatureHelp`, `getSemanticTokens` nehmen es aus der übergebenen
  Datei, die Handler in `server.ts` geben es nur weiter, wo ein bloßer Ausdruck übergeben wird.
- Tests: `parsed.checkResult!`, Test-Helfer, die intern parsen, geben es mit zurück.

**Befund: Typen zeigen über Dateigrenzen auf den Baum.** Ein Funktionstyp hält sein Literal
(`CompileTimeFunctionType.literal`), ein Dictionary-Literal-Typ seine Deklaration (`TypeDeclaration`).
Beide wandern mit dem Typ in andere Dateien. Wer darüber Typen im Baum liest, braucht das Ergebnis der
Herkunftsdatei, nicht das der gerade geprüften: die Konstantenfaltung (`buildEnvironment`, mitten in
`isTypeAssignable`) und `getFieldSymbolsFromDictionaryType` (Spread-Felder). Ein erster Anlauf, der das
Ergebnis einfach durchreichte, drang deshalb bis in `type-algebra.ts` vor und hätte ab Schritt 3 still
falsche Typen gelesen (verworfen, liegt als Stash). Lösung wie bei TypeScript, wo der Typ seine
Deklaration kennt: `literalResult` neben `literal` (gemeinsam gesetzt und über `getFunctionTypeFacts`
kopiert) und `TypeDeclaration.result`. `type-algebra.ts` bleibt unberührt. Ebenso liest der Typ eines
Imports aus dem Ergebnis der importierten Datei. `CompileTimeAliasType.symbol` ist die dritte solche
Verbindung, sie gehört zu Schritt 4.

Gemessen A/B gegen `6f39675` (gleicher yugioh-Stand, 6 Runden à 7 Läufe): Median +1,3 %, Zähler
identisch. B war in allen Runden etwas langsamer. Laut CPU-Profil kosten die Zugriffe selbst etwa
0,3 % (V8 bettet `setTypeInfo`/`getTypeInfo` nicht ganz ein), der Rest ist verteilt. Unter dem Gate,
die Summe mit Schritt 3 ist neu zu messen. Suite (1769), LSP-Snapshot und yugioh (Build, Tests) grün.

### 3. Ausdrücke umschalten (umgesetzt 2026-10-28)

Die Zugriffe aus Schritt 2 lesen und schreiben jetzt Tabellen im `CheckResult` (`typeInfos`,
`expectedTypes`, `calledFunctionTypes`, `calledParameterNames`), indiziert über die Knoten-Id. Die
Felder sind aus den AST-Typen gelöscht. Der TypeScript-Compiler meldete danach nur noch zwei Stellen in
Tests, der Codemod aus Schritt 2 hatte alles erfasst. Übersehen hatte er drei Abfragen zur Laufzeit im
Language Server (`'expectedType' in expression` in `util.ts`, `'typeInfo' in …` in `hover.ts` und
`completion.ts`), die ohne die Felder immer falsch waren. Gefunden haben sie 8 Tests in
`completion.test.ts`, nicht der Compiler.

- **Ids:** `setParentsAndIds` in `parser-utils.ts` (vorher `setParentsRecursive`) vergibt sie im
  nachgelagerten Durchlauf, der schon `parent` setzte: je Datei dicht ab 0 in Vorordnung, für alle
  Knoten einschließlich Namen. Eine Stelle in `parseFile` für `.jul`, TypeScript und JSON statt rund 90
  Stellen beim Bauen der Knoten. Die Id wird vor `parent` gesetzt, damit Wurzeln und Kinder dieselbe
  Kette von Formen durchlaufen. `ParsedFile.nodeCount` hält die Anzahl.
- **Tabellen:** In `createCheckResult` auf `nodeCount` angelegt und mit `undefined` gefüllt. In
  beliebiger Reihenfolge beschrieben bleibt das Array dicht, ein wachsendes würde bei Lücken zum
  Wörterbuch. Ein Knoten ohne Id wirft.
- **`coverageBeforeBranch`:** eine `Map` von der Id des branches im Ergebnis statt einer modulweiten
  `WeakMap`.
- **Fehler:** `CheckResult.errors` beginnt als Kopie von `unchecked.errors`, der Checker hängt an, die
  `#ignore`-Kommentare filtern zuletzt. `checked` ist eine flache Kopie von `unchecked` mit genau diesem
  Array als `errors`, Ausdrücke und Symbole sind dieselben. So lesen alle Leser von `checked.errors`
  (Compiler, Language Server, 32 Stellen in Tests) unverändert, `unchecked.errors` hält nur noch, was
  Parser und Loader melden. Abweichung vom Plan: Der `fileNotFound` aus `project-loader.ts` bleibt in
  `unchecked`. Er ist ein Ladefehler und gilt, bis die Datei neu geladen wird, nicht nur für einen
  Prüflauf.
- **Prüfung der Dateizugehörigkeit:** Mit `JUL_VERIFY_NODE_OWNERSHIP=1` hält das Ergebnis die Wurzeln
  der Datei, jeder Zugriff läuft die `parent`-Kette hoch und wirft bei einem fremden Knoten. Fest
  eingeschaltet in `test-setup.mjs` beider Pakete (die Suiten werden dadurch nicht spürbar langsamer),
  belegt durch `check-result.test.ts`. Die Suiten fanden keinen Zugriff mit falschem Ergebnis.
- **Parser-Tests:** Die von Hand gebauten erwarteten Bäume bekommen ihre Ids über dieselbe Funktion. In
  `dictionary-type` war `symbols.someKey.typeExpression` eine Kopie des Typguards, im Parser ist es
  dasselbe Objekt, jetzt auch im Test.

Gemessen A/B gegen `6f39675`, also Schritte 2 und 3 zusammen (yugioh, 6 Runden à 7 Läufe): Median
+0,8 %, Minimum −0,5 %, Zähler identisch. Damit unter dem Gate. Protokollierte Benches: Compiler
parse+check geteilt 737 → 718 ms, Language Server tippen → diagnostics 244 → 234 ms, Importeure
832 → 790 ms (im Rauschen). Suiten (Compiler 1772, Language Server 176), LSP-Snapshot und yugioh
(Build ohne Warnungen, 403 Tests) grün.

### 4. Symbole umschalten (umgesetzt 2026-10-28)

Typ, `functionRef` und Verwendung der Symbole stehen in Tabellen im `CheckResult`
(`symbolTypeInfos`, `functionRefs`, `usedSymbols`), Zugriffe `getSymbolTypeInfo`/`setSymbolTypeInfo`,
`getFunctionRef`/`setFunctionRef`, `isSymbolUsed`/`markSymbolUsed`. Die Felder sind aus
`SymbolDefinition` gelöscht, übrig bleibt dort nur, was der Parser setzt.

- **Ids:** `setParentsAndIds` vergibt sie für die Symboltabellen der Knoten im selben Durchlauf,
  `setFileSymbolIds` danach für die Tabelle der Datei, die erst nach dem Durchlauf entsteht. Ein
  erster Entwurf lief für die Symbole ein zweites Mal über den Baum, das kostete bei parse messbar.
  Zuerst teilten Symbole den Id-Raum der Knoten, seit Schritt 5 zählen sie getrennt
  (`ParsedFile.nodeCount`, `symbolCount`).
- **Welches Ergebnis:** Der Kern des Schritts, denn ein Symbol aus einer anderen Datei liest im eigenen
  Ergebnis still einen fremden Eintrag.
  - Im Checker kommt ein Symbol aus den Scopes entweder aus der eigenen Datei oder aus der core-lib.
    `dereferenceType` vergleicht dafür die Tabelle, in der es gefunden wurde, mit der der core-lib,
    nicht den Index 0: Ein Test, der die core-lib neu parst und prüft, hat an Index 0 seine eigene
    Tabelle. Den Fall hat die Prüfung der Dateizugehörigkeit sofort gefunden.
  - Der Import liest die Typen der exportierten Symbole aus `importedDocument.checkResult`.
  - `CompileTimeAliasType` trägt `symbolResult` neben `symbol`, wie `literalResult`. Damit lesen
    `type-algebra.ts`, die Konstantenfaltung und `reference-index.ts` über `getAliasSymbolType(alias)`.
    Das Ergebnis steht mit im Schlüssel des Interning, ein neuer Prüflauf bekommt also eigene Aliase.
  - Language Server: `getSymbolResult(fileResult, symbol)` und `getScopeSymbolTypeInfo` aus
    `checker.ts` für Symbole aus Scopes (core-lib per Menge der `builtInSymbols`), für gefundene
    Symbole mit Datei `getSymbolInfoTypeInfo` in `symbol-lookup.ts` über `SymbolInfo.filePath`.
- **Prüfung der Dateizugehörigkeit:** Für Symbole hält das Ergebnis in den Tests die Menge aller Symbole
  der Datei.
- **Tests:** `builtInSymbols[...].typeInfo` liest jetzt `getSymbolTypeInfo(coreLibCheckResult, …)`
  (`coreLibCheckResult` ist exportiert). Ein Alias-Test in `type-algebra.test.ts` baute ein leeres
  Symbol-Objekt, jetzt ein geparstes samt Ergebnis.

Danach schreibt der Checker nichts mehr in den Baum (gesucht nach Zuweisungen an Knoten und Symbole in
`checker.ts`, `stream-lifetime.ts`, `branch-dispatch.ts`, `constant-folding.ts`,
`reference-index.ts`). Ein neuer Test prüft denselben Baum zweimal und vergleicht Fehler und Typen, mit
Vorwärtsreferenz und ungenutzter Definition, die früher am Symbol hingen.

Gemessen A/B gegen `6f39675`, Schritte 2 bis 4 zusammen (6 Runden à 7 Läufe): Median +0,6 %, Minimum
−2,6 %, Zähler identisch. Die protokollierten Benches schwankten an diesem Nachmittag stark (derselbe
Stand parse 62 bis 74 ms). Der erste Eintrag zu Schritt 4 zeigt deshalb +15 %, der alte Stand lag
direkt danach gleichauf (parse+check 12 402 gegen 12 404 ms). Suiten (Compiler 1773, Language Server
176), LSP-Snapshot und yugioh (Build ohne Warnungen, 403 Tests) grün.

### 5. Aufräumen (umgesetzt 2026-10-28)

- **Recheck ohne Parsen:** `recheckFile(file, documents, host)` in `project-loader.ts` leert die
  Caches, löst die Abhängigkeiten auf und ruft `checkTypes` auf dem vorhandenen Baum.
  `recheckDocument` im Server und die Recheck-Tests in `reference-index.test.ts` nutzen es.
  - Caches: `clearTypeCaches` ist keine Frage der Korrektheit, sondern des Speichers (ein gemerkter
    Typ hält über Symbole ganze Bäume). `recheckFile` ruft es wie `loadFile`. Die Längen-Terme
    (`getPathLengthTerm`) hängen an der Identität der Symbole, die über Läufe gleich bleibt. Das ist
    korrekt: Ein Recheck läuft nur, wenn die Datei selbst unverändert ist, dasselbe Symbol bezeichnet
    also denselben Wert.
  - **Befund:** Das alte Neuladen löste nebenbei die Importe neu auf. Ein bloßes `checkTypes` hätte
    eine inzwischen gelöschte Abhängigkeit still als `Any` importiert, ohne `fileNotFound`. Deshalb
    zieht `fileNotFound` doch aus `syntax.errors` aus, wie ursprünglich geplant (in Schritt 3 war er
    dort geblieben): `ParsedFile.loadErrors`, bei jedem Laden und Recheck neu gesetzt
    (`loadDependencies`), das `CheckResult` übernimmt sie nach den Parse-Fehlern. Test in
    `project-loader.test.ts`: Abhängigkeit gelöscht, Recheck meldet sie, wieder da, Recheck vergisst
    sie, alles ohne Neuparsen.
- **`unchecked` heißt `syntax`** (rund 110 Stellen samt Skripten), Kommentare zum alten Klon angepasst.
- **AST-Typen `readonly`:** alle Felder der Knoten und von `SymbolDefinition` außer `parent` und `id`,
  die der Parser nachgelagert setzt (105 Felder, Arrays darin bleiben veränderlich). Der Compiler
  meldete nur fünf Schreibstellen:
  - Der Parser hängte bei mehrzeiligem Text `'\n'` an einen schon gebauten `TextToken` an. Der kann aus
    einem Teilergebnis stammen, das der Parser mehrfach durchläuft. Jetzt wird er ersetzt.
  - Vier Parser-Tests bauen zyklische erwartete Bäume (Symbol ↔ Definition), dafür ein Helfer
    `setDefinition`.
- **Doku:** Abschnitt „Architektur" und Language Server in `JUL/CLAUDE.md`.

**Leistung.** Das A/B gegen `6f39675` lag nach diesen Punkten bei +1,6 % und +2,8 %, also am bzw.
über dem Gate, obwohl Schritt 5 am Prüfpfad kaum etwas ändert. Die Rundenmediane schwankten um ±5 %,
die Reihenfolge von A und B kippte. Deshalb ein zweites Messverfahren: beide Compiler im selben Prozess,
abwechselnd, 30 bis 60 Paare, Median der Verhältnisse je Paar (Skript `ab-same.mts` im Scratchpad).
Ergebnis: Parsen +4 % (rund 2 ms bei 56 ms), Prüfen und Parsen zusammen +2,7 %. Behoben:

- `'symbols' in expression` an jedem Knoten war bei den vielen Knotenformen teuer, jetzt
  `getNodeSymbols` mit `switch` über `type`.
- Getrennte Id-Räume für Knoten und Symbole: Symbole sind in yugioh 16 % der Ids (19 856 von
  123 665), ihre drei Tabellen hatten aber eine Zeile je Knoten.
- Tabellen per `push` statt `new Array(n).fill()`: gepackt statt „holey", und V8 legt `new Array` mit
  großer Länge als Wörterbuch an.
- Der Interning-Schlüssel des Alias nahm `getObjectId(symbolResult)`, eine `WeakMap` je Referenz auf
  einen Typnamen. Jetzt eine laufende Nummer `CheckResult.id`.
- Die Zugehörigkeitsprüfung hängt an der Modulkonstante statt an `result.roots`, ohne Prüfung kostet
  der Zugriff so keinen Ladebefehl.

Danach im selben Prozess +0,7 % (40 Paare), mit getrennten Prozessen +1,5 % Median, Minimum −0,1 %
(8 Runden à 7 Läufe), Zähler identisch. Language Server: tippen → importeure fertig 816 → 759 ms. Suiten
(Compiler 1774, Language Server 176), LSP-Snapshot und yugioh (Build ohne Warnungen, 403 Tests) grün.

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
