import { ErrorCode } from "./error-codes.js";
import { createEmbeddedWorker } from "./worker-host.js";
import persistentScriptSupervisorSource from "./workers/persistent-script-supervisor.worker.js";
import persistentScriptSandboxSource from "./workers/persistent-script.worker.js";
import parserWorkerSource from "./workers/parser.worker.js";
import { withInternalMetadata } from "./internal-command-metadata.js";
import { validateWorkerRpc } from "./script-rpc-policy.js";
import { assertSafeScriptSource } from "./script-source-policy.js";
import { ResourceLimits } from "./resource-limits.js";
import {
    normalizePersistentMcpMetadata,
    normalizePersistentMcpParams,
    normalizePersistentMcpResult
} from "./worker-rpc-payload.js";
import { readOwnDataProperty } from "./structured-value-normalizer.js";
import { codedError } from "./validation.js";
import acornDependency from "./dependencies/acorn.dependency-source.js";

export function createScriptService({
    state,
    ui,
    responder,
    breakpointOwners,
    ensureRomLoaded,
    finishPersistentScriptEvent,
    requestPersistentScriptResume,
    settlePersistentScriptCallbacks,
    hex,
    parseAddress,
    rawOutputText,
    runCommand,
    getCommands,
    onExplicitPause
}) {
    let scriptInstanceSerial = 1;
    let queuedScriptEventSerial = 1;
    const commands = new Proxy({}, {
        get: (_, command) => getCommands()[command]
    });

    const SCRIPT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
    const IDENTITY_PRIORITY = Object.freeze({
        generated: 0,
        "runtime-return": 1,
        "source-comment": 2,
        "api-name": 3
    });

    function normalizeScriptIdentity(value) {
        return typeof value === "string" && SCRIPT_NAME_PATTERN.test(value) ? value : null;
    }

    function applyScriptIdentity(script, candidate, source) {
        const name = normalizeScriptIdentity(candidate);
        if (!name) return false;
        if (source === "source-comment") script.declaredCommentId = name;
        if (source === "runtime-return") script.declaredReturnFallbackId = name;
        const currentPriority = IDENTITY_PRIORITY[script.identitySource] ?? 0;
        const nextPriority = IDENTITY_PRIORITY[source] ?? 0;
        if (name === script.name) {
            if (nextPriority >= currentPriority) {
                script.identitySource = source;
                script.nameProvisional = false;
            }
            return true;
        }
        if (nextPriority <= currentPriority) {
            script.identityConflict = true;
            return false;
        }
        const collision = [...state.scripts.values()].find((other) => (
            other !== script && other.name === name
        ));
        if (collision) {
            script.identityConflict = true;
            script.identityCollision = {
                requestedName: name,
                existingId: collision.id,
                existingRunning: collision.running === true
            };
            return false;
        }
        script.name = name;
        script.nameProvisional = false;
        script.identitySource = source;
        renderScripts();
        if (state.activeScriptId === script.id) ui.scriptName.value = script.name;
        return true;
    }

    const scriptBytes = (script) => new TextEncoder().encode(`${script.code}\n${script.output.join("\n")}`).byteLength;

    function pruneStoppedScripts(requiredBytes = 0) {
        const stopped = [...state.scripts.values()]
            .filter((script) => !script.running && script.id !== state.activeScriptId)
            .sort((left, right) => Number(left.stoppedAt || 0) - Number(right.stoppedAt || 0));
        const totalBytes = () => [...state.scripts.values()].reduce((sum, script) => sum + scriptBytes(script), 0);
        while (stopped.length && (state.scripts.size >= ResourceLimits.totalScriptRecords
            || totalBytes() + requiredBytes > ResourceLimits.totalScriptHistoryBytes)) {
            const removed = stopped.shift();
            state.scripts.delete(removed.id);
        }
        if (!state.scripts.has(state.activeScriptId)) {
            state.activeScriptId = [...state.scripts.values()].at(-1)?.id || 0;
        }
        return totalBytes();
    }

    function scriptConsoleLine(script, values) {
        const line = values.map((value) => typeof value === "string" ? value : rawOutputText(value)).join(" ");
        if (!Number.isSafeInteger(script.outputStartLine) || script.outputStartLine < 1) {
            script.outputStartLine = 1;
        }
        if (!Number.isSafeInteger(script.nextOutputLine) || script.nextOutputLine < script.outputStartLine) {
            script.nextOutputLine = script.outputStartLine + script.output.length;
        }
        script.output.push(`[${new Date().toLocaleTimeString()}] ${line}`);
        script.nextOutputLine += 1;
        let outputBytes = new TextEncoder().encode(script.output.join("\n")).byteLength;
        while (outputBytes > ResourceLimits.scriptOutputBytes && script.output.length > 0) {
            script.output.shift();
            script.outputStartLine += 1;
            outputBytes = new TextEncoder().encode(script.output.join("\n")).byteLength;
        }
        pruneStoppedScripts();
        if (state.activeScriptId === script.id) renderScriptConsole(script);
    }

    function scriptFailureDetails(message, source) {
        const error = message.error || {};
        const stack = String(error.stack || "");
        const location = stack.match(/desmume-persistent-user\.js:(\d+):(\d+)/);
        const line = location ? Math.max(1, Number(location[1]) - 2) : undefined;
        const column = location ? Number(location[2]) : undefined;
        const sourceExcerpt = line
            ? String(source).split(/\r?\n/)[line - 1]?.slice(0, 240)
            : undefined;
        return {
            phase: String(message.phase || "runtime"),
            errorName: String(error.name || "Error"),
            ...(line ? { line } : {}),
            ...(column ? { column } : {}),
            sourceName: "desmume-persistent-user.js",
            ...(sourceExcerpt ? { sourceExcerpt } : {}),
            ...(stack ? { stack: stack.split("\n").slice(0, 3).join("\n").slice(0, 600) } : {})
        };
    }

    function scriptFailureResult(message, source) {
        const phase = String(message.phase || "runtime");
        const code = phase === "compile"
            ? ErrorCode.SCRIPT_COMPILE_ERROR
            : phase === "protocol"
                ? ErrorCode.WORKER_PROTOCOL_ERROR
                : ErrorCode.SCRIPT_RUNTIME_ERROR;
        return responder.fail(
            code,
            String(message.error?.message || message.error || "Persistent script failed"),
            scriptFailureDetails(message, source)
        );
    }

    function workerRpcError(error, fallbackCode = ErrorCode.INTERNAL_ERROR) {
        return {
            code: String(error?.mcpCode || fallbackCode),
            message: String(error?.message || error || "Worker RPC failed").slice(0, 2048),
            ...(error?.mcpDetails === undefined ? {} : { details: error.mcpDetails })
        };
    }
    
    function renderScriptConsole(script = state.scripts.get(state.activeScriptId)) {
        const text = script ? script.output.join("\n") : "No script selected.";
        ui.scriptRawOutput.value = text;
        ui.scriptOutput.textContent = text || "No console output.";
    }
    
    function renderScripts() {
        const selected = state.scripts.get(state.activeScriptId);
        ui.scriptTabs.replaceChildren();
        ui.scriptList.replaceChildren();
        for (const script of state.scripts.values()) {
            const tab = ui.scriptTabTemplate.content.firstElementChild.cloneNode(true);
            tab.textContent = script.name;
            tab.dataset.scriptTab = script.id;
            tab.setAttribute("aria-selected", String(script.id === state.activeScriptId));
            tab.addEventListener("click", () => selectScript(script.id));
            ui.scriptTabs.append(tab);
            const row = document.createElement("button");
            row.type = "button";
            row.dataset.running = String(script.running);
            row.textContent = `${script.name} · ${script.running ? "running" : "stopped"} · ${script.triggers.length} triggers · ${script.pscriptMcps.size} MCPs`;
            row.addEventListener("click", () => selectScript(script.id));
            ui.scriptList.append(row);
        }
        if (!selected && state.scripts.size) selectScript(state.scripts.values().next().value.id);
    }
    
    function selectScript(id) {
        const script = state.scripts.get(Number(id));
        if (!script) return;
        state.activeScriptId = script.id;
        ui.scriptName.value = script.name;
        ui.scriptAsyncMode.checked = script.asyncMode;
        if (document.activeElement !== ui.scriptCode) ui.scriptCode.value = script.code;
        renderScriptConsole(script);
        renderScripts();
    }
    
    function enqueueScriptEvent(script, message) {
        if (message.event === "tick") {
            const index = script.eventQueue.findIndex((queued) => queued.event === "tick");
            if (index >= 0) {
                script.eventQueue[index] = message;
                script.droppedEvents++;
                return true;
            }
        }
        if (script.eventQueue.length >= ResourceLimits.persistentEventQueue) {
            void failPersistentScript(script, new Error(`main event queue exceeded ${ResourceLimits.persistentEventQueue}`));
            return false;
        }
        script.eventQueue.push(message);
        pumpScriptEvents(script);
        return true;
    }

    function dispatchScriptEvent(type, payload = {}) {
        for (const script of state.scripts.values()) {
            if (!script.running || !script.started) continue;
            const message = { type: "event", event: type, payload };
            enqueueScriptEvent(script, message);
        }
    }

    async function dispatchScriptEventAndWait(type, payload = {}) {
        const completions = [];
        for (const script of state.scripts.values()) {
            if (!script.running || !script.started) continue;
            const queueEventId = queuedScriptEventSerial++;
            let pendingAck;
            const completion = new Promise((resolve, reject) => {
                pendingAck = { resolve, reject, type };
                script.pendingEventAcks.set(queueEventId, pendingAck);
            });
            completions.push(completion);
            if (!enqueueScriptEvent(script, {
                type: "event",
                event: type,
                payload,
                queueEventId
            })) {
                script.pendingEventAcks.delete(queueEventId);
                pendingAck.reject(codedError(ErrorCode.BUSY, `Persistent script event queue is full: ${type}`, {
                    scriptId: script.id,
                    scriptName: script.name,
                    event: type
                }));
                break;
            }
        }
        await Promise.all(completions);
        return { event: type, scriptsCompleted: completions.length };
    }

    function pumpScriptEvents(script) {
        if (!script.running || !script.started || script.eventBusy || !script.eventQueue.length) return;
        script.eventBusy = true;
        try {
            script.worker.postMessage(script.eventQueue.shift());
        } catch (error) {
            script.eventBusy = false;
            void failPersistentScript(script, error);
        }
    }

    function isCurrentScript(script) {
        return script.running && state.scripts.get(script.id) === script;
    }

    function rejectPendingPScriptMcpCalls(
        script,
        code = ErrorCode.SCRIPT_RUNTIME_ERROR,
        message = "Persistent script stopped before its MCP call completed"
    ) {
        for (const pending of script.pendingPScriptMcpCalls.values()) {
            clearTimeout(pending.timer);
            pending.reject(codedError(code, message, {
                scriptId: script.id,
                name: pending.name
            }));
        }
        script.pendingPScriptMcpCalls.clear();
        script.expiredPScriptMcpCalls.clear();
        script.inFlightPScriptMcpCalls.clear();
    }

    function rejectPendingScriptEventAcks(script, reason = "Persistent script stopped before event processing completed") {
        for (const [queueEventId, pending] of script.pendingEventAcks) {
            pending.reject(codedError(ErrorCode.CANCELLED, reason, {
                scriptId: script.id,
                scriptName: script.name,
                queueEventId,
                event: pending.type
            }));
        }
        script.pendingEventAcks.clear();
    }

    function waitForScriptRegistration(script) {
        if (script.registrationComplete) return Promise.resolve(scriptSummary(script, true));
        return new Promise((resolve) => {
            script.registrationWaiters.add(resolve);
        });
    }

    function settleScriptRegistrationWaiters(script, result) {
        for (const resolve of script.registrationWaiters) resolve(result);
        script.registrationWaiters.clear();
    }

    function pruneExpiredPScriptMcpTombstones(script) {
        const now = Date.now();
        for (const [callId, expiresAt] of script.expiredPScriptMcpCalls) {
            if (expiresAt > now) break;
            script.expiredPScriptMcpCalls.delete(callId);
        }
        while (script.expiredPScriptMcpCalls.size > ResourceLimits.expiredPersistentMcpCallsPerScript) {
            script.expiredPScriptMcpCalls.delete(script.expiredPScriptMcpCalls.keys().next().value);
        }
    }

    function nextPScriptMcpCallId(script) {
        for (let attempts = 0; attempts < Number.MAX_SAFE_INTEGER; attempts++) {
            const callId = script.nextPScriptMcpCallId;
            script.nextPScriptMcpCallId = callId >= Number.MAX_SAFE_INTEGER ? 1 : callId + 1;
            if (!script.inFlightPScriptMcpCalls.has(callId)) return callId;
        }
        throw codedError(ErrorCode.BUSY, "No persistent script MCP call ID is available");
    }

    function listPScriptMcps(scriptId) {
        const scripts = scriptId === undefined
            ? [...state.scripts.values()]
            : [state.scripts.get(scriptId)].filter(Boolean);
        const mcps = [];
        for (const script of scripts) {
            if (!isCurrentScript(script) || !script.pscriptMcpPublished) continue;
            for (const metadata of script.pscriptMcps.values()) {
                mcps.push({
                    scriptId: script.id,
                    scriptName: script.name,
                    name: metadata.name,
                    description: metadata.description
                });
            }
        }
        return { mcps };
    }

    function compactPScriptMcpDirectory() {
        return [...state.scripts.values()]
            .filter(isCurrentScript)
            .sort((left, right) => left.id - right.id)
            .map((script) => ({
                id: script.id,
                name: script.name,
                registrationComplete: script.registrationComplete,
                mcps: script.registrationComplete
                    ? [...script.pscriptMcps.keys()].sort()
                    : []
            }));
    }

    function resolvePScriptMcpTarget({ scriptId, scriptName, name }) {
        let scripts = [...state.scripts.values()].filter(isCurrentScript);
        if (scriptId !== undefined) scripts = scripts.filter((script) => script.id === scriptId);
        if (scriptName !== undefined) scripts = scripts.filter((script) => script.name === scriptName);
        const matches = scripts.filter((script) => (
            script.registrationComplete && script.pscriptMcps.has(name)
        ));
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) {
            throw codedError(
                ErrorCode.SCRIPT_MCP_AMBIGUOUS,
                `Multiple persistent scripts publish MCP: ${name}`,
                {
                    matches: matches.map((script) => ({ id: script.id, name: script.name })),
                    requiredSelector: "scriptId, id, or scriptName"
                }
            );
        }
        const selectedPending = scripts.find((script) => !script.registrationComplete);
        if (selectedPending && (scriptId !== undefined || scriptName !== undefined)) {
            throw codedError(
                ErrorCode.BUSY,
                "Persistent script registration is not complete",
                {
                    scriptId: selectedPending.id,
                    scriptName: selectedPending.name,
                    name,
                    registrationComplete: false
                }
            );
        }
        throw codedError(
            ErrorCode.SCRIPT_MCP_NOT_FOUND,
            `Persistent script MCP is not available: ${name}`,
            {
                requested: {
                    ...(scriptId === undefined ? {} : { scriptId }),
                    ...(scriptName === undefined ? {} : { scriptName }),
                    name
                },
                available: compactPScriptMcpDirectory()
            }
        );
    }

    function callPScriptMcp({ scriptId, scriptName, name, params, blocking, timeoutMs }) {
        const script = resolvePScriptMcpTarget({ scriptId, scriptName, name });
        scriptId = script.id;
        pruneExpiredPScriptMcpTombstones(script);
        if (script.inFlightPScriptMcpCalls.size >= ResourceLimits.pendingPersistentMcpCallsPerScript) {
            throw codedError(ErrorCode.BUSY, "Persistent script MCP call limit reached", {
                scriptId,
                maximum: ResourceLimits.pendingPersistentMcpCallsPerScript
            });
        }
        if (blocking && script.eventQueue.length >= ResourceLimits.persistentEventQueue) {
            throw codedError(ErrorCode.BUSY, "Persistent script work queue is full", {
                scriptId,
                maximum: ResourceLimits.persistentEventQueue
            });
        }
        let normalizedParams;
        try {
            normalizedParams = normalizePersistentMcpParams(params);
        } catch (error) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                `Persistent script MCP params are invalid: ${String(error?.message || error)}`
            );
        }
        const callId = nextPScriptMcpCallId(script);
        const message = {
            type: "pscriptMcpInvoke",
            scriptInstanceId: script.scriptInstanceId,
            callId,
            name,
            params: normalizedParams,
            blocking
        };
        const promise = new Promise((resolve, reject) => {
            const pending = { resolve, reject, name, blocking, timer: 0 };
            pending.timer = setTimeout(() => {
                if (script.pendingPScriptMcpCalls.get(callId) !== pending) return;
                script.pendingPScriptMcpCalls.delete(callId);
                script.expiredPScriptMcpCalls.set(
                    callId,
                    Date.now() + ResourceLimits.persistentMcpTombstoneMs
                );
                pruneExpiredPScriptMcpTombstones(script);
                reject(codedError(
                    ErrorCode.TIMEOUT,
                    `Persistent script MCP call timed out after ${timeoutMs} ms. Increase callPScriptMcp.timeoutMs (milliseconds) for long-running handlers.`,
                    {
                        scriptId,
                        scriptName: script.name,
                        name,
                        timeoutMs,
                        timeoutParameter: "timeoutMs"
                    }
                ));
            }, timeoutMs);
            script.pendingPScriptMcpCalls.set(callId, pending);
        });
        script.inFlightPScriptMcpCalls.set(callId, { name, blocking });
        if (blocking) {
            script.eventQueue.push(message);
            pumpScriptEvents(script);
        } else {
            try {
                script.worker.postMessage(message);
            } catch (error) {
                const pending = script.pendingPScriptMcpCalls.get(callId);
                if (pending) {
                    clearTimeout(pending.timer);
                    script.pendingPScriptMcpCalls.delete(callId);
                    script.inFlightPScriptMcpCalls.delete(callId);
                    pending.reject(error);
                }
            }
        }
        return promise;
    }

    function completeScriptRegistration(script, message) {
        if (message.scriptInstanceId !== script.scriptInstanceId || script.registrationComplete) {
            throw codedError(
                ErrorCode.WORKER_PROTOCOL_ERROR,
                "Persistent script sent an invalid registration completion"
            );
        }
        if (message.fallbackId !== null && message.fallbackId !== undefined) {
            if (!normalizeScriptIdentity(message.fallbackId)) {
                throw codedError(
                    ErrorCode.WORKER_PROTOCOL_ERROR,
                    "Persistent script returned an invalid fallbackId"
                );
            }
            applyScriptIdentity(script, message.fallbackId, "runtime-return");
        }
        const metadata = normalizePersistentMcpMetadata(message.mcps);
        const next = new Map();
        for (const item of metadata) next.set(item.name, item);
        script.pscriptMcps = next;
        script.registrationComplete = true;
        script.topLevelRunning = false;
        script.pscriptMcpPublished = true;
        renderScripts();
        settleScriptRegistrationWaiters(script, scriptSummary(script, true));
    }

    function finishPScriptMcpCall(script, message) {
        if (message.scriptInstanceId !== script.scriptInstanceId) return;
        const callId = Number(message.callId);
        if (!Number.isSafeInteger(callId) || callId < 1 || typeof message.ok !== "boolean") {
            throw codedError(
                ErrorCode.WORKER_PROTOCOL_ERROR,
                "Persistent script sent a malformed MCP result"
            );
        }
        const active = script.inFlightPScriptMcpCalls.get(callId);
        if (!active) {
            scriptConsoleLine(script, [`ignored unknown MCP result: ${callId}`]);
            return;
        }
        const payload = message.ok
            ? normalizePersistentMcpResult(message.value)
            : normalizePersistentMcpResult(message.error);
        script.inFlightPScriptMcpCalls.delete(callId);
        if (active.blocking) {
            script.eventBusy = false;
            pumpScriptEvents(script);
        }
        if (script.expiredPScriptMcpCalls.delete(callId)) return;
        const pending = script.pendingPScriptMcpCalls.get(callId);
        if (!pending) {
            scriptConsoleLine(script, [`ignored expired MCP result: ${callId}`]);
            return;
        }
        clearTimeout(pending.timer);
        script.pendingPScriptMcpCalls.delete(callId);
        if (message.ok) {
            pending.resolve({
                scriptId: script.id,
                scriptName: script.name,
                name: active.name,
                blocking: active.blocking,
                value: payload
            });
            return;
        }
        const code = readOwnDataProperty(payload, "code");
        const errorMessage = readOwnDataProperty(payload, "message");
        const details = readOwnDataProperty(payload, "details");
        pending.reject(codedError(
            typeof code === "string" ? code : ErrorCode.SCRIPT_RUNTIME_ERROR,
            typeof errorMessage === "string" ? errorMessage : "Persistent script MCP handler failed",
            {
                scriptId: script.id,
                scriptName: script.name,
                name: active.name,
                ...(details === undefined ? {} : { worker: details })
            }
        ));
    }
    
    async function unregisterScriptTriggers(script) {
        const failures = [];
        for (const trigger of [...script.triggers]) {
            for (const ownerId of [trigger.breakpointId, trigger.specialBreakpointId].filter(Boolean)) {
                try {
                    await commands.removeBreakpoint({ id: ownerId });
                } catch (error) {
                    breakpointOwners.discardOwner(ownerId);
                    failures.push({ ownerId, message: String(error?.message || error).slice(0, 300) });
                }
            }
            state.scriptTriggers = state.scriptTriggers.filter((item) => item.id !== trigger.id);
        }
        script.triggers = [];
        for (const ownerId of [...script.ownedBreakpointIds]) {
            try {
                if (breakpointOwners.findBreakpointById(ownerId)) {
                    await commands.removeBreakpoint({ id: ownerId });
                }
            } catch (error) {
                breakpointOwners.discardOwner(ownerId);
                failures.push({ ownerId, message: String(error?.message || error).slice(0, 300) });
            }
        }
        script.ownedBreakpointIds.clear();
        try {
            breakpointOwners.reconcileNativeBreakpoints();
        } catch (error) {
            failures.push({ stage: "reconcile", message: String(error?.message || error).slice(0, 300) });
        }
        if (failures.length) {
            const error = new Error("persistent script trigger cleanup required recovery");
            error.mcpCode = ErrorCode.NATIVE_ERROR;
            error.mcpDetails = { failures };
            throw error;
        }
    }
    
    async function registerScriptTrigger(script, trigger) {
        ensureRomLoaded("script trigger registration requires a loaded ROM");
        if (script.triggers.length >= ResourceLimits.scriptTriggers) {
            throw new Error(`script trigger limit exceeded (${ResourceLimits.scriptTriggers})`);
        }
        const type = String(trigger.kind || trigger.type || "tick");
        const item = { id: state.nextScriptTriggerId++, scriptId: script.id, callbackId: Number(trigger.callbackId), type, cpu: String(trigger.cpu || state.selectedCpu), address: parseAddress(trigger.address, 0, trigger.cpu) };
        if (["read", "write", "exec"].includes(type)) {
            const result = await commands.setBreakpoint(withInternalMetadata(
                { cpu: item.cpu, type, address: item.address, enabled: true },
                { origin: "script", scriptId: script.id, triggerId: item.id }
            ));
            item.breakpointId = result.id;
        } else if (["dataAbort", "prefetchAbort", "undefinedInstruction"].includes(type)) {
            const result = await commands.setSpecialBreakpoint(withInternalMetadata(
                { kind: type, enabled: true },
                { origin: "script", scriptId: script.id, triggerId: item.id }
            ));
            item.specialBreakpointId = result.id;
        } else if (type !== "tick" && type !== "start" && type !== "stateLoad" && type !== "stateSave") {
            throw new Error(`unknown script trigger: ${type}`);
        }
        script.triggers.push(item);
        state.scriptTriggers.push(item);
        renderScripts();
        return item;
    }
    
    const ASYNC_SCRIPT_BLOCKED_COMMANDS = new Set([
        "pause", "resume", "memorySetRegister",
        "memoryReadByte", "memoryReadWord", "memoryReadDword",
        "memoryWriteByte", "memoryWriteWord", "memoryWriteDword", "dumpMemory",
        "writeMemory", "injectMemoryFile", "injectBytes", "setMemoryFreeze"
    ]);
    const CALLBACK_DESTRUCTIVE_COMMANDS = new Set([
        "reset", "reloadRom", "reloadRecentFile",
        "loadRomFile", "loadRomBytes", "loadRomUrl",
        "loadState", "loadStateBytes", "loadStateUrl", "importStateFile",
        "restoreAnalysisBaseline", "loadSaveSlot", "importSaveFile"
    ]);
    
    function queuePersistentScriptOperation(script, command, params, eventIdentity = {}) {
        const eventId = Number(eventIdentity.eventId) || 0;
        const operation = script.queue.then(async () => {
            if (!script.running) throw new Error(`script stopped before queued ${command} operation`);
            if (command === "resume" && eventId) {
                const token = String(eventIdentity.callbackToken || "");
                const completion = script.pendingEventReleases.get(token);
                if (!completion) throw new Error("resume request was not preceded by a valid event release");
                script.pendingEventReleases.delete(token);
                return completion;
            }
            if (eventId && CALLBACK_DESTRUCTIVE_COMMANDS.has(command)) {
                throw codedError(
                    ErrorCode.COMMAND_NOT_ALLOWED,
                    `${command} is unavailable inside a persistent breakpoint callback because lifecycle completion would be re-entrant`,
                    {
                        command,
                        eventId,
                        scriptId: script.id,
                        reason: "destructive-callback-reentrancy"
                    }
                );
            }
            if (script.asyncMode && ASYNC_SCRIPT_BLOCKED_COMMANDS.has(command)) {
                throw new Error(`${command} is unavailable in persistent-script async mode because it requires immediate emulator state. Restart with asyncMode:false (or clear “async queue” in the UI).`);
            }
            if (command === "register") return registerScriptTrigger(script, params);
            if (command === "setBreakpoint" || command === "setSpecialBreakpoint") {
                const result = await commands[command](withInternalMetadata(params, {
                    origin: "script",
                    scriptId: script.id
                }));
                if (params.enabled !== false && Number.isSafeInteger(Number(result?.id))) {
                    script.ownedBreakpointIds.add(Number(result.id));
                }
                return result;
            }
            if (command === "removeBreakpoint") {
                const result = await runCommand(command, params);
                if (result?.ok !== false) script.ownedBreakpointIds.delete(Number(params.id));
                return result;
            }
            const result = command === "pause" && eventId
                ? await commands.pause(withInternalMetadata(params, {
                    scriptCallback: true,
                    scriptId: script.id,
                    scriptEventId: eventId
                }))
                : await runCommand(command, params);
            if (command === "pause" && eventId && result?.ok !== false) {
                onExplicitPause({ scriptId: script.id, eventId: Number(eventId) });
            }
            return result;
        });
        script.queue = operation.catch(() => undefined);
        return operation;
    }
    
    async function startPersistentScript(params = {}, internalOptions = {}) {
        const source = internalOptions.source ?? params.code ?? ui.scriptCode.value;
        if (typeof source !== "string" || source.length > 262144) {
            return responder.fail(ErrorCode.SCRIPT_SOURCE_INVALID, "Persistent script source must be a string up to 262144 characters");
        }
        try {
            assertSafeScriptSource(source);
        } catch (error) {
            return responder.fail(error.mcpCode, error.message, error.mcpDetails);
        }
        const code = source;
        const explicitName = Object.hasOwn(params, "name")
            ? String(params.name ?? "").trim()
            : "";
        if (explicitName && !normalizeScriptIdentity(explicitName)) {
            return responder.fail(
                ErrorCode.INVALID_ARGUMENT,
                "name must match ^[A-Za-z][A-Za-z0-9._-]{0,63}$"
            );
        }
        const asyncMode = !!(params.asyncMode ?? ui.scriptAsyncMode.checked);
        const waitForRegistration = params.waitForRegistration !== false;
        const startupTimeoutMs = Number(params.startupTimeoutMs ?? 3000);
        if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0 || startupTimeoutMs > 600000) {
            return responder.fail(
                ErrorCode.INVALID_ARGUMENT,
                "startupTimeoutMs must be between 1 and 600000"
            );
        }
        const existingId = Number(internalOptions.existingId);
        const existing = Number.isSafeInteger(existingId) && existingId > 0
            ? state.scripts.get(existingId)
            : explicitName
                ? [...state.scripts.values()].find((script) => script.name === explicitName)
                : null;
        const duplicate = internalOptions.deduplicateByCode === false
            ? null
            : [...state.scripts.values()].find((script) => (
                script !== existing
                && script.code === code
                && script.asyncMode === asyncMode
                && script.running
            ));
        if (duplicate) {
            return waitForRegistration && !duplicate.registrationComplete
                ? waitForScriptRegistration(duplicate)
                : scriptSummary(duplicate, true);
        }
        if (existing?.running) await stopPersistentScript({ id: existing.id, resumeScriptOnlyTrap: true });
        const sourceBytes = new TextEncoder().encode(source).byteLength;
        const retainedBytes = pruneStoppedScripts(sourceBytes);
        if (!existing && (state.scripts.size >= ResourceLimits.totalScriptRecords
            || retainedBytes + sourceBytes > ResourceLimits.totalScriptHistoryBytes)) {
            return responder.fail(ErrorCode.BUSY, "Persistent script history limit reached", {
                records: state.scripts.size,
                maximumRecords: ResourceLimits.totalScriptRecords,
                maximumBytes: ResourceLimits.totalScriptHistoryBytes
            });
        }
        const runningScripts = [...state.scripts.values()].filter((script) => script.running).length;
        if (runningScripts >= ResourceLimits.persistentScripts) {
            return responder.fail(ErrorCode.BUSY, "Persistent script limit reached", {
                running: runningScripts,
                maximum: ResourceLimits.persistentScripts
            });
        }
        const id = existing?.id || state.nextScriptId++;
        const name = explicitName || `script-${id}`;
        const script = {
            id,
            name,
            nameProvisional: !explicitName,
            identitySource: explicitName ? "api-name" : "generated",
            identityConflict: false,
            identityCollision: null,
            declaredCommentId: null,
            declaredReturnFallbackId: null,
            code,
            asyncMode,
            queue: Promise.resolve(),
            worker: null,
            workerHost: null,
            running: true,
            started: false,
            topLevelRunning: false,
            registrationComplete: false,
            output: [],
            outputStartLine: existing?.nextOutputLine ?? 1,
            nextOutputLine: existing?.nextOutputLine ?? 1,
            triggers: [],
            ownedBreakpointIds: new Set(),
            eventQueue: [],
            eventBusy: false,
            pendingEventAcks: new Map(),
            pendingEventReleases: new Map(),
            registrationWaiters: new Set(),
            droppedEvents: 0,
            scriptInstanceId: `${Date.now().toString(36)}-${scriptInstanceSerial++}`,
            pscriptMcps: new Map(),
            pendingPScriptMcpCalls: new Map(),
            expiredPScriptMcpCalls: new Map(),
            inFlightPScriptMcpCalls: new Map(),
            nextPScriptMcpCallId: 1,
            pscriptMcpPublished: false,
            createdAt: Date.now()
        };
        let workerHost;
        try {
            workerHost = createEmbeddedWorker(persistentScriptSupervisorSource);
        } catch (error) {
            return responder.fail(ErrorCode.WORKER_START_FAILED, "Persistent script Worker could not be started", {
                errorName: String(error?.name || "Error"),
                message: String(error?.message || error)
            });
        }
        const { worker } = workerHost;
        script.worker = worker;
        script.workerHost = workerHost;
        state.scripts.set(script.id, script);
        state.activeScriptId = script.id;
        let resultSettled = false;
        let ready = false;
        let compiled = false;
        const seenRequestIds = new Set();
        let resolveStartup;
        const startup = new Promise((resolve) => {
            resolveStartup = resolve;
        });
        const settleResult = (result) => {
            if (resultSettled) return false;
            resultSettled = true;
            resolveStartup(result);
            return true;
        };
        const handleWorkerFailure = async (result, message) => {
            const identifiedResult = result?.ok === false ? {
                ...result,
                error: {
                    ...result.error,
                    details: {
                        ...(result.error?.details || {}),
                        scriptId: script.id,
                        scriptName: script.name
                    }
                }
            } : result;
            settleScriptRegistrationWaiters(script, identifiedResult);
            await failPersistentScript(script, message);
            settleResult(identifiedResult);
        };
        const startupTimer = setTimeout(() => {
            const result = responder.fail(
                ErrorCode.WORKER_START_FAILED,
                "Persistent script Worker did not complete its startup handshake",
                { timeoutMs: startupTimeoutMs }
            );
            void handleWorkerFailure(result, "startup handshake timed out");
        }, startupTimeoutMs);
        worker.onmessage = async (event) => {
            const msg = event.data || {};
            if (state.scripts.get(script.id) !== script) return;
            try {
                if (msg.type === "ready" && !ready
                    && msg.hardened === true && msg.layer === "supervisor") {
                    ready = true;
                    worker.postMessage({
                        type: "start",
                        code,
                        asyncMode,
                        scriptInstanceId: script.scriptInstanceId,
                        parserSource: parserWorkerSource,
                        sandboxSource: persistentScriptSandboxSource,
                        dependency: acornDependency,
                        shortcuts: Object.entries(window.DesmumeShortcuts || {}).map(([shortcut, definition]) => [
                            shortcut,
                            definition.command,
                            definition.params,
                            definition.defaults
                        ])
                    });
                } else if (msg.type === "sourceIdentity") {
                    if (!ready || compiled) {
                        throw new Error("Persistent script source identity arrived outside parser phase");
                    }
                    if (msg.scriptId !== null && msg.scriptId !== undefined) {
                        applyScriptIdentity(script, msg.scriptId, "source-comment");
                    }
                } else if (msg.type === "call") {
                    if (!ready) throw new Error("Persistent script sent RPC before ready");
                    if (seenRequestIds.size >= ResourceLimits.pendingWorkerRpc) {
                        throw Object.assign(new Error("Persistent script exceeded its pending RPC limit"), {
                            mcpCode: ErrorCode.BUSY
                        });
                    }
                    const request = validateWorkerRpc(msg, seenRequestIds);
                    try {
                        const result = await queuePersistentScriptOperation(
                            script,
                            request.command,
                            request.params,
                            msg
                        );
                        worker.postMessage({ replyId: msg.id, result });
                    } catch (error) {
                        worker.postMessage({ replyId: msg.id, error: workerRpcError(error) });
                    } finally {
                        seenRequestIds.delete(msg.id);
                    }
                } else if (msg.type === "register") {
                    if (!ready || seenRequestIds.size >= ResourceLimits.pendingWorkerRpc
                        || typeof msg.id !== "string" || seenRequestIds.has(msg.id) || !msg.trigger || typeof msg.trigger !== "object") {
                        await handleWorkerFailure(
                            responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Persistent script sent a malformed trigger request"),
                            "malformed Worker trigger request"
                        );
                        return;
                    }
                    seenRequestIds.add(msg.id);
                    try {
                        const result = await queuePersistentScriptOperation(script, "register", msg.trigger);
                        worker.postMessage({ replyId: msg.id, result });
                    } catch (error) {
                        worker.postMessage({ replyId: msg.id, error: workerRpcError(error) });
                    } finally {
                        seenRequestIds.delete(msg.id);
                    }
                } else if (msg.type === "eventRelease") {
                    if (!ready || !compiled || !script.started || !script.running
                        || msg.mode !== "resume") {
                        throw new Error("Persistent script sent an invalid event release");
                    }
                    const callbackToken = String(msg.callbackToken || "");
                    if (!callbackToken || script.pendingEventReleases.has(callbackToken)) {
                        throw new Error("Persistent script reused or omitted an event release token");
                    }
                    const completion = requestPersistentScriptResume(msg.eventId, {
                        scriptId: script.id,
                        callbackId: msg.callbackId,
                        callbackToken
                    });
                    if (!completion) {
                        throw new Error("Persistent script event release did not match the active callback");
                    }
                    completion.catch(() => undefined);
                    script.pendingEventReleases.set(callbackToken, completion);
                } else if (msg.type === "registrationComplete") {
                    if (!ready || !compiled || !script.started || !script.running) {
                        throw new Error("Persistent script completed registration before startup");
                    }
                    completeScriptRegistration(script, msg);
                    if (waitForRegistration) settleResult(scriptSummary(script, false));
                } else if (msg.type === "pscriptMcpResult") {
                    if (!ready || !script.running) {
                        throw new Error("Persistent script returned an MCP result before startup");
                    }
                    finishPScriptMcpCall(script, msg);
                } else if (msg.type === "eventDone" && Number.isFinite(Number(msg.eventId))) {
                    const accepted = await finishPersistentScriptEvent(msg.eventId, {
                        scriptId: script.id,
                        callbackId: msg.callbackId,
                        callbackToken: msg.callbackToken
                    });
                    if (!accepted) {
                        await handleWorkerFailure(
                            responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Persistent script sent an invalid event completion"),
                            "invalid Worker event completion"
                        );
                    }
                } else if (msg.type === "print" && Array.isArray(msg.values)) {
                    scriptConsoleLine(script, msg.values);
                } else if (msg.type === "eventAck") {
                    script.eventBusy = false;
                    const queueEventId = Number(msg.queueEventId) || 0;
                    if (queueEventId) {
                        const pending = script.pendingEventAcks.get(queueEventId);
                        if (!pending) {
                            throw new Error("Persistent script acknowledged an unknown queued event");
                        }
                        script.pendingEventAcks.delete(queueEventId);
                        pending.resolve({
                            scriptId: script.id,
                            scriptName: script.name,
                            queueEventId,
                            event: pending.type
                        });
                    }
                    pumpScriptEvents(script);
                } else if (msg.type === "compiled" && ready && !compiled) {
                    compiled = true;
                } else if (msg.type === "started") {
                    if (!ready || !compiled) {
                        throw new Error("Persistent script started before compile acknowledgement");
                    }
                    script.started = true;
                    script.topLevelRunning = true;
                    clearTimeout(startupTimer);
                    if (!waitForRegistration) settleResult(scriptSummary(script, false));
                } else if (msg.type === "failed") {
                    const result = scriptFailureResult(msg, code);
                    await handleWorkerFailure(result, result.error.message);
                } else {
                    await handleWorkerFailure(
                        responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Persistent script sent an unknown message"),
                        `unknown Worker message: ${String(msg.type)}`
                    );
                }
            } catch (error) {
                await handleWorkerFailure(
                    responder.fail(error?.mcpCode || ErrorCode.WORKER_PROTOCOL_ERROR, String(error?.message || error)),
                    String(error?.message || error)
                );
            }
        };
        worker.onerror = (event) => {
            const message = String(event.message || event.error?.message || "Persistent script Worker crashed");
            void handleWorkerFailure(
                responder.fail(ready ? ErrorCode.WORKER_CRASHED : ErrorCode.WORKER_START_FAILED, ready ? "Persistent script Worker crashed" : "Persistent script Worker failed during startup", { message }),
                message
            );
        };
        worker.onmessageerror = () => {
            void handleWorkerFailure(
                responder.fail(ErrorCode.WORKER_PROTOCOL_ERROR, "Persistent script Worker returned an unreadable message"),
                "persistent script Worker protocol error"
            );
        };
        renderScripts();
        return startup;
    }
    
    async function stopPersistentScript(params = {}) {
        const id = Number(params.id ?? state.activeScriptId);
        const script = state.scripts.get(id);
        if (!script) throw new Error(`script not found: ${id}`);
        script.running = false;
        script.topLevelRunning = false;
        script.stoppedAt = Date.now();
        rejectPendingPScriptMcpCalls(script);
        rejectPendingScriptEventAcks(script);
        if (!script.registrationComplete) {
            settleScriptRegistrationWaiters(script, responder.fail(
                ErrorCode.CANCELLED,
                "Persistent script stopped before registration completed",
                { scriptId: script.id, scriptName: script.name }
            ));
        }
        script.eventQueue.length = 0;
        script.eventBusy = false;
        const resumeScriptOnlyTrap = params.resumeScriptOnlyTrap === true;
        await settlePersistentScriptCallbacks(script.id, { resumeScriptOnlyTrap });
        script.pendingEventReleases.clear();
        let queueTimedOut = false;
        await Promise.race([
            script.queue,
            new Promise((resolve) => setTimeout(() => {
                queueTimedOut = true;
                resolve();
            }, 10000))
        ]);
        try {
            await unregisterScriptTriggers(script);
        } finally {
            script.workerHost?.dispose();
            renderScripts();
            renderScriptConsole(script);
        }
        if (queueTimedOut) {
            throw codedError(
                ErrorCode.TIMEOUT,
                "Persistent script queue did not settle before stop",
                { scriptId: script.id, scriptName: script.name, timeoutMs: 10000 }
            );
        }
        return scriptSummary(script, false);
    }
    
    async function failPersistentScript(script, error) {
        if (!script.running) return;
        scriptConsoleLine(script, ["stopped: " + String(error?.message || error)]);
        try {
            await stopPersistentScript({ id: script.id });
        } catch (stopError) {
            script.workerHost?.dispose();
            script.running = false;
            scriptConsoleLine(script, ["trigger cleanup failed: " + String(stopError?.message || stopError)]);
            renderScripts();
            renderScriptConsole(script);
        }
    }
    
    function scriptSummary(script, duplicate = false) {
        const mcpNames = [...script.pscriptMcps.keys()].sort();
        return {
            id: script.id,
            name: script.name,
            nameProvisional: script.nameProvisional,
            identitySource: script.identitySource,
            ...(script.declaredCommentId ? { declaredCommentId: script.declaredCommentId } : {}),
            ...(script.declaredReturnFallbackId
                ? { declaredReturnFallbackId: script.declaredReturnFallbackId }
                : {}),
            ...(script.identityConflict ? { identityConflict: true } : {}),
            ...(script.identityCollision ? { identityCollision: script.identityCollision } : {}),
            running: script.running,
            started: script.started,
            topLevelRunning: script.topLevelRunning,
            registrationComplete: script.registrationComplete,
            asyncMode: script.asyncMode,
            triggers: script.triggers.map(({ id, type, address, cpu }) => ({
                id,
                type,
                address: hex(address),
                cpu
            })),
            mcpCount: script.registrationComplete ? script.pscriptMcps.size : null,
            mcpNames: mcpNames.slice(0, 16),
            mcpNamesTruncated: mcpNames.length > 16,
            mcpPublished: script.pscriptMcpPublished,
            consoleFirstLine: script.outputStartLine,
            consoleLastLine: script.nextOutputLine - 1,
            consoleLineCount: script.output.length,
            duplicate
        };
    }

    return {
        scriptConsoleLine,
        renderScriptConsole,
        renderScripts,
        selectScript,
        dispatchScriptEvent,
        dispatchScriptEventAndWait,
        startPersistentScript,
        stopPersistentScript,
        scriptSummary,
        listPScriptMcps,
        callPScriptMcp,
        finishPScriptMcpCall
    };
}
