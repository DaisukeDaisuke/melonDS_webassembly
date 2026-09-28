// SSLv3 RSA/RC4 server for the legacy Nintendo WFC client. This is scoped to
// the browser's private virtual LAN; it does not expose a network listener.
const enc = new TextEncoder();
const concat = (...items) => {
  const out = new Uint8Array(items.reduce((n, item) => n + item.length, 0));
  let pos = 0;
  for (const item of items) { out.set(item, pos); pos += item.length; }
  return out;
};
const word = n => Uint8Array.from([n >>> 8, n & 255]);
const three = n => Uint8Array.from([n >>> 16, n >>> 8 & 255, n & 255]);
const read16 = (b, i) => (b[i] << 8) | b[i + 1];
const read24 = (b, i) => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
const pem = value => {
  if (typeof value !== 'string') throw new TypeError('PEM certificate and private key are required');
  const match = value.match(/-----BEGIN [^-]+-----([A-Za-z0-9+/=\s]+)-----END [^-]+-----/);
  if (!match) throw Error('Invalid PEM');
  return Uint8Array.from(atob(match[1].replace(/\s/g, '')), char => char.charCodeAt(0));
};
function der(bytes, start = 0) {
  const tag = bytes[start]; let position = start + 1, length = bytes[position++];
  if (length & 128) {
    const count = length & 127;
    if (!count || count > 4 || position + count > bytes.length) throw Error('Invalid DER length');
    length = 0;
    for (let n = 0; n < count; n++) length = (length << 8) | bytes[position++];
  }
  if (position + length > bytes.length) throw Error('Invalid DER value');
  return { tag, value: bytes.subarray(position, position + length), next: position + length };
}
function integers(bytes) {
  const root = der(bytes);
  if (root.tag !== 0x30) throw Error('Invalid RSA key');
  let body = root.value;
  // PKCS#8 PrivateKeyInfo: version, algorithm, OCTET STRING(PKCS#1).
  let cursor = der(body, 0).next;
  if (der(body, cursor).tag === 0x30) {
    cursor = der(body, cursor).next;
    const wrapped = der(body, cursor);
    if (wrapped.tag !== 4) throw Error('Unsupported private key');
    body = der(wrapped.value).value;
  }
  const values = [];
  for (let offset = 0; offset < body.length;) {
    const item = der(body, offset);
    if (item.tag !== 2) throw Error('Invalid RSA integer');
    values.push(item.value); offset = item.next;
  }
  if (values.length < 4) throw Error('Incomplete RSA key');
  const bigint = value => BigInt(`0x${Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')}`);
  return { modulus: bigint(values[1]), exponent: bigint(values[3]), size: values[1].length - (values[1][0] === 0 ? 1 : 0) };
}
function modPow(base, exponent, modulus) {
  let value = 1n;
  for (base %= modulus; exponent; exponent >>= 1n) {
    if (exponent & 1n) value = value * base % modulus;
    base = base * base % modulus;
  }
  return value;
}
function rsaDecrypt(ciphertext, key) {
  const number = BigInt(`0x${Array.from(ciphertext, byte => byte.toString(16).padStart(2, '0')).join('')}`);
  let result = modPow(number, key.exponent, key.modulus);
  const decoded = new Uint8Array(key.size);
  for (let n = decoded.length - 1; n >= 0; n--) { decoded[n] = Number(result & 255n); result >>= 8n; }
  if (decoded[0] !== 0 || decoded[1] !== 2) throw Error('Invalid RSA premaster padding');
  const end = decoded.indexOf(0, 2);
  if (end < 10 || decoded.length - end - 1 !== 48) throw Error('Invalid RSA premaster length');
  return decoded.subarray(end + 1);
}
// RFC 1321 MD5, needed by the SSLv3 PRF and Finished hash (not in WebCrypto).
function md5(data) {
  const length = data.length;
  const padded = new Uint8Array((length + 9 + 63) & ~63);
  padded.set(data); padded[length] = 128;
  const bits = BigInt(length) * 8n;
  for (let n = 0; n < 8; n++) padded[padded.length - 8 + n] = Number(bits >> BigInt(n * 8) & 255n);
  const shift = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new DataView(padded.buffer, offset, 64);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g, s;
      if (i < 16) { f = b & c | ~b & d; g = i; s = shift[i % 4]; }
      else if (i < 32) { f = d & b | ~d & c; g = (5 * i + 1) % 16; s = shift[4 + i % 4]; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; s = shift[8 + i % 4]; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; s = shift[12 + i % 4]; }
      const value = (a + f + constants[i] + words.getUint32(g * 4, true)) >>> 0;
      [a, b, c, d] = [d, (b + ((value << s) | (value >>> (32 - s)))) >>> 0, b, c];
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const digest = new Uint8Array(16), view = new DataView(digest.buffer);
  [a0, b0, c0, d0].forEach((value, i) => view.setUint32(i * 4, value, true));
  return digest;
}
const sha = async data => new Uint8Array(await crypto.subtle.digest('SHA-1', data));
async function prf(secret, seed, count) {
  const blocks = [];
  for (let n = 1; blocks.length * 16 < count; n++) {
    const letters = new Uint8Array(n).fill(64 + n);
    blocks.push(md5(concat(secret, await sha(concat(letters, secret, seed)))));
  }
  return concat(...blocks).subarray(0, count);
}
class Rc4 {
  constructor(key) {
    this.s = Uint8Array.from({ length: 256 }, (_, n) => n);
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + this.s[i] + key[i % key.length]) & 255;
      [this.s[i], this.s[j]] = [this.s[j], this.s[i]];
    }
    this.i = 0; this.j = 0;
  }
  apply(data) {
    const output = new Uint8Array(data.length);
    for (let n = 0; n < data.length; n++) {
      this.i = (this.i + 1) & 255; this.j = (this.j + this.s[this.i]) & 255;
      [this.s[this.i], this.s[this.j]] = [this.s[this.j], this.s[this.i]];
      output[n] = data[n] ^ this.s[(this.s[this.i] + this.s[this.j]) & 255];
    }
    return output;
  }
}
function sequence(number) {
  const out = new Uint8Array(8);
  for (let n = 7; n >= 0; n--) { out[n] = Number(number & 255n); number >>= 8n; }
  return out;
}
async function mac(secret, type, payload, number, digest) {
  const padding = digest === sha ? 40 : 48;
  const inner = concat(secret, new Uint8Array(padding).fill(0x36), sequence(number),
    Uint8Array.of(type), word(payload.length), payload);
  return digest(concat(secret, new Uint8Array(padding).fill(0x5c), await digest(inner)));
}
async function finished(master, transcript, sender) {
  const result = [];
  for (const [digest, size] of [[md5, 48], [sha, 40]]) {
    const inner = await digest(concat(transcript, enc.encode(sender), master, new Uint8Array(size).fill(0x36)));
    result.push(await digest(concat(master, new Uint8Array(size).fill(0x5c), inner)));
  }
  return concat(...result);
}
const handshake = (type, body) => concat(Uint8Array.of(type), three(body.length), body);
const record = (type, data) => concat(Uint8Array.of(type, 3, 0), word(data.length), data);

export function createSsl3Server({ certificatePem, privateKeyPem, chainPem, onRequest, onDiagnostic = () => {} }) {
  const certificate = pem(certificatePem), chain = chainPem ? pem(chainPem) : null;
  const key = integers(pem(privateKeyPem));
  return function createSession() {
    let input = new Uint8Array(), handshakes = new Uint8Array(), transcript = new Uint8Array();
    let randomClient, randomServer, master, readCipher, writeCipher, readMac, writeMac;
    let readSeq = 0n, writeSeq = 0n, digest = sha, secure = false, established = false;
    let http = new Uint8Array();
    const certificateList = concat(...[certificate, chain].filter(Boolean).map(cert => concat(three(cert.length), cert)));
    const serverCert = handshake(11, concat(three(certificateList.length), certificateList));
    async function decrypt(type, data) {
      if (!readCipher) throw Error('SSL cipher not ready');
      const bytes = readCipher.apply(data), size = digest === sha ? 20 : 16;
      if (bytes.length < size) throw Error('SSL MAC truncated');
      const message = bytes.subarray(0, bytes.length - size);
      const expected = await mac(readMac, type, message, readSeq++, digest);
      if (!expected.every((value, index) => value === bytes[message.length + index])) throw Error('SSL MAC mismatch');
      return message;
    }
    async function encrypt(type, data) {
      return record(type, writeCipher.apply(concat(data, await mac(writeMac, type, data, writeSeq++, digest))));
    }
    async function acceptHandshake(message) {
      const type = message[0], body = message.subarray(4);
      if (type === 1 && !randomClient) {
        if (body.length < 38 || body[0] !== 3) throw Error('Invalid SSL ClientHello');
        randomClient = body.slice(2, 34);
        const sessionEnd = 35 + body[34];
        if (sessionEnd + 2 > body.length) throw Error('Invalid cipher list');
        const cipherLength = read16(body, sessionEnd);
        const ciphers = body.subarray(sessionEnd + 2, sessionEnd + 2 + cipherLength);
        if (ciphers.length !== cipherLength) throw Error('Invalid cipher list length');
        const suite = ciphers.some((_, n) => n % 2 === 0 && ciphers[n] === 0 && ciphers[n + 1] === 5) ? 5
          : ciphers.some((_, n) => n % 2 === 0 && ciphers[n] === 0 && ciphers[n + 1] === 4) ? 4 : 0;
        if (!suite) throw Error('Client lacks SSL_RSA_WITH_RC4 cipher');
        onDiagnostic(`ClientHello → SSLv3 RSA RC4 ${suite === 5 ? 'SHA' : 'MD5'} · Certificate / ServerHelloDone`);
        digest = suite === 5 ? sha : md5;
        randomServer = crypto.getRandomValues(new Uint8Array(32));
        const hello = handshake(2, concat(Uint8Array.of(3, 0), randomServer,
          Uint8Array.of(0, 0, suite, 0)));
        const done = handshake(14, new Uint8Array());
        transcript = concat(transcript, message, hello, serverCert, done);
        return concat(record(22, hello), record(22, serverCert), record(22, done));
      }
      if (type === 16 && randomServer && !master) {
        const encrypted = body.length > 2 && read16(body, 0) === body.length - 2 ? body.subarray(2) : body;
        const preMaster = rsaDecrypt(encrypted, key);
        onDiagnostic('ClientKeyExchange · RSA復号完了');
        if (preMaster[0] !== 3) throw Error('Invalid premaster version');
        master = await prf(preMaster, concat(randomClient, randomServer), 48);
        const macSize = digest === sha ? 20 : 16;
        const keys = await prf(master, concat(randomServer, randomClient), macSize * 2 + 32);
        readMac = keys.subarray(0, macSize); writeMac = keys.subarray(macSize, macSize * 2);
        readCipher = new Rc4(keys.subarray(macSize * 2, macSize * 2 + 16));
        writeCipher = new Rc4(keys.subarray(macSize * 2 + 16, macSize * 2 + 32));
        transcript = concat(transcript, message);
        return new Uint8Array();
      }
      if (type === 20 && secure && !established) {
        const expected = await finished(master, transcript, 'CLNT');
        if (!expected.every((value, index) => value === body[index]) || body.length !== expected.length) {
          throw Error('SSL client Finished mismatch');
        }
        transcript = concat(transcript, message);
        established = true;
        onDiagnostic('Finished検証成功 · SSLv3接続確立');
        const serverDone = handshake(20, await finished(master, transcript, 'SRVR'));
        return concat(record(20, Uint8Array.of(1)), await encrypt(22, serverDone));
      }
      throw Error('Unexpected SSL handshake');
    }
    return {
      async receive(chunk) {
        input = concat(input, chunk);
        if (input.length > 5 * 1024 * 1024 + 65536) throw Error('SSL input too large');
        const outgoing = [];
        while (input.length >= 5) {
          const type = input[0], length = read16(input, 3);
          if (input[1] !== 3 || length > 18432) throw Error('Invalid SSL record');
          if (input.length < length + 5) break;
          let payload = input.subarray(5, 5 + length);
          input = input.slice(5 + length);
          if (type === 20) {
            if (!master || payload.length !== 1 || payload[0] !== 1) throw Error('Invalid ChangeCipherSpec');
            secure = true; continue;
          }
          if (secure) payload = await decrypt(type, payload);
          if (type === 22) {
            handshakes = concat(handshakes, payload);
            while (handshakes.length >= 4) {
              const length = read24(handshakes, 1);
              if (length > 65536) throw Error('SSL handshake too large');
              if (handshakes.length < length + 4) break;
              const message = handshakes.slice(0, length + 4);
              handshakes = handshakes.slice(length + 4);
              outgoing.push(await acceptHandshake(message));
            }
          } else if (type === 23 && established) {
            http = concat(http, payload);
            if (http.length > 5 * 1024 * 1024 + 32768) throw Error('HTTP request too large');
            const separator = http.findIndex((_, n) => http[n] === 13 && http[n + 1] === 10 && http[n + 2] === 13 && http[n + 3] === 10);
            if (separator >= 0) {
              const headers = new TextDecoder().decode(http.subarray(0, separator)).split('\r\n');
              const [method, path] = headers[0].split(' ');
              const fields = new Map(headers.slice(1).map(line => {
                const offset = line.indexOf(':');
                return [line.slice(0, offset).toLowerCase(), line.slice(offset + 1).trim()];
              }));
              const count = Number(fields.get('content-length') || 0);
              if (!Number.isSafeInteger(count) || count < 0 || count > 5 * 1024 * 1024) throw Error('Invalid HTTP body');
              if (http.length >= separator + 4 + count) {
                const reply = await onRequest({ port: 443, host: fields.get('host') || '', method, path,
                  body: http.slice(separator + 4, separator + 4 + count) });
                for (let offset = 0; offset < reply.length; offset += 16384) {
                  outgoing.push(await encrypt(23, reply.subarray(offset, offset + 16384)));
                }
                http = new Uint8Array();
                return { bytes: concat(...outgoing), close: true };
              }
            }
          } else if (type === 21) { onDiagnostic(`SSL Alert level ${payload[0]} description ${payload[1]}`); return { bytes: concat(...outgoing), close: true }; }
          else throw Error('Unexpected SSL record');
        }
        return { bytes: concat(...outgoing), close: false };
      }
    };
  };
}
