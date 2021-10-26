import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { webpack } from 'webpack';
import { parseCode } from './parser';
import { astToJs, getPathFromImport, isImport } from './emitter';
import { Expression } from './abstract-syntax-tree';

export function compileFileToJs(filePath: string, compiledFilePaths?: { [key: string]: true }): void {
	console.log(`compiling ${filePath} ...`);
	if (filePath.substr(filePath.length - 4) !== '.jul') {
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
					&& isImport(value.functionReference)) {
					const path = getPathFromImport(value);
					importedPaths.push(path + '.jul');
				}
				return;

			default:
				return;
		}
	});
	return importedPaths;
}