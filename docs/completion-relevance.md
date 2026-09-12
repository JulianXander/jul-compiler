# Completion-Relevanz im Language Server: Typ/Wert-Sortierung + Argumenttyp-Bewusstsein

## Context

`server.ts` markiert die Completion-Sortierung seit Langem als offen:

```
// TODO sortierung type/nicht-type, bei normaler stelle erst nicht-types, bei type erst types/nur types?
```
([server.ts:403](../../jul-language-server/src/server.ts#L403))

Aktuell liefert `symbolsToCompletionItems` alle Scope-Symbole ohne `sortText` zurück — der Editor
sortiert alphabetisch. An einer Typ-Position (z. B. nach `:`) stehen Werte und Typen also wild
gemischt, ebenso umgekehrt an einer Wert-Position.

Bei der Untersuchung kam eine zweite, verwandte Lücke ans Licht: Für den Infix-Aufruf
(`a.f(...)`, `prefixArgument` gesetzt) filtert der Server schon nach Argumenttyp — nur Funktionen,
deren erster Parameter das `prefixArgument` laut `getTypeError` überhaupt annehmen würde, werden
vorgeschlagen ([server.ts:541-570](../../jul-language-server/src/server.ts#L541)).
Für normale Aufrufe (`f(1 <hier>)`) gibt es diese Typ-Bewusstheit beim Vervollständigen von
Argumentwerten dagegen gar nicht.

Eine dritte Option (an einer Typ-Position **nur** Typen zeigen, also filtern statt sortieren) wurde
bewusst verworfen: Sie verletzt Prinzip 2 aus [design-principles.md](design-principles.md#L46)
("Freiheit — keine gültigen Programme verbieten"), weil Typen und Werte in JUL denselben
Namensraum teilen und ein Wert an einer Typ-Position gültig sein kann. Sortieren statt Filtern
umgeht dieses Risiko: Im Zweifel bleibt jedes Symbol sichtbar, nur an anderer Stelle in der Liste.

Ziel dieser Änderung: bessere Vorschlagsreihenfolge ohne ein einziges gültiges Symbol aus der
Liste zu entfernen, außer an der einen Stelle, wo das schon heute passiert und dort nachweislich
sicher ist (Infix-Funktionsauswahl, weil `getTypeError` dieselbe Regel anwendet, die der Checker
später ohnehin durchsetzen würde).

Umfang: beide Phasen (A und B) werden in einem Durchgang umgesetzt.

## Ansatz

### Neues Modul `src/completion.ts` (+ `src/completion.test.ts`)

Wie schon bei `util.ts`: reine Hilfsfunktionen werden aus `server.ts` extrahiert, damit sie ohne
den Seiteneffekt von `createConnection`/`connection.listen()` testbar sind (echtes Parsen +
Checken über `jul-compiler/out/...`, kein Server-Start nötig — analog zu `util.test.ts`).

**`getResolvedType(typeInfo)`** — der Einzeiler aus [server.ts:89](../../jul-language-server/src/server.ts#L89)
wandert nach `util.ts`, damit sowohl `server.ts` als auch `completion.ts` ihn importieren können,
ohne dass `completion.ts` aus `server.ts` importiert (das würde wieder den Seiteneffekt mitziehen).

**`getExpectedPositionKind(expression): 'type' | 'value' | undefined`** — erkennt, ob die
Cursor-Position ein Typ-Slot ist, anhand von `expression.parent`:
- `definition`/`parameter`/`destructuringField`/`singleDictionaryField`/`singleDictionaryTypeField`
  und `expression === parent.typeGuard` → `'type'`
- `functionLiteral`/`functionTypeLiteral` und `expression === parent.returnType` → `'type'`
- alle anderen erkannten Wert-Slots (z. B. `definition.value`) → `'value'`
- alles andere (z. B. Top-Level-Statement, wo beides syntaktisch gültig ist) → `undefined`
  (kein Bucket, aktuelles Verhalten bleibt unverändert — bewusst keine Vermutung, wenn die Position
  wirklich beides sein kann)

**`getArgumentSlotType(expression): CompileTimeType | undefined`** — Refactoring: extrahiert den
`functionCall`-Zweig aus dem bestehenden `getDeclaredType` in `server.ts`
([server.ts:2028 ff.](../../jul-language-server/src/server.ts#L2028)), der
für ein Argument bereits den erwarteten Zieltyp berechnet (inkl. `TODO handle prefix arg` — das
lösen wir hier gleich mit, indem bei gesetztem `prefixArgument` der erste Parameter übersprungen
wird statt den Fall unbehandelt zu lassen).

**`getFirstArgumentSymbolFilter(prefixArgumentType, scopes)`** — Refactoring der bestehenden
Inline-Logik aus [server.ts:530-570](../../jul-language-server/src/server.ts#L530)
(Infix-Fall), unverändert im Verhalten, nur extrahiert und parametrisiert.

### Phase A — Sortier-Bucket Typ/Wert

- `symbolsToCompletionItems(scopes, symbolFilter?, positionKind?)` bekommt einen dritten,
  optionalen Parameter.
- Pro Symbol: `isTypeSymbol = isTypeOfType(getResolvedType(symbol.typeInfo))`.
- `sortText`: wenn `positionKind` gesetzt ist und `isTypeSymbol === (positionKind === 'type')`,
  dann `'0' + name`, sonst `'1' + name`; ist `positionKind === undefined`, kein `sortText`
  (unverändertes Verhalten).
- In `onCompletion` wird `positionKind = getExpectedPositionKind(expression)` einmal berechnet und
  an alle Aufrufstellen von `symbolsToCompletionItems` durchgereicht (aktuell die Stellen bei
  Infix-Call, destructuring, generischem Fallback).
- Reine Umsortierung, kein Symbol verschwindet.

### Phase B — Argumenttyp-Bewusstsein erweitern

Zwei getrennte Fälle, unterschiedlich streng behandelt:

1. **Funktionsauswahl beim Infix-Aufruf** (`a.f(...)`): bleibt ein harter Filter wie heute — das
   ist der einzige Fall, in dem der Funktionsname erst *nach* einem schon feststehenden Argument
   getippt wird, und `getTypeError` bildet exakt die Checker-Regel ab (kein Rätselraten). Nur
   Refactoring nach `completion.ts`, kein Verhaltensunterschied — außer der Behebung von
   `TODO handle prefix arg`.
2. **Argumentwert-Vervollständigung bei jedem Aufruf** (auch normalem `f(1 <hier>)`, nicht nur
   Infix): **neuer** Sortier-Bucket, kein Filter. An der Argument-Position wird über
   `getArgumentSlotType(expression)` der erwartete Parametertyp bestimmt; Symbole, deren Typ laut
   `getTypeError` dazu passt, bekommen denselben Bucket-Vorrang wie in Phase A
   (`'0' + name` vs. `'1' + name`). Bewusst kein Filter, weil hier — anders als bei 1. — nicht
   jede Nichtübereinstimmung zwangsläufig ein Fehler wäre (z. B. bei locker typisierten
   Parametern); ein zu Unrecht verstecktes, aber gültiges Symbol wäre ein Freiheits-Verstoß.

## Betroffene Dateien

- **neu:** `jul-language-server/src/completion.ts`, `jul-language-server/src/completion.test.ts`
- `jul-language-server/src/util.ts`: `getResolvedType` zieht hierher um
- `jul-language-server/src/server.ts`: `getResolvedType`-Definition entfernt (Import aus `util.ts`
  statt lokaler Definition); `onCompletion` und `symbolsToCompletionItems` verdrahten die neuen
  Parameter; der `functionCall`-Zweig in `getDeclaredType` bleibt, `getArgumentSlotType` in
  `completion.ts` ist eine eigenständige Kopie mit dem Prefix-Argument-Fix (keine gemeinsame
  Extraktion mit `getDeclaredType`, da diese Funktion zu stark mit anderen `server.ts`-internen
  Fällen verzahnt ist, um sie vollständig zu verschieben)

## Tests

Tabellengetrieben wie `util.test.ts`: echter `parseCode` + `checkTypes` gegen kleine JUL-Schnipsel,
dann die extrahierte Funktion direkt aufrufen. Konkret:

- `getExpectedPositionKind`: Fälle für `typeGuard` (Definition, Parameter, Dictionary-Feld),
  `returnType`, und einen eindeutigen Wert-Slot — je ein erwarteter `'type'`/`'value'`/`undefined`.
- `symbolsToCompletionItems`-`sortText`-Vergabe: ein Scope mit gemischten Typ- und Wert-Symbolen,
  geprüft wird die resultierende Reihenfolge/das `sortText`-Präfix bei `positionKind: 'type'` bzw.
  `'value'`.
- `getArgumentSlotType` mit `prefixArgument`: Regressionstest für den gefixten
  `TODO handle prefix arg`-Fall (roter Test zuerst, wie mit dem Nutzer vereinbart: nach jedem
  einzelnen roten Testlauf anhalten und auf Bestätigung warten, bevor der jeweilige Fix kommt).
- `getFirstArgumentSymbolFilter`: bestehendes Verhalten (Infix-Filter) als Regressionsnetz,
  migriert aus dem, was der Snapshot-Test bisher nur indirekt/grob abdeckt.

## Verifikation

```bash
cd jul-language-server
npm test            # neue Unit-Tests grün, roter Zwischenstand je Fix vom Nutzer bestätigt
npm run typecheck
npm run build
npm run bench        # vorher/nachher, da Phase B pro Completion-Request zusätzliche getTypeError-Aufrufe einführt
npm run test-snapshot # erwartete Diffs durchsehen (andere completion-Reihenfolge/-Filterung),
                       # erst danach bewusst UPDATE_SNAPSHOT=1 npm run test-snapshot
```
