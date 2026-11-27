// Deliberately constructs metadata from fixed header fields only.
// Never pass raw frame bytes or protocol application decoders into the log.
const u16 = (b, p) => (b[p] << 8) | b[p + 1];
const u32 = (b, p) => (b[p] * 0x1000000 + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]) >>> 0;
const addr = (b, p) => Array.from(b.subarray(p, p + 4)).join('.');
const mac = (b, p) => Array.from(b.subarray(p, p + 6), x => x.toString(16).padStart(2, '0')).join(':');
const hex = n => '0x' + n.toString(16);
export function wifiMetadata(event, b) {
  const record = { type: 'wifi-log', metadataOnly: true, instanceId: event.instanceId,
    direction: event.direction, timestamp: event.timestamp, length: event.length,
    dropped: event.dropped, bssid: event.bssid };
  let source = '', destination = '', protocol = 'Ethernet', summary = '', fields = [];
  if (b.length >= 14) {
    source = mac(b, 6); destination = mac(b, 0);
    const type = u16(b, 12);
    fields.push('Ethernet ' + source + ' → ' + destination, 'EtherType ' + hex(type));
    if (type === 0x0800 && b.length >= 34 && b[14] >> 4 === 4) {
      source = addr(b, 26); destination = addr(b, 30);
      const ihl = (b[14] & 15) * 4, total = u16(b, 16), flags = u16(b, 20),
        offset = (flags & 0x1fff) * 8, more = Boolean(flags & 0x2000), start = 14 + ihl,
        end = Math.min(b.length, 14 + total), transport = b[23];
      protocol = ({ 6: 'TCP', 17: 'UDP', 1: 'ICMP' })[transport] || 'IPv4/' + transport;
      if (offset || more) protocol += ' fragment';
      summary = 'ID=' + u16(b, 18) + ' Offset=' + offset + ' MF=' + Number(more) +
        ' IP payload=' + Math.max(0, total - ihl) + ' B';
      fields.push('IPv4 ' + source + ' → ' + destination, 'IHL=' + ihl + ' Total=' + total +
        ' TTL=' + b[22] + ' DSCP/ECN=' + b[15] + ' DF=' + Number(Boolean(flags & 0x4000)) +
        ' Protocol=' + transport + ' Header checksum=' + hex(u16(b, 24)), summary);
      if (ihl >= 20 && !offset && start <= end) {
        if (transport === 17 && start + 8 <= end) {
          source += ':' + u16(b, start); destination += ':' + u16(b, start + 2);
          fields.push('UDP length=' + u16(b, start + 4) + ' checksum=' + hex(u16(b, start + 6)));
          summary += ' UDP length=' + u16(b, start + 4);
        } else if (transport === 6 && start + 20 <= end) {
          source += ':' + u16(b, start); destination += ':' + u16(b, start + 2);
          fields.push('TCP seq=' + u32(b, start + 4) + ' ack=' + u32(b, start + 8) +
            ' header=' + ((b[start + 12] >> 4) * 4) + ' flags=' + hex(b[start + 13]) +
            ' window=' + u16(b, start + 14) + ' checksum=' + hex(u16(b, start + 16)));
        } else if (transport === 1 && start + 4 <= end) {
          fields.push('ICMP type=' + b[start] + ' code=' + b[start + 1] + ' checksum=' + hex(u16(b, start + 2)));
        }
      }
    } else if (type === 0x0806 && b.length >= 42 && b[18] === 6 && b[19] === 4) {
      protocol = 'ARP'; source = addr(b, 28); destination = addr(b, 38);
      summary = 'operation=' + u16(b, 20);
      fields.push(summary, 'sender MAC=' + mac(b, 22), 'target MAC=' + mac(b, 32));
    }
  }
  fields.push('Ethernet length=' + event.length, 'BSSID=' + (event.bssid || []).map(x => x.toString(16).padStart(2, '0')).join(':'),
    'Dropped log records=' + (event.dropped || 0));
  record.decoded = { source, destination, protocol, summary, detail: fields.join('\n') };
  return record;
}
const stages = {
  1: 'RX_ENQUEUED', 2: 'RX_QUEUE_FULL', 3: 'RX_WAIT_RING', 4: 'RX_DEQUEUED',
  5: 'RX_BSSID_MISMATCH', 6: 'RX_BACKEND_DISABLED', 7: 'NETWORK_BACKEND',
  10: 'AP_LENGTH_REJECT', 11: 'AP_DEST_MAC_REJECT', 12: 'AP_SOURCE_MAC_REJECT', 13: 'AP_FRAMED',
  20: 'RX_BAD_LENGTH', 21: 'RX_BAD_CHANNEL', 23: 'RX_START', 24: 'RX_FILTER_REJECT',
  25: 'RX_COMPLETE', 26: 'RX_BUFFER_FULL', 27: 'RX_DUPLICATE'
};
const reasons = ['unknown', 'destination MAC', 'WEP disabled', 'beacon filter', 'management filter',
  'PS-poll BSSID filter', 'control subtype', 'FromDS/ToDS filter', 'data BSSID filter', 'retry filter',
  'data subtype 1 ACK filter', 'data subtype 1 filter', 'data subtype 2 filter', 'data subtype 3 filter',
  'data subtype 5 MP filter', 'data subtype 5 filter', 'data subtype 6 filter', 'data subtype 7 filter', 'unsupported data subtype'];
export function wifiDiagnostic(words) {
  const [low, high, instanceId, stage, length, a, b, c, d, dropped] = words;
  const protocol = stages[stage] || 'WIFI_DIAGNOSTIC';
  let summary;
  if (stage >= 1 && stage <= 6) summary = 'IP ID=' + (a === 0xffffffff ? '—' : a) +
    ' Offset=' + ((b & 0x1fff) * 8) + ' MF=' + Number(Boolean(b & 0x2000)) + ' queue=' + c + ' protocol=' + d;
  else if (stage === 7) summary = 'enabled=' + a;
  else if (stage === 13) summary = '802.11 sequence=' + hex(a) + ' frame length=' + b + ' channel=' + c + ' AP slot=' + d;
  else if (stage === 20) summary = 'header length=' + a + ' actual=' + b;
  else if (stage === 21) summary = 'channel=' + a + ' expected=' + b + ' sequence=' + hex(c);
  else if (stage === 23) summary = 'sequence=' + hex(a) + ' frame control=' + hex(b) + ' rate=' + c + ' write cursor=' + hex(d);
  else if (stage === 24) summary = 'sequence=' + hex(a) + ' frame control=' + hex(b) + ' reason=' + (reasons[c] || c) + ' filter=' + hex(d);
  else if (stage === 25) summary = 'sequence=' + hex(a) + ' frame control=' + hex(b) + ' RX flags=' + hex(c) + ' write cursor=' + hex(d);
  else if (stage === 26) summary = 'sequence=' + hex(a) + ' read=' + hex(b) + ' write=' + hex(c) + ' RXTX=' + hex(d);
  else if (stage === 27) summary = 'sequence=' + hex(a) + ' frame control=' + hex(b);
  else summary = 'length=' + length;
  return { type: 'wifi-log', metadataOnly: true, diagnostic: true, instanceId, direction: 'RX',
    timestamp: high + ':' + low, length, dropped,
    decoded: { source: 'NET', destination: '#' + instanceId, protocol, summary,
      detail: protocol + '\n' + summary + '\nLength=' + length + '\nDropped diagnostic records=' + dropped } };
}
