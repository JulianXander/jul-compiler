# Pure Functions: erste Ausbaustufe (core-lib-only, ohne Inferenz)

## Stand

Umgesetzt: drei geschriebene Purity-Pfeile (`->` unbedingt rein, `~>` unrein, `:>` unbestimmt,
kontextabhängig aufgelöst) im Parser, dazu am Typ ein vierter, nicht schreibbarer Zustand
`pureIfArgsPure` (rein, sofern die übergebenen Funktionsargumente rein sind - siehe
[purity-bedingte-reinheit.md](purity-bedingte-reinheit.md)). Die Purity eines Funktionsliterals wird
aus seinem Rumpf inferiert, nicht nur aus dem geschriebenen Pfeil übernommen; `->` ist dabei eine
Zusicherung, gegen den inferierten Rumpf geprüft, `:>`/kein Pfeil übernimmt das Inferenzergebnis.
Die Argument-Regel für Funktionen höherer Ordnung (`getCallPurityInfo`: ein Aufruf einer
`pureIfArgsPure`-Funktion ist rein, wenn jedes Funktionsargument seinerseits beweisbar rein ist)
hängt seit diesem Umbau am vierten Zustand, nicht mehr an `->` selbst - `->` heißt seither
durchgehend „unbedingt rein, egal was übergeben wird" und ignoriert die Argumente. `typeToString`
zeigt den geschriebenen bzw. abgeleiteten Pfeil.

Darauf aufbauend ist Constant Folding vollständig umgesetzt und verdrahtet: `tryFoldCall` im
[Checker](../src/checker/checker.ts) und die Übersetzung zwischen Typ und Wert in
[constant-folding.ts](../src/checker/constant-folding.ts), getestet in `constant-folding.test.ts`
und im `constant folding`-Block von `checker.test.ts`. Gefaltet wird, wenn das Ergebnis Skalare
**und** Kollektionen aus Literaltypen sind (nicht nur Skalare, wie ursprünglich hier für Stufe 1
vorgesehen).

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
aber ohne Datums-Literal unerreichbar).
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

## Nächste Ausbaustufe: „Pure Inference"

Purity aus dem Rumpf ableiten, statt sie nur an der `nativeFunction`-Grenze zu deklarieren.
Entschieden und geplant in [pure-inference-umsetzung.md](pure-inference-umsetzung.md); dort stehen
die Entscheidungen einzeln mit Begründung. Drei Annahmen, die hier zuvor standen, haben sich dabei
als falsch erwiesen:

- **Funktionen höherer Ordnung sind sehr wohl ein eigenes Thema.** Die Argument-Regel löst nur die
  *Aufrufstelle*. Für die Inferenz war offen, was ein Rumpf aussagt, der einen eigenen
  Funktionsparameter benutzt — beantwortet in
  [purity-bedingte-reinheit.md](purity-bedingte-reinheit.md): ein Rumpf, der nur deshalb
  unentscheidbar ist, weil er einen eigenen funktionswertigen Parameter aufruft, wird nicht als
  `unknown` eingestuft, sondern als `pureIfArgsPure` - Nutzer-HOFs können damit rein werden, sofern
  sie tatsächlich nur eigene Parameter aufrufen.
- **Fixpunkt-Iteration ist nicht nötig.** Gegenseitige Rekursion gibt es außerhalb der core-lib
  nicht (Vorwärtsreferenzen sind `JUL4002`), und für direkte Selbstrekursion genügt eine
  optimistische Annahme in einem Durchlauf.
- **Der „Schritt-/Aufrufzähler aus der Faltung" existiert nicht** — `checkerStats.foldableCall` ist
  reine Statistik, `tryFoldCall` hat kein Budget. Gebraucht wird ein Budget erst, wenn Nutzercode
  zur Compile-Zeit ausgeführt wird, und das ist bewusst eine spätere Stufe.

Ein Purity-Polymorphismus in der Signatur (Koka-artig) wäre erst nötig, wenn Purity durchgesetzt
wird — siehe „echte Durchsetzung" unten.

### Ausblick: Nutzerfunktionen zur Compile-Zeit ausführen

Eigene, spätere Ausbaustufe. Erst damit führt Purity über die Anzeige hinaus zu mehr Faltung, denn
für eine Nutzerfunktion liegt kein fertiges JS in `runtime.ts`. Voraussetzungen und ein möglicher
Einstieg über Substitution statt Ausführung stehen im Ausblick von
[pure-inference-umsetzung.md](pure-inference-umsetzung.md).

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
