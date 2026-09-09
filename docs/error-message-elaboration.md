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

