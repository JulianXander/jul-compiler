import { Name, ParseDictionaryTypeLiteral, ParseExpression, ParseFunctionCall, ParseParameterField, ParseParameterFields, ParseReference, ParseSingleDictionaryTypeField, ParseValueExpression, ParsedExpressions, Purity, SymbolTable } from '../syntax-tree.js';
import { isDefined, NonEmptyArray } from '../util.js';
import { CompilerError, Positioned } from '../compiler-errors.js';
import typescript, { ArrowFunction, BindingName, FunctionDeclaration, FunctionTypeNode, IndexSignatureDeclaration, LiteralTypeNode, Node, NodeArray, NumericLiteral, ParameterDeclaration, ParenthesizedTypeNode, PropertySignature, SourceFile, StringLiteral, TypeLiteralNode, TypeNode, TypeOperatorNode, TypeReferenceNode, UnionTypeNode, VariableStatement, ArrayTypeNode } from 'typescript';
import { createParseFunctionLiteral, createParseFunctionTypeLiteral, createParseParameters, fillSymbolTableWithFields } from './parser-utils.js';
const { createSourceFile, getJSDocCommentsAndTags, getJSDocTags, ScriptKind, ScriptTarget, SyntaxKind } = typescript;

export function parseTsCode(code: string, filePath = 'todo.ts'): ParsedExpressions {
	// Parent-Pointer braucht getJSDocCommentsAndTags
	// Auch .js wird als TS geparst, der Dateiname dient nur der Anzeige in Meldungen.
	const tsAst = createSourceFile(filePath, code, ScriptTarget.ESNext, true, ScriptKind.TS);
	const errors: CompilerError[] = [];
	const julExpressions = tsAst.statements.map(tsNode =>
		tsNodeToJulAst(tsNode, tsAst, errors))
		.filter(isDefined);
	return {
		expressions: julExpressions,
		errors: errors,
	};
}

function tsNodeToJulAst(tsNode: Node, sourceFile: SourceFile, errors: CompilerError[]): ParseExpression | undefined {
	const position = getPositionFromTsNode(tsNode, sourceFile);
	switch (tsNode.kind) {
		case SyntaxKind.NumericLiteral: {
			const numericLiteral = tsNode as NumericLiteral;
			return {
				type: 'float',
				value: +numericLiteral.text,
				...position,
			};
		}
		case SyntaxKind.StringLiteral: {
			const stringLiteral = tsNode as StringLiteral;
			return {
				type: 'text',
				values: [{
					type: 'textToken',
					value: stringLiteral.text,
				}],
				...position,
			};
		}
		case SyntaxKind.NullKeyword:
			return {
				type: 'empty',
				...position,
			};
		case SyntaxKind.ArrowFunction: {
			const arrowFunction = tsNode as ArrowFunction;
			return tsFunctionToJulAst(position, arrowFunction, arrowFunction.parameters, arrowFunction.type, sourceFile, errors);
		}
		case SyntaxKind.EmptyStatement:
			return undefined;
		case SyntaxKind.VariableStatement: {
			const variableStatement = tsNode as VariableStatement;
			const test = variableStatement.declarationList.declarations.map(declaration => {
				return {
					name: tsNameToJulName(declaration.name, sourceFile),
					value: declaration.initializer && tsNodeToJulAst(declaration.initializer, sourceFile, errors),
				};
			});
			const test1 = test[0]!;
			if (!test1.value
				|| !test1.name) {
				return undefined;
			}
			// TODO nur exported definitions lieferen?
			return {
				type: 'definition',
				description: getJsDocDescription(variableStatement, sourceFile),
				name: test1.name,
				value: test1.value as any,
				...position,
			};
		}
		case SyntaxKind.FunctionDeclaration: {
			const functionDeclaration = tsNode as FunctionDeclaration;
			const tsName = functionDeclaration.name;
			if (!tsName) {
				return undefined;
			}
			const julName = tsNameToJulName(tsName, sourceFile);
			if (!julName) {
				return undefined;
			}
			return {
				type: 'definition',
				description: getJsDocDescription(functionDeclaration, sourceFile),
				name: julName,
				value: tsFunctionToJulAst(position, functionDeclaration, functionDeclaration.parameters, functionDeclaration.type, sourceFile, errors),
				...position,
			};
		}
		case SyntaxKind.TypeAliasDeclaration:
			return undefined;
		default:
			return undefined;
	}
}

/**
 * Der Text des letzten JSDoc-Blocks vor dem Node, ohne Kommentarzeichen. Tags bleiben als
 * Textzeilen stehen. Gewöhnliche Kommentare (// und /* *\/) sind keine Beschreibung.
 */
function getJsDocDescription(tsNode: Node, sourceFile: SourceFile): string | undefined {
	const jsDoc = getJSDocCommentsAndTags(tsNode)
		.filter(jsDocOrTag => jsDocOrTag.kind === SyntaxKind.JSDoc)
		.at(-1);
	if (!jsDoc) {
		return undefined;
	}
	const description = jsDoc.getText(sourceFile)
		// ohne /** und */
		.slice(3, -2)
		.split(/\r?\n/)
		.map(row => row.replace(/^\s*\* ?/, ''))
		// @pure ist eine Aussage für den Checker, keine Beschreibung
		.filter(row => row.trim() !== '@pure')
		.join('\n')
		.trim();
	return description || undefined;
}

function tsFunctionToJulAst(
	position: Positioned,
	tsFunction: Node,
	parameters: NodeArray<ParameterDeclaration>,
	returnType: TypeNode | undefined,
	sourceFile: SourceFile,
	errors: CompilerError[],
) {
	return createParseFunctionLiteral(
		tsParametersToJulParameters(parameters, position, sourceFile, errors),
		// Die Annotation wird ungeprüft übernommen. Der Checker fällt auf sie zurück, weil der
		// Dummy-Rumpf nur Any liefert.
		returnType && tsTypeToJulType(returnType, sourceFile, errors),
		// TODO body, errors,
		// erstmal dummy body nativeValue([...]) damit returnType = Any inferred wird
		[
			{
				type: 'functionCall',
				functionExpression: {
					type: 'reference',
					name: {
						type: 'name',
						name: 'nativeValue',
						...position,
					},
					...position,
				},
				arguments: {
					type: 'list',
					values: [
						{
							type: 'text',
							values: [
								{
									type: 'textToken',
									value: '[...]'
								}
							],
							...position,
						}
					],
					...position,
				},
				...position,
			}
		],
		position,
		errors,
		getTsFunctionPurity(tsFunction),
	);
}

/**
 * Eine TS-Funktion gilt als unrein, außer ihr JSDoc trägt @pure. Die Zusicherung wird nicht
 * geprüft, den Rumpf sieht der Checker nicht. Kann ein Parameter eine Funktion aufnehmen, macht
 * der Checker aus @pure ein pureIfArgsPure.
 */
function getTsFunctionPurity(tsFunction: Node): Purity {
	return getJSDocTags(tsFunction).some(tag => tag.tagName.text === 'pure')
		? 'pure'
		: 'impure';
}

function tsParametersToJulParameters(
	tsParameters: NodeArray<ParameterDeclaration>,
	position: Positioned,
	sourceFile: SourceFile,
	errors: CompilerError[],
): ParseParameterFields {
	const singleFields: ParseParameterField[] = [];
	let rest: ParseParameterField | undefined;
	tsParameters.forEach(tsParameter => {
		// Ein Destructuring-Parameter hat keinen Namen, TS ruft aber positional auf: Weglassen würde
		// die folgenden Parameter verschieben. Er heißt deshalb nach seiner Position (ab 1).
		const julName = isTsBindingPattern(tsParameter.name)
			? {
				type: 'name' as const,
				name: `arg${singleFields.length + 1}`,
				...getPositionFromTsNode(tsParameter.name, sourceFile),
			}
			: tsNameToJulName(tsParameter.name, sourceFile);
		// this ist in TS eine reine Typangabe, kein Argument
		if (!julName
			|| julName.name === 'this') {
			return;
		}
		const julParameter: ParseParameterField = {
			type: 'parameter',
			name: julName,
			typeGuard: tsParameterToJulType(tsParameter, sourceFile, errors),
			...getPositionFromTsNode(tsParameter, sourceFile),
		};
		if (tsParameter.dotDotDotToken) {
			rest = julParameter;
		}
		else {
			singleFields.push(julParameter);
		}
	});
	return createParseParameters(singleFields, rest, position, errors);
}

/**
 * Die Annotation wird ungeprüft übernommen. Lässt sie sich nicht übersetzen, bleibt der Parameter
 * ungetypt.
 */
function tsParameterToJulType(
	tsParameter: ParameterDeclaration,
	sourceFile: SourceFile,
	errors: CompilerError[],
): ParseValueExpression | undefined {
	const tsType = tsParameter.type;
	const julType = tsType && tsTypeToJulType(tsType, sourceFile, errors);
	if (!julType) {
		return undefined;
	}
	// Ein Aufruf ohne Rest-Argumente kommt in JUL als Empty an, und am Rest-Parameter kann TS das
	// nicht mit | undefined annotieren. Optional und mit Default darf das Argument fehlen.
	return tsParameter.dotDotDotToken
		|| tsParameter.questionToken
		|| tsParameter.initializer
		? orEmpty(julType, tsType, sourceFile, errors)
		: julType;
}

//#region Typannotation

/**
 * Übersetzt eine TS-Typannotation rein syntaktisch in den JUL-Typausdruck, den man in JUL dafür
 * schreiben würde. Liefert undefined, wenn sich der Typ nicht übersetzen lässt - der Aufrufer
 * bleibt dann beim bisherigen Verhalten (Any). Eine unbekannte Typreferenz wird nie als
 * JUL-Referenz ausgegeben: ein Generic T oder ein Interface wäre in JUL nicht definiert.
 */
function tsTypeToJulType(
	tsType: TypeNode,
	sourceFile: SourceFile,
	errors: CompilerError[],
): ParseValueExpression | undefined {
	const position = getPositionFromTsNode(tsType, sourceFile);
	switch (tsType.kind) {
		case SyntaxKind.BigIntKeyword:
			return createReference('Integer', position);
		case SyntaxKind.NumberKeyword:
			return createReference('Float', position);
		case SyntaxKind.StringKeyword:
			return createReference('Text', position);
		case SyntaxKind.BooleanKeyword:
			return createReference('Boolean', position);
		case SyntaxKind.AnyKeyword:
		case SyntaxKind.UnknownKeyword:
			return createReference('Any', position);
		case SyntaxKind.NullKeyword:
		case SyntaxKind.UndefinedKeyword:
		case SyntaxKind.VoidKeyword:
			return { type: 'empty', ...position };
		case SyntaxKind.ParenthesizedType:
			return tsTypeToJulType((tsType as ParenthesizedTypeNode).type, sourceFile, errors);
		case SyntaxKind.LiteralType:
			return tsLiteralTypeToJulType(tsType as LiteralTypeNode, position);
		case SyntaxKind.ArrayType:
			return createCollection(
				'List',
				(tsType as ArrayTypeNode).elementType,
				position,
				sourceFile,
				errors);
		case SyntaxKind.TypeOperator: {
			const typeOperator = tsType as TypeOperatorNode;
			// readonly ändert nichts am Wert, keyof/unique lassen sich nicht übersetzen
			return typeOperator.operator === SyntaxKind.ReadonlyKeyword
				? tsTypeToJulType(typeOperator.type, sourceFile, errors)
				: undefined;
		}
		case SyntaxKind.TypeReference:
			return tsTypeReferenceToJulType(tsType as TypeReferenceNode, position, sourceFile, errors);
		case SyntaxKind.TypeLiteral:
			return tsTypeLiteralToJulType(tsType as TypeLiteralNode, position, sourceFile, errors);
		case SyntaxKind.UnionType:
			return tsUnionToJulType((tsType as UnionTypeNode).types, false, position, sourceFile, errors);
		case SyntaxKind.FunctionType:
			return tsFunctionTypeToJulType(tsType as FunctionTypeNode, position, sourceFile, errors);
		default:
			return undefined;
	}
}

/**
 * Für verschachtelte Stellen: dort ist Any genauer als gar nichts, z.B. Foo[] -> List(Any).
 */
function tsTypeToJulTypeOrAny(
	tsType: TypeNode,
	sourceFile: SourceFile,
	errors: CompilerError[],
): ParseValueExpression {
	return tsTypeToJulType(tsType, sourceFile, errors)
		?? createReference('Any', getPositionFromTsNode(tsType, sourceFile));
}

function tsLiteralTypeToJulType(
	literalType: LiteralTypeNode,
	position: Positioned,
): ParseValueExpression | undefined {
	const literal = literalType.literal;
	switch (literal.kind) {
		case SyntaxKind.StringLiteral:
			return {
				type: 'text',
				values: [{
					type: 'textToken',
					value: literal.text,
				}],
				...position,
			};
		case SyntaxKind.NumericLiteral:
			return {
				type: 'float',
				value: +literal.text,
				...position,
			};
		case SyntaxKind.BigIntLiteral:
			return {
				type: 'integer',
				// text endet auf n
				value: BigInt(literal.text.slice(0, -1)),
				...position,
			};
		case SyntaxKind.TrueKeyword:
			return createReference('true', position);
		case SyntaxKind.FalseKeyword:
			return createReference('false', position);
		case SyntaxKind.NullKeyword:
			return { type: 'empty', ...position };
		default:
			return undefined;
	}
}

function tsTypeReferenceToJulType(
	typeReference: TypeReferenceNode,
	position: Positioned,
	sourceFile: SourceFile,
	errors: CompilerError[],
): ParseValueExpression | undefined {
	const typeName = typeReference.typeName;
	if (typeName.kind !== SyntaxKind.Identifier) {
		return undefined;
	}
	const typeArguments = typeReference.typeArguments ?? [];
	switch (typeName.text) {
		case 'Array':
		case 'ReadonlyArray': {
			const [elementType] = typeArguments;
			return typeArguments.length === 1
				? createCollection('List', elementType!, position, sourceFile, errors)
				: undefined;
		}
		case 'Record': {
			const [keyType, valueType] = typeArguments;
			return typeArguments.length === 2
				&& keyType!.kind === SyntaxKind.StringKeyword
				? createCollection('Dictionary', valueType!, position, sourceFile, errors)
				: undefined;
		}
		case 'Error':
			return typeArguments.length
				? undefined
				: createReference('Error', position);
		default:
			return undefined;
	}
}

/**
 * Entweder eine reine Index-Signatur ({ [key: string]: T }) oder reine Properties
 * ({ a: T; b?: U }) - gemischte und leere Typliterale lassen sich nicht übersetzen.
 */
function tsTypeLiteralToJulType(
	typeLiteral: TypeLiteralNode,
	position: Positioned,
	sourceFile: SourceFile,
	errors: CompilerError[],
): ParseValueExpression | undefined {
	const members = typeLiteral.members;
	const firstMember = members[0];
	if (!firstMember) {
		// {} heißt in TS "alles außer null/undefined", nicht "leeres Objekt"
		return undefined;
	}
	if (firstMember.kind === SyntaxKind.IndexSignature) {
		const indexSignature = firstMember as IndexSignatureDeclaration;
		const keyType = indexSignature.parameters[0]?.type;
		if (members.length !== 1
			|| keyType?.kind !== SyntaxKind.StringKeyword) {
			return undefined;
		}
		return createCollection('Dictionary', indexSignature.type, position, sourceFile, errors);
	}
	const fields: ParseSingleDictionaryTypeField[] = [];
	for (const member of members) {
		if (member.kind !== SyntaxKind.PropertySignature) {
			return undefined;
		}
		const propertySignature = member as PropertySignature;
		const propertyName = propertySignature.name;
		if (propertyName.kind !== SyntaxKind.Identifier
			&& propertyName.kind !== SyntaxKind.StringLiteral) {
			return undefined;
		}
		const tsFieldType = propertySignature.type;
		const fieldType = tsFieldType && tsTypeToJulTypeOrAny(tsFieldType, sourceFile, errors);
		fields.push({
			type: 'singleDictionaryTypeField',
			name: {
				type: 'name',
				name: propertyName.text,
				...getPositionFromTsNode(propertyName, sourceFile),
			},
			typeGuard: fieldType && propertySignature.questionToken
				? orEmpty(fieldType, tsFieldType!, sourceFile, errors)
				: fieldType,
			...getPositionFromTsNode(member, sourceFile),
		});
	}
	const symbols: SymbolTable = {};
	fillSymbolTableWithFields(symbols, errors, fields, false);
	const dictionaryType: ParseDictionaryTypeLiteral = {
		type: 'dictionaryType',
		fields: fields as NonEmptyArray<ParseSingleDictionaryTypeField>,
		symbols: symbols,
		...position,
	};
	return dictionaryType;
}

/**
 * Ein Glied, das sich nicht übersetzen lässt, macht den ganzen Union unübersetzbar: Or(X Any)
 * wäre ohnehin Any. Empty steht vorne und nur einmal, wie in der core-lib (Or([] X)).
 */
function tsUnionToJulType(
	tsTypes: readonly TypeNode[],
	includeEmpty: boolean,
	position: Positioned,
	sourceFile: SourceFile,
	errors: CompilerError[],
): ParseValueExpression | undefined {
	const choices: ParseValueExpression[] = [];
	let emptyChoice: ParseValueExpression | undefined = includeEmpty
		? { type: 'empty', ...position }
		: undefined;
	for (const tsType of tsTypes) {
		const choice = tsTypeToJulType(tsType, sourceFile, errors);
		if (!choice) {
			return undefined;
		}
		if (choice.type === 'empty') {
			emptyChoice ??= choice;
		}
		else {
			choices.push(choice);
		}
	}
	const allChoices = emptyChoice
		? [emptyChoice, ...choices]
		: choices;
	if (allChoices.length === 1) {
		return allChoices[0];
	}
	return createCall('Or', allChoices, position);
}

/**
 * Die Parameternamen gehören zum Typ wie bei jeder JUL-Funktion, auch wenn TS den Callback
 * positional aufruft - wie die core-lib bei map. Ein Parameter ohne Namen (Destructuring) oder ein
 * generischer Callback macht den Funktionstyp deshalb unübersetzbar.
 */
function tsFunctionTypeToJulType(
	functionType: FunctionTypeNode,
	position: Positioned,
	sourceFile: SourceFile,
	errors: CompilerError[],
): ParseValueExpression | undefined {
	if (functionType.typeParameters
		|| functionType.parameters.some(parameter => parameter.name.kind !== SyntaxKind.Identifier)) {
		return undefined;
	}
	const tsReturnType = functionType.type;
	// void heißt am Callback "der Rückgabewert wird ignoriert", nicht "liefert nichts"
	const returnType = tsReturnType.kind === SyntaxKind.VoidKeyword
		? createReference('Any', getPositionFromTsNode(tsReturnType, sourceFile))
		: tsTypeToJulTypeOrAny(tsReturnType, sourceFile, errors);
	return createParseFunctionTypeLiteral(
		tsParametersToJulParameters(functionType.parameters, position, sourceFile, errors),
		returnType,
		'unknown',
		position,
		errors);
}

/**
 * Für optionale Felder und Parameter: der Typ darf zusätzlich fehlen.
 */
function orEmpty(
	julType: ParseValueExpression,
	tsType: TypeNode,
	sourceFile: SourceFile,
	errors: CompilerError[],
): ParseValueExpression {
	const position = getPositionFromTsNode(tsType, sourceFile);
	if (julType.type === 'empty') {
		return julType;
	}
	if (tsType.kind === SyntaxKind.UnionType) {
		return tsUnionToJulType((tsType as UnionTypeNode).types, true, position, sourceFile, errors) ?? julType;
	}
	return createCall('Or', [{ type: 'empty', ...position }, julType], position);
}

/**
 * Ohne Empty: In JUL gibt es keine leere Liste und kein leeres Dictionary, leer ist immer Empty.
 * Eine TS-Funktion, die leer liefern kann, muss daher undefined zurückgeben und das mit
 * | undefined annotieren.
 */
function createCollection(
	collectionName: 'List' | 'Dictionary',
	tsElementType: TypeNode,
	position: Positioned,
	sourceFile: SourceFile,
	errors: CompilerError[],
): ParseFunctionCall {
	const elementType = tsTypeToJulTypeOrAny(tsElementType, sourceFile, errors);
	return createCall(collectionName, [elementType], position);
}

function createCall(
	functionName: string,
	args: ParseValueExpression[],
	position: Positioned,
): ParseFunctionCall {
	return {
		type: 'functionCall',
		functionExpression: createReference(functionName, position),
		arguments: {
			type: 'list',
			values: args as NonEmptyArray<ParseValueExpression>,
			...position,
		},
		...position,
	};
}

function createReference(name: string, position: Positioned): ParseReference {
	return {
		type: 'reference',
		name: {
			type: 'name',
			name: name,
			...position,
		},
		...position,
	};
}

//#endregion Typannotation

function isTsBindingPattern(tsName: BindingName): boolean {
	return tsName.kind === SyntaxKind.ObjectBindingPattern
		|| tsName.kind === SyntaxKind.ArrayBindingPattern;
}

function tsNameToJulName(tsName: BindingName, sourceFile: SourceFile): Name | undefined {
	// TODO case BindingPattern
	let name: string;
	switch (tsName.kind) {
		case SyntaxKind.Identifier:
			name = tsName.text;
			break;
		case SyntaxKind.ObjectBindingPattern:
		case SyntaxKind.ArrayBindingPattern:
			const position = getPositionFromTsNode(tsName, sourceFile);
			console.error(`SyntaxKind for Name not implemented yet: ${SyntaxKind[tsName.kind]} in ${sourceFile.fileName}:${position.startRowIndex + 1}:${position.startColumnIndex + 1}`);
			return undefined;
		default:
			const assertNever: never = tsName;
			throw new Error(`Unexpected SyntaxKind for Name: ${SyntaxKind[(assertNever as BindingName).kind]}`);
	}
	return {
		type: 'name',
		name: name,
		...getPositionFromTsNode(tsName, sourceFile),
	};
}

function getPositionFromTsNode(tsNode: Node, sourceFile: SourceFile): Positioned {
	const start = sourceFile.getLineAndCharacterOfPosition(tsNode.getStart(sourceFile));
	const end = sourceFile.getLineAndCharacterOfPosition(tsNode.getEnd());
	return {
		startRowIndex: start.line,
		startColumnIndex: start.character,
		endRowIndex: end.line,
		endColumnIndex: end.character,
	};
}