export const MAX_INSTANCES = 16;

export function instanceId(value) {
  if (!Number.isInteger(value) || value < 0 || value >= MAX_INSTANCES) {
    throw new RangeError('instanceId must be an integer from 0 to 15');
  }
  return value;
}

const METHODS = Object.freeze({
  createInstance: 'global', listInstances: 'global', loadRomMany: 'global',
  destroyInstance: 'instance', status: 'instance', pause: 'instance', resume: 'instance',
  reset: 'instance', step: 'instance', stepOver: 'instance', runUntil: 'instance',
  loadRom: 'instance', loadState: 'instance', saveState: 'instance',
  exportState: 'instance', importSave: 'instance', exportSave: 'instance',
  getRegisters: 'instance', setRegister: 'instance', readMemory: 'instance',
  writeMemory: 'instance', memorySearch: 'instance', memoryFreeze: 'instance',
  listMemoryFreezes: 'instance', removeMemoryFreeze: 'instance',
  disassemble: 'instance', addBreakpoint: 'instance',
  removeBreakpoint: 'instance', listBreakpoints: 'instance', input: 'instance',
  screenshot: 'instance', localCommLog: 'instance', wifiLog: 'instance',
  injectNetworkFrame: 'instance',
  runScript: 'instance', startPersistentScript: 'instance',
  stopPersistentScript: 'instance', restartPersistentScript: 'instance',
  listPersistentScripts: 'instance', callPersistentScriptMcp: 'instance',
  batch: 'instance'
});

// The backend must acknowledge completed operations, not queued requests.
export function createApi(backend) {
  if (!backend || typeof backend.execute !== 'function') {
    throw new TypeError('A completion-aware melonDS backend is required');
  }
  const tails = new Map();
  const api = {};

  const execute = (name, args = {}) => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return Promise.reject(new TypeError('Arguments must be an object'));
    }
    if (name === 'createInstance' && args.instanceId !== undefined) instanceId(args.instanceId);
    if (METHODS[name] === 'instance') instanceId(args.instanceId);
    if (name === 'loadRomMany') {
      if (!Array.isArray(args.instanceIds) || !args.instanceIds.length) {
        throw new TypeError('instanceIds must be a nonempty array');
      }
      args.instanceIds.forEach(instanceId);
      if (new Set(args.instanceIds).size !== args.instanceIds.length) {
        throw new TypeError('instanceIds must be unique');
      }
    }
    if (name === 'loadRom' || name === 'loadRomMany') {
      if (!(args.file instanceof Blob)) throw new TypeError('file must be a Blob');
    }
    if ((name === 'loadState' || name === 'importSave') && args.file !== undefined && !(args.file instanceof Blob)) {
      throw new TypeError('file must be a Blob');
    }
    const ids = name === 'loadRomMany' ? args.instanceIds :
      METHODS[name] === 'instance' ? [args.instanceId] : [];
    // Barrier across all instances for bulk ROM load. Rejections must not poison the queue.
    const prior = Promise.all(ids.map(id => tails.get(id)?.catch(() => {}) || Promise.resolve()));
    const operation = prior.then(() => backend.execute(name, args));
    for (const id of ids) tails.set(id, operation);
    return operation;
  };

  for (const name of Object.keys(METHODS)) {
    api[name] = async args => execute(name, args);
  }
  api.toolNames = () => Object.keys(METHODS);
  api.subscribe = listener => {
    if (typeof backend.subscribe !== 'function') throw new Error('Backend does not support events');
    return backend.subscribe(listener);
  };
  return Object.freeze(api);
}

export function missingBackend() {
  return {
    async execute() {
      throw new Error('melonDS Wasm backend is not built or connected. See PLAN.md.');
    },
    subscribe() { return () => {}; }
  };
}
