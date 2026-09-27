import { ErrorCode } from "./error-codes.js";
import { codedError } from "./validation.js";

export function createFileTransactionService({
    state,
    cancelPendingScriptEvents = async () => {},
    eventService = null,
    inputTaskManager = null
}) {
    function begin(reason = "file transaction") {
        if (state.fileTransactionActive) {
            throw codedError(ErrorCode.BUSY, `Active file transaction is ${state.fileTransactionReason || "in progress"}`, {
                activeReason: state.fileTransactionReason || null
            });
        }
        const token = Symbol(reason);
        state.fileTransactionActive = true;
        state.fileTransactionOwner = token;
        state.fileTransactionReason = String(reason);
        state.fileTransactionBoundaryActive = false;
        eventService?.publish({
            phase: "begin",
            active: true,
            fileTransactionSerial: Number(state.fileTransactionSerial || 0),
            reason: state.fileTransactionReason
        });
        return token;
    }

    async function commit(token) {
        if (state.fileTransactionOwner !== token) {
            throw codedError(ErrorCode.CANCELLED, "File transaction ownership was lost");
        }
        if (state.fileTransactionBoundaryActive) return false;
        state.fileTransactionBoundaryActive = true;
        state.fileTransactionSerial++;
        state.nativeBreakSerial = Number(state.nativeBreakSerial || 0) + 1;
        state.currentBreakIdentity = null;
        state.lastBreakKey = "";
        state.breakRefreshKey = "";
        await cancelPendingScriptEvents(`${state.fileTransactionReason} started`);
        eventService?.publish({
            phase: "commit",
            active: true,
            fileTransactionSerial: Number(state.fileTransactionSerial || 0),
            reason: state.fileTransactionReason
        });
        return true;
    }

    function end(token) {
        if (state.fileTransactionOwner !== token) return false;
        state.fileTransactionActive = false;
        state.fileTransactionBoundaryActive = false;
        state.fileTransactionOwner = null;
        state.fileTransactionReason = "";
        eventService?.publish({
            phase: "end",
            active: false,
            fileTransactionSerial: Number(state.fileTransactionSerial || 0),
            reason: ""
        });
        return true;
    }

    async function run(reason, task, ownerToken = null) {
        if (ownerToken !== null) {
            if (state.fileTransactionOwner !== ownerToken) {
                throw codedError(ErrorCode.BUSY, `Active file transaction is ${state.fileTransactionReason || "in progress"}`);
            }
            return task({
                token: ownerToken,
                commit: () => commit(ownerToken)
            });
        }
        const token = begin(reason);
        try {
            await inputTaskManager?.blockAndCancel(`${reason} started`);
            return await task({
                token,
                commit: () => commit(token)
            });
        } finally {
            end(token);
            inputTaskManager?.unblock();
        }
    }

    return Object.freeze({ begin, commit, end, run });
}
