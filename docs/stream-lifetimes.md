# Lebensdauer von Streams

Ein Stream aus einer unendlichen Quelle (`interval$`, `create$`) läuft, bis jemand `complete` aufruft.
Vergisst man das, hält die Quelle ihre Listener und alles, was daran hängt, für immer. Der Checker
meldet das bisher nicht, Leaks bleiben still.

Dieses Dokument hält fest, welches Laufzeitmodell gilt, womit ein Stream endet und wie eine
Analyse fehlende Enden meldet.

**Stand:** Das Laufzeitmodell ist das bestehende. `takeUntil$` und der Pflicht-Timeout für
HTTP-Requests sind umgesetzt, ebenso `FiniteStream` als Typ mit den Rückgabetypen der core-lib
und die Analyse innerhalb eines Rumpfs mit der Warnung JUL2800 (Umsetzung, Schritte 1 und 2,
[stream-lifetime.ts](../src/checker/stream-lifetime.ts)) und das Abschalten per `#ignore`
(Schritt 3, [comment-directives.ts](../src/parser/comment-directives.ts), Quick Fix im Language Server). Offen
sind die Zusammenfassungen je Funktion.

## Zwei Arten von Leak

**A: Eine Quelle läuft weiter, obwohl niemand mehr zuhört.**

```jul
elementById(§x§).onClick(
	() =>
		seconds$ = interval$(1000f)
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

### Wann gewarnt wird

> Warnung bei jedem Stream, der nicht endet, und bei jedem Abonnement auf einen solchen, egal wo
> es steht.

Ob ein Stream, der nicht endet, Absicht ist, weiß nur der Autor. Er sagt es, indem er die Warnung
an dieser Stelle per Kommentar abschaltet. Das ist das allgemeine Abschalten für jeden
Warnungscode, kein eigener Weg nur für Streams. Der Kommentar ist zugleich Dokumentation: An
`gameUiState$ = create$(…)` sagt er dem Leser, dass der Stream absichtlich mit der App lebt.

Eine Ausnahme für Code auf oberster Ebene gibt es nicht. Dort läuft Code zwar nur einmal, ein
Stream, der nicht endet, wächst also nicht. Die Ausnahme verlangte aber beim Lesen mitzudenken, wo
ein Stream über Rückgaben am Ende landet, und für jeden Funktionsrumpf zu entscheiden, ob er
wiederholt läuft. Ohne sie gibt es ein Modell ohne Sonderfall. Der Preis ist ein Kommentar an jedem
gewollt ewigen Stream, in Yugioh an den sechs Zustands-Streams. Nebenbei erfasst die Regel auch
CLI-Programme, die wegen eines laufenden Timers nicht enden.

Gewarnt wird einmal je Ursache. Leitet der Code im selben Rumpf von einer eigenen Quelle ab, die
nicht endet, oder abonniert sie, deckt die Warnung an der Quelle das mit ab. Ein Abonnement wird
eigens gewarnt, wenn der Stream geliehen ist, also Parameter ist oder aus einem umgebenden Rumpf
oder von oberster Ebene stammt. Das ist Leak B.

### Wann ein Stream endet: `FiniteStream`

Ob ein Stream endet, steht in seinem Typ. `FiniteStream(T)` ist eine Teilmenge von
`Stream(T)`: Es fordert zusätzlich, dass der Stream endet, und ist deshalb überall einsetzbar, wo
`Stream(T)` verlangt wird. `Stream(T)` sagt über das Ende nichts zu, „endet nie“ ist kein
eigener Typ, denn das kann niemand zusichern.

Im Checker ist `FiniteStream` keine eigene Typart, sondern ein Merkmal `finite` an
`CompileTimeStreamType`, so wie `purity` an `CompileTimeFunctionType`. `FiniteStream(T)` ist nur
die Schreibweise dafür in der core-lib und im Hover, so wie die Pfeile `->` und `~>` die
Schreibweise für die Reinheit sind.

Native Quellen deklarieren es in ihrer Signatur in der core-lib, Operatoren leiten es über bedingte
Rückgabetypen (`:?`) aus ihren Argumenten ab:

| Ausdruck | Typ |
|---|---|
| `completed$`, `httpTextRequest$`, `httpBlobRequest$` | `FiniteStream` |
| `create$`, `interval$` | `Stream` |
| `map$(s)` | `FiniteStream`, wenn `s` einer ist |
| `flatMergeMap$(s f)`, `flatSwitchMap$(s f)` | `FiniteStream`, wenn `s` einer ist und `f` einen liefert |
| `combine$(a b …)` | `FiniteStream`, wenn alle einer sind |
| `take$(s n)`, `takeUntil$(s n)` | `FiniteStream` |

Die Operatoren brauchen dafür keinen neuen Mechanismus. Alle nötigen Formen von `:?` sind in der
core-lib schon im Einsatz: mehrere Argumente (`subtract`), das Muster `[List(…)]` über `TypeOf`
eines Rest-Parameters (`add`) und der Rückgabetyp eines Funktionsarguments
(`TypeOf(transform$)/ReturnType`):

```jul
map$ = nativeFunction(
	(source$: Stream(Any) transform$: …)
		~>
			:?(TypeOf(source$))
				[FiniteStream(Any)] => FiniteStream(TypeOf(transform$)/ReturnType)
				() => Stream(TypeOf(transform$)/ReturnType)
	…
)
combine$ = nativeFunction(
	(...sources: Or([] List(Stream(Any))))
		~>
			:?(TypeOf(sources))
				[List(FiniteStream(Any))] => FiniteStream(…)
				() => Stream(…)
	…
)
flatMergeMap$ = nativeFunction(
	(source$: Stream(Any) transform$: …)
		~>
			:?(TypeOf(source$) TypeOf(transform$)/ReturnType)
				[FiniteStream(Any) FiniteStream(Any)] => FiniteStream(TypeOf(transform$)/ReturnType/ValueType)
				() => Stream(TypeOf(transform$)/ReturnType/ValueType)
	…
)
```

`flatSwitchMap$` entspricht `flatMergeMap$`. Das passt zur Runtime: `flatMerge$` endet, wenn die
Quelle und alle inneren Streams enden, `flatSwitch$`, wenn die Quelle und der aktuelle innere
Stream enden. `map$` schaut nur auf `source$`: Liefert `transform$` selbst Streams, endet das
Ergebnis trotzdem mit `source$`.

Bei gemischten Argumenten, also endlichen und nicht endlichen Streams zusammen, greift bei
`combine$` der catchAll. Ohne Argumente greift `[List(FiniteStream(Any))]`: Alle Quellen enden
dann von Anfang an. Die Runtime liefert in dem Fall ihren Wert und beendet den Stream sofort.

HTTP-Requests enden sicher, weil der Timeout Pflicht ist: Kommt die Antwort nicht rechtzeitig
vollständig an, wird abgebrochen und der Stream liefert einen Error.

Ein Stream aus `create$` ist ein `FiniteStream`, wenn im Rumpf, in dem er entsteht, ein
`complete` darauf steht, auch in einem Callback. Das ist eine Inferenz aus dem Rumpf wie bei
der Reinheit von JUL-Funktionen. Sie gilt für das Symbol überall, im Rumpf ebenso wie nach außen,
und schon an der Definition: Ob der Stream endet, ist eine Eigenschaft des ganzen Streams, nicht
der Stelle, an der man ihn betrachtet. Der Preis ist, dass der Typ an der Definitionszeile von
einer späteren Zeile abhängt. Der Checker braucht dafür vor dem Ableiten der Typen einen Durchgang
über den Rumpf, der die `complete`-Aufrufe je Symbol einsammelt. Ein `complete` über einen
Umweg, etwa über ein zweites Symbol, erkennt er nicht, dafür gibt es die Angabe unten.

Anerkannt wird ein `complete` in einem Callback, obwohl nicht beweisbar ist, dass der Callback
läuft. Ohne das wäre jedes `create$`-Muster rot: `result$` in `confirm$` endet nur im
`onDialogClose`-Callback. Nach außen liefert `confirm$` damit einen `FiniteStream`.

Wer einen Rückgabetyp `FiniteStream` selbst hinschreibt, dem wird geglaubt. Der Checker prüft das
nicht nach, auch nicht, wenn der Rumpf nur einen `Stream` liefert. So wird es auch bei den nativen
Quellen gehandhabt, deren Signatur in der core-lib ebenfalls nur deklariert ist. Die Angabe ist
der Ausweg, wenn die Inferenz ein Ende nicht erkennt, etwa weil `complete` in einer anderen
Funktion aufgerufen wird.

`take$` und `takeUntil$` gelten als endlich, auch wenn ihr Ende von künftigen Werten abhängt.
`takeUntil$(s clicks$)` endet beim nächsten Klick, das ist Absicht.

`FiniteStream` heißt deshalb „keine Pflicht für den Empfänger“, nicht „das Ende ist garantiert“.
Ob die Runtime den Stream beendet oder der Besitzer, macht für den Empfänger keinen Unterschied,
selbst terminierende und manuell beendete Streams werden nicht unterschieden. Hinter demselben Typ
stehen aber Zusagen verschiedener Stärke:

| Herkunft | Ende |
|---|---|
| `completed$`, HTTP-Requests | garantiert durch die Runtime |
| `take$`, `takeUntil$` | abhängig davon, dass künftige Werte kommen |
| `create$`, `interval$` mit `complete` im Rumpf | abhängig davon, dass der Codepfad mit `complete` läuft |
| selbst geschriebenes `~> FiniteStream(…)` | geglaubt |

Für die Analyse reicht das, sie sucht fehlende Absicht. Braucht einmal eine Funktion ein
garantiertes Ende, etwa um darauf zu warten, ist zwischen „garantiert“ und „beabsichtigt“ zu
unterscheiden, nicht zwischen selbst terminierend und manuell beendet.

Zur Laufzeit ist `FiniteStream` wie `ValueType` nicht prüfbar. In einem Branch-Muster ist es
deshalb nur erlaubt, wenn der Eingang schon endlich ist, sonst ist es ein Fehler: Zur Laufzeit
passte der Zweig auf jeden Stream. Über Eigenschaften eines Streams zu verzweigen ergibt keinen
Sinn, nur über die Frage, ob etwas ein Stream ist. Die Regel gilt allgemein für Typen, die die
Runtime gröber prüft als der Checker, und steht im [TODO](../TODO).

Ein Abonnement endet mit seinem Stream. `subscribe` auf einen `FiniteStream` ist deshalb
unbedenklich. `subscribe` auf einen geliehenen `Stream`, der kein `FiniteStream` ist, wird
gewarnt: Das ist Leak B, jeder Aufruf hängt einen weiteren Listener an die Quelle. Abhilfe ist
`takeUntil$` vor dem `subscribe`.

Die Pflicht hängt an der Quelle, nicht an der Sicht darauf. In
`interval$(1000f).takeUntil$(response$)` endet die Sicht mit der Antwort, der Timer läuft aber weiter
und wird deshalb gewarnt. Dasselbe gilt für `take$`: In Yugioh startet
`interval$(2000f).take$(1).map$(…)` in `game-logic.jul` bei jeder aufgelösten Kette einen Timer, der
nach dem ersten Wert ohne Listener für immer weitertickt. Ebenso stoppt `flatSwitchMap$` beim
Umschalten nur das Abonnement auf den vorigen inneren Stream: Liefert `f` einen `interval$`, wird er
gewarnt, liefert `f` einen HTTP-Request, endet dieser von selbst.

#### Verworfene Alternativen

- **Namensliste im Checker:** unsichtbar in der core-lib, jede neue Quelle braucht eine Änderung
  am Checker.
- **Merkmal an der Funktion, wie die Reinheitspfeile** (Vorbild: der Effekt `div` in Koka):
  „endet“ ist eine Eigenschaft des Werts. Wird der Stream in einer Variablen, einer Liste oder als
  Parameter weitergereicht, geht ein Merkmal der erzeugenden Funktion verloren.
- **Pflicht-Typparameter `Stream(T Finite)`:** Ohne Standardwerte müsste jede Stream-Annotation
  das Merkmal nennen.
- **Optionales Flag als Schreibweise, `Stream(T finite = true)`**, fehlend heißt „keine Zusage“:
  Operatoren könnten es mit `source$/finite` durchreichen statt über `:?`. Verworfen, weil
  `FiniteStream(Text)` an der Stelle, an der es steht, ohne Wissen über den Parameter lesbar ist.
- **Bedingtes Merkmal wie `pureIfArgsPure`**, also endlich, wenn alle Stream-Argumente endlich
  sind und alle Funktionsargumente endliche Streams liefern: Es braucht eine eigene Schreibweise,
  weil es nicht von selbst gelten darf. `interval$` hat kein Stream-Argument und wäre sonst endlich.
  Bei `map$` mit einer Transformation, die Streams liefert, wäre es zu streng. `:?` leistet
  dasselbe ohne neuen Mechanismus und genauer.

### Zusammenfassungen je Funktion

Für JUL-Funktionen wird abgeleitet, was sie mit Streams tun, ohne Annotationen:

- **Rückgabe:** endet von selbst (`confirm$`: `complete` auf `result$` im Rumpf), endet mit einem
  Parameter, oder die Pflicht geht an den Aufrufer.
- **Parameter:** Ruft die Funktion `complete` darauf, übernimmt sie den Besitz. Hängt sie ein
  Abonnement ohne `takeUntil$` daran, endet es mit dem Parameter, geprüft wird an der
  Aufrufstelle. Mit `takeUntil$` endet es unabhängig davon (`bindText`).

Eine Pflicht wandert über Rückgaben nach oben bis zu der Stelle, an der der Stream landet, ohne
beendet oder weitergegeben zu werden. Dort wird gewarnt: am erzeugenden Ausdruck, bzw. am Aufruf,
wenn die Pflicht aus einer Funktion kommt. Eine Fabrik wie `clock$ = (ms: Float) => interval$(ms)`
wird also nicht selbst gewarnt, sondern jede Stelle, die `clock$(…)` aufruft und das Ergebnis
nicht beendet.

**Unkündbare Pflicht:** Gibt eine Funktion nur eine Ableitung ihrer eigenen Quelle zurück, etwa
`() => interval$(1000f).map$(…)`, kann der Aufrufer die Quelle nicht beenden. Beendet er die
Ableitung, läuft der Timer weiter, weil ein Ende nur abwärts fließt. Der Fehler liegt in der
Funktion, unabhängig davon, wer sie aufruft, deshalb steht die Warnung an der Quelle in der
Funktion und nicht beim Aufrufer. Abhilfen:

- **Die Quelle mit zurückgeben**, der Aufrufer beendet sie:

  ```jul
  secondsText = () =>
  	seconds$ = interval$(1000f)
  	[
  		source$ = seconds$
  		text$ = seconds$.map$((s) => §§(s) s§)
  	]
  ```

- **Die Quelle als Parameter annehmen**, statt sie selbst zu erzeugen. Der Aufrufer besitzt sie
  von vornherein, so wie `seconds$` im Dialog-Beispiel:

  ```jul
  secondsText$ = (seconds$: Stream(Float)) =>
  	seconds$.map$((s) => §§(s) s§)
  ```

Beendet die Funktion ihre Quelle selbst, gleich wodurch ausgelöst, ist die Quelle ein
`FiniteStream` und es gibt keine unkündbare Pflicht. Das folgt aus der allgemeinen Regel
„`complete` im Rumpf“ und braucht keine eigene Form.

```jul
elementById(§delete§).onClick(
	() =>
		seconds$ = interval$(1000f)        # Warnung: endet nie
		…
)

user$ = create$(…)                     # Warnung, per Kommentar abgeschaltet: lebt mit der App
elementById(§x§).onClick(
	() => user$.map$((u) => …).subscribe(…)   # Warnung: user$ ist geliehen und endet nie
)
```

### Grenzen

- Ein `complete`, das nur auf einem nie erreichten Pfad steht, fällt nicht auf.
- Ein Stream, der in einer Liste oder einem Dictionary abgelegt wird, gilt als weitergegeben.
- TS/JS-Importe liefern `Any`. Übergaben dorthin gelten als geliehen, von dort gelieferte Streams
  erzeugen keine Pflicht.
- Rekursion braucht einen Fixpunkt über die Zusammenfassungen oder bricht konservativ ab.
- Als Quelle gilt ein Aufruf, der einen Stream ohne Zusage liefert und selbst keinen Stream als
  Argument bekommt, auch keine Kollektion von Streams. Eine Funktion, die einen Stream annimmt und
  einen eigenen, neuen zurückgibt, wird deshalb an der Aufrufstelle nicht gemeldet, bis die
  Zusammenfassungen je Funktion kommen.
- Das `complete` wird syntaktisch nach Namen gesucht, vor dem Ableiten der Typen: `complete(x)`
  und `x.complete()`. Nicht erkannt werden die benannte Form `complete(stream$ = x)` und ein
  `complete` über ein zweites Symbol. Bindet ein verschachtelter Rumpf denselben Namen neu, zählt
  sein `complete` trotzdem für den äußeren.

## Umsetzung

1. `FiniteStream` als Typ: Merkmal an `CompileTimeStreamType`, Teilmengenbeziehung in
   `getTypeError` und `typeEquals`, Rückgabetypen der Builtins in der core-lib. Vorher und nachher
   messen.
2. Innerhalb einer Funktion: `complete` im selben Rumpf samt Closures suchen, `create$`-Streams
   danach als `FiniteStream` führen, Streams ohne Ende warnen. Das deckt Leak A ab.
3. Warnungen per Kommentar abschalten (`#ignore`, siehe [TODO](../TODO)). Ohne das ließen
   sich die gewollt ewigen Zustands-Streams, etwa in Yugioh, nicht still stellen.
4. Zusammenfassungen je Funktion für Rückgabe und Parameter. Damit werden Leak B, die
   Weitergabe über Funktionsgrenzen und die unkündbare Pflicht erkannt.
5. Tests über `expectCheck(code, { errors })`: je eine Zeile der Tabelle, dazu das Dialog-Beispiel
   mit und ohne `seconds$.complete()`.
