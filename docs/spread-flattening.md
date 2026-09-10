# Spread-Flattening in List Literals

**Status:** Tests written (red), implementation pending.  
**Test Issues:** 
- `list-literal-spread-collapses-to-list`: Expects `List(Union(T, [a: Integer]))`
- `tuple-literal-spread-flattens-elements`: Expects `[Integer, Text, [a: Integer]]`

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

## Solution: Option C (Hybrid Flattening)

**Tuple-Spreads flatten** (known length explodes element-by-element):
```
[...myTuple [a=1]] → Tuple(elem1, elem2, [a: Integer])
```

**List-Spreads collapse to List** (unknown length preserved):
```
[...myList [a=1]] → List(Union(ListElementType, [a: Integer]))
```

**Result type rule:** If any spread is a List → outer is List; else Tuple (known length).

This matches TypeScript/Python behavior and preserves type precision.

## Implementation Plan

### Step 0: Before Benchmark
```bash
cd jul-compiler
npm run bench -- ../jul-examples --save --note "spread-flatten-start"
```

### Step 1: Refactor `case 'list'` in checker.ts

Current code uses `.map()` which expects 1 type per element. For Tuple flattening, we need multiple types per iteration.

**Refactor to for-loop:**
```typescript
const tupleElements: CompileTimeType[] = [];
for (const element of expression.values) {
    if (element.type === 'spread') {
        const sourceType = resolvePlaceholders(element.value.typeInfo!.type);
        if (sourceType.julType === 'tuple') {
            // Tuple-Spread: flatten elements into accumulator
            tupleElements.push(...sourceType.ElementTypes);
        } else if (sourceType.julType === 'list') {
            // List-Spread: add ElementType as single element (not the List)
            tupleElements.push(sourceType.ElementType);
        } else {
            // Other types: fallback to any
            tupleElements.push({ julType: 'any' });
        }
    } else {
        tupleElements.push(element.typeInfo!.type);
    }
}

// Decide Tuple vs List for outer type
const hasListSpread = expression.values.some(e => 
    e.type === 'spread' && resolvePlaceholders(e.value.typeInfo!.type).julType === 'list'
);

if (hasListSpread) {
    // Build union of all element types
    const elementTypes = tupleElements.map(t => /* resolve & unwrap */);
    const unionType = createNormalizedUnionType(elementTypes);
    const rawType = createCompileTimeListType(unionType);
} else {
    // All spreads are tuples (or no spreads) → result is Tuple
    const rawType = createCompileTimeTupleType(tupleElements);
}
```

### Step 2: Verify Tests Pass
```bash
npm test 2>&1 | grep -E "passing|failing"
```
Both red tests should turn green:
- `list-literal-spread-collapses-to-list`
- `tuple-literal-spread-flattens-elements`

### Step 3: Update Snapshot Baseline (if needed)
```bash
npm run typecheck
```

### Step 4: After Benchmark
```bash
npm run bench -- ../jul-examples --save --note "spread-flatten-end"
```
Verify performance is acceptable (alarm at 50% regression).

### Step 5: Build & Verify yugioh
```bash
npm run build-all-and-deploy
cd ../../yugioh
node ../JUL/jul-compiler/out/cli.js jul-config.yaml
# Verify "Missing field boards" error is gone
```

## Code Details

**Key locations:**
- Spread check: `checker.ts`, line ~1937 (in `case 'list'`)
- Already-checked spread source: `element.value.typeInfo!.type` (no need to re-check)
- Type resolution: `resolvePlaceholders()` handles parameterReferences and nested types

**No new types needed:** `CompileTimeListType` and `CompileTimeTupleType` already have `.ElementType` / `.ElementTypes` properties.

**Tuple element detection:** Use `sourceType.julType === 'tuple'` after `resolvePlaceholders()`.
