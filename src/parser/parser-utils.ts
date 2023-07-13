import { BracketedExpressionBase, Name, ParseExpression, ParseFieldBase, ParseFunctionLiteral, ParseParameterFields, ParseValueExpression, ParseValueExpressionBase, SimpleExpression, SymbolTable } from "../syntax-tree.js";
import { ParserError, Positioned } from "./parser-combinator.js";

export function createParseFunctionLiteral(
  params: SimpleExpression | ParseParameterFields,
  returnType: ParseValueExpression | undefined,
  body: ParseExpression[],
  position: Positioned,
  errors: ParserError[],
): ParseFunctionLiteral {
  const symbols: SymbolTable = {};
  fillSymbolTableWithParams(symbols, errors, params);
  fillSymbolTableWithExpressions(symbols, errors, body);
  return {
    type: 'functionLiteral',
    params: params,
    returnType: returnType,
    body: body,
    symbols: symbols,
    ...position,
  };
}

//#region SymbolTable

export function fillSymbolTableWithExpressions(
  symbolTable: SymbolTable,
  errors: ParserError[],
  expressions: ParseExpression[],
): void {
  expressions.forEach(expression => {
    switch (expression.type) {
      case 'definition': {
        // TODO type
        defineSymbol(symbolTable, errors, expression.name, expression.value, expression.description, undefined);
        return;
      }
      case 'destructuring': {
        // TODO type über value ermitteln
        fillSymbolTableWithDictionaryType(symbolTable, errors, expression.fields, false);
        return;
      }
      default:
        return;
    }
  });
}

function fillSymbolTableWithParams(
  symbolTable: SymbolTable,
  errors: ParserError[],
  params: SimpleExpression | ParseParameterFields,
): void {
  switch (params.type) {
    case 'bracketed':
      fillSymbolTableWithDictionaryType(symbolTable, errors, params, true);
      break;
    case 'parameters': {
      params.singleFields.forEach((field, index) => {
        defineSymbol(
          symbolTable,
          errors,
          field.name,
          // TODO
          field.typeGuard as any,
          field.description,
          index);
      });
      const rest = params.rest;
      if (rest) {
        defineSymbol(
          symbolTable,
          errors,
          rest.name,
          // TODO
          rest.typeGuard as any,
          rest.description,
          undefined);
      }
      break;
    }
    default:
      break;
  }
}

export function fillSymbolTableWithDictionaryType(
  symbolTable: SymbolTable,
  errors: ParserError[],
  dictionaryType: BracketedExpressionBase,
  isFunctionParameter: boolean,
): void {
  dictionaryType.fields.forEach((field, index) => {
    defineSymbolForField(symbolTable, errors, field, isFunctionParameter ? index : undefined);
  });
}

function defineSymbolForField(
  symbolTable: SymbolTable,
  errors: ParserError[],
  field: ParseFieldBase,
  functionParameterIndex: number | undefined,
): void {
  const name = checkName(field.name);
  if (!name) {
    // TODO error?
    return;
  }
  defineSymbol(
    symbolTable,
    errors,
    name,
    // TODO check type
    field.typeGuard as any,
    field.description,
    functionParameterIndex,
  );
}

function defineSymbol(
  symbolTable: SymbolTable,
  errors: ParserError[],
  name: Name,
  type: ParseValueExpression,
  description: string | undefined,
  functionParameterIndex: number | undefined,
): void {
  const nameString = name.name;
  // TODO check upper scopes
  if (symbolTable[nameString]) {
    errors.push({
      message: `${nameString} is already defined`,
      startRowIndex: name.startRowIndex,
      startColumnIndex: name.startColumnIndex,
      endRowIndex: name.endRowIndex,
      endColumnIndex: name.endColumnIndex,
    });
  }
  symbolTable[nameString] = {
    typeExpression: type,
    description: description,
    functionParameterIndex: functionParameterIndex,
    startRowIndex: name.startRowIndex,
    startColumnIndex: name.startColumnIndex,
    endRowIndex: name.endRowIndex,
    endColumnIndex: name.endColumnIndex,
  };
}

//#endregion SymbolTable

export function checkName(parseName: ParseValueExpressionBase | ParseValueExpression): Name | undefined {
  if (parseName.type !== 'reference') {
    return undefined;
  }
  if (parseName.path.length > 1) {
    return undefined;
  }
  return parseName.path[0];
}