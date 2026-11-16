import { expect } from 'chai';
import { posix } from 'path';
import { posixPath } from './path-util.js';
import { reportAtCaller } from './test-util.js';

// posixPath ist der Ersatz für path im Browser, Node liefert die Referenz.

const expectLikeNode = reportAtCaller(<Name extends keyof typeof posixPath>(
	name: Name,
	...args: Parameters<typeof posixPath[Name]>
) => {
	const expected = (posix[name] as (...args: unknown[]) => unknown)(...args);
	const actual = (posixPath[name] as (...args: unknown[]) => unknown)(...args);
	expect(actual).to.equal(expected);
});

describe('posixPath', () => {
	describe('join', () => {
		it('a b', () => {
			expectLikeNode('join', 'a', 'b.jul');
		});
		it('Ordner . aus dirname', () => {
			expectLikeNode('join', '.', './b.jul');
		});
		it('leerer Ordner', () => {
			expectLikeNode('join', '', 'b.jul');
		});
		it('ohne Argumente', () => {
			expectLikeNode('join');
		});
		it('nur leere Teile', () => {
			expectLikeNode('join', '', '');
		});
		it('.. kürzt', () => {
			expectLikeNode('join', 'lib/x', '../b.jul');
		});
		it('.. über den Anfang eines relativen Pfads', () => {
			expectLikeNode('join', 'a', '../../b.jul');
		});
		it('.. über die Wurzel', () => {
			expectLikeNode('join', '/a', '../../b.jul');
		});
		it('absolut', () => {
			expectLikeNode('join', '/src', 'lib/b.jul');
		});
		it('doppelte Schrägstriche', () => {
			expectLikeNode('join', 'a//', '/b');
		});
		it('Schrägstrich am Ende bleibt', () => {
			expectLikeNode('join', 'a', 'b/');
		});
	});
	describe('dirname', () => {
		it('Datei im Ordner', () => {
			expectLikeNode('dirname', 'lib/b.jul');
		});
		it('Datei ohne Ordner', () => {
			expectLikeNode('dirname', 'b.jul');
		});
		it('Datei in der Wurzel', () => {
			expectLikeNode('dirname', '/b.jul');
		});
		it('Schrägstrich am Ende', () => {
			expectLikeNode('dirname', '/a/b/');
		});
		it('Wurzel', () => {
			expectLikeNode('dirname', '/');
		});
		it('leer', () => {
			expectLikeNode('dirname', '');
		});
	});
	describe('basename', () => {
		it('Datei im Ordner', () => {
			expectLikeNode('basename', '/a/b.jul');
		});
		it('Schrägstrich am Ende', () => {
			expectLikeNode('basename', 'a/b/');
		});
		it('ohne Ordner', () => {
			expectLikeNode('basename', 'b.jul');
		});
	});
	describe('extname', () => {
		it('eine Endung', () => {
			expectLikeNode('extname', 'a/b.jul');
		});
		it('zwei Endungen', () => {
			expectLikeNode('extname', 'data.yaml.json');
		});
		it('Punkt am Anfang', () => {
			expectLikeNode('extname', '.gitignore');
		});
		it('ohne Endung', () => {
			expectLikeNode('extname', 'a.b/c');
		});
		it('Punkt am Ende', () => {
			expectLikeNode('extname', 'a.');
		});
	});
	describe('isAbsolute', () => {
		it('absolut', () => {
			expectLikeNode('isAbsolute', '/a');
		});
		it('relativ', () => {
			expectLikeNode('isAbsolute', 'a/b');
		});
	});
	describe('relative', () => {
		it('Geschwister', () => {
			expectLikeNode('relative', '/out/src', '/out/lib/a.jul');
		});
		it('darunter', () => {
			expectLikeNode('relative', '/a', '/a/b/c.jul');
		});
		it('gleich', () => {
			expectLikeNode('relative', '/a/b', '/a/b');
		});
		it('aus der Wurzel', () => {
			expectLikeNode('relative', '/', '/a.jul');
		});
		// Node löst relative Pfade gegen das Arbeitsverzeichnis auf, bei zwei relativen kürzt es sich heraus.
		it('zwei relative', () => {
			expectLikeNode('relative', 'lib', 'src/a.jul');
		});
		it('Ordner . aus dirname', () => {
			expectLikeNode('relative', '.', 'a.jul');
		});
		it('mit ..', () => {
			expectLikeNode('relative', 'a/x/..', 'a/b.jul');
		});
		it('absolut zu relativ ist ein Fehler', () => {
			expect(() => posixPath.relative('/a', 'b')).to.throw('relative needs two absolute or two relative paths');
		});
	});
});
