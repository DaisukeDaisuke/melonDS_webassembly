import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLanService } from '../lan-services.js';
import { decodePacket } from '../packet-decode.js';

test('UDP fragment logs show real payload sizes and ports only on the initial fragment', () => {
  const lan = createLanService({ address: '192.168.0.200', dhcp: false });
  try {
    for (const length of [2000, 7600]) {
      const data = new Uint8Array(length).fill(0xab);
      const frames = lan.sendUdp({ address: '255.255.255.255', port: 58881, sourcePort: 58881, data });
      const decoded = frames.map(payload => decodePacket({ payload }));
      assert.equal(decoded[0].source, '192.168.0.200:58881');
      assert.equal(decoded[0].destination, '255.255.255.255:58881');
      assert.equal(decoded[0].summary, `1472 B · UDP datagram ${length} B · Offset 0 · MF=1`);
      for (let i = 1; i < decoded.length; i++) {
        const offset = i * 1480;
        const size = Math.min(1480, length + 8 - offset);
        assert.equal(decoded[i].source, '192.168.0.200');
        assert.equal(decoded[i].destination, '255.255.255.255');
        assert.equal(decoded[i].summary, `${size} B · Offset ${offset} · MF=${Number(i !== decoded.length - 1)}`);
      }
      assert.ok(decoded.every(packet => packet.protocol === 'UDP fragment'));
      assert.equal(decoded.reduce((total, packet) => total + parseInt(packet.summary, 10), 0), length);
    }
    const payload = lan.sendUdp({ address: '255.255.255.255', port: 58881, data: new Uint8Array(200) });
    const decoded = decodePacket({ payload });
    assert.equal(decoded.protocol, 'UDP');
    assert.equal(decoded.summary, '200 B');
    assert.equal(decoded.source, '192.168.0.200:58881');
  } finally { lan.close(); }
});

test('non-initial IPv4 TCP fragments are not decoded as TCP headers', () => {
  const lan = createLanService({ dhcp: false });
  try {
    const frames = lan.sendUdp({ address: '255.255.255.255', port: 53, data: new Uint8Array(2000).fill(0xff) });
    const frame = frames[1].slice();
    frame[23] = 6;
    const decoded = decodePacket({ payload: frame });
    assert.equal(decoded.protocol, 'TCP fragment');
    assert.equal(decoded.source, '10.0.0.1');
    assert.equal(decoded.destination, '255.255.255.255');
    assert.equal(decoded.summary, '528 B · Offset 1480 · MF=0');
  } finally { lan.close(); }
});
