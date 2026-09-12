import { dirname } from 'path';
import { getPathFromImport, isImportFunctionCall } from '../parser/parser.js';
import { ParseDestructuringField, SymbolDefinition } from '../syntax-tree.js';
import { Positioned } from '../compiler-errors.js';
import type { ParsedDocuments } from './checker.js';

export interface ReferenceLocation extends Positioned {
	filePath: string;
}

function getSymbolKey(filePath: string, symbol: Positioned): string {
	return `${filePath}#${symbol.startRowIndex}:${symbol.startColumnIndex}`;
}

/**
 * Folgt einem nicht-aliasierten Import-Binding einen Hop weit zur Deklaration in der importierten
 * Datei. Ein Alias (destructuringField.source gesetzt) wird bewusst trotzdem einen Hop weit verfolgt,
 * wenn der Aufrufer das explizit für das source-Token braucht (siehe checker.ts) - resolveCanonicalSymbol
 * selbst ruft das nur für unaliasierte Felder auf.
 */
function followImportHop(
	definition: ParseDestructuringField,
	filePath: string,
	documents: ParsedDocuments,
): { symbol: SymbolDefinition; filePath: string; } | undefined {
	const destructuringFields = definition.parent;
	const destructuring = destructuringFields?.type === 'destructuringFields'
		? destructuringFields.parent
		: undefined;
	if (destructuring?.type !== 'destructuring'
		|| !destructuring.value
		|| !isImportFunctionCall(destructuring.value)) {
		return undefined;
	}
	const { fullPath, error } = getPathFromImport(destructuring.value, dirname(filePath));
	if (error || !fullPath) {
		return undefined;
	}
	const importedDocument = documents[fullPath];
	if (!importedDocument) {
		return undefined;
	}
	const importedExpressions = importedDocument.checked ?? importedDocument.unchecked;
	const importedSymbol = importedExpressions.symbols[definition.source?.name ?? definition.name.name];
	if (!importedSymbol) {
		return undefined;
	}
	return {
		symbol: importedSymbol,
		filePath: fullPath,
	};
}

/**
 * Löst ein Symbol bis zur kanonischen Ursprungsdeklaration auf, auch über mehrere Re-Export-Stufen.
 *
 * Ein Alias (`(local: source) = import(...)`) ist eine eigene Identität: der lokale Name lebt
 * unabhängig vom Ursprungsnamen weiter, Rename/Find-All-References dürfen ihn nicht mitziehen.
 * Deshalb wird nur bei unaliasierten Import-Bindings weiterverfolgt - das `source`-Token selbst
 * wird separat behandelt (siehe checker.ts, Aufrufstelle von `followImportHop`).
 */
export function resolveCanonicalSymbol(
	symbol: SymbolDefinition,
	filePath: string,
	documents: ParsedDocuments,
): { symbol: SymbolDefinition; filePath: string; } {
	let currentSymbol = symbol;
	let currentFilePath = filePath;
	const visitedFilePaths = new Set<string>([filePath]);
	for (; ;) {
		const definition = currentSymbol.definition;
		if (definition?.type !== 'destructuringField' || definition.source) {
			return { symbol: currentSymbol, filePath: currentFilePath };
		}
		const hop = followImportHop(definition, currentFilePath, documents);
		if (!hop || visitedFilePaths.has(hop.filePath)) {
			return { symbol: currentSymbol, filePath: currentFilePath };
		}
		visitedFilePaths.add(hop.filePath);
		currentSymbol = hop.symbol;
		currentFilePath = hop.filePath;
	}
}

/**
 * Löst genau einen Import-Hop auf - unabhängig davon, ob das Binding aliasiert ist. Wird vom
 * Checker beim Auswerten einer `destructuring` benutzt, um das `source`-Token (bei Alias) bzw.
 * das `name`-Token (ohne Alias) auf die Ursprungsdeklaration zu beziehen.
 */
export function resolveImportBinding(
	definition: ParseDestructuringField,
	filePath: string,
	documents: ParsedDocuments,
): { symbol: SymbolDefinition; filePath: string; } | undefined {
	const hop = followImportHop(definition, filePath, documents);
	if (!hop) {
		return undefined;
	}
	return resolveCanonicalSymbol(hop.symbol, hop.filePath, documents);
}

interface IndexEntry {
	symbolKey: string;
	location: ReferenceLocation;
}

/**
 * Projektweiter, dateigeshardeter Referenz-Index: Rename und Find-All-References werden damit zu
 * reinen Lookups (O(Treffer)) statt Suchen über alle Dateien. Siehe
 * jul-compiler/docs/cross-file-reference-index.md.
 */
export class ReferenceIndex {
	#byReferenceFile = new Map<string, Set<IndexEntry>>();
	#bySymbolKey = new Map<string, Set<ReferenceLocation>>();

	recordReference(canonicalSymbol: SymbolDefinition, canonicalFilePath: string, location: ReferenceLocation): void {
		const symbolKey = getSymbolKey(canonicalFilePath, canonicalSymbol);
		const entry: IndexEntry = { symbolKey, location };
		let referenceFileEntries = this.#byReferenceFile.get(location.filePath);
		if (!referenceFileEntries) {
			referenceFileEntries = new Set();
			this.#byReferenceFile.set(location.filePath, referenceFileEntries);
		}
		referenceFileEntries.add(entry);
		let symbolEntries = this.#bySymbolKey.get(symbolKey);
		if (!symbolEntries) {
			symbolEntries = new Set();
			this.#bySymbolKey.set(symbolKey, symbolEntries);
		}
		symbolEntries.add(location);
	}

	getReferences(canonicalSymbol: SymbolDefinition, canonicalFilePath: string): ReferenceLocation[] {
		const symbolKey = getSymbolKey(canonicalFilePath, canonicalSymbol);
		const entries = this.#bySymbolKey.get(symbolKey);
		return entries
			? [...entries]
			: [];
	}

	/**
	 * Entfernt alle Einträge, die von Referenzen in `filePath` stammen - unabhängig davon, auf
	 * welches (ggf. andere) Symbol sie zeigen. Vor jedem Re-Check einer Datei aufzurufen, damit
	 * ein erneuter Checklauf keine veralteten/doppelten Einträge hinterlässt.
	 */
	clearReferencesFromFile(filePath: string): void {
		const referenceFileEntries = this.#byReferenceFile.get(filePath);
		if (!referenceFileEntries) {
			return;
		}
		for (const { symbolKey, location } of referenceFileEntries) {
			const symbolEntries = this.#bySymbolKey.get(symbolKey);
			symbolEntries?.delete(location);
			if (symbolEntries?.size === 0) {
				this.#bySymbolKey.delete(symbolKey);
			}
		}
		this.#byReferenceFile.delete(filePath);
	}
}
