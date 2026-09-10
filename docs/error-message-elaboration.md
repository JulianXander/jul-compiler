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
  `relatedInformation` ein reines Diagnostic-Feld für den Editor).

## Offen: Meldungslänge bei Tupel-/Listen-Elementen begrenzen

Zurückgestellt: baut auf der noch nicht existierenden Elaboration für Tupel-/Listen-**Literale**
auf (bisher nur für Dictionary-Literale umgesetzt) und ist damit kein unabhängiger erster Schritt.
Grund: ein reiner Zähler (`3×`) verschleiert, welche Elemente betroffen sind; Indizes in Prosa
(`elements 1, 2, 3`) wären nur ein Fallback für den Fall ohne Literal (z.B. ein Parameter wie
`row: Row` ohne eigene Element-Positionen) - andere Sprachen (TypeScript, Elm) lösen das
stattdessen über echte Positionen je Element, wenn ein Literal vorliegt. Bevor hier ein Format
festgelegt wird, muss also erst geklärt sein, ob/wie die Elaboration auf Tupel-/Listen-Literale
ausgeweitet wird - ein vorher geschriebener roter Test
(`duplicate-tuple-element-errors-are-deduplicated`) legte ein Format fest, das dieser Erkenntnis
nicht mehr standhielt, und wurde deshalb wieder entfernt (keine Ausnahme von "roter Test bleibt
stehen" - der Test belegte kein Bugverhalten, sondern eine verfrühte Festlegung auf ein noch
offenes Design).

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

