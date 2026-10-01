# Dreiwertige Zuweisbarkeit

Umsetzungsplan. Die Zuweisbarkeitsprüfung des Checkers soll neben „passt" und „passt nicht" ein
drittes Ergebnis kennen: „unbekannt".

## Problem

`getTypeError` ([checker.ts](../src/checker/checker.ts)) kennt zwei Ergebnisse: ein `TypeError`
oder `undefined`. `undefined` heißt dabei zweierlei:

- **Teilmenge:** `PositiveInteger` passt zu `Integer`.
- **Unbekannt, also nachsichtig:** Der Typ steht noch nicht fest (Platzhalter, `Any`), oder die
  Regel ist absichtlich nachsichtig (`Not` als Quelle, Prädikat als Ziel). Nach dem Prinzip
  Freiheit ([design-principles.md](design-principles.md)) darf „nicht entscheidbar" nie zu
  „passt nicht" werden, also wird kein Fehler gemeldet.

Für das Melden eines Fehlers ist das gleichwertig. Wer aus einem **ausbleibenden** Fehler etwas
folgert, muss die beiden Fälle aber unterscheiden. Heute geschieht das über eine Liste:
`hasReliableTypeError` nennt die Typen, bei denen „kein Fehler" nicht „Teilmenge" heißt. Jede neue
nachsichtige Regel, die dort fehlt, wird zur Falle. Drei Fehler dieser Art wurden gefunden und
behoben bzw. umgangen:

| Fall | Folge |
|---|---|
| `Not` als Quelle ist nachsichtig | `Not(GreaterInteger(3))` wurde als `Not(GreaterInteger(2))` angenommen |
| `And(A Not(B))` wurde zu `A`, sobald B keine Teilmenge von A war | `x: And(Integer Not(Greater(2))) = 3` war fehlerfrei |
| `lengthOf` als Ziel wird gegen `PositiveInteger` geprüft, gilt aber als verlässlich | `And(PositiveInteger Or(length(values) LessInteger(length(values))))` wird zu `PositiveInteger`, die obere Grenze geht verloren |

Der dritte Fall ist offen. Die core-lib umgeht ihn, indem sie obere Grenzen als
`Not(GreaterInteger(…))` schreibt (siehe [number-ranges.md](number-ranges.md)).

## Wer aus der Prüfung etwas folgert

Stand der Analyse, Zeilen in `checker.ts` bzw. `branch-dispatch.ts`:

**Meldet Fehler**, braucht nur „passt nicht": Zuweisung (3628), Typ-Guard (3737), Argumente
(4035), Rückgabetyp (4267), Typ-Guard gegen `Type` (9396), Funktion erwartet (9424).

**Folgert aus „kein Fehler"**, braucht „passt" und darf „unbekannt" nicht so lesen:
- `removeSubtypes` beim Normalisieren einer Union, geschützt über `hasReliableTypeError` und
  `isUnresolvedPlaceholderType`
- die Vereinfachung für Teilmengen in `createNormalizedIntersectionType`, geschützt über
  `hasReliableTypeError`
- `isNotAssignableTo`, genutzt von `typesOverlap` und den `Not`-Regeln, geschützt über
  `hasReliableTypeError`
- die Erreichbarkeit von Branches (3467), geschützt über `hasReliableTypeError`
- `containsAny` (5473), liest `hasReliableTypeError` direkt
- `isSubtype` in [branch-dispatch.ts](../src/checker/branch-dispatch.ts) (486): **ungeschützt**,
  wertet `!getTypeError(…)` als Teilmenge

## Modell

Gefragt ist: Liegt jeder Wert der Quelle im Ziel?

- **yes:** bewiesen, jeder Wert liegt darin.
- **no:** bewiesen, mindestens ein Wert liegt nicht darin.
- **unknown:** nicht entscheidbar.

Gemeldet wird nur no, gefolgert nur aus yes.

Ein Kern liefert drei Werte, die bisherigen Funktionen werden zu dünnen Hüllen darum:

```ts
type Assignability =
	| { result: 'yes'; }
	| { result: 'no'; error: TypeError; }
	| { result: 'unknown'; fromAny: boolean; };

function getAssignability(prefixArgumentType, argumentsType, targetType): Assignability;

// Melden (Prinzip Freiheit): nur ein sicheres Nein ist ein Fehler.
getTypeError = (…) => assignability.result === 'no' ? assignability.error : undefined;
// Folgern: nur ein sicheres Ja ist eine Teilmenge, nur ein sicheres Nein keine.
isSubtypeOf = (…) => assignability.result === 'yes';
isNotSubtypeOf = (…) => assignability.result === 'no';
```

`'yes'` und die beiden `'unknown'` sind Konstanten, nur `'no'` erzeugt ein Objekt.

`fromAny` sagt, ob ein `Any` als Quelle beteiligt ist. Die geplante Warnung (siehe unten) braucht
das, denn Typen, die erst am Aufrufort feststehen, dürfen nicht warnen, und `Any` kann
verschachtelt sein (`[a = Any]` → `[a: Text]`), sodass nur die Prüfung selbst es weiß. Beim
Verknüpfen gewinnt `Any`: Ein zusammengesetztes unknown ist `fromAny`, sobald ein beteiligtes
es ist. Die Meldungen bleiben
unverändert, sie hängen weiter am `TypeError` des Nein.

### Verknüpfung

| Stelle | yes | no | sonst |
|---|---|---|---|
| Ziel `And` | alle Choices yes | ein Choice no | unknown |
| Ziel `Or` | ein Choice yes | alle Choices no | unknown |
| Quelle `Or` | alle Choices yes | ein Choice no | unknown |
| Quelle `And` | ein Choice yes | nur über die bestehenden exakten Regeln (Bereich, `And(A Not(B))`) | unknown |

### Einordnung der heutigen Fälle

Jedes heutige `return undefined` in `getTypeError` wird einzeln als yes oder unknown eingeordnet.
Das sind rund 63, davon 13 ausdrücklich als nachsichtig kommentiert.

- **yes:** Ziel `Any`, gleiche Referenz (`argumentsType === targetType`), alle heutigen
  Strukturregeln, die eine Teilmenge tatsächlich zeigen (Literal in Basistyp, Bereich in Bereich,
  Tuple elementweise usw.)
- **unknown:** Quelle `Any`, denn sie kommt aus Ungetyptem (übersprungene Datei, `runJs`, Import
  ohne Typen) und hat einen bestimmten, nur unbekannten Typ. Als no wäre jeder ungetypte Wert ein
  Fehler, als yes dürfte das Normalisieren `Or(Any Integer)` zu `Integer` machen. Das entspricht
  dem heutigen Verhalten. `parameterReference`, `nestedReference`, `parameters`, `concat`,
  `add`, `mapElements`, `conditional`, `withElementAt` auf beiden Seiten; Prädikat als Ziel,
  wenn der Wert nur in der Obermenge liegt (gewollt: ein Prädikat ist ein Vertrag, den die
  Laufzeit prüft); der Stapel für rekursive Aliase (wie TypeScripts `Maybe`) und die Tiefengrenze
  der Alias-Expansion
- **`Not` als Quelle** wird genau (Schritt in Phase 2): no, außer das Ziel deckt alles außer der
  Quelle des `Not` ab (`Any`, `Not(B)` mit `B ⊆ A`, `Or(A …)`), dann yes. Heute lässt die
  nachsichtige Regel `(a: Not(0)) => a.add(1)` ohne Fehler durch, obwohl `a` Text sein kann.
- **`lengthOf` als Ziel**, ein offener Einzelwert wie ein abstrakter Typ mit oberer Schranke:
  yes bei derselben Länge (`typeEquals`) und bei `Never`, no bei einer Quelle ohne Überschneidung
  mit `PositiveInteger` (`0`, Text), sonst unknown. Als Quelle bleibt es `PositiveInteger`.

Vorbild ist TypeScript: `isTypeRelatedTo` rechnet intern mit einem `Ternary` (`True`, `False`,
`Maybe`, `Unknown`), und ein Typparameter `T extends number` ist `number` zuweisbar, aber nicht
umgekehrt. `typesOverlap` arbeitet im Checker schon so (`true`/`false`/`undefined`).

## Phasen

Jede Phase für sich abnehmbar. Vor und nach jeder Phase `npm run bench -- --save` mit Notiz; der
Checker-Snapshot soll unverändert bleiben, jede Abweichung wird einzeln begründet.

### Phase 0: Abnahmefälle

Rote Tests, die heute scheitern:
- `And(PositiveInteger Or(length(values) LessInteger(length(values))))` im Parametertyp behält die
  obere Grenze
- `isSubtype` in `branch-dispatch.ts` hält ein unbekanntes Paar nicht für eine Teilmenge (Fall aus
  dem Code dort zu suchen: ein Branch mit Platzhalter- oder `Not`-Typ)

Gegenproben, die heute grün sind und es bleiben müssen: die `upper-bound`-Tests, der Test zur
Vereinfachung von `And(A Not(B))`, die Grenzen-Tests.

### Phase 1: Kern einführen, ohne Verhaltensänderung

- `Assignability` und `getAssignability` anlegen, `getTypeError` wird zur Hülle.
- Zunächst wird jedes `undefined` des alten Codes als unknown übernommen und jedes Fehlerobjekt
  als no. Da `getTypeError` beides wieder auf das Alte abbildet, ändert sich nichts.
- Messen: Die Hülle kostet einen Aufruf und einen Vergleich pro Prüfung.

### Phase 2: yes einordnen

- Switch für Switch (Quelle, Ziel, Alias, Bereich) die `return undefined` durchgehen, die eine
  Teilmenge zeigen, und auf yes umstellen. Die Verknüpfung für `And`/`Or` gemäß Tabelle.
- Nach jedem Switch die Suite. Solange die Folgernden noch über `hasReliableTypeError` gehen,
  ändert sich das Verhalten nicht.
- `Never` als Quelle wird yes (siehe Abschnitt `Never`).
- **Eigener Schritt: `Not` als Quelle genau machen.** `Not(A)` liegt genau dann in `T`, wenn `T`
  alles außer `A` abdeckt: yes bei `Any`, bei `Not(B)` mit `B ⊆ A` (gibt es schon) und bei einem
  `Or`, das `A` und den Rest enthält; sonst no. Die exakten Regeln für `And(A Not(B))` bleiben.
  Das ändert Verhalten: Bisher fehlerfreier Code wie `(a: Not(0)) => a.add(1)` meldet jetzt einen
  Fehler. Bricht dabei Code, in dem die Inferenz ein `Not` ohne seinen Grundtyp liefert, ist die
  Inferenz zu korrigieren, nicht die Regel. Abnahme: Suite, Snapshot, yugioh, jul-examples.

### Phase 3: Folgernde umstellen

- `removeSubtypes`, Vereinfachung für Teilmengen, `isNotAssignableTo`, Erreichbarkeit der
  Branches, `containsAny` und `isSubtype` in `branch-dispatch.ts` fragen `isSubtypeOf` bzw.
  `isNotSubtypeOf` statt `!getTypeError(…)` plus `hasReliableTypeError`.
- `hasReliableTypeError` entfällt. Wo `isUnresolvedPlaceholderType` nur deshalb danebensteht,
  entfällt es ebenfalls.
- Hier ändert sich Verhalten: Wo ein Fall fälschlich als unknown eingeordnet blieb, normalisiert
  der Checker schwächer. Das zeigt sich im Snapshot als längere Typen und ist dann in Phase 2
  nachzutragen.

### Phase 4: `lengthOf` und die core-lib

- Zielregel für `lengthOf` wie oben.
- `forEach`, `repeat` und `range` schreiben die obere Grenze als `Or(end LessInteger(end))`.
  Der Abschnitt „Ausnahme" in [number-ranges.md](number-ranges.md) und der TODO-Eintrag entfallen.

## Anschluss: Warnung bei unsicheren Zugriffen auf `Any`

Nicht Teil dieses Plans, setzt aber auf ihm auf. Gewarnt wird, wo ein `Any`-Wert an ein engeres
Ziel geht: Definition mit Typ, Argument, Rückgabewert und Feldzugriff, denn `x/name` ist wie der
Aufruf von `getField`. Der Wert selbst und seine Weitergabe an ein Ziel, das `Any` erlaubt,
warnen nicht.

```jul
x = runJs(§…§)        # Any, keine Warnung
name = x/name         # Warnung: Any an den Feldzugriff, name ist Any
log(name)             # log erlaubt Any, keine Warnung
w: Text = name        # Warnung
```

Die meldenden Stellen geben dann zu no einen Fehler aus, zu unknown mit `fromAny` eine Warnung und
sonst nichts: Typen, die erst am Aufrufort feststehen, und Prädikate als Ziel bleiben stumm wie
heute. `Not` als Quelle ist nach Phase 2 genau und liefert no statt unknown. Weitere Fälle werden
ebenso über genaue Regeln gelöst, nicht über weitere Gründe.

Ein eigener Typ `Unknown` (strenger oberster Typ wie in TypeScript) ist damit nicht nötig: `Any`
mit dieser Warnung verhält sich wie `unknown`, nur mit Warnung statt Fehler.

## `Never`

**Entschieden:** `Never` als Quelle ist überall yes, als leere Menge liegt es in jedem Typ. So
halten es auch TypeScript (`never`), Kotlin und Scala (`Nothing`) und Rust (`!`). Heute ist es
keinem Typ zuweisbar. Das wird in Phase 2 mit umgestellt, das Normalisieren braucht dann keinen
Sonderfall mehr für `Or(Never X)`. Als Ziel bleibt `Never` streng: Ein Wert passt nie hinein,
`f(5)` an `(a: Never)` bleibt ein Fehler.

Damit ein unmöglicher Typ trotzdem auffällt, wird er dort gemeldet, wo er entsteht, nicht wo er
benutzt wird. Eigener Schritt nach Phase 2:
- Warnung an einem Parameter, dessen Typ `Never` ist: Er kann keinen Wert annehmen, die Funktion
  ist nie aufrufbar.
- `:?` ohne passenden Zweig am Aufrufort: prüfen, ob es dafür schon eine Meldung gibt, sonst eine
  einführen.

Heute meldet stattdessen jede Verwendung (`Can not assign Never to Integer`), und gar nichts,
wenn der Parameter nur an `Any` geht:

```jul
# gemeint: 1 bis 9
inRange = (index: And(GreaterInteger(10) LessInteger(0))) =>
	log(index)        # heute nichts, danach nichts
	index.add(1)      # heute Fehler mit Never, danach nichts
# danach: eine Warnung an index
```

## Nicht Teil dieses Plans

- Die Laufzeitprüfung `getTypeError` in `runtime.ts`, sie prüft Werte, keine Typen.
- Neue Regeln, die heute unbekannte Fälle entscheiden, außer `lengthOf`.
- Die Struktur der Fehlermeldungen (`// TODO error struktur überdenken`).
