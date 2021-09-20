import { ExpressionList, StringLiteral, Name, Expression, FunctionDeclaration, JulSyntaxTree, NumberLiteral } from './syntax-tree';

export function parseJst(code: string): JulSyntaxTree
{
	// const compiledExressions: JulExpression[] = [];
	// const errors: string[] = [];
	// TODO parse imports?
	const parserResult = parseExpressionBlock(code, 0, 0);

	return {
		expressions: parserResult.parsed?.expressions,
		errors: parserResult.errors,
	};
}

// TODO Kommentare als Expression speichern für Intellisense doc comments?
function parseComment(code: string, startIndex: number): ParserResult<undefined>
{
	const lineEndIndex = code.indexOf('\n', startIndex);
	// Kommentar, rest der Zeile verwerfen
	return {
		endIndex: lineEndIndex + 1,
	};
}

function parseNumberLiteral(code: string, startIndex: number): ParserResult<NumberLiteral>
{
	const numberRegex = /-?[0-9]+(.[0-9]+)?/;
	numberRegex.lastIndex = startIndex - 1;
	const match = numberRegex.exec(code);
	if (!match || match.index !== startIndex)
	{
		return {
			errors: ['not a valid number'],
			endIndex: startIndex + 1,
		}
	}
	const valueString = match[0];
	const valueNumber = +valueString;
	return {
		parsed: {
			type: 'numberLiteral',
			value: valueNumber
		},
		endIndex: startIndex + valueString.length,
	}
}

function parseStringLiteral(code: string, startIndex: number): ParserResult<StringLiteral>
{
	let value = '';
	for (let index = startIndex; index < code.length; index++)
	{
		const char = code[index];
		switch (char)
		{
			case '\'':
				const nextChar = code[index + 1];
				if (nextChar == '\'')
				{
					// escaptes '
					value += char;
					index++;
					break;
				}
				// string zuende
				return {
					endIndex: index + 1,
					parsed: {
						type: 'stringLiteral',
						value: value,
					},
				};

			default:
				value += char;
				break;
		}
	}
	// Compiler Error End of File reached, string not terminated
	return {
		endIndex: code.length,
		errors: ['End of File reached, string not terminated']
	};
}

function parseName(firstChar: string, code: string, startIndex: number): ParserResult<Name>
{
	let value = firstChar;
	for (let index = startIndex; index < code.length; index++)
	{
		const char = code[index];
		switch (char)
		{
			case ' ':
			case '\t':
			case '\n':
			case '(':
			case ')':
			case '.':
			case '=':
				// Name zuende
				return {
					endIndex: index,
					parsed: {
						type: 'name',
						value: value,
					},
				};

			default:
				value += char;
				break;
		}
	}
	// End of File reached, Name zuende
	return {
		endIndex: code.length,
		parsed: {
			type: 'name',
			value: value,
		},
	};
}

// TODO tryParseIndent, liefere anzahl parsedIndents
function parseIndent(code: string, startIndex: number, indent: number): ParserResult<number>
{
	let parsedIndents = 0;
	for (let index = startIndex; index < startIndex + indent; index++)
	{
		const char = code[index];
		switch (char)
		{
			case undefined:
				// TODO empty line mit indent?
				// End of File reached, ) not found => Compiler Error
				return {
					endIndex: code.length,
					parsed: parsedIndents,
					errors: ['End of file reached. Missing token )']
				};

			case '\t':
				parsedIndents++;
				continue;

			default:
				// TODO Error: indent missing? end of stament block?
				return {
					endIndex: index + 1,
					parsed: parsedIndents,
					errors: [`Missing indent. Unexpected token ${char}`],
				};
		}
	}
	return {
		endIndex: startIndex + indent,
		parsed: indent,
	};
}

// function parseObjectLiteral(code: string, startIndex: number, indent: number): ParserResult<ObjectLiteral>
// {
// 	// TODO
// 	return null as any;
// }

function parseFunctionOrObject(code: string, startIndex: number, indent: number): ParserResult<FunctionDeclaration | ExpressionList>//ObjectLiteral>
{
	const expressionListResult = parseExpressionList(code, startIndex, indent);
	// wenn =>: function, parse function body(Expression/expressionBlock)
	// wenn nicht: return expressionList als Object
	if (expressionListResult.endIndex + 3 < code.length)
	{
		return expressionListResult;
	}
	const possibleArrow = code.substr(expressionListResult.endIndex, 3);
	if (possibleArrow !== ' =>')
	{
		return expressionListResult;
	}
	const functionBodyResult = parseExpressionBlock(code, expressionListResult.endIndex + 4, indent + 1);
	return {
		endIndex: functionBodyResult.endIndex,
		errors: [
			...(expressionListResult.errors ?? []),
			...(functionBodyResult.errors ?? []),
		],
		parsed: {
			type: 'functionDecalaration',
			body: functionBodyResult.parsed?.expressions,
			params: expressionListResult.parsed?.expressions,
		}
	}
}

function parseExpressionList(code: string, startIndex: number, indent: number): ParserResult<ExpressionList>
{
	const expressions: Expression[] = [];
	const errors: string[] = [];
	for (let index = startIndex; index < code.length; index++)
	{
		const char = code[index];
		switch (char)
		{
			case ')':
				// Liste zuende
				return {
					endIndex: index + 1,
					parsed: {
						type: 'expressionList',
						expressions: expressions,
					},
					errors: errors,
				};

			case '\n': {
				// Leerzeile/indent+Expression (continue)
				const nextChar = code[index + 1];
				switch (nextChar)
				{
					case '\n':
						// Leerzeile
						continue;

					default:
						const indentResult = parseIndent(code, index + 1, indent + 1);
						if (indentResult.errors?.length)
						{
							errors.push(...indentResult.errors);
						}
						index = indentResult.endIndex - 1; // - 1, da for Schleife danach wieder inkrementiert
						continue;
				}
			}

			default: {
				// parse expression => Separator/Ende
				const subExpressionResult = parseExpression(code, index, indent);
				if (subExpressionResult.parsed)
				{
					expressions.push(subExpressionResult.parsed);
				}
				index = subExpressionResult.endIndex;
				// Separator/Ende
				const nextChar = code[index];
				switch (nextChar)
				{
					case ' ':
						continue;

					case '\n':
						// newline nochmal parsen im nächsten Schleifendurchlauf
						index--;
						continue;

					case ')':
						return {
							endIndex: index + 1,
							parsed: {
								type: 'expressionList',
								expressions: expressions,
							},
							errors: errors,
						};

					default:
						// TODO error, skip to end of line?
						continue;
				}
			}
		}
	}
	// End of File reached, ) not found => Compiler Error
	return {
		endIndex: code.length,
		errors: ['End of file reached. Missing token )']
	};
}

// TODO parseObjectDerference
// TODO parseDestructuringAssignment

function parseExpression(code: string, startIndex: number, indent: number): ParserResult<Expression | undefined>
{
	const char = code[startIndex];
	if (/[a-zA-Z]/.test(char))
	{
		// Derefernzierung/Funktionsaufruf/Zuweisung
		const nameResult = parseName(char, code, startIndex + 1);
		if (nameResult.errors?.length)
		{
			// TODO mit der zeile weiter machen?
			return nameResult;
		}
		const nextChar = code[nameResult.endIndex];
		switch (nextChar)
		{
			case '(':
				// Funktionsaufruf
				// const paramsResult = parseObjectLiteral(code, nameResult.endIndex, indent);
				const paramsResult = parseExpressionList(code, nameResult.endIndex + 1, indent);
				if (paramsResult.errors?.length)
				{
					return paramsResult;
				}
				return {
					endIndex: paramsResult.endIndex,
					parsed: {
						type: 'functionCall',
						functionReference: nameResult.parsed!,
						params: paramsResult.parsed!,
					}
				};

			case ' ':
				// Zuweisung
				const possibleEquals = code.substr(nameResult.endIndex + 1, 2);
				if (possibleEquals !== '= ')
				{
					// Error
					// TODO mit der zeile weiter machen?
				}
				const assignmentValueResult = parseExpression(code, nameResult.endIndex + 3, indent);
				return {
					endIndex: assignmentValueResult.endIndex,
					errors: assignmentValueResult.errors, // TODO check assgnment value, wenn fehlt error
					parsed: {
						type: 'assignment',
						name: nameResult.parsed!.value,
						value: assignmentValueResult.parsed,
					}
				};

			case '.':
				// Derefernzierung
				// TODO kann auch Funktionsaufruf sein
				break;

			case '\n':
				// Ende
				return nameResult;

			default:
				// TODO unexpected token
				break;
		}
	}
	if (/[-0-9]/.test(char))
	{
		return parseNumberLiteral(code, startIndex);
	}
	switch (char)
	{
		case '#':
			return parseComment(code, startIndex + 1);

		case '\'':
			return parseStringLiteral(code, startIndex + 1);

		case '(':
			// TODO Destructuring Zuweisung
			return parseFunctionOrObject(code, startIndex + 1, indent);

		default:
			// Compiler Error: unexpected token
			return {
				errors: [`Unexpected token ${char}`],
				endIndex: startIndex + 1,
			};
	}
}

function parseExpressionBlock(code: string, startIndex: number, indent: number): ParserResult<ExpressionList>
{
	const expressions: Expression[] = [];
	const errors: string[] = [];
	for (let index = startIndex; index < code.length; index++)
	{
		const char = code[index];
		switch (char)
		{
			case '\n':
				// Leerzeile (continue)
				continue;

			default:
				// try parse indent + expression + newline
				// wenn indent zu klein: ende
				const indentParserResult = parseIndent(code, index, indent);
				index = indentParserResult.endIndex;
				if (indentParserResult.errors)
				{
					errors.push(...indentParserResult.errors)
				}
				if (indentParserResult.parsed === indent)
				{
					const expressionResult = parseExpression(code, index, indent)
					index = expressionResult.endIndex;
					if (expressionResult.errors)
					{
						errors.push(...expressionResult.errors)
					}
					if (expressionResult.parsed)
					{
						expressions.push(expressionResult.parsed)
					}
				}
				else
				{
					// TODO skip to end of line?
				}
				continue;
		}
	}
	// End of File reached, done
	return {
		endIndex: code.length,
		parsed: {
			type: 'expressionList',
			expressions: expressions,
		},
	};
}