import { mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

export function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}

//#region Array

export type NonEmptyArray<T> = [T, ...T[]];

export function isNonEmpty<T>(array: T[]): array is NonEmptyArray<T> {
	return !!array.length;
}

export function findMap<T, U>(
	values: T[],
	fn: (value: T, index: number) => U | undefined,
): U | undefined {
	for (let index = 0; index < values.length; index++) {
		const value = values[index]!;
		const mapped = fn(value, index);
		if (mapped !== undefined) {
			return mapped;
		}
	}
}

export function last<T>(array: NonEmptyArray<T>): T;
export function last<T>(array: ArrayLike<T>): T | undefined;
export function last<T>(array: ArrayLike<T>): T | undefined {
	return array[array.length - 1];
}

export function mapNonEmpty<T, U>(array: NonEmptyArray<T>, fn: (element: T) => U): NonEmptyArray<U> {
	return array.map(fn) as NonEmptyArray<U>;
}

export function toDictionary<T, U>(
	values: T[],
	getKey: (value: T) => string,
	getValue: (value: T) => U,
): { [key: string]: U; } {
	const dictionary: { [key: string]: U; } = {};
	values.forEach(oldValue => {
		const key = getKey(oldValue);
		const newValue = getValue(oldValue);
		dictionary[key] = newValue;
	});
	return dictionary;
}

//#endregion Array

//#region Dictionary

export function forEach<T>(
	dictionary: { [key: string]: T; },
	iterator: (value: T, key: string) => void,
): void {
	for (const key in dictionary) {
		const element = dictionary[key]!;
		iterator(element, key);
	}
}

export function map<T, U>(
	dictionary: { [key: string]: T; },
	mapFn: (value: T, key: string) => U,
): U[] {
	const mapped: U[] = [];
	for (const key in dictionary) {
		const element = dictionary[key]!;
		mapped.push(mapFn(element, key));
	}
	return mapped;
}

export function mapDictionary<T, U>(
	dictionary: { [key: string]: T; },
	mapFn: (value: T, key: string) => U,
): { [key: string]: U; } {
	const mapped: { [key: string]: U; } = {};
	for (const key in dictionary) {
		const element = dictionary[key]!;
		mapped[key] = (mapFn(element, key));
	}
	return mapped;
}

//#endregion Dictionary

// function mapFn<Args extends any[], Result1, Result2>(
// 	fn: (...args: Args) => Result1,
// 	transform: (result1: Result1) => Result2,
// ): (...args: Args) => Result2 {
// 	return (...args) => {
// 		const result1 = fn(...args);
// 		const result2 = transform(result1);
// 		return result2;
// 	};
// }

//#region file system

export const executingDirectory = dirname(fileURLToPath(import.meta.url));

//#region extension

export enum Extension {
	js = '.js',
	json = '.json',
	jul = '.jul',
	ts = '.ts',
	yaml = '.yaml',
}

export function isValidExtension(extension: string): extension is Extension {
	switch (extension) {
		case Extension.js:
		case Extension.json:
		case Extension.jul:
		case Extension.ts:
		case Extension.yaml:
			return true;
		default:
			return false;
	}
}

export function removeExtension(path: string): string {
	return path.replace(/\.[^/.]+$/, '');
}

export function changeExtension(
	path: string,
	/**
	 * inklusive . am Anfang
	 */
	newExtension: string,
): string {
	return removeExtension(path) + newExtension;
}

//#endregion extension

/**
 * @throws Wirft Error wenn Datei nicht gelesen werden kann.
 */
export function readTextFile(path: string): string {
	const file = readFileSync(path);
	const text = file.toString();
	return text;
}

export function tryReadTextFile(path: string): string | undefined {
	try {
		return readTextFile(path);
	}
	catch (error) {
		console.error(error);
		return undefined;
	}
}

export function tryCreateDirectory(path: string): void {
	mkdirSync(path, { recursive: true });
}

//#endregion file system