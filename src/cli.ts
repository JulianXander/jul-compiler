#!/usr/bin/env node
import Ajv from 'ajv';
import { load } from 'js-yaml';
import { dirname, join } from 'path';
import { compileFileToJs } from './compiler';
import configSchema from './jul-config-schema.json';
import { readTextFile } from './util';

interface JulCompilerConfiguration {
	entryFilePath: string;
	/**
	 * Default: out
	 */
	outputFolder?: string;
}

// console.log(process.argv)
const configFilePath = process.argv[2] ?? 'jul-config.yaml';
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
compileFileToJs(
	join(rootFolder, config.entryFilePath),
	join(rootFolder, outputFolder),
);
