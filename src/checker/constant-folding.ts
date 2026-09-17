// Übersetzung zwischen CompileTimeType und dem JS-Wert, mit dem constant folding rechnet.
// Bewusst ohne Abhängigkeit von checker.ts, damit beide Richtungen ohne laufenden Checker
// testbar sind.

import { _julTypeSymbol } from '../runtime.js';
import {
	builtinEmpty,
	builtinError,
	CompileTimeDictionary,
	CompileTimeType,
	createBooleanLiteral,
	createCompileTimeDictionaryLiteralType,
	createCompileTimeTupleType,
	createFloatLiteral,
	createIntegerLiteral,
	createTextLiteral,
} from '../syntax-tree.js';

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
			// TODO?
			// function vie emitter to js + eval? oder interpreter?
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
