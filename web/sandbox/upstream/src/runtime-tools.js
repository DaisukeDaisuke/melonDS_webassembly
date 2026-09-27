import { nonNegativeNumber } from "./validation.js";

export function createRuntimeTools({ state, getRomWaitMs }) {
    function sleep(milliseconds) {
        return new Promise((resolve) => {
            setTimeout(resolve, Math.max(0, Number(milliseconds) || 0));
        });
    }

    async function waitChecked(milliseconds, deadline = 0, label = "wait") {
        const duration = Math.max(0, Number(milliseconds) || 0);
        if (!duration) return;
        if (deadline && performance.now() + duration > deadline) {
            throw new Error(`${label} timeout`);
        }
        await sleep(duration);
    }

    function bootWaitMs(params = {}) {
        return nonNegativeNumber(
            params.waitMs ?? params.romWaitMs ?? getRomWaitMs() ?? 600,
            "waitMs",
            10000
        );
    }

    function blockSaveFlush(milliseconds = 10000) {
        const until = performance.now() + nonNegativeNumber(milliseconds, "saveFlushBlockMs");
        state.saveFlushBlockedUntil = Math.max(state.saveFlushBlockedUntil, until);
        state.lastSaveFlush = performance.now();
    }

    return Object.freeze({ blockSaveFlush, bootWaitMs, sleep, waitChecked });
}
