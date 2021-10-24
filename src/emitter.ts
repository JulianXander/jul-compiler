import { DefinitionNames, Expression, FunctionCall, ObjectLiteral, ReferenceNames, ValueExpression } from './abstract-syntax-tree';
import * as runtime from './runtime';

const runtimeKeys = Object.keys(runtime);
// slice(1) um __esModule wegzulassen
const runtimeImports = runtimeKeys.slice(1).join(', ');
export const importLine = `const { ${runtimeImports} } = require("./runtime");\n`;

// TODO nur benutzte builtins importieren? minimale runtime erzeugen/bundling mit treeshaking?
export function astToJs(expressions: Expression[]): string {
	// _branch, _callFunction, _checkType, _createFunction, log
	let hasDefinition = false;
	return `${importLine}${expressions.map((expression, index) => {
		const expressionJs = expressionToJs(expression);
		// export defined names
		if (expression.type === 'definition') {
			hasDefinition = true;
			return `${expressionJs}\nexports.${expression.name} = ${expression.name};`
		}
		// default export = last expression
		if (index === expressions.length - 1 && !hasDefinition) {
			return 'module.exports = ' + expressionJs;
		}
		return expressionJs;
	}).join('\n')}`;
}

function expressionToJs(expression: Expression): string {
	switch (expression.type) {
		case 'branching':
			return `_branch(\n${expressionToJs(expression.value)},\n${expression.branches.map(expressionToJs).join(',\n')},\n)`;

		case 'definition': {
			const valueJs = expressionToJs(expression.value);
			return `const ${escapeReservedJsVariableName(expression.name)} = ${expression.typeGuard ? checkTypeJs(expression.typeGuard, valueJs) : valueJs};`;
		}

		case 'destructuring': {
			// TODO rest
			const singleNames = expression.names.singleNames;
			const declarations = singleNames.map(singleName => `let ${escapeReservedJsVariableName(singleName.name)};`).join('\n');
			const assignments = singleNames.map((singleName, index) => {
				const { name, source, fallback, typeGuard } = singleName;
				const fallbackJs = fallback ? ` ?? ${expressionToJs(fallback)}` : '';
				const rawValue = `_isArray ? _temp[${index}] : _temp.${source ?? name}${fallbackJs}`;
				const checkedValue = typeGuard
					? `_checkType(${expressionToJs(typeGuard)}, ${rawValue})`
					: rawValue;
				return `${escapeReservedJsVariableName(name)} = ${checkedValue};`
			}).join('\n');
			return `${declarations}\n{\nconst _temp = ${expressionToJs(expression.value)};\nconst _isArray = Array.isArray(_temp);\n${assignments}\n}`;
		}

		case 'dictionary':
			return `{\n${expression.values.map(value => {
				const valueJs = expressionToJs(value.value);
				return `${value.name}: ${value.typeGuard ? checkTypeJs(value.typeGuard, valueJs) : valueJs},\n`;
			}).join('')}}`;

		case 'empty':
			return 'null';

		case 'functionCall': {
			const functionReference = expression.functionReference;
			if (isImport(functionReference)) {
				const path = getPathFromImport(expression);
				return `require("${path}")`;
			}
			return `_callFunction(${referenceNamesToJs(functionReference)}, ${expressionToJs(expression.params)})`;
		}

		case 'functionLiteral': {
			// TODO params(DefinitionNames) to Type
			// TODO rest args
			// TODO return statement
			const argsJs = expression.params.singleNames.map(name => name.name).join(', ');
			return `_createFunction((${argsJs}) => {${functionBodyToJs(expression.body)}}, ${definitionNamesToJs(expression.params)})`;
		}

		case 'list':
			return `[\n${expression.values.map(value => {
				return `${expressionToJs(value)},\n`;
			}).join('')}]`;

		case 'number':
			return '' + expression.value;

		case 'reference':
			return referenceNamesToJs(expression.names);

		case 'string': {
			const stringValue = expression.values.map(value => {
				if (value.type === 'stringToken') {
					return value.value;
				}
				return expressionToJs(value);
			}).join('');
			return `"${stringValue}"`;
		}

		default: {
			const assertNever: never = expression;
			throw new Error(`Unexpected expression.type: ${(assertNever as Expression).type}`);
		}
	}
}

export function isImport(functionReference: ReferenceNames): boolean {
	return functionReference.length === 1
		&& functionReference[0] === 'import';
}

export function getPathFromImport(importExpression: FunctionCall): string {
	const pathExpression = getPathExpression(importExpression.params);
	if (pathExpression.type === 'string'
		&& pathExpression.values.length === 1
		&& pathExpression.values[0]!.type === 'stringToken') {
		const importedPath = pathExpression.values[0].value;
		return importedPath;
	}
	// TODO dynamische imports verbieten???
	throw new Error('Can not get import path from ' + pathExpression.type);
}

function getPathExpression(importParams: ObjectLiteral): ValueExpression {
	switch (importParams.type) {
		case 'dictionary':
			return importParams.values[0].value;

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

function functionBodyToJs(expressions: Expression[]): string {
	const js = expressions.map((expression, index) => {
		const expressionJs = expressionToJs(expression);
		// Die letzte Expression ist der Rückgabewert
		if (index === expressions.length - 1) {
			if (expression.type === 'definition') {
				return `${expressionJs}\nreturn ${expression.name};`
			}
			return `return ${expressionJs}`;
		}
		else {
			return expressionJs;
		}
	}).join('\n');
	return js;
}

// TODO bound functions berücksichtigen
function referenceNamesToJs(referenceNames: ReferenceNames): string {
	return referenceNames.map((name, index) => {
		if (!index) {
			if (typeof name !== 'string') {
				throw new Error('First name must be a string');
			}
			return escapeReservedJsVariableName(name);
		}
		switch (typeof name) {
			case 'string':
				return `.${name}`;

			case 'number':
				return `[${name}]`;

			default: {
				const assertNever: never = name;
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

// TODO
function definitionNamesToJs(definitionNames: DefinitionNames): string {
	return `{${definitionNames.singleNames.map(definitionName => {
		return `${definitionName.name}`;
	})}}`;
}

function checkTypeJs(type: Expression, valueJs: string): string {
	return `_checkType(${expressionToJs(type)}, ${valueJs})`
}