import { CompilerError, ErrorCode } from '../compiler-errors.js';
import {
	CompileTimeType,
	forEachChild,
	ParseExpression,
	ParseFunctionCall,
	ParseValueExpression,
	PositionedExpression,
} from '../syntax-tree.js';
import { last } from '../util.js';
import { resolvePlaceholders } from './type-algebra.js';

/**
 * Lebensdauer von Streams, siehe docs/stream-lifetimes.md: Ein Stream aus einer Quelle, die nicht
 * von selbst endet (create$, interval$), braucht ein complete im Rumpf, in dem er entsteht, oder er
 * wird zurückgegeben. Sonst läuft er für immer.
 */

//#region complete im Rumpf

/**
 * Die Namen, auf die im Rumpf irgendwo complete aufgerufen wird, auch in einem Callback:
 * `complete(x)` und `x.complete()`. Syntaktisch, vor dem Ableiten der Typen, damit der Typ des
 * Symbols schon an seiner Definition feststeht. Ein Name, den ein verschachtelter Rumpf neu
 * bindet, wird nicht unterschieden.
 */
export function collectCompletedNames(body: readonly PositionedExpression[]): Set<string> {
	const names = new Set<string>();
	const visit = (expression: PositionedExpression): void => {
		if (expression.type === 'functionCall') {
			const completedName = getCompletedName(expression);
			if (completedName) {
				names.add(completedName);
			}
		}
		forEachChild(expression, child => {
			visit(child);
			return undefined;
		});
	};
	body.forEach(visit);
	return names;
}

function getCompletedName(call: ParseFunctionCall): string | undefined {
	const functionExpression = call.functionExpression;
	if (functionExpression?.type !== 'reference'
		|| functionExpression.name.name !== 'complete') {
		return undefined;
	}
	const target = call.prefixArgument ?? getFirstListArgument(call);
	return target?.type === 'reference'
		? target.name.name
		: undefined;
}

function getFirstListArgument(call: ParseFunctionCall): PositionedExpression | undefined {
	const args = call.arguments;
	return args?.type === 'list'
		? args.values[0]
		: undefined;
}

//#endregion complete im Rumpf

//#region Warnung

/**
 * Meldet jeden Stream, der nicht endet: eine Quelle ohne Zusage, dass sie endet, auf die im Rumpf
 * kein complete steht und die weder zurückgegeben noch in einer Liste oder einem Dictionary
 * weitergegeben wird. Auch auf oberster Ebene, ein gewollt ewiger Stream wird dort abgeschaltet.
 * Ableitungen einer Quelle deckt die Warnung an der Quelle mit ab.
 */
export function reportStreamsWithoutEnd(fileExpressions: readonly ParseExpression[] | undefined, errors: CompilerError[]): void {
	if (!fileExpressions) {
		return;
	}
	reportInBody(fileExpressions, false, errors);
}

function reportInBody(body: readonly ParseExpression[], isFunctionBody: boolean, errors: CompilerError[]): void {
	const completedNames = collectCompletedNames(body);
	const passedOnNames = collectPassedOnNames(body);
	const returned = isFunctionBody ? last(body) : undefined;
	const returnedName = getReturnedName(returned);
	const visit = (expression: PositionedExpression, definedName: string | undefined): void => {
		if (expression.type === 'functionLiteral') {
			reportInBody(expression.body, true, errors);
			return;
		}
		if (expression.type === 'functionCall'
			&& isStreamSource(expression)
			&& !isEnded(expression, definedName)) {
			errors.push({
				code: ErrorCode.streamNeverCompleted,
				message: definedName
					? `Stream '${definedName}' is never completed. Call complete on it or return it.`
					: 'Stream is never completed. Assign it to a name and call complete on it, or return it.',
				startRowIndex: expression.startRowIndex,
				startColumnIndex: expression.startColumnIndex,
				endRowIndex: expression.endRowIndex,
				endColumnIndex: expression.endColumnIndex,
			});
		}
		forEachChild(expression, child => {
			visit(
				child,
				expression.type === 'definition' && child === expression.value
					? expression.name.name
					: undefined,
			);
			return undefined;
		});
	};
	const isEnded = (source: ParseFunctionCall, definedName: string | undefined): boolean => {
		if (source === returned
			|| (returned?.type === 'definition' && returned.value === source)) {
			return true;
		}
		return definedName !== undefined
			&& (completedNames.has(definedName)
				|| passedOnNames.has(definedName)
				|| definedName === returnedName);
	};
	body.forEach(expression => visit(expression, undefined));
}

/**
 * Eine Quelle: ein Aufruf, der einen Stream ohne Zusage liefert, ohne selbst einen Stream als
 * Argument zu bekommen. Mit Stream-Argument ist er eine Ableitung und endet mit seinen Quellen.
 */
function isStreamSource(call: ParseFunctionCall): boolean {
	if (!isStreamWithoutEnd(call.typeInfo?.type)) {
		return false;
	}
	const argumentValues = [
		...(call.prefixArgument ? [call.prefixArgument] : []),
		...getArgumentValues(call.arguments),
	];
	return !argumentValues.some(argument => containsStream(argument.typeInfo?.type));
}

function getArgumentValues(args: ParseFunctionCall['arguments']): ParseValueExpression[] {
	switch (args?.type) {
		case 'list':
			return args.values.map(value => value.type === 'spread' ? value.value : value);
		case 'dictionary':
			return args.fields.flatMap(field => {
				const value = field.value;
				return value ? [value] : [];
			});
		default:
			return [];
	}
}

/**
 * Aufgelöst wird nur, was noch auf etwas anderes verweist. Ein konkreter Typ wie eine Funktion
 * oder ein Text wird nie zum Stream, der Durchgang läuft über jeden Aufruf der Datei.
 */
function resolveIfPlaceholder(type: CompileTimeType): CompileTimeType {
	switch (type.julType) {
		case 'parameterReference':
		case 'nestedReference':
		case 'alias':
			return resolvePlaceholders(type);
		default:
			return type;
	}
}

/**
 * Auch eine Kollektion von Streams zählt, etwa `combine$(...sources)`.
 */
function containsStream(type: CompileTimeType | undefined): boolean {
	if (!type) {
		return false;
	}
	const resolved = resolveIfPlaceholder(type);
	switch (resolved.julType) {
		case 'stream':
			return true;
		case 'list':
		case 'dictionary':
			return containsStream(resolved.ElementType);
		case 'tuple':
			return resolved.ElementTypes.some(containsStream);
		case 'dictionaryLiteral':
			return Object.values(resolved.Fields).some(containsStream);
		case 'or':
		case 'and':
			return resolved.ChoiceTypes.some(containsStream);
		default:
			return false;
	}
}

function isStreamWithoutEnd(type: CompileTimeType | undefined): boolean {
	if (!type) {
		return false;
	}
	const resolved = resolveIfPlaceholder(type);
	return resolved.julType === 'stream' && !resolved.finite;
}

/**
 * Namen, die als Wert in einer Liste oder einem Dictionary stehen: Der Stream ist damit
 * weitergegeben, wer die Kollektion bekommt, kann ihn beenden.
 */
function collectPassedOnNames(body: readonly PositionedExpression[]): Set<string> {
	const names = new Set<string>();
	// Eine Argumentliste ist im Baum ebenfalls list oder dictionary. Ein Argument ist aber nur
	// geliehen, nicht weitergegeben.
	const argumentLists = new Set<PositionedExpression>();
	const visit = (expression: PositionedExpression): void => {
		if (expression.type === 'functionLiteral') {
			return;
		}
		if (expression.type === 'functionCall' && expression.arguments) {
			argumentLists.add(expression.arguments);
		}
		const isLiteral = !argumentLists.has(expression);
		if (isLiteral && expression.type === 'list') {
			expression.values.forEach(value => addReferenceName(value, names));
		}
		else if (isLiteral && expression.type === 'dictionary') {
			expression.fields.forEach(field => {
				if (field.type === 'singleDictionaryField' && field.value) {
					addReferenceName(field.value, names);
				}
			});
		}
		forEachChild(expression, child => {
			visit(child);
			return undefined;
		});
	};
	body.forEach(visit);
	return names;
}

function addReferenceName(expression: PositionedExpression, names: Set<string>): void {
	if (expression.type === 'reference') {
		names.add(expression.name.name);
	}
}

function getReturnedName(returned: ParseExpression | undefined): string | undefined {
	const value: ParseValueExpression | undefined = returned?.type === 'definition'
		? returned.value
		: returned as ParseValueExpression | undefined;
	return value?.type === 'reference'
		? value.name.name
		: undefined;
}

//#endregion Warnung
