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
  reset: 'instance', step: 'instance', stepOver: 'instance', smartStep: 'instance', runUntil: 'instance',
  loadRom: 'instance', loadSystemFile: 'instance', loadState: 'instance', saveState: 'instance',
  exportState: 'instance', importSave: 'instance', exportSave: 'instance',
  saveStateToBrowser: 'instance', loadStateFromBrowser: 'instance',
  saveSaveToBrowser: 'instance', loadSaveFromBrowser: 'instance', listBrowserStates: 'instance',
  getRegisters: 'instance', setRegister: 'instance', readMemory: 'instance',
  writeMemory: 'instance', memorySearch: 'instance', memoryFreeze: 'instance',
  listMemoryFreezes: 'instance', removeMemoryFreeze: 'instance',
  disassemble: 'instance', addBreakpoint: 'instance',
  removeBreakpoint: 'instance', listBreakpoints: 'instance', callStack: 'instance', input: 'instance',
  startInputRecording: 'instance', stopInputRecording: 'instance', getInputRecording: 'instance',
  inputSequence: 'instance', repeatInput: 'instance', stopInputSequence: 'instance', touch: 'instance',
  screenshot: 'instance', localCommLog: 'instance', wifiLog: 'instance',
  captureFrame: 'instance', compareFrames: 'instance',
  injectNetworkFrame: 'instance', setNetworkBackend: 'instance',
  setPacketInterceptor: 'instance', pendingPackets: 'instance', commitPacket: 'instance',
  setPacketRoutes: 'instance', injectLocalPacket: 'instance',
  runScript: 'instance', startPersistentScript: 'instance',
  stopPersistentScript: 'instance', restartPersistentScript: 'instance',
  listPersistentScripts: 'instance', callPersistentScriptMcp: 'instance',
  batch: 'instance', operationStatus: 'global', cancelOperation: 'global',
  waitFrames: 'instance', waitMemory: 'instance'
});

// The backend must acknowledge completed operations, not queued requests.
export function createApi(backend) {
  if (!backend || typeof backend.execute !== 'function') {
    throw new TypeError('A completion-aware melonDS backend is required');
  }
  const tails = new Map();
  const operations = new Map();
  const api = {};

  const execute = (name, args = {}) => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return Promise.reject(new TypeError('Arguments must be an object'));
    }
    if (name === 'createInstance' && args.instanceId !== undefined) instanceId(args.instanceId);
    if (METHODS[name] === 'instance') instanceId(args.instanceId);
    if (name === 'operationStatus' || name === 'cancelOperation') {
      const operation = operations.get(args.operationId);
      if (!operation) throw new Error('Operation not found');
      if (operation.ids.length && !operation.ids.includes(instanceId(args.instanceId))) {
        throw new Error('Operation not found for this instance');
      }
      if (name === 'operationStatus') return Promise.resolve({ operationId: args.operationId,
        status: operation.status, instanceIds: [...operation.ids],
        createdAt: operation.createdAt, startedAt: operation.startedAt, finishedAt: operation.finishedAt,
        ...(operation.error ? { error: operation.error } : {}) });
      if (operation.status === 'running' && operation.controller) {
        operation.controller.abort();
        return operation.promise.then(() => ({ operationId: args.operationId, cancelled: false, status: operation.status }),
          () => ({ operationId: args.operationId, cancelled: operation.status === 'cancelled', status: operation.status }));
      }
      if (operation.status === 'running' && operation.cancellable && typeof backend.cancelOperation === 'function') {
        operation.cancelRequested = true;
        backend.cancelOperation(args.operationId);
        return operation.promise.then(() => ({ operationId: args.operationId, cancelled: false, status: operation.status }),
          () => ({ operationId: args.operationId, cancelled: operation.status === 'cancelled', status: operation.status }));
      }
      if (operation.status !== 'queued') return Promise.resolve({ operationId: args.operationId, cancelled: false, status: operation.status });
      operation.cancelled = true;
      return operation.promise.then(() => ({ operationId: args.operationId, cancelled: false, status: operation.status }),
        () => ({ operationId: args.operationId, cancelled: operation.status === 'cancelled', status: operation.status }));
    }
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
    let entry;
    if (args.operationId !== undefined) {
      if (typeof args.operationId !== 'string' || !args.operationId || args.operationId.length > 100 || operations.has(args.operationId)) {
        throw new TypeError('operationId must be a unique nonempty string of at most 100 characters');
      }
      entry = { ids, status: 'queued', createdAt: Date.now(), cancelled: false, cancellable: name === 'memorySearch',
        controller: ['waitFrames', 'waitMemory'].includes(name) ? new AbortController() : null };
      operations.set(args.operationId, entry);
      if (operations.size > 512) {
        for (const [key, record] of operations) {
          if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') {
            operations.delete(key);
            break;
          }
        }
      }
    }
    // Barrier across all instances for bulk ROM load. Rejections must not poison the queue.
    const prior = Promise.all(ids.map(id => tails.get(id)?.catch(() => {}) || Promise.resolve()));
    const operation = prior.then(() => {
      if (entry?.cancelled) throw new Error('Operation cancelled before execution');
      if (entry) { entry.status = 'running'; entry.startedAt = Date.now(); }
      return backend.execute(name, entry?.controller ? { ...args, signal: entry.controller.signal } : args);
    }).then(result => {
      if (entry) { entry.status = 'completed'; entry.finishedAt = Date.now(); }
      return result;
    }, error => {
      if (entry) {
        entry.status = entry.cancelled || entry.cancelRequested || entry.controller?.signal.aborted ? 'cancelled' : 'failed';
        entry.error = String(error?.message || error); entry.finishedAt = Date.now();
      }
      throw error;
    });
    if (entry) entry.promise = operation;
    // Observational waiters must not hold the instance queue: gameplay input
    // and network replies need to remain executable while a waiter is pending.
    if (!['waitFrames', 'waitMemory', 'runUntil', 'stepOver', 'smartStep', 'step',
      'injectNetworkFrame', 'runScript', 'callPersistentScriptMcp'].includes(name)) {
      for (const id of ids) tails.set(id, operation);
    }
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
