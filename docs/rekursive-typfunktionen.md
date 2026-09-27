# Rekursive Typen und Typfunktionen

Ein Typ darf sich selbst enthalten, solange die Selbstreferenz in einer Datenebene steht:

```jul
Node = [value: Integer children: Or([] List(Node))]
Tree = (T: Type) => [value: T children: Or([] List(Tree(T)))]
```

`Node` nennt sich selbst, `Tree` ruft sich selbst auf. Beides muss der Checker prüfen können, ohne
endlos auszuwerten, und beides muss zur Laufzeit ladbar sein, obwohl Typen dort sofort gebaute
Werte sind. Dieses Dokument hält fest, wie das gelöst ist.

**Stand:** Umgesetzt, im Checker wie zur Laufzeit.

## Das Problem

Im Checker hat eine Definition, während ihr Wert geprüft wird, noch keinen Typ. Eine
Selbstreferenz kann ihn also nicht nachschlagen. Für `Node` gibt es dafür den `alias`-Knoten: er
hält den Namen und liest den Typ erst beim Zugriff. Für `Tree` fehlte das Gegenstück. Die
Selbstreferenz wurde wie ein fertiger Typ behandelt, und der Aufruf `Tree(T)` scheiterte mit
JUL5151.

Zur Laufzeit wird `Node = [...]` zu einer Konstante, die sich beim Bauen selbst braucht
(`Cannot access 'Node' before initialization`). `Tree(Integer)` ruft beim Bauen sofort den
nächsten `Tree(T)` auf und endet nie.

## Entscheidung: verzögerte Knoten statt Auswertung bis zu einer Tiefe

Die Selbstreferenz bleibt ein Knoten, der erst beim Zugriff eine Ebene weiter ausgewertet wird, im
Checker wie zur Laufzeit.

Verworfen wurde, `Tree(T)` sofort bis zu einer festen Tiefe auszuwerten und darunter `Any`
einzusetzen. `Any` lässt alles durch, Fehler unterhalb der Grenze fielen still weg. Jeder Aufruf
erzeugte einen Typ dieser Tiefe, bei mehreren rekursiven Feldern exponentiell groß, und Hover und
Fehlermeldungen zeigten den ausgeschriebenen Baum. Die Laufzeit braucht die Verzögerung ohnehin.

Verworfen wurde für die Laufzeit auch ein Register, über das Typen per Namen nachgeschlagen werden
(wie Clojure spec). Es machte Namen zur Identität eines Typs, JUL ist aber strukturell, und das
Registrieren wäre ein Seiteneffekt beim Laden, der das Tree-Shaking der Runtime bricht
([runtime-tree-shaking.md](runtime-tree-shaking.md)). Ein zweiphasiger Aufbau (Objekt anlegen,
dann füllen) scheidet aus, weil `Or(...)`, `List(...)` usw. in der Runtime neue Objekte erzeugen
und weil jeder Aufruf `Tree(T)` einen neuen Typ baut.

Die Verzögerung per Funktion ist der übliche Weg bei strukturellen Laufzeittypen (zod
`z.lazy`, io-ts `t.recursion`, Racket `recursive-contract`).

## Checker

**Knoten.** `CompileTimeAliasType` bekommt optionale `args`. `alias(Tree, args = T)` steht für
`Tree` angewendet auf `T`. Als Erweiterung des Alias erbt die Anwendung alle Stellen, an denen
ein Alias verzögert (`resolveAlias`), anhält (`traversePlaceholders`, `forEachChildType`) und
angezeigt wird (`typeToString`, dort als `Tree(Integer)`).

**Erzeugen.** Ruft eine Typfunktion sich im eigenen Rumpf auf, ist ihr Symbol noch ohne Typ. Der
Aufruf wird dann nicht als Funktionsaufruf geprüft, sein Typ ist `TypeOf(alias(Tree, args))`. Nur
diese Stelle erzeugt Anwendungsknoten. Ein Aufruf mit Präfix-Argument (`T.Tree()`) wird nicht als
Anwendung erkannt. Ein Aufruf von außen (`Tree(Integer)` als Parametertyp)
liefert weiter den ausgewerteten Typ `[value: Integer children: Or([] List(Tree(Integer)))]`.

**Auflösen.** `dereferenceAlias` setzt die `args` in den Rückgabetyp der fertigen Typfunktion ein
und cacht das Ergebnis je Knoten.

**Einsetzen von außen.** `traversePlaceholders` steigt in die `args` eines Alias ab, nie in sein
Ziel. So wird beim Aufruf `Tree(Integer)` aus dem inneren `alias(Tree, T)` ein
`alias(Tree, Integer)`. Das endet, weil die `args` endlich sind.

**Vergleiche beenden.** Jede Auflösung von `Tree(Integer)` erzeugt einen neuen inneren Knoten.
Der Stapel, über den `getTypeErrorAtDepth` und `typeEquals` rekursive Vergleiche beenden, erkennt
Paare aber an ihrer Identität und griffe nie. Deshalb:

- Gleiches Symbol und gleiche `args` gelten ohne Auflösen als zuweisbar bzw. gleich. Das ist
  genau und deckt den häufigsten Fall ab.
- Ist eine Anwendung am Vergleich beteiligt, erkennt der Stapel ein laufendes Paar strukturell
  wieder (`typeEquals`), nicht nur an der Identität: auch die Union oder das Dictionary neben der
  Anwendung ist bei jeder Auflösung ein neues Objekt. Ohne das reichte die Fehlermeldung für
  `Tree(Text)` gegen `Tree(Integer)` bis zur Tiefenbremse hinunter, und `Bin(Integer)` gegen
  `Bin(Or(Integer Text))` meldete dort sogar einen falschen Fehler. Gewöhnliche Alias-Vergleiche
  bleiben beim billigen Identitätsvergleich.
- Für alles andere zählt ein Budget die Auflösungen von Anwendungsknoten je Vergleich. Ist es
  erschöpft, gilt das Paar als zuweisbar. Das garantiert das Ende an jeder Vergleichsstelle, auch
  an einer übersehenen; im Language Server hieße das sonst Hängen. Übersehen werden dabei nur
  Unterschiede unterhalb der Grenze, dieselbe Richtung wie beim bestehenden Stapel (im Zweifel
  zuweisbar). TypeScript beendet solche Vergleiche mit einer ähnlichen Tiefenheuristik.

**Nicht auflösen, wo nichts gefragt ist.** Zwei Stellen durchlaufen Typen, ohne dass ein Zugriff
sie treibt, und dürfen Aliase deshalb nicht blind auflösen:

- Das Normalisieren einer Union (`createNormalizedUnionType`). Ein Alias, dessen Definition noch
  geprüft wird, löst zu `Any` auf und machte `Or([] Node)` zu `Any`. Eine Anwendung wie `Bin(T)`
  direkt in einem `Or` enthielte aufgelöst wieder ein solches `Or`, das Normalisieren liefe endlos.
  Beide sind dort undurchsichtig: sie verwerfen nichts, werden nicht verworfen und gelten nur bei
  gleichem Symbol und gleichen `args` als Duplikat.
- Die Einteilung nach Typ oder Wert für die Schreibweise (`classifyTypeness`). Sie merkt sich die
  Aliase auf dem Pfad, eine Wiederholung trägt nichts bei. Ohne das liefe sie bei zwei rekursiven
  Feldern exponentiell bis zu ihrer Tiefenbremse.

**Unproduktive Zyklen.** `Loop = (T: Type) => Loop(T)` hat keine Datenebene und bekommt JUL5170,
wie `A = Or([] A)`. An dieser Zusage hängt auch die Laufzeit: die Typprüfung dort endet nur, weil
jeder Zyklus durch eine Datenebene läuft, die Wert verbraucht.

## Laufzeit

`_lazyType(name, getType)` ist ein Laufzeittyp, der erst beim Prüfen aufgelöst wird. Der Emitter
erzeugt ihn für eine Referenz im Wert der eigenen Definition (`Node`) und für einen Aufruf, den
der Checker als Anwendung markiert hat (`Tree(T)` im Rumpf von `Tree`). Die Entscheidung für den
Aufruf kommt aus dem geprüften Baum, nicht aus der Schreibweise, eine rekursive Funktion
`f = (x) => f(x)` bleibt unberührt. Der Knoten merkt sich das Ergebnis von `getType`, sonst baute
jede Prüfung auf jeder Ebene `Tree(T)` neu.

Wer Laufzeittypen verarbeitet, muss den Knoten je nach Art unterschiedlich behandeln. Die Regeln
stehen am `LazyType` in `runtime.ts`: ein Durchlauf entlang der Typstruktur hält an, ein Durchlauf
entlang eines Werts darf auflösen, wer eine Ebene hineinschaut, löst vorher auf.

## Nicht Teil dieses Schritts

Jeder Aufruf einer Typfunktion als Anwendungsknoten, sodass Hover und Fehlermeldungen überall
`Tree(Integer)` statt des ausgeschriebenen Typs zeigen. Das betrifft auch `List`, `Or` und alle
übrigen Typfunktionen und wäre ein eigener Schritt.
