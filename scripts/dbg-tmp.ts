import { checkerStats, resetCheckerStats } from '../src/checker/checker-stats.js';
import { createInMemoryHost, loadFile } from '../src/compiler/project-loader.js';
const measure = (name: string, code: string) => {
	const run = () => {
		resetCheckerStats();
		const t = performance.now();
		const p = loadFile('x.jul', {}, createInMemoryHost({ 'x.jul': code }, { cloneUnchecked: false }), code);
		return `${(performance.now() - t).toFixed(1).padStart(6)} ms fold ${String(checkerStats.foldableCall).padStart(6)} errors ${p.checked?.errors.map(e => e.code)}`;
	};
	run();
	console.log(name.padEnd(30), run());
};
const prog = (n: number, extra = '') => `isDiv = (dividend: Integer) => dividend.modulo(=>3).equal(0)
f = (value: PositiveInteger) =>
	?(value)
		[isDiv] => §a§
		Any => value
messages = range(1 ${n}).map(f)
messages.forEach((value) => value)
${extra}`;
for (const n of [5, 8, 10, 12, 15, 20, 25]) measure(`n=${n}`, prog(n));
measure('forEach ohne Callback-Param', `isDiv = (dividend: Integer) => dividend.modulo(=>3).equal(0)
f = (value: PositiveInteger) =>
	?(value)
		[isDiv] => §a§
		Any => value
range(1 25).map(f).forEach((value) => value)
`);
measure('ohne map-Variable n=25', `isDiv = (dividend: Integer) => dividend.modulo(=>3).equal(0)
f = (value: PositiveInteger) =>
	?(value)
		[isDiv] => §a§
		Any => value
x = range(1 25).map(f)
x.forEach((value) => value)
`);
