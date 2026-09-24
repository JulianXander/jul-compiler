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
