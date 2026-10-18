# Plan: Benannte Argumente nur in deklarierter Reihenfolge, `params` zur Laufzeit abbauen

Entschieden: Benannte Argumente müssen in der Reihenfolge der Parameter stehen. Sie sind damit
Beschriftungen, die der Checker prüft, keine Zuordnung zur Laufzeit. Das ersetzt die Entscheidung
„freie Reihenfolge" in [backlog/typed-emission.md](backlog/typed-emission.md).

Ziel: Der Emitter schreibt jeden Aufruf mit bekanntem Funktionstyp als positionalen JS-Aufruf. Damit
braucht eine gewöhnliche Closure kein `params` mehr, das Hoisting aus
[js-performance-plan.md](js-performance-plan.md) entfällt, und `_callFunction`, `assignArgs` und
`_combineObject` für Argumente können verschwinden.

## Ausgangslage

- Der Checker prüft ein Dictionary-Argument strukturell gegen den Parametertyp, die Reihenfolge
  der Schlüssel ist ihm egal. `f(b = x a = y)` ist heute erlaubt.
- Der Emitter ordnet benannte Argumente nur dann statisch zu, wenn die Funktion ein JUL-Literal
  ist (`literalParameterNames`, `namedArgumentsToDirectCallJs` in `emitter.ts`). Sonst läuft der
  Aufruf über `_callFunction` und `assignArgs`, die zur Laufzeit `fn.params.singleNames` lesen.
- `namedArgumentsToDirectCallJs` enthält Temporaries und ein Arrow, nur damit die Auswertung bei
  umsortierten Argumenten in geschriebener Reihenfolge bleibt. Das entfällt mit dem Verbot.
- Leser von `params` zur Laufzeit: `_callFunction`/`assignArgs` (benannte Aufrufe),
  `_branch`/`tryAssignArgs` (Branches), `_isOfType` für Prädikate (`runtime.ts:280`),
  `'params' in fn` als Unterscheidung JUL-Funktion gegen JS-Funktion in `_callFunction`.
- Alle rund 540 Builtins in `runtime.ts` tragen `params`, nur für `_callFunction`.

## Schritt 0: Messen, bevor irgendetwas geändert wird

Ein Skript (AST-basiert wie `migrate-*.mjs`, Ablage `scripts/`, nicht im Test-Lauf) über yugioh,
`jul-examples`, `core-lib.jul` und die Test-Fixtures. Gezählt wird je Fund mit Datei und Zeile:

1. Aufrufe mit benannten Argumenten, deren Reihenfolge von den Parametern abweicht.
2. Aufrufe mit benannten Argumenten, deren Funktionstyp nicht bekannt ist (`Any`, Parameter ohne
   Typ, Funktion aus `.js`/`.ts` ohne Typen).
3. Aufrufe mit Spread in die Argumentliste (`f(...x)`, AST-Typ `object`).
4. Gemischte Argumentlisten (positional und benannt zugleich), falls die Syntax sie zulässt.
5. Funktionen, die als Prädikat in Typposition stehen (`Or(1 istGerade)`, `Not(...)`).

Das Ergebnis entscheidet über die Punkte „Offene Entscheidungen" unten.

### Ergebnis Schritt 0

Gemessen mit `scripts/probe-argument-order.ts` (`npx tsx scripts/probe-argument-order.ts <ordner...>`).

| | yugioh (7150 Aufrufe) | jul-examples (485 Aufrufe) |
|---|---|---|
| benannt, in Reihenfolge | 29 | 1 |
| benannt, Reihenfolge abweichend | 0 | 1 (`function-call.jul:13`, die Demo „2.1") |
| Spread `f(...x)` in Argumenten | 0 | 4 (alle in `function-call.jul`, die Demos) |
| benannt, Funktionstyp ohne Namen | 0 | 5 |

Folgerungen:

- **Das Verbot kostet in yugioh nichts**: Alle 29 benannten Aufrufe stehen schon in Reihenfolge.
  Ein Migrationswerkzeug ist nicht nötig. In `jul-examples` ändert sich nur die Demo.
- **Der Funktionstyp trägt die Parameternamen bereits**: `calledFunctionType.ParamsType` ist ein
  `ParametersType` mit `singleNames` (`syntax-tree.ts`). Schritt 1 und 2 brauchen dafür keinen neuen
  Typ, nur den Zugriff darauf. Zu prüfen bleibt, ob ein `source`-Alias dort schon aufgelöst ist.
- **Die fünf Fälle ohne Namen sind Sonderformen**, keine unbekannten Typen: Funktionen mit
  Typ-Kopf (`typeFunction = MyType => …`, `function-call.jul:50`), Rest-Parameter
  (`restFunction(a = 1 b = 2)`, `function-call.jul:70`) und ein Aufruf einer nicht existierenden
  Funktion (`booleanInput`, `dynamic-form2.jul`, Datei mit Fehlern). Beide Sonderformen brauchen keine
  Laufzeitbindung für benannte Argumente (geprüft an den Demos in `function-call.jul`, siehe
  Entscheidung 6).
- Fehlt im Probe-Lauf: Prädikate in Typposition (Kategorie ohne Treffer in beiden Projekten) und
  gemischte Argumentlisten (nicht erfasst, der Parser kennt sie vermutlich nicht).

## Schritt 1: Checker

- Neuer Fehlercode in `compiler-errors.ts` (nächste freie Nummer in der Gruppe der Argumentfehler,
  neben `JUL5050`): benannte Argumente stehen nicht in der Parameterreihenfolge. Die Meldung nennt
  die erwartete Reihenfolge.
- Regel: Die Namen der benannten Argumente sind eine Teilfolge der Parameternamen
  (`source` vor `name`, wie in `getLiteralParameterNames`). Ein `prefixArgument` belegt den ersten
  Parameter. Weglassen bleibt erlaubt, wo der Parametertyp `Empty` zulässt (heutiges Verhalten,
  `JUL5050` sonst). Die Reihenfolge wird an der Aufrufstelle geprüft, nicht über den Typ: Ein
  Dictionary-Typ bleibt ungeordnet.
- Der Funktionstyp muss die Parameternamen für alle Funktionen tragen, nicht nur für Literale
  (`literal` an der Funktionstyp-Struktur). Für `nativeFunction` stehen sie in der Signatur der
  core-lib, für `.ts`-Importe kommen sie aus der Signatur. Zu prüfen, ob `calledFunctionType`
  genügt.
- Tests (Mocha, `expectCheck`): richtige Reihenfolge, vertauscht, Teilfolge mit Auslassung,
  Auslassung eines Pflichtparameters, `prefixArgument` plus benannt, `source`-Alias, Funktion
  aus `.ts`.
- Der Checker-Snapshot und das Zähler-Gate schlagen an, die neu geschriebene Baseline wird
  angesehen, nicht blind übernommen.

## Schritt 2: Emitter, direkte Aufrufe

- `namedArgumentsToDirectCallJs` vereinfachen: Auswertungsreihenfolge gleich Schreibreihenfolge
  gleich Parameterreihenfolge. Temporaries, `needsTemporaries` und `isTrivialArgument` entfallen.
  Ausgelassene Parameter in der Mitte werden zu `undefined`, am Ende entfallen sie.
- Parameternamen nicht mehr nur aus `functionType.literal`, sondern aus dem aufgelösten Funktionstyp
  (siehe Schritt 1), damit auch Builtins, Funktionswerte und Parameter vom Typ Funktion direkt
  aufgerufen werden.
- Bleibt ein Aufruf mit benannten Argumenten ohne bekannten Funktionstyp, folgt die Regel aus
  „Offene Entscheidungen" (Vorschlag: Fehler).
- Spread: `f(...list)` mit statischem List-Typ wird ein JS-Spread. Der Checker verwirft Spread mit
  anderem Typ (siehe Entscheidung 2), damit bleibt kein `object`-Argument mehr, das `_combineObject`
  bräuchte.
- Emitter-Tests in `emitter.test.ts`: direkter Aufruf für JUL-Literal, Builtin, Funktionswert,
  Auslassung in der Mitte.

## Schritt 3: Runtime

Erst nach Schritt 2 und nur, wenn Schritt 0 keine verbleibenden Nutzer von `_callFunction` zeigt:

- `_callFunction`, `assignArgs` und `_combineObject` (soweit nur für Argumente) entfernen. Die
  Unterscheidung JUL gegen JS in `_callFunction` entfällt damit, es gibt nur noch direkte Aufrufe.
- `_createFunction(fn, params)` bleibt für Branches, Typ-Köpfe und Prädikate. Die Builtins in
  `runtime.ts` verlieren ihre `params`, wenn kein Leser mehr übrig ist. Das verkleinert die
  Runtime und beschleunigt das Laden.
- `test-runtime.ts`, `runtime-shaking.ts` und die Sandbox des constant folding
  (`createBudgetedCreateFunction` in `checker/constant-folding.ts`) prüfen, ob sie `params` oder
  `_callFunction` voraussetzen.
- Nach jeder Änderung an `runtime.ts`: `npm run check-runtime-purity`.

## Schritt 4: Emitter, `params` nur wo nötig

- Ein Funktionsliteral bekommt `params` (also `_createFunction`), wenn die Laufzeit sie liest. Das tut nur
  `tryAssignArgs`, für die Branches von `_branch` und für ein Prädikat in Typposition. Es prüft Typen aus der
  Liste (Typ-Kopf, Parametertypen, Typ des Rest-Parameters) und bindet sonst nur der Reihe nach, wie ein
  direkter Aufruf. Die Regel ist deshalb exakt statt grob: `params` bleiben bei einem Typ-Kopf, bei Parametertypen
  oder Rest-Typ und bei einem Argument von `_branch`. Alle übrigen Funktionsliterale, auch die auf oberster
  Ebene, sind nackte Arrows ohne `_createFunction`. Benannte Aufrufe brauchen `params` nicht mehr.
- Das Hoisting (`hoistedParams`, `hoistParametersJs`, `isNestedInFunction`, `hasParameterTypes`)
  wird entfernt, die zugehörigen Tests ersetzt durch Tests für „nackte Closure".
- Messen: `callbacks/countSmall` und alle anderen Fälle mit `--save`, vorher und nachher
  (`countSmall` stand vorher bei 95 ms ohne und 76 ms mit Hoisting). Erwartung: höchstens so
  schnell wie mit Hoisting, plus Wegfall der Property-Zuweisung. Dazu yugioh-Bench.

**Schritt 4 (`params` nur wo nötig), umgesetzt.** `needsRuntimeParams` im Emitter, Hoisting entfernt (samt Tests,
ersetzt durch Tests für „nackte Closure" und für die Fälle, die `params` behalten). Das constant folding emittiert
weiter mit `_createFunction`, weil der Budget-Wrapper darüber läuft.

| Messung | ohne Hoisting (Ausgangslage) | mit Hoisting | Schritt 4 |
|---|---|---|---|
| `bench-runtime` `callbacks/countSmall` (ms je 1 Mio.) | 95 | 76 | 60 bis 62 |
| yugioh Match (3 Läufe, Median) | 7,74 s | 7,07 s | 6,98 s |

Geprüft: Compiler-Tests (1478), Typecheck, `check-runtime-purity`, `build-all`, Language-Server-Tests und
Snapshot, yugioh (`jul test` 250 grün). Die Formatierung nackter Arrows im erzeugten JS bleibt wie bei
`_createFunction` eingerückt (Rumpf zwei Ebenen, schließende Klammer eine), das ist nur kosmetisch.

## Schritt 5: Dokumentation

- `docs/backlog/typed-emission.md`: Entscheidung „freie Reihenfolge" ersetzen, Schritt 2 als
  umgesetzt führen. `design-principles.md` nur, wenn die Entscheidung ein Prinzip belegt. Keine
  Statuslisten dort.
- `jul-homepage/docs/docs/documentation/handbook.md` und `error-codes.md`: Verhalten der Sprache,
  mit Beispiel, ohne Begründung. Der neue Fehlercode bekommt einen Abschnitt wie die vorhandenen.
- `jul-examples/function-call.jul`: Abschnitt 2.1 (andere Reihenfolge) und die Abschnitte 4 und 4.1
  (Dictionary-Spread) streichen, den List-Spread (Abschnitt 3) behalten. Das Beispiel ist die
  Dokumentation der Aufrufformen.
- `scripts/bench-runtime/named-arguments.jul` und `bench-runtime.ts`: der Fall `namedSwapped` ist
  nicht mehr erlaubt und entfällt.
- `TODO` und die Pläne in `docs` nachführen.

## Offene Entscheidungen (nach Schritt 0)

1. **Benannte Argumente an einem Wert vom Typ `Any`** (entschieden, anders als zuerst vorgeschlagen kein
   Fehler). Der Aufruf eines `Any`-Werts ist heute erlaubt und wird nicht verboten, weil mehrere Stellen
   in yugioh darauf beruhen. Stattdessen meldet `JUL5011` (Warnung, wie `JUL5010` nur mit `warnUnknown`):
   Es steht nicht fest, dass der Wert eine Funktion ist. Benannte Argumente gehen bei einem solchen
   Aufruf der Reihe nach an die Funktion, die Namen entfallen (wie ein positionaler Aufruf). Rekursive Aufrufe sind ausgenommen:
   Ihr eigener Typ steht erst nach dem Rumpf fest. Ihre Parameternamen kommen vom Funktionsliteral.
2. **Spread in die Argumentliste** (entschieden: Dictionary-Spread entfällt). `f(...dictionary)` wird
   gestrichen, weil ein Dictionary-Typ ungeordnet ist und die Gültigkeit eines Aufrufs sonst von der
   Feldreihenfolge im Typ abhinge. Der Checker meldet einen Spread, dessen Typ keine List ist, als
   Fehler (Dictionary, `Any` und unbekannter Typ). `f(...list)` bleibt und wird ein JS-Spread
   `f(...list)`. Heute läuft auch der List-Spread über `_callFunction(f, undefined, _combineObject(l))`,
   weil der Parser ihn als `object` führt. Das fällt weg. Verwendet wird der Spread heute nur in den
   Demos von `jul-examples/function-call.jul`, yugioh hat keine Verwendung.
3. **Gemischte Argumentlisten**, falls die Syntax sie kennt: positionale zuerst, dann benannte,
   wie in Python.
4. **Prädikate in Typposition.** Der Vorschlag in Schritt 4 (oberste Ebene und Typposition behalten
   `params`) deckt nicht den Fall ab, dass eine verschachtelte Funktion erst über eine Variable in
   einen Typ gelangt. Prüfen, ob Schritt 0 so etwas findet, sonst als Einschränkung dokumentieren
   oder als Fehler melden.
5. **JS- und TS-Importe ohne Typen.** Eine Funktion, deren Parameter `Any` sind, ist weiter
   aufrufbar, aber nur positional.

6. **Typ-Kopf-Funktionen und Rest-Parameter mit benannten Argumenten** (entschieden).
   - Ein Typ-Kopf (`MyType => …`) hat keine benannten Parameter, die Funktion bekommt ihre Argumente nie
     (der Emitter erzeugt `() => …`). `typeFunction(a = 1 b = 2)` prüft nur der Checker gegen `MyType`.
     Der Emitter schreibt den Aufruf ohne Argumente, die Reihenfolge der Namen ist dort egal.
   - Benannte Argumente an einen Rest-Parameter sind schon heute ein Checkerfehler (`JUL5050`, „Can not
     assign dictionary to rest parameter"), die Runtime würde ohnehin mit „not implemented yet for rest
     dictionary" abbrechen. Das bleibt so und wird getestet.
   - `params` bleibt für diese Funktionen nur, wenn sie als Branch in `_branch` oder als Prädikat in
     Typposition dienen (Schritt 4), nicht für benannte Aufrufe.

## Stand

**Schritt 1 (Checker), umgesetzt.** Zwei neue Codes: `JUL2501` (`argumentsOutOfOrder`) und `JUL2502`
(`spreadArgumentNotList`), beide `semantic` · `error`, mit Abschnitt in `error-codes.md`. Die Prüfungen
`checkArgumentOrder` und `checkSpreadArgument` stehen neben `checkDiscardedArguments` im Checker. Ein
Name ohne Parameter und ein vom Prefix gebundener Name gehen nicht in die Reihenfolge ein (sie meldet
`JUL2500`). Rest-Parameter bleiben bei benannten Argumenten ein Fehler (vorhandener Test).
Der Parameter-Alias (`(a1: Boolean = a)`) zählt mit dem Quellnamen (`a`): `getKnownFieldNames` liefert die
Quelle, ein Aufruf mit dem lokalen Namen `a1` ist weiter ein verworfener Wert.

Angepasst: die Beispiele `jul-examples/function-call.jul` (Abschnitte 2.1, 4 und 4.1 entfernt), vier
Checker-Tests und der `reference-index`-Test (Aufrufe in Parameterreihenfolge), die
Snapshot-Baselines (nur die Verschiebung durch das gekürzte Beispiel, geprüft). Drei Emitter-Tests
für umsortierte Aufrufe wurden entfernt. Der zugehörige Code in `namedArgumentsToDirectCallJs`
(Temporaries) ist damit für gültige Programme tot und wird in Schritt 2 gelöscht. yugioh baut und
besteht seine 250 Tests mit dem neuen Compiler.

**Schritt 2 (Emitter), umgesetzt.**
- Der Checker setzt `calledParameterNames` (Parameternamen des aufgerufenen Funktionstyps, `source ?? name`,
  dieselbe Quelle wie die Reihenfolgeprüfung) statt `literalParameterNames`. `getLiteralParameterNames` entfällt.
- `namedArgumentsToDirectCallJs` gilt damit für jede Funktion mit bekannter Signatur: JUL-Literal, Builtin
  (`modulo(dividend = x divisor = 3)` wird `modulo(x, 3n)`), Funktionswert (`g(a = 1)` wird `g(1n)`), Funktion mit
  Typ-Kopf (bekommt die Argumente in Parameterreihenfolge und liest sie nicht). Temporaries nur noch für ein
  nicht-triviales Argument ohne Parameter.
- Eine reine Spread-Argumentliste (`f(...values)`) ist ein JS-Spread `f(...values ?? [])` statt
  `_callFunction(f, undefined, _combineObject(values))`.
- Messung: yugioh-Bench-Bundle enthält kein `_callFunction` mehr; `jul test` in yugioh grün (250). Der
  Bench-Fall `namedSwapped` ist entfernt.
- Nachtrag: `Any`-Aufrufe sind kein Fehler, sondern `JUL5011` (siehe Entscheidung 1). Ein Aufruf mit Namen an
  `Any` ist ein positionaler Aufruf in geschriebener Reihenfolge. Ein rekursiver Aufruf mit Namen bekam zunächst
  falsch ein Dictionary übergeben: Sein Typ ist beim Prüfen `Any`. Behoben über `getSelfReferenceParameterNames`
  (Checker), mit Emitter- und Checker-Test.

**Schritt 3 (Runtime), umgesetzt, soweit er `_callFunction` betrifft.**
- `_callFunction` und `assignArgs` sind aus `runtime.ts` entfernt. Der Emitter erzeugt keinen Aufruf mehr.
  Die zugehörigen Runtime-Tests entfallen.
- Das constant folding (`tryFoldCall`) ruft den Callable über `callWithConstantArguments` direkt auf: List
  positional, Dictionary nach den Parameternamen des Funktionstyps, Prefix zuerst. Drei neue Tests (Builtin,
  Prefix, Nutzerfunktion mit Namen). Die Auswertung des Emitters für das Falten
  (`functionLiteralToEvaluableJs`) nutzt dieselben `calledParameterNames`.
- `tryAssignArgs` bleibt (Branches, Prädikate). `_combineObject` bleibt (Spread in Datenliteralen).
- Die `params` an den rund 540 Builtins bleiben vorerst: `tryFoldCall` erkennt faltbare Builtins an
  `'params' in runtimeFunction`. Sie zu entfernen bräuchte ein anderes Erkennungsmerkmal.
- Geprüft: Compiler-Tests, Typecheck, `check-runtime-purity`, `build-all`, Language-Server-Unit-Tests,
  yugioh (`jul test` 250 grün, kein `_callFunction` im Bench-Bundle).
- Die Baseline des Language-Server-Snapshots (`jul-language-server/scripts/snapshot.baseline.txt`) war schon
  vor diesen Änderungen veraltet (die core-lib hatte sich verschoben, `definition` zeigt auf Zeile 1477,
  jetzt 1530, dazu vier Builtins mehr bei `completion`). Ich habe sie neu geschrieben: Neben dieser Drift
  ändern sich nur die Dokumentsymbole in `function-call.jul` (gekürztes Beispiel).

**Schritt 5 (Dokumentation), umgesetzt.** `backlog/typed-emission.md`: Entscheidung „freie Reihenfolge" ersetzt, Schritt 2
neu gefasst, Messtabelle mit Hinweis auf den entfallenen Fall `namedSwapped`. `TODO`: der erledigte Punkt zu den
benannten Argumenten entfernt. `handbook.md`: Reihenfolge, Auslassen und List-Spread mit Beispielen (gegen den
Compiler geprüft). `error-codes.md`: JUL2501, JUL2502 und JUL5011. `design-principles.md` bleibt unverändert, die
Entscheidung belegt kein Prinzip.

**Offen, bewusst nicht Teil dieses Plans:** die `params` an den rund 540 Builtins in `runtime.ts` (`tryFoldCall`
erkennt faltbare Builtins daran) und das Zählskript `scripts/probe-argument-order.ts`.

## Reihenfolge und Abnahme

1. Schritt 0, Ergebnis kurz festhalten (als Abschnitt hier, nicht als eigenes Dokument).
2. Schritt 1 und 2, danach Migration von yugioh und `jul-examples`, bis beide mit dem neuen
   Compiler bauen und ihre Tests grün sind.
3. Schritt 3 und 4 einzeln, je mit Bench vor und nach der Änderung.
4. Nach jedem Schritt: `node --run test`, `npm run typecheck`, `npm run test-update-snapshot` nur
   nach Ansicht des Diffs, `npm run bench` und `npm run bench-runtime` mit `--save`,
   Language Server mit `npm run build-all` und `npm run test-snapshot`, yugioh `jul test` und
   Bench. Beispiele aus `jul-examples` neu bauen.
5. Der Language Server und die VSCode-Extension übernehmen den neuen Fehlercode über den
   Compiler. Prüfen, ob Hover oder Completion Parameternamen und deren Reihenfolge anzeigen
   und dort etwas anzupassen ist.
