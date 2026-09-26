# JSON-Parser: natives `JSON.parse` gemessen und verworfen

`_parseJson` in [runtime.ts](../src/runtime.ts) ist ein handgeschriebener Parser. Er wird zur
Laufzeit als Builtin `parseJson` benutzt und beim Kompilieren für `.json`-Importe
([parser.ts](../src/parser/parser.ts) → [json-parser.ts](../src/parser/json-parser.ts)).
Geprüft wurde, ob natives `JSON.parse` ihn ersetzen kann. Ergebnis: Der eigene Parser bleibt.

## Was der Parser für JUL umwandelt

- Ganze Zahlen werden `bigint`. Dezimalzahlen werden zu einer gekürzten Fraction, oder zu `bigint`,
  wenn sie ganzzahlig sind (`normalizeRational`, wie bei Zahlenliteralen in JUL).
- `null`, `[]` und `{}` werden `undefined` (Empty), auch verschachtelt.
- Ein Feld mit Empty **bleibt als Schlüssel erhalten**. Der `.json`-Import macht daraus ein
  Dictionary-Feld. Fehlte es, wäre ein Zugriff wie `cardData.ability` in yugioh ein Typfehler.

## Warum nicht `JSON.parse`

**Mit Reviver:** Exakte Zahlen gehen nur über `context.source` (ES2025; Chrome/Edge 114, Node 21,
Firefox 135, Safari 18.4). Damit das Feld erhalten bleibt, muss Empty im Reviver zunächst `null`
bleiben und im Elternobjekt per Zuweisung zu `undefined` werden. Der Grund: Gibt ein Reviver
`undefined` zurück, löscht `JSON.parse` den Schlüssel.

Das funktionierte, war aber langsamer (`npm run bench-runtime`, ms je Million Aufrufe):

| Fall | eigener Parser | Reviver |
|---|---|---|
| `json/small` (~300 B) | 3 966 | 6 947 (+75 %) |
| `json/large` (~200 kB, viele Zahlen) | 3 627 718 | 4 950 602 (+36 %) |

Die Kosten liegen im Mechanismus selbst: Schon `(key, value) => value` als Reviver macht
`JSON.parse` etwa 7-mal langsamer als ohne Reviver. Das kostet je Wert und ist bei Zahlen und kleinen
Objekten teurer als der ganze eigene Parser. Schneller war der Reviver nur bei textlastigen Daten.

**Ohne Reviver, mit eigenem Durchlauf danach:** 1,2- bis 5-mal schneller, aber jede Zahl ist dann
schon ein Double. Exakt ist das nur bis 15 signifikante Stellen und innerhalb des Wertebereichs.
`1234567890.1234001` wird zu `…4002`, `1e400` zu `Infinity`, `1e-400` zu `0`. Die Korrektheit
hinge an einer Regex-Vorprüfung auf lange Ziffernfolgen und große Exponenten, mit dem Reviver als
Rückfall. Das ist nicht weniger Code als der eigene Parser, und die Fehler wären still.

**Der Gewinn wäre ohnehin klein:** Beim Kompilieren von yugioh macht `card-data.json` (1,8 MB)
gut 1 % von `parse+check` aus. Zur Laufzeit parst `parseJson` typischerweise eine HTTP-Antwort.

## Was stattdessen am eigenen Parser geändert wurde

- Fractions werden gekürzt: `1.50` ergibt `3/2`, `2.0` ergibt `2n`.
- Rohe Steuerzeichen unter U+0020 in Strings sind ein Fehler, wie in der JSON-Spec.
- Ein ungültiges Escape liefert eine Meldung mit Position statt eines leeren `Error`.
- Ein Schlüssel `"__proto__"` wird eigenes Feld (`Object.defineProperty`) und setzt nicht mehr den
  Prototyp. Das ist relevant bei fremdem JSON wie einer HTTP-Antwort.
- Strings werden abschnittsweise per `substring` übernommen statt Zeichen für Zeichen. Das
  Anhängen je Zeichen war der teuerste Teil. Auf yugioh `card-data.json`: 22,8 → 15,0 ms,
  damit schneller als der Reviver (19,8 ms).

Tests dazu stehen in der Region `parseJson` in [runtime.test.ts](../src/runtime.test.ts),
Bench-Fälle `json/small`, `json/large` und `json/texts` in
[bench-runtime.ts](../scripts/bench-runtime.ts).
