# Empty, optional und JSON-null

Offene Fragen, die nach der Umstellung auf geschlossene Record-Typen übrig sind
([geschlossene-records.md](geschlossene-records.md)). Ein fehlendes Feld und ein Feld mit dem Wert Empty
sind für den Checker heute dasselbe. Ein weiteres Feld außerhalb des Typs ist seit 2026-11-24 immer ein
Fehler (`Unexpected field`), auch mit dem Wert Empty, siehe unten „Laufzeit: Schlüssel mit Empty“.

## JSON-null gegen fehlenden Schlüssel

JSON unterscheidet `{"b": null}` von `{}`. JUL kann das heute nur über die Laufzeit unterscheiden
(Schlüssel mit `undefined` gegen fehlender Schlüssel), der Typ nicht. Erwogen wurden:

- **Eigener Wert `Null`:** JSON-`null` wird `Null`, ein fehlender Schlüssel fehlt. Kosten: Jede
  JSON-Verarbeitung muss `Null` kennen (`Or([] Null X)`), `card-data.json` in yugioh hat 9178 `null`.
  Asymmetrisch (`Null` nur zum Schreiben) wäre billiger, verliert aber die Unterscheidung beim Lesen.
- **Fehlen im Typ ausdrücken** (`b?: X`): `b: Or([] X)` heißt vorhanden mit Wert Empty, `b?: X` darf
  fehlen. Unterscheidet beides in beide Richtungen ohne neuen Wert.

**Vorschlag:** `b?: X`, zusammen mit stabilen Objektformen, ausgearbeitet in
[stabile-objektformen.md](stabile-objektformen.md). Ein Feld ohne `?` muss im Literal stehen und zur
Laufzeit als Schlüssel da sein, ein fehlender Schlüssel passt nur auf `?`.

## Laufzeit: Schlüssel mit Empty

Zur Laufzeit ist Empty `undefined`, `[a = 1 b = []]` hat also einen Schlüssel mehr als `[a = 1]`.
Das betrifft alles, was über Schlüssel läuft: `deepEqual` (vergleicht die Schlüsselanzahl), `toList`
(`Object.values`), `toJson`, `mapDictionary`, `findKey`, die `Dictionary(X)`-Prüfung.

Mit dem Vorschlag oben ist das kein Widerspruch mehr: „fehlt“ und „Empty“ haben verschiedene Typen, die
Laufzeit darf sie unterscheiden.

**Entschieden (2026-11-24):** Ein weiteres Feld mit Empty außerhalb des Typs ist ein Fehler wie jedes
andere weitere Feld (Test `surplus-field-with-empty-is-rejected`). Vorher war es zulässig (geschlossener
Typ: jedes ungenannte Feld ist Empty), zur Laufzeit hatte der Wert aber einen Schlüssel mehr. Anlass war
yugioh Jul-Fund 48: Nach Umbenennen oder Verschieben von Feldern blieben `feld = []` in Literalen still
stehen und änderten `deepEqual`. Folge: Ein Spread kann keine Felder entfernen, ein Wechsel zwischen
Varianten einer Union kopiert die gemeinsamen Felder einzeln (yugioh `getGameUiStateBase`). Der früher
hier verlinkte Entwurf `stabile-objektformen.md` existiert nicht.

## Offene Records

Es gibt keine Schreibweise für einen offenen Record-Typ. `[a: Integer ...Any]` ist ein Fehler (JUL5004)
und damit für später frei. Gebraucht würde sie für Teil-Muster in einem Branch-Kopf
(`[[kind: §circle§ ...Any]] => …`) und für breite Parameter (`(x: [hp: Integer ...Any])`).
Nachrüsten ist rückwärtskompatibel. Denkbare Ausbaustufen: `...Dictionary(T)` für weitere Felder vom
Typ T, Zeilenvariablen, damit ein Spread die Felder des Arguments im Ergebnistyp behält.

## Intersection von Records

`And([a: 4] [b: 5])` ist mit geschlossenen Records `Never`: kein Wert hat `a` und zugleich nur `b`.
Als Komposition von Record-Typen dient der Spread (`[...A ...B]`).
