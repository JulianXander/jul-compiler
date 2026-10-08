# Invalid-Typ: Umbauplan

Umsetzungsplan. Der Checker bekommt einen eigenen Typ für „hier wurde schon ein Fehler gemeldet“,
getrennt von `Any`. Hintergrund: [CHECKER-AUDIT.md](CHECKER-AUDIT.md), Abschnitt zu den drei
Bedeutungen von `Any`.

## Problem

`Any` steht heute für drei Dinge: unbekannt (Import ohne Typinformation), bewusst nachsichtig
(Parameter ohne Typ) und „Fehler schon gemeldet, sei still“. Nach einem Fehler gibt der Checker
`builtinAny` zurück (Kommentar in `checker.ts`: „Any als Ergebnis, damit sich der Fehler nicht
kaskadierend fortsetzt“). Dort wirkt `Any` aber nicht neutral, sondern wie der Übertyp, und die
Typoperatoren rechnen damit. Gemessen am Stand vor dem Umbau, jeweils mit **nur** dem Fehler
`'undefinedName' is not defined.` als Ursache:

| Snippet | Folgemeldung heute |
|---|---|
| `a: Not(undefinedName) = 1` | 5000 `Can not assign 1 to Not(Any).` (`Not(Any)` ist `Never`) |
| `a: Without(undefinedName Integer) = 1` | 5000 `Can not assign 1 to Not(Integer).` |
| `a: And(undefinedName Integer) = §t§` | 5000 `Can not assign §t§ to Integer.` |
| Branch `(u: undefinedName) => 1` vor `(i: Integer) => 2` | 5152 `Unreachable branch detected.` (der Parameter `Any` fängt alles) |

Dazu der Zweig in `isTypeAssignableAtDepth` (`type-algebra.ts`) mit dem offenen Kommentar
„TODO error/warning bei any? error type bei assignment/function call?“. Mit eingeschalteter
`warnUnknown` wird jede Verwendung eines Fehler-`Any` zusätzlich als `typeNotProven` (5010)
gemeldet, weil `Any` als Quelle `unknown` liefert.

Umfang laut grep: 59 Stellen mit `builtinAny` in `checker.ts`, 27 in `type-algebra.ts`, 2 in
`reference-index.ts`, neun `case 'any':` in `type-algebra.ts` und einer in `syntax-tree.ts`. Der
Language Server nutzt `builtinAny` nicht.

## Entscheidungen

1. **Eigener Typ** `InvalidType` mit `julType: 'invalid'` und `builtinInvalid`. Er ist **kein**
   Name im Namensraum (nicht in `builtInSymbols`), der Nutzer kann ihn nicht schreiben. Ausgabe in
   `typeToString`: `Invalid`.
2. **Invalid absorbiert.** Als Quelle und als Ziel von `isTypeAssignable` ist es `yes` (nicht
   `unknown`, es gibt also auch keine `typeNotProven`-Warnung). `Not`, `And`, `Or` und `Without`
   mit einem Invalid-Operanden ergeben Invalid. Das ist die Linie von rustc und Roslyn: Ein
   Operand, der schon fehlerhaft ist, macht den Ausdruck fehlerhaft, statt halb zu rechnen.
   Container bleiben gültig: `List(Invalid)` ist eine Liste mit Invalid-Element, Zuweisbarkeit
   elementweise `yes`.
3. **`Any` bleibt unverändert**, auch als Quelle `unknown`. Ob `Any` später in „Übertyp“ und
   „dynamisch (Import)“ zerfällt, ist eine eigene Entscheidung und nicht Teil dieses Umbaus.
4. **Herkunftsregel:** Invalid entsteht nur, wo für den Ausdruck bereits ein Fehler (Schweregrad
   `error`) gemeldet ist, vom Parser oder vom Checker. Unvollständige Ausdrücke beim Tippen zählen
   dazu, der Parser hat sie gemeldet. Die Regel wird als Test erzwungen (Phase 7), sonst
   verschwindet ein Fehler still.
5. Der Emitter sieht nie Invalid, weil bei einem Fehler nicht emittiert wird.

Die Typalgebra bleibt importfrei gegenüber `checker.ts`, `builtinInvalid` kommt aus
`syntax-tree.ts`, wie `builtinAny`.

## Vorgehen

Jede Phase: erst die roten Tests schreiben, laufen lassen, den roten Output zeigen, **dann
anhalten**. Erst nach Freigabe kommt der Fix. Nach jeder Phase `node --run test` und `npm run
typecheck`. Der Zähler-Gate in `checker-snapshot.test.ts` darf sich nur dort bewegen, wo die Phase
es nennt, eine neu geschriebene Baseline wird angesehen. Vor Phase 1 und nach der letzten Phase
`npm run bench -- --save --note "…"` auf `C:\Projects\privat\yugioh`, nicht bei laufender Last.
Danach `npm run build-all` und `npm run test-snapshot` im Language Server.

### Phase 1: Typ einführen, Zuweisbarkeit

Tests in `type-algebra.test.ts`, jeder mit eigenem `it`:

```ts
it('invalid-ist-nicht-any', () => {
	expect(typeEquals(builtinInvalid, builtinAny)).to.equal(false);
});
it('invalid-ist-gleich-invalid', () => {
	expect(typeEquals(builtinInvalid, builtinInvalid)).to.equal(true);
});
it('invalid-to-string', () => {
	expect(typeToString(builtinInvalid)).to.equal('Invalid');
});
it('invalid-als-quelle-ist-zuweisbar', () => {
	expect(isTypeAssignable(builtinInvalid, builtinInteger)).to.deep.equal({ assignable: true });
});
it('invalid-als-ziel-ist-zuweisbar', () => {
	expect(isTypeAssignable(builtinInteger, builtinInvalid)).to.deep.equal({ assignable: true });
});
it('any-als-quelle-bleibt-unknown', () => {
	expect(isTypeAssignable(builtinAny, builtinInteger)).to.deep.equal({ assignable: undefined });
});
```

Rot: `builtinInvalid` existiert nicht (Kompilierfehler). Der letzte Test ist grün und sichert die
Grenze zu `Any`.

Fix: `InvalidType` und `builtinInvalid` in `syntax-tree.ts`, `'invalid'` in `CompileTimeType`. Der
Compiler führt über jedes erschöpfende `switch` auf `julType` zu den Stellen (`case 'any':` in
`type-algebra.ts`: `forEachChildType`, `typeToString`, `dereference`, Guards, Normalisierung).
Invalid verhält sich dort wie Any, außer in `isTypeAssignableAtDepth`: Prüfung auf Invalid
**vor** der `any`-Prüfung, beide Richtungen `yes`. `typeEquals` kennt keinen Sonderfall.
Erwartung: Snapshot und Zähler unverändert, weil noch niemand Invalid erzeugt.

### Phase 2: Fehlerstellen erzeugen Invalid

Erste Stellen: unaufgelöster Name (`type: builtinAny, found: false` in `checker.ts` um Zeile 451),
`nestedKey` mit Fehler (die beiden Stellen „Any als Ergebnis, damit sich der Fehler nicht
kaskadierend fortsetzt“, `nestedKey.name < 1`, fehlender Feldname), „keine Funktion“ (Zeile ca.
2692), Destructuring mit gemeldetem Namen (Zeile ca. 2412).

Tests in `checker.test.ts`. Dafür ein kleiner Helfer `expectTypeOfLastExpression(code, typeString)`
neben `expectCheck`, erzeugt mit `reportAtCaller`:

```ts
it('invalid-undefinierter-name', () => {
	expectLastTypeString(`x = undefinedName
x`, 'Invalid');
});
it('invalid-feld-auf-invalid', () => {
	expectLastTypeString(`x = undefinedName
x/foo`, 'Invalid');
});
it('invalid-aufruf-einer-nichtfunktion', () => {
	expectLastTypeString(`f = 1
f(2)`, 'Invalid');
});
it('any-bleibt-any-bei-assume', () => {
	expectLastTypeString(`x = assume(1 Any)
x`, 'Any');
});
```

Jeweils auch `errors` des Falls (nur die eine Ursache), wie überall mit vollständigem Objekt.
Rot: heute `Any`. Erwartung nach dem Fix: Zähler bewegen sich nur leicht. Der letzte Test ist
grün und sichert, dass `Any` aus anderen Quellen bleibt.

Zu klären beim Umstellen, nicht vorab: ob eine Stelle Fehler-`Any` oder `Any` aus „unbekannt“
liefert. Maßstab ist die Herkunftsregel. Stellen ohne gemeldeten Fehler (zum Beispiel
übersprungene Dateien über 100 kB, `skipped`) bleiben `Any`.

### Phase 3: Typoperatoren

Tests in `checker.test.ts`, die vier Fälle aus der Tabelle oben, jeweils mit **nur** dem
Fehler 3201 und seiner Position:

```ts
it('not-invalid-meldet-keine-folgefehler', () => {
	expectCheck('a: Not(undefinedName) = 1', {
		errors: [{
			code: ErrorCode.notDefined,
			message: "'undefinedName' is not defined.",
			startRowIndex: 0, startColumnIndex: 7, endRowIndex: 0, endColumnIndex: 20,
		}],
	});
});
it('without-invalid-meldet-keine-folgefehler', ...);   // Spalten 11 bis 24
it('and-invalid-meldet-keine-folgefehler', ...);       // `a: And(undefinedName Integer) = §t§`, Spalten 7 bis 20
```

Dazu Gegenproben, grün: `a: Not(Any) = 1` meldet weiter 5000, `a: And(Any Integer) = §t§` weiter 5000,
`a: Or(undefinedName Integer) = §t§` bleibt bei 3201.
Dazu Tests für das Zusammentreffen mit `Any`: `Or(Any Integer)` bleibt `Any` (grün), `Or(Invalid Integer)` ist `Invalid`, `Or(Any Invalid)` ist `Invalid`, weil der Fehler schon gemeldet ist. Als Einheitentest an der Normalisierung (`typeToString` des Ergebnisses), nicht über Quelltext, weil `Invalid` nicht schreibbar ist.

Rot: Folgefehler 5000. Fix: `createNormalizedComplementType`, die Vereinigungs- und
Schnittnormalisierung in `checker.ts` und `type-algebra.ts` (Zeilen um 2066, 2246, 2451) geben bei
einem Invalid-Operanden Invalid zurück, `Without` über `And`/`Not`.

### Phase 4: Branching

```ts
it('branch-parametertyp-invalid-ist-nicht-unerreichbar', () => {
	expectCheck(`f = (x: Integer) =>
	?(x)
		(u: undefinedName) => 1
		(i: Integer) => 2`, {
		errors: [{
			code: ErrorCode.notDefined,
			message: "'undefinedName' is not defined.",
			startRowIndex: 2, startColumnIndex: 6, endRowIndex: 2, endColumnIndex: 19,
		}],
	});
});
it('branch-scrutinee-invalid-meldet-keinen-error-typ', ...);
```

Rot: heute zusätzlich 5152 am zweiten Branch. Der zweite Test: Ergebnis der Auswertung mit
Invalid als Scrutinee darf `Error` (kein Treffer) nicht in den Rückgabetyp aufnehmen. Fix in
`branch-dispatch.ts` und dem Branching-Teil des Checkers: Ein Branch mit Invalid-Parametertyp
nimmt dem Rest nichts weg und gilt nicht als unerreichbar, ein Invalid-Scrutinee gilt als
erschöpfend.

### Phase 5: Restliche Erzeuger

Einordnung der übrigen `builtinAny` (Stand nach Phase 4, `checker.ts` 55 Stellen, `type-algebra.ts`
rund 25, `reference-index.ts` 1). Maßstab ist die Herkunftsregel: Invalid nur, wo für den Ausdruck
schon ein Fehler gemeldet ist. Die Zeilen sind Orientierung und verschieben sich.

**A. Fehler schon gemeldet, wird Invalid** (je ein roter Test, Parser-Fehler zählen)

| Stelle | Anlass | gemeldet von |
|---|---|---|
| `inferType` `binding`/`data` (um 2019, `// TODO?`) | unaufgelöster Klammerknoten | Parser |
| Branch-Kopf nach 5003 (um 2212 und 2224, jeweils nur der Fallback) | Params-Typ beschreibt keine Argumentkollektion | Checker |
| Aufruf ohne Funktion (um 2589), z. B. `x.` | Funktion fehlt | Parser 1010 |
| `nestedReference` ohne Schlüssel (um 3110) | `a/` unvollständig | Parser |
| Index `< 1` (um 3129) und Name ohne gültigen Text (um 3164) | Schlüssel ungültig | Parser |
| leerer Funktionsrumpf (um 2951) | `f = () =>` | Parser 1152 |
| `import` ohne Pfad (um 3523) | Pfad nicht bestimmbar | Parser oder Checker (`error`) |
| Rückgabetyp und Parametertyp eines Invalid-Werts (`getParamsType`, `getReturnTypeFromFunctionType`, um 4684 bis 4695) | Aufruf von `x` mit `x = undefinedName` liefert heute `Any` | Checker 3201 |

**B. Typfunktionen mit Invalid-Operand** (`And`, `ElementAt`, `LengthOf`, `WithElementAt`,
`IndexRange`, `MapElements`, `Concat`, `Add`, `Or`, `TypeOf`, `GreaterInteger`, `LessInteger`; um 3547
bis 3682): Ist das Argumentbündel oder ein Operand Invalid, ist das Ergebnis `TypeOf(Invalid)`, wie
es `Not` schon tut. Eine Prüfung vor dem `switch` über die Namen. `valueOf` und
`mapElementType` müssen Invalid durchreichen, nicht zu Any machen. Die Rückgabe `Any` bei fehlenden
Argumenten (`!argTypes`) bleibt, sie heißt "nicht bestimmbar".

**C. Bleibt Any** (unbekannt oder neutral, kein Fehler gemeldet)

- `Any` selbst (`coreBuiltInSymbolTypes`, Zeile 276), `Not(Never)` ist Any (1382), Signatur von
  `nativeFunction` (346), `anyFunctionType` in `checkIsFunction` (4988).
- Rekursive Funktion als Selbstverweis (484, "ein Wert bleibt bei Any").
- Fehlendes `typeInfo` als neutrales Element beim Verengen (1265, 2848) und bei vorläufigen
  Argumenten (2665), Purität ohne Funktionstyp (3960).
- Nicht auflösbare Spread-Quelle (3083), unentschiedene Referenz "abwarten" (3204), `expectedType`
  ohne TypeGuard (3286).
- `import` ohne geladene Datei, ohne Definitionen oder ohne letzten Ausdruck (3529 bis 3555). Eine
  übersprungene Datei über 100 kB ist kein Fehler.
- `type-algebra.ts`: Nachschlagen ohne Treffer (1197, 1248), unbewiesene Typen (`type`,
  `conditional`, `withElementAt`, 506), Rest-Parameter ohne Positionen (974), Alias ohne Symbol oder
  zu tief (3095, 3157, 3177), Parameter-Fallbacks (3208 bis 3215, 4208 bis 4511), `Or(A Not(A))` und
  `Or(… Any)` (2082, 2122).
- `reference-index.ts` 70.

**D. Prüfen, bevor entschieden wird** (je ein Probelauf, Ergebnis hier eintragen)

- Definition ohne Wert (2271), Destructuring ohne Wert (2372), Dictionary-Feld ohne Wert (2478),
  `literalType`/`dictionaryType` undefined (2507, 3269): Fallback bei unvollständigem Ausdruck. Ist der
  Fehler immer vom Parser gemeldet, wird es Invalid, sonst bleibt es Any.
- Destructuring-Ergebnis (2422): liefert immer Any, auch ohne Fehler. Vermutlich bleibt es Any, weil die
  Definition keinen Wert hat.
- `Any` in `getAllArgTypes`-Fällen mit fehlender Argumentliste (3514): `functionCall.arguments` fehlt
  nur beim Tippen, also Invalid? Eine Probe mit `And` ohne Klammern entscheidet.

**Stand nach den Proben**

- A umgesetzt: `binding`/`data` (ein nicht auflösbarer Klammerknoten, z. B. der Wert einer Definition
  `d = [a = 1 b =]` oder `f = () => ()`), Aufruf ohne Funktion, `nestedReference` ohne Schlüssel, Index
  `< 1`, leerer Funktionsrumpf (dazu ist so ein Rumpf nicht mehr faltbar, sonst wertete `f()` zu
  `Empty` aus), `import` mit nicht bestimmbarem Pfad, Aufruf eines Invalid-Werts.
- Nicht geändert, weil kein sichtbarer Unterschied zu messen war: der Rest-Zweig des `:?`-Kopfes nach
  5154 und die Fallbacks bei fehlendem Wert in Destructuring und Dictionary-Feld (laufen über 3201
  und sind dort schon Invalid).
- Bleibt Any: Name mit leerem Text (`x/§§`, meldet keinen Fehler: Lücke fürs Audit), Import mit
  interpoliertem Pfad oder fehlender Datei (kein gemeldeter Fehler), Destructuring-Ergebnis,
  Parameter ohne Typ.
- Nebenbei behoben: Der Fehler 3130 trug `importExpression.endColumnIndex` als Endzeile.

Reihenfolge: B zuerst (kleinster Eingriff, eine Prüfung), dann der Invalid-Aufruf aus A (heute
`Any`, ein klarer roter Fall: `x = undefinedName`, `y = x(1)`, `y` hat `Any`), dann die
Parser-gemeldeten Stellen aus A, dann D nach den Proben.

Tests für Parser-Fehler brauchen einen Helfer `expectLastTypeString` ohne die Prüfung, dass der
Parser fehlerfrei ist (neuer Parameter oder zweiter Helfer). Jede Gruppe ein eigener Schritt mit
rotem Test, danach Pause.

### Phase 6: Vorbedingungen ersetzen (Ergebnis: nichts zu ersetzen)

Die Bestandsaufnahme hat gezeigt, dass die Vorbedingungen nicht wegen eines Fehler-`Any` da sind:

- `hasKnownFields` und `hasKnownLength` (`type-algebra.ts`, genutzt in `checker.ts` bei den
  `dereferenceFailed`-Meldungen und in `dereferenceNestedKeyFromObject`) fragen, ob ein Typ seine
  Feld- bzw. Längenmenge **schon kennt**. Das betrifft noch nicht ausgewertete Typen, nicht Fehler.
  Invalid und Any liefern dort `false`, es wird kein Fehler gemeldet, wie es sein soll.
- `containsAny` (`branch-dispatch.ts`) hat `default: return true`, Invalid fällt dort in den vollen
  Check wie Any.
- `nestedKey.name < 1` schützt vor dem Nachschlagen mit einem Parser-gemeldeten Index und liefert jetzt
  Invalid. Die Prüfung bleibt nötig, sonst würde ein Schlüssel nachgeschlagen, den es nicht gibt.
- `hasReliableTypeError` gibt es seit der dreiwertigen Zuweisbarkeit nicht mehr.
- Die `=== 'any'`-Prüfungen im Branching (catchAll, exhaustive, unerreichbar) sehen Invalid als
  unbekannten Kopf. Probe: Ein Branch, der ein Invalid-Ausdruck ist (`?(x)` mit `undefinedName` als
  Branch), liefert dieselben Meldungen wie vor dem Umbau, nur der Rückgabetyp ist Invalid statt Any.

Es gibt also nichts zu ersetzen. Die Zeile im Audit („jeder Konsument prüft seine Vorbedingung selbst“)
beschreibt dann eine andere Sache (noch nicht ausgewertete Typen) und wird in Phase 7 entsprechend
angepasst.

### Phase 7: Absicherung und Anschluss

- **Herkunftsregel als Test:** In der Snapshot-Suite zählt der Test alle Ausdrücke mit Typ
  `invalid` und fordert, dass die Datei mindestens einen Fehler mit Schweregrad `error` hat.
  Rot: ein künstlicher Fall, in dem eine Stelle Invalid ohne Fehler erzeugt. Dazu ein Test mit
  `warnUnknown`: Ein Invalid erzeugt keine `typeNotProven`-Warnung.
- **Language Server:** `hover`, `completion` und `symbol-lookup` prüfen, was sie bei Invalid
  zeigen (Ziel: wie bisher bei `Any`, Hover zeigt `Invalid`). Unit-Test je Modul mit
  `createInMemoryHost`, danach `npm run test-snapshot` gegen die Baseline, Abweichungen ansehen.
- **Dokumente:** `CHECKER-AUDIT.md` bekommt in „Fallen im Checker“ die Regel (Fehlerstellen
  liefern Invalid, nicht Any), der Punkt zu den drei Bedeutungen wird angepasst. Der offene Kommentar
  in `isTypeAssignableAtDepth` entfällt. `design-principles.md` nur, wenn die Herkunftsregel als
  Prinzip gelten soll. `three-valued-assignability.md` bekommt einen Satz: Invalid ist immer `yes`.
- Die zweite Entscheidung (Übertyp und dynamisch trennen) kommt nach `docs/backlog/`.

## Risiken

- **Performance:** Invalid darf in `createNormalizedUnionType` und `typeEquals` keinen Mehraufwand
  bringen. Der Absorptionsfall steht vorn und beendet früh. Gemessen wird auf yugioh vor Phase 1,
  nach Phase 3 und am Ende, das Audit nennt ein Beispiel für 4-fache Zeit durch ein präziseres `Any`.
- **Vergessene Stellen:** Ein Typ, der als `Any` weiterläuft, bleibt einfach wie heute. Das Risiko
  ist also ein Fehler, der nicht verbessert wird, kein neuer Falschfehler. Ausnahme: Stellen, die
  `julType` nicht per `switch` prüfen, sondern `=== 'any'`. Davor sucht Phase 1 mit grep nach
  `'any'` auch außerhalb von `switch` (`type-algebra.ts` um 2066, 2246, 2451, 3351, 3354).
- **Falsche Herkunft:** Eine Stelle liefert Invalid, obwohl nichts gemeldet ist. Das fängt der Test
  aus Phase 7 nur für die Fälle der Snapshot-Fixtures. Jede Umstellung nennt deshalb den Fehler,
  der gemeldet ist, im Kommentar.
- **Baseline:** Zähler und Snapshot bewegen sich in Phase 3 und 4 absichtlich (weniger
  Folgefehler). Jede neu geschriebene Baseline wird Zeile für Zeile angesehen.
