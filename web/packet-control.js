import { instanceId } from './api.js';
export const packetMethods = new Set(['setPacketInterceptor', 'pendingPackets', 'commitPacket', 'setPacketRoutes', 'injectLocalPacket']);
const bytes = (value, hex) => {
  if (hex !== undefined) {
    if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})*$/i.test(hex.replace(/\s/g, ''))) throw Error('Invalid packet hex');
    value = (hex.replace(/\s/g, '').match(/../g) || []).map(v => parseInt(v, 16));
  }
  if (value == null) return undefined;
  if (!(Array.isArray(value) || value instanceof Uint8Array) || value.length > 4096
      || !Array.from(value).every(v => Number.isInteger(v) && v >= 0 && v <= 255)) throw Error('Packet data must contain at most 4096 bytes');
  return new Uint8Array(value);
};
const mask = value => { if (!Number.isInteger(value) || value < 0 || value > 65535) throw Error('destinationMask must be 0..65535'); return value; };
export function createPacketControl(native, publish, invokeHandler) {
  const settings = new Map(), pending = new Map(), handling = new Set(), committing = new Set();
  let serial = 1, suspended = false, polling = false;
  const configuration = (id, medium) => settings.get(`${id}:${medium}`);
  const applies = (config, direction) => config?.enabled && (config.direction === 'both' || config.direction === direction);
  function notify(packet) {
    if (pending.has(packet.packetId)) return;
    pending.set(packet.packetId, packet);
    publish({ type: 'packet-pending', ...structuredClone(packet) });
    const config = configuration(packet.instanceId, packet.medium), handler = config?.enabled ? config.handler : null;
    if (handler && !suspended) {
      const { data, nativeId, event, ...metadata } = packet;
      const job = Promise.resolve().then(() => invokeHandler({ instanceId: packet.instanceId, ...handler,
        params: { ...metadata, hex: Array.from(data, v => v.toString(16).padStart(2, '0')).join('') }, blocking: true, timeoutMs: 3000 }))
        .then(result => {
          if (!pending.has(packet.packetId) || !result || result.action === 'hold') return;
          return execute('commitPacket', { ...result, instanceId: packet.instanceId, packetId: packet.packetId });
        }).catch(error => publish({ type: 'packet-error', instanceId: packet.instanceId, packetId: packet.packetId, error: String(error.message || error) }))
        .finally(() => handling.delete(job));
      handling.add(job);
    }
  }
  function capture(event) {
    if (event.type !== 'wifi-log' || event.direction !== 'TX' || !event.payload || event.committed) return false;
    const config = configuration(event.instanceId, 'wifi');
    if (!applies(config, 'TX') && config?.destinationInstanceId === undefined) return false;
    if (pending.size >= 192) {
      publish({ type: 'packet-error', instanceId: event.instanceId, error: 'Packet hold queue full; frame dropped' });
      return true;
    }
    const packet = { packetId: `wifi:${event.instanceId}:${serial++}`, instanceId: event.instanceId, medium: 'wifi', direction: 'TX',
      timestamp: event.timestamp, data: new Uint8Array(event.payload), event };
    if (!applies(config, 'TX')) {
      void native.execute('injectNetworkFrame', { instanceId: config.destinationInstanceId, data: packet.data })
        .catch(error => publish({ type: 'packet-error', instanceId: event.instanceId, error: String(error.message || error) }));
    } else notify(packet);
    publish({ ...event, held: true }); return true;
  }
  async function refreshLocal(id) {
    const records = await native.execute('localPacketPending', { instanceId: id });
    const present = new Set(records.map(p => p.packetId));
    for (const [key, p] of pending) if (p.instanceId === id && p.medium === 'local' && !present.has(key)) pending.delete(key);
    records.forEach(notify);
  }
  async function execute(name, args) {
    const id = instanceId(args.instanceId);
    if (name === 'injectNetworkFrame') {
      if (!applies(configuration(id, 'wifi'), 'RX')) return native.execute(name, args);
      const data = bytes(args.data); if (!data || data.length < 14 || data.length > 2048) throw Error('Ethernet frame must be 14..2048 bytes');
      if (pending.size >= 192) throw Error('Packet hold queue full');
      const packetId = `wifi:${id}:${serial++}`;
      notify({ packetId, instanceId: id, medium: 'wifi', direction: 'RX', data });
      return { instanceId: id, packetId, held: true };
    }
    if (name === 'pendingPackets') {
      if (!args.medium || args.medium === 'local') await refreshLocal(id);
      return [...pending.values()].filter(p => p.instanceId === id && (!args.medium || p.medium === args.medium))
        .map(({ event, ...packet }) => structuredClone(packet));
    }
    if (name === 'commitPacket') {
      if (!['forward', 'drop'].includes(args.action)) throw Error('action must be forward or drop');
      const packet = pending.get(args.packetId);
      if (!packet || packet.instanceId !== id) throw Error('Pending packet not found for this instance');
      if (committing.has(packet.packetId)) throw Error('Packet commit is already running');
      committing.add(packet.packetId);
      try {
      const data = bytes(args.data, args.hex), targets = args.destinationMask === undefined ? undefined : mask(args.destinationMask);
      if (args.timestamp !== undefined && (!Number.isSafeInteger(args.timestamp) || args.timestamp < 0)) throw Error('timestamp must be a nonnegative safe integer');
      if (packet.medium === 'local') {
        await native.execute('localPacketCommit', { instanceId: id, nativeId: packet.nativeId, action: args.action, data,
          destinationMask: targets, timestamp: args.timestamp });
      } else if (args.action === 'forward') {
        const value = data || packet.data;
        if (value.length < 14 || value.length > 2048) throw Error('Ethernet frame must be 14..2048 bytes');
        const destination = args.destinationInstanceId ?? configuration(id, 'wifi')?.destinationInstanceId;
        if (destination !== undefined || packet.direction === 'RX') {
          await native.execute('injectNetworkFrame', { instanceId: destination === undefined ? id : instanceId(destination), data: value });
        } else publish({ ...packet.event, payload: Array.from(value), length: value.length, held: false, committed: true });
      }
      pending.delete(packet.packetId); return { instanceId: id, packetId: packet.packetId, action: args.action, committed: true };
      } finally { committing.delete(packet.packetId); }
    }
    if (name === 'injectLocalPacket') {
      if (!Number.isInteger(args.packetType) || args.packetType < 0 || args.packetType > 0xffffffff) throw Error('packetType must be uint32');
      if (!Number.isSafeInteger(args.timestamp) || args.timestamp < 0) throw Error('timestamp must be a nonnegative safe integer');
      return native.execute(name, { ...args, data: bytes(args.data, args.hex) || new Uint8Array(), destinationMask: mask(args.destinationMask ?? 65535) });
    }
    if (!['wifi', 'local'].includes(args.medium)) throw Error('medium must be wifi or local');
    const key = `${id}:${args.medium}`, config = { instanceId: id, medium: args.medium, direction: 'TX', ...settings.get(key) };
    if (name === 'setPacketRoutes') {
      if (args.medium === 'local') {
        config.destinationMask = mask(args.destinationMask);
        await native.execute('localPacketRoutes', { instanceId: id, destinationMask: config.destinationMask });
      } else config.destinationInstanceId = args.destinationInstanceId == null ? undefined : instanceId(args.destinationInstanceId);
    } else {
      if (typeof args.enabled !== 'boolean') throw Error('enabled must be boolean');
      const direction = args.direction ?? 'TX';
      if (!['TX', 'RX', 'both'].includes(direction) || (args.medium === 'local' && direction !== 'TX')) throw Error('Local interception is TX; wifi is TX/RX/both');
      if (args.handler != null && (typeof args.handler.scriptName !== 'string' || typeof args.handler.name !== 'string')) throw Error('handler requires scriptName and name');
      config.enabled = args.enabled; config.direction = direction; config.handler = args.handler || null;
      if (args.medium === 'local') await native.execute('localPacketInterceptor', { instanceId: id, enabled: args.enabled });
    }
    settings.set(key, config);
    if (name === 'setPacketInterceptor' && !args.enabled) {
      if (args.medium === 'local') await refreshLocal(id);
      for (const packet of [...pending.values()]) if (packet.instanceId === id && packet.medium === args.medium) {
        await execute('commitPacket', { instanceId: id, packetId: packet.packetId, action: args.pendingAction === 'drop' ? 'drop' : 'forward' });
      }
    }
    return structuredClone(config);
  }
  const timer = setInterval(async () => {
    if (polling || suspended) return;
    polling = true;
    try { for (const config of settings.values()) if (config.medium === 'local' && config.enabled) await refreshLocal(config.instanceId); }
    catch (error) { publish({ type: 'packet-error', error: String(error.message || error) }); }
    finally { polling = false; }
  }, 50);
  return {
    execute, capture,
    forget(id) { for (const [key, value] of settings) if (value.instanceId === id) settings.delete(key); for (const [key, value] of pending) if (value.instanceId === id) pending.delete(key); },
    async suspend() { suspended = true; await Promise.all([...handling]); },
    resume() { suspended = false; },
    snapshot: () => structuredClone({ serial, settings: [...settings], pending: [...pending] }),
    restore(value) {
      if (!value || !Array.isArray(value.settings) || value.settings.length > 32 || !Array.isArray(value.pending) || value.pending.length > 192) throw Error('Invalid packet-control workspace');
      settings.clear(); pending.clear(); serial = value.serial;
      value.settings.forEach(([k, v]) => settings.set(k, v)); value.pending.forEach(([k, v]) => pending.set(k, v));
    },
    close() { clearInterval(timer); }
  };
}
