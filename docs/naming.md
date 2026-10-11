# Namenskonventionen

Internes Arbeitsdokument, keine Doku. Es legt fest, wie Builtins in `src/runtime/core-lib.jul`
heißen. Die Regeln folgen aus den [Designprinzipien](design-principles.md), vor allem
**Einheitlichkeit** (eine Sache, ein Name) und **Klarheit** (der Name sagt, was die Funktion tut),
und gelten für neue Builtins ohne erneute Diskussion.

## Schreibweise

- **PascalCase** für Typen und Typfunktionen (`Integer`, `NonZeroInteger`, `TypeOf`, `LengthOf`),
  **camelCase** für Werte und Funktionen (`getElement`, `parseJson`). Die Ausnahmen sind
  `true` und `false`.
- Parameter folgen derselben Regel wie die Definition, zu der sie gehören: Eine Typfunktion hat
  PascalCase-Parameter (`Source`, `Index`), eine Wertfunktion camelCase-Parameter (`values`, `index`).
- **Finnish Notation** für Streams: Ein Name endet auf `$`, wenn sein Wert ein Stream ist, also
  Variablen und Parameter vom Typ `Stream` (`stream$`, `source$`, `until$`) und Funktionen, die
  einen Stream liefern (`create$`, `interval$`, `map$`, `httpTextRequest$`). Maßgeblich ist der
  Rückgabewert: `push`, `complete` und `subscribe` nehmen einen Stream an, liefern aber keinen und
  tragen kein `$`. Die Typen `Stream` und `FiniteStream` bleiben ohne `$`. Die Stream-Variante
  einer Listenfunktion heißt wie diese mit `$` (`map` → `map$`).
- Kommentare in der core-lib sind deutsch, Bezeichner englisch.

## Typfunktion zu Wertfunktion

Berechnet eine Wertfunktion ihren Rückgabetyp aus den Argumenttypen, gibt es dafür eine
Typfunktion, die in PascalCase heißt und den Stamm der Wertfunktion trägt: `add` → `Add`,
`length` → `LengthOf`. Die Wertfunktion verwendet sie im Rückgabetyp. Beide Namen stehen für
dieselbe Operation, die eine auf Werten, die andere auf Typen.

## Präfixe

| Präfix | Bedeutung | Beispiele |
|---|---|---|
| `get` / `set` / `remove` | Zugriff auf Element oder Feld, `set` und `remove` ohne Mutation | `getElement`, `setField`, `removeField` |
| `find` | Suche mit Prädikat, liefert Wert, Index oder Key | `findFirst`, `findLastIndex`, `findField`, `findKey` |
| `parse` | Text zu Wert, Fehlerfall ist `Error` im Rückgabetyp | `parseFloat`, `parseJson` |
| `to` | Umwandlung in eine andere Darstellung | `toList`, `toDictionary`, `toJson` |

## Neue Namen finden

- **Ausgeschrieben, keine Abkürzungen.** Ein Name wird gelesen, bevor er geschrieben wird, und
  eine Abkürzung muss der Leser auflösen. Erlaubt sind nur allgemein bekannte Abkürzungen, die
  ausgeschrieben länger oder weniger verständlich wären (`JSON`, `URL`, `HTTP`, `regex`). Im
  Zweifel ausschreiben.
- **Der bessere Name schlägt die Konvention anderer Sprachen.** Ein Name wird danach gewählt, was
  die Funktion tut und wie sie sich zu den übrigen Builtins verhält, nicht danach, wie sie in
  JavaScript, Haskell oder Rust heißt. Übernommen wird ein fremder Name, wenn er der beste ist
  (`map`, `filter`), nicht weil er fremd bekannt ist. Der Preis: Umsteiger müssen einzelne Namen
  neu lernen.
- **Ein Wort pro Begriff.** Hat das Wort für eine Sache schon einen Namen in der core-lib, wird er
  wiederverwendet, kein Synonym. Gegenstücke heißen symmetrisch (`get`/`set`, nicht `get`/`put`).

## Begriffe der Container

List hat **Elemente** mit einem **Index**, Dictionary hat **Felder** mit einem **Key**. Der Name
einer Funktion nennt den Begriff des Containers, auf dem sie arbeitet (`getElement`, `getField`).
Funktionen, die für beide gelten, nennen den gemeinsamen Begriff nur, wenn es einen gibt.
