import {
	CheckedExpression,
	CheckedFunctionCall,
	CheckedListValue,
	CheckedParameterFields,
	CheckedStringLiteral,
	CheckedValueExpression,
	ObjectLiteral,
	Reference,
} from './syntax-tree.js';
import * as runtime from './runtime.js';
import { Extension, changeExtension } from './util.js';
import { extname } from 'path';

const runtimeKeys = Object.keys(runtime);
const runtimeImports = runtimeKeys.join(', ');

export function getRuntimeImportJs(runtimePath: string): string {
	return getImportJs(`{ ${runtimeImports} }`, runtimePath);
}

// TODO nur benutzte builtins importieren? minimale runtime erzeugen/bundling mit treeshaking?
export function syntaxTreeToJs(expressions: CheckedExpression[], runtimePath: string): string {
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

function expressionToJs(expression: CheckedExpression, topLevel: boolean = false): string {
	switch (expression.type) {
		case 'branching':
			return `_branch(\n${expressionToJs(expression.value)},\n${expression.branches.map(branch =>
				expressionToJs(branch)).join(',\n')},\n)`;
		case 'definition': {
			// export topLevel definitions
			const value = expression.value;
			const nameJs = escapeReservedJsVariableName(expression.name);
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
			const fields = expression.fields;
			const value = expression.value;
			if (isImportFunctionCall(value)) {
				const importPath = getPathFromImport(value);
				// TODO export, typeGuard, fallback
				return getImportJs(`{${fields.map(field => {
					const nameJs = escapeReservedJsVariableName(field.name);
					return field.source
						? `${escapeReservedJsVariableName(field.source)} as ${nameJs}`
						: nameJs
				}).join(', ')}}`, importPath);
			}
			// TODO rest
			const declarations = fields.map(field => `let ${escapeReservedJsVariableName(field.name)};`).join('\n');
			const assignments = fields.map((singleName, index) => {
				const { name, source, fallback, typeGuard } = singleName;
				const nameJs = escapeReservedJsVariableName(name);
				const sourceJs = escapeReservedJsVariableName(source ?? name);
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
		case 'fieldReference':
			return `${expressionToJs(expression.source)}[${stringToJs(expression.field)}]`;
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
			const prefixArgJs = expression.prefixArgument
				? expressionToJs(expression.prefixArgument)
				: 'undefined';
			return `_callFunction(${expressionToJs(functionExpression)}, ${prefixArgJs}, ${expressionToJs(expression.arguments)})`;
		}
		case 'functionLiteral': {
			// TODO params(DefinitionNames) to Type
			// TODO return statement
			const params = expression.params;
			let argsJs: string;
			let paramsJs: string;
			if (params.type === 'parameters') {
				argsJs = params.singleFields.map(field => field.name).join(', ');
				const rest = params.rest;
				if (rest) {
					argsJs += '...' + rest.name;
				}
				paramsJs = parametersToJs(params);
			}
			else {
				argsJs = '';
				paramsJs = `{type:${expressionToJs(params)}}`;
			}
			return `_createFunction((${argsJs}) => {${functionBodyToJs(expression.body)}}, ${paramsJs})`;
		}
		case 'indexReference':
			return `${expressionToJs(expression.source)}[${expression.index} - 1]`;
		case 'integer':
			return `${expression.value}n`;
		case 'list':
			return `[\n${expression.values.map(value => {
				const spread = value.type === 'spread';
				const valueExpression = value.type === 'spread'
					? value.value
					: value;
				return `${spread ? '...' : ''}${expressionToJs(valueExpression)},\n`;
			}).join('')}]`;
		case 'object':
			throw new Error('Unknown object literal emitter not implemented yet');
		case 'reference':
			return referenceToJs(expression);
		case 'string':
			return stringLiteralToJs(expression);
		default: {
			const assertNever: never = expression;
			throw new Error(`Unexpected expression.type: ${(assertNever as CheckedExpression).type}`);
		}
	}
}

//#region import

function getImportJs(importedJs: string, path: string): string {
	const isJson = path.endsWith(Extension.json);
	return `import ${importedJs} from ${stringToJs(path)}${isJson ? ' assert { type: \'json\' }' : ''};\n`;
}

function isImportFunctionCall(value: CheckedValueExpression): value is CheckedFunctionCall {
	return value.type === 'functionCall'
		&& isImportFunction(value.functionExpression);
}

function isImportFunction(functionExpression: CheckedValueExpression): boolean {
	return functionExpression.type === 'reference' && functionExpression.name.name === 'import';
}

function getPathFromImport(importExpression: CheckedFunctionCall): string {
	const pathExpression = getPathExpression(importExpression.arguments);
	if (pathExpression.type === 'string'
		&& pathExpression.values.length === 1
		&& pathExpression.values[0]!.type === 'stringToken') {
		const importedPath = pathExpression.values[0].value;
		switch (extname(importedPath)) {
			case Extension.ts:
				return changeExtension(importedPath, Extension.js);
			case Extension.yaml:
				return importedPath + Extension.json;
			default:
				return importedPath;
		}
	}
	// TODO dynamische imports verbieten???
	throw new Error('Can not get import path from ' + pathExpression.type);
}

function getPathExpression(importParams: ObjectLiteral): CheckedListValue {
	switch (importParams.type) {
		case 'dictionary':
			return importParams.fields[0].value;

		case 'empty':
			throw new Error('import can not be called without arguments');

		case 'list':
			return importParams.values[0];

		case 'object':
			throw new Error('import with unknown object literal argument not implemented yet');

		default: {
			const assertNever: never = importParams;
			throw new Error(`Unexpected importParams.type: ${(assertNever as ObjectLiteral).type}`);
		}
	}
}

//#endregion import

function functionBodyToJs(expressions: CheckedExpression[]): string {
	const js = expressions.map((expression, index) => {
		const expressionJs = expressionToJs(expression);
		// Die letzte Expression ist der Rückgabewert
		if (index === expressions.length - 1) {
			if (expression.type === 'definition') {
				return `${expressionJs}\nreturn ${expression.name};`;
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

	'Boolean',
	'Error',
	'String',
];
function escapeReservedJsVariableName(name: string): string {
	if (reservedJsNames.includes(name)) {
		return '_' + name;
	}
	return name;
}

function parametersToJs(parameters: CheckedParameterFields): string {
	const singleNamesJs = parameters.singleFields.length
		? `singleNames: [\n${parameters.singleFields.map(field => {
			const typeJs = field.typeGuard
				? `,\ntype: ${expressionToJs(field.typeGuard)}`
				: '';
			const sourceJs = field.source
				? `,\nsource: ${stringToJs(field.source)}`
				: '';
			return `{\nname: ${stringToJs(field.name)}${typeJs}${sourceJs}}`;
		}).join(',\n')}\n],\n`
		: '';
	const restJs = parameters.rest
		? `rest: {${parameters.rest.typeGuard ? 'type: ' + expressionToJs(parameters.rest.typeGuard) : ''}}\n`
		: '';
	return `{\n${singleNamesJs}${restJs}}`;
}

function checkTypeJs(type: CheckedValueExpression, valueJs: string): string {
	return `_checkType(${expressionToJs(type)}, ${valueJs})`;
}

function stringLiteralToJs(stringLiteral: CheckedStringLiteral): string {
	const stringValue = stringLiteral.values.map(value => {
		if (value.type === 'stringToken') {
			return escapeStringForBacktickJs(value.value);
		}
		return `\${${expressionToJs(value)}}`;
	}).join('');
	return `\`${stringValue}\``;
}

function dictionaryToJs(fieldsJs: string[]): string {
	return `{\n${fieldsJs.join('')}}`
}

function singleDictionaryFieldToJs(name: string, valueJs: string): string {
	return `${stringToJs(name)}: ${valueJs},\n`
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