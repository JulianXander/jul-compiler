import { Expression } from './abstract-syntax-tree';
import { readFileSync, writeFileSync } from 'fs';
import { parseCode } from './parser';

export function compileFileToJs(fileName: string): void {
	if (fileName.substr(fileName.length - 4, 4) !== '.jul') {
		throw new Error('Invalid file ending. Expected .jul');
	}
	const file = readFileSync(fileName);
	const code = file.toString();
	console.log(code);
	const compiled = compileCodeToJs(code);
	console.log(compiled);
	// ul von der DateiEndung abschneiden
	const jsFileName = fileName.substring(0, fileName.length - 2) + 's';
	writeFileSync(jsFileName, compiled);
}

function compileCodeToJs(code: string): string {
	try {
		const result = parseCode(code);
		if (result.errors?.length) {
			throw new Error(JSON.stringify(result.errors, undefined, 2));
		}
		console.log(result);
		const interpreterFile = readFileSync('dist/interpreter.js');
		const interpreterCode = interpreterFile.toString();
		const compiled = `${interpreterCode}
const c = ${JSON.stringify(result.parsed, undefined, 2)}
interpreteAst(c)
`;
		return compiled;
	} catch (error) {
		console.error(error);
		throw error;
	}
}

// function compileExpression(expression: Expression): string{
// 	switch (expression.type) {
// 		case 'branching':

// 			break;

// 		default:
// 			break;
// 	}
// }

//#region interfaces

//#region tokens

// type TokenType =
// 	| '('
// 	| ')'
// 	| 'space'
// 	| 'tab'
// 	| 'newline'
// 	| '='
// 	| '=>'
// 	| 'name'
// 	| 'stringLiteral'
// 	| 'numberLiteral'
// 	;

//#endregion tokens

//#endregion interfaces