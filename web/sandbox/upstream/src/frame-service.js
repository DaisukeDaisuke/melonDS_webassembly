import { ErrorCode } from "./error-codes.js";
import { compareFramePixels } from "./frame-diff/index.js";

export function createFrameService({
    responder,
    capturePixels,
    getFrame,
    maxSnapshots = 16,
    compareImplementation = compareFramePixels
}) {
    let valid = false;
    let stateLoadSerial = 0;
    let completedFrameSerial = 0;
    const snapshots = new Map();
    const listeners = new Set();
    const requireValid = () => valid
        ? null
        : responder.fail(ErrorCode.SCREEN_INVALID, "Run at least one complete frame after loading State");
    const capture = () => {
        const error = requireValid();
        if (error) return error;
        return responder.ok({
            pixels: new Uint32Array(capturePixels()),
            width: 256,
            height: 384,
            frame: getFrame(),
            stateLoadSerial
        });
    };

    const service = {
        invalidateAfterStateLoad() {
            valid = false;
            stateLoadSerial++;
        },
        isValid: () => valid,
        onFrameCompleted(frame) {
            valid = true;
            completedFrameSerial++;
            for (const listener of listeners) {
                listener({ frame, serial: completedFrameSerial });
            }
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        requireValid,
        captureFrame({ id, replace = false } = {}) {
            if (!id) return responder.fail(ErrorCode.INVALID_ARGUMENT, "snapshot id is required");
            const shot = capture();
            if (!shot.ok) return shot;
            if (snapshots.has(id) && !replace) {
                return responder.fail(
                    ErrorCode.FRAME_SNAPSHOT_EXISTS,
                    `Frame snapshot already exists: ${id}`
                );
            }
            if (!snapshots.has(id) && snapshots.size >= maxSnapshots) {
                return responder.fail(
                    ErrorCode.INVALID_ARGUMENT,
                    `Frame snapshot limit is ${maxSnapshots}`
                );
            }
            snapshots.set(id, { ...shot, id, createdAt: Date.now() });
            return responder.ok({ id, frame: shot.frame, width: 256, height: 384 });
        },
        listFrameSnapshots() {
            return responder.ok({
                snapshots: [...snapshots.values()].map(({ pixels, ...item }) => item)
            });
        },
        deleteFrameSnapshot({ id } = {}) {
            if (!snapshots.delete(id)) {
                return responder.fail(
                    ErrorCode.FRAME_SNAPSHOT_NOT_FOUND,
                    `Frame snapshot not found: ${id}`
                );
            }
            return responder.ok({ id });
        },
        async compareFrame(params = {}) {
            const baseline = snapshots.get(params.id);
            if (!baseline) {
                return responder.fail(
                    ErrorCode.FRAME_SNAPSHOT_NOT_FOUND,
                    `Frame snapshot not found: ${params.id}`
                );
            }
            return service.comparePixels(baseline.pixels, params);
        },
        async comparePixels(baseline, params = {}) {
            const current = capture();
            if (!current.ok) return current;
            return service.compareCapturedPixels(baseline, current.pixels, params);
        },
        async compareCapturedPixels(baseline, current, params = {}) {
            if (!Number.isFinite(Number(params.thresholdPct))) {
                return responder.fail(ErrorCode.INVALID_ARGUMENT, "thresholdPct is required");
            }
            try {
                const result = await compareImplementation({
                    baseline,
                    current,
                    width: 256,
                    height: 384,
                    ...params
                });
                if (result?.ok === false) return result;
                return responder.ok({
                    changed: result.pct >= Number(params.thresholdPct),
                    pct: result.pct,
                    ...(params.debug ? result.debug : {})
                });
            } catch (error) {
                const code = error?.name === "AbortError"
                    ? ErrorCode.CANCELLED
                    : error?.mcpCode || (
                        error instanceof TypeError || /required|invalid|outside|must be/i.test(String(error?.message || error))
                            ? ErrorCode.INVALID_ARGUMENT
                            : ErrorCode.INTERNAL_ERROR
                    );
                return responder.fail(code, String(error?.message || error));
            }
        },
        getSnapshot(id) {
            const snapshot = snapshots.get(id);
            return snapshot
                ? { ...snapshot, pixels: new Uint32Array(snapshot.pixels) }
                : null;
        },
        captureCurrent: capture
    };

    return service;
}
