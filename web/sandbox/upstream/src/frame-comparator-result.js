import { isPlainObject } from "./validation.js";

export function isValidAlgorithmWorkerResult(result) {
    return isPlainObject(result)
        && Number.isFinite(result.pct)
        && result.pct >= 0
        && result.pct <= 100
        && (result.debug === undefined || isPlainObject(result.debug));
}

