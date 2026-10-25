import {
	builtinAny,
	builtinEmpty,
	builtinInvalid,
	builtinNever,
	CompileTimeType,
	createCompileTimeComplementType,
	createCompileTimeTupleType,
} from '../syntax-tree.js';
import { elementsEqual, last } from '../util.js';
import {
	createNormalizedIntersectionType,
	createNormalizedUnionType,
	isFunctionType,
	isParametersType,
	isSubtypeOf,
	resolveAlias,
	typeEquals,
	typesOverlap,
} from './type-algebra.js';

/**
 * Was die branches eines branchings abfangen, über alle Argumentstellen zugleich.
 *
 * Bei ?(a b) kommt immer ein Paar an. Mit a, b: Or(Integer Text) gibt es vier Sorten von Paaren,
 * eine Tabelle:
 *
 *                  b = Integer   b = Text
 *     a = Integer      ☐            ☐
 *     a = Text         ☐            ☐
 *
 * Jeder Kopf hakt Felder ab, die leeren Felder sind der Rest: was beim nächsten branch noch
 * ankommen kann. Nach [Integer Integer] ist nur das Feld oben links abgehakt. a kann im nächsten
 * branch also noch Integer sein, nämlich wenn b Text ist. Wer pro Stelle abzieht ("Integer ist
 * abgehakt, also ist a jetzt Text"), streicht die ganze Zeile und verengt falsch.
 *
 * Der Rest ist deshalb kein Typ je Stelle, sondern eine Liste von Boxen. Eine Box ist ein
 * Rechteck in der Tabelle: ein Typ je Stelle, und jede Kombination daraus gehört dazu. Der Rest
 * nach [Integer Integer] ist eine L-Form, zusammengesetzt aus zwei Rechtecken:
 *
 *     .  ☐      Box 1: a = Integer, b = Text
 *     ☐  ☐      Box 2: a = Text,    b = Or(Integer Text)
 *
 * Ein Kopf ist selbst eine Box (an den Stellen, die er nicht nennt, Any). Abziehen heißt, ihn aus
 * jeder Box des Rests herauszuschneiden. Was übrig bleibt, zerfällt wieder in Rechtecke:
 *
 *     A×B − C×D  =  (A−C)×B  ∪  (A∩C)×(B−D)
 *
 * Daraus folgen alle Fragen an ein branching:
 * - unerreichbar: Der Kopf überlappt keine Box des Rests.
 * - erschöpfend: Nach dem letzten Kopf ist der Rest leer.
 * - Verengung im branch: die Stelle i von Kopf ∩ Rest. Nach [Integer Integer] fängt
 *   [Integer Any] nur noch [Integer, Text], dort ist b also Text.
 *
 * Mehr als zwei Stellen machen aus der Tabelle einen Würfel, das Rechnen bleibt gleich. Die
 * Zeilen sind beliebige Typen, das Herausschneiden rechnet mit Schnitt und Komplement.
 *
 * Eine Box hat eine Stelle mehr als die Argumente, die letzte gilt für alle weiteren Stellen
 * (Empty bei geschriebenen Argumenten, Any hinter einer offenen Parameterliste). So bleibt ein
 * Kopf mit mehr Parametern als Argumenten vergleichbar: Er verlangt dort etwas, wo nur Empty
 * ankommt.
 *
 * Prädikate im Kopf (isEven) zählen in zwei Grenzen: Abgezogen wird nur, was er sicher fängt, und
 * erreichbar ist er, solange er etwas aus dem Rest vielleicht fängt. Derselbe Kopf zweimal ist
 * über die Identität erkannt: isEven ∩ Not(isEven) ist leer.
 */

//#region Typen

/** Ein Typ je Argumentstelle, der letzte gilt für alle weiteren Stellen. */
type Box = readonly CompileTimeType[];

/**
 * Eine Stelle einer Box des Rests: source ohne alles, was Köpfe dort schon abgezogen haben.
 * Normalisiert wird erst, wenn jemand den Typ braucht: Die Verengung liest die meisten Stellen
 * nie, und ein Schnitt mit dem Komplement einer wachsenden Union ist teuer.
 */
interface RestType {
	readonly source: CompileTimeType;
	readonly subtracted: readonly CompileTimeType[];
	/** Or(subtracted), erst beim ersten Bedarf gebildet */
	subtractedType?: CompileTimeType;
	/** And(source Not(Or(subtracted))), erst beim ersten Bedarf gebildet */
	normalizedType?: CompileTimeType;
}

type RestBox = readonly RestType[];

export interface BranchCoverage {
	/** Die Argumente vor dem ersten branch */
	readonly start: readonly RestBox[];
	/**
	 * Was nach den bisherigen branches noch ankommen kann.
	 * undefined: unbekannt, weil die Boxen über maxBoxCount gewachsen sind.
	 */
	readonly rest: readonly RestBox[] | undefined;
	/**
	 * false: Es gibt keine Argumente, die sich prüfen lassen. Erschöpfend ist das branching dann
	 * nur mit einem Kopf, der alles fängt.
	 */
	readonly checkable: boolean;
	/** Ein vorheriger branch fängt syntaktisch alles (() oder Any) */
	readonly afterCatchAll: boolean;
}

export interface BranchHead {
	readonly boxes: readonly Box[];
	/**
	 * false: Die Boxen sind nur eine Obermenge dessen, was der Kopf fängt (ein Kopf mit Fehler,
	 * eine Liste, ein Prädikat über die ganze Argumentkollektion). Er darf dann verengen, aber
	 * nichts abziehen.
	 */
	readonly exact: boolean;
	/**
	 * () oder Any als Kopf: fängt syntaktisch alles. Ein solcher branch am Ende ist der gewollte
	 * Rückfall und wird nicht als unerreichbar gemeldet, auch wenn die Köpfe davor schon alles
	 * fangen. Unerreichbar ist er nur hinter einem anderen catchAll.
	 */
	readonly isCatchAll: boolean;
}

export interface BranchStep {
	/**
	 * Der Kopf trifft beweisbar nichts mehr: Er überlappt keine Box des Rests. Auch ohne
	 * vorherigen branch, etwa ein zweistelliger Kopf bei ?([a b]).
	 */
	readonly unreachable: boolean;
	/** Der Rest, nachdem dieser Kopf abgefangen hat, was er sicher fängt */
	readonly coverage: BranchCoverage;
}

//#endregion Typen

/**
 * Jeder Schnitt kann eine Box in so viele zerlegen, wie die Box Stellen hat. Darüber gilt der
 * Rest als unbekannt: Kein branch ist dann unerreichbar, und das branching gilt als erschöpfend
 * (unbekannt heißt nicht bewiesen).
 */
const maxBoxCount = 64;

//#region Aufbau

/**
 * argsType: der Typ der Argumentkollektion. undefined: Es gibt keine Argumente, die sich prüfen
 * lassen.
 */
export function createBranchCoverage(argsType: CompileTimeType | undefined): BranchCoverage {
	const startBoxes = argsType
		? getCollectionBoxes(argsType).boxes
		: [[builtinAny]];
	const start = startBoxes.map(box => box.map(createRestType));
	return {
		start: start,
		rest: start,
		checkable: !!argsType,
		afterCatchAll: false,
	};
}

/**
 * possibleFunctionType: der Typ des branches. Was keine Funktion ist, ist schon gemeldet und
 * fängt nichts sicher.
 */
export function getBranchHeadOfFunction(possibleFunctionType: CompileTimeType | undefined): BranchHead {
	const functionType = possibleFunctionType && resolveAlias(possibleFunctionType);
	if (!isFunctionType(functionType)) {
		return unknownHead;
	}
	return getBranchHead(functionType.ParamsType);
}

/** paramsType: der Parametertyp des branches, eine Parameterliste oder ein Typ-Kopf */
export function getBranchHead(paramsType: CompileTimeType): BranchHead {
	const type = resolveAlias(paramsType);
	const isCatchAll = type.julType === 'any'
		|| (isParametersType(type) && !type.singleNames.length && !type.rest);
	return {
		...getCollectionBoxes(type),
		isCatchAll: isCatchAll,
	};
}

const unknownHead: BranchHead = {
	boxes: [[builtinAny]],
	exact: false,
	isCatchAll: false,
};

interface CollectionBoxes {
	readonly boxes: readonly Box[];
	/** false: Die Boxen sind eine Obermenge der Kollektion. */
	readonly exact: boolean;
}

/**
 * Die Boxen, die eine Kollektion beschreiben: die Argumente oder ein Kopf. Eine Stelle mit
 * gemeldetem Fehler (Invalid) sagt nichts über die Werte und zählt wie Any, aber nicht exakt.
 */
function getCollectionBoxes(rawType: CompileTimeType): CollectionBoxes {
	const collectionBoxes = getRawCollectionBoxes(rawType);
	let exact = collectionBoxes.exact;
	const boxes = collectionBoxes.boxes.map(box => {
		if (!box.some(isInvalidType)) {
			return box;
		}
		exact = false;
		return box.map(type => isInvalidType(type) ? builtinAny : type);
	});
	return {
		boxes: boxes,
		exact: exact,
	};
}

function getRawCollectionBoxes(rawType: CompileTimeType): CollectionBoxes {
	const type = resolveAlias(rawType);
	if (isParametersType(type)) {
		// Eine Parameterliste ist offen: Hinter ihren Parametern darf alles stehen.
		// Ohne Typ fängt ein Parameter alles.
		const prefix = type.singleNames.map(parameter => parameter.type ?? builtinAny);
		const rest = type.rest;
		if (!rest) {
			return {
				boxes: [[...prefix, builtinAny]],
				exact: true,
			};
		}
		const restBoxes = getRawCollectionBoxes(rest.type ?? builtinAny);
		return {
			boxes: restBoxes.boxes.map(restBox => [...prefix, ...restBox]),
			exact: restBoxes.exact,
		};
	}
	switch (type.julType) {
		case 'any':
			return {
				boxes: [[builtinAny]],
				exact: true,
			};
		case 'never':
			return {
				boxes: [],
				exact: true,
			};
		case 'empty':
			return {
				boxes: [[builtinEmpty]],
				exact: true,
			};
		case 'tuple':
			return {
				boxes: [[...type.ElementTypes, builtinEmpty]],
				exact: true,
			};
		case 'list':
			// Mindestens ein Element. Dahinter Element oder Empty, aber nicht in beliebiger
			// Reihenfolge: Die Box ist größer als die Liste.
			return {
				boxes: [[type.ElementType, createNormalizedUnionType([type.ElementType, builtinEmpty])]],
				exact: false,
			};
		case 'or': {
			const boxes: Box[] = [];
			let exact = true;
			for (const choiceType of type.ChoiceTypes) {
				const choiceBoxes = getRawCollectionBoxes(choiceType);
				boxes.push(...choiceBoxes.boxes);
				exact &&= choiceBoxes.exact;
			}
			return {
				boxes: boxes,
				exact: exact,
			};
		}
		default:
			// Dictionary (benannte Argumente), Prädikat über die Kollektion, Invalid: Über die
			// einzelnen Stellen ist nichts bekannt.
			return {
				boxes: [[builtinAny]],
				exact: false,
			};
	}
}

//#endregion Aufbau

//#region Abfragen

/**
 * Ein branch nach dem anderen, in der Reihenfolge von _branch. Unerreichbarkeit und Abziehen in
 * einem Durchgang, beide fragen je Paar aus Rest und Kopf, ob sie sich überlappen.
 */
export function applyBranchHead(coverage: BranchCoverage, head: BranchHead): BranchStep {
	const afterCatchAll = coverage.afterCatchAll || head.isCatchAll;
	const rest = coverage.rest;
	if (!rest) {
		return {
			unreachable: false,
			coverage: {
				...coverage,
				afterCatchAll: afterCatchAll,
			},
		};
	}
	// Solange alle Kopf-Boxen davor disjunkt waren, ist der Rest unverändert: Die
	// Unerreichbarkeit prüft also immer gegen den Rest vor diesem branch.
	let unreachable = !head.isCatchAll || coverage.afterCatchAll;
	let nextRest: readonly RestBox[] = rest;
	for (const headBox of head.boxes) {
		const subtractedRest: RestBox[] = [];
		for (const restBox of nextRest) {
			const [restTypes, headTypes] = widenBoxes(restBox, headBox);
			if (areBoxesDisjoint(restTypes, headTypes)) {
				subtractedRest.push(restBox);
				continue;
			}
			unreachable = false;
			if (!head.exact) {
				subtractedRest.push(restBox);
				continue;
			}
			subtractedRest.push(...subtractBox(restTypes, headTypes));
		}
		if (subtractedRest.length > maxBoxCount) {
			return {
				unreachable: false,
				coverage: {
					...coverage,
					rest: undefined,
					afterCatchAll: afterCatchAll,
				},
			};
		}
		nextRest = subtractedRest;
	}
	return {
		unreachable: unreachable,
		coverage: {
			...coverage,
			rest: nextRest,
			afterCatchAll: afterCatchAll,
		},
	};
}

/**
 * Ob kein Wert durchrutschen kann: Jede übrige Box ist an einer Stelle leer. Nicht erschöpfend
 * bringt Error in den Rückgabetyp, und das darf nur ein Beweis auslösen. Eine Stelle, deren Leere
 * sich nicht entscheiden lässt (Any als Argument), zählt deshalb als leer.
 */
export function isCoverageExhausted(coverage: BranchCoverage): boolean {
	const rest = coverage.rest;
	if (!rest) {
		return true;
	}
	return coverage.checkable
		? rest.every(restBox => restBox.some(isRestTypeEmpty))
		: !rest.length;
}

/**
 * Ob der Kopf an dieser Stelle verengen kann, ohne etwas zu berechnen: Er schränkt die Stelle ein,
 * oder vorherige Köpfe haben schon etwas abgezogen. Sonst bleibt der Typ dort wie er ist.
 */
export function mayNarrowAt(coverage: BranchCoverage, head: BranchHead, position: number): boolean {
	return coverage.rest !== coverage.start
		|| head.boxes.some(headBox => !isAnyType(getBoxType(headBox, position)));
}

/**
 * Der Typ des Arguments an dieser Stelle im branch: currentType geschnitten mit Kopf ∩ Rest an
 * dieser Stelle. currentType ist der Typ, den das Argument vor dem branching hat, und damit
 * schon die Quelle der Argument-Box.
 */
export function narrowArgumentType(
	coverage: BranchCoverage,
	head: BranchHead,
	position: number,
	currentType: CompileTimeType,
): CompileTimeType {
	const rest = coverage.rest;
	if (!rest) {
		// Der Rest ist unbekannt, sicher ist nur, was der Kopf verlangt.
		return intersect(currentType, createNormalizedUnionType(head.boxes.map(headBox => getBoxType(headBox, position))));
	}
	const narrowedTypes: CompileTimeType[] = [];
	for (const restBox of rest) {
		for (const headBox of head.boxes) {
			const [restTypes, headTypes] = widenBoxes(restBox, headBox);
			if (areBoxesDisjoint(restTypes, headTypes)) {
				continue;
			}
			const restType = getBoxType(restTypes, position);
			let narrowedType = intersect(currentType, getBoxType(headTypes, position));
			// Eine Quelle, die nicht die der Argumente ist, stammt aus dem Schnitt mit einem Kopf an
			// anderer Stelle.
			if (!coverage.start.some(startBox => getBoxType(startBox, position).source === restType.source)) {
				narrowedType = intersect(narrowedType, restType.source);
			}
			if (restType.subtracted.length) {
				narrowedType = createNormalizedIntersectionType([
					narrowedType,
					createNormalizedComplementType(getSubtractedType(restType)),
				]);
			}
			narrowedTypes.push(narrowedType);
		}
	}
	return createNormalizedUnionType(narrowedTypes);
}

//#endregion Abfragen

//#region Boxen

function getBoxType<Type>(box: readonly Type[], position: number): Type {
	return box[position] ?? last(box)!;
}

/** Beide Boxen gleich lang: Die letzte Stelle wird so oft wiederholt, wie es nötig ist. */
function widenBoxes(first: RestBox, second: Box): [RestBox, Box] {
	const length = Math.max(first.length, second.length);
	return [widenBox(first, length), widenBox(second, length)];
}

function widenBox<Type>(box: readonly Type[], length: number): readonly Type[] {
	if (box.length >= length) {
		return box;
	}
	const tail = last(box)!;
	const widened = box.slice(0, -1);
	while (widened.length < length) {
		widened.push(tail);
	}
	return widened;
}

/** Beide gleich lang */
function areBoxesDisjoint(restBox: RestBox, headBox: Box): boolean {
	return restBox.some((restType, index) => areTypesDisjoint(restType, headBox[index]!));
}

/**
 * restBox ohne headBox, als Liste von Boxen, beide gleich lang und nicht disjunkt. Stelle für
 * Stelle: Die Box, die an Stelle j aus dem Kopf fällt, hat davor die Schnitte mit dem Kopf und
 * dahinter den Rest unverändert. Wo der Kopf Any hat, fällt nichts heraus.
 */
function subtractBox(restBox: RestBox, headBox: Box): RestBox[] {
	let lastConstrainedIndex = headBox.length - 1;
	while (lastConstrainedIndex >= 0
		&& isAnyType(headBox[lastConstrainedIndex]!)) {
		lastConstrainedIndex--;
	}
	const pieces: RestBox[] = [];
	const prefix: RestType[] = [];
	for (let index = 0; index <= lastConstrainedIndex; index++) {
		const restType = restBox[index]!;
		const headType = headBox[index]!;
		if (isAnyType(headType)) {
			// Was Any abzieht, bleibt leer, und der Schnitt mit Any ist die Stelle selbst.
			prefix.push(restType);
			continue;
		}
		const missedType = subtract(restType, headType);
		if (missedType) {
			pieces.push([...prefix, missedType, ...restBox.slice(index + 1)]);
		}
		// Den Schnitt braucht erst eine spätere Stelle.
		if (index < lastConstrainedIndex) {
			prefix.push(createRestType(intersect(getNormalizedType(restType), headType)));
		}
	}
	return pieces;
}

//#endregion Boxen

//#region Typen je Stelle

function createRestType(source: CompileTimeType): RestType {
	return {
		source: source,
		subtracted: [],
	};
}

function getSubtractedType(restType: RestType): CompileTimeType {
	return restType.subtractedType ??= createNormalizedUnionType([...restType.subtracted]);
}

function getNormalizedType(restType: RestType): CompileTimeType {
	return restType.normalizedType ??= restType.subtracted.length
		? createNormalizedIntersectionType([
			restType.source,
			createNormalizedComplementType(getSubtractedType(restType)),
		])
		: restType.source;
}

/**
 * Beweisbar kein gemeinsamer Wert: Der Kopf überlappt die Quelle nicht, auch nicht mit allem, was
 * ein Prädikat im Kopf vielleicht fängt, oder die vorherigen Köpfe fangen schon alles davon ab
 * (derselbe Kopf über die Identität). Bei einem Prädikat entscheidet erst der Schnitt
 * (isEven ∩ Not(isEven) ist leer).
 */
function areTypesDisjoint(restType: RestType, headType: CompileTimeType): boolean {
	if (isAnyType(headType)) {
		return false;
	}
	const upperHeadType = getUpperBoundType(headType);
	if (typesOverlap(restType.source, upperHeadType) === false) {
		return true;
	}
	if (restType.subtracted.length
		&& (restType.subtracted.some(subtractedType => typeEquals(subtractedType, headType))
			|| isSubtypeOf(upperHeadType, getLowerBoundType(getSubtractedType(restType))) === true)) {
		return true;
	}
	if (upperHeadType === headType) {
		return false;
	}
	return isNeverType(createNormalizedIntersectionType([getNormalizedType(restType), headType]));
}

/** Was der Kopf an dieser Stelle nicht sicher fängt. undefined: nichts. */
function subtract(restType: RestType, headType: CompileTimeType): RestType | undefined {
	if (isSubtypeOf(restType.source, getLowerBoundType(headType)) === true) {
		return undefined;
	}
	return {
		source: restType.source,
		subtracted: [...restType.subtracted, headType],
	};
}

/**
 * Ob die Stelle beweisbar keinen Wert mehr hat: Die abgezogenen Köpfe fangen die Quelle sicher
 * ab, oder es bleibt nach dem Abziehen nichts übrig. Dort greift die Identität, sodass isEven im
 * Kopf den isEven-Anteil des Arguments abdeckt. Unbekannt zählt als leer.
 */
function isRestTypeEmpty(restType: RestType): boolean {
	if (!restType.subtracted.length) {
		return isNeverType(restType.source);
	}
	return isSubtypeOf(restType.source, getLowerBoundType(getSubtractedType(restType))) !== false
		|| isNeverType(getNormalizedType(restType));
}

function intersect(type: CompileTimeType, headType: CompileTimeType): CompileTimeType {
	if (isAnyType(headType)) {
		return type;
	}
	return createNormalizedIntersectionType([type, headType]);
}

function isAnyType(type: CompileTimeType): boolean {
	return resolveAlias(type).julType === 'any';
}

function isInvalidType(type: CompileTimeType): boolean {
	return resolveAlias(type).julType === 'invalid';
}

function isNeverType(type: CompileTimeType): boolean {
	return resolveAlias(type).julType === 'never';
}

/**
 * Höchstens diese Werte liegen im Typ: ein Prädikat zählt mit seiner Obermenge, unter Not mit
 * seiner Untermenge. Für die Frage "könnte der Wert hier liegen".
 */
function getUpperBoundType(type: CompileTimeType): CompileTimeType {
	return mapBoundType(type, true);
}

/**
 * Mindestens diese Werte liegen im Typ: ein Prädikat zählt nur mit dem, wofür es nachweislich
 * true liefert. Für die Frage "fängt dieser Kopf den Wert sicher ab".
 */
function getLowerBoundType(type: CompileTimeType): CompileTimeType {
	return mapBoundType(type, false);
}

function mapBoundType(rawType: CompileTimeType, upper: boolean): CompileTimeType {
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'predicate':
			return upper
				? type.UpperBound
				: type.LowerBound;
		case 'not': {
			const source = mapBoundType(type.SourceType, !upper);
			return source === type.SourceType
				? type
				: createNormalizedComplementType(source);
		}
		case 'or':
		case 'and': {
			const choices = type.ChoiceTypes.map(choice => mapBoundType(choice, upper));
			if (elementsEqual(choices, type.ChoiceTypes)) {
				return type;
			}
			return type.julType === 'or'
				? createNormalizedUnionType(choices)
				: createNormalizedIntersectionType(choices);
		}
		case 'tuple': {
			const elements = type.ElementTypes.map(element => mapBoundType(element, upper));
			return elementsEqual(elements, type.ElementTypes)
				? type
				: createCompileTimeTupleType(elements);
		}
		default:
			return type;
	}
}

/**
 * Not mit den Randfällen, die als Quelle sonst permissiv blieben: Not(Never) ist alles,
 * Not(Any) nichts, Not(Invalid) bleibt ungültig.
 */
function createNormalizedComplementType(source: CompileTimeType): CompileTimeType {
	const resolved = resolveAlias(source);
	switch (resolved.julType) {
		case 'never':
			return builtinAny;
		case 'any':
			return builtinNever;
		case 'invalid':
			return builtinInvalid;
		default:
			return createCompileTimeComplementType(source);
	}
}

//#endregion Typen je Stelle
