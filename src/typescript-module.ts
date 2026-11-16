import type TypeScript from 'typescript';

/**
 * Das TypeScript-Paket, gebraucht nur für .ts-Dateien (Parser und Emit). Es ist groß, deshalb
 * importiert es der Compiler nicht selbst: Unter Node setzt es node-host.ts beim Laden, im Browser
 * lädt es der Einstieg nach, bevor er eine .ts-Datei parst.
 */
let typescript: typeof TypeScript | undefined;

export function setTypeScript(module: typeof TypeScript): void {
	typescript = module;
}

export function isTypeScriptLoaded(): boolean {
	return typescript !== undefined;
}

/**
 * @throws Wirft Error, wenn setTypeScript noch nicht aufgerufen wurde.
 */
export function getTypeScript(): typeof TypeScript {
	if (!typescript) {
		throw new Error('TypeScript is not loaded, call setTypeScript before parsing or emitting a .ts file.');
	}
	return typescript;
}
