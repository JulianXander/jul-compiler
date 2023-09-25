import { writeFileSync, copyFileSync, rmSync } from 'fs';
import { dirname, extname, join, resolve } from 'path';
import webpack from 'webpack';
import { isImportFunctionCall, syntaxTreeToJs } from './emitter.js';
import { ParsedFile } from './syntax-tree.js';
import { ParsedDocuments, checkTypes, getPathFromImport } from './type-checker.js';
import { parseCode, parseFile } from './parser/parser.js';
import { ParserError } from './parser/parser-combinator.js';
import { Extension, changeExtension, executingDirectory, isValidExtension, readTextFile, tryCreateDirectory } from './util.js';
import { load } from 'js-yaml';
import typescript from 'typescript';
import ShebangPlugin from 'webpack-shebang-plugin';
const { ModuleKind, transpileModule } = typescript;

const runtimeFileName = 'runtime.js';

export function compileProject(
	entryFilePath: string,
	outputFolderPath: string,
	cli: boolean = false,
): void {
	//#region 1. cleanup out
	rmSync(outputFolderPath, { recursive: true, force: true });
	//#endregion 1. cleanup out

	//#region 2. compile
	const runtimePath = resolve(join(outputFolderPath, runtimeFileName));
	const outFilePath = compileFile({
		sourceFilePath: entryFilePath,
		outputFolderPath: outputFolderPath,
		runtimePath: runtimePath,
		shebang: cli,
	}, {});
	if (!outFilePath) {
		return;
	}
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
		optimization: {
			minimize: false
		},
		output: {
			path: absoluteFolderPath,
			filename: 'bundle.js',
		},
		plugins: [
			new ShebangPlugin(),
		],
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
	shebang: boolean;
}

/**
 * Gibt den outFilePath zurück bei success, undefined wenn schon compiled.
 */
function compileFile(
	options: JulCompilerOptions,
	compiledDocuments: ParsedDocuments,
): string | undefined {
	const {
		sourceFilePath,
		outputFolderPath,
		runtimePath,
		shebang,
	} = options;
	if (compiledDocuments[sourceFilePath]) {
		return undefined;
	}
	console.log(`compiling ${sourceFilePath} ...`);

	//#region 1. read
	const sourceCode = readTextFile(sourceFilePath);
	//#endregion 1. read

	//#region 2. parse
	const extension = extname(sourceFilePath);
	if (!isValidExtension(extension)) {
		throw new Error(`Unexpected extension for parseFile: ${extension}`);
	}
	const parsed = parseCode(sourceCode, extension);
	compiledDocuments[sourceFilePath] = parsed;
	//#endregion 2. parse

	//#region 3. compile
	let compiled;
	let outFilePath;
	switch (extension) {
		case Extension.js: {
			// copy js file to output folder
			compiled = sourceCode;
			outFilePath = join(outputFolderPath, sourceFilePath);
			break;
		}
		case Extension.json:
		// parse json and write to js in output folder
		case Extension.jul: {
			const expressions = parsed.expressions ?? [];
			compiled = syntaxTreeToJs(expressions, runtimePath);
			const jsFileName = changeExtension(sourceFilePath, Extension.js);
			outFilePath = join(outputFolderPath, jsFileName);
		}
		case Extension.ts: {
			const js = transpileModule(sourceCode, {
				compilerOptions: {
					module: ModuleKind.ESNext
				}
			});
			compiled = js.outputText;
			const jsFileName = changeExtension(sourceFilePath, Extension.js);
			outFilePath = join(outputFolderPath, jsFileName);
			break;
		}
		case Extension.yaml: {
			// parse yaml and write to json in output folder
			// TODO compile
			const parsedYaml = load(sourceCode);
			compiled = JSON.stringify(parsedYaml);
			outFilePath = join(outputFolderPath, sourceFilePath + Extension.json);
			break;
		}
		default: {
			const assertNever: never = extension;
			throw new Error(`Unexpected extension for compileFile: ${assertNever}`);
		}
	}
	//#endregion 3. compile

	//#region 4. write
	const outDir = dirname(outFilePath);
	tryCreateDirectory(outDir);
	writeFileSync(outFilePath, (shebang ? '#!/usr/bin/env node\n' : '') + compiled);
	//#endregion 4. write

	if (extension === Extension.jul) {
		//#region 5. compile dependencies
		// TODO check cyclic dependencies? sind cyclic dependencies erlaubt/technisch möglich/sinnvoll?
		const sourceFolder = dirname(sourceFilePath);
		const importedFilePaths = getImportedPaths(parsed, sourceFolder);
		importedFilePaths.paths.forEach(importedPath => {
			compileFile({
				...options,
				shebang: false,
				sourceFilePath: importedPath,
			}, compiledDocuments);
		});
		//#endregion 5. compile dependencies

		//#region 6. check
		checkTypes(parsed, compiledDocuments, sourceFolder);
		outputErrors(parsed.errors);
		//#endregion 6. check
	}
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

export function getImportedPaths(
	parsedFile: ParsedFile,
	sourceFolder: string,
): {
	paths: string[];
	errors: ParserError[];
} {
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
				if (isImportFunctionCall(value)) {
					const { fullPath, error } = getPathFromImport(value, sourceFolder);
					if (error) {
						errors.push(error);
					}
					if (fullPath) {
						importedPaths.push(fullPath);
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

//#endregion import