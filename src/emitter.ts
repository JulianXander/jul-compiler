import { DefinitionNames, Expression, ReferenceNames } from './abstract-syntax-tree';

// TODO import builtins
export function astToJs(expressions: Expression[]): string {
	return 'import { _branch, _callFunction, _checkType, _createFunction } from "./runtime"\n' + expressionsToJs(expressions);
}

export function expressionsToJs(expressions: Expression[]): string {
	const js = expressions.map(expressionToJs).join('\n');
	return js;
}

function expressionToJs(expression: Expression): string {
	switch (expression.type) {
		case 'branching':
			return `_branch(\n${expressionToJs(expression.value)},\n${expression.branches.map(expressionToJs).join(',\n')},\n)`;

		case 'definition': {
			const valueJs = expressionToJs(expression.value);
			return `const ${expression.name} = ${expression.typeGuard ? checkTypeJs(expression.typeGuard, valueJs) : valueJs};`;
		}

		case 'destructuring':
			// TODO type checks, temp value, definitionnames einzeln durchgehen
			return `const {${expression.names}} = ${expressionToJs(expression.value)}`;

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

		case 'string':
			return expression.values.map(value => {
				if (value.type === 'stringToken') {
					return value.value;
				}
				return expressionToJs(value);
			}).join('');

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
			return name;
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

// TODO
function definitionNamesToJs(definitionNames: DefinitionNames): string {
	return `{${definitionNames.singleNames.map(definitionName => {
		return `${definitionName.name}`;
	})}}`;
}

function checkTypeJs(type: Expression, valueJs: string): string {
	return `_checkType(${expressionToJs(type)}, ${valueJs})`
}