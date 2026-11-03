# Importeure nur bei geänderter Schnittstelle neu prüfen

Plan, Stand 2026-10-28, noch nicht begonnen. Folgt auf `immutable-syntax-tree.md` (Schritte 0 bis 5
umgesetzt) und ersetzt dessen Schritt 6 durch eine Reihenfolge mit Messung vorab.

## Ausgangslage

Language Server, yugioh, Median nach Schritt 5 des unveränderlichen Syntaxbaums:

| Szenario | Median |
|---|---|
| tippen → diagnostics | 242 ms |
| tippen → importeure fertig | 759 ms |
| hover | 0,08 ms |
| completion | 5,5 ms |

Nach jeder Änderung einer Datei merkt der Server **alle** transitiven Importeure als veraltet vor
(`markDependentsStale` in `jul-language-server/src/server.ts`) und prüft sie nach 300 ms Pause neu.
Das sind rund 500 der 759 ms. Die meisten Tastendrücke landen aber in einem Funktionsrumpf und ändern
nichts, was ein Importeur sieht.

## Vorbilder

Fast alle Sprachen prüfen Abhängige nur neu, wenn sich die Schnittstelle der geänderten Datei ändert
(„early cutoff“):

- **TypeScript** (`--incremental`): Hash der erzeugten `.d.ts` je Datei. Weil Rückgabetypen inferiert
  sein können, entsteht die Signatur erst nach dem Check, wie bei Jul.
- **Go (gopls):** Hash der Exportdaten je Paket.
- **GHC, Swift, OCaml:** Fingerprint der Interface-Datei (`.hi`, Interface-Hash, `.cmi`).
- **rust-analyzer:** `ItemTree` mit den Signaturen getrennt von den Rümpfen; Salsa rechnet Abfragen,
  deren Ergebnis gleich bleibt, nicht weiter („backdating“).
- **Kotlin (K2):** Eine Änderung im Rumpf macht nur diesen ungültig, aber nur bei explizitem
  Rückgabetyp. Bei inferiertem Rückgabetyp wird mehr verworfen.

## Was ein Importeur von einer Datei sieht

Der Fingerprint muss alles abdecken, wovon das Ergebnis eines Importeurs abhängt:

1. **Namen und Typen der Dateisymbole.** Importiert wird per Destructuring über die Symboltabelle der
   Datei. Die Typen sind meist inferiert, also erst nach dem Check bekannt.
2. **Positionen der Symbole.** Der Referenz-Index schlüsselt über `datei#zeile:spalte`
   (`getSymbolKey` in `reference-index.ts`), auch für Feldsymbole von Typen (`recordRelatedSymbol`).
   Hover und Go-to-Definition im Importeur folgen Symbolen der importierten Datei. Ein Zeilenumbruch
   oberhalb einer Definition ändert also, was ein Importeur weiß, ohne dass sich ein Typ ändert.
3. **Ob die Datei gefunden wurde** (`loadErrors`). Das deckt schon das Laden ab, nicht der Fingerprint.

Nicht dazu gehören die Fehler der Datei selbst und alles in Funktionsrümpfen, solange es nicht in einen
inferierten Typ durchschlägt.

## Schritte

### 0. Messen (Gate)

Ziel: wissen, wie oft der Cutoff greifen würde und woran er scheitert.

- Skript im Scratchpad: Für jede Datei in yugioh an zufälligen Stellen (in Rümpfen, in Typen, am
  Zeilenende, als neue Zeile) eine Tippfolge Zeichen für Zeichen einfügen und je Schritt prüfen, ob
  sich (a) Namen und Typen, (b) nur Positionen, (c) nichts geändert hat. Grundlage ist der
  Fingerprint aus Schritt 1, zunächst als Prototyp.
- Den Bench-Schritt aufteilen: Wie viel von den 242 ms ist Parsen, wie viel Prüfen der eigenen Datei?
  Das entscheidet über Schritt 5.

**Gate:** Der Cutoff lohnt, wenn in mindestens der Hälfte der Tippschritte (c) gilt. Ist (b) häufig,
kommt Schritt 3 vor Schritt 2.

Der vorhandene Bench-Fall „tippen“ hängt Ziffern an Zeile 47 von `game-logic.jul` an, einen Namen in
einer Import-Liste. Das ändert die Typen, der Cutoff greift dort nicht. Es braucht einen zweiten Fall
„tippen im Rumpf“.

### 1. Fingerprint der Schnittstelle (Compiler)

- `getInterfaceFingerprint(file: ParsedFile): string | undefined` in einem neuen Modul unter
  `src/checker/`. Über alle Symbole der Dateitabelle: Name, Startposition, Typ.
- Eine eigene Serialisierung der Typen, nicht `typeToString`: Die kürzt ab `depth` ab und ist für die
  Anzeige gedacht. Gebraucht wird eine vollständige, eindeutige Darstellung:
  - Alias-Typen als Datei, Name und Argumente, nicht aufgelöst, sonst drohen Zyklen.
  - Feldsymbole von Dictionary-Typen mit ihrer Position, wegen des Referenz-Index.
  - Unbekannte Typarten liefern `undefined`. Das gilt als „geändert“, also konservativ.
- Tests: Rumpfänderung gleich, Änderung eines inferierten Rückgabetyps verschieden, neue Zeile
  oberhalb verschieden, Feld umbenannt verschieden, zwei Läufe auf demselben Baum gleich.
- Die CLI nutzt den Fingerprint nicht. Er kostet nur im Server Zeit, das misst der Bench.

### 2. Cutoff im Server

- Je Datei den Fingerprint des letzten Checks halten.
- `processDocumentChange`: Nach dem Check den neuen Fingerprint mit dem alten vergleichen. Nur wenn er
  sich unterscheidet, die **direkten** Importeure vormerken, nicht mehr alle transitiven.
- `recheckDocument`: Danach ebenso vergleichen und bei Änderung die direkten Importeure des
  Importeurs vormerken. So wandert die Änderung nur so weit, wie sie Schnittstellen ändert.
- Vorgemerkte Importeure werden nie wieder entfernt, auch wenn ein späterer Tastendruck den alten
  Fingerprint wiederherstellt. Ein Importeur, der schon vorgemerkt ist, wird also im Zweifel einmal zu
  viel geprüft, nie zu wenig.
- **Reihenfolge topologisch:** Eine Datei erst prüfen, wenn keine ihrer Importe mehr vorgemerkt ist.
  Bei Zyklen eine beliebige nehmen.
  - Vermuteter Fehler im heutigen Stand, noch nicht geprüft: Die Breitensuche in
    `getTransitiveDependents` liefert keine topologische Ordnung. Importiert D sowohl A als auch B,
    und B importiert A, kann D vor B geprüft werden und sieht dann Typen von B, die noch auf dem alten
    A beruhen. D wird danach nicht noch einmal geprüft. Erst mit einem Test belegen, dann beheben.
- `onDidChangeWatchedFiles` nutzt denselben Weg.
- **Prüfmodus** `JUL_VERIFY_EARLY_CUTOFF=1`, analog zu `JUL_VERIFY_NODE_OWNERSHIP`: Übersprungene
  Importeure werden trotzdem geprüft, und ihre Fehler müssen dieselben sein wie vorher. Eine
  Abweichung wirft. Gesetzt in `test-setup.mjs` des Language Servers. Damit fällt ein zu grober
  Fingerprint in den Tests auf statt als veraltete Diagnose im Editor.
- Speicher: Ein übersprungener Importeur hält über Alias-Typen (`symbolResult`) das alte
  `CheckResult` und den alten Baum der geänderten Datei. Seit dem unveränderlichen Baum ist das
  korrekt. Es kostet nur Speicher bis zum nächsten Recheck des Importeurs.
- Messen: neuer Bench-Fall „tippen im Rumpf → importeure fertig“, erwartet etwa so viel wie
  „tippen → diagnostics“. Bench vor und nach dem Umbau speichern.

### 3. Positionsunabhängige Schlüssel im Referenz-Index (nur wenn Schritt 0 es verlangt)

Wenn neue Zeilen oberhalb von Definitionen den Cutoff oft verhindern: Der Referenz-Index schlüsselt
Symbole über einen Pfad aus Namen (`datei#name/feld`) statt über die Position. Die Positionen fallen
dann aus dem Fingerprint heraus. Go-to-Definition und Hover im Importeur müssen dann über die aktuelle
Datei auflösen statt über das gehaltene Symbol. Das ist ein eigener Umbau mit eigenem Gate.

### 4. Antworten aus dem letzten fehlerfreien Ergebnis (früherer Schritt 6, erster Teil)

Nach Schritt 2 neu bewerten. Zwei Lesarten:

- **Während ein Check läuft:** Bringt nichts, solange der Server einthreadig ist. Eine Anfrage wartet
  so oder so, bis der Check fertig ist. Das ginge erst mit einem Check im Worker-Thread oder in
  Häppchen.
- **Während der Code kaputt ist:** Hover und Completion liefern weiter Typen aus dem letzten Stand
  ohne Parse-Fehler. Dafür müssen Positionen im aktuellen Text auf den alten Baum abgebildet werden,
  über die Änderungen dazwischen. TypeScript und rust-analyzer machen das nicht, sie verlassen sich auf
  eine gute Fehlerbehandlung im Parser. Erst prüfen, wie schlecht Hover und Completion bei typischen
  halbfertigen Zeilen heute sind. Vielleicht ist bessere Fehlerbehandlung im Parser der kürzere Weg
  (siehe `parser-fehlermeldungen.md`).

### 5. Prüfen je Definition (früherer Schritt 6, zweiter Teil)

Nur wenn Schritt 0 zeigt, dass das Prüfen der eigenen Datei der Engpass bleibt. Vorbild rust-analyzer:

- Ids je Definition statt je Datei. Heute werden sie in Vorordnung vergeben, jede Bearbeitung
  verschiebt alle folgenden, und die Tabellen lassen sich über ein Neuparsen hinweg nicht halten.
- Signaturen getrennt von den Rümpfen. Eine Änderung im Rumpf prüft nur diesen Rumpf neu.
- Inferierte Rückgabetypen: Ändert sich der Typ, müssen die Nutzer der Funktion in derselben Datei mit.
  Das ist der Cutoff aus Schritt 2, eine Ebene tiefer.
- Was quer über Definitionen läuft, braucht eigene Antworten: Constant Folding, Längen-Terme,
  Analyse ungenutzter Symbole.

Ein eigener Entwurf, wenn es so weit ist.

## Risiken

- **Ein zu grober Fingerprint** übersieht eine Änderung, und Importeure zeigen veraltete Diagnosen,
  ohne dass es auffällt. Dagegen helfen der Prüfmodus aus Schritt 2 und die konservative Regel
  „unbekannt heißt geändert“.
- **Ein zu feiner Fingerprint** greift selten, dann bleibt nur die Messung aus Schritt 0 als
  Ergebnis. Das wäre billig erkauft.
- **Kosten des Fingerprints:** Er serialisiert bei jedem Tastendruck alle exportierten Typen. Bei
  großen Typen wie in `game-logic.jul` muss der Bench zeigen, dass das unter wenigen Millisekunden
  bleibt. Sonst einen Hash je Typ beim Interning merken.

## Zusammenhang mit anderen Dokumenten

- `immutable-syntax-tree.md`: Voraussetzung. Ohne unveränderlichen Baum wäre ein übersprungener
  Importeur, der alte Symbole hält, nicht sicher.
- `src/checker/reference-index.ts`: Schlüssel des Referenz-Index, betrifft Schritt 3. Das dort
  verlinkte `docs/cross-file-reference-index.md` gibt es nicht mehr.
- `parser-fehlermeldungen.md`: Alternative zu Schritt 4.
