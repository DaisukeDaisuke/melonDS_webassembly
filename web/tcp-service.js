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
  const listeners = new Map();
  function notifyClose(connection, reason) {
    if (connection.raw) listeners.get(connection.port)?.onClose?.(peer(connection), reason);
  }
  function peer(connection) {
    return Object.freeze({ address: Array.from(connection.clientIp).join('.'),
      port: connection.clientPort, localAddress: address, localPort: connection.port });
  }
  function enqueue(connection, result) {
    if (result == null) return;
    const data = result instanceof Uint8Array ? result : result.data;
    if (data != null) {
      if (!(data instanceof Uint8Array)) throw new TypeError('TCP response must contain Uint8Array data');
      if (data.length > 5 * 1024 * 1024) throw new RangeError('TCP response exceeds 5 MiB');
      if (data.length) connection.queue.push(data.slice());
    }
    if (result.close === true) connection.closing = true;
  }
  let retransmitTimer;
  let frozenAt = null;
  const emissions = new Set();
  function tick() {
    if (frozenAt !== null) return;
    const now = Date.now();
    for (const [key, connection] of connections) {
      if (now - connection.lastSeen > 120000 || connection.inflight?.retries >= 8) {
        onDiagnostic(`Connection timeout ${key}`);
        notifyClose(connection, 'timeout');
        connections.delete(key);
        continue;
      }
      if (connection.inflight && now - connection.inflight.sentAt > 500) {
        connection.inflight.sentAt = now;
        connection.inflight.retries++;
        const emission = Promise.resolve(emitFrame(connection.inflight.frame)).catch(error => console.error('Virtual TCP retry failed', error));
        emissions.add(emission); emission.finally(() => emissions.delete(emission));
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
      const bytes = connection.output.subarray(connection.position, connection.position + Math.min(connection.mss, connection.window));
      if (!bytes.length) return null;
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
    const listener = listeners.get(port);
    if (!listener && !(port === 80 && onRequest) && !(port === 443 && createSecureSession)) return null;
    const clientIp = frame.subarray(26, 30);
    const clientPort = read16(frame, offset);
    const key = `${Array.from(clientIp).join('.')}:${clientPort}:${port}`;
    const flags = frame[offset + 13], clientSeq = read32(frame, offset + 4);
    if (flags & 0x04) {
      const connection = connections.get(key);
      if (connection) notifyClose(connection, 'reset');
      connections.delete(key); return null;
    }
    if (flags & 0x02) {
      const existing = connections.get(key);
      if (existing && !existing.accepted && existing.initialClientSeq === clientSeq && existing.synReply) {
        existing.lastSeen = Date.now();
        return existing.synReply;
      }
      if (connections.size >= 64 && !connections.has(key)) return null;
      let mss = 536;
      for (let cursor = offset + 20; cursor < offset + header;) {
        const kind = frame[cursor];
        if (kind === 0) break;
        if (kind === 1) { cursor++; continue; }
        const size = frame[cursor + 1];
        if (size < 2 || cursor + size > offset + header) break;
        if (kind === 2 && size === 4) mss = Math.max(1, Math.min(1460, read16(frame, cursor + 2)));
        cursor += size;
      }
      const connection = { mac: frame.slice(6, 12), clientIp: clientIp.slice(), clientPort, port, mss, window: read16(frame, offset + 14),
        lastSeen: Date.now(), initialClientSeq: clientSeq,
        ack: (clientSeq + 1) >>> 0, seq: (Math.random() * 0xffffffff) >>> 0,
        ipId: 1, inflight: null, request: new Uint8Array(), output: null, queue: [],
        closing: false, position: 0, finSent: false,
        raw: !!listener, accepted: false,
        secure: !listener && port === 443 ? createSecureSession() : null };
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
    connection.window = read16(frame, offset + 14);
    connection.lastSeen = Date.now();
    const acknowledged = read32(frame, offset + 8);
    if ((flags & 0x10) && connection.inflight && acknowledged === connection.inflight.end) connection.inflight = null;
    const payload = frame.subarray(offset + header, 14 + total);
    const replies = [];
    if (connection.raw && !connection.accepted) {
      if (!(flags & 0x10) || acknowledged !== connection.seq || clientSeq !== connection.ack) return null;
      connection.accepted = true;
      try { enqueue(connection, await listener?.onConnect?.(peer(connection))); }
      catch (error) {
        onDiagnostic(`TCP ${key}: ${error.message || error}`);
        connections.delete(key); return packet(connection, 0x14);
      }
    }
    if (payload.length && clientSeq === connection.ack) {
      if (!connection.raw && !connection.secure && connection.request.length + payload.length > 5 * 1024 * 1024 + 32768) {
        connections.delete(key); return packet(connection, 0x14);
      }
      if (!connection.raw && !connection.secure) {
        const received = new Uint8Array(connection.request.length + payload.length);
        received.set(connection.request); received.set(payload, connection.request.length);
        connection.request = received;
      }
      connection.ack = (connection.ack + payload.length) >>> 0;
      replies.push(packet(connection, 0x10));
      if (connection.raw) {
        try {
          if (!listener) throw Error('TCP listener closed');
          enqueue(connection, await listener.onData(payload.slice(), peer(connection)));
        } catch (error) {
          onDiagnostic(`TCP ${key}: ${error.message || error}`);
          notifyClose(connection, 'error');
          connections.delete(key); return packet(connection, 0x14);
        }
      } else if (connection.secure) {
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
      connection.peerFinished = true;
      if (connection.raw) connection.closing = true;
    }
    if (connection.peerFinished && connection.finSent && !connection.inflight) {
      notifyClose(connection, 'peer-fin'); connections.delete(key);
    }
    const outgoing = next(connection);
    if (outgoing) replies.push(outgoing);
    return replies.length === 0 ? null : replies;
  }
  onFrame.listen = (port, handlers) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('TCP port must be 1..65535');
    if (!handlers || typeof handlers.onData !== 'function') throw new TypeError('TCP onData callback required');
    if (listeners.has(port) || (port === 80 && onRequest) || (port === 443 && createSecureSession)) throw Error('TCP port already bound');
    listeners.set(port, handlers);
    return () => { if (listeners.get(port) === handlers) {
      for (const [key, connection] of connections) if (connection.raw && connection.port === port) {
        notifyClose(connection, 'listener-closed'); connections.delete(key);
      }
      listeners.delete(port);
    } };
  };
  onFrame.close = () => {
    for (const connection of connections.values()) notifyClose(connection, 'closed');
    connections.clear(); listeners.clear(); clearInterval(retransmitTimer); retransmitTimer = null;
  };
  onFrame.suspend = () => { if (frozenAt === null) frozenAt = Date.now(); };
  onFrame.settle = () => Promise.all([...emissions]);
  onFrame.resume = () => {
    if (frozenAt === null) return;
    const elapsed = Date.now() - frozenAt;
    for (const connection of connections.values()) {
      connection.lastSeen += elapsed;
      if (connection.inflight) connection.inflight.sentAt += elapsed;
    }
    frozenAt = null;
  };
  onFrame.snapshot = () => {
    const now = frozenAt ?? Date.now();
    if ([...connections.values()].some(connection => connection.raw)) throw Error('Custom TCP connections cannot be snapshotted');
    return [...connections].map(([key, connection]) => {
      const { secure, lastSeen, inflight, ...fields } = connection;
      return { key, ...structuredClone(fields), age: now - lastSeen,
        inflight: inflight ? { ...structuredClone(inflight), sentAt: undefined, age: now - inflight.sentAt } : null,
        secure: secure?.snapshot() || null };
    });
  };
  onFrame.restore = records => {
    if (!Array.isArray(records) || records.length > 64) throw Error('Invalid saved TCP connections');
    connections.clear();
    const now = frozenAt ?? Date.now();
    for (const record of records) {
      const { key, age, secure: state, inflight, ...fields } = record;
      const secure = state ? createSecureSession() : null;
      if (state) secure.restore(state);
      connections.set(key, { ...structuredClone(fields), lastSeen: now - age, secure,
        inflight: inflight ? { ...structuredClone(inflight), sentAt: now - inflight.age } : null });
    }
    if (connections.size && !retransmitTimer) retransmitTimer = setInterval(tick, 250);
  };
  return onFrame;
}
