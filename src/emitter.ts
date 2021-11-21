import { DefinitionNames, Expression, FunctionCall, NumberLiteral, ObjectLiteral, Reference, ReferenceNames, StringLiteral, TypeExpression, ValueExpression } from './syntax-tree';
import * as runtime from './runtime';

const runtimeKeys = Object.keys(runtime);
const runtimeImports = runtimeKeys.join(', ');
export const importLine = `const { ${runtimeImports} } = require("./runtime");\n`;

// TODO nur benutzte builtins importieren? minimale runtime erzeugen/bundling mit treeshaking?
export function syntaxTreeToJs(expressions: Expression[]): string {
	// _branch, _callFunction, _checkType, _createFunction, log
	let hasDefinition = false;
	return `${importLine}${expressions.map((expression, index) => {
		const expressionJs = expressionToJs(expression);
		// export defined names
		if (expression.type === 'definition') {
			hasDefinition = true;
			return `${expressionJs}\nexports.${expression.name} = ${expression.name};`;
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
			const checkedValueJs = expression.typeGuard
				? checkTypeJs(expression.typeGuard, valueJs)
				: valueJs;
			return `const ${escapeReservedJsVariableName(expression.name.name)} = ${checkedValueJs};`;
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
				return `${escapeReservedJsVariableName(name)} = ${checkedValue};`;
			}).join('\n');
			return `${declarations}\n{\nconst _temp = ${expressionToJs(expression.value)};\nconst _isArray = Array.isArray(_temp);\n${assignments}\n}`;
		}

		case 'dictionary':
			// TODO mit Object.create(null), damit leerer prototype
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
			return `_callFunction(${referenceToJs(functionReference)}, ${expressionToJs(expression.arguments)})`;
		}

		case 'functionLiteral': {
			// TODO params(DefinitionNames) to Type
			// TODO rest args
			// TODO return statement
			const params = expression.params;
			let argsJs: string;
			let paramsJs: string;
			if (params.type === 'definitionNames') {
				argsJs = params.singleNames.map(name => name.name).join(', ');
				paramsJs = definitionNamesToJs(params);
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
			throw new Error(`Unexpected expression.type: ${(assertNever as Expression).type}`);
		}
	}
}

export function isImport(functionReference: Reference): boolean {
	return functionReference.names.length === 1
		&& functionReference.names[0] === 'import';
}

export function getPathFromImport(importExpression: FunctionCall): string {
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

function definitionNamesToJs(definitionNames: DefinitionNames): string {
	const singleNamesJs = definitionNames.singleNames.length
		? `singleNames: [\n${definitionNames.singleNames.map(definitionName => {
			const typeJs = definitionName.typeGuard
				? `,\ntype: ${typeToJs(definitionName.typeGuard)}`
				: '';
			return `{\nname: "${definitionName.name}"${typeJs}}`;
		}).join(',\n')}\n],\n`
		: '';
	const restJs = definitionNames.rest
		? `rest: {${definitionNames.rest.typeGuard ? 'type: ' + typeToJs(definitionNames.rest.typeGuard) : ''}}\n`
		: '';
	return `{\n${singleNamesJs}${restJs}}`;
}

function checkTypeJs(type: TypeExpression, valueJs: string): string {
	return `_checkType(${typeToJs(type)}, ${valueJs})`;
}

function typeToJs(typeExpression: TypeExpression): string {
	switch (typeExpression.type) {
		case 'branching':
			throw new Error(`Type not implemented for expression.type: ${typeExpression.type}`);

		case 'dictionary':
			throw new Error(`Type not implemented for expression.type: ${typeExpression.type}`);

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
			throw new Error(`Unexpected expression.type: ${(assertNever as Expression).type}`);
		}
	}
}

function constantValueToTypeJs(expression: ValueExpression): string {
	return `(_x) => _x === ${expressionToJs(expression)}`;
}

function stringLiteralToJs(stringLiteral: StringLiteral): string {
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