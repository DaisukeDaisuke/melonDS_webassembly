export function createOrderedFrameDrain({
    frameService,
    sampleEveryFrames = 1,
    maxQueue = 32,
    onSample,
    onOverflow,
    onError
}) {
    const queue = [];
    let active = true;
    let completed = 0;
    let sampled = 0;
    let draining = false;

    async function drain() {
        if (draining || !active) return;
        draining = true;
        try {
            while (active && queue.length) {
                const sample = queue.shift();
                await onSample(sample, {
                    completedFrames: completed,
                    sampledFrames: sampled,
                    queued: queue.length
                });
            }
        } catch (error) {
            if (active) onError(error);
        } finally {
            draining = false;
            if (active && queue.length) void drain();
        }
    }

    const unsubscribe = frameService.subscribe(({ frame, serial } = {}) => {
        if (!active) return;
        completed++;
        if (completed % sampleEveryFrames) return;
        const captured = frameService.captureCurrent();
        if (!captured.ok) {
            onError(captured);
            return;
        }
        if (queue.length >= maxQueue) {
            active = false;
            queue.length = 0;
            unsubscribe();
            onOverflow({ frame, serial, maxQueue });
            return;
        }
        sampled++;
        queue.push({
            frame,
            serial,
            pixels: new Uint32Array(captured.pixels)
        });
        void drain();
    });

    return Object.freeze({
        stats: () => ({
            active,
            completedFrames: completed,
            sampledFrames: sampled,
            queued: queue.length,
            draining
        }),
        stop() {
            if (!active) return;
            active = false;
            queue.length = 0;
            unsubscribe();
        }
    });
}
