# Constant Folding: Umsetzungsplan

Detailplan für die zweite Hälfte von [pure-functions.md](pure-functions.md), hinter der dort
beschriebenen Schnittmöglichkeit. Die erste Hälfte (Pfeile, `purity` im Typ, Argument-Regel) ist
umgesetzt.

**Ziel:** Ein Aufruf eines `->`-Builtins, dessen Argumente zur Compile-Zeit bekannt sind, wird
ausgeführt und sein Ergebnis fließt als präziserer Typ zurück. Der emittierte Code bleibt
unverändert — gefaltet wird nur der Typ.

## Was entschieden ist

| Frage | Entscheidung |
| --- | --- |
| Umfang | alle Builtins mit `->`, keine Ausschlussliste |
| Argumentform | Skalare **und** Kollektionen aus Literaltypen |
| Ergebnisform | Skalare **und** Kollektionen; `undefined` → `Empty`, zurückgegebener `Error` → `Error` |
| Aufrufkonvention | `_callFunction` wiederverwenden statt nachbauen |
| Vorrang | Faltung gewinnt — genauer: gewinnt, wenn sie gelingt |
| Ziel des Ergebnisses | nur der Typ, nicht der Emitter |
| Name → Runtime-Export | `escapeReservedJsVariableName`, keine Tabelle |
| Hostabhängigkeit | gilt als impure; hat derzeit **keine** Instanz (siehe unten) |
| Langläufer | kein Timeout, Risiko bewusst getragen |
| Zähler | pro Ausdruck |
| Brüche | erst nach dem Kürzen faltbar (Voraussetzung) |

**Kein neuer Fehlercode.** Faltung meldet nie etwas — sie gelingt oder unterbleibt.

## Der wichtigste Befund vorab

Faltung arbeitet auf **Typen**, nicht auf Syntax. Gemessen:

```
x = 5                →  5          Literaltyp, kein Syntax-Literal nötig
y = addInteger(x 3)  →  Integer    faltbar: die Argumenttypen sind [5, 3]
```

Jede Variable, die an eine Konstante gebunden ist, trägt einen Literaltyp, und gefaltete Ergebnisse
machen weitere Aufrufe faltbar. Die Reichweite lässt sich deshalb **nicht am Quelltext ablesen** —
ein Grep über 5845 Zeilen yugioh findet fast nur `Or(1 2)` (Typkonstruktor, schon heute
compile-time ausgewertet) und Nutzerfunktionen, sagt aber nichts über die tatsächliche Zahl
faltbarer Aufrufstellen.

Daraus folgt die Reihenfolge unten: **erst zählen, dann bauen.**

---

## Schritt 0 — Voraussetzung: Brüche kürzen

Eigener Bugfix, kein Teil der Faltung. Die roten Tests stehen bereits
(`src/runtime.test.ts`, `describe('Bruch kuerzen')` und `checker.test.ts`,
`fraction-literals-are-reduced`).

Vier Stellen tragen denselben `// TODO kleinstes gemeinsames Vielfaches, kürzen`:
[parser.ts:1335](../src/parser/parser.ts#L1335) (Bruchliterale),
[add](../src/runtime.ts#L1786), [subtract](../src/runtime.ts#L1707),
[multiply](../src/runtime.ts#L1637).

Ein gemeinsamer Helfer in `runtime.ts`:

```ts
function normalizeRational(numerator: bigint, denominator: bigint): RuntimeRational {
	// Vorzeichen in den Zaehler, mit gcd kuerzen, Nenner 1 wird zum Integer.
}
```

- Nenner 1 → `bigint`, nicht `{numerator, denominator}` — `Rational = Or(Integer Fraction)` sieht
  genau das vor, und `add(0.5 0.5)` soll den Typ `1` bekommen, nicht `[numerator = 1 denominator = 1]`.
- Der Parser braucht denselben Helfer, sonst behalten `0.5` und `0.50` verschiedene Typen
  (gemessen: `[numerator = 5 denominator = 10]` vs. `[numerator = 50 denominator = 100]`).

**Warum das die Faltung blockiert:** Ohne Kürzen beschreibt ein gefalteter Bruchtyp nicht den
**Wert**, sondern den **Rechenweg** — `add(0.5 0.5)` und `add(0.25 0.75)` ergäben verschiedene Typen
für dieselbe Zahl. Das bricht „gleiche Werte, gleiche Typen", worauf Deduplizierung, Unions und
Narrowing aufbauen.

Danach: `npm run test-update-snapshot`, denn Bruchliterale in `jul-examples` ändern ihren Typ.

## Schritt 1 — Zählen statt falten

**Vor** der eigentlichen Faltung: die Bedingung auswerten, mitzählen, nichts falten. Ein Zähler in
`checkerStats` neben den bestehenden (`inferType`, `resolvePlaceholders`, `getTypeError`), erhöht an
der Stelle aus Schritt 4, aber ohne Ausführung.

Auswerten gegen yugioh und `jul-examples`. Die Zahl beantwortet zwei Fragen, die sonst offen bleiben:

- **Gibt es überhaupt faltbare Aufrufstellen?** Bei null ist die Faltung in dieser Form wirkungslos —
  das wäre vor dem Bauen gut zu wissen, nicht danach.
- **Welche Funktionen dominieren, und wie groß sind die Ergebnisse?** Das sagt, ob Kollektionstypen
  (die teure Form, siehe Risiken) überhaupt vorkommen.

Erst mit dieser Zahl ist die Zeitmessung in Schritt 6 interpretierbar; ohne sie misst man eine
Differenz ohne Nenner.

**Entscheidungspunkt:** Fällt die Zahl sehr klein aus, ist hier der Ort abzubrechen — der Zähler
bleibt dann als Instrumentierung stehen und hat wenig gekostet.

## Schritt 2 — `escapeReservedJsVariableName` teilen

Die Abbildung JUL-Name → Runtime-Export ist bereits gelöst und drei Zeilen lang
([emitter.ts:466](../src/emitter.ts#L466)) — sie ist aber **nicht exportiert**, und der Checker
importiert den Emitter nicht.

Nach `util.ts` verschieben (zusammen mit `reservedJsNames`) und von Emitter und Checker importieren.
Keine Tabelle, keine zweite Wahrheit.

*Randnotiz zur Modulstruktur:* `runtime.ts` hat **null Imports**. Der neue Import
`checker.ts → runtime.ts` erzeugt also keinen Zyklus. Er zieht allerdings das ganze Runtime-Modul in
den Checker-Prozess, inklusive `StreamClass` — beim Sprachserver-Start einmalig, danach ohne Kosten.

## Schritt 3 — Übersetzung in beide Richtungen

Zwei Funktionen, am besten in einer eigenen Datei (`src/checker/constant-folding.ts`), damit die
Faltung testbar ist, ohne den Checker zu fahren.

### 3a. Typ → JS-Wert (Argumente)

```ts
function typeToConstantValue(type: CompileTimeType): { value: unknown } | undefined
```

Liefert `undefined`, sobald irgendein Teil nicht konstant ist — das ist zugleich die
Faltungsbedingung. Rekursiv über:

| Typ | Wert |
| --- | --- |
| `integerLiteral` | `bigint` |
| `floatLiteral` | `number` |
| `textLiteral` | `string` |
| `booleanLiteral` | `boolean` |
| `empty` | `undefined` |
| `tuple` | Array aus den Elementwerten |
| `dictionaryLiteral` | Objekt aus den Feldwerten |
| alles andere | `undefined` (nicht faltbar) |

Der Rückgabetyp ist bewusst `{ value }` und nicht `unknown`, weil `undefined` ein **gültiger** Wert
ist (`Empty`) und nicht mit „nicht faltbar" verwechselt werden darf.

**Brüche** sind `dictionaryLiteral` und laufen damit automatisch mit — korrekt erst nach Schritt 0.

### 3b. JS-Wert → Typ (Ergebnis)

```ts
function constantValueToType(value: unknown): CompileTimeType | undefined
```

Umgekehrt, plus zwei Fälle, die auf dem Hinweg nicht vorkommen:

- `value instanceof Error` → `builtinError`. Ein **zurückgegebener** Error ist ein normaler
  JUL-Wert (`parseFloat(§abc§)` liefert `new Error('Invalid number.')`), kein Defekt. Die konkrete
  Meldung geht dabei verloren — `ErrorType` hat keine Felder (siehe „Vorgemerkt").
- `undefined` → `builtinEmpty`. Das ist keine Neuerfindung: der Checker liefert für
  `[1 2 3].getElement(5)` schon heute `Empty`.
- `NaN`, `Infinity`, `-Infinity` → `undefined` (nicht falten). Ein Literaltyp dafür wäre
  darstellbar, aber bedeutungslos.

## Schritt 4 — Die Faltungsstelle

**Wo:** im `case 'functionCall'` von `inferType`, **nach**
`dereferenceArgumentTypesNested` ([checker.ts:2577](../src/checker/checker.ts#L2577)) — nicht in
`getReturnTypeFromFunctionCall`.

Der Grund ist der Argument-Gate: `assignArgsError` wird an der Aufrufstelle berechnet
([checker.ts:2555](../src/checker/checker.ts#L2555)) und liegt dort in Reichweite;
`getReturnTypeFromFunctionCall` bekommt es nicht. Und es passt zur Vorrangregel: der abhängige
Rückgabetyp ist an dieser Stelle bereits ausgerechnet, die Faltung ersetzt ihn, wenn sie gelingt.

```ts
const foldedType = tryFoldCall(
    functionExpression, prefixArgumentType, argsType, assignArgsError, dereferencedReturnType);
return { type: foldedType ?? dereferencedReturnType };
```

### Die Bedingungen, in dieser Reihenfolge

1. **Kein Argumentfehler.** `assignArgsError` ist gesetzt → nicht falten. Sonst rechnete die
   Runtime auf Werten, für die sie nicht geschrieben ist, und `NaN` flösse als Literaltyp zurück.
2. **Referenz auf ein Builtin.** `functionExpression.type === 'reference'`, und der Name ist der
   Anker. Überschreiben ist ausgeschlossen: `builtInSymbols` ist der oberste Scope jeder
   Nicht-core-lib-Datei ([checker.ts:1510](../src/checker/checker.ts#L1510)), eine Definition mit
   Builtin-Namen ist bereits `JUL4003`. Dasselbe setzt der bestehende Typkonstruktor-`switch`
   voraus ([checker.ts:3166](../src/checker/checker.ts#L3166)).
3. **Beweisbar rein.** `getCallPurity(functionType, argsType) === 'pure'`
   ([checker.ts:4148](../src/checker/checker.ts#L4148)) — schon vorhanden, wird hier zum ersten Mal
   produktiv benutzt.
4. **Runtime-Export vorhanden und aufrufbar.** `runtime[escapeReservedJsVariableName(name)]` ist eine
   Funktion.
5. **`.params` vorhanden.** Sonst fällt `_callFunction` in den JS-Zweig, wo ein Dictionary als *ein*
   Objekt-Argument durchgereicht wird — für eine positionale native Funktion still falsch. Geprüft:
   alle relevanten Funktionen haben eine Registrierung, weil `_createFunction` die Funktion mutiert
   ([runtime.ts:66](../src/runtime.ts#L66)). Der Riegel ist die Versicherung und zugleich die Probe,
   ob Schritt 2 den richtigen Export getroffen hat.
6. **Alle Argumente konstant.** `typeToConstantValue` auf Prefix- und Argumenttyp.

### Die Ausführung

```ts
try {
    const result = _callFunction(runtimeFn, prefixValue, argsValue);
    return constantValueToType(result);
}
catch {
    return undefined;   // nicht falten, keine Diagnose
}
```

`_callFunction` statt eines Nachbaus: `assignArgs` ([runtime.ts:467](../src/runtime.ts#L467))
erledigt positionale Zuordnung, benannte Argumente inklusive `source`-Alias, `prefixArgument` und
Rest-Parameter bereits — und zwar **exakt so**, wie der Emitter es für Dictionary-Argumente erzeugt.

Das `try/catch` ist **Pflicht**, nicht Vorsicht: `assignArgs` wirft bei Rest-Parameter plus benannten
Argumenten (`'tryAssignArgs not implemented yet for rest dictionary'`,
[runtime.ts:511](../src/runtime.ts#L511)). Ohne Fang risse eine Faltung den Checker mit.

**Wichtige Unterscheidung:** Ein *geworfener* Fehler heißt „nicht falten". Ein *zurückgegebener*
`Error` ist ein Programmwert und wird zu `Error` gefaltet. JUL gibt Fehler grundsätzlich zurück
(`_branch` liefert `new Error(...)`), deshalb ist die Trennung sauber.

## Schritt 5 — Tests

### 5a. Faltung greift

| Aufruf | erwartet |
| --- | --- |
| `addInteger(2 3)` | `5` |
| `x = 5` dann `addInteger(x 3)` | `8` — belegt, dass Typen zählen, nicht Syntax |
| `combineTexts([§x§ §y§] §-§)` | `§x-y§` |
| `2.addInteger(3)` | `5` — Prefixargument |
| `add(2 3)` | `5` — Rest-Parameter |
| `parseFloat(§1.5§)` | `1.5` |
| `parseFloat(§abc§)` | `Error` |
| `[1 2 3].slice(2)` | `[2 3]` statt `Or(Empty 1 2 3)` |
| `[1 2 3].slice(9)` | `Empty` |

### 5b. Faltung unterbleibt

Unveränderter deklarierter Typ, keine neue Diagnose: nicht-konstantes Argument; `purity !== 'pure'`
(`log`, `currentDate`); Nutzerfunktion; Callback-Argument, das nicht beweisbar rein ist
(`map(log …)`); Aufruf mit Argumenttypfehler.

### 5c. Abgleich mit den abhängigen Rückgabetypen

Der eigentliche Riegel gegen stilles Auseinanderlaufen. Für die Funktionen, bei denen **beide**
Mechanismen ein konkretes Ergebnis liefern — `getElement`, `setElement`, `getField` — beide Wege
gegeneinander prüfen.

Heute stimmen sie überein, auch im Randfall (gemessen):

| Ausdruck | abhängiger Typ | Laufzeitwert |
| --- | --- | --- |
| `[1 2 3].getElement(2)` | `2` | `2n` |
| `[1 2 3].getElement(5)` | `Empty` | `undefined` |

Garantiert ist das nicht — 1-basiert in JUL, 0-basiert in JS. Der Test hält es fest.

### 5d. Aufrufkonvention gegen den Emitter

Die einzige Annahme, die `_callFunction` macht: für **Listen**-Argumente emittiert der Emitter
`fn(a, b, c)` direkt statt über `_callFunction`
([emitter.ts:200-208](../src/emitter.ts#L200-L208)). Für ein paar Funktionen beide Wege ausführen
und vergleichen. (Defaultparameter gibt es in den Runtime-Exporten keine, `f(a)` und
`f(a, undefined)` sind dort gleichwertig — der wahrscheinlichste Divergenzgrund entfällt damit.)

## Schritt 6 — Messung

```bash
npm run bench -- --save --note "nach constant folding"
```

Verglichen mit der Messung aus Schritt 1. Interpretiert wird sie zusammen mit der Zahl faltbarer
Aufrufstellen von dort — eine Zeitdifferenz ohne diesen Nenner sagt nichts.

Dazu `npm test`, `npm run typecheck`, ein paar `jul-examples` neu bauen, und die
Snapshot-Baseline ansehen: Sie zeigt die Faltung an echtem Code und ist die beste Gegenprobe.

## Risiken

| Risiko | Abfederung |
| --- | --- |
| **Präzisere Typen sind teuer.** Der Audit hat 3,6 s → 14,4 s gemessen, fast vollständig in `typeEquals` aus der Deduplizierung — bei unveränderten Aufrufzahlen. | Schritt 1 sagt vorher, wie viele und wie große Typen entstehen. Kollektionsergebnisse sind die gefährdete Form. |
| **Eine einzelne Faltung hängt.** Der Zähler pro Ausdruck kann das nicht verhindern — JavaScript kennt keine Preemption, ein Budget bricht keinen laufenden `regex` ab. | Bewusst getragen. Realistisch betrifft es nur `regex` mit katastrophalem Backtracking; alles andere ist linear in der Literalgröße. |
| **Faltung und abhängiger Rückgabetyp laufen auseinander.** | Test 5c. |
| **Aufrufkonvention weicht vom Emitter ab.** | Test 5d. |

Der Zähler aus Schritt 1 bleibt übrigens auch danach ohne Wirkung: In dieser Stufe ist jede Faltung
genau **ein** nativer Aufruf, ein Budget pro Ausdruck steht also immer bei 1. Seine Aufgabe bekommt
er erst mit der Inferenz-Ausbaustufe, wenn rekursiver JUL-Code zur Compile-Zeit läuft. Als
Instrumentierung ist er trotzdem jetzt schon nützlich.

## Vorgemerkt, nicht Teil dieser Stufe

- **`Error` typisiert zugänglich machen.** core-lib dokumentiert `# Instance structure: (message: Text)`
  ([core-lib.jul:99](../src/core-lib.jul#L99)), aber `ErrorType` hat keine Felder und `e/message`
  liefert heute `Any` (gemessen). Ein `message: Text` am Typ löst den dortigen TODO, nützt allen
  Errors — nicht nur gefalteten — und erst danach lohnt die Frage, ob die Faltung die konkrete
  Meldung einsetzen soll. Dagegen spricht dann: die Meldung würde Teil des Typs, und eine
  Textänderung wäre eine Typänderung.
- **Hostabhängigkeit.** Die Regel „hostabhängig zählt als impure" steht, hat aber **keine Instanz**:
  `regex` ist nachweislich nicht hostabhängig (kein `u`-Flag, also sind `\p{…}` keine
  Unicode-Property-Klassen, sondern spec-konform literales `p`), und `addDate` ist es zwar
  (Ortszeit-Arithmetik, gemessen: Berlin und UTC eine Stunde auseinander), aber unerreichbar — JUL
  hat kein Datums-Literal, `addDate` bekommt also nie konstante Argumente. Beide Einschätzungen
  gehören als Kommentar an die jeweilige Deklaration in core-lib, mit dem Hinweis, wann sie kippen.
- **Gefaltetes Ergebnis emittieren** — siehe pure-functions.md, „Ausblick: gefaltetes Ergebnis auch
  emittieren".
- **Bugfix, unabhängig von allem hier:** `Blob = nativeValue(§_Date§)`
  ([core-lib.jul:98](../src/core-lib.jul#L98)) zeigt auf `_Date` statt auf `_Blob`
  ([runtime.ts:1434](../src/runtime.ts#L1434)). JULs `Blob` ist damit derselbe Typ wie `Date`.
