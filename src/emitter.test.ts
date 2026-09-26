import { expect } from 'chai';
import { parseCode } from './parser/parser.js';
import { checkTypes } from './checker/checker.js';
import { errorInfos } from './compiler-errors.js';
import { functionLiteralToEvaluableJs, getRuntimeImportJs, getTestRuntimeImportJs, syntaxTreeToJs, syntaxTreeToJsWithMappings } from './emitter.js';
import { ParseFunctionLiteral, ParseSingleDefinition } from './syntax-tree.js';
import { reportAtCaller } from './test-util.js';

const expectEmit = reportAtCaller((code: string, result: string) => {
	const parsed = parseCode(code, 'dummy.jul');
	const syntaxTree = parsed.unchecked.expressions!;
	const compiled = syntaxTreeToJs(syntaxTree, '');
	expect(compiled).to.equal(getRuntimeImportJs('') + result);
});

describe('Emitter', () => {
	it('true', () => {
		expectEmit('true', 'export default true');
	});
	it('Any', () => {
		expectEmit('Any', 'export default Any');
	});
	it('String', () => {
		expectEmit('String', 'export default _String');
	});
	// TODO parse comments
	// result: '// Destructuring import\n"a"'
	it('# Destructuring import\n§a§', () => {
		expectEmit('# Destructuring import\n§a§', 'export default `a`');
	});
	it('§12§', () => {
		expectEmit('§12§', 'export default `12`');
	});
	it('12', () => {
		expectEmit('12', 'export default 12n');
	});
	it('[1 2]', () => {
		expectEmit('[1 2]', `export default [
	1n,
	2n,
]`);
	});
	it('someVar = 12', () => {
		expectEmit('someVar = 12', 'export const someVar = 12n;');
	});
	it('log()', () => {
		expectEmit('log()', 'export default log()');
	});
	it('log-empty', () => {
		expectEmit('log([])', `export default log(undefined)`);
	});
	it('log(1)', () => {
		expectEmit('log(1)', `export default log(1n)`);
	});
	it('functionCall-unknown-object', () => {
		expectEmit('log(...[])', `export default _callFunction(
	log,
	undefined,
	_combineObject(undefined),
)`);
	});
	it('1.log()', () => {
		expectEmit('1.log()', 'export default log(1n)');
	});
	it('1.log(1)', () => {
		expectEmit('1.log(1)', `export default log(
	1n,
	1n,
)`);
	});
	it('function-call-named-args', () => {
		expectEmit('log(a = 1)', `export default _callFunction(
	log,
	undefined,
	{'a': 1n},
)`);
	});
	it('text-argument', () => {
		expectEmit('log(§hallo welt§)', 'export default log(`hallo welt`)');
	});
	it('someVar/1/test', () => {
		expectEmit('someVar/1/test', 'export default someVar?.[1 - 1]?.[\'test\']');
	});
	it('functionLiteral', () => {
		expectEmit('(a b) => log(a)', `export default _createFunction(
	(a, b) => {
		return log(a)
	},
	{singleNames: [
		{name: 'a'},
		{name: 'b'},
	]},
)`);
	});
	it('function-return-type-check', () => {
		expectEmit(`() =>
	a: Integer = 1`, `export default _createFunction(
	() => {
		const a = 1n;
		return a;
	},
	{},
)`);
	});
	it('multiline-function-body', () => {
		expectEmit('(a b) =>\n\tlog(a)\n\tlog(b)', `export default _createFunction(
	(a, b) => {
		log(a)
		return log(b)
	},
	{singleNames: [
		{name: 'a'},
		{name: 'b'},
	]},
)`);
	});
	it('branching', () => {
		expectEmit('?(4)\n\t(a) => log(a)\n\t(b) => log(b)', `export default _branch(
	[4n],
	_createFunction(
		(a) => {
			return log(a)
		},
		{singleNames: [{name: 'a'}]},
	),
	_createFunction(
		(b) => {
			return log(b)
		},
		{singleNames: [{name: 'b'}]},
	),
)`);
	});
	it('[a: String]', () => {
		expectEmit('[a: String]', `export default {
	[_julTypeSymbol]: 'dictionaryLiteral',
	Fields: {'a': _String},
}`);
	});
	it('[a: String b]', () => {
		expectEmit('[a: String b]', `export default {
	[_julTypeSymbol]: 'dictionaryLiteral',
	Fields: {
		'a': _String,
		'b': Any,
	},
}`);
	});
	// Der gespreadete Typ ist selbst ein Typobjekt, übernommen werden seine Fields.
	it('dictionary-type-spread', () => {
		expectEmit('[...a b: String]', `export default {
	[_julTypeSymbol]: 'dictionaryLiteral',
	Fields: {
		...a.Fields,
		'b': _String,
	},
}`);
	});
	it('[1 ...a ...b]', () => {
		expectEmit('[1 ...a ...b]', `export default [
	1n,
	...a ?? [],
	...b ?? [],
]`);
	});
	it('(testVar) = import(§./some-file.jul§)', () => {
		expectEmit('(testVar) = import(§./some-file.jul§)', 'export default import {testVar} from \'./some-file.js\';\n');
	});
	it('type-function', () => {
		expectEmit('Any => []', `export default _createFunction(
	() => {
		return undefined
	},
	{type: Any},
)`);
	});
	it('empty-type-function', () => {
		expectEmit('Empty => []', `export default _createFunction(
	() => {
		return undefined
	},
	{type: Empty},
)`);
	});
});

/**
 * Emittiert nach dem Check, damit der Emitter die typeInfo sieht. Verglichen wird nur der Rumpf
 * der Funktion f: das _createFunction mit den Parametertypen dahinter ist hier nicht Gegenstand
 * und würde jeden Fall aufblähen.
 */
function emitCheckedFunctionBody(code: string): string {
	const parsed = parseCode(code, 'dummy.jul');
	checkTypes(parsed, {}, { cloneUnchecked: false });
	const checked = parsed.checked!;
	const errors = checked.errors.filter(error => errorInfos[error.code].severity === 'error');
	expect(errors.map(error => error.message)).to.deep.equal([]);
	const compiled = syntaxTreeToJs(checked.expressions!, '');
	const functionStart = compiled.indexOf('export const f = (');
	const bodyStart = compiled.indexOf(' => {', functionStart) + ' => {'.length;
	const bodyEnd = compiled.indexOf('\n\t}\n\t_createFunction(\n\tf,', bodyStart);
	expect(functionStart, 'f fehlt').to.be.greaterThan(-1);
	expect(bodyEnd, 'Ende von f nicht gefunden').to.be.greaterThan(-1);
	return compiled.slice(bodyStart, bodyEnd);
}

const expectBranchingEmit = reportAtCaller((code: string, bodyJs: string) => {
	expect(emitCheckedFunctionBody(code)).to.equal(bodyJs);
});

/** Fälle, in denen die Typen keinen billigeren Test hergeben: dort bleibt der volle Check über _branch */
const expectBranchingFallback = reportAtCaller((code: string) => {
	expect(emitCheckedFunctionBody(code)).to.match(/^\n\t\treturn _branch\(/);
});

describe('Emitter branching mit Typinformation', () => {
	it('Empty gegen komplexen Typ wird zu undefined-Vergleich', () => {
		expectBranchingEmit(`f = (x: Or([] [a: Integer b: Text])) =>
	?(x)
		[[a: Integer b: Text]] => 1
		() => 2`, `
		return x !== undefined
			? (() => {
				return 1n
			})()
			: (() => {
				return 2n
			})()`);
	});
	it('verschiedene Laufzeitarten werden mit typeof und Array.isArray unterschieden', () => {
		expectBranchingEmit(`f = (x: Or(Text List(Integer) [name: Text])) =>
	?(x)
		[Text] => 1
		[List(Integer)] => 2
		() => 3`, `
		return typeof x === 'string'
			? (() => {
				return 1n
			})()
			: Array.isArray(x)
			? (() => {
				return 2n
			})()
			: (() => {
				return 3n
			})()`);
	});
	it('Literal-Kopf wird zu Gleichheitsvergleich', () => {
		expectBranchingEmit(`f = (x: Integer) =>
	?(x)
		[1] => 1
		() => 2`, `
		return x === 1n
			? (() => {
				return 1n
			})()
			: (() => {
				return 2n
			})()`);
	});
	it('Branch mit Parameter bekommt das Argument direkt', () => {
		expectBranchingEmit(`f = (x: Or([] Text)) =>
	?(x)
		(t: Text) => t
		() => §leer§`, `
		return x !== undefined
			? ((t) => {
				return t
			})(x)
			: (() => {
				return \`leer\`
			})()`);
	});
	it('erster Branch deckt alles ab: kein Test, keine weiteren Branches', () => {
		expectBranchingEmit(`f = (x: Text) =>
	?(x)
		[Text] => 1
		() => 2`, `
		return (() => {
				return 1n
			})()`);
	});
	it('nicht erschöpfend: nach dem letzten Test folgt _noBranchMatched', () => {
		expectBranchingEmit(`f = (x: Or(Text Integer)) =>
	?(x)
		[Text] => 1`, `
		return typeof x === 'string'
			? (() => {
				return 1n
			})()
			: _noBranchMatched(x)`);
	});
	it('letzter Literal-Branch fängt den Rest: Aufruf ohne Test statt offenem Zweig', () => {
		expectBranchingEmit(`f = (x: Or(§a§ §b§)) =>
	?(x)
		[§a§] => 1
		[§b§] => 2`, `
		return x === 'a'
			? (() => {
				return 1n
			})()
			: (() => {
				return 2n
			})()`);
	});
	it('Branch, der keinen der noch möglichen Werte fängt, entfällt', () => {
		expectBranchingEmit(`f = (x: Or([] §a§)) =>
	?(x)
		[§a§] => 1
		[Text] => 2
		() => 3`, `
		return x === 'a'
			? (() => {
				return 1n
			})()
			: (() => {
				return 3n
			})()`);
	});
	it('unterscheidendes Feld wird direkt verglichen', () => {
		expectBranchingEmit(`f = (x: Or([kind: §circle§ radius: Float] [kind: §rect§ width: Float])) =>
	?(x)
		[[kind: §circle§]] => 1
		() => 2`, `
		return x?.['kind'] === 'circle'
			? (() => {
				return 1n
			})()
			: (() => {
				return 2n
			})()`);
	});
	it('Argument ohne Referenz wird genau einmal ausgewertet', () => {
		expectBranchingEmit(`g = (y: Or([] Text)) => y
f = (x: Or([] Text)) =>
	?(g(x))
		[Text] => 1
		() => 2`, `
		return ((_arg) => _arg !== undefined
				? (() => {
					return 1n
				})()
				: (() => {
					return 2n
				})())(g(x))`);
	});
	it('Rückfall: Any in einem Glied, die Teilmengenprüfung wäre dort permissiv', () => {
		expectBranchingFallback(`f = (x: Or([] [a: Any])) =>
	?(x)
		[[a: Integer]] => 1
		() => 2`);
	});
	it('Rückfall: untypisiertes Argument', () => {
		expectBranchingFallback(`f = (x) =>
	?(x)
		[Integer] => 1
		() => 2`);
	});
	it('Rückfall: zwei Argumente', () => {
		expectBranchingFallback(`f = (x: Integer y: Integer) =>
	?(x y)
		[1 Integer] => 1
		() => 2`);
	});
	it('Rückfall: komplexe Typen, die sich nur tief in der Struktur unterscheiden', () => {
		expectBranchingFallback(`f = (x: Or(List(Integer) List(Or(Integer Text)))) =>
	?(x)
		[List(Integer)] => 1
		() => 2`);
	});
});

const expectCallEmit = reportAtCaller((code: string, bodyJs: string) => {
	expect(emitCheckedFunctionBody(code)).to.equal(bodyJs);
});

/** Fälle, in denen der Aufruf weiter zur Laufzeit über _callFunction zugeordnet wird */
const expectCallFallback = reportAtCaller((code: string) => {
	expect(emitCheckedFunctionBody(code)).to.match(/^\n\t\treturn _callFunction\(/);
});

describe('Emitter benannte Argumente mit Typinformation', () => {
	it('gleiche Reihenfolge wird zum positionalen Aufruf', () => {
		expectCallEmit(`g = (a: Integer b: Integer) => a
f = (x: Integer) =>
	g(a = x b = 1)`, `
		return g(
			x,
			1n,
		)`);
	});
	it('abweichende Reihenfolge wird in Parameterreihenfolge übergeben', () => {
		expectCallEmit(`g = (a: Integer b: Integer) => a
f = (x: Integer) =>
	g(b = 1 a = x)`, `
		return g(
			x,
			1n,
		)`);
	});
	it('fehlender letzter Parameter entfällt', () => {
		expectCallEmit(`g = (a: Integer b: Or([] Integer)) => a
f = (x: Integer) =>
	g(a = x)`, `
		return g(x)`);
	});
	it('fehlender Parameter in der Mitte wird undefined', () => {
		expectCallEmit(`g = (a: Or([] Integer) b: Integer) => b
f = (x: Integer) =>
	g(b = x)`, `
		return g(
			undefined,
			x,
		)`);
	});
	it('prefixArgument geht an den ersten Parameter', () => {
		expectCallEmit(`g = (a: Integer b: Integer) => a
f = (x: Integer) =>
	x.g(b = 1)`, `
		return g(
			x,
			1n,
		)`);
	});
	it('ein einzelnes nicht-triviales Argument darf die Position wechseln', () => {
		expectCallEmit(`h = (y: Integer) => y
g = (a: Integer b: Integer) => a
f = (x: Integer) =>
	g(b = h(x) a = x)`, `
		return g(
			x,
			h(x),
		)`);
	});
	it('mehrere nicht-triviale Argumente werden in geschriebener Reihenfolge ausgewertet', () => {
		expectCallEmit(`h = (y: Integer) => y
g = (a: Integer b: Integer) => a
f = (x: Integer) =>
	g(b = h(x) a = h(1))`, `
		return ((_arg0, _arg1) => g(_arg1, _arg0))(
			h(x),
			h(1n),
		)`);
	});
	it('überzähliges nicht-triviales Argument wird trotzdem ausgewertet', () => {
		expectCallEmit(`h = (y: Integer) => y
g = (a: Integer) => a
f = (x: Integer) =>
	g(a = x c = h(x))`, `
		return ((_arg0, _arg1) => g(_arg0))(
			x,
			h(x),
		)`);
	});
	it('Rückfall: nativeFunction bekommt weiter das Dictionary', () => {
		expectCallFallback(`f = (x: Integer) =>
	modulo(dividend = x divisor = 3)`);
	});
	it('Rückfall: funktionswertiger Parameter', () => {
		expectCallFallback(`f = (g: (a: Integer) -> Integer) =>
	g(a = 1)`);
	});
});

const expectTestEmit = reportAtCaller((code: string, result: string) => {
	const parsed = parseCode(code, 'dummy.test.jul');
	const compiled = syntaxTreeToJs(parsed.unchecked.expressions!, '', 'dummy.test.jul');
	expect(compiled).to.equal(getRuntimeImportJs('') + getTestRuntimeImportJs('') + result);
});

describe('Emitter test', () => {
	// Die Stelle geht als drittes Argument mit, der äußerste Aufruf im Callback über _testCall.
	it('instrumented-outermost-call', () => {
		expectTestEmit('test(§a§ () => equal(1 2))', `export default test(
	\`a\`,
	_createFunction(
		() => {
			return _testCall(
				'equal',
				equal,
				[
					1n,
					2n,
				],
			)
		},
		{},
	),
	{ file: 'dummy.test.jul', row: 1, column: 1 },
)`);
	});
	it('prefix-argument-is-first-instrumented-argument', () => {
		expectTestEmit('test(§a§ () => 1.equal(2))', `export default test(
	\`a\`,
	_createFunction(
		() => {
			return _testCall(
				'equal',
				equal,
				[
					1n,
					2n,
				],
			)
		},
		{},
	),
	{ file: 'dummy.test.jul', row: 1, column: 1 },
)`);
	});
	// Benannte Argumente werden positionell emittiert, damit die Stelle mitgehen kann.
	it('named-arguments-are-emitted-positionally', () => {
		expectTestEmit('test(name = §a§ callback = () => true)', `export default test(
	\`a\`,
	_createFunction(
		() => {
			return true
		},
		{},
	),
	{ file: 'dummy.test.jul', row: 1, column: 1 },
)`);
	});
});

/**
 * An der Quellposition (0-basiert) beginnt ein Statement, dessen erzeugtes JS mit generatedJs
 * anfängt.
 */
const expectMapping = reportAtCaller((
	code: string,
	sourceLine: number,
	sourceColumn: number,
	generatedJs: string,
) => {
	const parsed = parseCode(code, 'dummy.jul');
	const { js, mappings } = syntaxTreeToJsWithMappings(parsed.unchecked.expressions!, '');
	const mapping = mappings.find(candidate =>
		candidate.sourceLine === sourceLine
		&& candidate.sourceColumn === sourceColumn);
	expect(mapping, `mapping für ${sourceLine}:${sourceColumn}`).to.not.equal(undefined);
	const generatedLine = js.split('\n')[mapping!.generatedLine]!;
	expect(generatedLine.slice(mapping!.generatedColumn)).to.satisfy(
		(generated: string) => generated.startsWith(generatedJs),
		`erzeugt: ${generatedLine}`);
});

describe('Emitter source map', () => {
	it('top-level-definition', () => {
		expectMapping('a = 1\n\nb = 2', 2, 0, 'export const b = 2n;');
	});
	it('default-export', () => {
		expectMapping('§a§', 0, 0, 'export default `a`');
	});
	it('expression-in-function-body-maps-to-own-line', () => {
		expectMapping('f = (x: Integer) =>\n\ty = x\n\ty', 1, 1, 'const y = x;');
	});
	// Der Marker steht vor dem return, nicht dahinter.
	it('last-expression-in-function-body-includes-return', () => {
		expectMapping('f = (x: Integer) =>\n\ty = x\n\ty', 2, 1, 'return y');
	});
	it('last-definition-in-function-body', () => {
		expectMapping('f = (x: Integer) =>\n\ty = x', 1, 1, 'const y = x;');
	});
	it('nested-function-body', () => {
		expectMapping('f = (x: Integer) =>\n\tg = (y: Integer) =>\n\t\tz = y\n\t\tz\n\tg(x)', 2, 2, 'const z = y;');
	});
	it('statement-after-nested-function', () => {
		expectMapping('f = (x: Integer) =>\n\tg = (y: Integer) =>\n\t\ty\n\tg(x)', 3, 1, 'return g(x)');
	});
	// Ein Markerzeichen aus dem Quelltext darf nicht als Marker gelesen werden.
	it('marker-character-in-text-is-escaped', () => {
		const parsed = parseCode('a = §x\u0001y\u0002z§', 'dummy.jul');
		const { js, mappings } = syntaxTreeToJsWithMappings(parsed.unchecked.expressions!, '');
		expect(js).to.equal(getRuntimeImportJs('') + 'export const a = `x\\u0001y\\u0002z`;');
		expect(mappings).to.have.length(1);
	});
	it('constant-folding-emits-without-markers', () => {
		const parsed = parseCode('f = (x: Integer) =>\n\ty = x\n\ty', 'dummy.jul');
		const literal = (parsed.unchecked.expressions![0] as ParseSingleDefinition).value as ParseFunctionLiteral;
		expect(functionLiteralToEvaluableJs(literal)).to.not.match(/[\u0001\u0002]/);
	});
});
