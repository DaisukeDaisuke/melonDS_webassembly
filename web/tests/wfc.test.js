import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, publicEncrypt, constants } from 'node:crypto';
import { createDq9WfcHandler, httpBytes } from '../dq9-wfc.js';
import { createLanService } from '../lan-services.js';
import { createTcpService } from '../tcp-service.js';
import { createSsl3Server } from '../dq9/ssl3.js';
import { dlcPath } from '../file-store.js';
import { uploadPath } from '../file-explorer.js';

const form = fields => new TextEncoder().encode(Object.entries(fields)
  .map(([key, value]) => `${key}=${encodeURIComponent(Buffer.from(value).toString('base64').replaceAll('=', '*'))}`).join('&'));
const encoded = value => Buffer.from(value).toString('base64').replaceAll('=', '*');
const u16 = (b, i) => b[i] * 256 + b[i + 1];
const u32 = (b, i) => (b[i] * 0x1000000 + b[i + 1] * 65536 + b[i + 2] * 256 + b[i + 3]) >>> 0;
const put16 = (b, i, n) => { b[i] = n >>> 8; b[i + 1] = n & 255; };
const put32 = (b, i, n) => { put16(b, i, n >>> 16); put16(b, i + 2, n); };

test('ported NAS login/svcloc and DLC responses preserve star-base64 and bytes', async () => {
  const wfc = createDq9WfcHandler({ dlc: { YDQJ: {
    '_list.txt': 'first\rsecond\n', first: Uint8Array.from([0, 255, 1])
  } } });
  const login = await wfc.handle({ port: 443, host: 'nas.nintendowifi.net', path: '/ac',
    body: form({ action: 'login', gamecd: 'YDQJ' }) });
  const body = new TextDecoder().decode(login.body);
  assert.equal(login.status, 200);
  assert.match(body, new RegExp(`returncd=${encoded('001')}`));
  assert.match(body, /challenge=Uk5SMUhMQVM\*/);
  const svc = await wfc.handle({ port: 443, host: 'nas.nintendowifi.net', path: '/ac',
    body: form({ action: 'svcloc', svc: '9000', gamecd: 'YDQJ' }) });
  assert.match(new TextDecoder().decode(svc.body), /svchost=/);
  const base = { port: 443, host: 'dls1.nintendowifi.net', path: '/download', method: 'POST' };
  const count = await wfc.handle({ ...base, body: form({ action: 'count', gamecd: 'YDQJ' }) });
  assert.equal(new TextDecoder().decode(count.body), '2');
  const list = await wfc.handle({ ...base, body: form({ action: 'list', gamecd: 'YDQJ' }) });
  assert.equal(new TextDecoder().decode(list.body), 'first\r\nsecond\r\n');
  const content = await wfc.handle({ ...base, body: form({ action: 'contents', gamecd: 'YDQJ', contents: 'first' }) });
  assert.deepEqual([...content.body], [0, 255, 1]);
  assert.match(new TextDecoder().decode(httpBytes(content).subarray(0, 220)), /Content-Length: 3/);
  const invalid = await wfc.handle({ ...base, body: form({ action: 'contents', gamecd: 'YDQJ', contents: '../first' }) });
  assert.equal(invalid.status, 400);
});

test('four-letter file paths and live UTF-8 DLC provider', async () => {
  assert.equal(dlcPath('ydqj', '_list.txt'), '/YDQJ/_list.txt');
  assert.equal(uploadPath('YDQJ/_list.txt', 'ABCD'), '/YDQJ/_list.txt');
  assert.equal(uploadPath('dlc/YDQJ/file', 'ABCD'), '/YDQJ/file');
  assert.throws(() => dlcPath('A', 'file'), /four-letter/);
  assert.throws(() => uploadPath('YDQJ/sub/file', 'YDQJ'), /Drop files/);
  const live = new Map([['_list.txt', new Blob(['one\ntwo\rthree\r\n'])]]);
  const wfc = createDq9WfcHandler({ getFile: async ({ gamecd, name }) => {
    assert.equal(gamecd, 'YDQJ');
    return live.get(name) || null;
  } });
  const request = action => wfc.handle({ port: 443, host: 'dls1.nintendowifi.net', path: '/download',
    body: form({ action, gamecd: 'YDQJ' }) });
  assert.equal(new TextDecoder().decode((await request('count')).body), '3');
  assert.equal(new TextDecoder().decode((await request('list')).body), 'one\r\ntwo\r\nthree\r\n');
  live.set('_list.txt', new Blob(['changed\n']));
  assert.equal(new TextDecoder().decode((await request('count')).body), '1');
});

test('DNS suffix and DHCP answers come from Ethernet packets', () => {
  const lan = createLanService({ domainSuffixes: ['nintendowifi.net'] });
  const name = Uint8Array.from([3, 110, 97, 115, 12, ...Buffer.from('nintendowifi'), 3, 110, 101, 116, 0]);
  const dns = new Uint8Array(12 + name.length + 4);
  put16(dns, 0, 0x1234); put16(dns, 2, 0x100); put16(dns, 4, 1);
  dns.set(name, 12); put16(dns, dns.length - 4, 1); put16(dns, dns.length - 2, 1);
  const frame = new Uint8Array(42 + dns.length);
  put16(frame, 12, 0x0800); frame[14] = 0x45; put16(frame, 16, frame.length - 14);
  frame[23] = 17; frame.set([10, 0, 0, 100], 26); frame.set([10, 0, 0, 1], 30);
  put16(frame, 34, 1024); put16(frame, 36, 53); put16(frame, 38, 8 + dns.length); frame.set(dns, 42);
  const answer = lan(frame);
  assert.equal(u16(answer, 42), 0x1234);
  assert.equal(u16(answer, 48), 1);
  assert.deepEqual([...answer.subarray(-4)], [10, 0, 0, 1]);
  const dhcp = new Uint8Array(42 + 244);
  put16(dhcp, 12, 0x0800); dhcp[14] = 0x45; put16(dhcp, 16, dhcp.length - 14);
  dhcp[23] = 17; dhcp.set([255, 255, 255, 255], 30);
  put16(dhcp, 34, 68); put16(dhcp, 36, 67); put16(dhcp, 38, 8 + 244);
  dhcp[42] = 1; dhcp[43] = 1; dhcp[44] = 6;
  dhcp.set([99, 130, 83, 99, 53, 1, 1, 255], 42 + 236);
  const offer = lan(dhcp);
  assert.equal(u16(offer, 34), 67);
  assert.deepEqual([...offer.subarray(42 + 16, 42 + 20)], [10, 0, 0, 100]);
  assert.equal(offer[42 + 242], 2);
});

test('TCP answers handshake and paces HTTP response by client ACK', async () => {
  const tcp = createTcpService({ address: '10.0.0.1', mac: [2, 77, 68, 83, 0, 1],
    onRequest: async () => httpBytes({ status: 200, headers: {}, body: new TextEncoder().encode('ok') }) });
  function packet(seq, ack, flags, bytes = new Uint8Array()) {
    const b = new Uint8Array(54 + bytes.length);
    b.set([1, 2, 3, 4, 5, 6], 6); put16(b, 12, 0x0800); b[14] = 0x45;
    put16(b, 16, b.length - 14); b[23] = 6;
    b.set([10, 0, 0, 100], 26); b.set([10, 0, 0, 1], 30);
    put16(b, 34, 12345); put16(b, 36, 80);
    put32(b, 38, seq); put32(b, 42, ack); b[46] = 0x50; b[47] = flags;
    put16(b, 48, 8192);
    b.set(bytes, 54);
    return b;
  }
  const synAck = await tcp(packet(100, 0, 2));
  assert.equal(synAck[47], 0x12);
  const serverSeq = u32(synAck, 38);
  assert.equal(u32(synAck, 42), 101);
  assert.equal(await tcp(packet(101, serverSeq + 1, 0x10)), null);
  const request = new TextEncoder().encode('GET / HTTP/1.1\r\nHost: conntest.nintendowifi.net\r\n\r\n');
  const replies = await tcp(packet(101, serverSeq + 1, 0x18, request));
  assert.equal(replies[0][47], 0x10);
  assert.match(new TextDecoder().decode(replies[1].subarray(54)), /HTTP\/1.1 200 OK/);
  const fin = await tcp(packet(101 + request.length, u32(replies[1], 38) + replies[1].length - 54, 0x10));
  assert.equal(fin[0][47] & 1, 1);
});

for (const [suite, algorithm, macLength, padLength] of [[5, 'sha1', 20, 40], [4, 'md5', 16, 48]]) {
test(`SSLv3 RSA/RC4-${algorithm} handshake decrypts an HTTP request on the private LAN`, async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const server = createSsl3Server({
    certificatePem: '-----BEGIN CERTIFICATE-----\nMAA=\n-----END CERTIFICATE-----',
    chainPem: '-----BEGIN CERTIFICATE-----\nMAE=\n-----END CERTIFICATE-----',
    privateKeyPem: privateKey.export({ type: suite === 5 ? 'pkcs8' : 'pkcs1', format: 'pem' }),
    onRequest: async request => httpBytes({ status: 200, headers: {}, body: request.body })
  });
  const session = server();
  const cat = (...chunks) => Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  const hash = (algorithm, ...chunks) => createHash(algorithm).update(cat(...chunks)).digest();
  const hshake = (type, body) => cat([type, body.length >>> 16, body.length >>> 8 & 255, body.length & 255], body);
  const rec = (type, body) => cat([type, 3, 0, body.length >>> 8, body.length & 255], body);
  const random = Buffer.alloc(32, 1);
  const hello = hshake(1, cat([3, 0], random, [0, 0, 2, 0, suite, 1, 0]));
  const flight = Buffer.from((await session.receive(rec(22, hello))).bytes);
  const messages = [];
  for (let i = 0; i < flight.length;) {
    const length = u16(flight, i + 3);
    messages.push(flight.subarray(i + 5, i + 5 + length)); i += 5 + length;
  }
  assert.equal(messages.length, 3);
  assert.equal(messages[1][0], 11);
  assert.equal(messages[1][6], 10); // Two length-prefixed DER certificates.
  assert.deepEqual([...messages[1].subarray(7, 12)], [0, 0, 2, 0x30, 0]);
  assert.deepEqual([...messages[1].subarray(12, 17)], [0, 0, 2, 0x30, 1]);
  const serverRandom = messages[0].subarray(6, 38);
  const premaster = cat([3, 0], Buffer.alloc(46, 3));
  const encrypted = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, premaster);
  const cke = hshake(16, cat([encrypted.length >>> 8, encrypted.length & 255], encrypted));
  await session.receive(rec(22, cke));
  await session.receive(rec(20, [1]));
  function prf(secret, seed, count) {
    const blocks = [];
    for (let i = 1; blocks.length * 16 < count; i++) {
      const letters = Buffer.alloc(i, 64 + i);
      blocks.push(hash('md5', secret, hash('sha1', letters, secret, seed)));
    }
    return cat(...blocks).subarray(0, count);
  }
  const master = prf(premaster, cat(random, serverRandom), 48);
  const keys = prf(master, cat(serverRandom, random), macLength * 2 + 32);
  const clientMac = keys.subarray(0, macLength), clientKey = keys.subarray(macLength * 2, macLength * 2 + 16);
  function finished(transcript, sender) {
    return cat(...[['md5', 48], ['sha1', 40]].map(([algo, size]) =>
      hash(algo, master, Buffer.alloc(size, 0x5c),
        hash(algo, transcript, Buffer.from(sender), master, Buffer.alloc(size, 0x36)))));
  }
  function rc4(key) {
    const s = Array.from({ length: 256 }, (_, i) => i);
    let j = 0, a = 0, b = 0;
    for (let i = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
    return input => Buffer.from(Array.from(input, byte => {
      a = (a + 1) & 255; b = (b + s[a]) & 255; [s[a], s[b]] = [s[b], s[a]];
      return byte ^ s[(s[a] + s[b]) & 255];
    }));
  }
  const cipher = rc4(clientKey);
  function clientRecord(type, body, serial) {
    const seq = Buffer.alloc(8); seq.writeBigUInt64BE(BigInt(serial));
    const mac = hash(algorithm, clientMac, Buffer.alloc(padLength, 0x5c),
      hash(algorithm, clientMac, Buffer.alloc(padLength, 0x36), seq,
        [type], [body.length >>> 8, body.length & 255], body));
    return rec(type, cipher(cat(body, mac)));
  }
  const transcript = cat(hello, ...messages, cke);
  const clientFinished = hshake(20, finished(transcript, 'CLNT'));
  const serverFinished = (await session.receive(clientRecord(22, clientFinished, 0))).bytes;
  assert.equal(serverFinished[0], 20);
  assert.equal(serverFinished[6], 22);
  const serverCipher = rc4(keys.subarray(macLength * 2 + 16, macLength * 2 + 32));
  const serverMac = keys.subarray(macLength, macLength * 2);
  function serverPayload(record, serial) {
    const length = u16(record, 3);
    const decrypted = serverCipher(record.subarray(5, 5 + length));
    const payload = decrypted.subarray(0, decrypted.length - macLength);
    const seq = Buffer.alloc(8); seq.writeBigUInt64BE(BigInt(serial));
    assert.deepEqual(decrypted.subarray(-macLength), hash(algorithm, serverMac, Buffer.alloc(padLength, 0x5c),
      hash(algorithm, serverMac, Buffer.alloc(padLength, 0x36), seq,
        [record[0]], [payload.length >>> 8, payload.length & 255], payload)));
    return payload;
  }
  assert.deepEqual(serverPayload(serverFinished.subarray(6), 0),
    hshake(20, finished(cat(transcript, clientFinished), 'SRVR')));
  const body = Buffer.from('hello');
  const request = cat(Buffer.from(`POST / HTTP/1.1\r\nHost: nas.nintendowifi.net\r\nContent-Length: ${body.length}\r\n\r\n`), body);
  const result = (await session.receive(clientRecord(23, request, 1)));
  assert.equal(result.close, true);
  assert.equal(result.bytes[0], 23);
  const response = serverPayload(result.bytes, 1);
  assert.match(response.toString(), /HTTP\/1.1 200 OK\r\n/);
  assert.equal(response.subarray(-body.length).toString(), 'hello');
});
}
