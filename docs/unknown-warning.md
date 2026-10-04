# Warnung bei unknown (Versuch)

Ein Versuch, um zu sehen, wie laut die Warnung wird. Der Plan in
[three-valued-assignability.md](three-valued-assignability.md) (Abschnitt „Anschluss: Warnung bei
unknown") beschreibt das Ziel, hier steht die einfache Form davon, die sich wieder abschalten lässt.

## Verhalten

Liefert `isTypeAssignable` an einer meldenden Stelle unknown, meldet der Checker eine Warnung:
„Was zur Laufzeit schiefgehen kann, wird gemeldet." Meldende Stellen sind die drei, die heute bei
no einen Fehler melden:

| Stelle | Fehler bei no | Warnung bei unknown |
|---|---|---|
| Definition mit Typ | `definitionTypeMismatch` (5000) | `typeNotProven` (5010) |
| Argument | `argumentTypeMismatch` (5050) | `typeNotProven` (5010) |
| Rückgabewert | `returnTypeMismatch` (5100) | `typeNotProven` (5010) |

Die Meldung nennt Stelle, Quelle und Ziel, mehr nicht:

```
Argument type can not be verified.
Can not prove that [Any] is assignable to ( t: Text ).
```

Einen Grund wie „Any an Integer" oder „hängt am Parameter values" trägt sie nicht. Dafür wäre der
Pflichtfeld-Umbau von `isTypeAssignable` nötig (siehe den Plan). Er lohnt sich erst, wenn der
Versuch bleibt.

Die Warnung folgt dem Prinzip Freiheit: Sie ändert nichts am Ergebnis der Prüfung, ein unknown
bleibt zulässig. Einzelne Stellen lassen sich mit einem Ignore-Kommentar ausnehmen wie jede andere
Warnung.

## Ausnahmen

- **`.ts`- und `.js`-Dateien.** Der Rumpf ist ein Artefakt des Parsers, die Rückgabe ist dort immer
  `Any`. Die Prüfung würde bei jeder TS-Funktion warnen, ganz gleich, was sie tut.
- **`core-lib.jul`.** Sie gehört zum Compiler und wird nicht angezeigt.

## Schalter

`jul-config.yaml`:

```yaml
warnUnknown: false   # Standard: true
```

- Standard ist **an**. Wer zu laute Warnungen hat, schaltet sie ab.
- Der Checker selbst kennt den Schalter als `CheckOptions.warnUnknown`, eine Funktion vom
  Dateipfad auf bool. Fehlt sie, ist die Warnung aus. So bleiben Tests und die Baselines unberührt,
  und jeder Aufrufer entscheidet für sich. Eine Funktion statt eines Werts, weil der Language Server
  mehrere Projekte mit je eigener Config hält.
- Die CLI liest den Schalter aus der Config, der Language Server sucht je Datei die nächste
  `jul-config.yaml` nach oben. Das Lesen steht in `compiler/config.ts` und ist für beide dasselbe.

## Umsetzung

1. Fehlercode `typeNotProven = 5010`, Schweregrad `warning`.
2. Roter Test je Stelle (Definition, Argument, Rückgabe), dazu die Gegenproben: yes, Schalter aus,
   TS-Datei.
3. `CheckOptions.warnUnknown`, an den drei Stellen melden.
4. `compiler/config.ts`: Config finden und lesen (aus der CLI herausgezogen), Schema um
   `warnUnknown` erweitern, CLI und Language Server verdrahten.
5. Fehlercode-Seite der Homepage, `jul-config.yaml`-Beschreibung.
6. Gegen yugioh, jul-examples und den Snapshot laufen lassen, die Zahl der Warnungen je Fall
   festhalten und mit der Zahl der unknown (95 in yugioh) vergleichen.

## Entscheidung nach dem Versuch

Zu laut: Schalter standardmäßig aus oder die Warnung auf wenige Stellen beschränken. Brauchbar:
Pflichtfeld `warning` mit Grund einführen und die Ursachen der Warnungen einzeln abbauen, wie in
„Vorarbeit: unknown abbauen".

## Stand

Schritte 1 bis 5 sind umgesetzt (`typeNotProven` 5010, `CheckOptions.warnUnknown`,
`compiler/config.ts`, Schema, CLI, Language Server, Fehlercode-Seite). Die Quelle erscheint in der
Meldung ohne Alias, sonst stünde dort nur der Name einer Definition (`newDeckBuilderState`) statt
des Typs mit dem `Any`, um das es geht.

Gemessen mit dem Standard (an):

| Ziel | unknown (Zählung) | Warnungen |
|---|---|---|
| yugioh | 91 (41 Argumente, 27 Definitionen, 23 Rückgaben) | 73 (41 Argumente, 27 Definitionen, 5 Rückgaben) |
| jul-examples | 21 (mit core-lib) | 3, alle in `core-lib/aggregate` |

Argumente und Definitionen stimmen mit der Zählung überein. Der Unterschied sind 18 Rückgaben in
TS-Dateien (`util.ts`, `dom.ts`, `database.ts`), für die es bewusst keine Warnung gibt. Der Bench
läuft ohne Schalter und ist unverändert (1324 ms gegen 1401 ms davor).

In yugioh wiederholen sich unter anderem drei Muster, die sich einzeln abbauen lassen:
Literale mit einem `Any`-Feld (`activeDeck: Any`), Streams mit `Stream(Any)` (`create$`,
`subscribe`) und `assume(… Any)`.
