# Mehrzeiliger Funktionskopf

Ziel: Pfeile und Rückgabetyp eines Funktionskopfs dürfen auf eigenen, eingerückten Zeilen stehen.
Das ist der TODO-Punkt „multiline returntype parser“. Auslöser ist `jul-examples/test1.jul`:

```jul
myAdd = (
	a: Rational
	b: Rational
)
	->
		SumType(TypeOf(a) TypeOf(b))
	=>
		add(a b)
```

Voraussetzung ist das auch für [conditional-types.md](conditional-types.md): Dort steht als offener
Nachweis, dass ein mehrzeiliger Ausdruck im Rückgabetyp sauber endet. Einen eingerückten Block an
dieser Stelle gibt es noch nicht.

## Ist-Zustand

Stand des gebauten Compilers, geprüft mit `cli.js … --check`:

| Form | Ergebnis |
|---|---|
| `(a: Integer) -> Integer => a` | ok |
| Parameterliste mehrzeilig, dann `) :> T =>` und Rumpf eingerückt | ok (yugioh: 73 Stellen) |
| Rückgabetyp mehrzeilig innerhalb von Klammern: `:> [` … `] =>` bzw. `:> Or(` … `) =>` | ok, auch JUL5100 zeigt den mehrzeiligen Typ richtig an |
| Pfeil am Zeilenende, Typ eingerückt darunter (`test1.jul:11`) | JUL1102 + JUL1050 |
| Pfeile auf eigener Zeile (`test1.jul:29-36`) | JUL1050 in jeder Folgezeile |
| `-> :?(…)` mit eingerückten Zweigen (`test1.jul:23`, Zielbild von `:?`) | JUL1050 |

Ursachen in [parser.ts](../src/parser/parser.ts):

- Die Tokens `' -> '`, `' :> '`, `' ~> '` und `' =>'` verlangen das Leerzeichen davor in derselben
  Zeile. Nach `)` am Zeilenende erkennt `valueExpressionBaseParser` deshalb keinen Funktionskopf.
  Die Klammer gilt als fertiger Ausdruck und die eingerückten Folgezeilen passen nirgends hin.
- `functionTypeBodyParser` parst nach dem Pfeil nur eine `simpleExpression`, und zwar direkt ohne
  Zeilenumbruch. Branching (`?(…)`, künftig `:?(…)`) ist keine `simpleExpression` und scheidet
  als Rückgabetyp schon inline aus.
- Die Meldungen nennen Parser-Namen (`Expected one of: roundBracketedBaseParser,…`). Das verstößt
  gegen Klarheit, Abschnitt Fehlermeldungen in [design-principles.md](design-principles.md).

Vorbild im Bestand: Der Rumpf hat schon zwei Layouts, `=> x` inline oder `=>` am Zeilenende mit
eingerücktem Block (`functionBodyParser`). Branching parst seine Zweige als eingerückten Block
(`newLineParser` + `incrementIndent(multilineParser(…))`).

## Randbedingungen

1. **Warum der Rückgabetyp eine `simpleExpression` ist:** Inline wäre bei einer `valueExpression`
   nicht entscheidbar, wem das folgende `=>` gehört. `(a) -> (b) => c` könnte den Rückgabetyp
   `(b) => c` haben. Ein eingerückter Block endet dagegen an der Einrückung, dort ist das
   Problem weg.
2. Der Parser ist zeilen- und einrückungsbasiert. Der Kopf endet heute dort, wo `)` steht, und die
   Folgezeile wird von der umgebenden Liste (Datei, Block, mehrzeilige Klammer) geparst. Die neue
   Form muss vorausschauen: Steht in der nächsten Zeile eine Ebene tiefer ein Pfeil?
3. Die Parser tolerieren unvollständige Ausdrücke für den Language Server. Ein halb getippter Kopf
   (`)` + Zeile `->` ohne Typ) muss einen Teilbaum mit Fehler liefern und darf nicht den Rest der
   Datei verlieren.
4. Kollisionsfreiheit: Eine Zeile, die tiefer eingerückt ist als der vorige Ausdruck, ist heute
   überall ein Fehler (Datei, Rumpf, Klammerliste). Sie mit Bedeutung zu belegen, macht kein
   gültiges Programm ungültig.

## Optionen

Alle am selben Beispiel. Rumpf und Typ sind absichtlich kurz, damit das Layout sichtbar bleibt.

**O0 – alles bleibt.** Mehrzeilig nur über Klammern:

```jul
myAdd = (
	a: Rational
	b: Rational
) -> SumType(TypeOf(a) TypeOf(b)) =>
	add(a b)
```

Reicht für Dictionary-Typen und Typfunktionen. Branching bzw. `:?` im Rückgabetyp ist damit nicht
möglich. Dadurch hängt `:?` fest.

**O1 – Pfeil am Zeilenende, Operand als Block** (analog zu `=>` beim Rumpf):

```jul
myAdd = (a: Rational b: Rational) ->
		SumType(TypeOf(a) TypeOf(b))
	=>
		add(a b)
```

Für den Typ passt das zum Rumpf-Layout. Wohin aber das `=>` gehört, ist unklar: Ans Ende der
Typzeile geht nicht, weil der Block an der Einrückung endet. Auf eine eigene Zeile gestellt, ergibt
das eine Mischform aus O1 und O2.

**O2 – Pfeil beginnt eine Folgezeile eine Ebene tiefer, Operand inline oder als Block darunter.**

```jul
# Operand inline
myAdd = (
	a: Rational
	b: Rational
)
	-> SumType(TypeOf(a) TypeOf(b))
	=> add(a b)

# Operand als Block (Form aus test1.jul)
myAdd = (
	a: Rational
	b: Rational
)
	->
		SumType(TypeOf(a) TypeOf(b))
	=>
		add(a b)

# :? im Rückgabetyp, reiner Typ ohne Rumpf
subtract = nativeFunction(
	(minuend: Rational subtrahend: Rational)
		->
			:?(TypeOf(minuend) TypeOf(subtrahend))
				[Integer Integer] => Integer
				() => Fraction
	§js … §
)
```

Jede Kopfzeile beginnt mit ihrem Pfeil, also ist der Aufbau lesbar, ohne Zeilenenden abzusuchen.
Das `=>` hat eine feste Stelle. Die Operand-Regel ist dieselbe wie heute beim Rumpf (inline oder
am Zeilenende mit eingerücktem Block) und gilt dann auch für den Typ. Kosten: eine Ebene mehr
Einrückung für den Rumpf.

**Empfehlung: O2.** Ausschlaggebend ist Einheitlichkeit: *eine* Regel für alle Pfeile (umbrechen
vor dem Pfeil, Operand inline oder als Block), statt einer Sonderstellung für `=>`. O1 bleibt
verworfen, weil es für `=>` keine eigene Stelle hat. Die Umstellung auf O2 bricht nichts, die
heutige einzeilige Form bleibt gültig, beide stehen nebeneinander (siehe Entschieden).

## Umsetzung (für O2)

### 1. Parser: Kopf-Fortsetzung

In `valueExpressionBaseParser` kommt neben den heutigen Zweigen „`=>` in derselben Zeile“ und
„Rückgabepfeil in derselben Zeile“ ein dritter hinzu. Das Prädikat dafür: Die aktuelle Zeile ist zu
Ende, und die unmittelbar nächste Zeile beginnt auf `indent + 1` mit `->`, `:>`, `~>` oder `=>`.
Gibt es diese Zeile nicht, bleibt es bei der `simpleExpression` wie heute. Kommentarzeilen auf
`indent + 1` überspringt das Prädikat dabei, eine Leerzeile direkt hinter dem Kopf beendet ihn.

Neuer `functionHeadContinuationParser`, auf `indent + 1`:

- optional eine Zeile Rückgabepfeil + Typ,
- optional eine Zeile `=>` + Rumpf,
- mindestens eine der beiden. Fehlt `=>`, ist es ein Funktionstyp-Literal.

Zwischen der Rückgabepfeil-Zeile samt Typblock und der `=>`-Zeile dürfen Leer- und
Kommentarzeilen stehen. Leerzeilen am Ende des Typblocks nimmt `multilineParser` ohnehin mit.
Kommentarzeilen auf Ebene der Pfeilzeilen muss der Parser ausdrücklich überspringen.

Für die Mischform (Rückgabetyp in der Kopfzeile, nur `=>` umgebrochen) braucht es dieselbe
Prüfung noch einmal in `functionTypeBodyParser`: Endet die Zeile nach dem Rückgabetyp und beginnt
die unmittelbar nächste Zeile auf `indent + 1` mit `=>`, wird sie als Rumpf gelesen. Beide Stellen
teilen sich das Prädikat und den Parser für die `=>`-Zeile.

Er liefert dieselbe Struktur wie `functionTypeBodyParser` (`arrow`, `returnTypeBase`, `body?`),
damit der bestehende `switch (parsed2.type)` samt `createParseFunctionLiteral` und
`functionTypeLiteral` unverändert bleibt. Am AST ändert sich nichts, Checker, Emitter und Language
Server sehen denselben Knoten mit anderen Positionen.

### 2. Parser: Operand hinter dem Pfeil

Gemeinsame Hilfsfunktion für Typ und Rumpf:

- Inline: ` ` + Ausdruck. Für den Typ bleibt es bei `simpleExpression` (Randbedingung 1), für den
  Rumpf bei `valueExpression` wie heute.
- Block: Zeilenende, dann `moveToNextLine(incrementIndent(expressionBlockParser))`, für Rumpf
  und Typ gleich. Damit sind im Typblock auch Branching und `:?` zulässig, und Kommentar- und
  Leerzeilen gehen wie im Rumpf. Für den Typ wird das Ergebnis danach geprüft: Jede Definition
  meldet JUL2103. Der letzte Ausdruck wird zum `returnType`, am AST ändert sich also nichts.
  Davorstehende Ausdrücke werden ohne Meldung verworfen, wie im Rumpf. Da sie nicht im AST
  landen, haben sie bis zur Ausbaustufe auch keinen Hover. Die Definitionen werden bewusst
  geparst und erst dann abgelehnt, statt nur einen einzelnen Ausdruck zu parsen: Das liefert eine gezielte Meldung statt JUL1050,
  der Rest der Datei geht nicht verloren, und die Ausbaustufe unten muss den Parser nicht mehr
  anfassen.

`functionBodyParser` wird darauf umgestellt, damit Rumpf und Typ denselben Code benutzen.

### 3. Fehlermeldungen

Eigene Meldungen statt der Sammelmeldung, auf Quelltext-Ebene formuliert.

Bestand (`src/compiler-errors.ts`, Layout-Block 11xx): `expectedStartOfLine` (1100),
`expectedEndOfLine` (1101), `unparsedRestOfRow` (1102), `spaceIndentation` (1103),
`windowsLineEnding` (1104), dazu `expectedExpression` (1152) und
`definitionNotAllowedForValueExpression` (2103). Einen Code für „Zeile auf falscher Ebene“ gibt es
nicht: Eine zu tief eingerückte Zeile meldet heute JUL1050 mit Parser-Namen, auch außerhalb von
Funktionsköpfen (`x = 1` + zwei Tabs tiefer `y = 2`, zu tiefe Zeile im Rumpf).

| Fall | Code |
|---|---|
| Pfeil in eigener Pfeilzeile ohne Operand (`\t->`, darunter nichts tiefer Eingerücktes) | bestehend: 1152 `expectedExpression` |
| Definition im Typblock (bis zur Ausbaustufe) | bestehend: 2103 `definitionNotAllowedForValueExpression` |
| Pfeilzeile zwei oder mehr Ebenen tiefer als der Kopf | neu: 1105 `unexpectedIndentation` |
| Pfeilzeile ohne Kopf: auf gleicher Ebene wie der Kopf, nach einer Leerzeile direkt hinter dem Kopf, oder nach einem nicht eingerückten Kommentar | neu: 1106 `misplacedArrow` |
| `=>`-Zeile vor der Rückgabepfeil-Zeile | neu: 1106 `misplacedArrow` |
| Nach umgebrochenem Rückgabepfeil folgt `=>` in derselben Zeile (`-> T =>`) | neu: 1106 `misplacedArrow` |
| Branching als Rückgabetyp inline (`-> ?(…)` bzw. `-> :?(…)`) | neu: 1107 `returnTypeRequiresBlock` |
| Funktionstyp als Rückgabetyp inline (`:> (b: Integer) :> Integer`) | neu: 1107 `returnTypeRequiresBlock`, ersetzt die heutige JUL2105 + JUL1102 |
| Rückgabepfeil am Ende der Kopfzeile (O1, `(a: Integer) ->` + Zeilenende), egal was darunter steht | neu: 1106 `misplacedArrow` |
| Zweite Rückgabepfeil-Zeile oder zweite `=>`-Zeile, auch nach Rückgabetyp in der Kopfzeile | neu: 1106 `misplacedArrow` |

**Wo verwaiste Pfeilzeilen erkannt werden.** Eine Pfeilzeile, die zu keinem Kopf gehört (nach
Leerzeile, nach Kommentar in Spalte 0, auf Ebene des Kopfs, zwei Ebenen zu tief), wird nicht vom
Funktionskopf gesehen, sondern von dem Block, in dem sie steht. Erkannt wird sie deshalb in
`multilineParser` bzw. am Anfang von `expressionParser`: Steht nach der Blockeinrückung, mit
höchstens einem zusätzlichen Tab, einer der Pfeile `->`, `:>`, `~>` oder `=>`, gibt es 1106. Bei
zwei oder mehr zusätzlichen Tabs vor dem Pfeil gibt es 1105. Gültige Programme enthalten solche
Zeilen nie, die Prüfung ändert also nur Meldungen, die heute JUL1050 sind. Die Zeile wird danach übersprungen, statt sie
als Ausdruck zu parsen, damit JUL1050 nicht zusätzlich erscheint.

**Weiterparsen nach einem Fehler.** Die Testfälle verlangen die vollständige Fehlerliste, also
keine Folgefehler. Deshalb:

- O1 (U1, U2): Der Rest wird gelesen, als stünde der Pfeil schon in der nächsten Zeile. Ein
  eingerückter Typblock darunter wird also normal übernommen.
- `-> T =>` nach Umbruch (U3): Rumpf und Typ werden übernommen, nur die Stelle wird gemeldet.
- Branching oder Funktionstyp inline (U4–U8): Der Ausdruck wird trotzdem als Rückgabetyp
  übernommen. Nicht über `valueExpressionParser`, der würde bei `(a) -> Integer => a` das
  `Integer => a` als Rückgabetyp verschlucken (Randbedingung 1). Stattdessen gezielt: Steht hinter
  dem Pfeil `?` oder `:?`, wird mit `branchingParser` gelesen. Ist die gelesene `simpleExpression`
  eine runde Klammer und folgt in derselben Zeile ein Rückgabepfeil, wird der Rest als
  Funktionstyp gelesen (`functionTypeBodyParser` ohne Rumpf). In beiden Fällen kommt 1107, der
  Knoten entsteht aber vollständig.
- Doppelte Pfeilzeilen (U13–U15, U21): gemeldet und übersprungen, der Knoten besteht aus dem, was
  davor gültig war.

`unexpectedIndentation` ist allgemein gemeint und kann später die JUL1050 bei jeder zu tief
eingerückten Zeile ersetzen. Das ändert aber Meldungen außerhalb dieses Umbaus und damit die
Checker-Snapshot-Baseline, gehört also in einen eigenen Schritt. Hier wird es nur für Pfeilzeilen
verwendet. `misplacedArrow` bekommt je Fall eine eigene Meldung. Alle drei neuen Codes kommen
auf die Homepage-Fehlerseite (`jul-homepage/docs/docs/documentation/error-codes.md`).

Vorab zu beheben (Schritt 1 der Reihenfolge): `g = (a: Integer) =>` ohne Rumpf läuft vor einer
weiteren Definition oder mit nur einem Kommentar darunter fehlerfrei durch. Am Dateiende kommen
JUL2100 und JUL1102 (mit Parser-Namen), die Definition verliert dabei ihren Wert. Beim
Rückgabepfeil (`:>` am Zeilenende) kommt JUL1102. Der fehlende Rumpf muss JUL1152 melden, sonst
kann der Test für „Pfeil ohne Operand“ nicht rot werden, ohne dass zwei Ursachen vermischt sind.

### 4. Language Server

Kein Codeumbau erwartet. Zu prüfen sind Hover auf Parameter im Typblock (`TypeOf(a)`),
SignatureHelp und DocumentSymbol für die neue Form sowie das Verhalten beim Tippen
(Randbedingung 3). Die TextMate-Grammatik hat keine Regeln für Pfeile, dort ist nichts zu tun.

### Reihenfolge und Tests

1. **Bugfix: `=>` ohne Rumpf meldet JUL1152** (siehe „3. Fehlermeldungen“). Eigenständig und vor
   allem anderen, damit die späteren Tests für „Pfeil ohne Operand“ nur eine Ursache haben.
   1. `npm run bench -- --save --note "vor mehrzeiligem Funktionskopf"` (Compiler und LSP). Die
      Messung deckt Bugfix und Umbau gemeinsam ab, beide ändern den Parser.
   2. Rote Tests B1–B4 aus dem Testkatalog unten. Anhalten und den roten Zustand zeigen.
   3. Fix: Ursache zuerst klären, es sind zwei. Vor einer weiteren Definition liefert
      `multilineParser` für den Block einen Erfolg mit leerer Liste, weil schon die erste Zeile
      nicht tief genug eingerückt ist. Am Dateiende schlägt `checkEndOfCode` in
      `expressionBlockParser` an. Der ganze Funktionskopf scheitert daran, beim Nutzer kommen
      nur JUL2100 und JUL1102 an. Beide Fälle landen
      in einer Prüfung im Block-Zweig von `functionBodyParser`: Enthält der Block keinen Ausdruck
      (auch nicht, wenn nur Kommentare oder Leerzeilen darin stehen), wird JUL1152 gemeldet. Der
      Knoten entsteht trotzdem, mit leerem Rumpf, damit der Language Server weiterarbeitet.
   4. `npm test`, `npm run typecheck`. Ändert sich die Checker-Snapshot-Baseline, die Änderung
      ansehen.
2. Rote Tests G1–G30, U1–U21 und C1–C3 aus dem Testkatalog. Anhalten und den roten Zustand
   zeigen. Alle Fälle sollten rot sein. Ist einer schon grün, ist er anzusehen, bevor es
   weitergeht: Dann prüft er entweder nichts oder das Verhalten gibt es schon.
3. Parser (Umsetzung 1 und 2), dann Fehlermeldungen (3). Zwischendurch den Testkatalog laufen
   lassen: zuerst die G-Fälle grün, dann die U-Fälle.
4. `npm test`, `npm run typecheck`, `npm run test-update-snapshot`, die Baseline-Änderungen
   durchsehen (es sollte keine geben). `npm run build-all`, im LSP `test-snapshot`, dann Hover
   von Hand in `test1.jul`.
5. `test1.jul:11` und `test1.jul:23` auf die Block-Form umschreiben. Danach checken
   `test1.jul:11-16` und `test1.jul:29-36` ohne Syntaxfehler. `test1.jul:23-27` meldet weiter
   einen Fehler, bis es `:?` gibt ([conditional-types.md](conditional-types.md)), aber nicht mehr
   am Layout. yugioh checkt unverändert (kein Migrationsbedarf, die Änderung ist
   additiv).
6. Handbuch: Abschnitt zu Rückgabetypen (`handbook.md` bei `myAdd`) um die mehrzeilige Form
   ergänzen, nur Verhalten und Beispiel.
7. TODO: „multiline returntype parser“ streichen. In [conditional-types.md](conditional-types.md)
   den offenen Nachweis unter „3. Parser“ und das Zielbild auf das Layout aus O2 umstellen.
8. `bench --save --note "nach mehrzeiligem Funktionskopf"`.

## Testkatalog

Jede erlaubte und jede verbotene Variante bekommt einen Testfall. `\t` steht im Code für einen
Tab, Zeilen sind 0-basiert.

### Aufbau

In `src/parser/parser.test.ts` kommt ein eigener `describe('Mehrzeiliger Funktionskopf')` mit
eigener Tabelle. Die bestehende Tabelle vergleicht vollständige Fehlerobjekte samt Meldungstext
und ganze ASTs mit Positionen. Für rund 50 Fälle wäre das unlesbar, und der Meldungstext steht
erst bei der Umsetzung fest. Deshalb:

```ts
const multilineHeadCases: {
	name: string;
	code: string;
	/** Gültiger Fall: gleiche AST-Struktur wie diese Form, Positionen und parent ausgenommen. */
	equivalentTo?: string;
	/** Zusätzliche Prüfung am ersten Ausdruck, für Fälle ohne einzeilige Entsprechung. */
	check?: (expression: ParseExpression) => void;
	/** Ungültiger Fall: erwartete Fehler, nur Code und Zeile. */
	errors?: { code: ErrorCode; row: number; }[];
	/** Anzahl der Ausdrücke auf oberster Ebene, belegt, dass der Rest der Datei nicht verloren geht. */
	expressionCount?: number;
}[]
```

- Gültige Fälle: `errors` fehlt, erwartet wird eine leere Fehlerliste.
- `equivalentTo`: Beide Codes werden geparst, dann werden `startRowIndex`, `startColumnIndex`,
  `endRowIndex`, `endColumnIndex` und `parent` rekursiv entfernt (Hilfsfunktion
  `stripPositions` im Test), danach `deep.equal`. Das belegt, dass die mehrzeilige Form genau
  denselben Knoten ergibt wie die einzeilige, samt `arrow`, `returnType` und Symboltabelle.
- Ungültige Fälle: `errors` wird gegen `code` und `startRowIndex` der gemeldeten Fehler
  verglichen, in dieser Reihenfolge. Zusätzlich gilt für jede Meldung, dass sie keinen
  Parser-Namen enthält (`/Parser/` darf nicht vorkommen), siehe Klarheit in den
  Designprinzipien.

### B – Bugfix `=>` ohne Rumpf (Schritt 1)

| ID | Code | Erwartung |
|---|---|---|
| B1 | `g = (a: Integer) =>` | 1152 in Zeile 0 |
| B2 | `g = (a: Integer) =>\nx = 1` | 1152 in Zeile 0, `expressionCount` 2 |
| B3 | `g = (a: Integer) =>\n\t# nur Kommentar\nx = 1` | 1152 in Zeile 0, `expressionCount` 2 |
| B4 | `g = (a: Integer) =>\n\ta` | fehlerfrei (Regression) |

### G – gültig

Einzeilige Entsprechung steht in der letzten Spalte (`equivalentTo`), sonst eine `check`-Prüfung.

**Rückgabepfeil umgebrochen (O2)**

| ID | Code | Entspricht bzw. Prüfung |
|---|---|---|
| G1 | `f = (a: Integer)\n\t-> Integer\n\t=> a` | `f = (a: Integer) -> Integer => a` |
| G2 | `f = (a: Integer)\n\t-> Integer\n\t=>\n\t\tb = a\n\t\tb` | `f = (a: Integer) -> Integer =>\n\tb = a\n\tb` |
| G3 | `f = (a: Integer)\n\t->\n\t\tInteger\n\t=> a` | wie G1 |
| G4 | `f = (a: Integer)\n\t->\n\t\tInteger\n\t=>\n\t\tb = a\n\t\tb` | wie G2 |
| G5 | `f = (\n\ta: Integer\n\tb: Integer\n)\n\t->\n\t\tInteger\n\t=>\n\t\tadd(a b)` (Form aus test1) | `f = (\n\ta: Integer\n\tb: Integer\n) -> Integer =>\n\tadd(a b)` |
| G6 | `f = (a: Integer)\n\t:> Integer\n\t=> a` | `f = (a: Integer) :> Integer => a` |
| G7 | `f = (a: Integer)\n\t~> Integer\n\t=> a` | `f = (a: Integer) ~> Integer => a` |

**Ohne Rumpf (Funktionstyp)**

| ID | Code | Entspricht bzw. Prüfung |
|---|---|---|
| G8 | `F = (a: Integer)\n\t-> Integer` | `F = (a: Integer) -> Integer` |
| G9 | `F = (a: Integer)\n\t->\n\t\tInteger` | wie G8 |

**Typen, die den Block brauchen**

| ID | Code | Entspricht bzw. Prüfung |
|---|---|---|
| G10 | `f = (a: Integer)\n\t->\n\t\t?(a)\n\t\t\t[Integer] => Integer\n\t\t\t() => Text\n\t=> a` | `returnType.type === 'branching'`, 2 Zweige |
| G11 | `F = (a: Integer)\n\t:>\n\t\t(b: Integer) :> Integer` | `functionTypeLiteral`, dessen `returnType.type === 'functionTypeLiteral'` |
| G12 | `F = (a: Integer)\n\t->\n\t\tText\n\t\tInteger` (mehrere Ausdrücke, der letzte gilt) | `F = (a: Integer) -> Integer` |

**Typ-Parameter als Kopf**

| ID | Code | Entspricht bzw. Prüfung |
|---|---|---|
| G13 | `f = [Integer]\n\t-> Integer\n\t=> 1` | `f = [Integer] -> Integer => 1` |
| G14 | `x = ?(1)\n\t[Integer]\n\t\t-> Integer\n\t\t=> 1` | `x = ?(1)\n\t[Integer] -> Integer => 1` |

**Umbruch ohne Rückgabetyp (V3)**

| ID | Code | Entspricht bzw. Prüfung |
|---|---|---|
| G15 | `f = (a: Integer)\n\t=> a` | `f = (a: Integer) => a` |
| G16 | `f = (a: Integer)\n\t=>\n\t\tb = a\n\t\tb` | `f = (a: Integer) =>\n\tb = a\n\tb` |
| G17 | `f = (\n\ta: Integer\n)\n\t=> a` | `f = (\n\ta: Integer\n) => a` |

**Mischform (Rückgabetyp in der Kopfzeile, nur `=>` umgebrochen)**

| ID | Code | Entspricht bzw. Prüfung |
|---|---|---|
| G18 | `f = (a: Integer) -> Integer\n\t=> a` | wie G1 |
| G19 | `f = (a: Integer) -> Integer\n\t=>\n\t\tb = a\n\t\tb` | wie G2 |

**Kommentare und Leerzeilen**

| ID | Code | Entspricht bzw. Prüfung |
|---|---|---|
| G20 | `f = (a: Integer)\n\t->\n\t\t# Typ\n\t\tInteger\n\t=> a` | fehlerfrei, `returnType` ist die Referenz `Integer` (der Kommentar hängt als Beschreibung daran, deshalb kein `equivalentTo`) |
| G21 | `f = (a: Integer)\n\t->\n\n\t\tInteger\n\t=> a` | wie G1 |
| G22 | `f = (a: Integer)\n\t-> Integer\n\t=>\n\t\tb = a\n\n\t\t# Ergebnis\n\t\tb` | fehlerfrei |
| G23 | `f = (a: Integer)\n\t->\n\t\tInteger\n\n\t=> a` (Leerzeile zwischen Typblock und `=>`) | wie G1 |
| G24 | `f = (a: Integer)\n\t->\n\t\tInteger\n\t# Rumpf\n\t=> a` | wie G1 |
| G25 | `f = (a: Integer)\n\t# Rückgabetyp\n\t-> Integer\n\t=> a` | wie G1 |
| G26 | `f = (a: Integer)\n\t# -> Integer\n\t=> a` (Rückgabetyp auskommentiert) | `f = (a: Integer) => a` |
| G27 | `f = (a: Integer)\n\t# ->\n\t# \tInteger\n\t=> a` (Typblock auskommentiert) | `f = (a: Integer) => a` |

**Einbettung (Einrückung relativ zur Zeile, in der der Kopf beginnt)**

| ID | Code | Entspricht bzw. Prüfung |
|---|---|---|
| G28 | `x = map(\n\tvalues\n\t(v: Integer)\n\t\t-> Integer\n\t\t=> v\n)` | `x = map(\n\tvalues\n\t(v: Integer) -> Integer => v\n)` |
| G29 | `g = () =>\n\tf = (a: Integer)\n\t\t-> Integer\n\t\t=> a\n\tf` | `g = () =>\n\tf = (a: Integer) -> Integer => a\n\tf` |

**In Kauf genommen**

| ID | Code | Entspricht bzw. Prüfung |
|---|---|---|
| G30 | `x = foo\n\t=> 1` | `x = foo => 1` (dokumentiert, dass eine eingerückte `=>`-Zeile zum Funktionskopf wird) |

### U – ungültig

| ID | Code | Fehler (Code, Zeile) | Fall |
|---|---|---|---|
| U1 | `f = (a: Integer) ->\n\t\tInteger\n\t=> a` | 1106, 0 | O1 |
| U2 | `F = (a: Integer) ->` | 1106, 0 | O1 ohne etwas darunter |
| U3 | `f = (a: Integer)\n\t-> Integer => a` | 1106, 1 | `=>` nach umgebrochenem Rückgabepfeil in derselben Zeile |
| U4 | `f = (a: Integer) -> ?(a)\n\t[Integer] => Integer` | 1107, 0 | Branching in der Kopfzeile |
| U5 | `f = (a: Integer)\n\t-> ?(a)\n\t\t[Integer] => Integer\n\t=> a` | 1107, 1 | Branching inline in der Pfeilzeile |
| U6 | `f = (a: Integer) -> :?(a)\n\t[Integer] => Integer` | 1107, 0 | `:?` in der Kopfzeile (Token wird dafür schon erkannt) |
| U7 | `F = (a: Integer) :> (b: Integer) :> Integer` | 1107, 0 (und kein 2105/1102 mehr) | Funktionstyp in der Kopfzeile |
| U8 | `F = (a: Integer)\n\t:> (b: Integer) :> Integer` | 1107, 1 | Funktionstyp inline in der Pfeilzeile |
| U9 | `f = (a: Integer)\n\n\t=> a` | 1106, 2 | Leerzeile zwischen Kopf und Pfeilzeile |
| U10 | `f = (a: Integer)\n#\t-> Integer\n\t=> a` | 1106, 2 | Kommentar in Spalte 0 beendet den Kopf |
| U11 | `f = (a: Integer)\n=> a` | 1106, 1 | Pfeilzeile auf Ebene des Kopfs |
| U12 | `f = (a: Integer)\n\t\t=> a` | 1105, 1 | Pfeilzeile zwei Ebenen zu tief |
| U13 | `f = (a: Integer)\n\t=> a\n\t-> Integer` | 1106, 2 | `=>` vor dem Rückgabepfeil |
| U14 | `f = (a: Integer)\n\t-> Integer\n\t-> Text\n\t=> a` | 1106, 2 | zwei Rückgabepfeile |
| U15 | `f = (a: Integer)\n\t=> a\n\t=> a` | 1106, 2 | zwei `=>` |
| U16 | `f = (a: Integer)\n\t->\n\t=> a` | 1152, 1 | Rückgabepfeil ohne Operand |
| U17 | `f = (a: Integer)\n\t-> Integer\n\t=>` | 1152, 2 | `=>` ohne Operand |
| U18 | `f = (a: Integer)\n\t->\n\t\tA = Integer\n\t\tA\n\t=> a\ng = 1` | 2103, 2; `expressionCount` 2 | Definition im Typblock, Rest der Datei bleibt |
| U19 | `f = (a: Integer)\n\t->` | 1152, 1; `check`: Knoten `functionTypeLiteral` existiert | halb getippt, Toleranz für den Language Server |
| U20 | `f = (a: Integer)\n\t=>` | 1152, 1; `check`: Knoten `functionLiteral` mit leerem Rumpf | halb getippt ohne Rückgabetyp |
| U21 | `f = (a: Integer) -> Integer\n\t-> Text\n\t=> a` | 1106, 1 | Rückgabepfeil nach Rückgabetyp in der Kopfzeile |

### C – Checker (`src/checker/checker.test.ts`)

| ID | Code | Erwartung |
|---|---|---|
| C1 | `f = (a: Integer)\n\t->\n\t\tText\n\t=> a` | JUL5100 `returnTypeMismatch`, Position des Rumpfs |
| C2 | `f = (a: Integer)\n\t->\n\t\tTypeOf(a)\n\t=> a` | fehlerfrei, `TypeOf(a)` löst den Parameter auf |
| C3 | `F = (a: Integer)\n\t:>\n\t\t(b: Integer) :> Integer\nf: F = (a: Integer) => (b: Integer) => b` | fehlerfrei, Funktionstyp als Rückgabetyp wird geprüft |

### Language Server

Kein eigener Unit-Test, `server.ts` ist nur über den Snapshot abgedeckt. `test-snapshot` muss
unverändert grün bleiben. Von Hand in `test1.jul` nach dem Umschreiben: Hover auf `a` in
`TypeOf(a)` im Typblock, Hover auf `myAdd`, Go-to-Definition von `a` im Typblock, und beim Tippen
von G1 Zeile für Zeile keine Fehler außerhalb der Funktion.

## Ausbaustufe: Definitionen im Typblock

Nicht Teil dieses Umbaus, danach additiv nachrüstbar:

```jul
myAdd = (a: Rational b: Rational)
	->
		A = TypeOf(a)
		B = TypeOf(b)
		Or(And(Integer And(A B)) And(Fraction Or(A B)))
	=>
		add(a b)
```

Die Prinzipien sprechen dafür: Werte und Typen leben im selben Namensraum, und der Rumpf-Block
erlaubt Definitionen auch (Einheitlichkeit, Freiheit). Zurückgestellt wird es nur wegen des
Umfangs, und weil es noch keinen realen Fall gibt. Heute schreibt man einen benannten Hilfstyp
nach außen (`SumType`).

Was dafür zu tun ist, der Parser gehört nicht dazu (siehe „2. Parser: Operand hinter dem Pfeil“):

- AST: `returnType` wird vom einzelnen Ausdruck zum Block mit eigener Symboltabelle, analog zum
  Rumpf. Die JUL2103-Prüfung für den Typblock entfällt.
- Checker: Der Typblock bekommt einen eigenen Scope unterhalb des Parameter-Scopes. Sein letzter
  Ausdruck ist der Rückgabetyp.
- Language Server: Hover, Definition, Rename und DocumentSymbol müssen den neuen Scope kennen.
- Emitter: nichts, Rückgabetypen werden nicht ausgegeben.
- Tests: Definition im Typblock, Zugriff auf Parameter, Namenskonflikt mit Parametern
  (`alreadyDefinedInUpperScope`), Hover auf die lokale Definition.

## Entschieden

- **In der Kopfzeile hinter dem Pfeil nur `simpleExpression`:** Branching (`?`, `:?`) und
  Funktionstypen als Rückgabetyp stehen immer als Block unter dem Pfeil. In der Kopfzeile wäre
  sonst nicht erkennbar, ob eine `=>`-Zeile auf Ebene der Zweige ein weiterer Zweig ist oder der
  Rumpf, und bei einem Funktionstyp nicht, wem das `=>` gehört (Randbedingung 1). Das Zielbild in
  [conditional-types.md](conditional-types.md) wechselt deshalb auf die Block-Form:

  ```jul
  subtract = nativeFunction(
  	(minuend: Rational subtrahend: Rational)
  		->
  			:?(TypeOf(minuend) TypeOf(subtrahend))
  				[Integer Integer] => Integer
  				() => Fraction
  	§js … §
  )
  ```

  Nebenbei wird damit eine Funktion als Rückgabetyp überhaupt erst schreibbar. Heute meldet
  `F = (a: Integer) :> (b: Integer) :> Integer` JUL2105 und JUL1102. Künftig geht:

  ```jul
  F = (a: Integer)
  	:>
  		(b: Integer) :> Integer
  ```

  Dafür kommt ein Fall in die roten Tests.

- **Nicht nur nach runden Klammern:** Der Umbruch gilt nach jeder Parameterangabe, also auch nach
  Typ-Parametern wie in Branching-Zweigen (`[Integer Integer]` + Zeile `-> Integer`). Das kostet
  nichts: `valueExpressionBaseParser` parst zuerst eine beliebige `simpleExpression`, erst
  `bracketedParamsToParams` unterscheidet, und die Fortsetzungsprüfung sitzt davor. Eine
  Beschränkung bräuchte eine zusätzliche Abfrage `type === 'binding'`, also einen Sonderfall. Die
  Bedeutung ist dieselbe wie bei der einzeiligen Form (`[Integer] => x`), und Kollisionen gibt es
  nicht (Randbedingung 4). In den roten Tests steht dafür mindestens ein Fall mit
  `[Integer]`-Kopf.

- **Nur O2, O1 ist ungültig:** Ein Rückgabepfeil am Ende der Kopfzeile mit dem Typ darunter
  (`(a: Rational b: Rational) ->` + eingerückter Typ) ist keine zweite Schreibweise. Beide Formen
  sagen dasselbe, und O1 hat keinen eigenen Platz für ein folgendes `=>`. Gemeldet wird es mit
  JUL1106 `misplacedArrow` und dem Hinweis, den Pfeil an den Anfang der nächsten Zeile zu setzen.
  `test1.jul:11` wird auf O2 umgeschrieben.

- **Typblock:** Im ersten Schritt keine Definitionen, eine Definition meldet JUL2103.
  Definitionen kommen als Ausbaustufe (siehe oben). Geparst wird der Typblock trotzdem schon jetzt
  als voller Block.
- **Mehrere Ausdrücke im Typblock sind kein Fehler:** Wie im Rumpf gilt der letzte Ausdruck, die
  davor verschwinden ohne Meldung. Ob verpuffte Ausdrücke gemeldet werden, gilt für Rumpf und
  Typblock gleichermaßen und steht als eigener Punkt in [TODO](../TODO).

- **Einzeilige und mehrzeilige Form nebeneinander:** beide erlaubt. Die einzeilige Form
  wegzulassen hieße, 70 Köpfe mit Rückgabetyp in yugioh umzuschreiben, ohne Gewinn. Es ist dieselbe Regel
  „Operand inline oder als Block“, die der Rumpf schon hat, nur eine Ebene höher angewandt.
- **Umbruch ohne Rückgabetyp erlaubt:** `(a: Integer)` + Zeile `=> a` bzw. `=>` + Block ist
  gültig. Grund ist die Editierbarkeit: Wer aus

  ```jul
  f = (a: Integer)
  	-> Integer
  	=> a
  ```

  die Rückgabetypzeile löscht, soll gültigen Code behalten, ohne die `=>`-Zeile umformatieren
  zu müssen. Dasselbe gilt für die Mischform unten, wenn man ` -> T` aus der Kopfzeile löscht.
  Die Alternative (eigene `=>`-Zeile nur nach einer Rückgabepfeil-Zeile) hätte je Fall genau eine
  Schreibweise gehabt und wurde deshalb erwogen, verworfen wegen dieses Umformatierens.
  In Kauf genommen: Eine versehentlich eingerückte `=>`-Zeile unter einem beliebigen Ausdruck
  (`x = foo` + Zeile `=> 1`) wird still zu dessen Funktionskopf statt zum Fehler, genau wie die
  einzeilige Form `x = foo => 1`.
- **Jede Pfeilzeile hat ihren Operanden inline oder als Block:** auch der Rückgabepfeil. Gültig
  sind also

  ```jul
  myAdd = (a: Rational b: Rational)
  	-> SumType(TypeOf(a) TypeOf(b))
  	=> add(a b)

  myAdd = (a: Rational b: Rational)
  	-> SumType(TypeOf(a) TypeOf(b))
  	=>
  		c = add(a b)
  		c
  ```

  Inline gilt dabei weiter nur `simpleExpression` (siehe oben), Branching und Funktionstypen
  brauchen den Block.
- **Kommentare und Leerzeilen:** im Typblock und im Rumpf erlaubt, und ebenso zwischen den
  Pfeilzeilen, also zwischen Typblock und `=>`-Zeile.

  Zwischen Kopf und erster Pfeilzeile sind Kommentarzeilen auf Ebene der Pfeilzeilen erlaubt,
  damit sich die Rückgabetypzeile auskommentieren lässt, ohne dass ein Fehler entsteht (gleicher
  Grund wie beim Umbruch ohne Rückgabetyp):

  ```jul
  f = (a: Integer)
  	# -> Integer
  	=> a

  f = (a: Integer)
  	# ->
  	# 	Integer
  	=> a
  ```

  Das `#` muss dabei auf Ebene der Pfeilzeilen eingerückt sein. Ein Kommentar in Spalte 0
  (`#` + Tab + `-> Integer`) beendet den Kopf wie jede andere weniger eingerückte Zeile, die
  folgende `=>`-Zeile steht dann verwaist (`misplacedArrow`).

  Eine Leerzeile an dieser Stelle bleibt verboten. Sonst würde jede eingerückte `=>`-Zeile nach
  einer Leerzeile zum Kopf des Ausdrucks darüber, und man sähe nicht mehr, wozu sie gehört. Die
  Pfeilzeile steht dann verwaist (`misplacedArrow`). Ein Kommentar zeigt dagegen sichtbar an,
  dass hier etwas stand.
- **Mitten in einer Zeile:** Ein mehrzeiliges Funktionsliteral muss als Argument schon heute in
  einer neuen Zeile beginnen, und das bleibt so. Die Einrückung der Pfeilzeilen bezieht sich damit
  immer auf die Zeile, in der der Kopf beginnt (`indent` des Ausdrucks).
- **Mischformen:** Bricht der Rückgabepfeil um, bricht auch `=>` um. `)` + Zeile `-> T =>` ist
  ein Fehler (`misplacedArrow`). Umgekehrt ist erlaubt, den Rückgabetyp in der Kopfzeile zu lassen
  und nur `=>` umzubrechen, mit Rumpf inline oder als Block:

  ```jul
  myAdd = (a: Rational b: Rational) -> SumType(TypeOf(a) TypeOf(b))
  	=> add(a b)
  ```

  Es ist dieselbe Umbruchstelle vor `=>` wie beim Umbruch ohne Rückgabetyp. Die Regel lautet
  damit: Vor jedem Pfeil darf umgebrochen werden, ab dem ersten Umbruch beginnt jeder folgende
  Pfeil eine eigene Zeile eine Ebene tiefer, und sein Operand steht inline oder als Block. Der
  Pfeil am Zeilenende (O1) bleibt verboten.
- **Fehlercodes:** wie in der Tabelle unter „3. Fehlermeldungen“. Neu kommen JUL1105
  `unexpectedIndentation`, JUL1106 `misplacedArrow` und JUL1107 `returnTypeRequiresBlock` hinzu,
  sonst wird JUL1152 wiederverwendet. JUL1107 erkennt Branching an `?`/`:?` direkt hinter dem
  Pfeil und einen Funktionstyp daran, dass der Rückgabetyp eine runde Klammer ist und in derselben
  Zeile ein weiterer Rückgabepfeil folgt. `unexpectedIndentation` gilt zunächst nur für
  Pfeilzeilen, die allgemeine Verwendung ist ein eigener Schritt.

## Offene Fragen

Keine. Ob verpuffte Ausdrücke in Blöcken gemeldet werden, steht als eigener Punkt in
[TODO](../TODO).
