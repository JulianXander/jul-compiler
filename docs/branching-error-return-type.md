# Branching ohne catchAll: Error-Handling im Rückgabetyp

## Entscheidung

**Option A ist entschieden:** Hat ein Branching keinen catchAll-Branch (weder `()` noch `Any`),
wird `Error` automatisch Teil der Rückgabetyp-Union. Begründung: Prinzipien Freiheit und
Einheitlichkeit in [design-principles.md](design-principles.md), siehe dortige Beispiele zu
branching ohne catchAll. Umsetzung siehe [Umsetzungsplan](#umsetzungsplan).

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

## Umbau durch die Entscheidung

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

Das ist ein **umfassender Typ-Struktur-Umbau**, der überall durchgreift. Der Compiler-Code ist trivial, aber die Migration ist groß. Nach dem Endzustand-Prinzip ist das kein Gegenargument, solange das Design das richtige ist.

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

Performance (Checker-Umbau, siehe CLAUDE.md "Wann messen"): vor dem Umbau und danach je einmal
mit `--save` messen, sonst lässt sich ein Sprung später keinem der beiden Schritte mehr zuordnen.

```bash
cd jul-compiler
npm run bench -- --save --note "vor Error-in-Branching-Return-Type"
# ... Implementierung ...
npm run bench -- --save --note "nach Error-in-Branching-Return-Type"
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
