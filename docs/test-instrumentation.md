# Idee: Zwischenwerte fehlgeschlagener Tests anzeigen

Reine Ideensammlung, keine Entscheidung getroffen.

## Ausgangslage

Der Emitter schreibt im Rumpf eines Test-Callbacks nur den **äußersten** Aufruf um, als
`_testCall('equal', equal, [args])`, und das nur bei positionellen Argumenten
([emitter.ts](../src/emitter.ts), `testCallToInstrumentedJs`; [testing.md](testing.md)). Bei

```jul
test(§die ersten beiden Zahlen sind 1§ () => and(equal(fibonacci(1) 1) equal(fibonacci(2) 1)))
```

meldet der Lauf nur `and(true false) returned false`. Welcher `fibonacci`-Aufruf falsch war, sieht
man nicht.

Den häufigsten Anlass für einen Debugger (welcher Zwischenwert in dieser Berechnung ist falsch?)
kann der Reporter selbst beantworten, ohne Klicken und ohne Werkzeugwechsel. Vorbilder: power-assert
(JS), Power Assertions in Groovy/Spock, `assert` in Elixir. Breakpoints ersetzt das nicht, sie
bleiben der Rückfall, wenn die angezeigten Werte nicht reichen ([source-maps.md](source-maps.md)).

## Idee

Nicht Aufrufe umschreiben, sondern Werte mitschreiben. Jeder Teilausdruck im Testrumpf wird zu
`_v(id, <unverändertes JS>)`. `_v` legt den Wert unter `id` ab und gibt ihn unverändert zurück. Zur
`id` bettet der Emitter den Quelltext-Ausschnitt als String ein, die Positionen samt Ende hat jeder
Knoten. Schlägt der Test fehl, zeigt der Reporter den Baum:

```
✗ die ersten beiden Zahlen sind 1 (fibonacci.test.jul:4:1)
    and(equal(fibonacci(1) 1) equal(fibonacci(2) 1))  →  false
      equal(fibonacci(1) 1)  →  true
        fibonacci(1)         →  1
      equal(fibonacci(2) 1)  →  false
        fibonacci(2)         →  2
```

- Eingerückte Liste statt des Säulendiagramms von power-assert. Das Diagramm zerfällt bei
  mehrzeiligen Tests und langen Werten.
- Literale weglassen, Referenzen zeigen.
- Ersetzt `_testCall`. Benannte Argumente, heute ausgenommen, gehen automatisch mit, weil Werte
  eingefangen werden und keine Aufrufe.
- Auch Definitionen in einem mehrzeiligen Testrumpf werden so erfasst, nicht nur der letzte Ausdruck.

## Probleme und Entschärfung

1. **Der Test führt anderen Code aus als die Produktion.** Der Emitter hat Optimierungen, die an der
   Form eines Ausdrucks hängen: statischer Dispatch bei `?` (`getBranchDispatch`),
   `namedArgumentsToDirectCallJs`, `isTrivialArgument`. Ein `_v(…)` um ein Argument kann diese
   Entscheidungen kippen.
   → Nur den Testrumpf instrumentieren, nie importierten Code, und `_v` erst um das fertig erzeugte
   JS legen, nachdem alle Entscheidungen gefallen sind. Die Funktion unter Test läuft dann
   unverändert. Diese Regel gehört als Kommentar in den Emitter.
2. **Funktionsliterale im Testrumpf.** Bei `map([1 2 3] (value) => fibonacci(value))` läuft der
   Rumpf mehrfach.
   → An der Grenze zum Funktionsliteral aufhören, wie power-assert. Angezeigt wird das Ergebnis von
   `map`. Die Zweige von `?` sind Funktionen und fallen ebenfalls darunter.
3. **Nicht ausgewertete Teilausdrücke** (vorher flog eine Exception) erscheinen als
   `(nicht ausgewertet)`.
4. **Exceptions.** Der Teilausdruck, der begonnen, aber noch keinen Wert geliefert hat, ist der, der
   geworfen hat. `_v` erkennt ihn über einen kleinen Stack der offenen `id`s. Der Reporter zeigt die
   Exception an dieser JUL-Stelle, für Fehler im Testrumpf also schon ohne Source Maps.
5. **Nichts doppelt auswerten.** Manche Werkzeuge werten Teilausdrücke nach einem Fehlschlag erneut
   aus. Das wäre bei Effekten (`log`, Streams, `nativeFunction`) falsch.
   → Nur während des einen Laufs mitschreiben. JUL-Werte sind unveränderlich, die gespeicherte
   Referenz bleibt gültig. Ausnahme sind veränderliche JS-Objekte aus dem Interop, die später
   mutiert werden. Selten, wird hingenommen.
6. **Große Werte.** `valueToString` mit Tiefen- und Längenbegrenzung. Streams als `Stream(…)` mit
   `lastValue`, Funktionen nur mit ihrem Typ. Für `deepEqual` kommt ein Diff dazu (steht im TODO).
7. **Kosten.** Ein Funktionsaufruf und ein Map-Eintrag pro Teilausdruck, pro Test zurückgesetzt.
   Nur in `*.test.jul`, die nie in einen normalen Build kommen. Vernachlässigbar.
8. **Noch ein Modus im Emitter.** Neben `useTypeInfo` und `instrumentedTestCall`; ersetzt aber den
   letzteren. Die Emitter-Tests für `test` ändern sich.

## Dieselbe Anzeige zur Compile-Zeit

Die statische Meldung JUL5200 zeigt heute ebenfalls nur die Argumente des äußersten Aufrufs. Der
Checker hat an jedem Teilausdruck die `TypeInfo`, bei gefalteten Aufrufen ein Literaltyp. Derselbe
Baum ließe sich also auch im Editor ausgeben, ohne dass der Test läuft. Laufzeit und Checker würden
dann gleich berichten.

## Aufwand

Etwa 1–2 Tage für Emitter, `_v` und Reporter in [test-runtime.ts](../src/test-runtime.ts) und Tests,
dazu etwa ein halber Tag für die Compile-Zeit-Variante.
