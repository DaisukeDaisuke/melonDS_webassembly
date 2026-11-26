// Run in the melonDS page after loading native BIOS and firmware.
// Set window.rakurakuWirelessStartConfig before running to change the profile.
void (async () => {
  const config = {
    instanceId: 0,
    setupSsid: '******',
    ssid: 'WARPSTAR-TEST',
    security: 'open',
    key: '',
    channel: 6,
    network: { address: '192.168.0.200', clientAddress: '192.168.0.176', netmask: '255.255.255.0', dhcp: true },
    ...globalThis.rakurakuWirelessStartConfig
  };
  const api = globalThis.melonds;
  const virtual = globalThis.melondsVirtualNetwork;
  const status = await api.status({ instanceId: config.instanceId });
  if (!status.system.firmware || !status.system.nativeBios7 || !status.system.nativeBios9) {
    throw Error('Load BIOS7, BIOS9 and firmware before running wireless setup');
  }
  await globalThis.rakurakuWirelessStart?.stop();
  const encoder = new TextEncoder();
  const u16 = (bytes, offset) => (bytes[offset] << 8) | bytes[offset + 1];
  const put16 = (bytes, offset, value) => { bytes[offset] = value >>> 8; bytes[offset + 1] = value & 255; };
  const sum = bytes => bytes.reduce((total, value) => (total + value) & 0xffff, 0);
  function concat(...parts) {
    const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
  }
  function attributes(...fields) {
    const body = concat(...fields.map(([type, value]) => {
      const bytes = new Uint8Array((4 + value.length + 7) & ~7);
      put16(bytes, 0, type); put16(bytes, 2, value.length);
      bytes.set(value, 4);
      return bytes;
    }));
    const header = new Uint8Array(8);
    put16(header, 0, body.length);
    return concat(header, body);
  }
  function attribute(bytes, type) {
    if (bytes.length < 8 || u16(bytes, 0) !== bytes.length - 8) return null;
    for (let offset = 8; offset + 4 <= bytes.length;) {
      const length = u16(bytes, offset + 2);
      const next = offset + ((length + 4 + 7) & ~7);
      if (next > bytes.length) return null;
      if (u16(bytes, offset) === type) return bytes.slice(offset + 4, offset + 4 + length);
      offset = next;
    }
    return null;
  }
  function message(type, body) {
    const bytes = new Uint8Array(body.length + 8);
    put16(bytes, 0, type); put16(bytes, 2, body.length);
    bytes.set(body, 6);
    put16(bytes, bytes.length - 2, sum(bytes.subarray(0, bytes.length - 2)));
    return bytes;
  }
  const hmac = { name: 'HMAC', hash: 'SHA-256' };
  async function wrap(key, data) {
    const kek = await crypto.subtle.importKey('raw', key, 'AES-KW', false, ['wrapKey']);
    const material = await crypto.subtle.importKey('raw', data, hmac, true, ['sign']);
    return new Uint8Array(await crypto.subtle.wrapKey('raw', material, kek, 'AES-KW'));
  }
  async function unwrap(key, data) {
    const kek = await crypto.subtle.importKey('raw', key, 'AES-KW', false, ['unwrapKey']);
    const material = await crypto.subtle.unwrapKey('raw', data, kek, 'AES-KW', hmac, true, ['sign']);
    return new Uint8Array(await crypto.subtle.exportKey('raw', material));
  }
  function bootstrapKey(clientMac, bssid) {
    const apMac = Uint8Array.from(bssid.split(':'), part => parseInt(part, 16));
    // Clear the AP's locally administered bit, then put the larger MAC first.
    apMac[0] &= 0xfd;
    const order = clientMac.findIndex((octet, i) => octet !== apMac[i]);
    const macs = order >= 0 && clientMac[order] > apMac[order] ? [clientMac, apMac] : [apMac, clientMac];
    return concat(...macs, encoder.encode('WARP'));
  }
  const one = Uint8Array.of(0, 1);
  const setupPort = 58881; // 0xe601 on the wire in the DS setup library.
  const hello = message(1, attributes([1, one], [2, one], [5, one]));
  // The DS setup UI expects key slot 1. Empty keys leave the profile open.
  const empty = new Uint8Array();
  const profile = attributes([0x201, encoder.encode(config.ssid)], [0x202, one], [0x205, one],
    [0x206, empty], [0x207, empty], [0x208, empty], [0x209, empty]);
  const sessions = new Map();
  let setup, final, timer, sending = false, greetings = 0, accepted = false;
  async function onSetupPacket({ data, address, port, mac }) {
    if (port !== setupPort || data.length < 8 || u16(data, 2) !== data.length - 8 ||
        sum(data.subarray(0, data.length - 2)) !== u16(data, data.length - 2)) return;
    const type = u16(data, 0), body = data.slice(6, -2);
    const peer = `${address}/${mac.join(':')}`;
    if (type === 2) {
      let session = sessions.get(peer);
      if (!session) {
        session = { key: bootstrapKey(mac, setup.bssid), challenge: crypto.getRandomValues(new Uint8Array(8)) };
        sessions.set(peer, session);
      }
      return message(3, await wrap(session.key, attributes([0x101, session.challenge])));
    }
    const session = sessions.get(peer);
    if (!session) return;
    if (type === 4) {
      const nonce = attribute(await unwrap(session.key, body), 0x102);
      if (nonce?.length !== 8) return;
      session.profileKey = concat(session.challenge, nonce);
      return message(5, await wrap(session.profileKey, profile));
    }
    if (type === 6 && session.profileKey) {
      const result = attribute(await unwrap(session.profileKey, body), 0x301);
      if (result?.length === 1) {
        accepted = true;
        clearInterval(timer);
        console.info('Wireless setup acknowledgement', { address, result: result[0], ssid: final.ssid });
      }
    }
  }
  const radio = { instanceId: config.instanceId, channel: config.channel };
  final = await virtual.createAccessPoint({ ...radio, ssid: config.ssid, security: config.security, key: config.key, network: config.network });
  try {
    setup = await virtual.createAccessPoint({ ...radio, ssid: config.setupSsid, security: 'open',
      network: { ...config.network, dhcp: false }, udp: { [setupPort]: onSetupPacket } });
  } catch (error) { await final.close(); throw error; }
  timer = setInterval(async () => {
    if (sending || accepted || sessions.size || greetings >= 18) return;
    const [peer] = setup.peers();
    if (!peer) return;
    sending = true;
    try {
      await setup.sendUdp({ address: peer.address, port: setupPort, data: hello });
      if (++greetings === 18) clearInterval(timer);
    } catch (error) { console.error('Wireless setup greeting', error); }
    finally { sending = false; }
  }, 750);
  globalThis.rakurakuWirelessStart = Object.freeze({ setup, final,
    async stop() { clearInterval(timer); await Promise.all([setup.close(), final.close()]); } });
  console.info('Wireless setup AP created', { setup: setup.ssid, final: final.ssid });
})().catch(error => console.error('Wireless setup', error));
