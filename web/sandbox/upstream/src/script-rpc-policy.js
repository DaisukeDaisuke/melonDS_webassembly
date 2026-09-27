import { ErrorCode } from "./error-codes.js";
import { codedError, isPlainObject } from "./validation.js";
import { normalizeWorkerRpcParams } from "./worker-rpc-payload.js";

const RESERVED_FIELDS = new Set([
    "_operation", "_origin", "_scriptId", "_triggerId", "_operationId",
    "_scriptCallback", "_scriptEventId", "_analysisBaselineSlotToken"
]);

export function validateWorkerRpc(message, seenIds) {
    if (!isPlainObject(message)
        || typeof message.id !== "string"
        || !message.id
        || typeof message.command !== "string"
        || !isPlainObject(message.params ?? {})) {
        throw codedError(ErrorCode.WORKER_PROTOCOL_ERROR, "Worker sent an invalid RPC request");
    }
    if (seenIds.has(message.id)) {
        throw codedError(ErrorCode.WORKER_PROTOCOL_ERROR, "Worker reused an RPC request ID");
    }
    let params;
    try {
        params = normalizeWorkerRpcParams(message.command, message.params ?? {});
    } catch (error) {
        throw codedError(ErrorCode.WORKER_PROTOCOL_ERROR, String(error?.message || error));
    }
    const reserved = Object.keys(params).find((key) => RESERVED_FIELDS.has(key));
    if (reserved) {
        throw codedError(ErrorCode.WORKER_PROTOCOL_ERROR, `Worker RPC used reserved parameter: ${reserved}`);
    }
    seenIds.add(message.id);
    if (seenIds.size > 4096) seenIds.delete(seenIds.values().next().value);
    return { command: message.command, params };
}
