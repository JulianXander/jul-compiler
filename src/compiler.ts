import { writeFileSync, copyFileSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import webpack from 'webpack';
import { syntaxTreeToJs } from './emitter.js';
import { ParsedDocuments, checkTypes } from './checker.js';
import { parseCode } from './parser/parser.js';
import { Extension, changeExtension, executingDirectory, readTextFile, tryCreateDirectory } from './util.js';
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
	const { outFilePath, error } = compileFile({
		sourceFilePath: entryFilePath,
		outputFolderPath: outputFolderPath,
		runtimePath: runtimePath,
		shebang: cli,
	}, {});
	if (error) {
		console.error(error);
		process.exitCode = 1;
		return;
	}
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
			console.error(colorize('bundling failed.', ConsoleColor.lightRed));
			console.error(stats?.compilation.errors);
			process.exitCode = 1;
		}
		else {
			console.log(colorize('build finished successfully', ConsoleColor.green));
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

function compileFile(
	options: JulCompilerOptions,
	compiledDocuments: ParsedDocuments,
): {
	/**
	 * undefined wenn schon compiled und bei error.
	 */
	outFilePath?: string;
	error?: string;
} {
	const {
		sourceFilePath,
		outputFolderPath,
		runtimePath,
		shebang,
	} = options;
	if (compiledDocuments[sourceFilePath]) {
		return {};
	}
	console.log(`compiling ${sourceFilePath} ...`);

	//#region 1. read
	const sourceCode = readTextFile(sourceFilePath);
	//#endregion 1. read

	//#region 2. parse
	const parsed = parseCode(sourceCode, sourceFilePath);
	compiledDocuments[sourceFilePath] = parsed;
	const extension = parsed.extension;
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
			const expressions = parsed.unchecked.expressions ?? [];
			compiled = syntaxTreeToJs(expressions, runtimePath);
			const jsFileName = changeExtension(sourceFilePath, Extension.js);
			outFilePath = join(outputFolderPath, jsFileName);
			break;
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
			return { error: `Unexpected extension for compileFile: ${assertNever}` };
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
		const importedFilePaths = parsed.dependencies;
		if (importedFilePaths) {
			for (const importedPath of importedFilePaths) {
				const importedResult = compileFile({
					...options,
					shebang: false,
					sourceFilePath: importedPath,
				}, compiledDocuments);
				if (importedResult.error) {
					return importedResult;
				}
			}
		}
		//#endregion 5. compile dependencies

		//#region 6. check
		checkTypes(parsed, compiledDocuments);
		const errors = parsed.checked?.errors;
		if (errors?.length) {
			return {
				error: errors.map(error => {
					const errorPath = colorize(parsed.filePath, ConsoleColor.cyan);
					const errorRow = colorize(error.startRowIndex, ConsoleColor.yellow);
					const errorColumn = colorize(error.startColumnIndex, ConsoleColor.yellow);
					const errorLabel = colorize('CompilerError', ConsoleColor.lightRed);
					return `${errorPath}:${errorRow}:${errorColumn} - ${errorLabel}: ${error.message}`;
				}).join('\n'),
			};
		}
		//#endregion 6. check
	}
	return { outFilePath: outFilePath };
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

// https://askubuntu.com/questions/558280/changing-colour-of-text-and-background-of-terminal
enum ConsoleColor {
	// red = 31,
	green = 32,
	yellow = 33,
	// blue = 34,
	// purple = 35,
	cyan = 36,
	// lightGray = 37,
	// darkGrey = 90,
	lightRed = 91,
	// lightBlue = 94,
	// lightCyan = 96,
}

function colorize(text: any, color: ConsoleColor): string {
	return `\x1b[${color}m${text}\x1b[0m`;
}