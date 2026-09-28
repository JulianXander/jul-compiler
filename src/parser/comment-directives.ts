import { CompilerError, ErrorCode, errorInfos } from '../compiler-errors.js';
import { IgnoreComment, ParsedExpressions } from '../syntax-tree.js';

/**
 * Anweisungen in Kommentaren: `#` direkt gefolgt von einem Wort, ohne Leerzeichen. Mit
 * Leerzeichen ist ein Kommentar gewöhnlicher Text.
 *
 * `#ignore JUL<nr> erklärung` unterdrückt Warnungen mit diesem Code, deren Startposition in
 * der nächsten Zeile liegt, die weder leer noch ein Kommentar ist. Wie @ts-expect-error: Ein
 * Kommentar, der nichts unterdrückt, ist selbst eine Warnung. Fehler lassen sich nicht
 * unterdrücken, sonst würde kaputter Code gebaut.
 *
 * `#TODO text` markiert einen offenen Punkt, gefärbt über die Grammatik, ohne Diagnose. Andere
 * Schreibweisen wie `# TODO` oder `#todo` sind eine Warnung, damit es genau eine gibt.
 */

const knownDirectives = ['region', 'endregion', 'ignore', 'TODO'];
const ignoreCommentRegex = /^(\t*)#ignore\b(.*)$/;
const commentRegex = /^\t*#/;

/**
 * Eine Anweisung ist keine Beschreibung der folgenden Definition.
 */
export function isDirectiveCommentText(commentText: string): boolean {
	return /^[A-Za-z]/.test(commentText);
}

/**
 * Die Meldungen zu einer Kommentarzeile. commentText ist der Kommentar ohne das #.
 */
export function getCommentDirectiveError(
	commentText: string,
	rowIndex: number,
	startColumnIndex: number,
	endColumnIndex: number,
): CompilerError | undefined {
	const position = {
		startRowIndex: rowIndex,
		startColumnIndex: startColumnIndex,
		endRowIndex: rowIndex,
		endColumnIndex: endColumnIndex,
	};
	if (/^TODO\b/.test(commentText)) {
		return undefined;
	}
	if (/^\s*todo\b/i.test(commentText)) {
		return {
			code: ErrorCode.todoSpelling,
			message: 'Write TODO comments as #TODO, without a space after # and in uppercase.',
			...position,
		};
	}
	// Ein unbekanntes Wort direkt nach # ist vermutlich ein Tippfehler in einer Anweisung.
	const directive = /^[A-Za-z][\w-]*/.exec(commentText)?.[0];
	if (!directive || knownDirectives.includes(directive)) {
		return undefined;
	}
	return {
		code: ErrorCode.unknownDirective,
		message: `Unknown directive '#${directive}'. Known directives are #region, #endregion, #ignore and #TODO. For a comment, write a space after #.`,
		...position,
	};
}

//#region lesen

export function parseIgnoreComments(rows: readonly string[]): IgnoreComment[] {
	const comments: IgnoreComment[] = [];
	rows.forEach((row, rowIndex) => {
		const match = ignoreCommentRegex.exec(row);
		if (!match) {
			return;
		}
		const codeMatch = /^\s+JUL(\d+)\b/.exec(match[2]!);
		comments.push({
			code: codeMatch ? Number(codeMatch[1]) : undefined,
			targetRowIndex: findTargetRowIndex(rows, rowIndex),
			startRowIndex: rowIndex,
			startColumnIndex: match[1]!.length,
			endRowIndex: rowIndex,
			endColumnIndex: row.length,
		});
	});
	return comments;
}

export interface TodoComment {
	rowIndex: number;
	columnIndex: number;
	/**
	 * Der Text nach #TODO, ohne führende und abschließende Leerzeichen.
	 */
	text: string;
}

/**
 * Die #TODO-Kommentare einer Datei, für jul todo.
 */
export function parseTodoComments(rows: readonly string[]): TodoComment[] {
	const comments: TodoComment[] = [];
	rows.forEach((row, rowIndex) => {
		const match = /^(\t*)#TODO\b(.*)$/.exec(row);
		if (!match) {
			return;
		}
		comments.push({
			rowIndex: rowIndex,
			columnIndex: match[1]!.length,
			text: match[2]!.trim(),
		});
	});
	return comments;
}

function findTargetRowIndex(rows: readonly string[], commentRowIndex: number): number | undefined {
	for (let rowIndex = commentRowIndex + 1; rowIndex < rows.length; rowIndex++) {
		const row = rows[rowIndex]!;
		if (row.trim() === '' || commentRegex.test(row)) {
			continue;
		}
		return rowIndex;
	}
	return undefined;
}

//#endregion lesen

//#region anwenden

export function applyIgnoreComments(file: ParsedExpressions): void {
	const ignoreComments = file.ignoreComments;
	if (!ignoreComments?.length) {
		return;
	}
	const reported: CompilerError[] = [];
	let remaining = file.errors;
	ignoreComments.forEach(comment => {
		const invalidMessage = getInvalidMessage(comment.code);
		if (invalidMessage) {
			reported.push(commentWarning(comment, ErrorCode.invalidIgnoreComment, invalidMessage));
			return;
		}
		const kept = remaining.filter(error =>
			error.code !== comment.code
			|| error.startRowIndex !== comment.targetRowIndex);
		if (kept.length === remaining.length) {
			reported.push(commentWarning(
				comment,
				ErrorCode.unusedIgnoreComment,
				`This #ignore comment suppresses nothing: the next line has no warning JUL${comment.code}.`,
			));
		}
		remaining = kept;
	});
	// Dasselbe Array behalten, andere halten eine Referenz darauf.
	file.errors.splice(0, file.errors.length, ...remaining, ...reported);
}

function getInvalidMessage(code: number | undefined): string | undefined {
	if (code === undefined) {
		return '#ignore needs the code of a warning, e.g. #ignore JUL2800.';
	}
	const info = errorInfos[code as ErrorCode];
	if (!info) {
		return `JUL${code} is not a known code.`;
	}
	if (info.severity !== 'warning') {
		return `JUL${code} is not a warning and can not be suppressed.`;
	}
	return undefined;
}

function commentWarning(comment: IgnoreComment, code: ErrorCode, message: string): CompilerError {
	return {
		code: code,
		message: message,
		startRowIndex: comment.startRowIndex,
		startColumnIndex: comment.startColumnIndex,
		endRowIndex: comment.endRowIndex,
		endColumnIndex: comment.endColumnIndex,
	};
}

//#endregion anwenden
