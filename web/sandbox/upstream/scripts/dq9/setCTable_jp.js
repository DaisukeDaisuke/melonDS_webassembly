// Port of setCTable_jp.lua.
// The API uses a Big Endian byte-view, so native32() preserves the Lua/DS word value.

const CPU = "arm9";
const CTABLE_SEED = 0x02385f0c;

function swap32(value) {
  const n = Number(value) >>> 0;
  return (((n & 0xff) << 24) | ((n & 0xff00) << 8) | ((n >>> 8) & 0xff00) | ((n >>> 24) & 0xff)) >>> 0;
}

async function writeNative32(address, value) {
  return memory.write32(address, swap32(value), CPU);
}

await writeNative32(CTABLE_SEED, 0x02751013);
await writeNative32(CTABLE_SEED + 4, 0);
printhex("C table seed", 0x02751013);
print("C table high word: 0x00000000");
