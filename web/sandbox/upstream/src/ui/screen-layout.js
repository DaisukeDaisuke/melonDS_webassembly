export function applyScreenLayout(screenShell, {
    scale = 2,
    rotation = 0
} = {}) {
    const normalizedScale = Number(scale) || 2;
    const normalizedRotation = Number(rotation) || 0;
    const vertical = normalizedRotation % 180 === 0;
    const canvasWidth = 256 * normalizedScale;
    const canvasHeight = 384 * normalizedScale;
    screenShell.style.setProperty("--canvas-w", `${canvasWidth}px`);
    screenShell.style.setProperty("--canvas-h", `${canvasHeight}px`);
    screenShell.style.setProperty("--screen-w", `${(vertical ? 256 : 384) * normalizedScale}px`);
    screenShell.style.setProperty("--screen-h", `${(vertical ? 384 : 256) * normalizedScale}px`);
    screenShell.style.setProperty("--screen-rotation", `${normalizedRotation}deg`);
}
