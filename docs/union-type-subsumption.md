# Union-Normalisierung: Teilmengen-Elimination

## Entscheidung

**Option B ist entschieden:** `createNormalizedUnionType` bekommt eine Teilmengen-Elimination,
allgemein für alle Typen, nicht nur Boolean. Performance-Schutz nach TS-Vorbild: Größenschwelle,
ab der die Reduktion übersprungen wird (siehe Umsetzungsplan unten). Vor und nach der Umsetzung
wird mit `npm run bench --save` gemessen (CLAUDE.md "Wann messen").

## Problem

`createNormalizedUnionType` ([checker.ts:1951](../src/checker.ts#L1951)) entfernt nur **exakte**
Duplikate über `typeEquals`, keine Choices, die bereits Teilmenge eines anderen Choice sind:

```typescript
const uniqueChoices: CompileTimeType[] = [];
choicesWithoutNever.forEach(choice => {
	if (!uniqueChoices.some(uniqueChoice =>
		typeEquals(choice, uniqueChoice))) {
		uniqueChoices.push(choice);
	}
});
```

`typeEquals(Boolean, BooleanLiteral(false))` ist `false` — beide sind strukturell verschieden,
obwohl `false` semantisch immer schon in `Boolean` enthalten ist. Ergebnis:

```jul
getBoolean = () :> Boolean => true
x = ?(5)
	[1] => getBoolean()
	() => false
# x: Or(Boolean False) — bleibt 'or', kollabiert nicht zu Boolean
```

**Wie das sichtbar wurde:** Die Exhaustivitätsprüfung für Branching ohne catchAll
([branching-error-return-type.md](branching-error-return-type.md)) vergleicht den Typ des
gebranchten Werts gegen die Vereinigung der branch-Typen. Bei `Or(Boolean False)` schlägt der
Vergleich fehl, weil `Boolean` (der allgemeine Typ) nicht beweisbar in `Or(true false)` (die
branch-Literale) passt — obwohl der Wert nach Kollaps eindeutig `Boolean` wäre und die branches
`[true]`/`[false]` ihn vollständig abdecken. Aktuell mit einem lokalen Workaround
(`expandBooleanChoices` in `isBranchingExhaustive`) umgangen. Roter Test dazu:
`union-collapses-boolean-literal-into-boolean` in [checker.test.ts](../src/checker.test.ts).

Das Muster ist nicht auf `Boolean`/`booleanLiteral` beschränkt — dieselbe Lücke gilt für jedes
Paar aus einem allgemeinen Typ und einem seiner Literale, z.B. `Or(Integer 5)`, `Or(Text §a§)`,
oder allgemeiner für `Or(A B)`, wenn `B` Teilmenge von `A` ist (z.B. verschachtelte `Or`/`And`).

## Optionen

### Option A: Lokaler Workaround pro Aufrufstelle (Status quo)

Jede Stelle, die das Problem trifft, normalisiert selbst vor, so wie `expandBooleanChoices` das
für die Exhaustivitätsprüfung tut.

**Pro:**
- Kein Risiko für den Rest des Checkers — Blast Radius ist eine Funktion.
- Kein Performance-Overhead an der sehr heiß aufgerufenen `createNormalizedUnionType`.

**Contra:**
- Verstößt gegen Einheitlichkeit: Jede neue Stelle, die auf kollabierte Unions angewiesen ist,
  braucht ihren eigenen Sonderfall. `expandBooleanChoices` deckt nur Boolean ab, nicht
  `Or(Integer 5)` o.ä. — der nächste Fall (anderer Typ, andere Stelle) bräuchte einen neuen
  Workaround.
- Der rote Test `union-collapses-boolean-literal-into-boolean` bleibt dauerhaft rot bzw. muss
  gelöscht/umgeschrieben werden, um nur den Workaround zu prüfen statt die Normalisierung selbst.

**Aufwand:** Bereits erledigt (0 zusätzlich), aber mit wachsender Sonderfall-Schuld.

### Option B: Teilmengen-Elimination in `createNormalizedUnionType`

Nach dem Entfernen exakter Duplikate zusätzlich: für jedes Paar von Choices prüfen, ob einer
Teilmenge des anderen ist (`getTypeError(undefined, choiceA, choiceB) === undefined`), und den
engeren Choice verwerfen.

**Pro:**
- Behebt das Problem an der Wurzel, für alle Typen, nicht nur Boolean.
- Entspricht Einheitlichkeit: eine Regel statt vieler Sonderfälle pro Aufrufstelle.
- Typen werden generell kompakter — betrifft auch `typeToString`-Ausgaben, Fehlermeldungen,
  IDE-Hover: `Or(Boolean False)` wird überall zu `Boolean`, nicht nur in der
  Exhaustivitätsprüfung.

**Contra:**
- `createNormalizedUnionType` wird an sehr vielen Stellen aufgerufen (jede Union-Bildung im
  Checker). Ein zusätzlicher O(n²)-Vergleich mit `getTypeError` (selbst nicht billig, siehe
  `checkerStats.getTypeError`) kann sich messbar auf die Performance auswirken — laut
  [CLAUDE.md](../../CLAUDE.md) vor/nach einem solchen Umbau mit `npm run bench` zu prüfen.
- Reihenfolge- und Rekursionsfragen: Bei verschachtelten `Or`/`And`/`Not` kann die
  Teilmengenprüfung selbst rekursiv teuer werden oder in Zyklen laufen (z.B.
  `parameterReference`, die erst zur Laufzeit der Prüfung auflösbar sind).
  `getTypeError` behandelt `any` bereits permissiv (Prinzip Freiheit) — zu prüfen, ob das für
  Teilmengen-Elimination zu aggressiv kollabiert (z.B. `Or(Any X)` sofort zu `Any`, was aktuell
  schon so passiert, aber `Or(X Y)` mit `X` nur *möglicherweise* Teilmenge von `Y` bei
  unauflösbaren Typen nicht fälschlich kollabieren darf — sonst kollidiert es mit Freiheit:
  "im Zweifel erlauben" heißt hier "im Zweifel *nicht* kollabieren", sonst geht Information
  verloren, die z.B. für spätere engere Zuweisungen noch gebraucht wird).
- Größerer Diff in `checker-snapshot.baseline.txt` zu erwarten (viele Typ-Strings ändern sich),
  entsprechend mehr Prüfaufwand beim Verifizieren.

**Aufwand:** Mittel — die Kernlogik ist wenige Zeilen, aber Validierung (Performance, Snapshot-
Diff, Rekursionsfälle) ist der eigentliche Aufwand.

### Option C: Nichts ändern, Test anpassen

Den roten Test so umschreiben, dass er nur den Workaround in `isBranchingExhaustive` prüft, ohne
eine allgemeine Kollaps-Erwartung an `createNormalizedUnionType` zu stellen. Das Problem bleibt
dokumentiert (dieses Dokument), aber unangetastet.

**Pro:** Null Risiko, null Aufwand.

**Contra:** Der nächste ähnliche Fall (nicht-Boolean) reißt dasselbe Loch erneut auf, vermutlich
wieder erst sichtbar über einen entfernten Bug statt geplant.

## Wie andere Sprachen das lösen

### TypeScript: kollabiert Literal-in-Basistyp automatisch

```typescript
type A = boolean | false; // A ist boolean, TypeScript kollabiert automatisch
type B = string | "a";    // B ist string
```

TypeScript prüft beim Erzeugen von Union-Typen, ob ein Member bereits Subtyp eines anderen ist,
und lässt in dem Fall nur den weiteren Typ stehen. Das passiert strukturell, nicht nur bei
Literalen — auch `string | (string & { brand: true })` wird ggf. vereinfacht, wenn keine
zusätzliche Information verloren geht. Kosten: Diese Prüfung ist Teil des ohnehin vorhandenen
Subtyp-Algorithmus, kein separater Zusatzschritt wie bei uns über `getTypeError`.

**Der Algorithmus (`getUnionType` mit `UnionReduction.Subtype`), sinngemäß:**

1. Verschachtelte Unions flach klopfen (wie bei uns).
2. Über eine Map/einen Set nach struktureller Typ-Identität exakte Duplikate entfernen (wie bei
   uns über `typeEquals`) — das ist billig, reine Objekt-/ID-Vergleiche.
3. Nur wenn Subtyp-Reduktion angefordert ist (nicht bei jeder Union-Bildung — viele interne
   Unions in TS werden *ohne* Subtyp-Reduktion gebaut, z.B. reine Literal-Unions aus einem
   Switch, wo Reduktion nichts brächte): für jeden Kandidat-Typ gegen die bereits akzeptierte
   Ergebnisliste prüfen, ob er Subtyp eines schon akzeptierten Typs ist (dann verwerfen) oder ob
   er einen bereits akzeptierten Typ subsumiert (dann den alten verwerfen, neuen aufnehmen).
4. **Größenschwelle:** Ab einer bestimmten Anzahl Member (in der TS-Quelle mit einem Kommentar
   zur vermiedenen quadratischen Explosion versehen) wird die Subtyp-Reduktion übersprungen und
   nur die billige Duplikat-Entfernung angewendet — TS nimmt dann bewusst eine unvollständig
   vereinfachte, aber dafür schnell gebaute Union in Kauf.

Genau Punkt 3 und 4 sind die zwei Elemente, die für unsere Umsetzung relevant sind: Reduktion ist
**nicht überall** nötig (nur dort, wo sie beobachtbar hilft), und es gibt eine **harte
Notbremse gegen O(n²)** bei großen Unions.

### Flow: keine automatische Vereinfachung

Flow behält `boolean | false` typischerweise als geschriebene Union bei und verlässt sich auf
spätere Kontrollfluss-Verengung (Refinement), nicht auf strukturelle Vereinfachung beim Erzeugen
des Typs. Wer die Vereinfachung will, muss sie explizit schreiben.

### Rust: kein strukturelles Analogon

Rust hat keine anonymen Union-Typen dieser Art — `enum`s sind nominal, jede Variante ist explizit
benannt. Ein Fall wie `Or(Boolean False)` kann syntaktisch gar nicht entstehen; das Problem ist
durch das Typsystem-Design ausgeschlossen, nicht gelöst.

### Kotlin/Scala: kein First-Class Union-Typ (bis auf Scala 3 Union-Types)

Scala 3 hat `A | B` als Union-Typ, vereinfacht aber ebenfalls keine Literal/Basistyp-Paare
automatisch — dafür gibt es dort ohnehin keine mit JUL vergleichbaren Wert-Literaltypen im
Union direkt neben ihrem Basistyp im selben Sinne.

### Haskell: das Problem existiert dort nicht

`Bool` ist ein gewöhnlicher ADT mit zwei Konstruktoren (`data Bool = True | False`). `False` ist
ein **Wert** dieses Typs, keine eigene Type-Level-Unterscheidung — es gibt also gar kein `Bool |
False`, gegen das man kollabieren müsste. Erst mit der GHC-Extension `DataKinds` bekommen
Konstruktoren wie `False` eine Promotion zu einem eigenen Kind (`'False :: Bool`), aber das ist
Type-Level-Programmierung für Spezialfälle (z.B. Typebene-Beweise), nicht der Normalfall, und
selbst dort gibt es keine automatische Kollaps-Regel „Literal-Kind + Basistyp ⇒ Basistyp" —
weil in Standard-Haskell niemand freiwillig `Bool | 'False` schreibt.

**Lernpunkt:** Wie bei Rust ist das kein gelöstes Problem, sondern ein durch das Typsystem-Design
ausgeschlossenes. Nominale ADTs kennen keine Literal-Typen neben ihrem Basistyp im selben Union —
das Problem ist spezifisch für Systeme mit strukturellen Literaltypen wie TypeScript und JUL.

**Lernpunkt:** Nur TypeScript unter den verglichenen Sprachen macht das automatisch, weil es
ohnehin einen vollständigen strukturellen Subtyp-Check für andere Zwecke braucht (Kosten sind
also amortisiert). JUL hätte diese Kosten on top, da `getTypeError` bereits eine der teuersten
Operationen im Checker ist (`checkerStats.getTypeError` wird eigens gezählt).

## Bezug zu den Designprinzipien

- **Einheitlichkeit** spricht für Option B: ein lokaler Workaround pro Fundstelle ist genau die
  Ausnahmenliste, die das Prinzip verbietet.
- **Freiheit** (Checker-Ebene) verlangt Vorsicht bei Option B: die Teilmengenprüfung darf im
  Zweifel (nicht auflösbare Typen) nicht kollabieren, sonst geht Information verloren, die
  Prinzip 2 eigentlich bewahren will.
- **Endzustand** spricht tendenziell für Option B (das bessere Design), verlangt aber laut
  eigenem Verfahren ("Wie eine Entscheidung getroffen wird") eine Performance-Messung vor/nach,
  keine Schätzung.

## Offene Fragen vor einer Entscheidung

1. Wie oft kommen Teilmengen-Paare in der Praxis vor (`jul-examples`, yugioh) außerhalb des
   Boolean-Falls? Auszählen, bevor die Kosten von Option B geschätzt werden (Verfahren-Schritt 4).
2. Wie stark schlägt ein zusätzlicher O(n²)-`getTypeError`-Durchlauf in `createNormalizedUnionType`
   tatsächlich auf die Bench-Zeiten durch? Messen, nicht schätzen (Verfahren-Schritt 5).
3. Reicht eine flache Paarprüfung, oder braucht es Rekursion in verschachtelte `Or`/`And` — und
   wenn ja, wie wird eine Endlosschleife bei `parameterReference`/generischen Typen ausgeschlossen?

Keine Empfehlung an dieser Stelle — dafür fehlen noch die Zahlen aus Frage 1 und 2.

## Umsetzungsplan

### Phase 1: Auszählen und Baseline messen

```bash
cd jul-compiler
npm run bench -- --save --note "vor Teilmengen-Elimination in createNormalizedUnionType"
```

Zusätzlich grob auszählen, wie oft Unions mit potentiellen Teilmengen-Paaren in `jul-examples`
und yugioh vorkommen (z.B. über einen Zähler in `createNormalizedUnionType`, analog zu
`checkerStats`), um die Größenordnung des Effekts vor der Umsetzung zu kennen.

### Phase 2: Roter Test bleibt, neue Fälle ergänzen

`union-collapses-boolean-literal-into-boolean` (bereits vorhanden, aktuell rot) plus mindestens:

```typescript
{
	name: 'union-collapses-integer-literal-into-integer',
	code: 'x: Or(Integer 5) = 5',
	// erwartet: typeInfo.type.julType === 'integer', nicht 'or'
},
{
	name: 'union-keeps-unrelated-choices',
	code: 'x: Or(Text Integer) = 5',
	// erwartet: bleibt 'or' — kein falsches Kollabieren nicht verwandter Typen
},
```

### Phase 3: Implementierung mit Größenschwelle

In `createNormalizedUnionType`, nach der bestehenden Duplikat-Entfernung (`uniqueChoices`), vor
dem Stream-Kollaps:

```typescript
// Teilmengen-Elimination nach TS-Vorbild (getUnionType mit UnionReduction.Subtype):
// nur bis zu einer Größenschwelle, sonst O(n²) mit getTypeError - einem der teuersten
// Checker-Aufrufe. Im Zweifel (Schwelle überschritten, oder Typ nicht sicher auflösbar)
// nicht kollabieren - Prinzip Freiheit: lieber ungenauer als fälschlich verengt.
const SUBTYPE_REDUCTION_LIMIT = 20; // TODO Wert durch Messung (Phase 4) belegen, nicht raten
const reducedChoices = uniqueChoices.length <= SUBTYPE_REDUCTION_LIMIT
	? removeSubtypes(uniqueChoices)
	: uniqueChoices;
```

```typescript
/**
 * Entfernt Choices, die bereits Teilmenge eines anderen Choice in derselben Liste sind.
 * Or(Boolean False) => [Boolean]. Reihenfolge in der Ergebnisliste bleibt stabil für die
 * zuerst behaltenen Choices.
 */
function removeSubtypes(choices: CompileTimeType[]): CompileTimeType[] {
	return choices.filter((choice, index) =>
		!choices.some((otherChoice, otherIndex) => {
			if (index === otherIndex) {
				return false;
			}
			// choice ist überflüssig, wenn er Teilmenge von otherChoice ist (jeder Wert von
			// choice passt auch zu otherChoice) - bei Gleichheit gewinnt der erste Index,
			// damit nichts doppelt verworfen wird.
			const isSubtype = !getTypeError(undefined, choice, otherChoice);
			const otherIsAlsoSubtype = !getTypeError(undefined, otherChoice, choice);
			if (isSubtype && otherIsAlsoSubtype) {
				return otherIndex < index; // strukturell gleichwertig, sollte typeEquals schon gefangen haben
			}
			return isSubtype;
		}));
}
```

Danach `expandBooleanChoices` in `isBranchingExhaustive` ([checker.ts](../src/checker.ts))
entfernen — der allgemeine Fix macht den lokalen Workaround überflüssig (Einheitlichkeit).

### Phase 4: Messen und Schwelle belegen

```bash
npm run bench -- --save --note "nach Teilmengen-Elimination in createNormalizedUnionType"
```

Bei Alarm (>50% Regression laut Bench-Ausgabe): `SUBTYPE_REDUCTION_LIMIT` senken und erneut
messen, bis der Trade-off zwischen Vollständigkeit und Laufzeit belegt (nicht geschätzt) ist.

### Phase 5: Snapshot-Verifikation

```bash
UPDATE_SNAPSHOT=1 npx mocha --import=tsx --require ./test-setup.mjs src/checker-snapshot.test.ts
git diff -- src/checker-snapshot.baseline.txt
```

Diff durchsehen: erwartet sind kompaktere Typen (`Boolean` statt `Or(Boolean False)` etc.), keine
neuen Fehler. Jede neue Fehlermeldung im Diff einzeln prüfen, bevor die Baseline übernommen wird.

### Phase 6: yugioh gegenchecken

```bash
node "<Pfad>/jul-compiler/out/cli.js" jul-config.yaml   # im yugioh-Verzeichnis
```

Erwartet: keine neuen Fehler gegenüber dem Stand nach
[branching-error-return-type.md](branching-error-return-type.md).
