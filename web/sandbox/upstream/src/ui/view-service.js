import { positiveInteger } from "../validation.js";
import { compactOutputText, flattenObject } from "../compact-output.js";

export function createViewService({
    state,
    ui,
    getRegisters,
    hasLoadedRom,
    native,
    parseAddress,
    getIdbPut
}) {
    const idbPut = (...args) => getIdbPut()(...args);

    function log(message) {
        const line = `[${new Date().toLocaleTimeString()}] ${message}\n`;
        ui.logOutput.textContent = (line + ui.logOutput.textContent).slice(0, 12000);
    }

    function disasmRefreshParams(overrides = {}) {
        const usePc = overrides.address === "pc"
            || (overrides.address == null && state.followPc);
        return {
            cpu: overrides.cpu ?? state.selectedCpu,
            address: usePc ? "pc" : (overrides.address ?? ui.disasmAddress.value),
            before: Number(overrides.before ?? ui.disasmBefore.value),
            count: Number(overrides.count ?? ui.disasmCount.value),
            mode: overrides.mode ?? ui.disasmMode.value,
            keepHighlight: overrides.keepHighlight
        };
    }

    function setFollowPc(enabled) {
        state.followPc = !!enabled;
        if (state.followPc) ui.disasmAddress.value = "pc";
    }
    
    function hex(value, width = 8) {
        const n = Number(value) >>> 0;
        return "0x" + n.toString(16).padStart(width, "0");
    }
    
    function cpsrModeInfo(cpsr) {
        const value = Number(cpsr) >>> 0;
        const mode = value & 0x1f;
        const modes = {
            0x10: { key: "usr", label: "User", className: "" },
            0x11: { key: "fiq", label: "FIQ", className: "mode-fiq" },
            0x12: { key: "irq", label: "IRQ", className: "mode-irq" },
            0x13: { key: "svc", label: "Supervisor", className: "mode-svc" },
            0x17: { key: "abt", label: "Abort", className: "mode-abt" },
            0x1b: { key: "und", label: "Undefined", className: "mode-und" },
            0x1f: { key: "sys", label: "System", className: "" }
        };
        return modes[mode] || { key: `0x${mode.toString(16)}`, label: `Mode 0x${mode.toString(16)}`, className: "mode-svc" };
    }
    
    function normalizeCallStackData(data) {
        const frames = data && Array.isArray(data.frames) ? data.frames : [];
        const rawStacks = data && Array.isArray(data.stacks) ? data.stacks : [];
        const controlFlow = data && Array.isArray(data.controlFlow) ? data.controlFlow : [];
        const controlFlowKinds = {
            1: "bx",
            2: "mov-pc",
            3: "movs-pc",
            4: "subs-pc",
            5: "ldm-pc",
            6: "ldm-pc-spsr",
            7: "blx-reg",
            8: "irq-entry",
            9: "irq-return"
        };
        const normalizeFrames = (items) => items.map((frame, index) => {
            const cpsr = Number(frame.cpsr) >>> 0;
            const mode = cpsrModeInfo(cpsr);
            const hasReturnAddress = frame.returnAddress != null;
            const returnAddress = Number(hasReturnAddress ? frame.returnAddress : frame.caller) >>> 0;
            const caller = hasReturnAddress ? (Number(frame.caller) >>> 0) : (((returnAddress & ~1) - 4) >>> 0);
            const depthFromNewest = index;
            const kind = Number(frame.kind);
            return {
                ...frame,
                caller,
                returnAddress,
                depthFromNewest,
                ageLabel: depthFromNewest === 0 ? "newest" : `↑+${depthFromNewest}d`,
                cpsr,
                cpsrHex: hex(cpsr),
                modeValue: cpsr & 0x1f,
                modeKey: mode.key,
                modeName: mode.label,
                modeClass: mode.className,
                kindName: controlFlowKinds[kind] || (Number.isFinite(kind) ? `kind-${kind}` : "")
            };
        });
        const stacks = rawStacks.length ? rawStacks.map((stack) => ({
            ...stack,
            id: Number(stack.id),
            depth: Number(stack.depth) || 0,
            sp: Number(stack.sp) >>> 0,
            spHex: hex(Number(stack.sp) >>> 0),
            nowPc: Number(stack.nowPc) >>> 0,
            nowPcHex: hex(Number(stack.nowPc) >>> 0),
            frames: normalizeFrames(Array.isArray(stack.frames) ? stack.frames : [])
        })) : (frames.length ? [{ id: Number(data?.activeStackId ?? 1), active: true, depth: Number(data?.depth ?? frames.length) || 0, sp: 0, spHex: hex(0), frames: normalizeFrames(frames) }] : []);
        const activeStackId = Number(data?.activeStackId ?? stacks.find((stack) => stack.active)?.id ?? stacks[0]?.id ?? 1);
        return {
            ...(data || {}),
            activeStackId,
            stacks,
            frames: normalizeFrames(frames),
            controlFlow: controlFlow.map((event) => {
                const cpsr = Number(event.cpsr) >>> 0;
                const mode = cpsrModeInfo(cpsr);
                const kind = Number(event.kind);
                return { ...event, cpsr, cpsrHex: hex(cpsr), modeValue: cpsr & 0x1f, modeKey: mode.key, modeName: mode.label, modeClass: mode.className, kindName: controlFlowKinds[kind] || `kind-${kind}` };
            })
        };
    }
    
    function callStackLimit(params = {}) {
        const raw = Number(params.limit ?? 128);
        return Math.max(1, Math.min(1024, Number.isFinite(raw) ? Math.trunc(raw) : 128));
    }

    function modeNumber(mode) {
        const normalized = String(mode || "").toLowerCase();
        if (normalized === "thumb") return 1;
        if (normalized === "arm") return 2;
        return 0;
    }
    
    function readCallStackData(params = {}) {
        const limit = callStackLimit(params);
        return {
            ...normalizeCallStackData(native.getCallStack(limit)),
            synchronized: state.traceStateSynchronized !== false
        };
    }
    
    function disassemblyRows(cpu, address, options = {}) {
        const addr = Number(address) >>> 0;
        const mode = options.mode || (((Number(options.cpsr) >>> 0) & 0x20) ? "thumb" : "arm");
        const count = Math.max(1, Math.min(3, Number(options.count ?? 3)));
        return native.disassemble(cpu, addr, count, modeNumber(mode))
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
    }
    
    function publicCallStackFrame(frame, cpu = state.selectedCpu) {
        return {
            ageLabel: frame.ageLabel,
            caller: hex(frame.caller),
            returnAddress: hex(frame.returnAddress),
            callee: hex(frame.callee),
            sp: hex(frame.sp),
            cpsr: frame.cpsrHex,
            cpuMode: frame.modeName,
            isa: frame.thumb ? "thumb" : "arm",
            id: frame.id,
            callerDisassembly: disassemblyRows(cpu, frame.caller, { cpsr: frame.cpsr }),
            calleeDisassembly: disassemblyRows(cpu, frame.callee, { cpsr: frame.cpsr })
        };
    }

    function publicUiCallStackFrame(frame, cpu = state.selectedCpu) {
        if (!frame.synthetic) return publicCallStackFrame(frame, cpu);
        return {
            ageLabel: frame.ageLabel,
            caller: hex(frame.caller),
            callee: `${hex(frame.callee)} ${frame.kindName}`,
            sp: hex(frame.sp),
            cpsr: frame.cpsrHex,
            mode: `pc-write ${frame.kindName}`,
            cpuMode: frame.modeName
        };
    }
    
    function publicRealFrames(stack, cpu = state.selectedCpu) {
        return (Array.isArray(stack?.frames) ? stack.frames : [])
            .filter((frame) => !frame.synthetic)
            .map((frame) => publicCallStackFrame(frame, cpu));
    }
    
    function otherCoroutineCommand(cpu, stackId, limit) {
        const params = { cpu, stackId, limit };
        return {
            command: "getOtherCoroutines",
            params,
            webMcpCall: { command: "getOtherCoroutines", params },
            injectionSnippet: `return await mcp.call("getOtherCoroutines", ${JSON.stringify(params)});`
        };
    }
    
    function publicOtherCoroutineSummary(stack, data, params = {}) {
        const cpu = String(params.cpu ?? state.selectedCpu);
        const limit = callStackLimit(params);
        const frames = publicRealFrames(stack, cpu);
        return {
            id: stack.id,
            current: false,
            activeStackId: Number(data.activeStackId),
            sp: stack.spHex,
            nowPc: stack.nowPcHex,
            depth: frames.length,
            newestFrame: frames[0] || null,
            state: "これは現在のコルーチンではありません。",
            getOtherCoroutines: otherCoroutineCommand(cpu, stack.id, limit)
        };
    }
    
    function publicOtherCoroutines(data, params = {}) {
        const stackId = params.stackId == null ? null : Number(params.stackId);
        const stacks = Array.isArray(data.stacks) ? data.stacks : [];
        const activeStackId = Number(data.activeStackId);
        const others = stacks.filter((stack) => stack.id !== activeStackId && !stack.active);
        const selected = stackId == null ? others : others.filter((stack) => stack.id === stackId);
        const coroutines = selected.map((stack) => ({
            ...publicOtherCoroutineSummary(stack, data, params),
            frames: publicRealFrames(stack, String(params.cpu ?? state.selectedCpu))
        }));
        return {
            enabled: !!data.enabled,
            activeStackId,
            count: coroutines.length,
            coroutines,
            message: coroutines.length ? "" : "現在ではないコルーチンは記録されていません。"
        };
    }
    
    function publicCallStackData(data, params = {}) {
        if (params.raw) return data;
        const cpu = String(params.cpu ?? state.selectedCpu);
        const activeStackId = Number(data.activeStackId);
        const stacks = Array.isArray(data.stacks) ? data.stacks : [];
        const activeStack = stacks.find((stack) => stack.id === activeStackId) || stacks.find((stack) => stack.active) || stacks[0] || null;
        const activeFrames = (activeStack ? activeStack.frames : data.frames || [])
            .map((frame) => publicUiCallStackFrame(frame, cpu));
        return {
            enabled: !!data.enabled,
            synchronized: data.synchronized !== false,
            message: data.synchronized === false
                ? "Stateロード後のactive stackはCPU状態と同期していません。traceを再開するには一度Stack Traceをoff/onしてください。"
                : "",
            depth: activeFrames.length,
            activeStackId,
            frames: activeFrames,
            stacks: stacks.map((stack) => {
                const active = stack.id === activeStackId || !!stack.active;
                if (active) {
                    return { id: stack.id, active: true, sp: stack.spHex, nowPc: stack.nowPcHex, depth: stack.frames.length };
                }
                return {
                    id: stack.id,
                    active: false,
                    sp: stack.spHex,
                    nowPc: stack.nowPcHex,
                    depth: Number(stack.frames?.filter((frame) => !frame.synthetic).length ?? stack.depth ?? 0),
                    message: "これは現在のコルーチンではありません。",
                    howToShow: `listOtherCoroutines({ cpu: ${JSON.stringify(cpu)} }) で一覧を確認し、getOtherCoroutines({ cpu: ${JSON.stringify(cpu)}, stackId: ${stack.id} }) で詳細を取得します。`
                };
            })
        };
    }
    
    function defaultMemorySearchRanges(cpuName) {
        const common = [
            { name: "main", address: 0x02000000, length: 0x00400000 },
            { name: "shared-wram", address: 0x03000000, length: 0x00008000 },
            { name: "palette", address: 0x05000000, length: 0x00000800 },
            { name: "vram", address: 0x06000000, length: 0x000a4000 },
            { name: "oam", address: 0x07000000, length: 0x00000800 }
        ];
        if (String(cpuName || state.selectedCpu).toLowerCase() === "arm7") {
            return [...common, { name: "arm7-wram", address: 0x03800000, length: 0x00010000 }];
        }
        return common;
    }
    
    function memorySearchRanges(params = {}) {
        const rawAddress = params.address ?? ui.searchAddress.value;
        const full = params.all === true || params.full === true || String(rawAddress).trim().toLowerCase() === "all";
        if (full) return defaultMemorySearchRanges(params.cpu);
        const address = parseAddress(rawAddress, 0, params.cpu);
        const length = positiveInteger(
            params.length ?? ui.searchLength.value,
            "length",
            16 * 1024 * 1024
        );
        return [{ name: "custom", address, length }];
    }
    
    function memorySearchRangeKey(ranges) {
        return ranges.map((range) => `${range.name}:${range.address}:${range.length}`).join("|");
    }
    
    async function copyText(text, label) {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            log(`${label} copied`);
        } else {
            log(`${label} prepared; clipboard is unavailable in this context`);
        }
        return text;
    }
    
    const rawOutputText = compactOutputText;
    
    function plainScalarText(value) {
        if (value === null) return "null";
        if (value === undefined) return "";
        if (typeof value === "number") return Number.isInteger(value) && value >= 0x1000 ? hex(value) : String(value);
        if (typeof value === "boolean") return value ? "true" : "false";
        return String(value);
    }
    
    function isPlainScalar(value) {
        return value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value);
    }
    
    function plainRowText(row) {
        if (!row || typeof row !== "object" || Array.isArray(row)) return plainOutputText(row);
        return Object.entries(row).map(([key, value]) => `${key}=${plainOutputText(value, true)}`).join("  ");
    }
    
    function plainOutputText(value, inline = false) {
        if (isPlainScalar(value)) return plainScalarText(value);
        if (Array.isArray(value)) {
            if (!value.length) return inline ? "[]" : "(empty)";
            if (value.every((item) => isPlainScalar(item))) return value.map(plainScalarText).join(inline ? ", " : "\n");
            return value.map(plainRowText).join(inline ? " | " : "\n");
        }
        if (value && typeof value === "object") {
            const entries = Object.entries(value).filter(([, item]) => item !== undefined);
            if (!entries.length) return inline ? "{}" : "(empty)";
            if (inline) return entries.map(([key, item]) => `${key}=${plainOutputText(item, true)}`).join(", ");
            return entries.map(([key, item]) => `${key}: ${plainOutputText(item, true)}`).join("\n");
        }
        return String(value);
    }
    
    function setScriptOutput(result) {
        const raw = rawOutputText(result);
        ui.scriptRawOutput.value = raw;
        ui.scriptOutput.textContent = raw;
        return raw;
    }
    
    function createRecentId() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
        return `recent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    
    function normalizeKeyboardCode(event) {
        const code = String(event?.code || "");
        if (code && code !== "Unidentified") return code;
        const key = String(event?.key || "");
        const keyCode = Number(event?.keyCode ?? event?.which ?? 0);
        const right = event?.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT;
        if (key === "Shift" || keyCode === 16) return event?.location === KeyboardEvent.DOM_KEY_LOCATION_LEFT ? "ShiftLeft" : "ShiftRight";
        if (key === "Control" || keyCode === 17) return right ? "ControlRight" : "ControlLeft";
        if (key === "Alt" || keyCode === 18) return right ? "AltRight" : "AltLeft";
        if (key === "Meta" || keyCode === 91 || keyCode === 92) return right ? "MetaRight" : "MetaLeft";
        if (keyCode >= 65 && keyCode <= 90) return `Key${String.fromCharCode(keyCode)}`;
        if (keyCode >= 48 && keyCode <= 57) return `Digit${keyCode - 48}`;
        return code;
    }
    
    function saveKeymap() {
        try {
            localStorage.setItem("desmume-keymap", JSON.stringify(state.keymap));
        } catch {}
    }
    
    function loadKeymap() {
        try {
            const stored = JSON.parse(localStorage.getItem("desmume-keymap") || "{}");
            if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
            const next = {};
            for (const [code, button] of Object.entries(stored)) {
                if (typeof code === "string" && state.buttons[String(button)] !== undefined) next[code] = String(button);
            }
            let migrated = false;
            if (next.ShiftLeft === "Select" && !next.ShiftRight) {
                delete next.ShiftLeft;
                next.ShiftRight = "Select";
                migrated = true;
            }
            if (Object.keys(next).length) {
                state.keymap = next;
                if (migrated) saveKeymap();
            }
        } catch {}
    }
    
    function renderRegisters() {
        if (!hasLoadedRom()) {
            [...ui.registers.querySelectorAll("div")].forEach((row) => {
                row.classList.remove("changed");
                row.classList.remove("editing");
                row.querySelector("b").textContent = "--------";
                row.querySelector("input").value = "--------";
            });
            state.previousRegisters = null;
            return null;
        }
        const regs = getRegisters();
        [...ui.registers.querySelectorAll("div")].forEach((row) => {
            const name = row.querySelector("span").textContent;
            const changed = state.previousRegisters && state.previousRegisters[name] !== regs[name];
            const value = hex(regs[name] ?? 0);
            row.classList.toggle("changed", !!changed);
            row.querySelector("b").textContent = value;
            const input = row.querySelector("input");
            if (document.activeElement !== input) input.value = value;
        });
        state.previousRegisters = regs;
        return regs;
    }
    
    function renderBreakpoints() {
        ui.bpOutput.textContent = state.breakpoints.map((bp) => `#${bp.id} ${bp.cpu} ${bp.type} ${hex(bp.address)}`).join("\n") || "no breakpoints";
        const current = ui.bpIdSelect.value;
        ui.bpIdSelect.innerHTML = `<option value="">none</option>` + state.breakpoints.map((bp) => `<option value="${bp.id}">#${bp.id} ${bp.cpu} ${bp.type} ${hex(bp.address)}</option>`).join("");
        ui.bpIdSelect.value = state.breakpoints.some((bp) => String(bp.id) === current) ? current : "";
    }
    
    function renderFreezes() {
        ui.freezeOutput.textContent = state.freezes.map((item) => `${item.cpu} ${hex(item.address)} ${item.size === 4 ? "u32" : item.size === 2 ? "u16" : "u8"} = ${hex(item.value, item.size * 2)}`).join("\n") || "no freezes";
    }
    
    function renderRecentFiles() {
        const current = ui.recentFileSelect.value;
        ui.recentFileSelect.innerHTML = `<option value="">none</option>` + state.recentFiles.map((item) => {
            const label = item.slot ? `${item.kind} ${item.name} [${item.slot}]` : `${item.kind} ${item.name}`;
            return `<option value="${item.id}">${label.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</option>`;
        }).join("");
        ui.recentFileSelect.value = state.recentFiles.some((item) => String(item.id) === current) ? current : "";
    }
    
    function rememberSlot(slot) {
        const value = String(slot || "").trim();
        if (!value) return;
        state.knownSlots = [value, ...state.knownSlots.filter((item) => item !== value)].slice(0, 24);
        try {
            localStorage.setItem("desmume-known-slots", JSON.stringify(state.knownSlots));
        } catch {}
        renderStateSlotOptions(value);
    }
    
    function renderStateSlotOptions(selected = ui.stateSlot.value) {
        const options = [...new Set([String(selected || "").trim(), ...state.knownSlots].filter(Boolean))];
        if (!options.length) options.push("dq9-debug");
        state.knownSlots = options;
        ui.stateSlotSelect.innerHTML = options.map((slot) => {
            const safe = slot.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
            return `<option value="${safe}">${safe}</option>`;
        }).join("");
        ui.stateSlotSelect.value = options.includes(selected) ? selected : options[0];
        if (selected && ui.stateSlot.value !== selected) ui.stateSlot.value = selected;
    }
    
    async function recordRecentFile(kind, name, bytes = null, slot = "") {
        const existing = state.recentFiles.find((item) => item.kind === kind && item.name === name && item.slot === String(slot || ""));
        const id = existing?.id || createRecentId();
        const item = { id, kind, name, slot: String(slot || ""), size: bytes ? bytes.length : 0 };
        if (item.slot) rememberSlot(item.slot);
        if (bytes) {
            item.key = `recent:${kind}:${id}`;
            await idbPut(item.key, bytes);
        }
        state.recentFiles = [item, ...state.recentFiles.filter((x) => x.id !== id)].slice(0, 6);
        renderRecentFiles();
        return item;
    }
    
    function renderHotkey() {
        const button = ui.hotkeyButton.value;
        const code = Object.entries(state.keymap).find(([, mapped]) => mapped === button)?.[0] || "";
        ui.hotkeyCurrent.value = code;
        if (code) ui.hotkeyCode.value = code;
    }

    return {
        log,
        disasmRefreshParams,
        setFollowPc,
        hex,
        cpsrModeInfo,
        normalizeCallStackData,
        callStackLimit,
        readCallStackData,
        disassemblyRows,
        publicCallStackFrame,
        publicRealFrames,
        otherCoroutineCommand,
        publicOtherCoroutineSummary,
        publicOtherCoroutines,
        publicCallStackData,
        defaultMemorySearchRanges,
        memorySearchRanges,
        memorySearchRangeKey,
        copyText,
        rawOutputText,
        flattenObject,
        plainScalarText,
        isPlainScalar,
        plainRowText,
        plainOutputText,
        setScriptOutput,
        createRecentId,
        normalizeKeyboardCode,
        saveKeymap,
        loadKeymap,
        renderRegisters,
        renderBreakpoints,
        renderFreezes,
        renderRecentFiles,
        rememberSlot,
        renderStateSlotOptions,
        recordRecentFile,
        renderHotkey
    };
}
