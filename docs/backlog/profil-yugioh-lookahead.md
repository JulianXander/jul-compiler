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

## Nachmessung am 23.10.2026

yugioh bei `e82990a` (Spiellogik und KI-Suche ohne History, siehe
[inplace-mutationen.md](inplace-mutationen.md)), Node 24.19, Match 7,1 s, dieselbe Last.

**Je Datei** (`--cpu-prof`, Self-Time, 7,4 s; Zeilen über die Source Map aufgelöst, für die vom Emitter
ausgeschriebenen sofort aufgerufenen Funktionen über den nächsten Eintrag davor):

| Anteil | Datei | 18.10. |
|---|---|---|
| 55,4 % | `game-logic.jul` | 54,5 % |
| 15,7 % | `runtime.js` | 23,1 % |
| 14,7 % | `legal-inputs.jul` | 8,0 % |
| 4,6 % | `lookahead-ai.jul` | 4,6 % |
| 3,9 % | `evaluation.jul` | 3,1 % |
| 3,3 % | GC | 4,2 % |

Die größte Einzelfunktion ist `flatten` mit 5,1 % (Aufrufer `evaluateCardQuery`, `getSpellTrapEffectInputs`,
`getEffectInputs`), danach `applyInput` 5,0 %, `getCanActivateActivation` 3,5 %, `getElement` 3,4 %.

**Inklusive Zeit** (eine Funktion zählt einmal je Sample):

| Anteil | Funktion |
|---|---|
| 88,9 % | `getLookaheadInput` (Greedy 0,8 %) |
| 62,4 % | `getChildren` |
| 47,2 % | `applyToGameState` |
| 12,4 % | davon `updatePendingTriggers` |
| 7,3 % | davon `applyAllContinuousEffects` |
| 27,4 % | `getLegalInputs` |
| 10,6 % | davon `getActivationInputs` |
| 7,1 % | davon `getSynchroInputs` |
| 4,4 % | davon `getCanActivateActivation` |
| 4,4 % | `evaluate` |

**Builtins** (`--prof`, zwei Läufe: 542 Ticks im Normallauf, 27 Mio. Ticks mit
`--prof-sampling-interval=100`, der den Lauf auf 700 s streckt; die Anteile beider Läufe liegen innerhalb von
zwei Punkten, genannt ist der zweite): megamorphe Feldzugriffe (`LoadIC_Megamorphic`,
`LoadICTrampoline_Megamorphic`) 12,7 %, Objekt-Spread (`CreateDataProperty`, `CloneObjectIC(_Slow)`,
`DefineNamedOwnIC`) 11,3 %, `StrictEqual` 2,5 %, BigInt-Umwandlung 1,3 %, GC 5,5 %.

**Folgerung.** Das Profil bleibt flach. Fast alles ist Suche, und die Suche teilt sich in Anwenden (knapp die
Hälfte) und legale Inputs erzeugen (gut ein Viertel). Beides skaliert mit der Zahl der Knoten. Die größten
Posten innerhalb davon sind Spiellogik von yugioh, nicht Emission: Trigger und Dauereffekte werden nach jedem
Input vollständig neu berechnet, Aktivierungs- und Synchro-Inputs bei jedem Knoten. Der in-place-Akkumulator
von `aggregate` trifft nur einen Bruchteil der 11 % Spread-Zeit (8,6 % der kopierten Elemente, davon ein Teil
Listenelemente), erwartet etwa 1 %.

**Wiederholte Knoten.** Gezählt in einer gepatchten Kopie des Bundles: 474 Entscheidungen der Lookahead-KI,
296 211 Aufrufe von `getSearchScore`, 784 023 von `applyToGameState`, 372 730 von `getLegalInputs`. Nur 17 % der
Knoten sind innerhalb ihrer Entscheidung ein neues Paar aus State und Tiefe, 83 % werden doppelt berechnet
(gleicher State über verschiedene Reihenfolgen derselben Inputs). `getSearchScore` ist rein, eine Tabelle je
Entscheidung ändert das Ergebnis also nicht.

Prototyp im Bundle (Tabelle je Entscheidung, Schlüssel ist der State ohne die statischen Kartenfelder `effect`
und `cardData`, plus Tiefe):

| Schlüssel | Match | Aufrufe `getSearchScore` |
|---|---|---|
| ohne Tabelle | 7,26 bis 7,49 s | 296 211 |
| `JSON.stringify` je Knoten (72 µs, State im Mittel 40 000 Zeichen) | 9,3 s | 73 662 |
| Schlüssel je Teilobjekt in einer `WeakMap` nach Identität gecacht | 4,94 bis 5,19 s (**−32 %**) | 73 662 |

In allen Läufen dieselben 474 gewählten Inputs (Hash über die Folge). Der gecachte Schlüssel kostet 0,85 s, weil
unveränderte Teile eines States (etwa die Kartenliste) per Referenz geteilt werden und nur einmal serialisiert
werden. Für JUL heißt das: Eine Tabelle braucht veränderlichen Zustand während der Suche oder eine Memoisierung,
die von außen rein ist; beides hat JUL heute nicht, ein Weg in yugioh ist ein TypeScript-Helfer.

Umgesetzt in yugioh als `memoizeSearch` (`src/util.ts`, `@pure`), Schlüssel wie im Prototyp, aber `effect` und
`cardData` nur an Karten (Objekten mit `dataId`) weggelassen. `measure-ai.js` mit einem Paar: 6880 ms auf
5115 ms (−26 %). Gewählte Inputs im ganzen Match gleich wie ohne Tabelle (Hash über die Folge), berechnet werden
50 442 statt 296 211 Knoten. Ein Test vergleicht die Wurzelbewertungen mit und ohne Tabelle an sechs Stellungen;
er fängt grobe Schlüsselfehler, ein einzelnes weggelassenes Feld fiel in den Proben nicht auf, weil es sich in
diesen Stellungen nie allein ändert. Für die Sprache wäre ein `memoize` für reine Funktionen der Ersatz (Fund 50
in yugioh `docs/jul-findings.md`).
