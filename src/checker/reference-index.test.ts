import { expect } from 'chai';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { checkTypes, ParsedDocuments } from './checker.js';
import { parseCode } from '../parser/parser.js';
import { ParsedFile } from '../syntax-tree.js';
import { ReferenceIndex } from './reference-index.js';

/**
 * Parst rekursiv inklusive Importe und checkt, analog zu checker-snapshot.test.ts, aber mit
 * echten Dateien in einem Temp-Ordner statt jul-examples - so lässt sich der Import-Graph für
 * diesen Test gezielt konstruieren (Re-Export-Kette, Alias).
 */
function parseAndCheck(filePath: string, documents: ParsedDocuments, referenceIndex: ReferenceIndex): ParsedFile {
	const existing = documents[filePath];
	if (existing) {
		return existing;
	}
	const code = readFileSync(filePath, { encoding: 'utf8' });
	const parsed = parseCode(code, filePath);
	documents[filePath] = parsed;
	parsed.dependencies?.forEach(dependencyPath => {
		parseAndCheck(dependencyPath, documents, referenceIndex);
	});
	checkTypes(parsed, documents, referenceIndex);
	return parsed;
}

describe('ReferenceIndex', () => {
	let folder: string;
	let originPath: string;
	let reexportPath: string;
	let directPath: string;
	let aliasPath: string;
	let documents: ParsedDocuments;
	let referenceIndex: ReferenceIndex;

	beforeEach(() => {
		folder = mkdtempSync(join(tmpdir(), 'jul-reference-index-'));
		originPath = join(folder, 'origin.jul');
		reexportPath = join(folder, 'reexport.jul');
		directPath = join(folder, 'direct.jul');
		aliasPath = join(folder, 'alias.jul');
		writeFileSync(originPath, 'foo = 1\n');
		// nicht-aliasierter Re-Export: foo bleibt über diese Datei importierbar
		writeFileSync(reexportPath, '(foo) = import(§./origin.jul§)\n');
		// nicht-aliasierter Import + lokale Nutzung
		writeFileSync(directPath, '(foo) = import(§./origin.jul§)\nusage = foo\n');
		// aliasierter Import (über die Re-Export-Kette) + lokale Nutzung des Alias
		writeFileSync(aliasPath, '(bar = foo) = import(§./reexport.jul§)\nusage = bar\n');
		documents = {};
		referenceIndex = new ReferenceIndex();
		[originPath, reexportPath, directPath, aliasPath].forEach(filePath => {
			parseAndCheck(filePath, documents, referenceIndex);
		});
	});

	afterEach(() => {
		rmSync(folder, { recursive: true, force: true });
	});

	it('sammelt alle Referenzen auf eine Deklaration über Re-Export-Ketten und Alias-Importe hinweg', () => {
		const fooSymbol = documents[originPath]!.checked!.symbols['foo']!;
		const references = referenceIndex.getReferences(fooSymbol, originPath);

		// reexport.jul (Import-Binding), direct.jul (Import-Binding), direct.jul (Nutzung),
		// alias.jul (source-Token) - nicht aber alias.jul's lokaler Alias-Name oder dessen Nutzung.
		expect(references).to.have.lengthOf(4);
		expect(references.some(location => location.filePath === reexportPath)).to.equal(true);
		expect(references.filter(location => location.filePath === directPath)).to.have.lengthOf(2);
		expect(references.some(location => location.filePath === aliasPath)).to.equal(true);
	});

	it('behandelt einen Alias als eigene Identität, unabhängig vom Ursprungssymbol', () => {
		const barSymbol = documents[aliasPath]!.checked!.symbols['bar']!;
		const references = referenceIndex.getReferences(barSymbol, aliasPath);

		// nur die lokale Nutzung "usage = bar", nichts aus dem foo-Ursprungscluster
		expect(references).to.have.lengthOf(1);
		expect(references[0]!.filePath).to.equal(aliasPath);
	});

	it('entfernt beim Recheck einer Datei nur deren eigene Einträge, ohne Duplikate anzuhäufen', () => {
		const fooSymbol = documents[originPath]!.checked!.symbols['foo']!;
		expect(referenceIndex.getReferences(fooSymbol, originPath)).to.have.lengthOf(4);

		// direct.jul ändert sich: Nutzung von foo entfällt, Import bleibt
		writeFileSync(directPath, '(foo) = import(§./origin.jul§)\n');
		const reparsed = parseCode(readFileSync(directPath, { encoding: 'utf8' }), directPath);
		documents[directPath] = reparsed;
		checkTypes(reparsed, documents, referenceIndex);

		const afterEdit = referenceIndex.getReferences(fooSymbol, originPath);
		expect(afterEdit).to.have.lengthOf(3);
		expect(afterEdit.filter(location => location.filePath === directPath)).to.have.lengthOf(1);

		// erneutes Checken ohne weitere Änderung darf nichts verdoppeln
		checkTypes(reparsed, documents, referenceIndex);
		expect(referenceIndex.getReferences(fooSymbol, originPath)).to.have.lengthOf(3);
	});
});
