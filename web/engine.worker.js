import createModule from './dist/melonds.js';
import pthreadSource from './dist/melonds.worker.js';
import { decodeInstructions } from './disassemble.js';

export async function startEngine(moduleURL) {
let wasm;
const ids = new Set();
const romLoaded = new Set();
const configuredAccessPoints = new Set();
const paused = new Set();
const visibleScreens = new Set();
const audibleInstances = new Set();
const lastFrames = new Map();
const debugWaiters = new Map();
const cancelledOperations = new Set();
const freezes = Array.from({ length: 16 }, () => new Map());
const history = { 'local-log': [], 'wifi-log': [] };
const masks = Array(16).fill(0xfff);
const buttons = { A: 0, B: 1, SELECT: 2, START: 3, RIGHT: 4, LEFT: 5, UP: 6, DOWN: 7, R: 8, L: 9, X: 10, Y: 11 };
const call = (name, ...args) => wasm[`_${name}`](...args);
const requireInstance = id => {
  if (!Number.isInteger(id) || id < 0 || id > 15 || !ids.has(id)) throw Error(`Instance ${id} does not exist`);
};
const success = (result, name) => {
  if (result < 0) throw Error(`${name}: native operation failed (${result})`);
  return result;
};
function withBytes(bytes, run) {
  const pointer = call('malloc', bytes.length || 1);
  if (!pointer) throw Error('Wasm memory exhausted');
  try { wasm.HEAPU8.set(bytes, pointer); return run(pointer); }
  finally { call('free', pointer); }
}
// melonDS software renderer supplies BGRA pixels; ImageData expects RGBA.
function rgba(bytes) {
  for (let i = 0; i < bytes.length; i += 4) {
    const blue = bytes[i]; bytes[i] = bytes[i + 2]; bytes[i + 2] = blue;
  }
  return bytes;
}
const cpu = label => label === 'ARM7' ? 7 : label === 'ARM9' ? 9 : (() => { throw Error('cpu must be ARM9 or ARM7'); })();
const positive = (length, max) => {
  if (!Number.isInteger(length) || length < 1 || length > max) throw Error(`length must be 1..${max}`);
  return length;
};
function beginDebugWait(id, name, selectedCpu, address, timeoutMs = 30000) {
  if (!romLoaded.has(id)) throw Error('Load a ROM first');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw RangeError('timeoutMs must be 1..120000');
  drainDebug();
  if (debugWaiters.has(id)) throw Error('Another debugger operation is running for this instance');
  success(call(name === 'step' ? 'web_debug_step' : 'web_debug_until', id, selectedCpu,
    ...(name === 'step' ? [] : [address])), name);
  paused.delete(id);
  return new Promise((resolve, reject) => {
    const finish = (error, event) => {
      if (debugWaiters.get(id) !== waiter) return;
      debugWaiters.delete(id); clearTimeout(timer);
      if (error) reject(error); else resolve({ instanceId: id, cpu: selectedCpu === 9 ? 'ARM9' : 'ARM7', stopped: event });
    };
    const waiter = { resolve: event => finish(null, event), reject: error => finish(error) };
    const timer = setTimeout(() => {
      finish(Error(`${name} timed out`));
      try { call('web_pause', id); paused.add(id); } catch { /* instance may have been removed */ }
    }, timeoutMs);
    debugWaiters.set(id, waiter);
  });
}
function execute(name, args) {
  if (name === 'workspaceFlush') { drainLogs(); drainWifi(); return true; }
  if (name === 'workspaceTransport') {
    if (args.data) {
      const result = withBytes(new Uint8Array(args.data), pointer => success(call('web_transport_import', pointer, args.data.length), name));
      for (const id of ids) lastFrames.set(id, -1);
      return result;
    }
    const length = success(call('web_transport_capture'), name), pointer = call('web_transport_pointer');
    return wasm.HEAPU8.slice(pointer, pointer + length);
  }
  if (name === 'listInstances') return [...ids].sort((a, b) => a - b);
  if (name === 'createInstance') {
    const id = args.instanceId ?? Array.from({ length: 16 }, (_, n) => n).find(n => !ids.has(n));
    if (!Number.isInteger(id) || id < 0 || id > 15 || ids.has(id)) throw Error('No free instance slot');
    success(call('web_create', id), name); ids.add(id); paused.add(id); freezes[id].clear();
    lastFrames.set(id, call('web_peek_frame_number', id)); return { instanceId: id };
  }
  if (name === 'loadRomMany') {
    const rom = new Uint8Array(args.bytes);
    for (const id of args.instanceIds) requireInstance(id);
    return withBytes(rom, pointer => args.instanceIds.map(id => {
      debugWaiters.get(id)?.reject(Error('ROM replaced during debugger operation'));
      success(call('web_load_rom', id, pointer, rom.length), name);
      romLoaded.add(id); paused.delete(id); freezes[id].clear(); masks[id] = 0xfff;
      lastFrames.set(id, call('web_peek_frame_number', id)); return { instanceId: id };
    }));
  }
  const { instanceId: id } = args;
  requireInstance(id);
  if (name === 'workspaceCapture') {
    if (!call('web_is_paused', id)) throw Error('Pause the workspace before saving');
    const system = {};
    for (const [kind, value] of [['bios7', 7], ['bios9', 9], ['firmware', 0]]) {
      const length = success(call('web_system_size', id, value), name), pointer = call('web_system_pointer', id, value);
      system[kind] = wasm.HEAPU8.slice(pointer, pointer + length);
    }
    let core = null;
    if (romLoaded.has(id)) {
      const length = success(call('web_workspace_state_capture', id), name), pointer = call('web_workspace_state_pointer');
      core = wasm.HEAPU8.slice(pointer, pointer + length);
    }
    const slots = Array.from({ length: 10 }, (_, slot) => {
      const length = success(call('web_state_size', id, slot), name);
      return withBytes(new Uint8Array(length), pointer => {
        if (length) success(call('web_state_export', id, slot, pointer, length), name);
        return wasm.HEAPU8.slice(pointer, pointer + length);
      });
    });
    return { system, core, slots, mask: masks[id], freezes: [...freezes[id]], configuredAccessPoint: configuredAccessPoints.has(id) };
  }
  if (name === 'workspaceRestore') {
    const saved = args.data;
    if (!call('web_is_paused', id)) throw Error('Pause the workspace before restoring');
    if (saved.core) withBytes(new Uint8Array(saved.core), pointer => success(call('web_state_import', id, 0, pointer, saved.core.length), name));
    for (let slot = 0; slot < 10; slot++) {
      const bytes = new Uint8Array(saved.slots[slot]);
      withBytes(bytes, pointer => success(call('web_workspace_slot_restore', id, slot, pointer, bytes.length), name));
    }
    freezes[id] = new Map(saved.freezes); masks[id] = saved.mask;
    if (saved.configuredAccessPoint) configuredAccessPoints.add(id); else configuredAccessPoints.delete(id);
    lastFrames.set(id, -1); paused.add(id);
    return true;
  }
  if (name === 'localCommLog' || name === 'wifiLog') {
    const type = name === 'localCommLog' ? 'local-log' : 'wifi-log';
    return history[type].filter(entry => entry.instanceId === id || entry.destination === id)
      .slice(-Math.min(Math.max(args.limit || 100, 1), 500));
  }
  if (name === 'injectNetworkFrame') {
    const bytes = new Uint8Array(args.data);
    if (bytes.length < 14 || bytes.length > 2048) throw Error('Ethernet frame length must be 14..2048');
    return withBytes(bytes, pointer => success(call('web_net_enqueue', id, pointer, bytes.length), name));
  }
  if (name === 'setNetworkBackend') {
    if (!['virtual', 'disabled'].includes(args.backend)) throw Error('backend must be virtual or disabled');
    success(call('web_net_backend', id, args.backend === 'virtual' ? 1 : 0), name);
    if (args.backend === 'virtual' && args.configureAccessPoint) {
      success(call('web_prepare_virtual_ap', id), name); configuredAccessPoints.add(id);
    }
    if (args.backend === 'disabled') configuredAccessPoints.delete(id);
    return { instanceId: id, backend: args.backend };
  }
  if (name === 'destroyInstance') {
    debugWaiters.get(id)?.reject(Error('Instance destroyed during debugger operation'));
    success(call('web_destroy', id), name); ids.delete(id); romLoaded.delete(id); paused.delete(id);
    configuredAccessPoints.delete(id);
    freezes[id].clear(); lastFrames.delete(id); masks[id] = 0xfff;
    return { instanceId: id };
  }
  if (name === 'loadRom') {
    debugWaiters.get(id)?.reject(Error('ROM replaced during debugger operation'));
    const rom = new Uint8Array(args.bytes);
    return withBytes(rom, pointer => {
      success(call('web_load_rom', id, pointer, rom.length), name);
      romLoaded.add(id); paused.delete(id); freezes[id].clear(); masks[id] = 0xfff;
      lastFrames.set(id, call('web_peek_frame_number', id)); return { instanceId: id };
    });
  }
  if (name === 'reset' || name === 'pause' || name === 'resume') {
    if (name !== 'pause' && !romLoaded.has(id)) throw Error('Load a ROM first');
    if (name === 'reset') debugWaiters.get(id)?.reject(Error('Instance reset during debugger operation'));
    success(call(`web_${name}`, id), name);
    if (name === 'reset') { lastFrames.set(id, call('web_peek_frame_number', id)); masks[id] = 0xfff; }
    if (name === 'pause') paused.add(id);
    if (name === 'resume') paused.delete(id);
    return { instanceId: id, paused: paused.has(id) };
  }
  if (name === 'status') {
    const isPaused = success(call('web_is_paused', id), name) !== 0;
    const system = success(call('web_system_status', id), name);
    if (isPaused) paused.add(id); else paused.delete(id);
    return { instanceId: id, loaded: romLoaded.has(id), paused: isPaused, frames: call('web_frame_number', id),
      networkBackend: call('web_net_backend_status', id) ? 'virtual' : 'disabled',
      romBytes: call('web_rom_info', id, 0), sharedRomInstances: call('web_rom_info', id, 1),
      system: { bios7: !!(system & 1), bios9: !!(system & 2), firmware: !!(system & 4), nativeBios7: !!(system & 8), nativeBios9: !!(system & 16) } };
  }
  if (name === 'loadSystemFile') {
    const kind = { bios7: 7, bios9: 9, firmware: 0 }[args.kind];
    const bytes = new Uint8Array(args.bytes || []);
    if (kind === undefined) throw Error('kind must be bios7, bios9 or firmware');
    return withBytes(bytes, pointer => {
      success(call('web_system_import', id, kind, pointer, bytes.length), name);
      return { instanceId: id, kind: args.kind, bytes: bytes.length };
    });
  }
  if (['saveState', 'loadState', 'exportState'].includes(name)) {
    if (!romLoaded.has(id)) throw Error('Load a ROM first');
    const slot = args.slot ?? 0;
    if (!Number.isInteger(slot) || slot < 0 || slot > 9) throw Error('State slot must be 0..9');
    if (name === 'saveState') return { instanceId: id, slot, length: success(call('web_save_state', id, slot), name) };
    if (name === 'loadState') {
      if (args.bytes) {
        return (async () => {
        let bytes = new Uint8Array(args.bytes);
        if (bytes.length >= 32 && new TextDecoder().decode(bytes.subarray(0, 14)) === 'DeSmuME SState') {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          if (view.getUint32(16, true) !== 12) throw Error('対応していないDeSmuMEステートのバージョンです');
          const expanded = view.getUint32(24, true), compressed = view.getUint32(28, true);
          if (expanded > 64 * 1024 * 1024) throw Error('ステートが大きすぎます');
          if (compressed !== 0xffffffff) {
            if (compressed !== bytes.length - 32) throw Error('DeSmuMEステートの圧縮長が一致しません');
            const stream = new Blob([bytes.subarray(32)]).stream().pipeThrough(new DecompressionStream('deflate'));
            const reader = stream.getReader();
            const output = new Uint8Array(32 + expanded); output.set(bytes.subarray(0, 32));
            let offset = 32;
            for (;;) {
              const { done, value } = await reader.read(); if (done) break;
              if (value.length > output.length - offset) { await reader.cancel(); throw Error('DeSmuMEステートの展開長が一致しません'); }
              output.set(value, offset); offset += value.length;
            }
            if (offset !== output.length) throw Error('DeSmuMEステートが途中で切れています');
            new DataView(output.buffer).setUint32(28, 0xffffffff, true); bytes = output;
          }
        }
        return withBytes(bytes, pointer => {
          const result = call('web_state_import', id, slot, pointer, bytes.length);
          const messages = { '-20': 'DeSmuMEステートの項目・サイズが一致しません', '-21': 'ステートとROMが一致しません',
            '-22': 'このDeSmuMEステートには処理途中の周辺機器があります', '-23': '未対応のDeSmuME内部形式です', '-24': 'DeSmuMEの描画データを読み込めません' };
          if (result < 0) throw Error(messages[result] || `loadState failed (${result})`);
          if (configuredAccessPoints.has(id)) success(call('web_prepare_virtual_ap', id), name);
          lastFrames.set(id, -1); masks[id] = call('web_key_mask_get', id); return result;
        });
        })();
      }
      const result = success(call('web_load_state', id, slot), name);
      if (configuredAccessPoints.has(id)) success(call('web_prepare_virtual_ap', id), name);
      lastFrames.set(id, -1); masks[id] = call('web_key_mask_get', id); return result;
    }
    const size = success(call('web_state_size', id, slot), name);
    if (!size) throw Error('State slot is empty');
    return withBytes(new Uint8Array(size), pointer => {
      success(call('web_state_export', id, slot, pointer, size), name);
      return Array.from(wasm.HEAPU8.slice(pointer, pointer + size));
    });
  }
  if (name === 'exportSave' || name === 'importSave') {
    if (!romLoaded.has(id)) throw Error('Load a ROM first');
    if (name === 'importSave') {
      if (!args.bytes) throw Error('Save file is required');
      const bytes = new Uint8Array(args.bytes);
      return withBytes(bytes, pointer => success(call('web_save_import', id, pointer, bytes.length), name));
    }
    const size = success(call('web_save_size', id), name);
    if (!size) throw Error('No save data is available');
    return withBytes(new Uint8Array(size), pointer => {
      success(call('web_save_export', id, pointer, size), name);
      return Array.from(wasm.HEAPU8.slice(pointer, pointer + size));
    });
  }
  if (name === 'screenshot') {
    if (!romLoaded.has(id)) throw Error('Load a ROM first');
    return withBytes(new Uint8Array(256 * 192 * 4 * 2), pointer => {
      const length = 256 * 192 * 4;
      success(call('web_copy_frame', id, pointer, length * 2), name);
      return { width: 256, height: 192,
        top: Array.from(rgba(wasm.HEAPU8.slice(pointer, pointer + length))),
        bottom: Array.from(rgba(wasm.HEAPU8.slice(pointer + length, pointer + length * 2))) };
    });
  }
  if (name === 'step') {
    return beginDebugWait(id, name, cpu(args.cpu || 'ARM9'), 0, args.timeoutMs);
  }
  if (name === 'runUntil') {
    if (!Number.isInteger(args.address) || args.address < 0 || args.address > 0xffffffff) throw RangeError('address must be a uint32');
    return beginDebugWait(id, name, cpu(args.cpu || 'ARM9'), args.address, args.timeoutMs);
  }
  if (name === 'stepOver' || name === 'smartStep') {
    const selectedCpu = cpu(args.cpu || 'ARM9');
    const cpsr = call('web_register', id, selectedCpu, 16) >>> 0;
    const address = call('web_register', id, selectedCpu, 15) >>> 0;
    const width = cpsr & 0x20 ? 2 : 4;
    const data = withBytes(new Uint8Array(4), pointer => {
      success(call('web_read_memory', id, selectedCpu, address, pointer, 4), name);
      return wasm.HEAPU8.slice(pointer, pointer + 4);
    });
    const opcode = data[0] | data[1] << 8 | data[2] << 16 | data[3] << 24;
    const callInstruction = width === 2
      ? (opcode & 0xf800) === 0xf000 && [0xf800, 0xe800].includes((opcode >>> 16) & 0xf800)
        || (opcode & 0xff87) === 0x4780
      : (opcode & 0x0f000000) === 0x0b000000 || ((opcode & 0xfe000000) >>> 0) === 0xfa000000
        || (opcode & 0x0ffffff0) === 0x012fff30;
    return callInstruction
      ? beginDebugWait(id, 'runUntil', selectedCpu, (address + (width === 2 && (opcode & 0xf800) === 0xf000 ? 4 : width)) >>> 0, args.timeoutMs)
      : beginDebugWait(id, 'step', selectedCpu, 0, args.timeoutMs);
  }
  if (name === 'addBreakpoint') {
    const selectedCpu = cpu(args.cpu || 'ARM9');
    const kind = ({ execute: 1, read: 2, write: 3, dataAbort: 7, prefetchAbort: 8, undefinedInstruction: 9, access: 10 })[args.type || 'execute'];
    const address = kind >= 7 && kind <= 9 ? 0 : args.address;
    if (!kind || !Number.isInteger(address) || address < 0 || address > 0xffffffff) {
      throw Error('Breakpoint type or uint32 address is invalid');
    }
    const length = args.length ?? 1;
    return { instanceId: id, id: success(call('web_breakpoint_add', id, selectedCpu, kind, address, length), name),
      cpu: args.cpu || 'ARM9', type: args.type || 'execute', address, length };
  }
  if (name === 'listBreakpoints' || name === 'removeBreakpoint') {
    const count = success(call('web_breakpoint_count', id), name);
    const list = withBytes(new Uint8Array(20), pointer => Array.from({ length: count }, (_, index) => {
      success(call('web_breakpoint_entry', id, index, pointer), name);
      const view = new DataView(wasm.HEAPU8.buffer, pointer, 20);
      return { instanceId: id, id: view.getUint32(0, true), cpu: view.getUint32(4, true) === 9 ? 'ARM9' : 'ARM7',
        type: ({1:'execute',2:'read',3:'write',7:'dataAbort',8:'prefetchAbort',9:'undefinedInstruction',10:'access'})[view.getUint32(8, true)],
        address: view.getUint32(12, true), length: view.getUint32(16, true) };
    }));
    if (name === 'listBreakpoints') return list;
    const selected = list.filter(bp => args.id !== undefined ? bp.id === args.id
      : bp.address === args.address && (!args.cpu || bp.cpu === args.cpu) && (!args.type || bp.type === args.type));
    for (const bp of selected) success(call('web_breakpoint_remove', id, bp.id), name);
    return { instanceId: id, removed: selected.length };
  }
  if (name === 'callStack') {
    const selectedCpu = cpu(args.cpu || 'ARM9');
    const limit = positive(args.limit ?? 32, 128);
    const capacity = 3 + 128 * (5 + limit * 5);
    return withBytes(new Uint8Array(capacity * 4), pointer => {
      const count = success(call('web_call_stack_snapshot', id, selectedCpu, pointer, capacity, limit), name);
      const view = new DataView(wasm.HEAPU8.buffer, pointer, count * 4);
      let offset = 0;
      const next = () => { const value = view.getUint32(offset, true); offset += 4; return value; };
      const laneCount = next(), activeStackId = next(), totalDepth = next(), stacks = [];
      for (let n = 0; n < laneCount; n++) {
        const lane = { id: next(), sp: next(), nowPc: next(), cpsr: next(), depth: next(), frames: [] };
        lane.active = lane.id === activeStackId;
        for (let i = 0; i < lane.depth; i++) lane.frames.push({ caller: next(), callee: next(), returnAddress: next(), sp: next(), cpsr: next(), observed: true });
        stacks.push(lane);
      }
      const active = stacks.find(lane => lane.active);
      return { instanceId: id, cpu: args.cpu || 'ARM9', frames: active?.frames || [], depth: active?.depth || 0, totalDepth, activeStackId, stacks };
    });
  }
  if (name === 'getRegisters') {
    const registers = {};
    for (let n = 0; n < 16; n++) registers[`r${n}`] = call('web_register', id, cpu(args.cpu || 'ARM9'), n) >>> 0;
    registers.cpsr = call('web_register', id, cpu(args.cpu || 'ARM9'), 16) >>> 0;
    if (args.includeTiming) {
      for (const [field, key] of ['halted', 'irq', 'timestamp', 'target', 'arm7Timestamp', 'cpuStop', 'clockShift', 'idleLoop', 'ime', 'ie', 'if', 'ipcFifoControl', 'ipcSync'].entries()) registers[key] = call('web_cpu_info', id, cpu(args.cpu || 'ARM9'), field);
    }
    return registers;
  }
  if (name === 'disassemble') {
    const count = positive(args.count ?? 16, 256);
    const selectedCpu = cpu(args.cpu || 'ARM9');
    const thumb = args.thumb ?? !!(call('web_register', id, selectedCpu, 16) & 0x20);
    const width = thumb ? 2 : 4;
    const size = Math.min(4096, count * width * (thumb ? 2 : 1));
    return withBytes(new Uint8Array(size), pointer => {
      success(call('web_read_memory', id, selectedCpu, args.address >>> 0, pointer, size), name);
      return decodeInstructions(wasm.HEAPU8.slice(pointer, pointer + size), args.address >>> 0, count, thumb, (at, op, isThumb) => {
        const text = call('web_disassemble_opcode', at, op, isThumb ? 1 : 0);
        let end = text;
        while (end < text + 255 && wasm.HEAPU8[end]) end++;
        return new TextDecoder().decode(wasm.HEAPU8.slice(text, end));
      });
    });
  }
  if (name === 'setRegister') {
    const n = args.register === 'cpsr' ? 16 : /^r(?:1[0-5]|[0-9])$/.test(args.register) ? Number(args.register.slice(1)) : -1;
    if (n < 0) throw Error('register must be r0..r15 or cpsr');
    return success(call('web_set_register', id, cpu(args.cpu || 'ARM9'), n, args.value >>> 0), name);
  }
  if (name === 'readMemory' || name === 'writeMemory') {
    const content = name === 'readMemory' ? new Uint8Array(positive(args.length, 4096)) : new Uint8Array(args.data);
    positive(content.length, 4096);
    return withBytes(content, pointer => {
      success(call(name === 'readMemory' ? 'web_read_memory' : 'web_write_memory', id, cpu(args.cpu || 'ARM9'), args.address >>> 0, pointer, content.length), name);
      return name === 'readMemory' ? Array.from(wasm.HEAPU8.slice(pointer, pointer + content.length)) : content.length;
    });
  }
  if (name === 'memorySearch') {
    if (!romLoaded.has(id)) throw Error('Load a ROM first');
    const address = args.address ?? 0x02000000;
    const length = positive(args.length ?? 0x400000, 0x400000);
    const pattern = new Uint8Array(args.pattern);
    positive(pattern.length, 256);
    const selectedCpu = cpu(args.cpu || 'ARM9');
    const regions = [[0x02000000, 0x02400000], [0x03000000, 0x03008000],
      ...(selectedCpu === 7 ? [[0x03800000, 0x03810000]] : [])];
    if (!Number.isInteger(address) || !regions.some(([start, end]) => address >= start && address + length <= end)) {
      throw Error('Search range must be inside main RAM, shared WRAM, or ARM7 WRAM');
    }
    const limit = positive(args.limit ?? 100, 10000);
    const results = [];
    const chunk = 4096;
    return (async () => {
      const pointer = call('malloc', chunk);
      if (!pointer) throw Error('Wasm memory exhausted');
      try {
      let overlap = new Uint8Array();
      for (let offset = 0; offset < length; offset += chunk) {
        if (args.operationId && cancelledOperations.has(args.operationId)) throw Error('Operation cancelled');
        const count = Math.min(chunk, length - offset);
        success(call('web_read_memory', id, selectedCpu, address + offset, pointer, count), name);
        const current = wasm.HEAPU8.slice(pointer, pointer + count);
        const window = new Uint8Array(overlap.length + current.length);
        window.set(overlap); window.set(current, overlap.length);
        for (let i = 0; i <= window.length - pattern.length; i++) {
          if (pattern.every((value, n) => value === window[i + n])) {
            results.push(address + offset - overlap.length + i);
            if (results.length >= limit) return { addresses: results, truncated: true };
          }
        }
        overlap = window.slice(Math.max(0, window.length - pattern.length + 1));
        if (offset % (chunk * 16) === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      return { addresses: results, truncated: false };
      } finally { call('free', pointer); if (args.operationId) cancelledOperations.delete(args.operationId); }
    })();
  }
  if (name === 'memoryFreeze') {
    const data = new Uint8Array(args.data);
    positive(data.length, 256);
    if (!Number.isInteger(args.address) || args.address < 0 || args.address > 0xffffffff - data.length) throw Error('Invalid freeze address');
    const key = `${cpu(args.cpu || 'ARM9')}:${args.address}`;
    withBytes(data, pointer => success(call('web_freeze_set', id, cpu(args.cpu || 'ARM9'), args.address, pointer, data.length), name));
    freezes[id].set(key, { address: args.address, cpu: args.cpu || 'ARM9', data });
    return { instanceId: id, address: args.address, length: data.length };
  }
  if (name === 'listMemoryFreezes') return [...freezes[id].values()].map(item => ({ address: item.address, cpu: item.cpu, data: Array.from(item.data) }));
  if (name === 'removeMemoryFreeze') {
    const removed = success(call('web_freeze_remove', id, cpu(args.cpu || 'ARM9'), args.address >>> 0), name);
    freezes[id].delete(`${cpu(args.cpu || 'ARM9')}:${args.address}`);
    return { removed: !!removed };
  }
  if (name === 'batch') {
    if (!Array.isArray(args.commands) || args.commands.length > 64) throw Error('Batch must contain at most 64 commands');
    return (async () => {
      const results = [];
      for (const item of args.commands) {
        if (!item || typeof item.name !== 'string' || item.name === 'batch'
          || item.args?.instanceId !== id) throw Error('Every batch command must specify the same instanceId');
        results.push(await execute(item.name, item.args));
      }
      return results;
    })();
  }
  if (name === 'startInputRecording' || name === 'stopInputRecording') {
    if (!romLoaded.has(id)) throw Error('Load a ROM first');
    const result = success(call(name === 'startInputRecording' ? 'web_input_record_start' : 'web_input_record_stop', id), name);
    return { instanceId: id, recorded: result };
  }
  if (name === 'getInputRecording') {
    const count = success(call('web_input_record_count', id), name);
    const truncated = !!success(call('web_input_record_overflow', id), name);
    return withBytes(new Uint8Array(8), pointer => {
      const events = [];
      for (let index = 0; index < count; index++) {
        success(call('web_input_record_entry', id, index, pointer), name);
        const view = new DataView(wasm.HEAPU8.buffer, pointer, 8);
        events.push({ frame: view.getUint32(0, true), mask: view.getUint32(4, true) });
      }
      return { instanceId: id, events, truncated };
    });
  }
  if (name === 'repeatInput') {
    const keys = args.keys ?? (args.key ? [args.key] : []);
    if (!Array.isArray(keys) || !keys.length || keys.some(key => buttons[key] === undefined)) throw Error('keys must contain DS button names');
    const count = positive(args.count ?? 60, 50000);
    const press = positive(args.pressFrames ?? 2, 60000), release = positive(args.releaseFrames ?? 2, 60000);
    if (count * (press + release) > 0xffffffff) throw Error('Input duration exceeds uint32 frame range');
    let mask = 0xfff;
    for (const key of keys) mask &= ~(1 << buttons[key]);
    const events = [];
    for (let n = 0; n < count; n++) {
      const frame = n * (press + release);
      events.push({ frame, mask }, { frame: frame + press, mask: 0xfff });
    }
    return execute('inputSequence', { ...args, events });
  }
  if (name === 'inputSequence') {
    if (!romLoaded.has(id)) throw Error('Load a ROM first');
    const events = args.events;
    if (!Array.isArray(events) || !events.length || events.length > 100000) throw Error('events must contain 1..100000 frame/mask pairs');
    const bytes = new Uint8Array(events.length * 8), view = new DataView(bytes.buffer);
    let previous = -1;
    for (const [index, event] of events.entries()) {
      if (!Number.isInteger(event?.frame) || event.frame < previous || event.frame > 0xffffffff
        || !Number.isInteger(event?.mask) || event.mask < 0 || event.mask > 0xfff) {
        throw Error('Input events require ascending uint32 frame offsets and 12-bit key masks');
      }
      previous = event.frame;
      view.setUint32(index * 8, event.frame, true);
      view.setUint32(index * 8 + 4, event.mask, true);
    }
    return withBytes(bytes, pointer => {
      success(call('web_input_schedule', id, pointer, events.length), name);
      return { instanceId: id, scheduled: events.length };
    });
  }
  if (name === 'stopInputSequence') {
    success(call('web_input_schedule_stop', id), name);
    success(call('web_key_mask', id, 0xfff), name);
    masks[id] = 0xfff;
    return { instanceId: id, stopped: true };
  }
  if (name === 'touch') {
    if (!Number.isInteger(args.x) || args.x < 0 || args.x > 255 || !Number.isInteger(args.y) || args.y < 0 || args.y > 191) throw RangeError('Touch coordinates must be x=0..255, y=0..191');
    return success(call('web_touch', id, args.x, args.y, args.pressed ? 1 : 0), name);
  }
  if (name === 'input') {
    const bit = buttons[args.key]; if (bit === undefined) throw Error('Unknown key');
    masks[id] = success(call('web_key_mask_get', id), name);
    masks[id] = args.pressed ? masks[id] & ~(1 << bit) : masks[id] | (1 << bit);
    return success(call('web_key_mask', id, masks[id]), name);
  }
  throw Error(`${name} is not implemented by the melonDS Wasm backend`);
}

function pollFrame(id) {
  if (!romLoaded.has(id)) return;
  const number = call('web_peek_frame_number', id);
  if (number < 0 || number === lastFrames.get(id)) return;
  // A tick does not require a screen tile; persistent scripts depend on it.
  if (!visibleScreens.has(id)) {
    lastFrames.set(id, number);
    postMessage({ type: 'event', event: { type: 'frame', instanceId: id, frame: number } });
    return;
  }
  const length = 256 * 192 * 4;
  const ptr = call('malloc', length * 2);
  if (!ptr) throw Error('Wasm memory exhausted while copying screen');
  try {
    if (call('web_copy_frame', id, ptr, length * 2) < 0) {
      postMessage({ type: 'event', event: { type: 'frame', instanceId: id, frame: number } });
      return;
    }
    const top = rgba(wasm.HEAPU8.slice(ptr, ptr + length));
    const bottom = rgba(wasm.HEAPU8.slice(ptr + length, ptr + length * 2));
    lastFrames.set(id, number);
    postMessage({ type: 'event', event: { type: 'frame', instanceId: id, frame: number, top, bottom } }, [top.buffer, bottom.buffer]);
  } finally { call('free', ptr); }
}
function pollAudio(id) {
  if (!romLoaded.has(id) || !audibleInstances.has(id)) return;
  const capacity = 4096;
  const pointer = call('malloc', capacity * 4);
  if (!pointer) throw Error('Wasm memory exhausted while reading audio');
  try {
    const frames = call('web_read_audio', id, pointer, capacity);
    if (frames <= 0) return;
    const samples = new Int16Array(wasm.HEAPU8.slice(pointer, pointer + frames * 4).buffer);
    postMessage({ type: 'event', event: { type: 'audio', instanceId: id, samples } }, [samples.buffer]);
  } finally { call('free', pointer); }
}
function drainLogs() {
  const count = call('web_log_count');
  if (!count) return;
  const meta = call('malloc', 32), payload = call('malloc', 0x948);
  try {
    for (let i = 0; i < count; i++) {
      const length = call('web_log_entry', i, meta, payload, 0x948);
      if (length < 0) continue;
      const view = new DataView(wasm.HEAPU8.buffer, meta, 32);
      const type = view.getUint32(12, true), src = view.getUint32(16, true);
      emit({
        type: 'local-log', instanceId: src, destination: view.getInt32(20, true),
        timestamp: `${view.getUint32(4, true)}:${view.getUint32(0, true)}`,
        packetType: ['PACKET', 'CMD', 'REPLY', 'ACK'][type & 3] || 'PACKET',
        direction: view.getUint32(24, true) ? 'RX' : 'TX',
        senderId: src, length, dropped: view.getUint32(28, true),
        payload: Array.from(wasm.HEAPU8.slice(payload, payload + length))
      });
    }
  } finally { call('free', meta); call('free', payload); }
}
function emit(event) {
  const entries = history[event.type];
  if (entries) {
    entries.push(event);
    if (entries.length > 2000) entries.splice(0, entries.length - 2000);
  }
  postMessage({ type: 'event', event });
}
function drainWifi() {
  const count = call('web_net_log_count');
  if (!count) return;
  const meta = call('malloc', 20), payload = call('malloc', 2048);
  try {
    for (let i = 0; i < count; i++) {
      const length = call('web_net_log_entry', i, meta, payload, 2048);
      if (length < 0) continue;
      const view = new DataView(wasm.HEAPU8.buffer, meta, 20);
      const bytes = Array.from(wasm.HEAPU8.slice(payload, payload + length));
      emit({ type: 'wifi-log', instanceId: view.getInt32(8, true), direction: view.getUint32(12, true) ? 'RX' : 'TX',
        timestamp: `${view.getUint32(4, true)}:${view.getUint32(0, true)}`,
        packetType: length >= 14 ? `ETH ${bytes[12].toString(16).padStart(2, '0')}${bytes[13].toString(16).padStart(2, '0')}` : 'ETH',
        length, dropped: view.getUint32(16, true), payload: bytes });
    }
  } finally { call('free', meta); call('free', payload); }
}
function drainDebug() {
  const count = call('web_debug_event_count');
  if (!count) return;
  const pointer = call('malloc', 32);
  if (!pointer) throw Error('Wasm memory exhausted while reading debugger events');
  try {
    for (let index = 0; index < count; index++) {
      if (call('web_debug_event_entry', index, pointer) < 0) continue;
      const view = new DataView(wasm.HEAPU8.buffer, pointer, 32);
      const id = view.getUint32(0, true), kind = view.getUint32(8, true);
      const event = { type: kind <= 3 ? 'breakpoint' : 'debug-stop', instanceId: id,
        cpu: view.getUint32(4, true) === 9 ? 'ARM9' : 'ARM7',
        kind: ['', 'execute', 'read', 'write', 'step', 'runUntil', 'pause'][kind],
        breakpointId: view.getUint32(12, true), address: view.getUint32(16, true),
        pc: view.getUint32(20, true), frame: view.getUint32(24, true), dropped: view.getUint32(28, true) };
      paused.add(id);
      emit(event);
      debugWaiters.get(id)?.resolve(event);
    }
  } finally { call('free', pointer); }
}

let requests = Promise.resolve();
onmessage = ({ data }) => {
  if (data.type === 'screens') {
    for (const id of data.instanceIds) if (!visibleScreens.has(id)) lastFrames.set(id, -1);
    visibleScreens.clear();
    for (const id of data.instanceIds) if (Number.isInteger(id) && id >= 0 && id < 16) visibleScreens.add(id);
    return;
  }
  if (data.type === 'audio-targets') {
    audibleInstances.clear();
    for (const id of data.instanceIds) if (Number.isInteger(id) && id >= 0 && id < 16) audibleInstances.add(id);
    return;
  }
  if (data.type === 'cancel-operation') {
    if (typeof data.operationId === 'string') cancelledOperations.add(data.operationId);
    return;
  }
  // Blob decoding yields to the event loop. Keep all native operations in
  // arrival order even if a second request arrives before decoding finishes.
  requests = requests.then(async () => {
    try {
    const args = { ...data.args };
    if (args.file instanceof Blob) {
      args.bytes = await args.file.arrayBuffer();
      delete args.file;
    }
    const result = execute(data.name, args);
    void Promise.resolve(result).then(value => postMessage({ id: data.id, result: value }),
      error => postMessage({ id: data.id, error: String(error?.message || error) }));
    } catch (error) { if (!/^Instance \d+ does not exist$/.test(error?.message || '')) console.error(`melonDS ${data.name}`, error?.stack || error); postMessage({ id: data.id, error: String(error?.message || error) }); }
  });
};

const pthreadURL = URL.createObjectURL(new Blob([pthreadSource], { type: 'text/javascript' }));
wasm = await createModule({
  mainScriptUrlOrBlob: moduleURL,
  locateFile: path => path.endsWith('.worker.js') ? pthreadURL : new URL('./melonds.wasm', moduleURL).href
});
postMessage({ type: 'ready' });
setInterval(() => {
  for (const id of ids) { pollFrame(id); pollAudio(id); }
  drainLogs();
  drainWifi();
  drainDebug();
}, 1000 / 60);
}
