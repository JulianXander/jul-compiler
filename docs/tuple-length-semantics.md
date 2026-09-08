# Ist ein Tupeltyp in seiner Länge exakt?

Internes Arbeitsdokument. Aufbau und Vorgehen nach
[design-principles.md](design-principles.md), Abschnitt „Wie eine Entscheidung getroffen wird".

Die Frage: Bedeutet `[Integer Integer]` **genau zwei** Elemente, oder **mindestens zwei**? Heute
gilt „mindestens" — an keiner Stelle geschrieben, sondern nur daran ablesbar, dass zu wenige
Elemente gemeldet werden und zu viele nicht.

Die Frage betrifft nicht nur Tupel-Zuweisungen. Über `ParamsType` hängt daran auch, ob ein Aufruf
mit zu vielen Argumenten ein Fehler ist, und über `_branch`, welcher Zweig matcht.

---

## 1. Ist-Zustand

Alle Zeilen ausgeführt, nicht aus der Erinnerung. Checker über `parseCode` + `checkTypes`,
Laufzeit über `_branch` bzw. `_callFunction` direkt.

### Checker

| Fall | Code | heute |
|---|---|---|
| Zuweisung zu lang | `x: [Integer Integer] = [1 2 3]` | — |
| Zuweisung zu kurz | `x: [Integer Integer] = [1]` | `Can not assign Empty to Integer.` |
| Parameterliste, zu viele | `f = (a: Integer) => a` · `f(1 2)` | — |
| Parameterliste, zu wenige | `f()` | `Can not assign Empty to Integer.` |
| Parameterliste, benannt extra | `f(a = 1 b = 2)` | — |
| Parameterliste, Spread | `args = [1 2 3]` · `f(...args)` | — |
| Typparameter, zu viele | `g = [Integer Integer] => []` · `g(1 2 3)` | — |
| Typparameter, zu wenige | `g(1)` | `Can not assign Empty to Integer.` |
| Typparameter, Spread | `g(...args)` | — |

Zwei getrennte Fundstellen, beide mit derselben Lücke:

- [getTupleTypeError2](../src/checker.ts#L2972) iteriert über `targetElementTypes`. Was das
  Argument darüber hinaus enthält, wird nie angesehen. Der TODO-Kommentar eine Zeile darüber
  benennt genau das.
- [getTypeErrorForParametersWithCollectionArgs](../src/checker.ts#L3106) iteriert über
  `singleNames` und prüft `rest` nur, wenn er deklariert ist. Ohne `rest` endet die Prüfung mit
  dem letzten Parameter.

Der Spread ist ein dritter, unabhängiger Fall: Spread-Elemente werden in
[case 'list'](../src/checker.ts#L1371) zu `any` (`TODO flatten spread tuple value type`), und
`getTypeError` steigt bei `any` sofort aus. Für `f(...args)` gibt es heute also gar keinen Typ,
gegen den sich eine Länge prüfen ließe — unabhängig davon, wie diese Frage entschieden wird.

### Laufzeit

[getTupleTypeError](../src/runtime.ts#L418) meldet ausschließlich
`value.length < elementTypes.length`. [tryAssignArgs](../src/runtime.ts#L524) läuft im
`singleNames`-Pfad bis zum letzten deklarierten Parameter und sieht danach nicht weiter;
[assignArgs](../src/runtime.ts#L467) — der Pfad für den gewöhnlichen Aufruf, ohne Typprüfung —
genauso.

| Fall | Ergebnis |
|---|---|
| `_callFunction` mit `(a: Integer)` und `[1 2]` | `a=1`, zweites Argument verworfen |
| `_branch` mit `(a: Integer)` und `[1 2]` | matcht |
| `_branch` mit `[Integer Integer]` und `[1 2 3]` | **matcht** |
| `_branch` mit `[Integer Integer]` und `[1 2]` | matcht |
| `_branch` mit `[Integer Integer]` und `[1]` | `did not match any branch` |

**Damit ist der Checker nicht kaputt, sondern treu.** Er bildet ab, was die Laufzeit tut. Die
Semantik ist heute durchgehend *Präfix*: „mindestens diese Elemente, mit diesen Typen." Sie steht
nur nirgends, und die Asymmetrie sieht von außen aus wie ein Loch.

### Nebenbefund, nicht Teil dieser Frage

Im `paramsType`-Pfad geben `assignArgs` und `tryAssignArgs` ein leeres Array zurück. Ein Zweig
`[Integer Integer] => …` wird also **ohne Argumente** aufgerufen; sein Body kommt an die
gematchten Werte nicht heran. Nachgestellt: der Body sieht `[]`, obwohl `[1 2 3]` gematcht hat.
Bei einem Tupeltyp gibt es keine Parameternamen, insofern ist es konsequent — trotzdem ein
eigener Punkt, der unabhängig von dieser Entscheidung zu klären ist.

---

## 2. Die begrenzende Randbedingung

**Die Entscheidung ist keine Checker-Änderung.** Wer den Checker strenger macht, ohne
`runtime.ts` mitzuziehen, erzeugt einen Compiler, der Programme ablehnt, die laufen würden — und
umgekehrt bei `_branch` einen, der ein Matching zusagt, das zur Laufzeit anders ausgeht. Beide
Seiten müssen dieselbe Regel haben.

Das schließt aus, die Frage „nur mal eben" für die bessere Fehlermeldung zu erledigen. Es ist eine
Sprachänderung mit Auswirkung auf jedes Branching.

---

## 3. Optionen

Alle an demselben Beispiel:

```jul
pair = [Integer Integer]
triple = [1 2 3]
f = (a: Integer) => a
g = [Integer Integer] => []
```

### A — alles bleibt: Tupeltyp ist ein Präfix

`x: pair = triple` ist gültig, `f(1 2)` und `g(1 2 3)` ebenso. Die Regel wird ausgeschrieben und
dokumentiert, statt sie zu ändern.

- **Dafür:** kostet nichts, bricht nichts. Passt zu Prinzip 4 (Unwissen ist keine Ablehnung) —
  wobei das hier nicht greift, denn die Länge ist bekannt, sie wird nur nicht geprüft.
- **Dagegen:** Ein Tupeltyp, der die Länge nicht festlegt, ist von `List(Integer)` kaum zu
  unterscheiden. `[Integer Integer]` heißt dann „eine Liste, deren erste beide Elemente Integer
  sind" — dafür gibt es mit `List` bereits eine Form, und mit `...rest` eine zweite. Prinzip 3
  (ein Weg pro Sache) spricht dagegen.
- **Dagegen:** Die Asymmetrie bleibt begründungsbedürftig. Zu kurz meldet, zu lang nicht — das ist
  keine Regel, die man in einem Satz erklärt.

### B — exakte Länge, überall

`x: pair = triple` ist ein Fehler, `f(1 2)` ist ein Fehler, `g(1 2 3)` matcht nicht mehr. Variable
Länge schreibt man mit `List(X)` oder `...rest`.

- **Dafür:** Ein Satz erklärt es. Die Länge ist Teil des Typs, wie die Elementtypen auch.
- **Dafür:** Prinzip 1 — was der Code bedeutet, steht im Code. `[Integer Integer]` sieht nach zwei
  Elementen aus und bedeutet dann auch zwei.
- **Dafür:** Prinzip 3 — `List(X)` und `...rest` sind die Formen für variable Länge, und sie
  existieren bereits. Ein drittes, implizites „darf auch länger sein" ist eine Schreibweise zu
  viel.
- **Dagegen:** verschärft `_branch`. Zweige, die heute matchen, matchen nicht mehr. Der Effekt ist
  in echtem Code auszuzählen, bevor entschieden wird (siehe unten).
- **Dagegen:** Ein `_branch` ohne Treffer liefert `new Error(...)`, keinen Compilerfehler. Aus
  einem heute stillen Match wird also ein stiller Fehlerwert — schlechter als beides. Das koppelt
  diese Frage an Punkt 1 des [Checker-Audits](CHECKER-AUDIT.md).

### C — exakte Länge, mit explizitem Rest im Tupeltyp

Wie B, zusätzlich wird das Präfix schreibbar: `[Integer Integer ...]` oder
`[Integer Integer ...List(Any)]` bedeutet „mindestens diese zwei".

- **Dafür:** Beide Bedeutungen bleiben verfügbar, und man sieht an der Stelle, welche gemeint ist.
  Das ist genau die in Prinzip 1 vorgesehene Auflösung: zwei Schreibweisen sind kein Verstoß gegen
  3, wenn sie Verschiedenes bedeuten.
- **Dafür:** Der Spread in Datenliteralen existiert schon (`[1 ...a ...b]`), die Schreibweise wäre
  keine neue Idee, sondern dieselbe im Typkontext.
- **Dagegen:** neue Syntax und neue Regeln im Parser, im Checker (`getTupleTypeError2`) und in der
  Laufzeit (`getTupleTypeError`). Zu klären: darf nur am Ende ein Rest stehen, und was bedeutet
  `[...List(Text) Integer]`?
- **Dagegen:** Prinzip 5 — erst prüfen, ob es ohne neue Syntax geht. `Or` über mehrere Tupellängen
  deckt endlich viele Fälle ab, „beliebig länger" aber nicht.

### D — exakt beim Aufruf, Präfix beim Matching

Der Aufruf `f(1 2)` und die Zuweisung `x: pair = triple` melden, `_branch` matcht weiter wie
heute.

- **Dafür:** trifft die Fehlerklasse, die tatsächlich wehtut (vertipptes Argument), ohne
  Pattern-Matching anzufassen.
- **Dagegen:** Prinzip 2 — dieselbe Konstruktion bedeutet an zwei Stellen Verschiedenes. Genau die
  Sorte Regel mit Ausnahmenliste, die das Prinzip verbietet. `?(x)` und `f(x)` benutzen beide eine
  Argumentliste gegen eine Parameterliste; sie hier auseinanderlaufen zu lassen, kostet mehr, als
  die Meldung wert ist.

---

## 4. Wie andere Sprachen es halten

Zwei Lager, und sie trennen sich nicht nach Typsystem, sondern danach, ob die Sprache
Pattern Matching als Kernkonstrukt hat.

**Exakt — alle Sprachen mit Pattern Matching:**

- **Erlang / Elixir:** `{A, B} = {1, 2, 3}` schlägt fehl. Die Stelligkeit gehört zur Identität
  einer Funktion — `f/2` und `f/3` sind verschiedene Funktionen, ein Aufruf mit falscher
  Stelligkeit findet keine Klausel.
- **Rust:** `let (a, b) = (1, 2, 3);` ist ein Typfehler. Für das Präfix gibt es eine eigene
  Schreibweise, `..` im Muster — also Option C.
- **Haskell / ML:** Tupel verschiedener Länge sind verschiedene Typen. Zusätzliche Argumente sind
  durch Currying ein Typfehler.
- **Python:** `a, b = (1, 2, 3)` wirft `ValueError`; ein Aufruf mit zu vielen Argumenten wirft
  `TypeError`. Das Präfix schreibt man explizit: `a, b, *rest = …`.
- **TypeScript:** Tupeltypen sind in der Länge exakt, und ein Aufruf mit zu vielen Argumenten ist
  ein Fehler. Bemerkenswert für uns: TS lehnt auch den Spread ab, wenn die Länge unbekannt ist —
  ein Array darf nicht in eine feste Parameterliste gespreadet werden, nur ein Tupel oder ein
  Rest-Parameter.

**Präfix — Sprachen ohne Pattern Matching, in denen Argumente eine Liste sind:**

- **JavaScript:** überzählige Argumente werden ignoriert, Destructuring `const [a, b] = [1,2,3]`
  nimmt das Präfix. Das ist die Semantik, die JUL heute geerbt hat — nicht überraschend, die
  Laufzeit ist JS.
- **Lua:** überzählige Argumente verworfen, fehlende `nil`.
- **Clojure:** Destructuring von Sequenzen ist Präfix, die Stelligkeit eines Funktionsaufrufs
  dagegen wird zur Laufzeit geprüft.

Für JUL ist die Zuordnung eindeutig: `?` ist Pattern Matching, und zwar die häufigste
Kontrollstruktur der Sprache. Von den Sprachen, die dasselbe Konstrukt haben, macht es keine als
Präfix. Prinzip 7 („kein Konstrukt, nur weil andere Sprachen es so schreiben") verbietet, das als
Argument zu nehmen — es ist aber ein Hinweis darauf, dass exakte Muster und Pattern Matching
zusammengehören: Ein Muster, das mehr durchlässt als es zeigt, macht die Reihenfolge der Zweige
zur eigentlichen Logik.

---

## 5. Zahlen aus echtem Code

Gezählt über den Parser, ohne Bewertung (Prinzip 10: die Zahlen sagen, was anzufassen ist, nicht
was sich lohnt).

| | jul-examples (27 Dateien) | yugioh (10 Dateien) |
|---|---|---|
| Funktionsaufrufe | 214 | 1398 |
| davon mit Spread-Argument | 4 | 0 |
| Branchings | 21 | 245 |
| Funktionsliterale | 107 | 828 |
| davon mit Typ statt Parameterliste | 33 | 531 |
| davon mit `...rest` | 4 | 0 |

Zwei Dinge fallen auf:

1. **Der Typparameter-Pfad ist der Normalfall, nicht der Sonderfall.** 531 von 828
   Funktionsliteralen in yugioh (64 %) haben einen Typ statt einer Parameterliste — das sind
   überwiegend Branch-Zweige wie `§up§ => …`. Was hier entschieden wird, trifft also die Mehrheit
   der Funktionsliterale, nicht eine Randform.
2. **Spread im Aufruf ist praktisch nicht vorhanden** (4 von 1612). Dass er ungeprüft durchläuft,
   ist heute kein realer Schaden — und das Flatten nachzurüsten hat entsprechend wenig Dringlichkeit.

Noch nicht ausgezählt, weil dafür der geänderte Checker nötig ist: **wie viele der 266 Branchings
ihren Zweig verlieren würden**, wenn Muster exakt würden. Das ist die Zahl, die Option B gegen A
entscheidet, und sie ist vor der Entscheidung zu erheben — Vorgehen wie bei der Klammer-Regel:
Checker umstellen, Trockenlauf über yugioh und jul-examples, Meldungen zählen.

---

## 6. Abhängigkeiten zu offenen Punkten

- **Branching ohne catchAll** ([Checker-Audit](CHECKER-AUDIT.md), Punkt 1): Solange ein Zweig
  ohne Treffer nur `new Error(...)` liefert und keine Meldung, verschiebt Option B stille Matches
  zu stillen Fehlerwerten. Diese Frage sollte **vorher** entschieden sein.
- **Exhaustivitätsprüfung** ([TODO](../TODO)): Sie rechnet mit denselben Resttypen. Exakte Muster
  machen die Rechnung schärfer — beide Punkte hängen an derselben Stelle.
- **Spread flatten** ([case 'list'](../src/checker.ts#L1371)): unabhängig von der Entscheidung,
  aber nötig, damit die Regel für `f(...args)` überhaupt greifen kann. Ohne das Flatten bleibt
  dort `any`, und die strengste Regel ist wirkungslos.

---

## 7. Empfehlung

**Option C**, in zwei Schritten und erst nach der catchAll-Entscheidung.

Begründung: Prinzip 1 gibt den Ausschlag. `[Integer Integer]` zeigt zwei Elemente; wenn drei
zulässig sind, steht die Bedeutung nicht im Code. Prinzip 3 stützt das — `List(X)` und `...rest`
sind die vorhandenen Formen für variable Länge, ein drittes implizites „darf länger sein"
ist eine Schreibweise zu viel.

C statt B, weil das Präfix-Verhalten in einer Pattern-Matching-Sprache einen echten Zweck hat
(„ein Kommando mit mindestens diesen Feldern") und heute in Gebrauch sein dürfte. Es wegzunehmen,
ohne eine Schreibweise dafür anzubieten, verschöbe Code nach `Or` über mehrere Längen — unlesbar,
und laut Prinzip 5 genau die Schwelle, ab der neue Syntax gerechtfertigt ist.

Reihenfolge:

1. Zählen, was Option B in yugioh und jul-examples bricht. Ergibt der Trockenlauf nahe null, ist
   die Rest-Syntax aus C womöglich unnötig und B reicht — dann ist C überbaut.
2. catchAll entscheiden, sonst wird aus jedem gebrochenen Match ein stiller Fehlerwert.
3. Checker und Laufzeit in einem Schritt umstellen, mit rotem Test je Fundstelle:
   [getTupleTypeError2](../src/checker.ts#L2972),
   [getTypeErrorForParametersWithCollectionArgs](../src/checker.ts#L3106),
   [getTupleTypeError](../src/runtime.ts#L418), [tryAssignArgs](../src/runtime.ts#L524).

Nicht Teil davon, aber vorher zu klären: dass ein Zweig mit Tupeltyp seine gematchten Werte
überhaupt sieht (Nebenbefund in Abschnitt 1).
