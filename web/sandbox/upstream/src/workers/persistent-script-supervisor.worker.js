"use strict";

import { normalizeBoundedValue } from "../bounded-value.js";
import {
    isPersistentMcpName,
    normalizePersistentMcpMetadata,
    normalizePersistentMcpParams,
    normalizePersistentMcpResult,
    normalizeWorkerRpcParams,
    normalizeWorkerTrigger
} from "../worker-rpc-payload.js";
import { ResourceLimits } from "../resource-limits.js";

let sandbox = null;
let sandboxUrl = "";
let channelToken = "";
let scriptInstanceId = "";
let parser = null;
let parserUrl = "";
let parserChannelToken = "";
let started = false;
let childWorkerTerminateCalled = false;
let childBlobUrlRevokeCalled = false;
let childHandlersCleared = false;
const pendingRequestIds = new Set();
const pendingPersistentMcpCallIds = new Set();
const completedPersistentMcpCallIds = new Set();
const MAX_PENDING_REQUESTS = 32;
const MAX_EVENT_QUEUE = 64;
const eventQueue = [];
let childEventBusy = false;

function smallValue(value) {
    return normalizeBoundedValue(value, {
        maxBytes: 64 * 1024,
        maxArray: 256,
        maxNodes: 2048,
        maxDepth: 10,
        maxProperties: 128
    }).value;
}

function fail(error, phase = "protocol") {
    let normalizedError;
    try {
        normalizedError = smallValue({
            name: String(error?.name || "Error").slice(0, 256),
            message: String(error?.message || error).slice(0, 2048),
            stack: String(error?.stack || "").slice(0, 8192)
        });
    } catch {
        normalizedError = { name: "Error", message: "unrepresentable supervisor error", stack: "" };
    }
    postMessage({ type: "failed", phase: String(phase).slice(0, 128), error: normalizedError });
}

function disposeSandbox() {
    if (sandbox) {
        sandbox.onmessage = null;
        sandbox.onerror = null;
        sandbox.onmessageerror = null;
        childHandlersCleared = true;
        sandbox.terminate();
        childWorkerTerminateCalled = true;
        sandbox = null;
    }
    if (sandboxUrl) {
        URL.revokeObjectURL(sandboxUrl);
        childBlobUrlRevokeCalled = true;
        sandboxUrl = "";
    }
    pendingRequestIds.clear();
    pendingPersistentMcpCallIds.clear();
    completedPersistentMcpCallIds.clear();
    eventQueue.length = 0;
    childEventBusy = false;
}

function disposeParser() {
    if (parser) {
        parser.onmessage = null;
        parser.onerror = null;
        parser.onmessageerror = null;
        parser.terminate();
        parser = null;
    }
    if (parserUrl) {
        URL.revokeObjectURL(parserUrl);
        parserUrl = "";
    }
    parserChannelToken = "";
}

function shutdown(requestId) {
    disposeParser();
    disposeSandbox();
    postMessage({
        type: "shutdownAck",
        requestId: String(requestId || ""),
        cleanup: {
            childWorkerTerminateCalled,
            childBlobUrlRevokeCalled,
            childHandlersCleared,
            childPendingRpcAfter: pendingRequestIds.size,
            childQueuedEventsAfter: eventQueue.length,
            childEventBusyAfter: childEventBusy
        }
    });
}

function requireRequestId(childMessage) {
    if (typeof childMessage.id !== "string" || !childMessage.id
        || pendingRequestIds.has(childMessage.id)) {
        throw new TypeError("sandbox reused or omitted a request id");
    }
    if (pendingRequestIds.size >= MAX_PENDING_REQUESTS) {
        throw new RangeError(`sandbox exceeded ${MAX_PENDING_REQUESTS} pending requests`);
    }
    pendingRequestIds.add(childMessage.id);
}

function forwardAuthenticatedChildMessage(childMessage) {
    if (childMessage.type === "call") {
        if (typeof childMessage.command !== "string") throw new TypeError("sandbox RPC command is invalid");
        requireRequestId(childMessage);
        postMessage({
            type: "call",
            id: childMessage.id,
            command: childMessage.command,
            params: normalizeWorkerRpcParams(childMessage.command, childMessage.params || {}),
            eventId: Number(childMessage.eventId) || 0,
            callbackId: childMessage.callbackId,
            callbackToken: typeof childMessage.callbackToken === "string" ? childMessage.callbackToken : ""
        });
        return;
    }
    if (childMessage.type === "register") {
        requireRequestId(childMessage);
        postMessage({ type: "register", id: childMessage.id, trigger: normalizeWorkerTrigger(childMessage.trigger) });
        return;
    }
    if (childMessage.type === "eventDone") {
        postMessage({
            type: "eventDone",
            eventId: Number(childMessage.eventId) || 0,
            callbackId: Number(childMessage.callbackId) || 0,
            callbackToken: typeof childMessage.callbackToken === "string"
                ? childMessage.callbackToken.slice(0, 256) : ""
        });
        return;
    }
    if (childMessage.type === "eventRelease") {
        postMessage({
            type: "eventRelease",
            eventId: Number(childMessage.eventId) || 0,
            callbackId: Number(childMessage.callbackId) || 0,
            callbackToken: typeof childMessage.callbackToken === "string"
                ? childMessage.callbackToken.slice(0, 256) : "",
            mode: childMessage.mode === "resume" ? "resume" : "invalid"
        });
        return;
    }
    if (childMessage.type === "print") {
        const values = smallValue(childMessage.values);
        if (!Array.isArray(values)) throw new TypeError("sandbox print payload is invalid");
        postMessage({ type: "print", values });
        return;
    }
    if (childMessage.type === "registrationComplete") {
        postMessage({
            type: "registrationComplete",
            scriptInstanceId,
            fallbackId: childMessage.fallbackId == null
                ? null
                : String(childMessage.fallbackId).slice(0, 64),
            mcps: normalizePersistentMcpMetadata(childMessage.mcps)
        });
        return;
    }
    if (childMessage.type === "pscriptMcpResult") {
        const callId = Number(childMessage.callId);
        if (!Number.isSafeInteger(callId) || callId < 1
            || childMessage.scriptInstanceId !== scriptInstanceId) {
            throw new TypeError("sandbox persistent MCP result identity is invalid");
        }
        if (!pendingPersistentMcpCallIds.has(callId)) {
            if (completedPersistentMcpCallIds.has(callId)) {
                throw new TypeError("sandbox duplicated a persistent MCP result");
            }
            return;
        }
        if (typeof childMessage.ok !== "boolean") {
            throw new TypeError("sandbox persistent MCP result status is invalid");
        }
        pendingPersistentMcpCallIds.delete(callId);
        completedPersistentMcpCallIds.add(callId);
        while (completedPersistentMcpCallIds.size > ResourceLimits.expiredPersistentMcpCallsPerScript) {
            completedPersistentMcpCallIds.delete(completedPersistentMcpCallIds.values().next().value);
        }
        if (childMessage.ok) {
            postMessage({
                type: "pscriptMcpResult",
                scriptInstanceId,
                callId,
                ok: true,
                value: normalizePersistentMcpResult(childMessage.value)
            });
        } else {
            postMessage({
                type: "pscriptMcpResult",
                scriptInstanceId,
                callId,
                ok: false,
                error: normalizePersistentMcpResult(childMessage.error)
            });
        }
        return;
    }
    if (childMessage.type === "failed") {
        postMessage({
            type: "failed",
            phase: String(childMessage.phase || "runtime").slice(0, 128),
            error: smallValue(childMessage.error)
        });
        disposeSandbox();
        return;
    }
    if (childMessage.type === "compiled" || childMessage.type === "started") {
        postMessage({ type: childMessage.type });
        return;
    }
    childEventBusy = false;
    postMessage({
        type: "eventAck",
        queueEventId: Number(childMessage.queueEventId) || 0
    });
    pumpEventQueue();
}

function pumpEventQueue() {
    if (childEventBusy || !sandbox || !channelToken || !eventQueue.length) return;
    childEventBusy = true;
    sandbox.postMessage(eventQueue.shift());
}

function queueEvent(message) {
    if (message.event === "tick" && !message.eventId) {
        const index = eventQueue.findIndex((queued) => queued.event === "tick" && !queued.eventId);
        if (index >= 0) {
            eventQueue[index] = message;
            return;
        }
    }
    if (eventQueue.length >= MAX_EVENT_QUEUE) {
        fail(new Error(`supervisor event queue exceeded ${MAX_EVENT_QUEUE}`), "resource");
        disposeSandbox();
        return;
    }
    eventQueue.push(message);
    pumpEventQueue();
}

function startSandbox(message) {
    try {
        sandboxUrl = URL.createObjectURL(new Blob([message.sandboxSource], { type: "text/javascript" }));
        sandbox = new Worker(sandboxUrl);
        sandbox.postMessage({ type: "initialize" });
    } catch (error) {
        fail(error, "startup");
        disposeSandbox();
        return;
    }
    sandbox.onmessage = (event) => {
        const childMessage = event.data || {};
        if (!channelToken) {
            if (childMessage.type !== "ready"
                || childMessage.hardened !== true
                || childMessage.layer !== "sandbox"
                || typeof childMessage.channelToken !== "string") {
                fail(new Error("sandbox Worker did not provide a valid channel token"), "child-auth");
                disposeSandbox();
                return;
            }
            channelToken = childMessage.channelToken;
            sandbox.postMessage({
                type: "start",
                code: message.code,
                asyncMode: message.asyncMode,
                scriptInstanceId,
                shortcuts: message.shortcuts
            });
            return;
        }
        if (childMessage.channelToken !== channelToken
            || ![
                "call", "register", "eventDone", "eventRelease", "eventProcessed", "print", "compiled", "started",
                "failed", "registrationComplete", "pscriptMcpResult"
            ].includes(childMessage.type)) {
            fail(new Error("sandbox Worker sent an invalid message"), "child-auth");
            disposeSandbox();
            return;
        }
        try {
            forwardAuthenticatedChildMessage(childMessage);
        } catch (error) {
            fail(error, "child-output");
            disposeSandbox();
        }
    };
    sandbox.onerror = (event) => {
        fail(new Error(String(event.message || "sandbox Worker crashed")), "runtime");
        disposeSandbox();
    };
    sandbox.onmessageerror = () => {
        fail(new Error("sandbox Worker returned an unreadable message"), "child-output");
        disposeSandbox();
    };
}

function startParser(message) {
    try {
        parserUrl = URL.createObjectURL(new Blob([message.parserSource], { type: "text/javascript" }));
        parser = new Worker(parserUrl);
        parser.postMessage({ type: "initialize", dependency: message.dependency });
    } catch (error) {
        fail(error, "parser-startup");
        disposeParser();
        return;
    }
    parser.onmessage = (event) => {
        const parserMessage = event.data || {};
        if (!parserChannelToken) {
            if (parserMessage.type !== "ready"
                || parserMessage.hardened !== true
                || parserMessage.layer !== "parser"
                || typeof parserMessage.channelToken !== "string"
                || parserMessage.dependencyHash !== message.dependency.sha256) {
                fail(new Error("parser Worker did not provide a valid dependency attestation"), "parser-auth");
                disposeParser();
                return;
            }
            parserChannelToken = parserMessage.channelToken;
            parser.postMessage({ type: "parse", code: message.code, channelToken: parserChannelToken });
            return;
        }
        if (parserMessage.channelToken !== parserChannelToken
            || !["parsed", "error", "protocolError"].includes(parserMessage.type)) {
            fail(new Error("parser Worker sent an invalid message"), "parser-output");
            disposeParser();
            return;
        }
        if (parserMessage.type === "parsed") {
            postMessage({
                type: "sourceIdentity",
                scriptId: parserMessage.scriptId == null
                    ? null
                    : String(parserMessage.scriptId).slice(0, 64)
            });
            disposeParser();
            startSandbox(message);
            return;
        }
        if (parserMessage.type === "error") {
            postMessage({
                type: "failed",
                phase: "compile",
                error: smallValue(parserMessage.error)
            });
            disposeParser();
            return;
        }
        fail(new Error(String(parserMessage.message || "parser protocol error")), "parser");
        disposeParser();
    };
    parser.onerror = (event) => {
        fail(new Error(String(event.message || "parser Worker crashed")), "parser-runtime");
        disposeParser();
    };
    parser.onmessageerror = () => {
        fail(new Error("parser Worker returned an unreadable message"), "parser-output");
        disposeParser();
    };
}

onmessage = (event) => {
    const message = event.data || {};
    if (message.type === "shutdown") {
        shutdown(message.requestId);
        return;
    }
    if (message.type === "start") {
        if (started || typeof message.code !== "string" || typeof message.sandboxSource !== "string"
            || typeof message.parserSource !== "string" || typeof message.dependency?.source !== "string"
            || typeof message.scriptInstanceId !== "string" || !message.scriptInstanceId) {
            fail(new Error("one start message with code, parser source, sandbox source, and fixed dependency is required"));
            return;
        }
        started = true;
        scriptInstanceId = message.scriptInstanceId;
        startParser(message);
        return;
    }
    if (message.replyId && sandbox && pendingRequestIds.delete(String(message.replyId))) {
        sandbox.postMessage(message);
        return;
    }
    if (message.type === "pscriptMcpInvoke" && sandbox && channelToken) {
        const callId = Number(message.callId);
        if (!Number.isSafeInteger(callId) || callId < 1
            || message.scriptInstanceId !== scriptInstanceId
            || !isPersistentMcpName(message.name)
            || typeof message.blocking !== "boolean") {
            fail(new Error("persistent MCP invocation is malformed"));
            disposeSandbox();
            return;
        }
        if (pendingPersistentMcpCallIds.has(callId)
            || completedPersistentMcpCallIds.has(callId)) {
            fail(new Error("persistent MCP invocation reused a call id"));
            disposeSandbox();
            return;
        }
        if (pendingPersistentMcpCallIds.size >= ResourceLimits.pendingPersistentMcpCallsPerScript) {
            fail(new Error("persistent MCP invocation limit exceeded"), "resource");
            disposeSandbox();
            return;
        }
        let params;
        try {
            params = normalizePersistentMcpParams(message.params);
        } catch (error) {
            fail(error);
            disposeSandbox();
            return;
        }
        pendingPersistentMcpCallIds.add(callId);
        sandbox.postMessage({
            type: "pscriptMcpInvoke",
            scriptInstanceId,
            callId,
            name: message.name,
            params,
            blocking: message.blocking
        });
        return;
    }
    if (message.type === "event" && sandbox && channelToken) {
        queueEvent(message);
        return;
    }
    fail(new Error("unknown supervisor message"));
};

postMessage({ type: "ready", hardened: true, layer: "supervisor" });
