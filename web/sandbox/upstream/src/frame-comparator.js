import { ErrorCode } from "./error-codes.js";
import { compareFramePixels } from "./frame-diff/index.js";
import { createEmbeddedWorker } from "./worker-host.js";
import algorithmWorkerSource from "./workers/algorithm.worker.js";
import { normalizeArea } from "./frame-diff/common.js";
import { isValidAlgorithmWorkerResult } from "./frame-comparator-result.js";
import ssimDependency from "./dependencies/ssim.dependency-source.js";

export function createFrameComparator({
    responder,
    createWorker = createEmbeddedWorker,
    workerStartupTimeoutMs = 3000,
    workerExecutionTimeoutMs = 10000
}) {
    async function compare(args) {
        if (args.algorithm !== "ssim-trim") return compareFramePixels(args);
        try {
            normalizeArea(args);
        } catch (error) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, String(error?.message || error));
        }
        let host;
        try {
            host = createWorker(algorithmWorkerSource);
        } catch (error) {
            return responder.fail(ErrorCode.WORKER_START_FAILED, "Algorithm Worker could not be started", {
                message: String(error?.message || error)
            });
        }
        const baseline = new Uint32Array(args.baseline);
        const current = new Uint32Array(args.current);
        return new Promise((resolve) => {
            let finished = false;
            let ready = false;
            let channelToken = "";
            let timer = 0;
            const finish = (result) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                args.signal?.removeEventListener("abort", aborted);
                host.dispose();
                resolve(result);
            };
            const aborted = () => finish(responder.fail(ErrorCode.CANCELLED, "Frame comparison was cancelled"));
            host.worker.onmessage = (event) => {
                const message = event.data || {};
                if (message.type === "bootstrapReady" && !ready && !channelToken
                    && message.hardened === true && message.layer === "bootstrap"
                    && typeof message.channelToken === "string") {
                    channelToken = message.channelToken;
                    host.worker.postMessage({ type: "initialize", dependency: ssimDependency });
                } else if (message.type === "ready" && !ready
                    && message.hardened === true && message.layer === "sandbox") {
                    if (message.channelToken !== channelToken || message.dependencyHash !== ssimDependency.sha256) {
                        finish(responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Algorithm dependency attestation failed"));
                        return;
                    }
                    ready = true;
                    clearTimeout(timer);
                    timer = setTimeout(() => finish(responder.fail(
                        ErrorCode.ALGORITHM_UNAVAILABLE,
                        "ssim-trim execution timed out",
                        { timeoutMs: workerExecutionTimeoutMs }
                    )), workerExecutionTimeoutMs);
                    const {
                        signal: ignoredSignal,
                        baseline: ignoredBaseline,
                        current: ignoredCurrent,
                        ...cloneableArgs
                    } = args;
                    try {
                        host.worker.postMessage({
                            type: "compare",
                            ...cloneableArgs,
                            baseline,
                            current,
                            channelToken
                        }, [baseline.buffer, current.buffer]);
                    } catch (error) {
                        finish(responder.fail(
                            ErrorCode.WORKER_PROTOCOL_ERROR,
                            "Algorithm Worker request could not be transferred",
                            { message: String(error?.message || error) }
                        ));
                    }
                } else if (message.type === "done" && ready) {
                    if (!isValidAlgorithmWorkerResult(message.result)) {
                        finish(responder.fail(
                            ErrorCode.WORKER_PROTOCOL_ERROR,
                            "Algorithm Worker returned an invalid comparison result"
                        ));
                        return;
                    }
                    finish({
                        ok: true,
                        pct: message.result.pct,
                        debug: {
                            ...message.result.debug,
                            algorithm: args.algorithm,
                            libraryVersion: "3.5.0",
                            bundled: true
                        }
                    });
                } else if (message.type === "error" && ready) {
                    finish(responder.fail(ErrorCode.ALGORITHM_UNAVAILABLE, "ssim-trim execution failed", {
                        errorName: String(message.errorName || "Error"),
                        message: String(message.message || "Algorithm execution failed")
                    }));
                } else if (message.type === "protocolError") {
                    finish(responder.fail(
                        ErrorCode.WORKER_PROTOCOL_ERROR,
                        message.message || "Algorithm Worker protocol error"
                    ));
                } else {
                    finish(responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Algorithm Worker protocol error"));
                }
            };
            host.worker.onerror = (event) => finish(responder.fail(
                ready ? ErrorCode.WORKER_CRASHED : ErrorCode.WORKER_START_FAILED,
                ready ? "Algorithm Worker crashed" : "Algorithm Worker failed during startup",
                { message: String(event.message || "Worker error") }
            ));
            host.worker.onmessageerror = () => finish(responder.fail(
                ErrorCode.WORKER_PROTOCOL_ERROR,
                "Algorithm Worker returned an unreadable message"
            ));
            args.signal?.addEventListener("abort", aborted, { once: true });
            if (args.signal?.aborted) {
                aborted();
                return;
            }
            timer = setTimeout(() => finish(responder.fail(
                ErrorCode.WORKER_START_FAILED,
                "Algorithm Worker did not complete its startup handshake",
                { timeoutMs: workerStartupTimeoutMs }
            )), workerStartupTimeoutMs);
        });
    }

    return { compare };
}
