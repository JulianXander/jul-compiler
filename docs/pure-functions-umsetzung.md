# Pure Functions, Schritte 1–10: Umsetzungsplan

Detailplan für die erste Hälfte von [pure-functions.md](pure-functions.md) — bis zur dort
beschriebenen Schnittmöglichkeit, also **ohne** Constant Folding. Die Entscheidungen stehen im
Hauptdokument (Fragen 1, 2, 4, 5 und die Argument-Regel); hier steht nur, wie sie umgesetzt werden.

Ergebnis dieser Hälfte: `purity` ist korrekt belegt statt wie heute falsch, im Typ sichtbar, im Hover
lesbar, und die Purity eines konkreten Aufrufs ist berechenbar. Kein Code wird zur Compile-Zeit
ausgeführt. Kein neuer Fehlercode.

## Was sich insgesamt ändert

| Datei | Änderung |
| --- | --- |
| `src/parser/parser.ts` | zwei neue Tokens, Pfeil-Art durch `functionTypeBody` |
| `src/syntax-tree.ts` | `Purity`-Typ, `arrow` an zwei Parse-Knoten, `pure` → `purity` |
| `src/checker/checker.ts` | Pfeil lesen, `nativeFunction`-Signatur, `typeEquals`, Argument-Regel, `typeToString` |
| `src/core-lib.jul` | 80 Migrationen `true`/`false` → Pfeil, `nativeFunction` selbst |
| Tests | Parser, Checker, zwei Baselines |
| `vscode-jul-language-service` | Grammatik |
| `jul-homepage/docs` | Handbuch |

Der **Emitter bleibt unberührt** — Typen werden nicht emittiert. Der **Language Server** bleibt
unberührt: Hover und Signature Help bauen auf `typeToString` auf
([server.ts:620 ff.](../../jul-language-server/src/server.ts#L620)) und übernehmen die neue Ausgabe
von selbst.

---

## Schritt 1 — Ausgangsmessung

```bash
cd jul-compiler
npm run bench -- --save --note "vor pure-functions Schritt 1-10"
```

Gemessen wird gegen `C:\Projects\privat\yugioh`. Ohne diese Messung vergleicht die nächste über zwei
Umbauten hinweg (siehe CLAUDE.md, „Wann messen").

## Schritt 2 — Roter Test für die Fehlbelegung

Belegt den Befund aus dem „Stand": jede core-lib-Funktion trägt heute `pure: true`, auch `log` und
`currentDate`, weil `functionTypeLiteral` das hart setzt
([checker.ts:2702](../src/checker/checker.ts#L2702)).

Neuer Testfall in `src/checker/checker.test.ts`, der `builtInSymbols` befragt — er schlägt **vor**
der Änderung fehl und dokumentiert damit, was repariert wird:

```ts
it('core-lib: log und currentDate sind nicht pure', () => {
	// builtInSymbols laden wie in den bestehenden core-lib-Tests
	expect(purityOf('log')).to.equal('impure');
	expect(purityOf('currentDate')).to.equal('impure');
	expect(purityOf('add')).to.equal('pure');
});
```

**Hier anhalten und den roten Output zeigen** (CLAUDE.md: „Bugfix per Test"). Der Test bleibt bis
Schritt 6 rot, weil er erst mit der core-lib-Migration grün wird — das ist beabsichtigt und beim
Zeigen zu sagen.

## Schritt 3 — Parser: zwei neue Pfeil-Tokens

### 3a. Tokens

Neben [parser.ts:259](../src/parser/parser.ts#L259):

```ts
const returnTypeTokenParser = tokenParser(' :> ');   // bestehend
const pureReturnTypeTokenParser = tokenParser(' -> ');
const impureReturnTypeTokenParser = tokenParser(' ~> ');
```

Alle drei **inklusive umgebender Leerzeichen**, wie der bestehende Token. Damit ist die Abgrenzung
zum präfixen Branching-`?` ([parser.ts:255](../src/parser/parser.ts#L255)) und zum `functionToken`
`' =>'` ([parser.ts:257](../src/parser/parser.ts#L257)) gegeben; keiner der neuen Tokens beginnt oder
endet mit `=`.

Kein Kollisionsrisiko bei `->`: JUL hat keinen Subtraktions-Token, arithmetische Operationen laufen
über Funktionen (`subtract`).

### 3b. Einen Pfeil-Parser, der die Art liefert

`discriminatedChoiceParser` nimmt den **ersten** Zweig, dessen Predicate parst
([parser-combinator.ts:91](../src/parser/parser-combinator.ts#L91)), und `mapParser`
([parser-combinator.ts:230](../src/parser/parser-combinator.ts#L230)) hängt einen Wert an ein
Ergebnis. Daraus:

```ts
const anyReturnTypeTokenParser: Parser<undefined> = choiceParser(
	returnTypeTokenParser,
	pureReturnTypeTokenParser,
	impureReturnTypeTokenParser,
);

const returnArrowParser: Parser<Purity> = discriminatedChoiceParser(
	{ predicate: returnTypeTokenParser, parser: mapParser(returnTypeTokenParser, () => 'unknown') },
	{ predicate: pureReturnTypeTokenParser, parser: mapParser(pureReturnTypeTokenParser, () => 'pure') },
	{ predicate: impureReturnTypeTokenParser, parser: mapParser(impureReturnTypeTokenParser, () => 'impure') },
);
```

Die Reihenfolge ist hier gleichgültig, weil sich die drei Tokens im zweiten Zeichen unterscheiden.
Trotzdem beim Umsetzen verifizieren — `discriminatedChoiceParser` prüft nicht auf Eindeutigkeit.

### 3c. `functionTypeBodyParser` gibt die Pfeil-Art weiter

[parser.ts:1649](../src/parser/parser.ts#L1649): `returnTypeTokenParser` im `sequenceParser` durch
`returnArrowParser` ersetzen und das Ergebnis in den Rückgabewert aufnehmen:

```ts
parsed: result.parsed && {
	type: 'functionTypeBody',
	arrow: result.parsed[0],        // neu
	returnTypeBase: result.parsed[1],
	body: result.parsed[2]?.body,
},
```

**Der Knackpunkt:** Dieser Parser entscheidet erst am optionalen `=>`, ob ein Typ oder ein Wert
entsteht — der Pfeil ist zu dem Zeitpunkt längst konsumiert. `arrow` erreicht damit zwangsläufig
beide Zweige. Das ist kein Unfall, sondern nach Entscheidung 1B genau richtig: die Zusicherung am
Literal wird übernommen.

### 3d. Predicate an der Aufrufstelle

[parser.ts:1037](../src/parser/parser.ts#L1037): `predicate: returnTypeTokenParser` →
`predicate: anyReturnTypeTokenParser`. Sonst greift der Zweig nur bei `:>` und `(a) -> Integer`
liefe in den „SimpleExpressionBase"-Zweig mit anschließendem `unparsedRestOfRow`.

### 3e. Knoten befüllen

- `ParseFunctionTypeLiteral` ([parser.ts:1123](../src/parser/parser.ts#L1123)) bekommt `arrow`.
- Der `functionLiteral`-Zweig derselben Stelle ebenfalls.

### 3f. Parser-Tests

`src/parser/parser.test.ts` ist tabellengetrieben; ohne `result` wird nur auf fehlerfreies Parsen
geprüft, was für Schreibweisen reicht. Vorbild ist der bestehende Fall `function-type-literal`.
Sechs neue Einträge — je Pfeil einmal als Typ und einmal als Literal:

```ts
{ name: 'function-type-literal-pure',        code: '(a: Integer) -> Integer' },
{ name: 'function-type-literal-impure',      code: '(a: Integer) ~> Integer' },
{ name: 'function-literal-pure-arrow',       code: '(a: Integer) -> Integer => a' },
{ name: 'function-literal-impure-arrow',     code: '(a: Integer) ~> Integer => a' },
{ name: 'function-type-literal-in-params',   code: '(callback: (v: Integer) -> Integer) :> Integer' },
{ name: 'function-type-literal-unknown',     code: '(a: Integer) :> Integer' },   // Regression
```

Dazu **ein** Test mit `result`, der `arrow` am Knoten festhält — sonst prüft nichts, dass die
Pfeil-Art überhaupt ankommt.

## Schritt 4 — Typdarstellung

### 4a. `Purity` in `syntax-tree.ts`

```ts
/** Der geschriebene Pfeil bzw. die daraus folgende Purity-Aussage. */
export type Purity =
	| 'unknown'  // :>
	| 'pure'     // ->
	| 'impure';  // ~>
```

### 4b. Feld an den Parse-Knoten

[`ParseFunctionTypeLiteral`](../src/syntax-tree.ts#L402) und
[`ParseFunctionLiteral`](../src/syntax-tree.ts#L374) bekommen `arrow?: Purity`. Optional, weil eine
Funktion ohne Pfeil (`(a) => a`) keinen hat.

Am Literal heißt das Feld **`arrow`, nicht `purity`**: AST = was dasteht, CompileTimeType = was gilt.
Bei dieser Gelegenheit den auskommentierten `pure: boolean` mit dem `!=>`-TODO
([syntax-tree.ts:379](../src/syntax-tree.ts#L379)) entfernen — er ist damit erledigt.

### 4c. Feld am Typ

[`CompileTimeFunctionType.pure: boolean`](../src/syntax-tree.ts#L928) → `purity: Purity`, ebenso der
Parameter von [`createCompileTimeFunctionType`](../src/syntax-tree.ts#L943).

Die 11 Aufrufstellen nachziehen. `tsc` findet sie alle, weil der Typ sich ändert — vier sind
inhaltlich, der Rest mechanisch:

| Stelle | neu |
| --- | --- |
| [checker.ts:2702](../src/checker/checker.ts#L2702) `functionTypeLiteral` | `expression.arrow ?? 'unknown'` statt `true` |
| [checker.ts:2587](../src/checker/checker.ts#L2587) `functionLiteral` | `expression.arrow ?? 'unknown'` statt `false` |
| [checker.ts:1036](../src/checker/checker.ts#L1036), [checker.ts:1235](../src/checker/checker.ts#L1235) | kopieren unverändert weiter |
| [checker.ts:235–296](../src/checker/checker.ts#L235) Builtin-Signaturen | `'impure'` für `nativeFunction`/`nativeValue`, Typkonstruktoren `'pure'` |
| [checker.ts:418](../src/checker/checker.ts#L418) `getStreamGetValueType` | `'impure'` — ein Stream-Wert zu lesen ist Zustandszugriff |
| [checker.ts:6049](../src/checker/checker.ts#L6049) `anyFunctionType` | `'unknown'`; der Typ dient nur der Prüfung „ist das überhaupt eine Funktion" und darf an Purity nicht scheitern (mit 4A prüft `getTypeError` sie ohnehin nicht) |

Zu 2587: `'unknown'` statt `'impure'` — „nicht bewiesen" statt „bewiesen unrein", und
vorwärtskompatibel zur Inferenz-Ausbaustufe.

### 4d. `typeEquals`

[checker.ts:4221](../src/checker/checker.ts#L4221): `first.pure === second.pure` vergleicht künftig
die **wirksame** Purity, nicht das Label:

```ts
function effectivePurity(purity: Purity): 'pure' | 'notPure' {
	return purity === 'pure' ? 'pure' : 'notPure';
}
```

`'unknown'` und `'impure'` fallen zusammen, weil kein Algorithmus sie unterscheidet. Ohne das bekäme
`createNormalizedUnionType` eine zweite künstliche Trennung — zusätzlich zu der, die dieser Umbau
gerade beseitigt.

**Erwartete Nebenwirkung, die zu beobachten ist:** heute sind deklarierte und inferierte
Funktionstypen *nie* `typeEquals` (`true` vs. `false`). Danach sind sie es oft. Das verändert
Deduplizierungsergebnisse — deshalb liegt Schritt 10 (Bench) und der Snapshot-Vergleich danach.

## Schritt 5 — Checker: Pfeil lesen, `nativeFunction` verkleinern

### 5a. Pfeil lesen

Die beiden Zeilen aus 4c. Damit ist die Quelle der Wahrheit umgestellt: `purity` kommt aus dem
geschriebenen Pfeil statt aus einer Hartkodierung.

### 5b. `nativeFunction` von drei auf zwei Parameter

[checker.ts:282](../src/checker/checker.ts#L282): den `pure`-Parameter aus der Parameterliste
entfernen. Der Rückgabetyp ist bereits `createParameterReference('FunctionType', 0)`, also der
deklarierte Typ selbst — der Wert kommt damit aus dem `FunctionType`-Argument, und die zweite Stelle,
die lügen könnte, verschwindet.

Analog `nativeFunction` in core-lib selbst ([core-lib.jul:1278](../src/core-lib.jul#L1278)) und
`nativeValue` daneben.

### 5c. Tests

In `src/checker/checker.test.ts`, tabellengetrieben wie der Bestand:

- Zusicherung nach 1B: `f = (a: Integer) -> Integer => a` trägt `'pure'`, **ohne** dass der Rumpf
  geprüft wird; `(a: Integer) :> Integer => a` und `(a) => a` tragen `'unknown'`.
- Der bestehende `nativeFunction`-Testfall
  ([checker.test.ts:953](../src/checker/checker.test.ts#L953)) verliert sein `true`-Argument —
  mitziehen, sonst schlägt er mit Arity-Fehler fehl.

## Schritt 6 — Migration core-lib

80 Bool-Argumente entfallen, der Pfeil der jeweiligen Signatur tritt an ihre Stelle. **Die 17
Callback-Parameterpositionen bleiben `:>`** — sie brauchen keine Markierung, die Argument-Regel
erledigt das an der Aufrufstelle.

### 6a. Die klaren Fälle

- **49 × `true` → `->`**: `add`, `and`, `or`, `not`, `equal`, `deepEqual`, `greater`, `length`,
  `slice`, `flatten`, `getElement`, `setElement`, `getField`, `setField`, `lastElement`, `toList`,
  `combineTexts`, `parseFloat`, `parseJson`, `toJson`, `regex`, `assume`, `addDate`,
  `toIsoDateText`, `rationalToFloat`, die `add*`/`subtract*`/`multiply*`/`max*`-Varianten, `modulo`,
  `divideFloat`, sowie die Typkonstruktoren `List`, `Or`, `And`, `Not`, `TypeOf`, `Dictionary`,
  `Stream`, `Greater`, `Range`, `TupleOf`, `Concat`, `ElementAt`, `LengthOf`, `WithElementAt`.
- **Streams und I/O → `~>`**: `log`, `currentDate`, `import`, `runJs`, `push`, `complete`,
  `create$`, `completed$`, `combine$`, `take$`, `timer$`, `httpTextRequest$`, `httpBlobRequest$`,
  `map$`, `flatMergeMap$`, `flatSwitchMap$`, `subscribe`, `nativeFunction`, `nativeValue`.

### 6b. Die 10 TODO-Stellen → `->`

`map`, `filter`, `filterMap`, `findFirst`, `findLast`, `findLastIndex`, `exists`, `all`,
`aggregate`, `toDictionary` tragen heute `false` mit dem Kommentar „TODO pure wenn die args pure
sind". Sie bekommen `->` und der Kommentar entfällt: sie fügen von sich aus keine Unreinheit hinzu,
die Bedingung an den Argumenten erledigt Schritt 7.

### 6c. Die sechs Callback-Nehmer ohne TODO

Sechs Funktionen nehmen einen Callback, tragen heute `false`, haben aber **kein** „TODO pure wenn die
args pure sind". Sie sind kein mechanischer Fall — unter der alten Semantik war `false` unauffällig,
unter der neuen ist je Funktion zu entscheiden, ob sie *selbst* etwas Unreines tut. Alle sechs
bleiben `~>`:

| Funktion | Begründung |
| --- | --- |
| `forEach`, `repeat` | Beide geben `[]` zurück und **verwerfen jedes Callback-Ergebnis** — im Code sichtbar an `iteratee: (index: bigint) => void` ([runtime.ts:3186](../src/runtime.ts#L3186)) und am `values?.forEach(...)` ohne Rückgabe ([runtime.ts:2304](../src/runtime.ts#L2304)). Mit reinem Callback sind sie nachweislich Noops. Ihr einziger Zweck ist der Effekt im Callback; `->` wäre zwar formal verteidigbar, beschriebe aber eine Funktion, die es so nicht gibt. |
| `subscribe`, `map$`, `flatMergeMap$`, `flatSwitchMap$` | Streams sind push-basiert mit `processId`-Takt; die Funktionen verändern Stream-Zustand → `~>` |

Für `forEach` und `repeat` bekommt zusätzlich der **Callback-Parameter** `~>`: eine Position, die
einen reinen Callback bekommt, ist sinnlos, und das soll in der Signatur stehen.

Zwei Dinge dazu, damit die Erwartung stimmt: Der Parameter-Pfeil wirkt heute **nicht** — die
Argument-Regel liest die Purity des tatsächlichen *Arguments*, nicht die des deklarierten Parameters,
und nach 4A weist nichts etwas zurück. Er wäre ohnehin folgenlos, weil beide Funktionen schon durch
ihr eigenes `~>` nie beweisbar rein sind. Er steht dort aus demselben Grund wie `~>` überhaupt
(Frage 2): als bewusste, positive Aussage und als Ground Truth für die spätere Inferenz-Ausbaustufe —
die einzige Stelle in core-lib, an der ein Parameter-Pfeil etwas sagt, das die Regel nicht ohnehin
ausrechnet.

### 6d. Grenzfälle einzeln verifizieren

Die bestehenden Bool-Werte sind die Vorlage, aber **ungeprüft** — sie waren nie wirksam. Vor der
Übernahme je Fall prüfen: deterministisch **und** frei von Systemzustand?

- `regex` — nachgesehen ([runtime.ts:1890](../src/runtime.ts#L1890)): `text.match(pattern)` mit
  einem String-Pattern erzeugt je Aufruf ein frisches `RegExp`, es gibt keinen `lastIndex`-Zustand
  zwischen Aufrufen. Deterministisch, `->` ist richtig. (Katastrophales Backtracking bleibt ein
  Thema — aber für die Faltung, nicht für den Pfeil.)
- `parseFloat`, `parseJson`, `toJson` — deterministisch, aber werfen/liefern `Error`
- `assume` — wirft bei Nichterfüllung
- `runJs` — offensichtlich `~>`
- `toIsoDateText` — deterministisch bezüglich der Argumente, aber abhängig von Zeitzone und ICU.
  Für den **Pfeil** ist das unerheblich (`->` ist korrekt: die Funktion selbst fügt nichts hinzu);
  für die **Faltung** wird es relevant und ist im Hauptdokument als offener Punkt vermerkt.

## Schritt 7 — Die Argument-Regel

Bei der Auflösung eines Funktionsaufrufs (dort, wo heute
`getReturnTypeFromFunctionCall`/`dereferenceArgumentTypesNested` greifen): ein Aufruf ist beweisbar
rein, wenn

1. der Typ der aufgerufenen Funktion `purity === 'pure'` trägt, **und**
2. jedes Argument, dessen Typ ein Funktionstyp ist, seinerseits `'pure'` trägt.

Alles andere ist `'impure'`. Kein Fixpunkt, kein neuer Zustand im Typ — das Ergebnis gilt für diese
eine Aufrufstelle.

**Abgrenzung:** Betrachtet werden nur Argumente, deren Typ *direkt* ein Funktionstyp ist. Funktionen
in einem Datenargument (`f([cb = log])`) erfasst die Regel nicht. Für diese Hälfte ohne Belang —
sie hat noch keinen Konsumenten, der falsch entscheiden könnte.

**Ehrlich zu notieren:** In dieser Hälfte hat die Regel *keinen* Konsumenten. Ihr Zweck hier ist,
dass `->` an `map` & Co. eine wahre Aussage ist; verbraucht wird sie erst vom Constant Folding. Sie
ist deshalb als eigene, testbare Funktion zu bauen (etwa `getCallPurity(functionType, argsType)`),
nicht in die Faltungsstelle eingebettet.

### Tests

- `map(add ...)` → `'pure'`
- `map(log ...)` → `'impure'`
- `map(myFn ...)` mit `myFn = () :> Any => someFn()` → `'impure'` (konservativ; `myFn` ist
  `'unknown'`)
- `toDictionary` mit einem reinen und einem unreinen Callback → `'impure'`
- `add(2 3)` → `'pure'` (keine Funktionsargumente)
- `f = map`, dann `f(add ...)` → `'pure'` (die Regel arbeitet am Typ, nicht am Symbol)

## Schritt 8 — Mitziehende Artefakte

- **TextMate-Grammatik**: [jul.tmLanguage.yaml:87](../../vscode-jul-language-service/syntaxes/jul.tmLanguage.yaml#L87)
  hat `match: :>` unter `keyword.operator.expression.returntype.jul`. Regel auf `(:|-|~)>` erweitern
  oder zwei Regeln danebenstellen. **Die YAML ist die Quelle**, danach
  `npm run convert-grammar` in `vscode-jul-language-service`.
- **Handbuch**: [handbook.md:65](../../jul-homepage/docs/docs/documentation/handbook.md#L65)
  (`MyFunctionType = (param1: Text) :> Any`). Das Beispiel bleibt gültig, weil `:>` unverändert
  „keine Aussage" heißt; die neuen Pfeile gehören als eigener Absatz dazu — nach der Vorlage des
  Bestands: **was gilt, mit Beispiel**, keine Begründungen (siehe CLAUDE.md, „Welches Dokument
  wofür"). Die englische Fassung unter `i18n/en/` enthält den Abschnitt heute nicht.
- **Snippets**: `snippets.json` enthält keinen Pfeil — nichts zu tun.
- **Fehlercode-Doku**: kein neuer Code, also keine Änderung.

## Schritt 9 — `typeToString`

[checker.ts:5774](../src/checker/checker.ts#L5774) rendert heute fest
`${paramsString} :> ${returnString}`. Künftig nach `type.purity`:

| Purity | Ausgabe |
| --- | --- |
| `'unknown'` | `:>` |
| `'pure'` | `->` |
| `'impure'` | `~>` |

`'unknown'` als `:>` heißt: für Nutzercode ändert sich in Hover und Fehlermeldungen **nichts**, und
die 64 bestehenden `:>`-Testerwartungen bleiben gültig.

### Die beiden Baselines

Das ist der Punkt, an dem der Umbau sichtbar wird, und zwar automatisch:

- **`checker-snapshot.baseline.txt`** hält den inferierten Typ je Top-Level-Symbol über alle
  `jul-examples` fest (42 Zeilen mit `:>`). Jedes Symbol, dessen Typ eine core-lib-Funktion ist,
  rendert danach `->` oder `~>`. Neu schreiben mit `npm run test-update-snapshot`
  (`UPDATE_SNAPSHOT=1 npm test`) — **und den Diff lesen**: er ist die beste Gegenprobe auf die
  Migration aus Schritt 6. Ein `~>` an einer Funktion, die rein sein sollte, fällt hier auf.
- **`checker-stats.baseline.txt`** ist ein deterministisches Zähler-Gate (`inferType`,
  `resolvePlaceholders`, `getTypeError`). Ändert es sich, ist das erklärungsbedürftig: die
  `typeEquals`-Umstellung aus Schritt 4 kann Deduplizierung und damit Aufrufzahlen verschieben.
  Nicht blind aktualisieren.

## Schritt 10 — Abschluss der ersten Hälfte

```bash
cd jul-compiler
npm test
npm run typecheck
npm run bench -- --save --note "nach pure-functions Schritt 1-10 (Pfeile, Purity im Typ)"
```

Dazu ein paar `jul-examples`-Projekte neu bauen, und — wegen der ungepinnten globalen Installation —
prüfen, ob `C:\Projects\privat\yugioh` noch baut. Es sollte: `:>` bleibt unverändert gültig, und
die Migration betrifft nur core-lib.

Danach ist die Ausbaustufe entweder abgeschlossen oder es folgt das Constant Folding als eigenes
Dokument.

---

## Reihenfolge und Abhängigkeiten

```
1 (Bench)
 └─ 2 (roter Test) ─── bleibt rot bis 6
     └─ 3 (Parser) ──┐
                     ├─ 4 (Typdarstellung) ── 5 (Checker liest Pfeil)
                     │                          └─ 6 (core-lib) ── 7 (Argument-Regel)
                     └─ 8 (Grammatik/Doku)                          └─ 9 (typeToString)
                                                                        └─ 10 (Bench/Tests)
```

3 vor 4, weil `arrow` am Knoten existieren muss, bevor der Checker es liest. 6 vor 7, weil die
Argument-Regel ohne migrierte core-lib nichts Sinnvolles liefert. 9 spät, weil der Snapshot-Diff
erst nach der Migration aussagekräftig ist.

## Risiken

| Risiko | Wo | Abfederung |
| --- | --- | --- |
| Predicate an [parser.ts:1037](../src/parser/parser.ts#L1037) vergessen | Schritt 3d | `(a) -> b` parst nicht; die sechs Parser-Tests fangen es |
| `typeEquals`-Umstellung verschiebt Deduplizierung | Schritt 4d | Stats-Baseline und Bench in Schritt 10 |
| Bool-Werte ungeprüft übernommen | Schritt 6 | 6c/6d einzeln durchgehen; der Snapshot-Diff in Schritt 9 liest die ganze Migration auf einmal |

Kein Risiko für Nutzercode außerhalb von core-lib: `:>` behält Schreibweise und Bedeutung, es gibt
keinen neuen Fehler, und die Zuweisbarkeit ändert sich nicht (Frage 4 = 4A).
