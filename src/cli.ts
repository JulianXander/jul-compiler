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

/**
 * Liest und validiert die jul-config.yaml. Die Ordner sind bereits relativ zum Config-Ordner aufgelöst.
 */
function loadConfig(configPathOption: string | undefined): {
	rootFolder: string;
	outputFolder: string;
	config: JulCompilerConfiguration;
} {
	const configFilePath = configPathOption ?? 'jul-config.yaml';
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
	return {
		rootFolder: rootFolder,
		outputFolder: join(rootFolder, config.outputFolder ?? 'out'),
		config: config,
	};
}

try {
	const args = process.argv.slice(2);
	// Eine Quelle für Validierung und help, damit ein neues Kommando bzw. eine neue Option nur an
	// einer Stelle einzutragen ist. build steht nicht in knownCommands: Der Build ist der Aufruf ohne
	// Kommando, seine Optionen stehen in buildOptions.
	// help und version sind Kommandos, keine Flags - sie sind eigene Aktionen, keine Abwandlung.
	const knownOptions: Record<string, { value: string; description: string; }> = {
		'--config': {
			value: '<path>',
			description: 'Path to the jul-config.yaml. Default: jul-config.yaml in the current directory.',
		},
		'--name': {
			value: '<name>',
			description: 'Run only the tests with exactly this name.',
		},
	};
	const buildOptions: string[] = ['--config'];
	// satisfies statt Annotation, damit Command die Union der Kommandonamen ist und der switch unten
	// ein neues Kommando ohne case beim Typecheck meldet.
	const knownCommands = {
		check: {
			description: 'Only parse and check, without emitting or bundling output.',
			options: ['--config'],
		},
		test: {
			description: 'Check and run all *.test.jul files below the config folder, without writing output.',
			options: ['--config', '--name'],
		},
		help: {
			description: 'Print this help text.',
			options: [],
		},
		version: {
			description: 'Print the compiler version.',
			options: [],
		},
	} satisfies Record<string, { description: string; options: string[]; }>;
	type Command = keyof typeof knownCommands;
	// Object.hasOwn statt in: in fände auch geerbte Schlüssel wie toString.
	const isCommand = (value: string): value is Command => Object.hasOwn(knownCommands, value);
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
	const commandArg = positionalArgs[0];
	if (commandArg !== undefined && !isCommand(commandArg)) {
		throw new Error(`Unknown command: ${commandArg}. Known commands: ${Object.keys(knownCommands).join(', ')}`);
	}
	const command: Command | undefined = commandArg;
	// Eine Option, die das Kommando nicht kennt, würde sonst still ignoriert.
	const allowedOptions: string[] = command === undefined
		? buildOptions
		: knownCommands[command].options;
	const commandText = command === undefined
		? 'Build (without command)'
		: `Command ${command}`;
	const unexpectedOptions = Object.keys(optionValues).filter(name => !allowedOptions.includes(name));
	if (unexpectedOptions.length) {
		throw new Error(allowedOptions.length
			? `${commandText} does not take option ${unexpectedOptions.join(', ')}. Allowed options: ${allowedOptions.join(', ')}`
			: `${commandText} takes no options: ${unexpectedOptions.join(', ')}.`);
	}
	switch (command) {
		case undefined:
		// Nur parsen und checken, kein Emit/Bundle - siehe checkOnly in compiler.ts.
		case 'check': {
			const { rootFolder, outputFolder, config } = loadConfig(optionValues['--config']);
			compileProject(
				join(rootFolder, config.entryFilePath),
				outputFolder,
				config.cli,
				command === 'check',
			);
			break;
		}
		case 'test': {
			const { rootFolder, outputFolder } = loadConfig(optionValues['--config']);
			await testProject(rootFolder, outputFolder, optionValues['--name']);
			break;
		}
		case 'help': {
			const printEntries = (entries: [string, string][]) => {
				const width = Math.max(...entries.map(([name]) => name.length)) + 2;
				for (const [name, description] of entries) {
					console.log(`  ${name.padEnd(width)}${description}`);
				}
			};
			const withOptions = (description: string, options: string[]) => options.length
				? `${description} Options: ${options.join(', ')}`
				: description;
			console.log('\nUsage: jul [command] [options]');
			console.log(`\n${withOptions('Without command, the project is checked, emitted and bundled into the output folder.', buildOptions)}`);
			console.log('\nCommands:');
			printEntries(Object.entries(knownCommands).map(([name, knownCommand]) =>
				[name, withOptions(knownCommand.description, knownCommand.options)]));
			console.log('\nOptions:');
			printEntries(Object.entries(knownOptions).map(([name, option]) =>
				[`${name} ${option.value}`, option.description]));
			break;
		}
		case 'version': {
			// package.json liegt nicht unter src/ (rootDir in tsconfig.build.json) und lässt sich deshalb
			// nicht per JSON-Import einbinden - stattdessen zur Laufzeit relativ zur ausgeführten Datei
			// gelesen, wie runtime.js in compiler.ts.
			const packageJson: PackageJson = JSON.parse(readTextFile(join(executingDirectory, '..', 'package.json')));
			console.log(packageJson.version);
			break;
		}
		default: {
			const unhandledCommand: never = command;
			throw new Error(`Unhandled command: ${unhandledCommand}`);
		}
	}
}
catch (error) {
	// Nur die Message ausgeben, kein Stack Trace - der ist für Nutzer der CLI nicht hilfreich.
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
