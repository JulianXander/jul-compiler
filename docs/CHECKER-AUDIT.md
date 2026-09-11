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
| 1 | ~~branching ohne catchAll: `Error` fehlt im Rückgabetyp~~ — erledigt, siehe [design-principles.md](design-principles.md) Abschnitt „Branching ohne catchAll" | — | — |
| 2 | Nie matchender branch ([src/checker.ts:885-903](../src/checker.ts#L885-L903) auskommentiert) | reine Diagnose | **klein** — `typesOverlap` liegt vor, `getPreviousBranchValueType` ebenfalls |
| 3 | `getTypeErrorForParameters` „not implemented yet" ([src/checker.ts:2807](../src/checker.ts#L2807)) | unklar | unklar |
| 4 | **Weitere core-lib-Funktionen mit zu grobem Rückgabetyp** — `slice`, `map` und `filterMap` sind gefixt (siehe [core-lib-empty-return-types.md](core-lib-empty-return-types.md)), `findFirst`, `lastElement`, `toDictionary`, `toList` etc. sind ungeprüft | dieselbe Klasse: `Empty` zu viel oder Struktur verloren | je Funktion klein |
| 5 | Untypisierter Rest-Parameter matcht zur Laufzeit **nie**: in [tryAssignArgs](../src/runtime.ts#L570) liefert `restType ? getTypeError(…) : true` ohne Typ ein `true`, also einen Fehler | unsound — der Checker sagt für `?(1 2)` mit Branch `(...args) => §rest§` den Typ `§rest§` zu, zur Laufzeit kommt `did not match any branch`. Trifft die Catch-all-Schreibweise | **klein** — `true` zu `undefined`, wie im `singleNames`-Pfad und wie im Checker |
| 6 | „Parameter name mismatch" nennt die Rollen verkehrt herum ([checker.ts:3074](../src/checker.ts#L3074)) | `map(l (value: Integer i: PositiveInteger) => value)` meldet „Got index but expected i" — geschrieben wurde `i`, erwartet war `index`. Verstößt gegen Prinzip 9 | **klein** — Ursache ist die Kontravarianz: `case 'function'` vertauscht Ziel und Wert, die Meldung rechnet das nicht zurück |
| 7 | Positionelles Destructuring ist im Checker nicht umgesetzt: `case 'destructuring'` löst nur über Namen auf (`dereferenceNameFromObject`) | `(a b) = [1 2]` meldet `Failed to dereference a in type [1 2]`, obwohl das emittierte JS es kann (`_isArray ? _temp[0] : _temp.a`). Laufzeit und Checker sind sich uneinig | **klein** — bei einer Liste über den Index auflösen statt über den Namen |
| 8 | **Spread-Argumente werden gar nicht geprüft.** Spread-Elemente werden in [case 'list'](../src/checker.ts#L1371) zu `any`, damit ist der ganze Argumenttyp `any` und `getTypeError` steigt aus | verifiziert: `f(§x§)` gegen `(a: Integer)` meldet, `args = [§x§]` · `f(...args)` meldet nichts. Betrifft jede Typprüfung am Aufruf, nicht nur die Stelligkeit | mittel — Tupel-Elementtypen beim Spread flach machen (`TODO flatten spread tuple value type`) |
| 9 | Ein Zweig mit Tupel-Typkopf bekommt **keine Argumente**: im `paramsType`-Pfad geben [assignArgs](../src/runtime.ts#L467) und [tryAssignArgs](../src/runtime.ts#L524) ein leeres Array zurück | `[Integer Integer] => …` matcht `[1 2 3]`, der Body sieht aber `[]`. Ein Typkopf hat keine Parameternamen, insofern konsequent — nur kommt der Body an die gematchten Werte nicht heran | unklar, hängt an der Frage, ob ein Typkopf überhaupt binden soll |
| 10 | Benannte Argumente gegen einen `rest`-Parameter sind nicht umgesetzt | `f(a = 1 b = 2)` gegen `(a: Integer ...args)` meldet `Can not assign dictionary to rest parameter`, die Laufzeit wirft `not implemented yet for rest dictionary`. Test `named-arguments-with-rest-parameter-are-not-supported` hält es fest | unklar — zuerst zu klären, was ein rest aus benannten Argumenten überhaupt aufnehmen soll |
| 11 | Ein Prefix-Argument überdeckt ein gleichnamiges Feld, ohne dass es auffällt | `1.f(a = 2)` bindet `a = 1` aus dem Prefix, die geschriebene `2` verfällt still. Verpasster Fall von `JUL2500`, keine Falschmeldung | klein — die vom Prefix belegten Namen aus der bekannten Namensmenge nehmen |
| 12 | **Schlüsselart passt nicht zum Quelltyp** — Feldname auf einer List ([checker.ts:331](../src/checker.ts#L331)) und Index in einem Dictionary ([checker.ts:426](../src/checker.ts#L426)) liefern `undefined` statt eines Fehlers, beide als `TODO` markiert | `undefined` wird beim Aufrufer zu `Any`, und ob überhaupt gemeldet wird, entscheiden `hasKnownFields`/`hasKnownLength` — die für den jeweils anderen Fall nicht greifen. Zu verifizieren, ob der Mismatch dadurch ganz stillschweigend durchgeht | klein — eigener Fehlerfall je Richtung; die Wächter unterscheiden „Art passt nicht" heute nicht von „weiß ich nicht" |
| 13 | **Die Verengung erreicht die Quelle eines Feldzugriffs nicht.** Wer auf `x/feld` branched (direkt oder über eine Variable), verengt nur den Feldwert, nicht `x` | Falschfehler: `stepType = step/type` mit `step: Or([] Step)`, dann `?(stepType) [Text] => …step/query` meldet `Can not assign Empty to Text`, obwohl ein Text-`type` beweist, dass `step` nicht empty ist — `Empty` hat kein Feld `type`. Test `branch-narrowing-does-not-reach-source-of-field` hält es fest. Trifft jeden Code, der einen möglicherweise leeren Wert über eines seiner Felder prüft | unklar — verwandt mit Punkt „Feldpfad" (`branch-narrowing-field-path-is-missing`), braucht aber zusätzlich die Rückrichtung: aus dem verengten Feldwert auf die Quelle schließen |
| 14 | **Generischer Rückgabetyp friert bei einer echten Funktion (`functionLiteral`) an der Deklaration fest, statt je Aufruf aufgelöst zu werden.** Betrifft nur den Fall, dass der inferierte Rumpf-Typ `Any` ist (z.B. via `assume`) — dann greift in `case 'functionLiteral'` der Any-Fallback auf den deklarierten Rückgabetyp und löst `TypeOf(values)/ElementType` sofort mit dem an der Deklaration sichtbaren Parametertyp auf | Falschfehler bleibt aus: `first = (values: List(Any)) :> TypeOf(values)/ElementType => assume(1 Any)`, danach `f = (values: List(Text)) => g(values.first())` mit `g: (n: Integer) => n` meldet nichts, obwohl `values.first()` `Text` ist. Bei derselben Signatur über `nativeFunction` (`case 'functionTypeLiteral'`, kein Rumpf) meldet es korrekt — dort greift der Any-Fallback nicht. Test `generic-return-type-is-frozen-at-declaration-for-function-literal` hält es rot fest | unklar — der Any-Fallback existiert, damit ein geprüfter Rumpf den deklarierten Typ nach außen zeigt statt `Any`; er müsste den rohen (nicht aufgelösten) deklarierten Typ übernehmen, nicht die aufgelöste `declaredReturnValueType` |

---

## Erledigte Punkte

**JUL2500-Serie (Discarded values):**
- Überzähliger Wert verfällt stillschweigend → `JUL2500` für Aufrufe (positionell und benannt) und Destructuring. Die Zuweisung verwirft nichts, dort gibt es die Warnung bewusst nicht.
- Severity-System → [compileFile](../src/compiler.ts#L212) bricht nur noch bei `severity === 'error'` ab, `discardedValue` (JUL2500) ist die erste Warnung.

Die Entscheidung dahinter — ein Typ nennt Anforderungen, ein Wert darf sie übertreffen — steht als Beleg bei Prinzip 2 in [design-principles.md](design-principles.md), das Verhalten in `CLAUDE.md` und im Handbuch.

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
