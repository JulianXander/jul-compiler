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
import { Extension } from './util.js';

const runtimeKeys = Object.keys(runtime);
const runtimeImports = runtimeKeys.join(', ');
export function getRuntimeImportJs(runtimePath: string): string {
	return `import { ${runtimeImports} } from ${stringToJs(runtimePath)};\n`;
	// return `const { ${runtimeImports} } = require(${stringToJs(runtimePath)});\n`;
}

// TODO nur benutzte builtins importieren? minimale runtime erzeugen/bundling mit treeshaking?
export function syntaxTreeToJs(expressions: CheckedExpression[], runtimePath: string): string {
	// _branch, _callFunction, _checkType, _createFunction, log
	let hasDefinition = false;
	return `${getRuntimeImportJs(runtimePath)}${expressions.map((expression, index) => {
		const expressionJs = expressionToJs(expression, true);
		// TODO remove wenn ecmascript module syntax fertig
		// // export defined names
		// if (expression.type === 'definition') {
		// 	hasDefinition = true;
		// 	return `export ${expressionJs}`;
		// 	// const name = expression.name;
		// 	// return `${expressionJs}\nexports.${name} = ${name};`;
		// }
		// default export = last expression
		if (index === expressions.length - 1 && !hasDefinition) {
			return `export default ${expressionJs}`;
			// return 'module.exports = ' + expressionJs;
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
				const useDefinitionLine = typeGuard || topLevel;
				const aliasJs = `${useDefinitionLine ? '_' : ''}${nameJs}`;
				const importJs = `import * as ${aliasJs} from ${stringToJs(importPath)};`;
				if (useDefinitionLine) {
					const checkedValueJs = typeGuard
						? checkTypeJs(typeGuard, aliasJs)
						: aliasJs;

					return `${importJs}
${getDefinitionJs(topLevel, nameJs, checkedValueJs)}`
				}
				return importJs;
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
				return `import {${fields.map(field =>
					field.source
						? `${escapeReservedJsVariableName(field.source)} as ${escapeReservedJsVariableName(field.source)}`
						: escapeReservedJsVariableName(field.name)
				).join(', ')}} from ${stringToJs(importPath)};`;
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

		case 'float':
			return '' + expression.value;

		case 'fraction':
			return `{numerator:${expression.numerator}n,denominator:${expression.denominator}n}`;

		case 'functionCall': {
			const functionReference = expression.functionReference;
			if (isImportFunction(functionReference)) {
				throw new Error('import at unexpected location.');
				// const path = getPathFromImport(expression);
				// const outPath = path.endsWith(Extension.yaml)
				// 	? path + Extension.json
				// 	: path;
				// return `require("${outPath}")`;
			}
			return `_callFunction(${referenceToJs(functionReference)}, ${expressionToJs(expression.arguments)})`;
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

function isImportFunctionCall(value: CheckedValueExpression): value is CheckedFunctionCall {
	return value.type === 'functionCall'
		&& isImportFunction(value.functionReference);
}

export function isImportFunction(functionReference: Reference): boolean {
	return functionReference.path.length === 1
		&& functionReference.path[0].name === 'import';
}

export function getPathFromImport(importExpression: CheckedFunctionCall): string {
	const pathExpression = getPathExpression(importExpression.arguments);
	if (pathExpression.type === 'string'
		&& pathExpression.values.length === 1
		&& pathExpression.values[0]!.type === 'stringToken') {
		const importedPath = pathExpression.values[0].value;
		return importedPath;
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
	return reference.path.map((name, index) => {
		const innerName = name.name;
		if (!index) {
			if (typeof innerName !== 'string') {
				throw new Error('First name must be a string');
			}
			return escapeReservedJsVariableName(innerName);
		}
		switch (typeof innerName) {
			case 'string':
				return `.${escapeReservedJsVariableName(innerName)}`;

			case 'number':
				return `[${innerName}]`;

			default: {
				const assertNever: never = innerName;
				throw new Error(`Unexpected typeof name: ${typeof assertNever}`);
			}
		}
	}).join('');
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
	return `'${name.replaceAll('\'', '\\\'')}': ${valueJs},\n`
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