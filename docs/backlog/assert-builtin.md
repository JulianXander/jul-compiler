# `assert` als Builtin für JUL-Code

Umgesetzt wie unten festgelegt. Offen ist nur noch die Messung der Kosten unter `jul test`, sobald
yugioh die ersten Asserts hat. Nicht zu verwechseln mit [assertions.md](assertions.md), dort geht es
um Prüfungen im TypeScript-Code des Compilers.

## Ausgangslage

JUL-Code kann heute zwei Dinge prüfen:

- **`assume(wert Typ)`** behauptet einen Typ. Im normalen Build ist es die Identität, unter
  `jul test` prüft es, was der statische Typ offen lässt (`_checkAssume` / `_checkAssumeTest` in
  `runtime.ts`), und meldet einen Bruch mit `file:row:col`. Bedingungen über mehrere Werte
  („Index ≤ Länge“, „Karte X liegt in Zone Y“) lassen sich so nicht ausdrücken.
- **Eigene Prüffunktionen**, die einen `Error`-Wert liefern. yugioh prüft so die Invarianten des
  Spielzustands (`invariants.jul`, `applyChecked`): nach jedem Schritt, mit dem auslösenden Input
  in der Meldung. Ein Bruch wird erst am Ende des Schritts sichtbar, nicht dort, wo er entsteht.
  Das ungeprüfte `apply` der KI-Playouts prüft gar nicht, damit sie nichts kosten.

## Idee

`assert(meldung bedingung)` in der core-lib. Unter `jul test` wird die Bedingung ausgewertet, ein
`false` wirft wie ein verletztes `assume` mit `file:row:col` und der Meldung. Im normalen Build
entfernt der Emitter den Aufruf samt Argumenten, er kostet dann nichts. Gedacht für
Nachbedingungen an den Stellen, die einen Zustand ändern (Zonenwechsel, Kettenauflösung), damit
ein Bruch dort gemeldet wird, wo er entsteht.

## Festgelegt

- **Seiteneffekte der Bedingung werden nicht geprüft.** Im normalen Build entfernt der Emitter den
  Aufruf samt Argumenten, auch wenn die Bedingung nicht rein ist. Ihre Seiteneffekte fallen dann
  weg. Die Doku von `assert` sagt das, der Checker meldet nichts.
- **Ein Funktionsaufruf `assert(message: Text condition: Boolean)` mit Rückgabe `[]`.** Eine
  Funktion der core-lib, kein eigenes Sprachkonstrukt, die Reihenfolge wie bei
  `test(name callback)`. `assert` steht als eigene Zeile im Rumpf, wie `log(…)`. Der Emitter
  behandelt den Aufruf gesondert (prüfen unter `jul test`, im normalen Build samt Argumenten
  entfernen, als letzte Zeile eines Rumpfs durch `[]` ersetzen). Die Bedingung ist ein fertiger
  `Boolean`, kein Callback: kürzer, so wie in C#, Swift, Java und Python, und im Test genauso
  einfach wie im Produktivcode. Weil der Emitter den Aufruf ohnehin gesondert behandelt, wird die
  Bedingung trotzdem nur ausgewertet, wenn geprüft wird.
- **Warnung bei Definitionen, die nur in `assert` verwendet werden.** Zwischenwerte einer
  Prüfung, die als eigene Zeilen vor dem `assert` stehen, berechnet der normale Build weiter,
  obwohl das `assert` wegfällt. Der Checker warnt deshalb bei einer Definition, deren einzige
  Verwendungen in `assert`-Bedingungen liegen, mit dem Hinweis, die Rechnung in eine
  Hilfsfunktion zu verschieben (wie die `get…Error`-Funktionen in yugiohs `invariants.jul`).
- **Fehlermeldung wie bei `test`.** Der Emitter legt `_testCall` um die Bedingung, ein Bruch
  nennt dann die ausgewerteten Argumente (`equal(1 2) returned false`).
- **Die Meldung wird nur im Fehlerfall ausgewertet.** Der Emitter setzt das Argument für die
  Meldung in den Fehlerzweig, eine interpolierte Meldung kostet bei bestandener Prüfung nichts.
  Geschrieben wird sie als normaler `Text`, nicht als Funktion.
- **Ein gemeinsamer Schalter `checkAssertions` für `assume` und `assert`.** Unter `jul test`
  immer an, im normalen Build per `checkAssertions: true` in der `jul-config.yaml`. Die
  Emitter-Option `checkAssumes` heißt dann ebenso. Kein CLI-Flag: Ein Build mit Prüfungen ist
  eine eigene Konfiguration (wie `bench.jul-config.yaml` in yugioh), gewählt mit `--config`.
  Getrennte Schalter erst, wenn ein Fall zeigt, dass man nur eines von beiden prüfen will.
- **Keine Typverengung.** `assume` behauptet Typen und wirkt auf den Checker, `assert` behauptet
  etwas über Werte und wirkt nur zur Laufzeit. So bleibt `assume` die einzige Stelle, an der der
  Checker einer ungeprüften Behauptung glaubt, und lässt sich weiter vollständig suchen. Wer
  beides braucht, schreibt `assert` und `assume` nebeneinander. Eine Verengung ließe sich später
  nachrüsten, bräuchte bei einem `Boolean` als Bedingung aber eine Verengung im Ablauf eines
  Rumpfs („nach dieser Zeile ist `x` enger“), die es in JUL bisher nicht gibt. Die
  Prädikat-Fakten dafür sind vorhanden ([predicate-types-and-filter-narrowing.md](predicate-types-and-filter-narrowing.md)).
- **Ein Bruch wirft eine Exception, keinen `Error`-Wert.** Ein Assert beweist einen
  Programmierfehler, keinen erwartbaren Fehlerfall. Der Throw liefert den Stacktrace, die Meldung
  nennt `file:row:col` und den Meldungstext. Melde- und Fangweg teilt `assert` mit `assume`
  (`pendingAssumeViolation`, damit ein abfangender JS-Aufrufer den Bruch nicht verschluckt).
- **`applyChecked` in yugioh bleibt.** Die UI verwirft dort einen Input, der eine Invariante
  verletzt, behält den alten Zustand und zeigt die Meldung an. Das ist Fehlerbehandlung im
  normalen Build, kein Test-Assert. `assert` ergänzt es an den Stellen, die den Zustand ändern,
  und in Pfaden, die heute ungeprüft laufen (`apply` in den KI-Playouts).
- **Kosten unter `jul test` werden nach dem Einbau gemessen**, in yugioh mit `measure-build.js`
  vor und nach den ersten Asserts. Regeln für teure Bedingungen oder Prüfstufen erst, wenn die
  Messung zeigt, dass es nötig ist.
- **Eine konstante Bedingung meldet der Checker.** Faltet er die Bedingung zu `true`, prüft das
  `assert` nichts, faltet er sie zu `false`, schlägt es bei jeder Ausführung fehl. In beiden
  Fällen ist es sinnloser Code und bekommt eine Warnung, je Fall mit eigenem Code („prüft nie
  etwas“ ist ein Aufräumhinweis, „schlägt immer fehl“ ein wahrscheinlicher Bug). Kein Fehler:
  Die Faltung wird mit der Zeit genauer, ein Fehler würde bestehenden Code dann mit einem
  Compiler-Update unbaubar machen. Ein `assert`, das immer fehlschlägt, meldet `jul test` ohnehin
  beim ersten Durchlauf. Das passt zu JUL2503 (redundantes `assume`) und JUL5152 (unerreichbarer
  Zweig), beide Warnungen.
- **Färbung wie `assume`.** `assert` behandelt der Emitter gesondert, es wird deshalb wie ein
  Keyword gefärbt: in der Grammatik der Extension (`syntaxes/jul.tmLanguage.yaml`, Regeln wie
  `assume-call.jul` und `keyword.control.assume.jul`, danach `npm run convert-grammar`) und im
  Language Server in `keywordFunctionNames` (`semantic-tokens.ts`), damit kein Semantic Token die
  Färbung überschreibt.
- **Nur direkt aufrufbar.** Der Emitter kann einen Aufruf nur entfernen, den er sieht. `assert`
  als Funktionswert weiterzugeben, ist ein Fehler, wie bei `assume` (`assumeNotCalled`).
- **Name `assert`.** Passt zu [naming.md](../naming.md): ein Verb in camelCase, ausgeschrieben,
  steht neben `assume`, und die core-lib hat für den Begriff noch kein anderes Wort.

## Offene Fragen

Keine.