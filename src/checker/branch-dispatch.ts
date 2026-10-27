import {
	CompileTimeType,
	ParseBranching,
	ParseValueExpression,
	getOwnField,
} from '../syntax-tree.js';
import { isFunctionType, isParametersType, isSubtypeOf, resolveAlias, resolvePlaceholders } from './type-algebra.js';

/**
 * Welcher Test zur Laufzeit reicht, um die branches eines branchings auseinanderzuhalten.
 * Der Emitter vertraut dabei dem statischen Typ des gebranchten Werts: geprüft wird nicht, ob der
 * Wert seinen Typ erfüllt, sondern nur, welcher der laut Typ möglichen Fälle vorliegt.
 * Wird vom Emitter aufgerufen, nicht vom Checker: der Language Server zahlt dafür nichts.
 * Siehe docs/typed-emission.md.
 */

//#region Typen

/**
 * Laufzeitarten, wie getTypeError in runtime.ts sie unterscheidet. object umfasst alles, was
 * sich nicht billig abgrenzen lässt: Dictionary, Fraction, Stream, Typwerte.
 */
export type JsKind =
	| 'undefined'
	| 'boolean'
	| 'bigint'
	| 'number'
	| 'string'
	| 'function'
	| 'array'
	| 'date'
	| 'blob'
	| 'error'
	| 'object'
	;

export type BranchTest =
	/** Der Branch fängt alles, was an dieser Stelle noch möglich ist. */
	| { kind: 'always'; }
	/** Der Branch fängt nichts mehr von dem, was noch möglich ist, und wird nicht emittiert. */
	| { kind: 'never'; }
	/** Der Wert gehört zu einer der Laufzeitarten (negated: zu keiner). */
	| { kind: 'jsKind'; kinds: JsKind[]; negated: boolean; }
	| { kind: 'literal'; value: LiteralValue; }
	/** Der Wert ist gleich einem der Werte (undefined steht für Empty). */
	| { kind: 'literals'; values: Array<LiteralValue | undefined>; }
	/** Ein Feld mit Literaltyp unterscheidet die Glieder. */
	| { kind: 'field'; name: string; value: LiteralValue; }
	/**
	 * Der Wert liegt jenseits einer Literal-Grenze. guarded: Nicht jedes Glied hat die Laufzeitart der
	 * Grenze, vor dem Vergleich wird sie geprüft.
	 */
	| { kind: 'bound'; relation: 'greater' | 'less'; value: LiteralValue; jsKind: 'bigint' | 'number'; guarded: boolean; }
	;

export type LiteralValue = bigint | string | boolean | number;

export interface BranchDispatch {
	/** Ein Test je emittiertem branch. Nach einem always folgt keiner mehr. */
	tests: BranchTest[];
	/** false: nach dem letzten Test bleiben Werte übrig, die keinen branch treffen */
	exhaustive: boolean;
}

/** Was ein branch vom Argument verlangt */
type BranchRequirement =
	| { kind: 'catchAll'; }
	| { kind: 'type'; type: CompileTimeType; }
	;

//#endregion Typen

/**
 * undefined: die Typen geben keinen billigeren Test her als den vollen Check, oder das branching
 * liegt außerhalb dessen, was hier behandelt wird. Der Emitter bleibt dann bei _branch.
 */
export function getBranchDispatch(branching: ParseBranching): BranchDispatch | undefined {
	const argument = getSingleArgument(branching);
	const argumentType = argument?.typeInfo && resolvePlaceholders(argument.typeInfo.type);
	if (!argumentType) {
		return undefined;
	}
	let remaining = getMembers(argumentType);
	if (!remaining) {
		return undefined;
	}
	const tests: BranchTest[] = [];
	for (const branch of branching.branches) {
		if (!remaining.length) {
			// Alles ist schon abgefangen, der Rest ist unerreichbar.
			return { tests: tests, exhaustive: true };
		}
		const requirement = getBranchRequirement(branch);
		if (!requirement) {
			return undefined;
		}
		if (requirement.kind === 'catchAll') {
			tests.push({ kind: 'always' });
			return { tests: tests, exhaustive: true };
		}
		const step = getBranchStep(remaining, requirement.type);
		if (!step) {
			return undefined;
		}
		if (!step.remaining.length) {
			// Der branch fängt jeden noch möglichen Wert, auch wenn sein Test das allein nicht
			// sagt (letztes Literal einer Literal-Union): dann braucht es keinen Test mehr.
			tests.push({ kind: 'always' });
			return { tests: tests, exhaustive: true };
		}
		tests.push(step.test);
		if (step.test.kind === 'always') {
			return { tests: tests, exhaustive: true };
		}
		remaining = step.remaining;
	}
	return {
		tests: tests,
		exhaustive: !remaining.length,
	};
}

/** Nur ?(x): ein geschriebenes Argument, kein Spread. */
function getSingleArgument(branching: ParseBranching): ParseValueExpression | undefined {
	const args = branching.args;
	if (args?.type !== 'list'
		|| args.values.length !== 1) {
		return undefined;
	}
	const value = args.values[0]!;
	return value.type === 'spread'
		? undefined
		: value;
}

/**
 * Nur Funktionsliterale mit Typ-Kopf über genau ein Element ([T] =>, Any =>) oder mit höchstens
 * einem Parameter ohne rest. Ein Funktionswert in Typ-Position ist ein Prädikat, das die Laufzeit
 * aufrufen muss - dafür gibt es keinen billigeren Test.
 */
function getBranchRequirement(branch: ParseValueExpression): BranchRequirement | undefined {
	if (branch.type !== 'functionLiteral'
		|| !branch.typeInfo) {
		return undefined;
	}
	const functionType = resolveAlias(branch.typeInfo.type);
	if (!isFunctionType(functionType)) {
		return undefined;
	}
	const paramsType = resolveAlias(functionType.ParamsType);
	if (isParametersType(paramsType)) {
		if (paramsType.rest
			|| paramsType.singleNames.length > 1) {
			return undefined;
		}
		const parameterType = paramsType.singleNames[0]?.type;
		return getRequirementForType(parameterType && resolveAlias(parameterType));
	}
	if (paramsType.julType === 'any') {
		return { kind: 'catchAll' };
	}
	if (paramsType.julType !== 'tuple'
		|| paramsType.ElementTypes.length !== 1) {
		return undefined;
	}
	return getRequirementForType(resolveAlias(paramsType.ElementTypes[0]!));
}

function getRequirementForType(type: CompileTimeType | undefined): BranchRequirement | undefined {
	if (!type
		|| type.julType === 'any') {
		return { kind: 'catchAll' };
	}
	if (isFunctionType(type)) {
		return undefined;
	}
	return { kind: 'type', type: type };
}

//#region Schritt je branch

type BranchStep = { test: BranchTest; remaining: CompileTimeType[]; };

/**
 * Teilt die noch möglichen Glieder in die, die der branch sicher fängt, und die, die er sicher
 * nicht fängt. Bleibt ein Glied unentschieden, gibt es keinen exakten billigen Test.
 * Erst der Test nach Laufzeitart bzw. Feld, dann der Vergleich mit einer Grenze, sonst (Kopf ist eine Union
 * aus Einzelwerten) der Vergleich mit den Werten. Die Art zuerst: Bei Or([] PositiveInteger) mit Kopf
 * PositiveInteger reicht x !== undefined, der Vergleich wäre überflüssig.
 */
function getBranchStep(
	remaining: CompileTimeType[],
	required: CompileTimeType,
): BranchStep | undefined {
	return getKindStep(remaining, required)
		?? getBoundStep(remaining, required)
		?? getSingletonStep(remaining, required);
}

/**
 * Der Kopf ist ein Grenztyp mit Literal-Grenze (GreaterInteger(1)): Der Vergleich entscheidet jeden Wert
 * exakt, so wie getTypeError in runtime.ts. Eine Grenze, die erst zur Laufzeit feststeht
 * (GreaterInteger(count)), hat keinen Literalwert und bleibt beim vollen Check.
 */
function getBoundStep(
	remaining: CompileTimeType[],
	required: CompileTimeType,
): BranchStep | undefined {
	if (required.julType !== 'bound') {
		return undefined;
	}
	const value = getLiteralValue(resolveAlias(required.Value));
	if (value === undefined) {
		return undefined;
	}
	const jsKind = required.Family === 'integer'
		? 'bigint'
		: 'number';
	// Ohne Test der Art wäre der Vergleich falsch: §5§ > 1n ist in JS true.
	const guarded = remaining.some(member => getMemberKind(member) !== jsKind);
	return {
		test: { kind: 'bound', relation: required.Relation, value: value, jsKind: jsKind, guarded: guarded },
		// Wie beim Literal: Der Test ist für jeden Wert exakt, der Rest darf zu groß bleiben.
		remaining: remaining.filter(member => isSubtypeOf(member, required) !== true),
	};
}

/**
 * Der Kopf ist eine Union aus Einzelwerten (Literale, Empty): Ein Literal-Glied ist gefangen, wenn sein Wert
 * dazugehört, sonst sicher verfehlt, auch bei gleicher Laufzeitart. Ein Glied, das kein Einzelwert ist
 * (Text, Integer), mit derselben Laufzeitart wie der Kopf lässt sich nicht entscheiden: Rückfall.
 */
function getSingletonStep(
	remaining: CompileTimeType[],
	required: CompileTimeType,
): BranchStep | undefined {
	const requiredValues = getSingletonValues(required);
	const requiredKinds = getJsKinds(required);
	if (!requiredValues
		|| !requiredKinds) {
		return undefined;
	}
	const caughtValues: Array<LiteralValue | undefined> = [];
	const missed: CompileTimeType[] = [];
	for (const member of remaining) {
		const memberValues = getSingletonValues(member);
		if (memberValues?.length === 1) {
			const memberValue = memberValues[0];
			if (requiredValues.includes(memberValue)) {
				if (!caughtValues.includes(memberValue)) {
					caughtValues.push(memberValue);
				}
			}
			else {
				missed.push(member);
			}
			continue;
		}
		const memberKind = getMemberKind(member);
		if (!memberKind
			|| requiredKinds.has(memberKind)) {
			return undefined;
		}
		missed.push(member);
	}
	if (!missed.length) {
		return {
			test: { kind: 'always' },
			remaining: [],
		};
	}
	if (!caughtValues.length) {
		return {
			test: { kind: 'never' },
			remaining: missed,
		};
	}
	return {
		test: { kind: 'literals', values: caughtValues },
		remaining: missed,
	};
}

function getKindStep(
	remaining: CompileTimeType[],
	required: CompileTimeType,
): BranchStep | undefined {
	const literal = getLiteralValue(required);
	if (literal !== undefined) {
		// x === literal ist für jeden Wert exakt. Der Rest bleibt bewusst zu groß (Integer statt
		// Integer ohne 1): ein Test, der auf der Obermenge exakt ist, ist es auch auf dem Rest.
		return {
			test: { kind: 'literal', value: literal },
			remaining: remaining.filter(member => isSubtypeOf(member, required) !== true),
		};
	}
	const requiredKinds = getJsKinds(required);
	if (!requiredKinds) {
		return undefined;
	}
	const caught: CompileTimeType[] = [];
	const missed: CompileTimeType[] = [];
	let undecided = false;
	for (const member of remaining) {
		const memberKind = getMemberKind(member);
		if (!memberKind) {
			return undefined;
		}
		if (!requiredKinds.has(memberKind)) {
			missed.push(member);
		}
		else if (isSubtypeOf(member, required) === true) {
			caught.push(member);
		}
		else {
			undecided = true;
			missed.push(member);
		}
	}
	if (!missed.length) {
		return {
			test: { kind: 'always' },
			remaining: [],
		};
	}
	if (!caught.length
		&& !undecided) {
		return {
			test: { kind: 'never' },
			remaining: missed,
		};
	}
	if (!undecided) {
		const kindTest = getKindTest(caught, missed);
		if (kindTest) {
			return {
				test: kindTest,
				remaining: missed,
			};
		}
	}
	const fieldTest = getFieldTest(remaining, required);
	return fieldTest && {
		test: fieldTest,
		remaining: remaining.filter(member => isSubtypeOf(member, required) !== true),
	};
}

/**
 * Getestet wird die billigere Seite: die gefangenen Arten direkt oder die verfehlten negiert.
 * object hat keinen exakten Einzeltest (auch Array, Date, Error sind Objekte), die Seite mit
 * object scheidet deshalb aus.
 */
function getKindTest(caught: CompileTimeType[], missed: CompileTimeType[]): BranchTest | undefined {
	const caughtKinds = new Set(caught.map(member => getMemberKind(member)!));
	const missedKinds = new Set(missed.map(member => getMemberKind(member)!));
	for (const kind of caughtKinds) {
		if (missedKinds.has(kind)) {
			return undefined;
		}
	}
	const caughtCost = getKindsCost(caughtKinds);
	const missedCost = getKindsCost(missedKinds);
	if (caughtCost === undefined
		&& missedCost === undefined) {
		return undefined;
	}
	// Gleichstand: die gefangene Seite, das liest sich wie der branch selbst.
	if (missedCost === undefined
		|| (caughtCost !== undefined && caughtCost <= missedCost)) {
		return { kind: 'jsKind', kinds: [...caughtKinds], negated: false };
	}
	return { kind: 'jsKind', kinds: [...missedKinds], negated: true };
}

/** undefined: object ist dabei, es gibt keinen exakten Test */
function getKindsCost(kinds: Set<JsKind>): number | undefined {
	let cost = 0;
	for (const kind of kinds) {
		switch (kind) {
			case 'undefined':
				break;
			case 'boolean':
			case 'bigint':
			case 'number':
			case 'string':
			case 'function':
				cost += 1;
				break;
			case 'array':
			case 'date':
			case 'blob':
			case 'error':
				cost += 2;
				break;
			case 'object':
				return undefined;
		}
	}
	return cost;
}

/**
 * Sind alle noch möglichen Glieder Dictionaries, reicht ein Feld, das der branch mit einem
 * Literal fordert und das jedes Glied als Literal festlegt: gleich heißt gefangen, sofern das
 * Glied den branch-Typ ganz erfüllt, verschieden heißt verfehlt.
 */
function getFieldTest(remaining: CompileTimeType[], required: CompileTimeType): BranchTest | undefined {
	if (required.julType !== 'dictionaryLiteral') {
		return undefined;
	}
	const members = remaining.map(member => resolveAlias(member));
	if (members.some(member => member.julType !== 'dictionaryLiteral')) {
		return undefined;
	}
	for (const [name, rawFieldType] of Object.entries(required.FieldTypes)) {
		const requiredValue = getLiteralValue(resolveAlias(rawFieldType));
		if (requiredValue === undefined) {
			continue;
		}
		const decides = members.every(member => {
			const memberFieldType = member.julType === 'dictionaryLiteral'
				? getOwnField(member.FieldTypes, name)
				: undefined;
			const memberValue = memberFieldType && getLiteralValue(resolveAlias(memberFieldType));
			if (memberValue === undefined) {
				return false;
			}
			return memberValue !== requiredValue
				|| isSubtypeOf(member, required) === true;
		});
		if (decides) {
			return { kind: 'field', name: name, value: requiredValue };
		}
	}
	return undefined;
}

//#endregion Schritt je branch

//#region Typ-Helfer

/**
 * Die Glieder eines Or, Aliase aufgelöst, Never entfernt. undefined, wenn ein Glied nicht
 * belastbar ist: mit Any irgendwo darin ist die Teilmengenprüfung des Checkers permissiv
 * ([a: Any] gilt als Teilmenge von [a: Integer]), ein darauf gebauter Test wäre falsch.
 */
function getMembers(type: CompileTimeType): CompileTimeType[] | undefined {
	const resolved = resolveAlias(type);
	switch (resolved.julType) {
		case 'never':
			return [];
		case 'or': {
			const members: CompileTimeType[] = [];
			for (const choiceType of resolved.ChoiceTypes) {
				const choiceMembers = getMembers(choiceType);
				if (!choiceMembers) {
					return undefined;
				}
				members.push(...choiceMembers);
			}
			return members;
		}
		default:
			return getMemberKind(resolved) && !containsAny(resolved, new Set())
				? [resolved]
				: undefined;
	}
}

function containsAny(type: CompileTimeType, visitedAliases: Set<CompileTimeType>): boolean {
	switch (type.julType) {
		case 'any':
			return true;
		case 'alias':
			if (visitedAliases.has(type)) {
				return false;
			}
			visitedAliases.add(type);
			return containsAny(resolveAlias(type), visitedAliases);
		case 'never':
		case 'empty':
		case 'boolean':
		case 'booleanLiteral':
		case 'integer':
		case 'integerLiteral':
		case 'float':
		case 'floatLiteral':
		case 'text':
		case 'textLiteral':
		case 'date':
		case 'blob':
		case 'error':
			return false;
		case 'list':
		case 'dictionary':
			return containsAny(type.ElementType, visitedAliases);
		case 'tuple':
			return type.ElementTypes.some(elementType => containsAny(elementType, visitedAliases));
		case 'dictionaryLiteral':
			return Object.values(type.FieldTypes).some(fieldType => containsAny(fieldType, visitedAliases));
		case 'stream':
			return containsAny(type.ValueType, visitedAliases);
		case 'bound':
			// Die Grenze ist ein Wert, den der Dispatch nie auswertet. Ein unbekannter Wert (Platzhalter) bleibt unbrauchbar.
			return containsAny(type.Value, visitedAliases);
		case 'or':
		case 'and':
			return type.ChoiceTypes.some(choiceType => containsAny(choiceType, visitedAliases));
		default:
			// Unbekanntes zählt wie Any: lieber der volle Check als ein falscher Test.
			return true;
	}
}

/** Die Laufzeitart eines einzelnen Glieds, undefined wenn sie sich nicht festlegen lässt */
function getMemberKind(type: CompileTimeType): JsKind | undefined {
	const kinds = getJsKinds(type);
	if (kinds?.size !== 1) {
		return undefined;
	}
	return [...kinds][0];
}

/** Die Laufzeitarten, die ein Wert dieses Typs haben kann. undefined = nicht bestimmbar. */
function getJsKinds(type: CompileTimeType): Set<JsKind> | undefined {
	const resolved = resolveAlias(type);
	switch (resolved.julType) {
		case 'never':
			return new Set();
		case 'empty':
			return new Set(['undefined']);
		case 'boolean':
		case 'booleanLiteral':
			return new Set(['boolean']);
		case 'integer':
		case 'integerLiteral':
			return new Set(['bigint']);
		case 'float':
		case 'floatLiteral':
			return new Set(['number']);
		case 'bound':
			// Wie integer bzw. float: die Grenze schränkt die Werte ein, nicht die Laufzeitart.
			// Ob ein Wert innerhalb der Grenze liegt, kann nur isSubtypeOf (statisch) entscheiden.
			return new Set([resolved.Family === 'integer' ? 'bigint' : 'number']);
		case 'text':
		case 'textLiteral':
			return new Set(['string']);
		case 'function':
			return new Set(['function']);
		case 'list':
		case 'tuple':
			return new Set(['array']);
		case 'date':
			return new Set(['date']);
		case 'blob':
			return new Set(['blob']);
		case 'error':
			return new Set(['error']);
		case 'dictionary':
		case 'dictionaryLiteral':
		case 'stream':
			return new Set(['object']);
		case 'or': {
			const kinds = new Set<JsKind>();
			for (const choiceType of resolved.ChoiceTypes) {
				const choiceKinds = getJsKinds(choiceType);
				if (!choiceKinds) {
					return undefined;
				}
				choiceKinds.forEach(kind => kinds.add(kind));
			}
			return kinds;
		}
		default:
			return undefined;
	}
}

/**
 * Die Einzelwerte eines Typs, der nur aus Literalen und Empty besteht (undefined steht für Empty).
 * undefined, wenn irgendein Glied mehr als ein Wert sein kann.
 */
function getSingletonValues(type: CompileTimeType): Array<LiteralValue | undefined> | undefined {
	const resolved = resolveAlias(type);
	if (resolved.julType === 'empty') {
		return [undefined];
	}
	const literal = getLiteralValue(resolved);
	if (literal !== undefined) {
		return [literal];
	}
	if (resolved.julType !== 'or') {
		return undefined;
	}
	const values: Array<LiteralValue | undefined> = [];
	for (const choiceType of resolved.ChoiceTypes) {
		const choiceValues = getSingletonValues(choiceType);
		if (!choiceValues) {
			return undefined;
		}
		values.push(...choiceValues);
	}
	return values;
}

function getLiteralValue(type: CompileTimeType): LiteralValue | undefined {
	switch (type.julType) {
		case 'booleanLiteral':
		case 'integerLiteral':
		case 'floatLiteral':
		case 'textLiteral':
			return type.value;
		default:
			return undefined;
	}
}


//#endregion Typ-Helfer
