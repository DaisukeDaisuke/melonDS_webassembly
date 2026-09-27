export function createUtilityCommands(context) {
    const { ensureWasmReady, native, splitBinaryBits } = context;

    return {
        async binaryFloat(params = {}) {
            await ensureWasmReady();
            const bits = Number(params.bits ?? params.size ?? 32);
            if (bits !== 32 && bits !== 64) throw new Error("bits must be 32 or 64");
            const operation = String(params.op ?? params.action ?? "decode").toLowerCase();
            const encode = operation === "encode";
            const parts = encode ? { low: 0, high: 0 } : splitBinaryBits(params, bits);
            const numeric = encode ? Number(params.value) : 0;
            const result = native.binaryFloat(bits, parts.low, parts.high, numeric, encode);
            result.op = encode ? "encode" : "decode";
            return result;
        }
    };
}
