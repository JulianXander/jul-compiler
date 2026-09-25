import { expect } from 'chai';
import { join, resolve } from 'path';

import { checkTypes, ParsedDocuments } from './checker.js';
import { errorInfos } from '../compiler-errors.js';
import { createInMemoryHost, loadFile, ProjectHost } from '../project-loader.js';
import { ParsedFile, SymbolDefinition } from '../syntax-tree.js';
import { ReferenceIndex } from './reference-index.js';

// Die Dateien gibt es nur im Speicher - so lässt sich der Import-Graph für diesen Test gezielt
// konstruieren (mehrere Importeure, Alias).
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
	const importOnlyPath = join(folder, 'import-only.jul');
	const directPath = join(folder, 'direct.jul');
	const aliasPath = join(folder, 'alias.jul');
	let documents: ParsedDocuments;
	let referenceIndex: ReferenceIndex;
	let host: ProjectHost;

	beforeEach(() => {
		documents = {};
		referenceIndex = new ReferenceIndex();
		// Mit Klon wie im Language Server: der Recheck-Test checkt eine Datei ohne neues Parsen
		// erneut.
		host = createInMemoryHost({
			[originPath]: 'foo = 1\n',
			// nicht-aliasierter Import ohne Nutzung
			[importOnlyPath]: '(foo) = import(§./origin.jul§)\n',
			// nicht-aliasierter Import + lokale Nutzung
			[directPath]: '(foo) = import(§./origin.jul§)\nusage = foo\n',
			// aliasierter Import + lokale Nutzung des Alias
			[aliasPath]: '(bar = foo) = import(§./origin.jul§)\nusage = bar\n',
		}, { cloneUnchecked: true, referenceIndex: referenceIndex });
		[originPath, importOnlyPath, directPath, aliasPath].forEach(filePath => {
			load(filePath, documents, host);
		});
	});

	it('sammelt alle Referenzen auf eine Deklaration über mehrere Importeure und Alias-Importe hinweg', () => {
		const fooSymbol = documents[originPath]!.checked!.symbols['foo']!;
		const references = referenceIndex.getReferences(fooSymbol, originPath);

		// import-only.jul (Import-Binding), direct.jul (Import-Binding), direct.jul (Nutzung),
		// alias.jul (source-Token) - nicht aber alias.jul's lokaler Alias-Name oder dessen Nutzung.
		expect(references).to.have.lengthOf(4);
		expect(references.some(location => location.filePath === importOnlyPath)).to.equal(true);
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
		checkTypes(reparsed, documents, { cloneUnchecked: true, referenceIndex: referenceIndex });
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
		load(filePath, documents, createInMemoryHost({ [filePath]: code }, { cloneUnchecked: false, referenceIndex: referenceIndex }));
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

function getErrorsWithSeverityError(documents: ParsedDocuments, filePath: string) {
	return documents[filePath]!.checked!.errors.filter(error => errorInfos[error.code].severity === 'error');
}

function getFieldSymbolOfType(documents: ParsedDocuments, filePath: string, typeName: string, fieldName: string): SymbolDefinition {
	const typeSymbol = documents[filePath]!.checked!.symbols[typeName]!;
	const type = typeSymbol.typeInfo!.type as any;
	const declaration = (type.julType === 'typeOf' ? type.value : type).declaration;
	return declaration.expression.symbols[fieldName];
}

describe('ReferenceIndex: Feldnamen an Stellen mit erwartetem Typ', () => {
	const filePath = join(folder, 'expected-fields.jul');
	let documents: ParsedDocuments;
	let referenceIndex: ReferenceIndex;

	beforeEach(() => {
		documents = {};
		referenceIndex = new ReferenceIndex();
		const code = [
			'MyType = [',
			'	name: Text',
			']',
			'Outer = [inner: MyType]',
			'Other = [name: Text]',
			'f = (value: MyType) => value/name',
			'g = (count: Integer value: MyType) => count',
			'a: MyType = [name = §a§]',
			'b = f([name = §b§])',
			'c = g(value = [name = §c§] count = 1)',
			'd: List(MyType) = [[name = §d§]]',
			'o: Outer = [inner = [name = §o§]]',
			'r = () :> MyType => [name = §r§]',
			'e = a/name',
			'(aliased = name) = a',
			'(name) = a',
			'other: Other = [name = §p§]',
			'untyped = [name = §q§]',
			'h = (v: Any) => v',
			'i = h([name = §s§])',
			'nameUsage = name',
			'aliasedUsage = aliased',
			'',
		].join('\n');
		load(filePath, documents, createInMemoryHost({ [filePath]: code }, { cloneUnchecked: false, referenceIndex: referenceIndex }));
	});

	function getReferenceRows(): number[] {
		return referenceIndex.getReferences(getFieldSymbolOfType(documents, filePath, 'MyType', 'name'), filePath)
			.map(location => location.startRowIndex);
	}

	it('der Testcode prüft ohne Fehler', () => {
		expect(getErrorsWithSeverityError(documents, filePath)).to.deep.equal([]);
	});

	it('Definition mit Typguard: der Feldname ist eine Referenz auf das Feld des erwarteten Typs', () => {
		expect(getReferenceRows()).to.include(7);
	});
	it('positionales Argument: der Feldname ist eine Referenz auf das Feld des erwarteten Typs', () => {
		expect(getReferenceRows()).to.include(8);
	});
	it('benanntes Argument: der Feldname ist eine Referenz auf das Feld des erwarteten Typs', () => {
		expect(getReferenceRows()).to.include(9);
	});
	it('Listenelement: der Feldname ist eine Referenz auf das Feld des erwarteten Typs', () => {
		expect(getReferenceRows()).to.include(10);
	});
	it('verschachteltes Literal: der Feldname ist eine Referenz auf das Feld des erwarteten Typs', () => {
		expect(getReferenceRows()).to.include(11);
	});
	it('Rückgabewert: der Feldname ist eine Referenz auf das Feld des erwarteten Typs', () => {
		expect(getReferenceRows()).to.include(12);
	});
	it('Zugriff über eine typisierte Variable: der Feldname ist eine Referenz auf das Feld des erwarteten Typs', () => {
		expect(getReferenceRows()).to.include(13);
	});
	it('Destructuring ohne Alias: der Feldname ist eine Referenz auf das Feld des erwarteten Typs', () => {
		expect(getReferenceRows()).to.include(15);
	});

	it('Destructuring mit Alias: der Feldname ist die Referenz, nicht der lokale Name', () => {
		const references = referenceIndex.getReferences(getFieldSymbolOfType(documents, filePath, 'MyType', 'name'), filePath)
			.filter(location => location.startRowIndex === 14);
		expect(references.map(location => location.startColumnIndex)).to.deep.equal([11]);
	});

	it('Destructuring ohne Alias: der lokale Name ist das Feld, seine Verwendungen gehören dazu', () => {
		expect(getReferenceRows()).to.include(20);
	});

	it('Gegenprobe: ein gleichnamiges Feld eines anderen Typs ist keine Referenz', () => {
		expect(getReferenceRows()).to.not.include(16);
	});
	it('Gegenprobe: ein Literal ohne erwarteten Typ ist keine Referenz', () => {
		expect(getReferenceRows()).to.not.include(17);
	});
	it('Gegenprobe: ein Literal, das Any erwartet ist keine Referenz', () => {
		expect(getReferenceRows()).to.not.include(19);
	});
	it('Gegenprobe: die Verwendung eines Alias aus einem Destructuring ist keine Referenz', () => {
		expect(getReferenceRows()).to.not.include(21);
	});
});

describe('ReferenceIndex: Feldnamen mit erwartetem Typ aus einer anderen Datei', () => {
	const typePath = join(folder, 'type.jul');
	const usagePath = join(folder, 'usage.jul');

	it('der Feldname ist eine Referenz auf das Feld in der importierten Datei', () => {
		const documents: ParsedDocuments = {};
		const referenceIndex = new ReferenceIndex();
		const host = createInMemoryHost({
			[typePath]: 'MyType = [\n\tname: Text\n]\n',
			[usagePath]: '(MyType) = import(§./type.jul§)\nb: MyType = [name = §b§]\n',
		}, { cloneUnchecked: false, referenceIndex: referenceIndex });
		load(typePath, documents, host);
		load(usagePath, documents, host);
		const references = referenceIndex.getReferences(getFieldSymbolOfType(documents, typePath, 'MyType', 'name'), typePath)
			.filter(location => location.filePath === usagePath);
		expect(references.map(location => location.startRowIndex)).to.deep.equal([1]);
	});

	it('entfernt beim Recheck die Verknüpfungen der Datei, ohne sie zu verdoppeln', () => {
		const documents: ParsedDocuments = {};
		const referenceIndex = new ReferenceIndex();
		const host = createInMemoryHost({
			[typePath]: 'MyType = [\n\tname: Text\n]\n',
			[usagePath]: '(MyType) = import(§./type.jul§)\nb: MyType = [name = §b§]\nc = b/name\n',
		}, { cloneUnchecked: true, referenceIndex: referenceIndex });
		load(typePath, documents, host);
		const usage = load(usagePath, documents, host);
		const getUsageRows = () => referenceIndex.getReferences(getFieldSymbolOfType(documents, typePath, 'MyType', 'name'), typePath)
			.filter(location => location.filePath === usagePath)
			.map(location => location.startRowIndex)
			.sort();
		expect(getUsageRows()).to.deep.equal([1, 2]);

		checkTypes(usage, documents, { cloneUnchecked: true, referenceIndex: referenceIndex });
		expect(getUsageRows()).to.deep.equal([1, 2]);

		load(usagePath, documents, host, '(MyType) = import(§./type.jul§)\n');
		expect(getUsageRows()).to.deep.equal([]);
	});
});

describe('ReferenceIndex: Feldnamen mit einer Union als erwartetem Typ', () => {
	const filePath = join(folder, 'union-fields.jul');
	let documents: ParsedDocuments;
	let referenceIndex: ReferenceIndex;

	beforeEach(() => {
		documents = {};
		referenceIndex = new ReferenceIndex();
		const code = [
			'Person = [name: Text age: Integer]',
			'Pet = [name: Text species: Text]',
			'A = [kind: §a§ name: Text]',
			'B = [kind: §b§ name: Text]',
			'x: Or(Person Pet) = [name = §Ada§ age = 36]',
			'y: Or(Person Pet) = [name = §Rex§ age = 3 species = §Hund§]',
			'z: Or(A B) = [kind = §a§ name = §z§]',
			'',
		].join('\n');
		load(filePath, documents, createInMemoryHost({ [filePath]: code }, { cloneUnchecked: false, referenceIndex: referenceIndex }));
	});

	function getReferenceRows(typeName: string): number[] {
		return referenceIndex.getReferences(getFieldSymbolOfType(documents, filePath, typeName, 'name'), filePath)
			.map(location => location.startRowIndex);
	}

	it('der Testcode prüft ohne Fehler', () => {
		expect(getErrorsWithSeverityError(documents, filePath)).to.deep.equal([]);
	});

	it('ein Literal, das nur zu einem Zweig passt, gehört zu diesem Zweig', () => {
		expect(getReferenceRows('Person')).to.include(4);
	});

	it('Gegenprobe: ein Literal gehört nicht zu einem Zweig, dessen Pflichtfeld ihm fehlt', () => {
		expect(getReferenceRows('Pet')).to.not.include(4);
	});

	it('ein Literal, das zu beiden Zweigen passt, gehört zu beiden', () => {
		expect(getReferenceRows('Person')).to.include(5);
		expect(getReferenceRows('Pet')).to.include(5);
	});

	it('ein Literal gehört zu dem Zweig, dem seine übrigen Felder nicht widersprechen', () => {
		expect(getReferenceRows('A')).to.include(6);
	});

	it('Gegenprobe: ein Literal gehört nicht zu einem Zweig, dem ein Feld widerspricht', () => {
		expect(getReferenceRows('B')).to.not.include(6);
	});
});
