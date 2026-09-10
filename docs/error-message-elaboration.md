# Fehlermeldungen: Elaboration und offene Punkte

## Status

Umgesetzt (Details in der Git-Historie bzw. im Code, nicht mehr Teil dieses Dokuments):

- Elaboration mit echten AST-Positionen für Dictionary-Felder (`elaborateDictionaryLiteralError`/
  `elaborateDictionaryFieldError` in checker.ts), inkl. generischem `Dictionary(T)` als Ziel.
- Missing-field-Meldungen zu einer Zeile gesammelt statt einer Zeile je fehlendem Feld, siehe
  [missing-field-message-format.md](missing-field-message-format.md).
- Kopfzeile mit Typnamen (`Can not assign X to Y.`, `getTypeError`s `case 'dictionaryLiteral':`),
  Rollenwort-Präfix an allen drei Push-Stellen (`Definition type mismatch.` /
  `Argument type mismatch.` / `Return type mismatch.`), und `relatedInformation` (zweite Position
  an der Rückgabetyp-Deklaration, `CompilerError` in compiler-errors.ts, genutzt von
  `formatErrors` in compiler.ts und `server.ts`).
- ASCII-Quellcode-Darstellung im CLI-Terminal nach Rust-Vorbild (`formatErrors`/`formatSpanLines`
  in compiler.ts): `-->`-Zeile mit Datei:Zeile:Spalte, `^^^^^`-Marker unter einzeiligen Spans,
  `|`-Klammerung mit Konnektor-Linien bei mehrzeiligen Spans, `relatedInformation` als zweiter
  Frame ohne eigene Positionszeile. Betrifft nur das CLI-Ausgabeformat, nicht das LSP (dort bleibt
  `relatedInformation` ein reines Diagnostic-Feld für den Editor). Tabs in der Quellzeile werden
  für die Anzeige zu 2 Spalten expandiert (`editor.tabSize` der vscode-Extension), sonst laufen
  Marker/Konnektoren bei tab-eingerücktem Code dem Text davon.
- Identische Sub-Meldungen bei fehlenden Tupel-Elementen dedupliziert (`getTupleTypeError2`,
  `new Set(subErrors.map(typeErrorToString))`, analog zum bestehenden `'and'`-Fall in
  `getTypeError`): mehrere fehlende Elemente mit demselben Zieltyp erzeugen dieselbe
  `Can not assign Empty to Integer.`-Zeile nicht mehr mehrfach hintereinander. Derselbe Dedup auch
  im Nachbar-Codepfad Ziel `List(X)` mit Tupel-Literal als Wert (`getTypeError`s
  `case 'list': case 'tuple':`) - Fund: eine `List(GameBoard)` mit mehreren strukturell
  identischen Boards erzeugte denselben mehrzeiligen Fehler mehrfach hintereinander.
- Redundante Zwei-Diagnosen-Elaboration durch eine einzige Diagnose mit rekursiv ermittelter
  Position ersetzt (`findInnermostErrorPosition`/`findInnermostFieldErrorPosition` in checker.ts,
  löst `elaborateDictionaryLiteralError`/`elaborateDictionaryFieldError` komplett ab). Vorher:
  eine Diagnose mit der vollen, verschachtelten Fehlerkette an der äußeren Position, zusätzlich
  eine zweite Diagnose mit dem inneren Teil derselben Kette an einer präziseren Position - bei
  mehrstufiger Verschachtelung (z.B. `GameState → boards → GameBoard → activatableGameCardIds`)
  wiederholte sich derselbe Text über mehrere, sich überlappende Rust-Code-Frames. Jetzt (nach
  TypeScript/Rust/Elm-Vorbild): eine Diagnose, deren Position beim Abstieg durch verschachtelte
  Dictionary-Literale auf die innerste noch vorhandene, tatsächlich falsche Stelle wandert; die
  Nachricht bleibt die volle Kette, aber nur einmal.
- Position zusätzlich zur `-->`-Zeile auch am Ende der ersten Zeile (`formatErrors` in
  compiler.ts): bei mehrzeiligen, verschachtelten Ketten liegen oft 5+ Zeilen zwischen erster
  Zeile und `-->`-Zeile - ohne Wiederholung ließe die erste Zeile allein keinen Rückschluss auf
  die Stelle zu. Bewusste Rückkehr zur Dopplung, die für kurze Meldungen zuvor entfernt worden
  war (Session 2026-09-10). Steht am Zeilenende (nicht davor), damit die Meldung selbst zuerst
  lesbar ist.
- Feldname steht vor statt hinter der Erklärung, die er einleitet, mit einer Einrückung (2
  Leerzeichen, nicht Tabs - generierter Diagnosetext, kein Quellcode, ein Tab-Zeichen rendert je
  nach Terminal/Editor-Tabstop unterschiedlich breit) pro Verschachtelungsebene
  (`getDictionaryFieldError`/`indentLines` in checker.ts, nach TypeScript-Vorbild): vorher hingen
  alle `Invalid value for field X`-Zeilen ans Ende der Kette, in umgekehrter
  Verschachtelungsreihenfolge (innerstes Feld zuerst) - man musste sie im Kopf der richtigen Ebene
  der Typ-Kette zuordnen. Jetzt liest sich die Kette durchgehend außen nach innen, jede Zeile eine
  Ebene tiefer eingerückt als die vorige.
- `typeToString`s eigene Mehrzeilen-Darstellung (Tupel/Dictionary, `bracketedExpressionToString`)
  nutzt jetzt dieselbe Einrückungseinheit wie `indentLines` (2 Leerzeichen statt Tabs) - vorher
  mischten sich Tabs und Leerzeichen, sobald ein mehrzeiliger Typ-Dump in eine bereits
  eingerückte Fehlerkette eingebettet wurde, die Verschachtelung sah dann zufällig aus statt
  konsistent (Fund im echten yugioh-Fehlerbild, Session 2026-09-10). Separate Fix: große
  Dictionaries in Typ-Dumps werden nach 5 Feldern gekürzt mit "(and N more fields)" (`maxFieldsInTypeDump`
  in checker.ts, `dictionaryTypeToString`), um unendlich lange Fehlermeldungen zu vermeiden (z.B.
  eine Fehlzuweisung zu einem 20-Feld-Dictionary druckt jetzt nur noch 9 Zeilen statt 23).
- Echte Position am falschen Tupel-/Listen-**Element** (`findInnermostElementErrorPosition` in
  checker.ts, Analogon zu `findInnermostFieldErrorPosition` für Dictionary-Felder): ein falsches
  Element markierte bisher nur die ganze Definition, jetzt zeigt die Position auf das Element
  selbst und steigt rekursiv weiter ab, falls das Element wieder ein Literal ist. Bricht ab bei
  einem fehlenden Element (kein Ausdruck zum Zeigen) oder einem Spread (Zuordnung nicht
  eindeutig) - dort bleibt die äußere Position wie bisher. Deckt nur den Fall mit Literal ab,
  siehe "Offen" unten für den Fallback ohne Literal.
- Typinferenz-Bug behoben: ein Spread von `Or([] List(X))` (Idiom für eine möglicherweise leere
  Liste) in ein List-Literal wurde als "andere Typen"-Fallback behandelt (ein einzelnes
  `Any`-Element statt `hasListSpread = true`) und machte das Ergebnis fälschlich zu einem Tuple
  fester Länge statt einer `List(X)` (`getSpreadElementTypes` in checker.ts, `case 'list':` in
  `inferType`). Fund im echten yugioh-Fehlerbild: `allGameCardIds` erzeugte einen 7-elementigen
  Tuple-Dump mit lauter identischen `Or(Empty Integer)`-Einträgen statt der erwarteten
  `List(Or(Integer Empty))`. Der Fix schaut bei `Or`-Quelltypen durch die Choices hindurch;
  unterschiedliche Element-Anzahlen zwischen den Choices (z.B. `Empty` = 0 vs. `List(X)` =
  unbestimmt) bedeuten eine unbestimmte Gesamtlänge und damit `hasListSpread = true`.
- `aliasName`-Leck behoben: `typeToString` zeigte bei `depth > 0` den `aliasName` einer
  Dictionary-Definition, um verschachtelte Typen kurz zu halten (`GameBoard` statt voller
  Struktur). `aliasName` wird aber für **jede** Dictionary-Definition gesetzt, auch für normale
  Werte (`getNameFromValue` in checker.ts) - nicht nur für echte Typ-Aliase. Realer yugioh-Fund:
  `Can not assign newGameState to GameState.` / `Can not assign newBoard to GameBoard.` -
  `newGameState`/`newBoard` sind Variablennamen der zugewiesenen Werte, keine Typnamen, wurden
  aber genauso als Alias gedruckt wie `GameBoard`. Fix: `typeToString` bekommt ein
  `suppressAlias`-Flag, das durch die **gesamte** Rekursion gereicht wird (nicht nur an der
  Aufrufstelle) - sonst leckt der Wertname weiterhin eine Ebene tiefer bei verschachtelten
  Feldern (`[board: newBoard]` statt `[board: [a: ...]]`). Gesetzt auf `true` nur für die
  `argumentsType`-Seite in `getTypeError`s `case 'dictionaryLiteral':` - die Zielseite
  (`targetType`, echte Typ-Aliase wie `GameBoard`/`GameState`) zeigt ihren Alias unverändert
  weiter an. 7 bestehende Tests mit dem alten (fehlerhaften) `x`/`newGameState`-Text als
  Erwartung aktualisiert.
- List-Element-Fehler unzusammenhängend mit Nachbar-Choices behoben: `getTypeError`s
  `case 'list':` gab den Element-Fehler bei `list`-gegen-`list` bisher unveraendert durch
  (`return getTypeError(prefixArgumentType, argumentsType.ElementType, targetElementType);`),
  ohne ihn als `Can not assign List(X) to List(Y).` zu umhuellen - anders als der
  `dictionaryLiteral`-Fall. Bei einem `Or`-Ziel (Idiom `Or([] List(X))`, "moeglicherweise leere
  Liste") standen dadurch zwei Fehler ohne erkennbaren Zusammenhang nebeneinander: die Choice
  gegen `Empty` und der rohe Element-Fehler der Choice gegen `List(X)`, ohne Hinweis, dass
  Letzterer "in einer Liste" liegt. Fund im echten yugioh-Fehlerbild: `activatableGameCardIds`
  zeigte `Can not assign List(Or(Integer Empty)) to Empty.` gefolgt von der unverbundenen Zeile
  `Can not assign Empty to Integer.`. Fix: der Element-Fehler wird jetzt analog zum
  `dictionaryLiteral`-Fall in `Can not assign List(X) to List(Y).\n  <eingerueckter
  Element-Fehler>` gepackt - die Kette liest sich seitdem durchgehend zusammenhaengend.- `Or`-Ziel: Best-Match statt Alle-Choices-Dump (TS/Flow-Vorbild, direkte Fortsetzung des
  vorigen Funds - der List-Wrap allein reichte nicht, weil `getTypeError`s `case 'or':` im
  `targetType`-Switch weiterhin **jeden** fehlgeschlagenen Choice als eigene Zeile zeigte,
  auch triviale wie "List ist kein Empty"). TypeScript/Flow zeigen bei einem Union-Ziel den
  vollen Union-Typ im Kopf (`Can not assign X to A | B.`), vertiefen aber nur den strukturell
  naechsten Choice, statt alle einzeln durchzukauen; Flow faellt nur zurueck auf "alle
  Choices zeigen", wenn kein eindeutig naechster Choice existiert. Umgesetzt: `closestIndexes`
  filtert `targetType.ChoiceTypes` auf denselben `julType` wie der Wert - bei genau einem
  Treffer wird nur dessen Fehler vertieft, der volle `Or(...)`-Zieltyp bleibt im Kopf sichtbar
  (`Can not assign List(Or(Integer Empty)) to Or(Empty List(Integer)).\n  <naechster Choice>`);
  bei keinem oder mehreren Treffern bleibt der bisherige Alle-Choices-Dump als Fallback. Vorher/
  nachher am echten yugioh-Fehlerbild:
  ```
  # vorher
  Can not assign List(Or(Integer Empty)) to Empty.
  Can not assign Empty to Integer.
  # nachher
  Can not assign List(Or(Integer Empty)) to Or(Empty List(Integer)).
    Can not assign List(Or(Integer Empty)) to List(Integer).
      Can not assign Empty to Integer.
  ```
  Ausdruecklich keine semantische Erklaerung des Unterschieds ("eine fehlende Liste" vs. "eine
  Liste mit fehlenden Eintraegen") - das leistet auch TypeScript/Flow nicht, waere Freitext-
  Generierung in der Groessenordnung des verworfenen Diff-Modus (s.u.), nur fuer Bedeutung statt
  Struktur.
## Entscheidung gegen Diff-Modus ("expected X but got Y")

Geprüft und verworfen (Session 2026-09-10): ein Umbau aller `Can not assign X to Y.`-Meldungen
auf Elm-Stil `expected Y but got X` wurde diskutiert, mit Bench-Baseline abgesichert und mit
ersten roten Tests vorbereitet, dann aber vor der Umsetzung verworfen. Begründung:

Die beiden eigentlichen Vorteile von Diff-Modus sind durch die oben stehenden, kleineren Fixes
bereits weitgehend abgedeckt:

- **Strukturelles Diffing** (nur abweichende Teile zeigen, nicht ganze Typen nebeneinander) -
  liefert die bestehende Fehlerkette (`Invalid value for field X`, rekursiv bis zur innersten
  tatsächlich falschen Stelle via `findInnermostErrorPosition`) plus die Truncation
  (`maxFieldsInTypeDump`) bereits.
- **Störfaktor entfernt** - das `aliasName`-Leck (Wertname statt Typname) war die
  hauptsächliche Ursache für unklare Meldungen, ist jetzt behoben.

Übrig bliebe nur noch die Wortstellung selbst (`expected X but got Y` vs. `Can not assign Y to
X`) - rein kosmetisch, ohne Informationsgewinn. Der Umbau würde `getTypeError` an vielen
Fundstellen anfassen (mindestens 6, siehe `grep 'Can not assign'` in checker.ts) und riskiert
neue Inkonsistenzen der Art, die das `aliasName`-Leck erst verursacht hat. Aufwand/Nutzen wird
daher als ungünstig bewertet - keine weitere Umsetzung geplant, außer ein neuer konkreter Fund
rechtfertigt es erneut.

## Offen: Meldungslänge bei Tupel-/Listen-Elementen begrenzen

**Dictionary-Typ-Dumps** sind bereits gekürzt (siehe Status oben: `maxFieldsInTypeDump`). Offen
bleibt die Kürzung bei **Tupel-/Listen-Element-Fehlern** (mehrere Elemente mit je einem
Zieltyp-Fehler):

Die Dedup identischer *aufeinanderfolgender* Sub-Meldungen ist umgesetzt (siehe Status oben) und
deckt den häufigsten Fall ab: mehrere Elemente mit gleichem Zieltyp, sowohl bei Tupel- als auch
bei Listen-Zielen. Echte Positionen je Element sind fuer den Fall MIT Literal ebenfalls umgesetzt
(siehe Status oben, `findInnermostElementErrorPosition`). Offen bleibt nur noch der **Fallback
ohne Literal** (z.B. ein Parameter wie `row: Row` ohne eigene Element-Positionen, oder ein
Spread) - dort gibt es weiterhin keinen Ausdruck, auf den man zeigen koennte. Ein reiner Zähler
(`3×`) verschleiert dann, welche Elemente betroffen sind; Indizes in Prosa
(`elements 1, 2, 3`) waeren ein moeglicher Text-Fallback fuer genau diesen Fall - andere Sprachen
(TypeScript, Elm) lösen das nur, WENN ein Literal vorliegt, genau wie jetzt in JUL. Ein vorher
geschriebener roter Test (`duplicate-tuple-element-errors-are-deduplicated`) legte dafür
zunächst ein Format fest, das dieser Erkenntnis nicht mehr standhielt, wurde entfernt und
später mit dem einfacheren Set-Dedup-Format neu geschrieben (keine Ausnahme von "roter Test
bleibt stehen" - der erste Test belegte kein Bugverhalten, sondern eine verfrühte Festlegung
auf ein noch offenes Design).

Andere Compiler begrenzen unterschiedlich (für Tupel-Elemente weiterhin relevant, sobald ein Format feststeht):

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
(`GameCardRow` hat keine Feldnamen) - die 6 Teilmeldungen waren textlich identisch, nur der Index
unterschied sich (jetzt durch Set-Dedup zu 1 Zeile zusammengefasst). Eine reine TS-artige "erste
N, Rest kappen"-Regel könnte hier zufällig ein *abweichendes* 4. Element verschlucken, während
3 *identische* stehen bleiben - deshalb kein Zähler, sondern Textgleichheit als Kriterium.

- Klarheit: weiterhin offen, ob das Ziel echte Positionen je Element (wie TS/Elm, bei Literalen)
  oder ein Text-Fallback (ohne Literal) ist.
- LSP-Performance: potenzieller Nutzen - kappt genau die Art von Diagnose-Payload, die bei tief
  verschachtelten/duplizierten `Or`-Typen unbegrenzt wächst und bei jedem Tastendruck neu an den
  Client geschickt wird.

Noch nicht umgesetzt - vor jeder Umsetzung roter Test zuerst, dann Umsetzung, dann Bench.

## Offener Punkt: Namen in Meldungen konsequent in Anführungszeichen

Umgesetzt (Session 2026-09-10): jede Stelle in `checker.ts`, die einen eingesetzten Namen aus dem
Quelltext des Nutzers in eine Meldung einbaut (Feldname, Referenzname, Parametername, Index),
setzt ihn jetzt in einfache Anführungszeichen - `Invalid value for field 'boards'` statt
`Invalid value for field boards`, `'a' is not defined.` statt `a is not defined.`, ebenso bei
`Missing field(s)`, `Failed to dereference`, `Parameter name mismatch`, `is already defined in
upper scope`, `is not destructured`, `There is no parameter named`. Betraf durchgängig, nicht nur
die eine gemeldete Stelle (s.u.) - sonst zwei Schreibweisen für dieselbe Sache. Typnamen
(`typeToString`-Ergebnisse) bleiben unverändert unquotiert, siehe "Diff-Modus" oben: Typnamen sind
kein einzelnes Wort wie ein Identifier, sondern potenziell mehrzeilige Strukturen - Anführungszeichen
um einen mehrzeiligen Dictionary-Dump wären selbst wieder verwirrend.

Fund, der den Punkt auslöste: `Missing field monsters, expected ...` liest sich zweideutig - klingt,
als könnte das Feld selbst "field" heißen und "monsters" etwas anderes sein, statt klar zu
markieren, dass "monsters" der eingesetzte Name ist. `checker.ts` setzte an **keiner** Stelle
Anführungszeichen um Namen - nach Einheitlichkeit (Prinzip 3) durfte das nicht nur an einer
Stelle behoben werden.

Vergleich mit anderen Compilern - fast alle markieren eingesetzte Namen sichtbar:

- **TypeScript**: einfache Anführungszeichen um jeden eingesetzten Namen, durchgängig -
  `Property 'monsters' is missing in type '...'.`, `Cannot find name 'foo'.`.
- **Rust**: Backticks, ebenso durchgängig - `` missing field `monsters` in initializer of
  `GameBoard` ``, `` cannot find value `foo` in this scope ``.
- **Clang/GCC**: einfache Anführungszeichen - `error: 'foo' was not declared in this scope`.
- **Elm**: Backticks um Bezeichner - `` I cannot find a variable named `foo` `` - bei fehlenden
  Record-Feldern zeigt Elm aber lieber den ganzen Diff in `{ }`-Klammern statt einzelne Namen
  zu zitieren (siehe "Meldungslänge bei Tupel-/Listen-Elementen" oben).
- **Go**: die Ausnahme - zitiert Namen meist gar nicht (`undefined: foo`), verlässt sich auf
  Satzstellung statt auf Markierung.

Mehrheitlich (TS, Rust, Clang, Elm) wird der eingesetzte Name also sichtbar vom Fließtext
abgesetzt - deckt sich mit JULs eigenem Klarheits-Detail "Fehlermeldungen sprechen vom
Quelltext des Nutzers": die Markierung zeigt genau, welches Wort aus dem Quelltext des Nutzers
stammt und welches feste Compiler-Prosa ist. Entscheidung für einfache Anführungszeichen (statt
Backticks): näher an TypeScript, der Implementierungssprache dieses Compilers.

## Geprüft und verworfen: Farbe statt/zusätzlich zu Anführungszeichen

Diskutiert (Session 2026-09-10): Feldnamen bzw. Typnamen farbig hervorheben (Elm-Stil) statt/
zusätzlich zu Anführungszeichen. Verworfen, weil `CompilerError.message` ein einziger String ist,
der sowohl an die CLI (`formatErrors`, darf ANSI-Codes enthalten) als auch an den Language Server
(Diagnostic-Text im Editor, ANSI-Codes wären Müllzeichen) geht. Färbung müsste daher entweder:

- nachträglich per Regex in `formatErrors` in die fertige Message eingefügt werden - fragil bei
  mehrzeiligen Typ-Dumps und Text-Literalen, die zufällig wie Trennwörter aussehen, oder
- die Message-Struktur von `string` auf strukturierte Segmente (`{ text, kind }[]`) umstellen -
  berührt dieselben ~14 Fundstellen in `checker.ts` wie der verworfene Diff-Modus-Umbau (s.o.).

Anführungszeichen dagegen sind einfache Zeichen im selben String, funktionieren identisch in CLI
und LSP, keine Architekturänderung nötig - deshalb umgesetzt, Farbe nicht.

