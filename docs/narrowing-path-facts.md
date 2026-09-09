# Umsetzungsplan: Verengung als Fakten über Pfaden

Umsetzung von Option E aus [narrowing-through-field-access.md](narrowing-through-field-access.md).
Dort steht das Warum und der Vergleich mit anderen Sprachen; hier steht, was zu tun ist.

## Ziel

Verengung hängt nicht mehr am Namen, sondern am **Pfad**. Ein Name ist dann der Sonderfall eines
Pfads der Länge 1. Erreicht sein soll:

```jul
?(d/a)                      # Feldpfad im Kopf verengt d
	(y: Integer) => …

stepType = step/type        # und über eine Zwischenvariable hinweg
?(stepType)
	[Text] => step/query      # step ist hier nicht mehr Empty
```

**Nicht in diesem Plan:** Verengung aus Booleschen Bedingungen (`isEmpty = step.equal()`), Pfade
über Indizes (`values/2`), Fakten über mehrere korrelierte Argumente. Alle drei sind später
Erweiterungen der Befüllung, kein Umbau — genau deshalb E statt B.

## Ausgangslage

Steht schon:

- **rot** (Zielverhalten): `branch-narrowing-through-field-path`,
  `branch-narrowing-reaches-source-of-field`, `branch-narrowing-field-path-in-nested-branching`,
  `branch-narrowing-deep-field-path`
- **grün** (grenzen den Umbau ein): `…-needs-a-name-as-source`, `…-is-per-branch`,
  `…-any-does-not-widen`, `…-ends-with-the-branch`
- Vorher-Messung protokolliert: **3684,55 ms**, `inferType 273148`, `resolvePlaceholders 2799688`,
  `getTypeError 313632`

Die Regel selbst ist gemessen und trägt: `And(Quelltyp [Feld: T])` entfernt `Empty`, hält den
korrelierten Fall einer diskriminierten Union auseinander und lässt das Feld lesbar.

### Zwei Fallen beim Schreiben weiterer Tests

Beide sind hier schon aufgetreten und haben je einen unbrauchbaren Test erzeugt:

- **Eine Quelle, die ein Parameter ist, verschluckt den Fehler.** Platzhalter werden permissiv
  geprüft, der Test wäre vorher und nachher grün und bewiese nichts.
- **Ein deklarierter Rückgabetyp erzeugt keine Union.** Eine Definition übernimmt den *inferierten*
  Typ des Werts; `getD = (…) :> D => [a = 1]` liefert `[a: 1]`, nicht `D`. Die Union muss im Rumpf
  wirklich entstehen, z.B. über ein branching.

## Zwei Entscheidungen vor der ersten Zeile

### 1. Wie kommt die Umgebung an die Prüfstellen? — entschieden: explizites Argument

`inferType` reicht heute `scopes`, `parsedDocuments`, `folder`, `file`, `filePath` durch jede
Rekursion. Die Fakten nehmen denselben Weg: als weiteres Argument.

Verworfen wurde ein modulweiter Stapel, der um den Branch-Rumpf herum auf- und abgebaut wird. Er
wäre billiger zu schreiben, aber der Checker läuft re-entrant — die core-lib wird beim Modul-Load
geprüft, der Sprachserver prüft viele Dateien nacheinander. Ein vergessenes Abräumen wäre dort
nicht lokal zu finden, sondern zeigte sich als Verengung, die in eine fremde Datei ausläuft.

Umfang: 28 Aufrufe von `setInferredType`, 2 von `inferType`, 3 von `inferFileTypes` — alle in
[checker.ts](../src/checker.ts), keiner im Sprachserver. Rein mechanisch.

### 2. Wie sieht ein Pfad als Schlüssel aus? — entschieden

Wurzel ist die **Objektidentität der `SymbolDefinition`**, nicht der Name. Nicht wegen gültiger
Programme — ein Name, den es im äußeren Scope schon gibt, ist in JUL bereits ein Fehler
(`alreadyDefinedInUpperScope`, geprüft für Definition und Branch-Parameter). Sondern wegen
halbfertigem Code, der laut Prinzip 8 der Normalfall ist: Die Identität kostet nichts extra und
hält auch dann, wenn die Meldung schon steht.

`Map<SymbolDefinition, { segmente, typ }[]>`, beim Betreten eines Rumpfs kopiert.

Begründung über den **Fehlschlag**, nicht über den Treffer: Praktisch jede Referenz ist *nicht*
verengt, jeder Nachschlag also ein Fehlschlag. Mit der Wurzel als äußerem Schlüssel kostet der
einen Identitäts-Nachschlag, unabhängig von der Schachtelungstiefe. Eine flache Liste mit
Elternzeiger wäre dort am teuersten, und tief geschachtelt wird in JUL viel, weil es kein `return`
gibt — man verzweigt ineinander statt früh auszusteigen.

Innerhalb einer Wurzel ist die Menge dagegen wirklich klein (die Pfade unter *einer* Variablen),
dort genügt ein Array mit linearer Suche. Die Präfixsuche ist damit ein Vergleich der
Segmentanfänge; bei mehreren Treffern gilt der längste. Segmente bleiben ihre eigenen Werte, damit
entfällt der Zeichenkettenbau und mit ihm die Frage nach dem Trennzeichen — Feldname `2` und
Index `2` sind ohne Zutun verschieden.

**Annahme, die das Kopieren trägt:** JUL kennt keine Zusammenführungen. Ein branching ist ein
Ausdruck, seine Zweige sind Funktionen, Fakten verlassen den Rumpf nie; vereinigt werden nur die
Rückgabetypen. Ohne `return`, Schleifen und Zuweisung entsteht keine Stelle, an der zwei
Umgebungen verschmolzen werden müssten. Kotlin braucht dafür eine persistente Map mit
struktureller Teilung — hier genügt eine Kopie je Rumpf, die danach nie wieder angefasst wird.
Bekäme JUL Schleifen oder Zuweisung an bestehende Namen, wäre diese Wahl neu zu bewerten.

Die Schnittstelle bleibt eng (`getNarrowedType`, `withNarrowedType`), damit die Messung aus
Schritt 6 einen Wechsel auf einen Trie noch erlaubt.

### 3. Wie heißt das im Code? — entschieden

Nicht „Fakt". Der Begriff stammt aus diesem Dokument und aus der Literatur; die Codebasis hat für
dieselbe Sache längst ein Vokabular — englische Bezeichner mit `narrow*`, deutsche Kommentare mit
„Verengung" (`narrowBranchedType`, „verengen heißt schneiden, nicht ersetzen"). Ein drittes Wort
daneben trennt nur, was dasselbe meint.

```ts
/** Verengte Typen je Zugriffspfad, gültig im Rumpf eines branches. */
type NarrowedTypes = Map<SymbolDefinition, NarrowedPath[]>;

interface NarrowedPath {
	/** Feldnamen und Indizes ab der Wurzel. Leer = die Wurzel selbst. */
	keys: (string | number)[];
	type: CompileTimeType;
}
```

| Name | Aufgabe |
|---|---|
| `getAccessPath(expression, scopes)` | Ausdruck → `{ symbol, keys }` oder `undefined`, wenn er keinen Pfad hat |
| `getNarrowedType(narrowedTypes, symbol, keys)` | Nachschlag samt Präfixsuche |
| `withNarrowedType(narrowedTypes, symbol, keys, type)` | liefert eine **neue** Umgebung |

Der Parametername ist durchgehend `narrowedTypes`, neben `scopes`, das denselben Weg nimmt.

Verworfen: `TypeFacts`/`FactTable` (schleppen den Literaturbegriff ein) und `NarrowedSymbols` (es
hängt gerade *nicht* mehr an Symbolen — das ist der Unterschied zum heutigen Zustand).

Dass `withNarrowedType` eine neue Umgebung liefert statt zu mutieren, gehört in den Namen: Es macht
die Kopie beim Betreten des Rumpfs zur einzigen Stelle, an der die Umgebung wächst, und schließt
aus, dass eine Verengung nach außen sichtbar wird.

## Schritte

### 1. Pfad und Ablage

`NarrowedTypes`, `NarrowedPath` und die drei Funktionen aus Entscheidung 3.
`getAccessPath` liefert `undefined` für alles, was keine Wurzel mit literaler Schlüsselfolge ist —
ein Aufruf als Quelle (`getStep(flag)/type`) hat keinen Pfad. Das ist die Stelle, die
`…-needs-a-name-as-source` absichert.

Die Wurzel wird über die **Scopes** aufgelöst (`findSymbolInScopes`), nicht über den inferierten
Typ des Quellausdrucks: Der Typ einer Referenz ist bei einem Parameter ein `parameterReference` und
führt nicht zum Symbol zurück.

`withNarrowedType` **ersetzt** einen vorhandenen Eintrag für denselben Pfad, statt ihn anzuhängen.
Der neue Typ entsteht per `And(bisher, …)` und ist damit ohnehin der engere; zwei Einträge für
denselben Pfad würden die Präfixsuche nur vor eine Wahl stellen, die keine ist.

### 2. Befüllen aus dem Branch-Kopf

Ersetzt den Abschnitt „narrowed type symbol für branching" in `case 'functionLiteral'`.
Je geschriebenem Argument:

- Pfad bestimmen; ohne Pfad nichts eintragen
- Typ aus dem Kopf holen (`getBranchArgumentType`) und vorherige Branches abziehen
  (`getPreviousBranchArgumentType`) — beides bleibt unverändert
- Fakt für den Pfad eintragen: `And(bisheriger Typ, Kopftyp)` über `narrowBranchedType`
- **Aufwärtsregel:** für einen Pfad der Länge > 1 zusätzlich einen Fakt für den Elternpfad
  eintragen: `And(Typ des Elternpfads, [letztes Segment: verengter Typ])`

Wer die neue Umgebung sieht, und wer nicht:

| | Umgebung |
|---|---|
| Params des branches (`(y: Integer)`) | die **äußere** — sie werden vor der Verengung inferiert und sagen sie erst aus |
| Rumpf des branches | die **neue** |
| deklarierter Rückgabetyp des branches | die **neue** — er steht im Rumpfkontext und darf dieselbe Verengung sehen |
| `args` des branchings | die **äußere** — sie werden in `case 'branching'` vor den Zweigen inferiert |

Der gebranchte Ausdruck selbst behält also seinen unverengten Typ; verengt sind nur Nachschläge
**im** Rumpf. Ein geschachteltes branching erbt die äußeren Fakten dadurch von selbst, weil seine
`args` im Rumpf des äußeren Zweigs inferiert werden.

Die Symbol-Überschattung entfällt damit; die Folge für den Sprachserver steht in Schritt 5.

### 3. Nachschlagen

Zwei Stellen konsultieren die Umgebung, bevor sie rechnen:

- `dereferenceType` für eine Referenz: Pfad der Länge 1
- `case 'nestedReference'` in `inferType`: Pfad aus Quelle und Schlüssel

Trifft kein Fakt genau, aber einer für einen **Präfix** des Pfads, wird von dort aus wie bisher
dereferenziert. Damit wirkt schon der Aufwärts-Fakt allein: `step/query` erbt aus dem verengten
`step`.

### 4. Herkunft über die Zwischenvariable

Der Fall `stepType = step/type` braucht einen Schritt, den auch E nicht geschenkt bekommt: Ist das
Branch-Argument eine Referenz, deren Symbol über `symbol.definition.value` auf einen
`nestedReference` mit literalem Schlüssel zurückgeht, gilt der Fakt zusätzlich für **dessen** Pfad —
und von dort greift die Aufwärtsregel aus Schritt 2.

Eng prüfen: nur `nestedReference` mit literalem Schlüssel auf eine Referenz. Alles andere (Aufruf,
Berechnung, Destructuring) darf nichts eintragen.

### 5. Sprachserver: Hover liest den Ausdruck

`onHover` sucht heute über `getSymbolDefinition` das Symbol und zeigt `symbol.typeInfo`
([server.ts:1087](../../jul-language-server/src/server.ts#L1087)). Weil
`findExpressionInParsedFile` die `symbols` der Branch-Funktion in die Scopes legt, trifft es dabei
das verengte Schatten-Symbol. Fällt die Überschattung weg, zeigt Hover im Branch wieder den weiten
Typ.

Hover muss deshalb die `typeInfo` des **Ausdrucks** bevorzugen und nur für die Beschreibung auf das
Symbol zurückgreifen. Das ist ohnehin richtiger: Der Ausdruckstyp gilt an dieser Position, der
Symboltyp für alle Vorkommen.

Der Sprachserver liegt in einem eigenen Projekt und hängt an den **gebauten** Compiler-Artefakten —
vor dem Prüfen also `npm run build-all`.

### 6. Nachher-Messung

`npm run bench -- --save --note "nach Verengung ueber Pfade"`. Ein Nachschlag je Referenz und je
Feldzugriff liegt im heißen Pfad; erwartet wird eine Verschiebung bei `inferType`, nicht bei
`getTypeError`. Bei einem Sprung erst die Ursache finden, dann weiterbauen.

### 7. Verifikation

Wie in [CHECKER-AUDIT.md](CHECKER-AUDIT.md#verifikation-nach-jedem-schritt): Checker-Tests,
`typecheck`, `npm test`, `build`, Beispiele bauen. Zusätzlich der Durchlauf gegen das große
Fremdprojekt — dort muss die verbliebene Meldung verschwinden, ohne dass eine neue entsteht.

## Risiken

- **Zu weite Verengung.** Vier Gegenproben stehen; die schärfste ist `…-needs-a-name-as-source`.
- **Verengung überlebt den Rumpf.** Heute verhindert das die Scope-Suche von innen nach außen. Mit
  einer eigenen Umgebung muss das die Weitergabe leisten: Der Fakt darf nur in die Prüfung des
  Rumpfs, nicht in die des branchings. `…-ends-with-the-branch` fängt es ab.
- **Sprachserver.** Geprüft: Hover hängt an der Überschattung, siehe Schritt 5. Completion und
  Go-to-Definition lesen ebenfalls Symbole — dort ist der Schatten unkritisch, weil er alle
  Positionsangaben des äußeren Symbols übernimmt.
- **Laufzeit.** Siehe Schritt 6.
