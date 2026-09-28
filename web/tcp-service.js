// One response segment is kept in flight at a time; DS ACKs pace downloads.
// Runs only on real IPv4/TCP frames from Platform::Net_SendPacket.
const read16 = (b, p) => (b[p] << 8) | b[p + 1];
const read32 = (b, p) => (((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);
const write16 = (b, p, v) => { b[p] = v >>> 8; b[p + 1] = v & 255; };
const write32 = (b, p, v) => { write16(b, p, v >>> 16); write16(b, p + 2, v); };
function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i] << 8) | (bytes[i + 1] || 0);
  while (sum > 0xffff) sum = (sum & 65535) + (sum >>> 16);
  return (~sum) & 65535;
}
const ip = address => Uint8Array.from(address.split('.').map(Number));
const equals = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);
const text = new TextDecoder();

export function createTcpService({ address, mac, onRequest, createSecureSession, emitFrame, onDiagnostic = () => {} }) {
  const serverIp = ip(address);
  const serverMac = Uint8Array.from(mac);
  const connections = new Map();
  let retransmitTimer;
  function tick() {
    const now = Date.now();
    for (const [key, connection] of connections) {
      if (now - connection.lastSeen > 120000 || connection.inflight?.retries >= 8) {
        onDiagnostic(`Connection timeout ${key}`);
        connections.delete(key);
        continue;
      }
      if (connection.inflight && now - connection.inflight.sentAt > 500) {
        connection.inflight.sentAt = now;
        connection.inflight.retries++;
        Promise.resolve(emitFrame(connection.inflight.frame)).catch(error => console.error('Virtual TCP retry failed', error));
      }
    }
    if (!connections.size) { clearInterval(retransmitTimer); retransmitTimer = null; }
  }
  const inFlight = (end, frame) => ({ end, frame, sentAt: Date.now(), retries: 0 });
  function packet(connection, flags, data = new Uint8Array(), seq = connection.seq) {
    const out = new Uint8Array(14 + 20 + 20 + data.length);
    out.set(connection.mac); out.set(serverMac, 6); write16(out, 12, 0x0800);
    out[14] = 0x45; write16(out, 16, out.length - 14); write16(out, 18, connection.ipId++);
    out[22] = 64; out[23] = 6;
    out.set(serverIp, 26); out.set(connection.clientIp, 30);
    write16(out, 24, checksum(out.subarray(14, 34)));
    const tcp = 34;
    write16(out, tcp, connection.port); write16(out, tcp + 2, connection.clientPort);
    write32(out, tcp + 4, seq); write32(out, tcp + 8, connection.ack);
    out[tcp + 12] = 0x50; out[tcp + 13] = flags;
    write16(out, tcp + 14, 8192);
    out.set(data, tcp + 20);
    const pseudo = new Uint8Array(12 + 20 + data.length);
    pseudo.set(serverIp); pseudo.set(connection.clientIp, 4);
    pseudo[9] = 6; write16(pseudo, 10, 20 + data.length);
    pseudo.set(out.subarray(tcp), 12);
    write16(out, tcp + 16, checksum(pseudo));
    return out;
  }
  function next(connection) {
    if (connection.inflight) return null;
    if (!connection.output && connection.queue.length) {
      connection.output = connection.queue.shift();
      connection.position = 0;
    }
    if (!connection.output) {
      if (connection.closing && !connection.finSent) {
        const frame = packet(connection, 0x11);
        connection.seq = (connection.seq + 1) >>> 0;
        connection.inflight = inFlight(connection.seq, frame);
        connection.finSent = true;
        return frame;
      }
      return null;
    }
    if (connection.position < connection.output.length) {
      const bytes = connection.output.subarray(connection.position, connection.position + 1200);
      const frame = packet(connection, 0x18, bytes);
      connection.seq = (connection.seq + bytes.length) >>> 0;
      connection.position += bytes.length;
      connection.inflight = inFlight(connection.seq, frame);
      return frame;
    }
    connection.output = null;
    if (connection.queue.length) return next(connection);
    if (connection.closing && !connection.finSent) {
      const frame = packet(connection, 0x11);
      connection.seq = (connection.seq + 1) >>> 0;
      connection.inflight = inFlight(connection.seq, frame);
      connection.finSent = true;
      return frame;
    }
    return null;
  }
  function requestReady(connection) {
    const bytes = connection.request;
    let headerEnd = -1;
    for (let n = 0; n < bytes.length - 3; n++) {
      if (bytes[n] === 13 && bytes[n + 1] === 10 && bytes[n + 2] === 13 && bytes[n + 3] === 10) {
        headerEnd = n + 4; break;
      }
    }
    if (headerEnd < 0) {
      if (bytes.length > 32768) throw Error('HTTP headers exceed 32KiB');
      return null;
    }
    if (headerEnd > 32768) throw Error('HTTP headers exceed 32KiB');
    const lines = text.decode(bytes.subarray(0, headerEnd)).split('\r\n');
    const [method, path, version] = lines[0].split(' ');
    if (!['HTTP/1.0', 'HTTP/1.1'].includes(version) || !path?.startsWith('/') || !/^[A-Z]+$/.test(method || '')) throw Error('Invalid HTTP request');
    const headers = {};
    for (const line of lines.slice(1)) {
      if (!line) break;
      const separator = line.indexOf(':');
      if (separator < 1) throw Error('Invalid HTTP header');
      const name = line.slice(0, separator).toLowerCase();
      if ((name === 'content-length' || name === 'host') && name in headers) throw Error('Duplicate HTTP header');
      headers[name] = line.slice(separator + 1).trim();
    }
    if (headers['transfer-encoding']) throw Error('Unsupported HTTP transfer encoding');
    const length = headers['content-length'] === undefined ? 0 : Number(headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 0 || length > 5 * 1024 * 1024) throw Error('Invalid HTTP body length');
    if (bytes.length < headerEnd + length) return null;
    return { port: connection.port, host: headers.host || '', method, path,
      body: bytes.slice(headerEnd, headerEnd + length) };
  }
  async function onFrame(frame) {
    if (!(frame instanceof Uint8Array) || frame.length < 54 || read16(frame, 12) !== 0x0800 ||
      frame[14] >>> 4 !== 4 || frame[23] !== 6 || !equals(frame.subarray(30, 34), serverIp)) return null;
    const ihl = (frame[14] & 15) * 4, total = read16(frame, 16);
    if (ihl < 20 || total < ihl + 20 || 14 + total > frame.length || (read16(frame, 20) & 0x3fff)) return null;
    const offset = 14 + ihl, header = (frame[offset + 12] >>> 4) * 4;
    if (header < 20 || ihl + header > total) return null;
    const port = read16(frame, offset + 2);
    if (port !== 80 && (port !== 443 || !createSecureSession)) return null;
    const clientIp = frame.subarray(26, 30);
    const clientPort = read16(frame, offset);
    const key = `${Array.from(clientIp).join('.')}:${clientPort}:${port}`;
    const flags = frame[offset + 13], clientSeq = read32(frame, offset + 4);
    if (flags & 0x04) { connections.delete(key); return null; }
    if (flags & 0x02) {
      const existing = connections.get(key);
      if (existing && existing.initialClientSeq === clientSeq && existing.synReply) {
        existing.lastSeen = Date.now();
        return existing.synReply;
      }
      if (connections.size >= 64 && !connections.has(key)) return null;
      const connection = { mac: frame.slice(6, 12), clientIp: clientIp.slice(), clientPort, port,
        lastSeen: Date.now(), initialClientSeq: clientSeq,
        ack: (clientSeq + 1) >>> 0, seq: (Math.random() * 0xffffffff) >>> 0,
        ipId: 1, inflight: null, request: new Uint8Array(), output: null, queue: [],
        closing: false, position: 0, finSent: false,
        secure: port === 443 ? createSecureSession() : null };
      connections.set(key, connection);
      if (emitFrame && !retransmitTimer) retransmitTimer = setInterval(tick, 250);
      const reply = packet(connection, 0x12);
      connection.synReply = reply;
      onDiagnostic(`SYN ${key} → SYN ACK`);
      connection.seq = (connection.seq + 1) >>> 0;
      connection.inflight = inFlight(connection.seq, reply);
      return reply;
    }
    const connection = connections.get(key);
    if (!connection) return null;
    connection.lastSeen = Date.now();
    const acknowledged = read32(frame, offset + 8);
    if (connection.inflight && acknowledged === connection.inflight.end) connection.inflight = null;
    const payload = frame.subarray(offset + header, 14 + total);
    const replies = [];
    if (payload.length && clientSeq === connection.ack) {
      if (!connection.secure && connection.request.length + payload.length > 5 * 1024 * 1024 + 32768) {
        connections.delete(key); return packet(connection, 0x14);
      }
      if (!connection.secure) {
        const received = new Uint8Array(connection.request.length + payload.length);
        received.set(connection.request); received.set(payload, connection.request.length);
        connection.request = received;
      }
      connection.ack = (connection.ack + payload.length) >>> 0;
      replies.push(packet(connection, 0x10));
      if (connection.secure) {
        try {
          const { bytes, close } = await connection.secure.receive(payload);
          if (bytes.length) connection.queue.push(bytes);
          if (close) connection.closing = true;
        } catch (error) {
          onDiagnostic(`SSL ${key}: ${error.message || error}`);
          connections.delete(key);
          return packet(connection, 0x14);
        }
      } else if (!connection.output && !connection.queue.length) {
        try {
          const request = requestReady(connection);
          if (request) { connection.queue.push(await onRequest(request)); connection.closing = true; }
        } catch (error) {
          onDiagnostic(`HTTP ${key}: ${error.message || error}`);
          connections.delete(key);
          return packet(connection, 0x14);
        }
      }
    } else if (payload.length && clientSeq !== connection.ack) replies.push(packet(connection, 0x10));
    if ((flags & 0x01) && ((clientSeq + payload.length) >>> 0) === connection.ack) {
      connection.ack = (connection.ack + 1) >>> 0;
      replies.push(packet(connection, 0x10));
      if (connection.finSent && !connection.inflight) connections.delete(key);
    }
    const outgoing = next(connection);
    if (outgoing) replies.push(outgoing);
    return replies.length === 0 ? null : replies;
  }
  onFrame.close = () => { connections.clear(); clearInterval(retransmitTimer); retransmitTimer = null; };
  return onFrame;
}
