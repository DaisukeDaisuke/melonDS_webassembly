import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLanService } from '../lan-services.js';
import { wifiMetadata, wifiDiagnostic, exportWifiMetadataCsv } from '../wifi-metadata.js';
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

test('CSV exports only newest 10000 matching records, not visible 100 rows', () => {
  const records = Array.from({ length: 20020 }, (_, i) => ({
    type: 'wifi-log', instanceId: i % 2, metadataOnly: true,
    timestamp: 'row-' + i, direction: 'RX', length: 1,
    decoded: { protocol: 'RX_COMPLETE', summary: 'summary', detail: 'detail' }
  }));
  const csv = exportWifiMetadataCsv(records, { instanceId: 0, metadataOnly: true });
  assert.equal(csv.count, 10000);
  assert.ok(csv.text.startsWith('\ufefftimestamp,instance_id,'));
  assert.equal(csv.text.split('\r\n').length, 10002);
  assert.match(csv.text, /\r\nrow-20,0,/);
  assert.match(csv.text, /\r\nrow-20018,0,/);
  assert.doesNotMatch(csv.text, /\r\nrow-18,0,|\r\nrow-21,1,/);
  const all = exportWifiMetadataCsv(records, { all: true, metadataOnly: true });
  assert.equal(all.count, 10000);
  assert.match(all.text, /\r\nrow-10020,0,/);
  assert.match(all.text, /\r\nrow-20019,1,/);
});
test('CSV quotes detail and omits raw and application-decoded content', () => {
  const diagnostic = wifiDiagnostic([100, 1, 2, 25, 72, 16, 0x208, 0x8018, 128, 0]);
  diagnostic.decoded.detail = 'line 1, "quoted"\nline 2';
  const frame = new Uint8Array(60);
  frame.fill(0xab, 14);
  frame[12] = 0x88; frame[13] = 0xb5;
  const records = [
    diagnostic,
    { type: 'wifi-log', instanceId: 2, direction: 'TX', timestamp: 'raw', length: 60,
      payload: Array.from(frame), decoded: { detail: 'PRIVATE_BODY' } },
    { type: 'wifi-log', instanceId: 2, logical: true, timestamp: 'logical', direction: 'RX',
      decoded: { detail: 'PRIVATE_BODY', summary: 'PRIVATE_BODY' } }
  ];
  const csv = exportWifiMetadataCsv(records, { instanceId: 2 });
  assert.equal(csv.count, 3);
  assert.match(csv.text, /"line 1, ""quoted""\nline 2"/);
  assert.match(csv.text, /EtherType 0x88b5/);
  assert.doesNotMatch(csv.text, /PRIVATE_BODY|ab:ab|payload_hex/);
  assert.equal(exportWifiMetadataCsv(records, { instanceId: 2, metadataOnly: true }).count, 1);
  assert.equal(exportWifiMetadataCsv(records, { instanceId: 3 }).count, 0);
});
