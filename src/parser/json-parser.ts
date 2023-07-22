import { ParseExpression, ParseSingleDictionaryField } from "../syntax-tree.js";
import { Positioned } from "./parser-combinator.js";

export function jsonValueToJulAst(jsonValue: any): ParseExpression {
  // TODO position?
  const position: Positioned = {
    startColumnIndex: 0,
    startRowIndex: 0,
    endColumnIndex: 0,
    endRowIndex: 0,
  }
  switch (typeof jsonValue) {
    case 'bigint':
      return {
        type: 'integer',
        value: jsonValue,
        ...position,
      };
    case 'boolean':
      return {
        type: 'reference',
        name: {
          type: 'name',
          name: '' + jsonValue,
          ...position,
        },
        ...position,
      };
    case 'object': {
      if (jsonValue === null) {
        return {
          type: 'empty',
          ...position
        };
      }
      if (Array.isArray(jsonValue)) {
        return {
          type: 'list',
          values: jsonValue.map(jsonValueToJulAst) as any,
          ...position,
        };
      }
      return {
        type: 'dictionary',
        fields: Object.entries(jsonValue).map(([key, value]) => {
          const field: ParseSingleDictionaryField = {
            type: 'singleDictionaryField',
            name: jsonValueToJulAst(key) as any,
            value: jsonValueToJulAst(value) as any,
            ...position,
          };
          return field;
        }) as any,
        ...position,
      };
    }
    case 'string':
      return {
        type: 'string',
        values: [{
          type: 'stringToken',
          value: jsonValue,
        }],
        ...position,
      };
    default:
      throw new Error(`Unexpected jsonValue type: ${typeof jsonValue}`);
  }
}