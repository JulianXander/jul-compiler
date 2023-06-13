import {
	BracketedExpressionBase,
	CheckedDestructuringField,
	CheckedDictionaryField,
	CheckedDictionaryTypeField,
	CheckedExpression,
	CheckedParameterField,
	CheckedParameterFields,
	CheckedSingleDictionaryField,
	CheckedSingleDictionaryTypeField,
	CheckedSpreadValueExpression,
	CheckedValueExpression,
	ParseExpression,
	ParseParameterField,
	ParseParameterFields,
	ParseSpreadValueExpression,
	ParseValueExpression,
	SimpleExpression,
	StringToken,
} from './syntax-tree.js';

/**
 * Gibt undefined zurück im Fehlerfall
 */
export function checkParseExpressions(parseExpressions: ParseValueExpression[]): CheckedValueExpression[] | undefined;
export function checkParseExpressions(parseExpressions: ParseExpression[]): CheckedExpression[] | undefined;
export function checkParseExpressions(parseExpressions: (ParseValueExpression | StringToken)[]): (CheckedValueExpression | StringToken)[] | undefined;
export function checkParseExpressions(parseExpressions: (ParseExpression | StringToken)[]): (CheckedExpression | StringToken)[] | undefined {
	return checkExpressions(parseExpressions, checkParseExpression);
}

function checkExpressions<T, U>(expressions: T[], checkFn: (x: T) => U | undefined): U[] | undefined {
	const checkedExpressions: U[] = [];
	for (const expression of expressions) {
		const checkedExpression = checkFn(expression);
		if (checkedExpression) {
			checkedExpressions.push(checkedExpression);
		}
		else {
			return undefined;
		}
	}
	return checkedExpressions;
}

function checkParseExpression(parseExpression: ParseValueExpression): CheckedValueExpression | undefined;
function checkParseExpression(parseExpression: ParseExpression): CheckedExpression | undefined;
function checkParseExpression(parseExpression: ParseValueExpression | StringToken): CheckedValueExpression | StringToken | undefined;
function checkParseExpression(parseExpression: ParseExpression | StringToken): CheckedExpression | StringToken | undefined;
function checkParseExpression(parseExpression: ParseExpression | StringToken): CheckedExpression | StringToken | undefined {
	switch (parseExpression.type) {
		case 'bracketed':
			return undefined;
		case 'branching': {
			const checkedValue = checkParseExpression(parseExpression.value);
			if (!checkedValue) {
				return undefined;
			}
			const checkedBranches = checkParseExpressions(parseExpression.branches);
			if (!checkedBranches) {
				return undefined;
			}
			return {
				type: 'branching',
				value: checkedValue,
				branches: checkedBranches,
			};
		}
		case 'definition': {
			const checkedTypeGuard = parseExpression.typeGuard && checkParseExpression(parseExpression.typeGuard);
			if (!checkedTypeGuard && parseExpression.typeGuard) {
				return undefined;
			}
			const checkedValue = checkParseExpression(parseExpression.value);
			if (!checkedValue) {
				return undefined;
			}
			const checkedFallback = parseExpression.fallback && checkParseExpression(parseExpression.fallback);
			if (!checkedFallback && parseExpression.fallback) {
				return undefined;
			}
			return {
				type: 'definition',
				name: parseExpression.name.name,
				typeGuard: checkedTypeGuard,
				value: checkedValue,
				fallback: checkedFallback,
			};
		}
		case 'destructuring': {
			const checkedValue = checkParseExpression(parseExpression.value);
			if (!checkedValue) {
				return undefined;
			}
			const checkedDefinitionFields = checkDestructuringFields(parseExpression.fields);
			if (!checkedDefinitionFields) {
				return undefined;
			}
			return {
				type: 'destructuring',
				fields: checkedDefinitionFields,
				value: checkedValue,
			};
		}
		case 'dictionary': {
			const checkedFields = checkExpressions(
				parseExpression.fields,
				parseField => {
					switch (parseField.type) {
						case 'singleDictionaryField': {
							const checkedName = getCheckedEscapableName(parseField.name);
							if (!checkedName) {
								return undefined;
							}
							const checkedTypeGuard = parseField.typeGuard && checkParseExpression(parseField.typeGuard);
							if (!checkedTypeGuard && parseField.typeGuard) {
								return undefined;
							}
							const checkedValue = checkParseExpression(parseField.value);
							if (!checkedValue) {
								return undefined;
							}
							const checkedFallback = parseField.fallback && checkParseExpression(parseField.fallback);
							if (!checkedFallback && parseField.fallback) {
								return undefined;
							}
							const checkedField: CheckedSingleDictionaryField = {
								type: 'singleDictionaryField',
								name: checkedName,
								typeGuard: checkedTypeGuard,
								value: checkedValue,
								fallback: checkedFallback,
							};
							return checkedField;
						}
						case 'spread':
							return checkSpreadExpression(parseField);
						default: {
							const assertNever: never = parseField;
							throw new Error(`Unexpected parseField.type: ${(assertNever as CheckedDictionaryField).type}`);
						}
					}
				});
			if (!checkedFields) {
				return undefined;
			}
			return {
				type: 'dictionary',
				fields: checkedFields as any,
			};
		}
		case 'dictionaryType': {
			const checkedFields = checkExpressions(
				parseExpression.fields,
				parseField => {
					switch (parseField.type) {
						case 'singleDictionaryTypeField': {
							const checkedName = getCheckedEscapableName(parseField.name);
							if (!checkedName) {
								return undefined;
							}
							const checkedTypeGuard = parseField.typeGuard && checkParseExpression(parseField.typeGuard);
							if (!checkedTypeGuard && parseField.typeGuard) {
								return undefined;
							}
							const checkedField: CheckedSingleDictionaryTypeField = {
								type: 'singleDictionaryTypeField',
								name: checkedName,
								typeGuard: checkedTypeGuard,
							};
							return checkedField;
						}
						case 'spread':
							return checkSpreadExpression(parseField);
						default: {
							const assertNever: never = parseField;
							throw new Error(`Unexpected parseField.type: ${(assertNever as CheckedDictionaryTypeField).type}`);
						}
					}
				});
			if (!checkedFields) {
				return undefined;
			}
			return {
				type: 'dictionaryType',
				fields: checkedFields as any,
			};
		}
		case 'empty':
			return {
				type: 'empty',
			};
		case 'field':
			return undefined;
		case 'float':
			return parseExpression;
		case 'fraction':
			return parseExpression;
		case 'functionCall': {
			const checkedArguments = checkParseExpression(parseExpression.arguments);
			if (!checkedArguments) {
				return undefined;
			}
			return {
				type: 'functionCall',
				functionReference: parseExpression.functionReference,
				arguments: checkedArguments as any
			};
		}
		case 'functionLiteral': {
			const checkedParams = checkParameters(parseExpression.params);
			if (!checkedParams) {
				return undefined;
			}
			const checkedBody = checkParseExpressions(parseExpression.body);
			if (!checkedBody) {
				return undefined;
			}
			return {
				type: 'functionLiteral',
				params: checkedParams,
				body: checkedBody,
			};
		}
		case 'functionTypeLiteral': {
			// TODO
			// const checkedParams = checkParameters(parseExpression.params);
			// if (!checkedParams) {
			// 	return undefined;
			// }
			// const checkedBody = checkParseExpressions(parseExpression.body);
			// if (!checkedBody) {
			// 	return undefined;
			// }
			// return {
			// 	type: 'functionTypeLiteral',
			// 	params: checkedParams,
			// 	body: checkedBody,
			// };
			return {
				type: 'empty',
			};
		}
		case 'integer':
			return parseExpression;
		case 'list': {
			const checkedValues = checkExpressions(
				parseExpression.values,
				expression => {
					switch (expression.type) {
						case 'spread':
							return checkSpreadExpression(expression);
						default:
							return checkParseExpression(expression);
					}
				});
			if (!checkedValues) {
				return undefined;
			}
			return {
				type: 'list',
				values: checkedValues as any,
			};
		}
		case 'object': {
			const checkedValues = checkExpressions(
				parseExpression.values,
				checkSpreadExpression);
			if (!checkedValues) {
				return undefined;
			}
			return {
				type: 'object',
				values: checkedValues as any,
			};
		}
		case 'reference':
			return parseExpression;
		case 'string': {
			const checkedValues = checkParseExpressions(parseExpression.values);
			if (!checkedValues) {
				return undefined;
			}
			return {
				type: 'string',
				values: checkedValues,
			};
		}
		case 'stringToken':
			return parseExpression;
		default: {
			const assertNever: never = parseExpression;
			throw new Error(`Unexpected parseExpression.type: ${(assertNever as ParseExpression).type}`);
		}
	}
}

function checkSpreadExpression(spreadExpression: ParseSpreadValueExpression): CheckedSpreadValueExpression | undefined {
	const checkedValue = checkParseExpression(spreadExpression.value);
	if (!checkedValue) {
		return undefined;
	}
	const checkedSpread: CheckedSpreadValueExpression = {
		type: 'spread',
		value: checkedValue,
	};
	return checkedSpread;
}

function checkDestructuringFields(parseDefinitionFields: BracketedExpressionBase): CheckedDestructuringField[] | undefined {
	return checkExpressions(
		parseDefinitionFields.fields,
		parseField => {
			const checkedName = getCheckedName(parseField.name);
			if (!checkedName) {
				return undefined;
			}
			const checkedTypeGuard = parseField.typeGuard && checkParseExpression(parseField.typeGuard);
			if (!checkedTypeGuard && parseField.typeGuard) {
				return undefined;
			}
			const checkedSource = parseField.assignedValue && getCheckedName(parseField.assignedValue);
			if (!checkedSource && parseField.assignedValue) {
				return undefined;
			}
			const checkedFallback = parseField.fallback && checkParseExpression(parseField.fallback);
			if (!checkedFallback && parseField.fallback) {
				return undefined;
			}
			return {
				spread: parseField.spread,
				name: checkedName,
				typeGuard: checkedTypeGuard,
				source: checkedSource,
				fallback: checkedFallback,
			};
		}
	);
}

function checkParameters(parseParameters: SimpleExpression | ParseParameterFields): CheckedValueExpression | CheckedParameterFields | undefined {
	if (parseParameters.type === 'bracketed') {
		return undefined;
	}
	if (parseParameters.type !== 'parameters') {
		return checkParseExpression(parseParameters);
	}
	const parseSingleFields = parseParameters.singleFields;
	const checkedSingleFields: CheckedParameterField[] = [];
	for (let index = 0; index < parseSingleFields.length; index++) {
		const parseField = parseSingleFields[index]!;
		const checkedField = checkParameterField(parseField);
		if (!checkedField) {
			return undefined;
		}
		checkedSingleFields.push(checkedField);
	}
	let checkedRest: CheckedParameterField | undefined;
	const parseRest = parseParameters.rest;
	if (parseRest) {
		checkedRest = checkParameterField(parseRest);
		if (!checkedRest) {
			return undefined;
		}
	}
	return {
		type: 'parameters',
		singleFields: checkedSingleFields,
		rest: checkedRest,
	};
}

function checkParameterField(parseField: ParseParameterField): CheckedParameterField | undefined {
	const checkedTypeGuard = parseField.typeGuard && checkParseExpression(parseField.typeGuard);
	if (!checkedTypeGuard && parseField.typeGuard) {
		return undefined;
	}
	const checkedFallback = parseField.fallback && checkParseExpression(parseField.fallback);
	if (!checkedFallback && parseField.fallback) {
		return undefined;
	}
	const checkedField: CheckedParameterField = {
		name: parseField.name.name,
		typeGuard: checkedTypeGuard,
		source: parseField.source,
		fallback: checkedFallback,
	};
	return checkedField;
}

export function getCheckedName(parseName: ParseValueExpression): string | undefined {
	if (parseName.type !== 'reference') {
		return undefined;
	}
	if (parseName.path.length > 1) {
		return undefined;
	}
	return parseName.path[0].name;
}

export function getCheckedEscapableName(parseName: ParseValueExpression): string | undefined {
	switch (parseName.type) {
		case 'reference':
			if (parseName.path.length > 1) {
				return undefined;
			}
			return parseName.path[0].name;
		case 'string':
			if (parseName.values.length > 1) {
				return undefined;
			}
			const value = parseName.values[0];
			if (value?.type !== 'stringToken') {
				return undefined;
			}
			return value.value;
		default:
			return undefined;
	}
}