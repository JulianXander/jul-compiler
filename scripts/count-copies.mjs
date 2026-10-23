// Zählt zur Laufzeit, wie oft und wie viel jede Kopierstelle eines JUL-Programms kopiert, getrennt nach
// der Kategorie ihrer Quelle. Messinstrument für docs/backlog/inplace-mutationen.md.
//
// Vorgehen:
//   1. Das Programm mit JUL_COUNT_COPIES=1 bauen. Der Emitter wickelt dann jede Kopierstelle in
//      globalThis._julCountCopy(stelle, wert), die Stelle trägt Datei, Zeile, Art und Kategorie.
//   2. node scripts/count-copies.mjs <bundle.js> [argumente des programms]
//
// Beispiel yugioh (PowerShell, im yugioh-Repo):
//   $env:JUL_COUNT_COPIES = '1'; node ..\JUL\jul-compiler\out\compiler\cli.js --config bench.jul-config.yaml
//   Remove-Item Env:JUL_COUNT_COPIES
//   node ..\JUL\jul-compiler\scripts\count-copies.mjs out-bench\bundle.js 1
//
// Gezählt werden Kopien und die Zahl der kopierten Felder bzw. Elemente, das zweite ist das bessere
// Maß für die Kosten. Die Zeiten des Programms sind mit dem Zähler nicht aussagekräftig.

import { resolve } from 'path';
import { pathToFileURL } from 'url';

const [bundlePath, ...programArgs] = process.argv.slice(2);
if (!bundlePath) {
	console.error('Aufruf: node scripts/count-copies.mjs <bundle.js> [argumente]');
	process.exit(1);
}

/** @type {Map<string, { copies: number; size: number; }>} */
const sites = new Map();

globalThis._julCountCopy = (site, value) => {
	let entry = sites.get(site);
	if (!entry) {
		entry = { copies: 0, size: 0 };
		sites.set(site, entry);
	}
	entry.copies++;
	if (Array.isArray(value)) {
		entry.size += value.length;
	}
	else if (value && typeof value === 'object') {
		entry.size += Object.keys(value).length;
	}
	return value;
};

process.on('exit', () => {
	report();
});

process.argv = [process.argv[0], resolve(bundlePath), ...programArgs];
await import(pathToFileURL(resolve(bundlePath)).href);

function report() {
	let totalCopies = 0;
	let totalSize = 0;
	/** @type {Map<string, { copies: number; size: number; sites: number; }>} */
	const byCategory = new Map();
	/** @type {Map<string, { copies: number; size: number; sites: number; }>} */
	const byKind = new Map();
	for (const [site, entry] of sites) {
		const { kind, category } = parseSite(site);
		totalCopies += entry.copies;
		totalSize += entry.size;
		add(byCategory, category, entry).sites++;
		add(byKind, kind, entry).sites++;
	}
	if (!totalCopies) {
		console.error('Keine Kopie gezählt. Mit JUL_COUNT_COPIES=1 gebaut?');
		return;
	}
	const percent = (part, total) => `${(100 * part / total).toFixed(1)} %`;
	const printTable = (title, map) => {
		console.error(`\n${title}`);
		[...map].sort((a, b) => b[1].size - a[1].size).forEach(([key, entry]) => {
			console.error(`  ${key.padEnd(14)} Kopien ${String(entry.copies).padStart(10)} (${percent(entry.copies, totalCopies).padStart(7)})`
				+ `   Felder ${String(entry.size).padStart(12)} (${percent(entry.size, totalSize).padStart(7)})`
				+ `   Stellen ${entry.sites}`);
		});
	};
	console.error(`\nKopien gesamt ${totalCopies}, kopierte Felder/Elemente gesamt ${totalSize}`);
	printTable('Je Kategorie der Quelle:', byCategory);
	printTable('Je Art:', byKind);
	console.error('\nTeuerste Stellen (nach kopierten Feldern):');
	[...sites].sort((a, b) => b[1].size - a[1].size).slice(0, 30).forEach(([site, entry]) => {
		console.error(`  ${percent(entry.size, totalSize).padStart(7)}  ${String(entry.copies).padStart(9)}x  ${site}`);
	});
}

function add(map, key, entry) {
	let sum = map.get(key);
	if (!sum) {
		sum = { copies: 0, size: 0, sites: 0 };
		map.set(key, sum);
	}
	sum.copies += entry.copies;
	sum.size += entry.size;
	return sum;
}

function parseSite(site) {
	// Der Pfad kann unter Windows selbst einen Doppelpunkt enthalten, Art und Kategorie stehen hinten.
	const parts = site.split(':');
	return {
		category: parts[parts.length - 1],
		kind: parts[parts.length - 2],
	};
}
