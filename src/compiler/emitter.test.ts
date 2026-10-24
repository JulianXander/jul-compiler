import { expect } from 'chai';
import { parseCode } from '../parser/parser.js';
import { checkTypes } from '../checker/checker.js';
import { ErrorCode, errorInfos } from '../compiler-errors.js';
import { functionLiteralToEvaluableJs, getUsedRuntimeNames, jsonValueToJs, syntaxTreeToJs, syntaxTreeToJsWithMappings } from './emitter.js';
import { ParseFunctionLiteral, ParseSingleDefinition } from '../syntax-tree.js';
import { reportAtCaller } from '../test-util.js';
import * as runtime from '../runtime/runtime.js';

/**
 * Die Import-Zeilen am Anfang, welche Namen sie enthalten, prüft der Abschnitt Runtime-Import.
 */
const importLinesRegex = /^(import \{[^}]*\} from '[^']*';\n)*/;

function withoutImports(js: string): string {
	return js.replace(importLinesRegex, '');
}

const expectEmit = reportAtCaller((code: string, result: string) => {
	const parsed = parseCode(code, 'dummy.jul');
	const syntaxTree = parsed.unchecked.expressions!;
	const compiled = syntaxTreeToJs(syntaxTree, '');
	expect(withoutImports(compiled)).to.equal(result);
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
	// Eine reine Spread-Argumentliste ist ein List-Spread (der Checker lässt nur eine List zu).
	it('functionCall-spread-only', () => {
		expectEmit('log(...[])', 'export default log(...undefined ?? [])');
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
	// Ohne Check kennt der Emitter keine Parameterliste: Die Werte gehen der Reihe nach an die Funktion.
	it('function-call-named-args', () => {
		expectEmit('log(a = 1)', 'export default log(1n)');
	});
	it('text-argument', () => {
		expectEmit('log(§hallo welt§)', 'export default log(`hallo welt`)');
	});
	it('someVar/1/test', () => {
		expectEmit('someVar/1/test', 'export default someVar?.[1 - 1]?.[\'test\']');
	});
	it('functionLiteral', () => {
		expectEmit('(a b) => log(a)', `export default (a, b) => {
		return log(a)
	}`);
	});
	it('function-return-type-check', () => {
		expectEmit(`() =>
	a: Integer = 1`, `export default () => {
		const a = 1n;
		return a;
	}`);
	});
	it('multiline-function-body', () => {
		expectEmit('(a b) =>\n\tlog(a)\n\tlog(b)', `export default (a, b) => {
		log(a)
		return log(b)
	}`);
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
	// Ein Feld, das fehlen darf, trägt das Kennzeichen am Typ des Felds.
	it('[a: String b?: String]', () => {
		expectEmit('[a: String b?: String]', `export default {
	[_julTypeSymbol]: 'dictionaryLiteral',
	Fields: {
		'a': _String,
		'b': _optionalField(_String),
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
	// Mit Parametertypen folgt ein _createFunction, sonst endet f nach dem Arrow.
	const bodyEndWithParams = compiled.indexOf('\n\t}\n\t_createFunction(\n\tf,', bodyStart);
	const bodyEnd = bodyEndWithParams >= 0
		? bodyEndWithParams
		: compiled.indexOf('\n\t};', bodyStart);
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
		[[kind: §circle§ radius: Float]] => 1
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
	// Ob ein beliebiger Integer gerade ist, entscheidet erst die Laufzeit. Ein Array-Test allein
	// würde [1 3] in den ersten branch schicken.
	it('Rückfall: Prädikat im Elementtyp, die Teilmenge ist unbekannt', () => {
		expectBranchingFallback(`isEven = (n: Integer) => n.modulo(2).equal(0)
f = (x: Or(Text List(Integer))) =>
	?(x)
		[List(isEven)] => 1
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
	// bound (PositiveInteger = GreaterInteger(0)) hat als Laufzeitart bigint bzw. number. Ein Feld mit bound
	// macht den Record nicht unbestimmbar: gefragt ist nur, welcher der möglichen Fälle vorliegt.
	it('bound im Record: Error gegen Record mit PositiveInteger-Feld wird zu instanceof', () => {
		expectBranchingEmit(`f = (x: Or(Error [a: PositiveInteger])) =>
	?(x)
		[Error] => 1
		() => 2`, `
		return x instanceof Error
			? (() => {
				return 1n
			})()
			: (() => {
				return 2n
			})()`);
	});
	it('bound im Record: Empty gegen Record mit PositiveInteger-Feld wird zu undefined-Vergleich', () => {
		expectBranchingEmit(`f = (x: Or([] [a: PositiveInteger])) =>
	?(x)
		[Empty] => 1
		() => 2`, `
		return x === undefined
			? (() => {
				return 1n
			})()
			: (() => {
				return 2n
			})()`);
	});
	it('bound im Record: Kopf mit dem Record-Typ wird zu undefined-Vergleich', () => {
		expectBranchingEmit(`f = (x: Or([] [a: PositiveInteger])) =>
	?(x)
		[[a: PositiveInteger]] => 1
		() => 2`, `
		return x !== undefined
			? (() => {
				return 1n
			})()
			: (() => {
				return 2n
			})()`);
	});
	it('bound im Record: unterscheidendes Feld wird direkt verglichen', () => {
		expectBranchingEmit(`f = (x: Or([kind: §a§ id: PositiveInteger] [kind: §b§ id: PositiveInteger])) =>
	?(x)
		[[kind: §a§ id: PositiveInteger]] => 1
		() => 2`, `
		return x?.['kind'] === 'a'
			? (() => {
				return 1n
			})()
			: (() => {
				return 2n
			})()`);
	});
	it('bound als Glied: Text gegen PositiveInteger wird zu typeof', () => {
		expectBranchingEmit(`f = (x: Or(Text PositiveInteger)) =>
	?(x)
		[Text] => 1
		() => 2`, `
		return typeof x === 'string'
			? (() => {
				return 1n
			})()
			: (() => {
				return 2n
			})()`);
	});
	it('bound als Glied: Kopf PositiveInteger auf Or([] PositiveInteger) wird zu undefined-Vergleich', () => {
		expectBranchingEmit(`f = (x: Or([] PositiveInteger)) =>
	?(x)
		[PositiveInteger] => 1
		() => 2`, `
		return x !== undefined
			? (() => {
				return 1n
			})()
			: (() => {
				return 2n
			})()`);
	});
	it('bound im Record: Record mit PositiveInteger-Feld ist Teilmenge von Record mit Integer-Feld', () => {
		expectBranchingEmit(`f = (x: Or(Text [a: PositiveInteger])) =>
	?(x)
		[[a: Integer]] => 1
		() => 2`, `
		return typeof x !== 'string'
			? (() => {
				return 1n
			})()
			: (() => {
				return 2n
			})()`);
	});
	it('Rückfall: Record mit Integer-Feld ist keine Teilmenge von Record mit PositiveInteger-Feld', () => {
		expectBranchingFallback(`f = (x: Or(Text [a: Integer])) =>
	?(x)
		[[a: PositiveInteger]] => 1
		() => 2`);
	});
	// Ob ein Integer größer 0 ist, entscheidet erst die Laufzeit: Integer und PositiveInteger haben dieselbe Laufzeitart.
	it('Rückfall: Kopf PositiveInteger auf Integer, die Grenze entscheidet erst die Laufzeit', () => {
		expectBranchingFallback(`f = (x: Integer) =>
	?(x)
		[PositiveInteger] => 1
		() => 2`);
	});
	it('Rückfall: Kopf PositiveInteger auf Or([] Integer)', () => {
		expectBranchingFallback(`f = (x: Or([] Integer)) =>
	?(x)
		[PositiveInteger] => 1
		() => 2`);
	});
	it('Rückfall: bound in einem Glied mit Any bleibt unbrauchbar', () => {
		expectBranchingFallback(`f = (x: Or([] [a: PositiveInteger b: Any])) =>
	?(x)
		[[a: PositiveInteger b: Integer]] => 1
		() => 2`);
	});
	// Literaltypen sind Einzelwerte: Ein Literal, das nicht zum Kopf gehört, ist sicher verfehlt, auch bei gleicher Laufzeitart.
	it('Kopf mit Union von Text-Literalen wird zu Gleichheitsvergleichen', () => {
		expectBranchingEmit(`Phase = Or(§draw§ §standby§ §main1§ §battle§ §main2§ §end§)
f = (x: Phase) =>
	?(x)
		[Or(§draw§ §standby§)] => 1
		[Or(§main1§ §main2§)] => 2
		[Or(§battle§)] => 3
		() => 4`, `
		return x === 'draw' || x === 'standby'
			? (() => {
				return 1n
			})()
			: x === 'main1' || x === 'main2'
			? (() => {
				return 2n
			})()
			: x === 'battle'
			? (() => {
				return 3n
			})()
			: (() => {
				return 4n
			})()`);
	});
	it('Kopf mit Union von Integer-Literalen und Empty wird zu Gleichheitsvergleichen', () => {
		expectBranchingEmit(`f = (x: Or([] 1 2 3 4 5 6 7 8)) =>
	?(x)
		[Or([] 1 2 3 4)] => 0
		[Or(5 6)] => 1
		() => 2`, `
		return x === undefined || x === 1n || x === 2n || x === 3n || x === 4n
			? (() => {
				return 0n
			})()
			: x === 5n || x === 6n
			? (() => {
				return 1n
			})()
			: (() => {
				return 2n
			})()`);
	});
	it('Kopf mit Union von Literalen: Glieder außerhalb des Kopfs entfallen', () => {
		expectBranchingEmit(`f = (x: Or(§a§ §b§ §c§)) =>
	?(x)
		[Or(§a§ §z§)] => 1
		() => 2`, `
		return x === 'a'
			? (() => {
				return 1n
			})()
			: (() => {
				return 2n
			})()`);
	});
	// Der Test nach Laufzeitart greift zuerst: a und b sind die einzigen Texte im Typ.
	it('Kopf mit Union von Literalen, Argument mit anderer Laufzeitart: typeof reicht', () => {
		expectBranchingEmit(`f = (x: Or(§a§ §b§ Integer)) =>
	?(x)
		[Or(§a§ §b§)] => 1
		() => 2`, `
		return typeof x === 'string'
			? (() => {
				return 1n
			})()
			: (() => {
				return 2n
			})()`);
	});
	it('Rückfall: Kopf mit Union von Literalen, Argument mit Text (Wert unbekannt)', () => {
		expectBranchingFallback(`f = (x: Or(Text Integer)) =>
	?(x)
		[Or(§a§ §b§)] => 1
		() => 2`);
	});
	it('Rückfall: Kopf mit Union von Literalen, Argument mit Integer (Wert unbekannt)', () => {
		expectBranchingFallback(`f = (x: Or([] Integer)) =>
	?(x)
		[Or(1 2)] => 1
		() => 2`);
	});
});

const expectCallEmit = reportAtCaller((code: string, bodyJs: string) => {
	expect(emitCheckedFunctionBody(code)).to.equal(bodyJs);
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
	// Der eigene Typ steht beim rekursiven Aufruf noch nicht fest (Any): Die Namen kommen vom Literal.
	it('rekursiver Aufruf mit Namen wird positional', () => {
		expectCallEmit(`f = (n: Integer acc: Integer) =>
	?(n)
		[0] => acc
		() => f(n = subtract(n 1) acc = add(acc n))`, `
		return n === 0n
			? (() => {
				return acc
			})()
			: (() => {
				return f(
					subtract(
						n,
						1n,
					),
					add(
						acc,
						n,
					),
				)
			})()`);
	});
	// Ohne bekannte Parameterliste (Any, JUL5011) gehen die Werte der Reihe nach, die Namen entfallen.
	it('Aufruf eines Any-Werts mit Namen wird positional in geschriebener Reihenfolge', () => {
		expectCallEmit(`f = (g: Any) =>
	g(a = 1 b = 2)`, `
		return g(
			1n,
			2n,
		)`);
	});
	it('Builtin wird direkt aufgerufen', () => {
		expectCallEmit(`f = (x: Integer) =>
	modulo(dividend = x divisor = 3)`, `
		return modulo(
			x,
			3n,
		)`);
	});
	it('funktionswertiger Parameter wird direkt aufgerufen', () => {
		expectCallEmit(`f = (g: (a: Integer) -> Integer) =>
	g(a = 1)`, `
		return g(1n)`);
	});
	it('Funktion mit Typ-Kopf bekommt die Argumente in Parameterreihenfolge, sie liest sie nicht', () => {
		expectCallEmit(`MyType = [a: Integer b: Integer]
typeFunction = MyType => 1
f = () =>
	typeFunction(a = 1 b = 2)`, `
		return typeFunction(
			1n,
			2n,
		)`);
	});
	it('List-Spread in der Argumentliste ist ein JS-Spread', () => {
		expectCallEmit(`g = (a: Integer b: Integer) => a
f = (values: [Integer Integer]) =>
	g(...values)`, `
		return g(...values ?? [])`);
	});
});

const expectTestEmit = reportAtCaller((code: string, result: string) => {
	const parsed = parseCode(code, 'dummy.test.jul');
	const compiled = syntaxTreeToJs(parsed.unchecked.expressions!, '', 'dummy.test.jul');
	expect(withoutImports(compiled)).to.equal(result);
});

describe('Emitter test', () => {
	// Die Stelle geht als drittes Argument mit, der äußerste Aufruf im Callback über _testCall.
	it('instrumented-outermost-call', () => {
		expectTestEmit('test(§a§ () => equal(1 2))', `export default test(
	\`a\`,
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
	{ file: 'dummy.test.jul', row: 1, column: 1 },
)`);
	});
	it('prefix-argument-is-first-instrumented-argument', () => {
		expectTestEmit('test(§a§ () => 1.equal(2))', `export default test(
	\`a\`,
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
	{ file: 'dummy.test.jul', row: 1, column: 1 },
)`);
	});
	// Benannte Argumente werden positionell emittiert, damit die Stelle mitgehen kann.
	it('named-arguments-are-emitted-positionally', () => {
		expectTestEmit('test(name = §a§ callback = () => true)', `export default test(
	\`a\`,
	() => {
			return true
		},
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
		expect(js).to.equal('export const a = `x\\u0001y\\u0002z`;');
		expect(mappings).to.have.length(1);
	});
	it('constant-folding-emits-without-markers', () => {
		const parsed = parseCode('f = (x: Integer) =>\n\ty = x\n\ty', 'dummy.jul');
		const literal = (parsed.unchecked.expressions![0] as ParseSingleDefinition).value as ParseFunctionLiteral;
		expect(functionLiteralToEvaluableJs(literal)).to.not.match(/[\u0001\u0002]/);
	});
});

/**
 * Die Namen der Import-Zeile aus dem Modulpfad `path`, undefined ohne solche Zeile.
 */
function getImportedNames(js: string, path: string): string[] | undefined {
	const line = js.split('\n').find(candidate => candidate.startsWith('import {') && candidate.endsWith(` from '${path}';`));
	return line?.slice('import { '.length, line.indexOf(' }')).split(', ');
}

const expectRuntimeImport = reportAtCaller((code: string, names: string[] | undefined, filePath: string = 'dummy.jul') => {
	const parsed = parseCode(code, filePath);
	const compiled = syntaxTreeToJs(parsed.unchecked.expressions!, '', filePath);
	expect(getImportedNames(compiled, '')).to.deep.equal(names);
});

const expectTestRuntimeImport = reportAtCaller((code: string, names: string[] | undefined) => {
	const parsed = parseCode(code, 'dummy.test.jul');
	const compiled = syntaxTreeToJs(parsed.unchecked.expressions!, '', 'dummy.test.jul', 'test-runtime.js');
	expect(getImportedNames(compiled, 'test-runtime.js')).to.deep.equal(names);
});

describe('Emitter Runtime-Import', () => {
	it('Referenz auf ein Builtin importiert genau dieses', () => {
		expectRuntimeImport('log(1)', ['log']);
	});
	it('ohne Runtime-Bezug keine Import-Zeile', () => {
		expectRuntimeImport('x = 1\ny = [1 2]', undefined);
	});
	it('Funktionsliteral ohne Typen importiert nichts', () => {
		expectRuntimeImport('f = (a) => a', undefined);
	});
	it('Funktionsliteral mit Typ importiert _createFunction', () => {
		expectRuntimeImport('f = (a: Integer) => a', ['Integer', '_createFunction']);
	});
	it('Typ-Guard importiert den Builtin-Typ', () => {
		expectRuntimeImport('f = (a: Integer) => a', ['Integer', '_createFunction']);
	});
	it('Branching importiert _branch', () => {
		expectRuntimeImport('?(4)\n\t(a) => log(a)\n\t(b) => log(b)', ['_branch', '_createFunction', 'log']);
	});
	it('Builtin-Name in einem Textliteral wird mit importiert', () => {
		expectRuntimeImport('a = §map§', ['map']);
	});
	it('Testdatei importiert aus der Runtime nur die benutzten Namen', () => {
		expectRuntimeImport('test(§x§ () => equal(1 1))', ['equal'], 'dummy.test.jul');
	});
	it('Testdatei importiert aus der Test-Runtime nur die benutzten Namen', () => {
		expectTestRuntimeImport('test(§x§ () => equal(1 1))', ['_testCall', 'test']);
	});
	it('Testdatei ohne test-Aufruf importiert die Test-Runtime nicht', () => {
		expectTestRuntimeImport('x = 1', undefined);
	});
	it('Scan: Bezeichner hinter einem Punkt ist ein Feldzugriff', () => {
		expect(getUsedRuntimeNames('values.map(f); x?.filter', ['map', 'filter'])).to.deep.equal([]);
	});
	it('Scan: Bezeichner hinter einem Spread ist eine Referenz', () => {
		expect(getUsedRuntimeNames('[...map]', ['map'])).to.deep.equal(['map']);
	});
	it('Scan: Namen mit $ und Unterstrich', () => {
		expect(getUsedRuntimeNames('combine$(a); _branch(b)', ['_branch', 'combine$', 'combine'])).to.deep.equal(['_branch', 'combine$']);
	});
	it('Scan: Suffix einer Zahl ist kein Bezeichner', () => {
		expect(getUsedRuntimeNames('f(1n)', ['n'])).to.deep.equal([]);
	});
});

/**
 * Führt den emittierten Code einer Datei aus, ohne Dateizugriff: die Import-Zeile entfällt, die
 * Runtime-Exporte werden stattdessen als Parameter gebunden (wie beim constant folding).
 * Liefert die Definition resultName, ohne sie den export default.
 */
function runEmitted(code: string, resultName?: string): unknown {
	const parsed = parseCode(code, 'dummy.jul');
	checkTypes(parsed, {}, { cloneUnchecked: true });
	expect(parsed.checked?.errors).to.deep.equal([]);
	const compiled = syntaxTreeToJs(parsed.checked!.expressions!, '');
	const body = withoutImports(compiled)
		.replaceAll(/^export const /gm, 'const ')
		.replace(/^export default /m, 'return ')
		+ (resultName ? `\nreturn ${resultName};` : '');
	const runtimeNames = Object.keys(runtime);
	return new Function(...runtimeNames, body)(...runtimeNames.map(name => (runtime as { [name: string]: unknown; })[name]));
}

function emitChecked(code: string): string {
	const parsed = parseCode(code, 'dummy.jul');
	checkTypes(parsed, {}, { cloneUnchecked: true });
	expect(parsed.checked?.errors).to.deep.equal([]);
	return withoutImports(syntaxTreeToJs(parsed.checked!.expressions!, ''));
}

const expectEmitChecked = reportAtCaller((code: string, result: string) => {
	expect(emitChecked(code)).to.equal(result);
});

describe('Emitter and/or kurzschließend', () => {
	it('and mit mehreren Argumenten wird zu &&', () => {
		expectEmitChecked(
			'x = true\ny = false\nz = true\nresult = and(x y z)',
			'export const x = true;\nexport const y = false;\nexport const z = true;\nexport const result = x && y && z;',
		);
	});
	it('or mit mehreren Argumenten wird zu ||', () => {
		expectEmitChecked(
			'x = true\ny = false\nresult = or(x y)',
			'export const x = true;\nexport const y = false;\nexport const result = x || y;',
		);
	});
	it('verschachtelte Aufrufe werden geklammert', () => {
		expectEmitChecked(
			'x = true\ny = false\nresult = and(x or(y x))',
			'export const x = true;\nexport const y = false;\nexport const result = x && (y || x);',
		);
	});
	it('and mit Spread bleibt ein Funktionsaufruf', () => {
		const js = emitChecked('list = [true false]\nresult = and(...list)');
		expect(js).to.not.contain('&&');
	});
	it('and liefert weiterhin das richtige Ergebnis', () => {
		expect(runEmitted('x = true\ny = false\nresult = and(x y)', 'result')).to.equal(false);
	});
});

describe('Emitter Ausführung', () => {
	it('mapDictionary bildet jeden Wert mit seinem Schlüssel ab', () => {
		const code = [
			'd = [a = 1 b = 2]',
			'result = d.mapDictionary((value key) => §§(key)§(value)§)',
		].join('\n');
		expect(runEmitted(code, 'result')).to.deep.equal({ a: 'a1', b: 'b2' });
	});
	it('mapDictionary über Empty liefert Empty', () => {
		const code = [
			'f = (d: Or([] Dictionary(Integer))) => d.mapDictionary((value) => value)',
			'result = f([])',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(undefined);
	});
	it('findField liefert den passenden Wert', () => {
		const code = [
			'd = [a = 1 b = 2 c = 3]',
			'result = d.findField((value key) => value.greater(2))',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(3n);
	});
	it('findField reicht den Schlüssel an das Prädikat', () => {
		const code = [
			'd = [a = 1 b = 2]',
			'result = d.findField((value key) => key.equal(§b§))',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(2n);
	});
	it('findField über Empty liefert Empty', () => {
		const code = [
			'f = (d: Or([] Dictionary(Integer))) => d.findField((value) => value.greater(1))',
			'result = f([])',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(undefined);
	});
	it('findKey liefert den Schlüssel des passenden Werts', () => {
		const code = [
			'd = [a = 1 b = 2 c = 3]',
			'result = d.findKey((value key) => value.equal(2))',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal('b');
	});
	it('findKey ohne Treffer liefert Empty', () => {
		const code = [
			'd = [a = 1 b = 2]',
			'result = d.findKey((value key) => value.greater(5))',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(undefined);
	});
	it('findKey über Empty liefert Empty', () => {
		const code = [
			'f = (d: Or([] Dictionary(Integer))) => d.findKey((value) => value.greater(1))',
			'result = f([])',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(undefined);
	});
	// Die Selbstreferenz steht in einer Kollektion und ist damit produktiv, der Checker lässt sie
	// durch. Zur Laufzeit darf sie dann nicht vor der fertigen Definition ausgewertet werden.
	it('ein rekursiver Typ lässt sich laden', () => {
		expect(() => runEmitted('Node = [value: Integer children?: List(Node)]')).to.not.throw();
	});
	// Die Elemente von children werden gegen die Selbstreferenz geprüft, sie wird also aufgelöst.
	it('ein verschachtelter Wert besteht die Prüfung gegen einen rekursiven Typ', () => {
		const code = [
			'Node = [value: Integer children?: List(Node)]',
			'f = (node: Node) => node/value',
			'result = f([value = 1 children = [[value = 2 children = [[value = 3]]]]])',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(1n);
	});
	// Der Aufruf Tree(T) im eigenen Rumpf darf erst beim Prüfen ausgewertet werden, sonst ruft
	// jeder Aufruf von Tree sofort den nächsten auf.
	it('ein verschachtelter Wert besteht die Prüfung gegen eine rekursive Typfunktion', () => {
		const code = [
			'Tree = (T: Type) => [value: T children?: List(Tree(T))]',
			'f = (tree: Tree(Integer)) => tree/value',
			'result = f([value = 1 children = [[value = 2 children = [[value = 3]]]]])',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(1n);
	});
	// Ein Datentupel ist geschlossen: [Integer] als Typ trifft
	// nur ein Array mit genau einem Element.
	it('ein Tupeltyp als Kopf trifft kein längeres Array', () => {
		const code = [
			'f = (x: Any) =>',
			'	?(x)',
			'		[[Integer]] => 1',
			'		() => 2',
			'result = f([1 2])',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(2n);
	});
	it('ein Tupeltyp als Kopf trifft ein Array mit genau so vielen Elementen', () => {
		const code = [
			'f = (x: Any) =>',
			'	?(x)',
			'		[[Integer]] => 1',
			'		() => 2',
			'result = f([1])',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(1n);
	});
	// Ein Kopf ist dagegen eine Parameterliste: Er prüft die Positionen, die er nennt, und lässt
	// weitere Operanden zu.
	it('ein Kopf mit weniger Positionen als Operanden trifft', () => {
		const code = [
			'f = (a: Any b: Any) =>',
			'	?(a b)',
			'		[Integer] => 1',
			'		() => 2',
			'result = f(1 §x§)',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(1n);
	});
	it('ein Kopf mit weniger Positionen als Operanden prüft die genannte Position', () => {
		const code = [
			'f = (a: Any b: Any) =>',
			'	?(a b)',
			'		[Integer] => 1',
			'		() => 2',
			'result = f(§x§ 1)',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(2n);
	});
});

describe('Emitter Tail-Call-Optimierung', () => {
	it('ein Selbstaufruf in Tail-Position wird zur Schleife', () => {
		expectBranchingEmit(`f = (n: Integer sum: Integer) =>
	?(n)
		[0] => sum
		() => f(subtract(n 1) add(sum n))`, `
		while (true) {
			if (n === 0n) {
				return sum
			} else {
				;[n, sum] = [subtract(
						n,
						1n,
					), add(
						sum,
						n,
					)];
				continue;
			}
		}`);
	});
	it('die Rekursion überläuft den Stack nicht', () => {
		const code = [
			'f = (n: Integer sum: Integer) =>',
			'\t?(n)',
			'\t\t[0] => sum',
			'\t\t() => f(subtract(n 1) add(sum n))',
			'result = f(200000 0)',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(20000100000n);
	});
	it('ein einzelner Parameter wird ohne Array zugewiesen', () => {
		const code = [
			'f = (n: Integer) =>',
			'\t?(n)',
			'\t\t[0] => 0',
			'\t\t() => f(subtract(n 1))',
			'result = f(200000)',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(0n);
	});
	it('ein Aufruf außerhalb der Tail-Position bleibt Rekursion', () => {
		expect(emitCheckedFunctionBody(`f = (n: Integer) =>
	?(n)
		[0] => 0
		() => add(1 f(subtract(n 1)))`)).to.not.contain('while');
	});
	// Eine Closure sähe sonst die Parameter der Folgeiterationen
	it('eine Closure im Rumpf verhindert die Schleife', () => {
		expect(emitCheckedFunctionBody(`f = (n: Integer g: Any) =>
	?(n)
		[0] => g
		() => f(subtract(n 1) () => n)`)).to.not.contain('while');
	});
});

// Ein Kopf aus einem Listenliteral ist eine Parameterliste ohne Namen (der Checker gibt ihm den Typ
// parameters): Der Emitter schreibt ihn als Positionen unter head. Ein Typ-Kopf beschreibt dagegen
// die ganze Argumentkollektion und bleibt unter type, auch wenn er ein Tupeltyp ist: Ein Alias
// auf ein Tupel ist zur Laufzeit ein Array wie das Listenliteral.
describe('Emitter: Kopf aus Positionen', () => {
	it('Listenliteral als Kopf steht unter head', () => {
		const js = emitChecked('f = [Integer] => 1');
		expect(js).to.contain('head: [Integer]');
		expect(js).not.to.contain('type: [Integer]');
	});
	it('Listenliteral als Kopf eines Branch-Arms steht unter head', () => {
		const js = emitChecked(`f = (a: Any b: Any) =>
	?(a b)
		[Integer] => 1
		() => 2`);
		expect(js).to.contain('head: [Integer]');
	});
	it('Alias auf ein Tupel als Kopf bleibt ein Typ-Kopf', () => {
		const js = emitChecked(`Pair = [Integer Integer]
f = Pair => 1`);
		expect(js).to.contain('type: Pair');
		expect(js).not.to.contain('head:');
	});
	it('Any als Kopf bleibt ein Typ-Kopf', () => {
		const js = emitChecked('f = Any => 1');
		expect(js).to.contain('type: Any');
		expect(js).not.to.contain('head:');
	});
});

describe('Emitter: params nur, wo die Laufzeit sie liest', () => {
	const emitUnchecked = (code: string): string =>
		withoutImports(syntaxTreeToJs(parseCode(code, 'dummy.jul').unchecked.expressions!, ''));

	it('Funktionsliteral ohne Typen ist ein nacktes Arrow', () => {
		expect(emitUnchecked('f = (x) => x')).not.to.contain('_createFunction');
	});
	it('verschachtelter Callback ohne Typen ist ein nacktes Arrow', () => {
		const js = emitUnchecked(`f = (x) =>
	map(x (value) => value)`);
		expect(js).not.to.contain('_createFunction');
		expect(js).not.to.contain('singleNames');
	});
	it('Parametertyp: die Parameterliste bleibt', () => {
		const js = emitUnchecked('f = (x: Integer) => x');
		expect(js).to.contain('_createFunction');
		expect(js).to.contain('type: Integer');
	});
	it('verschachtelter Callback mit Parametertyp behält die Parameterliste', () => {
		const js = emitUnchecked(`f = (x) =>
	map(x (value: Integer) => value)`);
		expect(js).to.contain('_createFunction');
		expect(js).to.contain('type: Integer');
	});
	it('Typ-Kopf: die Parameterliste bleibt', () => {
		expect(emitUnchecked('Any => []')).to.contain('{type: Any}');
	});
	it('Typ eines Rest-Parameters: die Parameterliste bleibt', () => {
		const js = emitUnchecked('f = (...rest: List(Integer)) => rest');
		expect(js).to.contain('_createFunction');
	});
	it('Branch in _branch behält die Parameterliste auch ohne Typen', () => {
		const js = emitUnchecked(`?(4)
	(a) => log(a)
	(b) => log(b)`);
		expect(js.match(/_createFunction/g)).to.have.length(2);
	});
	it('constant folding emittiert weiter mit _createFunction', () => {
		const parsed = parseCode('f = (x) => x', 'dummy.jul');
		const literal = (parsed.unchecked.expressions![0] as ParseSingleDefinition).value as ParseFunctionLiteral;
		expect(functionLiteralToEvaluableJs(literal)).to.contain('_createFunction');
	});
});

describe('Emitter exists als Schleife', () => {
	const listOf3 = 'values = [1 2 3]';
	it('ein Treffer liefert true', () => {
		expect(runEmitted(`${listOf3}\nresult = exists(values (value) => equal(value 2))`, 'result')).to.equal(true);
	});
	it('kein Treffer liefert false', () => {
		expect(runEmitted(`${listOf3}\nresult = exists(values (value) => equal(value 9))`, 'result')).to.equal(false);
	});
	it('Empty liefert false', () => {
		const code = [
			'f = (values: Or([] List(Integer))) => values.exists((value) => true)',
			'result = f([])',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(false);
	});
	it('die Schreibweise mit Präfix wird ebenfalls zur Schleife', () => {
		const code = `${listOf3}\nresult = values.exists((value) => equal(value 3))`;
		expect(emitChecked(code)).to.contain('_listValues');
		expect(runEmitted(code, 'result')).to.equal(true);
	});
	it('der Index ist 1-basiert und wird nur mit zweitem Parameter gebildet', () => {
		const withIndex = `${listOf3}\nresult = exists(values (value index) => equal(index 3))`;
		expect(emitChecked(withIndex)).to.contain('BigInt(_listIndex + 1)');
		expect(runEmitted(withIndex, 'result')).to.equal(true);
		const withoutIndex = `${listOf3}\nresult = exists(values (value) => equal(value 3))`;
		expect(emitChecked(withoutIndex)).to.not.contain('BigInt');
	});
	it('der Rumpf darf mehrere Anweisungen haben', () => {
		const code = [
			listOf3,
			'result = exists(',
			'	values',
			'	(value) =>',
			'		doubled = add(value value)',
			'		equal(doubled 6)',
			')',
		].join('\n');
		expect(emitChecked(code)).to.contain('_listValues');
		expect(runEmitted(code, 'result')).to.equal(true);
	});
	it('der Callback sieht Werte der Umgebung', () => {
		const code = [
			'f = (values: List(Integer) limit: Integer) => values.exists((value) => greater(value limit))',
			'result = and(f([1 2 3] 2) not(f([1 2 3] 3)))',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(true);
	});
	it('verschachtelte exists', () => {
		const code = [
			'hasFour = (values: List(Integer)) => exists(values (value) => equal(value 4))',
			'result = exists([[1 2] [3 4]] (value) => hasFour(value))',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(true);
	});
	it('ein Callback als Wert bleibt ein Funktionsaufruf', () => {
		const code = `${listOf3}\nisTwo = (value) => equal(value 2)\nresult = exists(values isTwo)`;
		const js = emitChecked(code);
		expect(js).to.not.contain('_listValues');
		expect(runEmitted(code, 'result')).to.equal(true);
	});
	it('ein Callback mit Typ-Guard bleibt ein Funktionsaufruf', () => {
		const code = `${listOf3}\nresult = exists(values (value: Integer) => equal(value 2))`;
		expect(emitChecked(code)).to.not.contain('_listValues');
		expect(runEmitted(code, 'result')).to.equal(true);
	});
});

describe('Emitter filter, map und filterMap als Schleife', () => {
	const listOf3 = 'values = [1 2 3]';
	const expectLoop = (code: string) => {
		expect(emitChecked(code)).to.contain('_listValues');
	};
	it('filter behält die passenden Elemente', () => {
		const code = `${listOf3}\nresult = filter(values (value) => greater(value 1))`;
		expectLoop(code);
		expect(runEmitted(code, 'result')).to.deep.equal([2n, 3n]);
	});
	it('filter ohne Treffer liefert Empty', () => {
		const code = `${listOf3}\nresult = filter(values (value) => greater(value 9))`;
		expect(runEmitted(code, 'result')).to.equal(undefined);
	});
	it('filter über Empty liefert Empty', () => {
		const code = [
			'f = (values: Or([] List(Integer))) => values.filter((value) => true)',
			'result = f([])',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(undefined);
	});
	it('filter reicht den 1-basierten Index', () => {
		const code = `${listOf3}\nresult = filter(values (value index) => greater(index 1))`;
		expectLoop(code);
		expect(runEmitted(code, 'result')).to.deep.equal([2n, 3n]);
	});
	it('map bildet jedes Element ab', () => {
		const code = `${listOf3}\nresult = values.map((value) => add(value 10))`;
		expectLoop(code);
		expect(runEmitted(code, 'result')).to.deep.equal([11n, 12n, 13n]);
	});
	it('map reicht den 1-basierten Index', () => {
		const code = `${listOf3}\nresult = map(values (value index) => add(value index))`;
		expect(runEmitted(code, 'result')).to.deep.equal([2n, 4n, 6n]);
	});
	it('map über Empty liefert Empty', () => {
		const code = [
			'f = (values: Or([] List(Integer))) => values.map((value) => value)',
			'result = f([])',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(undefined);
	});
	it('filterMap lässt Empty-Ergebnisse weg', () => {
		const code = [
			'f = (values: List(Or([] Integer))) => filterMap(values (value) => value)',
			'result = f([[] 5 [] 7])',
		].join('\n');
		expect(emitChecked(code)).to.contain('_listValues');
		expect(runEmitted(code, 'result')).to.deep.equal([5n, 7n]);
	});
	it('ein Callback als Wert bleibt ein Funktionsaufruf', () => {
		const code = `${listOf3}\ninc = (value) => add(value 1)\nresult = map(values inc)`;
		expect(emitChecked(code)).to.not.contain('_listValues');
		expect(runEmitted(code, 'result')).to.deep.equal([2n, 3n, 4n]);
	});
	it('verkettete Aufrufe bleiben richtig geordnet', () => {
		const code = `${listOf3}\nresult = values.filter((value) => greater(value 1)).map((value) => add(value 10))`;
		expect(runEmitted(code, 'result')).to.deep.equal([12n, 13n]);
	});
});

describe('Emitter all, findFirst und aggregate als Schleife', () => {
	const listOf3 = 'values = [1 2 3]';
	const expectLoop = (code: string) => {
		expect(emitChecked(code)).to.contain('_listValues');
	};
	it('all ist true, wenn jedes Element passt', () => {
		const code = `${listOf3}\nresult = all(values (value) => greater(value 0))`;
		expectLoop(code);
		expect(runEmitted(code, 'result')).to.equal(true);
	});
	it('all ist false, sobald ein Element nicht passt', () => {
		const code = `${listOf3}\nresult = all(values (value) => greater(value 1))`;
		expect(runEmitted(code, 'result')).to.equal(false);
	});
	it('all über Empty ist true', () => {
		const code = [
			'f = (values: Or([] List(Integer))) => values.all((value) => false)',
			'result = f([])',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(true);
	});
	it('all reicht den 1-basierten Index', () => {
		const code = `${listOf3}\nresult = all(values (value index) => equal(value index))`;
		expect(runEmitted(code, 'result')).to.equal(true);
	});
	it('findFirst liefert das erste passende Element', () => {
		const code = `${listOf3}\nresult = findFirst(values (value) => greater(value 1))`;
		expectLoop(code);
		expect(runEmitted(code, 'result')).to.equal(2n);
	});
	it('findFirst ohne Treffer liefert Empty', () => {
		const code = `${listOf3}\nresult = findFirst(values (value) => greater(value 9))`;
		expect(runEmitted(code, 'result')).to.equal(undefined);
	});
	it('findFirst über Empty liefert Empty', () => {
		const code = [
			'f = (values: Or([] List(Integer))) => values.findFirst((value) => true)',
			'result = f([])',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(undefined);
	});
	it('aggregate summiert mit Startwert', () => {
		const code = `${listOf3}\nresult = values.aggregate(Integer 10 (accumulator value) => add(accumulator value))`;
		expectLoop(code);
		expect(runEmitted(code, 'result')).to.equal(16n);
	});
	it('aggregate reicht den 1-basierten Index', () => {
		const code = `${listOf3}\nresult = aggregate(values Integer 0 (accumulator value index) => add(accumulator index))`;
		expect(runEmitted(code, 'result')).to.equal(6n);
	});
	it('aggregate über Empty liefert den Startwert', () => {
		const code = [
			'f = (values: Or([] List(Integer))) => values.aggregate(Integer 7 (accumulator value) => add(accumulator value))',
			'result = f([])',
		].join('\n');
		expect(runEmitted(code, 'result')).to.equal(7n);
	});
	it('aggregate mit einem Parameter sieht nur den Akkumulator', () => {
		const code = `${listOf3}\nresult = values.aggregate(Integer 0 (accumulator) => add(accumulator 2))`;
		expect(runEmitted(code, 'result')).to.equal(6n);
	});
	it('aggregate mit Callback als Wert bleibt ein Funktionsaufruf', () => {
		const code = `${listOf3}\nsum = (accumulator value) => add(accumulator value)\nresult = values.aggregate(Rational 0 sum)`;
		expect(emitChecked(code)).to.not.contain('_listValues');
		expect(runEmitted(code, 'result')).to.equal(6n);
	});
});

describe('Emitter untypisiertes JSON', () => {
	function evaluateDefaultExport(js: string): unknown {
		return new Function(`return ${js.replace(/^export default /, '')}`)();
	}

	// Der Baum ist die Referenz: die untypisierte Datei muss zur Laufzeit dieselben Werte liefern.
	const expectSameValue = reportAtCaller((json: string) => {
		const fromTree = syntaxTreeToJs(parseCode(json, 'data.json').unchecked.expressions!, '', 'data.json');
		const untyped = parseCode(json, 'data.json', true);
		expect(untyped.unchecked.expressions).to.equal(undefined);
		const direct = jsonValueToJs(untyped.jsonValue);
		expect(evaluateDefaultExport(direct)).to.deep.equal(evaluateDefaultExport(fromTree));
	});

	it('Integer', () => {
		expectSameValue('5');
	});
	it('großer Integer bleibt exakt', () => {
		expectSameValue('[12345678901234567890]');
	});
	it('Bruch und Exponent', () => {
		expectSameValue('[0.1, 1.50, 1e3, -2.5e-2]');
	});
	it('Text mit Anführungszeichen, Umbruch, Backtick und Backslash', () => {
		expectSameValue(JSON.stringify(['a"b', 'x' + String.fromCharCode(10) + 'y', '`', String.fromCharCode(92)]));
	});
	it('Text mit Platzhalter-Syntax bleibt Text', () => {
		const text = '$' + '{x}';
		const untyped = parseCode(JSON.stringify([text]), 'data.json', true);
		expect(evaluateDefaultExport(jsonValueToJs(untyped.jsonValue))).to.deep.equal([text]);
	});
	it('true, false, null', () => {
		expectSameValue('[true, false, null]');
	});
	it('leere Liste und leeres Objekt', () => {
		expectSameValue('{"a": [], "b": {}, "c": [[]]}');
	});
	it('verschachtelt', () => {
		expectSameValue('{"a": {"b": [1, {"c": "d"}]}, "e": [true]}');
	});
	it('ungültiges JSON meldet weiter invalidJson', () => {
		const untyped = parseCode('[1,', 'data.json', true);
		expect(untyped.unchecked.errors.map(error => error.code)).to.deep.equal([ErrorCode.invalidJson]);
	});
});
