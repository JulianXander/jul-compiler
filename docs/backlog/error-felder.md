# Felder eingebauter Typen in der core-lib deklarieren

Schritt 1 (`native`) und 2 (Felder von `Error`) sind umgesetzt, Schritt 3 (Stream) ist offen.
Anlass ist `Error/message`. Der Entwurf vereinigt dafür `nativeFunction` und `nativeValue` zu
`native`.

## Ausgangslage

`Error` ist ein eigener eingebauter Typ (`julType: 'error'`), kein Record. Er ist nominal: Zur
Laufzeit prüft `_isOfType` mit `instanceof Error`, ein Record `[message = §x§]` ist kein Error.
Darauf beruht die Verengung `?(x) [Error] => …`, die `Error` sauber aus `Or(GameState Error)`
herausnimmt.

Sein einziges Feld `message` steht nirgends im Quelltext:

- In der core-lib steht nur `Error = nativeValue(§_Error§)`. Den Checker-Typ des Namens liefert
  `coreBuiltInSymbolTypes` in `checker.ts` (`Error: createCompileTimeTypeOfType(builtinError)`),
  das `nativeValue` zählt nur für Emitter und Runtime.
- Den Typ von `x/message` liefert `valueFieldAccess.error` in `type-algebra.ts`, fest verdrahtet:
  `name === 'message' ? builtinText : undefined`.
- Der Language Server kennt das Feld deshalb nur als Typ, nicht als Deklaration.
  `getFieldSymbolsFromDictionaryType` (`reference-index.ts`) findet bei `error` nichts: Go to
  Definition und Referenzen auf `message` gehen nicht, der Hover hat keinen Doku-Kommentar. Die
  Vervollständigung hat einen eigenen Sonderfall (`case 'error'` in `completion.ts`).

Dasselbe gilt für `getValue` am Stream (`valueFieldAccess.stream`, Typ aus
`getStreamGetValueType`).

Anlass: In yugioh ersetzt `x/message.equal()` die Hilfsfunktion `getErrorMessage`. Records sind
geschlossen, `/message` ist für jeden Nicht-Error ohne eigenes Feld `message` Empty. An dieser
Stelle springt Go to Definition ins Leere.

## `native` statt `nativeFunction` und `nativeValue`

Beide Konstrukte meinen dasselbe: Dieser Wert kommt aus JS. Sie unterscheiden sich nur darin, woher
der Checker den Typ nimmt. `nativeFunction(FunctionType js)` nennt ihn als erstes Argument,
`nativeValue(js)` liefert `Any`, und für die zwölf Typwerte (`true`, `Integer`, `Error` …) kommt der
Typ aus `coreBuiltInSymbolTypes`. Der JS-Text wird in keinem der beiden Fälle emittiert, er ist
Referenz für Menschen (`runtime.ts`, Abschnitt builtins). Da Typen in JUL Werte sind, ist eine
Signatur auch nur ein Typ. Es bleibt ein Konstrukt:

```jul
native(
	ValueType: Type
	js: Text
	Fields: Or([] Type)
)
```

- `Fields` in PascalCase wie `ValueType`: Der Parameter hält einen Typ (JUL2600).
- `ValueType` ist der Typ des Werts selbst, bei einer Funktion die Signatur, bei einem Typwert
  `Type`. Die Reihenfolge entspricht `assume(value Type)` und dem heutigen `nativeFunction`.
- `Fields` beschreibt die **Instanzen** eines Typwerts, nicht den Wert selbst, deshalb ein eigenes
  Argument und nicht `ValueType`: `Error` ist ein Typ, ein Error hat `message`. Es steht hinten,
  weil es fast immer fehlt.
- Der Name: Das Suffix `Function`/`Value` hat die beiden Konstrukte unterschieden, nach der
  Vereinigung sagt es nichts mehr, alles ist ein Wert. `native` ist ein Adjektiv, folgt aber dem
  Muster der core-lib, einen Konstruktor nach seinem Ergebnis zu benennen (`error(message)`), und
  `nativeFunction`/`nativeValue` sind heute auch keine Verben. Dass „native“ hier JavaScript meint,
  zeigt der JS-Text daneben. `import` bleibt getrennt: Es liest eine Datei, `native` bindet einen
  JS-Ausdruck an Ort und Stelle.

```jul
subtract = native(
	(minuend: Integer subtrahend: Integer) -> Integer
	§js …§
)
Integer = native(Type §Integer§)
# Ein Fehler als gewöhnlicher Wert, kein Wurf. Zur Laufzeit eine Instanz von Error.
Error = native(
	Type
	§_Error§
	[
		# Die Meldung, mit der der Error erzeugt wurde.
		message: Text
	]
)
```

Bei den Typwerten bleibt `ValueType` Beschriftung: Was `Integer` oder `Error` *ist*, lässt sich in
JUL nicht ausdrücken und bleibt in `coreBuiltInSymbolTypes`. Das ist heute auch so, das Konstrukt
macht es nur sichtbar.

Bisher hängen Sonderregeln am Namen `nativeFunction`: `Is(…)` nur als Rückgabetyp der Signatur
(JUL5155, Text der Meldung und Doku in `error-codes.md`), bedingtes `:>` an der äußersten Signatur,
Faltbarkeit (Rumpf ohne native Aufrufe). Sie gelten künftig für die Signatur eines `native`-Werts.
Weitere Stellen: `typescript-parser.ts` (Dummy-Rumpf `nativeValue` für Importe aus `.ts`), das
Beispiel `subtract` im Handbuch, die Bootstrap-Zeile `nativeValue = nativeFunction(…)` in der
core-lib (entfällt, `native` steht in `coreBuiltInSymbolTypes`).

## Felder aus dem Literal

`Error` bleibt der nominale eingebaute Typ, `Fields` beschreibt nur seine Felder:

- **Laufzeit und Emitter:** unverändert, die Prüfung bleibt `instanceof Error`.
- **Checker:** `initCoreLib` liest nach dem Check der core-lib den Typ von `Fields` (ein
  `dictionaryLiteral` mit `declaration`) und übergibt ihn der Typalgebra.
  `valueFieldAccess.error.get` dereferenziert dann auf diesem Literal statt `message` fest zu
  kennen. Identität, Zuweisbarkeit und Verengung hängen weiter an `julType: 'error'`: `Error` wird
  kein Record, `[message = §x§]` bleibt kein Error, ein Error passt nicht auf `[message: Text]`.
- **Language Server:** `getFieldSymbolsFromDictionaryType` folgt bei `error` dem Literal wie bei
  `alias` dem Typ dahinter. Go to Definition, Referenzen und der Doku-Kommentar im Hover gehen ohne
  eigenen Code, der Sonderfall in `completion.ts` entfällt zugunsten von
  `dictionaryTypeToCompletionItems`.
- **Nur Record-Typ-Literale.** Der Parametertyp kann das nicht ausdrücken, JUL hat keinen Typ für
  „ein Record-Typ“. Eine Checker-Prüfung mit eigenem Fehlercode lohnt sich nicht, `native` steht
  nur in der core-lib. Stattdessen wirft `initCoreLib`, wenn `Fields` kein `dictionaryLiteral` mit
  `declaration` ist: ein Fehler im Compiler, und jeder Testlauf lädt die core-lib.

Die Typalgebra weiß danach nur noch, dass ein eingebauter Typ seine Felder aus der core-lib bezieht,
nicht mehr, welche es sind. Ein späteres Feld (etwa `cause` am Error) ist eine Zeile in der
core-lib.

### Weitere Typen

- **Stream (`getValue`):** passt, ist heute genauso fest verdrahtet. Die Schwierigkeit: `Stream` ist
  eine Typfunktion, der Typ von `getValue` hängt vom Parameter ab (`() ~> ValueType`). Das Literal
  müsste `ValueType` sehen, steht aber als eigenes Argument außerhalb der Signatur. Möglich wäre
  `Fields` als Typfunktion mit denselben Parametern (`(ValueType: Type) => [getValue: () ~> ValueType]`).
  `ValueType` als Eigenschaft des Typs (`TypeOf(s$)/ValueType`) bleibt in `typePropertyAccess`, sie ist
  kein Feld eines Streams. `FiniteStream` teilt die Felder.
- **List (`length`):** eher nicht. Zur Laufzeit ist `Array.length` da, aber es gibt schon die
  Funktion `length`, deren Rückgabetyp `LengthOf(TypeOf(values))` die genaue Länge kennt. Ein Feld
  mit `Integer` wäre eine zweite, schlechter typisierte Schreibweise für dieselbe Sache. Außerdem
  ist `/` auf einer Liste heute ein Index-Zugriff (`values/1`), ein Feld würde daneben einen
  Feldzugriff für Listen einführen.
- **Function (`ParamsType`, `ReturnType`):** keine Felder, sondern Eigenschaften, die aus dem
  jeweiligen Funktionstyp berechnet werden. Bleiben in der Typalgebra.

## Verworfen

- **`Error = And(nativeValue(§_ErrorInstance§) [message: Text])`**, ein Schnitt aus nominalem
  Kern und Record. Go to Definition ginge sofort, weil die Feldsuche `and` schon folgt. Aber die
  Verengung `?(x) [Error]` müsste einen Schnitt abziehen, der Rest wäre etwas wie
  `And(Or(GameState Error) Not(And(…)))`, und ob die Typalgebra das überall zu `GameState`
  vereinfacht, ist offen. Außerdem ist der Record geschlossen, ein JS-Error hat aber eigene Felder
  (`stack` in V8). Die Laufzeitprüfung bräuchte doch wieder eine Sonderregel.
- **Ein eigenes `nativeType`.** Typen sind Werte, ein eigenes Konstrukt würde sie an einer Stelle
  trennen, an der die Sprache sonst keinen Unterschied macht. Andere Sprachen mit einem
  Schlüsselwort dafür (Kotlin `external class Error(…) { val message: String? }`, TypeScript
  `lib.es5.d.ts`, Python-Stubs) trennen Typen und Werte ohnehin.
- **`Fields` als erstes Argument.** Das erste Argument ist der Typ des Werts selbst. Stünden dort
  die Felder, hieße es, `Error` sei ein Record und `Error/message` ein Text. Außerdem fehlt
  `Fields` fast immer, weglassen geht nur hinten.
- **`js` als letztes Argument**, damit wie bei einem Rumpf die Implementierung am Ende steht. Dann
  müsste jeder Aufruf ohne Felder, also fast jeder, ein leeres `[]` in der Mitte schreiben oder
  `js` benannt übergeben. Mit `(ValueType js Fields)` steht der lange Block trotzdem am Ende: bei
  Funktionen der JS-Text, bei Typwerten, deren JS-Text nur der Name des Laufzeit-Exports ist, die
  Felder.
- **Nur im Language Server** auf die Zeile `Error = …` springen. Wenig Aufwand, ändert an der
  Sprache nichts, landet aber beim Typ statt beim Feld und ergänzt eine Sonderbehandlung, statt eine
  zu ersetzen.

## Offene Fragen

- **Wohin mit dem Literal.** Gelöst: `setErrorFieldsType` in `type-algebra.ts`, aufgerufen von
  `initCoreLib`. Vor `initCoreLib` hat ein Error keine Felder, kein Test der Typalgebra braucht
  `message` ohne core-lib.
- **Referenzen auf `message`.** Wie bei allen Builtins sammelt der Referenzindex keine
  Verwendungen von Feldern aus der core-lib (`getDeclaredFieldSymbols` filtert sie). Go to
  Definition, Hover mit Doku-Kommentar und Vervollständigung gehen.
- **Was der Check der core-lib selbst sieht.** Beim Check von `Error = native(…)` gibt es den Setter
  noch nicht. Die core-lib liest `/message` heute nirgends. Käme das später dazu, müsste es nach
  der Definition von `Error` stehen oder der Setter schon während des Checks greifen.
- **Felder einer Typfunktion** (Stream, siehe oben): `Fields` als Typfunktion mit den Parametern der
  Signatur, oder Stream vorerst fest verdrahtet lassen.
- **Andere Laufzeitfelder.** `stack` und `name` gibt es zur Laufzeit, statisch sind sie Empty.
  Daran ändert der Entwurf nichts, das ist heute schon so.

## Reihenfolge

1. `native` einführen, `nativeFunction` und `nativeValue` ersetzen (core-lib, Checker,
   `typescript-parser.ts`, Handbuch und JUL5155). Kein Verhalten ändert sich, Snapshot und Tests
   bleiben gleich.
2. `Fields` für `Error`, Feldzugriff und Language Server darauf umstellen.
3. Stream, sobald die Frage der Typfunktion entschieden ist.

## Tests

- Language Server (`definition.test.ts`): Go to Definition auf `message` in `x/message` mit
  `x: Or(Record Error)` springt auf das Feld im Literal der core-lib. Nach der Regel „Bugfix per
  Test“ zuerst rot.
- Hover auf `message` zeigt den Doku-Kommentar, Referenzen finden die Verwendungen.
- Checker: `x/message` bleibt `Text` bzw. `Or([] Text)` bei `Or(Record Error)`. Die Verengung
  `?(x) [Error]` ist unverändert, abgedeckt durch die bestehenden Tests und den Checker-Snapshot.
- `initCoreLib` wirft bei `Fields`, das kein Record-Typ-Literal ist.
- Bench vor und nach jedem Schritt (Typalgebra und Checker).
