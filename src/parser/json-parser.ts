import { JsonValue } from "../runtime.js";
import { Name, ParseDictionaryLiteral, ParseExpression, ParseSingleDictionaryField, ParsedExpressions, ParsedFile, SymbolDefinition } from "../syntax-tree.js";
import { mapDictionary } from "../util.js";
import { Positioned } from "./parser-combinator.js";
import { setParent, setParents } from "./parser-utils.js";

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
				inferredType: null,
				dereferencedType: null,
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
				inferredType: null,
				dereferencedType: null,
			};
		case 'object': {
			if (jsonValue === null) {
				return {
					type: 'empty',
					...position,
					inferredType: null,
					dereferencedType: null,
				};
			}
			if (Array.isArray(jsonValue)) {
				return {
					type: 'list',
					values: jsonValue.map(jsonValueToJulAst) as any,
					...position,
					inferredType: null,
					dereferencedType: null,
				};
			}
			const dictionary: ParseDictionaryLiteral = {
				type: 'dictionary',
				fields: Object.entries(jsonValue).map(([key, value]) => {
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
					setParent(name, field);
					return field;
				}) as any,
				symbols: mapDictionary(jsonValue as { [key: string]: JsonValue; }, (value, key) => {
					const symbolDefinition: SymbolDefinition = {
						// TODO definition? zumindest range für DocumentSymbol?
						typeExpression: jsonValueToJulAst(value) as any,
						...position,
						inferredType: null,
						dereferencedType: null,
					};
					return symbolDefinition;
				}),
				...position,
				inferredType: null,
				dereferencedType: null,
			};
			setParents(dictionary.fields, dictionary);
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
				inferredType: null,
				dereferencedType: null,
			};
		case 'undefined':
			return {
				type: 'empty',
				...position,
				inferredType: null,
				dereferencedType: null,
			};
		default:
			throw new Error(`Unexpected jsonValue type: ${typeof jsonValue}`);
	}
}