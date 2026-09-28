// A worker owns all calls to the Wasm core. A reply means the native call has
// returned; request acceptance alone never completes a destructive API call.
export function createWasmBackend() {
  const moduleURL = new URL(`./main.js${new URL(import.meta.url).search}`, import.meta.url).href;
  const workerURL = URL.createObjectURL(new Blob([
    `import { startEngine } from ${JSON.stringify(moduleURL)}; await startEngine(${JSON.stringify(moduleURL)});`
  ], { type: 'text/javascript' }));
  const worker = new Worker(workerURL, { type: 'module', name: 'melonDS dispatcher' });
  const listeners = new Set();
  const pending = new Map();
  let serial = 0;
  let settled = false;
  let fatalError = null;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  worker.onmessage = ({ data }) => {
    if (data.type === 'ready') { URL.revokeObjectURL(workerURL); settled = true; readyResolve(); return; }
    if (data.type === 'event') {
      try { for (const listener of listeners) listener(data.event); }
      finally {
        if (data.frameToken !== undefined) worker.postMessage({ type: 'frame-consumed', instanceId: data.event.instanceId, frameToken: data.frameToken });
      }
      return;
    }
    if (data.type === 'events') {
      try {
        for (const event of data.events) {
          try { for (const listener of listeners) listener(event); }
          // A failing subscriber must not discard the rest of a batch. Before
          // batching, the following packets arrived in separate message tasks.
          catch (error) { queueMicrotask(() => { throw error; }); }
        }
      } finally { worker.postMessage({ type: 'logs-consumed', logToken: data.logToken }); }
      return;
    }
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(data.error));
    else entry.resolve(data.result);
  };
  const fail = error => {
    URL.revokeObjectURL(workerURL);
    const reason = new Error(error?.message || 'Wasm worker failed to initialize');
    fatalError = reason;
    if (!settled) { settled = true; readyReject(reason); }
    for (const entry of pending.values()) entry.reject(reason);
    pending.clear();
  };
  worker.onerror = fail;
  worker.onmessageerror = fail;
  return {
    async execute(name, args = {}) {
      await ready;
      if (fatalError) throw fatalError;
      const id = ++serial;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, name, args });
      });
    },
    setScreenTargets(instanceIds) { worker.postMessage({ type: 'screens', instanceIds }); },
    setAudioTargets(instanceIds) { worker.postMessage({ type: 'audio-targets', instanceIds }); },
    cancelOperation(operationId) { worker.postMessage({ type: 'cancel-operation', operationId }); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}
