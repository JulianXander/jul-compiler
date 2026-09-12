import { expect } from 'chai';

import { ParseDictionaryLiteral, ParseDictionaryTypeLiteral, ParseExpression, ParseFunctionLiteral, ParseListLiteral, ParseNestedReference, ParseSingleDictionaryField, ParseSingleDictionaryTypeField } from '../syntax-tree.js';
import { CompilerError, ErrorCode } from '../compiler-errors.js';
import { coreLibPath, isCoreLibPath, parseCode, parseFile } from './parser.js';

const expectedResults: {
	name?: string;
	code: string;
	result?: ParseExpression[];
	errors?: CompilerError[];
}[] = [
		//#region Literale und Schreibweisen
		// Ohne result wird nur geprüft, dass fehlerfrei geparst wird. Das reicht für
		// Schreibweisen, deren AST anderswo schon abgedeckt ist.
		{
			name: 'reference-true',
			code: 'true',
		},
		{
			name: 'text-multiline-with-escaped-comment',
			code: '§\n\t§#\n§',
		},
		{
			name: 'text-multiline',
			code: '§\n\t12\n§',
		},
		{
			name: 'definition-with-literal-type-guard',
			code: 'a: 4 = 4',
		},
		{
			name: 'float-literal',
			code: '12.34f',
		},
		{
			name: 'fraction-literal',
			code: '12.34',
		},
		{
			name: 'comment-before-text',
			code: '# Destructuring import\n§a§',
		},
		{
			name: 'function-type-literal',
			code: '(delayMs: Float) :> Stream(Float)',
		},
		{
			name: 'definition-with-function-type-guard',
			code: 'x: (b: B c: C) :> [] = []',
		},
		//#endregion Literale und Schreibweisen
		{
			name: 'field-description',
			code: '[\n\t# hallo\n\tsomeKey = 5\n]\n',
			result: (() => {
				const field: ParseSingleDictionaryField = {
					"description": " hallo",
					"endColumnIndex": 12,
					"endRowIndex": 2,
					"name": {
						"endColumnIndex": 8,
						"endRowIndex": 2,
						"name": "someKey",
						"startColumnIndex": 1,
						"startRowIndex": 2,
						"type": "name",
					},
					"startColumnIndex": 1,
					"startRowIndex": 2,
					"type": "singleDictionaryField",
					"typeGuard": undefined,
					"value": {
						"endColumnIndex": 12,
						"endRowIndex": 2,
						"startColumnIndex": 11,
						"startRowIndex": 2,
						"type": "integer",
						"value": 5n,
					},
				};
				field.name.parent = field;
				field.value!.parent = field;
				const dictionary: ParseDictionaryLiteral = {
					"endColumnIndex": 1,
					"endRowIndex": 3,
					"fields": [
						field,
					],
					"symbols": {
						"someKey": {
							"description": " hallo",
							"endColumnIndex": 8,
							"endRowIndex": 2,
							"functionParameterIndex": undefined,
							"startColumnIndex": 1,
							"startRowIndex": 2,
							"typeExpression": undefined as any,
						},
					},
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"type": "dictionary",
				};
				dictionary.fields[0].parent = dictionary;
				dictionary.symbols.someKey!.definition = field;
				const result: ParseExpression[] = [
					dictionary,
				];
				return result;
			})(),
		},
		{
			name: 'escaped-field',
			code: '[\n\t§someKey§ = 5\n]\n',
			result: (() => {
				const field: ParseSingleDictionaryField = {
					"description": undefined,
					"endColumnIndex": 14,
					"endRowIndex": 1,
					"name": {
						"endColumnIndex": 10,
						"endRowIndex": 1,
						"startColumnIndex": 1,
						"startRowIndex": 1,
						"type": "text",
						values: [
							{
								type: "textToken",
								value: "someKey"
							}
						],
					},
					"startColumnIndex": 1,
					"startRowIndex": 1,
					"type": "singleDictionaryField",
					"typeGuard": undefined,
					"value": {
						"endColumnIndex": 14,
						"endRowIndex": 1,
						"startColumnIndex": 13,
						"startRowIndex": 1,
						"type": "integer",
						"value": 5n,
					},
				};
				field.name.parent = field;
				field.value!.parent = field;
				const dictionary: ParseDictionaryLiteral = {
					"endColumnIndex": 1,
					"endRowIndex": 2,
					"fields": [
						field,
					],
					"symbols": {
						"someKey": {
							"description": undefined,
							"endColumnIndex": 10,
							"endRowIndex": 1,
							"functionParameterIndex": undefined,
							"startColumnIndex": 1,
							"startRowIndex": 1,
							"typeExpression": undefined as any,
						},
					},
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"type": "dictionary",
				};
				dictionary.fields[0].parent = dictionary;
				dictionary.symbols.someKey!.definition = field;
				const result: ParseExpression[] = [
					dictionary,
				];
				return result;
			})(),
		},
		{
			name: 'dictionary-type',
			code: '[\n\tsomeKey: Text\n]',
			result: (() => {
				const field: ParseSingleDictionaryTypeField = {
					description: undefined,
					"endColumnIndex": 14,
					"endRowIndex": 1,
					"name": {
						"endColumnIndex": 8,
						"endRowIndex": 1,
						"name": "someKey",
						"startColumnIndex": 1,
						"startRowIndex": 1,
						"type": "name",
					},
					"startColumnIndex": 1,
					"startRowIndex": 1,
					"type": "singleDictionaryTypeField",
					"typeGuard": {
						"endColumnIndex": 14,
						"endRowIndex": 1,
						"name": {
							"endColumnIndex": 14,
							"endRowIndex": 1,
							"name": "Text",
							"startColumnIndex": 10,
							"startRowIndex": 1,
							"type": "name",
						},
						"startColumnIndex": 10,
						"startRowIndex": 1,
						"type": "reference",
					},
				};
				field.name.parent = field;
				field.typeGuard!.parent = field;
				const dictionaryType: ParseDictionaryTypeLiteral = {
					"endColumnIndex": 1,
					"endRowIndex": 2,
					"fields": [
						field
					],
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"symbols": {
						"someKey": {
							"description": undefined,
							"endColumnIndex": 8,
							"endRowIndex": 1,
							"functionParameterIndex": undefined,
							"startColumnIndex": 1,
							"startRowIndex": 1,
							"typeExpression": {
								"endColumnIndex": 14,
								"endRowIndex": 1,
								"name": {
									"endColumnIndex": 14,
									"endRowIndex": 1,
									"name": "Text",
									"startColumnIndex": 10,
									"startRowIndex": 1,
									"type": "name",
								},
								"startColumnIndex": 10,
								"startRowIndex": 1,
								"type": "reference",
							},
						},
					},
					"type": "dictionaryType",
				};
				dictionaryType.fields[0].parent = dictionaryType;
				dictionaryType.symbols.someKey!.definition = field;
				dictionaryType.symbols.someKey!.typeExpression!.parent = field;
				const result: ParseExpression[] = [
					dictionaryType,
				];
				return result;
			})(),
		},
		{
			name: 'destructuring',
			code: '(var var2) = [4 5]',
		},
		//#region Funktionen
		{
			name: 'function-single-line-body',
			code: '(a b) => log(a)',
		},
		{
			name: 'function-multiline-body',
			code: '(a b) =>\n\tlog(a)\n\tlog(b)',
		},
		{
			name: 'function-param-type-guard',
			code: '(a: Text) => a',
		},
		{
			name: 'function-rest-param',
			code: '(a ...restArg) => restArg',
		},
		{
			name: 'function-multiline-params',
			code: '(\n\ta\n) =>\n\trestArg',
		},
		{
			name: 'function-multiline-params-with-rest',
			code: '(\n\ta\n\t...restArg\n) =>\n\trestArg',
		},
		{
			name: 'function-call-multiline-argument',
			code: 'myFunc(\n\t§someValue§\n)',
		},
		{
			// Steht nach => gar nichts, gibt es keinen Wert für die Definition. Gegenstück in
			// checker.test.ts: mit einer Kommentarzeile darunter parst das Funktionsliteral durch
			// und hat einen leeren body.
			name: 'function-without-body',
			code: 'f = () =>',
			errors: [
				{
					"code": ErrorCode.assignedValueMissingForDefinition,
					"endColumnIndex": 4,
					"endRowIndex": 0,
					"message": "assignedValue missing for definition",
					"startColumnIndex": 0,
					"startRowIndex": 0,
				},
				{
					"code": ErrorCode.unparsedRestOfRow,
					"endColumnIndex": 4,
					"endRowIndex": 0,
					"message": "multilineParser should parse until end of row",
					"startColumnIndex": 4,
					"startRowIndex": 0,
				},
			],
		},
		//#endregion Funktionen
		//#region Einrückung
		{
			name: 'space-indentation-single-line',
			code: 'foo(\n    a = 1\n)',
			errors: [
				{
					code: ErrorCode.spaceIndentation,
					message: 'Indentation uses spaces instead of tabs. Expected 1 tab(s).',
					startRowIndex: 1,
					startColumnIndex: 0,
					endRowIndex: 1,
					endColumnIndex: 4,
					expectedIndent: 1,
				},
			],
		},
		{
			// Der einzeilige Fall allein reicht als Abdeckung nicht: eine Erkennung, die jede Zeile
			// mit führendem Leerzeichen pauschal als "gleiche Ebene, falsches Zeichen" behandelt,
			// kann ein echtes Dedent (hier die schließende Klammer von bar in Zeile 4) nicht mehr
			// davon unterscheiden, sobald die ganze Datei auf Leerzeichen umgestellt ist. Dann
			// kaskadiert die Fehlinterpretation über die Verschachtelung hinweg.
			name: 'space-indentation-nested-with-dedent',
			code: 'foo(\n  a = bar(\n    x = 1\n    y = 2\n  )\n  b = 3\n)',
			errors: [
				{
					code: ErrorCode.spaceIndentation,
					message: 'Indentation uses spaces instead of tabs. Expected 1 tab(s).',
					startRowIndex: 1,
					startColumnIndex: 0,
					endRowIndex: 1,
					endColumnIndex: 2,
					expectedIndent: 1,
				},
				{
					code: ErrorCode.spaceIndentation,
					message: 'Indentation uses spaces instead of tabs. Expected 2 tab(s).',
					startRowIndex: 2,
					startColumnIndex: 0,
					endRowIndex: 2,
					endColumnIndex: 4,
					expectedIndent: 2,
				},
				{
					code: ErrorCode.spaceIndentation,
					message: 'Indentation uses spaces instead of tabs. Expected 2 tab(s).',
					startRowIndex: 3,
					startColumnIndex: 0,
					endRowIndex: 3,
					endColumnIndex: 4,
					expectedIndent: 2,
				},
				{
					code: ErrorCode.spaceIndentation,
					message: 'Indentation uses spaces instead of tabs. Expected 1 tab(s).',
					startRowIndex: 4,
					startColumnIndex: 0,
					endRowIndex: 4,
					endColumnIndex: 2,
					expectedIndent: 1,
				},
				{
					code: ErrorCode.spaceIndentation,
					message: 'Indentation uses spaces instead of tabs. Expected 1 tab(s).',
					startRowIndex: 5,
					startColumnIndex: 0,
					endRowIndex: 5,
					endColumnIndex: 2,
					expectedIndent: 1,
				},
			],
		},
		//#endregion Einrückung
		{
			name: 'branching-error',
			code: '?(4)\n\t[4] =>\n\t\tlog(\n\t\t\t4)',
			errors: [
				{
					code: ErrorCode.unparsedRestOfRow,
					message: "multilineParser should parse until end of row",
					startRowIndex: 2,
					startColumnIndex: 5,
					endRowIndex: 2,
					endColumnIndex: 5,
				},
				{
					code: ErrorCode.expectedOneOf,
					startRowIndex: 3,
					startColumnIndex: 2,
					endRowIndex: 3,
					endColumnIndex: 2,
					message: "Expected one of: roundBracketedBaseParser,squareBracketedBaseParser,numberParser,,referenceParser",
				},
			],
		},
		{
			name: 'function-literal-return-type',
			code: '() :> [] => []',
			result: (() => {
				const functionLiteral: ParseFunctionLiteral = {
					"body": [
						{
							"endColumnIndex": 14,
							"endRowIndex": 0,
							"startColumnIndex": 12,
							"startRowIndex": 0,
							"type": "empty",
						},
					],
					"endColumnIndex": 14,
					"endRowIndex": 0,
					"params": {
						"endColumnIndex": 2,
						"endRowIndex": 0,
						"rest": undefined,
						"singleFields": [],
						"startColumnIndex": 0,
						"startRowIndex": 0,
						symbols: {},
						"type": "parameters",
					},
					"returnType": {
						"endColumnIndex": 8,
						"endRowIndex": 0,
						"startColumnIndex": 6,
						"startRowIndex": 0,
						"type": "empty",
					},
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"symbols": {},
					"type": "functionLiteral",
				};
				functionLiteral.body[0]!.parent = functionLiteral;
				functionLiteral.params.parent = functionLiteral;
				return [
					functionLiteral,
				];
			})(),
		},
		{
			name: 'type-function-type-literal',
			code: 'true :> []',
		},
		{
			name: 'uncomplete-nested-reference',
			code: 'a/',
			result: (() => {
				const nestedReference: ParseNestedReference = {
					"endColumnIndex": 2,
					"endRowIndex": 0,
					"nestedKey": undefined,
					"source": {
						"endColumnIndex": 1,
						"endRowIndex": 0,
						"name": {
							"endColumnIndex": 1,
							"endRowIndex": 0,
							"name": "a",
							"startColumnIndex": 0,
							"startRowIndex": 0,
							"type": "name",
						},
						"startColumnIndex": 0,
						"startRowIndex": 0,
						"type": "reference",
					},
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"type": "nestedReference",
				};
				nestedReference.source.parent = nestedReference;
				return [
					nestedReference,
				];
			})(),
			errors: [
				{
					"code": ErrorCode.expectedNestedKey,
					"endColumnIndex": 2,
					"endRowIndex": 0,
					"message": "Expected a nested key",
					"startColumnIndex": 1,
					"startRowIndex": 0,
				},
			],
		},
		{
			name: 'uncomplete-list',
			code: '[4 ]',
			result: (() => {
				const list: ParseListLiteral = {
					"endColumnIndex": 4,
					"endRowIndex": 0,
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"type": "list",
					"values": [
						{
							"endColumnIndex": 2,
							"endRowIndex": 0,
							"startColumnIndex": 1,
							"startRowIndex": 0,
							"type": "integer",
							"value": 4n,
						},
					],
				};
				list.values[0].parent = list;
				return [list];
			})(),
			errors: [
				{
					"code": ErrorCode.expectedExpression,
					"endColumnIndex": 3,
					"endRowIndex": 0,
					"message": "expression expected",
					"startColumnIndex": 3,
					"startRowIndex": 0,
				},
			],
		},
		{
			name: 'uncomplete-dictionary-field',
			code: '[\n\ta = \n]',
			result: (() => {
				const dictionary: ParseDictionaryLiteral = {
					"endColumnIndex": 1,
					"endRowIndex": 2,
					"fields": [
						{
							"description": undefined,
							"endColumnIndex": 5,
							"endRowIndex": 1,
							"name": {
								"endColumnIndex": 2,
								"endRowIndex": 1,
								"name": "a",
								// "parent": [Circular],
								"startColumnIndex": 1,
								"startRowIndex": 1,
								"type": "name",
							},
							// "parent": [Circular],
							"startColumnIndex": 1,
							"startRowIndex": 1,
							"type": "singleDictionaryField",
							"typeGuard": undefined,
							"value": undefined,
						},
					],
					"startColumnIndex": 0,
					"startRowIndex": 0,
					"symbols": {
						"a": {
							"description": undefined,
							"endColumnIndex": 2,
							"endRowIndex": 1,
							"functionParameterIndex": undefined,
							"startColumnIndex": 1,
							"startRowIndex": 1,
							"typeExpression": undefined,
						},
					},
					"type": "dictionary",
				};
				dictionary.fields[0].parent = dictionary;
				(dictionary.fields[0] as any).name.parent = dictionary.fields[0];
				dictionary.symbols.a!.definition = dictionary.fields[0] as any;
				return [
					dictionary,
				];
			})(),
			errors: [
				{
					"code": ErrorCode.assignedValueMissingForDictionaryField,
					"endColumnIndex": 5,
					"endRowIndex": 1,
					"message": "assignedValue missing for singleDictionaryField",
					"startColumnIndex": 1,
					"startRowIndex": 1,
				},
			],
		},
		//#region Datenklammer
		{
			// Ein Datenliteral muss eckig sein. Rund ist eine Bindungsstelle.
			name: 'data-literal-must-be-square',
			code: 'x = (1 2)',
			errors: [
				{
					"code": ErrorCode.dataLiteralMustUseSquareBrackets,
					"message": "data literal must use square brackets [ ]",
					"startRowIndex": 0,
					"startColumnIndex": 4,
					"endRowIndex": 0,
					"endColumnIndex": 9,
				},
			],
		},
		{
			// Die Argumentliste ist rund geschrieben, ihr Inhalt bleibt eine Kollektion.
			name: 'argument-list-stays-round',
			code: 'f(1 2)',
		},
		{
			// Leere Parameterliste: bindet nichts, matcht jeden Wert.
			name: 'empty-parameter-list-stays-round',
			code: '() => 1',
		},
		{
			// Eckig vor => ist kein Fehler, sondern der Parametertyp -
			// die beklammerte Entsprechung zu `Text => true`.
			name: 'square-before-arrow-is-parameter-type',
			code: '[Text Float] => true',
		},
		//#endregion Datenklammer
		//#region Import
		{
			// getImportedPaths sammelt Abhängigkeiten nur von der direkten Zuweisung
			// `x = import(...)` - ein bloßer Aufruf ohne Zuweisung wird laut TODO in
			// getImportedPaths (case 'functionCall': return;) heute stillschweigend übersprungen:
			// die Zieldatei landet nie in dependencies/parsedDocuments, der Checker fällt beim
			// Typchecken later lautlos auf Any zurück (checker.ts case 'import'). Das soll
			// stattdessen gemeldet werden, statt lautlos zu verpuffen.
			name: 'import-without-assignment-is-reported',
			code: 'import(§./some-file.jul§)',
			errors: [
				{
					code: ErrorCode.unsupportedImportPosition,
					message: 'import(...) is only supported as the direct value of a top-level definition or destructuring.',
					startRowIndex: 0,
					startColumnIndex: 0,
					endRowIndex: 0,
					endColumnIndex: 25,
				},
			],
		},
		//#endregion Import
		//#region Index
		{
			// Indizes sind 1-basiert, 0 ist also nie gültig. Die Meldung soll das sagen und auf
			// der 0 sitzen. Heute akzeptiert indexParser die 0 gar nicht erst, der choiceParser
			// fällt durch und meldet stattdessen "Expected a nested key" auf dem / — plus eine
			// zweite Meldung mit interner Parser-Formulierung.
			name: 'index-zero',
			code: 'a/0',
			errors: [
				{
					"code": ErrorCode.invalidIndexSyntax,
					"endColumnIndex": 3,
					"endRowIndex": 0,
					"message": "Invalid index 0, indexes start at 1",
					"startColumnIndex": 2,
					"startRowIndex": 0,
				},
			],
		},
		{
			// Gegenprobe: ein gültiger Index parst fehlerfrei
			name: 'index-one',
			code: 'a/1',
		},
		{
			// Führende Nullen lehnt die Regex selbst ab, dafür braucht es keine eigene Regel.
			// Die Meldung ist hier bewusst nicht poliert: die 1 bleibt liegen und zieht eine
			// Folgemeldung nach sich. Das nimmt der Test in Kauf, weil niemand einen Index mit
			// führender Null tippt — er hält nur fest, dass die Schreibweise ungültig bleibt.
			name: 'index-leading-zero',
			code: 'a/01',
			errors: [
				{
					"code": ErrorCode.invalidIndexSyntax,
					"endColumnIndex": 3,
					"endRowIndex": 0,
					"message": "Invalid index 0, indexes start at 1",
					"startColumnIndex": 2,
					"startRowIndex": 0,
				},
				{
					"code": ErrorCode.unparsedRestOfRow,
					"endColumnIndex": 3,
					"endRowIndex": 0,
					"message": "multilineParser should parse until end of row",
					"startColumnIndex": 3,
					"startRowIndex": 0,
				},
			],
		},
		//#endregion Index
	];

describe('Parser', () => {
	expectedResults.forEach(({ name, code, result, errors }) => {
		it(name ?? code, () => {
			const parserResult = parseCode(code, 'dummy.jul');
			// if (parserResult.errors?.length) {
			// 	console.log(parserResult.errors);
			// }
			expect(parserResult.unchecked.errors).to.deep.equal(errors ?? []);
			if (result) {
				expect(parserResult.unchecked.expressions).to.deep.equal(result);
			}
		});
	});
	// Die core-lib ist der beste Einzelindikator für die Grammatik: gut 1000 Zeilen
	// realistischer JUL-Code mit Parameterlisten, FunctionTypeLiterals, DictionaryTypes,
	// Spread/Rest, Multiline und Interpolation. Fehler dort werden sonst still ignoriert.
	it('core-lib parses without errors', () => {
		expect(parseFile(coreLibPath).unchecked.errors).to.deep.equal([]);
	});
	// Die Erkennung darf nicht an coreLibPath hängen: der Sprachserver läuft aus dem out
	// Verzeichnis der installierten Extension, geöffnet wird aber die Quelldatei im Repo.
	it('isCoreLibPath erkennt die core-lib unabhängig vom Verzeichnis', () => {
		expect(isCoreLibPath(coreLibPath)).to.equal(true);
		expect(isCoreLibPath('C:\\Projects\\privat\\JUL\\jul-compiler\\src\\core-lib.jul')).to.equal(true);
		expect(isCoreLibPath('/home/user/jul-compiler/src/core-lib.jul')).to.equal(true);
		expect(isCoreLibPath('C:\\Projects\\some-project\\src\\game-logic.jul')).to.equal(false);
		expect(isCoreLibPath('dummy.jul')).to.equal(false);
	});
});
