# Umsetzungsplan: Positionen für Teilfehler (Elaboration)

## Ziel

`getTypeError`/`TypeError` bleiben unverändert — position-los, schnell, ohne Abhängigkeit zu
AST-Knoten. TypeScript macht das genauso: Positionen stecken nicht in den Typ-Vergleichs-
Strukturen, sondern die "Elaboration" läuft komplett daneben, auf der ohnehin vorhandenen
AST-Expression (die hat längst echte Positionen), und wiederholt die Prüfung dort noch einmal,
feld- bzw. elementweise. Für JUL heißt das: eine neue, rein additive Funktion, die **nur im
Fehlerfall** aufgerufen wird, mit der echten `ParseDictionaryLiteral`-Expression und dem Zieltyp -
sie läuft Feld für Feld durch, ruft für jedes Feld erneut `getTypeError` auf dem schon
vorhandenen `field.value.typeInfo.type` auf, und erzeugt bei einem Fehlschlag einen **eigenen**,
zusätzlichen `CompilerError` direkt an der echten Position von `field.value` - kein neuer
Datenweg durch `TypeError` nötig, weil die Position von der AST kommt, nicht vom Typvergleich.

Beispiel für den angestrebten Endzustand: bei

```jul
T = [a: Integer b: Text]
x: T = [a = 1]
```

zeigt der Editor die rote Markierung nicht nur an der ganzen Definition `x: T = [a = 1]`, sondern
zusätzlich eine zweite Markierung dort, wo das fehlende Feld `b` stehen müsste (das `[a = 1]`
selbst), bzw. bei einem falsch getypten, aber vorhandenen Feld direkt am Feld-Wert.

## Verworfener Ansatz: Position in `TypeError`

Erste Idee war, `TypeError` um ein optionales `position`-Feld zu erweitern und diese Position bis
zur Fehlermeldung durchzureichen. Verworfen, weil:

- `getTypeError` hat an der Stelle des Vergleichs gar keine AST-Expression, nur `CompileTimeType`-
  Werte - eine Position könnte nur dort entstehen, wo zufällig ein `declaration`-Verweis am Typ
  hängt (wie bei `dictionaryLiteral`), nicht generell.
- Jede Zwischenstelle, die heute `areArgsAssignableTo` (liefert nur `string`) benutzt, müsste
  stattdessen die Struktur durchreichen - betrifft praktisch jede Fehler-Callsite im Checker,
  großer Blast Radius für einen Nutzen, der ohnehin nur an wenigen Stellen greift.
- Vermischt Zuständigkeiten: der reine Typvergleich müsste AST-Wissen kennen oder zumindest dafür
  vorbereitet sein - genau die Kopplung, die TypeScript bewusst vermeidet.

## Ausgangslage

- `TypeError` (checker.ts) ist `{ message: string; innerError?: TypeError }` — bleibt so.
- `CompileTimeDictionaryLiteralType` trägt für echte Literale schon einen Herkunfts-Verweis:
  `declaration?: { expression: ParseDictionaryLiteral; filePath: string }`, gesetzt in `inferType`s
  `'dictionary'`-Fall. Das ist die Verbindung, die für den ersten Ausschnitt gebraucht wird — sie
  muss nicht neu geschaffen werden. `ParseDictionaryLiteral.fields[].value` trägt bereits
  `typeInfo` (vom regulären Checklauf) und eigene Positionen.
- `getDictionaryLiteralTypeError`/`getDictionaryFieldError` erzeugen bereits die inhaltlich
  richtigen, unterschiedenen Meldungen ("Missing field X" vs. "Invalid value for field X" -
  Fix von heute) - unverändert, liefern weiterhin nur den einen, geflatteten String für die
  Hauptmeldung. Die neue Elaboration läuft daneben, ersetzt sie nicht.
- Motivation, mit konkreten Beispielen aus einer laufenden yugioh-Fehlersuche, in der Session vom
  2026-09-09 dokumentiert (siehe Git-Historie dieses Dokuments für den Kontext, falls nötig).

## Nicht in diesem Plan

- Keine Positionen für Fehler außerhalb von Dictionary-Feldern (Funktionsparameter, Tuple-Elemente,
  Union-Choices) - das ist eine spätere, gleichartige Erweiterung, kein Teil dieses Umbaus.
- Keine Kürzung großer `Or`-Aufzählungen und keine Alias-Kurzanzeige (`typeToString`-Depth) -
  eigenständige, unabhängige Verbesserungen, siehe Diskussion in der Session vom 2026-09-09.
- Keine "did you mean"-Vorschläge (Levenshtein) - eigenständige Erweiterung, setzt auf denselben
  Callsites auf, aber ohne Abhängigkeit von Positionen.

## Plan

### Schritt 1: Roter Test zuerst

`checkTypes` auf dem Beispielcode aus dem Ziel-Abschnitt (`T = [a: Integer b: Text]` /
`x: T = [a = 1]`), erwartet **zwei** Fehler: die bestehende Hauptmeldung an der Definition
**und** eine neue, präzisere an `[a = 1]` selbst (Missing field b). Läuft heute rot, weil es
nur den einen Fehler gibt.

### Schritt 2: Elaborations-Funktion schreiben

Neue Funktion, z.B. `elaborateDictionaryLiteralError`, aufgerufen nur dort, wo heute schon ein
`assignmentError` aus `areArgsAssignableTo` feststeht (zunächst nur `case 'definition'` in
`inferType`, für `x: T = [...]`). Nimmt die Wert-Expression (`value`) und den Zieltyp
(`typeGuardType.type`, aufgelöst). Wenn `value.type === 'dictionary'` und der aufgelöste Zieltyp
`dictionaryLiteral`-Felder hat:

- Für jedes Zielfeld: das entsprechende `value.fields`-Element suchen.
  - Vorhanden → `getTypeError(undefined, resolvePlaceholders(fieldExpr.value.typeInfo.type), targetFieldType)`
    erneut aufrufen; bei Fehler eigenen `CompilerError` an `fieldExpr.value`s Position pushen.
  - Fehlt → eigenen `CompilerError` mit "Missing field X" an der Position des ganzen
    `value`-Ausdrucks pushen (kein spezifischeres Kind vorhanden).
- Rein additiv: die bestehende, schon gepushte Hauptmeldung (an der Definition) bleibt unverändert
  bestehen, die Elaboration ergänzt zusätzliche, genauere Diagnosen daneben.

Danach: Test aus Schritt 1 muss grün sein, `npm test` komplett grün (Snapshot-Baseline ggf. mit
`UPDATE_SNAPSHOT=1` aktualisieren, da eine neue Datei/Fixture mehr Fehler zeigen könnte).

### Schritt 3: Benchmark

`npm run bench -- --save --note "Elaboration fuer fehlende/falsche Dictionary-Felder"` vor und
nach Schritt 2 (vorher-Wert notieren, bevor Schritt 2 beginnt). Die Elaboration läuft nur im
Fehlerfall, sollte also im Normalfall (fehlerfreier Code) keine messbare Auswirkung haben - das
ist hier aber eine Erwartung, keine Ausnahme von der Meßpflicht. Bei Verschlechterung über der
Alarmschwelle: Ursache klären, ggf. verwerfen, nicht committen.

## Reihenfolge und Freigabe

Nach Schritt 1-3: Zwischenstand zeigen, dann entscheiden, ob und wie auf weitere Fälle
(fehlgeschlagene Funktionsargumente, Rückgabetypen) ausgeweitet wird - das sind eigenständige,
gleichartige Ergänzungen derselben Funktion, kein weiterer Strukturumbau.

## Erledigt: generisches Dictionary(T) als Ziel

An einem echten yugioh-Fund (`cardEffects: Dictionary(CardEffect) = [...]`, card-effects.jul)
gezeigt: das ursprüngliche `isDictionaryLiteralType(targetType)` griff dort nicht, weil das Ziel
ein generisches `Dictionary(T)` ist (ein `ElementType`, keine benannten `Fields`) - jeder
geschriebene Eintrag (z.B. eine Karten-ID als Schlüssel) muss gegen denselben `ElementType`
geprüft werden, statt gegen ein festes Feld. `elaborateDictionaryLiteralError` behandelt jetzt
beide Ziel-Formen: `dictionaryLiteral` (Fields, inkl. "Missing field") und `dictionary`
(ElementType, jeder vorhandene Eintrag einzeln, keine "Missing field"-Diagnose möglich - ein
generisches Dictionary fordert keine bestimmten Schlüssel). Rot belegt
(`generic-dictionary-target-elaborates-per-entry`), grün nach Umsetzung, Bench neutral (-5 %,
Rauschen). Am realen yugioh-Fall bestätigt: aus einer Sammelmeldung an einer Position wurden
mehrere Meldungen, je eine pro betroffener Karten-Definition mit eigener Zeile/Spalte.

## Erledigt: Missing-field-Meldungen zu einer Zeile gesammelt

Umgesetzt, siehe [missing-field-message-format.md](missing-field-message-format.md) für Details,
Sprachvergleich und Bench-Ergebnis. Betraf ausschließlich die "Missing field"-Erzeugung in
`getDictionaryLiteralTypeError`/`elaborateDictionaryFieldError`, unabhängig von der A/B/C1/D-Frage
unten.

## Offene Entscheidung: Kopfzeile mit Typnamen vor der Feldliste

Fund an einem realen yugioh-Fall (`draw()` deklariert `:> GameBoard`, liefert aber tatsächlich
`GameState`): `getDictionaryLiteralTypeError` springt direkt in `subErrors.map(...).join('\n')`
(nur "Missing field X, expected Y." je Feld) - anders als der `not`-/`parameterReference`-Fall in
`getTypeError` fehlt hier die sonst überall verwendete Kopfzeile `Can not assign X to Y.` mit
beiden konkreten Typnamen. Damit erkennt man den Fehler nur über den Fehlercode
(`JUL5100` = `returnTypeMismatch`), nicht über den Text - der sieht identisch aus wie ein
gewöhnlicher `JUL5000` an einer Definition. Noch nicht entschieden, welcher der folgenden Wege
gegangen wird - dieser Abschnitt sammelt die Optionen mit Beispiel als Entscheidungshilfe
(Session vom 2026-09-10). Bewertet wird ausschließlich nach Klarheit für den Leser und
Auswirkung auf die LSP-Performance (Diagnose-Größe/-Häufigkeit bei jedem Tastendruck) -
Umsetzungskosten sind für diese Entscheidung kein Kriterium.

### Option A: TS-Kopfzeile

```
Can not assign GameState to GameBoard.
Missing fields: monsters, spellTraps, lifePoints, skippedDrawPhaseCount.
```

- Klarheit: beide Typnamen sofort sichtbar, ohne Fehlercode nachzuschlagen - Basisnutzen,
  aber sagt nicht, dass es speziell um eine Rückgabe geht.
- LSP-Performance: eine zusätzliche kurze Zeile pro Fehler, keine neue Diagnose, kein
  zusätzlicher Compiler-Durchlauf - keine messbare Auswirkung.

### Option B: Elm-Rollensatz ("Rückgabetyp stimmt nicht")

```
Rückgabetyp stimmt nicht: kann GameState nicht als GameBoard zurückgeben.
```

- Klarheit: sagt explizit, dass es um die Rückgabe geht, ohne Fehlercode-Tabelle - schließt
  genau die Lücke, die A offen lässt.
- LSP-Performance: ein fester String-Präfix, keine zusätzliche Diagnose, keine zusätzliche
  Typberechnung - keine messbare Auswirkung.

### Option C: Rust Zwei-Orte-Diagnose

Rust macht hier zwei trennbare Dinge gleichzeitig - unterschiedlich teuer, daher aufgeteilt:

**C1: zweite Position an der Deklaration markieren** (der eigentliche Kern der Idee - beantwortet
nicht nur *dass*, sondern *warum* der Zieltyp gilt):

```
Rückgabetyp stimmt nicht.
  Deklariert als GameBoard hier: game-logic.jul:1828:15
```

- Klarheit: zeigt zusätzlich, WARUM der Zieltyp gilt (Verweis auf die Signatur) - dadurch
  vermutlich die verständlichste der Optionen, besonders bei langen Funktionsrümpfen, wo die
  Signatur beim Lesen der Rückgabe längst aus dem Bildschirm gescrollt ist. Im Editor per Klick
  direkt erreichbar, das kann reiner Text (A/B) nicht bieten.
- Nicht LSP-exklusiv, sondern eine gemeinsame Datenstruktur-Erweiterung: `CompilerError`
  (compiler-errors.ts) hat aktuell nur eine Position/Message, weder CLI noch LSP kennen eine
  zweite. `formatErrors` in compiler.ts (CLI) müsste um eine zweite Zeile erweitert werden,
  server.ts nutzt dafür das schon vorhandene, bisher auskommentierte `relatedInformation`-
  Boilerplate. Gleich einfach an beiden Stellen, aber an keiner heute schon vorhanden.
- LSP-Performance: eine zweite `Diagnostic`/`relatedInformation` je Fehler bedeutet mehr
  Objekte im Diagnose-Payload, der bei jedem Tippen neu an den Client geschickt wird. Bei den
  seltenen, echten Rückgabetyp-Fehlern selbst irrelevant; relevant wird es erst, wenn (wie im
  yugioh-Fund) ein einzelner Tippfehler kaskadierend viele Folgefehler auslöst - dann
  verdoppelt sich die Anzahl der zu serialisierenden Positionen. Ohne Kappung (siehe D) ein
  Multiplikator auf ein bestehendes Problem, kein neues.

**C2: ASCII-Quellcode-Darstellung mit `^^^^^`-Pfeilen im Terminal**:

```
2 | draw = (...) :> GameBoard =>
  |             --------- expected GameBoard because of return type
3 |     newGameState
  |     ^^^^^^^^^^^^ expected GameBoard, found GameState
```

- Klarheit: zusätzliche visuelle Verstärkung nur im CLI-Terminal - im Editor zeigt die
  Squiggle plus Hover (aus C1) dieselbe Information bereits, C2 verbessert dort nichts mehr.
- LSP-Performance: betrifft das LSP gar nicht - reines CLI-Ausgabeformat auf derselben
  `CompilerError`-Erweiterung wie C1, keine zusätzlichen Diagnose-Daten im LSP, kein
  Payload-Effekt. Für die hier relevanten Kriterien ohne Wirkung.

### Option D: Meldungslänge begrenzen (zurückgestellt)

Zurückgestellt: baut auf der noch nicht existierenden Elaboration für Tupel-/Listen-**Literale**
auf (bisher nur für Dictionary-Literale umgesetzt, siehe oben) und ist damit kein unabhängiger
erster Schritt mehr. Grund: ein reiner Zähler (`3×`) verschleiert, welche Elemente betroffen
sind; Indizes in Prosa (`elements 1, 2, 3`) wären nur ein Fallback für den Fall ohne Literal
(z.B. ein Parameter wie `row: Row` ohne eigene Element-Positionen, siehe Diskussion Session
2026-09-10) - andere Sprachen (TypeScript, Elm) lösen das stattdessen über echte Positionen je
Element, wenn ein Literal vorliegt. Bevor hier ein Format festgelegt wird, muss also erst
geklärt sein, ob/wie die Elaboration auf Tupel-/Listen-Literale ausgeweitet wird - ein vorher
geschriebener roter Test (`duplicate-tuple-element-errors-are-deduplicated`) legte ein Format
fest, das dieser Erkenntnis nicht mehr standhielt, und wurde deshalb wieder entfernt (keine
Ausnahme von "roter Test bleibt stehen" - der Test belegte kein Bugverhalten, sondern eine
verfrühte Festlegung auf ein noch offenes Design).

Andere Compiler begrenzen unterschiedlich (weiterhin relevant, sobald ein Format feststeht):

- TypeScript: `is missing the following properties from type 'Y': a, b, c, and N more.` -
  Kappung nach wenigen **benannten** Feldern, die jedes für sich informativ sind.
- Rust: `and N others` bei langen Trait-Kandidatenlisten; sehr lange generische Typnamen werden
  zusätzlich selbst gekürzt (Elision), nicht nur Listen.
- Elm: geht das Problem strukturell an statt zu kappen - zeigt bei Record-Mismatches von
  vornherein nur die **abweichenden** Felder als Diff, nie den ganzen Typ.
- GHC (Haskell): Gegenbeispiel - berüchtigt für unbegrenzt lange Meldungen bei
  Typfamilien-Expansion, reagiert mit Flags (`-fmax-relevant-binds`, `-freduction-depth`) statt
  einem kurzen Default. Lehre: Begrenzung sollte Standard sein, nicht Zusatzoption.
- Scala 3: Standardmeldung bewusst eingedampft, volle Herleitung nur hinter `-explain` auf Wunsch.

Der reale yugioh-Fund (`Can not assign Empty to Integer.` sechsfach) ist aber kein Fall von
vielen verschiedenen benannten Feldern, sondern von **positionslosen Tupel-Elementen**
(`GameCardRow` hat keine Feldnamen) - die 6 Teilmeldungen sind textlich identisch, nur der Index
unterscheidet sich. Eine reine TS-artige "erste N, Rest kappen"-Regel könnte hier zufällig ein
*abweichendes* 4. Element verschlucken, während 3 *identische* stehen bleiben.

- Klarheit: kürzere, weniger repetitive Meldung bei großen Dictionary-/Tupel-Typen möglich - im
  realen yugioh-Fund wurde derselbe Satz `Can not assign Empty to Integer.` sechsmal wiederholt,
  ohne neue Information je Wiederholung. Noch offen, ob das Ziel echte Positionen je Element
  (wie TS/Elm, bei Literalen) oder ein Text-Fallback (ohne Literal) ist - siehe oben.
- LSP-Performance: potenzieller Nutzen unabhängig von A/B/C1 - kappt genau die Art von
  Diagnose-Payload, die bei tief verschachtelten/duplizierten `Or`-Typen unbegrenzt wächst und
  bei jedem Tastendruck neu an den Client geschickt wird. Wirkt am stärksten in Kombination mit
  C1 (das sonst die Duplikate zusätzlich vervielfacht, siehe oben).

A, B und C1 schließen sich nicht aus und sind unabhängig von D umsetzbar. Nach Klarheit und
LSP-Performance allein betrachtet ist C1 die inhaltlich stärkste Einzelmaßnahme (beantwortet die
"warum"-Frage), A und B sind günstige Basisverbesserungen ohne Payload-Risiko. D hätte den
größten Performance-Nutzen bei großen/duplizierten Typen, ist aber wie oben beschrieben an die
Tupel-/Listen-Literal-Elaboration gekoppelt und deshalb zurückgestellt. C2 bleibt ohne Wirkung
auf beide Kriterien (reines CLI-Rendering) und damit nach diesen Kriterien nicht priorisiert.
Noch nicht umgesetzt - vor jeder Umsetzung roter Test zuerst (analog Schritt 1 oben), dann
Umsetzung, dann Bench (insbesondere für C1/D wegen der Payload-Frage).

### Erledigt: A + B + C1 umgesetzt

Nach `design-principles.md`: Fehlermeldungen sprechen vom Quelltext des Nutzers, nicht von
Compiler-Interna (Prinzip 1, Klarheit) - das erfüllen A, B und C1 alle drei, keins verweist auf
Compiler-Internas. "Klarheit schlägt Vertrautheit" heißt aber auch: dass andere Sprachen es so
machen, ist für sich kein Argument - C1 ist nur deshalb umgesetzt, weil es selbst die "warum"-
Frage beantwortet, nicht weil Rust es tut. B wurde nach Einheitlichkeit (Prinzip 3) an **allen**
Push-Stellen mit Rollenwort eingeführt (`definitionTypeMismatch`, `argumentTypeMismatch`,
`returnTypeMismatch`), nicht nur bei der Rückgabe - sonst wäre genau die verbotene Situation
"zwei Fehlerarten, gleiche Struktur, unterschiedlich behandelt ohne Grund" entstanden. D bleibt
zurückgestellt (siehe oben), C2 wurde nicht priorisiert (kein Effekt auf Klarheit/LSP-Performance
über C1 hinaus, reines CLI-Rendering).

Umsetzung:
- **A**: Kopfzeile in `getTypeError`s `case 'dictionaryLiteral':` (checker.ts), ruft
  `typeToString(..., 0, 1)` statt `depth=0` auf - erzwingt die Alias-Anzeige (`GameBoard` statt
  voller Feld-Dump) auch auf dieser obersten Vergleichsebene, da `typeToString` Aliase sonst nur
  ab `depth>0` zeigt (empirisch verifiziert, nicht nur aus dem Code geschlossen).
- **B**: Präfix an allen drei Push-Stellen (`Definition type mismatch.`, `Argument type
  mismatch.`, `Return type mismatch.`).
- **C1**: `CompilerError` (compiler-errors.ts) um optionales `relatedInformation` (Message +
  Position) erweitert; am `returnTypeMismatch`-Push-Ort mit der Position von `declaredReturnType`
  befüllt (Typ dort über `valueOf(resolvePlaceholders(...))`, nicht der rohe `TypeOf(...)`-Meta-
  Typ - sonst hätte die Meldung `Declared as TypeOf(Text) here.` statt `Declared as Text here.`
  gezeigt, an einem Testlauf gefunden). `formatErrors` (compiler.ts, CLI) druckt die Zeile
  zusätzlich als Text; `server.ts` aktiviert das schon vorhandene, zuvor auskommentierte
  `relatedInformation`-Boilerplate.

Rot belegt (`checker.test.ts`): bestehende Tests mit `Definition type mismatch.`/
`Argument type mismatch.`/`Return type mismatch.`-Präfix aktualisiert (Format geändert, Verhalten
unverändert), `map-callback-parameter-infers-element-type-through-alias` um die
`relatedInformation`-Erwartung ergänzt. `npm test` (208 Tests), `npm run typecheck` und der Build
von `jul-language-server` grün. Bench vor/nach C1: +10 % ggü. der letzten Messung, aber
`getTypeError`-Aufrufzahl identisch (492817) - reine Laufzeitstreuung zwischen Durchläufen, weit
unter der Alarmschwelle, keine algorithmische Regression.

Beispiel-Endzustand am realen `draw()`-Fund (`game-logic.jul:1837`, deklariert `:> GameBoard`,
liefert tatsächlich `GameState`):

**CLI-Ausgabe:**
```
game-logic.jul:1837:8 - TypeError JUL5100: Return type mismatch.
Can not assign GameState to GameBoard.
Missing fields: monsters, spellTraps, lifePoints, skippedDrawPhaseCount.
  Declared as GameBoard here. game-logic.jul:1828:15
```

**Im Editor (VS Code) zusätzlich:** dieselbe Diagnose, die letzte Zeile aber als eigener,
eingerückter `relatedInformation`-Eintrag mit Sprungmarke zu `game-logic.jul:1828:15` statt als
Text.

Zeile für Zeile den drei Bausteinen zugeordnet:
- `Return type mismatch.` - B, reines Rollenwort, keine Typnamen (die stehen erst in der
  nächsten Zeile, sonst Dopplung).
- `Can not assign GameState to GameBoard.` - A, die generische Kopfzeile aus
  `getDictionaryLiteralTypeError`, unverändert an jeder Stelle (Definition/Argument/Rückgabe).
- `Missing fields: ...` - bereits umgesetzt, siehe "Erledigt: Missing-field-Meldungen" oben.
- `Declared as GameBoard here. ...` - C1, im CLI eine zusätzliche Textzeile mit Position, im
  Editor die klickbare `relatedInformation`-Referenz auf dieselbe `CompilerError`-Erweiterung.

## Optionale spätere Verbesserung: Darstellung im Language Server

Der Server braucht für die Elaboration selbst nichts: `errors.map(error => diagnostic)`
(jul-language-server/src/server.ts) wandelt jeden Eintrag aus `checked.errors` generisch in eine
eigene, gleichrangige `Diagnostic` um - die zusätzlichen Elaboration-Fehler erscheinen automatisch.

Es gibt dort aber schon unbenutztes, auskommentiertes Boilerplate aus der offiziellen LSP-
Beispielvorlage für `diagnostic.relatedInformation` (geschützt hinter
`hasDiagnosticRelatedInformationCapability`). Das wäre die im LSP-Protokoll vorgesehene,
sauberere Darstellung für genau diesen Fall: die Elaboration-Fehler nicht als eigenständige
Diagnosen, sondern gruppiert **unter** der Hauptmeldung (VS Code zeigt das eingerückt, mit
Sprungmarke zur jeweiligen Stelle). Rein darstellerisch, keine Voraussetzung für die Funktion -
eigenständiger, späterer Schritt, falls gewünscht.

## Offener Punkt: Namen in Meldungen konsequent in Anführungszeichen

Fund (Session 2026-09-10): `Missing field monsters, expected ...` liest sich zweideutig - klingt,
als könnte das Feld selbst "field" heißen und "monsters" etwas anderes sein, statt klar zu
markieren, dass "monsters" der eingesetzte Name ist. Betrifft nicht nur diese eine Meldung:
`checker.ts` setzt Namen an **keiner** Stelle in Anführungszeichen (`${name} is not defined.`,
`Missing field ${fieldName}, ...`, `Got ${valueParameter.name} but expected ...`) - nach
Einheitlichkeit (Prinzip 3) darf das nicht nur an einer Stelle geändert werden, sonst entsteht
die verbotene Situation "zwei Schreibweisen für dieselbe Sache".

Vergleich mit anderen Compilern - fast alle markieren eingesetzte Namen sichtbar:

- **TypeScript**: einfache Anführungszeichen um jeden eingesetzten Namen, durchgängig -
  `Property 'monsters' is missing in type '...'.`, `Cannot find name 'foo'.`.
- **Rust**: Backticks, ebenso durchgängig - `` missing field `monsters` in initializer of
  `GameBoard` ``, `` cannot find value `foo` in this scope ``.
- **Clang/GCC**: einfache Anführungszeichen - `error: 'foo' was not declared in this scope`.
- **Elm**: Backticks um Bezeichner - `` I cannot find a variable named `foo` `` - bei fehlenden
  Record-Feldern zeigt Elm aber lieber den ganzen Diff in `{ }`-Klammern statt einzelne Namen
  zu zitieren (siehe Option D oben).
- **Go**: die Ausnahme - zitiert Namen meist gar nicht (`undefined: foo`), verlässt sich auf
  Satzstellung statt auf Markierung.

Mehrheitlich (TS, Rust, Clang, Elm) wird der eingesetzte Name also sichtbar vom Fließtext
abgesetzt - deckt sich mit JULs eigenem Klarheits-Detail "Fehlermeldungen sprechen vom
Quelltext des Nutzers": die Markierung zeigt genau, welches Wort aus dem Quelltext des Nutzers
stammt und welches feste Compiler-Prosa ist. Eigenständige Entscheidung, unabhängig von der
A/B/C1-Frage oben - noch nicht bewertet, welches Zeichen (Anführungszeichen vs. Backticks) und
ob zuerst hier oder in `TODO` als eigener Punkt geführt wird.

