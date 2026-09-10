# Spread-Flattening in List Literals

**Status:** Red test created (2026-09-10), implementation pending.  
**Issue:** [list-literal-spread-loses-element-type](../src/checker/checker.test.ts)

## Problem

List literals with Spread elements degrade element types to `Any`, losing type information from the spread source.

```jul
values = [1 2 3]                    // List(Integer)
result = [...values [a = 1]]        // Expected: List(Union(Integer, [a: Integer]))
                                    // Actual:   Tuple(Any, dictionaryLiteral)
```

In yugioh (game-logic.jul:988), this cascades to field type errors:

```jul
activatableGameCardIds = [...board/hand ...board/spellTraps board/field]
// loses List(Integer), becomes Tuple(Any, Any, Or(Empty Integer))
// causes "Missing field boards" on newGameState
```

## Root Cause

**Location:** `checker.ts`, `case 'list'` (line ~1937)

```typescript
if (element.type === 'spread') {
    // TODO flatten spread tuple value type
    return { julType: 'any' };  // ❌ All type info lost
}
```

The checker encounters a spread element but returns `Any` instead of:
1. Resolving the spread source type
2. Detecting whether it's a Tuple or List
3. Extracting/flattening its element types

## Algorithm (to be clarified)

### Step 0: Before Benchmark
```bash
cd jul-compiler
npm run bench -- ../jul-examples --save --note "spread-flatten-start"
```

### Step 1: Resolve Spread Source Type
```typescript
const sourceType = resolvePlaceholders(
    checkExpression(element.value, scope),  // element.value is AST node
    scope
);
```

Need to clarify: Is `element.value` already an expression, or does it need wrapping?

### Step 2: Branch on Collection Type

**If Tuple:** Flatten directly into accumulator (unknown: element-by-element or whole?)  
**If List:** Extract element type and return it (unknown: return bare elementType or wrap in List?)  
**If neither:** Emit error or fallback to `Any`

### Step 3: Integrate into List Assembly
Current flow accumulates elements:
```typescript
const elements: CompileTimeType[] = [];
for (const element of list.items) {
    const itemType = checkListElement(element, scope);  // ← our fix goes here
    elements.push(itemType);
}
// Assembly logic below
```

After spread flattening, `itemType` for spread elements should provide flattened types (or multiple types for Tuple).

### Step 4: Full Test Suite + Red Test Green
```bash
npm test
```
Red test `list-literal-spread-loses-element-type` should pass.

### Step 5: Update Snapshot Baseline
If type error text changes:
```bash
npm run typecheck
npx mocha --import=tsx --require ./test-setup.mjs src/checker/checker.test.ts --grep "snapshot"
```

### Step 6: After Benchmark
```bash
npm run bench -- ../jul-examples --save --note "spread-flatten-end"
```
Compare with before (alarm threshold: 50% regression).

### Step 7: Build & Verify yugioh
```bash
npm run build-all-and-deploy
cd ../../yugioh
node ../JUL/jul-compiler/out/cli.js jul-config.yaml
# Verify no "Missing field boards" error
```

## Open Questions

1. **Tuple element handling:**
   - `[...myTuple [a=1]]` → spread elements go at beginning or end?
   - Return flattened Tuple type, or push individual types into accumulator?

2. **List element return type:**
   - `[...myList [a=1]]` where `myList` is `List(Integer)` →
   - Return bare `Integer` and let outer logic build `List(Union(Integer, [a: 1]))`?
   - Or return `List(Integer)` and let outer degrade/union?

3. **checkExpression + resolvePlaceholders:**
   - `element.value` is already a checked expression in the AST?
   - Or need to call `checkExpression(element.value, scope)` first?
   - Pattern from `case 'dictionary'` Spread handling?

## Implementation Pattern (to verify)

From analogous Spread fix in dictionary literals:
- Call `checkExpression()` on spread source
- Call `resolvePlaceholders()` on result
- Inspect `.julType` and `.singleTypes` / `.elementType`
- Flatten or extract accordingly

See `case 'dictionary'` in checker.ts for reference pattern.
