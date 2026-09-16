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
  Pfeil, ohne Prüfung des Rumpfs; ohne Pfeil (`(a) => ...`) bleibt es bei „keine Aussage". *Kosten:* die
  Zusicherung kann lügen, bis die Inferenz-Ausbaustufe sie prüft. *Nutzen:* eine Bedeutung für ein
  Symbol, und die Inferenz prüft später die Zusicherung, statt sie zu ersetzen — derselbe Weg wie
  beim deklarierten Rückgabetyp, der heute schon gegen den inferierten geprüft wird.
- **1C — Deklaration mit sofortiger Prüfung.** Braucht Purity-Inferenz über den Rumpf, das ist die
  nächste Ausbaustufe. Für jetzt ausgeschlossen.

**Entscheidung: 1B.** Der Wert übernimmt die Purity aus dem geschriebenen Pfeil, ohne Prüfung des
Rumpfs; ohne Pfeil oder mit `:>` bleibt es bei `'unknown'`.

Ursprünglich stand hier 1A („die Purity-Pfeile bleiben reserviertes Vokabular für
`functionTypeLiteral`-Deklarationen in core-lib"), mit der Begründung, eine Zusicherung am Literal
sei mangels Inferenz unbelegbar und in dieser Ausbaustufe ohnehin folgenlos. Das ist ein Argument
gegen ihre *Wirkung*, keines gegen ihre *Zulässigkeit*, und es hat zwei Löcher:

- **Ungleichbehandlung.** `nativeFunction`s `FunctionType`-Argument ist dieselbe Syntax, die ein
  Nutzer hinschreibt. 1A hieße: core-lib darf `->` schreiben, Nutzercode nicht. Das ist genau die
  Kostenart, die 1A laut seiner eigenen Begründung vermeiden sollte (Prinzip 3, „dieselbe
  Schreibweise bedeutet an zwei Stellen Verschiedenes") — der Einwand war dort nur für `:>`
  entkräftet worden, nicht für die neuen Pfeile.
- **1A verbietet nur die Hälfte.** Verboten wäre das Literal mit Rumpf; den *Typ*
  `(a: Integer) -> Integer` dürfte der Nutzer weiter hinschreiben — nur könnte ihn keine
  selbstgeschriebene Funktion je erfüllen, weil jede `'unknown'` trägt. Erlaubt wäre die
  Deklaration, verboten die Erfüllung.

Dazu kommt der Nutzen, den 1B gegenüber 1A behält: die Inferenz-Ausbaustufe **prüft** die
Zusicherung später, statt sie zu ersetzen — derselbe Weg wie beim deklarierten Rückgabetyp, der
heute schon gegen den inferierten geprüft wird (`JUL5100`). Bei 1A müsste stattdessen ein gerade
erst eingeführter Fehlercode wieder verschwinden, und Nummern werden nie wiederverwendet.

*Bewusst getragenes Risiko:* die Zusicherung kann lügen. Wirksam wird eine Lüge nur an einer Stelle,
der Argument-Regel (`map(myFn ...)` gilt als pure, weil der Nutzer es behauptet hat). Bis in die
Faltung trägt sie nicht: die verlangt literale Argumente, und eine Funktion ist keins. Mit der
Inferenz-Ausbaustufe wird aus der Zusicherung eine geprüfte Deklaration; bis dahin ist sie das, was
`assume` an anderer Stelle auch ist — eine Behauptung des Nutzers, die der Compiler übernimmt.

1C (Deklaration mit sofortiger Prüfung) bleibt ausgeschlossen: das ist die Inferenz-Ausbaustufe.


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
dort einen pure-Callback liefern kann) entfällt, sobald die Purity eines Aufrufs ohnehin die Purity
seiner Funktionsargumente einbezieht (siehe
[Funktionen höherer Ordnung](#funktionen-höherer-ordnung-die-argument-regel) unten): die
Callback-Positionen brauchen dann gar keine Markierung und bleiben `:>`. `:>` selbst bleibt
eigenständig „keine Aussage über Purity" (siehe Entscheidung zu Frage 1) — Migrationskosten für
einen komplett neuen Pfeil sind laut Nutzer vernachlässigbar, die Sprache ist noch in Entwicklung.

Favorisierte Symbole: eine harmonische Familie mit dem bereits bestehenden `functionToken` `=>` —
`=>` (Lambda-Rumpf), `->` (fügt keine Unreinheit hinzu), `~>` (unrein). Alle nach demselben Muster
gebaut: ein einzelnes, sonst unbelegtes Zeichen plus `>`. Das vermeidet, was `:>` heute tut — den
Doppelpunkt wiederzuverwenden, der in JUL bereits eine andere Bedeutung trägt (`(a: Integer)`,
`[a: Integer]`). `:>` bleibt daneben bestehen, aber außerhalb dieser Familie — kein Widerspruch,
weil es keine Purity-Aussage macht und daher nicht zur Pfeil-Familie gehören muss. Damit gilt:

- `:>` — keine Aussage (Status quo, bleibt an allen heutigen Stellen unverändert)
- `->` — fügt keine eigene Unreinheit hinzu
- `~>` — unrein

Ein vierter Pfeil für „abhängig vom Callback" stand hier zwischenzeitlich (`?>`, nach dem Vorbild von
Swifts `rethrows`). Er ist gestrichen: die Abhängigkeit vom Callback ist keine Eigenschaft einzelner
Signaturen, sondern gilt für jeden Aufruf — siehe den Abschnitt zu Funktionen höherer Ordnung.

Zu `->`: kein Kollisionsrisiko mit einem Subtraktions-Operator, da JUL keinen eigenen
Subtraktions-Token hat (arithmetische Operationen laufen über Funktionen wie `add`). Zu prüfen bleibt
trotzdem die Tokenisierungsreihenfolge: der bestehende Pfeil-Token ist `' :> '` **inklusive
umgebender Leerzeichen** ([parser.ts:259](../src/parser/parser.ts#L259)), `=>` ist der
`functionToken`. Ein Symbol, das mit `=>` beginnt oder endet, verlangt Blick auf die Reihenfolge der
`discriminatedChoiceParser`-Zweige — betrifft hier keinen der Kandidaten direkt, aber die Abgrenzung
zu `=>` selbst ist bei der Umsetzung zu verifizieren.

Alternativvorschlag aus einer früheren Notiz: `!=>` statt `~>`
([syntax-tree.ts:379](../src/syntax-tree.ts#L379)) — passt schlechter in die Familie (zwei
Sonderzeichen statt eines), daher nachrangig.

**Mehrwert eines eigenen Impure-Symbols gegenüber „keine Aussage".** Für den Konsumenten dieser
Ausbaustufe (Constant Folding) verhalten sich `~>` und `:>` identisch — beide sind „nicht beweisbar
pure", der Algorithmus muss zwischen „bekannt unrein" und „unklassifiziert" nicht unterscheiden. Der
Mehrwert von `~>` ist rein vorbereitend/dokumentarisch:

- **Migrationsdisziplin**: zwingt dazu, für die 31 bekannt unreinen Funktionen (`log`, `currentDate`,
  I/O) eine bewusste, positive Aussage zu treffen, statt sie unter „keine Aussage" verschwinden zu
  lassen.
- **Ground Truth für die spätere Pure-Inference-Ausbaustufe**: sie bräuchte einen Unterschied
  zwischen „fixer Sink, nie pure" (`~>`) und „unklassifiziert, bitte prüfen" (`:>`), um gezielt
  ansetzen zu können statt jede core-lib-Funktion neu zu bewerten.
- **Lesbarkeit** für Menschen, die core-lib lesen.

**Entscheidung: drei Symbole.** `~>` bleibt eigenständig, trotz fehlendem algorithmischem Mehrwert in
dieser Ausbaustufe — für die Klarheit der drei oben genannten Punkte.

Verbleibende Migration: die 31 tatsächlich unreinen Signaturen auf `~>`, alle anderen 49 auf `->`.
Die 17 Callback-Parameterpositionen bleiben unverändert, ebenso alle bestehenden `:>`-Vorkommen in
Beispielen/Tests (72 Stück), die bislang gar keine Purity-Aussage trafen und das weiterhin nicht tun.

### Funktionen höherer Ordnung: die Argument-Regel

`map`, `filter`, `forEach` u. a. fügen von sich aus keine Unreinheit hinzu — sie rufen nur den
Callback. Ihre tatsächliche Purity hängt ausschließlich vom übergebenen Callback ab, ohne dass dafür
eine Fixpunkt-Iteration nötig wäre (die braucht erst rekursiver Nutzercode, siehe Ausblick unten).

Sie brauchen dafür **kein eigenes Symbol**. Ein Aufruf ist beweisbar rein, wenn beides gilt:

1. die aufgerufene Funktion ist `->` deklariert, und
2. jedes Argument, das selbst eine Funktion ist, ist beweisbar rein.

Bedingung 2 gilt **immer**, nicht nur wo jemand eine Markierung gesetzt hat. `map` bekommt damit
schlicht `->`, und ob ein konkreter `map`-Aufruf rein ist, ergibt sich aus derselben Regel, die für
jeden anderen Aufruf auch gilt. `->` heißt einheitlich **„fügt keine eigene Unreinheit hinzu"** —
bei `add` ist das dasselbe wie „rein", bei `map` fällt die Bedingung an den Argumenten zusätzlich an.
Eine Bedeutung, eine Regel.

**Warum Swift dafür `rethrows` braucht und JUL nicht.** In Swift ist `throws` durchgesetzt: eine
nicht markierte Funktion darf einen werfenden Closure gar nicht aufrufen, deshalb braucht es ein
eigenes Schlüsselwort, um die Ausnahme zu erlauben. JUL setzt nach 4A nichts durch — Purity ist eine
Auskunft, kein Vertrag, und eine Auskunft lässt sich an der Aufrufstelle ausrechnen, statt sie in der
Deklaration anzukündigen. Ein Marker löste hier ein Problem, das es ohne Durchsetzung nicht gibt.

**Auflösung an der Aufrufstelle** (kein Fixpunkt, nur Nachschauen):

1. Ist die aufgerufene Funktion `->`? Sonst ist der Aufruf nicht beweisbar rein, fertig.
2. Sammle die Argumente, deren Typ ein Funktionstyp ist. Für jedes: nur wenn es nachweislich auf
   eine Deklaration mit geschriebenem Purity-Pfeil zeigt (derselbe Anker wie beim Constant Folding,
   `isBuiltIn`/Symbolauflösung), ist seine Purity bekannt; sonst konservativ `'impure'`. Nach 1B
   zählt dazu auch die ungeprüfte Zusicherung an einer Nutzerfunktion — das ist die einzige Stelle,
   an der eine falsche Zusicherung in dieser Ausbaustufe überhaupt wirkt. Bis in die Faltung trägt
   sie nicht: die verlangt literale Argumente, und eine Funktion ist keins.
3. Ergebnis = UND über Schritt 1 und alle Purities aus Schritt 2.

Beispiele:

| Aufruf | `map` | Argument | Ergebnis |
| --- | --- | --- | --- |
| `map(add [1 2])` | `->` | `add` ist `->` | beweisbar rein |
| `map(log [1 2])` | `->` | `log` ist `~>` | unrein |
| `map(myFn [1 2])` mit `myFn = () :> Any => someFn()` | `->` | `myFn` ist `'unknown'` | nicht beweisbar rein |

Der dritte Fall ist der interessante: `myFn`s eigene Purity hinge an `someFn`, aber diese Ausbaustufe
leitet sie nicht ab — `myFn` trägt `'unknown'` und zählt damit als nicht beweisbar rein. Konservativ
und richtig. Die Inferenz-Ausbaustufe füllt später `myFn`s Purity aus dem Aufrufgraph; die
Argument-Regel bleibt dabei unverändert und liefert dann von selbst das bessere Ergebnis. Sie setzt
an keiner Stelle voraus, *warum* ein Argument rein ist.

Das Ergebnis gilt für **diese** Aufrufstelle. Der Typ von `map` selbst bleibt unverändert `->`; es
gibt keinen Zustand, der aus der Deklaration herauswandert und anderswo unbestimmt wäre. `f = map`
ist deshalb unproblematisch: `f` trägt `->` wie `map`, und `f(cb [1 2])` löst genauso auf.

**Preis:** eine Funktion, die einen Callback entgegennimmt, ihn aber nie aufruft, gilt bei unreinem
Callback trotzdem als unrein. Das ist eine Überschätzung, also sicher — und in core-lib kommt der
Fall nicht vor: alle 17 Callback-Parameter werden von ihrer Funktion aufgerufen.

**Zweiter Preis:** dass `map`s Purity vom Callback abhängt, steht nicht mehr in `map`s Signatur,
sondern in der Sprachregel. Der Tausch lohnt sich: eine Regel, die für jeden Aufruf gleich gilt,
statt einer Markierung, die je Signatur richtig gesetzt werden muss.

**Grenze:** Funktionen, die in einem Datenargument stecken (`f([cb = log])`), erfasst Schritt 2 nur,
wenn er in Kollektionen absteigt. Für diese Ausbaustufe ohne Belang — gefaltet wird ohnehin nur mit
literalen Argumenten.

**Scope-Auswirkung:** Die 10 „TODO pure wenn die args pure sind"-Stellen (`map`, `filter`,
`filterMap` u. a.), bisher unter „Explizit außerhalb dieser Ausbaustufe" gelistet, erledigen sich
damit ohne eigenen Mechanismus: sie bekommen `->`, den Rest macht die Regel.

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
lediglich falten/nicht falten, lehnt aber nie einen Aufruf ab. Die Argument-Regel (siehe oben) rechnet
diese Auskunft aus, ohne je ein Argument zurückzuweisen — eine echte `->`-Anforderung mit
Zurückweisung (4B) wird dafür nicht gebraucht. Callback-Positionen bleiben deshalb `:>` und nehmen
weiterhin jede Funktion an, pure oder nicht.

Eine `->`-Pflicht hätte zudem einen realen Ergonomie-Preis: Debug-`log`-Aufrufe in `predicate`,
`getKey` oder einer Vergleichsfunktion wären dann nicht mehr kompilierbar, sobald diese Position
`->` verlangt. Das spricht dafür, 4B — falls überhaupt — nur gezielt und opt-in einzuführen, nicht
pauschal (siehe Ausblick).

Unabhängig von der Wahl mitzuentscheiden war: bleibt `first.pure === second.pure` in `typeEquals`
([checker.ts:4221](../src/checker/checker.ts#L4221)) so stehen? Nein — siehe Frage 5, wo die Antwort
aus der Darstellung folgt: verglichen wird die *wirksame* Purity, nicht das Label.

### Frage 5: Wie wird Purity im Typ dargestellt?

Drei Pfeile lassen sich nicht mehr in `pure: boolean` ([syntax-tree.ts:928](../src/syntax-tree.ts#L928))
ablegen.

Zwei Achsen, getrennt zu entscheiden.

**Achse 1 — welche Zustände.** `:>` („keine Aussage") und `~>` („unrein") verhalten sich für den
Konsumenten identisch: beide heißen „nicht beweisbar pure". Sie trotzdem getrennt zu halten kostet
nichts und trägt die drei Gründe aus Frage 2 (Migrationsdisziplin, Ground Truth für die
Inferenz-Ausbaustufe, Lesbarkeit). **Entscheidung: drei Zustände**, `unknown | pure | impure`.

Einen vierten Zustand für „abhängig vom Callback" braucht es nicht: die Abhängigkeit wird an der
Aufrufstelle ausgerechnet (Argument-Regel) und steht nie im Typ. Das erspart dieser Ausbaustufe
einen Zustand, der sonst durch jede Typkopie propagiert wäre — unter anderem durch
[checker.ts:1036](../src/checker/checker.ts#L1036), das Callback-Parametertypen neu baut.

Daraus folgt unmittelbar die offene Frage aus Frage 4: `typeEquals` darf **nicht** das Label
vergleichen, sondern die wirksame Purity — `unknown` und `impure` sind für die Gleichheit derselbe
Wert. Sonst wären `:>`- und `~>`-Typen ungleich, obwohl kein Algorithmus sie unterscheidet, und die
Deduplizierung (`createNormalizedUnionType`) bekäme eine zweite künstliche Trennung zusätzlich zu
der, die dieses Dokument gerade beseitigt.

**Achse 2 — wo die Information liegt.**

- **A — Enum-Feld am Funktionstyp.** `pure: boolean` → `purity: Purity`. Der Typ trägt nur die
  Aussage der eigenen Deklaration; die Abhängigkeit vom Callback rechnet die Argument-Regel an der
  Aufrufstelle aus und legt sie nirgends ab.
- **B — Enum plus Zusatzdaten am Typ** (etwa, welche Parameter die Purity speisen). Ohne `?>` gibt
  es nichts abzulegen — die Option ist mit der Argument-Regel gegenstandslos geworden.
- **C — Purity als eigener `CompileTimeType`,** als [`parameterReference`](../src/syntax-tree.ts#L1062)
  auf einen Parameter. *Vorbilder:* Koka (row-polymorphe Effekttypen,
  `map : (list<a>, a -> e b) -> e list<b>`) und Rusts Keyword-Generics-Initiative, die für dasselbe
  Problem `?async` vorschlägt.
- **D — gar nicht im Typ,** sondern in einer Tabelle am Symbol. *Vorbild:* C++ `constexpr` ist
  bewusst **nicht** Teil des Funktionstyps (über einen Funktionszeiger geht die Information
  verloren), um Overload- und Konversionsexplosion zu vermeiden; Zig markiert für `comptime` gar
  nichts und lässt die Auswertung an den nicht verfügbaren Operationen scheitern.

**Entscheidung: A.** Ein Enum mit drei Werten, mehr braucht der Typ nicht zu tragen.

Begründung gegen die anderen: B hat mit dem Wegfall von `?>` keinen Inhalt mehr. D macht Teil 2 des
Ziels rückgängig — Purity wäre nicht mehr im Typ ablesbar, `typeToString` käme nicht daran, und eine
Callback-Position könnte Purity nie fordern; die Option ist nur ehrlich, wenn man Empfehlung B der
Architekturfrage aufgibt. Sie bleibt als dokumentierter Rückzugsweg stehen, falls die
`typeEquals`-Folgen im Bench teuer werden.

C wäre die Zielform, falls Purity je durchgesetzt wird (4B) oder ein zweiter Effekt dazukommt —
dann führt an Effekt-Polymorphismus in der Signatur kein Weg vorbei. Für diese Ausbaustufe ist sie
gegenstandslos: die einzige Abhängigkeit, die sie hätte ausdrücken sollen, wird ausgerechnet statt
deklariert. Zu beachten, falls sie je verfolgt wird: der Kommentar an
[checker.ts:991-998](../src/checker/checker.ts#L991-L998) hält fest, dass `traversePlaceholders` im
`argumentContext`-Zweig absichtlich nicht in Funktions- und Parameterknoten absteigt und dass das
Nachrüsten die Auflösung generischer Rückgabetypen zerstört hat — eine Purity am Callback-Parameter
verlangt genau diesen Abstieg.

Warnende Gegenproben aus anderen Sprachen, für den Fall, dass Purity später doch in die Signatur
wandert: **Java Checked Exceptions** sind Effekt in der Signatur *ohne* Polymorphismus —
`Stream.map` nimmt bis heute kein werfendes Lambda. **OCaml 5** hat Effect Handlers ausgeliefert und
die Effekttypen bewusst weggelassen, weil die Typsystemkosten zu hoch waren — ein Team, das C hätte
bauen können, hat D gewählt. **Die Sprache D** trägt `pure` als echten Teil des Funktionstyps und
zeigt dessen Preis: Attributexplosion (`pure @safe nothrow @nogc` an jeder Signatur) plus `inout`
als eigener Polymorphismus-Mechanismus.

#### Wo das Feld steht

Drei Orte, und sie tragen **nicht dasselbe**.

1. **Der Enum selbst** in `syntax-tree.ts`, weil sowohl der AST-Knoten als auch der Compile-Time-Typ
   dort liegen:

   ```ts
   /** Der geschriebene Pfeil bzw. die daraus folgende Purity-Aussage. */
   export type Purity =
   	| 'unknown'  // :>
   	| 'pure'     // ->
   	| 'impure';  // ~>
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

   Das Feld heißt am AST `arrow` und nicht `purity`: **AST = was dasteht, CompileTimeType = was
   gilt.** Nach 1B fallen die beiden am `functionLiteral` zwar nicht mehr auseinander — die
   Zusicherung wird eins zu eins übernommen —, aber die Trennung bleibt richtig: `arrow` ist
   optional (es gibt Funktionen ohne jeden Pfeil), `purity` nicht, und sobald die
   Inferenz-Ausbaustufe die Zusicherung gegen den Rumpf prüft, ist der geschriebene Pfeil die eine
   Seite dieses Vergleichs.

3. **Am Typ: die Bedeutung.** `CompileTimeFunctionType.pure`
   ([syntax-tree.ts:928](../src/syntax-tree.ts#L928)) → `purity: Purity`, ebenso der Parameter von
   [`createCompileTimeFunctionType`](../src/syntax-tree.ts#L943). 11 Aufrufstellen, davon vier
   inhaltlich:
   - [checker.ts:2702](../src/checker/checker.ts#L2702) (`functionTypeLiteral`) — liest künftig
     `expression.arrow` statt hart `true`.
   - [checker.ts:2587](../src/checker/checker.ts#L2587) (`functionLiteral`) — heute hart `false`,
     liest nach 1B ebenfalls `expression.arrow`. Ohne Pfeil (und bei `:>`) `'unknown'` statt
     `'impure'`: ehrlicher („nicht bewiesen" statt „bewiesen unrein") und vorwärtskompatibel zur
     Inferenz-Ausbaustufe.
   - [checker.ts:1036](../src/checker/checker.ts#L1036) und
     [checker.ts:1235](../src/checker/checker.ts#L1235) — kopieren die Purity beim Dereferenzieren
     mit. Mit drei einfachen Zuständen ist daran nichts zu entscheiden; das war nur offen, solange
     ein `'conditional'` mitpropagieren konnte.

Und eines **verschwindet**: der `pure`-Parameter von `nativeFunction`
([checker.ts:282](../src/checker/checker.ts#L282)) entfällt ersatzlos, der Wert kommt aus dem
`FunctionType`-Argument. Das war das Argument für Option B der Architekturfrage: nur eine Stelle
kann lügen.

**Nicht betroffen:** der Emitter. Typen werden nicht emittiert, `purity` erreicht ihn nie.

## Der Konsument: Constant Folding

**Voraussetzung für Faltung eines Aufrufs:**

- Die aufgerufene Funktion ist eine core-lib-`nativeFunction` mit `purity === 'pure'`, und die
  Argument-Regel bestätigt das für diese Aufrufstelle (bei skalaren Argumenten trivial, weil keins
  davon eine Funktion ist).
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
zu beantworten — der Typ trägt keinen Herkunftsnamen. Der Anker ist der **Name**, und er trägt:
`builtInSymbols` ist der oberste Scope jeder Nicht-core-lib-Datei
([checker.ts:1510](../src/checker/checker.ts#L1510)), und eine Definition, die einen Builtin-Namen
wiederverwendet, ist bereits `JUL4003 alreadyDefinedInUpperScope`. Ein Builtin lässt sich also nicht
überschreiben; der Symbolname ist zugleich der Runtime-Export-Name.

Dafür gibt es **Präzedenz im selben Codepfad**: `getReturnTypeFromFunctionCall` wertet bereits elf
Builtins zur Compile-Zeit aus (`And`, `Or`, `Not`, `TypeOf`, `ElementAt`, `LengthOf`,
`WithElementAt`, `Range`, `TupleOf`, `Concat`, `Greater`) — über ein `switch` auf den geschriebenen
Namen ([checker.ts:3166 ff.](../src/checker/checker.ts#L3166)). Die Wertfaltung ist dort ein weiterer
Zweig, keine neue Maschinerie.

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

### Welche Builtins: alle mit `->`

Kein eigenes Kriterium neben der Deklaration — was `->` trägt, ist faltbar. Die Auswahl richtet
sich danach, was die Funktion *ist*, nicht danach, wofür man sie gerade brauchen kann.

Die Typkonstruktoren (`List`, `Or`, `And`, `TypeOf`, …) sind davon nicht betroffen: der Checker
behandelt sie bereits gesondert ([checker.ts:235](../src/checker/checker.ts#L235) ff.,
[checker.ts:3166 ff.](../src/checker/checker.ts#L3166)) und liefert Typen statt Werte. Sie brauchen
die Wertfaltung nicht.

### Wert↔Typ-Grenze: Stufe 1 faltet nur skalare Ergebnisse

Die Frage ist nicht, welche Funktionen gefaltet werden (alle mit `->`), sondern **was mit einem
Ergebnis passiert, das kein Skalar ist**. Drei Möglichkeiten standen zur Wahl:

- **A — nur skalare Ergebnisse.** Gefaltet wird, wenn das Ergebnis ein `integerLiteral`,
  `floatLiteral`, `textLiteral` oder `booleanLiteral` wird. Alles andere behält den deklarierten
  Rückgabetyp.
- **B — alles Darstellbare, eifrig.** Zusätzlich Kollektionen aus Literalen (`tuple`,
  `dictionaryLiteral`) und `Fraction` als `[numerator = … denominator = …]`.
- **C — alles Darstellbare, aber nur auf Nachfrage.** Gefaltet wird nur, wo ein Konsument den Wert
  braucht (Typargument einer abhängigen Typfunktion, Prüfung gegen einen Literal-Typguard).

**Entscheidung: A.** Beispiele:

```
addInteger(2 3)              → 5                    gefaltet
combineTexts([§a§ §b§] §-§)  → §a-b§                gefaltet
slice([1 2 3] 2)             → Or([] List(Any))     nicht gefaltet (deklariert)
add(0.5 0.5)                 → Rational             nicht gefaltet (Fraction ist kein Skalar)
parseJson(§{"a":1}§)         → Or(Any Error)        nicht gefaltet
```

Der Grund gegen B ist ein **gemessener Präzedenzfall im selben Checker**: eine Präzisierung, die
statt `Any` die Vereinigung aller Felder eines großen `dictionaryLiteral` lieferte, trieb
parse+check von 3,6 s auf 14,4 s bei praktisch unveränderten Aufrufzahlen — die Zeit steckte fast
vollständig in `typeEquals` aus der Deduplizierung (CHECKER-AUDIT.md, „Fallen im Checker"). Die
Schlussfolgerung dort lautet: „im Zweifel nur dort präzisieren, wo die Feldmenge klein ist." B
erzeugt genau diese Typform, und die Faltung läuft im Language Server bei jedem Tastendruck mit.

Zwei weitere Punkte gegen B in Stufe 1: ein gefaltetes `toList` über ein großes Literal wird zu
einem Tuple-Typ derselben Länge, und `add` kürzt nicht
(`// TODO kleinstes gemeinsames Vielfaches, kürzen`, [runtime.ts:1786](../src/runtime.ts#L1786)) —
`[numerator = 2 denominator = 4]` fröre eine Implementierungs-Unfertigkeit in einen Typ ein.

**Bewusst getragene Ausnahme:** Gefaltet wird nach **Ergebnisform**, nicht nach Purity. `slice`,
`toList`, `toDictionary`, `parseJson`, `getElement` und `flatten` tragen `->` und werden trotzdem
nie gefaltet. Das ist nicht schön, aber es ist der Punkt, an dem eine Messung vorliegt und eine
Vermutung nicht.

B und C sind als Ausbaustufe vermerkt (siehe unten), nicht verworfen.

### Weiterhin zu entscheiden

- **Fehler beim Falten** (`parseFloat`, Division durch 0, geworfene Ausnahme): Vorschlag abfangen,
  nicht falten, keine neue Diagnose. Faltung darf nie selbst Fehlerquelle sein.
- **Granularität und Rücksetzung des Zählers:** pro Ausdruck, pro Datei oder pro Check-Lauf? Der
  Language Server ist ein langlebiger Prozess — ein globaler Zähler blockierte nach einiger Zeit
  dauerhaft.
- **Aufrufkonvention:** welche Argumentformen Stufe 1 faltet. Der Emitter unterscheidet drei Fälle
  ([emitter.ts:200-225](../src/emitter.ts#L200-L225)), dazu kommen `prefixArgument` und
  Rest-Parameter. Achtung: `add` hat einen Rest-Parameter (`rest: { type: List(Rational) }`),
  `add(2 3)` läuft also über den Spread-Pfad — das Standardbeispiel trifft nicht den einfachsten
  Fall.
- **Name→Runtime-Abbildung:** explizite Tabelle statt `runtime[name]` (escapte Namen,
  `_createFunction`-verpackte Exporte, `_parseJson` neben `parseJson`), und was bei einem
  core-lib-Symbol ohne Eintrag geschieht.
- **Hostunabhängigkeit** als zweites Kriterium neben `purity === 'pure'`: `toIsoDateText` und alles
  Datums- und Zahlformatierende hängt an Zeitzone, ICU und Node-Version.
- **Kosten:** Messung vor und nach der Faltung, und eine Schwelle, ab der sie wieder rausfliegt.

**Entschieden — das Ergebnis fließt nur in den Typ, nicht in den Emitter.** Der emittierte Code ruft
die Funktion weiterhin auf; gefaltet wird ausschließlich für die Typpräzision. Damit trägt die
Faltung in dieser Stufe **kein Semantik-Risiko**: weicht sie vom Laufzeitergebnis ab, ist der Typ
ungenau, aber das Programm verhält sich unverändert. Die Emitter-Variante ist als Ausbaustufe
vermerkt (siehe unten).

## Explizit außerhalb dieser Ausbaustufe

- Keine Purity-**Inferenz** aus dem Rumpf einer `functionLiteral`. Der Pfeil am Literal wird nach
  1B übernommen, aber nicht gegen den Rumpf geprüft; ohne Pfeil bleibt der Typ `'unknown'`.
- Keine Faltung von Aufrufen an Nutzerfunktionen.
- Keine Durchsetzung von Purity in der Zuweisbarkeit (Frage 4 = 4A).

Die 10 „TODO pure wenn die args pure sind"-Stellen (`map`, `filter`, `filterMap` u. a.) standen
früher hier und erledigen sich mit der Argument-Regel von selbst: sie bekommen `->`, den Rest macht
die Regel. Kein eigener Mechanismus, keine Fixpunkt-Iteration.

## Was sich beim Entscheiden aufgelöst hat

Schritte 1–10 sind umgesetzt; die Fragen, die davor offen waren, sind hier als Protokoll
festgehalten. Was für die Faltung noch zu entscheiden ist, steht oben unter
„Weiterhin zu entscheiden".

**Kein neuer Fehlercode nötig.** Beide, die hier standen, sind entfallen: der für einen Purity-Pfeil
am `functionLiteral` mit der Entscheidung zu 1B (dort ist er erlaubt), der für einen `?>`-Pfeil ins
Leere mit dem Wegfall von `?>`. Beide Male ist das kein Zufall, sondern die Probe auf die
Entscheidung: ein Fehlercode, der eine Schreibweise verbietet, die später wieder erlaubt sein soll,
wäre ein schlechtes Zeichen gewesen — Nummern werden nie wiederverwendet
([compiler-errors.ts](../src/compiler-errors.ts)).

**Mehrere Funktionsargumente in einem Aufruf.** core-lib durchgesehen: die 17 Callback-Parameter
verteilen sich auf 16 Funktionen, und genau eine hat zwei — `toDictionary` mit `getKey` und
`getValue` ([core-lib.jul:941](../src/core-lib.jul#L941)), die auch das „TODO pure wenn die args
pure sind" trägt. Das UND über alle Funktionsargumente liefert dort das offensichtlich richtige
Ergebnis: rein nur, wenn beide Callbacks rein sind. Alle übrigen (`map`, `filter`, `filterMap`,
`findFirst`, `findLast`, `findLastIndex`, `forEach`, `exists`, `all`, `aggregate`, `subscribe`,
`repeat`, `map$`, `flatMergeMap$`, `flatSwitchMap$`) haben genau einen.

**Entschieden — `typeToString` bei `'unknown'` rendert `:>`.** `:>` und `~>` sind im Typ
unterschieden, aber jede Nutzerfunktion trägt `'unknown'`. `:>` bedeutet genau „keine Aussage", und
`'unknown'` ist genau das; jede andere Darstellung erfände eine Aussage, die der Typ nicht trifft.
Nebeneffekt: die 64 bestehenden `:>`-Testerwartungen bleiben unverändert, und im Hover ändert sich
für Nutzercode nichts.

## Vorgehen

Die Messungen sind eigene Schritte, keine Anhänge — ein „vor und nach Schritt X" ist beim Abarbeiten
nicht mehr messbar.

**Stand: Schritte 1–10 sind umgesetzt** — Pfeile, Purity im Typ, core-lib-Migration, Argument-Regel
(`getCallPurity`), `typeToString`. Offen ist die Faltung ab Schritt 11.

1. `npm run bench -- --save` (Ausgangsmessung).
2. Roter Test: `pure` einer nachweislich unreinen core-lib-Funktion (`currentDate`, `log`). Belegt
   die Fehlbelegung aus dem Stand, bevor irgendetwas daran geändert wird.
3. Parser: `->` und `~>` als weitere Tokens neben `:>` in
   `functionTypeBodyParser`/`returnTypeTokenParser` zulassen; die Pfeil-Art wandert als `arrow`
   durch `functionTypeBody` in `ParseFunctionTypeLiteral` **und** `ParseFunctionLiteral` (siehe
   „Wo das Feld steht"). Reihenfolge der `discriminatedChoiceParser`-Zweige gegen `=>` verifizieren.
   Parser-Tests analog zu den bestehenden `:>`-Tests, je einer pro Pfeil, an Typ **und** Literal.
4. Typdarstellung: `Purity`-Enum in `syntax-tree.ts`, `pure: boolean` → `purity: Purity` an
   `CompileTimeFunctionType` und `createCompileTimeFunctionType`, 11 Aufrufstellen nachziehen.
   `typeEquals` auf wirksame Purity umstellen
   ([checker.ts:4221](../src/checker/checker.ts#L4221)): `'unknown'` und `'impure'` sind für die
   Gleichheit derselbe Wert.
5. Checker: `purity` sowohl beim `functionTypeLiteral` als auch beim `functionLiteral` aus `arrow`
   lesen statt hartzukodieren (ohne Pfeil: `'unknown'`); `nativeFunction`s Signatur auf zwei
   Parameter (`FunctionType`, `js`) reduzieren. Test für die Zusicherung nach 1B: eine Funktion mit
   `->` trägt `'pure'`, ohne Pfeil `'unknown'` — ohne dass der Rumpf geprüft würde.
6. Migration core-lib: alle 81 `nativeFunction`-Aufrufe von `(FunctionType, true/false, js)` auf
   `(FunctionType mit passendem Pfeil, js)` — 49 auf `->`, 31 auf `~>`. Die 17
   Callback-Parameterpositionen bleiben `:>`. Die bestehenden Bool-Werte sind die Vorlage, aber
   ungeprüft — Grenzfälle (`regex`, `parseFloat`, `parseJson`, `assume`, `runJs`) einzeln
   verifizieren: deterministisch und frei von Systemzustand? Die 10 „TODO pure wenn die args pure
   sind"-Stellen bekommen `->`; ihre Bedingung an den Argumenten erledigt Schritt 7.
7. Argument-Regel bei der Auflösung eines Aufrufs: beweisbar rein nur, wenn die aufgerufene Funktion
   `->` trägt **und** jedes Argument, dessen Typ ein Funktionstyp ist, beweisbar rein ist. Tests:
   `map(add ...)` → rein, `map(log ...)` → unrein, `map(myFn ...)` mit `myFn` ohne Pfeil → nicht
   beweisbar rein, `toDictionary` mit einem reinen und einem unreinen Callback → unrein.
8. Mitziehende Artefakte: TextMate-Grammatik ([jul.tmLanguage.yaml](../../vscode-jul-language-service/syntaxes/jul.tmLanguage.yaml),
   die YAML ist die Quelle), `snippets.json`, `handbook.md`, die öffentliche Doku in
   `jul-homepage/docs`, `nativeFunction`-Testfälle in `checker.test.ts`.
9. `typeToString` `case 'function'` ([checker.ts:5741](../src/checker/checker.ts#L5741)) um
   `type.purity` erweitern, damit der Pfeil in Fehlermeldungen und Hover erscheint — `'unknown'`
   rendert als `:>`, die bestehenden Testerwartungen bleiben damit unverändert.
10. `npm run bench -- --save` (trennt die Kosten des Syntaxumbaus von denen der Faltung).
11. Roter Test für die Faltung (`add(2 3)` → Literal `5`).
12. Constant-Folding-Stelle im Checker identifizieren (beim Auflösen eines Funktionsaufrufs, analog
    zu `getReturnTypeFromFunctionCall`) und um den Fall „Builtin + Argument-Regel aus Schritt 7
    sagt rein + alle Argumente literal" ergänzen, inklusive Schritt-Zähler als Guard vor der
    Ausführung.
13. Gegenproben als Tests: nicht-literale Argumente (keine Faltung, unverändertes Verhalten),
    `purity !== 'pure'` (keine Faltung), werfender Aufruf (keine Faltung, keine neue Diagnose),
    benannte Argumente (keine Faltung, solange Stufe 1 nur positional faltet).
14. `npm run bench -- --save` (Abschluss), `npm test`, `npm run typecheck`, ein paar
    `jul-examples`-Projekte neu bauen.

**Schnittmöglichkeit:** Schritt 1–10 sind eine abgeschlossene, testbare Einheit ohne Ausführung von
Code zur Compile-Zeit. Die Faltung (11–14) trägt als einziger Teil Semantik-Risiko und blockiert den
Rest nicht — sie lässt sich als eigene Ausbaustufe mit eigenem Dokument abtrennen.

## Ausblick: gefaltetes Ergebnis auch emittieren

Vorgemerkt: statt den Aufruf zu emittieren, die gefaltete Konstante einsetzen — `addInteger(2 3)`
würde zu `5n` statt zu `addInteger(2n, 3n)`.

**Der Gewinn wäre echt**, weil ihn heute niemand sonst einsammelt: webpack läuft mit
`minimize: false` ([compiler.ts:60](../src/compiler.ts#L60)), und ein JS-Minifier könnte einen
Aufruf in die Runtime ohnehin nicht wegrechnen.

**Drei Dinge müssten vorher geklärt sein**, und alle drei sind der Grund, warum es nicht in Stufe 1
gehört:

- **Ein neuer Kanal vom Checker zum Emitter.** Der Emitter liest heute **kein** `typeInfo` — er
  arbeitet ausschließlich auf dem Parse-Baum. Der gefaltete Wert müsste ihn also erst erreichen,
  entweder über eine Annotation am Knoten oder indem der Emitter anfängt, geprüfte Typen zu lesen.
  Das ist eine Architekturänderung, keine Ergänzung.
- **Hostunabhängigkeit wird von einer Soll- zu einer Muss-Bedingung.** Solange nur der Typ betroffen
  ist, ist eine Abweichung zwischen Faltung und Laufzeit eine Ungenauigkeit. Sobald der Wert
  emittiert wird, ist sie eine Verhaltensänderung — und Zeitzone, ICU-Daten und Node-Version der
  Build-Maschine landen im Programm.
- **Die CLI bricht bei Parse-Fehlern ab, der Language Server nicht.** Gefaltet wird in beiden; nur
  einer emittiert. Es muss festliegen, dass eine Faltung, die im Language Server auf einem
  unvollständigen Baum passiert, nie in emittierten Code gerät.

## Ausblick: Faltung nicht-skalarer Ergebnisse

Stufe 1 faltet nur skalare Ergebnisse (siehe Wert↔Typ-Grenze). Die beiden verworfenen Varianten
bleiben vorgemerkt:

- **Kollektionen und `Fraction` mitfalten (Variante B).** Beseitigt die Ausnahme „pure, aber nie
  gefaltet" für `slice`, `toList`, `toDictionary`, `parseJson`, `getElement`, `flatten`, und die
  abhängigen Typfunktionen (`ElementAt`, `LengthOf`, `WithElementAt`) profitieren am meisten davon.
  Voraussetzung ist eine Messung: der Befund aus CHECKER-AUDIT.md (3,6 s → 14,4 s durch genau diese
  Typform) ist der Grund für die Vertagung, nicht ein grundsätzlicher Einwand. Der natürliche
  Zwischenschritt wäre eine Größenschranke (nur Kollektionen bis n Elemente) — die Schranke ist
  aber willkürlich, solange die Messung aus Stufe 1 fehlt. Vorher zu klären ist außerdem, ob `add`
  kürzt: sonst friert ein gefalteter Bruch `[numerator = 2 denominator = 4]` in einen Typ ein.
- **Bedarfsgesteuerte Faltung (Variante C).** Nur falten, wo ein Konsument den Wert braucht. Löst
  ein Kostenproblem, verlangt aber eine Bedarfsrichtung im Checker, die es heute nicht gibt
  (`inferType` läuft von unten nach oben), und macht die Ausgabe unvorhersehbar: derselbe Ausdruck
  zeigt im Hover mal `5`, mal `Rational`. Nur verfolgen, falls Stufe 1 messbar zu teuer ist.

## Ausblick: Ausbaustufe „Pure Inference"

Vorgemerkt, nicht Teil dieser Ausbaustufe: Purity automatisch aus dem Aufrufgraph ableiten statt nur
manuell an der `nativeFunction`-Grenze zu deklarieren — eine `functionLiteral` wäre dann pure, wenn
alle aufgerufenen Funktionen pure sind und kein Stream gelesen/geschrieben wird (Fixpunkt-Iteration
für Rekursion). Löst die Hartkodierung bei `functionLiteral` aus dem Stand und prüft die
Zusicherungen, die 1B heute ungeprüft übernimmt. Der Schritt-/Aufrufzähler aus dieser Ausbaustufe
wird dort notwendig statt nur vorsorglich, weil dann auch rekursiver Nutzercode zur Compile-Zeit
ausgeführt werden könnte.

Funktionen höherer Ordnung sind dort **kein** eigenes Thema mehr: die Argument-Regel aus dieser
Ausbaustufe gilt unverändert weiter und liefert von selbst bessere Ergebnisse, sobald die Inferenz
die Purity gewöhnlicher Nutzerfunktionen kennt. Sie setzt an keiner Stelle voraus, *warum* ein
Argument rein ist. Ein Purity-Polymorphismus in der Signatur (Koka-artig) wäre erst nötig, wenn
Purity durchgesetzt wird — siehe den Ausblick unten.

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
