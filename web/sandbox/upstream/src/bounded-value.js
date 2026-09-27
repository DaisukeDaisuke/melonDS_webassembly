import { normalizeStructuredValue } from "./structured-value-normalizer.js";

export function normalizeBoundedValue(value, options = {}) {
    return normalizeStructuredValue(value, options);
}
