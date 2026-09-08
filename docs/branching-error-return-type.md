# Branching ohne catchAll: Error-Handling im Rückgabetyp

## Problem

Die `_branch` Runtime-Funktion ([runtime.ts:21-28](../src/runtime.ts#L21-L28)) gibt `new Error(...)` zurück, wenn kein Branch auf die Eingabe passt:

```javascript
export function _branch(args: Collection | undefined, ...branches: JulFunction[]) {
	for (const branch of branches) {
		const assignedParams = tryAssignArgs(branch.params, undefined, args);
		if (!(assignedParams instanceof Error)) {
			return branch(...assignedParams);
		}
	}
	return new Error(`${args} did not match any branch`);  // ← Fehler, wenn nichts matcht
}
```

**Der Checker macht das nicht visible:** Ein Branching ohne `catchAll` (einen Branch, der alles matcht) deklariert einen Rückgabetyp, der das mögliche `Error` nicht enthält. Das ist **unsound**: Code, der nach einem solchen Branching ein `Error` erhält, ist zum Type-Check-Zeit nicht damit gerechnet.

**Beispiel:**
```jul
f = (x: Or(1 2 3)) => ?(x)
	[1] => §eins§
	[2] => §zwei§
	# Fall 3 nicht abgedeckt

result = f(x)  # Typ: Text, aber zur Laufzeit kann es Error sein
```

## Lage im Code

- **Checker:** [checker.ts:920-950](../src/checker.ts#L920-L950) — case 'branching', berechnet Rückgabetyp als Union aller Branch-Rückgabetypen
- **Runtime:** [runtime.ts:21-28](../src/runtime.ts#L21-L28) — `_branch` wirft Error bei kein Match
- **Core-lib:** [core-lib.jul:107](../src/core-lib.jul#L107) — `Error`-Typ ist definiert

## Designoptionen

### Option A: Error in Rückgabetyp einbinden (Recommended)

**Beschreibung:**  
Wenn ein Branching keinen `catchAll`-Branch hat (weder `()` noch `Any`), wird `Error` zum Rückgabetyp hinzugefügt. Compiler-Seitiger Check erkennt, ob ein Branch alles abdeckt.

```jul
f = (x: Or(1 2 3)) => ?(x)
	[1] => §eins§
	[2] => §zwei§
# Typ: Or(Text Error)  ← Error ist nun Pflicht im Typ
```

**Pro:**
- Korrekt (sound) — der Typ beschreibt alle möglichen Laufzeitwerte
- Einfach implementierbar (3-4 Zeilen im Checker)
- Benutzer sieht sofort, dass ein Fall fehlt

**Contra:**
- Bei gewollter Exhaustivitätsprüfung (TODO: ein anderes Feature) kann Error u.U. redundant sein
- Ändert bestehende Typen (Breaking Change für Code, der schon geschrieben wurde)

**Implementierungsaufwand:** Klein

---

### Option B: Exhaustivitätsprüfung erzwingen

**Beschreibung:**  
Der Compiler prüft, ob ein Branching alle Fälle abdeckt. Ohne Exhaustivität ist es ein Fehler, nicht nur eine Warnung.

```jul
f = (x: Or(1 2 3)) => ?(x)
	[1] => §eins§
	[2] => §zwei§
# Compiler-Fehler: "Case 3 not covered"
```

**Pro:**
- Zwingt Benutzer, explizit zu denken
- Keine Error im Typ nötig

**Contra:**
- Kann unwillkürlich streng sein (z.B. bei Union-Typen, die nicht auflösbar sind)
- Höherer Implementierungsaufwand
- Braucht vorher die Entscheidung: was ist "exhaustiv"? (→ TODO: `catchAll`-Definition)

**Implementierungsaufwand:** Mittel bis Hoch

---

### Option C: Status quo (unsound, nicht empfohlen)

**Beschreibung:**  
Nichts ändern. Error bleibt undeklariert.

**Pro:**
- Null Aufwand

**Contra:**
- Type-unsound
- Benutzer hat keine Möglichkeit, das Problem zu erkennen
- Wird in jedem größeren Projekt zu unerwartetem Laufzeit-Fehler

---

## Tradeoffs: A vs. B im Detail

| Kriterium | Option A | Option B | Sieger |
|-----------|----------|----------|--------|
| **Implementierungsaufwand** | 1 Tag | 3-5 Tage | A |
| **Soundness sofort** | ✅ Error im Typ | ✅ Compiler-Fehler | Beide |
| **Code-Breaking** | Ja (Typen ändern sich) | Ja (Binaries haben Fehler) | Remis |
| **Bedingte Ausführung** | ✅ `?(x) [case] => effect` ohne catchAll möglich | ❌ Erzwingt immer catchAll | A |
| **„If ohne else"-Pattern** | ✅ Unterstützt | ❌ Verboten | A |
| **Flexibilität für Later** | Erlaubt unsicheres `?` mit Fallback | Erzwingt Exhaustivität | B |
| **Debuggbarkeit** | Error-Wert sichtbar im Typ | Compile-Fehler klar | B |
| **Rückgängigmachung schwierig** | Sehr schwierig (Abhängigkeiten) | Relativ einfach | A |
| **Abhängig von anderem Design** | Nein | Ja: `catchAll`-Semantik | A |

---

**Anmerkung zu "Rückgängigmachung schwierig":**

Falls wir uns später anders entscheiden wollen, ist der Aufwand sehr unterschiedlich:

- **Option A rückgängig machen:** Error wurde zum Typ hinzugefügt, hunderte Funktions-Signaturen haben sich geändert, Benutzer-Code hat Error in Typdeklarationen geschrieben. Um das rückgängig zu machen, müssten wir:
  1. Error aus Signaturen entfernen
  2. Alle Stellen finden, die Error behandeln
  3. Semantik von betroffenen Branchings neu bewerten
  
  Das ist extrem aufwändig.

- **Option B rückgängig machen:** Exhaustivitätsprüfung wurde eingeführt. Um das rückgängig zu machen:
  1. Compiler-Flag umdrehen oder zu Warnung downgraden
  2. Oder einfach ein Feature-Flag hinzufügen
  
  Das ist relativ einfach — es ist reiner Compiler-Code, nicht die Typ-Infrastruktur.

---

**Kontextannahmen dieser Bewertung:**

Dieses Dokument geht davon aus, dass die Sprache noch in experimenteller Phase ist und keine etablierte Nutzer-Basis hat. Das ändert die Gewichtung:

- **Migrationsaufwand ist irrelevant** — Breaking Changes sind akzeptabel
- **"Rückgängigmachung schwierig"** ist kein Argument gegen A (es lohnt sich, wenn es das richtige Design ist)
- **Die Frage ist: Was ist das richtige Langzeit-Design?**

---

**Neu-Bewertung unter dieser Annahme:**

| Kriterium | Option A | Option B | Sieger |
|-----------|----------|----------|--------|
| **Implementierungsaufwand** | 1 Tag | 3-5 Tage | A |
| **Soundness sofort** | ✅ Error im Typ | ✅ Compiler-Fehler | Beide |
| **Bedingte Ausführung** | ✅ Unterstützt | ❌ Verboten | A |
| **„If ohne else"-Pattern** | ✅ Unterstützt | ❌ Verboten | A |
| **Langfristiges Design** | Error als Wert im Typ-System | Exhaustivität erzwungen | ? |
| **Flexibilität für Sonderfälle** | Erlaubt unsicheres `?` | Alles ist exhaustiv | ? |
| **Konsistenz mit Sprachphilosophie** | Abwesenheit im Typ (Prinzip 6) | Abwesenheit als Fehler (auch Prinzip 6) | ? |

Die beiden wichtigsten Fragen sind jetzt:

1. **Wollen wir langfristig `Error` als regulären Wert im Typ-System haben?** (wie Rust `Result<T, E>` oder wie JUL `Or(T Error)`)
2. **Oder wollen wir Pattern Matching mit Exhaustivität und `_` Wildcard erzwingen?** (wie Scala/Rust)

---

**Empfehlung revidiert: Option B ist attraktiver als gedacht**

Wenn Migrationen egal sind, wird die Frage klarer:

- **Option A** ist ein Workaround: Wir bauen Error-Handling in den Typ ein, weil wir nicht erzwingen wollen
- **Option B** ist die richtige Lösung: Wir machen Exhaustivität zur Regel, nicht zur Ausnahme

**Option B hätte diese Vorteile:**
- ✅ Sound by Construction (nicht nachmachen)
- ✅ Erzeugt besseren Code (Benutzer denkt über alle Fälle nach)
- ✅ Konsistent mit Rust/Scala (bewährtes Design)
- ✅ Keine Error-im-Typ-Inflation (vereinfachte Signaturen)
- ❌ Bedingte Effekte brauchen explizite catchAll (`() => undefined`)

**Die Tradeoff-Frage wird zu:**

Wollen wir:
- **A:** Bedingte Effekte erlauben (wenn-ohne-else), aber mit Error im Typ leben
- **B:** Bedingte Effekte verbieten, dafür Sound-by-Construction und klare Fehler

---

**Was wird bei Option A konkret umgebaut?**

Der Checker-Code selbst ist klein (3-4 Zeilen im case 'branching'), aber die Konsequenzen durchziehen die ganze Codebase:

1. **Alle Branchings ohne catchAll** bekommen automatisch `Error` in ihrer Union
   - Beispiel: `?(x) [1] => §a§; [2] => §b§` hatte Typ `Text`, hat jetzt `Or(Text Error)`

2. **Alle Funktionen, die ein Branching zurückgeben**, ändern ihren Typ
   - `f = (x: Integer) => ?(x) [1] => §a§; [2] => §b§` hatte Typ `(Integer) :> Text`, hat jetzt `(Integer) :> Or(Text Error)`
   - Das sind hunderte Funktionen in Benutzer-Code, yugioh, jul-examples

3. **Alle Call-Sites, die diese Funktionen aufrufen**, bekommen Typ-Fehler
   ```jul
   result: Text = f(x)  // ← Error: Or(Text Error) kann nicht zu Text zugewiesen werden
   ```
   - Der Benutzer muss jetzt `result: Or(Text Error) = f(x)` schreiben
   - Oder Error-Handling hinzufügen: `?(f(x)) [result: Text] => doSomething(); () => handleError()`

4. **Alle bestehenden Typen, die man deklariert hat**, sind plötzlich zu eng
   ```jul
   process = (handler: (Integer) :> Text) => ...
   // Problem: Ein Branching ist jetzt (Integer) :> Or(Text Error), nicht (Integer) :> Text
   ```

Das ist ein **umfassender Typ-Struktur-Umbau**, der überall durchgreift. Der Compiler-Code ist trivial, aber die Migration ist groß.

---

**Im Vergleich: Option B umbaut**

1. Der Compiler erhält einen zusätzlichen Check: "Sind alle Fälle abgedeckt?"
2. Wenn nicht, wirft er einen Fehler
3. Benutzer-Code, der nicht-exhaustiv ist, bricht **an exakt der Stelle**, wo der Fehler ist
4. Benutzer fügt `() => ...` hinzu oder alle Fälle ab
5. Typ-Signaturen ändern sich **nicht**

Das ist eine **Compile-Level-Änderung**, keine Typ-Struktur-Änderung.

---

---

**Kernkonflikt:**
- **A:** Macht das System zum Type-Check korrekt, zieht aber Konsequenzen (Error im Typ) nach sich, die Benutzer aktiv handhaben müssen
- **B:** Behebt den Fehler an der Quelle, zwingt aber zum kompletten Refactoring **und verbietet bedingte Ausführung ohne catchAll**

**Neuer kritischer Punkt: "If ohne Else"**

Option B verbietet das Muster (bedingte Effekte ohne catchAll):
```jul
?(result)
	[success] => doSomething()  // Nur dieser Fall wird behandelt
	# Error-Fall wird ignoriert (wie ein if ohne else)
```

Mit Option B müsste immer ein catchAll geschrieben werden:
```jul
?(result)
	[success] => doSomething()
	() => undefined  // Explizit erzwungen: leere catchAll
```

Das verkompliziert den Code für einen häufigen Use-Case (bedingte Effekte). **Option A hat hier Vorrang.**

JUL hat bereits die `() => ...` Notation für catchAll — wir brauchen keine zusätzliche Wildcard-Syntax. Option B würde trotzdem erzwingen, dass sie überall geschrieben wird, auch wo sie semantisch nicht gebraucht wird.

Mit Option B müsste es sein:
```jul
?(result)
	[success] => doSomething()
	() => undefined  // Expliziter Fallback erzwungen
```

Das verkompliziert den Code für einen häufigen Use-Case (bedingte Effekte). **Option A hat hier Vorrang.**

---

## Wie andere Sprachen das lösen

### TypeScript: Union mit `never` (ähnlich Option A)

```typescript
type Result<T> = T | { error: string };

function match<T>(value: 1 | 2 | 3, handlers: {
	[1]: () => T;
	[2]: () => T;
	[3]: () => T;
}): T {
	// Alles abgedeckt → T
	// ...
}

function matchUnsafe<T>(value: 1 | 2 | 3, handlers: {
	[1]: () => T;
	[2]: () => T;
	// Fall 3 fehlt
}): T | never {
	// Rückgabetyp ist unsicher
	// ...
}
```

**Was TypeScript macht:**
- `never` ist der untere Typ (inhabitted by nothing)
- Union mit nicht abgedeckten Fällen: Das System kann das nicht direkt ausdrücken
- Workaround: Benutzer schreiben manuell `Result<T> | Error`
- **Keine automatische Exhaustivitätsprüfung** im Base-System (nur über externe Tools wie `@ts-check`)

**Lernpunkt für JUL:** TypeScript sagt: "Unsichere Pattern → manuell den Error-Typ mitschreiben". Das ist Option A.

---

### Scala: `match` mit Exhaustivitätsprüfung (Option B)

```scala
sealed trait Result
case object One extends Result
case object Two extends Result
case object Three extends Result

def process(r: Result): String = r match {
	case One => "eins"
	case Two => "zwei"
	// Compiler-Error: match may not be exhaustive
}
```

**Was Scala macht:**
- `sealed` erzwingt Exhaustivität: nur die bekannten Subtypen sind erlaubt
- Fehlende Fälle → **Compile-Fehler** (nicht Warning)
- Benutzer muss `case _ => ...` schreiben oder alle Fälle abdecken
- Fallback nur explizit mit Wildcard

**Lernpunkt für JUL:** Scala sagt: "Unsichere Pattern → Compiler-Fehler". Das ist Option B mit `sealed`.

---

### Rust: `match` mit `unreachable!()` oder `_` (hybride Lösung)

```rust
fn process(x: u8) -> String {
	match x {
		1 => "eins".to_string(),
		2 => "zwei".to_string(),
		3 => "drei".to_string(),
		_ => panic!("Unexpected value"),  // ← Expliziter Fallback
	}
}
```

**Was Rust macht:**
- `match` ist standardmäßig exhaustiv (Compiler-Fehler ohne alle Fälle)
- `_` Wildcard ist erlaubt, aber sichtbar (nicht still)
- `panic!()` oder `unreachable!()` zur Laufzeit explizit
- **Keine Typen für Fehler**: Fehler ist Laufzeit-Abort, nicht ein Wert

**Lernpunkt für JUL:** Rust erzwingt Exhaustivität UND macht Fallbacks sichtbar. Das ist Option B + explizite Syntax.

---

### Haskell: Exhaustivität-Warning, aber nicht Error (hybrid)

```haskell
process :: Either Result String
process x = case x of
	Left One -> "eins"
	Left Two -> "zwei"
	-- Warning: Pattern match is not exhaustive
	-- Die Compilation läuft aber durch (mit Flag -Werror wird es Fehler)

process x = case x of
	Left One -> "eins"
	Left Two -> "zwei"
	_ -> error "Missing case"  -- ← Expliziter Fallback
```

**Was Haskell macht:**
- Exhaustivitäts-**Warnung** (nicht Fehler)
- Wildcard `_` ist explizit (guter Stil: immer mit `_` abdecken)
- Laufzeit-`error` in Fallback
- Mit Compiler-Flag `-Werror` wird Warning zu Fehler

**Lernpunkt für JUL:** Haskell sagt: "Wir warnen, machen es aber nicht erzwingend." Das ist zwischen A und B.

---

## Fazit: Was für JUL am besten passt

| Ansatz | Sprache | Charakter |
|--------|---------|-----------|
| **A (Error im Typ)** | TypeScript, Kotlin | „Dynamisch optional, aber typprüfbar" |
| **B (Exhaustivität)** | Scala, Rust, OCaml | „Absolut zwingend" |
| **Hybrid (Warnung + Wildcard)** | Haskell, Python/mypy | „Flexible Strenge" |

**Für JUL:**

JUL ist eine **statisch typisierte, Sound-System** — näher bei Scala/Rust als bei TypeScript. Das spricht für **Option B** als Langziel (wie Rust: Exhaustivität erzwingen + `_` explizit).

Aber:
1. **B braucht Vorarbeit** (Semantik von `catchAll`, Typunion-Auflösung, Test-Infrastruktur)
2. **A ist der sofortige Fix** und macht das System korrekt (wie Haskell: Warning wird später zu Fehler mit `-Werror`)

**Empfehlung bleibt A**, aber mit dem Wissen: Das ist der erste Schritt zu B.

---

## Designprinzipien (JUL Design-Richtlinien)

Die Entscheidung für **Option A** wird durch drei Kernprinzipien gestützt:

### Prinzip 2: Bei einer Ausnahme ist die Regel falsch, nicht der Fall
> „Eine allgemeine Regel mit Ausnahmenliste ist teurer als eine strengere Regel ohne."

**Anwendung hier:**

Option B (Exhaustivität) führt eine Ausnahmenliste ein:
- Alle Fälle müssen abgedeckt sein **außer**
- wenn du `()` schreibst **oder**
- wenn du `_` wildcard schreibst

Das widerspricht dem Prinzip. Stattdessen brauchen wir eine Regel ohne Ausnahmen:
- Option A: Error gehört zur Union, wenn nicht alle Fälle abgedeckt sind. Punkt.
- Keine Ausnahmen, keine Wildcard-Regel, die separat erklär werden muss.

### Prinzip 4: Unwissen ist keine Ablehnung
> „Wo der Checker etwas nicht auflösen kann, fällt er zugunsten des Programms aus: Union statt Auswahl."

**Anwendung hier:**

Bei unvollständigen Branchings können wir nicht immer definitiv sagen, ob alle Fälle abgedeckt sind (z.B. bei unscharfen Union-Typen, bei generics). Nach Prinzip 4:
- Nicht zu einem „False Positive" führen (Compiler-Fehler, obwohl es richtig ist)
- Lieber eine weite Union (mit Error) als eine Ablehnung im Zweifel

Option B kann hier zu falschen Fehlern führen. Option A nicht.

### Prinzip 6: Abwesenheit wird geschrieben, nicht geschluckt
> „Das Fehlen eines Werts ist ein eigener Fall, der in der Signatur auftaucht."

**Anwendung hier:**

Beide Optionen sprechen für Prinzip 6, nur in unterschiedlichen Medien:
- **Option A:** Der fehlende Case wird in der **Typ-Signatur** geschrieben (Error in der Union)
- **Option B:** Der fehlende Case wird als **Compiler-Fehler** geschrieben (nicht schweigend, sondern gemeldet)

Prinzip 6 sagt: „nicht schweigen". Beide erfüllen das:

```jul
// Option A: Abwesenheit im Typ
f = (x: Or(1 2 3)) => ?(x)
	[1] => §eins§
	[2] => §zwei§
# Typ: Or(Text Error)  ← Abwesenheit steht im Typ

// Option B: Abwesenheit als Fehler
f = (x: Or(1 2 3)) => ?(x)
	[1] => §eins§
	[2] => §zwei§
# Compiler-Fehler: "Case 3 not covered"  ← Abwesenheit gemeldet
```

**Der Unterschied zu Prinzip 6:**
- Prinzip 6 spricht vom „Fehlen eines Werts" (z.B. Optional-Typen, leere Kollektionen)
- Hier geht es um das „Fehlen eines Falles" (unvollständiges Pattern Matching)

Diese sind nicht dasselbe. Prinzip 6 sagt nicht, dass *alle* Abwesenheiten im Typ stehen müssen — nur die, die Werte betreffen (Empty im Return-Typ einer Funktion). Ein fehlender Fall im Branching ist kein Wert-Fehlen, sondern ein Programmfehler.

**Fazit:** Prinzip 6 ist neutral zwischen A und B. Es sagt nur: „mach Abwesenheit sichtbar." A macht das im Typ, B als Compiler-Fehler. Beide sind nicht-schweigend.

---

## Rangfolge bei Kollisionen (aus design-principles.md)

Falls Prinzip 2 (keine Ausnahmen) mit Prinzip 4 (Union vor falschen Fehlern) kollidierten, gilt:
- **Prinzip 2 schlägt Ausnahmen vor** (Rangfolge in der Dokumentation)
- **Prinzip 4 schlägt Schärfe vor**

Hier kollidieren sie nicht — beide sprechen für Option A.

---

## Neues implizites Prinzip: Keine Sperre für gültigen Code

**Kernidee:** Die Sprache sollte kein gültiges, semantisch sinnvolles Programm verbieten, nur weil es eine Invariante verletzt, die aus puristischen Gründen erzwungen werden soll.

**Beispiel:**
```jul
?(result)
	[success] => doSomething()  // Effekt, aber kein Rückgabewert
	# Falls der Case nicht passt, wird Error zurückgegeben
```

Das ist vollkommen **gültiger Code**: Eine bedingte Ausführung (if-ohne-else). Semantisch korrekt und sinnvoll.

Option B würde das verbieten und den Benutzer zwingen:
```jul
?(result)
	[success] => doSomething()
	() => undefined  // Erzwungen, obwohl nicht semantisch nötig
```

Das ähnelt dem klassischen Rust-Problem: Die Sprache zwingt den Programmierer, etwas zu schreiben, das der Computer verlangt, nicht das Problem erfordert.

**Nach diesem Prinzip:** Option A hat Vorrang. Error im Typ ist "ehrlich" (der Typ sagt, was passieren kann), aber erlaubt dem Benutzer, mit echten Use-Cases zu arbeiten.

---

## Rangfolge bei Kollisionen (revidiert)

Falls Prinzip 4 (Union vor falschen Fehlern) mit diesem neuen Prinzip (keine Sperre für gültigen Code) kollidierten, gilt:
- **Prinzip 4 schlägt Schärfe vor** (keinen falschen Fehler erzeugen)
- **Neues Prinzip schlägt Purismu vor** (den Code nicht verbieten)

Hier kollidieren sie nicht — beide sprechen für Option A.

---

## Empfehlung

**Option A** — Error in Rückgabetyp einbinden.

**Begründung (revidiert):**

1. **Keine gültigen Programme verbieten.** Bedingte Effekte ohne Fallback sind ein echtes Sprachmuster (if-ohne-else), das wir nicht bevormunden sollten. Option B würde das verbieten — das widerspricht der Philosophie, dass die Sprache mit dem Benutzer arbeitet, nicht gegen ihn.

2. **Soundness + Freiheit kombinieren.** Option A macht das System korrekt (Error ist im Typ), aber wir entscheiden nicht für den Benutzer, wie er seinen Code strukturiert.

3. **Langfristig erweiterbar.** Option A schließt nicht aus, dass wir später (als separates Feature) Exhaustivitätsprüfung einführen — als *optionales* Tool, nicht erzwungen. Option B schließt A aus.

4. **Migrationsaufwand ist akzeptabel** (Sprache ist experimentell).

---

**Warum nicht Option B?**

Option B ist "schöner" (Sound by Construction, klare Fehler), aber:
- ❌ Verbietet legale, sinnvolle Sprachmuster (if-ohne-else)
- ❌ Bevormundet den Benutzer (erzwingt `() => undefined` wo es nicht gebraucht wird)
- ❌ Das Rust-Problem: Programmierer kämpft gegen die Sprache, nicht mit ihr

---

**Nächste Schritte (Phase 1):**

- Test schreiben für Branching ohne catchAll
- Implementieren: Error zur Union hinzufügen
- Verifikation gegen jul-examples und yugioh

---

## Umsetzungsplan

### Phase 1: Test schreiben (rot)

Datei: [checker.test.ts](../src/checker.test.ts)

```typescript
{
	code: `f = (x: Or(1 2 3)) => ?(x)
		[1] => §eins§
		[2] => §zwei§
	g: Text = f(1)`,
	result: undefined,
	errors: [
		{
			code: 'JUL3000',  // oder neue Nummer
			message: 'Can not assign Or(Text Error) to Text',
			// oder alternativ:
			// message: 'Branching without catchAll may return Error, but target type Text does not include it'
			line: 5,
			column: 10,
		},
	],
}
```

Variante 2 (expliziter Error-Check):
```typescript
{
	code: `f = (x: Or(1 2 3)) => ?(x)
		[1] => §eins§
		[2] => §zwei§`,
	result: undefined,
	errors: [], // kein Error in der Deklaration, aber:
},
{
	code: `f = (x: Or(1 2 3)) => ?(x)
		[1] => §eins§
		[2] => §zwei§
	g: Or(Text Error) = f(1)`,  // ← Typ ist OK
	result: undefined,
	errors: [],
}
```

### Phase 2: Code-Stelle identifizieren (Debugging)

[checker.ts:920-950](../src/checker.ts#L920-L950), case 'branching':

1. **Bestimme, ob catchAll vorhanden ist:**
   - Ein Branch mit `params.type === 'any'` 
   - Ein leerer Branch `() => ...`
   - Ein Branch, dessen Parametertyp `Never` ist (unmöglich)

2. **Wenn keine catchAll:** Füge `Error` zur Union hinzu

### Phase 3: Implementierung

Patch in [checker.ts:920-950](../src/checker.ts#L920-L950):

```typescript
case 'branching': {
	// ... existing code to collect returnTypes ...
	
	const hasCatchAll = branches.some(branch => {
		const branchType = branch.inferredType?.type;
		if (!branchType) return false;
		if (branchType.julType === 'any') return true;
		if (branchType.julType === 'functionType') {
			const paramsType = branchType.params;
			return paramsType?.julType === 'any' 
				|| (paramsType?.julType === 'empty');  // () matcht alles
		}
		return false;
	});
	
	if (!hasCatchAll && returnTypes.length > 0) {
		returnTypes.push({ julType: 'reference', name: 'Error' });
	}
	
	const finalType = createNormalizedUnionType(returnTypes);
	return { type: finalType };
}
```

### Phase 4: Verifikation

```bash
cd jul-compiler
npx mocha --import=tsx --require ./test-setup.mjs src/checker.test.ts --grep "branching.*error|error.*branching"
npm run typecheck
npm test
npm run build
```

Beispiele:
```bash
cd jul-examples
for cfg in $(find . -name jul-config.yaml | sort); do
	d=$(dirname "$cfg")
	out=$(cd "$d" && node "../../jul-compiler/out/cli.js" jul-config.yaml 2>&1)
	echo "$(echo "$out" | grep -q successfully && echo OK || echo FAIL)  $d"
done
```

---

## Abhängigkeiten & Voraussetzungen

- ✅ `Error`-Typ existiert in core-lib.jul
- ✅ Union-Handling im Checker ist stabil
- ⚠️ Braucht Klarheit: wie wird `() => ...` parsed? (catchAll-Erkennung)

---

## Offene Fragen vor Start

1. **Wie wird ein leerer Branch (`()`) im AST dargestellt?**  
   Ist `params` gleich `empty`, oder ist das Binding leer?

2. **Ist bereits dokumentiert, wie man einen Branching-Typ vollständig auflöst?**  
   Brauchen wir `dereferenceType` auf dem `reference` zu `Error`?

3. **Bricht das Code, der schon geschrieben wurde?**  
   Falls Benutzer einen bestimmten Typ deklariert haben, der nicht `Error` enthält, aber ein unsicheres Branching davon zugewiesen wird?
   → Ja, das ist beabsichtigt (Sound Type System).
