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
	forEachChild,
} from '../syntax-tree.js';
import { Positioned } from '../compiler-errors.js';
import * as runtime from '../runtime/runtime.js';
import * as testRuntime from '../runtime/test-runtime.js';
import { Extension, NonEmptyArray, changeExtension, escapeReservedJsVariableName, isTestFilePath, last } from '../util.js';
import { extname, isAbsolute } from 'path';
import { getPathExpression, isImportFunction, isImportFunctionCall, isNamedFunction } from '../parser/parser.js';
import { getCheckedEscapableName, getTestCallArguments } from '../parser/parser-utils.js';
import { BranchDispatch, BranchTest, getBranchDispatch, JsKind, LiteralValue } from '../checker/branch-dispatch.js';
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
): string {
	return syntaxTreeToJsWithMappings(expressions, runtimeImportPath, filePath, testRuntimeImportPath).js;
}

/**
 * Wie syntaxTreeToJs, dazu je Statement (Top-Level-Ausdruck, Ausdruck in einem Funktionsrumpf) die
 * Zuordnung seines Anfangs zur Quellposition, für die Source Map, und die importierten
 * Runtime-Namen, aus denen der Compiler die verkleinerte Runtime erzeugt (shakeRuntime).
 */
export function syntaxTreeToJsWithMappings(
	expressions: ParseExpression[],
	runtimeImportPath: string,
	filePath: string = '',
	testRuntimeImportPath: string = '',
): { js: string; mappings: SourceMapping[]; runtimeNames: string[]; } {
	let hasDefinition = false;
	useTypeInfo = true;
	emitSourcePositions = true;
	sourceFilePath = filePath;
	try {
		const bodyJs = expressions.map((expression, index) => {
			const expressionJs = expressionToJs(expression, 0, true);
			if (expression.type === 'definition') {
				hasDefinition = true;
			}
			const markerJs = sourcePositionMarkerJs(expression);
			// default export = last expression
			if (index === expressions.length - 1
				&& !hasDefinition) {
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
export function functionLiteralToEvaluableJs(literal: ParseFunctionLiteral): string {
	const indent = 1;
	const { functionJs, paramsJs, delimiterJs } = functionLiteralToJsParts(literal.params, literal.body, indent);
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
				? getBranchDispatch(expression)
				: undefined;
			if (dispatch) {
				return branchDispatchToJs(expression, dispatch, indent);
			}
			const innerIndent = indent + 1;
			const jsValues = [
				expressionToJs(args, innerIndent),
				...expression.branches.map(branch => expressionToJs(branch, innerIndent)),
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
				const isJson = importPath.endsWith(Extension.json);
				const importJs = getImportJs(`${isJson ? '' : '* as '}${aliasJs}`, importPath);
				const valueJs = isJson
					? aliasJs
					// default export automatisch liefern, wenn vorhanden (value import)
					: `${aliasJs}.default ?? ${aliasJs}`;
				return `${importJs}
${getDefinitionJs(topLevel, nameJs, valueJs)}`;
			}
			const valueJs = expressionToJs(value, indent);
			return getDefinitionJs(topLevel, nameJs, valueJs);
		}
		case 'destructuring': {
			const fields = expression.fields.fields;
			const value = expression.value;
			if (!value) {
				throw new Error('value missing in destructuring');
			}
			if (isImportFunctionCall(value)) {
				const importPath = getPathFromImport(value);
				return getImportJs(`{${fields.map(field => {
					const name = field.name.name;
					const nameJs = escapeReservedJsVariableName(name);
					const source = field.source?.name;
					return source
						? `${escapeReservedJsVariableName(source)} as ${nameJs}`
						: nameJs;
				}).join(', ')}}`, importPath);
			}
			// TODO spread
			const delimiterJs = getRowDelimiterJs(indent);
			const declarations = fields.map(field => {
				const name = getCheckedEscapableName(field.name);
				return `let ${name && escapeReservedJsVariableName(name)};`;
			}).join(delimiterJs);
			const assignments = fields.map((singleName, index) => {
				const { name, source } = singleName;
				const nameString = name.name;
				const sourceString = source?.name ?? nameString;
				const nameJs = escapeReservedJsVariableName(nameString);
				const sourceJs = escapeReservedJsVariableName(sourceString);
				const valueJs = `_isArray ? _temp[${index}] : _temp.${sourceJs}`;
				return `${nameJs} = ${valueJs};`;
			}).join(delimiterJs);
			return `${declarations}${delimiterJs}{${delimiterJs}const _temp = ${expressionToJs(value, indent)};${delimiterJs}const _isArray = Array.isArray(_temp);${delimiterJs}${assignments}${delimiterJs}}`;
		}
		case 'dictionary': {
			const newIndent = indent + 1;
			// TODO mit Object.create(null), damit leerer prototype? Oder Persistent Data Structure?
			return dictionaryToJs(expression.fields.map(field => {
				if (!field.value) {
					throw new Error('value missing for dictionary field');
				}
				const valueJs = expressionToJs(field.value, newIndent);
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
						? expressionToJs(field.typeGuard, fieldsIndent)
						: 'Any';
					// Ein Feld, das fehlen darf (b?: X), trägt das Kennzeichen am Typ des Felds.
					return singleDictionaryFieldToJs(field.name, field.optional ? `_optionalField(${typeGuardJs})` : typeGuardJs);
				}
				else {
					// Der gespreadete Wert ist selbst ein Typobjekt, übernommen werden seine Fields.
					return spreadDictionaryFieldToJs(`${expressionToJs(field.value, fieldsIndent)}.Fields`);
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
			return `{numerator:${expression.numerator}n,denominator:${expression.denominator}n}`;
		case 'functionCall': {
			const callJs = functionCallToJs(expression, indent);
			// Der Checker hat den Aufruf einer Typfunktion im eigenen Rumpf als Anwendung markiert. Sofort
			// ausgewertet riefe jeder Aufruf von Tree den nächsten auf. Entschieden wird am geprüften
			// Baum, nicht an useTypeInfo: das schaltet Optimierungen, hier geht es um Korrektheit.
			const selfAppliedName = getSelfAppliedTypeFunctionName(expression);
			return selfAppliedName === undefined
				? callJs
				: `_lazyType(${stringToJs(selfAppliedName)}, () => ${callJs})`;
		}
		case 'functionLiteral': {
			const parent = expression.parent;
			const isNamed = parent?.type === 'definition'
				&& expression === parent.value;
			const tail = useTypeInfo && isNamed
				? analyzeTailCalls(expression, parent.name.name)
				: undefined;
			const { functionJs, paramsJs, delimiterJs } = functionLiteralToJsParts(expression.params, expression.body, indent, tail);
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
			return `${expression.value}n`;
		case 'list': {
			const jsValues = parseListValuesToJs(expression.values, indent, expression);
			return listToJs(jsValues, indent);
		}
		case 'nestedReference': {
			const nestedKey = expression.nestedKey;
			if (!nestedKey) {
				throw new Error('Missing nestedKey in nestedReference.');
			}
			switch (nestedKey.type) {
				case 'index':
					return `${expressionToJs(expression.source, indent)}?.[${nestedKey.name} - 1]`;
				case 'name':
				case 'text':
					const field = getCheckedEscapableName(nestedKey);
					if (!field) {
						throw new Error(`Invalid field.`);
					}
					return `${expressionToJs(expression.source, indent)}?.[${stringToJs(field)}]`;
				default: {
					const assertNever: never = nestedKey;
					throw new Error(`Unexpected nestedKey.type ${(assertNever as ParseExpression).type}`);
				}
			}
		}
		case 'object': {
			return `_combineObject(${expression.values.map(value => {
				return expressionToJs(value.value, indent);
			}).join(`,${getRowDelimiterJs(indent)}`)})`;
		}
		case 'reference':
			return referenceToJs(expression);
		case 'text':
			return textLiteralToJs(expression, indent);
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
function parseListValuesToJs(values: NonEmptyArray<ParseListValue>, indent: number, listLiteral?: ParseExpression): string[] {
	const innerIndent = indent + 1;
	const jsValues = values.map(value => {
		const valueJs = value.type === 'spread'
			? `...${listLiteral
				? countCopyJs(expressionToJs(value.value, innerIndent), value.value, listLiteral, 'listSpread')
				: expressionToJs(value.value, innerIndent)} ?? []`
			: expressionToJs(value, innerIndent);
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

function getImportJs(importedJs: string, path: string): string {
	const isJson = path.endsWith(Extension.json);
	const pathWithFileScheme = (isAbsolute(path) ? 'file://' : '') + path;
	return `import ${importedJs} from ${stringToJs(pathWithFileScheme)}${isJson ? ' with { type: \'json\' }' : ''};\n`;
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

function functionBodyToJs(expressions: ParseExpression[], indent: number, tail?: TailContext): string {
	const delimiter = getRowDelimiterJs(indent);
	const js = delimiter + expressions.map((expression, index) => {
		const markerJs = sourcePositionMarkerJs(expression);
		// Die letzte Expression ist der Rückgabewert
		if (index === expressions.length - 1) {
			if (tail
				&& (expression.type === 'functionCall' || expression.type === 'branching')
				&& (tail.calls.has(expression as ParseFunctionCall) || tail.branchings.has(expression as ParseBranching))) {
				return `${markerJs}${tailExpressionToJs(expression, indent, tail)}`;
			}
			const expressionJs = expressionToJs(expression, indent);
			if (expression.type === 'definition') {
				return `${markerJs}${expressionJs}${delimiter}return ${escapeReservedJsVariableName(expression.name.name)};`;
			}
			return `${markerJs}return ${expressionJs}`;
		}
		return markerJs + expressionToJs(expression, indent);
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
	params: SimpleExpression | ParseParameterFields,
	body: ParseExpression[],
	indent: number,
	tail?: TailContext,
): { functionJs: string; paramsJs: string; delimiterJs: string; } {
	let argsJs: string;
	let paramsJs: string;
	if (params.type === 'parameters') {
		argsJs = params.singleFields.map(field => escapeReservedJsVariableName(field.name.name)).join(', ');
		const rest = params.rest;
		if (rest) {
			argsJs += (argsJs ? ', ' : '') + '...' + escapeReservedJsVariableName(rest.name.name);
		}
		paramsJs = parametersToJs(params, indent);
	}
	else {
		argsJs = '';
		// Ein Listenliteral, dem der Checker einen Tupeltyp gegeben hat, ist eine Parameterliste ohne
		// Namen (siehe createUnnamedParametersType): Positionen unter head. Jeder andere Kopf ist ein
		// Typ und beschreibt die ganze Argumentkollektion. Ohne Typinfo (ungeprüfter Baum) bleibt es
		// ein Typ-Kopf.
		const isPositionalHead = params.type === 'list'
			&& params.typeInfo?.type.julType === 'tuple';
		const headFieldJs = singleDictionaryFieldToJsInternal(isPositionalHead ? 'head' : 'type', expressionToJs(params, indent));
		paramsJs = dictionaryToJs([headFieldJs], indent);
	}
	const delimiterJs = getRowDelimiterJs(indent + 1);
	const functionJs = tail
		? `(${argsJs}) => {${getRowDelimiterJs(indent + 2)}while (true) {${functionBodyToJs(body, indent + 3, tail)}${getRowDelimiterJs(indent + 2)}}${delimiterJs}}`
		: `(${argsJs}) => {${functionBodyToJs(body, indent + 2)}${delimiterJs}}`;
	return { functionJs, paramsJs, delimiterJs };
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
function analyzeTailCalls(literal: ParseFunctionLiteral, name: string): TailContext | undefined {
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
			if (!isTailSelfCall(expression, name, parameterNames.length)) {
				return false;
			}
			calls.add(expression);
			return true;
		}
		if (expression?.type !== 'branching') {
			return false;
		}
		const dispatch = getBranchDispatch(expression);
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
		paramNamesJs: parameterNames.map(escapeReservedJsVariableName),
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
		|| getSelfAppliedTypeFunctionName(call) !== undefined) {
		return false;
	}
	return true;
}

/** Die Anweisungen für eine Expression in Tail-Position, die in tail.calls oder tail.branchings steht */
function tailExpressionToJs(expression: ParseExpression, indent: number, tail: TailContext): string {
	if (expression.type === 'functionCall') {
		const values = (expression.arguments as { values: ParseValueExpression[]; }).values
			.map(value => expressionToJs(value, indent + 1));
		// Das führende ; schützt vor einer Fortsetzung der vorigen Zeile (kein Semikolon nach Aufrufen)
		const assignmentJs = values.length === 1
			? `${tail.paramNamesJs[0]} = ${values[0]};`
			: `;[${tail.paramNamesJs.join(', ')}] = [${values.join(', ')}];`;
		return `${assignmentJs}${getRowDelimiterJs(indent)}continue;`;
	}
	const branching = expression as ParseBranching;
	const dispatch = getBranchDispatch(branching)!;
	const argument = (branching.args as { values: ParseListValue[]; }).values[0] as ParseValueExpression;
	const isReference = argument.type === 'reference';
	const argumentJs = isReference
		? referenceToJs(argument)
		: '_arg';
	const delimiterJs = getRowDelimiterJs(indent);
	let js = isReference
		? ''
		: `const _arg = ${expressionToJs(argument, indent)};${delimiterJs}`;
	let hasCatchAll = false;
	const chainJs: string[] = [];
	dispatch.tests.forEach((test, index) => {
		if (test.kind === 'never') {
			return;
		}
		const branch = branching.branches[index] as ParseFunctionLiteral;
		const bindsArgument = branch.params.type === 'parameters'
			&& branch.params.singleFields.length === 1;
		const bindingJs = bindsArgument
			? `${getRowDelimiterJs(indent + 1)}const ${escapeReservedJsVariableName((branch.params as ParseParameterFields).singleFields[0]!.name.name)} = ${argumentJs};`
			: '';
		const blockJs = `{${bindingJs}${functionBodyToJs(branch.body, indent + 1, tail)}${delimiterJs}}`;
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
function branchDispatchToJs(branching: ParseBranching, dispatch: BranchDispatch, indent: number): string {
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
		const callJs = branchCallToJs(branching.branches[index]!, argumentJs, chainIndent);
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
		: `((${argumentJs}) => ${chainJs})(${expressionToJs(argument, indent)})`;
}

function branchCallToJs(branch: ParseValueExpression, argumentJs: string, indent: number): string {
	if (branch.type !== 'functionLiteral') {
		throw new Error('branch is not a functionLiteral');
	}
	const { functionJs } = functionLiteralToJsParts(branch.params, branch.body, indent);
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
			return `${value}n`;
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
				: expressionToJs(argument.value, innerIndent);
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
	const writtenJs = written.map(argument => expressionToJs(argument.value, innerIndent));
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

function functionCallToJs(expression: ParseFunctionCall, indent: number): string {
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
			? countCopyJs(expressionToJs(prefixArgument, indent), prefixArgument, expression, copyingBuiltinName)
			: expressionToJs(prefixArgument, indent)
		: 'undefined';
	if (isNamedFunction(functionExpression, 'assume')) {
		if (prefixArgument) {
			return prefixArgJs;
		}
		switch (args?.type) {
			case 'list': {
				const firstValue = args.values[0];
				if (firstValue.type === 'spread') {
					throw new Error('spread not implemented yet for assume');
				}
				else {
					return expressionToJs(firstValue, indent);
				}
			}
			default:
				throw new Error('unexpected arguments.type for assume functionCall: ' + args?.type);
		}
	}
	if (isNamedFunction(functionExpression, 'test')) {
		return testCallToJs(expression, functionExpression, indent);
	}
	const shortCircuitJs = shortCircuitCallToJs(expression, prefixArgJs, indent);
	if (shortCircuitJs !== undefined) {
		return shortCircuitJs;
	}
	const functionJs = expressionToJs(functionExpression, indent);
	const testCallName = expression === instrumentedTestCall
		&& functionExpression.type === 'reference'
		? functionExpression.name.name
		: undefined;
	if (testCallName !== undefined
		&& (args?.type === 'list' || args?.type === 'empty' || !args)) {
		return testCallToInstrumentedJs(testCallName, functionJs, expression, indent);
	}
	const inlinedListJs = inlinedListCallToJs(expression, prefixArgJs, indent);
	if (inlinedListJs !== undefined) {
		return inlinedListJs;
	}
	switch (args?.type) {
		case 'list': {
			const jsValues = parseListValuesToJs(args.values, indent);
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
			const jsValues = parseListValuesToJs(args.values, indent);
			if (prefixArgument) {
				jsValues.unshift(prefixArgJs);
			}
			return `${functionJs}(${listValuesToJs(jsValues, indent)})`;
		}
		case 'dictionary': {
			const directCallJs = namedArgumentsToDirectCallJs(expression.calledParameterNames, functionJs, prefixArgument, args, indent);
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
				return expressionToJs(field.value, indent + 1);
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
function getSelfAppliedTypeFunctionName(expression: ParseFunctionCall): string | undefined {
	const type = expression.typeInfo?.type;
	return type?.julType === 'typeOf'
		&& type.value.julType === 'alias'
		&& type.value.args
		? type.value.name
		: undefined;
}

//#region short circuit

const shortCircuitOperators: { readonly [functionName: string]: string | undefined; } = {
	and: '&&',
	or: '||',
};

/**
 * Ein Aufruf von and/or mit direkt aufgeführten Argumenten wird zu && bzw. ||, damit nach dem ersten
 * false bzw. true die übrigen Argumente nicht mehr ausgewertet werden. Bei Spread und bei benannten
 * Argumenten (und wenn die Funktion als Wert weitergereicht wird) bleibt es beim Funktionsaufruf, der
 * alle Argumente auswertet. Der Name allein genügt, weil and/or nicht überschrieben werden können.
 */
function shortCircuitCallToJs(expression: ParseFunctionCall, prefixArgJs: string, indent: number): string | undefined {
	const functionExpression = expression.functionExpression;
	const args = expression.arguments;
	if (functionExpression?.type !== 'reference'
		|| args?.type !== 'list') {
		return undefined;
	}
	const operator = shortCircuitOperators[functionExpression.name.name];
	if (operator === undefined) {
		return undefined;
	}
	const operands: string[] = [];
	if (expression.prefixArgument) {
		operands.push(operandToJs(expression.prefixArgument, prefixArgJs));
	}
	for (const value of args.values) {
		if (value.type === 'spread') {
			return undefined;
		}
		operands.push(operandToJs(value, expressionToJs(value, indent)));
	}
	return operands.join(` ${operator} `);
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
			return operand.functionExpression?.type === 'reference'
				&& shortCircuitOperators[operand.functionExpression.name.name] !== undefined
				&& operand.arguments?.type === 'list'
				&& !operand.arguments.values.some(value => value.type === 'spread')
				? `(${operandJs})`
				: operandJs;
		default:
			return `(${operandJs})`;
	}
}

//#endregion short circuit

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
	index: 'BigInt(_listIndex + 1)',
};

/**
 * Ein Aufruf einer Listenfunktion mit einem Funktionsliteral als Callback wird zu einer Schleife an
 * der Aufrufstelle: keine Closure je Aufruf, und der Index entsteht nur, wenn das Literal ihn als
 * Parameter nimmt. Der Name allein genügt, weil core-lib-Namen nicht überschrieben werden können.
 * Alles andere (Callback als Wert, Typ-Guards, Rest, Spread, benannte Argumente) bleibt beim
 * Funktionsaufruf.
 */
function inlinedListCallToJs(expression: ParseFunctionCall, prefixArgJs: string, indent: number): string | undefined {
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
		: expressionToJs(values[0]!, indent + 1);
	const delimiterJs = getRowDelimiterJs(indent + 2);
	const bodyIndent = indent + 3;
	const bodyDelimiterJs = getRowDelimiterJs(bodyIndent);
	const bindings = callback.params.singleFields.map((field, index) =>
		`const ${escapeReservedJsVariableName(field.name.name)} = ${inlinedListParameterJs[inlined.parameters[index]!]};`);
	const body = callback.body;
	const statements = body.slice(0, -1).map(statement => sourcePositionMarkerJs(statement) + expressionToJs(statement, bodyIndent));
	const last = body[body.length - 1]!;
	statements.push(`${sourcePositionMarkerJs(last)}${inlined.step(expressionToJs(last, bodyIndent), bodyDelimiterJs)}`);
	const header = [`const _listValues = ${valuesJs};`];
	if (inlined.initialValueArgument !== undefined) {
		const initialValue = values[listOffset + inlined.initialValueArgument]!;
		header.push(`let _listAccumulator = ${expressionToJs(initialValue, indent + 1)};`);
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

function parametersToJs(parameters: ParseParameterFields, indent: number): string {
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
				fieldsJs.push(singleDictionaryFieldToJsInternal('type', expressionToJs(field.typeGuard, innerIndent3)));
			}
			return dictionaryToJs(fieldsJs, innerIndent2);
		});
		const singleNamesJs = listToJs(singleNamesValuesJs, innerIndent);
		parametersFieldsJs.push(singleDictionaryFieldToJsInternal('singleNames', singleNamesJs));
	}
	if (parameters.rest) {
		const restFieldsJs: string[] = [];
		if (parameters.rest.typeGuard) {
			restFieldsJs.push(singleDictionaryFieldToJsInternal('type', expressionToJs(parameters.rest.typeGuard, innerIndent2)));
		}
		const restJs = dictionaryToJs(restFieldsJs, innerIndent);
		parametersFieldsJs.push(singleDictionaryFieldToJsInternal('rest', restJs));
	}
	return dictionaryToJs(parametersFieldsJs, indent);
}

function textLiteralToJs(stringLiteral: ParseTextLiteral, indent: number): string {
	const stringValue = stringLiteral.values.map(value => {
		if (value.type === 'textToken') {
			return escapeStringForBacktickJs(value.value);
		}
		return `\${${expressionToJs(value, indent)}}`;
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

//#region test

/**
 * Immer positionell und mit der Stelle des Aufrufs als drittem Argument, auch wenn die Argumente
 * benannt geschrieben sind.
 */
function testCallToJs(call: ParseFunctionCall, functionExpression: SimpleExpression, indent: number): string {
	const { name, callback } = getTestArguments(call);
	const previousInstrumentedCall = instrumentedTestCall;
	instrumentedTestCall = callback.type === 'functionLiteral'
		? last(callback.body)
		: undefined;
	try {
		const innerIndent = indent + 1;
		const locationJs = `{ file: ${stringToJs(sourceFilePath)}, row: ${call.startRowIndex + 1}, column: ${call.startColumnIndex + 1} }`;
		const valuesJs = listValuesToJs(
			[expressionToJs(name, innerIndent), expressionToJs(callback, innerIndent), locationJs],
			indent);
		return `${expressionToJs(functionExpression, indent)}(${valuesJs})`;
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
function testCallToInstrumentedJs(name: string, functionJs: string, call: ParseFunctionCall, indent: number): string {
	const valuesIndent = indent + 1;
	const jsValues = call.arguments?.type === 'list'
		? parseListValuesToJs(call.arguments.values, valuesIndent)
		: [];
	if (call.prefixArgument) {
		jsValues.unshift(expressionToJs(call.prefixArgument, valuesIndent + 1));
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