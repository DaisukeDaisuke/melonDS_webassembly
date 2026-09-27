import createModule from './dist/melonds.js';

let wasm;
const ids = new Set();
const romLoaded = new Set();
const paused = new Set();
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
const cpu = label => label === 'ARM7' ? 7 : label === 'ARM9' ? 9 : (() => { throw Error('cpu must be ARM9 or ARM7'); })();
const positive = (length, max) => {
  if (!Number.isInteger(length) || length < 1 || length > max) throw Error(`length must be 1..${max}`);
  return length;
};
function execute(name, args) {
  if (name === 'listInstances') return [...ids].sort((a, b) => a - b);
  if (name === 'createInstance') {
    const id = args.instanceId ?? Array.from({ length: 16 }, (_, n) => n).find(n => !ids.has(n));
    if (!Number.isInteger(id) || id < 0 || id > 15 || ids.has(id)) throw Error('No free instance slot');
    success(call('web_create', id), name); ids.add(id); paused.add(id); freezes[id].clear(); return { instanceId: id };
  }
  if (name === 'loadRomMany') {
    const rom = new Uint8Array(args.bytes);
    for (const id of args.instanceIds) requireInstance(id);
    return withBytes(rom, pointer => args.instanceIds.map(id => {
      success(call('web_load_rom', id, pointer, rom.length), name);
      romLoaded.add(id); paused.delete(id); return { instanceId: id };
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
  if (name === 'destroyInstance') {
    success(call('web_destroy', id), name); ids.delete(id); romLoaded.delete(id); paused.delete(id); freezes[id].clear();
    return { instanceId: id };
  }
  if (name === 'loadRom') {
    const rom = new Uint8Array(args.bytes);
    return withBytes(rom, pointer => {
      success(call('web_load_rom', id, pointer, rom.length), name);
      romLoaded.add(id); paused.delete(id); return { instanceId: id };
    });
  }
  if (name === 'reset' || name === 'pause' || name === 'resume') {
    if (name !== 'pause' && !romLoaded.has(id)) throw Error('Load a ROM first');
    success(call(`web_${name}`, id), name);
    if (name === 'pause') paused.add(id);
    if (name === 'resume') paused.delete(id);
    return { instanceId: id, paused: paused.has(id) };
  }
  if (name === 'status') return { instanceId: id, loaded: romLoaded.has(id), paused: paused.has(id), frames: call('web_frame_number', id) };
  if (['saveState', 'loadState', 'exportState'].includes(name)) {
    if (!romLoaded.has(id)) throw Error('Load a ROM first');
    const slot = args.slot ?? 0;
    if (!Number.isInteger(slot) || slot < 0 || slot > 9) throw Error('State slot must be 0..9');
    if (name === 'saveState') return { instanceId: id, slot, length: success(call('web_save_state', id, slot), name) };
    if (name === 'loadState') {
      if (args.bytes) {
        const bytes = new Uint8Array(args.bytes);
        return withBytes(bytes, pointer => success(call('web_state_import', id, slot, pointer, bytes.length), name));
      }
      return success(call('web_load_state', id, slot), name);
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
    return withBytes(new Uint8Array(8), pointer => {
      success(call('web_framebuffers', id, pointer), name);
      const view = new DataView(wasm.HEAPU8.buffer);
      const top = view.getUint32(pointer, true), bottom = view.getUint32(pointer + 4, true);
      if (!top || !bottom) throw Error('Framebuffers are unavailable');
      const length = 256 * 192 * 4;
      return { width: 256, height: 192,
        top: Array.from(wasm.HEAPU8.slice(top, top + length)),
        bottom: Array.from(wasm.HEAPU8.slice(bottom, bottom + length)) };
    });
  }
  if (name === 'step') {
    // Instruction stepping requires an execution hook inside the ARM interpreter.
    throw Error('Instruction stepping is not available in this Wasm build');
  }
  if (name === 'getRegisters') {
    const registers = {};
    for (let n = 0; n < 16; n++) registers[`r${n}`] = call('web_register', id, cpu(args.cpu || 'ARM9'), n) >>> 0;
    registers.cpsr = call('web_register', id, cpu(args.cpu || 'ARM9'), 16) >>> 0;
    return registers;
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
    if (!Number.isInteger(address) || address < 0x02000000 || address + length > 0x02400000) {
      throw Error('Search range must be within DS main RAM (02000000..023FFFFF)');
    }
    const limit = positive(args.limit ?? 100, 10000);
    const results = [];
    const chunk = 4096;
    return withBytes(new Uint8Array(chunk + pattern.length - 1), pointer => {
      let overlap = new Uint8Array();
      for (let offset = 0; offset < length; offset += chunk) {
        const count = Math.min(chunk, length - offset);
        success(call('web_read_memory', id, cpu(args.cpu || 'ARM9'), address + offset, pointer, count), name);
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
      }
      return { addresses: results, truncated: false };
    });
  }
  if (name === 'memoryFreeze') {
    const data = new Uint8Array(args.data);
    positive(data.length, 256);
    if (!Number.isInteger(args.address) || args.address < 0 || args.address > 0xffffffff - data.length) throw Error('Invalid freeze address');
    const key = `${cpu(args.cpu || 'ARM9')}:${args.address}`;
    freezes[id].set(key, { address: args.address, cpu: args.cpu || 'ARM9', data });
    return { instanceId: id, address: args.address, length: data.length };
  }
  if (name === 'listMemoryFreezes') return [...freezes[id].values()].map(item => ({ address: item.address, cpu: item.cpu, data: Array.from(item.data) }));
  if (name === 'removeMemoryFreeze') return { removed: freezes[id].delete(`${cpu(args.cpu || 'ARM9')}:${args.address}`) };
  if (name === 'batch') {
    if (!Array.isArray(args.commands) || args.commands.length > 64) throw Error('Batch must contain at most 64 commands');
    return args.commands.map(item => {
      if (!item || typeof item.name !== 'string' || item.name === 'batch'
        || item.args?.instanceId !== id) throw Error('Every batch command must specify the same instanceId');
      return execute(item.name, item.args);
    });
  }
  if (name === 'input') {
    const bit = buttons[args.key]; if (bit === undefined) throw Error('Unknown key');
    masks[id] = args.pressed ? masks[id] & ~(1 << bit) : masks[id] | (1 << bit);
    return success(call('web_key_mask', id, masks[id]), name);
  }
  throw Error(`${name} is not implemented by the melonDS Wasm backend`);
}

function frame(id) {
  if (call('web_frame', id) < 0) return;
  for (const item of freezes[id].values()) {
    withBytes(item.data, pointer => call('web_write_memory', id, cpu(item.cpu), item.address, pointer, item.data.length));
  }
  const ptr = call('malloc', 8);
  try {
    if (call('web_framebuffers', id, ptr) < 0) return;
    const view = new DataView(wasm.HEAPU8.buffer);
    const length = 256 * 192 * 4;
    const topPtr = view.getUint32(ptr, true), bottomPtr = view.getUint32(ptr + 4, true);
    if (!topPtr || !bottomPtr) return;
    const top = wasm.HEAPU8.slice(topPtr, topPtr + length);
    const bottom = wasm.HEAPU8.slice(bottomPtr, bottomPtr + length);
    postMessage({ type: 'event', event: { type: 'frame', instanceId: id, top, bottom } }, [top.buffer, bottom.buffer]);
  } finally { call('free', ptr); }
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

onmessage = async ({ data }) => {
  try {
    const args = { ...data.args };
    if (args.file instanceof Blob) {
      args.bytes = await args.file.arrayBuffer();
      delete args.file;
    }
    postMessage({ id: data.id, result: execute(data.name, args) });
  } catch (error) { postMessage({ id: data.id, error: String(error?.message || error) }); }
};

wasm = await createModule({ locateFile: path => new URL(`./dist/${path}`, import.meta.url).href });
postMessage({ type: 'ready' });
setInterval(() => {
  for (const id of ids) frame(id);
  drainLogs();
  drainWifi();
}, 1000 / 60);
