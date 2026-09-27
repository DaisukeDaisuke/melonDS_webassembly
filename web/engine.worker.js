import createModule from './dist/melonds.js';
import { decodeInstructions } from './disassemble.js';

let wasm;
const ids = new Set();
const romLoaded = new Set();
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
    return { instanceId: id, backend: args.backend };
  }
  if (name === 'destroyInstance') {
    debugWaiters.get(id)?.reject(Error('Instance destroyed during debugger operation'));
    success(call('web_destroy', id), name); ids.delete(id); romLoaded.delete(id); paused.delete(id);
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
    if (isPaused) paused.add(id); else paused.delete(id);
    return { instanceId: id, loaded: romLoaded.has(id), paused: isPaused, frames: call('web_frame_number', id),
      networkBackend: call('web_net_backend_status', id) ? 'virtual' : 'disabled' };
  }
  if (['saveState', 'loadState', 'exportState'].includes(name)) {
    if (!romLoaded.has(id)) throw Error('Load a ROM first');
    const slot = args.slot ?? 0;
    if (!Number.isInteger(slot) || slot < 0 || slot > 9) throw Error('State slot must be 0..9');
    if (name === 'saveState') return { instanceId: id, slot, length: success(call('web_save_state', id, slot), name) };
    if (name === 'loadState') {
      if (args.bytes) {
        const bytes = new Uint8Array(args.bytes);
        return withBytes(bytes, pointer => {
          const result = success(call('web_state_import', id, slot, pointer, bytes.length), name);
          lastFrames.set(id, call('web_peek_frame_number', id)); return result;
        });
      }
      const result = success(call('web_load_state', id, slot), name);
      lastFrames.set(id, call('web_peek_frame_number', id)); return result;
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
  if (name === 'stepOver') {
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
      ? (opcode & 0xf800) === 0xf000 && ((opcode >>> 16) & 0xf800) === 0xf800
        || (opcode & 0xff87) === 0x4780
      : (opcode & 0x0f000000) === 0x0b000000 || ((opcode & 0xfe000000) >>> 0) === 0xfa000000
        || (opcode & 0x0ffffff0) === 0x012fff30;
    return callInstruction
      ? beginDebugWait(id, 'runUntil', selectedCpu, (address + (width === 2 && (opcode & 0xf800) === 0xf000 ? 4 : width)) >>> 0, args.timeoutMs)
      : beginDebugWait(id, 'step', selectedCpu, 0, args.timeoutMs);
  }
  if (name === 'addBreakpoint') {
    const selectedCpu = cpu(args.cpu || 'ARM9');
    const kind = ({ execute: 1, read: 2, write: 3 })[args.type || 'execute'];
    if (!kind || !Number.isInteger(args.address) || args.address < 0 || args.address > 0xffffffff) {
      throw Error('Breakpoint requires execute/read/write and a uint32 address');
    }
    const length = args.length ?? 1;
    return { instanceId: id, id: success(call('web_breakpoint_add', id, selectedCpu, kind, args.address, length), name),
      cpu: args.cpu || 'ARM9', type: args.type || 'execute', address: args.address, length };
  }
  if (name === 'listBreakpoints' || name === 'removeBreakpoint') {
    const count = success(call('web_breakpoint_count', id), name);
    const list = withBytes(new Uint8Array(20), pointer => Array.from({ length: count }, (_, index) => {
      success(call('web_breakpoint_entry', id, index, pointer), name);
      const view = new DataView(wasm.HEAPU8.buffer, pointer, 20);
      return { instanceId: id, id: view.getUint32(0, true), cpu: view.getUint32(4, true) === 9 ? 'ARM9' : 'ARM7',
        type: ['none', 'execute', 'read', 'write'][view.getUint32(8, true)],
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
    const count = success(call('web_call_stack_count', id, selectedCpu), name);
    const limit = positive(args.limit ?? 32, 128);
    return withBytes(new Uint8Array(20), pointer => {
      const frames = [];
      for (let index = 0; index < Math.min(count, limit); index++) {
        success(call('web_call_stack_entry', id, selectedCpu, index, pointer), name);
        const view = new DataView(wasm.HEAPU8.buffer, pointer, 20);
        frames.push({ caller: view.getUint32(0, true), callee: view.getUint32(4, true),
          returnAddress: view.getUint32(8, true), sp: view.getUint32(12, true),
          cpsr: view.getUint32(16, true), reconstructed: true });
      }
      return { instanceId: id, cpu: args.cpu || 'ARM9', frames, depth: count };
    });
  }
  if (name === 'getRegisters') {
    const registers = {};
    for (let n = 0; n < 16; n++) registers[`r${n}`] = call('web_register', id, cpu(args.cpu || 'ARM9'), n) >>> 0;
    registers.cpsr = call('web_register', id, cpu(args.cpu || 'ARM9'), 16) >>> 0;
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
      return decodeInstructions(wasm.HEAPU8.slice(pointer, pointer + size), args.address >>> 0, count, thumb);
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
    return { instanceId: id, stopped: true };
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
  lastFrames.set(id, number);
  // A tick does not require a screen tile; persistent scripts depend on it.
  if (!visibleScreens.has(id)) {
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
    } catch (error) { postMessage({ id: data.id, error: String(error?.message || error) }); }
  });
};

wasm = await createModule({ locateFile: path => new URL(`./dist/${path}`, import.meta.url).href });
postMessage({ type: 'ready' });
setInterval(() => {
  for (const id of ids) { pollFrame(id); pollAudio(id); }
  drainLogs();
  drainWifi();
  drainDebug();
}, 1000 / 60);
