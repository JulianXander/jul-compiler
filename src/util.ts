export type NonEmptyArray<T> = [T, ...T[]];

export function isNonEmpty<T>(array: T[]): array is NonEmptyArray<T> {
	return !!array.length;
}

export function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}

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