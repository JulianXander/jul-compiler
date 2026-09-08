# Designprinzipien

Internes Arbeitsdokument, keine Doku. Zweck: Sprachentwurfs-Fragen entscheidbar machen, ohne
dieselben Argumente jedes Mal neu herzuleiten.

Ein Prinzip ist hier nur, was eine Entscheidung **hätte anders ausfallen lassen können**. Jedes
nennt deshalb, was es verbietet und was es kostet — ein Satz ohne Preis ist keine Entscheidung,
sondern eine Beschreibung. Belegt sind sie an Fragen, die tatsächlich so entschieden wurden.

## Die Prinzipien

### 1. Was der Code bedeutet, muss im Code stehen

Der Leser muss die Bedeutung einer Stelle aus dem ableiten können, was dort steht. Das schließt
zwei Sorten Magie aus:

**Wertabhängige.** Eine Regel darf nicht am Laufzeitwert hängen; zwei identische Zeilen müssen
dasselbe bedeuten, egal welche Daten durchlaufen. Auto-Spread im Branching — `_branch` entscheidet
an `isRealObject` —, die Arity-Regel für `?(...myList)`, stille Leerwerte
(`myStream ? (a) => a` bindet `()`).

**Nichtlokale.** Auch eine statisch feste Regel ist Magie, wenn man zum Verstehen woanders
hinsehen muss. `export default` hängt in [src/emitter.ts](../src/emitter.ts) daran, ob *irgendwo
sonst* in der Datei eine Definition steht — dieselbe letzte Zeile ist mal Export, mal nicht, und
man sieht es ihr nicht an.

**Die Grenze:** Implizites ist erlaubt, wenn es sich aus dem ableitet, was an derselben Stelle
steht. Typinferenz bleibt deshalb richtig — der Typ folgt aus dem Wert, der direkt danebensteht.
Diese Grenze ist die eigentliche Aussage des Prinzips; „keine Magie" allein wäre zu viel verlangt
und würde die Sprache treffen, die es schützen soll.

- **Kostet:** Zeichen und Wiederholung. `?` ist die häufigste Kontrollstruktur der Sprache, und
  die gewählte Form `?(x)` macht jedes Branching um ein bis zwei Zeichen schwerer; konsequent
  angewandt braucht auch der Default-Export ein eigenes Wort statt der Regel „letzter Ausdruck".
- **Entschied:** Auto-Spread im Branching abgeschafft, obwohl Beibehalten nichts gekostet hätte.
  `_branch` entschied bislang an `isRealObject`, ob ein Wert als Argumentkollektion oder als
  Einzelwert behandelt wird — dieselbe Zeile `x ?` bedeutete je nach Laufzeitwert etwas anderes.
  Das Branching steht seitdem präfix mit runder Argumentliste, `x ?` wurde zu `?(x)`; was die
  Umstellung im Einzelnen bedeutete, steht im Kopfkommentar von
  [scripts/migrate-branching.mjs](../scripts/migrate-branching.mjs).
- **Offen:** der Default-Export. Nach diesem Prinzip ist die aktuelle Regel ein Verstoß, der noch
  in keiner Liste steht.

### 2. Bei einer Ausnahme ist die Regel falsch, nicht der Fall

Wenn ein neues Konstrukt einen Sonderfall in einer bestehenden Regel braucht, ist zuerst die
Regel zu ändern. Eine allgemeine Regel mit Ausnahmenliste ist teurer als eine strengere Regel
ohne.

- **Verbietet:** Sonderfälle einzeln zu reparieren. Vgl. `getElement`, `lastElement`, `length`,
  `setElement`, `map` im Checker — fünf Helfer, die alle dasselbe tun (über `Or` verteilen,
  `parameterReference` auflösen, bei Unbekanntem zurückfallen). Richtig wäre ein Konstrukt statt
  fünf Sonderfällen.
- **Kostet:** Umstellung der gesamten Codebasis. Die Klammer-Regel hat genau das ausgelöst und
  ein eigenes Migrationswerkzeug nötig gemacht
  ([scripts/migrate-brackets.mjs](../scripts/migrate-brackets.mjs)).
- **Entschied:** rund = Bindungsstelle, eckig = Daten — ausnahmslos, statt der vorherigen
  Mehrdeutigkeit. Ergebnis: `() => x` und `[] => x` bedeuten heute Verschiedenes, ohne dass eine
  Zusatzregel das erklären muss.
- **Entschied:** Ein Typ nennt Anforderungen, kein vollständiges Bild — ein Wert darf sie
  übertreffen. Verworfen wurde, Tupel in ihrer Länge exakt zu machen: Dictionaries lassen
  überzählige Felder zu, exakte Positionen wären also die Ausnahme von einer Regel, der die Namen
  folgen — und in JUL sind `f(1 2)` und `f(a = 1 b = 2)` derselbe Aufruf gegen dieselbe
  Parameterliste. Dass andere Sprachen das trennen (TypeScript: Objekte weit, Tupel exakt), trägt
  hier nicht: dort sind es zwei Konstrukte, hier wäre es eine Ausnahme innerhalb eines einzigen.
  Zusätzlich hängt die core-lib daran — ein einstelliger Callback an `map` ist nur zulässig, weil
  weniger zu fordern erlaubt ist. Gemeldet wird deshalb nicht der längere Wert, sondern nur das
  hingeschriebene Argument, das nirgends ankommt (`JUL2500`).

### 3. Ein Weg pro Sache

Zwei Schreibweisen für dasselbe sind kein Komfort, sondern eine Entscheidung, die jeder Leser und
jeder Schreiber jedes Mal neu treffen muss. Wo es zwei gibt, ist eine zu streichen — oder beiden
ein eigener Zweck zu geben, sodass es wieder zwei Sachen sind.

- **Verbietet:** einen neuen Mechanismus neben einem bestehenden, der dasselbe kann. Die runde
  Argumentliste am Branching wurde auch deshalb gewählt, weil ihr Spread — `?(...myList)` — der
  bestehende Argumentlisten-Spread aus `function-call.jul` ist und keine zweite Spread-Regel
  einführt.
- **Kostet:** Bequemlichkeit im Einzelfall, und es erzeugt Arbeit an Altlasten, die niemanden
  stören. `() => x` und `Any => x` matchen beide jeden Wert und sind für die Typverengung
  gleichwertig — in [TODO](../TODO) steht dazu „nur noch eine Stilfrage". Nach diesem Prinzip ist es
  keine Stilfrage, sondern ein offener Punkt.
- **Offen:** ob `(a: MyType) => …` und `MyType => …` immer äquivalent sind. Wenn ja, ist eine der
  beiden Formen zu viel.

### 4. Unwissen ist keine Ablehnung

Wo der Checker etwas nicht auflösen kann, fällt er zugunsten des Programms aus: Union statt
Auswahl, weiter Typ statt enger, kein Fehler statt falscher Fehler. „Nicht entscheidbar" darf nie
zu „passt nicht" werden.

- **Verbietet:** Typregeln, die im Zweifel ablehnen — auch wenn sie dadurch schärfer wären. Bei
  bedingten Typen heißt das ausdrücklich: nicht auflösbarer Typ ⇒ Union aller Zweigergebnisse.
- **Kostet:** verpasste Fehler. `1/2` wird still zu `Any`, weil `dereferenceIndexFromObject`
  `integerLiteral` nicht kennt und `hasKnownLength` false ist. Das ist der Preis, nicht ein
  Verstoß.
- **Entschied:** Branching-Constant-Folding — nur falten, wenn das Matching entscheidbar ist,
  sonst weiter Union.

Beleg: [TODO](../TODO), Abschnitte zu Constant Folding und bedingten Typen.

### 5. Kein Feature, das nur Typen können

Alles, was für Typen gebraucht wird, wird zuerst als gewöhnlicher Wert bzw. gewöhnliche Funktion
versucht. Eine zweite Sprache neben der Sprache gibt es nicht.

- **Verbietet:** Typkonstrukte mit eigener Syntax, solange eine Funktion in
  [src/core-lib.jul](../src/core-lib.jul) reicht. `Or`, `And`, `Not`, `TypeOf`, `Without` sind
  normale Funktionen.
- **Kostet:** Lesbarkeit an der Grenze. Bedingte Typen sind heute schon ausdrückbar, aber nur als
  `Or(And(And(TypeOf(a) Integer) …) …)` — unbenutzbar. Erst wenn ein realer Fall so weit
  getrieben ist und immer noch unlesbar bleibt, ist neue Syntax gerechtfertigt.
- **Entschied:** dass die offene Frage `:?` heißt und nicht „Typsprache" — ein Operator im
  bestehenden System, kein Parallelsystem.

### 6. Abwesenheit wird geschrieben, nicht geschluckt

Das Fehlen eines Werts ist ein eigener Fall, der in der Signatur auftaucht. Kollektionstypen
schließen das Leere aus; wer beides zulässt, schreibt `Or([] List(X))`.

- **Verbietet:** leere Kollektionen als stille Mitglieder von `List(X)`, und `Empty` im
  Rückgabetyp „zur Sicherheit". `Empty` gehört nur hinein, wenn die Eingabe empty sein kann
  **oder** die Implementierung selbst empty erzeugt.
- **Kostet:** `Or([] List(X))` steht in `core-lib.jul` überall. Das ist laut, absichtlich.
- **Entschied:** `slice` hat `Empty` im Rückgabetyp (`return sliced.length ? sliced : undefined`),
  `map` nicht — dort bleibt die Länge gleich.

### 7. Die Einrückung ist die Struktur

Was die Einrückung schon zeigt, wird nicht noch einmal geschrieben. Ein Konstrukt, das einen
mehrzeiligen Block klammern oder abschließen muss, ist kein JUL-Konstrukt.

- **Verbietet:** schließende Klammern über Blockgrenzen. Deshalb umfasst die runde Klammer des
  Branchings nur den gebranchten Wert — die Branches bleiben im eingerückten Block darunter,
  ohne Abschluss.
- **Kostet:** der Parser trägt `rows`, `rowIndex`, `columnIndex` und `indent` durch alle
  Kombinatoren, und mehrzeilige Konstrukte (vgl. `multiline returntype parser` in [TODO](../TODO))
  sind einzeln zu bauen statt gratis zu bekommen.

### 8. Halbfertiger Code ist der Normalfall

Der Compiler wird beim Tippen aufgerufen, nicht erst am Ende. Toleranz gehört in Parser und
Checker, Strenge an die Ausgabe.

- **Verbietet:** Werfen bei unvollständigen Ausdrücken; ein Konstrukt ohne sinnvolle Teil-Parse.
- **Kostet:** die Strenge muss anderswo nachgeholt werden — die CLI bricht explizit bei
  Parse-Fehlern ab, bevor der Emitter einen unvollständigen Baum sieht.
- **Entschied:** die Architektur, in der Language Server und CLI dieselbe Pipeline und dasselbe
  `ParsedDocuments` benutzen, statt zweier Frontends mit verschiedener Strenge.

### 9. Die Fehlermeldung gehört zur Sprache

Eine Meldung spricht über das, was der Nutzer geschrieben hat oder hätte schreiben sollen. Sie
ist Teil des Sprachentwurfs, nicht Ausgabe des Compilers.

- **Verbietet:** Kombinator- und Funktionsnamen in Meldungen, und Meldungen als Behauptung über
  den Compiler. `multilineParser should parse until end of row` ist in 7 von 14 invaliden
  Snippets das Einzige, was der Nutzer sieht; gemeint ist je nach Fall `Expected )` oder
  `assignedValue missing`.
- **Kostet:** Parser-Aufbau. Erst großzügig konsumieren, dann prüfen (vgl. `indexParser`) — eine
  strenge Regex lehnt korrekt ab, hinterlässt aber Restzeichen und erzeugt genau diese
  Sammelmeldung.

### 10. Der Endzustand zählt, nicht der Weg dahin

Umstellungskosten sind kein Kriterium. Zu bewerten ist allein, welche Sprache dauerhaft besser zu
schreiben und zu erklären ist.

- **Verbietet:** „bleibt so, weil eine Änderung teuer wäre" als Argument. Genau daran ist der
  Vorschlag gescheitert, das Infix-Branching mit Auto-Spread zu belassen: er war nur vertretbar,
  weil er nichts kostet.
- **Kostet:** wiederholte Migrationen fremder Codebasen. `C:\Projects\privat\yugioh` hängt
  ungepinnt an diesem Compiler und bricht bei jeder Sprachänderung.
- **Gilt so lange**, wie die Sprache in Entwicklung ist. Dieses Prinzip hat ein Verfallsdatum,
  die anderen nicht.

## Wenn Prinzipien kollidieren

Sie tun es regelmäßig. Die bisher praktizierte Rangfolge:

- **1 schlägt Kürze.** Sichtbarkeit im Quelltext vor weniger Zeichen — der ganze Auto-Spread-Fall.
- **1 schlägt 3.** Verlangt die Sichtbarkeit eine zweite Schreibweise — `x` und `...x` —, ist das
  kein Verstoß gegen 3: die beiden bedeuten dann Verschiedenes, und genau das ist der Zweck.
- **2 schlägt 10.** Kohärenz vor Umstellungskosten, siehe Klammer-Regel.
- **4 schlägt Schärfe.** Ein verpasster Fehler ist billiger als ein falscher.
- **5 schlägt Lesbarkeit — bis zu einem Punkt.** Erst wenn ein realer Fall im bestehenden System
  ausgeschrieben unlesbar bleibt, ist neue Syntax dran. Das ist die Schwelle, an der `:?` gerade
  steht.
- **7 schlägt Vertrautheit.** Kein Konstrukt, nur weil andere Sprachen es so schreiben.

## Wie eine Entscheidung getroffen wird

1. **Ist-Zustand am Code beschreiben**, nicht aus der Erinnerung. Beim Auto-Spread im Branching
   stellte sich heraus, dass `isRealObject` etwas anderes prüfte als gemeint war. Dazu gehört,
   die **benachbarten Konstrukte danebenzulegen**: Ob an einem Konstrukt etwas fehlt oder ob dort
   die Regel der Sprache steht, sieht man erst im Vergleich. Bei der Tupel-Länge sah „zu kurz
   meldet, zu lang nicht" nach einer Lücke aus — bis Dictionary und Parameterliste danebenlagen
   und dasselbe taten.
2. **Die begrenzende Randbedingung vorab benennen**, sonst wird eine Option diskutiert, die es
   nicht gibt.
3. **Optionen ausschreiben, inklusive „alles bleibt"**, alle an demselben Beispielcode.
   Verworfene bleiben mit Begründung stehen.
4. **An echtem Code auszählen** — yugioh (~5800 Zeilen) und [../jul-examples](../../jul-examples).
   Die Zahlen sagen, *was anzufassen ist*, nicht *was sich lohnt* (Prinzip 10).
5. **Performance-Behauptungen messen, nicht schätzen**, vor und nach dem Umbau und am größeren
   Ziel. Aufrufzahlen und Laufzeit sind verschiedene Größen und stehen nicht füreinander ein:
   Der Cache für `resolvePlaceholders` sparte 99 % der Aufrufe und nur 17 % der Zeit — zu wenig
   gegen das Risiko, dass Typen nach dem Erzeugen noch mutiert werden. Das kostet zwei Messläufe
   je Umbau, und niemand ruft sie automatisch auf.
6. **Abhängigkeiten zu offenen Punkten prüfen.** Ein anderer Fix kann die Frage vorwegnehmen: bei
   Auto-Spread hat die fehlende Verengung für Feldpfade fast alle typbezogenen Argumente
   aufgelöst.
7. **Empfehlung mit Begründung**, und benennen, welches Prinzip den Ausschlag gab.

Große Fragen bekommen ein eigenes Dokument neben diesem, kleine bleiben in [TODO](../TODO). Die
Grenze ist praktisch: sobald es Optionen mit Kosten auf beiden Seiten gibt, lohnt das Dokument.
