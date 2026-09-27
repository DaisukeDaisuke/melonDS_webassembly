import { ErrorCode } from "./error-codes.js";
import { createEmbeddedWorker } from "./worker-host.js";
import supervisorSource from "./workers/eval-supervisor.worker.js";
import sandboxSource from "./workers/eval.worker.js";
import parserSource from "./workers/parser.worker.js";
import dependency from "./dependencies/acorn.dependency-source.js";
import { normalizeBoundedValue } from "./bounded-value.js";

const BOUNDARY_PROBE_SOURCE = "return { productionWorkerReady: true };";

export function createSandboxBoundarySelfTest({ createWorker = createEmbeddedWorker, timeoutMs = 5000 } = {}) {
    let active = null;
    let cooldownUntil = 0;
    let activeWorkerHosts = 0;

    function runProductionSession({ code = BOUNDARY_PROBE_SOURCE, holdRpc = false }) {
        return new Promise((resolve, reject) => {
            const host = createWorker(supervisorSource);
            activeWorkerHosts++;
            const pendingRpc = new Set();
            let ready = false;
            let timerActive = true;
            let terminalValue;
            let terminalError = null;
            let pendingRpcBeforeShutdown = 0;
            const shutdownRequestId = `boundary-shutdown-${Math.random().toString(36).slice(2)}`;
            const timer = setTimeout(() => {
                if (!timerActive) return;
                clearTimeout(timer);
                timerActive = false;
                pendingRpc.clear();
                host.dispose();
                activeWorkerHosts--;
                reject(Object.assign(new Error("Sandbox boundary production session timed out"), {
                    mcpCode: ErrorCode.TIMEOUT
                }));
            }, timeoutMs);
            const requestShutdown = (value, error = null) => {
                if (terminalValue !== undefined || terminalError) return;
                terminalValue = value;
                terminalError = error;
                pendingRpcBeforeShutdown = pendingRpc.size;
                host.worker.postMessage({ type: "shutdown", requestId: shutdownRequestId });
            };
            const finishAfterAck = (cleanup) => {
                if (!timerActive) return;
                clearTimeout(timer);
                timerActive = false;
                pendingRpc.clear();
                host.dispose();
                activeWorkerHosts--;
                const hostStatus = typeof host.status === "function" ? host.status() : {};
                const sample = {
                    value: terminalValue,
                    pendingRpcBeforeShutdown,
                    pendingRpcAfter: pendingRpc.size,
                    timerCleared: !timerActive,
                    outerWorkerDisposed: hostStatus.disposed === true,
                    outerWorkerTerminateCalled: hostStatus.workerTerminated === true,
                    outerBlobUrlRevokeCalled: hostStatus.blobUrlRevoked === true,
                    childWorkerTerminateCalled: cleanup.childWorkerTerminateCalled === true,
                    childBlobUrlRevokeCalled: cleanup.childBlobUrlRevokeCalled === true,
                    childHandlersCleared: cleanup.childHandlersCleared === true,
                    childPendingRpcAfter: Number(cleanup.childPendingRpcAfter)
                };
                if (terminalError) reject(terminalError);
                else resolve(sample);
            };
            host.worker.onmessage = (event) => {
                const message = event.data || {};
                if (message.type === "ready" && !ready
                    && message.hardened === true && message.layer === "supervisor") {
                    ready = true;
                    host.worker.postMessage({
                        type: "run",
                        code,
                        shortcuts: [],
                        parserSource,
                        sandboxSource,
                        dependency,
                    });
                    return;
                }
                if (message.type === "call" && holdRpc) {
                    pendingRpc.add(String(message.id));
                    requestShutdown({ pendingObserved: true });
                    return;
                }
                if (message.type === "done") {
                    requestShutdown(normalizeBoundedValue(message.result, { maxBytes: 64 * 1024 }).value);
                    return;
                }
                if (message.type === "shutdownAck" && message.requestId === shutdownRequestId
                    && message.cleanup && typeof message.cleanup === "object") {
                    finishAfterAck(message.cleanup);
                    return;
                }
                requestShutdown(undefined, Object.assign(new Error(message.message || "Sandbox boundary production protocol failure"), {
                    mcpCode: ErrorCode.WORKER_PROTOCOL_ERROR
                }));
            };
            host.worker.onerror = (event) => requestShutdown(undefined, Object.assign(new Error(String(event.message || "Sandbox boundary Worker crashed")), {
                mcpCode: ErrorCode.WORKER_CRASHED
            }));
            host.worker.onmessageerror = () => requestShutdown(undefined, Object.assign(new Error("Sandbox boundary Worker returned unreadable data"), {
                mcpCode: ErrorCode.WORKER_PROTOCOL_ERROR
            }));
        });
    }

    function run() {
        if (active) return active;
        if (Date.now() < cooldownUntil) {
            const error = new Error("Sandbox boundary self-test is cooling down");
            error.mcpCode = ErrorCode.BUSY;
            throw error;
        }
        cooldownUntil = Date.now() + 1000;
        active = (async () => {
            const boundary = await runProductionSession({});
            const cleanupSamples = [boundary];
            const pending = await runProductionSession({ code: `await mcp.call("status", {}); return null;`, holdRpc: true });
            cleanupSamples.push(pending);
            const cleanup = {
                activeWorkerHostsAfter: activeWorkerHosts,
                pendingRpcAfter: pending.pendingRpcAfter,
                childPendingRpcAfter: pending.childPendingRpcAfter,
                allOuterWorkerHostsDisposed: cleanupSamples.every((sample) => sample.outerWorkerDisposed),
                allOuterWorkersTerminated: cleanupSamples.every((sample) => sample.outerWorkerTerminateCalled),
                allOuterBlobUrlsRevoked: cleanupSamples.every((sample) => sample.outerBlobUrlRevokeCalled),
                allChildWorkersTerminated: cleanupSamples.every((sample) => sample.childWorkerTerminateCalled),
                allChildBlobUrlsRevoked: cleanupSamples.every((sample) => sample.childBlobUrlRevokeCalled),
                allChildHandlersCleared: cleanupSamples.every((sample) => sample.childHandlersCleared),
                allTimersCleared: cleanupSamples.every((sample) => sample.timerCleared)
            };
            const passed = boundary.value?.productionWorkerReady === true
                && pending.pendingRpcBeforeShutdown === 1
                && pending.value?.pendingObserved === true
                && cleanup.pendingRpcAfter === 0
                && cleanup.childPendingRpcAfter === 0
                && cleanup.activeWorkerHostsAfter === 0
                && cleanup.allOuterWorkerHostsDisposed
                && cleanup.allOuterWorkersTerminated
                && cleanup.allOuterBlobUrlsRevoked
                && cleanup.allChildWorkersTerminated
                && cleanup.allChildBlobUrlsRevoked
                && cleanup.allChildHandlersCleared
                && cleanup.allTimersCleared;
            return normalizeBoundedValue({
                passed,
                productionPath: ["eval-supervisor.worker", "parser.worker", "eval.worker"],
                productionWorkerReady: boundary.value?.productionWorkerReady === true,
                pendingRpcCreated: pending.pendingRpcBeforeShutdown,
                cleanup
            }, { maxBytes: 64 * 1024 }).value;
        })().finally(() => { active = null; });
        return active;
    }

    return Object.freeze({ run });
}
