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
	SimpleExpression,
} from './syntax-tree.js';
import * as runtime from './runtime.js';
import * as testRuntime from './test-runtime.js';
import { Extension, NonEmptyArray, changeExtension, escapeReservedJsVariableName, isTestFilePath, last } from './util.js';
import { dirname, extname, isAbsolute, join } from 'path';
import { getPathExpression, isImportFunction, isImportFunctionCall, isNamedFunction } from './parser/parser.js';
import { getCheckedEscapableName } from './parser/parser-utils.js';
import { BranchDispatch, BranchTest, getBranchDispatch, JsKind, LiteralValue } from './checker/branch-dispatch.js';
import { isFunctionType, resolveAlias, resolvePlaceholders } from './checker/checker.js';

const runtimeKeys = Object.keys(runtime);
const runtimeImports = runtimeKeys.join(', ');
const testRuntimeImports = Object.keys(testRuntime).join(', ');
const testRuntimeFileName = 'test-runtime.js';
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

export function getRuntimeImportJs(runtimePath: string): string {
	return getImportJs(`{ ${runtimeImports} }`, runtimePath);
}

/**
 * Nur *.test.jul-Dateien importieren die Test-Runtime. Sie liegt neben der Runtime, so wie beide
 * im Compiler nebeneinander liegen.
 */
export function getTestRuntimeImportJs(runtimePath: string): string {
	return getImportJs(`{ ${testRuntimeImports} }`, join(dirname(runtimePath), testRuntimeFileName));
}

// TODO nur benutzte builtins importieren? minimale runtime erzeugen/bundling mit treeshaking?
export function syntaxTreeToJs(
	expressions: ParseExpression[],
	runtimePath: string,
	/**
	 * Wie er in Meldungen erscheinen soll. Nur für test-Aufrufe gebraucht.
	 */
	filePath: string = '',
): string {
	// _branch, _callFunction, _createFunction, log
	let hasDefinition = false;
	useTypeInfo = true;
	sourceFilePath = filePath;
	try {
		const testRuntimeImportJs = isTestFilePath(filePath)
			? getTestRuntimeImportJs(runtimePath)
			: '';
		return `${getRuntimeImportJs(runtimePath)}${testRuntimeImportJs}${expressions.map((expression, index) => {
			const expressionJs = expressionToJs(expression, 0, true);
			if (expression.type === 'definition') {
				hasDefinition = true;
			}
			// default export = last expression
			if (index === expressions.length - 1
				&& !hasDefinition) {
				return `export default ${expressionJs}`;
			}
			return expressionJs;
		}).join('\n')}`;
	}
	finally {
		useTypeInfo = false;
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
					return spreadDictionaryFieldToJs(valueJs);
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
					return singleDictionaryFieldToJs(field.name, typeGuardJs);
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
			const prefixArgJs = prefixArgument
				? expressionToJs(prefixArgument, indent)
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
			const functionJs = expressionToJs(functionExpression, indent);
			const testCallName = expression === instrumentedTestCall
				&& functionExpression.type === 'reference'
				? functionExpression.name.name
				: undefined;
			if (testCallName !== undefined
				&& (args?.type === 'list' || args?.type === 'empty' || !args)) {
				return testCallToInstrumentedJs(testCallName, functionJs, expression, indent);
			}
			switch (args?.type) {
				case 'list': {
					const jsValues = parseListValuesToJs(args.values, indent);
					if (prefixArgument) {
						jsValues.unshift(prefixArgJs);
					}
					const valuesJs = listValuesToJs(jsValues, indent);
					return `${functionJs}(${valuesJs})`;
				}
				case 'object':
				case 'dictionary': {
					const directCallJs = useTypeInfo
						&& args.type === 'dictionary'
						? namedArgumentsToDirectCallJs(functionExpression, functionJs, prefixArgument, args, indent)
						: undefined;
					if (directCallJs) {
						return directCallJs;
					}
					const argsJs = expressionToJs(args, indent);
					const jsValues = [functionJs, prefixArgJs, argsJs];
					const valuesJs = listValuesToJs(jsValues, indent);
					return `_callFunction(${valuesJs})`;
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
		case 'functionLiteral': {
			const { functionJs, paramsJs, delimiterJs } = functionLiteralToJsParts(expression.params, expression.body, indent);
			const parent = expression.parent;
			if (parent?.type === 'definition'
				&& expression === parent.value) {
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
			const jsValues = parseListValuesToJs(expression.values, indent);
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
		case 'object':
			return `_combineObject(${expression.values.map(value => {
				return expressionToJs(value.value, indent);
			}).join(`,${getRowDelimiterJs(indent)}`)})`;
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

function parseListValuesToJs(values: NonEmptyArray<ParseListValue>, indent: number): string[] {
	const innerIndent = indent + 1;
	const jsValues = values.map(value => {
		const valueJs = value.type === 'spread'
			? `...${expressionToJs(value.value, innerIndent)} ?? []`
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

function functionBodyToJs(expressions: ParseExpression[], indent: number): string {
	const delimiter = getRowDelimiterJs(indent);
	const js = delimiter + expressions.map((expression, index) => {
		const expressionJs = expressionToJs(expression, indent);
		// Die letzte Expression ist der Rückgabewert
		if (index === expressions.length - 1) {
			if (expression.type === 'definition') {
				return `${expressionJs}${delimiter}return ${escapeReservedJsVariableName(expression.name.name)};`;
			}
			return `return ${expressionJs}`;
		}
		return expressionJs;
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
		const typeFieldJs = singleDictionaryFieldToJsInternal('type', expressionToJs(params, indent));
		paramsJs = dictionaryToJs([typeFieldJs], indent);
	}
	const delimiterJs = getRowDelimiterJs(indent + 1);
	const functionJs = `(${argsJs}) => {${functionBodyToJs(body, indent + 2)}${delimiterJs}}`;
	return { functionJs, paramsJs, delimiterJs };
}

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

function literalValueToJs(value: LiteralValue): string {
	switch (typeof value) {
		case 'bigint':
			return `${value}n`;
		case 'string':
			return stringToJs(value);
		default:
			return String(value);
	}
}

//#endregion branching mit Typinformation

//#region benannte Argumente mit Typinformation

/**
 * Ordnet benannte Argumente schon beim Emittieren den Parametern zu, statt zur Laufzeit über
 * _callFunction/assignArgs. Nur, wenn die aufgerufene Funktion nachweislich ein JUL-Literal ist:
 * eine nativeFunction bekommt von _callFunction das Dictionary selbst.
 * Die Auswertung bleibt in geschriebener Reihenfolge. Müssten dafür nicht-triviale Argumente die
 * Reihenfolge tauschen oder fiele eines weg, werden alle Argumente in geschriebener Reihenfolge an
 * ein Arrow übergeben, das sie in Parameterreihenfolge weiterreicht.
 */
function namedArgumentsToDirectCallJs(
	functionExpression: SimpleExpression,
	functionJs: string,
	prefixArgument: SimpleExpression | undefined,
	args: ParseDictionaryLiteral,
	indent: number,
): string | undefined {
	const parameterNames = getLiteralParameterNames(functionExpression);
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
	const nonTrivial = written.filter(argument => !isTrivialArgument(argument.value));
	const needsTemporaries = nonTrivial.some((argument, index) =>
		argument.parameterIndex < 0
		|| (index && argument.parameterIndex < nonTrivial[index - 1]!.parameterIndex));
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

/**
 * Die Namen, unter denen die Laufzeit benannte Argumente zuordnet (source ?? name, wie
 * assignArgs). undefined, wenn die Funktion kein JUL-Literal mit einfacher Parameterliste ist.
 * literal am Funktionstyp ist nur bei Funktionsliteralen aus .jul gesetzt, und das Symbol behält
 * den Typ des Werts.
 */
function getLiteralParameterNames(functionExpression: SimpleExpression): string[] | undefined {
	if (functionExpression.type !== 'reference'
		|| !functionExpression.typeInfo) {
		return undefined;
	}
	const functionType = resolveAlias(resolvePlaceholders(functionExpression.typeInfo.type));
	if (!isFunctionType(functionType)
		|| !functionType.literal) {
		return undefined;
	}
	const params = functionType.literal.params;
	if (params.type !== 'parameters'
		|| params.rest) {
		return undefined;
	}
	return params.singleFields.map(field => field.source ?? field.name.name);
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

function referenceToJs(reference: ParseReference): string {
	const name = reference.name.name;
	return escapeReservedJsVariableName(name);
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
				fieldsJs.push(singleDictionaryFieldToJsInternal('source', stringToJs(field.source)));
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

function escapeStringForBacktickJs(value: string): string {
	return value
		.replaceAll('\\', '\\\\')
		.replaceAll('`', '\\`');
}

function escapeStringForSingleQuoteJs(value: string): string {
	return value
		.replaceAll('\\', '\\\\')
		.replaceAll('\'', '\\\'');
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
	const args = call.arguments;
	if (args?.type === 'dictionary') {
		const getField = (fieldName: string) => {
			const field = args.fields.find(field =>
				field.type === 'singleDictionaryField'
				&& getCheckedEscapableName(field.name) === fieldName);
			if (!field?.value) {
				throw new Error(`argument ${fieldName} missing for test`);
			}
			return field.value;
		};
		return { name: getField('name'), callback: getField('callback') };
	}
	const values: ParseValueExpression[] = call.prefixArgument
		? [call.prefixArgument]
		: [];
	if (args?.type === 'list') {
		args.values.forEach(value => {
			if (value.type === 'spread') {
				throw new Error('spread not implemented yet for test');
			}
			values.push(value);
		});
	}
	const [name, callback] = values;
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