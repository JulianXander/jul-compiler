import { Name, ParseExpression, ParsedFile } from '../syntax-tree.js';
import { isDefined } from '../util.js';
import { Positioned } from './parser-combinator.js';
import typescript, { BindingName, Node, StringLiteral, VariableStatement } from 'typescript';
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
  const position = getPositionFromTsNode(tsNode);
  switch (tsNode.kind) {
    case SyntaxKind.StringLiteral: {
      const stringLiteral = tsNode as StringLiteral;
      return {
        type: 'string',
        values: [{
          type: 'stringToken',
          value: stringLiteral.text,
        }],
        ...position,
      };
    }
    case SyntaxKind.NullKeyword:
      return {
        type: 'empty',
        ...position,
      };
    case SyntaxKind.VariableStatement: {
      const variableStatement = tsNode as VariableStatement;
      const test = variableStatement.declarationList.declarations.map(declaration => {
        return {
          name: tsNameToJulName(declaration.name),
          value: declaration.initializer && tsNodeToJulAst(declaration.initializer),
        };
      });
      const test1 = test[0]!;
      return {
        type: 'definition',
        name: test1.name,
        value: test1.value as any,
        ...position,
      };
    }
    case SyntaxKind.TypeAliasDeclaration:
    default:
      return undefined;
  }
}

function tsNameToJulName(tsName: BindingName): Name {
  // TODO case BindingPattern
  let name: string;
  switch (tsName.kind) {
    case SyntaxKind.Identifier:
      name = tsName.text;
      break;
    case SyntaxKind.ObjectBindingPattern:
    case SyntaxKind.ArrayBindingPattern:
      throw new Error(`SyntaxKind for Name not implemented yet: ${SyntaxKind[tsName.kind]}`);
    default:
      const assertNever: never = tsName;
      throw new Error(`Unexpected SyntaxKind for Name: ${SyntaxKind[(assertNever as BindingName).kind]}`);
  }
  return {
    type: 'name',
    name: tsName.text,
    ...getPositionFromTsNode(tsName),
  }
}

function getPositionFromTsNode(tsNode: Node): Positioned {
  // TODO
  return {
    startRowIndex: tsNode.pos,
    startColumnIndex: tsNode.pos,
    endRowIndex: tsNode.end,
    endColumnIndex: tsNode.end,
  }
}