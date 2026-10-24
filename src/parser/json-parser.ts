import { JsonValue } from '../runtime/runtime.js';
import { Name, ParseDictionaryLiteral, ParseExpression, ParseSingleDictionaryField, ParsedExpressions, createSymbolTable } from '../syntax-tree.js';
import { fillSymbolTableWithFields } from './parser-utils.js';
import { Positioned } from '../compiler-errors.js';

export function jsonValueToParsedExpressions(jsonValue: JsonValue): ParsedExpressions {
	const ast = jsonValueToJulAst(jsonValue);
	return {
		expressions: [
			ast,
		],
		errors: [],
	};
}

function jsonValueToJulAst(jsonValue: JsonValue): ParseExpression {
	// TODO position?
	const position: Positioned = {
		startColumnIndex: 0,
		startRowIndex: 0,
		endColumnIndex: 0,
		endRowIndex: 0,
	};
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
					...position,
				};
			}
			if (Array.isArray(jsonValue)) {
				return {
					type: 'list',
					values: jsonValue.map(jsonValueToJulAst) as any,
					...position,
				};
			}
			const fields = Object.entries(jsonValue).map(([key, value]) => {
				const name: Name = {
					type: 'name',
					name: key,
					...position,
				};
				const field: ParseSingleDictionaryField = {
					type: 'singleDictionaryField',
					name: name,
					value: jsonValueToJulAst(value) as any,
					...position,
				};
				return field;
			});
			// Wie beim JUL-Parser verweist das Symbol auf das Feld, der Wert wird nur einmal gebaut.
			const symbols = createSymbolTable();
			fillSymbolTableWithFields(symbols, [], fields, false);
			const dictionary: ParseDictionaryLiteral = {
				type: 'dictionary',
				fields: fields as any,
				symbols: symbols,
				...position,
			};
			return dictionary;
		}
		case 'string':
			return {
				type: 'text',
				values: [{
					type: 'textToken',
					value: jsonValue,
				}],
				...position,
			};
		case 'undefined':
			return {
				type: 'empty',
				...position,
			};
		default:
			throw new Error(`Unexpected jsonValue type: ${typeof jsonValue}`);
	}
}