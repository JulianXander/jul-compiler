# Profil: yugioh Lookahead-KI (Phase 1 aus js-performance-plan.md)

Befund, keine Entscheidung. Gemessen am 18.10.2026, Node 24.19, yugioh bei `7a11d4e`.

## Last

`node out-bench/bundle.js 1` im yugioh-Repo (gebaut mit `jul --config bench.jul-config.yaml`): Lookahead-KI
gegen Greedy, ein Paar. Baseline über vier Läufe: Match 7,8 bis 8,8 s, Entscheidung Tiefe 1 etwa 20 ms,
Tiefe 2 etwa 170 bis 210 ms, Tiefe 3 etwa 550 bis 650 ms. Die Streuung zwischen Läufen liegt bei etwa 10 %.

## Ergebnisse

**Zeit nach Bundle-Region** (`--cpu-prof`, Self-Time, 9,4 s):

| Anteil | Region |
|---|---|
| 54,5 % | `game-logic.js` |
| 23,1 % | `runtime.js` (Builtins wie `map`, `filter`, `getField`, `_branch`) |
| 8,0 % | `legal-inputs.js` |
| 4,6 % | `lookahead-ai.js` |
| 4,2 % | GC |
| 3,1 % | `evaluation.js` |

Das Profil ist flach: Die größte einzelne Funktion hat 4,6 %. Es gibt keinen einzelnen Flaschenhals.

**BigInt ist hier kein Faktor.** Im V8-Tick-Profil (`--prof`) tauchen BigInt-Builtins mit zusammen unter
1 % auf (`ToNumberConvertBigInt`, `ToBigIntConvertNumber`). Das Spiel rechnet kaum, es verschiebt Karten
und Zustände. Die Hypothese, dass `number` statt `bigint` viel brächte, ist für diese Last widerlegt.
Ein Punkt B im Plan (Integer als `number`) ist damit zurückgestellt.

**Zeit steckt in Objekt- und Array-Operationen:**

- `CreateDataProperty` 9 % und `CloneObjectIC_Slow` 2 %: Objekt-Spread beim Zustandsupdate. Größter
  einzelner Aufrufer ist `declineOptionalEventTriggers`.
- `LoadIC_Megamorphic` und `LoadICTrampoline_Megamorphic` zusammen 9 %: Feldzugriffe `x?.['feld']` auf
  Objekten mit wechselnder Form, etwa in `applyContinuousEffectsForPlayer`.
- `GrowFastSmiOrObjectElements` 3 %, `ArrayPrototypeFlatMap` und `FlattenIntoArray`: wachsende Arrays,
  `flatMap`, `concat`.

**Aufrufzähler** (instrumentiertes Bundle, ein Match):

| Funktion | Aufrufe |
|---|---|
| `_createFunction` | 79,6 Mio. |
| `tryAssignArgs` | 2,6 Mio. |
| `_combineObject` | 2,7 Mio. |
| `_branch` | 1,8 Mio. |

`_createFunction` wird bei jeder Closure-Erzeugung aufgerufen, auch bei Callbacks in `map`/`filter`. Jede
Erzeugung legt ein frisches `params`-Literal an und setzt `fn.params`. Mikro-Messung (Closure entkommt):
etwa 8 ns mehr je Erzeugung gegenüber einer Closure ohne `params`, mit hochgezogenem (konstantem) `params`
etwa 2 ns. Das sind grob 0,6 s von etwa 8 s (rund 8 %) mit Literal, rund 3 % mit hochgezogenem Literal.
Obergrenze, weil GC-Druck hineinspielt und die Rechnung nicht am echten Lauf bestätigt ist.

`_branch` mit `tryAssignArgs` (1,8 Mio.) kommt trotz des Dispatchs für typisierte Köpfe noch vor, und ruft
den vollständigen Typcheck.

**Runtime-HOFs bilden bei jedem Element `BigInt(index + 1)`**, auch wenn der Callback keinen Index nimmt
(`map`, `filter`, `some`, `reduce`). Das ging im Tick-Profil nicht als eigener Posten auf, ist aber
vermeidbar.

## Folgerungen für Phase 2

Reihenfolge nach Erwartung, jeweils einzeln zu messen:

1. **`params` hochziehen oder entfallen lassen** (Teil von D): konstante Parameterlisten einmal pro
   Funktionsliteral anlegen statt je Erzeugung. Für Callbacks, die nie über `_callFunction`/`_branch`
   laufen, entfällt `params` ganz, falls der Emitter das belegen kann. Erwartung: 3 bis 8 %.
2. **Objekt-Updates** (C): Spread-Kopien in den Zustandsupdates reduzieren, wo das Profil sie zeigt
   (`declineOptionalEventTriggers` zuerst). Erwartung: bis etwa 10 %, abhängig vom Aufrufer.
3. **Megamorphe Zugriffe**: prüfen, ob Zustandsobjekte mit gleicher Feldreihenfolge und vollständigen
   Feldern entstehen (stabile Hidden Classes). Ob das der Emitter steuern kann, ist offen.
4. **Index nur bilden, wenn der Callback ihn nimmt** (`fn.length`), in `map`, `filter`, `some`, `reduce`.
5. **A (Branching/benannte Argumente)**: `_branch` taucht noch 1,8 Mio. Mal auf, sinnvoll nur, wenn die
   Fälle im Profil hoch stehen, was sie nicht tun.
6. **E (Worker)**: unverändert der größte Hebel für die Paare-Läufe, unabhängig vom Compiler.

Erwarteter Gesamtgewinn von 1 bis 4: im niedrigen zweistelligen Prozentbereich. Das passt zu dem, was die
früheren Optimierungen in `ai-measurements.tsv` brachten (einzelne Prozent je Schritt). Ein Wasm-Backend
ist für diese Last nicht indiziert: Der Zeitanteil steckt in Objektallokation und Objektzugriffen, nicht
in Zahlen.

## Grenzen der Messung

- Ein Match mit festem Deck. Andere Decks und Tiefen verschieben die Anteile.
- Inlining verschiebt Self-Time vom Aufgerufenen zum Aufrufer, die Regionsanteile sind daher grob.
- `--cpu-prof` zeigt Builtins nicht einzeln, deshalb zusätzlich `--prof`. Bei diesem hat die Probe nur
  679 Ticks, die Prozentwerte sind auf wenige Punkte genau.
- Die 8 %-Schätzung für `params` stammt aus einer Mikro-Messung, nicht aus einem Lauf mit geändertem
  Compiler.
