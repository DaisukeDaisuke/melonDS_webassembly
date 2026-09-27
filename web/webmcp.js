// Every operation is discoverable on its own; the shared dispatcher stays internal.
import { compactOutputText } from './sandbox/upstream/src/compact-output.js';

const uint = { type: 'integer', minimum: 0, maximum: 4294967295 };
const bytes = { type: 'array', items: { type: 'integer', minimum: 0, maximum: 255 } };
const cpu = { type: 'string', enum: ['ARM9', 'ARM7'] };
const toolInputs = {
  status: [{}, []], pause: [{}, []], resume: [{}, []], reset: [{}, []],
  step: [{ cpu }, []], stepOver: [{ cpu }, []],
  runUntil: [{ cpu, address: uint, timeoutMs: { type: 'integer', minimum: 1 } }, ['address']],
  readMemory: [{ cpu, address: uint, length: { type: 'integer', minimum: 1, maximum: 4096 } }, ['address', 'length']],
  writeMemory: [{ cpu, address: uint, data: bytes }, ['address', 'data']],
  memorySearch: [{ cpu, address: uint, length: uint, pattern: bytes, limit: uint }, ['pattern']],
  memoryFreeze: [{ cpu, address: uint, data: bytes }, ['address', 'data']],
  removeMemoryFreeze: [{ cpu, address: uint }, ['address']],
  getRegisters: [{ cpu }, []],
  setRegister: [{ cpu, register: { type: 'string' }, value: uint }, ['register', 'value']],
  disassemble: [{ cpu, address: uint, count: { type: 'integer', minimum: 1, maximum: 256 }, thumb: { type: 'boolean' } }, ['address']],
  addBreakpoint: [{ cpu, address: uint, type: { type: 'string', enum: ['execute', 'read', 'write'] }, length: uint }, ['address']],
  removeBreakpoint: [{ id: uint, address: uint, cpu }, []],
  listBreakpoints: [{ cpu }, []], callStack: [{ cpu, limit: uint }, []],
  loadState: [{ slot: { type: 'integer', minimum: 0, maximum: 9 } }, []],
  saveState: [{ slot: { type: 'integer', minimum: 0, maximum: 9 } }, []],
  exportState: [{ slot: { type: 'integer', minimum: 0, maximum: 9 } }, []],
  saveStateToBrowser: [{ slot: { type: 'integer', minimum: 0, maximum: 9 } }, []],
  loadStateFromBrowser: [{ slot: { type: 'integer', minimum: 0, maximum: 9 } }, []],
  input: [{ key: { type: 'string' }, pressed: { type: 'boolean' } }, ['key', 'pressed']],
  touch: [{ x: { type: 'integer', minimum: 0, maximum: 255 }, y: { type: 'integer', minimum: 0, maximum: 191 }, pressed: { type: 'boolean' } }, ['x', 'y', 'pressed']],
  inputSequence: [{ events: { type: 'array', items: { type: 'object', properties: { frame: uint, mask: uint }, required: ['frame', 'mask'] } } }, ['events']],
  waitFrames: [{ frames: { type: 'integer', minimum: 1 }, timeoutMs: uint }, ['frames']],
  waitMemory: [{ address: uint, cpu, pattern: bytes, timeoutMs: uint }, ['address', 'pattern']],
  compareFrames: [{ threshold: { type: 'integer', minimum: 0, maximum: 255 } }, []],
  runScript: [{ code: { type: 'string' } }, ['code']],
  startPersistentScript: [{ name: { type: 'string' }, code: { type: 'string' }, asyncMode: { type: 'boolean' } }, ['name', 'code']],
  stopPersistentScript: [{ name: { type: 'string' } }, ['name']],
  restartPersistentScript: [{ name: { type: 'string' } }, ['name']],
  callPersistentScriptMcp: [{ scriptName: { type: 'string' }, name: { type: 'string' }, params: { type: 'object' } }, ['scriptName', 'name']],
  batch: [{ commands: { type: 'array', maxItems: 64, items: { type: 'object' } } }, ['commands']],
  localCommLog: [{ limit: { type: 'integer', minimum: 1, maximum: 500 } }, []],
  wifiLog: [{ limit: { type: 'integer', minimum: 1, maximum: 500 } }, []],
  operationStatus: [{ instanceId: { type: 'integer', minimum: 0, maximum: 15 } }, []],
  cancelOperation: [{ instanceId: { type: 'integer', minimum: 0, maximum: 15 } }, []],
  setNetworkBackend: [{ backend: { type: 'string', enum: ['virtual', 'disabled'] } }, ['backend']]
};

function compactResult(value, name) {
  if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    && ['readMemory', 'exportState', 'exportSave'].includes(name)) {
    return `ok=true\nlength=${value.length}\nhex=${value.slice(0, 256).map(byte => byte.toString(16).padStart(2, '0')).join(' ')}${value.length > 256 ? '\ntruncated=true' : ''}`;
  }
  if (name === 'screenshot' && value?.top && value?.bottom) {
    return `ok=true\nwidth=${value.width}\nheight=${value.height}\ntop.bytes=${value.top.length}\nbottom.bytes=${value.bottom.length}`;
  }
  return compactOutputText({ ok: true, value }).slice(0, 64 * 1024);
}

export async function registerWebMcp(api, modelContext = document.modelContext || navigator.modelContext) {
  if (!modelContext?.registerTool) return 0;
  let count = 0;
  for (const name of api.toolNames()) {
    const globalTool = ['listInstances', 'createInstance', 'loadRomMany', 'operationStatus', 'cancelOperation'].includes(name);
    const binaryTool = ['loadRom', 'loadRomMany', 'loadState', 'importSave'].includes(name);
    const [operationProperties, operationRequired] = toolInputs[name] || [{}, []];
    const schema = {
      type: 'object', properties: {
        ...(!globalTool ? { instanceId: { type: 'integer', minimum: 0, maximum: 15 } } : {}),
        ...operationProperties,
        ...(binaryTool ? { fileBase64: { type: 'string', description: 'Local ROM/state/save bytes, base64 encoded.' } } : {}),
        ...(name === 'loadRomMany' ? { instanceIds: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 15 }, minItems: 1, maxItems: 16 } } : {}),
        ...(['operationStatus', 'cancelOperation'].includes(name) ? { operationId: { type: 'string' } } : {})
      },
      required: [...(globalTool ? [] : ['instanceId']), ...(name === 'loadRom' || name === 'loadRomMany' || name === 'importSave' ? ['fileBase64'] : []),
        ...(name === 'loadRomMany' ? ['instanceIds'] : []),
        ...(['operationStatus', 'cancelOperation'].includes(name) ? ['operationId'] : []),
        ...operationRequired], additionalProperties: true
    };
    try {
      await modelContext.registerTool({
        name: `melonds.${name}`, title: `melonDS ${name}`,
        description: `${name} operates on the actual melonDS backend and resolves when it finishes. ${['operationStatus', 'cancelOperation'].includes(name) ? 'Provide instanceId for an instance-bound operation; global create operations need only operationId.' : globalTool ? 'Global operation.' : 'An explicit instanceId is required.'}`,
        inputSchema: schema,
        execute: async args => {
          try {
            const params = typeof args === 'string' ? JSON.parse(args) : { ...args };
            if (binaryTool && params.fileBase64 !== undefined) {
              if (typeof params.fileBase64 !== 'string' || !/^[a-zA-Z0-9+/]*={0,2}$/.test(params.fileBase64)) {
                throw new TypeError('fileBase64 must be valid base64');
              }
              const decoded = atob(params.fileBase64);
              const bytes = new Uint8Array(decoded.length);
              for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
              params.file = new Blob([bytes]);
              delete params.fileBase64;
            }
            const value = await api[name](params);
            return { content: [{ type: 'text', text: compactResult(value, name) }] };
          }
          catch (error) { return { isError: true, content: [{ type: 'text', text: compactOutputText({ ok: false, error: { message: String(error.message || error) } }).slice(0, 2048) }] }; }
        }
      });
      count++;
    } catch (error) {
      console.warn(`WebMCP registration failed: melonds.${name}`, error);
    }
  }
  return count;
}
