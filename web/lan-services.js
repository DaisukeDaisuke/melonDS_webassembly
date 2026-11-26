// Minimal Ethernet LAN service for traffic emitted by melonDS's NetDriver.
// The DS still performs its own ARP and DNS requests; no game-facing results
// are injected directly into emulated memory.
const ethernet = 14;
const macDefault = Uint8Array.from([0x02, 0x4d, 0x44, 0x53, 0x00, 0x01]);

function ipv4(value) {
  const parts = typeof value === 'string' ? value.split('.').map(Number) : value;
  if (!Array.isArray(parts) || parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
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
function port(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new RangeError('UDP port must be 1..65535');
  return value;
}
function udpFrame({ sourceMac, targetMac, sourceIp, targetIp, sourcePort, targetPort, payload, ipId = 0 }) {
  if (!(payload instanceof Uint8Array) || payload.length > 1472) throw new RangeError('UDP payload must be a Uint8Array of 0..1472 bytes');
  port(sourcePort); port(targetPort);
  const reply = new Uint8Array(ethernet + 20 + 8 + payload.length);
  reply.set(targetMac);
  reply.set(sourceMac, 6); write16(reply, 12, 0x0800);
  const header = ethernet;
  reply[header] = 0x45; write16(reply, header + 2, reply.length - ethernet);
  write16(reply, header + 4, ipId);
  reply[header + 8] = 64; reply[header + 9] = 17;
  reply.set(sourceIp, header + 12); reply.set(targetIp, header + 16);
  write16(reply, header + 10, checksum(reply.subarray(header, header + 20)));
  const outUdp = header + 20;
  write16(reply, outUdp, sourcePort); write16(reply, outUdp + 2, targetPort);
  write16(reply, outUdp + 4, payload.length + 8);
  reply.set(payload, outUdp + 8);
  const pseudo = new Uint8Array(12 + 8 + payload.length);
  pseudo.set(sourceIp, 0); pseudo.set(targetIp, 4); pseudo[9] = 17;
  write16(pseudo, 10, 8 + payload.length);
  pseudo.set(reply.subarray(outUdp), 12);
  write16(reply, outUdp + 6, checksum(pseudo) || 0xffff);
  return reply;
}
function udpReply(frame, { broadcast = false, ...fields }) {
  return udpFrame({ ...fields, targetMac: broadcast ? broadcastMac : frame.subarray(6, 12),
    ipId: u16(frame, ethernet + 4) });
}

export function createLanService({ address = '10.0.0.1', clientAddress = '10.0.0.100', mac = macDefault,
  domains = {}, domainSuffixes = [], ignoreUnknownDomains = false, interceptDns = false } = {}) {
  const ip = ipv4(address);
  const clientIp = ipv4(clientAddress);
  const serverMac = Uint8Array.from(mac);
  if (serverMac.length !== 6) throw new TypeError('MAC address must have six octets');
  const records = new Map(Object.entries(domains).map(([name, target]) => [name.toLowerCase().replace(/\.$/, ''), ipv4(target)]));
  const suffixes = domainSuffixes.map(name => name.toLowerCase().replace(/\.$/, ''));

  const neighbors = new Map();
  const bindings = new Map();
  let nextId = 1;
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
    if (type !== 0x0800 || frame.length < 42) return null;
    const start = ethernet;
    const ihl = (frame[start] & 15) * 4;
    const total = u16(frame, start + 2);
    if ((frame[start] >>> 4) !== 4 || ihl < 20 || total < ihl || start + total > frame.length
      || (u16(frame, start + 6) & 0x3fff) !== 0) return null;
    remember(frame.subarray(start + 12, start + 16), frame.subarray(6, 12));
    if (frame[start + 9] !== 17 || total < ihl + 8) return null;
    const udp = start + ihl;
    const udpLength = u16(frame, udp + 4);
    if (udpLength < 8 || udpLength > total - ihl) return null;
    const sourcePort = u16(frame, udp), targetPort = u16(frame, udp + 2);
    if (sourcePort === 68 && targetPort === 67) {
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
        1, 4, 255, 255, 255, 0,
        3, 4, ...ip,
        6, 4, ...ip,
        51, 4, 0, 1, 0x51, 0x80,
        255
      ]);
      const dhcp = new Uint8Array(240 + options.length);
      dhcp.set(request.subarray(0, 236)); dhcp[0] = 2;
      dhcp.set(clientIp, 16); dhcp.set(ip, 20);
      dhcp.set([99, 130, 83, 99], 236); dhcp.set(options, 240);
      return udpReply(frame, { sourceMac: serverMac, sourceIp: ip,
        targetIp: Uint8Array.from([255, 255, 255, 255]), sourcePort: 67, targetPort: 68,
        payload: dhcp, broadcast: true });
    }
    // Custom UDP applications reuse the LAN parser and packet builder.
    const listener = bindings.get(targetPort);
    const target = frame.subarray(start + 16, start + 20);
    if (listener && (same(target, ip) || same(target, broadcastIp))) {
      const source = frame.slice(start + 12, start + 16);
      const request = Object.freeze({ address: Array.from(source).join('.'), port: sourcePort,
        localAddress: Array.from(target).join('.'), localPort: targetPort,
        mac: Array.from(frame.subarray(6, 12)), data: frame.slice(udp + 8, udp + udpLength) });
      const respond = payload => payload == null ? null : udpReply(frame, { sourceMac: serverMac, sourceIp: ip,
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
    return udpReply(frame, { sourceMac: serverMac,
      sourceIp: interceptDns ? frame.subarray(start + 16, start + 20) : ip,
      targetIp: frame.subarray(start + 12, start + 16), sourcePort: 53, targetPort: sourcePort, payload: dns });
  }
  onFrame.bindUdp = (localPort, handler) => {
    port(localPort);
    if (localPort === 53 || localPort === 67 || localPort === 68) throw new Error('Reserved LAN service port');
    if (typeof handler !== 'function') throw new TypeError('UDP listener must be a function');
    if (bindings.has(localPort)) throw new Error('UDP port already bound');
    bindings.set(localPort, handler);
    return () => { if (bindings.get(localPort) === handler) bindings.delete(localPort); };
  };
  onFrame.peers = () => [...neighbors].map(([address, mac]) => ({ address, mac: Array.from(mac) }));
  onFrame.sendUdp = ({ sourcePort, address, port: targetPort, data }) => {
    const targetIp = ipv4(address);
    const targetMac = same(targetIp, broadcastIp) ? broadcastMac : neighbors.get(Array.from(targetIp).join('.'));
    if (!targetMac) throw new Error('UDP peer has not been discovered by the virtual LAN');
    return udpFrame({ sourceMac: serverMac, targetMac, sourceIp: ip, targetIp,
      sourcePort, targetPort, payload: data, ipId: nextId++ & 0xffff });
  };
  onFrame.close = () => { bindings.clear(); neighbors.clear(); };
  return onFrame;
}
