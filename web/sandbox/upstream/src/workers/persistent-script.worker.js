"use strict";

import { assertLockedGlobals, lockDownCapabilityPrototypes } from "./dependency-bootstrap.js";
import { normalizeBoundedValue } from "../bounded-value.js";
import { readOwnDataProperty } from "../structured-value-normalizer.js";
import {
    isPersistentMcpName,
    normalizePersistentMcpDescription,
    normalizePersistentMcpMetadata,
    normalizePersistentMcpParams,
    normalizePersistentMcpResult,
    normalizeWorkerRpcParams,
    normalizeWorkerTrigger
} from "../worker-rpc-payload.js";
import { serializeWorkerError } from "../worker-error-summary.js";
import { ResourceLimits } from "../resource-limits.js";

(() => {
const nativePostMessage = globalThis.postMessage.bind(globalThis);
const nativeAddEventListener = globalThis.addEventListener.bind(globalThis);
const nativeEval = globalThis.eval;
const NativeError = globalThis.Error;
const NativeString = globalThis.String;
const nativeObjectHasOwn = globalThis.Object.hasOwn.bind(globalThis.Object);
const nativeObjectGetPrototypeOf = globalThis.Object.getPrototypeOf.bind(globalThis.Object);
const nativeObjectGetOwnPropertyDescriptors = globalThis.Object.getOwnPropertyDescriptors.bind(globalThis.Object);
const nativeObjectKeys = globalThis.Object.keys.bind(globalThis.Object);
const nativeObjectFreeze = globalThis.Object.freeze.bind(globalThis.Object);
const nativeObjectDefineProperty = globalThis.Object.defineProperty.bind(globalThis.Object);
const nativeObjectPrototype = nativeObjectGetPrototypeOf({});
const nativeJsonStringify = globalThis.JSON.stringify.bind(globalThis.JSON);
const nativeSetTimeout = globalThis.setTimeout?.bind(globalThis);
const nativeSetInterval = globalThis.setInterval?.bind(globalThis);
const channelToken = globalThis.crypto.randomUUID();
const send = (message) => {
    nativeObjectDefineProperty(message, "channelToken", {
        value: channelToken,
        enumerable: true,
        configurable: true,
        writable: true
    });
    nativePostMessage(message);
};

const fetch = undefined;
const XMLHttpRequest = undefined;
const WebSocket = undefined;
const EventSource = undefined;
const importScripts = undefined;
const Function = undefined;
const callbacks = new Map();
const persistentMcps = new Map();
const replies = new Map();
let callbackSerial = 1;
const workQueue = [];
const MAX_WORK_QUEUE = ResourceLimits.persistentEventQueue;
let drainingWork = false;
let activeNonBlockingMcpCalls = 0;
let droppedTicks = 0;
let asyncMode = false;
let activeEvent = null;
let initialized = false;
const CALLBACK_DESTRUCTIVE_COMMANDS = new Set([
    "reset", "reloadRom", "reloadRecentFile",
    "loadRomFile", "loadRomBytes", "loadRomUrl",
    "loadState", "loadStateBytes", "loadStateUrl", "importStateFile",
    "restoreAnalysisBaseline", "loadSaveSlot", "importSaveFile"
]);

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

function ask(type, data = {}) {
    return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        replies.set(id, { resolve, reject });
        send({ type, id, ...data });
    });
}

const mcp = {
    call: (command, params = {}) => {
        const normalizedParams = normalizeWorkerRpcParams(command, params);
        if (activeEvent?.eventId && CALLBACK_DESTRUCTIVE_COMMANDS.has(command)) {
            const error = new NativeError(
                `${command} is unavailable inside a persistent breakpoint callback because it requires lifecycle handlers after the callback releases. Invoke it after the callback or through the external API.`
            );
            error.code = "COMMAND_NOT_ALLOWED";
            error.details = {
                command,
                eventId: activeEvent.eventId,
                reason: "destructive-callback-reentrancy"
            };
            return Promise.reject(error);
        }
        if (command === "resume" && activeEvent?.eventId) {
            if (activeEvent.released) {
                const error = new NativeError("resume was already requested for this callback");
                error.code = "SCRIPT_RESUME_NOT_COMPLETED";
                return Promise.reject(error);
            }
            const eventIdentity = {
                eventId: activeEvent.eventId,
                callbackId: activeEvent.callbackId,
                callbackToken: activeEvent.callbackToken
            };
            activeEvent.released = true;
            send({ type: "eventRelease", ...eventIdentity, mode: "resume" });
            return ask("call", {
                command,
                params: normalizedParams,
                ...eventIdentity
            });
        }
        return ask("call", {
            command,
            params: normalizedParams,
            eventId: activeEvent?.released ? 0 : activeEvent?.eventId || 0,
            callbackId: activeEvent?.callbackId,
            callbackToken: activeEvent?.callbackToken
        });
    }
};
const webmcp = mcp;
const print = (...values) => {
    for (let index = 0; index < values.length; index++) {
        if (values[index] === undefined) values[index] = "undefined";
    }
    send({ type: "print", values: normalizeBoundedValue(values, { maxBytes: 64 * 1024 }).value });
};
const printf = (format, ...values) => print(String(format).replace(/%#?\.?(\d*)x|%[sd]/g, (match, width) => {
    const value = values.shift();
    if (match.endsWith("x")) {
        return "0x" + (Number(value) >>> 0).toString(16).padStart(Number(width || 0), "0");
    }
    return match.endsWith("d") ? String(Number(value)) : String(value);
}));
const printhex = (label, value) => print(
    label + ": " + (value == null ? "nil" : "0x" + (Number(value) >>> 0).toString(16).padStart(8, "0"))
);

function callbackErrorMessage(error) {
    const code = readOwnDataProperty(error, "code");
    const summary = serializeWorkerError(error, { phase: "callback", code });
    const details = readOwnDataProperty(error, "details");
    let detailText = "";
    try {
        if (details && typeof details === "object") {
            detailText = nativeJsonStringify(normalizeBoundedValue(details, {
                maxBytes: 4096,
                maxArray: 32,
                maxProperties: 32
            }).value);
        }
    } catch {}
    return `${summary.details.code ? `[${summary.details.code}] ` : ""}${summary.message}${detailText ? ` details=${detailText}` : ""}`;
}

function unwrapLegacyScalar(result, command) {
    if (result?.ok === false) {
        const error = new Error(result.error?.message || `${command} failed`);
        error.code = result.error?.code;
        error.details = result.error?.details;
        throw error;
    }
    if (result?.ok === true && nativeObjectHasOwn(result, "value")) {
        return result.value;
    }
    if (result == null || ["number", "string", "boolean"].includes(typeof result)) {
        return result;
    }
    throw new TypeError(`${command} did not return a scalar result`);
}

async function callLegacyScalar(command, params, invoke = mcp.call) {
    return unwrapLegacyScalar(await invoke(command, params), command);
}

async function callMemory(command, params) {
    try {
        return await mcp.call(command, params);
    } catch (cause) {
        const error = cause && typeof cause === "object"
            ? cause
            : new NativeError(NativeString(cause || `${command} failed`));
        const address = params?.address;
        error.details = {
            memoryApi: command,
            inputAddress: address === undefined ? "undefined" : NativeString(address),
            triggerId: Number(activeEvent?.triggerId) || 0
        };
        throw error;
    }
}

async function register(kind, address, callback, options = {}) {
    if (typeof address === "function") {
        options = callback || {};
        callback = address;
        address = 0;
    }
    if (typeof callback !== "function") throw new TypeError(`${kind} callback is required`);
    const callbackId = callbackSerial++;
    callbacks.set(callbackId, { callback, kind });
    try {
        return await ask("register", {
            trigger: normalizeWorkerTrigger({ kind, address, callbackId, ...options })
        });
    } catch (error) {
        callbacks.delete(callbackId);
        throw error;
    }
}

const memory = {
    getregister: (registerName, cpu) => callLegacyScalar("memoryGetRegister", { register: registerName, cpu }),
    setregister: (registerName, value, cpu) => mcp.call("memorySetRegister", { register: registerName, value, cpu }),
    readbyte: (address, cpu) => callLegacyScalar("memoryReadByte", { address, cpu }, callMemory),
    readword: (address, cpu) => callLegacyScalar("memoryReadWord", { address, cpu }, callMemory),
    readdword: (address, cpu) => callLegacyScalar("memoryReadDword", { address, cpu }, callMemory),
    writebyte: (address, value, cpu) => callMemory("memoryWriteByte", { address, value, cpu }),
    writeword: (address, value, cpu) => callMemory("memoryWriteWord", { address, value, cpu }),
    writedword: (address, value, cpu) => callMemory("memoryWriteDword", { address, value, cpu }),
    registerwrite: (address, callback, options) => register("write", address, callback, options),
    registerread: (address, callback, options) => register("read", address, callback, options),
    registerexec: (address, callback, options) => register("exec", address, callback, options),
    registerexception: (kind, callback, options) => register(kind, 0, callback, options),
    ontick: (callback, options) => register("tick", 0, callback, options)
};
memory.reg = memory.getregister;
memory.regw = memory.setregister;
memory.read8 = memory.readbyte;
memory.read16 = memory.readword;
memory.read32 = memory.readdword;
memory.write8 = memory.writebyte;
memory.write16 = memory.writeword;
memory.write32 = memory.writedword;

const emu_registerstart = (callback, options) => register("start", 0, callback, options);
const emu_ontick = (callback, options) => register("tick", 0, callback, options);
const emu_onstateload = (callback, options) => register("stateLoad", 0, callback, options);
const emu_onstatesave = (callback, options) => register("stateSave", 0, callback, options);
const emu = Object.fromEntries([
    "pause", "resume", "status", "step", "smartStep", "stepOver", "stepNextBranchOrReturn",
    "trueNextBranch", "runUntilReturn", "runUntilNextCall", "nextCallThisDepth", "stepFrames", "setInput",
    "runTouchHold", "setSpeed", "setRenderEnabled", "setAudio", "saveState", "loadState",
    "reloadRecentFile"
].map((command) => [command, (params = {}) => mcp.call(command, params)]));
emu.onStateLoad = emu_onstateload;
emu.onStateSave = emu_onstatesave;

function installShortcuts(definitions) {
    for (const [name, command, parameterNames, defaults = {}] of definitions || []) {
        globalThis[name] = (...args) => {
            const params = args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
                ? { ...defaults, ...args[0] }
                : Object.fromEntries(parameterNames.map((parameter, index) => [parameter, args[index]])
                    .filter(([, value]) => value !== undefined));
            return mcp.call(command, { ...defaults, ...params });
        };
    }
}

function fail(error, phase = "runtime") {
    send({
        type: "failed",
        phase,
        error: serializeWorkerError(error, { phase })
    });
}

function validatePlainObject(value, label) {
    if (!value || typeof value !== "object") throw new TypeError(`${label} must be an object`);
    const prototype = nativeObjectGetPrototypeOf(value);
    if (prototype !== nativeObjectPrototype && prototype !== null) {
        throw new TypeError(`${label} must be a plain object`);
    }
    const descriptors = nativeObjectGetOwnPropertyDescriptors(value);
    for (const key of nativeObjectKeys(descriptors)) {
        const descriptor = readOwnDataProperty(descriptors, key);
        if (!descriptor || !nativeObjectHasOwn(descriptor, "value")) {
            throw new TypeError(`${label} contains an accessor`);
        }
    }
    return value;
}

function validatePublishedMcps(value) {
    let fallbackId = null;
    let definitions = value;
    if (value === undefined || value === null) definitions = [];
    else if (!Array.isArray(value)) {
        const result = validatePlainObject(value, "persistent script top-level return");
        const rawFallbackId = readOwnDataProperty(result, "fallbackId");
        if (rawFallbackId !== undefined && rawFallbackId !== null) {
            if (typeof rawFallbackId !== "string"
                || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(rawFallbackId)) {
                throw new TypeError("persistent script fallbackId must match ^[A-Za-z][A-Za-z0-9._-]{0,63}$");
            }
            fallbackId = rawFallbackId;
        }
        const rawMcps = readOwnDataProperty(result, "mcps");
        definitions = rawMcps === undefined || rawMcps === null ? [] : rawMcps;
    }
    if (!Array.isArray(definitions)) {
        throw new TypeError("persistent script mcps must be an array, null, or undefined");
    }
    if (definitions.length > ResourceLimits.persistentMcpEndpointsPerScript) {
        throw new RangeError(
            `persistent MCP endpoint limit exceeded (${ResourceLimits.persistentMcpEndpointsPerScript})`
        );
    }
    const handlers = new Map();
    const metadata = new Array(definitions.length);
    for (let index = 0; index < definitions.length; index++) {
        const definition = validatePlainObject(
            readOwnDataProperty(definitions, `${index}`),
            `persistent MCP definition ${index}`
        );
        const name = readOwnDataProperty(definition, "name");
        const description = normalizePersistentMcpDescription(
            readOwnDataProperty(definition, "description")
        );
        const handler = readOwnDataProperty(definition, "handler");
        if (!isPersistentMcpName(name)) {
            throw new TypeError("persistent MCP name must match ^[A-Za-z][A-Za-z0-9._-]{0,63}$");
        }
        if (typeof handler !== "function") {
            throw new TypeError(`persistent MCP handler is required: ${name}`);
        }
        if (handlers.has(name)) throw new TypeError(`duplicate persistent MCP name: ${name}`);
        handlers.set(name, handler);
        metadata[index] = { name, description };
    }
    return { fallbackId, handlers, metadata: normalizePersistentMcpMetadata(metadata) };
}

function publishPersistentMcps(value) {
    const published = validatePublishedMcps(value);
    persistentMcps.clear();
    for (const [name, handler] of published.handlers) persistentMcps.set(name, handler);
    send({
        type: "registrationComplete",
        fallbackId: published.fallbackId,
        mcps: published.metadata
    });
    for (const item of published.metadata) print(`MCP published: ${item.name}`);
}

async function runPersistentMcp(message) {
    const callId = Number(message.callId);
    const scriptInstanceId = String(message.scriptInstanceId || "");
    const name = message.name;
    const blocking = message.blocking;
    let params;
    if (!Number.isSafeInteger(callId) || callId < 1
        || !scriptInstanceId
        || !isPersistentMcpName(name)
        || typeof blocking !== "boolean") {
        fail(new TypeError("persistent MCP invocation is malformed"), "protocol");
        return;
    }
    try {
        params = normalizePersistentMcpParams(message.params);
    } catch (error) {
        fail(error, "protocol");
        return;
    }
    const handler = persistentMcps.get(name);
    if (!handler) {
        send({
            type: "pscriptMcpResult",
            callId,
            scriptInstanceId,
            ok: false,
            error: normalizePersistentMcpResult({
                code: "SCRIPT_MCP_NOT_FOUND",
                message: `Persistent script MCP is not published: ${name}`
            })
        });
        return;
    }
    print(`MCP call: ${name} · blocking=${blocking}`);
    try {
        const rawValue = await handler(params, nativeObjectFreeze({ blocking }));
        let value;
        try {
            value = normalizePersistentMcpResult(rawValue);
        } catch (error) {
            fail(error, "protocol");
            return;
        }
        send({ type: "pscriptMcpResult", callId, scriptInstanceId, ok: true, value });
    } catch (error) {
        const summary = serializeWorkerError(error, {
            phase: "persistent-mcp",
            code: "SCRIPT_RUNTIME_ERROR"
        });
        send({
            type: "pscriptMcpResult",
            callId,
            scriptInstanceId,
            ok: false,
            error: normalizePersistentMcpResult({
                code: "SCRIPT_RUNTIME_ERROR",
                message: summary.message,
                details: summary.details
            })
        });
    }
}

lockDownRuntimeCodeGeneration();
lockDownCapabilityPrototypes();
assertLockedGlobals();

async function runEvent(message) {
    const previousEvent = activeEvent;
    activeEvent = {
        eventId: Number(message.eventId) || 0,
        callbackId: Number(message.callbackId),
        triggerId: Number(message.triggerId) || 0,
        callbackToken: String(message.callbackToken || ""),
        released: false
    };
    try {
        for (const [id, entry] of callbacks) {
            if (message.callbackId ? id !== message.callbackId : entry.kind !== message.event) continue;
            try {
                await entry.callback(message.payload);
            } catch (error) {
                if (asyncMode) throw error;
                print(`callback error: ${callbackErrorMessage(error)}`);
            }
        }
    } finally {
        const completedEvent = activeEvent;
        activeEvent = previousEvent;
        if (message.eventId && !completedEvent.released) send({
            type: "eventDone",
            eventId: message.eventId,
            callbackId: message.callbackId,
            callbackToken: message.callbackToken
        });
        send({
            type: "eventProcessed",
            queueEventId: Number(message.queueEventId) || 0
        });
    }
}

async function drainWork() {
    if (drainingWork) return;
    drainingWork = true;
    try {
        while (workQueue.length) {
            const message = workQueue.shift();
            if (message.type === "pscriptMcpInvoke") {
                await runPersistentMcp(message);
                continue;
            }
            try {
                await runEvent(message);
            } catch (error) {
                if (asyncMode) throw error;
                print(`callback error: ${callbackErrorMessage(error)}`);
            }
        }
    } finally {
        drainingWork = false;
    }
}

nativeAddEventListener("message", async (event) => {
    const message = event.data || {};
    if (!initialized) {
        if (message.type !== "initialize") return fail(new Error("sandbox initialization is required"), "protocol");
        initialized = true;
        send({ type: "ready", hardened: true, layer: "sandbox" });
        return;
    }
    if (message.replyId) {
        const pending = replies.get(message.replyId);
        if (!pending) return fail(new Error(`unknown reply id: ${message.replyId}`), "protocol");
        replies.delete(message.replyId);
        if (message.error) {
            const payload = message.error;
            const error = new NativeError(typeof payload === "object"
                ? NativeString(readOwnDataProperty(payload, "message") || "Worker RPC failed")
                : NativeString(payload));
            if (payload && typeof payload === "object") {
                const code = readOwnDataProperty(payload, "code");
                const details = readOwnDataProperty(payload, "details");
                if (typeof code === "string") error.code = code;
                if (details !== undefined) error.details = details;
            }
            pending.reject(error);
        } else pending.resolve(message.result);
        return;
    }
    if (message.type === "start") {
        asyncMode = !!message.asyncMode;
        installShortcuts(message.shortcuts);
        try {
            const run = nativeEval(`(async (mcp, webmcp, memory, print, printf, printhex, emu, emu_registerstart, emu_ontick, emu_onstateload, emu_onstatesave) => {\n"use strict";\n${message.code}\n})\n//# sourceURL=desmume-persistent-user.js`);
            send({ type: "compiled" });
            send({ type: "started" });
            const published = await run(
                mcp,
                webmcp,
                memory,
                print,
                printf,
                printhex,
                emu,
                emu_registerstart,
                emu_ontick,
                emu_onstateload,
                emu_onstatesave
            );
            publishPersistentMcps(published);
        } catch (error) {
            fail(error, error?.name === "SyntaxError" ? "compile" : "runtime");
        }
        return;
    }
    if (message.type === "event") {
        if (message.event === "tick" && !message.eventId) {
            const existingTick = workQueue.findIndex((queued) => (
                queued.type === "event" && queued.event === "tick" && !queued.eventId
            ));
            if (existingTick >= 0) {
                workQueue[existingTick] = message;
                droppedTicks++;
                if ((droppedTicks & 63) === 1) print(`tick queue coalesced ${droppedTicks} event(s)`);
                return;
            }
        }
        if (workQueue.length >= MAX_WORK_QUEUE) {
            fail(new Error(`persistent work queue exceeded ${MAX_WORK_QUEUE}`), "resource");
            return;
        }
        workQueue.push(message);
        void drainWork().catch((error) => fail(error, "runtime"));
        return;
    }
    if (message.type === "pscriptMcpInvoke") {
        if (message.blocking === true) {
            if (workQueue.length >= MAX_WORK_QUEUE) {
                fail(new Error(`persistent work queue exceeded ${MAX_WORK_QUEUE}`), "resource");
                return;
            }
            workQueue.push(message);
            void drainWork().catch((error) => fail(error, "runtime"));
            return;
        }
        if (message.blocking !== false
            || activeNonBlockingMcpCalls >= ResourceLimits.pendingPersistentMcpCallsPerScript) {
            fail(new Error("persistent non-blocking MCP call limit exceeded"), "protocol");
            return;
        }
        activeNonBlockingMcpCalls++;
        void runPersistentMcp(message).finally(() => {
            activeNonBlockingMcpCalls--;
        });
        return;
    }
    fail(new Error(`unknown message type: ${String(message.type)}`), "protocol");
});
})();
