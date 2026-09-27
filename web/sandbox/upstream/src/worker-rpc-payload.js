import { normalizeStructuredValue, readOwnDataProperty } from "./structured-value-normalizer.js";
import { ResourceLimits } from "./resource-limits.js";

const nativeReflectApply = globalThis.Reflect.apply;
const nativeGetOwnPropertyDescriptor = globalThis.Object.getOwnPropertyDescriptor;
const nativeDefineProperty = globalThis.Object.defineProperty;
const nativeObjectCreate = globalThis.Object.create;
const nativeArrayIsArray = globalThis.Array.isArray;
const nativeStringPrototype = globalThis.Object.getPrototypeOf("");
const nativeStringTrim = nativeReflectApply(nativeGetOwnPropertyDescriptor, null, [
    nativeStringPrototype,
    "trim"
]).value;
const nativeRegExpPrototype = globalThis.Object.getPrototypeOf(/x/);
const nativeRegExpTest = nativeReflectApply(nativeGetOwnPropertyDescriptor, null, [
    nativeRegExpPrototype,
    "test"
]).value;
const PERSISTENT_MCP_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

const DEFAULT_LIMITS = Object.freeze({
    maxDepth: 10,
    maxNodes: 4096,
    maxProperties: 128,
    maxArray: 1024,
    maxBytes: 256 * 1024
});

export const WorkerByteLimits = Object.freeze({
    injectBytes: Object.freeze({ decodedBytes: 1024 * 1024 }),
    disassembleBytes: Object.freeze({ decodedBytes: 64 * 1024, opcodeWords: 16 * 1024 })
});

const BYTE_COMMAND_SCHEMAS = new Map([
    ["injectBytes", Object.freeze({
        maxBytes: 3 * 1024 * 1024 + 64 * 1024,
        specialArrays: Object.freeze({ bytes: Object.freeze({ kind: "byte", maxItems: 1024 * 1024 }) }),
        stringLimits: Object.freeze({
            base64: 1398104,
            hex: 3 * 1024 * 1024,
            input: 3 * 1024 * 1024,
            text: 3 * 1024 * 1024
        })
    })],
    ["disassembleBytes", Object.freeze({
        maxBytes: 256 * 1024,
        specialArrays: Object.freeze({
            bytes: Object.freeze({ kind: "byte", maxItems: 64 * 1024 }),
            words: Object.freeze({ kind: "uint32", maxItems: 16 * 1024 }),
            opcodes: Object.freeze({ kind: "uint32", maxItems: 16 * 1024 })
        }),
        stringLimits: Object.freeze({
            base64: 87384,
            hex: 192 * 1024,
            input: 192 * 1024,
            text: 192 * 1024,
            opcodes: 192 * 1024
        })
    })]
]);

function copySchemaOptions(options = {}) {
    const output = Object.create(null);
    for (const key of ["maxDepth", "maxNodes", "maxProperties", "maxArray", "maxBytes", "specialArrays", "stringLimits"]) {
        const value = readOwnDataProperty(options, key);
        if (value !== undefined) output[key] = value;
    }
    return output;
}

export function normalizeWorkerProtocolValue(value, options = {}) {
    const safeOptions = copySchemaOptions(options);
    return normalizeStructuredValue(value, {
        ...DEFAULT_LIMITS,
        ...safeOptions
    });
}

export function normalizeWorkerRpcParams(command, params = {}) {
    const schema = BYTE_COMMAND_SCHEMAS.get(command);
    return normalizeWorkerProtocolValue(params, schema || {}).value;
}

export function normalizeWorkerTrigger(trigger) {
    return normalizeWorkerProtocolValue(trigger, { maxBytes: 64 * 1024, maxArray: 256 }).value;
}

function defineDataProperty(target, key, value) {
    nativeReflectApply(nativeDefineProperty, null, [target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
    }]);
}

export function isPersistentMcpName(value) {
    return typeof value === "string"
        && value.length <= ResourceLimits.persistentMcpNameChars
        && nativeReflectApply(nativeRegExpTest, PERSISTENT_MCP_NAME_PATTERN, [value]);
}

export function normalizePersistentMcpDescription(value) {
    if (typeof value !== "string") throw new TypeError("persistent MCP description must be a string");
    const description = nativeReflectApply(nativeStringTrim, value, []);
    if (!description || description.length > ResourceLimits.persistentMcpDescriptionChars) {
        throw new RangeError(
            `persistent MCP description must contain 1..${ResourceLimits.persistentMcpDescriptionChars} characters`
        );
    }
    return description;
}

export function normalizePersistentMcpParams(value) {
    return normalizeWorkerProtocolValue(value, {
        maxBytes: ResourceLimits.persistentMcpParamsBytes,
        maxArray: 4096,
        maxNodes: 10000,
        maxProperties: 1024
    }).value;
}

export function normalizePersistentMcpResult(value) {
    return normalizeWorkerProtocolValue(value === undefined ? null : value, {
        maxBytes: ResourceLimits.persistentMcpResultBytes,
        maxArray: 16384,
        maxNodes: 50000,
        maxProperties: 4096
    }).value;
}

export function normalizePersistentMcpMetadata(value) {
    const normalized = normalizeWorkerProtocolValue(value, {
        maxBytes: 128 * 1024,
        maxArray: ResourceLimits.persistentMcpEndpointsPerScript,
        maxNodes: ResourceLimits.persistentMcpEndpointsPerScript * 4 + 1,
        maxProperties: 3
    }).value;
    if (!nativeArrayIsArray(normalized)) {
        throw new TypeError("persistent MCP metadata must be an array");
    }
    if (normalized.length > ResourceLimits.persistentMcpEndpointsPerScript) {
        throw new RangeError(
            `persistent MCP endpoint limit exceeded (${ResourceLimits.persistentMcpEndpointsPerScript})`
        );
    }
    const names = new Set();
    const output = new Array(normalized.length);
    for (let index = 0; index < normalized.length; index++) {
        const item = normalized[index];
        const name = readOwnDataProperty(item, "name");
        const description = normalizePersistentMcpDescription(readOwnDataProperty(item, "description"));
        if (!isPersistentMcpName(name)) {
            throw new TypeError("persistent MCP name must match ^[A-Za-z][A-Za-z0-9._-]{0,63}$");
        }
        if (names.has(name)) throw new TypeError(`duplicate persistent MCP name: ${name}`);
        names.add(name);
        const metadata = nativeReflectApply(nativeObjectCreate, null, [null]);
        defineDataProperty(metadata, "name", name);
        defineDataProperty(metadata, "description", description);
        defineDataProperty(output, `${index}`, metadata);
    }
    return output;
}
