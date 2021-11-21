import {
	SyntaxTree,
	Expression,
	TypeExpression,
	FunctionLiteral,
} from './syntax-tree';

//#region SyntaxTreeWithSymbols

interface SyntaxTreeWithSymbols {
	type: 'root';
	/**
	 * Builtins
	 */
	symbols: SymbolTable;
	files: {
		[fileName: string]: FileWithSymbols;
	};
}

interface SymbolTable {
	[symbol: string]: SymbolDefinition;
}

interface SymbolDefinition {
	startRowIndex: number;
	startColumnIndex: number;
	endRowIndex: number;
	endColumnIndex: number;
	description?: string;
	type: TypeExpression;
}

interface FileWithSymbols {
	type: 'file';
	errors?: any[];
	expressions?: ExpressionWithSymbols[];
	symbols: SymbolTable;
}

type ExpressionWithSymbols =
	| FunctionLiteralWithSymbols
	;

interface FunctionLiteralWithSymbols extends FunctionLiteral {
	// parent: ExpressionWithSymbols;
	symbols: SymbolTable;
}

//#endregion SyntaxTreeWithSymbols

export function bindFile(syntaxTree: SyntaxTree): FileWithSymbols {
	const globals: SymbolTable = {};
	const errors = syntaxTree.errors ?? [];
	const syntaxTreeWithSymbols: FileWithSymbols = {
		type: 'file',
		symbols: globals,
		errors: errors,
		expressions: syntaxTree.parsed!.map(expression => {
			switch (expression.type) {
				case 'definition': {
					const name = expression.name.name;
					if (globals[name]) {
						// TODO
						// errors.push()
						throw new Error(`${name} is already defined`);
					}
					return expression;
				}

				default: {
					const assertNever: never = expression;
					throw new Error(`Unexpected : ${(assertNever as Expression).type}`);
				}
			}
		}),
	};
	return syntaxTreeWithSymbols;
}

function bindExpression(): ExpressionWithSymbols {

}