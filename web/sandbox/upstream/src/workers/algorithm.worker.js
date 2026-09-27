"use strict";

import { assertLockedGlobals, initializeLockedDependency, lockDownCapabilityPrototypes } from "./dependency-bootstrap.js";

(() => {
const nativePostMessage = globalThis.postMessage.bind(globalThis);
const nativeAddEventListener = globalThis.addEventListener.bind(globalThis);
const nativeEval = globalThis.eval;
const nativeDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
const NativeTextEncoder = globalThis.TextEncoder;
const nativeSetTimeout = globalThis.setTimeout?.bind(globalThis);
const nativeSetInterval = globalThis.setInterval?.bind(globalThis);
const channelToken = globalThis.crypto.randomUUID();
const send = (message) => nativePostMessage({ ...message, channelToken });
let ssim = null;

const fetch = undefined;
const XMLHttpRequest = undefined;
const WebSocket = undefined;
const EventSource = undefined;
const importScripts = undefined;
const Function = undefined;

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
        if (!Object.prototype.hasOwnProperty.call(prototype, "constructor")) continue;
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

lockDownRuntimeCodeGeneration();
lockDownCapabilityPrototypes();
assertLockedGlobals();

function normalizeArea({ width, screen = "both", region, ignoreRects = [] }) {
    const baseY = screen === "bottom" ? 192 : 0;
    const areaHeight = screen === "both" ? 384 : 192;
    if (!["top", "bottom", "both"].includes(screen)) throw new Error("invalid screen");
    if (region !== undefined && (!Array.isArray(region) || region.length !== 4)) throw new Error("invalid region");
    if (!Array.isArray(ignoreRects)) throw new Error("invalid ignoreRects");
    const [x, y, areaWidth, height] = (region || [0, 0, width, areaHeight]).map(Number);
    if (![x, y, areaWidth, height].every(Number.isInteger)
        || x < 0 || y < 0 || areaWidth <= 0 || height <= 0
        || x + areaWidth > width || y + height > areaHeight) {
        throw new Error("invalid region");
    }
    const ignored = ignoreRects.map((rect) => {
        if (!Array.isArray(rect) || rect.length !== 4) throw new Error("invalid ignore rect");
        const values = rect.map(Number);
        const [rectX, rectY, rectWidth, rectHeight] = values;
        if (!values.every(Number.isInteger)
            || rectX < 0 || rectY < 0 || rectWidth <= 0 || rectHeight <= 0
            || rectX + rectWidth > width || rectY + rectHeight > areaHeight) {
            throw new Error("invalid ignore rect");
        }
        return values;
    });
    return { x, y: y + baseY, width: areaWidth, height, baseY, ignoreRects: ignored };
}

function isIgnored(x, y, area) {
    return area.ignoreRects.some(([rectX, rectY, width, height]) => (
        x >= rectX && x < rectX + width
        && y - area.baseY >= rectY && y - area.baseY < rectY + height
    ));
}

function tileImage(pixels, sourceWidth, area, tileX, tileY, tileWidth, tileHeight, baselinePixels) {
    const data = new Uint8ClampedArray(tileWidth * tileHeight * 4);
    for (let y = 0; y < tileHeight; y++) {
        for (let x = 0; x < tileWidth; x++) {
            const sourceX = tileX + x;
            const sourceY = tileY + y;
            const sourceIndex = sourceY * sourceWidth + sourceX;
            const pixel = isIgnored(sourceX, sourceY, area) && baselinePixels
                ? baselinePixels[sourceIndex]
                : pixels[sourceIndex];
            const target = (y * tileWidth + x) * 4;
            data[target] = pixel & 255;
            data[target + 1] = (pixel >>> 8) & 255;
            data[target + 2] = (pixel >>> 16) & 255;
            data[target + 3] = 255;
        }
    }
    return { data, width: tileWidth, height: tileHeight };
}

function compare(message) {
    const area = normalizeArea(message);
    const tileSize = Math.max(8, Math.min(64, Number(message.options?.tileSize ?? 16)));
    const threshold = Number(message.options?.tileThresholdPct ?? 12);
    const trimTopPct = Math.max(0, Math.min(40, Number(message.options?.trimTopPct ?? 20)));
    const scores = [];
    for (let tileY = area.y; tileY < area.y + area.height; tileY += tileSize) {
        for (let tileX = area.x; tileX < area.x + area.width; tileX += tileSize) {
            const width = Math.min(tileSize, area.x + area.width - tileX);
            const height = Math.min(tileSize, area.y + area.height - tileY);
            const baseline = tileImage(message.baseline, message.width, area, tileX, tileY, width, height);
            const current = tileImage(
                message.current,
                message.width,
                area,
                tileX,
                tileY,
                width,
                height,
                message.baseline
            );
            const result = ssim(baseline, current, { ssim: "fast" });
            scores.push((1 - Number(result.mssim)) * 100);
        }
    }
    scores.sort((left, right) => right - left);
    const trimmedTiles = Math.floor(scores.length * trimTopPct / 100);
    const kept = scores.slice(trimmedTiles);
    const changedTiles = kept.filter((score) => score >= threshold).length;
    return {
        pct: kept.length ? changedTiles / kept.length * 100 : 0,
        debug: {
            rawPct: scores.length ? scores.filter((score) => score >= threshold).length / scores.length * 100 : 0,
            comparedTiles: kept.length,
            trimmedTiles,
            changedTiles
        }
    };
}

nativeAddEventListener("message", async (event) => {
    const message = event.data || {};
    if (!ssim) {
        if (message.type !== "initialize") {
            send({ type: "protocolError", message: "dependency initialization is required" });
            return;
        }
        try {
            const dependency = await initializeLockedDependency({
                dependency: message.dependency,
                nativeEval,
                nativeDigest,
                NativeTextEncoder
            });
            if (typeof dependency.ssim !== "function") throw new Error("SSIM export is unavailable");
            ssim = dependency.ssim;
            send({ type: "ready", hardened: true, layer: "sandbox", dependencyHash: message.dependency.sha256 });
        } catch (error) {
            send({ type: "protocolError", message: `dependency initialization failed: ${String(error?.message || error)}` });
        }
        return;
    }
    if (message.channelToken !== channelToken) {
        send({ type: "protocolError", message: "algorithm Worker token mismatch" });
        return;
    }
    if (message.type !== "compare") {
        send({ type: "protocolError", message: "unknown algorithm Worker message" });
        return;
    }
    try {
        send({ type: "done", result: compare(message) });
    } catch (error) {
        send({
            type: "error",
            message: String(error?.message || error),
            errorName: String(error?.name || "Error")
        });
    }
});

send({ type: "bootstrapReady", hardened: true, layer: "bootstrap" });
})();
