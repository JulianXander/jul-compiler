import { dirname } from 'path';
import { getPathFromImport, isImportFunctionCall } from '../parser/parser.js';
import { isExportedSymbol } from '../parser/parser-utils.js';
import { builtinAny, CompileTimeType, ParseDestructuringField, SymbolDefinition } from '../syntax-tree.js';
import { Positioned } from '../compiler-errors.js';
import type { ParsedDocuments } from './checker.js';

export interface ReferenceLocation extends Positioned {
	filePath: string;
}

export interface FieldSymbolLocation {
	symbol: SymbolDefinition;
	/**
	 * Leerstring, wenn builtin.
	 */
	filePath: string;
}

/**
 * Löst einen Feldnamen gegen einen Dictionary-Typ auf dessen Felddeklaration(en) auf - die einzige
 * Brücke von einem Feldzugriff zurück zu einem Symbol. Bei einer Union/Intersection ist derselbe
 * Name ggf. in mehreren Zweigen deklariert, dann gehört die Fundstelle zu allen.
 */
export function getFieldSymbolsFromDictionaryType(
	dictionaryType: CompileTimeType,
	fieldName: string,
	result: FieldSymbolLocation[] = [],
): FieldSymbolLocation[] {
	switch (dictionaryType.julType) {
		case 'dictionaryLiteral': {
			const declaration = dictionaryType.declaration;
			const foundSymbol = declaration?.expression.symbols[fieldName];
			if (declaration && foundSymbol) {
				result.push({
					symbol: foundSymbol,
					filePath: declaration.filePath,
				});
			}
			return result;
		}
		case 'and':
		case 'or': {
			dictionaryType.ChoiceTypes.forEach(choiceType => {
				getFieldSymbolsFromDictionaryType(choiceType, fieldName, result);
			});
			return result;
		}
		case 'typeOf':
			return getFieldSymbolsFromDictionaryType(dictionaryType.value, fieldName, result);
		case 'alias':
			// Der Alias ist Beschriftung; die Felddeklaration steht am Typ dahinter.
			return getFieldSymbolsFromDictionaryType(
				dictionaryType.symbol.typeInfo?.type ?? builtinAny,
				fieldName,
				result);
		default:
			return result;
	}
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
	if (!importedSymbol
		|| !isExportedSymbol(importedSymbol)) {
		return undefined;
	}
	return {
		symbol: importedSymbol,
		filePath: fullPath,
	};
}

/**
 * Löst ein Symbol auf seine kanonische Ursprungsdeklaration auf. Ein Hop genügt: Exportiert werden
 * nur Definitionen, ein Import-Binding zeigt also immer direkt auf die Deklaration.
 *
 * Ein Alias (`(local: source) = import(...)`) ist eine eigene Identität: der lokale Name lebt
 * unabhängig vom Ursprungsnamen weiter, Rename/Find-All-References dürfen ihn nicht mitziehen.
 * Deshalb wird nur bei unaliasierten Import-Bindings weiterverfolgt - das `source`-Token selbst
 * wird separat behandelt (siehe checker.ts, Aufrufstelle von `resolveImportBinding`).
 */
export function resolveCanonicalSymbol(
	symbol: SymbolDefinition,
	filePath: string,
	documents: ParsedDocuments,
): { symbol: SymbolDefinition; filePath: string; } {
	const definition = symbol.definition;
	if (definition?.type !== 'destructuringField' || definition.source) {
		return { symbol, filePath };
	}
	return followImportHop(definition, filePath, documents)
		?? { symbol, filePath };
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
	return followImportHop(definition, filePath, documents);
}

interface IndexEntry {
	symbolKey: string;
	location: ReferenceLocation;
}

export interface SymbolLocation {
	symbol: SymbolDefinition;
	filePath: string;
}

/**
 * Ein Symbol, das zu einem Feld eines Typs gehört, ohne selbst dieses Feld zu sein: das Feld eines
 * Literals an einer Stelle mit erwartetem Typ, oder der lokale Name eines Destructurings ohne Alias.
 */
interface RelatedEntry {
	typeFieldKey: string;
	typeField: SymbolLocation;
	relatedKey: string;
	related: SymbolLocation;
}

/**
 * Projektweiter, dateigeshardeter Referenz-Index: Rename und Find-All-References werden damit zu
 * reinen Lookups (O(Treffer)) statt Suchen über alle Dateien. Siehe
 * jul-compiler/docs/cross-file-reference-index.md.
 */
export class ReferenceIndex {
	#byReferenceFile = new Map<string, Set<IndexEntry>>();
	#bySymbolKey = new Map<string, Set<ReferenceLocation>>();
	#relatedByFile = new Map<string, Set<RelatedEntry>>();
	#relatedByTypeFieldKey = new Map<string, Set<RelatedEntry>>();
	#relatedByRelatedKey = new Map<string, Set<RelatedEntry>>();

	/**
	 * Verknüpft ein Symbol mit dem Feld eines Typs, zu dem es gehört (TypeScript: "related
	 * symbols"). Die Verknüpfung gehört zur Datei des verknüpften Symbols und wird mit deren
	 * Einträgen entfernt.
	 */
	recordRelatedSymbol(typeField: SymbolLocation, related: SymbolLocation): void {
		const entry: RelatedEntry = {
			typeFieldKey: getSymbolKey(typeField.filePath, typeField.symbol),
			typeField: typeField,
			relatedKey: getSymbolKey(related.filePath, related.symbol),
			related: related,
		};
		addToSetMap(this.#relatedByFile, related.filePath, entry);
		addToSetMap(this.#relatedByTypeFieldKey, entry.typeFieldKey, entry);
		addToSetMap(this.#relatedByRelatedKey, entry.relatedKey, entry);
	}

	/**
	 * Die Symbole, die mit einem Typfeld verknüpft sind.
	 */
	getRelatedSymbols(typeField: SymbolDefinition, filePath: string): SymbolLocation[] {
		const entries = this.#relatedByTypeFieldKey.get(getSymbolKey(filePath, typeField));
		return entries
			? [...entries].map(entry => entry.related)
			: [];
	}

	/**
	 * Die Typfelder, mit denen ein Symbol verknüpft ist. Leer, wenn es selbst ein Typfeld ist oder
	 * zu keinem gehört.
	 */
	getRelatedTypeFields(symbol: SymbolDefinition, filePath: string): SymbolLocation[] {
		const entries = this.#relatedByRelatedKey.get(getSymbolKey(filePath, symbol));
		return entries
			? [...entries].map(entry => entry.typeField)
			: [];
	}

	recordReference(canonicalSymbol: SymbolDefinition, canonicalFilePath: string, location: ReferenceLocation): void {
		const symbolKey = getSymbolKey(canonicalFilePath, canonicalSymbol);
		const entry: IndexEntry = { symbolKey, location };
		addToSetMap(this.#byReferenceFile, location.filePath, entry);
		addToSetMap(this.#bySymbolKey, symbolKey, location);
	}

	/**
	 * Nur die Referenzen auf das Symbol selbst, ohne die verknüpften Symbole.
	 */
	getDirectReferences(canonicalSymbol: SymbolDefinition, canonicalFilePath: string): ReferenceLocation[] {
		const entries = this.#bySymbolKey.get(getSymbolKey(canonicalFilePath, canonicalSymbol));
		return entries
			? [...entries]
			: [];
	}

	/**
	 * Die Referenzen auf das Symbol und, wenn es ein Typfeld ist, auf die damit verknüpften
	 * Symbole. Nur ein Schritt weit: Zwei Typfelder, die über ein gemeinsames Literal verknüpft
	 * sind, hängen dadurch nicht aneinander.
	 */
	getReferences(canonicalSymbol: SymbolDefinition, canonicalFilePath: string): ReferenceLocation[] {
		const symbolKey = getSymbolKey(canonicalFilePath, canonicalSymbol);
		const result = new Map<string, ReferenceLocation>();
		const addReferences = (key: string) => {
			this.#bySymbolKey.get(key)?.forEach(location => {
				result.set(getSymbolKey(location.filePath, location), location);
			});
		};
		addReferences(symbolKey);
		this.#relatedByTypeFieldKey.get(symbolKey)?.forEach(entry => {
			addReferences(entry.relatedKey);
		});
		return [...result.values()];
	}

	/**
	 * Entfernt alle Einträge, die von Referenzen in `filePath` stammen - unabhängig davon, auf
	 * welches (ggf. andere) Symbol sie zeigen. Vor jedem Re-Check einer Datei aufzurufen, damit
	 * ein erneuter Checklauf keine veralteten/doppelten Einträge hinterlässt.
	 */
	clearReferencesFromFile(filePath: string): void {
		const relatedEntries = this.#relatedByFile.get(filePath);
		if (relatedEntries) {
			for (const entry of relatedEntries) {
				deleteFromSetMap(this.#relatedByTypeFieldKey, entry.typeFieldKey, entry);
				deleteFromSetMap(this.#relatedByRelatedKey, entry.relatedKey, entry);
			}
			this.#relatedByFile.delete(filePath);
		}
		const referenceFileEntries = this.#byReferenceFile.get(filePath);
		if (!referenceFileEntries) {
			return;
		}
		for (const { symbolKey, location } of referenceFileEntries) {
			deleteFromSetMap(this.#bySymbolKey, symbolKey, location);
		}
		this.#byReferenceFile.delete(filePath);
	}
}

function addToSetMap<T>(map: Map<string, Set<T>>, key: string, value: T): void {
	let values = map.get(key);
	if (!values) {
		values = new Set();
		map.set(key, values);
	}
	values.add(value);
}

function deleteFromSetMap<T>(map: Map<string, Set<T>>, key: string, value: T): void {
	const values = map.get(key);
	values?.delete(value);
	if (values?.size === 0) {
		map.delete(key);
	}
}
