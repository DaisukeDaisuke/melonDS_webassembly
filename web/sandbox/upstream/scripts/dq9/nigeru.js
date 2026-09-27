// Port of nigeru.lua: force the second PRNG path to return a non-zero value.

const CPU = "arm9";
const reg = (name) => memory.reg(name, CPU);

async function trace(callback) {
  try {
    await callback();
  } finally {
    // Script breakpoints stop emulation before this callback. Continue the trace automatically.
    await mcp.call("resume");
  }
}

await memory.registerexec(0x021611e0, () => trace(async () => {
  const r0 = await reg("r0");
  if (r0 === 0) {
    printhex("2nd PRNG called; forcing r0", 1);
    await memory.regw("r0", 1, CPU);
  }
}), { cpu: CPU });

await memory.registerexec(0x0209d1c0, () => trace(async () => {
  printhex("nigeru r1", await reg("r1"));
  printhex("nigeru r3", await reg("r3"));
}), { cpu: CPU });

print("nigeru hooks registered");
