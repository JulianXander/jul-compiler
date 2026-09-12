# Platzhalter-Auflösung im Checker vereinheitlichen

## Context

`docs/generic-types-through-function-body.md` lässt zwei Stellen offen, an denen der Checker eine
Parameter-Referenz im Funktionsrumpf *eager* auf ihren deklarierten Typ zurückfaltet, statt sie für
die spätere Aufrufstelle symbolisch zu halten: das **Präfix-Argument eines Methodenaufrufs**
(`values.getElement(2)`) und der **Index-/Namenszugriff** (`values/2`). Für Spread ist es bereits
umgesetzt.

Die Lücke, in dieser Session reproduziert (gegen den Checker gemessen, nicht aus dem Dokument
zitiert):

```jul
second = (values: List(Any)) :> ElementAt(TypeOf(values) 2) => values.getElement(2)
y = [1 §a§].second()     # typeInfo.type = {"julType":"textLiteral","value":"a"}

second = (values: List(Any)) => values.getElement(2)
y = [1 §a§].second()     # typeInfo.type = {"julType":"any"}   <-- Präzision weg
```

Nebenbefund: Über Fehler ist die Lücke **nicht** sichtbar (`y: Text = ...` meldet nichts), weil
`Any` gegenüber jedem Zieltyp permissiv behandelt wird. Nur der inferierte Typ zeigt sie.

Der direkte Fix an diesen zwei Stellen wäre riskant — nicht wegen fehlender Typmächtigkeit (die
sechs Konstruktoren existieren alle), sondern wegen dreier Altlasten: drei duplizierte
Traversierungen, eine Benennung die lügt, und eine unklare Performance-Lage. Dieser Plan räumt die
Altlasten zuerst weg und macht den eigentlichen Fix damit zur kleinen Änderung.

**Zentraler Befund dieser Session — die Performance-Lage ist umgekehrt als vermutet:**
[`isUnresolvedPlaceholderType`](../src/checker/checker.ts#L3315) ist eine vollständige rekursive
Baumtraversierung und wird in [`removeSubtypes`](../src/checker/checker.ts#L3357) über alle
Choice-Paare aufgerufen (O(n²) Baumdurchläufe), hängend an `createNormalizedUnionType` — also an
praktisch jeder Union-Konstruktion. Diese Kosten fallen **heute schon** an, unabhängig von
Generics. Das Flag zu cachen (rustc-`TypeFlags`-Muster) ist daher plausibel ein Netto-Gewinn, der
gleichzeitig Luft für das eigentliche Feature schafft.

---

## Phase 0 — Plan projektlokal ablegen

Diesen Plan nach `jul-compiler/docs/checker-placeholder-unification.md` schreiben (relative Links
anpassen), danach `~/.claude/plans/witty-riding-leaf.md` löschen. Plan-Mode erlaubt während der
Planung nur die Plan-Datei, deshalb erst jetzt.

## Phase 1 — Benennung ehrlich machen

Rein mechanisch, verhaltensneutral.

- `dereferenced*` und `resolved*` sind heute Synonyme für dasselbe → auf **ein** Wort vereinheitlichen.
- `resolved*` künftig nur dort, wo ein `isUnresolvedPlaceholderType`-Guard es tatsächlich
  festgestellt hat. Sonst ein Name ohne Zusicherung.
- Beleg für das Problem: [checker.ts:1080-1089](../src/checker/checker.ts#L1080-L1089) — `dereferenced1`
  ist nachweislich identisch mit `rawType`. Die "wenn nichts sich geändert hat, gib das Original
  zurück"-Optimierung steht in fast jedem Fall, also gibt `resolvePlaceholders` routinemäßig
  unaufgelöste Typen zurück.
- Bisher unmarkierte Variablen markieren: `prefixArgumentType`, `sourceType`, `argType`,
  `typeToDereference`.

**Kontrolle:** Beide Baselines müssen unverändert bleiben.

## Phase 2 — `assertNever` in `isUnresolvedPlaceholderType`

[checker.ts:3346](../src/checker/checker.ts#L3346) hat weiterhin `default: return false` — ausgerechnet
in der Funktion, die *entscheidet*, ob aufgeschoben wird. Ein fehlender Fall meldet still "ist
aufgelöst" → eager gefaltet → lautloser Präzisionsverlust. Exakt die Form des `case 'greater'`-Bugs,
der beim Spread-Fix gefunden wurde.

Erledigt zwei Dinge: macht die Bugklasse zum Compile-Fehler, **und** validiert die Fallliste, bevor
Phase 3 sie in die Konstruktoren einbrennt.

## Phase 3 — Platzhalter-Flag am Knoten cachen

Kern des Umbaus. `isUnresolvedPlaceholderType` wird von O(Baumgröße) auf einen O(1)-Feldzugriff.

- Flag bei der Konstruktion berechnen: `flag = (Knotenart ist inhärent unaufgelöst) || (irgendein Kind-Flag)`.
  Deckt beide heutigen Regeln ab — `parameterReference`/`nestedReference`/`withElementAt`/`tupleOf`
  sind inhärent unaufgelöst, der Rest erbt.
- Orte: die 15 Konstruktoren in [syntax-tree.ts:722-997](../src/syntax-tree.ts#L722-L997) plus
  [`createNormalizedUnionType`](../src/checker/checker.ts#L3379) und
  [`createNormalizedIntersectionType`](../src/checker/checker.ts#L3465).
- **4 Literal-Bypässe** für `tuple` über den Konstruktor führen: checker.ts
  [907](../src/checker/checker.ts#L907), [4194](../src/checker/checker.ts#L4194),
  [5057](../src/checker/checker.ts#L5057), [5073](../src/checker/checker.ts#L5073). (Der `or`-Literal
  bei 4573 ist eine feste Boolean-Union ohne mögliche Platzhalter — unkritisch.)

**Hauptrisiko:** Funktionstypen werden mutierbar gebaut, weil `setFunctionRefForParams` das Objekt
braucht, bevor seine Teile feststehen (Knotenbindung). Vier Stellen schreiben nachträglich:
checker.ts [2345](../src/checker/checker.ts#L2345), [2434](../src/checker/checker.ts#L2434),
[2454](../src/checker/checker.ts#L2454), [2459](../src/checker/checker.ts#L2459). Ein gecachtes Flag
würde dort veralten. Mitigation: eine kleine Helferfunktion, die das Flag nach dem Zuweisen neu
setzt — genau diese vier Stellen, alle lokal in zwei Switch-Cases. Die Mutation ist tragend, also
nicht wegrefactoren.

**Messen:** bench vor und nach, mit `--save`.

## Phase 4 — Die drei Traversierungen zu einer zusammenziehen

[`resolvePlaceholders`](../src/checker/checker.ts#L967) (~210 Zeilen) und
[`dereferenceArgumentTypesNested`](../src/checker/checker.ts#L684) (~175 Zeilen) haben dieselbe
Fallliste, dieselbe `===`-Kurzschluss-Struktur und rufen beim Neufalten bereits dieselben Smart
Constructors (`getLengthFromType`, `withElementAtFromTypes`, `tupleOfFromTypes`, `concatFromTypes`).
Real unterscheiden sie sich in **einem** Fall: `parameterReference` (und minimal bei
`nestedReference`).

- Ziel: eine Traversierung, parametrisiert über die Blatt-Aktion.
- `isUnresolvedPlaceholderType` entfällt als Traversierung bereits durch Phase 3.
- Danach gilt die Regel: **außerhalb einer `*FromTypes`-Funktion faltet niemand.**

Verhaltensneutral gemeint. Verschiebt sich eine Baseline, ist das ein **Befund**, kein
Update-Knopf — dann erst verstehen, warum.

## Phase 5 — Das eigentliche Feature

Erst jetzt, mit Flag und einer Traversierung im Rücken.

- Guard vor der eager-Auflösung bei `prefixArgumentType`
  ([checker.ts:2306](../src/checker/checker.ts#L2306)) und bei Index-/Namenszugriff
  (`dereferenceIndexFromObject` / `dereferenceNameFromObject`).
- **Beide Fundstellen gemeinsam**, sonst bleibt die willkürliche Grenze stehen, die das Dokument
  kritisiert ("Spread ist schlau, Feldzugriff nicht").
- **Roter Test zuerst** (CLAUDE.md-Konvention): Test schreiben, der die verlorene Präzision zeigt,
  rot laufen lassen, roten Output zeigen — **dann anhalten**, bevor der Fix kommt.
  Testvorlage ist der Repro oben; er prüft `typeInfo.type`, nicht die Fehlerliste, weil die Lücke
  über Fehler unsichtbar ist.
- Nachziehen: den "Offen"-Abschnitt in `docs/generic-types-through-function-body.md` und die
  TODO-Zeile 30.

---

## Verifikation

- `npm run typecheck`
- `npm test` — inklusive der beiden Baselines: `src/checker/checker-snapshot.baseline.txt`
  (331 Zeilen, Verhalten) und `src/checker/checker-stats.baseline.txt` (3 Zeilen: `inferType`,
  `resolvePlaceholders`, `getTypeError`). Exakter String-Vergleich, keine Toleranz; Eingabe ist der
  gesamte `jul-examples`-Bestand.
  - Phasen 1, 2, 4: Stats sollen sich **nicht** verschieben.
  - Phasen 3 und 5: Verschiebung erwartbar → `npm run test-update-snapshot`, mit Begründung der
    Differenz im Commit.
- `npm run bench -- --save --note "..."` **vor und nach** Phase 3, 4 und 5 einzeln (CLAUDE.md: vor
  und nach jedem Umbau an Checker/Parser/Server). Nicht auslassen — sonst vergleicht die nächste
  Messung über zwei Änderungen hinweg.
- Stichprobe: ein paar `jul-examples`-Projekte neu bauen. `C:\Projects\privat\yugioh` hängt
  ungepinnt am Compiler — bei Sprachverhalten-Änderungen im Blick behalten.

## Abbruchkriterien

- Phase 3 bringt keinen messbaren Gewinn → Phase 4 trotzdem sinnvoll (Korrektheit), Phase 5 neu
  bewerten.
- Phase 5 kostet spürbar (Größenordnung des `WithElementAt`-Funds: +51 % auf `getTypeError`) →
  zurück zur Bewertung im Dokument: kein akuter Leidensdruck, die Annotation kostet vier bis fünf
  Zeichen und funktioniert heute korrekt.

Phasen 1-4 sind auch für sich wertvoll und ohne Phase 5 sinnvoll abschließbar.
