import {
	ObjectLiteral,
	StringLiteral,
	DefinitionName,
	Expression,
	FunctionLiteral,
	AbstractSyntaxTree,
	NumberLiteral,
	DestructuringDefinition,
	Reference,
	FunctionCall,
	Branching,
	SingleDefinition,
	ValueExpression,
	ListLiteral,
	DefinitionNames,
	DictionaryLiteral,
	DictionaryValue,
	NonEmptyArray
} from './abstract-syntax-tree';
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
	tokenParser
} from './parser-combinator';

//#region util

function mapFn<Args extends any[], Result1, Result2>(
	fn: (...args: Args) => Result1,
	transform: (result1: Result1) => Result2,
): (...args: Args) => Result2 {
	return (...args) => {
		const result1 = fn(...args);
		const result2 = transform(result1);
		return result2;
	};
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}

//#endregion util

export function parseCode(code: string): AbstractSyntaxTree {
	const rows = code.split('\n');
	const parserResult = expressionBlockParser(rows, 0, 0, 0);
	// check end of code reached
	if (parserResult.endRowIndex !== rows.length) {
		return {
			errors: [
				{
					message: 'Failed to parse until end of code',
					columnIndex: parserResult.endColumnIndex,
					rowIndex: parserResult.endRowIndex,
				},
				...(parserResult.errors ?? [])
			]
		};
	}
	return {
		parsed: parserResult.parsed,
		errors: parserResult.errors,
	};
}

//#region helper

//#region Tokens

const spaceParser = tokenParser(' ');
const openingBracketParser = tokenParser('(');
const closingBracketParser = tokenParser(')');
const paragraphParser = tokenParser('§');
// SVO BoundFunction
const boundFunctionTokenParser = tokenParser('.');
const branchingTokenParser = tokenParser(' ?');
const functionTokenParser = tokenParser(' =>');
const definitionTokenParser = tokenParser(' = ');

//#endregion Tokens

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
				rowIndex: startRowIndex,
				columnIndex: startColumnIndex,
				message: `columnIndex=${startColumnIndex}, but should be at start of line`
			}],
		};
	}
	return {
		endRowIndex: startRowIndex,
		endColumnIndex: startColumnIndex,
	};
}

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
				rowIndex: startRowIndex,
				columnIndex: startColumnIndex,
				message: `columnIndex=${startColumnIndex}, but should be at end of line (${rowLength})`
			}],
		};
	}
	return {
		endRowIndex: startRowIndex,
		endColumnIndex: startColumnIndex,
	};
}

function newLineParser(
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
				rowIndex: startRowIndex,
				columnIndex: startColumnIndex,
				message: `columnIndex=${startColumnIndex}, but should be at end of line (${rowLength})`
			}],
		};
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
	if (startColumnIndex !== 0) {
		return {
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: [{
				rowIndex: startRowIndex,
				columnIndex: startColumnIndex,
				message: `columnIndex=${startColumnIndex}, but should be at start of line`
			}],
		};
	}
	const totalIndentToken = '\t'.repeat(indent);
	const result = tokenParser(totalIndentToken)(rows, startRowIndex, startColumnIndex, indent);
	return result;
}

/**
 * Beginnt mit columnIndex = 0.
 * Parst undefined bei Leerzeile.
 * Parst nichts bei Kommentarzeile (wird übersprungen).
 * Enthält ggf. endständiges Zeilenende nicht.
 * TODO comment in AST für Intellisense?
 */
function multilineParser<T>(parser: Parser<T>): Parser<(T | undefined)[]> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		if (startColumnIndex !== 0) {
			return {
				endRowIndex: startRowIndex,
				endColumnIndex: startColumnIndex,
				errors: [{
					rowIndex: startRowIndex,
					columnIndex: startColumnIndex,
					message: 'multilineParser should start at beginning of row'
				}],
			};
		}
		const parsed: (T | undefined)[] = [];
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
					rowIndex: rowIndex,
					columnIndex: result.endColumnIndex,
					message: 'multilineParser should parse until end of row'
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

function multilineBracketedExpressionListParser<T>(parser: Parser<T>): Parser<(T | undefined)[]> {
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

function inlineBracketedExpressionListParser<T>(parser: Parser<T>): Parser<T[]> {
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

//#endregion helper

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
			if (line) {
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
): ParserResult<string> {
	const result = regexParser(/[a-zA-Z][0-9a-zA-Z]*\$?/g, 'Invalid name')(rows, startRowIndex, startColumnIndex, indent);
	return result;
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
					indexAccessParser
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

function indexAccessParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<number> {
	const result = regexParser(/[0-9]+/g, 'Invalid index access Syntax')(rows, startRowIndex, startColumnIndex, indent);
	return {
		...result,
		parsed: result.parsed === undefined
			? undefined
			: +result.parsed,
	};
}

function definitionNameParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<DefinitionName> {
	const result = sequenceParser(
		nameParser,
		// source
		multiplicationParser(
			0,
			1,
			sequenceParser(
				tokenParser('='),
				nameParser,
			)
		),
		// typeguard
		multiplicationParser(
			0,
			1,
			sequenceParser(
				tokenParser(':'),
				valueExpressionParser, // TODO type expression
				// fallback
				multiplicationParser(
					0,
					1,
					sequenceParser(
						tokenParser(' ?? '),
						valueExpressionParser,
					)
				)
			)
		)
	)(rows, startRowIndex, startColumnIndex, indent);
	const typeSequence = result.parsed?.[2]?.[0];
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: result.parsed && {
			type: 'name',
			name: result.parsed[0],
			source: result.parsed[1]?.[0]?.[1],
			typeGuard: typeSequence?.[1],
			fallback: typeSequence?.[2]?.[0]?.[1],
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
		},
	};
}

function emptyNameListParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<DefinitionNames> {
	const result = tokenParser('()')(rows, startRowIndex, startColumnIndex, indent);
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		errors: result.errors,
		parsed: result.errors
			? undefined
			: {
				type: 'definitionNames',
				singleNames: [],
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
			},
	};
}

function inlineNameListParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<DefinitionNames> {
	const result = inlineBracketedExpressionListParser(
		choiceParser(
			definitionNameParser,
			sequenceParser(
				tokenParser('...'),
				nameParser,
				// TODO typeguard
			)
		),
	)(rows, startRowIndex, startColumnIndex, indent);
	if (result.errors?.length) {
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: result.errors,
		};
	}
	const parsed = result.parsed!;
	const possibleRest = parsed[parsed.length - 1];
	let rest: string | undefined;
	if (Array.isArray(possibleRest)) {
		rest = possibleRest[1];
	}
	let hasError = false;
	let singleNames = parsed.filter((x, index) => {
		const isRest = Array.isArray(x);
		if (isRest && index < parsed.length - 1) {
			hasError = true;
		}
		return !isRest;
	}) as DefinitionName[];
	if (hasError) {
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: [{
				columnIndex: result.endColumnIndex,
				rowIndex: result.endRowIndex,
				message: 'Rest argument must be last.',
			}],
		};
	}
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		parsed: {
			type: 'definitionNames',
			singleNames: singleNames,
			rest: rest === undefined
				? undefined
				: {
					name: rest
				},
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
		}
	};
}

function multilineNameListParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<DefinitionNames> {
	const result = multilineBracketedExpressionListParser(
		choiceParser(
			definitionNameParser,
			sequenceParser(
				tokenParser('...'),
				nameParser,
				// TODO typeguard
			)
		),
	)(rows, startRowIndex, startColumnIndex, indent);
	if (result.errors?.length) {
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: result.errors,
		};
	}
	const parsed = result.parsed!.filter(isDefined);
	const possibleRest = parsed[parsed.length - 1];
	let rest: string | undefined;
	if (Array.isArray(possibleRest)) {
		rest = possibleRest[1];
	}
	let hasError = false;
	let singleNames = parsed.filter((x, index) => {
		const isRest = Array.isArray(x);
		if (index < parsed.length - 2) {
			hasError = true;
		}
		return !isRest;
	}) as DefinitionName[];
	if (hasError) {
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: [{
				columnIndex: result.endColumnIndex,
				rowIndex: result.endRowIndex,
				message: 'Rest argument must be last.',
			}],
		};
	}
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		parsed: {
			type: 'definitionNames',
			singleNames: singleNames,
			rest: rest === undefined
				? undefined
				: {
					name: rest
				},
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
): ParserResult<ObjectLiteral | NumberLiteral | StringLiteral | Reference | FunctionCall | DefinitionNames | DefinitionName> {
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
			// TODO nameStartedExpressionParser ohne Definition/Reference Branching
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
	if (startRowIndex >= rows.length) {
		return {
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: [{
				rowIndex: startRowIndex,
				columnIndex: startColumnIndex,
				message: endOfCodeError('expression')
			}]
		};
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
	if (result.errors?.length) {
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: result.errors,
		};
	}
	const [parsed1, parsed2] = result.parsed!;
	if (!parsed2) {
		// SimpleExpression
		// TODO definitionNames to ObjectLiteral
		if ('type' in parsed1 && parsed1.type === 'name') {
			return {
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
				errors: [{
					rowIndex: result.endRowIndex,
					columnIndex: result.endColumnIndex,
					message: 'Can not branch over DefinitionName'
				}]
			};
		}
		const valueExpression = definitionNamesToObjectLiteral(parsed1);
		if (valueExpression.errors?.length) {
			return {
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
				errors: valueExpression.errors as any // TODO structure überdenken
			};
		}
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			parsed: valueExpression.value
		};
	}
	switch (parsed2.type) {
		case 'branches': {
			if ('type' in parsed1 && parsed1.type === 'name') {
				return {
					endRowIndex: result.endRowIndex,
					endColumnIndex: result.endColumnIndex,
					errors: [{
						rowIndex: result.endRowIndex,
						columnIndex: result.endColumnIndex,
						message: 'Can not branch over DefinitionName'
					}]
				};
			}
			const valueExpression = definitionNamesToObjectLiteral(parsed1);
			if (valueExpression.errors?.length) {
				return {
					endRowIndex: result.endRowIndex,
					endColumnIndex: result.endColumnIndex,
					errors: valueExpression.errors as any // TODO structure überdenken
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
			if ('type' in parsed1 && parsed1.type === 'name') {
				return {
					endRowIndex: result.endRowIndex,
					endColumnIndex: result.endColumnIndex,
					errors: [{
						rowIndex: result.endRowIndex,
						columnIndex: result.endColumnIndex,
						message: 'DefinitionName not allowed as FunctionParameters'
					}],
				};
			}
			const functionLiteral: FunctionLiteral = {
				type: 'functionLiteral',
				params: parsed1,
				body: parsed2.body,
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
			};
		}

		case 'definitionValue': {
			const definitionValue = parsed2.value;
			if ('type' in parsed1) {
				// SingleDefinition
				switch (parsed1.type) {
					case 'name':
					case 'reference': {
						const toName = referenceToDefinitionName(parsed1);
						if (toName.errors?.length) {
							return {
								endRowIndex: result.endRowIndex,
								endColumnIndex: result.endColumnIndex,
								errors: toName.errors as any, // TODO error structure überdenken
							};
						}
						const definition: SingleDefinition = {
							type: 'definition',
							name: toName.name!,
							value: definitionValue,
							typeGuard: toName.name!.typeGuard,
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
								rowIndex: startRowIndex,
								columnIndex: startColumnIndex,
								message: 'Unexpected ExpressionType for Definition part 1: ' + parsed1.type
							}],
						};
				}
			}
			const definition: DestructuringDefinition = {
				type: 'destructuring',
				names: parsed1,
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
					rowIndex: result.endRowIndex,
					columnIndex: result.endColumnIndex,
					message: `${result.parsed.type} expression is not a value expression`
				}]
			};

		default:
			return result as any;
	}
}

/**
 * ObjectLiteral/FunctionLiteralParams/DestructuringDeclarations
 * TODO object type literal
 */
function bracketedExpressionParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ObjectLiteral | DefinitionNames> {
	const result = choiceParser(
		//#region nameList
		// leer
		emptyNameListParser,
		// mit Klammern einzeilig
		inlineNameListParser,
		// mit Klammern mehrzeilig
		multilineNameListParser,
		// ohne Klammern?
		//#endregion nameList
		objectParser,
	)(rows, startRowIndex, startColumnIndex, indent);
	return result;
}

/**
 * FunctionCall/Reference/DefinitionName
 */
function nameStartedExpressionParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<Reference | FunctionCall | DefinitionName> {
	const result = sequenceParser(
		choiceParser(
			referenceParser,
			definitionNameParser, // TODO nur name, typeGuard, kein source, optional
		),
		discriminatedChoiceParser(
			// FunctionCall
			{
				predicate: choiceParser(
					openingBracketParser,
					boundFunctionTokenParser,
				),
				// ObjectLiteral
				parser: functionArgumentsParser
			},
			{
				// Reference/DefinitionName
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
		// Reference/DefinitionName
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			parsed: parsed1
		};
	}
	// FunctionCall
	const toRef = definitionNameToReference(parsed1);
	if (toRef.errors?.length) {
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: toRef.errors as any, // TODO error structure überdenken
		};
	}
	let functionCall: FunctionCall;
	const params = parsed2.arguments;
	if (parsed2.boundFunctionReference) {
		const values: NonEmptyArray<ValueExpression> = [
			toRef.ref!,
		];
		// TODO bound function call mit dictionary
		if (params.type === 'list') {
			values.push(...params.values);
		}
		functionCall = {
			type: 'functionCall',
			functionReference: parsed2.boundFunctionReference,
			arguments: {
				type: 'list',
				values: values,
				// TODO achtung bei findExpressionbyPosition, da bound param außerhalb der range
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
	boundFunctionReference?: Reference;
}> {
	const result = sequenceParser(
		multiplicationParser(0, 1, sequenceParser(boundFunctionTokenParser, nameParser)),
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
	const boundFunctionName = parsed1[0]?.[1];
	return {
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		parsed: {
			arguments: parsed2,
			boundFunctionReference: boundFunctionName
				? {
					type: 'reference',
					names: [boundFunctionName],
					startRowIndex: startRowIndex,
					// + 1 für boundFunctionToken .
					startColumnIndex: startColumnIndex + 1,
					endRowIndex: startRowIndex,
					endColumnIndex: startColumnIndex + 1 + boundFunctionName.length,
				}
				: undefined,
		},
	};
}

function definitionNameToReference(possibleRef: Reference | DefinitionName): { errors?: string[]; ref?: Reference; } {
	if (possibleRef.type === 'reference') {
		return { ref: possibleRef };
	}

	const errors: string[] = [];
	if (possibleRef.fallback) {
		errors.push('fallback not allowed for reference');
	}
	if (possibleRef.source) {
		errors.push('source not allowed for reference');
	}
	if (possibleRef.typeGuard) {
		errors.push('typeGuard not allowed for reference');
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

function referenceToDefinitionName(possibleName: Reference | DefinitionName): { errors?: string[]; name?: DefinitionName; } {
	if (possibleName.type === 'name') {
		return { name: possibleName };
	}
	if (possibleName.names.length > 1) {
		return {
			errors: ['derefencing name not allowed for definition'],
		};
	}
	return {
		name: {
			type: 'name',
			name: possibleName.names[0],
			startRowIndex: possibleName.startRowIndex,
			startColumnIndex: possibleName.startColumnIndex,
			endRowIndex: possibleName.endRowIndex,
			endColumnIndex: possibleName.endColumnIndex,
		}
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
	if (startRowIndex >= rows.length) {
		return {
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: [{
				rowIndex: startRowIndex,
				columnIndex: startColumnIndex,
				message: endOfCodeError('expressionBlock')
			}]
		};
	}
	const result = mapParser(
		multilineParser(expressionParser),
		expressions =>
			expressions.filter(isDefined),
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

function inlineListParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ListLiteral> {
	const result = inlineBracketedExpressionListParser(valueExpressionParser)(rows, startRowIndex, startColumnIndex, indent);
	const parsed: ListLiteral | undefined = result.parsed && {
		type: 'list',
		// TODO check NonEmptyArray?
		values: result.parsed as any,
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

function multilineListParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ListLiteral> {
	const result = multilineBracketedExpressionListParser(valueExpressionParser)(rows, startRowIndex, startColumnIndex, indent);
	const parsed: ListLiteral | undefined = result.parsed && {
		type: 'list',
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

//#region Dictionary

function inlineDictionaryParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<DictionaryLiteral> {
	const result = inlineBracketedExpressionListParser(dictionaryValueParser)(rows, startRowIndex, startColumnIndex, indent);
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

function multilineDictionaryParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<DictionaryLiteral> {
	const result = multilineBracketedExpressionListParser(dictionaryValueParser)(rows, startRowIndex, startColumnIndex, indent);
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
		definitionNameParser, // TODO ohne source, fallback
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
	const definitionName = sequence[0];
	const value: DictionaryValue = {
		name: definitionName.name,
		typeGuard: definitionName.typeGuard,
		value: sequence[2],
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
	// mit Klammern und Leerzeichen
	inlineListParser,
	inlineDictionaryParser,
	// mit Klammern und Zeilenumbrüchen
	multilineListParser,
	multilineDictionaryParser,
);

//#endregion ObjectLteral

function branchesParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<{
	type: 'branches';
	value: ValueExpression[];
}> {
	if (startRowIndex >= rows.length) {
		return {
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: [{
				rowIndex: startRowIndex,
				columnIndex: startColumnIndex,
				message: endOfCodeError('branching')
			}]
		};
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
			value: result.parsed[2].filter(isDefined),
		}
	};
}

function definitionNamesToObjectLiteral<T extends Expression>(possibleNames: T | DefinitionNames): { errors?: string[]; value?: T; } {
	if (possibleNames.type !== 'definitionNames') {
		// Expression
		return {
			value: possibleNames
		};
	}
	// DefinitionName[]
	const errors: string[] = [];
	if (possibleNames.rest) {
		errors.push('Rest arguments not allowed for reference');
	}
	const refs = possibleNames.singleNames.map(name => {
		const res = definitionNameToReference(name);
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