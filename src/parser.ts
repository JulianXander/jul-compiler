import {
	Branching,
	DestructuringDefinition,
	DictionaryLiteral,
	DictionaryTypeLiteral,
	DictionaryValue,
	Expression,
	Field,
	FunctionLiteral,
	FunctionCall,
	Name,
	NumberLiteral,
	Index,
	ListLiteral,
	ObjectLiteral,
	ParsedFile,
	PositionedExpression,
	Reference,
	SingleDefinition,
	StringLiteral,
	SymbolTable,
	ValueExpression,
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
	isDefined,
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
	expressions: Expression[],
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
	dictionaryType: DictionaryTypeLiteral,
): void {
	dictionaryType.singleFields.forEach(field => {
		// TODO type
		defineSymbol(symbolTable, errors, field.name, field.typeGuard!, field.description);
	});
	const rest = dictionaryType.rest;
	if (rest) {
		// TODO
		// defineSymbol(symbolTable,errors, rest.name, rest.typeGuard!, 'TODO')
	}
}

function defineSymbol(
	symbolTable: SymbolTable,
	errors: ParserError[],
	name: Name,
	type: ValueExpression,
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

function inlineStringParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<StringLiteral> {
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

function stringLineContentParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<({
	type: 'stringToken';
	value: string;
} | ValueExpression)[]> {
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

function multilineStringParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<StringLiteral> {
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
	} | ValueExpression)[] = [];
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
): ParserResult<Field> {
	const result = sequenceParser(
		// rest
		multiplicationParser(
			0,
			1,
			tokenParser('...'),
		),
		nameParser,
		// typeguard
		multiplicationParser(
			0,
			1,
			sequenceParser(
				tokenParser(': '),
				valueExpressionParser,
			),
		),
		// source
		multiplicationParser(
			0,
			1,
			sequenceParser(
				tokenParser(' = '),
				nameParser,
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
			isRest: !!result.parsed[0].length,
			name: result.parsed[1],
			typeGuard: result.parsed[2]?.[0]?.[1],
			source: result.parsed[3]?.[0]?.[1],
			fallback: result.parsed[4]?.[0]?.[1],
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
		},
	};
}

function multiDictionaryTypeParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<DictionaryTypeLiteral> {
	const result = bracketedMultiParser(fieldParser)(rows, startRowIndex, startColumnIndex, indent);
	if (result.errors?.length) {
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: result.errors,
		};
	}
	const parsed = result.parsed!.filter(isDefined);
	const allFields = assignDescriptions(result.parsed!);
	let rest: Field | undefined;
	const errors: ParserError[] = [];
	const singleFields = allFields.filter((field, index) => {
		const isRest = field.isRest;
		if (isRest) {
			if (index < parsed.length - 1) {
				errors.push({
					message: 'Rest argument must be last.',
					startRowIndex: field.startRowIndex,
					startColumnIndex: field.startColumnIndex,
					endRowIndex: field.endRowIndex,
					endColumnIndex: field.endColumnIndex,
				});
			}
			else {
				rest = field;
			}
			const source = field.source;
			if (source) {
				errors.push({
					message: 'source is not allowed for rest.',
					startRowIndex: source.startRowIndex,
					startColumnIndex: source.startColumnIndex,
					endRowIndex: source.endRowIndex,
					endColumnIndex: source.endColumnIndex,
				});
			}
		}
		return !isRest;
	});
	if (errors.length) {
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: errors,
		};
	}
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		parsed: {
			type: 'dictionaryType',
			singleFields: singleFields,
			rest: rest,
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
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
	body: Expression[];
}> {
	const result = sequenceParser(
		functionTokenParser,
		discriminatedChoiceParser<Expression[][]>(
			// multiline FunctionLiteral
			{
				predicate: endOfLineParser,
				parser: moveToNextLine(incrementIndent(expressionBlockParser))
			},
			// inline FunctionLiteral
			{
				predicate: spaceParser,
				parser: moveColumnIndex(1, mapParser(
					expressionParser,
					expression =>
						([expression]))),
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

function definitionValueParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<{
	type: 'definitionValue';
	value: ValueExpression;
}> {
	const result = sequenceParser(
		tokenParser(' = '),
		valueExpressionParser
	)(rows, startRowIndex, startColumnIndex, indent);
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: result.parsed && {
			type: 'definitionValue',
			value: result.parsed[1]
		}
	};
}

function simpleExpressionParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ObjectLiteral | NumberLiteral | StringLiteral | Reference | FunctionCall | DictionaryTypeLiteral | Field> {
	const result = discriminatedChoiceParser(
		// ObjectLiteral/FunctionLiteralParams/DestructuringDeclarations
		{
			predicate: openingBracketParser,
			parser: bracketedExpressionParser,
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
		// FunctionCall/Reference/DefinitionDeclarations
		{
			predicate: regexParser(/[a-zA-Z]/g, ''),
			parser: nameStartedExpressionParser,
		},
	)(rows, startRowIndex, startColumnIndex, indent);
	return result;
}

function expressionParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<Expression> {
	const endOfCodeError = checkEndOfCode(rows, startRowIndex, startColumnIndex, 'expression');
	if (endOfCodeError) {
		return endOfCodeError;
	}
	const result = sequenceParser(
		simpleExpressionParser,
		discriminatedChoiceParser(
			// TODO Reference Chain,FunctionCall?
			// {
			// 	predicate: tokenParser('.'),
			// 	parser: ???,
			// },
			// Branching
			{
				predicate: branchingTokenParser,
				// function list
				parser: branchesParser
			},
			// FunctionLiteral
			{
				predicate: functionTokenParser,
				// expressionBlock
				parser: functionBodyParser
			},
			// Definition
			{
				predicate: definitionTokenParser,
				// ValueExpression
				parser: definitionValueParser
			},
			// SimpleExpression
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
		if ('type' in parsed1 && parsed1.type === 'field') {
			return {
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
				errors: [{
					message: 'Field is not a valid simple Expression',
					startRowIndex: startRowIndex,
					startColumnIndex: startColumnIndex,
					endRowIndex: result.endRowIndex,
					endColumnIndex: result.endColumnIndex,
				}]
			};
		}
		const valueExpression = dictionaryTypeToObjectLiteral(parsed1);
		if (valueExpression.errors?.length) {
			return {
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
				parsed: parsed1,
			};
			// return {
			// 	endRowIndex: result.endRowIndex,
			// 	endColumnIndex: result.endColumnIndex,
			// 	errors: valueExpression.errors as any, // TODO structure überdenken
			// };
		}
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			parsed: valueExpression.value,
		};
	}
	switch (parsed2.type) {
		case 'branches': {
			if ('type' in parsed1 && parsed1.type === 'field') {
				return {
					endRowIndex: result.endRowIndex,
					endColumnIndex: result.endColumnIndex,
					errors: [{
						message: 'Can not branch over Field',
						startRowIndex: startRowIndex,
						startColumnIndex: startColumnIndex,
						endRowIndex: result.endRowIndex,
						endColumnIndex: result.endColumnIndex,
					}]
				};
			}
			const valueExpression = dictionaryTypeToObjectLiteral(parsed1);
			if (valueExpression.errors?.length) {
				return {
					endRowIndex: result.endRowIndex,
					endColumnIndex: result.endColumnIndex,
					errors: valueExpression.errors
				};
			}
			const branching: Branching = {
				type: 'branching',
				value: valueExpression.value!,
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
			if ('type' in parsed1 && parsed1.type === 'field') {
				return {
					endRowIndex: result.endRowIndex,
					endColumnIndex: result.endColumnIndex,
					errors: [{
						message: 'Field not allowed as FunctionParameters',
						startRowIndex: startRowIndex,
						startColumnIndex: startColumnIndex,
						endRowIndex: result.endRowIndex,
						endColumnIndex: result.endColumnIndex,
					}],
				};
			}
			const symbols: SymbolTable = {};
			const body = parsed2.body;
			if (parsed1.type === 'dictionaryType') {
				fillSymbolTableWithDictionaryType(symbols, errors, parsed1);
			}
			// TODO im Fall das params TypeExpression ist: Code Flow Typing berücksichtigen
			fillSymbolTableWithExpressions(symbols, errors, body);
			const functionLiteral: FunctionLiteral = {
				type: 'functionLiteral',
				params: parsed1,
				body: body,
				symbols: symbols,
				pure: true, // TODO impure functions mit !=> ?
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

		case 'definitionValue': {
			const definitionValue = parsed2.value;
			if ('type' in parsed1) {
				// SingleDefinition
				switch (parsed1.type) {
					case 'field':
					case 'reference': {
						const toField = referenceToField(parsed1);
						if (toField.errors?.length) {
							return {
								endRowIndex: result.endRowIndex,
								endColumnIndex: result.endColumnIndex,
								errors: toField.errors as any, // TODO error structure überdenken
							};
						}
						const field = toField.field!;
						// TODO field.source verbieten
						const definition: SingleDefinition = {
							type: 'definition',
							name: field.name,
							typeGuard: field.typeGuard,
							value: definitionValue,
							fallback: field.fallback,
							startRowIndex: startRowIndex,
							startColumnIndex: startColumnIndex,
							endRowIndex: result.endRowIndex,
							endColumnIndex: result.endColumnIndex,
						};
						return {
							endRowIndex: result.endRowIndex,
							endColumnIndex: result.endColumnIndex,
							parsed: definition,
						};
					}

					default:
						return {
							endRowIndex: result.endRowIndex,
							endColumnIndex: result.endColumnIndex,
							errors: [{
								message: 'Unexpected ExpressionType for Definition part 1: ' + parsed1.type,
								startRowIndex: startRowIndex,
								startColumnIndex: startColumnIndex,
								// TODO end indices bei parsed1 end
								endRowIndex: result.endRowIndex,
								endColumnIndex: result.endColumnIndex,
							}],
						};
				}
			}
			const definition: DestructuringDefinition = {
				type: 'destructuring',
				fields: parsed1,
				value: definitionValue,
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
			};
			return {
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
				parsed: definition,
			};
		}

		default: {
			const assertNever: never = parsed2;
			throw new Error(`Unexpected secondExpression.type: ${(assertNever as any).type}`);
		}
	}
}

function valueExpressionParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ValueExpression> {
	const result = expressionParser(rows, startRowIndex, startColumnIndex, indent);
	switch (result.parsed?.type) {
		case 'definition':
		case 'destructuring':
			return {
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
				errors: [{
					message: `${result.parsed.type} expression is not a value expression`,
					startRowIndex: startRowIndex,
					startColumnIndex: startColumnIndex,
					endRowIndex: result.endRowIndex,
					endColumnIndex: result.endColumnIndex,
				}]
			};

		default:
			return result as any;
	}
}

//#region bracketed

/**
 * Multiline oder inline mit Leerzeichen getrennt
 */
function bracketedMultiParser<T>(parser: Parser<T>): Parser<(T | string | undefined)[]> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		const result = discriminatedChoiceParser(
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

/**
 * ObjectLiteral/FunctionLiteralParams/DestructuringDeclarations
 * TODO tuple type literal?
 */
function bracketedExpressionParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ObjectLiteral | DictionaryTypeLiteral> {
	const result = choiceParser(
		multiDictionaryTypeParser,
		objectParser,
	)(rows, startRowIndex, startColumnIndex, indent);
	return result;
}

//#region ObjectLteral

function emptyObjectParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ObjectLiteral> {
	const result = tokenParser('()')(rows, startRowIndex, startColumnIndex, indent);
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: result.errors ? undefined : {
			type: 'empty',
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
		},
	};
}

function multiListParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ListLiteral> {
	const result = bracketedMultiParser(valueExpressionParser)(rows, startRowIndex, startColumnIndex, indent);
	const parsed: ListLiteral | undefined = result.parsed && {
		type: 'list',
		// TODO check NonEmptyArray?
		values: result.parsed.filter((x): x is ValueExpression =>
			typeof x === 'object') as any,
		startRowIndex: startRowIndex,
		startColumnIndex: startColumnIndex,
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
	};
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: parsed,
	};
}

//#region Dictionary

function multiDictionaryParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<DictionaryLiteral> {
	const result = bracketedMultiParser(dictionaryValueParser)(rows, startRowIndex, startColumnIndex, indent);
	const parsed: DictionaryLiteral | undefined = result.parsed && {
		type: 'dictionary',
		// TODO check NonEmptyArray?
		values: result.parsed.filter(isDefined) as any,
		startRowIndex: startRowIndex,
		startColumnIndex: startColumnIndex,
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
	};
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: parsed,
	};
}

function dictionaryValueParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<DictionaryValue> {
	const result = sequenceParser(
		fieldParser, // TODO ohne source, fallback
		definitionTokenParser,
		valueExpressionParser,
	)(rows, startRowIndex, startColumnIndex, indent);
	const sequence = result.parsed;
	if (!sequence) {
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: result.errors,
		};
	}
	const field = sequence[0];
	const value: DictionaryValue = {
		type: 'dictionaryValue',
		name: field.name,
		typeGuard: field.typeGuard,
		value: sequence[2],
		startRowIndex: startRowIndex,
		startColumnIndex: startColumnIndex,
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
	};
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: value,
	};
}

//#endregion Dictionary

const objectParser: Parser<ObjectLiteral> = choiceParser(
	// ()
	emptyObjectParser,
	// mit Klammern und Leerzeichen/Zeilenumbrüchen
	multiListParser,
	multiDictionaryParser,
);

//#endregion ObjectLteral

//#endregion bracketed

/**
 * FunctionCall/Reference/Field
 */
function nameStartedExpressionParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<Reference | FunctionCall | Field> {
	const result = sequenceParser(
		choiceParser(
			referenceParser,
			fieldParser,
		),
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
				// Reference/Field
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
		// Reference/Field
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			parsed: parsed1
		};
	}
	// FunctionCall
	const toRef = fieldToReference(parsed1);
	if (toRef.errors?.length) {
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: toRef.errors,
		};
	}
	let functionCall: FunctionCall;
	const params = parsed2.arguments;
	if (parsed2.infixFunctionReference) {
		const values: NonEmptyArray<ValueExpression> = [
			toRef.ref!,
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
			functionReference: toRef.ref!,
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
	arguments: ObjectLiteral;
	infixFunctionReference?: Reference;
}> {
	const result = sequenceParser(
		multiplicationParser(0, 1, sequenceParser(infixFunctionTokenParser, nameParser)),
		objectParser,
	)(rows, startRowIndex, startColumnIndex, indent);
	if (result.errors?.length) {
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: result.errors,
		};
	}
	const [parsed1, parsed2] = result.parsed!;
	const infixFunctionName = parsed1[0]?.[1];
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		parsed: {
			arguments: parsed2,
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
	};
}

/**
 * enthält ggf. endständiges Zeilenende nicht
 */
function expressionBlockParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<Expression[]> {
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

function branchesParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<{
	type: 'branches';
	value: ValueExpression[];
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
			value: result.parsed[2].filter((x): x is ValueExpression =>
				typeof x === 'object'),
		}
	};
}

//#endregion expression parser

//#region convert

function fieldToReference(possibleRef: Reference | Field): { errors?: ParserError[]; ref?: Reference; } {
	if (possibleRef.type === 'reference') {
		return { ref: possibleRef };
	}

	const errors: ParserError[] = [];
	if (possibleRef.isRest) {
		errors.push({
			message: 'rest is not allowed for reference',
			startRowIndex: possibleRef.startRowIndex,
			startColumnIndex: possibleRef.startColumnIndex,
			endRowIndex: possibleRef.startRowIndex,
			endColumnIndex: possibleRef.startColumnIndex + 3,
		});
	}
	const fallback = possibleRef.fallback;
	if (fallback) {
		errors.push({
			message: 'fallback is not allowed for reference',
			startRowIndex: fallback.startRowIndex,
			startColumnIndex: fallback.startColumnIndex,
			endRowIndex: fallback.endRowIndex,
			endColumnIndex: fallback.endColumnIndex,
		});
	}
	const source = possibleRef.source;
	if (source) {
		errors.push({
			message: 'source is not allowed for reference',
			startRowIndex: source.startRowIndex,
			startColumnIndex: source.startColumnIndex,
			endRowIndex: source.endRowIndex,
			endColumnIndex: source.endColumnIndex,
		});
	}
	const typeGuard = possibleRef.typeGuard;
	if (typeGuard) {
		errors.push({
			message: 'typeGuard is not allowed for reference',
			startRowIndex: typeGuard.startRowIndex,
			startColumnIndex: typeGuard.startColumnIndex,
			endRowIndex: typeGuard.endRowIndex,
			endColumnIndex: typeGuard.endColumnIndex,
		});
	}
	if (errors.length) {
		return {
			errors: errors,
		};
	}
	return {
		ref: {
			type: 'reference',
			names: [possibleRef.name],
			startRowIndex: possibleRef.startRowIndex,
			startColumnIndex: possibleRef.startColumnIndex,
			endRowIndex: possibleRef.endRowIndex,
			endColumnIndex: possibleRef.endColumnIndex,
		}
	};
}

function referenceToField(possibleName: Reference | Field): { errors?: ParserError[]; field?: Field; } {
	if (possibleName.type === 'field') {
		return { field: possibleName };
	}
	const derefencingName = possibleName.names[1];
	if (derefencingName) {
		return {
			errors: [{
				message: 'derefencing name not allowed for definition',
				startRowIndex: derefencingName.startRowIndex,
				startColumnIndex: derefencingName.startColumnIndex,
				endRowIndex: derefencingName.endRowIndex,
				endColumnIndex: derefencingName.endColumnIndex,
			}],
		};
	}
	return {
		field: {
			type: 'field',
			isRest: false,
			name: possibleName.names[0],
			startRowIndex: possibleName.startRowIndex,
			startColumnIndex: possibleName.startColumnIndex,
			endRowIndex: possibleName.endRowIndex,
			endColumnIndex: possibleName.endColumnIndex,
		}
	};
}

function dictionaryTypeToObjectLiteral<T extends Expression>(
	possibleNames: T | DictionaryTypeLiteral,
): { errors?: ParserError[]; value?: T; } {
	if (possibleNames.type !== 'dictionaryType') {
		// Expression
		return {
			value: possibleNames
		};
	}
	// DictionaryTypeLiteral
	const errors: ParserError[] = [];
	const rest = possibleNames.rest;
	if (rest) {
		const restArgument = rest.name;
		errors.push({
			message: 'Rest arguments not allowed for reference',
			startRowIndex: restArgument.startRowIndex,
			startColumnIndex: restArgument.startColumnIndex,
			endRowIndex: restArgument.endRowIndex,
			endColumnIndex: restArgument.endColumnIndex,
		});
	}
	const refs = possibleNames.singleFields.map(name => {
		const res = fieldToReference(name);
		if (res.errors) {
			errors.push(...res.errors);
		}
		return res.ref;
	});
	if (errors.length) {
		return {
			errors: errors,
		};
	}
	return {
		value: {
			type: 'list',
			// TODO check NonEmptyArray?
			values: refs
		} as any
	};
}

//#endregion convert

/**
 * Unmittelbar aufeinanderfolgende Kommentarzeilen zusammenfassen und zur darauffolgenden Definition/Field packen
 */
function assignDescriptions<T extends PositionedExpression>(expressionsOrComments: (string | undefined | T)[]): T[] {
	let descriptionComment = '';
	const expressionsWithDescription: PositionedExpression[] = [];
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
				expressionsOrComments.push(expressionWithDesciption);
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
	return expressionsWithDescription as any;
}