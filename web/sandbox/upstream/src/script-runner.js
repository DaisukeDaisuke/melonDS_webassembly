import { ErrorCode } from "./error-codes.js";
import { createEmbeddedWorker } from "./worker-host.js";
import { validateWorkerRpc } from "./script-rpc-policy.js";
import { ResourceLimits } from "./resource-limits.js";
import acornDependency from "./dependencies/acorn.dependency-source.js";
import { normalizeBoundedValue } from "./bounded-value.js";

export function createScriptRunner({
    source,
    sandboxSource,
    parserSource,
    responder,
    callCommand,
    getShortcuts = () => [],
    createWorker = createEmbeddedWorker,
    startupTimeoutMs = 3000
}) {
    let activeWorkers = 0;

    async function run(code, timeoutMs = 3000) {
        if (typeof code !== "string" || !code.trim() || code.length > 262144) {
            return responder.fail(
                ErrorCode.SCRIPT_SOURCE_INVALID,
                "Script source must be a non-empty string up to 262144 characters"
            );
        }
        const timeout = Number(timeoutMs);
        if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600000) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "timeoutMs must be between 1 and 600000");
        }
        if (activeWorkers >= ResourceLimits.concurrentEvalWorkers) {
            return responder.fail(ErrorCode.BUSY, "All isolated eval Worker slots are busy", {
                active: activeWorkers,
                maximum: ResourceLimits.concurrentEvalWorkers,
                queueMaximum: 0
            });
        }
        let host;
        try {
            host = createWorker(source);
        } catch (error) {
            return responder.fail(ErrorCode.WORKER_START_FAILED, "Script Worker could not be started", {
                errorName: String(error?.name || "Error"),
                message: String(error?.message || error)
            });
        }
        const { worker } = host;
        activeWorkers++;
        return new Promise((resolve) => {
            let finished = false;
            let ready = false;
            const seenRequestIds = new Set();
            const finish = (result) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                host.dispose();
                activeWorkers--;
                resolve(result);
            };
            let timer = setTimeout(() => finish(responder.fail(
                ErrorCode.WORKER_START_FAILED,
                "Script Worker did not complete its startup handshake",
                { timeoutMs: startupTimeoutMs }
            )), startupTimeoutMs);
            worker.onmessage = async (event) => {
                const message = event.data || {};
                if (message.type === "ready" && !ready
                    && message.hardened === true && message.layer === "supervisor") {
                    ready = true;
                    clearTimeout(timer);
                    timer = setTimeout(() => finish(responder.fail(
                        ErrorCode.TIMEOUT,
                        "Script execution timed out",
                        { timeoutMs: timeout }
                    )), timeout);
                    try {
                        worker.postMessage({
                            type: "run",
                            code,
                            shortcuts: getShortcuts(),
                            parserSource,
                            sandboxSource,
                            dependency: acornDependency
                        });
                    } catch (error) {
                        finish(responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Script request could not be sent", {
                            message: String(error?.message || error)
                        }));
                    }
                    return;
                }
                if (message.type === "call") {
                    if (!ready) {
                        finish(responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Script Worker sent RPC before ready"));
                        return;
                    }
                    try {
                        if (seenRequestIds.size >= ResourceLimits.pendingWorkerRpc) {
                            finish(responder.fail(ErrorCode.BUSY, "Script Worker exceeded its pending RPC limit", {
                                maximum: ResourceLimits.pendingWorkerRpc
                            }));
                            return;
                        }
                        const request = validateWorkerRpc(message, seenRequestIds);
                        try {
                            const result = await callCommand(request.command, request.params);
                            if (!finished) worker.postMessage({ replyId: message.id, result });
                        } finally {
                            seenRequestIds.delete(message.id);
                        }
                    } catch (error) {
                        finish(responder.fail(
                            error?.mcpCode || ErrorCode.WORKER_PROTOCOL_ERROR,
                            String(error?.message || error)
                        ));
                    }
                    return;
                }
                if (message.type === "done" && ready) {
                    try {
                        finish(responder.ok({ value: normalizeBoundedValue(message.result).value }));
                    } catch (error) {
                        finish(responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, String(error?.message || error)));
                    }
                    return;
                }
                if (message.type === "error" && ready) {
                    const phase = message.error?.details?.phase;
                    const codeName = phase === "compile" ? ErrorCode.SCRIPT_COMPILE_ERROR : ErrorCode.SCRIPT_RUNTIME_ERROR;
                    finish(responder.fail(codeName, message.error?.message || "Script execution failed", message.error?.details));
                    return;
                }
                if (message.type === "protocolError") {
                    finish(responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, message.message || "Script Worker protocol error"));
                    return;
                }
                finish(responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Script Worker sent an unknown message"));
            };
            worker.onerror = (event) => finish(responder.fail(ready ? ErrorCode.WORKER_CRASHED : ErrorCode.WORKER_START_FAILED, ready ? "Script Worker crashed" : "Script Worker failed during startup", {
                message: String(event.message || "Worker error")
            }));
            worker.onmessageerror = () => finish(responder.fail(
                ErrorCode.WORKER_PROTOCOL_ERROR,
                "Script Worker returned an unreadable message"
            ));
        });
    }

    return { run };
}
