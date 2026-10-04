# Unveränderliche Funktionstypen

## Stand

Ein Funktionstyp (`CompileTimeFunctionType`) wird beim Prüfen eines Funktionsliterals zuerst mit leeren
Platzhaltern angelegt (`ParamsType` und `ReturnType` sind `builtinEmpty`) und erst danach gefüllt:
`ParamsType` nach den Parametern, `purity`, `literal`, `foldable`, `ReturnType` und `predicate` nach dem
Rumpf (`checker.ts`, Fall `functionLiteral`). Nach jeder Zuweisung an `ParamsType` oder `ReturnType`
rechnet `updateFunctionTypeUnresolvedFlag` das Flag `isUnresolvedPlaceholder` neu, weil es sonst nicht
mehr stimmt. Alle anderen Typen haben dieses Flag ab dem Erzeugen fest.

Der Grund ist ein Zyklus: Die Parameter-Symbole und jede `parameterReference` im Typ tragen ein
`functionRef`, das auf genau das Funktionsobjekt zeigt. Ein Rückgabetyp wie `Concat(TypeOf(a) TypeOf(b))`
enthält Verweise auf Parameter derselben Funktion, ist also Teil des Objekts, auf das er zeigt. Das
Funktionsobjekt muss deshalb vor seinen Bestandteilen existieren.

## Folgen

- Typen sind nicht durchgängig unveränderlich. Ein Cache über Typpaare oder über die Identität eines
  Typs (Relationen, Normalisierung von Unions) ist für Typen mit Funktionsanteil nicht sicher, solange
  ein Funktionstyp noch gefüllt wird.
- Das Flag `isUnresolvedPlaceholder` und alles, was sich darauf stützt, braucht bei Funktionen eine
  eigene Pflege (`updateFunctionTypeUnresolvedFlag`, 4 Aufrufe in `checker.ts`).
- Wer einen Funktionstyp während der Prüfung des Rumpfs liest, sieht einen Zwischenstand.

## Audit (Stand der Untersuchung)

Gezählt wurde in `jul-compiler/src` und `jul-language-server/src`, ohne Tests. Die Treffer für
`functionRef` in `parser.ts` sind `functionReferenceResult` und gehören nicht dazu.

**`functionRef` (17 Stellen)**

| Art | Stellen |
|---|---|
| Setzen, Typfunktionen der core-lib (`Stream` und `FiniteStream` über `createStreamTypeFunction`, `List`, `Dictionary`, `nativeFunction`) | `checker.ts` 263, 292, 307, 330; hier entsteht der Zyklus schon beim Aufbau |
| Setzen an Parameter-Symbolen | `setFunctionRefForParams` (2 Stellen), und `checker.ts` 460 kopiert es vom Symbol in die `parameterReference` |
| Identitätsvergleich | `type-algebra.ts` 889 (Argumente einsetzen), `checker.ts` 721 (Projektion), 3657 und 3840 (Purity: eigener Parameter) |
| Inhalt lesen | genau eine Stelle: `dereferenceParameterTypeFromFunctionRef` (`type-algebra.ts` 1340) liest `ParamsType` |

Der Verweis wird also fast nur als Identität benutzt. Inhalt wird einzig über `ParamsType` gelesen.

**Schreibzugriffe auf `ParamsType`, `ReturnType`, `purity`, `literal`, `foldable`, `predicate`,
`boundArguments`:** 18 in `checker.ts`, 4 in `type-algebra.ts` (Neubau in `traversePlaceholders`).
`createCompileTimeFunctionType` wird an 13 Stellen aufgerufen (11 in `checker.ts`, 2 in
`type-algebra.ts`). Einige der Schreibzugriffe (`checker.ts` 650, 1774, 4070ff) betreffen frisch
angelegte Typen, die noch nicht weitergegeben wurden. Sie ließen sich in den Konstruktoraufruf ziehen.

**Was während der Prüfung des Rumpfs sichtbar ist:** Der Funktionstyp ist über die `parameterReference`
im Rumpf erreichbar. Gelesen wird dort nur `ParamsType` (gesetzt vor der Rumpfprüfung) und die Identität.
`ReturnType`, `purity`, `literal`, `foldable` und `predicate` entstehen nach dem Rumpf und sind erst im
fertigen Typ sichtbar, den der Checker zurückgibt. Die Selbstrekursion nimmt die Purity optimistisch an
und liest den Funktionstyp nicht.

## Einordnung der 22 Schreibzugriffe

| Gruppe | Stellen | Anzahl | Was nötig wäre |
|---|---|---|---|
| A: frisch angelegter Typ, noch nicht weitergegeben | `checker.ts` 650, 1774 (`predicate`); 4070–4073 (`predicate`, `literal`, `foldable`, `boundArguments`); `type-algebra.ts` 1078–1081 (dieselben vier) | 10 | nur den Konstruktor erweitern: `createCompileTimeFunctionType(params, return, purity, aliasName, fakten?)` |
| B: Funktionsliteral, nach dem Rumpf bekannt | `checker.ts` 2802, 2813, 2822, 2825 (`purity`); 2859, 2860 (`literal`, `foldable`); 2911, 2913 (`ReturnType`, `predicate`) | 8 | Werte lokal berechnen, den Typ am Ende der Prüfung einmal anlegen. Die vier `purity`-Zuweisungen sind Zweige derselben Entscheidung und werden zu einer Variablen |
| B′: Funktionsliteral, vor dem Rumpf bekannt | `checker.ts` 2741 (`ParamsType`) | 1 | Token |
| C: Funktionstyp-Literal | `checker.ts` 2932 (`ParamsType`), 2938 (`ReturnType`) | 2 | Token für `ParamsType`, `ReturnType` danach am Ende |
| D: Mutation eines schon weitergegebenen Typs | `checker.ts` 2707 (`resolvedReturnType.purity`) | 1 | mit Token ein Klon, siehe unten |

Also 18 der 22 Zuweisungen sind mechanisch (A, B), 3 brauchen das Token (B′, C), 1 braucht eine
Entscheidung (D).

**Gruppe D** ist der Fall, an dem der Zyklus am deutlichsten wird. Der Kommentar bei `checker.ts` 2691
begründet die Mutation damit, dass `parameterReference`-Knoten per `functionRef` auf genau dieses Objekt
zeigen und eine Kopie die Identität bräche. Mit dem Token teilt die Kopie das Token und damit die
Identität, der Grund entfällt. Das Mutieren eines fremden, schon weitergereichten Typs wäre damit
nicht mehr nötig.

**Erzeugungsstellen (13):** 4 der core-lib (`checker.ts` 255, 284, 299, 315) bauen den Zyklus mit
Token, Parameterverweis und Funktionstyp in dieser Reihenfolge. 2 sind Funktionsliteral und
Funktionstyp-Literal (2722, 2919). 7 sind unkritisch (333 `nativeValue`, 644, 1768, 4069, 4847,
`type-algebra.ts` 250 und 1075): Kopie oder Konstante ohne Zyklus.

## Entwurf (Skizze, nicht entschieden)

Identität und Inhalt trennen. Das Token ist ein kleines, einmal beschreibbares Objekt, das vor dem
Funktionsliteral angelegt wird und nur `ParamsType` aufnimmt:

- `parameterReference.functionRef` und das Symbol zeigen auf das Token statt auf den Funktionstyp.
- Der Funktionstyp trägt dasselbe Token als Identität. Die vier Vergleiche prüfen Token gegen Token.
- `dereferenceParameterTypeFromFunctionRef` liest `ParamsType` aus dem Token.
- Der Funktionstyp selbst wird erst nach dem Rumpf angelegt, vollständig und danach unveränderlich:
  `ReturnType`, `purity`, `literal`, `foldable`, `predicate` und das Flag stehen von Anfang an fest.
  `updateFunctionTypeUnresolvedFlag` entfällt.
- Der einzige verbleibende Zyklus liegt im Token (Parametertypen, die frühere Parameter referenzieren).
  Er wird einmal vor der Rumpfprüfung geschlossen.

Offen:

- Das Token muss vor `ParamsType` existieren, weil Parametertypen frühere Parameter referenzieren können
  (abhängige Parameter). Das Schließen des Zyklus gehört dorthin, nicht in den Funktionstyp.
- Rekursive Aufrufe im eigenen Rumpf: Der Funktionstyp existiert dort noch nicht. Die Inferenz nimmt die
  Purity optimistisch an. Prüfen, ob irgendein Pfad den Typ der eigenen Funktion im Rumpf braucht.
- `traversePlaceholders` baut Funktionen neu (`type-algebra.ts` 1075ff) und kopiert danach vier Felder
  per Zuweisung. Diese Felder müssten in den Konstruktor.
- `mapElements` verlässt sich darauf, dass Verweise im Rückgabetyp des Callbacks "auf genau dieses
  Funktionsobjekt" zeigen (Kommentar in `traversePlaceholders`). Das Token muss dort dieselbe Identität
  liefern.
- `bound`-Funktionstypen (`checker.ts` 4070ff) kopieren Fakten eines anderen Funktionstyps.
- Die Typfunktionen der core-lib (4 Stellen für 5 Funktionen) bauen den Zyklus beim Modul-Load auf. Sie brauchen dieselbe
  Reihenfolge: Token, Parameterverweis, Funktionstyp.

## Umgesetzt

Der Spike (unten) ist ins Repo übernommen, dazu Gruppe A und B: `createCompileTimeFunctionType` nimmt
Identität und Fakten (`predicate`, `literal`, `foldable`, `boundArguments`) im fünften Parameter
entgegen, `getFunctionTypeFacts` übernimmt sie bei einem Neubau. Alle Felder eines Funktionstyps sind
`readonly`, `updateFunctionTypeUnresolvedFlag` ist entfernt. Geprüft mit Typecheck, der ganzen Suite
samt Gates, `jul check` auf yugioh (identische Ausgabe), dem Language Server (Tests und Snapshot) und
beiden Benches (laufzeitneutral, Compiler +3 % im Rauschen).

Offen aus diesem Dokument: das Verhalten der Spread-Kopie (siehe unten) und der Relationscache.

## Spike-Ergebnis

Ein Wegwerfversuch in einer Kopie des Compilers (nichts im Repo geändert) hat den Entwurf gegen die
Suite und ein großes Projekt geprüft:

- `FunctionIdentity` (nur `ParamsType`) als neuer Typ, `CompileTimeFunctionType.identity`,
  `functionRef` an `ParameterReference` und `SymbolDefinition` zeigt darauf. Die Identität ist
  nominal markiert (`isFunctionIdentity`), sonst erfüllt der Funktionstyp sie strukturell, und der
  Compiler würde die nicht migrierten Stellen verschweigen.
- `functionLiteral` und `functionTypeLiteral` legen den Funktionstyp erst nach dem Rumpf an.
  `purity` wird lokal berechnet, `updateFunctionTypeUnresolvedFlag` entfällt dort.
- Gruppe D (`checker.ts` 2707): ein Klon, der die Identität teilt, ersetzt die Mutation. Dafür
  musste die Entscheidung vor die Verwendung des Rückgabetyps gezogen werden.
- Danach sind `ParamsType`, `ReturnType` und `purity` `readonly`, und der Compiler meldet keine
  Zuweisung mehr.

Ergebnis: Typecheck sauber, alle 1203 Tests inklusive Checker-Snapshot und Zähler-Baseline
unverändert grün, `jul check` auf dem yugioh-Projekt (16 Dateien, ein Fehler in `game-logic.jul`
Zeile 47) liefert Zeichen für Zeichen dieselbe Ausgabe. Der Diff umfasst etwa 150 geänderte Zeilen
in vier Dateien.

Was das Token gelöst hat:

- Rekursive Funktionen und abhängige Parameter machten keine Probleme: Der Rumpf liest über das Token
  nur `ParamsType`, und das steht vor der Rumpfprüfung fest.
- `mapElements` und die Typfunktionen der core-lib brauchten keine Sonderbehandlung. Bei der core-lib
  genügt `parameterReference.functionRef = functionType.identity` nach dem Erzeugen.

Nicht geprüft und offen:

- `literal`, `foldable`, `predicate` und `boundArguments` werden weiter nach dem Erzeugen zugewiesen
  (Gruppe A und B). Sie stehen auf dem Funktionstyp, bevor er weitergegeben wird, und sind nicht
  `readonly`.
- Eine Kopie per Spread (`checker.ts` ca. 2682, Signatur für Hover) behält jetzt dieselbe Identität.
  Vorher löste sich ein Verweis auf das Original dort nicht auf. Die Tests ändern sich dadurch nicht,
  das Verhalten ist aber nicht mehr identisch zu vorher und sollte bewusst entschieden werden.
- Keine Messung der Laufzeit. Der Relationscache, der den Umbau motiviert hat, ist nicht gebaut.
- Der Language Server und die Tests dort laufen gegen den Compiler aus `out/` und wurden nicht
  gegen den Spike gebaut.

## Nutzen, soweit absehbar

- Ein Cache für Relationen und normalisierte Unions wäre für Funktionstypen sicher. Ob er sich lohnt,
  ist offen: Der A/B-Test mit der Textliteral-Abkürzung in `removeSubtypes` hat gezeigt, dass weniger
  Aufrufe nicht automatisch weniger Zeit bedeuten.
- Ohne die Mutation entfällt das Nachführen des Flags `isUnresolvedPlaceholder` bei Funktionstypen.
- Möglicherweise lässt sich `structuredClone` in `checkTypes` vermeiden (8 % des Checks). Das hängt
  vom ungecheckten Baum ab, nicht vom Typ, und ist hier nicht untersucht.

## Vergleich

TypeScript trennt dasselbe: Verweise laufen über Symbole, Parameter- und Rückgabetypen werden beim
ersten Zugriff aufgelöst und am Symbol gemerkt, mit Zirkularitätsschutz. Relationen werden erst
gecacht, wenn sie nicht mehr von einer laufenden Berechnung abhängen.

## Nächste Schritte

1. Entwurf gegen `design-principles.md` prüfen.
2. Beim Token klären, ob `ParamsType` allein reicht oder ob mehr früh gelesen wird (abhängige
   Parameter, `mapElements`).
3. Entscheiden. Fällt die Entscheidung, gehört das Ergebnis in ein eigenes Dokument in `docs/`.

Als erster, für sich nützlicher Schritt ohne Token wäre Gruppe A (10 Zuweisungen) umsetzbar: der
Konstruktor nimmt die Fakten entgegen, und die Zuweisungen nach dem Erzeugen entfallen. Das ändert
kein Verhalten und lässt sich mit den Gates prüfen.
