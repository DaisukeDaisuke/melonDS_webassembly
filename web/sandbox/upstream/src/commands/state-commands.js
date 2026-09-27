import { getInternalMetadata } from "../internal-command-metadata.js";
import { ErrorCode } from "../error-codes.js";
import { codedError, nonNegativeNumber } from "../validation.js";

export function createStateCommands(context) {
    const {
        analysisBaselineSlotToken,
        blockSaveFlush,
        bytesFromParams,
        cancelAndWait = async () => false,
        dispatchScriptEvent,
        dispatchScriptEventAndWait,
        download,
        drawLoadedStateFrame,
        ensureReady,
        ensureRomLoaded,
        idbGet,
        idbPut,
        isAnalysisBaselineSlot,
        loadStateBytesFromMemory,
        log,
        native,
        fileTransactionService = { run: async (reason, task) => task({ commit: async () => {} }) },
        openPicker,
        pauseForFileLoad,
        readFileFromInput,
        recordRecentFile,
        rememberSlot,
        restoreAfterFileLoad,
        state,
        stopAfterFailedStateLoad,
        ui
    } = context;
    const waitForScriptEvent = typeof dispatchScriptEventAndWait === "function"
        ? dispatchScriptEventAndWait
        : async (event, payload) => dispatchScriptEvent?.(event, payload);

    const stateCommands = {
        async saveState(params = {}) {
            ensureRomLoaded("state save requires a loaded ROM");
            if (isAnalysisBaselineSlot(params.slot)
                && getInternalMetadata(params).analysisBaselineSlotToken !== analysisBaselineSlotToken) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "analysis baseline slots are reserved");
            }
            const bytes = native.saveStateBytes();
            const size = bytes.length;
            if (params.slot) {
                if (!isAnalysisBaselineSlot(params.slot)) rememberSlot(params.slot);
                if (bytes.length > 256 * 1024 * 1024) {
                    throw codedError(
                        ErrorCode.INVALID_ARGUMENT,
                        "state exceeds 256MB browser storage limit"
                    );
                }
                await idbPut(String(params.slot), bytes);
                if (!isAnalysisBaselineSlot(params.slot)) {
                    await recordRecentFile("state", String(params.slot), bytes, String(params.slot));
                }
                ui.storageStatus.textContent = `state saved ${params.slot}`;
            }
            dispatchScriptEvent("stateSave", { size, slot: params.slot || null });
            return { ok: true, size };
        },

        async loadState(params = {}) {
            ensureRomLoaded("state load requires a loaded ROM");
            const saveFlushBlockMs = nonNegativeNumber(
                params.saveFlushBlockMs ?? 30000,
                "saveFlushBlockMs"
            );
            if (isAnalysisBaselineSlot(params.slot)
                && getInternalMetadata(params).analysisBaselineSlotToken !== analysisBaselineSlotToken) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "analysis baseline slots are reserved");
            }
            const metadata = getInternalMetadata(params);
            const ownerToken = metadata.fileTransactionToken ?? null;
            return fileTransactionService.run("State load", async ({ commit }) => {
                let bytes = null;
                let loaded = false;
                if (params.slot) bytes = await idbGet(String(params.slot));
                if (params.slot && !bytes) {
                    throw codedError(ErrorCode.STATE_NOT_LOADED, `state slot not found: ${params.slot}`);
                }
                if (!metadata.operation) await cancelAndWait("state-load");
                await commit();
                const runState = pauseForFileLoad();
                let lifecycleComplete = false;
                try {
                    if (params.slot && !isAnalysisBaselineSlot(params.slot) && !metadata.recordingReplay) {
                        rememberSlot(params.slot);
                    }
                    const ret = bytes ? loadStateBytesFromMemory(bytes) : native.loadBufferedState();
                    if (ret !== 0) throw codedError(
                        ErrorCode.NATIVE_ERROR,
                        `State load failed (${ret})`,
                        { nativeCode: ret }
                    );
                    loaded = true;
                    state.frame = 0;
                    blockSaveFlush(saveFlushBlockMs);
                    drawLoadedStateFrame({
                        showResumeNotice: !(runState.running && !runState.paused)
                    });
                    await waitForScriptEvent("stateLoad", {
                        slot: params.slot || null,
                        source: "loadState"
                    });
                    lifecycleComplete = true;
                    return { ok: true, paused: runState.paused, reset: false };
                } finally {
                    if (loaded && lifecycleComplete) restoreAfterFileLoad(metadata.holdPaused
                        ? { ...runState, running: false, paused: true }
                        : runState);
                    else stopAfterFailedStateLoad();
                }
            }, ownerToken);
        },

        async importStateFile(params = {}) {
            ensureRomLoaded("state import requires a loaded ROM");
            const saveFlushBlockMs = nonNegativeNumber(
                params.saveFlushBlockMs ?? 30000,
                "saveFlushBlockMs"
            );
            return fileTransactionService.run("State import", async ({ commit }) => {
                const selected = ui.stateFile.files && ui.stateFile.files[0]
                    ? await readFileFromInput(ui.stateFile)
                    : await openPicker(ui.stateFile);
                const { file, bytes } = selected;
                await cancelAndWait("state-load");
                await commit();
                const runState = pauseForFileLoad();
                let loaded = false;
                let lifecycleComplete = false;
                try {
                    const ret = native.loadStateFile(bytes);
                    if (ret !== 0) throw codedError(
                        ErrorCode.NATIVE_ERROR,
                        `State import failed (${ret})`,
                        { nativeCode: ret }
                    );
                    loaded = true;
                    state.frame = 0;
                    blockSaveFlush(saveFlushBlockMs);
                    drawLoadedStateFrame({
                        showResumeNotice: !(runState.running && !runState.paused)
                    });
                    await recordRecentFile("state", file.name, bytes);
                    log(`state imported: ${file.name}`);
                    await waitForScriptEvent("stateLoad", {
                        name: file.name,
                        source: "importStateFile"
                    });
                    lifecycleComplete = true;
                    return { ok: true, ret, size: bytes.length, reset: false, paused: runState.paused };
                } finally {
                    if (loaded && lifecycleComplete) restoreAfterFileLoad(runState);
                    else stopAfterFailedStateLoad();
                }
            });
        },

        async loadStateBytes(params = {}) {
            ensureRomLoaded("state byte load requires a loaded ROM");
            const saveFlushBlockMs = nonNegativeNumber(
                params.saveFlushBlockMs ?? 30000,
                "saveFlushBlockMs"
            );
            return fileTransactionService.run("State byte load", async ({ commit }) => {
                const bytes = bytesFromParams(params);
                await cancelAndWait("state-load");
                await commit();
                const runState = pauseForFileLoad();
                let loaded = false;
                let lifecycleComplete = false;
                try {
                    const ret = native.loadStateFile(bytes);
                    if (ret !== 0) throw codedError(
                        ErrorCode.NATIVE_ERROR,
                        `State byte load failed (${ret})`,
                        { nativeCode: ret }
                    );
                    loaded = true;
                    state.frame = 0;
                    blockSaveFlush(saveFlushBlockMs);
                    drawLoadedStateFrame({
                        showResumeNotice: !(runState.running && !runState.paused)
                    });
                    log(`state loaded from MCP bytes: ${params.name || "mcp-state.dst"}`);
                    await waitForScriptEvent("stateLoad", {
                        name: params.name || "mcp-state.dst",
                        source: "loadStateBytes"
                    });
                    lifecycleComplete = true;
                    return { ok: true, ret, size: bytes.length, reset: false, paused: runState.paused };
                } finally {
                    if (loaded && lifecycleComplete) restoreAfterFileLoad(runState);
                    else stopAfterFailedStateLoad();
                }
            });
        },

        async loadStateUrl(params = {}) {
            ensureRomLoaded("state URL load requires a loaded ROM");
            const url = String(params.url || "");
            if (!url) throw new Error("url is required");
            return fileTransactionService.run("State URL load", async ({ commit }) => {
                const response = await fetch(url, { cache: "no-store" });
                if (!response.ok) throw new Error(`state fetch failed: ${response.status}`);
                const bytes = new Uint8Array(await response.arrayBuffer());
                await cancelAndWait("state-load");
                await commit();
                const runState = pauseForFileLoad();
                let loaded = false;
                let lifecycleComplete = false;
                try {
                    const ret = native.loadStateFile(bytes);
                    if (ret !== 0) throw codedError(
                        ErrorCode.NATIVE_ERROR,
                        `State URL load failed (${ret})`,
                        { nativeCode: ret }
                    );
                    loaded = true;
                    state.frame = 0;
                    blockSaveFlush(nonNegativeNumber(params.saveFlushBlockMs ?? 30000, "saveFlushBlockMs"));
                    drawLoadedStateFrame({
                        showResumeNotice: !(runState.running && !runState.paused)
                    });
                    const name = params.name || url.split("/").pop() || "url-state.dst";
                    log(`state loaded from URL: ${name}`);
                    await waitForScriptEvent("stateLoad", {
                        name,
                        source: "loadStateUrl"
                    });
                    lifecycleComplete = true;
                    return { ok: true, ret, size: bytes.length, reset: false, paused: runState.paused };
                } finally {
                    if (loaded && lifecycleComplete) restoreAfterFileLoad(runState);
                    else stopAfterFailedStateLoad();
                }
            });
        },

        async exportStateFile() {
            ensureRomLoaded("state export requires a loaded ROM");
            const result = await stateCommands.saveState();
            download("desmume-state.dst", native.getStateBufferBytes(result.size));
            return result;
        }
    };

    return stateCommands;
}
