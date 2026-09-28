import { instanceId } from './api.js';
import { createLanService } from './lan-services.js';
import { createTcpService } from './tcp-service.js';
import { createDq9WfcHandler, httpBytes } from './dq9-wfc.js';
import { createSsl3Server } from './dq9/ssl3.js';
import { createFileStore, dlcPath } from './file-store.js';

// A service receives raw Ethernet frames actually emitted by melonDS WifiAP.
// Its responses are enqueued at Platform::Net_RecvPacket, never substituted
// for a game-facing result in JavaScript.
export function createVirtualNetwork(api, { onEvent = () => {} } = {}) {
  const servers = new Map();
  const pending = new Map();
  let suspended = false;
  const diagnostic = (id, protocol, summary, detail = '', direction = 'TX') => onEvent({ type: 'wifi-log', instanceId: id, direction, timestamp: new Date().toLocaleTimeString(), packetType: protocol, logical: true, length: 0, decoded: { source: direction === 'TX' ? `#${id}` : 'WFC', destination: direction === 'TX' ? 'WFC' : `#${id}`, protocol, summary, detail } });
  const files = createFileStore();
  function register({ instanceId: id, onFrame }) {
    instanceId(id);
    if (typeof onFrame !== 'function') throw new TypeError('onFrame must be a function');
    servers.get(id)?.close?.();
    servers.set(id, onFrame);
    if (suspended) onFrame.suspend?.();
    return () => { if (servers.get(id) === onFrame) { servers.delete(id); onFrame.close?.(); } };
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
      emitFrame: frame => api.injectNetworkFrame({ instanceId: id, data: frame }) });
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
    if (event.type !== 'wifi-log' || event.direction !== 'TX' || event.held) return;
    const server = servers.get(event.instanceId);
    if (!server) return;
    const work = (pending.get(event.instanceId) || Promise.resolve()).catch(() => {}).then(() => {
      if (servers.get(event.instanceId) !== server) return null;
      return server(new Uint8Array(event.payload), {
      instanceId: event.instanceId, timestamp: event.timestamp
      });
    }).then(async reply => {
      if (reply == null) return;
      if (servers.get(event.instanceId) !== server) return;
      for (const frame of Array.isArray(reply) ? reply : [reply]) {
        if (!(frame instanceof Uint8Array) || frame.length < 14 || frame.length > 2048) {
          throw new TypeError('Virtual server must return Ethernet Uint8Arrays (14..2048 bytes)');
        }
        await api.injectNetworkFrame({ instanceId: event.instanceId, data: frame });
      }
    }).catch(error => { diagnostic(event.instanceId, 'ERROR', error.message || String(error)); console.error('Virtual network server error', error); });
    pending.set(event.instanceId, work);
    work.finally(() => { if (pending.get(event.instanceId) === work) pending.delete(event.instanceId); });
  });
  return Object.freeze({
    files,
    register,
    registerLan({ instanceId: id, ...options }) {
      const onFrame = createLanService(options);
      onFrame.snapshot = () => ({ type: 'lan', options: { ...options, instanceId: id } });
      return register({ instanceId: id, onFrame });
    },
    async suspend() {
      suspended = true;
      for (const server of servers.values()) server.suspend?.();
      while (pending.size) await Promise.all([...pending.values()]);
      await Promise.all([...servers.values()].map(server => server.settle?.()));
    },
    resume() { for (const server of servers.values()) server.resume?.(); suspended = false; },
    snapshot() {
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
    unregister({ instanceId: id }) { instanceId(id); servers.get(id)?.close?.(); servers.delete(id); },
    close() { for (const service of servers.values()) service.close?.(); servers.clear(); unsubscribe(); }
  });
}
