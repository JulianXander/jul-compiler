# Fuzz-Prototyp: Parser und Checker werfen nie und terminieren

Entwurf ohne Entscheidung. Erster, bewusst kleiner Schritt; die Ausbaustufen stehen unten.

## Ziel

Beleg, ob Parser und Checker bei **beliebigem, auch kaputtem Text** nur Diagnostics liefern, nie
eine Exception werfen und in endlicher Zeit fertig werden. Das ist die Zusage, auf der der
Language Server beim Tippen aufbaut (siehe CLAUDE.md, „Parser und Checker tolerieren
unvollständige Ausdrücke absichtlich“). Kein Orakel nötig: Die Eigenschaft ist „kein Throw,
kein Timeout“.

## Form

Eigenes Skript `jul-compiler/scripts/fuzz.ts`, Aufruf `npm run fuzz [-- --seed 42 --seconds 20]`.
**Nicht** Teil von `npm test` (Suite soll bei ~0,35 s bleiben), analog zu `bench`. Läuft über
`tsx`, ohne IO: Code über `createInMemoryHost` laden. Keine neue Abhängigkeit; ein kleiner
Zufallsgenerator mit Seed (mulberry32) reicht und macht Läufe reproduzierbar.

## Ablauf

1. **Korpus**: alle `*.jul` unter `jul-examples` (ohne `out`, `node_modules`) einlesen, dazu die
   `code`-Strings der Fälle aus den Parser- und Checker-Tests, falls sich diese ohne Umbau
   herausziehen lassen (sonst weglassen, der Korpus aus `jul-examples` genügt für den Start).
2. **Mutationen** (je Runde 1 bis 3 davon auf eine zufällige Korpusdatei):
   - Zeichenbereich löschen
   - Zeichen aus einer Menge einfügen, die die Syntax tragen: `( ) [ ] § ? : = > - . , \t \n` und
     Leerzeichen sowie ein paar Bezeichner und Zahlen
   - Zeile duplizieren, löschen oder umsortieren
   - Einrückung einer Zeile um ±1 Tab ändern (der Parser ist einrückungsbasiert)
   - Abschneiden an zufälliger Stelle (simuliert „mitten im Tippen“)
3. **Prüfung je Eingabe**, in dieser Reihenfolge:
   - `loadFile` bzw. `parseCode` + `checkTypes` über `createInMemoryHost`
   - Kein Throw. Sonst Fund „exception“ mit Stack.
   - Laufzeit unter einer Grenze (Start: 1000 ms). Sonst Fund „slow“. Echte Endlosschleifen
     blockieren den Thread; deshalb läuft jede Runde in einem `worker_threads`-Worker mit
     `terminate()` nach der Grenze. Fund „hang“.
   - Alle Fehlerpositionen liegen in der Datei (Zeile < Zeilenzahl, Spalte ≤ Zeilenlänge, Start ≤
     Ende). Sonst Fund „position“.
4. **Ausgabe**: je Fund Art, Seed, Runde, Länge und die Eingabe nach einer einfachen
   Verkleinerung (Zeilen, dann Zeichen entfernen, solange derselbe Fund bleibt) als Datei unter
   `scripts/fuzz-findings/` (in `.gitignore`). Zum Schluss Zähler je Art und Durchsatz.

Exit-Code ungleich 0 bei Funden, damit sich das Skript später in einen Hook oder eine CI hängen
lässt. Das ist anders als beim Bench, wo der Alarm reine Ausgabe ist.

## Was nicht dazugehört

- Kein coverage-guided Fuzzing (Jazzer.js), keine Grammatik-Generatoren.
- Keine Typalgebra-Gesetze, kein Soundness-Test, kein Emitter.
- Keine Language-Server-Anfragen.

## Vorgehen bei Funden

Je Fund ein normaler Regressionstest in der Suite (`expectParse` bzw. `expectCheck`), nach der
Projektregel: erst den roten Test zeigen und anhalten, dann der Fix. Das Skript selbst bleibt
unverändert.

## Erfolgskriterium des Prototyps

- Läuft reproduzierbar mit festem Seed und liefert nach 20 s Durchsatz und Fundzahlen.
- Entweder mindestens ein echter Fund, oder ein Lauf über mehrere Seeds ohne Fund. Beides ist
  ein Ergebnis; ohne Fund ist die Zusage belegt und der Aufwand für die nächste Stufe besser
  begründet.

## Ausbaustufen (nur bei Nutzen)

1. **Typalgebra-Gesetze** mit fast-check und einem `Arbitrary<CompileTimeType>`: Reflexivität und
   Symmetrie von `typeEquals`, Idempotenz und Kommutativität von `createNormalizedUnionType` /
   `createNormalizedIntersectionType`, Transitivität der Zuweisbarkeit, Kontravarianz an der
   Parameterposition. Gehört als kleine Property-Tests in die Suite, wenn sie unter ~50 ms
   bleiben, sonst ins Skript.
2. **Tipp-Simulation**: Datei Zeichen für Zeichen aufbauen, jedes Präfix prüfen (Throw, Zeit).
   Billige Erweiterung von Schritt 3 oben und sehr nah an der Nutzung im Language Server.
3. **Language Server**: zufällige Positionen für Hover, Completion, Definition und Rename auf
   gültigen und mutierten Dateien.
4. **Soundness**: typgesteuert generierte, fehlerfrei geprüfte Programme ausführen und den
   Laufzeitwert gegen den geprüften Typ prüfen. Größter Nutzen, größter Aufwand.

## Stand

Umgesetzt in `scripts/fuzz.ts` (`npm run fuzz`). Abweichung vom Entwurf: Ein Ende am Anfang der
Zeile hinter der Datei gilt nicht als Positionsfehler, der Parser meldet so regulär `?()`.
Der erste Lauf (Seed 42, 20 s, ~300 Eingaben/s) fand Positionsfehler (`import()` meldet das Ende
in Zeile 8 einer Ein-Zeilen-Datei, 3000/5154 enden hinter der Datei) und eine Eingabe, die
1,8 s braucht (`fizz-buzz-functional.jul` mit `dividend.modulo(=>divisor)`).

### Faltbudget

Der Fuzzer meldet zusätzlich `budget`: mehr Faltungen (`checkerStats.foldableCall`) als
`initialFoldBudget` je geprüfter Datei erlaubt. Ist das Budget leer, soll nichts mehr gefaltet
werden; tatsächlich baut jeder weitere Versuch in `tryBuildCallable` ein `new Function`, wirft
einen `FoldBudgetExhaustedError` und speichert nichts. Dafür gibt es bewusst keinen Test in der
Suite: Schon das Leerbrennen des Budgets kostet ~40 ms.
