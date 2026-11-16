/**
 * Prüft, dass der Compiler im Browser läuft (src/browser.ts, Playground der Homepage). Läuft nach
 * dem Build auf out/browser.js.
 *
 * 1. webpack bündelt out/browser.js für target 'web'. Webpack 5 hat keine Polyfills für
 *    Node-Module, ein Import von path, fs, url & Co. bricht ab (Pfade über path-util.ts).
 * 2. Das Bündel läuft in einem leeren VM-Kontext ohne process, Buffer und require, prüft und
 *    übersetzt ein kleines Projekt aus zwei Dateien. Das findet Zugriffe auf Node-Globals, die beim
 *    Bündeln nicht auffallen.
 *
 * TypeScript bleibt extern: Der Einstieg lädt es nur für .ts/.js nach, die Probe braucht es nicht.
 */
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createContext, runInContext } from 'vm';
import webpack from 'webpack';

const compilerDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = mkdtempSync(join(tmpdir(), 'jul-browser-check-'));

try {
	const stats = await new Promise((resolve, reject) => {
		webpack({
			mode: 'production',
			target: ['web', 'es2020'],
			entry: join(compilerDirectory, 'out', 'browser.js'),
			output: {
				path: outputDirectory,
				filename: 'browser.js',
				library: { type: 'var', name: 'julCompiler' },
			},
			externalsType: 'import',
			externals: { typescript: 'typescript' },
			performance: { hints: false },
		}, (error, stats) => error ? reject(error) : resolve(stats));
	});
	if (stats.hasErrors()) {
		console.error('Browser-Bündel fehlgeschlagen (Node-Modul im Compiler?):');
		stats.toJson({ all: false, errors: true }).errors.forEach(error => {
			console.error(`  ${error.moduleName ?? ''}  ${error.message.split('\n')[0]}`);
		});
		process.exitCode = 1;
	}
	else {
		await runProbe(readFileSync(join(outputDirectory, 'browser.js'), 'utf8'));
	}
}
finally {
	rmSync(outputDirectory, { recursive: true, force: true });
}

async function runProbe(code) {
	const context = createContext({
		console: console,
		performance: performance,
		URL: URL,
		TextEncoder: TextEncoder,
		TextDecoder: TextDecoder,
		setTimeout: setTimeout,
		clearTimeout: clearTimeout,
		queueMicrotask: queueMicrotask,
		structuredClone: structuredClone,
	});
	runInContext(code, context);
	const compiler = context.julCompiler;
	compiler.initCompiler(readFileSync(join(compilerDirectory, 'out', 'runtime', 'core-lib.jul'), 'utf8'));
	const files = {
		'main.jul': '(double) = import(§./lib/math.jul§)\nlog(double(21))\n',
		'lib/math.jul': 'double = (x: Integer) => x.multiply(2)\n',
	};
	const output = await compiler.compile(files, {
		runtimeImportPath: './runtime.js',
		testRuntimeImportPath: './test-runtime.js',
	});
	if (output.type !== 'success') {
		console.error('Probe im Browser-Bündel fehlgeschlagen:');
		console.error(JSON.stringify(output.errors, undefined, 2));
		process.exitCode = 1;
		return;
	}
	const sizeKb = (Buffer.byteLength(code) / 1024).toFixed(0);
	const outFiles = Object.values(output.files).map(file => file.outFilePath).sort().join(', ');
	console.log(`Browser-Bündel ok, ${sizeKb} kB minifiziert ohne TypeScript, Probe übersetzt: ${outFiles}`);
}
