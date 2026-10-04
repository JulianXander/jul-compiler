# Assertions an Phasengrenzen

Idee ohne Entscheidung. Angeregt durch den Tiger Style von TigerBeetle (viele Assertions, die
Invarianten ausführbar machen).

## Ausgangslage

Im Compiler gibt es keine Assertions. Die Invarianten der Pipeline stehen nur in der Doku
(CLAUDE.md) und werden indirekt von Snapshot und Zähler-Gate abgedeckt, die das **Ergebnis**
prüfen, nicht den Zustand auf dem Weg dorthin. Der Fuzzer (`fuzz-prototyp.md`) prüft „kein Throw,
kein Hang, Positionen plausibel“, aber keine fachliche Konsistenz.

## Idee

Invarianten an den Phasengrenzen als ausführbare Prüfungen schreiben. Ein Bruch meldet dann die
Ursache dort, wo sie entsteht, statt als unverständlicher Folgefehler tief im Emitter. Jeder
Lauf über `jul-examples`, yugioh, Bench und Fuzzer prüft sie mit, ohne zusätzlichen Testcode.

Kandidaten:

- **Eingang des Emitters**: kein `binding`- oder `data`-Knoten mehr im Baum, jeder Ausdruck hat
  `checked` samt `TypeInfo`, keine Datei mit Fehler der Schwere `error`.
- **Ausgang des Checkers**: jede geprüfte Datei hat für alle Ausdrücke eine `TypeInfo`, auch
  `.json`/`.yaml`/`.ts`/`.js`.
- **Typalgebra**: Nach `createNormalizedUnionType` / `createNormalizedIntersectionType` ist kein
  `Or` in einem `Or` und kein `And` in einem `And` mehr verschachtelt, keine doppelten Glieder.
- **Parser**: Positionen von Kindknoten liegen innerhalb des Elternknotens.
- **Tiefe**: Rekursion über Typen und Ausdrücke hat eine Obergrenze, deren Überschreiten ein
  regulärer Fehler ist, kein Stack Overflow.

## Offene Fragen

- **Wann aktiv?** Immer, nur im Test, Fuzz und Bench, oder per Schalter. Billige Prüfungen
  (Knotentyp, Feld vorhanden) können immer laufen, teure (Baumdurchlauf pro Knoten) nur dort, wo
  Zeit keine Rolle spielt. Messen mit `npm run bench -- --save` vor und nach dem Einbau.
- **Wie melden?** Ein Assert beweist einen Compilerfehler, keinen Fehler im JUL-Code des
  Nutzers. Im Language Server darf er das Tippen nicht abbrechen; dort wäre ein Log oder eine
  Diagnostic „interner Fehler“ passender als ein Throw.
- **Helfer**: eigener `assert`-Helfer mit Typverengung (`asserts condition`) oder
  `node:assert`. Ein eigener Helfer erlaubt den Schalter oben und eine einheitliche Meldung.
- **Zusammenspiel mit dem Fuzzer**: Der Fuzzer müsste einen Assert-Bruch als eigenen Fund
  melden (`assertion`), getrennt von `exception`.

## Reihenfolge, falls umgesetzt

1. Die Emitter-Vorbedingung, weil sie die in CLAUDE.md zugesagte Garantie prüft und am wenigsten
   Aufwand hat.
2. Die Normalisierungs-Nachbedingungen der Typalgebra, vor den Typalgebra-Gesetzen aus
   Ausbaustufe 1 des Fuzz-Prototyps.
3. Der Rest nach Bedarf, sobald ein Fund zeigt, an welcher Grenze Prüfungen fehlen.
