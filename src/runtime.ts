type Type = (value: any) => boolean

interface Params {
	singleNames?: {
		name: string;
		type: Type;
	}[];
	rest?: Type;
}

type JulFunction = Function & { params: Params };

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
	return fn(assignedParams);
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

function tryAssignParams(value: any, params: Params): any[] | Error {
	const assigned = [];
	// TODO
	params.singleNames.forEach(param => {

	});
	return assigned;
}