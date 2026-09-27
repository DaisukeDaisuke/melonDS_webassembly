"use strict";

import { assertLockedGlobals, initializeLockedDependency, lockDownCapabilityPrototypes } from "./dependency-bootstrap.js";
import { serializeWorkerError } from "../worker-error-summary.js";

(() => {
const nativePostMessage = globalThis.postMessage.bind(globalThis);
const nativeAddEventListener = globalThis.addEventListener.bind(globalThis);
const nativeEval = globalThis.eval;
const nativeDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
const NativeTextEncoder = globalThis.TextEncoder;
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
let parse = null;

for (const name of [
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "importScripts", "Function",
    "postMessage", "addEventListener", "removeEventListener", "dispatchEvent", "onmessage", "onmessageerror",
    "BroadcastChannel", "WebTransport", "WebSocketStream", "indexedDB", "caches",
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

function parseSandboxSource(source) {
    const scriptIds = [];
    const ast = parse(`async function __desmumeSandbox__(){\n${String(source)}\n}`, {
        ecmaVersion: "latest",
        sourceType: "script",
        onComment: (block, text) => {
            if (block) return;
            const match = String(text).match(/^\s*@script-id\s+([^\s]+)\s*$/);
            if (match) scriptIds.push(match[1]);
        }
    });
    const pending = [ast];
    const seen = new Set();
    while (pending.length) {
        const node = pending.pop();
        if (!node || typeof node !== "object" || seen.has(node)) continue;
        seen.add(node);
        if (node.type === "ImportExpression") throw new SyntaxError("dynamic import is unavailable in isolated scripts");
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) pending.push(...value);
            else if (value && typeof value === "object") pending.push(value);
        }
    }
    const uniqueScriptIds = [...new Set(scriptIds)];
    if (uniqueScriptIds.length > 1) {
        throw new SyntaxError("persistent script contains conflicting @script-id directives");
    }
    const scriptId = uniqueScriptIds[0] || null;
    if (scriptId !== null && !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(scriptId)) {
        throw new SyntaxError("@script-id must match ^[A-Za-z][A-Za-z0-9._-]{0,63}$");
    }
    return { scriptId };
}

lockDownRuntimeCodeGeneration();
lockDownCapabilityPrototypes();
assertLockedGlobals();

nativeAddEventListener("message", async (event) => {
    const message = event.data || {};
    if (!parse) {
        if (message.type !== "initialize") {
            send({ type: "protocolError", message: "dependency initialization is required" });
            return;
        }
        try {
            const acorn = await initializeLockedDependency({
                dependency: message.dependency,
                nativeEval,
                nativeDigest,
                NativeTextEncoder
            });
            if (typeof acorn.parse !== "function") throw new Error("Acorn parse export is unavailable");
            parse = acorn.parse;
            send({ type: "ready", hardened: true, layer: "parser", dependencyHash: message.dependency.sha256 });
        } catch (error) {
            send({ type: "protocolError", message: `dependency initialization failed: ${String(error?.message || error)}` });
        }
        return;
    }
    if (message.channelToken !== channelToken) {
        send({ type: "protocolError", message: "parser Worker token mismatch" });
        return;
    }
    if (message.type !== "parse" || typeof message.code !== "string") {
        send({ type: "protocolError", message: "parse message with string code is required" });
        return;
    }
    try {
        const parsed = parseSandboxSource(message.code);
        send({ type: "parsed", scriptId: parsed.scriptId });
    } catch (error) {
        send({ type: "error", error: serializeWorkerError(error, { source: message.code, phase: "compile" }) });
    }
});
})();
