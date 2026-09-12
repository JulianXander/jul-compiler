# Pure Functions: erste Ausbaustufe (core-lib-only, ohne Inferenz)

## Stand

`pure` existiert bereits als Feld auf `CompileTimeFunctionType`
([syntax-tree.ts:898](../src/syntax-tree.ts#L898)), wird bei jeder Funktionstyp-Erzeugung gesetzt
([syntax-tree.ts:916](../src/syntax-tree.ts#L916)) und fließt bis in die Typgleichheit ein
(`first.pure === second.pure`, [checker.ts:3761](../src/checker.ts#L3761)). Die Infrastruktur ist
also da — es gibt aber noch **keinen Konsumenten**, der das Feld für irgendeine Entscheidung nutzt.

Die Werte kommen aktuell aus drei Quellen:

1. **`nativeFunction`-Deklarationen in core-lib.jul**: `pure` ist dort der zweite Positionsparameter
   ([checker.ts:187](../src/checker.ts#L187), Typ `Boolean`) und bereits von Hand gesetzt — z. B.
   `true` bei `add`/`And`/`Or`/`TypeOf` (arithmetik- und Typkonstruktor-Builtins), `false` bei
   `log`/`require` (echte Seiteneffekte). Das ist bereits korrekt und ausreichend für diese
   Ausbaustufe.
2. **Funktionen höherer Ordnung** (`map`, `filter`, `filterMap`, u. a., [core-lib.jul:562](../src/core-lib.jul#L562) ff.):
   hartcodiert `false`, mit TODO-Kommentar `# TODO pure wenn die args pure sind`
   ([core-lib.jul:570](../src/core-lib.jul#L570) u. a., 9 Fundstellen). Das ist konservativ korrekt
   (Purity hängt vom übergebenen Callback ab, siehe unten), bleibt in dieser Ausbaustufe unverändert.
3. **`functionLiteral`** (jede von Nutzern geschriebene Funktion, `(a) => ...`): hartcodiert `false`
   ([checker.ts:2282](../src/checker.ts#L2282)), mit TODO `# TODO pure, wenn der body pure ist`.
   Bleibt in dieser Ausbaustufe ebenfalls unverändert.

## Ziel dieser Ausbaustufe

Nur **direkte, manuell deklarierte** Purity auf core-lib-`nativeFunction`s nutzbar machen — keine
Inferenz über Nutzercode, keine Ableitung durch höhere Ordnung. Zwei Teile:

1. **Sichtbarkeit**: `pure` im Typ ablesbar machen (aktuell unsichtbar, siehe Architekturfrage unten).
2. **Ein erster Konsument**: Constant Folding — ein Aufruf einer als `pure` deklarierten
   `nativeFunction` mit ausschließlich literalen/statisch bekannten Argumenten wird zur Compile-Zeit
   mit der echten `§js§`-Implementierung ausgewertet, das Ergebnis fließt als präziserer
   (Literal-)Typ in den Checker zurück.

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
  [parser.ts:246](../src/parser.ts#L246), [parser.ts:1522](../src/parser.ts#L1522)), der erzeugte
  `functionTypeLiteral`-Knoten ([parser.ts:982](../src/parser.ts#L982)) trägt, welcher Pfeil
  geschrieben wurde. `nativeFunction`s `FunctionType`-Parameter *ist* bereits ein `functionTypeLiteral`
  (dieselbe Syntax, mit der auch Callback-Parametertypen wie in `map` deklariert werden) — der
  Checker liest `pure` direkt daraus, der separate Bool-Parameter
  ([checker.ts:188](../src/checker.ts#L188)) entfällt, `nativeFunction` schrumpft von drei auf zwei
  Parameter (`FunctionType: Type`, `js: Text`).
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

## Der Konsument: Constant Folding

**Voraussetzung für Faltung eines Aufrufs:**

- Die aufgerufene Funktion ist eine core-lib-`nativeFunction` mit `pure === true`.
- Alle Argumente sind zur Compile-Zeit als Literal/konstanter Wert bekannt (analog zu den bereits
  vorhandenen `integerLiteral`/`floatLiteral`/`textLiteral`/`booleanLiteral`-Typen im Checker).
- Kein Aufruf über eine Zwischenvariable, die selbst nicht mehr eindeutig auf die native Deklaration
  zeigt (gleiche Einschränkung wie beim bereits bekannten `lastElement`-Alias-Fund in
  [core-lib-empty-return-types.md](core-lib-empty-return-types.md#ergebnis-lastelement) — dort ging
  es um einen Namens-Sonderfall im Checker, hier greift die reguläre Typauflösung ohnehin über den
  aufgelösten `functionRef`, betrifft also nur die Erkennung „ist das derselbe native Aufruf").

**Durchführung:** Die im `§js§`-Block hinterlegte echte Implementierung wird mit den (in
JS-Werte übersetzten) Literal-Argumenten ausgeführt — kein Nachbau der Semantik im Checker, sondern
derselbe Code, der auch zur Laufzeit läuft. Das Ergebnis wird zurück in einen `CompileTimeType`
(Literal-Typ) übersetzt.

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

## Explizit außerhalb dieser Ausbaustufe

- Keine Änderung an den 9 „TODO pure wenn die args pure sind"-Stellen (`map`, `filter`, `filterMap`
  u. a.) — deren Purity hängt vom übergebenen Callback ab, das ist der in der Diskussion
  identifizierte Fall der Funktionen höherer Ordnung (siehe Ausblick).
- Kein `pure`-Wert für `functionLiteral` — bleibt hartcodiert `false`.
- Keine Syntax, mit der Nutzer selbst `pure` für eigene Funktionen deklarieren.

## Vorgehen

1. Parser: `~>` als zweiten Token neben `:>` in `functionTypeBodyParser`/`returnTypeTokenParser`
   zulassen, `functionTypeLiteral` um die Pfeil-Art erweitern.
2. Checker: `pure` beim Auflösen eines `functionTypeLiteral` aus der Pfeil-Art lesen statt aus einem
   Parameter; `nativeFunction`s Signatur auf zwei Parameter (`FunctionType`, `js`) reduzieren.
3. `typeToString` `case 'function'` um `type.pure` erweitern, damit der Pfeil in Fehlermeldungen und
   Hover erscheint.
4. Migration: alle `nativeFunction`-Aufrufe in core-lib.jul von `(FunctionType, true/false, js)` auf
   `(FunctionType mit passendem Pfeil, js)` umstellen. Dabei stichprobenartig verifizieren, dass die
   bisherige Markierung stimmte (insbesondere Grenzfälle wie `regex`, `parseFloat`, `parseJson` — sind
   die wirklich deterministisch und frei von Systemzustand?).
5. Constant-Folding-Stelle im Checker identifizieren (vermutlich beim Auflösen eines
   Funktionsaufrufs mit bekanntem `functionRef` auf eine native Deklaration, analog zu
   `getReturnTypeFromFunctionCall`) und um den Fall „alle Argumente literal + `pure`" ergänzen.
6. Schritt-Zähler als Guard einbauen, bevor die native `§js§`-Implementierung ausgeführt wird.
7. Tests: gefaltete Literal-Typen für einfache Fälle (`add(2 3)` → Literal `5`), Gegenprobe mit
   nicht-literalen Argumenten (keine Faltung, unverändertes Verhalten), Gegenprobe mit `pure ===
   false` (keine Faltung), Parser-Tests für `~>` analog zu bestehenden `:>`-Tests.

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
