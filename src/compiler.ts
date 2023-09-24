import { writeFileSync, copyFileSync, rmSync } from 'fs';
import { dirname, extname, join, resolve } from 'path';
import webpack from 'webpack';
import { isImportFunctionCall, syntaxTreeToJs } from './emitter.js';
import { ParsedFile } from './syntax-tree.js';
import { ParsedDocuments, checkTypes, getPathFromImport } from './type-checker.js';
import { parseFile } from './parser/parser.js';
import { ParserError } from './parser/parser-combinator.js';
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
 * Gibt den outFilePath zurück bei success (nur jul/json), undefined bei error/andere Dateitypen.
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

	switch (extname(sourceFilePath)) {
		case Extension.js: {
			// copy js file to output folder
			const jsOutFilePath = join(outputFolderPath, sourceFilePath);
			const jsOutDir = dirname(jsOutFilePath);
			tryCreateDirectory(jsOutDir);
			copyFileSync(sourceFilePath, jsOutFilePath);
			break;
		}
		case Extension.json:
		// parse json and write to js in output folder
		case Extension.jul: {
			//#region 1. read & 2. parse
			const parsed = parseFile(sourceFilePath);
			//#endregion 1. read & 2. parse

			//#region 3. compile
			const expressions = parsed.expressions ?? [];
			const compiled = syntaxTreeToJs(expressions, runtimePath);
			// console.log(compiled);
			//#endregion 3. compile

			//#region 4. write
			const jsFileName = changeExtension(sourceFilePath, Extension.js);
			const outFilePath = join(outputFolderPath, jsFileName);
			const outDir = dirname(outFilePath);
			tryCreateDirectory(outDir);
			writeFileSync(outFilePath, (shebang ? '#!/usr/bin/env node\n' : '') + compiled);
			//#endregion 4. write

			//#region 5. compile dependencies
			// TODO check cyclic dependencies? sind cyclic dependencies erlaubt/technisch möglich/sinnvoll?
			compiledDocuments[sourceFilePath] = parsed;
			const sourceFolder = dirname(sourceFilePath);
			const importedFilePaths = getImportedPaths(parsed, sourceFolder);
			importedFilePaths.paths.forEach(importedPath => {
				compileFile({
					...options,
					sourceFilePath: importedPath,
				}, compiledDocuments);
			});
			//#endregion 5. compile dependencies

			//#region 6. check
			checkTypes(parsed, compiledDocuments, sourceFolder);
			outputErrors(parsed.errors);
			//#endregion 6. check
			return outFilePath;
		}
		case Extension.ts: {
			const ts = readTextFile(sourceFilePath);
			const js = transpileModule(ts, {
				compilerOptions: {
					module: ModuleKind.ESNext
				}
			});
			const jsOutFilePath = join(outputFolderPath, changeExtension(sourceFilePath, Extension.js));
			const jsOutDir = dirname(jsOutFilePath);
			tryCreateDirectory(jsOutDir);
			writeFileSync(jsOutFilePath, js.outputText);
			break;
		}
		case Extension.yaml: {
			// parse yaml and write to json in output folder
			// TODO compile
			const yaml = readTextFile(sourceFilePath);
			const parsedYaml = load(yaml);
			const json = JSON.stringify(parsedYaml);
			const jsonOutFilePath = join(outputFolderPath, sourceFilePath + Extension.json);
			const jsonOutDir = dirname(jsonOutFilePath);
			tryCreateDirectory(jsonOutDir);
			writeFileSync(jsonOutFilePath, json);
			break;
		}
		default:
			break;
	}
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