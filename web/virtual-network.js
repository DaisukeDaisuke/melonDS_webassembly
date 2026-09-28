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
  const diagnostic = (id, protocol, summary, detail = '', direction = 'TX') => onEvent({ type: 'wifi-log', instanceId: id, direction, timestamp: new Date().toLocaleTimeString(), packetType: protocol, length: 0, decoded: { source: direction === 'TX' ? `#${id}` : 'WFC', destination: direction === 'TX' ? 'WFC' : `#${id}`, protocol, summary, detail } });
  const files = createFileStore();
  function register({ instanceId: id, onFrame }) {
    instanceId(id);
    if (typeof onFrame !== 'function') throw new TypeError('onFrame must be a function');
    servers.get(id)?.close?.();
    servers.set(id, onFrame);
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
      diagnostic(id, protocol, path, `${path}\n${new TextDecoder().decode(request.body?.subarray(0, 16384) || new Uint8Array())}`);
      const bytes = httpBytes(await handler.handle(request));
      diagnostic(id, protocol, new TextDecoder().decode(bytes.subarray(0, 128)).split('\r\n')[0], new TextDecoder().decode(bytes.subarray(0, 16384)), 'RX');
      return bytes;
    };
    if (!!certificatePem !== !!privateKeyPem) throw new TypeError('SSLv3 certificate and private key must be provided together');
    const createSecureSession = certificatePem
      ? createSsl3Server({ certificatePem, privateKeyPem, chainPem, onRequest, onDiagnostic: message => diagnostic(id, 'SSLv3', message, message) }) : null;
    const tcp = createTcpService({ address, mac, onRequest, createSecureSession, onDiagnostic: message => diagnostic(id, 'TCP', message, message),
      emitFrame: frame => api.injectNetworkFrame({ instanceId: id, data: frame }) });
    const onFrame = frame => lan(frame) || tcp(frame);
    onFrame.close = () => tcp.close();
    const unregister = register({ instanceId: id, onFrame });
    diagnostic(id, 'WFC', certificatePem ? 'HTTP / SSLv3 サーバー接続済み' : 'HTTP サーバー接続済み', `Gateway ${address}\nClient ${clientAddress}`);
    return Object.freeze({ setDlc: (game, files) => handler.setDlc(game, files), unregister });
  }
  const unsubscribe = api.subscribe(event => {
    if (event.type !== 'wifi-log' || event.direction !== 'TX') return;
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
      return register({ instanceId: id, onFrame: createLanService(options) });
    },
    registerDq9Wfc,
    async registerDq9WfcFromSameOrigin(options = {}) {
      const base = new URL('./dq9/certs/', import.meta.url);
      if (base.origin !== globalThis.location?.origin) throw Error('DQ9 certificates must be hosted with the UI on the same origin');
      const [certificatePem, privateKeyPem, chainPem] = await Promise.all(
        ['server.crt', 'server.key', 'nwc.crt'].map(async file => {
          const response = await fetch(new URL(file, base), { credentials: 'same-origin' });
          if (!response.ok) throw Error(`Cannot load same-origin DQ9 certificate ${file}: ${response.status}`);
          return response.text();
        }));
      return registerDq9Wfc({ ...options, certificatePem, privateKeyPem, chainPem });
    },
    unregister({ instanceId: id }) { instanceId(id); servers.get(id)?.close?.(); servers.delete(id); },
    close() { for (const service of servers.values()) service.close?.(); servers.clear(); unsubscribe(); }
  });
}
