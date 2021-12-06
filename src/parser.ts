import {
	BracketedExpression,
	BracketedExpressionBase,
	Index,
	Name,
	NumberLiteral,
	ParseBranching,
	ParseDestructuringDefinition,
	ParsedFile,
	ParseExpression,
	ParseFieldBase,
	ParseFunctionCall,
	ParseFunctionLiteral,
	ParseSingleDefinition,
	ParseSingleDictionaryField,
	ParseSpreadDictionaryField,
	ParseStringLiteral,
	ParseValueExpression,
	ParseValueExpressionBase,
	Reference,
	SimpleExpression,
	SymbolTable,
} from './syntax-tree';
import {
	choiceParser,
	discriminatedChoiceParser,
	emptyParser,
	endOfCodeError,
	incrementIndent,
	mapParser,
	moveColumnIndex,
	moveToNextLine,
	multiplicationParser,
	Parser,
	ParserError,
	ParserResult,
	regexParser,
	sequenceParser,
	tokenParser,
} from './parser-combinator';
import {
	NonEmptyArray,
} from './util';

export function parseCode(code: string): ParsedFile {
	const rows = code.split('\n');
	const parserResult = expressionBlockParser(rows, 0, 0, 0);
	const expressions = parserResult.parsed;
	const errors = [
		...(parserResult.errors ?? [])
	];
	// check end of code reached
	if (parserResult.endRowIndex !== rows.length) {
		errors.push({
			message: 'Failed to parse until end of code',
			startRowIndex: parserResult.endRowIndex,
			startColumnIndex: parserResult.endColumnIndex,
			endRowIndex: parserResult.endRowIndex,
			endColumnIndex: parserResult.endColumnIndex,
		});
	}
	const symbols: SymbolTable = {};
	expressions && fillSymbolTableWithExpressions(symbols, errors, expressions);
	return {
		errors: errors,
		expressions: expressions,
		symbols: symbols,
	};
}

//#region SymbolTable

function fillSymbolTableWithExpressions(
	symbolTable: SymbolTable,
	errors: ParserError[],
	expressions: ParseExpression[],
): void {
	expressions.forEach(expression => {
		switch (expression.type) {
			case 'definition': {
				// TODO type
				defineSymbol(symbolTable, errors, expression.name, expression.value, expression.description);
				return;
			}

			case 'destructuring': {
				// TODO type über value ermitteln
				fillSymbolTableWithDictionaryType(symbolTable, errors, expression.fields);
				return;
			}

			default:
				return;
		}
	});
}

function fillSymbolTableWithDictionaryType(
	symbolTable: SymbolTable,
	errors: ParserError[],
	dictionaryType: BracketedExpressionBase,
): void {
	dictionaryType.fields.forEach(field => {
		defineSymbolsForField(symbolTable, errors, field);
	});
}

function defineSymbolsForField(
	symbolTable: SymbolTable,
	errors: ParserError[],
	field: ParseFieldBase,
): void {
	if (field.spread) {
		// TODO spread
	}
	else {
		defineSymbol(
			symbolTable,
			errors,
			// TODO check field.name type
			field.name as any,
			// TODO type
			field.typeGuard as any,
			field.description,
		);
	}
}

function defineSymbol(
	symbolTable: SymbolTable,
	errors: ParserError[],
	name: Name,
	type: ParseValueExpression,
	description: string | undefined,
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
		type: type,
		description: description,
		startRowIndex: name.startRowIndex,
		startColumnIndex: name.startColumnIndex,
		endRowIndex: name.endRowIndex,
		endColumnIndex: name.endColumnIndex,
	};
}

//#endregion SymbolTable

//#region Tokens

const spaceParser = tokenParser(' ');
const openingBracketParser = tokenParser('(');
const closingBracketParser = tokenParser(')');
const paragraphParser = tokenParser('§');
// SVO InfixFunctionCall
const infixFunctionTokenParser = tokenParser('.');
const branchingTokenParser = tokenParser(' ?');
const functionTokenParser = tokenParser(' =>');
const definitionTokenParser = tokenParser(' = ');

//#endregion Tokens

//#region utility parser

/**
 * Liefert ParserErrorResult bei endOfCode
 */
function checkEndOfCode(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	searched: string,
): ParserResult<never> | undefined {
	if (startRowIndex >= rows.length) {
		return {
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: [{
				message: endOfCodeError(searched),
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: startRowIndex,
				endColumnIndex: startColumnIndex,
			}]
		};
	}
}

/**
 * parst 0 Zeichen
 */
function startOfLineParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<undefined> {
	if (startColumnIndex !== 0) {
		return {
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: [{
				message: `columnIndex=${startColumnIndex}, but should be at start of line`,
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: startRowIndex,
				endColumnIndex: startColumnIndex,
			}],
		};
	}
	return {
		endRowIndex: startRowIndex,
		endColumnIndex: startColumnIndex,
	};
}

/**
 * parst 0 Zeichen
 */
function endOfLineParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<undefined> {
	const row = rows[startRowIndex];
	const rowLength = row!.length;
	if (startColumnIndex !== rowLength) {
		return {
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: [{
				message: `columnIndex=${startColumnIndex}, but should be at end of line (${rowLength})`,
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: startRowIndex,
				endColumnIndex: startColumnIndex,
			}],
		};
	}
	return {
		endRowIndex: startRowIndex,
		endColumnIndex: startColumnIndex,
	};
}

/**
 * Verschiebt den Start in den Anfang der nächsten Zeilen.
 */
function newLineParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<undefined> {
	const result = endOfLineParser(rows, startRowIndex, startColumnIndex, indent);
	if (result.errors?.length) {
		return result;
	}
	return {
		endRowIndex: startRowIndex + 1,
		endColumnIndex: 0,
	};
}

function indentParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<undefined> {
	const startOfLineResult = startOfLineParser(rows, startRowIndex, startColumnIndex, indent);
	if (startOfLineResult.errors?.length) {
		return startOfLineResult;
	}
	const totalIndentToken = '\t'.repeat(indent);
	const indentResult = tokenParser(totalIndentToken)(rows, startRowIndex, startColumnIndex, indent);
	return indentResult;
}

/**
 * Beginnt mit columnIndex = 0.
 * Parst undefined bei Leerzeile.
 * Parst string bei Kommentarzeile.
 * Enthält ggf. endständiges Zeilenende nicht.
 * TODO comment in AST für Intellisense?
 */
function multilineParser<T>(parser: Parser<T>): Parser<(T | string | undefined)[]> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		const startOfLineResult = startOfLineParser(rows, startRowIndex, startColumnIndex, indent);
		if (startOfLineResult.errors?.length) {
			return {
				endRowIndex: startOfLineResult.endRowIndex,
				endColumnIndex: startOfLineResult.endColumnIndex,
				errors: startOfLineResult.errors,
			};
		}
		const parsed: (T | string | undefined)[] = [];
		const errors: ParserError[] = [];
		let rowIndex = startRowIndex;
		let columnIndex = 0;
		for (; rowIndex < rows.length; rowIndex++) {
			columnIndex = 0;
			const row = rows[rowIndex];
			if (row === undefined) {
				throw new Error(`row[${rowIndex}] missing`);
			}
			if (row === '') {
				// Leerzeile
				parsed.push(undefined);
				continue;
			}
			const indentResult = indentParser(rows, rowIndex, columnIndex, indent);
			columnIndex = indentResult.endColumnIndex;
			if (indentResult.errors?.length) {
				const endRowIndex = rowIndex - 1;
				const endRow = rows[endRowIndex];
				if (endRow === undefined) {
					throw new Error(`row[${endRowIndex}] missing`);
				}
				// Ende des Blocks
				return {
					endRowIndex: endRowIndex,
					endColumnIndex: endRow!.length,
					parsed: parsed,
					errors: errors,
				};
			}
			if (row[columnIndex] === '#') {
				// Kommentarzeile
				const comment = row.substring(columnIndex + 1);
				parsed.push(comment);
				continue;
			}
			const result = parser(rows, rowIndex, columnIndex, indent);
			rowIndex = result.endRowIndex;
			if (result.errors?.length) {
				errors.push(...result.errors);
				// fehlerhafte Zeile überspringen und in nächster Zeile weiterparsen
				continue;
			}
			parsed.push(result.parsed);
			// check columnIndex at endindex
			const endRow = rows[rowIndex];
			if (endRow === undefined) {
				// Ende des Codes
				break;
			}
			if (result.endColumnIndex !== endRow.length) {
				errors.push({
					message: 'multilineParser should parse until end of row',
					startRowIndex: rowIndex,
					startColumnIndex: result.endColumnIndex,
					endRowIndex: rowIndex,
					endColumnIndex: result.endColumnIndex,
				});
				// fehlerhafte Zeile überspringen und in nächster Zeile weiterparsen
				continue;
			}
		}
		// Ende des Codes
		return {
			endRowIndex: rowIndex,
			endColumnIndex: columnIndex,
			parsed: parsed,
			errors: errors,
		};
	};
}

//#endregion utility parser

//#region expression parser

/**
 * enthält ggf. endständiges Zeilenende nicht
 */
function expressionBlockParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseExpression[]> {
	const endOfCodeError = checkEndOfCode(rows, startRowIndex, startColumnIndex, 'expressionBlock');
	if (endOfCodeError) {
		return endOfCodeError;
	}
	const result = multilineParser(expressionParser)(rows, startRowIndex, startColumnIndex, indent);
	const expressions = result.parsed && assignDescriptions(result.parsed);
	return {
		...result,
		parsed: expressions
	};
}

function expressionParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseExpression> {
	const result = fieldParser(rows, startRowIndex, startColumnIndex, indent);
	const parsed = result.parsed;
	if (!parsed) {
		return {
			...result,
			parsed: undefined
		};
	}
	const errors = result.errors ?? [];
	const baseName = parsed.name;
	// bei name = BracketedExpression und assignedValue: DestructuringDefinition
	// bei name = ref und assignedValue: SingleDefinition
	// bei alles außer name leer: valueExpression
	// sonst fehler
	if ((baseName.type === 'bracketed') && parsed.assignedValue) {
		if (parsed.spread) {
			errors.push({
				message: 'rest not allowed for destructuring',
				startRowIndex: parsed.startRowIndex,
				startColumnIndex: parsed.startColumnIndex,
				endRowIndex: parsed.startRowIndex,
				endColumnIndex: parsed.startColumnIndex + 3,
			});
		}
		if (parsed.typeGuard) {
			errors.push({
				message: 'typeGuard not allowed for destructuring',
				startRowIndex: parsed.typeGuard.startRowIndex,
				startColumnIndex: parsed.typeGuard.startColumnIndex,
				endRowIndex: parsed.typeGuard.endRowIndex,
				endColumnIndex: parsed.typeGuard.endColumnIndex,
			});
		}
		if (parsed.fallback) {
			errors.push({
				message: 'typeGuard not allowed for destructuring',
				startRowIndex: parsed.fallback.startRowIndex,
				startColumnIndex: parsed.fallback.startColumnIndex,
				endRowIndex: parsed.fallback.endRowIndex,
				endColumnIndex: parsed.fallback.endColumnIndex,
			});
		}
		bracketedExpressionToDestructuringFields(baseName, errors);
		const destructuring: ParseDestructuringDefinition = {
			type: 'destructuring',
			fields: baseName,
			value: parsed.assignedValue,
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
		};
		return {
			...result,
			errors: errors,
			parsed: destructuring,
		};
	}
	if (baseName.type === 'reference' && parsed.assignedValue) {
		if (baseName.names.length > 1) {
			errors.push({
				message: 'only single name allowed for definition',
				startRowIndex: baseName.startRowIndex,
				startColumnIndex: baseName.startColumnIndex,
				endRowIndex: baseName.endRowIndex,
				endColumnIndex: baseName.endColumnIndex,
			});
		}
		const definition: ParseSingleDefinition = {
			type: 'definition',
			description: parsed.description,
			name: baseName.names[0],
			typeGuard: parsed.typeGuard,
			value: parsed.assignedValue,
			fallback: parsed.fallback,
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
		};
		return {
			...result,
			errors: errors,
			parsed: definition,
		};
	}
	// valueExpression
	if (parsed.spread) {
		errors.push({
			message: 'rest not allowed for valueExpression',
			startRowIndex: parsed.startRowIndex,
			startColumnIndex: parsed.startColumnIndex,
			endRowIndex: parsed.startRowIndex,
			endColumnIndex: parsed.startColumnIndex + 3,
		});
	}
	if (parsed.typeGuard) {
		errors.push({
			message: 'typeGuard not allowed for valueExpression',
			startRowIndex: parsed.typeGuard.startRowIndex,
			startColumnIndex: parsed.typeGuard.startColumnIndex,
			endRowIndex: parsed.typeGuard.endRowIndex,
			endColumnIndex: parsed.typeGuard.endColumnIndex,
		});
	}
	if (parsed.assignedValue) {
		errors.push({
			message: 'assignedValue not allowed for valueExpression',
			startRowIndex: parsed.assignedValue.startRowIndex,
			startColumnIndex: parsed.assignedValue.startColumnIndex,
			endRowIndex: parsed.assignedValue.endRowIndex,
			endColumnIndex: parsed.assignedValue.endColumnIndex,
		});
	}
	if (parsed.fallback) {
		errors.push({
			message: 'fallback not allowed for valueExpression',
			startRowIndex: parsed.fallback.startRowIndex,
			startColumnIndex: parsed.fallback.startColumnIndex,
			endRowIndex: parsed.fallback.endRowIndex,
			endColumnIndex: parsed.fallback.endColumnIndex,
		});
	}
	if (baseName.type === 'bracketed') {
		const bracketedValueExpression = bracketedExpressionToValueExpression(baseName, errors);
		return {
			...result,
			errors: errors,
			parsed: bracketedValueExpression,
		};
	}
	return {
		...result,
		errors: errors,
		parsed: baseName,
	};
}

function numberParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<NumberLiteral> {
	const result = regexParser(/-?(0|[1-9][0-9]*)(\.[0-9]+)?/g, 'not a valid number')(rows, startRowIndex, startColumnIndex, indent);
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: result.parsed === undefined
			? undefined
			: {
				type: 'number',
				value: +result.parsed,
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
			},
	};
}

//#region String

// TODO stringparser mit discriminated choice über linebreak

function inlineStringParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseStringLiteral> {
	const result = sequenceParser(
		paragraphParser,
		stringLineContentParser,
		paragraphParser,
	)(rows, startRowIndex, startColumnIndex, indent);
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: result.parsed === undefined
			? undefined
			: {
				type: 'string',
				values: result.parsed[1],
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
			},
	};
}

function multilineStringParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseStringLiteral> {
	const result = sequenceParser(
		paragraphParser,
		newLineParser,
		incrementIndent(multilineParser(stringLineContentParser)),
		newLineParser,
		indentParser,
		paragraphParser,
	)(rows, startRowIndex, startColumnIndex, indent);
	const values: ({
		type: 'stringToken';
		value: string;
	} | ParseValueExpression)[] = [];
	if (result.parsed) {
		result.parsed[2].forEach(line => {
			if (typeof line === 'object') {
				values.push(...line);
			}
			const tail = values[values.length - 1];
			if (tail?.type === 'stringToken') {
				tail.value += '\n';
			}
			else {
				values.push({
					type: 'stringToken',
					value: '\n'
				});
			}
		});
	}
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: result.parsed === undefined
			? undefined
			: {
				type: 'string',
				values: values,
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex
			},
	};
}

function stringLineContentParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<({
	type: 'stringToken';
	value: string;
} | ParseValueExpression)[]> {
	const result =
		multiplicationParser(
			0,
			undefined,
			choiceParser(
				regexParser(/[^§]+/g, 'Invalid String Syntax'),
				tokenParser('§§'),
				sequenceParser(
					tokenParser('§('),
					valueExpressionParser,
					closingBracketParser,
				),
			)
		)(rows, startRowIndex, startColumnIndex, indent);
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: result.parsed?.map(choice => {
			switch (typeof choice) {
				case 'undefined':
					return {
						type: 'stringToken',
						value: '§'
					};

				case 'string':
					return {
						type: 'stringToken',
						value: choice
					};

				case 'object':
					return choice[1];

				default:
					throw new Error('unexpected String Token choice');
			}
		})
	};
}

//#endregion String

function nameParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<Name> {
	const result = regexParser(/[a-zA-Z][0-9a-zA-Z]*\$?/g, 'Invalid name')(rows, startRowIndex, startColumnIndex, indent);
	return {
		...result,
		parsed: result.parsed
			? {
				type: 'name',
				name: result.parsed,
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
			}
			: undefined
	};
}

function referenceParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<Reference> {
	const result = sequenceParser(
		nameParser,
		multiplicationParser(
			0,
			undefined,
			sequenceParser(
				tokenParser('/'),
				choiceParser(
					nameParser,
					indexParser
				)
			)
		),
	)(rows, startRowIndex, startColumnIndex, indent);
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: result.parsed && {
			type: 'reference',
			names: [
				result.parsed[0],
				...(result.parsed[1].map(sequence => {
					const name = sequence[1];
					return name;
				}) ?? [])
			],
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex
		}
	};
}

function indexParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<Index> {
	const result = regexParser(/[0-9]+/g, 'Invalid index syntax')(rows, startRowIndex, startColumnIndex, indent);
	return {
		...result,
		parsed: result.parsed === undefined
			? undefined
			: {
				type: 'index',
				name: +result.parsed,
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
			}
	};
}

function fieldParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseFieldBase> {
	const result = sequenceParser(
		// spread/rest
		multiplicationParser(
			0,
			1,
			tokenParser('...'),
		),
		// name/single value/definitionFields
		valueExpressionBaseParser,
		// typeguard
		multiplicationParser(
			0,
			1,
			sequenceParser(
				tokenParser(': '),
				valueExpressionParser,
			),
		),
		// source/assignedValue
		multiplicationParser(
			0,
			1,
			sequenceParser(
				definitionTokenParser,
				valueExpressionParser,
			),
		),
		// fallback
		multiplicationParser(
			0,
			1,
			sequenceParser(
				tokenParser(' ?? '),
				valueExpressionParser,
			),
		),
	)(rows, startRowIndex, startColumnIndex, indent);
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: result.parsed && {
			type: 'field',
			spread: !!result.parsed[0].length,
			name: result.parsed[1],
			typeGuard: result.parsed[2]?.[0]?.[1],
			assignedValue: result.parsed[3]?.[0]?.[1],
			fallback: result.parsed[4]?.[0]?.[1],
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
		},
	};
}

function valueExpressionParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseValueExpression> {
	const result = valueExpressionBaseParser(rows, startRowIndex, startColumnIndex, indent);
	const parsed = result.parsed;
	if (!parsed) {
		return result;
	}
	const errors = result.errors ?? [];
	const valueExpression = baseValueExpressionToValueExpression(parsed, errors);
	return {
		...result,
		parsed: valueExpression,
		errors: errors,
	};
}

//#region SimpleExpression

function valueExpressionBaseParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseValueExpressionBase> {
	const endOfCodeError = checkEndOfCode(rows, startRowIndex, startColumnIndex, 'expression');
	if (endOfCodeError) {
		return endOfCodeError;
	}
	const result = sequenceParser(
		simpleExpressionParser,
		discriminatedChoiceParser(
			// TODO Reference Chain,FunctionCall Chain?
			// {
			// 	predicate: tokenParser('.'),
			// 	parser: ???,
			// },
			// Branching
			{
				predicate: branchingTokenParser,
				// function list
				parser: branchesParser,
			},
			// FunctionLiteral
			{
				predicate: functionTokenParser,
				// expressionBlock
				parser: functionBodyParser,
			},
			// SimpleValueExpression
			{
				predicate: emptyParser,
				parser: emptyParser
			},
		)
	)(rows, startRowIndex, startColumnIndex, indent);
	const errors = result.errors
		? [...result.errors]
		: [];
	if (errors.length) {
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: errors,
		};
	}
	const [parsed1, parsed2] = result.parsed!;
	if (!parsed2) {
		// SimpleExpression
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			parsed: parsed1,
		};
	}
	switch (parsed2.type) {
		case 'branches': {
			// TODO
			// const valueExpression = dictionaryTypeToObjectLiteral(parsed1);
			// if (valueExpression.errors?.length) {
			// 	return {
			// 		endRowIndex: result.endRowIndex,
			// 		endColumnIndex: result.endColumnIndex,
			// 		errors: valueExpression.errors
			// 	};
			// }
			const branching: ParseBranching = {
				type: 'branching',
				// value: valueExpression.value!,
				value: parsed1,
				branches: parsed2.value,
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
			};
			return {
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
				parsed: branching,
			};
		}

		case 'functionBody': {
			const symbols: SymbolTable = {};
			const body = parsed2.body;
			if (parsed1.type === 'bracketed') {
				fillSymbolTableWithDictionaryType(symbols, errors, parsed1);
				bracketedExpressionToParameters(parsed1, errors);
			}
			// TODO im Fall das params TypeExpression ist: Code Flow Typing berücksichtigen
			fillSymbolTableWithExpressions(symbols, errors, body);
			const functionLiteral: ParseFunctionLiteral = {
				type: 'functionLiteral',
				params: parsed1,
				body: body,
				symbols: symbols,
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
			};
			return {
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
				parsed: functionLiteral,
				errors: errors,
			};
		}

		default: {
			const assertNever: never = parsed2;
			throw new Error(`Unexpected secondExpression.type: ${(assertNever as any).type}`);
		}
	}
}

function simpleExpressionParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<SimpleExpression> {
	const result = discriminatedChoiceParser(
		// BracketedExpression
		{
			predicate: openingBracketParser,
			parser: bracketedBaseParser,
		},
		// NumberLiteral
		{
			predicate: regexParser(/[-0-9]/g, ''),
			parser: numberParser,
		},
		// StringLiteral
		{
			predicate: paragraphParser,
			parser: choiceParser(
				inlineStringParser,
				multilineStringParser
			)
		},
		// Reference/FunctionCall
		{
			predicate: regexParser(/[a-zA-Z]/g, ''),
			parser: simpleNameStartedExpressionParser,
		},
	)(rows, startRowIndex, startColumnIndex, indent);
	return result;
}

function branchesParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<{
	type: 'branches';
	value: ParseValueExpression[];
}> {
	const endOfCodeError = checkEndOfCode(rows, startRowIndex, startColumnIndex, 'branching');
	if (endOfCodeError) {
		return endOfCodeError;
	}
	const result = sequenceParser(
		branchingTokenParser,
		newLineParser,
		incrementIndent(multilineParser(valueExpressionParser)) // TODO function expression
	)(rows, startRowIndex, startColumnIndex, indent);
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: result.parsed && {
			type: 'branches',
			value: result.parsed[2].filter((x): x is ParseValueExpression =>
				typeof x === 'object'),
		}
	};
}

/**
 * enthält ggf. endständiges Zeilenende nicht
 */
function functionBodyParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<{
	type: 'functionBody';
	body: ParseExpression[];
}> {
	const result = sequenceParser(
		functionTokenParser,
		discriminatedChoiceParser<ParseExpression[][]>(
			// multiline FunctionLiteral
			{
				predicate: endOfLineParser,
				parser: moveToNextLine(incrementIndent(expressionBlockParser))
			},
			// inline FunctionLiteral
			{
				predicate: spaceParser,
				parser: moveColumnIndex(1, mapParser(
					valueExpressionParser,
					expression =>
						expression && [expression])),
			},
		),
	)(rows, startRowIndex, startColumnIndex, indent);
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: result.parsed && {
			type: 'functionBody',
			body: result.parsed[1],
		},
	};
}

//#endregion SimpleExpression

//#region bracketed

function bracketedBaseParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<BracketedExpressionBase> {
	const result = bracketedMultiParser(fieldParser)(rows, startRowIndex, startColumnIndex, indent);
	const parsed = result.parsed;
	if (!parsed) {
		return {
			...result,
			parsed: undefined,
		};
	}
	const withDescriptions = assignDescriptions(parsed);
	const bracketed: BracketedExpressionBase = {
		type: 'bracketed',
		fields: withDescriptions,
		startRowIndex: startRowIndex,
		startColumnIndex: startColumnIndex,
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,

	};
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		parsed: bracketed,
	};
}

/**
 * Parsed beginnend mit öffnender bis zur 1. schließenden Klammer.
 * Multiline oder inline mit Leerzeichen getrennt.
 */
function bracketedMultiParser<T>(parser: Parser<T>): Parser<(T | string | undefined)[]> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		const result = discriminatedChoiceParser(
			{
				predicate: tokenParser('()'),
				parser: mapParser(
					tokenParser('()'),
					parsed =>
						[]),
			},
			{
				predicate: sequenceParser(
					openingBracketParser,
					newLineParser,
				),
				parser: bracketedMultilineParser(parser)
			},
			{
				predicate: emptyParser,
				parser: bracketedInlineParser(parser)
			},
		)(rows, startRowIndex, startColumnIndex, indent);
		return result;
	};
}

function bracketedMultilineParser<T>(parser: Parser<T>): Parser<(T | string | undefined)[]> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		const result = sequenceParser(
			openingBracketParser,
			newLineParser,
			incrementIndent(multilineParser(parser)),
			newLineParser,
			indentParser,
			closingBracketParser,
		)(rows, startRowIndex, startColumnIndex, indent);
		const parsed = result.parsed?.[2];
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: result.errors,
			parsed: parsed,
		};
	};
}

function bracketedInlineParser<T>(parser: Parser<T>): Parser<T[]> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		const result = sequenceParser(
			openingBracketParser,
			parser,
			multiplicationParser(
				0,
				undefined,
				sequenceParser(
					spaceParser,
					parser,
				)
			),
			closingBracketParser,
		)(rows, startRowIndex, startColumnIndex, indent);
		const parsed = result.parsed && [
			result.parsed[1],
			...result.parsed[2].map(sequence =>
				sequence[1]),
		];
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: result.errors,
			parsed: parsed,
		};
	};
}

//#endregion bracketed

/**
 * Reference/FunctionCall
 */
function simpleNameStartedExpressionParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<Reference | ParseFunctionCall> {
	const result = sequenceParser(
		referenceParser,
		discriminatedChoiceParser(
			// FunctionCall
			{
				predicate: choiceParser(
					openingBracketParser,
					infixFunctionTokenParser,
				),
				// ObjectLiteral
				parser: functionArgumentsParser
			},
			{
				// Reference
				predicate: emptyParser,
				parser: emptyParser
			},
		)
	)(rows, startRowIndex, startColumnIndex, indent);
	if (result.errors?.length) {
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: result.errors,
		};
	}
	const [parsed1, parsed2] = result.parsed!;
	if (!parsed2) {
		// Reference
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			parsed: parsed1
		};
	}
	// FunctionCall
	let functionCall: ParseFunctionCall;
	const params = parsed2.arguments;
	if (parsed2.infixFunctionReference) {
		const values: NonEmptyArray<ParseValueExpression> = [
			parsed1,
		];
		// TODO infix function call mit dictionary
		if (params.type === 'list') {
			values.push(...params.values);
		}
		functionCall = {
			type: 'functionCall',
			functionReference: parsed2.infixFunctionReference,
			arguments: {
				type: 'list',
				values: values,
				// TODO achtung bei findExpressionbyPosition, da infix param außerhalb der range
				startRowIndex: params.startRowIndex,
				startColumnIndex: params.startColumnIndex,
				endRowIndex: params.endRowIndex,
				endColumnIndex: params.endColumnIndex,
			},
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
		};
	}
	else {
		functionCall = {
			type: 'functionCall',
			functionReference: parsed1,
			arguments: params,
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
		};
	}
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		parsed: functionCall,
	};
}

function functionArgumentsParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<{
	arguments: BracketedExpression;
	infixFunctionReference?: Reference;
}> {
	const result = sequenceParser(
		multiplicationParser(0, 1, sequenceParser(infixFunctionTokenParser, nameParser)),
		bracketedBaseParser,
	)(rows, startRowIndex, startColumnIndex, indent);
	const parsed = result.parsed;
	if (!parsed) {
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: result.errors,
		};
	}
	const errors = result.errors ?? [];
	const [parsed1, parsed2] = parsed;
	const infixFunctionName = parsed1[0]?.[1];
	const args = bracketedExpressionToValueExpression(parsed2, errors);
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		parsed: {
			arguments: args,
			infixFunctionReference: infixFunctionName
				? {
					type: 'reference',
					names: [infixFunctionName],
					startRowIndex: infixFunctionName.startRowIndex,
					startColumnIndex: infixFunctionName.startColumnIndex,
					endRowIndex: infixFunctionName.endRowIndex,
					endColumnIndex: infixFunctionName.endColumnIndex,
				}
				: undefined,
		},
		errors: errors
	};
}

//#endregion expression parser

/**
 * Unmittelbar aufeinanderfolgende Kommentarzeilen zusammenfassen und zur darauffolgenden Definition/Field packen
 */
function assignDescriptions<T extends ParseExpression>(expressionsOrComments: (string | undefined | T)[]): T[] {
	let descriptionComment = '';
	const expressionsWithDescription: any[] = [];
	expressionsOrComments.forEach(expressionOrComment => {
		switch (typeof expressionOrComment) {
			case 'object':
				const expressionWithDesciption = expressionOrComment.type === 'definition'
					|| expressionOrComment.type === 'field'
					? {
						...expressionOrComment,
						description: descriptionComment
					}
					: expressionOrComment;
				expressionsWithDescription.push(expressionWithDesciption);
				descriptionComment = '';
				return;

			case 'string':
				return descriptionComment += '\n' + expressionOrComment;

			case 'undefined':
				descriptionComment = '';
				return;

			default: {
				const assertNever: never = expressionOrComment;
				throw new Error(`Unexpected typeof expression: ${typeof assertNever}`);
			}
		}
	});
	return expressionsWithDescription;
}

//#region convert

function bracketedExpressionToDestructuringFields(
	bracketedExpression: BracketedExpressionBase,
	errors: ParserError[],
): void {
	if (!bracketedExpression.fields.length) {
		errors.push({
			message: 'destructuring fields must not be empty',
			startRowIndex: bracketedExpression.startRowIndex,
			startColumnIndex: bracketedExpression.startColumnIndex,
			endRowIndex: bracketedExpression.endRowIndex,
			endColumnIndex: bracketedExpression.endColumnIndex,
		});
	}
	bracketedExpression.fields.forEach(baseField => {
		const baseName = baseField.name;
		if (baseName.type === 'reference') {
			if (baseName.names.length > 1) {
				errors.push({
					message: 'only single name allowed for destruring field',
					startRowIndex: baseName.startRowIndex,
					startColumnIndex: baseName.startColumnIndex,
					endRowIndex: baseName.endRowIndex,
					endColumnIndex: baseName.endColumnIndex,
				});
			}
		}
		else {
			// TODO nested destructuring?
			errors.push({
				message: `${baseName.type} is not a valid expression for destruring field name`,
				startRowIndex: baseName.startRowIndex,
				startColumnIndex: baseName.startColumnIndex,
				endRowIndex: baseName.endRowIndex,
				endColumnIndex: baseName.endColumnIndex,
			});
		}
		if (baseField.spread) {
			// TODO spread ohne source, fallback, typeguard?
		}
	});
}

function bracketedExpressionToParameters(
	bracketedExpression: BracketedExpressionBase,
	errors: ParserError[],
): void {
	const baseFields = bracketedExpression.fields;
	baseFields.forEach((field, index) => {
		if (field.spread) {
			if (index < baseFields.length - 1) {
				errors.push({
					message: 'Rest argument must be last.',
					startRowIndex: field.startRowIndex,
					startColumnIndex: field.startColumnIndex,
					endRowIndex: field.endRowIndex,
					endColumnIndex: field.endColumnIndex,
				});
			}
			// TODO ?
			// const fallback = field.fallback;
			// if (fallback) {
			// 	errors.push({
			// 		message: 'fallback is not allowed for rest parameter.',
			// 		startRowIndex: fallback.startRowIndex,
			// 		startColumnIndex: fallback.startColumnIndex,
			// 		endRowIndex: fallback.endRowIndex,
			// 		endColumnIndex: fallback.endColumnIndex,
			// 	});
			// }
		}
		const assignedValue = field.assignedValue;
		if (assignedValue) {
			errors.push({
				message: 'assignedValue is not allowed for parameter.',
				startRowIndex: assignedValue.startRowIndex,
				startColumnIndex: assignedValue.startColumnIndex,
				endRowIndex: assignedValue.endRowIndex,
				endColumnIndex: assignedValue.endColumnIndex,
			});
		}
	});
}

function bracketedExpressionToValueExpression(
	bracketedExpression: BracketedExpressionBase,
	errors: ParserError[],
): BracketedExpression {
	const baseFields = bracketedExpression.fields;
	if (!baseFields.length) {
		return {
			type: 'empty',
			startRowIndex: bracketedExpression.startRowIndex,
			startColumnIndex: bracketedExpression.startColumnIndex,
			endRowIndex: bracketedExpression.endRowIndex,
			endColumnIndex: bracketedExpression.endColumnIndex,
		};
	}
	const isList = !baseFields.some(parseField =>
		parseField.spread
		|| parseField.typeGuard
		|| parseField.assignedValue
		// TODO ListLiteral mit Fallback?
		|| parseField.fallback);
	if (isList) {
		return {
			type: 'list',
			values: baseFields.map(baseField =>
				baseValueExpressionToValueExpression(baseField.name, errors)) as any,
			startRowIndex: bracketedExpression.startRowIndex,
			startColumnIndex: bracketedExpression.startColumnIndex,
			endRowIndex: bracketedExpression.endRowIndex,
			endColumnIndex: bracketedExpression.endColumnIndex,
		};
	}
	const isDictionary = !baseFields.some(baseField =>
		// singleDictionaryField muss assignedValue haben
		!baseField.spread && !baseField.assignedValue);
	if (isDictionary) {
		return {
			type: 'dictionary',
			fields: baseFields.map(baseField => {
				const baseName = baseField.name;
				if (baseField.spread) {
					const typeGuard = baseField.typeGuard;
					if (typeGuard) {
						errors.push({
							message: `typeGuard is not aallowed for dictionary field`,
							startRowIndex: typeGuard.startRowIndex,
							startColumnIndex: typeGuard.startColumnIndex,
							endRowIndex: typeGuard.endRowIndex,
							endColumnIndex: typeGuard.endColumnIndex,
						});
					}
					const assignedValue = baseField.assignedValue;
					if (assignedValue) {
						errors.push({
							message: `assignedValue is not aallowed for dictionary field`,
							startRowIndex: assignedValue.startRowIndex,
							startColumnIndex: assignedValue.startColumnIndex,
							endRowIndex: assignedValue.endRowIndex,
							endColumnIndex: assignedValue.endColumnIndex,
						});
					}
					const fallback = baseField.fallback;
					if (fallback) {
						errors.push({
							message: `fallback is not aallowed for dictionary field`,
							startRowIndex: fallback.startRowIndex,
							startColumnIndex: fallback.startColumnIndex,
							endRowIndex: fallback.endRowIndex,
							endColumnIndex: fallback.endColumnIndex,
						});
					}
					const spreadDictionaryField: ParseSpreadDictionaryField = {
						type: 'spreadDictionaryField',
						value: baseName,
						startRowIndex: baseField.startRowIndex,
						startColumnIndex: baseField.startColumnIndex,
						endRowIndex: baseField.endRowIndex,
						endColumnIndex: baseField.endColumnIndex,
					};
					return spreadDictionaryField;
				}
				else {
					if (baseName.type !== 'reference') {
						errors.push({
							message: `${baseName.type} is not a valid expression for dictionary field name`,
							startRowIndex: baseName.startRowIndex,
							startColumnIndex: baseName.startColumnIndex,
							endRowIndex: baseName.endRowIndex,
							endColumnIndex: baseName.endColumnIndex,
						});
					}
					const singleDictionaryField: ParseSingleDictionaryField = {
						type: 'singleDictionaryField',
						name: baseName,
						typeGuard: baseField.typeGuard,
						value: baseField.assignedValue!,
						fallback: baseField.fallback,
						startRowIndex: baseField.startRowIndex,
						startColumnIndex: baseField.startColumnIndex,
						endRowIndex: baseField.endRowIndex,
						endColumnIndex: baseField.endColumnIndex,
					};
					return singleDictionaryField;
				}
			}) as any,
			startRowIndex: bracketedExpression.startRowIndex,
			startColumnIndex: bracketedExpression.startColumnIndex,
			endRowIndex: bracketedExpression.endRowIndex,
			endColumnIndex: bracketedExpression.endColumnIndex,
		};
	}
	const isDictionaryType = !baseFields.some(baseField =>
		baseField.assignedValue
		|| baseField.fallback);
	if (isDictionaryType) {
		// TODO
	}
	// TODO bessere Fehlermeldung
	errors.push({
		message: 'could not convert bracketedExpression to ValueExpression',
		startRowIndex: bracketedExpression.startRowIndex,
		startColumnIndex: bracketedExpression.startColumnIndex,
		endRowIndex: bracketedExpression.endRowIndex,
		endColumnIndex: bracketedExpression.endColumnIndex,
	});
	return bracketedExpression;
}

function baseValueExpressionToValueExpression(
	baseExpression: ParseValueExpressionBase,
	errors: ParserError[],
): ParseValueExpression {
	if (baseExpression.type === 'bracketed') {
		return bracketedExpressionToValueExpression(baseExpression, errors);
	}
	return baseExpression;
}

//#endregion convert