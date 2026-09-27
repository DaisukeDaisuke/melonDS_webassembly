import { instanceId } from './api.js';

// A service receives raw Ethernet frames actually emitted by melonDS WifiAP.
// Its responses are enqueued at Platform::Net_RecvPacket, never substituted
// for a game-facing result in JavaScript.
export function createVirtualNetwork(api) {
  const servers = new Map();
  const unsubscribe = api.subscribe(event => {
    if (event.type !== 'wifi-log' || event.direction !== 'TX') return;
    const server = servers.get(event.instanceId);
    if (!server) return;
    Promise.resolve().then(() => server(new Uint8Array(event.payload), {
      instanceId: event.instanceId, timestamp: event.timestamp
    })).then(reply => {
      if (reply == null) return;
      if (!(reply instanceof Uint8Array) || reply.length < 14 || reply.length > 2048) {
        throw new TypeError('Virtual server must return an Ethernet Uint8Array (14..2048 bytes)');
      }
      return api.injectNetworkFrame({ instanceId: event.instanceId, data: reply });
    }).catch(error => console.error('Virtual network server error', error));
  });
  return Object.freeze({
    register({ instanceId: id, onFrame }) {
      instanceId(id);
      if (typeof onFrame !== 'function') throw new TypeError('onFrame must be a function');
      servers.set(id, onFrame);
      return () => { if (servers.get(id) === onFrame) servers.delete(id); };
    },
    unregister({ instanceId: id }) { instanceId(id); servers.delete(id); },
    close() { servers.clear(); unsubscribe(); }
  });
}
