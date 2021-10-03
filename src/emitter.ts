import { Expression } from './abstract-syntax-tree';

export function expressionsToJs(expressions: Expression[]): string {
	const js = expressions.map(expressionToJs).join('\n');
	return js;
}

export function expressionToJs(expression: Expression): string {
	switch (expression.type) {
		case 'branching':
			// TODO
			return;

		case 'definition': {
			const valueJs = expressionToJs(expression.value);
			return `const ${expression.name} = ${expression.typeGuard ? checkTypeJs(expression.typeGuard, valueJs) : valueJs};`;
		}

		case 'destructuring':
			// TODO
			return;

		case 'dictionary':
			return `{\n${expression.values.map(value => {
				const valueJs = expressionToJs(value.value);
				return `${value.name}: ${value.typeGuard ? checkTypeJs(value.typeGuard, valueJs) : valueJs},\n`;
			}).join('')}}`;

		case 'empty':
			return 'null';

		case 'functionCall':
			// TODO
			return;

		case 'functionLiteral':
			// TODO
			return;

		case 'list':
			return `[\n${expression.values.map(value => {
				return `${expressionToJs(value)},\n`;
			}).join('')}]`;

		case 'number':
			return '' + expression.value;

		case 'reference':
			// TODO
			return;

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

function checkTypeJs(type: Expression, valueJs: string): string {
	// TODO import runtime.checkType
	return `checkType(${expressionToJs(type)}, ${valueJs})`
}