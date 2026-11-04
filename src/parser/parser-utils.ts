import { ParseBindingExpression, DefinitionExpression, forEachChild, getNodeSymbols, ParseBranching, ParseDestructuringField, ParseDictionaryField, ParseDictionaryTypeField, ParseExpression, ParseFieldBase, ParseFunctionCall, ParseFunctionLiteral, ParseFunctionTypeLiteral,ParseParameterField, ParseParameterFields, ParseValueExpression, PositionedExpression, PositionedExpressionBase, Purity, SimpleExpression, SymbolDefinition, SymbolTable, TypedExpression, createSymbolTable, discardName } from "../syntax-tree.js";
import { forEach, last } from "../util.js";
import { CompilerError, ErrorCode, Positioned } from '../compiler-errors.js';

export function createParseParameters(
	singleFields: ParseParameterField[],
	rest: ParseParameterField | undefined,
	position: Positioned,
	errors: CompilerError[],
): ParseParameterFields {
	const symbols = createSymbolTable();
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
		if (field.name.name === discardName) {
			return;
		}
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
	if (rest
		&& rest.name.name !== discardName) {
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
	writtenBody: ParseExpression[],
	position: Positioned,
	errors: CompilerError[],
	arrow?: Purity,
	isRestOfBlock?: true,
): ParseFunctionLiteral {
	const body = checkAndSplitBody(writtenBody, errors);
	const symbols = createSymbolTable();
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
	if (isRestOfBlock) {
		return { ...functionLiteral, isRestOfBlock: true };
	}
	return functionLiteral;
}

//#region Anweisungen

/**
 * Prüft die Anweisungen eines Funktionsrumpfs und hängt den Rest hinter dem ersten Branching als
 * Anweisung als dessen letzten Branch an (ParseFunctionLiteral.isRestOfBlock). Passt ein Arm, ist
 * sein Wert das Ergebnis der Funktion, sonst geht es mit dem Rest weiter. Rekursiv über
 * createParseFunctionLiteral, der Rest kann selbst wieder Branchings enthalten.
 */
function checkAndSplitBody(body: ParseExpression[], errors: CompilerError[]): ParseExpression[] {
	const lastIndex = body.length - 1;
	for (let index = 0; index <= lastIndex; index++) {
		const statement = body[index]!;
		switch (statement.type) {
			case 'functionLiteral':
				if (index < lastIndex) {
					errors.push({
						code: ErrorCode.unusedFunctionLiteral,
						message: 'This function is never used. A branch must be indented below its branching.',
						startRowIndex: statement.startRowIndex,
						startColumnIndex: statement.startColumnIndex,
						endRowIndex: statement.endRowIndex,
						endColumnIndex: statement.endColumnIndex,
					});
				}
				break;
			case 'definition':
				if (index === lastIndex
					&& statement.name.name === discardName) {
					errors.push({
						code: ErrorCode.discardAsResult,
						message: `'${discardName}' can not be the result. The last expression of a function is its result.`,
						startRowIndex: statement.name.startRowIndex,
						startColumnIndex: statement.name.startColumnIndex,
						endRowIndex: statement.name.endRowIndex,
						endColumnIndex: statement.name.endColumnIndex,
					});
				}
				break;
			case 'branching': {
				statement.branches.forEach(branch => {
					if (isCatchAllBranch(branch)) {
						errors.push({
							code: ErrorCode.catchAllInStatementBranching,
							message: 'A branching as a statement can not have a catch-all branch. Write the default case below the branching, one level less indented.',
							startRowIndex: branch.params.startRowIndex,
							startColumnIndex: branch.params.startColumnIndex,
							endRowIndex: branch.params.endRowIndex,
							endColumnIndex: branch.params.endColumnIndex,
						});
					}
				});
				if (index === lastIndex) {
					break;
				}
				const rest = body.slice(index + 1);
				const restStart = rest[0]!;
				const restEnd = last(rest)!;
				const restParams = createParseParameters([], undefined, {
					startRowIndex: restStart.startRowIndex,
					startColumnIndex: 0,
					endRowIndex: restStart.startRowIndex,
					endColumnIndex: 0,
				}, errors);
				const restBranch = createParseFunctionLiteral(
					restParams,
					undefined,
					rest,
					{
						startRowIndex: restStart.startRowIndex,
						startColumnIndex: restStart.startColumnIndex,
						endRowIndex: restEnd.endRowIndex,
						endColumnIndex: restEnd.endColumnIndex,
					},
					errors,
					undefined,
					true);
				// Das Branching umfasst den Rest, sonst fände die Suche nach der Cursorposition im
				// Language Server den Rest nicht unter seinem Branch.
				const branching: ParseBranching = {
					...statement,
					branches: [...statement.branches, restBranch],
					endRowIndex: restEnd.endRowIndex,
					endColumnIndex: restEnd.endColumnIndex,
				};
				return [...body.slice(0, index), branching];
			}
			default:
				break;
		}
	}
	return body;
}

/**
 * Ein Branch, der jede Argumentkollektion annimmt: `() =>`, `Any =>` oder eine Parameterliste ohne
 * Typen (bzw. nur mit `Any`). Steht der Arm nicht als Funktionsliteral da, ist das an der Syntax
 * nicht zu erkennen.
 */
function isCatchAllBranch(branch: ParseValueExpression): branch is ParseFunctionLiteral {
	if (branch.type !== 'functionLiteral') {
		return false;
	}
	const params = branch.params;
	switch (params.type) {
		case 'reference':
			return isAnyReference(params);
		case 'parameters': {
			const fields = params.rest
				? [...params.singleFields, params.rest]
				: params.singleFields;
			return fields.every(field => !field.typeGuard || isAnyReference(field.typeGuard));
		}
		default:
			return false;
	}
}

function isAnyReference(expression: ParseValueExpression): boolean {
	return expression.type === 'reference'
		&& expression.name.name === 'Any';
}

/**
 * Auf oberster Dateiebene gibt es keine Funktion, die ein Branching als Anweisung verlassen könnte.
 */
export function checkTopLevelStatements(expressions: ParseExpression[], errors: CompilerError[]): void {
	expressions.forEach(expression => {
		if (expression.type !== 'branching') {
			return;
		}
		errors.push({
			code: ErrorCode.statementBranchingAtTopLevel,
			message: `A branching can not be a top-level statement. Write '${discardName} = ?(…)' for a conditional side effect.`,
			startRowIndex: expression.startRowIndex,
			startColumnIndex: expression.startColumnIndex,
			endRowIndex: expression.startRowIndex,
			endColumnIndex: expression.args
				&& expression.args.endRowIndex === expression.startRowIndex
				? expression.args.endColumnIndex
				: expression.startColumnIndex + 1,
		});
	});
}

//#endregion Anweisungen

export function createParseFunctionTypeLiteral(
	params: SimpleExpression | ParseParameterFields,
	returnType: ParseValueExpression,
	arrow: Purity,
	position: Positioned,
	errors: CompilerError[],
): ParseFunctionTypeLiteral {
	const symbols = createSymbolTable();
	if (params.type === 'binding'
		|| params.type === 'parameters') {
		fillSymbolTableWithParams(symbols, errors, params);
	}
	return {
		type: 'functionTypeLiteral',
		params: params,
		returnType: returnType,
		symbols: symbols,
		arrow: arrow,
		...position,
	};
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
				if (expression.name.name === discardName) {
					return;
				}
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

function fillSymbolTableWithParams(
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
		// Ein Dictionary-Feld namens _ ist ein Schlüssel, keine Bindung.
		if (name === discardName
			&& (isFunctionParameter || field.type === 'destructuringField')) {
			return;
		}
		defineSymbol(
			symbolTable,
			errors,
			name,
			field,
			field.name,
			'typeGuard' in field ? field.typeGuard : undefined,
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
 * Setzt die parent-Kette und vergibt Ids an die Knoten und an die Symbole ihrer Symboltabellen, über
 * den fertigen Baum einer Datei. Knoten und Symbole zählen getrennt, je dicht ab 0 in Vorordnung,
 * Rückgabe ist die Anzahl je Raum (siehe CheckResult). Die Symboltabelle der Datei entsteht erst
 * danach, ihre Ids vergibt setFileSymbolIds.
 * Nachgelagert und nicht beim Bauen: derselbe Parser-Pfad laeuft mehrfach ueber dieselbe Eingabe
 * und reicht die inneren Ergebnisse weiter, eine Huelle steht also noch nicht fest, waehrend ihre
 * Kinder schon existieren. Wer parent beim Bauen setzt, schreibt auf ein Objekt, dessen
 * Zugehoerigkeit noch offen ist (TypeScript setzt parent aus demselben Grund nachgelagert;
 * Roslyn und rust-analyzer speichern ihn im geteilten Baum gar nicht erst).
 * Die Id vor parent, damit Wurzeln (nur id) und Kinder (id, parent) dieselbe Kette von Formen
 * durchlaufen.
 */
export function setParentsAndIds(expressions: readonly PositionedExpression[]): {
	nodeCount: number;
	symbolCount: number;
} {
	let nextId = 0;
	let nextSymbolId = 0;
	const visit = (expression: PositionedExpression): undefined => {
		const symbols = getNodeSymbols(expression);
		if (symbols) {
			nextSymbolId = setSymbolIds(symbols, nextSymbolId);
		}
		forEachChild(expression, child => {
			child.id = nextId++;
			child.parent = expression;
			visit(child);
			return undefined;
		});
		return undefined;
	};
	expressions.forEach(expression => {
		expression.id = nextId++;
		visit(expression);
	});
	return {
		nodeCount: nextId,
		symbolCount: nextSymbolId,
	};
}

/**
 * Vergibt Ids an die Symbole der Datei, im Anschluss an die Symbole der Knoten (ab firstId).
 * Rückgabe ist die Anzahl der Symbole.
 */
export function setFileSymbolIds(fileSymbols: SymbolTable, firstId: number): number {
	return setSymbolIds(fileSymbols, firstId);
}

function setSymbolIds(symbols: SymbolTable, firstId: number): number {
	let nextId = firstId;
	for (const name in symbols) {
		symbols[name]!.id = nextId++;
	}
	return nextId;
}
//#region test

/**
 * Name- und Callback-Argument eines test-Aufrufs, positionell, mit Präfix-Argument oder benannt.
 * Fehlt eines, ist es undefined. Ein Spread zählt nicht als Argument.
 */
export function getTestCallArguments(call: ParseFunctionCall): {
	name: ParseValueExpression | undefined;
	callback: ParseValueExpression | undefined;
} {
	const args = call.arguments;
	if (args?.type === 'dictionary') {
		const getField = (fieldName: string) => args.fields.find(field =>
			field.type === 'singleDictionaryField'
			&& getCheckedEscapableName(field.name) === fieldName)?.value;
		return { name: getField('name'), callback: getField('callback') };
	}
	const values: (ParseValueExpression | undefined)[] = call.prefixArgument
		? [call.prefixArgument]
		: [];
	if (args?.type === 'list') {
		args.values.forEach(value => {
			values.push(value.type === 'spread' ? undefined : value);
		});
	}
	return { name: values[0], callback: values[1] };
}

/**
 * Der Name eines test-Aufrufs, sofern er ein Text-Literal ohne Interpolation ist. Nur dann steht
 * er ohne Lauf fest und taugt als Identität des Tests.
 */
export function getTestName(call: ParseFunctionCall): string | undefined {
	const name = getTestCallArguments(call).name;
	if (name?.type !== 'text') {
		return undefined;
	}
	let text = '';
	for (const value of name.values) {
		if (value.type !== 'textToken') {
			return undefined;
		}
		text += value.value;
	}
	return text;
}

//#endregion test

//#region Elternkette

/** Der Name der Definition, deren Wert der Ausdruck ist. */
export function getNameFromValue(expression: TypedExpression): string | undefined {
	if (expression.parent?.type === 'definition'
		&& expression.parent.value === expression) {
		return expression.parent.name.name;
	}
}

export function isInsideFunctionLiteral(expression: TypedExpression): boolean {
	for (let parent = expression.parent; parent; parent = parent.parent) {
		if (parent.type === 'functionLiteral') {
			return true;
		}
	}
	return false;
}

//#endregion Elternkette

//#region and/or

/**
 * Ein Aufruf von and bzw. or mit direkt aufgeführten Argumenten. Der Name allein genügt, weil sich
 * Builtins nicht überdecken lassen (JUL3203). Der Emitter macht daraus && bzw. ||, der Checker
 * verengt über die Operanden.
 */
export interface Junction {
	readonly jsOperator: '&&' | '||';
	/**
	 * Hat das Ergebnis diesen Wert, haben ihn alle Operanden: true bei and, false bei or. Beim anderen
	 * Wert steht nicht fest, welcher Operand ihn geliefert hat.
	 */
	readonly sharedResult: boolean;
	/** Das Präfix-Argument und die Argumente, in Auswertungsreihenfolge. */
	readonly operands: ParseValueExpression[];
}

/**
 * undefined, wenn der Aufruf kein and/or ist oder seine Argumente nicht einzeln dastehen: Bei Spread
 * und benannten Argumenten lässt sich kein Operand einem Ausdruck zuordnen.
 */
export function getJunction(call: ParseFunctionCall): Junction | undefined {
	const functionExpression = call.functionExpression;
	const args = call.arguments;
	if (functionExpression?.type !== 'reference'
		|| args?.type !== 'list') {
		return undefined;
	}
	const name = functionExpression.name.name;
	if (name !== 'and'
		&& name !== 'or') {
		return undefined;
	}
	if (args.values.some(value => value.type === 'spread')) {
		return undefined;
	}
	const values = args.values as ParseValueExpression[];
	return {
		jsOperator: name === 'and' ? '&&' : '||',
		sharedResult: name === 'and',
		operands: call.prefixArgument
			? [call.prefixArgument, ...values]
			: values,
	};
}

//#endregion and/or
