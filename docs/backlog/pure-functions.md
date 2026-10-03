# Pure Functions

## Stand

Drei geschriebene Purity-Pfeile (`->` unbedingt rein, `~>` unrein, `:>` unbestimmt, kontextabhängig
aufgelöst) im Parser, dazu am Typ ein vierter, nicht schreibbarer Zustand `pureIfArgsPure` (rein,
sofern die übergebenen Funktionsargumente rein sind). Die Purity eines Funktionsliterals wird aus
seinem Rumpf inferiert, nicht nur aus dem geschriebenen Pfeil übernommen; `->` ist dabei eine
Zusicherung, gegen den inferierten Rumpf geprüft, `:>`/kein Pfeil übernimmt das Inferenzergebnis.
Die Argument-Regel für Funktionen höherer Ordnung (`getCallPurityInfo`: ein Aufruf einer
`pureIfArgsPure`-Funktion ist rein, wenn jedes Funktionsargument seinerseits beweisbar rein ist)
hängt am vierten Zustand, nicht an `->` selbst — `->` heißt durchgehend „unbedingt rein, egal was
übergeben wird" und ignoriert die Argumente. `typeToString` zeigt den geschriebenen bzw.
abgeleiteten Pfeil.

Ein Rumpf, der nur deshalb unentscheidbar ist, weil er einen eigenen funktionswertigen Parameter
aufruft, wird nicht als `unknown` eingestuft, sondern als `pureIfArgsPure` — Nutzer-HOFs können
damit rein werden, sofern sie tatsächlich nur eigene Parameter aufrufen. Fixpunkt-Iteration braucht
die Inferenz nicht: gegenseitige Rekursion gibt es außerhalb der core-lib nicht (Vorwärtsreferenzen
sind `JUL3202`), und für direkte Selbstrekursion genügt eine optimistische Annahme in einem
Durchlauf.

Funktionen aus `.ts`/`.js` gelten als `impure`. Ihr Rumpf ist ein Dummy, eine Inferenz ist also
nicht möglich. Der Default entspricht deshalb einem geschriebenen `~>`: TS-Code in diesem Projekt
ist überwiegend DOM- oder IO-Anbindung. Mit `@pure` im JSDoc wird eine TS-Funktion `pure`, ohne
Prüfung. Kann ein Parameter eine Funktion aufnehmen, wird sie stattdessen `pureIfArgsPure`. Das
entscheidet dieselbe Regel wie beim übergebenen Argument (`getArgumentPurity`), Any und Listen
zählen dabei als möglicher Callback. Callback-Typen in der Signatur bleiben `unknown`. Die Folge:
Ein `->` über einem TS-Aufruf ohne `@pure` meldet `JUL5101`, statt die Zusicherung still zu glauben.
Und eine TS-Funktion ohne `@pure` wird als Prädikat in Typ-Position abgelehnt. Gefaltet wird
TS-Code auch mit `@pure` nicht.

Darauf aufbauend ist Constant Folding umgesetzt und verdrahtet: `tryFoldCall` im
[Checker](../src/checker/checker.ts) und die Übersetzung zwischen Typ und Wert in
[constant-folding.ts](../src/checker/constant-folding.ts), getestet in `constant-folding.test.ts`
und im `constant folding`-Block von `checker.test.ts`. Gefaltet wird, wenn das Ergebnis Skalare
**und** Kollektionen aus Literaltypen sind. Gefaltet werden nicht nur core-lib-`nativeFunction`s,
sondern auch Nutzerfunktionen: `tryBuildCallable` emittiert das Funktionsliteral über
`functionLiteralToEvaluableJs` ([emitter.ts](../src/emitter.ts)) und führt es aus. Dagegen steht ein
globales Budget pro Check-Lauf (`resetFoldBudget`), das ein erschöpftes Budget still in „nicht
gefaltet" übersetzt, ohne Diagnose.

Bewusst nicht enthalten: **keine Durchsetzung von Purity in der Zuweisbarkeit** — `pure` ist Anzeige
und Faltungsbedingung, keine Anforderung, die einen Aufruf ablehnen könnte.

## Offen

### Hostunabhängigkeit als zweites Faltungskriterium

„Hostabhängig zählt als impure" ist als Regel entschieden, aber ohne aktive Prüfung im Code — bisher
nur an zwei Funktionen einzeln nachgemessen (`regex`: nicht hostabhängig; `addDate`: hostabhängig,
aber ohne Datums-Literal unerreichbar).
Nicht durchgesehen: alles andere Datums- und Zahlformatierende (`toIsoDateText` u. Ä.), das an
Zeitzone, ICU-Daten oder Node-Version der Build-Maschine hängen könnte.

### Eigener Parameter in verschachteltem Literal und Branching

Idee, keine Entscheidung. Eine HOF, die ihren funktionswertigen Parameter nicht direkt, sondern in
einem Branching-Zweig aufruft, wird `unknown` statt `pureIfArgsPure` und deshalb nie gefaltet, auch
nicht mit reinem Callback:

```jul
aggregateRecursive = (values: List(Any) init fn: (acc val i) :> Any index curr) =>
	?(index)
		[values.length().add(1)] => curr
		() =>
			prev = aggregateRecursive(values init fn index.add(1) curr)
			fn(prev values.getElement(index) index)
```

Zwei Stellen in `inferBodyPurity` verlieren die Information, dass `fn` ein eigener Parameter der
äußeren Funktion ist:

- Der Zweig `() => …` ist ein eigenes Literal. Für es ist `fn` ein fremder Parameter (E2), seine
  Purity ist `unknown`. Das Branching trägt sie mit `fromOwnParameterCall = false` bei, also bleibt
  `unknownOnlyFromOwnParameterCalls` nicht erhalten.
- Ein Zweig mit `pureIfArgsPure` zählt im Branching als `unknown`, weil unbekannt ist, mit welchen
  Argumenten der getroffene Zweig gerufen wird.

Denkbar: Aufrufe fremder Parameter eines *unmittelbar* umschließenden Literals beim Aufstieg als
Aufrufe eigener Parameter der äußeren Funktion werten. Zu klären ist, ob E2 absichtlich so streng
ist und was ein Callback bedeutet, der erst in einer weiteren Verschachtelung gerufen wird.

Roter Test dazu: Funktion mit Parameter `fn`, Branching-Zweig ruft `fn`, Aufruf mit reinem `fn`
und konstanten Argumenten soll einen gefalteten Typ liefern. Beispiel:
`jul-examples/core-lib/aggregate`.

## Ausblick: gefaltetes Ergebnis auch emittieren

Vorgemerkt: statt den Aufruf zu emittieren, die gefaltete Konstante einsetzen — `addInteger(2 3)`
würde zu `5n` statt zu `addInteger(2n, 3n)`.

**Der Gewinn wäre echt**, weil ihn heute niemand sonst einsammelt: webpack läuft mit
`minimize: false` ([compiler.ts:60](../src/compiler.ts#L60)), und ein JS-Minifier könnte einen
Aufruf in die Runtime ohnehin nicht wegrechnen.

**Drei Dinge müssten vorher geklärt sein**, und alle drei sind der Grund, warum es nicht Teil der
bisherigen Umsetzung ist:

- **Ein neuer Kanal vom Checker zum Emitter.** Der Emitter liest heute **kein** `typeInfo` — er
  arbeitet ausschließlich auf dem Parse-Baum. Der gefaltete Wert müsste ihn also erst erreichen,
  entweder über eine Annotation am Knoten oder indem der Emitter anfängt, geprüfte Typen zu lesen.
  Das ist eine Architekturänderung, keine Ergänzung.
- **Hostunabhängigkeit wird von einer Soll- zu einer Muss-Bedingung.** Solange nur der Typ betroffen
  ist, ist eine Abweichung zwischen Faltung und Laufzeit eine Ungenauigkeit. Sobald der Wert
  emittiert wird, ist sie eine Verhaltensänderung — und Zeitzone, ICU-Daten und Node-Version der
  Build-Maschine landen im Programm.
- **Die CLI bricht bei Parse-Fehlern ab, der Language Server nicht.** Gefaltet wird in beiden; nur
  einer emittiert. Es muss festliegen, dass eine Faltung, die im Language Server auf einem
  unvollständigen Baum passiert, nie in emittierten Code gerät.

## Ausblick: echte Durchsetzung

Bisher entschieden gegen Durchsetzung: Constant Folding braucht nur eine Auskunft „beweisbar pure
ja/nein", keine Zurückweisung nicht-pure Argumente. Denkbare spätere Konsumenten, für die eine echte
`->`-Anforderung einen Mehrwert hätte, der über Auskunft hinausgeht:

- **Ein künftiges `memoize`**: Caching ist falsch, wenn die gecachte Funktion nicht bei gleichen
  Argumenten immer dasselbe liefert — hier wäre Durchsetzung, nicht nur Anzeige, der Punkt.
- **Prädikate in Typ-Position**: entschieden 2026-09-25, ein Prädikat als Typ muss rein sein.
  Identität und Folding gelten sonst nicht.
- **Vergleichsfunktionen bei Sortierung**: eine unreine Compare-Funktion kann eine in sich
  widersprüchliche Ordnung liefern und damit die Algorithmus-Invariante brechen, nicht nur das
  Ergebnis überraschen.
- **`getKey`/`getValue` bei Gruppierung/Dictionary-Aufbau**: das Ergebnis ist nur wohldefiniert, wenn
  gleiche Eingaben immer derselben Zuordnung entsprechen.
- **`predicate` bei Funktionen mit Kurzschluss-Semantik** (`some`, `every`, `find`): wie oft und in
  welcher Reihenfolge das Prädikat aufgerufen wird, ist Implementierungsdetail — ein unreines
  Prädikat macht beobachtbares Verhalten von genau diesem Detail abhängig.
- **Künftige Parallelisierung von `map`/`filter`**: Reihenfolge-/Zeitpunkt-Unabhängigkeit der
  Callbacks wäre Voraussetzung für Korrektheit bei nebenläufiger Ausführung.

Erst mit Durchsetzung würde auch ein Purity-Polymorphismus in der Signatur (Koka-artig) nötig.

**Ausdrücklicher Gegeneinwand, der vor einer Einführung berücksichtigt werden muss:** eine `->`-Pflicht
an diesen Positionen verbietet auch das gängige Debugging-Pattern, testweise `log` in `predicate`,
`getKey` oder eine Vergleichsfunktion einzusetzen. Eine pauschale Durchsetzung an all diesen Stellen
hätte also einen realen Ergonomie-Preis. Falls Durchsetzung je verfolgt wird, eher gezielt/opt-in an
einzelnen, sorgfältig ausgewählten Stellen (z. B. nur `memoize`) statt als allgemeine Regel für alle
Callback-Parameter.
