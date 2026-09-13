# Rekursive Typen und der Alias-Knoten

Ein Typalias ist heute kein Knoten im Typbaum, sondern nur ein Name (`aliasName`) am Zieltyp.
Daraus folgen drei Lücken, die dieselbe Ursache haben. Dieses Dokument hält die Entscheidungen
und die Schrittfolge fest.

## Ausgangslage

Drei rote Tests in `src/checker/checker.test.ts` beschreiben den Zielzustand:

| Test | heute | soll |
| --- | --- | --- |
| `type-alias-name-survives-flattening-into-an-outer-union` | `Or(Empty 1 2 3)` | `Or(Empty ZoneIndex)` |
| `recursive-type-alias-keeps-the-self-reference` | `List(Any)` | `List(Tree)` |
| `unproductive-type-cycle-is-reported` | kein Fehler | ein Fehler |

Gemessenes Ist-Verhalten bei Zyklen:

| Code | heute |
| --- | --- |
| `Bad = Or(Integer Bad)` | kein Fehler, Typ ist `TypeOf(Any)` |
| `Bad2 = Bad2` | kein Fehler, Typ ist `Any` |
| `A = Or(Integer B)` / `B = Or(Text A)` | `JUL4002 'B' is used before it is defined.` |

Der dritte Fall zeigt: gegenseitige Rekursion scheitert nicht am Zyklus, sondern am generellen
Verbot von Vorwärtsreferenzen. Bei gegenseitiger Rekursion zeigt zwangsläufig eine Referenz
vorwärts.

## Warum ein Knoten und nicht ein Merkfeld

Die naheliegende Alternative wäre TypeScripts `origin`: die Union bleibt flach und normalisiert,
daneben liegt die geschriebene Form nur für die Ausgabe. Das löst die Anzeige und **nichts
sonst**. Rekursion löst TypeScript getrennt davon über verzögerte Auflösung — `type Json = string
| Json[]` ist erlaubt, `type Bad = string | Bad` meldet „circularly references itself".

Da rekursive Typen gewollt sind, braucht es ohnehin einen aufschiebbaren Knoten. Der trägt den
Namen dann mit, und `origin` wäre Arbeit, die später zurückgebaut wird. Derselbe Knoten ist
zusätzlich Vorarbeit für die bereits im TODO notierten bedingten Typen (`:?`), die dieselbe
Aufschub-Maschinerie brauchen.

Aufschiebbare Knoten sind in JUL kein Fremdkörper: `parameterReference`, `nestedReference`,
`lengthOf`, `concat`, `withElementAt` folgen alle diesem Muster.

## Entscheidungen

**E1 — Nur Selbstreferenz.** Gegenseitige Rekursion bleibt durch `JUL4002` gesperrt und wird ein
eigener TODO-Punkt; sie verlangt Reihenfolgeunabhängigkeit in der Namensauflösung und damit eine
zweite Baustelle.

**E2 — Der Knoten bleibt dauerhaft stehen.** Jede Typdefinition hinterlässt ihn, nicht nur die
zyklischen. Ein Mechanismus deckt damit Rekursion und Anzeige ab. Preis: die Vergleichsfunktionen
müssen ihn transparent behandeln.

**E3 — Transparent bei der Prüfung, richtungsgebunden bei der Anzeige.** `GameCardId =
PositiveInteger` heißt: beide sind wechselseitig zuweisbar, `GameCardId` nimmt jeden Integer, der
die Anforderungen erfüllt, und wo `PositiveInteger` erwartet wird, ist `GameCardId` zulässig.
Nur die *Anzeige* ist richtungsgebunden — der Name gilt an der Schreibstelle, an der er steht.
`PositiveInteger` wird dadurch nirgends zu `GameCardId`.

Kein nominales Verhalten, kein Identitätsfeld auf Vorrat: weder TODO noch Design-Dokumente
nennen nominale Typen als Ziel.

**E4 — Neuer Fehlercode.** `circularTypeDefinition = 5170`, `type: 'type'`, `severity: 'error'`.
Text: `Circular type definition 'Bad'. A type can only refer to itself through a field, list,
tuple, stream or function.` Dazu ein Abschnitt in `jul-homepage/docs/.../error-codes.md`.

**E5 — Compile-Zeit zuerst.** `runtime.ts` bleibt unangetastet; rekursive Typen zur Laufzeit
prüfen wird ein eigener TODO-Punkt.

## Die Regel: Produktivität

Erlaubt ist Rekursion, die durch mindestens einen datentragenden Konstruktor läuft. Nur dann hat
die Typgleichung eine eindeutige Lösung, und nur dann wird beim Prüfen eines Werts etwas kleiner.

| produktiv | nicht produktiv |
| --- | --- |
| `dictionaryLiteral` (Feldtypen), `dictionary` (ElementType), `list`, `tuple`, `stream`, `function` | `or`, `and`, `not`, `typeOf`, `greater` |

Die aufgeschobenen Typfunktionen (`concat`, `tupleOf`, `withElementAt`, `lengthOf`,
`nestedReference`) werden zunächst konservativ als nicht produktiv behandelt.

`Tree` → Dictionary-Feld → `Or` → `List`-Element → `Tree` hat zwei produktive Schritte und ist
zulässig. `Bad` → `Or`-Choice → `Bad` hat keinen und ist es nicht.

## Die eigentliche Invariantenänderung

Ein rekursiver Typ ist ein **Graph mit Zyklus, kein Baum**. Sämtliche Traversierungen im Checker
sind heute als Baum-Traversierungen geschrieben und terminieren nur deshalb. Es gibt derzeit
**keinerlei** Zyklusschutz: keine Besuchsmengen, keine Tiefenlimits. Der `depth`-Parameter in
`typeToString` ist der Schalter für die Alias-Anzeige, kein Limit.

Der Fehlermodus verschlechtert sich dabei: heute ist die Lücke still falsch (`Any`), ohne Schutz
wäre sie ein eingefrorener Language Server beim Tippen. Der Schutz gehört deshalb in dieselbe
Änderung.

Drei Ebenen, alle drei nötig:

1. **Der Knoten bricht den Zyklus.** Wer nicht expandiert, terminiert. Regel: *jede Traversierung
   stoppt am Alias-Knoten, es sei denn sie expandiert bewusst.*
2. **Besuchsmenge für die Relationen.** `getTypeError` und `typeEquals` müssen expandieren. Liegt
   das Paar `(S, T)` schon auf dem Stack, gilt es als zuweisbar und die Prüfung läuft weiter
   (TypeScripts „maybe stack"). Ohne diese Annahme ist strukturelle Gleichheit rekursiver Typen
   nicht entscheidbar.
3. **Tiefenlimit als Notbremse**, mit Fehler statt stillem `Any`. TypeScript hat es trotz (1) und
   (2).

## Der Knoten

```
alias: { julType: 'alias', name: string, symbol: SymbolDefinition }
```

Er hält eine **Symbolreferenz, keinen Typ** — genau das bricht den Zyklus, weil das Ziel erst
beim Zugriff gelesen wird (`symbol.typeInfo.type`). Zum Zeitpunkt, an dem `Tree` in seiner
eigenen Definition auftaucht, hat das Symbol noch keine `typeInfo`; wenn jemand später fragt,
hat es sie.

`isUnresolvedPlaceholder` ist **false**. Ein Alias ist immer auflösbar, nur nicht sofort — anders
als `parameterReference`, der auf einen Aufrufort wartet, der nie kommen muss. Ein Knoten, der an
jeder Typdefinition entsteht und sich als unaufgelöst meldet, würde jeden Konsumenten verteuern;
dieser Effekt ist in diesem Projekt gemessen und dokumentiert.

**Risiko Stale-Symbol:** Der Language Server hält `parsedDocuments` über Änderungen hinweg. Ein
Knoten mit direkter Symbolreferenz kann auf ein Symbol aus einem alten Parse-Durchlauf zeigen.
Alternative wäre `name` + `filePath` mit Auflösung über die Symboltabelle — robuster, umständlicher.
Zunächst die direkte Referenz, das Risiko wird in Schritt 9 gegen die Beispiele geprüft.

## Stellen-Inventar

In `checker.ts` gibt es **37** `switch (x.julType)`. Nur **vier** erzwingen per `assertNever`,
dass eine neue Variante behandelt wird:

| Zeile | Funktion |
| --- | --- |
| 1182 | `traversePlaceholders` |
| 3919 | `typeEquals` |
| 4728 | `getTypeError` (targetType) |
| 5331 | `typeToString` |

Die übrigen **33 fallen still auf `default`**. Der Compiler hilft dort nicht — sie müssen
einzeln durchgesehen werden. Das ist derselbe Fehler wie beim `lengthOf`-Umbau, wo ein fehlendes
`case` in `resolvePlaceholders` auf `default: return rawType` zurückfiel und nur die umgebende
Referenz auflöste.

Zusätzlich aus der Erfahrung mit `lengthOf` explizit zu prüfen: `resolvePlaceholders`,
`getTypeError`, `dereferenceNestedKeyFromObject`, `dereferenceArgumentTypesNested`, `valueOf`,
`isUnresolvedPlaceholderType`.

## Schrittfolge

Jede Messung ist ein eigener nummerierter Schritt. „Vor und nach X" als ein Schritt zu notieren
hat schon einmal dazu geführt, dass der Vorher-Wert beim Abarbeiten nicht mehr messbar war.

1. **Bench-Vorherwert.** `npm run bench -- --save --note "vor: alias-knoten"`.
2. **Produktivitätsprüfung und Fehlercode.** `circularTypeDefinition` in `compiler-errors.ts`
   (Enum + `errorInfos`), Erkennung unproduktiver Selbstreferenzen, Doku-Abschnitt.
   Macht `unproductive-type-cycle-is-reported` grün — **vor** dem Knoten, weil diese Prüfung den
   Schutz gegen Endlosrekursion liefert.
3. **Den Knoten einführen.** Variante in `syntax-tree.ts`, Konstruktor, `isUnresolvedPlaceholder`
   auf false. Die vier `assertNever`-Stellen melden sich vom Compiler.
4. **Die 33 stillen `switch`-Stellen durchgehen**, Liste abhaken, je Stelle entscheiden: stoppen
   oder expandieren. Kein Schritt weiter, bevor die Liste vollständig ist.
5. **Dealias in den Vergleichsfunktionen.** `typeEquals` und `getTypeError` expandieren, mit
   Besuchsmenge nach dem „maybe stack"-Muster. `createNormalizedUnionType` dedupliziert weiterhin
   über die aufgelöste Form; bei zwei strukturgleichen Aliasen gewinnt der frühere Index,
   konsistent mit `removeSubtypes`.
6. **Tiefenlimit** als Notbremse mit eigener Diagnose.
7. **Die Referenz auf ein noch unfertiges Symbol** erzeugt den Knoten statt `Any`. Macht
   `recursive-type-alias-keeps-the-self-reference` grün.
8. **Anzeige.** `typeToString` `case 'alias'` gibt den Namen; ab `depth 0` expandiert es einmal.
   Macht `type-alias-name-survives-flattening-into-an-outer-union` grün. `aliasName` und
   `withTypeAliasName` entfallen, sofern der Knoten sie vollständig ersetzt.
9. **Beispiele und Language Server.** `jul-examples` neu bauen, Server gegen ein großes Projekt
   laufen lassen, Stale-Symbol-Risiko prüfen.
10. **Snapshot-Baseline** neu schreiben und Zeile für Zeile durchsehen. Viele Änderungen sind
    erwartet (Aliase erscheinen künftig namentlich) — das ist der erwünschte Effekt, aber jede
    Zeile muss als Verbesserung erkennbar sein.
11. **Bench-Nachherwert.** `npm run bench -- --save --note "nach: alias-knoten"`.

## Fallen

- **Konstruktionsfunktion, nicht Konstruktor.** Wer eine zusammengesetzte Variante nach dem
  Auflösen ihrer Quelle neu aufbaut, muss die Konstruktionsfunktion erneut aufrufen
  (`getLengthFromType(src)`), nie den Konstruktor. Sonst gehen dort kodierte Fallunterscheidungen
  verloren.
- **Permissive Fallbacks nicht verschärfen, ohne die volle Suite zu fahren.** Die core-lib nutzt
  generische Muster, die ein handgeschriebener Minimaltest übersieht.
- **`valueOf(undefined)` liefert `builtinAny`, nie `undefined`.**
- **Die Stats-Baseline** (`checker-stats.baseline.txt`) ist das deterministische Gate. Ändert sie
  sich stark, ohne dass die Laufzeit es tut, ist das ein Frühwarnsignal.

## Verifikation

- Alle drei roten Tests grün, volle Suite grün, `npm run typecheck` sauber.
- Snapshot-Baseline Zeile für Zeile geprüft.
- Bench vorher/nachher protokolliert, Zählerstände verglichen.
- `jul-examples` gebaut, Language Server manuell gegen ein großes Projekt geprüft.
