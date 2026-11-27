import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLanService } from '../lan-services.js';
import { createVirtualNetwork } from '../virtual-network.js';

const read16 = (b, offset) => (b[offset] << 8) | b[offset + 1];

function checksum(bytes) {
  let sum = 0;
  for (let n = 0; n < bytes.length; n += 2) sum += (bytes[n] << 8) | (bytes[n + 1] || 0);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

test('large UDP payloads are MTU-safe and reassemble byte-perfectly in reverse order', () => {
  const lan = createLanService({ address: '10.0.0.1', dhcp: false });
  const received = [];
  lan.bindUdp(7788, message => { received.push(message.data); return null; });
  try {
    for (const length of [0, 1, 1472, 1473, 8192, 16000, 60000, 65507]) {
      const original = Uint8Array.from({ length }, (_, index) => (index * 71 + 13) & 255);
      const sent = lan.sendUdp({ address: '255.255.255.255', port: 7788, sourcePort: 8888, data: original });
      const frames = Array.isArray(sent) ? sent : [sent];
      assert.equal(frames.length, Math.ceil((length + 8) / 1480));
      let nextOffset = 0;
      for (const [index, frame] of frames.entries()) {
        assert.ok(frame.length <= 1514, 'oversized Ethernet frame');
        assert.equal(read16(frame, 12), 0x0800);
        assert.equal(checksum(frame.subarray(14, 34)), 0, 'invalid IPv4 header checksum');
        assert.equal((read16(frame, 20) & 0x1fff) * 8, nextOffset);
        assert.equal(Boolean(read16(frame, 20) & 0x2000), index < frames.length - 1);
        nextOffset += frame.length - 34;
      }
      assert.equal(nextOffset, length + 8);
      for (const frame of [...frames].reverse()) lan(frame);
      assert.deepEqual(received.at(-1), original, 'payload lost in IPv4 reassembly');
      assert.equal(received.length, 1 + [0, 1, 1472, 1473, 8192, 16000, 60000, 65507].indexOf(length));
    }
    assert.throws(() => lan.sendUdp({ address: '255.255.255.255', port: 7788,
      sourcePort: 8888, data: new Uint8Array(65508) }), /65507/);
  } finally { lan.close(); }
});

test('full emulator RX queue retries every fragment in the original order', async () => {
  let remainingFailures = 3;
  const delivered = [];
  const network = createVirtualNetwork({
    subscribe() { return () => {}; },
    async injectNetworkFrame({ data }) {
      if (remainingFailures-- > 0) throw new Error('injectNetworkFrame: native operation failed (-2)');
      delivered.push(data);
    }
  });
  try {
    const server = network.registerNetwork({ instanceId: 0, dhcp: false });
    const data = Uint8Array.from({ length: 8192 }, (_, index) => index & 255);
    await server.udp.send({ address: '255.255.255.255', port: 9000, sourcePort: 9000, data });
    assert.equal(delivered.length, Math.ceil((data.length + 8) / 1480));
    assert.ok(delivered.every(part => part.length <= 1514));
    assert.deepEqual(delivered.map(part => (read16(part, 20) & 0x1fff) * 8),
      delivered.map((_, i) => i * 1480));
  } finally { await network.close(); }
});

test('experiment-only tiny IPv4 fragments preserve offsets and reassemble UDP', () => {
  for (const fragmentBytes of [8, 16, 48, 1480]) {
    const lan = createLanService({ address: '10.0.0.1', dhcp: false, fragmentBytes });
    const received = [];
    lan.bindUdp(7788, msg => { received.push(msg.data); return null; });
    try {
      const original = Uint8Array.from({ length: 96 }, (_, i) => (i * 23) & 255);
      const outgoing = lan.sendUdp({ address: '255.255.255.255', port: 7788, sourcePort: 7788, data: original });
      const frames = Array.isArray(outgoing) ? outgoing : [outgoing];
      assert.equal(frames.length, Math.ceil((original.length + 8) / fragmentBytes));
      assert.deepEqual(frames.map(f => ((read16(f, 20) & 0x1fff) * 8)),
        frames.map((_, i) => i * fragmentBytes));
      assert.ok(frames.every(f => f.length <= 34 + fragmentBytes));
      for (const f of frames) assert.equal(checksum(f.subarray(14, 34)), 0);
      for (const f of frames) lan(f);
      assert.deepEqual(received, [original]);
    } finally { lan.close(); }
  }
  assert.throws(() => createLanService({ fragmentBytes: 10 }), /multiple of 8/);
  assert.throws(() => createLanService({ fragmentBytes: 1984 }), /multiple of 8/);
});

test('experimental jumbo IPv4 MTU sends a 1888-byte UDP segment in one frame', () => {
  const lan = createLanService({ address: '192.168.0.200', dhcp: false, fragmentBytes: 1920 });
  try {
    // 1880 data bytes + UDP header (8) = 1888 bytes.
    const payload = new Uint8Array(1880);
    const frame = lan.sendUdp({ address: '255.255.255.255', port: 58881, sourcePort: 58881, data: payload });
    assert.ok(frame instanceof Uint8Array);
    assert.equal(frame.length, 1922);
    assert.equal(read16(frame, 20) & 0x3fff, 0);
    assert.equal(checksum(frame.subarray(14, 34)), 0);
    assert.throws(() => createLanService({ fragmentBytes: 1984 }), /1976/);
  } finally { lan.close(); }
});
