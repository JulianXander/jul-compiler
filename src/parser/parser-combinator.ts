// Abstrakte Parser Library
export type Parser<T> = (
	rows: string[],
	startRowIndex: number,
	startColumnIndex: number,
	indent: number,
) => ParserResult<T>;

export interface ParserResult<T> {
	/**
	 * Gibt an, ob etwas geparst wurde.
	 * Es kann trotzdem errors geben.
	 */
	hasParsed: boolean;
	parsed?: T;
	endRowIndex: number;
	endColumnIndex: number;
	errors?: ParserError[];
}

export interface ParserError extends Positioned {
	message: string;
	// TODO isFatal?
	// TODO type: 'semantic'? | 'syntax' | 'type';?
	// TODO id/number/code: number;?
}

export interface Positioned {
	startRowIndex: number;
	startColumnIndex: number;
	endRowIndex: number;
	endColumnIndex: number;
}

//#region Errors

export function endOfCodeError(searched: string): string {
	return `End of code reached while looking for ${searched}`;
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

type Parsers<T extends any[]> = { [k in keyof T]: Parser<T[k]> };
// type OptionalTuple<T extends any[]> = { [k in keyof T]?: T[k] }

export function choiceParser<T extends any[]>(...parsers: Parsers<T>): Parser<T[number]> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		for (const parser of parsers) {
			const result = parser(rows, startRowIndex, startColumnIndex, indent);
			if (result.hasParsed) {
				return result;
			}
		}
		return {
			hasParsed: false,
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: [{
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				// TODO end indices
				endRowIndex: startRowIndex,
				endColumnIndex: startColumnIndex,
				message: `Expected one of: ${parsers.map(parser => parser.name).join(',')}`
			}],
		};
	};
}

type ParserChoices<T extends any[]> = {
	[k in keyof T]: {
		predicate: Parser<any>;
		parser: Parser<T[k]>;
	}
};

/**
 * Im Gegensatz zum choiceParser, der bei erfolglosem Parsen den nächsten parser versucht,
 * bricht der discriminatedChoiceParser ab, sobald das erste predicate passt.
 */
export function discriminatedChoiceParser<T extends any[]>(
	...choices: ParserChoices<T>
): Parser<T[number]> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		for (const { predicate, parser } of choices) {
			const predicateResult = predicate(rows, startRowIndex, startColumnIndex, indent);
			if (predicateResult.hasParsed) {
				const parserResult = parser(rows, startRowIndex, startColumnIndex, indent);
				return parserResult;
			}
		}

		return {
			hasParsed: false,
			endRowIndex: startRowIndex,
			endColumnIndex: startColumnIndex,
			errors: [{
				startRowIndex: startRowIndex,
				startColumnIndex: startColumnIndex,
				// TODO end indices
				endRowIndex: startRowIndex,
				endColumnIndex: startColumnIndex,
				message: `Expected one of: ${choices.map(({ parser }) => parser.name).join(',')}`
			}],
		};
	};
}

/**
 * Parst alles oder nichts.
 */
export function sequenceParser<T extends any[]>(...parsers: Parsers<T>): Parser<T> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		const parsed: any[] = [];
		const errors: ParserError[] = [];
		let rowIndex = startRowIndex;
		let columnIndex = startColumnIndex;
		for (const parser of parsers) {
			// nicht abbrechen bei end of code, denn die folgenden parser könnten optional sein
			// wenn sie nicht optional sind, dann liefern sie eh direkt Fehler
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
			const result = parser(rows, rowIndex, columnIndex, indent);
			rowIndex = result.endRowIndex;
			columnIndex = result.endColumnIndex;
			if (!result.hasParsed) {
				// errors.push(...result.errors)
				return {
					hasParsed: false,
					endRowIndex: rowIndex,
					endColumnIndex: columnIndex,
					errors: result.errors,
				};
			}
			parsed.push(result.parsed);
		}
		return {
			hasParsed: true,
			endRowIndex: rowIndex,
			endColumnIndex: columnIndex,
			errors: errors,
			parsed: parsed as any
		};
	};
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
						hasParsed: true,
						endRowIndex: rowIndex,
						endColumnIndex: columnIndex,
						parsed: parsed,
					};
				}
				else {
					return {
						hasParsed: false,
						endRowIndex: rowIndex,
						endColumnIndex: columnIndex,
						errors: [{
							startRowIndex: rowIndex,
							startColumnIndex: columnIndex,
							endRowIndex: rowIndex,
							endColumnIndex: columnIndex,
							message: endOfCodeError(parser.name),
						}],
					};
				}
			}
			const result = parser(rows, rowIndex, columnIndex, indent);
			if (!result.hasParsed) {
				if (count >= minOccurs) {
					return {
						hasParsed: true,
						endRowIndex: rowIndex,
						endColumnIndex: columnIndex,
						parsed: parsed,
					};
				}
				else {
					return {
						hasParsed: false,
						// TODO endIndizes hier aus error result nehmen? (Indizes enthalten hier noch die Werte vor dem Fehler)
						endRowIndex: rowIndex,
						endColumnIndex: columnIndex,
						errors: result.errors,
					};
				}
			}
			rowIndex = result.endRowIndex;
			columnIndex = result.endColumnIndex;
			parsed.push(result.parsed!);
		}
		return {
			hasParsed: true,
			endRowIndex: rowIndex,
			endColumnIndex: columnIndex,
			parsed: parsed
		};
	};
}

export function mapParser<T, U>(parser: Parser<T>, transform: (x: T | undefined) => U | undefined): Parser<U> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		const result = parser(rows, startRowIndex, startColumnIndex, indent);
		return {
			...result,
			parsed: transform(result.parsed),
		};
	};
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
		hasParsed: true,
		endRowIndex: startRowIndex,
		endColumnIndex: startColumnIndex,
	};
}

export function tokenParser(token: string): Parser<undefined> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
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
						message: endOfCodeError(token)
					}]
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
						message: `Unexpected character: ${codeChar} while looking for: ${token}`
					}]
				};
			}
		}
		// Success
		const endColumnIndex = startColumnIndex + token.length;
		return {
			hasParsed: true,
			endRowIndex: startRowIndex,
			endColumnIndex: endColumnIndex,
		};
	};
}

/**
 * Achtung: regex muss y (sticky) flag haben!
 */
export function regexParser(regex: RegExp, errorMessage: string): Parser<string> {
	return (rows, startRowIndex, startColumnIndex, indent) => {
		regex.lastIndex = startColumnIndex;
		const row = rows[startRowIndex];
		if (row === undefined) {
			// throw new Error('Can not match regex at end of code');
			return {
				hasParsed: false,
				endRowIndex: startRowIndex,
				endColumnIndex: startColumnIndex,
				errors: [{
					startRowIndex: startRowIndex,
					startColumnIndex: startColumnIndex,
					endRowIndex: startRowIndex,
					endColumnIndex: startColumnIndex,
					message: 'Can not match regex at end of code',
				}],
			};
		}
		const match = regex.exec(row);
		if (!match) {
			return {
				hasParsed: false,
				endRowIndex: startRowIndex,
				endColumnIndex: startColumnIndex,
				errors: [{
					startRowIndex: startRowIndex,
					startColumnIndex: startColumnIndex,
					endRowIndex: startRowIndex,
					endColumnIndex: startColumnIndex,
					message: errorMessage,
				}],
			};
		}
		// Success
		const value = match[0]!;
		const endColumnIndex = startColumnIndex + value.length;
		return {
			hasParsed: true,
			endRowIndex: startRowIndex,
			endColumnIndex: endColumnIndex,
			parsed: value,
		};
	};
}

//#endregion primitives