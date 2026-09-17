# Pure Inference: Umsetzungsplan

Baut auf [pure-functions.md](pure-functions.md) auf. Dort steht der bisherige Stand: Purity-Pfeile
im Parser und im Typ, die Argument-Regel (`getCallPurity`) und das darauf aufsetzende Constant
Folding an der core-lib-Grenze.

Diese Stufe leitet die Purity einer `functionLiteral` **aus ihrem Rumpf** ab, statt sie nur aus dem
geschriebenen Pfeil zu übernehmen.

## Ziel

Drei Dinge, die es heute nicht gibt:

1. Eine Funktion ohne Pfeil (`(a) => ...`) bekommt einen — bisher bleibt sie `'unknown'`. Das
   betrifft praktisch allen bestehenden JUL-Code: in den 37 `.jul`-Dateien von `jul-examples` und
   `yugioh` steht **kein einziger** Purity-Pfeil.
2. Die Argument-Regel greift dadurch erstmals bei Nutzerfunktionen. Heute ist jede Abstraktion über
   einer core-lib-Funktion eine Sackgasse für Purity und Faltung.
3. Ein geschriebenes `->`, dem der Rumpf nachweislich widerspricht, wird gemeldet.

## Abgrenzung

Ausdrücklich **nicht** Teil dieser Stufe:

- **Kein Ausführen von Nutzerfunktionen zur Compile-Zeit.** Gefaltet wird weiter nur an der
  core-lib-Grenze, wo fertiges JS in `runtime.ts` liegt. Siehe „Ausblick".
- **Kein Schritt-/Aufrufbudget.** Es wird erst gebraucht, wenn Nutzercode läuft. Der in
  [pure-functions.md](pure-functions.md) erwähnte „Zähler aus der Faltung" existiert nicht;
  `checkerStats.foldableCall` ist reine Statistik.
- **Keine Durchsetzung von Purity in der Zuweisbarkeit.** `getTypeError` ignoriert Purity
  weiterhin. Der einzige neue Fehler ist der Widerspruch zum selbst geschriebenen Pfeil.
- **Keine Purity-Polymorphie in der Signatur** (Koka-artig). Die Bedingung bleibt implizit, siehe E1.

## Entscheidungen

### E1 — Die Benutzung eines eigenen Funktionsparameters zählt als rein

Ein `->` an einer Funktion höherer Ordnung heißt: *rein, sofern die Funktionsargumente rein sind.*
Das ist keine Neuerung, sondern die Lesart, unter der `map` in [core-lib.jul](../src/core-lib.jul)
bereits heute `->` trägt, obwohl es einen `:>`-Callback aufruft. Eingelöst wird die Bedingung an der
Aufrufstelle durch die bestehende Argument-Regel, die dort die tatsächlichen Argumente sieht.

Die Alternative — Parameterbenutzung gilt als nicht beweisbar rein — wurde verworfen: sie macht jede
Nutzer-HOF dauerhaft unrein, also genau den Fall wertlos, für den die Inferenz gebaut wird. Ein
bloßer Wrapper `myMap = (values callback) => map(values callback)` würde die Kette brechen.

Bemerkenswert: die heutige Implementierung verhält sich an der inneren Aufrufstelle bereits so,
allerdings versehentlich. `getCallPurity` lässt alles durch, was kein Funktionstyp ist, und ein
Parameter trägt als Typ eine `parameterReference`, keinen Funktionstyp. Diese Stufe macht aus dem
Zufall eine benannte Regel — und grenzt sie ein (E2).

### E2 — Die Annahme darf die eigene Funktion nicht verlassen

```
makeCaller = (cb: () :> Any) => () => cb()
```

Die innere Funktion benutzt `cb`, das aber ein Parameter der **äußeren** Funktion ist. An der
Aufrufstelle der inneren Funktion gibt es kein Argument, an dem sich die Bedingung einlösen ließe.
Solche Closure-Zugriffe liefern `'unknown'`. Erkennbar am `functionRef` der `parameterReference`,
das `setFunctionRefForParams` bereits setzt.

**Nur an den beiden Stellen, an denen es um Purity geht**, nämlich wenn ein fremder Parameter
*aufgerufen* oder *als Argument weitergegeben* wird. Der bloße Zugriff auf einen fremden Parameter
ist rein — `(a: Integer) => () => a.addInteger(1)` ist eine reine Funktion und muss es bleiben,
sonst wäre praktisch jede geschachtelte Funktion unrein.

Das ist die eine Stelle, an der E1 nicht geschenkt ist — und der Preis dafür, auf Purity-Polymorphie
zu verzichten.

### E3 — Der geschriebene Pfeil wird geprüft, aber nur gegen einen Beweis

Purity-Inferenz ist prinzipiell unvollständig: eine `nativeFunction`, eine aus TypeScript importierte
Funktion oder ein `:>` aus fremdem Code machen einen Rumpf nicht unrein, sondern unentscheidbar.
„Nicht beweisbar rein" ist deshalb nicht dasselbe wie „unrein", und nur der echte Widerspruch wird
gemeldet.

| geschrieben | Rumpf beweisbar rein | Rumpf beweisbar unrein | Rumpf unbekannt |
|---|---|---|---|
| `->` | `->`, stumm | **JUL5101**, Typ wird `~>` | `->`, stumm (ungeprüfte Zusicherung) |
| `~>` | `~>`, stumm | `~>`, stumm | `~>`, stumm |
| `:>` oder kein Pfeil | `->` | `~>` | `:>` |

Der geschriebene Pfeil gewinnt also überall dort, wo er eine Aussage macht — außer wenn er widerlegt
ist. `~>` bei reinem Rumpf bleibt stumm: das ist eine legitime Reserve des Autors, keine
Unsauberkeit. `:>` wird durch das Inferenzergebnis ersetzt; das ist der eigentliche Gewinn.

Nebeneffekt, der die Entscheidung stützt: Beim Tippen ist ein Rumpf unvollständig und liefert
`'unknown'` — die Prüfung schweigt also im Language Server genau dann, wenn sie sonst stören würde.

`nativeFunction` bleibt von der Prüfung unberührt, und zwar nicht aus Nachsicht: ihr Pfeil steht an
einem `functionTypeLiteral` ohne Rumpf. Die ungeprüfte Zusicherung an dieser Grenze bleibt damit die
Wurzel, auf der alles andere ruht — die Inferenz macht Purity nicht beweisbar, sondern nur
weitertragbar.

### E4 — Purity ist dreiwertig, mit `unknown` als echtem dritten Wert

Der Verband ist `pure < unknown < impure`, die Verknüpfung mehrerer Beiträge ist das Maximum: ein
beweisbar unreiner Beitrag macht unrein, sonst macht ein unbekannter unbekannt, sonst ist es rein.

Das ist neu gegenüber `effectivePurity` in [checker.ts](../src/checker/checker.ts), das `unknown` und
`impure` zusammenfallen lässt. Diese Zusammenfassung bleibt dort, wo sie hingehört — in der
Union-Normalisierung und in `typeEquals`, wo eine zweite künstliche Trennung schadet. Die Inferenz
braucht die Unterscheidung dagegen, weil E3 auf ihr beruht.

### E5 — Selbstrekursion wird optimistisch angenommen, in einem Durchlauf

Eine Selbstreferenz auf einen Wert liefert heute `builtinAny` (`dereferenceType`), am rekursiven
Aufruf liegt also gar kein Funktionstyp vor. Statt einer Fixpunkt-Iteration wird der rekursive
Aufruf als rein angenommen.

Das ist hier beweisbar ausreichend, nicht nur pragmatisch: die Annahme wirkt sich nur aus, wenn alle
übrigen Beiträge rein sind — andernfalls ist das Ergebnis ohnehin unrein, unabhängig von ihr. Ein
zweiter Durchlauf könnte das Ergebnis also nicht mehr ändern. Nichttermination gilt dabei nicht als
Effekt: eine Funktion, deren einziger nicht-reiner Bestandteil der Selbstaufruf ist, terminiert
entweder rein oder gar nicht.

**Gegenseitige** Rekursion gibt es außerhalb der core-lib nicht, weil Vorwärtsreferenzen `JUL4002`
sind. Innerhalb der core-lib wäre sie möglich, betrifft aber nur die wenigen dort in JUL
geschriebenen Definitionen (`Without` u. a.); dort wird der konservative Wert genommen.

### E6 — Funktionen aus `.ts`/`.js`-Dateien behalten `'unknown'`

Sie folgt aus einem Befund, der beim Ausarbeiten aufgetaucht ist:

Eine aus TypeScript importierte Funktion wird vom
[typescript-parser](../src/parser/typescript-parser.ts) als `functionLiteral` mit einem
**Dummy-Rumpf** dargestellt — `nativeValue(§[...]§)`, damit der Rückgabetyp `Any` wird. `nativeValue`
ist in der core-lib `~>`. Eine Inferenz über diesen Rumpf würde also ableiten: *jede importierte
TS-Funktion ist beweisbar unrein.*

Das wäre falsch begründet. Der Dummy-Rumpf ist ein Artefakt des Parsers, keine Aussage über das JS
dahinter; die ehrliche Auskunft ist `:>`. **Entschieden:** Funktionsliterale aus `.ts`/`.js`-Dateien
überspringt die Inferenz, ihr Typ bleibt `'unknown'`. JavaScript ist für den Checker undurchsichtig —
nicht unrein, sondern unbekannt, genau wie die `nativeFunction`-Grenze. Der Kommentar an `ParseFunctionLiteral.arrow`
in [syntax-tree.ts](../src/syntax-tree.ts) hält bereits fest, dass diese Literale keinen Pfeil
tragen — die Ausnahme passt also zum Bestand.

Die Alternative — den Dummy-Rumpf im Walker erkennen — löst dasselbe Problem teurer und
zerbricht, sobald der Parser einen echten Rumpf erzeugt.

## Geprüfte Voraussetzungen

Drei Punkte, die die Regeln hätten ändern können, und an denen sie es nicht tun:

- **Streams brauchen keine eigene Regel.** Die ursprüngliche Formulierung lautete „kein Stream
  gelesen/geschrieben". Jeder Streamzugriff ist tatsächlich ein Aufruf (`push`, `subscribe`,
  `complete`, `timer$`, `map$`, `combine$` — alle `~>`), ein lesender Member-Zugriff existiert nicht;
  `getValue` steht in [core-lib.jul](../src/core-lib.jul) nur auskommentiert, und `stream$/ValueType`
  navigiert im Typ, nicht im Wert. Die Streambedingung ist damit vollständig in „ruft nur reine
  Funktionen" enthalten.
- **Die Reihenfolge stimmt schon.** `functionType.purity` wird beim Erzeugen aus dem Pfeil gesetzt
  und nach dem Rumpf überschrieben, obwohl der Rumpf bereits mit diesem `functionType` im Scope
  geprüft wird. Purity liest während der Rumpfprüfung nur `getCallPurity` (in `tryFoldCall`) — und
  ein rekursiver Aufruf sieht dort ohnehin `Any`, nicht den `functionType`. Geschachtelte Literale
  werden vor dem äußeren fertig; die Reihenfolge ist also von selbst bottom-up.
- **Ein Pfeil bedingt einen Rückgabetyp.** `functionTypeBodyParser` liest Pfeil und Rückgabetyp in
  einer Sequenz. `expression.returnType` existiert also immer, wenn `expression.arrow` gesetzt ist —
  wichtig für JUL5101, weil `arrow` selbst nur ein `Purity`-Wert ohne Position ist.

## Schritte

### Schritt 1 — Aufruf-Purity dreiwertig, und die Lücken der Argument-Regel

**Ort:** `//#region purity` in [checker.ts](../src/checker/checker.ts), bei `getCallPurity`.
Eine eigene Datei nach dem Vorbild von `constant-folding.ts` scheidet aus: der Code braucht
`isFunctionType`, `isTupleType`, `isDictionaryLiteralType` und `resolveAlias`, die alle in
`checker.ts` liegen, und `checker.ts` initialisiert beim Laden die core-lib — ein Modulzyklus ist
dort riskant. Testbar bleibt es wie heute über den Export.

```ts
/** pure < unknown < impure. Ein beweisbar unreiner Beitrag gewinnt, sonst ein unbekannter. */
function joinPurity(first: Purity, second: Purity): Purity;

/**
 * Purity eines konkreten Aufrufs, dreiwertig.
 * ownFunctionType ist gesetzt, wenn innerhalb eines Rumpfes inferiert wird: dann zaehlt die
 * Weitergabe eines eigenen Parameters als rein (E1). Ohne den Kontext - also bei der Faltung -
 * zaehlt sie als 'unknown'.
 */
export function getCallPurityInfo(
	functionType: CompileTimeType,
	prefixArgumentType: CompileTimeType | undefined,
	argsType: CompileTimeType,
	ownFunctionType?: CompileTimeFunctionType,
): Purity;

/** Zweiwertige Auskunft fuer die Faltung: nur ein Beweis genuegt. */
export function getCallPurity(/* wie oben, ohne ownFunctionType */): Purity {
	return getCallPurityInfo(...) === 'pure' ? 'pure' : 'impure';
}
```

Beiträge in `getCallPurityInfo`:

- Callee-Typ ist kein Funktionstyp (`Any`, Choice, Platzhalter) → `'unknown'`.
- Callee-Purity `'impure'` → `'impure'`; `'unknown'` → `'unknown'`.
- Callee-Purity `'pure'` → `joinPurity` über die Purity **aller** übergebenen Werte, Prefix-Argument
  eingeschlossen.

Die Purity eines übergebenen Werts (`getArgumentPurity`, rekursiv):

| Typ | Beitrag |
|---|---|
| Funktionstyp | dessen `purity` |
| `parameterReference` | `'pure'`, wenn `functionRef === ownFunctionType`, sonst `'unknown'` (E1/E2) |
| `tuple`, `dictionaryLiteral` | `joinPurity` über die Elemente bzw. Felder |
| `empty` und alles, was keine Funktion enthalten kann (`integer`, `float`, `text`, `boolean`, `date`, `blob`, `error`, Literaltypen) | `'pure'` |
| alles Übrige (`any`, `choice`, `list`, `dictionary`, sonstige Platzhalter) | `'unknown'` |

Damit sind drei Lücken der heutigen Regel geschlossen:

- **Das Prefix-Argument** wird mitgeprüft; heute bekommt `getCallPurity` nur `argsType`, eine
  Funktion in Prefix-Position entgeht der Regel vollständig. `tryFoldCall` hat den Typ bereits zur
  Hand und reicht ihn durch.
- **Funktionen in Datenargumenten** (`f([cb = log])`) werden über den rekursiven Abstieg in Tuple
  und Dictionary erfasst. **Nicht** in Funktionstypen hinein absteigen: deren Parameter und Rückgabe
  beschreiben etwas, sie werden nicht übergeben.
- **Was heute pauschal durchrutscht, weil es kein Funktionstyp ist** (`Any`, Choice, und bei
  `f(...liste)` die gesamte Argumentliste, die dann kein Tuple ist), gilt jetzt als `'unknown'`.

**Die Faltung ändert sich dadurch nicht.** Sie verlangt ohnehin konstante Argumente, und
`typeToConstantValue` scheitert an jedem Typ, der neu auf `'unknown'` fällt. Die Verschärfung ist
dort gratis — sie zahlt sich erst in Schritt 2 aus.

*Tests* in `checker.test.ts` neben den bestehenden `getCallPurity`-Tests: Prefix-Argument mit `log`,
Callback im Dictionary-Argument, Spread-Argumentliste, Parameter-Weitergabe mit und ohne
Eigentümer-Kontext, fremder Parameter, je ein Fall pro Wertstufe.

### Schritt 2 — Der Rumpf-Walker

Läuft über den **bereits geprüften** Rumpf (`typeInfo` ist gesetzt), im Anschluss an die
Body-Schleife in `case 'functionLiteral'`. Keine eigene Typauflösung, nur Lesen.

```ts
interface BodyPurity {
	purity: Purity;
	/** Erste beweisbar unreine Stelle - fuer JUL5101, damit der Fehler dort steht, wo er entsteht. */
	impureExpression?: PositionedExpression;
}

function inferBodyPurity(
	body: ParseExpression[],
	ownFunctionType: CompileTimeFunctionType,
): BodyPurity;
```

Je Knotentyp:

- **`functionLiteral`** → Beitrag `'pure'`, **nicht absteigen**. Eine Funktion zu *erzeugen* ist
  rein; erst ihr Aufruf trägt bei, und ihre Purity steht bereits an ihrem Typ, weil sie vorher
  inferiert wurde. Ein Rumpf, der eine Funktion baut, die `log` ruft, ist rein.
- **`functionCall`** → `getCallPurityInfo(functionExpression.typeInfo.type,
  prefixArgument?.typeInfo?.type, arguments?.typeInfo?.type, ownFunctionType)`. In die
  Argumentausdrücke wird zusätzlich abgestiegen (dort können weitere Aufrufe stehen). Zwei
  Sonderfälle vor der Auswertung:
  - **Selbstaufruf** (E5): `functionExpression` ist eine `reference`, für die das vorhandene
    `isSelfReference` zutrifft → Beitrag `'pure'`.
  - **Callee ist ein fremder Parameter** (E2) → Beitrag `'unknown'`.
- **`branching`** → eigener Fall, entgegen einer früheren Fassung dieses Plans: `branching` ist ein
  eigener Knotentyp mit `branches: ParseValueExpression[]`, und ein Zweig muss kein Literal sein, er
  kann auch eine Referenz auf eine Funktion sein. Beitrag = `joinPurity` über die Purity **der
  Zweigtypen** (Funktionstyp → dessen `purity`, sonst `'unknown'`), plus der Abstieg in `args`. In
  die Zweig-Literale wird dabei nicht abgestiegen — ihre Purity steht an ihrem Typ, genau wie bei
  jedem anderen aufgerufenen Wert.
- **`reference`** → `'pure'`. Auch bei einem fremden Parameter: der bloße Zugriff ist rein, nur
  Aufruf und Weitergabe zählen (E2).
- **Alles Übrige** — verschachtelte Referenzen, Kollektionen, Text-Interpolation, Definitionen im
  Rumpf — ist für sich rein und wird über `forEachChild` nur durchlaufen.

*Tests*, tabellengetrieben mit `code` und erwarteter Purity: konstanter Rumpf; Aufruf von `log`;
Aufruf einer `:>`-Funktion; erzeugtes, aber nicht aufgerufenes unreines Literal; sofort aufgerufenes
Literal; Branching mit einem unreinen Zweig; Branching mit einer unreinen Referenz als Zweig;
Closure über einen fremden Parameter als Wert (rein) und als Aufruf (unbekannt); direkte Rekursion
mit und ohne `log`; Weitergabe des eigenen Parameters an `map`; `log` tief in einem
Dictionary-Argument.

### Schritt 3 — Verdrahtung nach der E3-Tabelle

In `case 'functionLiteral'`, nach der Body-Schleife und vor dem Setzen von `ReturnType`. Das Objekt
wird dort ohnehin schon nachträglich mutiert (`ParamsType`, `ReturnType`), es entsteht kein neuer
Mechanismus.

```ts
// E6: der Dummy-Rumpf importierter TS-Funktionen (nativeValue) wuerde sie faelschlich
// als unrein ausweisen - fuer sie bleibt es bei der Auskunft 'unknown'.
if (!isTypeScriptFile(filePath)) {
	const bodyPurity = inferBodyPurity(expression.body, functionType);
	switch (expression.arrow) {
		case undefined:
		case 'unknown':
			functionType.purity = bodyPurity.purity;
			break;
		case 'impure':
			break;
		case 'pure':
			if (bodyPurity.purity === 'impure') {
				// Schritt 4: JUL5101
				functionType.purity = 'impure';
			}
			break;
	}
}
```

`case 'functionTypeLiteral'` bleibt unangetastet: kein Rumpf, nichts zu inferieren.

*Tests*: die Felder der Tabelle, jeweils über `typeToString` am Definitionstyp geprüft, plus eine
`.ts`-Datei, deren importierte Funktion `:>` bleibt.

### Schritt 4 — `JUL5101 purityMismatch`

Neuer Code in `compiler-errors.ts` direkt neben `returnTypeMismatch = 5100`, `type: 'type'`,
`severity: 'error'`.

Gemeldet wird an `bodyPurity.impureExpression` — also an der Aufrufstelle, die den Beweis bricht,
nicht an der ganzen Funktion. Das ist derselbe Grund, aus dem `returnTypeMismatch` den
zurückgegebenen Ausdruck markiert und nicht den Rumpf: sonst ummantelt die mehrzeilige Klammerung
der Fehlerausgabe den kompletten Funktionskörper.

`relatedInformation` zeigt auf `expression.returnType` — das ist die Position direkt hinter dem
Pfeil, denn der Pfeil selbst ist nur ein `Purity`-Wert ohne Position, und ein Rückgabetyp ist immer
da, wenn ein Pfeil geschrieben wurde (siehe „Geprüfte Voraussetzungen").

Wortlaut in der Art der bestehenden Meldungen:

```
Purity mismatch.
The function is declared pure, but this call is not.
```

mit `relatedInformation`: `Declared as pure here.`

*Tests*: ein positiver Fall; die Gegenprobe, dass ein `->` über einem *unentscheidbaren* Rumpf
(Aufruf einer `:>`-Funktion) **nichts** meldet; und dass der Fehler an der Aufrufstelle steht, nicht
an der Funktion.

### Schritt 5 — Baselines und Messung

Erwartete Änderungen, jede einzeln zu prüfen statt zu übernehmen:

- **core-lib**: die in JUL geschriebenen Definitionen ohne Pfeil (`Without` u. a.) wechseln von `:>`
  auf `->`.
- **Importierte TS-Funktionen bleiben `:>`** — das ist der Beleg dafür, dass E6 greift. Stünde dort
  `~>`, ist die Ausnahme nicht wirksam.
- **`typeEquals` vergleicht die `effectivePurity`** von Funktionstypen: zwei bisher gleiche Typen
  können jetzt ungleich werden und in einer Union nicht mehr dedupliziert. Das ist die
  wahrscheinlichste Ursache, falls sich Zählerstände bewegen.

Betroffen: `src/checker/checker-snapshot.baseline.txt` und `src/checker/checker-stats.baseline.txt`
(`npm run test-update-snapshot`), sowie `jul-language-server/scripts/snapshot.baseline.txt`
(`npm run test-snapshot`, nach `npm run build-all`).

Bench in `jul-compiler` und `jul-language-server` **vor und nach** dem Umbau, jeweils mit
`--save --note`. Der Walker ist ein zusätzlicher Durchlauf je Funktionsrumpf über bereits geprüfte
Knoten, also linear und ohne Typauflösung — zeigt die Messung mehr, ist das ein Befund und kein
Rundungsfehler.

### Schritt 6 — Dokumentation und Altlasten

- `jul-homepage/docs/docs/documentation/handbook.md`: der Satz „Die Zusicherung gilt für das ganze
  Function Type Literal bzw. Function Literal, **unabhängig vom Rumpf**" wird durch E3 falsch. Neu
  zu formulieren ist, was gilt: ohne Pfeil bestimmt der Rumpf die Purity; ein geschriebenes `->`,
  dem der Rumpf widerspricht, ist ein Fehler. Ohne Begründung und ohne Verweis hierher — die
  öffentliche Doku beschreibt Verhalten. Die englische i18n-Fassung mitziehen.
- Die verbliebenen Verweise auf die gelöschte `docs/constant-folding-umsetzung.md` in `checker.ts`
  (zweimal), `constant-folding.ts`, `checker.test.ts` und `runtime.test.ts` bereinigen.
- Der Kommentar an `checkerStats.foldableCall` („gezählt, aber noch nicht gefaltet") ist seit der
  Umsetzung der Faltung falsch.

## Bewusst offen gelassen

- **Die `nativeFunction`-Grenze bleibt ungeprüft.** Unvermeidbar; die Inferenz macht Purity
  weitertragbar, nicht beweisbar.
- **Die Argument-Regel fordert zu viel.** Sie verlangt Reinheit von *allen* Funktionsargumenten, auch
  von solchen, die die gerufene Funktion nie aufruft. Die präzise Form — der Funktionstyp merkt sich,
  *welche* Parameterpositionen rein sein müssen — ist additiv aus dieser Stufe erreichbar: sie ändert
  nur das Feld `purity` und `getCallPurityInfo`. Erst angehen, wenn die grobe Form real stört.
- **Closures verlieren die Bedingung** (E2). Das ist die Grenze ohne Purity-Polymorphie.
- **`tryFoldCall` sucht die auszuführende Funktion über den Namen** im Runtime-Modul statt über das
  aufgelöste Symbol. Dadurch faltet

  ```
  add = (a: Integer b: Integer) -> Integer => 99
  r = add(2 3)
  ```

  heute zu `r: 5`. `JUL4003` meldet die Überdeckung, der Code ist also ohnehin fehlerhaft, und der
  Wert ist nur ein Typ — deshalb bleibt es hier liegen. Vor jedem Ausführen von Nutzerfunktionen ist
  es dagegen zwingend zu reparieren (`dereferenceType` liefert bereits ein `isBuiltIn`).
- **Purity flackert im Language Server**, solange ein Rumpf halb getippt ist. Hingenommen: betroffen
  sind nur Anzeige und Faltung, und E3 sorgt dafür, dass dabei keine Diagnose aufblitzt.

## Abnahme

1. `npm test` in `jul-compiler` und in `jul-language-server` grün.
2. `npm run typecheck` in beiden.
3. Die drei Baselines neu geschrieben und die Änderung nach Schritt 5 durchgesehen.
4. Bench vor/nach protokolliert.
5. Ein Beispiel aus `jul-examples` und `yugioh` gebaut und ausgeführt: die Inferenz darf keine neue
   Diagnose erzeugen, weil in beiden Codebasen kein einziger Pfeil steht und `JUL5101` nur gegen
   einen geschriebenen Pfeil urteilt.

## Ausblick: Nutzerfunktionen zur Compile-Zeit ausführen

Bewusst auf später verschoben, nicht Teil dieser Stufe. Erst damit würde Purity über die Anzeige
hinaus zu mehr Faltung führen. Drei Voraussetzungen, die vorher geklärt sein müssen:

- **Ein Schritt-/Aufrufbudget.** Es gibt keines. Ohne Budget friert eine nicht terminierende
  Nutzerfunktion den Language Server bei jedem Tastendruck ein.
- **Die Purity-Zusicherung würde zur Ausführungserlaubnis.** Ein `->` an einer nutzereigenen
  `nativeFunction`, die `runJs` kapselt, hieße: der Language Server führt beim Tippen beliebiges JS
  aus. Heute ist die Menge der ausführbaren Funktionen kuratiert. Prüfen lässt sich das nicht (E3),
  nur durch Nicht-Ausführen vermeiden.
- **Symbolbasierte statt namensbasierte Auflösung** in `tryFoldCall`, siehe oben.

Als Einstieg wäre die Substitution der Ausführung vorzuziehen: Funktionen, deren Rumpf ein einzelner
Ausdruck ohne Rekursion ist, durch diesen Ausdruck ersetzen und die bestehende Builtin-Faltung
darauf greifen lassen. Das deckt dünne Wrapper ab, terminiert von selbst und braucht weder Budget
noch einen zweiten Evaluator neben dem Emitter.
