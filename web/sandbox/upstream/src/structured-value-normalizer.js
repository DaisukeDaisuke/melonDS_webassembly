const NativeArray = globalThis.Array;
const NativeArrayBuffer = globalThis.ArrayBuffer;
const NativeUint8Array = globalThis.Uint8Array;
const NativeSet = globalThis.Set;
const NativeTextEncoder = globalThis.TextEncoder;
const NativeTypeError = globalThis.TypeError;
const NativeRangeError = globalThis.RangeError;
const NativeNumber = globalThis.Number;

const nativeReflectApply = globalThis.Reflect.apply;
const nativeArrayIsArray = NativeArray.isArray;
const nativeArrayBufferIsView = NativeArrayBuffer.isView;
const nativeGetPrototypeOf = globalThis.Object.getPrototypeOf;
const nativeGetOwnPropertyDescriptor = globalThis.Object.getOwnPropertyDescriptor;
const nativeGetOwnPropertyDescriptors = globalThis.Object.getOwnPropertyDescriptors;
const nativeObjectKeys = globalThis.Object.keys;
const nativeObjectCreate = globalThis.Object.create;
const nativeDefineProperty = globalThis.Object.defineProperty;
const nativeObjectPrototype = nativeReflectApply(nativeGetPrototypeOf, null, [{}]);
const nativeHasOwnProperty = nativeReflectApply(nativeGetOwnPropertyDescriptor, null, [
    nativeObjectPrototype,
    "hasOwnProperty"
]).value;
const nativeNumberIsFinite = globalThis.Number.isFinite;
const nativeNumberIsInteger = globalThis.Number.isInteger;
const nativeNumberIsSafeInteger = globalThis.Number.isSafeInteger;
const nativeSetPrototype = nativeReflectApply(nativeGetPrototypeOf, null, [new NativeSet()]);
const nativeSetHas = nativeReflectApply(nativeGetOwnPropertyDescriptor, null, [nativeSetPrototype, "has"]).value;
const nativeSetAdd = nativeReflectApply(nativeGetOwnPropertyDescriptor, null, [nativeSetPrototype, "add"]).value;
const nativeSetDelete = nativeReflectApply(nativeGetOwnPropertyDescriptor, null, [nativeSetPrototype, "delete"]).value;
const trustedTextEncoder = new NativeTextEncoder();
const nativeTextEncoderPrototype = nativeReflectApply(nativeGetPrototypeOf, null, [trustedTextEncoder]);
const nativeTextEncode = findPrototypeValue(nativeTextEncoderPrototype, "encode");
const nativeStringPrototype = nativeReflectApply(nativeGetPrototypeOf, null, [""]);
const nativeStringTrim = nativeReflectApply(nativeGetOwnPropertyDescriptor, null, [nativeStringPrototype, "trim"]).value;
const nativeStringReplace = nativeReflectApply(nativeGetOwnPropertyDescriptor, null, [nativeStringPrototype, "replace"]).value;
const nativeRegExpPrototype = nativeReflectApply(nativeGetPrototypeOf, null, [/x/]);
const nativeRegExpTest = nativeReflectApply(nativeGetOwnPropertyDescriptor, null, [nativeRegExpPrototype, "test"]).value;
const nativeUint8Prototype = nativeReflectApply(nativeGetPrototypeOf, null, [new NativeUint8Array(0)]);
const nativeTypedArrayPrototype = nativeReflectApply(nativeGetPrototypeOf, null, [nativeUint8Prototype]);
const nativeTypedArrayByteLength = nativeReflectApply(nativeGetOwnPropertyDescriptor, null, [
    nativeTypedArrayPrototype,
    "byteLength"
]).get;
const nativeArrayBufferPrototype = nativeReflectApply(nativeGetPrototypeOf, null, [new NativeArrayBuffer(0)]);
const nativeArrayBufferByteLength = nativeReflectApply(nativeGetOwnPropertyDescriptor, null, [
    nativeArrayBufferPrototype,
    "byteLength"
]).get;

const DEFAULT_LIMITS = Object.freeze({
    maxDepth: 12,
    maxNodes: 2000,
    maxBytes: 256 * 1024,
    maxArray: 256,
    maxProperties: 256
});

const MAXIMUM_LIMITS = Object.freeze({
    maxDepth: 64,
    maxNodes: 100000,
    maxBytes: 16 * 1024 * 1024,
    maxArray: 1024 * 1024,
    maxProperties: 4096
});

function callIntrinsic(fn, receiver, args) {
    return nativeReflectApply(fn, receiver, args);
}

function findPrototypeValue(prototype, key) {
    let current = prototype;
    while (current) {
        const descriptor = callIntrinsic(nativeGetOwnPropertyDescriptor, null, [current, key]);
        if (descriptor && hasOwn(descriptor, "value")) return descriptor.value;
        current = callIntrinsic(nativeGetPrototypeOf, null, [current]);
    }
    throw new NativeTypeError(`${key} intrinsic is unavailable`);
}

function hasOwn(value, key) {
    return callIntrinsic(nativeHasOwnProperty, value, [key]);
}

export function readOwnDataProperty(object, key) {
    if (object === null || (typeof object !== "object" && typeof object !== "function")) return undefined;
    const descriptor = callIntrinsic(nativeGetOwnPropertyDescriptor, null, [object, key]);
    if (!descriptor || !hasOwn(descriptor, "value")) return undefined;
    return descriptor.value;
}

function readLimit(options, key, fallback) {
    const value = readOwnDataProperty(options, key);
    if (value === undefined) return fallback;
    return validateLimitValue(value, key, MAXIMUM_LIMITS[key]);
}

function validateLimitValue(value, key, maximum) {
    if (!callIntrinsic(nativeNumberIsSafeInteger, null, [value])
        || value < 0
        || value > maximum) {
        throw new NativeRangeError(`${key} must be a finite non-negative safe integer within the trusted maximum`);
    }
    return value;
}

function utf8Length(text) {
    const encoded = callIntrinsic(nativeTextEncode, trustedTextEncoder, [text]);
    return callIntrinsic(nativeTypedArrayByteLength, encoded, []);
}

function getSpecial(options, group, path) {
    const entries = readOwnDataProperty(options, group);
    return readOwnDataProperty(entries, path);
}

function getUint8Length(value) {
    try {
        if (callIntrinsic(nativeGetPrototypeOf, null, [value]) !== nativeUint8Prototype) return -1;
        return callIntrinsic(nativeTypedArrayByteLength, value, []);
    } catch {
        return -1;
    }
}

function isArrayBuffer(value) {
    try {
        callIntrinsic(nativeArrayBufferByteLength, value, []);
        return true;
    } catch {
        return false;
    }
}

function defineDataProperty(target, key, value) {
    callIntrinsic(nativeDefineProperty, null, [target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true
    }]);
}

export function normalizeStructuredValue(value, options = {}) {
    const limits = {
        maxDepth: readLimit(options, "maxDepth", DEFAULT_LIMITS.maxDepth),
        maxNodes: readLimit(options, "maxNodes", DEFAULT_LIMITS.maxNodes),
        maxBytes: readLimit(options, "maxBytes", DEFAULT_LIMITS.maxBytes),
        maxArray: readLimit(options, "maxArray", DEFAULT_LIMITS.maxArray),
        maxProperties: readLimit(options, "maxProperties", DEFAULT_LIMITS.maxProperties)
    };
    const seen = new NativeSet();
    let nodes = 0;
    let bytes = 0;
    const chargeBytes = (amount) => {
        bytes += amount;
        if (bytes > limits.maxBytes) throw new NativeRangeError("structured value exceeds byte budget");
    };
    const visit = (input, depth, path) => {
        nodes++;
        if (nodes > limits.maxNodes) throw new NativeRangeError("structured value exceeds node budget");
        if (depth > limits.maxDepth) throw new NativeRangeError("structured value exceeds depth budget");
        if (input === null) { chargeBytes(4); return null; }
        if (typeof input === "boolean") { chargeBytes(input ? 4 : 5); return input; }
        if (typeof input === "number") {
            if (!callIntrinsic(nativeNumberIsFinite, null, [input])) {
                throw new NativeTypeError("structured numbers must be finite");
            }
            chargeBytes(16);
            return input;
        }
        if (typeof input === "string") {
            const length = utf8Length(input);
            const stringLimit = getSpecial(options, "stringLimits", path);
            const boundedStringLimit = stringLimit === undefined
                ? undefined
                : validateLimitValue(stringLimit, `stringLimits.${path}`, limits.maxBytes);
            if (boundedStringLimit !== undefined && length > boundedStringLimit) {
                throw new NativeRangeError("structured string exceeds field budget");
            }
            chargeBytes(length);
            return input;
        }
        if (typeof input !== "object") throw new NativeTypeError(`unsupported structured value: ${typeof input}`);
        if (callIntrinsic(nativeSetHas, seen, [input])) throw new NativeTypeError("cyclic structured values are unavailable");

        const specialArray = getSpecial(options, "specialArrays", path);
        const uint8Length = getUint8Length(input);
        if (uint8Length >= 0) {
            if (!specialArray || readOwnDataProperty(specialArray, "kind") !== "byte") {
                throw new NativeTypeError("binary structured values are unavailable in this field");
            }
            const rawMaxItems = readOwnDataProperty(specialArray, "maxItems");
            const maxItems = rawMaxItems === undefined
                ? limits.maxArray
                : validateLimitValue(rawMaxItems, "maxItems", MAXIMUM_LIMITS.maxArray);
            if (uint8Length > maxItems) {
                throw new NativeRangeError("structured byte input exceeds field budget");
            }
            chargeBytes(uint8Length);
            const output = new NativeUint8Array(uint8Length);
            for (let index = 0; index < uint8Length; index++) output[index] = input[index];
            return output;
        }
        if (callIntrinsic(nativeArrayBufferIsView, null, [input]) || isArrayBuffer(input)) {
            throw new NativeTypeError("unsupported binary structured value");
        }

        callIntrinsic(nativeSetAdd, seen, [input]);
        try {
            if (callIntrinsic(nativeArrayIsArray, null, [input])) {
                const specialKind = readOwnDataProperty(specialArray, "kind");
                const rawMaxItems = readOwnDataProperty(specialArray, "maxItems");
                const maximum = specialArray && rawMaxItems !== undefined
                    ? validateLimitValue(rawMaxItems, "maxItems", MAXIMUM_LIMITS.maxArray)
                    : limits.maxArray;
                if (input.length > maximum) throw new NativeRangeError("structured array exceeds item budget");
                const output = new NativeArray(input.length);
                if (specialKind === "byte" || specialKind === "uint32") {
                    for (let index = 0; index < input.length; index++) {
                        const indexKey = `${index}`;
                        const descriptor = callIntrinsic(nativeGetOwnPropertyDescriptor, null, [input, indexKey]);
                        if (!descriptor || !hasOwn(descriptor, "value")) {
                            throw new NativeTypeError("structured arrays must be dense data arrays");
                        }
                        const item = descriptor.value;
                        if (typeof item === "string") {
                            const tokenLength = utf8Length(item);
                            if (tokenLength > 16) throw new NativeRangeError(`structured ${specialKind} array token exceeds field budget`);
                            const trimmed = callIntrinsic(nativeStringTrim, item, []);
                            const text = callIntrinsic(nativeStringReplace, trimmed, [/^0x/i, ""]);
                            if (!callIntrinsic(nativeRegExpTest, /^[0-9a-f]+$/i, [text])) {
                                throw new NativeTypeError(`structured ${specialKind} array contains an invalid value`);
                            }
                            chargeBytes(tokenLength);
                            defineDataProperty(output, indexKey, item);
                            continue;
                        }
                        if (!callIntrinsic(nativeNumberIsInteger, null, [item])
                            || item < 0
                            || item > (specialKind === "byte" ? 0xff : 0xffffffff)) {
                            throw new NativeTypeError(`structured ${specialKind} array contains an invalid value`);
                        }
                        defineDataProperty(output, indexKey, item);
                    }
                    chargeBytes(input.length * (specialKind === "byte" ? 1 : 4));
                    return output;
                }
                for (let index = 0; index < input.length; index++) {
                    const indexKey = `${index}`;
                    const descriptor = callIntrinsic(nativeGetOwnPropertyDescriptor, null, [input, indexKey]);
                    if (!descriptor || !hasOwn(descriptor, "value")) {
                        throw new NativeTypeError("structured arrays must be dense data arrays");
                    }
                    defineDataProperty(output, indexKey, visit(
                        descriptor.value,
                        depth + 1,
                        `${path}[${index}]`
                    ));
                }
                return output;
            }
            const prototype = callIntrinsic(nativeGetPrototypeOf, null, [input]);
            if (prototype !== nativeObjectPrototype && prototype !== null) {
                throw new NativeTypeError("only plain structured objects are available");
            }
            const descriptors = callIntrinsic(nativeGetOwnPropertyDescriptors, null, [input]);
            const keys = callIntrinsic(nativeObjectKeys, null, [descriptors]);
            if (keys.length > limits.maxProperties) {
                throw new NativeRangeError("structured object exceeds property budget");
            }
            const output = callIntrinsic(nativeObjectCreate, null, [null]);
            for (let index = 0; index < keys.length; index++) {
                const key = keys[index];
                const descriptorHolder = callIntrinsic(nativeGetOwnPropertyDescriptor, null, [descriptors, key]);
                const descriptor = descriptorHolder.value;
                if (!hasOwn(descriptor, "value")) throw new NativeTypeError("structured accessors are unavailable");
                chargeBytes(utf8Length(key));
                defineDataProperty(output, key, visit(
                    descriptor.value,
                    depth + 1,
                    path ? `${path}.${key}` : key
                ));
            }
            return output;
        } finally {
            callIntrinsic(nativeSetDelete, seen, [input]);
        }
    };
    return { value: visit(value, 0, ""), bytes, nodes };
}
