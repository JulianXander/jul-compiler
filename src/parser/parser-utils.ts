import { ParseBindingExpression, DefinitionExpression, forEachChild, ParseDestructuringField, ParseDictionaryField, ParseDictionaryTypeField, ParseExpression, ParseFieldBase, ParseFunctionLiteral, ParseParameterField, ParseParameterFields, ParseValueExpression, PositionedExpression, PositionedExpressionBase, Purity, SimpleExpression, SymbolDefinition, SymbolTable } from "../syntax-tree.js";
import { forEach } from "../util.js";
import { CompilerError, ErrorCode, Positioned } from '../compiler-errors.js';

export function createParseParameters(
	singleFields: ParseParameterField[],
	rest: ParseParameterField | undefined,
	position: Positioned,
	errors: CompilerError[],
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
			singleFields.length);
	}
	return parameters;
}

export function createParseFunctionLiteral(
	params: SimpleExpression | ParseParameterFields,
	returnType: ParseValueExpression | undefined,
	body: ParseExpression[],
	position: Positioned,
	errors: CompilerError[],
	arrow?: Purity,
): ParseFunctionLiteral {
	const symbols: SymbolTable = {};
	if (params.type === 'binding'
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
		arrow: arrow,
		...position,
	};
	return functionLiteral;
}

//#region SymbolTable

export function fillSymbolTableWithExpressions(
	symbolTable: SymbolTable,
	errors: CompilerError[],
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

/**
 * Was eine Datei beim Import anbietet: ihre Top-Level-Definitionen. Destructuring bindet lokal,
 * auch als Import - der Emitter exportiert es nicht, sonst würde jeder Import zum Re-Export.
 */
export function getExportedSymbols(fileSymbols: SymbolTable): SymbolTable {
	const exported: SymbolTable = {};
	forEach(fileSymbols, (symbol, name) => {
		if (isExportedSymbol(symbol)) {
			exported[name] = symbol;
		}
	});
	return exported;
}

/**
 * Für ein Symbol aus der Top-Level-Symboltabelle einer Datei, siehe getExportedSymbols.
 */
export function isExportedSymbol(fileSymbol: SymbolDefinition): boolean {
	return fileSymbol.definition?.type === 'definition';
}

export function fillSymbolTableWithParams(
	symbolTable: SymbolTable,
	errors: CompilerError[],
	params: ParseBindingExpression | ParseParameterFields,
): void {
	if (params.type === 'binding') {
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
	errors: CompilerError[],
	fields: (ParseDestructuringField | ParseDictionaryField | ParseDictionaryTypeField | ParseFieldBase | ParseParameterField)[],
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
	errors: CompilerError[],
	name: string,
	definition: DefinitionExpression,
	namePosition: Positioned,
	type: ParseValueExpression | undefined,
	description: string | undefined,
	functionParameterIndex: number | undefined,
): void {
	if (symbolTable[name]) {
		errors.push({
			code: ErrorCode.alreadyDefined,
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

/**
 * Setzt die parent-Kette ueber den fertigen Baum.
 * Nachgelagert und nicht beim Bauen: derselbe Parser-Pfad laeuft mehrfach ueber dieselbe Eingabe
 * und reicht die inneren Ergebnisse weiter, eine Huelle steht also noch nicht fest, waehrend ihre
 * Kinder schon existieren. Wer parent beim Bauen setzt, schreibt auf ein Objekt, dessen
 * Zugehoerigkeit noch offen ist (TypeScript setzt parent aus demselben Grund nachgelagert;
 * Roslyn und rust-analyzer speichern ihn im geteilten Baum gar nicht erst).
 */
export function setParentsRecursive(expression: PositionedExpression): void {
	forEachChild(expression, child => {
		child.parent = expression;
		setParentsRecursive(child);
		return undefined;
	});
}