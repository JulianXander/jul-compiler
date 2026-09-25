# Umsetzungsplan: Feldreferenzen an kontextuell typisierten Stellen

## Ziel

Find-All-References, Rename und Document Highlight auf einem Feld eines Dictionary-Typs sollen
jede Stelle finden, die dieses Feld meint, nicht nur Feldzugriffe auf einer als Typ deklarierten
Quelle:

```jul
MyType = [
	name: Text
]
a: MyType = [name = §x§]                        # Feldname im Literal
f = (value: MyType) => value/name               # Feldzugriff, geht heute schon
b = f([name = §y§])                             # Funktionsargument
c: List(MyType) = [[name = §z§]]                # Listenelement
d = a/name                                      # Feldzugriff über eine typisierte Variable
(name) = a                                      # Destructuring
g = (value: MyType) :> MyType => [name = §w§]   # Rückgabewert
```

Heute findet der Index davon nur `value/name`.

Das ist nicht nur eine Lücke bei der Suche. Rename liest denselben Index. Benennt man `name` in
`MyType` um, bleiben alle Literale stehen, und der Code hat danach Fehler („Feld fehlt“).

**Nicht in diesem Plan:** strukturelles Matching über den bloßen Feldnamen. Zwei unabhängig
geschriebene `[name: Text]` sind derselbe Typ, aber ein Rename darf das fremde Feld nicht
mitziehen. Ebenfalls nicht: Werte, die über eine Variable ohne Typguard an eine typisierte Stelle
fließen (`x = [name = 1]` und dann `f(x)`), siehe Frage 3.

## Ausgangslage

- Eingetragen wird nur in `recordFieldReference` ([checker.ts](../src/checker/checker.ts)),
  aufgerufen nur aus dem Fall `nestedReference`. Aufgelöst wird gegen den **inferierten** Typ der
  Quelle.
- Eine Definition übernimmt den inferierten Typ des Werts, nicht den Typguard („Die Zuweisung
  schneidet nichts weg“). Deshalb zeigt `d = a/name` auf das Feld `name` **des Literals**
  `[name = §x§]`, das ein eigenes Feldsymbol hat, und nicht auf `MyType.name`. Das bleibt so,
  der Plan ändert die Typregel nicht.
- Der Language Server rekonstruiert den kontextuellen Typ bereits mit `getDeclaredType`
  ([util.ts](../../jul-language-server/src/util.ts)). Go-to-Definition auf `[name = …]`
  springt deshalb schon heute zu `MyType.name`. Das hilft dem Index aber nicht, er wird im Checker
  gefüllt.
- Die CLI legt keinen `ReferenceIndex` an (`createFileSystemHost` ohne `referenceIndex`). Alles, was
  nur bei aktivem Index läuft, kostet die CLI nichts.

## Voraussetzung

Dieser Plan baut auf [expected-types.md](expected-types.md) auf: Der Checker merkt sich an jedem
Ausdruck den erwarteten Typ, auch an jedem Feld eines Dictionary-Literals. Wie der Zieltyp durch
Argumente, Felder, Listen und Tuples weitergereicht wird, steht dort und wird hier nicht noch
einmal gebaut. Dort steht auch der Vergleich der Stellen, die heute Ausdrücke einem Zieltyp
zuordnen.

## Ansatz

Zwei Arten von Einträgen, beide im Checker und nur bei aktivem Index:

1. **Kontext-Referenz.** Hat ein Dictionary-Literal einen erwarteten Typ, wird jeder
   ausgeschriebene Feldname als Referenz auf das Feld des erwarteten Typs eingetragen, bei einer
   Union auf das Feld jedes passenden Zweigs (Frage 2). Das deckt `a: MyType = [name = …]`, `f([name = …])`, `List(MyType)`,
   verschachtelte Literale und den Rückgabewert ab.
2. **Verknüpfung.** Zusätzlich merkt sich der Index, dass das Feldsymbol des Literals und das Feld
   des Zieltyps zusammengehören (TypeScript nennt das „related symbols“). `getReferences` liefert
   dann die Referenzen aller verknüpften Symbole. Erst damit wird `d = a/name` gefunden, denn das
   zeigt auf das Literalfeld. Umgekehrt braucht auch `resolveRenameTarget` die Verknüpfung, damit
   ein Rename vom Cursor auf `d = a/name` aus bei `MyType.name` landet.

Der Index wird damit n:1: eine Fundstelle kann mehreren Symbolschlüsseln gehören. Die
Verknüpfung ist ein Hop vom Typfeld zu den Literalfeldern, nicht transitiv (Frage 2). Sie lebt in
der Datei des Literals und wird mit `clearReferencesFromFile` dieser Datei wieder entfernt.

## Entscheidungen

### 1. Destructuring ohne Alias: `(name) = a` — entschieden

Das Token `name` ist zugleich die lokale Definition und der Feldname. Beim Rename von
`MyType.name` zu `label`:

- **Normalfall ohne Alias:** Der lokale Name ist das Feld, wie beim Import `(foo) = import(…)`
  (`resolveCanonicalSymbol` folgt dem unaliasierten Binding). Aus `(name) = a` wird
  `(label) = a`, die lokalen Verwendungen von `name` werden mit umbenannt.
- **Bei Konflikt mit Alias:** JUL verbietet doppelte Namen im selben Scope (`alreadyDefined`)
  und Verdecken (`alreadyDefinedInUpperScope`). Ein Konflikt entsteht also, wenn `label` schon
  im selben Scope steht, in einem umgebenden Scope (Parameter, Top-Level, Builtin wie `length`)
  oder in einem inneren Scope, der dann plötzlich verdeckt. Dann wird zu `(name = label) = a`
  umgeschrieben. Der lokale Name bleibt, die Verwendungen bleiben unverändert, und der Rename
  gelingt immer. Dafür braucht Rename ein TextEdit, dessen Text vom neuen Namen abweicht.

Beim Alias `(n = name) = a` ist die Sache ohnehin klar: `name` ist eine Feldreferenz, `n` ist
eine eigene Identität.

Dieselbe Konfliktregel gilt dann sinnvollerweise auch für den Import. Ob Rename dort heute einen
Konflikt erzeugt, ist noch zu prüfen.

### 2. Zieltyp ist eine Union — entschieden

Ausgangspunkt für alle Beispiele:

```jul
Person = [name: Text age: Integer]
Pet = [name: Text species: Text]
x: Or(Person Pet) = [name = §Ada§ age = 36]                  # passt nur zu Person
y: Or(Person Pet) = [name = §Rex§ age = 3 species = §Hund§]  # passt zu beiden
```

**Mit welchen Zweigen wird ein Literalfeld verknüpft?** Mit allen Zweigen, die nach dem
Aussortieren übrig bleiben und das Feld deklarieren. Aussortiert wird wie beim erwarteten Typ
(`narrowExpectedTypeByFields`), erweitert um fehlende Felder:

- Ein Zweig fällt weg, wenn ein geschriebenes Feld seinem Feldtyp widerspricht (`getTypeError` je
  Feld).
- Ein Zweig fällt weg, wenn er ein Feld verlangt, das im Literal fehlt. Das ist ein Namensvergleich
  ohne `getTypeError`. Ein Feld, dessen Typ `Empty` zulässt (`Or([] X)`), darf fehlen.

Bei `x` fällt `Pet` weg, weil `species` fehlt, bei `y` bleiben beide. Ein Widerspruch tief in einem
verschachtelten Wert wird übersehen, das ist dieselbe Unschärfe wie beim erwarteten Typ.

Verworfen:

- **alle Zweige, die das Feld deklarieren:** `x/name` hinge dann an `Pet.name`, ein Rename von
  `Pet.name` machte `x` zu einem Literal, das zu keinem Zweig passt.
- **nur zuweisbare Zweige mit vollem `getTypeError`:** exakt, aber das ganze Literal je Zweig bei
  jedem Tastendruck im Language Server.
- **Unions gar nicht verknüpfen:** lässt gerade diskriminierte Unions aus, den häufigen Fall.

TypeScript macht es ähnlich: Es verengt über die Diskriminanten
(`discriminateContextualTypeByObjectMembers`) und verknüpft mit allen verbleibenden Zweigen, die
die Eigenschaft deklarieren (`getPropertySymbolsFromContextualType`), prüft aber nicht auf fehlende
Felder.

**Die Verknüpfung ist nicht transitiv.** `y` hängt an `Person.name` und an `Pet.name`, die beiden
hängen dadurch nicht aneinander. Sonst benennte ein Rename von `Person.name` jedes Haustier im
Projekt um, nur weil irgendwo ein Literal zufällig beides ist. Ein Rename von `Person.name` macht aus
`y` ein `[label = … age = 3 species = …]`, das ist kein `Pet` mehr, aber noch eine `Person`, und
`Or` verlangt nur einen Zweig.

**Rename von einer mehrdeutigen Stelle** (Cursor auf `name` in `y` oder auf `y/name`) benennt alle
verknüpften Typfelder um, hier `Person.name` und `Pet.name` samt allem, was an ihnen hängt. So
verhält sich meines Wissens auch TypeScript bei einer Union-Eigenschaft. Damit der Nutzer sieht,
dass ein Typ betroffen ist, an den er vielleicht nicht gedacht hat, tragen die Änderungen über den
ersten Typ hinaus eine `changeAnnotation` mit `needsConfirmation` (etwa „Feld auch in Pet“). VS Code
zeigt dann die Refactoring-Vorschau, in der jede Änderung abwählbar ist. Das ist etwa wichtig,
wenn `Pet` die Antwort eines Servers beschreibt und der Checker die Daten nicht sieht.

Find-All-References von einer mehrdeutigen Stelle zeigt die Fundstellen aller verknüpften
Typfelder.

### 3. Werte, die über Variablen fließen — entschieden: nicht verknüpfen

```jul
MyType = [name: Text]
f = (v: MyType) => v/name
x = [name = §Ada§]      # kein Typguard, das Literal hat keinen erwarteten Typ
f(x)
```

Verknüpft werden nur Literale, die direkt an einer typisierten Stelle stehen. Ein Rename von
`MyType.name` lässt `x` stehen, der Fehler erscheint dann bei `f(x)` und nennt das fehlende Feld.
Wer die Verknüpfung will, schreibt den Typguard: `x: MyType = [name = §Ada§]`. So verhalten sich
auch TypeScript, Flow und Pyright (`TypedDict`). Sprachen mit nominalen Struct-Literalen (Rust,
Kotlin, C#) kennen das Problem nicht, das Literal nennt dort seinen Typ.

Verworfen:

- **Über den Datenfluss verknüpfen:** In JUL billig, weil der Typ eines Dictionary-Literals seine
  Deklaration mitträgt. Aber die Reichweite ist nicht kontrollierbar: Landet `x` bei `f` und bei
  `g = (w: OtherType) => …`, hängt das Literal an beiden Typen, und ein Rename von `MyType.name`
  bricht `g(x)`. Werte laufen außerdem durch generische Funktionen und Listen und sammeln so
  Verknüpfungen im ganzen Projekt.
- **Nur Find-All-References über den Datenfluss, Rename nicht:** Beide Funktionen wären sich
  uneinig, und LSP kann „nur informativ“ nicht kennzeichnen.

Möglicher Ausbau, falls weitergereichte Literale im Alltag oft fehlen: über den Datenfluss
verknüpfen, ein Rename nimmt ein solches Literal aber nur mit, wenn alle seine Verknüpfungen auf
dasselbe Typfeld zeigen. Sonst bleibt es stehen, und der Rename warnt. Vorbild sind die „dynamic
usages“ in WebStorm/IntelliJ, die getrennt angezeigt und beim Rename abgefragt werden.

### 4. Wohin springt Go-to-Definition bei `d = a/name`? — entschieden: zum Typfeld

Mit `a: MyType = [name = §x§]` springt Go-to-Definition auf `name` in `a/name` zu `MyType.name`,
nicht wie heute zum Literalfeld. Allgemein: Ist das Literalfeld verknüpft, sind die verknüpften
Typfelder das Ziel, bei einer mehrdeutigen Stelle alle (VS Code zeigt dann die Peek-Ansicht). Ohne
Verknüpfung, etwa bei `x = [name = …]` ohne Typguard, bleibt das Literalfeld das Ziel.

Begründung:

- Einheitlich mit dem Parameterfall: `value/name` mit `value: MyType` springt schon heute zu
  `MyType.name`. Ob der Typ an einem Parameter oder an einer Definition steht, sieht der Nutzer
  dem Zugriff nicht an.
- Dasselbe Ziel, das Rename und Find-All-References als eigentliche Deklaration behandeln.
- So verhalten sich TypeScript, Rust, Kotlin und C#.
- Der Wert bleibt einen Schritt entfernt: Go-to-Definition auf `a` führt zur Definition mit dem
  Literal. Umgekehrt führt Go-to-Definition auf `name` im Literal schon heute zu `MyType.name`
  (Fall `singleDictionaryField` in [server.ts](../../jul-language-server/src/server.ts)).

Verworfen: beim Literalfeld lassen (uneinheitlich mit dem Parameterfall) und beide Ziele liefern
(Peek-Ansicht bei jedem Sprung, obwohl meist genau eines gemeint ist).

### 5. Welche Stellen zählen?

Genau die, an denen [expected-types.md](expected-types.md) einen erwarteten Typ setzt. Für die
Referenzen heißt das zusätzlich:

- Argumente eines Branchings `?(…)` zählen nicht, die Köpfe sind Muster, keine Deklaration.
- Beim Spread `[...base name = 1]` zählen nur die ausgeschriebenen Felder, die Felder aus `base`
  haben kein eigenes Token.
- `Dictionary(X)` als Ziel: Dort sind keine Felder deklariert, es gibt nichts einzutragen.

## Schritte

### 1. Vorher-Messung

Erst nach Abschluss von [expected-types.md](expected-types.md). LSP-Bench mit `--save` (nur dort
ist der Index aktiv), zusätzlich der Compiler-Bench als Gegenprobe, dass die CLI unverändert
bleibt.

### 2. Rote Tests

In `reference-index.test.ts`, im Block „Felder eines Dictionary-Typs“, je ein Test pro Stelle.
Die Tests prüfen `getReferences(MyType.name)` auf die erwarteten Zeilen:

| Test | Code | erwartet |
|---|---|---|
| Definition mit Typguard | `a: MyType = [name = §x§]` | rot |
| Funktionsargument positional | `f([name = §y§])` | rot |
| Funktionsargument benannt | `f(value = [name = §y§])` | rot |
| Listenelement | `c: List(MyType) = [[name = §z§]]` | rot |
| verschachteltes Literal | `o: Outer = [inner = [name = 1]]` mit `Outer = [inner: MyType]` | rot |
| Rückgabewert | `g = () :> MyType => [name = §w§]` | rot |
| Zugriff über typisierte Variable | `d = a/name` | rot |
| über Dateigrenzen | Literal in `b.jul`, `MyType` aus `a.jul` importiert | rot |
| Destructuring mit Alias | `(n = name) = a` | rot, `name` zählt |
| Destructuring ohne Alias | `(name) = a` | rot, `name` zählt |
| Union, ein passender Zweig | `x: Or(Person Pet) = [name = §Ada§ age = 36]`: liegt bei `Person.name`, nicht bei `Pet.name` | rot |
| Union, beide Zweige passen | `y: Or(Person Pet) = [name = §Rex§ age = 3 species = §Hund§]`: liegt bei beiden | rot |
| Union, Widerspruch | `z: Or([kind: §a§ name: Text] [kind: §b§ name: Text]) = [kind = §a§ name = §x§]`: nur beim ersten Zweig | rot |

Gegenproben, die grün sein und grün bleiben müssen:

- `Other = [name: Text]` und `o: Other = [name = §x§]` liegen nicht in den Referenzen von
  `MyType.name`.
- Ein untypisiertes `x = [name = 1]` liegt nicht darin.
- `h = (v: Any) => v` mit `h([name = 1])` trägt nichts ein.
- Ein Feld des Literals, das der Zieltyp nicht kennt (`[name = 1 extra = 2]`), trägt für `extra`
  nichts ein.

Rote Tests laufen lassen, den Output zeigen, anhalten.

### 3. Aussortieren um fehlende Felder erweitern

`narrowExpectedTypeByFields` sortiert zusätzlich Zweige aus, die ein Feld verlangen, das im
Literal nicht ausgeschrieben ist. Verlangt heißt: Der Feldtyp lässt `Empty` nicht zu, denn ein Feld
vom Typ `Or([] X)` darf fehlen. Die ausgeschriebenen Feldnamen stehen syntaktisch fest, dafür
zählen alle Felder des Literals, nicht nur die vorherigen. Ein Spread im Literal schaltet diese
Prüfung ab, seine Felder sind nicht ausgeschrieben.

Davon profitiert auch der erwartete Typ. Deshalb vorher ein roter Test in `checker.test.ts`, Region
`erwarteter Typ`:

```jul
x: Or([name: Text age: Integer cb: (v: Integer) :> Text]  [name: Text species: Text cb: (v: Text) :> Text]) = [name = §Ada§ age = 36 cb = (v) => v]
```

`species` fehlt, also bleibt nur der erste Zweig, `v` ist `Integer`, und der Rückgabewert ist kein
`Text`. Heute bleibt `v` ohne Typ, weil zwei Funktionszweige übrig sind.

### 4. Kontext-Referenzen eintragen

Im Fall `dictionary`, nachdem alle Felder inferiert sind, das Literal mit seinen Feldern gegen
seinen erwarteten Typ aussortieren und für jedes ausgeschriebene Feld `recordFieldReference`
gegen das Ergebnis aufrufen, nur bei aktivem Index. Danach sind alle Tests grün außer „Zugriff über
typisierte Variable“ und den beiden Destructuring-Tests.

### 5. Destructuring

Im Fall `destructuring` das Feld-Token (`source` beim Alias, sonst `name`) als Referenz auf das
Feld des Werttyps eintragen. Ohne Alias ist der lokale Name dabei das Feld selbst (Frage 1).

### 6. Verknüpfung im Index

`ReferenceIndex` bekommt eine Verknüpfung Typfeld → Literalfelder (ein Hop, nicht transitiv, je
Datei entfernbar). `getReferences` auf einem Typfeld liefert die eigenen Fundstellen, die
Deklarationen der verknüpften Literalfelder und deren Fundstellen. Danach ist auch „Zugriff über
typisierte Variable“ grün.

### 7. Sprachserver

`resolveRenameTarget` löst ein Literalfeld über die Verknüpfung auf das Typfeld auf, bei einer
mehrdeutigen Stelle auf alle (Frage 2). Rename benennt dabei auch die verknüpften Literalfelder
um, und beim Destructuring ohne Alias gilt die Konfliktregel aus Frage 1. Go-to-Definition auf
einen Zugriff wie `a/name` liefert die verknüpften Typfelder (Frage 4). Änderungen, die über den
ersten Typ hinausgehen, tragen eine `changeAnnotation` mit `needsConfirmation`.

Umgesetzt abweichend vom ursprünglichen Plan nicht über den LSP-Snapshot, der nur Hover,
Definition, Completion und SignatureHelp an Positionen in jul-examples abfragt. Stattdessen stehen
Zielauflösung, Find-All-References und Rename samt Konfliktregel in einem eigenen Modul
[references.ts](../../jul-language-server/src/references.ts) mit Unit-Tests, `server.ts` verdrahtet
es nur. Go-to-Definition auf `a/name` und die Annotation wurden einmalig über echtes LSP gegen den
gebauten Server geprüft, sie haben keinen automatischen Test.

Die Konfliktprüfung ist bewusst grob: Jede Definition des neuen Namens irgendwo in der Datei und
jedes Builtin zählt als Konflikt. Im Zweifel entsteht ein Alias zu viel, nie falscher Code.

Auf dem lokalen Namen eines Destructurings ohne Alias, das kein Import ist, war Rename bisher gar
nicht möglich (es wurde nur eine Import-Bindung gesucht). Jetzt fällt es auf das lokale Symbol und
über die Verknüpfung auf das Typfeld.

### 8. Nachher-Messung und Aufräumen

LSP-Bench mit `--save`. Den TODO-Punkt entfernen, falls danach nichts mehr offen ist.

Stand (2026-09-25): Schritte 1 bis 7 umgesetzt, alle Tests grün (Compiler 678, Language Server 52),
Checker-Snapshot, Zähler-Baseline und LSP-Snapshot unverändert, jul-examples unverändert, yugioh
ohne Fehler.

Messung (2026-09-25, yugioh). Die erste Nachher-Messung lief unter fremder Last (Compiler 10,6 s
bei identischen Zählern). Sie steht weiter im Protokoll, gültig ist der wiederholte Eintrag direkt
danach, Notiz „feldreferenzen, wiederholt ohne fremde last“:

- Compiler: 1205 → 1418 ms. Die Zähler sind gegenüber vorher praktisch gleich (`getTypeError`
  +0,06 %), ein ungespeicherter Lauf desselben Stands lag bei 1288 ms. Der Unterschied liegt in
  der Streuung zwischen Läufen.
- Language Server: didOpen 52 → 62 ms (hier wird der Index gefüllt), didChange 156 → 153 ms,
  completion 1,9 → 1,6 ms, hover und definition unter der Messgrenze.

## Risiken

- **Laufzeit im Language Server:** Das Eintragen ist ein Lookup je Feld mit erwartetem Typ, die
  Zweigauswahl bei einer Union (Frage 2) braucht zusätzlich `getTypeError`. Gemessen wird in
  Schritt 1 und 7.
- **Zu weite Verknüpfung:** Jede Verknüpfung über Unions (Frage 2) vergrößert, was ein Rename
  anfasst. Eine falsche Verknüpfung ist schlimmer als eine fehlende, denn sie benennt fremden Code
  um. Im Zweifel nicht verknüpfen.
- **Zugriff auf eine Union:** `u/name` mit `u: Or(Pet Robot)` hängt an `Pet.name` und an
  `Robot.name`. Ein Rename von `Pet.name` benennt den Zugriff mit um, `Robot.name` aber nicht, und
  der Robot-Zweig hat danach kein passendes Feld mehr. Das gilt für jeden Rename eines Felds, das
  auch in einer Union vorkommt, nicht nur von einer mehrdeutigen Stelle aus, und TypeScript hat
  dieselbe Grenze. Gelöst würde es nur durch Transitivität über Union-Zugriffe, und die ist
  ausgeschlossen (Frage 2). Nicht in diesem Plan.
- **Veraltete Einträge über Dateigrenzen:** Das Literal in `b.jul` verweist auf `MyType` in
  `a.jul`. Solange die transitive Invalidierung nur beim Speichern läuft, sieht `b.jul` eine
  Änderung an `a.jul` erst dann. Das ist dieselbe Einschränkung wie für die bestehenden
  Cross-File-Referenzen.
