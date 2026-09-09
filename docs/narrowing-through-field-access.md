# Verengung erreicht die Quelle eines Feldzugriffs nicht

Punkt 13 in [CHECKER-AUDIT.md](CHECKER-AUDIT.md). Erzeugt Falschfehler in echtem Code, muss vor der
Weiterarbeit an [type-accessor-constructors.md](type-accessor-constructors.md) geschlossen werden.

## Der Fehler

```jul
step = getStep(flag)        # Or([] Step), Step = [type: Text query: Text]
stepType = step/type        # Or([] Text)
?(stepType)
	[Text] => g(step/query)   # meldet "Can not assign Empty to Text"
	() => §§
```

Der Branch beweist, dass `stepType` ein `Text` ist. `Empty` hat kein Feld `type`, also **kann**
`step` in diesem Zweig nicht leer sein. Der Checker zieht diesen Schluss nicht: verengt wird nur
`stepType`, `step` behält `Or([] Step)`, und `step/query` schleppt das `Empty` weiter.

Festgehalten als `branch-narrowing-does-not-reach-source-of-field` in
[checker.test.ts](../src/checker.test.ts).

## Warum es passiert

Die Verengung sitzt in `inferType`, `case 'functionLiteral'`, Abschnitt „narrowed type symbol für
branching" ([checker.ts](../src/checker.ts)). Sie tut genau zwei Dinge:

1. Sie geht die **geschriebenen Argumente** des branchings durch (`getWrittenArguments`).
2. Für jedes Argument, das eine **einfache Referenz** ist, legt sie im Scope des branches ein
   überschattendes Symbol mit dem verengten Typ an.

Daraus folgen beide bekannten Lücken:

- `argument.type !== 'reference'` → `return`: ein Feldpfad als Branch-Argument (`?(step/type)`)
  verengt gar nichts. Das ist `branch-narrowing-field-path-is-missing`.
- Verengt wird ausschließlich das Symbol des gebranchten Namens. Dass `stepType` aus `step/type`
  stammt, steht nirgends in der Verengung — die Rückrichtung fehlt vollständig.

## Was bereits trägt

Das Werkzeug für die Rückrichtung ist der Schnitt mit einem Feldtyp, und der funktioniert heute
schon. Gemessen an drei Fällen:

| Ausdruck | Ergebnis |
|---|---|
| `z: And(Or([] Step) [type: Text]) = []` | Fehler — `Empty` fällt aus dem Schnitt |
| `z: And(Or([] Step) [type: Text]) = [type = §a§ query = §b§]` | kein Fehler |
| `(narrowed: And(Or([] Step) [type: Text])) => g(narrowed/query)` | kein Fehler, `query` bleibt lesbar |

Grund: `createNormalizedIntersectionType` verteilt über die Union, und `And(Empty [type: Text])`
wird zu `Never`, weil `typesOverlap` die Familien `empty` und `dictionary` als disjunkt erkennt.
Der verengte Typ ist also schlicht `And(Quelltyp [Feld: verengterFeldtyp])` — kein neues Konstrukt.

Dieselbe Verteilung deckt **diskriminierte Unions** gleich mit ab. Mit
`A = [type: §a§ payload: Integer]` und `B = [type: §b§ payload: Text]` liefert
`And(Or(A B) [type: §a§])` genau `A` — `And(B [type: §a§])` fällt als `Never` heraus, weil die
Textliterale nicht überlappen. Der Zugriff `n/payload` ist danach `Integer`. Ein korreliertes Feld
braucht also keinen eigenen Mechanismus.

Zweiter Baustein, ebenfalls vorhanden: `SymbolDefinition.definition`
([syntax-tree.ts:33](../src/syntax-tree.ts#L33)) zeigt auf den Definitionsausdruck. Von
`stepType` aus ist `step/type` damit erreichbar, ohne dass ein Symbol neue Felder braucht.

Dass JUL keine Zuweisung an bestehende Namen kennt, macht diese Herkunft verlässlich: Ein Name
bezeichnet genau einen Wert, der Rückschluss kann nicht durch eine spätere Änderung ungültig werden.

## Optionen

### A — nur der direkte Feldpfad

`?(step/type)` verengt `step` zu `And(step [type: …])`. Der `argument.type !== 'reference'`-Ausstieg
wird um den `nestedReference`-Fall erweitert.

- schließt `branch-narrowing-field-path-is-missing`
- schließt den Fall aus diesem Dokument **nicht**, denn dort steht eine Zwischenvariable
- kleinster Eingriff, rein lokal in der Verengung

### B — direkter Pfad und Zwischenvariable, Herkunft aus dem AST

Wie A, zusätzlich: Ist das Branch-Argument eine Referenz, deren Symbol über
`symbol.definition.value` als `nestedReference` auf eine Referenz zurückgeht, wird auch dieses
Quellsymbol verengt. Für Ketten (`a/b/c`) rekursiv von innen nach außen.

- schließt beide Lücken
- braucht kein neues Feld an `SymbolDefinition`
- Kosten: eine zusätzliche Schnittbildung je Branch und Kettenglied; die Herkunft wird bei jedem
  branching neu aus dem AST gelesen
- Risiko: Die Herkunft muss eng geprüft werden. Nur ein `nestedReference` mit literalem Schlüssel
  auf eine Referenz zählt; alles andere (Aufruf, Berechnung, Destructuring) darf nicht verengen

### C — Herkunft als eigenes Feld am Symbol

Wie B, aber beim Prüfen der Definition wird `derivedFrom: { sourceName, key }` am Symbol vermerkt,
statt später den AST auszuwerten.

- macht die Absicht explizit und die Verengung billiger
- kostet ein Feld an `SymbolDefinition` und eine Pflegestelle mehr
- lohnt erst, wenn B messbar zu teuer ist

### D — Faktenumgebung über Zugriffspfaden

Verengung nicht am Symbol, sondern als Menge von Aussagen über Pfade (`step`, `step/type`,
`step/query`), die je Branch-Rumpf gilt. Jede Typabfrage schlägt zuerst dort nach — unabhängig
davon, über welchen Ausdruck beobachtet wurde.

- löst zusätzlich die Verengung **aus Bedingungen** statt aus Typ-Köpfen
  (`isEmpty = step.equal()`, dann `?(isEmpty) [false] => …`), und die Korrelation mehrerer Werte
  in einem `?(a b)`
- ein Mechanismus statt drei Fallunterscheidungen am Argument
- **kein** Vorteil bei diskriminierten Unions — die deckt der Schnitt schon ab (siehe oben)
- Kosten: eine zweite Nachschlageebene, die `dereferenceType` und der `nestedReference`-Fall
  konsultieren müssen. Dafür in JUL deutlich kleiner als in TypeScript: ohne `return`, Schleifen
  und Zuweisung an bestehende Namen gelten die Fakten für den ganzen Rumpf und müssen nie
  invalidiert werden — es braucht keine Flussanalyse, nur eine durchgereichte Umgebung

**Zum Vergleich:** TypeScript deckt genau diese Stufen ab. Der direkte Fall entspricht dem
Discriminated-Union-Narrowing (`if (x.kind === 'a')`), der Fall mit Zwischenvariable den seit 4.4
unterstützten *destructured discriminants* (`const { kind } = x; switch (kind)`). Beides gilt dort
nur, weil die Zwischenvariable nicht neu zugewiesen werden kann — in JUL ist das ohnehin der Fall.

### E — Struktur von D, Umfang von B

Die pfadindizierte Umgebung bauen, aber vorerst nur aus Branch-Köpfen füllen, nicht aus Booleschen
Bedingungen. Die Regel bleibt `And(Quelltyp [Feld: T])`, nur der Weg dorthin ändert sich.

- löst den Anlass, ohne dass später etwas weggeworfen wird: „Verengung aus Bedingungen" wäre eine
  reine Erweiterung der Befüllung
- kein Präzedenzfall in anderen Sprachen. Wer Pfad-Fakten hat (TypeScript, Flow, Kotlin, Typed
  Racket), hat sie **wegen** der Bedingungen; wer nur über Muster verengt (ML, Rust, Elixir,
  Scala), braucht keine Pfade, weil das Muster die Teile an Namen bindet. E liegt dazwischen

## Verworfen: den Aufrufcode umschreiben

Die Verengung auf einem einfachen Namen mit Typ-Kopf funktioniert längst, und `[type: Text]` ist
ein gewöhnlicher Typ. Wer auf dem **Wert** branched statt auf dem **Feld**, bekommt sie deshalb
heute schon — alle drei Formen sind fehlerfrei:

```jul
?(step)
	[[type: Text]] => g(step/query)
	() => §§

?(step)
	[Step] => g(step/query)
	() => §§

?(step)
	(s: Step) => g(s/query)
	() => §§
```

Das ist ein nützlicher Befund — die Regel stimmt bereits, es fehlt nur der Einstieg über den
Feldzugriff. Als Lösung kommt es trotzdem nicht in Frage: Der betroffene Code ist semantisch
sinnvoll und gültig, ihn zur Umschreibung zu zwingen widerspricht dem Prinzip Freiheit
([design-principles.md](design-principles.md#2-freiheit), „die Sprache arbeitet mit dem Benutzer,
nicht gegen ihn"). Ein Falschfehler ist zudem laut derselben Rangfolge das schlechteste Ergebnis:
„Freiheit schlägt Schärfe — ein verpasster Fehler ist billiger als ein falscher."

## Empfehlung

Noch offen zwischen **B** und **E**. A allein löst den Anlass nicht (dort steht eine
Zwischenvariable), C ist eine Optimierung ohne Messung, D geht über den Anlass hinaus.

Beide teilen dieselbe Regel; sie unterscheiden sich nur darin, wo das Ergebnis liegt — bei B in
einem überschattenden Symbol, bei E als Fakt am Pfad. Daraus folgt die eine Frage, die zu
entscheiden ist:

- **B**, wenn Verengung in JUL an Namen hängen soll. Dann ist der Feldzugriff ein Sonderweg, der
  die Quelle mitverengt, und die Umsetzung bleibt lokal. Grenze: Beobachtungen, die sich nicht als
  Bedingung an einer *benannten* Quelle ausdrücken lassen, bleiben unerreichbar.
- **E**, wenn Verengung an Ausdrücken hängen soll. Dann ist der Name nur ein Pfad der Länge 1,
  und spätere Erweiterungen (Bedingungen, Index-Pfade) sind Zusätze statt Umbauten. Preis: eine
  Nachschlageebene im heißen Pfad, gemessen werden muss.

Was **nicht** in die Abwägung gehört: dass sich der Anlass im Aufrufcode umgehen ließe — siehe
oben, verworfen.

## Vorgehen

1. Beide Lücken-Tests auf die **richtige** Erwartung umstellen, damit sie rot werden:
   `branch-narrowing-field-path-is-missing` und `branch-narrowing-does-not-reach-source-of-field`.
2. Gegenproben ergänzen, bevor implementiert wird — die Verengung darf nicht zu weit gehen:
   - Quelle ist kein einfacher Name (`getStep(flag)/type` direkt im Kopf) → nicht verengen
   - Feld existiert im Quelltyp nicht → nicht verengen, nicht melden
   - anderer Branch derselben Kette darf die Verengung nicht sehen
3. Messen vor dem Umbau (`npm run bench -- --save`), die Verengung liegt im heißen Pfad.
4. Umsetzen, dann erneut messen.
5. Verifikation wie in [CHECKER-AUDIT.md](CHECKER-AUDIT.md#verifikation-nach-jedem-schritt),
   inklusive Durchlauf gegen das große Fremdprojekt: dort muss die verbliebene Meldung verschwinden.
