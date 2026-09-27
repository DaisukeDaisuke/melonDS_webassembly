import { withInternalMetadata } from "../internal-command-metadata.js";
import { ErrorCode } from "../error-codes.js";
import { codedError, nonNegativeNumber } from "../validation.js";

let analysisBaselineTemporarySerial = 0;

export function createContextCommands(context) {
    const {
        ANALYSIS_BASELINE_SLOT_PREFIX,
        analysisBaselineSlotToken,
        call,
        currentRomIdentity,
        emulatorActivity,
        ensureRomLoaded,
        fileTransactionService = {
            run: async (reason, task) => task({ token: null })
        },
        getRegisters,
        hasLoadedRom,
        idbGet,
        idbKeys,
        idbDelete,
        idbPut,
        native,
        operationManager = () => null,
        readAnalysisBaseline,
        sha256Hex,
        snapshotContext,
        state,
        syncNativeBreakStatus,
        ui,
        writeAnalysisBaseline
    } = context;
    const analysisBaselineLocks = new Map();

    async function withAnalysisBaselineLock(name, task) {
        const previous = analysisBaselineLocks.get(name) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => {
            release = resolve;
        });
        analysisBaselineLocks.set(name, current);
        await previous.catch(() => {});
        try {
            return await task();
        } finally {
            release();
            if (analysisBaselineLocks.get(name) === current) {
                analysisBaselineLocks.delete(name);
            }
        }
    }

    const getOperationManager = () => typeof operationManager === "function"
        ? operationManager()
        : operationManager;

    return {
        async status(params = {}) {
            const waitMs = nonNegativeNumber(params.waitMs ?? params.ms ?? 0, "waitMs", 600000);
            if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
            const nativeStatus = state.ready ? native.getStatus() : null;
            if (nativeStatus) syncNativeBreakStatus(nativeStatus);
            return {
                ready: state.ready,
                emulatorLoaded: !!state.emulatorBundleLoaded,
                emulatorLoading: state.nativeInitState === "loading"
                    || state.nativeInitState === "initializing",
                emulatorLoadError: state.emulatorLoadError || null,
                paused: state.paused,
                running: state.running,
                loadingFile: state.loadingFile,
                fileTransaction: {
                    active: !!state.fileTransactionActive,
                    serial: Number(state.fileTransactionSerial || 0),
                    reason: String(state.fileTransactionReason || "")
                },
                stateLoadSerial: Number(state.stateLoadSerial || 0),
                operation: getOperationManager()?.current() || null,
                romLoaded: hasLoadedRom(),
                romSize: state.romSize,
                frame: state.frame,
                speed: state.speed,
                render: state.render,
                audio: state.audio,
                cpu: state.selectedCpu,
                breakpointPolicy: state.breakpointPolicy || "allow",
                recentFiles: state.recentFiles,
                autoUpdate: {
                    enabled: state.autoUpdate.enabled,
                    hz: state.autoUpdate.hz
                },
                native: nativeStatus
            };
        },

        async getOperation() {
            return {
                operation: getOperationManager()?.current() || null
            };
        },

        async cancelOperation() {
            const manager = getOperationManager();
            const operation = manager?.current() || null;
            if (!operation) return { ok: true, cancelled: false, operation: null };
            await manager.cancelAndWait("explicit-cancel");
            return { ok: true, cancelled: true, operation };
        },

        async listStateSlots() {
            const slots = (await idbKeys()).filter((key) => (
                !key.startsWith("save:")
                && !key.startsWith(ANALYSIS_BASELINE_SLOT_PREFIX)
                && !key.startsWith("input-recording:")
            ));
            return { slots };
        },

        async deleteStateSlot(params = {}) {
            const slot = String(params.slot || "");
            if (!slot || slot.startsWith("save:")
                || slot.startsWith(ANALYSIS_BASELINE_SLOT_PREFIX)
                || slot.startsWith("input-recording:")) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "a normal State slot is required");
            }
            await idbDelete(slot);
            return { ok: true, slot };
        },

        async listSaveSlots() {
            return {
                slots: (await idbKeys())
                    .filter((key) => key.startsWith("save:"))
                    .map((key) => key.slice(5))
            };
        },

        async deleteSaveSlot(params = {}) {
            const slot = String(params.slot || "");
            if (!slot) throw codedError(ErrorCode.INVALID_ARGUMENT, "slot is required");
            await idbDelete(`save:${slot}`);
            return { ok: true, slot };
        },

        async listAnalysisBaselines() {
            const baselines = [];
            for (let index = 0; index < localStorage.length; index++) {
                const key = localStorage.key(index);
                if (!key?.startsWith("analysis-baseline:")) continue;
                const name = key.slice("analysis-baseline:".length);
                const baseline = readAnalysisBaseline(name);
                if (baseline) baselines.push({
                    name,
                    savedAt: baseline.savedAt || null,
                    romName: baseline.romName || "",
                    stateSize: Number(baseline.stateSize || 0),
                    stateFormatVersion: Number(baseline.stateFormatVersion || 0),
                    pcVerified: !!baseline.cpuState
                });
            }
            return { baselines };
        },

        async deleteAnalysisBaseline(params = {}) {
            const name = String(params.name || "");
            if (!name) throw codedError(ErrorCode.INVALID_ARGUMENT, "name is required");
            return withAnalysisBaselineLock(name, async () => {
            const baseline = readAnalysisBaseline(name);
            if (!baseline) throw codedError(ErrorCode.STATE_NOT_LOADED, `analysis baseline not found: ${name}`);
            await idbDelete(String(baseline.slot || `${ANALYSIS_BASELINE_SLOT_PREFIX}${name}`));
            state.analysisBaselines.delete(name);
            localStorage.removeItem(`analysis-baseline:${name}`);
            return { ok: true, name };
            });
        },

        async snapshotContext(params = {}) {
            return snapshotContext(params);
        },

        async saveAnalysisBaseline(params = {}) {
            ensureRomLoaded("analysis baseline requires a loaded ROM");
            const name = String(params.name || "default");
            return withAnalysisBaselineLock(name, async () => {
            const existing = readAnalysisBaseline(name);
            if (existing && params.replace !== true) {
                throw codedError(
                    ErrorCode.INVALID_ARGUMENT,
                    `analysis baseline already exists: ${name}; pass replace:true to overwrite it`
                );
            }
            const slot = `${ANALYSIS_BASELINE_SLOT_PREFIX}${name}:temporary:${Date.now().toString(36)}-${++analysisBaselineTemporarySerial}`;
            const generation = state.romGeneration;
            const activity = emulatorActivity();
            const stateBytes = native.saveStateBytes();
            const cpuState = {
                arm9: {
                    pc: Number(getRegisters("arm9").pc) >>> 0,
                    cpsr: Number(getRegisters("arm9").cpsr) >>> 0
                },
                arm7: {
                    pc: Number(getRegisters("arm7").pc) >>> 0,
                    cpsr: Number(getRegisters("arm7").cpsr) >>> 0
                }
            };
            const identity = await currentRomIdentity();
            if (generation !== state.romGeneration) {
                throw codedError(ErrorCode.CANCELLED, "ROM changed while saving analysis baseline");
            }
            const stateSha256 = await sha256Hex(stateBytes);
            const baseline = {
                name,
                slot,
                ...identity,
                stateSize: stateBytes.length,
                stateSha256,
                cpuState,
                ...activity,
                skipIrq: !!ui.tracePrivilegeToggle.checked,
                traceEnabled: !!ui.traceToggle.checked,
                savedAt: new Date().toISOString()
            };
            let committed = false;
            try {
                await idbPut(slot, stateBytes);
                writeAnalysisBaseline(name, baseline);
                committed = true;
            } finally {
                if (!committed) await idbDelete(slot).catch(() => {});
            }
            const previousSlot = existing
                ? String(existing.slot || `${ANALYSIS_BASELINE_SLOT_PREFIX}${name}`)
                : null;
            if (previousSlot && previousSlot !== slot) {
                await idbDelete(String(previousSlot)).catch(() => {});
            }
            return {
                ok: true,
                name,
                slot,
                size: stateBytes.length,
                pcVerified: true,
                cpuState,
                ...emulatorActivity(),
                skipIrq: baseline.skipIrq,
                traceEnabled: baseline.traceEnabled
            };
            });
        },

        async restoreAnalysisBaseline(params = {}) {
            ensureRomLoaded("analysis baseline restore requires a loaded ROM");
            const name = String(params.name || "default");
            return withAnalysisBaselineLock(name, async () => {
            return fileTransactionService.run("Analysis baseline restore", async ({ token }) => {
            const baseline = readAnalysisBaseline(name);
            if (!baseline) {
                throw codedError(ErrorCode.STATE_NOT_LOADED, `analysis baseline not found: ${name}`);
            }
            const rom = await currentRomIdentity();
            for (const field of ["romName", "romSize", "romSha256"]) {
                if (baseline[field] !== rom[field]) {
                    throw codedError(
                        ErrorCode.STATE_INVALID,
                        `analysis baseline ROM mismatch: ${field}`,
                        { field }
                    );
                }
            }
            const stateBytes = await idbGet(baseline.slot);
            const invalidState = !stateBytes
                || stateBytes.length !== baseline.stateSize
                || await sha256Hex(stateBytes) !== baseline.stateSha256;
            if (invalidState) {
                throw codedError(
                    ErrorCode.STATE_INVALID,
                    "analysis baseline state integrity check failed"
                );
            }
            await call("loadState", withInternalMetadata({
                slot: baseline.slot,
                saveFlushBlockMs: params.saveFlushBlockMs
            }, {
                analysisBaselineSlotToken,
                fileTransactionToken: token,
                holdPaused: true
            }));
            state.paused = true;
            state.running = false;
            native.pause(true);
            const restoredCpuState = {
                arm9: {
                    pc: Number(getRegisters("arm9").pc) >>> 0,
                    cpsr: Number(getRegisters("arm9").cpsr) >>> 0
                },
                arm7: {
                    pc: Number(getRegisters("arm7").pc) >>> 0,
                    cpsr: Number(getRegisters("arm7").cpsr) >>> 0
                }
            };
            const pcVerified = !!baseline.cpuState;
            if (pcVerified) {
                for (const cpu of ["arm9", "arm7"]) {
                    for (const register of ["pc", "cpsr"]) {
                        if ((Number(baseline.cpuState[cpu]?.[register]) >>> 0)
                            !== restoredCpuState[cpu][register]) {
                            throw codedError(
                                ErrorCode.STATE_INVALID,
                                `analysis baseline ${cpu} ${register} mismatch`,
                                {
                                    cpu,
                                    register,
                                    expected: Number(baseline.cpuState[cpu]?.[register]) >>> 0,
                                    actual: restoredCpuState[cpu][register]
                                }
                            );
                        }
                    }
                }
            }
            if (ui.traceToggle.checked !== !!baseline.traceEnabled) {
                await call("setStackTraceMode", { enabled: baseline.traceEnabled });
            }
            await call("setStackTracePrivilegeCheck", { enabled: baseline.skipIrq });
            if (baseline.running && !baseline.paused) await call("resume");
            else await call("pause");
            return {
                ok: true,
                name,
                restored: true,
                pcVerified,
                cpuState: restoredCpuState,
                ...await snapshotContext(params)
            };
            });
            });
        }
    };
}
