/* Standalone DS Wi-Fi / Rakuraku wireless-start UDP responder.
 * Run this file as a classic script on melonDS WebAssembly's HTTPS page.
 * It uses only the generic AP, Ethernet-frame and virtual-network interfaces.
 * No firmware, BIOS, ROM or .mel file is uploaded to a server.
 */
void (async function main() {
  'use strict';
  const config = {
    instanceId: 0,
    slot: 0,
    // Temporary setup AP uses Nintendo's literal six-asterisk discovery SSID.
    setupSsid: '******',
    ssid: 'WARPSTAR-TEST',  // Final connection profile delivered inside AES-KW
    security: 'open',        // 'open', 'wep40', or 'wep104'
    key: '',                 // For WEP: 5 or 13 ASCII bytes; alternatively set keyHex
    keyHex: undefined,      // For WEP: 10 or 26 hexadecimal digits
    channel: 6,
    bssid: '02:f0:77:77:77:77',
    serverIp: '192.168.0.200',
    clientIp: '192.168.0.176',
    challengeHex: '0001020304050607',
    greetingIntervalMs: 2500
  };
  const api = globalThis.melonds;
  const virtual = globalThis.melondsVirtualNetwork;
  if (!api || !virtual || typeof api.configureAccessPoint !== 'function') {
    throw Error('This script requires a melonDS build with generic configureAccessPoint and register APIs');
  }
  globalThis.wirelessStartExperiment?.stop?.();
  const status = await api.status({ instanceId: config.instanceId });
  if (!status.system.firmware || !status.system.nativeBios7 || !status.system.nativeBios9) {
    throw Error('Load native BIOS7/BIOS9 and firmware.bin before running the handshake');
  }

  const encoder = new TextEncoder();
  const ip = value => Uint8Array.from(value.split('.').map(Number));
  const mac = value => Uint8Array.from(value.split(':').map(v => parseInt(v, 16)));
  const serverIp = ip(config.serverIp), clientIp = ip(config.clientIp);
  const serverMac = mac(config.bssid);
  const challenge = Uint8Array.from(config.challengeHex.match(/../g), n => parseInt(n, 16));
  const broadcastMac = new Uint8Array(6).fill(255);
  const broadcastIp = new Uint8Array(4).fill(255);
  const sixteen = (v, i) => ((v[i] << 8) | v[i + 1]);
  const write16 = (v, i, x) => { v[i] = (x >>> 8) & 255; v[i + 1] = x & 255; };
  const equals = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const bytes = (...chunks) => {
    const result = new Uint8Array(chunks.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of chunks) { result.set(part, offset); offset += part.length; }
    return result;
  };
  const be16 = n => Uint8Array.of(n >>> 8, n & 255);
  const checksum = array => {
    let sum = 0;
    for (let i = 0; i < array.length; i += 2) sum += (array[i] << 8) | (array[i + 1] || 0);
    while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
    return (~sum) & 0xffff;
  };
  function udpFrame(destinationMac, sourceIP, destinationIP, sourcePort, destinationPort, payload) {
    const frame = new Uint8Array(14 + 20 + 8 + payload.length);
    frame.set(destinationMac, 0); frame.set(serverMac, 6); write16(frame, 12, 0x0800);
    frame[14] = 0x45;
    write16(frame, 16, frame.length - 14);
    frame[22] = 64; frame[23] = 17;
    frame.set(sourceIP, 26); frame.set(destinationIP, 30);
    write16(frame, 24, checksum(frame.subarray(14, 34)));
    write16(frame, 34, sourcePort); write16(frame, 36, destinationPort);
    write16(frame, 38, payload.length + 8);
    frame.set(payload, 42);
    return frame;
  }
  function parseUdp(frame) {
    if (sixteen(frame, 12) !== 0x0800 || frame.length < 42 || frame[14] >>> 4 !== 4) return null;
    const header = (frame[14] & 15) * 4, length = sixteen(frame, 16);
    if (header < 20 || 14 + length > frame.length || length < header + 8 ||
        (sixteen(frame, 20) & 0x3fff) || frame[23] !== 17) return null;
    const start = 14 + header, udpLength = sixteen(frame, start + 4);
    if (udpLength < 8 || udpLength > length - header) return null;
    return { sourcePort: sixteen(frame, start), targetPort: sixteen(frame, start + 2),
      sourceIP: frame.slice(26, 30), payload: frame.slice(start + 8, start + udpLength),
      sourceMac: frame.slice(6, 12) };
  }
  let gatewaySeen = false;
  function handleLan(frame) {
    if (frame.length >= 42 && sixteen(frame, 12) === 0x0806 &&
        sixteen(frame, 20) === 1 && equals(frame.subarray(38, 42), serverIp)) {
      gatewaySeen = true;
      const response = new Uint8Array(42);
      response.set(frame.subarray(22, 28), 0);
      response.set(serverMac, 6); write16(response, 12, 0x0806);
      response.set([0, 1, 8, 0, 6, 4, 0, 2], 14);
      response.set(serverMac, 22); response.set(serverIp, 28);
      response.set(frame.subarray(22, 28), 32); response.set(frame.subarray(28, 32), 38);
      return response;
    }
    const udp = parseUdp(frame);
    if (!udp || udp.sourcePort !== 68 || udp.targetPort !== 67) return null;
    const request = udp.payload;
    if (request.length < 240 || !equals(request.subarray(236, 240), Uint8Array.of(99, 130, 83, 99))) return null;
    let kind = 0;
    for (let i = 240; i < request.length;) {
      const option = request[i++]; if (option === 255) break; if (option === 0) continue;
      if (i >= request.length || i + 1 + request[i] > request.length) return null;
      const n = request[i++]; if (option === 53 && n === 1) kind = request[i];
      i += n;
    }
    if (kind !== 1 && kind !== 3) return null;
    const options = Uint8Array.of(
      53, 1, kind === 1 ? 2 : 5, 54, 4, ...serverIp,
      1, 4, 255, 255, 255, 0, 3, 4, ...serverIp, 6, 4, ...serverIp,
      51, 4, 0, 1, 0x51, 0x80, 255
    );
    const reply = new Uint8Array(240 + options.length);
    reply.set(request.subarray(0, 236)); reply[0] = 2;
    reply.set(clientIp, 16); reply.set(serverIp, 20);
    reply.set([99, 130, 83, 99], 236); reply.set(options, 240);
    return udpFrame(broadcastMac, serverIp, broadcastIp, 67, 68, reply);
  }
  // The DS library encodes a TLV as two big-endian 16-bit fields followed
  // by the value and padding to an eight-byte boundary.
  function tlv(type, value) {
    const raw = new Uint8Array((4 + value.length + 7) & ~7);
    write16(raw, 0, type); write16(raw, 2, value.length);
    raw.set(value, 4);
    return raw;
  }
  function attributes(fields) {
    const body = bytes(...fields);
    const header = new Uint8Array(8);
    write16(header, 0, body.length);
    return bytes(header, body);
  }
  function findAttribute(raw, wanted) {
    if (raw.length < 8) return null;
    const end = Math.min(raw.length, 8 + sixteen(raw, 0));
    for (let pos = 8; pos + 4 <= end;) {
      const type = sixteen(raw, pos), length = sixteen(raw, pos + 2);
      if (pos + 4 + length > end) return null;
      if (type === wanted) return raw.slice(pos + 4, pos + 4 + length);
      pos += (4 + length + 7) & ~7;
    }
    return null;
  }
  function packet(type, payload) {
    const data = new Uint8Array(payload.length + 8);
    write16(data, 0, type); write16(data, 2, payload.length);
    data.set(payload, 6);
    let sum = 0;
    for (let i = 0; i < payload.length + 6; i++) sum += data[i];
    write16(data, data.length - 2, sum & 0xffff);
    return data;
  }
  function decodePacket(data) {
    if (data.length < 8 || sixteen(data, 2) + 8 > data.length) return null;
    const total = sixteen(data, 2) + 8;
    let sum = 0;
    for (let i = 0; i < total - 2; i++) sum += data[i];
    if ((sum & 0xffff) !== sixteen(data, total - 2)) return null;
    return { type: sixteen(data, 0), body: data.slice(6, total - 2) };
  }
  async function wrapAesKey(plain, kekBytes) {
    if (plain.length < 16 || (plain.length & 7)) throw Error('AES-KW plaintext must be 16+ bytes in blocks of 8');
    const kek = await crypto.subtle.importKey('raw', kekBytes, 'AES-KW', false, ['wrapKey']);
    // A temporary extractable HMAC key allows standard WebCrypto AES-KW over
    // arbitrary bytes without implementing AES or bypassing real crypto.
    const material = await crypto.subtle.importKey('raw', plain, { name: 'HMAC', hash: 'SHA-256' }, true, ['sign']);
    return new Uint8Array(await crypto.subtle.wrapKey('raw', material, kek, 'AES-KW'));
  }
  const hello = packet(1, attributes([
    tlv(1, be16(1)), tlv(2, be16(1)), tlv(5, be16(1))
  ]));
  let handshakeStarted = false;
  let finalized = false;
  async function handleProtocol(data) {
    const request = decodePacket(data);
    if (!request) return null;
    console.info('[DS Wi-Fi handshake] incoming message', request.type, request.body.length);
    if (request.type === 2) {
      handshakeStarted = true;
      return packet(3, attributes([tlv(0x101, challenge)]));
    }
    if (request.type === 4) {
      const nonce = findAttribute(request.body, 0x102);
      if (!nonce || nonce.length !== 8) throw Error('Handshake message 4 lacks its 8-byte nonce');
      const mode = config.security === 'open' ? 0 : 1;
      const fields = [
        tlv(0x201, encoder.encode(config.ssid)),
        tlv(0x202, be16(mode))
      ];
      if (mode) {
        fields.push(tlv(0x205, be16(1)));
        const key = config.keyHex !== undefined ?
          Uint8Array.from(config.keyHex.match(/../g), v => parseInt(v, 16)) : encoder.encode(config.key);
        const hexadecimal = Array.from(key, value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
        fields.push(tlv(0x206, encoder.encode(hexadecimal)));
      }
      const wrapped = await wrapAesKey(attributes(fields), bytes(challenge, nonce));
      return packet(5, wrapped);
    }
    if (request.type === 6) {
      console.info('[DS Wi-Fi handshake] final acknowledgement', Array.from(request.body));
      if (!finalized) {
        finalized = true;
        // Reconfigure the *same* AP after the DS has accepted the profile.
        setTimeout(() => void api.configureAccessPoint({
          instanceId: config.instanceId, slot: config.slot, ssid: config.ssid,
          security: config.security, key: config.key, keyHex: config.keyHex,
          channel: config.channel, bssid: config.bssid
        }).catch(error => console.error('[DS Wi-Fi handshake] final AP:', error)), 700);
      }
    }
    return null;
  }
  await api.configureAccessPoint({
    instanceId: config.instanceId, slot: config.slot, ssid: config.setupSsid,
    security: 'open', key: '', channel: config.channel, bssid: config.bssid
  });
  await api.setNetworkBackend({ instanceId: config.instanceId, backend: 'virtual' });
  let udpCount = 0, tcpCount = 0;
  const unregister = virtual.register({
    instanceId: config.instanceId,
    async onFrame(frame) {
      const maintenance = handleLan(frame);
      if (maintenance) return maintenance;
      if (frame.length < 34 || sixteen(frame, 12) !== 0x0800) return null;
      if (frame[23] === 6) {
        if (++tcpCount < 30) console.debug('[DS Wi-Fi TCP frame]', Array.from(frame));
        return null;
      }
      const udp = parseUdp(frame);
      if (!udp) return null;
      if (++udpCount < 30) console.debug('[DS Wi-Fi UDP]', udp.sourcePort, udp.targetPort, udp.payload.length);
      if (udp.targetPort !== 486) return null;
      const reply = await handleProtocol(udp.payload);
      return reply && udpFrame(udp.sourceMac, serverIp, udp.sourceIP, 486, udp.sourcePort, reply);
    }
  });
  let stopped = false, sending = false, greetings = 0;
  const initialFrame = status.frames;
  const timer = setInterval(async () => {
    if (stopped || sending || handshakeStarted || greetings >= 18) return;
    sending = true;
    try {
      const current = await api.status({ instanceId: config.instanceId });
      // Never enqueue packets while the DS is paused. Wait for an association
      // opportunity, and bound pre-association queued frames to avoid overflow.
      // The DS must first resolve the emulated setup gateway over real ARP.
      // No speculative UDP is enqueued while the Wi-Fi adapter is unassociated.
      if (current.paused || !gatewaySeen || current.frames < initialFrame + 90) return;
      greetings++;
      await api.injectNetworkFrame({ instanceId: config.instanceId,
        data: udpFrame(broadcastMac, serverIp, broadcastIp, 486, 486, hello) });
    } catch (error) { console.error('[DS Wi-Fi handshake] greeting:', error); }
    finally { sending = false; }
  }, config.greetingIntervalMs);
  globalThis.wirelessStartExperiment = Object.freeze({
    config: { ...config },
    stop() { stopped = true; clearInterval(timer); unregister(); },
    sendGreeting() { return api.injectNetworkFrame({ instanceId: config.instanceId,
      data: udpFrame(broadcastMac, serverIp, broadcastIp, 486, 486, hello) }); }
  });
  console.info('[DS Wi-Fi handshake] temporary setup AP active', config.setupSsid, 'final:', config.ssid, config.security);
})().catch(error => console.error('[DS Wi-Fi handshake]', error));
