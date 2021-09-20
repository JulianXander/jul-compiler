// Abstrake Parser Library
export type Parser<T> = (
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
) => ParserResult<T>;

export interface ParserResult<T> {
	parsed?: T;
	endRowIndex: number;
	endColumnIndex: number;
	errors?: ParserError[];
}

export interface ParserError {
	rowIndex: number;
	columnIndex: number;
	message: string;
	// TODO isFatal?
}

//#region Errors

export function endOfCodeError(searched: string): string {
	return `End of code reached while looking for ${searched}`
}

//#endregion Errors

//#region combinators

export function incrementIndent<T>(parser: Parser<T>): Parser<T> {
	return (rows, startRowIndex, startColumnIndex, indent) =>
		parser(rows, startRowIndex, startColumnIndex, indent + 1);
}

export function moveColumnIndex<T>(indexDelta: number, parser: Parser<T>): Parser<T> {
	return (rows, startRowIndex, startColumnIndex, indent) =>
		parser(rows, startRowIndex, startColumnIndex + indexDelta, indent);
}

export function moveToNextLine<T>(parser: Parser<T>): Parser<T> {
	return (rows, startRowIndex, startColumnIndex, indent) =>
		parser(rows, startRowIndex + 1, 0, indent);
}

type Parsers<T extends any[]> = { [k in keyof T]: Parser<T[k]> }
// type OptionalTuple<T extends any[]> = { [k in keyof T]?: T[k] }

export function choiceParser<T extends any[]>(...parsers: Parsers<T>): Parser<T[number]> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		for (const parser of parsers) {
			const result = parser(rows, startRowIndex, startColumnIndex, indent)
			if (!result.errors?.length) {
				return result;
			}
		}
		return {
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: [{
				rowIndex: startRowIndex,
				columnIndex: startColumnIndex,
				message: `Expected one of: ${parsers.map(parser => parser.name).join(',')}`
			}],
		}
	}
}

type ParserChoices<T extends any[]> = {
	[k in keyof T]: {
		predicate: Parser<any>;
		parser: Parser<T[k]>;
	}
}

export function discriminatedChoiceParser<T extends any[], U = never>(
	choices: ParserChoices<T>,
	restParser?: Parser<U>,
): Parser<T[number] | U> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		// const char = code[startIndex];
		for (const { predicate, parser } of choices) {
			const predicateResult = predicate(rows, startRowIndex, startColumnIndex, indent);
			if (!predicateResult.errors?.length) {
				const parserResult = parser(rows, startRowIndex, startColumnIndex, indent)
				return parserResult;
			}
		}

		if (restParser) {
			const restParserResult = restParser(rows, startRowIndex, startColumnIndex, indent);
			return restParserResult;
		}

		return {
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: [{
				rowIndex: startRowIndex,
				columnIndex: startColumnIndex,
				message: `Expected one of: ${choices.map(({ parser }) => parser.name).join(',')}`
			}],
		}
	}
}

export function sequenceParser<T extends any[]>(...parsers: Parsers<T>): Parser<T> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		const parsed: (T | undefined)[] = [];
		const errors: ParserError[] = [];
		let rowIndex = startRowIndex;
		let columnIndex = startColumnIndex;
		for (const parser of parsers) {
			// nicht abbrechen bei end of code, denn die folgenden parser könnten optional sein
			// wenn sie nicht optional sind, dann liefern sie eh direkt fehler
			// TODO bei allen parsern abbruchbedingung end of code einbauen!
			// if (index >= code.length) {
			// 	return {
			// 		endIndex: index,
			// 		errors: [{
			// 			index: index,
			// 			message: `End of code reached while looking for ${parser.name}`
			// 		}],
			// 	}
			// }
			const result = parser(rows, rowIndex, columnIndex, indent)
			rowIndex = result.endRowIndex;
			columnIndex = result.endColumnIndex;
			if (result.errors?.length) {
				// errors.push(...result.errors)
				return {
					endRowIndex: rowIndex,
					endColumnIndex: columnIndex,
					errors: result.errors,
				}
			}
			parsed.push(result.parsed);
		}
		return {
			endRowIndex: rowIndex,
			endColumnIndex: columnIndex,
			errors: errors,
			parsed: parsed as any
		}
	}
}

export function multiplicationParser<T>(
	minOccurs: number,
	maxOccurs: number | undefined,
	parser: Parser<T>,
): Parser<T[]> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		const parsed: T[] = [];
		let rowIndex = startRowIndex;
		let columnIndex = startColumnIndex;
		for (let count = 0; maxOccurs === undefined || count < maxOccurs; count++) {
			if (rowIndex >= rows.length) {
				if (count >= minOccurs) {
					return {
						endRowIndex: rowIndex,
						endColumnIndex: columnIndex,
						parsed: parsed,
					}
				}
				else {
					return {
						endRowIndex: rowIndex,
						endColumnIndex: columnIndex,
						errors: [{
							rowIndex: rowIndex,
							columnIndex: columnIndex,
							message: endOfCodeError(parser.name)
						}],
					}
				}
			}
			const result = parser(rows, rowIndex, columnIndex, indent)
			if (result.errors?.length) {
				if (count >= minOccurs) {
					return {
						endRowIndex: rowIndex,
						endColumnIndex: columnIndex,
						parsed: parsed,
					}
				}
				else {
					return {
						// TODO endIndizes hier aus error result nehmen? (indizes enthalten hier noch die werte vor dem Fehler)
						endRowIndex: rowIndex,
						endColumnIndex: columnIndex,
						errors: result.errors,
					}
				}
			}
			rowIndex = result.endRowIndex;
			columnIndex = result.endColumnIndex;
			parsed.push(result.parsed!);
		}
		return {
			endRowIndex: rowIndex,
			endColumnIndex: columnIndex,
			parsed: parsed
		}
	}
}

export function mapParser<T, U>(parser: Parser<T>, transform: (x: T) => U): Parser<U> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		const result = parser(rows, startRowIndex, startColumnIndex, indent);
		return {
			endRowIndex: result.endRowIndex,
			endColumnIndex: result.endColumnIndex,
			errors: result.errors,
			parsed: result.parsed === undefined
				? undefined
				: transform(result.parsed),
		}
	}
}

//#endregion combinators

//#region primitives

export function emptyParser(
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
): ParserResult<undefined> {
	return {
		endRowIndex: startRowIndex,
		endColumnIndex: startColumnIndex,
	}
}

export function tokenParser(token: string): Parser<undefined> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		const row = rows[startRowIndex];
		if (row === undefined) {
			// throw new Error('Can not parse token at end of code');
			return {
				endRowIndex: startRowIndex,
				endColumnIndex: startColumnIndex,
				errors: [{
					message: 'Can not match token at end of code',
					rowIndex: startRowIndex,
					columnIndex: startColumnIndex
				}],
			}
		}
		for (let tokenIndex = 0; tokenIndex < token.length; tokenIndex++) {
			const tokenChar = token[tokenIndex];
			const columnIndex = tokenIndex + startColumnIndex;
			const codeChar = row[columnIndex];
			if (!codeChar) {
				return {
					endRowIndex: startRowIndex,
					endColumnIndex: columnIndex,
					errors: [{
						rowIndex: startRowIndex,
						columnIndex: columnIndex,
						message: endOfCodeError(token)
					}]
				}
			}
			if (codeChar !== tokenChar) {
				return {
					endRowIndex: startRowIndex,
					endColumnIndex: columnIndex,
					errors: [{
						rowIndex: startRowIndex,
						columnIndex: columnIndex,
						message: `Unexpected character: ${codeChar} while looking for: ${token}`
					}]
				}
			}
		}
		// Success
		const endColumnIndex = startColumnIndex + token.length;
		// if (endColumnIndex >= row.length) {
		// 	// Ende der Zeile erreicht => gehe in die nächste Zeile
		// 	return {
		// 		endRowIndex: startRowIndex + 1,
		// 		endColumnIndex: 0,
		// 	}
		// }
		return {
			endRowIndex: startRowIndex,
			endColumnIndex: endColumnIndex,
		}
	}
}

/**
 * Achtung: regex muss g flag haben!
 */
export function regexParser(regex: RegExp, errorMessage: string): Parser<string> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		regex.lastIndex = startColumnIndex;
		const row = rows[startRowIndex];
		if (row === undefined) {
			// throw new Error('Can not match regex at end of code');
			return {
				endRowIndex: startRowIndex,
				endColumnIndex: startColumnIndex,
				errors: [{
					message: 'Can not match regex at end of code',
					rowIndex: startRowIndex,
					columnIndex: startColumnIndex
				}],
			}
		}
		const match = regex.exec(row);
		if (!match || match.index !== startColumnIndex) {
			return {
				endRowIndex: startRowIndex,
				endColumnIndex: startColumnIndex,
				errors: [{
					message: errorMessage,
					rowIndex: startRowIndex,
					columnIndex: startColumnIndex
				}],
			}
		}
		// Success
		const value = match[0]!
		const endColumnIndex = startColumnIndex + value.length;
		// if (endColumnIndex >= row.length) {
		// 	// Ende der Zeile erreicht => gehe in die nächste Zeile
		// 	return {
		// 		endRowIndex: startRowIndex + 1,
		// 		endColumnIndex: 0,
		// 		parsed: value,
		// 	}
		// }
		return {
			endRowIndex: startRowIndex,
			endColumnIndex: endColumnIndex,
			parsed: value,
		}
	}
}

//#endregion primitives