import {
	Name,
	ParseExpression,
	ParseFunctionCall,
	ParseParameterFields,
	ParseTextLiteral,
	ParseValueExpression,
	ParseValueExpressionBase,
	Reference,
} from './syntax-tree.js';
import * as runtime from './runtime.js';
import { Extension, changeExtension } from './util.js';
import { extname, isAbsolute } from 'path';
import { getCheckedName } from './checker.js';
import { getPathExpression, isImportFunction, isImportFunctionCall } from './parser/parser.js';
import { getCheckedEscapableName } from './parser/parser-utils.js';

const runtimeKeys = Object.keys(runtime);
const runtimeImports = runtimeKeys.join(', ');

export function getRuntimeImportJs(runtimePath: string): string {
	return getImportJs(`{ ${runtimeImports} }`, runtimePath);
}

// TODO nur benutzte builtins importieren? minimale runtime erzeugen/bundling mit treeshaking?
export function syntaxTreeToJs(expressions: ParseExpression[], runtimePath: string): string {
	// _branch, _callFunction, _checkType, _createFunction, log
	let hasDefinition = false;
	return `${getRuntimeImportJs(runtimePath)}${expressions.map((expression, index) => {
		const expressionJs = expressionToJs(expression, true);
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

function expressionToJs(expression: ParseExpression, topLevel: boolean = false): string {
	switch (expression.type) {
		case 'branching':
			return `_branch(\n${expressionToJs(expression.value)},\n${expression.branches.map(branch =>
				expressionToJs(branch)).join(',\n')},\n)`;
		case 'definition': {
			// export topLevel definitions
			const value = expression.value;
			if (!value) {
				throw new Error('value missing in definition');
			}
			const nameJs = escapeReservedJsVariableName(expression.name.name);
			const typeGuard = expression.typeGuard;
			if (isImportFunctionCall(value)) {
				const importPath = getPathFromImport(value);
				// const useDefinitionLine = typeGuard || topLevel;
				const aliasJs = `_${nameJs}`;
				const isJson = importPath.endsWith(Extension.json);
				const importJs = getImportJs(`${isJson ? '' : '* as '}${aliasJs}`, importPath);
				const valueJs = isJson
					? aliasJs
					// default export automatisch liefern, wenn vorhanden (value import)
					: `${aliasJs}.default ?? ${aliasJs}`;
				const checkedValueJs = typeGuard
					? checkTypeJs(typeGuard, valueJs)
					: valueJs;
				return `${importJs}
${getDefinitionJs(topLevel, nameJs, checkedValueJs)}`;
			}
			const valueJs = expressionToJs(value);
			const checkedValueJs = typeGuard
				? checkTypeJs(typeGuard, valueJs)
				: valueJs;
			return getDefinitionJs(topLevel, nameJs, checkedValueJs);
		}
		case 'destructuring': {
			const fields = expression.fields.fields;
			const value = expression.value;
			if (!value) {
				throw new Error('value missing in destructuring');
			}
			if (isImportFunctionCall(value)) {
				const importPath = getPathFromImport(value);
				// TODO export, typeGuard, fallback
				return getImportJs(`{${fields.map(field => {
					const name = getCheckedName(field.name);
					const nameJs = name && escapeReservedJsVariableName(name);
					const source = field.assignedValue;
					const checkedSource = source && getCheckedName(source);
					return checkedSource
						? `${escapeReservedJsVariableName(checkedSource)} as ${nameJs}`
						: nameJs;
				}).join(', ')}}`, importPath);
			}
			// TODO rest

			const declarations = fields.map(field => {
				const name = getCheckedEscapableName(field.name);
				return `let ${name && escapeReservedJsVariableName(name)};`;
			}).join('\n');
			const assignments = fields.map((singleName, index) => {
				const { name, assignedValue, fallback, typeGuard } = singleName;
				const checkedName = getCheckedName(name);
				const checkedSource = (assignedValue && getCheckedName(assignedValue)) ?? checkedName;
				const nameJs = checkedName && escapeReservedJsVariableName(checkedName);
				const sourceJs = checkedSource && escapeReservedJsVariableName(checkedSource);
				const fallbackJs = fallback ? ` ?? ${expressionToJs(fallback)}` : '';
				const rawValue = `_isArray ? _temp[${index}] : _temp.${sourceJs}${fallbackJs}`;
				const checkedValue = typeGuard
					? `_checkType(${expressionToJs(typeGuard)}, ${rawValue})`
					: rawValue;
				return `${nameJs} = ${checkedValue};`;
			}).join('\n');
			return `${declarations}\n{\nconst _temp = ${expressionToJs(value)};\nconst _isArray = Array.isArray(_temp);\n${assignments}\n}`;
		}
		case 'dictionary':
			// TODO mit Object.create(null), damit leerer prototype? Oder Persistent Data Structure?
			return dictionaryToJs(expression.fields.map(field => {
				if (!field.value) {
					throw new Error('value missing for dictionary field');
				}
				const valueJs = expressionToJs(field.value);
				if (field.type === 'singleDictionaryField') {
					return singleDictionaryFieldToJs(field.name, field.typeGuard ? checkTypeJs(field.typeGuard, valueJs) : valueJs);
				}
				else {
					return spreadDictionaryFieldToJs(valueJs);
				}
			}));
		case 'dictionaryType':
			return `new DictionaryLiteralType(${dictionaryToJs(expression.fields.map(field => {
				if (field.type === 'singleDictionaryTypeField') {
					const typeGuardJs = field.typeGuard
						? expressionToJs(field.typeGuard)
						: 'Any';
					return singleDictionaryFieldToJs(field.name, typeGuardJs);
				}
				else {
					return spreadDictionaryFieldToJs(expressionToJs(field.value));
				}
			}))})`;
		case 'empty':
			return 'null';
		case 'float':
			return '' + expression.value;
		case 'fraction':
			return `{numerator:${expression.numerator}n,denominator:${expression.denominator}n}`;
		case 'functionCall': {
			const functionExpression = expression.functionExpression;
			if (isImportFunction(functionExpression)) {
				// TODO dynamic import/parser error?
				throw new Error('import at unexpected location.');
				// const path = getPathFromImport(expression);
				// const outPath = path.endsWith(Extension.yaml)
				// 	? path + Extension.json
				// 	: path;
				// return `require("${outPath}")`;
			}
			const functionJs = functionExpression && expressionToJs(functionExpression);
			const prefixArgJs = expression.prefixArgument
				? expressionToJs(expression.prefixArgument)
				: 'undefined';
			const args = expression.arguments;
			const argsJs = args && expressionToJs(args);
			return `_callFunction(${functionJs}, ${prefixArgJs}, ${argsJs})`;
		}
		case 'functionLiteral': {
			// TODO params(DefinitionNames) to Type
			const params = expression.params;
			let argsJs: string;
			let paramsJs: string;
			if (params.type === 'parameters') {
				argsJs = params.singleFields.map(field => field.name.name).join(', ');
				const rest = params.rest;
				if (rest) {
					argsJs += '...' + rest.name.name;
				}
				paramsJs = parametersToJs(params);
			}
			else {
				argsJs = '';
				paramsJs = `{type:${expressionToJs(params)}}`;
			}
			const functionJs = `(${argsJs}) => {\n${functionBodyToJs(expression.body)}\n}`;
			const parent = expression.parent;
			if (parent?.type === 'definition'
				&& expression === parent.value) {
				// named function
				const nameJs = escapeReservedJsVariableName(parent.name.name);
				return `${functionJs}\n${callCreateFunctionJs(nameJs, paramsJs)}`;
			}
			// anonymous function
			return callCreateFunctionJs(functionJs, paramsJs);
		}
		case 'functionTypeLiteral': {
			// TODO params to type
			return `new FunctionType(Any, ${expressionToJs(expression.returnType)})`;
		}
		case 'integer':
			return `${expression.value}n`;
		case 'list':
			return `[\n${expression.values.map(value => {
				const valueJs = value.type === 'spread'
					? `...${expressionToJs(value.value)} ?? []`
					: expressionToJs(value);
				return `${valueJs},\n`;
			}).join('')}]`;
		case 'nestedReference': {
			const nestedKey = expression.nestedKey;
			if (!nestedKey) {
				throw new Error('Missing nestedKey in nestedReference.');
			}
			switch (nestedKey.type) {
				case 'index':
					return `${expressionToJs(expression.source)}?.[${nestedKey.name} - 1]`;
				case 'name':
				case 'text':
					const field = getCheckedEscapableName(nestedKey);
					if (!field) {
						throw new Error(`Invalid field.`);
					}
					return `${expressionToJs(expression.source)}?.[${stringToJs(field)}]`;
				default: {
					const assertNever: never = nestedKey;
					throw new Error(`Unexpected nestedKey.type ${(assertNever as ParseExpression).type}`);
				}
			}
		}
		case 'object':
			return `_combineObject(${expression.values.map(value => {
				return expressionToJs(value.value);
			}).join(',\n')})`;
		case 'reference':
			return referenceToJs(expression);
		case 'text':
			return textLiteralToJs(expression);
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

function functionBodyToJs(expressions: ParseExpression[]): string {
	const js = expressions.map((expression, index) => {
		const expressionJs = expressionToJs(expression);
		// Die letzte Expression ist der Rückgabewert
		if (index === expressions.length - 1) {
			if (expression.type === 'definition') {
				return `${expressionJs}\nreturn ${escapeReservedJsVariableName(expression.name.name)};`;
			}
			return `return ${expressionJs}`;
		}
		else {
			return expressionJs;
		}
	}).join('\n');
	return js;
}

function referenceToJs(reference: Reference): string {
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

function parametersToJs(parameters: ParseParameterFields): string {
	const singleNamesJs = parameters.singleFields.length
		? `singleNames: [\n${parameters.singleFields.map(field => {
			const typeJs = field.typeGuard
				? `,\ntype: ${expressionToJs(field.typeGuard)}`
				: '';
			const sourceJs = field.source
				? `,\nsource: ${stringToJs(field.source)}`
				: '';
			return `{\nname: ${stringToJs(field.name.name)}${typeJs}${sourceJs}}`;
		}).join(',\n')}\n],\n`
		: '';
	const restJs = parameters.rest
		? `rest: {${parameters.rest.typeGuard ? 'type: ' + expressionToJs(parameters.rest.typeGuard) : ''}}\n`
		: '';
	return `{\n${singleNamesJs}${restJs}}`;
}

function checkTypeJs(type: ParseValueExpression, valueJs: string): string {
	return `_checkType(${expressionToJs(type)}, ${valueJs})`;
}

function textLiteralToJs(stringLiteral: ParseTextLiteral): string {
	const stringValue = stringLiteral.values.map(value => {
		if (value.type === 'textToken') {
			return escapeStringForBacktickJs(value.value);
		}
		return `\${${expressionToJs(value)}}`;
	}).join('');
	return `\`${stringValue}\``;
}

function dictionaryToJs(fieldsJs: string[]): string {
	return `{\n${fieldsJs.join('')}}`;
}

function singleDictionaryFieldToJs(name: ParseValueExpressionBase | Name, valueJs: string): string {
	const checkedName = getCheckedEscapableName(name);
	return `${checkedName && stringToJs(checkedName)}: ${valueJs},\n`;
}

function spreadDictionaryFieldToJs(valueJs: string): string {
	return `...${valueJs},\n`;
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

function callCreateFunctionJs(functionJs: string, paramsJs: string): string {
	return `_createFunction(${functionJs}, ${paramsJs})`;
}