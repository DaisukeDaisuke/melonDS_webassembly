// A worker owns all calls to the Wasm core. A reply means the native call has
// returned; request acceptance alone never completes a destructive API call.
export function createWasmBackend() {
  const worker = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
  const listeners = new Set();
  const pending = new Map();
  let serial = 0;
  let settled = false;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  worker.onmessage = ({ data }) => {
    if (data.type === 'ready') { settled = true; readyResolve(); return; }
    if (data.type === 'event') { for (const listener of listeners) listener(data.event); return; }
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(data.error));
    else entry.resolve(data.result);
  };
  const fail = error => {
    const reason = new Error(error?.message || 'Wasm worker failed to initialize');
    if (!settled) { settled = true; readyReject(reason); }
    for (const entry of pending.values()) entry.reject(reason);
    pending.clear();
  };
  worker.onerror = fail;
  worker.onmessageerror = fail;
  return {
    async execute(name, args = {}) {
      await ready;
      const id = ++serial;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, name, args });
      });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}
