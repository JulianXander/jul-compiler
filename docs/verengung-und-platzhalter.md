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
- `subst` und `reduce` für die Typ-Arithmetik, stehenbleibende `App` und `Cond`.
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
      | Var(param)                  der Typ des Arguments an dieser Stelle (heute parameterReference)
      | Proj(Typ, name)             TypeOf(values)/ElementType            (heute nestedReference)
      | App(Typfunktion, Typ...)    Add(...), Greater(...)
      | Cond(Typ, Zweige)           :?(...)
```

Drei Operationen, die heute in `traversePlaceholders` und `resolvePlaceholders` vermischt sind:

| Operation | Bedeutung | heute |
|---|---|---|
| `subst(term, Abbildung)` mit anschließendem `reduce` | Variablen durch Typen ersetzen und auswerten, soweit alle Argumente konkret sind (Add, Fold-Budget, `:?`-Zweige). Was nicht reduzierbar ist, bleibt als Term stehen. | `traversePlaceholders` mit `argumentContext`, `*FromTypes` |
| `bound(term)` | die Obergrenze für Prüfungen: eine Variable wird durch ihre Grenze ersetzt, ein stehengebliebenes `Cond` durch die Vereinigung seiner Zweige. Kein `Any` als Rückfall. | `resolvePlaceholders` |
| Verengung | ändert die Grenze einer Variable in einer Umgebung, nicht den Term | `narrowedTypes`, heute mit `And(Platzhalter X)` als Eintrag |

Daraus folgt für die Arithmetik:

- Mit konkreten Argumenten wertet `reduce` aus wie heute, die Konstantenfaltung bleibt
  (`add(2 3)` ergibt `5`).
- Im Rumpf einer Funktion bleibt `Add(Var(a) 1)` als Term stehen und wird erst beim Aufruf von
  außen eingesetzt. Das löst die offene Zeile in der [TODO](../TODO): „ein Aufruf im Rückgabetyp
  faltet nicht am Aufrufort: `Greater(add(a 1))` ergibt `Greater(Integer)`“.
- Die dreiwertige Zuweisbarkeit ([three-valued-assignability.md](three-valued-assignability.md))
  bleibt: *yes*, wenn die Obergrenze zuweisbar ist, *no*, wenn Obergrenze und Ziel disjunkt sind,
  sonst *unknown*.

Zu beachten, wenn es gebaut wird: Die Obergrenze eines `Cond` ist nicht das `Cond` der Obergrenzen,
deshalb die Vereinigung aller Zweige. Die Auswertung rekursiver Typfunktionen braucht weiter das
Fold-Budget. Starre Variablen im Rumpf melden strengere Fehler als `Any`, das widerspricht dem
Prinzip „im Zweifel permissiv“ und muss bewusst entschieden werden. Ein präziserer Typ kann sehr
teuer sein (siehe `CHECKER-AUDIT.md`), jeder Schritt wird deshalb gemessen.

### Was dieser Plan davon umsetzt

| Baustein des Ziels | Dieser Plan |
|---|---|
| Verengung ändert die Grenze in einer Umgebung | schon so gebaut (`narrowedTypes`) |
| `bound` als einzige Auflösung für Prüfungen | `getLookupType` für verengte Typen, an den Nachschlage- und Prüfstellen |
| Variable mit Grenze als eigene Darstellung | nicht (zurückgestellt, `Refinement`) |
| `subst` und `reduce`, stehenbleibende `App` und `Cond` | nicht Teil dieses Plans |
| starre Variablen im Rumpf statt `Any` | nicht Teil dieses Plans |
| Speichern von aufgelösten Typen beim Spread | nicht Teil dieses Plans |

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
