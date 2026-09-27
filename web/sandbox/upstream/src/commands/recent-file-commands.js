import { ErrorCode } from "../error-codes.js";
import { codedError, nonNegativeNumber } from "../validation.js";

export function createRecentFileCommands(context) {
    const {
        applySaveAndReloadRom,
        blockSaveFlush,
        bootWaitMs,
        cancelAndWait = async () => false,
        dispatchScriptEventAndWait = async () => {},
        fileTransactionService = { run: async (reason, task) => task({ commit: async () => {} }) },
        drawLoadedStateFrame,
        ensureReady,
        ensureRomLoaded,
        idbGet,
        loadStateBytesFromMemory,
        native,
        pauseForFileLoad,
        rememberSlot,
        renderRecentFiles,
        restoreAfterFileLoad,
        state,
        stopAfterFailedStateLoad,
        ui
    } = context;

    return {
        async listRecentFiles() {
            renderRecentFiles();
            return { recentFiles: state.recentFiles };
        },

        async reloadRecentFile(params = {}) {
            ensureReady();
            const id = String(params.id ?? ui.recentFileSelect.value);
            const item = state.recentFiles.find((entry) => entry.id === id);
            if (!item) throw new Error(`recent file not found: ${id}`);
            const saveFlushBlockMs = item.kind === "state"
                ? nonNegativeNumber(params.saveFlushBlockMs ?? 30000, "saveFlushBlockMs")
                : 0;
            return fileTransactionService.run("Recent file reload", async ({ commit }) => {
                if (item.slot) rememberSlot(item.slot);
                const bytes = item.key
                    ? await idbGet(item.key)
                    : item.slot
                        ? await idbGet(`${item.kind}:${item.slot}`)
                        : null;
                if (!bytes) throw new Error(`recent bytes not found: ${id}`);
                if (item.kind === "state") {
                    ensureRomLoaded("recent state reload requires a loaded ROM");
                }
                await cancelAndWait(item.kind === "save" ? "reset" : "state-load");
                await commit();

                if (item.kind === "save") {
                    const runState = pauseForFileLoad();
                    let loaded = false;
                    let lifecycleComplete = false;
                    try {
                        const saveLoad = await applySaveAndReloadRom(
                            item.name || item.slot || "save.sav",
                            bytes,
                            { waitMs: bootWaitMs(), resume: false }
                        );
                        const ret = saveLoad.ret;
                        if (ret !== 0) throw codedError(ErrorCode.NATIVE_ERROR, `Recent Save load failed (${ret})`, { nativeCode: ret });
                        loaded = true;
                        await dispatchScriptEventAndWait("start", {
                            generation: ++state.scriptStartGeneration,
                            reason: "reloadRecentSave"
                        });
                        lifecycleComplete = true;
                        return {
                            ret,
                            item,
                            size: bytes.length,
                            reset: ret === 0,
                            reloaded: ret === 0,
                            paused: runState.paused,
                            path: saveLoad.path
                        };
                    } finally {
                        if (loaded && lifecycleComplete) restoreAfterFileLoad(runState);
                        else stopAfterFailedStateLoad();
                    }
                }

                const runState = pauseForFileLoad();
                let loaded = false;
                let lifecycleComplete = false;
                try {
                    const ret = item.slot ? loadStateBytesFromMemory(bytes) : native.loadStateFile(bytes);
                    if (ret !== 0) throw codedError(
                        ErrorCode.NATIVE_ERROR,
                        `Recent State load failed (${ret})`,
                        { nativeCode: ret }
                    );
                    loaded = true;
                    state.frame = 0;
                    blockSaveFlush(saveFlushBlockMs);
                    drawLoadedStateFrame({
                        showResumeNotice: !(runState.running && !runState.paused)
                    });
                    await dispatchScriptEventAndWait("stateLoad", {
                        id,
                        name: item.name || null,
                        slot: item.slot || null,
                        source: "reloadRecentState"
                    });
                    lifecycleComplete = true;
                    return { ok: true, ret, item, size: bytes.length, paused: runState.paused };
                } finally {
                    if (loaded && lifecycleComplete) restoreAfterFileLoad(runState);
                    else stopAfterFailedStateLoad();
                }
            });
        }
    };
}
