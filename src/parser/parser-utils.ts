import { BracketedExpressionBase, DefinitionExpression, ParseDictionaryField, ParseDictionaryLiteral, ParseDictionaryTypeField, ParseDictionaryTypeLiteral, ParseExpression, ParseFieldBase, ParseFunctionLiteral, ParseParameterField, ParseParameterFields, ParseValueExpression, PositionedExpression, PositionedExpressionBase, SimpleExpression, SymbolTable } from "../syntax-tree.js";
import { forEach } from "../util.js";
import { ParserError, Positioned } from "./parser-combinator.js";

export function createParseParameters(
	singleFields: ParseParameterField[],
	rest: ParseParameterField | undefined,
	position: Positioned,
	errors: ParserError[],
): ParseParameterFields {
	const symbols: SymbolTable = {};
	const parameters: ParseParameterFields = {
		type: 'parameters',
		singleFields: singleFields,
		rest: rest,
		symbols: symbols,
		startRowIndex: position.startRowIndex,
		startColumnIndex: position.startColumnIndex,
		endRowIndex: position.endRowIndex,
		endColumnIndex: position.endColumnIndex,
	};
	singleFields.forEach((field, index) => {
		defineSymbol(
			symbols,
			errors,
			field.name.name,
			field,
			field.name,
			field.typeGuard,
			field.description,
			index);
		setParent(field, parameters);
	});
	if (rest) {
		defineSymbol(
			symbols,
			errors,
			rest.name.name,
			rest,
			rest.name,
			rest.typeGuard,
			rest.description,
			undefined);
		setParent(rest, parameters);
	}
	return parameters;
}

export function createParseFunctionLiteral(
	params: SimpleExpression | ParseParameterFields,
	returnType: ParseValueExpression | undefined,
	body: ParseExpression[],
	position: Positioned,
	errors: ParserError[],
): ParseFunctionLiteral {
	const symbols: SymbolTable = {};
	if (params.type === 'bracketed'
		|| params.type === 'parameters') {
		fillSymbolTableWithParams(symbols, errors, params);
	}
	fillSymbolTableWithExpressions(symbols, errors, body);
	const functionLiteral: ParseFunctionLiteral = {
		type: 'functionLiteral',
		params: params,
		returnType: returnType,
		body: body,
		symbols: symbols,
		...position,
	};
	setParent(params, functionLiteral);
	return functionLiteral;
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
					expression,
					expression.name,
					expression.value,
					expression.description,
					undefined);
				return;
			}
			case 'destructuring': {
				// TODO type über value ermitteln
				fillSymbolTableWithFields(symbolTable, errors, expression.fields.fields, false);
				return;
			}
			default:
				return;
		}
	});
}

export function fillSymbolTableWithParams(
	symbolTable: SymbolTable,
	errors: ParserError[],
	params: BracketedExpressionBase | ParseParameterFields,
): void {
	if (params.type === 'bracketed') {
		fillSymbolTableWithFields(
			symbolTable,
			errors,
			params.fields,
			true);
	}
	else {
		forEach(params.symbols, (symbol, name) => {
			symbolTable[name] = symbol;
		});
	}
}

export function fillSymbolTableWithFields(
	symbolTable: SymbolTable,
	errors: ParserError[],
	fields: (ParseDictionaryField | ParseDictionaryTypeField | ParseFieldBase | ParseParameterField)[],
	isFunctionParameter: boolean,
): void {
	fields.forEach((field, index) => {
		if (field.type === 'spread') {
			// TODO?
			return;
		}
		const name = getCheckedEscapableName(field.name);
		if (!name) {
			// TODO error?
			return;
		}
		defineSymbol(
			symbolTable,
			errors,
			name,
			field,
			field.name,
			field.typeGuard,
			field.description,
			isFunctionParameter ? index : undefined,
		);
	});
}

function defineSymbol(
	symbolTable: SymbolTable,
	errors: ParserError[],
	name: string,
	definition: DefinitionExpression,
	namePosition: Positioned,
	type: ParseValueExpression | undefined,
	description: string | undefined,
	functionParameterIndex: number | undefined,
): void {
	if (symbolTable[name]) {
		errors.push({
			message: `${name} is already defined`,
			startRowIndex: namePosition.startRowIndex,
			startColumnIndex: namePosition.startColumnIndex,
			endRowIndex: namePosition.endRowIndex,
			endColumnIndex: namePosition.endColumnIndex,
		});
	}
	symbolTable[name] = {
		definition: definition,
		description: description,
		typeExpression: type,
		functionParameterIndex: functionParameterIndex,
		startRowIndex: namePosition.startRowIndex,
		startColumnIndex: namePosition.startColumnIndex,
		endRowIndex: namePosition.endRowIndex,
		endColumnIndex: namePosition.endColumnIndex,
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