# Early Return: der Rest des Blocks als Default-Fall

Entschieden für Option E und umgesetzt, Stand 2026-11-04. Verfahren nach
[design-principles.md](../design-principles.md), Abschnitt „Wie eine Entscheidung getroffen wird“.
Was bei der Umsetzung vom Entwurf abweicht und was offen bleibt, steht am Ende unter „Umsetzung“.

## Ist-Zustand

JUL hat kein `return`. Das Ergebnis einer Funktion ist ihr letzter Ausdruck. Eine Vorbedingung
lässt sich nur als Branching schreiben, dessen catchAll-Arm den ganzen Rest der Funktion enthält.
Jede weitere Prüfung rückt alles danach eine Ebene tiefer, genauer gesagt um zwei Tabs: einen für
den Arm, einen für dessen Rumpf.

Ein Branching als Anweisung mitten im Block gibt es heute schon, als bedingten Seiteneffekt,
nach dem es weitergeht (if ohne else). Das Prinzip Freiheit schützt diese Form ausdrücklich.

`arena.jul`, Reducer eines Spiels:

```jul
(accumulator value) =>
	?(accumulator)
		[Error] => accumulator
		() =>
			history = accumulator
			gameState = getCurrentGameState(history)
			?(gameState/winner)
				[Or(1 2 §draw§)] => accumulator
				() =>
					?(gameState/priority)
						[Or(1 2)] =>
							kind = ?(gameState/priority)
								[1] => kind1
								[2] => kind2
							applyChecked(history getAgentInput(kind history gameState/priority))
						() => applyChecked(history [])
```

`game-logic.jul`, die tiefste Stelle in yugioh mit 18 Tabs:

```jul
getBoardLocation = (board: GameBoard gameCardId: GameCardId) :> Or([] CardLocation) =>
	?(board/monsters.elementExists(gameCardId))
		[true] => §monsterZone§
		[false] =>
			?(board/spellTraps.elementExists(gameCardId))
				[true] => §spellTrapZone§
				[false] =>
					?(board/field.equal(gameCardId))
						[true] => §fieldZone§
						[false] =>
							# … sechs weitere Ebenen bis
							[false] => []
```

Der Kommentar über der Funktion hält fest, dass eine flache Tabelle mit `findFirst` lesbarer, aber
5–10 % langsamer war. Die Kaskade ist also eine Performance-Entscheidung, die mit Lesbarkeit
bezahlt wird.

## Randbedingungen

- Alles ist ein Ausdruck. Eine Anweisung ohne Wert (`return`) wäre die erste ihrer Art.
- Branch-Arme sind Funktionen. Jede Regel „verlässt die Funktion“ muss sagen, welche.
- Der Parser ist einrückungsbasiert. Eine neue Bedeutung darf nicht an einer Einrückung hängen,
  die sich durch versehentliches Verschieben still ergibt.

## Optionen

### A: alles bleibt

Es bleibt bei der Verschachtelung. Nach dem Prinzip Editierbarkeit ist das ein Mangel: Eine neue
Vorbedingung erzwingt eine Umformatierung des gesamten Rests.

### B: `return` als Anweisung

Verworfen. Es wäre eine Anweisung ohne Wert in einer Ausdruckssprache. In Callbacks bleibt offen,
ob die innere oder die äußere Funktion verlassen wird (Kotlin und Ruby haben dafür zwei Arten von
Return). Außerdem kann ein `return` tief in einem Arm stehen, ohne dass man es dem Rumpf ansieht
(Klarheit).

### C: Guard-Bindung (`name: Typ = ausdruck else ersatz`)

Wie Swift `guard` und Rust `let-else`. Verworfen zugunsten von E: Sie braucht neue Syntax, eine
Bindung ohne Nutzen, wenn nur geprüft wird (`noWinner: [] = …`), und für die eigentliche
Fallunterscheidung bleibt trotzdem das Branching. Damit gäbe es zwei Konstrukte für dasselbe.

### D: Continuation wie Gleams `use`

Der Rest des Blocks wird zu einem Lambda, das einer gewöhnlichen Funktion übergeben wird. Das passt
zu „keine Magie“, verletzt aber die Klarheit: Dass der Rest zur Funktion wird, steht nirgends.
Außerdem kostet jede Stufe eine Closure. Verworfen.

### E: Branching als Anweisung, der Rest ist der Default

Regeln:

1. **Anweisung:** Ein Branching als Anweisung im Rumpf einer Funktion verlässt die innerste
   Funktion mit dem Wert des Arms, wenn ein Arm passt. Passt keiner, geht es mit der nächsten
   Zeile weiter. Der Rest ist auf das Komplement der Arme verengt, wie heute ein catchAll-Arm.
   Ein catchAll-Arm (`() =>`, `Any =>`, Parameter ohne Typ) ist dort ein Fehler. (Nach der
   Umsetzung gestrichen, siehe „Abweichungen vom Entwurf“.)
2. **Ausdruck:** Steht ein Branching in Ausdrucksposition (Zuweisung, Argument, Listenelement),
   ändert sich nichts. Der catchAll-Arm ist erlaubt, weil es kein „danach“ gibt.
3. **Bedingter Seiteneffekt:** Er wird an `_` zugewiesen (`_ = ?(…)`) und steht damit in
   Ausdrucksposition, siehe Bewertung, Problem 3.
4. **Unerreichbarer Code:** Decken die Arme den Typ des Werts nachweislich ab, ist alles danach ein
   Fehler. Ist das nicht entscheidbar, wird nichts gemeldet (Freiheit). Für Arme hinter einem
   abdeckenden Arm gibt es das schon (`unreachableBranch`), der Rest des Blocks wäre derselbe Fall.
5. **Blockende:** Steht das Branching am Ende, ist der Rest leer. Passt dann kein Arm, ist das
   Ergebnis wie heute `Error`.

Damit gibt es für jede Position genau eine Schreibweise für den Default: in Ausdrucksposition den
catchAll-Arm, als Anweisung den Rest.

```jul
(accumulator value) =>
	?(accumulator)
		[Error] => accumulator
	history = accumulator
	gameState = getCurrentGameState(history)
	?(gameState/winner)
		[Or(1 2 §draw§)] => accumulator
	?(gameState/priority)
		[Or(1 2)] =>
			kind = ?(gameState/priority)
				[1] => kind1
				[2] => kind2
			applyChecked(history getAgentInput(kind history gameState/priority))
	applyChecked(history [])
```

```jul
getBoardLocation = (board: GameBoard gameCardId: GameCardId) :> Or([] CardLocation) =>
	?(board/monsters.elementExists(gameCardId))
		[true] => §monsterZone§
	?(board/spellTraps.elementExists(gameCardId))
		[true] => §spellTrapZone§
	?(board/field.equal(gameCardId))
		[true] => §fieldZone§
	# … sechs gleich gebaute Zeilenpaare
	[]
```

Die Kaskade bleibt eine Kaskade und damit so schnell wie heute, steht aber flach da.

## Auszählung

Per AST mit dem aktuellen Parser über `yugioh/src` und `jul-examples` (80 Dateien; sieben Beispiele
mit absichtlichen oder bekannten Parserfehlern zählen mit, soweit sie parsen):

| | Anzahl |
|---|---|
| Branchings insgesamt | 1163 |
| in Ausdrucksposition (unverändert) | 350 |
| als Anweisung, letzter Ausdruck einer Funktion | 796 |
| als Anweisung mitten im Block (bedingter Seiteneffekt) | 4 |
| als Anweisung auf oberster Dateiebene (nur `jul-examples`) | 13 |
| Anweisung mit catchAll-Arm (Regel 1 greift, inkl. oberster Dateiebene) | 516 |
| davon `() =>` / `Any =>` / benannt | 497 / 17 / 2 |
| davon benannt über einem berechneten Ausdruck | 1 |
| davon einzeiliger catchAll (`() => x`) | 366 |
| Zeilen in mehrzeiligen catchAll-Rümpfen, die zwei Tabs nach links rücken | 2096 |
| Anweisung am Blockende ohne catchAll | 292 |
| davon `[true]`/`[false]`-Paare | 267 (Rumpf des zweiten Arms: 1145 Zeilen) |
| `[true]`/`[false]`-Paare in Ausdrucksposition | 118 |

Die vier Seiteneffekt-Stellen: `yugioh/src/main.jul:302`, `yugioh/src/main.jul:694`,
`jul-examples/fizz-buzz/fizz-buzz-recursive.jul:5`, `jul-examples/ui/tic-tac-toe/tic-tac-toe.jul:59`.

Die maximale Einrückung in yugioh liegt bei 18 Tabs und bleibt bei 18, wenn nur die catchAll-Arme
migriert werden: Die tiefste Stelle ist die `[true]`/`[false]`-Kaskade in `getBoardLocation`.

## Kritische Bewertung

### Was dafür spricht

- **Editierbarkeit:** Eine neue Vorbedingung ist eine Zeile plus Arm und lässt den Rest unberührt.
  Das ist der Kern des Prinzips Pragmatismus/Editierbarkeit, und die Zählung zeigt die Größenordnung:
  2096 Zeilen in catchAll-Rümpfen stehen heute nur deshalb tiefer, weil davor etwas geprüft wurde,
  dazu der Teil der 1145 Zeilen aus `[true]`/`[false]`-Paaren, der in Kaskaden steht.
- **Keine neue Syntax:** Kein Schlüsselwort, kein Operator. Semantisch ist der Entwurf eine
  Umschreibung: `…; ?(x) Arme; Rest` ist `…; ?(x) Arme () => Rest`. Verengung, Typ des Ergebnisses
  und Prüfung gegen den deklarierten Rückgabetyp gibt es also schon.
- **Lexikalisch eindeutig:** Verlassen wird die innerste Funktion, also bei einem Branching in
  einem Arm der Arm, in einem Callback der Callback. Es gibt keine nichtlokalen Returns.
- **Kaskaden ohne Performancepreis:** `getBoardLocation` wird lesbar, ohne auf eine langsamere
  Datenstruktur auszuweichen.

### Probleme, nach Gewicht

1. **Der Ausstieg ist unsichtbar.** `?(x)` mit `[A] => log(x)` mitten im Block liest jeder, der
   eine andere Sprache kennt, als if ohne else, also „danach weiter“. Im Entwurf endet dort die
   Funktion. Die Regel ist statisch und an der Stelle ablesbar (Anweisung oder Ausdruck), verletzt
   die Klarheit also nicht formal. Der Unterschied zwischen „Seiteneffekt, weiter“ und
   „Ergebnis, Ende“ steht immerhin sichtbar am Zeilenanfang: `_ =` davor oder nicht. Das ist
   dieselbe Art von Regel wie „der letzte Ausdruck ist das Ergebnis“, nur mit mehr Folgen.
   Abhilfe wäre ein Hinweis im Language Server (Inlay oder Hover „verlässt die Funktion“), mehr
   nicht. **Das ist der eigentliche Preis des Entwurfs.**

   Das Prinzip Freiheit verletzt der Entwurf nicht: Bedingte Ausführung ohne else bleibt
   schreibbar, nur mit `_ =` davor. Das Beispiel „if ohne else“ in
   [design-principles.md](../design-principles.md) ist nach einer Entscheidung entsprechend
   anzupassen.

2. **Erschöpfende Arme ohne catchAll.** Regel 1 verbietet nur den catchAll-Arm. Am Blockende
   können `?(b) [true] => a [false] => c` und `?(b) [true] => a` mit `c` danach bei einem Boolean
   gleich aussehen. Es sind trotzdem zwei Sachen, deshalb bleiben beide ohne Meldung erlaubt:
   - **Syntax gegen Typ:** Ein catchAll-Arm und der Rest sind immer gleichbedeutend, unabhängig vom
     Typ. Deshalb kann Regel 1 rein syntaktisch verbieten. Erschöpfende Arme und Rest sind nur
     gleich, wenn der Checker den Typ kennt. Bei `Any` matcht `[false] =>` nur `false`, alles
     andere ergibt `Error`, der Rest nimmt dagegen alles auf, was nicht `true` ist.
   - **Robust bei Typänderungen:** Wird der Typ von `Boolean` auf `Or(true false [])` erweitert,
     kommt bei expliziten Armen `Error` in den Ergebnistyp, und der Checker meldet das am
     deklarierten Rückgabetyp. Beim Rest landet der neue Wert still im Default. Für Unions und
     Enums sind erschöpfende Arme deshalb die sicherere Schreibweise.
   - **Absicht:** Gleichrangige Fälle und eine Vorbedingung mit Hauptpfad sagen beim Lesen
     Verschiedenes.
   - **Meldung wäre nichtlokal:** Ein Fehler oder Hinweis hinge am Typ des Werts, der oft woanders
     deklariert ist, und tauchte beim Ändern dieses Typs in entferntem Code auf oder verschwände.

   Der verbleibende Preis: Bei einer Kaskade wie `getBoardLocation` muss der Autor zwischen
   verschachtelt (`[false] =>`) und flach (Rest) wählen. Das ist eine Stilentscheidung. Der
   Language Server kann dafür ein Refactoring „Letzten Arm als Rest schreiben“ anbieten, ohne
   Diagnose. Die Migration formt nicht alle 267 Paare um, sondern nur Kaskaden, also Paare, deren
   letzter Arm wieder mit einem Branching als Anweisung beginnt. Ohne das bliebe die tiefste
   Stelle unverändert.

3. **Bedingter Seiteneffekt braucht eine Form.** Geplant ist `_` als Bindungsziel, das nichts
   bindet. Erwogen wurden:
   - **Zuweisung an einen normalen Namen** (`replayPushed = ?(…)`). Das ist semantisch korrekt,
     aber `reportUnusedInFunctionBodies` meldet den Namen mitten im Block als ungenutzt
     (`unusedDefinition`, Schweregrad Hinweis). Der Hinweis stimmt, wäre aber an jeder solchen
     Stelle Dauerrauschen. Ihn für Branchings auszunehmen, wäre eine Ausnahme in der Regel, und
     die Bindung behauptete einen Wert, den niemand liest.
   - **Eine gewöhnliche Funktion, die ihr Argument verwirft** (`discard(?(…))`). Sie braucht
     keine Ausnahme, kostet aber eine zusätzliche Einrückungsebene und eine Zeile für die
     schließende Klammer, und sie löst nur diesen einen Fall. Verworfen zugunsten von `_`. Beides
     zusammen wären zwei Schreibweisen für denselben Zweck.
   - **`_`:** Es ist heute kein gültiger Name, `nameRegex` im Parser verlangt einen Buchstaben am
     Anfang. `_` ist deshalb kein Sondername mit Ausnahmen, sondern ein eigenes Token mit der
     Bedeutung „hier wird nichts gebunden“. Wo nichts definiert wird, gibt es nichts Ungenutztes
     und nichts doppelt Definiertes, also entfallen beide vermeintlichen Ausnahmen.

   `_` gilt überall, wo gebunden wird:
   - **Definition:** `_ = ?(…)` lässt das Branching auf seiner Einrückung. Aus einem Early Return
     wird ein Seiteneffekt durch ein Präfix (Editierbarkeit). Betroffen sind 4 Stellen.
   - **Destructuring:** `(_ b) = liste` überspringt eine Position. Heute braucht es dafür einen
     Namen, und der wird als ungenutzt gemeldet.
   - **Parameter:** `(_ index) =>` sagt ohne Suchen, dass der erste Wert egal ist. Mehrere `_` in
     einer Liste sind möglich, weil nichts gebunden wird.
   - **Typ-Annotation:** `_: Typ = x` ist erlaubt und prüft wie jede annotierte Definition, ob `x`
     zum Typ passt, statisch und ohne Bindung (wie `satisfies` in TypeScript). Sie zu verbieten,
     wäre die Ausnahme: `_` steht für einen Namen, also überall, wo ein Name stehen kann. Einziger
     Haken: In einem Branch-Arm bedeuten `(_: Integer) =>` und `[Integer] =>` dasselbe, nämlich
     eine Position mit Typ und ohne Namen. Zu entscheiden ist, ob eine Parameterliste nur aus
     typisierten `_` eine zweite Schreibweise des Listenkopfs ist oder ob eine davon gestrichen
     wird. Bei gemischten Listen (`(_: Text index: Integer)`) gibt es keine Alternative.

   Jede Lesestelle von `_` ist ein Fehler. So ist garantiert, dass ein verworfener Wert nirgends
   doch benutzt wird, was ein normaler Name wie `unused` nicht leistet. Der Emitter erzeugt keine
   Variable, aus `_ = x` wird `x;`.

   `_ = …` als letzter Ausdruck eines Rumpfs ist ein Fehler. Nach der Regel „die letzte
   Definition ist das Ergebnis“ würde der Wert dort gerade nicht verworfen, und `_ = x` wäre
   nur eine zweite Schreibweise für `x`.

4. **Emitter: „kein Treffer“ ist heute ein Wert.** Der Pfad über `_branch(…)` liefert bei keinem
   Treffer ein `Error`. Für Regel 1 muss der Emitter „kein Arm passt“ von „der Arm gibt einen
   Error zurück“ unterscheiden, was in yugioh dauernd vorkommt (`[Error] => accumulator`). Das
   braucht einen eigenen Helfer oder einen Sentinel. Über den typisierten Dispatch
   (`branchDispatchToJs`) ist es ein schlichtes `if (…) return …;`. Für die Laufzeit gilt: messen,
   nicht schätzen. Erwartbar ist eher ein Gewinn, weil der Rest keine Closure mehr ist.

5. **Leerer Rest heißt `Error`, voller Rest heißt weiter.** Regel 5 ist ein eigener Satz, den man
   lernen muss. Konsequent ist er trotzdem: Ein Block ohne Ergebnis hat keinen Wert, und das ist
   heute schon `Error`.

6. **Oberste Dateiebene.** Dort gibt es keine Funktion, die man verlassen könnte. Die 13 Stellen
   liegen alle in `jul-examples`. Entschieden: Ein Branching als Anweisung ist dort ein Fehler,
   damit keine Sonderbedeutung entsteht. Ein bedingter Seiteneffekt wird wie im Rumpf als
   `_ = ?(…)` geschrieben.

7. **Arme, die keine Funktionsliterale sind.** Ein Arm kann auch ein Name sein, der auf eine
   Funktion zeigt (2 Stellen). Ob er ein catchAll ist, steht dann nicht in der Syntax. Regel 1
   prüft deshalb nur Literale, der Rest fällt unter Regel 4.

8. **Einrückung trägt mehr Bedeutung.** Rückt man einen Arm versehentlich eine Ebene nach links,
   steht er als Funktionsliteral im Block statt im Branching. Eine Meldung für einen Ausdruck,
   dessen Wert als Anweisung ungenutzt bleibt, gibt es heute nicht (kein Fehlercode dafür). Sie
   gehört zum Entwurf, mindestens für Funktionsliterale.

9. **Callbacks.** In `forEach` oder `reduce` verlässt ein Treffer nur den Callback, wirkt also wie
   `continue`. Das ist konsistent mit der Regel „innerste Funktion“ und, da JUL keine Schleifen
   hat, auch der einzige sinnvolle Fall. Erwähnen sollte die öffentliche Doku es trotzdem.

10. **Typ-Branching `:?`.** Es ist nur als Rückgabetyp erlaubt, steht also immer in
    Ausdrucksposition. Die Regeln betreffen es nicht. Erst wenn `:?` außerhalb des
    Rückgabetyps erlaubt wird (Ausbaustufe in [conditional-types.md](conditional-types.md)),
    kann es als Anweisung im Rumpf stehen. Dazu passt Early Return nur mit der auswählenden
    Semantik (B), die dort ohnehin vor dem Lockern verlangt ist, nicht mit dem Typkonstruktor
    (A), der alle Zweige zu einer Union zusammenfasst. Offen wäre dann nur Regel 5: Ohne Treffer
    liefert `:?` still nichts (`Never`), `?` am Blockende `Error`.

### Urteil

Der Entwurf löst ein reales, häufiges Problem ohne neue Syntax und mit einer Semantik, die sich
als Umschreibung auf das bestehende catchAll zurückführen lässt. Dagegen stehen der unsichtbare
Ausstieg (1) und die Wahl zwischen erschöpfenden Armen und Rest (2). (1) ist der bewusste Preis
und nur durch den Language Server zu mildern. (2) ist eine Stilfrage, entscheidet aber über den
Nutzen bei der tiefsten Verschachtelung: Ohne das Umformen der Kaskaden bleibt sie, wie sie ist.

Empfehlung: E umsetzen, mit
- `_` als Bindungsziel ohne Bindung für den bedingten Seiteneffekt, ebenso nutzbar in
  Destructuring und Parametern, statt einer Funktion `discard` oder einer ungenutzten Bindung,
- erschöpfenden Armen ohne Meldung, dazu ein Refactoring ohne Diagnose im Language Server,
- einem Fehler für Branchings als Anweisung auf oberster Dateiebene (entschieden),
- einem eigenen Emitter-Pfad für „kein Treffer“.

Den Ausschlag geben Pragmatismus/Editierbarkeit gegen die Klarheit, mit dem Argument, dass die
Bedeutung statisch an der Position hängt und nicht am Laufzeitwert.

## Umsetzung

### Wie

- **Der Parser hängt den Rest an.** `createParseFunctionLiteral` prüft die Anweisungen eines Rumpfs
  und macht den Rest hinter dem ersten Branching als Anweisung zu dessen letztem Branch, einem
  parameterlosen Funktionsliteral mit `isRestOfBlock`. Das Branching umfasst danach den Rest, damit
  die Suche nach der Cursorposition im Language Server ihn findet. Die leeren Parameter des Rests
  liegen in Spalte 0 seiner ersten Zeile, außerhalb jedes Rumpfs, sonst fingen sie dort den Cursor
  ab. Checker, Verengung, Rückgabetyp, Emitter und Tail-Call-Optimierung behandeln den Rest damit
  wie einen geschriebenen catchAll und brauchen keinen eigenen Pfad. Problem 4 (Sentinel für „kein
  Treffer“) entfällt: Mitten im Rumpf gibt es durch den Rest immer einen Treffer, am Ende gilt wie
  bisher `Error`.
- **Der Rest ist ein eigener Scope.** Seine Definitionen stehen in der Symboltabelle des
  Rest-Arms. Eine Definition im Rest mit dem Namen einer Definition davor meldet deshalb JUL3203
  statt JUL3200, ein Verweis vor dem Branching auf eine Definition im Rest JUL3201 statt JUL3202.
- **`_`** ist ein Name, den `nameRegex` nur allein annimmt. Definition, Destructuring-Feld und
  Parameter mit diesem Namen landen in keiner Symboltabelle, ein Dictionary-Feld `_` bleibt ein
  Schlüssel. Der Emitter benennt Parameter `_` nach Position (`_0`, `_1`), weil JS doppelte
  Parameternamen ablehnt. Bei der Prüfung von Callback-Signaturen passt `_` zu jedem Namen
  (`(_ index) =>` an `(value index)`).
- **Neue Codes:** JUL3002 (Anweisung auf oberster Ebene), JUL3003
  (ungenutztes Funktionsliteral, Warnung), JUL3205 (`_` gelesen), JUL3206 (`_` als Ergebnis).
- **Language Server:** Der Hover auf dem `?` eines Branchings als Anweisung sagt, dass ein Treffer
  die Funktion beendet. `_` erscheint nicht in der Gliederung.

### Abweichungen vom Entwurf

- **Der catchAll-Arm als Anweisung ist erlaubt.** Das Verbot (Regel 1, zuerst als JUL3001
  umgesetzt) ist gestrichen. Toter Code dahinter ist kein Argument dafür, denselben gibt es hinter
  erschöpfenden Armen, und Regel 4 meldet beide gleich. Eine Schreibweise spart es auch nicht ein:
  Der catchAll bleibt in Ausdrucksposition ohnehin, das Verbot machte daraus nur eine Sonderregel,
  nach der derselbe Arm je nach Position erlaubt ist oder nicht. Ohne sie passt ein catchAll überall
  gleich, und der Rest ist nur das, was gilt, wenn kein Arm passt und noch Code folgt. Die flache
  Schreibweise ist damit ein Angebot, kein Zwang.
- **Regel 4 ist eine Warnung, kein Fehler.** Sie nutzt JUL5152 (`unreachableBranch`) mit eigener
  Meldung, und das ist dort eine Warnung. Ein geschriebener catchAll wird dabei weiterhin nie als
  unerreichbar gemeldet, er darf defensiv dastehen. Für den Rest des Blocks gilt das nicht.
- **`(_: T) =>` neben `[T] =>` bleibt.** Beide sind als Arm-Kopf erlaubt, gestrichen wurde keine.

### Migration

`scripts/migrate-early-return.mjs`, angewandt auf yugioh, `jul-examples`, `scripts/bench-runtime`
und die Snippets der Testdateien: 564 Umformungen in 48 Dateien, darunter 31 Kaskaden aus
`[true]`/`[false]`-Paaren in yugioh. Ein Branching, das nur aus einem catchAll bestand
(`?(x)` mit `Any => x`), entfällt ganz. Die maximale Einrückung in `game-logic.jul` sinkt von 18
auf 13 Tabs.

### Offen

- **Unerreichbarer Rest in yugioh:** Drei Stellen in `game-logic.jul` waren defensive catchAlls
  hinter erschöpfenden Armen und melden jetzt JUL5152. Ob der Code weg kann, ist dort zu
  entscheiden. Soll er defensiv bleiben, geht das wieder als catchAll-Arm.
- **`[true]`/`[false]` auf einem Boolean** gilt in der Abdeckungsrechnung nicht als erschöpfend.
  Ein Rest dahinter wird deshalb nicht als unerreichbar gemeldet.
- **Refactoring „Letzten Arm als Rest schreiben“** im Language Server (Problem 2) fehlt noch.
- **Beispiel „if ohne else“** in `design-principles.md`: Die Aussage bleibt wahr, bedingte
  Ausführung wird jetzt `_ = ?(…)` geschrieben. Ob das Prinzip die Entscheidung als Beleg aufnimmt
  (Editierbarkeit gegen Klarheit), ist offen.
