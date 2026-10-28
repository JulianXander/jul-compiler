import { parseCode } from '../parser/parser.js';
import { forEachChild, ParseExpression, PositionedExpression } from '../syntax-tree.js';

/**
 * Bringt Klammerlisten in die Form, die das Zeichen hinter der öffnenden Klammer vorgibt:
 * - Zeilenumbruch: jedes Feld in einer eigenen Zeile, eine Ebene tiefer eingerückt, die
 *   schließende Klammer in einer eigenen Zeile.
 * - sonst: alle Felder mit Leerzeichen getrennt hinter der öffnenden Klammer, die schließende
 *   Klammer direkt hinter dem letzten Feld.
 * Ein Feld mit Blockrumpf (Lambda, Branching) erzwingt die mehrzeilige Form, weil es keine
 * einzeilige gibt. Felder werden wörtlich aus dem Quelltext übernommen und nur ein- oder ausgerückt.
 */

//#region API

export interface FormatEdit {
	startRowIndex: number;
	startColumnIndex: number;
	endRowIndex: number;
	endColumnIndex: number;
	newText: string;
}

export interface FormatPosition {
	rowIndex: number;
	columnIndex: number;
}

export interface FormatOptions {
	/**
	 * Nur die innerste Klammerliste an dieser Stelle samt der Listen darin formatieren. Die Stelle
	 * liegt zwischen den Feldern der Liste oder am Anfang eines Felds, nicht mitten in einem Feld.
	 * Gibt es dort keine Liste, bleibt der Code unverändert.
	 */
	at?: FormatPosition;
	/**
	 * Die Liste an `at` mehrzeilig schreiben, unabhängig vom Zeichen hinter der Klammer.
	 */
	multiline?: boolean;
}

/**
 * Schranke für die Durchgänge, je Durchgang wird eine Verschachtelungsebene je Pfad umgestellt.
 */
const maxPasses = 50;

/**
 * Formatierter Code, oder der unveränderte, wenn sich der Syntaxbaum (ohne Positionen) dabei
 * ändern würde.
 */
export function formatCode(code: string, filePath: string, options: FormatOptions = {}): string {
	if (code.includes('\r')) {
		// Windows-Zeilenenden meldet der Parser als Fehler, die Spaltenlogik hier rechnet ohne \r.
		return code;
	}
	const originalExpressions = parseCode(code, filePath).syntax.expressions ?? [];
	let region: Region | undefined;
	if (options.at) {
		const target = findBracketListAt(originalExpressions, code.split('\n'), options.at);
		if (!target) {
			return code;
		}
		region = {
			startRowIndex: target.startRowIndex,
			startColumnIndex: target.startColumnIndex,
			endRowIndex: target.endRowIndex,
			multiline: !!options.multiline,
		};
	}
	let formatted = code;
	let expressions = originalExpressions;
	for (let pass = 0; pass < maxPasses; pass++) {
		const rows = formatted.split('\n');
		const edits = getPassEdits(rows, expressions, region);
		if (!edits.length) {
			break;
		}
		formatted = applyEdits(rows, edits);
		expressions = parseCode(formatted, filePath).syntax.expressions ?? [];
	}
	if (formatted === code || !isStructurallyEqual(originalExpressions, expressions)) {
		return code;
	}
	return formatted;
}

/**
 * Ein Edit über den geänderten Bereich, leer, wenn nichts zu tun ist.
 */
export function getFormatEdits(code: string, filePath: string, options?: FormatOptions): FormatEdit[] {
	return getDiffEdits(code, formatCode(code, filePath, options));
}

/**
 * Ein Edit, der code in formatted überführt, über den Bereich zwischen gemeinsamem Anfang und
 * gemeinsamem Ende. Leer, wenn beide gleich sind.
 */
export function getDiffEdits(code: string, formatted: string): FormatEdit[] {
	if (formatted === code) {
		return [];
	}
	let prefixLength = 0;
	const minLength = Math.min(code.length, formatted.length);
	while (prefixLength < minLength && code[prefixLength] === formatted[prefixLength]) {
		prefixLength++;
	}
	let suffixLength = 0;
	while (suffixLength < minLength - prefixLength
		&& code[code.length - 1 - suffixLength] === formatted[formatted.length - 1 - suffixLength]) {
		suffixLength++;
	}
	const start = offsetToPosition(code, prefixLength);
	const end = offsetToPosition(code, code.length - suffixLength);
	return [{
		startRowIndex: start.rowIndex,
		startColumnIndex: start.columnIndex,
		endRowIndex: end.rowIndex,
		endColumnIndex: end.columnIndex,
		newText: formatted.substring(prefixLength, formatted.length - suffixLength),
	}];
}

//#endregion API

//#region Durchgang

/**
 * Die Liste aus FormatOptions.at und ihre Zeilen. Der Anfang bleibt über die Durchgänge gleich,
 * weil alle Edits an ihm oder dahinter liegen, das Ende wandert mit den eingefügten Zeilen.
 */
interface Region {
	startRowIndex: number;
	startColumnIndex: number;
	endRowIndex: number;
	multiline: boolean;
}

/**
 * Edits für die äußersten Klammerlisten, die nicht in ihrer Form stehen. Darin Verschachteltes
 * kommt im nächsten Durchgang dran, nachdem neu geparst wurde. Mit region nur die Listen darin,
 * deren Ende wird dabei nachgeführt.
 */
function getPassEdits(rows: string[], expressions: ParseExpression[], region: Region | undefined): FormatEdit[] {
	const edits: FormatEdit[] = [];
	let addedRowCount = 0;
	const visit = (expression: PositionedExpression): undefined => {
		if (region && !isInRegion(expression, region)) {
			if (overlapsRegion(expression, region)) {
				forEachChild(expression, visit);
			}
			return undefined;
		}
		if (isBracketList(expression, rows)) {
			const forceMultiline = !!region?.multiline
				&& expression.startRowIndex === region.startRowIndex
				&& expression.startColumnIndex === region.startColumnIndex;
			const newText = renderBracketList(expression, rows, forceMultiline);
			if (newText !== undefined) {
				edits.push({
					startRowIndex: expression.startRowIndex,
					startColumnIndex: expression.startColumnIndex,
					endRowIndex: expression.endRowIndex,
					endColumnIndex: expression.endColumnIndex,
					newText: newText,
				});
				addedRowCount += newText.split('\n').length - 1 - (expression.endRowIndex - expression.startRowIndex);
				return undefined;
			}
		}
		forEachChild(expression, visit);
		return undefined;
	};
	expressions.forEach(visit);
	if (region) {
		region.endRowIndex += addedRowCount;
	}
	return edits;
}

function isInRegion(expression: PositionedExpression, region: Region): boolean {
	return comparePositions(expression.startRowIndex, expression.startColumnIndex, region.startRowIndex, region.startColumnIndex) >= 0
		&& expression.endRowIndex <= region.endRowIndex;
}

function overlapsRegion(expression: PositionedExpression, region: Region): boolean {
	return expression.startRowIndex <= region.endRowIndex
		&& comparePositions(expression.endRowIndex, expression.endColumnIndex, region.startRowIndex, region.startColumnIndex) > 0;
}

/**
 * Die innerste Klammerliste, in der die Stelle hinter der öffnenden und vor der schließenden
 * Klammer liegt, aber nicht mitten in einem ihrer Felder (am Anfang eines Felds zählt zur Liste).
 * Liegt die Stelle mitten in einem Feld ohne Liste darin, gibt es keine.
 */
function findBracketListAt(
	expressions: ParseExpression[],
	rows: string[],
	position: FormatPosition,
): PositionedExpression | undefined {
	const visit = (expression: PositionedExpression): PositionedExpression | undefined => {
		if (!containsStrictly(expression, position)) {
			return undefined;
		}
		if (!isBracketList(expression, rows)) {
			return forEachChild(expression, visit);
		}
		const field = getChildren(expression).find(child => containsStrictly(child, position));
		return field
			? visit(field)
			: expression;
	};
	for (const expression of expressions) {
		const found = visit(expression);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function containsStrictly(expression: PositionedExpression, position: FormatPosition): boolean {
	return comparePositions(position.rowIndex, position.columnIndex, expression.startRowIndex, expression.startColumnIndex) > 0
		&& comparePositions(position.rowIndex, position.columnIndex, expression.endRowIndex, expression.endColumnIndex) < 0;
}

function comparePositions(rowA: number, columnA: number, rowB: number, columnB: number): number {
	return rowA === rowB
		? columnA - columnB
		: rowA - rowB;
}

/**
 * Edits dürfen sich nicht überlappen, getPassEdits liefert sie in Quelltextreihenfolge.
 */
function applyEdits(rows: string[], edits: FormatEdit[]): string {
	const rowOffsets: number[] = [];
	let offset = 0;
	for (const row of rows) {
		rowOffsets.push(offset);
		offset += row.length + 1;
	}
	const code = rows.join('\n');
	let result = '';
	let lastOffset = 0;
	for (const edit of edits) {
		const startOffset = rowOffsets[edit.startRowIndex]! + edit.startColumnIndex;
		result += code.substring(lastOffset, startOffset) + edit.newText;
		lastOffset = rowOffsets[edit.endRowIndex]! + edit.endColumnIndex;
	}
	return result + code.substring(lastOffset);
}

//#endregion Durchgang

//#region Klammerliste

const closingCharacters: { [opening: string]: string; } = {
	'(': ')',
	'[': ']',
};

/**
 * Knotentypen, die aus einer Klammerliste entstehen. Ob der Knoten tatsächlich geklammert ist,
 * zeigen erst die Zeichen an seinen Enden (eine Argumentliste ohne Klammern gibt es auch).
 */
const bracketListTypes = new Set<string>([
	'binding',
	'data',
	'list',
	'object',
	'dictionary',
	'dictionaryType',
	'destructuringFields',
	'parameters',
]);

function isBracketList(expression: PositionedExpression, rows: string[]): boolean {
	if (!bracketListTypes.has(expression.type)) {
		return false;
	}
	const opening = rows[expression.startRowIndex]?.[expression.startColumnIndex];
	const closing = rows[expression.endRowIndex]?.[expression.endColumnIndex - 1];
	return opening !== undefined
		&& closing !== undefined
		&& closingCharacters[opening] === closing;
}

/**
 * Neuer Text vom öffnenden bis zum schließenden Zeichen, undefined, wenn die Liste schon in ihrer
 * Form steht oder sich nicht umstellen lässt.
 */
function renderBracketList(list: PositionedExpression, rows: string[], forceMultiline: boolean): string | undefined {
	const fields = getChildren(list);
	if (!fields.length) {
		return undefined;
	}
	const openingRow = rows[list.startRowIndex]!;
	const opening = openingRow[list.startColumnIndex]!;
	const closing = closingCharacters[opening]!;
	const indent = getTabCount(openingRow);
	const isMultiline = forceMultiline
		|| list.startColumnIndex + 1 === openingRow.length
		|| fields.some(hasBlockBody);
	if (isMultiline) {
		if (isMultilineForm(list, fields, rows, indent)) {
			return undefined;
		}
		return renderMultiline(list, fields, rows, indent, opening, closing);
	}
	if (isInlineForm(list, fields, rows)) {
		return undefined;
	}
	return renderInline(list, fields, rows, indent, opening, closing);
}

function isMultilineForm(
	list: PositionedExpression,
	fields: PositionedExpression[],
	rows: string[],
	indent: number,
): boolean {
	let previousEndRowIndex = list.startRowIndex;
	for (const field of fields) {
		if (field.startRowIndex <= previousEndRowIndex) {
			return false;
		}
		previousEndRowIndex = field.endRowIndex;
	}
	return list.endRowIndex > previousEndRowIndex
		&& list.endColumnIndex - 1 === indent
		&& getTabCount(rows[list.endRowIndex]!) === indent;
}

function isInlineForm(
	list: PositionedExpression,
	fields: PositionedExpression[],
	rows: string[],
): boolean {
	let previousEndRowIndex = list.startRowIndex;
	let expectedColumnIndex = list.startColumnIndex + 1;
	for (const field of fields) {
		if (field.startRowIndex !== previousEndRowIndex || field.startColumnIndex !== expectedColumnIndex) {
			return false;
		}
		if (expectedColumnIndex > list.startColumnIndex + 1
			&& rows[field.startRowIndex]![field.startColumnIndex - 1] !== ' ') {
			return false;
		}
		previousEndRowIndex = field.endRowIndex;
		expectedColumnIndex = field.endColumnIndex + 1;
	}
	return list.endRowIndex === previousEndRowIndex
		&& list.endColumnIndex === expectedColumnIndex;
}

function renderMultiline(
	list: PositionedExpression,
	fields: PositionedExpression[],
	rows: string[],
	indent: number,
	opening: string,
	closing: string,
): string | undefined {
	const fieldIndentToken = getIndentToken(indent + 1);
	const lines = [opening];
	let previousEndRowIndex = list.startRowIndex;
	for (const field of fields) {
		lines.push(...getGapLines(rows, previousEndRowIndex, field.startRowIndex, fieldIndentToken));
		const text = getShiftedText(field, rows, indent + 1);
		if (text === undefined) {
			return undefined;
		}
		lines.push(fieldIndentToken + text);
		previousEndRowIndex = field.endRowIndex;
	}
	lines.push(...getGapLines(rows, previousEndRowIndex, list.endRowIndex, fieldIndentToken));
	lines.push(getIndentToken(indent) + closing);
	return lines.join('\n');
}

function renderInline(
	list: PositionedExpression,
	fields: PositionedExpression[],
	rows: string[],
	indent: number,
	opening: string,
	closing: string,
): string | undefined {
	// Kommentare zwischen den Feldern laufen bis zum Zeilenende und passen nicht in eine Zeile
	let previousEndRowIndex = list.startRowIndex;
	for (const field of [...fields, list]) {
		const startRowIndex = field === list
			? list.endRowIndex
			: field.startRowIndex;
		if (getGapLines(rows, previousEndRowIndex, startRowIndex, '').some(line => line !== '')) {
			return undefined;
		}
		previousEndRowIndex = field.endRowIndex;
	}
	const texts: string[] = [];
	for (const field of fields) {
		const text = getShiftedText(field, rows, indent);
		if (text === undefined) {
			return undefined;
		}
		texts.push(text);
	}
	return opening + texts.join(' ') + closing;
}

/**
 * Leer- und Kommentarzeilen strikt zwischen zwei Zeilen, Kommentare mit der neuen Einrückung.
 */
function getGapLines(rows: string[], afterRowIndex: number, beforeRowIndex: number, indentToken: string): string[] {
	const lines: string[] = [];
	for (let rowIndex = afterRowIndex + 1; rowIndex < beforeRowIndex; rowIndex++) {
		const content = rows[rowIndex]!.trimStart();
		lines.push(content === ''
			? ''
			: indentToken + content);
	}
	return lines;
}

/**
 * Text des Felds aus dem Quelltext. Folgezeilen werden um die Differenz zwischen der Einrückung
 * der Zeile, in der das Feld beginnt, und der neuen verschoben. undefined, wenn eine Folgezeile
 * dafür zu wenig eingerückt ist.
 */
function getShiftedText(field: PositionedExpression, rows: string[], newIndent: number): string | undefined {
	const lines: string[] = [];
	for (let rowIndex = field.startRowIndex; rowIndex <= field.endRowIndex; rowIndex++) {
		const row = rows[rowIndex]!;
		const startColumnIndex = rowIndex === field.startRowIndex
			? field.startColumnIndex
			: 0;
		const endColumnIndex = rowIndex === field.endRowIndex
			? field.endColumnIndex
			: row.length;
		lines.push(row.substring(startColumnIndex, endColumnIndex));
	}
	const shift = newIndent - getTabCount(rows[field.startRowIndex]!);
	if (shift === 0) {
		return lines.join('\n');
	}
	for (let index = 1; index < lines.length; index++) {
		const line = lines[index]!;
		if (line === '') {
			continue;
		}
		if (shift > 0) {
			lines[index] = getIndentToken(shift) + line;
		}
		else if (getTabCount(line) >= -shift) {
			lines[index] = line.substring(-shift);
		}
		else {
			return undefined;
		}
	}
	return lines.join('\n');
}

/**
 * Lambda oder Branching, dessen Rumpf bzw. Zweige in den Zeilen unter dem Kopf stehen, auch als
 * Wert eines benannten Felds oder Spreads.
 */
function hasBlockBody(field: PositionedExpression): boolean {
	const value = field.type === 'singleDictionaryField' || field.type === 'spread'
		? field.value
		: field.type === 'field'
			? field.assignedValue ?? field.name
			: field;
	if (!value) {
		return false;
	}
	switch (value.type) {
		case 'functionLiteral': {
			const head = value.returnType ?? value.params;
			const firstBodyExpression = value.body[0];
			return firstBodyExpression !== undefined
				&& firstBodyExpression.startRowIndex > head.endRowIndex;
		}
		case 'branching':
		case 'typeBranching': {
			const firstBranch = value.branches[0];
			return firstBranch !== undefined
				&& firstBranch.startRowIndex > (value.args?.endRowIndex ?? value.startRowIndex);
		}
		default:
			return false;
	}
}

//#endregion Klammerliste

//#region Hilfsfunktionen

function getChildren(expression: PositionedExpression): PositionedExpression[] {
	const children: PositionedExpression[] = [];
	forEachChild(expression, child => {
		children.push(child);
		return undefined;
	});
	return children;
}

function getTabCount(row: string): number {
	let count = 0;
	while (row[count] === '\t') {
		count++;
	}
	return count;
}

const indentTokens: string[] = [];

function getIndentToken(indent: number): string {
	return indentTokens[indent] ??= '\t'.repeat(indent);
}

function offsetToPosition(code: string, offset: number): { rowIndex: number; columnIndex: number; } {
	let rowIndex = 0;
	let rowStart = 0;
	for (let index = code.indexOf('\n'); index !== -1 && index < offset; index = code.indexOf('\n', index + 1)) {
		rowIndex++;
		rowStart = index + 1;
	}
	return { rowIndex: rowIndex, columnIndex: offset - rowStart };
}

const ignoredKeys = new Set(['startRowIndex', 'startColumnIndex', 'endRowIndex', 'endColumnIndex', 'parent']);

/**
 * Gleiche Struktur ohne Positionen und parent.
 */
function isStructurallyEqual(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
		return false;
	}
	if (Array.isArray(a) !== Array.isArray(b)) {
		return false;
	}
	const aKeys = Object.keys(a).filter(key => !ignoredKeys.has(key));
	const bKeys = Object.keys(b).filter(key => !ignoredKeys.has(key));
	if (aKeys.length !== bKeys.length) {
		return false;
	}
	return aKeys.every(key =>
		isStructurallyEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

//#endregion Hilfsfunktionen
