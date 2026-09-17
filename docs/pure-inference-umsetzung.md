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
allerdings versehentlich. `getCallPurity` lässt alles durch, was kein Funktionstyp ist
([checker.ts](../src/checker/checker.ts), `getCallPurity`), und ein Parameter trägt als Typ eine
`parameterReference`, keinen Funktionstyp. Diese Stufe macht aus dem Zufall eine benannte Regel —
und grenzt sie ein (E5).

### E2 — Die Annahme darf die eigene Funktion nicht verlassen

```
makeCaller = (cb: () :> Any) => () => cb()
```

Die innere Funktion benutzt `cb`, das aber ein Parameter der **äußeren** Funktion ist. An der
Aufrufstelle der inneren Funktion gibt es kein Argument, an dem sich die Bedingung einlösen ließe.
Solche Closure-Zugriffe machen unrein (genauer: `'unknown'`, siehe E4). Erkennbar ist der Fall am
`functionRef` der `parameterReference`, das `setFunctionRefForParams` bereits setzt.

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
| `:>` | `->` | `~>` | `:>` |

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

Das ist neu gegenüber `effectivePurity` ([checker.ts](../src/checker/checker.ts)), das `unknown` und
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

## Schritte

### Schritt 1 — Aufruf-Purity dreiwertig, und die drei Lücken der Argument-Regel

`getCallPurity` wird zum dünnen Wrapper über einer dreiwertigen Funktion. Die bestehende Zweiwertigkeit
bleibt für die Faltung erhalten (`pure` genau dann, wenn die dreiwertige Auskunft `pure` ist), das
Verhalten der Faltung ändert sich dadurch nicht.

Beiträge eines Aufrufs:

- Callee-Typ ist kein Funktionstyp (`Any`, Choice, Platzhalter) → `unknown`.
- Callee-Purity `impure` → `impure`; `unknown` → `unknown`.
- Callee-Purity `pure` → das Maximum über die Purity der Funktionsargumente.

Bei der Gelegenheit die drei Lücken, die die Inferenz sonst erbt und verstärkt:

- **Das Prefix-Argument wird mitgeprüft.** `getCallPurity` bekommt heute nur `argsType`; eine
  Funktion in Prefix-Position entgeht der Regel vollständig. `tryFoldCall` hat den Typ bereits zur
  Hand und reicht ihn durch.
- **Funktionen in Datenargumenten werden erfasst.** `f([cb = log])` entgeht der Regel heute, weil
  nur die obersten Argumenttypen betrachtet werden. Beim Sammeln der Funktionsargumente in Tuple-
  und Dictionary-Typen absteigen — aber nicht in Funktionstypen hinein (deren Parameter und
  Rückgabe sind Beschreibung, kein übergebener Wert).
- **`parameterReference` gilt nur unter E1 als rein.** Der dreiwertigen Funktion wird optional der
  eigene Funktionstyp mitgegeben; nur dann passiert eine `parameterReference` mit passendem
  `functionRef` die Prüfung. Ohne diesen Kontext — also bei der Faltung — gilt sie als `unknown`.
  Für die Faltung ist das folgenlos, weil `typeToConstantValue` an einer `parameterReference` ohnehin
  scheitert; die Verschärfung ist dort gratis.

*Tests* in `checker.test.ts` neben den bestehenden `getCallPurity`-Tests: Prefix-Argument mit
`log`, Callback im Dictionary-Argument, Parameter-Weitergabe mit und ohne Eigentümer-Kontext,
je einer für die drei Wertstufen.

### Schritt 2 — Der Rumpf-Walker

Eine Funktion, die über den **bereits geprüften** Rumpf läuft (`typeInfo` ist gesetzt) und die
Purity-Beiträge nach E4 verknüpft. Sie läuft im Anschluss an die Body-Schleife in
`case 'functionLiteral'` ([checker.ts](../src/checker/checker.ts)), also ohne eigene Typauflösung.

Regeln der Traversierung:

- **Nicht in geschachtelte `functionLiteral` absteigen.** Eine Funktion zu *erzeugen* ist rein; erst
  ihr Aufruf trägt bei. Ein Rumpf, der eine Funktion baut, die `log` ruft, ist rein. Ihre Purity
  steht ohnehin schon an ihrem Typ, weil sie vorher inferiert wurde.
- **`branching` trägt die Purity seiner Zweige.** Die Zweige sind Funktionsliterale, die vom
  Branching aufgerufen werden — ihre inferierte Purity steht an ihrem Typ und geht mit ein, zusammen
  mit der des gebranchten Werts. Kein Sonderfall in der Traversierung, nur ein Beitrag mehr.
- **`functionCall`** trägt das Ergebnis aus Schritt 1 bei, mit dem eigenen Funktionstyp als
  Kontext (E1). Ein unmittelbar aufgerufenes Funktionsliteral `((a) => a)(5)` fällt ohne Sonderfall
  darunter, weil sein Typ die inferierte Purity trägt.
- **Referenz auf einen fremden Parameter** (Closure, `functionRef` zeigt auf eine andere Funktion)
  → `unknown` (E2).
- **Selbstreferenz** → als rein angenommen (E5). Erkennbar wie in `isSelfReference`: über die
  `parent`-Kette zur umschließenden Definition gleichen Namens.
- Alles Übrige — Referenzen, verschachtelte Referenzen, Kollektionen, Text-Interpolation,
  Definitionen im Rumpf — ist für sich rein und wird nur durchlaufen.

Für die Fehlermeldung aus Schritt 4 liefert der Walker neben der Purity die **erste beweisbar
unreine Aufrufstelle** mit zurück.

*Tests*: tabellengetrieben mit `code` und erwarteter Purity. Mindestens: leerer/konstanter Rumpf,
Aufruf von `log`, Aufruf einer `:>`-Funktion, erzeugtes aber nicht aufgerufenes unreines Literal,
Branching mit einem unreinen Zweig, Closure über fremden Parameter, direkte Rekursion mit und ohne
`log` im Rumpf, Weitergabe des eigenen Parameters an `map`.

### Schritt 3 — Verdrahtung nach der E3-Tabelle

In `case 'functionLiteral'`: nach der Body-Schleife und vor dem Setzen von `ReturnType` die
Rumpf-Purity bestimmen und `functionType.purity` nach der Tabelle setzen. Das Objekt wird dort
ohnehin schon nachträglich mutiert (`ParamsType`, `ReturnType`), es entsteht kein neuer Mechanismus.

`case 'functionTypeLiteral'` bleibt unangetastet: kein Rumpf, nichts zu inferieren.

*Tests*: die neun Felder der Tabelle, jeweils über `typeToString` am Definitionstyp geprüft.

### Schritt 4 — `JUL5101 purityMismatch`

Neuer Code in `compiler-errors.ts` direkt neben `returnTypeMismatch = 5100`, `type: 'type'`,
`severity: 'error'`. Gemeldet an der Aufrufstelle, die den Beweis bricht — nicht an der ganzen
Funktion, aus demselben Grund, aus dem `returnTypeMismatch` den zurückgegebenen Ausdruck markiert
und nicht den Rumpf. `relatedInformation` zeigt auf den geschriebenen Pfeil.

*Tests*: ein positiver Fall, plus die Gegenprobe, dass ein `->` über einem unentscheidbaren Rumpf
(`nativeFunction`-Aufruf, `:>`-Funktion) **nichts** meldet.

### Schritt 5 — Baselines und Messung

Die core-lib enthält in JUL geschriebene Definitionen ohne Pfeil (`Without` in
[core-lib.jul](../src/core-lib.jul) u. a.), deren Typ sich zwangsläufig ändert. Betroffen:

- `src/checker/checker-snapshot.baseline.txt` und `src/checker/checker-stats.baseline.txt`
  (`npm run test-update-snapshot`),
- `jul-language-server/scripts/snapshot.baseline.txt` (`npm run test-snapshot`, nach `build-all`).

Die Änderungen sind **anzusehen, nicht zu übernehmen**: erwartet werden ausschließlich Pfeile, die
von `:>` auf `->` wechseln. Ein Wechsel auf `~>` oder eine geänderte Zählung sind erklärungsbedürftig.

`typeEquals` vergleicht die `effectivePurity` von Funktionstypen — zwei bisher gleiche Typen können
jetzt ungleich werden und in einer Union nicht mehr dedupliziert. Das ist die wahrscheinlichste
Ursache, falls sich Zählerstände bewegen.

Bench in `jul-compiler` und `jul-language-server` **vor und nach** dem Umbau, jeweils mit
`--save --note`. Der Walker ist ein zusätzlicher Durchlauf je Funktionsrumpf über bereits geprüfte
Knoten, also linear und ohne Typauflösung — falls die Messung mehr zeigt, ist das der Befund, nicht
der Rundungsfehler.

### Schritt 6 — Dokumentation

- [pure-functions.md](pure-functions.md): den Stand fortschreiben, den Ausblick „Pure Inference"
  durch einen Verweis hierher ersetzen. Dabei die vier Verweise auf die gelöschte
  `constant-folding-umsetzung.md` bereinigen (sie stehen auch in `checker.ts`, `constant-folding.ts`,
  `checker.test.ts` und `runtime.test.ts`) und den veralteten Kommentar an
  `checkerStats.foldableCall` („gezählt, aber noch nicht gefaltet") korrigieren.
- `jul-homepage/docs/docs/documentation/handbook.md`: der Satz „Die Zusicherung gilt für das ganze
  Function Type Literal bzw. Function Literal, **unabhängig vom Rumpf**" wird durch E3 falsch. Neu
  zu formulieren ist, was gilt: ohne Pfeil bestimmt der Rumpf die Purity; ein geschriebenes `->`,
  dem der Rumpf widerspricht, ist ein Fehler. Ohne Begründung und ohne Verweis hierher — die
  öffentliche Doku beschreibt Verhalten.

## Bewusst offen gelassen

- **Die `nativeFunction`-Grenze bleibt ungeprüft.** Unvermeidbar; die Inferenz macht Purity
  weitertragbar, nicht beweisbar.
- **Die Argument-Regel fordert zu viel.** Sie verlangt Reinheit von *allen* Funktionsargumenten, auch
  von solchen, die die gerufene Funktion nie aufruft. Die präzise Form — der Funktionstyp merkt sich,
  *welche* Parameterpositionen rein sein müssen — ist additiv aus dieser Stufe erreichbar: sie ändert
  nur das Feld `purity` und die Prüfung an der Aufrufstelle. Erst angehen, wenn die grobe Form real
  stört.
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
3. Die drei Baselines neu geschrieben und die Änderung durchgesehen — nur `:>` → `->`.
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
  aus. Heute ist die Menge der ausführbaren Funktionen kuratiert. Prüfen lässt sich das nicht
  (E3), nur durch Nicht-Ausführen vermeiden.
- **Symbolbasierte statt namensbasierte Auflösung** in `tryFoldCall`, siehe oben.

Als Einstieg wäre die Substitution der Ausführung vorzuziehen: Funktionen, deren Rumpf ein einzelner
Ausdruck ohne Rekursion ist, durch diesen Ausdruck ersetzen und die bestehende Builtin-Faltung
darauf greifen lassen. Das deckt dünne Wrapper ab, terminiert von selbst und braucht weder Budget
noch einen zweiten Evaluator neben dem Emitter.
