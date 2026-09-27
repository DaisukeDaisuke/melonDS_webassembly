const metadataByParams = new WeakMap();

export function withInternalMetadata(params = {}, metadata = {}) {
    const internalParams = { ...params };
    metadataByParams.set(internalParams, Object.freeze({ ...metadata }));
    return internalParams;
}

export function getInternalMetadata(params) {
    return params && typeof params === "object"
        ? metadataByParams.get(params) || Object.freeze({})
        : Object.freeze({});
}
