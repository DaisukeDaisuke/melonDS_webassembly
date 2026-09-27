// A worker owns all calls to the Wasm core. A reply means the native call has
// returned; request acceptance alone never completes a destructive API call.
export function createWasmBackend() {
  const moduleURL = new URL('./main.js', import.meta.url).href;
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
    if (data.type === 'event') { for (const listener of listeners) listener(data.event); return; }
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
