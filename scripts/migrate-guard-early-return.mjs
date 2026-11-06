// Dreht Verzweigungen um, bei denen der Hauptweg im Arm steht und der Sonderfall als Rest dahinter:
//
//   ?(activeDeck)                         ?(activeDeck)
//   	[Deck] =>                          	[Empty] => log(§no deck selected§)
//   		newDeck = …              ->       newDeck = …
//   		setState(newDeck)                 setState(newDeck)
//   log(§no deck selected§)
//
// Der Arm wird zum Wächter für den Sonderfall und kehrt früh zurück, der Hauptweg steht flach im
// Rumpf. Umgeformt wird ein Branching mit genau einem Arm, auf das genau ein Ausdruck folgt, der
// den Rumpf beendet, wenn der Rumpf des Arms mehr Zeilen hat als dieser Rest.
//
// Der neue Kopf:
// - [true] und [false] tauschen.
// - Lässt der Typ des verzweigten Werts neben dem Kopf genau eine Alternative übrig, die sich als
//   Name oder Literal schreiben lässt, steht diese da (meist Empty).
// - Sonst Not(<alter Kopf>).
//
// Nicht umgeformt, sondern als "von Hand" gemeldet: ein Arm mit benannten Parametern, ein Arm, dessen
// Rumpf in der Kopfzeile beginnt, ein Rest aus mehreren Ausdrücken oder einer Definition, und ein
// Arm, der einen Namen definiert, den der umgebende Rumpf schon kennt. Ganz ausgelassen: ein Arm über
// Error oder Empty, der ist schon ein Wächter, und [§equal§], der Gleichstand einer Vergleichskette.
//
// Die Typen kommen aus dem Checker: Jede Datei wird über loadFile mit ihren Importen geladen. Nach
// einem Durchlauf wird die Datei neu geladen und erneut umgeformt, bis nichts mehr passt, damit
// verschachtelte Fälle nacheinander drankommen. Ein zweiter Lauf auf migriertem Code findet nichts
// mehr, weil danach der Rest länger ist als der Arm.
//
// Aufruf:
//   node scripts/migrate-guard-early-return.mjs [--compiler <out-verzeichnis>] [--write] <ziel...>
//
// Ohne --compiler wird jul-compiler/out verwendet, also vorher bauen.

import { pathToFileURL, fileURLToPath } from 'url';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';

//#region Umformung

const skipKeys = new Set(['parent', 'typeInfo', 'symbols']);

/** Ein Kopf, der sich als Quelltext in einen Listenkopf schreiben lässt. */
const simpleTypeText = /^(?:[A-Za-z]\w*|§[^§\n]*§|-?\d+)$/;

/**
 * @param code der Quelltext
 * @param parsed die mit Typen geladene Datei zu genau diesem Quelltext
 * @param api getTypeInfo und typeToString aus dem Compiler
 * @returns code: neuer Quelltext, manual: Stellen für Handarbeit, changes: Anzahl der Umformungen
 */
export function migrateCode(code, parsed, api) {
	const rows = code.split('\n');
	const indentOf = rowIndex => rows[rowIndex].match(/^\t*/)[0].length;
	const isBlank = rowIndex => rows[rowIndex].trim() === '';
	const isComment = rowIndex => rows[rowIndex].trim().startsWith('#');
	const typeText = type => type ? api.typeToString(type, 0, 2) : undefined;
	const manual = [];
	/** Ersetzungen ganzer Zeilenbereiche, nie überlappend. */
	const replacements = [];
	const overlaps = (from, to) => replacements.some(r => from <= r.to && r.from <= to);

	const getNewHead = (branching, headExpression, headText) => {
		const subject = branching.args?.type === 'list' && branching.args.values.length === 1
			? branching.args.values[0]
			: undefined;
		const subjectType = subject && api.getTypeInfo(parsed.checkResult, subject)?.type;
		// Tauschen nur, wenn der Wert sicher ein Boolean ist: Ein optionales Feld kann Empty sein
		// und gehört dann zum Rest, nicht zum anderen Literal.
		if (subjectType?.julType === 'boolean' && (headText === 'true' || headText === 'false')) {
			return headText === 'true' ? 'false' : 'true';
		}
		const branchType = api.getTypeInfo(parsed.checkResult, branching.branches[0])?.type;
		const headType = branchType?.julType === 'function'
			&& branchType.ParamsType.julType === 'parameters'
			? branchType.ParamsType.singleNames[0]?.type
			: undefined;
		if (subjectType?.julType === 'or' && headType) {
			const headChoices = new Set(headType.julType === 'or'
				? headType.ChoiceTypes.map(typeText)
				: [typeText(headType)]);
			const rest = subjectType.ChoiceTypes.map(typeText).filter(choice => !headChoices.has(choice));
			const allHeadChoicesFound = [...headChoices].every(choice => subjectType.ChoiceTypes.some(c => typeText(c) === choice));
			if (allHeadChoicesFound && rest.length === 1 && simpleTypeText.test(rest[0])) {
				return rest[0];
			}
		}
		return `Not(${headText})`;
	};

	const visitBody = (owner, body) => {
		// Der Parser hängt den Rest des Rumpfs hinter einem Branching als letzten Arm an (ohne
		// Parameter, auf der Einrückung des Branchings), das Branching ist dann der letzte Ausdruck.
		const branching = body[body.length - 1];
		if (branching?.type !== 'branching' || branching.branches.length !== 2) {
			return;
		}
		const restBranch = branching.branches[1];
		if (restBranch.type !== 'functionLiteral'
			|| restBranch.startColumnIndex !== indentOf(branching.startRowIndex)
			|| restBranch.startRowIndex <= branching.branches[0].endRowIndex) {
			return;
		}
		if (restBranch.body.length !== 1) {
			if (branching.branches[0].endRowIndex - branching.branches[0].startRowIndex >= restBranch.endRowIndex - restBranch.startRowIndex) {
				manual.push({ rowIndex: branching.startRowIndex, reason: 'Rest aus mehreren Ausdrücken' });
			}
			return;
		}
		const rest = restBranch.body[0];
		const branch = branching.branches[0];
		if (branch.type !== 'functionLiteral') {
			return;
		}
		const armRow = branch.startRowIndex;
		const armEnd = branch.endRowIndex;
		const restStart = rest.startRowIndex;
		const restEnd = rest.endRowIndex;
		const countLines = (from, to) => {
			let count = 0;
			for (let row = from; row <= to; row++) {
				if (!isBlank(row) && !isComment(row)) {
					count++;
				}
			}
			return count;
		};
		// Ohne die Kopfzeile: Nach dem Umdrehen tauschen Rumpf und Rest die Rollen, mit der Kopfzeile
		// würde ein gleich langes Paar bei jedem Durchlauf wieder umgedreht.
		if (countLines(armRow + 1, armEnd) <= countLines(restStart, restEnd)) {
			return;
		}
		const params = branch.params;
		if (params.type !== 'list' || params.values.length !== 1) {
			manual.push({ rowIndex: armRow, reason: 'Arm mit benannten Parametern' });
			return;
		}
		const headExpression = params.values[0];
		const headText = rows[headExpression.startRowIndex].slice(headExpression.startColumnIndex, headExpression.endColumnIndex);
		if (headExpression.startRowIndex !== headExpression.endRowIndex) {
			manual.push({ rowIndex: armRow, reason: 'mehrzeiliger Kopf' });
			return;
		}
		if (headText === 'Error' || headText === 'Empty' || headText === '§equal§') {
			return;
		}
		if (rest.type === 'definition' || rest.type === 'destructuring') {
			manual.push({ rowIndex: restStart, reason: 'Rest ist eine Definition' });
			return;
		}
		const firstBody = branch.body[0];
		if (!firstBody || firstBody.startRowIndex === armRow) {
			manual.push({ rowIndex: armRow, reason: 'Rumpf beginnt in der Kopfzeile' });
			return;
		}
		const outerNames = new Set(Object.keys(owner?.symbols ?? {}));
		const clash = Object.keys(branch.symbols ?? {}).find(name => outerNames.has(name));
		if (clash) {
			manual.push({ rowIndex: armRow, reason: `Name ${clash} gibt es im umgebenden Rumpf schon` });
			return;
		}
		const branchingIndent = indentOf(branching.startRowIndex);
		const armIndent = indentOf(armRow);
		if (armIndent !== branchingIndent + 1 || indentOf(restStart) !== branchingIndent) {
			manual.push({ rowIndex: armRow, reason: 'unerwartete Einrückung' });
			return;
		}
		if (overlaps(armRow, restEnd)) {
			return;
		}
		const newHead = getNewHead(branching, headExpression, headText);
		const armHeadLine = rows[armRow];
		const newArmHead = armHeadLine.slice(0, headExpression.startColumnIndex) + newHead + armHeadLine.slice(headExpression.endColumnIndex);
		const shift = (row, amount) => {
			if (isBlank(row)) {
				return '';
			}
			const indent = indentOf(row) + amount;
			if (indent < 0) {
				throw new Error(`Zeile ${row + 1}: Einrückung würde negativ`);
			}
			return '\t'.repeat(indent) + rows[row].slice(indentOf(row));
		};
		// Zeilen zwischen Arm und Rest: tiefer eingerückte Kommentare gehören zum Arm, die übrigen
		// Kommentare beschreiben den Rest und wandern mit ihm in den Wächter.
		let bodyEnd = armEnd;
		while (bodyEnd + 1 < restStart && (isBlank(bodyEnd + 1) || (isComment(bodyEnd + 1) && indentOf(bodyEnd + 1) > armIndent))) {
			bodyEnd++;
		}
		while (bodyEnd > armEnd && isBlank(bodyEnd)) {
			bodyEnd--;
		}
		const restComments = [];
		for (let row = bodyEnd + 1; row < restStart; row++) {
			if (!isBlank(row)) {
				restComments.push('\t'.repeat(armIndent) + rows[row].trim());
			}
		}
		const lines = [...restComments];
		if (restStart === restEnd) {
			lines.push(`${newArmHead} ${rows[restStart].trim()}`);
		}
		else {
			lines.push(newArmHead);
			for (let row = restStart; row <= restEnd; row++) {
				lines.push(shift(row, 2));
			}
		}
		for (let row = armRow + 1; row <= bodyEnd; row++) {
			lines.push(shift(row, -2));
		}
		replacements.push({ from: armRow, to: restEnd, lines: lines });
	};

	const seen = new WeakSet();
	(function walk(node) {
		if (!node || typeof node !== 'object' || seen.has(node)) {
			return;
		}
		seen.add(node);
		if (Array.isArray(node)) {
			node.forEach(walk);
			return;
		}
		// Außen zuerst: Ein innerer Fall, der mit einem äußeren überlappt, kommt im nächsten Durchlauf dran.
		if (node.type === 'functionLiteral' && Array.isArray(node.body)) {
			visitBody(node, node.body);
		}
		for (const key of Object.keys(node)) {
			if (!skipKeys.has(key)) {
				walk(node[key]);
			}
		}
	})(parsed.syntax.expressions);

	if (!replacements.length) {
		return { code: code, manual: manual, changes: 0 };
	}
	replacements.sort((a, b) => b.from - a.from);
	const output = [...rows];
	for (const replacement of replacements) {
		output.splice(replacement.from, replacement.to - replacement.from + 1, ...replacement.lines);
	}
	return { code: output.join('\n'), manual: manual, changes: replacements.length };
}

//#endregion Umformung

//#region Aufruf

function collectJulFiles(target, acc = []) {
	if (!statSync(target).isDirectory()) {
		if (target.endsWith('.jul')) {
			acc.push(resolve(target));
		}
		return acc;
	}
	for (const entry of readdirSync(target)) {
		if (entry === 'node_modules' || entry === 'out' || entry === '.git') {
			continue;
		}
		collectJulFiles(join(target, entry), acc);
	}
	return acc;
}

async function main() {
	const argv = process.argv.slice(2);
	const write = argv.includes('--write');
	const compilerIndex = argv.indexOf('--compiler');
	const compilerDir = compilerIndex >= 0
		? resolve(argv[compilerIndex + 1])
		: join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
	const targets = argv.filter((arg, index) => !arg.startsWith('--') && (compilerIndex < 0 || index !== compilerIndex + 1));
	if (!targets.length) {
		console.error('Keine Ziele angegeben.');
		process.exit(1);
	}
	const load = async path => import(pathToFileURL(join(compilerDir, path)).href);
	const { loadFile, createFileSystemHost } = await load('compiler/project-loader.js');
	const { getTypeInfo } = await load('checker/check-result.js');
	const { typeToString } = await load('checker/type-algebra.js');
	const api = { getTypeInfo, typeToString };
	const host = createFileSystemHost();
	const documents = {};
	let totalChanges = 0;
	let changedFiles = 0;
	const manual = [];
	for (const filePath of targets.flatMap(target => collectJulFiles(target))) {
		let code = readFileSync(filePath, 'utf8');
		let parsed = loadFile(filePath, documents, host, code);
		let fileChanges = 0;
		let fileManual = [];
		for (let pass = 0; pass < Number(process.env.MIGRATE_PASSES ?? 200); pass++) {
			const result = migrateCode(code, parsed, api);
			fileManual = result.manual;
			if (!result.changes) {
				break;
			}
			fileChanges += result.changes;
			code = result.code;
			parsed = loadFile(filePath, documents, host, code);
		}
		fileManual.forEach(entry => manual.push(`${filePath}:${entry.rowIndex + 1}  ${entry.reason}`));
		if (!fileChanges) {
			continue;
		}
		totalChanges += fileChanges;
		changedFiles++;
		console.log(String(fileChanges).padStart(5), filePath);
		if (write) {
			writeFileSync(filePath, code, 'utf8');
		}
	}
	if (manual.length) {
		console.log('\nVon Hand:');
		manual.forEach(line => console.log(`  ${line}`));
	}
	console.log(`\n${changedFiles} Dateien, ${totalChanges} Umformungen, ${write ? 'geschrieben' : 'nicht geschrieben (--write)'}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}

//#endregion Aufruf
