import { ErrorCode } from "./error-codes.js";
import { codedError } from "./validation.js";

export function containsDynamicImport(source) {
    throw codedError(
        ErrorCode.SCRIPT_SOURCE_INVALID,
        "Dynamic-import inspection is available only inside the hardened Acorn Worker",
        { parser: "acorn", version: "8.17.0", hardenedWorkerRequired: true }
    );
}

export function assertSafeScriptSource(source) {
    if (typeof source !== "string" || source.length > 262144) {
        throw codedError(
            ErrorCode.SCRIPT_SOURCE_INVALID,
            "Script source must be a string up to 262144 characters",
            { parser: "acorn", version: "8.17.0", validationLayer: "hardened-worker" }
        );
    }
}
