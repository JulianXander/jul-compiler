#!/usr/bin/env node
import { Ajv } from 'ajv';
import { load } from 'js-yaml';
import { dirname, join } from 'path';
import { compileProject, testProject } from './compiler.js';
import configSchema from './jul-config-schema.json' with { type: 'json' };
import { executingDirectory, readTextFile } from './util.js';

interface JulCompilerConfiguration {
	entryFilePath: string;
	/**
	 * Default: out
	 */
	outputFolder?: string;
	/**
	 * Default: false
	 */
	cli?: boolean;
}

interface PackageJson {
	version: string;
}

try {
	const args = process.argv.slice(2);
	// Eine Quelle für Validierung und help, damit ein neues Kommando bzw. eine neue Option nur an
	// einer Stelle einzutragen ist. build steht nicht darin: Der Build ist der Aufruf ohne Kommando.
	// help und version sind Kommandos, keine Flags - sie sind eigene Aktionen, keine Abwandlung.
	const knownCommands: Record<string, string> = {
		check: 'Only parse and check, without emitting or bundling output.',
		test: 'Check and run all *.test.jul files below the config folder, without writing output.',
		help: 'Print this help text.',
		version: 'Print the compiler version.',
	};
	const knownOptions: Record<string, { value: string; description: string; }> = {
		'--config': {
			value: '<path>',
			description: 'Path to the jul-config.yaml. Default: jul-config.yaml in the current directory.',
		},
	};
	const optionValues: Record<string, string> = {};
	const positionalArgs: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (!arg.startsWith('--')) {
			positionalArgs.push(arg);
			continue;
		}
		// Werte gehen als --config pfad und als --config=pfad.
		const separatorIndex = arg.indexOf('=');
		const name = separatorIndex === -1 ? arg : arg.slice(0, separatorIndex);
		const option = knownOptions[name];
		// Ein Tippfehler im Flag-Namen (z.B. --confg) soll auffallen statt still ignoriert zu werden.
		if (!option) {
			throw new Error(`Unknown option: ${name}. Known options: ${Object.keys(knownOptions).join(', ')}`);
		}
		const value = separatorIndex === -1
			? args[++index]
			: arg.slice(separatorIndex + 1);
		if (!value || value.startsWith('--')) {
			throw new Error(`Missing value for option ${name}.`);
		}
		if (name in optionValues) {
			throw new Error(`Option ${name} given more than once.`);
		}
		optionValues[name] = value;
	}
	// Jedes positionale Argument ist ein Kommando. Ein Tippfehler (z.B. chekc) schlägt deshalb fehl,
	// statt als Pfad gelesen zu werden.
	if (positionalArgs.length > 1) {
		throw new Error(`Too many arguments: ${positionalArgs.join(', ')}. Expected at most one command.`);
	}
	const command = positionalArgs[0];
	if (command !== undefined && !(command in knownCommands)) {
		throw new Error(`Unknown command: ${command}. Known commands: ${Object.keys(knownCommands).join(', ')}`);
	}
	// Optionen beziehen sich aufs Projekt; bei help und version würden sie still ignoriert.
	const givenOptions = Object.keys(optionValues);
	if ((command === 'help' || command === 'version') && givenOptions.length) {
		throw new Error(`Command ${command} takes no options: ${givenOptions.join(', ')}.`);
	}
	if (command === 'help') {
		const printEntries = (entries: [string, string][]) => {
			const width = Math.max(...entries.map(([name]) => name.length)) + 2;
			for (const [name, description] of entries) {
				console.log(`  ${name.padEnd(width)}${description}`);
			}
		};
		console.log('\nUsage: jul [command] [options]');
		console.log('\nWithout command, the project is checked, emitted and bundled into the output folder.');
		console.log('\nCommands:');
		printEntries(Object.entries(knownCommands));
		console.log('\nOptions:');
		printEntries(Object.entries(knownOptions).map(([name, option]) =>
			[`${name} ${option.value}`, option.description]));
		process.exit(0);
	}
	if (command === 'version') {
		// package.json liegt nicht unter src/ (rootDir in tsconfig.build.json) und lässt sich deshalb
		// nicht per JSON-Import einbinden - stattdessen zur Laufzeit relativ zur ausgeführten Datei
		// gelesen, wie runtime.js in compiler.ts.
		const packageJson: PackageJson = JSON.parse(readTextFile(join(executingDirectory, '..', 'package.json')));
		console.log(packageJson.version);
		process.exit(0);
	}
	// Nur parsen und checken, kein Emit/Bundle - siehe checkOnly in compiler.ts.
	const checkOnly = command === 'check';
	const runTests = command === 'test';
	const configFilePath = optionValues['--config'] ?? 'jul-config.yaml';
	let configYaml: string;
	try {
		configYaml = readTextFile(configFilePath);
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`Config file not found: ${configFilePath}.\nProvide the path to a jul-config.yaml with --config, or run in a directory that contains one.`);
		}
		throw error;
	}
	const config = load(configYaml) as JulCompilerConfiguration;
	const ajv = new Ajv();
	const validateConfig = ajv.compile(configSchema);
	const valid = validateConfig(config);
	if (!valid) {
		throw new Error('Configuration file does not match schema');
	}
	const rootFolder = dirname(configFilePath);
	const outputFolder = config.outputFolder ?? 'out';
	if (runTests) {
		await testProject(rootFolder, join(rootFolder, outputFolder));
	}
	else {
		compileProject(
			join(rootFolder, config.entryFilePath),
			join(rootFolder, outputFolder),
			config.cli,
			checkOnly,
		);
	}
}
catch (error) {
	// Nur die Message ausgeben, kein Stack Trace - der ist für Nutzer der CLI nicht hilfreich.
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
