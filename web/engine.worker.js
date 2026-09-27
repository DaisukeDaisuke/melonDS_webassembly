import createModule from './dist/melonds.js';

let wasm;
const ids = new Set();
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
    success(call('web_create', id), name); ids.add(id); return { instanceId: id };
  }
  if (name === 'loadRomMany') {
    const rom = new Uint8Array(args.bytes);
    for (const id of args.instanceIds) requireInstance(id);
    return withBytes(rom, pointer => args.instanceIds.map(id => {
      success(call('web_load_rom', id, pointer, rom.length), name); return { instanceId: id };
    }));
  }
  const { instanceId: id } = args;
  requireInstance(id);
  if (name === 'destroyInstance') { success(call('web_destroy', id), name); ids.delete(id); return { instanceId: id }; }
  if (name === 'loadRom') {
    const rom = new Uint8Array(args.bytes);
    return withBytes(rom, pointer => success(call('web_load_rom', id, pointer, rom.length), name));
  }
  if (name === 'reset' || name === 'pause' || name === 'resume') return success(call(`web_${name}`, id), name);
  if (name === 'status') return { instanceId: id, frames: call('web_frame', id) };
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
  if (name === 'input') {
    const bit = buttons[args.key]; if (bit === undefined) throw Error('Unknown key');
    masks[id] = args.pressed ? masks[id] & ~(1 << bit) : masks[id] | (1 << bit);
    return success(call('web_key_mask', id, masks[id]), name);
  }
  throw Error(`${name} is not implemented by the melonDS Wasm backend`);
}

function frame(id) {
  if (call('web_frame', id) < 0) return;
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
      postMessage({ type: 'event', event: {
        type: 'local-log', instanceId: src, destination: view.getInt32(20, true),
        timestamp: `${view.getUint32(4, true)}:${view.getUint32(0, true)}`,
        packetType: ['PACKET', 'CMD', 'REPLY', 'ACK'][type & 3] || 'PACKET',
        direction: view.getUint32(24, true) ? 'RX' : 'TX',
        senderId: src, length, dropped: view.getUint32(28, true),
        payload: Array.from(wasm.HEAPU8.slice(payload, payload + length))
      } });
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
}, 1000 / 60);
