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
- **Kotlin**: kein allgemeines Feature. `filterIsInstance<T>()` ist ein Compiler-Intrinsic nur
  für den exakten Is-Instance-Fall, nicht auf beliebige Prädikate generalisierbar.
- **Scala**: `.collect { case x: Foo => ... }` - die Verengung kommt aus dem Pattern-Match, der
  einen **Wert** zurückgibt, nie aus einem geprüften Boolean.
- **Rust/Haskell**: `filter`/`filter` verengt nie. `filter_map`/`mapMaybe` lösen den Fall, indem
  der Callback direkt den (optionalen) Zielwert zurückgibt statt eines Booleans - JULs
  `filterMap` folgt genau diesem Muster und funktioniert schon korrekt.
- **Liquid Haskell / F* / Dafny**: die einzigen Systeme, die tatsächlich **beliebige** Prädikate
  als Typen verifizieren (Refinement Types) - und zwar mit einem SMT-Solver, der beweist, dass
  ein Prädikat für eine ganze (oft unendliche) Wertemenge eine Eigenschaft erfüllt. Das ist keine
  Bibliotheksfunktion, sondern eine eigene Typtheorie mit eigenem Beweissystem - mehrjährige
  Forschungsprojekte, kein Feature, das sich nebenbei ergänzen lässt.

Nur die letzte Kategorie beantwortet die Frage des Titels wirklich mit "ja, generell" - um den
Preis eines SMT-Solvers und einer entsprechend eingeschränkten, formalisierten Prädikatsprache.
Das steht außer Verhältnis zu JULs aktuellem Umfang.

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

**Aufwand, ehrlich eingeschätzt:**

1. Neue Analyse bei der Typinferenz von Funktionsliteralen: erkennen, ob der Rumpf exakt ein
   `?(param)`-Branching ist, und je Branch entscheiden "kann `true` herauskommen" - bewusst
   **begrenzte** Heuristik (Literal-Erkennung), kein allgemeiner Beweiser, im selben Sinne wie
   die bereits vorhandene, bewusst limitierte `isBranchingExhaustive`-Heuristik.
2. Neues Feld am Funktionstyp (`CompileTimeType` für `'function'`), das diese abgeleitete
   Verengung trägt.
3. Neue Typ-Position, um darauf zuzugreifen (analog zu `callback/ReturnType`).
4. Betrifft mehrere core-lib-Funktionen (`filter`, `findFirst`, `findLast`, `exists`, `all`),
   nicht nur eine.

## Fazit

- Die Laufzeit-Dualität "Typ = Prädikat" existiert in JUL bereits, löst das Problem aber nicht,
  weil der statische Checker auf einer anderen, rein symbolischen Ebene arbeitet.
- Vollständig generelle Prädikate-als-Typen sind Refinement-Types-Territorium (SMT-Solver) -
  außer Verhältnis zum aktuellen Sprachumfang.
- Ein enger, geprüfter Mittelweg (Branch-Narrowing über Boolean-Rückgaben hinweg tragen) wäre
  machbar und baut auf vorhandener Infrastruktur auf, ist aber ein eigenständiges Feature mit
  spürbarem Umfang (neues Typfeld, neue Typ-Position, mehrere betroffene core-lib-Funktionen).
- Für den akuten yugioh-Fall reicht `assume(...)` an der einen betroffenen Aufrufstelle - siehe
  Antwort in der Session, kein Sprachfeature nötig.

Nicht geplant, keine rote Tests - eigenständige Design-Entscheidung, falls ein weiterer Fund das
rechtfertigt.
