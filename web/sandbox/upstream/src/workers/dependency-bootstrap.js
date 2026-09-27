const MAX_DEPENDENCY_SOURCE_BYTES = 2 * 1024 * 1024;

function hexDigest(bytes) {
    return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function initializeLockedDependency({
    dependency,
    nativeEval,
    nativeDigest,
    NativeTextEncoder
}) {
    if (!dependency || typeof dependency.source !== "string"
        || !/^[a-f0-9]{64}$/.test(String(dependency.sha256))) {
        throw new TypeError("dependency source and SHA-256 are required");
    }
    const bytes = new NativeTextEncoder().encode(dependency.source);
    if (bytes.byteLength > MAX_DEPENDENCY_SOURCE_BYTES) {
        throw new RangeError("dependency source exceeds the bootstrap budget");
    }
    const actual = hexDigest(await nativeDigest("SHA-256", bytes));
    if (actual !== dependency.sha256) throw new Error("dependency source hash mismatch");
    const exports = nativeEval(dependency.source);
    if (!exports || typeof exports !== "object") throw new Error("dependency did not initialize exports");
    return Object.freeze(exports);
}

export function assertLockedGlobals() {
    for (const name of [
        "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "importScripts",
        "postMessage", "addEventListener", "removeEventListener", "dispatchEvent", "onmessage", "onmessageerror",
        "BroadcastChannel", "WebTransport", "WebSocketStream", "indexedDB", "caches", "localStorage",
        "sessionStorage", "close", "navigator", "crypto", "EventTarget", "WorkerGlobalScope",
        "DedicatedWorkerGlobalScope", "eval", "Function"
    ]) {
        if (globalThis[name] !== undefined) throw new Error(`lockdown invariant failed: ${name}`);
    }
}

export function lockDownCapabilityPrototypes() {
    const names = [
        "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "importScripts",
        "postMessage", "addEventListener", "removeEventListener", "dispatchEvent", "onmessage", "onmessageerror",
        "BroadcastChannel", "WebTransport", "WebSocketStream", "close"
    ];
    const prototypes = [];
    let current = Object.getPrototypeOf(globalThis);
    while (current) {
        prototypes.push(current);
        current = Object.getPrototypeOf(current);
    }
    for (const prototype of prototypes) {
        for (const name of names) {
            if (!Object.prototype.hasOwnProperty.call(prototype, name)) continue;
            try {
                Object.defineProperty(prototype, name, {
                    value: undefined,
                    writable: false,
                    configurable: false
                });
            } catch (error) {
                throw new Error(`prototype lockdown failed: ${name}: ${String(error?.message || error)}`);
            }
        }
    }
    for (const prototype of prototypes) {
        for (const name of names) {
            if (Object.prototype.hasOwnProperty.call(prototype, name) && prototype[name] !== undefined) {
                throw new Error(`prototype lockdown invariant failed: ${name}`);
            }
        }
    }
}
