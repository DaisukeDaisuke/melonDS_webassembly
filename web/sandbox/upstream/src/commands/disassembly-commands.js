import { ErrorCode } from "../error-codes.js";
import { codedError, positiveInteger } from "../validation.js";
import { WorkerByteLimits } from "../worker-rpc-payload.js";

export function createDisassemblyCommands(context) {
    const {
        bytesFromFlexibleParams,
        ensureRomLoaded,
        ensureWasmReady,
        formatDisassemblyText,
        getPc,
        getRegisters,
        instructionWidthForMode,
        modeNumber,
        native,
        opcodeWordsFromInput,
        parseAddress,
        parseNumber,
        shouldIncludeDisassemblyBytes,
        u16FromBytes,
        u32FromBytes,
        ui
    } = context;

    const disassemblyCommands = {
        async getRegisters(params = {}) {
            return getRegisters(params.cpu);
        },

        async setRegister(params) {
            ensureRomLoaded("register write requires a loaded ROM");
            const register = String(params.register).toLowerCase();
            const names = { sp: 13, lr: 14, pc: 15, cpsr: 16, spsr: 17 };
            const index = names[register] ?? Number(register.replace("r", ""));
            if (!Number.isInteger(index) || index < 0 || index > 17) {
                throw new Error(`unknown register: ${register}`);
            }
            const value = parseNumber(params.value);
            if (index === 15) {
                const registers = getRegisters(params.cpu);
                const thumb = (value & 1) !== 0 || (Number(registers.cpsr) & 0x20) !== 0;
                if (!thumb && (value & 3) !== 0) {
                    throw codedError(ErrorCode.INVALID_ARGUMENT, "ARM PC writes must be 4-byte aligned", {
                        value
                    });
                }
            }
            const ret = native.setRegister(params.cpu, index, value);
            if (ret !== 0) throw codedError(ErrorCode.NATIVE_ERROR, `Register write failed (${ret})`, { nativeCode: ret });
            if (index === 15) {
                return { ret, pc: getPc(params.cpu) >>> 0 };
            }
            return { ret };
        },

        async disassemble(params = {}) {
            ensureRomLoaded("disassembly requires a loaded ROM");
            const mode = params.mode ?? ui.disasmMode.value;
            const before = Math.max(0, Math.min(64, Number(params.before ?? ui.disasmBefore.value ?? 0)));
            const width = instructionWidthForMode(mode, params.cpu);
            const base = parseAddress(
                params.address ?? ui.disasmAddress.value,
                getPc(params.cpu),
                params.cpu
            );
            const address = (base - before * width) >>> 0;
            const count = positiveInteger(params.count ?? ui.disasmCount.value, "count", 100000);
            const includeBytes = shouldIncludeDisassemblyBytes(params);
            const text = native.disassemble(params.cpu, address, count + before, modeNumber(mode));
            return {
                address,
                before,
                includeBytes,
                text: formatDisassemblyText(text, includeBytes)
            };
        },

        async disassembleBytes(params = {}) {
            await ensureWasmReady();
            const mode = String(params.mode ?? "arm").toLowerCase();
            if (mode !== "arm" && mode !== "thumb") throw new Error("mode must be arm or thumb");
            const modeId = mode === "thumb" ? 1 : 2;
            const width = mode === "thumb" ? 2 : 4;
            const endian = String(params.endian ?? params.byteOrder ?? "little").toLowerCase();
            const start = parseAddress(params.address ?? params.base ?? 0, 0, params.cpu);
            const rows = [];
            let incompleteBytes = 0;
            const words = opcodeWordsFromInput(params, WorkerByteLimits.disassembleBytes.opcodeWords);
            if (words) {
                words.forEach((word, index) => {
                    const opcode = mode === "thumb" ? word & 0xffff : word >>> 0;
                    const address = (start + index * width) >>> 0;
                    const mnemonic = native.disassembleOpcode(address, opcode, modeId);
                    rows.push({
                        offset: index * width,
                        address,
                        opcode,
                        mnemonic,
                        undefined: mnemonic.includes("UNDEFINED")
                    });
                });
            } else {
                const bytes = bytesFromFlexibleParams(params, WorkerByteLimits.disassembleBytes.decodedBytes);
                const usable = bytes.length - (bytes.length % width);
                incompleteBytes = bytes.length - usable;
                for (let offset = 0; offset < usable; offset += width) {
                    const opcode = mode === "thumb"
                        ? u16FromBytes(bytes, offset, endian)
                        : u32FromBytes(bytes, offset, endian);
                    const address = (start + offset) >>> 0;
                    const mnemonic = native.disassembleOpcode(address, opcode, modeId);
                    rows.push({
                        offset,
                        address,
                        opcode,
                        mnemonic,
                        undefined: mnemonic.includes("UNDEFINED")
                    });
                }
            }
            const hasUndefined = rows.some((row) => row.undefined);
            return {
                complete: !hasUndefined && incompleteBytes === 0,
                error: hasUndefined || incompleteBytes > 0,
                hasUndefined,
                incompleteBytes,
                mode,
                endian,
                count: rows.length,
                rows,
                text: rows.map((row) => `${row.offset}: ${row.mnemonic}`).join("\n")
            };
        },

        async memoryGetRegister(params = {}) {
            ensureRomLoaded("register read requires a loaded ROM");
            const register = String(params.register ?? params.reg ?? "pc").toLowerCase();
            const value = getRegisters(params.cpu)[register];
            if (value === undefined) throw new Error(`unknown register: ${register}`);
            return value >>> 0;
        },

        async memorySetRegister(params = {}) {
            ensureRomLoaded("register write requires a loaded ROM");
            return disassemblyCommands.setRegister({
                cpu: params.cpu,
                register: params.register ?? params.reg,
                value: params.value
            });
        }
    };

    return disassemblyCommands;
}
