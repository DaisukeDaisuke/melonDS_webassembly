const hex = (value, digits = 8) => `0x${(value >>> 0).toString(16).padStart(digits, '0')}`;
function arm(opcode, address) {
  const cond = ['EQ', 'NE', 'CS', 'CC', 'MI', 'PL', 'VS', 'VC', 'HI', 'LS', 'GE', 'LT', 'GT', 'LE', '', ''][opcode >>> 28];
  if ((opcode & 0x0ffffff0) === 0x012fff10) return `BX${cond} r${opcode & 15}`;
  if ((opcode & 0x0ffffff0) === 0x012fff30) return `BLX${cond} r${opcode & 15}`;
  if ((opcode & 0xfe000000) >>> 0 === 0xfa000000) {
    const offset = (opcode << 8 >> 6) + ((opcode >>> 23) & 2);
    return `BLX ${hex(address + 8 + offset)}`;
  }
  if ((opcode & 0x0e000000) === 0x0a000000) {
    const offset = (opcode << 8 >> 6);
    return `${opcode & 0x01000000 ? 'BL' : 'B'}${cond} ${hex(address + 8 + offset)}`;
  }
  if ((opcode & 0x0f000000) === 0x0f000000) return `SWI${cond} ${hex(opcode & 0xffffff, 6)}`;
  if ((opcode & 0x0c000000) === 0x04000000) {
    const load = !!(opcode & (1 << 20)), byte = !!(opcode & (1 << 22));
    const offset = opcode & 0xfff;
    const amount = offset ? `, #${opcode & (1 << 23) ? '' : '-'}${offset}` : '';
    return `${load ? 'LDR' : 'STR'}${byte ? 'B' : ''}${cond} r${(opcode >>> 12) & 15}, [r${(opcode >>> 16) & 15}${amount}]`;
  }
  if ((opcode & 0x0c000000) === 0 && !(opcode & 0x02000000)) {
    const op = (opcode >>> 21) & 15, names = ['AND', 'EOR', 'SUB', 'RSB', 'ADD', 'ADC', 'SBC', 'RSC', 'TST', 'TEQ', 'CMP', 'CMN', 'ORR', 'MOV', 'BIC', 'MVN'];
    const operand = `r${opcode & 15}`;
    if ([8, 9, 10, 11].includes(op)) return `${names[op]}${cond} r${(opcode >>> 16) & 15}, ${operand}`;
    if (op === 13 || op === 15) return `${names[op]}${cond} r${(opcode >>> 12) & 15}, ${operand}`;
    return `${names[op]}${cond} r${(opcode >>> 12) & 15}, r${(opcode >>> 16) & 15}, ${operand}`;
  }
  return `.word ${hex(opcode)}`;
}
function thumb(opcode, address, following) {
  if ((opcode & 0xf800) === 0xf000 && (following & 0xf800) === 0xf800) {
    const offset = (opcode << 21 >> 9) + ((following & 0x7ff) << 1);
    return { text: `BL ${hex(address + 4 + offset)}`, width: 4 };
  }
  if ((opcode & 0xff87) === 0x4780) return { text: `BLX r${(opcode >>> 3) & 15}`, width: 2 };
  if ((opcode & 0xff87) === 0x4700) return { text: `BX r${(opcode >>> 3) & 15}`, width: 2 };
  if ((opcode & 0xf800) === 0xe000) return { text: `B ${hex(address + 4 + (opcode << 21 >> 20))}`, width: 2 };
  if ((opcode & 0xf000) === 0xd000 && (opcode & 0x0f00) !== 0x0f00) {
    const cond = ['EQ', 'NE', 'CS', 'CC', 'MI', 'PL', 'VS', 'VC', 'HI', 'LS', 'GE', 'LT', 'GT', 'LE'][opcode >>> 8 & 15];
    return { text: `B${cond} ${hex(address + 4 + ((opcode & 255) << 24 >> 23))}`, width: 2 };
  }
  if ((opcode & 0xff00) === 0xdf00) return { text: `SWI ${hex(opcode & 255, 2)}`, width: 2 };
  if ((opcode & 0xf800) === 0x4800) return { text: `LDR r${(opcode >>> 8) & 7}, [pc, #${(opcode & 255) * 4}]`, width: 2 };
  if ((opcode & 0xe000) === 0x2000) {
    const operations = ['MOV', 'CMP', 'ADD', 'SUB'];
    return { text: `${operations[(opcode >>> 11) & 3]} r${(opcode >>> 8) & 7}, #${opcode & 255}`, width: 2 };
  }
  return { text: `.hword ${hex(opcode, 4)}`, width: 2 };
}
export function decodeInstructions(bytes, address, count, thumbMode = false) {
  const instructions = [];
  for (let position = 0; position + (thumbMode ? 2 : 4) <= bytes.length && instructions.length < count;) {
    const at = (address + position) >>> 0;
    const raw = bytes[position] | bytes[position + 1] << 8;
    if (thumbMode) {
      const following = position + 4 <= bytes.length ? bytes[position + 2] | bytes[position + 3] << 8 : 0;
      const { text, width } = thumb(raw, at, following);
      instructions.push({ address: at, opcode: hex(width === 4 ? raw | following << 16 : raw, width * 2), width, text });
      position += width;
    } else {
      const opcode = (raw | bytes[position + 2] << 16 | bytes[position + 3] << 24) >>> 0;
      instructions.push({ address: at, opcode: hex(opcode), width: 4, text: arm(opcode, at) });
      position += 4;
    }
  }
  return instructions;
}
