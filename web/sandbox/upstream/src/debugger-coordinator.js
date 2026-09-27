import { ResourceLimits } from "./resource-limits.js";
import { ErrorCode } from "./error-codes.js";
import { codedError } from "./validation.js";

export function createDebuggerCoordinator({
    state,
    native,
    breakpointOwners,
    breakpointService,
    pauseEventService = null,
    getQueueBreakpointRefresh,
    getWakeEmulationLoop = () => null,
    log,
    hex,
    updateStatus,
    getStopPersistentScript = () => null,
    reconcileNativeBreakpoints = () => {},
    scriptCallbackTimeoutMs = 10000
}) {
    function breakpointKindName(kind) {
        return [
            "exec",
            "read",
            "write",
            "dataAbort",
            "prefetchAbort",
            "undefinedInstruction"
        ][Number(kind)] || "unknown";
    }

    function pauseKindForBreakpointType(type) {
        return type === "exec"
            ? "executeBreakpoint"
            : type === "read" || type === "write"
                ? "memoryBreakpoint"
                : "specialBreakpoint";
    }

    function getNativeStatus() {
        return state.ready ? native.getStatus() : null;
    }

    function currentInstructionAddress(cpu = state.selectedCpu) {
        const status = getNativeStatus();
        const node = status && status[String(cpu).toLowerCase() === "arm7" ? "arm7" : "arm9"];
        return node ? Number(node.pc) >>> 0 : null;
    }

    function currentExecBreakpoint(cpu = state.selectedCpu, address = currentInstructionAddress(cpu)) {
        if (!Number.isFinite(address)) return null;
        return breakpointOwners.getSite({
            type: "exec",
            cpu: String(cpu),
            address: Number(address) >>> 0
        }) || null;
    }

    async function withCurrentExecBreakpointSuspended(cpu, callback) {
        const address = currentInstructionAddress(cpu);
        const breakpoint = currentExecBreakpoint(cpu, address);
        if (breakpoint) native.setBreakpoint(cpu, "exec", address, false);
        try {
            return await callback(address);
        } finally {
            if (breakpoint && breakpointOwners.getOwners(breakpoint).length) {
                native.setBreakpoint(cpu, "exec", address, true);
            }
        }
    }

    function matchingScriptTriggers(type, breakpoint) {
        return state.scriptTriggers.filter((trigger) => (
            trigger.type === type
            && (
                trigger.type === "dataAbort"
                || trigger.type === "prefetchAbort"
                || trigger.type === "undefinedInstruction"
                || (
                    trigger.cpu === String(breakpoint.cpu)
                    && trigger.address === (Number(breakpoint.address) >>> 0)
                )
            )
        ));
    }

    async function finishCompletedPersistentScriptEvent(eventId, pending) {
        state.pendingScriptEvents.delete(Number(eventId));
        clearTimeout(pending.timeoutId);
        const currentClassification = breakpointOwners.classifySite(pending.ownerSite);
        const status = getNativeStatus();
        const currentBreak = status?.lastBreak;
        const sameBreak = state.nativeBreakSerial === pending.nativeBreakSerial
            && currentBreak?.hit === true
            && breakpointKindName(currentBreak.kind) === pending.type
            && String(currentBreak.cpu) === pending.cpu
            && (Number(currentBreak.address) >>> 0) === pending.address
            && (Number(currentBreak.pc) >>> 0) === pending.eventPc;
        if (pending.failed || pending.pauseSerial !== state.explicitPauseSerial
            || pending.romGeneration !== state.romGeneration
            || pending.fileTransactionSerial !== state.fileTransactionSerial
            || state.fileTransactionActive || state.loadingFile || !sameBreak
            || !currentClassification.scriptOnly || state.breakpointsInSync !== true
            || !native.hasLoadedRom()) return null;

        // Exec hooks stop before the instruction. MMU read/write hooks have already
        // completed the access, so stepping those would duplicate the side effect.
        if (pending.type === "exec" && currentInstructionAddress(pending.cpu) === pending.address) {
            state.lastBreakKey = "";
            await withCurrentExecBreakpointSuspended(pending.cpu, () => {
                native.clearBreakStatus();
                return native.step(pending.cpu, 1);
            });
            const statusAfterStep = getNativeStatus();
            if (statusAfterStep?.lastBreak?.hit) {
                syncNativeBreakStatus(statusAfterStep);
                updateStatus();
                return null;
            }
        }
        state.breakLabel = "";
        state.breakRefreshKey = "";
        state.lastBreakKey = "";
        native.clearBreakStatus();
        state.paused = false;
        state.running = true;
        native.pause(false);
        const nativePaused = typeof native.isPaused === "function" ? native.isPaused() : false;
        if (nativePaused) {
            state.paused = true;
            state.running = false;
            throw codedError(
                ErrorCode.SCRIPT_RESUME_NOT_COMPLETED,
                "Persistent script resume did not clear the native paused state",
                { eventId: Number(eventId), nativePaused: true }
            );
        }
        const wakeEmulationLoop = getWakeEmulationLoop();
        if (typeof wakeEmulationLoop === "function") wakeEmulationLoop();
        updateStatus();
        return {
            ok: true,
            resumed: true,
            eventId: Number(eventId),
            steppedPast: pending.type === "exec",
            nativePaused: false,
            running: true,
            paused: false
        };
    }

    function rejectReleaseWaiters(pending, error) {
        for (const waiter of pending.releaseWaiters || []) waiter.reject(error);
        pending.releaseWaiters = [];
    }

    function resolveReleaseWaiters(pending, result) {
        for (const waiter of pending.releaseWaiters || []) waiter.resolve(result);
        pending.releaseWaiters = [];
    }

    async function completePersistentScriptEvent(eventId, pending) {
        try {
            const result = await finishCompletedPersistentScriptEvent(eventId, pending);
            if (pending.releaseWaiters?.length) {
                if (result?.resumed === true) resolveReleaseWaiters(pending, result);
                else rejectReleaseWaiters(pending, codedError(
                    ErrorCode.SCRIPT_RESUME_NOT_COMPLETED,
                    "Persistent script resume could not complete because the event no longer qualified for automatic resume",
                    { eventId: Number(eventId), resumed: false }
                ));
            }
        } catch (error) {
            rejectReleaseWaiters(pending, error);
            await failPersistentScriptEvent(eventId, pending, "callback finalization failure", error);
        }
    }

    async function failPersistentScriptEvent(eventId, pending, reason, error = null, code = "SCRIPT_EVENT_FINALIZATION_FAILED") {
        if (state.pendingScriptEvents.get(Number(eventId)) === pending) {
            state.pendingScriptEvents.delete(Number(eventId));
        }
        clearTimeout(pending.timeoutId);
        pending.failed = true;
        rejectReleaseWaiters(pending, codedError(
            ErrorCode.SCRIPT_RESUME_NOT_COMPLETED,
            `Persistent script resume was cancelled: ${reason}`,
            { eventId: Number(eventId), reason }
        ));
        state.paused = true;
        state.running = false;
        try { native.pause(true); } catch {}
        if (pending.ownerClassification?.scriptOnly) {
            pauseEventService?.publish({
                pauseKind: pauseKindForBreakpointType(pending.type),
                breakType: pending.type,
                cpu: pending.cpu,
                address: pending.address,
                pc: pending.eventPc,
                frame: Number(state.frame || 0),
                scriptEventFailure: true,
                reason
            });
        }
        try { await reconcileNativeBreakpoints(); } catch (reconcileError) {
            log(`breakpoint reconciliation failed after ${reason}: ${String(reconcileError?.message || reconcileError)}`);
        }
        const stopPersistentScript = getStopPersistentScript();
        if (typeof stopPersistentScript === "function") {
            await Promise.allSettled(pending.scriptIds.map((id) => stopPersistentScript({ id })));
        }
        state.lastScriptError = {
            code,
            eventId: Number(eventId),
            reason,
            message: String(error?.message || error || reason).slice(0, 500)
        };
        log(`persistent script event ${eventId} stopped safely: ${reason}`);
        try { updateStatus(); } catch {}
    }

    async function finishPersistentScriptEvent(eventId, identity = {}) {
        const pending = state.pendingScriptEvents.get(Number(eventId));
        const token = String(identity.callbackToken || "");
        const callback = pending?.pendingCallbacks.get(token);
        if (!pending || !callback) return false;
        if (Number(identity.scriptId) !== callback.scriptId
            || Number(identity.callbackId) !== callback.callbackId) {
            return false;
        }
        pending.pendingCallbacks.delete(token);
        if (pending.pendingCallbacks.size) return true;
        await completePersistentScriptEvent(eventId, pending);
        return true;
    }

    function requestPersistentScriptResume(eventId, identity = {}) {
        const pending = state.pendingScriptEvents.get(Number(eventId));
        const token = String(identity.callbackToken || "");
        const callback = pending?.pendingCallbacks.get(token);
        if (!pending || !callback
            || Number(identity.scriptId) !== callback.scriptId
            || Number(identity.callbackId) !== callback.callbackId) {
            return null;
        }
        if (callback.released) return null;
        callback.released = true;
        pending.pendingCallbacks.delete(token);
        const completion = new Promise((resolve, reject) => {
            pending.releaseWaiters.push({
                resolve,
                reject,
                token,
                scriptId: callback.scriptId,
                callbackId: callback.callbackId
            });
        });
        if (!pending.pendingCallbacks.size) {
            void completePersistentScriptEvent(eventId, pending);
        }
        return completion;
    }

    async function settlePersistentScriptCallbacks(scriptId, { resumeScriptOnlyTrap = false } = {}) {
        const completions = [];
        for (const [eventId, pending] of state.pendingScriptEvents) {
            for (const [token, callback] of pending.pendingCallbacks) {
                if (callback.scriptId === Number(scriptId)) {
                    if (!resumeScriptOnlyTrap) pending.failed = true;
                    pending.pendingCallbacks.delete(token);
                }
            }
            const retainedReleaseWaiters = [];
            for (const waiter of pending.releaseWaiters || []) {
                if (waiter.scriptId === Number(scriptId)) {
                    if (!resumeScriptOnlyTrap) pending.failed = true;
                    waiter.reject(codedError(
                        ErrorCode.SCRIPT_RESUME_NOT_COMPLETED,
                        "Persistent script stopped before callback resume completed",
                        { eventId: Number(eventId), scriptId: Number(scriptId) }
                    ));
                } else {
                    retainedReleaseWaiters.push(waiter);
                }
            }
            pending.releaseWaiters = retainedReleaseWaiters;
            if (!pending.pendingCallbacks.size) {
                completions.push(completePersistentScriptEvent(eventId, pending));
            }
        }
        await Promise.all(completions);
    }

    async function cancelAllPersistentScriptEvents(reason = "file transaction started") {
        await Promise.allSettled([...state.pendingScriptEvents.entries()].map(([eventId, pending]) => (
            failPersistentScriptEvent(eventId, pending, reason)
        )));
    }

    function dispatchScriptTriggers(triggers, breakpoint, type, classification) {
        if (!triggers.length) return;
        if (state.pendingScriptEvents.size >= ResourceLimits.pendingScriptEvents) {
            const eventId = state.nextScriptEventId++;
            const pending = {
                pendingCallbacks: new Map(),
                scriptIds: [...new Set(triggers.map((trigger) => Number(trigger.scriptId)))],
                pauseSerial: state.explicitPauseSerial,
                romGeneration: state.romGeneration,
                fileTransactionSerial: state.fileTransactionSerial,
                nativeBreakSerial: state.nativeBreakSerial,
                ownerSite: classification.ownerSite,
                cpu: String(breakpoint.cpu),
                type,
                address: Number(breakpoint.address) >>> 0,
                eventPc: Number(breakpoint.pc) >>> 0,
                failed: true,
                releaseWaiters: [],
                timeoutId: 0
            };
            state.pendingScriptEvents.set(eventId, pending);
            void failPersistentScriptEvent(
                eventId,
                pending,
                `pending script event limit reached (${ResourceLimits.pendingScriptEvents})`,
                null,
                "BUSY"
            ).catch((error) => log(`overflow recovery failed: ${String(error?.message || error)}`));
            return;
        }
        const eventId = state.nextScriptEventId++;
        const pendingCallbacks = new Map();
        for (const trigger of triggers) {
            const callbackToken = `${eventId}:${state.nextScriptCallbackToken++}`;
            pendingCallbacks.set(callbackToken, {
                scriptId: Number(trigger.scriptId),
                callbackId: Number(trigger.callbackId),
                released: false
            });
            trigger.callbackToken = callbackToken;
        }
        const pending = {
            pendingCallbacks,
            scriptIds: [...new Set(triggers.map((trigger) => Number(trigger.scriptId)))],
            pauseSerial: state.explicitPauseSerial,
            romGeneration: state.romGeneration,
            fileTransactionSerial: state.fileTransactionSerial,
            nativeBreakSerial: state.nativeBreakSerial,
            ownerSite: classification.ownerSite,
            cpu: String(breakpoint.cpu),
            type,
            address: Number(breakpoint.address) >>> 0,
            eventPc: Number(breakpoint.pc) >>> 0,
            ownerClassification: classification,
            failed: false,
            releaseWaiters: [],
            timeoutId: 0
        };
        state.pendingScriptEvents.set(eventId, pending);
        pending.timeoutId = setTimeout(() => {
            if (state.pendingScriptEvents.get(eventId) !== pending) return;
            void failPersistentScriptEvent(eventId, pending, "callback timeout")
                .catch((error) => log(`persistent script timeout recovery failed: ${String(error?.message || error)}`));
        }, scriptCallbackTimeoutMs);
        for (const trigger of triggers) {
            if (pending.failed) break;
            const script = state.scripts.get(trigger.scriptId);
            if (script?.running) {
                try {
                    script.worker.postMessage({
                        type: "event",
                        eventId,
                        scriptId: trigger.scriptId,
                        callbackId: trigger.callbackId,
                        triggerId: trigger.id,
                        callbackToken: trigger.callbackToken,
                        event: type,
                        payload: {
                            ...breakpoint,
                            address: hex(breakpoint.address),
                            pc: hex(breakpoint.pc),
                            value: hex(breakpoint.value)
                        }
                    });
                } catch (error) {
                    pending.failed = true;
                    void failPersistentScriptEvent(eventId, pending, "event postMessage failure", error)
                        .catch((failure) => log(`persistent script event recovery failed: ${String(failure?.message || failure)}`));
                }
            } else {
                pending.failed = true;
                void failPersistentScriptEvent(eventId, pending, "script stopped before event delivery")
                    .catch((failure) => log(`persistent script event recovery failed: ${String(failure?.message || failure)}`));
            }
        }
    }

    function syncNativeBreakStatus(status = null) {
        if (!state.ready) return null;
        const nativeStatus = status || native.getStatus();
        if (Number.isFinite(Number(nativeStatus.frame))) state.frame = Number(nativeStatus.frame);
        const breakpoint = nativeStatus.lastBreak;
        if (!breakpoint?.hit) return nativeStatus;

        const type = breakpointKindName(breakpoint.kind);
        const triggers = matchingScriptTriggers(type, breakpoint);
        const site = {
            type,
            cpu: String(breakpoint.cpu),
            address: Number(breakpoint.address) >>> 0
        };
        const ownerSite = ["dataAbort", "prefetchAbort", "undefinedInstruction"].includes(type)
            ? { cpu: "special", type, address: 0 }
            : site;
        const classification = { ...breakpointOwners.classifySite(ownerSite), ownerSite };
        const internalScriptTrap = classification.scriptOnly && triggers.length > 0;
        state.paused = true;
        state.running = false;
        native.pause(true);
        state.breakLabel = internalScriptTrap ? "" : `break ${type}`;
        const key = `${breakpoint.cpu}:${breakpoint.kind}:${breakpoint.address}:${breakpoint.pc}:${breakpoint.value}`;
        if (!internalScriptTrap && state.breakRefreshKey !== key) {
            state.breakRefreshKey = key;
            getQueueBreakpointRefresh()(String(breakpoint.cpu || state.selectedCpu));
        }
        if (state.lastBreakKey === key) return nativeStatus;

        state.lastBreakKey = key;
        state.nativeBreakSerial = Number(state.nativeBreakSerial || 0) + 1;
        state.currentBreakIdentity = {
            serial: state.nativeBreakSerial,
            cpu: String(breakpoint.cpu),
            type,
            address: Number(breakpoint.address) >>> 0,
            pc: Number(breakpoint.pc) >>> 0
        };
        if (!internalScriptTrap) {
            log(`break ${type} ${breakpoint.cpu} at ${hex(breakpoint.address)} pc ${hex(breakpoint.pc)}`);
        }
        breakpointService.publish({
            ...breakpoint,
            ...site,
            ownerSite,
            pc: Number(breakpoint.pc) >>> 0,
            value: Number(breakpoint.value) >>> 0
        });
        if (!internalScriptTrap) {
            pauseEventService?.publish({
                pauseKind: pauseKindForBreakpointType(type),
                breakType: type,
                cpu: String(breakpoint.cpu),
                address: Number(breakpoint.address) >>> 0,
                pc: Number(breakpoint.pc) >>> 0,
                frame: Number(state.frame || 0)
            });
        }
        dispatchScriptTriggers(triggers, breakpoint, type, classification);
        return nativeStatus;
    }

    function getRegisters(cpu = state.selectedCpu) {
        native.ensureRomLoaded("Registers are unavailable because no ROM is loaded");
        const names = [
            "r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11",
            "r12", "sp", "lr", "pc", "cpsr", "spsr"
        ];
        const values = {};
        for (let index = 0; index < names.length; index++) {
            values[names[index]] = native.getRegister(cpu, index);
        }
        values.r13 = values.sp;
        values.r14 = values.lr;
        values.r15 = values.pc;
        return values;
    }

    return Object.freeze({
        breakpointKindName,
        currentExecBreakpoint,
        currentInstructionAddress,
        finishPersistentScriptEvent,
        getNativeStatus,
        getRegisters,
        requestPersistentScriptResume,
        cancelAllPersistentScriptEvents,
        settlePersistentScriptCallbacks,
        syncNativeBreakStatus,
        withCurrentExecBreakpointSuspended
    });
}
