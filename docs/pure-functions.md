# Pure Functions: erste Ausbaustufe (core-lib-only, ohne Inferenz)

## Stand

Umgesetzt: Purity-Pfeile (`->` rein, `~>` unrein, `:>` keine Aussage) im Parser und im Typ
(`Purity`-Enum an `CompileTimeFunctionType`), die Argument-Regel für Funktionen höherer Ordnung
(`getCallPurity`: ein Aufruf ist beweisbar rein, wenn die aufgerufene Funktion `->` trägt und jedes
Funktionsargument seinerseits beweisbar rein ist), `typeToString` zeigt den Pfeil.

Darauf aufbauend ist Constant Folding vollständig umgesetzt und verdrahtet — siehe
[constant-folding-umsetzung.md](constant-folding-umsetzung.md) für Entscheidungen, Umsetzung und
Tests. Dort ist auch entschieden, dass gefaltet wird, wenn das Ergebnis Skalare **und** Kollektionen
aus Literaltypen sind (nicht nur Skalare, wie ursprünglich hier für Stufe 1 vorgesehen).

Scope dieser beiden Ausbaustufen zusammen, bewusst nicht enthalten:

- Keine Purity-**Inferenz** aus dem Rumpf einer `functionLiteral` — der Pfeil ist eine ungeprüfte
  Zusicherung, nicht gegen den Rumpf geprüft; ohne Pfeil bleibt der Typ `'unknown'`.
- Keine Faltung von Aufrufen an Nutzerfunktionen, nur an core-lib-`nativeFunction`s.
- Keine Durchsetzung von Purity in der Zuweisbarkeit — `pure` ist Anzeige und Faltungsbedingung,
  keine Anforderung, die einen Aufruf ablehnen könnte.

## Offen

### Hostunabhängigkeit als zweites Faltungskriterium

„Hostabhängig zählt als impure" ist als Regel entschieden, aber ohne aktive Prüfung im Code — bisher
nur an zwei Funktionen einzeln nachgemessen (`regex`: nicht hostabhängig; `addDate`: hostabhängig,
aber ohne Datums-Literal unerreichbar, siehe
[constant-folding-umsetzung.md, „Vorgemerkt"](constant-folding-umsetzung.md#vorgemerkt-nicht-teil-dieser-stufe)).
Nicht durchgesehen: alles andere Datums- und Zahlformatierende (`toIsoDateText` u. Ä.), das an
Zeitzone, ICU-Daten oder Node-Version der Build-Maschine hängen könnte.

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

## Ausblick: Ausbaustufe „Pure Inference"

Vorgemerkt, nicht Teil der bisherigen Umsetzung: Purity automatisch aus dem Aufrufgraph ableiten
statt nur manuell an der `nativeFunction`-Grenze zu deklarieren — eine `functionLiteral` wäre dann
pure, wenn alle aufgerufenen Funktionen pure sind und kein Stream gelesen/geschrieben wird
(Fixpunkt-Iteration für Rekursion). Löst die Hartkodierung bei `functionLiteral` und prüft die
Zusicherungen, die die Argument-Regel heute ungeprüft übernimmt. Der Schritt-/Aufrufzähler aus der
Faltung wird dort notwendig statt nur vorsorglich, weil dann auch rekursiver Nutzercode zur
Compile-Zeit ausgeführt werden könnte.

Funktionen höherer Ordnung sind dort **kein** eigenes Thema mehr: die Argument-Regel gilt unverändert
weiter und liefert von selbst bessere Ergebnisse, sobald die Inferenz die Purity gewöhnlicher
Nutzerfunktionen kennt. Sie setzt an keiner Stelle voraus, *warum* ein Argument rein ist. Ein
Purity-Polymorphismus in der Signatur (Koka-artig) wäre erst nötig, wenn Purity durchgesetzt wird —
siehe den nächsten Ausblick.

### Ausblick: echte Durchsetzung (Frage 4 = 4B)

Bisher entschieden gegen Durchsetzung: Constant Folding braucht nur eine Auskunft „beweisbar pure
ja/nein", keine Zurückweisung nicht-pure Argumente. Denkbare spätere Konsumenten, für die eine echte
`->`-Anforderung einen Mehrwert hätte, der über Auskunft hinausgeht:

- **Ein künftiges `memoize`**: Caching ist falsch, wenn die gecachte Funktion nicht bei gleichen
  Argumenten immer dasselbe liefert — hier wäre Durchsetzung, nicht nur Anzeige, der Punkt.
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

**Ausdrücklicher Gegeneinwand, der vor einer Einführung berücksichtigt werden muss:** eine `->`-Pflicht
an diesen Positionen verbietet auch das gängige Debugging-Pattern, testweise `log` in `predicate`,
`getKey` oder eine Vergleichsfunktion einzusetzen. Eine pauschale Durchsetzung an all diesen Stellen
hätte also einen realen Ergonomie-Preis. Falls Durchsetzung je verfolgt wird, eher gezielt/opt-in an
einzelnen, sorgfältig ausgewählten Stellen (z. B. nur `memoize`) statt als allgemeine Regel für alle
Callback-Parameter.
