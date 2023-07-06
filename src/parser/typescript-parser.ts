import typescript, { Node } from 'typescript';
import { ParseExpression, ParsedFile } from '../syntax-tree.js';
import { isDefined } from '../util.js';
const { createSourceFile, ScriptTarget, SyntaxKind } = typescript;


export function parseTsCode(code: string): ParsedFile {
  // TODO pass file name?
  const tsAst = createSourceFile('todo.ts', code, ScriptTarget.ESNext);
  console.log(tsAst.statements);
  // TODO
  return {
    expressions: tsAst.statements.map(tsNode =>
      tsNodeToJulAst(tsNode))
      .filter(isDefined),
    errors: [],
    symbols: {},
  };
}

function tsNodeToJulAst(tsNode: Node): ParseExpression | undefined {
  switch (tsNode.kind) {
    case SyntaxKind.NullKeyword:
      return {
        type: 'empty',
        startRowIndex: tsNode.pos,
        startColumnIndex: tsNode.pos,
        endRowIndex: tsNode.end,
        endColumnIndex: tsNode.end,
      };

    case SyntaxKind.TypeAliasDeclaration:
    default:
      return undefined;
  }
}