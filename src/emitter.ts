import { Expression } from './abstract-syntax-tree';

export function expressionsToJs(expressions: Expression[]): string {
    const js = expressions.map(expressionToJs).join('\n');
    return js;
}

export function expressionToJs(expression: Expression): string {
    switch (expression.type) {
        case 'branching':
            return;

        default: {
            const assertNever: never = expression.type;
            throw new Error(`Unexpected expression.type: ${assertNever}`);
        }
    }
}