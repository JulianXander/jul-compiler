# Plan: Der deklarierte Rückgabetyp gilt immer

Hat eine Funktion einen deklarierten Rückgabetyp, ist er der Typ jedes Aufrufs. Der Rumpftyp wird nur noch
gegen die Deklaration geprüft und verlässt die Funktion nicht. Ohne Deklaration gilt wie bisher der Rumpftyp.
Ein gefalteter Aufruf (`foldedType`) liefert weiter seinen ausgewerteten Wert.

## Ausgangslage

In `checker.ts` (Fall `functionLiteral`, nach der Prüfung `returnTypeMismatch`) ist der deklarierte Typ heute
nur eine Obergrenze. Der Funktionstyp trägt den Rumpftyp, außer in zwei Fällen: Der Rumpftyp ist `Any`, oder
der deklarierte Typ enthält Platzhalter (`isDeferredType`, etwa `TypeOf(values)/ElementType` oder `:?`). Dann
wird der rohe deklarierte Typ verwendet und je Aufruf aufgelöst. Im eigenen Rumpf gilt die Deklaration schon
(`getDeclaredSignature`). Ein rekursiver Aufruf sieht also heute einen anderen Typ als ein Aufrufer von außen.

Ein Versuch, bei dem die Deklaration immer galt, ergab:

- **Suite und jul-examples:** keine neuen Fehler. Im Snapshot stehen lesbarere Typen, `getTypeError` sinkt
  von 6048 auf 5998.
- **yugioh:** 3 Fehler, 37 Warnungen und 2 überflüssige `assume`. Alle lassen sich durch eine genauere
  Signatur beheben oder sind echte Befunde, siehe Schritt 4.
- **Bench yugioh:** parse+check (geteilt) sinkt von 934 auf 635 ms, ungeteilt von 12,5 auf 9,9 s.

## Schritte

### 0. Vorher messen

`npm run bench -- --save --note "vor: deklarierter Rückgabetyp gilt immer"` in `jul-compiler`.

### 1. Rote Tests in `checker.test.ts`

Alle Aufrufe erfolgen mit Parametern als Argument, sonst verdeckt die Faltung das Ergebnis.

- **Aufruf hat den deklarierten Typ:** `f = (x: Integer) :> Or(Integer Text) => x`, dann
  `g = (n: Integer) => y: Integer = f(n)` meldet einen Zuweisungsfehler. Heute ist das fehlerfrei.
- **Kein Folgefehler bei falschem Rumpf:** `f = (x: Integer) :> Integer => §a§`, dann
  `g = (n: Integer) => y: Integer = f(n)` meldet nur `returnTypeMismatch` an der Rückgabe und nichts am
  Aufruf. Heute kommt am Aufruf ein zweiter Fehler dazu.
- **Ohne Deklaration bleibt der Rumpftyp:** Diesen Fall decken bestehende Tests ab, sonst kommt ein Test dazu.
- **Gefaltete Aufrufe bleiben genau:** `f = (x: Integer) :> Integer => x.add(1)` und `y: 2 = f(1)` sind
  fehlerfrei. Der Test hält das gewollte Verhalten fest und ist schon vor dem Umbau grün.
- **Rekursion und Aufruf von außen sehen denselben Typ:** Die bestehenden Tests `recursive-call-*` bleiben
  unverändert.

Den roten Lauf zeigen und **anhalten**.

### 2. Umbau im Checker

Im Fall `functionLiteral`: Gibt es einen `declaredReturnType`, wird `returnType = rawDeclaredReturnType`
gesetzt, auch wenn die Prüfung fehlschlägt. Der Fehler gehört an die Rückgabe, nicht an jeden Aufrufer. Der
Zweig für `Any`/`isDeferredType` entfällt samt Kommentar. Der Kommentar über `let returnType` beschreibt
danach die neue Regel. `eraseListLengths` betrifft nur noch den Rumpftyp.

Zu prüfen:

- `getPredicateFacts` erhält den deklarierten Typ. Mit `:> Boolean` sollte das gleich bleiben, weil nur
  `isSubtypeOf(..., Boolean)` abgefragt wird. Die Prädikat-Tests müssen grün bleiben.
- Der Kommentar bei `getDeclaredSignature` und `dereferenceType` erwähnt keinen Unterschied mehr zwischen
  Rekursion und Aufruf von außen.

### 3. Suite und Baselines

- `node --run test`, `npm run typecheck`.
- `npm run test-update-snapshot`. Die Baseline lesen: erwartet sind lesbarere Typen (deklarierte Namen statt
  ausgeschriebener Records) und sinkende Zähler. Ein neuer Fehler im Snapshot ist ein Befund.
- In jul-examples ein paar Projekte mit `check` und `test` laufen lassen.
- Language Server: `npm test`, danach `npm run build-all` im Compiler und `npm run test-snapshot`. Im Hover
  stehen jetzt die deklarierten Typen. Baseline lesen, dann übernehmen.

### 4. yugioh mitmigrieren

`jul` zeigt per Symlink auf `jul-compiler`, deshalb ist die Reihenfolge wichtig.

**Vor dem Build**, verträglich mit dem alten Compiler (deklarierte Typen mit Platzhaltern gelten dort schon):

1. `removeElement`/`removeElements` (`game-logic.jul:66–85`): `:> Or([] List(TypeOf(values)/ElementType))`.
   Das behebt die 37 Warnungen.
2. `toPlayerInput` (`scenario-driver.jul:832`) bleibt bei `:> Or([] PlayerInput)`: Für `resolveChain`
   liefert der catchAll `() => []`, `applyLegal` nimmt Empty an. Das `JUL5050` bei `scenario-driver.jul:976`
   im Versuch war eine Folge von `getGameCardIds` und entfällt mit Punkt 3.
3. `getGameCardIds` (`scenario-driver.jul:598`): bedingter Rückgabetyp

   ```
   	:>
   		:?(TypeOf(refs))
   			[Empty] => Empty
   			() => List(GameCardId)
   ```

   Behebt `JUL5100` in `toPlayerInput` (Synchro `materialGameCardIds`).
4. `game-logic.jul:1903`: Ein `PendingTrigger` geht an `getHasActivatedThisTurn(… effectIdentifier:
   EffectIdentifier)`. Ein Record ist geschlossen, `triggeringGameCardId?` passt also nicht. Der Vertrag wird
   tatsächlich verletzt, das ist kein Artefakt des Umbaus. Vorschlag: An der Aufrufstelle den
   `EffectIdentifier` aus `gameCardId`, `effectType` und `effectIndex` bauen, als Helfer, falls die Stelle
   öfter vorkommt.

Danach `jul check` und `jul test` mit dem alten Compiler: Es dürfen keine neuen Diagnosen auftauchen.

**Nach dem Build:**

5. Die zwei überflüssigen `assume(… List(GameCardId))` entfernen (`JUL2503`, `game-logic.jul:5410`,
   `scenario-driver.jul:525`).
6. `jul check` und `jul test` fehlerfrei. Die Zahl der Warnungen darf nicht steigen.
7. `node scripts/assume-inventory.js` und in `docs/jul-findings.md` den Eintrag zur Rekursion ergänzen.

### 5. Doku

- **Handbuch** (`jul-homepage/docs/docs/documentation/handbook.md`, Abschnitt Funktionen und Rückgabepfeil):
  Ein deklarierter Rückgabetyp ist der Typ jedes Aufrufs, der Rumpf wird dagegen geprüft. Ohne Deklaration
  gilt der Typ des Rumpfs. Ein Beispiel mit `:> Or(Integer Text) => 1`.
- **`design-principles.md`, Klarheit/Beispiele:** Ein Aufrufer liest den Typ aus der Signatur, nicht aus dem
  Rumpf, der woanders steht (nichtlokale Magie). Das ist ein Beleg für das Prinzip, also gehört es hinein.
- `conditional-types.md`: Vermerk, dass `:?` damit der Weg ist, eine Kopplung zwischen Eingabe und Ergebnis
  zu behalten (Beispiel `getGameCardIds`).

### 6. Nachher messen

`npm run bench -- --save --note "nach: deklarierter Rückgabetyp gilt immer"`. Erwartet wird für parse+check
etwa −30 %.

## Risiken

- **Grobe Deklarationen kosten Genauigkeit:** `:> Any` oder `:> Or([] List(Any))` geben ab jetzt genau das
  weiter. Man sieht es an `JUL5010` beim Aufrufer, und die Abhilfe ist eine genauere Signatur. Das ist gewollt.
- **Faltung bleibt eine Ausnahme:** `f(1)` liefert weiter den ausgewerteten Wert. Das ist der Wert und keine
  Aussage über die Signatur. Die Faltung hängt ohnehin an konstanten Argumenten.
- **Externe Projekte:** Sie brechen nur dort, wo sie sich auf einen engeren Rumpftyp verlassen haben. Beim
  Versuch war das in jul-examples nie der Fall.
