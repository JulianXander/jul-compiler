// npx tsc experiments/test-stream.ts
var processId = 1;
//#region util
function deepEquals(value1, value2) {
    var type1 = typeof value1;
    if (type1 !== typeof value2) {
        return false;
    }
    switch (type1) {
        case 'bigint':
        case 'boolean':
        case 'function':
        case 'number':
        case 'string':
        case 'symbol':
        case 'undefined':
            return value1 === value2;
        case 'object':
            if (value1 === null || value2 === null) {
                return value1 === value2;
            }
            else if (value1 instanceof Stream || value2 instanceof Stream) {
                return value1 === value2;
            }
            else if (Array.isArray(value1) || Array.isArray(value2)) {
                if (!Array.isArray(value1)
                    || !Array.isArray(value2)
                    || value1.length !== value2.length) {
                    return false;
                }
                for (var index = 0; index < value1.length; index++) {
                    if (value1[index] !== value2[index]) {
                        return false;
                    }
                }
                return true;
            }
            else {
                for (var key in value1) {
                    if (value1[key] !== value2[key]) {
                        return false;
                    }
                }
                return true;
            }
        default: {
            var assertNever = type1;
            throw new Error('Unexpected type for deepEquals: ' + assertNever);
        }
    }
}
var Stream = /** @class */ (function () {
    function Stream(getValue) {
        this.completed = false;
        this.listeners = [];
        this.onCompletedListeners = [];
        this.getValue = getValue;
    }
    Stream.prototype.push = function (value) {
        if (processId === this.lastProcessId) {
            return;
        }
        if (deepEquals(value, this.lastValue)) {
            return;
        }
        if (this.completed) {
            throw new Error('Can not push to completed stream.');
        }
        this.lastValue = value;
        this.lastProcessId = processId;
        this.listeners.forEach(function (listener) { return listener(value); });
    };
    /**
     * Gibt einen unsubscribe callback zurück.
     * Wertet sofort den listener beim subscriben sofort aus, wenn evaluateOnSubscribe = true.
     */
    Stream.prototype.subscribe = function (listener, evaluateOnSubscribe) {
        var _this = this;
        if (evaluateOnSubscribe === void 0) { evaluateOnSubscribe = true; }
        if (evaluateOnSubscribe) {
            listener(this.getValue());
        }
        if (this.completed) {
            return function () { };
        }
        this.listeners.push(listener);
        return function () {
            if (_this.completed) {
                return;
            }
            var index = _this.listeners.indexOf(listener);
            if (index === -1) {
                throw new Error('Can not unsubscribe listener, because listener was not subscribed.');
            }
            _this.listeners.splice(index, 1);
        };
    };
    Stream.prototype.complete = function () {
        if (this.completed) {
            return;
        }
        this.completed = true;
        // dispose listeners
        this.listeners = [];
        this.onCompletedListeners.forEach(function (onCompletedListener) {
            onCompletedListener();
        });
        this.onCompletedListeners = [];
    };
    /**
     * Wenn der Stream schon completed ist wird der callback sofort aufgerufen.
     */
    Stream.prototype.onCompleted = function (callback) {
        if (this.completed) {
            callback();
        }
        else {
            this.onCompletedListeners.push(callback);
        }
    };
    return Stream;
}());
//#region create
function createSource$(initialValue) {
    var stream$ = new Stream(function () { return stream$.lastValue; });
    stream$.push(initialValue);
    return stream$;
}
function timer$(delayMs) {
    var stream$ = createSource$(1);
    var cycle = function () {
        setTimeout(function () {
            if (stream$.completed) {
                return;
            }
            processId++;
            stream$.push(stream$.lastValue + 1);
            cycle();
        }, delayMs);
    };
    cycle();
    return stream$;
}
function httpRequest$(url, method, body) {
    var abortController = new AbortController();
    var response$ = createSource$(null);
    response$.onCompleted(function () {
        abortController.abort();
    });
    fetch(url, {
        method: method,
        body: body,
        signal: abortController.signal
    }).then(function (response) {
        processId++;
        // console.log('fetch response', response);
        response$.push(response);
    })["catch"](function (error) {
        processId++;
        response$.push(error);
    })["finally"](function () {
        response$.complete();
    });
    return response$;
}
function of$(value) {
    var $ = createSource$(value);
    $.complete();
    return $;
}
//#endregion create
//#region transform
function createDerived$(getValue) {
    return new Stream(getValue);
}
function map$(source$, mapFunction) {
    var lastSourceValue;
    var mapped$ = createDerived$(function () {
        if (processId === mapped$.lastProcessId) {
            return mapped$.lastValue;
        }
        var currentSourceValue = source$.getValue();
        if (deepEquals(currentSourceValue, lastSourceValue)) {
            mapped$.lastProcessId = processId;
            return mapped$.lastValue;
        }
        var currentMappedValue = mapFunction(currentSourceValue);
        lastSourceValue = currentSourceValue;
        mapped$.push(currentMappedValue);
        return currentMappedValue;
    });
    mapped$.onCompleted(function () {
        unsubscribe();
    });
    var unsubscribe = source$.subscribe(function (sourceValue) {
        mapped$.getValue();
    });
    source$.onCompleted(function () {
        mapped$.complete();
    });
    return mapped$;
}
function combine$() {
    var source$s = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        source$s[_i] = arguments[_i];
    }
    var combined$ = createDerived$(function () {
        var lastValues = combined$.lastValue;
        if (combined$.lastProcessId === processId) {
            return lastValues;
        }
        var currentValues = source$s.map(function (source$) {
            return source$.getValue();
        });
        if (deepEquals(currentValues, lastValues)) {
            combined$.lastProcessId = processId;
            return lastValues;
        }
        combined$.push(currentValues);
        return currentValues;
    });
    combined$.onCompleted(function () {
        unsubscribes.forEach(function (unsubscribe, index) {
            unsubscribe();
        });
    });
    var unsubscribes = source$s.map(function (source$, index) {
        source$.onCompleted(function () {
            // combined ist complete, wenn alle Sources complete sind.
            if (!source$s.some(function (source$) { return !source$.completed; })) {
                combined$.complete();
            }
        });
        return source$.subscribe(function (value) {
            combined$.getValue();
        });
    });
    return combined$;
}
function takeUntil$(source$, completed$) {
    var mapped$ = map$(source$, function (x) { return x; });
    var unsubscribeCompleted = completed$.subscribe(function () {
        mapped$.complete();
    }, false);
    completed$.onCompleted(function () {
        mapped$.complete();
    });
    mapped$.onCompleted(function () {
        unsubscribeCompleted();
    });
    return mapped$;
}
function flatMerge$(source$$) {
    var inner$s = [];
    var unsubscribeInners = [];
    var flat$ = createDerived$(function () {
        var lastValue = flat$.lastValue;
        if (processId === flat$.lastProcessId) {
            return lastValue;
        }
        var currentValue = source$$.getValue().getValue();
        if (deepEquals(currentValue, lastValue)) {
            flat$.lastProcessId = processId;
            return lastValue;
        }
        flat$.push(currentValue);
        return currentValue;
    });
    var unsubscribeOuter = source$$.subscribe(function (source$) {
        inner$s.push(source$);
        var unsubscribeInner = source$.subscribe(function (value) {
            flat$.getValue();
        });
        unsubscribeInners.push(unsubscribeInner);
    });
    flat$.onCompleted(function () {
        unsubscribeOuter();
        unsubscribeInners.forEach(function (unsubscribeInner) {
            unsubscribeInner();
        });
    });
    // flat ist complete, wenn outerSource und alle innerSources complete sind
    source$$.onCompleted(function () {
        inner$s.forEach(function (inner$) {
            inner$.onCompleted(function () {
                if (!inner$s.some(function (source$) { return !source$.completed; })) {
                    flat$.complete();
                }
            });
        });
    });
    return flat$;
}
function flatSwitch$(source$$) {
    var unsubscribeInner;
    var flat$ = createDerived$(function () {
        var lastValue = flat$.lastValue;
        if (processId === flat$.lastProcessId) {
            return lastValue;
        }
        var currentValue = source$$.getValue().getValue();
        if (deepEquals(currentValue, lastValue)) {
            flat$.lastProcessId = processId;
            return lastValue;
        }
        flat$.push(currentValue);
        return currentValue;
    });
    var unsubscribeOuter = source$$.subscribe(function (source$) {
        unsubscribeInner = takeUntil$(source$, source$$).subscribe(function (value) {
            flat$.getValue();
        });
    });
    flat$.onCompleted(function () {
        unsubscribeOuter();
        unsubscribeInner === null || unsubscribeInner === void 0 ? void 0 : unsubscribeInner();
    });
    // flat ist complete, wenn outerSource und die aktuelle innerSource complete sind
    source$$.onCompleted(function () {
        source$$.getValue().onCompleted(function () {
            flat$.complete();
        });
    });
    return flat$;
}
// TODO
// function flatMap
function retry$(method$, maxAttepmts, currentAttempt) {
    if (currentAttempt === void 0) { currentAttempt = 1; }
    if (currentAttempt === maxAttepmts) {
        return method$();
    }
    var withRetry$$ = map$(method$(), function (result) {
        if (result instanceof Error) {
            console.log('Error! Retrying... Attempt:', currentAttempt, 'process:', processId);
            return retry$(method$, maxAttepmts, currentAttempt + 1);
        }
        return of$(result);
    });
    return flatSwitch$(withRetry$$);
}
;
//#endregion transform
//#endregion Stream
//#region example
// {
// 	const source$ = timer$(2000);
// 	source$.subscribe(x => {
// 		console.log('source$', x, 'process', processId);
// 		// for (let index = 0; index < 1000000; index++) {
// 		// 	let memoryLeakTest$ = timer$(1000);
// 		// 	memoryLeakTest$.subscribe(x => { console.log('noop') });
// 		// }
// 	});
// 	const mapped1$ = map$(source$, count => count % 2);
// 	mapped1$.subscribe(x => console.log('mapped1$', x));
// 	const mapped2$ = map$(source$, count => count % 5);
// 	mapped2$.subscribe(x => console.log('mapped2$', x));
// 	const combined$ = combine$(source$, mapped1$, mapped2$);
// 	combined$.subscribe(x => console.log('combined', x));
// 	combined$.onCompleted(() => console.log('combined complete'));
// 	source$.complete();
// 	mapped2$.complete();
// }
{
    var fetchPage$ = function () { return httpRequest$('https://api.github.com/repos/javascript-tutorial/en.javascript.info/commits', 'GET', undefined); };
    var pageWithRetry$ = retry$(fetchPage$, 3);
    pageWithRetry$.subscribe(function (x) {
        // TODO show loading indicator while x = null
        console.log('source$', x, 'process', processId);
    });
    var element_1 = document.createElement('div');
    element_1.innerText = 'Lade...';
    document.body.appendChild(element_1);
    pageWithRetry$.onCompleted(function () {
        console.log('loading finished');
        document.body.removeChild(element_1);
    });
}
//#endregion example
