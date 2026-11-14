import { builtinAny, builtinEmpty, builtinInteger, createCompileTimeComplementType, createCompileTimeDictionaryLiteralType } from '../src/syntax-tree.js';
import { createNormalizedIntersectionType, createNormalizedUnionType, dereferenceNameFromObject, typeToString } from '../src/checker/type-algebra.js';
const s = (t: any) => t ? typeToString(t, 0, 3) : String(t);
// Fall 1: pair: Or([] Pair), pair/inner ist Empty
const pair = createCompileTimeDictionaryLiteralType({ inner: { type: createNormalizedUnionType([builtinEmpty, builtinInteger]), optional: false } }, true);
const pairOrEmpty = createNormalizedUnionType([builtinEmpty, pair]);
const fact1 = createNormalizedUnionType([builtinEmpty, createCompileTimeDictionaryLiteralType({ inner: { type: builtinEmpty, optional: true } }, false)]);
console.log('fact1', s(fact1));
console.log('pair ∩ fact1', s(createNormalizedIntersectionType([pairOrEmpty, fact1])));
// Fall 2: Any-Quelle, s/index ist Not(Integer)
const notInt = createCompileTimeComplementType(builtinInteger);
const fact2 = createNormalizedUnionType([builtinEmpty, createCompileTimeDictionaryLiteralType({ index: { type: notInt, optional: true } }, false)]);
const any2 = createNormalizedIntersectionType([builtinAny, fact2]);
console.log('any ∩ fact2', s(any2));
console.log('deref boards', s(dereferenceNameFromObject('boards', any2 as any)));
const dict2 = createCompileTimeDictionaryLiteralType({ index: { type: notInt, optional: true } }, false);
console.log('deref boards (nur dict)', s(dereferenceNameFromObject('boards', dict2 as any)));
