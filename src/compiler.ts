import { writeFileSync, copyFileSync, rmSync } from 'fs';
import { dirname, extname, join, resolve } from 'path';
import webpack from 'webpack';
import { checkParseExpressions } from './checker.js';
import { syntaxTreeToJs } from './emitter.js';
import { ParsedFile, ParseFunctionCall, ParseValueExpression } from './syntax-tree.js';
import { getPathFromImport } from './type-checker.js';
import { parseJulFile } from './parser/parser.js';
import { ParserError } from './parser/parser-combinator.js';
import { Extension, changeExtension, executingDirectory, readTextFile, tryCreateDirectory } from './util.js';
import { load } from 'js-yaml';
import typescript from 'typescript';
const { ModuleKind, transpileModule } = typescript;

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
	const runtimeSourcePath = join(executingDirectory, runtimeFileName);
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
		// optimization: {
		// 	minimize: false
		// },
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
	if (!sourceFilePath.endsWith(Extension.jul)) {
		throw new Error(`Invalid file ending. Expected .jul but got ${sourceFilePath}`);
	}

	//#region 1. read & 2. parse
	const parsed = parseJulFile(sourceFilePath);
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
	const jsFileName = changeExtension(sourceFilePath, Extension.js);
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
			case Extension.js:
			case Extension.json: {
				// copy js/json file to output folder
				const jsOutFilePath = join(outputFolderPath, fullPath);
				const jsOutDir = dirname(jsOutFilePath);
				tryCreateDirectory(jsOutDir);
				copyFileSync(fullPath, jsOutFilePath);
				return;
			}
			case Extension.jul: {
				compileJulFileInternal({
					...options,
					sourceFilePath: fullPath,
				}, compiledFilePathsWithDefault);
				return;
			}
			case Extension.ts: {
				const ts = readTextFile(fullPath);
				const js = transpileModule(ts, {
					compilerOptions: {
						module: ModuleKind.ESNext
					}
				});
				const jsOutFilePath = join(outputFolderPath, changeExtension(fullPath, Extension.js));
				const jsOutDir = dirname(jsOutFilePath);
				tryCreateDirectory(jsOutDir);
				writeFileSync(jsOutFilePath, js.outputText);
				return;
			}
			case Extension.yaml: {
				// parse yaml and write to json in output folder
				const yaml = readTextFile(fullPath);
				const parsedYaml = load(yaml);
				const json = JSON.stringify(parsedYaml);
				const jsonOutFilePath = join(outputFolderPath, fullPath + Extension.json);
				const jsonOutDir = dirname(jsonOutFilePath);
				tryCreateDirectory(jsonOutDir);
				writeFileSync(jsonOutFilePath, json);
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
	const functionExpression = expression.functionExpression;
	return functionExpression.type === 'reference'
		&& functionExpression.name.name === 'import';
}

//#endregion import