"use strict";

import { assertLockedGlobals, lockDownCapabilityPrototypes } from "./dependency-bootstrap.js";
import { normalizeBoundedValue } from "../bounded-value.js";
import { normalizeWorkerRpcParams } from "../worker-rpc-payload.js";
import { serializeWorkerError } from "../worker-error-summary.js";

(() => {
const nativePostMessage = globalThis.postMessage.bind(globalThis);
const nativeAddEventListener = globalThis.addEventListener.bind(globalThis);
const nativeEval = globalThis.eval;
const nativeObjectHasOwn = globalThis.Object.hasOwn.bind(globalThis.Object);
const nativeSetTimeout = globalThis.setTimeout?.bind(globalThis);
const nativeSetInterval = globalThis.setInterval?.bind(globalThis);
const channelToken = globalThis.crypto.randomUUID();
const send = (message) => nativePostMessage({ ...message, channelToken });

const fetch = undefined;
const XMLHttpRequest = undefined;
const WebSocket = undefined;
const EventSource = undefined;
const importScripts = undefined;
const Function = undefined;
const replies = new Map();
let initialized = false;

for (const name of [
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "importScripts", "Function",
    "postMessage", "addEventListener", "removeEventListener", "dispatchEvent", "onmessage", "onmessageerror", "BroadcastChannel", "WebTransport", "WebSocketStream", "indexedDB", "caches",
    "localStorage", "sessionStorage", "close",
    "navigator", "crypto", "EventTarget", "WorkerGlobalScope", "DedicatedWorkerGlobalScope"
]) {
    try {
        Object.defineProperty(globalThis, name, {
            value: undefined,
            writable: false,
            configurable: false
        });
    } catch {
        try { globalThis[name] = undefined; } catch {}
    }
}

function installSafeTimer(name, nativeTimer) {
    if (!nativeTimer) return;
    Object.defineProperty(globalThis, name, {
        value: (callback, delay, ...args) => {
            if (typeof callback !== "function") {
                throw new TypeError(`${name} requires a function callback`);
            }
            return nativeTimer(callback, delay, ...args);
        },
        writable: false,
        configurable: false
    });
}

installSafeTimer("setTimeout", nativeSetTimeout);
installSafeTimer("setInterval", nativeSetInterval);

function lockDownRuntimeCodeGeneration() {
    const prototypes = new Set();
    const collectPrototypeChain = (value) => {
        let current = value;
        while (current && !prototypes.has(current)) {
            prototypes.add(current);
            current = Object.getPrototypeOf(current);
        }
    };
    collectPrototypeChain(globalThis);
    collectPrototypeChain(() => {});
    collectPrototypeChain(async () => {});
    collectPrototypeChain(function* () {});
    collectPrototypeChain(async function* () {});
    for (const prototype of prototypes) {
        if (!nativeObjectHasOwn(prototype, "constructor")) continue;
        try {
            Object.defineProperty(prototype, "constructor", {
                value: undefined,
                writable: false,
                configurable: false
            });
        } catch {
            try { prototype.constructor = undefined; } catch {}
        }
    }
    try {
        Object.defineProperty(globalThis, "eval", {
            value: undefined,
            writable: false,
            configurable: false
        });
    } catch {
        try { globalThis.eval = undefined; } catch {}
    }
}

function call(command, params = {}) {
    const normalizedParams = normalizeWorkerRpcParams(command, params);
    return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        replies.set(id, { resolve, reject });
        send({ type: "call", id, command, params: normalizedParams });
    });
}

const mcp = { call };
const webmcp = mcp;

function installShortcuts(definitions) {
    for (const [name, command, parameterNames, defaults = {}] of definitions || []) {
        globalThis[name] = (...args) => {
            const params = args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
                ? { ...defaults, ...args[0] }
                : Object.fromEntries(parameterNames.map((parameter, index) => [parameter, args[index]])
                    .filter(([, value]) => value !== undefined));
            return call(command, { ...defaults, ...params });
        };
    }
}

lockDownRuntimeCodeGeneration();
lockDownCapabilityPrototypes();
assertLockedGlobals();

nativeAddEventListener("message", async (event) => {
    const message = event.data || {};
    if (!initialized) {
        if (message.type !== "initialize") {
            send({ type: "protocolError", message: "sandbox initialization is required" });
            return;
        }
        initialized = true;
        send({ type: "ready", hardened: true, layer: "sandbox" });
        return;
    }
    if (message.replyId) {
        const pending = replies.get(message.replyId);
        if (!pending) {
            send({ type: "protocolError", message: `unknown reply id: ${message.replyId}` });
            return;
        }
        replies.delete(message.replyId);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        return;
    }
    if (message.type !== "run" || typeof message.code !== "string") {
        send({ type: "protocolError", message: "run message with string code is required" });
        return;
    }
    installShortcuts(message.shortcuts);
    try {
        const script = `(async (mcp, webmcp) => {\n"use strict";\n${message.code}\n})\n//# sourceURL=desmume-eval-user.js`;
        const run = nativeEval(script);
        const result = await run(mcp, webmcp);
        send({ type: "done", result: normalizeBoundedValue(result === undefined ? null : result).value });
    } catch (error) {
        const phase = error?.name === "SyntaxError" ? "compile" : "runtime";
        send({ type: "error", error: serializeWorkerError(error, { source: message.code, phase }) });
    }
});
})();
