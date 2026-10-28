import {
	BracketedExpression,
	ParseBindingExpression,
	ParseDataExpression,
	Index,
	Name,
	NumberLiteral,
	ParseBranching,
	ParseTypeBranching,
	ParseDestructuringDefinition,
	ParseDestructuringField,
	ParseDestructuringFields,
	ParsedExpressions,
	ParsedFile,
	ParseDictionaryLiteral,
	ParseDictionaryTypeLiteral,
	ParseExpression,
	ParseFieldBase,
	ParseFunctionLiteral,
	ParseFunctionCall,
	ParseListLiteral,
	ParseListValue,
	ParseNestedReference,
	ParseParameterField,
	ParseParameterFields,
	ParseSingleDefinition,
	ParseSingleDictionaryField,
	ParseSingleDictionaryTypeField,
	ParseSpreadValueExpression,
	ParseTextLiteral,
	ParseValueExpression,
	PositionedExpression,
	ImportedDependency,
	ParseReference,
	Purity,
	SimpleExpression,
	SymbolTable,
	TextToken,
	createSymbolTable,
} from '../syntax-tree.js';
import {
	executingDirectory,
	Extension,
	isNonEmpty,
	isTestFilePath,
	isValidExtension,
	last,
	mapNonEmpty,
	readTextFile,
} from '../util.js';
import { CompilerError, ErrorCode, Positioned } from '../compiler-errors.js';
import { getCommentDirectiveError, isDirectiveCommentText, parseIgnoreComments } from './comment-directives.js';
import { parseTsCode } from './typescript-parser.js';
import {
	createParseFunctionLiteral,
	createParseFunctionTypeLiteral,
	createParseParameters,
	fillSymbolTableWithFields,
	fillSymbolTableWithExpressions,
	setParentsAndIds,
	setFileSymbolIds,
} from './parser-utils.js';
import { basename, dirname, extname, join } from 'path';
import { _parseJson, JsonValue, normalizeRational } from '../runtime/runtime.js';
import { jsonValueToParsedExpressions } from './json-parser.js';
import { load } from 'js-yaml';

/**
 * Ein Parser liest an (Zeile, Spalte) bei der Einrückungstiefe indent. Parser arbeiten auf Zeilen
 * (rows), die Tiefe zählt die Tabs der Zeile.
 */
type LineParser<T> = (
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
) => ParserResult<T>;

interface ParserResult<T> {
	/**
	 * Gibt an, ob etwas geparst wurde.
	 * Es kann trotzdem errors geben.
	 */
	hasParsed: boolean;
	parsed?: T;
	endRowIndex: number;
	endColumnIndex: number;
	errors?: CompilerError[];
}

function endOfCodeError(searched: string): string {
	return `End of code reached while looking for ${searched}`;
}

const coreLibFileName = 'core-lib.jul';
export const coreLibPath = join(executingDirectory, 'runtime', coreLibFileName);

/**
 * Ist die Datei die core-lib?
 * Die core-lib definiert die builtInSymbols selbst und muss daher ohne oberen Scope gecheckt
 * werden, sonst stünde ihre Symboltabelle doppelt im Scope Stack.
 *
 * Erkennung über den Dateinamen und nicht über coreLibPath: der Sprachserver läuft aus dem out
 * Verzeichnis der installierten Extension, im Editor wird aber die Quelldatei aus dem Repo
 * geöffnet. Von der Extension aus ist deren Pfad nicht ableitbar, ein Pfadvergleich würde die
 * Quelldatei also nie erkennen.
 */
export function isCoreLibPath(filePath: string): boolean {
	// unter win32 sind Dateinamen case insensitiv
	const fileName = process.platform === 'win32'
		? basename(filePath).toLowerCase()
		: basename(filePath);
	return fileName === coreLibFileName;
}

/**
 * @throws Wirft Error wenn Datei nicht gelesen werden kann.
 */
export function parseFile(filePath: string): ParsedFile {
	const code = readTextFile(filePath);
	const result = parseCode(code, filePath);
	return result;
}

/**
 * untyped: Die Datei ist zu groß für einen Typ (siehe maxTypedFileSize). Eine Datendatei
 * (.json, .yaml) bekommt dann keinen Syntaxbaum: Niemand liest ihn, der Emitter arbeitet vom
 * geparsten Wert (ParsedFile.jsonValue).
 */
export function parseCode(
	code: string,
	filePath: string,
	untyped?: boolean,
): ParsedFile {
	const extension = extname(filePath);
	if (!isValidExtension(extension)) {
		throw new Error(`Unexpected extension for parseCode: ${extension}`);
	}
	const sourceFolder = dirname(filePath);
	let parsedExpressions: ParsedExpressions;
	let dependencies: ImportedDependency[] | undefined;
	let jsonValue: JsonValue | undefined;
	switch (extension) {
		case Extension.js:
			parsedExpressions = parseTsCode(code, filePath);
			break;
		case Extension.json: {
			const parsedJson = _parseJson(code);
			if (parsedJson instanceof Error) {
				parsedExpressions = {
					errors: [{
						code: ErrorCode.invalidJson,
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
			if (untyped) {
				jsonValue = parsedJson;
				parsedExpressions = { errors: [] };
				break;
			}
			parsedExpressions = jsonValueToParsedExpressions(parsedJson);
			break;
		}
		case Extension.jul: {
			parsedExpressions = parseJulCode(code);
			const imported = getImportedPaths(parsedExpressions.expressions, sourceFolder, isTestFilePath(filePath));
			parsedExpressions.errors.push(...imported.errors);
			dependencies = imported.dependencies;
			break;
		}
		case Extension.ts:
			parsedExpressions = parseTsCode(code, filePath);
			break;
		case Extension.yaml: {
			if (untyped) {
				parsedExpressions = { errors: [] };
				break;
			}
			// TODO bigints, Fractions
			const parsedYaml = load(code);
			parsedExpressions = jsonValueToParsedExpressions(parsedYaml as any);
			break;
		}
		default: {
			const assertNever: never = extension;
			throw new Error(`Unexpected extension: ${assertNever}`);
		}
	}
	const { errors, expressions, ignoreComments } = parsedExpressions;
	// Erst hier, nicht beim Bauen der Knoten: siehe setParentsAndIds.
	const { nodeCount, symbolCount } = expressions
		? setParentsAndIds(expressions)
		: { nodeCount: 0, symbolCount: 0 };
	const symbols = createSymbolTable();
	expressions && fillSymbolTableWithExpressions(symbols, errors, expressions);
	const fileSymbolCount = setFileSymbolIds(symbols, symbolCount);
	return {
		filePath: filePath,
		extension: extension,
		sourceFolder: sourceFolder,
		lineCount: parsedExpressions.lineCount ?? 0,
		nodeCount: nodeCount,
		symbolCount: fileSymbolCount,
		syntax: {
			errors: errors,
			expressions: expressions,
			symbols: symbols,
			ignoreComments: ignoreComments,
		},
		dependencies: dependencies,
		jsonValue: jsonValue,
	};
}

function parseJulCode(code: string): ParsedExpressions {
	const errors: CompilerError[] = [];
	const rows = code.split('\n').map((row, rowIndex) => {
		if (!row.endsWith('\r')) {
			return row;
		}
		errors.push({
			code: ErrorCode.windowsLineEnding,
			message: 'Line uses \\r\\n (Windows) instead of \\n as line ending.',
			startRowIndex: rowIndex,
			startColumnIndex: row.length - 1,
			endRowIndex: rowIndex,
			endColumnIndex: row.length,
		});
		return row.slice(0, -1);
	});
	const parserResult = expressionBlockParser(rows, 0, 0, 0);
	const expressions = parserResult.parsed;
	errors.push(...(parserResult.errors ?? []));
	// check end of code reached
	if (parserResult.endRowIndex !== rows.length) {
		errors.push({
			code: ErrorCode.unparsedCode,
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
		ignoreComments: parseIgnoreComments(rows),
		// Eine abschließende leere Zeile hinter dem letzten Zeilenumbruch ist keine Zeile.
		lineCount: rows[rows.length - 1] === '' ? rows.length - 1 : rows.length,
	};
}

//#region Tokens

/**
 * Die beiden Klammerarten. Rund ist eine Bindungsstelle (Aufruf, Parameterliste,
 * Destructuring), eckig ein Datenliteral.
 * Indiziert nach der Art, die auch den erzeugten Knotentyp bestimmt.
 */
const brackets = {
	round: {
		openingCharacter: '(',
		closingCharacter: ')',
		nodeType: 'binding',
	},
	square: {
		openingCharacter: '[',
		closingCharacter: ']',
		nodeType: 'data',
	},
} as const;

type BracketKind = keyof typeof brackets;

function hasOnlyEmptyRowsAfter(rows: string[], rowIndex: number): boolean {
	for (let index = rowIndex + 1; index < rows.length; index++) {
		if (rows[index] !== '') {
			return false;
		}
	}
	return true;
}

function closingBracketMissingError(
	closingCharacter: string,
	rowIndex: number,
	columnIndex: number,
): CompilerError {
	return {
		code: ErrorCode.closingBracketMissing,
		message: `Expected closing bracket ${closingCharacter}.`,
		startRowIndex: rowIndex,
		startColumnIndex: columnIndex,
		endRowIndex: rowIndex,
		endColumnIndex: columnIndex,
	};
}

/**
 * Eine noch nicht aufgelöste Klammer, gleich welcher Art.
 */
function isBracketed(expression: { type: string; }): expression is ParseBindingExpression | ParseDataExpression {
	return expression.type === 'binding'
		|| expression.type === 'data';
}

//#endregion Tokens

//#region utility parser

/**
 * Ergebnis eines Tokens, das an dieser Stelle nicht steht. Der Aufrufer prüft vorher mit
 * startsWith, ob es passt, und ruft das hier nur im Fehlerfall: Meldung und Position sind
 * dieselben wie bei tokenParser.
 */
function tokenFailure(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	token: string,
): ParserResult<never> {
	const row = rows[startRowIndex];
	if (row === undefined) {
		return {
			hasParsed: false,
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: [{
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: startRowIndex,
				endColumnIndex: startColumnIndex,
				code: ErrorCode.endOfCode,
				message: endOfCodeError(token),
			}],
		};
	}
	for (let tokenIndex = 0; tokenIndex < token.length; tokenIndex++) {
		const tokenChar = token[tokenIndex];
		const columnIndex = tokenIndex + startColumnIndex;
		const codeChar = row[columnIndex];
		if (!codeChar) {
			return {
				hasParsed: false,
				endRowIndex: startRowIndex,
				endColumnIndex: columnIndex,
				errors: [{
					startRowIndex: startRowIndex,
					startColumnIndex: startColumnIndex,
					endRowIndex: startRowIndex,
					endColumnIndex: columnIndex,
					code: ErrorCode.endOfCode,
					message: endOfCodeError(token),
				}],
			};
		}
		if (codeChar !== tokenChar) {
			return {
				hasParsed: false,
				endRowIndex: startRowIndex,
				endColumnIndex: columnIndex,
				errors: [{
					startRowIndex: startRowIndex,
					startColumnIndex: startColumnIndex,
					endRowIndex: startRowIndex,
					endColumnIndex: columnIndex,
					code: ErrorCode.unexpectedCharacter,
					message: `Unexpected character: ${codeChar} while looking for: ${token}`,
				}],
			};
		}
	}
	throw new Error(`Token ${token} passt an dieser Stelle, tokenFailure ist nur für den Fehlerfall`);
}

/**
 * Ergebnis eines Regex, der an dieser Stelle nicht passt (wie regexParser, ohne Treffer).
 * error fehlt bei Prädikat-Parsern: Deren Fehler wird ohnehin verworfen.
 */
function regexFailure(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	error: { code: ErrorCode; message: string; },
): ParserResult<never> {
	if (rows[startRowIndex] === undefined) {
		return {
			hasParsed: false,
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: [{
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: startRowIndex,
				endColumnIndex: startColumnIndex,
				code: ErrorCode.regexAtEndOfCode,
				message: 'Can not match regex at end of code',
			}],
		};
	}
	return {
		hasParsed: false,
		endRowIndex: startRowIndex,
		endColumnIndex: startColumnIndex,
		errors: [{
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			code: error.code,
			message: error.message,
		}],
	};
}

/**
 * Liefert CompilerErrorResult bei endOfCode
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
				code: ErrorCode.endOfCode,
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
				code: ErrorCode.expectedStartOfLine,
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
 * Liefert CompilerErrorResult bei endOfCode
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
				code: ErrorCode.expectedEndOfLine,
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
	if (startColumnIndex === rows[startRowIndex]?.length) {
		return {
			hasParsed: true,
			endRowIndex: startRowIndex + 1,
			endColumnIndex: 0,
		};
	}
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

/**
 * Leerzeichen je Einrückungsebene, einmal je Datei ermittelt.
 * Die Breite ist eine Eigenschaft der Datei, nicht der Parse-Position: nebenbei beim Parsen
 * ermittelt hinge sie von Reihenfolge und Backtracking ab. rows entsteht genau einmal je
 * Parse-Lauf, deshalb genügt die Array-Identität als Schlüssel.
 */
const indentUnitByRows = new WeakMap<string[], number | undefined>();

function greatestCommonDivisor(a: number, b: number): number {
	while (b) {
		const rest = a % b;
		a = b;
		b = rest;
	}
	return a;
}

/**
 * undefined heißt unbekannt: dann wird Leerzeichen-Einrückung nicht erkannt und es bleibt beim
 * strikten Tab-Verhalten. Lieber gar nicht raten als eine falsche Ebene annehmen - eine falsch
 * geratene Ebene zerstört die Struktur der ganzen Datei.
 */
function getIndentUnit(rows: string[]): number | undefined {
	if (indentUnitByRows.has(rows)) {
		return indentUnitByRows.get(rows);
	}
	let unit: number | undefined = undefined;
	let maxSpaceCount = 0;
	for (const row of rows) {
		let spaceCount = 0;
		while (row[spaceCount] === ' ') {
			spaceCount++;
		}
		if (!spaceCount
			// gemischte Einrückung sagt nichts über die Breite: unklar, wie viele Ebenen der
			// Tab-Anteil ausmacht
			|| row[spaceCount] === '\t'
			// Zeile aus lauter Leerzeichen ist eine Leerzeile, keine Einrückung
			|| spaceCount === row.length) {
			continue;
		}
		maxSpaceCount = Math.max(maxSpaceCount, spaceCount);
		unit = unit === undefined
			? spaceCount
			: greatestCommonDivisor(unit, spaceCount);
	}
	// ggT 1 trotz längerer Sequenzen: die Datei ist nicht einheitlich eingerückt, oder der Inhalt
	// eines mehrzeiligen Textliterals verfälscht die Messung.
	const result = unit === 1 && maxSpaceCount > 1
		? undefined
		: unit;
	indentUnitByRows.set(rows, result);
	return result;
}

/**
 * Läuft die Einrückung zeichenweise ab und zählt Ebenen, bis indent erreicht ist - und nicht
 * weiter. Alles dahinter bleibt Inhalt; sonst würde der Inhalt eines mehrzeiligen Textliterals,
 * der mit Leerzeichen beginnen darf, mitgefressen.
 * Liefert undefined, wenn die erwartete Tiefe nicht mit Leerzeichen erreicht wird - dann gilt
 * unverändert das Ergebnis des Tab-Vergleichs (Dedent bzw. Blockende).
 */
function spaceIndentParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<undefined> | undefined {
	const row = rows[startRowIndex];
	if (row === undefined) {
		return undefined;
	}
	const indentUnit = getIndentUnit(rows);
	let columnIndex = startColumnIndex;
	let level = 0;
	let hasSpaceIndentation = false;
	while (level < indent) {
		if (row[columnIndex] === '\t') {
			columnIndex++;
			level++;
			continue;
		}
		if (row[columnIndex] !== ' ' || indentUnit === undefined) {
			// Zeile ist flacher als erwartet (echtes Dedent) oder die Breite ist unbekannt
			return undefined;
		}
		let spaceCount = 0;
		while (spaceCount < indentUnit && row[columnIndex + spaceCount] === ' ') {
			spaceCount++;
		}
		if (spaceCount < indentUnit) {
			// angefangene Ebene: ergibt keine ganze Ebene, also keine Aussage
			return undefined;
		}
		columnIndex += indentUnit;
		level++;
		hasSpaceIndentation = true;
	}
	if (!hasSpaceIndentation) {
		// reine Tabs hätte bereits der Tab-Vergleich gematcht
		return undefined;
	}
	return {
		hasParsed: true,
		endRowIndex: startRowIndex,
		endColumnIndex: columnIndex,
		errors: [{
			code: ErrorCode.spaceIndentation,
			message: `Indentation uses spaces instead of tabs. Expected ${indent} tab(s).`,
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: startRowIndex,
			endColumnIndex: columnIndex,
			expectedIndent: indent,
		}],
	};
}

const indentTokens: string[] = [];

function getIndentToken(indent: number): string {
	return indentTokens[indent] ??= '\t'.repeat(indent);
}

function indentParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<undefined> {
	if (startColumnIndex !== 0) {
		return startOfLineParser(rows, startRowIndex, startColumnIndex, indent);
	}
	const totalIndentToken = getIndentToken(indent);
	if (rows[startRowIndex]?.startsWith(totalIndentToken, startColumnIndex)) {
		return {
			hasParsed: true,
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex + totalIndentToken.length,
		};
	}
	const indentResult = tokenFailure(rows, startRowIndex, startColumnIndex, totalIndentToken);
	// Die erwartete Tiefe mit Leerzeichen zu erreichen ist ein Erfolg mit Diagnose, kein
	// Fehlschlag: ein Fehlschlag würde beim Backtracking (Wiederholung, Auswahl)
	// samt Diagnose verworfen und käme beim Nutzer nie an.
	return spaceIndentParser(rows, startRowIndex, startColumnIndex, indent)
		?? indentResult;
}

function indentMatcher(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): boolean {
	return startColumnIndex === 0
		&& (rows[startRowIndex]?.startsWith(getIndentToken(indent), startColumnIndex) === true
			|| spaceIndentParser(rows, startRowIndex, startColumnIndex, indent) !== undefined);
}

/**
 * Beginnt mit columnIndex = 0.
 * Parst undefined bei Leerzeile.
 * Parst string bei Kommentarzeile.
 * Enthält ggf. endständiges Zeilenende nicht.
 * TODO comment in AST für Intellisense?
 */
function multilineBlock<T>(
	parser: LineParser<T>,
	/**
	 * Steht hinter einem Ausdruck eine schließende Klammer, endet der Block vor ihr, statt den Rest
	 * der Zeile zu überspringen. Die Klammer gehört dem umschließenden Aufruf oder Literal.
	 */
	stopAtClosingBracket: boolean,
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<(T | string | undefined)[]> {
	const startOfLineResult = startOfLineParser(rows, startRowIndex, startColumnIndex, indent);
	if (!startOfLineResult.hasParsed) {
		return {
			...startOfLineResult,
		};
	}
	const parsed: (T | string | undefined)[] = [];
	const errors: CompilerError[] = [];
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
		// Reine Tab-Einrückung ist der Regelfall und braucht kein Ergebnisobjekt, das Blockende
		// ebenso kein Fehlerobjekt.
		const hasTabIndent = row.startsWith(getIndentToken(indent));
		const indentResult = hasTabIndent
			? undefined
			: indentMatcher(rows, rowIndex, columnIndex, indent)
				? indentParser(rows, rowIndex, columnIndex, indent)
				: undefined;
		if (!hasTabIndent && !indentResult) {
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
		columnIndex = indentResult
			? indentResult.endColumnIndex
			: indent;
		if (indentResult?.errors) {
			// spaceIndentation: die Zeile wurde trotz falscher Einrückung auf der erwarteten
			// Ebene erkannt, die Diagnose muss aber sichtbar bleiben.
			errors.push(...indentResult.errors);
		}
		if (row[columnIndex] === '#') {
			// Kommentarzeile
			const comment = row.substring(columnIndex + 1);
			const directiveError = getCommentDirectiveError(comment, rowIndex, columnIndex, row.length);
			if (directiveError) {
				errors.push(directiveError);
			}
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
			const restCharacter = endRow[result.endColumnIndex];
			if (stopAtClosingBracket && (restCharacter === ')' || restCharacter === ']')) {
				return {
					hasParsed: true,
					endRowIndex: rowIndex,
					endColumnIndex: result.endColumnIndex,
					parsed: parsed,
					errors: errors,
				};
			}
			errors.push({
				code: ErrorCode.unparsedRestOfRow,
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
}

function expressionBlockParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
	/**
	 * Für Blöcke unter einem Pfeil: Eine schließende Klammer hinter dem letzten Ausdruck gehört dem
	 * umschließenden Aufruf oder Literal und beendet den Block.
	 */
	stopAtClosingBracket: boolean = false,
): ParserResult<ParseExpression[]> {
	const endOfCodeError = checkEndOfCode(rows, startRowIndex, startColumnIndex, 'expressionBlock');
	if (endOfCodeError) {
		return endOfCodeError;
	}
	const result = multilineBlock(orphanCheckedExpressionParser, stopAtClosingBracket, rows, startRowIndex, startColumnIndex, indent);
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
	checkOptionalNotAllowed(parsed, errors);
	const baseName = parsed.name;
	// bei name = BracketedExpression und definition: DestructuringDefinition
	// bei name = ref und definition: SingleDefinition
	// bei alles außer name leer: valueExpression
	// sonst Fehler
	if ((baseName.type === 'binding') && parsed.definition) {
		if (parsed.spread) {
			errors.push({
				code: ErrorCode.spreadNotAllowedForDestructuring,
				message: 'spread not allowed for destructuring',
				startRowIndex: parsed.startRowIndex,
				startColumnIndex: parsed.startColumnIndex,
				endRowIndex: parsed.startRowIndex,
				endColumnIndex: parsed.startColumnIndex + 3,
			});
		}
		if (parsed.typeGuard) {
			errors.push({
				code: ErrorCode.typeGuardNotAllowedForDestructuring,
				message: 'typeGuard not allowed for destructuring',
				startRowIndex: parsed.typeGuard.startRowIndex,
				startColumnIndex: parsed.typeGuard.startColumnIndex,
				endRowIndex: parsed.typeGuard.endRowIndex,
				endColumnIndex: parsed.typeGuard.endColumnIndex,
			});
		}
		const value = parsed.assignedValue;
		if (!value) {
			errors.push({
				code: ErrorCode.assignedValueMissingForDestructuring,
				message: 'assignedValue missing for destructuring',
				startRowIndex: parsed.startRowIndex,
				startColumnIndex: parsed.startColumnIndex,
				endRowIndex: parsed.endRowIndex,
				endColumnIndex: parsed.endColumnIndex,
			});
		}
		const fields = bindingToDestructuringFields(baseName, errors);
		const destructuring: ParseDestructuringDefinition = {
			type: 'destructuring',
			fields: fields,
			value: value,
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
	if (baseName.type === 'reference' && parsed.definition) {
		if (!parsed.assignedValue) {
			errors.push({
				code: ErrorCode.assignedValueMissingForDefinition,
				message: 'assignedValue missing for definition',
				startRowIndex: parsed.startRowIndex,
				startColumnIndex: parsed.startColumnIndex,
				endRowIndex: parsed.endRowIndex,
				endColumnIndex: parsed.endColumnIndex,
			});
		}
		const definition: ParseSingleDefinition = {
			type: 'definition',
			description: parsed.description,
			name: baseName.name,
			typeGuard: parsed.typeGuard,
			value: parsed.assignedValue,
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
			code: ErrorCode.spreadNotAllowedForValueExpression,
			message: 'spread not allowed for valueExpression',
			startRowIndex: parsed.startRowIndex,
			startColumnIndex: parsed.startColumnIndex,
			endRowIndex: parsed.startRowIndex,
			endColumnIndex: parsed.startColumnIndex + 3,
		});
	}
	if (parsed.typeGuard) {
		errors.push({
			code: ErrorCode.typeGuardNotAllowedForValueExpression,
			message: 'typeGuard not allowed for valueExpression',
			startRowIndex: parsed.typeGuard.startRowIndex,
			startColumnIndex: parsed.typeGuard.startColumnIndex,
			endRowIndex: parsed.typeGuard.endRowIndex,
			endColumnIndex: parsed.typeGuard.endColumnIndex,
		});
	}
	if (parsed.definition) {
		errors.push({
			code: ErrorCode.definitionNotAllowedForValueExpression,
			message: 'definition not allowed for valueExpression',
			// TODO definition token position?
			startRowIndex: parsed.startRowIndex,
			startColumnIndex: parsed.startColumnIndex,
			endRowIndex: parsed.endRowIndex,
			endColumnIndex: parsed.endColumnIndex,
		});
	}
	if (isBracketed(baseName)) {
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

const nameRegex = /[a-zA-Z][0-9a-zA-Z]*\$?/y;
const invalidNameError = { code: ErrorCode.invalidName, message: 'Invalid name' };

function nameParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<Name> {
	const row = rows[startRowIndex];
	if (row !== undefined) {
		nameRegex.lastIndex = startColumnIndex;
		const match = nameRegex.exec(row);
		if (match) {
			const endColumnIndex = startColumnIndex + match[0].length;
			return {
				hasParsed: true,
				endRowIndex: startRowIndex,
				endColumnIndex: endColumnIndex,
				parsed: {
					type: 'name',
					name: match[0],
					startRowIndex: startRowIndex,
					startColumnIndex: startColumnIndex,
					endRowIndex: startRowIndex,
					endColumnIndex: endColumnIndex,
				},
			};
		}
	}
	// Fehlerpfad wie bisher über den regexParser, damit Meldung und Position gleich bleiben
	return regexFailure(rows, startRowIndex, startColumnIndex, invalidNameError);
}

function referenceParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseReference> {
	const result = nameParser(rows, startRowIndex, startColumnIndex, indent);
	if (!result.parsed) {
		return result as ParserResult<never>;
	}
	return {
		hasParsed: true,
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		parsed: {
			type: 'reference',
			name: result.parsed,
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
		},
	};
}

function nestedReferenceKeyParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<{
	type: 'nestedReference';
	nestedKey?: Name | ParseTextLiteral | Index;
}> {
	// Hinter dem / steht ein Name, ein Text, ein Index oder nichts (beim Tippen).
	const keyColumnIndex = startColumnIndex + 1;
	const character = rows[startRowIndex]?.[keyColumnIndex];
	let result: ParserResult<Name | ParseTextLiteral | Index> | undefined;
	if (character !== undefined && nameStartRegex.test(character)) {
		result = nameParser(rows, startRowIndex, keyColumnIndex, indent);
	}
	else if (character === '§') {
		const textResult = inlineTextParser(rows, startRowIndex, keyColumnIndex, indent);
		if (textResult.hasParsed) {
			result = textResult;
		}
	}
	if (!result && character !== undefined && character >= '0' && character <= '9') {
		result = indexParser(rows, startRowIndex, keyColumnIndex, indent);
	}
	result ??= {
		hasParsed: true,
		endRowIndex: startRowIndex,
		endColumnIndex: keyColumnIndex,
	};
	const errors = result.errors
		? [...result.errors]
		: [];
	if (result.parsed === undefined) {
		errors.push({
			code: ErrorCode.expectedNestedKey,
			message: 'Expected a nested key',
			startRowIndex: result.endRowIndex,
			startColumnIndex: result.endColumnIndex - 1,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
		});
	}
	return {
		...result,
		parsed: {
			type: 'nestedReference',
			nestedKey: result.parsed,
		},
		errors: errors,
	};
}

const nameStartRegex = /[a-zA-Z]/;

const indexRegex = /0|[1-9][0-9]*/y;
const invalidIndexSyntaxError = { code: ErrorCode.invalidIndexSyntax, message: 'Invalid index syntax' };

function indexParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<Index> {
	// Ein Index ist eine positive Ganzzahl ohne führende Nullen. Die 0 wird trotzdem geparst,
	// weil sie getippt wird: nur wenn sie konsumiert ist, kann die Meldung auf ihr sitzen —
	// sonst fällt die Auswahl in nestedReferenceKeyParser durch und meldet generisch
	// "Expected a nested key" auf dem vorangehenden /.
	const row = rows[startRowIndex];
	let match: RegExpExecArray | null = null;
	if (row !== undefined) {
		indexRegex.lastIndex = startColumnIndex;
		match = indexRegex.exec(row);
	}
	if (!match) {
		return regexFailure(rows, startRowIndex, startColumnIndex, invalidIndexSyntaxError);
	}
	const index = +match[0];
	const endColumnIndex = startColumnIndex + match[0].length;
	return {
		hasParsed: true,
		endRowIndex: startRowIndex,
		endColumnIndex: endColumnIndex,
		// Indizes sind 1-basiert
		errors: index < 1
			? [{
				code: ErrorCode.invalidIndexSyntax,
				message: `Invalid index ${index}, indexes start at 1`,
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: startRowIndex,
				endColumnIndex: endColumnIndex,
			}]
			: undefined,
		parsed: {
			type: 'index',
			name: index,
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: startRowIndex,
			endColumnIndex: endColumnIndex,
		},
	};
}

/**
 * Verkettet zwei Fehlerlisten: undefined bleibt undefined, eine einzelne Liste
 * wird weitergereicht.
 */
function mergeErrors(
	errors: CompilerError[] | undefined,
	more: CompilerError[] | undefined,
): CompilerError[] | undefined {
	if (!more) {
		return errors;
	}
	return errors
		? errors.concat(more)
		: more;
}

/**
 * Spread, Name oder Wert, Typ-Guard, Zuweisung. Geradlinig geschrieben statt aus Kombinatoren, das
 * Verhalten ist dasselbe:
 * - Ein Fehlschlag von Name oder Typ-Guard-Wert endet das Feld mit den bisherigen Fehlern.
 * - Fehlt der Wert hinter ` = `, ist das kein Fehler des Feldes, die Fehler des Versuchs gehen
 *   verloren (assignedValueMissingForDefinition meldet es später).
 */
/**
 * `b?: X` ist nur im Dictionary-Typ erlaubt, überall sonst meldet das ein Fehler am Feld.
 */
function checkOptionalNotAllowed(field: ParseFieldBase, errors: CompilerError[]): void {
	if (field.optional) {
		errors.push({
			code: ErrorCode.optionalNotAllowedOutsideDictionaryType,
			message: 'An optional field (name?: Type) is only allowed in a dictionary type.',
			startRowIndex: field.name.endRowIndex,
			startColumnIndex: field.name.endColumnIndex,
			endRowIndex: field.name.endRowIndex,
			endColumnIndex: field.name.endColumnIndex + 1,
		});
	}
}

function fieldParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseFieldBase> {
	let columnIndex = startColumnIndex;
	let spread = false;
	if (rows[startRowIndex]?.startsWith('...', columnIndex)) {
		spread = true;
		columnIndex += 3;
	}
	const nameResult = valueExpressionBaseParser(rows, startRowIndex, columnIndex, indent);
	let errors = nameResult.errors;
	let rowIndex = nameResult.endRowIndex;
	columnIndex = nameResult.endColumnIndex;
	if (!nameResult.hasParsed) {
		return {
			hasParsed: false,
			endRowIndex: rowIndex,
			endColumnIndex: columnIndex,
			errors: errors,
		};
	}
	// b?: X, das ? gehört zum Feld (nur der Dictionary-Typ erlaubt es)
	let optional = false;
	if (rows[rowIndex]?.startsWith('?: ', columnIndex)) {
		optional = true;
		columnIndex += 1;
	}
	let typeGuard: ParseValueExpression | undefined;
	if (rows[rowIndex]?.startsWith(': ', columnIndex)) {
		const typeGuardResult = valueExpressionParser(rows, rowIndex, columnIndex + 2, indent);
		errors = mergeErrors(errors, typeGuardResult.errors);
		rowIndex = typeGuardResult.endRowIndex;
		columnIndex = typeGuardResult.endColumnIndex;
		if (!typeGuardResult.hasParsed) {
			return {
				hasParsed: false,
				endRowIndex: rowIndex,
				endColumnIndex: columnIndex,
				errors: errors,
			};
		}
		typeGuard = typeGuardResult.parsed;
	}
	let definition = false;
	let assignedValue: ParseValueExpression | undefined;
	if (rows[rowIndex]?.startsWith(' = ', columnIndex)) {
		definition = true;
		columnIndex += 3;
		const valueResult = valueExpressionParser(rows, rowIndex, columnIndex, indent);
		if (valueResult.hasParsed) {
			errors = mergeErrors(errors, valueResult.errors);
			rowIndex = valueResult.endRowIndex;
			columnIndex = valueResult.endColumnIndex;
			assignedValue = valueResult.parsed;
		}
	}
	return {
		hasParsed: true,
		endRowIndex: rowIndex,
		endColumnIndex: columnIndex,
		parsed: {
			type: 'field',
			spread: spread,
			name: nameResult.parsed!,
			typeGuard: typeGuard,
			...(optional ? { optional: true } : {}),
			definition: definition,
			assignedValue: assignedValue,
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: rowIndex,
			endColumnIndex: columnIndex,
		},
		errors: errors,
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
): ParserResult<ParseValueExpression> {
	const endOfCodeError = checkEndOfCode(rows, startRowIndex, startColumnIndex, 'expression');
	if (endOfCodeError) {
		return endOfCodeError;
	}
	// Branching (`?` und `:?`) beginnt den Ausdruck und hat keinen linken Operanden. Es wird deshalb
	// vor der simpleExpression geprüft und nicht wie der Rumpf oder Rückgabepfeil danach angehängt.
	if (rows[startRowIndex]?.startsWith(':?', startColumnIndex)) {
		return branchingParser(rows, startRowIndex, startColumnIndex, indent, 'typeBranching');
	}
	if (rows[startRowIndex]?.startsWith('?', startColumnIndex)) {
		return branchingParser(rows, startRowIndex, startColumnIndex, indent, 'branching');
	}
	const firstResult = simpleExpressionBaseParser(rows, startRowIndex, startColumnIndex, indent);
	if (!firstResult.hasParsed) {
		return {
			hasParsed: false,
			endRowIndex: firstResult.endRowIndex,
			endColumnIndex: firstResult.endColumnIndex,
			errors: firstResult.errors,
			parsed: undefined,
		};
	}
	const parsed1 = firstResult.parsed!;
	let endRowIndex = firstResult.endRowIndex;
	let endColumnIndex = firstResult.endColumnIndex;
	let mergedErrors = firstResult.errors;
	// Was auf die simpleExpression folgt: Rumpf, Rückgabepfeil mit Typ, ein ungültiger Pfeil am
	// Zeilenende, Pfeilzeilen unter dem Kopf oder nichts. Das erste passende Prädikat gewinnt.
	let restResult: ParserResult<FunctionHeadRest> | undefined;
	if (rows[endRowIndex]?.startsWith(' =>', endColumnIndex)) {
		restResult = functionBodyParser(rows, endRowIndex, endColumnIndex, indent);
	}
	else if (getReturnArrowPurity(rows[endRowIndex], endColumnIndex) !== undefined) {
		restResult = functionTypeBodyParser(rows, endRowIndex, endColumnIndex, indent);
	}
	else if (isReturnArrowAtEndOfRow(rows, endRowIndex, endColumnIndex)) {
		restResult = returnArrowAtEndOfRowParser(rows, endRowIndex, endColumnIndex, indent);
	}
	else if (isFunctionHeadContinued(rows, endRowIndex, endColumnIndex, indent)) {
		restResult = functionHeadContinuationParser(rows, endRowIndex, endColumnIndex, indent);
	}
	if (restResult) {
		mergedErrors = mergeErrors(mergedErrors, restResult.errors);
		endRowIndex = restResult.endRowIndex;
		endColumnIndex = restResult.endColumnIndex;
		if (!restResult.hasParsed) {
			return {
				hasParsed: false,
				endRowIndex: endRowIndex,
				endColumnIndex: endColumnIndex,
				errors: mergedErrors,
				parsed: undefined,
			};
		}
	}
	const parsed2 = restResult?.parsed;
	const errors = mergedErrors
		? [...mergedErrors]
		: [];
	if (!parsed2) {
		// SimpleExpressionBase
		return {
			hasParsed: true,
			endRowIndex: endRowIndex,
			endColumnIndex: endColumnIndex,
			parsed: parsed1,
			errors: errors,
		};
	}
	switch (parsed2.type) {
		case 'functionBody': {
			const body = parsed2.body;
			const params = bracketedParamsToParams(parsed1, errors);
			// TODO im Fall dass params TypeExpression ist: Code Flow Typing berücksichtigen
			const functionLiteral = createParseFunctionLiteral(
				params,
				undefined,
				body,
				{
					startRowIndex: startRowIndex,
					startColumnIndex: startColumnIndex,
					endRowIndex: endRowIndex,
					endColumnIndex: endColumnIndex,
				},
				errors,
			);
			return {
				hasParsed: true,
				endRowIndex: endRowIndex,
				endColumnIndex: endColumnIndex,
				parsed: functionLiteral,
				errors: errors,
			};
		}
		case 'functionTypeBody': {
			const body = parsed2.body;
			const returnType = parsed2.returnTypeBase && baseValueExpressionToValueExpression(parsed2.returnTypeBase, errors);
			const params = bracketedParamsToParams(parsed1, errors);
			if (body) {
				// FunctionLiteral mit ReturnType
				const functionLiteral = createParseFunctionLiteral(
					params,
					returnType,
					body,
					{
						startRowIndex: startRowIndex,
						startColumnIndex: startColumnIndex,
						endRowIndex: endRowIndex,
						endColumnIndex: endColumnIndex,
					},
					errors,
					parsed2.arrow,
				);
				return {
					hasParsed: true,
					endRowIndex: endRowIndex,
					endColumnIndex: endColumnIndex,
					parsed: functionLiteral,
					errors: errors,
				};
			}
			// FunctionTypeLiteral
			const functionTypeLiteral = createParseFunctionTypeLiteral(
				params,
				// Rückgabepfeil ohne Typ (schon gemeldet): Platzhalter, damit der Knoten für den
				// Language Server erhalten bleibt
				returnType ?? {
					type: 'empty',
					startRowIndex: endRowIndex,
					startColumnIndex: endColumnIndex,
					endRowIndex: endRowIndex,
					endColumnIndex: endColumnIndex,
				},
				parsed2.arrow,
				{
					startRowIndex: startRowIndex,
					startColumnIndex: startColumnIndex,
					endRowIndex: endRowIndex,
					endColumnIndex: endColumnIndex,
				},
				errors,
			);
			return {
				hasParsed: true,
				endRowIndex: endRowIndex,
				endColumnIndex: endColumnIndex,
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

function expectedOneOfResult(
	rowIndex: number,
	columnIndex: number,
	expected: string,
): ParserResult<never> {
	return {
		hasParsed: false,
		endRowIndex: rowIndex,
		endColumnIndex: columnIndex,
		errors: [{
			startRowIndex: rowIndex,
			startColumnIndex: columnIndex,
			// TODO end indices
			endRowIndex: rowIndex,
			endColumnIndex: columnIndex,
			code: ErrorCode.expectedOneOf,
			message: expected,
		}],
	};
}

/**
 * Text: inline mit schließendem §, mehrzeilig, zuletzt ohne schließendes §.
 */
function textParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseTextLiteral> {
	const inlineResult = inlineTextParser(rows, startRowIndex, startColumnIndex, indent);
	if (inlineResult.hasParsed) {
		return inlineResult;
	}
	const multilineResult = multilineTextParser(rows, startRowIndex, startColumnIndex, indent);
	if (multilineResult.hasParsed) {
		return multilineResult;
	}
	// zuletzt: `§abc` ist auch der Kopf eines mehrzeiligen Textes
	const unclosedResult = unclosedInlineTextParser(rows, startRowIndex, startColumnIndex, indent);
	if (unclosedResult.hasParsed) {
		return unclosedResult;
	}
	return expectedOneOfResult(startRowIndex, startColumnIndex, 'Expected a text.');
}

/**
 * Der Anfang einer simpleExpression: Klammer, Zahl, Text oder Referenz. Das erste Zeichen
 * entscheidet, danach gibt es keinen Rückfall auf eine andere Alternative.
 */
function simpleExpressionStartParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<SimpleExpression> {
	const character = rows[startRowIndex]?.[startColumnIndex];
	if (character !== undefined) {
		if (character === '(') {
			// Bindungsstelle: Parameterliste oder Destructuring-Ziel.
			// Was davon, entscheidet erst das Token nach der schließenden Klammer.
			return roundBracketedBaseParser(rows, startRowIndex, startColumnIndex, indent);
		}
		if (character === '[') {
			// Datenliteral
			return squareBracketedBaseParser(rows, startRowIndex, startColumnIndex, indent);
		}
		if (character === '-' || (character >= '0' && character <= '9')) {
			return numberParser(rows, startRowIndex, startColumnIndex, indent);
		}
		if (character === '§') {
			return textParser(rows, startRowIndex, startColumnIndex, indent);
		}
		if (nameStartRegex.test(character)) {
			return referenceParser(rows, startRowIndex, startColumnIndex, indent);
		}
	}
	return expectedOneOfResult(startRowIndex, startColumnIndex, 'Expected a bracket, number, text or reference.');
}

type SimpleExpressionChainLink =
	| NonNullable<ReturnType<typeof nestedReferenceKeyParser>['parsed']>
	| BracketedExpression
	| NonNullable<ReturnType<typeof infixFunctionArgumentsParser>['parsed']>;

function simpleExpressionBaseParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<SimpleExpression> {
	const baseResult = simpleExpressionStartParser(rows, startRowIndex, startColumnIndex, indent);
	if (!baseResult.hasParsed) {
		return {
			hasParsed: false,
			endRowIndex: baseResult.endRowIndex,
			endColumnIndex: baseResult.endColumnIndex,
			errors: baseResult.errors,
			parsed: undefined,
		};
	}
	const parsed1 = baseResult.parsed!;
	// Kette aus Verschachtelung (/), Aufruf und Infix-Aufruf, so oft es passt. Ein Fehlschlag
	// beendet die Kette ohne Folgen, die Fehler des Versuchs gehen verloren.
	let endRowIndex = baseResult.endRowIndex;
	let endColumnIndex = baseResult.endColumnIndex;
	let mergedErrors = baseResult.errors;
	const parsed2: SimpleExpressionChainLink[] = [];
	while (endRowIndex < rows.length) {
		const row = rows[endRowIndex]!;
		const character = row[endColumnIndex];
		const linkResult: ParserResult<SimpleExpressionChainLink> | undefined = character === '/'
			? nestedReferenceKeyParser(rows, endRowIndex, endColumnIndex, indent)
			: character === '('
				? functionArgumentsParser(rows, endRowIndex, endColumnIndex, indent)
				: character === '.'
					? infixFunctionArgumentsParser(rows, endRowIndex, endColumnIndex, indent)
					: undefined;
		if (!linkResult?.hasParsed) {
			break;
		}
		mergedErrors = mergeErrors(mergedErrors, linkResult.errors);
		endRowIndex = linkResult.endRowIndex;
		endColumnIndex = linkResult.endColumnIndex;
		parsed2.push(linkResult.parsed!);
	}
	const errors = mergedErrors
		? [...mergedErrors]
		: [];
	let expression: SimpleExpression = parsed1;
	if (parsed2.length) {
		// (Nested Ref/Function Call) Chain
		expression = simpleExpressionBaseToSimpleExpression(expression, errors);
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
						return functionCall;
					}
					case 'nestedReference': {
						const nestedKey = currentValue.nestedKey;
						if (nestedKey?.type === 'text') {
							errors.push(...getEscapableNameErrors(nestedKey));
						}
						const nestedReference: ParseNestedReference = {
							type: 'nestedReference',
							source: accumulator,
							nestedKey: nestedKey,
							startColumnIndex: accumulator.startColumnIndex,
							startRowIndex: accumulator.startRowIndex,
							endColumnIndex: nestedKey
								? nestedKey.endColumnIndex
								// + 1 für nestedReferenceToken /
								: accumulator.endColumnIndex + 1,
							endRowIndex: nestedKey
								? nestedKey.endRowIndex
								: accumulator.endRowIndex,
						};
						return nestedReference;
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
						return functionCall;
					}
				}
			},
			expression);
	}
	return {
		hasParsed: true,
		endRowIndex: endRowIndex,
		endColumnIndex: endColumnIndex,
		parsed: expression,
		errors: errors,
	};
}

const numberRegex = /-?(0|[1-9][0-9]*)(\.[0-9]+)?f?/y;
const invalidNumberError = { code: ErrorCode.invalidNumber, message: 'not a valid number' };

function numberParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<NumberLiteral> {
	const row = rows[startRowIndex];
	let match: RegExpExecArray | null = null;
	if (row !== undefined) {
		numberRegex.lastIndex = startColumnIndex;
		match = numberRegex.exec(row);
	}
	if (!match) {
		return regexFailure(rows, startRowIndex, startColumnIndex, invalidNumberError);
	}
	const parsed = match[0];
	const endColumnIndex = startColumnIndex + parsed.length;
	if (last(parsed) === 'f') {
		return {
			hasParsed: true,
			endRowIndex: startRowIndex,
			endColumnIndex: endColumnIndex,
			parsed: {
				type: 'float',
				value: +parsed.substring(0, parsed.length - 1),
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: startRowIndex,
				endColumnIndex: endColumnIndex,
			},
		};
	}
	const decimalSeparatorIndex = parsed.indexOf('.');
	if (decimalSeparatorIndex > 0) {
		const numberOfDecimalPlaces = (parsed.length - 1) - decimalSeparatorIndex;
		const normalized = normalizeRational(BigInt(parsed.replace('.', '')), 10n ** BigInt(numberOfDecimalPlaces));
		return {
			hasParsed: true,
			endRowIndex: startRowIndex,
			endColumnIndex: endColumnIndex,
			parsed: typeof normalized === 'bigint'
				? {
					type: 'integer',
					value: normalized,
					startRowIndex: startRowIndex,
					startColumnIndex: startColumnIndex,
					endRowIndex: startRowIndex,
					endColumnIndex: endColumnIndex,
				}
				: {
					type: 'fraction',
					numerator: normalized.numerator,
					denominator: normalized.denominator,
					startRowIndex: startRowIndex,
					startColumnIndex: startColumnIndex,
					endRowIndex: startRowIndex,
					endColumnIndex: endColumnIndex,
				},
		};
	}
	return {
		hasParsed: true,
		endRowIndex: startRowIndex,
		endColumnIndex: endColumnIndex,
		parsed: {
			type: 'integer',
			value: BigInt(parsed),
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: startRowIndex,
			endColumnIndex: endColumnIndex,
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
	if (!rows[startRowIndex]?.startsWith('§', startColumnIndex)) {
		return tokenFailure(rows, startRowIndex, startColumnIndex, '§');
	}
	const contentResult = textLineContentParser(rows, startRowIndex, startColumnIndex + 1, indent);
	const closingRowIndex = contentResult.endRowIndex;
	const closingColumnIndex = contentResult.endColumnIndex;
	if (!rows[closingRowIndex]?.startsWith('§', closingColumnIndex)) {
		const closingResult = tokenFailure(rows, closingRowIndex, closingColumnIndex, '§');
		return {
			hasParsed: false,
			endRowIndex: closingResult.endRowIndex,
			endColumnIndex: closingResult.endColumnIndex,
			errors: mergeErrors(contentResult.errors, closingResult.errors),
		};
	}
	return {
		hasParsed: true,
		endRowIndex: closingRowIndex,
		endColumnIndex: closingColumnIndex + 1,
		parsed: {
			type: 'text',
			values: contentResult.parsed!,
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: closingRowIndex,
			endColumnIndex: closingColumnIndex + 1,
		},
		errors: contentResult.errors,
	};
}

/**
 * Einzeiliger Text ohne schließendes §, der bis zum Zeilenende reicht (beim Tippen üblich).
 * Der Knoten entsteht trotzdem, damit der Baum für den Language Server erhalten bleibt.
 */
function unclosedInlineTextParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseTextLiteral> {
	const rowLength = rows[startRowIndex]!.length;
	if (!rows[startRowIndex]!.startsWith('§', startColumnIndex)) {
		return {
			hasParsed: false,
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: tokenFailure(rows, startRowIndex, startColumnIndex, '§').errors,
		};
	}
	const contentResult = textLineContentParser(rows, startRowIndex, startColumnIndex + 1, indent);
	if (contentResult.endColumnIndex !== rowLength) {
		return {
			hasParsed: false,
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: contentResult.errors,
		};
	}
	return {
		hasParsed: true,
		endRowIndex: startRowIndex,
		endColumnIndex: rowLength,
		parsed: {
			type: 'text',
			values: contentResult.parsed!,
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: startRowIndex,
			endColumnIndex: rowLength,
		},
		errors: [
			...(contentResult.errors ?? []),
			{
				code: ErrorCode.closingTextMarkerMissing,
				message: 'Expected closing §.',
				startRowIndex: startRowIndex,
				startColumnIndex: rowLength,
				endRowIndex: startRowIndex,
				endColumnIndex: rowLength,
			},
		],
	};
}

/**
 * §, Sprachkennung, Zeilenumbruch, eingerückte Zeilen, Zeilenumbruch, Einrückung, §.
 */
function multilineTextHeadParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<{ languageIdentifier: string; lines: ((TextToken | ParseValueExpression)[] | string | undefined)[]; }> {
	if (!rows[startRowIndex]?.startsWith('§', startColumnIndex)) {
		return tokenFailure(rows, startRowIndex, startColumnIndex, '§');
	}
	// language identifier
	// TODO nur unterstützte sprachen? validieren?
	languageIdentifierRegex.lastIndex = startColumnIndex + 1;
	const languageIdentifier = languageIdentifierRegex.exec(rows[startRowIndex]!)![0];
	let errors: CompilerError[] | undefined;
	const opened = newLineParser(rows, startRowIndex, startColumnIndex + 1 + languageIdentifier.length, indent);
	errors = mergeErrors(errors, opened.errors);
	if (!opened.hasParsed) {
		return { hasParsed: false, endRowIndex: opened.endRowIndex, endColumnIndex: opened.endColumnIndex, errors: errors };
	}
	const linesResult = multilineBlock(textLineContentParser, false, rows, opened.endRowIndex, opened.endColumnIndex, indent + 1);
	errors = mergeErrors(errors, linesResult.errors);
	if (!linesResult.hasParsed) {
		return { hasParsed: false, endRowIndex: linesResult.endRowIndex, endColumnIndex: linesResult.endColumnIndex, errors: errors };
	}
	const closed = newLineParser(rows, linesResult.endRowIndex, linesResult.endColumnIndex, indent);
	errors = mergeErrors(errors, closed.errors);
	if (!closed.hasParsed) {
		return { hasParsed: false, endRowIndex: closed.endRowIndex, endColumnIndex: closed.endColumnIndex, errors: errors };
	}
	const indentResult = indentParser(rows, closed.endRowIndex, closed.endColumnIndex, indent);
	errors = mergeErrors(errors, indentResult.errors);
	if (!indentResult.hasParsed) {
		return { hasParsed: false, endRowIndex: indentResult.endRowIndex, endColumnIndex: indentResult.endColumnIndex, errors: errors };
	}
	if (!rows[indentResult.endRowIndex]?.startsWith('§', indentResult.endColumnIndex)) {
		const endResult = tokenFailure(rows, indentResult.endRowIndex, indentResult.endColumnIndex, '§');
		return {
			hasParsed: false,
			endRowIndex: endResult.endRowIndex,
			endColumnIndex: endResult.endColumnIndex,
			errors: mergeErrors(errors, endResult.errors),
		};
	}
	return {
		hasParsed: true,
		endRowIndex: indentResult.endRowIndex,
		endColumnIndex: indentResult.endColumnIndex + 1,
		parsed: { languageIdentifier: languageIdentifier, lines: linesResult.parsed! },
		errors: errors,
	};
}

const languageIdentifierRegex = /[a-z]*/y;

function multilineTextParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseTextLiteral> {
	const head = multilineTextHeadParser(rows, startRowIndex, startColumnIndex, indent);
	if (!head.hasParsed) {
		return head as ParserResult<never>;
	}
	const result = head;
	const values: (TextToken | ParseValueExpression)[] = [];
	let languageIdentifier: string | undefined;
	if (result.parsed) {
		languageIdentifier = result.parsed.languageIdentifier;
		const isRegex = languageIdentifier === 'regex';
		result.parsed.lines.forEach(line => {
			if (isRegex) {
				// Ein Regex ist ein Pattern, kein Text mit Zeilen: Zeilen ohne Umbruch und ohne
				// Einrückung verbinden. Kommentar- und Leerzeilen tragen nichts bei.
				if (typeof line === 'object') {
					values.push(...line.map((value, index) => index === 0 && value.type === 'textToken'
						? { ...value, value: value.value.replace(/^\t+/, '') }
						: value));
				}
				return;
			}
			if (typeof line === 'object') {
				values.push(...line);
			}
			const tail = last(values);
			if (tail?.type === 'textToken') {
				// Ersetzen statt anhängen: Der Token kann aus einem Teilergebnis stammen, das der Parser
				// mehrfach durchläuft (siehe setParentsAndIds).
				values[values.length - 1] = { ...tail, value: tail.value + '\n' };
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
				endColumnIndex: result.endColumnIndex,
			},
	};
}

/**
 * Text bis zum nächsten §, mit §§ und §# als Escapes und §( ) für eingebettete Ausdrücke. Ein Stück,
 * das nicht passt, beendet die Wiederholung ohne Folgen, die Fehler des Versuchs gehen verloren.
 */
function textLineContentParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<(TextToken | ParseValueExpression)[]> {
	const values: (TextToken | ParseValueExpression)[] = [];
	let errors: CompilerError[] | undefined;
	let rowIndex = startRowIndex;
	let columnIndex = startColumnIndex;
	while (rowIndex < rows.length) {
		const row = rows[rowIndex]!;
		textContentRegex.lastIndex = columnIndex;
		const match = textContentRegex.exec(row);
		if (match) {
			const text = match[0];
			values.push({
				type: 'textToken',
				value: text.startsWith('§')
					? text.substring(1)
					: text,
			});
			columnIndex += text.length;
			continue;
		}
		if (!row.startsWith('§(', columnIndex)) {
			break;
		}
		const expressionResult = valueExpressionParser(rows, rowIndex, columnIndex + 2, indent);
		if (!expressionResult.hasParsed
			|| !rows[expressionResult.endRowIndex]?.startsWith(')', expressionResult.endColumnIndex)) {
			break;
		}
		errors = mergeErrors(errors, expressionResult.errors);
		values.push(expressionResult.parsed!);
		rowIndex = expressionResult.endRowIndex;
		columnIndex = expressionResult.endColumnIndex + 1;
	}
	return {
		hasParsed: true,
		endRowIndex: rowIndex,
		endColumnIndex: columnIndex,
		parsed: values,
		errors: errors,
	};
}

const textContentRegex = new RegExp('([^§]+|§§|§#)', 'y');

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
	infixFunctionReference?: ParseReference;
	endRowIndex: number,
	endColumnIndex: number,
}> {
	// TODO greedy SequenceParser der soviel von der Sequence parst wie möglich?
	// const result = sequenceParser(
	// 	infixFunctionTokenParser,
	// 	nameParser,
	// 	functionArgumentsParser,
	// )(rows, startRowIndex, startColumnIndex, indent);
	if (!rows[startRowIndex]?.startsWith('.', startColumnIndex)) {
		return tokenFailure(rows, startRowIndex, startColumnIndex, '.');
	}
	const errors: CompilerError[] = [];
	let endRowIndex = startRowIndex;
	let endColumnIndex = startColumnIndex + 1;
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
		hasParsed: true,
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
	// Die Argumentliste eines Aufrufs ist eine Bindungsstelle und bleibt rund.
	const result = roundBracketedBaseParser(rows, startRowIndex, startColumnIndex, indent);
	const parsed = result.parsed;
	if (!parsed) {
		return result;
	}
	const errors = result.errors ?? [];
	const args = bracketedExpressionToValueExpression(parsed, errors, true);
	return {
		...result,
		parsed: args,
		errors: errors
	};
}

//#endregion SimpleExpression

/**
 * `?` und `:?` teilen sich die Form: Präfix-Token, Argumentliste, eingerückte Zweige.
 */
function branchingParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
	kind: 'branching' | 'typeBranching',
): ParserResult<ParseBranching | ParseTypeBranching> {
	const endOfCodeError = checkEndOfCode(rows, startRowIndex, startColumnIndex, 'branching');
	if (endOfCodeError) {
		return endOfCodeError;
	}
	const token = kind === 'branching' ? '?' : ':?';
	if (!rows[startRowIndex]?.startsWith(token, startColumnIndex)) {
		return tokenFailure(rows, startRowIndex, startColumnIndex, token);
	}
	// dieselbe Argumentliste wie beim Aufruf, damit ... und benannte Argumente hier gelten
	const argumentsResult = functionArgumentsParser(rows, startRowIndex, startColumnIndex + token.length, indent);
	let sequenceErrors = argumentsResult.errors;
	if (!argumentsResult.hasParsed) {
		return {
			hasParsed: false,
			endRowIndex: argumentsResult.endRowIndex,
			endColumnIndex: argumentsResult.endColumnIndex,
			errors: sequenceErrors,
		};
	}
	const newLineResult = newLineParser(rows, argumentsResult.endRowIndex, argumentsResult.endColumnIndex, indent);
	sequenceErrors = mergeErrors(sequenceErrors, newLineResult.errors);
	if (!newLineResult.hasParsed) {
		return {
			hasParsed: false,
			endRowIndex: newLineResult.endRowIndex,
			endColumnIndex: newLineResult.endColumnIndex,
			errors: sequenceErrors,
		};
	}
	const branchesResult = multilineBlock(orphanCheckedValueExpressionParser, true, rows, newLineResult.endRowIndex, newLineResult.endColumnIndex, indent + 1);
	sequenceErrors = mergeErrors(sequenceErrors, branchesResult.errors);
	if (!branchesResult.hasParsed) {
		return {
			hasParsed: false,
			endRowIndex: branchesResult.endRowIndex,
			endColumnIndex: branchesResult.endColumnIndex,
			errors: sequenceErrors,
		};
	}
	const result = {
		endRowIndex: branchesResult.endRowIndex,
		endColumnIndex: branchesResult.endColumnIndex,
		errors: sequenceErrors,
	};
	const branches = branchesResult.parsed!.filter((x): x is ParseValueExpression =>
		typeof x === 'object');
	const branching: ParseBranching | ParseTypeBranching = {
		type: kind,
		args: argumentsResult.parsed!,
		branches: branches,
		startRowIndex: startRowIndex,
		startColumnIndex: startColumnIndex,
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
	};
	const errors = result.errors ?? [];
	if (!branches.length) {
		errors.push({
			code: ErrorCode.branchingHasNoBranches,
			message: 'Branching has no branches.',
			startRowIndex: branching.startRowIndex,
			startColumnIndex: branching.startColumnIndex,
			endRowIndex: branching.endRowIndex,
			endColumnIndex: branching.endColumnIndex,
		});
	}
	return {
		hasParsed: true,
		endRowIndex: result.endRowIndex,
		endColumnIndex: result.endColumnIndex,
		parsed: branching,
		errors: errors,
	};
}

//#region Funktionskopf

/**
 * Rest eines Funktionskopfs hinter den Parametern: nur der Rumpf, oder Rückgabepfeil samt Typ mit
 * optionalem Rumpf.
 */
type FunctionHeadRest =
	| FunctionBody
	| FunctionTypeBody;

interface FunctionBody {
	type: 'functionBody';
	body: ParseExpression[];
}

interface FunctionTypeBody {
	type: 'functionTypeBody';
	arrow: Purity;
	/**
	 * Fehlt nur in fehlerhaftem Code: Rückgabepfeil ohne Operand.
	 */
	returnTypeBase?: ParseValueExpression;
	body?: ParseExpression[];
}

type ReturnArrow = '->' | ':>' | '~>';
type Arrow = ReturnArrow | '=>';

const returnArrowPurities: { [arrow in ReturnArrow]: Purity } = {
	'->': 'pure',
	':>': 'unknown',
	'~>': 'impure',
};

/**
 * Rückgabepfeil samt Leerzeichen davor und danach an columnIndex: ' :> ', ' -> ', ' ~> '.
 */
function getReturnArrowPurity(row: string | undefined, columnIndex: number): Purity | undefined {
	if (row === undefined) {
		return undefined;
	}
	if (row.startsWith(' :> ', columnIndex)) {
		return 'unknown';
	}
	if (row.startsWith(' -> ', columnIndex)) {
		return 'pure';
	}
	if (row.startsWith(' ~> ', columnIndex)) {
		return 'impure';
	}
	return undefined;
}

/**
 * Pfeil an columnIndex, gefolgt von Leerzeichen oder Zeilenende.
 */
function getArrowAt(row: string, columnIndex: number): Arrow | undefined {
	const arrow = row.substring(columnIndex, columnIndex + 2);
	if (arrow !== '->'
		&& arrow !== ':>'
		&& arrow !== '~>'
		&& arrow !== '=>') {
		return undefined;
	}
	const nextChar = row[columnIndex + 2];
	if (nextChar !== undefined && nextChar !== ' ') {
		return undefined;
	}
	return arrow;
}

interface ArrowLine {
	rowIndex: number;
	/**
	 * Spalte des Pfeils
	 */
	columnIndex: number;
	arrow: Arrow;
	/**
	 * spaceIndentation
	 */
	indentErrors?: CompilerError[];
}

/**
 * Sucht ab rowIndex die nächste Pfeilzeile auf der Ebene arrowIndent. Kommentarzeilen auf dieser
 * Ebene werden übersprungen, Leerzeilen nur bei allowEmptyRows. Jede andere Zeile beendet die Suche.
 */
function findArrowLine(
	rows: string[],
	rowIndex: number,
	arrowIndent: number,
	allowEmptyRows: boolean,
): ArrowLine | undefined {
	for (let currentRowIndex = rowIndex; currentRowIndex < rows.length; currentRowIndex++) {
		const row = rows[currentRowIndex]!;
		if (row === '') {
			if (allowEmptyRows) {
				continue;
			}
			return undefined;
		}
		const indentResult = indentParser(rows, currentRowIndex, 0, arrowIndent);
		if (!indentResult.hasParsed) {
			return undefined;
		}
		const columnIndex = indentResult.endColumnIndex;
		if (row[columnIndex] === '#') {
			continue;
		}
		const arrow = getArrowAt(row, columnIndex);
		if (!arrow) {
			return undefined;
		}
		return {
			rowIndex: currentRowIndex,
			columnIndex: columnIndex,
			arrow: arrow,
			indentErrors: indentResult.errors,
		};
	}
	return undefined;
}

/**
 * Letzte Zeile ab rowIndex, bis zu der die Folgezeilen tiefer als indent eingerückt sind.
 * Leerzeilen dazwischen gehören dazu, am Ende nicht.
 */
function getLastDeeperRowIndex(rows: string[], rowIndex: number, indent: number): number {
	let lastRowIndex = rowIndex;
	for (let currentRowIndex = rowIndex + 1; currentRowIndex < rows.length; currentRowIndex++) {
		if (rows[currentRowIndex] === '') {
			continue;
		}
		if (!indentParser(rows, currentRowIndex, 0, indent + 1).hasParsed) {
			break;
		}
		lastRowIndex = currentRowIndex;
	}
	return lastRowIndex;
}

/**
 * Ist die Zeile genau auf der Ebene indent eingerückt und beginnt weder mit einem Pfeil noch mit
 * einem Kommentar?
 */
function isRowAtIndent(rows: string[], rowIndex: number, indent: number): boolean {
	const row = rows[rowIndex];
	if (!row) {
		return false;
	}
	const indentResult = indentParser(rows, rowIndex, 0, indent);
	if (!indentResult.hasParsed) {
		return false;
	}
	const columnIndex = indentResult.endColumnIndex;
	return row[columnIndex] !== '\t'
		&& row[columnIndex] !== '#'
		&& !getArrowAt(row, columnIndex);
}

function misplacedArrowError(rowIndex: number, columnIndex: number, message: string): CompilerError {
	return {
		code: ErrorCode.misplacedArrow,
		message: message,
		startRowIndex: rowIndex,
		startColumnIndex: columnIndex,
		endRowIndex: rowIndex,
		endColumnIndex: columnIndex + 2,
	};
}

function isReturnArrowAtEndOfRow(rows: string[], rowIndex: number, columnIndex: number): boolean {
	const row = rows[rowIndex];
	if (row === undefined
		|| row[columnIndex] !== ' '
		|| columnIndex + 3 !== row.length) {
		return false;
	}
	const arrow = getArrowAt(row, columnIndex + 1);
	return !!arrow && arrow !== '=>';
}

function isFunctionHeadContinued(rows: string[], rowIndex: number, columnIndex: number, indent: number): boolean {
	const row = rows[rowIndex];
	return row !== undefined
		&& columnIndex === row.length
		&& !!findArrowLine(rows, rowIndex + 1, indent + 1, false);
}

/**
 * Pfeilzeilen unter dem Funktionskopf, eine Ebene tiefer eingerückt als die Zeile, in der der Kopf
 * beginnt.
 */
function functionHeadContinuationParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<FunctionHeadRest> {
	return arrowLinesParser(rows, startRowIndex, startColumnIndex, indent, undefined, false);
}

/**
 * Parst die Pfeilzeilen ab der Zeile nach startRowIndex: höchstens eine Rückgabepfeil-Zeile, danach
 * höchstens eine =>-Zeile. Weitere Pfeilzeilen werden gemeldet und samt tiefer eingerückten
 * Folgezeilen übersprungen. Leer- und Kommentarzeilen sind zwischen den Pfeilzeilen erlaubt, werden
 * aber nur verbraucht, wenn danach noch eine Pfeilzeile folgt.
 */
function arrowLinesParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
	/**
	 * Rückgabepfeil samt Typ, der schon vor der ersten Pfeilzeile steht (in der Kopfzeile).
	 */
	headReturnType: { arrow: Purity; returnTypeBase?: ParseValueExpression; } | undefined,
	allowLeadingEmptyRows: boolean,
): ParserResult<FunctionHeadRest> {
	const arrowIndent = indent + 1;
	const errors: CompilerError[] = [];
	let returnType = headReturnType;
	let body: ParseExpression[] | undefined;
	let endRowIndex = startRowIndex;
	let endColumnIndex = startColumnIndex;
	for (
		let arrowLine = findArrowLine(rows, endRowIndex + 1, arrowIndent, allowLeadingEmptyRows);
		arrowLine;
		arrowLine = findArrowLine(rows, endRowIndex + 1, arrowIndent, true)
	) {
		const { rowIndex, columnIndex, arrow } = arrowLine;
		if (arrowLine.indentErrors) {
			errors.push(...arrowLine.indentErrors);
		}
		const misplacedMessage = arrow === '=>'
			? body && 'A function has only one => line.'
			: body
				? 'The return type line must come before the => line.'
				: returnType && 'A function has only one return type.';
		if (misplacedMessage) {
			errors.push(misplacedArrowError(rowIndex, columnIndex, misplacedMessage));
			endRowIndex = getLastDeeperRowIndex(rows, rowIndex, arrowIndent);
			endColumnIndex = rows[endRowIndex]!.length;
			continue;
		}
		const operandColumnIndex = columnIndex + 2;
		const operandResult = arrow === '=>'
			? bodyOperandParser(rows, rowIndex, operandColumnIndex, arrowIndent)
			: returnTypeOperandParser(rows, rowIndex, operandColumnIndex, arrowIndent, arrow, true);
		if (operandResult.errors) {
			errors.push(...operandResult.errors);
		}
		endRowIndex = operandResult.endRowIndex;
		endColumnIndex = operandResult.endColumnIndex;
		if (arrow === '=>') {
			body = (operandResult.parsed as ParseExpression[] | undefined) ?? [];
		}
		else {
			returnType = {
				arrow: returnArrowPurities[arrow],
				returnTypeBase: operandResult.parsed as ParseValueExpression | undefined,
			};
			if (rows[endRowIndex]?.startsWith(' =>', endColumnIndex)) {
				// Rumpf in derselben Zeile wie der umgebrochene Rückgabepfeil: gemeldet, aber übernommen
				errors.push(misplacedArrowError(
					endRowIndex,
					endColumnIndex + 1,
					'After a wrapped return arrow, => starts its own line at the level of the return arrow.',
				));
				const bodyResult = functionBodyParser(rows, endRowIndex, endColumnIndex, arrowIndent);
				if (bodyResult.errors) {
					errors.push(...bodyResult.errors);
				}
				endRowIndex = bodyResult.endRowIndex;
				endColumnIndex = bodyResult.endColumnIndex;
				body = bodyResult.parsed?.body ?? [];
			}
		}
		const endRow = rows[endRowIndex];
		if (endRow !== undefined && endColumnIndex !== endRow.length) {
			if (operandResult.hasParsed) {
				errors.push({
					code: ErrorCode.unparsedRestOfRow,
					message: 'Unexpected code after the end of the expression.',
					startRowIndex: endRowIndex,
					startColumnIndex: endColumnIndex,
					endRowIndex: endRowIndex,
					endColumnIndex: endRow.length,
				});
			}
			endColumnIndex = endRow.length;
		}
	}
	return {
		hasParsed: true,
		endRowIndex: endRowIndex,
		endColumnIndex: endColumnIndex,
		parsed: returnType
			? {
				type: 'functionTypeBody',
				arrow: returnType.arrow,
				returnTypeBase: returnType.returnTypeBase,
				body: body,
			}
			: {
				type: 'functionBody',
				body: body ?? [],
			},
		errors: errors,
	};
}

/**
 * Rückgabepfeil am Ende der Kopfzeile ist ungültig. Gemeldet wird er, der Rest wird aber gelesen,
 * als stünde der Pfeil schon am Anfang der nächsten Zeile, damit keine Folgefehler entstehen.
 */
function returnArrowAtEndOfRowParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<FunctionHeadRest> {
	const row = rows[startRowIndex]!;
	const arrowColumnIndex = startColumnIndex + 1;
	const arrow = getArrowAt(row, arrowColumnIndex) as ReturnArrow;
	const errors: CompilerError[] = [misplacedArrowError(
		startRowIndex,
		arrowColumnIndex,
		'The return arrow must not end the row. Put it at the start of the next row, indented one level deeper than the function head.',
	)];
	// Der Typblock darf eine Ebene unter der Kopfzeile stehen (wie ein Rumpf unter =>) oder zwei
	// (wie unter einer Pfeilzeile). Fehlt der Typ, ist das schon mit misplacedArrow gesagt.
	const isTypeBlockBelowHeadRow = isRowAtIndent(rows, startRowIndex + 1, indent + 1);
	const typeResult = returnTypeOperandParser(
		rows,
		startRowIndex,
		row.length,
		isTypeBlockBelowHeadRow ? indent : indent + 1,
		arrow,
		false,
	);
	if (typeResult.errors) {
		errors.push(...typeResult.errors);
	}
	const restResult = arrowLinesParser(
		rows,
		typeResult.endRowIndex,
		typeResult.endColumnIndex,
		indent,
		{
			arrow: returnArrowPurities[arrow],
			returnTypeBase: typeResult.parsed,
		},
		true,
	);
	if (restResult.errors) {
		errors.push(...restResult.errors);
	}
	return {
		...restResult,
		errors: errors,
	};
}

/**
 * Operand hinter einem =>: inline ein Ausdruck, am Zeilenende ein eingerückter Block.
 * startColumnIndex steht direkt hinter dem Pfeil.
 */
function bodyOperandParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseExpression[]> {
	const row = rows[startRowIndex];
	if (row !== undefined && startColumnIndex === row.length) {
		// multiline FunctionLiteral
		return blockOperandParser(rows, startRowIndex, startColumnIndex, indent, '=>', true);
	}
	if (row?.startsWith(' ', startColumnIndex)) {
		// inline FunctionLiteral
		const valueResult = valueExpressionParser(rows, startRowIndex, startColumnIndex + 1, indent);
		return {
			...valueResult,
			parsed: valueResult.parsed && [valueResult.parsed],
		};
	}
	return expectedOneOfResult(startRowIndex, startColumnIndex, 'Expected a line end or a space after the arrow.');
}

/**
 * Operand hinter einem Rückgabepfeil: inline eine simpleExpression, am Zeilenende ein eingerückter
 * Block, dessen letzter Ausdruck der Rückgabetyp ist.
 * startColumnIndex steht direkt hinter dem Pfeil.
 */
function returnTypeOperandParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
	arrow: ReturnArrow,
	reportMissingOperand: boolean,
): ParserResult<ParseValueExpression> {
	const row = rows[startRowIndex]!;
	if (startColumnIndex === row.length) {
		const blockResult = blockOperandParser(rows, startRowIndex, startColumnIndex, indent, arrow, reportMissingOperand);
		const errors = blockResult.errors ?? [];
		return {
			...blockResult,
			parsed: typeBlockToReturnType(blockResult.parsed ?? [], errors),
			errors: errors,
		};
	}
	return returnTypeInlineParser(rows, startRowIndex, startColumnIndex + 1, indent);
}

/**
 * Rückgabepfeil, dann eine simpleExpression.
 */
function returnArrowOperandParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<[Purity, SimpleExpression]> {
	const arrow = getReturnArrowPurity(rows[startRowIndex], startColumnIndex);
	if (arrow === undefined) {
		return expectedOneOfResult(startRowIndex, startColumnIndex, 'Expected a return arrow.');
	}
	const operandResult = simpleExpressionBaseParser(rows, startRowIndex, startColumnIndex + 4, indent);
	return {
		hasParsed: operandResult.hasParsed,
		endRowIndex: operandResult.endRowIndex,
		endColumnIndex: operandResult.endColumnIndex,
		parsed: operandResult.hasParsed
			? [arrow, operandResult.parsed!]
			: undefined,
		errors: operandResult.errors,
	};
}

/**
 * Rückgabetyp in derselben Zeile wie der Pfeil. Erlaubt ist nur eine simpleExpression, sonst wäre
 * nicht entscheidbar, wem ein folgendes => gehört. Branching und Funktionstypen werden trotzdem
 * gelesen und übernommen, damit der Knoten vollständig entsteht, aber mit
 * returnTypeRequiresBlock gemeldet.
 */
function returnTypeInlineParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseValueExpression> {
	const row = rows[startRowIndex];
	const branchingKind = row?.startsWith(':?', startColumnIndex)
		? 'typeBranching'
		: row?.[startColumnIndex] === '?'
			? 'branching'
			: undefined;
	if (branchingKind !== undefined) {
		const tokenLength = branchingKind === 'typeBranching' ? 2 : 1;
		const result = branchingParser(rows, startRowIndex, startColumnIndex, indent, branchingKind);
		const errors = result.errors ?? [];
		errors.push({
			code: ErrorCode.returnTypeRequiresBlock,
			message: 'Branching as return type must be written as a block below the return arrow.',
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex + tokenLength,
		});
		return {
			...result,
			parsed: result.parsed && {
				...result.parsed,
				startColumnIndex: startColumnIndex,
			},
			errors: errors,
		};
	}
	const result = simpleExpressionBaseParser(rows, startRowIndex, startColumnIndex, indent);
	const paramsBase = result.parsed;
	if (paramsBase?.type !== 'binding'
		|| getReturnArrowPurity(rows[result.endRowIndex], result.endColumnIndex) === undefined) {
		return result;
	}
	// Funktionstyp als Rückgabetyp
	const innerResult = returnArrowOperandParser(rows, result.endRowIndex, result.endColumnIndex, indent);
	const errors = [
		...(result.errors ?? []),
		...(innerResult.errors ?? []),
	];
	errors.push({
		code: ErrorCode.returnTypeRequiresBlock,
		message: 'A function type as return type must be written as a block below the return arrow.',
		startRowIndex: startRowIndex,
		startColumnIndex: startColumnIndex,
		endRowIndex: innerResult.endRowIndex,
		endColumnIndex: innerResult.endColumnIndex,
	});
	if (!innerResult.parsed) {
		return {
			...innerResult,
			parsed: undefined,
			errors: errors,
		};
	}
	const [arrow, innerReturnTypeBase] = innerResult.parsed;
	const innerReturnType = baseValueExpressionToValueExpression(innerReturnTypeBase, errors);
	const params = bracketedParamsToParams(paramsBase, errors);
	return {
		hasParsed: true,
		endRowIndex: innerResult.endRowIndex,
		endColumnIndex: innerResult.endColumnIndex,
		parsed: createParseFunctionTypeLiteral(
			params,
			innerReturnType,
			arrow,
			{
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				endRowIndex: innerResult.endRowIndex,
				endColumnIndex: innerResult.endColumnIndex,
			},
			errors,
		),
		errors: errors,
	};
}

/**
 * Letzter Ausdruck des Typblocks. Definitionen sind im Typblock (noch) nicht erlaubt, die
 * Ausdrücke davor werden wie im Rumpf ohne Meldung verworfen.
 */
function typeBlockToReturnType(
	expressions: ParseExpression[],
	errors: CompilerError[],
): ParseValueExpression | undefined {
	let returnType: ParseValueExpression | undefined;
	for (const expression of expressions) {
		switch (expression.type) {
			case 'definition':
			case 'destructuring':
			case 'field':
				errors.push({
					code: ErrorCode.definitionNotAllowedForValueExpression,
					message: 'Definitions are not allowed in the return type block.',
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.endRowIndex,
					endColumnIndex: expression.endColumnIndex,
				});
				break;
			default:
				returnType = expression;
		}
	}
	return returnType;
}

/**
 * Eingerückter Block unter einem Pfeil am Zeilenende.
 * Enthält der Block keinen Ausdruck (Dateiende, nächste Zeile nicht eingerückt oder nur Kommentare
 * und Leerzeilen), wird expectedExpression am Pfeil gemeldet. Der Block ist dann leer, geparst
 * gilt er trotzdem, damit der Funktionsknoten für den Language Server erhalten bleibt.
 */
function blockOperandParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
	arrow: Arrow,
	reportMissingOperand: boolean,
): ParserResult<ParseExpression[]> {
	const result = expressionBlockParser(rows, startRowIndex + 1, 0, indent + 1, true);
	if (result.hasParsed && result.parsed?.length) {
		return result;
	}
	// Scheitern kann der Block nur am Dateiende. Der endOfCode-Fehler wird durch
	// expectedExpression ersetzt.
	const errors = result.hasParsed
		? [...(result.errors ?? [])]
		: [];
	// Hat der Block nur fehlerhafte Zeilen, ist expectedExpression ein Folgefehler.
	if (!errors.length && reportMissingOperand) {
		errors.push({
			code: ErrorCode.expectedExpression,
			message: `expression expected after ${arrow}`,
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex - 2,
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
		});
	}
	return {
		hasParsed: true,
		endRowIndex: result.hasParsed ? result.endRowIndex : startRowIndex,
		endColumnIndex: result.hasParsed ? result.endColumnIndex : startColumnIndex,
		parsed: [],
		errors: errors,
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
): ParserResult<FunctionBody> {
	if (!rows[startRowIndex]?.startsWith(' =>', startColumnIndex)) {
		return tokenFailure(rows, startRowIndex, startColumnIndex, ' =>');
	}
	const bodyResult = bodyOperandParser(rows, startRowIndex, startColumnIndex + 3, indent);
	return {
		hasParsed: bodyResult.hasParsed,
		endRowIndex: bodyResult.endRowIndex,
		endColumnIndex: bodyResult.endColumnIndex,
		parsed: bodyResult.hasParsed
			? {
				type: 'functionBody',
				body: bodyResult.parsed!,
			}
			: undefined,
		errors: bodyResult.errors,
	};
}

/**
 * FunctionTypeLiteral/FunctionLiteral mit ReturnType, Rückgabepfeil in der Kopfzeile.
 * Der Rumpf steht in derselben Zeile oder in einer =>-Zeile darunter.
 * enthält ggf. endständiges Zeilenende nicht
 */
function functionTypeBodyParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<FunctionTypeBody> {
	const arrow = getReturnArrowPurity(rows[startRowIndex], startColumnIndex);
	if (arrow === undefined) {
		return expectedOneOfResult(startRowIndex, startColumnIndex, 'Expected a return arrow.');
	}
	const returnTypeResult = returnTypeInlineParser(rows, startRowIndex, startColumnIndex + 4, indent);
	if (!returnTypeResult.hasParsed) {
		return {
			hasParsed: false,
			endRowIndex: returnTypeResult.endRowIndex,
			endColumnIndex: returnTypeResult.endColumnIndex,
			errors: returnTypeResult.errors,
		};
	}
	const returnTypeBase = returnTypeResult.parsed!;
	const errors = returnTypeResult.errors ?? [];
	const { endRowIndex, endColumnIndex } = returnTypeResult;
	if (rows[endRowIndex]?.startsWith(' =>', endColumnIndex)) {
		const bodyResult = functionBodyParser(rows, endRowIndex, endColumnIndex, indent);
		if (bodyResult.errors) {
			errors.push(...bodyResult.errors);
		}
		return {
			...bodyResult,
			parsed: bodyResult.parsed && {
				type: 'functionTypeBody',
				arrow: arrow,
				returnTypeBase: returnTypeBase,
				body: bodyResult.parsed.body,
			},
			errors: errors,
		};
	}
	if (isFunctionHeadContinued(rows, endRowIndex, endColumnIndex, indent)) {
		// Rückgabetyp in der Kopfzeile, nur => umgebrochen
		const restResult = arrowLinesParser(
			rows,
			endRowIndex,
			endColumnIndex,
			indent,
			{
				arrow: arrow,
				returnTypeBase: returnTypeBase,
			},
			false,
		);
		if (restResult.errors) {
			errors.push(...restResult.errors);
		}
		return {
			...restResult,
			// arrowLinesParser liefert mit headReturnType immer functionTypeBody
			parsed: restResult.parsed as FunctionTypeBody,
			errors: errors,
		};
	}
	return {
		hasParsed: true,
		endRowIndex: endRowIndex,
		endColumnIndex: endColumnIndex,
		parsed: {
			type: 'functionTypeBody',
			arrow: arrow,
			returnTypeBase: returnTypeBase,
		},
		errors: errors,
	};
}

/**
 * Pfeilzeile, die zu keinem Funktionskopf gehört: nach einer Leerzeile, nach einem weniger tief
 * eingerückten Kommentar, auf Ebene des Kopfs oder zu tief eingerückt. Sie wird samt tiefer
 * eingerückten Folgezeilen gemeldet und übersprungen, statt sie als Ausdruck zu parsen.
 * Gültige Programme enthalten solche Zeilen nie.
 */
const orphanCheckedExpressionParser = (rows: string[], startRowIndex: number, startColumnIndex: number, indent: number) =>
	checkOrphanArrowLine(expressionParser, rows, startRowIndex, startColumnIndex, indent);

const orphanCheckedValueExpressionParser = (rows: string[], startRowIndex: number, startColumnIndex: number, indent: number) =>
	checkOrphanArrowLine(valueExpressionParser, rows, startRowIndex, startColumnIndex, indent);

function checkOrphanArrowLine<T>(
	parser: LineParser<T>,
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<T> {
	const row = rows[startRowIndex];
	if (row === undefined) {
		return parser(rows, startRowIndex, startColumnIndex, indent);
	}
	let arrowColumnIndex = startColumnIndex;
	while (row[arrowColumnIndex] === '\t') {
		arrowColumnIndex++;
	}
	if (!getArrowAt(row, arrowColumnIndex)) {
		return parser(rows, startRowIndex, startColumnIndex, indent);
	}
	const extraIndent = arrowColumnIndex - startColumnIndex;
	const error: CompilerError = extraIndent >= 2
		? {
			code: ErrorCode.unexpectedIndentation,
			message: `Arrow line is indented ${extraIndent} levels deeper than the function head, expected one level.`,
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: startRowIndex,
			endColumnIndex: arrowColumnIndex,
		}
		: misplacedArrowError(startRowIndex, arrowColumnIndex, getOrphanArrowLineMessage(rows, startRowIndex, extraIndent));
	const lastRowIndex = getLastDeeperRowIndex(rows, startRowIndex, indent + extraIndent);
	return {
		hasParsed: false,
		endRowIndex: lastRowIndex,
		endColumnIndex: rows[lastRowIndex]!.length,
		errors: [error],
	};
}

function getOrphanArrowLineMessage(rows: string[], rowIndex: number, extraIndent: number): string {
	if (!extraIndent) {
		return 'An arrow line must be indented one level deeper than the function head.';
	}
	const previousRow = rows[rowIndex - 1];
	if (previousRow === '') {
		return 'A blank line ends the function head. Remove the blank line before the arrow line.';
	}
	if (previousRow?.trimStart().startsWith('#')) {
		return 'A comment indented less than the arrow lines ends the function head. Indent the comment to the level of the arrow lines.';
	}
	return 'Arrow line without function head.';
}

//#endregion Funktionskopf

//#endregion ValueExpression

//#region bracketed

/**
 * Parst beginnend mit öffnender bis zur 1. schließenden Klammer.
 * Multiline oder inline mit Leerzeichen getrennt.
 * Die Klammerart bestimmt den Knotentyp: rund = Bindung, eckig = Daten.
 */
function createBracketedBaseParser(kind: BracketKind): LineParser<ParseBindingExpression | ParseDataExpression> {
	const { openingCharacter, closingCharacter, nodeType } = brackets[kind];
	const multilineParser2 = createBracketedMultilineParser(kind);
	const inlineParser = createBracketedInlineParser(kind);
	/**
	 * Die Alternativen in dieser Reihenfolge, das erste passende Prädikat gewinnt:
	 * 1. Die leere Klammer braucht einen eigenen Zweig, weil bracketedInlineParser mindestens ein
	 *    Feld verlangt und bracketedMultilineParser einen Zeilenumbruch.
	 * 2. Öffnende Klammer, hinter der nichts mehr kommt (beim Tippen der erste Zustand).
	 * 3. Öffnende Klammer am Zeilenende: mehrzeilig.
	 * 4. Sonst inline.
	 */
	const parser = (
		rows: string[],
		startRowIndex: number,
		startColumnIndex: number,
		indent: number,
	): ParserResult<ParseBindingExpression | ParseDataExpression> => {
		const row = rows[startRowIndex];
		let result: ParserResult<(ParseFieldBase | string | undefined)[]>;
		if (row !== undefined && row.startsWith(openingCharacter, startColumnIndex)) {
			const rest = row.substring(startColumnIndex + 1);
			if (rest.startsWith(closingCharacter)) {
				result = {
					hasParsed: true,
					endRowIndex: startRowIndex,
					endColumnIndex: startColumnIndex + 2,
					parsed: [],
				};
			}
			else if (/^ *$/.test(rest) && (
				rest.length > 0 || hasOnlyEmptyRowsAfter(rows, startRowIndex)
			)) {
				result = {
					hasParsed: true,
					endRowIndex: startRowIndex,
					endColumnIndex: row.length,
					parsed: [],
					errors: [closingBracketMissingError(closingCharacter, startRowIndex, row.length)],
				};
			}
			else if (rest.length === 0) {
				result = multilineParser2(rows, startRowIndex, startColumnIndex, indent);
			}
			else {
				result = inlineParser(rows, startRowIndex, startColumnIndex, indent);
			}
		}
		else {
			result = inlineParser(rows, startRowIndex, startColumnIndex, indent);
		}
		const parsed = result.parsed;
		if (!parsed) {
			return {
				...result,
				parsed: undefined,
			};
		}
		const fieldsWithDescription = assignDescriptions(parsed);
		const bracketed: ParseBindingExpression | ParseDataExpression = {
			type: nodeType,
			fields: fieldsWithDescription,
			startRowIndex: startRowIndex,
			startColumnIndex: startColumnIndex,
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
		};
		// parent wird nachgelagert gesetzt, siehe setParentsAndIds
		return {
			...result,
			parsed: bracketed,
		};
	};
	return parser;
}

/**
 * Schließende Klammer in einer eigenen Zeile: Zeilenumbruch, Einrückung, Klammer.
 */
function closingOnOwnLine(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
	closingCharacter: string,
): ParserResult<undefined> {
	const newLineResult = newLineParser(rows, startRowIndex, startColumnIndex, indent);
	let errors = newLineResult.errors;
	if (!newLineResult.hasParsed) {
		return { hasParsed: false, endRowIndex: newLineResult.endRowIndex, endColumnIndex: newLineResult.endColumnIndex, errors: errors };
	}
	const indentResult = indentParser(rows, newLineResult.endRowIndex, newLineResult.endColumnIndex, indent);
	errors = mergeErrors(errors, indentResult.errors);
	if (!indentResult.hasParsed) {
		return { hasParsed: false, endRowIndex: indentResult.endRowIndex, endColumnIndex: indentResult.endColumnIndex, errors: errors };
	}
	if (!rows[indentResult.endRowIndex]?.startsWith(closingCharacter, indentResult.endColumnIndex)) {
		const closingResult = tokenFailure(rows, indentResult.endRowIndex, indentResult.endColumnIndex, closingCharacter);
		return {
			hasParsed: false,
			endRowIndex: closingResult.endRowIndex,
			endColumnIndex: closingResult.endColumnIndex,
			errors: mergeErrors(errors, closingResult.errors),
		};
	}
	return {
		hasParsed: true,
		endRowIndex: indentResult.endRowIndex,
		endColumnIndex: indentResult.endColumnIndex + 1,
		errors: errors,
	};
}

const orphanCheckedFieldParser = (rows: string[], startRowIndex: number, startColumnIndex: number, indent: number) =>
	checkOrphanArrowLine(fieldParser, rows, startRowIndex, startColumnIndex, indent);

/**
 * Felder einer Zeile in einer mehrzeiligen Klammerliste. Erlaubt ist eines je Zeile, weitere mit
 * Leerzeichen getrennte Felder werden trotzdem geparst und als multipleFieldsInRow gemeldet,
 * damit der Baum vollständig bleibt.
 */
function fieldsInRowParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<ParseFieldBase[]> {
	const firstResult = orphanCheckedFieldParser(rows, startRowIndex, startColumnIndex, indent);
	if (!firstResult.hasParsed) {
		return { ...firstResult, parsed: undefined };
	}
	const fields = [firstResult.parsed!];
	let errors = firstResult.errors;
	let endRowIndex = firstResult.endRowIndex;
	let endColumnIndex = firstResult.endColumnIndex;
	while (true) {
		const row = rows[endRowIndex];
		const fieldColumnIndex = endColumnIndex + 1;
		if (row === undefined
			|| row[endColumnIndex] !== ' '
			|| fieldColumnIndex >= row.length
			|| ' )]#'.includes(row[fieldColumnIndex]!)) {
			break;
		}
		const fieldResult = orphanCheckedFieldParser(rows, endRowIndex, fieldColumnIndex, indent);
		if (!fieldResult.hasParsed) {
			// Der Rest der Zeile bleibt stehen und wird vom Block als unparsedRestOfRow gemeldet
			break;
		}
		errors = mergeErrors(errors, fieldResult.errors);
		fields.push(fieldResult.parsed!);
		endRowIndex = fieldResult.endRowIndex;
		endColumnIndex = fieldResult.endColumnIndex;
	}
	if (fields.length > 1) {
		const secondField = fields[1]!;
		errors = mergeErrors(errors, [{
			code: ErrorCode.multipleFieldsInRow,
			message: 'Each field of a multiline list must be on its own line.',
			startRowIndex: secondField.startRowIndex,
			startColumnIndex: secondField.startColumnIndex,
			endRowIndex: endRowIndex,
			endColumnIndex: endColumnIndex,
		}]);
	}
	return {
		hasParsed: true,
		endRowIndex: endRowIndex,
		endColumnIndex: endColumnIndex,
		parsed: fields,
		errors: errors,
	};
}

function createBracketedMultilineParser(kind: BracketKind): LineParser<(ParseFieldBase | string | undefined)[]> {
	const { openingCharacter, closingCharacter } = brackets[kind];
	return (rows, startRowIndex, startColumnIndex, indent) => {
		if (!rows[startRowIndex]?.startsWith(openingCharacter, startColumnIndex)) {
			return tokenFailure(rows, startRowIndex, startColumnIndex, openingCharacter);
		}
		const newLineResult = newLineParser(rows, startRowIndex, startColumnIndex + 1, indent);
		let fieldsErrors = newLineResult.errors;
		if (!newLineResult.hasParsed) {
			return { hasParsed: false, endRowIndex: newLineResult.endRowIndex, endColumnIndex: newLineResult.endColumnIndex, errors: fieldsErrors };
		}
		const fieldsResult = multilineBlock(fieldsInRowParser, true, rows, newLineResult.endRowIndex, newLineResult.endColumnIndex, indent + 1);
		fieldsErrors = mergeErrors(fieldsErrors, fieldsResult.errors);
		if (!fieldsResult.hasParsed) {
			return { hasParsed: false, endRowIndex: fieldsResult.endRowIndex, endColumnIndex: fieldsResult.endColumnIndex, errors: fieldsErrors };
		}
		const parsed = fieldsResult.parsed!.flatMap<ParseFieldBase | string | undefined>(rowFields =>
			Array.isArray(rowFields)
				? rowFields
				: [rowFields]);
		const errors = fieldsErrors ?? [];
		// Die Klammer steht hinter dem letzten Feld statt in einer eigenen Zeile: tolerieren, damit
		// der Baum für den Language Server erhalten bleibt
		if (rows[fieldsResult.endRowIndex]?.startsWith(closingCharacter, fieldsResult.endColumnIndex)) {
			errors.push({
				code: ErrorCode.closingBracketNotOnOwnLine,
				message: 'Closing bracket must be on its own line after a multiline list.',
				startRowIndex: fieldsResult.endRowIndex,
				startColumnIndex: fieldsResult.endColumnIndex,
				endRowIndex: fieldsResult.endRowIndex,
				endColumnIndex: fieldsResult.endColumnIndex + 1,
			});
			return {
				hasParsed: true,
				endRowIndex: fieldsResult.endRowIndex,
				endColumnIndex: fieldsResult.endColumnIndex + 1,
				parsed: parsed,
				errors: errors,
			};
		}
		const closingResult = closingOnOwnLine(rows, fieldsResult.endRowIndex, fieldsResult.endColumnIndex, indent, closingCharacter);
		if (closingResult.errors) {
			errors.push(...closingResult.errors);
		}
		return {
			hasParsed: closingResult.hasParsed,
			endRowIndex: closingResult.endRowIndex,
			endColumnIndex: closingResult.endColumnIndex,
			parsed: closingResult.hasParsed
				? parsed
				: undefined,
			errors: errors,
		};
	};
}

interface ParseMissingField {
	type: 'missingField';
	rowIndex: number;
	columnIndex: number;
}

/**
 * undefined bei fehlendem Feld
 */
function createBracketedInlineParser(kind: BracketKind): LineParser<(ParseFieldBase | undefined)[]> {
	const { openingCharacter, closingCharacter } = brackets[kind];
	return (rows, startRowIndex, startColumnIndex, indent) => {
		if (!rows[startRowIndex]?.startsWith(openingCharacter, startColumnIndex)) {
			const openingFailure = tokenFailure(rows, startRowIndex, startColumnIndex, openingCharacter);
			return { ...openingFailure, parsed: undefined, errors: openingFailure.errors ?? [] };
		}
		// Leerraum vor dem ersten Feld (etwa die Einrückung der Folgezeile, wenn der Umbruch hinter der
		// Klammer mit Entf gelöscht wurde): überspringen und melden, damit die Liste erhalten bleibt.
		// Steht danach nichts oder die Klammer, bleibt es bei den bisherigen Fehlern.
		const openingRow = rows[startRowIndex]!;
		let firstColumnIndex = startColumnIndex + 1;
		while (openingRow[firstColumnIndex] === ' ' || openingRow[firstColumnIndex] === '\t') {
			firstColumnIndex++;
		}
		let whitespaceErrors: CompilerError[] | undefined;
		if (firstColumnIndex > startColumnIndex + 1
			&& firstColumnIndex < openingRow.length
			&& openingRow[firstColumnIndex] !== closingCharacter) {
			whitespaceErrors = [{
				code: ErrorCode.whitespaceAfterOpeningBracket,
				message: 'The first field of an inline list must follow the opening bracket directly.',
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex + 1,
				endRowIndex: startRowIndex,
				endColumnIndex: firstColumnIndex,
			}];
		}
		else {
			firstColumnIndex = startColumnIndex + 1;
		}
		const firstResult = fieldParser(rows, startRowIndex, firstColumnIndex, indent);
		let fieldsErrors = mergeErrors(whitespaceErrors, firstResult.errors);
		if (!firstResult.hasParsed) {
			return {
				hasParsed: false,
				endRowIndex: firstResult.endRowIndex,
				endColumnIndex: firstResult.endColumnIndex,
				parsed: undefined,
				errors: fieldsErrors ?? [],
			};
		}
		const fields: (ParseMissingField | ParseFieldBase)[] = [firstResult.parsed!];
		let fieldsEndRowIndex = firstResult.endRowIndex;
		let fieldsEndColumnIndex = firstResult.endColumnIndex;
		/**
		 * Felder stehen in tiefer eingerückten Folgezeilen, die Klammer darf dann auch in einer
		 * eigenen Zeile stehen.
		 */
		let spansRows = false;
		const continuationIndentToken = getIndentToken(indent + 1);
		// Weitere Felder, jeweils nach einem Leerzeichen. Direkt dahinter folgt noch ein Leerzeichen
		// oder die Klammer: dann fehlt ein Feld. Ein Fehlschlag beendet die Wiederholung ohne
		// Folgen, die Fehler des Versuchs gehen verloren.
		while (fieldsEndRowIndex < rows.length) {
			const row = rows[fieldsEndRowIndex]!;
			// Zeilenende hinter einem Feld (nicht hinter einem Block, der endet am Anfang der
			// Folgezeile): Geht es in einer tiefer eingerückten Zeile weiter, gehören deren Felder
			// trotzdem dazu und werden als inlineFieldsSpanRows gemeldet.
			if (fieldsEndColumnIndex > 0 && fieldsEndColumnIndex === row.length) {
				const nextRowIndex = fieldsEndRowIndex + 1;
				const nextRow = rows[nextRowIndex];
				const fieldColumnIndex = indent + 1;
				if (nextRow === undefined
					|| !nextRow.startsWith(continuationIndentToken)
					|| fieldColumnIndex >= nextRow.length
					|| ' \t#)]'.includes(nextRow[fieldColumnIndex]!)) {
					break;
				}
				const fieldResult = fieldParser(rows, nextRowIndex, fieldColumnIndex, indent + 1);
				if (!fieldResult.hasParsed) {
					break;
				}
				fieldsErrors = mergeErrors(fieldsErrors, [
					...fieldResult.errors ?? [],
					{
						code: ErrorCode.inlineFieldsSpanRows,
						message: 'Fields of an inline list must start on the row of the opening bracket.',
						startRowIndex: nextRowIndex,
						startColumnIndex: fieldColumnIndex,
						endRowIndex: fieldResult.endRowIndex,
						endColumnIndex: fieldResult.endColumnIndex,
					},
				]);
				fields.push(fieldResult.parsed!);
				fieldsEndRowIndex = fieldResult.endRowIndex;
				fieldsEndColumnIndex = fieldResult.endColumnIndex;
				spansRows = true;
				continue;
			}
			if (!row.startsWith(' ', fieldsEndColumnIndex)) {
				break;
			}
			const fieldColumnIndex = fieldsEndColumnIndex + 1;
			if (row.startsWith(' ', fieldColumnIndex) || row.startsWith(closingCharacter, fieldColumnIndex)) {
				fields.push({
					type: 'missingField',
					rowIndex: fieldsEndRowIndex,
					columnIndex: fieldColumnIndex,
				});
				fieldsEndColumnIndex = fieldColumnIndex;
				continue;
			}
			const fieldResult = fieldParser(rows, fieldsEndRowIndex, fieldColumnIndex, indent);
			if (!fieldResult.hasParsed) {
				break;
			}
			fieldsErrors = mergeErrors(fieldsErrors, fieldResult.errors);
			fields.push(fieldResult.parsed!);
			fieldsEndRowIndex = fieldResult.endRowIndex;
			fieldsEndColumnIndex = fieldResult.endColumnIndex;
		}
		const errors = fieldsErrors ?? [];
		const parsed = fields.map(field => {
			if (field.type === 'missingField') {
				errors.push({
					// TODO error message abhängig von der Art der erwarteten expression? (field vs value)
					code: ErrorCode.expectedExpression,
					message: 'expression expected',
					// TODO get position from empty
					startRowIndex: field.rowIndex,
					startColumnIndex: field.columnIndex,
					endRowIndex: field.rowIndex,
					endColumnIndex: field.columnIndex,
				});
				return undefined;
			}
			return field;
		});
		const blockExpressions = parsed.flatMap(field => {
			const blockExpression = field && getBlockExpression(field);
			return blockExpression
				? [blockExpression]
				: [];
		});
		// Hinter einem Block steht die Klammer in der Zeile seines letzten Ausdrucks (der Block endet
		// davor) oder in einer eigenen Zeile
		let closingEndRowIndex: number | undefined;
		let closingEndColumnIndex = 0;
		if (rows[fieldsEndRowIndex]?.startsWith(closingCharacter, fieldsEndColumnIndex)) {
			closingEndRowIndex = fieldsEndRowIndex;
			closingEndColumnIndex = fieldsEndColumnIndex + 1;
		}
		const lastField = parsed[parsed.length - 1];
		if (closingEndRowIndex === undefined && (spansRows || lastField && getBlockExpression(lastField))) {
			const closingOnOwnLineResult = closingOnOwnLine(rows, fieldsEndRowIndex, fieldsEndColumnIndex, indent, closingCharacter);
			if (closingOnOwnLineResult.hasParsed) {
				closingEndRowIndex = closingOnOwnLineResult.endRowIndex;
				closingEndColumnIndex = closingOnOwnLineResult.endColumnIndex;
			}
		}
		if (closingEndRowIndex === undefined) {
			// Nach dem öffnenden Zeichen ist klar, was folgen muss. Fehlt die Klammer, den Knoten trotzdem
			// liefern (der Baum bleibt für den Language Server erhalten) und genau das melden.
			// Leerzeichen am Zeilenende gehören dazu: Das Feld dahinter fehlt noch, sie blieben sonst
			// als unparsedRestOfRow stehen.
			const endRow = rows[fieldsEndRowIndex] ?? '';
			const endColumnIndex = /^ *$/.test(endRow.substring(fieldsEndColumnIndex))
				? endRow.length
				: fieldsEndColumnIndex;
			// Nach einem Block endet der Feldbereich am Anfang der Folgezeile (die es am Ende des Codes
			// nicht gibt). Gemeldet wird am Ende der Zeile davor, dort fehlt die Klammer.
			const endsAtLineStart = endColumnIndex === 0 && fieldsEndRowIndex > 0;
			const errorRowIndex = endsAtLineStart
				? fieldsEndRowIndex - 1
				: fieldsEndRowIndex;
			const errorColumnIndex = endsAtLineStart
				? rows[errorRowIndex]!.length
				: endColumnIndex;
			return {
				hasParsed: true,
				endRowIndex: fieldsEndRowIndex,
				endColumnIndex: endColumnIndex,
				parsed: parsed,
				errors: [...errors, closingBracketMissingError(closingCharacter, errorRowIndex, errorColumnIndex)],
			};
		}
		// Tolerieren, damit der Baum für den Language Server erhalten bleibt
		blockExpressions.forEach(blockExpression => {
			errors.push({
				code: ErrorCode.blockExpressionNotOnOwnLine,
				message: blockExpression.message,
				startRowIndex: blockExpression.expression.startRowIndex,
				startColumnIndex: blockExpression.expression.startColumnIndex,
				endRowIndex: blockExpression.headEndRowIndex,
				endColumnIndex: rows[blockExpression.headEndRowIndex]?.length ?? 0,
			});
		});
		return {
			hasParsed: true,
			endRowIndex: closingEndRowIndex,
			endColumnIndex: closingEndColumnIndex,
			parsed: parsed,
			errors: errors,
		};
	};
}

/**
 * Ausdruck eines Felds, dessen Block in den Zeilen unter dem Kopf steht: Funktion mit Rumpfblock
 * oder Branching mit Zweigen darunter.
 */
function getBlockExpression(field: ParseFieldBase): {
	expression: ParseFunctionLiteral | ParseBranching | ParseTypeBranching;
	/**
	 * Letzte Zeile des Kopfs, bis zu der ein Fehler reicht.
	 */
	headEndRowIndex: number;
	message: string;
} | undefined {
	const value = field.definition
		? field.assignedValue
		: field.name;
	switch (value?.type) {
		case 'functionLiteral': {
			const firstBodyExpression = value.body[0];
			return firstBodyExpression && firstBodyExpression.startRowIndex > value.params.endRowIndex
				? {
					expression: value,
					headEndRowIndex: value.params.endRowIndex,
					message: 'A function with a block body must start on its own line.',
				}
				: undefined;
		}
		case 'branching':
		case 'typeBranching': {
			const headEndRowIndex = value.args?.endRowIndex ?? value.startRowIndex;
			const firstBranch = value.branches[0];
			return firstBranch && firstBranch.startRowIndex > headEndRowIndex
				? {
					expression: value,
					headEndRowIndex: headEndRowIndex,
					message: 'Branching must start on its own line.',
				}
				: undefined;
		}
		default:
			return undefined;
	}
}

const roundBracketedBaseParser = createBracketedBaseParser('round');
const squareBracketedBaseParser = createBracketedBaseParser('square');

//#endregion bracketed

//#endregion expression parser

/**
 * Unmittelbar aufeinanderfolgende Kommentarzeilen zusammenfassen und zur darauffolgenden Definition/Field packen
 */
function assignDescriptions<T extends ParseExpression>(expressionsOrComments: (string | undefined | T)[]): T[] {
	let descriptionComment: string | undefined = undefined;
	const expressionsWithDescription: any[] = [];
	expressionsOrComments.forEach(expressionOrComment => {
		switch (typeof expressionOrComment) {
			case 'object':
				// Expression
				const expressionWithDescription = expressionOrComment.type === 'definition'
					|| expressionOrComment.type === 'field'
					? {
						...expressionOrComment,
						description: descriptionComment,
					}
					: expressionOrComment;
				expressionsWithDescription.push(expressionWithDescription);
				descriptionComment = undefined;
				return;
			case 'string':
				// Kommentar
				if (expressionOrComment.startsWith('region') || expressionOrComment.startsWith('endregion')) {
					// region comments verwerfen
					return;
				}
				if (isDirectiveCommentText(expressionOrComment)) {
					// Anweisung, keine Beschreibung. Eine Beschreibung darüber bleibt stehen.
					return;
				}
				descriptionComment = descriptionComment === undefined
					? expressionOrComment
					: descriptionComment + '\n' + expressionOrComment;
				return;
			case 'undefined':
				// Leerzeile
				descriptionComment = undefined;
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

function bindingToDestructuringFields(
	bracketedExpression: ParseBindingExpression,
	errors: CompilerError[],
): ParseDestructuringFields {
	if (!bracketedExpression.fields.length) {
		errors.push({
			code: ErrorCode.emptyDestructuring,
			message: 'destructuring fields must not be empty',
			startRowIndex: bracketedExpression.startRowIndex,
			startColumnIndex: bracketedExpression.startColumnIndex,
			endRowIndex: bracketedExpression.endRowIndex,
			endColumnIndex: bracketedExpression.endColumnIndex,
		});
	}
	const fields: ParseDestructuringField[] = [];
	bracketedExpression.fields.forEach(baseField => {
		checkOptionalNotAllowed(baseField, errors);
		const baseName = baseField.name;
		const checkedName = checkName(baseName);
		if (!checkedName) {
			errors.push({
				code: ErrorCode.invalidDestructuringFieldName,
				message: `${baseName.type} is not a valid expression for destructuring field name`,
				startRowIndex: baseName.startRowIndex,
				startColumnIndex: baseName.startColumnIndex,
				endRowIndex: baseName.endRowIndex,
				endColumnIndex: baseName.endColumnIndex,
			});
		}
		if (baseField.spread) {
			// TODO spread ohne source, typeGuard?
			errors.push({
				code: ErrorCode.spreadNotSupportedForDestructuring,
				message: `spread is not yet supported for destructuring`,
				startRowIndex: baseName.startRowIndex,
				startColumnIndex: baseName.startColumnIndex,
				endRowIndex: baseName.endRowIndex,
				endColumnIndex: baseName.endColumnIndex,
			});
		}
		const parseSource = baseField.assignedValue;
		let checkedSource: | Name | undefined;
		if (parseSource) {
			// TODO nested destructuring?
			checkedSource = checkName(parseSource);
			if (!checkedSource) {
				errors.push({
					code: ErrorCode.invalidParameterSource,
					message: `${parseSource.type} is not a valid expression for parameter source.`,
					startRowIndex: parseSource.startRowIndex,
					startColumnIndex: parseSource.startColumnIndex,
					endRowIndex: parseSource.endRowIndex,
					endColumnIndex: parseSource.endColumnIndex,
				});
			}
		}
		if (!checkedName) {
			return;
		}
		const destructuringField: ParseDestructuringField = {
			type: 'destructuringField',
			description: baseField.description,
			name: checkedName,
			typeGuard: baseField.typeGuard,
			source: checkedSource,
			startRowIndex: baseField.startRowIndex,
			startColumnIndex: baseField.startColumnIndex,
			endRowIndex: baseField.endRowIndex,
			endColumnIndex: baseField.endColumnIndex,
		};
		fields.push(destructuringField);
	});
	const symbols = createSymbolTable();
	fillSymbolTableWithFields(symbols, errors, fields, false);
	const parseFields: ParseDestructuringFields = {
		type: 'destructuringFields',
		fields: fields,
		symbols: symbols,
		startRowIndex: bracketedExpression.startRowIndex,
		startColumnIndex: bracketedExpression.startColumnIndex,
		endRowIndex: bracketedExpression.endRowIndex,
		endColumnIndex: bracketedExpression.endColumnIndex,
	};
	return parseFields;
}

/**
 * Deutet die Klammer vor ` => ` bzw. ` :> ` nach ihrer Art:
 * rund ist eine Parameterliste, eckig ein Datenliteral und damit der Parametertyp
 * (die beklammerte Entsprechung zu `Text => true`).
 * Alles andere ist bereits ein Wert und bleibt unverändert.
 */
function bracketedParamsToParams(
	params: SimpleExpression | ParseParameterFields,
	errors: CompilerError[],
): SimpleExpression | ParseParameterFields {
	switch (params.type) {
		case 'binding':
			return bindingToParameters(params, errors);
		case 'data':
			return bracketedExpressionToValueExpression(params, errors);
		default:
			return params;
	}
}

function bindingToParameters(
	bracketedExpression: ParseBindingExpression,
	errors: CompilerError[],
): ParseBindingExpression | ParseParameterFields {
	const baseFields = bracketedExpression.fields;
	let rest: ParseParameterField | undefined;
	const singleFields: ParseParameterField[] = [];
	for (let index = 0; index < baseFields.length; index++) {
		const baseField = baseFields[index]!;
		checkOptionalNotAllowed(baseField, errors);
		const parseSource = baseField.assignedValue;
		let source: Name | undefined;
		if (parseSource) {
			source = checkName(parseSource);
			if (!source) {
				errors.push({
					code: ErrorCode.invalidParameterSource,
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
			startRowIndex: baseField.startRowIndex,
			startColumnIndex: baseField.startColumnIndex,
			endRowIndex: baseField.endRowIndex,
			endColumnIndex: baseField.endColumnIndex,
		};
		if (baseField.spread) {
			if (index < baseFields.length - 1) {
				errors.push({
					code: ErrorCode.restArgumentNotLast,
					message: 'Rest argument must be last.',
					startRowIndex: baseField.startRowIndex,
					startColumnIndex: baseField.startColumnIndex,
					endRowIndex: baseField.endRowIndex,
					endColumnIndex: baseField.endColumnIndex,
				});
				// TODO collect all errors before returning?
				return bracketedExpression;
			}
			rest = parameterField;
		}
		else {
			singleFields.push(parameterField);
		}
	}
	return createParseParameters(singleFields, rest, bracketedExpression, errors);
}

function checkName(parseName: ParseValueExpression): Name | undefined {
	if (parseName.type !== 'reference') {
		return undefined;
	}
	return parseName.name;
}

function simpleExpressionBaseToSimpleExpression(
	simpleExpressionBase: SimpleExpression,
	errors: CompilerError[],
): SimpleExpression {
	if (isBracketed(simpleExpressionBase)) {
		return bracketedExpressionToValueExpression(simpleExpressionBase, errors);
	}
	return simpleExpressionBase;
}

function baseValueExpressionToValueExpression(
	baseExpression: ParseValueExpression,
	errors: CompilerError[],
): ParseValueExpression {
	if (isBracketed(baseExpression)) {
		return bracketedExpressionToValueExpression(baseExpression, errors);
	}
	return baseExpression;
}

/**
 * @param isFunctionArguments Argumentlisten sind rund geschrieben, ihr Inhalt ist aber
 * eine Kollektion und wird daher wie ein Datenliteral konvertiert.
 */
function bracketedExpressionToValueExpression(
	bracketedExpression: ParseBindingExpression | ParseDataExpression,
	errors: CompilerError[],
	isFunctionArguments: boolean = false,
): BracketedExpression {
	// Datenliterale werden eckig geschrieben. Der Fehler wird gemeldet, die Konvertierung
	// läuft trotzdem weiter, damit der Language Server einen brauchbaren Baum behält.
	if (bracketedExpression.type === 'binding' && !isFunctionArguments) {
		errors.push({
			code: ErrorCode.dataLiteralMustUseSquareBrackets,
			message: 'data literal must use square brackets [ ]',
			startRowIndex: bracketedExpression.startRowIndex,
			startColumnIndex: bracketedExpression.startColumnIndex,
			endRowIndex: bracketedExpression.endRowIndex,
			endColumnIndex: bracketedExpression.endColumnIndex,
		});
	}
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
		&& !baseField.definition)
		&& baseFields.some(baseField => !baseField.spread);
	if (isList) {
		const list: ParseListLiteral = {
			type: 'list',
			values: mapNonEmpty(
				baseFields,
				baseField => {
					const value = baseValueExpressionToValueExpression(baseField.name, errors);
					if (baseField.spread) {
						const spreadValue: ParseSpreadValueExpression = {
							type: 'spread',
							value: value,
							startRowIndex: baseField.startRowIndex,
							startColumnIndex: baseField.startColumnIndex,
							endRowIndex: baseField.endRowIndex,
							endColumnIndex: baseField.endColumnIndex,
						};
						return spreadValue;
					}
					return value;
				}),
			startRowIndex: bracketedExpression.startRowIndex,
			startColumnIndex: bracketedExpression.startColumnIndex,
			endRowIndex: bracketedExpression.endRowIndex,
			endColumnIndex: bracketedExpression.endColumnIndex,
		};
		return list;
	}
	const isDictionary = baseFields.every(baseField =>
		// singleDictionaryField muss definition haben
		baseField.spread || baseField.definition)
		&& baseFields.some(baseField => baseField.definition);
	if (isDictionary) {
		const fields = mapNonEmpty(
			baseFields,
			baseField => {
				checkOptionalNotAllowed(baseField, errors);
				const baseName = baseField.name;
				const typeGuard = baseField.typeGuard;
				if (baseField.spread) {
					if (typeGuard) {
						errors.push({
							code: ErrorCode.typeGuardNotAllowedForSpreadDictionaryField,
							message: `typeGuard is not allowed for spread dictionary field`,
							startRowIndex: typeGuard.startRowIndex,
							startColumnIndex: typeGuard.startColumnIndex,
							endRowIndex: typeGuard.endRowIndex,
							endColumnIndex: typeGuard.endColumnIndex,
						});
					}
					if (baseField.definition) {
						errors.push({
							code: ErrorCode.definitionNotAllowedForSpreadDictionaryField,
							message: `definition is not allowed for spread dictionary field`,
							// TODO position von definition token?
							startRowIndex: baseField.startRowIndex,
							startColumnIndex: baseField.startColumnIndex,
							endRowIndex: baseField.endRowIndex,
							endColumnIndex: baseField.endColumnIndex,
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
				// Ein Feld hat keinen eigenen Typ, geprüft wird über den Typ des ganzen Literals.
				if (typeGuard) {
					errors.push({
						code: ErrorCode.typeGuardNotAllowedForDictionaryField,
						message: 'typeGuard is not allowed for dictionary field',
						startRowIndex: typeGuard.startRowIndex,
						startColumnIndex: typeGuard.startColumnIndex,
						endRowIndex: typeGuard.endRowIndex,
						endColumnIndex: typeGuard.endColumnIndex,
					});
				}
				const value = baseField.assignedValue;
				if (!value) {
					errors.push({
						code: ErrorCode.assignedValueMissingForDictionaryField,
						message: 'assignedValue missing for singleDictionaryField',
						startRowIndex: baseField.startRowIndex,
						startColumnIndex: baseField.startColumnIndex,
						endRowIndex: baseField.endRowIndex,
						endColumnIndex: baseField.endColumnIndex,
					});
				}
				const name = baseName.type === 'reference'
					? baseName.name
					: baseName;
				const singleDictionaryField: ParseSingleDictionaryField = {
					type: 'singleDictionaryField',
					description: baseField.description,
					name: name,
					value: value,
					startRowIndex: baseField.startRowIndex,
					startColumnIndex: baseField.startColumnIndex,
					endRowIndex: baseField.endRowIndex,
					endColumnIndex: baseField.endColumnIndex,
				};
				return singleDictionaryField;
			});
		const symbols = createSymbolTable();
		fillSymbolTableWithFields(symbols, errors, fields, false);
		const dictionary: ParseDictionaryLiteral = {
			type: 'dictionary',
			fields: fields,
			symbols: symbols,
			startRowIndex: bracketedExpression.startRowIndex,
			startColumnIndex: bracketedExpression.startColumnIndex,
			endRowIndex: bracketedExpression.endRowIndex,
			endColumnIndex: bracketedExpression.endColumnIndex,
		};
		return dictionary;
	}
	const isDictionaryType = baseFields.every(baseField =>
		!baseField.definition)
		&& baseFields.some(baseField => baseField.typeGuard);
	if (isDictionaryType) {
		const fields = mapNonEmpty(
			baseFields,
			baseField => {
				if (baseField.definition) {
					errors.push({
						code: ErrorCode.definitionNotAllowedForDictionaryTypeField,
						message: `definition is not allowed for dictionaryType field`,
						// TODO position von definition token?
						startRowIndex: baseField.startRowIndex,
						startColumnIndex: baseField.startColumnIndex,
						endRowIndex: baseField.endRowIndex,
						endColumnIndex: baseField.endColumnIndex,
					});
				}
				const baseName = baseField.name;
				const typeGuard = baseField.typeGuard;
				if (baseField.spread) {
					if (typeGuard) {
						errors.push({
							code: ErrorCode.typeGuardNotAllowedForSpreadDictionaryTypeField,
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
				const name = baseName.type === 'reference'
					? baseName.name
					: baseName;
				const singleDictionaryField: ParseSingleDictionaryTypeField = {
					type: 'singleDictionaryTypeField',
					description: baseField.description,
					name: name,
					typeGuard: typeGuard,
					...(baseField.optional ? { optional: true } : {}),
					startRowIndex: baseField.startRowIndex,
					startColumnIndex: baseField.startColumnIndex,
					endRowIndex: baseField.endRowIndex,
					endColumnIndex: baseField.endColumnIndex,
				};
				return singleDictionaryField;
			});
		const symbols = createSymbolTable();
		fillSymbolTableWithFields(symbols, errors, fields, false);
		const dictionaryType: ParseDictionaryTypeLiteral = {
			type: 'dictionaryType',
			fields: fields,
			symbols: symbols,
			startRowIndex: bracketedExpression.startRowIndex,
			startColumnIndex: bracketedExpression.startColumnIndex,
			endRowIndex: bracketedExpression.endRowIndex,
			endColumnIndex: bracketedExpression.endColumnIndex,
		};
		return dictionaryType;
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
					const value = baseValueExpressionToValueExpression(baseField.name, errors);
					const spreadValue: ParseSpreadValueExpression = {
						type: 'spread',
						value: value,
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
		};
	}
	// TODO bessere Fehlermeldung
	errors.push({
		code: ErrorCode.invalidBracketedExpression,
		message: 'could not convert bracketedExpression to ValueExpression',
		startRowIndex: bracketedExpression.startRowIndex,
		startColumnIndex: bracketedExpression.startColumnIndex,
		endRowIndex: bracketedExpression.endRowIndex,
		endColumnIndex: bracketedExpression.endColumnIndex,
	});
	return bracketedExpression;
}

function getEscapableNameErrors(baseName: ParseValueExpression): CompilerError[] {
	const errors: CompilerError[] = [];
	switch (baseName.type) {
		case 'reference':
			break;
		case 'text':
			if (baseName.values.length > 1) {
				// TODO string parser combine multiline string to single token and allow multiline string for escaped name?
				errors.push({
					code: ErrorCode.escapedNameIsMultilineText,
					message: `escaped name can not be a multiline string literal`,
					startRowIndex: baseName.startRowIndex,
					startColumnIndex: baseName.startColumnIndex,
					endRowIndex: baseName.endRowIndex,
					endColumnIndex: baseName.endColumnIndex,
				});
			}
			if (baseName.values.some(value => value.type !== 'textToken')) {
				errors.push({
					code: ErrorCode.escapedNameHasInterpolation,
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
				code: ErrorCode.invalidEscapableName,
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

//#region import

function getImportedPaths(
	expressions: ParseExpression[] | undefined,
	sourceFolder: string,
	isTestFile: boolean,
): {
	dependencies: ImportedDependency[];
	errors: CompilerError[];
} {
	const dependencies: ImportedDependency[] = [];
	const errors: CompilerError[] = [];
	expressions?.forEach(expression => {
		switch (expression.type) {
			case 'functionCall':
				// import(...) wird nur als direkter Wert einer Top-Level-Definition/Destructuring
				// aufgelöst (siehe unten) - ein bloßer Aufruf ohne Zuweisung würde sonst
				// stillschweigend keine Abhängigkeit erzeugen und der Checker später lautlos auf
				// Any zurückfallen.
				if (isImportFunctionCall(expression)) {
					errors.push({
						code: ErrorCode.unsupportedImportPosition,
						message: 'import(...) is only supported as the direct value of a top-level definition or destructuring.',
						startRowIndex: expression.startRowIndex,
						startColumnIndex: expression.startColumnIndex,
						endRowIndex: expression.endRowIndex,
						endColumnIndex: expression.endColumnIndex,
					});
				}
				return;

			case 'definition':
			case 'destructuring':
				const value = expression.value;
				if (value && isImportFunctionCall(value)) {
					const { fullPath, source, error } = getPathFromImport(value, sourceFolder);
					if (error) {
						errors.push(error);
					}
					if (fullPath && source) {
						dependencies.push({ fullPath: fullPath, source: source });
						if (!isTestFile && isTestFilePath(fullPath)) {
							errors.push({
								code: ErrorCode.testFileImportedOutsideTests,
								message: 'A *.test.jul file can only be imported from another *.test.jul file.',
								...source,
							});
						}
					}
				}
				return;

			default:
				return;
		}
	});
	return {
		dependencies: dependencies,
		errors: errors,
	};
}

/**
 * Prüft die extension. Ob die Datei existiert, weiß erst der Loader (project-loader.ts) - er
 * meldet fileNotFound, der Parser bleibt frei von Dateizugriffen.
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
	/**
	 * Das Pfad-Textliteral, für Meldungen zur importierten Datei.
	 */
	source?: Positioned;
	error?: CompilerError;
} {
	if (!importExpression.arguments) {
		return {
			error: {
				code: ErrorCode.importArgumentsMissing,
				message: 'arguments missing for import',
				startRowIndex: importExpression.startRowIndex,
				startColumnIndex: importExpression.startColumnIndex,
				endRowIndex: importExpression.endRowIndex,
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
					code: ErrorCode.invalidImportExtension,
					message: `Unexpected extension for import: ${extension}`,
					startRowIndex: pathExpression.startRowIndex,
					startColumnIndex: pathExpression.startColumnIndex,
					endRowIndex: pathExpression.endRowIndex,
					endColumnIndex: pathExpression.endColumnIndex,
				}
			};
		}
		return {
			path: importedPath,
			fullPath: join(sourceFolder, importedPath),
			source: {
				startRowIndex: pathExpression.startRowIndex,
				startColumnIndex: pathExpression.startColumnIndex,
				endRowIndex: pathExpression.endRowIndex,
				endColumnIndex: pathExpression.endColumnIndex,
			},
		};
	}
	// TODO dynamische imports verbieten???
	return {
		error: {
			code: ErrorCode.dynamicImportNotAllowed,
			message: 'dynamic import not allowed',
			startRowIndex: importExpression.startRowIndex,
			startColumnIndex: importExpression.startColumnIndex,
			endRowIndex: importExpression.endRowIndex,
			endColumnIndex: importExpression.endColumnIndex,
		}
	};
}

export function getPathExpression(importParams: BracketedExpression): ParseListValue | undefined {
	switch (importParams.type) {
		case 'dictionary':
			return importParams.fields[0].value;
		case 'binding':
		case 'data':
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

export function isImportFunctionCall(expression: PositionedExpression): expression is ParseFunctionCall {
	if (expression.type !== 'functionCall') {
		return false;
	}
	const functionExpression = expression.functionExpression;
	return !!functionExpression && isImportFunction(functionExpression);
}

/**
 * Direkter Wert einer Top-Level-Definition/Destructuring - nur diese Importe sammelt
 * getImportedPaths als Abhängigkeit.
 */
export function isTopLevelImport(importExpression: ParseFunctionCall): boolean {
	const parent = importExpression.parent;
	return (parent?.type === 'definition' || parent?.type === 'destructuring')
		&& parent.value === importExpression
		&& !parent.parent;
}

export function isImportFunction(functionExpression: SimpleExpression): boolean {
	return isNamedFunction(functionExpression, 'import');
}

export function isNamedFunction(functionExpression: SimpleExpression, name: string): boolean {
	return functionExpression.type === 'reference'
		&& functionExpression.name.name === name;
}

//#endregion import