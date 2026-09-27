import { ErrorCode } from "./error-codes.js";

const CANCEL_SETTLE_TIMEOUT_MS = 10000;

export function createOperationManager({
    responder,
    pause = async () => {},
    releaseInput = async () => {},
    settleTimeoutMs = CANCEL_SETTLE_TIMEOUT_MS
}) {
    let active = null;
    let serial = 0;

    function cancel(reason = "user-cancel") {
        if (!active) return false;
        active.controller.abort(reason);
        return true;
    }

    async function waitForSettlement(operation) {
        let timer = 0;
        try {
            await Promise.race([
                operation.done,
                new Promise((resolve, reject) => {
                    timer = setTimeout(() => {
                        const error = new Error("Cancelled operation did not settle");
                        error.mcpCode = ErrorCode.TIMEOUT;
                        error.mcpDetails = {
                            operation: operation.name,
                            timeoutMs: settleTimeoutMs
                        };
                        reject(error);
                    }, settleTimeoutMs);
                })
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    async function cancelAndWait(reason = "user-cancel") {
        const operation = active;
        if (!operation) return false;
        operation.controller.abort(reason);
        await waitForSettlement(operation);
        return true;
    }

    async function run({
        name,
        timeoutMs,
        task,
        cleanup = async () => {},
        timeoutDetails = () => ({}),
        cancelDetails = () => ({})
    }) {
        if (active) return responder.fail(ErrorCode.BUSY, `Active operation is ${active.name}`);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "timeoutMs must be between 1 and 600000");
        }
        const controller = new AbortController();
        const operation = {
            id: ++serial,
            name,
            controller,
            signal: controller.signal,
            startedAt: performance.now(),
            startedAtEpochMs: Date.now()
        };
        active = operation;
        let timer = 0;
        let cleaned = false;
        const cleanupOnce = async () => {
            if (cleaned) return;
            cleaned = true;
            let cleanupError;
            try {
                await releaseInput();
            } catch (error) {
                cleanupError = error;
            }
            try {
                await cleanup(operation);
            } catch (error) {
                cleanupError ||= error;
            } finally {
                clearTimeout(timer);
                if (active === operation) active = null;
            }
            if (cleanupError) throw cleanupError;
        };
        const timeoutResult = () => responder.fail(
            ErrorCode.TIMEOUT,
            `${name} timed out`,
            { timeoutMs, ...timeoutDetails(operation) }
        );
        const cancelledResult = () => responder.fail(
            ErrorCode.CANCELLED,
            `${name} was cancelled`,
            { reason: operation.signal.reason, ...cancelDetails(operation) }
        );
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => {
                controller.abort("timeout");
                resolve({ timedOut: true });
            }, timeoutMs);
        });
        const running = Promise.resolve(task(operation)).then((value) => ({
            value
        }), (error) => {
            if (!operation.signal.aborted) throw error;
            return { value: operation.signal.reason === "timeout" ? timeoutResult() : cancelledResult() };
        });
        operation.done = running.then(() => {}, () => {}).finally(cleanupOnce);
        const runBody = async () => {
            const result = await Promise.race([running, timeout]);
            if (result?.timedOut) {
                await pause();
                return timeoutResult();
            }
            if (operation.signal.aborted) {
                await pause();
                return operation.signal.reason === "timeout" ? timeoutResult() : cancelledResult();
            }
            return result.value;
        };
        try {
            return await runBody();
        } finally {
            try {
                await waitForSettlement(operation);
            } catch (error) {
                if (error?.mcpCode !== ErrorCode.TIMEOUT) throw error;
            }
        }
    }

    return {
        run,
        cancel,
        cancelAndWait,
        signalFor: (name) => active?.name === name ? active.signal : null,
        current: () => active && ({
            id: active.id,
            name: active.name,
            startedAt: active.startedAt,
            startedAtEpochMs: active.startedAtEpochMs,
            elapsedMs: Math.max(0, performance.now() - active.startedAt),
            cancelling: active.signal.aborted
        })
    };
}
