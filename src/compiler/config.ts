import { Ajv } from 'ajv';
import { existsSync } from 'fs';
import { load } from 'js-yaml';
import { dirname, join } from 'path';
import configSchema from './jul-config-schema.json' with { type: 'json' };
import { readTextFile } from '../util.js';

export const configFileName = 'jul-config.yaml';

export interface JulCompilerConfiguration {
	entryFilePath: string;
	/**
	 * Default: out
	 */
	outputFolder?: string;
	/**
	 * Default: false
	 */
	cli?: boolean;
	/**
	 * Default: true
	 */
	warnUnknown?: boolean;
}

export const defaultWarnUnknown = true;

const validateConfig = new Ajv().compile(configSchema);

/**
 * Parst und validiert den Inhalt einer jul-config.yaml.
 */
export function parseConfig(configYaml: string): JulCompilerConfiguration {
	const config = load(configYaml) as JulCompilerConfiguration;
	if (!validateConfig(config)) {
		throw new Error('Configuration file does not match schema');
	}
	return config;
}

/**
 * Die nächste jul-config.yaml im Ordner oder darüber.
 */
export function findConfigFilePath(startFolder: string): string | undefined {
	let folder = startFolder;
	while (true) {
		const configFilePath = join(folder, configFileName);
		if (existsSync(configFilePath)) {
			return configFilePath;
		}
		const parentFolder = dirname(folder);
		if (parentFolder === folder) {
			return undefined;
		}
		folder = parentFolder;
	}
}

/**
 * Ob für die Datei unknown als Warnung gemeldet wird: nach der nächsten jul-config.yaml, ohne
 * Config oder bei einer ungültigen gilt der Standard. Der Language Server fragt je Checklauf und
 * Datei, die Config wird deshalb jedes Mal neu gelesen, damit eine Änderung sofort gilt.
 */
export function readWarnUnknown(filePath: string): boolean {
	const configFilePath = findConfigFilePath(dirname(filePath));
	if (!configFilePath) {
		return defaultWarnUnknown;
	}
	try {
		return parseConfig(readTextFile(configFilePath)).warnUnknown ?? defaultWarnUnknown;
	}
	catch {
		return defaultWarnUnknown;
	}
}
