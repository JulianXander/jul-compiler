"use strict";
exports.__esModule = true;
exports._import = exports.log = exports._createFunction = exports._checkType = exports._callFunction = exports._branch = void 0;
//#region internals
function _branch(value, branches) {
    // TODO collect inner Errors?
    for (var _i = 0, branches_1 = branches; _i < branches_1.length; _i++) {
        var branch = branches_1[_i];
        var assignedParams = tryAssignParams(value, branch.params);
        if (!(assignedParams instanceof Error)) {
            return branch(assignedParams);
        }
    }
    return new Error(value + " did not match any branch");
}
exports._branch = _branch;
function _callFunction(fn, args) {
    var assignedParams = tryAssignParams(args, fn.params);
    if (assignedParams instanceof Error) {
        return assignedParams;
    }
    return fn.apply(void 0, assignedParams);
}
exports._callFunction = _callFunction;
function _checkType(type, value) {
    return type(value)
        ? value
        : new Error(value + " is not of type " + type);
}
exports._checkType = _checkType;
function _createFunction(fn, params) {
    var julFn = fn;
    julFn.params = params;
    return julFn;
}
exports._createFunction = _createFunction;
//#endregion internals
function tryAssignParams(values, params) {
    var assigneds = [];
    var singleNames = params.singleNames, rest = params.rest;
    var isArray = Array.isArray(values);
    var index = 0;
    if (singleNames) {
        for (; index < singleNames.length; index++) {
            var param = singleNames[index];
            var name_1 = param.name, type = param.type;
            var value = isArray
                ? values[index]
                : values[name_1];
            var isValid = type
                ? type(value)
                : true;
            if (!isValid) {
                return new Error("Can not assigne the value " + value + " to param " + name_1 + " because it is not of type " + type);
            }
            assigneds.push(value);
        }
    }
    if (rest) {
        var restType = rest.type;
        if (isArray) {
            for (; index < values.length; index++) {
                var value = values[index];
                var isValid = restType
                    ? restType(value)
                    : true;
                if (!isValid) {
                    return new Error("Can not assigne the value " + value + " to rest param because it is not of type " + rest);
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
exports.log = _createFunction(console.log, { rest: {} });
exports._import = _createFunction(require, {
    singleNames: [{
            name: 'path',
            type: function (x) { return typeof x === 'string'; }
        }]
});
// TODO
//#endregion builtins
