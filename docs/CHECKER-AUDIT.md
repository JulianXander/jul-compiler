# Offene Checker-Lücken: Schritt für Schritt schließen

## Context

Ein Audit des Checkers (22 Snippets, die einen Fehler liefern müssten) hat neun Stellen gefunden, an
denen falscher Code stillschweigend durchgeht. Die daraus entstandenen Fixes werden einzeln
abgearbeitet.

Vorgehen: **Schritt für Schritt.** Immer nur eine Sache — zuerst ein roter Test mit vollständigem
`errors`-Objekt, dann der Fix. Die Harness bleibt unverändert. Testkommentare sagen, **was gilt**,
nicht was einmal kaputt war.

## Fallen im Checker

Der Sprachfakt zu `Empty` steht jetzt in [CLAUDE.md](../../CLAUDE.md) beim Sprachkern.

- **Wer aus der Zuweisbarkeit etwas folgert, fragt nur nach „yes".** `isTypeAssignable` liefert no, yes
  oder unknown, `isSubtypeOf` liefert `true`, `false` oder `undefined` und wird immer mit `=== true`
  bzw. `=== false` verglichen: `!isSubtypeOf(…)` hieße „nein oder unbekannt". Für `any`,
  `nestedReference`, `parameterReference` und `parameters` ist die Prüfung bewusst nachsichtig und
  liefert unknown, das ist nicht „ist zuweisbar". Daran ist die erste `typesOverlap`-Fassung
  gescheitert, die `NonZeroInteger` zu `Never` gemacht hat. Näheres in
  [three-valued-assignability.md](three-valued-assignability.md).
- **rawType und dereferencedType nicht vermischen.** Wer auf dem einen nachschlägt und anhand des
  anderen entscheidet, bekommt Falschfehler: die Verengung erzeugt im rawType ein `and` mit
  Platzhalter, auf dem `dereferenceNameFromObject` nur einen aufgeschobenen Zugriff liefert, während
  der aufgelöste Typ ein `dictionaryLiteral` mit dem gesuchten Feld ist.
- **Ein aufgelöster Typ hat seine Generizität verloren.** `resolvePlaceholders` macht aus einem
  Platzhalter wie `TypeOf(a)/ElementType` den deklarierten Typ, aus Nicht-Auflösbarem `Any`. Das
  Ergebnis wird trotzdem gespeichert, wo ein Platzhalter sonst nicht erkannt würde (Spread in
  Listen, Tupeln und Dictionaries, Nachschlagen nach einer Verengung, erwarteter Callback-Typ am
  Aufruf). Nur der Rückgabetyp einer aufgerufenen Funktion behält einen bloßen
  Platzhalter-Empfänger roh (`returnPrefixArgumentType`). Neue Stellen, die einen Typ speichern,
  müssen sich zwischen beiden entscheiden und nicht beides mischen. Zum Nachschlagen eines Feldes
  oder Index gibt es `getLookupType`: Es löst ein `and` oder `or` mit Platzhalter auf (die Form, in
  der eine Verengung den Parameter ablegt), ein bloßer Platzhalter bleibt roh. Wer nachschlägt,
  ruft nicht selbst `resolvePlaceholders` auf und fragt nicht nur auf `and`. Ein `and` in einer Hülle
  (`TypeOf(values)/ElementType` mit verengtem Argument) erreicht `getLookupType` nicht. Dafür haben
  die Dereferenzierungen der Typalgebra selbst einen `and`-Fall (`dereferenceFromIntersection`): Mit
  Platzhalter wartet der Schnitt als Ganzes, ohne verteilt sich der Zugriff auf die Operanden.
- **`Any` heißt „unbekannt“ oder „hier bewusst nachsichtig prüfen“, ein gemeldeter Fehler ist `Invalid`.**
  Wer an einer Fehlerstelle `builtinAny` zurückgibt, bringt die Folgefehler zurück, denn `Any` wirkt
  nicht neutral: aus `Not(Any)` wird `Never`, ein Parameter `Any` fängt jeden Branch ab. `Invalid` ist
  als Quelle und Ziel von `isTypeAssignable` immer yes (keine Warnung bei unknown), macht `Not`, `And`,
  `Or` und Typfunktionen mit einem Invalid-Operanden selbst ungültig und verengt als Branch-Kopf nichts.
  Ausgenommen ist das Element eines Containers: `[Invalid 2]` bleibt eine Liste. Es entsteht nur, wo für
  den Ausdruck schon ein Fehler gemeldet ist (vom Parser oder vom Checker), `findInvalidWithoutError` in
  `test-util.ts` prüft das über alle Beispiele. Unterschieden vom Laufzeit-`error` (`Error =
  nativeValue(§_Error§)`, der Typ von `_branch` ohne Treffer). Die Ausdrücke im Baum tragen keine
  Fehlermarkierung, die Fehler liegen als flache Liste pro Datei: Der Checker kann nicht fragen „hat
  dieser Teilausdruck schon Fehler“, deshalb bleibt die Herkunftsregel eine Prüfung über den ganzen
  Dokumentensatz. `hasKnownFields` und `hasKnownLength` fragen dagegen nicht nach Fehlern, sondern ob
  ein noch nicht ausgewerteter Typ seine Feld- bzw. Längenmenge kennt. Siehe
  [invalid-type-umbau.md](invalid-type-umbau.md).
- **`Any` ist auch ein Performance-Ventil — ein präziserer Typ kann sehr teuer sein.** Wer statt
  `Any` die Vereinigung aller Felder eines großen `dictionaryLiteral` liefert, erzeugt Typen, die
  von dort an durch jede weitere Prüfung getragen werden. Gemessen an einem Zugriff mit
  unbestimmtem Schlüssel: parse+check von 3,6 s auf 14,4 s, bei praktisch unveränderten
  Aufrufzahlen — die Zeit steckte fast vollständig in `typeEquals` (1320 ms Selbstzeit gegenüber
  nicht messbar vorher), aufgerufen aus der Deduplizierung in `createNormalizedUnionType`.
  Vor jeder Präzisierung deshalb messen, und im Zweifel nur dort präzisieren, wo die Feldmenge
  klein ist.

## Was sich als Vorgehen bewährt hat

1. Kette im echten Code nachvollziehen.
2. **Minimales Repro** bauen und gegen den Stand davor prüfen — meldet es in beiden Ständen, trifft
   es den Fall nicht.
3. Bewerten: berechtigter Fund oder Falschfehler.
4. Nur bei Falschfehler: roter Test, dann Fix.

**Das erste Repro trifft oft nicht die Ursache.** `slice` verlor den Elementtyp — echter Defekt,
gefixt, das reale Projekt blieb trotzdem unverändert. Erst der Blick auf `rawType` neben
`dereferencedType` zeigte die eigentliche Stelle. Nicht beim ersten grünen Test aufhören.

**Ein grüner Testsatz reicht als Absicherung nicht.** Der `dereferenceFailed`-Fix hatte alle Tests
grün und erzeugte im realen Projekt trotzdem zwölf Falschfehler: nachgeschlagen wurde auf dem rohen
Typ, entschieden anhand des aufgelösten. Die Verengung erzeugt im rohen Typ ein `and`, für das
`dereferenceNameFromObject` damals keinen Fall hatte. Ohne den Durchlauf gegen echten Code wäre das
durchgerutscht.

---

## Offene Punkte

Dringlichkeit = wie viel falscher Code stillschweigend durchgeht. Bewusst nicht nach Aufwand
sortiert.

| # | Lücke | Schaden | Aufwand |
|---|---|---|---|
| 1 | **Weitere core-lib-Funktionen mit zu grobem Rückgabetyp** — `slice`, `map`, `filterMap` und `lastElement` sind gefixt (siehe [core-lib-empty-return-types.md](core-lib-empty-return-types.md)), `findFirst`/`findLast`/`findLastIndex` vermutlich unproblematisch, `toDictionary`/`toList` ungeprüft | dieselbe Klasse: `Empty` zu viel oder Struktur verloren | je Funktion klein |
| 2 | Benannte Argumente gegen einen `rest`-Parameter sind nicht umgesetzt | `f(a = 1 b = 2)` gegen `(a: Integer ...args)` meldet `Can not assign dictionary to rest parameter`, die Laufzeit wirft `not implemented yet for rest dictionary` (`assignArgs`/`tryAssignArgs` in runtime.ts), Test `named-arguments-with-rest-parameter-are-not-supported` hält den Zustand fest. Vorgelagerte Design-Frage ungeklärt: was soll ein rest aus benannten Argumenten überhaupt binden? Python/Ruby trennen dafür zwei rest-Konstrukte (`*args`/`**kwargs`), keine verbreitete Sprache vereinigt beides in einem. Repro ohne Checker-Fehler existiert (Aufruf über eine `Any`-typisierte Zwischenstation, die die echte Signatur verdeckt), als nicht dringend zurückgestellt | unklar — hängt an der Design-Frage, nicht an der Umsetzung |
| 3 | `Concat` (und vermutlich die übrigen reinen Typfunktionen `ElementAt`, `LengthOf`, `WithElementAt`, `IndexRange`, `MapElements`) ist nur für Rückgabetyp-Annotationen gedacht, das erzwingt der Checker aber nicht | Als Parameter- bzw. Branch-Typ (`(a: Concat(TypeOf(x) TypeOf(y))) => ...`) landet der Aufruf über `parametersToJs` (`emitter.ts:485`) wörtlich im generierten JS, weil Parameter-/Branch-Typen anders als Rückgabetypen zur Laufzeit ausgewertet werden (Runtime-Dispatch in `_branch`/`_createFunction`). `Concat` hat keine Runtime-Implementierung und wirft dort bewusst (`runtime.ts:1404-1408`) — Ergebnis ist ein harter Runtime-Crash mit kryptischer Meldung statt eines Checker-Fehlers an der Stelle, wo `Concat` verwendet wurde | klein bis mittel — entweder eine gezielte Diagnose bei Verwendung außerhalb der Rückgabetyp-Position, oder Dokumentation der Einschränkung |
| 4 | Ein Parametertyp, der sich auf einen früheren Parameter bezieht (`TypeOf(stream$)/ValueType`, `list/ElementType`, `TypeOf(x)`), wird bei **benannten** Argumenten nicht gegen das Argument geprüft. Für Positionsargumente wird er mit den Argumenten des Aufrufs aufgelöst und dann geprüft (Test `argument-type-mismatch-parameter-type-from-previous-parameter`) | `push(stream$ = i$ value = §text§)` geht ohne Meldung durch. Nebenbefund: `l/ElementType` zu `[1 2]` ergibt `Or([] 1 2)`, das `Empty` darin ist zu viel. `TypeOf(x)` wird zum Typ des Arguments aufgelöst, `h(1 2)` gegen `(x: Integer y: TypeOf(x))` meldet also `Can not assign 2 to 1` | klein bis mittel — benannte Argumente über den Namen statt über die Position auflösen |
| 5 | Eine fehlende Eigenschaft eines Record-Typwerts wird nicht gemeldet: `hasKnownTypeProperties` zählt `dictionaryLiteral` als unbekannt, weil `typePropertyAccess` dort nur die Felder liefert. `ElementType` eines Record-Typs (`findField` auf `[a = 1 b = 2]`) entsteht bisher nur über den Rückfall `dereferenceUnknownKeyFromObject`, Fall `typeOf`, der in den Wert absteigt | `TypeOf([a: Integer])/Foo` geht ohne Meldung durch, das Ergebnis ist `Any` | klein — `ElementType` in `typePropertyAccess.dictionaryLiteral` aufnehmen (Messen: die Vereinigung aller Feldtypen war schon einmal teuer, siehe oben „Any ist auch ein Performance-Ventil“), dann `dictionaryLiteral` mit `complete` als bekannt zählen |
| 6 | Auf Typebene verwirft ein Choice ohne die Eigenschaft den Zugriff nicht: `Or(TypeOf(List(Integer)) TypeOf(Integer))/ElementType` ergibt `TypeOf(Integer)`, der `Integer`-Zweig fällt still weg (`dereferenceNameFromObjectType`, Fall `or`, filtert). Bei Werten macht ein nachweislich fehlendes Feld den Zugriff für die ganze Union unsicher. Dasselbe Filtern steht im Fall `concat` und in `dereferenceIndexFromObject`, Fall `or`. Gemeldet wird nur, wenn kein Choice die Eigenschaft hat | ein Zugriff, der zur Laufzeit für einen Zweig nichts liefert, gilt als sicher | klein — die Eigenschaftsmengen je Typart stehen jetzt in `hasKnownTypeProperties` |
| 7 | Ein Feldzugriff auf einen verengten Parameter verliert seine Generizität: `getLookupType` an den Aufrufstellen löst den Schnitt zur Deklaration auf. `name = (p: Or([] [name: Text])) => ?(p) [Empty] => §§ () => p/name` liefert für das Argument `[name: §Bob§]` den Typ `Text`, ohne die Verengung `§Bob§`. Ein Versuch, `getLookupType` an allen sieben Stellen durch den `and`-Fall der Typalgebra zu ersetzen, scheiterte auf yugioh: Ohne das Nachschlagen in `nestedReference.evaluate` fallen Verengungen über Callback-Parametern später auf `Any` (13 neue Warnungen), `resolvePlaceholders` stieg auf das 2,8-Fache, und nur einzelne Stellen umzustellen erzeugte echte Fehler (JUL5050) | nur Präzision: Der Typ ist zu weit, nicht falsch | groß — zuerst klären, warum der aufgeschobene Schnitt über einem Callback-Parameter später nicht mehr auflösbar ist |

---

## Gefunden, aber bewusst nicht umgesetzt

Kein akuter Schaden erkennbar, deshalb hier statt in der offenen Liste — nicht vergessen, nur
zurückgestuft.

| Lücke | Warum zurückgestellt |
|---|---|
| `getTypeErrorForParameters` meldet „not implemented yet" für jeden `argumentsType` außer dictionaryLiteral/empty/tuple/parameters | vermutlich unerreichbar: setzt voraus, dass ein `ParametersType` erwartet wird und das Argument ein `or`/`any`/`list` ist. Kein Repro gefunden, kein bekannter Schaden |

---

## Verifikation (nach jedem Schritt)

```bash
cd jul-compiler
npx mocha --import=tsx --require ./test-setup.mjs src/checker/checker.test.ts
npm run typecheck
npm test
npm run build
```

Beispiele bauen — sie laufen in keinem automatisierten Test. Referenzstand: alle OK außer `./import`
(vorbestehender Parse-Fehler `JUL1151`, unabhängig vom Checker):

```bash
cd jul-examples
for cfg in $(find . -name jul-config.yaml | sort); do
	d=$(dirname "$cfg")
	out=$(cd "$d" && node "../../jul-compiler/out/compiler/cli.js" 2>&1)
	echo "$(echo "$out" | grep -q successfully && echo OK || echo FAIL)  $d"
done
```

### Yugioh — nur so ist die Messung gültig

Nicht dort bauen. Abhängigkeiten rekursiv laden und in **Post-Order** prüfen (Abhängigkeiten vor dem
Importeur, wie `compileFile`); ohne diese Reihenfolge und ohne `documents` als zweites Argument von
`checkTypes` misst der Lauf nichts — daran ist die erste Verifikation gescheitert:

```js
import { parseFile } from './src/parser/parser.js';
import { checkTypes } from './src/checker/checker.js';
const documents = {};
const checkOrder = [];
function loadDocument(path) {
	if (documents[path]) { return documents[path]; }
	const parsed = parseFile(path);
	documents[path] = parsed;
	for (const dep of parsed.dependencies ?? []) { loadDocument(dep); }
	checkOrder.push(parsed);
	return parsed;
}
```
