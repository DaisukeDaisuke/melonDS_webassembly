import { applyScreenLayout } from "./ui/screen-layout.js";
import { createRuntimeLoader } from "./runtime-loader.js";
import { createBootstrapWebMcpTools } from "./bootstrap-webmcp.js";
import { compactOutputText } from "./compact-output.js";

const ui = Object.fromEntries(
    [...document.querySelectorAll("[id]")]
        .map((element) => [element.id.replace(/-([a-z])/g, (_, character) => character.toUpperCase()), element])
);

function applyBootstrapLayout() {
    if (!ui.screenShell) return;
    applyScreenLayout(ui.screenShell, {
        scale: Number(ui.scaleSelect?.value || 2),
        rotation: Number(ui.rotationSelect?.value || 0)
    });
}

function removeBootstrapLayoutListeners() {
    ui.scaleSelect?.removeEventListener("change", applyBootstrapLayout);
    ui.rotationSelect?.removeEventListener("change", applyBootstrapLayout);
}

applyBootstrapLayout();
ui.scaleSelect?.addEventListener("change", applyBootstrapLayout);
ui.rotationSelect?.addEventListener("change", applyBootstrapLayout);

let runtimeApi = null;
const importRuntimeModule = (specifier) => import(specifier);
const runtimeLoader = createRuntimeLoader({
    loadRuntime: (attempt) => importRuntimeModule(`./emulator.js?attempt=${attempt}`),
    getApi: () => window.DesmumeMCP,
    onStart: () => {
        if (ui.readyText) ui.readyText.textContent = "loading emulator";
    },
    onLoaded: (api) => {
        runtimeApi = api;
        removeBootstrapLayoutListeners();
    },
    onError: () => {
        if (ui.readyText) ui.readyText.textContent = "emulator load failed — retry by loading ROM";
    }
});

function unloadedStatus() {
    return {
        ok: true,
        ready: false,
        emulatorLoaded: false,
        emulatorLoading: runtimeLoader.status().loading,
        emulatorLoadError: runtimeLoader.status().error?.slice(0, 500) || null,
        romLoaded: false,
        paused: true,
        running: false,
        operation: null,
        fileTransaction: { active: false, serial: 0, reason: "" },
        stateLoadSerial: 0,
        frame: 0
    };
}

function fail(code, message, details) {
    return {
        ok: false,
        error: {
            code,
            message,
            recoverable: true,
            ...(details === undefined ? {} : { details })
        }
    };
}

async function ensureEmulatorLoaded() {
    return runtimeLoader.ensureLoaded();
}

async function listStorageKeys() {
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("desmume-web-debugger", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("states");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const keys = await new Promise((resolve, reject) => {
        const transaction = db.transaction("states", "readonly");
        const request = transaction.objectStore("states").getAllKeys();
        request.onsuccess = () => resolve(request.result.map(String));
        request.onerror = () => reject(request.error);
    });
    db.close();
    return keys;
}

async function readStorageValues(keys) {
    if (!keys.length) return [];
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("desmume-web-debugger", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("states");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction("states", "readonly");
    const store = transaction.objectStore("states");
    const values = await Promise.all(keys.map((storageKey) => new Promise((resolve, reject) => {
        const request = store.get(storageKey);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    })));
    db.close();
    return values;
}

const bootstrapApi = {
    async call(name, params = {}) {
        if (runtimeApi) return runtimeApi.call(name, params);
        if (name === "status") return unloadedStatus();
        if (name === "getOperation") return { ok: true, operation: null };
        if (name === "cancelOperation") return { ok: true, cancelled: false, operation: null };
        if (name === "getInputState") {
            return { ok: true, keyMask: 0, buttons: [], touch: { active: false, x: 0, y: 0 } };
        }
        if (name === "releaseInput") {
            return { ok: true, keyMask: 0, buttons: [], touch: { active: false, x: 0, y: 0 } };
        }
        if (name === "listStateSlots" || name === "listSaveSlots") {
            const keys = await listStorageKeys();
            return {
                ok: true,
                slots: name === "listSaveSlots"
                    ? keys.filter((key) => key.startsWith("save:")).map((key) => key.slice(5))
                    : keys.filter((key) => (
                        !key.startsWith("save:")
                        && !key.startsWith("__analysis_baseline__:")
                        && !key.startsWith("input-recording:")
                    ))
                };
        }
        if (name === "listAnalysisBaselines") {
            const baselines = [];
            for (let index = 0; index < localStorage.length; index++) {
                const storageKey = localStorage.key(index);
                if (!storageKey?.startsWith("analysis-baseline:")) continue;
                try {
                    const baseline = JSON.parse(localStorage.getItem(storageKey) || "null");
                    if (!baseline || typeof baseline !== "object") continue;
                    baselines.push({
                        name: storageKey.slice("analysis-baseline:".length),
                        savedAt: baseline.savedAt || null,
                        romName: baseline.romName || "",
                        stateSize: Number(baseline.stateSize || 0),
                        stateFormatVersion: Number(baseline.stateFormatVersion || 0),
                        pcVerified: !!baseline.cpuState
                    });
                } catch (_) {
                    // Ignore malformed legacy metadata while listing healthy entries.
                }
            }
            return { ok: true, baselines };
        }
        if (name === "listInputRecordings") {
            const keys = (await listStorageKeys())
                .filter((storageKey) => storageKey.startsWith("input-recording:meta:"));
            const recordings = (await readStorageValues(keys))
                .filter(Boolean)
                .map(({ dataKey, stateKey, cpuState, ...metadata }) => metadata);
            return { ok: true, recordings };
        }
        if (["loadRomFile", "loadRomBytes", "loadRomUrl"].includes(name)) {
            try {
                const api = await ensureEmulatorLoaded();
                return api.call(name, params);
            } catch (error) {
                return fail("WASM_NOT_READY", "emulator runtime could not be loaded", {
                    message: String(error?.message || error).slice(0, 500)
                });
            }
        }
        return fail("ROM_NOT_LOADED", `${name} requires a loaded ROM`, {
            emulatorLoaded: false,
            romLoaded: false
        });
    },
    list() {
        return {
            status: "Returns bootstrap status without loading the emulator runtime.",
            getOperation: "Returns the current operation without loading the emulator runtime.",
            cancelOperation: "Cancels the current operation without loading the emulator runtime.",
            getInputState: "Returns the neutral bootstrap input state.",
            releaseInput: "Releases bootstrap input without loading the emulator runtime.",
            listStateSlots: "Lists State slots without loading the emulator runtime.",
            listSaveSlots: "Lists Save slots without loading the emulator runtime.",
            listAnalysisBaselines: "Lists analysis baselines without loading the emulator runtime.",
            listInputRecordings: "Lists input recordings without loading the emulator runtime.",
            loadRomFile: "Loads the emulator runtime once, then loads a selected local ROM.",
            loadRomBytes: "Loads the emulator runtime once, then loads supplied ROM bytes.",
            loadRomUrl: "Loads the emulator runtime once, then fetches and loads the requested ROM.",
            warning: "This is a warning. The emulator main and web assembly have not yet been loaded into memory. This list may be incomplete!"
        };
    }
};

window.DesmumeMCP = bootstrapApi;
window.DesmumeRuntimeLoader = Object.freeze({
    ensureLoaded: ensureEmulatorLoaded,
    status: runtimeLoader.status
});

function webMcpContent(result) {
    const structured = result && typeof result === "object" ? result : { ok: true, value: result };
    return compactOutputText(structured);
}

function parseWebMcpInput(input) {
    if (typeof input !== "string") return input || {};
    return input.trim() ? JSON.parse(input) : {};
}

async function registerBootstrapWebMcp() {
    const modelContext = ("modelContext" in document && document.modelContext)
        || ("modelContext" in navigator && navigator.modelContext);
    if (!modelContext || typeof modelContext.registerTool !== "function") return false;
    const tools = createBootstrapWebMcpTools({
        bootstrapApi,
        webMcpContent,
        parseInput: parseWebMcpInput,
        fail
    });
    for (const tool of tools) {
        try {
            await modelContext.registerTool(tool);
        } catch (error) {
            if (!/already|duplicate/i.test(String(error?.message || error))) throw error;
        }
    }
    return true;
}

void registerBootstrapWebMcp().catch((error) => {
    if (ui.readyText) ui.readyText.dataset.webmcpError = String(error?.message || error).slice(0, 200);
});

const loadSelectedRom = async () => {
    if (!ui.romFile.files?.length) return;
    const result = await bootstrapApi.call("loadRomFile", {});
    if (runtimeApi) ui.romFile.removeEventListener("change", loadSelectedRom);
    if (result?.ok === false && ui.readyText) {
        ui.readyText.textContent = result.error?.message || "ROM load failed";
    }
};
ui.romFile?.addEventListener("change", loadSelectedRom);

if (ui.readyText) ui.readyText.textContent = "select a ROM to load emulator";
