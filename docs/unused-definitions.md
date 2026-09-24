# Hinweis auf ungenutzte Definitionen

Ungenutzte lokale Definitionen bekommen einen Hinweis (Schweregrad `hint`). Vorher wird die
Export-Regel für Top-Level-Destructuring im Checker an den Emitter angeglichen, weil davon
abhängt, welche Top-Level-Bindungen überhaupt ungenutzt sein können.

## Entscheidungen

### Export-Regel: die Form entscheidet

Top-Level-**Definitionen** (`x = …`) werden exportiert, Top-Level-**Destructuring**
(`(a b) = …`) nicht - weder Import-Bindungen noch zerlegte berechnete Werte.

- Import-Bindungen werden damit nicht stillschweigend re-exportiert. So halten es JS/TS, Rust,
  Go, Haskell; Python re-exportiert implizit und fängt das per `__all__` bzw.
  `--no-implicit-reexport` wieder ein.
- Weiterreichen bleibt über `lib = import(…)` möglich: das ist eine Definition.
- Der Emitter verhält sich bereits so (Destructuring bekommt kein `export`). Zur Laufzeit ändert
  sich nichts, nur der Checker hört auf, Destructuring-Felder als Export zu behaupten.
- Preis: Wer einen zerlegten Wert exportieren will, schreibt `size = getSize()` bzw. zerlegt und
  benennt um. Im Bestand (jul-examples, yugioh) sind alle Top-Level-Destructurings bis auf ein
  Sprachbeispiel Importe.

### Umfang des Hinweises

- Geprüft werden Definitionen und Destructuring-Felder in Funktionsrümpfen (auch
  `?`-Zweige, verschachtelt) sowie Destructuring-Felder auf oberster Ebene.
- Ausgenommen:
  - die letzte Expression eines Funktionsrumpfs, wenn sie eine `definition` ist - sie ist der
    Rückgabewert. Endet der Rumpf mit einem Destructuring, werden dessen Felder normal
    geprüft, zurückgegeben wird der ganze Wert.
  - Top-Level-Definitionen, sie sind exportiert.
  - Parameter: `?`-Zweige matchen per Parametertyp, Callbacks erfüllen per Kontravarianz
    breitere Signaturen - ungenutzte Parameter sind dort oft nötig.
  - Dictionary- und DictionaryType-Felder: das sind Daten, keine lokalen Bindungen.
  - die core-lib.
- Eine Referenz innerhalb der eigenen Definition zählt nicht als Nutzung (Rekursion). Gegenseitige
  Rekursion zweier sonst ungenutzter Funktionen bleibt unerkannt.
- Keine Unterdrückung. Namen dürfen nicht mit `_` beginnen (`_` ist im Emitter für eigene
  JS-Namen reserviert), eine Konvention dafür gibt es also nicht.
- Die CLI gibt Hinweise nicht aus, nur der Editor zeigt sie.

### Nutzung als Flag am Symbol

`SymbolDefinition` bekommt `isUsed?: true`, gesetzt im `case 'reference'` des Checkers - wie
TypeScript (`isReferenced`) und Go (`used`). Kein Modul-Slot, kein Durchreichen, und die
Information bleibt nach dem Check am Baum. Das Flag verlässt sich darauf, dass `checked` in jedem
Checklauf per `structuredClone` frisch entsteht.

Der `ReferenceIndex` wird nicht verwendet: er ist nur im Language Server aktiv (CLI und Tests
lassen ihn aus Kostengründen weg), dateiübergreifend kanonisch geschlüsselt und inkrementell
gepflegt. Anzahlen von Referenzen für den Language Server liefert er bereits.

## Schritte

1. **Export-Regel im Checker**
   - `getExportedSymbols(file)`: nur Symbole mit `definition.type === 'definition'`. Für `.ts`
     gibt es nur Definitionen, `.json`/`.yaml` haben keine Top-Level-Symbole.
   - Verwenden im `case 'import'` (Definitions- vs. Wert-Import, Dictionary-Typ), in
     `findImportCandidates` (Auto-Import), bei Go-to-Definition über Importe und in
     `followImportHop` (ReferenceIndex).
   - Test zuerst: Import eines Namens, den die Zieldatei nur per Destructuring bindet, ist ein
     Fehler.
2. **Fehlercode** `unusedDefinition = 4004`, `semantic`, `hint`, Abschnitt `JUL4004` in
   `jul-homepage/docs/docs/documentation/error-codes.md`.
3. **Checker**
   - `isUsed` im `case 'reference'` setzen, sofern nicht builtin und nicht innerhalb der eigenen
     Definition.
   - Nach `inferFileTypes` Lauf über den `checked`-Baum, Hinweis am Namen:
     `'x' is defined but never used.`
   - Tests zuerst, tabellengetrieben: ungenutzt mittendrin, letzte Definition, Nutzung in
     verschachteltem Lambda / Typ-Guard / Interpolation / `a/b`, teilweise genutztes
     Destructuring, Top-Level-Definition, ungenutzter Import, Rekursion.
4. **Language Server**: `DiagnosticTag.Unnecessary` für `unusedDefinition`.
5. **CLI**: Hinweise nicht ausgeben.
6. **Doku**: Export-Regel im Handbuch (`handbook.md`, Abschnitt import).
7. **Abnahme**
   - `npm run test-update-snapshot` und LSP-`test-snapshot`, Baseline-Diff durchsehen.
   - Bench vor und nach der Änderung mit `--save`.
   - yugioh und jul-examples mit `--check`, Hinweise auf Fehlalarme durchsehen.
