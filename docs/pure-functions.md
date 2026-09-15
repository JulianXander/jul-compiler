# Pure Functions: erste Ausbaustufe (core-lib-only, ohne Inferenz)

## Stand

`pure` existiert bereits als Feld auf `CompileTimeFunctionType`
([syntax-tree.ts:928](../src/syntax-tree.ts#L928)), wird bei jeder Funktionstyp-Erzeugung gesetzt
([syntax-tree.ts:943](../src/syntax-tree.ts#L943)) und fließt bis in die Typgleichheit ein
(`first.pure === second.pure`, [checker.ts:4083](../src/checker/checker.ts#L4083)). Das Feld hat
aber weder einen Konsumenten noch eine Quelle, die es korrekt belegt: **es ist heute falsch belegt,
nicht nur ungenutzt.**

Die Werte kommen aus genau zwei Hartkodierungen:

1. **`functionTypeLiteral`** — jede hingeschriebene Signatur (`(a: Integer) :> Integer`) erzeugt
   `pure: true` ([checker.ts:2564](../src/checker/checker.ts#L2564)).
2. **`functionLiteral`** — jede Funktion mit Rumpf erzeugt `pure: false`
   ([checker.ts:2449](../src/checker/checker.ts#L2449)), mit TODO „pure, wenn der body pure ist".

`nativeFunction` übergibt seine Signatur als `functionTypeLiteral`. Daraus folgt: **jede**
core-lib-Funktion trägt `pure: true`, auch `log`, `currentDate` und `forEach`. Nachgemessen über
`builtInSymbols`:

```
log: true   currentDate: true   forEach: true   map: true   assume: true
```

Der von Hand gesetzte `pure`-Parameter von `nativeFunction`
([core-lib.jul:1095](../src/core-lib.jul#L1095), deklariert in
[checker.ts:282](../src/checker/checker.ts#L282)) wird **nirgends gelesen** — es gibt keine Stelle
im Checker, die `nativeFunction` namentlich behandelt. Die 80 Bool-Argumente in core-lib (49 `true`,
31 `false`) sind damit reine Notizen, ebenso die 10 Kommentare „TODO pure wenn die args pure sind"
an den Funktionen höherer Ordnung. Als Notizen sind sie brauchbar: sie sind die Vorlage für die
Migration, aber nichts davon ist heute geprüft oder wirksam.

Eine dritte Folge derselben Lücke: `getTypeError`, `case 'function'`
([checker.ts:4820](../src/checker/checker.ts#L4820)) prüft `pure` gar nicht — nur Parameter
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

`typeToString` ([checker.ts:5042](../src/checker.ts#L5042)) rendert `case 'function'` heute als
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
  der erzeugte `functionTypeLiteral`-Knoten ([parser.ts:1122](../src/parser/parser.ts#L1122)) trägt,
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

Vier Fragen, die die Empfehlung offen lässt. Reihenfolge der Beantwortung: 2 → 1 → 4 → 3, weil
Frage 2 den Umfang der beiden folgenden bestimmt.

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
Purity-tragende Schreibweise ist (siehe Frage 2/3): `:>` bleibt an **jeder** Stelle — Literal wie
Typ — „keine Aussage über Purity", überall dieselbe Bedeutung. Die Purity-tragenden Pfeile
(`->`/`~>`/`?>`) bleiben vorerst reserviertes Vokabular für `functionTypeLiteral`-Deklarationen in
core-lib (`nativeFunction`); an einem `functionLiteral` mit Rumpf ergäben sie mangels Inferenz ohnehin
eine ungeprüfte Behauptung. Ob sie später dort erlaubt werden (das wäre dann 1B), ist eine Frage der
Pure-Inference-Ausbaustufe, nicht dieser.

### Frage 2: Welcher Pfeil trägt welche Aussage?

- **2A — `:>` = pure, `~>` = impure.** *Migration:* die 31 als `false` notierten Signaturen **plus
  alle 17 Callback-Parameterpositionen** nach `~>`. Letztere zwingend: eine Position, die einen
  reinen Callback fordert, kann heute von keinem Nutzercode bedient werden (`functionLiteral` ist
  immer impure). Dazu behaupten je nach Frage 1 alle 72 `:>`-Vorkommen in Beispielen und Tests
  ungewollt „pure".
- **2B — `:>` bleibt die unmarkierte Form, `~>` markiert pure.** *Migration:* nur die 49 reinen
  Signaturen. Callback-Positionen, Beispiele, Tests, Grammatik-Regel für `:>` bleiben unberührt.
  *Zu klären:* bedeutet die unmarkierte Form „unrein" oder „keine Aussage"? Zwei Bedeutungen in
  einem Symbol wäre dieselbe Lücke, die dieses Dokument gerade schließen will. Sauber ist
  „unmarkiert = unrein", weil das die schwächere und damit sichere Zusage ist.

**Entscheidung: 2A dem Grundsatz nach, aber mit eigenem Pfeil statt Wiederverwendung von `:>`.**
Der ursprüngliche Einwand gegen 2A — die 17 Callback-Parameterpositionen müssten pauschal auf `~>`,
obwohl kein Nutzercode dort einen pure-Callback liefern kann — entfällt mit dem dritten Pfeil `?>`
(siehe [Bedingte Purity bei Funktionen höherer Ordnung](#bedingte-purity-bei-funktionen-höherer-ordnung-)
unten): Callback-Positionen wie in `map` bekommen `?>` und akzeptieren damit von sich aus sowohl pure
als auch impure Argumente, ohne auf Frage 4 (Subtyping) zu warten.

`:>` selbst wird dabei **nicht** zum pure-Pfeil umgewidmet, sondern bleibt eigenständig „keine
Aussage über Purity" (siehe Entscheidung zu Frage 1). Pure bekommt stattdessen ein neues Symbol,
Platzhalter `->` (siehe Frage 3) — Migrationskosten sind laut Nutzer vernachlässigbar, die Sprache
ist noch in Entwicklung. Damit gilt:

- `:>` — keine Aussage (Status quo, bleibt an allen heutigen Stellen unverändert)
- `->` — pure
- `~>` — impure
- `?>` — abhängig vom Callback-Parameter

Verbleibende Migration: die 31 tatsächlich unreinen Signaturen auf `~>` (bzw. auf `:>`, falls die
[offene Frage zum Mehrwert von `~>`](#frage-3-welches-symbol) gegen ein eigenes Impure-Symbol
entschieden wird), die 17 Callback-Positionen auf `?>`, alle anderen 49 pure-Signaturen auf `->`.
Alle bestehenden `:>`-Vorkommen in Beispielen/Tests (72 Stück), die bislang gar keine Purity-Aussage
trafen, bleiben unverändert `:>` und behaupten damit korrekt weiterhin nichts.

### Bedingte Purity bei Funktionen höherer Ordnung (`?>`)

`map`, `filter`, `forEach` u. a. sind selbst nicht rekursiv — ihre Purity hängt ausschließlich vom
übergebenen Callback ab, ohne dass dafür eine Fixpunkt-Iteration nötig wäre (die braucht erst
rekursiver Nutzercode, siehe Ausblick unten). Weder `:>` noch `~>` passen auf diese Fälle: `:>` an
`map` wäre falsch, sobald `log` als Callback kommt, `~>` verhindert Faltung für `map(add ...)`.
Vorbild ist Swifts `rethrows`: eine Funktion, die nur dann wirft, wenn der übergebene Closure-Parameter
wirft — hier auf pure/impure statt throws/no-throws übertragen.

**Mechanik:** ein dritter Pfeil, Platzhalter `?>` (Glyphe weiterhin offen, siehe Frage 3 — jetzt für
drei statt zwei Symbole zu klären), steht an **zwei** Stellen derselben Deklaration:

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

**Offene Punkte, noch zu klären:**

- Fallback, wenn die Purity des Arguments nicht statisch bekannt ist (Variable, Parameter der
  umschließenden Funktion): impure annehmen — dieselbe „unmarkiert = unrein"-Logik wie in Frage 2.
- Validierungsregel: ein `?>`-Rückgabepfeil ohne mindestens einen `?>`-Parameter ist eine
  bedeutungslose Deklaration — eigener Fehlercode oder stillschweigend impure?
- Kombination bei mehreren `?>`-Parametern in einer Signatur (UND, siehe oben) — Beispiele in
  core-lib mit mehr als einem Callback-Parameter noch nicht durchgesehen.

**Scope-Auswirkung:** Die 10 „TODO pure wenn die args pure sind"-Stellen (`map`, `filter`,
`filterMap` u. a.), bisher unter „Explizit außerhalb dieser Ausbaustufe" gelistet, lassen sich damit
doch in dieser Ausbaustufe lösen — ohne die schwerere Pure-Inference-Maschinerie (Fixpunkt für
Rekursion), die nur für rekursiven Nutzercode gebraucht wird. Vorgehen und Scope-Liste unten sind
entsprechend noch anzupassen (eigener Schritt für `?>` nach Schritt 5, eigene Tests analog Schritt 11).

### Frage 3: Welches Symbol?

Favorisiert: eine harmonische Familie mit dem bereits bestehenden `functionToken` `=>` —
`=>` (Lambda-Rumpf), `->` (pure), `~>` (impure), `?>` (bedingt). Alle vier nach demselben Muster
gebaut: ein einzelnes, sonst unbelegtes Zeichen plus `>`. Das vermeidet, was `:>` heute tut — den
Doppelpunkt wiederzuverwenden, der in JUL bereits eine andere Bedeutung trägt
(`(a: Integer)`, `[a: Integer]`). `:>` bleibt daneben bestehen, aber außerhalb dieser Familie, als
eigenständiges Symbol für „keine Aussage" (siehe Frage 1/2) — kein Widerspruch, weil es keine
Purity-Aussage macht und daher nicht zur Pfeil-Familie gehören muss.

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

**Offen: Mehrwert eines eigenen Impure-Symbols gegenüber „keine Aussage".** Für die Konsumenten
dieser Ausbaustufe (Constant Folding, `?>`-Auflösung) verhalten sich `~>` und `:>` identisch — beide
sind „nicht beweisbar pure", keiner der beiden Algorithmen muss zwischen „bekannt unrein" und
„unklassifiziert" unterscheiden. Der Mehrwert von `~>` ist heute rein vorbereitend/dokumentarisch:

- **Migrationsdisziplin**: zwingt dazu, für die 31 bekannt unreinen Funktionen (`log`, `currentDate`,
  I/O) eine bewusste, positive Aussage zu treffen, statt sie unter „keine Aussage" verschwinden zu
  lassen.
- **Ground Truth für die spätere Pure-Inference-Ausbaustufe**: sie bräuchte einen Unterschied
  zwischen „fixer Sink, nie pure" (`~>`) und „unklassifiziert, bitte prüfen" (`:>`), um gezielt
  ansetzen zu können statt jede core-lib-Funktion neu zu bewerten.
- **Lesbarkeit** für Menschen, die core-lib lesen.

Entscheidung noch offen: vier Symbole jetzt (mit `~>` für die spätere Trennschärfe), oder erstmal nur
drei (`:>`, `->`, `?>`) und `~>` erst einführen, wenn die Pure-Inference-Ausbaustufe die Unterscheidung
tatsächlich braucht.

### Frage 4: Wird Purity Teil der Zuweisbarkeit?

- **4A — Nein (Status quo).** `pure` bleibt Anzeige und Faltungsbedingung. *Kosten:* eine
  Purity-Forderung an einer Callback-Position ist wirkungslos; die `typeEquals`-Inkonsistenz aus
  dem Stand bleibt bestehen.
- **4B — Ja, als Subtyping:** ein reiner Funktionstyp ist Untertyp des unreinen (pure ist überall
  einsetzbar, unrein nicht), in Parameterposition kippt die Richtung mit der bereits vorhandenen
  Kontravarianz ([checker.ts:4820](../src/checker/checker.ts#L4820)). *Kosten:* wirkt sofort auf
  alle Callback-Positionen — tragbar nur zusammen mit 2B.
- **4C — Ja, als Gleichheit.** Bricht sofort (heute ist deklariert ≠ inferiert) und ist zu streng:
  eine reine Funktion muss an einer unreinen Position zulässig sein.

Unabhängig von der Wahl mitzuentscheiden: bleibt `first.pure === second.pure` in `typeEquals`
([checker.ts:4083](../src/checker/checker.ts#L4083)) so stehen? Bei 4A wird die Ungleichheit nach
der Migration seltener, verschwindet aber nicht.

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
Referenzauflösung ([checker.ts:792](../src/checker/checker.ts#L792)): der oberste Scope *ist*
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

- Keine Änderung an den 10 „TODO pure wenn die args pure sind"-Stellen (`map`, `filter`,
  `filterMap` u. a.) — deren Purity hängt vom übergebenen Callback ab, das ist der in der Diskussion
  identifizierte Fall der Funktionen höherer Ordnung (siehe Ausblick).
- Keine Purity-**Inferenz** aus dem Rumpf einer `functionLiteral`. Ob der Pfeil am Literal
  stattdessen als ungeprüfte Zusicherung gelesen wird, entscheidet Frage 1; ohne 1B bleibt es bei
  hartcodiert `false`.
- Keine Faltung von Aufrufen an Nutzerfunktionen, auch nicht an als rein zugesicherten.

## Vorgehen

Die Messungen sind eigene Schritte, keine Anhänge — ein „vor und nach Schritt X" ist beim Abarbeiten
nicht mehr messbar.

1. `npm run bench -- --save` (Ausgangsmessung).
2. Roter Test: `pure` einer nachweislich unreinen core-lib-Funktion (`currentDate`, `log`). Belegt
   die Fehlbelegung aus dem Stand, bevor irgendetwas daran geändert wird.
3. Parser: `~>` als zweiten Token neben `:>` in `functionTypeBodyParser`/`returnTypeTokenParser`
   zulassen, `functionTypeLiteral` um die Pfeil-Art erweitern; Parser-Tests analog zu den
   bestehenden `:>`-Tests.
4. Checker: `pure` beim Auflösen eines `functionTypeLiteral` aus der Pfeil-Art lesen statt
   hartzukodieren; `nativeFunction`s Signatur auf zwei Parameter (`FunctionType`, `js`) reduzieren.
5. Migration core-lib: alle 81 `nativeFunction`-Aufrufe von `(FunctionType, true/false, js)` auf
   `(FunctionType mit passendem Pfeil, js)`. Die bestehenden Bool-Werte sind die Vorlage, aber
   ungeprüft — Grenzfälle (`regex`, `parseFloat`, `parseJson`, `assume`, `runJs`) einzeln
   verifizieren: deterministisch und frei von Systemzustand?
6. Mitziehende Artefakte: TextMate-Grammatik ([jul.tmLanguage.yaml](../../vscode-jul-language-service/syntaxes/jul.tmLanguage.yaml),
   die YAML ist die Quelle), `snippets.json`, `handbook.md`, `nativeFunction`-Testfälle in
   `checker.test.ts`.
7. `typeToString` `case 'function'` um `type.pure` erweitern, damit der Pfeil in Fehlermeldungen und
   Hover erscheint; Testerwartungen anpassen.
8. `npm run bench -- --save` (trennt die Kosten des Syntaxumbaus von denen der Faltung).
9. Roter Test für die Faltung (`add(2 3)` → Literal `5`).
10. Constant-Folding-Stelle im Checker identifizieren (beim Auflösen eines Funktionsaufrufs, analog
    zu `getReturnTypeFromFunctionCall`) und um den Fall „Builtin + `pure` + alle Argumente literal"
    ergänzen, inklusive Schritt-Zähler als Guard vor der Ausführung.
11. Gegenproben als Tests: nicht-literale Argumente (keine Faltung, unverändertes Verhalten), `pure
    === false` (keine Faltung), werfender Aufruf (keine Faltung, keine neue Diagnose).
12. `npm run bench -- --save` (Abschluss), `npm test`, `npm run typecheck`, ein paar
    `jul-examples`-Projekte neu bauen.

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
