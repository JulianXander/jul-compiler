# Offene Rechnungen und rigide Typvariablen

## Problem

Im Rumpf einer Funktion gilt ein Typ, der von einem Parameter abhängt, heute als seine Schranke,
sobald er auf der Zielseite einer Zuweisung steht. Gemeint ist aber der Typ des Arguments, das ein
beliebiger Aufrufer übergibt. Der Rumpf muss für **jeden** erlaubten Aufruf stimmen, nicht für
irgendeinen:

```jul
f = (x: Integer g: (y: TypeOf(x)) :> Integer) => g(5)
f(3 (y: 3) => y)
```

geht ohne Meldung durch, obwohl `g` nur `3` annimmt. Ursache: Als Ziel liefert jeder offene Typ
`assignable: undefined`, für `parameterReference` und für jede der sieben offenen Rechnungen
einzeln.

## Begriffe

- **Kopf:** `parameterReference`, die Variable, auf die eine Rechnung wartet.
- **Offene Rechnung:** die Anwendung einer Typoperation, die sich noch nicht ausrechnen ließ, weil
  ein Operand offen ist. Acht Varianten: `nestedReference` (Feld, Index, Schlüssel), `add`,
  `subtract`, `concat`, `mapElements`, `withElementAt`, `conditional` und `valueAsType` (ein
  Wert als Typ gelesen, das nackte `T` in `(T: Type v: T)`). Am Aufruf werden ihre Operanden
  eingesetzt und die Operation über ihre `*FromTypes`-Funktion bzw. `valueOf` neu ausgerechnet.
- **Keine offenen Rechnungen**, obwohl sie ähnlich aussehen: `lengthOf` ist eine feste, unbekannte
  Zahl (die Länge einer bestimmten List), auch wenn die Quelle schon feststeht. `indexRange` ist ein
  Schlüsseltyp. Beide bleiben eigene Typen.

Vorbild ist die Auswertung in Sprachen, in denen Typen Terme sind (Agda, Idris, Lean: „Normalization
by Evaluation“): Eine Rechnung, die an einer Variablen hängt, ist ein *Neutral*. Zwei Neutrale sind
genau dann gleich, wenn sie gleich gebaut sind. Als Quelle steht ein Neutral für seine Schranke,
als Ziel nur für sich selbst. TypeScript (`TypeParameter`, `IndexedAccess`, `Conditional`) und
Scala (pfadabhängige Typen `x.Elem`, Match Types) verfahren genauso.

## Bestandsaufnahme vor dem Umbau

| Stelle | parameterReference | offene Rechnungen |
|---|---|---|
| `isTypeAssignable`, Quelle | Schranke | auflösen, neu versuchen, sonst unbekannt (alle gleich; `concat` gegen `parameters` ist die Argumentkollektion) |
| `isTypeAssignable`, Ziel | unbekannt | unbekannt (alle gleich) |
| `typeEquals` | Name, Index, `deferValueOf` | strukturell; `mapElements` vergleicht den Callback als Objekt |
| `traversePlaceholders` | einsetzen bzw. Schranke | Operanden durchlaufen, über `*FromTypes` neu ausrechnen; `mapElements` lässt einen Funktions-Callback unangetastet, `conditional` durchläuft Köpfe gesondert, `nestedReference` schlägt nach |
| Nachschlagen (Feld, Index, unbekannter Schlüssel) | aufschieben | uneinheitlich: aufschieben, `undefined` oder `Any`, je nach Variante und Zugriff |
| `valueOf` | `deferValueOf` setzen | `nestedReference`, `mapElements`: `deferValueOf`; die übrigen bleiben unverändert |

## Entscheidung

Die Varianten behalten ihre Interfaces, denn in den Falt-Funktionen sind `Source`, `Index`
und `Value` lesbarer als eine generische Operandenliste. Neu ist die Kategorie
`CompileTimeOperationType` mit einer Tabelle je Operation (Operanden, Neuberechnung). Jede Relation
behandelt die Kategorie in **einem** Fall. Was eine Operation besonders macht, steht in der Tabelle
und nicht verstreut über die Relationen.

## Schritte

1. **Kategorie und Tabelle, Verhalten unverändert.** `traversePlaceholders`, `typeEquals`,
   `isTypeAssignable` (Quelle und Ziel) und `forEachChildType` behandeln offene Rechnungen über die
   Tabelle. Prüfung: Tests, Checker-Snapshot und Zähler-Gate unverändert, yugioh ohne neue Meldung,
   Bench vor und nach dem Umbau.
2. **Rigide als Ziel.** Umgesetzt in `isTypeAssignableAtDepth` (`isRigidType`). Ein offener Typ als
   Ziel nimmt einen gleichen offenen Typ auf und lehnt einen Typ ohne Platzhalter ab. Eine Quelle mit
   Platzhalter, die nicht gleich ist, bleibt unbekannt, denn es fehlt eine Rechenregel (`xs/1` gegen
   `TypeOf(xs)/ElementType`). Diese Quelle wird bewusst nicht aufgelöst: Ihre Schranke mit dem
   offenen Ziel zu vergleichen, sagt nichts. Nur `And` und `Or` werden weiter zerlegt. Nicht rigide
   ist ein Argument, das als Typ gelesen wird und auch eine Funktion sein kann (`(a: p)`): ein
   Prädikat, das die Laufzeit prüft. Rigide ist so ein Verweis nur mit der Schranke `Type`.
   Ein Parameterverweis wird jetzt als `TypeOf(x)` angezeigt statt als `x`.
   Dabei gefunden: Ein Aufruf einer übergebenen Funktion (`g(5)` mit dem Parameter `g`) prüfte seine
   Argumente gar nicht, `getParamsType` lieferte für einen Parameterverweis `Any`. Jetzt gilt der
   deklarierte Typ, roh und nicht aufgelöst, sonst stünde in seiner Signatur wieder die Schranke.
   Gezählt: yugioh und `jul-examples` melden vorher und nachher dasselbe, beide Änderungen erzeugen
   in echtem Code keine neue Meldung. Bench im direkten Wechsel alt/neu ohne messbaren Unterschied.
3. **Nachschlagen vereinheitlichen.** Umgesetzt (`waitsWithOperation`): Ein Zugriff auf eine offene
   Rechnung (Feld, Index, unbekannter Schlüssel, Typeigenschaft) wartet mit ihr auf den Aufruf,
   statt je nach Variante `undefined` oder `Any` zu liefern. `concat` behält, wo es eine eigene
   Regel hat, diese Regel: Es reicht Positionen fester Quellen vorher durch und verteilt sich über
   die Quellen. Beispiel: `TypeOf(setElement(xs 1 §a§))/ElementType` blieb nicht offen, am Aufruf mit
   `[1 2]` kam die Schranke `Or(Integer §a§)` heraus, jetzt `Or(§a§ 2)`.
   Folge im Constant Folding: Ob ein Aufruf einen Typ liefert und deshalb nicht gefaltet wird, prüft
   `tryFoldCall` jetzt am mit den Argumenten eingesetzten Rückgabetyp. Die deklarierte Form oder ihre
   Schranke reicht nicht: `AccumulatorType` hat die Schranke `Type`, liefert mit `Integer` aber eine
   Zahl.
   Gezählt: yugioh und `jul-examples` unverändert, Checker-Snapshot unverändert. Mehr Relationsprüfungen
   in yugioh (`getTypeError` +6,6 %), weil mehr Zugriffe erst am Aufruf ausgerechnet werden. Zeit im
   Wechsel alt/neu: im Mittel +1,4 % bei ±45 ms Streuung, nicht sicher nachweisbar.
4. **`deferValueOf` als Operation.** Umgesetzt: Das Flag an `parameterReference`,
   `nestedReference` und `mapElements` ist entfallen, an seiner Stelle steht die offene Rechnung
   `valueAsType` um den unveränderten Verweis. Der Name `valueOf` kam als `julType` nicht in
   Frage: Tabellen nach `julType` (`valueFieldAccess[type.julType]`) hätten die geerbte Methode
   `Object.prototype.valueOf` geliefert statt `undefined`.
   Der Knoten teilt den Parameterverweis, statt ihn zu kopieren. Die alte Kopie mit eigener Nummer
   übernahm `functionRef` nur, wenn es beim Kopieren schon gesetzt war.
   Folge in der Signatur am Aufruf (`substituteParameterProjections`): Ein Verweis wie
   `TypeOf(values)/ElementType` steht jetzt in einem `valueAsType`. Eingesetzt wird samt dieser
   Hülle, sonst käme der Typwert heraus (`TypeOf(Never)` bei `[].filter`) statt des Typs.
   Gezählt: yugioh und `jul-examples` unverändert, Checker-Snapshot und LSP-Snapshot unverändert.
   Zähler: `resolvePlaceholders` im Gate +2,4 %, weil der Knoten eine Ebene mehr ist.
   `getTypeError` in yugioh sinkt dagegen auf 1.950.080 (nach Schritt 3: 2.212.183,
   Ausgangsstand: 2.081.168), vermutlich weil die Caches den internierten Knoten wiedererkennen,
   wo früher jede Kopie eine neue Nummer hatte. Zeit im Wechsel gegen den Ausgangsstand ohne
   nachweisbaren Unterschied.
