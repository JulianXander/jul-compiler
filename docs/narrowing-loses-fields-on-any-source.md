# Verengung über einen Feldpfad löscht die übrigen Felder, wenn die Quelle Any ist

Rot als `branch-narrowing-through-any-source-keeps-other-fields` in
[checker.test.ts](../src/checker/checker.test.ts).

## Der Fehler

```jul
start: [boards: Integer index: Or([] Integer)] = [boards = 1 index = 1]
s = assume(start Any)
?(s/index)
	[Integer] => 0
	() =>
		result: [boards: Integer index: Or([] Integer)] = s
		result
```

Im `catchAll`-Zweig ist `s/index` auf `Not(Integer)` verengt. Der Checker leitet daraus für `s`
selbst `[index: Not(Integer)]` ab — ein Dictionary mit **einem** bekannten Feld. Die Zuweisung an
`result` scheitert, weil `boards` darin fehlt und als `Empty` gilt.

Gefunden über echten Code (`resolveChainLink` in einem externen JUL-Projekt), dort mit `aggregate`
statt `assume`: der Rückgabetyp von `aggregate` ist in der core-lib nicht generisch über den
Akkumulator (`accumulator: Any` in der Signatur), ein durchgereichter `GameState` wird darüber zu
`Any`. Das ist eine eigene, separate Lücke (siehe Abschnitt „Verwandtes, aber nicht Gegenstand"),
hier interessiert nur, was danach mit der Verengung passiert.

## Warum es passiert

`withNarrowedPath` in [checker.ts](../src/checker/checker.ts#L1193) läuft bei einem Feldpfad wie
`s/index` rückwärts zur Quelle und bildet dort den Schnitt:

```ts
const sourceType = getNarrowedType(result, sourcePath.symbol, sourcePath.keys)
	?? source.typeInfo?.type
	?? { julType: 'any' };
narrowedType = createNormalizedIntersectionType([
	sourceType,
	createCompileTimeDictionaryLiteralType({ [key]: narrowedType }),
]);
```

`createNormalizedIntersectionType` behandelt `Any` als neutrales Element (`And(A Any) => A`,
[checker.ts:2602](../src/checker/checker.ts#L2602)) — mengentheoretisch korrekt, `Any` ist die
Allmenge. Das Ergebnis ist aber `[index: Not(Integer)]`, und `CompileTimeDictionaryLiteralType`
([syntax-tree.ts:721](../src/syntax-tree.ts#L721)) ist ein **geschlossener** Typ: `Fields` gilt als
die vollständige Feldliste. Genau das prüft `getDictionaryLiteralTypeError`
([checker.ts:3664](../src/checker/checker.ts#L3664)):

```ts
const argument: CompileTimeType = argumentsType.Fields[fieldName] ?? { julType: 'empty' };
```

Ein Feld, das nicht in `Fields` steht, gilt als `Empty` — richtig für ein echtes Dictionary-Literal
wie `d = [a = 1]` (dort *ist* `b` tatsächlich nicht vorhanden, siehe `unknown-dictionary-field`),
falsch für einen aus `Any` **erfundenen** Fakt. Der Branch beweist nur etwas über `index`; über
`boards` sagt er nichts, und „nichts wissen" darf laut `dictionary-field-on-unknown-type` nicht zu
„gibt es nicht" werden. `createCompileTimeDictionaryLiteralType({ index: … })` kann diesen
Unterschied nicht ausdrücken — es gibt in der Repräsentation kein „offenes Dictionary, mindestens
dieses Feld, Rest unbekannt".

## Optionen

### A — Verengung bei Any-Quelle abbrechen

In der Rückwärts-Schleife: ist `sourceType.julType === 'any'`, keinen Fakt für diese Quelle setzen
und die Schleife an dieser Stelle beenden (höhere Glieder der Kette wären ohnehin von derselben
Unkenntnis betroffen).

- kleinster Eingriff, eine Bedingung in `withNarrowedPath`
- verliert eine echte Verengung: `s/index` bleibt weiterhin lesbar, aber `s` selbst bekommt keinen
  schärferen Typ mehr, obwohl der Fakt „hat mindestens `index`" korrekt wäre
- deckt genau den beobachteten Fall ab; andere Quelltypen (z. B. ein bereits bekanntes Dictionary)
  sind nicht betroffen, weil dort `sourceType` kein `any` ist

### B — offener Dictionary-Typ als eigenes Konstrukt

`CompileTimeDictionaryLiteralType` um ein Flag `open: boolean` erweitern (oder einen neuen
`julType` einführen). Bei `open: true` gilt: bekannte Felder wie deklariert, unbekannte Felder sind
unbekannt, nicht `Empty`. `getDictionaryLiteralTypeError` müsste für fehlende Felder bei `open` auf
„kein Fehler" statt auf `Empty` umschalten, jede Stelle, die `Fields` direkt iteriert
(`dictionaryTypeToString`, Destructuring, Aufruf-Prüfung, …) müsste das Flag kennen.

- löst das Problem an der Wurzel, für jeden Fall mit unbekannter Quelle einheitlich
- größter Eingriff: `Fields` wird an vielen Stellen im Checker gelesen
  ([checker.ts:412](../src/checker/checker.ts#L412),
  [:477](../src/checker/checker.ts#L477), [:771](../src/checker/checker.ts#L771),
  [:1640](../src/checker/checker.ts#L1640), [:3207](../src/checker/checker.ts#L3207),
  [:3675](../src/checker/checker.ts#L3675) u. a.), jede Stelle muss entscheiden, ob offen/geschlossen
  für sie etwas ändert
- Risiko: ein vergessener Ort behandelt „offen" weiterhin als „geschlossen" und der Fehler kehrt an
  anderer Stelle zurück

### C — Fakt als Schnitt mit dem Ursprungstyp statt mit Any

Statt `sourceType ?? { julType: 'any' }` als Startpunkt zu nehmen, bei `Any` stattdessen den
**deklarierten** Typ vor dem Verlust verwenden — hier also den Typ von `start` vor dem `assume`.

- verhindert den konkreten Fall, weil `s` dann faktisch nie wirklich `Any` wäre
- passt nicht zur Absicht von `assume`: das ist der bewusste, ausdrückliche Weg, Typwissen
  wegzuwerfen (vgl. `dictionary-field-on-unknown-type`, wo `Any` bewusst „ich weiß es nicht"
  bedeutet). Für `aggregate` gibt es keinen „Typ vor dem Verlust" mehr, sobald die core-lib-Signatur
  auf `Any` verengt hat — die Information ist zu diesem Zeitpunkt bereits weg, nicht nur versteckt
- verworfen: verwechselt zwei verschiedene Ursachen (bewusstes `assume`, verlorene Generizität in
  `aggregate`) und würde nur den ersten Fall zufällig verdecken

### D — Kombination: A jetzt, B falls weitere Fälle auftauchen

A behebt den beobachteten Bug minimal und ohne Repräsentationsänderung. Zeigen sich weitere Stellen,
an denen „offenes Dictionary" gebraucht wird (z. B. wenn `aggregate` generisch über den Akkumulator
gemacht wird und ähnliche Fälle mit `Or(Any …)` statt reinem `Any` auftreten), ist B der Umbau, der
das grundsätzlich löst.

## Verwandtes, aber nicht Gegenstand

`aggregate` in [core-lib.jul:753](../src/core-lib.jul#L753) ist nicht generisch über den
Akkumulator (`initialValue: Any`, `callback: (accumulator: Any …) :> Any`, nur `value` ist über
`TypeOf(values)/ElementType` generisch). Ein konkret getypter Startwert wird dadurch beim
Durchreichen zu `Any`, unabhängig vom hier beschriebenen Verengungs-Bug. Eigenes Thema, eigene
Entscheidung.

## Empfehlung

A. Kleinster Eingriff, behebt den roten Test, führt keine neue Repräsentation ein, deren
Vollständigkeit an vielen Stellen im Checker neu geprüft werden müsste.

## Umgesetzt: B, nicht A

Gewählt wurde doch B: `CompileTimeDictionaryLiteralType` hat jetzt ein Pflichtfeld
`complete: boolean` (kein Default), das an jeder der acht Erzeugungsstellen explizit gesetzt wird -
`true` bei echten Literalen, `false` beim Fakt aus `withNarrowedPath`. Zwei Konsumenten mussten
angepasst werden: `hasKnownFields` liefert für `dictionaryLiteral` jetzt `type.complete` statt
pauschal `true`, und `getDictionaryLiteralTypeError` überspringt ein fehlendes Feld ohne Fehler,
wenn die Quelle `complete: false` ist, statt es als `Empty` zu werten.

Grund für den Kurswechsel: A hätte die Verengung bei `Any`-Quelle stumm abgeschaltet und damit
`s/boards` selbst wieder auf `Any` zurückfallen lassen - der Zugriff wäre zulässig geblieben, aber
ohne den Typ `Integer`. B erhält die Präzision für die tatsächlich bekannten Felder und behandelt
nur die unbekannten korrekt als unbekannt.

Bestätigt gegen den ursprünglichen externen Fall: `Can not assign Empty to [GameBoard GameBoard]`
tritt nicht mehr auf. Übrig bleiben dort zwei fremde Fehler - einer ganz unabhängig, einer exakt das
oben unter „Verwandtes, aber nicht Gegenstand" beschriebene Folgeproblem der nicht-generischen
`aggregate`-Signatur, das weiterhin sein eigenes Thema ist.
