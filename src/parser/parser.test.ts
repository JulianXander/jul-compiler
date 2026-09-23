import { expect } from 'chai';

import { BracketedExpression, forEachChild, ParseFunctionCall, ParseDictionaryLiteral, ParseDictionaryTypeLiteral, ParseExpression, ParseBranching, ParseFunctionLiteral, ParseFunctionTypeLiteral, ParseListLiteral, ParseNestedReference, ParseReference, ParseSingleDictionaryField, ParseSingleDefinition, ParseSingleDictionaryTypeField, ParseValueExpression, PositionedExpression } from '../syntax-tree.js';
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
			name: 'function-type-literal-pure',
			code: '(a: Integer) -> Integer',
		},
		{
			name: 'function-type-literal-impure',
			code: '(a: Integer) ~> Integer',
		},
		{
			name: 'function-literal-pure-arrow',
			code: '(a: Integer) -> Integer => a',
		},
		{
			name: 'function-literal-impure-arrow',
			code: '(a: Integer) ~> Integer => a',
		},
		{
			name: 'function-type-literal-in-params',
			code: '(callback: (v: Integer) -> Integer) :> Integer',
		},
		{
			name: 'function-type-literal-unknown',
			// Regression: der bestehende :> Zweig bleibt unverändert erreichbar.
			code: '(a: Integer) :> Integer',
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
			// Windows-Zeilenenden (CRLF): parseJulCode schneidet das '\r' ab und meldet dafür
			// pro betroffener Zeile einen eigenen Fehler, statt dass die Kaskade aus
			// unparsedRestOfRow/expectedOneOf entsteht.
			name: 'function-call-multiline-argument-with-crlf',
			code: 'myFunc(\r\n\t§someValue§\r\n)',
			errors: [
				{
					code: ErrorCode.windowsLineEnding,
					message: 'Line uses \\r\\n (Windows) instead of \\n as line ending.',
					startRowIndex: 0,
					startColumnIndex: 7,
					endRowIndex: 0,
					endColumnIndex: 8,
				},
				{
					code: ErrorCode.windowsLineEnding,
					message: 'Line uses \\r\\n (Windows) instead of \\n as line ending.',
					startRowIndex: 1,
					startColumnIndex: 12,
					endRowIndex: 1,
					endColumnIndex: 13,
				},
			],
		},
		{
			// Steht nach => gar nichts, fehlt der Rumpf. Der Knoten entsteht trotzdem mit leerem
			// body, damit die Definition ihren Wert behält. Gegenstück in checker.test.ts:
			// function-with-empty-body-does-not-throw.
			name: 'function-without-body',
			code: 'f = () =>',
			errors: [
				{
					"code": ErrorCode.expectedExpression,
					"endColumnIndex": 9,
					"endRowIndex": 0,
					"message": "expression expected after =>",
					"startColumnIndex": 7,
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
					"arrow": "unknown",
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
				functionLiteral.returnType!.parent = functionLiteral;
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
	// Die parent-Kette wird beim Parsen gesetzt, also bevor feststeht, welche Hülle im fertigen
	// Baum landet: derselbe Parser-Pfad läuft mehrfach über dieselbe Eingabe und reicht die
	// inneren Ergebnisse weiter, jede Hülle setzt parent auf sich selbst. Von tief innen führt
	// die Kette deshalb an einem verworfenen Knoten vorbei statt an den Baum, der ausgeliefert
	// wird. Still, weil bisher nur eine Ebene hochgeschaut wurde (getNameFromValue).
	it('parent-chain-leads-to-the-delivered-tree', () => {
		const code = `Tree = [
	value: Integer
	children: Or([] List(Tree))
]`;
		const parsed = parseCode(code, 'dummy.jul');
		const definition = parsed.unchecked.expressions![0]!;

		function findReference(expression: PositionedExpression): ParseReference | undefined {
			if (expression.type === 'reference'
				&& expression.name.name === 'Tree') {
				return expression;
			}
			return forEachChild(expression, findReference);
		}
		const reference = findReference(definition);
		expect(reference, 'Selbstreferenz Tree nicht gefunden').to.not.equal(undefined);

		let current: PositionedExpression | undefined = reference;
		let top: PositionedExpression | undefined;
		while (current) {
			top = current;
			current = current.parent;
		}
		expect(top).to.equal(definition);
	});
	// Belegt, dass die Pfeil-Art tatsächlich am Knoten ankommt - die Fälle ohne result oben
	// prüfen nur fehlerfreies Parsen, nicht den Inhalt.
	it('arrow landet an functionTypeLiteral und functionLiteral', () => {
		const functionType = parseCode('(a: Integer) -> Integer', 'dummy.jul')
			.unchecked.expressions![0] as ParseFunctionTypeLiteral;
		expect(functionType.type).to.equal('functionTypeLiteral');
		expect(functionType.arrow).to.equal('pure');

		const impureFunctionType = parseCode('(a: Integer) ~> Integer', 'dummy.jul')
			.unchecked.expressions![0] as ParseFunctionTypeLiteral;
		expect(impureFunctionType.arrow).to.equal('impure');

		const unknownFunctionType = parseCode('(a: Integer) :> Integer', 'dummy.jul')
			.unchecked.expressions![0] as ParseFunctionTypeLiteral;
		expect(unknownFunctionType.arrow).to.equal('unknown');

		const functionLiteral = parseCode('(a: Integer) -> Integer => a', 'dummy.jul')
			.unchecked.expressions![0] as ParseFunctionLiteral;
		expect(functionLiteral.type).to.equal('functionLiteral');
		expect(functionLiteral.arrow).to.equal('pure');

		const functionLiteralWithoutArrow = parseCode('(a) => a', 'dummy.jul')
			.unchecked.expressions![0] as ParseFunctionLiteral;
		expect(functionLiteralWithoutArrow.arrow).to.equal(undefined);
	});
});

//#region Mehrzeiliger Funktionskopf

const multilineHeadCases: {
	name: string;
	code: string;
	/** Gültiger Fall: gleiche AST-Struktur wie diese Form, Positionen und parent ausgenommen. */
	equivalentTo?: string;
	/** Zusätzliche Prüfung am ersten Ausdruck, für Fälle ohne einzeilige Entsprechung. */
	check?: (expression: ParseExpression) => void;
	/** Ungültiger Fall: erwartete Fehler, nur Code und Zeile. */
	errors?: { code: ErrorCode; row: number; }[];
	/** Anzahl der Ausdrücke auf oberster Ebene, belegt, dass der Rest der Datei nicht verloren geht. */
	expressionCount?: number;
}[] = [
		//#region => ohne Rumpf
		{
			name: 'B1 => ohne Rumpf am Dateiende',
			code: 'g = (a: Integer) =>',
			errors: [{ code: ErrorCode.expectedExpression, row: 0 }],
		},
		{
			name: 'B2 => ohne Rumpf vor weiterer Definition',
			code: 'g = (a: Integer) =>\nx = 1',
			errors: [{ code: ErrorCode.expectedExpression, row: 0 }],
			expressionCount: 2,
		},
		{
			name: 'B3 => ohne Rumpf, Block nur mit Kommentar',
			code: 'g = (a: Integer) =>\n\t# nur Kommentar\nx = 1',
			errors: [{ code: ErrorCode.expectedExpression, row: 0 }],
			expressionCount: 2,
		},
		{
			name: 'B4 => mit eingerücktem Rumpf',
			code: 'g = (a: Integer) =>\n\ta',
		},
		//#endregion => ohne Rumpf
		//#region gültig: Rückgabepfeil umgebrochen
		{
			name: 'G1 Pfeilzeilen mit Operand inline',
			code: 'f = (a: Integer)\n\t-> Integer\n\t=> a',
			equivalentTo: 'f = (a: Integer) -> Integer => a',
		},
		{
			name: 'G2 Rückgabetyp inline, Rumpf als Block',
			code: 'f = (a: Integer)\n\t-> Integer\n\t=>\n\t\tb = a\n\t\tb',
			equivalentTo: 'f = (a: Integer) -> Integer =>\n\tb = a\n\tb',
		},
		{
			name: 'G3 Rückgabetyp als Block, Rumpf inline',
			code: 'f = (a: Integer)\n\t->\n\t\tInteger\n\t=> a',
			equivalentTo: 'f = (a: Integer) -> Integer => a',
		},
		{
			name: 'G4 Rückgabetyp und Rumpf als Block',
			code: 'f = (a: Integer)\n\t->\n\t\tInteger\n\t=>\n\t\tb = a\n\t\tb',
			equivalentTo: 'f = (a: Integer) -> Integer =>\n\tb = a\n\tb',
		},
		{
			name: 'G5 mehrzeilige Parameterliste mit Pfeilzeilen',
			code: 'f = (\n\ta: Integer\n\tb: Integer\n)\n\t->\n\t\tInteger\n\t=>\n\t\tadd(a b)',
			equivalentTo: 'f = (\n\ta: Integer\n\tb: Integer\n) -> Integer =>\n\tadd(a b)',
		},
		{
			name: 'G6 Rückgabepfeil :>',
			code: 'f = (a: Integer)\n\t:> Integer\n\t=> a',
			equivalentTo: 'f = (a: Integer) :> Integer => a',
		},
		{
			name: 'G7 Rückgabepfeil ~>',
			code: 'f = (a: Integer)\n\t~> Integer\n\t=> a',
			equivalentTo: 'f = (a: Integer) ~> Integer => a',
		},
		//#endregion gültig: Rückgabepfeil umgebrochen
		//#region gültig: ohne Rumpf
		{
			name: 'G8 Funktionstyp, Rückgabetyp inline',
			code: 'F = (a: Integer)\n\t-> Integer',
			equivalentTo: 'F = (a: Integer) -> Integer',
		},
		{
			name: 'G9 Funktionstyp, Rückgabetyp als Block',
			code: 'F = (a: Integer)\n\t->\n\t\tInteger',
			equivalentTo: 'F = (a: Integer) -> Integer',
		},
		//#endregion gültig: ohne Rumpf
		//#region gültig: Typen, die den Block brauchen
		{
			name: 'G10 Branching als Rückgabetyp',
			code: 'f = (a: Integer)\n\t->\n\t\t?(a)\n\t\t\t[Integer] => Integer\n\t\t\t() => Text\n\t=> a',
			check: expression => {
				const value = definedValue(expression) as ParseFunctionLiteral;
				expect(value.type).to.equal('functionLiteral');
				const returnType = value.returnType as ParseBranching;
				expect(returnType.type).to.equal('branching');
				expect(returnType.branches).to.have.lengthOf(2);
			},
		},
		{
			name: 'G11 Funktionstyp als Rückgabetyp',
			code: 'F = (a: Integer)\n\t:>\n\t\t(b: Integer) :> Integer',
			check: expression => {
				const value = definedValue(expression) as ParseFunctionTypeLiteral;
				expect(value.type).to.equal('functionTypeLiteral');
				expect(value.returnType.type).to.equal('functionTypeLiteral');
			},
		},
		{
			name: 'G12 mehrere Ausdrücke im Typblock, der letzte gilt',
			code: 'F = (a: Integer)\n\t->\n\t\tText\n\t\tInteger',
			equivalentTo: 'F = (a: Integer) -> Integer',
		},
		//#endregion gültig: Typen, die den Block brauchen
		//#region gültig: bedingter Typ im Typblock
		// Der Knoten typeBranching ist unabhängig von branching (G10 bleibt branching).
		{
			name: 'PA1 bedingter Typ im Typblock',
			code: 'F = (a: Integer)\n\t->\n\t\t:?(TypeOf(a))\n\t\t\t[Integer] => Integer\n\t\t\t() => Text',
			check: expression => {
				const value = definedValue(expression) as ParseFunctionTypeLiteral;
				expect(value.type).to.equal('functionTypeLiteral');
				const returnType = value.returnType as unknown as TypeBranchingShape;
				expect(returnType.type).to.equal('typeBranching');
				expect(returnType.branches).to.have.lengthOf(2);
				expect(returnType.branches.map(branch => branch.type)).to.deep.equal(['functionLiteral', 'functionLiteral']);
			},
		},
		{
			name: 'PA2 bedingter Typ mit zwei Operanden',
			code: 'F = (a: Integer b: Integer)\n\t->\n\t\t:?(TypeOf(a) TypeOf(b))\n\t\t\t[Integer Integer] => Integer',
			check: expression => {
				const value = definedValue(expression) as ParseFunctionTypeLiteral;
				const returnType = value.returnType as unknown as TypeBranchingShape;
				expect(returnType.type).to.equal('typeBranching');
				expect(argumentCount(returnType.args)).to.equal(2);
				expect(returnType.branches).to.have.lengthOf(1);
			},
		},
		{
			name: 'PA3 bedingter Typ im Funktionskopf von nativeFunction',
			code: 'f = nativeFunction(\n\t(a: Integer)\n\t\t->\n\t\t\t:?(TypeOf(a))\n\t\t\t\t[Integer] => Integer\n\t\t\t\t() => Text\n\t§js\n\t\t(a) => a\n\t§\n)',
			check: expression => {
				const call = definedValue(expression) as ParseFunctionCall;
				expect(call.type).to.equal('functionCall');
				const args = argumentValues(call.arguments);
				expect(args).to.have.lengthOf(2);
				const functionType = args[0] as ParseFunctionTypeLiteral;
				expect(functionType.type).to.equal('functionTypeLiteral');
				expect(functionType.returnType.type).to.equal('typeBranching');
				expect(args[1]!.type).to.equal('text');
			},
		},
		//#endregion gültig: bedingter Typ im Typblock
		//#region gültig: Typ-Parameter als Kopf
		{
			name: 'G13 Typ-Parameter als Kopf',
			code: 'f = [Integer]\n\t-> Integer\n\t=> 1',
			equivalentTo: 'f = [Integer] -> Integer => 1',
		},
		{
			name: 'G14 Branching-Zweig mit Pfeilzeilen',
			code: 'x = ?(1)\n\t[Integer]\n\t\t-> Integer\n\t\t=> 1',
			equivalentTo: 'x = ?(1)\n\t[Integer] -> Integer => 1',
		},
		//#endregion gültig: Typ-Parameter als Kopf
		//#region gültig: Umbruch ohne Rückgabetyp
		{
			name: 'G15 nur =>-Zeile, Rumpf inline',
			code: 'f = (a: Integer)\n\t=> a',
			equivalentTo: 'f = (a: Integer) => a',
		},
		{
			name: 'G16 nur =>-Zeile, Rumpf als Block',
			code: 'f = (a: Integer)\n\t=>\n\t\tb = a\n\t\tb',
			equivalentTo: 'f = (a: Integer) =>\n\tb = a\n\tb',
		},
		{
			name: 'G17 mehrzeilige Parameterliste, nur =>-Zeile',
			code: 'f = (\n\ta: Integer\n)\n\t=> a',
			equivalentTo: 'f = (\n\ta: Integer\n) => a',
		},
		//#endregion gültig: Umbruch ohne Rückgabetyp
		//#region gültig: Mischform
		{
			name: 'G18 Rückgabetyp in der Kopfzeile, =>-Zeile mit Rumpf inline',
			code: 'f = (a: Integer) -> Integer\n\t=> a',
			equivalentTo: 'f = (a: Integer) -> Integer => a',
		},
		{
			name: 'G19 Rückgabetyp in der Kopfzeile, =>-Zeile mit Rumpf als Block',
			code: 'f = (a: Integer) -> Integer\n\t=>\n\t\tb = a\n\t\tb',
			equivalentTo: 'f = (a: Integer) -> Integer =>\n\tb = a\n\tb',
		},
		//#endregion gültig: Mischform
		//#region gültig: Kommentare und Leerzeilen
		{
			name: 'G20 Kommentar im Typblock',
			code: 'f = (a: Integer)\n\t->\n\t\t# Typ\n\t\tInteger\n\t=> a',
			check: expression => {
				const value = definedValue(expression) as ParseFunctionLiteral;
				expect(value.type).to.equal('functionLiteral');
				const returnType = value.returnType as ParseReference;
				expect(returnType.type).to.equal('reference');
				expect(returnType.name.name).to.equal('Integer');
			},
		},
		{
			name: 'G21 Leerzeile am Anfang des Typblocks',
			code: 'f = (a: Integer)\n\t->\n\n\t\tInteger\n\t=> a',
			equivalentTo: 'f = (a: Integer) -> Integer => a',
		},
		{
			name: 'G22 Leerzeile und Kommentar im Rumpf-Block',
			code: 'f = (a: Integer)\n\t-> Integer\n\t=>\n\t\tb = a\n\n\t\t# Ergebnis\n\t\tb',
		},
		{
			name: 'G23 Leerzeile zwischen Typblock und =>-Zeile',
			code: 'f = (a: Integer)\n\t->\n\t\tInteger\n\n\t=> a',
			equivalentTo: 'f = (a: Integer) -> Integer => a',
		},
		{
			name: 'G24 Kommentar zwischen Typblock und =>-Zeile',
			code: 'f = (a: Integer)\n\t->\n\t\tInteger\n\t# Rumpf\n\t=> a',
			equivalentTo: 'f = (a: Integer) -> Integer => a',
		},
		{
			name: 'G25 Kommentar zwischen Kopf und erster Pfeilzeile',
			code: 'f = (a: Integer)\n\t# Rückgabetyp\n\t-> Integer\n\t=> a',
			equivalentTo: 'f = (a: Integer) -> Integer => a',
		},
		{
			name: 'G26 Rückgabetypzeile auskommentiert',
			code: 'f = (a: Integer)\n\t# -> Integer\n\t=> a',
			equivalentTo: 'f = (a: Integer) => a',
		},
		{
			name: 'G27 Typblock auskommentiert',
			code: 'f = (a: Integer)\n\t# ->\n\t# \tInteger\n\t=> a',
			equivalentTo: 'f = (a: Integer) => a',
		},
		//#endregion gültig: Kommentare und Leerzeilen
		//#region gültig: Einbettung
		{
			name: 'G28 Funktionskopf als Argument',
			code: 'x = map(\n\tvalues\n\t(v: Integer)\n\t\t-> Integer\n\t\t=> v\n)',
			equivalentTo: 'x = map(\n\tvalues\n\t(v: Integer) -> Integer => v\n)',
		},
		{
			name: 'G29 Funktionskopf im Rumpf',
			code: 'g = () =>\n\tf = (a: Integer)\n\t\t-> Integer\n\t\t=> a\n\tf',
			equivalentTo: 'g = () =>\n\tf = (a: Integer) -> Integer => a\n\tf',
		},
		//#endregion gültig: Einbettung
		//#region gültig: in Kauf genommen
		{
			// Eine eingerückte =>-Zeile unter einem beliebigen Ausdruck wird zu dessen
			// Funktionskopf, genau wie die einzeilige Form.
			name: 'G30 eingerückte =>-Zeile unter einer Referenz',
			code: 'x = foo\n\t=> 1',
			equivalentTo: 'x = foo => 1',
		},
		//#endregion gültig: in Kauf genommen
		//#region ungültig
		{
			name: 'U1 Rückgabepfeil am Ende der Kopfzeile, Typ darunter',
			code: 'f = (a: Integer) ->\n\t\tInteger\n\t=> a',
			errors: [{ code: ErrorCode.misplacedArrow, row: 0 }],
		},
		{
			name: 'U2 Rückgabepfeil am Ende der Kopfzeile, nichts darunter',
			code: 'F = (a: Integer) ->',
			errors: [{ code: ErrorCode.misplacedArrow, row: 0 }],
		},
		{
			name: 'U3 => nach umgebrochenem Rückgabepfeil in derselben Zeile',
			code: 'f = (a: Integer)\n\t-> Integer => a',
			errors: [{ code: ErrorCode.misplacedArrow, row: 1 }],
		},
		{
			name: 'U4 Branching als Rückgabetyp in der Kopfzeile',
			code: 'f = (a: Integer) -> ?(a)\n\t[Integer] => Integer',
			errors: [{ code: ErrorCode.returnTypeRequiresBlock, row: 0 }],
		},
		{
			name: 'U5 Branching als Rückgabetyp inline in der Pfeilzeile',
			code: 'f = (a: Integer)\n\t-> ?(a)\n\t\t[Integer] => Integer\n\t=> a',
			errors: [{ code: ErrorCode.returnTypeRequiresBlock, row: 1 }],
		},
		{
			name: 'U6 :? als Rückgabetyp in der Kopfzeile',
			code: 'f = (a: Integer) -> :?(a)\n\t[Integer] => Integer',
			errors: [{ code: ErrorCode.returnTypeRequiresBlock, row: 0 }],
		},
		{
			name: 'U7 Funktionstyp als Rückgabetyp in der Kopfzeile',
			code: 'F = (a: Integer) :> (b: Integer) :> Integer',
			errors: [{ code: ErrorCode.returnTypeRequiresBlock, row: 0 }],
		},
		{
			name: 'U8 Funktionstyp als Rückgabetyp inline in der Pfeilzeile',
			code: 'F = (a: Integer)\n\t:> (b: Integer) :> Integer',
			errors: [{ code: ErrorCode.returnTypeRequiresBlock, row: 1 }],
		},
		// U9-U12: Ohne Pfeilzeilen bleibt vom Kopf nur das runde Datenliteral, daher zusätzlich JUL2105.
		{
			name: 'U9 Leerzeile zwischen Kopf und Pfeilzeile',
			code: 'f = (a: Integer)\n\n\t=> a',
			errors: [{ code: ErrorCode.dataLiteralMustUseSquareBrackets, row: 0 }, { code: ErrorCode.misplacedArrow, row: 2 }],
		},
		{
			name: 'U10 Kommentar in Spalte 0 beendet den Kopf',
			code: 'f = (a: Integer)\n#\t-> Integer\n\t=> a',
			errors: [{ code: ErrorCode.dataLiteralMustUseSquareBrackets, row: 0 }, { code: ErrorCode.misplacedArrow, row: 2 }],
		},
		{
			name: 'U11 Pfeilzeile auf Ebene des Kopfs',
			code: 'f = (a: Integer)\n=> a',
			errors: [{ code: ErrorCode.dataLiteralMustUseSquareBrackets, row: 0 }, { code: ErrorCode.misplacedArrow, row: 1 }],
		},
		{
			name: 'U12 Pfeilzeile zwei Ebenen zu tief',
			code: 'f = (a: Integer)\n\t\t=> a',
			errors: [{ code: ErrorCode.dataLiteralMustUseSquareBrackets, row: 0 }, { code: ErrorCode.unexpectedIndentation, row: 1 }],
		},
		{
			name: 'U13 =>-Zeile vor der Rückgabepfeil-Zeile',
			code: 'f = (a: Integer)\n\t=> a\n\t-> Integer',
			errors: [{ code: ErrorCode.misplacedArrow, row: 2 }],
		},
		{
			name: 'U14 zwei Rückgabepfeil-Zeilen',
			code: 'f = (a: Integer)\n\t-> Integer\n\t-> Text\n\t=> a',
			errors: [{ code: ErrorCode.misplacedArrow, row: 2 }],
		},
		{
			name: 'U15 zwei =>-Zeilen',
			code: 'f = (a: Integer)\n\t=> a\n\t=> a',
			errors: [{ code: ErrorCode.misplacedArrow, row: 2 }],
		},
		{
			name: 'U16 Rückgabepfeil-Zeile ohne Operand',
			code: 'f = (a: Integer)\n\t->\n\t=> a',
			errors: [{ code: ErrorCode.expectedExpression, row: 1 }],
		},
		{
			name: 'U17 =>-Zeile ohne Operand',
			code: 'f = (a: Integer)\n\t-> Integer\n\t=>',
			errors: [{ code: ErrorCode.expectedExpression, row: 2 }],
		},
		{
			name: 'U18 Definition im Typblock, Rest der Datei bleibt',
			code: 'f = (a: Integer)\n\t->\n\t\tA = Integer\n\t\tA\n\t=> a\ng = 1',
			errors: [{ code: ErrorCode.definitionNotAllowedForValueExpression, row: 2 }],
			expressionCount: 2,
		},
		{
			name: 'U19 halb getippt: Rückgabepfeil-Zeile ohne Typ',
			code: 'f = (a: Integer)\n\t->',
			errors: [{ code: ErrorCode.expectedExpression, row: 1 }],
			check: expression => {
				expect(definedValue(expression).type).to.equal('functionTypeLiteral');
			},
		},
		{
			name: 'U20 halb getippt: =>-Zeile ohne Rumpf',
			code: 'f = (a: Integer)\n\t=>',
			errors: [{ code: ErrorCode.expectedExpression, row: 1 }],
			check: expression => {
				const value = definedValue(expression) as ParseFunctionLiteral;
				expect(value.type).to.equal('functionLiteral');
				expect(value.body).to.deep.equal([]);
			},
		},
		{
			name: 'U21 Rückgabepfeil-Zeile nach Rückgabetyp in der Kopfzeile',
			code: 'f = (a: Integer) -> Integer\n\t-> Text\n\t=> a',
			errors: [{ code: ErrorCode.misplacedArrow, row: 1 }],
		},
		//#endregion ungültig
	];

/**
 * Wert einer Definition auf oberster Ebene, an dem die Fälle den Funktionsknoten prüfen.
 */
function definedValue(expression: ParseExpression): ParseValueExpression {
	expect(expression.type).to.equal('definition');
	const value = (expression as ParseSingleDefinition).value;
	expect(value, 'Definition ohne Wert').to.not.equal(undefined);
	return value!;
}

/**
 * Form, an der die Fälle den Knoten von `:?` prüfen, ohne den Knotentyp zu importieren.
 */
interface TypeBranchingShape {
	type: string;
	args?: BracketedExpression;
	branches: ParseValueExpression[];
}

/**
 * Werte einer Argumentliste, egal ob der Parser sie schon als Kollektion aufgelöst hat.
 */
function argumentValues(args: BracketedExpression | undefined): { type: string; }[] {
	if (!args) {
		return [];
	}
	switch (args.type) {
		case 'empty':
			return [];
		case 'binding':
		case 'data':
			// Ein Positionsargument steht vor der Auflösung im Namen des Felds.
			return args.fields.map(field => field.name);
		case 'dictionary':
		case 'dictionaryType':
			return args.fields;
		case 'list':
		case 'object':
			return args.values;
	}
}

function argumentCount(args: BracketedExpression | undefined): number {
	return argumentValues(args).length;
}

const positionKeys = new Set(['startRowIndex', 'startColumnIndex', 'endRowIndex', 'endColumnIndex', 'parent']);

/**
 * Entfernt Positionen und parent rekursiv, damit sich mehrzeilige und einzeilige Form
 * strukturell vergleichen lassen.
 */
function stripPositions(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stripPositions);
	}
	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			if (!positionKeys.has(key)) {
				result[key] = stripPositions(child);
			}
		}
		return result;
	}
	return value;
}

describe('Mehrzeiliger Funktionskopf', () => {
	multilineHeadCases.forEach(({ name, code, equivalentTo, check, errors, expressionCount }) => {
		it(name, () => {
			const parsed = parseCode(code, 'dummy.jul').unchecked;
			const actualErrors = parsed.errors.map(error => ({ code: error.code, row: error.startRowIndex }));
			expect(actualErrors).to.deep.equal(errors ?? []);
			for (const error of parsed.errors) {
				expect(error.message).to.not.match(/Parser/);
			}
			if (expressionCount !== undefined) {
				expect(parsed.expressions?.length).to.equal(expressionCount);
			}
			if (equivalentTo !== undefined) {
				const equivalent = parseCode(equivalentTo, 'dummy.jul').unchecked;
				expect(equivalent.errors, 'einzeilige Entsprechung muss fehlerfrei sein').to.deep.equal([]);
				expect(stripPositions(parsed.expressions)).to.deep.equal(stripPositions(equivalent.expressions));
				expect(stripPositions(parsed.symbols)).to.deep.equal(stripPositions(equivalent.symbols));
			}
			if (check) {
				check(parsed.expressions![0]!);
			}
		});
	});
});

//#endregion Mehrzeiliger Funktionskopf
