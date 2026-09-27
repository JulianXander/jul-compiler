// Enthält Laufzeit helper sowie core-lib builtins

//#region helper
let processId = 1;

export interface Params {
	type?: RuntimeType;
	singleNames?: {
		name: string;
		type?: RuntimeType;
		source?: string;
	}[];
	rest?: {
		type?: RuntimeType;
	};
}

type JulFunction = Function & { params: Params; };

//#region internals

export function _branch(args: Collection | undefined, ...branches: JulFunction[]) {
	// TODO collect inner Errors?
	for (const branch of branches) {
		const assignedParams = tryAssignArgs(branch.params, undefined, args);
		if (!(assignedParams instanceof Error)) {
			return branch(...assignedParams);
		}
	}
	return _noBranchMatched(args);
}

/**
 * Ergebnis eines branchings, das keinen branch trifft. Eigener Helper, weil der Emitter bei
 * statisch unterscheidbaren branches ohne _branch auskommt und den Fall selbst emittiert.
 */
export function _noBranchMatched(args: unknown) {
	return new Error(`${args} did not match any branch`);
}

/**
 * Wird aufgerufen mit args = dictionary, oder unknown object, also Ergebnis von _combineObject
 */
export function _callFunction(fn: JulFunction | Function, prefixArg: any, args: Collection | undefined) {
	if ('params' in fn) {
		// jul function
		const assignedParams = assignArgs(fn.params, prefixArg, args);
		return fn(...assignedParams);
	}
	// js function
	const wrappedArgs = Array.isArray(args)
		? args
		: [args];
	const argsWithPrefix = prefixArg === undefined
		? wrappedArgs
		: [prefixArg, ...wrappedArgs];
	return fn(...argsWithPrefix);
}

export function _combineObject(...parts: (Collection | undefined)[]): Collection | undefined {
	const nonEmptyParts = parts.filter(part => part !== undefined);
	const firstNonEmptyPart = nonEmptyParts[0];
	if (!firstNonEmptyPart) {
		return;
	}
	if (Array.isArray(firstNonEmptyPart)) {
		return ([] as any[]).concat(...nonEmptyParts);
	}
	else {
		return Object.assign({}, ...nonEmptyParts);
	}
}

/**
 * Behält den Typ von fn: Builtins sind als `export const x = _createFunction(...)` definiert und
 * werden in der Runtime selbst mit ihrer eigentlichen Signatur aufgerufen.
 */
export function _createFunction<F extends Function>(fn: F, params: Params): F & JulFunction {
	const julFn = fn as F & JulFunction;
	julFn.params = params;
	return julFn;
}

//#endregion internals

//#region toString

function typeToString(type: RuntimeType, indent: number): string {
	switch (typeof type) {
		case 'bigint':
		case 'boolean':
			return type.toString();
		case 'function':
			return 'CustomType: ' + type;
		case 'number':
			return type.toString() + 'f';
		case 'object': {
			if (type === null) {
				// TODO throw error?
				return '[]';
			}
			if (Array.isArray(type)) {
				return arrayTypeToString(type, indent);
			}
			if (_julTypeSymbol in type) {
				switch (type[_julTypeSymbol]) {
					case 'and':
						return `And${arrayTypeToString(type.ChoiceTypes, indent, 'round')}`;
					case 'any':
						return 'Any';
					case 'blob':
						return 'Blob';
					case 'boolean':
						return 'Boolean';
					case 'date':
						return 'Date';
					case 'dictionary':
						return `Dictionary(${typeToString(type.ElementType, indent)})`;
					case 'dictionaryLiteral':
						return dictionaryTypeToString(type.Fields, ': ', indent);
					case 'empty':
						return 'Empty';
					case 'error':
						return 'Error';
					case 'float':
						return 'Float';
					case 'function':
						return 'Function';
					case 'greater':
						return `Greater(${typeToString(type.Value, indent)})`;
					case 'integer':
						return 'Integer';
					case 'list':
						return `List(${typeToString(type.ElementType, indent)})`;
					case 'not':
						return `Not(${typeToString(type.SourceType, indent)})`;
					case 'or':
						return `Or${arrayTypeToString(type.ChoiceTypes, indent, 'round')}`;
					case 'stream':
						return 'Stream';
					case 'text':
						return 'Text';
					case 'tuple':
						return arrayTypeToString(type.ElementTypes, indent);
					case 'type':
						return 'Type';
					case 'typeOf':
						return `TypeOf(${typeToString(type.value, indent)})`;
					case 'lazy':
						// Der Name statt des Typs: ausgeschrieben endete die Rekursion nicht.
						return type.name;
					default: {
						const assertNever: never = type;
						throw new Error(`Unexpected BuiltInType ${(assertNever as BuiltInType)[_julTypeSymbol]}`);
					}
				}
			}
			// Dictionary
			return dictionaryTypeToString(type, ' = ', indent);;
		}
		case 'string':
			return `§${type.replaceAll('§', '§§')}§`;
		case 'undefined':
			return '[]';
		default: {
			const assertNever: never = type;
			throw new Error(`Unexpected type ${typeof assertNever}`);
		}
	}
}

/**
 * Für die Ausgabe von Werten in test-runtime.ts.
 */
export { typeToString as _typeToString };

const maxElementsPerLine = 5;
function arrayTypeToString(
	array: RuntimeType[],
	indent: number,
	kind: 'round' | 'square' = 'square',
): string {
	const multiline = array.length > maxElementsPerLine;
	const newIndent = multiline
		? indent + 1
		: indent;
	return bracketedExpressionToString(
		array.map(element =>
			typeToString(element, newIndent)),
		multiline,
		indent,
		kind);
}

function dictionaryTypeToString(
	dictionary: RuntimeDictionary,
	nameSeparator: string,
	indent: number,
): string {
	const multiline = Object.keys(dictionary).length > 1;
	const newIndent = multiline
		? indent + 1
		: indent;
	return bracketedExpressionToString(
		Object.entries(dictionary).map(([key, element]) => {
			return `${key}${nameSeparator}${typeToString(element, newIndent)}`;
		}),
		multiline,
		indent);
}

/**
 * @param kind Daten werden eckig geschrieben, die Argumentliste eines Typaufrufs
 * wie Or/And rund.
 */
function bracketedExpressionToString(
	elements: string[],
	multiline: boolean,
	indent: number,
	kind: 'round' | 'square' = 'square',
): string {
	const indentString = '\t'.repeat(indent + 1);
	const openingBracketSeparator = multiline
		? '\n' + indentString
		: '';
	const elementSeparator = multiline
		? '\n' + indentString
		: ' ';
	const closingBracketSeparator = multiline
		? '\n' + '\t'.repeat(indent)
		: '';
	const [opening, closing] = kind === 'round'
		? ['(', ')']
		: ['[', ']'];
	return `${opening}${openingBracketSeparator}${elements.join(elementSeparator)}${closingBracketSeparator}${closing}`;
}

//#endregion toString

//#region check type

/**
 * Erfüllt value den Typ? Für den Checker, der ein Prädikat für einen konstanten Wert faltet und
 * dabei dieselbe Regel braucht wie die Laufzeit.
 */
export function _isOfType(value: any, type: RuntimeType): boolean {
	return getTypeError(value, type) === undefined;
}

function getTypeError(value: any, type: RuntimeType): string | undefined {
	switch (typeof type) {
		case 'bigint':
		case 'boolean':
		case 'number':
		case 'string':
		case 'undefined':
			if (value === type) {
				return undefined;
			}
			break;
		case 'object': {
			if (type === null) {
				if (value === null) {
					return undefined;
				}
				break;
			}
			if (Array.isArray(type)) {
				return getTupleTypeError(value, type);
			}
			if (_julTypeSymbol in type) {
				switch (type[_julTypeSymbol]) {
					case 'any':
						return undefined;
					case 'empty':
						if (value === undefined) {
							return undefined;
						}
						break;
					case 'boolean':
						if (typeof value === 'boolean') {
							return undefined;
						}
						break;
					case 'integer':
						if (typeof value === 'bigint') {
							return undefined;
						}
						break;
					case 'float':
						if (typeof value === 'number') {
							return undefined;
						}
						break;
					case 'greater':
						if (value > type.Value) {
							return undefined;
						}
						break;
					case 'text':
						if (typeof value === 'string') {
							return undefined;
						}
						break;
					case 'date':
						if (value instanceof Date) {
							return undefined;
						}
						break;
					case 'blob':
						if (value instanceof Blob) {
							return undefined;
						}
						break;
					case 'error':
						if (value instanceof Error) {
							return undefined;
						}
						break;
					case 'dictionary': {
						if (!isDictionary(value)) {
							return `The value ${value} is not a Dictionary.`;
						}
						const elementType = type.ElementType;
						if (elementType === Any) {
							return undefined;
						}
						for (const key in value) {
							const elementValue = value[key];
							const elementError = getTypeError(elementValue, elementType);
							if (elementError) {
								return `Invalid value for field ${key}.\n${elementError}`;
							}
						}
						return undefined;
					}
					case 'dictionaryLiteral':
						return getDictionaryLiteralTypeError(value, type.Fields);
					case 'list': {
						if (!Array.isArray(value)) {
							return `The value ${value} is not an Array.`;
						}
						if (!value.length) {
							return 'The value has no elements.';
						}
						const elementType = type.ElementType;
						if (elementType === Any) {
							return undefined;
						}
						for (let index = 0; index < value.length; index++) {
							const elementValue = value[index];
							const elementError = getTypeError(elementValue, elementType);
							if (elementError) {
								return `Invalid value at index ${index + 1}.\n${elementError}`;
							}
						}
						return undefined;
					}
					case 'tuple':
						return getTupleTypeError(value, type.ElementTypes);
					case 'stream':
						if (value instanceof StreamClass) {
							return undefined;
						}
						break;
					case 'function':
						if (typeof value === 'function') {
							return undefined;
						}
						break;
					case 'type': {
						const valueType = typeof value;
						switch (valueType) {
							case 'bigint':
							case 'boolean':
							case 'function':
							case 'number':
							case 'string':
							case 'undefined':
								return undefined;
							case 'object':
								if (_julTypeSymbol in value) {
									return undefined;
								}
								break;
							case 'symbol':
								break;
							default: {
								const assertNever: never = valueType;
								throw new Error(`Unexpected type ${assertNever}`);
							}
						}
						break;
					}
					case 'and':
						for (const coiceType of type.ChoiceTypes) {
							const choiceError = getTypeError(value, coiceType);
							if (choiceError) {
								return choiceError;
							}
						}
						return undefined;
					case 'or':
						const choiceErrors = [];
						for (const coiceType of type.ChoiceTypes) {
							const choiceError = getTypeError(value, coiceType);
							if (!choiceError) {
								return undefined;
							}
							choiceErrors.push(choiceError);
						}
						return 'No choice is valid.\n' + choiceErrors.join('\n');
					case 'not':
						if (getTypeError(value, type.SourceType)) {
							return undefined;
						}
						break;
					case 'typeOf':
						if (isDeepEqual(value, type.value)) {
							return undefined;
						}
						break;
					// Selten, deshalb zuletzt: die Prüfung ist der heißeste Pfad der Runtime.
					case 'lazy':
						return getTypeError(value, type.getType());
					default: {
						const assertNever: never = type;
						throw new Error(`Unexpected BuiltInType ${(assertNever as BuiltInType)[_julTypeSymbol]}`);
					}
				}
				break;
			}
			// Dictionary
			return getDictionaryLiteralTypeError(value, type);
		}
		case 'function':
			// Ein Prädikat: erfüllt ist es nur bei genau true, nicht bei jedem truthy Ergebnis wie
			// dem Error eines nicht erschöpfenden branchings. Eine JUL-Funktion bekommt den Wert über
			// ihre Parameterbindung wie in _branch, damit ihre Parametertypen mitzählen und ein
			// Typ-Kopf wie [Integer] => true das Argument überhaupt bekommt. Passt der Wert nicht auf
			// die Parameter, ist das Prädikat nicht erfüllt.
			if ('params' in type) {
				const predicate = type as JulFunction;
				const assignedParams = tryAssignArgs(predicate.params, undefined, [value]);
				if (!(assignedParams instanceof Error)
					&& predicate(...assignedParams) === true) {
					return undefined;
				}
				break;
			}
			if (type(value) === true) {
				return undefined;
			}
			break;
		default: {
			const assertNever: never = type;
			throw new Error(`Unexpected type ${typeof assertNever}`);
		}
	}
	return `Can not assign the value ${value} to type ${typeToString(type, 0)}`;
}

function getTupleTypeError(value: any, elementTypes: RuntimeType[]): string | undefined {
	if (!Array.isArray(value)) {
		return `The value ${value} is not an Array.`;
	}
	if (value.length < elementTypes.length) {
		return `The value has too few elements. Expected ${elementTypes.length} but got ${value.length}.`;
	}
	for (let index = 0; index < elementTypes.length; index++) {
		const elementType = elementTypes[index];
		const elementValue = value[index];
		const elementError = getTypeError(elementValue, elementType);
		if (elementError) {
			return `Invalid value at index ${index + 1}.\n${elementError}`;
		}
	}
}

function getDictionaryLiteralTypeError(value: any, fieldTypes: RuntimeDictionary): string | undefined {
	if (!isDictionary(value)) {
		return `The value ${value} is not a Dictionary.`;
	}
	for (const key in fieldTypes) {
		const elementValue = value[key];
		const elementType = fieldTypes[key];
		const elementError = getTypeError(elementValue, elementType);
		if (elementError) {
			return `Invalid value for field ${key}.\n${elementError}`;
		}
	}
}

function isRealObject(value: any): value is Collection {
	return typeof value === 'object'
		&& value !== null;
}

// TODO check empty prototype?
function isDictionary(value: any): value is RuntimeDictionary {
	return isRealObject(value)
		&& !(_julTypeSymbol in value)
		&& !(value instanceof Error)
		&& !Array.isArray(value);
}

//#endregion check type

/**
 * Ohne type check
 */
function assignArgs(
	params: Params,
	prefixArg: any,
	args: Collection | undefined,
): any[] {
	const assignedValues: any[] = [];
	const { type: paramsType, singleNames, rest } = params;
	const hasPrefixArg = prefixArg !== undefined;
	if (paramsType !== undefined) {
		return assignedValues;
	}
	const isArray = Array.isArray(args);
	let paramIndex = 0;
	let argIndex = 0;
	if (singleNames) {
		for (; paramIndex < singleNames.length; paramIndex++) {
			const param = singleNames[paramIndex]!;
			const { name, source } = param;
			const sourceWithFallback = source ?? name;
			let arg;
			if (hasPrefixArg && !paramIndex) {
				arg = prefixArg;
			}
			else {
				arg = isArray
					? args[argIndex]
					: args?.[sourceWithFallback];
				argIndex++;
			}
			assignedValues.push(arg);
		}
	}
	if (rest) {
		if (args === undefined) {
			const remainingArgs = hasPrefixArg && !paramIndex
				? [prefixArg]
				: undefined;
			assignedValues.push(...remainingArgs ?? []);
		}
		else if (isArray) {
			const remainingArgs = args.slice(argIndex);
			if (hasPrefixArg && !paramIndex) {
				remainingArgs.unshift(prefixArg);
			}
			assignedValues.push(...remainingArgs);
		}
		else {
			// TODO rest dictionary??
			throw new Error('tryAssignArgs not implemented yet for rest dictionary');
		}
	}
	return assignedValues;
}

/**
 * Mit type check
 */
function tryAssignArgs(
	params: Params,
	prefixArg: any,
	args: Collection | undefined,
): any[] | Error {
	const assignedValues: any[] = [];
	const { type: paramsType, singleNames, rest } = params;
	const hasPrefixArg = prefixArg !== undefined;
	if (paramsType !== undefined) {
		// TODO typecheck prefixArg with paramsType?
		const typeError = getTypeError(args, paramsType);
		if (typeError) {
			return new Error(`Can not assign the value to params.\n${typeError}`);
		}
		return assignedValues;
	}
	const isArray = Array.isArray(args);
	let paramIndex = 0;
	let argIndex = 0;
	if (singleNames) {
		for (; paramIndex < singleNames.length; paramIndex++) {
			const param = singleNames[paramIndex]!;
			const { name, type, source } = param;
			const sourceWithFallback = source ?? name;
			let arg;
			if (hasPrefixArg && !paramIndex) {
				arg = prefixArg;
			}
			else {
				arg = isArray
					? args[argIndex]
					: args?.[sourceWithFallback];
				argIndex++;
			}
			const typeError = type
				? getTypeError(arg, type)
				: undefined;
			if (typeError) {
				return new Error(`Can not assign the value to param ${sourceWithFallback}.\n${typeError}`);
			}
			assignedValues.push(arg);
		}
	}
	if (rest) {
		const restType = rest.type;
		if (args === undefined) {
			const remainingArgs = hasPrefixArg && !paramIndex
				? [prefixArg]
				: undefined;
			const typeError = restType
				? getTypeError(remainingArgs, restType)
				: undefined;
			if (typeError) {
				return new Error(`Can not assign the value to rest param.\n${typeError}`);
			}
			assignedValues.push(...remainingArgs ?? []);
		}
		else if (isArray) {
			const remainingArgs = args.slice(argIndex);
			if (hasPrefixArg && !paramIndex) {
				remainingArgs.unshift(prefixArg);
			}
			const typeError = restType
				? getTypeError(remainingArgs, restType)
				: undefined;
			if (typeError) {
				return new Error(`Can not assign the value to rest param.\n${typeError}`);
			}
			assignedValues.push(...remainingArgs);
		}
		else {
			// TODO rest dictionary??
			throw new Error('tryAssignArgs not implemented yet for rest dictionary');
		}
	}
	return assignedValues;
}

// TODO toString

function isDeepEqual(value1: any, value2: any): boolean {
	if (value1 === value2) {
		return true;
	}
	const type1 = typeof value1;
	switch (type1) {
		case 'bigint':
		case 'boolean':
		case 'function':
		case 'number':
		case 'string':
		case 'symbol':
		case 'undefined':
			return false;
		case 'object':
			if (typeof value2 !== 'object') {
				return false;
			}
			if (value1 === null || value2 === null) {
				return false;
			}
			else if (value1 instanceof StreamClass || value2 instanceof StreamClass) {
				return false;
			}
			else if (Array.isArray(value1) || Array.isArray(value2)) {
				if (!Array.isArray(value1)
					|| !Array.isArray(value2)
					|| value1.length !== value2.length) {
					return false;
				}
				for (let index = 0; index < value1.length; index++) {
					const elementValuesEqual = isDeepEqual(value1[index], value2[index]);
					if (!elementValuesEqual) {
						return false;
					}
				}
				return true;
			}
			else {
				// Dictionary/Function Object
				if (Object.keys(value1).length !== Object.keys(value2).length) {
					return false;
				}
				for (const key in value1) {
					const fieldValuesEqual = isDeepEqual(value1[key], value2[key]);
					if (!fieldValuesEqual) {
						return false;
					}
				}
				return true;
			}
		default: {
			const assertNever: never = type1;
			throw new Error('Unexpected type for deepEqual: ' + assertNever);
		}
	}
}

//#region Types

type Primitive =
	| undefined
	| boolean
	| number
	| bigint
	| string
	;

interface RuntimeDictionary { [key: string]: RuntimeType; }

type Collection =
	| RuntimeType[]
	| RuntimeDictionary
	;

type RuntimeType =
	| Primitive
	| Collection
	| BuiltInType
	| CustomType
	;

/**
 * numerator / denominator
 */
interface RuntimeFraction {
	numerator: bigint;
	denominator: bigint;
}

type RuntimeRational = bigint | RuntimeFraction;

type CustomType = (value: any) => boolean;

//#region BuiltInType

type BuiltInType =
	| AnyType
	| EmptyType
	| BooleanType
	| IntegerType
	| FloatType
	| GreaterType
	| TextType
	| DateType
	| BlobType
	| ErrorType
	| ListType
	| TupleType
	| DictionaryType
	| DictionaryLiteralType
	| StreamType
	| FunctionType
	| TypeType
	| IntersectionType
	| UnionType
	| ComplementType
	| TypeOfType
	| LazyType
	;


/**
 * Wird vom emitter benutzt
 */
export const _julTypeSymbol = /*#__PURE__*/ Symbol.for('julType');

interface AnyType {
	readonly [_julTypeSymbol]: 'any';
}

interface EmptyType {
	readonly [_julTypeSymbol]: 'empty';
}

interface BooleanType {
	readonly [_julTypeSymbol]: 'boolean';
}

interface IntegerType {
	readonly [_julTypeSymbol]: 'integer';
}

interface FloatType {
	readonly [_julTypeSymbol]: 'float';
}

interface GreaterType {
	readonly [_julTypeSymbol]: 'greater';
	readonly Value: bigint | number;
}

interface TextType {
	readonly [_julTypeSymbol]: 'text';
}

interface DateType {
	readonly [_julTypeSymbol]: 'date';
}

interface BlobType {
	readonly [_julTypeSymbol]: 'blob';
}

interface ErrorType {
	readonly [_julTypeSymbol]: 'error';
}

interface ListType {
	readonly [_julTypeSymbol]: 'list';
	readonly ElementType: RuntimeType;
}

interface TupleType {
	readonly [_julTypeSymbol]: 'tuple';
	readonly ElementTypes: RuntimeType[];
}

interface DictionaryType {
	readonly [_julTypeSymbol]: 'dictionary';
	readonly ElementType: RuntimeType;
}

interface DictionaryLiteralType {
	readonly [_julTypeSymbol]: 'dictionaryLiteral';
	readonly Fields: RuntimeDictionary;
}

interface StreamType {
	readonly [_julTypeSymbol]: 'stream';
}

const _StreamType: StreamType = { [_julTypeSymbol]: 'stream' };

interface FunctionType {
	readonly [_julTypeSymbol]: 'function';
}

/**
 * Wird vom emitter benutzt
 */
export const _Function: FunctionType = { [_julTypeSymbol]: 'function' };

interface TypeType {
	readonly [_julTypeSymbol]: 'type';
}

interface IntersectionType {
	readonly [_julTypeSymbol]: 'and';
	readonly ChoiceTypes: RuntimeType[];
}

interface UnionType {
	readonly [_julTypeSymbol]: 'or';
	readonly ChoiceTypes: RuntimeType[];
}

interface ComplementType {
	readonly [_julTypeSymbol]: 'not';
	readonly SourceType: RuntimeType;
}


interface TypeOfType {
	readonly [_julTypeSymbol]: 'typeOf';
	readonly value: RuntimeType;
}

/**
 * Die Selbstreferenz eines rekursiven Typs (`Node = [children: List(Node)]`). Sie wird erst beim
 * Prüfen aufgelöst, beim Bauen der Definition ist die Konstante noch nicht fertig.
 *
 * Wer Laufzeittypen verarbeitet, muss je nach Art unterschiedlich mit diesem Knoten umgehen:
 * - Ein Durchlauf, der der Struktur des Typs folgt (typeToString, Typgleichheit, Serialisierung),
 *   hält hier an und ruft getType nie auf: bei einem rekursiven Typ endete er sonst nicht.
 * - Ein Durchlauf, der einem Wert folgt (getTypeError), darf auflösen: er geht nur so tief wie der
 *   endliche Wert. Das setzt voraus, dass jeder Zyklus durch eine Datenebene läuft, die Wert
 *   verbraucht - der Checker erzwingt das mit JUL5170. `A = Or([] A)` liefe hier endlos.
 * - Wer eine Ebene in einen Typ hineinschaut (ElementAt, LengthOf), löst vorher auf, sonst fällt
 *   der Knoten still in den default-Zweig.
 * Fallunterscheidungen mit never-Prüfung erzwingen einen Fall für lazy, solche mit default-Zweig
 * oder einer Prüfung wie `_julTypeSymbol in type` nicht.
 */
interface LazyType {
	readonly [_julTypeSymbol]: 'lazy';
	readonly name: string;
	readonly getType: () => RuntimeType;
}

/**
 * Wird vom emitter benutzt
 */
export function _lazyType(name: string, getType: () => RuntimeType): LazyType {
	return {
		[_julTypeSymbol]: 'lazy',
		name: name,
		getType: getType,
	};
}

//#endregion BuiltInType

function optionalType(...types: RuntimeType[]): UnionType {
	return Or(undefined, ...types);
}

//#endregion Types

//#region JSON

//#region parse

type ParserResult<T> = {
	parsed: T,
	endIndex: number;
} | Error;

export type JsonValue =
	| undefined
	| boolean
	| RuntimeRational
	| string
	| JsonValue[]
	| { [key: string]: JsonValue; }
	;

export function _parseJson(json: string): JsonValue | Error {
	const result = parseJsonValue(json, 0);
	if (result instanceof Error) {
		return result;
	}
	const endIndex = parseJsonWhiteSpace(json, result.endIndex);
	if (endIndex < json.length) {
		return new Error(`Invalid JSON. Unexpected extra charcter ${json[endIndex]} after parsed value at position ${endIndex}`);
	}
	return result.parsed;
}

function parseJsonValue(json: string, startIndex: number): ParserResult<JsonValue> {
	let index = parseJsonWhiteSpace(json, startIndex);
	const character = json[index];
	switch (character) {
		case 'n':
			return parseJsonToken(json, index, 'null', undefined);
		case 't':
			return parseJsonToken(json, index, 'true', true);
		case 'f':
			return parseJsonToken(json, index, 'false', false);
		case '-':
		case '0':
		case '1':
		case '2':
		case '3':
		case '4':
		case '5':
		case '6':
		case '7':
		case '8':
		case '9': {
			const isNegative = character === '-';
			const numberRegex = /(?<integer>0|[1-9][0-9]*)(\.(?<fraction>[0-9]+))?([eE](?<exponent>[-+]?[0-9]+))?/y;
			numberRegex.lastIndex = isNegative
				? index + 1
				: index;
			const match = numberRegex.exec(json);
			if (!match) {
				return new Error(`Invalid JSON. Failed to parse number at position ${index}`);
			}
			const integerString = (isNegative ? '-' : '') + match.groups!.integer!;
			const fractionString = match.groups!.fraction;
			const numerator = BigInt(integerString + (fractionString ?? ''));
			const exponentString = match.groups!.exponent;
			const fractionExponent = fractionString
				? BigInt('-' + fractionString.length)
				: 0n;
			const exponent = exponentString
				? BigInt(exponentString)
				: 0n;
			const combinedExponent = fractionExponent + exponent;
			const numberValue: RuntimeRational = combinedExponent < 0
				? normalizeRational(numerator, 10n ** (-1n * combinedExponent))
				: numerator * 10n ** combinedExponent;
			return {
				parsed: numberValue,
				endIndex: numberRegex.lastIndex,
			};
		}
		case '"':
			return parseJsonString(json, index + 1);
		case '[': {
			index++;
			let array: any[] | undefined = undefined;
			index = parseJsonWhiteSpace(json, index);
			if (json[index] === ']') {
				return {
					parsed: array,
					endIndex: index + 1,
				};
			}
			let isSeparator = false;
			while (index < json.length) {
				if (isSeparator) {
					index = parseJsonWhiteSpace(json, index);
					const arrayCharacter = json[index];
					switch (arrayCharacter) {
						case ',':
							isSeparator = false;
							index++;
							break;
						case ']':
							return {
								parsed: array,
								endIndex: index + 1,
							};
						default:
							return new Error(`Invalid JSON. Unexpected character ${arrayCharacter} at position ${index} while parsing array.`);
					}
				}
				else {
					const elementResult = parseJsonValue(json, index);
					if (elementResult instanceof Error) {
						return elementResult;
					}
					if (!array) {
						array = [];
					}
					array.push(elementResult.parsed);
					isSeparator = true;
					index = elementResult.endIndex;
				}
			}
		}
		case '{': {
			index++;
			let object: { [key: string]: any; } | undefined = undefined;
			index = parseJsonWhiteSpace(json, index);
			if (json[index] === '}') {
				return {
					parsed: object,
					endIndex: index + 1,
				};
			}
			let isSeparator = false;
			while (index < json.length) {
				index = parseJsonWhiteSpace(json, index);
				const objectCharacter = json[index];
				if (isSeparator) {
					switch (objectCharacter) {
						case ',':
							isSeparator = false;
							index++;
							break;
						case '}':
							return {
								parsed: object,
								endIndex: index + 1,
							};
						default:
							return new Error(`Invalid JSON. Unexpected character ${objectCharacter} at position ${index} while parsing object.`);
					}
				}
				else {
					if (objectCharacter !== '"') {
						return new Error(`Invalid JSON. Unexpected character ${objectCharacter} at position ${index} while parsing object key.`);
					}
					const keyResult = parseJsonString(json, index + 1);
					if (keyResult instanceof Error) {
						return keyResult;
					}
					const colonIndex = parseJsonWhiteSpace(json, keyResult.endIndex);
					const colonCharacter = json[colonIndex];
					if (colonCharacter !== ':') {
						return new Error(`Invalid JSON. Unexpected character ${objectCharacter} at position ${index} while parsing colon.`);
					}
					const valueResult = parseJsonValue(json, colonIndex + 1);
					if (valueResult instanceof Error) {
						return valueResult;
					}
					if (!object) {
						object = {};
					}
					const key = keyResult.parsed;
					if (key === '__proto__') {
						// Die Zuweisung würde den Prototyp setzen statt eines Felds
						Object.defineProperty(object, key, {
							value: valueResult.parsed,
							writable: true,
							enumerable: true,
							configurable: true,
						});
					}
					else {
						object[key] = valueResult.parsed;
					}
					isSeparator = true;
					index = valueResult.endIndex;
				}
			}
		}
		default:
			return new Error(`Invalid JSON. Unexpected character ${character} at position ${index}`);
	}
}

function parseJsonWhiteSpace(json: string, startIndex: number): number {
	const whiteSpaceRegex = /[ \n\r\t]*/y;
	whiteSpaceRegex.lastIndex = startIndex;
	whiteSpaceRegex.exec(json);
	return whiteSpaceRegex.lastIndex;
}

function parseJsonToken(json: string, startIndex: number, token: string, value: any): ParserResult<any> {
	const endIndex = startIndex + token.length;
	if (json.substring(startIndex, endIndex) !== token) {
		return new Error(`Inavlid JSON. Failed to parse value ${token} at position ${startIndex}`);
	}
	return {
		parsed: value,
		endIndex: endIndex,
	};
}

/**
 * startIndex fängt hinter dem ersten " an
 */
function parseJsonString(json: string, startIndex: number): ParserResult<string> {
	let stringValue = '';
	// Abschnitte ohne Escape werden am Stück übernommen, das Anhängen je Zeichen war der teuerste
	// Teil des Parsers
	let chunkStartIndex = startIndex;
	for (let index = startIndex; index < json.length; index++) {
		const stringCharacter = json[index];
		switch (stringCharacter) {
			case '"':
				return {
					parsed: stringValue + json.substring(chunkStartIndex, index),
					endIndex: index + 1,
				};
			case '\\':
				stringValue += json.substring(chunkStartIndex, index);
				index++;
				if (index === json.length) {
					return new Error('Invalid JSON. String not terminated.');
				}
				const escapedCharacter = json[index];
				switch (escapedCharacter) {
					case '"':
					case '\\':
					case '/':
						stringValue += escapedCharacter;
						break;
					case 'b':
						stringValue += '\b';
						break;
					case 'f':
						stringValue += '\f';
						break;
					case 'n':
						stringValue += '\n';
						break;
					case 'r':
						stringValue += '\r';
						break;
					case 't':
						stringValue += '\t';
						break;
					case 'u':
						index++;
						const hexEndIndex = index + 4;
						if (hexEndIndex >= json.length) {
							return new Error('Invalid JSON. String not terminated.');
						}
						const hexCharacters = json.substring(index, hexEndIndex);
						if (!/[0-9a-fA-F]{4}/.test(hexCharacters)) {
							return new Error(`Invalid JSON. Invalid hex code at position ${index}.`);
						}
						stringValue += String.fromCharCode(parseInt(hexCharacters, 16));
						index = hexEndIndex - 1;
						break;
					default:
						return new Error(`Invalid JSON. Invalid escape sequence \\${escapedCharacter} at position ${index - 1}.`);
				}
				chunkStartIndex = index + 1;
				break;
			default:
				if (stringCharacter! < ' ') {
					return new Error(`Invalid JSON. Unescaped control character U+${stringCharacter!.charCodeAt(0).toString(16).padStart(4, '0')} at position ${index}.`);
				}
				break;
		}
	}
	return new Error('Invalid JSON. String not terminated.');
}

//#endregion parse

function _toJson(value: RuntimeType): string | Error {
	switch (typeof value) {
		case 'bigint':
		case 'boolean':
		case 'number':
			return value.toString();
		case 'string':
			return JSON.stringify(value);
		case 'function':
		case 'object': {
			if (!value) {
				return 'null';
			}
			if (Array.isArray(value)) {
				return `[${value.map(_toJson).join()}]`;
			}
			return `{${Object.entries(value).map(([key, innerValue]) => {
				return `${_toJson(key)}:${_toJson(innerValue)}`;
			}).join()}}`;
		};
		case 'symbol':
			return new Error('Can not convert symbol to JSON');
		case 'undefined':
			return 'null';
		default: {
			const assertNever: never = value;
			return new Error(`Unexpected type ${typeof assertNever}`);
		}
	}
}

//#endregion JSON

//#endregion helper

//#region builtins
// Dieser Block ist die tatsächliche Laufzeit-Implementierung aller in core-lib.jul deklarierten Builtins.
// core-lib.jul wird nur geparst, um dem Checker Typinformationen (builtInSymbols) zu liefern - sie wird
// nie emittiert, ihr eigener js-Text in nativeFunction(...)-Aufrufen läuft also nie. Jedes kompilierte
// Modul importiert stattdessen die Exporte dieser Datei, die es benutzt (siehe getUsedRuntimeNames in
// emitter.ts), und Referenzen auf Builtin-Symbole werden vom Emitter als einfache JS-Identifier ausgegeben,
// die hierher auflösen. core-lib.jul's js-Text dient also nur als für Menschen lesbare Referenz und muss
// von Hand synchron zu den Implementierungen hier gehalten werden.
//
// Jede Definition ist ein einzelner Ausdruck ohne Seiteneffekt beim Laden, Aufrufe darin sind mit
// /*#__PURE__*/ markiert. Nur so darf der Compiler weglassen, was ein Programm nicht erreicht
// (shakeRuntime in runtime-shaking.ts). Nach Änderungen: npm run check-runtime-purity. Die Funktion ist benannt (function x statt Arrow),
// sonst fehlte ihr Name im Stacktrace.
//#region Types
export const Any: AnyType = { [_julTypeSymbol]: 'any' };
export const Empty: EmptyType = { [_julTypeSymbol]: 'empty' };
export const Type: TypeType = { [_julTypeSymbol]: 'type' };
export const List = /*#__PURE__*/ _createFunction(
	function List(ElementType: RuntimeType): ListType {
		return {
			[_julTypeSymbol]: 'list',
			ElementType: ElementType,
		};
	},
	{
		singleNames: [
			{
				name: 'ElementType',
				type: Type,
			},
		]
	}
);
export const And = /*#__PURE__*/ _createFunction(
	function And(...ChoiceTypes: RuntimeType[]): IntersectionType {
		// TODO flatten nested IntersectionTypes?
		return {
			[_julTypeSymbol]: 'and',
			ChoiceTypes: ChoiceTypes,
		};
	},
	{
		rest: {
			type: /*#__PURE__*/ List(Type)
		}
	}
);
export const Or = /*#__PURE__*/ _createFunction(
	function Or(...ChoiceTypes: RuntimeType[]): UnionType {
		// TODO flatten nested UnionTypes?
		return {
			[_julTypeSymbol]: 'or',
			ChoiceTypes: ChoiceTypes,
		};
	},
	{
		rest: {
			type: /*#__PURE__*/ List(Type)
		}
	}
);
export const Not = /*#__PURE__*/ _createFunction(
	function Not(T: RuntimeType) {
		return {
			[_julTypeSymbol]: 'not',
			SourceType: T,
		};
	},
	{
		singleNames: [
			{
				name: 'T',
				type: Type,
			},
		]
	}
);
// TODO Without
export const TypeOf = /*#__PURE__*/ _createFunction(
	function TypeOf(value: any): TypeOfType {
		return {
			[_julTypeSymbol]: 'typeOf',
			value: value,
		};
	},
	{
		singleNames: [
			{
				name: 'value',
			},
		]
	}
);
export const _Boolean: BooleanType = { [_julTypeSymbol]: 'boolean' };
//#region Number
export const Float: FloatType = { [_julTypeSymbol]: 'float' };
export const NonZeroFloat = /*#__PURE__*/ And(Float, /*#__PURE__*/ Not(0));
export const Integer: IntegerType = { [_julTypeSymbol]: 'integer' };
export const NonZeroInteger = /*#__PURE__*/ And(Integer, /*#__PURE__*/ Not(0n));
export const Greater = /*#__PURE__*/ _createFunction(
	function Greater(Value: bigint | number): GreaterType {
		return {
			[_julTypeSymbol]: 'greater',
			Value: Value,
		};
	},
	{
		singleNames: [
			{
				name: 'value',
				type: /*#__PURE__*/ Or(Integer, Float),
			},
		]
	}
);
export const PositiveInteger = /*#__PURE__*/ And(Integer, /*#__PURE__*/ Greater(0n));
export const ElementAt = /*#__PURE__*/ _createFunction(
	function ElementAt(Source: any, index: bigint): RuntimeType {
		const position = Number(index);
		if (Source !== null
			&& typeof Source === 'object'
			&& _julTypeSymbol in Source) {
			switch (Source[_julTypeSymbol]) {
				case 'tuple':
					return Source.ElementTypes[position - 1] ?? Empty;
				case 'list':
					return Or(Empty, Source.ElementType);
				default:
					break;
			}
		}
		return Any;
	},
	{
		singleNames: [
			{
				name: 'Source',
				type: Type,
			},
			{
				name: 'Index',
				type: Integer,
			},
		]
	}
);
export const LengthOf = /*#__PURE__*/ _createFunction(
	function LengthOf(Source: any): RuntimeType {
		if (Source !== null
			&& typeof Source === 'object'
			&& _julTypeSymbol in Source) {
			switch (Source[_julTypeSymbol]) {
				case 'empty':
					return 0n;
				case 'tuple':
					return BigInt(Source.ElementTypes.length);
				case 'list':
					return PositiveInteger;
				default:
					break;
			}
		}
		return Integer;
	},
	{
		singleNames: [
			{
				name: 'Source',
				type: Type,
			},
		]
	}
);
export const WithElementAt = /*#__PURE__*/ _createFunction(
	function WithElementAt(Source: any, index: bigint, Value: RuntimeType): RuntimeType {
		const position = Number(index);
		if (Source !== null
			&& typeof Source === 'object'
			&& _julTypeSymbol in Source) {
			switch (Source[_julTypeSymbol]) {
				case 'tuple': {
					const elementTypes = [...Source.ElementTypes];
					elementTypes[position - 1] = Value;
					return {
						[_julTypeSymbol]: 'tuple',
						ElementTypes: elementTypes,
					};
				}
				case 'list':
					return List(Or(Source.ElementType, Value));
				default:
					break;
			}
		}
		return Any;
	},
	{
		singleNames: [
			{
				name: 'Source',
				type: Type,
			},
			{
				name: 'index',
				type: Integer,
			},
			{
				name: 'Value',
				type: Type,
			},
		]
	}
);
export const Range = /*#__PURE__*/ _createFunction(
	function Range(start: bigint, end: bigint | undefined): RuntimeType {
		return {
			[_julTypeSymbol]: 'range',
			Start: start,
			End: end,
		} as any;
	},
	{
		singleNames: [
			{
				name: 'start',
				type: Integer,
			},
			{
				name: 'end',
				type: /*#__PURE__*/ Or(Empty, Integer),
			},
		]
	}
);
export const TupleOf = /*#__PURE__*/ _createFunction(
	function TupleOf(count: bigint, ElementType: RuntimeType): RuntimeType {
		const length = Number(count);
		if (length < 1) {
			return Empty;
		}
		return {
			[_julTypeSymbol]: 'tuple',
			ElementTypes: new Array(length).fill(ElementType),
		};
	},
	{
		singleNames: [
			{
				name: 'count',
				type: Integer,
			},
			{
				name: 'ElementType',
				type: Type,
			},
		]
	}
);
export const Concat = /*#__PURE__*/ _createFunction(
	function Concat(...sources: any[]): RuntimeType {
		// Diese Funktion wird zur Laufzeit nie aufgerufen — Concat ist eine
		// rein semantische Typ-Konstruktorfunktion für den Checker.
		// Sie ist nur hier definiert, um eine gültige nativeFunction zu haben.
		throw new Error('Concat() is only for type-level computation and should never be called at runtime');
	},
	{
		rest: { type: Type },
	}
);
export const Add = /*#__PURE__*/ _createFunction(
	function Add(ArgsType: RuntimeType): RuntimeType {
		// Wie Concat nur für den Checker: der Rückgabetyp von add.
		throw new Error('Add() is only for type-level computation and should never be called at runtime');
	},
	{
		singleNames: [
			{
				name: 'ArgsType',
				type: Type,
			},
		]
	}
);
export const Fraction: DictionaryLiteralType = {
	[_julTypeSymbol]: 'dictionaryLiteral',
	Fields: {
		numerator: Integer,
		denominator: Integer
	},
};
export const Rational = /*#__PURE__*/ Or(Integer, Fraction);
//#endregion Number
export const _Text: TextType = { [_julTypeSymbol]: 'text' };
export const _Date: DateType = { [_julTypeSymbol]: 'date' };
export const _Blob: BlobType = { [_julTypeSymbol]: 'blob' };
export const _Error: ErrorType = { [_julTypeSymbol]: 'error' };
export const Dictionary = /*#__PURE__*/ _createFunction(
	function Dictionary(ElementType: RuntimeType): DictionaryType {
		return {
			[_julTypeSymbol]: 'dictionary',
			ElementType: ElementType,
		};
	},
	{
		singleNames: [
			{
				name: 'ElementType',
				type: Type,
			},
		]
	}
);
export const Stream = /*#__PURE__*/ _createFunction(
	function Stream(ValueType: RuntimeType) {
		return _StreamType;
	},
	{
		singleNames: [
			{
				name: 'ValueType',
				type: Type,
			},
		]
	}
);
//#endregion Types
//#region Functions
//#region Any
export const equal = /*#__PURE__*/ _createFunction(
	function equal(first: any, second: any) {
		return first === second;
	},
	{
		singleNames: [
			{
				name: 'first',
			},
			{
				name: 'second',
			}
		]
	}
);
export const deepEqual = /*#__PURE__*/ _createFunction(
	isDeepEqual,
	{
		singleNames: [
			{
				name: 'first',
			},
			{
				name: 'second',
			}
		]
	}
);
//#endregion Any
//#region Boolean
export const not = /*#__PURE__*/ _createFunction(
	function not(value: boolean): boolean {
		return !value;
	},
	{
		singleNames: [
			{
				name: 'value',
				type: _Boolean
			},
		]
	}
);
export const and = /*#__PURE__*/ _createFunction(
	function and(...args: boolean[]): boolean {
		return !args.includes(false);
	},
	{
		rest: {
			type: /*#__PURE__*/ List(_Boolean)
		}
	}
);
export const or = /*#__PURE__*/ _createFunction(
	function or(...args: boolean[]): boolean {
		return args.includes(true);
	},
	{
		rest: {
			type: /*#__PURE__*/ List(_Boolean)
		}
	}
);
//#endregion Boolean
//#region Number
export const divideFloat = /*#__PURE__*/ _createFunction(
	function divideFloat(dividend: number, divisor: number) {
		return dividend / divisor;
	},
	{
		singleNames: [
			{
				name: 'dividend',
				type: Float,
			},
			{
				name: 'divisor',
				type: NonZeroFloat,
			}
		]
	}
);
// TODO support Rational values
export const greater = /*#__PURE__*/ _createFunction(
	function greater(first: number | bigint, second: number | bigint) {
		return first > second;
	},
	{
		singleNames: [
			{
				name: 'first',
				type: /*#__PURE__*/ Or(Integer, Float),
			},
			{
				name: 'second',
				type: /*#__PURE__*/ Or(Integer, Float),
			}
		]
	}
);
export const maxInteger = /*#__PURE__*/ _createFunction(
	function maxInteger(...args: bigint[]): bigint {
		let max = args[0]!;
		for (let index = 1; index < args.length; index++) {
			const element = args[index]!;
			if (element > max) {
				max = element;
			}
		}
		return max;
	},
	{
		rest: {
			type: /*#__PURE__*/ List(Integer)
		}
	}
);
export const maxFloat = /*#__PURE__*/ _createFunction(
	function maxFloat(...args: number[]) {
		return Math.max(...args);
	},
	{
		rest: {
			type: /*#__PURE__*/ List(Float)
		}
	}
);
// TODO moduloFloat
export const modulo = /*#__PURE__*/ _createFunction(
	function modulo(dividend: bigint, divisor: bigint) {
		return dividend % divisor;
	},
	{
		singleNames: [
			{
				name: 'dividend',
				type: Integer,
			},
			{
				name: 'divisor',
				type: NonZeroInteger,
			}
		]
	}
);
function gcdBigInt(a: bigint, b: bigint): bigint {
	while (b) {
		[a, b] = [b, a % b];
	}
	return a;
}

/**
 * Bringt einen Bruch auf die kleinste Darstellung (Vorzeichen im Zaehler, mit ggT gekuerzt).
 * Nenner 1 wird zum Integer, denn Rational = Or(Integer Fraction) sieht keine eigene
 * Darstellung fuer ganzzahlige Brueche vor.
 */
export function normalizeRational(numerator: bigint, denominator: bigint): RuntimeRational {
	const sign = denominator < 0n ? -1n : 1n;
	const signedNumerator = numerator * sign;
	const signedDenominator = denominator * sign;
	const divisor = gcdBigInt(signedNumerator < 0n ? -signedNumerator : signedNumerator, signedDenominator);
	const reducedNumerator = divisor ? signedNumerator / divisor : signedNumerator;
	const reducedDenominator = divisor ? signedDenominator / divisor : signedDenominator;
	return reducedDenominator === 1n
		? reducedNumerator
		: {
			numerator: reducedNumerator,
			denominator: reducedDenominator,
		};
}

export const multiply = /*#__PURE__*/ _createFunction(
	function multiply(...args: RuntimeRational[]) {
		return args.reduce(
			(accumulator, current) => {
				if (typeof accumulator === 'bigint') {
					if (typeof current === 'bigint') {
						return accumulator * current;
					}
					else {
						return normalizeRational(accumulator * current.numerator, current.denominator);
					}
				}
				else {
					if (typeof current === 'bigint') {
						return normalizeRational(accumulator.numerator * current, accumulator.denominator);
					}
					else {
						return normalizeRational(
							accumulator.numerator * current.numerator,
							accumulator.denominator * current.denominator);
					}
				}
			},
			1n);
	},
	{
		rest: {
			type: /*#__PURE__*/ List(Rational)
		}
	}
);
export const multiplyFloat = /*#__PURE__*/ _createFunction(
	function multiplyFloat(...args: number[]) {
		return args.reduce(
			(accumulator, current) => {
				return accumulator * current;
			},
			1);
	},
	{
		rest: {
			type: /*#__PURE__*/ List(Float)
		}
	}
);
export const rationalToFloat = /*#__PURE__*/ _createFunction(
	function rationalToFloat(rational: RuntimeRational): number {
		if (typeof rational === 'bigint') {
			return Number(rational);
		}
		else {
			return Number(rational.numerator) / Number(rational.denominator);
		}
	},
	{
		singleNames: [
			{
				name: 'rational',
				type: Rational,
			},
		]
	}
);
export const subtract = /*#__PURE__*/ _createFunction(
	function subtract(minuend: RuntimeRational, subtrahend: RuntimeRational): RuntimeRational {
		if (typeof minuend === 'bigint') {
			if (typeof subtrahend === 'bigint') {
				return minuend - subtrahend;
			}
			else {
				return normalizeRational(minuend * subtrahend.denominator - subtrahend.numerator, subtrahend.denominator);
			}
		}
		else {
			if (typeof subtrahend === 'bigint') {
				return normalizeRational(minuend.numerator - subtrahend * minuend.denominator, minuend.denominator);
			}
			else {
				return normalizeRational(
					minuend.numerator * subtrahend.denominator - subtrahend.numerator * minuend.denominator,
					minuend.denominator * subtrahend.denominator);
			}
		}
	},
	{
		singleNames: [
			{
				name: 'minuend',
				type: Rational,
			},
			{
				name: 'subtrahend',
				type: Rational,
			}
		]
	}
);
export const subtractFloat = /*#__PURE__*/ _createFunction(
	function subtractFloat(minuend: number, subtrahend: number) {
		return minuend - subtrahend;
	},
	{
		singleNames: [
			{
				name: 'minuend',
				type: Float,
			},
			{
				name: 'subtrahend',
				type: Float,
			}
		]
	}
);
export const add = /*#__PURE__*/ _createFunction(
	function add(...args: RuntimeRational[]) {
		return args.reduce(
			(accumulator, current) => {
				if (typeof accumulator === 'bigint') {
					if (typeof current === 'bigint') {
						return accumulator + current;
					}
					else {
						return normalizeRational(accumulator * current.denominator + current.numerator, current.denominator);
					}
				}
				else {
					if (typeof current === 'bigint') {
						return normalizeRational(accumulator.numerator + current * accumulator.denominator, accumulator.denominator);
					}
					else {
						return normalizeRational(
							accumulator.numerator * current.denominator + current.numerator * accumulator.denominator,
							accumulator.denominator * current.denominator);
					}
				}
			},
			0n);
	},
	{
		rest: {
			type: /*#__PURE__*/ List(Rational)
		}
	}
);
export const addFloat = /*#__PURE__*/ _createFunction(
	function addFloat(...args: number[]): number {
		return args.reduce(
			(accumulator, current) =>
				accumulator + current,
			0);
	},
	{
		rest: {
			type: /*#__PURE__*/ List(Float)
		}
	}
);
//#endregion Number
//#region Text
export const combineTexts = /*#__PURE__*/ _createFunction(
	function combineTexts(texts: string[] | undefined, separator: string | undefined) {
		return texts?.join(separator ?? '') ?? '';
	},
	{
		singleNames: [
			{
				name: 'texts',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(_Text)),
			},
			{
				name: 'separator',
				type: /*#__PURE__*/ optionalType(_Text),
			},
		]
	}
);
export const parseFloat = /*#__PURE__*/ _createFunction(
	function parseFloat(textNumber: string) {
		const result = +textNumber;
		if (Number.isNaN(result)) {
			return new Error('Invalid number.');
		}
		return result;
	},
	{
		singleNames: [
			{
				name: 'textNumber',
				type: _Text,
			},
		]
	}
);
export const parseJson = /*#__PURE__*/ _createFunction(
	_parseJson,
	{
		singleNames: [
			{
				name: 'json',
				type: _Text,
			},
		]
	}
);
export const toJson = /*#__PURE__*/ _createFunction(
	_toJson,
	{
		singleNames: [
			{
				name: 'value',
				// TODO JsonValue
				type: Any,
			},
		]
	}
);
export const regex = /*#__PURE__*/ _createFunction(
	function regex(text: string, pattern: string) {
		try {
			const match = text.match(pattern);
			return {
				isMatch: !!match,
				unnamedCaptures: match ? Array.from(match) : undefined,
				namedCaptures: match?.groups,
			};
		}
		catch (error) {
			return error;
		}
	},
	{
		singleNames: [
			{
				name: 'text',
				type: _Text,
			},
			{
				name: 'pattern',
				type: _Text,
			},
		]
	}
);
//#endregion Text
//#region Date
export const addDate = /*#__PURE__*/ _createFunction(
	function addDate(
		date: Date,
		years: bigint | undefined,
		months: bigint | undefined,
		days: bigint | undefined,
		hours: bigint | undefined,
		minutes: bigint | undefined,
		seconds: bigint | undefined,
		milliseconds: bigint | undefined
	) {
		return new Date(
		date.getFullYear() + Number(years ?? 0),
		date.getMonth() + Number(months ?? 0),
		date.getDate() + Number(days ?? 0),
		date.getHours() + Number(hours ?? 0),
		date.getMinutes() + Number(minutes ?? 0),
		date.getSeconds() + Number(seconds ?? 0),
		date.getMilliseconds() + Number(milliseconds ?? 0),
	);
	},
	{
		singleNames: [
			{
				name: 'date',
				type: _Date
			},
			{
				name: 'years',
				type: /*#__PURE__*/ optionalType(Integer)
			},
			{
				name: 'months',
				type: /*#__PURE__*/ optionalType(Integer)
			},
			{
				name: 'days',
				type: /*#__PURE__*/ optionalType(Integer)
			},
			{
				name: 'hours',
				type: /*#__PURE__*/ optionalType(Integer)
			},
			{
				name: 'minutes',
				type: /*#__PURE__*/ optionalType(Integer)
			},
			{
				name: 'seconds',
				type: /*#__PURE__*/ optionalType(Integer)
			},
			{
				name: 'milliseconds',
				type: /*#__PURE__*/ optionalType(Integer)
			},
		]
	}
);
export const currentDate = /*#__PURE__*/ _createFunction(
	function currentDate() {
		return new Date();
	},
	{}
);
export const toIsoDateText = /*#__PURE__*/ _createFunction(
	function toIsoDateText(
		date: Date,
	) {
		return date.toISOString();
	},
	{
		singleNames: [
			{
				name: 'date',
				type: _Date
			},
		]
	}
);
//#endregion Date
//#region List
export const length = /*#__PURE__*/ _createFunction(
	function length(
		values: any[] | undefined,
	): bigint {
		if (!values) {
			return 0n;
		}
		return BigInt(values.length);
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
		]
	}
);
export const getElement = /*#__PURE__*/ _createFunction(
	function getElement<T>(
		values: T[] | undefined,
		index: bigint,
	): T | undefined {
		return values?.[Number(index) - 1];
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
			{
				name: 'index',
				type: PositiveInteger
			},
		]
	}
);
export const setElement = /*#__PURE__*/ _createFunction(
	function setElement<T>(
		values: T[] | undefined,
		index: bigint,
		value: T,
	): T[] {
		const copy = values
			? [...values]
			: [];
		copy[Number(index) - 1] = value;
		return copy;
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
			{
				name: 'index',
				type: PositiveInteger
			},
			{
				name: 'value',
			},
		]
	}
);
export const map = /*#__PURE__*/ _createFunction(
	function map<T, U>(
		values: T[] | undefined,
		callback: (value: T, index: bigint) => U,
	): U[] | undefined {
		if (!values) {
			return;
		}
		const mappedValues = values.map((value, index) => {
			return callback(value, BigInt(index + 1));
		});
		return mappedValues.length
			? mappedValues
			: undefined;
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
			{
				name: 'callback',
				type: _Function
			},
		]
	}
);
export const filter = /*#__PURE__*/ _createFunction(
	function filter<T>(
		values: T[] | undefined,
		predicate: (value: T, index: bigint) => boolean,
	): T[] | undefined {
		if (!values) {
			return;
		}
		const filtered = values.filter((value, index) => {
			return predicate(value, BigInt(index + 1));
		});
		return filtered.length
			? filtered
			: undefined;
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
			{
				name: 'predicate',
				type: _Function
			},
		]
	}
);
export const filterMap = /*#__PURE__*/ _createFunction(
	function filterMap<T, U>(
		values: T[] | undefined,
		callback: (value: T, index: bigint) => U | undefined,
	): U[] | undefined {
		if (!values) {
			return;
		}
		const mappedValues: U[] = [];
		values.forEach((value, index) => {
			const mapped = callback(value, BigInt(index + 1));
			if (mapped !== undefined) {
				mappedValues.push(mapped);
			}
		});
		return mappedValues.length
			? mappedValues
			: undefined;
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
			{
				name: 'callback',
				type: _Function
			},
		]
	}
);
export const flatten = /*#__PURE__*/ _createFunction(
	function flatten<T>(
		values: (T[] | undefined)[] | undefined,
	): T[] | undefined {
		if (!values) {
			return;
		}
		const flattened = values.flatMap(value => value ?? []);
		return flattened.length
			? flattened
			: undefined;
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(/*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))))
			},
		]
	}
);
export const slice = /*#__PURE__*/ _createFunction(
	function slice<T>(
		values: T[] | undefined,
		start: bigint,
		end: bigint | undefined,
	): T[] | undefined {
		if (!values) {
			return;
		}
		const sliced = values.slice(
			Number(start) - 1,
			typeof end === 'bigint'
				? Number(end)
				: undefined
		);
		return sliced.length ? sliced : undefined;
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
			{
				name: 'start',
				type: Integer
			},
			{
				name: 'end',
				type: /*#__PURE__*/ optionalType(Integer)
			},
		]
	}
);
export const findFirst = /*#__PURE__*/ _createFunction(
	function findFirst<T>(
		values: T[] | undefined,
		predicate: (value: T, index: bigint) => boolean,
	): T | undefined {
		return values?.find((value, index) => {
			return predicate(value, BigInt(index + 1));
		});
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
			{
				name: 'predicate',
				type: _Function
			},
		]
	}
);
export const findLast = /*#__PURE__*/ _createFunction(
	function findLast<T>(
		values: T[] | undefined,
		predicate: (value: T, index: bigint) => boolean,
	): T | undefined {
		return values?.findLast((value, index) => {
			return predicate(value, BigInt(index + 1));
		});
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
			{
				name: 'predicate',
				type: _Function
			},
		]
	}
);
export const findLastIndex = /*#__PURE__*/ _createFunction(
	function findLastIndex<T>(
		values: T[] | undefined,
		predicate: (value: T, index: bigint) => boolean,
	): bigint | undefined {
		if (!values) {
			return;
		}
		const lastIndexFloat = values.findLastIndex((value, index) => {
			return predicate(value, BigInt(index + 1));
		});
		return lastIndexFloat === -1
			? undefined
			: BigInt(lastIndexFloat + 1);
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
			{
				name: 'predicate',
				type: _Function
			},
		]
	}
);
export const lastElement = /*#__PURE__*/ _createFunction(
	function lastElement<T>(values: T[] | undefined): T | undefined {
		return values?.[values.length - 1];
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
		]
	}
);
export const forEach = /*#__PURE__*/ _createFunction(
	function forEach<T>(
		values: T[] | undefined,
		callback: (value: T, index: bigint) => void,
	) {
		values?.forEach((value, index) => {
			return callback(value, BigInt(index + 1));
		});
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
			{
				name: 'callback',
				type: _Function
			},
		]
	}
);
export const exists = /*#__PURE__*/ _createFunction(
	function exists<T>(
		values: T[] | undefined,
		predicate: (value: T, index: bigint) => boolean,
	): boolean {
		if (!values) {
			return false;
		}
		return values.some((value, index) => {
			return predicate(value, BigInt(index + 1));
		});
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
			{
				name: 'predicate',
				type: _Function
			},
		]
	}
);

export const all = /*#__PURE__*/ _createFunction(
	function all<T>(
		values: T[] | undefined,
		predicate: (value: T, index: bigint) => boolean,
	): boolean {
		if (!values) {
			return true;
		}
		return values.every((value, index) => {
			return predicate(value, BigInt(index + 1));
		});
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
			{
				name: 'predicate',
				type: _Function
			},
		]
	}
);
export const toDictionary = /*#__PURE__*/ _createFunction(
	function toDictionary(
		values: any[] | undefined,
		getKey: (value: any, index: bigint) => string,
		getValue: (value: any, index: bigint) => any,
	): RuntimeDictionary | undefined {
		if (!values) {
			return;
		}
		const dictionary: RuntimeDictionary = {};
		let indexBigint = 1n;
		for (let index = 0; index < values.length; index++) {
			const oldValue = values[index];
			const key = getKey(oldValue, indexBigint);
			const newValue = getValue(oldValue, indexBigint);
			dictionary[key] = newValue;
			indexBigint++;
		}
		return dictionary;
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
			{
				name: 'getKey',
				type: _Function
			},
			{
				name: 'getValue',
				type: _Function
			},
		]
	}
);
export const aggregate = /*#__PURE__*/ _createFunction(
	function aggregate<T, U>(
		values: T[] | undefined,
		initialValue: U,
		callback: (accumulator: U, value: T, index: bigint) => U,
	): U {
		if (!values) {
			return initialValue;
		}
		return values.reduce(
			(accumulator, value, index) => {
				return callback(accumulator, value, BigInt(index + 1));
			},
			initialValue);
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(Any))
			},
			{
				name: 'initialValue',
			},
			{
				name: 'callback',
				type: _Function
			},
		]
	}
);
//#endregion List
//#region Dictionary
export const getField = /*#__PURE__*/ _createFunction(
	function getField<T>(
		dictionary: { [key: string]: T; } | undefined,
		key: string,
	): T | undefined {
		return dictionary?.[key];
	},
	{
		singleNames: [
			{
				name: 'dictionary',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ Dictionary(Any))
			},
			{
				name: 'key',
				type: _Text
			},
		]
	}
);
export const setField = /*#__PURE__*/ _createFunction(
	function setField<T>(
		dictionary: { [key: string]: T; } | undefined,
		key: string,
		value: T,
	): { [key: string]: T; } {
		return {
			...dictionary,
			[key]: value,
		};
	},
	{
		singleNames: [
			{
				name: 'dictionary',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ Dictionary(Any))
			},
			{
				name: 'key',
				type: _Text
			},
			{
				name: 'value',
			},
		]
	}
);
export const toList = /*#__PURE__*/ _createFunction(
	function toList<T>(
		dictionary: { [key: string]: T; } | undefined,
	): T[] | undefined {
		if (!dictionary) {
			return;
		}
		return Object.values(dictionary);
	},
	{
		singleNames: [
			{
				name: 'values',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ Dictionary(Any))
			},
		]
	}
);
//#endregion Dictionary
//#region Stream
//#region helper
type Listener<T> = (value: T) => void;

class StreamClass<T> {
	constructor(
		/**
		 * Aktualisiert diesen Stream und alle Dependencies und benachrichtigt Subscriber.
		 */
		public readonly getValue: () => T,
	) {
		this.getValue = getValue;
	}

	/**
	 * Bei Quell-Streams (z.B. mit timer$ oder create$) wird immer sofort ein Startwert mit push eingetragen.
	 * 
	 * Falls abgeleiteter Stream (createDerived$, map$, combine$, etc):
	 * lastValue wird lazy gesetzt.
	 * Wenn getValue noch nicht aufgerufen wurde, dann ist lastValue noch null.
	 */
	lastValue: T | null = null;
	lastProcessId?: number;
	completed: boolean = false;
	listeners: Listener<T>[] = [];
	onCompletedListeners: (() => void)[] = [];

	push(value: T, processId: number): void {
		if (processId === this.lastProcessId) {
			return;
		}
		if (isDeepEqual(value, this.lastValue)) {
			return;
		}
		if (this.completed) {
			throw new Error('Can not push to completed stream.');
		}
		this.lastValue = value;
		this.lastProcessId = processId;
		// Über eine Kopie, denn ein Listener kann sich währenddessen abmelden: das splice in
		// unsubscribe würde sonst den nächsten Listener überspringen lassen.
		[...this.listeners].forEach(listener => listener(value));
	}
	/**
	 * Gibt einen unsubscribe callback zurück.
	 * Wertet den listener beim subscriben sofort aus, wenn evaluateOnSubscribe = true.
	 */
	subscribe(listener: Listener<T>, evaluateOnSubscribe: boolean = true): () => void {
		if (evaluateOnSubscribe) {
			listener(this.getValue());
		}
		if (this.completed) {
			return () => { };
		}
		this.listeners.push(listener);
		return () => {
			if (this.completed) {
				return;
			}
			const index = this.listeners.indexOf(listener);
			if (index === -1) {
				throw new Error('Can not unsubscribe listener, because listener was not subscribed.');
			}
			this.listeners.splice(index, 1);
		};
	}
	complete(): void {
		if (this.completed) {
			return;
		}
		this.completed = true;
		// dispose listeners
		this.listeners = [];
		this.onCompletedListeners.forEach(onCompletedListener => {
			onCompletedListener();
		});
		this.onCompletedListeners = [];
	}
	/**
	 * Wenn der Stream schon completed ist wird der callback sofort aufgerufen.
	 */
	onCompleted(callback: () => void): void {
		if (this.completed) {
			callback();
		}
		else {
			this.onCompletedListeners.push(callback);
		}
	}
}
/**
 * Für die Ausgabe von Werten in test-runtime.ts.
 */
export { StreamClass as _StreamClass };

//#region create

function _create$<T>(initialValue: T): StreamClass<T> {
	const stream$: StreamClass<T> = new StreamClass(
		() =>
			stream$.lastValue as T,
	);
	stream$.push(initialValue, processId);
	return stream$;
}

function _completed$<T>(value: T): StreamClass<T> {
	const $ = _create$(value);
	$.complete();
	return $;
}

type HttpResponseType =
	| 'blob'
	| 'text'
	;

/**
 * Der Timeout gilt für die ganze Anfrage einschließlich des Lesens der Antwort. Er ist Pflicht,
 * damit der Stream sicher endet, auch wenn der Server nie antwortet.
 */
function httpRequest$(
	url: string,
	method: string,
	timeoutMs: number,
	headers: { [key: string]: string; } | undefined,
	body: any,
	responseType: HttpResponseType,
): StreamClass<undefined | string | Blob | Error> {
	const abortController = new AbortController();
	const response$ = _create$<undefined | string | Blob | Error>(undefined);
	const timeoutId = setTimeout(() => {
		abortController.abort(new Error(`Timeout after ${timeoutMs} ms`));
	}, timeoutMs);
	response$.onCompleted(() => {
		clearTimeout(timeoutId);
		abortController.abort();
	});
	fetch(url, {
		method: method,
		headers: headers ?? undefined,
		body: body,
		signal: abortController.signal,
	}).then<string | Blob>(response => {
		if (response.ok) {
			switch (responseType) {
				case 'text':
					return response.text();
				case 'blob':
					return response.blob();
				default: {
					const assertNever: never = responseType;
					throw new Error(`Unexpected HttpResponseType ${assertNever}`);
				}
			}
		}
		else {
			// TODO improve error handling: return error response body (text)
			// return response.text();
			throw new Error(response.statusText);
		}
	}).then(responseText => {
		processId++;
		response$.push(responseText, processId);
	}).catch(error => {
		processId++;
		response$.push(error, processId);
	}).finally(() => {
		response$.complete();
	});
	return response$;
}

//#endregion create

//#region transform

function createDerived$<T>(getValue: () => T): StreamClass<T> {
	const derived$: StreamClass<T> = new StreamClass(
		() => {
			if (processId === derived$.lastProcessId
				|| derived$.completed) {
				return derived$.lastValue!;
			}
			return getValue();
		},
	);
	return derived$;
}

function _map$<TSource, TTarget>(
	source$: StreamClass<TSource>,
	mapFunction: (value: TSource) => TTarget,
): StreamClass<TTarget> {
	let lastSourceValue: TSource | null = null;
	const mapped$: StreamClass<TTarget> = createDerived$(
		() => {
			const currentSourceValue = source$.getValue();
			if (isDeepEqual(currentSourceValue, lastSourceValue)) {
				mapped$.lastProcessId = processId;
				return mapped$.lastValue!;
			}
			const currentMappedValue = mapFunction(currentSourceValue);
			lastSourceValue = currentSourceValue;
			mapped$.push(currentMappedValue, processId);
			return currentMappedValue;
		},
	);
	const unsubscribe = source$.subscribe(sourceValue => {
		mapped$.getValue();
	});
	mapped$.onCompleted(() => {
		unsubscribe();
	});
	source$.onCompleted(() => {
		mapped$.complete();
	});
	return mapped$;
}

function _combine$<T>(
	...source$s: StreamClass<T>[]
): StreamClass<T[]> {
	const combined$: StreamClass<T[]> = createDerived$(
		() => {
			const lastValues = combined$.lastValue!;
			const currentValues = source$s.map(source$ =>
				source$.getValue());
			if (isDeepEqual(currentValues, lastValues)) {
				combined$.lastProcessId = processId;
				return lastValues;
			}
			combined$.push(currentValues, processId);
			return currentValues;
		},
	);
	const unsubscribes = source$s.map((source$, index) => {
		source$.onCompleted(() => {
			// combined ist complete, wenn alle Sources complete sind.
			if (source$s.every(source$ => source$.completed)) {
				combined$.complete();
			}
		});
		return source$.subscribe(value => {
			combined$.getValue();
		});
	});
	combined$.onCompleted(() => {
		unsubscribes.forEach((unsubscribe, index) => {
			unsubscribe();
		});
	});
	return combined$;
}

function _take$<T>(source$: StreamClass<T>, count: bigint): StreamClass<T> {
	let counter = 0n;
	const mapped$ = _create$<T>(source$.lastValue!);
	const unsubscribe = source$.subscribe(
		(value) => {
			mapped$.push(value, processId);
			counter++;
			if (counter === count) {
				unsubscribe();
				mapped$.complete();
			}
		},
		false);
	source$.onCompleted(() => {
		mapped$.complete();
	});
	return mapped$;
}

function _takeUntil$<T>(source$: StreamClass<T>, notifier$: StreamClass<any>): StreamClass<T> {
	const mapped$ = _map$(source$, x => x);
	const unsubscribeNotifier = notifier$.subscribe(
		() => {
			mapped$.complete();
		},
		false);
	notifier$.onCompleted(() => {
		mapped$.complete();
	});
	mapped$.onCompleted(() => {
		unsubscribeNotifier();
	});
	return mapped$;
}

function flatMerge$<T>(source$$: StreamClass<StreamClass<T>>): StreamClass<T> {
	const inner$s: StreamClass<T>[] = [];
	const unsubscribeInners: (() => void)[] = [];
	const flat$: StreamClass<T> = createDerived$(
		() => {
			const lastValue = flat$.lastValue!;
			const currentValue = source$$.getValue().getValue();
			if (isDeepEqual(currentValue, lastValue)) {
				flat$.lastProcessId = processId;
				return lastValue;
			}
			flat$.push(currentValue, processId);
			return currentValue;
		},
	);
	const unsubscribeOuter = source$$.subscribe(source$ => {
		inner$s.push(source$);
		const unsubscribeInner = source$.subscribe(value => {
			flat$.getValue();
		});
		unsubscribeInners.push(unsubscribeInner);
	});
	flat$.onCompleted(() => {
		unsubscribeOuter();
		unsubscribeInners.forEach(unsubscribeInner => {
			unsubscribeInner();
		});
	});
	// flat ist complete, wenn outerSource und alle innerSources complete sind
	source$$.onCompleted(() => {
		inner$s.forEach(inner$ => {
			inner$.onCompleted(() => {
				if (inner$s.every(source$ => source$.completed)) {
					flat$.complete();
				}
			});
		});
	});
	return flat$;
}

function flatSwitch$<T>(source$$: StreamClass<StreamClass<T>>): StreamClass<T> {
	let unsubscribeInner: () => void;
	const flat$: StreamClass<T> = createDerived$(
		() => {
			const lastValue = flat$.lastValue!;
			const currentValue = source$$.getValue().getValue();
			if (isDeepEqual(currentValue, lastValue)) {
				flat$.lastProcessId = processId;
				return lastValue;
			}
			flat$.push(currentValue, processId);
			return currentValue;
		},
	);
	const unsubscribeOuter = source$$.subscribe(source$ => {
		unsubscribeInner?.();
		unsubscribeInner = source$.subscribe(value => {
			flat$.getValue();
		});
	});
	flat$.onCompleted(() => {
		unsubscribeOuter();
		unsubscribeInner?.();
	});
	// flat ist complete, wenn outerSource und die aktuelle innerSource complete sind
	source$$.onCompleted(() => {
		source$$.getValue().onCompleted(() => {
			flat$.complete();
		});
	});
	return flat$;
}

function flatMap$<T, U>(
	source$: StreamClass<T>,
	transform$: (value: T) => StreamClass<U>,
	merge: boolean,
): StreamClass<U> {
	const mapped$ = _map$(
		source$,
		transform$,
	);
	if (merge) {
		return flatMerge$(mapped$);
	}
	else {
		return flatSwitch$(mapped$);
	}
}

// TODO testen
function accumulate$<TSource, TAccumulated>(
	source$: StreamClass<TSource>,
	initialAccumulator: TAccumulated,
	accumulate: (previousAccumulator: TAccumulated, value: TSource) => TAccumulated,
): StreamClass<TAccumulated> {
	const mapped$ = _map$(
		source$,
		value => {
			const newAccumulator = accumulate(
				mapped$.lastValue === null
					? initialAccumulator
					: mapped$.lastValue,
				value);
			return newAccumulator;
		},
	);
	return mapped$;
}

function retry$<T>(
	method$: () => StreamClass<T | Error>,
	maxAttempts: number,
	currentAttempt: number = 1,
): StreamClass<T | Error> {
	if (currentAttempt === maxAttempts) {
		return method$();
	}
	const withRetry$$ = _map$(
		method$(),
		result => {
			if (result instanceof Error) {
				console.log('Error! Retrying... Attempt:', currentAttempt, 'process:', processId);
				return retry$(method$, maxAttempts, currentAttempt + 1);
			}
			return _completed$<T | Error>(result);
		},
	);
	return flatSwitch$(withRetry$$);
};

//#endregion transform
//#endregion helper
//#region core
export const complete = /*#__PURE__*/ _createFunction(
	function complete(stream$: StreamClass<any>): undefined {
		stream$.complete();
	},
	{
		singleNames: [
			{
				name: 'stream$',
				type: _StreamType
			},
		]
	}
);
export const push = /*#__PURE__*/ _createFunction(
	function push(stream$: StreamClass<any>, value: any) {
		processId++;
		stream$.push(value, processId);
	},
	{
		singleNames: [
			{
				name: 'stream$',
				type: _StreamType
			},
			{
				name: 'value',
			},
		]
	}
);
export const subscribe = /*#__PURE__*/ _createFunction(
	function subscribe<T>(stream$: StreamClass<T>, listener: Listener<T>) {
		return stream$.subscribe(listener);
	},
	{
		singleNames: [
			{
				name: 'stream$',
				type: _StreamType
			},
			{
				name: 'listener',
				type: _Function
			},
		]
	}
);
//#endregion core
//#region create
export const create$ = /*#__PURE__*/ _createFunction(
	function create$(ValueType: any, initialValue: any) {
		return _create$(initialValue);
	},
	{
		singleNames: [
			{
				name: 'ValueType',
				type: Type
			},
			{
				name: 'initialValue',
			},
		]
	}
);
export const completed$ = /*#__PURE__*/ _createFunction(
	_completed$,
	{
		singleNames: [
			{
				name: 'initialValue',
			},
		]
	}
);
export const httpTextRequest$ = /*#__PURE__*/ _createFunction(
	function httpTextRequest$(
		url: string,
		method: string,
		timeoutMs: number,
		headers: { [key: string]: string; } | undefined,
		body: any,
	) {
		return httpRequest$(url, method, timeoutMs, headers, body, 'text');
	},
	{
		singleNames: [
			{
				name: 'url',
				type: _Text
			},
			{
				name: 'method',
				type: _Text
			},
			{
				name: 'timeoutMs',
				type: Float
			},
			{
				name: 'headers',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ Dictionary(_Text))
			},
			{
				name: 'body',
			},
		]
	}
);
export const httpBlobRequest$ = /*#__PURE__*/ _createFunction(
	function httpBlobRequest$(
		url: string,
		method: string,
		timeoutMs: number,
		headers: { [key: string]: string; } | undefined,
		body: any,
	) {
		return httpRequest$(url, method, timeoutMs, headers, body, 'blob');
	},
	{
		singleNames: [
			{
				name: 'url',
				type: _Text
			},
			{
				name: 'method',
				type: _Text
			},
			{
				name: 'timeoutMs',
				type: Float
			},
			{
				name: 'headers',
				type: /*#__PURE__*/ optionalType(/*#__PURE__*/ Dictionary(_Text))
			},
			{
				name: 'body',
			},
		]
	}
);
export const timer$ = /*#__PURE__*/ _createFunction(
	function timer$(delayMs: number): StreamClass<number> {
		const stream$ = _create$(1);
		const cycle = () => {
			setTimeout(() => {
				if (stream$.completed) {
					return;
				}
				processId++;
				stream$.push(stream$.lastValue! + 1, processId);
				cycle();
			}, delayMs);
		};
		cycle();
		return stream$;
	},
	{
		singleNames: [{
			name: 'delayMs',
			type: Float
		}]
	}
);
//#endregion create
//#region transform
export const map$ = /*#__PURE__*/ _createFunction(
	function map$<T, U>(source$: StreamClass<T>, transform$: (value: T) => U) {
		return _map$(source$, transform$);
	},
	{
		singleNames: [
			{
				name: 'source$',
				type: _StreamType
			},
			{
				name: 'transform$',
				type: _Function
			}
		]
	}
);
export const flatMergeMap$ = /*#__PURE__*/ _createFunction(
	function flatMergeMap$<T, U>(source$: StreamClass<T>, transform$: (value: T) => StreamClass<U>) {
		return flatMap$(source$, transform$, true);
	},
	{
		singleNames: [
			{
				name: 'source$',
				type: _StreamType
			},
			{
				name: 'transform$',
				type: _Function
			}
		]
	}
);
export const flatSwitchMap$ = /*#__PURE__*/ _createFunction(
	function flatSwitchMap$<T, U>(source$: StreamClass<T>, transform$: (value: T) => StreamClass<U>) {
		return flatMap$(source$, transform$, false);
	},
	{
		singleNames: [
			{
				name: 'source$',
				type: _StreamType
			},
			{
				name: 'transform$',
				type: _Function
			}
		]
	}
);
export const combine$ = /*#__PURE__*/ _createFunction(
	_combine$,
	{
		rest: {
			type: /*#__PURE__*/ optionalType(/*#__PURE__*/ List(_StreamType))
		}
	}
);
export const take$ = /*#__PURE__*/ _createFunction(
	_take$,
	{
		singleNames: [
			{
				name: 'source$',
				type: _StreamType
			},
			{
				name: 'count',
				type: NonZeroInteger
			}
		]
	}
);
export const takeUntil$ = /*#__PURE__*/ _createFunction(
	_takeUntil$,
	{
		singleNames: [
			{
				name: 'source$',
				type: _StreamType
			},
			{
				name: 'notifier$',
				type: _StreamType
			}
		]
	}
);
//#endregion transform
//#endregion Stream
//#region Utility
export const log = /*#__PURE__*/ _createFunction(
	function log(...args: any[]) {
		console.log(...args);
	},
	{
		rest: {}
	}
);
export const repeat = /*#__PURE__*/ _createFunction(
	function repeat(
		count: bigint,
		iteratee: (index: bigint) => void,
	) {
		for (let index = 1n; index <= count; index++) {
			iteratee(index);
		}
	},
	{
		singleNames: [
			{
				name: 'count',
				type: Integer
			},
			{
				name: 'iteratee',
				type: _Function
			},
		]
	}
);
export const runJs = /*#__PURE__*/ _createFunction(
	// Indirektes eval, läuft im globalen Scope. Eine eigene Funktion statt eval selbst, sonst hinge
	// _createFunction die params an das globale eval. Über globalThis statt als Bezeichner: Ein
	// Bezeichner eval könnte ein direktes eval sein, ein Minimizer ließe dann im ganzen Bundle jede
	// unbenutzte Definition stehen.
	function runJs(js: string) {
		return globalThis.eval(js);
	},
	{
		singleNames: [{
			name: 'js',
			type: _Text
		}]
	}
);
// TODO dynamische imports erlauben??
// export const _import = _createFunction(require, {
// 	singleNames: [{
// 		name: 'path',
// 		type: (x) => typeof x === 'string'
// 	}]
// });
//#endregion Utility
//#endregion Functions
//#endregion builtins