# Designprinzipien

Internes Arbeitsdokument, keine Doku. Zweck: Sprachentwurfs-Fragen entscheidbar machen, ohne
dieselben Argumente jedes Mal neu herzuleiten.

Ein Prinzip ist hier nur, was eine Entscheidung **hätte anders ausfallen lassen können**. Jedes
nennt deshalb, was es verbietet und was es kostet — ein Satz ohne Preis ist keine Entscheidung,
sondern eine Beschreibung. Belegt sind sie an Fragen, die tatsächlich so entschieden wurden.

## Kurzfassung

1. **Klarheit** — Was im Code steht, ist was der Code macht
2. **Freiheit** — Unwissen ist keine Ablehnung, keine gültigen Programme verbieten
3. **Einheitlichkeit** — Keine Ausnahmen, keine Alternativen für dieselbe Sache
4. **Endzustand** — Umstellungskosten sind kein Kriterium

Die Reihenfolge ist die praktizierte Rangfolge aus dem Kollisions-Abschnitt unten; wo dort nichts
belegt ist, ist die Position ein Erfahrungswert, kein gemessener Wert.

## Die Prinzipien im Detail

### 1. Klarheit

Der Leser muss die Bedeutung einer Stelle aus dem ableiten können, was dort steht. WYSIWYG: Es gibt keine verborgene Regel, die die Bedeutung von außen ändert.

#### Details: Woran man erkennt, ob es verletzt ist

- **Wertabhängige Magie:** Eine Regel darf nicht am Laufzeitwert hängen; zwei identische Zeilen müssen dasselbe bedeuten, egal welche Daten durchlaufen.
- **Nichtlokale Magie:** Eine statisch feste Regel ist Magie, wenn man zum Verstehen woanders hinsehen muss.
- **Grenze:** Implizites ist erlaubt, wenn es sich aus dem ableitet, was an derselben Stelle steht (z.B. Typinferenz).

#### Beispiele

- **Verstößt dagegen:** Auto-Spread im Branching — `_branch` entschied an `isRealObject`, ob ein Wert als Argumentkollektion oder Einzelwert behandelt wird. Dieselbe Zeile `x ?` bedeutete je nach Laufzeitwert etwas anderes.
- **Folge davon:** `?(x)` statt `x ?` — präfix explizit, damit es lokal sichtbar ist.
- **Offen:** Default-Export hängt daran, ob *irgendwo sonst* in der Datei eine Definition steht.
- **Fehlermeldungen:** Sie sprechen vom Quelltext, den der Nutzer geschrieben hat, nicht von Compiler-Interna. `multilineParser should parse until end of row` ist in 7 von 14 invaliden Snippets das Einzige, was der Nutzer sieht — gemeint ist aber `Expected )` oder `assignedValue missing`. Kombinator- und Funktionsnamen sowie Behauptungen über den Compiler sind deshalb in Meldungen verboten.
- **Abwesenheit schreiben:** Das Fehlen eines Werts ist ein eigener Fall, der in der Signatur sichtbar sein muss, nicht geschluckt wird. Kollektionstypen schließen das Leere aus; wer beides zulässt, schreibt `Or([] List(X))` (`Empty` nur, wenn die Eingabe empty sein kann oder die Implementierung selbst empty erzeugt — `slice` ja, `map` nicht).

#### Kosten

Zeichen und Wiederholung (`?(x)` ist länger als `x ?`); Parser-Aufbau für gute Meldungen — erst großzügig konsumieren, dann prüfen, sonst erzeugt eine strenge Regex nur eine Sammelmeldung; `Or([] List(X))` steht in `core-lib.jul` überall, laut, absichtlich.

---

### 2. Freiheit

Wo der Checker etwas nicht auflösen kann, fällt er zugunsten des Programms aus: Union statt Auswahl, weiter Typ statt enger, kein Fehler statt falscher Fehler. Auf Sprachebene heißt dasselbe Prinzip: Ein semantisch sinnvolles, gültiges Programm wird nicht verboten, nur um eine designmäßige Invariante zu erzwingen.

#### Details

- **Checker-Ebene:** „Nicht entscheidbar" darf nie zu „passt nicht" werden.
- **Sprach-Ebene:** Die Sprache arbeitet *mit* dem Benutzer, nicht gegen ihn — dieselbe Haltung, nur aufs ganze Sprachdesign angewendet statt nur auf den Checker.

#### Beispiele

- **Bedingte Typen:** nicht auflösbarer Typ ⇒ Union aller Zweigergebnisse.
- **Branching-Folding:** nur falten, wenn das Matching entscheidbar ist, sonst Union.
- **Index auf Wert:** `1/2` wird still zu `Any`, weil `dereferenceIndexFromObject` `integerLiteral` nicht kennt und `hasKnownLength` false ist.
- **Branching ohne catchAll:** Exhaustive Pattern Matching wird **nicht erzwungen** — das würde bedingte Ausführung (if-ohne-else) verbieten und zu unsinnigen `() => undefined`-Fallbacks zwingen, wie in Rust, wo der Programmierer gegen die Sprache kämpft statt mit ihr zu arbeiten. Stattdessen gehört `Error` in den Rückgabetyp: ehrlich statt repressiv.

#### Kosten

Verpasste Fehler beim Checker — das ist der bewusste Preis. Auf Sprachebene: keine erzwingbare Exhaustivität; kann später als *optionales* Feature dazukommen, ohne die Semantik zu ändern.

#### Beleg

[TODO](../TODO), Abschnitte zu Constant Folding und bedingten Typen; umgesetzt in `case 'branching'` in [checker.ts](../src/checker.ts).

---

### 3. Einheitlichkeit

Wenn ein neues Konstrukt einen Sonderfall in einer bestehenden Regel braucht, ist zuerst die Regel zu ändern. Zwei Schreibweisen für dasselbe sind ebenso keine Ausnahme, sondern derselbe Fehler: eine Entscheidung, die jeder Leser und Schreiber jedes Mal neu treffen muss.

#### Details

Eine allgemeine Regel mit Ausnahmenliste ist teurer als eine strengere Regel ohne. Sonderfälle einzeln zu reparieren führt zu Code-Wildwuchs. Wo es zwei Schreibweisen für dieselbe Sache gibt, ist eine zu streichen — oder beiden ein eigener Zweck zu geben, sodass es wieder zwei Sachen sind.

#### Beispiele

- **Typen und Länge:** Tupel in ihrer Länge exakt zu machen wäre die Ausnahme — Dictionaries lassen überzählige Felder zu, `f(1 2)` und `f(a = 1 b = 2)` sind derselbe Aufruf. Stattdessen: Ein Typ nennt Anforderungen, kein vollständiges Bild.
- **Checker-Helfer:** Fünf separate Funktionen (`getElement`, `lastElement`, `length`, `setElement`, `map`), die alle über `Or` verteilen und bei Unbekanntem zurückfallen — war eine Ausnahmenliste. Richtig wäre ein Konstrukt statt fünf Fällen.
- **Klammer-Regel:** rund = Bindungsstelle, eckig = Daten — ausnahmslos.
- **Keine Magie für Typen:** Was für Typen gebraucht wird, wird zuerst als gewöhnlicher Wert bzw. gewöhnliche Funktion versucht, statt einer Ausnahme extra Typ-Syntax zu geben. `Or`, `And`, `Not`, `TypeOf`, `Without` sind normale Funktionen, nicht Syntax. Bedingte Typen sind heute schon ausdrückbar, aber nur als `Or(And(And(TypeOf(a) Integer) …) …)` — unbenutzbar. Erst wenn das unlesbar bleibt, ist die Ausnahme (neue Syntax) gerechtfertigt (Schwelle, an der `:?` gerade steht).
- **Spread:** `x` und `...x` bedeuten Verschiedenes → beide erlaubt, weil es zwei verschiedene Sachen sind, keine Ausnahme.
- **Offen:** `() => x` und `Any => x` matchen beide jeden Wert und sind für Typverengung gleichwertig — sind sie zu verbieten oder kommt eines weg?

#### Kosten

Umstellung der gesamten Codebasis (die Klammer-Regel brauchte ein Migrationswerkzeug); Lesbarkeit an der Grenze zur neuen Typ-Syntax; Bequemlichkeit im Einzelfall, Arbeit an Altlasten.

---

### 4. Endzustand

Umstellungskosten sind kein Kriterium. Zu bewerten ist allein, welche Sprache dauerhaft besser zu schreiben und zu erklären ist.

#### Details

- Verbietet: „bleibt so, weil eine Änderung teuer wäre" als Argument.
- Kostet: wiederholte Migrationen fremder Codebasen.
- **Verfallsdatum:** Gilt nur, solange die Sprache in Entwicklung ist — das ist der aktuelle Zustand. Sobald die Sprache als fertig erklärt wird, kippt das Prinzip in sein Gegenteil: Breaking Changes sind dann für immer ausgeschlossen, unabhängig davon, wie gut das bessere Endziel wäre. Die anderen Prinzipien kennen diesen Bruch nicht.

#### Beispiel

Das Infix-Branching mit Auto-Spread hätte alles bleiben können, weil es nichts kostet. Aber nach diesem Prinzip war das egal.

## Wenn Prinzipien kollidieren

Sie tun es regelmäßig. Die bisher praktizierte Rangfolge (daraus ergibt sich die Gewichtung oben):

- **Klarheit schlägt Kürze.** Sichtbarkeit im Quelltext vor weniger Zeichen — der ganze Auto-Spread-Fall.
- **Klarheit schlägt Einheitlichkeit.** Verlangt die Sichtbarkeit eine zweite Schreibweise — `x` und
  `...x` —, ist das kein Verstoß gegen Einheitlichkeit: die beiden bedeuten dann Verschiedenes, und genau
  das ist der Zweck.
- **Freiheit schlägt Schärfe.** Ein verpasster Fehler ist billiger als ein falscher.
- **Freiheit schlägt Lesbarkeit — bis zu einem Punkt.** Erst wenn ein realer Fall im
  bestehenden System ausgeschrieben unlesbar bleibt, ist neue Syntax dran. Das ist die Schwelle,
  an der `:?` gerade steht.
- **Einheitlichkeit schlägt Endzustand.** Kohärenz vor Umstellungskosten, siehe Klammer-Regel.
- **Klarheit schlägt Vertrautheit.** Kein Konstrukt, nur weil andere Sprachen es so schreiben.

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
   Die Zahlen sagen, *was anzufassen ist*, nicht *was sich lohnt* (Prinzip Endzustand).
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
