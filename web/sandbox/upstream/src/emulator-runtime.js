import { createMcpResponder } from "./mcp-responder.js";
import { createCommandRegistry } from "./command-registry.js";
import { createOperationManager } from "./operation-manager.js";
import { createBreakpointOwnerStore } from "./breakpoint-owner-store.js";
import { createBreakpointService } from "./breakpoint-service.js";
import { createFrameService } from "./frame-service.js";
import { createInputSequenceService } from "./input-service.js";
import { describeInputPause } from "./input-pause.js";
import { createApiDescriptions } from "./api-descriptions.js";
import { createAppState } from "./state.js";
import { installGlobalShortcuts } from "./shortcuts.js";
import { createScriptRunner } from "./script-runner.js";
import { createSandboxBoundarySelfTest } from "./sandbox-boundary-self-test.js";
import { createScriptService } from "./script-service.js";
import { createCommands } from "./commands/command-factory.js";
import { bindUi } from "./ui/ui-controller.js";
import { registerWebMcp } from "./webmcp.js";
import { registerWaitCommands } from "./commands/wait-commands.js";
import { createEmulationLoop } from "./emulation-loop.js";
import { createFrameComparator } from "./frame-comparator.js";
import { createDebuggerService } from "./debugger-service.js";
import { createViewService } from "./ui/view-service.js";
import { createNativeBridge } from "./native-bridge.js";
import { createBinaryTools } from "./binary-tools.js";
import { createFileIoService } from "./file-io-service.js";
import { createRomService } from "./rom-service.js";
import { createSaveService } from "./save-service.js";
import { createStateService } from "./state-service.js";
import { createScreenVisibility } from "./ui/screen-visibility.js";
import { createInputController } from "./ui/input-controller.js";
import { createDebuggerCoordinator } from "./debugger-coordinator.js";
import { createRuntimeTools } from "./runtime-tools.js";
import { createNativeFaultHandler } from "./native-fault-handler.js";
import { createCommandDispatcher } from "./command-dispatcher.js";
import { createScriptPauseService } from "./script-pause-service.js";
import { createPauseEventService } from "./pause-event-service.js";
import { createInputWindow } from "./input-window.js";
import { createSerialEventService } from "./serial-event-service.js";
import { createInputRecordingService } from "./input-recording-service.js";
import { createInputTaskManager } from "./input-task-manager.js";
import { withInternalMetadata } from "./internal-command-metadata.js";
import { createScreenInvalidNotice } from "./screen-invalid-notice.js";
import { createFileTransactionService } from "./file-transaction-service.js";
import { createUiInteractionLock } from "./ui/interaction-lock.js";
import evalSupervisorWorkerSource from "./workers/eval-supervisor.worker.js";
import evalSandboxWorkerSource from "./workers/eval.worker.js";
import parserWorkerSource from "./workers/parser.worker.js";

export const emulatorRuntimeEntry = true;
let initializedRuntimeApi = null;

export function initializeEmulatorRuntime() {
if (initializedRuntimeApi) return initializedRuntimeApi;
const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map((el) => [el.id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), el]));
const DESMUME_SCRIPT_URL = "desmume.js?v=20260731-singlethread-recovery";
const state = createAppState();
const uiInteractionLock = createUiInteractionLock();
state.emulatorBundleLoaded = true;
state.scale = Number(ui.scaleSelect?.value || state.scale);
state.rotation = Number(ui.rotationSelect?.value || state.rotation);
const screenInvalidNotice = createScreenInvalidNotice(ui.storageStatus);
const runCommand = (name, params = {}) => commandDispatcher.run(name, params);
const runtimeTools = createRuntimeTools({
    state,
    getRomWaitMs: () => ui.romWaitMs.value
});
const { blockSaveFlush, bootWaitMs, sleep, waitChecked } = runtimeTools;
const nativeBridge = createNativeBridge({
    state,
    scriptUrl: DESMUME_SCRIPT_URL,
    onScriptLoading: () => {
        ui.readyText.textContent = "loading emulator";
    },
    onNativeReady: () => log("native module signaled ready"),
    onFault: (error, operation) => handleNativeFault(error, operation),
    onInitialized: async () => {
        nativeBridge.setTraceEnabled(ui.traceToggle.checked);
        state.traceEnabled = ui.traceToggle.checked;
        state.imageData = ui.screen.getContext("2d").createImageData(256, 384);
        applyScaleRotation();
    },
    onReady: async () => {
        ui.readyLed.className = "led ready";
        ui.readyText.textContent = "ready";
        updateStatus();
        scheduleTick();
        try {
            await webMcp.registerBrowserTools();
        } catch (error) {
            log(`optional WebMCP registration failed: ${String(error?.message || error)}`);
        }
    }
});
const {
    ensureInitialized: ensureWasmReady,
    ensureReady,
    ensureRomLoaded,
    getPc,
    hasLoadedRom,
    tryGetPc
} = nativeBridge;
const binaryTools = createBinaryTools({
    getPc,
    getSelectedCpu: () => state.selectedCpu
});
const {
    bigEndianValue,
    bytesFromFlexibleParams,
    bytesFromParams,
    opcodeWordsFromInput,
    parseAddress,
    parseNumber,
    splitBinaryBits,
    swap16,
    swap32,
    u16FromBytes,
    u32FromBytes
} = binaryTools;
const mcpResponder = createMcpResponder({
    logger: { error: (name, error) => console.error(name, error) },
    pauseSafely: () => {
        state.paused = true;
        state.running = false;
        nativeBridge.pauseWithoutFaultHandling(true);
    }
});
const scriptRunner = createScriptRunner({
    source: evalSupervisorWorkerSource,
    sandboxSource: evalSandboxWorkerSource,
    parserSource: parserWorkerSource,
    responder: mcpResponder,
    callCommand: (command, params) => runCommand(command, params),
    getShortcuts: () => Object.entries(window.DesmumeShortcuts || {}).map(([shortcut, definition]) => [
        shortcut,
        definition.command,
        definition.params,
        definition.defaults
    ])
});
const sandboxBoundarySelfTest = createSandboxBoundarySelfTest();

const breakpointOwners = createBreakpointOwnerStore({
    onReconcileStart: () => {
        state.breakpointsInSync = false;
        state.paused = true;
        state.running = false;
        nativeBridge.pauseWithoutFaultHandling(true);
    },
    onReconcileSuccess: () => { state.breakpointsInSync = true; },
    onReconcileFailure: () => {
        state.breakpointsInSync = false;
        state.paused = true;
        state.running = false;
        nativeBridge.pauseWithoutFaultHandling(true);
    },
    onClearNative: () => {
        if (state.ready && nativeBridge.isRomLoaded()) nativeBridge.clearAllBreakpoints();
    },
    onFirstOwner: (site) => {
        if (!state.ready || !nativeBridge.isRomLoaded()) return;
        if (site.cpu === "special") {
            const kind = { dataAbort: 3, prefetchAbort: 4, undefinedInstruction: 5 }[site.type];
            nativeBridge.setSpecialBreakpoint(kind, true);
        } else {
            nativeBridge.setBreakpoint(site.cpu, site.type, site.address, true);
        }
    },
    onLastOwner: (site) => {
        if (!state.ready || !nativeBridge.isRomLoaded()) return;
        if (site.cpu === "special") {
            const kind = { dataAbort: 3, prefetchAbort: 4, undefinedInstruction: 5 }[site.type];
            nativeBridge.setSpecialBreakpoint(kind, false);
        } else {
            nativeBridge.setBreakpoint(site.cpu, site.type, site.address, false);
        }
    }
});
const breakpointService = createBreakpointService({ ownerStore: breakpointOwners });
const scriptPauseService = createScriptPauseService();
const pauseEventService = createPauseEventService();
const stateLoadEventService = createSerialEventService();
const fileTransactionEventService = createSerialEventService();
let wakeEmulationLoop = () => {};
const waitForInputWindow = createInputWindow({ pauseEventService });
const inputTaskManager = createInputTaskManager();
const frameComparator = createFrameComparator({ responder: mcpResponder });
const frameService = createFrameService({
    responder: mcpResponder,
    getFrame: () => state.frame,
    compareImplementation: frameComparator.compare,
    capturePixels: () => nativeBridge.captureFramePixels()
});
const screenVisibility = createScreenVisibility({
    state,
    ui,
    frameService,
    tryGetPc
});
const { applyScaleRotation, updateStatus } = screenVisibility;
const inputController = createInputController({ state, ui });
const {
    isTypingTarget,
    getInputSnapshot,
    releaseAllKeys,
    setKey,
    setTouchState,
    subscribeInputMutations,
    toButtonList,
    updateTouch
} = inputController;
const viewService = createViewService({
    state,
    ui,
    getRegisters: (cpu) => debuggerCoordinator.getRegisters(cpu),
    hasLoadedRom,
    native: nativeBridge,
    parseAddress,
    getIdbPut: () => debuggerService.idbPut
});
const {
    log,
    disasmRefreshParams,
    setFollowPc,
    hex,
    cpsrModeInfo,
    normalizeCallStackData,
    readCallStackData,
    publicOtherCoroutines,
    publicCallStackData,
    memorySearchRanges,
    memorySearchRangeKey,
    copyText,
    rawOutputText,
    setScriptOutput,
    normalizeKeyboardCode,
    saveKeymap,
    loadKeymap,
    renderRegisters,
    renderBreakpoints,
    renderFreezes,
    renderRecentFiles,
    rememberSlot,
    renderStateSlotOptions,
    recordRecentFile,
    renderHotkey
} = viewService;
const handleNativeFault = createNativeFaultHandler({
    state,
    native: nativeBridge,
    log,
    updateStatus,
    blockSaveFlush,
    pauseEventService
});
const debuggerCoordinator = createDebuggerCoordinator({
    state,
    native: nativeBridge,
    breakpointOwners,
    breakpointService,
    pauseEventService,
    getQueueBreakpointRefresh: () => queueBreakpointRefresh,
    getWakeEmulationLoop: () => wakeEmulationLoop,
    log,
    hex,
    updateStatus,
    getStopPersistentScript: () => stopPersistentScript,
    reconcileNativeBreakpoints: () => breakpointOwners.reconcileNativeBreakpoints()
});
const {
    breakpointKindName,
    cancelAllPersistentScriptEvents,
    finishPersistentScriptEvent,
    getNativeStatus,
    getRegisters,
    requestPersistentScriptResume,
    settlePersistentScriptCallbacks,
    syncNativeBreakStatus,
    withCurrentExecBreakpointSuspended
} = debuggerCoordinator;
const scriptService = createScriptService({
    state,
    ui,
    responder: mcpResponder,
    breakpointOwners,
    ensureRomLoaded,
    finishPersistentScriptEvent,
    requestPersistentScriptResume,
    settlePersistentScriptCallbacks,
    hex,
    parseAddress,
    rawOutputText,
    runCommand,
    getCommands: () => commands,
    onExplicitPause: (event) => {
        const scriptEvent = scriptPauseService.publish(event);
        pauseEventService.publish({
            ...scriptEvent,
            pauseKind: "scriptPause",
            frame: Number(state.frame || 0)
        });
    }
});
const {
    scriptConsoleLine,
    renderScriptConsole,
    renderScripts,
    selectScript,
    dispatchScriptEvent,
    dispatchScriptEventAndWait,
    startPersistentScript,
    stopPersistentScript,
    scriptSummary,
    listPScriptMcps,
    callPScriptMcp
} = scriptService;
let inputRecordingService = null;
const emulationLoop = createEmulationLoop({
    state,
    ui,
    frameService,
    native: nativeBridge,
    handleNativeFault,
    syncNativeBreakStatus,
    dispatchScriptEvent,
    limitFrameBatch: (frames) => inputRecordingService?.limitFrameBatch(frames) ?? frames,
    onScreenValid: screenInvalidNotice.clear,
    updateStatus,
    log
});
const { drawFrame, pumpAudio, applyFreezes, tick, scheduleTick, wakeTick } = emulationLoop;
wakeEmulationLoop = wakeTick;

const analysisBaselineSlotToken = Symbol("analysisBaselineSlot");
const ANALYSIS_BASELINE_SLOT_PREFIX = "__analysis_baseline__:";
const ANALYSIS_BASELINE_STATE_FORMAT_VERSION = 2;

const apiDescriptions = createApiDescriptions();
const fileIo = createFileIoService();
const {
    download,
    openPicker,
    readInput: readFileFromInput
} = fileIo;
const fileTransactionService = createFileTransactionService({
    state,
    cancelPendingScriptEvents: cancelAllPersistentScriptEvents,
    eventService: fileTransactionEventService,
    inputTaskManager
});
const romService = createRomService({
    state,
    native: nativeBridge,
    sleep,
    blockSaveFlush,
    drawFrame,
    fileTransactionService,
    reconcileNativeBreakpoints: () => breakpointOwners.reconcileNativeBreakpoints()
});
const {
    reload: reloadCurrentRom,
    write: writeRomFile
} = romService;
const saveService = createSaveService({ native: nativeBridge, romService });
const { applyAndReload: applySaveAndReloadRom } = saveService;
const stateService = createStateService({
    state,
    native: nativeBridge,
    frameService,
    wakeEmulationLoop: () => wakeEmulationLoop(),
    onScreenInvalid: ({ showResumeNotice }) => {
        if (showResumeNotice) screenInvalidNotice.show();
        else screenInvalidNotice.clear();
    },
    onStatusChange: updateStatus,
    onFault: handleNativeFault,
    eventService: stateLoadEventService
});
const {
    invalidateAfterLoad: drawLoadedStateFrame,
    loadBytes: loadStateBytesFromMemory,
    pauseForLoad: pauseForFileLoad,
    restoreAfterLoad: restoreAfterFileLoad,
    stopAfterFailedLoad: stopAfterFailedStateLoad
} = stateService;

applyScaleRotation();

const debuggerService = createDebuggerService({
    ANALYSIS_BASELINE_SLOT_PREFIX,
    ANALYSIS_BASELINE_STATE_FORMAT_VERSION,
    applyFreezes,
    breakpointKindName,
    cpsrModeInfo,
    disasmRefreshParams,
    ensureReady,
    ensureRomLoaded,
    getPc,
    getRegisters,
    handleNativeFault,
    hasLoadedRom,
    hex,
    log,
    native: nativeBridge,
    normalizeCallStackData,
    publicCallStackData,
    readCallStackData,
    renderRegisters,
    setFollowPc,
    state,
    syncNativeBreakStatus,
    ui,
    updateStatus,
    withCurrentExecBreakpointSuspended,
    getCommands: () => commands
});
const {
    formatDisassemblyText,
    shouldIncludeDisassemblyBytes,
    emulatorActivity,
    isAnalysisBaselineSlot,
    currentRomIdentity,
    sha256Hex,
    readAnalysisBaseline,
    writeAnalysisBaseline,
    snapshotContext,
    runDebuggerInstruction,
    runUntilNextBranchOrReturn,
    runUntilTrueNextBranch,
    renderDisassembly,
    renderCallStack,
    refreshDebuggerViews,
    queueBreakpointRefresh,
    stopAutoUpdateLoop,
    queueAutoUpdateLoop,
    runTraceStepper,
    renderMemoryDump,
    modeNumber,
    instructionWidthForMode,
    readSized,
    matchSearchCondition,
    idbPut,
    idbGet,
    idbKeys,
    idbDelete,
    idbDeleteMany
} = debuggerService;

const commands = createCommands({
    ANALYSIS_BASELINE_SLOT_PREFIX,
    ANALYSIS_BASELINE_STATE_FORMAT_VERSION,
    analysisBaselineSlotToken,
    applyFreezes,
    applyScaleRotation,
    applySaveAndReloadRom,
    bigEndianValue,
    blockSaveFlush,
    bootWaitMs,
    breakpointOwners,
    bytesFromFlexibleParams,
    bytesFromParams,
    cancelAndWait: (reason) => operationManager.cancelAndWait(reason),
    cancelOperation: (reason) => (
        reason === "pause" && operationManager.current()?.name === "waitForPause"
            ? false
            : operationManager.cancel(reason)
    ),
    copyText,
    currentRomIdentity,
    dispatchScriptEvent,
    dispatchScriptEventAndWait,
    download,
    drawFrame,
    drawLoadedStateFrame,
    emulatorActivity,
    ensureReady,
    ensureRomLoaded,
    ensureWasmReady,
    frameService,
    fileTransactionService,
    formatDisassemblyText,
    getPc,
    getRegisters,
    hasLoadedRom,
    hex,
    idbGet,
    idbKeys,
    idbDelete,
    idbPut,
    instructionWidthForMode,
    isAnalysisBaselineSlot,
    loadStateBytesFromMemory,
    log,
    matchSearchCondition,
    memorySearchRangeKey,
    memorySearchRanges,
    modeNumber,
    native: nativeBridge,
    onScreenValid: screenInvalidNotice.clear,
    operationManager: () => operationManager,
    inputTaskManager,
    getInputParentSignal: () => operationManager.signalFor("recordInput"),
    pauseEventService,
    stateLoadEventService,
    fileTransactionEventService,
    opcodeWordsFromInput,
    openPicker,
    parseAddress,
    parseNumber,
    pauseForFileLoad,
    publicCallStackData,
    publicOtherCoroutines,
    pumpAudio,
    queueAutoUpdateLoop,
    readAnalysisBaseline,
    readCallStackData,
    readFileFromInput,
    readSized,
    requireValidScreen: () => frameService.requireValid(),
    recordRecentFile,
    refreshDebuggerViews,
    reloadCurrentRom,
    rememberSlot,
    renderBreakpoints,
    renderCallStack,
    renderFreezes,
    renderHotkey,
    renderMemoryDump,
    renderRecentFiles,
    renderRegisters,
    renderScriptConsole,
    restoreAfterFileLoad,
    runCommand,
    runDebuggerInstruction,
    runIsolatedScript: (code, timeoutMs) => scriptRunner.run(code, timeoutMs),
    runSandboxBoundarySelfTest: () => sandboxBoundarySelfTest.run(),
    runTraceStepper,
    runUntilNextBranchOrReturn,
    runUntilTrueNextBranch,
    saveKeymap,
    scriptSummary,
    listPScriptMcps,
    callPScriptMcp,
    setKey,
    setTouchState,
    sha256Hex,
    shouldIncludeDisassemblyBytes,
    snapshotContext,
    splitBinaryBits,
    startPersistentScript,
    state,
    stopAfterFailedStateLoad,
    stopAutoUpdateLoop,
    stopPersistentScript,
    swap16,
    swap32,
    syncNativeBreakStatus,
    tick,
    toButtonList,
    u16FromBytes,
    u32FromBytes,
    ui,
    uiInteractionLock,
    updateStatus,
    wakeEmulationLoop: () => wakeTick,
    waitChecked,
    waitForInputWindow,
    writeAnalysisBaseline,
    writeRomFile
});
Object.assign(apiDescriptions, {
    reg: "memoryGetRegisterの短縮名です。",
    regw: "memorySetRegisterの短縮名です。",
    read8: "memoryReadByteの短縮名です。",
    read16: "memoryReadWordの短縮名です。",
    read32: "memoryReadDwordの短縮名です。",
    write8: "memoryWriteByteの短縮名です。",
    write16: "memoryWriteWordの短縮名です。",
    write32: "memoryWriteDwordの短縮名です。"
});

const inputSequenceService = createInputSequenceService({
    responder: mcpResponder,
    press: setKey,
    releaseAll: releaseAllKeys,
    touch: (active, x = 0, y = 0) => setTouchState(active, x, y),
    stepFrames: (frames) => commands.stepFrames({ frames, pauseWhenRunning: false }),
    getPauseDetails: () => describeInputPause(state, nativeBridge),
    waitForInputWindow,
    resume: () => commands.resume(withInternalMetadata({}, { operation: true }))
});
const operationManager = createOperationManager({
    responder: mcpResponder,
    pause: async () => {
        state.paused = true;
        state.running = false;
        if (state.ready) nativeBridge.pause(true);
    },
    releaseInput: async () => { releaseAllKeys(); setTouchState(false); }
});
inputRecordingService = createInputRecordingService({
    responder: mcpResponder,
    idbGet,
    idbPut,
    idbDelete,
    idbDeleteMany,
    idbKeys,
    frameService,
    pauseEventService,
    fileTransactionEventService,
    subscribeInputMutations,
    getInputSnapshot,
    applyInputSnapshot: ({ keyMask, touchActive, x, y }) => {
        for (const [button, bit] of Object.entries(state.buttons)) {
            setKey(button, (Number(keyMask) & (1 << bit)) !== 0);
        }
        setTouchState(touchActive, x, y);
    },
    releaseInput: () => {
        releaseAllKeys();
        setTouchState(false, 0, 0);
    },
    getFrame: () => Number(state.frame || 0),
    getActivity: () => ({ paused: !!state.paused, running: !!state.running }),
    getCpuState: () => ({
        arm9: {
            pc: Number(getRegisters("arm9").pc) >>> 0,
            cpsr: Number(getRegisters("arm9").cpsr) >>> 0
        },
        arm7: {
            pc: Number(getRegisters("arm7").pc) >>> 0,
            cpsr: Number(getRegisters("arm7").cpsr) >>> 0
        }
    }),
    currentRomIdentity,
    sha256Hex,
    saveStateBytes: () => nativeBridge.saveStateBytes(),
    commands,
    waitForInputWindow,
    cancelInputTasksForOperation: (signal) => inputTaskManager.cancelAndWaitForParent(
        signal,
        "recording-ended"
    )
});
window.addEventListener("beforeunload", () => operationManager.cancel("page-unload"));

registerWaitCommands({
    commands,
    descriptions: apiDescriptions,
    responder: mcpResponder,
    operationManager,
    breakpointOwners,
    breakpointService,
    scriptPauseService,
    pauseEventService,
    stateLoadEventService,
    fileTransactionEventService,
    frameService,
    inputSequenceService,
    inputRecordingService,
    getNativeStatus,
    parseAddress,
    hex,
    getFrame: () => state.frame,
    getActivity: () => ({
        paused: !!state.paused,
        running: !!state.running,
        frame: Number(state.frame || 0)
    })
});

const commandRegistry = createCommandRegistry({ responder: mcpResponder });
commandRegistry.registerAll(commands);
const commandDispatcher = createCommandDispatcher({
    state,
    registry: commandRegistry,
    responder: mcpResponder,
    operationManager,
    hasLoadedRom,
    emulatorActivity,
    refreshDebuggerViews,
    updateStatus,
    log
});

const webMcp = registerWebMcp({
    commands,
    descriptions: apiDescriptions,
    responder: mcpResponder,
    runCommand,
    compact: rawOutputText,
    installShortcuts: installGlobalShortcuts,
    logger: log
});

bindUi({
        copyText,
        disasmRefreshParams,
        hasLoadedRom,
        isTypingTarget,
        loadKeymap,
        log,
        normalizeKeyboardCode,
        parseAddress,
        parseNumber,
        queueAutoUpdateLoop,
        readCallStackData,
        readFileFromInput,
        refreshDebuggerViews,
        releaseAllKeys,
        rememberSlot,
        renderBreakpoints,
        renderCallStack,
        renderDisassembly,
        renderFreezes,
        renderHotkey,
        renderMemoryDump,
        renderRecentFiles,
        renderRegisters,
        renderScripts,
        renderStateSlotOptions,
        runCommand,
        selectScript,
        setFollowPc,
        setKey,
        setTouchState,
        state,
        ui,
        updateStatus,
        updateTouch
});

initializedRuntimeApi = window.DesmumeMCP;
return initializedRuntimeApi;
}
