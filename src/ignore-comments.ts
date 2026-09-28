import { CompilerError, ErrorCode, errorInfos } from './compiler-errors.js';
import { IgnoreComment, ParsedExpressions } from './syntax-tree.js';

/**
 * `#jul-ignore JUL<nr> erklärung` unterdrückt Warnungen mit diesem Code, deren Startposition in
 * der nächsten Zeile liegt, die weder leer noch ein Kommentar ist. Wie @ts-expect-error: Ein
 * Kommentar, der nichts unterdrückt, ist selbst eine Warnung. Fehler lassen sich nicht
 * unterdrücken, sonst würde kaputter Code gebaut.
 */

const ignoreCommentRegex = /^(\t*)#jul-ignore\b(.*)$/;
const commentRegex = /^\t*#/;

export function isIgnoreCommentText(commentText: string): boolean {
	return /^jul-ignore\b/.test(commentText);
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
				`This jul-ignore comment suppresses nothing: the next line has no warning JUL${comment.code}.`,
			));
		}
		remaining = kept;
	});
	// Dasselbe Array behalten, andere halten eine Referenz darauf.
	file.errors.splice(0, file.errors.length, ...remaining, ...reported);
}

function getInvalidMessage(code: number | undefined): string | undefined {
	if (code === undefined) {
		return 'jul-ignore needs the code of a warning, e.g. #jul-ignore JUL2800.';
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
