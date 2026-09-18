# Constant Folding für Nutzerfunktionen

Baut auf [pure-inference-umsetzung.md](pure-inference-umsetzung.md) auf, deren Abschnitt „Ausblick"
diese Stufe ankündigt und auf später verschiebt. Dort steht der Stand: Purity wird aus dem Rumpf
inferiert, die Argument-Regel greift bei Nutzerfunktionen, gefaltet wird aber weiterhin nur an der
core-lib-Grenze.

Diese Stufe faltet Aufrufe **nutzergeschriebener** Funktionen.

## Ziel

```
double = (a: Integer) => a.multiply(2)
r = double(21)           # heute: Integer,  Ziel: 42
s = map([1 2 3] double)  # heute: List(Integer),  Ziel: [2 4 6]
```

Beides scheitert heute an derselben Stelle: `tryFoldCall` führt nur JS aus, das als Export in
`runtime.ts` liegt. Jede Abstraktion über einer core-lib-Funktion ist eine Sackgasse für die
Faltung — dieselbe Sackgasse, die die Purity-Inferenz eine Stufe vorher für die Purity geöffnet hat.

## Die Struktur der Entscheidung

Die Frage zerfällt in zwei, die getrennt zu beantworten sind und in früheren Fassungen dieses
Plans vermischt waren:

1. **Wie trägt sich Wissen durch Nutzercode?** → Fernziel ist der Checker selbst (E1).
2. **Wer führt aus, wo Ausführung unvermeidbar ist?** → ein Blattdienst, gebaut über den
   Emitter (E2).

Die zweite ist unter beiden Antworten auf die erste nötig und wird deshalb zuerst gebaut. Die
Schritte 1–5 unten sind die zweite Frage; das Fernziel steht in „Fernziel: der Checker als
Evaluator" und ist ausdrücklich nicht Teil dieser Stufe.

## Abgrenzung

Nicht Teil dieser Stufe:

- **Kein spekulativer Zweitdurchlauf des Checkers.** Das ist das Fernziel, nicht dieser Schritt.
- **Keine Änderung am emittierten Code.** Gefaltet wird weiterhin nur der Typ (E7).
- **Keine Sandbox.** Die Ausführungsgrenze ist das Faltbarkeitsprädikat, nicht ein Worker (E4).
- **Keine Purity-Polymorphie**, keine Durchsetzung von Purity in der Zuweisbarkeit. Unverändert
  gegenüber der Vorstufe.

## Entscheidungen

### E1 — Fernziel ist der Checker als Evaluator, nicht ein zweiter Evaluator

In JUL leben Werte und Typen in einem Namensraum: `5` ist ein Typ, `Integer` ist ein Wert.
Auswerten und Inferieren sind hier näher beieinander als in den meisten Sprachen. Ein vollständiger
zweiter Evaluator neben dem Checker spaltete wieder auf, was der Sprachentwurf zusammengelegt hat —
Prinzip 3 (Einheitlichkeit) in [design-principles.md](design-principles.md), und dort speziell
„Keine Magie für Typen".

Der Mechanismus ist außerdem im Ansatz vorhanden: `traversePlaceholders` mit `ArgumentContext`
in [checker.ts](../src/checker/checker.ts) substituiert `parameterReference` bereits aus den
tatsächlichen Argumenten eines Aufrufs. Heute wirkt das auf den *deklarierten* Rückgabetyp; das
Fernziel lässt es auf den *Rumpf* wirken. Das ist die Ausweitung einer bestehenden Traversierung,
kein neuer Mechanismus.

Verworfen wurde ein eigener AST-Interpreter. Die Semantik von Branching, Destructuring,
Argumentbindung und Zahlenturm existiert bereits zweimal — als Werte in `runtime.ts` (`_branch`,
`assignArgs`, `_combineObject`), als Typen im Checker (`case 'branching'`, `areArgsAssignableTo`,
`getTypeError`). Beide müssen bleiben: die eine rechnet, die andere prüft. Ein Interpreter wäre die
**dritte** Fassung und könnte keine der beiden ablösen; jede Sprachänderung wäre ab dann an drei
Stellen nachzuziehen. Das ist der Zustand, in dem C++ und Rust stecken; Zig hat daraus den
umgekehrten Schluss gezogen und hält genau einen Evaluator.

Der Preis dieser Entscheidung steht in E4.

### E2 — Ausführung bleibt nötig, aber nur als Blattdienst

Der Checker rechnet nicht. `add(2 3)` faltet ausschließlich, weil `tryFoldCall` die Funktion aus
`runtime.ts` aufruft. An den Blättern bleibt Ausführung also unvermeidbar, auch unter dem Fernziel.

Die Lücke, die das Fernziel *nicht* schließt, sind die **Builtin-HOFs** — Funktionen höherer
Ordnung, die als `nativeFunction` in der core-lib stehen: `map`, `filter`, `filterMap`,
`findFirst`, `findLast`, `findLastIndex`, `forEach`, `toDictionary`, `aggregate`, `map$`. Ihr
Rumpf ist JS und für eine Typtraversierung undurchsichtig. `map` ([core-lib.jul](../src/core-lib.jul))
ruft darin `callback(value, BigInt(index + 1))` — ein echter JS-Aufruf. Ein `CompileTimeType` ist
nicht aufrufbar.

Um `map([1 2] double)` zu falten, braucht es deshalb ein **JS-Callable für `double`**. Für einen
Nutzer-HOF (`myMap = (values callback) => map(values callback)`) genügte später der Rumpfdurchlauf;
für den Builtin-HOF nicht.

**Entschieden:** Dieses Callable wird über den Emitter erzeugt — Funktionsliteral plus Umgebung
nach JS, `new Function`. Der Emitter ist damit die einzige Semantikquelle für Ausführung;
Compile-Zeit- und Laufzeitergebnis können nicht auseinanderlaufen.

### E3 — Die Umgebung wird aus Typen gebaut, nicht durch Ausführen des Moduls

`referenceToJs` in [emitter.ts](../src/emitter.ts) emittiert einen nackten Bezeichner. Ein
Funktionsliteral ist also nur im Modul-Scope lauffähig, in dem `syntaxTreeToJs` es platziert.

Der naheliegende Ausweg — das ganze Modul instanziieren — scheidet aus: JUL-Dateien haben
ausführbaren Top-Level. Ein Modul zu laden führte dessen Ausdrücke aus, potenziell `log`, Streams,
HTTP, und zwar beim Tippen.

**Entschieden:** Die Umgebung wird aus den bereits inferierten Typen gebaut. Für jede freie
Referenz im Rumpf: Typ → `typeToConstantValue` → als `const` in den Slice binden. Scheitert eine,
wird nicht gefaltet.

```
x = log(1)
f = () => x.add(1)
```

`f` aufzurufen heißt nicht, `x` auszuwerten — es heißt, den *Wert* von `x` zu brauchen. Der steht
als Typ da oder er steht nicht da. Hier steht er nicht (`log` faltet nicht), also faltet `f()`
nicht. Kein Top-Level läuft, keine zusätzliche Purity-Regel für Definitionen wird gebraucht, und
das Verhalten degradiert von selbst, statt eine statische Klassifikation zu verlangen.

### E4 — Faltbarkeit ist eine lokale Eigenschaft des Rumpfs, und sie ist die Sicherheitsgrenze

Faltbar ist ein Funktionsliteral, dessen Rumpf transitiv kein `nativeFunction` und kein
`nativeValue` enthält und das nicht aus einer `.ts`/`.js`-Datei stammt. Die zweite Bedingung ist
dieselbe Ausnahme wie E6 der Vorstufe, aus demselben Grund.

Das ist keine Verfeinerung der Purity, sondern ein eigener Begriff. Purity sagt „dieser Aufruf hat
keine Wirkung"; Faltbarkeit sagt „diesen Rumpf dürfen wir ausführen". Ein `->` an einer
nutzereigenen `nativeFunction`, die `runJs` kapselt, ist rein *und* nicht faltbar.

**Der akzeptierte Preis:** Bis heute ist die Menge der zur Prüfzeit ausgeführten Funktionen
kuratiert — nur Exporte aus `runtime.ts`. Mit dieser Stufe wird erstmals *emittierter Nutzercode*
zur Prüfzeit ausgeführt, und der Language Server prüft beim Öffnen einer Datei, ungefragt. Eine
Lücke im Faltbarkeitsprädikat ist damit Codeausführung beim Öffnen einer fremden `.jul`-Datei — eine
bekannte Schwachstellenklasse bei Editor-Erweiterungen, die es hier heute nicht gibt.

Ein Interpreter hätte diese Klasse vermieden (er schlägt nach innen fehl, der Emit-Weg nach außen).
E1 wiegt schwerer. Die Milderung, falls sie je nötig wird, ist ein Worker ohne `import`/`require`
mit eingefrorenen Globals und Zeitlimit — additiv erreichbar, kostet Latenz je Aufruf und wird
deshalb erst gebaut, wenn das Prädikat sich als zu schwach erweist. Das Prädikat ist die Stelle,
die Prüfung und Sorgfalt verdient; alles andere hängt daran.

### E5 — Aufgelöst wird über das Symbol, nicht über den Namen

`tryFoldCall` sucht die auszuführende Funktion heute über `runtime[escapeReservedJsVariableName(name)]`.
Deshalb faltet

```
add = (a: Integer b: Integer) -> Integer => 99
r = add(2 3)
```

zu `r: 5`. Als Altlast war das vertretbar — `JUL4003` meldet die Überdeckung, und gefaltet wird nur
ein Typ. Sobald Nutzerfunktionen ausgeführt werden, ist es ein Korrektheitsfehler: entschieden wird
dann über den Namen, welcher Code läuft. `dereferenceType` liefert bereits ein `isBuiltIn`.

Vorbedingung für alles Weitere, nicht Aufräumarbeit nebenbei.

### E6 — Rekursion über Selbstbindung, Termination über ein globales Budget

Eine Selbstreferenz liefert `builtinAny` (E5 der Vorstufe), also keinen konstanten Wert — über die
Umgebung aus E3 ist sie nicht auflösbar. Sie wird stattdessen beim Emit an die gerade gebaute
Closure gebunden. Der Slice ist deshalb eine Bindungsliste, kein einzelner Ausdruck.

Damit ist Nichttermination möglich. JUL hat keine Schleifen; Nichttermination braucht Rekursion.
Ein Zähler, der im emittierten Prolog jeder Funktion dekrementiert, genügt also — keine
Schleifeninstrumentierung.

Das Budget ist **global pro Check-Lauf**, nicht pro Aufrufstelle. Sonst sind 500 Aufrufe à 10⁴
Schritte einzeln unauffällig und zusammen eine Sekunde pro Tastendruck.

**Ein erschöpftes Budget erzeugt keine Diagnose**, sondern nur „nicht gefaltet". `->` sagt „rein",
nicht „terminiert"; die Vorstufe hält in E5 ausdrücklich fest, dass Nichttermination nicht als
Effekt zählt. Eine Fehlermeldung hinge sonst an einer Implementierungszahl.

Der Ergebnis-Cache über `(CompileTimeFunctionType, Argumentschlüssel)` ist aus demselben Grund
nicht nur Beschleunigung: ohne ihn ist schon `fib` exponentiell und verbrennt das Budget an einem
einzigen Aufruf.

### E7 — Gefaltet wird weiterhin nur der Typ

Der emittierte Code bleibt unverändert; das Ergebnis der Faltung ist ausschließlich ein präziserer
Typ. Unverändert gegenüber dem Bestand, und hier bewusst beibehalten: eine falsche Faltung erzeugt
dann eine Falschdiagnose, aber kein falsches Programm. Den Wert in den Emitter durchzureichen ist
additiv möglich, sobald die Faltung sich als stabil erwiesen hat.

## Geprüfte Voraussetzungen

Fünf Punkte, an denen der Plan hätte kippen können:

- **Der Checker rechnet nicht.** `tryFoldCall` ist die einzige Stelle, an der ein Wert entsteht.
  Ausführung an den Blättern bleibt deshalb auch unter dem Fernziel nötig (E2).
- **Die Substitution existiert bereits** (`traversePlaceholders`/`ArgumentContext`). Das Fernziel
  ist eine Ausweitung, keine Neuentwicklung (E1).
- **`referenceToJs` emittiert nackte Bezeichner.** Ein isoliertes Literal ist nicht lauffähig; die
  Umgebung muss gebaut werden (E3).
- **Vorwärtsreferenzen sind `JUL4002`.** Jede freie Referenz ist beim Falten bereits geprüft, ihr
  Typ steht fest. Es gibt kein Reihenfolgeproblem zu lösen.
- **Der Checker mutiert den Baum** (`typeInfo` je Knoten). Das ist der Hauptposten des Fernziels
  und berührt diese Stufe nicht — der Blattdienst liest nur.

## Schritte

### Schritt 1 — Auflösung über das Symbol

`tryFoldCall` bekommt das aufgelöste Symbol statt des Namens; `isBuiltIn` entscheidet, ob der
Runtime-Export überhaupt gemeint ist. E5.

*Tests:* der Überdeckungsfall oben faltet nicht mehr; die bestehenden Builtin-Faltungen unverändert.

### Schritt 2 — Rückverweis und Faltbarkeitsprädikat

`CompileTimeFunctionType` bekommt ein optionales `literal?: ParseFunctionLiteral` — optional, weil
`functionTypeLiteral` keinen Rumpf hat. Gesetzt wird es in `case 'functionLiteral'`, dort, wo
`ParamsType` und `ReturnType` ohnehin nachgetragen werden.

Dazu `isFoldableImplementation(literal, filePath)` nach E4: kein `nativeFunction`, kein
`nativeValue`, keine `.ts`/`.js`-Herkunft, transitiv über den Rumpf.

*Tests:* je ein positiver und negativer Fall pro Bedingung; besonders der transitive Fall (eine
Funktion, die eine `nativeFunction` aufruft, ist nicht faltbar).

### Schritt 3 — Freie Referenzen und Umgebung

Ein Sammler über den geprüften Rumpf, der die freien Referenzen liefert — scope-bewusst, also ohne
Parameter und ohne lokale Definitionen. Je Referenz: `typeInfo.type` → `typeToConstantValue`.
Scheitert eine, ist das Ergebnis „keine Umgebung" und damit „nicht gefaltet". E3.

*Tests:* Rumpf ohne freie Referenzen; freie Referenz auf eine Konstante; freie Referenz auf einen
nicht faltbaren Wert (`x = log(1)`); Abschattung durch einen Parameter; Abschattung durch eine
lokale Definition.

### Schritt 4 — Slice-Emit und Ausführung

Aus Literal und Umgebung eine Bindungsliste emittieren, mit `new Function` instanziieren, über
`runtime._callFunction` aufrufen. Selbstbindung nach E6, Budget im Prolog, Cache über
`(CompileTimeFunctionType, Argumentschlüssel)`.

Der Zähler ist der einzige Punkt, an dem der Emit vom Produktionscode abweicht. Er gehört deshalb
in eine klar benannte Option von `syntaxTreeToJs`, nicht in eine Kopie des Emitters.

*Tests:* `double(21)` faltet zu `42`; eine rekursive Funktion mit Abbruchbedingung faltet; eine
nicht terminierende Funktion faltet **nicht** und meldet **nichts**; Cache-Treffer bei doppeltem
Aufruf; Budget global, nicht je Aufrufstelle.

### Schritt 5 — `typeToConstantValue.case 'function'`

Der offene TODO in [constant-folding.ts](../src/checker/constant-folding.ts). Zweigeteilt: Builtin
→ Runtime-Export über das Symbol aus Schritt 1; Nutzerfunktion → das Callable aus Schritt 4.

Damit greift die HOF-Faltung: `map([1 2 3] double)`.

*Tests:* `map` mit Builtin-Callback (faltet heute schon, darf nicht brechen); `map` mit
Nutzer-Callback; `map` mit nicht faltbarem Callback (faltet nicht); `toDictionary` mit zwei
Callbacks; ein Callback, der über die Umgebung auf eine Konstante zugreift.

### Schritt 6 — Baselines und Messung

Erwartete Änderungen, jede einzeln durchzusehen statt zu übernehmen:

- `checker-snapshot.baseline.txt`: deutlich mehr Literaltypen, überall dort, wo bisher `Integer`
  oder `List(Integer)` stand.
- `checker-stats.baseline.txt`: `foldableCall` steigt. Das ist der Zweck der Übung; die Frage an
  die Differenz ist, ob die Zunahme dort auftritt, wo sie erwartet wird.
- `jul-language-server/scripts/snapshot.baseline.txt` nach `npm run build-all`.

Bench in beiden Projekten **vor und nach** dem Umbau, jeweils mit `--save --note`. Der Blattdienst
ist der erste Mechanismus im Checker, dessen Kosten nicht an der Baumgröße hängen, sondern an der
Zahl faltbarer Aufrufstellen — eine Messung an `jul-examples` allein trägt hier nicht, `yugioh` ist
das maßgebliche Ziel.

## Fernziel: der Checker als Evaluator

Nicht Teil dieser Stufe. Festgehalten, damit die Schritte 1–5 als das gebaut werden, was sie sind:
Vorarbeit, die unter beiden Zielen gebraucht wird.

Der Gedanke: statt einen Rumpf auszuführen, ihn mit den Argumenttypen als Parametertypen **erneut
prüfen**. Ein Literaltyp ist bereits ein Wert; `setInferredType` faltet Builtins dabei von selbst,
Branching wählt über Typen den Zweig. Konstantenfaltung ist dann der Spezialfall „alle Eingaben
sind Literale", und der allgemeine Fall liefert Präzision auch bei *teilweise* bekannten
Argumenten — `double(x: Positive)` → `Positive`, wo der Blattdienst nichts liefert.

Was vorher zu klären ist:

- **Ein schreibfreier Modus.** Der Checker schreibt `typeInfo` in die Knoten; eine spekulative
  Zweitprüfung überschriebe, was der Language Server für Hover und Completion liest, und was
  `inferBodyPurity` liest. Mechanisch ist das ein weiterer durchgereichter Parameter in einer
  Signatur, die ohnehin sechs durchreicht — aber er berührt jeden Fall im Checker.
- **Eine Fehlersenke.** Eine spekulative Prüfung darf nicht in `file.errors` schreiben.
- **Widening.** Unter dem Blattdienst genügt ein Schrittbudget; unter dem Fernziel wächst bei
  Rekursion eine Union, und ohne Widening-Operator terminiert die Analyse nicht. Bekannte
  abstrakte Interpretation, und eine bekannte Quelle subtiler Endlosläufe.
- **Memoisierung über Typen statt über Konstanten.** Größerer Schlüsselraum, teurere Treffer,
  teurere Fehlschläge — der Posten, an dem sich das Fernziel messen lassen muss.

Der Blattdienst bleibt unter dem Fernziel bestehen, in genau der Rolle aus E2: Builtin-HOFs sind
für eine Typtraversierung undurchsichtig, ihr Callback muss ein Callable sein.

## Verworfene Wege

- **Symbolische Substitution statt Ausführung** — Rümpfe aus einem einzigen Ausdruck an der
  Aufrufstelle durch diesen Ausdruck ersetzen. Braucht weder Budget noch `eval` und wäre der
  kleinste Schritt, ist aber kein Teilstück von irgendetwas: mit dem Blattdienst wird sie
  vollständig überdeckt, mit dem Fernziel ebenso. Ihr einziger eigener Beitrag — Präzision bei
  nicht-konstanten Argumenten — ist genau das, was das Fernziel allgemein liefert.
- **Eigener AST-Interpreter** — siehe E1. Die dritte Semantikfassung, die keine der beiden anderen
  ablösen kann. Sein einziger sachlicher Vorteil, das Fehlschlagen nach innen (E4), wiegt das nicht
  auf; die Milderung dafür ist additiv nachrüstbar, ein dritter Evaluator ist es nicht.
- **Modul instanziieren statt Umgebung bauen** — siehe E3. Führt Top-Level-Code beim Tippen aus.

## Bewusst offen gelassen

- **Die Argument-Regel fordert weiterhin zu viel** (Reinheit *aller* Funktionsargumente, auch der
  nie aufgerufenen). Unverändert aus der Vorstufe.
- **Keine Sandbox.** E4, mit benannter Milderung.
- **Der Wert bleibt im Typ** (E7). Der Emitter profitiert noch nicht.
- **Kein Widening**, weil es ohne das Fernziel nicht gebraucht wird.

## Abnahme

1. `npm test` in `jul-compiler` und `jul-language-server` grün.
2. `npm run typecheck` in beiden.
3. Die drei Baselines neu geschrieben und die Differenz nach Schritt 6 durchgesehen — insbesondere,
   dass `foldableCall` dort steigt, wo Nutzerfunktionen aufgerufen werden, und nicht anderswo.
4. Bench vor/nach in beiden Projekten protokolliert, Ziel `yugioh`.
5. Ein Beispiel aus `jul-examples` und `yugioh` gebaut und ausgeführt: die Faltung darf keine neue
   Diagnose erzeugen. Sie erzeugt nur präzisere Typen, und präzisere Typen sind zuweisbar, wo die
   gröberen es waren.
6. Das Faltbarkeitsprädikat (E4) gesondert durchgesehen, nicht nur betestet. Es ist die
   Sicherheitsgrenze; an ihm hängt, ob das Öffnen einer fremden Datei Code ausführt.
