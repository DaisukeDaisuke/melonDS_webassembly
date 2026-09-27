import { getInternalMetadata } from "../internal-command-metadata.js";
import { ErrorCode } from "../error-codes.js";
import { codedError, finiteNumber, positiveInteger } from "../validation.js";
import { completeFrames } from "../frame-completion.js";

const ALLOWED_SPEEDS = new Set([0.25, 0.5, 1, 1.5, 2, 3, 4]);
const ALLOWED_SCALES = new Set([1, 1.5, 2, 2.5, 3, 3.5, 4]);
const ALLOWED_ROTATIONS = new Set([0, 90, 180, 270]);

export function createRuntimeCommands(context) {
    const {
        applyFreezes,
        applyScaleRotation,
        bootWaitMs,
        cancelAndWait = async () => false,
        cancelOperation,
        fileTransactionService = { run: async (reason, task) => task({ commit: async () => {} }) },
        dispatchScriptEvent,
        dispatchScriptEventAndWait,
        drawFrame,
        ensureReady,
        ensureRomLoaded,
        frameService,
        hasLoadedRom,
        native,
        onScreenValid = () => {},
        pauseEventService = null,
        pauseForFileLoad,
        pumpAudio,
        queueAutoUpdateLoop,
        reloadCurrentRom,
        restoreAfterFileLoad,
        state,
        stopAfterFailedLoad,
        stopAutoUpdateLoop,
        syncNativeBreakStatus,
        ui,
        updateStatus
    } = context;
    const wakeEmulationLoop = typeof context.wakeEmulationLoop === "function"
        ? context.wakeEmulationLoop
        : () => {};
    const waitForScriptEvent = typeof dispatchScriptEventAndWait === "function"
        ? dispatchScriptEventAndWait
        : async (event, payload) => dispatchScriptEvent?.(event, payload);

    function resetRealtimePacing() {
        const now = performance.now();
        state.lastTick = now;
        state.frameBudget = 0;
        state.effectiveFps = 0;
        state.fpsSampleTime = now;
        state.fpsSampleFrame = state.frame;
    }

    const commands = {
        async setAutoUpdate(params = {}) {
            const hz = finiteNumber(params.hz ?? params.rate ?? ui.autoUpdateRate.value, "hz", 1, 20);
            state.autoUpdate.enabled = !!params.enabled;
            state.autoUpdate.hz = hz;
            ui.autoUpdateToggle.checked = state.autoUpdate.enabled;
            ui.autoUpdateRate.value = String(state.autoUpdate.hz);
            if (state.autoUpdate.enabled) queueAutoUpdateLoop();
            else stopAutoUpdateLoop();
            return { enabled: state.autoUpdate.enabled, hz: state.autoUpdate.hz };
        },

        async pause(params = {}) {
            const metadata = getInternalMetadata(params);
            if (!metadata.operation && !metadata.scriptCallback) cancelOperation("pause");
            ensureReady();
            state.explicitPauseSerial++;
            state.paused = true;
            state.running = false;
            state.effectiveFps = 0;
            native.pause(true);
            if (!metadata.operation && !metadata.scriptCallback) {
                pauseEventService?.publish({
                    pauseKind: "manual",
                    frame: Number(state.frame || 0)
                });
            }
            updateStatus();
            return { ok: true };
        },

        async resume() {
            ensureReady();
            if (!hasLoadedRom()) {
                state.breakLabel = "ROM not loaded";
                state.paused = true;
                state.running = false;
                native.pause(true);
                updateStatus();
                throw codedError(ErrorCode.ROM_NOT_LOADED, "ROM is not loaded", { romLoaded: false });
            }
            state.breakLabel = "";
            state.breakRefreshKey = "";
            state.lastBreakKey = "";
            state.paused = false;
            state.running = true;
            resetRealtimePacing();
            native.clearBreakStatus();
            native.pause(false);
            const nativePaused = typeof native.isPaused === "function" ? native.isPaused() : false;
            if (nativePaused) {
                state.paused = true;
                state.running = false;
                updateStatus();
                throw codedError(
                    ErrorCode.NATIVE_ERROR,
                    "resume did not clear the native paused state",
                    { nativePaused: true }
                );
            }
            wakeEmulationLoop();
            onScreenValid();
            updateStatus();
            return {
                ok: true,
                romLoaded: true,
                resumed: true,
                paused: false,
                running: true,
                nativePaused: false
            };
        },

        async reset(params = {}) {
            ensureRomLoaded("reset requires a loaded ROM");
            return fileTransactionService.run("ROM reset", async ({ commit }) => {
                await cancelAndWait("reset");
                await commit();
                const runState = pauseForFileLoad();
                const hold = params.holdPaused ?? params.hold ?? ui.resetHoldToggle.checked;
                let loaded = false;
                let lifecycleComplete = false;
                try {
                    const result = await reloadCurrentRom({
                        waitMs: bootWaitMs(params),
                        resume: false
                    });
                    if (result !== 0) throw codedError(ErrorCode.NATIVE_ERROR, `ROM reset failed (${result})`, { nativeCode: result });
                    loaded = true;
                    if (result === 0) {
                        await waitForScriptEvent("start", {
                            generation: ++state.scriptStartGeneration,
                            reason: "reset"
                        });
                        lifecycleComplete = true;
                    }
                    return {
                        ret: result,
                        reloaded: true,
                        held: !!hold,
                        waitMs: bootWaitMs(params),
                        romLoaded: native.isRomLoaded()
                    };
                } finally {
                    if (loaded && lifecycleComplete) restoreAfterFileLoad(
                        hold ? { ...runState, running: false, paused: true } : runState
                    );
                    else stopAfterFailedLoad();
                }
            });
        },

        async reloadRom(params = {}) {
            ensureRomLoaded("ROM reload requires a loaded ROM");
            return fileTransactionService.run("ROM reload", async ({ commit }) => {
                await cancelAndWait("rom-load");
                await commit();
                const runState = pauseForFileLoad();
                const resume = params.resume === true
                    || (params.resume !== false
                        && runState.running
                        && !runState.paused
                        && !ui.resetHoldToggle.checked);
                let loaded = false;
                let lifecycleComplete = false;
                try {
                    const result = await reloadCurrentRom({ waitMs: bootWaitMs(params), resume: false });
                    if (result !== 0) throw codedError(ErrorCode.NATIVE_ERROR, `ROM reload failed (${result})`, { nativeCode: result });
                    loaded = true;
                    if (result === 0) {
                        await waitForScriptEvent("start", {
                            generation: ++state.scriptStartGeneration,
                            reason: "reloadRom"
                        });
                        lifecycleComplete = true;
                    }
                    return {
                        ret: result,
                        reloaded: true,
                        resumed: resume,
                        waitMs: bootWaitMs(params),
                        romLoaded: native.isRomLoaded()
                    };
                } finally {
                    if (loaded && lifecycleComplete) restoreAfterFileLoad(
                        resume ? runState : { ...runState, running: false, paused: true }
                    );
                    else stopAfterFailedLoad();
                }
            });
        },

        async setSpeed(params = {}) {
            const speed = Number(params.speed ?? params.value ?? 1);
            if (!ALLOWED_SPEEDS.has(speed)) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "speed must be one of 0.25, 0.5, 1, 1.5, 2, 3, or 4");
            }
            state.speed = speed;
            resetRealtimePacing();
            ui.speedSelect.value = String(state.speed);
            updateStatus();
            return { speed: state.speed };
        },

        async stepFrames(params) {
            ensureRomLoaded("frame stepping requires a loaded ROM");
            if (state.running && !state.paused && params.pauseWhenRunning !== false) {
                return commands.pause();
            }
            const frames = positiveInteger(params.frames ?? 1, "frames", 1000000);
            const frameBefore = state.frame;
            const wasPaused = state.paused;
            let ran = 0;
            let completed = 0;
            let hitBreak = false;
            let result;
            let primaryError = null;
            let cleanupError = null;
            native.pause(false);
            try {
                applyFreezes();
                if (state.touch.active) {
                    for (let index = 0; index < frames; index++) {
                        const frameResult = native.runFrame({
                            render: state.render && index === frames - 1,
                            keys: state.keys,
                            touch: state.touch
                        });
                        ran++;
                        if (frameResult > 0) break;
                    }
                } else {
                    ran = native.runFrames(frames, { render: state.render, keys: state.keys });
                }
                const nativeStatus = syncNativeBreakStatus();
                hitBreak = !!nativeStatus?.lastBreak?.hit;
                completed = completeFrames({ state, frameService, frameBefore, onComplete: onScreenValid });
                applyFreezes();
                drawFrame();
                if (completed > 0) pumpAudio(completed);
                for (let index = 0; index < completed; index++) {
                    dispatchScriptEvent("tick", {
                        frame: state.frame - completed + index + 1,
                        cpu: state.selectedCpu
                    });
                }
                result = { frames: completed, attempted: ran, requested: frames };
            } catch (error) {
                primaryError = error;
            } finally {
                const shouldPause = wasPaused || completed < frames || hitBreak || !!state.nativeFault;
                try {
                    native.pause(shouldPause);
                } catch (error) {
                    cleanupError = error;
                }
                state.paused = shouldPause;
                state.running = !shouldPause;
                try {
                    updateStatus();
                } catch (error) {
                    cleanupError ||= error;
                }
            }
            if (primaryError) throw primaryError;
            if (cleanupError) throw cleanupError;
            return { ...result, paused: state.paused };
        },

        async setRenderEnabled(params) {
            state.render = !!params.enabled;
            ui.renderToggle.checked = state.render;
            return { render: state.render };
        },

        async setAudio(params) {
            const volume = finiteNumber(params.volume ?? ui.volumeRange.value, "volume", 0, 1);
            state.audio = !!params.enabled;
            ui.audioToggle.checked = state.audio;
            ui.volumeRange.value = volume;
            if (state.audio && state.audioContext?.state === "suspended") {
                await state.audioContext.resume();
            }
            return { audio: state.audio, volume };
        },

        async setScale(params = {}) {
            const scale = Number(params.scale ?? params.value ?? 2);
            if (!ALLOWED_SCALES.has(scale)) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "scale must be one of 1, 1.5, 2, 2.5, 3, 3.5, or 4");
            }
            state.scale = scale;
            ui.scaleSelect.value = String(state.scale);
            applyScaleRotation();
            return { scale: state.scale };
        },

        async setRotation(params = {}) {
            const rotation = Number(params.rotation ?? params.value ?? 0);
            if (!ALLOWED_ROTATIONS.has(rotation)) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "rotation must be 0, 90, 180, or 270");
            }
            state.rotation = rotation;
            ui.rotationSelect.value = String(state.rotation);
            applyScaleRotation();
            return { rotation: state.rotation };
        }
    };

    return Object.freeze(commands);
}
