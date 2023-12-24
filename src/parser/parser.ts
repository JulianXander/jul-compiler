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
} from './parser-combinator.js';
import {
	BracketedExpression,
	BracketedExpressionBase,
	ParseFieldReference,
	Index,
	ParseIndexReference,
	Name,
	NumberLiteral,
	ParseBranching,
	ParseDestructuringDefinition,
	ParsedExpressions,
	ParsedFile,
	ParseExpression,
	ParseFieldBase,
	ParseFunctionCall,
	ParseFunctionTypeLiteral,
	ParseParameterField,
	ParseParameterFields,
	ParseSingleDefinition,
	ParseSingleDictionaryField,
	ParseSingleDictionaryTypeField,
	ParseSpreadValueExpression,
	ParseTextLiteral,
	ParseValueExpression,
	ParseValueExpressionBase,
	Reference,
	SimpleExpression,
	SymbolTable,
	ParseListLiteral,
	PositionedExpressionBase,
	TextToken,
	ParseListValue,
} from '../syntax-tree.js';
import {
	Extension,
	isNonEmpty,
	isValidExtension,
	last,
	mapNonEmpty,
	readTextFile,
} from '../util.js';
import { parseTsCode } from './typescript-parser.js';
import { checkName, createParseFunctionLiteral, fillSymbolTableWithDictionaryType, fillSymbolTableWithExpressions } from './parser-utils.js';
import { dirname, extname, join } from 'path';
import { _parseJson } from '../runtime.js';
import { jsonValueToParsedExpressions } from './json-parser.js';
import { load } from 'js-yaml';
import { existsSync } from 'fs';

/**
 * @throws Wirft Error wenn Datei nicht gelesen werden kann.
 */
export function parseFile(filePath: string): ParsedFile {
	const code = readTextFile(filePath);
	const result = parseCode(code, filePath);
	return result;
}

export function parseCode(
	code: string,
	filePath: string,
): ParsedFile {
	const extension = extname(filePath);
	if (!isValidExtension(extension)) {
		throw new Error(`Unexpected extension for parseCode: ${extension}`);
	}
	const sourceFolder = dirname(filePath);
	let parsedExpressions: ParsedExpressions;
	let dependencies: string[] | undefined;
	switch (extension) {
		case Extension.js:
			parsedExpressions = parseTsCode(code);
			break;
		case Extension.json: {
			const parsedJson = _parseJson(code);
			if (parsedJson instanceof Error) {
				parsedExpressions = {
					errors: [{
						message: parsedJson.message,
						// TODO position?
						startColumnIndex: 0,
						startRowIndex: 0,
						endColumnIndex: 0,
						endRowIndex: 0,
					}],
				};
				break;
			}
			parsedExpressions = jsonValueToParsedExpressions(parsedJson);
			break;
		}
		case Extension.jul:
			parsedExpressions = parseJulCode(code);
			const imported = getImportedPaths(parsedExpressions.expressions, sourceFolder);
			parsedExpressions.errors.push(...imported.errors);
			dependencies = imported.paths;
			break;
		case Extension.ts:
			parsedExpressions = parseTsCode(code);
			break;
		case Extension.yaml: {
			// TODO bigints, Fractions
			const parsedYaml = load(code);
			parsedExpressions = jsonValueToParsedExpressions(parsedYaml);
			break;
		}
		default: {
			const assertNever: never = extension;
			throw new Error(`Unexpected extension: ${assertNever}`);
		}
	}
	const { errors, expressions } = parsedExpressions;
	const symbols: SymbolTable = {};
	expressions && fillSymbolTableWithExpressions(symbols, errors, expressions);
	return {
		filePath: filePath,
		extension: extension,
		sourceFolder: sourceFolder,
		unchecked: {
			errors: errors,
			expressions: expressions,
			symbols: symbols,
		},
		dependencies: dependencies,
	};
}

function parseJulCode(code: string): ParsedExpressions {
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
	return {
		errors: errors,
		expressions: expressions,
	};
}

//#region Tokens

const spaceParser = tokenParser(' ');
const openingBracketParser = tokenParser('(');
const closingBracketParser = tokenParser(')');
const paragraphParser = tokenParser('§');
const nestedReferenceTokenParser = tokenParser('/');
// SVO InfixFunctionCall
const infixFunctionTokenParser = tokenParser('.');
const branchingTokenParser = tokenParser(' ?');
const functionTokenParser = tokenParser(' =>');
const definitionTokenParser = tokenParser(' = ');
const typeGuardTokenParser = tokenParser(': ');
const fallbackTokenParser = tokenParser(' ?? ');

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
			hasParsed: false,
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
			hasParsed: false,
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
		hasParsed: true,
		endRowIndex: startRowIndex,
		endColumnIndex: startColumnIndex,
	};
}

/**
 * parst 0 Zeichen
 * Liefert ParserErrorResult bei endOfCode
 */
function endOfLineParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<undefined> {
	const endOfCodeError = checkEndOfCode(rows, startRowIndex, startColumnIndex, 'endOfLine');
	if (endOfCodeError) {
		return endOfCodeError;
	}
	const row = rows[startRowIndex];
	if (row === undefined) {
		throw new Error(`row[${startRowIndex}] missing`);
	}
	const rowLength = row.length;
	if (startColumnIndex !== rowLength) {
		return {
			hasParsed: false,
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
		hasParsed: true,
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
	if (!result.hasParsed) {
		return result;
	}
	return {
		hasParsed: true,
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
	if (!startOfLineResult.hasParsed) {
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
		if (!startOfLineResult.hasParsed) {
			return {
				...startOfLineResult,
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
			if (!indentResult.hasParsed) {
				const endRowIndex = rowIndex - 1;
				const endRow = rows[endRowIndex];
				if (endRow === undefined) {
					throw new Error(`row[${endRowIndex}] missing`);
				}
				// Ende des Blocks
				return {
					hasParsed: true,
					endRowIndex: endRowIndex,
					endColumnIndex: endRow.length,
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
			if (result.errors) {
				errors.push(...result.errors);
			}
			if (!result.hasParsed) {
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
			hasParsed: true,
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

// TODO parse infix function call chain
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
	// sonst Fehler
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
		const definition: ParseSingleDefinition = {
			type: 'definition',
			description: parsed.description,
			name: baseName.name,
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

function nameParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<Name> {
	const result = regexParser(/[a-zA-Z][0-9a-zA-Z]*\$?/y, 'Invalid name')(rows, startRowIndex, startColumnIndex, indent);
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
	const result = nameParser(rows, startRowIndex, startColumnIndex, indent);
	return {
		...result,
		parsed: result.parsed && {
			type: 'reference',
			name: result.parsed,
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
	// TODO parse number, and check number > 0 für bessere Fehlermeldung?
	const result = regexParser(/[1-9][0-9]*/y, 'Invalid index syntax')(rows, startRowIndex, startColumnIndex, indent);
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
		// typeGuard
		discriminatedChoiceParser(
			{
				predicate: typeGuardTokenParser,
				parser: sequenceParser(
					typeGuardTokenParser,
					valueExpressionParser,
				),
			},
			{
				predicate: emptyParser,
				parser: emptyParser,
			}
		),
		// source/assignedValue
		discriminatedChoiceParser(
			{
				predicate: definitionTokenParser,
				parser: sequenceParser(
					definitionTokenParser,
					valueExpressionParser,
				),
			},
			{
				predicate: emptyParser,
				parser: emptyParser,
			}
		),
		// fallback
		discriminatedChoiceParser(
			{
				predicate: fallbackTokenParser,
				parser: sequenceParser(
					fallbackTokenParser,
					valueExpressionParser,
				),
			},
			{
				predicate: emptyParser,
				parser: emptyParser,
			}
		),
	)(rows, startRowIndex, startColumnIndex, indent);
	return {
		...result,
		parsed: result.parsed && {
			type: 'field',
			spread: !!result.parsed[0].length,
			name: result.parsed[1],
			typeGuard: result.parsed[2]?.[1],
			assignedValue: result.parsed[3]?.[1],
			fallback: result.parsed[4]?.[1],
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

//#region ValueExpression

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
			// FunctionTypeLiteral/FunctionLiteral mit ReturnType
			{
				predicate: sequenceParser(
					moveColumnIndex(-1, closingBracketParser),
					typeGuardTokenParser,
				),
				parser: functionTypeBodyParser,
			},
			// SimpleValueExpression
			{
				predicate: emptyParser,
				parser: emptyParser
			},
		)
	)(rows, startRowIndex, startColumnIndex, indent);
	if (!result.hasParsed) {
		return {
			...result,
			parsed: undefined,
		};
	}
	const [parsed1, parsed2] = result.parsed!;
	if (!parsed2) {
		// SimpleExpression
		return {
			...result,
			parsed: parsed1,
		};
	}
	const errors = result.errors
		? [...result.errors]
		: [];
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
				hasParsed: true,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
				parsed: branching,
				errors: errors,
			};
		}
		case 'functionBody': {
			const body = parsed2.body;
			let params: SimpleExpression | ParseParameterFields = parsed1;
			if (params.type === 'bracketed') {
				params = bracketedExpressionToParameters(params, errors);
			}
			// TODO im Fall dass params TypeExpression ist: Code Flow Typing berücksichtigen
			const functionLiteral = createParseFunctionLiteral(
				params,
				undefined,
				body,
				{
					startRowIndex: startRowIndex,
					startColumnIndex: startColumnIndex,
					endRowIndex: result.endRowIndex,
					endColumnIndex: result.endColumnIndex,
				},
				errors,
			);
			return {
				hasParsed: true,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
				parsed: functionLiteral,
				errors: errors,
			};
		}
		case 'functionTypeBody': {
			const body = parsed2.body;
			if (parsed1.type !== 'bracketed') {
				throw new Error('ReturnType can only follow a bracketed expression.');
			}
			const params: BracketedExpressionBase | ParseParameterFields = bracketedExpressionToParameters(parsed1, errors);
			if (body) {
				// FunctionLiteral mit ReturnType
				const functionLiteral = createParseFunctionLiteral(
					params,
					parsed2.returnType,
					body,
					{
						startRowIndex: startRowIndex,
						startColumnIndex: startColumnIndex,
						endRowIndex: result.endRowIndex,
						endColumnIndex: result.endColumnIndex,
					},
					errors,
				);
				return {
					hasParsed: true,
					endRowIndex: result.endRowIndex,
					endColumnIndex: result.endColumnIndex,
					parsed: functionLiteral,
					errors: errors,
				};
			}
			// FunctionTypeLiteral
			const symbols: SymbolTable = {};
			fillSymbolTableWithDictionaryType(symbols, errors, parsed1, true);
			const functionTypeLiteral: ParseFunctionTypeLiteral = {
				type: 'functionTypeLiteral',
				params: params,
				returnType: parsed2.returnType,
				symbols: symbols,
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
			};
			return {
				hasParsed: true,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
				parsed: functionTypeLiteral,
				errors: errors,
			};
		}
		default: {
			const assertNever: never = parsed2;
			throw new Error(`Unexpected secondExpression.type: ${(assertNever as any).type}`);
		}
	}
}

//#region SimpleExpression

function simpleExpressionParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<SimpleExpression> {
	const result = sequenceParser(
		discriminatedChoiceParser(
			// BracketedExpression
			{
				predicate: openingBracketParser,
				parser: bracketedBaseParser,
			},
			// NumberLiteral
			{
				predicate: regexParser(/[-0-9]/y, ''),
				parser: numberParser,
			},
			// TextLiteral
			{
				predicate: paragraphParser,
				parser: choiceParser(
					inlineTextParser,
					multilineTextParser
				)
			},
			// Reference
			{
				predicate: regexParser(/[a-zA-Z]/y, ''),
				parser: referenceParser,
			},
		),
		multiplicationParser(
			0,
			undefined,
			discriminatedChoiceParser(
				// Field/Index Reference
				{
					predicate: nestedReferenceTokenParser,
					parser: moveColumnIndex(1, choiceParser(
						nameParser,
						inlineTextParser,
						indexParser,
					)),
				},
				// FunctionCall
				{
					predicate: openingBracketParser,
					// ObjectLiteral
					parser: functionArgumentsParser
				},
				// Infix FunctionCall
				{
					predicate: choiceParser(
						infixFunctionTokenParser,
						// TODO multiline functionCall mit Kommentarzeilen
					),
					parser: infixFunctionArgumentsParser,
				},
			)),
	)(rows, startRowIndex, startColumnIndex, indent);
	if (!result.hasParsed) {
		return {
			...result,
			parsed: undefined,
		};
	}
	const errors = result.errors
		? [...result.errors]
		: [];
	const [parsed1, parsed2] = result.parsed!;
	let expression: SimpleExpression = parsed1;
	if (parsed2.length) {
		// (Nested Ref/Function Call) Chain
		if (expression.type === 'bracketed') {
			expression = bracketedExpressionToValueExpression(expression, errors);
		}
		function setParentForFunctionCall(functionCall: ParseFunctionCall): void {
			setParent(functionCall.prefixArgument, functionCall);
			setParent(functionCall.functionExpression, functionCall);
			setParent(functionCall.arguments, functionCall);
		}
		expression = parsed2.reduce<SimpleExpression>(
			(accumulator, currentValue) => {
				switch (currentValue.type) {
					case 'infixFunctionArgs': {
						const args = currentValue.arguments;
						const functionCall: ParseFunctionCall = {
							type: 'functionCall',
							prefixArgument: accumulator,
							functionExpression: currentValue.infixFunctionReference,
							arguments: args,
							startRowIndex: accumulator.startRowIndex,
							startColumnIndex: accumulator.startColumnIndex,
							endRowIndex: currentValue.endRowIndex,
							endColumnIndex: currentValue.endColumnIndex,
						};
						setParentForFunctionCall(functionCall);
						return functionCall;
					}
					case 'index': {
						const indexReference: ParseIndexReference = {
							type: 'indexReference',
							source: accumulator,
							index: currentValue,
							startColumnIndex: accumulator.startColumnIndex,
							startRowIndex: accumulator.startRowIndex,
							endColumnIndex: currentValue.endColumnIndex,
							endRowIndex: currentValue.endColumnIndex,
						};
						return indexReference;
					}
					case 'name':
					case 'text': {
						if (currentValue.type === 'text') {
							errors.push(...getEscapableNameErrors(currentValue));
						}
						const fieldReference: ParseFieldReference = {
							type: 'fieldReference',
							source: accumulator,
							field: currentValue,
							startColumnIndex: accumulator.startColumnIndex,
							startRowIndex: accumulator.startRowIndex,
							endColumnIndex: currentValue.endColumnIndex,
							endRowIndex: currentValue.endColumnIndex,
						};
						return fieldReference;
					}
					default: {
						const functionCall: ParseFunctionCall = {
							type: 'functionCall',
							functionExpression: accumulator,
							arguments: currentValue,
							startRowIndex: accumulator.startRowIndex,
							startColumnIndex: accumulator.startColumnIndex,
							endRowIndex: currentValue.endRowIndex,
							endColumnIndex: currentValue.endColumnIndex,
						};
						setParentForFunctionCall(functionCall);
						return functionCall;
					}
				}
			},
			expression);
	}
	return {
		hasParsed: true,
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		parsed: expression,
		errors: errors,
	};
}

function numberParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<NumberLiteral> {
	const result = regexParser(/-?(0|[1-9][0-9]*)(\.[0-9]+)?f?/y, 'not a valid number')(rows, startRowIndex, startColumnIndex, indent);
	if (!result.hasParsed) {
		return {
			...result,
			parsed: undefined,
		};
	}
	const parsed = result.parsed!;
	if (last(parsed) === 'f') {
		return {
			hasParsed: true,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			parsed: {
				type: 'float',
				value: +parsed.substring(0, parsed.length - 1),
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
			},
		};
	}
	const decimalSeparatorIndex = parsed.indexOf('.');
	if (decimalSeparatorIndex > 0) {
		// TODO kürzen
		const numberOfDecimalPlaces = (parsed.length - 1) - decimalSeparatorIndex;
		return {
			...result,
			parsed: {
				type: 'fraction',
				numerator: BigInt(parsed.replace('.', '')),
				denominator: 10n ** BigInt(numberOfDecimalPlaces),
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
			},
		};
	}
	return {
		...result,
		parsed: {
			type: 'integer',
			value: BigInt(parsed),
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
		},
	};
}

//#region String

// TODO stringParser mit discriminated choice über linebreak

function inlineTextParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseTextLiteral> {
	const result = sequenceParser(
		paragraphParser,
		textLineContentParser,
		paragraphParser,
	)(rows, startRowIndex, startColumnIndex, indent);
	return {
		...result,
		parsed: result.parsed === undefined
			? undefined
			: {
				type: 'text',
				values: result.parsed[1],
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex,
			},
	};
}

function multilineTextParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseTextLiteral> {
	const result = sequenceParser(
		paragraphParser,
		// language identifier
		// TODO nur unterstützte sprachen? validieren?
		regexParser(/[a-z]*/y, 'language identifier'),
		newLineParser,
		incrementIndent(multilineParser(textLineContentParser)),
		newLineParser,
		indentParser,
		paragraphParser,
	)(rows, startRowIndex, startColumnIndex, indent);
	const values: (TextToken | ParseValueExpression)[] = [];
	let languageIdentifier: string | undefined;
	if (result.parsed) {
		languageIdentifier = result.parsed[1];
		result.parsed[3].forEach(line => {
			if (typeof line === 'object') {
				values.push(...line);
			}
			const tail = last(values);
			if (tail?.type === 'textToken') {
				tail.value += '\n';
			}
			else {
				const textToken: TextToken = {
					type: 'textToken',
					value: '\n'
				};
				values.push(textToken);
			}
		});
	}
	return {
		...result,
		parsed: result.parsed === undefined
			? undefined
			: {
				type: 'text',
				language: languageIdentifier,
				values: values,
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: result.endRowIndex,
				endColumnIndex: result.endColumnIndex
			},
	};
}

function textLineContentParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<(TextToken | ParseValueExpression)[]> {
	const result =
		multiplicationParser(
			0,
			undefined,
			choiceParser(
				regexParser(/([^§]+|§§|§#)/y, 'Invalid String Syntax'),
				sequenceParser(
					tokenParser('§('),
					valueExpressionParser,
					closingBracketParser,
				),
			)
		)(rows, startRowIndex, startColumnIndex, indent);
	return {
		...result,
		parsed: result.parsed?.map(choice => {
			switch (typeof choice) {
				case 'string':
					return {
						type: 'textToken',
						value: choice.startsWith('§')
							? choice.substring(1)
							: choice
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

/**
 * TODO multiline mit Kommentaren
 * Parst den Teil hinter dem . (infixFunctionToken)
 * Also FunctionReference und weitere Args, aber nicht das erste Arg vor dem .
 */
function infixFunctionArgumentsParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<{
	type: 'infixFunctionArgs',
	arguments?: BracketedExpression;
	infixFunctionReference?: Reference;
	endRowIndex: number,
	endColumnIndex: number,
}> {
	// TODO greedy SequenceParser der soviel von der Sequence parst wie möglich?
	// const result = sequenceParser(
	// 	infixFunctionTokenParser,
	// 	nameParser,
	// 	functionArgumentsParser,
	// )(rows, startRowIndex, startColumnIndex, indent);
	const infixTokenResult = infixFunctionTokenParser(rows, startRowIndex, startColumnIndex, indent);
	if (!infixTokenResult.hasParsed) {
		return {
			...infixTokenResult,
			parsed: undefined,
		};
	}
	const errors = infixTokenResult.errors ?? [];
	let endRowIndex = infixTokenResult.endRowIndex;
	let endColumnIndex = infixTokenResult.endColumnIndex;
	const functionReferenceResult = referenceParser(rows, endRowIndex, endColumnIndex, indent);
	if (functionReferenceResult.errors) {
		errors.push(...functionReferenceResult.errors);
	}
	let args: BracketedExpression | undefined;
	if (functionReferenceResult.hasParsed) {
		endRowIndex = functionReferenceResult.endRowIndex;
		endColumnIndex = functionReferenceResult.endColumnIndex;
		const argumentsResult = functionArgumentsParser(rows, endRowIndex, endColumnIndex, indent);
		if (argumentsResult.errors) {
			errors.push(...argumentsResult.errors);
		}
		args = argumentsResult.parsed;
		if (argumentsResult.hasParsed) {
			endRowIndex = argumentsResult.endRowIndex;
			endColumnIndex = argumentsResult.endColumnIndex;
		}
	}

	return {
		...infixTokenResult,
		endRowIndex: endRowIndex,
		endColumnIndex: endColumnIndex,
		parsed: {
			type: 'infixFunctionArgs',
			arguments: args,
			infixFunctionReference: functionReferenceResult.parsed,
			endRowIndex: endRowIndex,
			endColumnIndex: endColumnIndex,
		},
		errors: errors,
	};
}

function functionArgumentsParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<BracketedExpression> {
	const result = bracketedBaseParser(rows, startRowIndex, startColumnIndex, indent);
	const parsed = result.parsed;
	if (!parsed) {
		return result;
	}
	const errors = result.errors ?? [];
	const args = bracketedExpressionToValueExpression(parsed, errors);
	return {
		...result,
		parsed: args,
		errors: errors
	};
}

//#endregion SimpleExpression

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
		incrementIndent(multilineParser(valueExpressionParser))
	)(rows, startRowIndex, startColumnIndex, indent);
	return {
		...result,
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
		...result,
		parsed: result.parsed && {
			type: 'functionBody',
			body: result.parsed[1],
		},
	};
}

/**
 * FunctionTypeLiteral/FunctionLiteral mit ReturnType
 * enthält ggf. endständiges Zeilenende nicht
 */
function functionTypeBodyParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<{
	type: 'functionTypeBody';
	returnType: SimpleExpression;
	body?: ParseExpression[];
}> {
	const result = sequenceParser(
		typeGuardTokenParser,
		simpleExpressionParser,
		discriminatedChoiceParser(
			// FunctionLiteral mit ReturnType
			{
				predicate: functionTokenParser,
				parser: functionBodyParser
			},
			// FunctionTypeLiteral
			{
				predicate: emptyParser,
				parser: emptyParser,
			},
		),
	)(rows, startRowIndex, startColumnIndex, indent);
	return {
		...result,
		parsed: result.parsed && {
			type: 'functionTypeBody',
			returnType: result.parsed[1],
			body: result.parsed[2]?.body,
		},
	};
}

//#endregion ValueExpression

//#region bracketed

/**
 * Parsed beginnend mit öffnender bis zur 1. schließenden Klammer.
 * Multiline oder inline mit Leerzeichen getrennt.
 */
function bracketedBaseParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<BracketedExpressionBase> {
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
			parser: bracketedMultilineParser,
		},
		{
			predicate: emptyParser,
			parser: bracketedInlineParser,
		},
	)(rows, startRowIndex, startColumnIndex, indent);
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
		...result,
		parsed: bracketed,
	};
}

function bracketedMultilineParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<(ParseFieldBase | string | undefined)[]> {
	const result = sequenceParser(
		openingBracketParser,
		newLineParser,
		incrementIndent(multilineParser(fieldParser)),
		newLineParser,
		indentParser,
		closingBracketParser,
	)(rows, startRowIndex, startColumnIndex, indent);
	const parsed = result.parsed?.[2];
	return {
		...result,
		parsed: parsed,
	};
}

function bracketedInlineParser<T>(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseFieldBase[]> {
	const result = sequenceParser(
		openingBracketParser,
		fieldParser,
		multiplicationParser(
			0,
			undefined,
			sequenceParser(
				spaceParser,
				fieldParser,
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
		...result,
		parsed: parsed,
	};
}

//#endregion bracketed

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
				const expressionWithDescription = expressionOrComment.type === 'definition'
					|| expressionOrComment.type === 'field'
					? {
						...expressionOrComment,
						description: descriptionComment
					}
					: expressionOrComment;
				expressionsWithDescription.push(expressionWithDescription);
				descriptionComment = '';
				return;
			case 'string':
				if (expressionOrComment.startsWith('region') || expressionOrComment.startsWith('endregion')) {
					// region comments verwerfen
					return;
				}
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
		if (baseName.type !== 'reference') {
			// TODO nested destructuring?
			errors.push({
				message: `${baseName.type} is not a valid expression for destructuring field name`,
				startRowIndex: baseName.startRowIndex,
				startColumnIndex: baseName.startColumnIndex,
				endRowIndex: baseName.endRowIndex,
				endColumnIndex: baseName.endColumnIndex,
			});
		}
		if (baseField.spread) {
			// TODO spread ohne source, fallback, typeGuard?
		}
	});
}

function bracketedExpressionToParameters(
	bracketedExpression: BracketedExpressionBase,
	errors: ParserError[],
): BracketedExpressionBase | ParseParameterFields {
	const baseFields = bracketedExpression.fields;
	let rest: ParseParameterField | undefined;
	const singleFields: ParseParameterField[] = [];
	for (let index = 0; index < baseFields.length; index++) {
		const baseField = baseFields[index]!;
		const parseSource = baseField.assignedValue;
		let source: string | undefined;
		if (parseSource) {
			const checkedSource = checkName(parseSource);
			if (checkedSource) {
				source = checkedSource.name;
			}
			else {
				errors.push({
					message: `${parseSource.type} is not a valid expression for parameter source.`,
					startRowIndex: parseSource.startRowIndex,
					startColumnIndex: parseSource.startColumnIndex,
					endRowIndex: parseSource.endRowIndex,
					endColumnIndex: parseSource.endColumnIndex,
				});
			}
		}
		const checkedName = checkName(baseField.name);
		if (!checkedName) {
			// TODO collect all errors before returning?
			return bracketedExpression;
		}
		const parameterField: ParseParameterField = {
			type: 'parameter',
			description: baseField.description,
			name: checkedName,
			typeGuard: baseField.typeGuard,
			source: source,
			fallback: baseField.fallback,
			startRowIndex: baseField.startRowIndex,
			startColumnIndex: baseField.startColumnIndex,
			endRowIndex: baseField.endRowIndex,
			endColumnIndex: baseField.endColumnIndex,
		};
		if (baseField.spread) {
			if (index < baseFields.length - 1) {
				errors.push({
					message: 'Rest argument must be last.',
					startRowIndex: baseField.startRowIndex,
					startColumnIndex: baseField.startColumnIndex,
					endRowIndex: baseField.endRowIndex,
					endColumnIndex: baseField.endColumnIndex,
				});
				// TODO collect all errors before returning?
				return bracketedExpression;
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
			rest = parameterField;
		}
		else {
			singleFields.push(parameterField);
		}
	}
	return {
		type: 'parameters',
		singleFields: singleFields,
		rest: rest,
		startRowIndex: bracketedExpression.startRowIndex,
		startColumnIndex: bracketedExpression.startColumnIndex,
		endRowIndex: bracketedExpression.endRowIndex,
		endColumnIndex: bracketedExpression.endColumnIndex,
	};
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

function bracketedExpressionToValueExpression(
	bracketedExpression: BracketedExpressionBase,
	errors: ParserError[],
): BracketedExpression {
	const baseFields = bracketedExpression.fields;
	if (!isNonEmpty(baseFields)) {
		return {
			type: 'empty',
			startRowIndex: bracketedExpression.startRowIndex,
			startColumnIndex: bracketedExpression.startColumnIndex,
			endRowIndex: bracketedExpression.endRowIndex,
			endColumnIndex: bracketedExpression.endColumnIndex,
		};
	}
	const isList = baseFields.every(baseField =>
		!baseField.typeGuard
		&& !baseField.assignedValue
		// TODO ListLiteral mit Fallback?
		&& !baseField.fallback)
		&& baseFields.some(baseField => !baseField.spread);
	if (isList) {
		const list: ParseListLiteral = {
			type: 'list',
			values: mapNonEmpty(
				baseFields,
				baseField => {
					const value = baseValueExpressionToValueExpression(baseField.name, errors)
					if (baseField.spread) {
						const spreadValue: ParseSpreadValueExpression = {
							type: 'spread',
							value: value,
							startRowIndex: baseField.startRowIndex,
							startColumnIndex: baseField.startColumnIndex,
							endRowIndex: baseField.endRowIndex,
							endColumnIndex: baseField.endColumnIndex,
						}
						return spreadValue;
					}
					return value;
				}),
			startRowIndex: bracketedExpression.startRowIndex,
			startColumnIndex: bracketedExpression.startColumnIndex,
			endRowIndex: bracketedExpression.endRowIndex,
			endColumnIndex: bracketedExpression.endColumnIndex,
		};
		list.values.forEach(value => {
			setParent(value, list);
		});
		return list;
	}
	const isDictionary = baseFields.every(baseField =>
		// singleDictionaryField muss assignedValue haben
		baseField.spread || baseField.assignedValue)
		&& baseFields.some(baseField => baseField.assignedValue);
	if (isDictionary) {
		return {
			type: 'dictionary',
			fields: mapNonEmpty(
				baseFields,
				baseField => {
					const baseName = baseField.name;
					if (baseField.spread) {
						const typeGuard = baseField.typeGuard;
						if (typeGuard) {
							errors.push({
								message: `typeGuard is not allowed for spread dictionary field`,
								startRowIndex: typeGuard.startRowIndex,
								startColumnIndex: typeGuard.startColumnIndex,
								endRowIndex: typeGuard.endRowIndex,
								endColumnIndex: typeGuard.endColumnIndex,
							});
						}
						const assignedValue = baseField.assignedValue;
						if (assignedValue) {
							errors.push({
								message: `assignedValue is not allowed for spread dictionary field`,
								startRowIndex: assignedValue.startRowIndex,
								startColumnIndex: assignedValue.startColumnIndex,
								endRowIndex: assignedValue.endRowIndex,
								endColumnIndex: assignedValue.endColumnIndex,
							});
						}
						const fallback = baseField.fallback;
						if (fallback) {
							errors.push({
								message: `fallback is not allowed for spread dictionary field`,
								startRowIndex: fallback.startRowIndex,
								startColumnIndex: fallback.startColumnIndex,
								endRowIndex: fallback.endRowIndex,
								endColumnIndex: fallback.endColumnIndex,
							});
						}
						const spreadDictionaryField: ParseSpreadValueExpression = {
							type: 'spread',
							value: baseName,
							startRowIndex: baseField.startRowIndex,
							startColumnIndex: baseField.startColumnIndex,
							endRowIndex: baseField.endRowIndex,
							endColumnIndex: baseField.endColumnIndex,
						};
						return spreadDictionaryField;
					}
					errors.push(...getEscapableNameErrors(baseName));
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
				}),
			startRowIndex: bracketedExpression.startRowIndex,
			startColumnIndex: bracketedExpression.startColumnIndex,
			endRowIndex: bracketedExpression.endRowIndex,
			endColumnIndex: bracketedExpression.endColumnIndex,
		};
	}
	const isDictionaryType = baseFields.every(baseField =>
		!baseField.assignedValue
		&& !baseField.fallback)
		&& baseFields.some(baseField => baseField.typeGuard);
	if (isDictionaryType) {
		return {
			type: 'dictionaryType',
			fields: mapNonEmpty(
				baseFields,
				baseField => {
					const assignedValue = baseField.assignedValue;
					if (assignedValue) {
						errors.push({
							message: `assignedValue is not allowed for dictionaryType field`,
							startRowIndex: assignedValue.startRowIndex,
							startColumnIndex: assignedValue.startColumnIndex,
							endRowIndex: assignedValue.endRowIndex,
							endColumnIndex: assignedValue.endColumnIndex,
						});
					}
					const fallback = baseField.fallback;
					if (fallback) {
						errors.push({
							message: `fallback is not allowed for dictionaryType field`,
							startRowIndex: fallback.startRowIndex,
							startColumnIndex: fallback.startColumnIndex,
							endRowIndex: fallback.endRowIndex,
							endColumnIndex: fallback.endColumnIndex,
						});
					}
					const baseName = baseField.name;
					if (baseField.spread) {
						const typeGuard = baseField.typeGuard;
						if (typeGuard) {
							errors.push({
								message: `typeGuard is not allowed for spread dictionaryType field`,
								startRowIndex: typeGuard.startRowIndex,
								startColumnIndex: typeGuard.startColumnIndex,
								endRowIndex: typeGuard.endRowIndex,
								endColumnIndex: typeGuard.endColumnIndex,
							});
						}
						const spreadDictionaryField: ParseSpreadValueExpression = {
							type: 'spread',
							value: baseName,
							startRowIndex: baseField.startRowIndex,
							startColumnIndex: baseField.startColumnIndex,
							endRowIndex: baseField.endRowIndex,
							endColumnIndex: baseField.endColumnIndex,
						};
						return spreadDictionaryField;
					}
					errors.push(...getEscapableNameErrors(baseName));
					const singleDictionaryField: ParseSingleDictionaryTypeField = {
						type: 'singleDictionaryTypeField',
						name: baseName,
						typeGuard: baseField.typeGuard,
						startRowIndex: baseField.startRowIndex,
						startColumnIndex: baseField.startColumnIndex,
						endRowIndex: baseField.endRowIndex,
						endColumnIndex: baseField.endColumnIndex,
					};
					return singleDictionaryField;
				}),
			startRowIndex: bracketedExpression.startRowIndex,
			startColumnIndex: bracketedExpression.startColumnIndex,
			endRowIndex: bracketedExpression.endRowIndex,
			endColumnIndex: bracketedExpression.endColumnIndex,
		};
	}
	const isUnknownObject = baseFields.every(baseField =>
		baseField.spread
		&& !baseField.typeGuard);
	if (isUnknownObject) {
		return {
			type: 'object',
			values: mapNonEmpty(
				baseFields,
				baseField => {
					const spreadValue: ParseSpreadValueExpression = {
						type: 'spread',
						value: baseField.name,
						startRowIndex: baseField.startRowIndex,
						startColumnIndex: baseField.startColumnIndex,
						endRowIndex: baseField.endRowIndex,
						endColumnIndex: baseField.endColumnIndex,
					};
					return spreadValue;
				}
			),
			startRowIndex: bracketedExpression.startRowIndex,
			startColumnIndex: bracketedExpression.startColumnIndex,
			endRowIndex: bracketedExpression.endRowIndex,
			endColumnIndex: bracketedExpression.endColumnIndex,
		}
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

function getEscapableNameErrors(baseName: ParseValueExpressionBase): ParserError[] {
	const errors: ParserError[] = [];
	switch (baseName.type) {
		case 'reference':
			break;
		case 'text':
			if (baseName.values.length > 1) {
				// TODO string parser combine multiline string to single token and allow multiline string for escaped name?
				errors.push({
					message: `escaped name can not be a multiline string literal`,
					startRowIndex: baseName.startRowIndex,
					startColumnIndex: baseName.startColumnIndex,
					endRowIndex: baseName.endRowIndex,
					endColumnIndex: baseName.endColumnIndex,
				});
			}
			if (baseName.values.some(value => value.type !== 'textToken')) {
				errors.push({
					message: `escaped name can not contain string interpolation`,
					startRowIndex: baseName.startRowIndex,
					startColumnIndex: baseName.startColumnIndex,
					endRowIndex: baseName.endRowIndex,
					endColumnIndex: baseName.endColumnIndex,
				});
			}
			break;
		default:
			errors.push({
				message: `${baseName.type} is not a valid expression for escapable name`,
				startRowIndex: baseName.startRowIndex,
				startColumnIndex: baseName.startColumnIndex,
				endRowIndex: baseName.endRowIndex,
				endColumnIndex: baseName.endColumnIndex,
			});
			break;
	}
	return errors;
}

//#endregion convert

function setParent(expression: PositionedExpressionBase | undefined, parent: ParseExpression): void {
	if (expression) {
		expression.parent = parent;
	}
}

//#region import

function getImportedPaths(
	expressions: ParseExpression[] | undefined,
	sourceFolder: string,
): {
	paths: string[];
	errors: ParserError[];
} {
	const importedPaths: string[] = [];
	const errors: ParserError[] = [];
	expressions?.forEach(expression => {
		switch (expression.type) {
			case 'functionCall':
				// TODO impure imports erlauben?
				return;

			case 'definition':
			case 'destructuring':
				const value = expression.value;
				if (isImportFunctionCall(value)) {
					const { fullPath, error } = getPathFromImport(value, sourceFolder);
					if (error) {
						errors.push(error);
					}
					if (fullPath) {
						importedPaths.push(fullPath);
					}
				}
				return;

			default:
				return;
		}
	});
	return {
		paths: importedPaths,
		errors: errors,
	};
}

/**
 * Prüft extension und file exists
 */
export function getPathFromImport(
	importExpression: ParseFunctionCall,
	/**
	 * Pfad des Ordners, der die Quelldatei enthält
	 */
	sourceFolder: string,
): {
	/**
	 * Relative path
	 */
	path?: string;
	fullPath?: string;
	error?: ParserError;
} {
	if (!importExpression.arguments) {
		return {
			error: {
				message: 'arguments missing for import',
				startRowIndex: importExpression.startRowIndex,
				startColumnIndex: importExpression.startColumnIndex,
				endRowIndex: importExpression.endColumnIndex,
				endColumnIndex: importExpression.endColumnIndex,
			}
		};
	}
	const pathExpression = getPathExpression(importExpression.arguments);
	if (pathExpression?.type === 'text'
		&& pathExpression.values.length === 1
		&& pathExpression.values[0]!.type === 'textToken') {
		const importedPath = pathExpression.values[0].value;
		const extension = extname(importedPath);
		if (!isValidExtension(extension)) {
			return {
				error: {
					message: `Unexpected extension for import: ${extension}`,
					startRowIndex: pathExpression.startRowIndex,
					startColumnIndex: pathExpression.startColumnIndex,
					endRowIndex: pathExpression.endRowIndex,
					endColumnIndex: pathExpression.endColumnIndex,
				}
			};
		}
		const fullPath = join(sourceFolder, importedPath);
		const fileNotFoundError: ParserError | undefined = existsSync(fullPath)
			? undefined
			: {
				message: `File not found: ${fullPath}`,
				startRowIndex: pathExpression.startRowIndex,
				startColumnIndex: pathExpression.startColumnIndex,
				endRowIndex: pathExpression.endRowIndex,
				endColumnIndex: pathExpression.endColumnIndex,
			}
		return {
			path: importedPath,
			fullPath: fullPath,
			error: fileNotFoundError,
		};
	}
	// TODO dynamische imports verbieten???
	return {
		error: {
			message: 'dynamic import not allowed',
			startRowIndex: importExpression.startRowIndex,
			startColumnIndex: importExpression.startColumnIndex,
			endRowIndex: importExpression.endColumnIndex,
			endColumnIndex: importExpression.endColumnIndex,
		}
	};
}

export function getPathExpression(importParams: BracketedExpression): ParseListValue | undefined {
	switch (importParams.type) {
		case 'dictionary':
			return importParams.fields[0].value;
		case 'bracketed':
		case 'dictionaryType':
		case 'empty':
		case 'object':
			return undefined;
		case 'list':
			return importParams.values[0];
		default: {
			const assertNever: never = importParams;
			throw new Error(`Unexpected importParams.type: ${(assertNever as BracketedExpression).type}`);
		}
	}
}

export function isImportFunctionCall(expression: ParseExpression): expression is ParseFunctionCall {
	if (expression.type !== 'functionCall') {
		return false;
	}
	return isImportFunction(expression.functionExpression);
}

export function isImportFunction(functionExpression: SimpleExpression | undefined): boolean {
	return !!functionExpression
		&& functionExpression.type === 'reference'
		&& functionExpression.name.name === 'import';
}

//#endregion import