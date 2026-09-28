# onCompleted in der core-lib

Idee, keine Entscheidung.

## Die Lücke

JUL-Code kann nicht darauf reagieren, dass ein Stream endet. `subscribe` meldet nur Werte,
`onCompleted` gibt es nur in der Runtime (`StreamClass.onCompleted`), und das Feld `completed`
ist im Checker nicht zugänglich.

Eine Quelle, die in JUL geschrieben ist, kann deshalb beim vorzeitigen Beenden nicht aufräumen. Am
Beispiel einer einmaligen Verzögerung auf Basis von `interval$`:

```jul
delay$ = (delayMs: Float value: Any) =>
	result$ = create$(Or([] TypeOf(value)) [])
	tick$ = interval$(delayMs)
	tick$.subscribe(
		(tick = value) =>
			?(tick)
				[2f] =>
					tick$.complete()
					result$.push(value)
					result$.complete()
				() => []
	)
	result$
```

Beendet der Empfänger `result$` vor Ablauf der Zeit, pusht der erste Tick auf den beendeten
Stream, und `push` wirft. Hört man über `tick$.takeUntil$(result$)` nur, solange `result$` läuft,
feuert der Listener nach dem Abbruch nicht mehr, aber gerade er hätte `tick$` beendet: Der Timer
läuft für immer. Mit den vorhandenen Mitteln bleibt die Wahl zwischen Absturz und Leak.

`delay$` selbst ist deshalb nativ umgesetzt. Die Lücke betrifft aber jede Quelle aus JUL-Code.

## Der Vorschlag

`onCompleted` aus der Runtime in die core-lib aufnehmen:

```jul
onCompleted = nativeFunction(
	(stream$: Stream(Any) callback: () :> Any) ~> []
	…
)
```

Wie in der Runtime läuft der Callback sofort, wenn der Stream schon beendet ist. Damit wird das
Beispiel korrekt:

```jul
	result$.onCompleted(() => tick$.complete())
```

Die Lebensdauer-Analyse ([stream-lifetimes.md](../stream-lifetimes.md)) wertet ein `complete` in
einem Callback schon heute als Ende, der Callback von `onCompleted` fällt darunter.

## Offen

- Reicht `onCompleted`, oder gehört ein allgemeiner Konstruktor für Quellen mit Aufräumfunktion
  dazu, wie `new Observable(subscriber => teardown)` in RxJS oder `readable(initial, set => stop)`
  in Svelte? Der deckte auch DOM-Events und WebSockets ab, die heute über `create$` und `push`
  aus TS-Code kommen, braucht aber `setTimeout` und Ähnliches als JUL-Funktionen.
- Der Auslöser: nur das Ende, oder wie `takeUntil$` auch ein neuer Wert? Für das Aufräumen genügt
  das Ende.
