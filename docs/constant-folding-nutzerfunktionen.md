# Constant Folding für Nutzerfunktionen — Umsetzungsplan

Arbeitsdokument. Nach der Umsetzung zu löschen; was überlebt, zieht in Schritt 7 um.

Baut auf [pure-inference-umsetzung.md](pure-inference-umsetzung.md) auf. Stand dort: Purity wird
aus dem Rumpf inferiert, die Argument-Regel greift bei Nutzerfunktionen, gefaltet wird aber nur an
der core-lib-Grenze.

## Ziel

```
double = (a: Integer) => a.multiply(2)
r = double(21)           # heute: Integer,  Ziel: 42
s = map([1 2 3] double)  # heute: List(Integer),  Ziel: [2 4 6]
```

Beides scheitert daran, dass `tryFoldCall` nur JS ausführt, das als Export in `runtime.ts` liegt.

Der zweite Fall braucht mehr als den ersten: `map` ist eine `nativeFunction`, ihr JS ruft
`callback(value, BigInt(index + 1))`. Ein `CompileTimeType` ist nicht aufrufbar — für `double`
muss also ein echtes JS-Callable entstehen. Dasselbe gilt für `filter`, `filterMap`, `findFirst`,
`findLast`, `findLastIndex`, `forEach`, `toDictionary`, `aggregate`, `map$`.

## Regeln

Die Vorgaben, die über mehrere Schritte hinweg gelten.

**Faltbar** ist ein Funktionsliteral, wenn

1. sein Rumpf kein `nativeFunction`- und kein `nativeValue`-Literal enthält,
2. es nicht aus einer `.ts`/`.js`-Datei stammt, und
3. jede freie Referenz seines Rumpfs auf einen Runtime-Export (`isBuiltIn`), einen konstanten Wert
   oder eine wiederum faltbare Nutzerfunktion auflöst.

Bedingung 1 und 2 sind lokale Eigenschaften des Literals (Schritt 2), Bedingung 3 ist der Aufbau
der Umgebung (Schritt 3). Die Regel hängt am **emittierten Slice**, nicht am Aufrufgraphen: dass
`multiply` eine `nativeFunction` ist, macht `double` nicht unfaltbar — `multiply` wird als
kuratierter Runtime-Export gebunden, nicht emittiert. Gefährlich ist allein JS-Text aus einer
Nutzerdatei.

**Bedingung 1 ist die Sicherheitsgrenze.** Bis heute ist die Menge der zur Prüfzeit ausgeführten
Funktionen kuratiert (nur `runtime.ts`). Mit dieser Stufe läuft erstmals emittierter Nutzercode zur
Prüfzeit, und der Language Server prüft beim Öffnen einer Datei ungefragt. Eine Lücke in
Bedingung 1 bedeutet Codeausführung beim Öffnen einer fremden `.jul`-Datei.

**Die Umgebung wird aus Typen gebaut, nie durch Ausführen eines Moduls.** JUL-Dateien haben
ausführbaren Top-Level; ein Modul zu instanziieren führte ihn aus. Für jede freie Referenz also:
Typ → `typeToConstantValue`. Scheitert eine, wird nicht gefaltet. `x = log(1)` / `f = () => x.add(1)`
faltet folglich nicht, ohne dass es dafür eine eigene Regel braucht.

**Gefaltet wird nur der Typ.** Der emittierte Code bleibt unverändert. Eine falsche Faltung erzeugt
damit eine Falschdiagnose, aber kein falsches Programm.

**Ein erschöpftes Budget erzeugt keine Diagnose**, nur „nicht gefaltet". `->` sagt „rein", nicht
„terminiert".

**Unverändert bleibt**, dass `tryFoldCall` `functionExpression.type === 'reference'` verlangt, und
dass `typeToConstantValue` Fraction, Date und Blob nicht kennt. Beides begrenzt die Reichweite und
ist kein Ziel dieser Stufe.

## Schritte

Die Tests laufen tabellengetrieben in `checker.test.ts` gegen einen Helfer `foldedTypeOf(code)`
nach dem Vorbild von `purityOf`/`bodyPurityOf` — Code hinein, Typ der letzten Definition heraus.
Der Helfer entsteht in Schritt 1.

**Je Schritt zuerst die Tests, dann der rote Lauf, dann anhalten.** Für Schritt 1 ist das die
Konvention für Bugfixes — der Überdeckungsfall faltet heute falsch, der rote Zustand ist
vorzuzeigen und zu bestätigen, bevor die Korrektur kommt. Für die übrigen Schritte dasselbe
Vorgehen, weil jeder bestehendes Verhalten ändert.

Fallstrick dabei: Die neue API existiert vorher nicht. Ein Test gegen `foldable` oder gegen den
Auswerter wäre vorher ein *Compile-Fehler*, kein fehlschlagender Assert, und belegt nichts. **Die
Tests sind deshalb gegen `foldedTypeOf` zu formulieren**, gegen beobachtbares Verhalten statt gegen
neue interne Felder. Darum entsteht der Helfer schon in Schritt 1.

### Schritt 1 — Auflösung über das Symbol statt über den Namen

`tryFoldCall` sucht die auszuführende Funktion über
`runtime[escapeReservedJsVariableName(name)]`. Deshalb faltet

```
add = (a: Integer b: Integer) -> Integer => 99
r = add(2 3)
```

zu `r: 5`. Als Altlast war das vertretbar (`JUL4003` meldet die Überdeckung, gefaltet wird nur ein
Typ); sobald Nutzerfunktionen ausgeführt werden, entscheidet der Name darüber, welcher Code läuft.

An der Aufrufstelle von `tryFoldCall` liegt kein Symbol vor — übergeben werden nur Ausdruck und
Typen. `isBuiltIn` entsteht bei der Referenzauflösung (`findResult.scopeIndex === 0` in
`//#region dereference`). Es am `typeInfo` der Referenz mitzuführen ist dem zusätzlichen Parameter
vorzuziehen, weil Schritt 3 dieselbe Auskunft je freier Referenz erneut braucht.

*Tests:* der Überdeckungsfall faltet nicht mehr; die bestehenden Builtin-Faltungen unverändert.

### Schritt 2 — Rückverweis und Faltbarkeit am Typ

`CompileTimeFunctionType` bekommt `literal?: ParseFunctionLiteral` und `foldable?: boolean`, beide
optional, weil `functionTypeLiteral` keinen Rumpf hat. Gesetzt in `case 'functionLiteral'`, wo
`ParamsType` und `ReturnType` ohnehin nachgetragen werden.

`foldable` wird **beim Prüfen des Literals** berechnet, nicht beim Falten: Bedingung 2 braucht den
`filePath`, und den gibt es an einer Aufrufstelle in einer anderen Datei nicht mehr. Geprüft werden
hier nur Bedingung 1 und 2.

*Tests:* Rumpf mit `nativeFunction` nicht faltbar; mit `nativeValue` ebenso; Literal aus einer
`.ts`-Datei ebenso; **Gegenprobe:** ein Rumpf, der eine `nativeFunction` nur *aufruft*
(`a.multiply(2)`), **ist** faltbar.

### Schritt 3 — Freie Referenzen und Umgebung

Ein Sammler über den geprüften Rumpf liefert die freien Referenzen — ohne Parameter, ohne lokale
Definitionen. Je Referenz eine der drei Auflösungen aus Bedingung 3. Scheitert eine, ist das
Ergebnis „keine Umgebung" und damit „nicht gefaltet".

Das Scope-Wissen hängt bereits am Baum: ein `ParseFunctionLiteral` trägt seine `symbols`
(`const ownSymbols = expression.symbols` in `case 'functionLiteral'`). „Frei" heißt also: nicht in
den `symbols` des Literals und kein Parameter, bei geschachtelten Literalen deren eigene `symbols`
mitgeführt. Der Walker ist derselbe Bautyp wie `inferBodyPurity` — ein Durchlauf über den bereits
geprüften Baum, ohne eigene Auflösung.

*Tests:* Rumpf ohne freie Referenzen; freie Referenz auf ein Builtin (`multiply`); auf eine
Konstante; auf eine faltbare Nutzerfunktion; auf einen nicht faltbaren Wert (`x = log(1)`);
Abschattung durch einen Parameter; Abschattung durch eine lokale Definition.

### Schritt 4 — Der Auswerter, in `constant-folding.ts`

Aus Literal und Umgebung eine Bindungsliste emittieren, mit `new Function` instanziieren, über
`runtime._callFunction` aufrufen.

Er kommt in `constant-folding.ts` und nicht in eine eigene Datei, weil die Trennung einen Zyklus
erzeugte: Der Auswerter braucht `typeToConstantValue` und `constantValueToType`, und
`typeToConstantValue` braucht im Fall `function` (Schritt 5) den Auswerter. Im selben Modul ist das
gegenseitige Rekursion zweier Funktionen. Die Zusage im Kopfkommentar („ohne Abhängigkeit von
`checker.ts`") hält weiterhin, denn `emitter.ts` importiert den Checker nicht — der Kommentar ist
aber mitzuziehen, die Datei ist danach Übersetzung *und* Ausführung.

Die Umgebung kommt fertig aufgelöst aus Schritt 3 herein; der Auswerter schlägt nichts nach und
kennt keine Scopes. Damit bleibt er ohne laufenden Checker testbar.

Vier Details:

- **Der Emitter braucht einen neuen Einstiegspunkt.** `expressionToJs` ist nicht exportiert, und
  `syntaxTreeToJs` stellt dem Ergebnis immer einen Modul-Header mit `import` voran
  (`getRuntimeImportJs`). Nötig ist eine exportierte Funktion in [emitter.ts](../src/emitter.ts),
  die Bindungsliste und Literal ohne Header emittiert.
- **Die Runtime wird als Parameter hineingereicht, nicht importiert.** Emittierter Code ruft
  ausnahmslos über sie: jedes Funktionsliteral wird `_createFunction(...)`, jeder Aufruf
  `_callFunction(...)`, jedes Branching `_branch(...)`. Im `new Function`-Kontext gibt es keinen
  Import, diese Namen sind also Parameter der erzeugten Funktion.
- **Deshalb braucht das Budget keine Emitter-Änderung — aber der Haken sitzt nicht, wo man ihn
  sucht.** Nur Dictionary-Argumente werden als `_callFunction(...)` emittiert; Listen-Argumente und
  leere Argumente werden zu einem direkten `f(...)`. Ein Zähler in `_callFunction` bliebe bei
  `f = (n: Integer) => f(n.subtract(1))` also stumm, und der Language Server hinge — das ist die
  naheliegende Fehlimplementierung. Richtig ist `_createFunction`: es hängt heute nur `params` an
  die Funktion und gibt sie zurück; die hineingereichte Variante gibt stattdessen einen **Wrapper**
  zurück, der pro Aufruf dekrementiert, bei Erschöpfung wirft und sonst delegiert (`params`
  mitkopieren, `_callFunction` prüft `'params' in fn`). Beide Aufrufwege laufen über diesen
  Wrapper. Der emittierte Rumpf bleibt damit identisch mit dem Produktionscode. Das Budget ist
  **global pro Check-Lauf**, nicht pro Aufrufstelle — sonst sind 500 Aufrufe à 10⁴ Schritte einzeln
  unauffällig und zusammen eine Sekunde pro Tastendruck.
- **Cache und Schlüssel.** Eine `WeakMap<CompileTimeFunctionType, Map<Schlüssel, Ergebnis>>`; die
  Lebensdauer löst sich von selbst, weil der Funktionstyp je Check-Lauf neu erzeugt wird — im
  Language Server ist keine eigene Invalidierung nötig. Der Schlüssel braucht eine kanonische
  Serialisierung (`JSON.stringify` wirft bei `bigint`, Integer sind in JUL `bigint`) und muss das
  **Prefix-Argument** enthalten: `values.slice(1)` und `otherValues.slice(1)` haben dieselben
  `args`. Ohne Cache ist schon `fib` exponentiell und verbrennt das Budget an einem Aufruf.

**Rekursion:** Eine Selbstreferenz liefert `builtinAny`, ist über die Umgebung also nicht
auflösbar. Sie wird beim Emit an die gerade gebaute Closure gebunden — deshalb ist der Slice eine
Bindungsliste und kein einzelner Ausdruck.

*Tests:* `double(21)` faltet zu `42`; rekursive Funktion mit Abbruchbedingung faltet;
**Gegenprobe:** nicht terminierende Funktion faltet nicht und meldet **nichts** — und zwar mit
**Listen-Argument**, denn mit Dictionary-Argument liefe der Test auch über ein kaputtes Budget
grün; Cache-Treffer bei doppeltem Aufruf; Budget global, nicht je Aufrufstelle.

### Schritt 5 — `typeToConstantValue.case 'function'`

Der offene TODO in [constant-folding.ts](../src/checker/constant-folding.ts). Zweigeteilt: Builtin
→ Runtime-Export über das Symbol aus Schritt 1; Nutzerfunktion → Callable aus dem Auswerter. Damit
greift die HOF-Faltung.

*Tests:* `map` mit Builtin-Callback (faltet heute schon, darf nicht brechen); `map` mit
Nutzer-Callback; `map` mit nicht faltbarem Callback (faltet nicht); `toDictionary` mit zwei
Callbacks; ein Callback, der über die Umgebung auf eine Konstante zugreift.

### Schritt 6 — Baselines und Messung

Jede Änderung einzeln durchsehen statt übernehmen:

- `checker-snapshot.baseline.txt`: mehr Literaltypen, wo bisher `Integer` oder `List(Integer)` stand.
- **Auch die core-lib faltet mit.** Die dort in JUL geschriebenen Definitionen (`Without` u. a.)
  werden faltbar; Bewegung dort ist erwartet und kein Fehler.
- `checker-stats.baseline.txt`: `foldableCall` steigt — die Frage an die Differenz ist, ob die
  Zunahme dort auftritt, wo sie erwartet wird.
- `jul-language-server/scripts/snapshot.baseline.txt` nach `npm run build-all`.

Bench in beiden Projekten vor und nach dem Umbau, jeweils mit `--save --note`. Die Kosten des
Auswerters hängen nicht an der Baumgröße, sondern an der Zahl faltbarer Aufrufstellen —
`jul-examples` trägt als Ziel nicht, maßgeblich ist `yugioh`.

### Schritt 7 — Was den Plan überlebt

Vor dem Löschen dieses Dokuments umzuziehen, sonst geht es verloren:

- **Die Begründung der Sicherheitsgrenze** an das Faltbarkeitsprädikat im Code: warum die Regel am
  emittierten Slice hängt und nicht am Aufrufgraphen, und dass eine Lücke Codeausführung beim
  Öffnen einer fremden Datei bedeutet. Ohne diesen Kommentar liest die nächste Änderung die Regel
  als übervorsichtig und lockert sie.
- **Warum der Auswerter in `constant-folding.ts` liegt** in den Kopfkommentar dieser Datei — der
  ohnehin anzupassen ist (Übersetzung *und* Ausführung).
- **Dass ein erschöpftes Budget keine Diagnose erzeugt** an die Budget-Stelle, mit dem Grund:
  Purity sagt nichts über Termination.
- **Zwei Einträge nach `TODO`:** das Fernziel (Rümpfe mit Argumenttypen erneut prüfen, statt sie
  auszuführen — braucht schreibfreien Checker-Modus, Fehlersenke, Widening) und die verworfene
  Alternative, core-lib in JUL zu schreiben (scheitert an den Laufzeitkosten der core-lib und
  daran, dass JUL keine Array-Mutation hat und keine bekommen soll; ohne Mutation und ohne TCO
  risse ein rekursives `map` über eine lange Liste den Stack).

## Abnahme

1. `npm test` in `jul-compiler` und `jul-language-server` grün.
2. `npm run typecheck` in beiden.
3. Die drei Baselines neu geschrieben und die Differenz nach Schritt 6 durchgesehen.
4. Bench vor/nach in beiden Projekten protokolliert, Ziel `yugioh`.
5. Ein Beispiel aus `jul-examples` und `yugioh` gebaut und ausgeführt: keine neue Diagnose. Die
   Faltung erzeugt nur präzisere Typen, und die sind zuweisbar, wo die gröberen es waren.
6. Bedingung 1 der Faltbarkeitsregel gesondert durchgesehen, nicht nur betestet — an ihr hängt, ob
   das Öffnen einer fremden Datei Code ausführt. Keine Formsache: die Alternative, die diese
   Grenze vermieden hätte, ist verworfen.
7. Schritt 7 erledigt, erst dann dieses Dokument löschen.
