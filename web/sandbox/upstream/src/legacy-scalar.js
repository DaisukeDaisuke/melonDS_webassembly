export function unwrapLegacyScalar(result, command) {
    if (result?.ok === false) {
        const error = new Error(result.error?.message || `${command} failed`);
        error.code = result.error?.code;
        error.details = result.error?.details;
        throw error;
    }

    if (result?.ok === true
        && Object.prototype.hasOwnProperty.call(result, "value")) {
        return result.value;
    }

    if (result == null
        || typeof result === "number"
        || typeof result === "string"
        || typeof result === "boolean") {
        return result;
    }

    throw new TypeError(`${command} did not return a scalar result`);
}
