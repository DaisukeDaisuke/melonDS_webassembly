import { ErrorCode } from "./error-codes.js";
import { codedError, subscribeAbort } from "./validation.js";

export function createInputWindow({ pauseEventService }) {
    return function waitForInputWindow(milliseconds, {
        signal,
        deadline = 0,
        label = "input"
    } = {}) {
        const duration = Math.max(0, Number(milliseconds) || 0);
        if (deadline && performance.now() + duration > deadline) {
            throw codedError(ErrorCode.TIMEOUT, `${label} timeout`);
        }
        const afterSerial = pauseEventService.currentSerial();
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer = 0;
            let unsubscribeAbort = () => {};
            let unsubscribePause = () => {};
            const cleanup = () => {
                clearTimeout(timer);
                unsubscribeAbort();
                unsubscribePause();
            };
            const settle = (method, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                method(value);
            };
            unsubscribePause = pauseEventService.subscribe((event) => {
                if (event.serial <= afterSerial) return;
                settle(reject, codedError(
                    ErrorCode.INPUT_UNAVAILABLE,
                    `input is unavailable while emulator is paused (${event.pauseKind || "manual"})`,
                    event
                ));
            });
            unsubscribeAbort = subscribeAbort(signal, () => {
                settle(reject, new DOMException("aborted", "AbortError"));
            });
            if (duration === 0) {
                queueMicrotask(() => settle(resolve));
            } else {
                timer = setTimeout(() => settle(resolve), duration);
            }
        });
    };
}
