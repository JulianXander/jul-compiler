import { writeFileSync, copyFileSync, rmSync } from 'fs';
import { dirname, extname, join, resolve } from 'path';
import { webpack } from 'webpack';
import { checkParseExpressions } from './checker';
import { syntaxTreeToJs } from './emitter';
import { ParsedFile, ParseFunctionCall, ParseValueExpression } from './syntax-tree';
import { getPathFromImport } from './type-checker';
import { parseFile } from './parser';
import { ParserError } from './parser-combinator';
import { tryCreateDirectory } from './util';

const runtimeFileName = 'runtime.js';

export function compileFileToJs(
	entryFilePath: string,
	outputFolderPath: string,
): void {
	//#region 1. cleanup out
	rmSync(outputFolderPath, { recursive: true, force: true });
	//#endregion 1. cleanup out

	//#region 2. compile
	const runtimePath = resolve(join(outputFolderPath, runtimeFileName));
	const outFilePath = compileJulFileInternal({
		sourceFilePath: entryFilePath,
		outputFolderPath: outputFolderPath,
		runtimePath: runtimePath,
	});
	//#endregion 2. compile

	//#region 3. copy runtime
	const runtimeSourcePath = join(__dirname, runtimeFileName);
	copyFileSync(runtimeSourcePath, runtimePath);
	//#endregion 3. copy runtime

	//#region 4. bundle
	process.stdout.write('bundling ');
	const stopSpinner = busySpinner();
	const absoluteOutFilePath = resolve(outFilePath);
	const absoluteFolderPath = resolve(outputFolderPath);
	const bundler = webpack({
		// mode: 'none',
		entry: absoluteOutFilePath,
		output: {
			path: absoluteFolderPath,
			filename: 'bundle.js',
		},
		target: 'node',
		// resolve: {
		// 	modules: ['node_modules']
		// }
	});
	bundler.run((error, stats) => {
		// console.log(error, stats);
		const hasErrors = stats?.hasErrors();
		stopSpinner();
		if (hasErrors) {
			console.log('bundling failed');
			console.log(stats?.compilation.errors);
		}
		else {
			console.log('build finished successfully');
		}
	});
	//#endregion 4. bundle
}

interface JulCompilerOptions {
	sourceFilePath: string;
	outputFolderPath: string;
	runtimePath: string;
}

function compileJulFileInternal(
	options: JulCompilerOptions,
	compiledFilePaths?: { [key: string]: true; },
): string {
	const {
		sourceFilePath,
		outputFolderPath,
		runtimePath,
	} = options;
	console.log(`compiling ${sourceFilePath} ...`);
	if (sourceFilePath.substring(sourceFilePath.length - 4) !== '.jul') {
		throw new Error(`Invalid file ending. Expected .jul but got ${sourceFilePath}`);
	}

	//#region 1. read & 2. parse
	const parsed = parseFile(sourceFilePath);
	outputErrors(parsed.errors);
	// console.log(result);
	const syntaxTree = checkParseExpressions(parsed.expressions!)!;
	//#endregion 1. read & 2. parse

	// TODO typecheck

	//#region 3. compile
	// const interpreterFile = readFileSync('out/interpreter.js');
	// const interpreterCode = interpreterFile.toString();
	// const compiled = `${interpreterCode}
	// const compiled = `const interpreteAst = require("./interpreter").interpreteAst\nconst c = ${JSON.stringify(ast, undefined, 2)}\ninterpreteAst(c)`;
	const compiled = syntaxTreeToJs(syntaxTree, runtimePath);
	// console.log(compiled);
	//#endregion 3. compile

	//#region 4. write
	// ul von der DateiEndung abschneiden
	const jsFileName = sourceFilePath.substring(0, sourceFilePath.length - 2) + 's';
	const outFilePath = join(outputFolderPath, jsFileName);
	const outDir = dirname(outFilePath);
	tryCreateDirectory(outDir);
	writeFileSync(outFilePath, compiled);
	//#endregion 4. write

	//#region 5. compile dependencies
	// TODO check cyclic dependencies? sind cyclic dependencies erlaubt/technisch möglich/sinnvoll?
	const compiledFilePathsWithDefault = compiledFilePaths ?? { [sourceFilePath]: true };
	const importedFilePaths = getImportedPaths(parsed);
	outputErrors(importedFilePaths.errors);
	const sourceFolder = dirname(sourceFilePath);
	importedFilePaths.paths.forEach(path => {
		const fullPath = join(sourceFolder, path);
		if (compiledFilePathsWithDefault[fullPath]) {
			return;
		}
		compiledFilePathsWithDefault[fullPath] = true;
		switch (extname(path)) {
			case '.js':
			case '.json': {
				// copy js/json file to output folder
				const jsOutFilePath = join(outputFolderPath, fullPath);
				const jsOutDir = dirname(jsOutFilePath);
				tryCreateDirectory(jsOutDir);
				copyFileSync(fullPath, jsOutFilePath);
				return;
			}
			case '.jul': {
				compileJulFileInternal({
					...options,
					sourceFilePath: fullPath,
				}, compiledFilePathsWithDefault);
				return;
			}
			default:
				return;
		}
	});
	//#endregion 5. compile dependencies
	return outFilePath;
}

function outputErrors(errors: ParserError[]): void {
	if (errors.length) {
		throw new Error(JSON.stringify(errors, undefined, 2));
	}
}

function busySpinner() {
	let step = 0;
	// const characters = '⡀⠄⠂⠁⠈⠐⠠⢀';
	const characters = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
	process.stdout.write(characters[0] + ' ');
	const timer = setInterval(() => {
		step++;
		process.stdout.write(`\b\b${characters[step % characters.length]!} `);
		// move back: \x1b[1D
	}, 100);
	return () => {
		clearInterval(timer);
		process.stdout.write('\b\b  \n');
	};
}

//#region import

export function getImportedPaths(parsedFile: ParsedFile): { paths: string[], errors: ParserError[] } {
	const importedPaths: string[] = [];
	const errors: ParserError[] = [];
	parsedFile.expressions?.forEach(expression => {
		switch (expression.type) {
			case 'functionCall':
				// TODO impure imports erlauben?
				return;

			case 'definition':
			case 'destructuring':
				const value = expression.value;
				if (isImport(value)) {
					const { path, error } = getPathFromImport(value);
					if (error) {
						errors.push(error);
					}
					if (path) {
						importedPaths.push(path);
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

function isImport(expression: ParseValueExpression): expression is ParseFunctionCall {
	if (expression.type !== 'functionCall') {
		return false;
	}
	const functionReferencePath = expression.functionReference.path;
	return functionReferencePath.length === 1
		&& functionReferencePath[0].name === 'import';
}

//#endregion import