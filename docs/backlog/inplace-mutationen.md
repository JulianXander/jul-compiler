# In-place-Mutation statt Kopie bei Werten ohne weiteren Besitzer

Entwurf, keine Entscheidung. Gehört zu Punkt 1 in [../js-performance-plan.md](../js-performance-plan.md)
(Spread-Kopien in Zustandsupdates, etwa 11 % im yugioh-Profil).

## Idee

`[...x feld = v]`, `x.setField(k v)`, `x.setElement(i v)` und `x.removeField(k)` kopieren `x` immer. Hat
niemand außer dieser Stelle noch Zugriff auf das Objekt, darf der Emitter stattdessen mutieren: Von außen ist
der Unterschied nicht beobachtbar. Bei Records spart das die Kopie aller Felder, bei `setElement` auf Listen
wird aus O(n) je Update O(1), in einer Schleife also aus O(n²) O(n).

Anders als das Ausschreiben des Literals (`{turn, phase: s.phase, ...}`) behält die Mutation Felder, die der
Typ nicht nennt. Das Semantikproblem aus Punkt 1 des Plans entfällt damit.

## Der Haken: letzte Verwendung reicht nicht

Dass eine Variable danach nicht mehr gelesen wird, sagt nichts darüber, ob das Objekt noch anderswo steckt.
In `passPrioOrAdvance` (yugioh) wird `currentGameState = getCurrentGameState(history)` nach dem Spread nie
wieder gelesen, das Objekt liegt aber weiter in `history`. Gebraucht wird Eindeutigkeit: genau eine Referenz
auf das Objekt. JS zählt keine Referenzen, Eindeutigkeit muss also statisch bewiesen werden.

Grobe statische Zählung der 375 Spread-Stellen in yugioh (Heuristik über Zeilen, ungewichtet):

| Quelle des `...x` | Stellen |
|---|---|
| lokal frisch erzeugt (Literal, Spread, `setField`, `setElement`, `map`, `filter`) | 17 |
| Parameter | 132 |
| lokale Variable aus einem Funktionsaufruf | 112 |
| Pfadausdruck (`...a/b`) | 114 |

## Stufe 1: frische Werte innerhalb einer Funktion

Eine Bindung ist **frisch**, wenn ihr Wert ein Literal, ein Spread-Literal oder der Aufruf eines Builtins ist,
das garantiert ein neues Objekt liefert (je Builtin in `runtime.ts` prüfen, ob es die Eingabe unverändert
zurückgeben kann). Sie bleibt **eindeutig**, solange sie vor der Kopierstelle nur gelesen wird (`x/feld`) und
nicht entkommt: nicht in eine andere Struktur geschrieben, nicht an eine Nutzerfunktion übergeben, nicht von
einer Closure eingefangen. Ein Branch von `?` ist eine Funktion, gilt also als Closure, außer der Emitter
schreibt ihn inline aus.

Ist die Kopierstelle die letzte Verwendung einer eindeutigen Bindung, emittiert der Emitter eine Mutation.
Zuerst werden alle neuen Werte berechnet, weil sie `x` lesen dürfen (`turn = add(first/turn 1)`), dann
zugewiesen. Ketten wie `removeField(k).setField(k2 v)` fallen ohne Bindung an: Das Zwischenergebnis ist
immer frisch und eindeutig.

## Stufe 2: über Funktionsgrenzen

- Zusammenfassung je Funktion „liefert frisch“: Gilt sie auf allen Rückgabepfaden, ist `x = f(...)` frisch.
- Parameter „geliehen“ oder „übernommen“, nach dem Vorbild von Koka und Lean (Perceus, „functional but
  in-place“). Ohne Referenzzählung zur Laufzeit braucht das zwei Varianten je Funktion oder statische
  Besitzangaben. Großer Umbau von Checker und Emitter, nur bei klarem Messergebnis.

## Absicherung

Differenztest: dasselbe Programm mit und ohne Optimierung bauen und die Ergebnisse vergleichen (Erweiterung
von `scripts/fuzz.ts`). Dazu gezielte Emitter-Tests für jede Art des Entkommens.

## Messung vor dem Bau

Die statische Zählung sagt nichts darüber, wie oft eine Stelle läuft. Deshalb zuerst zur Laufzeit zählen:

- Mit `JUL_COUNT_COPIES=1` beim Build wickelt der Emitter jede Kopierstelle (Dictionary-Spread, List-Spread,
  erstes Argument von `setField`, `setElement`, `removeField`) in `globalThis._julCountCopy(stelle, wert)`.
  Die Stelle trägt Datei, Zeile, Art und die Kategorie der Quelle (siehe `copy-sites.ts`).
- `node scripts/count-copies.mjs <bundle.js> [argumente]` setzt den Zähler, führt das Bundle aus und gibt die
  Kopien und kopierten Felder bzw. Elemente je Kategorie und die teuersten Stellen aus.

Kategorien: `freshInline` (Quelle ist selbst ein frischer Ausdruck), `freshUnique` (frische lokale Bindung,
vorher nur gelesen, Kandidat für Stufe 1), `freshShared` (frisch, aber entkommt oder wird danach noch
verwendet), `freshCaptured` (frisch, aber in einer anderen Funktion definiert, etwa außerhalb des Branches),
`localCall` (lokale Bindung aus einem Nutzer-Aufruf, Kandidat für Stufe 2), `param`, `path`, `global`,
`other`.

Entscheidungsregel: Liegt der Anteil von `freshInline` und `freshUnique` an den kopierten Feldern unter
etwa 20 %, lohnt Stufe 1 nur für die Listen-Fälle mit O(n²).

### Ergebnis

Gemessen am 23.10.2026, Node 24.19, yugioh bei `83ef7aa`, `node out-bench/bundle.js 1` (Lookahead gegen
Greedy, ein Paar). 13,0 Mio. Kopien, 359 Mio. kopierte Felder bzw. Elemente.

| Kategorie | Kopien | Felder/Elemente | Stellen |
|---|---|---|---|
| `path` | 46,6 % | 70,2 % | 26 |
| `param` | 21,2 % | 13,0 % | 50 |
| `other` | 10,0 % | 8,5 % | 19 |
| `localCall` | 10,9 % | 7,0 % | 32 |
| `freshShared` | 1,3 % | 1,0 % | 1 |
| `freshUnique` | 6,0 % | 0,2 % | 2 |
| `freshInline` | 3,9 % | 0,0 % | 2 |
| `freshCaptured` | 0,1 % | 0,0 % | 4 |

Je Art: List-Spread 69 % der Elemente (16 Stellen), Dictionary-Spread 24 % (93 Stellen, im Mittel 18 Felder),
`setElement` 7 % (28 Stellen).

**Stufe 1 lohnt nicht.** `freshUnique` und `freshInline` zusammen sind 10 % der Kopien, aber nur 0,2 % der
kopierten Felder: kleine Objekte, die ohnehin billig sind. Die teuren Kopien kommen aus Parametern, Pfaden und
Aufrufergebnissen.

**Der größte Einzelposten ist die History, und dort ist in-place falsch.** `game-logic.jul:5509`
(`gameStates = [...oldHistory/gameStates newGameStateWithInput]`) allein macht 62 % aller kopierten Elemente aus:
789 301 Kopien mit im Mittel 282 Einträgen, also O(n²) über die Länge der Partie, dazu 1,8 GB Allokation für
GC. Die Lookahead-KI verzweigt aber von derselben History aus, das alte Array hat also tatsächlich mehrere
Besitzer. Helfen würde eine Datenstruktur mit billigem Anhängen und geteiltem Präfix (persistente Liste),
entweder als Repräsentation von `List` in der Runtime oder in yugioh selbst (History als verkettete Liste,
`getCurrentGameState` liest nur das letzte Element).

Mikro-Messung zur Einordnung (zwei Formen, also optimistisch): 789 301 Listenkopien mit 282 Elementen 190 ms,
4,68 Mio. Record-Spreads mit 18 Feldern 120 ms, ebenso viele Feldzuweisungen 18 ms. Im Profil stehen die
Record-Spreads bei etwa 11 % (gut 600 ms), dort sind die Objekte megamorph.

**Zweitgrößter Fall mit O(n²) ist der Akkumulator von `aggregate`.** `game-logic.jul:1254`
(`accumulator.setElement(gameCardId newCard)`) bringt 3,4 % der Elemente, Kategorie `param`. Der Startwert
wird geteilt, jeder spätere Akkumulator ist aber das frische Ergebnis des vorigen Schritts. Eine gezielte
Variante: den Startwert einmal kopieren, danach in-place, solange der Callback den Akkumulator nur als Quelle
von `setElement`/`setField`/Spread verwendet oder unverändert zurückgibt.

**Obergrenze für die History gemessen.** Im erzeugten Bundle wurde die Kopie in `apply` zusätzlich k-mal
ausgeführt (Ergebnis in eine globale Senke, Semantik unverändert, Spielausgang in allen Läufen gleich), je fünf
abwechselnde Läufe, Median des Matches: k=0 7808 ms, k=2 8596 ms, k=4 9473 ms. Der Zuwachs ist linear, etwa
415 ms je Kopie, also rund **5 % des Matches** für diese eine Stelle. Eher eine Untergrenze der echten Kosten:
Die zusätzlichen Kopien sterben sofort, die echte bleibt in der History und wird älter (teurere GC).

## Persistente Datenstrukturen: Ergänzung, kein Widerspruch

In-place und persistente Strukturen setzen dieselbe Semantik um (Werte sind unveränderlich) und decken
verschiedene Fälle ab:

- **Eindeutiger Wert:** in-place, Kosten null. Persistente Strukturen kopieren hier unnötig einen Pfad.
- **Geteilter Wert** (History, von der der Lookahead verzweigt): in-place ist falsch, eine persistente
  Struktur macht aus O(n) je Update O(1) oder O(log n).

Kombiniert gibt es das als Clojure-Transients und als Wiederverwendung in Koka, Lean und Roc: Ist ein Knoten
der persistenten Struktur eindeutig, wird er in-place geändert statt kopiert. Die Eindeutigkeitsanalyse aus
Stufe 1 und 2 wirkt dann auf Knoten statt auf ganze Objekte.

Spannungen gibt es bei Repräsentation und Kosten, nicht in der Semantik:

- **Records** mit 12 bis 18 Feldern bleiben als JS-Objekte schneller als eine persistente Map. Lesen
  überwiegt das Schreiben bei Weitem, und die Feldzugriffe sind schon jetzt ein Posten im Profil (Punkt 2
  des Plans). Persistent lohnt sich nur für große Listen und Dictionaries.
- **JS-Grenze:** `List` ist heute ein JS-Array. Sichtbar ist das in den `§js§`-Blöcken der core-lib, in
  `nativeFunction`, bei `.ts`-Importen, JSON, `deepEqual`, dem Branch-Test `Array.isArray` und den inline
  ausgeschriebenen Listenschleifen. Eine andere Repräsentation braucht Umwandlung an diesen Grenzen oder einen
  eigenen Typ.
- **Lesen wird teurer:** `getElement` O(log n) statt O(1), Iteration über Knoten statt über ein Array.

Zwei Wege mit kleinerem Radius als ein persistentes `List` überall:

1. **Eigener Typ** (etwa ein persistenter Vektor als Builtin), den Programme wie yugioh gezielt für große,
   geteilte Sammlungen wählen. Kein Eingriff in `List`, die Wahl ist im Typ sichtbar.
2. **Anhängen mit geteiltem Puffer** wie bei Go-Slices: Ein Wert ist (Puffer, Länge). Anhängen schreibt in den
   Puffer, wenn noch niemand hinter dieser Länge angehängt hat, sonst kopiert es. Für Historien, die fast nur
   am Ende wachsen und von denen verzweigt wird, praktisch O(1), Lesen bleibt O(1). Ebenfalls kein reines
   JS-Array mehr, also dieselbe Grenzfrage.

**Umgesetzt in yugioh, ohne Compiler-Änderung (23.10.2026):** Die Spielregeln brauchten die History nur für den
vorigen State (zweiter Pass) und für „hatte Spieler 2 schon einen Zug“. Beides steht jetzt als Feld im State, die
Spiellogik nimmt `GameState`, die KI-Suche wendet Inputs mit `applyToGameState` ohne History an. Nur UI, Replay,
Arena und Tests führen noch eine History, und die wächst einmal je echtem Spielschritt. Ergebnis im Match
(sechs abwechselnde Läufe gegen `83ef7aa`): Median etwa 7716 ms auf 7285 ms, **−5,6 %**, wie von der
Obergrenze vorhergesagt. Kopierte Felder und Elemente: 359 Mio. auf 142,5 Mio. Eine persistente Liste in der
Sprache ist damit für diesen Fall nicht mehr nötig.

Nächste Schritte, nach erwartetem Gewinn:

1. In-place für den Akkumulator von `aggregate` im Emitter (eng begrenzt, gut testbar). Nach dem Umbau ist
   `game-logic.jul` (`accumulator.setElement(gameCardId newCard)`) die drittteuerste Stelle mit 8,6 % der
   kopierten Elemente.
2. Stufe 1 allgemein nicht bauen. Stufe 2 nur, wenn die Record-Spreads aus Parametern weiter oben im
   Profil stehen.
