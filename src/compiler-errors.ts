// Fehlercodes des Compilers und ihre Metadaten.
// Die Erklärung zu jedem Code steht in der Dokumentation (documentation/error-codes),
// nicht hier - der sprechende Enum-Name verbindet beide Seiten.

export type CompilerErrorType =
	/**
	 * Der Code ließ sich grammatikalisch nicht lesen, es entsteht kein brauchbarer Baum.
	 */
	| 'syntax'
	/**
	 * Der Baum steht, aber das Konstrukt ist regelwidrig:
	 * an dieser Stelle nicht erlaubt, Namenskollision oder unauflösbarer Import.
	 */
	| 'semantic'
	/**
	 * Typfehler, erzeugt vom Checker.
	 */
	| 'type';

/**
 * Wie schwer der Fehler wiegt. Eigene Werte statt der LSP-Zahlen,
 * damit der Compiler nicht von vscode-languageserver abhängt - er läuft auch als CLI.
 */
export type CompilerErrorSeverity = 'error' | 'warning' | 'hint';

/**
 * Nummern werden nie wiederverwendet, auch nicht nach dem Entfernen eines Fehlers -
 * sonst brechen Unterdrückungskommentare und Links in die Dokumentation.
 *
 * Ein neuer Code braucht drei Einträge, sonst ist er unvollständig:
 * 1. hier im Enum,
 * 2. in errorInfos darunter - der Mapped Type erzwingt das,
 * 3. einen Abschnitt in jul-homepage/docs/docs/documentation/error-codes.md
 *    (`### JUL<nr> — Titel {#jul<nr>}`, darunter `type` · `severity` · `Message` und ein Beispiel).
 * Schritt 3 erzwingt kein Compiler, wird also am leichtesten vergessen - die Doku ist aber
 * das, was der Nutzer zum Code in der Fehlermeldung findet.
 */
export enum ErrorCode {
	//#region 1000 syntax
	// Token/Lexer
	unexpectedCharacter = 1000,
	endOfCode = 1001,
	regexAtEndOfCode = 1002,
	invalidName = 1010,
	invalidIndexSyntax = 1011,
	invalidNumber = 1012,
	invalidLanguageIdentifier = 1013,
	invalidTextSyntax = 1014,
	// Kombinatoren
	expectedOneOf = 1050,
	// Zeilen- und Einrückungslayout
	expectedStartOfLine = 1100,
	expectedEndOfLine = 1101,
	unparsedRestOfRow = 1102,
	// Abbruch, nicht geparster Restcode
	unparsedCode = 1150,
	expectedNestedKey = 1151,
	expectedExpression = 1152,
	// JSON-Subparser
	invalidJson = 1200,
	//#endregion 1000 syntax

	//#region 2000 semantic: Sprachregeln
	// Destructuring
	spreadNotAllowedForDestructuring = 2000,
	typeGuardNotAllowedForDestructuring = 2001,
	assignedValueMissingForDestructuring = 2002,
	emptyDestructuring = 2003,
	invalidDestructuringFieldName = 2004,
	spreadNotSupportedForDestructuring = 2005,
	// Definition/valueExpression
	assignedValueMissingForDefinition = 2100,
	spreadNotAllowedForValueExpression = 2101,
	typeGuardNotAllowedForValueExpression = 2102,
	definitionNotAllowedForValueExpression = 2103,
	invalidBracketedExpression = 2104,
	dataLiteralMustUseSquareBrackets = 2105,
	// Dictionary- und DictionaryType-Felder
	typeGuardNotAllowedForSpreadDictionaryField = 2200,
	definitionNotAllowedForSpreadDictionaryField = 2201,
	assignedValueMissingForDictionaryField = 2202,
	definitionNotAllowedForDictionaryTypeField = 2203,
	typeGuardNotAllowedForSpreadDictionaryTypeField = 2204,
	// Namen, escaped names
	escapedNameIsMultilineText = 2300,
	escapedNameHasInterpolation = 2301,
	invalidEscapableName = 2302,
	// Parameter
	invalidParameterSource = 2400,
	restArgumentNotLast = 2401,
	/**
	 * Ein Wert steht im Quelltext und kommt nirgends an, weil das Ziel ihn nicht aufnimmt.
	 * Keine Typverletzung: Längere Werte sind zulässig, ein Typ nennt Anforderungen.
	 * Gemeldet wird nur, was an derselben Stelle geschrieben steht und gelöscht werden kann -
	 * nicht ein Spread und nicht eine Variable, die zufällig mehr enthält.
	 */
	discardedValue = 2500,
	//#endregion 2000 semantic: Sprachregeln

	//#region 3000 semantic: Import und Modulauflösung
	importArgumentsMissing = 3000,
	invalidImportExtension = 3010,
	fileNotFound = 3020,
	dynamicImportNotAllowed = 3030,
	//#endregion 3000 semantic: Import und Modulauflösung

	//#region 4000 semantic: Namensauflösung und Scopes
	alreadyDefined = 4000,
	notDefined = 4001,
	usedBeforeDefined = 4002,
	alreadyDefinedInUpperScope = 4003,
	//#endregion 4000 semantic: Namensauflösung und Scopes

	//#region 5000 type: Typprüfung
	definitionTypeMismatch = 5000,
	destructuringFieldTypeMismatch = 5001,
	typeGuardIsNotType = 5002,
	/**
	 * Der Params-Typ einer Funktion wird gegen die Argumentkollektion geprüft, und die ist List,
	 * Dictionary oder Empty. Gemeldet wird, wenn der Typ bewohnt ist und keiner seiner Werte eine
	 * Kollektion sein kann - dann ist die Funktion nicht aufrufbar. Never ist unbewohnt und fällt
	 * daher nicht darunter, ohne dass es dazu eine Ausnahme braucht.
	 */
	paramsTypeIsNotCollection = 5003,
	argumentTypeMismatch = 5050,
	returnTypeMismatch = 5100,
	branchIsNotFunction = 5150,
	valueIsNotFunction = 5151,
	dereferenceFailed = 5160,
	//#endregion 5000 type: Typprüfung
}

interface ErrorInfo {
	type: CompilerErrorType;
	severity: CompilerErrorSeverity;
}

/**
 * Kategorie und Schweregrad je Fehlercode.
 * Der Mapped Type erzwingt Vollständigkeit: ein neuer Code ohne Eintrag ist ein Compile-Fehler.
 */
export const errorInfos: { [Code in ErrorCode]: ErrorInfo; } = {
	[ErrorCode.unexpectedCharacter]: { type: 'syntax', severity: 'error' },
	[ErrorCode.endOfCode]: { type: 'syntax', severity: 'error' },
	[ErrorCode.regexAtEndOfCode]: { type: 'syntax', severity: 'error' },
	[ErrorCode.invalidName]: { type: 'syntax', severity: 'error' },
	[ErrorCode.invalidIndexSyntax]: { type: 'syntax', severity: 'error' },
	[ErrorCode.invalidNumber]: { type: 'syntax', severity: 'error' },
	[ErrorCode.invalidLanguageIdentifier]: { type: 'syntax', severity: 'error' },
	[ErrorCode.invalidTextSyntax]: { type: 'syntax', severity: 'error' },
	[ErrorCode.expectedOneOf]: { type: 'syntax', severity: 'error' },
	[ErrorCode.expectedStartOfLine]: { type: 'syntax', severity: 'error' },
	[ErrorCode.expectedEndOfLine]: { type: 'syntax', severity: 'error' },
	[ErrorCode.unparsedRestOfRow]: { type: 'syntax', severity: 'error' },
	[ErrorCode.unparsedCode]: { type: 'syntax', severity: 'error' },
	[ErrorCode.expectedNestedKey]: { type: 'syntax', severity: 'error' },
	[ErrorCode.expectedExpression]: { type: 'syntax', severity: 'error' },
	[ErrorCode.invalidJson]: { type: 'syntax', severity: 'error' },
	[ErrorCode.spreadNotAllowedForDestructuring]: { type: 'semantic', severity: 'error' },
	[ErrorCode.typeGuardNotAllowedForDestructuring]: { type: 'semantic', severity: 'error' },
	[ErrorCode.assignedValueMissingForDestructuring]: { type: 'semantic', severity: 'error' },
	[ErrorCode.emptyDestructuring]: { type: 'semantic', severity: 'error' },
	[ErrorCode.invalidDestructuringFieldName]: { type: 'semantic', severity: 'error' },
	[ErrorCode.spreadNotSupportedForDestructuring]: { type: 'semantic', severity: 'error' },
	[ErrorCode.assignedValueMissingForDefinition]: { type: 'semantic', severity: 'error' },
	[ErrorCode.spreadNotAllowedForValueExpression]: { type: 'semantic', severity: 'error' },
	[ErrorCode.typeGuardNotAllowedForValueExpression]: { type: 'semantic', severity: 'error' },
	[ErrorCode.definitionNotAllowedForValueExpression]: { type: 'semantic', severity: 'error' },
	[ErrorCode.invalidBracketedExpression]: { type: 'semantic', severity: 'error' },
	[ErrorCode.dataLiteralMustUseSquareBrackets]: { type: 'semantic', severity: 'error' },
	[ErrorCode.typeGuardNotAllowedForSpreadDictionaryField]: { type: 'semantic', severity: 'error' },
	[ErrorCode.definitionNotAllowedForSpreadDictionaryField]: { type: 'semantic', severity: 'error' },
	[ErrorCode.assignedValueMissingForDictionaryField]: { type: 'semantic', severity: 'error' },
	[ErrorCode.definitionNotAllowedForDictionaryTypeField]: { type: 'semantic', severity: 'error' },
	[ErrorCode.typeGuardNotAllowedForSpreadDictionaryTypeField]: { type: 'semantic', severity: 'error' },
	[ErrorCode.escapedNameIsMultilineText]: { type: 'semantic', severity: 'error' },
	[ErrorCode.escapedNameHasInterpolation]: { type: 'semantic', severity: 'error' },
	[ErrorCode.invalidEscapableName]: { type: 'semantic', severity: 'error' },
	[ErrorCode.invalidParameterSource]: { type: 'semantic', severity: 'error' },
	[ErrorCode.restArgumentNotLast]: { type: 'semantic', severity: 'error' },
	[ErrorCode.discardedValue]: { type: 'semantic', severity: 'warning' },
	[ErrorCode.importArgumentsMissing]: { type: 'semantic', severity: 'error' },
	[ErrorCode.invalidImportExtension]: { type: 'semantic', severity: 'error' },
	[ErrorCode.fileNotFound]: { type: 'semantic', severity: 'error' },
	[ErrorCode.dynamicImportNotAllowed]: { type: 'semantic', severity: 'error' },
	[ErrorCode.alreadyDefined]: { type: 'semantic', severity: 'error' },
	[ErrorCode.notDefined]: { type: 'semantic', severity: 'error' },
	[ErrorCode.usedBeforeDefined]: { type: 'semantic', severity: 'error' },
	[ErrorCode.alreadyDefinedInUpperScope]: { type: 'semantic', severity: 'error' },
	[ErrorCode.definitionTypeMismatch]: { type: 'type', severity: 'error' },
	[ErrorCode.destructuringFieldTypeMismatch]: { type: 'type', severity: 'error' },
	[ErrorCode.typeGuardIsNotType]: { type: 'type', severity: 'error' },
	[ErrorCode.paramsTypeIsNotCollection]: { type: 'type', severity: 'error' },
	[ErrorCode.argumentTypeMismatch]: { type: 'type', severity: 'error' },
	[ErrorCode.returnTypeMismatch]: { type: 'type', severity: 'error' },
	[ErrorCode.branchIsNotFunction]: { type: 'type', severity: 'error' },
	[ErrorCode.valueIsNotFunction]: { type: 'type', severity: 'error' },
	[ErrorCode.dereferenceFailed]: { type: 'type', severity: 'error' },
};

/**
 * Ein Fehler im kompilierten Quelltext, an dessen Position.
 * Wird von allen Phasen erzeugt (Parser wie Checker) - deshalb sagt der Code, um welche Art es sich
 * handelt, und nicht die Liste, in der der Fehler landet: derselbe Fehler kann in unchecked und
 * checked errors stehen.
 *
 * Nicht gemeint sind Fehler des Compilers selbst (verletzte Invarianten).
 * Die werden geworfen und nicht gesammelt.
 */
export interface CompilerError extends Positioned {
	code: ErrorCode;
	message: string;
	// TODO isFatal?
	/**
	 * Zusätzlicher Verweis auf eine zweite Stelle im Quelltext, die den Fehler erklärt (z.B. die
	 * Deklaration eines Rückgabetyps) - additiv, ersetzt startRowIndex/... nicht. Von CLI
	 * (formatErrors) als zusätzliche Textzeile und vom Language Server als
	 * `Diagnostic.relatedInformation` genutzt.
	 */
	relatedInformation?: {
		message: string;
	} & Positioned;
}

export interface Positioned {
	startRowIndex: number;
	startColumnIndex: number;
	endRowIndex: number;
	endColumnIndex: number;
}