# Width Subtyping: ein Typ nennt Anforderungen

**Entschieden.** Internes Arbeitsdokument, Aufbau nach
[design-principles.md](design-principles.md). Was noch zu tun ist, steht in Abschnitt 5.

Die Ausgangsfrage war: Bedeutet `[Integer Integer]` genau zwei Elemente oder mindestens zwei?
Die Antwort ist **mindestens zwei** — und das ist keine Tupel-Eigenheit, sondern die Regel der
ganzen Sprache.

---

## 1. Die Entscheidung

> **Ein Typ nennt Anforderungen, kein vollständiges Bild.** Ein Wert muss sie erfüllen und darf
> sie übertreffen. Das gilt für Felder wie für Positionen: `[a: Integer]` akzeptiert
> `[a = 1 b = 2]`, `[Integer Integer]` akzeptiert `[1 2 3]`. Wer variable Länge *fordern* will,
> schreibt `List(X)` oder `...rest`.
>
> **Was sichtbar weggeworfen wird, wird gewarnt.** Steht der überzählige Wert im Quelltext an
> genau dieser Stelle, meldet der Compiler ihn — als Warnung, nicht als Fehler.

Der zweite Satz schränkt den ersten nicht ein. Er sagt nichts über Zuweisbarkeit, sondern über
toten Code: Ein hingeschriebener Wert, der nie ankommt, ist mit hoher Wahrscheinlichkeit ein
Versehen.

### Warum so entschieden

**Prinzip 2 gab den Ausschlag** („bei einer Ausnahme ist die Regel falsch, nicht der Fall").
Dictionaries, Tupel und Parameterlisten folgen heute alle derselben Regel. Sie für Positionen zu
verschärfen hieße, eine Ausnahme in ein Konstrukt einzubauen, das für Namen und Positionen
dasselbe ist: `f(1 2)` und `f(a = 1 b = 2)` sind derselbe Aufruf gegen dieselbe Parameterliste.

**Die core-lib setzt die Regel voraus** (Beleg in Abschnitt 3). Ein einstelliger Callback an
`map` ist nur zulässig, weil weniger zu fordern erlaubt ist. Das ist kein Geschmacksurteil,
sondern eine Abhängigkeit.

**Prinzip 1 bleibt gewahrt, aber anders als zunächst gedacht.** Dass man `[Integer Integer]` die
Regel nicht ansieht, stimmt — es gilt für `[a: Integer]` genauso, und dort überrascht es
niemanden. Gefehlt hat die Dokumentation, nicht die Strenge. Die Warnung setzt dort an, wo
Prinzip 1 wirklich verletzt ist: beim geschriebenen Wert, der verschwindet.

### Was ausdrücklich nicht gilt

Die Warnung greift **nur bei Literalen an Ort und Stelle**. Nicht bei `f(...args)`, nicht bei
einer Variablen mit längerem Wert, nicht beim Branching. Dort ist ein längerer Wert oft genau
die Absicht, und der Schreiber sieht an der Stelle nichts, was er löschen könnte.

---

## 2. Verworfene Optionen

Stehen mit Begründung, damit die Frage nicht neu aufgerollt wird.

| | Inhalt | Warum verworfen |
|---|---|---|
| **B** | Exakte Länge überall | Macht Positionen zur Ausnahme, während Namen weit bleiben. Bricht die core-lib-Callbacks. Verschärft `_branch`, ohne dass ein nicht getroffener Zweig überhaupt gemeldet würde |
| **C** | Exakt, plus `[Integer Integer ...]` für das Präfix | Neue Syntax für etwas, das heute die Regel ist. Kehrt Vorgabe und Ausnahme um: Der häufige Fall müsste ausgeschrieben werden |
| **D** | Exakt beim Aufruf, Präfix beim Matching | Prinzip 2 — dieselbe Konstruktion bedeutete an zwei Stellen Verschiedenes |
| **E** | Überlange Werte generell warnen | Warnt auch, wo nichts zu ändern ist (Variable, Spread). Eine Warnung ohne Handlungsmöglichkeit ist Rauschen. F ist dieselbe Idee, beschränkt auf die Stellen, an denen sie wahr und behebbar ist |

Neu aufzurollen wäre die Frage nur, wenn Width Subtyping bei **Dictionaries** selbst in Zweifel
steht. Dann ist es dieselbe Entscheidung und gehört gemeinsam getroffen.

---

## 3. Belege

Alles ausgeführt, nicht aus der Erinnerung.

### Die Regel ist überall dieselbe

| Fall | heute |
|---|---|
| `x: [a: Integer] = [a = 1 b = 2]` | — |
| `x: [a: Integer b: Integer] = [a = 1]` | `Can not assign Empty to Integer.` |
| `x: [Integer Integer] = [1 2 3]` | — |
| `x: [Integer Integer] = [1]` | `Can not assign Empty to Integer.` |
| `f = (a: Integer) => a` · `f(1 2)` | — |
| `f()` | `Can not assign Empty to Integer.` |
| `f(a = 1 b = 2)` | — |
| `g = [Integer Integer] => []` · `g(1 2 3)` | — |

Überzähliges zulässig, Fehlendes nicht — in allen vier Formen. „Zu kurz meldet" ist dabei keine
Arity-Regel, sondern die `Empty`-Prüfung gegen den deklarierten Typ.

Die Fundstellen iterieren jeweils nur über das Ziel:
[getTupleTypeError2](../src/checker.ts#L2972),
[getDictionaryLiteralTypeError](../src/checker.ts#L2996),
[getTypeErrorForParametersWithCollectionArgs](../src/checker.ts#L3106).

### Die Laufzeit sagt dasselbe

Typprüfung gibt es zur Laufzeit **nur fürs Branching**: `_branch` ruft
[tryAssignArgs](../src/runtime.ts#L524), der gewöhnliche Aufruf geht über
[assignArgs](../src/runtime.ts#L467) und prüft nichts. Maßstab ist deshalb `tryAssignArgs`.

| Fall | Ergebnis |
|---|---|
| `_branch` mit `(a: Integer)` und `[1 2]` | matcht |
| `_branch` mit `(a: Integer)` und `()` | matcht nicht |
| `_branch` mit `(a)` untypisiert | matcht alles |
| `_branch` mit `(a: Integer)` und `[a = 1 b = 2]` | matcht |
| `_branch` mit `[Integer Integer]` und `[1 2 3]` | matcht |
| `_branch` mit `[Integer Integer]` und `[1]` | `did not match any branch` |

[getTupleTypeError](../src/runtime.ts#L418) meldet ausschließlich
`value.length < elementTypes.length`. Der Checker bildet die Laufzeit also korrekt ab.

### Die core-lib hängt daran

Bei Funktionstypen kehrt sich die Regel an der Parameterposition um; der Checker rechnet
kontravariant ([case 'function'](../src/checker.ts#L2773) vertauscht Ziel und Wert). Aus
`[Text Text]` ⊆ `[Text]` folgt: `[Text] :> Boolean` ist **Teilmenge** von
`[Text Text] :> Boolean`. Wer weniger fordert, ist überall einsetzbar, wo mehr geliefert wird.
Verifiziert: der `[Text] :> Boolean`-Wert passt in den `[Text Text] :> Boolean`-Slot, umgekehrt
kommt `Can not assign Empty to Text.`

`map` deklariert seinen Callback zweistellig:

```jul
callback: (value: TypeOf(values)/ElementType index: PositiveInteger) :> Any
```

`map(l (value: Integer) => value)` geht durch — einstelliger Callback gegen zweistelligen Typ,
allein durch diese Regel. 18 Callback-Deklarationen mit `index` stehen in der core-lib.

### Zahlen aus echtem Code

| | jul-examples (27 Dateien) | yugioh (10 Dateien) |
|---|---|---|
| Funktionsaufrufe | 214 | 1398 |
| davon mit Spread-Argument | 4 | 0 |
| Branchings | 21 | 245 |
| Funktionsliterale | 107 | 828 |
| davon mit Typ statt Parameterliste | 33 | 531 |
| davon mit `...rest` | 4 | 0 |

Der Typkopf ist mit 64 % in yugioh der Normalfall, nicht die Randform — eine Verschärfung hätte
die Mehrheit der Funktionsliterale getroffen. Spread im Aufruf ist mit 4 von 1612 praktisch
nicht vorhanden.

---

## 4. Was die Warnung erkennen soll

**Nur beim Aufruf.** `assignArgs` bindet ausschließlich die deklarierten Parameter, alles weitere
fällt weg:

```jul
f = (a: Integer) => a
f(1 2)                  # die 2 steht da und verfällt
f(a = 1 b = 2)          # b = 2 steht da und verfällt
```

**Nicht bei der Zuweisung.** Der TypeGuard prüft, er formt nicht um: `x` behält den Typ des
Werts samt allem, was darüber hinausgeht.

```jul
x: [a: Integer] = [a = 1 b = 2]
x/b                     # 2 - nichts verworfen
```

Bedingungen, alle nötig:

1. Der überzählige Wert ist **geschriebener Ausdruck**, kein Spread. Ein Spread verschiebt die
   Zuordnung unbekannt weit bzw. bringt unbekannte Felder mit.
2. Die Parameterliste ist **bekannt**: `singleNames` ohne `rest`, oder ein Tupel- bzw.
   Dictionary-Typkopf. `List`, `Any`, `Or`, `parameterReference` heißen „unbekannt" und schweigen
   (Prinzip 4).
3. Kein `rest` — der verbraucht alles.
4. Das Prefix-Argument zählt als erstes Argument (`1.f()`).
5. **Branchings sind ausgenommen.** Bei `?(1 2)` gehört die Werteliste dem Branching, nicht einem
   Zweig; ein späterer Zweig darf das zweite Element konsumieren.

Die Meldung sitzt auf dem überzähligen Ausdruck bzw. dem ganzen Feld — der Einheit, die gelöscht
wird.

---

## 5. Umsetzungsplan

Jeder Schritt einzeln, roter Test vor dem Fix.

**Reihenfolge:** Schritt 2 kam vor Schritt 1, weil sich der Severity-Filter nicht rot testen
lässt, solange kein einziger Code eine Warnung ist. Das Emittieren der Warnung (Schritt 3) bleibt
hinten — vorher bräche sie den Build.

### Schritt 1 — Severity respektieren ✔ erledigt

[compileFile](../src/compiler.ts#L212) brach bei `errors?.length` ab, ohne die Severity
anzusehen. Eine Warnung hätte den Build genauso scheitern lassen wie ein Fehler.

- `compileFile`, Abschnitt „6. check": abbrechen nur, wenn ein Eintrag `severity === 'error'` hat.
  Warnungen werden ausgegeben, das Ergebnis entsteht trotzdem. Abschnitt „2b. check parse errors"
  bleibt unverändert — dort ist alles `'error'`.
- **Kein eigener Test.** Ein erster Anlauf hatte die Bedingung als `hasBlockingError` extrahiert
  und unit-getestet; der Test prüfte damit im Wesentlichen `Array.some` und die `errorInfos`-
  Tabelle, und die Extraktion existierte nur für ihn. Beides zurückgebaut, die Bedingung steht
  jetzt bei ihrem einzigen Aufrufer.
- **Abnahme erfüllt** (nach Schritt 3): eine Datei mit `f = (a: Integer) => a` und `log(f(1 2))`
  meldet `SemanticWarning JUL2500`, baut erfolgreich durch, Exit-Code 0, und das Bundle gibt `1n`
  aus — genau das, was die Warnung ankündigt.
- Vgl. [Checker-Audit](CHECKER-AUDIT.md), Punkt 7.

### Schritt 2 — ErrorCode anlegen ✔ erledigt

`discardedValue = 2500`, `{ type: 'semantic', severity: 'warning' }`.

**Korrektur am ursprünglichen Vorschlag:** `5200` wäre falsch gewesen. Die Tausenderblöcke folgen
der Kategorie — die 5000er sind `type`. Ein `semantic`-Code gehört in den 2000er-Block, und
2500–2599 ist als „Verworfene Werte" frei.

`semantic`, nicht `type`: Die Aussage ist „dieser Wert kommt nie an", keine Typverletzung. Ein
längerer Wert ist ja zulässig. Präzedenz für einen im Checker erzeugten `semantic`-Code ist
`alreadyDefinedInUpperScope`.

Alle drei Pflichteinträge gesetzt: Enum, `errorInfos`, Abschnitt `JUL2500` in
`jul-homepage/docs/docs/documentation/error-codes.md`. Dort auch die Nummernbereichs-Tabelle
ergänzt und der Satz „Derzeit sind alle Codes `error`" korrigiert.

### Schritt 3 — Prüfung im Checker, positionell ✔ erledigt

`checkDiscardedArguments` in [checker.ts](../src/checker.ts), aufgerufen im `functionCall`-Zweig
nach `areArgsAssignableTo`. Die Stelligkeit kommt aus `getKnownArity`, das bei einem `rest` und
bei allem, was keine Parameterliste und kein Tupel ist, `undefined` liefert — unbekannt heißt
schweigen (Prinzip 4). Jeder überzählige Ausdruck wird einzeln auf seiner eigenen Position
gemeldet: er ist einzeln löschbar.

**Korrektur während der Umsetzung.** Der Plan sah eine zweite Fundstelle bei der Zuweisung vor.
Die ist falsch: Der TypeGuard prüft, er formt nicht um. Nach `x: [Integer Integer] = [1 2 3]` hat
`x` den Typ `[1 2 3]`, das emittierte JS enthält alle drei Elemente, und `x/3` bleibt lesbar. Bei
einer Zuweisung wird also nichts verworfen. Aufgefallen ist es an
`jul-examples/type-checking-test.jul`, wo `testDictionaryLiteral3a` genau diesen Fall mit
`# should not error` festhält — die Abnahme gegen echten Code hat den Fehler gefangen, die Tests
allein hätten ihn durchgelassen.

Die Warnung gilt daher **nur für Aufrufe**, wo `assignArgs` überzählige Argumente tatsächlich
fallen lässt.

**Nebenher:** Der Snapshot schrieb pauschal `error` vor jeden Code. Jetzt, wo Severities sich
unterscheiden, verdeckte das die Unterscheidung im Diff — er gibt die tatsächliche Severity aus.

### Schritt 4 — Benannte Argumente ✔ erledigt

`checkDiscardedFields` für Argumentkollektionen, die als Dictionary geschrieben sind:
`f(a = 1 b = 2)` gegen `(a: Integer)` meldet `b = 2`. Gemeldet wird das ganze Feld, denn das ist
die Einheit, die gelöscht wird. `getKnownFieldNames` liefert die Namen aus der Parameterliste
oder einem Dictionary-Typkopf, sonst `undefined`.

Zwölf Tests in `checker.test.ts`, zwei positive und zehn Gegentests. Die Gegentests halten die
Entscheidung fest: Spread, Variable, gebranchter Wert, Rest-Parameter und **Zuweisung** melden
nicht.

**Dabei gefunden:** Benannte Argumente gegen einen `rest`-Parameter sind gar nicht umgesetzt —
der Checker meldet `Can not assign dictionary to rest parameter`, die Laufzeit wirft
`tryAssignArgs not implemented yet for rest dictionary`. Als Test
`named-arguments-with-rest-parameter-are-not-supported` festgehalten.

**Nicht abgedeckt:** Bindet ein Prefix-Argument den ersten Parameter, gewinnt es zur Laufzeit
gegen ein gleichnamiges Feld (`1.f(a = 2)` verwirft die `2`). Das bleibt still — ein verpasster
Fall, keine Falschmeldung.

### Schritt 5 — Destructuring ✔ erledigt

Beim Destructuring hält **keine** Variable den ganzen Wert: `_temp` ist blocklokal, nur die
gebundenen Namen kommen heraus. Ein übriges Feld ist danach unerreichbar — anders als bei der
Definition, wo das Symbol alles behält.

```jul
(a) = [a = 1 b = 2]     # b ist danach unerreichbar
```

`checkDiscardedDestructuringFields` liest die Namen über die Quelle (`(x = a)` bindet `a`), nicht
über den neuen Namen.

**Absicherung, die ein Fehlalarm erzwungen hat:** Gemeldet wird nur, wenn **jeder** gewünschte
Name im Wert steht. Sonst ist der nicht auflösbare Name die Ursache und das übrige Feld nur ihre
Folge — `(myA1 b) = [a = 1 b = 2]` lieferte sonst zwei Meldungen für einen Fehler. Aufgefallen an
`jul-examples/type-function.jul`, wo `(myA1 = a/a1 b)` steht: Ein Pfad als Destructuring-Quelle
ist ungültige Syntax (JUL2400), und die Warnung stapelte sich auf den bestehenden Parse-Fehler.

**Dabei gefunden:** Positionelles Destructuring ist im Checker nicht umgesetzt. `(a b) = [1 2]`
meldet `Failed to dereference a in type [1 2]`, obwohl das emittierte JS es kann
(`_isArray ? _temp[0] : _temp.a`). Gehört ins [Checker-Audit](CHECKER-AUDIT.md), nicht hierher.

#### Messung gegen echten Code

| | Aufrufe | JUL2500 |
|---|---|---|
| jul-examples | 214 | 1 |
| yugioh | 1398 | 0 |

Der eine Treffer ist echt: `subtract(1 2 3)` in `jul-examples/test1.jul` — `subtract` nimmt zwei
Parameter, die `3` verfällt. Die Datei ist eine Kladde und enthält schon andere absichtliche
Fehler; die Warnung steht daher in der Snapshot-Baseline. **Kein einziger Fehlalarm.**

Alle Beispielprojekte bauen weiterhin, außer `./import` mit seinem vorbestehenden `JUL1151`.
yugioh wurde in Post-Order mit gemeinsamem `documents`-Record geprüft und ist derzeit
vollständig meldungsfrei — ein erster Lauf ohne diese Reihenfolge hätte nichts gemessen, genau
wie im [Checker-Audit](CHECKER-AUDIT.md) beschrieben.

### Schritt 6 — Die Regel aufschreiben ✔ erledigt

- `jul-homepage/docs/docs/documentation/handbook.md`, Abschnitt „Typen": ein Unterabschnitt
  „Ein Typ nennt Anforderungen" mit je einem Beispiel für Feld und Position, dem Gegenstück für
  Fehlendes, und dem Hinweis auf `List(X)` bzw. den Rest-Parameter. Alle fünf Beispiele wurden
  ausgeführt, bevor sie in die Doku kamen. Ohne Verweis auf `JUL2500`: Das Handbuch beschreibt
  die Sprache, die Fehlercode-Doku beschreibt die Meldungen, und verwiesen wird von dort hierher
  — nicht umgekehrt.
- [CLAUDE.md](../../CLAUDE.md), Sprachkern: ein Absatz neben dem zu `Empty`, mit dem
  core-lib-Fall (einstelliger Callback an `map`) und der Abgrenzung Zuweisung/Aufruf.

Damit ist der Plan abgearbeitet.


### Abnahme insgesamt

```bash
cd jul-compiler
npx mocha --import=tsx --require ./test-setup.mjs src/checker.test.ts
npm run typecheck
npm test
npm run build
```

Dazu der Durchlauf gegen echten Code — ein grüner Testsatz reicht hier nicht, das hat der
`dereferenceFailed`-Fix gezeigt. jul-examples bauen (Referenzstand: alle OK außer `./import`,
vorbestehender Parse-Fehler `JUL1151`) und yugioh in Post-Order prüfen, Vorgehen im
[Checker-Audit](CHECKER-AUDIT.md).

**Jede neue Warnung ist einzeln anzusehen.** Sie ist nur dann richtig, wenn der gemeldete
Ausdruck tatsächlich verfällt und gelöscht werden kann. Erwartung nach den Zahlen aus
Abschnitt 3: wenige bis keine. Sind es viele, ist entweder die Bedingungsliste aus Abschnitt 4
unvollständig, oder das Muster hat einen Zweck, den dieses Dokument nicht kennt — dann anhalten,
nicht die Bedingungen nachziehen.

---

## 6. Angrenzende Befunde

Fallen bei dieser Arbeit an, brauchen aber keine Entscheidung mehr:

- **Untypisierter Rest-Parameter matcht nie** ([Audit](CHECKER-AUDIT.md), Punkt 6).
  `restType ? … : true` liefert ohne Typ einen Fehler. Unsound, trifft die Catch-all-Schreibweise.
- **„Parameter name mismatch" nennt die Rollen verkehrt herum** ([Audit](CHECKER-AUDIT.md),
  Punkt 8). Folge der Kontravarianz, die die Meldung nicht zurückrechnet.
- **Zweig mit Tupeltyp sieht seine Werte nicht.** Im `paramsType`-Pfad geben `assignArgs` und
  `tryAssignArgs` ein leeres Array zurück: `[Integer Integer] => …` wird ohne Argumente
  aufgerufen, der Body sieht `[]`, obwohl `[1 2 3]` gematcht hat.
- **Spread bleibt ungeprüft.** Spread-Elemente werden in [case 'list'](../src/checker.ts#L1371)
  zu `any`. Für die Warnung ist das kein Verlust — sie nimmt Spread ohnehin aus —, für die
  Typprüfung schon.
