"use strict";

import { normalizeBoundedValue } from "../bounded-value.js";
import { normalizeWorkerRpcParams } from "../worker-rpc-payload.js";

let sandbox = null;
let sandboxUrl = "";
let channelToken = "";
let parser = null;
let parserUrl = "";
let parserChannelToken = "";
let started = false;
let childWorkerTerminateCalled = false;
let childBlobUrlRevokeCalled = false;
let childHandlersCleared = false;
const pendingRequestIds = new Set();
const MAX_PENDING_REQUESTS = 32;

function smallValue(value) {
    return normalizeBoundedValue(value, {
        maxBytes: 64 * 1024,
        maxArray: 256,
        maxNodes: 2048,
        maxDepth: 10,
        maxProperties: 128
    }).value;
}

function protocolError(message, { code = "WORKER_PROTOCOL_ERROR", phase = "supervisor", probeId = "" } = {}) {
    postMessage({
        type: "protocolError",
        message: String(message).slice(0, 2048),
        code,
        phase,
        probeId: String(probeId || "").slice(0, 256)
    });
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
            childPendingRpcAfter: pendingRequestIds.size
        }
    });
}

function rejectChild(message, options = {}) {
    protocolError(message, options);
    disposeParser();
    disposeSandbox();
}

function forwardAuthenticatedChildMessage(childMessage) {
    if (childMessage.type === "call") {
        if (typeof childMessage.command !== "string" || typeof childMessage.id !== "string"
            || !childMessage.id || pendingRequestIds.has(childMessage.id)
            || pendingRequestIds.size >= MAX_PENDING_REQUESTS) {
            throw new TypeError(`sandbox exceeded ${MAX_PENDING_REQUESTS} pending requests`);
        }
        const params = normalizeWorkerRpcParams(childMessage.command, childMessage.params || {});
        pendingRequestIds.add(childMessage.id);
        postMessage({
            type: "call",
            id: childMessage.id,
            command: childMessage.command,
            params,
            eventId: Number(childMessage.eventId) || 0,
            callbackId: childMessage.callbackId,
            callbackToken: typeof childMessage.callbackToken === "string" ? childMessage.callbackToken : ""
        });
        return false;
    }
    if (childMessage.type === "done") {
        postMessage({ type: "done", result: normalizeBoundedValue(childMessage.result).value });
        return true;
    }
    if (childMessage.type === "error") {
        postMessage({ type: "error", error: smallValue(childMessage.error) });
        return true;
    }
    postMessage({
        type: "protocolError",
        message: String(childMessage.message || "sandbox protocol error").slice(0, 2048),
        code: String(childMessage.code || "WORKER_PROTOCOL_ERROR").slice(0, 128),
        phase: String(childMessage.phase || "sandbox").slice(0, 128),
        probeId: String(childMessage.probeId || "").slice(0, 256)
    });
    return true;
}

function startSandbox(message) {
    try {
        sandboxUrl = URL.createObjectURL(new Blob([message.sandboxSource], { type: "text/javascript" }));
        sandbox = new Worker(sandboxUrl);
        sandbox.postMessage({ type: "initialize" });
    } catch (error) {
        protocolError(`sandbox Worker could not be started: ${String(error?.message || error)}`, { phase: "startup" });
        disposeSandbox();
        return;
    }
    sandbox.onmessage = (sandboxEvent) => {
        const childMessage = sandboxEvent.data || {};
        if (!channelToken) {
            if (childMessage.type !== "ready"
                || childMessage.hardened !== true
                || childMessage.layer !== "sandbox"
                || typeof childMessage.channelToken !== "string") {
                rejectChild("sandbox Worker did not provide a valid channel token", { phase: "child-auth" });
                return;
            }
            channelToken = childMessage.channelToken;
            sandbox.postMessage({ type: "run", code: message.code, shortcuts: message.shortcuts });
            return;
        }
        if (childMessage.channelToken !== channelToken
            || !["call", "done", "error", "protocolError"].includes(childMessage.type)) {
            rejectChild("sandbox Worker sent an invalid message");
            return;
        }
        try {
            const terminal = forwardAuthenticatedChildMessage(childMessage);
            if (terminal) disposeSandbox();
        } catch (error) {
            rejectChild(String(error?.message || error), { phase: "child-output" });
        }
    };
    sandbox.onerror = (sandboxEvent) => {
        protocolError(String(sandboxEvent.message || "sandbox Worker crashed"), { phase: "runtime" });
        disposeSandbox();
    };
    sandbox.onmessageerror = () => {
        protocolError("sandbox Worker returned an unreadable message", { phase: "child-output" });
        disposeSandbox();
    };
}

function startParser(message) {
    try {
        parserUrl = URL.createObjectURL(new Blob([message.parserSource], { type: "text/javascript" }));
        parser = new Worker(parserUrl);
        parser.postMessage({ type: "initialize", dependency: message.dependency });
    } catch (error) {
        protocolError(`parser Worker could not be started: ${String(error?.message || error)}`, { phase: "parser-startup" });
        disposeParser();
        return;
    }
    parser.onmessage = (parserEvent) => {
        const parserMessage = parserEvent.data || {};
        if (!parserChannelToken) {
            if (parserMessage.type !== "ready"
                || parserMessage.hardened !== true
                || parserMessage.layer !== "parser"
                || typeof parserMessage.channelToken !== "string"
                || parserMessage.dependencyHash !== message.dependency.sha256) {
                rejectChild("parser Worker did not provide a valid dependency attestation", { phase: "parser-auth" });
                return;
            }
            parserChannelToken = parserMessage.channelToken;
            parser.postMessage({ type: "parse", code: message.code, channelToken: parserChannelToken });
            return;
        }
        if (parserMessage.channelToken !== parserChannelToken
            || !["parsed", "error", "protocolError"].includes(parserMessage.type)) {
            rejectChild("parser Worker sent an invalid message", { phase: "parser-output" });
            return;
        }
        if (parserMessage.type === "parsed") {
            disposeParser();
            startSandbox(message);
            return;
        }
        if (parserMessage.type === "error") {
            postMessage({ type: "error", error: smallValue(parserMessage.error) });
            disposeParser();
            return;
        }
        protocolError(String(parserMessage.message || "parser protocol error").slice(0, 2048), {
            phase: "parser"
        });
        disposeParser();
    };
    parser.onerror = (parserEvent) => {
        protocolError(String(parserEvent.message || "parser Worker crashed"), { phase: "parser-runtime" });
        disposeParser();
    };
    parser.onmessageerror = () => {
        protocolError("parser Worker returned an unreadable message", { phase: "parser-output" });
        disposeParser();
    };
}

onmessage = (event) => {
    const message = event.data || {};
    if (message.type === "shutdown") {
        shutdown(message.requestId);
        return;
    }
    if (message.type === "run") {
        if (started
            || typeof message.code !== "string"
            || typeof message.sandboxSource !== "string"
            || typeof message.parserSource !== "string"
            || typeof message.dependency?.source !== "string") {
            protocolError("one run message with code, parser source, sandbox source, and fixed dependency is required");
            return;
        }
        started = true;
        startParser(message);
        return;
    }
    if (message.replyId && sandbox && channelToken
        && pendingRequestIds.delete(String(message.replyId))) {
        sandbox.postMessage(message);
        return;
    }
    protocolError("unknown supervisor message");
};

postMessage({ type: "ready", hardened: true, layer: "supervisor" });
