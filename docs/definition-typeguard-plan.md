# Plan: Der Typguard einer Definition ist der Typ des Namens

**Stand 2026-11-05: umgesetzt (nicht committet).** Compiler-Suite 1894 grün, Language Server 182 grün,
yugioh ohne Meldung mit 407 grünen Tests. Bench yugioh: `getTypeError` 1952092 → 1872516 (−4,1 %),
`resolvePlaceholders` 2111538 → 2084916 (−1,3 %), `inferType` gleich. Die Wall-Clock-Werte waren beim
Vorher-Lauf verrauscht (Alarm bei `parse`) und taugen nicht zum Vergleich. Abweichungen vom Plan: Die Tests
für `JUL5010` laufen mit `warnUnknown` (sonst meldet der Checker die Warnung nicht). Im Language Server holt der
Test-Helfer Literalfelder jetzt über den Typ des Werts (`getLiteralField` in `references.test.ts`), und der
Completion-Test für Callback-Parameter erwartet `integer` statt `integerLiteral`.

Bei `name: T = wert` hat `name` künftig den Typ `T`. Der Wert wird wie bisher gegen `T` geprüft, sein
inferierter Typ verlässt die Definition aber nicht. Ohne Typguard gilt wie bisher der inferierte Typ. Das ist
dieselbe Regel wie für den deklarierten Rückgabetyp (`declared-return-type-plan.md`): Es gilt, was dasteht.

## Ausgangslage

In `checker.ts` (Fall `definition`) dient der Typguard als erwarteter Typ für die Inferenz des Werts. Danach
bekommt das Symbol den inferierten Typ (`setSymbolTypeInfo(…, typeInfo)` mit `typeInfo` aus `value`), und
`isTypeAssignable(inferiert, Typguard)` meldet `definitionTypeMismatch` oder `JUL5010`. Daneben steht
`// TODO typecheck mit typeguard`. Der Typguard wirkt also wie `satisfies` in TypeScript.

Das ist ein Problem, wenn der inferierte Typ genau, aber für den Zugriff unbrauchbar ist. Beispiel aus
yugioh (`card-effects.jul`):

```
cardEffects: Dictionary(CardEffect) = [
	§1475311§ = [ … ]
	…
]
```

Das Symbol hat den Typ des Record-Literals mit rund 100 Feldern. `cardEffects.getField(cardDataId)` mit einem
Text-Parameter ergibt `Any`, weil ein Record-Typ kein `ElementType` hat (`type-algebra.ts`, Kommentar bei
`dictionaryLiteral`). Der Aufrufer braucht `assume(… Or([] CardEffect))`, obwohl der Checker die Aussage an der
Definition schon bewiesen hat.

### Versuch (2026-11-05)

Im Fall `definition` bekam das Symbol statt `typeInfo` den Typ `valueOf(Typguard)`, sieben Zeilen. Ergebnis:

- **Suite:** 5 von 1886 Tests rot, alle erklärbar:
  - **Snapshot:** Absichtlich falsche Werte in `jul-examples/type-checking-test.jul` zeigen jetzt den Typguard
    (`testOr2: Or(4 5) = 6` → `Or(4 5)`, `testAnd2: And(4 5) = 5` → `Never`). Richtige Werte verlieren ihr
    Literal (`testBoolean1: Boolean = true` → `Boolean`, `testList1: List(Text) = [§aa§]` → `List(Text)`). Bei
    `initialGameState` (tic-tac-toe) stehen die Feldtypen statt der Startwerte. In `autocomplete.jul` zeigt
    `myValue: MyType` jetzt den ganzen `MyType` statt `[field1: Any]`, das ist besser.
  - **Zähler:** `getTypeError` sinkt (6093 → 6088, Stress `stateMachine` 693 → 637), `resolvePlaceholders`
    steigt leicht (7575 → 7582).
  - **`expected-type-list-element-after-spread` und `expected-type-rest-argument-after-spread`:** derselbe
    Fehler an derselben Stelle. `others` ist jetzt `List(…)` statt eines Tupels, die Meldung bekommt deshalb
    die äußere Zeile `Can not assign List(Or(…)) to List(…)` dazu.
- **yugioh:** Build und alle 407 Tests ohne neue Meldung bis auf eine: `JUL2503 Redundant assume` an
  `toGameCards` (`82899f`), genau das Ziel. Build-Zeit unverändert (1,9 s).

## Schritte

### 0. Vorher messen

`npm run bench -- --save --note "vor: Typguard einer Definition gilt"` in `jul-compiler`.

### 1. Rote Tests in `checker.test.ts`

Die Zugriffe stehen in Funktionen mit Parametern als Schlüssel, damit die Faltung das Ergebnis nicht
verdeckt.

- **Dynamischer Zugriff nutzt den Typguard:** `d: Dictionary(Integer) = [x = 1 y = 2]`, dann
  `f = (key: Text) :> Or([] Integer) => d.getField(key)` ohne Meldung. Heute: `JUL5010`.
- **Name hat den Typguard:** `x: Or(1 2) = 1`, dann `h = () :> 1 => x` meldet `returnTypeMismatch`. Heute ohne
  Meldung.
- **Ohne Typguard bleibt der inferierte Typ:** `x = 1`, dann `h = () :> 1 => x` ohne Meldung (grün schon vorher).
- **Kein Folgefehler bei falschem Wert:** `d: Dictionary(Integer) = [x = §a§]` meldet nur
  `definitionTypeMismatch`. Ein späteres `d.getField(key)` als `Or([] Integer)` meldet nichts.
- **Unbewiesener Wert:** `u: Dictionary(Integer) = anyValue` meldet weiter `JUL5010` an der Definition, `u` hat
  danach den Typ `Dictionary(Integer)`.
- **Import:** Ein Symbol aus einer anderen Datei hat beim Importeur den Typguard.
- **`_` bindet nichts:** `_: Integer = §a§` meldet weiter `definitionTypeMismatch` (grün schon vorher). Das ist
  der Weg, nur zu prüfen, ohne den Typ zu verbreitern.
- **Letzte Zeile eines Rumpfs:** `f = () => x: Or(1 2) = 1` hat den Rückgabetyp `Or(1 2)`. Heute `1`.
- **Stream:** Ein annotierter Stream, der in seinem Scope abgeschlossen wird (`withCompletedStream`), bleibt
  `FiniteStream`.

Den roten Lauf zeigen und **anhalten**.

### 2. Umbau im Checker

Im Fall `definition`, an der Stelle, an der das Symbol seinen Typ bekommt: Gibt es einen Typguard, bekommt das
Symbol `{ type: valueOf(Typguard) }` (durch `withCompletedStream`), auch wenn die Prüfung fehlschlägt. Der
Fehler gehört an die Definition, nicht an jede Verwendung. Die Prüfung gegen den Typguard bleibt gegen den
inferierten Typ. Der `TODO`-Kommentar wird durch eine Beschreibung der Regel ersetzt.

Zu prüfen:

- **Der Typ des Ausdrucks `definition`** (`return typeInfo`) wird an zwei Stellen gelesen: als letzte Zeile
  eines Funktionsrumpfs (`inferredReturnType`, Rückgabetyp ohne Deklaration und Prüfung gegen eine
  Deklaration) und als Wert-Import einer Datei, die mit einer Definition endet. Geprüft am 2026-11-05:
  Der Ausdruck bekommt denselben Typ wie das Symbol, also den Typguard. Sonst gäbe `x: T = …` als letzte Zeile
  etwas anderes zurück als `x`. Die Prüfung des Werts gegen den Typguard verwendet weiter den inferierten Typ.
- **Faltung:** `debug: Boolean = false` wird nicht mehr gefaltet, `?(debug)` bleibt eine Verzweigung zur
  Laufzeit. Finding 55 in yugioh (Feature-Flag meldet den toten Zweig als `JUL5152`) entfällt damit. Wer die
  Faltung will, lässt den Typguard weg.
- **Emitter:** Die typgestützte Branch-Emission und die Laufzeittests lesen Symboltypen. Ein breiterer Typ
  heißt dort höchstens ein allgemeinerer Test. Ein Blick in die Snapshots des Emitters genügt.

### 3. Suite und Baselines

- `node --run test`, `npm run typecheck`.
- `npm run test-update-snapshot`. Die Baseline lesen: Erwartet sind die Änderungen aus dem Versuch. Ein neuer
  Fehler ist ein Befund.
- Die zwei Tests `expected-type-*-after-spread`: neue Meldung übernehmen. Der Fehler und seine Stelle bleiben
  gleich.
- jul-examples: ein paar Projekte mit `check` und `test`. `type-checking-test.jul` prüft danach den Wert gegen
  den Typguard und zeigt den Typguard. Wenn die Datei Literal-Typen vorführen soll, Typguards dort entfernen.
- Language Server: `npm test`, danach `npm run build-all` im Compiler und `npm run test-snapshot`. Im Hover
  stehen bei annotierten Definitionen jetzt die Typguards.

### 4. yugioh mitmigrieren

`jul` zeigt per Symlink auf `jul-compiler`.

1. `toGameCards` (`game-logic.jul`, assume `82899f`): `effect = cardEffects.getField(cardDataId)` ohne
   `assume`, den falschen Kommentar „große Datei“ entfernen. Das meldet der Build als `JUL2503`.
2. `jul` bauen: keine Warnung.
3. Alle Tests über `node scripts/bench/measure-build.js --message "Typguard einer Definition gilt"`.
4. `node scripts/assume-inventory.js`, Inventar (`82899f`: Compiler) und `docs/jul-findings.md` (Finding 13,
   Abschnitt `getField`, und Finding 55) nachtragen.

`allCardData` (`card-data.json` über `maxTypedFileSize`, Finding 63) könnte danach als
`allCardData: Dictionary(CardData) = allCardDataUntyped` stehen. Das wäre aber nur ein `assume` mit Warnung
und kein Gewinn. Es bleibt beim kommentierten `assume`.

### 5. Doku

- **Handbuch** (`jul-homepage/docs/docs/documentation/handbook.md`, Abschnitt Definitionen): `name: T = wert`
  prüft den Wert gegen `T`, danach ist `name` ein `T`. Ohne Typguard hat `name` den genauen Typ des Werts.
  `_: T = wert` prüft nur. Beispiel mit einem Dictionary-Literal und `getField`.
- **`design-principles.md`:** Der Hinweis beim Rückgabetyp („der Aufrufer liest den Typ aus der Signatur“)
  gilt jetzt auch für Definitionen, einheitlich in einem Satz.

### 6. Nachher messen

`npm run bench -- --save --note "nach: Typguard einer Definition gilt"`. Erwartet wird kaum eine Änderung, im
Versuch blieb die Build-Zeit von yugioh gleich.

## Risiken

- **Grobe Typguards kosten Genauigkeit:** `x: Any = …` oder `x: Dictionary(Any) = …` gibt ab jetzt genau das
  weiter. Man sieht es an `JUL5010` bei der Verwendung, die Abhilfe ist ein genauerer oder gar kein
  Typguard. Das ist gewollt.
- **Typguard auf `Any` wirkt wie `assume`:** Der Name hat den Typguard, die Warnung `JUL5010` bleibt an der
  Definition. Wer sie unterdrückt, hat ein ungeprüftes `assume`.
- **Externe Projekte:** Sie brechen nur dort, wo sie sich auf einen engeren Wert einer annotierten Definition
  verlassen. In der Suite und in yugioh war das nie der Fall.

## Verworfen: Schnitt aus Wert und Typguard

`name` hätte `And(inferiert T)` bekommen. Die Normalisierung erledigt das schon weitgehend (Literale bleiben,
Records werden feldweise zusammengeführt, nur Record mit `Dictionary(X)` bleibt ein `And`), und `getField`
liefert auf `And(Dictionary(Integer) [x: 1 y: 2])` heute schon `Or([] Integer)`. Verworfen, weil:

- Die Anzeige hätte für Hover und Meldungen den Typguard zeigen müssen, sonst stünde dort ein Record mit 100
  Feldern. Damit hätte der Checker anders gerechnet, als die Anzeige sagt.
- Der Literal-Anteil hilft nur bei festen Schlüsseln und bei der Faltung. Beides ist auch ohne Typguard zu
  haben.
- Spread und `mapDictionary` haben Lücken bei `And` (`[...d z = 3]` ergibt `Any`, `mapDictionary` ergibt
  `Or(Empty List(…))`, beides geprüft 2026-11-05). Diese Lücken wären vorher zu schließen gewesen. Sie bleiben
  als eigene Bugs bestehen, sind aber für diesen Plan nicht nötig.
- Die Regel wäre die Gegenregel zum deklarierten Rückgabetyp.

## Ergänzung, unabhängig davon

`ElementType` eines vollständigen Records als Vereinigung der Feldtypen. Das ist korrekt, weil Records
geschlossen sind (`JUL5050 Unexpected field`), und `spreadDictionaryTypes` nutzt es schon
(`Object.values(side.FieldTypes)`). Damit ginge `getField` auch auf Records ohne Typguard.
