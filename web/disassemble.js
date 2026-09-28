// Complete ARM/Thumb decoding is performed by the vendored DeSmuME tables.
// Combine Thumb BL/BLX pairs so the visual debugger presents one call row.
export function decodeInstructions(bytes, address, count, thumb, decodeOpcode) {
  if (typeof decodeOpcode !== 'function') throw Error('Native DeSmuME disassembler is not connected');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lines = [];
  for (let offset = 0; lines.length < count && offset + (thumb ? 2 : 4) <= bytes.length;) {
    const at = (address + offset) >>> 0;
    let width = thumb ? 2 : 4;
    let opcode = thumb ? view.getUint16(offset, true) : view.getUint32(offset, true);
    let text;
    if (thumb && (opcode & 0xf800) === 0xf000 && offset + 4 <= bytes.length) {
      const low = view.getUint16(offset + 2, true), kind = low & 0xf800;
      if (kind === 0xf800 || kind === 0xe800) {
        let high = opcode & 0x7ff; if (high & 0x400) high -= 0x800;
        const destination = (at + 4 + high * 4096 + (low & 0x7ff) * 2) >>> 0;
        text = `${kind === 0xe800 ? 'BLX' : 'BL'} ${((kind === 0xe800 ? destination & ~3 : destination) >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
        width = 4; opcode = view.getUint32(offset, true);
      }
    }
    text ??= decodeOpcode(at, opcode, thumb);
    lines.push({ address: at, width, opcode: '0x' + (opcode >>> 0).toString(16).padStart(width * 2, '0'), text });
    offset += width;
  }
  return lines;
}
