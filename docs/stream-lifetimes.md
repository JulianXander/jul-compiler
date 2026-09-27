# Lebensdauer von Streams

Ein Stream aus einer unendlichen Quelle (`timer$`, `create$`) läuft, bis jemand `complete` aufruft.
Vergisst man das, hält die Quelle ihre Listener und alles, was daran hängt, für immer. Der Checker
meldet das bisher nicht, Leaks bleiben still.

Dieses Dokument hält fest, welches Laufzeitmodell gilt, womit ein Stream endet und wie eine
Analyse fehlende Enden meldet.

**Stand:** Das Laufzeitmodell ist das bestehende. `takeUntil$` ist in Runtime und core-lib
vorhanden. Die Analyse ist nicht umgesetzt.

## Zwei Arten von Leak

**A: Eine Quelle läuft weiter, obwohl niemand mehr zuhört.**

```jul
elementById(§x§).onClick(
	() =>
		seconds$ = timer$(1000f)
		seconds$.map$((s) => log(s))
		# kein complete: der Timer tickt für immer
)
```

**B: An einer langlebigen Quelle sammeln sich kurzlebige Ableitungen.**

```jul
user$ = create$(…)
elementById(§x§).onClick(
	() => user$.map$((u) => u.name).subscribe(…)
	# jeder Klick hängt einen weiteren Listener an user$
)
```

B ist in UIs der häufigere Fall und schwerer zu sehen.

## Laufzeitmodell: eager, Ende nur durch `complete`

> Jeder Stream läuft ab dem Aufruf. Er endet, wenn er fertig ist oder jemand ihn beendet.
> Fehlende Beobachter stoppen nichts.

Ein Ende fließt nur abwärts: Endet eine Quelle, enden alle Ableitungen. Endet eine Ableitung,
meldet sie sich bei der Quelle ab, die Quelle läuft aber weiter.

### Warum nicht Refcount oder lazy

Das Ende eines Streams kann aus drei Richtungen kommen: von selbst (fertig), von unten (niemand
hört mehr zu) oder von außen (ein Besitzer endet). Von drei gewünschten Eigenschaften bekommt man
immer nur zwei:

| | Aufruf läuft sofort | Kein Leak ohne Besitzangabe | Speichern überlebt die UI |
|---|---|---|---|
| lazy, läuft solange beobachtet | ✗ | ✔ | ✗ |
| eager, Ende nur explizit | ✔ | ✗ | ✔ |
| eager + Refcount | ✔ | ✔ | ✗ |

- **Lazy** (Rust-Streams, TC39-Signals): Ein Aufruf tut von selbst nichts. Jeder andere
  Funktionsaufruf in JUL wertet sofort aus, ein Stream-Aufruf wäre die Ausnahme
  ([Einheitlichkeit](design-principles.md#4-einheitlichkeit)). Ein Speicher-Request, den nur ein
  Dialog beobachtet, bricht beim Schließen still ab, es werden also stille Leaks gegen stille
  Abbrüche getauscht. Dazu ändern Operatoren mit Zustand (`take$`, `flatMergeMap$`) ihre
  Bedeutung, wenn sie zwischendurch nicht beobachtet werden.
- **Eager + Refcount** braucht zwei Arten von Quellen: wiederholbare, die bei Desinteresse
  stoppen, und solche mit Wirkung, die durchlaufen müssen. Das ist die Trennung in hot und cold,
  die man jedem Stream ansehen müsste.
- **Besitzer-Scopes** (Kotlin, Trio, Solid) verlangen, dass jede Signatur einen Besitzer
  durchreicht oder ihn implizit aus dem Kontext nimmt. Implizit ist unsichtbar
  ([Klarheit](design-principles.md#2-klarheit)), explizit belastet jede Komponente.

Das eager-Modell ist einheitlich und entspricht der Erwartung, dass ein Aufruf sofort wirkt. Sein
Mangel ist nur, dass ein fehlendes Ende unsichtbar bleibt. Das behebt die Analyse, nicht die
Runtime.

## Womit ein Stream endet

Es gibt zwei Mittel, der Unterschied zwischen ihnen ist der Besitz:

- **`complete`** beendet einen Stream, der einem selbst gehört, und damit alles, was davon
  abgeleitet ist. Wer eine unendliche Quelle erzeugt, beendet sie auch.
- **`takeUntil$(source$ notifier$)`** liefert eine begrenzte Sicht auf einen geliehenen Stream.
  Sie endet beim nächsten Wert oder beim Ende von `notifier$`, `source$` bleibt unberührt.

Beispiel mit beidem ist [dialog.jul](../../jul-examples/ui/dialog/dialog.jul): Der Dialog bindet
die übergebenen Texte mit `takeUntil$(result$)`, der Aufrufer beendet seinen eigenen Timer mit
`complete`.

### Was es bewusst nicht gibt

- **Unsubscribe-Callback von `subscribe`.** Das wäre eine zweite Art, etwas zu beenden, und eine
  Pflicht auf einem Funktionswert, die der Checker nicht von einem beliebigen `() => []`
  unterscheiden kann. Ein Abonnement mit Griff ist schon `map$`, und ein Abonnement endet immer
  über einen Stream. `subscribe ~> []` bleibt.
- **`completeWith`** („beende X, sobald Y endet“). Es ist nur Zucker für ein `complete` in einem
  Callback und macht die Analyse nicht genauer, weil sie `complete` in Callbacks ohnehin
  anerkennen muss (siehe unten). Kommt erst, wenn das Muster sich häuft.
- **`takeUntil$` für eigene Quellen.** Es stoppt die Quelle nicht. Außerdem entsteht ein Kreis,
  wenn der Stream gebraucht wird, um das zu bauen, dessen Ende ihn beenden soll: `seconds$` ist
  Argument von `confirm$`, `result$` gibt es erst danach.

`takeUntil$` statt `complete` für Bindungen ist Abwägung, keine Pflicht: Das Ende steht an der
Stelle, an der die Bindung entsteht, und lässt sich nicht vergessen. Dafür passiert das Aufräumen
unsichtbar, und der Notifier bekommt eine zweite Rolle.

## Analyse

Die Analyse sucht **fehlende Absicht**, keine Beweise. Sie ist eine Warnung.

### Was als Leak zählt

Ein Stream, der nie endet, ist für sich kein Fehler: Eine Bindung auf oberster Ebene an einen
app-weiten Stream soll ewig leben. Zum Leak wird er erst, wenn er in Code entsteht, der wiederholt
läuft.

> Warnung, wenn etwas, das nie endet, in einem Callback entsteht.

Code auf oberster Ebene läuft einmal und ist ausgenommen.

### Wann ein Stream endet

| Ausdruck | endet, wenn |
|---|---|
| `completed$`, `httpTextRequest$`, `httpBlobRequest$` | immer |
| `create$`, `timer$` | irgendwo steht ein `complete` darauf, auch in einem Callback |
| `map$(s)` | `s` endet |
| `flatMergeMap$(s f)`, `flatSwitchMap$(s f)` | `s` endet und die Streams, die `f` liefert, enden |
| `combine$(a b …)` | alle enden |
| `take$(s n)` | immer |
| `takeUntil$(s n)` | immer |
| `subscribe` auf `s` | `s` endet, `subscribe` ist keine eigene Pflicht |

`complete` in einem Callback wird anerkannt, obwohl nicht beweisbar ist, dass der Callback läuft.
Ohne das wäre jedes `create$`-Muster rot: `result$` in `confirm$` endet nur im
`onDialogClose`-Callback. `take$` und `takeUntil$` gelten als begrenzt, auch wenn ihr Ende von
künftigen Werten abhängt. `takeUntil$(s clicks$)` endet beim nächsten Klick, das ist Absicht.

Die Pflicht hängt an der Quelle, nicht an der Sicht darauf. In
`timer$(1000f).takeUntil$(response$)` endet die Sicht mit der Antwort, der Timer läuft aber weiter
und wird deshalb gewarnt. Ebenso stoppt `flatSwitchMap$` beim Umschalten nur das Abonnement auf
den vorigen inneren Stream: Liefert `f` einen `timer$`, entsteht er in einem Callback und wird
gewarnt, liefert `f` einen HTTP-Request, endet dieser von selbst.

### Zusammenfassungen je Funktion

Für JUL-Funktionen wird abgeleitet, was sie mit Streams tun, ohne Annotationen:

- **Rückgabe:** endet von selbst (`confirm$`: `complete` auf `result$` im Rumpf), endet mit einem
  Parameter, oder die Pflicht geht an den Aufrufer.
- **Parameter:** Ruft die Funktion `complete` darauf, übernimmt sie den Besitz. Hängt sie ein
  Abonnement ohne `takeUntil$` daran, endet es mit dem Parameter, geprüft wird an der
  Aufrufstelle. Mit `takeUntil$` endet es unabhängig davon (`bindText`).

Eine Pflicht wandert über die Zusammenfassungen nach oben. Erreicht sie die oberste Ebene, ist
sie erfüllt. Erreicht sie ein Lambda, das als Callback übergeben wird (`onClick`, `subscribe`,
`map$`), wird gewarnt: am erzeugenden Ausdruck, bzw. am Argument, wenn die Pflicht aus einem
Aufruf kommt.

```jul
elementById(§delete§).onClick(
	() =>
		seconds$ = timer$(1000f)        # Warnung: endet nie, entsteht bei jedem Klick neu
		…
)

user$ = create$(…)                     # oberste Ebene: keine Pflicht
elementById(§x§).onClick(
	() => user$.map$((u) => …).subscribe(…)   # Warnung: user$ endet nie
)
```

### Grenzen

- Ein `complete`, das nur auf einem nie erreichten Pfad steht, fällt nicht auf.
- Ein Stream, der in einer Liste oder einem Dictionary abgelegt wird, gilt als weitergegeben.
- TS/JS-Importe liefern `Any`. Übergaben dorthin gelten als geliehen, von dort gelieferte Streams
  erzeugen keine Pflicht.
- Rekursion braucht einen Fixpunkt über die Zusammenfassungen oder bricht konservativ ab.

## Umsetzung

1. Die Tabelle für die Builtins im Checker nach Namen hinterlegen. Eine Syntax in `core-lib.jul`
   erst, wenn weitere Quellen dazukommen.
2. Innerhalb einer Funktion: „endet“ je Ausdruck ableiten, `complete` im selben Rumpf samt
   Closures suchen, in Callback-Lambdas warnen. Das deckt Leak A ab.
3. Zusammenfassungen je Funktion für Rückgabe und Parameter. Damit werden Leak B und die
   Weitergabe über Funktionsgrenzen erkannt.
4. Tests über `expectCheck(code, { errors })`: je eine Zeile der Tabelle, dazu das Dialog-Beispiel
   mit und ohne `seconds$.complete()`.
