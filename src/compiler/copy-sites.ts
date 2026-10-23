import {
	ParseExpression,
	ParseFunctionLiteral,
	ParseReference,
	PositionedExpression,
	SymbolDefinition,
	forEachChild,
} from '../syntax-tree.js';

/**
 * Messinstrument für docs/backlog/inplace-mutationen.md: ordnet die Quelle einer Kopierstelle
 * (Spread, erstes Argument von setField und Co.) danach ein, ob sie in-place geändert werden dürfte.
 * Nur eine Näherung, kein Beweis: Sie entscheidet keine Emission, sondern beschriftet Zähler.
 */
export type CopySourceCategory =
	/** Die Quelle ist selbst ein frischer Ausdruck, etwa removeField(...).setField(...) */
	| 'freshInline'
	/** Frische lokale Bindung, vor der Kopierstelle nur gelesen und danach nicht mehr verwendet */
	| 'freshUnique'
	/** Frische lokale Bindung, die entkommt oder nach der Kopierstelle noch verwendet wird */
	| 'freshShared'
	/** Frische Bindung aus einer äußeren Funktion, etwa außerhalb des Branches definiert */
	| 'freshCaptured'
	/** Lokale Bindung aus dem Aufruf einer nicht als frisch bekannten Funktion */
	| 'localCall'
	| 'param'
	| 'path'
	| 'global'
	| 'other'
	;

/**
 * Builtins, die immer ein neues Objekt liefern, nie ihre Eingabe.
 */
const freshBuiltinNames = new Set([
	'setField',
	'setElement',
	'removeField',
	'map',
	'filter',
	'filterMap',
	'mapDictionary',
]);

export const copyingBuiltinNames = new Set([
	'setField',
	'setElement',
	'removeField',
]);

/**
 * copyExpression ist der kopierende Ausdruck (Dictionary- oder List-Literal, Aufruf), source die darin
 * kopierte Quelle. Feldzugriffe innerhalb von copyExpression zählen als vorher gelesen: Eine Mutation
 * berechnet die neuen Werte zuerst.
 */
export function classifyCopySource(source: ParseExpression, copyExpression: PositionedExpression): CopySourceCategory {
	switch (source.type) {
		case 'reference':
			return classifyReference(source, copyExpression);
		case 'nestedReference':
			return 'path';
		default:
			return isFreshExpression(source)
				? 'freshInline'
				: 'other';
	}
}

function isFreshExpression(expression: ParseExpression): boolean {
	switch (expression.type) {
		case 'dictionary':
		case 'list':
		case 'object':
			return true;
		case 'functionCall': {
			const functionExpression = expression.functionExpression;
			return functionExpression?.type === 'reference'
				&& freshBuiltinNames.has(functionExpression.name.name);
		}
		default:
			return false;
	}
}

function classifyReference(reference: ParseReference, copyExpression: PositionedExpression): CopySourceCategory {
	const name = reference.name.name;
	const resolved = resolveSymbol(reference, name);
	if (!resolved) {
		return 'global';
	}
	const { scope, symbol } = resolved;
	const definition = symbol.definition;
	if (definition?.type === 'parameter') {
		return 'param';
	}
	if (definition?.type !== 'definition'
		|| !definition.value) {
		return 'other';
	}
	const value = definition.value;
	if (!isFreshExpression(value)) {
		return value.type === 'functionCall'
			? 'localCall'
			: 'other';
	}
	if (getEnclosingFunction(reference) !== scope) {
		return 'freshCaptured';
	}
	return isOnlyReadBefore(reference, copyExpression, scope, name)
		? 'freshUnique'
		: 'freshShared';
}

/**
 * Wie der Checker: Scopes sind nur Funktionsliterale, außerhalb davon liegt die Datei.
 */
function resolveSymbol(
	expression: PositionedExpression,
	name: string,
): { scope: ParseFunctionLiteral; symbol: SymbolDefinition; } | undefined {
	let current = expression.parent;
	while (current) {
		if (current.type === 'functionLiteral') {
			const symbol = current.symbols[name];
			if (symbol) {
				return { scope: current, symbol: symbol };
			}
		}
		current = current.parent;
	}
	return undefined;
}

function getEnclosingFunction(expression: PositionedExpression): ParseFunctionLiteral | undefined {
	let current = expression.parent;
	while (current) {
		if (current.type === 'functionLiteral') {
			return current;
		}
		current = current.parent;
	}
	return undefined;
}

/**
 * Alle anderen Referenzen auf dieselbe Bindung sind Feldzugriffe (x/feld), die vor der Kopierstelle
 * enden oder in ihr liegen. Eine Referenz in einer inneren Funktion zählt als Entkommen, auch wenn sie
 * nur liest.
 */
function isOnlyReadBefore(
	copySource: ParseReference,
	copyExpression: PositionedExpression,
	scope: ParseFunctionLiteral,
	name: string,
): boolean {
	const visit = (expression: PositionedExpression): true | undefined => {
		if (expression.type === 'reference'
			&& expression !== copySource
			&& expression.name.name === name
			&& resolveSymbol(expression, name)?.scope === scope) {
			const parent = expression.parent;
			const isFieldRead = parent?.type === 'nestedReference'
				&& parent.source === expression;
			const isBefore = isDescendantOf(expression, copyExpression)
				|| expression.endRowIndex < copyExpression.startRowIndex
				|| (expression.endRowIndex === copyExpression.startRowIndex
					&& expression.endColumnIndex <= copyExpression.startColumnIndex);
			if (!isFieldRead
				|| !isBefore
				|| getEnclosingFunction(expression) !== scope) {
				return true;
			}
		}
		return forEachChild(expression, visit);
	};
	return !scope.body.some(expression => visit(expression));
}

function isDescendantOf(expression: PositionedExpression, ancestor: PositionedExpression): boolean {
	let current = expression.parent;
	while (current) {
		if (current === ancestor) {
			return true;
		}
		current = current.parent;
	}
	return false;
}
