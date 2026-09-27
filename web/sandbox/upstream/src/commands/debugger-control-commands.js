import { getInternalMetadata } from "../internal-command-metadata.js";
import { ErrorCode } from "../error-codes.js";
import { codedError, nonNegativeNumber, positiveInteger } from "../validation.js";

export function createDebuggerControlCommands(context) {
    const {
        breakpointOwners,
        copyText,
        ensureReady,
        ensureRomLoaded,
        getPc,
        hex,
        instructionWidthForMode,
        native,
        parseAddress,
        publicCallStackData,
        publicOtherCoroutines,
        readCallStackData,
        renderBreakpoints,
        renderCallStack,
        resume,
        runDebuggerInstruction,
        runTraceStepper,
        runUntilNextBranchOrReturn,
        runUntilTrueNextBranch,
        state,
        status,
        ui,
        updateStatus
    } = context;

    function assertBreakpointOriginAllowed(origin) {
        if (state.breakpointPolicy !== "script-only" || origin === "script") return;
        const error = new Error(`breakpoint origin is forbidden by script-only policy: ${origin}`);
        error.mcpCode = ErrorCode.BREAKPOINT_POLICY_VIOLATION;
        error.mcpDetails = { policy: state.breakpointPolicy, origin };
        throw error;
    }

    const debuggerCommands = {
        async setBreakpoint(params) {
            ensureRomLoaded("breakpoints require a loaded ROM");
            if (params.id && params.enabled === false) {
                return debuggerCommands.removeBreakpoint({ id: params.id });
            }
            const metadata = getInternalMetadata(params);
            const origin = String(metadata.origin || "user");
            assertBreakpointOriginAllowed(origin);
            const explicitId = params.id === undefined ? null : Number(params.id);
            if (explicitId !== null && (
                !Number.isSafeInteger(explicitId)
                || explicitId <= 0
                || explicitId >= Number.MAX_SAFE_INTEGER
            )) {
                const error = new Error("breakpoint id must be a positive safe integer");
                error.mcpCode = "INVALID_ARGUMENT";
                throw error;
            }
            const id = explicitId ?? state.nextBreakpointId++;
            if (explicitId !== null) {
                state.nextBreakpointId = Math.max(state.nextBreakpointId, explicitId + 1);
            }
            const breakpoint = {
                id,
                cpu: String(params.cpu ?? state.selectedCpu),
                type: String(params.type ?? "exec"),
                address: parseAddress(params.address, 0, params.cpu),
                enabled: params.enabled !== false,
                origin
            };
            if (!breakpoint.enabled) {
                const existing = state.breakpoints.find((item) => (
                    item.cpu === breakpoint.cpu
                    && item.type === breakpoint.type
                    && item.address === breakpoint.address
                ));
                if (existing) return debuggerCommands.removeBreakpoint({ id: existing.id });
                return { ok: true, breakpoints: state.breakpoints };
            }
            breakpointOwners.addOwner(breakpoint, {
                id: breakpoint.id,
                origin,
                scriptId: metadata.scriptId,
                triggerId: metadata.triggerId,
                operationId: metadata.operationId
            });
            if (origin === "user") state.breakpoints.push(breakpoint);
            renderBreakpoints();
            return { id: breakpoint.id, breakpoints: state.breakpoints };
        },

        async setSpecialBreakpoint(params = {}) {
            ensureRomLoaded("special breakpoints require a loaded ROM");
            const kindMap = new Map([
                ["dataAbort", "dataAbort"], ["3", "dataAbort"],
                ["prefetchAbort", "prefetchAbort"], ["4", "prefetchAbort"],
                ["undefinedInstruction", "undefinedInstruction"], ["undefined", "undefinedInstruction"],
                ["5", "undefinedInstruction"]
            ]);
            const kind = kindMap.get(String(params.kind));
            if (!kind) {
                const error = new Error("unknown special breakpoint kind");
                error.mcpCode = "INVALID_ARGUMENT";
                throw error;
            }
            const metadata = getInternalMetadata(params);
            const origin = String(metadata.origin || "user");
            assertBreakpointOriginAllowed(origin);
            const site = { cpu: "special", type: kind, address: 0 };
            const matchingOwner = breakpointOwners.getOwners(site).find((owner) => (
                owner.origin === origin
                && (metadata.scriptId === undefined || owner.scriptId === metadata.scriptId)
                && (metadata.triggerId === undefined || owner.triggerId === metadata.triggerId)
                && (metadata.operationId === undefined || owner.operationId === metadata.operationId)
            ));
            let id = matchingOwner?.id;
            if (params.enabled !== false && !matchingOwner) {
                id = state.nextBreakpointId++;
                breakpointOwners.addOwner(site, {
                    id,
                    origin,
                    scriptId: metadata.scriptId,
                    triggerId: metadata.triggerId,
                    operationId: metadata.operationId
                });
            } else if (params.enabled === false && matchingOwner) {
                breakpointOwners.removeOwner(matchingOwner.id);
            }
            const enabled = breakpointOwners.getOwners(site).some((owner) => owner.origin === "user");
            if (kind === "dataAbort") ui.bpDataAbortToggle.checked = enabled;
            if (kind === "prefetchAbort") ui.bpPrefetchAbortToggle.checked = enabled;
            if (kind === "undefinedInstruction") ui.bpUndefinedToggle.checked = enabled;
            return { id, kind, enabled: params.enabled !== false, userEnabled: enabled };
        },

        async setBreakpointPolicy(params = {}) {
            ensureReady();
            const mode = String(params.mode || "");
            if (!new Set(["allow", "script-only"]).has(mode)) {
                const error = new Error("breakpoint policy mode must be allow or script-only");
                error.mcpCode = ErrorCode.INVALID_ARGUMENT;
                throw error;
            }
            if (mode === "script-only") {
                const conflicts = breakpointOwners.list().flatMap((site) => (
                    breakpointOwners.getOwners(site)
                        .filter((owner) => owner.enabled !== false && owner.origin !== "script")
                        .map((owner) => ({
                            cpu: site.cpu,
                            type: site.type,
                            address: Number(site.address) >>> 0,
                            id: owner.id,
                            origin: owner.origin
                        }))
                ));
                if (conflicts.length) {
                    const error = new Error("script-only breakpoint policy requires all user and operation owners to be removed first");
                    error.mcpCode = ErrorCode.BREAKPOINT_POLICY_VIOLATION;
                    error.mcpDetails = { policy: mode, conflicts };
                    throw error;
                }
            }
            state.breakpointPolicy = mode;
            return { mode };
        },

        async listBreakpoints() {
            return state.breakpoints;
        },

        async removeBreakpoint(params = {}) {
            ensureReady();
            const id = Number(params.id ?? ui.bpIdSelect.value);
            const breakpoint = state.breakpoints.find((item) => item.id === id)
                || breakpointOwners.findBreakpointById(id);
            if (!breakpoint) throw new Error(`breakpoint not found: ${id}`);
            breakpointOwners.removeOwner(id);
            state.breakpoints = state.breakpoints.filter((item) => item.id !== id);
            renderBreakpoints();
            return { ok: true, removed: breakpoint, breakpoints: state.breakpoints };
        },

        async clearBreakpoints(params = {}) {
            ensureReady();
            const origin = params.origin === undefined ? "user" : String(params.origin);
            if (!["user", "all"].includes(origin)) {
                const error = new Error("origin must be user or all");
                error.mcpCode = "INVALID_ARGUMENT";
                throw error;
            }
            const removed = breakpointOwners.discardOwnersByOrigin(origin);
            const removedIds = new Set(removed.map((item) => item.id));
            state.breakpoints = state.breakpoints.filter((item) => !removedIds.has(item.id));
            let reconciliation;
            try {
                reconciliation = breakpointOwners.reconcileNativeBreakpoints();
            } catch (error) {
                renderBreakpoints();
                updateStatus();
                throw codedError(
                    ErrorCode.NATIVE_ERROR,
                    "Breakpoint owners were cleared, but native breakpoint reconciliation failed",
                    {
                        origin,
                        removedIds: [...removedIds],
                        breakpointsInSync: false,
                        nativeMessage: String(error?.message || error).slice(0, 300)
                    }
                );
            }
            renderBreakpoints();
            updateStatus();
            return {
                ok: true,
                removedIds: [...removedIds],
                breakpointsInSync: true,
                reconciliation,
                breakpoints: state.breakpoints,
                remaining: breakpointOwners.list().map((site) => ({
                    cpu: site.cpu,
                    type: site.type,
                    address: site.address,
                    owners: breakpointOwners.getOwners(site)
                }))
            };
        },

        async clearBreakStatus() {
            ensureReady();
            state.lastBreakKey = "";
            state.breakRefreshKey = "";
            state.breakLabel = "";
            updateStatus();
            native.clearBreakStatus();
            return { ok: true };
        },

        async step(params = {}) {
            return runDebuggerInstruction("step", params);
        },

        async smartStep(params = {}) {
            return runDebuggerInstruction("smartStep", params);
        },

        async stepOver(params = {}) {
            ensureRomLoaded("step over requires a loaded ROM");
            const cpu = String(params.cpu ?? state.selectedCpu);
            const legacyNativeFallback = async () => {
                const result = await runDebuggerInstruction("nativeStepOver", { ...params, cpu });
                result.kind = "stepOver";
                result.implementation = "native";
                return result;
            };
            if (cpu === "arm7") {
                return legacyNativeFallback();
            }
            const target = (getPc(cpu) + instructionWidthForMode("auto", cpu)) >>> 0;
            return runTraceStepper("stepOver", params, ({ pc, sameLane, startLanePresent, startFramePresent, atStartFrame }) => {
                if (!startLanePresent || (sameLane && !startFramePresent)) {
                    return { stop: "root", complete: false, target: hex(target) };
                }
                if (sameLane && atStartFrame && (pc >>> 0) === target) {
                    return { stop: "pc", target: hex(target) };
                }
                return false;
            }, { trackLane: true, requireTrackedLane: true, onMissingTrackedLane: legacyNativeFallback });
        },

        async stepNextBranchOrReturn(params = {}) {
            return runUntilNextBranchOrReturn(params);
        },

        async trueNextBranch(params = {}) {
            return runUntilTrueNextBranch(params);
        },

        async continue() {
            return resume();
        },

        async setStackTraceMode(params) {
            ensureReady();
            const enabled = !!params.enabled;
            const wasEnabled = !!ui.traceToggle.checked;
            if (enabled && state.traceEnabled === true && state.traceStateSynchronized === false) {
                return { enabled: true, synchronized: false, suspended: true };
            }
            native.setTraceEnabled(enabled);
            state.traceEnabled = enabled;
            ui.traceToggle.checked = enabled;
            if (!enabled) {
                state.selectedCallstackLaneId = null;
                state.traceStateSynchronized = true;
            } else if (!wasEnabled) {
                state.traceStateSynchronized = true;
            }
            renderCallStack(readCallStackData(), { autoSelectActive: enabled });
            return { enabled };
        },

        async setStackTracePrivilegeCheck(params) {
            ensureReady();
            native.setTracePrivilegeCheck(params.enabled);
            ui.tracePrivilegeToggle.checked = !!params.enabled;
            return { enabled: !!params.enabled };
        },

        async stackTrace(params = {}) {
            ensureRomLoaded("stack trace requires a loaded ROM");
            const callStack = readCallStackData(params);
            renderCallStack(callStack);
            return {
                callStack: publicCallStackData(callStack, params),
                text: native.stackTrace(params.cpu, positiveInteger(params.words ?? 32, "words", 1000000))
            };
        },

        async callStack(params = {}) {
            ensureRomLoaded("call stack requires a loaded ROM");
            const callStack = readCallStackData(params);
            renderCallStack(callStack);
            return publicCallStackData(callStack, params);
        },

        async listOtherCoroutines(params = {}) {
            ensureRomLoaded("other coroutine list requires a loaded ROM");
            const callStack = readCallStackData(params);
            renderCallStack(callStack);
            const details = publicOtherCoroutines(callStack, params);
            return {
                ...details,
                coroutines: details.coroutines.map(({ frames, ...summary }) => summary)
            };
        },

        async getOtherCoroutines(params = {}) {
            ensureRomLoaded("other coroutine details require a loaded ROM");
            const callStack = readCallStackData(params);
            renderCallStack(callStack);
            return publicOtherCoroutines(callStack, params);
        },

        async copyCallStackMarkdown() {
            ensureRomLoaded("call stack copy requires a loaded ROM");
            const callStack = readCallStackData({ limit: 512 });
            const rows = callStack.frames.map((frame) => (
                `| ${frame.ageLabel} | ${hex(frame.caller)} | ${hex(frame.returnAddress)} | ${hex(frame.callee)} | ${hex(frame.sp)} | ${frame.cpsrHex} | ${frame.modeName} | ${frame.thumb ? "thumb" : "arm"} | ${frame.id} |`
            ));
            const text = [
                "| age | caller | return | callee | sp | cpsr | mode | isa | id |",
                "|---|---|---|---|---|---|---|---|---:|",
                ...rows
            ].join("\n");
            renderCallStack(callStack);
            return { text: await copyText(text, "call stack markdown"), callStack };
        },

        async copyCallStackCsv() {
            ensureRomLoaded("call stack copy requires a loaded ROM");
            const callStack = readCallStackData({ limit: 512 });
            const escape = (value) => `"${String(value).replace(/"/g, '""')}"`;
            const rows = callStack.frames.map((frame) => [
                frame.ageLabel,
                hex(frame.caller),
                hex(frame.returnAddress),
                hex(frame.callee),
                hex(frame.sp),
                frame.cpsrHex,
                frame.modeName,
                frame.thumb ? "thumb" : "arm",
                frame.id
            ].map(escape).join(","));
            const text = ["age,caller,return,callee,sp,cpsr,mode,isa,id", ...rows].join("\n");
            renderCallStack(callStack);
            return { text: await copyText(text, "call stack csv"), callStack };
        },

        async runUntilReturn(params = {}) {
            return runTraceStepper("runUntilReturn", params, ({ depth, startDepth }) => depth < startDepth);
        },

        async runUntilNextCall(params = {}) {
            return runTraceStepper("runUntilNextCall", params, ({ depth, startDepth }) => depth > startDepth);
        },

        async nextCallThisDepth(params = {}) {
            const cpu = String(params.cpu ?? state.selectedCpu);
            if (cpu === "arm7") {
                throw codedError(ErrorCode.STATE_INVALID, "nextCallThisDepth requires ARM9 Stack Trace data");
            }
            const depthFallback = async () => {
                const result = await debuggerCommands.runUntilNextCall({ ...params, cpu });
                result.kind = "nextCallThisDepth";
                result.implementation = "depth";
                if (result.complete !== false && !result.stoppedByBreakpoint && !result.stop) result.stop = "call";
                return result;
            };
            return runTraceStepper("nextCallThisDepth", params, ({ sameLane, startLanePresent, startFramePresent, directCallFromStartDepth }) => {
                if (!startLanePresent) return { stop: "root", complete: false };
                if (!sameLane) return false;
                if (!startFramePresent) return { stop: "root", complete: false };
                if (directCallFromStartDepth) return { stop: "call" };
                return false;
            }, { trackLane: true, requireTrackedLane: true, onMissingTrackedLane: depthFallback });
        },

        async wait(params = {}) {
            const ms = nonNegativeNumber(params.ms ?? params.waitMs ?? 0, "ms", 600000);
            await new Promise((resolve) => setTimeout(resolve, ms));
            return status();
        },

        async waitMs(params = {}) {
            return debuggerCommands.wait(params);
        },

        async nextFunctionEnter(params = {}) {
            return debuggerCommands.runUntilNextCall(params);
        },

        async nextCall(params = {}) {
            return debuggerCommands.runUntilNextCall(params);
        },

        async nextFunctionCall(params = {}) {
            return debuggerCommands.runUntilNextCall(params);
        },

        async nextBranchOrReturn(params = {}) {
            return debuggerCommands.stepNextBranchOrReturn(params);
        },

        async nextTrueBranch(params = {}) {
            return debuggerCommands.trueNextBranch(params);
        },

        async returnToPop(params = {}) {
            return debuggerCommands.runUntilReturn(params);
        }
    };

    return debuggerCommands;
}
