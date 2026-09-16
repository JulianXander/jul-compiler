# Pure Functions: erste Ausbaustufe (core-lib-only, ohne Inferenz)

## Stand

`pure` existiert bereits als Feld auf `CompileTimeFunctionType`
([syntax-tree.ts:928](../src/syntax-tree.ts#L928)), wird bei jeder Funktionstyp-Erzeugung gesetzt
([syntax-tree.ts:943](../src/syntax-tree.ts#L943)) und fließt bis in die Typgleichheit ein
(`first.pure === second.pure`, [checker.ts:4221](../src/checker/checker.ts#L4221)). Das Feld hat
aber weder einen Konsumenten noch eine Quelle, die es korrekt belegt: **es ist heute falsch belegt,
nicht nur ungenutzt.**

Die Werte kommen aus genau zwei Hartkodierungen:

1. **`functionTypeLiteral`** — jede hingeschriebene Signatur (`(a: Integer) :> Integer`) erzeugt
   `pure: true` ([checker.ts:2702](../src/checker/checker.ts#L2702)).
2. **`functionLiteral`** — jede Funktion mit Rumpf erzeugt `pure: false`
   ([checker.ts:2587](../src/checker/checker.ts#L2587)), mit TODO „pure, wenn der body pure ist".

`nativeFunction` übergibt seine Signatur als `functionTypeLiteral`. Daraus folgt: **jede**
core-lib-Funktion trägt `pure: true`, auch `log`, `currentDate` und `forEach`. Nachgemessen über
`builtInSymbols`:

```
log: true   currentDate: true   forEach: true   map: true   assume: true
```

Der von Hand gesetzte `pure`-Parameter von `nativeFunction`
([core-lib.jul:1278](../src/core-lib.jul#L1278), deklariert in
[checker.ts:282](../src/checker/checker.ts#L282)) wird **nirgends gelesen** — es gibt keine Stelle
im Checker, die `nativeFunction` namentlich behandelt. Die 80 Bool-Argumente in core-lib (49 `true`,
31 `false`) sind damit reine Notizen, ebenso die 10 Kommentare „TODO pure wenn die args pure sind"
an den Funktionen höherer Ordnung. Als Notizen sind sie brauchbar: sie sind die Vorlage für die
Migration, aber nichts davon ist heute geprüft oder wirksam.

Eine dritte Folge derselben Lücke: `getTypeError`, `case 'function'`
([checker.ts:4964](../src/checker/checker.ts#L4964)) prüft `pure` gar nicht — nur Parameter
(kontravariant) und Rückgabetyp (kovariant). `typeEquals` vergleicht es dagegen. Weil ein
deklarierter Typ `true` und jede echte Funktion `false` trägt, sind die beiden heute **nie**
`typeEquals`; das fließt unbemerkt in jede Deduplizierung (z. B. `createNormalizedUnionType`).

## Ziel dieser Ausbaustufe

Nur **direkte, manuell deklarierte** Purity auf core-lib-`nativeFunction`s nutzbar machen — keine
Inferenz über Nutzercode, keine Ableitung durch höhere Ordnung. Drei Teile in dieser Reihenfolge:

1. **Quelle der Wahrheit**: `pure` überhaupt erst korrekt belegen (siehe Stand). Ohne diesen
   Schritt hielte jeder Konsument `currentDate` für rein.
2. **Sichtbarkeit**: `pure` im Typ ablesbar machen (aktuell unsichtbar, siehe Architekturfrage
   unten). Erst dadurch fällt eine Fehlbelegung beim Lesen auf statt erst im Verhalten.
3. **Ein erster Konsument**: Constant Folding — ein Aufruf einer als `pure` deklarierten
   `nativeFunction` mit ausschließlich literalen/statisch bekannten Argumenten wird zur Compile-Zeit
   ausgewertet, das Ergebnis fließt als präziserer (Literal-)Typ in den Checker zurück.

## Architekturfrage: Sichtbarkeit von `pure` im Typ

`typeToString` ([checker.ts:5741](../src/checker/checker.ts#L5741)) rendert `case 'function'` heute als
`${paramsString} :> ${returnString}` — `type.pure` wird nicht gelesen. Nach Prinzip 1
(Klarheit, design-principles.md) ist das eine Lücke: der Typ trägt eine Information, die an keiner
Stelle sichtbar wird, weder in Fehlermeldungen noch im Hover des Language Servers.

### Optionen

- **A — Zweites Pfeilsymbol, `pure` bleibt separater Flag.** `:>` bleibt für pure, ein zweites Symbol
  (z. B. `~>`) für impure, nur in der Ausgabe (`typeToString`). Die Eingabe (`nativeFunction`s
  `pure`-Parameter) bliebe unverändert ein Bool daneben.
- **B — Zweites Pfeilsymbol als echte Eingabe-Syntax, `pure`-Flag entfällt.** `~>` wird ein zweiter
  Token neben `:>` im Parser selbst (`functionTypeBodyParser`/`returnTypeTokenParser`,
  [parser.ts:259](../src/parser/parser.ts#L259), [parser.ts:1649](../src/parser/parser.ts#L1649)),
  der erzeugte `functionTypeLiteral`-Knoten ([parser.ts:1123](../src/parser/parser.ts#L1123)) trägt,
  welcher Pfeil geschrieben wurde. `nativeFunction`s `FunctionType`-Parameter *ist* bereits ein
  `functionTypeLiteral` (dieselbe Syntax, mit der auch Callback-Parametertypen wie in `map`
  deklariert werden) — der Checker liest `pure` direkt daraus, der separate Bool-Parameter
  ([checker.ts:282](../src/checker/checker.ts#L282)) entfällt, `nativeFunction` schrumpft von drei
  auf zwei Parameter (`FunctionType: Type`, `js: Text`).
- **C — Effekt im Rückgabetyp kodieren** (Haskell-`IO`-Weg). Größerer Umbau, lohnt sich nur, falls
  später mehr als binär pure/impure unterschieden werden soll (mehrere Effektarten). Für den
  aktuellen Anwendungsfall (Constant Folding an der `nativeFunction`-Grenze) unnötig groß.
- **D — Nur im Language Server/Hover sichtbar, nicht in `typeToString`.** Billigste Option, verstößt
  aber gegen Klarheit: Fehlermeldungen und jede textuelle Typausgabe (Tests, TODO-Notizen) blieben
  ohne die Information, Sichtbarkeit hinge vom Werkzeug ab statt vom Text selbst.

### Empfehlung

B statt A. A ließe zwei Aussagen über dieselbe Sache nebeneinander bestehen (die per Pfeil
geschriebene `FunctionType` und der separate Bool könnten auseinanderlaufen — `FunctionType` mit
`:>` geschrieben, aber `pure = false` daneben, ist heute möglich und würde durch A nicht
ausgeschlossen). B macht die Aussage strukturell einzig: nur eine Stelle kann lügen statt zwei. Nach
Prinzip 3 (Einheitlichkeit) ist das kein Sonderfall, sondern dieselbe bereits getroffene Entscheidung
wie bei Spread (design-principles.md: „`x` und `...x` bedeuten Verschiedenes → beide erlaubt, weil
zwei verschiedene Sachen") — pure und impure Funktionstypen sind unterschiedliche Typen, keine
Ausnahme von etwas Einheitlichem.

Zusatznutzen von B: dieselbe Schreibweise gilt nicht nur bei `nativeFunction`, sondern überall, wo
Funktionstypen auftauchen — insbesondere an Callback-Parametertypen (`callback: (value: X) :> Any`
vs. `~>`). Das ist die Stelle, an der die Ausbaustufe „Pure Inference" für Funktionen höherer Ordnung
(`map`/`filter`) später ansetzen müsste: die Anforderung an den Callback wird dann Teil seines Typs,
nicht nur ein Flag der äußeren Funktion. Löst die Inferenz selbst nicht (`map`s eigene Purity bliebe
weiterhin von der konkreten Aufrufstelle abhängig), aber es ist dasselbe Vokabular, das dort
wiederverwendet wird, statt ein zweites einzuführen.

Kosten von B gegenüber A: Parser-Änderung statt reinem Checker-Diff, plus Migration aller
`nativeFunction`-Aufrufe in core-lib.jul (aktuell `(FunctionType, true/false, js)`) auf den
passenden Pfeil. Mechanisch, aber einmalig — vergleichbar mit der bereits durchgeführten
Klammer-Migration.

Der Language Server übernimmt die Sichtbarkeit in beiden Fällen automatisch, da Hover/Signature Help
auf `typeToString` aufbauen.

## Zu entscheiden, bevor Option B umsetzbar ist

Vier Fragen, die die Empfehlung offen lässt. Reihenfolge der Beantwortung: 2 → 1 → 4 → 5, weil Frage 2
den Umfang der folgenden bestimmt. (Die ursprüngliche Frage 3 „Welches Symbol?" ist in Frage 2
aufgegangen, weil beide dieselbe Entscheidung trafen, sobald `:>` nicht mehr zur Debatte um
pure/impure gehört: welche neuen Symbole es gibt und welche Bedeutung jedes trägt, ist eine einzige
Frage. Frage 5 kam mit der Pfeil-Familie dazu — vier Pfeile passen nicht mehr in ein Bool.)

**Zahlen, auf die sich der Migrationsumfang unten bezieht:** 81 `nativeFunction`-Aufrufe in
core-lib mit 80 Bool-Argumenten (49 `true`, 31 `false`), davon 17 Parameter, deren Typ selbst ein
Funktionstyp ist (`callback`, `predicate`, `getKey`, `getValue`, `listener`, `transform$`,
`iteratee`); 8 `:>`-Vorkommen in `jul-examples`, 64 in den Tests, je eines in Grammatik, Snippets
und Handbuch.

### Frage 1: Was bedeutet der Pfeil an einem `functionLiteral`?

`:>` steht nicht nur in Typen, sondern auch am Wert mit deklariertem Rückgabetyp
(`(a: Integer) :> Integer => a`). Es ist derselbe Parser-Zweig: `functionTypeBodyParser`
([parser.ts:1649](../src/parser/parser.ts#L1649)) liest Pfeil und Rückgabetyp und entscheidet erst
am optionalen `=>`, ob ein Typ oder ein Wert entsteht. Ein Pfeil, der Purity trägt, steht damit
automatisch auch an Nutzerfunktionen — deren `pure` ist aber hart `false`.

- **1A — Der Pfeil ist nur im `functionTypeLiteral` bedeutungstragend**, am Literal bleibt er reine
  Rückgabetyp-Notation. *Kosten:* dieselbe Schreibweise bedeutet an zwei Stellen Verschiedenes
  (Prinzip 3). Zusätzlich zu klären: ist `~>` am Literal dann verboten (neuer Fehlercode) oder
  wirkungslos erlaubt?
- **1B — Der Pfeil am Literal ist eine ungeprüfte Zusicherung**: der Wert übernimmt `pure` aus dem
  Pfeil, ohne Prüfung des Rumpfs; ohne Pfeil (`(a) => ...`) bleibt es bei impure. *Kosten:* die
  Zusicherung kann lügen, bis die Inferenz-Ausbaustufe sie prüft. *Nutzen:* eine Bedeutung für ein
  Symbol, und die Inferenz prüft später die Zusicherung, statt sie zu ersetzen — derselbe Weg wie
  beim deklarierten Rückgabetyp, der heute schon gegen den inferierten geprüft wird.
- **1C — Deklaration mit sofortiger Prüfung.** Braucht Purity-Inferenz über den Rumpf, das ist die
  nächste Ausbaustufe. Für jetzt ausgeschlossen.

**Entscheidung: 1A, aber ohne dessen ursprüngliche Kosten.** Der Einwand gegen 1A war, dieselbe
Schreibweise bedeute an zwei Stellen Verschiedenes. Das entfällt, weil `:>` nicht mehr die
Purity-tragende Schreibweise ist (siehe Frage 2): `:>` bleibt an **jeder** Stelle — Literal wie
Typ — „keine Aussage über Purity", überall dieselbe Bedeutung. Die Purity-tragenden Pfeile
(`->`/`~>`/`?>`) bleiben vorerst reserviertes Vokabular für `functionTypeLiteral`-Deklarationen in
core-lib (`nativeFunction`); an einem `functionLiteral` mit Rumpf ergäben sie mangels Inferenz ohnehin
eine ungeprüfte Behauptung. Ob sie später dort erlaubt werden (das wäre dann 1B), ist eine Frage der
Pure-Inference-Ausbaustufe, nicht dieser.

### Frage 2: Welche Symbole, welche Bedeutung?

Ursprünglich als Frage gerahmt, welche Bedeutung die beiden damals einzigen Kandidaten (`:>` und ein
neues Symbol) bekommen:

- **A — `:>` = pure, neues Symbol (`~>`) = impure.** *Migration:* die 31 als `false` notierten
  Signaturen **plus alle 17 Callback-Parameterpositionen** nach `~>`. Letztere zwingend: eine
  Position, die einen reinen Callback fordert, kann heute von keinem Nutzercode bedient werden
  (`functionLiteral` ist immer impure). Dazu behaupten je nach Frage 1 alle 72 `:>`-Vorkommen in
  Beispielen und Tests ungewollt „pure".
- **B — `:>` bleibt die unmarkierte Form, neues Symbol markiert pure.** *Migration:* nur die 49
  reinen Signaturen. Callback-Positionen, Beispiele, Tests, Grammatik-Regel für `:>` bleiben
  unberührt. *Zu klären:* bedeutet die unmarkierte Form „unrein" oder „keine Aussage"? Zwei
  Bedeutungen in einem Symbol wäre dieselbe Lücke, die dieses Dokument gerade schließen will.

**Entscheidung: keine von beiden — `:>` wird gar nicht als Purity-Träger wiederverwendet.** Der
Einwand gegen A (17 Callback-Parameterpositionen müssten pauschal auf `~>`, obwohl kein Nutzercode
dort einen pure-Callback liefern kann) entfällt mit einem eigenen dritten Pfeil `?>` (siehe
[Bedingte Purity bei Funktionen höherer Ordnung](#bedingte-purity-bei-funktionen-höherer-ordnung-)
unten): Callback-Positionen wie in `map` bekommen `?>` und akzeptieren damit von sich aus sowohl pure
als auch impure Argumente, ohne auf Frage 4 (Subtyping) zu warten. `:>` selbst bleibt eigenständig
„keine Aussage über Purity" (siehe Entscheidung zu Frage 1) — Migrationskosten für einen komplett
neuen Pfeil sind laut Nutzer vernachlässigbar, die Sprache ist noch in Entwicklung.

Favorisierte Symbole: eine harmonische Familie mit dem bereits bestehenden `functionToken` `=>` —
`=>` (Lambda-Rumpf), `->` (pure), `~>` (impure), `?>` (bedingt). Alle vier nach demselben Muster
gebaut: ein einzelnes, sonst unbelegtes Zeichen plus `>`. Das vermeidet, was `:>` heute tut — den
Doppelpunkt wiederzuverwenden, der in JUL bereits eine andere Bedeutung trägt (`(a: Integer)`,
`[a: Integer]`). `:>` bleibt daneben bestehen, aber außerhalb dieser Familie — kein Widerspruch,
weil es keine Purity-Aussage macht und daher nicht zur Pfeil-Familie gehören muss. Damit gilt:

- `:>` — keine Aussage (Status quo, bleibt an allen heutigen Stellen unverändert)
- `->` — pure
- `~>` — impure
- `?>` — abhängig vom Callback-Parameter

Zu `->`: kein Kollisionsrisiko mit einem Subtraktions-Operator, da JUL keinen eigenen
Subtraktions-Token hat (arithmetische Operationen laufen über Funktionen wie `add`). Zu prüfen bleibt
trotzdem die Tokenisierungsreihenfolge: der bestehende Pfeil-Token ist `' :> '` **inklusive
umgebender Leerzeichen** ([parser.ts:259](../src/parser/parser.ts#L259)), `=>` ist der
`functionToken`. Ein Symbol, das mit `=>` beginnt oder endet, verlangt Blick auf die Reihenfolge der
`discriminatedChoiceParser`-Zweige — betrifft hier keinen der vier Kandidaten direkt, aber die
Abgrenzung zu `=>` selbst (z. B. `?=>` wäre riskant, `?>` nicht) ist bei der Umsetzung zu verifizieren.

Alternativvorschlag aus einer früheren Notiz: `!=>` statt `~>`
([syntax-tree.ts:379](../src/syntax-tree.ts#L379)) — passt schlechter in die Familie (zwei
Sonderzeichen statt eines), daher nachrangig.

**Mehrwert eines eigenen Impure-Symbols gegenüber „keine Aussage".** Für die Konsumenten dieser
Ausbaustufe (Constant Folding, `?>`-Auflösung) verhalten sich `~>` und `:>` identisch — beide sind
„nicht beweisbar pure", keiner der beiden Algorithmen muss zwischen „bekannt unrein" und
„unklassifiziert" unterscheiden. Der Mehrwert von `~>` ist rein vorbereitend/dokumentarisch:

- **Migrationsdisziplin**: zwingt dazu, für die 31 bekannt unreinen Funktionen (`log`, `currentDate`,
  I/O) eine bewusste, positive Aussage zu treffen, statt sie unter „keine Aussage" verschwinden zu
  lassen.
- **Ground Truth für die spätere Pure-Inference-Ausbaustufe**: sie bräuchte einen Unterschied
  zwischen „fixer Sink, nie pure" (`~>`) und „unklassifiziert, bitte prüfen" (`:>`), um gezielt
  ansetzen zu können statt jede core-lib-Funktion neu zu bewerten.
- **Lesbarkeit** für Menschen, die core-lib lesen.

**Entscheidung: vier Symbole.** `~>` bleibt eigenständig, trotz fehlendem algorithmischem Mehrwert in
dieser Ausbaustufe — für die Klarheit der drei oben genannten Punkte.

Verbleibende Migration: die 31 tatsächlich unreinen Signaturen auf `~>`, die 17 Callback-Positionen
auf `?>`, alle anderen 49 pure-Signaturen auf `->`. Alle bestehenden `:>`-Vorkommen in
Beispielen/Tests (72 Stück), die bislang gar keine Purity-Aussage trafen, bleiben unverändert `:>`
und behaupten damit korrekt weiterhin nichts.

### Bedingte Purity bei Funktionen höherer Ordnung (`?>`)

`map`, `filter`, `forEach` u. a. sind selbst nicht rekursiv — ihre Purity hängt ausschließlich vom
übergebenen Callback ab, ohne dass dafür eine Fixpunkt-Iteration nötig wäre (die braucht erst
rekursiver Nutzercode, siehe Ausblick unten). Weder `:>` noch `~>` passen auf diese Fälle: `:>` an
`map` wäre falsch, sobald `log` als Callback kommt, `~>` verhindert Faltung für `map(add ...)`.
Vorbild ist Swifts `rethrows`: eine Funktion, die nur dann wirft, wenn der übergebene Closure-Parameter
wirft — hier auf pure/impure statt throws/no-throws übertragen.

**Mechanik:** ein dritter Pfeil, Platzhalter `?>` (siehe Frage 2 für die favorisierte Symbolfamilie),
steht an **zwei** Stellen derselben Deklaration:

```
map: (callback: (value: X) ?> Y, list: List(X)) ?> List(Y)
```

- Am Callback-Parameter markiert `?>`: „akzeptiert eine Funktion beliebiger Purity, und die
  tatsächliche Purity wird sichtbar nach außen weitergereicht". Das ist eine eigenständige
  Typ-Eigenschaft von `?>` selbst, **keine** Instanz von pure-ist-Untertyp-von-impure — Frage 4
  (Subtyping) muss für diesen Mechanismus also nicht vorab entschieden sein.
- Am äußeren Rückgabepfeil markiert `?>`: „meine Purity ist die tatsächlich an den so markierten
  Parameter(n) übergebene."

**Auflösung an der Aufrufstelle** (kein Fixpunkt, nur Nachschauen):

1. Ermittle die Parameter der aufgerufenen Signatur, deren eigener Typ `?>` trägt (bei `map` genau
   einer, der Callback).
2. Für jeden davon: das tatsächlich übergebene Argument an dieser Position inspizieren. Nur wenn es
   nachweislich auf eine bekannte Deklaration mit `:>`/`~>` zeigt (derselbe Anker wie beim Constant
   Folding, `isBuiltIn`/Symbolauflösung), ist die Purity bekannt; sonst konservativ `~>` annehmen.
3. Gesamtergebnis = UND über alle so ermittelten Purities (impure, sobald ein Callback impure ist).
4. Das Ergebnis ersetzt `?>` an dieser einen Aufrufstelle durch `true`/`false` — `?>` verlässt die
   `nativeFunction`-Deklaration in core-lib nie und taucht in keinem konkreten Aufrufergebnis auf.

**Offene Punkte, noch zu klären** (aufgenommen unter „Was noch offen ist"):

- Fallback, wenn die Purity des Arguments nicht statisch bekannt ist (Variable, Parameter der
  umschließenden Funktion): impure annehmen — dieselbe „unmarkiert = unrein"-Logik wie in Frage 2.
- Was mit `'conditional'` geschieht, wenn der Typ **ohne** Aufruf weitergereicht oder dereferenziert
  wird. Das ist der Punkt, an dem die Behauptung „`?>` verlässt die Deklaration nie" trägt oder
  bricht.
- Validierungsregel: ein `?>`-Rückgabepfeil ohne mindestens einen `?>`-Parameter ist eine
  bedeutungslose Deklaration — eigener Fehlercode oder stillschweigend impure?
- Kombination bei mehreren `?>`-Parametern in einer Signatur (UND, siehe oben) — Beispiele in
  core-lib mit mehr als einem Callback-Parameter noch nicht durchgesehen.

**Scope-Auswirkung:** Die 10 „TODO pure wenn die args pure sind"-Stellen (`map`, `filter`,
`filterMap` u. a.), bisher unter „Explizit außerhalb dieser Ausbaustufe" gelistet, lassen sich damit
doch in dieser Ausbaustufe lösen — ohne die schwerere Pure-Inference-Maschinerie (Fixpunkt für
Rekursion), die nur für rekursiven Nutzercode gebraucht wird. Vorgehen und Scope-Liste unten sind
entsprechend angepasst (Schritt 7 für `?>`, Gegenproben in Schritt 13).

### Frage 4: Wird Purity Teil der Zuweisbarkeit?

- **4A — Nein (Status quo).** `pure` bleibt Anzeige und Faltungsbedingung. *Kosten:* eine
  Purity-Forderung an einer Callback-Position ist wirkungslos; die `typeEquals`-Inkonsistenz aus
  dem Stand bleibt bestehen.
- **4B — Ja, als Subtyping:** ein reiner Funktionstyp ist Untertyp des unreinen (pure ist überall
  einsetzbar, unrein nicht), in Parameterposition kippt die Richtung mit der bereits vorhandenen
  Kontravarianz ([checker.ts:4964](../src/checker/checker.ts#L4964)). *Kosten:* wirkt sofort auf
  alle Callback-Positionen — tragbar nur zusammen mit 2B.
- **4C — Ja, als Gleichheit.** Bricht sofort (heute ist deklariert ≠ inferiert) und ist zu streng:
  eine reine Funktion muss an einer unreinen Position zulässig sein.

**Entscheidung: 4A, für diese Ausbaustufe.** Der einzige Konsument hier ist Constant Folding, und der
braucht keine Durchsetzung, nur eine Auskunft: „ist dieser konkrete Aufruf beweisbar pure" entscheidet
lediglich falten/nicht falten, lehnt aber nie einen Aufruf ab. `?>` ist bereits so gebaut, dass es an
der Callback-Position **jede** Funktion akzeptiert, pure oder nicht (siehe oben) — eine echte
`->`-Anforderung mit Zurückweisung (4B) wird dafür nicht gebraucht.

Eine `->`-Pflicht hätte zudem einen realen Ergonomie-Preis: Debug-`log`-Aufrufe in `predicate`,
`getKey` oder einer Vergleichsfunktion wären dann nicht mehr kompilierbar, sobald diese Position
`->` statt `?>`/`~>` verlangt. Das spricht dafür, 4B — falls überhaupt — nur gezielt und opt-in
einzuführen, nicht pauschal (siehe Ausblick).

Unabhängig von der Wahl mitzuentscheiden war: bleibt `first.pure === second.pure` in `typeEquals`
([checker.ts:4221](../src/checker/checker.ts#L4221)) so stehen? Nein — siehe Frage 5, wo die Antwort
aus der Darstellung folgt: verglichen wird die *wirksame* Purity, nicht das Label.

### Frage 5: Wie wird Purity im Typ dargestellt?

Vier Pfeile lassen sich nicht mehr in `pure: boolean` ([syntax-tree.ts:928](../src/syntax-tree.ts#L928))
ablegen. `?>` ist dabei der harte Teil: es ist keine Eigenschaft des Typs, sondern ein Verweis auf
eine Parameterposition.

Zwei Achsen, getrennt zu entscheiden.

**Achse 1 — welche Zustände.** `:>` („keine Aussage") und `~>` („unrein") verhalten sich für beide
Konsumenten identisch: beide heißen „nicht beweisbar pure". Sie trotzdem getrennt zu halten kostet
nichts und trägt die drei Gründe aus Frage 2 (Migrationsdisziplin, Ground Truth für die
Inferenz-Ausbaustufe, Lesbarkeit). **Entscheidung: vier Zustände**, `unknown | pure | impure |
conditional`.

Daraus folgt unmittelbar die offene Frage aus Frage 4: `typeEquals` darf **nicht** das Label
vergleichen, sondern die wirksame Purity — `unknown` und `impure` sind für die Gleichheit derselbe
Wert. Sonst wären `:>`- und `~>`-Typen ungleich, obwohl kein Algorithmus sie unterscheidet, und die
Deduplizierung (`createNormalizedUnionType`) bekäme eine zweite künstliche Trennung zusätzlich zu
der, die dieses Dokument gerade beseitigt.

**Achse 2 — wo die Information liegt.**

- **A — Enum-Feld am Funktionstyp.** `pure: boolean` → `purity: Purity`. Welche Parameter das `?>`
  speisen, wird bei Bedarf aus `ParamsType` gelesen, nicht gespeichert. *Vorbild:* Swifts `rethrows`
  — ein Marker an der Deklaration, die Regel „wirft, wenn ein Closure-Argument wirft" steht im
  Compiler, nicht im Typ. *Bekannte Grenze desselben Vorbilds:* `rethrows` komponiert nicht, sobald
  der Closure gespeichert oder weitergereicht wird; Swift hat das nie repariert, sondern mit typed
  throws (`throws(E)`) einen zweiten, typbasierten Mechanismus danebengestellt.
- **B — Enum plus explizite Parameternamen** (`{kind: 'conditional', parameters: ['callback']}`).
  Macht die Validierungsregel („`?>`-Rückgabe ohne `?>`-Parameter") lokal prüfbar, kostet dafür
  Synchronisationspflicht an jeder Stelle, die Funktionstypen neu baut
  ([checker.ts:1036](../src/checker/checker.ts#L1036),
  [checker.ts:1235](../src/checker/checker.ts#L1235)). Kein Sprachvorbild — es ist A mit Redundanz.
- **C — Purity als eigener `CompileTimeType`,** `?>` als
  [`parameterReference`](../src/syntax-tree.ts#L1062) auf den Callback-Parameter. `map`s Typ sagte
  dann wörtlich „meine Purity ist `callback/Purity`"; mehrere `?>`-Parameter werden zu `And(...)`.
  *Vorbilder:* Koka (row-polymorphe Effekttypen, `map : (list<a>, a -> e b) -> e list<b>`) und
  Rusts Keyword-Generics-Initiative, die für dasselbe Problem `?async` vorschlägt.
- **D — gar nicht im Typ,** sondern in einer Tabelle am Symbol. *Vorbild:* C++ `constexpr` ist
  bewusst **nicht** Teil des Funktionstyps (über einen Funktionszeiger geht die Information
  verloren), um Overload- und Konversionsexplosion zu vermeiden; Zig markiert für `comptime` gar
  nichts und lässt die Auswertung an den nicht verfügbaren Operationen scheitern.

**Entscheidung: A**, mit einer Auflage: `'conditional'` trägt bewusst **keine** Daten. Damit ist ein
späterer Wechsel auf C eine Erweiterung (aus dem Zustand wird ein Verweis), kein Umbau.

Begründung gegen die anderen: B ist A mit Synchronisationspflicht ohne eigenen Gewinn. D macht
Teil 2 des Ziels rückgängig — Purity wäre nicht mehr im Typ ablesbar, `typeToString` käme nicht
daran, und eine Callback-Position könnte Purity nie fordern; die Option ist nur ehrlich, wenn man
Empfehlung B der Architekturfrage aufgibt. Sie bleibt als dokumentierter Rückzugsweg stehen, falls
die `typeEquals`-Folgen im Bench teuer werden.

C ist die konzeptionell richtige Zielform, falls Purity je durchgesetzt wird (4B) oder ein zweiter
Effekt dazukommt, und in JUL ungewöhnlich billig, weil `parameterReference` und
`traversePlaceholders` bereits existieren — die `?>`-Auflösung wäre kein neuer Algorithmus, sondern
derselbe, der `TypeOf(values)/ElementType` in Callback-Signaturen auflöst. **Dagegen spricht die
Stelle, an der sie ansetzen müsste:** der Kommentar an
[checker.ts:991-998](../src/checker/checker.ts#L991-L998) hält fest, dass `traversePlaceholders` im
`argumentContext`-Zweig absichtlich nicht in Funktions- und Parameterknoten absteigt und dass das
Nachrüsten die Auflösung generischer Rückgabetypen zerstört hat. Eine Purity am Callback-Parameter
will genau diesen Abstieg. C ist damit entweder ein Einzeiler oder ein Umbau an der empfindlichsten
Stelle des Checkers — das entscheidet ein Versuch, nicht das Papier, und dieses Risiko trägt der
Konsument dieser Ausbaustufe nicht.

Warnende Gegenproben aus anderen Sprachen, weil beide Richtungen einen Preis haben: **Java Checked
Exceptions** sind Effekt in der Signatur *ohne* Polymorphismus — `Stream.map` nimmt bis heute kein
werfendes Lambda; das ist der Zustand, in dem JUL landet, wenn `?>` nicht mitkommt. **OCaml 5** hat
Effect Handlers ausgeliefert und die Effekttypen bewusst weggelassen, weil die Typsystemkosten zu
hoch waren — ein Team, das C hätte bauen können, hat D gewählt. **Die Sprache D** trägt `pure`
dagegen als echten Teil des Funktionstyps und zeigt dessen Preis: Attributexplosion
(`pure @safe nothrow @nogc` an jeder Signatur) plus `inout` als eigener Polymorphismus-Mechanismus.

#### Wo das Feld steht

Drei Orte, und sie tragen **nicht dasselbe**.

1. **Der Enum selbst** in `syntax-tree.ts`, weil sowohl der AST-Knoten als auch der Compile-Time-Typ
   dort liegen:

   ```ts
   /** Der geschriebene Pfeil bzw. die daraus folgende Purity-Aussage. */
   export type Purity =
   	| 'unknown'      // :>
   	| 'pure'         // ->
   	| 'impure'       // ~>
   	| 'conditional'; // ?>
   ```

2. **Am AST: die Syntax, nicht die Bedeutung.**
   [`ParseFunctionTypeLiteral`](../src/syntax-tree.ts#L402) bekommt das Feld, gebaut an genau einer
   Stelle ([parser.ts:1123](../src/parser/parser.ts#L1123)). Eine Ebene darüber liegt die Falle:
   `functionTypeBodyParser` ([parser.ts:1649](../src/parser/parser.ts#L1649)) konsumiert den Pfeil
   und entscheidet **erst danach** am optionalen `=>`, ob ein Typ oder ein Wert entsteht — der Pfeil
   muss also schon in dessen Zwischenergebnis (`functionTypeBody`) stehen und erreicht damit
   zwangsläufig auch den `functionLiteral`-Zweig. Deshalb braucht
   [`ParseFunctionLiteral`](../src/syntax-tree.ts#L374) das Feld ebenfalls — dort steht heute der
   auskommentierte `pure: boolean` mit dem `!=>`-TODO
   ([syntax-tree.ts:379](../src/syntax-tree.ts#L379)).

   Nach Entscheidung 1A ist das Feld am Literal aber **kein** Purity-Wert, sondern nur „welcher
   Pfeil wurde geschrieben", gebraucht, um `->`/`~>`/`?>` dort mit einem Fehlercode abzulehnen.
   Es heißt daher am AST `arrow`, nicht `purity`: **AST = was dasteht, CompileTimeType = was gilt.**
   Am `functionLiteral` fallen die beiden auseinander.

3. **Am Typ: die Bedeutung.** `CompileTimeFunctionType.pure`
   ([syntax-tree.ts:928](../src/syntax-tree.ts#L928)) → `purity: Purity`, ebenso der Parameter von
   [`createCompileTimeFunctionType`](../src/syntax-tree.ts#L943). 11 Aufrufstellen, davon vier
   inhaltlich:
   - [checker.ts:2702](../src/checker/checker.ts#L2702) (`functionTypeLiteral`) — liest künftig
     `expression.arrow` statt hart `true`.
   - [checker.ts:2587](../src/checker/checker.ts#L2587) (`functionLiteral`) — heute hart `false`.
     Kleine Entscheidung: `'unknown'` statt `'impure'` ist ehrlicher („nicht bewiesen" statt
     „bewiesen unrein") und vorwärtskompatibel zur Inferenz-Ausbaustufe.
   - [checker.ts:1036](../src/checker/checker.ts#L1036) und
     [checker.ts:1235](../src/checker/checker.ts#L1235) — kopieren beim Dereferenzieren; hier ist zu
     klären, was mit `'conditional'` geschieht (siehe offene Punkte).

Und eines **verschwindet**: der `pure`-Parameter von `nativeFunction`
([checker.ts:282](../src/checker/checker.ts#L282)) entfällt ersatzlos, der Wert kommt aus dem
`FunctionType`-Argument. Das war das Argument für Option B der Architekturfrage: nur eine Stelle
kann lügen.

**Nicht betroffen:** der Emitter. Typen werden nicht emittiert, `purity` erreicht ihn nie.

## Der Konsument: Constant Folding

**Voraussetzung für Faltung eines Aufrufs:**

- Die aufgerufene Funktion ist eine core-lib-`nativeFunction` mit `pure === true`.
- Alle Argumente sind zur Compile-Zeit als Literal/konstanter Wert bekannt (analog zu den bereits
  vorhandenen `integerLiteral`/`floatLiteral`/`textLiteral`/`booleanLiteral`-Typen im Checker).
- Der Aufruf zeigt nachweislich auf die native Deklaration. Ein Aufruf über eine Zwischenvariable
  (`f = add`, dann `f(2 3)`) fällt heraus, solange die Erkennung am Symbol hängt (siehe unten).

**Durchführung:** Ausgeführt wird die **Runtime-Implementierung**, nicht der `§js§`-Text. Der
`§js§`-Block ist dafür keine verlässliche Quelle: bei `add`, `and`, `or` und `deepEqual` steht dort
`§TODO§`, bei `log` nur `console.log`. Die tatsächlichen Implementierungen liegen in `runtime.ts`;
der Emitter importiert alle Runtime-Exporte und referenziert sie per Namen
([emitter.ts:11](../src/emitter.ts#L11)). Die Faltung geht denselben Weg: über den core-lib-Namen
nach `runtime[name]`, mit den (in JS-Werte übersetzten) Literal-Argumenten. Kein Nachbau der
Semantik im Checker, sondern derselbe Code, der auch zur Laufzeit läuft. Das Ergebnis wird zurück in
einen `CompileTimeType` (Literal-Typ) übersetzt.

Zwei Details auf diesem Weg: reservierte Namen sind im Runtime-Export mit `_` escaped (`_Text`,
`_Boolean`), und einige Exporte sind mit `_createFunction` verpackt (`parseJson`, `toJson`, `runJs`,
`combine$`, `take$`) — das sind keine nackten Callables.

**Erkennung des Aufrufziels:** Über `functionRef` allein ist „das ist derselbe native Aufruf" nicht
zu beantworten — der Typ trägt keinen Herkunftsnamen. Vorhandener Anker ist `isBuiltIn` aus der
Referenzauflösung ([checker.ts:376](../src/checker/checker.ts#L376)): der oberste Scope *ist*
`builtInSymbols`, der Symbolname ist damit zugleich der Runtime-Export-Name.

**Sicherheitsnetz gegen Terminierung:** Ein Schritt-/Aufrufzähler (kein Wall-Clock-Timeout — siehe
Begründung unten), der die Auswertung eines einzelnen Ausdrucks abbricht, wenn ein Budget
überschritten wird. Für diese Ausbaustufe ist das Risiko klein (keine Rekursion durch Nutzercode
möglich, nur einzelne native Aufrufe auf Literalen), aber nicht null — z. B. könnte `regex` mit
katastrophalem Backtracking auf einem langen Text-Literal hängen. Deshalb schon jetzt vorsehen, auch
wenn die eigentliche Notwendigkeit erst mit Ausbaustufe „Inferenz" (rekursive JUL-Funktionen) steigt.

*Warum Schritt-/Aufrufzähler statt Zeit:* Wall-Clock-Timeout macht denselben Build je nach
Maschinenlast mal erfolgreich, mal fehlschlagend — nicht reproduzierbar. Vorbilder: Zig `comptime`
(`branch_quota`, zählt Verzweigungen), Rust CTFE/Miri (Instruktionslimit). Beide zählen
Ausführungsschritte, keine Zeit, genau um Nichtdeterminismus zu vermeiden.

### Zu entscheiden beim Falten

- **Welche Builtins?** Typkonstruktoren (`List`, `Or`, `And`, `TypeOf`) sind rein, liefern aber
  Runtime-Typobjekte, die zurückübersetzt werden müssten — und der Checker behandelt sie bereits
  gesondert ([checker.ts:235](../src/checker/checker.ts#L235) ff.). Vorschlag: Stufe 1 nur mit
  skalaren Ein- und Ausgaben.
- **Wert↔Typ-Grenze:** welche Literalvarianten hinein und heraus dürfen (bigint, number, string,
  boolean), ob Kollektionen aus Literalen (`tuple`, `dictionaryLiteral`) zählen, und was mit
  `Rational` geschieht — `add` kann ein `Fraction`-Objekt liefern, für das es keinen Literaltyp gibt.
- **Fehler beim Falten** (`parseFloat`, `parseJson`, Division durch 0, geworfene Ausnahme):
  Vorschlag abfangen, nicht falten, keine neue Diagnose. Faltung darf nie selbst Fehlerquelle sein.
- **Granularität und Rücksetzung des Zählers:** pro Ausdruck, pro Datei oder pro Check-Lauf? Der
  Language Server ist ein langlebiger Prozess — ein globaler Zähler blockierte nach einiger Zeit
  dauerhaft.
- **Kosten:** Faltung läuft im Language Server bei jedem Tastendruck mit, und präzisere Typen sind
  im Checker nachweislich teuer (CHECKER-AUDIT.md, „Fallen im Checker": `typeEquals` aus der
  Deduplizierung). Daher die Messung in Schritt 8 vor der Faltung und in Schritt 12 danach.

## Explizit außerhalb dieser Ausbaustufe

- Keine Purity-**Inferenz** aus dem Rumpf einer `functionLiteral`. Nach Entscheidung 1A trägt der
  Pfeil am Literal keine Purity-Aussage; der Typ einer `functionLiteral` bleibt `'unknown'`.
- Keine Faltung von Aufrufen an Nutzerfunktionen.
- Keine Durchsetzung von Purity in der Zuweisbarkeit (Frage 4 = 4A).

Die 10 „TODO pure wenn die args pure sind"-Stellen (`map`, `filter`, `filterMap` u. a.) standen
früher hier und sind mit `?>` **in** den Umfang gerückt — sie brauchen keine Fixpunkt-Iteration,
nur Nachschauen an der Aufrufstelle.

## Was noch offen ist

Nach den Entscheidungen zu Frage 1, 2, 4 und 5 ist die Ausbaustufe bis einschließlich Schritt 9
umsetzbar. Offen sind drei Punkte, die vorher fallen müssen, plus die Faltungsfragen.

**Vor Schritt 4 — Was passiert mit `'conditional'` beim Dereferenzieren?**
[checker.ts:1036](../src/checker/checker.ts#L1036) und
[checker.ts:1235](../src/checker/checker.ts#L1235) bauen Funktionstypen neu und kopieren `pure` mit.
Die Mechanik oben behauptet, `?>` verlasse die core-lib-Deklaration nie — das gilt aber nur für den
direkten Aufruf. Bei Weitergabe (`f = map`), bei `map` in einer Kollektion oder als Argument eines
anderen `?>`-Parameters bleibt `'conditional'` stehen. Zu entscheiden: dort auflösen, konservativ
auf `'impure'` zusammenfallen lassen, oder ein Fehler. **Ohne diese Entscheidung ist `?>` nicht
implementierbar**, weil unklar bleibt, was der Typ außerhalb eines Aufrufs bedeutet.

**Vor Schritt 3 — zwei Fehlercodes vergeben und Meldungstexte festlegen.** Beide folgen aus bereits
getroffenen Entscheidungen, existieren aber noch nicht. Beide sind Kategorie `semantic` („der Baum
steht, aber das Konstrukt ist regelwidrig"), keine Typfehler — sie entstehen ohne jeden Typvergleich,
allein daraus, welcher Pfeil wo steht:

- **Purity-Pfeil an einem `functionLiteral`** (`(a: Integer) -> Integer => a`). Nach 1A verboten,
  weil der Rumpf die Behauptung mangels Inferenz nicht einlöst. Der Parser nimmt den Pfeil ohne
  eigene Regel klaglos an: `functionTypeBodyParser` konsumiert ihn, bevor am optionalen `=>`
  feststeht, ob ein Typ oder ein Wert entsteht — ohne Fehlercode gäbe es eine Schreibweise, die
  aussieht, als sage sie etwas, und stillschweigend nichts bewirkt. Genau die Lücke, die dieses
  Dokument schließt.
- **`?>`-Rückgabepfeil ohne mindestens einen `?>`-Parameter.** Die Deklaration sagt „meine Purity
  ist die der so markierten Parameter" und markiert keine — die Auflösung an der Aufrufstelle hätte
  nichts, worüber sie das UND bildet, und fiele stumm auf `'impure'` zurück. Betrifft heute nur
  core-lib, weil die Purity-Pfeile dort reserviert sind; der Code ist trotzdem nötig, weil die
  Regel sonst nirgends steht.

*Schwere:* beide `error`, nicht `warning`. Eine Lockerung ist später rückwärtskompatibel (1B würde
den ersten Code entfallen lassen), eine Verschärfung von `warning` zu `error` wäre es nicht.

*Was ein neuer Code kostet* (siehe Kopfkommentar von [compiler-errors.ts](../src/compiler-errors.ts)):
drei Einträge — Enum, `errorInfos` (der Mapped Type erzwingt ihn), und ein Abschnitt in
`jul-homepage/docs/docs/documentation/error-codes.md`. Nur der dritte wird von keinem Compiler
erzwungen und ist zugleich der, den der Nutzer zur Fehlermeldung findet. Nummern werden nie
wiederverwendet. Vorschlag: eine eigene Unterregion `2600` „Purity-Pfeile" im semantischen Block
(`2400` Parameter, `2500` `discardedValue` sind belegt), mit `purityArrowNotAllowedForFunctionLiteral
= 2600` und `conditionalPurityWithoutConditionalParameter = 2601`.

**Vor Schritt 6 — mehrere `?>`-Parameter in einer Signatur.** Die Verknüpfung ist als UND
entschieden; noch nicht durchgesehen ist, ob core-lib überhaupt eine Signatur mit mehr als einem
Callback-Parameter enthält. Falls nein, ist die Regel unbelegt, aber harmlos.

**Entschieden — `typeToString` bei `'unknown'` rendert `:>`.** `:>` und `~>` sind im Typ
unterschieden, aber jede Nutzerfunktion trägt `'unknown'`. `:>` bedeutet genau „keine Aussage", und
`'unknown'` ist genau das; jede andere Darstellung erfände eine Aussage, die der Typ nicht trifft.
Nebeneffekt: die 64 bestehenden `:>`-Testerwartungen bleiben unverändert, und im Hover ändert sich
für Nutzercode nichts.

## Vorgehen

Die Messungen sind eigene Schritte, keine Anhänge — ein „vor und nach Schritt X" ist beim Abarbeiten
nicht mehr messbar.

1. `npm run bench -- --save` (Ausgangsmessung).
2. Roter Test: `pure` einer nachweislich unreinen core-lib-Funktion (`currentDate`, `log`). Belegt
   die Fehlbelegung aus dem Stand, bevor irgendetwas daran geändert wird.
3. Parser: `->`, `~>` und `?>` als weitere Tokens neben `:>` in
   `functionTypeBodyParser`/`returnTypeTokenParser` zulassen; die Pfeil-Art wandert als `arrow`
   durch `functionTypeBody` in `ParseFunctionTypeLiteral` **und** `ParseFunctionLiteral` (siehe
   „Wo das Feld steht"). Reihenfolge der `discriminatedChoiceParser`-Zweige gegen `=>` verifizieren.
   Fehlercode für einen Purity-Pfeil am `functionLiteral`. Parser-Tests analog zu den bestehenden
   `:>`-Tests, je einer pro Pfeil.
4. Typdarstellung: `Purity`-Enum in `syntax-tree.ts`, `pure: boolean` → `purity: Purity` an
   `CompileTimeFunctionType` und `createCompileTimeFunctionType`, 11 Aufrufstellen nachziehen
   (`functionLiteral` → `'unknown'`). `typeEquals` auf wirksame Purity umstellen
   ([checker.ts:4221](../src/checker/checker.ts#L4221)).
5. Checker: `purity` beim Auflösen eines `functionTypeLiteral` aus `arrow` lesen statt
   hartzukodieren; `nativeFunction`s Signatur auf zwei Parameter (`FunctionType`, `js`) reduzieren.
6. Migration core-lib: alle 81 `nativeFunction`-Aufrufe von `(FunctionType, true/false, js)` auf
   `(FunctionType mit passendem Pfeil, js)` — 49 auf `->`, 31 auf `~>`, die 17
   Callback-Parameterpositionen auf `?>`. Die bestehenden Bool-Werte sind die Vorlage, aber
   ungeprüft — Grenzfälle (`regex`, `parseFloat`, `parseJson`, `assume`, `runJs`) einzeln
   verifizieren: deterministisch und frei von Systemzustand?
7. `?>`-Auflösung an der Aufrufstelle (Schritte 1–4 der Mechanik oben), inklusive der Entscheidung
   zum Dereferenzieren aus den offenen Punkten und dem Fehlercode für `?>`-Rückgabe ohne
   `?>`-Parameter. Tests: pure Callback → pure, `log` als Callback → impure, nicht statisch
   bekanntes Argument → impure.
8. Mitziehende Artefakte: TextMate-Grammatik ([jul.tmLanguage.yaml](../../vscode-jul-language-service/syntaxes/jul.tmLanguage.yaml),
   die YAML ist die Quelle), `snippets.json`, `handbook.md`, die öffentliche Doku in
   `jul-homepage/docs`, `nativeFunction`-Testfälle in `checker.test.ts`.
9. `typeToString` `case 'function'` ([checker.ts:5741](../src/checker/checker.ts#L5741)) um
   `type.purity` erweitern, damit der Pfeil in Fehlermeldungen und Hover erscheint — `'unknown'`
   rendert als `:>`, die bestehenden Testerwartungen bleiben damit unverändert.
10. `npm run bench -- --save` (trennt die Kosten des Syntaxumbaus von denen der Faltung).
11. Roter Test für die Faltung (`add(2 3)` → Literal `5`).
12. Constant-Folding-Stelle im Checker identifizieren (beim Auflösen eines Funktionsaufrufs, analog
    zu `getReturnTypeFromFunctionCall`) und um den Fall „Builtin + `purity === 'pure'` + alle
    Argumente literal" ergänzen, inklusive Schritt-Zähler als Guard vor der Ausführung.
13. Gegenproben als Tests: nicht-literale Argumente (keine Faltung, unverändertes Verhalten),
    `purity !== 'pure'` (keine Faltung), werfender Aufruf (keine Faltung, keine neue Diagnose),
    benannte Argumente (keine Faltung, solange Stufe 1 nur positional faltet).
14. `npm run bench -- --save` (Abschluss), `npm test`, `npm run typecheck`, ein paar
    `jul-examples`-Projekte neu bauen.

**Schnittmöglichkeit:** Schritt 1–10 sind eine abgeschlossene, testbare Einheit ohne Ausführung von
Code zur Compile-Zeit. Die Faltung (11–14) trägt als einziger Teil Semantik-Risiko und blockiert den
Rest nicht — sie lässt sich als eigene Ausbaustufe mit eigenem Dokument abtrennen.

## Ausblick: Ausbaustufe „Pure Inference"

Vorgemerkt, nicht Teil dieser Ausbaustufe: Purity automatisch aus dem Aufrufgraph ableiten statt nur
manuell an der `nativeFunction`-Grenze zu deklarieren — eine `functionLiteral` wäre dann pure, wenn
alle aufgerufenen Funktionen pure sind und kein Stream gelesen/geschrieben wird (Fixpunkt-Iteration
für Rekursion), Funktionen höherer Ordnung wie `map` wären pure, wenn ihr Callback-Argument es ist.
Löst die 9 TODO-Stellen in core-lib.jul und die Hartkodierung bei `functionLiteral` aus dem Stand.
Der Schritt-/Aufrufzähler aus dieser Ausbaustufe wird dort notwendig statt nur vorsorglich, weil dann
auch rekursiver Nutzercode zur Compile-Zeit ausgeführt werden könnte. Eigene Architekturfrage bei
Funktionen höherer Ordnung: ohne Purity-Polymorphismus in der Signatur muss die Purity von `map`
&c. an der konkreten Aufrufstelle aus dem übergebenen Callback abgeleitet werden, nicht generisch aus
der Deklaration selbst (siehe Diskussion zu Koka-artigem Effekt-Polymorphismus vs. lokaler
Call-Site-Auflösung).

### Ausblick: echte Durchsetzung (Frage 4 = 4B), nicht Teil dieser oder der nächsten Ausbaustufe

Für diese Ausbaustufe entschieden gegen Durchsetzung (siehe Entscheidung zu Frage 4): Constant
Folding braucht nur eine Auskunft „beweisbar pure ja/nein", keine Zurückweisung nicht-pure Argumente.
Denkbare spätere Konsumenten, für die eine echte `->`-Anforderung (4B) einen Mehrwert hätte, der über
Auskunft hinausgeht:

- **Ein künftiges `memoize`**: Caching ist falsch, wenn die gecachte Funktion nicht bei gleichen
  Argumenten immer dasselbe liefert — hier wäre Durchsetzung, nicht nur Anzeige, der Punkt.
- **Vergleichsfunktionen bei Sortierung**: eine unreine Compare-Funktion kann eine in sich
  widersprüchliche Ordnung liefern und damit die Algorithmus-Invariante brechen, nicht nur das
  Ergebnis überraschen.
- **`getKey`/`getValue` bei Gruppierung/Dictionary-Aufbau**: das Ergebnis ist nur wohldefiniert, wenn
  gleiche Eingaben immer derselben Zuordnung entsprechen.
- **`predicate` bei Funktionen mit Kurzschluss-Semantik** (`some`, `every`, `find`): wie oft und in
  welcher Reihenfolge das Prädikat aufgerufen wird, ist Implementierungsdetail — ein unreines
  Prädikat macht beobachtbares Verhalten von genau diesem Detail abhängig.
- **Künftige Parallelisierung von `map`/`filter`**: Reihenfolge-/Zeitpunkt-Unabhängigkeit der
  Callbacks wäre Voraussetzung für Korrektheit bei nebenläufiger Ausführung.

**Ausdrücklicher Gegeneinwand, der vor einer Einführung berücksichtigt werden muss:** eine `->`-Pflicht
an diesen Positionen verbietet auch das gängige Debugging-Pattern, testweise `log` in `predicate`,
`getKey` oder eine Vergleichsfunktion einzusetzen. Eine pauschale Durchsetzung an all diesen Stellen
hätte also einen realen Ergonomie-Preis. Falls 4B je verfolgt wird, eher gezielt/opt-in an einzelnen,
sorgfältig ausgewählten Stellen (z. B. nur `memoize`) statt als allgemeine Regel für alle
Callback-Parameter.
