export function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}

//#region Array

export type NonEmptyArray<T> = [T, ...T[]];

export function isNonEmpty<T>(array: T[]): array is NonEmptyArray<T> {
	return !!array.length;
}

export function last<T>(array: NonEmptyArray<T>): T;
export function last<T>(array: T[]): T | undefined;
export function last<T>(array: T[]): T | undefined {
	return array[array.length - 1];
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