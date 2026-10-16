# Tail Calls beim constant folding

Idee, keine Entscheidung.

## Kontext

Der Emitter schreibt einen Selbstaufruf in Tail-Position als `while (true)`-Schleife (siehe
`analyzeTailCalls` in [emitter.ts](../../src/compiler/emitter.ts)), JS führt keine Tail Calls selbst
aus. Das gilt nur für die Emission einer ganzen Datei. Das constant folding im Checker emittiert
Nutzerfunktionen über `functionLiteralToEvaluableJs` ohne Typinformation und ohne diese Umformung:
Jeder rekursive Schritt läuft über den budgetierten `_createFunction`-Wrapper und verbraucht einen
Stack-Frame und einen Aufruf des Budgets (`initialFoldBudget`, global pro Check-Lauf).

## Idee

Auch die gefaltete Funktion als Schleife emittieren, mit einem Zähler je Durchlauf, der dasselbe
globale Budget herunterzählt und bei Erschöpfung `FoldBudgetExhaustedError` wirft. Die Notbremse
gegen nicht terminierende Rekursion bleibt, der Aufruf-Overhead und die Stacktiefe als Grenze
entfallen. Das Budget ließe sich dann vermutlich großzügiger setzen, gemessen mit `npm run bench` im
Language Server.

## Voraussetzungen

- **Typinformation:** `getBranchDispatch` braucht sie am Baum. Beim Falten emittiert der Emitter
  ohne sie, der Rumpf besteht dann aus `_branch(...)` mit Funktionsliteralen, und die Analyse
  lehnt ihn wegen der Closures ab. Entweder wird die Typinformation beim Falten genutzt (die
  gefaltete Funktion ist beim Aufruf bereits geprüft, das wäre zu belegen), oder die Analyse
  versteht Tail Calls auch durch `_branch`.
- **Zähler im emittierten Code:** Die Sandbox bekommt bisher nur den Wrapper hereingereicht, es
  braucht eine zweite Bindung, die das Budget herunterzählt.
- **Selbstreferenz:** Beim Falten läuft sie über die `let`-Bindung durch den Wrapper
  (`functionLiteralToEvaluableJs`). Die Schleife umgeht den Wrapper, die Zuordnung der Selbstreferenz
  muss dazu passen.

## Grenzen

Nicht endrekursive Funktionen (die naive Fibonacci-Form) bleiben über das Budget je Aufruf begrenzt.
Das Budget zählt weiter global, eine Schleife erschöpft es also auch für spätere Aufrufstellen.
