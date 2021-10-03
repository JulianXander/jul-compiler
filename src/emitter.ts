import { Expression, ReferenceNames } from './abstract-syntax-tree';

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
			// TODO import runtime.callFunction (enthält checkType)
			return `callFunction(${referenceNamesToJs(expression.functionReference)}, ${expressionToJs(expression.params)})`;

		case 'functionLiteral':
			// TODO import runtime.createFunction
			// TODO params(DefinitionNames) to Type
			// TODO rest args
			// TODO return statement
			return `createFunction((${expression.params.singleNames.map(name => name.name).join(', ')}) => {${expressionsToJs(expression.body)}}, ${expression.params})`;

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

function checkTypeJs(type: Expression, valueJs: string): string {
	// TODO import runtime.checkType
	return `checkType(${expressionToJs(type)}, ${valueJs})`
}