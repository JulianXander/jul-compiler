import {
	Name,
	ParseExpression,
	ParseFunctionCall,
	ParseListValue,
	ParseParameterFields,
	ParseTextLiteral,
	ParseValueExpression,
	ParseReference,
} from './syntax-tree.js';
import * as runtime from './runtime.js';
import { Extension, NonEmptyArray, changeExtension } from './util.js';
import { extname, isAbsolute } from 'path';
import { getPathExpression, isImportFunction, isImportFunctionCall, isNamedFunction } from './parser/parser.js';
import { getCheckedEscapableName } from './parser/parser-utils.js';

const runtimeKeys = Object.keys(runtime);
const runtimeImports = runtimeKeys.join(', ');

export function getRuntimeImportJs(runtimePath: string): string {
	return getImportJs(`{ ${runtimeImports} }`, runtimePath);
}

// TODO nur benutzte builtins importieren? minimale runtime erzeugen/bundling mit treeshaking?
export function syntaxTreeToJs(expressions: ParseExpression[], runtimePath: string): string {
	// _branch, _callFunction, _createFunction, log
	let hasDefinition = false;
	return `${getRuntimeImportJs(runtimePath)}${expressions.map((expression, index) => {
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
			const delimiterJs = getRowDelimiterJs(indent);
			return `_branch(${delimiterJs}${expressionToJs(expression.value, indent)},${delimiterJs}${expression.branches.map(branch =>
				expressionToJs(branch, indent)).join(`,${delimiterJs}`)},${delimiterJs})`;
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
				// TODO export
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
					return spreadDictionaryFieldToJs(expressionToJs(field.value, fieldsIndent));
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
			if (isNamedFunction(functionExpression, 'assume')) {
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
			const functionJs = expressionToJs(functionExpression, indent);
			const prefixArgJs = expression.prefixArgument
				? expressionToJs(expression.prefixArgument, indent)
				: 'undefined';
			switch (args?.type) {
				case 'list': {
					const jsValues = parseListValuesToJs(args.values, indent);
					if (expression.prefixArgument) {
						jsValues.unshift(prefixArgJs);
					}
					const valuesJs = listValuesToJs(jsValues, indent);
					return `${functionJs}(${valuesJs})`;
				}
				case 'object':
				case 'dictionary': {
					const argsJs = expressionToJs(args, indent);
					const jsValues = [functionJs, prefixArgJs, argsJs];
					const valuesJs = listValuesToJs(jsValues, indent);
					return `_callFunction(${valuesJs})`;
				}
				case undefined:
				case 'empty': {
					if (expression.prefixArgument) {
						return `${functionJs}(${prefixArgJs})`;
					}
					return `${functionJs}()`;
				}
				default:
					throw new Error('unexpected arguments.type for functionCall: ' + args?.type);
			}
		}
		case 'functionLiteral': {
			const params = expression.params;
			let argsJs: string;
			let paramsJs: string;
			if (params.type === 'parameters') {
				argsJs = params.singleFields.map(field => escapeReservedJsVariableName(field.name.name)).join(', ');
				const rest = params.rest;
				if (rest) {
					argsJs += '...' + escapeReservedJsVariableName(rest.name.name);
				}
				paramsJs = parametersToJs(params, indent);
			}
			else {
				argsJs = '';
				const typeFieldJs = singleDictionaryFieldToJsInternal('type', expressionToJs(params, indent));
				paramsJs = dictionaryToJs([typeFieldJs], indent);
			}
			const delimiterJs = getRowDelimiterJs(indent + 1);
			const functionJs = `(${argsJs}) => {${functionBodyToJs(expression.body, indent + 2)}${delimiterJs}}`;
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
		case 'bracketed':
		case 'field': {
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
	return `import ${importedJs} from ${stringToJs(pathWithFileScheme)}${isJson ? ' assert { type: \'json\' }' : ''};\n`;
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

function referenceToJs(reference: ParseReference): string {
	const name = reference.name.name;
	return escapeReservedJsVariableName(name);
}

const reservedJsNames: string[] = [
	'abstract',
	'arguments',
	'await',
	'abstract',
	'boolean',
	'break',
	'byte',
	'case',
	'catch',
	'case',
	'char',
	'case',
	'class',
	'const',
	'continue',
	'debugger',
	'default',
	'delete',
	'do',
	'double',
	'else',
	'enum',
	'eval',
	'export',
	'extends',
	'final',
	'finally',
	'float',
	'for',
	'function',
	'goto',
	'if',
	'implements',
	'import',
	'in',
	'instanceof',
	'int',
	'interface',
	'let',
	'long',
	'native',
	'new',
	'null',
	'package',
	'private',
	'protected',
	'public',
	'return',
	'short',
	'static',
	'super',
	'switch',
	'synchronized',
	'this',
	'throw',
	'throws',
	'transient',
	'try',
	'typeof',
	'var',
	'void',
	'volatile',
	'while',
	'with',
	'yield',

	'Blob',
	'Boolean',
	'Error',
	'String',
	'Text',
];
function escapeReservedJsVariableName(name: string): string {
	if (reservedJsNames.includes(name)) {
		return '_' + name;
	}
	return name;
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

function callCreateFunctionJs(functionJs: string, paramsJs: string, indent: number): string {
	const argsJs = listValuesToJs([functionJs, paramsJs], indent);
	return `_createFunction(${argsJs})`;
}

function getRowDelimiterJs(indent: number): string {
	return '\n' + '\t'.repeat(indent);
}