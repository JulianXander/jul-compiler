import { CheckResult, getCalledParameterNames, getTypeInfo } from '../checker/check-result.js';
import {
	Name,
	ParseBranching,
	ParseDictionaryLiteral,
	ParseExpression,
	ParseFunctionCall,
	ParseFunctionLiteral,
	ParseListValue,
	ParseParameterFields,
	ParseTextLiteral,
	ParseValueExpression,
	ParseReference,
	PositionedExpression,
	SimpleExpression,
	builtinInteger,
	CompileTimeType,
	discardName,
	forEachChild,
} from '../syntax-tree.js';
import { Positioned } from '../compiler-errors.js';
import * as runtime from '../runtime/runtime.js';
import type { JsonValue } from '../runtime/runtime.js';
import * as testRuntime from '../runtime/test-runtime.js';
import { Extension, NonEmptyArray, changeExtension, escapeReservedJsVariableName, isDefined, isTestFilePath, last } from '../util.js';
import { extname, isAbsolute } from 'path';
import { getPathExpression, getPathFromImport as getImportedPath, isImportFunction, isImportFunctionCall, isNamedFunction } from '../parser/parser.js';
import { getCheckedEscapableName, getJunction, getTestCallArguments, julHasDefaultExport } from '../parser/parser-utils.js';
import { BranchDispatch, BranchTest, getAssumeTest, getBranchDispatch, JsKind, LiteralValue } from '../checker/branch-dispatch.js';
import { hasArgumentSubstitution, isFunctionType, isParametersType, isSubtypeOf, resolveAlias, resolvePlaceholders, typeToString, valueOf } from '../checker/type-algebra.js';
import { classifyCopySource, copyingBuiltinNames } from './copy-sites.js';

const runtimeKeys = Object.keys(runtime);
const testRuntimeKeys = Object.keys(testRuntime);
/**
 * Nur beim Emittieren einer ganzen Datei nach dem Check: dann liegt die typeInfo vollständig am
 * Baum. functionLiteralToEvaluableJs läuft dagegen mitten im Checklauf (constant folding) und
 * emittiert weiter ohne Typen.
 */
let useTypeInfo = false;
/**
 * Quellpfad der gerade emittierten Datei, für die Stelle eines test-Aufrufs.
 */
let sourceFilePath = '';
/**
 * Der äußerste Aufruf im Rumpf des Test-Callbacks, der gerade emittiert wird. Er läuft über
 * _testCall, damit ein Fehlschlag seine ausgewerteten Argumente nennen kann.
 */
let instrumentedTestCall: ParseExpression | undefined;
/**
 * Nur beim Emittieren einer ganzen Datei: dann schreibt der Emitter an jeden Statement-Anfang einen
 * Marker mit der Quellposition, aus dem extractSourceMappings die Source Map gewinnt.
 * functionLiteralToEvaluableJs emittiert ohne Marker.
 */
let emitSourcePositions = false;
/**
 * Nur unter jul test: Jedes assume prüft seine Behauptung, soweit der statische Typ sie offen lässt
 * (siehe assumeCallToJs).
 */
let checkAssumes = false;
/**
 * Siehe EmitOptions.hasDefaultExport.
 */
let hasDefaultExport: EmitOptions['hasDefaultExport'];
/**
 * Messinstrument, siehe countCopyJs.
 */
const countCopies = typeof process !== 'undefined'
	&& process.env['JUL_COUNT_COPIES'] === '1';
//#region source map

/**
 * Die Steuerzeichen kommen in gültigem JS nur in String- und Template-Literalen vor, und deren
 * Inhalt escapen escapeStringForBacktickJs/escapeStringForSingleQuoteJs. Ein Markerzeichen im
 * erzeugten JS stammt also immer von sourcePositionMarkerJs.
 */
const markerStart = '\u0001';
const markerEnd = '\u0002';

/**
 * Zuordnung einer Stelle im erzeugten JS zu einer Stelle im Quelltext, alles 0-basiert.
 */
export interface SourceMapping {
	generatedLine: number;
	generatedColumn: number;
	sourceLine: number;
	sourceColumn: number;
}

function sourcePositionMarkerJs(expression: Positioned): string {
	return emitSourcePositions
		? `${markerStart}${expression.startRowIndex}:${expression.startColumnIndex}${markerEnd}`
		: '';
}

/**
 * Entfernt die Marker und liefert dafür je Marker die Position, an der er im bereinigten JS stand.
 */
function extractSourceMappings(markedJs: string): { js: string; mappings: SourceMapping[]; } {
	const mappings: SourceMapping[] = [];
	const chunks: string[] = [];
	let jsLength = 0;
	let generatedLine = 0;
	let lineStartIndex = 0;
	let index = 0;
	while (true) {
		const startIndex = markedJs.indexOf(markerStart, index);
		const chunk = markedJs.slice(index, startIndex < 0 ? undefined : startIndex);
		let newlineIndex = chunk.indexOf('\n');
		while (newlineIndex >= 0) {
			generatedLine++;
			lineStartIndex = jsLength + newlineIndex + 1;
			newlineIndex = chunk.indexOf('\n', newlineIndex + 1);
		}
		chunks.push(chunk);
		jsLength += chunk.length;
		if (startIndex < 0) {
			break;
		}
		const endIndex = markedJs.indexOf(markerEnd, startIndex);
		const [sourceLine, sourceColumn] = markedJs.slice(startIndex + 1, endIndex).split(':').map(Number);
		mappings.push({
			generatedLine: generatedLine,
			generatedColumn: jsLength - lineStartIndex,
			sourceLine: sourceLine!,
			sourceColumn: sourceColumn!,
		});
		index = endIndex + 1;
	}
	return { js: chunks.join(''), mappings: mappings };
}

//#endregion source map

//#region runtime import

/**
 * Ein Bezeichner im erzeugten JS, außer hinter einem einzelnen Punkt (Feldzugriff `a.map`,
 * `a?.map`). Hinter `...` steht dagegen eine Referenz.
 */
const identifierRegex = /(?<![\w$])(?<!(?:^|[^.])\.)[A-Za-z_$][\w$]*/g;

/**
 * Die Namen aus `keys`, die im erzeugten JS als Bezeichner vorkommen, in der Reihenfolge von `keys`.
 * Der Scan über den fertigen Text statt einer Sammlung beim Emittieren sieht auch die Hilfsaufrufe
 * (_branch, _callFunction, ...), die der Emitter an vielen Stellen als festen Text schreibt. Er
 * schätzt nach oben ab: Ein Builtin-Name in einem Textliteral wird mit importiert, das ist harmlos.
 * Überdeckung eines Builtins durch einen lokalen Namen gibt es nicht (JUL3203).
 */
export function getUsedRuntimeNames(js: string, keys: string[]): string[] {
	const identifiers = new Set(js.match(identifierRegex));
	return keys.filter(key => identifiers.has(key));
}

export function getRuntimeImportJs(runtimeImportPath: string, names: string[]): string {
	if (!names.length) {
		return '';
	}
	return getImportJs(`{ ${names.join(', ')} }`, runtimeImportPath);
}

/**
 * Nur *.test.jul-Dateien importieren die Test-Runtime.
 */
export function getTestRuntimeImportJs(testRuntimeImportPath: string, names: string[]): string {
	if (!names.length) {
		return '';
	}
	return getImportJs(`{ ${names.join(', ')} }`, testRuntimeImportPath);
}

//#endregion runtime import

export function syntaxTreeToJs(
	checkResult: CheckResult,
	expressions: ParseExpression[],
	runtimeImportPath: string,
	/**
	 * Wie er in Meldungen erscheinen soll. Nur für test-Aufrufe gebraucht.
	 */
	filePath: string = '',
	/**
	 * Nur für *.test.jul-Dateien gebraucht.
	 */
	testRuntimeImportPath: string = '',
	options: EmitOptions = {},
): string {
	return syntaxTreeToJsWithMappings(checkResult, expressions, runtimeImportPath, filePath, testRuntimeImportPath, options).js;
}

export interface EmitOptions {
	/**
	 * assume prüft seine Behauptung zur Laufzeit. Nur für jul test, der normale Build bleibt
	 * unverändert.
	 */
	checkAssumes?: boolean;
	/**
	 * Ob die importierte Datei einen default-Export hat (ParsedFile.hasDefaultExport), zum Pfad
	 * relativ zur emittierten Datei, wie er im import steht. Nur nötig, wenn die Datei importiert.
	 */
	hasDefaultExport?: (importedPath: string) => boolean;
}

/**
 * Das JS einer untypisierten .json-Datei, ohne Umweg über einen Syntaxbaum. Dieselben Werte wie
 * der Baum aus jsonValueToParsedExpressions: Integer als bigint, Brüche und Dictionaries als
 * Objekte, null und leere Kollektionen als undefined.
 */
export function jsonValueToJs(value: JsonValue): string {
	return `export default ${jsonValueToJsExpression(value)}`;
}

function jsonValueToJsExpression(value: JsonValue | null): string {
	switch (typeof value) {
		case 'bigint':
			return integerToJs(value);
		case 'number':
			// _parseJson liefert ganze Zahlen im sicheren Bereich als number (kanonisch), nie einen Float
			return '' + value;
		case 'boolean':
			return '' + value;
		case 'string':
			// Ein JSON-String-Literal ist auch ein gültiges JS-Literal.
			return JSON.stringify(value);
		case 'object': {
			if (value === null) {
				return 'undefined';
			}
			if (Array.isArray(value)) {
				return `[${value.map(jsonValueToJsExpression).join(',')}]`;
			}
			const fieldsJs = Object.entries(value).map(([key, fieldValue]) => {
				return `${JSON.stringify(key)}:${jsonValueToJsExpression(fieldValue)}`;
			});
			return `{${fieldsJs.join(',')}}`;
		}
		case 'undefined':
			return 'undefined';
		default:
			throw new Error(`Unexpected jsonValue type: ${typeof value}`);
	}
}

/**
 * Wie syntaxTreeToJs, dazu je Statement (Top-Level-Ausdruck, Ausdruck in einem Funktionsrumpf) die
 * Zuordnung seines Anfangs zur Quellposition, für die Source Map, und die importierten
 * Runtime-Namen, aus denen der Compiler die verkleinerte Runtime erzeugt (shakeRuntime).
 */
export function syntaxTreeToJsWithMappings(
	checkResult: CheckResult,
	expressions: ParseExpression[],
	runtimeImportPath: string,
	filePath: string = '',
	testRuntimeImportPath: string = '',
	options: EmitOptions = {},
): { js: string; mappings: SourceMapping[]; runtimeNames: string[]; } {
	const isValueFile = julHasDefaultExport(expressions);
	useTypeInfo = true;
	emitSourcePositions = true;
	sourceFilePath = filePath;
	checkAssumes = !!options.checkAssumes;
	hasDefaultExport = options.hasDefaultExport;
	try {
		const bodyJs = expressions.map((expression, index) => {
			const expressionJs = expressionToJs(checkResult, expression, 0, true);
			const markerJs = sourcePositionMarkerJs(expression);
			// default export = last expression
			if (index === expressions.length - 1
				&& isValueFile) {
				return `${markerJs}export default ${expressionJs}`;
			}
			return markerJs + expressionJs;
		}).join('\n');
		// Die Marker stehen erst nach dem Import im Text, extractSourceMappings zählt die Zeilen des
		// Imports also mit.
		const runtimeNames = getUsedRuntimeNames(bodyJs, runtimeKeys);
		const runtimeImportJs = getRuntimeImportJs(runtimeImportPath, runtimeNames);
		const testRuntimeImportJs = isTestFilePath(filePath)
			? getTestRuntimeImportJs(testRuntimeImportPath, getUsedRuntimeNames(bodyJs, testRuntimeKeys))
			: '';
		return { ...extractSourceMappings(runtimeImportJs + testRuntimeImportJs + bodyJs), runtimeNames: runtimeNames };
	}
	finally {
		useTypeInfo = false;
		emitSourcePositions = false;
		sourceFilePath = '';
		checkAssumes = false;
		hasDefaultExport = undefined;
	}
}

/**
 * Für constant folding von Nutzerfunktionen (siehe tryBuildCallable in constant-folding.ts):
 * emittiert ein Funktionsliteral ohne Modul-Header, aufrufbar über new Function(...bindingNames,
 * js). Anders als
 * die normale Emission (case 'functionLiteral') über `let` statt `const` und mit Rückweisung des
 * Ergebnisses von `_createFunction` auf den eigenen Namen: der Sandbox-Aufrufer reicht dafür einen
 * budgetierten `_createFunction`-Wrapper herein, der eine neue Closure zurückgibt statt in-place zu
 * mutieren (Produktionscode braucht das nicht, weil er den Rückgabewert verwirft). Die Rückweisung
 * ist nötig, damit auch eine Selbstreferenz im Rumpf - über dieselbe `let`-Bindung aufgelöst - durch
 * den Wrapper läuft, nicht am Original vorbei.
 */
export function functionLiteralToEvaluableJs(checkResult: CheckResult, literal: ParseFunctionLiteral): string {
	const indent = 1;
	const { functionJs, paramsJs, delimiterJs } = functionLiteralToJsParts(checkResult, literal.params, literal.body, indent);
	// Eine Selbstreferenz im Rumpf nennt sich beim ursprünglichen Definitionsnamen (referenceToJs
	// emittiert ihn wörtlich) - die Bindung hier muss also genauso heißen, sonst läuft die
	// Rekursion an dieser Closure vorbei in einen ReferenceError.
	const parent = literal.parent;
	const nameJs = parent?.type === 'definition' && parent.value === literal
		? escapeReservedJsVariableName(parent.name.name)
		: '_foldedFunction';
	return `let ${nameJs} = ${functionJs};${delimiterJs}${nameJs} = _createFunction(${nameJs}, ${paramsJs});${delimiterJs}return ${nameJs};`;
}

function getDefinitionJs(isExport: boolean, nameJs: string, valueJs: string): string {
	return `${isExport ? 'export ' : ''}const ${nameJs} = ${valueJs};`;
}

function expressionToJs(
	checkResult: CheckResult,
	expression: ParseExpression,
	indent: number,
	topLevel: boolean = false,
): string {
	switch (expression.type) {
		case 'branching': {
			const args = expression.args;
			if (!args) {
				throw new Error('args missing in branching');
			}
			const dispatch = useTypeInfo
				? getBranchDispatch(checkResult, expression)
				: undefined;
			if (dispatch) {
				return branchDispatchToJs(checkResult, expression, dispatch, indent);
			}
			const innerIndent = indent + 1;
			const jsValues = [
				expressionToJs(checkResult, args, innerIndent),
				...expression.branches.map(branch => expressionToJs(checkResult, branch, innerIndent)),
			];
			return `_branch(${listValuesToJs(jsValues, indent)})`;
		}
		case 'definition': {
			// export topLevel definitions
			const value = expression.value;
			if (!value) {
				throw new Error('value missing in definition');
			}
			const nameJs = escapeReservedJsVariableName(expression.name.name);
			if (isImportFunctionCall(value)) {
				const importPath = getPathFromImport(value);
				const aliasJs = `_${nameJs}`;
				// value import: der default-Export, sonst das Modul mit allen Definitionen
				const importedJs = isValueImport(value)
					? aliasJs
					: `* as ${aliasJs}`;
				return `${getImportJs(importedJs, importPath)}
${getDefinitionJs(topLevel, nameJs, aliasJs)}`;
			}
			const valueJs = expressionToJs(checkResult, value, indent);
			// _ bindet nichts: nur auswerten. Als letzter Ausdruck eines Rumpfs ist es ein Fehler,
			// der Emitter sieht es dort nie.
			if (expression.name.name === discardName) {
				return `${valueJs};`;
			}
			return getDefinitionJs(topLevel, nameJs, valueJs);
		}
		case 'destructuring': {
			// _ überspringt eine Position. index bleibt die Position im geschriebenen Ziel.
			const fields = expression.fields.fields
				.map((field, index) => ({ ...field, index: index }))
				.filter(field => field.name.name !== discardName);
			const value = expression.value;
			if (!value) {
				throw new Error('value missing in destructuring');
			}
			if (isImportFunctionCall(value)) {
				const importPath = getPathFromImport(value);
				// Aus TypeScript: Werte mit Integer im Typ an der Grenze umwandeln (TS bekommt bigint, Jul kanonische Integer)
				const moduleType = useTypeInfo && isTsImport(value)
					? getTypeInfo(checkResult, value)?.type
					: undefined;
				const wrapped: string[] = [];
				const importJs = getImportJs(`{${fields.map(field => {
					const name = field.name.name;
					const nameJs = escapeReservedJsVariableName(name);
					const source = field.source?.name;
					const sourceJs = escapeReservedJsVariableName(source ?? name);
					const spec = moduleType && getTsConversionSpec(getModuleFieldType(moduleType, source ?? name), new Set());
					if (spec) {
						wrapped.push(`const ${nameJs} = _fromTs(_ts_${nameJs}, ${JSON.stringify(spec)});\n`);
						return `${sourceJs} as _ts_${nameJs}`;
					}
					return source
						? `${sourceJs} as ${nameJs}`
						: nameJs;
				}).join(', ')}}`, importPath);
				return importJs + wrapped.join('');
			}
			// TODO spread
			const delimiterJs = getRowDelimiterJs(indent);
			const declarations = fields.map(field => {
				const name = getCheckedEscapableName(field.name);
				return `let ${name && escapeReservedJsVariableName(name)};`;
			}).join(delimiterJs);
			const assignments = fields.map(singleName => {
				const { name, source, index } = singleName;
				const nameString = name.name;
				const sourceString = source?.name ?? nameString;
				const nameJs = escapeReservedJsVariableName(nameString);
				const sourceJs = escapeReservedJsVariableName(sourceString);
				const valueJs = `_isArray ? _temp[${index}] : _temp.${sourceJs}`;
				return `${nameJs} = ${valueJs};`;
			}).join(delimiterJs);
			return `${declarations}${delimiterJs}{${delimiterJs}const _temp = ${expressionToJs(checkResult, value, indent)};${delimiterJs}const _isArray = Array.isArray(_temp);${delimiterJs}${assignments}${delimiterJs}}`;
		}
		case 'dictionary': {
			const newIndent = indent + 1;
			// TODO mit Object.create(null), damit leerer prototype? Oder Persistent Data Structure?
			return dictionaryToJs(expression.fields.map(field => {
				if (!field.value) {
					throw new Error('value missing for dictionary field');
				}
				const valueJs = expressionToJs(checkResult, field.value, newIndent);
				if (field.type === 'singleDictionaryField') {
					return singleDictionaryFieldToJs(field.name, valueJs);
				}
				else {
					return spreadDictionaryFieldToJs(countCopyJs(valueJs, field.value, expression, 'dictSpread'));
				}
			}), indent);
		}
		case 'dictionaryType': {
			const newIndent = indent + 1;
			const fieldsIndent = newIndent + 1;
			const fieldsJs = dictionaryToJs(expression.fields.map(field => {
				if (field.type === 'singleDictionaryTypeField') {
					const typeGuardJs = field.typeGuard
						? expressionToJs(checkResult, field.typeGuard, fieldsIndent)
						: 'Any';
					// Ein Feld, das fehlen darf (b?: X), trägt das Kennzeichen am Typ des Felds.
					return singleDictionaryFieldToJs(field.name, field.optional ? `_optionalField(${typeGuardJs})` : typeGuardJs);
				}
				else {
					// Der gespreadete Wert ist selbst ein Typobjekt, übernommen werden seine Fields.
					return spreadDictionaryFieldToJs(`${expressionToJs(checkResult, field.value, fieldsIndent)}.Fields`);
				}
			}), newIndent);
			return dictionaryToJs([
				singleDictionaryFieldToJsInternal('[_julTypeSymbol]', '\'dictionaryLiteral\''),
				singleDictionaryFieldToJsInternal('Fields', fieldsJs),
			], indent);
		}
		case 'empty':
			return 'undefined';
		case 'float':
			return '' + expression.value;
		case 'fraction':
			return `{numerator:${integerToJs(expression.numerator)},denominator:${integerToJs(expression.denominator)}}`;
		case 'functionCall': {
			const callJs = functionCallToJs(checkResult, expression, indent);
			// Der Checker hat den Aufruf einer Typfunktion im eigenen Rumpf als Anwendung markiert. Sofort
			// ausgewertet riefe jeder Aufruf von Tree den nächsten auf. Entschieden wird am geprüften
			// Baum, nicht an useTypeInfo: das schaltet Optimierungen, hier geht es um Korrektheit.
			const selfAppliedName = getSelfAppliedTypeFunctionName(checkResult, expression);
			return selfAppliedName === undefined
				? callJs
				: `_lazyType(${stringToJs(selfAppliedName)}, () => ${callJs})`;
		}
		case 'functionLiteral': {
			const parent = expression.parent;
			const isNamed = parent?.type === 'definition'
				&& expression === parent.value;
			const tail = useTypeInfo && isNamed
				? analyzeTailCalls(checkResult, expression, parent.name.name)
				: undefined;
			const { functionJs, paramsJs, delimiterJs } = functionLiteralToJsParts(checkResult, expression.params, expression.body, indent, tail);
			if (!needsRuntimeParams(expression)) {
				// Nichts liest die Parameterliste: ein nacktes Arrow, ohne _createFunction.
				if (isNamed) {
					return functionJs;
				}
				return isAccessSource(expression)
					? `(${functionJs})`
					: functionJs;
			}
			if (isNamed) {
				// named function
				const nameJs = escapeReservedJsVariableName(parent.name.name);
				return `${functionJs}${delimiterJs}${callCreateFunctionJs(nameJs, paramsJs, indent)}`;
			}
			// anonymous function
			return callCreateFunctionJs(functionJs, paramsJs, indent);
		}
		case 'functionTypeLiteral':
			return `_Function`;
		case 'integer':
			return integerToJs(expression.value);
		case 'list': {
			const jsValues = parseListValuesToJs(checkResult, expression.values, indent, expression);
			return listToJs(jsValues, indent);
		}
		case 'nestedReference': {
			const nestedKey = expression.nestedKey;
			if (!nestedKey) {
				throw new Error('Missing nestedKey in nestedReference.');
			}
			switch (nestedKey.type) {
				case 'index':
					return `${expressionToJs(checkResult, expression.source, indent)}?.[${nestedKey.name} - 1]`;
				case 'name':
				case 'text':
					const field = getCheckedEscapableName(nestedKey);
					if (!field) {
						throw new Error(`Invalid field.`);
					}
					return `${expressionToJs(checkResult, expression.source, indent)}?.[${stringToJs(field)}]`;
				default: {
					const assertNever: never = nestedKey;
					throw new Error(`Unexpected nestedKey.type ${(assertNever as ParseExpression).type}`);
				}
			}
		}
		case 'object': {
			return `_combineObject(${expression.values.map(value => {
				return expressionToJs(checkResult, value.value, indent);
			}).join(`,${getRowDelimiterJs(indent)}`)})`;
		}
		case 'reference':
			return referenceToJs(expression);
		case 'text':
			return textLiteralToJs(checkResult, expression, indent);
		case 'binding':
		case 'data':
		case 'field':
		// Nur im Rückgabetyp erlaubt, und der wird nicht emittiert.
		case 'typeBranching': {
			throw new Error(`Unexpected expression.type: ${expression.type}`);
		}
		default: {
			const assertNever: never = expression;
			throw new Error(`Unexpected expression.type: ${(assertNever as ParseExpression).type}`);
		}
	}
}

/**
 * listLiteral nur für ein List-Literal, nicht für Argumentlisten: Nur dort kopiert ein Spread.
 */
function parseListValuesToJs(checkResult: CheckResult, values: NonEmptyArray<ParseListValue>, indent: number, listLiteral?: ParseExpression): string[] {
	const innerIndent = indent + 1;
	const jsValues = values.map(value => {
		const valueJs = value.type === 'spread'
			? `...${listLiteral
				? countCopyJs(expressionToJs(checkResult, value.value, innerIndent), value.value, listLiteral, 'listSpread')
				: expressionToJs(checkResult, value.value, innerIndent)} ?? []`
			: expressionToJs(checkResult, value, innerIndent);
		return valueJs;
	});
	return jsValues;
}

function listValuesToJs(jsValues: string[], indent: number): string {
	if (!jsValues.length) {
		return '';
	}
	if (jsValues.length === 1) {
		return jsValues[0]!;
	}
	const delimiterJs = getRowDelimiterJs(indent);
	const innerIndent = indent + 1;
	const innerDelimiter = getRowDelimiterJs(innerIndent);
	return `${innerDelimiter}${jsValues.join(',' + innerDelimiter)},${delimiterJs}`;
}

function listToJs(valuesJs: string[], indent: number) {
	return `[${listValuesToJs(valuesJs, indent)}]`;
}

//#region import

function isValueImport(importExpression: ParseFunctionCall): boolean {
	const { path } = getImportedPath(importExpression, '');
	if (!hasDefaultExport || !path) {
		throw new Error('hasDefaultExport missing for import ' + path);
	}
	return hasDefaultExport(path);
}

function getImportJs(importedJs: string, path: string): string {
	const isJson = path.endsWith(Extension.json);
	const pathWithFileScheme = (isAbsolute(path) ? 'file://' : '') + path;
	return `import ${importedJs} from ${stringToJs(pathWithFileScheme)}${isJson ? ' with { type: \'json\' }' : ''};\n`;
}

/** import(§…/datei.ts§) */
function isTsImport(importExpression: ParseFunctionCall): boolean {
	const args = importExpression.arguments;
	const pathExpression = args && getPathExpression(args);
	return !!pathExpression
		&& pathExpression.type === 'text'
		&& pathExpression.values.length === 1
		&& pathExpression.values[0]!.type === 'textToken'
		&& extname(pathExpression.values[0].value) === Extension.ts;
}

/** Der Typ eines Exports im Typ eines importierten Moduls (ein Record der Exporte) */
function getModuleFieldType(moduleType: CompileTimeType, name: string): CompileTimeType | undefined {
	const resolved = resolveAlias(resolvePlaceholders(moduleType));
	return resolved.julType === 'dictionaryLiteral'
		? resolved.FieldTypes[name]
		: undefined;
}

/**
 * Wie ein Wert dieses Typs an der Grenze zu TypeScript umgewandelt wird (runtime.ts, TsConversionSpec).
 * undefined: keine Umwandlung nötig, der Wert enthält keinen Integer.
 */
function getTsConversionSpec(rawType: CompileTimeType | undefined, visited: Set<CompileTimeType>): runtime.TsConversionSpec | undefined {
	if (!rawType
		|| visited.has(rawType)) {
		return undefined;
	}
	visited.add(rawType);
	try {
		// TS-Typ CanonicalInteger: Die TS-Funktion verarbeitet kanonische Integer selbst (core-lib.jul)
		if (rawType.julType === 'alias'
			&& rawType.name === 'CanonicalInteger') {
			return undefined;
		}
		const type = resolveAlias(rawType);
		switch (type.julType) {
			case 'integer':
			case 'integerLiteral':
				return 'i';
			case 'bound':
				return type.Family === 'integer'
					? 'i'
					: undefined;
			case 'list': {
				const elementSpec = getTsConversionSpec(type.ElementType, visited);
				return elementSpec && ['l', elementSpec];
			}
			case 'dictionary': {
				const elementSpec = getTsConversionSpec(type.ElementType, visited);
				return elementSpec && ['m', elementSpec];
			}
			case 'tuple': {
				const elementSpecs = type.ElementTypes.map(elementType => getTsConversionSpec(elementType, visited) ?? null);
				return elementSpecs.some(spec => spec)
					? ['t', elementSpecs]
					: undefined;
			}
			case 'dictionaryLiteral': {
				const fieldSpecs: { [field: string]: runtime.TsConversionSpec; } = {};
				let hasSpec = false;
				for (const [field, fieldType] of Object.entries(type.FieldTypes)) {
					const fieldSpec = getTsConversionSpec(fieldType, visited);
					if (fieldSpec) {
						fieldSpecs[field] = fieldSpec;
						hasSpec = true;
					}
				}
				return hasSpec
					? ['d', fieldSpecs]
					: undefined;
			}
			case 'or':
			case 'and': {
				const choiceSpecs = type.ChoiceTypes
					.map(choiceType => getTsConversionSpec(choiceType, visited))
					.filter(isDefined);
				if (!choiceSpecs.length) {
					return undefined;
				}
				return choiceSpecs.length === 1
					? choiceSpecs[0]
					: ['u', choiceSpecs];
			}
			default: {
				if (!isFunctionType(type)) {
					return undefined;
				}
				const paramsType = resolveAlias(type.ParamsType);
				const paramSpecs = isParametersType(paramsType)
					? paramsType.singleNames.map(parameter => getTsConversionSpec(parameter.type, visited) ?? null)
					: [];
				const restSpec = isParametersType(paramsType) && paramsType.rest
					? getTsConversionSpec(paramsType.rest.type, visited) ?? null
					: null;
				// Rest-Parameter sind eine Liste: je Argument gilt der Elementtyp
				const restElementSpec = restSpec && typeof restSpec !== 'string' && restSpec[0] === 'l'
					? restSpec[1]
					: restSpec;
				const returnSpec = getTsConversionSpec(type.ReturnType, visited) ?? null;
				return paramSpecs.some(spec => spec) || restElementSpec || returnSpec
					? ['f', paramSpecs, restElementSpec, returnSpec]
					: undefined;
			}
		}
	}
	finally {
		visited.delete(rawType);
	}
}

function getPathFromImport(importExpression: ParseFunctionCall): string {
	const args = importExpression.arguments;
	if (!args) {
		throw new Error('arguments missing for import');
	}
	const pathExpression = getPathExpression(args);
	if (pathExpression
		&& pathExpression.type === 'text'
		&& pathExpression.values.length === 1
		&& pathExpression.values[0]!.type === 'textToken') {
		const importedPath = pathExpression.values[0].value;
		const extension = extname(importedPath);
		switch (extension) {
			case Extension.json:
			case Extension.jul:
			case Extension.ts:
				return changeExtension(importedPath, Extension.js);
			case Extension.yaml:
				return importedPath + Extension.json;
			case Extension.js:
				return importedPath;
			default:
				throw new Error('Unexpected extension for import ' + extension);
		}
	}
	// TODO dynamische imports verbieten???
	throw new Error('Can not get import path from ' + pathExpression?.type);
}

//#endregion import

function functionBodyToJs(checkResult: CheckResult, expressions: ParseExpression[], indent: number, tail?: TailContext): string {
	const delimiter = getRowDelimiterJs(indent);
	const js = delimiter + expressions.map((expression, index) => {
		const markerJs = sourcePositionMarkerJs(expression);
		// Die letzte Expression ist der Rückgabewert
		if (index === expressions.length - 1) {
			if (tail
				&& (expression.type === 'functionCall' || expression.type === 'branching')
				&& (tail.calls.has(expression as ParseFunctionCall) || tail.branchings.has(expression as ParseBranching))) {
				return `${markerJs}${tailExpressionToJs(checkResult, expression, indent, tail)}`;
			}
			const expressionJs = expressionToJs(checkResult, expression, indent);
			if (expression.type === 'definition') {
				return `${markerJs}${expressionJs}${delimiter}return ${escapeReservedJsVariableName(expression.name.name)};`;
			}
			return `${markerJs}return ${expressionJs}`;
		}
		return markerJs + expressionToJs(checkResult, expression, indent);
	}).join(delimiter);
	return js;
}

/**
 * `argsJs`/`paramsJs`/`functionJs` für ein Funktionsliteral, gemeinsam für die normale Emission
 * (case 'functionLiteral') und functionLiteralToEvaluableJs. `indent` ist der Indent, auf dem
 * `params` selbst eingebettet wird (Argumentposition von `_createFunction`); der Function-Body liegt
 * davon zwei Ebenen tiefer (Body innerhalb der Arrow-Function innerhalb der `_createFunction`-Argumente).
 * `delimiterJs` (Zeilenende auf Höhe der schließenden `}`) wird zurückgegeben, weil der Aufrufer es
 * i. d. R. auch für den umgebenden Code braucht.
 */
function functionLiteralToJsParts(
	checkResult: CheckResult,
	params: SimpleExpression | ParseParameterFields,
	body: ParseExpression[],
	indent: number,
	tail?: TailContext,
): { functionJs: string; paramsJs: string; delimiterJs: string; } {
	let argsJs: string;
	let paramsJs: string;
	if (params.type === 'parameters') {
		argsJs = params.singleFields.map((field, index) => parameterNameToJs(field.name.name, index)).join(', ');
		const rest = params.rest;
		if (rest) {
			argsJs += (argsJs ? ', ' : '') + '...' + parameterNameToJs(rest.name.name, params.singleFields.length);
		}
		paramsJs = parametersToJs(checkResult, params, indent);
	}
	else {
		argsJs = '';
		// Ein Listenliteral, dem der Checker einen Tupeltyp gegeben hat, ist eine Parameterliste ohne
		// Namen (siehe createUnnamedParametersType): Positionen unter head. Jeder andere Kopf ist ein
		// Typ und beschreibt die ganze Argumentkollektion. Ohne Typinfo (ungeprüfter Baum) bleibt es
		// ein Typ-Kopf.
		const isPositionalHead = params.type === 'list'
			&& getTypeInfo(checkResult, params)?.type.julType === 'tuple';
		const headFieldJs = singleDictionaryFieldToJsInternal(isPositionalHead ? 'head' : 'type', expressionToJs(checkResult, params, indent));
		paramsJs = dictionaryToJs([headFieldJs], indent);
	}
	const delimiterJs = getRowDelimiterJs(indent + 1);
	const functionJs = tail
		? `(${argsJs}) => {${getRowDelimiterJs(indent + 2)}while (true) {${functionBodyToJs(checkResult, body, indent + 3, tail)}${getRowDelimiterJs(indent + 2)}}${delimiterJs}}`
		: `(${argsJs}) => {${functionBodyToJs(checkResult, body, indent + 2)}${delimiterJs}}`;
	return { functionJs, paramsJs, delimiterJs };
}

/**
 * `_` bindet nichts, steht in JS aber trotzdem als Parameter. Mehrere gleichnamige Parameter sind
 * dort ein Syntaxfehler, deshalb nach Position benannt. Ein JUL-Name beginnt nie mit `_`.
 */
function parameterNameToJs(name: string, index: number): string {
	return name === discardName
		? `_${index}`
		: escapeReservedJsVariableName(name);
}

/**
 * Liest die Laufzeit die Parameterliste dieses Funktionsliterals? Nur tryAssignArgs tut es, für
 * ein Prädikat in Typposition und für die Branches von _branch. Es prüft Typen aus der Liste:
 * einen Typ-Kopf und Parametertypen. Ohne sie bindet es nur der Reihe nach, wie ein direkter
 * Aufruf. Benannte Aufrufe ordnet der Emitter selbst zu (JUL2501).
 */
function needsRuntimeParams(literal: ParseFunctionLiteral): boolean {
	if (literal.parent?.type === 'branching') {
		return true;
	}
	const params = literal.params;
	if (params.type !== 'parameters') {
		return true;
	}
	return params.singleFields.some(field => field.typeGuard)
		|| !!params.rest?.typeGuard;
}

/**
 * Ein Arrow als Quelle eines Zugriffs braucht Klammern. Als aufgerufener Ausdruck steht nie ein
 * Funktionsliteral, die Grammatik lässt es nicht zu.
 */
function isAccessSource(literal: ParseFunctionLiteral): boolean {
	const parent = literal.parent;
	return parent?.type === 'nestedReference' && parent.source === literal;
}

//#region Tail-Call-Optimierung

/**
 * Selbstaufrufe in Tail-Position, die als Schleife emittiert werden. JS führt keine Tail Calls
 * aus, jeder Schritt der Rekursion verbrauchte sonst einen Stack-Frame.
 */
interface TailContext {
	paramNamesJs: string[];
	/** Die Selbstaufrufe in Tail-Position: werden zu Parameterzuweisung und continue */
	calls: Set<ParseFunctionCall>;
	/** Die branchings auf dem Weg zu einem Selbstaufruf: werden zu if/else-Ketten, ihre branches inline */
	branchings: Set<ParseBranching>;
}

/**
 * undefined, wenn die Funktion nicht als Schleife emittiert wird: kein Selbstaufruf in Tail-Position,
 * oder die Umformung wäre nicht gleichwertig. Das Letzte gilt, sobald irgendwo im Rumpf ein weiteres
 * Funktionsliteral steht (außer den inline emittierten branches): Eine Closure sähe sonst die
 * Parameter der Folgeiterationen. Ebenso, wenn ein inline emittierter branch einen Namen bindet, der
 * einen Parameter verdeckte: Die Zuweisung für den nächsten Durchlauf träfe den falschen.
 */
function analyzeTailCalls(checkResult: CheckResult, literal: ParseFunctionLiteral, name: string): TailContext | undefined {
	const params = literal.params;
	if (params.type !== 'parameters'
		|| params.rest
		|| !params.singleFields.length) {
		return undefined;
	}
	const parameterNames = params.singleFields.map(field => field.name.name);
	const calls = new Set<ParseFunctionCall>();
	const branchings = new Set<ParseBranching>();
	const inlinedBranches = new Set<ParseFunctionLiteral>();
	const visitTail = (expression: ParseExpression | undefined): boolean => {
		if (expression?.type === 'functionCall') {
			if (!isTailSelfCall(checkResult, expression, name, parameterNames.length)) {
				return false;
			}
			calls.add(expression);
			return true;
		}
		if (expression?.type !== 'branching') {
			return false;
		}
		const dispatch = getBranchDispatch(checkResult, expression);
		if (!dispatch) {
			return false;
		}
		const emittedBranches: ParseValueExpression[] = [];
		dispatch.tests.forEach((test, index) => {
			if (test.kind !== 'never') {
				emittedBranches.push(expression.branches[index]!);
			}
		});
		const inlinableBranches = emittedBranches.filter(isInlinableBranch);
		if (inlinableBranches.length !== emittedBranches.length) {
			return false;
		}
		let containsTailCall = false;
		for (const branch of inlinableBranches) {
			if (visitTail(branch.body[branch.body.length - 1])) {
				containsTailCall = true;
			}
		}
		if (containsTailCall) {
			branchings.add(expression);
			inlinableBranches.forEach(branch => inlinedBranches.add(branch));
		}
		return containsTailCall;
	};
	if (!visitTail(literal.body[literal.body.length - 1])) {
		return undefined;
	}
	const hasForeignClosure = (expression: PositionedExpression): true | undefined =>
		forEachChild(expression, child =>
			child.type === 'functionLiteral' && !inlinedBranches.has(child)
				? true
				: hasForeignClosure(child));
	if (literal.body.some(expression => hasForeignClosure(expression))) {
		return undefined;
	}
	// Die Selbstreferenz im Rumpf hat keinen Typ (die Funktion ist noch in Arbeit), sie wird deshalb
	// über den Namen erkannt: kein Parameter, keine Definition im Rumpf und in den inline emittierten
	// branches darf ihn verdecken.
	const shadowing = [literal, ...inlinedBranches].some(scope =>
		Object.keys(scope.symbols).some(symbol => symbol === name));
	if (shadowing) {
		return undefined;
	}
	for (const branch of inlinedBranches) {
		if (Object.keys(branch.symbols).some(symbol => parameterNames.includes(symbol))) {
			return undefined;
		}
	}
	return {
		paramNamesJs: parameterNames.map(parameterNameToJs),
		calls: calls,
		branchings: branchings,
	};
}

function isInlinableBranch(branch: ParseValueExpression): branch is ParseFunctionLiteral {
	return branch.type === 'functionLiteral'
		&& (branch.params.type !== 'parameters'
			|| (!branch.params.rest && branch.params.singleFields.length <= 1));
}

/**
 * Ein Aufruf der Funktion `name` selbst, mit genau so vielen positionalen Argumenten wie Parametern.
 * Dass die Referenz die Definition meint und keinen verdeckenden Namen, prüft analyzeTailCalls.
 */
function isTailSelfCall(
	checkResult: CheckResult,
	call: ParseFunctionCall,
	name: string,
	parameterCount: number,
): boolean {
	const functionExpression = call.functionExpression;
	const args = call.arguments;
	if (functionExpression?.type !== 'reference'
		|| functionExpression.name.name !== name
		|| call.prefixArgument
		|| args?.type !== 'list'
		|| args.values.length !== parameterCount
		|| args.values.some(value => value.type === 'spread')
		|| getSelfAppliedTypeFunctionName(checkResult, call) !== undefined) {
		return false;
	}
	return true;
}

/** Die Anweisungen für eine Expression in Tail-Position, die in tail.calls oder tail.branchings steht */
function tailExpressionToJs(checkResult: CheckResult, expression: ParseExpression, indent: number, tail: TailContext): string {
	if (expression.type === 'functionCall') {
		const values = (expression.arguments as { values: ParseValueExpression[]; }).values
			.map(value => expressionToJs(checkResult, value, indent + 1));
		// Das führende ; schützt vor einer Fortsetzung der vorigen Zeile (kein Semikolon nach Aufrufen)
		const assignmentJs = values.length === 1
			? `${tail.paramNamesJs[0]} = ${values[0]};`
			: `;[${tail.paramNamesJs.join(', ')}] = [${values.join(', ')}];`;
		return `${assignmentJs}${getRowDelimiterJs(indent)}continue;`;
	}
	const branching = expression as ParseBranching;
	const dispatch = getBranchDispatch(checkResult, branching)!;
	const argument = (branching.args as { values: ParseListValue[]; }).values[0] as ParseValueExpression;
	const isReference = argument.type === 'reference';
	const argumentJs = isReference
		? referenceToJs(argument)
		: '_arg';
	const delimiterJs = getRowDelimiterJs(indent);
	let js = isReference
		? ''
		: `const _arg = ${expressionToJs(checkResult, argument, indent)};${delimiterJs}`;
	let hasCatchAll = false;
	const chainJs: string[] = [];
	dispatch.tests.forEach((test, index) => {
		if (test.kind === 'never') {
			return;
		}
		const branch = branching.branches[index] as ParseFunctionLiteral;
		const bindsArgument = branch.params.type === 'parameters'
			&& branch.params.singleFields.length === 1
			&& branch.params.singleFields[0]!.name.name !== discardName;
		const bindingJs = bindsArgument
			? `${getRowDelimiterJs(indent + 1)}const ${escapeReservedJsVariableName((branch.params as ParseParameterFields).singleFields[0]!.name.name)} = ${argumentJs};`
			: '';
		const blockJs = `{${bindingJs}${functionBodyToJs(checkResult, branch.body, indent + 1, tail)}${delimiterJs}}`;
		if (test.kind === 'always') {
			hasCatchAll = true;
			chainJs.push(blockJs);
			return;
		}
		chainJs.push(`if (${branchTestToJs(test, argumentJs)}) ${blockJs}`);
	});
	if (!hasCatchAll) {
		chainJs.push(`{${getRowDelimiterJs(indent + 1)}return _noBranchMatched(${argumentJs});${delimiterJs}}`);
	}
	js += chainJs.join(' else ');
	return js;
}

//#endregion Tail-Call-Optimierung

//#region branching mit Typinformation

/**
 * Eine ?:-Kette statt _branch: je branch der Test aus getBranchDispatch, der branch selbst als
 * Arrow an Ort und Stelle aufgerufen, ohne _createFunction. Ein nicht-Referenz-Argument wird
 * über ein umschließendes Arrow genau einmal ausgewertet.
 */
function branchDispatchToJs(checkResult: CheckResult, branching: ParseBranching, dispatch: BranchDispatch, indent: number): string {
	// getBranchDispatch liefert nur für ?(x) mit genau einem Argument ohne Spread ein Ergebnis
	const argument = (branching.args as { values: ParseListValue[]; }).values[0] as ParseValueExpression;
	const isReference = argument.type === 'reference';
	const argumentJs = isReference
		? referenceToJs(argument)
		: '_arg';
	const chainIndent = isReference
		? indent
		: indent + 1;
	const delimiterJs = getRowDelimiterJs(chainIndent + 1);
	let chainJs = '';
	dispatch.tests.forEach((test, index) => {
		if (test.kind === 'never') {
			return;
		}
		const callJs = branchCallToJs(checkResult, branching.branches[index]!, argumentJs, chainIndent);
		if (test.kind === 'always') {
			chainJs += callJs;
			return;
		}
		chainJs += `${branchTestToJs(test, argumentJs)}${delimiterJs}? ${callJs}${delimiterJs}: `;
	});
	if (!dispatch.exhaustive) {
		chainJs += `_noBranchMatched(${argumentJs})`;
	}
	return isReference
		? chainJs
		: `((${argumentJs}) => ${chainJs})(${expressionToJs(checkResult, argument, indent)})`;
}

function branchCallToJs(checkResult: CheckResult, branch: ParseValueExpression, argumentJs: string, indent: number): string {
	if (branch.type !== 'functionLiteral') {
		throw new Error('branch is not a functionLiteral');
	}
	const { functionJs } = functionLiteralToJsParts(checkResult, branch.params, branch.body, indent);
	// Ein Typ-Kopf und () binden nichts, nur ein einzelner Parameter bekommt das Argument.
	const bindsArgument = branch.params.type === 'parameters'
		&& branch.params.singleFields.length === 1;
	return `(${functionJs})(${bindsArgument ? argumentJs : ''})`;
}

function branchTestToJs(test: BranchTest, argumentJs: string): string {
	switch (test.kind) {
		case 'always':
			return 'true';
		case 'never':
			return 'false';
		case 'jsKind':
			return test.kinds
				.map(kind => jsKindTestToJs(kind, argumentJs, test.negated))
				.join(test.negated ? ' && ' : ' || ');
		case 'literal':
			return `${argumentJs} === ${literalValueToJs(test.value)}`;
		case 'literals':
			return test.values
				.map(value => `${argumentJs} === ${literalValueToJs(value)}`)
				.join(' || ');
		case 'field':
			return `${argumentJs}?.[${stringToJs(test.name)}] === ${literalValueToJs(test.value)}`;
		case 'bound': {
			const compareJs = `${argumentJs} ${test.relation === 'greater' ? '>' : '<'} ${literalValueToJs(test.value)}`;
			return test.guarded
				? `(${test.jsKinds.length === 1 ? `typeof ${argumentJs} === '${test.jsKinds[0]}'` : `(${test.jsKinds.map(kind => `typeof ${argumentJs} === '${kind}'`).join(' || ')})`} && ${compareJs})`
				: compareJs;
		}
		case 'not':
			return `!(${branchTestToJs(test.test, argumentJs)})`;
		default: {
			const assertNever: never = test;
			throw new Error(`Unexpected BranchTest ${(assertNever as BranchTest).kind}`);
		}
	}
}

function jsKindTestToJs(kind: JsKind, argumentJs: string, negated: boolean): string {
	switch (kind) {
		case 'undefined':
			return `${argumentJs} ${negated ? '!==' : '==='} undefined`;
		case 'boolean':
		case 'bigint':
		case 'number':
		case 'string':
		case 'function':
			return `typeof ${argumentJs} ${negated ? '!==' : '==='} '${kind}'`;
		case 'array':
			return `${negated ? '!' : ''}Array.isArray(${argumentJs})`;
		case 'date':
		case 'blob':
		case 'error': {
			const instanceTestJs = `${argumentJs} instanceof ${kind === 'date' ? 'Date' : kind === 'blob' ? 'Blob' : 'Error'}`;
			return negated
				? `!(${instanceTestJs})`
				: instanceTestJs;
		}
		case 'object':
			// getBranchDispatch testet die Seite mit object nie direkt
			throw new Error('no exact test for object');
		default: {
			const assertNever: never = kind;
			throw new Error(`Unexpected JsKind ${assertNever}`);
		}
	}
}

function literalValueToJs(value: LiteralValue | undefined): string {
	switch (typeof value) {
		case 'bigint':
			return integerToJs(value);
		case 'string':
			return stringToJs(value);
		case 'undefined':
			return 'undefined';
		default:
			return String(value);
	}
}

//#endregion branching mit Typinformation

//#region benannte Argumente mit Typinformation

/**
 * Schreibt benannte Argumente als positionalen Aufruf: Die Namen stehen in Parameterreihenfolge
 * (der Checker prüft es, JUL2501), ein ausgelassener Parameter in der Mitte wird undefined, am Ende
 * entfällt er. Gilt für jede Funktion, deren Parameternamen der Checker kennt (JUL-Literal,
 * Builtin, Funktionswert, importierte Funktion mit Signatur).
 * Ein Argument ohne Parameter (eine verworfene Warnung) wird trotzdem ausgewertet: Steht ein
 * nicht-triviales davon im Aufruf, gehen alle Argumente in geschriebener Reihenfolge an ein Arrow,
 * das sie weiterreicht.
 */
function namedArgumentsToDirectCallJs(
	checkResult: CheckResult,
	parameterNames: string[] | undefined,
	functionJs: string,
	prefixArgument: SimpleExpression | undefined,
	args: ParseDictionaryLiteral,
	indent: number,
): string | undefined {
	if (!parameterNames) {
		return undefined;
	}
	// Das prefixArgument steht vorn und belegt den ersten Parameter. Ein benanntes Argument für
	// denselben Parameter ignoriert assignArgs, es fällt also weg.
	const written: { value: ParseValueExpression; parameterIndex: number; }[] = [];
	if (prefixArgument) {
		written.push({ value: prefixArgument, parameterIndex: 0 });
	}
	for (const field of args.fields) {
		if (field.type !== 'singleDictionaryField'
			|| !field.value) {
			return undefined;
		}
		const name = getCheckedEscapableName(field.name);
		if (name === undefined) {
			return undefined;
		}
		const parameterIndex = parameterNames.indexOf(name);
		written.push({
			value: field.value,
			parameterIndex: prefixArgument && !parameterIndex
				? -1
				: parameterIndex,
		});
	}
	const innerIndent = indent + 1;
	// Die Namen stehen in Parameterreihenfolge (der Checker prüft es), die Auswertung folgt also von
	// selbst der geschriebenen Reihenfolge. Nur ein Argument ohne Parameter muss trotzdem ausgewertet
	// werden und käme sonst ans Ende.
	const needsTemporaries = written.some(argument =>
		argument.parameterIndex < 0
		&& !isTrivialArgument(argument.value));
	const slotsJs: (string | undefined)[] = parameterNames.map(() => undefined);
	written.forEach((argument, index) => {
		if (argument.parameterIndex >= 0) {
			slotsJs[argument.parameterIndex] = needsTemporaries
				? `_arg${index}`
				: expressionToJs(checkResult, argument.value, innerIndent);
		}
	});
	// Fehlende Parameter am Ende brauchen kein undefined, JS füllt sie selbst auf.
	while (slotsJs.length
		&& slotsJs[slotsJs.length - 1] === undefined) {
		slotsJs.pop();
	}
	const argumentsJs = slotsJs.map(slotJs => slotJs ?? 'undefined');
	if (!needsTemporaries) {
		return `${functionJs}(${listValuesToJs(argumentsJs, indent)})`;
	}
	const temporariesJs = written.map((_, index) => `_arg${index}`).join(', ');
	const writtenJs = written.map(argument => expressionToJs(checkResult, argument.value, innerIndent));
	return `((${temporariesJs}) => ${functionJs}(${argumentsJs.join(', ')}))(${listValuesToJs(writtenJs, indent)})`;
}

/** Ohne Seiteneffekt, darf also in anderer Reihenfolge ausgewertet werden */
function isTrivialArgument(value: ParseValueExpression): boolean {
	switch (value.type) {
		case 'reference':
		case 'integer':
		case 'float':
		case 'fraction':
		case 'empty':
			return true;
		case 'text':
			return value.values.every(part => part.type === 'textToken');
		default:
			return false;
	}
}

//#endregion benannte Argumente mit Typinformation

function functionCallToJs(checkResult: CheckResult, expression: ParseFunctionCall, indent: number): string {
	const functionExpression = expression.functionExpression;
	if (!functionExpression) {
		throw new Error('functionExpression missing for functionCall.');
	}
	if (isImportFunction(functionExpression)) {
		// TODO dynamic import/parser error?
		throw new Error('import at unexpected location.');
		// const path = getPathFromImport(expression);
		// const outPath = path.endsWith(Extension.yaml)
		// 	? path + Extension.json
		// 	: path;
		// return `require("${outPath}")`;
	}
	const args = expression.arguments;
	const prefixArgument = expression.prefixArgument;
	const copyingBuiltinName = functionExpression.type === 'reference'
		&& copyingBuiltinNames.has(functionExpression.name.name)
		? functionExpression.name.name
		: undefined;
	const prefixArgJs = prefixArgument
		? copyingBuiltinName
			? countCopyJs(expressionToJs(checkResult, prefixArgument, indent), prefixArgument, expression, copyingBuiltinName)
			: expressionToJs(checkResult, prefixArgument, indent)
		: 'undefined';
	if (isNamedFunction(functionExpression, 'assume')) {
		switch (args?.type) {
			case 'list': {
				if (prefixArgument) {
					return assumeCallToJs(checkResult, expression, prefixArgument, prefixArgJs, args.values[0], indent);
				}
				const firstValue = args.values[0];
				if (firstValue.type === 'spread') {
					throw new Error('spread not implemented yet for assume');
				}
				else {
					return assumeCallToJs(checkResult, expression, firstValue, expressionToJs(checkResult, firstValue, indent), args.values[1], indent);
				}
			}
			default:
				throw new Error('unexpected arguments.type for assume functionCall: ' + args?.type);
		}
	}
	if (isNamedFunction(functionExpression, 'test')) {
		return testCallToJs(checkResult, expression, functionExpression, indent);
	}
	const shortCircuitJs = shortCircuitCallToJs(checkResult, expression, prefixArgJs, indent);
	if (shortCircuitJs !== undefined) {
		return shortCircuitJs;
	}
	const integerArithmeticJs = integerArithmeticCallToJs(checkResult, expression, prefixArgJs, indent);
	if (integerArithmeticJs !== undefined) {
		return integerArithmeticJs;
	}
	const functionJs = expressionToJs(checkResult, functionExpression, indent);
	const testCallName = expression === instrumentedTestCall
		&& functionExpression.type === 'reference'
		? functionExpression.name.name
		: undefined;
	if (testCallName !== undefined
		&& (args?.type === 'list' || args?.type === 'empty' || !args)) {
		return testCallToInstrumentedJs(checkResult, testCallName, functionJs, expression, indent);
	}
	const inlinedListJs = inlinedListCallToJs(checkResult, expression, prefixArgJs, indent);
	if (inlinedListJs !== undefined) {
		return inlinedListJs;
	}
	switch (args?.type) {
		case 'list': {
			const jsValues = parseListValuesToJs(checkResult, args.values, indent);
			const firstValue = args.values[0];
			if (prefixArgument) {
				jsValues.unshift(prefixArgJs);
			}
			else if (copyingBuiltinName
				&& firstValue.type !== 'spread') {
				jsValues[0] = countCopyJs(jsValues[0]!, firstValue, expression, copyingBuiltinName);
			}
			const valuesJs = listValuesToJs(jsValues, indent);
			return `${functionJs}(${valuesJs})`;
		}
		case 'object': {
			// Nur Spreads: eine List, wie f(1 ...values) (der Checker lässt nichts anderes zu).
			const jsValues = parseListValuesToJs(checkResult, args.values, indent);
			if (prefixArgument) {
				jsValues.unshift(prefixArgJs);
			}
			return `${functionJs}(${listValuesToJs(jsValues, indent)})`;
		}
		case 'dictionary': {
			const directCallJs = namedArgumentsToDirectCallJs(checkResult, getCalledParameterNames(checkResult, expression), functionJs, prefixArgument, args, indent);
			if (directCallJs) {
				return directCallJs;
			}
			// Ohne bekannte Parameterliste (Typ Any, JUL5011) gehen die Werte der Reihe nach an die Funktion,
			// die Namen entfallen.
			const jsArguments = args.fields.map(field => {
				if (field.type !== 'singleDictionaryField'
					|| !field.value) {
					throw new Error('unexpected field in named arguments.');
				}
				return expressionToJs(checkResult, field.value, indent + 1);
			});
			if (prefixArgument) {
				jsArguments.unshift(prefixArgJs);
			}
			return `${functionJs}(${listValuesToJs(jsArguments, indent)})`;
		}
		case undefined:
		case 'empty': {
			if (prefixArgument) {
				return `${functionJs}(${prefixArgJs})`;
			}
			return `${functionJs}()`;
		}
		default:
			throw new Error('unexpected arguments.type for functionCall: ' + args?.type);
	}
}

/**
 * Der Name der Typfunktion, wenn der Checker diesen Aufruf als ihre Anwendung auf sich selbst
 * markiert hat (Typ TypeOf(alias mit args)).
 */
function getSelfAppliedTypeFunctionName(checkResult: CheckResult, expression: ParseFunctionCall): string | undefined {
	const type = getTypeInfo(checkResult, expression)?.type;
	return type?.julType === 'typeOf'
		&& type.value.julType === 'alias'
		&& type.value.args
		? type.value.name
		: undefined;
}

//#region short circuit

/**
 * Ein Aufruf von and/or mit direkt aufgeführten Argumenten wird zu && bzw. ||, damit nach dem ersten
 * false bzw. true die übrigen Argumente nicht mehr ausgewertet werden. Bei Spread und bei benannten
 * Argumenten (und wenn die Funktion als Wert weitergereicht wird) bleibt es beim Funktionsaufruf, der
 * alle Argumente auswertet.
 */
function shortCircuitCallToJs(checkResult: CheckResult, expression: ParseFunctionCall, prefixArgJs: string, indent: number): string | undefined {
	const junction = getJunction(expression);
	if (!junction) {
		return undefined;
	}
	return junction.operands
		.map(operand => operandToJs(
			operand,
			operand === expression.prefixArgument
				? prefixArgJs
				: expressionToJs(checkResult, operand, indent)))
		.join(` ${junction.jsOperator} `);
}

/**
 * Klammert den Operanden, wenn er kein primärer Ausdruck ist (zum Beispiel ein verschachteltes
 * and/or oder eine Verzweigung). Referenzen, Zugriffe und normale Aufrufe brauchen keine Klammern.
 */
function operandToJs(operand: ParseExpression, operandJs: string): string {
	switch (operand.type) {
		case 'reference':
		case 'nestedReference':
			return operandJs;
		case 'functionCall':
			return getJunction(operand)
				? `(${operandJs})`
				: operandJs;
		default:
			return `(${operandJs})`;
	}
}

//#endregion short circuit

//#region Integer-Arithmetik

/**
 * Ein Integer-Literal in kanonischer Darstellung: number im sicheren Bereich, sonst bigint
 * (docs/backlog/integer-als-number.md).
 */
function integerToJs(value: bigint): string {
	return value <= maxSafeBigInt && value >= -maxSafeBigInt
		? `${value}`
		: `${value}n`;
}

const maxSafeBigInt = BigInt(Number.MAX_SAFE_INTEGER);

const integerArithmeticOperators: { readonly [functionName: string]: { helperJs: string; minOperands: number; maxOperands: number; } | undefined; } = {
	add: { helperJs: '_addInteger', minOperands: 1, maxOperands: Infinity },
	multiply: { helperJs: '_multiplyInteger', minOperands: 1, maxOperands: Infinity },
	subtract: { helperJs: '_subtractInteger', minOperands: 2, maxOperands: 2 },
};

/**
 * add, subtract und multiply sind in der Runtime generisch über Rational (Integer oder Fraction), add und multiply
 * variadisch. Sind alle Operanden laut Typ Integer, genügt der Integer-Helfer der Runtime (_addInteger usw.): Er
 * rechnet im sicheren Bereich mit number und weicht nur bei Überlauf auf bigint aus
 * (docs/backlog/integer-als-number.md, Stufen 1 und 2). Variadische Aufrufe werden linksassoziativ verschachtelt.
 * Nur mit Typinformation, bei Spread und benannten Argumenten bleibt es beim Aufruf. Builtins lassen sich nicht
 * überdecken (JUL3203), der Name genügt.
 */
function integerArithmeticCallToJs(checkResult: CheckResult, expression: ParseFunctionCall, prefixArgJs: string, indent: number): string | undefined {
	if (!useTypeInfo) {
		return undefined;
	}
	const functionExpression = expression.functionExpression;
	const args = expression.arguments;
	if (functionExpression?.type !== 'reference') {
		return undefined;
	}
	const operator = integerArithmeticOperators[functionExpression.name.name];
	if (!operator) {
		return undefined;
	}
	let values: ParseValueExpression[];
	switch (args?.type) {
		case 'list':
			if (args.values.some(value => value.type === 'spread')) {
				return undefined;
			}
			values = args.values as ParseValueExpression[];
			break;
		case undefined:
		case 'empty':
			values = [];
			break;
		default:
			return undefined;
	}
	const operands = expression.prefixArgument
		? [expression.prefixArgument, ...values]
		: values;
	if (operands.length < operator.minOperands
		|| operands.length > operator.maxOperands
		|| !operands.every(operand => isIntegerTyped(checkResult, operand))) {
		return undefined;
	}
	const emitted = operands.map((operand): EmittedIntegerOperand => {
		const js = operand === expression.prefixArgument
			? prefixArgJs
			: expressionToJs(checkResult, operand, indent);
		return {
			js: js,
			isPrimary: operand.type === 'reference'
				|| operand.type === 'nestedReference'
				|| /^-?\d+n?$/.test(js),
			bounds: getExpressionIntegerBounds(checkResult, operand),
		};
	});
	return emitted.reduce((accumulator, operand) => integerOperationToJs(operator, accumulator, operand)).js;
}

interface EmittedIntegerOperand {
	js: string;
	/** Braucht als Operand von + - * keine Klammern. */
	isPrimary: boolean;
	bounds: IntegerBounds;
}

/**
 * Eine Rechnung mit zwei Operanden. Liegen beide Operanden und das Ergebnis laut Bereich sicher im sicheren Bereich,
 * sind beide number und das Ergebnis ist es auch: dann der JS-Operator ohne Prüfung (Stufe 3), sonst der Helfer.
 */
function integerOperationToJs(
	operator: { helperJs: string; },
	left: EmittedIntegerOperand,
	right: EmittedIntegerOperand,
): EmittedIntegerOperand {
	const bounds = getIntegerOperationBounds(operator.helperJs, left.bounds, right.bounds);
	if (!isSafeIntegerBounds(left.bounds)
		|| !isSafeIntegerBounds(right.bounds)
		|| !isSafeIntegerBounds(bounds)) {
		return {
			js: `${operator.helperJs}(${left.js}, ${right.js})`,
			isPrimary: true,
			bounds: bounds,
		};
	}
	const leftJs = left.isPrimary ? left.js : `(${left.js})`;
	const rightJs = right.isPrimary ? right.js : `(${right.js})`;
	switch (operator.helperJs) {
		case '_addInteger':
			return { js: `(${leftJs} + ${rightJs})`, isPrimary: true, bounds: bounds };
		case '_subtractInteger':
			return { js: `(${leftJs} - ${rightJs})`, isPrimary: true, bounds: bounds };
		case '_multiplyInteger':
			// 0 * -5 ergibt in JS -0, die Invariante kennt nur 0. + 0 macht daraus 0.
			return {
				js: mayProduceNegativeZero(left.bounds, right.bounds)
					? `(${leftJs} * ${rightJs} + 0)`
					: `(${leftJs} * ${rightJs})`,
				isPrimary: true,
				bounds: bounds,
			};
		default:
			throw new Error('unexpected integer helper: ' + operator.helperJs);
	}
}

/**
 * Die Grenzen eines Integer-Ausdrucks laut Typ, beide inklusive, undefined = offen oder nicht ablesbar
 * (docs/backlog/integer-als-number.md, Stufe 3).
 */
interface IntegerBounds {
	min?: bigint;
	max?: bigint;
}

function getExpressionIntegerBounds(checkResult: CheckResult, expression: ParseExpression): IntegerBounds {
	const typeInfo = getTypeInfo(checkResult, expression);
	return typeInfo
		? getIntegerBounds(resolvePlaceholders(typeInfo.type), new Set())
		: {};
}

/** JS-Arrays und -Strings haben höchstens 2^32 - 1 Elemente. */
const maxJsLength = 4294967295n;

/**
 * Wie getIntegerMinimum/getIntegerMaximum der Typ-Algebra, aber mit Grenzen, deren Wert selbst ein Typ mit Bereich
 * ist (Not(GreaterInteger(length(values))) im Index von map), und mit der Obergrenze einer Länge im JS-Target. Die
 * gehört nicht in die Typ-Algebra: Sie hängt vom Target ab und stünde sonst in jedem angezeigten Typ.
 * Betrachtet nur die ganzen Zahlen des Typs: Der Aufrufer weiß schon, dass der Ausdruck ein Integer ist.
 */
function getIntegerBounds(rawType: CompileTimeType, visiting: Set<CompileTimeType>): IntegerBounds {
	if (visiting.has(rawType)) {
		return {};
	}
	visiting.add(rawType);
	const bounds = getIntegerBoundsUnguarded(resolveAlias(rawType), visiting);
	visiting.delete(rawType);
	return bounds;
}

function getIntegerBoundsUnguarded(type: CompileTimeType, visiting: Set<CompileTimeType>): IntegerBounds {
	switch (type.julType) {
		case 'integerLiteral':
			return { min: type.value, max: type.value };
		case 'bound': {
			if (type.Family !== 'integer') {
				return {};
			}
			// x > V ≥ m heißt x ≥ m + 1, x < V ≤ n heißt x ≤ n - 1.
			const valueBounds = getIntegerBounds(type.Value, visiting);
			return type.Relation === 'greater'
				? { min: addBound(valueBounds.min, 1n) }
				: { max: addBound(valueBounds.max, -1n) };
		}
		case 'not': {
			const source = resolveAlias(type.SourceType);
			if (source.julType !== 'bound'
				|| source.Family !== 'integer') {
				return {};
			}
			const valueBounds = getIntegerBounds(source.Value, visiting);
			return source.Relation === 'greater'
				? { max: valueBounds.max }
				: { min: valueBounds.min };
		}
		case 'lengthOf':
			return { min: type.Offset, max: maxJsLength + type.Offset };
		case 'and': {
			const result: IntegerBounds = {};
			for (const choiceType of type.ChoiceTypes) {
				const choiceBounds = getIntegerBounds(choiceType, visiting);
				if (choiceBounds.min !== undefined
					&& (result.min === undefined || choiceBounds.min > result.min)) {
					result.min = choiceBounds.min;
				}
				if (choiceBounds.max !== undefined
					&& (result.max === undefined || choiceBounds.max < result.max)) {
					result.max = choiceBounds.max;
				}
			}
			return result;
		}
		case 'or': {
			let min: bigint | undefined;
			let max: bigint | undefined;
			let first = true;
			for (const choiceType of type.ChoiceTypes) {
				const choiceBounds = getIntegerBounds(choiceType, visiting);
				if (first) {
					min = choiceBounds.min;
					max = choiceBounds.max;
					first = false;
					continue;
				}
				min = min === undefined || choiceBounds.min === undefined
					? undefined
					: choiceBounds.min < min ? choiceBounds.min : min;
				max = max === undefined || choiceBounds.max === undefined
					? undefined
					: choiceBounds.max > max ? choiceBounds.max : max;
			}
			return { min: min, max: max };
		}
		default:
			return {};
	}
}

function addBound(bound: bigint | undefined, offset: bigint): bigint | undefined {
	return bound === undefined
		? undefined
		: bound + offset;
}

function getIntegerOperationBounds(helperJs: string, left: IntegerBounds, right: IntegerBounds): IntegerBounds {
	switch (helperJs) {
		case '_addInteger':
			return {
				min: left.min !== undefined && right.min !== undefined ? left.min + right.min : undefined,
				max: left.max !== undefined && right.max !== undefined ? left.max + right.max : undefined,
			};
		case '_subtractInteger':
			return {
				min: left.min !== undefined && right.max !== undefined ? left.min - right.max : undefined,
				max: left.max !== undefined && right.min !== undefined ? left.max - right.min : undefined,
			};
		case '_multiplyInteger': {
			if (left.min === undefined
				|| left.max === undefined
				|| right.min === undefined
				|| right.max === undefined) {
				return {};
			}
			const products = [
				left.min * right.min,
				left.min * right.max,
				left.max * right.min,
				left.max * right.max,
			];
			return {
				min: products.reduce((first, second) => second < first ? second : first),
				max: products.reduce((first, second) => second > first ? second : first),
			};
		}
		default:
			return {};
	}
}

function isSafeIntegerBounds(bounds: IntegerBounds): boolean {
	return bounds.min !== undefined
		&& bounds.max !== undefined
		&& bounds.min >= -maxSafeBigInt
		&& bounds.max <= maxSafeBigInt;
}

/** Ein Produkt ist -0, wenn ein Faktor 0 und der andere negativ ist. Nur mit bekannten Grenzen aufrufen. */
function mayProduceNegativeZero(left: IntegerBounds, right: IntegerBounds): boolean {
	const containsZero = (bounds: IntegerBounds) => bounds.min! <= 0n && bounds.max! >= 0n;
	return (containsZero(left) && right.min! < 0n)
		|| (containsZero(right) && left.min! < 0n);
}

/** Laut Typ sicher ein Integer. Any und unbekannte Typen zählen nicht: Die Teilmengenprüfung ist für Any permissiv. */
function isIntegerTyped(checkResult: CheckResult, expression: ParseExpression): boolean {
	const typeInfo = getTypeInfo(checkResult, expression);
	if (!typeInfo) {
		return false;
	}
	const type = resolvePlaceholders(typeInfo.type);
	return !containsAnyType(type, new Set())
		&& isSubtypeOf(type, builtinInteger) === true;
}

function containsAnyType(rawType: CompileTimeType, visited: Set<CompileTimeType>): boolean {
	if (visited.has(rawType)) {
		return false;
	}
	visited.add(rawType);
	const type = resolveAlias(rawType);
	switch (type.julType) {
		case 'any':
		case 'invalid':
			return true;
		case 'or':
		case 'and':
			return type.ChoiceTypes.some(choiceType => containsAnyType(choiceType, visited));
		default:
			return false;
	}
}

//#endregion Integer-Arithmetik

//#region inlined list functions

/** Was ein Parameter des Callbacks bekommt */
type InlinedListParameter = 'accumulator' | 'value' | 'index';

/**
 * Wie eine Listenfunktion als Schleife aussieht: `init` steht vor der Schleife, `step` bekommt den
 * Ausdruck der letzten Anweisung des Callbacks und `finish` steht danach. Ist die Liste empty, liefert
 * die Funktion `emptyResult`, wie die Runtime-Implementierung.
 */
interface InlinedListFunction {
	/** Die Parameter des Callbacks der Reihe nach, ein Literal darf weniger nehmen */
	readonly parameters: readonly InlinedListParameter[];
	/** Argumente zwischen der Liste und dem Callback (bei aggregate: der Typ und der Startwert) */
	readonly extraArgumentCount: number;
	/** Welches der Zusatzargumente der Startwert des Akkumulators ist */
	readonly initialValueArgument?: number;
	readonly emptyResult: string;
	readonly init: string[];
	readonly step: (lastJs: string, delimiterJs: string) => string;
	readonly finish: string[];
}

const inlinedListFunctions: { readonly [functionName: string]: InlinedListFunction | undefined; } = {
	exists: {
		parameters: ['value', 'index'],
		extraArgumentCount: 0,
		emptyResult: 'false',
		init: [],
		step: (lastJs, delimiterJs) => `if (${lastJs}) {${delimiterJs}\treturn true;${delimiterJs}}`,
		finish: ['return false;'],
	},
	all: {
		parameters: ['value', 'index'],
		extraArgumentCount: 0,
		emptyResult: 'true',
		init: [],
		step: (lastJs, delimiterJs) => `if (!(${lastJs})) {${delimiterJs}\treturn false;${delimiterJs}}`,
		finish: ['return true;'],
	},
	findFirst: {
		parameters: ['value', 'index'],
		extraArgumentCount: 0,
		emptyResult: 'undefined',
		init: [],
		step: (lastJs, delimiterJs) => `if (${lastJs}) {${delimiterJs}\treturn _listValues[_listIndex];${delimiterJs}}`,
		finish: ['return undefined;'],
	},
	filter: {
		parameters: ['value', 'index'],
		extraArgumentCount: 0,
		emptyResult: 'undefined',
		init: ['const _listResult = [];'],
		step: (lastJs, delimiterJs) => `if (${lastJs}) {${delimiterJs}\t_listResult.push(_listValues[_listIndex]);${delimiterJs}}`,
		finish: ['return _listResult.length ? _listResult : undefined;'],
	},
	map: {
		parameters: ['value', 'index'],
		extraArgumentCount: 0,
		emptyResult: 'undefined',
		init: ['const _listResult = [];'],
		step: lastJs => `_listResult.push(${lastJs});`,
		finish: ['return _listResult.length ? _listResult : undefined;'],
	},
	filterMap: {
		parameters: ['value', 'index'],
		extraArgumentCount: 0,
		emptyResult: 'undefined',
		init: ['const _listResult = [];'],
		step: (lastJs, delimiterJs) => `const _listMapped = ${lastJs};${delimiterJs}if (_listMapped !== undefined) {${delimiterJs}\t_listResult.push(_listMapped);${delimiterJs}}`,
		finish: ['return _listResult.length ? _listResult : undefined;'],
	},
	aggregate: {
		parameters: ['accumulator', 'value', 'index'],
		extraArgumentCount: 2,
		initialValueArgument: 1,
		emptyResult: '_listAccumulator',
		init: [],
		step: lastJs => `_listAccumulator = ${lastJs};`,
		finish: ['return _listAccumulator;'],
	},
};

const inlinedListParameterJs: { readonly [parameter in InlinedListParameter]: string; } = {
	accumulator: '_listAccumulator',
	value: '_listValues[_listIndex]',
	index: '(_listIndex + 1)',
};

/**
 * Ein Aufruf einer Listenfunktion mit einem Funktionsliteral als Callback wird zu einer Schleife an
 * der Aufrufstelle: keine Closure je Aufruf, und der Index entsteht nur, wenn das Literal ihn als
 * Parameter nimmt. Der Name allein genügt, weil core-lib-Namen nicht überschrieben werden können.
 * Alles andere (Callback als Wert, Typ-Guards, Rest, Spread, benannte Argumente) bleibt beim
 * Funktionsaufruf.
 */
function inlinedListCallToJs(checkResult: CheckResult, expression: ParseFunctionCall, prefixArgJs: string, indent: number): string | undefined {
	const functionExpression = expression.functionExpression;
	const args = expression.arguments;
	if (functionExpression?.type !== 'reference'
		|| args?.type !== 'list'
		|| args.values.some(value => value.type === 'spread')) {
		return undefined;
	}
	const inlined = inlinedListFunctions[functionExpression.name.name];
	if (inlined === undefined) {
		return undefined;
	}
	const hasPrefix = !!expression.prefixArgument;
	const values = args.values as ParseValueExpression[];
	if (values.length !== (hasPrefix ? 0 : 1) + inlined.extraArgumentCount + 1) {
		return undefined;
	}
	const callback = values[values.length - 1]!;
	if (callback.type !== 'functionLiteral'
		|| callback.params.type !== 'parameters'
		|| callback.params.rest
		|| callback.params.singleFields.length > inlined.parameters.length
		|| callback.params.singleFields.some(field => field.typeGuard)
		|| !callback.body.length
		|| callback.body[callback.body.length - 1]!.type === 'definition') {
		return undefined;
	}
	const listOffset = hasPrefix ? 0 : 1;
	const valuesJs = hasPrefix
		? prefixArgJs
		: expressionToJs(checkResult, values[0]!, indent + 1);
	const delimiterJs = getRowDelimiterJs(indent + 2);
	const bodyIndent = indent + 3;
	const bodyDelimiterJs = getRowDelimiterJs(bodyIndent);
	const bindings = callback.params.singleFields
		.map((field, index) => field.name.name === discardName
			? undefined
			: `const ${escapeReservedJsVariableName(field.name.name)} = ${inlinedListParameterJs[inlined.parameters[index]!]};`)
		.filter(isDefined);
	const body = callback.body;
	const statements = body.slice(0, -1).map(statement => sourcePositionMarkerJs(statement) + expressionToJs(checkResult, statement, bodyIndent));
	const last = body[body.length - 1]!;
	statements.push(`${sourcePositionMarkerJs(last)}${inlined.step(expressionToJs(checkResult, last, bodyIndent), bodyDelimiterJs)}`);
	const header = [`const _listValues = ${valuesJs};`];
	if (inlined.initialValueArgument !== undefined) {
		const initialValue = values[listOffset + inlined.initialValueArgument]!;
		header.push(`let _listAccumulator = ${expressionToJs(checkResult, initialValue, indent + 1)};`);
	}
	header.push(`if (!_listValues) {${bodyDelimiterJs}return ${inlined.emptyResult};${delimiterJs}}`, ...inlined.init);
	const loop = `for (let _listIndex = 0; _listIndex < _listValues.length; _listIndex++) {${bodyDelimiterJs}${[...bindings, ...statements].join(bodyDelimiterJs)}${delimiterJs}}`;
	return `(() => {${delimiterJs}${[...header, loop, ...inlined.finish].join(delimiterJs)}${getRowDelimiterJs(indent + 1)}})()`;
}

//#endregion inlined list functions

function referenceToJs(reference: ParseReference): string {
	const name = reference.name.name;
	const nameJs = escapeReservedJsVariableName(name);
	// Die Selbstreferenz eines rekursiven Typs würde ausgewertet, bevor die Konstante fertig ist.
	return isEvaluatedDuringOwnDefinition(reference, name)
		? `_lazyType(${stringToJs(name)}, () => ${nameJs})`
		: nameJs;
}

/**
 * Steht die Referenz im Wert der Definition dieses Namens, ohne Funktionsliteral dazwischen? Ein
 * Funktionsrumpf läuft erst beim Aufruf, bis dahin ist die Definition fertig.
 */
function isEvaluatedDuringOwnDefinition(reference: ParseReference, name: string): boolean {
	let current: PositionedExpression | undefined = reference.parent;
	while (current) {
		switch (current.type) {
			case 'functionLiteral':
				return false;
			case 'definition':
				if (current.name.name === name) {
					return true;
				}
				break;
			default:
				break;
		}
		current = current.parent;
	}
	return false;
}

function parametersToJs(checkResult: CheckResult, parameters: ParseParameterFields, indent: number): string {
	const innerIndent = indent + 1;
	const innerIndent2 = indent + 2;
	const innerIndent3 = indent + 3;
	const parametersFieldsJs: string[] = [];
	if (parameters.singleFields.length) {
		const singleNamesValuesJs = parameters.singleFields.map(field => {
			const fieldsJs: string[] = [singleDictionaryFieldToJsInternal('name', stringToJs(field.name.name))];
			if (field.source) {
				fieldsJs.push(singleDictionaryFieldToJsInternal('source', stringToJs(field.source.name)));
			}
			if (field.typeGuard) {
				fieldsJs.push(singleDictionaryFieldToJsInternal('type', expressionToJs(checkResult, field.typeGuard, innerIndent3)));
			}
			return dictionaryToJs(fieldsJs, innerIndent2);
		});
		const singleNamesJs = listToJs(singleNamesValuesJs, innerIndent);
		parametersFieldsJs.push(singleDictionaryFieldToJsInternal('singleNames', singleNamesJs));
	}
	if (parameters.rest) {
		const restFieldsJs: string[] = [];
		if (parameters.rest.typeGuard) {
			restFieldsJs.push(singleDictionaryFieldToJsInternal('type', expressionToJs(checkResult, parameters.rest.typeGuard, innerIndent2)));
		}
		const restJs = dictionaryToJs(restFieldsJs, innerIndent);
		parametersFieldsJs.push(singleDictionaryFieldToJsInternal('rest', restJs));
	}
	return dictionaryToJs(parametersFieldsJs, indent);
}

function textLiteralToJs(checkResult: CheckResult, stringLiteral: ParseTextLiteral, indent: number): string {
	const stringValue = stringLiteral.values.map(value => {
		if (value.type === 'textToken') {
			return escapeStringForBacktickJs(value.value);
		}
		return `\${${expressionToJs(checkResult, value, indent)}}`;
	}).join('');
	return `\`${stringValue}\``;
}

function dictionaryToJs(fieldsJs: string[], indent: number): string {
	return `{${listValuesToJs(fieldsJs, indent)}}`;
}

function singleDictionaryFieldToJs(
	name: ParseValueExpression | Name,
	valueJs: string,
): string {
	const checkedName = getCheckedEscapableName(name);
	if (checkedName === undefined) {
		throw new Error('checkedName mising for DictionaryField');
	}
	return singleDictionaryFieldToJsInternal(stringToJs(checkedName), valueJs);
}

function singleDictionaryFieldToJsInternal(
	nameJs: string,
	valueJs: string,
): string {
	return `${nameJs}: ${valueJs}`;
}

function spreadDictionaryFieldToJs(valueJs: string): string {
	return `...${valueJs}`;
}

/**
 * Mit JUL_COUNT_COPIES=1 beim Build läuft die Quelle jeder Kopierstelle durch einen Zähler, den
 * scripts/count-copies.mjs setzt. Messinstrument für docs/backlog/inplace-mutationen.md.
 */
function countCopyJs(valueJs: string, source: ParseExpression, copyExpression: ParseExpression, kind: string): string {
	if (!countCopies
		|| !useTypeInfo) {
		return valueJs;
	}
	const category = classifyCopySource(source, copyExpression);
	const site = `${sourceFilePath}:${copyExpression.startRowIndex + 1}:${kind}:${category}`;
	return `globalThis._julCountCopy(${stringToJs(site)}, ${valueJs})`;
}

function escapeStringForBacktickJs(value: string): string {
	return escapeSourceMapMarkers(value
		.replaceAll('\\', '\\\\')
		.replaceAll('`', '\\`'));
}

function escapeStringForSingleQuoteJs(value: string): string {
	return escapeSourceMapMarkers(value
		.replaceAll('\\', '\\\\')
		.replaceAll('\'', '\\\''));
}

/**
 * Nach dem Escapen der Backslashes, sonst würde der Backslash der Escape-Sequenz verdoppelt.
 */
function escapeSourceMapMarkers(escapedValue: string): string {
	return escapedValue
		.replaceAll(markerStart, '\\u0001')
		.replaceAll(markerEnd, '\\u0002');
}

function stringToJs(value: string): string {
	return `'${escapeStringForSingleQuoteJs(value)}'`;
}

//#region assume

/**
 * assume ist die Identität. Unter jul test (checkAssumes) prüft es seine Behauptung, aber nur so weit,
 * wie der statische Typ des Werts sie offen lässt: Bei Or([] GameCard) und Ziel GameCard reicht
 * value !== undefined (getAssumeTest). Nur wenn der statische Typ nichts hergibt, prüft
 * _checkAssume den ganzen Typ. Ein Zieltyp, der von einem Parameter abhängt, wird nicht geprüft:
 * Sein emittierter Ausdruck ist zur Laufzeit kein verlässlicher Typwert.
 */
function assumeCallToJs(
	checkResult: CheckResult,
	call: ParseFunctionCall,
	valueExpression: ParseValueExpression,
	valueJs: string,
	typeExpression: ParseListValue | undefined,
	indent: number,
): string {
	if (!checkAssumes
		|| !typeExpression
		|| typeExpression.type === 'spread') {
		return valueJs;
	}
	const valueType = getTypeInfo(checkResult, valueExpression)?.type;
	const rawTargetType = getTypeInfo(checkResult, typeExpression)?.type;
	if (!valueType
		|| !rawTargetType) {
		return valueJs;
	}
	const targetType = valueOf(rawTargetType);
	if (targetType.julType === 'any'
		|| hasArgumentSubstitution(targetType)) {
		return valueJs;
	}
	const test = getAssumeTest(valueType, targetType);
	if (test?.kind === 'always') {
		return valueJs;
	}
	const siteJs = [
		stringToJs(sourceFilePath),
		String(call.startRowIndex + 1),
		String(call.startColumnIndex + 1),
		// Einzeilig: Der Text steht in einem String-Literal ohne Zeilenumbruch.
		stringToJs(typeToString(targetType, 0, 1).replace(/\s*\n\s*/g, ' ')),
	];
	return test
		? `_checkAssumeTest(${listValuesToJs([valueJs, `(_v) => ${branchTestToJs(test, '_v')}`, ...siteJs], indent)})`
		: `_checkAssume(${listValuesToJs([valueJs, expressionToJs(checkResult, typeExpression, indent + 1), ...siteJs], indent)})`;
}

//#endregion assume

//#region test

/**
 * Immer positionell und mit der Stelle des Aufrufs als drittem Argument, auch wenn die Argumente
 * benannt geschrieben sind.
 */
function testCallToJs(checkResult: CheckResult, call: ParseFunctionCall, functionExpression: SimpleExpression, indent: number): string {
	const { name, callback } = getTestArguments(call);
	const previousInstrumentedCall = instrumentedTestCall;
	instrumentedTestCall = callback.type === 'functionLiteral'
		? last(callback.body)
		: undefined;
	try {
		const innerIndent = indent + 1;
		const locationJs = `{ file: ${stringToJs(sourceFilePath)}, row: ${call.startRowIndex + 1}, column: ${call.startColumnIndex + 1} }`;
		const valuesJs = listValuesToJs(
			[expressionToJs(checkResult, name, innerIndent), expressionToJs(checkResult, callback, innerIndent), locationJs],
			indent);
		return `${expressionToJs(checkResult, functionExpression, indent)}(${valuesJs})`;
	}
	finally {
		instrumentedTestCall = previousInstrumentedCall;
	}
}

function getTestArguments(call: ParseFunctionCall): { name: ParseValueExpression; callback: ParseValueExpression; } {
	const { name, callback } = getTestCallArguments(call);
	if (!name || !callback) {
		throw new Error('arguments missing for test');
	}
	return { name, callback };
}

/**
 * Der äußerste Aufruf im Callback, mit Listenargumenten. Die Argumente stehen als Array eine
 * Ebene tiefer als bei einem direkten Aufruf.
 */
function testCallToInstrumentedJs(checkResult: CheckResult, name: string, functionJs: string, call: ParseFunctionCall, indent: number): string {
	const valuesIndent = indent + 1;
	const jsValues = call.arguments?.type === 'list'
		? parseListValuesToJs(checkResult, call.arguments.values, valuesIndent)
		: [];
	if (call.prefixArgument) {
		jsValues.unshift(expressionToJs(checkResult, call.prefixArgument, valuesIndent + 1));
	}
	const argsJs = `[${listValuesToJs(jsValues, valuesIndent)}]`;
	return `_testCall(${listValuesToJs([stringToJs(name), functionJs, argsJs], indent)})`;
}

//#endregion test

function callCreateFunctionJs(functionJs: string, paramsJs: string, indent: number): string {
	const argsJs = listValuesToJs([functionJs, paramsJs], indent);
	return `_createFunction(${argsJs})`;
}

function getRowDelimiterJs(indent: number): string {
	return '\n' + '\t'.repeat(indent);
}