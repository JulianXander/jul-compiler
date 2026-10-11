# Abweichungen von den Namenskonventionen

Wo `src/runtime/core-lib.jul` von [naming.md](../naming.md) abweicht oder die Regeln noch nichts
sagen. Umbenennungen sind Breaking Changes (auch für yugioh) und noch nicht entschieden. Die
Container-Begriffe stehen in [container-nomenklatur.md](container-nomenklatur.md).

## Abweichungen

1. **Stamm von Wert- und Typfunktion.** `getElement` gehört zu `ElementAt`, die Stämme
   unterscheiden sich. Bei `add`/`Add` und `length`/`LengthOf` passt das Paar.
2. **`to` als Präfix und als Infix.** `rationalToFloat` statt `toFloat`. `toIsoDateText` hängt
   den Zieltyp an, `toList` nicht.
3. **`Concat` und `combineTexts`.** Die Typfunktion `Concat` gehört zu keiner Wertfunktion
   `concat`, `combineTexts` verbindet Texte mit einem Trenner und ist eine andere Operation.
   Offen ist, ob `Concat` einen Wertpartner bekommt und wie der Trenner-Fall heißt (`join`).
4. **Typ-Suffix an Funktionen.** `addFloat`, `subtractFloat`, `multiplyFloat`, `divideFloat`,
   `maxInteger`, `maxFloat`. Offen ist, ob der Typ den Namen trägt oder der Aufruf anhand des
   Argumenttyps aufgelöst wird (das widerspräche nicht der Klarheit, `add` löst schon so auf).
5. **Lücken in Paaren.** `lastElement` ohne `firstElement`, `greater` ohne `less`,
   `removeField` ohne `removeElement`.
6. **Gleiche Idee, verschiedene Wörter.** `map` für List, `mapDictionary` für Dictionary,
   `MapElements` als Typfunktion. `exists` und `all` statt `any` und `all`. `Rational` neben
   `Fraction`.
7. **Abkürzungen.** Der Rest-Parameter heißt `args` (`add`, `multiply`, `maxInteger` und weitere),
   Zeiten heißen `delayMs` und `timeoutMs`. Ausgeschrieben wären das `arguments` bzw. `numbers`
   und `delayMilliseconds`. Zu klären ist, ob `Ms` als bekannte Einheit durchgeht.
8. **Funktionen, die keine Verben sind.** `length`, `range`, `regex`, `currentDate` sind Nomen,
   `greater` und `all` sind Adjektive bzw. Quantoren, `equal` ist ein Adjektiv (`and`, `or`,
   `not` sind logische Operatoren und bleiben vermutlich). Mögliche Verb-Namen wären `getLength`,
   `createRange`, `getCurrentDate`, `isGreater`, `isEqual`. Zu klären ist, ob Prädikate mit `is`
   beginnen und ob Operatoren und kurze Ableitungen wie `length` Ausnahmen sind.
9. **Kommentare.** Teils englisch („Creates a new List…"), teils deutsch.

## Offene Regelfragen

- Wie heißt ein Prädikat-Callback-Parameter, und heißen Callback-Parameter überall gleich
  (`value`, `index`)?
- Gibt es eine Regel für Verneinung und Gegenstücke (`greater`/`less`, `Greater…`/`Less…`)?
