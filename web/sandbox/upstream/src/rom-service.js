import { ErrorCode } from "./error-codes.js";
import { codedError } from "./validation.js";

const ROM_PATH = "rom.nds";
const ROM_CANDIDATE_PATH = "__candidate_rom.nds";
const SAVE_PATHS = ["rom.sav", "rom.dsv"];

export function createRomService({
    state,
    native,
    sleep,
    blockSaveFlush,
    drawFrame,
    fileTransactionService,
    cancelPendingScriptEvents = async () => {},
    reconcileNativeBreakpoints = () => ({ cleared: false, registered: 0 })
}) {
    function validateBytes(bytes) {
        if (!bytes || bytes.length < 0x200) throw new Error("ROM data is too small or missing");
        const headerLength = Math.min(bytes.length, 0x200);
        for (let index = 0; index < headerLength; index++) {
            if (bytes[index] !== 0) return;
        }
        throw new Error("ROM header is all zero");
    }

    function write(name, bytes) {
        const romBytes = new Uint8Array(bytes);
        validateBytes(romBytes);
        state.pendingRomCandidate = {
            name: String(name || "rom.nds"),
            bytes: romBytes
        };
        return romBytes.length;
    }

    function snapshotFile(path) {
        return native.fileExists(path) ? native.readFile(path) : null;
    }

    function restoreFile(path, bytes) {
        if (bytes) native.writeFile(path, bytes);
        else native.unlinkFile(path);
    }

    function stageSave(candidateSave) {
        if (!candidateSave) return null;
        const bytes = new Uint8Array(candidateSave.bytes);
        const path = String(candidateSave.name).toLowerCase().endsWith(".dsv") ? "rom.dsv" : "rom.sav";
        const candidatePath = `__candidate_${path}`;
        native.writeFile(candidatePath, bytes);
        for (const livePath of SAVE_PATHS) native.unlinkFile(livePath);
        native.writeFile(path, native.readFile(candidatePath));
        return { path, candidatePath };
    }

    async function reload(options = {}) {
        if (!state.fileTransactionActive && fileTransactionService) {
            return fileTransactionService.run("ROM/save transaction", async ({ commit }) => {
                await commit();
                return reload(options);
            });
        }
        if (!state.fileTransactionActive) {
            state.fileTransactionActive = true;
            state.fileTransactionSerial++;
            state.nativeBreakSerial = Number(state.nativeBreakSerial || 0) + 1;
            state.currentBreakIdentity = null;
            try {
                await cancelPendingScriptEvents("ROM/save transaction started");
                return await reload(options);
            } finally {
                state.fileTransactionActive = false;
            }
        }

        const pending = state.pendingRomCandidate;
        const candidate = pending || (state.romBytes
            ? { name: state.romName || ROM_PATH, bytes: new Uint8Array(state.romBytes) }
            : native.fileExists(ROM_PATH)
                ? { name: ROM_PATH, bytes: native.readFile(ROM_PATH) }
                : null);
        if (!candidate?.bytes?.length) throw new Error("ROM is not loaded");
        validateBytes(candidate.bytes);

        const metadataBefore = {
            romName: state.romName,
            romBytes: state.romBytes,
            romSize: state.romSize,
            romGeneration: state.romGeneration,
            running: state.running,
            paused: state.paused
        };
        const filesBefore = new Map([
            [ROM_PATH, snapshotFile(ROM_PATH)],
            ...SAVE_PATHS.map((path) => [path, snapshotFile(path)])
        ]);
        const oldRomWasLoaded = native.isRomLoaded();
        let saveStage = null;

        try {
            native.pause(true);
            state.running = false;
            state.paused = true;
            state.frameBudget = 0;
            native.writeFile(ROM_CANDIDATE_PATH, candidate.bytes);
            native.writeFile(ROM_PATH, native.readFile(ROM_CANDIDATE_PATH));
            saveStage = stageSave(options.candidateSave);
            await sleep(Number(options.preWaitMs ?? 0));
            const result = native.loadRom(candidate.bytes.length);
            native.pause(true);
            await sleep(Number(options.waitMs ?? 0));
            if (result !== 0) {
                throw codedError(ErrorCode.NATIVE_ERROR, `ROM load failed (${result})`, {
                    nativeCode: result,
                    stage: "native-load"
                });
            }
            reconcileNativeBreakpoints();

            state.nativeFault = false;
            state.romName = candidate.name;
            state.romBytes = new Uint8Array(candidate.bytes);
            state.romSize = candidate.bytes.length;
            state.romGeneration = metadataBefore.romGeneration + 1;
            state.pendingRomCandidate = null;
            state.frame = 0;
            state.previousRegisters = null;
            state.lastBreakKey = "";
            state.breakRefreshKey = "";
            state.breakLabel = "";
            state.traceStateSynchronized = true;
            state.traceEnabled = state.traceEnabled !== false;
            native.setTraceSuspended?.(false);
            native.clearBreakStatus();
            state.running = options.resume === true;
            state.paused = options.resume !== true;
            native.pause(state.paused);
            blockSaveFlush(Number(options.saveFlushBlockMs ?? 10000));
            drawFrame();
            return result;
        } catch (error) {
            state.pendingRomCandidate = null;
            for (const [path, bytes] of filesBefore) restoreFile(path, bytes);
            Object.assign(state, metadataBefore, { running: false, paused: true });
            try {
                if (oldRomWasLoaded && filesBefore.get(ROM_PATH)?.length) {
                    const rollbackResult = native.loadRom(filesBefore.get(ROM_PATH).length);
                    if (rollbackResult !== 0) {
                        throw codedError(ErrorCode.NATIVE_ERROR, `ROM rollback load failed (${rollbackResult})`, {
                            nativeCode: rollbackResult,
                            rollbackStage: "native-load"
                        });
                    }
                    await sleep(Number(options.rollbackWaitMs ?? options.waitMs ?? 0));
                    if (!native.isRomLoaded()) {
                        throw codedError(ErrorCode.NATIVE_ERROR, "ROM rollback did not restore native loaded state", {
                            rollbackStage: "native-loaded-gate"
                        });
                    }
                    reconcileNativeBreakpoints();
                }
            } catch (rollbackError) {
                state.breakpointsInSync = false;
                error.mcpDetails = {
                    ...(error.mcpDetails || {}),
                    rollbackFailed: true,
                    nativeCode: rollbackError?.mcpDetails?.nativeCode,
                    rollbackStage: rollbackError?.mcpDetails?.rollbackStage || "breakpoint-reconcile",
                    breakpointsInSync: false,
                    rollbackMessage: String(rollbackError?.message || rollbackError).slice(0, 300)
                };
            }
            try { native.pause(true); } catch {}
            throw error;
        } finally {
            try { native.unlinkFile(ROM_CANDIDATE_PATH); } catch {}
            for (const path of [saveStage?.candidatePath, "__candidate_rom.sav", "__candidate_rom.dsv"].filter(Boolean)) {
                try { native.unlinkFile(path); } catch {}
            }
        }
    }

    return Object.freeze({ reload, validateBytes, write });
}
