#!/usr/bin/env node
import { Ajv } from 'ajv';
import { load } from 'js-yaml';
import { dirname, join } from 'path';
import { compileProject } from './compiler.js';
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
	// Flags (z.B. --check) und der positionale Config-Pfad werden getrennt eingesammelt, nicht per
	// Index gelesen - sonst würde ein Flag ohne Config-Angabe als Config-Pfad interpretiert.
	const args = process.argv.slice(2);
	// Eine Quelle für Validierung und --help, damit ein neues Flag nur an einer Stelle einzutragen ist.
	const knownFlags: Record<string, string> = {
		'--check': 'Only parse and check, without emitting or bundling output.',
		'--help': 'Print this help text and exit.',
		'--version': 'Print the compiler version and exit.',
	};
	const flags = args.filter(arg => arg.startsWith('--'));
	if (flags.includes('--help')) {
		console.log('\nUsage: jul [options] [path-to-jul-config.yaml]');
		console.log('\nOptions:');
		for (const [flag, description] of Object.entries(knownFlags)) {
			console.log(`  ${flag.padEnd(11)}${description}`);
		}
		process.exit(0);
	}
	if (flags.includes('--version')) {
		// package.json liegt nicht unter src/ (rootDir in tsconfig.build.json) und lässt sich deshalb
		// nicht per JSON-Import einbinden - stattdessen zur Laufzeit relativ zur ausgeführten Datei
		// gelesen, wie runtime.js in compiler.ts.
		const packageJson: PackageJson = JSON.parse(readTextFile(join(executingDirectory, '..', 'package.json')));
		console.log(packageJson.version);
		process.exit(0);
	}
	// Ein Tippfehler im Flag-Namen (z.B. --chekc) soll auffallen statt still einen Vollbuild
	// auszulösen.
	const unknownFlags = flags.filter(flag => !(flag in knownFlags));
	if (unknownFlags.length) {
		throw new Error(`Unknown option(s): ${unknownFlags.join(', ')}. Known options: ${Object.keys(knownFlags).join(', ')}`);
	}
	// Nur parsen und checken, kein Emit/Bundle - siehe checkOnly in compiler.ts.
	const checkOnly = flags.includes('--check');
	const positionalArgs = args.filter(arg => !arg.startsWith('--'));
	if (positionalArgs.length > 1) {
		throw new Error(`Too many arguments: ${positionalArgs.join(', ')}. Expected at most the path to jul-config.yaml.`);
	}
	const configFilePath = positionalArgs[0] ?? 'jul-config.yaml';
	let configYaml: string;
	try {
		configYaml = readTextFile(configFilePath);
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`Config file not found: ${configFilePath}.\nProvide the path to a jul-config.yaml as argument, or run in a directory that contains one.`);
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
	compileProject(
		join(rootFolder, config.entryFilePath),
		join(rootFolder, outputFolder),
		config.cli,
		checkOnly,
	);
}
catch (error) {
	// Nur die Message ausgeben, kein Stack Trace - der ist für Nutzer der CLI nicht hilfreich.
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
