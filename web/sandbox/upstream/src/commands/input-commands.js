import { codedError, nonNegativeNumber, positiveInteger } from "../validation.js";
import { ErrorCode } from "../error-codes.js";
import { describeInputPause, requireInputRunning } from "../input-pause.js";

const MAX_INPUT_WAIT_MS = 600000;

export function createInputCommands({
    state,
    native,
    ensureRomLoaded,
    resumeInput,
    renderHotkey,
    saveKeymap,
    setKey,
    setTouchState,
    toButtonList,
    waitChecked,
    waitForInputWindow = null,
    inputTaskManager = { run: async (name, task) => task() },
    getInputParentSignal = () => null
}) {
    const waitInput = (milliseconds, deadline, label, signal) => waitForInputWindow
        ? waitForInputWindow(milliseconds, { deadline, label, signal })
        : waitChecked(milliseconds, deadline, label);
    function inputDeadline(params) {
        if (params.timeoutMs === undefined) return 0;
        return performance.now() + positiveInteger(params.timeoutMs, "timeoutMs", MAX_INPUT_WAIT_MS);
    }

    function validateTotalWait(totalMs, command) {
        if (!Number.isFinite(totalMs) || totalMs > MAX_INPUT_WAIT_MS) {
            throw codedError(
                ErrorCode.INVALID_ARGUMENT,
                `${command} total wait must not exceed ${MAX_INPUT_WAIT_MS}ms`
            );
        }
    }

    async function requireInputReady(params, requirement) {
        ensureRomLoaded(requirement);
        const pauseDetails = state.paused ? describeInputPause(state, native) : null;
        if (pauseDetails?.pauseKind === "manual" && params.resume === true) {
            const result = await resumeInput();
            if (result?.ok === false) {
                throw codedError(
                    result.error?.code || ErrorCode.INPUT_UNAVAILABLE,
                    result.error?.message || "emulator could not resume before input",
                    result.error?.details
                );
            }
        }
        requireInputRunning(state, native);
    }

    async function setInput(params) {
        await requireInputReady(params, "input requires a loaded ROM");
        const [button] = toButtonList(params);
        setKey(button, !!params.pressed);
        return { keys: state.keys };
    }

    async function runInputHold(params = {}) {
        return inputTaskManager.run("runInputHold", async (signal) => {
        await requireInputReady(params, "input hold requires a loaded ROM");
        const buttons = toButtonList(params);
        const durationMs = nonNegativeNumber(
            params.durationMs ?? params.holdMs ?? 0,
            "durationMs",
            MAX_INPUT_WAIT_MS
        );
        const waitBeforeMs = nonNegativeNumber(params.waitBeforeMs ?? 0, "waitBeforeMs", MAX_INPUT_WAIT_MS);
        const waitAfterMs = nonNegativeNumber(params.waitAfterMs ?? 0, "waitAfterMs", MAX_INPUT_WAIT_MS);
        validateTotalWait(waitBeforeMs + durationMs + waitAfterMs, "runInputHold");
        const deadline = inputDeadline(params);
        await waitInput(waitBeforeMs, deadline, "runInputHold", signal);
        requireInputRunning(state, native);
        buttons.forEach((button) => setKey(button, true));
        try {
            await waitInput(durationMs, deadline, "runInputHold", signal);
        } finally {
            buttons.forEach((button) => setKey(button, false));
        }
        await waitInput(waitAfterMs, deadline, "runInputHold", signal);
        return { ok: true, buttons, durationMs };
        }, getInputParentSignal());
    }

    async function runInputTap(params = {}) {
        return inputTaskManager.run("runInputTap", async (signal) => {
        await requireInputReady(params, "input tap requires a loaded ROM");
        const buttons = toButtonList(params);
        const repeat = positiveInteger(params.repeat ?? params.count ?? 1, "repeat", 10000);
        const holdMs = nonNegativeNumber(params.holdMs ?? params.pressMs ?? 50, "holdMs", MAX_INPUT_WAIT_MS);
        const gapMs = nonNegativeNumber(params.gapMs ?? params.waitMs ?? 50, "gapMs", MAX_INPUT_WAIT_MS);
        const waitBeforeMs = nonNegativeNumber(params.waitBeforeMs ?? 0, "waitBeforeMs", MAX_INPUT_WAIT_MS);
        const waitAfterMs = nonNegativeNumber(params.waitAfterMs ?? 0, "waitAfterMs", MAX_INPUT_WAIT_MS);
        validateTotalWait(
            waitBeforeMs + (repeat * holdMs) + (Math.max(0, repeat - 1) * gapMs) + waitAfterMs,
            "runInputTap"
        );
        const deadline = inputDeadline(params);
        await waitInput(waitBeforeMs, deadline, "runInputTap", signal);
        for (let index = 0; index < repeat; index++) {
            requireInputRunning(state, native);
            buttons.forEach((button) => setKey(button, true));
            try {
                await waitInput(holdMs, deadline, "runInputTap", signal);
            } finally {
                buttons.forEach((button) => setKey(button, false));
            }
            if (index < repeat - 1) await waitInput(gapMs, deadline, "runInputTap", signal);
        }
        await waitInput(waitAfterMs, deadline, "runInputTap", signal);
        return { ok: true, buttons, repeat, holdMs, gapMs };
        }, getInputParentSignal());
    }

    async function runTouchHold(params = {}) {
        return inputTaskManager.run("runTouchHold", async (signal) => {
        await requireInputReady(params, "touch hold requires a loaded ROM");
        const x = Number(params.x);
        const y = Number(params.y);
        if (!Number.isInteger(x) || x < 0 || x > 255 || !Number.isInteger(y) || y < 0 || y > 191) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "x must be 0..255 and y must be 0..191 integers");
        }
        const durationMs = nonNegativeNumber(
            params.durationMs ?? params.holdMs ?? 0,
            "durationMs",
            MAX_INPUT_WAIT_MS
        );
        const waitBeforeMs = nonNegativeNumber(params.waitBeforeMs ?? 0, "waitBeforeMs", MAX_INPUT_WAIT_MS);
        const waitAfterMs = nonNegativeNumber(params.waitAfterMs ?? 0, "waitAfterMs", MAX_INPUT_WAIT_MS);
        validateTotalWait(waitBeforeMs + durationMs + waitAfterMs, "runTouchHold");
        const deadline = inputDeadline(params);
        await waitInput(waitBeforeMs, deadline, "runTouchHold", signal);
        requireInputRunning(state, native);
        setTouchState(true, x, y);
        try {
            await waitInput(durationMs, deadline, "runTouchHold", signal);
        } finally {
            setTouchState(false, x, y);
        }
        await waitInput(waitAfterMs, deadline, "runTouchHold", signal);
        return { ok: true, x, y, durationMs };
        }, getInputParentSignal());
    }

    async function setKeyBinding(params) {
        const [button] = toButtonList(params);
        const key = String(params.key || "").trim();
        if (!key) throw codedError(ErrorCode.INVALID_ARGUMENT, "key is required");
        for (const [code, mapped] of Object.entries(state.keymap)) {
            if (mapped === button || code === key) delete state.keymap[code];
        }
        state.keymap[key] = button;
        saveKeymap();
        renderHotkey();
        return { keymap: state.keymap };
    }

    async function getInputState() {
        return {
            keyMask: Number(state.keys || 0) >>> 0,
            buttons: Object.entries(state.buttons)
                .filter(([, bit]) => (state.keys & (1 << bit)) !== 0)
                .map(([button]) => button),
            touch: { ...state.touch }
        };
    }

    async function releaseInput() {
        Object.keys(state.buttons).forEach((button) => setKey(button, false));
        setTouchState(false, 0, 0);
        return { ok: true, ...await getInputState() };
    }

    return Object.freeze({
        runInputHold,
        runInputTap,
        runTouchHold,
        getInputState,
        releaseInput,
        setInput,
        setKeyBinding
    });
}
