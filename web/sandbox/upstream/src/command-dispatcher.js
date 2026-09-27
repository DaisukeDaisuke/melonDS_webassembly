import { ErrorCode } from "./error-codes.js";
import { isPlainObject } from "./validation.js";

const UI_REFRESH_COMMANDS = new Set([
    "pause", "resume", "step", "smartStep", "stepOver", "stepNextBranchOrReturn",
    "nextBranchOrReturn", "trueNextBranch", "nextTrueBranch", "runUntilReturn", "returnToPop",
    "runUntilNextCall", "nextFunctionEnter", "nextCall", "nextCallThisDepth", "nextFunctionCall", "stepFrames",
    "setRegister", "writeMemory", "injectMemoryFile", "injectBytes", "setMemoryFreeze",
    "setBreakpoint", "removeBreakpoint", "setSpecialBreakpoint", "setStackTraceMode",
    "setStackTracePrivilegeCheck", "loadRomUrl", "loadState", "reloadRecentFile", "setInput",
    "runInputHold", "runInputTap"
]);

const ACTIVITY_COMMANDS = new Set([
    "loadRomFile", "loadRomBytes", "loadRomUrl", "importSaveFile", "loadSaveSlot", "saveState",
    "loadState", "importStateFile", "loadStateBytes", "loadStateUrl", "reloadRecentFile", "pause",
    "resume", "continue", "reset", "reloadRom", "step", "smartStep", "stepOver",
    "stepNextBranchOrReturn", "nextBranchOrReturn", "trueNextBranch", "nextTrueBranch",
    "runUntilReturn", "returnToPop", "runUntilNextCall", "nextFunctionEnter", "nextCall", "nextCallThisDepth",
    "nextFunctionCall", "stepFrames", "setInput", "runInputHold", "runInputTap", "runTouchHold",
    "setRegister", "writeMemory", "injectMemoryFile", "injectBytes", "setMemoryFreeze",
    "setCTableSeed", "memorySetRegister", "memoryWriteByte", "memoryWriteWord", "memoryWriteDword"
]);

const CANCELLING_COMMANDS = new Set([
    "pause", "reset", "reloadRom", "loadRomFile", "loadRomBytes", "loadRomUrl", "importSaveFile",
    "loadSaveSlot", "loadState", "importStateFile", "loadStateBytes", "loadStateUrl",
    "reloadRecentFile"
]);

const FILE_TRANSACTION_ALLOWED_COMMANDS = new Set([
    "pause", "status", "listRecentFiles", "listBreakpoints", "listMemoryFreezes",
    "listScripts", "listPScriptMcp", "getScript", "listScriptPrint", "getOperation", "cancelOperation",
    "getInputState", "releaseInput", "listStateSlots", "listSaveSlots",
    "listAnalysisBaselines", "listInputRecordings", "waitForStateLoad",
    "waitForFileTransaction"
]);

const RECORDABLE_INPUT_COMMANDS = new Set([
    "setInput", "runInputHold", "runInputTap", "runTouchHold"
]);

const RESERVED_PARAM_FIELDS = Object.freeze([
    "_operation",
    "_origin",
    "_scriptId",
    "_triggerId",
    "_operationId",
    "_scriptCallback",
    "_scriptEventId",
    "_analysisBaselineSlotToken"
]);

export function createCommandDispatcher({
    state,
    registry,
    responder,
    operationManager,
    hasLoadedRom,
    emulatorActivity,
    refreshDebuggerViews,
    updateStatus,
    log
}) {
    let refreshTimer = 0;

    function queueUiRefresh(name) {
        if (!UI_REFRESH_COMMANDS.has(name)
            || !state.ready
            || !hasLoadedRom()
            || state.loadingFile) return;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            refreshTimer = 0;
            refreshDebuggerViews({ keepHighlight: true }).catch((error) => {
                log(error.message || String(error));
            });
        }, 0);
    }

    async function run(name, params = {}) {
        if (params === undefined) params = {};
        if (!isPlainObject(params)) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "Command params must be a plain object");
        }
        const reservedField = RESERVED_PARAM_FIELDS.find((field) => (
            Object.prototype.hasOwnProperty.call(params, field)
        ));
        if (reservedField) {
            return responder.fail(
                ErrorCode.INVALID_ARGUMENT,
                `Reserved parameter is not allowed: ${reservedField}`
            );
        }
        const active = operationManager.current();
        if (active
            && ACTIVITY_COMMANDS.has(name)
            && !CANCELLING_COMMANDS.has(name)
            && !(active.name === "recordInput" && RECORDABLE_INPUT_COMMANDS.has(name))
        ) {
            return responder.fail(ErrorCode.BUSY, `Active operation is ${active.name}`);
        }
        if (state.fileTransactionActive && !FILE_TRANSACTION_ALLOWED_COMMANDS.has(name)) {
            return responder.fail(
                ErrorCode.BUSY,
                `Active file transaction is ${state.fileTransactionReason || "in progress"}`
            );
        }
        const result = await registry.execute(name, params);
        if (ACTIVITY_COMMANDS.has(name) && result && typeof result === "object") {
            Object.assign(result, emulatorActivity());
        }
        updateStatus();
        queueUiRefresh(name);
        return result;
    }

    return Object.freeze({ queueUiRefresh, run });
}
