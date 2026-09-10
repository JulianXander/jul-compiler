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
  konsistent (Fund im echten yugioh-Fehlerbild, Session 2026-09-10). Behebt nur die Darstellung,
  nicht den unhandlichen Typ-Dump selbst - siehe "Offen" unten.
- Echte Position am falschen Tupel-/Listen-**Element** (`findInnermostElementErrorPosition` in
  checker.ts, Analogon zu `findInnermostFieldErrorPosition` für Dictionary-Felder): ein falsches
  Element markierte bisher nur die ganze Definition, jetzt zeigt die Position auf das Element
  selbst und steigt rekursiv weiter ab, falls das Element wieder ein Literal ist. Bricht ab bei
  einem fehlenden Element (kein Ausdruck zum Zeigen) oder einem Spread (Zuordnung nicht
  eindeutig) - dort bleibt die äußere Position wie bisher. Deckt nur den Fall mit Literal ab,
  siehe "Offen" unten für den Fallback ohne Literal.

## Offen: Meldungslänge bei Tupel-/Listen-Elementen begrenzen

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
  zu zitieren (siehe "Meldungslänge bei Tupel-/Listen-Elementen" oben).
- **Go**: die Ausnahme - zitiert Namen meist gar nicht (`undefined: foo`), verlässt sich auf
  Satzstellung statt auf Markierung.

Mehrheitlich (TS, Rust, Clang, Elm) wird der eingesetzte Name also sichtbar vom Fließtext
abgesetzt - deckt sich mit JULs eigenem Klarheits-Detail "Fehlermeldungen sprechen vom
Quelltext des Nutzers": die Markierung zeigt genau, welches Wort aus dem Quelltext des Nutzers
stammt und welches feste Compiler-Prosa ist. Eigenständige Entscheidung, noch nicht bewertet,
welches Zeichen (Anführungszeichen vs. Backticks) und ob zuerst hier oder in `TODO` als eigener
Punkt geführt wird.

