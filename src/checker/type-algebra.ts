import * as runtime from '../runtime/runtime.js';
import { tryBuildCallable, typeToConstantValue } from './constant-folding.js';
import { CompileTimeAliasType, CompileTimeBoundType, CompileTimeCollection, CompileTimeComplementType, CompileTimeDictionary, CompileTimeDictionaryLiteralType, CompileTimeDictionaryType, CompileTimeFunctionType, CompileTimeIndexRangeType, CompileTimeListType, CompileTimePredicateType, CompileTimeStreamType, CompileTimeTupleType, CompileTimeType, CompileTimeTypeOfType, CompileTimeUnionType, ConditionalTypeBranch, Parameter, ParameterReference, ParametersType, ResolvedType, TextLiteralType, TypePurity, builtinAny, builtinBoolean, builtinEmpty, builtinInteger, builtinNever, createBooleanLiteral, createCompileTimeAddType, createCompileTimeAliasType, createCompileTimeBoundType, createCompileTimeComplementType, createCompileTimeConcatType, createCompileTimeConditionalType, createCompileTimeDictionaryLiteralType, createCompileTimeDictionaryType, createCompileTimeFunctionType, createCompileTimeIndexRangeType, createCompileTimeIntersectionType, createCompileTimeLengthOfType, createCompileTimeListType, createCompileTimeMapElementsType, createCompileTimePredicateType, createCompileTimeStreamType, createCompileTimeTupleType, createCompileTimeTypeOfType, createCompileTimeUnionType, createCompileTimeWithElementAtType, createIntegerLiteral, createNestedReference, createParametersType, createTextLiteral, forEachChildType } from '../syntax-tree.js';
import { elementsEqual, fieldsEqual, isDefined, map, mapDictionary } from '../util.js';
import { checkerStats } from './checker-stats.js';
import { getNameFromValue, isInsideFunctionLiteral } from '../parser/parser-utils.js';

/**
 * Ergebnis von containsArgumentPlaceholder je Typobjekt.
 */
const argumentPlaceholderCache = new WeakMap<CompileTimeType, boolean>();

/**
 * Der aufgelöste Typ je Anwendungsknoten (Alias mit args), siehe dereferenceAlias.
 */
const aliasApplicationCache = new WeakMap<CompileTimeAliasType, CompileTimeType>();

/**
 * Wie viele Anwendungsknoten ein Vergleich höchstens auflöst, bevor er das Paar als zuweisbar
 * annimmt. Der Stapel laufender Alias-Vergleiche erkennt Anwendungen mit gleichen Argumenten
 * wieder (isSameOrSameAliasApplication), aber nicht jede Rekursion wiederholt ihre Argumente -
 * erst das Budget garantiert, dass der Vergleich endet. Gilt für isTypeAssignable und typeEquals je
 * eigenen Stapel.
 */
const maxAliasApplicationExpansions = 100;

let aliasApplicationExpansionsRemaining = maxAliasApplicationExpansions;

let typeEqualsApplicationExpansionsRemaining = maxAliasApplicationExpansions;

//#region benannte Eigenschaften

/**
 * Lesen und Schreiben einer benannten Eigenschaft einer Knotenart, nebeneinander, damit beide
 * zusammenpassen. set liefert undefined, wenn sich die Eigenschaft nicht zurückschreiben lässt
 * (etwa weil sie berechnet ist wie der ElementType eines Tupels).
 */
interface NamedAccess<T extends ResolvedType> {
	get(type: T, name: string): CompileTimeType | undefined;
	set(type: T, name: string, value: CompileTimeType): CompileTimeType | undefined;
}

type NamedAccessTable = { [K in ResolvedType['julType']]?: NamedAccess<Extract<ResolvedType, { julType: K; }>> };

function withReturnOrParamsType(
	functionType: CompileTimeFunctionType,
	name: string,
	value: CompileTimeType,
): CompileTimeFunctionType | undefined {
	const paramsType = name === 'ParamsType' ? value : functionType.ParamsType;
	const returnType = name === 'ReturnType' ? value : functionType.ReturnType;
	if (paramsType === functionType.ParamsType
		&& returnType === functionType.ReturnType) {
		return undefined;
	}
	// Der Aliasname beschriebe die geänderte Signatur nicht mehr.
	return {
		...functionType,
		ParamsType: paramsType,
		ReturnType: returnType,
		aliasName: undefined,
		isUnresolvedPlaceholder: paramsType.isUnresolvedPlaceholder || returnType.isUnresolvedPlaceholder,
	};
}

function withDictionaryLiteralField(
	type: Extract<ResolvedType, { julType: 'dictionaryLiteral'; }>,
	name: string,
	value: CompileTimeType,
): CompileTimeType | undefined {
	if (!(name in type.Fields)) {
		return undefined;
	}
	return createCompileTimeDictionaryLiteralType({ ...type.Fields, [name]: value }, type.complete, type.declaration);
}

/**
 * Felder eines Werts: `x/name`, wobei x einen Wert dieses Typs hat (`point/x`, `s$/getValue`). Die
 * Einträge für Funktion und Stream tragen auch deren Typeigenschaften, typePropertyAccess übernimmt
 * sie. Über einen Wert gelesen werden sie nicht, siehe isTypePropertyOfValue.
 */
export const valueFieldAccess: NamedAccessTable = {
	dictionaryLiteral: {
		get: (type, name) => type.Fields[name],
		set: withDictionaryLiteralField,
	},
	dictionary: {
		// TODO Or(() type.ElementType)
		get: type => type.ElementType,
		set: (_type, _name, value) => createCompileTimeDictionaryType(value),
	},
	function: {
		get: (type, name) => {
			switch (name) {
				case 'ParamsType':
					return type.ParamsType;
				case 'ReturnType':
					return type.ReturnType;
				case 'PredicateIfTrue':
					// Any als neutrales Element von And: ohne erkannte Prädikat-Form (kein
					// .predicate) soll die Projektion den ElementType unverändert lassen,
					// statt ihn fälschlich einzuschränken.
					return type.predicate?.ifTrue ?? builtinAny;
				default:
					return undefined;
			}
		},
		set: withReturnOrParamsType,
	},
	parameters: {
		get: (type, name) => type.singleNames.find(parameter => parameter.name === name)?.type,
		set: (type, name, value) => {
			const index = type.singleNames.findIndex(parameter => parameter.name === name);
			if (index === -1) {
				return undefined;
			}
			const singleNames = type.singleNames.map((parameter, parameterIndex) =>
				parameterIndex === index
					? { name: parameter.name, type: value }
					: parameter);
			return createParametersType(singleNames, type.rest);
		},
	},
	stream: {
		get: (type, name) => {
			switch (name) {
				case 'getValue':
					return getStreamGetValueType(type);
				case 'ValueType':
					return type.ValueType;
				default:
					return undefined;
			}
		},
		set: (type, name, value) => name === 'ValueType'
			? createCompileTimeStreamType(value, type.finite)
			: undefined,
	},
};

/**
 * Eigenschaften eines Typs: `TypeOf(x)/name` (`TypeOf(values)/ElementType`).
 */
export const typePropertyAccess: NamedAccessTable = {
	dictionary: {
		get: (type, name) => name === 'ElementType' ? type.ElementType : undefined,
		set: (_type, name, value) => name === 'ElementType'
			? createCompileTimeDictionaryType(value)
			: undefined,
	},
	dictionaryLiteral: {
		get: (type, name) => type.Fields[name],
		set: withDictionaryLiteralField,
	},
	list: {
		get: (type, name) => name === 'ElementType' ? type.ElementType : undefined,
		set: (_type, name, value) => name === 'ElementType'
			? createCompileTimeListType(value)
			: undefined,
	},
	tuple: {
		get: (type, name) => name === 'ElementType'
			? createNormalizedUnionType(type.ElementTypes)
			: undefined,
		// Die Union der Elemente lässt sich nicht auf die einzelnen Positionen zurückverteilen.
		set: () => undefined,
	},
	// Signatur und Werttyp sind Eigenschaften des Typs, derselbe Zugriff wie über einen Wert.
	function: valueFieldAccess.function,
	parameters: valueFieldAccess.parameters,
	stream: {
		// getValue ist ein Feld des Streams, keine Eigenschaft seines Typs.
		get: (type, name) => name === 'ValueType' ? type.ValueType : undefined,
		set: valueFieldAccess.stream!.set,
	},
};

export function getNamedAccess(table: NamedAccessTable, type: ResolvedType): NamedAccess<ResolvedType> | undefined {
	return table[type.julType] as NamedAccess<ResolvedType> | undefined;
}

//#endregion benannte Eigenschaften

const maxElementsPerLine = 5;

const maxFieldsInTypeDump = 5;

/** Notbremse gegen eine Alias-Kette ohne Ende. */
const maxAliasDepth = 100;

/**
 * Alias-Paare, deren Vergleich gerade läuft.
 * Ein Zyklus im Typgraph führt zwingend über einen Alias - nur er kann zurückverweisen -,
 * deshalb genügt die Besuchsmenge dort. Modul-Slot statt CheckContext-Feld, weil die
 * Typvergleiche (isTypeAssignable, typeEquals) keinen CheckContext bekommen; sie sind synchron und
 * nicht reentrant.
 */
const aliasComparisonsInProgress: { args: CompileTimeType; target: CompileTimeType; }[] = [];

/** Wie aliasComparisonsInProgress, aber für typeEquals - eine eigene Rekursion. */
const aliasEqualityInProgress: { first: CompileTimeType; second: CompileTimeType; }[] = [];

/**
 * Notbremse für die Vergleichsrekursion.
 * Die Besuchsmengen decken Zyklen ab; eine sehr tiefe, nicht zyklische Verschachtelung läuft an
 * ihnen vorbei und kippt irgendwann in den Stack Overflow (gemessen ab rund 4000 Ebenen, je nach
 * Plattform). Der Wert liegt bewusst weit darunter und weit über jeder realen Verschachtelung -
 * eine Notbremse, die selbst am Abgrund steht, ist keine.
 */
const maxTypeComparisonDepth = 100;

let typeComparisonDepth = 0;

let typeEqualsDepth = 0;

/**
 * Einheit für eine Einrückungsebene in generiertem Diagnosetext (Fehlerketten, Typ-Dumps) -
 * geteilt zwischen indentLines und bracketedExpressionToString, damit beide nie auseinanderlaufen
 * (Fund im echten yugioh-Fehlerbild: Tabs vs. Leerzeichen mischten sich, weil beide Stellen ihre
 * eigene Einrückung hatten). Leerzeichen statt Tabs: das ist generierter Diagnosetext, kein
 * Quellcode (JULs Tab-Konvention gilt dort) - ein Tab-Zeichen rendert je nach Terminal/Editor-
 * Tabstop unterschiedlich breit, Leerzeichen sind überall gleich breit.
 */
const indentUnit = '  ';

/**
 * Ab wie vielen Choices die Teilmengen-Elimination in createNormalizedUnionType übersprungen
 * wird, um O(n²) isTypeAssignable-Aufrufe bei großen Unions zu vermeiden (wie TypeScript es bei
 * getUnionType(..., UnionReduction.Subtype) macht). Wert durch Messung belegt, nicht geschätzt.
 * Muss vor CompileTimePositiveInteger stehen, weil das schon beim Modul-Load
 * createNormalizedUnionType aufruft.
 */
const subtypeReductionLimit = 20;

/**
 * Ab dieser Länge bildet MapElements ein Tupel nicht mehr je Position ab, sondern alle Positionen
 * mit der Union der Elemente. Je Position entstehen sonst n verschiedene Typen, die weiter hinten
 * (etwa in removeSubtypes) quadratisch kosten.
 */
const maxMappedPositions = 50;

/**
 * Die Länge einer Kollektion, die nicht Empty ist: mindestens 1.
 */
const CompileTimePositiveInteger = createCompileTimeBoundType('greater', 'integer', createIntegerLiteral(0n));

//#region dereference

export function getStreamGetValueType(streamType: CompileTimeStreamType): CompileTimeFunctionType {
	return createCompileTimeFunctionType(builtinEmpty, streamType.ValueType, 'impure');
}

/**
 * Faltet einen Zugriff so weit, wie die Position beweisbar ist: existiert sie, kommt ihr Typ
 * heraus; existiert sie nachweislich nicht, Empty; ist es nicht entscheidbar, die Vereinigung
 * aller Positionen. Ein noch unaufgelöster Schlüssel bleibt als Knoten stehen.
 */
export function dereferenceNestedKeyFromObject(
	rawNestedKey: string | number | CompileTimeType,
	rawSource: CompileTimeType,
): CompileTimeType | undefined {
	const nestedKey = typeof rawNestedKey === 'object'
		? resolveAlias(rawNestedKey)
		: rawNestedKey;
	const source = resolveAlias(rawSource);
	if (typeof nestedKey === 'string') {
		return dereferenceNestedKeyFromObject(createTextLiteral(nestedKey), source);
	}
	if (typeof nestedKey === 'number') {
		return dereferenceNestedKeyFromObject(createIntegerLiteral(BigInt(nestedKey)), source);
	}
	switch (nestedKey.julType) {
		case 'or': {
			// Jeder Choice ist ein eigener Zugriff. Sonst gälte die ganze Union als "steht nicht
			// fest", obwohl Or(1 2) auf einem Zweituple jede Position beweisbar trifft.
			const choices = nestedKey.ChoiceTypes
				.map(keyChoice => dereferenceNestedKeyFromObject(keyChoice, source))
				.filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(choices);
		}
		case 'integerLiteral': {
			const index = Number(nestedKey.value);
			const dereferenced = dereferenceIndexFromObject(index, source);
			if (dereferenced) {
				return dereferenced;
			}
			// Nur wo die Länge feststeht, heißt ein Fehlschlag "die Position gibt es nicht".
			return hasKnownLength(source)
				? builtinEmpty
				: dereferenceUnknownKeyFromObject(nestedKey, source);
		}
		case 'textLiteral': {
			const dereferenced = dereferenceNameFromObject(nestedKey.value, source);
			if (dereferenced) {
				return dereferenced;
			}
			return hasKnownFields(source)
				? builtinEmpty
				: dereferenceUnknownKeyFromObject(nestedKey, source);
		}
		case 'lengthOf': {
			// Der Index ist beweisbar die Länge genau dieser Quelle: bei einer List ist er
			// damit nie zu groß (er trifft exakt das letzte Element) und nie 0 (lengthOf.Source
			// ist per Konstruktion nie Empty, siehe getLengthFromType). Kein Empty im Ergebnis.
			if (source.julType === 'list'
				&& typeEquals(nestedKey.Source, source)) {
				return source.ElementType;
			}
			return dereferenceUnknownKeyFromObject(nestedKey, source);
		}
		case 'indexRange':
			return dereferenceIndexRangeFromObject(nestedKey, source);
		default: {
			// Ein Platzhalter kann sich noch zu einem Literal auflösen, der Knoten bleibt also
			// stehen. Nur ein aufgelöster, aber unbestimmter Schlüssel (PositiveInteger, Any)
			// heißt wirklich "die Position steht nicht fest".
			if (isUnresolvedPlaceholderType(nestedKey)) {
				return createNestedReference(source, nestedKey);
			}
			// Liegt er zwischen zwei Grenzen, stehen zumindest die möglichen Positionen fest.
			const range = getIntegerRange(nestedKey);
			return range?.isInteger
				? dereferenceIntegerRangeFromObject(range, nestedKey, source)
				: dereferenceUnknownKeyFromObject(nestedKey, source);
		}
	}
}

/**
 * Der Index liegt irgendwo in range: dann sind genau die Positionen darin möglich, und Empty nur,
 * wenn range über die Länge hinausreicht. Die Positionen werden direkt gewählt statt als
 * Or(1 2 … n) aufgezählt, damit ein großer Bereich keine große Union erzeugt.
 */
function dereferenceIntegerRangeFromObject(
	range: IntegerRange,
	nestedKey: CompileTimeType,
	rawSource: CompileTimeType,
): CompileTimeType | undefined {
	const source = resolveAlias(rawSource);
	switch (source.julType) {
		case 'tuple': {
			const length = BigInt(source.ElementTypes.length);
			const first = range.min === undefined || range.min < 1n ? 1n : range.min;
			const last = range.max === undefined || range.max > length ? length : range.max;
			const choices: CompileTimeType[] = [];
			for (let position = first; position <= last; position++) {
				choices.push(source.ElementTypes[Number(position) - 1]!);
			}
			const reachesOutside = range.min === undefined
				|| range.min < 1n
				|| range.max === undefined
				|| range.max > length;
			if (reachesOutside) {
				choices.push(builtinEmpty);
			}
			return createNormalizedUnionType(choices);
		}
		// Wie bei einem Literal: nur die erste Position ist beweisbar belegt.
		case 'list':
			return range.min !== undefined
				&& range.min >= 1n
				&& range.max !== undefined
				&& range.max <= 1n
				? source.ElementType
				: createNormalizedUnionType([builtinEmpty, source.ElementType]);
		case 'or': {
			const choices = source.ChoiceTypes
				.map(choiceType => dereferenceIntegerRangeFromObject(range, nestedKey, choiceType))
				.filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(choices);
		}
		default:
			return dereferenceUnknownKeyFromObject(nestedKey, source);
	}
}

/**
 * Der Schlüssel steht nicht fest, die Quelle schon: dann ist jede ihrer Positionen möglich,
 * dazu Empty, weil der Schlüssel danebenliegen kann.
 * Nur für Kollektionen mit Positionen. Ein Dictionary fällt bewusst auf Any: die Vereinigung
 * seiner Feldtypen ist zwar genauer, erzeugt aber Typen, an denen die weitere Prüfung erstickt -
 * gemessen hat sie parse+check vervierfacht.
 */
function dereferenceUnknownKeyFromObject(
	nestedKey: CompileTimeType,
	rawSource: CompileTimeType,
): CompileTimeType | undefined {
	const source = resolveAlias(rawSource);
	switch (source.julType) {
		case 'empty':
			return builtinEmpty;
		case 'any':
			return builtinAny;
		case 'tuple':
			return createNormalizedUnionType([builtinEmpty, ...source.ElementTypes]);
		case 'list':
			return createNormalizedUnionType([builtinEmpty, source.ElementType]);
		case 'or': {
			const choices = source.ChoiceTypes
				.map(choiceType => dereferenceUnknownKeyFromObject(nestedKey, choiceType))
				.filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(choices);
		}
		case 'concat': {
			const dereferencedSources = source.Sources
				.map(sourceType => dereferenceUnknownKeyFromObject(nestedKey, sourceType))
				.filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(dereferencedSources);
		}
		case 'nestedReference':
		case 'parameterReference':
			return createNestedReference(source, nestedKey);
		case 'typeOf':
			return dereferenceUnknownKeyFromObject(nestedKey, source.value);
		// Ein Wert, der das Prädikat erfüllt, liegt in dessen Obermenge und hat deren Gestalt.
		case 'predicate':
			return dereferenceUnknownKeyFromObject(nestedKey, source.UpperBound);
		// Weder Positionen noch benannte Felder mit unbekanntem Schlüssel bekannt - bisheriges,
		// unverändertes Verhalten wie vor der Exhaustivitätsprüfung: permissiv wie 'any'.
		case 'and':
		case 'blob':
		case 'boolean':
		case 'booleanLiteral':
		case 'date':
		case 'dictionary':
		case 'dictionaryLiteral':
		case 'error':
		case 'float':
		case 'floatLiteral':
		case 'function':
		case 'bound':
		case 'integer':
		case 'integerLiteral':
		case 'add':
		case 'lengthOf':
		case 'never':
		case 'not':
		case 'parameters':
		case 'indexRange':
		case 'stream':
		case 'text':
		case 'textLiteral':
		case 'mapElements':
		case 'type':
		case 'conditional':
		case 'withElementAt':
			return builtinAny;
		default: {
			const assertNever: never = source;
			throw new Error('Unexpected source.julType: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

function nestedKeysEqual(
	first: string | number | CompileTimeType,
	second: string | number | CompileTimeType,
): boolean {
	if (typeof first === 'object'
		&& typeof second === 'object') {
		return typeEquals(first, second);
	}
	return first === second;
}

/**
 * Kennt dieser Typ seine Feldmenge?
 * Nur dann heißt ein fehlgeschlagenes dereferenceNameFromObject "das Feld gibt es nicht".
 * Bei allen anderen liefert es undefined, weil der Typ noch nicht ausgewertet ist oder
 * dereferenceNameFromObject ihn nicht behandelt — daraus darf kein Fehler werden.
 */
export function hasKnownFields(rawType: CompileTimeType): boolean {
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'empty':
		case 'dictionary':
			// dereferenceNameFromObject liefert für JEDEN Namen einen Treffer (vakuos bei Empty,
			// den ElementType bei dictionary) - nie undefined. Damit ist die Feldmenge in dem
			// Sinn, den dieser Test braucht (kann dereferenceNameFromObject je scheitern?),
			// bereits vollständig entschieden.
			return true;
		case 'dictionaryLiteral':
			return type.complete;
		case 'function':
		case 'parameters':
		case 'stream':
			return true;
		case 'or':
			// Jeder Choice muss selbst entscheidbar sein - erst dann ist auch für die ganze
			// Union feststellbar, ob ein Feld existiert (siehe dereferenceNameFromObject,
			// case 'or': das setzt genau diese Entscheidbarkeit je Choice voraus).
			return type.ChoiceTypes.every(choiceType => !canHaveFields(choiceType) || hasKnownFields(choiceType));
		default:
			return false;
	}
}

/**
 * Kennt dieser Typ seine Länge?
 * Nur dann heißt ein fehlgeschlagenes dereferenceIndexFromObject "der Index liegt daneben".
 * Eine List hat keine bekannte Länge, dort ist kein Index zu weit.
 */
export function hasKnownLength(type: CompileTimeType): boolean {
	return resolveAlias(type).julType === 'tuple';
}

/**
 * Kann dieser Typ überhaupt benannte Felder tragen?
 * Ein Nein heißt: der Name liegt nicht daneben, er passt gar nicht zur Art der Quelle.
 * Im Zweifel ja, damit aus "weiß ich nicht" kein Fehler wird.
 */
export function canHaveFields(rawType: CompileTimeType): boolean {
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'boolean':
		case 'booleanLiteral':
		case 'float':
		case 'floatLiteral':
		case 'integer':
		case 'integerLiteral':
		case 'list':
		case 'text':
		case 'textLiteral':
		case 'tuple':
			return false;
		default:
			return true;
	}
}

/**
 * Liest x/name bei einem Wert x dieses Typs eine Eigenschaft des Typs statt eines Felds des Werts?
 * Die Typeigenschaften eines Typwerts (TypeOf(x)/name) sind es immer.
 */
export function isTypePropertyOfValue(julType: ResolvedType['julType'], name: string): boolean {
	switch (julType) {
		case 'function':
			return name === 'ParamsType' || name === 'ReturnType' || name === 'PredicateIfTrue';
		case 'stream':
			return name === 'ValueType';
		default:
			return false;
	}
}

export function dereferenceNameFromObject(
	name: string,
	rawSourceObjectType: CompileTimeType,
): CompileTimeType | undefined {
	const sourceObjectType = resolveAlias(rawSourceObjectType);
	switch (sourceObjectType.julType) {
		case 'empty':
			return builtinEmpty;
		case 'any':
			return builtinAny;
		case 'function':
		case 'stream':
			// Signatur und Werttyp sind Eigenschaften des Typs, gelesen über TypeOf(s$)/ValueType.
			// Der Wert selbst hat sie nicht, ein Funktionswert hat gar keine Felder.
			if (isTypePropertyOfValue(sourceObjectType.julType, name)) {
				return undefined;
			}
			return getNamedAccess(valueFieldAccess, sourceObjectType)!.get(sourceObjectType, name);
		case 'dictionaryLiteral':
		case 'dictionary':
		case 'parameters':
			return getNamedAccess(valueFieldAccess, sourceObjectType)!.get(sourceObjectType, name);
		case 'concat':
		case 'list':
		case 'tuple':
			// List/Tuple/Concat tragen keine benannten Felder; gemeldet wird an der Aufrufstelle.
			return undefined;
		case 'nestedReference':
		case 'parameterReference':
			return createNestedReference(sourceObjectType, name);
		case 'or': {
			const dereferencedChoices: CompileTimeType[] = [];
			for (const choiceType of sourceObjectType.ChoiceTypes) {
				const dereferenced = dereferenceNameFromObject(name, choiceType);
				if (dereferenced) {
					dereferencedChoices.push(dereferenced);
					continue;
				}
				// Fehlt das Feld nachweislich (die Art kennt ihre Feldmenge oder kann grundsätzlich
				// keine Felder tragen), ist der Zugriff für die GANZE Union unsicher - ein anderer
				// Choice (z.B. Empty) darf das nicht stillschweigend überdecken. Ein Choice, der nur
				// noch nicht aufgelöst ist (unvollständiges Dictionary), bleibt dagegen unentschieden
				// und wird wie bisher aus der Vereinigung weggelassen.
				if (!canHaveFields(choiceType) || hasKnownFields(choiceType)) {
					return undefined;
				}
			}
			// Kein Choice hat etwas beigetragen: unbekannt, nicht die leere Union Never.
			return dereferencedChoices.length
				? createNormalizedUnionType(dereferencedChoices)
				: undefined;
		}
		case 'typeOf': {
			const innerType = sourceObjectType.value;
			return dereferenceNameFromObjectType(name, innerType, sourceObjectType);
		}
		// Ein Wert, der das Prädikat erfüllt, liegt in dessen Obermenge und hat deren Gestalt.
		case 'predicate':
			return dereferenceNameFromObject(name, sourceObjectType.UpperBound);
		// Keine benannten Felder und kein Sonderfall nötig - unverändertes Verhalten wie vor der
		// Exhaustivitätsprüfung.
		case 'and':
		case 'blob':
		case 'boolean':
		case 'booleanLiteral':
		case 'date':
		case 'error':
		case 'float':
		case 'floatLiteral':
		case 'bound':
		case 'integer':
		case 'integerLiteral':
		case 'add':
		case 'lengthOf':
		case 'never':
		case 'not':
		case 'indexRange':
		case 'text':
		case 'textLiteral':
		case 'mapElements':
		case 'type':
		case 'conditional':
		case 'withElementAt':
			return undefined;
		default: {
			const assertNever: never = sourceObjectType;
			throw new Error('Unexpected sourceObjectType.julType: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

function dereferenceNameFromObjectType(
	name: string,
	rawInnerType: CompileTimeType,
	sourceObjectType: CompileTimeType,
): CompileTimeType | undefined {
	const innerType = resolveAlias(rawInnerType);
	switch (innerType.julType) {
		case 'dictionary':
		case 'dictionaryLiteral':
		case 'function':
		case 'list':
		case 'parameters':
		case 'stream':
		case 'tuple': {
			// Die Tabelle liefert den Typ selbst, der Ausdruck bezeichnet ihn aber als Wert:
			// List(Integer)/ElementType ist der Typ Integer, wie ein geschriebenes Integer auch.
			const property = getNamedAccess(typePropertyAccess, innerType)!.get(innerType, name);
			return property && createCompileTimeTypeOfType(property);
		}
		case 'nestedReference':
		case 'parameterReference':
			return createNestedReference(sourceObjectType, name);
		case 'or': {
			const dereferencedChoices = innerType.ChoiceTypes.map(choiceType => {
				// Der choice braucht seine eigene TypeOf Hülle: sonst entsteht für einen noch
				// nicht aufgelösten choice die Referenz values/ElementType statt
				// TypeOf(values)/ElementType, und die ist nicht auflösbar, weil ElementType
				// eine Eigenschaft des Typs ist und nicht des Werts.
				return dereferenceNameFromObjectType(name, choiceType, createCompileTimeTypeOfType(choiceType));
			}).filter((type): type is CompileTimeType => !!type);
			// Kein Choice hat die Eigenschaft: unbekannt, nicht die leere Union Never.
			return dereferencedChoices.length
				? createNormalizedUnionType(dereferencedChoices)
				: undefined;
		}
		case 'concat': {
			// Gleiches Prinzip wie 'or': jede Quelle einzeln dereferenzieren (mit eigener TypeOf-
			// Hülle, aus demselben Grund wie dort) und die Ergebnisse zur Union zusammenfassen.
			// Eine noch unaufgelöste Quelle (z.B. ein generischer Funktionsparameter hinter einem
			// Spread) liefert über den 'parameterReference'-Fall bereits eine offene
			// nestedReference zurück - die Generizität bleibt so erhalten, statt hier auf Any
			// zu kollabieren.
			const dereferencedSources = innerType.Sources.map(sourceType => {
				return dereferenceNameFromObjectType(name, sourceType, createCompileTimeTypeOfType(sourceType));
			}).filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(dereferencedSources);
		}
		// Keine Eigenschaft mit diesem Namen bekannt - unverändertes Verhalten wie vor der
		// Exhaustivitätsprüfung.
		case 'and':
		case 'any':
		case 'blob':
		case 'boolean':
		case 'booleanLiteral':
		case 'date':
		case 'empty':
		case 'error':
		case 'float':
		case 'floatLiteral':
		case 'bound':
		case 'integer':
		case 'integerLiteral':
		case 'add':
		case 'lengthOf':
		case 'never':
		case 'not':
		case 'indexRange':
		case 'text':
		case 'textLiteral':
		case 'mapElements':
		case 'type':
		case 'typeOf':
		case 'conditional':
		case 'withElementAt':
		// Ein Prädikat als Typwert hat keine benannten Felder wie ElementType.
		case 'predicate':
			return undefined;
		default: {
			const assertNever: never = innerType;
			throw new Error('Unexpected innerType.julType: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

export function dereferenceIndexFromObject(
	index: number,
	rawSourceObjectType: CompileTimeType,
): CompileTimeType | undefined {
	if (rawSourceObjectType === undefined) {
		return undefined;
	}
	const sourceObjectType = resolveAlias(rawSourceObjectType);
	switch (sourceObjectType.julType) {
		case 'empty':
			return builtinEmpty;
		// Ein Wert, der das Prädikat erfüllt, liegt in dessen Obermenge und hat deren Gestalt.
		case 'predicate':
			return dereferenceIndexFromObject(index, sourceObjectType.UpperBound);
		case 'dictionaryLiteral':
			// Ein Dictionary trägt keine Positionen; gemeldet wird an der Aufrufstelle.
			return undefined;
		case 'list':
			// List(X) schliesst Empty als Typ aus, ein Wert hat also mindestens ein Element -
			// Index 1 existiert beweisbar. Ab Index 2 ist die Länge weiterhin nicht bekannt.
			return index === 1
				? sourceObjectType.ElementType
				: createNormalizedUnionType([builtinEmpty, sourceObjectType.ElementType]);
		case 'or': {
			const dereferencedChoices = sourceObjectType.ChoiceTypes.map(choiceType => {
				return dereferenceIndexFromObject(index, choiceType);
			}).filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(dereferencedChoices);
		}
		case 'nestedReference':
		case 'parameterReference':
			return createNestedReference(sourceObjectType, index);
		case 'tuple':
			return sourceObjectType.ElementTypes[index - 1];
		case 'concat': {
			// Ein Concat bleibt nur stehen, solange eine Quelle offen ist (siehe concatFromTypes).
			// Die Quellen werden abgezählt, solange ihre Länge feststeht; liegt die Position
			// dahinter, hängt sie vom Argument ab, und der Zugriff wartet auf die aufgelösten
			// Quellen, statt verloren zu gehen.
			const deferred = sourceObjectType.Sources.some(isUnresolvedPlaceholderType)
				? createNestedReference(sourceObjectType, index)
				: undefined;
			let remainingIndex = index;
			for (const rawSource of sourceObjectType.Sources) {
				const source = resolveAlias(valueOf(rawSource));
				switch (source.julType) {
					case 'empty':
						continue;
					case 'tuple':
						if (remainingIndex <= source.ElementTypes.length) {
							return source.ElementTypes[remainingIndex - 1];
						}
						remainingIndex -= source.ElementTypes.length;
						continue;
					case 'list':
						// Wie im Fall 'list': nur die erste Position ist beweisbar belegt.
						return remainingIndex === 1
							? source.ElementType
							: deferred;
					default:
						return deferred;
				}
			}
			return deferred;
		}
		// Keine Position mit diesem Index bekannt - unverändertes Verhalten wie vor der
		// Exhaustivitätsprüfung.
		case 'and':
		case 'any':
		case 'blob':
		case 'boolean':
		case 'booleanLiteral':
		case 'date':
		case 'dictionary':
		case 'error':
		case 'float':
		case 'floatLiteral':
		case 'function':
		case 'bound':
		case 'integer':
		case 'integerLiteral':
		case 'add':
		case 'lengthOf':
		case 'never':
		case 'not':
		case 'parameters':
		case 'indexRange':
		case 'stream':
		case 'text':
		case 'textLiteral':
		case 'mapElements':
		case 'type':
		case 'typeOf':
		case 'conditional':
		case 'withElementAt':
			return undefined;
		default: {
			const assertNever: never = sourceObjectType;
			throw new Error('Unexpected sourceObjectType.julType: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

export function dereferenceArgumentTypesNested(
	calledFunction: CompileTimeType,
	argsType: CompileTimeType,
	typeToDereference: CompileTimeType,
): CompileTimeType {
	return traversePlaceholders(typeToDereference, {
		calledFunction: calledFunction,
		argsType: argsType,
	});
}

/**
 * Gegenstück zu bindReceiver für die Stellen, die nach Position binden: der Empfänger, falls die
 * Argumente die Form Concat([Empfänger] Rest) haben, und der Rest. Ein Tuple mit dem Empfänger vorn
 * bindet ohne Empfänger genauso und bleibt ungeteilt.
 */
export function splitReceiver(rawArgsType: CompileTimeType): {
	receiverType: CompileTimeType | undefined;
	argsType: CompileTimeType;
} {
	const argsType = resolveAlias(rawArgsType);
	if (argsType.julType === 'concat'
		&& argsType.Sources.length === 2) {
		const leading = resolveAlias(argsType.Sources[0]!);
		if (leading.julType === 'tuple'
			&& leading.ElementTypes.length === 1) {
			return { receiverType: leading.ElementTypes[0]!, argsType: argsType.Sources[1]! };
		}
	}
	return { receiverType: undefined, argsType: rawArgsType };
}

/**
 * Die Argumenttypen in Reihenfolge, der Empfänger zuerst. undefined, wenn die Argumente keine
 * Positionen haben (benannt, Spread).
 */
export function getAllArgTypes(
	rawBoundArgsType: CompileTimeType,
): CompileTimeType[] | undefined {
	const { receiverType: prefixArgumentType, argsType: rawArgsType } = splitReceiver(rawBoundArgsType);
	const argsType = resolveAlias(rawArgsType);
	const prefixArgTypes = prefixArgumentType
		? [prefixArgumentType]
		: [];
	if (argsType.julType === 'empty') {
		return prefixArgTypes;
	}
	if (isTupleType(argsType)) {
		const allArgTypes = [
			...prefixArgTypes,
			...argsType.ElementTypes,
		];
		return allArgTypes;
	}
	// TODO other argsType types
	return undefined;
}

function dereferenceParameterFromArgumentType(
	calledFunction: CompileTimeType,
	rawBoundArgsType: CompileTimeType,
	parameterReference: ParameterReference,
): CompileTimeType {
	const { receiverType: prefixArgumentType, argsType: rawArgsType } = splitReceiver(rawBoundArgsType);
	const argsType = resolveAlias(rawArgsType);
	if (!calledFunction || parameterReference.functionRef !== calledFunction) {
		return parameterReference;
	}
	// TODO Param index nicht in ParameterReference, stattdessen mithilfe von parameterReference.functionRef.paramsType ermitteln?
	const paramIndex = parameterReference.index;
	const paramsType = calledFunction.ParamsType;
	const isRest = isParametersType(paramsType)
		? paramsType.singleNames.length === paramIndex
		// TODO?
		: false;
	if (isRest) {
		const allArgTypes = getAllArgTypes(rawBoundArgsType);
		if (allArgTypes === undefined) {
			// Ist der Rest der einzige Parameter, sammelt er die ganze Argumentkollektion, auch
			// wenn sie keine Tuple ist (f(...ys) mit ys: List(Integer)).
			if (paramIndex === 0
				&& !prefixArgumentType) {
				return rawArgsType;
			}
			return builtinAny;
		}
		return createCompileTimeTupleType(allArgTypes.slice(paramIndex));
	}
	if (prefixArgumentType && paramIndex === 0) {
		return prefixArgumentType;
	}
	if (argsType.julType === 'empty') {
		return builtinEmpty;
	}
	switch (argsType.julType) {
		case 'dictionaryLiteral': {
			const referenceName = parameterReference.name;
			const argType = argsType.Fields[referenceName];
			// Ohne Argument kommt der Parameter zur Laufzeit als Empty an. Sonst ist das Argument
			// selbst der Wert des Parameters, wie beim Tuple.
			return argType ?? builtinEmpty;
		}
		case 'tuple': {
			// TODO dereference nested path
			// const referenceName = parameterReference.path[0].name;
			const argIndex = prefixArgumentType
				? paramIndex - 1
				: paramIndex;
			const argType = argsType.ElementTypes[argIndex];
			// Ohne Argument kommt der Parameter zur Laufzeit als Empty an.
			if (!argType) {
				return builtinEmpty;
			}
			return argType;
		}
		case 'function':
			// Wenn der Parameter ein Callback ist und sein Typ dereferenziert wird (z. B. TypeOf(callback)/ReturnType),
			// muss der ReturnType der Funktion extrahiert werden, nicht die Funktion selbst.
			return argsType.ReturnType;
		case 'list':
			// Eine List hat keine bekannte Länge, aber alle Elemente haben denselben Typ.
			// Wenn Argumente als Spread hereinkommen (...values), hat jedes Argument den ElementType.
			// Der erste Parameterindex (0) ist nach prefixArgument (falls vorhanden), alle anderen
			// sind Spread-Elemente und haben also den ElementType.
			return argsType.ElementType;
		default:
			return argsType;
	}
}

/**
 * Löst parameterReference und nestedReference über ihre Deklaration rekursiv soweit wie möglich auf.
 * Nicht Auflösbares wird zu Any — daher nur für Prüfung und Anzeige geeignet, nie zur
 * Weiterverarbeitung eines Typs, der seine Generizität behalten muss.
 */
export function resolvePlaceholders(rawType: CompileTimeType): CompileTimeType {
	return traversePlaceholders(rawType, undefined);
}

/**
 * Enthält der Typ etwas, das traversePlaceholders mit argumentContext ersetzen würde? Folgt
 * denselben Abstiegen, also nicht in Funktionen, Parameter und das Ziel eines Alias. Das Flag
 * isUnresolvedPlaceholder taugt dafür nicht, ein Dictionary-Literal setzt es bewusst nie.
 * Gecacht, weil große Dictionary-Literale sonst bei jedem Aufruf durchlaufen würden. Das geht, weil
 * Dictionary-Literale und Tupel nach dem Erzeugen nicht mehr verändert werden.
 */
function containsArgumentPlaceholder(type: CompileTimeType): boolean {
	switch (type.julType) {
		case 'parameterReference':
		case 'nestedReference':
			return true;
		case 'alias':
			return !!type.args && containsArgumentPlaceholder(type.args);
		case 'function':
		case 'parameters':
			return false;
		default:
			break;
	}
	const cached = argumentPlaceholderCache.get(type);
	if (cached !== undefined) {
		return cached;
	}
	let contains = false;
	forEachChildType(type, child => {
		contains ||= containsArgumentPlaceholder(child);
	});
	argumentPlaceholderCache.set(type, contains);
	return contains;
}

/** Die Argumente eines Aufrufs, über die ein parameterReference aufgelöst wird. */
interface ArgumentContext {
	calledFunction: CompileTimeType;
	/** Mit dem Empfänger, siehe bindReceiver. */
	argsType: CompileTimeType;
}

/**
 * Die einzige Traversierung über einen Typbaum. Der Kontext entscheidet, woher ein
 * parameterReference seinen Wert bekommt:
 * undefined aus der Deklaration (resolvePlaceholders), gesetzt aus den Argumenten eines Aufrufs
 * (dereferenceArgumentTypesNested).
 * Gefaltet wird ausschließlich in den *FromTypes-Funktionen.
 */
function traversePlaceholders(
	rawType: CompileTimeType,
	argumentContext: ArgumentContext | undefined,
): CompileTimeType {
	if (!argumentContext) {
		checkerStats.resolvePlaceholders++;
	}
	switch (rawType.julType) {
		case 'any':
		case 'blob':
		case 'boolean':
		case 'booleanLiteral':
		case 'date':
		case 'empty':
		case 'error':
		case 'float':
		case 'floatLiteral':
		case 'integer':
		case 'integerLiteral':
		case 'never':
		case 'text':
		case 'textLiteral':
		case 'type':
			// Blatt-Typen: kein verschachtelter CompileTimeType, der einen Platzhalter tragen könnte.
			return rawType;
		case 'and': {
			const rawChoices = rawType.ChoiceTypes;
			const dereferencedChoices = rawChoices.map(choiceType => traversePlaceholders(choiceType, argumentContext));
			if (elementsEqual(rawChoices, dereferencedChoices)) {
				return rawType;
			}
			return createNormalizedIntersectionType(dereferencedChoices);
		}
		case 'dictionary': {
			const rawElement = rawType.ElementType;
			const dereferencedElement = traversePlaceholders(rawElement, argumentContext);
			if (dereferencedElement === rawElement) {
				return rawType;
			}
			return createCompileTimeDictionaryType(
				dereferencedElement,
				argumentContext ? undefined : rawType.aliasName);
		}
		case 'dictionaryLiteral': {
			// Auch mit argumentContext: ein Typparameter in einem Feld (`[value: T]`) wird erst am
			// Aufruf der Typfunktion konkret.
			if (argumentContext && !containsArgumentPlaceholder(rawType)) {
				return rawType;
			}
			const rawFields = rawType.Fields;
			const dereferencedFields = mapDictionary(rawFields, field => traversePlaceholders(field, argumentContext));
			if (fieldsEqual(rawFields, dereferencedFields)) {
				return rawType;
			}
			return createCompileTimeDictionaryLiteralType(dereferencedFields, rawType.complete, rawType.declaration, rawType.aliasName);
		}
		case 'function': {
			if (argumentContext) {
				return rawType;
			}
			const dereferencedParamsType = resolvePlaceholders(rawType.ParamsType);
			const dereferencedReturnType = resolvePlaceholders(rawType.ReturnType);
			if (dereferencedParamsType === rawType.ParamsType
				&& dereferencedReturnType === rawType.ReturnType) {
				return rawType;
			}
			const dereferencedType = createCompileTimeFunctionType(dereferencedParamsType, dereferencedReturnType, rawType.purity, rawType.aliasName);
			// Die Prädikat-Fakten und das Literal beschreiben den Wert, nicht die Platzhalter darin -
			// sie gehen beim Neubau sonst still verloren. Am Literal hängen Faltung und Identität.
			dereferencedType.predicate = rawType.predicate;
			dereferencedType.literal = rawType.literal;
			dereferencedType.foldable = rawType.foldable;
			dereferencedType.boundArguments = rawType.boundArguments;
			return dereferencedType;
		}
		case 'bound': {
			const rawValue = rawType.Value;
			const dereferencedValue = traversePlaceholders(rawValue, argumentContext);
			if (dereferencedValue === rawValue) {
				return rawType;
			}
			return createCompileTimeBoundType(rawType.Relation, rawType.Family, dereferencedValue);
		}
		case 'list': {
			const rawElement = rawType.ElementType;
			const dereferencedElement = traversePlaceholders(rawElement, argumentContext);
			if (dereferencedElement === rawElement) {
				return rawType;
			}
			return createCompileTimeListType(dereferencedElement);
		}
		case 'nestedReference': {
			const dereferencedSource = traversePlaceholders(rawType.source, argumentContext);
			const dereferencedKey = typeof rawType.nestedKey === 'object'
				? traversePlaceholders(rawType.nestedKey, argumentContext)
				: rawType.nestedKey;
			const dereferencedNested = dereferenceNestedKeyFromObject(dereferencedKey, dereferencedSource);
			if (!dereferencedNested) {
				return builtinAny;
			}
			return rawType.deferValueOf
				? valueOf(dereferencedNested)
				: dereferencedNested;
		}
		case 'not': {
			const rawSource = rawType.SourceType;
			const dereferencedSource = traversePlaceholders(rawSource, argumentContext);
			if (dereferencedSource === rawSource) {
				return rawType;
			}
			return createCompileTimeComplementType(dereferencedSource);
		}
		case 'lengthOf': {
			const rawSource = rawType.Source;
			const dereferencedSource = traversePlaceholders(rawSource, argumentContext);
			if (dereferencedSource === rawSource) {
				return rawType;
			}
			// Nicht nur die aufgelöste Source in lengthOf einpacken: getLengthFromType splittet
			// z.B. Or([] List(T)) in Or(0 lengthOf(List(T))) auf. Würde hier stattdessen direkt
			// lengthOf(Or([] List(T))) entstehen, gölte die Source-nie-Empty-Invariante
			// (isTypeAssignable, case 'lengthOf') nicht mehr, obwohl der Aufrufer sich genau darauf
			// verlässt.
			return getLengthFromType(dereferencedSource);
		}
		case 'or': {
			const rawChoices = rawType.ChoiceTypes;
			const dereferencedChoices = rawChoices.map(choiceType => traversePlaceholders(choiceType, argumentContext));
			if (elementsEqual(rawChoices, dereferencedChoices)) {
				return rawType;
			}
			return createNormalizedUnionType(dereferencedChoices);
		}
		case 'parameterReference': {
			if (argumentContext) {
				const dereferencedParameter = dereferenceParameterFromArgumentType(
					argumentContext.calledFunction,
					argumentContext.argsType,
					rawType);
				const dereferencedNested = dereferencedParameter === rawType
					? dereferencedParameter
					: traversePlaceholders(dereferencedParameter, argumentContext);
				// Ein nacktes T meint das Argument als Typ, TypeOf(value) den Typ des Arguments.
				return rawType.deferValueOf
					? valueOf(dereferencedNested)
					: dereferencedNested;
			}
			const dereferenced1 = dereferenceParameterTypeFromFunctionRef(rawType);
			if (!dereferenced1) {
				return builtinAny;
			}
			if (dereferenced1 === rawType) {
				return rawType;
			}
			return resolvePlaceholders(dereferenced1);
		}
		case 'parameters': {
			if (argumentContext) {
				return rawType;
			}
			const dereferencedSingleNames = rawType.singleNames.map(dereferenceNestedParameter);
			const rawRest = rawType.rest;
			const dereferencedRest = rawRest
				? dereferenceNestedParameter(rawRest)
				: undefined;
			if (rawRest === dereferencedRest
				&& elementsEqual(rawType.singleNames, dereferencedSingleNames)) {
				return rawType;
			}
			return createParametersType(dereferencedSingleNames, dereferencedRest);
		}
		case 'stream': {
			const rawValue = rawType.ValueType;
			const dereferencedValue = traversePlaceholders(rawValue, argumentContext);
			if (dereferencedValue === rawValue) {
				return rawType;
			}
			return createCompileTimeStreamType(dereferencedValue, rawType.finite);
		}
		case 'tuple': {
			// Auch mit argumentContext: ein Typparameter in einem Tupel (`[T T]`) wird erst am
			// Aufruf der Typfunktion konkret.
			if (argumentContext && !containsArgumentPlaceholder(rawType)) {
				return rawType;
			}
			const rawElements = rawType.ElementTypes;
			const dereferencedElements = rawElements.map(element => traversePlaceholders(element, argumentContext));
			if (elementsEqual(rawElements, dereferencedElements)) {
				return rawType;
			}
			return createCompileTimeTupleType(dereferencedElements);
		}
		case 'typeOf': {
			const rawValue = rawType.value;
			const dereferencedValue = traversePlaceholders(rawValue, argumentContext);
			if (dereferencedValue === rawValue) {
				return rawType;
			}
			return createCompileTimeTypeOfType(dereferencedValue);
		}
		case 'withElementAt': {
			const rawSource = rawType.Source;
			const rawIndex = rawType.Index;
			const rawValue = rawType.Value;
			const dereferencedSource = traversePlaceholders(rawSource, argumentContext);
			const dereferencedIndex = traversePlaceholders(rawIndex, argumentContext);
			const dereferencedValue = traversePlaceholders(rawValue, argumentContext);
			if (dereferencedSource === rawSource
				&& dereferencedIndex === rawIndex
				&& dereferencedValue === rawValue) {
				return rawType;
			}
			// Neu falten statt neu einpacken, sonst bleibt der Knoten trotz aufgelöster Teile stehen.
			return withElementAtFromTypes(dereferencedSource, dereferencedIndex, dereferencedValue);
		}
		case 'conditional': {
			// Nur die Operanden entscheiden über den Zweig. Köpfe und Ergebnisse werden mit
			// aufgelöst, damit ein Ergebnis wie TypeOf(a) am Aufruf ebenfalls konkret wird.
			const rawOperands = rawType.Operands;
			const dereferencedOperands = rawOperands.map(operand => traversePlaceholders(operand, argumentContext));
			const rawBranches = rawType.Branches;
			const dereferencedBranches = rawBranches.map(branch => ({
				Head: traversePlaceholders(branch.Head, argumentContext),
				Result: traversePlaceholders(branch.Result, argumentContext),
			}));
			if (elementsEqual(rawOperands, dereferencedOperands)
				&& rawBranches.every((branch, index) =>
					branch.Head === dereferencedBranches[index]!.Head
					&& branch.Result === dereferencedBranches[index]!.Result)) {
				return rawType;
			}
			// Neu auswerten statt neu einpacken.
			return createConditionalType(dereferencedOperands, dereferencedBranches);
		}
		case 'indexRange': {
			const rawStart = rawType.Start;
			const rawEnd = rawType.End;
			const dereferencedStart = traversePlaceholders(rawStart, argumentContext);
			const dereferencedEnd = traversePlaceholders(rawEnd, argumentContext);
			if (dereferencedStart === rawStart
				&& dereferencedEnd === rawEnd) {
				return rawType;
			}
			return createCompileTimeIndexRangeType(dereferencedStart, dereferencedEnd);
		}
		case 'mapElements': {
			const rawSource = rawType.Source;
			const rawCallback = rawType.Callback;
			const dereferencedSource = traversePlaceholders(rawSource, argumentContext);
			// Die Verweise im Rückgabetyp des Callbacks zeigen auf genau dieses Funktionsobjekt.
			// resolvePlaceholders baut Funktionen neu, in einer Kopie fände das Einsetzen sie nicht.
			const dereferencedCallback = rawCallback.julType === 'function'
				? rawCallback
				: traversePlaceholders(rawCallback, argumentContext);
			if (dereferencedSource === rawSource
				&& dereferencedCallback === rawCallback) {
				return rawType;
			}
			const mapped = mapElementsFromTypes(dereferencedSource, dereferencedCallback);
			if (mapped.julType === 'mapElements') {
				return rawType.deferValueOf
					? { ...mapped, deferValueOf: true }
					: mapped;
			}
			// Der Rückgabetyp des Callbacks kann noch Parameter der umgebenden Funktion nennen.
			const resolved = isUnresolvedPlaceholderType(mapped)
				? traversePlaceholders(mapped, argumentContext)
				: mapped;
			return rawType.deferValueOf
				? valueOf(resolved)
				: resolved;
		}
		case 'concat': {
			const rawSources = rawType.Sources;
			const dereferencedSources = rawSources.map(source => traversePlaceholders(source, argumentContext));
			if (rawSources.every((source, i) => source === dereferencedSources[i])) {
				return rawType;
			}
			// Neu falten statt neu einpacken.
			return concatFromTypes(dereferencedSources);
		}
		case 'add': {
			const rawArgs = rawType.ArgsType;
			const dereferencedArgs = traversePlaceholders(rawArgs, argumentContext);
			if (dereferencedArgs === rawArgs) {
				return rawType;
			}
			// Neu falten statt neu einpacken.
			return addFromTypes(dereferencedArgs);
		}
		case 'alias': {
			// Stoppt vor dem Ziel: Absteigen würde bei einem rekursiven Typ nicht terminieren.
			// Nur die Argumente einer Anwendung (Tree(T)) tragen Platzhalter, und die sind endlich.
			const rawArgs = rawType.args;
			if (!rawArgs) {
				return rawType;
			}
			const dereferencedArgs = traversePlaceholders(rawArgs, argumentContext);
			if (dereferencedArgs === rawArgs) {
				return rawType;
			}
			return createCompileTimeAliasType(rawType.name, rawType.symbol, dereferencedArgs);
		}
		case 'predicate': {
			// Aufgelöst werden nur die Schranken. Die Funktion bleibt dasselbe Objekt, an ihr
			// hängen Identität und Faltung.
			const rawUpper = rawType.UpperBound;
			const rawLower = rawType.LowerBound;
			const dereferencedUpper = traversePlaceholders(rawUpper, argumentContext);
			const dereferencedLower = traversePlaceholders(rawLower, argumentContext);
			if (dereferencedUpper === rawUpper
				&& dereferencedLower === rawLower) {
				return rawType;
			}
			return createCompileTimePredicateType(rawType.FunctionType, dereferencedUpper, dereferencedLower, rawType.name);
		}
		default: {
			const assertNever: never = rawType;
			throw new Error('Unexpected rawType.julType: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

function dereferenceNestedParameter(parameter: Parameter): Parameter {
	return {
		name: parameter.name,
		type: parameter.type && resolvePlaceholders(parameter.type),
	};
}

export function dereferenceParameterTypeFromFunctionRef(parameterReference: ParameterReference): CompileTimeType | undefined {
	const functionType = parameterReference.functionRef;
	if (functionType) {
		const paramsType = functionType.ParamsType;
		if (isParametersType(paramsType)) {
			// Nach Index, nicht Name: ParamsType speichert bei einem aliasierten Parameter
			// (name = source) den Quellnamen, parameterReference.name aber den lokalen Namen
			// aus dem Rumpf - bei einem Alias laufen beide auseinander. Der Rest-Parameter steht
			// hinter den einzelnen.
			const { singleNames, rest } = paramsType;
			return parameterReference.index === singleNames.length
				? rest?.type
				: singleNames[parameterReference.index]?.type;
		}
	}
}

//#endregion dereference

//#region CompileTimeType guards

function isComplementType(type: CompileTimeType | undefined): type is CompileTimeComplementType {
	return !!type && type.julType === 'not';
}

export function isDictionaryType(type: CompileTimeType | undefined): type is CompileTimeDictionaryType {
	return !!type && type.julType === 'dictionary';
}

export function isDictionaryLiteralType(type: CompileTimeType | undefined): type is CompileTimeDictionaryLiteralType {
	return !!type && type.julType === 'dictionaryLiteral';
}

export function isFunctionType(type: CompileTimeType | undefined): type is CompileTimeFunctionType {
	return !!type && type.julType === 'function';
}

export function isListType(type: CompileTimeType | undefined): type is CompileTimeListType {
	return !!type && type.julType === 'list';
}

export function isParametersType(type: CompileTimeType | undefined): type is ParametersType {
	return !!type && type.julType === 'parameters';
}

export function isParameterReference(type: CompileTimeType | undefined): type is ParameterReference {
	return !!type && type.julType === 'parameterReference';
}

function isStreamType(type: CompileTimeType | undefined): type is CompileTimeStreamType {
	return !!type && type.julType === 'stream';
}

export function isTextLiteralType(type: CompileTimeType | undefined): type is TextLiteralType {
	return !!type && type.julType === 'textLiteral';
}

export function isTupleType(type: CompileTimeType | undefined): type is CompileTimeTupleType {
	return !!type && type.julType === 'tuple';
}

export function isTypeOfType(type: CompileTimeType | undefined): type is CompileTimeTypeOfType {
	return !!type && type.julType === 'typeOf';
}

export function isUnionType(type: CompileTimeType | undefined): type is CompileTimeUnionType {
	return !!type && type.julType === 'or';
}

//#endregion CompileTimeType guards

//#region branch narrowing

/**
 * Der Typ des Elements an dieser Stelle einer Kollektion.
 * undefined, wenn er sich nicht bestimmen lässt - dann wird nicht verengt.
 */
export function getElementTypeAtIndex(
	rawType: CompileTimeType | undefined,
	index: number,
): CompileTimeType | undefined {
	const type = rawType && resolveAlias(rawType);
	switch (type?.julType) {
		case 'any':
			return type;
		case 'list':
			return type.ElementType;
		case 'tuple':
			return type.ElementTypes[index];
		case 'or': {
			const choiceTypes: CompileTimeType[] = [];
			for (const choiceType of type.ChoiceTypes) {
				const elementType = getElementTypeAtIndex(choiceType, index);
				if (!elementType) {
					return undefined;
				}
				choiceTypes.push(elementType);
			}
			return createNormalizedUnionType(choiceTypes);
		}
		default:
			return undefined;
	}
}

//#endregion branch narrowing

//#region Sequenz Arithmetik

/**
 * Die Teilfolge der Quelle zwischen den Bereichsgrenzen. Bei bekannter Länge und literalen
 * Grenzen ein Tuple der getroffenen Positionen, sonst eine List - mit Empty, solange nicht
 * feststeht, dass der Bereich mindestens eine Position trifft.
 */
function dereferenceIndexRangeFromObject(
	range: CompileTimeIndexRangeType,
	rawSource: CompileTimeType,
): CompileTimeType | undefined {
	const source = resolveAlias(rawSource);
	if (isUnresolvedPlaceholderType(source)) {
		return createNestedReference(source, range);
	}
	// Steht die Quelle fest, müssen die Grenzen jetzt entschieden werden. Ein weggelassenes
	// optionales Argument bleibt sonst für immer parameterReference, der Knoten bliebe stehen -
	// und ein stehengebliebener Knoten wird permissiv geprüft, der Fehler verschwände lautlos.
	const start = resolvePlaceholders(range.Start);
	const end = resolvePlaceholders(range.End);
	switch (source.julType) {
		case 'empty':
			return builtinEmpty;
		case 'or': {
			const choices = source.ChoiceTypes
				.map(choice => dereferenceIndexRangeFromObject(range, choice))
				.filter((type): type is CompileTimeType => !!type);
			return createNormalizedUnionType(choices);
		}
		case 'tuple': {
			if (start.julType !== 'integerLiteral') {
				break;
			}
			const length = source.ElementTypes.length;
			const from = Number(start.value);
			const to = end.julType === 'empty'
				? length
				: end.julType === 'integerLiteral'
					? Number(end.value)
					: undefined;
			if (to === undefined) {
				break;
			}
			// Die Laufzeit schneidet an den Rändern ab, statt zu melden.
			const clampedFrom = Math.max(from, 1);
			const clampedTo = Math.min(to, length);
			if (clampedFrom > clampedTo) {
				return builtinEmpty;
			}
			return createCompileTimeTupleType(source.ElementTypes.slice(clampedFrom - 1, clampedTo));
		}
		case 'list': {
			const sliced = createCompileTimeListType(source.ElementType);
			return rangeCoversFirstPosition(start, end)
				? sliced
				: createNormalizedUnionType([builtinEmpty, sliced]);
		}
		default:
			break;
	}
	return dereferenceUnknownKeyFromObject(range, source);
}

/**
 * Trifft der Bereich garantiert mindestens eine Position? Nur dann darf Empty entfallen.
 * Beweisbar, wenn er bei 1 beginnt und bis zum Ende läuft - offen geschrieben oder über die
 * Länge einer Quelle, die selbst nie Empty ist (siehe getLengthFromType).
 */
function rangeCoversFirstPosition(rawStart: CompileTimeType, rawEnd: CompileTimeType): boolean {
	const start = resolveAlias(rawStart);
	const end = resolveAlias(rawEnd);
	if (start.julType !== 'integerLiteral'
		|| start.value !== 1n) {
		return false;
	}
	switch (end.julType) {
		case 'empty':
		case 'lengthOf':
			return true;
		case 'integerLiteral':
			return end.value >= 1n;
		default:
			return false;
	}
}

/**
 * Source, jede Position abgebildet durch callback. Bei einem Tuple wird der Rückgabetyp des
 * Callbacks je Position instanziiert, mit dem Element und seinem Index als Argumenten. Der Rumpf
 * wird dafür nicht neu inferiert: sein Rückgabetyp nennt die eigenen Parameter noch als Verweise,
 * eingesetzt wird wie beim Aufruf einer Funktion mit generischem Rückgabetyp.
 */
export function mapElementsFromTypes(
	rawSourceType: CompileTimeType,
	rawCallbackType: CompileTimeType,
): CompileTimeType {
	const callbackType = resolveAlias(rawCallbackType);
	if (callbackType.julType !== 'function'
		&& isUnresolvedPlaceholderType(callbackType)) {
		return createCompileTimeMapElementsType(rawSourceType, rawCallbackType);
	}
	const sourceType = resolveAlias(rawSourceType);
	switch (sourceType.julType) {
		case 'never':
			return builtinNever;
		case 'empty':
			return builtinEmpty;
		case 'tuple': {
			const elementTypes = sourceType.ElementTypes;
			if (!elementTypes.length) {
				return builtinEmpty;
			}
			if (elementTypes.length > maxMappedPositions) {
				const mapped = mapElementType(callbackType, createNormalizedUnionType(elementTypes), undefined);
				return createCompileTimeTupleType(new Array(elementTypes.length).fill(mapped));
			}
			return createCompileTimeTupleType(elementTypes.map((elementType, index) =>
				mapElementType(callbackType, elementType, createIntegerLiteral(BigInt(index + 1)))));
		}
		case 'list':
			// Die Länge steht nicht fest, jedes Element bekommt denselben Typ.
			return createCompileTimeListType(mapElementType(callbackType, sourceType.ElementType, undefined));
		case 'dictionaryLiteral': {
			const fieldNames = Object.keys(sourceType.Fields);
			if (!fieldNames.length
				&& sourceType.complete) {
				return builtinEmpty;
			}
			const mappedFields: CompileTimeDictionary = {};
			if (fieldNames.length > maxMappedPositions) {
				const mapped = mapElementType(callbackType, createNormalizedUnionType(Object.values(sourceType.Fields)), undefined);
				fieldNames.forEach(fieldName => {
					mappedFields[fieldName] = mapped;
				});
			}
			else {
				fieldNames.forEach(fieldName => {
					mappedFields[fieldName] = mapElementType(callbackType, sourceType.Fields[fieldName]!, createTextLiteral(fieldName));
				});
			}
			// Weitere, unbekannte Felder werden ebenso abgebildet, bleiben also unbekannt.
			return createCompileTimeDictionaryLiteralType(mappedFields, sourceType.complete);
		}
		case 'dictionary':
			// Die Schlüssel stehen nicht fest, jeder Wert bekommt denselben Typ.
			return createCompileTimeDictionaryType(mapElementType(callbackType, sourceType.ElementType, undefined));
		case 'or':
			return createNormalizedUnionType(sourceType.ChoiceTypes.map(choiceType =>
				mapElementsFromTypes(choiceType, rawCallbackType)));
		default:
			if (isUnresolvedPlaceholderType(sourceType)) {
				return createCompileTimeMapElementsType(rawSourceType, rawCallbackType);
			}
			// Über die Quelle ist nichts bekannt, sie kann also auch leer sein.
			return createNormalizedUnionType([
				builtinEmpty,
				createCompileTimeListType(mapElementType(callbackType, builtinAny, undefined)),
			]);
	}
}

/**
 * Der Rückgabetyp von callback für ein Element. Ohne feststehenden Index bleibt der Parameter
 * index ungebunden und fällt später auf seinen deklarierten Typ zurück.
 */
function mapElementType(
	callbackType: CompileTimeType,
	elementType: CompileTimeType,
	indexType: CompileTimeType | undefined,
): CompileTimeType {
	if (callbackType.julType !== 'function') {
		return builtinAny;
	}
	const argsType = createCompileTimeTupleType(indexType
		? [elementType, indexType]
		: [elementType]);
	return dereferenceArgumentTypesNested(callbackType, argsType, callbackType.ReturnType);
}

/**
 * Die Aneinanderreihung mehrerer Quellen. Sind alle Quellen konkrete Tupel, wird das Ergebnis
 * ihr Tuple; hat eine Quelle eine List, Union der Elementtypen als List; bei unaufgelösten
 * Quellen aufschieben.
 */
export function concatFromTypes(sourceTypes: CompileTimeType[]): CompileTimeType {
	if (sourceTypes.some(isUnresolvedPlaceholderType)) {
		return createCompileTimeConcatType(sourceTypes);
	}
	// Or-Quelle zuerst verteilen (Fund: Or([] List(X)) ist das Idiom für eine möglicherweise
	// leere Liste, CLAUDE.md) - sonst gilt eine Quelle mit unbestimmter Länge fälschlich als
	// nicht auflösbar.
	const orIndex = sourceTypes.findIndex(source => resolveAlias(valueOf(source)).julType === 'or');
	if (orIndex !== -1) {
		const orSource = resolveAlias(valueOf(sourceTypes[orIndex]!));
		if (orSource.julType === 'or') {
			const choiceResults = orSource.ChoiceTypes.map(choice => {
				const substituted = sourceTypes.slice();
				substituted[orIndex] = choice;
				return concatFromTypes(substituted);
			});
			return createNormalizedUnionType(choiceResults);
		}
	}
	const elementTypes: CompileTimeType[] = [];
	let hasListSource = false;
	for (const rawSource of sourceTypes) {
		// TypeOf(X) fällt hier zu X, sonst würde z.B. Concat(TypeOf(a) TypeOf(b)) nie greifen.
		const source = resolveAlias(valueOf(rawSource));
		if (source.julType === 'empty') {
			continue;
		}
		if (source.julType === 'tuple') {
			elementTypes.push(...source.ElementTypes);
		} else if (source.julType === 'list') {
			// Über eine List-Quelle ist die Länge unbekannt, das Ergebnis bleibt List.
			hasListSource = true;
			elementTypes.push(source.ElementType);
		} else {
			// Unknown: nicht entscheidbar, bleibt aufschiebbar.
			return createCompileTimeConcatType(sourceTypes);
		}
	}
	if (hasListSource) {
		return elementTypes.length
			? createCompileTimeListType(createNormalizedUnionType(elementTypes))
			: createCompileTimeListType(builtinNever);
	}
	return elementTypes.length
		? createCompileTimeTupleType(elementTypes)
		: builtinEmpty;
}

/**
 * Die möglichen Summen der Integer-Argumente ArgsType (Tuple oder List). Gerechnet wird mit dem
 * Mindestwert m je Argument (x ≥ m, siehe getIntegerMinimum): Hat jedes Argument einen, ist die
 * Summe ≥ Σm. Eine List zählt wie ein Argument ihres Elementtyps, denn sie ist nie leer - aber nur
 * bei m ≥ 0, sonst senkt jedes weitere Element die Summe. Ohne Grenze bleibt Integer, auch für
 * Argumente, die nicht sicher Integer sind: Den Rest deckt der catchAll von add ab.
 * Bleibt stehen, solange ArgsType noch Platzhalter enthält.
 */
export function addFromTypes(rawArgsType: CompileTimeType): CompileTimeType {
	if (isUnresolvedPlaceholderType(rawArgsType)) {
		return createCompileTimeAddType(rawArgsType);
	}
	const argsType = resolveAlias(rawArgsType);
	let elementTypes: CompileTimeType[];
	switch (argsType.julType) {
		case 'tuple':
			elementTypes = argsType.ElementTypes;
			break;
		case 'list':
			elementTypes = [argsType.ElementType];
			break;
		default:
			return builtinInteger;
	}
	let sum = 0n;
	for (const elementType of elementTypes) {
		// Nur für ganze Zahlen heißt > a dasselbe wie ≥ a + 1.
		if (isSubtypeOf(elementType, builtinInteger) !== true) {
			return builtinInteger;
		}
		const minimum = getIntegerMinimum(elementType);
		if (minimum === undefined
			|| (argsType.julType === 'list' && minimum < 0n)) {
			return builtinInteger;
		}
		sum += minimum;
	}
	return createCompileTimeBoundType('greater', 'integer', createIntegerLiteral(sum - 1n));
}

/**
 * Der kleinste Wert m, für den jeder Integer dieses Typs x ≥ m erfüllt. undefined heißt: nach
 * unten offen, oder die Grenze ist hier nicht ablesbar.
 */
function getIntegerMinimum(rawType: CompileTimeType): bigint | undefined {
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'integerLiteral':
			return type.value;
		case 'bound': {
			const value = type.Value;
			return type.Relation === 'greater'
				&& type.Family === 'integer'
				&& value.julType === 'integerLiteral'
				? value.value + 1n
				: undefined;
		}
		// Eine Länge ist nie 0 (siehe getLengthFromType).
		case 'lengthOf':
			return 1n;
		case 'and': {
			let maximum: bigint | undefined;
			for (const choiceType of type.ChoiceTypes) {
				const minimum = getIntegerMinimum(choiceType);
				if (minimum !== undefined
					&& (maximum === undefined || minimum > maximum)) {
					maximum = minimum;
				}
			}
			return maximum;
		}
		case 'or': {
			let minimum: bigint | undefined;
			for (const choiceType of type.ChoiceTypes) {
				const choiceMinimum = getIntegerMinimum(choiceType);
				if (choiceMinimum === undefined) {
					return undefined;
				}
				if (minimum === undefined || choiceMinimum < minimum) {
					minimum = choiceMinimum;
				}
			}
			return minimum;
		}
		default:
			return undefined;
	}
}

export function getLengthFromType(rawArgType: CompileTimeType | undefined): CompileTimeType {
	if (!rawArgType) {
		// TODO non negative
		return builtinInteger;
	}
	const argType = resolveAlias(rawArgType);
	switch (argType.julType) {
		case 'empty':
			return createIntegerLiteral(0n);
		case 'tuple':
			return createIntegerLiteral(BigInt(argType.ElementTypes.length));
		case 'list':
			return createCompileTimeLengthOfType(argType);
		case 'or': {
			const lengthChoices = argType.ChoiceTypes.map(getLengthFromType);
			return createNormalizedUnionType(lengthChoices);
		}
		default:
			// Quelle wartet noch auf weitere Auflösung (z.B. ein Feldzugriff wie history/gameStates
			// als nestedReference): Länge an die Quelle binden, statt sie auf ein anonymes Integer
			// abzuflachen - sonst erkennt ElementAt später nicht mehr, dass ein Index exakt diese
			// Länge ist (siehe dereferenceNestedKeyFromObject, case 'lengthOf').
			return isUnresolvedPlaceholderType(argType)
				? createCompileTimeLengthOfType(argType)
				// TODO non negative
				: builtinInteger;
	}
}

/**
 * Source mit Value an Position Index. Faltet so weit, wie die Position feststeht; solange Quelle
 * oder Index noch Platzhalter sind, bleibt der Knoten stehen und wird am Aufruf erneut gefaltet.
 */
export function withElementAtFromTypes(
	rawSourceType: CompileTimeType,
	rawIndexType: CompileTimeType,
	valueType: CompileTimeType,
): CompileTimeType {
	const sourceType = resolveAlias(rawSourceType);
	const indexType = resolveAlias(rawIndexType);
	// Ein Platzhalter kann sich noch zu einem Literal auflösen - dann steht genau eine Position
	// fest. Vorschnelles Falten würde stattdessen jede Position mit Value vereinigen.
	if (isUnresolvedPlaceholderType(sourceType)
		|| isUnresolvedPlaceholderType(indexType)) {
		return createCompileTimeWithElementAtType(sourceType, indexType, valueType);
	}
	if (isUnionType(indexType)) {
		const indexChoices = indexType.ChoiceTypes.map(indexChoice =>
			withElementAtFromTypes(sourceType, indexChoice, valueType));
		return createNormalizedUnionType(indexChoices);
	}
	switch (sourceType.julType) {
		case 'empty':
		case 'tuple': {
			// Empty ist ein 0-elementiges Tuple: dieselbe Positionslogik gilt für beide.
			const existingElementTypes = sourceType.julType === 'tuple' ? sourceType.ElementTypes : [];
			if (indexType.julType === 'integerLiteral') {
				// Liegt die Position hinter dem bisherigen Ende, entsteht eine Lücke - die muss
				// explizit mit Empty gefüllt werden. Ein rohes JS-Array-Loch (durch reines
				// Indexzuweisen über die Länge hinaus) wird beim nächsten Spread (z.B. beim
				// nächsten verketteten setElement, das existingElementTypes erneut kopiert) zu
				// einem echten undefined-Wert "verdichtet" - kein Loch mehr, sondern ein Element,
				// das kein CompileTimeType ist. Code, der jedes Element direkt anfasst (z.B.
				// typeToString), scheitert dann an undefined.julType.
				const position = Number(indexType.value);
				const elementTypes = [...existingElementTypes];
				for (let i = elementTypes.length; i < position - 1; i++) {
					elementTypes[i] = builtinEmpty;
				}
				elementTypes[position - 1] = valueType;
				return createCompileTimeTupleType(elementTypes);
			}
			if (existingElementTypes.length === 0) {
				// Ohne vorhandene Positionen UND ohne feste neue Position ist auch die Länge
				// unbekannt - anders als unten darf hier nicht einfach über nichts gemappt werden.
				return createCompileTimeListType(createNormalizedUnionType([builtinEmpty, valueType]));
			}
			// Ohne feste Position kann es jede vorhandene getroffen haben.
			return createCompileTimeTupleType(existingElementTypes.map(elementType =>
				createNormalizedUnionType([elementType, valueType])));
		}
		case 'list':
			return createCompileTimeListType(createNormalizedUnionType([sourceType.ElementType, valueType]));
		case 'or': {
			const sourceChoices = sourceType.ChoiceTypes.map(sourceChoice =>
				withElementAtFromTypes(sourceChoice, indexType, valueType));
			return createNormalizedUnionType(sourceChoices);
		}
		default:
			return builtinAny;
	}
}

//#endregion Sequenz Arithmetik

//#region Bedingte Typen

/**
 * `:?(Operanden)`: prüft die Kollektion der Operanden der Reihe nach gegen die Köpfe der Zweige.
 * Teilmenge: Ergebnis aufnehmen, fertig. Disjunkt: Zweig überspringen. Überlappend: Ergebnis
 * aufnehmen, weiter mit dem nächsten Zweig. Das Ergebnis ist die Union der aufgenommenen
 * Ergebnisse, ohne Treffer also Never.
 * Solange ein Operand noch Platzhalter enthält, bleibt der Knoten stehen und wird am Aufruf bzw.
 * per resolvePlaceholders erneut ausgewertet.
 */
export function createConditionalType(
	operands: CompileTimeType[],
	branches: ConditionalTypeBranch[],
): CompileTimeType {
	if (operands.some(isUnresolvedPlaceholderType)) {
		return createCompileTimeConditionalType(operands, branches);
	}
	const collection = operands.length
		? createCompileTimeTupleType(operands)
		: builtinEmpty;
	// Ganz im Kopf liegen die Operanden nur bewiesen. Steckt Any darin, ist das unbekannt, sie
	// überlappen den Kopf dann höchstens.
	const results: CompileTimeType[] = [];
	for (const branch of branches) {
		if (isSubtypeOf(collection, branch.Head) === true) {
			results.push(branch.Result);
			break;
		}
		if (typesOverlap(collection, branch.Head) === false) {
			continue;
		}
		results.push(branch.Result);
	}
	return createNormalizedUnionType(results);
}

//#endregion Bedingte Typen

//#region Typ Arithmetik

/**
 * Wartet dieser Typ noch auf den Aufrufort?
 * Choices, für die das gilt, werden nie verworfen und verwerfen auch nichts, damit die
 * Elimination im Zweifel keine Information wegwirft (Prinzip Freiheit) - isTypeAssignable prüft eine
 * parameterReference gegen ihren deklarierten Typ, ein Ja darüber würde sonst eine Elimination
 * erlauben, die den Platzhalter-Anteil verwirft, bevor er am Aufrufort genauer aufgelöst ist.
 * Reiner Feldzugriff: das Ergebnis wird beim Konstruieren berechnet (siehe die Konstruktoren in
 * syntax-tree.ts), weil die Frage pro Typ vielfach gestellt wird - unter anderem in einer
 * verschachtelten Schleife in removeSubtypes.
 */
export function isUnresolvedPlaceholderType(type: CompileTimeType): boolean {
	return type.isUnresolvedPlaceholder;
}

/**
 * Entfernt Choices, die bereits Teilmenge eines anderen Choice in derselben Liste sind:
 * Or(Boolean False) => [Boolean]. Bei struktureller Gleichwertigkeit (a Teilmenge von b und b
 * Teilmenge von a) gewinnt der frühere Index - sollte durch die Duplikat-Entfernung davor aber
 * ohnehin nicht mehr vorkommen.
 */
function removeSubtypes(choices: CompileTimeType[]): CompileTimeType[] {
	const isComparable = (type: CompileTimeType) =>
		!isUnresolvedPlaceholderType(type)
		&& !isOpaqueForNormalization(type);
	return choices.filter((choice, index) => {
		if (!isComparable(choice)) {
			return true;
		}
		return !choices.some((otherChoice, otherIndex) => {
			if (index === otherIndex
				|| !isComparable(otherChoice)) {
				return false;
			}
			if (isSubtypeOf(choice, otherChoice) !== true) {
				return false;
			}
			const otherIsAlsoSubtype = isSubtypeOf(otherChoice, choice) === true;
			return otherIsAlsoSubtype
				? otherIndex < index
				: true;
		});
	});
}

export function createNormalizedUnionType(choiceTypes: CompileTimeType[]): CompileTimeType {
	//#region flatten UnionTypes
	// Or(1 Or(2 3)) => Or(1 2 3)
	// Ein Alias auf eine Union wird NICHT aufgeflacht: er ist der einzige Träger seines Namens,
	// und die Dedup- bzw. Teilmengen-Elimination unten löst ihn ohnehin auf (typeEquals und
	// isTypeAssignable dealiasen beide).
	const flatChoices: CompileTimeType[] = choiceTypes.filter(choiceType =>
		!isUnionType(choiceType));
	const unionChoices = choiceTypes.filter(isUnionType);
	unionChoices.forEach(union => {
		flatChoices.push(...union.ChoiceTypes);
	});
	//#endregion flatten UnionTypes
	// Undurchsichtige Choices (isOpaqueForNormalization) werden hier nie aufgelöst: sie machen die
	// Union weder zu Any noch fallen sie als Never weg.
	if (flatChoices.some(choice =>
		!isOpaqueForNormalization(choice)
		&& resolveAlias(choice).julType === 'any')) {
		return builtinAny;
	}
	//#region remove Never
	const choicesWithoutNever = flatChoices.filter(choice =>
		isOpaqueForNormalization(choice)
		|| resolveAlias(choice).julType !== 'never');
	if (!choicesWithoutNever.length) {
		return builtinNever;
	}
	if (choicesWithoutNever.length === 1) {
		return choicesWithoutNever[0]!;
	}
	//#endregion remove Never
	//#region remove duplicates
	const uniqueChoices: CompileTimeType[] = [];
	choicesWithoutNever.forEach(choice => {
		if (!uniqueChoices.some(uniqueChoice =>
			isOpaqueForNormalization(choice) || isOpaqueForNormalization(uniqueChoice)
				? isSameOpaqueChoice(choice, uniqueChoice)
				: typeEquals(choice, uniqueChoice))) {
			uniqueChoices.push(choice);
		}
	});
	if (uniqueChoices.length === 1) {
		return uniqueChoices[0]!;
	}
	//#endregion remove duplicates
	//#region complement
	// Or(A Not(A)) => Any: jeder Wert liegt in A oder nicht. Gilt auch für ein Prädikat, dessen
	// Inhalt der Checker nicht kennt - nur so ist [isEven] … [Not(isEven)] erschöpfend.
	if (uniqueChoices.some(choice => {
		if (isOpaqueForNormalization(choice)) {
			return false;
		}
		const resolved = resolveAlias(choice);
		return isComplementType(resolved)
			&& uniqueChoices.some(other =>
				!isOpaqueForNormalization(other)
				&& typeEquals(other, resolved.SourceType));
	})) {
		return builtinAny;
	}
	//#endregion complement
	//#region collapse Boolean
	// Or(true false) => Boolean: die einzigen zwei möglichen Werte, kein Informationsverlust.
	if (uniqueChoices.length === 2
		&& uniqueChoices.some(choice => {
			const resolved = !isOpaqueForNormalization(choice) && resolveAlias(choice);
			return resolved && resolved.julType === 'booleanLiteral' && resolved.value === true;
		})
		&& uniqueChoices.some(choice => {
			const resolved = !isOpaqueForNormalization(choice) && resolveAlias(choice);
			return resolved && resolved.julType === 'booleanLiteral' && resolved.value === false;
		})) {
		return builtinBoolean;
	}
	//#endregion collapse Boolean
	//#region remove subtypes
	// Or(Boolean False) => Boolean: ein Choice, der schon Teilmenge eines anderen ist, trägt
	// keine zusätzliche Information mehr. Nur bis zu einer
	// Größenschwelle, sonst O(n²) mit isTypeAssignable - einem der teuersten Checker-Aufrufe (wie
	// TypeScript es bei getUnionType(..., UnionReduction.Subtype) macht). Choices, die nicht
	// sicher aufgelöst sind (parameterReference/nestedReference), werden nie verworfen und
	// verwerfen auch nichts - im Zweifel nicht kollabieren (Prinzip Freiheit).
	const reducedChoices = uniqueChoices.length <= subtypeReductionLimit
		? removeSubtypes(uniqueChoices)
		: uniqueChoices;
	if (reducedChoices.length === 1) {
		return reducedChoices[0]!;
	}
	//#endregion remove subtypes
	//#region collapse Streams
	// Or(Stream(1) Stream(2)) => Stream(Or(1 2))
	// TODO? diese Zusammenfassung ist eigentlich inhaltlich falsch, denn der Typ ist ungenauer
	// Or([1 1] [2 2]) != [Or(1 2) Or(1 2)] wegen Mischungen wie [1 2], [2 1] obwohl nur [1 1] oder [2 2] erlaubt sein sollten
	const streamChoices = reducedChoices.filter(isStreamType);
	let collapsedStreamChoices: CompileTimeType[];
	if (streamChoices.length > 1) {
		collapsedStreamChoices = [];
		const streamValueChoices = streamChoices.map(stream => stream.ValueType);
		const collapsedValueType = createNormalizedUnionType(streamValueChoices);
		collapsedStreamChoices.push(
			// Endlich nur, wenn jeder Choice endlich ist, sonst verspräche die Union mehr als ihre Teile.
			createCompileTimeStreamType(collapsedValueType, streamChoices.every(stream => stream.finite)),
			...reducedChoices.filter(choiceType =>
				!isStreamType(choiceType)),
		);
		if (collapsedStreamChoices.length === 1) {
			return collapsedStreamChoices[0]!;
		}
	}
	else {
		collapsedStreamChoices = reducedChoices;
	}
	//#endregion collapse Streams
	return createCompileTimeUnionType(collapsedStreamChoices);
}

/**
 * Der Typ von [...left ...right]: Felder von right überschreiben gleichnamige von left.
 * Eine Union verteilt sich über ihre Choices, auf jeder Seite. Empty trägt keine Felder bei.
 * Liefert undefined, wenn eine Seite kein Dictionary-Literal ist - dann ist nichts entscheidbar.
 */
export function spreadDictionaryTypes(
	rawLeft: CompileTimeType,
	rawRight: CompileTimeType,
	createDictionary: (fieldTypes: CompileTimeDictionary, complete: boolean) => CompileTimeType,
): CompileTimeType | undefined {
	const left = resolveAlias(rawLeft);
	const right = resolveAlias(rawRight);
	const distributed = isUnionType(left)
		? left.ChoiceTypes.map(choice => spreadDictionaryTypes(choice, right, createDictionary))
		: isUnionType(right)
			? right.ChoiceTypes.map(choice => spreadDictionaryTypes(left, choice, createDictionary))
			: undefined;
	if (distributed) {
		return distributed.every(isDefined)
			? createNormalizedUnionType(distributed)
			: undefined;
	}
	if (right.julType === 'empty') {
		return left;
	}
	if (left.julType === 'empty') {
		return right;
	}
	if (isDictionaryLiteralType(left)
		&& isDictionaryLiteralType(right)) {
		// Ist eine Seite unvollständig, kann der Wert weitere Felder haben, und das Ergebnis ebenso.
		return createDictionary(
			{
				...left.Fields,
				...right.Fields,
			},
			left.complete && right.complete);
	}
	return undefined;
}

export function createNormalizedIntersectionType(ChoiceTypes: CompileTimeType[]): CompileTimeType {
	// TODO flatten nested IntersectionTypes?

	if (ChoiceTypes.length === 2) {
		const first = resolveAlias(ChoiceTypes[0]!);
		const second = resolveAlias(ChoiceTypes[1]!);

		// Never ist das absorbierende Element:
		// And(A Never) => Never
		if (first.julType === 'never'
			|| second.julType === 'never') {
			return builtinNever;
		}

		// Any ist das neutrale Element:
		// And(A Any) => A
		// Außer neben einem Not: And(Any Not(Integer)) ist ein unbekannter Wert, der nur kein Integer
		// ist, etwa nach dem Verengen eines Any. Not(Integer) allein hieße "alles außer Integer" und
		// wäre damit keinem engeren Typ zuweisbar, das Unwissen ginge verloren.
		if (first.julType === 'any'
			&& !isComplementType(second)) {
			return ChoiceTypes[1]!;
		}
		if (second.julType === 'any'
			&& !isComplementType(first)) {
			return ChoiceTypes[0]!;
		}
	}

	// Ab hier bauen die Regeln den Typ um (Distribution, Feld-Merge, Teilmengen-Shortcut) - ein
	// Alias überlebt das ohnehin nicht, also gleich auf den aufgelösten Choices arbeiten.
	const resolvedChoices = ChoiceTypes.map(resolveAlias);

	// Distributivgesetz anwenden:
	// And(Or(A B) C) => Or(And(A C) And(B C)
	if (ChoiceTypes.length === 2) {
		// beide Seiten prüfen, damit die Reihenfolge der Argumente egal ist
		const unionIndex = resolvedChoices.findIndex(isUnionType);
		if (unionIndex >= 0) {
			const unionType = resolvedChoices[unionIndex] as CompileTimeUnionType;
			const otherIntersectionType = resolvedChoices[unionIndex ? 0 : 1]!;
			// Liegt die Union schon ganz in der anderen Seite, ändert der Schnitt nichts: die
			// geschriebene Union (mit ihrem Alias) statt einer neu gebauten. Dictionaries sind
			// ausgenommen, dort führt die Distribution unvollständige Felder zusammen.
			if (otherIntersectionType.julType !== 'dictionaryLiteral'
				&& isSubtypeOf(unionType, otherIntersectionType) === true) {
				return ChoiceTypes[unionIndex]!;
			}
			const distributedChoices = unionType.ChoiceTypes.map(choice => {
				return createNormalizedIntersectionType([choice, otherIntersectionType]);
			});
			const distributedType = createNormalizedUnionType(distributedChoices);
			return distributedType;
		}
	}

	if (resolvedChoices.length === 2
		&& isComplementType(resolvedChoices[1])) {
		const first = resolvedChoices[0]!;
		const second = resolvedChoices[1].SourceType;
		if (typeEquals(first, second)) {
			// And(A Not(A)) => Never
			return builtinNever;
		}
		// And(A Not(B))
		// Wenn B keine Schnittmenge mit A hat: nur A liefern. Dass B keine Teilmenge von A ist,
		// reicht nicht: Or(0 §a§) liegt nicht in Integer, schließt aber die 0 aus.
		if (typesOverlap(first, second) === false) {
			// Der geschriebene Typ statt des aufgelösten, damit ein Alias wie PositiveInteger in
			// der Anzeige erhalten bleibt.
			return ChoiceTypes[0]!;
		}
	}

	if (resolvedChoices.length === 2) {
		const first = resolvedChoices[0]!;
		const second = resolvedChoices[1]!;

		// Dictionaries sind Strukturen, keine Wertemengen: der Teilmengen-Shortcut unten würde bei
		// einer unvollständigen Seite (complete: false) Felder verlieren, die nur die andere Seite
		// kennt - "zuweisbar" heißt dort nur "widerspricht nicht nachweisbar", nicht "enthält schon
		// alles". Deshalb werden Felder hier stattdessen zusammengeführt, bevor der Shortcut greift.
		if (first.julType === 'dictionaryLiteral'
			|| second.julType === 'dictionaryLiteral') {
			if (first.julType === 'dictionaryLiteral'
				&& second.julType === 'dictionaryLiteral') {
				const keys = new Set([...Object.keys(first.Fields), ...Object.keys(second.Fields)]);
				const mergedFields: CompileTimeDictionary = {};
				for (const key of keys) {
					const firstFieldType = first.Fields[key];
					const secondFieldType = second.Fields[key];
					if (firstFieldType && secondFieldType) {
						const mergedFieldType = createNormalizedIntersectionType([firstFieldType, secondFieldType]);
						// Beide Seiten verlangen das Feld, kein Wert erfüllt beide: dann gibt es auch
						// kein Dictionary, das beide erfüllt. So fällt z.B. beim Verengen über
						// step/type die Choice mit dem anderen type aus der Union.
						if (mergedFieldType.julType === 'never') {
							return builtinNever;
						}
						mergedFields[key] = mergedFieldType;
					}
					else {
						mergedFields[key] = firstFieldType ?? secondFieldType!;
					}
				}
				return createCompileTimeDictionaryLiteralType(mergedFields, first.complete || second.complete);
			}
			if (typesOverlap(first, second) === false) {
				return builtinNever;
			}
			return createCompileTimeIntersectionType(ChoiceTypes);
		}

		// Teilmenge liefern:
		// And(A B) => A, wenn A Teilmenge von B ist
		// z.B. And(Integer Rational) => Integer, And(Integer Integer) => Integer
		// Any hat die Regel für das neutrale Element oben schon entschieden. Neben einem Not bleibt es
		// stehen und darf hier nicht als Obermenge wegfallen.
		if (first.julType !== 'any'
			&& second.julType !== 'any') {
			// Der geschriebene Typ statt des aufgelösten, damit ein Alias in der Anzeige erhalten bleibt.
			if (isSubtypeOf(first, second) === true) {
				return ChoiceTypes[0]!;
			}
			if (isSubtypeOf(second, first) === true) {
				return ChoiceTypes[1]!;
			}
		}

		// leere Schnittmenge:
		// And(A B) => Never, wenn A und B keinen gemeinsamen Wert haben
		// z.B. And(Integer Text) => Never
		if (typesOverlap(first, second) === false) {
			return builtinNever;
		}
	}

	const intersectionType = createCompileTimeIntersectionType(ChoiceTypes);
	// Grenzen ohne gemeinsame ganze Zahl, auch über mehr als zwei Choices:
	// And(Integer GreaterInteger(2) LessInteger(2)) => Never
	const range = getIntegerRange(intersectionType);
	if (range?.isInteger
		&& isEmptyIntegerRange(range)) {
		return builtinNever;
	}
	return intersectionType;
}

/**
 * Die grobe Laufzeit-Familie eines Typs. Werte aus verschiedenen Familien sind disjunkt,
 * ihr Schnitt ist also leer.
 * undefined = Familie unbekannt, dann ist keine Aussage über Disjunktheit möglich.
 */
function getTypeFamily(type: ResolvedType): string | undefined {
	switch (type.julType) {
		case 'blob':
			return 'blob';
		case 'boolean':
		case 'booleanLiteral':
			return 'boolean';
		case 'date':
			return 'date';
		case 'dictionary':
		case 'dictionaryLiteral':
			return 'dictionary';
		case 'empty':
			return 'empty';
		case 'error':
			return 'error';
		case 'float':
		case 'floatLiteral':
			return 'float';
		case 'function':
			return 'function';
		case 'integer':
		case 'integerLiteral':
			return 'integer';
		case 'bound':
			return type.Family;
		case 'list':
		case 'tuple':
			return 'list';
		case 'stream':
			return 'stream';
		case 'text':
		case 'textLiteral':
			return 'text';
		default:
			return undefined;
	}
}

/**
 * Haben die beiden Typen mindestens einen gemeinsamen Wert?
 * Das ist eine andere Relation als die Zuweisbarkeit (isTypeAssignable), die nur Teilmengen prüft:
 * Integer ist keine Teilmenge von 0, überlappt mit 0 aber sehr wohl.
 * undefined = unbekannt. Aufrufer müssen dann permissiv sein, sonst entstehen Falschfehler.
 */
/**
 * Sicher überlappend nur für dasselbe Prädikat oder einen konstanten Wert, für den es true
 * liefert. Sicher disjunkt, wenn der Wert es nicht erfüllt oder außerhalb der Obermenge liegt.
 */
function predicateOverlapsWith(predicate: CompileTimePredicateType, other: ResolvedType): boolean | undefined {
	if (other.julType === 'predicate'
		&& isSamePredicate(predicate, other)) {
		return true;
	}
	const folded = tryFoldPredicate(predicate, other);
	if (folded !== undefined) {
		return folded;
	}
	return typesOverlap(predicate.UpperBound, other) === false
		? false
		: undefined;
}

export function typesOverlap(rawFirst: CompileTimeType, rawSecond: CompileTimeType): boolean | undefined {
	const first = resolveAlias(rawFirst);
	const second = resolveAlias(rawSecond);
	// never enthält keinen Wert, any alle
	if (first.julType === 'never'
		|| second.julType === 'never') {
		return false;
	}
	if (first.julType === 'any'
		|| second.julType === 'any') {
		return true;
	}
	// Or überlappt, wenn ein Choice überlappt, und ist disjunkt, wenn alle Choices disjunkt sind
	if (isUnionType(first)) {
		return someTypeOverlaps(first.ChoiceTypes, second);
	}
	if (isUnionType(second)) {
		return someTypeOverlaps(second.ChoiceTypes, first);
	}
	// Aus den Teilen eines And lässt sich keine Überlappung bestätigen, aus Grenzen um ganze
	// Zahlen schon: And(Integer Not(GreaterInteger(3))) und GreaterInteger(2) teilen sich die 3.
	const firstRange = getIntegerRange(first);
	const secondRange = getIntegerRange(second);
	if (firstRange
		&& secondRange
		&& (firstRange.isInteger || secondRange.isInteger)) {
		const min = maxBound(firstRange.min, secondRange.min);
		const max = minBound(firstRange.max, secondRange.max);
		return min === undefined
			|| max === undefined
			|| min <= max;
	}
	// And ist disjunkt, sobald ein Choice disjunkt ist.
	// Überlappung lässt sich aus den Teilen dagegen nicht bestätigen.
	if (first.julType === 'and') {
		return everyTypeOverlaps(first.ChoiceTypes, second);
	}
	if (second.julType === 'and') {
		return everyTypeOverlaps(second.ChoiceTypes, first);
	}
	// A überlappt Not(B) genau dann, wenn A keine Teilmenge von B ist.
	if (isComplementType(first)) {
		return invertKnown(isSubtypeOf(second, first.SourceType));
	}
	if (isComplementType(second)) {
		return invertKnown(isSubtypeOf(first, second.SourceType));
	}
	if (first.julType === 'predicate') {
		return predicateOverlapsWith(first, second);
	}
	if (second.julType === 'predicate') {
		return predicateOverlapsWith(second, first);
	}
	const firstFamily = getTypeFamily(first);
	const secondFamily = getTypeFamily(second);
	if (!firstFamily
		|| !secondFamily) {
		return undefined;
	}
	if (firstFamily !== secondFamily) {
		return false;
	}
	//#region gleiche Familie
	// Innerhalb der Familie beantwortet eine Grenze nur die Bereichssicht oben. Konnte sie es nicht
	// (Float, unbekannter Wert), ist die Überlappung unbekannt, nicht wie beim Basistyp gegeben.
	if (first.julType === 'bound'
		|| second.julType === 'bound') {
		return undefined;
	}
	const firstIsLiteral = isLiteralType(first);
	const secondIsLiteral = isLiteralType(second);
	if (firstIsLiteral
		&& secondIsLiteral) {
		return typeEquals(first, second);
	}
	if (firstIsLiteral
		|| secondIsLiteral) {
		// ein Literal gegen den Basistyp derselben Familie: das Literal ist enthalten
		return true;
	}
	switch (firstFamily) {
		case 'list':
			return sequencesOverlap(first, second);
		// strukturierte Typen derselben Familie können sich beliebig überschneiden
		case 'dictionary':
		case 'function':
		case 'stream':
			return undefined;
		default:
			// zwei Basistypen derselben Familie, z.B. Integer und Integer
			return true;
	}
	//#endregion gleiche Familie
}

/**
 * Überlappung zweier Tuples oder Lists, Position für Position. Beide schließen das Leere aus, und
 * ein Tuple nennt nur Mindestpositionen: [Integer] und [Integer Text] teilen sich [1 §x§].
 * Gemeinsam ist ein Wert daher genau dann, wenn jede Position, die beide festlegen, überlappt.
 * Eine List legt jede Position auf ihren Elementtyp fest.
 */
function sequencesOverlap(first: ResolvedType, second: ResolvedType): boolean | undefined {
	let pairs: [CompileTimeType, CompileTimeType][];
	if (first.julType === 'tuple' && second.julType === 'tuple') {
		const length = Math.min(first.ElementTypes.length, second.ElementTypes.length);
		pairs = first.ElementTypes.slice(0, length).map((element, index) =>
			[element, second.ElementTypes[index]!]);
	}
	else if (first.julType === 'tuple' && second.julType === 'list') {
		pairs = first.ElementTypes.map(element => [element, second.ElementType]);
	}
	else if (first.julType === 'list' && second.julType === 'tuple') {
		pairs = second.ElementTypes.map(element => [first.ElementType, element]);
	}
	else if (first.julType === 'list' && second.julType === 'list') {
		pairs = [[first.ElementType, second.ElementType]];
	}
	else {
		return undefined;
	}
	const results = pairs.map(([firstElement, secondElement]) => typesOverlap(firstElement, secondElement));
	if (results.some(result => result === false)) {
		return false;
	}
	return results.every(result => result === true)
		? true
		: undefined;
}

/**
 * Die ganzen Zahlen eines Typs als lückenloser Bereich von min bis max (beide inklusive,
 * undefined = offen, min > max = leer). isInteger, wenn der Typ nur ganze Zahlen enthält. Sonst
 * beschreiben die Grenzen nur seine ganzzahligen Werte, etwa Not(GreaterInteger(2)) bis 2.
 */
interface IntegerRange {
	isInteger: boolean;
	min?: bigint;
	max?: bigint;
}

/**
 * Der Typ als IntegerRange. undefined, wenn er nicht allein aus Integer, Integer-Literalen,
 * GreaterInteger, LessInteger, deren Not mit Integer-Literal, And und Or besteht, oder wenn seine
 * ganzen Zahlen eine Lücke haben: Or(1 3) und And(Integer Not(3)) sind kein Bereich.
 */
function getIntegerRange(rawType: CompileTimeType): IntegerRange | undefined {
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'integer':
			return { isInteger: true };
		case 'integerLiteral':
			return { isInteger: true, min: type.value, max: type.value };
		case 'bound': {
			const value = resolveAlias(type.Value);
			if (type.Family !== 'integer'
				|| value.julType !== 'integerLiteral') {
				return undefined;
			}
			return type.Relation === 'greater'
				? { isInteger: true, min: value.value + 1n }
				: { isInteger: true, max: value.value - 1n };
		}
		// Not(GreaterInteger(3)) enthält außer den ganzen Zahlen bis 3 auch alles andere, etwa Text.
		case 'not': {
			const source = resolveAlias(type.SourceType);
			if (source.julType !== 'bound'
				|| source.Family !== 'integer') {
				return undefined;
			}
			const value = resolveAlias(source.Value);
			if (value.julType !== 'integerLiteral') {
				return undefined;
			}
			return source.Relation === 'greater'
				? { isInteger: false, max: value.value }
				: { isInteger: false, min: value.value };
		}
		case 'and': {
			let range: IntegerRange = { isInteger: false };
			// Ein Not(n) nimmt eine einzelne Zahl heraus. Das ist nur dann wieder ein Bereich, wenn
			// sie am Rand liegt: ≤ 3 ohne 3 ist ≤ 2.
			const excluded: bigint[] = [];
			for (const choiceType of type.ChoiceTypes) {
				const choice = resolveAlias(choiceType);
				if (choice.julType === 'not') {
					const source = resolveAlias(choice.SourceType);
					if (source.julType === 'integerLiteral') {
						excluded.push(source.value);
						continue;
					}
				}
				const choiceRange = getIntegerRange(choice);
				if (!choiceRange) {
					return undefined;
				}
				range = {
					isInteger: range.isInteger || choiceRange.isInteger,
					min: maxBound(range.min, choiceRange.min),
					max: minBound(range.max, choiceRange.max),
				};
			}
			return excludeFromIntegerRange(range, excluded);
		}
		case 'or': {
			const ranges: IntegerRange[] = [];
			for (const choiceType of type.ChoiceTypes) {
				const choiceRange = getIntegerRange(choiceType);
				if (!choiceRange) {
					return undefined;
				}
				if (!isEmptyIntegerRange(choiceRange)) {
					ranges.push(choiceRange);
				}
			}
			return unionOfIntegerRanges(ranges);
		}
		default:
			return undefined;
	}
}

function isEmptyIntegerRange(range: IntegerRange): boolean {
	return range.min !== undefined
		&& range.max !== undefined
		&& range.min > range.max;
}

/**
 * Nimmt einzelne Zahlen aus dem Bereich heraus. Am Rand verschiebt das die Grenze, so lange, bis
 * der Rand nicht mehr ausgenommen ist. Liegt eine Zahl im Inneren, hat der Bereich eine Lücke.
 */
function excludeFromIntegerRange(range: IntegerRange, excluded: bigint[]): IntegerRange | undefined {
	let { min, max } = range;
	let remaining = excluded;
	let changed = true;
	while (changed) {
		changed = false;
		remaining = remaining.filter(value => {
			if (value === min) {
				min = value + 1n;
				changed = true;
				return false;
			}
			if (value === max) {
				max = value - 1n;
				changed = true;
				return false;
			}
			return true;
		});
	}
	const result = { isInteger: range.isInteger, min, max };
	if (isEmptyIntegerRange(result)) {
		return result;
	}
	const hasHole = remaining.some(value =>
		(min === undefined || value > min)
		&& (max === undefined || value < max));
	return hasHole ? undefined : result;
}

/**
 * Die Vereinigung, falls sie wieder lückenlos ist: überlappend oder angrenzend, bei ganzen Zahlen
 * also auch 3 und 4. Leer, wenn es keinen Bereich gibt.
 */
function unionOfIntegerRanges(ranges: IntegerRange[]): IntegerRange | undefined {
	const isInteger = ranges.every(range => range.isInteger);
	if (!ranges.length) {
		return { isInteger: true, min: 1n, max: 0n };
	}
	// Nach unterer Grenze sortiert, offen nach unten zuerst.
	const sorted = [...ranges].sort((first, second) => {
		if (first.min === second.min) {
			return 0;
		}
		if (first.min === undefined) {
			return -1;
		}
		if (second.min === undefined) {
			return 1;
		}
		return first.min < second.min ? -1 : 1;
	});
	const min = sorted[0]!.min;
	let max = sorted[0]!.max;
	for (const range of sorted.slice(1)) {
		if (max === undefined) {
			// Schon nach oben offen, alles Weitere liegt darin.
			break;
		}
		if (range.min! > max + 1n) {
			return undefined;
		}
		max = range.max === undefined || range.max > max
			? range.max
			: max;
	}
	return { isInteger, min, max };
}

/** Die größere zweier unteren Grenzen, undefined = offen. */
function maxBound(first: bigint | undefined, second: bigint | undefined): bigint | undefined {
	if (first === undefined) {
		return second;
	}
	if (second === undefined) {
		return first;
	}
	return first > second ? first : second;
}

/** Die kleinere zweier oberen Grenzen, undefined = offen. */
function minBound(first: bigint | undefined, second: bigint | undefined): bigint | undefined {
	if (first === undefined) {
		return second;
	}
	if (second === undefined) {
		return first;
	}
	return first < second ? first : second;
}

function someTypeOverlaps(choiceTypes: CompileTimeType[], other: CompileTimeType): boolean | undefined {
	const results = choiceTypes.map(choiceType => typesOverlap(choiceType, other));
	if (results.some(result => result === true)) {
		return true;
	}
	return results.every(result => result === false)
		? false
		: undefined;
}

function everyTypeOverlaps(choiceTypes: CompileTimeType[], other: CompileTimeType): boolean | undefined {
	const results = choiceTypes.map(choiceType => typesOverlap(choiceType, other));
	return results.some(result => result === false)
		? false
		: undefined;
}

/** Kehrt ein bekanntes Ergebnis um, unbekannt bleibt unbekannt. */
function invertKnown(value: boolean | undefined): boolean | undefined {
	return value === undefined ? undefined : !value;
}

function isLiteralType(type: ResolvedType): boolean {
	switch (type.julType) {
		case 'booleanLiteral':
		case 'floatLiteral':
		case 'integerLiteral':
		case 'textLiteral':
			return true;
		default:
			return false;
	}
}

// 'unknown', 'impure' und 'pureIfArgsPure' fallen zusammen, weil kein Algorithmus sie
// unterscheidet - sonst bekäme createNormalizedUnionType eine zweite künstliche Trennung.
function effectivePurity(purity: TypePurity): 'pure' | 'notPure' {
	return purity === 'pure' ? 'pure' : 'notPure';
}

function isAliasApplication(type: CompileTimeType): type is CompileTimeAliasType & { args: CompileTimeType; } {
	return type.julType === 'alias' && !!type.args;
}

/**
 * Dieselbe Typfunktion mit gleichen Argumenten, etwa Tree(Integer) und Tree(Integer) aus zwei
 * Auflösungen: gleich, ohne aufzulösen.
 */
function isSameAliasApplication(first: CompileTimeType, second: CompileTimeType): boolean {
	return isAliasApplication(first)
		&& isAliasApplication(second)
		&& first.symbol === second.symbol
		&& typeEquals(first.args, second.args);
}

/**
 * Für den Stapel laufender Alias-Vergleiche: jede Auflösung von Tree(Text) erzeugt einen neuen
 * inneren Knoten, derselbe Vergleich eine Ebene tiefer wäre an der Identität nicht zu erkennen.
 */
function isSameOrSameAliasApplication(first: CompileTimeType, second: CompileTimeType): boolean {
	return first === second
		|| isSameAliasApplication(first, second);
}

export function typeEquals(first: CompileTimeType, second: CompileTimeType): boolean {
	if (first === second) {
		return true;
	}
	// Dieselbe Notbremse wie in isTypeAssignable. Hier fällt sie auf "nicht gleich" zurück: eine
	// ausgelassene Deduplizierung ist harmlos, eine fälschlich angenommene Gleichheit nicht.
	if (typeEqualsDepth >= maxTypeComparisonDepth) {
		return false;
	}
	typeEqualsDepth++;
	try {
		return typeEqualsAtDepth(first, second);
	}
	finally {
		typeEqualsDepth--;
	}
}

function typeEqualsAtDepth(first: CompileTimeType, second: CompileTimeType): boolean {
	// Der Alias ist reine Beschriftung: geprüft wird der Typ dahinter. Vor dem switch, weil sonst
	// jeder Zweig seinen eigenen Alias-Fall auf der Gegenseite bräuchte.
	// Liegt das Paar bereits auf dem Stack, gilt es als gleich - dieselbe coinduktive Annahme wie
	// in isTypeAssignable, ohne die der Vergleich rekursiver Typen nicht endet.
	if (first.julType === 'alias'
		|| second.julType === 'alias') {
		if (aliasEqualityInProgress.some(pair =>
			isSameOrSameAliasApplication(pair.first, first)
			&& isSameOrSameAliasApplication(pair.second, second))) {
			return true;
		}
		if (isSameAliasApplication(first, second)) {
			return true;
		}
		if (!aliasEqualityInProgress.length) {
			typeEqualsApplicationExpansionsRemaining = maxAliasApplicationExpansions;
		}
		if (isAliasApplication(first) || isAliasApplication(second)) {
			// Wie bei der Tiefenbremse "nicht gleich": eine ausgelassene Deduplizierung ist harmlos.
			if (typeEqualsApplicationExpansionsRemaining <= 0) {
				return false;
			}
			typeEqualsApplicationExpansionsRemaining--;
		}
		aliasEqualityInProgress.push({ first: first, second: second });
		try {
			return typeEquals(
				first.julType === 'alias' ? dereferenceAlias(first) : first,
				second.julType === 'alias' ? dereferenceAlias(second) : second);
		}
		finally {
			aliasEqualityInProgress.pop();
		}
	}
	switch (first.julType) {
		case 'empty':
		case 'any':
		case 'blob':
		case 'boolean':
		case 'date':
		case 'error':
		case 'integer':
		case 'float':
		case 'never':
		case 'text':
		case 'type':
			return first.julType === second.julType;
		case 'booleanLiteral':
		case 'integerLiteral':
		case 'floatLiteral':
		case 'textLiteral':
			return first.julType === second.julType
				&& first.value === second.value;
		case 'dictionary':
			return second.julType === 'dictionary'
				&& typeEquals(first.ElementType, second.ElementType);
		case 'bound':
			return second.julType === 'bound'
				&& first.Relation === second.Relation
				&& first.Family === second.Family
				&& typeEquals(first.Value, second.Value);
		case 'lengthOf':
			return second.julType === 'lengthOf'
				&& typeEquals(first.Source, second.Source);
		case 'list':
			return second.julType === 'list'
				&& typeEquals(first.ElementType, second.ElementType);
		case 'not':
			return second.julType === 'not'
				&& typeEquals(first.SourceType, second.SourceType);
		case 'stream':
			return second.julType === 'stream'
				&& first.finite === second.finite
				&& typeEquals(first.ValueType, second.ValueType);
		case 'typeOf':
			return second.julType === 'typeOf'
				&& typeEquals(first.value, second.value);
		case 'function':
			return second.julType === 'function'
				&& typeEquals(first.ParamsType, second.ParamsType)
				&& typeEquals(first.ReturnType, second.ReturnType)
				&& effectivePurity(first.purity) === effectivePurity(second.purity);
		case 'conditional':
			return second.julType === 'conditional'
				&& first.Operands.length === second.Operands.length
				&& first.Operands.every((operand, i) => typeEquals(operand, second.Operands[i]!))
				&& first.Branches.length === second.Branches.length
				&& first.Branches.every((branch, i) =>
					typeEquals(branch.Head, second.Branches[i]!.Head)
					&& typeEquals(branch.Result, second.Branches[i]!.Result));
		case 'withElementAt':
			return second.julType === 'withElementAt'
				&& typeEquals(first.Source, second.Source)
				&& typeEquals(first.Index, second.Index)
				&& typeEquals(first.Value, second.Value);
		case 'indexRange':
			return second.julType === 'indexRange'
				&& typeEquals(first.Start, second.Start)
				&& typeEquals(first.End, second.End);
		case 'mapElements':
			// Der Callback zählt als Objekt: seine Parameterverweise hängen an genau diesem.
			return second.julType === 'mapElements'
				&& typeEquals(first.Source, second.Source)
				&& first.Callback === second.Callback
				&& first.deferValueOf === second.deferValueOf;
		case 'concat':
			return second.julType === 'concat'
				&& first.Sources.length === second.Sources.length
				&& first.Sources.every((source, i) => typeEquals(source, second.Sources[i]!));
		case 'add':
			return second.julType === 'add'
				&& typeEquals(first.ArgsType, second.ArgsType);
		case 'tuple':
			return second.julType === 'tuple'
				&& first.ElementTypes.length === second.ElementTypes.length
				&& first.ElementTypes.every((elem, i) => typeEquals(elem, second.ElementTypes[i]!));
		case 'or':
			// Or-Typen sind Mengen, nicht Sequenzen: Reihenfolge ist egal,
			// aber jede Choice muss in beiden vorhanden sein.
			return second.julType === 'or'
				&& first.ChoiceTypes.length === second.ChoiceTypes.length
				&& first.ChoiceTypes.every(choice =>
					second.ChoiceTypes.some(otherChoice => typeEquals(choice, otherChoice)));
		case 'and':
			// Wie 'or': Schnittmengen sind kommutativ
			return second.julType === 'and'
				&& first.ChoiceTypes.length === second.ChoiceTypes.length
				&& first.ChoiceTypes.every(choice =>
					second.ChoiceTypes.some(otherChoice => typeEquals(choice, otherChoice)));
		case 'dictionaryLiteral':
			return second.julType === 'dictionaryLiteral'
				&& Object.keys(first.Fields).length === Object.keys(second.Fields).length
				&& Object.entries(first.Fields).every(([key, value]) => {
					const otherValue = second.Fields[key];
					return otherValue !== undefined && typeEquals(value, otherValue);
				});
		case 'parameterReference':
			return second.julType === 'parameterReference'
				&& first.name === second.name
				&& first.index === second.index
				&& first.deferValueOf === second.deferValueOf;
		case 'nestedReference':
			return second.julType === 'nestedReference'
				&& nestedKeysEqual(first.nestedKey, second.nestedKey)
				&& typeEquals(first.source, second.source)
				&& first.deferValueOf === second.deferValueOf;
		case 'parameters':
			return second.julType === 'parameters'
				&& first.singleNames.length === second.singleNames.length
				&& first.singleNames.every((param, i) => {
					const otherParam = second.singleNames[i];
					return otherParam !== undefined
						&& param.name === otherParam.name
						&& (param.type === undefined && otherParam.type === undefined
							|| param.type !== undefined && otherParam.type !== undefined && typeEquals(param.type, otherParam.type));
				})
				&& (first.rest === undefined && second.rest === undefined
					|| first.rest !== undefined && second.rest !== undefined
					&& first.rest.name === second.rest.name
					&& (first.rest.type === undefined && second.rest.type === undefined
						|| first.rest.type !== undefined && second.rest.type !== undefined && typeEquals(first.rest.type, second.rest.type)));
		case 'predicate':
			return second.julType === 'predicate'
				&& isSamePredicate(first, second);
		default:
			const assertNever: never = first;
			throw new Error('Unexpected julType: ' + (assertNever as CompileTimeType).julType);
	}
}

/**
 * Zwei Prädikate sind gleich, wenn es dieselbe Funktion ist und sie rein ist - nur dann liefert
 * sie für denselben Wert bei jeder Auswertung dasselbe. Gleiches Verhalten zweier verschiedener
 * Funktionen lässt sich nicht feststellen. Eine fälschlich angenommene Gleichheit wäre unsound,
 * deshalb zählt nur dasselbe Funktionstyp-Objekt. Auch das reicht nicht, wenn das Literal in
 * einer anderen Funktion steht: dann ist der Funktionstyp der deklarierte Rückgabetyp, den jeder
 * Aufruf teilt, und divisibleBy(5) wäre dasselbe wie divisibleBy(3). Solange der Funktionstyp
 * nicht festhält, woran seine freien Referenzen gebunden sind, gilt so ein Prädikat nie als gleich.
 */
function isSamePredicate(first: CompileTimePredicateType, second: CompileTimePredicateType): boolean {
	const firstFunction = first.FunctionType;
	const secondFunction = second.FunctionType;
	if (firstFunction.purity !== 'pure'
		|| secondFunction.purity !== 'pure') {
		return false;
	}
	const literal = firstFunction.literal;
	if (!literal) {
		// Ohne Literal (nativeFunction, Import aus .ts) bleibt nur dasselbe Objekt.
		return firstFunction === secondFunction;
	}
	if (literal !== secondFunction.literal) {
		return false;
	}
	if (!isInsideFunctionLiteral(literal)) {
		return true;
	}
	const firstBound = firstFunction.boundArguments;
	const secondBound = secondFunction.boundArguments;
	return !!firstBound
		&& !!secondBound
		&& haveSameBoundValues(firstBound.values, secondBound.values);
}

function haveSameBoundValues(
	first: { [name: string]: unknown; },
	second: { [name: string]: unknown; },
): boolean {
	const names = Object.keys(first);
	return names.length === Object.keys(second).length
		&& names.every(name =>
			name in second
			&& runtime.deepEqual(first[name], second[name]));
}

//#endregion Typ Arithmetik

/**
 * Der Typ hinter einem Alias.
 * Any, solange das Symbol noch gecheckt wird - das ist der Zyklusfall, und unproduktive Zyklen
 * sind an dieser Stelle bereits als JUL5170 gemeldet.
 */
function dereferenceAlias(alias: CompileTimeAliasType): CompileTimeType {
	const symbolType = alias.symbol.typeInfo?.type;
	if (!symbolType) {
		return builtinAny;
	}
	if (alias.args) {
		return dereferenceAliasApplication(alias, alias.args, symbolType);
	}
	// Eine Typdefinition hält ihren Typ als TypeOf; der Alias steht für den Typ selbst.
	return symbolType.julType === 'typeOf'
		? symbolType.value
		: symbolType;
}

/**
 * Ein Alias, dessen Definition gerade geprüft wird (`Node` in `Node = [left: Or([] Node)]`): sein
 * Symbol hat noch keinen Typ, aufgelöst ergibt er Any. Wer Typen dabei vergleicht oder
 * zusammenfasst, darf das nicht für bare Münze nehmen - er steht für den fertigen Typ.
 */
function isPendingAlias(type: CompileTimeType): type is CompileTimeAliasType {
	return type.julType === 'alias'
		&& !type.symbol.typeInfo;
}

/**
 * Choices, die das Normalisieren einer Union nicht auflösen darf: ein Alias in Prüfung (aufgelöst
 * Any, siehe isPendingAlias) und eine Anwendung wie Bin(T) - ihre Auflösung enthielte wieder ein Or
 * mit einer Anwendung, das Normalisieren liefe endlos. Sie verwerfen nichts, werden nicht verworfen
 * und gelten nur bei gleichem Symbol und gleichen args als Duplikat.
 */
function isOpaqueForNormalization(type: CompileTimeType): boolean {
	return isPendingAlias(type)
		|| isAliasApplication(type);
}

function isSameOpaqueChoice(first: CompileTimeType, second: CompileTimeType): boolean {
	if (first === second) {
		return true;
	}
	if (first.julType !== 'alias'
		|| second.julType !== 'alias'
		|| first.symbol !== second.symbol) {
		return false;
	}
	return first.args && second.args
		? typeEquals(first.args, second.args)
		: !first.args && !second.args;
}

/**
 * Tree(T) als Rückgabetyp der fertigen Typfunktion mit diesen Argumenten, eine Ebene tief: die
 * Selbstanwendung darin bleibt wieder ein Knoten. Erst hier, nicht beim Erzeugen, denn beim
 * Erzeugen wird die Typfunktion selbst noch geprüft.
 */
function dereferenceAliasApplication(
	alias: CompileTimeAliasType,
	args: CompileTimeType,
	symbolType: CompileTimeType,
): CompileTimeType {
	const cached = aliasApplicationCache.get(alias);
	if (cached) {
		return cached;
	}
	const functionType = resolveAlias(symbolType);
	if (!isFunctionType(functionType)) {
		return builtinAny;
	}
	const returnType = dereferenceArgumentTypesNested(symbolType, args, functionType.ReturnType);
	// Wie bei einer Typdefinition steht der Typ als TypeOf, der Alias steht für den Typ selbst.
	const dereferenced = returnType.julType === 'typeOf'
		? returnType.value
		: returnType;
	aliasApplicationCache.set(alias, dereferenced);
	return dereferenced;
}

/**
 * Der Typ ohne Alias-Hüllen, auch mehrfach geschachtelte (B = A = ...).
 * Die Schleifengrenze ist eine Notbremse: unproduktive Zyklen meldet bereits JUL5170, aber ein
 * hängender Language Server wäre ein schlechterer Ausgang als ein ungenauer Typ.
 */
export function resolveAlias(type: CompileTimeType): ResolvedType {
	let current = type;
	for (let depth = 0; current.julType === 'alias'; depth++) {
		if (depth >= maxAliasDepth) {
			return builtinAny;
		}
		current = dereferenceAlias(current);
	}
	return current;
}

/**
 * Die Menge der Werte, für die functionType true liefert, soweit der Checker sie kennt.
 * Obermenge ist der erste Parametertyp, denn die Laufzeit bindet den Wert als einziges Argument
 * und ein unpassender Wert erfüllt das Prädikat nicht. Dazu kommen die erkannten Fakten.
 */
function createPredicateFromFunctionType(functionType: CompileTimeFunctionType): CompileTimePredicateType {
	const parameterType = getFirstParameterType(functionType.ParamsType);
	const facts = functionType.predicate;
	const upperBound = facts
		? createNormalizedIntersectionType([parameterType, facts.ifTrue])
		: parameterType;
	const name = functionType.boundArguments?.display
		?? (functionType.literal && getNameFromValue(functionType.literal));
	return createCompileTimePredicateType(functionType, upperBound, facts?.excludedIfFalse ?? builtinNever, name);
}

/**
 * Was ein einzelnes Argument erfüllen muss, um an die erste Stelle gebunden zu werden.
 * Ohne Parameter wird ein einzelnes Argument schlicht nicht gebunden, jeder Wert passt.
 */
function getFirstParameterType(paramsType: CompileTimeType): CompileTimeType {
	if (isParametersType(paramsType)) {
		const firstParameter = paramsType.singleNames[0];
		if (firstParameter) {
			return firstParameter.type ?? builtinAny;
		}
		const restType = paramsType.rest?.type;
		return restType
			? getElementTypeAtIndex(restType, 0) ?? builtinAny
			: builtinAny;
	}
	return getElementTypeAtIndex(paramsType, 0) ?? builtinAny;
}

export function valueOf(type: CompileTimeType | undefined): CompileTimeType {
	if (!type) {
		return builtinAny;
	}
	switch (type.julType) {
		case 'dictionaryLiteral': {
			const fieldValues = mapDictionary(type.Fields, valueOf);
			return createCompileTimeDictionaryLiteralType(fieldValues, type.complete);
		}
		case 'function':
			// Ein Funktionswert in Typ-Position ist ein Prädikat. Das Funktionstyp-Literal kommt
			// hier nicht an: es steht als TypeOf(F) und wird oben zu F ausgepackt.
			return createPredicateFromFunctionType(type);
		case 'predicate':
			return type;
		case 'mapElements':
		case 'nestedReference':
			// Wie bei parameterReference: aufgelöst und ausgepackt wird am Aufruf.
			return type.deferValueOf
				? type
				: { ...type, deferValueOf: true };
		case 'parameters':
			return type;
		case 'parameterReference':
			// Der Argumenttyp steht erst beim Aufruf fest, dort holt traversePlaceholders das
			// valueOf nach.
			return type.deferValueOf
				? type
				: { ...type, deferValueOf: true };
		case 'stream':
			// TODO?
			return type;
		case 'tuple':
			return createCompileTimeTupleType(type.ElementTypes.map(valueOf));
		// Wie beim Tuple je Element, nur mit offener Länge: eine List, deren Elemente Typwerte
		// sind, als Typ gelesen ist die List dieser Typen.
		case 'list': {
			const elementValue = valueOf(type.ElementType);
			return elementValue === type.ElementType
				? type
				: createCompileTimeListType(elementValue);
		}
		case 'dictionary': {
			const elementValue = valueOf(type.ElementType);
			return elementValue === type.ElementType
				? type
				: createCompileTimeDictionaryType(elementValue);
		}
		case 'or': {
			// Der Wert ist einer der Choices, als Typ gelesen also die Union ihrer Werte:
			// Or(TypeOf(Integer) TypeOf(Text)) wird zu Or(Integer Text). Neu gebaut wird nur, wenn
			// sich ein Choice ändert, das Normalisieren der Union ist nicht billig.
			const choiceValues = type.ChoiceTypes.map(valueOf);
			return choiceValues.every((choiceValue, index) => choiceValue === type.ChoiceTypes[index])
				? type
				: createNormalizedUnionType(choiceValues);
		}
		case 'typeOf':
			return type.value;
		// Kein TypeOf zum Auspacken und keine Felder, die eines enthalten könnten: der Typ ist
		// bereits der Wert. Zusammengesetzte Varianten steigen bewusst nicht ab - ein TypeOf
		// darin ist Teil des Typs, nicht seine Verpackung.
		case 'alias':
		case 'and':
		case 'any':
		case 'blob':
		case 'add':
		case 'boolean':
		case 'booleanLiteral':
		case 'concat':
		case 'conditional':
		case 'date':
		case 'empty':
		case 'error':
		case 'float':
		case 'floatLiteral':
		case 'bound':
		case 'integer':
		case 'integerLiteral':
		case 'lengthOf':
		case 'never':
		case 'not':
		case 'indexRange':
		case 'text':
		case 'textLiteral':
		case 'type':
		case 'withElementAt':
			return type;
		default: {
			const assertNever: never = type;
			throw new Error('Unexpected type.julType: ' + (assertNever as CompileTimeType).julType);
		}
	}
}

//#region TypeAssignability

/**
 * Die Argumente eines Aufrufs gegen seine Parameter. Geprüft wird zuerst ungelöst, denn die
 * Argumente können generische Typwerte enthalten (etwa die Signatur eines nativeFunction-Aufrufs).
 * Bleibt das unbekannt, wird mit aufgelösten Platzhaltern beider Seiten wiederholt, so wie es die
 * Prüfung des Rückgabewerts tut: Ein Lambda behält für seinen Parameter etwa TypeOf(row)/ElementType,
 * während der Callback-Parameter des Ziels schon zu Cell aufgelöst ist. Beide meinen dasselbe.
 * Die Wiederholung darf nur beweisen, nie ablehnen: Aufgelöst verliert ein Platzhalter seine
 * Bedeutung als Typwert, aus dem Prädikat p in (a: p) würde ein gewöhnlicher Funktionstyp.
 */
export function getArgumentsAssignability(argsType: CompileTimeType, paramsType: CompileTimeType): TypeAssignability {
	const assignability = isTypeAssignable(argsType, paramsType);
	if (assignability.assignable !== undefined) {
		return assignability;
	}
	const resolvedAssignability = isTypeAssignable(resolvePlaceholders(argsType), resolvePlaceholders(paramsType));
	return resolvedAssignability.assignable === true
		? resolvedAssignability
		: assignability;
}

/**
 * Liegt jeder Wert von type in superType? true bewiesen ja, false bewiesen nein, undefined unbekannt.
 * Immer mit === true bzw. === false vergleichen: !isSubtypeOf(…) hieße "nein oder unbekannt".
 */
export function isSubtypeOf(type: CompileTimeType, superType: CompileTimeType): boolean | undefined {
	return isTypeAssignable(type, superType).assignable;
}

export function isTypeAssignable(
	argumentsType: CompileTimeType,
	targetType: CompileTimeType,
): TypeAssignability {
	if (typeComparisonDepth >= maxTypeComparisonDepth) {
		return { assignable: false, error: new TypeError('Type comparison is excessively deep and possibly infinite.') };
	}
	typeComparisonDepth++;
	try {
		return isTypeAssignableAtDepth(argumentsType, targetType);
	}
	finally {
		typeComparisonDepth--;
	}
}

type TypeAssignability =
	| {
		assignable: false;
		error: TypeError;
	}
	| {
		assignable: true | undefined;
	}

function isTypeAssignableAtDepth(
	argumentsType: CompileTimeType,
	targetType: CompileTimeType,
): TypeAssignability {
	checkerStats.getTypeError++;
	if (targetType.julType === 'any') {
		return { assignable: true };
	}
	if (argumentsType.julType === 'any') {
		// TODO error/warning bei any?
		// error type bei assignment/function call?
		// maybe return value?
		return { assignable: undefined };
	}
	if (argumentsType === targetType) {
		return { assignable: true };
	}
	// Die leere Menge liegt in jedem Typ. Ein unmöglicher Typ soll dort gemeldet werden, wo er
	// entsteht, nicht an jeder Verwendung.
	if (argumentsType.julType === 'never') {
		return { assignable: true };
	}
	// Der Alias ist reine Beschriftung: zugewiesen wird gegen den Typ dahinter, in beide Richtungen.
	// Liegt das Paar bereits auf dem Stack, gilt es als zuweisbar - bei rekursiven Typen ist das
	// die einzige Annahme, unter der der Vergleich überhaupt endet (TypeScripts "maybe stack").
	if (argumentsType.julType === 'alias'
		|| targetType.julType === 'alias') {
		// Mit einer Anwendung (Tree(T)) beteiligt ist jede Seite bei jeder Auflösung ein neues Objekt,
		// auch die Union oder das Dictionary neben ihr: dann nur strukturell wiederzuerkennen. Sonst
		// genügt die Identität, das hält die vielen gewöhnlichen Alias-Vergleiche billig.
		const involvesApplication = isAliasApplication(argumentsType) || isAliasApplication(targetType);
		if (aliasComparisonsInProgress.some(pair =>
			involvesApplication
				? typeEquals(pair.args, argumentsType) && typeEquals(pair.target, targetType)
				: pair.args === argumentsType && pair.target === targetType)) {
			// Koinduktiv: Findet der Vergleich sonst nirgends ein Nein, ist es eine Teilmenge. Das gilt,
			// weil ein Typ sich nur über ein Feld, eine Liste, ein Tuple, einen Stream oder eine
			// Funktion selbst enthalten darf (Circular type definition), nie direkt über Or oder And.
			return { assignable: true };
		}
		if (isSameAliasApplication(argumentsType, targetType)) {
			return { assignable: true };
		}
		if (!aliasComparisonsInProgress.length) {
			aliasApplicationExpansionsRemaining = maxAliasApplicationExpansions;
		}
		if (isAliasApplication(argumentsType) || isAliasApplication(targetType)) {
			// Siehe maxAliasApplicationExpansions: im Zweifel zuweisbar, wie beim Stapel.
			if (aliasApplicationExpansionsRemaining <= 0) {
				return { assignable: undefined };
			}
			aliasApplicationExpansionsRemaining--;
		}
		aliasComparisonsInProgress.push({ args: argumentsType, target: targetType });
		try {
			return isTypeAssignable(
				argumentsType.julType === 'alias' ? dereferenceAlias(argumentsType) : argumentsType,
				targetType.julType === 'alias' ? dereferenceAlias(targetType) : targetType);
		}
		finally {
			aliasComparisonsInProgress.pop();
		}
	}
	// Ganze Zahlen zwischen zwei Grenzen passen genau dann, wenn beide Grenzen im target liegen.
	// Die Zerlegung unten geht über Or(T B) und verlangt dort einen einzelnen passenden Choice, das
	// scheitert schon an And(Integer Not(GreaterInteger(2))) gegen Not(GreaterInteger(3)).
	// Passt es nicht, liefert die Zerlegung die genauere Meldung, etwa gegen welchen Teil des targets.
	const fitsRange = integerRangeFits(argumentsType, targetType);
	if (fitsRange === true) {
		return { assignable: true };
	}
	if (fitsRange === false) {
		const structureAssignability = isTypeAssignableByStructure(argumentsType, targetType);
		return structureAssignability.assignable === false
			? structureAssignability
			: getDefaultTypeError(argumentsType, targetType);
	}
	return isTypeAssignableByStructure(argumentsType, targetType);
}

/**
 * Liegen die ganzen Zahlen des Werts sicher im target (true) oder sicher nicht (false)?
 * undefined, wenn einer der beiden Typen sich nicht als Integer-Bereich lesen lässt.
 */
function integerRangeFits(argumentsType: CompileTimeType, targetType: CompileTimeType): boolean | undefined {
	const argumentsRange = getIntegerRange(argumentsType);
	if (!argumentsRange?.isInteger) {
		return undefined;
	}
	const targetRange = getIntegerRange(targetType);
	if (!targetRange) {
		return undefined;
	}
	const { min, max } = argumentsRange;
	const isEmpty = min !== undefined
		&& max !== undefined
		&& min > max;
	const fitsMin = targetRange.min === undefined
		|| (min !== undefined && min >= targetRange.min);
	const fitsMax = targetRange.max === undefined
		|| (max !== undefined && max <= targetRange.max);
	return isEmpty || (fitsMin && fitsMax);
}

function isTypeAssignableByStructure(
	argumentsType: Exclude<ResolvedType, { julType: 'any'; }>,
	targetType: Exclude<ResolvedType, { julType: 'any'; }>,
): TypeAssignability {
	switch (argumentsType.julType) {
		case 'and': {
			if (targetType.julType === 'and') {
				// Erst das target zerlegen, das ist exakt: der Wert muss zu jedem target Choice
				// passen. Sonst müsste ein einzelner args Choice für das ganze target reichen,
				// was z.B. And(Integer Or(1 §a§)) gegen And(Integer Not(0)) fälschlich ablehnt.
				break;
			}
			// Ein Not-Choice sagt als Quelle nichts Verlässliches (siehe case 'not'), passt also
			// fast immer und darf deshalb nicht als "passender Choice" zählen. Stattdessen exakt:
			// And(A Not(B)) liegt in T genau dann, wenn A in Or(T B) liegt.
			const complementChoices = argumentsType.ChoiceTypes.filter(choiceType =>
				isComplementType(resolveAlias(choiceType)));
			if (complementChoices.length
				&& complementChoices.length < argumentsType.ChoiceTypes.length) {
				const otherChoices = argumentsType.ChoiceTypes.filter(choiceType =>
					!complementChoices.includes(choiceType));
				const widenedTarget = createNormalizedUnionType([
					targetType,
					...complementChoices.map(choiceType =>
						(resolveAlias(choiceType) as CompileTimeComplementType).SourceType),
				]);
				const remainingType = otherChoices.length === 1
					? otherChoices[0]!
					: createCompileTimeIntersectionType(otherChoices);
				const remainingAssignability = isTypeAssignable(remainingType, widenedTarget);
				if (remainingAssignability.assignable === false) {
					return getDefaultTypeError(argumentsType, targetType);
				}
				// Liegt das target ganz im Ausgeschlossenen, passt kein Wert hinein, auch wenn A
				// unbekannt ist: And(Any Not(Integer)) gegen Integer.
				if (remainingAssignability.assignable === undefined) {
					const excludedType = createNormalizedUnionType(complementChoices.map(choiceType =>
						(resolveAlias(choiceType) as CompileTimeComplementType).SourceType));
					if (isSubtypeOf(targetType, excludedType) === true) {
						return getDefaultTypeError(argumentsType, targetType);
					}
				}
				return remainingAssignability;
			}
			// Es genügt, wenn ein args Choice zum target passt, denn der Wert erfüllt alle.
			const choiceAssignabilities = argumentsType.ChoiceTypes.map(choiceType =>
				isTypeAssignable(choiceType, targetType));
			if (choiceAssignabilities.some(choiceAssignability => choiceAssignability.assignable === true)) {
				return { assignable: true };
			}
			const subErrors = choiceAssignabilities.map(choiceAssignability =>
				choiceAssignability.assignable === false ? choiceAssignability.error : undefined);
			if (subErrors.every(isDefined)) {
				// Kein einzelner choice reicht. Die Schnittmenge kann trotzdem passen, sichtbar
				// wird das aber erst nach dem Auflösen: And(value Not(Empty)) mit
				// value: Or([] Integer) ist Integer, kein einzelner choice sagt das.
				const dereferencedArgumentsType = resolvePlaceholders(argumentsType);
				if (dereferencedArgumentsType !== argumentsType) {
					return isTypeAssignable(dereferencedArgumentsType, targetType);
				}
				// Bleibt auch nach dem Auflösen nichts übrig: das target selbst kann sich noch
				// zerlegen lassen (z.B. Or): And(Integer Not(0)) passt als GANZES zu
				// Or([] And(Integer Not(0))), obwohl weder Integer noch Not(0) allein passt.
				if (targetType.julType === 'or') {
					break;
				}
				// Choices, die sich zum selben Typ auflösen, liefern dieselbe Meldung
				return {
					assignable: false,
					// TODO error struktur überdenken
					error: new TypeError(() =>
						[...new Set(subErrors.map(typeErrorToString))].join('\n')),
				};
			}
			return { assignable: undefined };
		}
		case 'concat':
			// Gegen eine Parameterliste ist Concat die Argumentkollektion mit Empfänger, siehe
			// isTypeAssignableForParameters.
			if (targetType.julType === 'parameters') {
				break;
			}
		// falls through
		case 'add': {
			// Wie withElementAt: eine noch unaufgelöste Source (z.B. der eigene Parameter, bevor
			// er am Aufruf substituiert wird) hält den Knoten als Concat(...) stehen
			// (concatFromTypes: isUnresolvedPlaceholderType-Guard). Erst per resolvePlaceholders
			// neu falten versuchen, sonst permissiv wie nestedReference - als Zieltyp ist concat
			// schon permissiv (siehe unten), als Argumenttyp fehlte das.
			const resolved = resolvePlaceholders(argumentsType);
			if (resolved !== argumentsType) {
				return isTypeAssignable(resolved, targetType);
			}
			return { assignable: undefined };
		}
		case 'lengthOf': {
			// Dieselbe Länge liegt in sich selbst, als PositiveInteger gelesen wäre das nur unbekannt.
			if (targetType.julType === 'lengthOf'
				&& typeEquals(argumentsType, targetType)) {
				return { assignable: true };
			}
			// Source ist nur dann garantiert schon der reine list-Zweig (nie Empty), wenn
			// getLengthFromType sie bereits aufgesplittet hat. Bei einer hier noch unaufgelösten
			// Source (z.B. parameterReference, weil argsType bewusst ungeprüft bleibt, siehe
			// Aufrufer) gilt das nicht automatisch - erst auflösen und ggf. neu aufsplitten,
			// bevor PositiveInteger unterstellt wird.
			const dereferencedSource = resolvePlaceholders(argumentsType.Source);
			if (dereferencedSource !== argumentsType.Source) {
				const dereferencedLength = getLengthFromType(dereferencedSource);
				if (!typeEquals(dereferencedLength, argumentsType)) {
					return isTypeAssignable(dereferencedLength, targetType);
				}
			}
			return isTypeAssignable(CompileTimePositiveInteger, targetType);
		}
		case 'nestedReference': {
			// Wie concat/withElementAt: erst auflösen versuchen, sonst permissiv.
			const resolved = resolvePlaceholders(argumentsType);
			if (resolved !== argumentsType) {
				return isTypeAssignable(resolved, targetType);
			}
			return { assignable: undefined };
		}
		case 'not': {
			// Not(A) heißt "alles außer A" und liegt genau dann in T, wenn T alles außer A abdeckt.
			// Gegen ein Not als target: Not(A) liegt in Not(B), wenn B in A liegt. Not(GreaterInteger(3))
			// passt also nicht zu Not(GreaterInteger(2)), denn 3 wäre ausgeschlossen.
			switch (targetType.julType) {
				case 'not': {
					const sourceAssignability = isTypeAssignable(targetType.SourceType, argumentsType.SourceType);
					return sourceAssignability.assignable === false
						? getDefaultTypeError(argumentsType, targetType)
						: sourceAssignability;
				}
				// Zerlegen: ein Choice wie Not(B) mit B in A kann das Ganze abdecken.
				case 'and':
				case 'or':
				case 'predicate':
					break;
				default:
					// Steht das target noch nicht fest, ist nichts entschieden. Jedes andere target
					// lässt Werte außerhalb von A aus, etwa Text bei Not(0) gegen Integer.
					return isUnresolvedPlaceholderType(targetType)
						? { assignable: undefined }
						: getDefaultTypeError(argumentsType, targetType);
			}
			break;
		}
		case 'or': {
			// alle args Choices müssen zum target passen
			const choiceAssignabilities = argumentsType.ChoiceTypes.map(choiceType =>
				isTypeAssignable(choiceType, targetType));
			return joinTypeAssignabilities(choiceAssignabilities, true);
		}
		case 'parameterReference': {
			const dereferencedParameterType = dereferenceParameterTypeFromFunctionRef(argumentsType);
			if (!dereferencedParameterType) {
				return { assignable: undefined };
			}
			return isTypeAssignable(dereferencedParameterType, targetType);
		}
		case 'predicate':
			switch (targetType.julType) {
				// Diese Ziele werden erst zerlegt, damit ein gleiches Prädikat darin gefunden wird.
				case 'and':
				case 'not':
				case 'or':
				case 'predicate':
					break;
				// Ein Wert, der das Prädikat erfüllt, liegt in der Obermenge.
				default:
					return isTypeAssignable(argumentsType.UpperBound, targetType);
			}
			break;
		case 'mapElements': {
			// Wie concat/withElementAt: solange die Anzahl noch offen ist, bleibt der Knoten
			// stehen - erst neu falten versuchen, sonst permissiv.
			const resolved = resolvePlaceholders(argumentsType);
			if (resolved !== argumentsType) {
				return isTypeAssignable(resolved, targetType);
			}
			return { assignable: undefined };
		}
		case 'conditional': {
			// Wie withElementAt: erst auswerten versuchen, sonst permissiv.
			const resolved = resolvePlaceholders(argumentsType);
			if (resolved !== argumentsType) {
				return isTypeAssignable(resolved, targetType);
			}
			return { assignable: undefined };
		}
		case 'withElementAt': {
			// Steht die Position (noch) nicht fest, bleibt setElement als WithElementAt(...)
			// stehen (withElementAtFromTypes: Platzhalter bleibt ungefaltet, bis Source/Index
			// feststehen) - das ist kein falscher Wert, sondern einer, der es noch werden kann.
			// Erst per resolvePlaceholders neu falten versuchen (Source/Index könnten seither
			// aufgelöst sein), sonst permissiv wie nestedReference/parameterReference: als
			// Zieltyp ist withElementAt schon permissiv (siehe unten), als Argumenttyp fehlte das.
			const resolved = resolvePlaceholders(argumentsType);
			if (resolved !== argumentsType) {
				return isTypeAssignable(resolved, targetType);
			}
			return { assignable: undefined };
		}
		default:
			break;
	}
	// TODO generic types (customType, union/intersection, ...?)
	switch (targetType.julType) {
		case 'and': {
			// das arg muss zu allen target Choices passen
			const choiceAssignabilities = targetType.ChoiceTypes.map(choiceType =>
				isTypeAssignable(argumentsType, choiceType));
			return joinTypeAssignabilities(choiceAssignabilities, true);
		}
		case 'blob':
			break;
		case 'boolean':
			switch (argumentsType.julType) {
				case 'boolean':
					return { assignable: true };
				case 'booleanLiteral':
					return { assignable: true };
				default:
					break;
			}
			break;
		case 'booleanLiteral':
			if (typeEquals(argumentsType, targetType)) {
				return { assignable: true };
			}
			break;
		case 'date':
			break;
		case 'dictionary': {
			const elementType = targetType.ElementType;
			switch (argumentsType.julType) {
				case 'dictionary': {
					const subError = isTypeAssignable(argumentsType.ElementType, elementType);
					return subError;
				}
				case 'dictionaryLiteral': {
					// TODO the field x is missing error?
					const fieldAssignabilities = map(
						argumentsType.Fields,
						(fieldType, fieldName) => isTypeAssignableForField(fieldName, elementType, fieldType),
					);
					return joinTypeAssignabilities(fieldAssignabilities, true);
				}
				default:
					// TODO type specific error?
					break;
			}
			break;
		}
		case 'dictionaryLiteral': {
			const fieldsAssignability = isTypeAssignableForDictionaryLiteral(argumentsType, targetType.Fields);
			if (!fieldsAssignability) {
				// Standardfehler
				break;
			}
			if (fieldsAssignability.assignable !== false) {
				return fieldsAssignability;
			}
			const error = fieldsAssignability.error;
			// targetType mit depth=1, damit z.B. GameBoard als kurzer Alias erscheint statt
			// voll ausgeschrieben (typeToString zeigt Aliase nur ab depth>0). argumentsType
			// dagegen mit suppressAlias=true: sein aliasName ist der Name der Definition, die
			// den Wert hält (z.B. "newGameState"), kein Typname - der würde hier fälschlich
			// als Typ erscheinen, auch bei verschachtelten Feldern (Fund newBoard, s.o.).
			// Würde diese Kopfzeile selbst mehrzeilig rendern (z.B. weil ein Feld einen
			// größeren verschachtelten Typ enthält), trägt sie neben der folgenden
			// "Invalid value for field"-Kette nichts bei und lenkt vom eigentlichen Fehler ab
			// (Fund im echten yugioh-Fehlerbild, Session 2026-09-10) - dann fällt sie ganz weg.
			// Entscheidung anhand des tatsächlich gerenderten Textes, bevor er mit dem Detail
			// verklebt wird, statt den fertigen String später wieder aufzutrennen.
			return {
				assignable: false,
				error: new TypeError(() => {
					const header = `Can not assign ${typeToString(argumentsType, 0, 0, true)} to ${typeToString(targetType, 0, 1)}.`;
					if (header.includes('\n')) {
						return error.getMessage();
					}
					return `${header}\n${indentLines(error.getMessage())}`;
				}),
			};
		}
		case 'empty':
			if (argumentsType.julType === 'empty') {
				return { assignable: true };
			}
			break;
		case 'error':
			break;
		case 'float':
			switch (argumentsType.julType) {
				case 'float':
					return { assignable: true };
				case 'floatLiteral':
					return { assignable: true };
				case 'bound':
					if (argumentsType.Family === 'float') {
						return { assignable: true };
					}
					break;
				default:
					break;
			}
			break;
		case 'floatLiteral':
			if (typeEquals(argumentsType, targetType)) {
				return { assignable: true };
			}
			break;
		case 'function': {
			// TODO types als function interpretieren?
			if (!isFunctionType(argumentsType)) {
				break;
			}
			// Kontravarianz: Funktionstyp-Subtyping dreht die Richtung bei Parametern um.
			// - Parameter: targetType.ParamsType muss Teilmenge von argumentsType.ParamsType sein.
			//   Die übergebene Funktion muss also alles annehmen, was die Zielposition ihr
			//   übergibt. Wer weniger fordert, ist überall einsetzbar; wer mehr fordert, bekommt
			//   Werte, die er laut eigener Deklaration ablehnt.
			// - Return-Type: Normale Richtung (Kovarianz).
			//   argumentsType.ReturnType muss Teilmenge von targetType.ReturnType sein,
			//   weil der Rückgabewert das erfüllen muss, was die Zielposition erwartet.
			const paramsAssignability = isTypeAssignable(targetType.ParamsType, argumentsType.ParamsType);
			if (paramsAssignability.assignable === false) {
				return paramsAssignability;
			}
			const returnAssignability = isTypeAssignable(argumentsType.ReturnType, targetType.ReturnType);
			if (returnAssignability.assignable === false) {
				// Ohne Beschriftung liesse sich nicht erkennen, dass die Meldung den Rückgabewert
				// betrifft, statt z.B. einen weiteren Parameter (siehe getParameterError).
				return {
					assignable: false,
					error: new TypeError(() =>
						`Invalid return value\n${indentLines(typeErrorToString(returnAssignability.error))}`),
				};
			}
			if (paramsAssignability.assignable === undefined
				|| returnAssignability.assignable === undefined) {
				return { assignable: undefined };
			}
			return { assignable: true };
		}
		// Ganzzahlige Grenzen hat integerRangeFits schon entschieden, hier bleiben die übrigen Familien.
		case 'bound': {
			const boundValue = targetType.Value;
			const literalFamily = targetType.Family === 'integer' ? 'integerLiteral' : 'floatLiteral';
			if (boundValue.julType !== literalFamily) {
				break;
			}
			if (argumentsType.julType === literalFamily
				&& (targetType.Relation === 'greater'
					? argumentsType.value > boundValue.value
					: argumentsType.value < boundValue.value)) {
				return { assignable: true };
			}
			// GreaterFloat(a) liegt in GreaterFloat(b), wenn a >= b, LessFloat umgekehrt.
			if (argumentsType.julType === 'bound'
				&& argumentsType.Relation === targetType.Relation
				&& argumentsType.Family === targetType.Family) {
				const argumentValue = argumentsType.Value;
				if (argumentValue.julType === literalFamily
					&& (targetType.Relation === 'greater'
						? argumentValue.value >= boundValue.value
						: argumentValue.value <= boundValue.value)) {
					return { assignable: true };
				}
			}
			break;
		}
		case 'integer':
			switch (argumentsType.julType) {
				case 'integer':
					return { assignable: true };
				case 'integerLiteral':
					return { assignable: true };
				case 'bound':
					if (argumentsType.Family === 'integer') {
						return { assignable: true };
					}
					break;
				default:
					break;
			}
			break;
		case 'integerLiteral':
			if (typeEquals(argumentsType, targetType)) {
				return { assignable: true };
			}
			break;
		case 'list': {
			const targetElementType = targetType.ElementType;
			switch (argumentsType.julType) {
				case 'list': {
					const elementAssignability = isTypeAssignable(argumentsType.ElementType, targetElementType);
					if (elementAssignability.assignable === false) {
						// Ohne Hülle stand der Element-Fehler roh neben anderen Or-Choice-Fehlern,
						// ohne erkennbaren Bezug zur umschliessenden Liste (Fund im echten
						// yugioh-Fehlerbild, Session 2026-09-10) - analog zum dictionaryLiteral-Fall.
						return {
							assignable: false,
							error: new TypeError(() =>
								`Can not assign ${typeToString(argumentsType, 0, 0, true)} to ${typeToString(targetType, 0, 1)}.\n${indentLines(elementAssignability.error.getMessage())}`),
						};
					}
					return elementAssignability;
				}
				case 'tuple': {
					const elementAssignabilities = argumentsType.ElementTypes.map(valueElement =>
						isTypeAssignable(valueElement, targetElementType));
					return joinTypeAssignabilities(elementAssignabilities);
				}
				default:
					break;
			}
			break;
		}
		case 'nestedReference':
			// TODO?
			return { assignable: undefined };
		case 'never':
			break;
		case 'not': {
			// Der Wert darf den SourceType nicht überlappen. Zuweisbarkeit genügt hier nicht:
			// Integer ist keine Teilmenge von 0, enthält 0 aber und ist damit unzulässig.
			const overlaps = typesOverlap(argumentsType, targetType.SourceType);
			if (overlaps === true) {
				return getDefaultTypeError(argumentsType, targetType);
			}
			return { assignable: overlaps === false || undefined };
		}
		case 'or': {
			// das arg muss zu mindestens einem target Choice passen
			const choiceAssignabilities = targetType.ChoiceTypes.map(choiceType =>
				isTypeAssignable(argumentsType, choiceType));
			if (choiceAssignabilities.some(choiceAssignability => choiceAssignability.assignable === true)) {
				return { assignable: true };
			}
			const subErrors = choiceAssignabilities.map(choiceAssignability =>
				choiceAssignability.assignable === false ? choiceAssignability.error : undefined);
			if (subErrors.every(isDefined)) {
				if (argumentsType.julType === 'boolean') {
					// Boolean passt zu keinem einzelnen Choice, kann aber trotzdem vollständig
					// abgedeckt sein, wenn die Choices zusammen sowohl true als auch false
					// treffen (z.B. Or(true false)) - Boolean hat nur diese zwei bewohnten
					// Werte. Bewusst nur hier und nicht generell für 'boolean' als
					// argumentsType, damit der sehr viel häufigere Fall Boolean-gegen-Boolean/
					// Any keinen zusätzlichen Aufwand bekommt.
					const asLiteralUnion = createCompileTimeUnionType([
						createBooleanLiteral(true),
						createBooleanLiteral(false),
					]);
					return isTypeAssignable(asLiteralUnion, targetType);
				}
				// Best-Match statt Alle-Choices-Dump (TS/Flow-Vorbild, Fund im echten
				// yugioh-Fehlerbild, Session 2026-09-10): nur den strukturell nächsten Choice
				// (gleicher julType wie der Wert) vertiefen, statt jeden fehlgeschlagenen
				// Choice einzeln zu zeigen - sonst stehen triviale Fehler ("List ist kein
				// Empty") gleichberechtigt neben dem eigentlich relevanten. Der volle
				// Or-Zieltyp bleibt im Kopf sichtbar, damit die anderen Choices nicht aus der
				// Meldung verschwinden. Fallback (kein eindeutiger Kandidat): wie bisher alle
				// Choice-Fehler einzeln zeigen.
				const closestIndexes = targetType.ChoiceTypes
					.map((choiceType, index) => choiceType.julType === argumentsType.julType ? index : -1)
					.filter(index => index !== -1);
				if (closestIndexes.length === 1) {
					const closestError = subErrors[closestIndexes[0]!]!;
					return {
						assignable: false,
						error: new TypeError(() =>
							`Can not assign ${typeToString(argumentsType, 0, 0, true)} to ${typeToString(targetType, 0, 1)}.\n${indentLines(typeErrorToString(closestError))}`),
					};
				}
				return {
					assignable: false,
					// TODO error struktur überdenken
					error: new TypeError(() => subErrors.map(typeErrorToString).join('\n')),
				};
			}
			return { assignable: undefined };
		}
		case 'parameters':
			return isTypeAssignableForParameters(argumentsType, targetType);
		case 'parameterReference': {
			// TODO
			// const dereferenced = dereferenceArgumentType(null as any, targetType);
			// return isTypeAssignable(valueType, dereferenced ?? builtinAny);
			return { assignable: undefined };
		}
		case 'stream': {
			if (!isStreamType(argumentsType)) {
				break;
			}
			// FiniteStream fordert mehr als Stream: ein Stream ohne Zusage passt nicht.
			if (targetType.finite && !argumentsType.finite) {
				break;
			}
			return isTypeAssignable(argumentsType.ValueType, targetType.ValueType);
		}
		case 'text':
			switch (argumentsType.julType) {
				case 'text':
					return { assignable: true };
				case 'textLiteral':
					return { assignable: true };
				default:
					break;
			}
			break;
		case 'textLiteral': {
			if (typeEquals(argumentsType, targetType)) {
				return { assignable: true };
			}
			break;
		}
		case 'tuple':
			return isTypeAssignableForTuple(argumentsType, targetType);
		case 'type':
			switch (argumentsType.julType) {
				case 'boolean':
				case 'booleanLiteral':
				case 'bound':
				case 'empty':
				case 'float':
				case 'floatLiteral':
				case 'integer':
				case 'integerLiteral':
				case 'text':
				case 'textLiteral':
				case 'type':
				case 'typeOf':
					return { assignable: true };
				case 'function':
					return isTypeAssignableForPredicateFunction(argumentsType);
				// Ein Wert, der das Prädikat erfüllt, ist ein Typ, wenn seine Obermenge aus
				// Typen besteht.
				case 'predicate':
					return isTypeAssignable(argumentsType.UpperBound, targetType);
				case 'tuple': {
					// alle ElementTypes müssen Typen sein
					const elementAssignabilities = argumentsType.ElementTypes.map(elementType =>
						isTypeAssignable(elementType, targetType)).filter(isDefined);
					return joinTypeAssignabilities(elementAssignabilities);
				}
				// TODO check inner types rekursiv
				case 'dictionary':
				case 'dictionaryLiteral':
				case 'list':
					return { assignable: undefined };
				default:
					// TODO type specific error?
					break;
			}
			break;
		// TODO
		case 'typeOf':
			break;
		case 'lengthOf': {
			// Eine noch offene Länge ist eine bestimmte, nur unbekannte Zahl, nicht jede positive ganze
			// Zahl, wie ein abstrakter Typ mit oberer Schranke PositiveInteger. Hinein passt sicher nur
			// dieselbe Länge (oben bei der Quelle), sicher nicht, was keine positive ganze Zahl sein kann.
			// Entsteht etwa aus length(values) in einem Parametertyp.
			const overlaps = typesOverlap(argumentsType, CompileTimePositiveInteger);
			return overlaps === false
				? getDefaultTypeError(argumentsType, targetType)
				: { assignable: undefined };
		}
		case 'conditional':
			// Wartet noch auf seine Operanden: permissiv wie withElementAt.
			return { assignable: undefined };
		case 'withElementAt':
			// Noch ungefalteter Platzhalter als Ziel: permissiv wie nestedReference, sonst
			// entstünden Fehler an einem Typ, der noch gar nicht feststeht.
			return { assignable: undefined };
		case 'indexRange':
			// Nur als Schlüssel sinnvoll, nie als Zieltyp einer Zuweisung.
			return { assignable: undefined };
		case 'mapElements':
			// Noch ungefalteter Platzhalter als Ziel: permissiv wie nestedReference.
			return { assignable: undefined };
		case 'concat':
			// Ungefaltete Konkatenation: permissiv wie nestedReference.
			return { assignable: undefined };
		case 'add':
			// Ungefaltete Summe: permissiv wie concat.
			return { assignable: undefined };
		case 'predicate': {
			if (argumentsType.julType === 'predicate'
				&& isSamePredicate(argumentsType, targetType)) {
				return { assignable: true };
			}
			const folded = tryFoldPredicate(targetType, argumentsType);
			if (folded !== undefined) {
				if (folded) {
					return { assignable: true };
				}
				break;
			}
			// Was das Prädikat für einen Wert in der Obermenge liefert, weiß der Checker nicht.
			// Das prüft die Laufzeit.
			if (isTypeAssignable(argumentsType, targetType.UpperBound).assignable === false) {
				break;
			}
			return { assignable: undefined };
		}
		default: {
			const assertNever: never = targetType;
			throw new Error(`Unexpected targetType.type: ${(assertNever as CompileTimeType).julType}`);
		}
	}
	return getDefaultTypeError(argumentsType, targetType);
}

function getDefaultTypeError(argumentsType: CompileTimeType, targetType: CompileTimeType): TypeAssignability {
	return {
		assignable: false,
		error: new TypeError(() =>
			`Can not assign ${typeToString(argumentsType, 0, 0)} to ${typeToString(targetType, 0, 0)}.`),
	}
}

/**
 * Jede Funktion ist als Typ zulässig, die true liefern kann und rein ist: Identität und Faltung
 * setzen voraus, dass sie für denselben Wert immer dasselbe liefert. Unbekannte Reinheit ist
 * keine Ablehnung, gefaltet wird dann nur nicht.
 */
export function isTypeAssignableForPredicateFunction(functionType: CompileTimeFunctionType): TypeAssignability {
	if (functionType.purity === 'impure') {
		return {
			assignable: false,
			error: new TypeError('A predicate used as a type must be pure.'),
		};
	}
	if (isSubtypeOf(createBooleanLiteral(true), resolvePlaceholders(functionType.ReturnType)) === false) {
		return {
			assignable: false,
			error: new TypeError('A predicate used as a type must be able to return true.')
		};
	}
	return { assignable: true };
}

/**
 * Liefert das Prädikat für diesen konstanten Wert true? undefined, wenn es sich nicht ausrechnen
 * lässt: der Wert ist nicht konstant, die Funktion nicht rein oder nicht faltbar, oder das Budget
 * ist erschöpft. Ausgewertet wird nach derselben Regel wie zur Laufzeit.
 */
function tryFoldPredicate(predicate: CompileTimePredicateType, argumentsType: CompileTimeType): boolean | undefined {
	const functionType = predicate.FunctionType;
	if (functionType.purity !== 'pure') {
		return undefined;
	}
	const value = typeToConstantValue(argumentsType);
	if (!value) {
		return undefined;
	}
	// Dasselbe Prädikat wird beim Normalisieren oft gegen dasselbe Literal geprüft, etwa jedes Glied
	// einer Union gegen jedes andere. Ohne Zwischenspeicher verbraucht das das Faltbudget, und
	// spätere Faltungen fallen aus. Unbekannt wird nicht gespeichert: das kann am Budget liegen.
	const valueKey = typeToString(argumentsType, 0, 0);
	const cachedResults = predicateFoldCache.get(functionType);
	const cached = cachedResults?.get(valueKey);
	if (cached !== undefined) {
		return cached;
	}
	const callable = tryBuildCallable(functionType);
	if (!callable) {
		return undefined;
	}
	checkerStats.foldableCall++;
	let result: boolean | undefined;
	try {
		result = runtime._isOfType(value.value, callable as Parameters<typeof runtime._isOfType>[1]);
	}
	catch {
		return undefined;
	}
	if (cachedResults) {
		cachedResults.set(valueKey, result);
	}
	else {
		predicateFoldCache.set(functionType, new Map([[valueKey, result]]));
	}
	return result;
}

/** Ergebnis von tryFoldPredicate je Funktionstyp des Prädikats und konstantem Wert. */
const predicateFoldCache = new WeakMap<CompileTimeFunctionType, Map<string, boolean>>();

function isTypeAssignableForTuple(
	argumentsType: CompileTimeType,
	targetType: CompileTimeTupleType,
): TypeAssignability {
	const targetElementTypes = targetType.ElementTypes;
	switch (argumentsType.julType) {
		case 'list':
			if (targetElementTypes.length > 1) {
				return {
					assignable: false,
					error: new TypeError(`Expected ${targetElementTypes.length} elements, but List may contain less.`)
				};
			}
			return isTypeAssignable(argumentsType.ElementType, targetElementTypes[0]!);
		case 'tuple':
			return isTypeAssignableForTupleArgAndTupleTarget(argumentsType.ElementTypes, targetElementTypes);
		case 'parameters':
			// Gegenstück zu isTypeAssignableForParameters' case 'tuple': dort darf ein unbenanntes
			// Tuple-Pattern (`[Integer] => ...`) als Argument gegen einen benannten Parametertyp
			// bestehen, hier ist es umgekehrt - ein benannter Parametertyp (z.B. filter's
			// deklarierter predicate-Typ) tritt kontravariant als "argumentsType" gegen ein
			// unbenanntes Tuple-Ziel an (z.B. ein als Prädikat übergebenes `[Integer] => true`).
			// TODO argumentsType.rest berücksichtigen - kein aktueller Fall deklariert einen
			// Rest-Parameter an dieser Stelle.
			return isTypeAssignableForTupleArgAndTupleTarget(
				argumentsType.singleNames.map(param => param.type ?? builtinAny),
				targetElementTypes,
			);
		default:
			return getDefaultTypeError(argumentsType, targetType);
	}
}

function isTypeAssignableForTupleArgAndTupleTarget(
	argumentElementTypes: CompileTimeType[],
	targetElementTypes: CompileTimeType[],
): TypeAssignability {
	// TODO fehler wenn argument mehr elemente entfält als target?
	const elementAssignabilities = targetElementTypes.map((targetElementType, index) => {
		const valueElement = argumentElementTypes[index] ?? builtinEmpty;
		return isTypeAssignable(valueElement, targetElementType);
	});
	return joinTypeAssignabilities(elementAssignabilities);
}

/**
 * joined assignable :=
 * false, wenn mindestens 1 false
 * undefined, wenn kein false und mindestens 1 undefined
 * true, wenn alle true
 * keepDuplicateMessages: jede Meldung bleibt stehen, auch wenn zwei dieselbe liefern, etwa bei
 * Feldern, deren Name in der Meldung steht.
 */
function joinTypeAssignabilities(typeAssignabilities: TypeAssignability[], keepDuplicateMessages = false): TypeAssignability {
	const errors = typeAssignabilities.filter(elementAssignability => elementAssignability.assignable === false);
	if (errors.length) {
		return {
			assignable: false,
			// TODO error struktur überdenken
			error: new TypeError(() => {
				const messages = errors.map(error => typeErrorToString(error.error));
				const uniqueMessages = keepDuplicateMessages ? messages : [...new Set(messages)];
				return uniqueMessages.join('\n');
			}),
		};
	}
	const hasUnkownAssignability = typeAssignabilities.some(typeAssignability => typeAssignability.assignable === undefined);
	if (hasUnkownAssignability) {
		return { assignable: undefined };
	}
	else {
		return { assignable: true };
	}
}

/**
 * Die Felder des Werts gegen die Felder des Ziels. undefined, wenn der Wert kein Dictionary-Literal
 * ist: dann gilt der Standardfehler.
 */
function isTypeAssignableForDictionaryLiteral(
	argumentsType: CompileTimeType,
	targetFieldTypes: CompileTimeDictionary,
): TypeAssignability | undefined {
	switch (argumentsType.julType) {
		case 'dictionaryLiteral': {
			// Für ein fehlendes Feld gibt es keinen Wert zum Vergleichen - der erwartete Typ
			// steht bereits an der Zieltyp-Deklaration selbst, ihn hier zusätzlich auszuschreiben
			// ist reine Wiederholung (TypeScript/Rust/Elm/GHC tun das ebenfalls nicht). Fehlende
			// Feldnamen werden deshalb gesammelt und zu einer Zeile zusammengefasst, statt je
			// Feld eine eigene "Missing field X, expected Y."-Zeile zu erzeugen.
			const missingFieldNames: string[] = [];
			const fieldAssignabilities = map(
				targetFieldTypes,
				(fieldType, fieldName): TypeAssignability => {
					const knownField = argumentsType.Fields[fieldName];
					if (knownField === undefined) {
						if (!argumentsType.complete) {
							// Unwissen ist keine Ablehnung: taucht das Feld in einem
							// unvollständigen Dictionary nicht auf, ist das kein Beweis, dass
							// es fehlt.
							return { assignable: undefined };
						}
						if (isFieldOptional(fieldType)) {
							// Or([] X) ist das Idiom für optionale Felder - Weglassen bleibt erlaubt.
							return { assignable: true };
						}
						missingFieldNames.push(fieldName);
						return { assignable: true };
					}
					return isTypeAssignableForField(fieldName, fieldType, knownField);
				},
			);
			if (missingFieldNames.length) {
				fieldAssignabilities.unshift({
					assignable: false,
					error: new TypeError(missingFieldNames.length === 1
						? `Missing field '${missingFieldNames[0]}'.`
						: `Missing fields: ${missingFieldNames.map(fieldName => `'${fieldName}'`).join(', ')}.`),
				});
			}
			return joinTypeAssignabilities(fieldAssignabilities, true);
		}
		default:
			// TODO type specific error?
			return undefined;
	}
}

function isTypeAssignableForField(
	fieldName: string,
	fieldTargetType: CompileTimeType,
	fieldValueType: CompileTimeType,
): TypeAssignability {
	const subAssignability = isTypeAssignable(fieldValueType, fieldTargetType);
	if (subAssignability.assignable === false) {
		// Feldname steht VOR der Erklärung, die er einleitet (TypeScript-Vorbild), nicht danach -
		// sonst müsste man beim Lesen den Feldnamen im Kopf der richtigen Ebene der Typ-Kette
		// zuordnen statt ihn direkt an der Stelle zu lesen, wo er hingehört. Eine Ebene tiefer
		// eingerückt, damit die Verschachtelungstiefe auch bei 3+ Ebenen sichtbar bleibt.
		return {
			assignable: false,
			error: new TypeError(() =>
				`Invalid value for field '${fieldName}'\n${indentLines(typeErrorToString(subAssignability.error))}`),
		};
	}
	return subAssignability;
}

/**
 * Pendant zu isTypeAssignableForField für positionale Funktionsargumente: ohne den Parameternamen
 * ist bei mehreren Argumenten/Überladungen nicht erkennbar, welches Argument betroffen ist
 * (Fund: JUL5050 nannte nur den Typkonflikt, nie die Parameterposition).
 */
function isTypeAssignableForParameter(
	parameterName: string,
	parameterTargetType: CompileTimeType,
	argumentType: CompileTimeType,
	/**
	 * 'type' beim kontravarianten Vergleich zweier Funktionstypen: dort steht die deklarierte
	 * Signatur zur Prüfung, kein Wert, der an den Parameter übergeben wird.
	 */
	subject: 'value' | 'type' = 'value',
): TypeAssignability {
	const subAssignability = isTypeAssignable(argumentType, parameterTargetType);
	if (subAssignability.assignable === false) {
		return {
			assignable: false,
			error: new TypeError(() =>
				`Invalid ${subject} for parameter '${parameterName}'\n${indentLines(typeErrorToString(subAssignability.error))}`)
		};
	}
	return subAssignability;
}

/**
 * Darf ein Feld dieses Zieltyps im Literal fehlen? Or([] X) ist das Idiom für optionale Felder
 * (CLAUDE.md) - Empty erfüllt das Ziel dann bereits, ohne dass es explizit als `feld = []`
 * dastehen muss.
 */
function isFieldOptional(fieldTargetType: CompileTimeType): boolean {
	return isTypeAssignable(builtinEmpty, fieldTargetType).assignable !== false;
}

/**
 * Die Argumentkollektion eines Aufrufs gegen die Parameterliste. Ein Empfänger (a in a.f(b)) steckt
 * darin, siehe bindReceiver.
 */
function isTypeAssignableForParameters(
	rawArgumentsType: CompileTimeType,
	targetType: ParametersType,
): TypeAssignability {
	const { receiverType, argsType } = splitReceiver(rawArgumentsType);
	if (!receiverType
		&& resolveAlias(argsType).julType === 'concat') {
		// Eine andere Aneinanderreihung als [Empfänger] Rest: erst auflösen, sonst unbekannt.
		const resolved = resolvePlaceholders(argsType);
		return resolved === argsType
			? { assignable: undefined }
			: isTypeAssignableForParameters(resolved, targetType);
	}
	return isTypeAssignableForParametersWithLeading(receiverType, argsType, targetType);
}

/**
 * Wie isTypeAssignableForParameters, das führende Argument bindet den ersten Parameter, die
 * Kollektion beginnt dahinter.
 */
function isTypeAssignableForParametersWithLeading(
	leadingArgumentType: CompileTimeType | undefined,
	rawArgumentsType: CompileTimeType,
	targetType: ParametersType,
): TypeAssignability {
	const argumentsType = resolveAlias(rawArgumentsType);
	switch (argumentsType.julType) {
		case 'or': {
			const choiceAssignabilities = argumentsType.ChoiceTypes.map(choiceType =>
				isTypeAssignableForParametersWithLeading(leadingArgumentType, choiceType, targetType));
			return joinTypeAssignabilities(choiceAssignabilities, true);
		}
		case 'dictionaryLiteral':
			return isTypeAssignableForParametersWithCollectionArgs(leadingArgumentType, argumentsType.Fields, targetType);
		case 'empty':
			return isTypeAssignableForParametersWithCollectionArgs(leadingArgumentType, undefined, targetType);
		case 'tuple':
			return isTypeAssignableForParametersWithCollectionArgs(leadingArgumentType, argumentsType.ElementTypes, targetType);
		case 'list': {
			// Eine Liste als Argumentliste hat unbekannte Länge (entsteht durch einen Spread, dessen
			// Quelle erst zur Laufzeit feststeht). Welche Position welchen Parameter trifft, steht
			// damit nicht fest: jeder Einzelparameter muss den Elementtyp annehmen können. Belegt
			// ist nur die erste Position - List(X) schließt das Leere aus -, jede weitere kann
			// fehlen und muss deshalb zusätzlich Empty vertragen.
			const elementType = argumentsType.ElementType;
			const optionalElementType = createNormalizedUnionType([builtinEmpty, elementType]);
			const singleNames = targetType.singleNames;
			// Ein führendes Argument belegt die erste Parameterposition selbst; die Liste beginnt erst
			// dahinter, die garantierte Position rückt also mit.
			const guaranteedIndex = leadingArgumentType ? 1 : 0;
			// Bewiesen nur, wenn jeder Parameter yes liefert.
			let isProven = true;
			for (let index = 0; index < singleNames.length; index++) {
				const parameter = singleNames[index]!;
				const parameterType = parameter.type;
				if (!parameterType) {
					continue;
				}
				const argumentType = leadingArgumentType && !index
					? leadingArgumentType
					: index === guaranteedIndex
						? elementType
						: optionalElementType;
				const assignability = isTypeAssignableForParameter(parameter.name, parameterType, argumentType);
				if (assignability.assignable === false) {
					// TODO collect inner errors
					return assignability;
				}
				isProven &&= assignability.assignable === true;
			}
			const rest = targetType.rest;
			const restType = rest?.type;
			if (restType) {
				// Übrig bleibt wieder eine Liste desselben Elementtyps - aber womöglich keine mehr,
				// sobald Einzelparameter Positionen verbraucht haben. Ein führendes Argument, das kein
				// Einzelparameter aufgenommen hat, landet ebenfalls im Rest und geht in den
				// Elementtyp ein.
				const restElementType = leadingArgumentType && !singleNames.length
					? createNormalizedUnionType([leadingArgumentType, elementType])
					: elementType;
				const remainingType = singleNames.length
					? createNormalizedUnionType([builtinEmpty, createCompileTimeListType(restElementType)])
					: createCompileTimeListType(restElementType);
				const assignability = isTypeAssignableForParameter(rest!.name, restType, remainingType);
				if (assignability.assignable === false) {
					// TODO collect inner errors
					return assignability;
				}
				isProven &&= assignability.assignable === true;
			}
			return { assignable: isProven || undefined };
		}
		case 'parameters': {
			// Parameter gegen Parameter tritt nur beim Vergleich zweier Funktionstypen auf, und
			// der ruft kontravariant auf: targetType ist die übergebene Funktion, argumentsType
			// die Signatur, die die Zielposition zusichert. Deshalb ist hier targetType das
			// "Got" und argumentsType das "expected".
			let index = 0;
			// Bewiesen nur, wenn jeder Parameter yes liefert.
			let isProven = true;
			const targetSingleNames = targetType.singleNames;
			const valueSingleNames = argumentsType.singleNames;
			const valueRest = argumentsType.rest;
			const valueRestType = valueRest?.type;
			const valueRestItemType: CompileTimeType | undefined = valueRest
				? isListType(valueRestType)
					? valueRestType.ElementType
					: builtinAny
				: undefined;
			for (; index < targetSingleNames.length; index++) {
				const targetParameter = targetSingleNames[index]!;
				const targetParameterName = targetParameter.name;
				const targetParameterType = targetParameter.type;
				const valueParameter = valueSingleNames[index];
				if (valueParameter && valueParameter.name !== targetParameterName) {
					return {
						assignable: false,
						error: new TypeError(`Parameter name mismatch. Got '${targetParameterName}' but expected '${valueParameter.name}'`)
					};
				}
				const valueParameterType: CompileTimeType = valueParameter?.type ?? valueRestItemType ?? builtinAny;
				const assignability = targetParameterType
					? isTypeAssignableForParameter(targetParameterName, targetParameterType, valueParameterType, 'type')
					: undefined;
				if (assignability?.assignable === false) {
					// TODO collect inner errors
					return assignability;
				}
				isProven &&= !assignability || assignability.assignable === true;
			}
			const targetRest = targetType.rest;
			const targetRestType = targetRest?.type;
			if (targetRestType) {
				// Gegen den Elementtyp prüfen, nicht gegen den Listentyp selbst: ein Rest-Parameter
				// `...args: List(Any)` nimmt je übrigem Parameter einen Wert vom Elementtyp
				// entgegen, nicht die ganze Liste.
				const targetRestItemType = isListType(targetRestType)
					? targetRestType.ElementType
					: builtinAny;
				const remainingValueParameters = valueSingleNames.slice(index);
				for (const valueParameter of remainingValueParameters) {
					const valueParameterType = valueParameter.type ?? valueRestItemType ?? builtinAny;
					const assignability = isTypeAssignableForParameter(targetRest!.name, targetRestItemType, valueParameterType, 'type');
					if (assignability.assignable === false) {
						// TODO collect inner errors
						return assignability;
					}
					isProven &&= assignability.assignable === true;
				}
			}
			return { assignable: isProven || undefined };
		}
		default: {
			// Eine noch offene Kollektion, etwa der Spread eines Parameters (...xs): erst auflösen,
			// sonst ist nichts entschieden.
			const resolved = resolvePlaceholders(argumentsType);
			if (resolved !== argumentsType) {
				return isTypeAssignableForParametersWithLeading(leadingArgumentType, resolved, targetType);
			}
			if (isUnresolvedPlaceholderType(argumentsType)
				|| argumentsType.julType === 'concat') {
				return { assignable: undefined };
			}
			return {
				assignable: false,
				error: new TypeError('isTypeAssignableForParameters not implemented yet for ' + argumentsType.julType)
			};
		}
	}
}

function isTypeAssignableForParametersWithCollectionArgs(
	leadingArgumentType: CompileTimeType | undefined,
	argumentsType: CompileTimeCollection | undefined,
	targetType: ParametersType,
): TypeAssignability {
	const hasLeadingArgument = !!leadingArgumentType;
	const isArray = Array.isArray(argumentsType);
	let paramIndex = 0;
	let argumentIndex = 0;
	// Bewiesen nur, wenn jeder Parameter yes liefert.
	let isProven = true;
	const { singleNames, rest } = targetType;
	for (; paramIndex < singleNames.length; paramIndex++) {
		const param = singleNames[paramIndex]!;
		const { name, type } = param;
		let argument: CompileTimeType;
		if (hasLeadingArgument && !paramIndex) {
			argument = leadingArgumentType;
		}
		else {
			argument = (argumentsType && (isArray
				? argumentsType[argumentIndex]
				: argumentsType[name])) ?? builtinEmpty;
			argumentIndex++;
		}
		const assignability = type
			? isTypeAssignableForParameter(name, type, argument)
			: undefined;
		if (assignability?.assignable === false) {
			// TODO collect inner errors
			return assignability;
		}
		isProven &&= !assignability || assignability.assignable === true;
	}
	if (rest) {
		const restType = rest.type;
		if (!argumentsType) {
			const remainingArgs: CompileTimeType = hasLeadingArgument && !paramIndex
				? createCompileTimeTupleType([leadingArgumentType])
				: builtinEmpty;
			const assignability = restType
				? isTypeAssignableForParameter(rest.name, restType, remainingArgs)
				: undefined;
			if (assignability?.assignable === false) {
				return assignability;
			}
			isProven &&= !assignability || assignability.assignable === true;
			return { assignable: isProven || undefined };
		}
		if (isArray) {
			const remainingArgs = argumentsType.slice(argumentIndex);
			if (hasLeadingArgument && !paramIndex) {
				remainingArgs.unshift(leadingArgumentType);
			}
			const assignability = restType
				? isTypeAssignableForParameter(rest.name, restType, createCompileTimeTupleType(remainingArgs))
				: undefined;
			if (assignability?.assignable === false) {
				// TODO collect inner errors
				return assignability;
			}
			isProven &&= !assignability || assignability.assignable === true;
		}
		else {
			// TODO rest dictionary??
			return {
				assignable: false,
				error: new TypeError('Can not assign dictionary to rest parameter'),
			};
		}
	}
	return { assignable: isProven || undefined };
}

/**
 * Die Meldung entsteht erst bei getMessage und wird dann gemerkt. isSubtypeOf und die Normalisierung
 * von Typen verwerfen die meisten Fehler und brauchen nur das Boolean - die Meldung vorab zu bauen
 * (typeToString) war dort der größte Posten im Check. Wer eine Meldung aus einer anderen
 * zusammensetzt, muss das ebenfalls im createMessage-Callback tun, sonst wird die innere sofort
 * gelesen. Klasse statt Objektliteral mit Getter: Es entstehen Millionen davon, ein Literal mit
 * Accessor ist in V8 deutlich teurer.
 */
class TypeError {
	private createMessage: (() => string) | undefined;
	private cachedMessage: string | undefined;

	constructor(message: string | (() => string)) {
		if (typeof message === 'string') {
			this.cachedMessage = message;
		}
		else {
			this.createMessage = message;
		}
	}

	getMessage(): string {
		if (this.createMessage) {
			this.cachedMessage = this.createMessage();
			this.createMessage = undefined;
		}
		return this.cachedMessage!;
	}
}

export function typeErrorToString(typeError: TypeError): string {
	return typeError.getMessage();
}

/**
 * Rückt jede Zeile eines mehrzeiligen Fehlertexts eine Ebene tiefer - für verschachtelte
 * Dictionary-Felder, damit die Tiefe beim Lesen sichtbar ist (TypeScript-Vorbild), statt nur
 * über die Abfolge von Typ-Mismatch/Feldname-Zeilen erschlossen werden zu müssen.
 */
function indentLines(text: string): string {
	return text.split('\n').map(line => `${indentUnit}${line}`).join('\n');
}

//#endregion TypeAssignability

//#region ToString

// TODO expand ReferenceType 1 level deep?
// suppressAlias unterdrückt aliasName in der gesamten Rekursion, nicht nur an der Aufrufstelle -
// nötig, um einen Wert zu beschreiben (der Alias ist dort immer nur der Name der Definition,
// die den Wert hält, nie ein echter Typname; siehe Fund newGameState/newBoard, Session 2026-09-10).
/** Der Name, bei einer Anwendung mit Argumenten: Tree(Integer). */
function aliasNameToString(alias: CompileTimeAliasType, indent: number): string {
	if (!alias.args) {
		return alias.name;
	}
	const args = resolveAlias(alias.args);
	const argTypes = args.julType === 'tuple'
		? args.ElementTypes
		: [args];
	// Die Argumente sind Typwerte (TypeOf(Integer)), angezeigt wird der Typ.
	const argsString = argTypes.map(arg => typeToString(valueOf(arg), indent, 1)).join(' ');
	return `${alias.name}(${argsString})`;
}

/** Der Name, unter dem die Grenze geschrieben wird, etwa GreaterInteger. */
function boundName(type: CompileTimeBoundType): string {
	const relation = type.Relation === 'greater' ? 'Greater' : 'Less';
	const family = type.Family === 'integer' ? 'Integer' : 'Float';
	return relation + family;
}

export function typeToString(type: CompileTimeType, indent: number, depth: number, suppressAlias = false): string {
	if (depth && type.aliasName && !suppressAlias) {
		return type.aliasName;
	}
	switch (type.julType) {
		case 'and':
			return `And${arrayTypeToString(type.ChoiceTypes, indent, depth + 1, suppressAlias, 'round')}`;
		case 'any':
			return 'Any';
		case 'blob':
			return 'Blob';
		case 'boolean':
			return 'Boolean';
		case 'integerLiteral':
		case 'booleanLiteral':
			return type.value.toString();
		case 'date':
			return 'Date';
		case 'dictionary':
			return `Dictionary(${typeToString(type.ElementType, indent, depth + 1, suppressAlias)})`;
		case 'dictionaryLiteral':
			return dictionaryTypeToString(type.Fields, ': ', indent, depth + 1, suppressAlias);
		case 'empty':
			return 'Empty';
		case 'error':
			return 'Error';
		case 'float':
			return 'Float';
		case 'floatLiteral':
			return type.value.toString() + 'f';
		case 'function': {
			const paramsString = typeToString(type.ParamsType, indent, depth + 1, suppressAlias);
			const returnString = typeToString(type.ReturnType, indent, depth + 1, suppressAlias);
			const arrow = type.purity === 'pure'
				? '->'
				: type.purity === 'impure'
					? '~>'
					: ':>';
			return `${paramsString} ${arrow} ${returnString}`;
		}
		case 'bound':
			return `${boundName(type)}(${typeToString(type.Value, indent, depth + 1, suppressAlias)})`;
		case 'integer':
			return 'Integer';
		case 'lengthOf':
			return `LengthOf(${typeToString(type.Source, indent, depth + 1, suppressAlias)})`;
		case 'list':
			return `List(${typeToString(type.ElementType, indent, depth + 1, suppressAlias)})`;
		case 'nestedReference':
			return `${typeToString(type.source, indent, depth + 1, suppressAlias)}/${typeof type.nestedKey === 'object'
				? typeToString(type.nestedKey, indent, depth + 1, suppressAlias)
				: type.nestedKey}`;
		case 'never':
			return 'Never';
		case 'not':
			return `Not(${typeToString(type.SourceType, indent, depth + 1, suppressAlias)})`;
		case 'or':
			return `Or${arrayTypeToString(type.ChoiceTypes, indent, depth + 1, suppressAlias, 'round')}`;
		case 'parameters': {
			const rest = type.rest;
			const multiline = type.singleNames.length + (rest ? 1 : 0) > 1;
			const newIndent = multiline
				? indent + 1
				: indent;
			const elements = [
				...type.singleNames.map(element => {
					return `${element.name}${optionalTypeGuardToString(element.type, newIndent, depth + 1, suppressAlias)}`;
				}),
				...(rest
					? [`...${rest.name}${optionalTypeGuardToString(rest.type, newIndent, depth + 1, suppressAlias)}`]
					: []),
			];
			return bracketedExpressionToString(elements, multiline, indent, 'round');
		}
		case 'parameterReference':
			return type.name;
		case 'stream':
			return `${type.finite ? 'FiniteStream' : 'Stream'}(${typeToString(type.ValueType, indent, depth + 1, suppressAlias)})`;
		case 'text':
			return 'Text';
		case 'textLiteral':
			return `§${type.value.replaceAll('§', '§§')}§`;
		case 'tuple':
			return arrayTypeToString(type.ElementTypes, indent, depth + 1, suppressAlias);
		case 'conditional': {
			const operands = type.Operands.map(operand => typeToString(operand, indent, depth + 1, suppressAlias)).join(' ');
			const branches = type.Branches.map(branch =>
				`${typeToString(branch.Head, indent, depth + 1, suppressAlias)} => ${typeToString(branch.Result, indent, depth + 1, suppressAlias)}`);
			return `:?(${operands}) [${branches.join(', ')}]`;
		}
		case 'withElementAt':
			return `WithElementAt(${typeToString(type.Source, indent, depth + 1, suppressAlias)} ${typeToString(type.Index, indent, depth + 1, suppressAlias)} ${typeToString(type.Value, indent, depth + 1, suppressAlias)})`;
		case 'indexRange':
			return `IndexRange(${typeToString(type.Start, indent, depth + 1, suppressAlias)} ${typeToString(type.End, indent, depth + 1, suppressAlias)})`;
		case 'mapElements':
			return `MapElements(${typeToString(type.Source, indent, depth + 1, suppressAlias)} ${typeToString(type.Callback, indent, depth + 1, suppressAlias)})`;
		case 'concat':
			return `Concat(${type.Sources.map((source, i) =>
				i > 0 ? ' ' + typeToString(source, indent, depth + 1, suppressAlias) : typeToString(source, indent, depth + 1, suppressAlias)).join('')})`;
		case 'add':
			return `Add(${typeToString(type.ArgsType, indent, depth + 1, suppressAlias)})`;
		case 'type':
			return 'Type';
		case 'typeOf':
			return `TypeOf(${typeToString(type.value, indent, depth, suppressAlias)})`;
		case 'alias':
			// Wie aliasName: ab depth > 0 nur der Name, die äußerste Ebene wird ausgeschrieben.
			// suppressAlias greift nicht - es zielt auf Namen von Wertdefinitionen, und ein
			// Alias-Knoten entsteht nur für Typdefinitionen.
			return depth
				? aliasNameToString(type, indent)
				: typeToString(dereferenceAlias(type), indent, depth, suppressAlias);
		case 'predicate':
			// Gezeigt wird, was in Typ-Position stand. Die Obermenge wäre falsch: isEven ist nicht
			// Integer.
			return type.name ?? typeToString(type.FunctionType, indent, depth + 1, suppressAlias);
		default: {
			const assertNever: never = type;
			throw new Error(`Unexpected BuiltInType ${(assertNever as CompileTimeType).julType}`);
		}
	}
}

function optionalTypeGuardToString(type: CompileTimeType | undefined, indent: number, depth: number, suppressAlias: boolean): string {
	return type
		? `: ${typeToString(type, indent, depth, suppressAlias)}`
		: '';
}

function arrayTypeToString(
	array: CompileTimeType[],
	indent: number,
	depth: number,
	suppressAlias: boolean,
	kind: 'round' | 'square' = 'square',
): string {
	const multiline = array.length > maxElementsPerLine;
	const newIndent = multiline
		? indent + 1
		: indent;
	return bracketedExpressionToString(
		array.map(element =>
			typeToString(element, newIndent, depth, suppressAlias)),
		multiline,
		indent,
		kind);
}

/**
 * Ob typeToString(dictionary) mehrzeilig rendert - auch genutzt, um vor dem Bauen einer
 * umhüllenden "Can not assign X to Y."-Fehlerzeile zu entscheiden, ob X selbst ausgeschrieben
 * werden würde (dann trägt die Hülle nichts bei, was die Feld-Kette nicht ohnehin zeigt).
 * Eine Quelle statt zweier, die auseinanderlaufen könnten.
 */
function hasMultipleFields(dictionary: CompileTimeDictionary): boolean {
	return Object.keys(dictionary).length > 1;
}

function dictionaryTypeToString(
	dictionary: CompileTimeDictionary,
	nameSeparator: string,
	indent: number,
	depth: number,
	suppressAlias: boolean,
): string {
	const multiline = hasMultipleFields(dictionary);
	const newIndent = multiline
		? indent + 1
		: indent;
	const allFields = map(
		dictionary,
		(element, key) => {
			return `${key}${nameSeparator}${typeToString(element, newIndent, depth, suppressAlias)}`;
		});

	// Begrenzen bei zu vielen Feldern: zeige maxFieldsInTypeDump Felder, dann "and N more"
	let displayFields = allFields;
	if (allFields.length > maxFieldsInTypeDump) {
		displayFields = [
			...allFields.slice(0, maxFieldsInTypeDump),
			// Als JUL-Kommentar, damit das Syntax-Highlighting es nicht als Code darstellt
			`# and ${allFields.length - maxFieldsInTypeDump} more field${allFields.length - maxFieldsInTypeDump === 1 ? '' : 's'}`,
		];
	}

	return bracketedExpressionToString(
		displayFields,
		multiline,
		indent);
}

/**
 * @param kind Daten werden eckig geschrieben, Bindungsstellen (Parameterliste,
 * Argumentliste eines Typaufrufs wie Or/And) rund.
 */
function bracketedExpressionToString(
	elements: string[],
	multiline: boolean,
	indent: number,
	kind: 'round' | 'square' = 'square',
): string {
	// Dieselbe Einheit wie indentLines (indentUnit) - sonst mischen sich Tabs und Leerzeichen,
	// sobald dieser Dump in eine bereits eingerückte Fehlerkette eingebettet wird (Fund im
	// echten yugioh-Fehlerbild, Session 2026-09-10).
	const indentString = indentUnit.repeat(indent + 1);
	const openingBracketSeparator = multiline
		? '\n' + indentString
		: '';
	const elementSeparator = multiline
		? '\n' + indentString
		: ' ';
	const closingBracketSeparator = multiline
		? '\n' + indentUnit.repeat(indent)
		: '';
	const [opening, closing] = kind === 'round'
		? ['(', ')']
		: ['[', ']'];
	return `${opening}${openingBracketSeparator}${elements.join(elementSeparator)}${closingBracketSeparator}${closing}`;
}

//#endregion ToString
