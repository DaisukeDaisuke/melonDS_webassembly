import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLanService } from '../lan-services.js';
import { wifiMetadata, wifiDiagnostic } from '../wifi-metadata.js';
test('metadata mode records fragment headers and never payload', () => {
  const lan = createLanService({ address: '192.168.0.200', dhcp: false });
  try {
    const data = new Uint8Array(1488).fill(0xab);
    const frames = lan.sendUdp({ address: '255.255.255.255', port: 58881, data });
    const decoded = frames.map(frame => wifiMetadata({ instanceId: 0, direction: 'RX', length: frame.length }, frame));
    assert.equal(decoded[0].decoded.source, '192.168.0.200:58881');
    assert.equal(decoded[1].decoded.source, '192.168.0.200');
    assert.match(decoded[1].decoded.summary, /Offset=1480 MF=0 IP payload=16 B/);
    for (const record of decoded) {
      assert.equal(record.metadataOnly, true);
      assert.equal('payload' in record, false);
      assert.doesNotMatch(JSON.stringify(record), /ab ab|171,171/);
    }
  } finally { lan.close(); }
});
test('native RX completion and failure are distinct metadata-only events', () => {
  const completed = wifiDiagnostic([100, 1, 2, 25, 72, 16, 0x208, 0x8018, 128, 0]);
  const rejected = wifiDiagnostic([101, 1, 2, 24, 72, 16, 0x208, 8, 0, 0]);
  assert.equal(completed.decoded.protocol, 'RX_COMPLETE');
  assert.equal(rejected.decoded.protocol, 'RX_FILTER_REJECT');
  assert.match(rejected.decoded.summary, /data BSSID filter/);
  assert.equal('payload' in completed, false);
  assert.equal('payload' in rejected, false);
});
