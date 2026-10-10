# Nomenklatur bei List und Dictionary

Zielbegriffe:

| Container | Wert heißt | Identifier | Typ des Identifiers |
|---|---|---|---|
| List | Element | Index (ab 1) | PositiveInteger |
| Dictionary | Feld | Key | Text |

Die Begriffe sind weder im Handbuch noch in der core-lib erklärt. Dieses Dokument sammelt, wo die
core-lib (`src/runtime/core-lib.jul`) davon abweicht. Alle Punkte außer der Doku sind Breaking
Changes und zunächst zurückgestellt.

## Was schon passt

- List: `getElement`, `setElement`, `lastElement`, Parameter `index: PositiveInteger`.
- Dictionary: `getField`, `setField`, `findField`, Parameter `key: Text`.

## Abweichungen

1. **`ElementType` bei Dictionary.** `Dictionary(ElementType)` und `TypeOf(dictionary)/ElementType`
   benennen den Typ der Felder nach Elementen. Der Parametername ist Teil des Typs und wird per
   `/ElementType` von außen adressiert. Eine Umbenennung (z. B. `FieldType`) bricht jede Verwendung,
   auch in yugioh.
2. **Generische Typfunktionen.** `MapElements`, `ElementAt` und `WithElementAt` gelten auch für
   Dictionaries. Offen: Namen belassen oder einen gemeinsamen Oberbegriff wählen (Entry, Value).
3. **Drei Wörter für den Key.** Kommentar „key-value-pairs" bei Dictionary, „Schlüssel" bei
   `findKey`, im Code `key`.
4. **Sprache der Kommentare.** Teils englisch („Returns the value of the field", „Creates a new
   Dictionary…"), teils deutsch.
5. **„Index" doppelt belegt.** In `ElementAt` ist der Index eine Position oder ein Bereich
   (`Or(Integer Type)`, `IndexRange`), in den Callbacks immer ein `PositiveInteger`.
6. **Keine Erklärung.** Die Definitionen von `List` und `Dictionary` in der core-lib führen die
   Begriffe nicht ein.

## Ohne Breaking Change möglich

- Handbuch: Tabelle unter `## Container` und je ein Absatz bei List und Dictionary.
- core-lib: Kommentare an `List` und `Dictionary` mit den Begriffen, Kommentare vereinheitlichen
  (Punkte 3, 4).
- Language Server: Hover- und Fehlertexte auf dieselben Begriffe prüfen.
