import { codedError, memorySize, positiveInteger } from "../validation.js";
import { ErrorCode } from "../error-codes.js";
import { ResourceLimits } from "../resource-limits.js";
import { WorkerByteLimits } from "../worker-rpc-payload.js";

export function createMemoryCommands(context) {
    const {
        applyFreezes,
        bigEndianValue,
        bytesFromFlexibleParams,
        ensureRomLoaded,
        hex,
        log,
        matchSearchCondition,
        memorySearchRangeKey,
        memorySearchRanges,
        native,
        openPicker,
        parseAddress,
        parseNumber,
        readFileFromInput,
        readSized,
        renderFreezes,
        renderMemoryDump,
        state,
        swap16,
        swap32,
        ui
    } = context;

    function assertAddressRange(address, length) {
        if (address + length > 0x100000000) {
            throw codedError(ErrorCode.INVALID_ARGUMENT, "memory range exceeds uint32 address space");
        }
    }

    function refreshInjectedCurrentInstruction(cpu, address, length) {
        if (length <= 0) return;
        const pc = native.getPc(cpu) >>> 0;
        const cpsr = native.getRegister(cpu, 16) >>> 0;
        const thumb = (cpsr & 0x20) !== 0;
        const instructionSize = thumb ? 2 : 4;
        const injectionEnd = address + length;
        const instructionEnd = pc + instructionSize;
        if (address >= instructionEnd || injectionEnd <= pc) return;
        native.setRegister(cpu, 15, thumb ? (pc | 1) : pc);
    }

    const memoryCommands = {
        async applyMemoryFreezes() {
            applyFreezes();
            return { applied: state.freezes.filter((item) => item.enabled !== false).length };
        },

        async dumpMemory(params = {}) {
            ensureRomLoaded("memory dump requires a loaded ROM");
            const address = parseAddress(params.address ?? ui.memoryAddress.value, 0, params.cpu);
            const length = positiveInteger(params.length ?? ui.memoryLength.value, "length", 65536);
            assertAddressRange(address, length);
            const view = String(params.view ?? ui.memoryView?.value ?? "mixed");
            const bytes = [...native.dumpMemory(params.cpu, address, length)];
            const lines = [];
            const words32 = [];
            for (let offset = 0; offset < bytes.length; offset += 16) {
                const slice = bytes.slice(offset, offset + 16);
                const formattedWords = [];
                for (let inner = 0; inner + 3 < slice.length; inner += 4) {
                    const word = readSized(slice, inner, 4);
                    words32.push({ address: address + offset + inner, value: word });
                    formattedWords.push(hex(word));
                }
                const byteText = slice.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
                if (view === "packed32") {
                    lines.push(`${hex(address + offset)}  ${formattedWords.join("  ")}`);
                } else if (view === "bytes") {
                    lines.push(`${hex(address + offset)}  ${byteText}`);
                } else {
                    const wordText = formattedWords.length ? `    ${formattedWords.join("  ")}` : "";
                    lines.push(`${hex(address + offset)}  ${byteText}${wordText}`);
                }
            }
            return { address, bytes, words32, view, text: lines.join("\n") };
        },

        async injectMemoryFile(params = {}) {
            ensureRomLoaded("memory injection requires a loaded ROM");
            const address = parseAddress(params.address ?? ui.memoryAddress.value, 0, params.cpu);
            const selected = params.bytes
                ? { file: { name: params.name || "api-bytes" }, bytes: new Uint8Array(params.bytes) }
                : ui.memoryInjectFile.files && ui.memoryInjectFile.files[0]
                    ? await readFileFromInput(ui.memoryInjectFile)
                    : await openPicker(ui.memoryInjectFile);
            const { file, bytes } = selected;
            assertAddressRange(address, bytes.length);
            for (let offset = 0; offset < bytes.length; offset += 1) {
                native.writeMemory(params.cpu, address + offset, bytes[offset], 1);
            }
            refreshInjectedCurrentInstruction(params.cpu, address, bytes.length);
            log(`memory injected: ${file.name} -> ${hex(address)} (${bytes.length} bytes)`);
            const visibleStart = parseAddress(ui.memoryAddress.value, 0, params.cpu);
            const visibleLength = Number(ui.memoryLength.value);
            if (address >= visibleStart && address < visibleStart + visibleLength) {
                renderMemoryDump(await memoryCommands.dumpMemory({ cpu: params.cpu }));
            }
            return { ok: true, address, size: bytes.length, name: file.name };
        },

        async injectBytes(params = {}) {
            const bytes = bytesFromFlexibleParams(params, WorkerByteLimits.injectBytes.decodedBytes);
            return memoryCommands.injectMemoryFile({
                ...params,
                bytes: [...bytes],
                name: params.name || "api-bytes"
            });
        },

        async searchMemory(params = {}) {
            ensureRomLoaded("memory search requires a loaded ROM");
            const ranges = memorySearchRanges(params);
            const rangeKey = memorySearchRangeKey(ranges);
            const size = memorySize(params.size ?? ui.searchSize.value);
            const condition = String(params.condition ?? ui.searchCondition.value);
            const value = parseNumber(params.value ?? ui.searchValue.value);
            const limit = positiveInteger(params.limit ?? ui.searchLimit.value, "limit", 10000);
            for (const range of ranges) assertAddressRange(range.address, range.length);
            const refine = params.refine !== false
                && state.search.snapshot
                && state.search.rangeKey === rangeKey
                && state.search.size === size;
            if (refine && state.search.candidateSetComplete === false) {
                throw codedError(
                    ErrorCode.INVALID_ARGUMENT,
                    "Previous search exceeded the candidate limit; start a narrower search before refining",
                    { candidateLimit: ResourceLimits.memorySearchCandidates }
                );
            }
            const snapshots = new Map();
            const previousSnapshots = refine ? state.search.snapshot : null;
            const candidates = refine && state.search.addresses ? state.search.addresses : null;
            const matches = [];
            const candidateAddresses = [];
            let totalCandidates = 0;
            const findRange = (address) => ranges.find((range) => (
                address >= range.address && address + size <= range.address + range.length
            ));
            const scanRange = (range, offsets) => {
                const current = native.dumpMemory(params.cpu, range.address, range.length);
                snapshots.set(range.name, current);
                const previous = previousSnapshots?.get ? previousSnapshots.get(range.name) : null;
                const maxOffset = Math.max(0, range.length - size);
                const testOffset = (offset) => {
                    if (offset < 0 || offset > maxOffset) return false;
                    const nowValue = readSized(current, offset, size);
                    const oldValue = previous && offset + size <= previous.length
                        ? readSized(previous, offset, size)
                        : 0;
                    if (!matchSearchCondition(condition, nowValue, oldValue, value, !!previous)) return false;
                    totalCandidates++;
                    if (candidateAddresses.length < ResourceLimits.memorySearchCandidates) {
                        candidateAddresses.push(range.address + offset);
                    }
                    if (matches.length < limit) matches.push({
                        address: range.address + offset,
                        range: range.name,
                        value: nowValue,
                        previous: previous ? oldValue : null
                    });
                    return false;
                };
                if (offsets) {
                    for (const offset of offsets) {
                        if (testOffset(offset)) return true;
                    }
                } else {
                    for (let offset = 0; offset <= maxOffset; offset += size) {
                        if (testOffset(offset)) return true;
                    }
                }
                return false;
            };

            if (candidates) {
                const byRange = new Map();
                for (const address of candidates) {
                    const range = findRange(address);
                    if (!range) continue;
                    if (!byRange.has(range.name)) byRange.set(range.name, []);
                    byRange.get(range.name).push(address - range.address);
                }
                for (const range of ranges) {
                    if (scanRange(range, byRange.get(range.name) || [])) break;
                }
            } else {
                for (const range of ranges) {
                    if (scanRange(range, null)) break;
                }
            }

            state.search = {
                snapshot: snapshots,
                ranges,
                addresses: Uint32Array.from(candidateAddresses),
                candidateSetComplete: totalCandidates <= ResourceLimits.memorySearchCandidates,
                address: ranges[0]?.address ?? 0,
                length: ranges.reduce((sum, range) => sum + range.length, 0),
                size,
                rangeKey
            };
            const text = matches.map((item) => {
                const previous = item.previous === null
                    ? ""
                    : `  prev ${hex(item.previous, size * 2)}`;
                return `${item.range} ${hex(item.address)}  ${hex(item.value, size * 2)}${previous}`;
            }).join("\n") || "no matches";
            return {
                ranges,
                size,
                condition,
                totalShown: matches.length,
                totalCandidates,
                candidateSetComplete: totalCandidates <= ResourceLimits.memorySearchCandidates,
                truncated: totalCandidates > matches.length,
                matches,
                text
            };
        },

        async resetMemorySearch() {
            state.search = {
                snapshot: null,
                ranges: null,
                addresses: null,
                candidateSetComplete: true,
                address: 0,
                length: 0,
                size: 1,
                rangeKey: ""
            };
            ui.searchOutput.textContent = "search reset";
            return { ok: true };
        },

        async writeMemory(params) {
            ensureRomLoaded("memory write requires a loaded ROM");
            const address = parseAddress(params.address, 0, params.cpu);
            const value = parseNumber(params.value);
            const size = memorySize(params.size ?? 1);
            assertAddressRange(address, size);
            native.writeMemory(params.cpu, address, value, size);
            return { ok: true };
        },

        async setMemoryFreeze(params) {
            ensureRomLoaded("memory freeze requires a loaded ROM");
            const item = {
                cpu: String(params.cpu ?? state.selectedCpu),
                address: parseAddress(params.address, 0, params.cpu),
                value: parseNumber(params.value),
                size: memorySize(params.size ?? 1),
                enabled: params.enabled !== false
            };
            state.freezes = state.freezes.filter((entry) => !(
                entry.cpu === item.cpu
                && entry.address === item.address
                && entry.size === item.size
            ));
            if (item.enabled) state.freezes.push(item);
            applyFreezes();
            renderFreezes();
            return { freezes: state.freezes };
        },

        async listMemoryFreezes() {
            return state.freezes;
        },

        async setCTableSeed(params = {}) {
            ensureRomLoaded("CTable write requires a loaded ROM");
            const address = parseAddress(params.address ?? "02385f0c", 0, params.cpu);
            const value = parseNumber(params.value ?? "0x4b539adb");
            const high = parseNumber(params.high ?? 0);
            native.writeMemory(params.cpu, address, value, 4);
            native.writeMemory(params.cpu, address + 4, high, 4);
            return { ok: true, address, value, high };
        },

        async memoryReadByte(params = {}) {
            ensureRomLoaded("memory read requires a loaded ROM");
            return native.readMemory(params.cpu, parseAddress(params.address, 0, params.cpu), 1);
        },

        async memoryReadWord(params = {}) {
            ensureRomLoaded("memory read requires a loaded ROM");
            return swap16(native.readMemory(params.cpu, parseAddress(params.address, 0, params.cpu), 2)) & 0xffff;
        },

        async memoryReadDword(params = {}) {
            ensureRomLoaded("memory read requires a loaded ROM");
            return swap32(native.readMemory(params.cpu, parseAddress(params.address, 0, params.cpu), 4)) >>> 0;
        },

        async memoryWriteByte(params = {}) {
            ensureRomLoaded("memory write requires a loaded ROM");
            const address = parseAddress(params.address, 0, params.cpu);
            const value = bigEndianValue(params.value, 1);
            native.writeMemory(params.cpu, address, value, 1);
            return { ok: true, address: hex(address), value: hex(value, 2), endian: "big" };
        },

        async memoryWriteWord(params = {}) {
            ensureRomLoaded("memory write requires a loaded ROM");
            const address = parseAddress(params.address, 0, params.cpu);
            native.writeMemory(params.cpu, address, bigEndianValue(params.value, 2), 2);
            return {
                ok: true,
                address: hex(address),
                value: hex(parseNumber(params.value), 4),
                endian: "big"
            };
        },

        async memoryWriteDword(params = {}) {
            ensureRomLoaded("memory write requires a loaded ROM");
            const address = parseAddress(params.address, 0, params.cpu);
            native.writeMemory(params.cpu, address, bigEndianValue(params.value, 4), 4);
            return {
                ok: true,
                address: hex(address),
                value: hex(parseNumber(params.value)),
                endian: "big"
            };
        }
    };

    return memoryCommands;
}
