import { ErrorCode } from "../error-codes.js";
import { codedError, finiteNumber } from "../validation.js";

export function createScreenshotCommands(context) {
    const { requireValidScreen, state, ui } = context;

    return {
        async takeScreenshot(params = {}) {
            const screenError = requireValidScreen();
            if (screenError) return screenError;
            const cooldownMs = finiteNumber(params.cooldownMs ?? 1200, "cooldownMs", 250, 600000);
            if (performance.now() < state.screenshotCooldownUntil) {
                throw codedError(ErrorCode.BUSY, "screenshot cooldown active", {
                    remainingMs: Math.ceil(state.screenshotCooldownUntil - performance.now())
                });
            }
            state.screenshotCooldownUntil = performance.now() + cooldownMs;
            const type = "image/png";
            const name = String(params.name || `desmume-${Date.now()}.png`);
            const dataUrl = ui.screen.toDataURL(type);
            if (params.download !== false) {
                const link = document.createElement("a");
                link.href = dataUrl;
                link.download = name;
                link.click();
            }
            return {
                ok: true,
                type,
                name,
                width: ui.screen.width,
                height: ui.screen.height,
                cooldownMs,
                ...(params.includeDataUrl ? { dataUrl } : {})
            };
        }
    };
}
