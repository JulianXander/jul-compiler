/**
 * Kleine Quelltexte, die Muster großer JUL-Projekte nachbilden, an denen der Checker bisher
 * gebrochen ist. Das Zähler-Gate (checker-snapshot.test.ts) hält ihre Arbeit fest: Ein neuer
 * Ausreißer zeigt sich dort als Zahlensprung, nicht erst in der Laufzeit eines großen Projekts.
 */

/**
 * Spielzustand wie in yugioh: eine Union aus Dictionaries über einer gemeinsamen Basis mit
 * Literal-Diskriminator (status), Tagged Union als Eingabe, Spread mit überschriebenem Feld,
 * Branching mit Verengung auf Feldpfaden und eine rekursive Funktion ohne deklarierten Rückgabetyp.
 */
export const stateMachineFixture = `Phase = Or(§draw§ §standby§ §main1§ §battle§ §main2§ §end§)
CardId = PositiveInteger
Board = [
	hand: List(CardId)
	field: List(CardId)
	graveyard: List(CardId)
	lifePoints: Integer
]
ActivateInput = [
	type: §activate§
	gameCardId: CardId
	targets: [
		gameCardIds: Or([] List(CardId))
	]
]
AttackInput = [
	type: §attack§
	gameCardId: CardId
	targets: [
		attackedGameCardId: Or([] CardId)
	]
]
NormalInput = [
	type: §normal§
	gameCardId: CardId
]
SetInput = [
	type: §set§
	gameCardId: CardId
]
PassInput = [
	type: §pass§
]
SelectInput = [
	type: §select§
	targets: [
		gameCardIds: Or([] List(CardId))
	]
]
SynchroInput = [
	type: §synchro§
	gameCardId: CardId
]
PlayerInput = Or(
	ActivateInput
	AttackInput
	NormalInput
	SetInput
	PassInput
	SelectInput
	SynchroInput
)
GameState = [
	input: Or([] PlayerInput)
	boards: [Board Board]
	cards: List(CardId)
	turnPlayer: Or(1 2)
	priority: Or([] 1 2)
	phase: Phase
	winner: Or([] 1 2 §draw§)
	chain: Or([] List(CardId))
	error: Or([] Text)
]
GameHistory = [
	gameStates: List(GameState)
]
UiBase = [
	history: GameHistory
	activeGameCardId: Or([] CardId)
	passUntilPhase: Or([] Phase)
	player1Name: Or([] Text)
	player2Name: Or([] Text)
	errorMessage: Or([] Text)
]
UiState = Or(
	[
		...UiBase
		status: []
	]
	[
		...UiBase
		status: Or(§activationTargets§ §activationCost§)
		selectedGameCardIds: Or([] List(CardId))
	]
	[
		...UiBase
		status: §attackTarget§
		attackerGameCardId: CardId
	]
	[
		...UiBase
		status: Or(§tributeSummon§ §tributeSet§)
		tributingForGameCardId: CardId
	]
	[
		...UiBase
		status: §synchroSummon§
		synchroGameCardId: CardId
	]
	[
		...UiBase
		status: §select§
		selectedGameCardIds: Or([] List(CardId))
	]
)
getCurrentGameState = (history: GameHistory) :> GameState =>
	lastElement(history/gameStates)
withNewHistory = (uiState: UiState newHistory: GameHistory) :> UiState =>
	oldPassUntilPhase = uiState/passUntilPhase
	gameState = getCurrentGameState(newHistory)
	newUiState1: UiState = [
		...uiState
		history = newHistory
	]
	newPassUntilPhase = ?(oldPassUntilPhase)
		[Text] =>
			stopPassing = not(gameState/input.equal([type = §pass§]))
			?(stopPassing)
				[true] => []
				[false] => oldPassUntilPhase
		() => []
	newUiState2: UiState = [
		...newUiState1
		passUntilPhase = newPassUntilPhase
	]
advance = (previousUiState: UiState result: Or([] GameHistory Error)) =>
	uiState = ?(result)
		[Error] =>
			failedUiState: UiState = [
				...previousUiState
				passUntilPhase = []
				errorMessage = result/message
			]
			failedUiState
		[GameHistory] =>
			withNewHistory(previousUiState result)
		() => previousUiState
	currentGameState = getCurrentGameState(uiState/history)
	?(currentGameState/priority)
		[1] =>
			?(uiState/passUntilPhase)
				[Text] =>
					advance(uiState [])
				() => uiState
		[2] =>
			advance(uiState [])
		() => uiState
`;

/**
 * Listen und Tuple: Spreads über mehrere Or([] List(X)), length und Indexzugriffe.
 * Bildet die früheren Ausreißer in concatFromTypes und lengthOf nicht nach (sie sind hier
 * auf keinem alten Stand aufgefallen), deckt die Pfade aber ab.
 */
export const sequenceFixture = `Item = [
	id: PositiveInteger
	name: Text
	tags: Or([] List(Text))
]
Items = Or([] List(Item))
mergeAll = (a: Items b: Items c: Items d: Items e: Items f: Items g: Items h: Items i: Items) =>
	[...a ...b ...c ...d ...e ...f ...g ...h ...i]
mergeSome = (a: Items b: Items c: Items) =>
	[...a ...b ...c]
mergeTags = (item: Item other: Item) =>
	[...item/tags ...other/tags ...item/tags ...other/tags]
lastItem = (items: List(Item)) =>
	getElement(items length(items))
firstTwo = (items: [Item Item Item]) =>
	[getElement(items 1) getElement(items 2)]
countAfter = (items: List(Item) removed: List(Item)) =>
	length([...items ...removed])
pick = (items: List(Item) index: PositiveInteger) =>
	?(index.equal(1))
		[true] => getElement(items 1)
		[false] => lastItem(items)
`;
