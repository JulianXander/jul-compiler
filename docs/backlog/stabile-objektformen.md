# Stabile Objektformen und optionale Felder

Ausgearbeitet aus Punkt 1 von [js-performance-plan.md](../js-performance-plan.md). Entwurf, noch nicht
umgesetzt. Ziel: Alle Werte eines Record-Typs haben zur Laufzeit dieselbe Hidden Class, damit Feldzugriffe
monomorph bleiben und Spread-Kopien den schnellen Pfad nehmen. Dazu soll JSON vollständig abbildbar
werden, also ein fehlender Schlüssel und `null` unterscheidbar. Voraussetzung sind die geschlossenen
Record-Typen ([geschlossene-records.md](geschlossene-records.md)).

## Modell

**Zwei Arten von Feldern, die Wahl ist explizit:**

| Feld | im Literal | zur Laufzeit | JSON | Form |
|---|---|---|---|---|
| `b: Or([] X)` | muss stehen, auch als `b = []` | Schlüssel immer da, Empty ist `undefined` | `"b": null` | stabil |
| `b?: X` | darf fehlen | Schlüssel fehlt oder hat einen Wert | Schlüssel fehlt | variiert |

- **Kein Auffüllen.** Ein Literal nennt jedes Feld ohne `?`. Was im Literal steht, steht im Objekt. So
  machen es Rust, OCaml, F#, Elm und TypeScript (`b: X | undefined` gegen `b?: X`). Still aufgefüllt wird
  in Go, Java und C#, dort gilt es als Fehlerquelle, weil ein vergessenes Feld wie ein absichtlich leeres
  aussieht.
- **Strenge Prüfung überall:** im Checker, bei JSON- und YAML-Importen, in der Laufzeit-Typprüfung
  (`isDictionaryLiteralOfType`) und bei `parseJson` mit Typ. Ein Feld ohne `?` muss als Schlüssel
  vorhanden sein, ein fehlender Schlüssel passt nur auf `?`. Eine Ausnahme für Fremddaten gibt es nicht:
  Darf ein Schlüssel fehlen, sagt das der Typ.
- **Kein eigener `Null`-Wert.** JSON-`null` ist Empty, ein fehlender Schlüssel ist ein fehlendes `?`-Feld.
  `toJson` schreibt Empty wie heute als `null` und lässt ein fehlendes Feld weg.
- **`deepEqual`, `toJson` und die Builtins über Schlüssel bleiben**, wie sie sind: „fehlt“ und „Empty“ sind
  verschiedene Werte mit verschiedenen Typen, die Laufzeit darf sie unterscheiden.
- **TS-Importe:** `b?: X` wird `b?: Or([] X)` (TypeScript lässt bei `?` ohne `exactOptionalPropertyTypes`
  auch `undefined` zu), `b: X | undefined` wird `b: Or([] X)`.

**Zuweisbarkeit:**
- Ziel `b: T`: Die Quelle muss `b` haben (nicht `?`), mit einem Typ in `T`.
- Ziel `b?: T`: Die Quelle darf `b` nicht haben, `b?: S` oder `b: S` haben, jeweils mit `S` in `T`.
- Ziel ohne `b` (geschlossen): siehe offene Fragen.

## Kanonische Reihenfolge: alphabetisch (verworfen)

Gemessen ohne Nutzen, siehe Schritt 4. Der folgende Abschnitt beschreibt, was erwogen wurde.

Der Emitter schreibt die Schlüssel eines Dictionary-Literals alphabetisch sortiert. Dafür braucht er
keinen Typ. Weil jedes Literal alle Felder ohne `?` nennt, haben alle Literale eines Typs dieselbe
Schlüsselmenge und damit dieselbe Form.

- **Ein Spread, der nur überschreibt**, bleibt stabil: `[...card face = §up§]` wird `{...card, face: 'up'}`.
  `card` hat `face` schon, JS überschreibt an Ort und Stelle. Das ist der typische Fall bei
  Zustandsupdates, also der heiße Pfad im Profil.
- **Unabhängig vom Typ:** Ein Feld im Typ umzustellen oder einzufügen ändert keine Form. Wer JSON erzeugt,
  kann ohne Kenntnis der JUL-Typen mitmachen (Schlüssel beim Schreiben sortieren).
- **Nebenwirkungen:** `toJson` gibt die Schlüssel alphabetisch aus, der Debugger zeigt sie so. Die
  Feldwerte werden in sortierter Reihenfolge ausgewertet, für reine Ausdrücke ist das gleich. Zu prüfen
  ist, ob ein Testaufruf oder `log` das beobachten kann.
- **Felder mit `?`** variieren in ihrer Anwesenheit, die vorhandenen stehen trotzdem sortiert.

**Zweite Stufe, mit Typ: erweiternde Spreads.** `[...base status = x]` mit `base` ohne `status` hängt
`status` hinten an. Ob ein Feld neu ist, weiß nur der Typ der Quelle. Mit ihm schreibt der Emitter das
Ergebnis vollständig und sortiert aus (`{a: base.a, …, status: x, …}`), ohne Laufzeitarbeit:
- Ein Feld nimmt den Wert der letzten Stelle im Literal, deren Typ es kennt.
- Bei einer Union geschlossener Records als Quelle zählt die Vereinigung der Felder, ein fehlendes Feld ist
  dort Empty. Alle Varianten haben dann eine Form.
- Eine Quelle, die keine Referenz ist, kommt einmal in eine Hilfsvariable.
- `?`-Felder der Quelle werden nur übernommen, wenn sie da sind, sonst würde aus „fehlt“ ein Empty.
- Ohne geschlossenen Record-Typ der Quelle (Any, Dictionary(X), Verengung aus einem Branch) bleibt der
  einfache Spread, die Stelle bleibt polymorph.

Ohne Typ ginge das nur zur Laufzeit (Schlüssel der Quelle lesen, mischen, neu aufbauen), bei jedem Update.
Das sind die langsamen Pfade, die wegfallen sollen. Erst `undefined` vorzubelegen und dann zu spreaden war
im Mikrotest langsamer als heute (91 gegen 79 ms).

**JSON-Daten** haben die Reihenfolge der Datei. Generierte Dateien sortieren beim Schreiben. Wo der Typ
beim Erzeugen bekannt ist, kann der Import (einmal beim Laden) oder `parseJson` mit Typ die Objekte sortiert
aufbauen. Nur, wenn solche Objekte im Profil megamorph auftauchen.

## Prototyp und Messung

`stableShapeDictionaryToJs` in `src/compiler/emitter.ts`, aktiv mit `JUL_STABLE_SHAPES=1`. Er bildet noch
das ältere Modell ab: Typreihenfolge statt alphabetisch, weggelassene Empty-Felder aufgefüllt, Spreads mit
Typ ausgeschrieben. Für die Form ist das gleichwertig mit „alle Felder geschrieben, sortiert, erweiternde
Spreads ausgeschrieben“. Die Zahlen sind also die Obergrenze dessen, was beide Stufen zusammen bringen.

**bench-runtime**, Fixture `object-shapes.jul` (Karten wie `GameCard`, zwölf Literale mit verschiedenen
optionalen Feldern), Mediane aus drei abwechselnden Läufen am 24.10.2026:

| Fall | ohne | mit |
|---|---|---|
| `object-shapes/attackRound` (Spread je Karte, dann Feldzugriffe) | 1335 bis 1367 ms | 353 bis 380 ms |
| `object-shapes/sumAtk` (nur Feldzugriffe) | 177 bis 201 ms | 149 bis 165 ms |
| `record-update/nextTwice` | 42 bis 50 ms | 21 bis 23 ms |
| `field-access/unitScore` | 14 bis 17 ms | 16 bis 18 ms |

`record-update` liest nur ein Feld des neuen Records. Mit ausgeschriebenen Feldern kann V8 die Allokation
wegoptimieren, der Gewinn dort ist überzeichnet. `field-access` bekommt seine Objekte aus JS und zeigt
erwartungsgemäß nichts.

**yugioh-Match** (`out-bench/bundle.js 10 lookahead greedy`), abwechselnd:

| Lauf | ohne | mit |
|---|---|---|
| 1 | 165,6 s | 126,4 s |
| 2 | 171,7 s | 131,6 s |
| 3 | 174,7 s | 137,1 s |

Etwa −23 %, das Spielergebnis ist in allen Läufen gleich (12:8). Die Entscheidungszeiten von Monte Carlo
und MCTS sinken ähnlich (610 auf 490 ms, 410 auf 330 ms). Das Bundle wächst um 6 % (2,85 auf 3,02 MB).

**yugioh-Match nach der Migration (Schritt 2 und 3, ohne Emitter-Änderung):** 143,8 / 145,8 / 146,1 s, gegen 166 bis 175 s
vor der Migration (vier Läufe), Ergebnis jedes Mal 12:8. Das sind etwa 15 %: Schon dass `GameCard` und `GameState`
immer alle Felder haben, bringt den größeren Teil. Die Werte stammen aus verschiedenen Sitzungen, kein strikt
abwechselnder Lauf. Der Prototyp lag mit 126 bis 137 s noch etwa 10 % darunter, vermutlich wegen der
ausgeschriebenen Spreads (Schritt 5).

**yugioh-Tests** mit Flag: 398 von 399. Der Fehlschlag kommt vom Auffüllen: `deepEqual` vergleicht ein
aufgefülltes Objekt (`max: undefined`) mit einem ohne bekannten Typ gebauten, dem der Schlüssel fehlt. Im
neuen Modell gibt es kein Auffüllen, beide Literale müssten `max` nennen oder `max?:` haben.

## Schritte

Je Schritt erst die roten Tests, den roten Lauf zeigen, dann anhalten.

### 0. Baseline
`npm run bench -- --save` und `npm run bench-runtime -- --save` in `jul-compiler`, `npm run bench -- --save`
in `jul-language-server`, der yugioh-Bench mit mehreren Läufen.

### 1. Syntax und Typ für `b?: X` (umgesetzt, Compiler und Language Server grün)
- Parser: `?` hinter dem Feldnamen im Dictionary-Typ (`optional` am Feld, JUL2206 überall sonst). Die
  Grammatik der Extension (`syntaxes/jul.tmLanguage.yaml`) kennt es noch nicht.
- Typdarstellung: `Fields` bildet den Namen auf `{ type, optional }` ab (`CompileTimeField`), `optional`
  steht im Hash und im Typvergleich. `FieldTypes` ist die beim Erzeugen abgeleitete Sicht Name auf Typ für
  Stellen, die nur Typen lesen. Wer Felder kopiert oder mischt, nimmt `Fields`, sonst ginge das
  Kennzeichen verloren.
- Zuweisbarkeit: `b?: X` darf fehlen, ein vorhandenes `b` muss zu `X` passen, eine Quelle mit `?`-Feld passt
  nicht auf ein Pflichtfeld (`Field 'b' may be missing.`). `Or([] X)` als Idiom für „darf fehlen“ gilt bis
  Schritt 2 weiter.
- Spread, Intersection, Overlap, Abbildung über die Felder und Anzeige (`b?: X`) tragen das Kennzeichen mit.
  Bei `[...left ...right]` mit `right/b?: X` ist `b` die Vereinigung aus `left` und `X`.
- Laufzeit: Ein optionales Feld steht als `_optionalField(X)` in `Fields` des Laufzeittyps. Ein fehlender
  Schlüssel passt, ein vorhandener muss zum Typ passen.
- TS-Import: `b?: X` wird `b?: Or(Empty X)`.
- Offen: Language-Server-Anzeige und Completion zeigen `?` noch nicht eigens.

### 2. Strenge Prüfung (umgesetzt)
- `isTypeAssignableForDictionaryLiteral` und `isFieldOptional`: Ein fehlendes Feld ist nur bei `?` erlaubt,
  nicht mehr, weil der Typ Empty enthält.
- JSON- und YAML-Importe: Der aus dem Inhalt inferierte Typ hat fehlende Schlüssel als fehlende Felder,
  die Zuweisung an den Zieltyp prüft wie oben. Noch nicht gesondert getestet, in yugioh gibt es keine
  Fehlstelle.
- Laufzeit: `isDictionaryLiteralOfType` verlangt die Schlüssel der Felder ohne `?` (`key in value`). Danach
  `npm run check-runtime-purity`.
- Dokumentation: Handbuch, Fehlercodes, `design-principles.md`, CLAUDE.md.

### 3. Migration (jul-examples und yugioh erledigt)
- Umgesetzt als `scripts/migrate-optional-fields.mjs` (statt eines Skripts, das `= []` einsetzt): Es macht
  aus `name: Or([] X)` im Dictionary-Typ `name?: X`, mit `--all-empty` `name?: Or([] X)`, mit `--keep` bleiben
  Typen ausgenommen. Ein Feld wird in yugioh nicht nur als literales `[]` geschrieben, sondern auch aus einem
  gelesenen Wert kopiert (`name = other/name`), deshalb ist `?: Or([] X)` die verhaltenserhaltende Form. Die
  stabilen Typen (`GameCard`, `GameState`) blieben ausgenommen, ihre Konstruktoren schreiben jetzt alle Felder
  (GameCard 1, GameState 3 Stellen, dazu ein Testhelfer). Danach `check` sauber und 399 von 399 Tests.
- Ursprünglich geplant: Ein Migrationsskript (`scripts/migrate-*.mjs`) setzt `= []` für fehlende Pflichtfelder ein. Es nimmt die
  Fehlstellen aus dem Checker.
- yugioh: In den Typen entscheiden, welche Felder `?` werden. Interner Zustand (`GameCard`, `GameState`)
  bleibt ohne `?`, damit stabil. `GameCard` wird nur an drei Stellen neu gebaut, alles andere sind Spreads.
- Szenario-Typen (`ScenarioExpectPlayer` und Verwandte) bekommen `?`, die Dateien lassen dort Schlüssel weg.
- `card-data.json`: 3680 Einträge in zwei Schlüsselfolgen, weil `attribute` bei 1416 Zaubern und Fallen
  fehlt. Entweder schreibt das Download-Skript `"attribute": null` (eine Form) oder der Typ wird
  `attribute?: Attribute` (zwei Formen).
- jul-examples.

### 4. Emitter: alphabetisch sortieren (gemessen, verworfen)
- Umgesetzt und wieder ausgebaut: Der Emitter sortierte die Felder eines Literals nach Zeichencode, ohne Typ und nur
  zwischen zwei Spreads. Kein Gewinn:
  - Mikro-Bench (Records in sechs Schreibreihenfolgen, Zugriff auf `hp`): 84 bis 93 ms ohne, 84 bis 91 ms mit.
  - yugioh-Match, drei Paare abwechselnd auf identischem Stand: 143,8 / 145,8 / 146,1 s ohne, 147,1 / 138,7 / 145,6 s
    mit Sortierung, Median 145,8 gegen 145,6 s, Ergebnis jedes Mal 12:8.
  - Grund: Ein Typ wird in yugioh meist an einer Stelle gebaut, alles andere sind Spreads, die die Reihenfolge der
    Quelle erben. Nebenwirkungen (Auswertungsreihenfolge, sortierte `toJson`-Ausgabe) ohne Nutzen.
- Erst wieder aufgreifen, wenn ein Profil zeigt, dass derselbe Typ an mehreren Stellen in verschiedener Reihenfolge
  gebaut wird.

### 5. Spreads mit Typ ausschreiben (gemessen, verworfen)
- Umgesetzt und wieder ausgebaut: Ein Literal, dessen Spreads alle Referenzen mit geschlossenem Record-Typ ohne ?-Felder
  sind, schrieb die Felder einzeln (`'a': x['a']`). Im Mikro-Bench `record-update` 26,5 auf 13,1 ms (−51 %), yugioh-Bundle
  217 auf 112 Spreads. Im Match kein Gewinn: 147,1 / 146,1 s ohne, 147,9 / 147,8 s mit, Ergebnis jedes Mal 12:8. Der
  Mikro-Bench täuscht, V8 kann die Allokation dort wegoptimieren. Ein ?-Feld bedingt einzeln zu kopieren
  (`'b' in x ? { … } : undefined`) war sogar doppelt so langsam wie der Spread (`attackRound` 2,5 gegen 1,3 s).
- Der Rest des Abstands zum Prototyp (126 bis 137 s gegen 145 s nach der Migration) ist damit nicht erklärt, siehe
  Offene Fragen.

### (alt) Erweiternde Spreads mit Typ
Nur, wenn Schritt 4 deutlich unter dem Prototyp bleibt. Zuerst ein Zählinstrument wie `JUL_COUNT_COPIES`,
das je Spread zählt, ob er erweitert und ob der Typ der Quelle bekannt ist.

### 6. Quellen ohne Literal
JSON- und YAML-Daten, `setField` mit neuem Schlüssel, Ergebnisse von `mapDictionary`, TS-Importe. Jeweils
erst messen, ob sie im Profil auftauchen.

## Offene Fragen

- **Woher kam der Rest des Prototyp-Gewinns?** Der Prototyp lag mit 126 bis 137 s etwa 10 % unter dem Stand nach der
  Migration (145 s). Sortieren (Schritt 4) und Spreads ausschreiben (Schritt 5) erklären es nicht. Der Prototyp füllte
  außerdem jedes fehlende Feld eines Literals mit `undefined`, auch bei den Typen, die jetzt `?: Or([] X)` haben.
  Dort bleiben Objekte mit fehlenden Schlüsseln und damit verschiedenen Formen. Zu messen: die Zahl der
  Schlüsselfolgen je Typ am Eingang von `applyToGameState`, vor und nach der Migration.

- **Weiteres Feld mit Empty:** Heute darf ein Wert ein Feld, das der Typ nicht nennt, mit Empty haben
  (`[a = 1 b = []]` passt auf `[a: Integer]`). Darauf beruht `noGameUiStateVariantFields` in yugioh. Mit
  der Regel haben Werte eines Typs verschiedene Schlüsselmengen, `deepEqual` unterscheidet sie, die Form
  auch. Ohne sie braucht ein Wechsel zwischen Varianten eine Schreibweise zum Entfernen eines Felds.
- **Feld entfernen:** `[...a b = []]` setzt Empty und entfernt nicht. Ein `?`-Feld wieder fehlen zu lassen
  braucht eine eigene Schreibweise.
