# Imports sortieren

Idee ohne Entscheidung. In `jul-compiler/TODO` steht sie als „formatierer der imports sortiert“.

## Ausgangslage

Das Einfügen neuer Imports (`auto-import.ts` im Language Server) sortiert schon: Neue Importe
kommen alphabetisch nach Pfad zwischen die bestehenden (`findInsertRow`), neue Felder in ein
Destructuring alphabetisch nach Name (`createFieldEdit`), beides über `compareText`. Bestehende
Imports sortiert nichts nach. In yugioh stehen sie teils ungeordnet, z. B. in `game-logic.jul`:
`./game-types.jul`, `./card-effects.jul`, `../util.ts`, `./card-data.json`.

Unsortierte Imports sind kein Fehler, der Diagnosen-Formatter aus `formatter.md` passt daher nicht.

## Idee

Eine LSP-Code-Action `source.organizeImports` (`CodeActionKind.SourceOrganizeImports`). VS Code
kann sie über `editor.codeActionsOnSave` beim Speichern ausführen. Der Server hat
`codeActionProvider` mit QuickFix schon, die Kind-Liste käme um einen Eintrag dazu.

Die Logik liegt in einem eigenen Modul (z. B. `organize-imports.ts`) neben `auto-import.ts`, mit
eigenen Unit-Tests über `createInMemoryHost`. Es teilt sich mit `auto-import.ts` `compareText` und
`findTopLevelImports`, damit Einfügen und Sortieren dieselbe Reihenfolge benutzen.

### Ablauf

1. **Import-Läufe finden:** aufeinanderfolgende Top-Level-Definitionen und Destructurings, deren
   Wert ein `import(…)`-Aufruf ist, ohne Nicht-Import dazwischen. Eine Leerzeile beendet den Lauf,
   damit die Gruppierung erhalten bleibt (z. B. Code-Imports oben, Daten-Imports darunter).
2. **Einheiten bilden:** ein Import samt aller Kommentarzeilen direkt darüber (Beschreibung,
   `#TODO`, Ignore-Kommentare), bei einem mehrzeiligen Destructuring über alle Zeilen. Der Text
   kommt aus dem Quelltext, nicht aus dem AST.
3. **Sortieren** nach dem Pfad, wie er geschrieben steht (`path` aus `getPathFromImport`), mit
   `compareText`. `../` kommt dadurch vor `./`, weil `.` kleiner ist als `/`.
4. **Felder sortieren:** die Namen im Destructuring alphabetisch, einzeilig `(b a)` → `(a b)`,
   mehrzeilig zeilenweise samt Kommentar über dem Feld.
5. **Ein Text-Edit pro Lauf**, der den ganzen Bereich ersetzt. Ein zweiter Lauf ändert nichts.

Das Verschieben ist sicher, weil innerhalb eines Laufs nichts zwischen den Imports steht: Eine
Verwendung kann nicht über oder unter einen Import rutschen, `usedBeforeDefined` greift nicht neu.
Es braucht nur den Parse-Baum und funktioniert deshalb auch bei Check-Fehlern.

## Testfälle

Schon sortiert (keine Änderung), zwei vertauschte Imports, mehrzeiliges Destructuring, Kommentar
wandert mit, Leerzeile trennt Gruppen, Felder sortiert, gemischte Endungen (`.jul`, `.json`,
`.ts`), `../` vor `./`, Import am Dateiende ohne Zeilenumbruch.

## Offen

- **Sortierschlüssel:** reiner Zeichenvergleich wie in `auto-import` (Großbuchstaben vor
  Kleinbuchstaben, `Deck` vor `getOptionsHtml`) oder Pfad ohne Beachtung der Groß-/Kleinschreibung.
  Beim bestehenden `compareText` zu bleiben hält Einfügen und Sortieren deckungsgleich.
- **Gruppen:** Leerzeile trennt Gruppen, oder alle Imports einer Datei bilden einen Block.
- **Auslöser:** nur die Code-Action `source.organizeImports`, oder zusätzlich im „Dokument
  formatieren“ aus `formatter.md`.
