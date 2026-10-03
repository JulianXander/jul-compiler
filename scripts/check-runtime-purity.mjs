// Prüft, dass runtime.ts und test-runtime.ts beim Laden keine Seiteneffekte haben. Darauf verlässt
// sich shakeRuntime (src/runtime/runtime-shaking.ts): Es lässt jede Deklaration weg, die das Programm nicht
// erreicht. Ein nachgestellter Aufruf wie `_createFunction(x, params)` hätte dort keinen eigenen
// Namen und bliebe stehen, samt allem, was er referenziert. Ein Aufruf mit Seiteneffekt in einer
// weggelassenen Deklaration fiele dagegen still mit weg.
//
// Regel für die oberste Ebene: erlaubt sind Imports, Typen, Interfaces, function- und
// class-Deklarationen, `export { ... }` und Variablendeklarationen. Ein Aufruf oder `new` in einem
// Initialisierer braucht direkt davor /*#__PURE__*/, auch in den Argumenten eines markierten
// Aufrufs: Die Markierung ist die Zusicherung, dass der Aufruf nichts außer seinem Ergebnis bewirkt.
// Dieselbe Schreibweise verstehen Minimizer wie terser, falls das Bundle einmal minimiert wird.
// Funktionsrümpfe laufen nicht beim Laden und werden nicht geprüft. Dasselbe gilt für
// Initialisierer statischer Klassenfelder und static-Blöcke.
//
// Kein Test in der Suite: Es parst bei jedem Lauf die ganze Runtime. Aufrufen nach Änderungen an
// runtime.ts oder test-runtime.ts:
//   npm run check-runtime-purity
//
// Exit-Code 1 bei Verstößen, eine Zeile je Verstoß.

import { readFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';

const compilerDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['src/runtime/runtime.ts', 'src/runtime/test-runtime.ts'];

/**
 * Bewusste Ausnahmen, Schlüssel ist der Quelltext des Knotens.
 */
const allowed = new Map([
]);

/**
 * Die Markierung muss das Letzte vor dem Knoten sein. Über den Text statt über
 * ts.getLeadingCommentRanges: Das sammelt Kommentare auf derselben Zeile nicht ein.
 */
const pureCommentRegex = /\/\*\s*[#@]__PURE__\s*\*\/\s*$/;

function hasPureComment(node, sourceText) {
	return pureCommentRegex.test(sourceText.slice(node.getFullStart(), node.getStart()));
}

function isFunctionBody(node) {
	return ts.isFunctionLike(node);
}

/**
 * Sammelt Aufrufe und new-Ausdrücke außerhalb von Funktionsrümpfen, die nicht als pure markiert sind.
 */
function findImpureCalls(node, sourceText, violations) {
	if (isFunctionBody(node)) {
		return;
	}
	if ((ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node))
		&& !hasPureComment(node, sourceText)) {
		violations.push(node);
	}
	ts.forEachChild(node, child => findImpureCalls(child, sourceText, violations));
}

function checkStatement(statement, sourceText, violations) {
	switch (statement.kind) {
		case ts.SyntaxKind.ImportDeclaration:
		case ts.SyntaxKind.TypeAliasDeclaration:
		case ts.SyntaxKind.InterfaceDeclaration:
		case ts.SyntaxKind.FunctionDeclaration:
		case ts.SyntaxKind.ExportDeclaration:
		case ts.SyntaxKind.EmptyStatement:
			return;
		case ts.SyntaxKind.ClassDeclaration:
			// extends mit Aufruf und berechnete Schlüssel liefen beim Laden.
			statement.heritageClauses?.forEach(clause => findImpureCalls(clause, sourceText, violations));
			statement.members.forEach(member => {
				if (member.name && ts.isComputedPropertyName(member.name)) {
					findImpureCalls(member.name, sourceText, violations);
				}
				const isStatic = member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
				if (ts.isClassStaticBlockDeclaration(member)) {
					violations.push(member);
				}
				else if (isStatic && ts.isPropertyDeclaration(member) && member.initializer) {
					findImpureCalls(member.initializer, sourceText, violations);
				}
			});
			return;
		case ts.SyntaxKind.VariableStatement:
			statement.declarationList.declarations.forEach(declaration => {
				if (declaration.initializer) {
					findImpureCalls(declaration.initializer, sourceText, violations);
				}
			});
			return;
		default:
			violations.push(statement);
	}
}

let violationCount = 0;
for (const file of files) {
	const path = join(compilerDirectory, file);
	const sourceText = readFileSync(path, 'utf8');
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
	const violations = [];
	sourceFile.statements.forEach(statement => checkStatement(statement, sourceText, violations));
	for (const node of violations) {
		const text = node.getText(sourceFile);
		if (allowed.has(text)) {
			continue;
		}
		violationCount++;
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		const firstLine = text.split('\n')[0];
		console.log(`${relative(compilerDirectory, path)}:${line + 1}:${character + 1}: ${firstLine}`);
	}
}
if (violationCount) {
	console.log(`${violationCount} Stellen mit Seiteneffekt beim Laden`);
	process.exit(1);
}
console.log('keine Seiteneffekte beim Laden');
