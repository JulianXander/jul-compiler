import { SyntaxTree, TypeExpression } from './syntax-tree';

interface SymbolTables {
	parent?: SymbolTables;
	global: SymbolTable;
	scoped: {
		[scope: string]: SymbolTables;
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

export function bindFile(syntaxTree: SyntaxTree, symbolTables: SymbolTables): SymbolTable {

}