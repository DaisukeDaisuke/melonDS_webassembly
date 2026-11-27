import { instanceId } from './api.js';
import { createLanService, ipv4, portNumber } from './lan-services.js';
import { createTcpService } from './tcp-service.js';
import { createDq9WfcHandler, httpBytes } from './dq9-wfc.js';
import { createSsl3Server } from './dq9/ssl3.js';
import { createFileStore, dlcPath } from './file-store.js';

function handlersByPort(handlers, getHandler) {
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) throw new TypeError('Expected a port-to-handler object');
  return new Map(Object.entries(handlers).map(([port, entry]) => {
    const handler = getHandler(entry);
    if (!/^\d+$/.test(port) || typeof handler !== 'function') throw new TypeError(`Invalid handler for port ${port}`);
    return [portNumber(Number(port)), handler];
  }));
}

// Application responses are opaque bytes; only the transport adds headers.
function opaquePayload(value) {
  if (value == null || value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('AP response must be a binary payload');
}

function opaqueTcpResponse(value) {
  if (value == null || value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return opaquePayload(value);
  }
  if (typeof value === 'object' && ('data' in value || value.close === true)) {
    return { data: opaquePayload(value.data), close: value.close === true };
  }
  throw new TypeError('AP TCP response must be a binary payload or response envelope');
}

function networkOptions({ address = '10.0.0.1', clientAddress = '10.0.0.100', netmask = '255.255.255.0', dhcp = true, fragmentBytes = 1480 }) {
  const server = ipv4(address), client = ipv4(clientAddress), mask = ipv4(netmask);
  const maskBits = (mask[0] << 24) | (mask[1] << 16) | (mask[2] << 8) | mask[3];
  const hostMask = ~maskBits >>> 0;
  if (!maskBits || (hostMask & (hostMask + 1)) !== 0 || hostMask < 3) throw new RangeError('Expected a contiguous IPv4 netmask with at least two host bits');
  if (client.every((octet, i) => octet === server[i]) || client.some((octet, i) => ((octet ^ server[i]) & mask[i]) !== 0)) {
    throw new RangeError('Server and client must have different addresses in the same subnet');
  }
  for (const ip of [server, client]) {
    const host = ((ip[0] << 24 | ip[1] << 16 | ip[2] << 8 | ip[3]) & hostMask) >>> 0;
    if (!host || host === hostMask || !ip[0] || ip[0] >= 224) throw new RangeError('Expected unicast host addresses');
  }
  if (typeof dhcp !== 'boolean') throw new TypeError('network.dhcp must be a boolean');
  if (!Number.isInteger(fragmentBytes) || fragmentBytes < 8 || fragmentBytes > 1976 || fragmentBytes % 8) {
    throw new RangeError('network.fragmentBytes must be a multiple of 8 from 8 to 1976');
  }
  return { address: server.join('.'), clientAddress: client.join('.'), netmask: mask.join('.'), dhcp, fragmentBytes };
}

function apBssid(value, slot) {
  if (value == null) return [0x02, 0xf0, 0x77, 0x77, 0x77, 0x77 + slot];
  if (typeof value === 'string' && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value)) {
    value = value.split(':').map(part => parseInt(part, 16));
  }
  if ((!Array.isArray(value) && !(value instanceof Uint8Array)) || value.length !== 6 ||
    Array.from(value).some(n => !Number.isInteger(n) || n < 0 || n > 255) || (value[0] & 1) || !value.some(Boolean)) {
    throw new TypeError('BSSID must be a nonzero unicast MAC');
  }
  return Array.from(value);
}

// A service receives raw Ethernet frames actually emitted by melonDS WifiAP.
// Its responses are enqueued at Platform::Net_RecvPacket, never substituted
// for a game-facing result in JavaScript.
export function createVirtualNetwork(api, { onEvent = () => {} } = {}) {
  const servers = new Map();
  const accessPoints = new Map();
  const apMutations = new Map();
  const pending = new Map();
  let suspended = false;
  const diagnostic = (id, protocol, summary, detail = '', direction = 'TX') => onEvent({ type: 'wifi-log', instanceId: id, direction, timestamp: new Date().toLocaleTimeString(), packetType: protocol, logical: true, length: 0, decoded: { source: direction === 'TX' ? `#${id}` : 'WFC', destination: direction === 'TX' ? 'WFC' : `#${id}`, protocol, summary, detail } });
  const files = createFileStore();
  const outgoing = new Map();
  function sendFrames(id, data, bssid) {
    const work = (outgoing.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      let result;
      for (const frame of Array.isArray(data) ? data : [data]) {
        const deadline = Date.now() + 30000;
        for (;;) {
          try {
            result = await api.injectNetworkFrame({ instanceId: id, data: frame, bssid });
            break;
          } catch (error) {
            // -2 is the native RX queue-full signal. Do not drop a fragment.
            if (!/native operation failed \(-2\)/.test(String(error?.message)) || Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 4));
          }
        }
      }
      return result;
    });
    outgoing.set(id, work);
    work.finally(() => { if (outgoing.get(id) === work) outgoing.delete(id); }).catch(() => {});
    return work;
  }
  function mutateAccessPoints(id, run) {
    const operation = (apMutations.get(id) || Promise.resolve()).catch(() => {}).then(run);
    apMutations.set(id, operation);
    const done = () => { if (apMutations.get(id) === operation) apMutations.delete(id); };
    operation.then(done, done);
    return operation;
  }
  async function createAccessPoint({ instanceId: id, ssid, security = 'open', key = '', channel = 6, bssid,
    network = {}, udp = {}, tcp = {} } = {}) {
    instanceId(id);
    if (!Number.isInteger(channel) || channel < 1 || channel > 14) throw new RangeError('Channel must be 1..14');
    const config = networkOptions(network);
    const udpHandlers = handlersByPort(udp, handler => typeof handler === 'function' ? handler : handler?.handlePacket);
    const tcpListeners = handlersByPort(tcp, listener => typeof listener === 'function' ? listener : listener?.onData ?? listener?.handlePacket);
    if (config.dhcp && udpHandlers.has(67)) throw new RangeError('UDP port 67 is reserved by this AP’s DHCP server');
    return mutateAccessPoints(id, async () => {
      const points = accessPoints.get(id) || new Map();
      const usedSlots = new Set([...points.values()].map(point => point.slot));
      const slot = [1, 2, 3, 4, 5, 6, 7].find(value => !usedSlots.has(value));
      if (slot === undefined) throw Error('No free virtual access point slots for this instance');
      const mac = apBssid(bssid, slot);
      const macKey = mac.join(':');
      if (points.has(macKey)) throw Error('An access point already uses that BSSID');
      const lan = createLanService({ ...config, mac });
      for (const [port, handler] of udpHandlers) lan.bindUdp(port, async packet => opaquePayload(await handler(packet)));
      const emitFrame = data => {
        if (!isCurrent()) throw Error('The virtual access point is closed');
        return sendFrames(id, data, mac);
      };
      const stream = createTcpService({ address: config.address, mac, emitFrame,
        onDiagnostic: message => diagnostic(id, 'TCP', message, message) });
      for (const [port, handler] of tcpListeners) stream.listen(port, { async onData(data, peer) {
        return opaqueTcpResponse(await handler(data, peer));
      } });
      const point = { slot, onFrame: frame => lan(frame) || stream(frame), emitFrame,
        close: () => { lan.close(); stream.close(); },
        suspend: stream.suspend, resume: stream.resume, settle: stream.settle };
      const isCurrent = () => accessPoints.get(id) === points && points.get(macKey) === point;
      await api.configureAccessPoint({ instanceId: id, slot, ssid, security, key, channel, bssid: mac });
      points.set(macKey, point);
      accessPoints.set(id, points);
      if (suspended) point.suspend();
      return Object.freeze({ instanceId: id, ssid, security, channel, bssid: mac.map(n => n.toString(16).padStart(2, '0')).join(':'),
        network: Object.freeze(config),
        async sendUdp(message) {
          if (suspended) throw Error('Virtual network is suspended');
          return emitFrame(lan.sendUdp({ ...message, data: opaquePayload(message.data) }));
        },
        peers: lan.peers,
        close: () => mutateAccessPoints(id, async () => {
          if (!isCurrent()) return;
          await api.removeAccessPoint({ instanceId: id, slot });
          points.delete(macKey);
          if (!points.size) accessPoints.delete(id);
          point.close();
        }) });
    });
  }
  function services() {
    return [...servers.values(), ...[...accessPoints.values()].flatMap(points => [...points.values()])];
  }
  function register({ instanceId: id, onFrame }) {
    instanceId(id);
    if (typeof onFrame !== 'function') throw new TypeError('onFrame must be a function');
    servers.get(id)?.close?.();
    servers.set(id, onFrame);
    if (suspended) onFrame.suspend?.();
    return () => { if (servers.get(id) === onFrame) { servers.delete(id); onFrame.close?.(); } };
  }
  function registerNetwork({ instanceId: id, address = '10.0.0.1', clientAddress = '10.0.0.100',
    mac = [0x02, 0x4d, 0x44, 0x53, 0, 1], ...options } = {}) {
    const lan = createLanService({ ...options, address, clientAddress, mac });
    const emitFrame = data => sendFrames(id, data);
    const tcp = createTcpService({ address, mac, onRequest: options.onRequest,
      createSecureSession: options.createSecureSession, emitFrame,
      onDiagnostic: message => diagnostic(id, 'TCP', message, message) });
    let closed = false;
    const onFrame = frame => lan(frame) || tcp(frame);
    onFrame.close = () => { closed = true; lan.close(); tcp.close(); };
    onFrame.suspend = tcp.suspend;
    onFrame.resume = tcp.resume;
    onFrame.settle = tcp.settle;
    const unregister = register({ instanceId: id, onFrame });
    function active() {
      if (closed) throw Error('Virtual network is closed');
    }
    return Object.freeze({
      udp: Object.freeze({
        bind(port, handler) { active(); return lan.bindUdp(port, handler); },
        async send(datagram) { active(); if (suspended) throw Error('Virtual network is suspended'); return emitFrame(lan.sendUdp(datagram)); }
      }),
      tcp: Object.freeze({ listen(port, handlers) { active(); return tcp.listen(port, handlers); } }),
      peers() { active(); return lan.peers(); },
      close: unregister
    });
  }
  function registerDq9Wfc({ instanceId: id, address = '10.0.0.1', clientAddress = '10.0.0.100',
    mac = [0x02, 0x4d, 0x44, 0x53, 0, 1], dlc = {}, certificatePem, privateKeyPem, chainPem } = {}) {
    const handler = createDq9WfcHandler({ dlc, getFile: ({ gamecd, name }) => files.get({ path: dlcPath(gamecd, name) }) });
    const lan = createLanService({ address, clientAddress, mac, domainSuffixes: ['nintendowifi.net'],
      ignoreUnknownDomains: true, interceptDns: true });
    const onRequest = async request => {
      const protocol = request.port === 443 ? 'HTTPS' : 'HTTP';
      const path = `${request.method} ${request.host}${request.path}`;
      const bytes = httpBytes(await handler.handle(request));
      const response = new TextDecoder().decode(bytes.subarray(0, 16384));
      diagnostic(id, protocol, `${path} → ${response.split('\r\n')[0]}`,
        `Request\n${path}\n${new TextDecoder().decode(request.body?.subarray(0, 16384) || new Uint8Array())}\n\nResponse (${bytes.length} bytes)\n${response}`, 'TX');
      return bytes;
    };
    if (!!certificatePem !== !!privateKeyPem) throw new TypeError('SSLv3 certificate and private key must be provided together');
    const createSecureSession = certificatePem
      ? createSsl3Server({ certificatePem, privateKeyPem, chainPem, onRequest, onDiagnostic: message => diagnostic(id, 'SSLv3', message, message) }) : null;
    const tcp = createTcpService({ address, mac, onRequest, createSecureSession, onDiagnostic: message => diagnostic(id, 'TCP', message, message),
      emitFrame: frame => sendFrames(id, frame) });
    const onFrame = frame => lan(frame) || tcp(frame);
    onFrame.close = () => tcp.close();
    onFrame.suspend = () => tcp.suspend();
    onFrame.resume = () => tcp.resume();
    onFrame.settle = () => tcp.settle();
    onFrame.snapshot = () => ({ type: 'dq9', options: { instanceId: id, address, clientAddress, mac,
      dlc: handler.snapshot(), certificatePem, privateKeyPem, chainPem }, tcp: tcp.snapshot() });
    onFrame.restore = value => tcp.restore(value);
    const unregister = register({ instanceId: id, onFrame });
    diagnostic(id, 'WFC', certificatePem ? 'HTTP / SSLv3 サーバー接続済み' : 'HTTP サーバー接続済み', `Gateway ${address}\nClient ${clientAddress}`);
    return Object.freeze({ setDlc: (game, files) => handler.setDlc(game, files), unregister });
  }
  const unsubscribe = api.subscribe(event => {
    if (event.type !== 'wifi-tx' || event.held) return;
    const id = event.instanceId;
    const mac = event.bssid?.join(':');
    const point = accessPoints.get(id)?.get(mac);
    const server = point?.onFrame || servers.get(id);
    if (!server) return;
    const isCurrent = () => point ? accessPoints.get(id)?.get(mac) === point : servers.get(id) === server;
    const emitFrame = point?.emitFrame || (data => sendFrames(id, data));
    const work = (pending.get(id) || Promise.resolve()).catch(() => {}).then(() => {
      if (!isCurrent()) return null;
      return server(new Uint8Array(event.payload), { instanceId: id, timestamp: event.timestamp });
    }).then(async reply => {
      if (reply == null) return;
      for (const frame of Array.isArray(reply) ? reply : [reply]) {
        if (!isCurrent()) return;
        if (!(frame instanceof Uint8Array) || frame.length < 14 || frame.length > 2048) {
          throw new TypeError('Virtual server must return Ethernet Uint8Arrays (14..2048 bytes)');
        }
        await emitFrame(frame);
      }
    }).catch(error => { diagnostic(event.instanceId, 'ERROR', error.message || String(error)); console.error('Virtual network server error', error); });
    pending.set(id, work);
    work.finally(() => { if (pending.get(id) === work) pending.delete(id); });
  });
  return Object.freeze({
    files,
    register,
    registerNetwork,
    createAccessPoint,
    registerLan({ instanceId: id, ...options }) {
      const onFrame = createLanService(options);
      onFrame.snapshot = () => ({ type: 'lan', options: { ...options, instanceId: id } });
      return register({ instanceId: id, onFrame });
    },
    async suspend() {
      suspended = true;
      for (const server of services()) server.suspend?.();
      while (pending.size) await Promise.all([...pending.values()]);
      await Promise.all(services().map(server => server.settle?.()));
    },
    resume() { for (const server of services()) server.resume?.(); suspended = false; },
    snapshot() {
      if (accessPoints.size || apMutations.size) throw Error('スクリプトで作成したアクセスポイントは .mel 保存に対応していません');
      return [...servers.values()].map(server => {
        if (!server.snapshot) throw Error('このカスタム通信サーバーは .mel 保存に対応していません');
        return server.snapshot();
      });
    },
    restore(records) {
      for (const service of servers.values()) service.close?.(); servers.clear();
      for (const record of records) {
        if (record.type === 'dq9') { registerDq9Wfc(record.options); servers.get(record.options.instanceId).restore(record.tcp); }
        else if (record.type === 'lan') {
          const { instanceId: id, ...options } = record.options, onFrame = createLanService(options);
          onFrame.snapshot = () => structuredClone(record); register({ instanceId: id, onFrame });
        } else throw Error('Unknown .mel network server');
      }
    },
    registerDq9Wfc,
    async registerDq9WfcFromSameOrigin(options = {}) {
      const base = new URL('./dq9/certs/', import.meta.url);
      if (base.origin !== globalThis.location?.origin) throw Error('DQ9 certificates must be hosted with the UI on the same origin');
      const [certificatePem, privateKeyPem] = await Promise.all(
        ['server_with_chain.crt', 'server.key'].map(async file => {
          const response = await fetch(new URL(file, base), { credentials: 'same-origin', cache: 'no-store' });
          if (!response.ok) throw Error(`Cannot load same-origin DQ9 certificate ${file}: ${response.status}`);
          return response.text();
        }));
      await api.setNetworkBackend({ instanceId: options.instanceId, backend: 'virtual', configureAccessPoint: true });
      return registerDq9Wfc({ ...options, certificatePem, privateKeyPem });
    },
    unregister({ instanceId: id }) {
      instanceId(id);
      servers.get(id)?.close?.(); servers.delete(id);
      for (const point of accessPoints.get(id)?.values() || []) point.close();
      accessPoints.delete(id);
    },
    async close() {
      unsubscribe();
      for (const service of servers.values()) service.close?.();
      servers.clear();
      await Promise.all([...accessPoints.keys()].map(id => mutateAccessPoints(id, async () => {
        const points = accessPoints.get(id);
        if (!points) return;
        for (const [mac, point] of points) {
          await api.removeAccessPoint({ instanceId: id, slot: point.slot });
          points.delete(mac);
          point.close();
        }
        accessPoints.delete(id);
      })));
    }
  });
}
