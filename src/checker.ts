import { SymbolTable } from './syntax-tree';

export const builtInSymbols: SymbolTable = {
	//#region Number
	// TODO subtract, sum
	//#endregion Number
	//#region Stream
	//#region core
	complete: {
		type: 'TODO' as any,
		description: 'Beendet den Stream. Es werden keine Events mehr ausgelöst, alle Listener werden deregistiert und es werden keine mehr hinzugefügt. Löst onCompleted Event aus.',
	},
	subscribe: {
		type: 'TODO' as any,
		description: 'Registriert den listener auf die Events des Streams',
	},
	//#endregion core
	//#region create
	timer$: {
		type: 'TODO' as any,
		description: 'Emittiert alle delayMs einen um 1 inkrementierenden Zähler, beginnend mit 1',
	},
	//#endregion create
	//#endregion Stream
};