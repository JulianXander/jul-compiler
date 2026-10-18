import { readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

import { errorInfos } from '../src/compiler-errors.js';
import { createFileSystemHost, loadFile } from '../src/compiler/project-loader.js';
import { ParsedDocuments } from '../src/checker/checker.js';
import { getCheckedEscapableName } from '../src/parser/parser-utils.js';
import { CompileTimeType, ParseExpression, ParseFunctionCall, PositionedExpression, forEachChild } from '../src/syntax-tree.js';

/**
 * Zählt vor der Umstellung auf feste Argumentreihenfolge (docs/feste-argumentreihenfolge-plan.md,
 * Schritt 0), wie viele Aufrufe die neue Regel betrifft. Kein Test, nur Messung.
 * Aufruf: tsx scripts/probe-argument-order.ts <ordner...>
 * Ausgabe: je Kategorie die Zahl und die ersten Fundstellen (Datei:Zeile).
 */

type Category =
	| 'benannt, in Reihenfolge'
	| 'benannt, Reihenfolge abweichend'
	| 'benannt, Funktionstyp unbekannt'
	| 'benannt, Name ohne Parameter'
	| 'Spread List'
	| 'Spread Dictionary, Funktionstyp bekannt'
	| 'Spread unbekannter Typ'
	| 'Funktion in Typposition (Or/And/Not)';

const findings = new Map<Category, string[]>();
let callCount = 0;

function report(category: Category, location: string): void {
	const list = findings.get(category) ?? [];
	list.push(location);
	findings.set(category, list);
}

function findJulFiles(folder: string): string[] {
	return readdirSync(folder).flatMap(entry => {
		const fullPath = join(folder, entry);
		if (statSync(fullPath).isDirectory()) {
			return ['out', 'node_modules', '.git'].includes(entry) || entry.startsWith('out-')
				? []
				: findJulFiles(fullPath);
		}
		return fullPath.endsWith('.jul')
			? [fullPath]
			: [];
	});
}

/** Namen der Parameter in Deklarationsreihenfolge, undefined bei unbekannter Signatur */
function getParameterNames(call: ParseFunctionCall): string[] | undefined {
	const paramsType: CompileTimeType | undefined = call.calledFunctionType?.ParamsType;
	if (paramsType?.julType === 'parameters') {
		return paramsType.rest
			? undefined
			: paramsType.singleNames.map(parameter => parameter.name);
	}
	return undefined;
}

function isSubsequence(written: string[], declared: string[]): boolean {
	let declaredIndex = 0;
	for (const name of written) {
		const found = declared.indexOf(name, declaredIndex);
		if (found < 0) {
			return false;
		}
		declaredIndex = found + 1;
	}
	return true;
}

function visit(expression: PositionedExpression, filePath: string, root: string): void {
	if (expression.type === 'functionCall') {
		callCount++;
		inspectCall(expression, `${relative(root, filePath)}:${expression.startRowIndex + 1}`);
	}
	forEachChild(expression, child => {
		visit(child, filePath, root);
		return undefined;
	});
}

function inspectCall(call: ParseFunctionCall, location: string): void {
	const args = call.arguments;
	if (args?.type === 'dictionary') {
		const written = args.fields.flatMap(field =>
			field.type === 'singleDictionaryField' && field.value
				? [getCheckedEscapableName(field.name) ?? '?']
				: []);
		const declared = getParameterNames(call);
		if (!declared) {
			report('benannt, Funktionstyp unbekannt', location);
		}
		else if (written.some(name => !declared.includes(name))) {
			report('benannt, Name ohne Parameter', location);
		}
		else if (isSubsequence(written, declared)) {
			report('benannt, in Reihenfolge', location);
		}
		else {
			report('benannt, Reihenfolge abweichend', location);
		}
		const hasSpreadField = args.fields.some(field => field.type === 'spread');
		if (hasSpreadField) {
			report('Spread Dictionary, Funktionstyp bekannt', location);
		}
	}
	else if (args?.type === 'object') {
		report('Spread unbekannter Typ', location);
	}
	else if (args?.type === 'list') {
		if (args.values.some(value => value.type === 'spread')) {
			report('Spread List', location);
		}
	}
	const functionName = call.functionExpression?.type === 'reference'
		? call.functionExpression.name.name
		: undefined;
	if (functionName && ['Or', 'And', 'Not'].includes(functionName) && args?.type === 'list') {
		const hasFunctionArgument = args.values.some(value =>
			value.type === 'functionLiteral'
			|| (value.type === 'reference' && value.typeInfo?.type.julType === 'function'));
		if (hasFunctionArgument) {
			report('Funktion in Typposition (Or/And/Not)', location);
		}
	}
}

const folders = process.argv.slice(2).map(folder => resolve(folder));
if (!folders.length) {
	console.error('Aufruf: tsx scripts/probe-argument-order.ts <ordner...>');
	process.exit(1);
}
for (const folder of folders) {
	const documents: ParsedDocuments = {};
	const host = createFileSystemHost({ cloneUnchecked: false });
	for (const filePath of findJulFiles(folder)) {
		loadFile(filePath, documents, host);
	}
	let fileCount = 0;
	for (const [filePath, parsed] of Object.entries(documents)) {
		if (!filePath.endsWith('.jul') || !filePath.startsWith(folder)) {
			continue;
		}
		fileCount++;
		const checked = parsed.checked;
		if (!checked) {
			console.log(`  nicht geprüft: ${relative(folder, filePath)}`);
			continue;
		}
		const errors = checked.errors.filter(error => errorInfos[error.code].severity === 'error');
		if (errors.length) {
			console.log(`  Fehler in ${relative(folder, filePath)}: ${errors.length}, Ergebnis lückenhaft`);
		}
		(checked.expressions as ParseExpression[] | undefined)?.forEach(expression => visit(expression, filePath, folder));
	}
	console.log(`${folder}: ${fileCount} Dateien, ${callCount} Aufrufe`);
	callCount = 0;
	for (const [category, locations] of findings) {
		console.log(`  ${String(locations.length).padStart(5)}  ${category}`);
		if (category !== 'benannt, in Reihenfolge') {
			locations.slice(0, 8).forEach(location => console.log(`          ${location}`));
		}
	}
	findings.clear();
}
