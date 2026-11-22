# KeyOf: Schlüssel, deren Existenz bewiesen ist

**Stand 2026-11-22:** Schritte 1 bis 5 umgesetzt (Compiler, Laufzeit, core-lib, Handbuch, yugioh,
`findKey` und Schlüssel in `mapDictionary`/`findField`). Abweichungen vom Entwurf unten, die aus
Schritt 4 und 5 im zweiten Block.

- **Identität über Weg 2, wie die Längen-Terme** ([laengen-terme.md](laengen-terme.md)): Statt die
  Identität beim Binden mitzuführen, trägt `CompileTimeDictionaryType` einen Term (`Keys`, derselbe
  `LengthTerm` wie die Länge einer Liste). Es entsteht dort, wo auch die Länge entsteht:
  `withExpressionValueTerm` für Pfade, `case 'parameterReference'` und Feldpfade auf Parametern beim
  Auflösen. `withListLength` und Verwandte heißen jetzt `withValueTerm`, `hasTermChoice`,
  `eraseValueTerms`. Damit funktionieren Parameter (`(d: Dictionary(X) k: KeyOf(d))`) und der
  Vertrag von `hasField` ohne eigene Mechanik: Ein Dictionary mit Term gilt in `isSingletonValue` wie
  ein Literal.
- **Knoten `keyOf(Source)`** mit `getKeyOfFromType`: Dictionary mit Term → `keyOf`; Dictionary ohne
  Term → `keyOf` mit frischem Term (`CompileTimeKeyOfType.Keys`), damit zwei `KeyOf(make())` nicht
  als dasselbe internierte Objekt zusammenfallen; Record-Typ → Union der Pflichtfeld-Namen; `Or` →
  Schnitt der Schlüssel ohne Empty, `And` → Vereinigung, Empty → Never, Any → Text.
- **Import:** Ein importierter Name bekommt den Term seiner Definition (`getTermOrigin` über
  `resolveImportBinding`, je Symbol gecacht, Schlüssel Datei und Name, siehe unten).
- **Top-Level-Terme sind global** (`LengthTerm.global`): `eraseValueTerms` lässt sie im
  abgeleiteten Rückgabetyp stehen, Terme von Parametern und lokalen Bindungen nicht.
- **Literal-Regel:** Ein Textliteral passt zu `KeyOf` eines Record-Typs, wenn es ein Pflichtfeld ist
  (folgt aus der Union). Bei einem `Dictionary` mit Term beweist ein Literal nichts.
- **Lokale Alias-Bindung** (`local = data`, dann `local.hasField(id)`): beweist nichts für `data`,
  `local` hat einen eigenen Term. Präzisionsverlust, kein Soundness-Problem.
- **Kosten** (yugioh, `npm run bench`): Zähler unverändert, „geteilt" 1091 → 1125 ms (+3 %),
  parse+check +2 bis 4 % im Rauschen.

Aus Schritt 4 (yugioh) und 5, ersetzt Teile des Blocks oben:

- **Record-Typ:** `KeyOf` ist die Union seiner Pflichtfeld-Namen, kein `keyOf`-Knoten mit frischem Term.
  Frische Terme je Auswertung scheiterten am Callback von `mapDictionary`: Signatur und Lambda werten
  `KeyOf(dictionary)` getrennt aus, `KeyOf(d)` passte dann nicht zu `KeyOf(d)`. Ein Dictionary ohne Term
  bekommt weiter einen frischen Term.
- **`Or` mit Empty:** Empty trägt nichts bei. Ein Schlüssel vom Typ `KeyOf(d)` beweist, dass `d` nicht
  leer ist (jeder Weg zu ihm setzt einen nicht leeren Wert voraus, Bindungen sind unveränderlich).
  Sonst wäre der Schlüssel im Callback eines optionalen Dictionary `Never`. `isSingletonValue` nimmt
  auch `Or([] Dictionary)` mit Term, `hasField` verengt also auch dort.
- **Term über Datei und Name:** Eine Top-Level-Bindung (auch über Import) hat den Term
  `<Datei>#<Name>`, nicht das Symbol-Objekt, und er steht in einer eigenen Map (`namedPathTerms`), die
  `clearInternedTypes` nicht leert. `jul test` lädt mehrere Wurzeln in dieselben documents und leert
  dazwischen die Caches, sonst gab es zwei `KeyOf(allCardData)` (Test in `project-loader.test.ts`).
- **Zweige löschen keine Terme:** `eraseValueTerms` greift nicht beim Arm einer Verzweigung, er läuft im
  Aufruf der umgebenden Funktion. Sonst verlor ein Early Exit mit `hasField` auf einem Parameter den
  Term (betraf schon vorher die Listenlängen).
- **Offener Kopf:** `createConditionalType` wartet auch, wenn ein Kopf noch einen Parameter nennt
  (`isOpenHead`). `[KeyOf(dictionary)]` im Kopf von `getField` wartet im Rumpf auf den Parameter der
  umgebenden Funktion, vorher wurde zu früh „überlappt“ entschieden.
- **Vertrag mit offenem `keyOf`:** `getPredicateContract` löst einen offenen `keyOf`-Vertrag auf (wie
  die Länge eines Parameters), sonst verengte `hasField` auf einem Parameter nicht.
- **Schritt 5:** `findKey` liefert `Or([] KeyOf(dictionary))`, der Schlüssel im Callback von
  `mapDictionary`, `findField` und `findKey` ist `KeyOf(dictionary)`, `MapElements` setzt ihn ein.
- **Kosten nach Schritt 4/5** (`npm run bench`, Zähler deterministisch): gegen den Stand vor KeyOf
  `resolvePlaceholders` 6,03 → 6,60 Mio. (+9,5 %), `getTypeError` 5,15 → 5,65 Mio. (+9,8 %),
  „geteilt" 1091 → 1139 ms (+4 %), parse+check 20,0 → 22,3 s (+11 %). Davon etwa die Hälfte aus den
  Compiler-Änderungen seit Schritt 3 (unveränderter yugioh-Stand im Worktree: 6,28 Mio. bzw.
  5,33 Mio.), der Rest aus dem Umbau in yugioh. Die Regel für offene Köpfe ändert die Zähler nicht.
  Ein Zwischenstand baute die Union der Record-Schlüssel bei jedem getField normalisiert neu
  (quadratisch, JSON-Imports mit Tausenden Feldern): parse+check 84 s, jetzt einmal je Typ ohne
  Normalisierung (`getRecordKeys`). yugioh: Build unverändert (~2,7 s), `jul test` 5,1 → 5,6 s.
- **yugioh:** `allCardData` und `CardDataId` stehen in `game-types.jul` (kein Zyklus, kein eigenes
  Modul nötig). `GameCard/dataId` bleibt `Text`, weil Tokens keinen Passcode in `card-data.json`
  haben. Grenzen: `getKnownCards`/`toKnownDeck` (YDK, Datenbank, Bench-Einstiege), Payload-Typen in
  `ui-events.jul` (die Laufzeitprüfung gegen `UiEvent` prüft `KeyOf`), `findKey` (Szenarien),
  `mapDictionary` (Suche), `toCardDataId`/`toTestDeck` (Tests, `assume`).

Ursprünglicher Entwurf (Stand 2026-11-22, vor der Umsetzung):

## Anlass

In yugioh liefert `allCardData.getField(id)` den Typ `Or([] CardData)`, obwohl jede Id an der Grenze
geprüft ist (YDK-Import über `getKnownCards`, Suche und Deck Builder nehmen Schlüssel aus
`allCardData` selbst). Die Prüfung beweist es, aber danach ist die Id wieder `Text`, und das Wissen
ist weg. Übrig bleibt `assume(cardData CardData)` in `getCardDataFromDataId` (JUL2509), mit 17
produktiven Aufrufern.

Das Muster ist allgemein: Ein Wert wurde gegen ein Dictionary geprüft und wird später als Schlüssel
benutzt. Heute bleibt dafür nur `assume`, ein Fallback-Wert oder ein Empty-Zweig an jedem
Aufrufer, der nie greift.

## Vorschlag

`KeyOf(dictionary)` ist der Typ der Texte, die in `dictionary` als Schlüssel vorhanden sind, auch
mit explizit leerem Wert (`k = []`). Wie
`TypeOf` ist es eine gewöhnliche Funktion der core-lib, keine Syntax (Prinzip „Keine Magie für
Typen“).

```jul
allCardData = import(§./card-data.json§ Dictionary(CardData))
CardDataId = KeyOf(allCardData)

# Die Grenze: verengt per Vertrag von hasField
toKnownIds = (ids: Or([] List(Text))) :> Or([] List(CardDataId)) =>
	ids.filter((value) => allCardData.hasField(value))

# Kein assume mehr
getCardData = (id: CardDataId) :> CardData =>
	allCardData.getField(id)

# Early Exit an einer einzelnen Stelle
describe = (id: Text) :> Text =>
	?(id)
		[Not(CardDataId)] => §unbekannt§
	getCardData(id)/name
```

### Vorhanden, nicht nicht leer

`KeyOf` folgt derselben Unterscheidung wie Dictionary-Typen: Ein Pflichtfeld steht als Schlüssel
da, auch wenn sein Typ Empty zulässt, nur ein `?`-Feld darf fehlen (Handbuch, `isDictionaryLiteralOfType`
in `runtime.ts`). Deshalb zählt ein Schlüssel mit `k = []` dazu.

- **`getField`** liefert für einen `KeyOf`-Schlüssel den Elementtyp, wie er ist. Bei
  `Dictionary(CardData)` ist das `CardData`, bei `Dictionary(Or([] X))` bleibt Empty drin, weil es
  dort ein gültiger Wert ist.
- **Literal-Regel:** Pflichtfelder eines Dictionary-Typs sind `KeyOf`, `?`-Felder nicht. Das ist
  genau die Bedeutung von `?`.
- **Prüfung zur Laufzeit** wie bei Pflichtfeldern: `key in dictionary`.

### Identität statt Typ

`KeyOf` hängt am **Wert**, nicht an seinem Typ: Zwei Dictionaries vom Typ `Dictionary(CardData)`
haben verschiedene Schlüssel. Der Typ bezieht sich deshalb auf eine Bindung, so wie heute die
Verengung im Branching (`getAccessPath`: Symbol plus Feldpfad). Das ist sound, weil Bindungen
unveränderlich sind und Überdecken ein Fehler ist (JUL3203).

- **Top-Level-Bindung:** Die Identität ist die kanonische Definition (Datei plus Name). Ein
  importierter Name wird über `resolveImportBinding` aufgelöst, damit `KeyOf(allCardData)` in
  `deck-logic.jul` und in `game-logic.jul` derselbe Typ ist. Datei plus Name statt Symbol-Objekt,
  damit es Rechecks im Language Server übersteht.
- **Parameter:** `KeyOf(dictionary)` in einer Signatur ist ein Platzhalter. An der Aufrufstelle
  wird die Identität des Arguments eingesetzt.
- **Feldpfad einer Bindung** (`run/refByGameCardId`): wie Top-Level, nur mit Pfad.
- **Alles andere** (Aufrufergebnis, Literal, lokale Bindung, siehe offene Fragen): eine frische
  Identität, zu der nichts passt. `getField` fällt dann auf den heutigen Typ zurück. Das ist sound,
  nur nicht genauer als heute.

### core-lib

```jul
KeyOf = nativeFunction(
	(dictionary: Or([] Dictionary(Any))) -> Type
	§js
		(dictionary) => ({ [_julTypeSymbol]: 'keyOf', value: dictionary })
	§
)

# neu
hasField = nativeFunction(
	(dictionary: Or([] Dictionary(Any)) key: Text) -> Is(key KeyOf(dictionary))
	§js … §
)

getField = nativeFunction(
	(dictionary: Or([] Dictionary(Any)) key: Text)
		->
			:?(TypeOf(key))
				[KeyOf(dictionary)] => TypeOf(dictionary)/ElementType
				() => Or([] TypeOf(dictionary)/ElementType)
	§js … §
)
```

Danach lassen sich auch die Schlüssel genauer typisieren, die ein Dictionary selbst liefert:
`findKey` gibt `Or([] KeyOf(dictionary))` zurück, der Schlüssel im Callback von `mapDictionary`
hat den Typ `KeyOf(dictionary)`. Das gehört nicht in den ersten Schritt.

### Zuweisbarkeit und Normalisierung

| von | nach | Ergebnis |
|---|---|---|
| `KeyOf(d)` | `Text` | ja |
| `KeyOf(d)` | `KeyOf(e)` | ja bei gleicher Identität, sonst nein |
| `§k§` | `KeyOf(d)` | ja, wenn der Typ von `d` ein Dictionary-Literal mit Pflichtfeld `k` (ohne `?`) ist; sonst wie `Text` |
| `Text` | `KeyOf(d)` | wie `Integer` nach `PositiveInteger`: verlangt Verengung |
| `KeyOf(d)` mit `d: Empty` | | `Never` |

`And(Text KeyOf(d))` normalisiert zu `KeyOf(d)`, `Or(Text KeyOf(d))` zu `Text`. Damit liefern
`?(id) [KeyOf(d)]` und Early Exit mit `[Not(KeyOf(d))]` über die vorhandene Verengung den richtigen
Typ.

### Laufzeit

`getTypeError` in `runtime.ts` bekommt `case 'keyOf'`: Der Wert ist ein String, und
`dictionary` ist nicht leer und enthält ihn als Schlüssel (`value in dictionary`, wie bei
Pflichtfeldern). Damit funktionieren `?(id) [KeyOf(d)]`, `_checkAssume` unter
`jul test` und `checkAssertions` ohne weitere Änderungen. Der Emitter erzeugt für `KeyOf(x)` einen
normalen Aufruf.

### Language Server

Er braucht die Schlüssel nicht, die Identität genügt. Deshalb funktioniert `KeyOf(allCardData)` auch
dann, wenn er `card-data.json` nicht lädt (über `maxTypedFileSize`). Hover zeigt
`KeyOf(allCardData)` bzw. den Alias.

## Technisches Risiko: Identität an der Aufrufstelle

Heute setzt der Checker an der Aufrufstelle nur **Typen** für Parameter ein
(`dereferenceParameterFromArgumentType`, `boundArgsType`). Für `KeyOf(dictionary)` braucht er die
Identität des **Arguments**, also seinen Ausdruck. Zwei Wege:

1. Beim Binden der Argumente je Position die Identität mitführen (`getAccessPath` auf den
   Argumentausdruck), neben dem Typ. Beim Einsetzen eines `keyOf`-Platzhalters wird sie verwendet.
2. Der Typ eines Referenzausdrucks trägt seine Identität (`Dictionary(CardData)` mit Herkunft).
   Das ist invasiver, weil die Identität dann alle Typoperationen durchläuft.

Weg 1 ist kleiner. Dieselbe Erweiterung braucht der Vertrag von `hasField`: Heute werden
Vertragsargumente nur eingesetzt, wenn die übrigen Argumente einzelne Literale sind
(`predicate-types-and-filter-narrowing.md`). Eine Identität ist genauso exakt und kann
zusätzlich zugelassen werden.

## Was es nicht löst

- **Textliterale** in Tests (`geminiElf = §…§`): Den Typ von `card-data.json` kennt der Checker
  nicht als Literal, ein Literal-Schlüssel ist also kein `CardDataId`. Tests verengen mit `hasField`
  oder behalten `assume`, das dort keine Warnung bekommt.
- **Daten von außen** (localStorage, Replays, Szenarien) kommen als `Text` an und brauchen an ihrer
  Grenze eine Verengung. Das ist gewollt: Die Prüfung steht dann dort, wo die Daten hereinkommen.
- **`scenario-driver.jul`** (`getGameCardId(input/card gameCardIdByRef)`): Die Refs stammen aus
  Szenariodaten und werden nirgends gegen `gameCardIdByRef` geprüft. `KeyOf` hilft dort erst, wenn
  das Szenario beim Laden validiert wird.

## Umbau in yugioh

- **Importzyklus:** `Deck` und `GameCard` stehen in `game-types.jul`, `allCardData` in
  `game-logic.jul`, das `game-types.jul` importiert. `CardDataId` braucht `allCardData`, und
  `allCardData` braucht den Typ `CardData`. Lösung: ein eigenes Modul (z. B.
  `card-data/card-pool.jul`) mit `CardData` samt seinen Aufzählungstypen, `allCardData` und
  `CardDataId`. `game-types.jul` importiert es. Weil Imports nicht weitergereicht werden, müssen
  alle Nutzer von `CardData` ihren Import umstellen.
- `Deck/main`, `extra`, `side`, `maybe` und `GameCard/dataId` bekommen `CardDataId`.
- `getKnownCards` wird zur verengenden Grenze. Weitere Grenzen: Laden der Decks aus localStorage,
  Replay-Import (heute `assume(parsed Replay)`, Finding 19), Szenarien.
- `getCardDataFromDataId` nimmt `CardDataId` und braucht kein `assume` mehr.

## Reihenfolge

1. Typknoten `keyOf` mit Identität, `KeyOf` in der core-lib, Zuweisbarkeit, Normalisierung,
   `typeToString`, Laufzeit. Tests mit Top-Level-Bindung und `?(x) [KeyOf(d)]`.
2. Identität an der Aufrufstelle (Weg 1), `getField` mit bedingtem Rückgabetyp.
3. Neues Builtin `hasField` mit Vertrag, Verengung in `filter` und im Branching.
4. yugioh: Modul `card-pool.jul`, Typen umstellen, `assume` entfernen.
5. Optional: `findKey`, Schlüssel in `mapDictionary`.

Nach Schritt 3 ist das Feature nutzbar, Schritt 4 ist die Probe auf ein echtes Projekt.

## Offene Fragen

1. **Lokale Bindungen:** Ein `KeyOf(lokal)` kann im Rückgabetyp den Rumpf verlassen und gilt dann
   für eine andere Ausführung. Vorschlag: Beim Verlassen des Rumpfs wird der Typ zu `Text`
   verbreitert. Oder lokale Bindungen sind im ersten Schritt ausgeschlossen (frische Identität).
2. **`setField` und Spread:** Ist `KeyOf(d)` eine Teilmenge von `KeyOf(d.setField(k v))`? Das ist
   immer richtig, weil `setField` den Schlüssel auch mit leerem Wert setzt. Es braucht aber eine
   Beziehung zwischen Identitäten. Vorerst
   nicht.
3. **Feldpfade über optionale Felder** (`run/refByGameCardId` mit `Or([] Dictionary(Text))`):
   `KeyOf` von Empty ist `Never`, das passt. Ob die Verengung über Pfade mit leerem Zwischenwert
   sauber durchläuft, ist zu prüfen.
4. **Namen:** `KeyOf` folgt `TypeOf`, `hasField` folgt `getField` und `setField`. Gegen
   `naming.md` prüfen.
