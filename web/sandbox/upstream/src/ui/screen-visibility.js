import { applyScreenLayout } from "./screen-layout.js";

export function createScreenVisibility({ state, ui, frameService, tryGetPc }) {
    function hex(value, width = 8) {
        return `0x${(Number(value) >>> 0).toString(16).padStart(width, "0")}`;
    }

    function applyScaleRotation() {
        applyScreenLayout(ui.screenShell, state);
    }

    function updateStatus() {
        ui.frameStatus.textContent = `frame ${state.frame}`;
        const effectiveFps = state.running && !state.paused
            ? Math.max(0, Number(state.effectiveFps) || 0)
            : 0;
        ui.fpsStatus.textContent = `実効FPS: ${effectiveFps.toFixed(1)} fps`;
        ui.speedStatus.textContent = `speed ${state.speed.toFixed(2)}x`;
        if (state.ready) {
            const pc = tryGetPc();
            ui.pcStatus.textContent = `${state.selectedCpu} pc ${pc === null ? "--" : hex(pc)}`;
        }
        ui.readyLed.className = state.ready ? `led ${state.paused ? "paused" : "ready"}` : "led";
        if (state.ready) {
            ui.readyText.textContent = state.breakLabel || (state.paused ? "paused" : "running");
        }
        const screenValid = frameService.isValid();
        ui.canvasShotBtn.disabled = !screenValid;
        ui.canvasShotBtn.title = screenValid ? "" : "画面を更新するには実行を再開してください。";
    }

    return Object.freeze({ applyScaleRotation, updateStatus });
}
