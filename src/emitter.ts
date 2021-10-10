import { DefinitionNames, Expression, ReferenceNames } from './abstract-syntax-tree';
import * as runtime from './runtime';

const runtimeKeys = Object.keys(runtime);
// slice(1) um __esModule wegzulassen
const runtimeImports = runtimeKeys.slice(1).join(', ');

// TODO nur benutzte builtins importieren? minimale runtime erzeugen/bundling mit treeshaking?
export function astToJs(expressions: Expression[]): string {
	// _branch, _callFunction, _checkType, _createFunction, log
	return `const { ${runtimeImports} } = require("./runtime");\n${expressionsToJs(expressions)}`;
}

function expressionsToJs(expressions: Expression[]): string {
	const js = expressions.map(expressionToJs).join('\n');
	return js;
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

		case 'functionCall':
			return `_callFunction(${referenceNamesToJs(expression.functionReference)}, ${expressionToJs(expression.params)})`;

		case 'functionLiteral': {
			// TODO params(DefinitionNames) to Type
			// TODO rest args
			// TODO return statement
			const argsJs = expression.params.singleNames.map(name => name.name).join(', ');
			return `_createFunction((${argsJs}) => {${expressionsToJs(expression.body)}}, ${definitionNamesToJs(expression.params)})`;
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