# Plan: Record-Typen per Default geschlossen

## Context

Record-Typen (`[a: Integer]`) sind heute offen: `[a: Integer]` akzeptiert `[a = 1 b = 2]`
(CLAUDE.md, `design-principles.md:138`). Gleichzeitig behandelt der Checker deklarierte Records an
mehreren Stellen schon als geschlossen (`complete: true` aus `checker.ts:2612`):
- Feldzugriff auf ein unbekanntes Feld ist ein Fehler.
- Ein Spread liefert einen vollständigen Typ.
- Ein unbekannter Textschlüssel ergibt `Empty`.

Daraus folgt eine nachgewiesene Lücke:

```
f = (x: [a: Integer]) =>
	y: [a: Integer b: Or([] Integer)] = x   # kein Fehler
	y
z = f([a = 1 b = §s§])                     # y/b ist zur Laufzeit §s§
```

Ziel: Records sind geschlossen. Ein weiteres Feld ist nur erlaubt, wenn sein Typ Empty ist. Die
Zuweisbarkeit wird dadurch sound und konsistent mit Feldzugriff und Spread. Außerdem bekommt der
Perf-Plan (stabile Objektformen) vollständige Feldmengen aus den Typen.

**Neue Syntax für optionale Felder (`b?: X`) ist nicht nötig.**
- In einem geschlossenen Typ ist ein nicht genanntes Feld bewiesen Empty. Damit bleibt `Or([] X)` als
  Idiom für optionale Felder sound, auch wenn die Quelle ein deklarierter Typ und kein Literal ist.
- `?` bräuchte es nur, um bei JSON zwischen `null` und einem fehlenden Schlüssel zu unterscheiden.
  Diese Frage ist unabhängig von diesem Plan und kommt in ein Backlog-Dokument.
- **Nachtrag:** Für JSON und stabile Objektformen wird `?` inzwischen doch vorgeschlagen, siehe
  [stabile-objektformen.md](stabile-objektformen.md). Für die Geschlossenheit bleibt es unnötig.

**Entscheidungen:**
- Ein weiteres Feld mit Empty ist erlaubt (Lesart „Rest ist Empty“). Darauf beruht yugioh, z.B.
  `main.jul:640` (`attackerGameCardId = []` in der Variante mit `status: []`).
- Es gibt keine Syntax für offene Records. Ein Spread eines Typs, der kein Record ist (`...Any`),
  wird zum Fehler und nicht mehr still ignoriert. Offenheit lässt sich später ohne Bruch nachrüsten.
- TS-Objekttypen werden geschlossen übersetzt, also wie heute ohne Sonderbehandlung.
- Die Laufzeit-Typprüfung setzt die Geschlossenheit ebenfalls durch: Ein weiterer Schlüssel darf
  nur `undefined` enthalten.
- `complete: false` bleibt die interne Bedeutung „nur ein bewiesener Fakt“ (Branch-Verengung,
  `checker.ts:1296`) und verhält sich wie ein offener Typ.

## Schritte

### 0. Baseline messen
- In `jul-compiler`: `npm run bench -- --save --note "vor geschlossenen Records"` und
  `npm run bench-runtime -- --save --note "…"`.
- In `jul-language-server`: `npm run bench -- --save …`.
- Ziel jeweils yugioh.

### 1. Rote Tests, dann anhalten
Zuerst nur die Tests schreiben, den roten Lauf zeigen und auf die Freigabe warten.
- `src/checker/checker.test.ts`:
  - `assignment-keeps-surplus-field` (≈4215) wird zu `assignment-rejects-surplus-field`.
  - Neu `surplus-field-with-empty-is-allowed`: `x: [a: Integer] = [a = 1 b = []]` ergibt keinen Fehler.
  - Neu `surplus-field-that-may-be-non-empty-is-rejected`: Quelltyp `[a: Integer b: Or([] Integer)]`
    an das Ziel `[a: Integer]`.
  - Neu `optional-field-from-declared-record-is-sound`: der Fall aus dem Context. Der Aufruf
    `f([a = 1 b = §s§])` muss einen Fehler liefern.
  - Neu `spread-of-non-record-in-dictionary-type-is-error`: `[a: Integer ...Any]`.
- `src/checker/type-algebra.test.ts`:
  - `intersection-merges-dictionary-fields` (≈226) wird zu
    `intersection-of-closed-dictionaries-with-different-required-fields-is-never`.
  - Neu: Die Intersection mit optionalen Feldern schneidet das Feld auf Empty.
  - Neu `union-does-not-absorb-record-with-additional-field`: `Or([a: X] [a: X b: Y])` bleibt zweiteilig.
- Runtime-Test (Ort wie bestehende `_isOfType`-Tests):
  - Ein weiterer Schlüssel mit Wert wird abgelehnt.
  - Ein weiterer Schlüssel mit `undefined` wird akzeptiert.
- Alle Tests mit den Helfern `expectCheck` / `expectLastTypeString`, je ein `it` pro Fall.

### 2. Typalgebra (`src/checker/type-algebra.ts`)
- **`isTypeAssignableForDictionaryLiteral` (≈4849):**
  - Nur bei `complete`-Ziel: Felder der Quelle, die das Ziel nicht kennt, mit
    `isTypeAssignable(sourceFieldType, builtinEmpty)` prüfen.
  - `false` ergibt einen Fehler, gesammelt wie `missingFieldNames`: `Unexpected field 'b'.` bzw.
    `Unexpected fields: …`.
  - `undefined` bleibt unbekannt.
  - Ist die Quelle nicht `complete`, ist das Ergebnis unbekannt, also stillschweigend akzeptiert.
    Das entspricht der dreiwertigen Regel, nur `false` erzeugt einen Fehler (`checker.ts:2346`).
- **Intersection (≈2812–2849):** Ein Feld, das nur auf einer Seite steht, wird mit `builtinEmpty`
  geschnitten, wenn die andere Seite `complete` ist. Ergibt das `never`, ist der ganze Typ `never`.
  `complete = first || second` bleibt.
- **`isFieldOptional` (≈4949):** Der Kommentar wird angepasst: Das Weglassen ist jetzt auch aus
  geschlossenen Quelltypen sound.
- **`removeSubtypes` (≈2490):** Hier ist nichts zu tun, die Absorption folgt automatisch über
  `isSubtypeOf`. Den neuen Test prüfen.

### 3. Checker (`src/checker/checker.ts`)
- **dictionaryType-Spread (≈2590–2604):**
  - Ein Spread, dessen Wert kein `dictionaryLiteral` ist, erzeugt einen Fehler.
  - Den neuen ErrorCode in `src/compiler-errors.ts` anlegen, samt Abschnitt in
    `jul-homepage/docs/…/error-codes.md`.
  - Das `TODO` an dieser Stelle entfällt.
- **`narrowExpectedTypeByFields` (≈1749):** Eine Choice fällt zusätzlich weg, wenn das Literal ein
  Feld schreibt, das die geschlossene Choice nicht kennt, und dessen Typ nicht Empty sein kann.
  Damit werden verschachtelte Literale gegen Unions wie `GameUiState` genauer inferiert, und
  Fehlermeldungen zeigen auf die richtige Variante.

### 4. Runtime (`src/runtime/runtime.ts`)
- **`isDictionaryLiteralOfType` (≈341):** Nach der Prüfung der Felder über die Schlüssel des Werts
  laufen. Ein Schlüssel, der im Typ fehlt und nicht `undefined` enthält, ergibt `false`.
- Der Emitter bleibt unverändert, ein Flag ist nicht nötig, weil alle Records geschlossen sind.
- Danach `npm run check-runtime-purity` aufrufen.

### 5. jul-examples
- `type-checking-test.jul:103–113` (`testDictionaryLiteral3a`, „should not error“) umdrehen.
- `type-checking-test` und `ui/tic-tac-toe` neu bauen.

### 6. yugioh nachziehen
Hier hilft kein Migrationsskript, weil die Änderung semantisch und nicht syntaktisch ist. Nach
`npm run build-all` in yugioh `check` laufen lassen und die Fehler von Hand beheben:
- **`game-logic.jul:1899`:** `PendingTrigger` geht an `getHasActivatedThisTurn(… effectIdentifier:
  EffectIdentifier)`. Dort ein `EffectIdentifier` ausdrücklich bauen
  (`[gameCardId = … effectType = … effectIndex = …]`).
- **`main.jul`, etwa 28 `GameUiState`-Spreads (136, 592–602, 620, 638–641, 653, …):** Felder, die
  aus einer anderen Variante stammen, auf `[]` setzen oder den neuen Zustand aus `GameUiStateBase`
  aufbauen.
- **JSON-Importe** prüfen: `fuzz/*.json` als `Deck`, `card-data.json` als `CardData`,
  `assume(parseJson … Replay)` in `ai/arena.test.jul:49`. Zusätzliche Felder fallen jetzt auf.
- **`parseYdk`** (TS, `main.jul:1295`): Rückgabefelder gegen den Inline-Typ prüfen.

### 7. Dokumentation
- **CLAUDE.md, Abschnitt „Ein Typ nennt Anforderungen“ (107–110):**
  - Ein Record-Typ ist geschlossen, ein weiteres Feld nur mit Empty.
  - Die Parameterliste bleibt offen, sie ist die einzige offene Stelle.
- **`jul-compiler/docs/design-principles.md:138`** umschreiben: Record und Tupel sind geschlossen,
  die Parameterliste ist offen. Dazu die Begründung, warum der Aufruf überzählige Argumente
  verwerfen darf, die Zuweisung aber nicht.
- **`jul-homepage/docs/docs/documentation/handbook.md`:**
  - 24–28: Das Beispiel wird zum Fehlerfall.
  - 59–65: einen Satz zur Geschlossenheit ergänzen.
- **`jul-homepage/…/error-codes.md:590`:** Die Begründung zu JUL2500 auf Parameterlisten
  einschränken. Dazu der Abschnitt zum neuen ErrorCode.
- **`jul-compiler/docs/js-performance-plan.md`:**
  - Zeile 27: Ein Spread als Literal auszuschreiben ist jetzt semantisch korrekt.
  - Punkt 1: Geschlossene Typen liefern die vollständige Feldmenge.
- **Neu `jul-compiler/docs/backlog/empty-vs-optional.md`:** Die Notizen aus `docs/empty-vs-optional.txt`
  übernehmen und die `.txt` danach löschen. Offen bleiben:
  - JSON-`null` gegen fehlenden Schlüssel: `Null`-Wert oder `?`-Syntax.
  - Laufzeit: Feld mit Empty gegen fehlendes Feld bei `deepEqual`, `toList`, `toJson`.
  - Offene Records (`...Any`, `...Dictionary(T)`, Zeilenvariablen) als spätere Ausbaustufe.
- **Diesen Plan nach der Freigabe** zusätzlich als `jul-compiler/docs/backlog/geschlossene-records.md`
  ablegen.

## Verifikation
- In `jul-compiler`:
  - `node --run test` und `npm run typecheck`.
  - `npm run test-update-snapshot` und den Diff des Checker-Snapshots und der Zähler-Baseline
    ansehen, nicht blind übernehmen.
  - `npm run check-runtime-purity`.
- `npm run build-all`, danach in `jul-language-server`: `npm test` und `npm run test-snapshot`.
- In jul-examples: `node ../../jul-compiler/out/compiler/cli.js check` für `type-checking-test`
  und `tic-tac-toe`.
- In yugioh: `check`, dann `test`.
- Benches aus Schritt 0 mit `--save` wiederholen: Checker (neue Schleife über die Quellfelder) und
  bench-runtime (neue Schleife in `isDictionaryLiteralOfType`).

## Stand der Umsetzung

Umgesetzt (Compiler, Language Server und jul-examples grün, Doku angepasst):
- `isTypeAssignableForDictionaryLiteral`: ein weiteres Feld nur, wenn es Empty sein kann (`Unexpected field`).
- Intersection: ein Feld, das eine vollständige Seite nicht nennt, wird dort mit Empty geschnitten.
- `typesOverlap` kennt die Geschlossenheit, damit ein totes Muster als unerreichbar erkannt wird.
- `narrowExpectedTypeByFields` wirft Zweige weg, die ein geschriebenes Feld nicht kennen.
- Spread eines Nicht-Records in einem Record-Typ ist ein Fehler (JUL5004), auch `...Any`.
- Laufzeit: `isDictionaryLiteralOfType` lehnt weitere Schlüssel mit Wert ab.

**Entscheidung zum Muster:** Ein Teil-Record taugt nicht mehr als Branch-Kopf (`[[kind: §circle§]] =>`),
ein Kopf nennt die ganze Variante. Der Emitter-Direktvergleich über einen Diskriminator bleibt für
volle Varianten erhalten. Eine Offen-Syntax (`...Any`) ist ein späterer, rückwärtskompatibler Schritt,
siehe [empty-vs-optional.md](empty-vs-optional.md).

**Offen:** yugioh (30 Fehler in `main.jul`, alle bei Spreads eines `GameUiState` in eine andere
Variante), Messung der Benches nach dem Umbau.
