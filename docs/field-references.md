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
- Die CLI legt keinen `ReferenceIndex` an (`createFileSystemHost()` ohne Argument). Alles, was
  nur bei aktivem Index läuft, kostet die CLI nichts.

## Voraussetzung

Dieser Plan baut auf [expected-types.md](expected-types.md) auf: Der Checker merkt sich an jedem
Ausdruck den erwarteten Typ, auch an jedem Feld eines Dictionary-Literals. Wie der Zieltyp durch
Argumente, Felder, Listen und Tuples weitergereicht wird, steht dort und wird hier nicht noch
einmal gebaut. Dort steht auch der Vergleich der Stellen, die heute Ausdrücke einem Zieltyp
zuordnen.

## Ansatz

Zwei Arten von Einträgen, beide im Checker und nur bei aktivem Index:

1. **Kontext-Referenz.** Hat ein Feld eines Dictionary-Literals einen erwarteten Typ, weil das
   Literal einen hat, wird der Feldname als Referenz auf das Feld des erwarteten Typs
   eingetragen. Das deckt `a: MyType = [name = …]`, `f([name = …])`, `List(MyType)`,
   verschachtelte Literale und den Rückgabewert ab.
2. **Verknüpfung.** Zusätzlich merkt sich der Index, dass das Feldsymbol des Literals und das Feld
   des Zieltyps zusammengehören (TypeScript nennt das „related symbols“). `getReferences` liefert
   dann die Referenzen aller verknüpften Symbole. Erst damit wird `d = a/name` gefunden, denn das
   zeigt auf das Literalfeld. Umgekehrt braucht auch `resolveRenameTarget` die Verknüpfung, damit
   ein Rename vom Cursor auf `d = a/name` aus bei `MyType.name` landet.

Der Index wird damit n:1: eine Fundstelle kann mehreren Symbolschlüsseln gehören. Die
Verknüpfung ist ein Hop vom Typfeld zu den Literalfeldern, nicht transitiv (Frage 2). Sie lebt in
der Datei des Literals und wird mit `clearReferencesFromFile` dieser Datei wieder entfernt.

## Offene Fragen

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

### 2. Zieltyp ist eine Union: `x: Or(A B) = [name = 1]`

Ausgangspunkt für alle Beispiele:

```jul
Person = [name: Text age: Integer]
Pet = [name: Text species: Text]
```

`getFieldSymbolsFromDictionaryType` liefert bei `or` die Felder aller Zweige, die `name`
deklarieren, hier also `Person.name` und `Pet.name`. Die Frage ist, wie viel davon das Literal
abbekommt.

**Fall A: Das Literal passt nur zu einem Zweig.**

```jul
x: Or(Person Pet) = [name = §Ada§ age = 36]
```

Das Literal ist eine `Person`, für `Pet` fehlt `species`. Würde das Literalfeld trotzdem mit
`Pet.name` verknüpft, zöge ein Rename von `Pet.name` zu `nickname` dieses Literal mit:
`[nickname = §Ada§ age = 36]` ist dann keine `Person` mehr und auch kein `Pet`, der Code hat einen
Fehler. Außerdem zeigte Find-All-References auf `Pet.name` eine Person an. Deshalb: nur mit den
Zweigen verknüpfen, denen das Literal zuweisbar ist, hier nur mit `Person.name`.

**Fall B: Das Literal passt zu beiden Zweigen.**

```jul
y: Or(Person Pet) = [name = §Rex§ age = 3 species = §Hund§]
```

Das Literal ist beides. Es wird mit `Person.name` und mit `Pet.name` verknüpft, beide
Find-All-References zeigen es. Ein Rename von `Person.name` zu `fullName` macht daraus
`[fullName = §Rex§ age = 3 species = §Hund§]`. Das ist kein `Pet` mehr, aber noch eine `Person`,
und `Or` verlangt nur einen der beiden. Der Code bleibt gültig.

Daraus folgt: Die Verknüpfung darf **nicht transitiv** sein. Das Literalfeld hängt an beiden,
aber `Person.name` und `Pet.name` hängen dadurch nicht aneinander. Wäre sie transitiv, benennte
ein Rename von `Person.name` auch `Pet.name` um, und damit jedes Haustier im ganzen Projekt, nur
weil irgendwo ein Literal zufällig beides ist.

**Offen bleibt der Rename vom Literal aus.** Steht der Cursor auf `name` in `y` oder auf `y/name`,
meint die Stelle beide Felder zugleich. Möglich sind:

- beide Typfelder umbenennen, mit allem, was an ihnen hängt, denn der Nutzer hat eine Stelle
  gewählt, die beides ist
- nur das Literal und seine Zugriffe umbenennen. Das ist gültig, solange das Literal danach noch
  zu einem Zweig passt, hier also nicht: `[label = … age = 3 species = …]` ist weder `Person` noch
  `Pet`.
- den Rename ablehnen mit der Meldung, dass die Stelle mehrdeutig ist

Empfehlung: nur mit den zuweisbaren Zweigen verknüpfen, nicht transitiv. Beim Rename von einer
mehrdeutigen Stelle aus beide Typfelder umbenennen.

### 3. Werte, die über Variablen fließen

`x = [name = 1]` und dann `f(x)` mit `f = (v: MyType) => …`: Soll `x/name` bzw. das Literal zu
`MyType.name` gehören? TypeScript verknüpft nur kontextuell typisierte Literale, keine Werte, die
später irgendwohin fließen. Ein Rename lässt dort das Literal stehen, der Fehler erscheint dann
bei `f(x)`.

Empfehlung: nicht verknüpfen, genau wie TypeScript. Sonst verknüpft ein einziger Aufruf beliebig
entfernte Typen miteinander.

### 4. Zu welchem Zweig zeigt Go-to-Definition bei `d = a/name`?

Heute springt Go-to-Definition zum Literalfeld in `a: MyType = [name = §x§]`. Nach der
Verknüpfung wäre auch `MyType.name` begründbar. Empfehlung: unverändert lassen, das Literal ist
die Stelle, an der der Wert entsteht. Find-All-References zeigt ohnehin beide.

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
| Union als Ziel | `x: Or(MyType Other) = [name = 1]` | hängt an Frage 2 |

Gegenproben, die grün sein und grün bleiben müssen:

- `Other = [name: Text]` und `o: Other = [name = §x§]` liegen nicht in den Referenzen von
  `MyType.name`.
- Ein untypisiertes `x = [name = 1]` liegt nicht darin.
- `h = (v: Any) => v` mit `h([name = 1])` trägt nichts ein.
- Ein Feld des Literals, das der Zieltyp nicht kennt (`[name = 1 extra = 2]`), trägt für `extra`
  nichts ein.

Rote Tests laufen lassen, den Output zeigen, anhalten.

### 3. Kontext-Referenzen eintragen

Im Fall `dictionary` für jedes ausgeschriebene Feld mit erwartetem Typ `recordFieldReference`
gegen diesen Typ aufrufen, nur bei aktivem Index. Danach sind alle Tests grün außer „Zugriff über
typisierte Variable“ und den beiden Destructuring-Tests.

### 4. Destructuring

Im Fall `destructuring` das Feld-Token (`source` beim Alias, sonst `name`) als Referenz auf das
Feld des Werttyps eintragen. Ohne Alias ist der lokale Name dabei das Feld selbst (Frage 1).

### 5. Verknüpfung im Index

`ReferenceIndex` bekommt eine Verknüpfung Typfeld → Literalfelder (ein Hop, nicht transitiv, je
Datei entfernbar). `getReferences` auf einem Typfeld liefert die eigenen Fundstellen, die
Deklarationen der verknüpften Literalfelder und deren Fundstellen. Danach ist auch „Zugriff über
typisierte Variable“ grün.

### 6. Sprachserver

`resolveRenameTarget` löst ein Literalfeld über die Verknüpfung auf das Typfeld auf, bei einer
mehrdeutigen Stelle auf alle (Frage 2). Rename benennt dabei auch die verknüpften Literalfelder
um, und beim Destructuring ohne Alias gilt die Konfliktregel aus Frage 1. Abgedeckt wird das
über neue Einträge im LSP-Snapshot (References und Rename auf `MyType.name`, auf einem
Literalfeld und auf `d = a/name`).

### 7. Nachher-Messung und Aufräumen

LSP-Bench mit `--save`. Den TODO-Punkt entfernen, falls danach nichts mehr offen ist.

## Risiken

- **Laufzeit im Language Server:** Das Eintragen ist ein Lookup je Feld mit erwartetem Typ, die
  Zweigauswahl bei einer Union (Frage 2) braucht zusätzlich `getTypeError`. Gemessen wird in
  Schritt 1 und 7.
- **Zu weite Verknüpfung:** Jede Verknüpfung über Unions (Frage 2) vergrößert, was ein Rename
  anfasst. Eine falsche Verknüpfung ist schlimmer als eine fehlende, denn sie benennt fremden Code
  um. Im Zweifel nicht verknüpfen.
- **Veraltete Einträge über Dateigrenzen:** Das Literal in `b.jul` verweist auf `MyType` in
  `a.jul`. Solange die transitive Invalidierung nur beim Speichern läuft, sieht `b.jul` eine
  Änderung an `a.jul` erst dann. Das ist dieselbe Einschränkung wie für die bestehenden
  Cross-File-Referenzen.
