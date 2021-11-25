import { SymbolTable } from './syntax-tree';

export const builtInSymbols: SymbolTable = {
	//#region Number
	subtract: {
		type: 'TODO' as any,
		description: 'minuend - subtrahend',
		startRowIndex: 0,
		startColumnIndex: 0,
		endRowIndex: 0,
		endColumnIndex: 0,
	},
	sum: {
		type: 'TODO' as any,
		description: 'Addiert die gegebenen Werte',
		startRowIndex: 0,
		startColumnIndex: 0,
		endRowIndex: 0,
		endColumnIndex: 0,
	},
	//#endregion Number
	//#region Stream
	//#region core
	complete: {
		type: 'TODO' as any,
		description: 'Beendet den Stream. Es werden keine Events mehr ausgelöst, alle Listener werden deregistiert und es werden keine mehr hinzugefügt. Löst onCompleted Event aus.',
		startRowIndex: 0,
		startColumnIndex: 0,
		endRowIndex: 0,
		endColumnIndex: 0,
	},
	subscribe: {
		type: 'TODO' as any,
		description: 'Registriert den listener auf die Events des Streams',
		startRowIndex: 0,
		startColumnIndex: 0,
		endRowIndex: 0,
		endColumnIndex: 0,
	},
	//#endregion core
	//#region create
	timer$: {
		type: 'TODO' as any,
		description: 'Emittiert alle delayMs einen um 1 inkrementierenden Zähler, beginnend mit 1',
		startRowIndex: 0,
		startColumnIndex: 0,
		endRowIndex: 0,
		endColumnIndex: 0,
	},
	//#endregion create
	//#endregion Stream
	//#region Utility
	runJs: {
		type: 'TODO' as any,
		description: 'Führt den gegebenen String als JavaScript aus und gibt dessen Rückgabe zurück',
		startRowIndex: 0,
		startColumnIndex: 0,
		endRowIndex: 0,
		endColumnIndex: 0,
	},
	//#endregion Utility
};