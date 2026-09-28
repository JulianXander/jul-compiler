import { expect } from 'chai';
import { join, resolve } from 'path';
import { parseTsCode } from './typescript-parser.js';
import { parseCode } from './parser.js';
import { checkTypes, isFunctionType, ParsedDocuments, typeToString } from '../checker/checker.js';
import { ErrorCode } from '../compiler-errors.js';
import { createInMemoryHost, loadFile } from '../project-loader.js';
import { ParsedFile, ParseSingleDefinition, TypePurity } from '../syntax-tree.js';
import { reportAtCaller } from '../test-util.js';

describe('TypeScript Parser', () => {
	it('sollte Zeile/Spalte statt rohem Zeichen-Offset für die Position einer Funktionsdeklaration liefern', () => {
		const code = 'export function foo() {\n\treturn 1;\n}\n';
		const result = parseTsCode(code);
		const definition = result.expressions![0] as ParseSingleDefinition;
		expect(definition.name).to.deep.include({
			startRowIndex: 0,
			startColumnIndex: 16,
			endRowIndex: 0,
			endColumnIndex: 19,
		});
	});

	//#region Typannotationen

	/**
	 * Parst und prüft den TS-Code und liefert den Typ der Definition f als Text.
	 * Fehler dürfen keine entstehen: eine nicht übersetzbare Annotation fällt still auf Any zurück.
	 */
	function typeOfF(code: string): string | undefined {
		const parsed = parseCode(code, 'test.ts');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
		const definition = parsed.checked?.expressions?.find((expression): expression is ParseSingleDefinition =>
			expression.type === 'definition' && expression.name.name === 'f');
		const type = definition?.value?.typeInfo?.type;
		return type && typeToString(type, 0, 3);
	}

	const expectTypeOfF = reportAtCaller((code: string, result: string) => {
		expect(typeOfF(code)).to.equal(result);
	});
	describe('Rückgabetyp', () => {
		it('bigint', () => expectTypeOfF('export function f(): bigint { return 1n; }', '() ~> Integer'));
		it('number', () => expectTypeOfF('export function f(): number { return 1; }', '() ~> Float'));
		it('string', () => expectTypeOfF('export function f(): string { return ""; }', '() ~> Text'));
		it('boolean', () => expectTypeOfF('export function f(): boolean { return true; }', '() ~> Boolean'));
		it('void', () => expectTypeOfF('export function f(): void {}', '() ~> Empty'));
		it('any', () => expectTypeOfF('export function f(): any {}', '() ~> Any'));
		it('union mit undefined', () => expectTypeOfF('export function f(): bigint | undefined {}', '() ~> Or(Empty Integer)'));
		it('array', () => expectTypeOfF('export function f(): string[] {}', '() ~> List(Text)'));
		it('Array<T>', () => expectTypeOfF('export function f(): Array<bigint> {}', '() ~> List(Integer)'));
		it('array mit undefined', () => expectTypeOfF('export function f(): string[] | undefined {}', '() ~> Or(Empty List(Text))'));
		it('index signature', () => expectTypeOfF('export function f(): { [key: string]: any; } {}', '() ~> Dictionary(Any)'));
		it('index signature mit undefined', () => expectTypeOfF('export function f(): { [key: string]: any; } | undefined {}', '() ~> Or(Empty Dictionary(Any))'));
		it('Record', () => expectTypeOfF('export function f(): Record<string, number> {}', '() ~> Dictionary(Float)'));
		it('Objekt-Typliteral mit optionalem Feld und Error', () => {
			expectTypeOfF('export function f(): { main: string[] | undefined, extra?: bigint } | Error {}', `() ~> Or([
  main: Or(Empty List(Text))
  extra: Or(Empty Integer)
] Error)`);
		});
		it('Literaltypen', () => expectTypeOfF('export function f(): \'a\' | 1n | 2 | true {}', '() ~> Or(§a§ 1 2f true)'));
		it('Klammertyp', () => expectTypeOfF('export function f(): (bigint) {}', '() ~> Integer'));
		it('ArrowFunction', () => expectTypeOfF('export const f = (): bigint => 1n;', '() ~> Integer'));
		it('ohne Annotation', () => expectTypeOfF('export function f() { return 1n; }', '() ~> Any'));
		it('generisch', () => expectTypeOfF('export function f<T>(): T {}', '() ~> Any'));
		it('Promise', () => expectTypeOfF('export function f(): Promise<number> {}', '() ~> Any'));
		it('Funktionstyp', () => expectTypeOfF('export function f(): () => void {}', '() ~> () :> Any'));
		it('Union mit nicht übersetzbarem Glied', () => expectTypeOfF('export function f(): bigint | Foo {}', '() ~> Any'));
		it('verschachtelt nicht übersetzbar', () => expectTypeOfF('export function f(): Foo[] {}', '() ~> List(Any)'));
	});

	describe('Parametertyp', () => {
		it('einfacher Parameter', () => expectTypeOfF('export function f(a: bigint) {}', '(a: Integer) ~> Any'));
		it('optionaler Parameter', () => {
			expectTypeOfF('export function f(a: bigint, b?: string) {}', '(\n  a: Integer\n  b: Or(Empty Text)\n) ~> Any');
		});
		it('optionaler Parameter mit Union', () => expectTypeOfF('export function f(a?: bigint | string) {}', '(a: Or(Empty Integer Text)) ~> Any'));
		it('Default mit Annotation', () => expectTypeOfF('export function f(a: bigint = 1n) {}', '(a: Or(Empty Integer)) ~> Any'));
		it('Default ohne Annotation', () => expectTypeOfF('export function f(a = 1n) {}', '(a: Any) ~> Any'));
		it('ohne Annotation', () => expectTypeOfF('export function f(a) {}', '(a: Any) ~> Any'));
		it('Callback', () => expectTypeOfF('export function f(cb: (x: any) => boolean) {}', '(cb: (x: Any) :> Boolean) ~> Any'));
		it('optionaler Callback', () => expectTypeOfF('export function f(cb?: () => void) {}', '(cb: Or(Empty () :> Any)) ~> Any'));
		it('Callback mit nicht übersetzbarem Parametertyp', () => expectTypeOfF('export function f(cb: (event: Event) => void) {}', '(cb: (event: Any) :> Any) ~> Any'));
		it('Callback mit optionalem und Rest-Parameter', () => {
			expectTypeOfF('export function f(cb: (a?: string, ...rest: bigint[]) => void) {}', `(cb: (
  a: Or(Empty Text)
  ...rest: Or(Empty List(Integer))
) :> Any) ~> Any`);
		});
		// Ohne Namen lässt sich der Parameter nicht übersetzen, und weglassen würde die Positionen verschieben.
		it('Callback mit Destructuring bleibt ungetypt', () => expectTypeOfF('export function f(cb: ({ a }: { a: bigint }) => void) {}', '(cb: Any) ~> Any'));
		it('generischer Callback bleibt ungetypt', () => expectTypeOfF('export function f(cb: <T>(x: T) => T) {}', '(cb: Any) ~> Any'));
		// Ein Aufruf ohne Rest-Argumente kommt in JUL als Empty an, und TS kann das am
		// Rest-Parameter nicht mit | undefined annotieren - deshalb hier Empty zusätzlich.
		it('Rest-Parameter', () => expectTypeOfF('export function f(...args: bigint[]) {}', '(...args: Or(Empty List(Integer))) ~> Any'));
		it('Rest-Parameter nach Einzelparameter', () => {
			expectTypeOfF('export function f(a: string, ...args: bigint[]) {}', '(\n  a: Text\n  ...args: Or(Empty List(Integer))\n) ~> Any');
		});
		it('Rest-Parameter ohne Annotation', () => expectTypeOfF('export function f(...args) {}', '(...args: Any) ~> Any'));
		// this ist in TS eine reine Typangabe, kein Argument
		it('this-Parameter entfällt', () => expectTypeOfF('export function f(this: Window, a: bigint) {}', '(a: Integer) ~> Any'));
		it('ArrowFunction', () => expectTypeOfF('export const f = (a: bigint): bigint => a;', '(a: Integer) ~> Integer'));
	});

	it('JUL-Aufruf mit falschem Argumenttyp wird gemeldet', () => {
		const folder = resolve('/typescript-parser-test');
		const mainPath = join(folder, 'main.jul');
		const documents: ParsedDocuments = {};
		const main = loadFile(mainPath, documents, createInMemoryHost({
			[mainPath]: '(double) = import(§./util.ts§)\nwrong = double(§x§)',
			[join(folder, 'util.ts')]: 'export function double(a: bigint): bigint { return a * 2n; }',
		}, { cloneUnchecked: false }));
		expect(typeof main).to.not.equal('string');
		expect((main as ParsedFile).checked?.errors.map(error => error.code)).to.deep.equal([ErrorCode.argumentTypeMismatch]);
	});

	/**
	 * Lädt main.jul, das f aus util.ts importiert.
	 */
	function loadMainWithImport(tsCode: string, julCode: string): ParsedFile {
		const folder = resolve('/typescript-parser-test');
		const mainPath = join(folder, 'main.jul');
		const documents: ParsedDocuments = {};
		const main = loadFile(mainPath, documents, createInMemoryHost({
			[mainPath]: `(f) = import(§./util.ts§)
${julCode}`,
			[join(folder, 'util.ts')]: tsCode,
		}, { cloneUnchecked: false }));
		expect(typeof main).to.not.equal('string');
		return main as ParsedFile;
	}

	const expectImportErrors = reportAtCaller((tsCode: string, julCode: string, errorCodes: ErrorCode[]) => {
		expect(loadMainWithImport(tsCode, julCode).checked?.errors.map(error => error.code)).to.deep.equal(errorCodes);
	});
	describe('Callback aus JUL', () => {
		const listener = 'export function f(listener: (value: string) => void): void {}';
		it('passender Callback', () => expectImportErrors(listener, 'x = f((value) => value)', []));
		it('weniger Parameter', () => expectImportErrors(listener, 'x = f(() => 1)', []));
		// void am Callback: der Rückgabewert wird ignoriert
		it('Rückgabewert bei void', () => expectImportErrors(listener, 'x = f((value: Text) => 1)', []));
		// Die Parameternamen gehören zum Typ wie bei den Callbacks der core-lib.
		it('anderer Parametername', () => expectImportErrors(listener, 'x = f((v) => v)', [ErrorCode.argumentTypeMismatch]));
		it('falscher Parametertyp', () => expectImportErrors(listener, 'x = f((value: Integer) => value)', [ErrorCode.argumentTypeMismatch]));
		// Kontravarianz: der Callback bekommt jeden Text, darf also nicht weniger annehmen.
		it('engerer Parametertyp', () => expectImportErrors(listener, 'x = f((value: Or(§ok§ §cancel§)) => value)', [ErrorCode.argumentTypeMismatch]));
		// Der ungetypte Parameter bekommt Text aus der TS-Deklaration.
		it('Parametertyp aus der Deklaration', () => expectImportErrors(listener, 'x = f((value) => add(value 1))', [ErrorCode.argumentTypeMismatch]));
		it('keine Funktion', () => expectImportErrors(listener, 'x = f(1)', [ErrorCode.argumentTypeMismatch]));
	});

	//#endregion Typannotationen

	//#region Purity

	function purityOfDefinition(file: ParsedFile, name: string): TypePurity | undefined {
		const definition = file.checked?.expressions?.find((expression): expression is ParseSingleDefinition =>
			expression.type === 'definition' && expression.name.name === name);
		const type = definition?.value?.typeInfo?.type;
		return type && isFunctionType(type) ? type.purity : undefined;
	}

	function checkTs(code: string): ParsedFile {
		const parsed = parseCode(code, 'test.ts');
		checkTypes(parsed, {}, { cloneUnchecked: false });
		expect(parsed.checked?.errors).to.deep.equal([]);
		return parsed;
	}

	const expectPurityOfF = reportAtCaller((code: string, purity: TypePurity) => {
		expect(purityOfDefinition(checkTs(code), 'f')).to.equal(purity);
	});
	const expectPurityInMain = reportAtCaller((tsCode: string, julCode: string, purity: TypePurity) => {
		expect(purityOfDefinition(loadMainWithImport(tsCode, julCode), 'g')).to.equal(purity);
	});
	describe('Purity aus JSDoc', () => {
		it('ohne @pure unrein', () => expectPurityOfF('export function f(a: bigint): bigint { return a; }', 'impure'));
		it('@pure', () => expectPurityOfF('/** @pure */\nexport function f(a: bigint): bigint { return a; }', 'pure'));
		it('@pure ohne Parameter', () => expectPurityOfF('/** @pure */\nexport function f(): bigint { return 1n; }', 'pure'));
		it('@pure an const', () => expectPurityOfF('/** @pure */\nexport const f = (a: bigint): bigint => a;', 'pure'));
		it('@pure neben Beschreibung und Tags', () => {
			expectPurityOfF('/**\n * Verdoppelt\n * @pure\n * @param a der Wert\n */\nexport function f(a: bigint): bigint { return a; }', 'pure');
		});
		it('anderes Tag macht nicht rein', () => expectPurityOfF('/** @deprecated */\nexport function f(a: bigint): bigint { return a; }', 'impure'));
		it('Zeilenkommentar macht nicht rein', () => expectPurityOfF('// @pure\nexport function f(a: bigint): bigint { return a; }', 'impure'));
		// Rein heißt dann nur: ruft nichts Unreines außer den übergebenen Funktionen auf.
		it('@pure mit Callback ist bedingt rein', () => {
			expectPurityOfF('/** @pure */\nexport function f(cb: (x: bigint) => bigint): bigint { return cb(1n); }', 'pureIfArgsPure');
		});
		it('@pure mit optionalem Callback ist bedingt rein', () => {
			expectPurityOfF('/** @pure */\nexport function f(cb?: () => void) {}', 'pureIfArgsPure');
		});
		// Any kann eine Funktion sein.
		it('@pure mit Any-Parameter ist bedingt rein', () => expectPurityOfF('/** @pure */\nexport function f(a: any) {}', 'pureIfArgsPure'));
		it('@pure mit Rest-Parameter ohne Annotation ist bedingt rein', () => expectPurityOfF('/** @pure */\nexport function f(...args) {}', 'pureIfArgsPure'));
		it('Callback-Parameter bleibt unbestimmt', () => {
			const parsed = checkTs('export function f(cb: (x: bigint) => bigint) {}');
			const definition = parsed.checked?.expressions?.find((expression): expression is ParseSingleDefinition =>
				expression.type === 'definition' && expression.name.name === 'f');
			const type = definition?.value?.typeInfo?.type;
			const paramsType = type && isFunctionType(type) ? type.ParamsType : undefined;
			const callbackType = paramsType?.julType === 'parameters' ? paramsType.singleNames[0]?.type : undefined;
			expect(callbackType && isFunctionType(callbackType) ? callbackType.purity : undefined).to.equal('unknown');
		});
		it('Anzeige mit @pure', () => expectTypeOfF('/** @pure */\nexport function f(a: bigint): bigint { return a; }', '(a: Integer) -> Integer'));
		it('@pure erscheint nicht in der Beschreibung', () => {
			const parsed = parseCode('/**\n * Verdoppelt\n * @pure\n */\nexport function f(a: bigint) {}', 'test.ts');
			expect(parsed.unchecked.symbols.f?.description).to.equal('Verdoppelt');
		});
	});

	describe('Purity beim Aufruf aus JUL', () => {
		const impure = 'export function f(a: bigint): bigint { return a; }';
		const pure = '/** @pure */\nexport function f(a: bigint): bigint { return a; }';
		const pureWithCallback = '/** @pure */\nexport function f(cb: () => bigint): bigint { return cb(); }';
		it('Aufrufer einer unreinen Funktion ist unrein', () => expectPurityInMain(impure, 'g = () => f(1)', 'impure'));
		it('Aufrufer einer @pure-Funktion ist rein', () => expectPurityInMain(pure, 'g = () => f(1)', 'pure'));
		it('-> über unreiner Funktion', () => expectImportErrors(impure, 'g = () -> Any => f(1)', [ErrorCode.purityMismatch]));
		it('-> über @pure-Funktion', () => expectImportErrors(pure, 'g = () -> Any => f(1)', []));
		it('@pure mit reinem Callback ist rein', () => expectPurityInMain(pureWithCallback, 'g = () => f(() => 1)', 'pure'));
		it('@pure mit unreinem Callback ist unrein', () => expectPurityInMain(pureWithCallback, 'g = () => f(() => log(1))', 'impure'));
	});

	//#endregion Purity

	//#region Beschreibung

	const expectDescriptionOfF = reportAtCaller((code: string, description: string | undefined) => {
		const parsed = parseCode(code, 'test.ts');
		expect(parsed.unchecked.symbols.f?.description).to.equal(description);
	});
	describe('Beschreibung aus JSDoc', () => {
		it('Funktion', () => expectDescriptionOfF('/**\n * Erste Zeile\n * zweite Zeile\n */\nexport function f() {}', 'Erste Zeile\nzweite Zeile'));
		it('const', () => expectDescriptionOfF('/**\n * Beschreibung\n */\nexport const f = () => 1;', 'Beschreibung'));
		it('einzeilig', () => expectDescriptionOfF('/** Beschreibung */\nexport function f() {}', 'Beschreibung'));
		it('Tags bleiben als Text erhalten', () => {
			expectDescriptionOfF('/**\n * Beschreibung\n * @param a der Wert\n * @returns nichts\n */\nexport function f(a: bigint) {}', 'Beschreibung\n@param a der Wert\n@returns nichts');
		});
		it('nur der letzte JSDoc-Block', () => expectDescriptionOfF('/** alt */\n/** neu */\nexport function f() {}', 'neu'));
		it('CRLF', () => expectDescriptionOfF('/**\r\n * Erste Zeile\r\n * zweite Zeile\r\n */\r\nexport function f() {}', 'Erste Zeile\nzweite Zeile'));
		it('Zeilenkommentar zählt nicht', () => expectDescriptionOfF('// Notiz\nexport function f() {}', undefined));
		it('Blockkommentar zählt nicht', () => expectDescriptionOfF('/* Notiz */\nexport function f() {}', undefined));
		it('ohne Kommentar', () => expectDescriptionOfF('export function f() {}', undefined));
	});

	//#endregion Beschreibung
});
