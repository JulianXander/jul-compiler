// Übersetzung zwischen CompileTimeType und dem JS-Wert, mit dem constant folding rechnet, sowie
// (ab Schritt 3) der Auswerter, der Nutzerfunktionen tatsächlich ausführt: Literal + Umgebung zu
// JS emittieren (emitter.ts), mit new Function instanziieren, aufrufen. Der Auswerter liegt hier
// und nicht in einer eigenen Datei, weil typeToConstantValue im Fall 'function' den Auswerter
// braucht und der Auswerter umgekehrt typeToConstantValue/constantValueToType - eine Trennung
// erzeugte einen Zyklus. Bewusst ohne Abhängigkeit von checker.ts (siehe buildEnvironment): die
// Zusage "ohne laufenden Checker testbar" gilt weiter für die reine Typübersetzung, nicht mehr für
// die Ausführung - die braucht zwangsläufig einen bereits geprüften Baum.
import * as runtime from '../runtime.js';
import { _julTypeSymbol } from '../runtime.js';
import { functionLiteralToEvaluableJs } from '../emitter.js';
import { escapeReservedJsVariableName } from '../util.js';
import {
	builtinEmpty,
	builtinError,
	CompileTimeDictionary,
	CompileTimeFunctionType,
	CompileTimeType,
	createBooleanLiteral,
	createCompileTimeDictionaryLiteralType,
	createCompileTimeTupleType,
	createFloatLiteral,
	createIntegerLiteral,
	createTextLiteral,
	forEachChild,
	ParseFunctionLiteral,
	ParseReference,
	PositionedExpression,
} from '../syntax-tree.js';

/** Wie in emitter.ts (getRuntimeImportJs): alle Runtime-Exporte, namentlich gebunden. */
const runtimeKeys = Object.keys(runtime);

/**
 * Typ → JS-Wert, für die Argumente eines Aufrufs. `undefined` heißt "nicht faltbar" - deshalb
 * ist der Rückgabetyp `{ value }` und nicht `unknown`: `undefined` selbst ist ein gültiger Wert
 * (Empty) und darf damit nicht verwechselt werden. Rekursiv über Skalare und Kollektionen aus
 * Literaltypen; alles andere (Integer, Or, ...) ist nicht konstant.
 */
export function typeToConstantValue(type: CompileTimeType): { value: unknown; } | undefined {
	switch (type.julType) {
		case 'integerLiteral':
		case 'floatLiteral':
		case 'textLiteral':
		case 'booleanLiteral':
			return { value: type.value };
		case 'empty':
			return { value: undefined };
		case 'tuple': {
			const values: unknown[] = [];
			for (const elementType of type.ElementTypes) {
				const elementValue = typeToConstantValue(elementType);
				if (!elementValue) {
					return undefined;
				}
				values.push(elementValue.value);
			}
			return { value: values };
		}
		case 'dictionaryLiteral': {
			const fields: { [key: string]: unknown; } = {};
			for (const [fieldName, fieldType] of Object.entries(type.Fields)) {
				const fieldValue = typeToConstantValue(fieldType);
				if (!fieldValue) {
					return undefined;
				}
				fields[fieldName] = fieldValue.value;
			}
			return { value: fields };
		}
		case 'function': {
			// TODO Schritt 4 (docs/constant-folding-nutzerfunktionen.md): Builtin → Runtime-Export,
			// Nutzerfunktion → Callable aus tryBuildCallable. Noch offen, weil hierfür der
			// Referenzname der Schreibstelle fehlt (aliasName ist dafür nicht zuverlässig).
		}
		default:
			return undefined;
	}
}

/**
 * JS-Wert → Typ, für das Ergebnis eines gefalteten Aufrufs. Umgekehrt zu typeToConstantValue,
 * plus zwei Fälle, die dort nicht vorkommen: ein zurückgegebener (nicht geworfener) Error ist
 * ein normaler JUL-Wert, und `undefined` wird zu Empty - beides liefert die Runtime bereits
 * heute für ungefaltete Aufrufe. NaN/Infinity/-Infinity bleiben ungefaltet: ein Literaltyp dafür
 * wäre darstellbar, aber bedeutungslos.
 */
export function constantValueToType(value: unknown): CompileTimeType | undefined {
	if (value === undefined) {
		return builtinEmpty;
	}
	if (value instanceof Error) {
		return builtinError;
	}
	switch (typeof value) {
		case 'bigint':
			return createIntegerLiteral(value);
		case 'number':
			return Number.isFinite(value) ? createFloatLiteral(value) : undefined;
		case 'string':
			return createTextLiteral(value);
		case 'boolean':
			return createBooleanLiteral(value);
	}
	if (Array.isArray(value)) {
		const elementTypes: CompileTimeType[] = [];
		for (const element of value) {
			const elementType = constantValueToType(element);
			if (!elementType) {
				return undefined;
			}
			elementTypes.push(elementType);
		}
		return createCompileTimeTupleType(elementTypes);
	}
	if (typeof value === 'object' && value !== null) {
		if (_julTypeSymbol in value) {
			// RuntimeType-Objekt (Ergebnis eines Typkonstruktors wie Greater/Not/Or/And/TypeOf),
			// kein JUL-Datenwert - dafür hat diese Übersetzung keine Entsprechung. Die Type
			// constructor Sonderbehandlung in getReturnTypeFromFunctionCall bleibt zuständig.
			return undefined;
		}
		const fields: CompileTimeDictionary = {};
		for (const [fieldName, fieldValue] of Object.entries(value)) {
			const fieldType = constantValueToType(fieldValue);
			if (!fieldType) {
				return undefined;
			}
			fields[fieldName] = fieldType;
		}
		return createCompileTimeDictionaryLiteralType(fields, true);
	}
	return undefined;
}

//#region Auswerter (Schritt 3)

/**
 * Notbremse gegen nicht terminierende Rekursion: Purity sagt "rein", nicht "terminiert". Ein
 * erschöpftes Budget erzeugt keine Diagnose, nur "nicht gefaltet" (siehe tryBuildCallable/catch).
 * Global pro Check-Lauf (resetFoldBudget), nicht pro Aufrufstelle - sonst bleiben viele kleine
 * faltbare Aufrufe einzeln unauffällig und summieren sich trotzdem.
 */
// 10_000 (grob nach Plan) maß sich als zu teuer: ein genuin nicht terminierender Aufruf (siehe
// Test 'recursive-function-return-type-is-not-checked') brauchte damit über 600ms statt der
// angepeilten ~1ms - new Function/JSON.stringify pro Schritt sind teurer als reiner JS-Aufruf.
// Bis der Auswerter selbst schneller ist (Schritt 5: Bench), bleibt das Budget klein genug, um den
// Language Server nicht spürbar zu blockieren.
const initialFoldBudget = 1_000;
let foldBudgetRemaining = initialFoldBudget;

export function resetFoldBudget(): void {
	foldBudgetRemaining = initialFoldBudget;
}

class FoldBudgetExhaustedError extends Error { }

/**
 * Wie runtime._createFunction, aber statt in-place zu mutieren gibt sie eine neue Closure zurück,
 * die pro Aufruf das Budget dekrementiert und bei Erschöpfung wirft. Eine Selbstreferenz im Rumpf
 * läuft über dieselbe `let`-Bindung (siehe emitter.ts functionLiteralToEvaluableJs) durch genau
 * diesen Wrapper, ein direkter Aufruf ebenso wie einer über runtime._callFunction - **beide
 * Aufrufwege laufen über denselben Wrapper**, ein Zähler in _callFunction allein bliebe bei einem
 * direkt aufgerufenen `f(n) => f(n.subtract(1))` stumm.
 * Zusätzlich pro Closure memoisiert (Schlüssel: kanonisch serialisierte Argumente) - ohne das wäre
 * schon eine naive, nicht endrekursive Fibonacci-Funktion exponentiell und verbrennte das Budget an
 * einem einzigen äußeren Aufruf.
 */
function createBudgetedCreateFunction(): typeof runtime._createFunction {
	return (fn: Function, params: unknown) => {
		const cache = new Map<string, unknown>();
		const wrapped = (...args: unknown[]): unknown => {
			const key = canonicalArgsKey(args);
			if (cache.has(key)) {
				return cache.get(key);
			}
			if (foldBudgetRemaining <= 0) {
				throw new FoldBudgetExhaustedError();
			}
			foldBudgetRemaining--;
			const result = fn(...args);
			cache.set(key, result);
			return result;
		};
		return runtime._createFunction(wrapped, params as Parameters<typeof runtime._createFunction>[1]);
	};
}

function canonicalArgsKey(args: unknown[]): string {
	return JSON.stringify(args, (_key, value) => typeof value === 'bigint' ? `${value}n` : value);
}

/**
 * Freie Referenzen des Rumpfs - ohne Parameter, ohne lokale Definitionen. Derselbe Bautyp wie
 * inferBodyPurity in checker.ts, aber anders als dort steigt der Walker in verschachtelte
 * Funktionsliterale ab (mit deren eigenen symbols auf dem Stack): sie werden beim Emittieren des
 * äußeren Literals als Teil desselben Slice mit ausgeführt, nicht separat aufgelöst.
 */
function collectFreeReferences(literal: ParseFunctionLiteral): ParseReference[] {
	const freeReferences: ParseReference[] = [];
	const scopeStack = [literal.symbols];

	function walk(expression: PositionedExpression): undefined {
		switch (expression.type) {
			case 'reference':
				if (!scopeStack.some(symbols => expression.name.name in symbols)) {
					freeReferences.push(expression);
				}
				return undefined;
			case 'functionLiteral':
				scopeStack.push(expression.symbols);
				expression.body.forEach(walk);
				scopeStack.pop();
				return undefined;
			default:
				forEachChild(expression, walk);
				return undefined;
		}
	}

	literal.body.forEach(walk);
	return freeReferences;
}

/**
 * Bedingung 3 der Faltbarkeitsregel: löst jede freie Referenz des Rumpfs auf, in dieser
 * Reihenfolge (docs/constant-folding-nutzerfunktionen.md Schritt 2) - konstanter Wert, wiederum
 * faltbare Nutzerfunktion (rekursiv), Runtime-Export unter dem Namen. Scheitert eine, ist das
 * Ergebnis undefined ("keine Umgebung", also nicht gefaltet). Die Selbstreferenz der gerade
 * gefalteten Funktion ist ausgenommen - sie wird beim Emit an die gerade gebaute Closure gebunden,
 * nicht hier aufgelöst.
 */
function buildEnvironment(literal: ParseFunctionLiteral): { name: string; value: unknown; }[] | undefined {
	const ownName = literal.parent?.type === 'definition' && literal.parent.value === literal
		? literal.parent.name.name
		: undefined;
	const byName = new Map<string, ParseReference>();
	collectFreeReferences(literal).forEach(reference => {
		const name = reference.name.name;
		if (name !== ownName && !byName.has(name)) {
			byName.set(name, reference);
		}
	});
	const environment: { name: string; value: unknown; }[] = [];
	for (const [name, reference] of byName) {
		// Regel 3: ein Runtime-Export unter diesem Namen wird ohnehin über die volle Runtime-
		// Bindung in tryBuildCallable erreichbar sein (wie der normale Modul-Import) - hier reicht
		// die Auskunft, dass er existiert, eine eigene Bindung braucht es nicht. Der Namensgriff
		// ist eindeutig, weil Überdeckung (JUL4003) gegen alle oberen Scopes ist, Builtins
		// eingeschlossen.
		if (runtimeKeys.includes(escapeReservedJsVariableName(name))) {
			continue;
		}
		const type = reference.typeInfo?.type;
		if (!type) {
			return undefined;
		}
		const constantValue = typeToConstantValue(type);
		if (constantValue) {
			environment.push({ name: name, value: constantValue.value });
			continue;
		}
		if (type.julType === 'function' && type.literal) {
			if (!type.foldable) {
				return undefined;
			}
			const callable = tryBuildCallable(type);
			if (!callable) {
				return undefined;
			}
			environment.push({ name: name, value: callable });
			continue;
		}
		return undefined;
	}
	return environment;
}

/**
 * Instanziiert ein faltbares Funktionsliteral zu einem echten JS-Callable, über new Function -
 * ohne Modul-Header, mit der Runtime als hereingereichten Parametern statt Import (siehe
 * emitter.ts functionLiteralToEvaluableJs). undefined heißt "nicht gefaltet": entweder scheitert
 * die Umgebung (Bedingung 3), oder new Function wirft (z.B. FoldBudgetExhaustedError).
 */
export function tryBuildCallable(functionType: CompileTimeFunctionType): Function | undefined {
	const literal = functionType.literal;
	if (!literal || !functionType.foldable) {
		return undefined;
	}
	const environment = buildEnvironment(literal);
	if (!environment) {
		return undefined;
	}
	// Volle Runtime immer binden, wie der normale Modul-Import (getRuntimeImportJs): emittierte
	// Parameter-Typangaben (z.B. `a: Integer`) referenzieren Runtime-Exporte, die selbst keine
	// aufrufbaren Funktionen sind (kein `params`) und deshalb nicht über Regel 3 der freien
	// Referenzen laufen - der Sammler durchsucht nur den Rumpf, nicht die Parameterliste.
	const bindingNames = [...runtimeKeys, ...environment.map(entry => entry.name)];
	const bindingValues: unknown[] = [...runtimeKeys.map(key => key === '_createFunction' ? createBudgetedCreateFunction() : (runtime as { [key: string]: unknown; })[key]), ...environment.map(entry => entry.value)];
	try {
		const factory = new Function(...bindingNames, functionLiteralToEvaluableJs(literal));
		return factory(...bindingValues) as Function;
	}
	catch (e) {
		console.error('DEBUG build error', e);
		return undefined;
	}
}

//#endregion Auswerter
