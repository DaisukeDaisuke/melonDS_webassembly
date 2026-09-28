// Hosts the pinned DeSmuME supervisor -> parser -> sandbox Worker chain.
// The original Worker sources are bundled by scripts/build-workers.mjs; this
// module only adapts the authenticated RPC boundary to explicit melonDS ids.
import { validateWorkerRpc } from './sandbox/upstream/src/script-rpc-policy.js';
import { assertSafeScriptSource } from './sandbox/upstream/src/script-source-policy.js';
import { ResourceLimits } from './sandbox/upstream/src/resource-limits.js';
import { normalizePersistentMcpParams } from './sandbox/upstream/src/worker-rpc-payload.js';
import { sessionStore } from './session-store.js';
const persistentMethods = new Set(['startPersistentScript', 'stopPersistentScript',
  'restartPersistentScript', 'listPersistentScripts', 'callPersistentScriptMcp', 'runScript']);
const MAX_SCRIPTS = ResourceLimits.persistentScripts;
const MAX_SOURCE = 262144;
const MAX_PENDING_RPC = ResourceLimits.pendingWorkerRpc;
const scriptName = name => /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(name);
const wait = (ms, message) => new Promise((_, reject) => setTimeout(() => reject(Error(message)), ms));
function hostedWorker(source) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const worker = new Worker(url);
    return { worker, dispose() { worker.terminate(); URL.revokeObjectURL(url); } };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function checkedCode(code) {
  if (typeof code !== 'string' || !code.trim() || code.length > MAX_SOURCE) {
    throw Error(`Script source must be 1..${MAX_SOURCE} characters`);
  }
  assertSafeScriptSource(code);
}

export function createScriptBackend(native) {
  const scripts = new Map();
  const capturedFrames = new Map();
  const romHashes = new Map();
  let workerSources;
  const subscribers = new Set();
  let eventSerial = 0;
  const sources = async () => {
    if (!workerSources) workerSources = await import('./dist/script-workers.js');
    return workerSources;
  };
  const key = (id, name) => `${id}:${name}`;
  async function romHash(file) {
    if (!(file instanceof Blob)) return null;
    const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function requireMatchingRom(record, instanceId) {
    if (!record) throw Error('No browser data for this instance');
    if (!record.romHash || !romHashes.get(instanceId) || record.romHash !== romHashes.get(instanceId)) {
      throw Error('Browser data was saved for a different ROM');
    }
    return record.blob;
  }
  function waitOptions(args) {
    const timeoutMs = args.timeoutMs ?? 30000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw RangeError('timeoutMs must be 1..120000');
    return { timeoutMs, signal: args.signal };
  }
  function waitFrames(args) {
    if (!Number.isInteger(args.frames) || args.frames < 1 || args.frames > 1000000) throw RangeError('frames must be 1..1000000');
    const { timeoutMs, signal } = waitOptions(args);
    return new Promise((resolve, reject) => {
      let start, latest = -1, finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true; clearTimeout(timer); unsubscribe();
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(Error('Operation cancelled'));
      const unsubscribe = native.subscribe(event => {
        if (event.type !== 'frame' || event.instanceId !== args.instanceId) return;
        latest = event.frame;
        if (start === undefined) return;
        if (latest < start) finish(Error('Instance frame counter changed during wait'));
        else if (latest >= start + args.frames) finish(null, { instanceId: args.instanceId, frames: latest - start });
      });
      const timer = setTimeout(() => finish(Error('Frame wait timed out')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      void native.execute('status', { instanceId: args.instanceId }).then(status => {
        if (!status.loaded) throw Error('Load a ROM first');
        start = status.frames;
        if (latest >= start + args.frames) finish(null, { instanceId: args.instanceId, frames: latest - start });
      }).catch(error => finish(error));
    });
  }
  function waitMemory(args) {
    const { timeoutMs, signal } = waitOptions(args);
    const pattern = new Uint8Array(args.pattern || []);
    if (!pattern.length || pattern.length > 4096) throw RangeError('pattern length must be 1..4096');
    const intervalMs = args.intervalMs ?? 50;
    if (!Number.isInteger(intervalMs) || intervalMs < 16 || intervalMs > 1000) throw RangeError('intervalMs must be 16..1000');
    return new Promise((resolve, reject) => {
      let finished = false, pollTimer;
      const finish = (error, value) => {
        if (finished) return;
        finished = true; clearTimeout(timeout); clearTimeout(pollTimer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(Error('Operation cancelled'));
      const timeout = setTimeout(() => finish(Error('Memory wait timed out')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const poll = async () => {
        try {
          const data = await native.execute('readMemory', {
            instanceId: args.instanceId, cpu: args.cpu || 'ARM9', address: args.address, length: pattern.length
          });
          if (finished) return;
          if (pattern.every((byte, index) => byte === data[index])) {
            finish(null, { instanceId: args.instanceId, address: args.address, bytes: data });
          } else pollTimer = setTimeout(poll, intervalMs);
        } catch (error) { finish(error); }
      };
      void poll();
    });
  }
  function bindArgs(record, command, params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw Error('Worker RPC params must be an object');
    if (params.instanceId !== undefined && params.instanceId !== record.instanceId) throw Error('Cross-instance script RPC is not allowed');
    return { ...params, instanceId: record.instanceId };
  }
  async function rpc(record, command, params) {
    if (command === 'register') {
      const kind = params.kind || params.type;
      if (['read', 'write', 'exec'].includes(kind)) {
        const cpu = params.cpu || 'ARM9';
        const bp = await native.execute('addBreakpoint', { instanceId: record.instanceId, cpu,
          type: kind === 'exec' ? 'execute' : kind, address: params.address, length: params.length || 1 });
        record.triggers.push({ ...params, kind, breakpointId: bp.id });
        return { id: bp.id, ...params };
      }
      if (!['tick', 'start', 'stateLoad', 'stateSave'].includes(kind)) throw Error(`Unsupported callback type ${kind}`);
      record.triggers.push({ ...params, kind });
      return { id: record.triggers.length, ...params };
    }
    if (command === 'callPersistentScriptMcp' || persistentMethods.has(command)) {
      throw Error('Nested script lifecycle calls are not permitted');
    }
    const args = bindArgs(record, command, params);
    if (command === 'setInput') {
      return { ok: true, value: await native.execute('input', {
        instanceId: record.instanceId, key: String(params.button || params.key).toUpperCase(), pressed: !!params.pressed
      }) };
    }
    if (command === 'stepFrames') {
      return { ok: true, value: await waitFrames({ instanceId: record.instanceId, frames: params.frames ?? 1 }) };
    }
    if (command === 'memoryGetRegister') {
      const registers = await native.execute('getRegisters', args);
      const label = Number.isInteger(params.register) ? `r${params.register}` : String(params.register ?? params.reg ?? 'pc').toLowerCase();
      const name = ({ pc: 'r15', lr: 'r14', sp: 'r13' })[label] || label;
      if (!(name in registers)) throw Error(`Unknown register ${name}`);
      return { ok: true, value: registers[name] };
    }
    if (command === 'memorySetRegister') {
      const label = Number.isInteger(params.register) ? `r${params.register}` : String(params.register ?? params.reg).toLowerCase();
      return { ok: true, value: await native.execute('setRegister', {
        ...args, register: ({ pc: 'r15', lr: 'r14', sp: 'r13' })[label] || label
      }) };
    }
    const width = ({ memoryReadByte: 1, memoryReadWord: 2, memoryReadDword: 4,
      memoryWriteByte: 1, memoryWriteWord: 2, memoryWriteDword: 4 })[command];
    if (width) {
      if (command.startsWith('memoryRead')) {
        const bytes = await native.execute('readMemory', { ...args, length: width });
        return { ok: true, value: bytes.reduce((value, byte, index) => value | byte << (index * 8), 0) >>> 0 };
      }
      const bytes = Array.from({ length: width }, (_, index) => (params.value >>> (index * 8)) & 255);
      return { ok: true, value: await native.execute('writeMemory', { ...args, data: bytes }) };
    }
    return { ok: true, value: await native.execute(command, args) };
  }
  function summary(record) {
    return { instanceId: record.instanceId, name: record.name, running: record.running,
      registered: record.registered, asyncMode: record.asyncMode,
      triggers: record.triggers.map(t => ({ kind: t.kind, callbackId: t.callbackId })),
      mcps: record.mcps, output: record.output.slice(-100) };
  }
  function dispatch(record, type, payload, blocking = false) {
    if (!record.running || !record.registered || !record.triggers.some(t => t.kind === type)) return Promise.resolve();
    const queueEventId = blocking ? ++eventSerial : 0;
    const completion = blocking ? deferred() : null;
    if (completion) record.eventAcks.set(queueEventId, completion);
    record.host.worker.postMessage({ type: 'event', event: type, payload, queueEventId });
    return completion ? Promise.race([completion.promise, wait(10000, `${type} callback timed out`)]).finally(() => {
      record.eventAcks.delete(queueEventId);
    }) : Promise.resolve();
  }
  async function start({ instanceId, name, code, asyncMode = false, timeoutMs = 3000 }) {
    checkedCode(code);
    if (!scriptName(name)) throw Error('Script name must begin with a letter and contain at most 64 letters, digits, dot, underscore or hyphen');
    if (scripts.has(key(instanceId, name))) await stop({ instanceId, name });
    if (scripts.size >= MAX_SCRIPTS) throw Error('Persistent script limit reached');
    const { sources: bundled, dependency } = await sources();
    const host = hostedWorker(bundled['persistent-script-supervisor']);
    const startup = deferred();
    const record = {
      instanceId, name, code, asyncMode: !!asyncMode, host, running: true,
      registered: false, started: false, triggers: [], mcps: [], output: [],
      pending: new Set(), pendingMcp: new Map(), eventAcks: new Map(), activeEvents: new Map(), startup, callSerial: 0,
      scriptInstanceId: crypto.randomUUID()
    };
    scripts.set(key(instanceId, name), record);
    const fatal = error => {
      const reason = Error(String(error?.message || error));
      record.startup.reject(reason);
      for (const pending of record.pendingMcp.values()) pending.reject(reason);
      record.pendingMcp.clear();
      for (const pending of record.eventAcks.values()) pending.reject(reason);
      record.eventAcks.clear();
      record.running = false; scripts.delete(key(instanceId, name)); host.dispose();
      for (const trigger of record.triggers) if (trigger.breakpointId) {
        void native.execute('removeBreakpoint', { instanceId, id: trigger.breakpointId }).catch(() => {});
      }
    };
    host.worker.onerror = event => fatal(event.message || 'Supervisor crashed');
    host.worker.onmessageerror = () => fatal('Unreadable supervisor message');
    host.worker.onmessage = ({ data: message }) => {
      if (!record.running) return;
      if (message.type === 'ready' && message.layer === 'supervisor' && message.hardened === true) {
        host.worker.postMessage({ type: 'start', code, asyncMode: record.asyncMode,
          scriptInstanceId: record.scriptInstanceId, parserSource: bundled.parser,
          sandboxSource: bundled['persistent-script'], dependency, shortcuts: [] });
      } else if (message.type === 'call' || message.type === 'register') {
        if (record.pending.size >= MAX_PENDING_RPC || !message.id || record.pending.has(message.id)) {
          fatal('Worker RPC limit or duplicate ID'); return;
        }
        let request;
        try {
          request = message.type === 'register'
            ? { command: 'register', params: message.trigger }
            : validateWorkerRpc(message, record.pending);
          if (message.type === 'register') record.pending.add(message.id);
        } catch (error) { fatal(error); return; }
        const active = Number(message.eventId) ? record.activeEvents.get(Number(message.eventId)) : null;
        if (message.eventId && (!active || active.callbackId !== message.callbackId
          || active.callbackToken !== message.callbackToken)) { fatal('Invalid callback event identity'); return; }
        if (message.eventId && request.command === 'resume' && !active.released) {
          fatal('Callback resume requires a matching event release'); return;
        }
        void rpc(record, request.command, request.params).then(result => {
          if (record.running) host.worker.postMessage({ replyId: message.id, result });
        }, error => {
          if (record.running) host.worker.postMessage({ replyId: message.id,
            error: { code: 'SCRIPT_RPC_ERROR', message: String(error?.message || error) } });
        }).finally(() => {
          record.pending.delete(message.id);
          if (request.command === 'resume' && message.eventId) record.activeEvents.delete(message.eventId);
        });
      } else if (message.type === 'compiled') {
        record.compiled = true;
      } else if (message.type === 'started') {
        if (!record.compiled) { fatal('Script started before compile'); return; }
        record.started = true;
      } else if (message.type === 'registrationComplete') {
        if (!record.started || message.scriptInstanceId !== record.scriptInstanceId) { fatal('Invalid script registration'); return; }
        record.mcps = Array.isArray(message.mcps) ? message.mcps : [];
        record.registered = true;
        record.startup.resolve(summary(record));
        void dispatch(record, 'start', { instanceId });
      } else if (message.type === 'print') {
        record.output.push(...(message.values || []).map(value => String(value).slice(0, 2048)));
        if (record.output.length > 500) record.output.splice(0, record.output.length - 500);
      } else if (message.type === 'pscriptMcpResult') {
        const pending = record.pendingMcp.get(message.callId);
        if (!pending || message.scriptInstanceId !== record.scriptInstanceId) return;
        record.pendingMcp.delete(message.callId);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(Error(String(message.error?.message || 'MCP call failed')));
      } else if (message.type === 'failed') fatal(message.error?.message || message.phase || 'Script failed');
      else if (message.type === 'eventAck') {
        record.eventAcks.get(message.queueEventId)?.resolve({ instanceId, name, eventId: message.queueEventId });
      }
      else if (message.type === 'eventDone') {
        const active = record.activeEvents.get(message.eventId);
        if (active && active.callbackId === message.callbackId && active.callbackToken === message.callbackToken) {
          record.activeEvents.delete(message.eventId);
        }
      }
      else if (message.type === 'eventRelease') {
        const active = record.activeEvents.get(message.eventId);
        if (!active || active.callbackId !== message.callbackId || active.callbackToken !== message.callbackToken
          || message.mode !== 'resume') { fatal('Invalid breakpoint callback release'); return; }
        active.released = true;
      }
      else if (message.type === 'sourceIdentity') { /* source identity is checked by the supervisor */ }
      else fatal(`Unknown supervisor message: ${message.type}`);
    };
    try { return await Promise.race([startup.promise, wait(timeoutMs, 'Script startup timed out')]); }
    catch (error) { if (record.running) await stop({ instanceId, name }); throw error; }
  }
  async function stop({ instanceId, name }) {
    const record = scripts.get(key(instanceId, name));
    if (!record) throw Error(`Script not found: ${name}`);
    // Supervisor confirms child Worker termination and Blob URL revocation.
    const shutdown = deferred();
    const oldHandler = record.host.worker.onmessage;
    record.host.worker.onmessage = event => {
      if (event.data?.type === 'shutdownAck') shutdown.resolve(event.data.cleanup);
      else oldHandler(event);
    };
    record.host.worker.postMessage({ type: 'shutdown', requestId: record.scriptInstanceId });
    try { await Promise.race([shutdown.promise, wait(3000, 'Script shutdown acknowledgement timed out')]); }
    finally {
      record.running = false;
      record.startup.reject(Error('Script stopped'));
      for (const pending of record.pendingMcp.values()) pending.reject(Error('Script stopped'));
      record.pendingMcp.clear(); record.host.dispose(); scripts.delete(key(instanceId, name));
      for (const pending of record.eventAcks.values()) pending.reject(Error('Script stopped'));
      record.eventAcks.clear();
      record.activeEvents.clear();
      await Promise.all(record.triggers.filter(trigger => trigger.breakpointId).map(trigger =>
        native.execute('removeBreakpoint', { instanceId, id: trigger.breakpointId }).catch(() => {})));
    }
    return summary(record);
  }
  async function callMcp({ instanceId, scriptName, name, params = {}, blocking = true, timeoutMs = 10000 }) {
    const record = scripts.get(key(instanceId, scriptName));
    if (!record?.registered || !record.mcps.some(item => item.name === name)) throw Error('Persistent MCP not found');
    if (record.pendingMcp.size >= MAX_PENDING_RPC) throw Error('Persistent MCP queue full');
    const callId = ++record.callSerial;
    params = normalizePersistentMcpParams(params);
    const pending = deferred(); record.pendingMcp.set(callId, pending);
    record.host.worker.postMessage({ type: 'pscriptMcpInvoke', scriptInstanceId: record.scriptInstanceId,
      callId, name, params, blocking: !!blocking });
    try { return await Promise.race([pending.promise, wait(timeoutMs, 'Persistent MCP timed out')]); }
    finally { record.pendingMcp.delete(callId); }
  }
  async function runOnce({ instanceId, code, timeoutMs = 3000 }) {
    checkedCode(code);
    const { sources: bundled, dependency } = await sources();
    const host = hostedWorker(bundled['eval-supervisor']);
    const completed = deferred();
    const seen = new Set();
    host.worker.onmessage = ({ data: message }) => {
      if (message.type === 'ready' && message.hardened && message.layer === 'supervisor') {
        host.worker.postMessage({ type: 'run', code, parserSource: bundled.parser,
          sandboxSource: bundled.eval, dependency, shortcuts: [] });
      } else if (message.type === 'call') {
        let request;
        try { request = validateWorkerRpc(message, seen); }
        catch (error) { completed.reject(error); return; }
        void rpc({ instanceId }, request.command, request.params).then(result => {
          host.worker.postMessage({ replyId: message.id, result });
        }, error => host.worker.postMessage({ replyId: message.id, error: String(error?.message || error) }))
          .finally(() => seen.delete(message.id));
      } else if (message.type === 'done') completed.resolve(message.result);
      else if (message.type === 'error' || message.type === 'protocolError') completed.reject(Error(message.error?.message || message.message));
    };
    host.worker.onerror = error => completed.reject(Error(error.message || 'Eval Worker crashed'));
    try { return await Promise.race([completed.promise, wait(timeoutMs, 'Script timed out')]); }
    finally { host.dispose(); }
  }
  const unsubscribe = native.subscribe(event => {
    if (event.type === 'frame') {
      for (const record of scripts.values()) if (record.instanceId === event.instanceId) {
        void dispatch(record, 'tick', { instanceId: event.instanceId });
      }
    }
    if (event.type === 'breakpoint') {
      for (const record of scripts.values()) {
        if (record.instanceId !== event.instanceId || !record.running || !record.registered) continue;
        for (const trigger of record.triggers) {
          if (trigger.breakpointId !== event.breakpointId) continue;
          const eventId = ++eventSerial, callbackToken = crypto.randomUUID();
          record.activeEvents.set(eventId, { callbackId: trigger.callbackId, callbackToken, released: false });
          record.host.worker.postMessage({ type: 'event',
            event: trigger.kind, payload: event, eventId, callbackId: trigger.callbackId,
            triggerId: trigger.breakpointId, callbackToken });
        }
      }
    }
    for (const listener of subscribers) listener(event);
  });
  return {
    async execute(name, args = {}) {
      if (name === 'waitFrames') return waitFrames(args);
      if (name === 'waitMemory') return waitMemory(args);
      if (name === 'captureFrame') {
        const frame = await native.execute('screenshot', args);
        capturedFrames.set(args.instanceId, frame);
        return { instanceId: args.instanceId, width: frame.width, height: frame.height, captured: true };
      }
      if (name === 'compareFrames') {
        const before = capturedFrames.get(args.instanceId);
        if (!before) throw Error('Capture a reference frame first');
        const after = await native.execute('screenshot', args);
        const threshold = args.threshold ?? 0;
        if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) throw RangeError('threshold must be 0..255');
        const changed = {};
        for (const screen of ['top', 'bottom']) {
          let pixels = 0;
          const original = before[screen], current = after[screen];
          for (let n = 0; n < current.length; n += 4) {
            if (Math.abs(original[n] - current[n]) > threshold
              || Math.abs(original[n + 1] - current[n + 1]) > threshold
              || Math.abs(original[n + 2] - current[n + 2]) > threshold) pixels++;
          }
          changed[screen] = pixels;
        }
        return { instanceId: args.instanceId, changedPixels: changed, totalPixels: after.width * after.height * 2 };
      }
      if (name === 'listBrowserStates') return sessionStore.list(args);
      if (name === 'saveStateToBrowser') {
        await native.execute('saveState', args);
        const bytes = await native.execute('exportState', args);
        const stored = await sessionStore.put({ ...args, slot: args.name !== undefined ? `state:${String(args.name).trim()}` : args.slot ?? 0, data: bytes,
          romHash: romHashes.get(args.instanceId) });
        await Promise.all([...scripts.values()].filter(s => s.instanceId === args.instanceId)
          .map(s => dispatch(s, 'stateSave', { instanceId: args.instanceId, slot: args.slot ?? 0 }, true)));
        return stored;
      }
      if (name === 'loadStateFromBrowser') {
        const slot = args.slot ?? 0;
        const blob = requireMatchingRom(await sessionStore.getRecord({ instanceId: args.instanceId, slot: args.name !== undefined ? `state:${String(args.name).trim()}` : slot }), args.instanceId);
        const result = await native.execute('loadState', { ...args, slot, bytes: await blob.arrayBuffer() });
        await Promise.all([...scripts.values()].filter(s => s.instanceId === args.instanceId)
          .map(s => dispatch(s, 'stateLoad', { instanceId: args.instanceId, slot }, true)));
        return result;
      }
      if (name === 'saveSaveToBrowser') {
        const bytes = await native.execute('exportSave', args);
        return sessionStore.put({ instanceId: args.instanceId, slot: 'save', data: bytes,
          romHash: romHashes.get(args.instanceId) });
      }
      if (name === 'loadSaveFromBrowser') {
        const blob = requireMatchingRom(await sessionStore.getRecord({ instanceId: args.instanceId, slot: 'save' }), args.instanceId);
        return native.execute('importSave', { ...args, bytes: await blob.arrayBuffer() });
      }
      if (!persistentMethods.has(name)) {
        if (name === 'destroyInstance' || name === 'loadRom' || name === 'loadRomMany') {
          const targets = name === 'loadRomMany' ? args.instanceIds : [args.instanceId];
          for (const record of [...scripts.values()]) {
            if (targets.includes(record.instanceId)) await stop({ instanceId: record.instanceId, name: record.name });
          }
        }
        const hash = ['loadRom', 'loadRomMany'].includes(name) ? await romHash(args.file) : null;
        const result = await native.execute(name, args);
        if (['createInstance', 'destroyInstance', 'loadRom', 'loadRomMany'].includes(name)) {
          const ids = name === 'loadRomMany' ? args.instanceIds : [name === 'createInstance' ? result.instanceId : args.instanceId];
          for (const instanceId of ids) for (const listener of subscribers) listener({ type: 'instance-change', action: name, instanceId, romName: args.file?.name });
        }
        if (name === 'destroyInstance') romHashes.delete(args.instanceId);
        if (name === 'loadRom') romHashes.set(args.instanceId, hash);
        if (name === 'loadRomMany') for (const id of args.instanceIds) romHashes.set(id, hash);
        if (name === 'destroyInstance' || name === 'loadRom' || name === 'reset') capturedFrames.delete(args.instanceId);
        if (name === 'loadRomMany') for (const id of args.instanceIds) capturedFrames.delete(id);
        if (name === 'saveState' || name === 'loadState') {
          const type = name === 'saveState' ? 'stateSave' : 'stateLoad';
          await Promise.all([...scripts.values()].filter(s => s.instanceId === args.instanceId)
            .map(s => dispatch(s, type, { instanceId: args.instanceId, slot: args.slot }, true)));
        }
        return result;
      }
      if (name === 'startPersistentScript') return start(args);
      if (name === 'stopPersistentScript') return stop(args);
      if (name === 'restartPersistentScript') {
        const prior = scripts.get(key(args.instanceId, args.name));
        if (!prior) throw Error('Script not found');
        const { code, asyncMode } = prior;
        await stop(args); return start({ ...args, code, asyncMode });
      }
      if (name === 'listPersistentScripts') return [...scripts.values()].filter(s => s.instanceId === args.instanceId).map(summary);
      if (name === 'callPersistentScriptMcp') return callMcp(args);
      if (name === 'runScript') return runOnce(args);
    },
    setScreenTargets(instanceIds) { native.setScreenTargets(instanceIds); },
    setAudioTargets(instanceIds) { native.setAudioTargets(instanceIds); },
    cancelOperation(operationId) { native.cancelOperation(operationId); },
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    close() { unsubscribe(); }
  };
}
