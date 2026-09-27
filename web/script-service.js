// Hosts the pinned DeSmuME supervisor -> parser -> sandbox Worker chain.
// The original Worker sources are bundled by scripts/build-workers.mjs; this
// module only adapts the authenticated RPC boundary to explicit melonDS ids.
import { validateWorkerRpc } from './sandbox/upstream/src/script-rpc-policy.js';
import { assertSafeScriptSource } from './sandbox/upstream/src/script-source-policy.js';
import { ResourceLimits } from './sandbox/upstream/src/resource-limits.js';
import { normalizePersistentMcpParams } from './sandbox/upstream/src/worker-rpc-payload.js';
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
  let workerSources;
  const subscribers = new Set();
  let eventSerial = 0;
  const sources = async () => {
    if (!workerSources) workerSources = await import('./dist/script-workers.js');
    return workerSources;
  };
  const key = (id, name) => `${id}:${name}`;
  function bindArgs(record, command, params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw Error('Worker RPC params must be an object');
    if (params.instanceId !== undefined && params.instanceId !== record.instanceId) throw Error('Cross-instance script RPC is not allowed');
    return { ...params, instanceId: record.instanceId };
  }
  async function rpc(record, command, params) {
    if (command === 'register') {
      const kind = params.kind || params.type;
      if (!['tick', 'start', 'stateLoad', 'stateSave'].includes(kind)) {
        throw Error(`${kind} callback requires a native breakpoint event hook`);
      }
      record.triggers.push({ ...params, kind });
      return { id: record.triggers.length, ...params };
    }
    if (command === 'callPersistentScriptMcp' || persistentMethods.has(command)) {
      throw Error('Nested script lifecycle calls are not permitted');
    }
    return { ok: true, value: await native.execute(command, bindArgs(record, command, params)) };
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
      pending: new Set(), pendingMcp: new Map(), eventAcks: new Map(), startup, callSerial: 0,
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
        void rpc(record, request.command, request.params).then(result => {
          if (record.running) host.worker.postMessage({ replyId: message.id, result });
        }, error => {
          if (record.running) host.worker.postMessage({ replyId: message.id,
            error: { code: 'SCRIPT_RPC_ERROR', message: String(error?.message || error) } });
        }).finally(() => record.pending.delete(message.id));
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
      else if (message.type === 'eventDone' || message.type === 'sourceIdentity') { /* native callbacks registered separately */ }
      else if (message.type === 'eventRelease') fatal('Callback release requires a native breakpoint trap');
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
    for (const listener of subscribers) listener(event);
  });
  return {
    async execute(name, args = {}) {
      if (!persistentMethods.has(name)) {
        const result = await native.execute(name, args);
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
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    close() { unsubscribe(); }
  };
}
