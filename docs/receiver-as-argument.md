# Der Empfänger als erstes Argument

Umsetzungsplan, umgesetzt. `isTypeAssignable` kennt keinen Empfänger (`prefixArgumentType`) mehr.

## Problem

Bei `a.f(b)` ist `a` der Empfänger. `isTypeAssignable(prefixArgumentType, argumentsType,
targetType)` reicht ihn durch die ganze Prüfung, rund 64 Zeilen. Ausgewertet wird er nur in der
Prüfung einer Argumentkollektion gegen eine Parameterliste (`isTypeAssignableForParameters`,
`isTypeAssignableForParametersWithCollectionArgs`). Gesetzt wird er nur an einer Stelle, der
Argumentprüfung in `inferType`.

- Die Frage „liegt A in B?" hat keinen Empfänger, er gehört zur Frage „passt dieser Aufruf?".
- Er wandert in Prüfungen, in die er nicht gehört, etwa in Feldwerte
  (`isTypeAssignableForField(…, prefixArgumentType, …)`). Träfe eine solche innere Prüfung auf eine
  Parameterliste, würde er dort ein zweites Mal eingesetzt. Beim Vergleich zweier Funktionstypen
  steht deshalb `TODO prefixArgumentType berücksichtigen?`.

## Vorbild

Uniform Function Call Syntax: D, Nim und Koka schreiben `a.f(b)` zu `f(a, b)` um, C# (Extension
Methods), Kotlin (Extension Functions) und Rust (`self`) behandeln den Empfänger als ersten
Parameter. Die Teilmengenbeziehung kennt dort keinen Empfänger.

## Entscheidung

Am Aufruf wird der Empfänger vor die Argumente gesetzt: `Concat([prefix] args)`. Das gilt für jede
Form der Argumente gleich, auch für eine List mit Spread oder eine noch offene Kollektion.
`concatFromTypes` wird dafür nicht benutzt: Es faltet `[prefix]` vor einer List zu
`List(Or(prefix X))` und verliert damit, dass der Empfänger garantiert an erster Stelle steht.

Die Parameterprüfung liest `Concat` als Argumentkollektion: führende Tuple-Elemente, dann der Rest.

| Rest | Prüfung |
|---|---|
| keiner, Empty, Tuple | wie ein Tuple aus allen Elementen |
| Dictionary (benannte Argumente) | das führende Element bindet den ersten Parameter, die übrigen nach Namen, wie bisher mit Empfänger |
| List (Spread) | das führende Element bindet den ersten Parameter, die List beginnt dahinter, wie bisher mit Empfänger |
| Union | je Choice, verknüpft |
| noch offen | erst auflösen, sonst unknown |

Die interne Logik für einen Empfänger bleibt also, heißt aber führendes Argument und steckt nur
noch in der Parameterprüfung.

Nicht Teil dieses Plans: Die übrigen Stellen, die den Empfänger getrennt bekommen
(`dereferenceCallbackParams`, `tryFoldCall`, `bindClosureArguments`, der Rückgabetyp des Aufrufs).
Sie können später dieselbe Kollektion benutzen.

## Schritte

1. Die Parameterprüfung bekommt den Fall `concat` als Argumentkollektion. Die Quelle `concat`
   geht gegen ein Parameterziel nicht mehr in die allgemeine Regel (auflösen, sonst unknown),
   sondern an die Parameterprüfung.
2. `inferType` prüft `Concat([prefix] args)` statt `args` mit Empfänger.
3. `prefixArgumentType` fällt aus `isTypeAssignable` und allen inneren Funktionen weg, ebenso aus
   `isFieldOptional` und `isTypeAssignableForField`.

Abnahme: Suite und Checker-Snapshot unverändert (die Meldungen kommen aus derselben Logik), yugioh,
jul-examples, Language Server. Vorher und nachher messen.

## Umsetzung

- `isTypeAssignableForParameters(args, params)` liest `Concat([Empfänger] Rest)` und gibt an
  `isTypeAssignableForParametersWithLeading(leadingArgumentType, Rest, params)` weiter, das die
  bisherige Logik mit Empfänger enthält, jetzt mit `Or` als Rest (je Choice) und einem noch
  offenen Rest (erst auflösen, sonst unknown).
- Die Quelle `concat` geht gegen eine Parameterliste nicht mehr in die allgemeine Regel.
- Beim Umbau fiel ein ungetesteter Fall auf: Ein Spread über einen Parameter (`1.f(...xs)`) ist
  selbst ein offener `Concat`. Bisher löste ihn die allgemeine Regel auf, jetzt tut es die
  Parameterprüfung. Abgesichert mit drei Tests (`receiver-before-spread-…`).
- Ergebnis: Checker-Snapshot und Zähler-Baseline unverändert, yugioh, jul-examples und Language
  Server fehlerfrei.
