import { Name, ParseExpression, ParseParameterField, ParseParameterFields, ParsedExpressions } from '../syntax-tree.js';
import { isDefined } from '../util.js';
import { Positioned } from '../compiler-errors.js';
import typescript, { ArrowFunction, BindingName, FunctionDeclaration, Node, NodeArray, NumericLiteral, ParameterDeclaration, SourceFile, StringLiteral, VariableStatement } from 'typescript';
import { createParseFunctionLiteral, createParseParameters } from './parser-utils.js';
const { createSourceFile, ScriptTarget, SyntaxKind } = typescript;

export function parseTsCode(code: string): ParsedExpressions {
	// TODO pass file name?
	const tsAst = createSourceFile('todo.ts', code, ScriptTarget.ESNext);
	const julExpressions = tsAst.statements.map(tsNode =>
		tsNodeToJulAst(tsNode, tsAst))
		.filter(isDefined);
	// TODO errors
	return {
		expressions: julExpressions,
		errors: [],
	};
}

function tsNodeToJulAst(tsNode: Node, sourceFile: SourceFile): ParseExpression | undefined {
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
			return tsFunctionToJulAst(position, arrowFunction.parameters, sourceFile);
		}
		case SyntaxKind.EmptyStatement:
			return undefined;
		case SyntaxKind.VariableStatement: {
			const variableStatement = tsNode as VariableStatement;
			const test = variableStatement.declarationList.declarations.map(declaration => {
				return {
					name: tsNameToJulName(declaration.name, sourceFile),
					value: declaration.initializer && tsNodeToJulAst(declaration.initializer, sourceFile),
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
				name: julName,
				value: tsFunctionToJulAst(position, functionDeclaration.parameters, sourceFile),
				...position,
			};
		}
		case SyntaxKind.TypeAliasDeclaration:
			return undefined;
		default:
			return undefined;
	}
}

function tsFunctionToJulAst(
	position: Positioned,
	parameters: NodeArray<ParameterDeclaration>,
	sourceFile: SourceFile,
) {
	return createParseFunctionLiteral(
		tsParametersToJulParameters(parameters, position, sourceFile),
		undefined,
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
		[],
	);
}

function tsParametersToJulParameters(
	tsParameters: NodeArray<ParameterDeclaration>,
	position: Positioned,
	sourceFile: SourceFile,
): ParseParameterFields {
	const julParameters = tsParameters.map(tsParameter => {
		const julName = tsNameToJulName(tsParameter.name, sourceFile);
		if (!julName) {
			return undefined;
		}
		const julParameter: ParseParameterField = {
			type: 'parameter',
			name: julName,
			...getPositionFromTsNode(tsParameter, sourceFile),
		};
		return julParameter;
	}).filter(isDefined);
	// TODO errors
	return createParseParameters(julParameters, undefined, position, []);
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
			console.error(`SyntaxKind for Name not implemented yet: ${SyntaxKind[tsName.kind]}`);
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