# Kritische Bewertung der Sprache

Stand 2026-09-27. Grundlage: [design-principles.md](../design-principles.md),
[CHECKER-AUDIT.md](../CHECKER-AUDIT.md), [TODO](../../TODO), `core-lib.jul`, `runtime.ts`,
`jul-examples` und yugioh; der Code (~26.000 Zeilen) stichprobenartig, nicht vollständig gelesen.
Nachgeprüft zum Stand: 931 Tests grün (0,5 s), `typecheck` sauber, alle Beispiele checken außer
`import` (bekannter `JUL1151`), yugioh checkt fehlerfrei (491 ms).

## Urteil

Die Entwicklungsdisziplin ist für ein Ein-Personen-Sprachprojekt ungewöhnlich hoch, als Sprache hat
JUL aber ein ungelöstes Kernproblem: **Es ist nicht vorhersagbar, wo die Typprüfung aufhört.** Das
Handwerk ist stark, die Semantik noch nicht belastbar.

| Dimension | Note | Kurz |
|---|---|---|
| Entwurfsprozess | 9/10 | Prinzipien mit Preis, Rangfolge, am echten Code ausgezählt |
| Tooling | 8/10 | LSP, Test Explorer, Source Maps, Tree-Shaking, Benches |
| Kohärenz der Kernideen | 7/10 | Klammer-Regel, Werte = Typen, „Typ = Anforderungen“ konsequent |
| Verlässlichkeit des Typsystems | 4/10 | `Any` schluckt zu viel, Checker und Runtime divergieren |
| Syntax und Fehlermeldungen | 5/10 | eigenständig, aber mit Fallen, Parser-Meldungen schwach |
| Einsatzreife und Ökosystem | 3/10 | ein Nutzer, keine Libraries, häufige Breaking Changes |

## Stärken

- **Entwurfsprozess.** Jedes Prinzip nennt, was es verbietet und was es kostet, dazu eine
  praktizierte Rangfolge bei Kollisionen. Der Fall Auto-Spread → `?(x)` zeigt, dass die Prinzipien
  Entscheidungen tatsächlich ändern.
- **Messkultur.** Bench mit Protokoll, Zähler-Gate, Checker-Snapshot, und die Einsicht, dass
  Aufrufzahlen und Laufzeit verschiedene Größen sind (`resolvePlaceholders`: 99 % weniger Aufrufe,
  17 % weniger Zeit).
- **Kohärente Kernideen.** Werte und Typen in einem Namensraum, strukturelle Typen als
  Anforderungen mit korrekter Kontravarianz, `Empty` als eigener Typ, Pattern Matching über
  gewöhnliche Funktionen, Refinement-Typen (`NonZeroInteger`, `Greater`).
- **Interop.** `.ts`, `.js`, `.json` und `.yaml` landen im selben Syntaxbaum; yugioh zeigt, dass
  ein echtes Programm mit DOM und IndexedDB damit funktioniert.
- **Testkultur.** Schnelle Suite ohne IO, `reportAtCaller`, roter Test vor dem Fix.

## Schwächen

### 1. Freiheit untergräbt Klarheit

„Kein Fehler statt falscher Fehler“ ist vertretbar, aber der Rückfall auf `Any` passiert an
Stellen, die der Nutzer nicht vorhersehen kann:

- `1/2` wird still zu `Any`.
- Funktionstypen aus TS-Importen werden zu `Any`.
- Parametertypen, die sich auf frühere Parameter beziehen, werden bei benannten Argumenten nicht
  geprüft.
- `Any` hat drei Bedeutungen (unbekannt, bewusst permissiv, „schon kaputt, sei still“); nach einem
  Fehler verstummt die ganze Kette darunter.

Aus einem grünen Checker lässt sich deshalb nicht schließen, dass der Code geprüft wurde. Das
verletzt Klarheit („Was im Code steht, ist was der Code macht“). TypeScript ist auch nicht sound,
aber dort sind die Lücken bekannt und dokumentiert, hier sind sie Nebenwirkungen der
Implementierung.

### 2. Checker und Runtime haben verschiedene Semantik

Werte = Typen heißt, derselbe Typausdruck wird zweimal ausgewertet, im Checker und zur Laufzeit,
und beide weichen ab:

- `_branch` prüft bei `Stream(Text)` und `Stream(Integer)` nur `instanceof StreamClass`, der Checker
  verengt aber auf `Stream(Text)`. Er behauptet damit etwas, das die Runtime nicht garantiert — ein
  echtes Soundness-Loch, kein verpasster Fehler.
- `Concat` und die übrigen reinen Typfunktionen crashen zur Laufzeit, wenn sie an Parameterposition
  stehen.
- Jeder JUL-Aufruf geht über `_callFunction` und `assignArgs`, jedes Branching probiert die
  Branches mit `tryAssignArgs` durch. Typgestützte Emission ([typed-emission.md](typed-emission.md))
  würde das abbauen, heute zahlt jeder Aufruf.

### 3. Fehler als stille Werte

Trifft kein Branch, liefert das Branching `new Error(...)` als Wert, Exhaustivität wird bewusst
nicht erzwungen. Zusammen mit `Any` kann ein solcher Fehlerwert weit ungeprüft durchs Programm
wandern. „Ehrlich statt repressiv“ trägt erst, wenn ein `Error` im Rückgabetyp auch behandelt
werden muss.

### 4. Fragile Implementierung

- [checker.ts](../../src/checker/checker.ts) hat ~8.900 Zeilen, mutiert den AST, Typen sind nicht
  immutable — Caching ist deshalb riskant.
- Bekannte Fallen: rawType und dereferencedType vermischen, aus einem ausbleibenden
  `getTypeError` ohne `hasReliableTypeError` schließen.
- Präzision kostet unvorhersehbar: ein präziserer Typ an einer Stelle ließ parse+check von 3,6 s
  auf 14,4 s steigen (`typeEquals` in der Deduplizierung). `Any` ist damit auch Performance-Ventil,
  und jede Präzisierung ist ein Performance-Risiko.

Das Audit sagt selbst: „Ein grüner Testsatz reicht als Absicherung nicht.“ Echte Sicherheit gibt
heute nur der Lauf gegen yugioh.

### 5. Syntaxfallen und Parser-Meldungen

- `/` ist Pfad- und Indexoperator zugleich, `1/2` bedeutet still etwas anderes als erwartet.
- In 7 von 14 invaliden Snippets sieht der Nutzer nur `multilineParser should parse until end of
  row`, andere Meldungen leaken Kombinatornamen. Das verstößt gegen die eigene Regel „Meldungen
  sprechen vom Quelltext“ und trifft genau den Einstieg.
- Die Vereinheitlichung von positionellen und benannten Argumenten macht Parameternamen zum Teil
  des Funktionstyps: Umbenennen ist ein Breaking Change, TS-Callbacks lassen sich nicht übersetzen,
  benannte Argumente gegen einen `rest`-Parameter sind semantisch ungeklärt.
- `§` als Textbegrenzer ist auf der deutschen Tastatur bequem, außerhalb davon eine Hürde.

### 6. Ökosystem und Prozess

- Die Stichprobe ist ein Autor mit yugioh und den Beispielen, das räumen die Prinzipien selbst ein.
  „Realer Anlass“ heißt damit: die Anlässe eines Nutzers.
- Keine CI. Benches, Purity-Check und Beispiel-Builds hängen an Disziplin, und das zeigt sich schon:
  der LSP-Snapshot ist laut TODO veraltet,
  [type-function.jul](../../../jul-examples/type-function.jul) nutzt noch das Infix-`?`, `import`
  scheitert.
- Wiederverwendung (Libraries, Paketverwaltung) ist ungelöst.
- Endzustand ist richtig, solange es einen Nutzer gibt, wird aber mit jedem weiteren sofort teuer.

### 7. Positionierung

Refinement-Typen und push-basierte Streams sind echte Alleinstellungsmerkmale. Heute bezahlt man
sie mit mehr Laufzeitkosten und weniger Typverlässlichkeit als bei TypeScript. Was JUL für wen
besser macht als TS mit einer Stream-Library, ist nirgends formuliert — als Forschungs- und
Hobbyprojekt legitim, dann aber bewusst so einzuordnen.

## Empfehlungen, nach Hebel

1. **Invalid-Typ getrennt von `Any`**, dazu eine Meldung oder ein `--strict`-Report, wo ein
   Ausdruck ungewollt `Any` wurde. Macht die Prüfgrenze sichtbar, größter Hebel gegen Schwäche 1.
2. **Eine Regel für Verengung:** der Checker verengt nur auf das, was die Runtime prüfen kann —
   für Streams, Funktionen und Typfunktionen gleich, keine Ausnahme je Typ. Schließt das
   Soundness-Loch aus Schwäche 2.
3. **Parser-Sammelmeldung auflösen** — bester Einstiegsgewinn pro Aufwand.
4. **Absicherung automatisieren:** ein Skript oder Hook für Tests, Beispiel-Builds, Purity-Check
   und yugioh-Check.
5. **Mittelfristig immutable Typen und `checker.ts` aufteilen**, als Voraussetzung dafür, dass
   Präzision nicht jedes Mal ein Performance-Risiko ist.
