# Plan: Immer emittieren

Ziel: Fehler verhindern den Emit nicht mehr. Der Compiler erzeugt JS auch aus Code mit Syntax- oder
Typfehlern, das Programm läuft, soweit es eben läuft. Was an einer kaputten Stelle geschieht, ist
undefiniert. Die Fehler werden weiter gemeldet, und der Exit-Code bleibt bei einem Fehler 1.

Anlass: Im Playground sperrt ein beim Prüfen schon fehlschlagender Test (`JUL5200`) den Knopf
„Prüfen“, in fast jeder Übung des Tutorials ist das der Ausgangszustand.

## Entscheidungen

- **Kein sinnvolles JS an Fehlerstellen.** Zwei Bedingungen gelten trotzdem: Der Emitter stürzt
  nicht ab, und die Ausgabe ist gültiges JS, sonst scheitert das Bündeln und auch der intakte Teil
  läuft nicht. Eine Lücke wird `undefined`.
- **Für alle Befehle gleich:** `jul` (Build), `jul test`, Playground. Nur `jul check` emittiert
  weiterhin nicht.
- **Der Schweregrad bleibt Anzeige.** `error` heißt „Exit-Code 1“, nicht mehr „kein Emit“.
- Später möglich, nicht Teil dieses Plans: an einer Fehlerstelle statt `undefined` ein Abbruch mit
  der Prüfmeldung.

## Ausgangslage

Ein Versuch mit 20 kaputten Eingaben direkt am Emitter (`emitToJs` auf das Ergebnis von `loadFile`)
ergab:

- 18 Fälle erzeugen gültiges JS, darunter unvollständige Aufrufe, fehlende Werte und Rümpfe,
  unbekannte Namen, Typfehler, Verzweigungen ohne Argument oder ohne passenden Zweig, falsche
  Klammern, falsche Einrückung. Kaputte Zeilen fallen weg oder werden zu einem Namen, der zur
  Laufzeit fehlt (`ReferenceError`).
- 2 Fälle werfen im Emitter:
  - `import()` ohne Pfad: `Can not get import path from undefined` (`getImportedPath`)
  - Dictionary-Feld ohne Wert (`[a = ]`): `value missing for dictionary field`
- Ein Import einer fehlenden Datei (`JUL3120`) emittiert einen Import, den webpack bzw. der
  Testlauf nicht auflösen kann.

Sperren vor dem Emit:

- `compile` in `src/browser.ts` (Playground): `hasError` → `{ type: 'error' }` ohne Programm.
- `compileProject` in `src/compiler/compiler.ts`, Region „3. report errors“: Rückkehr bei
  `hasError`.
- `testProject` in `src/compiler/compiler.ts`: Rückkehr bei `hasError`, `JUL5200` ist dort schon
  ausgenommen (`ignoredCodes`).
- `Playground.js`: ohne `result.program` keine Ausführung und „Prüfen“ gesperrt.

## Schritte

1. **Emitter fest machen.** Je ein Emitter-Test für die beiden Abstürze und den fehlenden Import:
   Die Ausgabe ist gültiges JS. Erst rot zeigen, dann beheben: Lücken werden `undefined`, ein
   Import einer fehlenden oder nicht angegebenen Datei liefert `undefined` für jeden importierten
   Namen. Den `throw new Error(...)` für fehlende Teile im Emitter durchgehen
   (`args missing in branching`, `value missing in definition`, `functionExpression missing …` usw.)
   und jeden, der aus einem unvollständigen Baum entstehen kann, ebenso ersetzen. Echte
   Programmierfehler (`assertNever`) bleiben.
2. **Sperren entfernen.**
   - `browser.ts`: `compile` liefert immer ein Programm, `errors` daneben. `CompileOutput` ohne
     `type: 'error'`.
   - `compiler.ts`: Build und Testlauf melden die Fehler und machen weiter. Die Abschlusszeile sagt
     „build finished with errors“, `process.exitCode = 1`. Der Bericht an den Test Explorer
     (`compileFailed`) entfällt, die Fehler stehen im Editor. `ignoredCodes` wird überflüssig.
   - Playground: führt immer aus, die Fehler stehen über der Ausgabe, „Prüfen“ ist nie gesperrt.
3. **Tests.** Neben den Emitter-Tests: `compile` aus `browser.ts` liefert bei einem Typfehler ein
   Programm, und ein Testlauf mit `JUL5200` meldet den Test als fehlgeschlagen mit den
   Argumentwerten.
4. **Messen.** `npm run bench-runtime` und `npm run bench` vor und nach Schritt 1, mit `--save`.
5. **Doku.** `CLAUDE.md` (Abschnitt Compiler: „Emittiert wird erst, wenn …“ und „der Emitter sieht
   nie einen unvollständigen Baum“) und die Kommentare an `compile` und den Sperren. In
   `jul-homepage/docs` steht dazu bisher nichts, im CLI-Teil des Handbuchs einen Satz ergänzen:
   Auch mit Fehlern wird gebaut, der Exit-Code ist dann 1.

## Umgesetzt

Alle fünf Schritte, mit diesen Abweichungen:

- Eine zweite Versuchsreihe mit 33 Eingaben fand acht weitere Abstürze im Emitter (Dereferenz ohne
  Feld, Punkt ohne Funktion, `assert` ohne Bedingung, `assume()` und `assume(...l)`, benannte
  Argumente mit Spread, Definition ohne Wert im Rumpf, `test` ohne Callback). Je ein Test verlangt
  gültiges JS, geprüft mit dem Parser von TypeScript. Alle 53 Eingaben ergeben jetzt gültiges JS.
- `hasDefaultExport` liefert `undefined` für eine nicht geladene Datei, statt zu werfen.
- Projektfehler halten Build und Testlauf weiter auf: Ohne Einstieg gibt es nichts zu bauen, bei
  gleichen Ausgabepfaden überschriebe eine Datei die andere. `compileFailed` meldet nur noch sie.
- Sind alle Tests grün, der Code hat aber Fehler, endet `jul test` mit „tests finished with errors“
  samt Fehleranzahl und Exit-Code 1 (zuerst „tests passed with compile errors“, das las sich beim
  Überfliegen und für `grep passed` wie ein grüner Lauf).
- Der Playground zeigt `JUL5200` weiter in der Fehlerliste: Tests laufen dort erst auf „Prüfen“,
  ohne die Meldung sähe man vorher nicht, dass ein Test fehlschlägt.
- Bench vor und nach dem Emitter: keine Änderung über das Rauschen hinaus, für fehlerfreien Code ist
  das erzeugte JS gleich.

## Offen

- Im Browser nicht ausprobiert.
- Läuft der Playground bei jedem Tastendruck halbfertigen Code aus, kann der in eine Endlosschleife
  geraten. Der Lauf wird bei jeder Änderung neu gestartet und nach 10 s beendet, das sollte genügen.
