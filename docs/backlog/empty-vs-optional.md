# Empty, optional und JSON-null

Offene Fragen, die nach der Umstellung auf geschlossene Record-Typen übrig sind
([geschlossene-records.md](geschlossene-records.md)). Ein fehlendes Feld und ein Feld mit dem Wert Empty
sind für den Checker dasselbe, ein weiteres Feld ist zulässig, wenn es Empty sein kann.

## JSON-null gegen fehlenden Schlüssel

JSON unterscheidet `{"b": null}` von `{}`. JUL kann das heute nur über die Laufzeit unterscheiden
(Schlüssel mit `undefined` gegen fehlender Schlüssel), der Typ nicht. Soll das ausdrückbar sein, gibt es:

- **Eigener Wert `Null`:** JSON-`null` wird `Null`, ein fehlender Schlüssel fehlt. `Empty` bleibt der eine
  leere Wert. Kosten: Jede JSON-Verarbeitung muss `Null` kennen (`Or([] Null X)`), dazu YAML und die
  zur Compilezeit übersetzten `.json`/`.yaml`-Dateien.
- **Fehlen im Typ ausdrücken** (`b?: X`): `b: Or([] X)` heißt vorhanden mit Wert Empty, `b?: X` darf
  fehlen. Kosten: eine zweite Art von „nichts“ in jedem Dictionary, Spread mit `b = []` löscht dann nicht.

## Laufzeit: Schlüssel mit Empty

Zur Laufzeit ist Empty `undefined`, `[a = 1 b = []]` hat also einen Schlüssel mehr als `[a = 1]`.
Das betrifft alles, was über Schlüssel läuft: `deepEqual` (vergleicht die Schlüsselanzahl), `toList`
(`Object.values`), `toJson`, `mapDictionary`, `findKey`, die `Dictionary(X)`-Prüfung. Die Typprüfung
`isDictionaryLiteralOfType` ignoriert Schlüssel mit `undefined` schon. Für Konsistenz müssten die
übrigen das auch tun.

## Offene Records

Es gibt keine Schreibweise für einen offenen Record-Typ. `[a: Integer ...Any]` ist ein Fehler (JUL5004)
und damit für später frei. Gebraucht würde sie für Teil-Muster in einem Branch-Kopf
(`[[kind: §circle§ ...Any]] => …`) und für breite Parameter (`(x: [hp: Integer ...Any])`).
Nachrüsten ist rückwärtskompatibel. Denkbare Ausbaustufen: `...Dictionary(T)` für weitere Felder vom
Typ T, Zeilenvariablen, damit ein Spread die Felder des Arguments im Ergebnistyp behält.

## Intersection von Records

`And([a: 4] [b: 5])` ist mit geschlossenen Records `Never`: kein Wert hat `a` und zugleich nur `b`.
Als Komposition von Record-Typen dient der Spread (`[...A ...B]`).
