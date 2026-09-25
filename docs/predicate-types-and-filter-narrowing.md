# Prädikate als Typen: was daran offen ist

Ausgangspunkt war ein Fund in yugioh (Session 2026-09-10): `filter` verengte
`List(Or(Integer Empty))` nicht auf `List(Integer)`, obwohl das Prädikat es beweist. Daraus wurde
ein enger, geprüfter Mechanismus: erkennt der Checker im Rumpf eines Boolean-Callbacks exakt ein
`?(param)`-Branching, hängt er `predicate: PredicateFacts` an den Funktionstyp
([syntax-tree.ts](../src/syntax-tree.ts)) - `ifTrue` als Obermenge zum Schneiden im branch selbst,
`excludedIfFalse` als Untermenge zum Abziehen in späteren branches. Konsumiert wird das an zwei
Stellen: der Branch-Verengung am Typ-Kopf und der Projektion `predicate/PredicateIfTrue` in den
core-lib-Signaturen von `filter`, `findFirst` und `findLast`. `findLastIndex` liefert einen Index,
`exists` und `all` liefern `Boolean` - dort gibt es keinen ElementType zum Schneiden, die
Verengung am Aufrufort ist der ganze Nutzen.

Dieses Dokument hält fest, **was daran noch offen ist** - und warum die Grenze dort liegt, wo sie
liegt.

## Die Grenze, die bleibt

Die Gleichung "Typ = Prädikat" stimmt immer; mengentheoretisch *ist* ein Typ die Menge der Werte,
für die ein Prädikat `true` liefert. JULs Laufzeit lebt das bereits: `getTypeError` in
runtime.ts hat einen `case 'function'`, der einen Typ in Typ-Position schlicht **aufruft**, und
`List`/`And`/`Or` sind in core-lib.jul genau so gebaut.

Der statische Checker kann das trotzdem nicht generalisieren - nicht aus semantischen, sondern
aus **Entscheidbarkeits**gründen. Die Frage ist nicht, ob ein Boolean-Callback ein Typ *ist*,
sondern ob der Checker **ohne es auszuführen** herausfinden kann, für welche Werte es `true`
liefert. Ein Prädikat wie `getActivationRequirementsMet(...)` ist beliebiger,
Turing-vollständiger JUL-Code - nach dem Satz von Rice ist jede nicht-triviale semantische
Eigenschaft eines solchen Programms nicht algorithmisch entscheidbar. Genau deshalb besteht JULs
statische Typwelt aus einer geschlossenen, rein strukturellen Algebra (`CompileTimeType`-Tags):
der Checker vergleicht Tags, führt nie etwas aus und terminiert deshalb immer. Selbst ein
Interpreter (siehe TODO "infer pure function call return type") hülfe nicht - er bräuchte
konkrete Werte, der Parameter eines Callbacks ist aber symbolisch.

**Daraus folgt für jeden offenen Punkt unten dieselbe Obergrenze:** erweitert werden kann nur das
erkannte Mustervokabular, nie die Erkennung selbst zu "beliebige Prädikate". Wer wirklich
beliebige Prädikate als Typen will, landet bei Refinement Types mit SMT-Solver (Liquid Haskell,
F\*, Dafny) oder manuellen Beweistermen (Idris) - eine andere Größenordnung an Infrastruktur als
JULs struktureller Checker und außer Verhältnis zum Sprachumfang.

### Vorbilder für die offenen Erweiterungen

- **TypeScript 5.5 (2024), "inferred type predicates"** - der einzige bekannte, produktiv
  eingesetzte Mechanismus, der eine Verengung **automatisch aus dem Rumpf** ableitet, ohne
  `x is T`-Annotation und ohne SMT-Solver: erkennt gezielt einfache, entscheidbare Muster
  (`typeof`, `instanceof`, `!= null`, kurze Boolean-Ausdrücke). Strukturell dasselbe Prinzip wie
  JULs Branching-Erkennung, nur mit anderem Mustervokabular. Der Referenzpunkt für Punkt 2 unten.
- **Typed Racket** - *Occurrence Typing* (Tobin-Hochstadt & Felleisen, POPL 2010). Jeder
  Funktionstyp trägt eine logische Formel ("latenter Filter" φ⁺ | φ⁻), die beschreibt, was ein
  `true`/`false`-Ergebnis über das Argument aussagt, inklusive Kombination über `and`/`or`/`not`.
  `PredicateFacts` folgt diesem Vorbild in der Zweiteilung; die konzeptionelle Grundlage, falls
  die Formel-Kombination später generalisiert werden soll.
- **TypeScript/Flow (`x is T`)** - an der Signatur **behauptet**, nicht gegen den Rumpf geprüft.
  Dieselbe Vertrauensgrenze wie `assume()` in JUL, nur anders platziert. Als Vorbild bewusst
  nicht gewählt.
- **Kotlin** (`filterIsInstance<T>()`) und **Scala** (`.collect { case x: Foo => ... }`) - beide
  lösen nur den Is-Instance-Fall, nicht beliebige Prädikate; Scalas Verengung kommt aus dem
  Pattern-Match, nie aus einem geprüften Boolean.
- **Rust/Haskell** - `filter` verengt nie, `filter_map`/`mapMaybe` lösen den Fall über den
  Rückgabewert statt über ein Boolean. JULs `filterMap` folgt dem und funktioniert schon korrekt.

## Offene Punkte

### 1. Narrowing über den `Type`-Wert hinweg (Scope 2b)

`pred: Type = isInteger` als Zwischenschritt, danach soll `?(x) [pred] => ...` oder ein an
anderer Stelle gespeicherter Prädikatwert narrowen. Ein Prädikat ist heute an einer
`Type`-Position zwar *zuweisbar*, aber nicht *verengend* - das bleibt exklusiv dem direkten
`?(pred)`-Typ-Kopf vorbehalten.

Offen ist hier keine Implementierung, sondern eine **Entscheidung**: Datenfluss-Fragilität
(Umbenennung oder Indirektion bricht das Narrowing stillschweigend) sollte diskutiert sein, bevor
der Weg offen steht. Alternative ist der 2a+-Pfad mit einer eigenen TypeGuard-Position, die die
Absicht sichtbar macht, statt sie aus dem Datenfluss zu raten.

Der Plan unten würde diese Frage mitentscheiden, siehe dort Frage 8.

### 2. Weitere Rumpfformen

Erkannt wird nur: **ein** Parameter, Rumpf **genau ein** `?(param)`-Branching. Offen sind
mehrere Parameter, Prädikate aus Aufrufen und Referenzketten.

Ein nicht-literaler branch-Rumpf zählt bereits konservativ zu `ifTrue` (das vergrößert die
Obermenge, bleibt also sound), zu `excludedIfFalse` dagegen nicht - jede Erweiterung muss diese
Asymmetrie mitdenken, weil die beiden Mengen gegenläufige Schranken sind
(`excludedIfFalse ⊆ T ⊆ ifTrue`).

Zu beachten: Die Erkennung hängt **nicht** am deklarierten Rückgabetyp, sondern am inferierten -
gemessen trägt der Funktionstyp `Boolean` auch dann, wenn `:> Boolean` explizit dasteht; die
Annotation ist ohnehin optional und die Herleitung liest den Rumpf.

### 3. Welchen Parameter die Fakten meinen

Heute implizit Argument 0. Für `filter` & Co. ist das automatisch richtig, weil sie ihr Prädikat
immer zuerst mit dem Element aufrufen (Index kommt an Position 1). Erst ein Callback, der das
Element an anderer Stelle übergibt, bräuchte die Angabe explizit - dann bekommt `PredicateFacts`
einen `parameterIndex`. TypeScript (`x is T`) und Flow (`param is Type`) benennen den Parameter
aus genau diesem Grund.

## Plan: Ein Funktionswert in Typ-Position ist ein Prädikat

**Entwurf 2026-09-25, teilweise entschieden.** Was entschieden ist und was offen, steht am Ende
des Abschnitts.

### Ist-Zustand

Die Laufzeit hat die Regel schon: `getTypeError` ruft eine Funktion in Typ-Position auf und
wertet das Ergebnis als wahr/falsch (runtime.ts, `case 'function'`). Der Emitter gibt Typguards
unverändert aus, und `assignArgs` prüft Parametertypen zur Laufzeit. `(a: isInteger) => a` läuft
also schon heute korrekt.

Der Checker liest dieselbe Stelle anders. Er stellt einen Wert durch seinen Typ dar, und `valueOf`
packt ihn in Typ-Position wieder aus. Bei Literalen geht dabei nichts verloren, weil der Typ von
`1` die Menge `{1}` ist. Bei einer Funktion ist der Typ aber nur ihre Signatur, und `valueOf` gibt
im Fall `'function'` genau diese zurück (dort steht `// TODO?`). `(a: isInteger)` heißt für den
Checker deshalb „a ist eine Funktion `(x: Any) -> Boolean`“. Gemessen am Quellstand:

| Stelle | Checker heute |
|---|---|
| Branch-Kopf `?(v) [isInteger] => …` | verengt (Sonderweg `getBranchPredicateFacts`) |
| `Type`-Parameter `useType(isInteger)` | angenommen, nur erkannte Prädikate |
| `filter`, `findFirst`, `findLast` | verengen über `predicate/PredicateIfTrue` |
| `(a: isInteger)`, `:> isInteger`, `x: isInteger = …` | Fehler `Can not assign 1 to (x: Any) -> Boolean` |
| `List(isInteger)`, `Or(isInteger Text)`, `And(…)` | derselbe Fehler |

Ein Funktionstyp-Literal `(x: Any) :> Boolean` ist davon unterscheidbar. Der Checker verpackt es
als `TypeOf(F)` (`case 'functionTypeLiteral'`), und `valueOf` packt `TypeOf` aus, ohne
weiterzusteigen. Nach dem Auspacken bedeutet eine nackte Funktion also nur dann „Menge der
Funktionen mit dieser Signatur“, wenn sie aus einem Typ-Literal stammt.

### Randbedingung

Der Satz von Rice aus dem Abschnitt „Die Grenze, die bleibt“ gilt unverändert. Der Checker weiß
über ein Prädikat nur, was `PredicateFacts` hergibt. Bei jedem anderen Prädikat muss er sich einer
Aussage enthalten, und die Laufzeit prüft. Das Folding widerspricht dem nicht: Es rechnet das
Prädikat für einen konkreten Wert aus. Der Satz von Rice betrifft die Aussage für alle Werte, also
einen symbolischen Parameter.

### Optionen

1. **Alles bleibt.** Der Checker meldet an lauffähigem Code weiter Fehler. Das verletzt Freiheit:
   Er verbietet ein gültiges Programm.
2. **Literale nur noch über `TypeOf` als Typ.** Verworfen. Es löst die Prädikat-Frage nicht, denn
   `valueOf` bräuchte den neuen Fall trotzdem. Es ändert die Bedeutung bei Kollektionen:
   `TypeOf([1 2])` prüft mit `deepEqual` und lehnt `[1 2 3]` ab, `[1 2]` als Typ akzeptiert es.
   Tuple-Typen wie `[Integer Text]` sind selbst umgewandelte Werte und blieben ohnehin implizit.
   Und es trifft etwa 464 Stellen in yugioh und 23 in jul-examples (`[true] =>`, `[§…§] =>`,
   `Or(1 2)`).
3. **Ein Funktionswert in Typ-Position ist ein Prädikat.** Der Checker übernimmt die Regel der
   Laufzeit. Wer die Menge nur mit dieser einen Funktion meint, schreibt `TypeOf(f)`, wie bei
   jedem anderen Wert auch.

Empfehlung: Option 3. Den Ausschlag gibt Freiheit, weil der Checker heute falsche Fehler meldet.
Klarheit kommt dazu: Checker und Laufzeit lesen dieselbe Zeile dann gleich.

### Regel für die Laufzeit

Ein Wert `v` erfüllt ein Prädikat `p`, wenn `p` mit der Argumentliste `[v]` aufrufbar ist und
genau `true` liefert. Zulässig als Typ ist damit **jede Funktion, die `true` liefern kann**. Eine
Einschränkung der Parameterform ist nicht nötig. Zwei Änderungen an `getTypeError`
(runtime.ts, `case 'function'`) gehören dazu:

- **`=== true` statt truthy.** Heute matcht jeder truthy-Wert, also auch `5`, ein Text oder der
  Error eines nicht erschöpfenden Branchings.
- **Aufruf über die Parameterbindung.** Heute ruft die Laufzeit `type(value)` direkt als
  JS-Funktion auf und umgeht damit `tryAssignArgs`. Dadurch werden die Parametertypen des
  Prädikats nicht geprüft. Eine Funktion mit Typ-Kopf (`[Integer] => true`) bekommt ihr Argument
  gar nicht, denn der Emitter erzeugt dafür `() => …`. Künftig läuft der Aufruf wie in `_branch`
  über `tryAssignArgs(p.params, undefined, [v])`. Passt `[v]` nicht auf die Parameter, gilt das
  als `false`, nicht als Fehler. JS-Funktionen ohne `params` (`nativeFunction`, Importe aus
  `.ts`/`.js`) ruft die Laufzeit weiter direkt auf, wie `_callFunction` es auch tut.

Damit gilt für jede Parameterform dasselbe wie für einen Aufruf mit einem Argument. Ein zweiter
Parameter ohne Typ bekommt `[]`. Ein zweiter Pflichtparameter mit Typ, der `[]` ausschließt, führt
dazu, dass das Prädikat nie `true` liefert.

### Regel für den Checker

Ein Funktionswert und der Typ, den er als Prädikat beschreibt, sind verschiedene Mengen:

| | enthält | Beispiel |
|---|---|---|
| Funktionstyp `(x: Any) :> Boolean` | Funktionen mit dieser Signatur | `isInteger` passt, `5` nicht |
| Prädikat `isInteger` in Typ-Position | Werte, für die es `true` liefert | `5` passt, `isInteger` nicht |

Heute kommt für beide nach `valueOf` dasselbe heraus. **Entschieden 2026-09-25:** Das Prädikat
bekommt einen eigenen Typ `julType: 'predicate'`. `valueOf` macht aus einem Funktionswert ein
solches Prädikat. Das Funktionstyp-Literal ist davon nicht betroffen: Es kommt als `TypeOf(F)` an,
und `valueOf` packt es zu `F` aus, ohne den neuen Fall zu erreichen.

Das Prädikat trägt drei Dinge:

- **die Funktion selbst**, für die Identität und fürs Folding,
- **eine Obermenge** `And(Typ des ersten Parameters, ifTrue)`, ohne beides `Any`. Der Parametertyp
  zählt mit, weil die Laufzeit ihn prüft. `isPositive = (x: Integer) => x > 0` liegt also
  mindestens in `Integer`, auch ohne erkanntes Branching.
- **eine Untermenge** `excludedIfFalse`, ohne Fakten `Never`.

#### Warum ein eigener Typ

Würde `valueOf` gleich in die Obermenge übersetzen, vergäße der Checker, welches Prädikat dort
stand. Drei Folgen, jeweils mit einem Prädikat `isPrime = (n: Integer) :> Boolean => …`, dessen
Rumpf er nicht erkennt:

- **Abziehen im Branching.** Bei `v: Or(isPrime Text)` und `?(v) [isPrime] => … () => g(v)` bleibt
  im catchAll nur `Text`. Mit der Obermenge hieße der Parametertyp `Or(Integer Text)`. Das lässt
  sich nicht von einem Programm unterscheiden, in dem im catchAll wirklich eine `4` ankommt. Der
  Checker könnte nichts abziehen und meldete `g(v)` fälschlich.
- **Verschachteltes `Not`.** `Not(Or(isPrime Text))` würde zu `Not(Or(Integer Text))` und lehnte
  `4` ab, obwohl die Laufzeit es annimmt.
- **Folding.** `x: divisibleBy(5) = 44` (jul-examples/fizz-buzz) kann nur gemeldet werden, wenn die
  Funktion noch da ist, um sie auszurechnen. Zur Laufzeit meldet es niemand, denn der Emitter gibt
  Typguards an Definitionen nicht aus.

#### Auflösen wie `alias`

Vorbild ist `alias`: eine benannte Hülle, die `ResolvedType` per Typ ausschließt und die
`resolveAlias` auflöst (55 Aufrufe im Checker, nur 4 eigene `case 'alias'`). Das Prädikat wird
genauso zu seiner Obermenge aufgelöst, aber **nur dort, wo der Checker eine Gestalt braucht**:
Feldzugriff, Elementtyp, Länge, Aufrufbarkeit.

Wo er Mengen vergleicht, darf er es nicht auflösen. Ein Alias ist reine Beschriftung und gleich
dem Typ dahinter. Ein Prädikat ist dagegen **nicht** gleich seiner Obermenge: `isPrime` ist
nicht `Integer`. Würde man es wie einen Alias behandeln, gäbe es zwei falsche Schlüsse in
`createNormalizedIntersectionType`, das die Choices vorab mit `resolveAlias` auflöst:

- `And(Integer Not(isPrime))` würde über `typeEquals(Integer, isPrime)` zu `Never`, obwohl `4`
  darin liegt.
- `And(Integer isPrime)` würde über den Teilmengen-Shortcut zu `Integer`, weil „Integer passt
  auf isPrime“ nach Regel 3 unten kein Fehler ist. Das Prädikat ginge still verloren.

Deshalb gilt:
- `typeEquals` dealiast ein Prädikat nicht.
- `hasReliableTypeError` zählt es zu den Typen, bei denen „kein Fehler“ nicht „ist Teilmenge“
  heißt, wie heute schon `any` und `parameterReference`.
- Die Normalisierung von `Or`, `And` und `Not` behält es als eigenen Operanden.

Die 55 Aufrufe von `resolveAlias` sind deshalb einzeln durchzusehen: Braucht die Stelle eine
Gestalt oder vergleicht sie Mengen? Das ist der eigentliche Aufwand des eigenen Typs.

In die Hülle schauen die folgenden Stellen, und zwar **vor** dem Auflösen:

- **Zuweisung eines Werts an ein Prädikat `P`,** in dieser Reihenfolge:
  1. Der Wert hat selbst den Typ `P`, dieselbe Funktion: passt.
  2. Der Wert ist konstant (`typeToConstantValue`) und die Funktion faltbar: ausrechnen. `true`
     passt, alles andere ist ein Fehler.
  3. Sonst muss der Wert ganz in der Obermenge liegen, wie bei jedem anderen Typ auch. Den Rest
     prüft die Laufzeit.
- **Zuweisung von `P` an einen anderen Typ:** passt, wenn das Ziel `P` selbst enthält (etwa
  `Or(P Text)`) oder die Obermenge von `P` ins Ziel passt.
- **`Or`/`And`/`List`:** Das Prädikat bleibt ein eigener Operand. Die Normalisierung darf es für
  Vergleiche auflösen, im Ergebnis aber nicht ersetzen.
- **`Not`** dreht die Richtung um: Obermenge von `Not(P)` ist `Not(Untermenge)`, Untermenge ist
  `Not(Obermenge)`. Das gilt auch verschachtelt, weil das Prädikat bis ins `Not` erhalten bleibt.
  `Without` ist in der core-lib als `And(Not(…))` definiert und bekommt das mit.
- **Branch-Kopf `[P]`:** Im Branch selbst wird mit der Obermenge geschnitten. Ein `P` im Typ des
  gebranchten Werts bleibt dabei erhalten. In späteren Branches wird `P` über die Identität
  abgezogen, sonst die Untermenge. Die Erschöpfungsprüfung zählt einen Prädikat-Kopf ebenfalls nur
  mit Identität oder Untermenge. Sonst gälte `?(x) [isPositive] => …` ohne catchAll für jeden
  Integer als erschöpfend.
- **`typeToString`:** zeigt den Namen des Prädikats bzw. den Aufruf, der es erzeugt hat
  (`divisibleBy(5)`), nicht die Obermenge.

Als Typ abgelehnt (JUL5002) wird eine Funktion nur, wenn feststeht, dass sie nie `true` liefert:
Ihr Rückgabetyp schließt `true` aus, oder `[v]` passt für kein `v` auf ihre Parameter. Eine
Funktion mit Rückgabetyp `Any` wird angenommen.

#### Folding: was heute geht und was fehlt

Gemessen am Quellstand:

| Ausdruck | Typ heute |
|---|---|
| `isFive = (dividend: Integer) => dividend.modulo(5).equal(0)`, dann `isFive(45)` | `true`, gefaltet |
| `divisibleBy(5)(45)` | `Boolean`, nicht gefaltet |
| `divisibleBy(5)` | Funktionstyp mit `literal` und `foldable`, aber ohne Bindung von `divisor` |

Für eine benannte Funktion wie `isFive` reicht das vorhandene Folding (`tryFoldCall`,
`tryBuildCallable`) also schon. Für ein Prädikat, das ein Aufruf erzeugt, reicht es nicht, und
genau so ein Fall steht im fizz-buzz-Beispiel: Die zurückgegebene Funktion trägt ihr Literal,
aber nicht, dass `divisor` an `5` gebunden ist. `buildEnvironment` findet für die freie Referenz
`divisor` keinen Wert und gibt auf. Voraussetzung ist deshalb, dass der Funktionstyp, den ein
gefalteter Aufruf liefert, die gebundenen Argumente mitführt. Das ist ein eigener Schritt und
nützt auch ohne Prädikate.

Das Folding greift unter denselben Bedingungen wie heute: Die Funktion ist faltbar, rein, und
das Budget pro Check-Lauf ist nicht erschöpft. Greift es nicht, gilt Regel 3 mit der Obermenge.

### Schritte

1. **Rote Tests**, je ein `it` mit `expectCheck`:
   - Parameter-, Rückgabe- und Definitions-Annotation mit Prädikat,
   - `List`/`Or`/`And`/`Not` mit Prädikat, auch verschachtelt in `Not`,
   - ein falsches Argument (Text gegen `isInteger`),
   - ein nicht erkanntes Prädikat, das angenommen wird,
   - ein unreines Prädikat, das abgelehnt wird, als Typguard und als Branch-Kopf,
   - ein Prädikat mit typisiertem Parameter (`isPositive`),
   - das Abziehen über die Identität im catchAll,
   - ein Literal, das per Folding abgelehnt wird (`x: isFive = 44`),
   - ein Funktionstyp-Literal in Typ-Position, das weiter Funktionen verlangt.

   Für die Laufzeit: `=== true`, eine Funktion mit Typ-Kopf als Prädikat, der Parametertyp des
   Prädikats wird geprüft. Dann anhalten.
2. **Laufzeit:** `getTypeError` im `case 'function'` auf `tryAssignArgs` und `=== true` umstellen.
3. **Typ `predicate`** in syntax-tree.ts anlegen, in `ResolvedType` ausschließen und in
   `resolveAlias` auflösen. Danach `valueOf` im Fall `'function'` umstellen, nach Klärung von
   Frage 6.
4. **Zuweisung, `Not` und Normalisierung** wie in „Auflösen wie `alias`“.
5. **Branch-Kopf:** Identität und Untermenge fürs Abziehen und die Erschöpfungsprüfung.
   `getBranchArgumentType` und `getBranchPredicateFacts` gehen darin auf. Die
   Unerreichbarkeits-Prüfung (`TODO` bei „Prädikat-Fakten checken“) kann danach die Untermenge
   nutzen.
6. **Folding für Prädikate** über das vorhandene `tryBuildCallable`. Das deckt benannte Prädikate
   wie `isFive` ab.
7. **Gebundene Argumente im Funktionstyp**, damit auch `divisibleBy(5)` faltbar wird.
8. **`checkTypeGuardIsType`/JUL5002** an Frage 2 anpassen, unreine Prädikate ablehnen
   (Frage 9), auch an Branch-Köpfen, die heute nicht darauf geprüft werden. Den Schutz in
   `getPredicateFacts` entfernen (Frage 3).
9. **Drumherum:** `typeToString`, Hover, Checker- und LSP-Snapshot, Bench vor und nach dem Umbau
   mit `--save`, öffentliche Doku in jul-homepage.
10. **Offener Punkt 1 oben** ist mit diesem Plan mitentschieden, siehe Frage 8. Diesen Abschnitt
    danach anpassen.

### Was noch zu klären ist

1. **Realer Anlass.** Beantwortet 2026-09-25: `x: divisibleBy(5) = 45` in
   jul-examples/fizz-buzz scheitert heute an JUL5002 und JUL5000, obwohl die Branch-Köpfe
   darüber dasselbe Prädikat nutzen. In yugioh steht kein Prädikat in Typ-Position.
2. **Welche Funktionen als Typ zulässig sind.** Entschieden 2026-09-25: jede, die `true`
   liefern kann, siehe „Regel für die Laufzeit“. Der Test
   `arbitrary-boolean-function-not-assignable-to-type` kippt damit.
3. **Wahrheitsprüfung der Laufzeit.** Entschieden 2026-09-25: `=== true`. Der Schutz in
   `getPredicateFacts` davor, dass der Error eines nicht erschöpfenden Branchings matcht
   (checker.ts, „Die Laufzeit matcht ein Prädikat in Typ-Position mit einer Wahrheitsprüfung“),
   kann dann entfallen.
4. **Funktionsformen.** Entschieden 2026-09-25: keine Einschränkung, der Aufruf läuft über die
   Parameterbindung, siehe „Regel für die Laufzeit“. Offen ist nur noch, was der zusätzliche
   `tryAssignArgs`-Aufruf je Prüfung kostet. Das misst der Bench.
5. **Darstellung.** Entschieden 2026-09-25: eigener Typ nach dem Vorbild `alias`, siehe
   „Regel für den Checker“. Den Ausschlag gab das Folding.
6. **Wo umgewandelt wird.** Ein neuer Fall in `valueOf` wirkt überall. Mindestens eine Stelle ruft
   `valueOf` aber auf einen Wert und nicht auf einen Typwert auf: das Auflösen einer
   Parameter-Referenz im Argumentkontext (`// TODO immer valueOf?`). Über diesen Weg gehen
   `TypeOf(value)` in `WithElementAt(TypeOf(values) index TypeOf(value))` und
   `TypeOf(intitialValue)`. Ist das Argument dort eine Funktion, würde daraus fälschlich ein
   Prädikat. Zu klären ist, ob die Stelle `valueOf` wirklich braucht, oder ob die Umwandlung
   besser als eigene Funktion nur an Typ-Positionen läuft.
7. **Identität.** Wann sind zwei Prädikate dieselben? Sicher bei derselben benannten Funktion,
   auch über `pred = isPrime`. Offen ist der Aufruf: `x: divisibleBy(5)` und später
   `?(x) [divisibleBy(5)]` sind zwei Aufrufe mit zwei Ergebnissen. Gleich wären sie über dasselbe
   Literal mit denselben gebundenen Argumenten (Schritt 7). Ein Lambda, das an zwei Stellen neu
   hingeschrieben wird, ist nie gleich.
8. **Verengung über gespeicherte Werte (offener Punkt 1).** `pred = isInteger` trägt dieselben
   Fakten wie `isInteger`, und ein `Type`-Parameter bekommt sie beim Auflösen mit. Damit
   verengt `?(x) [pred]` automatisch. Die Frage aus Punkt 1, ob das über den Datenfluss passieren
   soll, fällt also hier und muss ausdrücklich entschieden werden.
9. **Reinheit.** Identität und Folding setzen ein reines Prädikat voraus. Ein Prädikat, das
   Zustand liest, kann für denselben Wert beim zweiten Aufruf etwas anderes liefern. Dann
   stimmt `P ⊆ P` über zwei Aufrufe hinweg nicht mehr. Das gilt auch innerhalb eines
   Branchings: Bei `v: Or(isPrime Text)` wertet die Laufzeit `isPrime` einmal beim Parametertyp
   aus und ein zweites Mal im Kopf `[isPrime]`. Bei `[isPrime] … [Not(isPrime)]` wertet sie es
   einmal je Kopf aus.

   **Entschieden 2026-09-25:** Ein Prädikat in Typ-Position muss rein sein. Ist es `impure`
   (Pfeil `~>` oder so abgeleitet), meldet der Checker JUL5002. Das gilt an jeder Stelle, an der
   `valueOf` aus einem Funktionswert ein Prädikat macht: Typguards, Branch-Köpfe und Argumente
   für `Type`-Parameter, also auch `Or`/`And`/`Not`. Identität und Folding sind damit für jedes
   zulässige Prädikat sicher. Als Argument für `filter` & Co. bleibt jede Funktion erlaubt, denn
   das ist keine Typ-Position.

   Getroffen wird heute nichts. Die einzigen Funktionen in Branch-Köpfen in jul-examples und
   yugioh sind `divisibleBy(…)` in den beiden fizz-buzz-Dateien. Der Checker leitet
   `divisibleBy`, `divisibleBy(5)` und `isFive` als `pure` ab, `(x: Integer) => log(x)` als
   `impure`.

   Das ist die erste Stelle, an der die Reinheit eine Anforderung ist und nicht nur Anzeige
   (vgl. „Bewusst nicht enthalten“ in [pure-functions.md](pure-functions.md)).

   **`unknown`, entschieden 2026-09-25:** wird angenommen, aber ohne Folding. Das betrifft den
   Pfeil `:>` ohne auflösbaren Rumpf, etwa einen Parameter `(p: (x: Any) :> Boolean)`, der dann als
   Typ benutzt wird, oder einen Import aus `.ts`. Das folgt Freiheit: „Unwissen ist keine
   Ablehnung“. Folgerung: Auch die Identität gilt für ein `unknown`-Prädikat nicht, denn sie ist
   aus demselben Grund nur für reine Prädikate sicher.
10. **Typguards an Definitionen zur Laufzeit.** Der Emitter gibt sie nicht aus. `x: isPrime = 4`
    fällt also nur auf, wenn der Checker faltet. Ist das gewollt, oder sollen sie wie
    Parametertypen zur Laufzeit geprüft werden? Das betrifft nicht nur Prädikate.

Nicht Teil dieses Plans ist die umgekehrte Richtung: ein Typ als Prädikat-Argument
(`filter(Integer)`). Dazu der nächste Abschnitt.

## Weitergehende Idee: Typ-/Literal-Werte direkt als Prädikat-Argument

**Stand 2026-09-15, reine Ideensammlung, keine Entscheidung getroffen.** Ausgangspunkt war die
Frage, warum

```jul
myFn = (a: List(Or([] Integer))) =>
	c = a.filter(Integer)
```

ungültig ist - `Integer` selbst (kein Wrapper wie `isInteger`) direkt als `filter`-Prädikat.
Anders als der Rest dieses Dokuments (Verengung *durch* ein Prädikat) geht es hier darum, den
Prädikat-Wrapper für den häufigen Fall "prüfe nur den Typ" ganz einzusparen.

### Generalisierung über `Integer` hinaus

Literale sind in JUL schon heute als Typen verwendbar (`f = (positive: Greater(0)) :> Not(5) =>
...`, checker.test.ts:757) und laufen im Checker durch dieselbe "Wert-als-Typ"-Kollaps-Logik wie
benannte Typen (`TypeOf(X)` fällt zu `X`, checker.ts:3517/4608f.) - eine Konvertierung, die `Integer`
als Prädikat erlaubt, würde `filter(5)` (Gleichheits-Prädikat) also automatisch mit abdecken, nicht
als Sonderfall, sondern als Nebeneffekt derselben Regel.

### Form des synthetischen Prädikat-Typs

Ein aus einem Typwert abgeleitetes Prädikat sollte die Form `(value: Any) :> Boolean` annehmen
(`'parameters'`-Shape, benannt), **nicht** `[Any] :> Boolean` (`'tuple'`-Shape, unbenannt) - obwohl
beide syntaktisch gültig sind (`checkParamsTypeIsCollection`, checker.ts:4484, lässt beide zu) und
`[Any]` sogar näher an der Schreibweise unbenannter Branch-Arme (`[true] => []`, s.a.
`yugioh/src/main.jul:264`) liegt. Grund: `filter`/`findFirst`/`findLast`/`findLastIndex`/`exists`/
`all` deklarieren ihren `predicate`-Parameter durchgängig `'parameters'`-förmig
(`(value: X index: Y) :> Boolean`), und nur diese Form landet im bereits erprobten Codepfad
`getTypeErrorForParameters` (checker.ts:5560). Ein `PredicateIfTrue`-Fact lässt sich ohne
Checker-Umbau anhängen: `predicate` ist ein simples optionales Feld auf `CompileTimeFunctionType`
(`{ifTrue, excludedIfFalse?}`, syntax-tree.ts:924-941), direkte Zuweisung nach dem Bau des
Funktionstyps genügt (Vorbild: checker.ts:2696) - `dereferenceNameFromObject` und
`createCompileTimeFunctionType` bleiben unverändert.

### Laufzeit: trivial, sofern die Aufrufstelle bekannt ist

`getTypeError` (runtime.ts:222-416) behandelt Literale (`typeof`-Vergleich), getaggte Typwerte
(`_julTypeSymbol`) und sogar Funktionswerte als Prädikat (`typeof type === 'function'` →
`type(value)`) bereits einheitlich - dieser dritte Fall ist praktisch schon die Laufzeit-Hälfte
dieses Features, nur bisher nicht von `filter` & Co. genutzt. Pro Aufrufstelle reicht ein einmaliger
Wrap vor der Schleife:

```ts
const actualPredicate = typeof predicate === 'function'
	? predicate
	: (v: T) => getTypeError(v, predicate) === undefined;
```

### Das eigentliche offene Problem: Checker/Runtime-Symmetrie

Eine *generische* Checker-Regel (an jeder Stelle, die `X :> Boolean` fordert, egal welche Funktion)
würde nur type-checken, aber nicht überall auch laufen: Nutzer-eigene JUL-Funktionen mit einem
`predicate: (v: Any) :> Boolean`-Parameter würden `Integer` als Argument akzeptieren, aber beim
Aufruf `predicate(value)` zur Laufzeit crashen, sofern die jeweilige Aufrufstelle nicht denselben
Wrap durchläuft. Eine generische Lösung bräuchte also entweder:

- eine universelle Runtime-Bridge (z.B. `_callFunction`, runtime.ts:36-50, generisch erweitert) -
  das würde aber "Aufruf eines Nicht-Funktionswerts" **in der gesamten Sprache** von einem Fehler
  zu einem stillen Prädikat-Test machen (`5()` als Bug bliebe unbemerkt), und `filter`/`findFirst`/
  `exists`/`all` rufen `predicate` ohnehin direkt als JS-Funktion auf (z.B. runtime.ts:2103-2105),
  nie über `_callFunction` - eine zentrale Erweiterung dort würde diese Aufrufe gar nicht erreichen.
- oder eine geschlossene, explizit benannte Markierung statt einer unsichtbaren, überall greifenden
  Typform-Heuristik.

**Skizzierter Mittelweg:** ein eigener Typ-Alias in core-lib.jul, z.B.
`Predicate(X) = (value: X index: PositiveInteger) :> Boolean`, an den sowohl die
Checker-Sugar-Regel als auch der Runtime-Wrap gebunden sind - nicht an Funktionsnamen (`filter`
hartkodiert), sondern an diesen einen, dokumentierten Typ. `filter` & Co. deklarieren `predicate`
dann als `Predicate(TypeOf(values)/ElementType)`; jede Funktion, die denselben Alias verwendet
(auch Nutzer-Code), bekommt dieselbe Sugar, muss ihn beim eigenen Aufruf aber ebenfalls über den
dokumentierten Wrap auflösen. Damit bleibt die Regel global und lernbar ("`Predicate(X)` akzeptiert
zusätzlich zu Funktionen auch Typen/Literale"), ohne an jeder beliebigen `X :> Boolean`-Stelle in
der Sprache implizit zu greifen.

### Vorbilder in anderen Sprachen

- **Ruby** ist das stärkste direkte Vorbild: `Class#===` ist als `is_a?` definiert
  (Case-Equality), `Enumerable#grep(pattern)` ruft `pattern === element` auf
  (`[1, "a", 2].grep(Integer)` → `[1, 2]`), seit Ruby 2.5 akzeptieren auch `all?`/`any?`/`none?`/
  `one?` ein Pattern statt eines Blocks. Etabliertes, produktiv genutztes Idiom, kein Fremdkörper.
- **Python** ist das Gegenbeispiel: `filter(int, liste)` ruft `int(x)` als **Konstruktor** auf und
  wertet das Ergebnis truthy/falsy - keine echte Typprüfung, sondern eine Coercion-Falle
  (`int(0)` ist falsy, obwohl `0` ein echter Integer ist). JULs Ansatz über `getTypeError` (reiner
  Vergleich, keine Konversion) vermeidet das bewusst.
- **Kotlin** löst denselben Bedarf über eine eigene, dedizierte Methode (`filterIsInstance<T>()`)
  statt `filter` selbst zu überladen - vermeidet die Kontravarianz-/Symmetrie-Fragen oben komplett,
  auf Kosten einer zusätzlichen API pro Anwendungsfall.

### Betroffene core-lib-Funktionen, falls umgesetzt

Alle mit `predicate: (value: X index: Y) :> Boolean`-artigem Parameter (Grep 2026-09-15):
`filter`, `findFirst`, `findLast`, `findLastIndex`, `exists`, `all`. `exists`s Prädikat deklariert
abweichend `:> Any` statt `:> Boolean` als Rückgabetyp - für ein `Boolean`-synthetisiertes Prädikat
unproblematisch (kovariant zuweisbar), aber bei der Umsetzung zu beachten.
