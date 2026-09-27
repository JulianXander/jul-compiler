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

- **Wer aus einem ausbleibenden `getTypeError` etwas folgert, braucht `hasReliableTypeError` davor.**
  Für `any`, `nestedReference`, `parameterReference` und `parameters` ist die Prüfung bewusst
  permissiv, „kein Fehler" heißt dort nicht „ist zuweisbar". Daran ist die erste `typesOverlap`-
  Fassung gescheitert, die `NonZeroInteger` zu `Never` gemacht hat.
- **rawType und dereferencedType nicht vermischen.** Wer auf dem einen nachschlägt und anhand des
  anderen entscheidet, bekommt Falschfehler: die Verengung erzeugt im rawType ein `and`, für das
  `dereferenceNameFromObject` keinen Fall hat, während der aufgelöste Typ ein `dictionaryLiteral`
  mit dem gesuchten Feld ist.
- **`Any` bedeutet drei verschiedene Dinge:** „Typ unbekannt", „hier bewusst permissiv prüfen" und
  „hier ist schon etwas schiefgelaufen, sei still". Die dritte Bedeutung zieht die zweite mit sich,
  deshalb verstummt nach einem gemeldeten Fehler die ganze Kette darunter. Ein eigener
  **Invalid-Typ** — getrennt von `Any` und vom Laufzeit-`error` (`Error = nativeValue(§_Error§)`,
  der Typ von `_branch` ohne Treffer) — würde das auflösen. Die Ausdrücke im Baum tragen keine
  Fehlermarkierung, und die Fehler liegen als flache Liste pro Datei: der Checker kann also nicht
  fragen „hat dieser Teilausdruck schon Fehler". Deshalb prüft heute jeder Konsument seine
  Vorbedingung selbst (`hasKnownFields`, `hasKnownLength`, `nestedKey.name < 1`).
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
`dereferenceNameFromObject` keinen Fall hat. Ohne den Durchlauf gegen echten Code wäre das
durchgerutscht.

---

## Offene Punkte

Dringlichkeit = wie viel falscher Code stillschweigend durchgeht. Bewusst nicht nach Aufwand
sortiert.

| # | Lücke | Schaden | Aufwand |
|---|---|---|---|
| 1 | **Weitere core-lib-Funktionen mit zu grobem Rückgabetyp** — `slice`, `map`, `filterMap` und `lastElement` sind gefixt (siehe [core-lib-empty-return-types.md](core-lib-empty-return-types.md)), `findFirst`/`findLast`/`findLastIndex` vermutlich unproblematisch, `toDictionary`/`toList` ungeprüft | dieselbe Klasse: `Empty` zu viel oder Struktur verloren | je Funktion klein |
| 2 | Benannte Argumente gegen einen `rest`-Parameter sind nicht umgesetzt | `f(a = 1 b = 2)` gegen `(a: Integer ...args)` meldet `Can not assign dictionary to rest parameter`, die Laufzeit wirft `not implemented yet for rest dictionary` (`assignArgs`/`tryAssignArgs` in runtime.ts), Test `named-arguments-with-rest-parameter-are-not-supported` hält den Zustand fest. Vorgelagerte Design-Frage ungeklärt: was soll ein rest aus benannten Argumenten überhaupt binden? Python/Ruby trennen dafür zwei rest-Konstrukte (`*args`/`**kwargs`), keine verbreitete Sprache vereinigt beides in einem. Repro ohne Checker-Fehler existiert (Aufruf über eine `Any`-typisierte Zwischenstation, die die echte Signatur verdeckt), als nicht dringend zurückgestellt | unklar — hängt an der Design-Frage, nicht an der Umsetzung |
| 3 | `Concat` (und vermutlich die übrigen reinen Typfunktionen `ElementAt`, `LengthOf`, `WithElementAt`, `Range`, `TupleOf`) ist nur für Rückgabetyp-Annotationen gedacht, das erzwingt der Checker aber nicht | Als Parameter- bzw. Branch-Typ (`(a: Concat(TypeOf(x) TypeOf(y))) => ...`) landet der Aufruf über `parametersToJs` (`emitter.ts:485`) wörtlich im generierten JS, weil Parameter-/Branch-Typen anders als Rückgabetypen zur Laufzeit ausgewertet werden (Runtime-Dispatch in `_branch`/`_createFunction`). `Concat` hat keine Runtime-Implementierung und wirft dort bewusst (`runtime.ts:1404-1408`) — Ergebnis ist ein harter Runtime-Crash mit kryptischer Meldung statt eines Checker-Fehlers an der Stelle, wo `Concat` verwendet wurde | klein bis mittel — entweder eine gezielte Diagnose bei Verwendung außerhalb der Rückgabetyp-Position, oder Dokumentation der Einschränkung |
| 4 | Ein Parametertyp, der sich auf einen früheren Parameter bezieht, wird am Aufruf nicht gegen das Argument geprüft — `stream$/ValueType`, `list/ElementType`, `TypeOf(x)` | Alles geht ohne Meldung durch: `create$(Integer 1).push(§text§)`, `push(i$ §text§)`, `(s: Stream(Any) v: s/ValueType) => []` mit `f(i$ §text§)`, `(l: List(Any) v: l/ElementType) => []` mit `g([1 2] §text§)`, `(x: Integer y: TypeOf(x)) => []` mit `h(1 §text§)`. Ein fester Typ an derselben Stelle (`y: Integer`) meldet korrekt `JUL5050`. Vermutlich die bewusst permissive Prüfung für `parameterReference`/`nestedReference` (siehe Fallen oben), ohne dass der Typ vorher mit den Argumenten des Aufrufs aufgelöst wird. Trifft die core-lib breit: `push`, `subscribe`-Listener, alle Stream-Transformationen und Listenfunktionen mit `ElementType`-Parametern. Ein Literaltyp am Stream (`create$(Or([] §ok§ §cancel§) [])`) ist dadurch heute nur Dokumentation. Groß: eine ganze Klasse von Aufrufen bleibt ungeprüft | mittel — Parametertypen der Reihe nach mit den bereits gebundenen Argumenttypen auflösen, dann prüfen; vorher und nachher messen |

---

## Gefunden, aber bewusst nicht umgesetzt

Kein akuter Schaden erkennbar, deshalb hier statt in der offenen Liste — nicht vergessen, nur
zurückgestuft.

| Lücke | Warum zurückgestellt |
|---|---|
| `getTypeErrorForParameters` meldet „not implemented yet" für jeden `argumentsType` außer dictionaryLiteral/empty/tuple/parameters | vermutlich unerreichbar: setzt voraus, dass ein `ParametersType` erwartet wird und das Argument ein `or`/`any`/`list` ist. Kein Repro gefunden, kein bekannter Schaden |
| Funktionstypen aus TS-Importen werden zu `Any` (`tsTypeToJulType` in `typescript-parser.ts` hat keinen Fall dafür). Ein Callback an eine TS-Funktion wird deshalb gar nicht geprüft: gegen `onClose: (returnValue: string) => void` geht `(returnValue: Or(§ok§ §cancel§)) => ...` durch, obwohl der engere Parameter nach der Kontravarianz ein Fehler ist — gegen einen JUL-Funktionstyp meldet derselbe Callback `JUL5050`. Zur Laufzeit prüft ebenfalls niemand, weil TS den Callback direkt aufruft und nicht über `_callFunction` | Bewusst: JUL vergleicht bei Funktionstypen die Parameternamen, TS nicht. Übersetzt, müsste jeder JUL-Callback genau so heißen wie der Parameter in der TS-Signatur. Voraussetzung für eine Übersetzung wäre ein Funktionstyp, dessen Parameter nur nach Position geprüft werden |

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
	out=$(cd "$d" && node "../../jul-compiler/out/cli.js" 2>&1)
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
