import { BracketedExpressionBase, Name, ParseDictionaryLiteral, ParseDictionaryTypeLiteral, ParseExpression, ParseFieldBase, ParseFunctionLiteral, ParseParameterField, ParseParameterFields, ParseValueExpression, ParseValueExpressionBase, PositionedExpression, PositionedExpressionBase, SimpleExpression, SymbolDefinition, SymbolTable } from "../syntax-tree.js";
import { ParserError, Positioned } from "./parser-combinator.js";

export function createParseParameters(
	singleFields: ParseParameterField[],
	rest: ParseParameterField | undefined,
	position: Positioned,
	errors: ParserError[],
): ParseParameterFields {
	const symbols: SymbolTable = {};
	singleFields.forEach((field, index) => {
		defineSymbol(
			symbols,
			errors,
			field.name.name,
			field.name,
			// TODO
			field.typeGuard as any,
			field.description,
			index);
	});
	if (rest) {
		defineSymbol(
			symbols,
			errors,
			rest.name.name,
			rest.name,
			// TODO
			rest.typeGuard as any,
			rest.description,
			undefined);
	}
	return {
		type: 'parameters',
		singleFields: singleFields,
		rest: rest,
		symbols: symbols,
		startRowIndex: position.startRowIndex,
		startColumnIndex: position.startColumnIndex,
		endRowIndex: position.endRowIndex,
		endColumnIndex: position.endColumnIndex,
	};
}

export function createParseFunctionLiteral(
	params: SimpleExpression | ParseParameterFields,
	returnType: ParseValueExpression | undefined,
	body: ParseExpression[],
	position: Positioned,
	errors: ParserError[],
): ParseFunctionLiteral {
	const symbols: SymbolTable = params.type === 'parameters'
		? {
			...params.symbols,
		}
		: {};
	if (params.type === 'bracketed') {
		fillSymbolTableWithDictionaryType(symbols, errors, params, true);
	}
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
				defineSymbol(
					symbolTable,
					errors,
					expression.name.name,
					expression.name,
					expression.value,
					expression.description,
					undefined);
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
	const name = getCheckedEscapableName(field.name);
	if (!name) {
		// TODO error?
		return;
	}
	defineSymbol(
		symbolTable,
		errors,
		name,
		field.name,
		// TODO check type
		field.typeGuard as any,
		field.description,
		functionParameterIndex,
	);
}

function defineSymbol(
	symbolTable: SymbolTable,
	errors: ParserError[],
	name: string,
	position: Positioned,
	type: ParseValueExpression | undefined,
	description: string | undefined,
	functionParameterIndex: number | undefined,
): void {
	if (symbolTable[name]) {
		errors.push({
			message: `${name} is already defined`,
			startRowIndex: position.startRowIndex,
			startColumnIndex: position.startColumnIndex,
			endRowIndex: position.endRowIndex,
			endColumnIndex: position.endColumnIndex,
		});
	}
	symbolTable[name] = {
		typeExpression: type,
		description: description,
		functionParameterIndex: functionParameterIndex,
		startRowIndex: position.startRowIndex,
		startColumnIndex: position.startColumnIndex,
		endRowIndex: position.endRowIndex,
		endColumnIndex: position.endColumnIndex,
	};
}

//#endregion SymbolTable

export function getCheckedEscapableName(parseName: PositionedExpression): string | undefined {
	switch (parseName.type) {
		case 'reference':
			return parseName.name.name;
		case 'name':
			return parseName.name;
		case 'text':
			if (parseName.values.length > 1) {
				return undefined;
			}
			const value = parseName.values[0];
			if (value?.type !== 'textToken') {
				return undefined;
			}
			return value.value;
		default:
			return undefined;
	}
}

export function setParent(expression: PositionedExpressionBase | undefined, parent: PositionedExpression): void {
	if (expression) {
		expression.parent = parent;
	}
}

export function setParentForFields(dictionary: ParseDictionaryLiteral | ParseDictionaryTypeLiteral): void {
	dictionary.fields.forEach(field => {
		setParent(field, dictionary);
	});
}