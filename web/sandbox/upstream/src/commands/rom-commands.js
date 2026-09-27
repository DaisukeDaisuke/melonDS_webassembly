import { ErrorCode } from "../error-codes.js";
import { codedError } from "../validation.js";

export function createRomCommands({
    state,
    ui,
    native,
    cancelAndWait = async () => false,
    dispatchScriptEventAndWait = async () => {},
    fileTransactionService = { run: async (reason, task) => task({ commit: async () => {} }) },
    ensureReady,
    ensureWasmReady,
    bytesFromParams,
    readFileFromInput,
    openPicker,
    pauseForFileLoad,
    restoreAfterFileLoad,
    stopAfterFailedLoad,
    writeRomFile,
    reloadCurrentRom,
    bootWaitMs,
    log
}) {
    const commands = {
        async loadRomFile() {
            return fileTransactionService.run("ROM file load", async ({ commit }) => {
                const selection = ui.romFile.files && ui.romFile.files[0]
                    ? await readFileFromInput(ui.romFile)
                    : await openPicker(ui.romFile);
                const { file, bytes } = selection;
                await ensureWasmReady();
                await cancelAndWait("rom-load");
                await commit();
                const runState = pauseForFileLoad();
                let loaded = false;
                let lifecycleComplete = false;
                try {
                    writeRomFile(file.name, bytes);
                    const result = await reloadCurrentRom({ waitMs: bootWaitMs(), resume: false });
                    if (result !== 0) throw codedError(ErrorCode.NATIVE_ERROR, `ROM load failed (${result})`, { nativeCode: result });
                    loaded = true;
                    await dispatchScriptEventAndWait("start", {
                        generation: ++state.scriptStartGeneration,
                        reason: "loadRomFile"
                    });
                    lifecycleComplete = true;
                    log(`ROM loaded: ${file.name} (${bytes.length} bytes)`);
                    return {
                        ret: result,
                        name: file.name,
                        size: bytes.length,
                        waitMs: bootWaitMs(),
                        romLoaded: native.isRomLoaded()
                    };
                } finally {
                    if (loaded && lifecycleComplete) {
                        restoreAfterFileLoad({ ...runState, running: true, paused: false });
                    }
                    else stopAfterFailedLoad();
                }
            });
        },

        async loadRomBytes(params = {}) {
            return fileTransactionService.run("ROM byte load", async ({ commit }) => {
                const bytes = bytesFromParams(params);
                await ensureWasmReady();
                await cancelAndWait("rom-load");
                await commit();
                const runState = pauseForFileLoad();
                const resume = params.resume !== false;
                const name = params.name || "mcp-rom.nds";
                let loaded = false;
                let lifecycleComplete = false;
                try {
                    writeRomFile(name, bytes);
                    const result = await reloadCurrentRom({ waitMs: bootWaitMs(params), resume: false });
                    if (result !== 0) throw codedError(ErrorCode.NATIVE_ERROR, `ROM load failed (${result})`, { nativeCode: result });
                    loaded = true;
                    await dispatchScriptEventAndWait("start", {
                        generation: ++state.scriptStartGeneration,
                        reason: "loadRomBytes"
                    });
                    lifecycleComplete = true;
                    log(`ROM loaded from MCP bytes: ${name} (${bytes.length} bytes)`);
                    return {
                        ret: result,
                        name,
                        size: bytes.length,
                        waitMs: bootWaitMs(params),
                        romLoaded: native.isRomLoaded()
                    };
                } finally {
                    if (loaded && lifecycleComplete) {
                        restoreAfterFileLoad({ ...runState, running: resume, paused: !resume });
                    }
                    else stopAfterFailedLoad();
                }
            });
        },

        async loadRomUrl(params = {}) {
            return fileTransactionService.run("ROM URL load", async ({ commit }) => {
                ensureReady();
                const url = String(params.url || "");
                if (!url) throw codedError(ErrorCode.INVALID_ARGUMENT, "url is required");
                let response;
                try {
                    response = await fetch(url, { cache: "no-store" });
                } catch (error) {
                    throw codedError(ErrorCode.INVALID_ARGUMENT, "ROM URL could not be fetched", {
                        message: String(error?.message || error)
                    });
                }
                if (!response.ok) throw codedError(ErrorCode.INVALID_ARGUMENT, `ROM fetch failed: ${response.status}`);
                const bytes = new Uint8Array(await response.arrayBuffer());
                await ensureWasmReady();
                await cancelAndWait("rom-load");
                await commit();
                const runState = pauseForFileLoad();
                const resume = params.resume !== false;
                const name = params.name || url.split("/").pop() || "url-rom.nds";
                let loaded = false;
                let lifecycleComplete = false;
                try {
                    writeRomFile(name, bytes);
                    const result = await reloadCurrentRom({ waitMs: bootWaitMs(params), resume: false });
                    if (result !== 0) throw codedError(ErrorCode.NATIVE_ERROR, `ROM load failed (${result})`, { nativeCode: result });
                    loaded = true;
                    await dispatchScriptEventAndWait("start", {
                        generation: ++state.scriptStartGeneration,
                        reason: "loadRomUrl"
                    });
                    lifecycleComplete = true;
                    log(`ROM loaded from URL: ${name} (${bytes.length} bytes)`);
                    return {
                        ret: result,
                        name,
                        size: bytes.length,
                        waitMs: bootWaitMs(params),
                        romLoaded: native.isRomLoaded()
                    };
                } finally {
                    if (loaded && lifecycleComplete) {
                        restoreAfterFileLoad({ ...runState, running: resume, paused: !resume });
                    }
                    else stopAfterFailedLoad();
                }
            });
        }
    };

    return Object.freeze(commands);
}
