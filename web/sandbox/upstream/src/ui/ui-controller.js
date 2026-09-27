export function bindScreenTouch({ screenShell, state, updateTouch, setTouchState }) {
    const releaseTouch = () => setTouchState(false, 0, 0);
    screenShell.addEventListener("pointerdown", (event) => {
        screenShell.setPointerCapture(event.pointerId);
        updateTouch(event, true);
    });
    screenShell.addEventListener("pointermove", (event) => {
        if (state.touch.active) updateTouch(event, true);
    });
    screenShell.addEventListener("pointerup", releaseTouch);
    screenShell.addEventListener("pointercancel", releaseTouch);
    screenShell.addEventListener("lostpointercapture", releaseTouch);
    screenShell.addEventListener("pointerleave", releaseTouch);
}

export function bindUi(context) {
    const {
        copyText,
        disasmRefreshParams,
        hasLoadedRom,
        isTypingTarget,
        loadKeymap,
        log,
        normalizeKeyboardCode,
        parseAddress,
        parseNumber,
        queueAutoUpdateLoop,
        readCallStackData,
        readFileFromInput,
        refreshDebuggerViews,
        releaseAllKeys,
        rememberSlot,
        renderBreakpoints,
        renderCallStack,
        renderDisassembly,
        renderFreezes,
        renderHotkey,
        renderMemoryDump,
        renderRecentFiles,
        renderRegisters,
        renderScripts,
        renderStateSlotOptions,
        runCommand,
        selectScript,
        setFollowPc,
        setKey,
        setTouchState,
        state,
        ui,
        updateStatus,
        updateTouch
    } = context;

    const runTraceCommand = (name, params = {}) => runCommand(name, params).then((result) => {
        if (result?.ok === false) {
            log(result.error?.message || `${name} failed`);
        } else if (result?.complete === false) {
            const detail = result.steps == null ? "" : ` after ${result.steps} steps`;
            log(`${name} stopped: ${result.stop || (result.stoppedByBreakpoint ? "breakpoint" : "incomplete")}${detail}`);
        }
        return result;
    });

    ui.romFile.closest("label").addEventListener("click", () => {});
    ui.saveExportBtn.addEventListener("click", () => runCommand("exportSaveFile").catch((e) => log(e.message)));
    ui.stateExportBtn.addEventListener("click", () => runCommand("exportStateFile").catch((e) => log(e.message)));
    ui.romFile.addEventListener("change", () => runCommand("loadRomFile").catch((e) => log(e.message)));
    ui.saveFile.addEventListener("change", () => runCommand("importSaveFile").catch((e) => log(e.message)));
    ui.stateFile.addEventListener("change", () => runCommand("importStateFile").catch((e) => log(e.message)));
    ui.pauseBtn.addEventListener("click", () => runCommand("pause").catch((e) => log(e.message)));
    ui.resumeBtn.addEventListener("click", () => runCommand("resume").catch((e) => log(e.message)));
    ui.resetBtn.addEventListener("click", () => runCommand("reset").catch((e) => log(e.message)));
    ui.romReloadBtn.addEventListener("click", () => runCommand("reloadRom", { waitMs: Number(ui.romWaitMs.value), resume: !ui.resetHoldToggle.checked }).catch((e) => log(e.message)));
    ui.stepFrameBtn.addEventListener("click", () => runCommand("stepFrames", { frames: 1 }).catch((e) => log(e.message)));
    ui.stepNBtn.addEventListener("click", () => runCommand("stepFrames", { frames: Number(ui.framesInput.value) }).catch((e) => log(e.message)));
    ui.speedSelect.addEventListener("change", () => runCommand("setSpeed", { speed: Number(ui.speedSelect.value) }).catch((e) => log(e.message)));
    ui.scaleSelect.addEventListener("change", () => runCommand("setScale", { scale: Number(ui.scaleSelect.value) }).catch((e) => log(e.message)));
    ui.rotationSelect.addEventListener("change", () => runCommand("setRotation", { rotation: Number(ui.rotationSelect.value) }).catch((e) => log(e.message)));
    ui.renderToggle.addEventListener("change", () => runCommand("setRenderEnabled", { enabled: ui.renderToggle.checked }).catch((e) => log(e.message)));
    ui.audioToggle.addEventListener("change", () => runCommand("setAudio", { enabled: ui.audioToggle.checked, volume: Number(ui.volumeRange.value) }).catch((e) => log(e.message)));
    ui.cpuSelect.addEventListener("change", () => { state.selectedCpu = ui.cpuSelect.value; renderRegisters(); updateStatus(); });
    ui.refreshTopBtn.addEventListener("click", () => refreshDebuggerViews({ keepHighlight: true }).catch((e) => log(e.message)));
    ui.refreshDebugBtn.addEventListener("click", () => refreshDebuggerViews({ keepHighlight: true }).catch((e) => log(e.message)));
    ui.refreshBreakpointsBtn.addEventListener("click", () => refreshDebuggerViews({ keepHighlight: true }).catch((e) => log(e.message)));
    ui.nearPcBtn.addEventListener("click", () => {
        setFollowPc(true);
        state.highlightedDisasmAddress = null;
        state.highlightedCallstackAddress = null;
        state.highlightedCallstackCpsr = null;
        refreshDebuggerViews({ address: "pc", keepHighlight: true }).catch((e) => log(e.message));
    });
    ui.cpuStepBtn.addEventListener("click", () => runCommand("step", { count: 1 }).catch((e) => log(e.message)));
    ui.cpuSmartStepBtn.addEventListener("click", () => runCommand("smartStep").catch((e) => log(e.message)));
    ui.cpuStepOverBtn.addEventListener("click", () => runTraceCommand("stepOver").catch((e) => log(e.message)));
    ui.cpuNextBranchReturnBtn.addEventListener("click", () => runCommand("stepNextBranchOrReturn", { timeoutMs: 1000 }).catch((e) => log(e.message)));
    ui.cpuTrueNextBranchBtn.addEventListener("click", () => runCommand("trueNextBranch", { timeoutMs: 1000 }).catch((e) => log(e.message)));
    ui.cpuStepDebugBtn.addEventListener("click", () => runCommand("step", { count: 1 }).catch((e) => log(e.message)));
    ui.cpuSmartStepDebugBtn.addEventListener("click", () => runCommand("smartStep").catch((e) => log(e.message)));
    ui.cpuStepOverDebugBtn.addEventListener("click", () => runTraceCommand("stepOver").catch((e) => log(e.message)));
    ui.cpuNextBranchReturnDebugBtn.addEventListener("click", () => runCommand("stepNextBranchOrReturn", { timeoutMs: 1000 }).catch((e) => log(e.message)));
    ui.cpuTrueNextBranchDebugBtn.addEventListener("click", () => runCommand("trueNextBranch", { timeoutMs: 1000 }).catch((e) => log(e.message)));
    ui.stackNextCallBtn.addEventListener("click", () => runTraceCommand("nextCall", { timeoutMs: 1000 }).catch((e) => log(e.message)));
    ui.stackReturnBtn.addEventListener("click", () => runTraceCommand("returnToPop", { timeoutMs: 1000 }).catch((e) => log(e.message)));
    ui.stackNextCallToolbarBtn.addEventListener("click", () => runTraceCommand("nextCall", { timeoutMs: 1000 }).catch((e) => log(e.message)));
    ui.stackNextCallThisDepthToolbarBtn.addEventListener("click", () => runTraceCommand("nextCallThisDepth", { timeoutMs: 1000 }).catch((e) => log(e.message)));
    ui.stackReturnToolbarBtn.addEventListener("click", () => runTraceCommand("returnToPop", { timeoutMs: 1000 }).catch((e) => log(e.message)));
    ui.stackNextCallDebugBtn.addEventListener("click", () => runTraceCommand("nextCall", { timeoutMs: 1000 }).catch((e) => log(e.message)));
    ui.stackNextCallThisDepthDebugBtn.addEventListener("click", () => runTraceCommand("nextCallThisDepth", { timeoutMs: 1000 }).catch((e) => log(e.message)));
    ui.stackReturnDebugBtn.addEventListener("click", () => runTraceCommand("returnToPop", { timeoutMs: 1000 }).catch((e) => log(e.message)));
    ui.stackClearBtn.addEventListener("click", () => runCommand("setStackTraceMode", { enabled: false }).then(() => runCommand("setStackTraceMode", { enabled: true })).catch((e) => log(e.message)));
    ui.stackCopyMdBtn.addEventListener("click", () => runCommand("copyCallStackMarkdown").catch((e) => log(e.message)));
    ui.stackCopyCsvBtn.addEventListener("click", () => runCommand("copyCallStackCsv").catch((e) => log(e.message)));
    ui.callstackLaneTabs.addEventListener("click", (e) => {
        const button = e.target.closest("[data-lane-id]");
        if (!button) return;
        state.selectedCallstackLaneId = Number(button.dataset.laneId);
        renderCallStack(readCallStackData());
    });
    ui.callstackBody.addEventListener("click", (e) => {
        const button = e.target.closest("button[data-jump-address]");
        if (!button) return;
        setFollowPc(false);
        ui.disasmAddress.value = button.dataset.jumpAddress;
        state.highlightedDisasmAddress = parseAddress(button.dataset.jumpAddress, 0, state.selectedCpu);
        state.highlightedCallstackAddress = state.highlightedDisasmAddress;
        state.highlightedCallstackCpsr = parseNumber(button.dataset.jumpCpsr, null);
        runCommand("disassemble", disasmRefreshParams({ address: button.dataset.jumpAddress, keepHighlight: true })).then((r) => renderDisassembly(r.text)).then(() => renderCallStack(readCallStackData())).catch((error) => log(error.message));
    });
    ui.disasmAddress.addEventListener("change", () => {
        const followsPc = String(ui.disasmAddress.value).trim().toLowerCase() === "pc";
        setFollowPc(followsPc);
        state.highlightedDisasmAddress = followsPc ? null : parseAddress(ui.disasmAddress.value, 0, state.selectedCpu);
        state.highlightedCallstackAddress = null;
        state.highlightedCallstackCpsr = null;
    });
    ui.disasmCount.addEventListener("change", () => { if (state.autoUpdate.enabled) queueAutoUpdateLoop(); });
    ui.disasmBefore.addEventListener("change", () => { if (state.autoUpdate.enabled) queueAutoUpdateLoop(); });
    ui.disasmMode.addEventListener("change", () => { if (state.autoUpdate.enabled) queueAutoUpdateLoop(); });
    ui.disasmBytes.addEventListener("change", () => { if (hasLoadedRom()) refreshDebuggerViews({ keepHighlight: true }).catch((e) => log(e.message)); });
    ui.autoUpdateToggle.addEventListener("change", () => runCommand("setAutoUpdate", { enabled: ui.autoUpdateToggle.checked, hz: Number(ui.autoUpdateRate.value) }).catch((e) => log(e.message)));
    ui.autoUpdateRate.addEventListener("change", () => runCommand("setAutoUpdate", { enabled: ui.autoUpdateToggle.checked, hz: Number(ui.autoUpdateRate.value) }).catch((e) => log(e.message)));
    ui.memoryView.addEventListener("change", () => { if (state.ready && hasLoadedRom()) runCommand("dumpMemory", {}).then(renderMemoryDump).catch((e) => log(e.message)); });
    ui.traceToggle.addEventListener("change", () => runCommand("setStackTraceMode", { enabled: ui.traceToggle.checked }).catch((e) => log(e.message)));
    ui.tracePrivilegeToggle.addEventListener("change", () => runCommand("setStackTracePrivilegeCheck", { enabled: ui.tracePrivilegeToggle.checked }).catch((e) => log(e.message)));
    ui.memoryDumpBtn.addEventListener("click", () => runCommand("dumpMemory", {}).then(renderMemoryDump).catch((e) => log(e.message)));
    ui.memoryOutput.addEventListener("click", (e) => {
        const cell = e.target.closest(".memory-byte");
        if (!cell || cell.querySelector("input")) return;
        const input = document.createElement("input");
        input.className = "memory-editor mono";
        input.value = cell.dataset.memoryValue;
        cell.textContent = "";
        cell.append(input);
        input.focus();
        input.select();
        let committed = false;
        const commit = () => {
            if (committed) return;
            committed = true;
            return runCommand("writeMemory", { address: cell.dataset.memoryAddress, value: `0x${input.value}`, size: 1 })
                .then(() => runCommand("dumpMemory", {}).then(renderMemoryDump))
                .catch((error) => log(error.message));
        };
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
                committed = true;
                runCommand("dumpMemory", {}).then(renderMemoryDump).catch((error) => log(error.message));
            }
        });
        input.addEventListener("blur", commit, { once: true });
    });
    ui.searchNewBtn.addEventListener("click", () => runCommand("searchMemory", { refine: false }).then((r) => ui.searchOutput.textContent = r.text).catch((e) => log(e.message)));
    ui.searchRefineBtn.addEventListener("click", () => runCommand("searchMemory", { refine: true }).then((r) => ui.searchOutput.textContent = r.text).catch((e) => log(e.message)));
    ui.searchResetBtn.addEventListener("click", () => runCommand("resetMemorySearch").catch((e) => log(e.message)));
    ui.memoryWriteBtn.addEventListener("click", () => runCommand("writeMemory", { address: ui.memoryAddress.value, value: ui.memoryWriteValue.value, size: Number(ui.memoryWriteSize.value) }).then(() => runCommand("dumpMemory", {}).then(renderMemoryDump)).catch((e) => log(e.message)));
    ui.memoryInjectBtn.addEventListener("click", () => runCommand("injectMemoryFile", { address: ui.memoryAddress.value }).catch((e) => log(e.message)));
    ui.freezeAddBtn.addEventListener("click", () => runCommand("setMemoryFreeze", { address: ui.freezeAddress.value, value: ui.freezeValue.value, size: Number(ui.freezeSize.value), enabled: true }).catch((e) => log(e.message)));
    ui.freezeRemoveBtn.addEventListener("click", () => runCommand("setMemoryFreeze", { address: ui.freezeAddress.value, size: Number(ui.freezeSize.value), enabled: false }).catch((e) => log(e.message)));
    ui.bpAddBtn.addEventListener("click", () => runCommand("setBreakpoint", { address: ui.bpAddress.value, type: ui.bpType.value, enabled: true }).catch((e) => log(e.message)));
    ui.bpRemoveBtn.addEventListener("click", () => runCommand("setBreakpoint", { address: ui.bpAddress.value, type: ui.bpType.value, enabled: false }).catch((e) => log(e.message)));
    ui.bpRemoveIdBtn.addEventListener("click", () => runCommand("removeBreakpoint", { id: Number(ui.bpIdSelect.value) }).catch((e) => log(e.message)));
    ui.bpDataAbortToggle.addEventListener("change", () => runCommand("setSpecialBreakpoint", { kind: "dataAbort", enabled: ui.bpDataAbortToggle.checked }).catch((e) => log(e.message)));
    ui.bpPrefetchAbortToggle.addEventListener("change", () => runCommand("setSpecialBreakpoint", { kind: "prefetchAbort", enabled: ui.bpPrefetchAbortToggle.checked }).catch((e) => log(e.message)));
    ui.bpUndefinedToggle.addEventListener("change", () => runCommand("setSpecialBreakpoint", { kind: "undefinedInstruction", enabled: ui.bpUndefinedToggle.checked }).catch((e) => log(e.message)));
    ui.stateSaveBtn.addEventListener("click", () => runCommand("saveState", { slot: ui.stateSlot.value }).catch((e) => log(e.message)));
    ui.stateLoadBtn.addEventListener("click", () => runCommand("loadState", { slot: ui.stateSlot.value }).catch((e) => log(e.message)));
    ui.saveSlotSaveBtn.addEventListener("click", () => runCommand("saveSaveSlot", { slot: ui.stateSlot.value }).catch((e) => log(e.message)));
    ui.saveSlotLoadBtn.addEventListener("click", () => runCommand("loadSaveSlot", { slot: ui.stateSlot.value }).catch((e) => log(e.message)));
    ui.stateSlot.addEventListener("change", () => rememberSlot(ui.stateSlot.value));
    ui.stateSlotSelect.addEventListener("change", () => { ui.stateSlot.value = ui.stateSlotSelect.value; rememberSlot(ui.stateSlot.value); });
    ui.recentReloadBtn.addEventListener("click", () => runCommand("reloadRecentFile", { id: ui.recentFileSelect.value }).catch((e) => log(e.message)));
    ui.hotkeyButton.addEventListener("change", renderHotkey);
    ui.hotkeyRefreshBtn.addEventListener("click", renderHotkey);
    ui.hotkeySetBtn.addEventListener("click", () => runCommand("setKeyBinding", { button: ui.hotkeyButton.value, key: ui.hotkeyCode.value }).catch((e) => log(e.message)));
    ui.hotkeyCode.addEventListener("focus", () => {
        ui.hotkeyCode.value = "Press a key";
        ui.hotkeyCode.select();
    });
    ui.hotkeyCode.addEventListener("blur", renderHotkey);
    ui.hotkeyCode.addEventListener("keydown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const key = normalizeKeyboardCode(event);
        if (!key) {
            renderHotkey();
            return;
        }
        ui.hotkeyCode.value = key;
        runCommand("setKeyBinding", { button: ui.hotkeyButton.value, key })
            .then(() => {
                ui.hotkeyCode.blur();
                log(`Hotkey saved: ${ui.hotkeyButton.value} = ${key}`);
            })
            .catch((error) => {
                log(error.message);
                renderHotkey();
            });
    });
    ui.canvasShotBtn.addEventListener("click", () => runCommand("takeScreenshot", {}).catch((e) => log(e.message)));
    ui.registers.querySelectorAll("input[data-register-input]").forEach((input) => {
        const row = input.closest("div[data-register]");
        const register = input.dataset.registerInput;
        let initialValue = input.value;
        input.addEventListener("focus", () => {
            row.classList.add("editing");
            initialValue = input.value;
            input.select();
        });
        const commit = () => {
            row.classList.remove("editing");
            const value = input.value.trim();
            if (!hasLoadedRom() || !value || value === initialValue) {
                renderRegisters();
                return;
            }
            runCommand("setRegister", { register, value, cpu: state.selectedCpu })
                .catch((error) => {
                    log(error.message);
                    renderRegisters();
                });
        };
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") input.blur();
            if (event.key === "Escape") {
                input.value = initialValue;
                input.blur();
            }
        });
        input.addEventListener("blur", commit);
    });
    ui.mcpRunBtn.addEventListener("click", () => {
        let params = {};
        try { params = JSON.parse(ui.mcpParams.value || "{}"); } catch (e) { console.error(e); ui.mcpOutput.textContent = e.message; return; }
        runCommand(ui.mcpCommand.value, params).then((r) => ui.mcpOutput.textContent = JSON.stringify(r, null, 2)).catch((e) => ui.mcpOutput.textContent = e.message);
    });
    ui.mcpBatchRunBtn.addEventListener("click", () => {
        let items = [];
        try { items = JSON.parse(ui.mcpBatch.value || "[]"); } catch (e) { console.error(e); ui.mcpOutput.textContent = e.message; return; }
        runCommand("batch", {
            commands: Array.isArray(items) ? items : items.commands || []
        }).then((r) => ui.mcpOutput.textContent = JSON.stringify(r, null, 2)).catch((e) => ui.mcpOutput.textContent = e.message);
    });
    ui.scriptRunBtn.addEventListener("click", () => {
        const params = { asyncMode: ui.scriptAsyncMode.checked };
        const name = ui.scriptName.value.trim();
        if (name) params.name = name;
        runCommand("runLoadedPersistentScript", params).then((result) => {
            ui.scriptName.value = result.name;
            try { localStorage.setItem("desmume-script-draft", JSON.stringify({ name: result.name, code: ui.scriptCode.value })); } catch {}
            selectScript(result.id);
        }).catch((e) => { ui.scriptRawOutput.value = e.message; ui.scriptOutput.textContent = e.message; });
    });
    ui.scriptStopBtn.addEventListener("click", () => runCommand("stopScript", {}).catch((e) => log(e.message)));
    ui.scriptRestartBtn.addEventListener("click", () => runCommand("restartScript", {}).then((result) => {
        ui.scriptName.value = result.name;
        selectScript(result.id);
    }).catch((e) => log(e.message)));
    ui.scriptClearOutputBtn.addEventListener("click", () => runCommand("clearScriptPrint", {}).catch((e) => log(e.message)));
    ui.scriptFile.addEventListener("change", () => readFileFromInput(ui.scriptFile).then(({ file, bytes }) => {
        ui.scriptCode.value = new TextDecoder().decode(bytes);
        ui.scriptName.value = file.name.replace(/\.[^.]+$/, "") || "script";
        try { localStorage.setItem("desmume-script-draft", JSON.stringify({ name: ui.scriptName.value, code: ui.scriptCode.value })); } catch {}
    }).catch((e) => log(e.message)));
    ui.scriptCode.addEventListener("input", () => { try { localStorage.setItem("desmume-script-draft", JSON.stringify({ name: ui.scriptName.value, code: ui.scriptCode.value })); } catch {} });
    ui.scriptName.addEventListener("input", () => { try { localStorage.setItem("desmume-script-draft", JSON.stringify({ name: ui.scriptName.value, code: ui.scriptCode.value })); } catch {} });
    ui.scriptCopyRawBtn.addEventListener("click", () => copyText(ui.scriptRawOutput.value, "script raw output").catch((e) => log(e.message)));
    ui.scriptSelectRawBtn.addEventListener("click", () => {
        ui.scriptRawOutput.focus();
        ui.scriptRawOutput.select();
    });
    
    ui.pad.addEventListener("pointerdown", (e) => { if (e.target.dataset.button) setKey(e.target.dataset.button, true); });
    ui.pad.addEventListener("pointerup", (e) => { if (e.target.dataset.button) setKey(e.target.dataset.button, false); });
    ui.pad.addEventListener("pointerleave", () => Object.keys(state.buttons).forEach((button) => setKey(button, false)));
    window.addEventListener("focusin", () => { if (isTypingTarget()) releaseAllKeys(); });
    window.addEventListener("keydown", (e) => { if (isTypingTarget(e.target)) return; const code = normalizeKeyboardCode(e); if (state.keymap[code]) { e.preventDefault(); setKey(state.keymap[code], true); } });
    window.addEventListener("keyup", (e) => { if (isTypingTarget(e.target)) return; const code = normalizeKeyboardCode(e); if (state.keymap[code]) { e.preventDefault(); setKey(state.keymap[code], false); } });
    bindScreenTouch({ screenShell: ui.screenShell, state, updateTouch, setTouchState });
    ui.volumeRange.addEventListener("input", () => { if (state.audioContext) state.audioNextTime = state.audioContext.currentTime; });
    
    const maintenanceFailures = new Set();
    const reportMaintenanceFailure = (kind, error) => {
        if (maintenanceFailures.has(kind)) return;
        maintenanceFailures.add(kind);
        log(`${kind} background task failed: ${String(error?.message || error)}`);
    };
    const maintenanceTimer = setInterval(() => {
        if (state.ready && ui.memoryAuto.value === "1") runCommand("dumpMemory", {}).then(renderMemoryDump).catch(() => {});
        if (state.ready) {
            runCommand("applyMemoryFreezes", {}).then(() => maintenanceFailures.delete("freeze")).catch((error) => {
                reportMaintenanceFailure("freeze", error);
            });
        }
        if (state.ready && state.running && !state.loadingFile && performance.now() >= state.saveFlushBlockedUntil && performance.now() - state.lastSaveFlush > 5000) {
            state.lastSaveFlush = performance.now();
            runCommand("saveSaveSlot", { slot: ui.stateSlot.value }).then(() => maintenanceFailures.delete("save")).catch((error) => {
                reportMaintenanceFailure("save", error);
            });
        }
    }, 750);
    
    try {
        const storedSlots = JSON.parse(localStorage.getItem("desmume-known-slots") || "[]");
        if (Array.isArray(storedSlots) && storedSlots.length) state.knownSlots = [...new Set([...storedSlots.map((slot) => String(slot)), ...state.knownSlots])].slice(0, 24);
    } catch {}
    try {
        const draft = JSON.parse(localStorage.getItem("desmume-script-draft") || "null");
        if (draft && typeof draft === "object") {
            if (typeof draft.name === "string") ui.scriptName.value = draft.name;
            if (typeof draft.code === "string") ui.scriptCode.value = draft.code;
        }
    } catch {}
    loadKeymap();
    ui.readyText.textContent = "ROM待ち";
    renderBreakpoints();
    renderFreezes();
    renderRecentFiles();
    renderScripts();
    renderStateSlotOptions(ui.stateSlot.value);
    renderHotkey();
    updateStatus();
    return Object.freeze({ dispose: () => clearInterval(maintenanceTimer) });
}
