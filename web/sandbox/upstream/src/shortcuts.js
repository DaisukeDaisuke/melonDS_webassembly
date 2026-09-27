export function installGlobalShortcuts(runCommand, target = window) {
    const definitions = [
        ["a", "disassemble", ["address", "count", "before", "mode"], { count: 16, before: 4 }],
        ["A", "disassemble", ["address", "count", "before", "mode"], { count: 16, before: 4, includeBytes: true }],
        ["b", "disassembleBytes", ["input", "mode", "endian"]],
        ["B", "binaryFloat", ["value", "bits", "op"]],
        ["c", "callStack", ["limit"], { limit: 32 }],
        ["C", "getOtherCoroutines", ["stackId", "limit"], { limit: 32 }],
        ["d", "status", []],
        ["D", "dumpMemory", ["address", "length", "view"], { length: 64 }],
        ["e", "getRegisters", ["cpu"]],
        ["E", "eval", ["code", "timeoutMs"]],
        ["f", "step", ["count"], { count: 1 }],
        ["F", "stepFrames", ["frames"], { frames: 1 }],
        ["g", "smartStep", []],
        ["G", "setRegister", ["register", "value", "cpu"]],
        ["h", "stepOver", []],
        ["H", "setFeatureSet", ["debugger", "memory", "mcp"]],
        ["i", "stepNextBranchOrReturn", ["timeoutMs", "maxSteps"]],
        ["I", "injectBytes", ["address", "input"]],
        ["j", "runUntilNextCall", ["timeoutMs", "maxSteps"]],
        ["J", "nextFunctionCall", ["timeoutMs", "maxSteps"]],
        ["k", "runUntilReturn", ["timeoutMs", "maxSteps"]],
        ["K", "returnToPop", ["timeoutMs", "maxSteps"]],
        ["l", "listBreakpoints", []],
        ["L", "listOtherCoroutines", ["limit"], { limit: 32 }],
        ["m", "batch", ["commands"]],
        ["M", "setBreakpoint", ["address", "type", "enabled"]],
        ["n", "trueNextBranch", ["timeoutMs", "maxSteps"]],
        ["N", "removeBreakpoint", ["id"]],
        ["o", "searchMemory", ["address", "value", "condition", "size"], { limit: 64 }],
        ["O", "resetMemorySearch", []],
        ["p", "pause", []],
        ["P", "resume", []],
        ["q", "setInput", ["button", "pressed"]],
        ["Q", "runInputTap", ["button", "repeat", "holdMs", "gapMs"]],
        ["r", "runInputHold", ["button", "durationMs"]],
        ["R", "runTouchHold", ["x", "y", "durationMs"]],
        ["s", "setSpeed", ["speed"]],
        ["S", "setCTableSeed", ["address", "value", "high"]],
        ["t", "stackTrace", ["limit"], { limit: 32 }],
        ["T", "setStackTraceMode", ["enabled"]],
        ["u", "writeMemory", ["address", "value", "size"]],
        ["U", "setStackTracePrivilegeCheck", ["enabled"]],
        ["v", "setRenderEnabled", ["enabled"]],
        ["V", "setAudio", ["enabled", "volume"]],
        ["w", "wait", ["ms"]],
        ["W", "waitMs", ["ms"]],
        ["x", "clearBreakStatus", []],
        ["X", "copyCallStackMarkdown", []],
        ["y", "setScale", ["scale"]],
        ["Y", "copyCallStackCsv", []],
        ["z", "setRotation", ["rotation"]],
        ["Z", "takeScreenshot", ["type", "includeDataUrl"]]
    ];
    const toParams = (args, names, defaults = {}) => {
        if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
            return { ...defaults, ...args[0] };
        }
        const params = { ...defaults };
        names.forEach((name, index) => {
            if (index < args.length && args[index] !== undefined) params[name] = args[index];
        });
        return params;
    };
    const shortcuts = {};
    for (const [name, command, params, defaults = {}] of definitions) {
        const shortcut = (...args) => runCommand(command, toParams(args, params, defaults));
        Object.defineProperty(shortcut, "name", {
            value: `desmume_${name}_${command}`,
            configurable: true
        });
        shortcut.command = command;
        shortcut.params = params;
        shortcut.defaults = defaults;
        target[name] = shortcut;
        shortcuts[name] = { command, params, defaults };
    }
    target.DesmumeShortcuts = shortcuts;
    return shortcuts;
}
