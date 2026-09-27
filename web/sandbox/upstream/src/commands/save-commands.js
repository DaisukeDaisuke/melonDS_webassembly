import { ErrorCode } from "../error-codes.js";
import { codedError } from "../validation.js";

export function createSaveCommands({
    state,
    ui,
    native,
    cancelAndWait = async () => false,
    dispatchScriptEventAndWait = async () => {},
    fileTransactionService = { run: async (reason, task) => task({ commit: async () => {} }) },
    ensureReady,
    ensureRomLoaded,
    readFileFromInput,
    openPicker,
    pauseForFileLoad,
    restoreAfterFileLoad,
    stopAfterFailedLoad,
    applySaveAndReloadRom,
    bootWaitMs,
    rememberSlot,
    idbGet,
    idbPut,
    recordRecentFile,
    download,
    log
}) {
    return Object.freeze({
        async importSaveFile() {
            return fileTransactionService.run("Save import", async ({ commit }) => {
                ensureReady();
                const selection = ui.saveFile.files && ui.saveFile.files[0]
                    ? await readFileFromInput(ui.saveFile)
                    : await openPicker(ui.saveFile);
                const { file, bytes } = selection;
                await cancelAndWait("reset");
                await commit();
                const runState = pauseForFileLoad();
                let loaded = false;
                let lifecycleComplete = false;
                try {
                    const saveLoad = await applySaveAndReloadRom(file.name, bytes, {
                        waitMs: bootWaitMs(),
                        resume: false
                    });
                    const result = saveLoad.ret;
                    if (result !== 0) throw codedError(ErrorCode.NATIVE_ERROR, `Save import failed (${result})`, { nativeCode: result });
                    loaded = true;
                    if (result === 0) {
                        rememberSlot(ui.stateSlot.value);
                        await idbPut(`save:${ui.stateSlot.value}`, bytes);
                        await recordRecentFile("save", file.name, bytes, ui.stateSlot.value);
                        ui.storageStatus.textContent = `save loaded ${ui.stateSlot.value}`;
                    }
                    await dispatchScriptEventAndWait("start", {
                        generation: ++state.scriptStartGeneration,
                        reason: "importSaveFile"
                    });
                    lifecycleComplete = true;
                    log(`save imported via ${saveLoad.path}: ${file.name}`);
                    return {
                        ret: result,
                        size: bytes.length,
                        reset: result === 0,
                        reloaded: result === 0,
                        path: saveLoad.path
                    };
                } finally {
                    if (loaded && lifecycleComplete) restoreAfterFileLoad(runState);
                    else stopAfterFailedLoad();
                }
            });
        },

        async exportSaveFile() {
            ensureRomLoaded("save export requires a loaded ROM");
            const bytes = native.exportSaveBytes();
            if (!bytes.length) throw codedError(
                ErrorCode.NATIVE_ERROR,
                "Save export produced an empty buffer",
                { size: 0 }
            );
            download("desmume-save.sav", bytes);
            return { ok: true, size: bytes.length };
        },

        async saveSaveSlot(params = {}) {
            ensureRomLoaded("save slot export requires a loaded ROM");
            const slot = String(params.slot ?? ui.stateSlot.value);
            rememberSlot(slot);
            const bytes = native.exportSaveBytes();
            if (!bytes.length) throw codedError(
                ErrorCode.NATIVE_ERROR,
                "Save export produced an empty buffer",
                { size: 0 }
            );
            await idbPut(`save:${slot}`, bytes);
            await recordRecentFile("save", slot, bytes, slot);
            ui.storageStatus.textContent = `save saved ${slot}`;
            return { ok: true, slot, size: bytes.length };
        },

        async loadSaveSlot(params = {}) {
            return fileTransactionService.run("Save slot load", async ({ commit }) => {
                ensureReady();
                const slot = String(params.slot ?? ui.stateSlot.value);
                rememberSlot(slot);
                const bytes = await idbGet(`save:${slot}`);
                if (!bytes) throw new Error(`save slot not found: ${slot}`);
                await cancelAndWait("reset");
                await commit();
                const runState = pauseForFileLoad();
                let loaded = false;
                let lifecycleComplete = false;
                try {
                    const saveLoad = await applySaveAndReloadRom(slot, bytes, {
                        waitMs: bootWaitMs(),
                        resume: false
                    });
                    const result = saveLoad.ret;
                    if (result !== 0) throw codedError(ErrorCode.NATIVE_ERROR, `Save load failed (${result})`, { nativeCode: result });
                    loaded = true;
                    ui.storageStatus.textContent = `save loaded ${slot}`;
                    await recordRecentFile("save", slot, bytes, slot);
                    await dispatchScriptEventAndWait("start", {
                        generation: ++state.scriptStartGeneration,
                        reason: "loadSaveSlot"
                    });
                    lifecycleComplete = true;
                    return {
                        ret: result,
                        slot,
                        size: bytes.length,
                        reset: result === 0,
                        reloaded: result === 0,
                        paused: runState.paused,
                        path: saveLoad.path
                    };
                } finally {
                    if (loaded && lifecycleComplete) restoreAfterFileLoad(runState);
                    else stopAfterFailedLoad();
                }
            });
        }
    });
}
