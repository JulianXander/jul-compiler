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
| 1 | `getTypeErrorForParameters` „not implemented yet" ([src/checker.ts:2807](../src/checker.ts#L2807)) | unklar | unklar |
| 2 | **Weitere core-lib-Funktionen mit zu grobem Rückgabetyp** — `slice`, `map` und `filterMap` sind gefixt (siehe [core-lib-empty-return-types.md](core-lib-empty-return-types.md)), `findFirst`, `lastElement`, `toDictionary`, `toList` etc. sind ungeprüft | dieselbe Klasse: `Empty` zu viel oder Struktur verloren | je Funktion klein |
| 3 | Benannte Argumente gegen einen `rest`-Parameter sind nicht umgesetzt | `f(a = 1 b = 2)` gegen `(a: Integer ...args)` meldet `Can not assign dictionary to rest parameter`, die Laufzeit wirft `not implemented yet for rest dictionary`. Test `named-arguments-with-rest-parameter-are-not-supported` hält es fest | unklar — zuerst zu klären, was ein rest aus benannten Argumenten überhaupt aufnehmen soll |
| 4 | Ein Prefix-Argument überdeckt ein gleichnamiges Feld, ohne dass es auffällt | `1.f(a = 2)` bindet `a = 1` aus dem Prefix, die geschriebene `2` verfällt still. Verpasster Fall von `JUL2500`, keine Falschmeldung | klein — die vom Prefix belegten Namen aus der bekannten Namensmenge nehmen |
| 5 | **Schlüsselart passt nicht zum Quelltyp** — Feldname auf einer List ([checker.ts:331](../src/checker.ts#L331)) und Index in einem Dictionary ([checker.ts:426](../src/checker.ts#L426)) liefern `undefined` statt eines Fehlers, beide als `TODO` markiert | `undefined` wird beim Aufrufer zu `Any`, und ob überhaupt gemeldet wird, entscheiden `hasKnownFields`/`hasKnownLength` — die für den jeweils anderen Fall nicht greifen. Zu verifizieren, ob der Mismatch dadurch ganz stillschweigend durchgeht | klein — eigener Fehlerfall je Richtung; die Wächter unterscheiden „Art passt nicht" heute nicht von „weiß ich nicht" |
| 6 | **Die Verengung erreicht die Quelle eines Feldzugriffs nicht.** Wer auf `x/feld` branched (direkt oder über eine Variable), verengt nur den Feldwert, nicht `x` | Falschfehler: `stepType = step/type` mit `step: Or([] Step)`, dann `?(stepType) [Text] => …step/query` meldet `Can not assign Empty to Text`, obwohl ein Text-`type` beweist, dass `step` nicht empty ist — `Empty` hat kein Feld `type`. Test `branch-narrowing-does-not-reach-source-of-field` hält es fest. Trifft jeden Code, der einen möglicherweise leeren Wert über eines seiner Felder prüft | unklar — verwandt mit Punkt „Feldpfad" (`branch-narrowing-field-path-is-missing`), braucht aber zusätzlich die Rückrichtung: aus dem verengten Feldwert auf die Quelle schließen |

---

## Erledigte Punkte

**Unreachable Branch Detection (Bug #1):** Ein Branch in einem `?` ist unreachable, wenn sein Argument-Typ (der extrahierte Werttyp aus dem Parameter-Typ) eine Teilmenge der kombinierten Argument-Typen aller vorherigen Branches ist.

Implementierung:
1. Extrahiere Argument-Typ mit `getBranchArgumentType()` aus jedem Branch-Parameter-Typ
2. Behandle Spezialfälle: `()` (Empty) ist orthogonal, `Any` ist catchAll und macht nächste Branches unreachable
3. Kombiniere bisherige Argument-Typen zu Union mit `createNormalizedUnionType()`
4. Prüfe mit `areArgsAssignableTo(undefined, currentArgumentType, combinedPreviousType)` ob aktueller Branch Teilmenge ist
5. Kein Error von areArgsAssignableTo = unreachable

Tests: `unreachable-branch-is-detected`, `orthogonal-branches-are-not-unreachable`, `subset-branch-is-unreachable` in `checker.test.ts`. Error code JUL5152 mit severity `warning`.

**Parameter-Namen-Mismatch wurde verkehrt herum gemeldet:** Die Kontravarianz bei Funktionstypen als Argumente sorgt dafür, dass die Parameter in umgekehrter Reihenfolge geprüft werden. In `getTypeError` wurde das aber bei der Parameterprüfung nicht berücksichtigt — statt `argumentsType.ParamsType` gegen `targetType.ParamsType` zu prüfen, wurde `targetType.ParamsType` gegen `argumentsType.ParamsType` geprüft. Das vertauschte die Namen in der Fehlermeldung. Fix: Reihenfolge in Zeile 3760 korrigiert. Test `parameter-name-mismatch-reports-names-in-wrong-order` in `checker.test.ts`.

**Spread-Argumente wurden gar nicht geprüft:** Eine reine Spread-Argumentliste (`f(...values)`,
kein Feld/Element daneben) parst laut `ParseUnknownObjectLiteral` zu `case 'object'`, nicht zu
`case 'list'` (das betraf nur `f(1 ...values)` u.ä.). `case 'object'` löste diesen Fall nie auf,
sondern gab immer `Any` zurück — `getTypeError` stieg damit für jedes Spread-Argument aus.
Fix in zwei Schritten:
1. Liste/Tuple: Auflösung wie in `case 'list'` über `getSpreadElementTypes` (Quellen als
   Liste/Tuple/Empty auflösen, zu Tuple bzw. List zusammensetzen).
2. Dictionary (`f(...namedArgs)`): lassen sich alle Quellen zu `dictionaryLiteral` auflösen,
   werden die Felder zusammengeführt (spätere Quelle überschreibt gleichnamige frühere Felder),
   analog zum bestehenden Spread-Fall in `case 'dictionary'`.
Tests `spread-argument-is-not-type-checked` und `dictionary-spread-argument-is-not-type-checked`
in `checker.test.ts`.

**Untypisierter Rest-Parameter matchte zur Laufzeit nie:** `tryAssignArgs` behandelte einen `rest`
ohne deklarierten Typ wie einen Typfehler (`restType ? getTypeError(...) : true`), an beiden
Stellen (args undefined und Array-Fall). `_branch` verwarf jeden Branch mit `(...args) => …` also
immer, unabhängig von den Argumenten - der Checker sagte währenddessen einen konkreten Typ zu.
Fix: `true` zu `undefined`, analog zum `singleNames`-Pfad. Test
`_branch matches a branch with an untyped rest parameter` in `runtime.test.ts`.

**JUL2500-Serie (Discarded values):**
- Überzähliger Wert verfällt stillschweigend → `JUL2500` für Aufrufe (positionell und benannt) und Destructuring. Die Zuweisung verwirft nichts, dort gibt es die Warnung bewusst nicht.
- Severity-System → [compileFile](../src/compiler.ts#L212) bricht nur noch bei `severity === 'error'` ab, `discardedValue` (JUL2500) ist die erste Warnung.

Die Entscheidung dahinter — ein Typ nennt Anforderungen, ein Wert darf sie übertreffen — steht als Beleg bei Prinzip 2 in [design-principles.md](design-principles.md), das Verhalten in `CLAUDE.md` und im Handbuch.

**Generischer Rückgabetyp fror bei einer echten Funktion (`functionLiteral`) an der Deklaration
fest:** Ist der inferierte Rumpf-Typ `Any` (z.B. via `assume`), fiel `case 'functionLiteral'` auf
den deklarierten Rückgabetyp zurück — aber auf dessen bereits mit `resolvePlaceholders`
aufgelöste Fassung, aufgelöst mit dem an der Deklaration sichtbaren Parametertyp statt mit dem
des jeweiligen Aufrufs. `TypeOf(values)/ElementType` fror dadurch auf `Any` ein, jeder Aufrufer
sah `Any` statt seines eigenen Elementtyps. Fix: der Fallback übernimmt die rohe, unaufgelöste
Fassung (`rawDeclaredReturnType`) — wie es `case 'functionTypeLiteral'` (`nativeFunction`,
kein Rumpf) schon immer tat. Test `generic-return-type-is-frozen-at-declaration-for-function-literal`.

**Positionelles Destructuring war im Checker nicht umgesetzt:** `case 'destructuring'` löste ein
Feld nur über den Namen auf (`dereferenceNameFromObject`). `(a b) = [1 2]` meldete deshalb
`Failed to dereference 'a'`, obwohl die Laufzeit genau das kann (`_isArray ? _temp[index] :
_temp.name`). Fix: schlägt die Namensauflösung fehl, versucht der Checker zusätzlich die Position
über `dereferenceIndexFromObject`, wie es die Laufzeit auch tut. Test
`positional-destructuring-from-list`.

**Typköpfe sind Filter, keine Parameterbindungen:** Typköpfe wie `[Integer Integer] => …` geben
ein leeres Array an `assignArgs` zurück, weil der Typkopf keine Parameternamen hat. Das ist kein
Fehler — Typköpfe sind reine Typefilter und binden bewusst nichts. Die echten Daten kommen über
die Aufrufer-Variable (z.B. `value` bei `?(value) [Integer] => …`). Der Typkopf wählt nur den
Ausführungspfad nach Typ.

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
