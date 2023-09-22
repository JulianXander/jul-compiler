import { Name, ParseExpression, ParseParameterField, ParseParameterFields, ParsedExpressions } from '../syntax-tree.js';
import { isDefined } from '../util.js';
import { Positioned } from './parser-combinator.js';
import typescript, { ArrowFunction, BindingName, FunctionDeclaration, Node, NodeArray, NumericLiteral, ParameterDeclaration, StringLiteral, VariableStatement } from 'typescript';
import { createParseFunctionLiteral } from './parser-utils.js';
const { createSourceFile, ScriptTarget, SyntaxKind } = typescript;

export function parseTsCode(code: string): ParsedExpressions {
  // TODO pass file name?
  const tsAst = createSourceFile('todo.ts', code, ScriptTarget.ESNext);
  const julExpressions = tsAst.statements.map(tsNode =>
    tsNodeToJulAst(tsNode))
    .filter(isDefined);
  // TODO errors
  return {
    expressions: julExpressions,
    errors: [],
  };
}

function tsNodeToJulAst(tsNode: Node): ParseExpression | undefined {
  const position = getPositionFromTsNode(tsNode);
  switch (tsNode.kind) {
    case SyntaxKind.NumericLiteral: {
      const numericLiteral = tsNode as NumericLiteral;
      return {
        type: 'float',
        value: +numericLiteral.text,
        ...position,
      };
    }
    case SyntaxKind.StringLiteral: {
      const stringLiteral = tsNode as StringLiteral;
      return {
        type: 'text',
        values: [{
          type: 'textToken',
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
    case SyntaxKind.ArrowFunction: {
      const arrowFunction = tsNode as ArrowFunction;
      return createParseFunctionLiteral(
        tsParametersToJulParameters(arrowFunction.parameters, position),
        undefined,
        // TODO body, errors
        [],
        position,
        [],
      );
    }
    case SyntaxKind.EmptyStatement:
      return undefined;
    case SyntaxKind.VariableStatement: {
      const variableStatement = tsNode as VariableStatement;
      const test = variableStatement.declarationList.declarations.map(declaration => {
        return {
          name: tsNameToJulName(declaration.name),
          value: declaration.initializer && tsNodeToJulAst(declaration.initializer),
        };
      });
      const test1 = test[0]!;
      if (!test1.value
        || !test1.name) {
        return undefined;
      }
      // TODO nur exported definitions lieferen?
      return {
        type: 'definition',
        name: test1.name,
        value: test1.value as any,
        ...position,
      };
    }
    case SyntaxKind.FunctionDeclaration: {
      const functionDeclaration = tsNode as FunctionDeclaration;
      const tsName = functionDeclaration.name;
      if (!tsName) {
        return undefined;
      }
      const julName = tsNameToJulName(tsName);
      if (!julName) {
        return undefined;
      }
      return {
        type: 'definition',
        name: julName,
        value: createParseFunctionLiteral(
          tsParametersToJulParameters(functionDeclaration.parameters, position),
          undefined,
          // TODO body, errors,
          [],
          position,
          [],
        ),
        ...position,
      };
    }
    case SyntaxKind.TypeAliasDeclaration:
      return undefined;
    default:
      return undefined;
  }
}

function tsParametersToJulParameters(
  tsParameters: NodeArray<ParameterDeclaration>,
  position: Positioned,
): ParseParameterFields {
  const julParameters = tsParameters.map(tsParameter => {
    const julName = tsNameToJulName(tsParameter.name);
    if (!julName) {
      return undefined;
    }
    const julParameter: ParseParameterField = {
      type: 'parameter',
      name: julName,
      ...getPositionFromTsNode(tsParameter),
    };
    return julParameter;
  }).filter(isDefined);
  return {
    type: 'parameters',
    singleFields: julParameters,
    ...position,
  };
}

function tsNameToJulName(tsName: BindingName): Name | undefined {
  // TODO case BindingPattern
  let name: string;
  switch (tsName.kind) {
    case SyntaxKind.Identifier:
      name = tsName.text;
      break;
    case SyntaxKind.ObjectBindingPattern:
    case SyntaxKind.ArrayBindingPattern:
      console.error(`SyntaxKind for Name not implemented yet: ${SyntaxKind[tsName.kind]}`);
      return undefined;
    default:
      const assertNever: never = tsName;
      throw new Error(`Unexpected SyntaxKind for Name: ${SyntaxKind[(assertNever as BindingName).kind]}`);
  }
  return {
    type: 'name',
    name: name,
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