import { ErrorCode } from "./error-codes.js";
import { codedError } from "./validation.js";

export function createStateService({
    state,
    native,
    frameService,
    wakeEmulationLoop = () => {},
    onScreenInvalid = () => {},
    onStatusChange = () => {},
    onFault = () => {},
    eventService = null
}) {
    function loadBytes(bytes) {
        return native.loadStateBytes(bytes);
    }

    function invalidateAfterLoad({ showResumeNotice = true } = {}) {
        frameService.invalidateAfterStateLoad();
        state.screenValid = false;
        state.framesSinceStateLoad = 0;
        state.stateLoadSerial++;
        if (state.traceEnabled === true) {
            native.setTraceEnabled(false);
            native.setTraceEnabled(true);
        }
        state.traceStateSynchronized = true;
        onScreenInvalid({ showResumeNotice });
        eventService?.publish({
            stateLoadSerial: Number(state.stateLoadSerial || 0),
            fileTransactionSerial: Number(state.fileTransactionSerial || 0),
            fileTransactionActive: !!state.fileTransactionActive,
            paused: !!state.paused,
            running: !!state.running,
            frame: Number(state.frame || 0)
        });
    }

    function pauseForLoad() {
        const runState = {
            running: state.running,
            paused: state.paused,
            explicitPauseSerial: Number(state.explicitPauseSerial || 0)
        };
        state.loadingFile = true;
        state.running = false;
        state.paused = true;
        state.frameBudget = 0;
        if (state.ready) native.pause(true);
        onStatusChange();
        return runState;
    }

    function restoreAfterLoad(runState) {
        state.loadingFile = false;
        state.lastTick = performance.now();
        state.frameBudget = 0;
        if (state.nativeFault) {
            state.paused = true;
            state.running = false;
            native.pause(true);
            onStatusChange();
            return;
        }
        state.breakLabel = "";
        state.breakRefreshKey = "";
        state.lastBreakKey = "";
        native.clearBreakStatus();
        const explicitlyPausedDuringLoad = Number(state.explicitPauseSerial || 0)
            !== Number(runState.explicitPauseSerial || 0);
        if (runState.running && !runState.paused && !explicitlyPausedDuringLoad) {
            state.paused = false;
            state.running = true;
            native.pause(false);
            const nativePaused = typeof native.isPaused === "function" ? native.isPaused() : false;
            if (nativePaused) {
                state.paused = true;
                state.running = false;
                native.pause(true);
                onStatusChange();
                throw codedError(
                    ErrorCode.NATIVE_ERROR,
                    "file load completed, but native resume did not clear the paused state",
                    { nativePaused: true }
                );
            }
            wakeEmulationLoop();
        } else {
            state.paused = true;
            state.running = false;
            native.pause(true);
        }
        onStatusChange();
    }

    function stopAfterFailedLoad() {
        state.loadingFile = false;
        state.lastTick = performance.now();
        state.frameBudget = 0;
        state.paused = true;
        state.running = false;
        try {
            native.pauseWithoutFaultHandling(true);
        } catch (error) {
            onFault(error, "state load failure pause");
        }
        onStatusChange();
    }

    return Object.freeze({
        invalidateAfterLoad,
        loadBytes,
        pauseForLoad,
        restoreAfterLoad,
        stopAfterFailedLoad
    });
}
