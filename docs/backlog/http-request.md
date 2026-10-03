# HTTP-Anfragen ohne verlorene Information

Idee, keine Entscheidung.

## Die Lücke

`httpTextRequest$` und `httpBlobRequest$` laufen über `httpRequest$`
([runtime.ts](../../src/runtime/runtime.ts)), das den Body sofort mit `response.text()` bzw.
`response.blob()` vollständig einliest. Dabei geht verloren:

- **Status und Header** bei Erfolg: `201` und `200` sind nicht zu unterscheiden, `Content-Type`,
  `ETag`, `Location` und die URL nach Redirects (`response.url`) sind nicht erreichbar.
- **Der Body bei Fehlern**: Bei `!response.ok` kommt nur `new Error(statusText)` an. Fehlerdetails
  einer API (etwa JSON bei 400/422) und der Statuscode selbst fehlen. Unter HTTP/2 ist
  `statusText` immer leer, der Error ist dann ganz ohne Inhalt.
- **Streaming**: Weder Fortschritt noch Verarbeitung während des Ladens (NDJSON, Antworten im Stil
  von Server-Sent-Events) noch große Dateien ohne vollständiges Puffern.
- **fetch-Optionen** wie `credentials`, `redirect`, `cache`, `mode`, `keepalive`.
- **Timeout-Semantik**: `timeoutMs` gilt für die ganze Antwort. Ein großer Download über eine
  langsame Leitung bricht ab, obwohl Daten fließen.

Was bleiben soll: `complete()` auf den Ergebnis-Stream bricht die Anfrage ab.

## Download-Fortschritt

Über `response.body.getReader()` Chunks lesen, `loaded` aufaddieren, `total` aus `Content-Length`.
Am Ende `new Blob(chunks, { type })` bzw. `TextDecoder` mit `{ stream: true }`.

Fallstricke:

- `Content-Length` fehlt oft (chunked transfer), `total` ist also optional.
- Bei `Content-Encoding: gzip`/`br` nennt `Content-Length` die komprimierte Größe, die Chunks sind
  schon entpackt: `loaded` kann `total` übersteigen. Begrenzen oder `total` dann weglassen.
- Chunks kommen teils sehr dicht. Ein Push je Chunk ist korrekt, kann eine UI aber fluten.
  Drosseln wäre Sache des Konsumenten, nicht der Runtime.

## Skizze: ein Primitiv, das nichts verbirgt

```jul
HttpProgress = [loaded: Integer total: Or([] Integer)]
HttpResponse = [status: Integer headers: Dictionary(Text) body: Blob]

httpRequest$ = nativeFunction(
	(
		url: Text
		method: Text
		idleTimeoutMs: Float
		headers: Or([] Dictionary(Text))
		body: Any
	) ~> FiniteStream(Or([] HttpProgress HttpResponse Error))
	…
)
```

- Ablauf: `()`, dann beliebig viele `HttpProgress`, dann genau ein `HttpResponse` oder `Error`,
  dann beendet. Nach dem Ende ist der letzte Wert immer das Ergebnis, wer nur das will, übergeht
  die Zwischenwerte.
- Ein Status außerhalb von 2xx ist ein `HttpResponse` mit Status und Body, kein `Error`. `Error`
  bleibt für Netzwerkfehler, Abbruch und Timeout. Das löst auch das TODO zur Fehlerbehandlung in
  `httpRequest$`.
- Unterschieden wird über `?` nach Typ, wie heute zwischen `Blob` und `Error`.
- Timeout als Leerlauf-Timeout, der bei jedem Chunk neu startet.
- `httpTextRequest$` und `httpBlobRequest$` bleiben als Abkürzungen, möglichst in JUL auf
  `httpRequest$` aufgebaut.

Verworfene Variante: zwei Streams (`[progress$ = … response$ = …]`). Einfacher zu konsumieren,
aber offen, welcher von beiden beim Beenden die Anfrage abbricht, und umständlicher im Typ.

## Upload-Fortschritt

Mit fetch nicht möglich. Streaming-Request-Bodies (`duplex: 'half'`) gibt es nur in Chromium und
über HTTP/2, einen Fortschritt liefern sie trotzdem nicht. Einziger Weg ist `XMLHttpRequest` mit
`upload.onprogress`, das es in Node nicht gibt, während die Runtime auch in CLI-Bundles läuft. Wäre
ein eigenes, nur im Browser verfügbares Builtin; zurückstellen, bis es jemand braucht.
