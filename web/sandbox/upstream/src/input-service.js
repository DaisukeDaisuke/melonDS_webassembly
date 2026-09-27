import { ErrorCode } from "./error-codes.js";
import { codedError, subscribeAbort } from "./validation.js";

const STORAGE_KEY = "desmume-input-sequences-v1";
const BUTTONS = new Set(["A", "B", "X", "Y", "L", "R", "Start", "Select", "Up", "Down", "Left", "Right"]);
const MAX_DURATION_MS = 600000;
const MAX_TAP_COUNT = 10000;
const MAX_STEP_FRAMES = 1000000;

export function createInputSequenceService({
    responder,
    press,
    releaseAll,
    touch,
    stepFrames,
    getPauseDetails = () => null,
    waitForInputWindow = null,
    resume = async () => ({ ok: true }),
    storage = localStorage
}) {
    const sequences = new Map();
    try {
        const saved = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
        if (saved?.version === 1) {
            Object.entries(saved.items || {}).forEach(([id, sequence]) => {
                sequences.set(id, sequence);
            });
        }
    } catch {}

    const save = () => storage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        items: Object.fromEntries(sequences)
    }));
    const buttons = (text) => String(text)
        .split("+")
        .map((button) => button.trim())
        .filter(Boolean);
    const inputUnavailable = (details = getPauseDetails()) => {
        const pauseDetails = details && typeof details === "object"
            ? details
            : { paused: true, running: false, pauseKind: "manual" };
        return codedError(
            ErrorCode.INPUT_UNAVAILABLE,
            `input is unavailable while emulator is paused (${pauseDetails.pauseKind || "manual"})`,
            pauseDetails
        );
    };
    const requireInputRunning = () => {
        const pauseDetails = getPauseDetails();
        if (pauseDetails?.paused) throw inputUnavailable(pauseDetails);
        return pauseDetails;
    };
    const requireCompletedFrameStep = (result, requestedFrames) => {
        const pauseDetails = requireInputRunning();
        const completedFrames = Number(result?.frames);
        if (result?.paused === true
            || (Number.isFinite(completedFrames) && completedFrames < requestedFrames)) {
            throw inputUnavailable({
                ...(pauseDetails && typeof pauseDetails === "object" ? pauseDetails : {}),
                paused: true,
                running: false,
                pauseKind: pauseDetails?.pauseKind || "manual"
            });
        }
    };
    const waitFallback = (ms, signal) => new Promise((resolve, reject) => {
        let unsubscribeAbort = () => {};
        const cleanup = () => unsubscribeAbort();
        const complete = () => {
            cleanup();
            resolve();
        };
        const timer = setTimeout(complete, Math.max(0, ms));
        const aborted = () => {
            clearTimeout(timer);
            cleanup();
            reject(new DOMException("aborted", "AbortError"));
        };
        unsubscribeAbort = subscribeAbort(signal, aborted);
    });
    const wait = (ms, signal) => waitForInputWindow
        ? waitForInputWindow(ms, { signal, label: "runInputSequence" })
        : waitFallback(ms, signal);

    function validate(sequence, tapParams) {
        if (!Array.isArray(sequence) || !sequence.length) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "seq must be a non-empty array");
        }
        const tap = tapParams === undefined ? [40, 50] : tapParams;
        if (!Array.isArray(tap) || tap.length !== 2) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "tap must be [holdMs, gapMs]");
        }
        const holdMs = finiteDuration(tap[0], "tap holdMs");
        const gapMs = finiteDuration(tap[1], "tap gapMs");
        let totalDurationMs = 0;
        for (const step of sequence) {
            if (!Array.isArray(step)) {
                throw codedError(ErrorCode.INVALID_ARGUMENT, "each sequence step must be an array");
            }
            const opcode = step[0];
            const validLength = (
                (opcode === "t" && (step.length === 2 || step.length === 3))
                || (["s", "h", "hf"].includes(opcode) && step.length === 3)
                || (["w", "wf"].includes(opcode) && step.length === 2)
                || (opcode === "x" && (step.length === 3 || step.length === 4))
            );
            if (!validLength) throw codedError(ErrorCode.INVALID_ARGUMENT, `invalid ${String(opcode)} tuple`);
            const usesButtons = ["t", "s", "h", "hf"].includes(step[0]);
            if (usesButtons) {
                const selected = buttons(step[1]);
                if (!selected.length || selected.some((button) => !BUTTONS.has(button))) {
                    throw codedError(ErrorCode.INVALID_ARGUMENT, `unknown or empty button list in ${step[1]}`);
                }
            }
            if (opcode === "t") {
                const count = positiveStepInteger(step[2] ?? 1, "tap count", MAX_TAP_COUNT);
                totalDurationMs += count * holdMs + Math.max(0, count - 1) * gapMs;
            } else if (["s", "h"].includes(opcode)) {
                totalDurationMs += finiteDuration(step[2], `${opcode} durationMs`);
            } else if (opcode === "w") {
                totalDurationMs += finiteDuration(step[1], "wait durationMs");
            } else if (opcode === "hf") {
                positiveStepInteger(step[2], "hold frames", MAX_STEP_FRAMES);
            } else if (opcode === "wf") {
                positiveStepInteger(step[1], "wait frames", MAX_STEP_FRAMES);
            } else if (opcode === "x") {
                const x = Number(step[1]);
                const y = Number(step[2]);
                if (!Number.isInteger(x) || x < 0 || x > 255
                    || !Number.isInteger(y) || y < 0 || y > 191) {
                    throw codedError(ErrorCode.INVALID_ARGUMENT, "touch x must be 0..255 and y must be 0..191 integers");
                }
                totalDurationMs += finiteDuration(step[3] ?? 0, "touch durationMs");
            }
        }
        if (!Number.isFinite(totalDurationMs) || totalDurationMs > MAX_DURATION_MS) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                `sequence total duration must not exceed ${MAX_DURATION_MS}ms`
            );
        }
        return { holdMs, gapMs, totalDurationMs };
    }

    function finiteDuration(value, name) {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || number > MAX_DURATION_MS) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, `${name} must be a finite number from 0 to ${MAX_DURATION_MS}`);
        }
        return number;
    }

    function positiveStepInteger(value, name, maximum) {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, `${name} must be an integer from 1 to ${maximum}`);
        }
        return number;
    }

    return {
        list() {
            return responder.ok({
                sequences: [...sequences].map(([id, sequence]) => ({ id, seq: sequence }))
            });
        },
        delete({ id }) {
            if (!sequences.delete(id)) {
                return responder.fail(
                    ErrorCode.SEQUENCE_NOT_FOUND,
                    `Input sequence not found: ${id}`
                );
            }
            save();
            return responder.ok({ id });
        },
        async run(params, operation) {
            let sequence = params.seq;
            const existing = sequences.get(params.id);
            if (!sequence) {
                if (!existing) {
                    return responder.fail(
                        ErrorCode.SEQUENCE_NOT_FOUND,
                        `Input sequence not found: ${params.id}`
                    );
                }
                sequence = existing;
            }
            let tap;
            try {
                tap = validate(sequence, params.tap);
            } catch (error) {
                return responder.fail(error.mcpCode || ErrorCode.INVALID_ARGUMENT, error.message, error.mcpDetails);
            }
            const changedExisting = existing
                && JSON.stringify(existing) !== JSON.stringify(sequence);
            if (changedExisting && params.replace !== true) {
                return responder.fail(
                    ErrorCode.SEQUENCE_EXISTS,
                    `Input sequence already exists: ${params.id}`
                );
            }
            let initialPause = getPauseDetails();
            if (initialPause?.paused && initialPause.pauseKind === "manual" && params.resume === true) {
                const resumed = await resume();
                if (resumed?.ok === false) return resumed;
                initialPause = getPauseDetails();
            }
            if (initialPause?.paused) {
                return responder.fail(
                    ErrorCode.INPUT_UNAVAILABLE,
                    `input is unavailable while emulator is paused (${initialPause.pauseKind || "manual"})`,
                    initialPause
                );
            }
            if (params.id) {
                sequences.set(params.id, sequence);
                save();
            }

            const { holdMs, gapMs } = tap;
            try {
                for (const step of sequence) {
                    requireInputRunning();
                    const [opcode, first, second] = step;
                    if (opcode === "w") {
                        await wait(first, operation.signal);
                    } else if (opcode === "wf") {
                        const requestedFrames = first;
                        requireInputRunning();
                        const result = await stepFrames(requestedFrames);
                        requireCompletedFrameStep(result, requestedFrames);
                    } else if (opcode === "x") {
                        requireInputRunning();
                        touch(true, first, second);
                        await wait(step[3] ?? 0, operation.signal);
                        touch(false);
                    } else {
                        const selected = buttons(first);
                        const down = () => {
                            requireInputRunning();
                            selected.forEach((button) => press(button, true));
                        };
                        const up = () => selected.forEach((button) => press(button, false));
                        if (opcode === "t") {
                            const count = second ?? 1;
                            for (let index = 0; index < count; index++) {
                                down();
                                await wait(holdMs, operation.signal);
                                up();
                                if (index + 1 < count) {
                                    await wait(gapMs, operation.signal);
                                }
                            }
                        } else if (opcode === "s") {
                            const end = performance.now() + second;
                            while (performance.now() < end) {
                                down();
                                await wait(holdMs, operation.signal);
                                up();
                                await wait(gapMs, operation.signal);
                            }
                        } else if (opcode === "h") {
                            down();
                            await wait(second, operation.signal);
                            up();
                        } else if (opcode === "hf") {
                            down();
                            const requestedFrames = second;
                            let result;
                            try {
                                result = await stepFrames(requestedFrames);
                            } finally {
                                up();
                            }
                            requireCompletedFrameStep(result, requestedFrames);
                        }
                    }
                    requireInputRunning();
                }
                requireInputRunning();
                return responder.ok({ id: params.id || null, steps: sequence.length });
            } finally {
                releaseAll();
                touch(false);
            }
        }
    };
}
