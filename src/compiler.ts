import { writeFileSync, copyFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { webpack } from 'webpack';
import { checkParseExpressions } from './checker';
import { syntaxTreeToJs } from './emitter';
import { parseFile } from './parser';
import { BracketedExpression, CheckedExpression, ParsedFile, ParseFunctionCall, ParseValueExpression } from './syntax-tree';
import { getPathFromImport } from './type-checker';

export function compileFileToJs(filePath: string, compiledFilePaths?: { [key: string]: true; }): void {
	console.log(`compiling ${filePath} ...`);
	if (filePath.substring(filePath.length - 4) !== '.jul') {
		throw new Error('Invalid file ending. Expected .jul');
	}

	//#region 1. read & 2. parse
	const parsed = parseFile(filePath);
	if (parsed.errors.length) {
		throw new Error(JSON.stringify(parsed.errors, undefined, 2));
	}
	// console.log(result);
	const syntaxTree = checkParseExpressions(parsed.expressions!)!;
	//#endregion 1. read & 2. parse

	// TODO typecheck

	//#region 3. compile
	// const interpreterFile = readFileSync('out/interpreter.js');
	// const interpreterCode = interpreterFile.toString();
	// const compiled = `${interpreterCode}
	// const compiled = `const interpreteAst = require("./interpreter").interpreteAst\nconst c = ${JSON.stringify(ast, undefined, 2)}\ninterpreteAst(c)`;
	const compiled = syntaxTreeToJs(syntaxTree);
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
	const importedFilePaths = getImportedPaths(parsed);
	const sourceFolder = dirname(filePath);
	importedFilePaths.forEach(path => {
		const fullPath = join(sourceFolder, path);
		if (compiledFilePathsWithDefault[fullPath]) {
			return;
		}
		compiledFilePathsWithDefault[fullPath] = true;
		compileFileToJs(fullPath, compiledFilePathsWithDefault);
	});
	//#endregion 5. compile dependencies

	// copy runtime und bundling nur einmalig beim root call (ohne compiledFilePaths)
	if (!compiledFilePaths) {
		//#region 6. copy runtime
		copyFileSync('out/runtime.js', sourceFolder + '/runtime.js');
		//#endregion 6. copy runtime

		//#region 7. bundle
		console.log('bundling ...');
		// const absoulteJsPath = resolve(jsFileName);
		const absoulteFolderPath = resolve(sourceFolder);
		const bundler = webpack({
			mode: 'none',
			entry: jsFileName,
			output: {
				path: absoulteFolderPath,
				filename: 'bundle.js',
			}
		});
		bundler.run((error, stats) => {
			// console.log(error, stats);
			console.log('done');
		});
		//#endregion 7. bundle
	}

}

//#region import

export function getImportedPaths(parsedFile: ParsedFile): string[] {
	const importedPaths: string[] = [];
	parsedFile.expressions?.forEach(expression => {
		switch (expression.type) {
			case 'functionCall':
				// TODO impure imports erlauben?
				return;

			case 'definition':
			case 'destructuring':
				const value = expression.value;
				if (isImport(value)) {
					const path = getPathFromImport(value);
					if (path) {
						importedPaths.push(path);
					}
				}
				return;

			default:
				return;
		}
	});
	return importedPaths;
}

function isImport(expression: ParseValueExpression): expression is ParseFunctionCall {
	if (expression.type !== 'functionCall') {
		return false;
	}
	const functionReferencePath = expression.functionReference.path;
	return functionReferencePath.length === 1
		&& functionReferencePath[0].name === 'import';
}

//#endregion import