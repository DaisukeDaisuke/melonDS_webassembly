// Minimal Ethernet LAN service for traffic emitted by melonDS's NetDriver.
// The DS still performs its own ARP and DNS requests; no game-facing results
// are injected directly into emulated memory.
const ethernet = 14;
const macDefault = Uint8Array.from([0x02, 0x4d, 0x44, 0x53, 0x00, 0x01]);

export function ipv4(value) {
  const parts = typeof value === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) ? value.split('.').map(Number) : value;
  if ((!Array.isArray(parts) && !(parts instanceof Uint8Array)) || parts.length !== 4 ||
    Array.from(parts).some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new TypeError('IP address must contain four octets');
  }
  return Uint8Array.from(parts);
}
function checksum(bytes) {
  let sum = 0;
  for (let n = 0; n < bytes.length; n += 2) sum += (bytes[n] << 8) | (bytes[n + 1] || 0);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}
function u16(data, offset) { return (data[offset] << 8) | data[offset + 1]; }
function write16(data, offset, value) { data[offset] = value >>> 8; data[offset + 1] = value & 255; }
function same(a, b) { return a.every((value, index) => value === b[index]); }
const broadcastMac = new Uint8Array(6).fill(255);
const broadcastIp = new Uint8Array(4).fill(255);
export function portNumber(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new RangeError('Port must be 1..65535');
  return value;
}
function udpFrame({ sourceMac, targetMac, sourceIp, targetIp, sourcePort, targetPort, payload, ipId = 0, fragmentBytes = 1480 }) {
  if (!(payload instanceof Uint8Array) || payload.length > 65507) throw new RangeError('UDP payload must be a Uint8Array of 0..65507 bytes');
  portNumber(sourcePort); portNumber(targetPort);
  if (!Number.isInteger(fragmentBytes) || fragmentBytes < 8 || fragmentBytes > 1976 || fragmentBytes % 8) {
    throw new RangeError('UDP fragmentBytes must be a multiple of 8 from 8 to 1976');
  }
  const udp = new Uint8Array(8 + payload.length);
  write16(udp, 0, sourcePort); write16(udp, 2, targetPort);
  write16(udp, 4, udp.length); udp.set(payload, 8);
  const pseudo = new Uint8Array(12 + udp.length);
  pseudo.set(sourceIp, 0); pseudo.set(targetIp, 4); pseudo[9] = 17;
  write16(pseudo, 10, udp.length); pseudo.set(udp, 12);
  write16(udp, 6, checksum(pseudo) || 0xffff);
  const frames = [];
  for (let offset = 0; offset < udp.length; offset += fragmentBytes) {
    const part = udp.subarray(offset, Math.min(offset + fragmentBytes, udp.length));
    const more = offset + part.length < udp.length;
    const reply = new Uint8Array(ethernet + 20 + part.length);
    reply.set(targetMac); reply.set(sourceMac, 6); write16(reply, 12, 0x0800);
    reply[ethernet] = 0x45;
    write16(reply, ethernet + 2, 20 + part.length);
    write16(reply, ethernet + 4, ipId);
    write16(reply, ethernet + 6, (offset >>> 3) | (more ? 0x2000 : 0));
    reply[ethernet + 8] = 64; reply[ethernet + 9] = 17;
    reply.set(sourceIp, ethernet + 12); reply.set(targetIp, ethernet + 16);
    write16(reply, ethernet + 10, checksum(reply.subarray(ethernet, ethernet + 20)));
    reply.set(part, ethernet + 20);
    frames.push(reply);
  }
  return frames.length === 1 ? frames[0] : frames;
}
function udpReply(frame, { broadcast = false, ...fields }) {
  return udpFrame({ ...fields, targetMac: broadcast ? broadcastMac : frame.subarray(6, 12),
    ipId: u16(frame, ethernet + 4) });
}

export function createLanService({ address = '10.0.0.1', clientAddress = '10.0.0.100', mac = macDefault,
  netmask = '255.255.255.0', dhcp = true, fragmentBytes = 1480, domains = {}, domainSuffixes = [], ignoreUnknownDomains = false, interceptDns = false } = {}) {
  if (!Number.isInteger(fragmentBytes) || fragmentBytes < 8 || fragmentBytes > 1976 || fragmentBytes % 8) {
    throw new RangeError('UDP fragmentBytes must be a multiple of 8 from 8 to 1976');
  }
  const ip = ipv4(address);
  const clientIp = ipv4(clientAddress);
  const mask = ipv4(netmask);
  const subnetBroadcast = ip.map((octet, i) => octet | (255 ^ mask[i]));
  const serverMac = Uint8Array.from(mac);
  if (serverMac.length !== 6) throw new TypeError('MAC address must have six octets');
  const records = new Map(Object.entries(domains).map(([name, target]) => [name.toLowerCase().replace(/\.$/, ''), ipv4(target)]));
  const suffixes = domainSuffixes.map(name => name.toLowerCase().replace(/\.$/, ''));

  const neighbors = new Map();
  const bindings = new Map();
  const fragments = new Map();
  let nextId = 1;
  function reassembleIpv4(frame, ihl, total) {
    const flags = u16(frame, ethernet + 6);
    if (!(flags & 0x3fff)) return frame;
    const offset = (flags & 0x1fff) * 8, more = !!(flags & 0x2000);
    const size = total - ihl;
    if (!size || (more && size % 8) || offset + size > 65515) return null;
    const key = [
      ...frame.subarray(6, 12), ...frame.subarray(ethernet + 12, ethernet + 20),
      frame[ethernet + 9], u16(frame, ethernet + 4)
    ].join('.');
    const now = Date.now();
    for (const [id, value] of fragments) if (now - value.time > 15000) fragments.delete(id);
    let entry = fragments.get(key);
    if (!entry) {
      if (fragments.size >= 64) fragments.delete(fragments.keys().next().value);
      entry = { time: now, pieces: new Map(), header: null, end: null };
      fragments.set(key, entry);
    }
    entry.time = now;
    const bytes = frame.slice(ethernet + ihl, ethernet + total);
    for (const [at, previous] of entry.pieces) {
      if (offset < at + previous.length && at < offset + size) {
        if (offset === at && previous.length === size &&
          previous.every((value, index) => value === bytes[index])) return null;
        fragments.delete(key); return null;
      }
    }
    if (entry.end !== null && offset + size > entry.end) { fragments.delete(key); return null; }
    if (!more) {
      if (entry.end !== null && entry.end !== offset + size) { fragments.delete(key); return null; }
      entry.end = offset + size;
    }
    if (offset === 0) entry.header = frame.slice(0, ethernet + ihl);
    entry.pieces.set(offset, bytes);
    if (!entry.header || entry.end === null) return null;
    const headerSize = (entry.header[ethernet] & 15) * 4;
    if (entry.end + headerSize > 65535) { fragments.delete(key); return null; }
    const result = new Uint8Array(ethernet + headerSize + entry.end);
    result.set(entry.header);
    let cursor = 0;
    for (const [at, part] of [...entry.pieces].sort((a, b) => a[0] - b[0])) {
      if (at !== cursor) return null;
      result.set(part, ethernet + headerSize + at);
      cursor += part.length;
    }
    if (cursor !== entry.end) return null;
    write16(result, ethernet + 2, headerSize + entry.end);
    write16(result, ethernet + 6, 0);
    write16(result, ethernet + 10, 0);
    write16(result, ethernet + 10, checksum(result.subarray(ethernet, ethernet + headerSize)));
    fragments.delete(key);
    return result;
  }
  function remember(addressBytes, macBytes) {
    if (addressBytes.length !== 4 || macBytes.length !== 6 || (macBytes[0] & 1)
        || macBytes.every(v => v === 0) || addressBytes.every(v => v === 0)
        || addressBytes[0] >= 224 || same(addressBytes, ip)) return;
    const address = Array.from(addressBytes).join('.');
    if (!neighbors.has(address) && neighbors.size >= 64) neighbors.delete(neighbors.keys().next().value);
    neighbors.set(address, Uint8Array.from(macBytes));
  }
  function onFrame(frame) {
    if (!(frame instanceof Uint8Array) || frame.length < ethernet) return null;
    const type = u16(frame, 12);
    if (type === 0x0806 && frame.length >= 42 && u16(frame, 14) === 1 && u16(frame, 16) === 0x0800
      && frame[18] === 6 && frame[19] === 4 && (u16(frame, 20) === 1 || u16(frame, 20) === 2)
      && same(frame.subarray(6, 12), frame.subarray(22, 28))) {
      remember(frame.subarray(28, 32), frame.subarray(22, 28));
    }
    if (type === 0x0806 && frame.length >= 42 && u16(frame, 14) === 1 && u16(frame, 16) === 0x0800
      && frame[18] === 6 && frame[19] === 4 && u16(frame, 20) === 1 && same(frame.subarray(38, 42), ip)) {
      const reply = new Uint8Array(42);
      reply.set(frame.subarray(22, 28)); reply.set(serverMac, 6); write16(reply, 12, 0x0806);
      reply.set(frame.subarray(14, 20), 14); write16(reply, 20, 2);
      reply.set(serverMac, 22); reply.set(ip, 28);
      reply.set(frame.subarray(22, 28), 32); reply.set(frame.subarray(28, 32), 38);
      return reply;
    }
    if (type !== 0x0800 || frame.length < 34) return null;
    const start = ethernet;
    let ihl = (frame[start] & 15) * 4;
    let total = u16(frame, start + 2);
    if ((frame[start] >>> 4) !== 4 || ihl < 20 || total < ihl || start + total > frame.length) return null;
    frame = reassembleIpv4(frame, ihl, total);
    if (!frame || frame.length < 42) return null;
    ihl = (frame[start] & 15) * 4; total = u16(frame, start + 2);
    remember(frame.subarray(start + 12, start + 16), frame.subarray(6, 12));
    if (frame[start + 9] !== 17 || total < ihl + 8) return null;
    const udp = start + ihl;
    const udpLength = u16(frame, udp + 4);
    if (udpLength < 8 || udpLength > total - ihl) return null;
    const sourcePort = u16(frame, udp), targetPort = u16(frame, udp + 2);
    if (dhcp && sourcePort === 68 && targetPort === 67) {
      const request = frame.subarray(udp + 8, udp + udpLength);
      if (request.length < 240 || request[0] !== 1 || request[1] !== 1 || request[2] !== 6
        || !same(request.subarray(236, 240), Uint8Array.from([99, 130, 83, 99]))) return null;
      let messageType = 0;
      for (let pos = 240; pos < request.length;) {
        const code = request[pos++];
        if (code === 255) break;
        if (code === 0) continue;
        if (pos >= request.length || pos + 1 + request[pos] > request.length) return null;
        const size = request[pos++];
        if (code === 53 && size === 1) messageType = request[pos];
        pos += size;
      }
      if (messageType !== 1 && messageType !== 3) return null;
      if (messageType === 3 && same(frame.subarray(6, 12), request.subarray(28, 34)))
        remember(clientIp, request.subarray(28, 34));
      const options = Uint8Array.from([
        53, 1, messageType === 1 ? 2 : 5,
        54, 4, ...ip,
        1, 4, ...mask,
        3, 4, ...ip,
        6, 4, ...ip,
        51, 4, 0, 1, 0x51, 0x80,
        255
      ]);
      const dhcp = new Uint8Array(240 + options.length);
      dhcp.set(request.subarray(0, 236)); dhcp[0] = 2;
      dhcp.set(clientIp, 16); dhcp.set(ip, 20);
      dhcp.set([99, 130, 83, 99], 236); dhcp.set(options, 240);
      return udpReply(frame, { fragmentBytes, sourceMac: serverMac, sourceIp: ip,
        targetIp: Uint8Array.from([255, 255, 255, 255]), sourcePort: 67, targetPort: 68,
        payload: dhcp, broadcast: true });
    }
    // Custom UDP applications reuse the LAN parser and packet builder.
    const listener = bindings.get(targetPort);
    const target = frame.subarray(start + 16, start + 20);
    if (listener && (same(target, ip) || same(target, broadcastIp) || same(target, subnetBroadcast))) {
      const source = frame.slice(start + 12, start + 16);
      const request = Object.freeze({ address: Array.from(source).join('.'), port: sourcePort,
        localAddress: ip.join('.'), localPort: targetPort, destinationAddress: target.join('.'),
        mac: Array.from(frame.subarray(6, 12)), data: frame.slice(udp + 8, udp + udpLength) });
      const respond = payload => payload == null ? null : udpReply(frame, { fragmentBytes, sourceMac: serverMac, sourceIp: ip,
        targetIp: source, sourcePort: targetPort, targetPort: sourcePort, payload });
      const response = listener(request);
      return response && typeof response.then === 'function' ? response.then(respond) : respond(response);
    }
    if (targetPort !== 53 || udpLength < 20 || (!interceptDns && !same(frame.subarray(start + 16, start + 20), ip))) return null;
    const request = frame.subarray(udp + 8, udp + udpLength);
    if (request.length < 12 || (u16(request, 2) & 0x8000) || u16(request, 4) !== 1) return null;
    let cursor = 12, position = cursor, jumped = false, steps = 0, pointers = 0, ended = false;
    const labels = [];
    while (position < request.length) {
      if (++steps > 256) return null;
      const size = request[position++];
      if ((size & 0xc0) === 0xc0) {
        if (position >= request.length || ++pointers > 32) return null;
        const target = ((size & 0x3f) << 8) | request[position++];
        if (target >= request.length) return null;
        if (!jumped) { cursor = position; jumped = true; }
        position = target;
        continue;
      }
      if (size & 0xc0) return null;
      if (!size) { if (!jumped) cursor = position; ended = true; break; }
      if (position + size > request.length || labels.length > 64) return null;
      labels.push(String.fromCharCode(...request.subarray(position, position + size)).toLowerCase());
      position += size;
    }
    if (!ended || cursor + 4 > request.length) return null;
    const questionEnd = cursor + 4;
    if (u16(request, cursor) !== 1 || u16(request, cursor + 2) !== 1) return null;
    const name = labels.join('.');
    const answer = records.get(name) || (suffixes.some(suffix => name === suffix || name.endsWith(`.${suffix}`)) ? ip : null);
    if (!answer && ignoreUnknownDomains) return null;
    const dns = new Uint8Array(questionEnd + (answer ? 16 : 0));
    dns.set(request.subarray(0, questionEnd));
    write16(dns, 2, 0x8080 | (u16(request, 2) & 0x0100) | (answer ? 0 : 3));
    write16(dns, 6, answer ? 1 : 0);
    write16(dns, 8, 0); write16(dns, 10, 0);
    if (answer) {
      write16(dns, questionEnd, 0xc00c); write16(dns, questionEnd + 2, 1);
      write16(dns, questionEnd + 4, 1);
      dns[questionEnd + 9] = 60; write16(dns, questionEnd + 10, 4);
      dns.set(answer, questionEnd + 12);
    }
    return udpReply(frame, { fragmentBytes, sourceMac: serverMac,
      sourceIp: interceptDns ? frame.subarray(start + 16, start + 20) : ip,
      targetIp: frame.subarray(start + 12, start + 16), sourcePort: 53, targetPort: sourcePort, payload: dns });
  }
  onFrame.bindUdp = (localPort, handler) => {
    portNumber(localPort);
    if (dhcp && localPort === 67) throw new Error('Reserved DHCP service port');
    if (typeof handler !== 'function') throw new TypeError('UDP listener must be a function');
    if (bindings.has(localPort)) throw new Error('UDP port already bound');
    bindings.set(localPort, handler);
    return () => { if (bindings.get(localPort) === handler) bindings.delete(localPort); };
  };
  onFrame.peers = () => [...neighbors].map(([address, mac]) => ({ address, mac: Array.from(mac) }));
  onFrame.sendUdp = ({ address = clientAddress, port: targetPort, sourcePort = targetPort, data, fragmentBytes: packetFragmentBytes = fragmentBytes }) => {
    const targetIp = ipv4(address);
    const targetMac = same(targetIp, broadcastIp) || same(targetIp, subnetBroadcast) ? broadcastMac : neighbors.get(targetIp.join('.'));
    if (!targetMac) throw new Error('UDP peer has not been discovered by the virtual LAN');
    return udpFrame({ sourceMac: serverMac, targetMac, sourceIp: ip, targetIp,
      sourcePort, targetPort, payload: data, ipId: nextId++ & 0xffff, fragmentBytes: packetFragmentBytes });
  };
  onFrame.close = () => { bindings.clear(); neighbors.clear(); fragments.clear(); };
  return onFrame;
}
