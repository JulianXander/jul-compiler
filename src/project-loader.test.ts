import { expect } from 'chai';
import { join, resolve } from 'path';
import { ParsedDocuments } from './checker/checker.js';
import { ErrorCode } from './compiler-errors.js';
import { createInMemoryHost, loadFile, ProjectHost } from './project-loader.js';
import { ParsedFile } from './syntax-tree.js';

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
	const expectedResults: {
		name: string;
		files: { [fileName: string]: string; };
		errors: { code: ErrorCode; startRowIndex: number; startColumnIndex: number; }[];
	}[] = [
			{
				// Die CLI checkte früher nur .jul-Dateien - der Import aus der ungecheckten
				// TS-Datei lieferte Any, und der falsche Typ fiel nicht auf.
				name: 'importierte TS-Datei wird gecheckt, ihr Typ kommt beim Importeur an',
				files: {
					'main.jul': '(count) = import(§./util.ts§)\nwrong: Text = count()',
					'util.ts': 'export function count(): bigint { return 1n; }',
				},
				errors: [{ code: ErrorCode.definitionTypeMismatch, startRowIndex: 1, startColumnIndex: 0 }],
			},
			{
				// Genau einmal: früher meldeten Parser und Checker den Fehler je für sich.
				name: 'fehlende Abhängigkeit wird einmal am Pfad-Literal gemeldet',
				files: {
					'main.jul': '(a) = import(§./gibtsnicht.jul§)',
				},
				errors: [{ code: ErrorCode.fileNotFound, startRowIndex: 0, startColumnIndex: 13 }],
			},
		];
	expectedResults.forEach(({ name, files, errors }) => {
		it(name, () => {
			const { main } = loadMain(files);
			expect(main.checked?.errors.map(error => ({
				code: error.code,
				startRowIndex: error.startRowIndex,
				startColumnIndex: error.startColumnIndex,
			}))).to.deep.equal(errors);
		});
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
});
