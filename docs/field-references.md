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
- Der Checker läuft dieselbe Struktur „Literal gegen Zieltyp“ bereits ab, allerdings nur für
  Fehlerpositionen: `findInnermostErrorPosition` (Dictionary → Felder, Liste/Tuple → Elemente,
  rekursiv) und `findArgumentErrorPosition` (Argumente → Parameter).
- Die CLI legt keinen `ReferenceIndex` an (`createFileSystemHost()` ohne Argument). Alles, was
  nur bei aktivem Index läuft, kostet die CLI nichts.

## Ansatz

Zwei Arten von Einträgen, beide im Checker und nur bei aktivem Index:

1. **Kontext-Referenz.** Wo ein Dictionary-Literal an einer Stelle mit deklariertem Typ steht,
   wird jeder Feldname des Literals als Referenz auf das Feld des Zieltyps eingetragen,
   rekursiv durch verschachtelte Literale, Listen und Tuples. Das deckt `a: MyType = [name = …]`,
   `f([name = …])`, `List(MyType)` und den Rückgabewert ab.
2. **Verknüpfung.** Zusätzlich merkt sich der Index, dass das Feldsymbol des Literals und das Feld
   des Zieltyps zusammengehören (TypeScript nennt das „related symbols“). `getReferences` liefert
   dann die Referenzen aller verknüpften Symbole. Erst damit wird `d = a/name` gefunden, denn das
   zeigt auf das Literalfeld. Umgekehrt braucht auch `resolveRenameTarget` die Verknüpfung, damit
   ein Rename vom Cursor auf `d = a/name` aus bei `MyType.name` landet.

Der Index wird damit n:1: eine Fundstelle kann mehreren Symbolschlüsseln gehören, und ein Symbol
gehört zu einer Gruppe. Die Verknüpfung lebt in der Datei des Literals und wird mit
`clearReferencesFromFile` dieser Datei wieder entfernt.

Die Strukturwanderung „Literal gegen Zieltyp“ gibt es dann zweimal: einmal für Fehlerpositionen
und einmal für Referenzen. Sie sollte deshalb ein gemeinsamer Walker werden, den
`findInnermostErrorPosition` und das Eintragen beide nutzen (Frage 6).

## Offene Fragen

### 1. Destructuring ohne Alias: `(name) = a`

Das Token `name` ist zugleich die lokale Definition und der Feldname. Was passiert beim Rename von
`MyType.name` zu `label`?

- **(a) Wie beim Import:** Der lokale Name ist das Feld. `(foo) = import(…)` verhält sich heute
  genau so (`resolveCanonicalSymbol` folgt dem unaliasierten Binding), Rename zieht die lokalen
  Verwendungen mit. Konsistent, aber ein Feld-Rename ändert dann lokale Variablennamen quer durch
  die Rümpfe.
- **(b) Wie in TypeScript:** Das Binding wird zu `(name = label) = a` umgeschrieben, der lokale
  Name bleibt. Dafür braucht Rename ein TextEdit mit anderem Text als dem neuen Namen, und
  Find-All-References muss unterscheiden, welche Rolle das Token hat.

Empfehlung: (a), weil Import und Dictionary-Destructuring dieselbe Syntax sind und sich nicht
unterschiedlich verhalten sollten. Beim Alias `(n = name) = a` ist die Sache klar: `name` ist
eine Feldreferenz, `n` ist eine eigene Identität.

### 2. Zieltyp ist eine Union: `x: Or(A B) = [name = 1]`

`getFieldSymbolsFromDictionaryType` liefert bei `or` die Felder aller Zweige. Soll das Literalfeld
an alle Zweige gehen, die `name` deklarieren, oder nur an die, denen das Literal zuweisbar ist?
Wird es an mehrere Zweige verknüpft, geraten `A.name` und `B.name` in dieselbe Gruppe, und ein
Rename von `A.name` benennt auch `B.name` um.

Empfehlung: nur die Zweige, denen das Literal zuweisbar ist. Bleiben danach mehrere übrig, werden
sie verknüpft, denn sonst hinterlässt der Rename kaputten Code.

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

### 5. Welche Stellen zählen als kontextuell typisiert?

Sicher: Definition mit Typguard, Funktionsargument (positional und benannt), deklarierter
Rückgabetyp, Destructuring-Feld mit Typguard. Offen:

- Argumente eines Branchings `?(…)` gegen die Köpfe: Die Köpfe sind Muster, keine Deklaration.
  Empfehlung: nicht.
- Spread `[...base name = 1]`: Die Felder aus `base` haben kein eigenes Token. Nur die
  ausgeschriebenen Felder zählen.
- `Dictionary(X)` als Ziel: Dort sind keine Felder deklariert, es gibt nichts einzutragen.

### 6. Gemeinsamer Walker oder eigene Funktion?

Den bestehenden `findInnermostErrorPosition` zu einem generischen Walker umbauen (Literal und
Zieltyp paarweise ablaufen, Besucher als Parameter) oder eine zweite Funktion daneben schreiben?
Empfehlung: gemeinsamer Walker, sonst driften die beiden Abstiege auseinander (Spread, Alias,
Tuples). Das betrifft Fehlerpositionen und damit den Checker-Snapshot. Deshalb als eigener
Schritt vor dem Eintragen, bei dem sich keine Meldung ändern darf.

## Schritte

### 1. Vorher-Messung

LSP-Bench mit `--save` (nur dort ist der Index aktiv), zusätzlich der Compiler-Bench als
Gegenprobe, dass die CLI unverändert bleibt.

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
| Destructuring ohne Alias | `(name) = a` | hängt an Frage 1 |
| Union als Ziel | `x: Or(MyType Other) = [name = 1]` | hängt an Frage 2 |

Gegenproben, die grün sein und grün bleiben müssen:

- `Other = [name: Text]` und `o: Other = [name = §x§]` liegen nicht in den Referenzen von
  `MyType.name`.
- Ein untypisiertes `x = [name = 1]` liegt nicht darin.
- `h = (v: Any) => v` mit `h([name = 1])` trägt nichts ein.
- Ein Feld des Literals, das der Zieltyp nicht kennt (`[name = 1 extra = 2]`), trägt für `extra`
  nichts ein.

Rote Tests laufen lassen, den Output zeigen, anhalten.

### 3. Gemeinsamer Walker

`findInnermostErrorPosition` auf den Walker umstellen (Frage 6). Checker-Snapshot und
Zähler-Baseline müssen unverändert bleiben.

### 4. Kontext-Referenzen eintragen

Den Walker an den Prüfstellen aus Frage 5 mit einem Besucher aufrufen, der
`recordFieldReference` für jeden Feldnamen gegen den Zieltyp aufruft, nur bei aktivem Index.
Danach sind alle Tests grün außer „Zugriff über typisierte Variable“.

### 5. Verknüpfung im Index

`ReferenceIndex` bekommt Gruppen verknüpfter Symbole (Union-Find, je Datei entfernbar).
`getReferences` liefert die Fundstellen der ganzen Gruppe plus die Deklarationen der anderen
Gruppenmitglieder. Danach ist auch „Zugriff über typisierte Variable“ grün.

### 6. Sprachserver

`resolveRenameTarget` löst ein Literalfeld über die Gruppe auf. Rename muss dabei die
Deklarationen aller Gruppenmitglieder umbenennen, also auch die Literalfelder. Abgedeckt wird das
über neue Einträge im LSP-Snapshot (References und Rename auf `MyType.name`, auf einem
Literalfeld und auf `d = a/name`).

### 7. Nachher-Messung und Aufräumen

LSP-Bench mit `--save`. Den TODO-Punkt entfernen, falls danach nichts mehr offen ist.

## Risiken

- **Laufzeit im Language Server:** Der Walker läuft an jeder typisierten Stelle ein zweites Mal.
  Gemessen wird in Schritt 1 und 7.
- **Zu große Gruppen:** Jede Verknüpfung über Unions (Frage 2) vergrößert, was ein Rename
  anfasst. Eine falsche Verknüpfung ist schlimmer als eine fehlende, denn sie benennt fremden Code
  um. Im Zweifel nicht verknüpfen.
- **Veraltete Einträge über Dateigrenzen:** Das Literal in `b.jul` verweist auf `MyType` in
  `a.jul`. Solange die transitive Invalidierung nur beim Speichern läuft, sieht `b.jul` eine
  Änderung an `a.jul` erst dann. Das ist dieselbe Einschränkung wie für die bestehenden
  Cross-File-Referenzen.
