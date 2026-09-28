const u16 = (b, p) => ((b[p] << 8) | b[p + 1]) >>> 0;
const u32 = (b, p) => ((b[p] * 0x1000000) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]) >>> 0;
const hex = b => Array.from(b, n => n.toString(16).padStart(2, '0')).join(' ');
const ip = b => Array.from(b).join('.');
const mac = b => Array.from(b, n => n.toString(16).padStart(2, '0')).join(':');
const text = b => new TextDecoder().decode(b);
function dnsName(b, start) {
  const names = []; let p = start, end = start, jumped = false;
  const seen = new Set();
  while (p < b.length && names.length < 128 && !seen.has(p)) {
    seen.add(p); const n = b[p++];
    if (!n) { if (!jumped) end = p; break; }
    if ((n & 0xc0) === 0xc0) { if (p >= b.length) break; const target = ((n & 63) << 8) | b[p++]; if (!jumped) end = p; jumped = true; p = target; continue; }
    if (n > 63 || p + n > b.length) break;
    names.push(text(b.subarray(p, p + n))); p += n; if (!jumped) end = p;
  }
  return { name: names.join('.'), end };
}
export function decodePacket(packet) {
  if (packet.decoded) return packet.decoded;
  const b = Uint8Array.from(packet.payload || []);
  const out = { source: '', destination: '', protocol: packet.packetType || 'Ethernet', summary: '', detail: '' };
  const details = [];
  if (b.length < 14) return { ...out, summary: `${b.length} bytes`, detail: hex(b) };
  out.source = mac(b.subarray(6, 12)); out.destination = mac(b.subarray(0, 6));
  const type = u16(b, 12); details.push(`Ethernet ${out.source} → ${out.destination}`);
  if (type === 0x0806 && b.length >= 42) {
    out.protocol = 'ARP'; out.source = ip(b.subarray(28, 32)); out.destination = ip(b.subarray(38, 42));
    out.summary = u16(b, 20) === 1 ? `Who has ${out.destination}?` : `${out.source} is ${mac(b.subarray(22, 28))}`;
    details.push(out.summary);
  } else if (type === 0x0800 && b.length >= 34 && b[14] >> 4 === 4) {
    const ihl = (b[14] & 15) * 4, end = Math.min(b.length, 14 + u16(b, 16)), p = 14 + ihl;
    out.source = ip(b.subarray(26, 30)); out.destination = ip(b.subarray(30, 34));
    details.push(`IPv4 ${out.source} → ${out.destination} · TTL ${b[22]} · ID ${u16(b, 18)}`);
    if (ihl < 20 || p > end) return { ...out, protocol: 'IPv4', summary: 'Truncated IPv4 header', detail: details.join('\n') };
    if (b[23] === 6 && p + 20 <= end) {
      const sp = u16(b, p), dp = u16(b, p + 2), size = (b[p + 12] >> 4) * 4;
      out.source += `:${sp}`; out.destination += `:${dp}`; out.protocol = 'TCP';
      const flags = [[1, 'FIN'], [2, 'SYN'], [4, 'RST'], [8, 'PSH'], [16, 'ACK'], [32, 'URG'], [64, 'ECE'], [128, 'CWR']].filter(([mask]) => b[p + 13] & mask).map(([, name]) => name).join(' ');
      const payload = size >= 20 && p + size <= end ? b.subarray(p + size, end) : new Uint8Array();
      out.summary = `${flags} · Seq ${u32(b, p + 4)} Ack ${u32(b, p + 8)} · ${payload.length} B`;
      details.push(`TCP ${out.source} → ${out.destination}`, `Flags ${flags} · Window ${u16(b, p + 14)}`, `Sequence ${u32(b, p + 4)} · Acknowledgement ${u32(b, p + 8)}`);
      if (payload.length >= 5 && [20, 21, 22, 23].includes(payload[0]) && payload[1] === 3) {
        out.protocol = payload[2] === 0 ? 'SSLv3' : 'TLS';
        const recordName = { 20: 'ChangeCipherSpec', 21: 'Alert', 22: 'Handshake', 23: 'ApplicationData' }[payload[0]];
        out.summary += ` · ${recordName} ${u16(payload, 3)} B`;
        details.push(`${out.protocol} ${recordName} · record bytes ${u16(payload, 3)}`);
        if (payload[0] === 22 && payload.length >= 9) details.push(`Handshake ${({ 1: 'ClientHello', 2: 'ServerHello', 11: 'Certificate', 14: 'ServerHelloDone', 16: 'ClientKeyExchange', 20: 'Finished' })[payload[5]] || payload[5]}`);
        if (payload[0] === 21 && payload.length >= 7) details.push(`Alert level ${payload[5]} · description ${payload[6]}`);
      } else if (payload.length && /^(?:GET|POST|HEAD|PUT|DELETE|OPTIONS|HTTP\/)/.test(text(payload.subarray(0, 12)))) {
        out.protocol = 'HTTP'; out.summary = text(payload).split('\r\n')[0]; details.push(text(payload.subarray(0, 16384)));
      }
      if (payload.length && out.protocol !== 'HTTP') details.push(`Payload\n${hex(payload.subarray(0, 512))}${payload.length > 512 ? '\n…' : ''}`);
    } else if (b[23] === 17 && p + 8 <= end) {
      const sp = u16(b, p), dp = u16(b, p + 2), payload = b.subarray(p + 8, end);
      out.protocol = 'UDP'; out.source += `:${sp}`; out.destination += `:${dp}`;
      out.summary = `${payload.length} B`;
      if ((sp === 53 || dp === 53) && payload.length >= 12) {
        out.protocol = 'DNS'; const q = dnsName(payload, 12), response = !!(payload[2] & 0x80);
        out.summary = `${response ? 'Response' : 'Query'} ${q.name} · ${({ 1: 'A', 28: 'AAAA', 5: 'CNAME' })[u16(payload, q.end)] || u16(payload, q.end)}`;
        details.push(`DNS ID ${u16(payload, 0)} · RCODE ${payload[3] & 15} · Answers ${u16(payload, 6)}`);
      } else if ([67, 68].includes(sp) && [67, 68].includes(dp)) {
        out.protocol = 'DHCP'; out.summary = `${payload[0] === 1 ? 'Client request' : 'Server reply'} · ${ip(payload.subarray(16, 20))}`;
      }
      details.push(out.summary);
    } else { out.protocol = b[23] === 1 ? 'ICMP' : `IPv4/${b[23]}`; out.summary = `${end - p} B`; }
  } else out.summary = `EtherType 0x${type.toString(16)} · ${b.length} B`;
  out.detail = details.join('\n'); return out;
}
