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
3. jede freie Referenz seines Rumpfs auf einen konstanten Wert, eine wiederum faltbare
   Nutzerfunktion oder einen Runtime-Export auflöst.

Bedingung 1 und 2 sind lokale Eigenschaften des Literals (Schritt 1), Bedingung 3 ist der Aufbau
der Umgebung (Schritt 1). Die Regel hängt am **emittierten Slice**, nicht am Aufrufgraphen: dass
`multiply` eine `nativeFunction` ist, macht `double` nicht unfaltbar — `multiply` wird als
kuratierter Runtime-Export gebunden, nicht emittiert. Gefährlich ist allein JS-Text aus einer
Nutzerdatei.

**Bedingung 1 ist die Sicherheitsgrenze.** Bis heute ist die Menge der zur Prüfzeit ausgeführten
Funktionen kuratiert (nur `runtime.ts`). Mit dieser Stufe läuft erstmals emittierter Nutzercode zur
Prüfzeit, und der Language Server prüft beim Öffnen einer Datei ungefragt. Eine Lücke in
Bedingung 1 bedeutet Codeausführung beim Öffnen einer fremden `.jul`-Datei.

### `nativeFunction` in Nutzercode

`runJs`, `nativeFunction` und `nativeValue` sind gewöhnliche core-lib-Builtins und damit in jeder
`.jul`-Datei verfügbar; `runJs` ist wörtlich `eval`. Nutzercode kann also beliebiges JS einbetten.
Drei Fälle, die verschieden gestoppt werden:

1. **Der Rumpf enthält ein `nativeFunction`/`nativeValue`-Literal oder ruft `runJs`.** Doppelt
   gestoppt: alle drei sind `~>`, der Rumpf ist damit beweisbar unrein und fällt schon durch das
   Purity-Gate in `tryFoldCall`; zusätzlich greift Bedingung 1.
2. **Eine per `nativeFunction` definierte Funktion wird aufgerufen.** Purity hilft hier *nicht*:
   ihre Signatur sagt `->`, und das ist die ungeprüfte Zusicherung an der nativeFunction-Grenze.
   Gestoppt wird es daran, dass ihr Typ kein `literal` trägt (sie entsteht aus einer Signatur, nicht
   aus einem Literal) und Regel 3 keinen Runtime-Export unter ihrem Namen findet.
3. **Sie wird aus einem faltbaren Rumpf gerufen oder als Callback übergeben.** Der unauffälligste
   Fall: `f = (a: Integer) => myFn(a)` ist rein und enthält kein Literal, die Faltung wird also
   *versucht* und scheitert erst beim Umgebungsaufbau — aus demselben Grund wie in Fall 2.

**Die Kette in Fall 2 und 3 ist tragend:** Regel 3 verlangt `'params' in export`, und `params` hängt
nur an den Builtins, die `runtime.ts` per `_createFunction(...)` auf Top-Level-Ebene registriert —
deren Namen wiederum sind durch `JUL4003` überdeckungsgeschützt. Wer Regel 3 zu einem schlichten
`runtime[name]` vereinfacht, öffnet genau hier.

**Bedingung 1 ist trotz Fall 1 nicht überflüssig.** Purity stoppt dort zwar zuerst, aber sie ruht auf
dem `~>` in der core-lib — einer Deklaration, keinem Beweis. Bedingung 1 ist der unabhängige,
strukturelle Riegel: im emittierten Slice steht kein JS-Text aus einer Nutzerdatei. Beide behalten.

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
Alles läuft in `describe('constant folding')` in
[checker.test.ts](../src/checker/checker.test.ts), gegen den dort vorhandenen Helfer
`typeOfLastDefinition(code)` — Code hinein, Typstring der letzten Definition heraus. Er prüft
nebenbei Fehlerfreiheit (`expect(parsed.checked?.errors).to.deep.equal([])`); Code mit erwarteten
Fehlern braucht also den ausgeschriebenen Weg wie der Test `Argumenttypfehler` in Region 5b. Neue
Fälle kommen in eine Region `5d Nutzerfunktionen` neben die bestehenden 5a/5b/5c.

**Die Schritte 1 und 2 ändern kein beobachtbares Verhalten** — Felder am Typ setzen, freie
Referenzen sammeln. Erst Schritt 3 faltet. Der rote Testsatz gehört deshalb nicht an jeden
Schritt, sondern **vor Schritt 1**: erst schreiben, roten Lauf zeigen, anhalten; dann 1 → 3 bauen,
bis er grün ist. Dazwischen tragen `npm run typecheck` und die unveränderte Suite.

### Roter Testsatz für die Schritte 1–3

```ts
// Eroeffnungsfall, zugleich Gegenprobe zur Faltbarkeitsregel: multiply ist eine nativeFunction,
// und double ist trotzdem faltbar - die Regel haengt am emittierten Slice, nicht am Aufrufgraphen.
it('Nutzerfunktion mit konstantem Argument faltet', () => {
	expect(typeOfLastDefinition(`double = (a: Integer) => a.multiply(2)
r = double(21)`)).to.equal('42');
});

it('freie Referenz auf eine Konstante wird in die Umgebung gebunden', () => {
	expect(typeOfLastDefinition(`factor = 3
triple = (a: Integer) => a.multiply(factor)
r = triple(7)`)).to.equal('21');
});

it('freie Referenz auf einen nicht konstanten Wert verhindert die Faltung', () => {
	expect(typeOfLastDefinition(`stamp = currentDate()
f = () => stamp
r = f()`)).to.equal('Date');
});

// Wortgleich zu jul-examples/fibonacci/fibonacci.jul, damit die Rekursion echt ist.
//
// OFFEN (Stand: Umsetzung Schritt 1-3, Diskussion mit dem Nutzer): dieser Test bleibt rot, aber
// nicht wegen constant folding selbst, sondern wegen einer Lücke in der bereits abgeschlossenen
// Purity-Inferenz (pure-inference-umsetzung.md), auf der dieser Plan aufbaut, ohne sie zu ändern.
//
// Der rekursive Aufruf `fibonacciHelper(...)` steht im ()-Branch, einer eigenen, verschachtelten
// Funktionsliteral-Closure. Die Selbstreferenz wird optimistisch als rein angenommen (E5), aber
// ihre ARGUMENTE `subtract(countdown 1)`, `add(current previous)`, `current` reichen Parameter der
// ÄUSSEREN Funktion durch. getArgumentPurity prüft für parameterReference-Argumente
// `argType.functionRef === ownFunctionType` - ownFunctionType ist hier die Funktion des Branches,
// nicht die äußere fibonacciHelper - die Parameter gelten also als "fremd" (E2) und damit pauschal
// als nicht beweisbar rein, unabhängig davon, dass sie hier nur als Werte weitergereicht (nicht
// aufgerufen) werden. Ergebnis: fibonacciHelpers Gesamt-Purity wird 'unknown' statt 'pure', und
// tryFoldCall verlangt zwingend 'pure' - Bedingung 3 (freie Referenzen) und der Auswerter selbst
// (tryBuildCallable/buildEnvironment) sind nicht betroffen; sie liefern nachweislich richtig (siehe
// den direkten tryBuildCallable-Test mit vorgegebenen Argumenten, der 55n liefert).
//
// Optionen, noch nicht entschieden:
// 1. Testcode ändern, z.B. Rekursion ohne verschachtelte Branch-Closure (kein branching), damit E2
//    nicht greift.
// 2. getArgumentPurity präzisieren: ein fremder Parameter, der nur als Wert weitergereicht (nicht
//    aufgerufen) wird, ist rein. Das wäre ein Eingriff in pure-inference-umsetzung.md, nicht in
//    diesen Plan - zu klären, ob das dort oder hier passiert.
// 3. Das Beispiel jul-examples/fibonacci/fibonacci.jul selbst prüfen: ist es von derselben Lücke
//    betroffen, oder unterscheidet es sich strukturell (z.B. keine Branches, sondern if-artige
//    Konstruktion) und der Test hier bildet es nicht korrekt nach?
it('Rekursion mit Abbruchbedingung faltet', () => {
	expect(typeOfLastDefinition(`fibonacciHelper = (
	countdown: Integer
	current: Integer
	previous: Integer
) =>
	?(countdown)
		[0] => previous
		() => fibonacciHelper(subtract(countdown 1) add(current previous) current)
r = fibonacciHelper(10 1 0)`)).to.equal('55');
});

it('Nutzerfunktion ohne konstantes Argument faltet nicht', () => {
	expect(typeOfLastDefinition(`double = (a: Integer) => a.multiply(2)
r = (x: Integer) => double(x)`)).to.equal('(x: Integer) -> Integer');
});

// Sicherheitsfall 3 aus "nativeFunction in Nutzercode": myFn behauptet -> (ungeprueft),
// f ist damit rein und enthaelt kein nativeFunction-Literal. Die Faltung wird also versucht
// und muss am Umgebungsaufbau scheitern. Die Literalform ist gegen den Parser zu pruefen.
it('eine per nativeFunction definierte Funktion wird nicht gefaltet', () => {
	expect(typeOfLastDefinition(`myFn = nativeFunction(
	(a: Integer) -> Integer
	§js
		(a) => a
	§
)
f = (a: Integer) => myFn(a)
r = f(21)`)).to.equal('Integer');
});

// Budget. Das Listen-Argument ist wesentlich: mit Dictionary-Argument liefe der Aufruf ueber
// _callFunction, und der Test waere auch mit einem Budget an der falschen Stelle gruen.
// Der erwartete Typ ist der ungefaltete Rueckgabetyp - aus dem roten Lauf ablesen.
it('nicht terminierende Rekursion faltet nicht und meldet nichts', () => {
	expect(typeOfLastDefinition(`spin = (n: Integer) => spin(add(n 1))
r = spin(0)`)).to.equal('Integer');
});
```

**Ein bestehender Test hält die Einschränkung fest, die hier fällt** — Region 5b, „faltet nicht bei
einer Nutzerfunktion (kein Runtime-Export unter dem Namen)":

```ts
expect(typeOfLastDefinition('f = (a: Integer b: Integer) -> Integer => addInteger(a b)\nr = f(2 3)'))
	.to.equal('Integer');   // wird zu '5'
```

Er ist mit Schritt 3 umzuschreiben und nach 5d zu verschieben. Wer ihn übersieht, sucht den Fehler
in der neuen Mechanik statt in der alten Erwartung.

### Schritt 1 — Rückverweis und Faltbarkeit am Typ

`CompileTimeFunctionType` bekommt `literal?: ParseFunctionLiteral` und `foldable?: boolean`, beide
optional, weil `functionTypeLiteral` keinen Rumpf hat. Gesetzt in `case 'functionLiteral'`, wo
`ParamsType` und `ReturnType` ohnehin nachgetragen werden.

`foldable` wird **beim Prüfen des Literals** berechnet, nicht beim Falten: Bedingung 2 braucht den
`filePath`, und den gibt es an einer Aufrufstelle in einer anderen Datei nicht mehr. Geprüft werden
hier nur Bedingung 1 und 2.

*Tests:* keine eigenen, siehe oben. Die Gegenprobe zur Faltbarkeitsregel steckt bereits im
roten Testsatz: `double` ruft `multiply` — eine `nativeFunction` — und faltet trotzdem. Der Fall
„Rumpf *enthält* ein `nativeFunction`-Literal" kommt mit Schritt 4 dazu, wo er beobachtbar wird.

### Schritt 2 — Freie Referenzen und Umgebung

Ein Sammler über den geprüften Rumpf liefert die freien Referenzen — ohne Parameter, ohne lokale
Definitionen. Je Referenz wird in dieser Reihenfolge gebunden:

1. Typ ist konstant (`typeToConstantValue`) → den Wert binden.
2. Typ ist ein Funktionstyp **mit `literal`** → Nutzerfunktion, rekursiv auflösen.
3. Runtime-Export mit `params` unter diesem Namen → den Export binden.
4. Sonst: keine Umgebung, also nicht gefaltet.

Ein eigenes `isBuiltIn` braucht es dafür nicht. Der Unterscheider ist `literal` aus Schritt 1: ein
Builtin entsteht aus `nativeFunction(...)`, also aus einer Signatur ohne Rumpf, und trägt deshalb
nie eines. Beim Umsetzen ist genau das zu bestätigen — trüge ein Builtin wider Erwarten ein
`literal`, griffe Regel 2 statt Regel 3.

Der Namensgriff in Regel 3 ist eindeutig, weil Überdeckung `alreadyDefinedInUpperScope` (JUL4003)
gegen *alle* oberen Scopes ist, Builtins eingeschlossen. Aus `builtInSymbols` ableiten ließe sich
dieselbe Auskunft zwar auch, aber nicht gefahrlos: die Konstante wird erst nach
`inferFileTypes(parsedCoreLib2, …)` zugewiesen, und währenddessen — beim Prüfen der core-lib
selbst — faltet der Checker bereits. Ein Zugriff von dort wäre ein `ReferenceError` beim
Modulladen.

Das Scope-Wissen hängt bereits am Baum: ein `ParseFunctionLiteral` trägt seine `symbols`
(`const ownSymbols = expression.symbols` in `case 'functionLiteral'`). „Frei" heißt also: nicht in
den `symbols` des Literals und kein Parameter, bei geschachtelten Literalen deren eigene `symbols`
mitgeführt. Der Walker ist derselbe Bautyp wie `inferBodyPurity` — ein Durchlauf über den bereits
geprüften Baum, ohne eigene Auflösung.

*Tests:* keine eigenen, siehe oben. Der rote Testsatz deckt freie Referenz auf ein Builtin
(`multiply`), auf eine Konstante (`factor`) und auf einen nicht konstanten Wert (`stamp`) ab. Zwei
Fälle fehlen dort und sind zu ergänzen, sobald Schritt 3 sie beobachtbar macht:

```ts
it('ein Parameter ist keine freie Referenz, auch bei gleichnamiger aeusserer Definition', () => {
	expect(typeOfLastDefinition(`factor = 99
f = (factor: Integer) => factor.multiply(2)
r = f(4)`)).to.equal('8');
});

it('eine lokale Definition ist keine freie Referenz', () => {
	expect(typeOfLastDefinition(`f = (a: Integer) =>
	step = 3
	a.multiply(step)
r = f(4)`)).to.equal('12');
});
```

Achtung beim ersten Fall: eine Definition `factor` und ein gleichnamiger Parameter sind
`JUL4003` — der Fall ist so also nicht schreibbar und der Test entsprechend anzupassen, sobald
das beim Schreiben auffällt. Die zweite Form (lokale Definition, dann Ergebnisausdruck) ist gegen
den Parser zu verifizieren, bevor sie als Baseline gilt.

### Schritt 3 — Der Auswerter, in `constant-folding.ts`

Aus Literal und Umgebung eine Bindungsliste emittieren, mit `new Function` instanziieren, über
`runtime._callFunction` aufrufen.

Er kommt in `constant-folding.ts` und nicht in eine eigene Datei, weil die Trennung einen Zyklus
erzeugte: Der Auswerter braucht `typeToConstantValue` und `constantValueToType`, und
`typeToConstantValue` braucht im Fall `function` (Schritt 4) den Auswerter. Im selben Modul ist das
gegenseitige Rekursion zweier Funktionen. Die Zusage im Kopfkommentar („ohne Abhängigkeit von
`checker.ts`") hält weiterhin, denn `emitter.ts` importiert den Checker nicht — der Kommentar ist
aber mitzuziehen, die Datei ist danach Übersetzung *und* Ausführung.

Die Umgebung kommt fertig aufgelöst aus Schritt 2 herein; der Auswerter schlägt nichts nach und
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

*Tests:* der rote Testsatz oben wird hier grün — das ist die Abnahme des Schritts. Dazu zwei
Fälle, die erst jetzt formulierbar sind:

```ts
it('Cache: derselbe Aufruf zweimal wird nur einmal ausgewertet', () => {
	// ueber den Zaehler im injizierten _createFunction-Wrapper zu pruefen, nicht ueber den Typ
});

it('das Budget ist global pro Check-Lauf, nicht je Aufrufstelle', () => {
	// viele kleine faltbare Aufrufe in einer Datei erschoepfen es gemeinsam
});
```

### Schritt 4 — `typeToConstantValue.case 'function'`

Der offene TODO in [constant-folding.ts](../src/checker/constant-folding.ts). Zweigeteilt: Builtin
→ Runtime-Export über das Symbol aus Schritt 1; Nutzerfunktion → Callable aus dem Auswerter. Damit
greift die HOF-Faltung.

*Tests:*

```ts
it('map mit Nutzer-Callback faltet', () => {
	expect(typeOfLastDefinition(`double = (a: Integer) => a.multiply(2)
r = map([1 2 3] double)`)).to.equal('[2 4 6]');
});

it('map mit nicht faltbarem Callback faltet nicht', () => {
	expect(typeOfLastDefinition(`stamp = currentDate()
tag = (a: Integer) => stamp
r = map([1 2] tag)`)).to.equal('[Date Date]');
});

it('toDictionary mit zwei Nutzer-Callbacks faltet', () => {
	// Erwartung aus dem roten Lauf ablesen; der Punkt ist, dass beide Callbacks
	// materialisiert werden muessen, nicht nur der erste.
});
```

Unverändert grün bleiben müssen `map([1 2] add)` aus Region 5a und `map([1 2] log)` aus 5b.

### Schritt 5 — Baselines und Messung

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

### Schritt 6 — Was den Plan überlebt

Vor dem Löschen dieses Dokuments umzuziehen, sonst geht es verloren:

- **Dass Bedingung 1 neben dem Purity-Gate stehen bleibt**, und warum: Purity ruht auf dem `~>` in
  der core-lib, Bedingung 1 ist der strukturelle Riegel. Ohne den Kommentar wird sie als doppelt
  gemoppelt gestrichen. Dazu die Kette `params` → registrierte Builtins → `JUL4003` an die Stelle,
  die den Runtime-Export nachschlägt.
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
3. Die drei Baselines neu geschrieben und die Differenz nach Schritt 5 durchgesehen.
4. Bench vor/nach in beiden Projekten protokolliert, Ziel `yugioh`.
5. Ein Beispiel aus `jul-examples` und `yugioh` gebaut und ausgeführt: keine neue Diagnose. Die
   Faltung erzeugt nur präzisere Typen, und die sind zuweisbar, wo die gröberen es waren.
6. Bedingung 1 der Faltbarkeitsregel gesondert durchgesehen, nicht nur betestet — an ihr hängt, ob
   das Öffnen einer fremden Datei Code ausführt. Keine Formsache: die Alternative, die diese
   Grenze vermieden hätte, ist verworfen.
7. Schritt 6 erledigt, erst dann dieses Dokument löschen.
