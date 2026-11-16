/**
 * Die Pfadfunktionen, die Parser, Checker und Emitter brauchen, ohne `import 'path'`, damit der
 * Compiler in jedem Bundler ohne Polyfill läuft (browser.ts).
 *
 * Unter Node ist es das eingebaute path, geholt über process.getBuiltinModule statt über einen
 * Import: Unter Windows liefert join dort \ als Trenner, darauf verlassen sich Importauflösung und
 * Language Server. Im Browser gibt es nur POSIX-Pfade, dafür genügt posixPath.
 */

//#region POSIX

function normalize(path: string): string {
	const isAbsolutePath = path.startsWith('/');
	const segments: string[] = [];
	path.split('/').forEach(segment => {
		if (segment === '' || segment === '.') {
			return;
		}
		if (segment === '..') {
			if (segments.length && segments[segments.length - 1] !== '..') {
				segments.pop();
				return;
			}
			if (isAbsolutePath) {
				// Über die Wurzel hinaus gibt es nichts.
				return;
			}
		}
		segments.push(segment);
	});
	const joined = segments.join('/');
	// Wie Node: Ein Schrägstrich am Ende bleibt stehen.
	const trailingSlash = path.endsWith('/') ? '/' : '';
	if (isAbsolutePath) {
		return joined
			? '/' + joined + trailingSlash
			: '/';
	}
	return (joined || '.') + trailingSlash;
}

function removeTrailingSlashes(path: string): string {
	let end = path.length;
	while (end > 1 && path[end - 1] === '/') {
		end--;
	}
	return path.slice(0, end);
}

/**
 * Wie path.posix, beschränkt auf das, was der Compiler braucht. relative kennt kein
 * Arbeitsverzeichnis: Beide Pfade müssen absolut oder beide relativ zur selben Wurzel sein.
 */
export const posixPath = {
	basename: (path: string): string => {
		const trimmed = removeTrailingSlashes(path);
		return trimmed.slice(trimmed.lastIndexOf('/') + 1);
	},
	dirname: (path: string): string => {
		const trimmed = removeTrailingSlashes(path);
		const slashIndex = trimmed.lastIndexOf('/');
		if (slashIndex < 0) {
			return '.';
		}
		if (slashIndex === 0) {
			return '/';
		}
		return removeTrailingSlashes(trimmed.slice(0, slashIndex));
	},
	extname: (path: string): string => {
		const name = posixPath.basename(path);
		const dotIndex = name.lastIndexOf('.');
		// Ein Punkt am Anfang gehört zum Namen (.gitignore).
		return dotIndex <= 0
			? ''
			: name.slice(dotIndex);
	},
	isAbsolute: (path: string): boolean => {
		return path.startsWith('/');
	},
	join: (...paths: string[]): string => {
		const joined = paths.filter(path => path !== '').join('/');
		return joined === ''
			? '.'
			: normalize(joined);
	},
	relative: (from: string, to: string): string => {
		if (posixPath.isAbsolute(from) !== posixPath.isAbsolute(to)) {
			throw new Error(`relative needs two absolute or two relative paths, got ${from} and ${to}`);
		}
		const fromSegments = getSegments(from);
		const toSegments = getSegments(to);
		let commonLength = 0;
		while (commonLength < fromSegments.length
			&& commonLength < toSegments.length
			&& fromSegments[commonLength] === toSegments[commonLength]) {
			commonLength++;
		}
		return [
			...fromSegments.slice(commonLength).map(() => '..'),
			...toSegments.slice(commonLength),
		].join('/');
	},
};

function getSegments(path: string): string[] {
	const normalized = normalize(path);
	return normalized.split('/').filter(segment => segment !== '' && segment !== '.');
}

//#endregion POSIX

type PathFunctions = typeof posixPath;

function getPathFunctions(): PathFunctions {
	const isNode = typeof process !== 'undefined'
		&& process.versions?.node !== undefined;
	if (!isNode) {
		return posixPath;
	}
	if (typeof process.getBuiltinModule !== 'function') {
		// Ohne den Fallback auf POSIX: Der wäre unter Windows still falsch.
		throw new Error(`Node ${process.versions.node} lacks process.getBuiltinModule, the compiler needs Node 20.16 or 22.3 or newer.`);
	}
	return process.getBuiltinModule('path');
}

const pathFunctions = getPathFunctions();

export const basename = pathFunctions.basename;
export const dirname = pathFunctions.dirname;
export const extname = pathFunctions.extname;
export const isAbsolute = pathFunctions.isAbsolute;
export const join = pathFunctions.join;
export const relative = pathFunctions.relative;
