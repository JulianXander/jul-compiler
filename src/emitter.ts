import {
	CheckedDestructuringField,
	CheckedExpression,
	CheckedFunctionCall,
	CheckedParameterFields,
	CheckedStringLiteral,
	CheckedValueExpression,
	NumberLiteral,
	ObjectLiteral,
	Reference,
} from './syntax-tree';
import * as runtime from './runtime';

const runtimeKeys = Object.keys(runtime);
const runtimeImports = runtimeKeys.join(', ');
export const importLine = `const { ${runtimeImports} } = require("./runtime");\n`;

// TODO nur benutzte builtins importieren? minimale runtime erzeugen/bundling mit treeshaking?
export function syntaxTreeToJs(expressions: CheckedExpression[]): string {
	// _branch, _callFunction, _checkType, _createFunction, log
	let hasDefinition = false;
	return `${importLine}${expressions.map((expression, index) => {
		const expressionJs = expressionToJs(expression);
		// export defined names
		if (expression.type === 'definition') {
			hasDefinition = true;
			const name = expression.name;
			return `${expressionJs}\nexports.${name} = ${name};`;
		}
		// default export = last expression
		if (index === expressions.length - 1 && !hasDefinition) {
			return 'module.exports = ' + expressionJs;
		}
		return expressionJs;
	}).join('\n')}`;
}

function expressionToJs(expression: CheckedExpression): string {
	switch (expression.type) {
		case 'branching':
			return `_branch(\n${expressionToJs(expression.value)},\n${expression.branches.map(expressionToJs).join(',\n')},\n)`;

		case 'definition': {
			const valueJs = expressionToJs(expression.value);
			const checkedValueJs = expression.typeGuard
				? checkTypeJs(expression.typeGuard, valueJs)
				: valueJs;
			return `const ${escapeReservedJsVariableName(expression.name)} = ${checkedValueJs};`;
		}

		case 'destructuring': {
			const fields = expression.fields;
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
			return `${declarations}\n{\nconst _temp = ${expressionToJs(expression.value)};\nconst _isArray = Array.isArray(_temp);\n${assignments}\n}`;
		}

		case 'dictionary':
			// TODO mit Object.create(null), damit leerer prototype
			return `{\n${expression.fields.map(value => {
				const valueJs = expressionToJs(value.value);
				if (value.type === 'singleDictionaryField') {
					return `${value.name}: ${value.typeGuard ? checkTypeJs(value.typeGuard, valueJs) : valueJs},\n`;
				}
				else {
					return `...${valueJs},\n`;
				}
			}).join('')}}`;

		case 'dictionaryType':
			// TODO
			return 'TODO dictionaryType';

		case 'empty':
			return 'null';

		case 'functionCall': {
			const functionReference = expression.functionReference;
			if (isImport(functionReference)) {
				const path = getPathFromImport(expression);
				return `require("${path}")`;
			}
			return `_callFunction(${referenceToJs(functionReference)}, ${expressionToJs(expression.arguments)})`;
		}

		case 'functionLiteral': {
			// TODO params(DefinitionNames) to Type
			// TODO rest args
			// TODO return statement
			const params = expression.params;
			let argsJs: string;
			let paramsJs: string;
			if (params.type === 'parameters') {
				argsJs = params.singleFields.map(field => field.name).join(', ');
				paramsJs = parametersToJs(params);
			}
			else {
				argsJs = '';
				paramsJs = `{type:${typeToJs(params)}}`;
			}
			return `_createFunction((${argsJs}) => {${functionBodyToJs(expression.body)}}, ${paramsJs})`;
		}

		case 'list':
			return `[\n${expression.values.map(value => {
				return `${expressionToJs(value)},\n`;
			}).join('')}]`;

		case 'number':
			return numberLiteralToJs(expression);

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

export function isImport(functionReference: Reference): boolean {
	return functionReference.names.length === 1
		&& functionReference.names[0].name === 'import';
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

function getPathExpression(importParams: ObjectLiteral): CheckedValueExpression {
	switch (importParams.type) {
		case 'dictionary':
			return importParams.fields[0].value;

		case 'empty':
			throw new Error('import can not be called without arguments');

		case 'list':
			return importParams.values[0];

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
	return reference.names.map((name, index) => {
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
	'false',
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
	'true',
	'try',
	'typeof',
	'var',
	'void',
	'volatile',
	'while',
	'with',
	'yield',
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
				? `,\ntype: ${typeToJs(field.typeGuard)}`
				: '';
			return `{\nname: "${field.name}"${typeJs}}`;
		}).join(',\n')}\n],\n`
		: '';
	const restJs = parameters.rest
		? `rest: {${parameters.rest.typeGuard ? 'type: ' + typeToJs(parameters.rest.typeGuard) : ''}}\n`
		: '';
	return `{\n${singleNamesJs}${restJs}}`;
}

function checkTypeJs(type: CheckedValueExpression, valueJs: string): string {
	return `_checkType(${typeToJs(type)}, ${valueJs})`;
}

function typeToJs(typeExpression: CheckedValueExpression): string {
	switch (typeExpression.type) {
		case 'branching':
			throw new Error(`Type not implemented for expression.type: ${typeExpression.type}`);

		case 'dictionary':
			// TODO dictionaryType?!
			throw new Error(`Type not implemented for expression.type: ${typeExpression.type}`);

		case 'dictionaryType':
			// TODO dictionaryType?!
			throw new Error(`Type not implemented for expression.type: ${typeExpression.type}`);
		// return `(_x) => _checkDictionaryType(${definitionNamesToJs(typeExpression)}, _x)`;

		case 'empty':
			throw new Error(`Type not implemented for expression.type: ${typeExpression.type}`);

		case 'functionCall':
			throw new Error(`Type not implemented for expression.type: ${typeExpression.type}`);

		case 'functionLiteral':
			throw new Error(`Type not implemented for expression.type: ${typeExpression.type}`);

		case 'list':
			throw new Error(`Type not implemented for expression.type: ${typeExpression.type}`);

		case 'number':
		case 'string':
			return constantValueToTypeJs(typeExpression);

		case 'reference':
			return referenceToJs(typeExpression);

		default: {
			const assertNever: never = typeExpression;
			throw new Error(`Unexpected expression.type: ${(assertNever as CheckedExpression).type}`);
		}
	}
}

function constantValueToTypeJs(expression: CheckedValueExpression): string {
	return `(_x) => _x === ${expressionToJs(expression)}`;
}

function stringLiteralToJs(stringLiteral: CheckedStringLiteral): string {
	const stringValue = stringLiteral.values.map(value => {
		if (value.type === 'stringToken') {
			return value.value;
		}
		return `\${${expressionToJs(value)}}`;
	}).join('');
	return `\`${stringValue}\``;
}

function numberLiteralToJs(numberLiteral: NumberLiteral): string {
	return '' + numberLiteral.value;
}