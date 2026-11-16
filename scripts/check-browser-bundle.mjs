/**
 * Prüft, dass der Compiler und der erzeugte Code im Browser laufen (src/browser.ts, Playground der
 * Homepage). Läuft nach dem Build auf out/browser.js und out/runtime.
 *
 * 1. webpack bündelt out/browser.js für target 'web'. Webpack 5 hat keine Polyfills für
 *    Node-Module, ein Import von path, fs, url & Co. bricht ab (Pfade über path-util.ts).
 * 2. Das Bündel läuft in einem leeren VM-Kontext ohne process, Buffer und require, prüft und
 *    übersetzt ein kleines Projekt aus drei Dateien. Das findet Zugriffe auf Node-Globals, die beim
 *    Bündeln nicht auffallen.
 * 3. Das erzeugte JS wird mit runtime.js und test-runtime.js ebenso gebündelt und in einem leeren
 *    Kontext ausgeführt, samt der Tests über _runTests.
 *
 * TypeScript bleibt extern: Der Einstieg lädt es nur für .ts/.js nach, die Probe braucht es nicht.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createContext, runInContext } from 'vm';
import webpack from 'webpack';

const compilerDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDirectory = join(compilerDirectory, 'out', 'runtime');
const workDirectory = mkdtempSync(join(tmpdir(), 'jul-browser-check-'));

const probeFiles = {
	'main.jul': '(double) = import(§./lib/math.jul§)\nlog(double(21))\n',
	'lib/math.jul': 'double = (x: Integer) => x.multiply(2)\n',
	'lib/math.test.jul': '(double) = import(§./math.jul§)\n\ntest(§verdoppelt§ () => equal(double(2) 4))\n',
};

try {
	const compilerBundle = await bundle(join(compilerDirectory, 'out', 'browser.js'), 'compiler');
	if (compilerBundle === undefined) {
		console.error('Browser-Bündel des Compilers fehlgeschlagen (Node-Modul im Compiler?)');
	}
	else {
		await runProbe(compilerBundle);
	}
}
finally {
	rmSync(workDirectory, { recursive: true, force: true });
}

/**
 * @returns der gebündelte Code, undefined bei Fehlern (schon ausgegeben)
 */
async function bundle(entry, name, alias = {}) {
	const outputDirectory = join(workDirectory, 'bundle-' + name);
	const stats = await new Promise((resolve, reject) => {
		webpack({
			mode: 'production',
			target: ['web', 'es2020'],
			entry: entry,
			output: {
				path: outputDirectory,
				filename: 'bundle.js',
				library: { type: 'var', name: 'bundled' },
			},
			resolve: { alias: alias },
			externalsType: 'import',
			externals: { typescript: 'typescript' },
			performance: { hints: false },
		}, (error, stats) => error ? reject(error) : resolve(stats));
	});
	if (stats.hasErrors()) {
		stats.toJson({ all: false, errors: true }).errors.forEach(error => {
			console.error(`  ${error.moduleName ?? ''}  ${error.message.split('\n')[0]}`);
		});
		process.exitCode = 1;
		return undefined;
	}
	return readFileSync(join(outputDirectory, 'bundle.js'), 'utf8');
}

/**
 * Ein Kontext nur mit dem, was auch ein Browser hat; console.log landet in logged.
 */
function createBrowserLikeContext(logged) {
	return createContext({
		console: {
			...console,
			log: (...args) => logged.push(args.map(String).join(' ')),
		},
		performance: performance,
		URL: URL,
		TextEncoder: TextEncoder,
		TextDecoder: TextDecoder,
		setTimeout: setTimeout,
		clearTimeout: clearTimeout,
		queueMicrotask: queueMicrotask,
		structuredClone: structuredClone,
	});
}

async function runProbe(compilerCode) {
	const compilerContext = createBrowserLikeContext([]);
	runInContext(compilerCode, compilerContext);
	const compiler = compilerContext.bundled;
	compiler.initCompiler(readFileSync(join(runtimeDirectory, 'core-lib.jul'), 'utf8'));
	const output = await compiler.compile(probeFiles, {
		// Nackte Bezeichner, die für jede Datei gleich auflösen, egal in welchem Ordner sie liegt.
		runtimeImportPath: 'jul-runtime',
		testRuntimeImportPath: 'jul-test-runtime',
	});
	if (output.type !== 'success') {
		fail('Probe im Browser-Bündel fehlgeschlagen:', JSON.stringify(output.errors, undefined, 2));
		return;
	}

	// Das erzeugte JS als Dateien, dazu die Runtime und ein Einstieg, der die Tests ausführt.
	const programDirectory = join(workDirectory, 'program');
	const writeProgramFile = (filePath, content) => {
		const fullPath = join(programDirectory, filePath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content);
	};
	Object.values(output.files).forEach(file => {
		writeProgramFile(file.outFilePath, file.js);
	});
	copyFileSync(join(runtimeDirectory, 'runtime.js'), join(programDirectory, 'runtime.js'));
	copyFileSync(join(runtimeDirectory, 'test-runtime.js'), join(programDirectory, 'test-runtime.js'));
	writeProgramFile('entry.js', [
		`import './main.js';`,
		`import './lib/math.test.js';`,
		`import { _runTests } from 'jul-test-runtime';`,
		`export const testResults = [];`,
		`_runTests(result => testResults.push(result));`,
	].join('\n'));
	const programCode = await bundle(join(programDirectory, 'entry.js'), 'program', {
		'jul-runtime$': join(programDirectory, 'runtime.js'),
		'jul-test-runtime$': join(programDirectory, 'test-runtime.js'),
	});
	if (programCode === undefined) {
		fail('Browser-Bündel des erzeugten Codes fehlgeschlagen (Node-Modul in der Runtime?)');
		return;
	}
	const logged = [];
	const programContext = createBrowserLikeContext(logged);
	runInContext(programCode, programContext);
	const testResults = programContext.bundled.testResults;
	if (logged.join('\n') !== '42') {
		fail('Probe gibt nicht 42 aus, sondern:', logged.join('\n'));
		return;
	}
	if (testResults.length !== 1 || testResults[0].failure !== undefined) {
		fail('Test der Probe nicht bestanden:', JSON.stringify(testResults, undefined, 2));
		return;
	}

	const sizeKb = (Buffer.byteLength(compilerCode) / 1024).toFixed(0);
	console.log(`Browser-Bündel ok, Compiler ${sizeKb} kB minifiziert ohne TypeScript, Probe übersetzt und ausgeführt (Ausgabe 42, 1 Test bestanden)`);
}

function fail(...messages) {
	messages.forEach(message => console.error(message));
	process.exitCode = 1;
}
