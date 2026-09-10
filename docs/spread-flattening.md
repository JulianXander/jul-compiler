# Spread-Flattening Implementation Plan

**Status:** Phase 1 COMPLETE ✅, Phase 2 IN PROGRESS 🔴

## Phase 1: List-Spread Flattening ✅ COMPLETE

### Tests
- ✅ `list-literal-spread-collapses-to-list` - PASSING
- ✅ `tuple-literal-spread-flattens-elements` - PASSING
- ✅ `branch-spread-binds-elements` - PASSING
- ✅ `spread-argument-is-not-discarded` - PASSING

### Implementation
- ✅ List literals now correctly flatten Tuple-Spreads
- ✅ List literals now correctly collapse List-Spreads to Union
- ✅ Benchmarked: -0% performance change (3433.64ms → 3425.68ms)
- ✅ All 204 tests passing

### How It Works
**Tuple-Spreads flatten** (known length explodes element-by-element):
```
[...myTuple [a=1]] → Tuple(elem1, elem2, [a: Integer])
```

**List-Spreads collapse to List** (unknown length preserved):
```
[...myList [a=1]] → List(Union(ListElementType, [a: Integer]))
```

---

## Phase 2: Dictionary-Spread Merging ✅ COMPLETE

### Tests (Now PASSING) ✅
- ✅ `dictionary-literal-spread-merges-fields` - PASSING
- ✅ `dictionary-type-spread-merges-fields` - PASSING

### Implementation Complete
- ✅ Dictionary-Literal spreads now merge fields correctly
- ✅ Dictionary-Type spreads work as expected
- ✅ All 206 tests passing

### Expected Behavior

**Dictionary-Literal Spreads** - merge fields into output:
```jul
T = [a: Integer b: Text]
f = (source: T) => [
    ...source
    c = Boolean true
]
// Expected return type: [a: Integer, b: Text, c: Boolean]
```

**Dictionary-Type Spreads** - merge type fields:
```jul
SourceType = [x: Integer y: Text]
TargetType = [x: Integer y: Text z: Boolean]
// Expected: TypeOf([x: Integer, y: Text, z: Boolean])
```

### Implementation Steps

**Step 1:** Fix dictionary spread handling in `case 'dictionary'` (line ~1614)
- Currently: `isDictionaryLiteralType(valueType)` only
- Needed: Also handle `dictionaryType` spreads

**Step 2:** Fix dictionary-type spread handling in `case 'dictionaryType'` (line ~1692)
- Currently: `TODO spread fields flach machen`
- Needed: Implement field merging

**Step 3:** Run tests
```bash
npm test 2>&1 | grep -E "passing|failing"
```

**Step 4:** Update snapshot baseline if needed
```bash
npm run bench -- --save --note "dictionary-spread-end"
```

---

## Real-World Impact

yugioh project (game-logic.jul:988):
```jul
newBoard: GameBoard = [
    ...board               # Dictionary spread - currently broken
    activatableGameCardIds = activatableGameCardIds
    pendingTriggers = [...]
]
```

Expected: Merges all fields from `board` + adds/overrides `activatableGameCardIds`
Current: Type becomes `Any` → cascades to "Missing field" errors

---

## Notes

- **Tuple vs List rule:** If ANY spread is a List → result is List; else Tuple
- **Union creation:** `resolvePlaceholders()` must be called on all elements before `createNormalizedUnionType()`
- **Stats tracking:** Each phase measures before/after to catch regressions

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
