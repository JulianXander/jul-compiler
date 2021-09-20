type Grammar =
	| Token
	| Sequence
	| Choice
	| Multiplication
	;

interface Token
{
	type: 'token';
	token: string;
}

interface Sequence
{
	type: 'sequence';
	elements: Grammar[];
}

interface Choice
{
	type: 'choice';
	options: Grammar[];
}

interface Multiplication
{
	type: 'multiplication';
	element: Grammar;
	minOccurs: number;
	maxOccurs?: number;
}

const julGrammar: Grammar = {};

const numberRegex = /-?[0-9]+(.[0-9]+)?/
const numberGrammar: Grammar = {
	type: 'sequence',
	elements: [
		{
			type: 'multiplication',
			minOccurs: 0,
			maxOccurs: 1,
			element: {
				type: 'token',
				token: '-',
			}
		},
		{
			type: 'multiplication',
			minOccurs: 1,
			maxOccurs: undefined,
			element: {
				// TODO 0-9
				type: 'token',
				token: '1',
			}
		},
	]
};

const nameRegex = /[a-zA-Z][0-9a-zA-Z]/;

const expressionGrammar: Grammar = {
	type: 'choice',
	options: [
		// TODO
		// NumberLiteral
		// StringLiteral
		// ObjektLiteral
		// FunktionLiteral
		// Referenz
		// Assignment
		// Funktionsaufruf
	]
}

const objectGrammar = (indent: number): Grammar =>
{
	return {
		type: 'choice',
		options: [
			// mit Klammern
			{
				type: 'sequence',
				elements: [
					{
						type: 'token',
						token: '('
					},
					{
						type: 'multiplication',
						minOccurs: 0,
						maxOccurs: undefined,
						element: {}
					},
					{
						type: 'token',
						token: ')'
					}
				]
			}
			// ohne Klammern
		]
	}
}