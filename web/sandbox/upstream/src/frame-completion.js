export function completeFrames({ state, frameService, frameBefore, onComplete = () => {} }) {
    if (state.frame <= frameBefore) return 0;

    for (let frame = frameBefore + 1; frame <= state.frame; frame++) {
        frameService.onFrameCompleted(frame);
    }
    const completed = state.frame - frameBefore;
    state.screenValid = true;
    state.framesSinceStateLoad += completed;
    state.completedFrameSerial += completed;
    onComplete(completed);
    return completed;
}
