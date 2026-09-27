import { ErrorCode } from "./error-codes.js";

const NATIVE_FUNCTIONS = Object.freeze([
    ["loadROM", "number", ["number"]],
    ["reset", "number", []],
    ["isRomLoaded", "number", []],
    ["runFrame", "number", ["number", "number", "number", "number", "number"]],
    ["runFrames", "number", ["number", "number", "number"]],
    ["fillAudioBuffer", "number", ["number"]],
    ["getSymbol", "number", ["number"]],
    ["savGetSize", "number", []],
    ["savGetPointer", "number", ["number"]],
    ["savImportFromFile", "number", ["number"]],
    ["savExportToFile", "number", []],
    ["savUpdateChangeFlag", "number", []],
    ["stateGetSize", "number", []],
    ["stateGetPointer", "number", ["number"]],
    ["saveStateToBuffer", "number", []],
    ["loadStateFromBuffer", "number", ["number"]],
    ["loadStateFromFile", "number", []],
    ["captureFrameBuffer", "number", []],
    ["pauseEmu", "number", ["number"]],
    ["isPaused", "number", []],
    ["debuggerSetEnabled", "number", ["number"]],
    ["traceSetEnabled", "number", ["number"]],
    ["traceSetSuspended", "number", ["number"]],
    ["traceSetPrivilegeCheck", "number", ["number"]],
    ["traceGetDepth", "number", []],
    ["dbgGetReg", "number", ["number", "number"]],
    ["dbgSetReg", "number", ["number", "number", "number"]],
    ["dbgRead8", "number", ["number", "number"]],
    ["dbgRead16", "number", ["number", "number"]],
    ["dbgRead32", "number", ["number", "number"]],
    ["dbgWrite8", "number", ["number", "number", "number"]],
    ["dbgWrite16", "number", ["number", "number", "number"]],
    ["dbgWrite32", "number", ["number", "number", "number"]],
    ["dbgDumpMemory", "number", ["number", "number", "number"]],
    ["dbgSetExecBreakpoint", "number", ["number", "number", "number"]],
    ["dbgSetReadBreakpoint", "number", ["number", "number", "number"]],
    ["dbgSetWriteBreakpoint", "number", ["number", "number", "number"]],
    ["dbgSetSpecialBreakpoint", "number", ["number", "number"]],
    ["dbgClearBreakStatus", "number", []],
    ["dbgClearAllBreakpoints", "number", []],
    ["wasmDebuggerShouldBreak", "number", ["number", "number", "number", "number", "number"]],
    ["dbgStep", "number", ["number", "number"]],
    ["dbgStepOver", "number", ["number"]],
    ["dbgGetStatusJson", "string", []],
    ["dbgDisassemble", "string", ["number", "number", "number", "number"]],
    ["dbgDisassembleOpcode", "string", ["number", "number", "number"]],
    ["dbgStackTrace", "string", ["number", "number"]],
    ["dbgCallStackJson", "string", []],
    ["dbgCallStackJsonLimit", "string", ["number"]],
    ["utilBinaryFloat", "string", ["number", "number", "number", "number", "number"]],
    ["emuSetOpt", "number", ["number", "number"]]
]);

export function createNativeBridge({
    state,
    scriptUrl,
    onScriptLoading = () => {},
    onNativeReady = () => {},
    onInitialized = () => {},
    onReady = () => {},
    onFault = () => {}
}) {
    function cpuIndex(cpu = state.selectedCpu) {
        return String(cpu).toLowerCase() === "arm7" ? 1 : 0;
    }

    function ensureReady() {
        if (!state.ready) throw new Error("wasm is not ready");
    }

    function hasLoadedRom() {
        return !!(
            state.ready
            && state.fns.isRomLoaded
            && state.fns.isRomLoaded() === 1
            && state.romSize > 0
        );
    }

    function ensureRomLoaded(action = "ROM is not loaded") {
        ensureReady();
        if (!hasLoadedRom()) {
            throw new Error(`${action}. Load a ROM first with Files > ROM or loadRomUrl("/dq9.nds").`);
        }
    }

    function getPc(cpu = state.selectedCpu) {
        ensureRomLoaded("register access requires a loaded ROM");
        return state.fns.dbgGetReg(cpuIndex(cpu), 18) >>> 0;
    }

    function tryGetPc(cpu = state.selectedCpu) {
        return hasLoadedRom() ? state.fns.dbgGetReg(cpuIndex(cpu), 18) >>> 0 : null;
    }

    function checkResult(value, operation) {
        const result = Number(value);
        if (result >= 0) return value;
        const normalErrors = {
            [-1]: [ErrorCode.ROM_NOT_LOADED, "ROM is not loaded"],
            [-2]: [ErrorCode.INVALID_ARGUMENT, "Native operation received an invalid argument"],
            [-3]: [ErrorCode.STATE_INVALID, "State data is invalid"],
            [-4]: [ErrorCode.BUFFER_TOO_SMALL, "Native buffer is too small"]
        };
        const normalError = normalErrors[result];
        const error = new Error(normalError
            ? `${normalError[1]} during ${operation} (${result})`
            : `native fault during ${operation} (${result})`);
        error.mcpCode = normalError?.[0]
            || (result === -99 ? ErrorCode.NATIVE_ERROR : ErrorCode.NATIVE_FAULT);
        error.mcpDetails = { operation, nativeCode: result };
        if (!normalError) onFault(error, operation);
        throw error;
    }

    function checkText(value, operation) {
        const text = String(value || "");
        if (!text || text.includes('"nativeFault":true')) {
            const error = new Error(`native fault during ${operation}`);
            error.mcpCode = ErrorCode.NATIVE_FAULT;
            error.mcpDetails = { operation };
            onFault(error, operation);
            throw error;
        }
        return text;
    }

    function parseJson(value, operation) {
        const text = checkText(value, operation);
        try {
            return JSON.parse(text);
        } catch (cause) {
            const error = new Error(`native returned invalid JSON during ${operation}`);
            error.mcpCode = ErrorCode.NATIVE_ERROR;
            error.mcpDetails = {
                operation,
                errorType: cause?.name || "Error",
                preview: text.slice(0, 120)
            };
            onFault(error, operation);
            throw error;
        }
    }

    function wrapFunctions() {
        for (const [name, returnType, argumentTypes] of NATIVE_FUNCTIONS) {
            state.fns[name] = state.module.cwrap(name, returnType, argumentTypes);
        }
    }

    async function loadScript() {
        if (typeof CreateDesmumeModule === "function") return;
        if (!state.scriptLoadPromise) {
            onScriptLoading();
            state.scriptLoadPromise = new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = scriptUrl;
                script.async = true;
                script.onload = resolve;
                script.onerror = () => reject(new Error("desmume.js load failed"));
                document.head.append(script);
            }).catch((error) => {
                state.scriptLoadPromise = null;
                throw error;
            });
        }
        await state.scriptLoadPromise;
    }

    async function initialize() {
        if (state.nativeInitState === "ready" && state.ready) return state.module;
        if (typeof CreateDesmumeModule !== "function") {
            throw new Error("desmume.js is not loaded");
        }
        state.nativeInitState = "initializing";
        state.ready = false;
        try {
            window.wasmReady = onNativeReady;
            state.module = await CreateDesmumeModule({ noInitialRun: false });
            wrapFunctions();
            await onInitialized();
            state.ready = true;
            state.nativeInitState = "ready";
        } catch (error) {
            state.ready = false;
            state.nativeInitState = "failed";
            state.module = null;
            state.fns = {};
            throw error;
        }
        try {
            await onReady();
        } catch (error) {
            onFault(error, "post-initialization");
        }
        return state.module;
    }

    async function ensureInitialized() {
        if (state.nativeInitState === "ready" && state.ready) return state.module;
        if (!state.moduleInitPromise) {
            state.moduleInitPromise = (async () => {
                await loadScript();
                return initialize();
            })().catch((error) => {
                state.moduleInitPromise = null;
                throw error;
            });
        }
        return state.moduleInitPromise;
    }

    function pause(paused = true) {
        ensureReady();
        if (!paused && state.breakpointsInSync !== true) {
            const error = new Error("resume is unavailable while native breakpoints are out of sync");
            error.mcpCode = ErrorCode.NATIVE_ERROR;
            error.mcpDetails = { breakpointsInSync: false };
            throw error;
        }
        return checkResult(state.fns.pauseEmu(paused ? 1 : 0), paused ? "pause" : "resume");
    }

    function pauseWithoutFaultHandling(paused = true) {
        if (!state.ready || !state.fns.pauseEmu) return 0;
        return state.fns.pauseEmu(paused ? 1 : 0);
    }

    function isPaused() {
        ensureReady();
        return state.fns.isPaused() !== 0;
    }

    function loadRom(size) {
        ensureReady();
        return checkResult(state.fns.loadROM(Number(size)), "loadROM");
    }

    function fileExists(path) {
        ensureReady();
        return !!state.module.FS.analyzePath(String(path)).exists;
    }

    function readFile(path) {
        ensureReady();
        return new Uint8Array(state.module.FS.readFile(String(path)));
    }

    function writeFile(path, bytes) {
        ensureReady();
        state.module.FS.writeFile(String(path), bytes);
    }

    function unlinkFile(path) {
        if (!fileExists(path)) return false;
        state.module.FS.unlink(String(path));
        return true;
    }

    function loadStateBytes(bytes) {
        ensureReady();
        const pointer = state.fns.stateGetPointer(bytes.length);
        if (!pointer) throw new Error("state buffer allocation failed");
        state.module.HEAPU8.set(bytes, pointer);
        return checkResult(state.fns.loadStateFromBuffer(bytes.length), "loadStateFromBuffer");
    }

    function setTraceEnabled(enabled) {
        return checkResult(state.fns.traceSetEnabled(enabled ? 1 : 0), "traceSetEnabled");
    }

    function setTraceSuspended(suspended) {
        return checkResult(state.fns.traceSetSuspended(suspended ? 1 : 0), "traceSetSuspended");
    }

    function setTracePrivilegeCheck(enabled) {
        return checkResult(
            state.fns.traceSetPrivilegeCheck(enabled ? 1 : 0),
            "traceSetPrivilegeCheck"
        );
    }

    function setDebuggerEnabled(enabled) {
        return checkResult(state.fns.debuggerSetEnabled(enabled ? 1 : 0), "debuggerSetEnabled");
    }

    function isRomLoaded() {
        return !!(state.ready && state.fns.isRomLoaded() === 1);
    }

    function exportSaveBytes() {
        checkResult(state.fns.savExportToFile(), "save export");
        return readFile("export.sav");
    }

    function saveStateBytes() {
        const size = checkResult(state.fns.saveStateToBuffer(), "saveStateToBuffer");
        if (size <= 0) throw new Error("state save failed");
        const pointer = state.fns.stateGetPointer(0);
        if (!pointer) throw new Error("state buffer is unavailable");
        return state.module.HEAPU8.slice(pointer, pointer + size);
    }

    function getStateBufferBytes(size) {
        const pointer = state.fns.stateGetPointer(0);
        if (!pointer) throw new Error("state buffer is unavailable");
        return state.module.HEAPU8.slice(pointer, pointer + Number(size));
    }

    function loadBufferedState() {
        const size = checkResult(state.fns.stateGetSize(), "stateGetSize");
        if (size <= 0) throw new Error("in-memory state is empty");
        return checkResult(state.fns.loadStateFromBuffer(size), "loadStateFromBuffer");
    }

    function loadStateFile(bytes, path = "import.dst") {
        writeFile(path, bytes);
        return checkResult(state.fns.loadStateFromFile(), "loadStateFromFile");
    }

    function setRegister(cpu, register, value) {
        return checkResult(
            state.fns.dbgSetReg(cpuIndex(cpu), Number(register), Number(value) >>> 0),
            "setRegister"
        );
    }

    function disassembleOpcode(address, opcode, mode) {
        return checkText(
            state.fns.dbgDisassembleOpcode(
                Number(address) >>> 0,
                Number(opcode) >>> 0,
                Number(mode)
            ),
            "disassembleOpcode"
        );
    }

    function binaryFloat(bits, low, high, numeric, encode) {
        return parseJson(
            state.fns.utilBinaryFloat(bits, low >>> 0, high >>> 0, numeric, encode ? 1 : 0),
            "binaryFloat"
        );
    }

    function dumpMemory(cpu, address, length) {
        const pointer = state.fns.dbgDumpMemory(cpuIndex(cpu), address >>> 0, Number(length));
        if (!pointer) throw new Error("memory dump failed");
        return state.module.HEAPU8.slice(pointer, pointer + Number(length));
    }

    function readMemory(cpu, address, size = 1) {
        const functionName = size === 4 ? "dbgRead32" : size === 2 ? "dbgRead16" : "dbgRead8";
        const value = state.fns[functionName](cpuIndex(cpu), Number(address) >>> 0);
        return size === 4 ? value >>> 0 : size === 2 ? value & 0xffff : value & 0xff;
    }

    function setSpecialBreakpoint(kind, enabled) {
        return checkResult(
            state.fns.dbgSetSpecialBreakpoint(Number(kind), enabled ? 1 : 0),
            "setSpecialBreakpoint"
        );
    }

    function stackTrace(cpu, words) {
        return checkText(
            state.fns.dbgStackTrace(cpuIndex(cpu), Number(words)),
            "stackTrace"
        );
    }

    function captureFramePixels() {
        ensureRomLoaded("frame capture requires a loaded ROM");
        checkResult(state.fns.captureFrameBuffer(), "captureFrameBuffer");
        const pointer = state.fns.getSymbol(4);
        return state.module.HEAPU32.slice(pointer >>> 2, (pointer >>> 2) + 256 * 384);
    }

    function getFrameBytes() {
        const pointer = state.fns.getSymbol(4);
        if (!pointer) return null;
        return state.module.HEAPU8.subarray(pointer, pointer + 256 * 384 * 4);
    }

    function fillAudioSamples(desired) {
        const sampleCount = checkResult(state.fns.fillAudioBuffer(desired), "fillAudioBuffer");
        if (sampleCount <= 0) return { sampleCount: 0, samples: null };
        const pointer = state.fns.getSymbol(6);
        return {
            sampleCount,
            samples: state.module.HEAP16.subarray(pointer >> 1, (pointer >> 1) + sampleCount * 2)
        };
    }

    function runFrame({ render, keys, touch }) {
        if (state.breakpointsInSync !== true) throw Object.assign(new Error("frame execution requires synchronized breakpoints"), { mcpCode: ErrorCode.NATIVE_ERROR });
        return checkResult(state.fns.runFrame(
            render ? 1 : 0,
            keys,
            touch?.active ? 1 : 0,
            Number(touch?.x) || 0,
            Number(touch?.y) || 0
        ), "runFrame");
    }

    function runFrames(count, { render, keys }) {
        if (state.breakpointsInSync !== true) throw Object.assign(new Error("frame execution requires synchronized breakpoints"), { mcpCode: ErrorCode.NATIVE_ERROR });
        return checkResult(state.fns.runFrames(count, render ? 1 : 0, keys), "runFrames");
    }

    function getStatus() {
        ensureReady();
        return parseJson(state.fns.dbgGetStatusJson(), "status");
    }

    function getRegister(cpu, register) {
        ensureReady();
        return state.fns.dbgGetReg(cpuIndex(cpu), register) >>> 0;
    }

    function clearBreakStatus() {
        return checkResult(state.fns.dbgClearBreakStatus(), "clearBreakStatus");
    }

    function clearAllBreakpoints() {
        if (!state.fns.dbgClearAllBreakpoints) return 0;
        return checkResult(state.fns.dbgClearAllBreakpoints(), "clearAllBreakpoints");
    }

    function setBreakpoint(cpu, type, address, enabled) {
        const functionName = type === "read"
            ? "dbgSetReadBreakpoint"
            : type === "write" ? "dbgSetWriteBreakpoint" : "dbgSetExecBreakpoint";
        return checkResult(
            state.fns[functionName](cpuIndex(cpu), Number(address) >>> 0, enabled ? 1 : 0),
            `set ${type} breakpoint`
        );
    }

    function checkExecBreakpoint(cpu, address) {
        return checkResult(
            state.fns.wasmDebuggerShouldBreak(cpuIndex(cpu), 0, Number(address) >>> 0, 0, 0),
            "check exec breakpoint"
        ) === 1;
    }

    function step(cpu, count = 1) {
        if (state.breakpointsInSync !== true) throw Object.assign(new Error("step requires synchronized breakpoints"), { mcpCode: ErrorCode.NATIVE_ERROR });
        return checkResult(state.fns.dbgStep(cpuIndex(cpu), Number(count)), "step");
    }

    function stepOver(cpu) {
        if (state.breakpointsInSync !== true) throw Object.assign(new Error("stepOver requires synchronized breakpoints"), { mcpCode: ErrorCode.NATIVE_ERROR });
        return checkResult(state.fns.dbgStepOver(cpuIndex(cpu)), "stepOver");
    }

    function disassemble(cpu, address, count, mode) {
        return checkText(
            state.fns.dbgDisassemble(cpuIndex(cpu), Number(address) >>> 0, Number(count), Number(mode)),
            "disassemble"
        );
    }

    function getCallStack(limit = 128) {
        const text = state.fns.dbgCallStackJsonLimit
            ? state.fns.dbgCallStackJsonLimit(limit)
            : state.fns.dbgCallStackJson();
        return parseJson(text, "callStack");
    }

    function getTraceDepth() {
        return checkResult(state.fns.traceGetDepth(), "traceGetDepth");
    }

    function writeMemory(cpu, address, value, size = 1) {
        const functionName = size === 4 ? "dbgWrite32" : size === 2 ? "dbgWrite16" : "dbgWrite8";
        return checkResult(
            state.fns[functionName](cpuIndex(cpu), Number(address) >>> 0, Number(value) >>> 0),
            `write${size * 8}`
        );
    }

    return Object.freeze({
        captureFramePixels,
        checkResult,
        checkText,
        checkExecBreakpoint,
        clearAllBreakpoints,
        clearBreakStatus,
        cpuIndex,
        disassemble,
        disassembleOpcode,
        dumpMemory,
        ensureInitialized,
        ensureReady,
        ensureRomLoaded,
        exportSaveBytes,
        fillAudioSamples,
        getCallStack,
        getFrameBytes,
        getPc,
        getRegister,
        getStatus,
        getStateBufferBytes,
        getTraceDepth,
        hasLoadedRom,
        initialize,
        fileExists,
        isRomLoaded,
        isPaused,
        binaryFloat,
        loadBufferedState,
        loadRom,
        loadStateFile,
        loadStateBytes,
        parseJson,
        pause,
        pauseWithoutFaultHandling,
        readFile,
        readMemory,
        runFrame,
        runFrames,
        setBreakpoint,
        setDebuggerEnabled,
        setRegister,
        setSpecialBreakpoint,
        step,
        stepOver,
        setTraceEnabled,
        setTraceSuspended,
        setTracePrivilegeCheck,
        saveStateBytes,
        stackTrace,
        tryGetPc,
        unlinkFile,
        writeFile,
        writeMemory
    });
}
