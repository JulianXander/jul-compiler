#!/usr/bin/env node
import { JulCompilerOptions, compileFileToJs } from './compiler';
import { load } from 'js-yaml';
import Ajv from 'ajv';
import configSchema from './jul-config-schema.json';
import { readTextFile } from './util';

// console.log(process.argv)
const configFilePath = process.argv[2] ?? 'jul-config.yaml';
const configYaml = readTextFile(configFilePath);
const parsedConfig = load(configYaml);
const ajv = new Ajv();
const validateConfig = ajv.compile(configSchema);
const valid = validateConfig(parsedConfig);
if (!valid) {
	throw new Error('Configuration file does not match schema');
}
const options = parsedConfig as JulCompilerOptions;
console.log(`Compiler started with entry file ${options.entryFilePath} ...`);
compileFileToJs(options);
