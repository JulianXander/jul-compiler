#!/usr/bin/env node
import { Ajv } from 'ajv';
import { load } from 'js-yaml';
import { dirname, join } from 'path';
import { compileProject } from './compiler.js';
import configSchema from './jul-config-schema.json' with { type: 'json' };
import { readTextFile } from './util.js';

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

// console.log(process.argv)
// Flags (z.B. --check) und der positionale Config-Pfad werden getrennt eingesammelt, nicht per
// Index gelesen - sonst würde ein Flag ohne Config-Angabe als Config-Pfad interpretiert.
const args = process.argv.slice(2);
const knownFlags = new Set(['--check']);
const flags = args.filter(arg => arg.startsWith('--'));
// Ein Tippfehler im Flag-Namen (z.B. --chekc) soll auffallen statt still einen Vollbuild
// auszuloesen.
const unknownFlags = flags.filter(flag => !knownFlags.has(flag));
if (unknownFlags.length) {
	throw new Error(`Unknown option(s): ${unknownFlags.join(', ')}. Known options: ${[...knownFlags].join(', ')}`);
}
// Nur parsen und checken, kein Emit/Bundle - siehe checkOnly in compiler.ts.
const checkOnly = flags.includes('--check');
const positionalArgs = args.filter(arg => !arg.startsWith('--'));
if (positionalArgs.length > 1) {
	throw new Error(`Too many arguments: ${positionalArgs.join(', ')}. Expected at most the path to jul-config.yaml.`);
}
const configFilePath = positionalArgs[0] ?? 'jul-config.yaml';
const configYaml = readTextFile(configFilePath);
const config = load(configYaml) as JulCompilerConfiguration;
const ajv = new Ajv();
const validateConfig = ajv.compile(configSchema);
const valid = validateConfig(config);
if (!valid) {
	throw new Error('Configuration file does not match schema');
}
const rootFolder = dirname(configFilePath);
const outputFolder = config.outputFolder ?? 'out';
console.log(`Compiler started with entry file ${config.entryFilePath} ...`);
compileProject(
	join(rootFolder, config.entryFilePath),
	join(rootFolder, outputFolder),
	config.cli,
	checkOnly,
);
