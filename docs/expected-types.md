# Umsetzungsplan: Erwarteter Typ je Ausdruck

## Ziel

Der Checker reicht beim Prüfen den erwarteten Typ von der Stelle, die ihn festlegt, abwärts an
die geschriebenen Ausdrücke weiter und merkt ihn sich dort. Andere Sprachen nennen das
kontextuelle oder bidirektionale Typprüfung (TypeScript: contextual type).

Der unmittelbare Nutzen ist eine Lücke in der Typprüfung: Ein Funktionsliteral bekommt die Typen
seiner untypisierten Parameter heute nur als direktes Argument eines Aufrufs aus dem Kontext.
Überall sonst bleiben sie `Any`, damit wird der Rückgabetyp `Any`, und die Prüfung gegen den
Zieltyp läuft ins Leere:

| Code | heute |
|---|---|
| `g((x) => x)` mit `g = (cb: (x: Integer) :> Text) => …` | JUL5050, richtig |
| `f: (x: Integer) :> Text = (x) => x` | keine Meldung |
| `h: [cb: (x: Integer) :> Text] = [cb = (x) => x]` | keine Meldung |
| `g([cb = (x) => x])` mit `g = (o: [cb: (x: Integer) :> Text]) => …` | keine Meldung |
| `l: List((x: Integer) :> Text) = [(x) => x]` | keine Meldung |

Richtig wäre in allen fünf Fällen „Can not assign Integer to Text“.

Weitere Nutzer desselben Werts, jeweils in eigenen Schritten:

- Feldreferenzen an kontextuell typisierten Stellen, siehe
  [field-references.md](field-references.md)
- `getDeclaredType` im Language Server liest den Wert ab, statt ihn aufwärts zu rekonstruieren
- die genauere Fehlerposition (`findInnermostErrorPosition`, `findArgumentErrorPosition`)

**Nicht in diesem Plan:** Literale anhand des erwarteten Typs verbreitern oder verengen. Außer den
Parametern untypisierter Funktionsliterale ändert der erwartete Typ an keinem inferierten Typ
etwas. Die Regel „Die Zuweisung schneidet nichts weg, das Symbol behält den Typ des Werts“ bleibt.

## Ausgangslage

Heute ordnen fünf Stellen geschriebene Ausdrücke einem Zieltyp zu, jede auf ihre Art:

| Stelle | Richtung | Kollektionen | Spread | Union als Ziel |
|---|---|---|---|---|
| `inferredTypeFromCall` (checker) | Argumente gegen Parameter, vor dem Inferieren gesetzt | nur positional | ignoriert, TODO | nein |
| `findInnermostErrorPosition` samt Feld/Element-Variante (checker) | abwärts, nur fehlerhafte Pfade | Dictionary gegen Felder und `Dictionary(X)`, Liste gegen Tuple und `List(X)` | Liste: Abbruch; Dictionary: sucht nach Name | kein Abstieg |
| `findArgumentErrorPosition` (checker) | Argumente gegen Parameter | positional und benannt, Präfix-Argument | Abbruch | benannt über `dereferenceNameFromObject` |
| `getWrittenArguments` / `getBranchArgumentType` (checker, Branching) | Argumente gegen Branch-Köpfe | nur positional | Abbruch | ja |
| `getDeclaredType` (Language Server, `util.ts`) | aufwärts, vom Ausdruck zum Elternteil | Typguard, Argument (Index über die Cursorposition), Listenelement, Dictionary-Feld, Präfix-Argument, Funktionsparameter | nicht berücksichtigt, Index nach Spread falsch | über `dereferenceNameFromObject` |

Die Branching-Zuordnung bleibt außen vor: Branch-Köpfe sind Muster, keine Deklaration.

`inferredTypeFromCall` im Detail: Der Fall `functionCall` setzt vor dem Inferieren der Argumente
an jedem Parameter eines Funktionsliteral-Arguments den Parametertyp des aufgerufenen Parameters
(Index-gleich, ohne Namen, ohne Rest). Der Fall `parameter` löst ihn generisch auf
(`dereferenceArgumentTypesNested`), aber nur, wenn die Elternkette genau
`functionLiteral` → `list` → `functionCall` ist. Dafür baut er aus den schon inferierten
vorherigen Argumenten einen vorläufigen `argsType`. Ein geschriebener Typguard am Parameter geht
vor, der Kontext füllt nur untypisierte Parameter.

Reihenfolge heute, die für den erwarteten Typ umgestellt werden muss:

- **Definition:** Der Wert wird vor dem Typguard inferiert. Der Typguard muss zuerst.
- **Funktionsliteral:** Der Rumpf wird vor dem deklarierten Rückgabetyp inferiert. Der
  Rückgabetyp muss nach den Parametern, aber vor dem Rumpf inferiert werden.

## Entscheidungen

### 1. Wie kommt der erwartete Typ zum Ausdruck? — entschieden: explizites Argument

`setInferredType` bekommt den erwarteten Typ als **Pflichtparameter**
(`CompileTimeType | undefined`, nicht optional), damit der Compiler alle Aufrufstellen zeigt und
jede ausdrücklich entscheidet, was sie weitergibt. So erwarten auch rustc
(`check_expr_with_expectation`), GHC (`Check` gegen `Infer`), Scala (`pt`, der „prototype“) und
Kotlin den Typ, und es ist dieselbe Entscheidung wie für die Umgebung beim Pfad-Narrowing (siehe
[narrowing-path-facts.md](narrowing-path-facts.md), Entscheidung 1).

Zusätzlich wird er am Ausdruck gemerkt (Feld `expectedType` neben `typeInfo`), nur als Ergebnis
zum Nachlesen für spätere Nutzer, nie als Eingabe. Nicht an `TypeInfo`: Diese Objekte werden
geteilt, eine Definition übernimmt das ihres Werts, Symbole ebenso. Ein erwarteter Typ daran
schlüge auf andere Ausdrücke durch. Veralten kann das Feld nicht: Wo derselbe Baum erneut geprüft
wird (Language Server, `cloneUnchecked: true`), arbeitet jeder Lauf auf einem frischen Klon. Die
CLI prüft jede Datei nur einmal und beschriftet den Baum direkt.
`inferredTypeFromCall` entfällt.

Verworfen:

- **Feld am Ausdruck, vor dem Inferieren gesetzt** (so arbeitet `inferredTypeFromCall` heute):
  Die Reihenfolge „erst setzen, dann inferieren“ hängt an jeder Stelle von Hand. Außerdem prüft
  `recheckDependents` dasselbe `ParsedFile` erneut, ohne neu zu parsen. Eine Stelle, die im
  zweiten Lauf nichts mehr setzt, hinterlässt den alten Wert.
- **Im `TypeContext`:** Der Kontext gilt für einen ganzen Teilbaum, der erwartete Typ nur für
  genau einen Ausdruck. Er würde an Kinder durchsickern, für die er nicht gilt.
- **Bei Bedarf aufwärts abfragen** wie TypeScripts `getContextualType`: passt zu einem lazy
  Checker, nicht zu JULs eifrigem Durchlauf von oben nach unten. Es wäre ein zweiter Weg durch
  dieselbe Struktur, und `getDeclaredType` zeigt, wie der in JUL altert.

### 2. Was wird gemerkt? — entschieden: instanziiert, nicht aufgelöst

Ein Typ durchläuft drei Stufen, am Beispiel `values.map((x) => …)` mit `values: List(Integer)`:

| Stufe | Typ von `x` | entsteht durch |
|---|---|---|
| roh | `TypeOf(values)/ElementType`, Platzhalter auf den Parameter `values` von `map` | Signatur in der core-lib |
| instanziiert | `Integer` | `dereferenceArgumentTypesNested` mit den Argumenten dieses Aufrufs |
| über die Deklaration aufgelöst | `Any` | `resolvePlaceholders`, fragt die Deklaration von `values` statt des Aufrufs |

Die Aufrufstelle instanziiert mit ihren Argumenten und reicht das Ergebnis durch. Genau das wird
am Ausdruck gemerkt, ohne `resolvePlaceholders`. Was danach noch Platzhalter ist, etwa ein
Verweis auf einen Parameter der umgebenden Funktion, bleibt roh. Leser lösen beim Nachschlagen
und Anzeigen selbst auf, wie beim inferierten Typ, der auch roh gespeichert wird.

Begründung:

- Eine aufgelöste Kopie wäre eine Momentaufnahme. Ein Funktionstyp wird mit leeren Parametern und
  leerem Rückgabetyp erzeugt und erst danach befüllt. Der rohe Verweis bekommt das mit, die Kopie
  nicht (vgl. TODO „cache für resolvePlaceholders“).
- `resolvePlaceholders` an jedem Ausdruck wäre teuer: In yugioh sind es schon heute rund
  0,9 Mio. Aufrufe, bei 0,27 Mio. inferierten Ausdrücken (Messung vom 2026-09-24).
- Roh durchreichen und den Leser instanziieren lassen geht nicht: Der Leser kennt den Aufruf
  nicht mehr. Daran krankt `inferredTypeFromCall`, das deshalb die Elternkette hochklettert.

So machen es auch andere: TypeScript hält den kontextuellen Typ mit Typparametern, instanziiert
mit dem Inferenzkontext des Aufrufs und löst Typparameter erst beim Member-Zugriff über ihre
Schranke auf (`getApparentType`). rustc trägt Inferenzvariablen durch, löst beim Lesen auf und
schreibt erst am Ende der Funktion endgültig zurück („writeback“). GHC arbeitet mit Löchern
(`ExpType`), die später gefüllt werden.

**Argumentreihenfolge bleibt wie heute:** Instanziiert wird mit den schon inferierten
vorherigen Argumenten und dem Präfix-Argument. Steht ein Callback vor dem Argument, aus dem sein
Typ kommt, bleibt der Platzhalter unaufgelöst. Folgeschritt: zwei Durchgänge wie in TypeScript,
das kontextabhängige Argumente (Funktionsliterale mit untypisierten Parametern) zurückstellt und
nach den übrigen prüft.

### 3. Union als erwarteter Typ — entschieden: nur aussortieren

Heute bekommt nicht einmal der optionale Callback als direktes Argument einen Parametertyp:
`g = (cb: Or([] (x: Integer) :> Text)) => 1` mit `g((x) => x)` meldet nichts, weil
`inferredTypeFromCall` nur greift, wenn der Parametertyp selbst ein Funktionstyp ist.

Drei Arten von Unions:

```jul
# 1. Funktion oder etwas anderes
cb: Or([] (x: Integer) :> Text)
# 2. mehrere Funktionstypen
cb: Or((x: Integer) :> Text  (x: Text) :> Text)
# 3. diskriminierte Union von Dictionaries
h: Or([kind: §a§ cb: (x: Integer) :> Text]  [kind: §b§ cb: (x: Text) :> Text])
h = [kind = §a§ cb = (x) => …]
```

Umgesetzt wird nur das Aussortieren von Zweigen, die nicht passen können:

- Für ein Funktionsliteral fallen alle Zweige weg, die keine Funktion sind.
- Für ein Dictionary-Literal fallen alle Zweige weg, denen die übrigen, schon inferierten Felder
  widersprechen. In Fall 3 passt `kind = §a§` nur zum ersten Zweig.

Bleibt genau ein Zweig, ist er der erwartete Typ. Das deckt Fall 1 und 3 ab. Bleiben mehrere,
gibt es keinen erwarteten Typ, der Parameter bleibt `Any` wie heute. So sortiert auch
TypeScript aus (`getContextualSignature` filtert auf Typen mit Signatur,
`discriminateContextualTypeByObjectMembers` verengt diskriminierte Unions).

Für Fall 2 zurückgestellt, jeweils als möglicher Ausbau:

- **Nur bei gleichen Parametertypen:** Unterscheiden sich die Zweige nur im Rückgabetyp, gelten
  die gemeinsamen Parametertypen. So verhält sich TypeScript meines Wissens, und es erzeugt keine
  Falschfehler.
- **Vereinigung je Position** (`x: Or(Integer Text)`): formal sicher, erzeugt aber
  Falschfehler. Bei `Or((e: MouseEvent) ~> []  (e: KeyEvent) ~> [])` mit
  `(e) => log(e/clientX)` meldet `e/clientX` einen Fehler, obwohl der Code für den
  Maus-Zweig richtig ist.
- **Rumpf gegen jeden Zweig prüfen** wie Roslyn bei der Überladungsauflösung: am genauesten, aber
  mehrfache Prüfung mit exponentiellem Wachstum bei Verschachtelung, und eine Fehlersenke für die
  Fehlversuche, die es noch nicht gibt.
- **Warnung statt Stille** wie TypeScripts `noImplicitAny`: Ein Funktionsliteral an einer
  typisierten Stelle ohne eindeutigen Parametertyp bekommt den Hinweis, den Parameter zu
  annotieren.

### 4. Wo wird er berechnet und gemerkt? — entschieden: überall, wo es billig ist

Für die Typprüfung braucht nur das Funktionsliteral ihn. Feldreferenzen und `getDeclaredType`
brauchen ihn aber an jedem Dictionary-Feld, Listenelement und Argument. Das Merken kostet einen
Verweis je Ausdruck. Was kostet, ist das Berechnen für die Kinder, und das ist nach Frage 1 ohnehin
nötig, damit ein tief verschachteltes Funktionsliteral seinen Typ bekommt.

- Durchgereicht und gemerkt wird überall, wo es billig ist: Argumente, `List(X)` (jedes Element
  bekommt dasselbe `X`), Tuple-Positionen und Felder eines Dictionary-Typs.
- `Any` zählt wie kein erwarteter Typ. Er wird weder durchgereicht noch gemerkt, das spart die
  Arbeit unter den vielen `Any`-Parametern der core-lib.
- Das Aussortieren bei Unions (Frage 3) braucht `getTypeError` und passiert erst dort, wo ein Kind
  einen eindeutigen Zweig verlangt: ein Funktionsliteral oder die Verknüpfung der Feldreferenzen.
  Gemerkt wird bis dahin die ganze Union. Dafür gibt es eine Hilfsfunktion, damit Leser nicht
  selbst aussortieren.

Vorbild ist Roslyn: `TypeInfo.Type` ist der eigene Typ eines Ausdrucks, `TypeInfo.ConvertedType`
der, in den er an dieser Stelle umgewandelt wird. Die IDE-Funktionen lesen beides.

Fällt das Aussortieren in der Messung nicht auf, lässt es sich vereinfachen und überall sofort
erledigen.

### 5. Neue Meldungen in bestehendem Code — entschieden: direkt als Fehler

Callbacks, deren Parameter bisher stumm `Any` waren, bekommen einen echten Typ, ihr Rumpf wird zum
ersten Mal geprüft. Die neuen Meldungen sind ganz normale `returnTypeMismatch`,
`definitionTypeMismatch` oder Folgefehler im Rumpf, ohne Schalter und ohne Übergangsphase als
Warnung.

Eine Warnphase wie bei Rust-Lints oder ein Schalter wie TypeScripts `strict` setzen voraus, dass
die neue Meldung eine eigene Identität hat. Hier entsteht keine neue Meldung, sondern eine
genauere Inferenz löst bestehende Meldungen häufiger aus. Der Checker wüsste nicht, welcher Fehler
„nur wegen des erwarteten Typs“ entstanden ist. In diesem Fall landen auch bei TypeScript
Verbesserungen direkt.

yugioh wird **später** bereinigt, nicht als Teil dieses Plans. Bis dahin gilt:

- Nicht installieren (`build-all-and-deploy`, `install-cli`), solange yugioh nicht bereinigt ist.
  yugioh hängt ungepinnt am globalen Compiler, und die CLI emittiert nichts, sobald ein Fehler
  steht.
- Bei der Bereinigung jede neue Meldung einzeln bewerten: echter Fund (in yugioh beheben) oder
  Falschfehler (roter Test und Fix im Checker), Vorgehen wie in
  [CHECKER-AUDIT.md](CHECKER-AUDIT.md).

## Schritte

### 1. Vorher-Messung

Compiler-Bench mit `--save`. Anders als bei den Feldreferenzen betrifft der Umbau auch die CLI.

### 2. Rote Tests

In `checker.test.ts`, tabellengetrieben, mit vollständigem `errors`-Objekt:

| Test | Code | erwartet |
|---|---|---|
| Definition mit Funktionstyp | `f: (x: Integer) :> Text = (x) => x` | rot |
| Dictionary-Feld hinter Typguard | `h: [cb: (x: Integer) :> Text] = [cb = (x) => x]` | rot |
| Dictionary-Argument | `g([cb = (x) => x])` mit `g = (o: [cb: (x: Integer) :> Text]) => …` | rot |
| Listenelement | `l: List((x: Integer) :> Text) = [(x) => x]` | rot |
| benanntes Argument | `g(cb = (x) => x)` mit `g = (cb: (x: Integer) :> Text) => …` | rot |
| Rückgabewert | `k = () :> (x: Integer) :> Text => (x) => x` | rot |
| verschachtelt | `[outer = [cb = (x) => x]]` gegen `[outer: [cb: (x: Integer) :> Text]]` | rot |
| Platzhalter der umgebenden Funktion | `f = (values: List(Integer)) =>` mit einem inneren Aufruf, dessen Callback-Typ `TypeOf(values)/ElementType` nennt, siehe Frage 2 | rot, Code wird im Schritt ausgearbeitet |
| optionaler Callback als Argument | `g((x) => x)` mit `g = (cb: Or([] (x: Integer) :> Text)) => …` | rot |
| optionaler Callback hinter Typguard | `f: Or([] (x: Integer) :> Text) = (x) => x` | rot |
| diskriminierte Union | `h: Or([kind: §a§ cb: (x: Integer) :> Text]  [kind: §b§ cb: (x: Text) :> Text]) = [kind = §a§ cb = (x) => x]` | rot |

Gegenproben, die grün sein und bleiben müssen:

- Ohne Kontext bleibt es `Any`: `f = (x) => x` meldet nichts.
- Mehrere Funktionszweige bleiben ohne erwarteten Typ (Frage 3):
  `g = (cb: Or((x: Integer) :> Text  (x: Text) :> Text)) => …` mit `g((x) => x)` meldet nichts.
- Ein geschriebener Typguard geht vor: `f: (x: Integer) :> Text = (x: Text) => x` meldet die
  Kontravarianz, nicht den Rückgabetyp.
- Das direkte Argument verhält sich wie bisher, inklusive der generischen Fälle (`values.map((x)
  => …)`). Die bestehenden Tests decken das ab.

Rote Tests laufen lassen, den Output zeigen, anhalten.

### 3. Reihenfolge umstellen

Definition: Typguard vor dem Wert. Funktionsliteral: Rückgabetyp nach den Parametern, vor dem
Rumpf. Noch ohne erwarteten Typ. Checker-Snapshot und Zähler-Baseline müssen unverändert bleiben,
sonst hängt etwas an der alten Reihenfolge.

### 4. Erwarteten Typ durchreichen

`setInferredType` bekommt den erwarteten Typ als Argument (Frage 1). Er wird gesetzt an:
Definition mit Typguard, Funktionsargumenten (positional und benannt), deklariertem
Rückgabetyp. Er wird weitergereicht durch Dictionary-Felder,
Listen- und Tuple-Elemente. Beim Spread bricht er ab, wie bei den bestehenden Zuordnungen. `Any`
wird wie kein erwarteter Typ behandelt, eine Union wird unverändert weitergereicht und erst beim
Funktionsliteral bzw. Dictionary-Literal aussortiert (Frage 3 und 4).

Abweichend vom ursprünglichen Plan nicht umgesetzt:

- **Präfix-Argument:** Es wird inferiert, bevor die aufgerufene Funktion bekannt ist. Ein
  erwarteter Typ bräuchte eine weitere Umstellung der Reihenfolge, und ein Funktionsliteral als
  Präfix-Argument ist selten.
- **Destructuring-Feld mit Typguard:** Das Feld bindet einen Teil des Werts, es gibt keinen
  geschriebenen Ausdruck, der den Typ bekommen könnte.
- **Typguard eines Dictionary-Felds** (`[a: T = …]`): Er wird heute nach dem Wert inferiert, wie
  früher bei der Definition.

Die Argumente eines Aufrufs werden dafür einzeln und in Reihenfolge inferiert, bevor die
Argumentliste zusammengesetzt wird. Ein Callback wird dabei mit den schon inferierten vorherigen
Argumenten instanziiert (`instantiateExpectedCallback`).

### 5. Parameter lesen den erwarteten Typ

Der Fall `parameter` nimmt den Parametertyp aus dem erwarteten Funktionstyp statt aus
`inferredTypeFromCall`. Die Sonderprüfung der Elternkette entfällt. Danach sind die roten Tests
grün.

### 6. Merken

Der instanziierte, nicht aufgelöste erwartete Typ steht am Ausdruck in `expectedType` (Frage 1, 2
und 4). Damit ist der Weg für [field-references.md](field-references.md) frei.

### 7. Nachher-Messung und Verifikation

Compiler-Bench mit `--save` und jul-examples bauen. Neue Meldungen in jul-examples werden bewertet
und behoben. yugioh wird nur geprüft, ohne zu installieren, und die Zahl der neuen Meldungen
festgehalten. Die Bereinigung folgt später (Frage 5).

Ergebnis (2026-09-24):

- Compiler-Bench yugioh: parse+check im Median 3643 ms vorher, 3779 ms nachher (+4 %, innerhalb
  der Streuung zwischen Läufen). `inferType` unverändert 274 189, `resolvePlaceholders` 923 166
  → 926 624, `getTypeError` 1 194 756 → 1 236 442 (+3,5 %).
- Checker-Snapshot und Zähler-Baseline des Beispielkorpus unverändert, LSP-Snapshot unverändert.
- jul-examples: unverändert, alle fehlerfrei außer `./import` mit dem vorbestehenden `JUL1151`.
- yugioh: keine neue Meldung. Die Bereinigung aus Frage 5 entfällt damit, und Installieren bricht
  yugioh nicht.

### Folgeschritte

- Erledigt (2026-09-25): `getDeclaredType` im Language Server liest den gemerkten Typ, der
  Index nach einem Spread stimmt damit. Nur Präfix-Argument, Argumentliste und Definition ohne
  Typguard werden noch selbst bestimmt. Im LSP-Snapshot entfallen dadurch Hover auf Literale in
  Kollektionen ohne erwarteten Typ, die bisher über den eigenen Typ der Definition zustande kamen.
  Zugleich reicht der Checker hinter einem Spread `List(X)` und den Rest-Parameter weiter.
- `findInnermostErrorPosition` und `findArgumentErrorPosition` lesen den gemerkten Typ, statt
  selbst zuzuordnen.
- Zwei Durchgänge für die Argumente eines Aufrufs (Frage 2), damit ein Callback auch vor dem
  Argument stehen darf, aus dem sein Typ kommt.
- Erwarteter Typ für das Präfix-Argument und aus dem Typguard eines Dictionary-Felds (Schritt 4).

## Risiken

- **Reihenfolge:** Typguard vor Wert und Rückgabetyp vor Rumpf können an Stellen hängen, die
  heute niemand kennt, etwa an Selbstreferenzen. Schritt 3 isoliert das.
- **Veraltete Typen:** durch Frage 2 ausgeschlossen, solange nirgends eine aufgelöste Kopie
  gemerkt wird.
- **Laufzeit:** Das Weiterreichen selbst ist linear in der Größe der Literale und braucht kein
  zusätzliches `getTypeError`. Neue Meldungen können aber neue Folgeprüfungen auslösen, und ein
  präziserer Parametertyp statt `Any` wird durch den ganzen Rumpf getragen (siehe
  „`Any` ist auch ein Performance-Ventil“ in [CHECKER-AUDIT.md](CHECKER-AUDIT.md)). Gemessen wird
  in Schritt 1 und 7.
