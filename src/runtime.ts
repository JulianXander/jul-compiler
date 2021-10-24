type Type = (value: any) => boolean

interface Params {
	singleNames?: {
		name: string;
		type?: Type;
	}[];
	rest?: {
		type?: Type
	};
}

type JulFunction = Function & { params: Params };

//#region internals

export function _branch(value: any, branches: JulFunction[]) {
	// TODO collect inner Errors?
	for (const branch of branches) {
		const assignedParams = tryAssignParams(value, branch.params);
		if (!(assignedParams instanceof Error)) {
			return branch(assignedParams);
		}
	}
	return new Error(`${value} did not match any branch`);
}

export function _callFunction(fn: JulFunction, args: any) {
	const assignedParams = tryAssignParams(args, fn.params);
	if (assignedParams instanceof Error) {
		return assignedParams;
	}
	return fn(...assignedParams);
}

export function _checkType(type: Type, value: any) {
	return type(value)
		? value
		: new Error(`${value} is not of type ${type}`);
}

export function _createFunction(fn: Function, params: Params): JulFunction {
	const julFn = fn as JulFunction;
	julFn.params = params;
	return julFn;
}

//#endregion internals

function tryAssignParams(values: any[] | { [key: string]: any }, params: Params): any[] | Error {
	const assigneds: any[] = [];
	const { singleNames, rest } = params;
	const isArray = Array.isArray(values);
	let index = 0;
	if (singleNames) {
		for (; index < singleNames.length; index++) {
			const param = singleNames[index]!;
			const { name, type } = param;
			const value = isArray
				? values[index]
				: values[name];
			const isValid = type
				? type(value)
				: true;
			if (!isValid) {
				return new Error(`Can not assigne the value ${value} to param ${name} because it is not of type ${type}`);
			}
			assigneds.push(value);
		}
	}
	if (rest) {
		const restType = rest.type;
		if (isArray) {
			for (; index < values.length; index++) {
				const value = values[index];
				const isValid = restType
					? restType(value)
					: true;
				if (!isValid) {
					return new Error(`Can not assigne the value ${value} to rest param because it is not of type ${rest}`);
				}
				assigneds.push(value);
			}
		}
		else {
			// TODO rest dictionary??
			throw new Error('tryAssignParams not implemented yet for rest dictionary');
		}
	}
	return assigneds;
}

// TODO toString

//#region builtins

export const log = _createFunction(console.log, { rest: {} });
// export const _import = _createFunction(require, {
// 	singleNames: [{
// 		name: 'path',
// 		type: (x) => typeof x === 'string'
// 	}]
// });

// TODO

//#endregion builtins