# Typalgebra aus checker.ts auslagern

## Kontext

`jul-compiler/src/checker/checker.ts` hat rund 9500 Zeilen. Etwa die Hälfte davon ist reine
Typalgebra: Funktionen auf `CompileTimeType`, die weder Scopes noch Syntaxbaum noch `inferType`
brauchen (Normalisierung von Or/And, Gleichheit, Überlappung, Zuweisbarkeit, Alias-Auflösung,
Platzhalter, Feld- und Indexzugriff auf Typen, Typ-zu-Text). Dass diese Schicht den Checker nicht
kennt, ist heute nur Konvention. Als eigenes Modul wird es durch die Importrichtung erzwungen,
die Schicht wird einzeln testbar und Emitter und Language Server bekommen eine eigene,
kleinere Schnittstelle.

Ziel ist ein **reines Verschieben** ohne Verhaltensänderung: Snapshot und Zähler-Baseline
bleiben unverändert.

## Befund der Analyse

Der transitive Abschluss über die Typoperationen ist **geschlossen**. Er erreicht weder
`inferType` noch `checkTypes`, `builtInSymbols`, Scopes oder `CheckContext`.

- **Umfang:** 134 Top-Level-Deklarationen, rund 4700 Zeilen.
- **Ein einziger Block:** Alle Teile erreichen sich gegenseitig, meist über `resolveAlias`.
  Eine feinere Aufteilung auf mehrere Dateien brächte nur zyklische Importe. Deshalb **ein**
  Modul.
- **Zustand bleibt intern:** Die `let`-Zähler (`typeComparisonDepth`, `typeEqualsDepth`,
  `aliasApplicationExpansionsRemaining`, `typeEqualsApplicationExpansionsRemaining`) werden nur
  innerhalb des Abschlusses gelesen und zurückgesetzt. Reset-Funktionen über die Modulgrenze
  sind nicht nötig.
- **Einzige geteilte Zustände sind `checkerStats` und `resetCheckerStats`:** Beide Seiten zählen
  hinein, das neue Modul `getTypeError`, `resolvePlaceholders` und `foldableCall`, der Checker
  `inferType` und `foldableCall`.
- **Zwei Syntaxbaum-Helfer werden von beiden Seiten gebraucht:** `getNameFromValue` und
  `isInsideFunctionLiteral` (reine Elternkettensuche auf `TypedExpression`).
- **Die Ladereihenfolge wird besser:** `emitter.ts`, `branch-dispatch.ts` und
  `stream-lifetime.ts` importieren aus `checker.js` ausschließlich Typalgebra-Namen. Heute gibt
  es den Zyklus `checker → constant-folding → emitter → checker`. Danach lautet er
  `type-algebra → constant-folding → emitter → type-algebra`. Der Checker, der beim Laden die
  core-lib prüft, ist dann in keinem Zyklus mehr und wird zuletzt ausgewertet. `emitter.ts`
  ruft auf oberster Ebene nichts aus der Typalgebra auf.

## Vorgehen

### 1. Neue Datei `jul-compiler/src/checker/checker-stats.ts`

Die Region `stats` (`checkerStats`, `resetCheckerStats`, Zeilen 211–236) zieht unverändert
hierher. `checker.ts` und `type-algebra.ts` importieren sie von dort, ebenso
`checker-snapshot.test.ts` und `scripts/bench.ts`.

### 2. Syntaxbaum-Helfer nach `src/parser/parser-utils.ts`

`getNameFromValue` und `isInsideFunctionLiteral` werden dort exportiert. In
`parser-utils.ts` stehen schon vergleichbare Helfer wie `getCheckedEscapableName`. Checker und
Typalgebra importieren sie von dort.

### 3. Neue Datei `jul-compiler/src/checker/type-algebra.ts`

Hierher kommen alle Deklarationen des Abschlusses, **byte-identisch**. Sie behalten ihre
Reihenfolge und ihre `//#region`-Klammern. Neue Regionsgrenzen gibt es nur dort, wo ein Block
aus einer gemischten Region herausgelöst wird. Gruppen in Dateireihenfolge:

| Herkunft in checker.ts | Inhalt |
|---|---|
| Kopf (242–265, 421–495) | Caches `argumentPlaceholderCache` und `aliasApplicationCache`, Budgets, Tiefenzähler, `aliasComparisonsInProgress` und `aliasEqualityInProgress`, die Konstanten `maxAliasDepth`, `indentUnit`, `subtypeReductionLimit`, `maxMappedPositions`, `maxElementsPerLine`, `maxFieldsInTypeDump` sowie `CompileTimePositiveInteger` |
| `benannte Eigenschaften` (267–419) | komplett: `NamedAccess`, `valueFieldAccess`, `typePropertyAccess`, `getNamedAccess` |
| `dereference` (616–2196), teilweise | `getStreamGetValueType`, die Familie `dereference*FromObject`, `nestedKeysEqual`, `hasKnownFields`, `hasKnownLength`, `canHaveFields`, `isTypePropertyOfValue`, `dereferenceArgumentTypesNested`, `splitReceiver`, `getAllArgTypes`, `dereferenceParameterFromArgumentType`, `resolvePlaceholders`, `containsArgumentPlaceholder`, `traversePlaceholders`, `dereferenceNestedParameter`, `dereferenceParameterTypeFromFunctionRef` |
| `CompileTimeType guards` (2198–2248) | komplett, auch die heute nur vom LSP benutzten Guards (`isTextLiteralType`, `isParameterReference`, `isTypeOfType`, `isDictionaryType`) |
| `branch narrowing`, teilweise | nur `getElementTypeAtIndex` |
| `Sequenz Arithmetik` (5022–5443) | ohne `getSpreadElementTypes`, das braucht der Checker |
| `Bedingte Typen` (5445–5481) | komplett |
| `Typ Arithmetik` (5483–6950), teilweise | alles außer der Purity- und Folding-Gruppe (`joinPurity` bis `bindClosureArguments`). `effectivePurity` zieht mit, weil `typeEqualsAtDepth` es braucht. |
| Alias und Wert (7387–7608), teilweise | `dereferenceAlias` bis `valueOf`, ohne die `check*`-Funktionen davor |
| `TypeAssignability` (7608–8992) | ohne die Fehlerpositions-Helfer `findInnermostErrorPosition`, `findErrorPositionInChild`, `getWrittenChildValues`, `hasExpectedTypeError`. Die sind Diagnose am Syntaxbaum und bleiben im Checker. |
| `ToString` (8994–9240) | komplett |

Die genaue Liste ergibt sich mechanisch aus dem Abschluss. Das Verschieben erledigt ein
Wegwerfskript im Scratchpad, das nach Zeilenbereichen schneidet. Danach wird geprüft, dass
jede verschobene Deklaration bis auf ein hinzugefügtes `export` identisch ist.

**Exporte:** Exportiert wird alles, was der Rest des Checkers oder externe Nutzer brauchen.
Laut Analyse sind das 44 Namen aus dem Checker, dazu die heute schon exportierten Guards,
`getStreamGetValueType` und die Typen `TypeAssignability`, `TypeError` und `IntegerRange`,
soweit der Checker sie benutzt. Was nur intern gebraucht wird, bleibt unexportiert.

**Kommentare:** Die Hinweise „Muss vor der core-lib Initialisierung stehen…“ an den
verschobenen Konstanten (etwa an `aliasApplicationCache`, `typeComparisonDepth` und
`subtypeReductionLimit`) stimmen danach nicht mehr. Das Modul ist vollständig ausgewertet, bevor
der Checker läuft. Diese Sätze entfallen. Die Hinweise an dem, was im Checker bleibt
(`parameterProjectionsCache`, `completedNamesByScope`, `maxTypenessDepth`, `typeCombinatorNames`),
bleiben stehen.

**Importe des neuen Moduls:** `../syntax-tree.js` (Typen und `createCompileTime*`),
`../util.js` (`elementsEqual`, `fieldsEqual`, `isDefined`, `last`, `map`, `mapDictionary`),
`./constant-folding.js` (`tryBuildCallable`, `typeToConstantValue`), `../runtime/runtime.js`,
`./checker-stats.js` und `../parser/parser-utils.js`. **Kein** Import aus `./checker.js`.
Diese Regel ist das eigentliche Ziel des Umbaus.

### 4. `checker.ts` aufräumen

`checker.ts` importiert die benötigten Namen aus `./type-algebra.js`. Ungenutzte Importe aus
`syntax-tree.js` und `util.js` fliegen raus, `tsc` meldet sie. Danach hat die Datei rund 4800
Zeilen.

**Keine Re-Exporte** aus `checker.ts`. Würde der Emitter weiter über `checker.js` importieren,
bliebe der Checker im Ladezyklus. Alle Nutzer importieren direkt.

### 5. Importe der Nutzer umstellen

Typalgebra-Namen kommen künftig aus `type-algebra.js`, der Rest bleibt bei `checker.js`.

- Compiler:
  - `src/compiler/emitter.ts`
  - `src/checker/branch-dispatch.ts`
  - `src/checker/stream-lifetime.ts`
  - `src/checker/checker.test.ts` (`isFunctionType`, `resolvePlaceholders`, `typeToString`)
  - `src/checker/checker-snapshot.test.ts`
  - `src/parser/typescript-parser.test.ts`
  - `scripts/bench.ts` (nur auf `checker-stats.js`)
- Language Server (`jul-compiler/out/checker/type-algebra.js`):
  - `completion.ts`
  - `hover.ts`
  - `semantic-tokens.ts`
  - `server.ts`
  - `util.ts`

### 6. Doku

- In der `CLAUDE.md` des Workspace bekommt der Abschnitt „Compiler-Pipeline“, Schritt 3, einen
  Satz: Die Typalgebra liegt in `checker/type-algebra.ts` und importiert nichts aus
  `checker.ts`.
- `docs/backlog/predicate-types-and-filter-narrowing.md` enthält 4 Zeilenverweise auf
  `checker.ts`. Sie werden auf die neue Datei bzw. die neuen Zeilen umgestellt.
- Dieser Plan kommt nach Freigabe nach `jul-compiler/docs/type-algebra-module.md`. Die Kopie
  unter `~/.claude/plans/` wird danach gelöscht.

## Nicht Teil dieses Schritts

- Purity und Folding (`joinPurity` bis `bindClosureArguments`) in ein eigenes Modul. Das ist
  Schritt 2.
- Eigene Unit-Tests direkt auf `type-algebra.ts`. Das ist danach möglich, aber ein eigener
  Schritt.
- Inhaltliche Änderungen, Umbenennungen und eine Neusortierung innerhalb der verschobenen
  Funktionen.

## Verifikation

1. **Vorher** in `jul-compiler` `npm run bench -- --save --note "vor Auslagerung type-algebra"`
   ausführen, ebenso in `jul-language-server`.
2. In `jul-compiler`: `npm run typecheck`, dann `node --run test`. Checker-Snapshot und
   Zähler-Gate müssen **ohne** `test-update-snapshot` grün sein, weil die Zähler identisch
   bleiben.
3. Prüfen, dass `type-algebra.ts` keinen Import aus `./checker.js` enthält (grep).
4. `npm run build-all`, danach in `jul-language-server` `npm run typecheck`, `npm test` und
   `npm run test-snapshot`.
5. `node out/cli.js check` auf einige Projekte in `jul-examples` und auf
   `C:\Projects\privat\yugioh`, dazu einmal bauen und ausführen (`fizz-buzz`).
6. **Nachher** beide Benches erneut mit `--save --note "nach Auslagerung type-algebra"`
   ausführen. Erwartet ist keine Veränderung.
