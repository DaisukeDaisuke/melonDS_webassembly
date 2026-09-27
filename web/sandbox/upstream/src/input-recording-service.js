import { ErrorCode } from "./error-codes.js";
import { codedError, positiveInteger, subscribeAbort } from "./validation.js";
import { withInternalMetadata } from "./internal-command-metadata.js";

const FORMAT_VERSION = 1;
const MAX_EVENTS = 100000;
const MAX_SERIALIZED_CHARS = 4 * 1024 * 1024;
const META_PREFIX = "input-recording:meta:";
const DATA_PREFIX = "input-recording:data:";
const STATE_PREFIX = "input-recording:state:";
let temporaryKeySerial = 0;

export function createInputRecordingService({
    responder,
    idbGet,
    idbPut,
    idbDelete,
    idbDeleteMany = async (keys) => Promise.all(keys.map((item) => idbDelete(item))),
    idbKeys,
    frameService,
    pauseEventService,
    fileTransactionEventService,
    subscribeInputMutations,
    getInputSnapshot,
    applyInputSnapshot,
    releaseInput,
    getFrame,
    getActivity,
    getCpuState,
    currentRomIdentity,
    sha256Hex,
    saveStateBytes,
    commands,
    waitForInputWindow,
    cancelInputTasksForOperation = async () => false
}) {
    const key = (prefix, id) => `${prefix}${id}`;
    let recordingTargetFrame = null;
    const recordingId = (value) => {
        const id = String(value || "").trim();
        if (!id || id.length > 128 || !/^[A-Za-z0-9._-]+$/.test(id)) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "recording id must use 1..128 letters, numbers, dot, underscore, or hyphen");
        }
        return id;
    };

    function validateEvents(events) {
        if (!Array.isArray(events) || !events.length || events.length > MAX_EVENTS) {
            throw codedError(ErrorCode.STATE_INVALID, "recording events are missing or exceed the event limit");
        }
        let previousOffset = -1;
        for (const event of events) {
            if (!Array.isArray(event) || event.length !== 6 || event[0] !== "i") {
                throw codedError(ErrorCode.STATE_INVALID, "recording contains an invalid input event");
            }
            const [, offset, mask, active, x, y] = event;
            if (!Number.isSafeInteger(offset) || offset < previousOffset
                || !Number.isSafeInteger(mask) || mask < 0 || mask > 0xfff
                || typeof active !== "boolean"
                || !Number.isInteger(x) || x < 0 || x > 255
                || !Number.isInteger(y) || y < 0 || y > 191) {
                throw codedError(ErrorCode.STATE_INVALID, "recording input event fields are invalid");
            }
            previousOffset = offset;
        }
        return events;
    }

    async function waitForRecordingBoundary({ targetFrame, durationMs, operation }) {
        if (durationMs !== null) {
            await waitForInputWindow(durationMs, {
                signal: operation.signal,
                label: "recordInput"
            });
            return getFrame();
        }
        if (getFrame() >= targetFrame) return targetFrame;
        return new Promise((resolve, reject) => {
            let unsubscribeFrame = () => {};
            let unsubscribePause = () => {};
            let unsubscribeFile = () => {};
            let unsubscribeAbort = () => {};
            const cleanup = () => {
                unsubscribeFrame();
                unsubscribePause();
                unsubscribeFile();
                unsubscribeAbort();
            };
            const fail = (error) => {
                cleanup();
                reject(error);
            };
            unsubscribeFrame = frameService.subscribe(({ frame } = {}) => {
                const completedFrame = Number.isFinite(Number(frame)) ? Number(frame) : getFrame();
                if (completedFrame < targetFrame) return;
                cleanup();
                resolve(targetFrame);
            });
            const afterPause = pauseEventService.currentSerial();
            unsubscribePause = pauseEventService.subscribe((event) => {
                if (event.serial > afterPause) {
                    fail(codedError(ErrorCode.INPUT_UNAVAILABLE, "recording was interrupted by pause", event));
                }
            });
            const afterFile = fileTransactionEventService.currentSerial();
            unsubscribeFile = fileTransactionEventService.subscribe((event) => {
                if (event.serial > afterFile) {
                    fail(codedError(ErrorCode.CANCELLED, "recording was interrupted by a file transaction", event));
                }
            });
            unsubscribeAbort = subscribeAbort(operation.signal, () => {
                fail(new DOMException("aborted", "AbortError"));
            });
        });
    }

    async function record(params, operation) {
        const id = recordingId(params.id);
        const hasFrames = params.frames !== undefined;
        const hasDuration = params.durationMs !== undefined;
        if (hasFrames === hasDuration) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "exactly one of frames or durationMs is required");
        }
        const frames = hasFrames ? positiveInteger(params.frames, "frames", 1000000) : null;
        const durationMs = hasDuration ? positiveInteger(params.durationMs, "durationMs", 600000) : null;
        const previousMetadata = await idbGet(key(META_PREFIX, id));
        if (previousMetadata && params.replace !== true) {
            return responder.fail(ErrorCode.RECORDING_EXISTS, `Input recording already exists: ${id}`);
        }
        const temporarySuffix = `${Date.now().toString(36)}-${++temporaryKeySerial}`;
        const dataKey = key(DATA_PREFIX, `${id}:temporary:${temporarySuffix}`);
        const stateKey = key(STATE_PREFIX, `${id}:temporary:${temporarySuffix}`);
        const metaKey = key(META_PREFIX, id);
        let committed = false;
        let unsubscribe = () => {};
        const events = [];
        const startedFrame = getFrame();
        const targetFrame = frames === null ? null : startedFrame + frames;
        let lastEncoded = "";
        const initialActivity = getActivity();
        if (initialActivity.paused && params.resume !== true) {
            return responder.fail(ErrorCode.INPUT_UNAVAILABLE, "recordInput requires a running emulator or resume:true");
        }
        const startCpuState = getCpuState();
        const appendAt = (offset, snapshot) => {
            const event = [
                "i",
                Math.max(0, offset),
                Number(snapshot.keyMask) >>> 0,
                !!snapshot.touchActive,
                Number(snapshot.x || 0),
                Number(snapshot.y || 0)
            ];
            const encoded = event.slice(2).join(":");
            if (encoded === lastEncoded) return;
            if (events.length >= MAX_EVENTS) {
                throw codedError(ErrorCode.RESOURCE_LIMIT, `recording event limit is ${MAX_EVENTS}`);
            }
            lastEncoded = encoded;
            events.push(event);
        };
        const append = (snapshot) => appendAt(getFrame() - startedFrame, snapshot);
        try {
            recordingTargetFrame = targetFrame;
            if (initialActivity.paused && params.resume === true && params.captureState !== true) {
                const resumed = await commands.resume(withInternalMetadata({}, { operation: true }));
                if (resumed?.ok === false) return resumed;
            }
            let associatedState = null;
            if (params.captureState === true) {
                const activity = getActivity();
                const wasRunning = activity.running && !activity.paused;
                if (activity.paused && params.resume !== true) {
                    return responder.fail(ErrorCode.INPUT_UNAVAILABLE, "recordInput requires a running emulator or resume:true");
                }
                await commands.pause(withInternalMetadata({}, { operation: true }));
                const stateBytes = saveStateBytes();
                const cpuState = getCpuState();
                const rom = await currentRomIdentity();
                associatedState = {
                    bytes: stateBytes,
                    size: stateBytes.length,
                    sha256: await sha256Hex(stateBytes),
                    cpuState,
                    rom
                };
                if (wasRunning || params.resume === true) {
                    await commands.resume(withInternalMetadata({}, { operation: true }));
                }
            }
            append(getInputSnapshot());
            unsubscribe = subscribeInputMutations(append);
            const boundaryFrame = await waitForRecordingBoundary({
                targetFrame,
                durationMs,
                operation
            });
            const totalFrames = Math.max(0, boundaryFrame - startedFrame);
            unsubscribe();
            unsubscribe = () => {};
            await cancelInputTasksForOperation(operation.signal);
            releaseInput();
            appendAt(totalFrames, getInputSnapshot());
            const serialized = JSON.stringify(events);
            if (serialized.length > MAX_SERIALIZED_CHARS) {
                throw codedError(ErrorCode.RESOURCE_LIMIT, "recording serialized size limit exceeded");
            }
            const rom = await currentRomIdentity();
            const metadata = {
                id,
                formatVersion: FORMAT_VERSION,
                createdAt: new Date().toISOString(),
                rom,
                events: events.length,
                totalFrames,
                durationMs,
                hasState: !!associatedState,
                stateSize: associatedState?.size || 0,
                stateSha256: associatedState?.sha256 || null,
                cpuState: associatedState?.cpuState || startCpuState,
                dataKey,
                stateKey: associatedState ? stateKey : null
            };
            await idbPut(dataKey, events);
            if (associatedState) await idbPut(stateKey, associatedState.bytes);
            await idbPut(metaKey, metadata);
            committed = true;
            if (previousMetadata) {
                await Promise.allSettled([
                    previousMetadata.dataKey && previousMetadata.dataKey !== dataKey
                        ? idbDelete(previousMetadata.dataKey)
                        : Promise.resolve(),
                    previousMetadata.stateKey && previousMetadata.stateKey !== stateKey
                        ? idbDelete(previousMetadata.stateKey)
                        : Promise.resolve()
                ]);
            }
            return responder.ok({ ...metadata, stateLoaded: false });
        } finally {
            recordingTargetFrame = null;
            unsubscribe();
            await cancelInputTasksForOperation(operation.signal);
            releaseInput();
            if (!committed) {
                await Promise.allSettled([
                    idbDelete(dataKey),
                    idbDelete(stateKey)
                ]);
            }
        }
    }

    async function replay(params, operation) {
        const id = recordingId(params.id);
        const metadata = await idbGet(key(META_PREFIX, id));
        if (!metadata) return responder.fail(ErrorCode.RECORDING_NOT_FOUND, `Input recording not found: ${id}`);
        const events = validateEvents(await idbGet(metadata.dataKey));
        const currentRom = await currentRomIdentity();
        for (const field of ["romName", "romSize", "romSha256"]) {
            if (metadata.rom?.[field] !== currentRom[field]) {
                return responder.fail(ErrorCode.STATE_INVALID, `recording ROM mismatch: ${field}`, { field });
            }
        }
        let stateLoaded = false;
        let stateSource = null;
        if (params.loadState === true && params.stateSlot !== undefined) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "loadState and stateSlot cannot be combined");
        }
        if (params.loadState === true) {
            if (!metadata.stateKey) {
                return responder.fail(ErrorCode.STATE_NOT_LOADED, "recording has no associated State");
            }
            const bytes = await idbGet(metadata.stateKey);
            if (!bytes || bytes.length !== metadata.stateSize
                || await sha256Hex(bytes) !== metadata.stateSha256) {
                return responder.fail(ErrorCode.STATE_INVALID, "recording State integrity check failed");
            }
            const loaded = await commands.loadState(withInternalMetadata(
                { slot: metadata.stateKey },
                { operation: true, recordingReplay: true, holdPaused: true }
            ));
            if (loaded?.ok === false) return loaded;
            stateLoaded = true;
            stateSource = "recording";
        } else if (params.stateSlot !== undefined) {
            const loaded = await commands.loadState(withInternalMetadata(
                { slot: String(params.stateSlot) },
                { operation: true, recordingReplay: true, holdPaused: true }
            ));
            if (loaded?.ok === false) return loaded;
            stateLoaded = true;
            stateSource = "slot";
        } else {
            await commands.pause(withInternalMetadata({}, { operation: true }));
        }
        const cpuState = getCpuState();
        const verificationSkipped = params.verifyStart === false;
        const pcVerified = verificationSkipped ? null : (
            ["arm9", "arm7"].every((cpu) => (
                ["pc", "cpsr"].every((register) => (
                    (Number(metadata.cpuState?.[cpu]?.[register]) >>> 0)
                    === (Number(cpuState[cpu][register]) >>> 0)
                ))
            ))
        );
        if (!verificationSkipped && !pcVerified) {
            return responder.fail(ErrorCode.STATE_INVALID, "recording start PC/CPSR mismatch");
        }
        let offset = 0;
        try {
            for (const event of events) {
                const nextOffset = event[1];
                if (nextOffset > offset) {
                    const requested = nextOffset - offset;
                    const stepped = await commands.stepFrames(withInternalMetadata(
                        { frames: requested, pauseWhenRunning: false },
                        { operation: true }
                    ));
                    if (stepped?.ok === false || Number(stepped.frames) !== requested) {
                        return responder.fail(ErrorCode.BREAKPOINT_INTERRUPTED, "replay frame advance was interrupted");
                    }
                    offset = nextOffset;
                }
                applyInputSnapshot({
                    keyMask: event[2],
                    touchActive: event[3],
                    x: event[4],
                    y: event[5]
                });
            }
            if (metadata.totalFrames > offset) {
                const requested = metadata.totalFrames - offset;
                const stepped = await commands.stepFrames(withInternalMetadata(
                    { frames: requested, pauseWhenRunning: false },
                    { operation: true }
                ));
                if (stepped?.ok === false || Number(stepped.frames) !== requested) {
                    return responder.fail(ErrorCode.BREAKPOINT_INTERRUPTED, "replay final frame advance was interrupted");
                }
                offset = metadata.totalFrames;
            }
            if (params.pauseAfter !== false) {
                await commands.pause(withInternalMetadata({}, { operation: true }));
            } else {
                const resumed = await commands.resume(withInternalMetadata({}, { operation: true }));
                if (resumed?.ok === false) return resumed;
            }
            const activity = getActivity();
            return responder.ok({
                id,
                events: events.length,
                frames: offset,
                stateLoaded,
                stateSource,
                pcVerified,
                verificationSkipped,
                frame: getFrame(),
                paused: !!activity.paused,
                running: !!activity.running
            });
        } finally {
            releaseInput();
        }
    }

    async function list() {
        const metadata = [];
        for (const storageKey of await idbKeys()) {
            if (!storageKey.startsWith(META_PREFIX)) continue;
            const item = await idbGet(storageKey);
            if (!item) continue;
            const { dataKey, stateKey, cpuState, ...publicItem } = item;
            metadata.push(publicItem);
        }
        return responder.ok({ recordings: metadata });
    }

    async function remove(params = {}) {
        const id = recordingId(params.id);
        const metadata = await idbGet(key(META_PREFIX, id));
        if (!metadata) return responder.fail(ErrorCode.RECORDING_NOT_FOUND, `Input recording not found: ${id}`);
        await idbDeleteMany([
            key(META_PREFIX, id),
            metadata.dataKey,
            metadata.stateKey
        ]);
        return responder.ok({ id });
    }

    function limitFrameBatch(requestedFrames) {
        if (recordingTargetFrame === null) return requestedFrames;
        return Math.min(requestedFrames, Math.max(0, recordingTargetFrame - getFrame()));
    }

    return Object.freeze({ delete: remove, limitFrameBatch, list, record, replay });
}
