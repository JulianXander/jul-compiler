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
| 1 | branching ohne catchAll: `Error` fehlt im Rückgabetyp ([src/checker.ts:905-912](../src/checker.ts#L905-L912)) | unsound — `_branch` liefert `new Error(...)` | mittel, **Designentscheidung offen** ([TODO:56](../TODO#L56)) |
| 2 | Tupel-Länge: zu wenige Elemente werden gemeldet, zu viele nicht — **keine Checker-Lücke, sondern offene Sprachentscheidung**, siehe [tuple-length-semantics.md](tuple-length-semantics.md) | überzählige Werte still verworfen, auch bei `x: [Integer Integer] = [1 2 3]` | Entscheidung offen, Umsetzung klein |
| 3 | Nie matchender branch ([src/checker.ts:885-903](../src/checker.ts#L885-L903) auskommentiert) | reine Diagnose | **klein** — `typesOverlap` liegt vor, `getPreviousBranchValueType` ebenfalls |
| 4 | `getTypeErrorForParameters` „not implemented yet" ([src/checker.ts:2807](../src/checker.ts#L2807)) | unklar | unklar |
| 5 | **Weitere core-lib-Funktionen mit zu grobem Rückgabetyp** — `slice` und `map` sind gefixt, `filterMap`, `findFirst`, `removeElements` etc. sind ungeprüft | dieselbe Klasse: `Empty` zu viel oder Struktur verloren | je Funktion klein |

Zu 2: Es ist keine Aufruf-Regel, sondern Zuweisbarkeit von Tupeln — der Aufruf mit zu vielen
Argumenten fällt als Sonderfall mit ab. Der Checker bildet damit die Laufzeit korrekt ab:
[getTupleTypeError](../src/runtime.ts#L418) meldet nur `value.length < elementTypes.length`, und
[tryAssignArgs](../src/runtime.ts#L524) sieht nach dem letzten deklarierten Parameter nicht weiter.
Ein Branch `[Integer Integer]` matcht zur Laufzeit also `[1 2 3]`, `[1]` dagegen nicht. Die heutige
Semantik ist damit **Präfix, nicht exakte Länge** — konsistent, nur nirgends festgeschrieben.

Auf exakte Länge umzustellen ist deshalb keine reine Checker-Änderung: die Laufzeit müsste mit,
und das verschärft `_branch`-Matching. Erst entscheiden, dann fixen. Betroffen wären
[getTupleTypeError2](../src/checker.ts#L2972) (iteriert nur über `targetElementTypes`) und
[getTypeErrorForParametersWithCollectionArgs](../src/checker.ts#L3106) (nur über `singleNames`).

Ein Spread im Aufruf bleibt in beiden Varianten ungeprüft: `f(...args)` hat als Argumenttyp `any`
(Spread-Elemente werden in [case 'list'](../src/checker.ts#L1371) zu `any`), und `getTypeError` steigt
bei `any` aus. Erst wenn das Flatten dort kommt, greift eine Längenprüfung auch für Spread.

---

## Verifikation (nach jedem Schritt)

```bash
cd jul-compiler
npx mocha --import=tsx --require ./test-setup.mjs src/checker.test.ts
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
	out=$(cd "$d" && node "../../jul-compiler/out/cli.js" jul-config.yaml 2>&1)
	echo "$(echo "$out" | grep -q successfully && echo OK || echo FAIL)  $d"
done
```

### Yugioh — nur so ist die Messung gültig

Nicht dort bauen. Abhängigkeiten rekursiv laden und in **Post-Order** prüfen (Abhängigkeiten vor dem
Importeur, wie `compileFile`); ohne diese Reihenfolge und ohne `documents` als zweites Argument von
`checkTypes` misst der Lauf nichts — daran ist die erste Verifikation gescheitert:

```js
import { parseFile } from './src/parser/parser.js';
import { checkTypes } from './src/checker.js';
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
