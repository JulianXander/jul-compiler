import { getTypeInfo } from '../checker/check-result.js';
import { typeToString } from '../checker/type-algebra.js';
import { expect } from 'chai';
import { join, resolve } from 'path';
import { ParsedDocuments } from '../checker/checker.js';
import { ErrorCode } from '../compiler-errors.js';
import { createInMemoryHost, loadFile, ProjectHost, recheckFile } from './project-loader.js';
import { ParsedFile } from '../syntax-tree.js';
import { reportAtCaller } from '../test-util.js';

// Ein ausgedachter Ordner - die Dateien gibt es nur im Speicher.
const root = resolve('/project-loader-test');
function path(fileName: string): string {
	return join(root, fileName);
}

/**
 * Zählt die Lesezugriffe je Datei mit.
 */
function createCountingHost(files: { [fileName: string]: string; }): { host: ProjectHost; readCounts: Map<string, number>; } {
	const inMemoryHost = createInMemoryHost(Object.fromEntries(
		Object.entries(files).map(([fileName, code]) => [path(fileName), code])));
	const readCounts = new Map<string, number>();
	return {
		host: {
			readSource: filePath => {
				readCounts.set(filePath, (readCounts.get(filePath) ?? 0) + 1);
				return inMemoryHost.readSource(filePath);
			},
		},
		readCounts: readCounts,
	};
}

function loadMain(files: { [fileName: string]: string; }, host?: ProjectHost): { main: ParsedFile; documents: ParsedDocuments; } {
	const documents: ParsedDocuments = {};
	const main = loadFile(path('main.jul'), documents, host ?? createCountingHost(files).host);
	if (typeof main === 'string') {
		throw new Error(`main.jul nicht geladen: ${main}`);
	}
	return { main, documents };
}

describe('project-loader', () => {
	const expectLoadErrors = reportAtCaller((
		files: { [fileName: string]: string; },
		errors: { code: ErrorCode; startRowIndex: number; startColumnIndex: number; }[],
	) => {
		const { main } = loadMain(files);
		expect(main.checked?.errors.map(error => ({
			code: error.code,
			startRowIndex: error.startRowIndex,
			startColumnIndex: error.startColumnIndex,
		}))).to.deep.equal(errors);
	});
	// Die CLI checkte früher nur .jul-Dateien - der Import aus der ungecheckten
	// TS-Datei lieferte Any, und der falsche Typ fiel nicht auf.
	it('importierte TS-Datei wird gecheckt, ihr Typ kommt beim Importeur an', () => {
		expectLoadErrors({
			'main.jul': '(count) = import(§./util.ts§)\nwrong: Text = count()',
			'util.ts': 'export function count(): bigint { return 1n; }',
		}, [{ code: ErrorCode.definitionTypeMismatch, startRowIndex: 1, startColumnIndex: 0 }]);
	});
	// Zur Laufzeit kommt der default-Export an, nicht das Modul mit count. Dessen Wert übersetzt
	// der TS-Parser nicht, der Typ ist also Any statt eines Dictionarys mit count.
	it('Value-Import einer TS-Datei mit default-Export liefert nicht die benannten Exporte', () => {
		const { main } = loadMain({
			'main.jul': 'u = import(§./util.ts§)',
			'util.ts': 'export function count(): bigint { return 1n; }\nexport default 5;',
		});
		expect(typeToString(getTypeInfo(main.checkResult!, main.checked!.expressions![0])!.type, 0, 3)).to.equal('Any');
	});
	// Genau einmal: früher meldeten Parser und Checker den Fehler je für sich.
	it('fehlende Abhängigkeit wird einmal am Pfad-Literal gemeldet', () => {
		expectLoadErrors({
			'main.jul': '(a) = import(§./gibtsnicht.jul§)\nb = a',
		}, [{ code: ErrorCode.fileNotFound, startRowIndex: 0, startColumnIndex: 13 }]);
	});
	// Exportiert werden nur Top-Level-Definitionen, der Emitter gibt Destructuring kein
	// export. Hielte der Checker das Feld für importierbar, käme zur Laufzeit undefined an.
	it('per Destructuring gebundener Name ist kein Export', () => {
		expectLoadErrors({
			'main.jul': '(a) = import(§./b.jul§)\nb = a',
			'b.jul': '(a) = [a = 1]\nc = 2',
		}, [{ code: ErrorCode.dereferenceFailed, startRowIndex: 0, startColumnIndex: 1 }]);
	});
	// Sonst würde jeder Import stillschweigend zum Re-Export.
	it('importierter Name wird nicht weiterexportiert', () => {
		expectLoadErrors({
			'main.jul': '(d) = import(§./b.jul§)\nb = d',
			'b.jul': '(d) = import(§./d.jul§)\nb = d',
			'd.jul': 'd = 1',
		}, [{ code: ErrorCode.dereferenceFailed, startRowIndex: 0, startColumnIndex: 1 }]);
	});
	// Signatur statt Rumpf (docs/design-principles.md): Der Typguard gilt auch beim Importeur.
	it('importierter Name hat den Typguard seiner Definition', () => {
		// Mit warnUnknown wie die CLI: ein Any statt des Typguards zeigt sich nur als typeNotProven.
		const host = createInMemoryHost({
			[path('main.jul')]: '(d) = import(§./b.jul§)\nf = (key: Text) :> Or([] Integer) => d.getField(key)',
			[path('b.jul')]: 'd: Dictionary(Integer) = [x = 1 y = 2]',
		}, { warnUnknown: () => true });
		const { main } = loadMain({}, host);
		expect(main.checked?.errors.map(error => error.code)).to.deep.equal([]);
	});
	it('ungenutzter Import wird gemeldet', () => {
		expectLoadErrors({
			'main.jul': '(a b) = import(§./b.jul§)\nc = a',
			'b.jul': 'a = 1\nb = 2',
		}, [{ code: ErrorCode.unusedDefinition, startRowIndex: 0, startColumnIndex: 3 }]);
	});

	it('übersprungene Abhängigkeit ist kein Fehler', () => {
		const files = { 'main.jul': '(count) = import(§./util.ts§)\nwrong: Text = count()' };
		const inMemoryHost = createInMemoryHost({ [path('main.jul')]: files['main.jul'] });
		const { main, documents } = loadMain(files, {
			readSource: filePath => filePath === path('util.ts')
				? { type: 'skipped' }
				: inMemoryHost.readSource(filePath),
		});
		expect(main.checked?.errors).to.deep.equal([]);
		expect(documents[path('util.ts')]).to.equal(undefined);
	});

	// Wie im Language Server, der solche Dateien gar nicht lädt: Sonst wäre ein `assume` in der
	// CLI überflüssig (JUL2503), in der IDE aber nötig.
	it('zu große Datei liefert beim Importeur Any, ein assume darauf ist nicht überflüssig', () => {
		const files = {
			'main.jul': 'data = import(§./data.json§)\nlist = assume(data List(Integer))',
			'data.json': '[1, 2, 3]',
		};
		const { main, documents } = loadMain(files, {
			...createCountingHost(files).host,
			maxTypedFileSize: 5,
		});
		expect(main.checked?.errors.map(error => error.code)).to.deep.equal([ErrorCode.uncheckedAssume]);
		expect(documents[path('data.json')]?.untyped).to.equal(true);
	});
	it('zu große Datendatei bekommt keinen Syntaxbaum und wird nicht inferiert', () => {
		const files = {
			'main.jul': 'data = import(§./data.json§)',
			'data.json': '[1, 2, 3]',
		};
		const { documents } = loadMain(files, {
			...createCountingHost(files).host,
			maxTypedFileSize: 5,
		});
		const data = documents[path('data.json')]!;
		expect(data.checked).to.not.equal(undefined);
		expect(getTypeInfo(data.checkResult!, data.checked?.expressions?.[0])).to.equal(undefined);
	});
	it('Datei unter der Grenze behält ihren Typ, ein assume darauf ist überflüssig', () => {
		const { main } = loadMain({
			'main.jul': 'data = import(§./data.json§)\nlist = assume(data List(Integer))',
			'data.json': '[1, 2, 3]',
		});
		expect(main.checked?.errors.map(error => error.code)).to.deep.equal([ErrorCode.redundantAssume]);
	});

	describe('Import mit Typ', () => {
		function loadUntyped(files: { [fileName: string]: string; }): ReturnType<typeof loadMain> {
			return loadMain(files, {
				...createCountingHost(files).host,
				maxTypedFileSize: 5,
			});
		}
		function getErrorCodes(main: ParsedFile): ErrorCode[] {
			return main.checked!.errors.map(error => error.code);
		}
		function getImportType(main: ParsedFile): string {
			return typeToString(getTypeInfo(main.checkResult!, main.checked!.expressions![0])!.type, 0, 3);
		}
		/**
		 * Unter und über maxTypedFileSize dasselbe Urteil: Eine Datei soll ihr Prüfergebnis nicht
		 * ändern, nur weil sie über die Grenze wächst.
		 */
		const expectSameVerdict = reportAtCaller((
			files: { [fileName: string]: string; },
			errorCodes: ErrorCode[],
		) => {
			expect(getErrorCodes(loadMain(files).main), 'unter der Grenze').to.deep.equal(errorCodes);
			expect(getErrorCodes(loadUntyped(files).main), 'über der Grenze').to.deep.equal(errorCodes);
		});

		it('hat den angegebenen Typ', () => {
			const files = {
				'main.jul': 'data = import(§./data.json§ List(Integer))',
				'data.json': '[1, 2, 3]',
			};
			expect(getImportType(loadMain(files).main)).to.equal('List(Integer)');
			expect(getImportType(loadUntyped(files).main)).to.equal('List(Integer)');
		});
		it('passender Wert ist kein Fehler', () => {
			expectSameVerdict({
				'main.jul': 'data = import(§./data.json§ List(Integer))',
				'data.json': '[1, 2, 3]',
			}, []);
		});
		it('unpassender Wert ist ein Fehler', () => {
			expectSameVerdict({
				'main.jul': 'data = import(§./data.json§ List(Text))',
				'data.json': '[1, 2, 3]',
			}, [ErrorCode.importTypeMismatch]);
		});
		it('null erfüllt ein Feld, das Empty zulässt', () => {
			expectSameVerdict({
				'main.jul': 'data = import(§./data.json§ Dictionary([a: Integer b: Or([] Text)]))',
				'data.json': '{"x": {"a": 1, "b": null}, "y": {"a": 2, "b": "z"}}',
			}, []);
		});
		it('fehlendes Pflichtfeld ist ein Fehler', () => {
			expectSameVerdict({
				'main.jul': 'data = import(§./data.json§ Dictionary([a: Integer b: Text]))',
				'data.json': '{"x": {"a": 1}}',
			}, [ErrorCode.importTypeMismatch]);
		});
		it('Meldung nennt nur die ersten falschen Einträge', () => {
			const { main } = loadUntyped({
				'main.jul': 'data = import(§./data.json§ Dictionary(Text))',
				'data.json': '{"a": 1, "b": 2, "c": 3, "d": 4, "e": 5}',
			});
			const lines = main.checked!.errors[0]!.message.split('\n');
			expect(lines.filter(line => line.startsWith('Invalid value'))).to.have.length(3);
			expect(lines.at(-1)).to.equal('… 2 more');
		});
		it('Typ als benanntes Argument', () => {
			expectSameVerdict({
				'main.jul': 'data = import(path = §./data.json§ ValueType = List(Text))',
				'data.json': '[1, 2, 3]',
			}, [ErrorCode.importTypeMismatch]);
		});
		// Die Grenze der Konstantenfaltung (maxFoldedTupleLength) gilt nicht: Wie ein Literal im
		// Quelltext ist der Wert durch die Dateigröße begrenzt.
		it('lange Liste in großer Datei wird geprüft', () => {
			const { main } = loadUntyped({
				'main.jul': 'data = import(§./data.json§ List(Integer))',
				'data.json': `[${Array(1001).fill('1').join(', ')}]`,
			});
			expect(getErrorCodes(main)).to.deep.equal([]);
		});
		// Wie im Language Server, der große Dateien nicht lädt: Der Typ gilt ungeprüft, der Build prüft.
		it('übersprungene Datei hat den angegebenen Typ ohne Fehler', () => {
			const inMemoryHost = createInMemoryHost({ [path('main.jul')]: 'data = import(§./data.json§ List(Text))' });
			const { main } = loadMain({}, {
				readSource: filePath => filePath === path('data.json')
					? { type: 'skipped' }
					: inMemoryHost.readSource(filePath),
			});
			expect(getErrorCodes(main)).to.deep.equal([]);
			expect(getImportType(main)).to.equal('List(Text)');
		});
		it('Wert ohne Typ (TS-default-Export) ist nicht beweisbar', () => {
			const { main } = loadMain({
				'main.jul': 'u = import(§./util.ts§ Integer)',
				'util.ts': 'export default 5;',
			});
			expect(getErrorCodes(main)).to.deep.equal([ErrorCode.importTypeMismatch]);
		});
	});

	it('jede Datei einer Raute wird genau einmal gelesen und gecheckt', () => {
		const { host, readCounts } = createCountingHost({
			'main.jul': '(b) = import(§./b.jul§)\n(c) = import(§./c.jul§)',
			'b.jul': '(d) = import(§./d.jul§)\nb = d',
			'c.jul': '(d) = import(§./d.jul§)\nc = d',
			'd.jul': 'd = 1',
		});
		const { documents } = loadMain({}, host);
		expect([...readCounts.values()]).to.deep.equal([1, 1, 1, 1]);
		Object.values(documents).forEach(document => {
			expect(document.checked, document.filePath).to.not.equal(undefined);
		});
	});

	it('Zyklus terminiert, beide Dateien werden gecheckt', () => {
		const { host, readCounts } = createCountingHost({
			'main.jul': '(b) = import(§./b.jul§)\na = 1',
			'b.jul': '(a) = import(§./main.jul§)\nb = 2',
		});
		const { documents } = loadMain({}, host);
		expect([...readCounts.values()]).to.deep.equal([1, 1]);
		expect(documents[path('main.jul')]?.checked).to.not.equal(undefined);
		expect(documents[path('b.jul')]?.checked).to.not.equal(undefined);
	});

	it('mit code wird eine schon geladene Datei neu geparst, ohne sie zu lesen', () => {
		const { host, readCounts } = createCountingHost({ 'main.jul': 'a = 1' });
		const { main: first, documents } = loadMain({}, host);
		const second = loadFile(path('main.jul'), documents, host, 'a = 2');
		expect(second).to.not.equal(first);
		expect(documents[path('main.jul')]).to.equal(second);
		expect(readCounts.get(path('main.jul'))).to.equal(1);
	});

	it('onParsed bekommt den ersetzten Stand', () => {
		const { host: countingHost } = createCountingHost({ 'main.jul': 'a = 1' });
		const calls: [ParsedFile, ParsedFile | undefined][] = [];
		const host: ProjectHost = {
			...countingHost,
			onParsed: (parsed, previous) => calls.push([parsed, previous]),
		};
		const { main: first, documents } = loadMain({}, host);
		loadFile(path('main.jul'), documents, host, 'a = 2');
		expect(calls.length).to.equal(2);
		expect(calls[0]![1]).to.equal(undefined);
		expect(calls[1]![1]).to.equal(first);
	});

	// Der Recheck parst nicht neu, löst die Abhängigkeiten aber neu auf: fileNotFound ist ein
	// Ladefehler und ändert sich, ohne dass die Datei sich ändert.
	it('recheck meldet eine gelöschte Abhängigkeit und vergisst sie, wenn sie wieder da ist', () => {
		const files: { [filePath: string]: string; } = {
			[path('main.jul')]: '(a) = import(§./b.jul§)\nc = a',
			[path('b.jul')]: 'a = 1',
		};
		const host = createInMemoryHost(files);
		const { main, documents } = loadMain({}, host);
		const errorCodes = () => main.checked!.errors.map(error => error.code);
		expect(errorCodes()).to.deep.equal([]);

		delete files[path('b.jul')];
		delete documents[path('b.jul')];
		recheckFile(main, documents, host);
		expect(errorCodes()).to.deep.equal([ErrorCode.fileNotFound]);

		files[path('b.jul')] = 'a = 1';
		recheckFile(main, documents, host);
		expect(errorCodes()).to.deep.equal([]);
		expect(documents[path('main.jul')]).to.equal(main);
		expect(main.syntax.errors).to.deep.equal([]);
	});

	// docs/backlog/key-of.md: Ein importierter Name steht für die Definition in seiner Datei, sonst
	// wäre KeyOf(data) in jeder importierenden Datei ein anderer Typ.
	describe('KeyOf über Dateigrenzen', () => {
		const pool = 'data: Dictionary(Integer) = [a = 1 b = 2]\nId = KeyOf(data)';
		function getErrorCodes(files: { [fileName: string]: string; }): ErrorCode[] {
			return loadMain(files).main.checked!.errors.map(error => error.code);
		}
		it('KeyOf aus der Quelldatei gilt für den importierten Wert', () => {
			expect(getErrorCodes({
				'main.jul': '(data Id) = import(§./pool.jul§)\nget = (id: Id) :> Integer => data.getField(id)',
				'pool.jul': pool,
			})).to.deep.equal([]);
		});
		it('KeyOf des importierten Werts ist derselbe Typ wie in der Quelldatei', () => {
			expect(getErrorCodes({
				'main.jul': '(data Id) = import(§./pool.jul§)\nf = (id: KeyOf(data)) :> Id => id',
				'pool.jul': pool,
			})).to.deep.equal([]);
		});
		// jul test lädt mehrere Wurzeln in dieselben documents, loadFile leert dazwischen die Typ-Caches.
		// pool.jul ist dann schon geprüft, sein Id trägt den Term aus dem ersten Lauf. Der Term einer
		// Top-Level-Bindung muss das Leeren überstehen, sonst passte KeyOf(data) nicht mehr zu sich selbst.
		it('KeyOf übersteht das Leeren der Caches zwischen zwei Wurzeln', () => {
			const host = createCountingHost({
				'first.jul': '(Id) = import(§./pool.jul§)\nx = 1',
				'second.jul': '(data Id) = import(§./pool.jul§)\nget = (id: Id) :> Integer => data.getField(id)',
				'pool.jul': pool,
			}).host;
			const documents: ParsedDocuments = {};
			loadFile(path('first.jul'), documents, host);
			const second = loadFile(path('second.jul'), documents, host);
			if (typeof second === 'string') {
				throw new Error(second);
			}
			expect(second.checked!.errors.map(error => error.code)).to.deep.equal([]);
		});
		// Gegenprobe: ein anderes Dictionary aus derselben Datei.
		it('KeyOf eines anderen importierten Dictionary passt nicht', () => {
			expect(getErrorCodes({
				'main.jul': '(other Id) = import(§./pool.jul§)\nget = (id: Id) :> Integer => other.getField(id)',
				'pool.jul': pool + '\nother: Dictionary(Integer) = [a = 1]',
			})).to.deep.equal([ErrorCode.returnTypeMismatch]);
		});
	});
});
