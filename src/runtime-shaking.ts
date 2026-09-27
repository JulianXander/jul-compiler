import typescript from 'typescript';
const { ScriptKind, ScriptTarget, SyntaxKind, createSourceFile, forEachChild, isClassDeclaration, isExportDeclaration, isFunctionDeclaration, isIdentifier, isNamedExports, isVariableStatement } = typescript;
type Node = typescript.Node;
type SourceFile = typescript.SourceFile;
type Statement = typescript.Statement;

/**
 * runtime.js ohne die Definitionen, die von `usedNames` aus nicht erreichbar sind. `usedNames` sind
 * die Runtime-Namen, die die emittierten Dateien importieren (getUsedRuntimeNames).
 *
 * Voraussetzung: Die Runtime hat beim Laden keine Seiteneffekte, jede Anweisung auf oberster Ebene
 * ist eine Deklaration (scripts/check-runtime-purity.mjs). Nur dann ist es sicher, eine Deklaration
 * wegzulassen, die niemand erreicht.
 *
 * Erreichbarkeit geht nach Namen, nicht nach Bindungen: Ein lokaler Bezeichner, der wie eine
 * Definition der obersten Ebene heißt, hält diese am Leben. Das schätzt nur nach oben ab.
 *
 * Eine weggelassene Anweisung wird durch ihre Zeilenumbrüche ersetzt. Damit bleiben alle
 * Zeilennummern gleich, Stacktraces und Source Maps auf runtime.js stimmen weiter.
 */
export function shakeRuntime(runtimeJs: string, usedNames: Iterable<string>): string {
	const sourceFile = createSourceFile('runtime.js', runtimeJs, ScriptTarget.Latest, true, ScriptKind.JS);
	const statements = sourceFile.statements;
	const declaredNames = statements.map(statement => getDeclaredNames(statement, sourceFile));
	/** Anweisungen je deklariertem Namen, auch export { a as b } unter b. */
	const statementsByName = new Map<string, number[]>();
	declaredNames.forEach((names, index) => {
		names.forEach(name => {
			const indices = statementsByName.get(name) ?? [];
			indices.push(index);
			statementsByName.set(name, indices);
		});
	});
	const kept = new Set<number>();
	const pending: number[] = [];
	const keepName = (name: string) => {
		statementsByName.get(name)?.forEach(index => {
			if (!kept.has(index)) {
				kept.add(index);
				pending.push(index);
			}
		});
	};
	// Alles, was nichts deklariert, bleibt stehen. Nach der Voraussetzung sind das nur leere
	// Anweisungen, der Fall ist also nur Vorsicht.
	declaredNames.forEach((names, index) => {
		if (!names.length) {
			kept.add(index);
			pending.push(index);
		}
	});
	for (const name of usedNames) {
		keepName(name);
	}
	while (pending.length) {
		const index = pending.pop()!;
		collectReferencedNames(statements[index]!, sourceFile).forEach(keepName);
	}
	let result = '';
	let position = 0;
	statements.forEach((statement, index) => {
		if (kept.has(index)) {
			return;
		}
		const start = statement.getStart(sourceFile);
		const end = statement.getEnd();
		result += runtimeJs.slice(position, start) + runtimeJs.slice(start, end).replace(/[^\n]/g, '');
		position = end;
	});
	return result + runtimeJs.slice(position);
}

function getDeclaredNames(statement: Statement, sourceFile: SourceFile): string[] {
	if (isVariableStatement(statement)) {
		return statement.declarationList.declarations.flatMap(declaration =>
			isIdentifier(declaration.name) ? [declaration.name.text] : []);
	}
	if ((isFunctionDeclaration(statement) || isClassDeclaration(statement)) && statement.name) {
		return [statement.name.text];
	}
	if (isExportDeclaration(statement) && statement.exportClause && isNamedExports(statement.exportClause)) {
		return statement.exportClause.elements.map(element => element.name.getText(sourceFile));
	}
	return [];
}

/**
 * Alle Bezeichner im Teilbaum, außer Feld- und Methodennamen: `values.map(...)` darf `map` nicht
 * am Leben halten.
 */
function collectReferencedNames(statement: Statement, sourceFile: SourceFile): string[] {
	const names: string[] = [];
	const visit = (node: Node) => {
		if (isIdentifier(node) && !isMemberName(node)) {
			names.push(node.text);
		}
		forEachChild(node, visit);
	};
	visit(statement);
	// Bei export { a as b } ist a die Referenz, b der deklarierte Name.
	if (isExportDeclaration(statement) && statement.exportClause && isNamedExports(statement.exportClause)) {
		statement.exportClause.elements.forEach(element => names.push((element.propertyName ?? element.name).getText(sourceFile)));
	}
	return names;
}

function isMemberName(identifier: typescript.Identifier): boolean {
	const parent = identifier.parent;
	switch (parent.kind) {
		case SyntaxKind.PropertyAccessExpression:
			return (parent as typescript.PropertyAccessExpression).name === identifier;
		case SyntaxKind.PropertyAssignment:
		case SyntaxKind.MethodDeclaration:
		case SyntaxKind.PropertyDeclaration:
		case SyntaxKind.GetAccessor:
		case SyntaxKind.SetAccessor:
			return (parent as typescript.NamedDeclaration).name === identifier;
		case SyntaxKind.ExportSpecifier:
			// Wird in collectReferencedNames gezielt behandelt.
			return true;
		default:
			return false;
	}
}
