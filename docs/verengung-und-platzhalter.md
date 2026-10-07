# Verengung und Platzhalter: eine Regel für das Nachschlagen

Plan, noch nichts umgesetzt. Die Verengung eines Parameters (`?(values) [List(X)] => …`) erzeugt
`And(values List(X))`. Jeder Verbraucher, der in diesen Typ hineinschaut, hat sich dafür eine eigene
Sonderregel gebaut, und eine davon fehlt (Schritt 0b). Der Plan ersetzt die Sonderregeln durch
**eine** Regel, so wie TypeScript es mit `getApparentType` für `T & Foo` macht: Nachgeschlagen und
geprüft wird auf dem aufgelösten Typ, gespeichert wird der rohe. Einen eigenen Typknoten für die
Verengung („Refinement“) gibt es vorerst nicht, siehe „Zurückgestellt“.

Hintergrund: [CHECKER-AUDIT.md](CHECKER-AUDIT.md), Abschnitt „Fallen im Checker“, und der
Doku-Kommentar an `resolvePlaceholders` in [type-algebra.ts](../src/checker/type-algebra.ts).

## Ausgangslage

Was im Code steht (alles gelesen, nicht nur aus der Doku):

- Die Verengung hat schon eine Umgebung: `TypeContext.narrowedTypes` (`NarrowedTypes`, je
  `SymbolDefinition` eine Liste von Pfaden mit verengtem Typ), gepflegt mit `withNarrowedType` und
  `withNarrowedPath`, gelesen mit `getNarrowedType`. Eine Referenz liefert
  `getNarrowedType(...) ?? deklarierter Typ` (`case 'reference'`). Die Verengung gilt nur im Rumpf des
  branches, es gibt nichts zusammenzuführen.
- Der Eintrag entsteht in `narrowBranchedType`: `And(aktueller Typ, Typ des branches)`, minus
  `Not(vorherige branches)`. Ist der aktuelle Typ ein unaufgelöster Platzhalter (ein Parameter,
  `parameterReference`), steht danach `And(values List(X))` im Baum. `withNarrowedPath` baut für
  Feldpfade `And(Quelle, [feld: …])`.
- Hover und Checker-Snapshot zeigen immer den **aufgelösten** Typ
  (`typeToString(resolvePlaceholders(...))`), der rohe Typ ist für den Nutzer nicht sichtbar.

Der rohe Typ eines verengten Parameters hat je nach Zweig verschiedene Formen (gemessen, `n: Integer`):

| Code | roher Typ von `n` im Zweig |
|---|---|
| zweiter Zweig, `[1] => … [Integer] => n` | `And(n Not(1))` |
| `?(n) [Or(1 2 3)]` | `Or(And(1 n) And(2 n) And(3 n))` (das `And` wird über das `Or` verteilt) |
| zweimal verengt (`[Not(0)]`, dann `[Not(1)]`) | `And(And(n Not(0)) Not(1))` (verschachtelt, nicht zusammengefasst) |
| zwei verschiedene Parameter | `And(n Not(0))` und `And(m Not(1))`, getrennt je Symbol |

Sonderregeln, die es deshalb heute gibt (jeweils im Code mit Kommentar belegt):

| Stelle | Behandlung |
|---|---|
| `getNarrowedType` | löst auf, wenn die Quelle ein `and` ist, damit das Nachschlagen eines Feldes klappt |
| `case 'nestedReference'` (Index und Name) | schlägt erst im rohen, dann im aufgelösten Typ nach, weil `dereferenceIndexFromObject` und `dereferenceNameFromObject` kein `and` kennen |
| `getArgumentPurity` | steigt eigens in `and` ab, sonst fällt ein verengter Parameter durch |
| `functionCall`, erwarteter Callback-Typ | löst den Empfänger auf; mit rohem `And(values List(X))` wäre der Elementtyp des Callbacks `Any` (Test `callback-param-type-after-match-on-list`) |

Alle prüfen auf `julType === 'and'`. Die Form `or` aus der zweiten Zeile erreichen sie nicht. Ob das
heute zu einem sichtbaren Fehler führt, ist nicht gezeigt.

Das Audit (`CHECKER-AUDIT.md`) hat dasselbe Muster schon einmal gemessen: zwölf Falschfehler im
realen Projekt, bei allen Tests grün, weil auf dem rohen Typ nachgeschlagen und anhand des
aufgelösten entschieden wurde.

## Ziel

**Eine Regel, an einer Stelle:** Wer einen Typ nachschlägt oder prüft (Feld, Index, `ElementType`,
Purity, erwarteter Callback-Typ am Aufruf), bekommt dafür den aufgelösten Typ, sobald der rohe Typ ein
**zusammengesetzter** Typ mit Platzhalter ist (`and`, `or`). Ein bloßer Platzhalter bleibt roh, denn
der Zugriff darauf liefert einen aufgeschobenen Knoten, der für Generizität nötig ist (siehe den
Kommentar in `case 'nestedReference'`).

Die Regel gilt nur an Stellen, die **nachschlagen oder prüfen**. Gespeichert wird weiter der rohe
Typ. Damit löst sich die Verwechslung mit Signaturen von selbst: Ein `And` mit Platzhalter in einer
Signatur, etwa der Rückgabetyp von `range`
(`And(Integer Or(start Greater(start)) Not(Greater(end)))`, siehe
[backlog/integer-range.md](backlog/integer-range.md)), wird nie gespeichert aufgelöst, nur beim
Nachschlagen. Das entspricht dem Doku-Kommentar an `resolvePlaceholders`: nur für Prüfung und
Anzeige.

Die Hilfsfunktion (Arbeitsname `getLookupType`, in `type-algebra.ts`) ersetzt die vier Sonderregeln
oben. Sie prüft das Flag `isUnresolvedPlaceholder` und den `julType`, nicht nur `and`.

## Nicht Teil dieses Plans

- Ein eigener Typknoten für die Verengung (siehe „Zurückgestellt“).
- Starre Variablen im Rumpf und `Any` als Rückfall für Nicht-Auflösbares.
- Einsetzen und Auswerten für die Typ-Arithmetik, stehenbleibende Anwendungen und Bedingungen.
- Die Stellen, die einen aufgelösten Typ **speichern** (Spread in Listen, Tupeln und Dictionaries,
  `withCompletedStream`). Sie sind lokal begründet.

## Vorgehen

Jeder Schritt wird einzeln gemessen, wie in `CHECKER-AUDIT.md` verlangt: erst ein roter Test mit
vollständigem `errors`-Objekt, dann der Fix. Abnahme jedes Schritts:

1. alle Tests grün, Checker-Snapshot unverändert (Zähler-Baseline nur nach Ansehen neu schreiben)
2. `yugioh`: Warnungen nicht mehr als 49, keine neuen Fehler (neue Meldungen einzeln ansehen)
3. Beispiel-Korpus: der Checker-Snapshot deckt `jul-examples` und die core-lib ab
4. `npm run bench -- --save` vor und nach dem Schritt

**Schritt 0 — Messen und Tests.** Erledigt, siehe „Stand Schritt 0“.

**Schritt 0b — Fehlerprüfung nach der Verengung. Erledigt.** Die drei roten Tests sind grün.
`getNarrowedType` dereferenzierte die Schlüssel hinter dem verengten Pfad mit
`dereferenceNestedKeyFromObject`, die für ein fehlendes Feld `Empty` bzw. `Or(Empty X)` liefert. Das
ging in `case 'nestedReference'` still als verengter Typ durch. Jetzt nutzt `getNarrowedType` dieselben
Funktionen wie die reguläre Prüfung (`dereferenceNameFromObject`, `dereferenceIndexFromObject`), die
`undefined` für ein fehlendes Feld liefern. Ohne Treffer entscheidet die reguläre Prüfung und meldet den
Fehler. Damit entfällt auch die frühere Frage, wie sich ein fehlendes Feld von einem Feld mit dem Typ
`Empty` unterscheiden lässt.

Ergebnis: alle 1276 Tests grün, Snapshot und Zähler unverändert, Bench-Median etwa 1240 ms (vorher
1200 bis 1250). In yugioh gibt es einen neuen Fehler, ein echter Fund: `main.jul:219`,
`lingeringEffect/selectionTargets/gameCardId`. `SelectInputTargets` hat nur `gameCardIds`. Die
Verengung `?(lingeringEffect/selectionTargets) [Empty] => … () => …` hat das bisher verdeckt. Dazu
verschiebt sich eine Warnung (`main.jul:209` neu, `game-logic.jul:1060` weg). Der Code in yugioh ist
nicht angepasst.

**Schritt 1 — `getLookupType`. Erledigt.** Die Hilfsfunktion steht in `type-algebra.ts` neben
`resolvePlaceholders`: Ein `and` oder `or` mit Platzhalter wird aufgelöst, ein bloßer Platzhalter bleibt
roh. Eingesetzt ist sie an den drei Stellen, die nachschlagen: `getNarrowedType` und `case
'nestedReference'` für Index und Name. Die zwei Stellen mit „erst roh, dann aufgelöst“ haben damit
einen Auflösungsschritt weniger und tragen die Form `or` mit.

Nicht umgestellt, mit Grund:
- `getArgumentPurity` steigt in die Teile eines `and` ab, es schlägt nichts nach und löst nichts auf.
  Es ist eine Strukturregel und keine Nachschlageregel.
- `functionCall`, erwarteter Callback-Typ: Der Empfänger wird dort schon immer aufgelöst, nicht nur
  bei zusammengesetzten Typen (siehe Kommentar im Code). Das ist eine andere, weitergehende Regel.

Ergebnis: alle 1276 Tests grün, Snapshot und Zähler unverändert, yugioh unverändert gegenüber Schritt
0b (1 Fehler, 49 Warnungen), Bench-Median etwa 1240 ms. **Ein roter Test für die Form `or` war nicht
möglich:** Vier Prüffälle (Feld, Index, Callback-Parameter nach einer Verengung auf eine Vereinigung)
liefern schon vorher die richtigen Ergebnisse, über den Rückfall auf den aufgelösten Typ. Der Schritt
ist deshalb ein reiner Umbau ohne sichtbare Änderung des Verhaltens.

**Schritt 2 — Aufräumen. Erledigt.** Die Kommentare an den umgestellten Stellen sind angepasst (sie
nennen nicht mehr „das `and`“ als Sonderfall), der Kommentar an `resolvePlaceholders` verweist auf
`getLookupType`, und `CHECKER-AUDIT.md` nennt die Regel zum Nachschlagen. Der Doku-Kommentar an
`resolvePlaceholders` selbst war schon vorher richtiggestellt worden.

## Stand Schritt 0

Gemessen am heutigen Checker (Tests in `checker.test.ts`, Gruppe „Verengung eines Parameters“):

- **Rot, drei Tests:** Nach einer Verengung meldet das Nachschlagen eines fehlenden Feldes oder
  Index **keinen** Fehler, ohne Verengung schon (`field-on-narrowed-dictionary-parameter-is-checked`,
  `field-on-narrowed-list-parameter-is-checked`, `element-field-on-narrowed-list-parameter-is-checked`).
  Ursache (am Code bestätigt): `getNarrowedType` dereferenziert den fehlenden Schlüssel im verengten
  Typ, `dereferenceNestedKeyFromObject` liefert dafür `Empty` statt `undefined`, und
  `case 'nestedReference'` kehrt damit früh zurück, ohne die Fehlerprüfung darunter. Das hat mit der
  Darstellung der Verengung nichts zu tun und ist eigens zu beheben.
- **Grün, drei Schutztests:** verengter Feldpfad bleibt benutzbar, der Rückgabetyp bleibt konkret
  (`List(Integer)`), und das `And` mit Platzhalter in `range` bleibt unangetastet.
- **Nicht umgesetzt:** der Purity-Fall (`getArgumentPurity` mit `And(a Not(0))`). Ich habe keinen
  Auslöser gefunden, der ihn erreicht.
- **Ausgangsstand:** yugioh 49 Warnungen, Snapshot-Baseline des Beispiel-Korpus unverändert
  (`checker-snapshot.baseline.txt`), Bench-Median etwa 1200 bis 1250 ms.

## Zurückgestellt: eigener Typknoten `Refinement(Source, Bound)`

Gedacht war ein Knoten, der die Verengung eines Platzhalters eindeutig darstellt: `Source` der
Platzhalter, `Bound` die Einschränkung (immer eine Ebene, `Or` im `Bound` statt verteilt). Er würde die
Formen oben vereinheitlichen und den Compiler an jedes `switch` über `julType` erinnern.

Zurückgestellt, weil
- TypeScript dasselbe Problem mit einem gewöhnlichen Schnitt `T & Foo` und einer zentralen Auflösung
  löst (nach meinem Wissen, nicht neu geprüft),
- an den Nachschlage- und Prüfstellen die Verwechslung mit Signaturen entfällt (siehe „Ziel“),
- der Knoten etwa 17 `switch`-Fälle auf `nestedReference` und 23 Stellen mit `and` berührt, mit der
  Normalisierung als Hauptrisiko.

**Entscheidungskriterium:** nach Schritt 1 wieder aufnehmen, wenn
1. nach der Hilfsfunktion Verbraucher übrig bleiben, die zwischen Verengung und Signatur
   unterscheiden müssten, oder
2. die Form `Or(And(…))` oder die Verschachtelung `And(And(…))` nachweislich Fehler verursacht, oder
3. das langfristige Ziel (nächster Abschnitt) angegangen wird, denn dort ist `Source` die Variable
   und `Bound` ihre Grenze.

Regeln für den Fall, dass er kommt: Verengt man ein `Refinement(n, B1)` erneut, ergibt das
`Refinement(n, B1 ∩ Einschränkung)`, `Source` bleibt der Platzhalter, es gibt nur eine Ebene.
Verschiedene Parameter haben getrennte Einträge in `narrowedTypes` und beeinflussen sich nicht.
Feldpfade verschmelzen über die vorhandene Dictionary-Regel. Ein `Bound` aus `Never` ergibt `Never`.
Aufgelöst ist `Refinement(n, B)` gleich `resolve(n) ∩ B`, also dasselbe wie das `And` heute.

## Langfristiges Ziel

Ein einziger Mechanismus statt der heutigen Mischung aus `parameterReference`, `nestedReference`,
`resolvePlaceholders`, `argumentContext` und den `*FromTypes`-Funktionen.

**Typ-Arithmetik bleibt.** `add`, `subtract`, `Greater` und die bedingten Typen (`:?`, siehe
[backlog/conditional-types.md](backlog/conditional-types.md)) sind Typfunktionen: Ihr Rückgabetyp ist
ein Term über den Argumenttypen (`Add(TypeOf(args))`, `Greater(add(a 1))`). Das bleibt so, ein Term
wird nur klarer von seinem Ergebnis getrennt.

Ein Typ ist ein Term:

```
Typ ::= Konkret                     Integer, List(X), 5, ...
      | Variable(Parameter)         der Typ des Arguments an dieser Stelle (heute parameterReference)
      | Projektion(Typ, Name)       TypeOf(values)/ElementType            (heute nestedReference)
      | Anwendung(Typfunktion, Typ...)   Add(...), Greater(...)
      | Bedingung(Typ, Zweige)      :?(...)
```

Drei Operationen, die heute in `traversePlaceholders` und `resolvePlaceholders` vermischt sind:

| Operation | Bedeutung | heute |
|---|---|---|
| **Einsetzen** (Substitution), danach **Auswerten** | Variablen durch Typen ersetzen und danach auswerten, soweit alle Argumente konkret sind (Add, Fold-Budget, `:?`-Zweige). Was sich nicht auswerten lässt, bleibt als Term stehen. | `traversePlaceholders` mit `argumentContext`, `*FromTypes` |
| **Obergrenze** | der größte Typ, in den jedes mögliche Argument passt, für Prüfungen: eine Variable wird durch ihre Grenze ersetzt, eine stehengebliebene Bedingung durch die Vereinigung ihrer Zweige. Kein `Any` als Rückfall. | `resolvePlaceholders` |
| Verengung | ändert die Grenze einer Variable in einer Umgebung, nicht den Term | `narrowedTypes`, heute mit `And(Platzhalter X)` als Eintrag |

Daraus folgt für die Arithmetik:

- Mit konkreten Argumenten wird ausgewertet wie heute, die Konstantenfaltung bleibt
  (`add(2 3)` ergibt `5`).
- Im Rumpf einer Funktion bleibt `Add(Variable(a) 1)` als Term stehen und wird erst beim Aufruf von
  außen eingesetzt. Das löst die offene Zeile in der [TODO](../TODO): „ein Aufruf im Rückgabetyp
  faltet nicht am Aufrufort: `Greater(add(a 1))` ergibt `Greater(Integer)`“.
- Die dreiwertige Zuweisbarkeit ([three-valued-assignability.md](three-valued-assignability.md))
  bleibt: *yes*, wenn die Obergrenze zuweisbar ist, *no*, wenn Obergrenze und Ziel disjunkt sind,
  sonst *unknown*.

Zu beachten, wenn es gebaut wird: Die Obergrenze einer Bedingung ist nicht die Bedingung der Obergrenzen,
deshalb die Vereinigung aller Zweige. Die Auswertung rekursiver Typfunktionen braucht weiter das
Fold-Budget. Starre Variablen im Rumpf melden strengere Fehler als `Any`, das widerspricht dem
Prinzip „im Zweifel permissiv“ und muss bewusst entschieden werden. Ein präziserer Typ kann sehr
teuer sein (siehe `CHECKER-AUDIT.md`), jeder Schritt wird deshalb gemessen.

### Was dieser Plan davon umsetzt

| Baustein des Ziels | Dieser Plan |
|---|---|
| Verengung ändert die Grenze in einer Umgebung | schon so gebaut (`narrowedTypes`) |
| Obergrenze als einzige Auflösung für Prüfungen | `getLookupType` für verengte Typen, an den Nachschlage- und Prüfstellen |
| Variable mit Grenze als eigene Darstellung | nicht (zurückgestellt, `Refinement`) |
| Einsetzen und Auswerten, stehenbleibende Anwendungen und Bedingungen | nicht Teil dieses Plans |
| starre Variablen im Rumpf statt `Any` | nicht Teil dieses Plans |
| Speichern von aufgelösten Typen beim Spread | nicht Teil dieses Plans |

## Umsetzungsplan für das langfristige Ziel

Grundlage ist eine Untersuchung des Codes (Zeilennummern können sich verschieben, die Namen der
Funktionen bleiben). Sie ändert das Bild von oben deutlich: **Das Modell gibt es zu großen Teilen
schon.** (Das „Bild von oben“ ist der Abschnitt „Langfristiges Ziel“.)

Was es schon gibt:
- **Einsetzen:** `traversePlaceholders` mit `argumentContext` (aufgerufen über
  `dereferenceArgumentTypesNested`, 9 Stellen). Es ersetzt Platzhalter durch Argumenttypen.
- **Auswerten und stehenbleibende Terme:** Die Funktionen `mapElementsFromTypes`, `concatFromTypes`,
  `addFromTypes`, `withElementAtFromTypes`, `createConditionalType` (das `:?`) und
  `getLengthFromType` bleiben **symbolisch** (als eigener Knoten), solange ein Operand ein
  unaufgelöster Platzhalter ist, und werten sonst sofort aus. Am Aufrufort werden sie beim Einsetzen
  neu ausgewertet (`add` über `:?` und `addFromTypes`).
- **Obergrenze:** Die Zuweisbarkeit behandelt einen Parameter-Platzhalter als Quelle schon über seinen
  deklarierten Typ (`dereferenceParameterTypeFromFunctionRef`).
- Ein Parameter hat im Rumpf als Typ einen frischen `ParameterReference`, den deklarierten Typ erreicht
  man nur über `functionRef`.

Was **nicht** zum Plan gehört: `Add`, `Concat`, `MapElements`, `GreaterInteger` und weitere werden in
`getReturnTypeFromFunctionCall` **nach ihrem Namen** behandelt und nicht aus der Deklaration
abgeleitet. Das widerspricht „Keine Magie für Typen“ (`design-principles.md`), ist aber ein eigenes
Thema.

Der Plan hat fünf Schritte. Die Reihenfolge ist Zielbild-Schritt 1, dann 2 und 3 unabhängig voneinander, dann 4,
dann 5. Jeder Schritt hat dieselbe Abnahme: alle Tests grün, Checker-Snapshot und Zähler-Gate
unverändert (oder nach Ansehen bewusst neu geschrieben), yugioh bei 1 Fehler und 49 Warnungen
(Stand nach Schritt 0b), Bench-Median etwa 1240 ms. Neue Meldungen sind Funde und werden einzeln
angesehen. Erst ein roter Test, dann der Fix. Namen im Code werden ausgeschrieben, ohne Kürzel.

**Zielbild-Schritt 1 — Obergrenze benennen** (reiner Umbau, kleiner Aufwand). *Ursprünglicher Plan, zum größten Teil zurückgenommen, siehe den Absatz darunter.*
- `getParameterUpperBound(reference)` in `type-algebra.ts`: liefert den deklarierten Typ eines
  Parameter-Platzhalters, oder den **Grund**, warum es keinen gibt (kein `functionRef`, die Parameter
  der Funktion sind keine `parameters`, der Parameter hat keinen Typ, Index außerhalb ohne
  Rest-Parameter). Heute ergibt jeder dieser Fälle ohne Unterscheidung `Any` (`traversePlaceholders`,
  `case 'parameterReference'`, nur Auflösung ohne Kontext). Die Gründe braucht Zielbild-Schritt 4.
- `getUpperBound(type)`: das heutige Verhalten von `resolvePlaceholders`, als Name für Prüfungen. Die
  rund 37 Stellen, die prüfen (Zuweisbarkeit, Teilmenge, Überlappung, Erschöpfung von branches,
  Rückgabetyp, Callback-Reinheit), rufen es auf. Anzeige und Speichern behalten
  `resolvePlaceholders`. Das ist ein mechanisches Umbenennen, der Aufruf bleibt derselbe.
- `isTypeAssignable` nutzt für einen Parameter-Platzhalter als Quelle `getParameterUpperBound`.
- Tests: die vorhandenen, die das heutige Verhalten festhalten (unter anderem
  `generic-return-type-survives-branching`, `chained-generic-call-checks-element-type`,
  `predicate-with-unknown-purity-is-accepted`, `params-type-unknown-is-not-reported`, die Gruppe „Warnung
  bei unknown“). Neu: je ein Test für die vier Gründe.
- Risiko: gering. Es ändert sich nichts am Ergebnis.

**Zielbild-Schritt 1: umgesetzt und zum größten Teil wieder zurückgenommen.** Er war die Vorbereitung für
Zielbild-Schritt 4. Nachdem der verworfen wurde (siehe dort), hat er keinen Verbraucher mehr:
- `getUpperBound` (dünne Hülle um `resolvePlaceholders`, 36 umbenannte Aufrufe) und die Gründe
  (`missingReason`) in `getParameterUpperBound` samt ihren sechs Tests sind **zurückgenommen**. Zwei Namen
  für dasselbe wären verwirrender als nützlich, und niemand las die Gründe.
- **Geblieben ist** `getParameterUpperBound(reference)` in `type-algebra.ts`: der deklarierte Typ eines
  Parameter-Platzhalters oder `undefined`. Es ersetzt `dereferenceParameterTypeFromFunctionRef` an allen
  vier Stellen (zwei in `type-algebra.ts`, zwei in `checker.ts`), nur als klarerer Name.
- Die Einteilung der Aufrufe von `resolvePlaceholders` in „prüfend“ und „Anzeige oder Speichern“ (36 und
  rund 20 Stellen, selbst eingeordnet) bleibt als Analyse hier stehen: prüfend sind Zuweisbarkeit,
  Teilmenge, Überlappung, Erschöpfung und Erreichbarkeit von branches, Typwächter, Reinheit, Rückgabetyp und
  Argumentprüfung. Speichernd oder anzeigend sind Fehlertexte, die IDE, Spread und Stream, die
  Erwartungstypen am Aufruf, die Verengung, die Rekursion in `traversePlaceholders` und der Emitter.
- Ergebnis nach dem Zurücknehmen: 1282 Tests grün, yugioh unverändert (1 Fehler, 49 Warnungen).

**Zielbild-Schritt 2 — Einsetzen: eine Funktion, Lücken ansehen** (kleiner bis mittlerer Aufwand).
- `dereferenceArgumentTypesNested` (9 Stellen) bekommt den Namen `substituteArgumentTypes`, nur wenn
  das beim Lesen hilft.
- Die einzigen Stellen, an denen Einsetzen `Any` liefert, sind der Rest-Parameter ohne bekannte
  Positionen (`dereferenceParameterFromArgumentType`) und `addFromTypes` für einen nicht auflösbaren
  Argumenttyp (ergibt `Integer`). Für jede: entscheiden, ob das gewollt ist (dann kommentieren) oder
  ein Fund (dann roter Test).
- Risiko: gering.

**Zielbild-Schritt 3 — Stehenbleibende Terme, grobe Rückfälle finden** (mittlerer Aufwand, unabhängig von 2).
- Der erste, **reproduzierte** Fall (TODO „ein Aufruf im Rückgabetyp faltet nicht am Aufrufort“):
  `f = (a: Integer) :> GreaterInteger(add(a 1)) => add(a 2)` meldet `Return type mismatch. Can not
  assign Integer to GreaterInteger(Integer)`, obwohl der Code stimmt: `add(a 1)` wird im Rumpf mit der
  Obergrenze von `a` zu `Integer` ausgewertet. Erwartet: keine Meldung (nicht beweisbar, aber auch
  nicht widerlegt). Ursache vermutlich der Vergleich in `case 'functionLiteral'` (deklarierter gegen
  inferierten Rückgabetyp, beide über `resolvePlaceholders`), vor dem Fix bestätigen.
- Die anderen groben Rückfälle durchgehen, jeweils entscheiden: gewollt (kommentieren) oder ein Knoten:
  `mapElementsFromTypes` bei unbekannter Quelle (`Or(Empty List(Any))`), `withElementAtFromTypes` bei
  unbekannter Art der Quelle (`Any`), `createConditionalType` ohne passenden Zweig (`Never`),
  `dereferenceUnknownKeyFromObject` für Dictionaries (laut Kommentar bewusst `Any`, aus Leistungsgründen)
  und die vielen `return builtinAny` in `getReturnTypeFromFunctionCall` bei fehlenden Argumenten.
- Ein Fund pro roter Test. Risiko: mittel, denn ein genauerer Typ kann teuer sein (siehe
  `CHECKER-AUDIT.md`), also jeweils messen.

**Zielbild-Schritt 3 ist erledigt.** Der erste Fall (Grenze mit unbekanntem Wert) war der einzige Fund.
- **Ursache anders als vermutet.** Nicht der Vergleich von deklariertem und inferiertem Rückgabetyp war
  falsch, sondern die Zuweisbarkeit mit einer Grenze als Ziel: Bei `GreaterInteger(add(a 1))` steht im
  Typ für den Wert der Grenze sein Typ (`Integer`) oder ein Platzhalter, und `isTypeAssignable` lieferte
  dafür ein sicheres **Nein**, selbst für `5` (`case 'bound'` auf der Zielseite, `break` ohne Ergebnis).
  Der Rückgabetyp zeigte deshalb `GreaterInteger(Integer)` und meldete bei korrektem Code einen Fehler.
- **Fix:** Ist der Wert einer ganzzahligen Grenze nicht bekannt und die Quelle eine ganze Zahl (Integer,
  Literal oder Grenze mit bekanntem Wert), ist das Ergebnis *unknown* statt *nein*. Ein Nicht-Integer
  (etwa Text) bleibt *nein*, Grenzen mit bekanntem Wert bleiben entschieden wie bisher.
- **Gilt auch für die Float-Familie:** Eine Float-Quelle (Float, Float-Literal, Grenze mit Float) ist einer
  Float-Grenze mit unbekanntem Wert *unknown* zuweisbar, alles andere weiterhin nicht.
- **Tests:** `return-type-with-bound-of-unknown-value-is-not-rejected` (Checker, war rot), vier
  Einheitentests zur Zuweisbarkeit (drei waren rot, darunter einer für Float) und eine Gegenprobe für
  Literal-Grenzen.
- **Ergebnis:** 1288 Tests grün, Snapshot und Zähler unverändert, yugioh unverändert (1 Fehler, 49
  Warnungen), Bench-Median etwa 1200 bis 1290 ms.
- **Zur Anzeige und zur TODO-Zeile „ein Aufruf im Rückgabetyp faltet nicht am Aufrufort“:** Als Wert einer
  Grenze steht im Typ immer der **Typ des Wertes**. Das ist die Darstellung, kein Fehler: `GreaterInteger(a)`
  mit `n: PositiveInteger` ergibt am Aufrufort `GreaterInteger(PositiveInteger)`,
  `GreaterInteger(add(a 1))` ergibt `GreaterInteger(GreaterInteger(1))`, und mit einem Literal wird gefaltet
  (`f(5)` ergibt `7`). Die Zeile in der TODO beschreibt also einen Stand, der am Aufrufort nicht mehr
  zutrifft. Was bleibt, ist ein Funktionsumfang: Die Grenze selbst zu berechnen (`add(n 1)` größer
  als 2 beweisen) bräuchte symbolische Arithmetik über Werte, das gehört nicht in diesen Plan.

**Zielbild-Schritt 2 ist erledigt, ohne Änderung des Verhaltens.** Beide Stellen sind als gewollt
eingeordnet und im Code kommentiert (`type-algebra.ts`):
- `dereferenceParameterFromArgumentType`, Rest-Parameter ohne bekannte Positionen: `Any`, weil sich nicht
  bestimmen lässt, was der Rest hinter den einzelnen Parametern sammelt. Vier Proben (Spread, benannte
  Argumente, Rest hinter einem und hinter zwei Einzelparametern) melden vorher einen anderen Fehler. Ein
  Fall, in dem das `Any` etwas Sichtbares verdeckt, ist nicht gefunden. Als Alternative käme die Obergrenze
  des Rest-Parameters in Frage (`getParameterUpperBound`), das habe ich nicht umgesetzt, weil kein Test
  einen Gewinn zeigt.
- `addFromTypes`, Argumente weder Tuple noch Liste: `Integer`, eine grobe, aber gültige Obergrenze.
- Die Umbenennung von `dereferenceArgumentTypesNested` habe ich nicht gemacht, sie hilft beim Lesen nicht
  genug.

**Zielbild-Schritt 3, übrige Rückfälle durchgesehen** (an der Quelle gelesen, nicht verändert):
- `mapElementsFromTypes` bei unbekannter Quelle (`Or(Empty List(…))`): gewollt, der Code kommentiert, dass
  die Quelle auch leer sein kann.
- `withElementAtFromTypes` bei unbekannter Art der Quelle (`Any`): gewollt, nur `setElement` nutzt es, und
  für Dictionaries gibt es `setField`.
- `createConditionalType` ohne passenden Zweig (`Never`): gewollt (das Never-Idiom aus
  `backlog/conditional-types.md`).
- Dictionary-Literal mit unbekanntem Schlüssel oder als Quelle von `setField` (`Dictionary(And(Any
  Not(Empty)))`): gewollt, der Kommentar im Code und `CHECKER-AUDIT.md` nennen das Leistungsventil
  (die Vereinigung aller Felder eines großen Literals ließ die Laufzeit von 3,6 s auf 14,4 s steigen).
- `getReturnTypeFromFunctionCall`, `return builtinAny`: gelesen. Es sind Importfehler (Pfad fehlt, Datei nicht
  geladen, keine Ausdrücke) und die Typkombinierer (`And`, `Or`, `Not`, `TypeOf`, `GreaterInteger`, `LessInteger`,
  `ElementAt`, `LengthOf`) bei Argumenten ohne bekannte Positionen (Spread, benannte Argumente, leer). Die
  Autoren haben dort `TODO unknown?` vermerkt. Gewollt, kein Fall mit sichtbarer Wirkung gefunden.
- Ergebnis: kein weiterer Falschfehler gefunden.

**Zielbild-Schritt 4 — Starre Variablen im Rumpf** (großer Aufwand, größtes Risiko, nach 1 bis 3).
- Heute ist ein Platzhalter als **Ziel** der Zuweisbarkeit *unknown* (`isTypeAssignable`,
  `case 'parameterReference'` und `case 'nestedReference'` auf der Zielseite, jeweils mit TODO), als
  Quelle schon eine Obergrenze. Starr hieße: Ein Wert ist einem Platzhalter nur zuweisbar, wenn es
  derselbe Platzhalter ist (oder `Never`).
- Der Rückfall auf `Any` bei nicht auflösbarem Platzhalter wird nach dem Grund getrennt: Ein Parameter ohne
  Typ bleibt unbekannt, ein deklarierter, aber nicht auflösbarer Typ bekommt eine Obergrenze. (Dafür gab es
  die Gründe in `getParameterUpperBound`, sie sind zurückgenommen und wären bei einem neuen Versuch
  wieder einzuführen.)
- Vorgehen **mit Messung vor der Entscheidung:** hinter einem Schalter (wie die Warnung bei unknown),
  dann zählen, wie viele neue Meldungen im Beispiel-Korpus, in der core-lib und in yugioh entstehen.
  Nur übernehmen, wenn sie echte Funde sind. Die Signaturen der core-lib (`nativeFunction`, `List`,
  `Dictionary`) sind voller Platzhalter als Ziel, dort ist mit vielen neuen Meldungen zu rechnen.
- Tests, die das heutige Wohlwollen festhalten und angesehen werden müssen:
  `expected-type-placeholder-of-enclosing-function`, `generic-dictionary-target-elaborates-per-entry`,
  `naming-case-generic-return-is-free`, `predicate-accepts-unknown-value-inside-parameter-type`.
- Es kann sein, dass das Ergebnis lautet: nicht übernehmen. Das ist ein gültiger Ausgang.

**Zielbild-Schritt 4: gemessen und die acht Abweichungen einzeln bewertet. Entscheidung: nicht übernehmen.**

Gemessen mit einem Schalter (Umgebungsvariable, wieder entfernt): Ein Platzhalter als Ziel von
`isTypeAssignable` ist nur sich selbst zuweisbar (starr). Weil die Definitions- und die Rückgabeprüfung das
Ziel vorher mit `resolvePlaceholders` auflösen, kam ein Platzhalter dort nie als Ziel an. Für die Messung wurden
beide Stellen auf roh umgestellt (Quelle und Ziel).

- **Echte Projekte: nichts.** yugioh bleibt bei 1 Fehler und 49 Warnungen, die vier Beispielprojekte
  bleiben fehlerfrei, die `core-lib` hat in beiden Fällen 0 Meldungen. Im Beispiel-Korpus (Snapshot) ändert
  sich nur der Text einer vorhandenen Meldung.
- **Tests: 21 weichen ab.** 13 davon nur im Meldungstext (derselbe Fehler, die Meldung nennt den
  Platzhalter statt der Obergrenze). Die übrigen **acht** wurden einzeln gelesen:

| Test | Was passiert | Bewertung |
|---|---|---|
| `callback-return-type-from-type-parameter-is-checked`, `...accepts-matching-value` | Neuer Fehler für den Rumpf der Fixture-Funktion `f = (T: Type …) :> T => 0` | **berechtigt**: Die Funktion gibt `0` für beliebiges `T` zurück. Der Fixture-Code ist falsch, nicht die Meldung |
| `predicate-with-unknown-purity-is-accepted` | `g = (a: p) => a` mit einem Prädikat `p` als Typ, `g(v)` wird abgelehnt (`Can not assign v to the unresolved placeholder p`) | **Falschfehler**: Ob `v` das Prädikat erfüllt, ist unbekannt, nicht widerlegt. Das Test-Kommentar sagt es: „Unbekannte Reinheit ist keine Ablehnung“ |
| `nested-condition-keeps-fraction-precise`, `flat-condition-keeps-fraction-precise`, `type-function-keeps-condition-until-arguments-are-known` | Der geschriebene Rückgabetyp ist eine Formel über die Argumenttypen (`Or(And(Integer And(TypeOf(a) TypeOf(b))) …)`). Der Rumpf `subtract(a b)` wird gegen die Formel mit den Platzhaltern `a` und `b` geprüft und abgelehnt | **Falschfehler**: Die Formel ist ein Typ je Aufruf. Der Rumpf ist dagegen nur mit der Obergrenze der Formel prüfbar, so ist es entworfen (siehe „bekannte Großzügigkeit“ in `R3`) |
| `R2 Rumpf außerhalb der Union`, `R4 Teiltreffer im Rumpf` | Ein Fehler fehlt: Der Rumpf liefert Text bzw. `a` gegen einen bedingten Rückgabetyp (`:?`) | **verlorene Erkennung**: Mit rohem Ziel ist das `:?` ungefaltet und die Zuweisbarkeit *unknown*. Mit der Obergrenze (Vereinigung der Zweige) wird der Fehler gefunden |

- **Bilanz:** zwei berechtigte neue Meldungen, beide nur in Fixtures; vier Falschfehler; zwei verlorene
  Fehlererkennungen. Im echten Code kein Gewinn.
- **Was daraus folgt:** Starr passt zu einem Typparameter, der der Typ eines Wertes ist (`:> T`, `x: T`). Es
  passt **nicht** zu einer Formel über Argumenttypen (bedingte Typen, `TypeOf(a)` im Rückgabetyp), dort ist die
  Obergrenze der Entwurf, und nicht zu einem Prädikat als Typ. Eine Regel, die das unterscheidet (nur ein
  bloßer Platzhalter als oberstes Ziel, keiner in einer Formel, keiner mit Funktionstyp als Grenze), wären
  drei Sonderfälle für einen Gewinn, der heute nur in Fixtures liegt.
- **Entscheidung:** nicht übernehmen. Die Voraussetzung für einen späteren Versuch ist die Unterscheidung
  von Typparameter und Formel, mit den acht Tests als Ausgangsliste.

**Zielbild-Schritt 5 — Aufräumen, Speicherstellen** (mittlerer Aufwand, nach 4).
- Stellen, die einen aufgelösten Typ speichern: Spread in Dictionaries (zwei Stellen), Spread in Listen,
  Tupeln und Objekten (sechs Stellen), `withCompletedStream`. Einige Tests zeigen, dass die Elementtypen
  eines generischen Spreads schon erhalten bleiben
  (`spread-of-generic-list-parameter-keeps-element-type`). Für jede Stelle prüfen, welche Fälle die
  Generizität verlieren, je ein roter Test, dann Umstellung auf den rohen Typ oder die Obergrenze.
- Kommentare und Doku an das Modell anpassen (`resolvePlaceholders`, `CHECKER-AUDIT.md`, dieses
  Dokument).

**Was ich nicht geprüft habe:** Ob die Zeilen in `type-algebra.ts` und `checker.ts` aus dem
Untersuchungsbericht stimmen (nur die Aussage zur Quelle als Obergrenze und der TODO-Fall sind selbst
verifiziert), und wie viele neue Meldungen Zielbild-Schritt 4 wirklich ergibt. Dafür ist die Messung da.

**Zielbild-Schritt 5: durchgesehen, drei Fehler gefunden und behoben, eine Einschränkung bleibt.**
Jede Speicherstelle wurde mit einem Aufruf von außen geprüft (das Ergebnis am Aufrufort zeigt, ob die
Generizität verloren ging):
- **Gut:** Spread von Listen (auch `Or([] List(X))`), Tupeln, Destructuring und das Durchreichen eines Streams
  behalten den Elementtyp am Aufrufort (`List(Or(Text 1))`, `[Text Integer 1]`, `Stream(Text)`). Die Listen
  bleiben über den symbolischen `concat`-Knoten generisch.
- **Fehler 1 (behoben):** Spread eines `Dictionary(X)` in ein Dictionary-Literal ergab `Any`.
  `spreadDictionaryTypes` kennt jetzt ein `Dictionary(X)` auf einer Seite: Das Ergebnis ist ein `Dictionary`
  über die Vereinigung aller Werttypen (ein unvollständiges Literal daneben bleibt unentscheidbar).
- **Fehler 2 (behoben):** Spread von `Or([] Dictionary(X))` ergab nur `Empty`, der Dictionary-Zweig ging
  verloren. Reine Spreads (`[...d]`) bleiben als `concat`-Knoten stehen, bis sich die Quelle auflösen lässt;
  `concatFromTypes` kannte nur Listen und Tupel und behandelt jetzt auch Dictionaries.
- **Fehler 3 (behoben):** \`withCompletedStream\`: Ein Stream, der im Rumpf mit \`complete\` beendet wird, verlor
  den Wertetyp eines generischen Parameters (\`FiniteStream(Any)\` statt \`FiniteStream(Text)\`). Der Wertetyp
  bleibt jetzt \`TypeOf(x)/ValueType\`, wenn der Stream selbst ein Platzhalter ist.
- **Tests:** vier für Dictionary-Spreads (\`spread-of-dictionary-type-into-dictionary-literal\`,
  \`spread-of-two-dictionary-types-merges-element-types\`, \`spread-of-dictionary-type-with-additional-field\`,
  \`spread-of-optional-dictionary-type-keeps-both-cases\`) und \`completed-stream-keeps-generic-value-type\`, alle
  vorher rot.
- **Wirkung in yugioh:** Die Form \`cards: Any\` ist aus den Warnungen verschwunden (vorher 7), die Zahl der
  Zeilen mit \`Any\` sank von 119 auf 112. Die Warnungen selbst bleiben bei 49, weil dort weiterhin andere
  \`Any\` stecken (\`hand\`, \`activeGameCardId\`, \`stream$\`, \`passUntilPhase\`).
- **Bleibt (Einschränkung, kein Fehler):** Ein Dictionary-**Literal** als Parameter, gespreadet
  (\`d: [a: Any]\`, \`[...d y = 1]\`), verliert die Generizität: Am Aufruf mit \`[a: Text]\` steht \`a: Any\`. Für
  Dictionaries gibt es kein Gegenstück zum \`concat\`-Knoten der Listen, ein Fix wäre ein neuer Typknoten.
- **Nicht untersucht:** Der Spread in einer **Typangabe** (\`case 'dictionaryType'\`): Er wertet nur
  Dictionary-Literale aus, andere Quellen werden still ignoriert (im Code mit \`TODO error when spread list\`
  vermerkt). Dazu habe ich keinen Test.
- **Ergebnis:** 1287 Tests grün, Snapshot und Zähler unverändert, Bench-Median etwa 1170 bis 1190 ms.

## Risiken und offene Fragen

- **Ein `And` aus einer Signatur beim Nachschlagen:** Wird auf einem Rückgabetyp wie dem von `range`
  nachgeschlagen und enthält er die Platzhalter des Aufrufers, löst die Regel ihn auf. Das ist der
  Zustand von heute für `and`. Ob das bei `or` neue Fälle trifft, zeigt die Messung nach Schritt 1.
- **Verschachtelung:** `And(And(n Not(0)) Not(1))` wird nicht zusammengefasst, das Auflösen liefert
  ebenfalls `And(And(Integer Not(0)) Not(1))`. Für das Nachschlagen genügt das, geprüft ist es nicht.
- **Performance:** `getLookupType` ruft `resolvePlaceholders` nur für zusammengesetzte Typen mit
  Platzhalter. Der Bench entscheidet, nicht die Schätzung.
- **Index-Pfade:** `withNarrowedPath` trägt den Schluss auf die Quelle für Index-Pfade noch nicht
  (Kommentar dort). Das ändert sich durch diesen Plan nicht.
- **Annahme:** Es gibt keine Verbraucher außerhalb von `checker.ts`, `type-algebra.ts` und
  `stream-lifetime.ts`, die `and` mit Platzhalter erwarten (`jul-language-server` nicht geprüft,
  er importiert den gebauten Compiler).
