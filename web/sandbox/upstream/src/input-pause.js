import { ErrorCode } from "./error-codes.js";
import { codedError } from "./validation.js";

const BREAK_TYPES = Object.freeze([
    "exec",
    "read",
    "write",
    "dataAbort",
    "prefetchAbort",
    "undefinedInstruction"
]);

function finiteUint32(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number >>> 0 : 0;
}

export function describeInputPause(state, native) {
    let nativeStatus = null;
    try {
        nativeStatus = state.ready && native?.getStatus ? native.getStatus() : null;
    } catch {}
    const lastBreak = nativeStatus?.lastBreak?.hit ? nativeStatus.lastBreak : null;
    const breakType = lastBreak ? (BREAK_TYPES[Number(lastBreak.kind)] || "unknown") : "";
    const pauseKind = breakType === "exec"
        ? "executeBreakpoint"
        : breakType === "read" || breakType === "write"
            ? "memoryBreakpoint"
            : breakType
                ? "specialBreakpoint"
                : "manual";
    return {
        paused: !!state.paused,
        running: !!state.running,
        pauseKind,
        ...(lastBreak ? {
            breakType,
            cpu: String(lastBreak.cpu || state.selectedCpu || ""),
            address: finiteUint32(lastBreak.address),
            pc: finiteUint32(lastBreak.pc)
        } : {})
    };
}

export function requireInputRunning(state, native) {
    if (!state.paused) return;
    const details = describeInputPause(state, native);
    throw codedError(
        ErrorCode.INPUT_UNAVAILABLE,
        `input is unavailable while emulator is paused (${details.pauseKind})`,
        details
    );
}
