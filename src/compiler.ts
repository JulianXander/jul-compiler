import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { parseCode } from './parser';
import { astToJs } from './emitter';
import { Expression, ObjectLiteral, ValueExpression } from './abstract-syntax-tree';

export function compileFileToJs(filePath: string, compiledFilePaths?: { [key: string]: true }): void {
	console.log(`compiling ${filePath} ...`);
	if (filePath.substr(filePath.length - 4, 4) !== '.jul') {
		throw new Error('Invalid file ending. Expected .jul');
	}

	//#region 1. read
	const file = readFileSync(filePath);
	const code = file.toString();
	// console.log(code);
	//#endregion 1. read

	//#region 2. parse
	const result = parseCode(code);
	if (result.errors?.length) {
		throw new Error(JSON.stringify(result.errors, undefined, 2));
	}
	// console.log(result);
	const ast = result.parsed!;
	//#endregion 2. parse

	//#region 3. compile
	// const interpreterFile = readFileSync('out/interpreter.js');
	// const interpreterCode = interpreterFile.toString();
	// const compiled = `${interpreterCode}
	// const compiled = `const interpreteAst = require("./interpreter").interpreteAst\nconst c = ${JSON.stringify(ast, undefined, 2)}\ninterpreteAst(c)`;
	const compiled = astToJs(ast);
	// console.log(compiled);
	//#endregion 3. compile

	//#region 4. write
	// ul von der DateiEndung abschneiden
	const jsFileName = filePath.substring(0, filePath.length - 2) + 's';
	writeFileSync(jsFileName, compiled);
	//#endregion 4. write

	//#region 5. compile dependencies
	// TODO check cyclic dependencies? sind cyclic dependencies erlaubt/technisch möglich/sinnvoll?
	const compiledFilePathsWithDefault = compiledFilePaths ?? { [filePath]: true };
	const importedFilePaths = getImportedPaths(ast);
	const sourceFolder = dirname(filePath);
	importedFilePaths.forEach(path => {
		const combinedPath = join(sourceFolder, path);
		if (compiledFilePathsWithDefault[combinedPath]) {
			return;
		}
		compiledFilePathsWithDefault[combinedPath] = true;
		compileFileToJs(combinedPath, compiledFilePathsWithDefault);
	});
	//#endregion 5. compile dependencies

	// copy runtime und bundling nur einmalig beim root call (ohne compiledFilePaths)
	if (!compiledFilePaths) {
		//#region 6. copy runtime
		copyFileSync('out/runtime.js', sourceFolder + '/runtime.js')
		//#endregion 6. copy runtime

		//#region 7. bundle
		console.log('bundling ...')
		// TODO bundling
		//#endregion 7. bundle
	}

}

function getImportedPaths(ast: Expression[]): string[] {
	const importedPaths: string[] = [];
	ast.forEach(expression => {
		switch (expression.type) {
			case 'functionCall':
				// TODO impure imports erlauben?
				return;

			case 'definition':
			case 'destructuring':
				const value = expression.value;
				if (value.type === 'functionCall'
					&& value.functionReference.length === 1
					&& value.functionReference[0] === 'import') {
					const pathExpression = getPathExpression(value.params);
					if (pathExpression.type === 'string'
						&& pathExpression.values.length === 1
						&& pathExpression.values[0]!.type === 'stringToken') {
						const importedPath = pathExpression.values[0].value;
						importedPaths.push(importedPath);
					}
					// TODO dynamische imports verbieten???
				}
				return;

			default:
				return;
		}
	});
	return importedPaths;
}

function getPathExpression(importParams: ObjectLiteral): ValueExpression {
	switch (importParams.type) {
		case 'dictionary':
			return importParams.values[0].value;

		case 'empty':
			throw new Error('import can not be called without arguments');

		case 'list':
			return importParams.values[0];

		default: {
			const assertNever: never = importParams;
			throw new Error(`Unexpected importParams.type: ${(assertNever as ObjectLiteral).type}`);
		}
	}
}