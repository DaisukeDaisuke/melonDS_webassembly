import { ErrorCode } from "./error-codes.js";
import { completeFrames } from "./frame-completion.js";

const FRAMEBUFFER_BYTES = 256 * 384 * 4;
const EMULATED_FRAMES_PER_SECOND = 59.8261;
const FPS_SAMPLE_INTERVAL_MS = 500;

export function createEmulationLoop({
    state,
    ui,
    frameService,
    native,
    handleNativeFault,
    syncNativeBreakStatus,
    dispatchScriptEvent,
    limitFrameBatch = (frames) => frames,
    onScreenValid = () => {},
    updateStatus,
    log = () => {}
}) {
    let previousScreenDiagnostic = "ok";
    let animationFrameId = 0;
    let sleepTimerId = 0;

    function reportScreenDiagnostic(next, message = "") {
        if (next === previousScreenDiagnostic) return;
        if (next === "ok") {
            log(`screen diagnostic recovered from ${previousScreenDiagnostic}`);
        } else {
            log(message);
        }
        previousScreenDiagnostic = next;
    }

    function drawFrame() {
        if (!state.ready || !state.render || !frameService.isValid()) return;
        const rect = ui.screenShell.getBoundingClientRect();
        const collapsed = rect.width <= 0
            || rect.height <= 0
            || !Number.isFinite(rect.width)
            || !Number.isFinite(rect.height);
        const bytes = native.getFrameBytes();
        if (!bytes || bytes.byteLength !== FRAMEBUFFER_BYTES) {
            reportScreenDiagnostic("invalid-framebuffer", "invalid framebuffer length");
            const error = new Error("invalid framebuffer length");
            error.screenDiagnosticLogged = true;
            throw error;
        }
        if (!ui.screen.isConnected) {
            reportScreenDiagnostic("detached", "screen canvas detached");
        } else if (collapsed) {
            reportScreenDiagnostic(
                "collapsed",
                `screen shell collapsed: scale=${state.scale} rotation=${state.rotation} width=${rect.width} height=${rect.height}`
            );
        } else {
            reportScreenDiagnostic("ok");
        }
        state.imageData.data.set(bytes);
        ui.screen.getContext("2d").putImageData(state.imageData, 0, 0);
    }

    function pumpAudio(frames = 1) {
        if (!state.audio || !state.ready) return;
        const AudioConstructor = window.AudioContext || window.webkitAudioContext;
        if (!AudioConstructor) return;
        if (!state.audioContext) state.audioContext = new AudioConstructor({ sampleRate: 44100 });
        const context = state.audioContext;
        const desired = Math.min(8192, Math.max(256, Math.ceil(
            (44100 / 59.8261) * Math.max(1, frames)
        )));
        const { sampleCount, samples } = native.fillAudioSamples(desired);
        if (sampleCount <= 0) return;
        const buffer = context.createBuffer(2, sampleCount, 44100);
        const volume = Number(ui.volumeRange.value);
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);
        for (let index = 0; index < sampleCount; index++) {
            left[index] = (samples[index * 2] / 32768) * volume;
            right[index] = (samples[index * 2 + 1] / 32768) * volume;
        }
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = state.speed;
        source.connect(context.destination);
        state.audioNextTime = Math.max(context.currentTime, state.audioNextTime);
        source.start(state.audioNextTime);
        state.audioNextTime += sampleCount / (44100 * state.speed);
    }

    function applyFreezes() {
        if (!state.ready || state.freezes.length === 0) return;
        for (const item of state.freezes) {
            native.writeMemory(item.cpu, item.address, item.value, item.size);
        }
    }

    function sampleEffectiveFps(now) {
        const sampleTime = Number(state.fpsSampleTime);
        const sampleFrame = Number(state.fpsSampleFrame);
        if (!Number.isFinite(sampleTime)
            || !Number.isFinite(sampleFrame)
            || now < sampleTime
            || state.frame < sampleFrame) {
            state.fpsSampleTime = now;
            state.fpsSampleFrame = state.frame;
            state.effectiveFps = 0;
            return;
        }
        const elapsed = now - sampleTime;
        if (elapsed < FPS_SAMPLE_INTERVAL_MS) return;
        state.effectiveFps = (state.frame - sampleFrame) * 1000 / elapsed;
        state.fpsSampleTime = now;
        state.fpsSampleFrame = state.frame;
    }

    function tick(now) {
        try {
            if (state.ready && state.running && !state.paused && !state.loadingFile) {
            const elapsed = Math.max(0, Math.min(250, now - state.lastTick));
            const fractionalBudget = Math.max(0, state.frameBudget - Math.floor(state.frameBudget));
            const generatedBudget = fractionalBudget
                + elapsed * EMULATED_FRAMES_PER_SECOND * state.speed / 1000;
            const normalBatchFrames = Math.min(
                Math.max(1, Math.ceil(state.speed)),
                Math.floor(generatedBudget)
            );
            state.frameBudget = generatedBudget - Math.floor(generatedBudget);
            const frames = Math.min(
                normalBatchFrames,
                Math.max(0, Math.floor(Number(limitFrameBatch(normalBatchFrames))))
            );
            if (frames > 0) {
                const frameBefore = state.frame;
                applyFreezes();
                let ran = 0;
                let frameFailed = false;
                try {
                    if (state.touch.active) {
                        for (let index = 0; index < frames; index++) {
                            const frameResult = native.runFrame({
                                render: state.render && index === frames - 1,
                                keys: state.keys,
                                touch: state.touch
                            });
                            ran++;
                            if (frameResult > 0) break;
                        }
                    } else {
                        ran = native.runFrames(frames, {
                            render: state.render,
                            keys: state.keys
                        });
                    }
                } catch (error) {
                    frameFailed = true;
                    if (error?.mcpCode === ErrorCode.NATIVE_ERROR
                        || error?.mcpCode === ErrorCode.NATIVE_FAULT) {
                        handleNativeFault(error, "runFrame");
                    } else {
                        throw error;
                    }
                }
                if (frameFailed) {
                    return;
                }
                const nativeStatus = syncNativeBreakStatus();
                const completed = completeFrames({ state, frameService, frameBefore, onComplete: onScreenValid });
                sampleEffectiveFps(now);
                if (completed < frames || nativeStatus?.lastBreak?.hit) {
                    state.paused = true;
                    state.running = false;
                    native.pause(true);
                }
                for (let index = 0; index < completed; index++) {
                    dispatchScriptEvent("tick", {
                        frame: state.frame - completed + index + 1,
                        cpu: state.selectedCpu
                    });
                }
                applyFreezes();
                try {
                    drawFrame();
                } catch (error) {
                    if (!error?.screenDiagnosticLogged) {
                        log(`frame draw failed: ${String(error?.message || error)}`);
                    }
                }
                try {
                    if (completed > 0) pumpAudio(completed);
                } catch (error) {
                    state.audio = false;
                    log(`audio stopped: ${String(error?.message || error)}`);
                }
                try {
                    updateStatus();
                } catch (error) {
                    log(`status update failed: ${String(error?.message || error)}`);
                }
            }
            }
        } catch (error) {
            if (error?.mcpCode === ErrorCode.NATIVE_ERROR
                || error?.mcpCode === ErrorCode.NATIVE_FAULT) {
                handleNativeFault(error, "emulationLoop");
            } else {
                state.paused = true;
                state.running = false;
                log(`emulation loop paused: ${String(error?.message || error)}`);
            }
        } finally {
            state.lastTick = now;
            scheduleTick();
        }
    }

    function queueAnimationFrame() {
        if (animationFrameId) return;
        animationFrameId = requestAnimationFrame((now) => {
            animationFrameId = 0;
            tick(now);
        });
    }

    function scheduleTick() {
        if (state.running && !state.paused && !state.loadingFile) {
            if (sleepTimerId) {
                clearTimeout(sleepTimerId);
                sleepTimerId = 0;
            }
            queueAnimationFrame();
        } else if (!sleepTimerId && !animationFrameId) {
            sleepTimerId = setTimeout(() => {
                sleepTimerId = 0;
                queueAnimationFrame();
            }, 120);
        }
    }

    function wakeTick() {
        if (sleepTimerId) {
            clearTimeout(sleepTimerId);
            sleepTimerId = 0;
        }
        if (state.running && !state.paused && !state.loadingFile) queueAnimationFrame();
    }

    return { drawFrame, pumpAudio, applyFreezes, tick, scheduleTick, wakeTick };
}
