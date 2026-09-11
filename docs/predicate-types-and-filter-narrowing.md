# Prädikate als Typen: warum `filter` nicht verengt, und was das käme

Fund in yugioh (Session 2026-09-10): `allGameCardIds.filter((gameCardId) => ?(gameCardId)
[Integer] => ... () => false)` verengt `List(Or(Integer Empty))` nicht auf `List(Integer)`,
obwohl das Prädikat es beweist. Kein Bug in JUL oder im yugioh-Code (siehe
[error-message-elaboration.md](error-message-elaboration.md), Abschnitt zum `filter`-Rückgabetyp-
Fix) - eine echte Grenze der Sprache. Dieses Dokument hält die Untersuchung fest, warum das so
ist, wie andere Sprachen damit umgehen, und was ein JUL-eigener Lösungsweg bräuchte. Kein Plan
zur Umsetzung - eine Bestandsaufnahme für eine spätere Entscheidung.

## Die Frage: sind Prädikate nicht sowieso schon Typen?

Naheliegender Einwand: JUL behandelt Typen zur Laufzeit bereits wie Prädikate. `getTypeError` in
runtime.ts hat einen eigenen Fall dafür:

```typescript
case 'function':
	if (type(value)) {
		return undefined;
	}
	break;
```

Ein "Typ" kann zur Laufzeit buchstäblich eine JS-Funktion sein, die aufgerufen wird. Genau so
sind `List`, `And`, `Or` in core-lib.jul selbst implementiert - `nativeFunction`, deren JS-Rumpf
ein Prädikat ist (`x => Array.isArray(x) && x.every(...)`). Die Dualität "Typ = Prädikat" ist
also keine Hypothese, sondern bereits der Mechanismus, mit dem JULs eigene eingebauten Typen
funktionieren. Mengentheoretisch ist das ohnehin exakt dasselbe: ein Typ *ist* die Menge der
Werte, für die ein Prädikat `true` liefert - keine Interpretation, sondern die Definition.

**Trotzdem lässt sich das nicht automatisch generalisieren - nicht aus semantischen, sondern aus
Entscheidbarkeitsgründen.** Die Gleichung "Typ = Prädikat" stimmt immer. Die Frage ist nicht, ob
ein Boolean-Callback ein Typ *ist*, sondern ob der Checker, **ohne das Callback auszuführen**,
herausfinden kann, für welche Werte es `true` liefert. Ein Prädikat wie
`getActivationRequirementsMet(...)` ist beliebiger, Turing-vollständiger JUL-Code - nach dem Satz
von Rice ist jede nicht-triviale semantische Eigenschaft eines solchen Programms im Allgemeinen
nicht algorithmisch entscheidbar, ganz unabhängig von JULs konkreter Implementierung. Genau
deshalb bestehen JULs eigentliche (statische) Typen bewusst aus einer geschlossenen,
rein strukturellen Algebra (`CompileTimeType`-Tags wie `'integer'`, `'or'`, ...) statt aus
beliebigem Code - der Checker vergleicht Tags, er führt nie etwas aus, und terminiert deshalb
immer. Ein beliebiges Boolean-Callback ist aber ausführbarer Code, kein Tag, und fällt damit aus
dieser entscheidbaren Welt heraus. Das ist keine JUL-spezifische Lücke, sondern dieselbe Wand,
vor der jedes Typsystem mit Turing-vollständigen Prädikaten steht (s.u., Liquid Haskell/F*/Dafny
lösen das nur durch eine bewusst eingeschränkte, SMT-prüfbare Prädikatssprache, nie durch
beliebige Prädikate).

**Das löst das `filter`-Problem trotzdem nicht.** Der Grund: das ist die **Laufzeit**-Ebene
(`RuntimeType`, ausgewertete JS-Werte). Der **statische** Checker arbeitet auf einer komplett
anderen, rein symbolischen Repräsentation (`CompileTimeType` in checker.ts - eine getaggte Union
aus `julType`-Strings wie `'integer'`, `'or'`, `'dictionaryLiteral'`). Der Checker **führt nichts
aus** - er vergleicht Tags und Felder. Er kann ein beliebiges JUL-Prädikat nicht einfach "aufrufen
und schauen, was rauskommt", weil er zur Prüfzeit keinen konkreten Wert hat, auf den er das
Prädikat anwenden könnte (der Parameter eines Callbacks ist symbolisch, nicht konkret) - und
selbst wenn er einen Interpreter hätte (siehe TODO "infer pure function call return type"), gilt
das nur für **konkrete** Werte, nicht für einen abstrakten "irgendein Wert vom Typ Or(Integer
Empty)".

## Wie andere Sprachen das lösen

- **TypeScript/Flow**: `x is T` als eigene Rückgabetyp-Form einer Funktion. Wird an der
  Funktionssignatur **behauptet**, nicht gegen den Rumpf **geprüft** - schreiben Sie
  `function isInteger(x): x is number { return Math.random() > 0.5; }`, kompiliert das
  fehlerfrei und verengt trotzdem überall falsch. Dieselbe Vertrauensgrenze wie `assume()` in
  JUL, nur an der Signatur statt am Aufruf platziert.
- **Typed Racket**: der akademische Ursprung des ganzen Konzepts - *Occurrence Typing*
  (Tobin-Hochstadt & Felleisen, POPL 2010, "Logical Types for Untyped Languages"). Jeder
  Funktionstyp trägt eine **logische Formel** ("latenter Filter"), die beschreibt, was ein
  `true`/`false`-Ergebnis über das Argument aussagt, inklusive Kombination mehrerer Prädikate
  über `and`/`or`/`not`. TypeScripts Control-Flow-Narrowing ist davon direkt inspiriert. Für
  eingebaute Prädikate (`number?`, `pair?`) ist die Formel eingebaut, für eigene Funktionen
  muss sie wie bei TS annotiert werden - auch hier keine automatische Herleitung aus dem Rumpf.
- **TypeScript 5.5 (2024), "inferred type predicates"**: der bisher einzige bekannte,
  produktiv eingesetzte Mechanismus, der eine Verengung **automatisch aus dem Funktionsrumpf
  ableitet**, ohne `x is T`-Annotation - erkennt gezielt einfache, entscheidbare Muster
  (`typeof`, `instanceof`, `!= null`, kurze Boolean-Ausdrücke). Strukturell genau das Prinzip
  aus dem Mittelweg oben, nur mit anderem Mustervokabular (JS-Operatoren statt Branching, weil
  TS kein `?(...)` hat). Der naheliegendste Referenzpunkt, falls der Mittelweg umgesetzt wird -
  ein strukturell arbeitender Type-Checker ohne SMT-Solver, keine Forschungssprache.
- **Kotlin**: kein allgemeines Feature. `filterIsInstance<T>()` ist ein Compiler-Intrinsic nur
  für den exakten Is-Instance-Fall, nicht auf beliebige Prädikate generalisierbar.
- **Scala**: `.collect { case x: Foo => ... }` - die Verengung kommt aus dem Pattern-Match, der
  einen **Wert** zurückgibt, nie aus einem geprüften Boolean.
- **Rust/Haskell**: `filter`/`filter` verengt nie. `filter_map`/`mapMaybe` lösen den Fall, indem
  der Callback direkt den (optionalen) Zielwert zurückgibt statt eines Booleans - JULs
  `filterMap` folgt genau diesem Muster und funktioniert schon korrekt.
- **Liquid Haskell**: fügt Refinement Types einer bestehenden, verbreiteten Sprache (Haskell)
  hinzu, SMT-Solver (Z3), am zugänglichsten dokumentiert von den SMT-basierten Systemen.
- **F\***: volle Refinement-/Dependent-Types, SMT-gestützt, Forschungssprache (Microsoft
  Research, u.a. verifiziertes TLS in Project Everest).
- **Dafny**: Verifikationssprache mit Vor-/Nachbedingungen, ebenfalls SMT (Boogie+Z3).
- **Idris**: volle abhängige Typen, aber **manuelle** Beweisterme statt automatischer
  SMT-Entscheidung (Curry-Howard-Stil) - der andere Pol: mehr Ausdruckskraft, aber keine
  Automatik.

Diese vier sind der einzige Weg zu "wirklich beliebige Prädikate als Typen" - aber mit einem
SMT-Solver (oder manuellen Beweistermen bei Idris) als Kernkomponente, eine andere
Größenordnung an Infrastruktur als JULs struktureller Checker.

Nur diese Kategorie beantwortet die Frage des Titels wirklich mit "ja, generell" - um den
Preis eines SMT-Solvers und einer entsprechend eingeschränkten, formalisierten Prädikatsprache.
Das steht außer Verhältnis zu JULs aktuellem Umfang.

### Empfehlung als Vorbild, falls der Mittelweg verfolgt wird

**TypeScript 5.5** für die Umsetzung selbst - der einzige bekannte, produktiv eingesetzte
Mechanismus, der automatisch (nicht per Annotation) aus einem begrenzten, erkennbaren
Rumpf-Muster ableitet, ohne SMT-Solver - strukturell am nächsten an JULs Checker. **Typed
Racket** als konzeptionelle Grundlage, falls die Formel-Kombination (and/or/not mehrerer
Prädikate) später generalisiert werden soll, da es die "Fakten-Logik"-Idee am saubersten
formalisiert. Die SMT-basierten Systeme (Liquid Haskell/F*/Dafny/Idris) sind Referenzen zur
Einordnung des Aufwands, nicht als Vorbild für JULs Umfang gedacht.

## Ein JUL-eigener Mittelweg (nicht umgesetzt, nur skizziert)

Statt beliebige Prädikate zu verifizieren, ließe sich eine **eng begrenzte, aber geprüfte**
(nicht behauptete) Form ableiten - aus einer Beobachtung, die schon vorhandene Infrastruktur
nutzt: Innerhalb von `?(param) [Integer] => ...` ist `param` durch das bestehende
Branch-Narrowing bereits korrekt auf `Integer` verengt (das ist bereits geprüfter, existierender
Code, keine neue Analyse). Fehlt nur die Weitergabe dieser Information über die Rückgabe eines
Boolean-Callbacks hinweg.

Skizze: Bei einer Funktion mit Rückgabetyp `Boolean`, deren gesamter Rumpf ein
`?(param)`-Branching ist, für jeden Branch prüfen: *kann dieser Branch überhaupt `true`
liefern?* Bei `() => false` ist das syntaktisch entscheidbar (liefert nachweislich immer
`false`). Liefert nur ein Teil der Branches potenziell `true`, folgt daraus **korrekt und
geprüft** (nicht behauptet): `predicate(x) == true ⟹ x hatte einen der Parametertypen dieser
Branches`.

Das wäre kein Sonderfall für `filter` - eine neue, allgemeine Eigenschaft von Funktionstypen
(vergleichbar mit dem bereits referenzierbaren `callback/ReturnType` in `map`/`filterMap`),
nutzbar von jeder Funktion, die eine solche Callback-Funktion entgegennimmt (`filter`,
`findFirst`, `findLast`, `exists`, `all`).

### Zweite Konsumstelle derselben Metadaten: Prädikate in Typ-Position

Weil die abgeleitete Verengung am Funktionstyp selbst hängt (nicht an `filter`s Signatur), wäre
sie nicht auf Callback-nehmende Funktionen beschränkt. Ein Branch ist selbst eine Funktion und
matcht über seinen **Parametertyp**; Typen stehen dort als normale Werte (`[Integer]`, `Any`,
`NonZeroInteger`, ...). Ein Prädikat gehört also nicht anstelle des Kopfes hin, sondern in
dessen Typ-Position - heute nicht wirkungslos, sondern **falsch**: der Checker schneidet den
gebranchten Typ mit dem Funktionstyp und kommt auf `Never`, erklärt den branch also für
unerreichbar (gemessen 2026-09-11, `JUL5050: Can not assign Never to Integer`). Die Laufzeit
matcht denselben Code korrekt: `_branch` prüft über `getTypeError`, und dort wird ein
Funktionswert in Typ-Position **aufgerufen** (runtime.ts, `case 'function'`). Der Falschbefund
trifft lauffähigen Code:

```jul
isInteger = (x: Any) :> Boolean =>
	?(x)
		[Integer] => true
		() => false

?(someValue)
	[isInteger] => ...   # narrowt someValue heute auf Never statt auf Integer
```

Mit den `narrowsTo`-Metadaten am Funktionstyp bräuchte die Branch-Verengung nur eine zusätzliche
Regel: "trägt der Parametertyp `narrowsTo`-Metadaten, verenge auf diesen Typ" - zusätzlich zur
bestehenden Regel "ist es ein `Type`-Wert, matche direkt dagegen". Derselbe abgeleitete Fakt
schließt also zwei Lücken (`filter`-Narrowing und Prädikate in Typ-Position), nicht nur eine -
mit dem Callback-Analyseschritt (Punkt 1 unten) als gemeinsamer Grundlage. Dieselbe Grenze gilt
an beiden Stellen: nur Prädikate mit exakt der erkennbaren Branching-Form bekommen `narrowsTo` -
ein Prädikat wie `getActivationRequirementsMet(...)`, das beliebige Berechnungen anstellt, bliebe
an keiner der beiden Stellen verengend, unabhängig davon, wie der Mechanismus gebaut wird.

### Reihenfolge: Branching zuerst, `filter` danach

Beide Konsumstellen teilen sich Punkt 1 und 2. Wird zuerst das Branching bedient, endet der
erste Schritt nach Punkt 3 - die neue Typ-Position und die core-lib-Signaturen (Punkt 4 und 5)
entfallen, solange nur das Branching narrowt. Das ist der kleinere und der rückbaubarere Schnitt: der
abgeleitete Fakt bleibt checker-intern, es kommt kein neues Vokabular in `core-lib.jul` und
keine neue Schreibweise in die Sprachoberfläche. Erweist sich die Herleitungs-Heuristik als zu
eng oder falsch, ist nichts zurückzunehmen, das Nutzer schon geschrieben haben.

Dazu kommt, dass Verengung am Branching ohnehin schon existiert (Testregion "branching:
Verengung" in checker.test.ts): der neue Fakt wird in derselben Tabelle geprüft, statt über eine
neue Typ-Position hinweg. Und die Konstruktion ist selbstbezüglich - die Analyse liest ein
Branching und speist ihr Ergebnis wieder in ein Branching ein. Trägt die Regel dort nicht, trägt
sie bei `filter` erst recht nicht.

Der Preis: der auslösende Fund (yugioh, `filter`) bleibt zunächst offen, und Schritt eins liefert
ein Feature, für das es bisher keinen Fund gibt. Deshalb ist das keine Begründung, jetzt
anzufangen - nur die Reihenfolge, falls angefangen wird.

**Aufwand, ehrlich eingeschätzt:**

1. Neue Analyse bei der Typinferenz von Funktionsliteralen: erkennen, ob der Rumpf exakt ein
   `?(param)`-Branching ist, und je Branch entscheiden "kann `true` herauskommen" - bewusst
   **begrenzte** Heuristik (Literal-Erkennung), kein allgemeiner Beweiser, im selben Sinne wie
   die bereits vorhandene, bewusst limitierte `isBranchingExhaustive`-Heuristik.
2. Neues Feld am Funktionstyp (`CompileTimeType` für `'function'`), das diese abgeleitete
   Verengung trägt.
3. Erste Konsumstelle: Branch-Verengung um die `narrowsTo`-Regel erweitern, damit Prädikate in
   Typ-Position narrowen. Bis hierher ohne Änderung an core-lib oder Sprachoberfläche.
4. Zweite Konsumstelle, danach: neue Typ-Position, um auf `narrowsTo` zuzugreifen (analog zu
   `callback/ReturnType`).
5. Dazu die Signaturen mehrerer core-lib-Funktionen (`filter`, `findFirst`, `findLast`,
   `exists`, `all`), nicht nur `filter`.

### Bewusst nicht in Schritt 1

Schritt 1 (roter Test `branch-narrowing-predicate-head` in checker.test.ts) macht ausschließlich
die true-Richtung am Typ-Kopf. Alles Folgende ist erkannt und verschoben, nicht vergessen:

1. **Gegenrichtung für den false-Zweig.** `narrowsTo` sagt nur `predicate(x) == true ⟹ x ∈ T`.
   Spätere branches wissen aber nur, dass `false` herauskam, und `false ⟹ x ∉ T` folgt daraus
   nicht:

   ```jul
   isBigInteger = (x: Any) :> Boolean =>
   	?(x)
   		[0] => false
   		[Integer] => true
   		() => false
   ```

   `narrowsTo` ist `Integer`, aber `isBigInteger(0)` ist `false` - `Integer` im false-Zweig
   abzuziehen würde `0` fälschlich entfernen. Die Umkehrung bräuchte eine **zweite** Menge:
   branches, deren Rumpf literal `true` ist, abzüglich dessen, was frühere branches abfangen.
   Daraus folgt eine Umsetzungsauflage für Schritt 1: die Prädikat-Regel darf nicht in
   `getBranchArgumentType` stehen, weil `getPreviousBranchArgumentType` dieselbe Funktion
   aufruft und den Abzug damit stillschweigend auf die Obermenge stützen würde.
2. **Prädikat als `Type`-Wert.** In Parameterposition (`(y: isInteger) => ...`) meldet der
   Checker zusätzlich `JUL5002: Can not assign (x: Any) :> Or(true false) to Type` - ein
   TypeGuard muss ein `Type`-Wert sein. Der Typ-Kopf löst diese Prüfung nicht aus, deshalb
   kommt Schritt 1 ohne sie aus. Die dahinterliegende Sprachfrage steht in core-lib.jul seit
   jeher auskommentiert: `# Type = Any :> Boolean`. Sie zu bejahen hieße, `getTypeError`
   case `'function'` umzubauen (dort steht `// TODO types als function interpretieren?`) und
   damit Parametertypen, Feldtypen und Rückgabetypen gleichzeitig zu betreffen - eigene
   Entscheidung mit eigenem Dokument.
3. **Weitere Rumpfformen.** Schritt 1 erkennt nur: ein Parameter, Rumpf genau ein
   `?(param)`-Branching, jeder branch mit Boolean-**Literal** als Rumpf. Nicht-literale Rümpfe
   dürfen später konservativ zu `narrowsTo` zählen (das vergrößert die Obermenge, bleibt also
   sound); mehrere Parameter, Prädikate aus Aufrufen oder Referenzketten sind offen.
   Die Erkennung darf **nicht** am deklarierten Rückgabetyp hängen: gemessen trägt der
   Funktionstyp `Or(true false)`, obwohl `:> Boolean` dasteht (`createNormalizedUnionType`
   kollabiert Literale nicht).
4. **Die Callback-Konsumstelle** (`filter`, `findFirst`, `findLast`, `exists`, `all`) mit
   Punkt 4 und 5 der Liste oben - der auslösende yugioh-Fall.

## Fazit

- Die Laufzeit-Dualität "Typ = Prädikat" existiert in JUL bereits, löst das Problem aber nicht,
  weil der statische Checker auf einer anderen, rein symbolischen Ebene arbeitet.
- Vollständig generelle Prädikate-als-Typen sind Refinement-Types-Territorium (SMT-Solver) -
  außer Verhältnis zum aktuellen Sprachumfang.
- Ein enger, geprüfter Mittelweg (Branch-Narrowing über Boolean-Rückgaben hinweg tragen) wäre
  machbar und baut auf vorhandener Infrastruktur auf, ist aber ein eigenständiges Feature mit
  spürbarem Umfang (neues Typfeld, neue Typ-Position, mehrere betroffene core-lib-Funktionen).
- Falls er verfolgt wird, beginnt er am Branching, nicht an `filter`: dieselbe Grundlage, aber
  ohne neue Typ-Position und ohne core-lib-Änderung, also rückbaubar.
- Für den akuten yugioh-Fall reicht `assume(...)` an der einen betroffenen Aufrufstelle - siehe
  Antwort in der Session, kein Sprachfeature nötig.

Nicht geplant, keine rote Tests - eigenständige Design-Entscheidung, falls ein weiterer Fund das
rechtfertigt.
