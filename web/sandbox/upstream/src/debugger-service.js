import { ErrorCode } from "./error-codes.js";
import { positiveInteger } from "./validation.js";

export function createDebuggerService({
    ANALYSIS_BASELINE_SLOT_PREFIX,
    ANALYSIS_BASELINE_STATE_FORMAT_VERSION,
    applyFreezes,
    breakpointKindName,
    cpsrModeInfo,
    disasmRefreshParams,
    ensureReady,
    ensureRomLoaded,
    getPc,
    getRegisters,
    handleNativeFault,
    hasLoadedRom,
    hex,
    log,
    normalizeCallStackData,
    native,
    publicCallStackData,
    readCallStackData,
    renderRegisters,
    setFollowPc,
    state,
    syncNativeBreakStatus,
    ui,
    updateStatus,
    withCurrentExecBreakpointSuspended,
    getCommands
}) {
    if (typeof applyFreezes !== "function") {
        throw new TypeError("createDebuggerService requires applyFreezes");
    }
    const commands = new Proxy({}, {
        get: (_, command) => getCommands()[command]
    });

    function instructionOpcode(line) {
        return String(line || "").replace(/^=>/, "  ");
    }

    function stripDisassemblyBytesLine(line) {
        return String(line || "").replace(/^(\s*(?:=>)?\s*[0-9a-fA-F]+:\s+)[0-9a-fA-F]{1,8}\s+(.*)$/i, "$1$2");
    }
    
    function formatDisassemblyText(text, includeBytes = false) {
        if (includeBytes) return String(text || "");
        return String(text || "").split("\n").map(stripDisassemblyBytesLine).join("\n");
    }
    
    function shouldIncludeDisassemblyBytes(params = {}) {
        if (params.includeBytes != null) return !!params.includeBytes;
        if (params.bytes != null) return !!params.bytes;
        return ui.disasmBytes ? ui.disasmBytes.value === "show" : false;
    }
    
    function instructionBody(line) {
        return instructionOpcode(line).replace(/^\s*[0-9a-fA-F]+:\s*(?:(?:[0-9a-fA-F]{4}|[0-9a-fA-F]{8})\s+)?/i, "").trim();
    }
    
    function armConditionSuffix(text) {
        return /^(eq|ne|cs|cc|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al)$/i.test(String(text || ""));
    }
    
    function mnemonicMatches(mnemonic, base) {
        const op = String(mnemonic || "").toLowerCase();
        if (op === base) return true;
        return op.startsWith(base) && armConditionSuffix(op.slice(base.length));
    }
    
    function isBranchLinkMnemonic(mnemonic) {
        const op = String(mnemonic || "").toLowerCase();
        return op === "bl" || (op.startsWith("bl") && armConditionSuffix(op.slice(2)));
    }
    
    function isBranchLinkExchangeMnemonic(mnemonic) {
        const op = String(mnemonic || "").toLowerCase();
        return op === "blx" || (op.startsWith("blx") && armConditionSuffix(op.slice(3)));
    }
    
    function classifyInstruction(line) {
        const body = instructionBody(line);
        const match = body.match(/^([a-z][a-z0-9]*)(?:\s+(.*))?$/i);
        const mnemonic = String(match?.[1] || "").toLowerCase();
        const operands = String(match?.[2] || "").toLowerCase();
        const isCall = isBranchLinkMnemonic(mnemonic) || isBranchLinkExchangeMnemonic(mnemonic);
        const firstOperand = (operands.match(/^\s*([^,\s\]!]+)/) || [])[1] || "";
        const destPc = firstOperand === "pc";
        const isBx = mnemonicMatches(mnemonic, "bx");
        const isMovPc = (mnemonicMatches(mnemonic, "mov") || mnemonicMatches(mnemonic, "movs")) && destPc;
        const isLdrPc = mnemonicMatches(mnemonic, "ldr") && destPc;
        const isLdmPc = /^ldm/i.test(mnemonic) && /\{[^}]*\bpc\b[^}]*\}\^?/i.test(operands);
        const isPopPc = mnemonicMatches(mnemonic, "pop") && /\{[^}]*\bpc\b[^}]*\}/i.test(operands);
        const isSubsPc = mnemonicMatches(mnemonic, "subs") && destPc;
        const isAluPcBranch = (mnemonicMatches(mnemonic, "add") || mnemonicMatches(mnemonic, "sub")) && destPc;
        const isPurpleBranch = mnemonic.startsWith("b") && !isCall && !isBx;
        const isReturn = (isBx && /\blr\b/i.test(operands)) || isLdmPc || isPopPc || isSubsPc || (isMovPc && /\blr\b/i.test(operands));
        const writesPc = isBx || isMovPc || isLdrPc || isLdmPc || isPopPc || isSubsPc || isAluPcBranch;
        return {
            mnemonic,
            body,
            kind: isCall ? "call" : isReturn ? "return" : isBx ? "bx" : (isPurpleBranch || writesPc) ? "branch" : "normal",
            isCall,
            isBx,
            isReturn,
            isBranch: isPurpleBranch || writesPc,
            writesPc
        };
    }
    
    async function getCurrentInstructionInfo(cpu = state.selectedCpu) {
        const disasm = await commands.disassemble({ cpu, address: "pc", before: 0, count: 1, mode: "auto" });
        const line = String(disasm.text || "").split("\n").find((item) => item.trim()) || "";
        const address = parseInt((line.match(/(?:=>|  )\s*([0-9a-fA-F]+):/) || [])[1] || "", 16);
        return { line, address: Number.isFinite(address) ? (address >>> 0) : null, ...classifyInstruction(line) };
    }
    
    function registerHexSnapshot(cpu = state.selectedCpu) {
        const values = getRegisters(cpu);
        return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, hex(value)]));
    }
    
    function stepStatusSummary(cpu, native = null) {
        const status = native || syncNativeBreakStatus() || {};
        const lastBreak = status.lastBreak && status.lastBreak.hit ? status.lastBreak : null;
        return {
            cpu: String(cpu),
            breakReason: lastBreak ? breakpointKindName(lastBreak.kind) : (state.breakLabel || ""),
            paused: !!state.paused
        };
    }
    
    function emulatorActivity() {
        return { paused: !!state.paused, running: !!state.running };
    }
    
    function analysisBaselineKey(name) {
        return `analysis-baseline:${String(name || "default")}`;
    }
    
    function isAnalysisBaselineSlot(slot) {
        return String(slot || "").startsWith(ANALYSIS_BASELINE_SLOT_PREFIX);
    }
    
    async function currentRomIdentity() {
        if (!state.romBytes || state.romBytes.length !== state.romSize) throw new Error("current ROM bytes are unavailable for baseline verification");
        if (!globalThis.crypto || !crypto.subtle) throw new Error("SHA-256 is unavailable; analysis baseline cannot be saved safely");
        const digest = await crypto.subtle.digest("SHA-256", state.romBytes);
        return {
            romName: state.romName,
            romSize: state.romSize,
            romSha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
            stateFormatVersion: ANALYSIS_BASELINE_STATE_FORMAT_VERSION
        };
    }
    
    async function sha256Hex(bytes) {
        if (!globalThis.crypto || !crypto.subtle) throw new Error("SHA-256 is unavailable");
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    
    function readAnalysisBaseline(name) {
        const key = String(name || "default");
        const cached = state.analysisBaselines.get(key);
        if (cached) return cached;
        try {
            const saved = JSON.parse(localStorage.getItem(analysisBaselineKey(key)) || "null");
            if (saved && typeof saved === "object") state.analysisBaselines.set(key, saved);
            return saved;
        } catch (_) {
            return null;
        }
    }
    
    function writeAnalysisBaseline(name, baseline) {
        const key = String(name || "default");
        localStorage.setItem(analysisBaselineKey(key), JSON.stringify(baseline));
        state.analysisBaselines.set(key, baseline);
    }
    
    async function snapshotContext(params = {}) {
        ensureReady();
        const cpu = String(params.cpu ?? state.selectedCpu);
        const status = await commands.status();
        const registers = registerHexSnapshot(cpu);
        const disassembly = hasLoadedRom()
            ? await commands.disassemble({ cpu, address: "pc", before: Math.max(0, Number(params.before ?? 1)), count: Math.max(1, Math.min(8, Number(params.count ?? 3))), mode: "auto" })
            : { text: "" };
        const native = status.native || {};
        const lastBreak = native.lastBreak && native.lastBreak.hit ? native.lastBreak : null;
        return {
            ...emulatorActivity(),
            romLoaded: !!status.romLoaded,
            frame: status.frame,
            cpu,
            registers: { pc: registers.pc, sp: registers.sp, lr: registers.lr, cpsr: registers.cpsr },
            nearPc: String(disassembly.text || "").split("\n").map((line) => line.trim()).filter(Boolean),
            breakReason: lastBreak ? breakpointKindName(lastBreak.kind) : "",
            skipIrq: !!ui.tracePrivilegeToggle.checked,
            traceEnabled: !!ui.traceToggle.checked
        };
    }
    
    async function attachDebuggerContext(result, cpu, pcBefore, native = null) {
        const pcAfter = getPc(cpu);
        const disassembly = await commands.disassemble({ cpu, address: pcAfter, before: 1, count: 2, mode: "auto" });
        return {
            ...result,
            pcBefore: hex(pcBefore),
            pcAfter: hex(pcAfter),
            pc: hex(pcAfter),
            status: stepStatusSummary(cpu, native),
            registers: registerHexSnapshot(cpu),
            disassembly: String(disassembly.text || "").split("\n").map((line) => line.trim()).filter(Boolean)
        };
    }

    async function stepPastCurrentExecBreakpoint(cpu, operation) {
        return withCurrentExecBreakpointSuspended(cpu, async () => {
            native.clearBreakStatus();
            return operation();
        });
    }

    async function runDebuggerInstruction(kind, params = {}) {
        ensureRomLoaded("debugger step requires a loaded ROM");
        const cpu = String(params.cpu ?? state.selectedCpu);
        const stepCount = kind === "step" || kind === "smartStep"
            ? positiveInteger(params.count ?? 1, "count", 1000000)
            : 1;
        const pcBefore = getPc(cpu);
        let result = { kind, count: 0 };
        state.breakRefreshKey = "";
        if (kind === "smartStep") {
            const info = await getCurrentInstructionInfo(cpu);
            const chosen = info.kind === "call" || info.kind === "bx" ? "stepOver" : "step";
            const implementation = chosen === "stepOver" ? "nativeStepOver" : chosen;
            result = await runDebuggerInstruction(implementation, { ...params, cpu });
            result.kind = "smartStep";
            result.chosen = chosen;
            result.instruction = info;
            return result;
        } else {
            try {
                if (kind === "step") {
                    result.count = await stepPastCurrentExecBreakpoint(
                        cpu,
                        () => native.step(cpu, stepCount)
                    );
                }
                else if (kind === "nativeStepOver") {
                    result.count = await stepPastCurrentExecBreakpoint(
                        cpu,
                        () => native.stepOver(cpu)
                    );
                    result.ret = result.count;
                } else throw new Error(`unsupported debugger step: ${kind}`);
            } catch (error) {
                if (error?.mcpCode === ErrorCode.NATIVE_ERROR
                    || error?.mcpCode === ErrorCode.NATIVE_FAULT) {
                    handleNativeFault(error, kind);
                }
                throw error;
            }
        }
        applyFreezes();
        const nativeStatus = syncNativeBreakStatus();
        updateStatus();
        result.paused = state.paused;
        return attachDebuggerContext(result, cpu, pcBefore, nativeStatus);
    }
    
    async function runUntilNextBranchOrReturn(params = {}) {
        ensureRomLoaded("next branch/return requires a loaded ROM");
        const cpu = String(params.cpu ?? state.selectedCpu);
        const pcBefore = getPc(cpu);
        const timeoutMs = positiveInteger(params.timeoutMs ?? 1000, "timeoutMs", 600000);
        const maxSteps = positiveInteger(params.maxSteps ?? 200000, "maxSteps", 1000000);
        const deadline = performance.now() + timeoutMs;
        let steps = 0;
        state.breakRefreshKey = "";
        native.clearBreakStatus();
        while (performance.now() < deadline && steps < maxSteps) {
            const info = await getCurrentInstructionInfo(cpu);
            if (info.isReturn || info.isBranch) {
                const result = { kind: "stepNextBranchOrReturn", ok: true, steps, stop: info.isReturn ? "return" : "branch", instruction: info };
                return attachDebuggerContext(result, cpu, pcBefore);
            }
            if (info.isCall) {
                await stepPastCurrentExecBreakpoint(cpu, () => native.stepOver(cpu));
            } else {
                await stepPastCurrentExecBreakpoint(cpu, () => native.step(cpu, 1));
            }
            steps++;
            applyFreezes();
            const nativeStatus = syncNativeBreakStatus();
            if (nativeStatus && nativeStatus.lastBreak && nativeStatus.lastBreak.hit) {
                return attachDebuggerContext({ kind: "stepNextBranchOrReturn", ok: true, complete: false, stoppedByBreakpoint: true, steps, instruction: info }, cpu, pcBefore, nativeStatus);
            }
        }
        throw new Error(`stepNextBranchOrReturn timeout after ${timeoutMs}ms`);
    }
    
    async function runUntilTrueNextBranch(params = {}) {
        ensureRomLoaded("true next branch requires a loaded ROM");
        const cpu = String(params.cpu ?? state.selectedCpu);
        const pcBefore = getPc(cpu);
        const timeoutMs = positiveInteger(params.timeoutMs ?? 1000, "timeoutMs", 600000);
        const maxSteps = positiveInteger(params.maxSteps ?? 200000, "maxSteps", 1000000);
        const deadline = performance.now() + timeoutMs;
        let steps = 0;
        state.breakRefreshKey = "";
        native.clearBreakStatus();
        while (performance.now() < deadline && steps < maxSteps) {
            const info = await getCurrentInstructionInfo(cpu);
            const sequentialPc = info.address == null ? null : (info.address + instructionWidthForMode("auto", cpu)) >>> 0;
            await stepPastCurrentExecBreakpoint(cpu, () => native.step(cpu, 1));
            steps++;
            applyFreezes();
            const nativeStatus = syncNativeBreakStatus();
            const pcAfter = getPc(cpu);
            if (nativeStatus && nativeStatus.lastBreak && nativeStatus.lastBreak.hit) {
                return attachDebuggerContext({ kind: "trueNextBranch", ok: true, complete: false, stoppedByBreakpoint: true, steps, instruction: info }, cpu, pcBefore, nativeStatus);
            }
            if ((info.isBranch || info.isReturn || info.isCall) && sequentialPc !== null && pcAfter !== sequentialPc) {
                return attachDebuggerContext({ kind: "trueNextBranch", ok: true, steps, instruction: info, branchFrom: hex(info.address), branchTo: hex(pcAfter) }, cpu, pcBefore);
            }
        }
        throw new Error(`trueNextBranch timeout after ${timeoutMs}ms`);
    }
    
    function renderDisassembly(text) {
        const lines = String(text || "").split("\n").filter(Boolean);
        ui.disasmOutput.innerHTML = lines.map((line) => {
            const current = line.startsWith("=>");
            const address = parseInt((line.match(/(?:=>|  )\s*([0-9a-fA-F]+):/) || [])[1] || "", 16);
            const highlighted = Number.isFinite(address) && state.highlightedDisasmAddress === address;
            const modeClass = highlighted && state.highlightedCallstackCpsr != null ? cpsrModeInfo(state.highlightedCallstackCpsr).className : "";
            const hasBp = state.breakpoints.some((bp) => bp.type === "exec" && bp.cpu === state.selectedCpu && bp.address === address);
            const opcode = instructionOpcode(line);
            const body = instructionBody(line);
            const info = classifyInstruction(line);
            const isCallLike = isBranchLinkMnemonic(info.mnemonic) || /\bpush\b/i.test(opcode);
            const isMemoryReturnLike = /^ldm/i.test(info.mnemonic) && /\{[^}]*\bpc\b[^}]*\}\^?/i.test(body);
            const isBranchLike = info.isBranch || info.writesPc;
            const cls = ["disasm-line", highlighted ? "highlight-line" : "", modeClass, isCallLike ? "entry-line" : "", isMemoryReturnLike ? "return-line" : "", isBranchLike ? "branch-line" : "", hasBp ? "breakpoint-line" : "", current ? "current" : ""].filter(Boolean).join(" ");
            return `<span class="${cls}">${line.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</span>`;
        }).join("");
    }
    
    function renderCallStack(data, options = {}) {
        data = normalizeCallStackData(data);
        const stacks = data && Array.isArray(data.stacks) ? data.stacks : [];
        const fallbackLaneId = Number(data?.activeStackId ?? stacks[0]?.id ?? 1);
        const selectedExists = stacks.some((stack) => stack.id === state.selectedCallstackLaneId);
        if (options.autoSelectActive || !selectedExists) state.selectedCallstackLaneId = fallbackLaneId;
        const selectedStack = stacks.find((stack) => stack.id === state.selectedCallstackLaneId) || stacks[0] || null;
        renderCallStackLanes(stacks, selectedStack ? selectedStack.id : null);
        const frames = selectedStack ? selectedStack.frames : (data && Array.isArray(data.frames) ? data.frames : []);
        if (!frames.length) {
            ui.callstackBody.innerHTML = `<tr><td colspan="9">${data && data.enabled ? "no frames recorded" : "stack trace disabled"}</td></tr>`;
            return;
        }
        ui.callstackBody.innerHTML = frames.map((frame) => {
            const caller = hex(frame.caller);
            const callee = hex(frame.callee);
            const highlighted = state.highlightedCallstackAddress === frame.caller || state.highlightedCallstackAddress === frame.callee;
            const cls = ["callstack-row", highlighted ? "highlight" : "", frame.modeClass].filter(Boolean).join(" ");
            const execMode = frame.synthetic ? `pc-write ${frame.kindName}` : `${frame.thumb ? "thumb" : "arm"} ${frame.modeName}`;
            const cpuMode = frame.modeName;
            const calleeText = frame.synthetic ? `${callee} ${frame.kindName}` : `${callee} (${frame.id})`;
            const returnTitle = frame.synthetic ? `expected ${hex(frame.expected)} target ${hex(frame.target)}` : `return ${hex(frame.returnAddress)}`;
            return `<tr class="${cls}"><td title="newest frame is the top row">${frame.ageLabel}</td><td title="${returnTitle}">${caller}</td><td>${calleeText}</td><td>${hex(frame.sp)}</td><td title="CPSR ${frame.cpsrHex}">${frame.cpsrHex}</td><td>${execMode}</td><td>${cpuMode}</td><td><button type="button" data-jump-address="${caller}" data-jump-cpsr="${frame.cpsr}" data-jump-label="caller">Caller</button></td><td><button type="button" data-jump-address="${callee}" data-jump-cpsr="${frame.cpsr}" data-jump-label="callee">Callee</button></td></tr>`;
        }).join("");
    }
    
    function renderCallStackLanes(stacks, selectedId) {
        if (!ui.callstackLaneTabs || !ui.callstackLaneTabTemplate) return;
        const fragment = document.createDocumentFragment();
        for (const stack of stacks) {
            const button = ui.callstackLaneTabTemplate.content.firstElementChild.cloneNode(true);
            button.dataset.laneId = String(stack.id);
            button.dataset.active = String(stack.id === selectedId);
            button.dataset.now = String(!!stack.active);
            button.querySelector("[data-lane-label]").textContent = `SP ${stack.spHex} PC ${stack.nowPcHex}`;
            button.querySelector("[data-lane-depth]").textContent = `${stack.depth}`;
            button.querySelector("[data-lane-now]").hidden = !stack.active;
            button.title = `lane ${stack.id}, depth ${stack.depth}, now PC ${stack.nowPcHex}`;
            fragment.append(button);
        }
        ui.callstackLaneTabs.replaceChildren(fragment);
    }
    
    async function refreshDebuggerViews(disasmParams = {}) {
        if (!disasmParams.keepHighlight) {
            state.highlightedDisasmAddress = null;
            state.highlightedCallstackAddress = null;
            state.highlightedCallstackCpsr = null;
        }
        renderRegisters();
        renderCallStack(readCallStackData(), { autoSelectActive: true });
        const disasm = await commands.disassemble(disasmRefreshParams(disasmParams));
        renderDisassembly(disasm.text);
        if (ui.memoryAuto.value === "1") renderMemoryDump(await commands.dumpMemory({ cpu: disasmParams.cpu }));
        syncNativeBreakStatus();
        updateStatus();
        return disasm;
    }
    
    function queueBreakpointRefresh(cpu = state.selectedCpu) {
        if (state.breakRefreshPending || !hasLoadedRom()) return;
        state.breakRefreshPending = true;
        if (state.breakRefreshTimer) clearTimeout(state.breakRefreshTimer);
        state.breakRefreshTimer = setTimeout(async () => {
            state.breakRefreshPending = false;
            state.breakRefreshTimer = 0;
            try {
                state.selectedCpu = cpu;
                ui.cpuSelect.value = cpu;
                setFollowPc(true);
                state.highlightedDisasmAddress = null;
                state.highlightedCallstackAddress = null;
                state.highlightedCallstackCpsr = null;
                await refreshDebuggerViews({ cpu, address: "pc", keepHighlight: true });
            } catch (error) {
                log(error.message || String(error));
            }
        }, 5);
    }
    
    function stopAutoUpdateLoop() {
        if (state.autoUpdate.timer) clearTimeout(state.autoUpdate.timer);
        state.autoUpdate.timer = 0;
    }
    
    function queueAutoUpdateLoop() {
        stopAutoUpdateLoop();
        if (!state.autoUpdate.enabled) return;
        const hz = Math.max(1, Math.min(20, Number(state.autoUpdate.hz) || 4));
        state.autoUpdate.timer = setTimeout(async () => {
            if (state.autoUpdate.enabled && state.ready && hasLoadedRom() && !state.loadingFile) {
                try {
                    await refreshDebuggerViews({ keepHighlight: true });
                } catch (error) {
                    log(error.message || String(error));
                }
            }
            queueAutoUpdateLoop();
        }, Math.max(50, Math.round(1000 / hz)));
    }
    
    async function runTraceStepper(label, params = {}, shouldStop, options = {}) {
        ensureRomLoaded(`${label} requires a loaded ROM`);
        if (state.traceStateSynchronized === false) {
            const error = new Error("Stateロード後のactive stackはCPU状態と同期していません。Stack Traceをoff/onして再同期してから実行してください。");
            error.mcpCode = ErrorCode.STATE_INVALID;
            throw error;
        }
        const cpu = String(params.cpu ?? state.selectedCpu);
        const pcBefore = getPc(cpu);
        const timeoutMs = positiveInteger(params.timeoutMs ?? 1000, "timeoutMs", 600000);
        const maxSteps = positiveInteger(params.maxSteps ?? 200000, "maxSteps", 1000000);
        const traceWasEnabled = !!ui.traceToggle.checked;
        if (!ui.traceToggle.checked) await commands.setStackTraceMode({ enabled: true });
        let trackLane = !!options.trackLane;
        const stackFramesComplete = (stack) => {
            const frames = Array.isArray(stack?.frames) ? stack.frames : [];
            return frames.length >= Number(stack?.depth ?? frames.length);
        };
        const realFrameMarker = (frame) => frame && !frame.synthetic ? {
            id: Number(frame.id),
            caller: Number(frame.caller) >>> 0,
            callee: Number(frame.callee) >>> 0,
            returnAddress: Number(frame.returnAddress) >>> 0
        } : null;
        const frameMatchesMarker = (frame, marker) => !!frame && !frame.synthetic && !!marker
            && Number(frame.id) === marker.id
            && (Number(frame.caller) >>> 0) === marker.caller
            && (Number(frame.callee) >>> 0) === marker.callee
            && (Number(frame.returnAddress) >>> 0) === marker.returnAddress;
        const newestRealFrame = (stack) => (Array.isArray(stack?.frames) ? stack.frames : [])
            .find((frame) => !frame.synthetic) || null;
        const containsFrameMarker = (stack, marker) => !marker
            || (Array.isArray(stack?.frames) ? stack.frames : []).some((frame) => frameMatchesMarker(frame, marker));
        const atTrackedStartDepth = (stack, marker) => {
            if (!stack) return false;
            if (!marker) return newestRealFrame(stack) == null;
            if (!containsFrameMarker(stack, marker)) return false;
            const current = newestRealFrame(stack);
            if (!current) return false;
            return frameMatchesMarker(current, marker)
                || (Number(current.returnAddress) >>> 0) === marker.returnAddress;
        };
        let startCallStack = readCallStackData();
        let startStacks = Array.isArray(startCallStack?.stacks) ? startCallStack.stacks : [];
        const startStackId = Number(startCallStack?.activeStackId ?? startStacks.find((stack) => stack.active)?.id);
        let startStack = startStacks.find((stack) => Number(stack.id) === startStackId);
        if (trackLane && startStack && !newestRealFrame(startStack) && !stackFramesComplete(startStack)) {
            startCallStack = readCallStackData({ limit: 1024 });
            startStacks = Array.isArray(startCallStack?.stacks) ? startCallStack.stacks : [];
            startStack = startStacks.find((stack) => Number(stack.id) === startStackId);
        }
        let startDepth = trackLane
            ? Number(startStack?.depth ?? startCallStack?.depth ?? native.getTraceDepth())
            : native.getTraceDepth();
        let startFrameMarker = trackLane ? realFrameMarker(newestRealFrame(startStack)) : null;
        if (options.requireTrackedLane && (!Number.isFinite(startStackId) || !startStack || startDepth <= 0)) {
            if (!traceWasEnabled) {
                trackLane = false;
                startDepth = native.getTraceDepth();
                startFrameMarker = null;
            } else if (typeof options.onMissingTrackedLane === "function") {
                return options.onMissingTrackedLane();
            } else {
                const error = new Error(`${label} requires a recorded active Stack Trace frame`);
                error.mcpCode = ErrorCode.STATE_INVALID;
                throw error;
            }
        }
        if ((params.skipIrq ?? true) && !ui.tracePrivilegeToggle.checked) {
            await commands.setStackTracePrivilegeCheck({ enabled: true });
        }
        native.clearBreakStatus();
        const deadline = performance.now() + timeoutMs;
        let steps = 0;
        let beforeSameLane = true;
        let beforeStartFramePresent = !startFrameMarker || containsFrameMarker(startStack, startFrameMarker);
        let beforeAtStartDepth = !trackLane || atTrackedStartDepth(startStack, startFrameMarker);
        while (performance.now() < deadline && steps < maxSteps) {
            try {
                if (steps > 0 && native.checkExecBreakpoint(cpu, getPc(cpu))) {
                    const nativeStatus = syncNativeBreakStatus();
                    const callStack = readCallStackData();
                    const stacks = Array.isArray(callStack?.stacks) ? callStack.stacks : [];
                    const activeStackId = Number(callStack?.activeStackId ?? stacks.find((stack) => stack.active)?.id);
                    const activeStack = stacks.find((stack) => Number(stack.id) === activeStackId);
                    const depth = Number(activeStack?.depth ?? callStack.depth ?? callStack.frames?.length ?? 0);
                    return attachDebuggerContext({
                        kind: label,
                        ok: true,
                        complete: false,
                        stoppedByBreakpoint: true,
                        steps,
                        depth,
                        callStack: publicCallStackData(callStack, { ...params, cpu })
                    }, cpu, pcBefore, nativeStatus);
                }
                await stepPastCurrentExecBreakpoint(cpu, () => native.step(cpu, 1));
            } catch (error) {
                if (error?.mcpCode === ErrorCode.NATIVE_ERROR
                    || error?.mcpCode === ErrorCode.NATIVE_FAULT) {
                    handleNativeFault(error, label);
                }
                throw error;
            }
            steps++;
            applyFreezes();
            const nativeStatus = syncNativeBreakStatus();
            let callStack = readCallStackData();
            let stacks = Array.isArray(callStack?.stacks) ? callStack.stacks : [];
            let activeStackId = Number(callStack?.activeStackId ?? stacks.find((stack) => stack.active)?.id);
            let activeStack = stacks.find((stack) => Number(stack.id) === activeStackId);
            let startLaneStack = trackLane
                ? stacks.find((stack) => Number(stack.id) === startStackId)
                : activeStack;
            if (trackLane && startLaneStack && startFrameMarker
                && !containsFrameMarker(startLaneStack, startFrameMarker)
                && !stackFramesComplete(startLaneStack)) {
                callStack = readCallStackData({ limit: 1024 });
                stacks = Array.isArray(callStack?.stacks) ? callStack.stacks : [];
                activeStackId = Number(callStack?.activeStackId ?? stacks.find((stack) => stack.active)?.id);
                activeStack = stacks.find((stack) => Number(stack.id) === activeStackId);
                startLaneStack = stacks.find((stack) => Number(stack.id) === startStackId);
            }
            const startLanePresent = !trackLane
                || !!startLaneStack;
            const sameLane = !trackLane || activeStackId === startStackId;
            const depth = Number(activeStack?.depth ?? callStack.depth ?? callStack.frames?.length ?? 0);
            const currentRealFrame = trackLane && sameLane ? newestRealFrame(activeStack) : null;
            const startFramePresent = !trackLane || !startFrameMarker
                ? startLanePresent
                : containsFrameMarker(startLaneStack, startFrameMarker);
            const atStartFrame = !trackLane
                ? depth === startDepth
                : sameLane && (startFrameMarker
                    ? frameMatchesMarker(currentRealFrame, startFrameMarker)
                    : currentRealFrame == null);
            const atStartDepth = !trackLane
                ? depth === startDepth
                : sameLane && startFramePresent && atTrackedStartDepth(activeStack, startFrameMarker);
            const deeperThanStart = trackLane && sameLane && startFramePresent && !atStartFrame && !!currentRealFrame;
            const directCallFromStartDepth = trackLane
                ? beforeSameLane
                    && beforeStartFramePresent
                    && beforeAtStartDepth
                    && sameLane
                    && startFramePresent
                    && !!currentRealFrame
                    && !frameMatchesMarker(currentRealFrame, startFrameMarker)
                    && ((Number(currentRealFrame.callee) >>> 0) & ~1) === ((getPc(cpu) >>> 0) & ~1)
                : beforeAtStartDepth && depth > startDepth;
            if (nativeStatus && nativeStatus.lastBreak && nativeStatus.lastBreak.hit) {
                return attachDebuggerContext({ kind: label, ok: true, complete: false, stoppedByBreakpoint: true, steps, depth, callStack: publicCallStackData(callStack, { ...params, cpu }) }, cpu, pcBefore, nativeStatus);
            }
            const stop = shouldStop({
                startDepth,
                depth,
                callStack,
                pc: getPc(cpu),
                startStackId,
                activeStackId,
                sameLane,
                startLanePresent,
                startFramePresent,
                atStartFrame,
                atStartDepth,
                deeperThanStart,
                directCallFromStartDepth
            });
            if (stop) {
                return attachDebuggerContext({
                    kind: label,
                    ok: true,
                    steps,
                    depth,
                    ...(typeof stop === "object" ? stop : {}),
                    callStack: publicCallStackData(callStack, { ...params, cpu })
                }, cpu, pcBefore);
            }
            beforeSameLane = sameLane;
            beforeStartFramePresent = startFramePresent;
            beforeAtStartDepth = atStartDepth;
        }
        const callStack = readCallStackData();
        const depth = Number(callStack.depth ?? callStack.frames?.length ?? 0);
        const hitStepLimit = steps >= maxSteps;
        return attachDebuggerContext({
            kind: label,
            ok: true,
            complete: false,
            stop: hitStepLimit ? "maxSteps" : "timeout",
            limitReached: true,
            steps,
            depth,
            timeoutMs,
            maxSteps,
            callStack: publicCallStackData(callStack, { ...params, cpu })
        }, cpu, pcBefore);
    }
    
    function renderMemoryDump(result) {
        const bytes = result.bytes || [];
        const lines = [];
        const view = String(result.view || ui.memoryView?.value || "mixed");
        const breakpointAddresses = new Set(state.breakpoints.filter((bp) => bp.cpu === state.selectedCpu && (bp.type === "read" || bp.type === "write")).map((bp) => bp.address >>> 0));
        for (let i = 0; i < bytes.length; i += 16) {
            const slice = bytes.slice(i, i + 16);
            const cells = slice.map((b, j) => {
                const addr = result.address + i + j;
                const cls = ["memory-byte", breakpointAddresses.has(addr >>> 0) ? "breakpoint-memory" : ""].filter(Boolean).join(" ");
                return `<span class="${cls}" data-memory-address="${hex(addr)}" data-memory-value="${b.toString(16).padStart(2, "0")}">${b.toString(16).padStart(2, "0")}</span>`;
            }).join(" ");
            const words = [];
            for (let j = 0; j + 3 < slice.length; j += 4) {
                const wordAddress = (result.address + i + j) >>> 0;
                const highlightWord = breakpointAddresses.has(wordAddress) || breakpointAddresses.has((wordAddress + 1) >>> 0) || breakpointAddresses.has((wordAddress + 2) >>> 0) || breakpointAddresses.has((wordAddress + 3) >>> 0);
                const word = hex(readSized(slice, j, 4));
                words.push(highlightWord ? `<span class="memory-u32 breakpoint-memory">${word}</span>` : `<span class="memory-u32">${word}</span>`);
            }
            if (view === "packed32") lines.push(`<span class="memory-line">${hex(result.address + i)}  ${words.join("  ")}</span>`);
            else if (view === "bytes") lines.push(`<span class="memory-line">${hex(result.address + i)}  <span class="memory-bytes">${cells}</span></span>`);
            else lines.push(`<span class="memory-line">${hex(result.address + i)}  <span class="memory-bytes">${cells}</span>${words.length ? `  ${words.join("  ")}` : ""}</span>`);
        }
        ui.memoryOutput.innerHTML = lines.join("\n");
    }
    
    function modeNumber(mode) {
        return mode === "thumb" ? 1 : mode === "arm" ? 2 : 0;
    }
    
    function instructionWidthForMode(mode, cpu = state.selectedCpu) {
        if (mode === "thumb") return 2;
        if (mode === "arm") return 4;
        return (getRegisters(cpu).cpsr & 0x20) ? 2 : 4;
    }
    
    function readSized(bytes, offset, size) {
        if (size === 4) return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
        if (size === 2) return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
        return bytes[offset] >>> 0;
    }
    
    function matchSearchCondition(condition, current, previous, value, hasPrevious) {
        if (condition === "changed") return hasPrevious && current !== previous;
        if (condition === "unchanged") return hasPrevious && current === previous;
        if (condition === "increased") return hasPrevious && current > previous;
        if (condition === "decreased") return hasPrevious && current < previous;
        if (condition === "notEqual") return current !== value;
        if (condition === "greater") return current > value;
        if (condition === "less") return current < value;
        return current === value;
    }
    
    async function idbPut(key, bytes) {
        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open("desmume-web-debugger", 1);
            req.onupgradeneeded = () => req.result.createObjectStore("states");
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        await new Promise((resolve, reject) => {
            const tx = db.transaction("states", "readwrite");
            tx.objectStore("states").put(bytes, key);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    }
    
    async function idbGet(key) {
        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open("desmume-web-debugger", 1);
            req.onupgradeneeded = () => req.result.createObjectStore("states");
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        const value = await new Promise((resolve, reject) => {
            const tx = db.transaction("states", "readonly");
            const req = tx.objectStore("states").get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        db.close();
        return value;
    }

    async function idbKeys() {
        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open("desmume-web-debugger", 1);
            req.onupgradeneeded = () => req.result.createObjectStore("states");
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        const keys = await new Promise((resolve, reject) => {
            const tx = db.transaction("states", "readonly");
            const req = tx.objectStore("states").getAllKeys();
            req.onsuccess = () => resolve(req.result.map(String));
            req.onerror = () => reject(req.error);
        });
        db.close();
        return keys;
    }

    async function idbDeleteMany(keys) {
        const normalizedKeys = [...new Set(
            (Array.isArray(keys) ? keys : [keys])
                .filter((key) => key !== undefined && key !== null)
                .map(String)
        )];
        if (!normalizedKeys.length) return;
        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open("desmume-web-debugger", 1);
            req.onupgradeneeded = () => req.result.createObjectStore("states");
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        await new Promise((resolve, reject) => {
            const tx = db.transaction("states", "readwrite");
            const store = tx.objectStore("states");
            for (const key of normalizedKeys) store.delete(key);
            tx.oncomplete = resolve;
            tx.onabort = () => reject(tx.error);
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    }

    async function idbDelete(key) {
        return idbDeleteMany([key]);
    }

    return {
        stripDisassemblyBytesLine,
        formatDisassemblyText,
        shouldIncludeDisassemblyBytes,
        instructionBody,
        armConditionSuffix,
        mnemonicMatches,
        isBranchLinkMnemonic,
        isBranchLinkExchangeMnemonic,
        classifyInstruction,
        getCurrentInstructionInfo,
        registerHexSnapshot,
        stepStatusSummary,
        emulatorActivity,
        analysisBaselineKey,
        isAnalysisBaselineSlot,
        currentRomIdentity,
        sha256Hex,
        readAnalysisBaseline,
        writeAnalysisBaseline,
        snapshotContext,
        attachDebuggerContext,
        runDebuggerInstruction,
        runUntilNextBranchOrReturn,
        runUntilTrueNextBranch,
        renderDisassembly,
        renderCallStack,
        renderCallStackLanes,
        refreshDebuggerViews,
        queueBreakpointRefresh,
        stopAutoUpdateLoop,
        queueAutoUpdateLoop,
        runTraceStepper,
        renderMemoryDump,
        modeNumber,
        instructionWidthForMode,
        readSized,
        matchSearchCondition,
        idbPut,
        idbGet,
        idbKeys,
        idbDelete,
        idbDeleteMany
    };
}
