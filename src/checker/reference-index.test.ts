import { expect } from 'chai';
import { join, resolve } from 'path';

import { checkTypes, ParsedDocuments } from './checker.js';
import { createInMemoryHost, loadFile, ProjectHost } from '../project-loader.js';
import { ParsedFile, SymbolDefinition } from '../syntax-tree.js';
import { ReferenceIndex } from './reference-index.js';

// Die Dateien gibt es nur im Speicher - so lässt sich der Import-Graph für diesen Test gezielt
// konstruieren (Re-Export-Kette, Alias).
const folder = resolve('/reference-index-test');

function load(filePath: string, documents: ParsedDocuments, host: ProjectHost, code?: string): ParsedFile {
	const parsed = loadFile(filePath, documents, host, code);
	if (typeof parsed === 'string') {
		throw new Error(`${parsed}: ${filePath}`);
	}
	return parsed;
}

describe('ReferenceIndex', () => {
	const originPath = join(folder, 'origin.jul');
	const reexportPath = join(folder, 'reexport.jul');
	const directPath = join(folder, 'direct.jul');
	const aliasPath = join(folder, 'alias.jul');
	let documents: ParsedDocuments;
	let referenceIndex: ReferenceIndex;
	let host: ProjectHost;

	beforeEach(() => {
		documents = {};
		referenceIndex = new ReferenceIndex();
		host = createInMemoryHost({
			[originPath]: 'foo = 1\n',
			// nicht-aliasierter Re-Export: foo bleibt über diese Datei importierbar
			[reexportPath]: '(foo) = import(§./origin.jul§)\n',
			// nicht-aliasierter Import + lokale Nutzung
			[directPath]: '(foo) = import(§./origin.jul§)\nusage = foo\n',
			// aliasierter Import (über die Re-Export-Kette) + lokale Nutzung des Alias
			[aliasPath]: '(bar = foo) = import(§./reexport.jul§)\nusage = bar\n',
		}, referenceIndex);
		[originPath, reexportPath, directPath, aliasPath].forEach(filePath => {
			load(filePath, documents, host);
		});
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
		const reparsed = load(directPath, documents, host, '(foo) = import(§./origin.jul§)\n');

		const afterEdit = referenceIndex.getReferences(fooSymbol, originPath);
		expect(afterEdit).to.have.lengthOf(3);
		expect(afterEdit.filter(location => location.filePath === directPath)).to.have.lengthOf(1);

		// erneutes Checken ohne weitere Änderung darf nichts verdoppeln
		checkTypes(reparsed, documents, referenceIndex);
		expect(referenceIndex.getReferences(fooSymbol, originPath)).to.have.lengthOf(3);
	});
});

describe('ReferenceIndex: Felder eines Dictionary-Typs', () => {
	const filePath = join(folder, 'fields.jul');
	let documents: ParsedDocuments;
	let referenceIndex: ReferenceIndex;

	beforeEach(() => {
		documents = {};
		referenceIndex = new ReferenceIndex();
		const code = [
			'MyType = [',
			'	name: Text',
			'	age: Integer',
			']',
			'getName = (value: MyType) =>',
			'	value/name',
			'greet = (value: MyType) =>',
			'	value/name',
			'',
		].join('\n');
		load(filePath, documents, createInMemoryHost({ [filePath]: code }, referenceIndex));
	});

	function getFieldSymbol(typeName: string, fieldName: string): SymbolDefinition {
		const typeSymbol = documents[filePath]!.checked!.symbols[typeName]!;
		const type = typeSymbol.typeInfo!.type as any;
		const declaration = (type.julType === 'typeOf' ? type.value : type).declaration;
		return declaration.expression.symbols[fieldName];
	}

	it('sammelt Feldzugriffe als Referenzen auf das Feld des Dictionary-Typs', () => {
		const references = referenceIndex.getReferences(getFieldSymbol('MyType', 'name'), filePath);

		expect(references.map(location => location.startRowIndex).sort()).to.deep.equal([5, 7]);
	});

	it('hält gleichnamige Felder verschiedener Felder derselben Deklaration auseinander', () => {
		expect(referenceIndex.getReferences(getFieldSymbol('MyType', 'age'), filePath)).to.have.lengthOf(0);
	});
});
