// Log-oriented port of Ctable_jp.lua. Disabled Lua mutations intentionally remain
// disabled; this version records the same active random, battle, and C-table hooks.

const CPU = "arm9";
const CTABLE_SEED = 0x02385f0c;
const LCG_MULTIPLIER = 0x5d588b656c078965n;
const LCG_INCREMENT = 0x269ec3n;
const LCG_INVERSE_MULTIPLIER = 0xdedcedae9638806dn;
const LCG_MASK = (1n << 64n) - 1n;
const MAX_INITIAL_SEED = (1n << 48n) - 1n;
const MAX_RECOVER_POSITION = 3000;
const reg = (name) => memory.reg(name, CPU);
let counter = 0;
let lastSeed = null;

function swap32(value) {
  const n = Number(value) >>> 0;
  return (((n & 0xff) << 24) | ((n & 0xff00) << 8) | ((n >>> 8) & 0xff00) | ((n >>> 24) & 0xff)) >>> 0;
}

async function native32(address) {
  return swap32(await memory.read32(address, CPU));
}

async function currentSeed64() {
  const low = BigInt(await native32(CTABLE_SEED));
  const high = BigInt(await native32(CTABLE_SEED + 4));
  return (high << 32n) | low;
}

function nextSeed(seed) {
  return (seed * LCG_MULTIPLIER + LCG_INCREMENT) & LCG_MASK;
}

function previousSeed(seed) {
  return ((seed - LCG_INCREMENT) * LCG_INVERSE_MULTIPLIER) & LCG_MASK;
}

function recoverInitialSeed(currentSeed) {
  const candidates = [];
  let seed = currentSeed;

  for (let position = 0; position <= MAX_RECOVER_POSITION; position++) {
    if (seed <= MAX_INITIAL_SEED) candidates.push({ initialSeed: seed, position });
    seed = previousSeed(seed);
  }

  return candidates;
}

async function syncCounterFromSeed() {
  const seed = await currentSeed64();

  if (lastSeed !== null && seed === nextSeed(lastSeed)) {
    lastSeed = seed;
    return true;
  }

  lastSeed = null;
  const candidates = recoverInitialSeed(seed);
  if (candidates.length !== 1) {
    print(`C-table counter sync failed: ${candidates.length} initial-seed candidates`);
    return false;
  }

  const candidate = candidates[0];
  counter = candidate.position;
  lastSeed = seed;
  print(`C-table counter resynced: #${counter} initial=0x${candidate.initialSeed.toString(16).padStart(12, "0")}`);
  return true;
}

async function consumeRandomPosition() {
  if (!await syncCounterFromSeed()) return "?";
  counter++;
  return counter;
}

async function trace(callback) {
  // The main breakpoint coordinator resumes only after every callback for this event settles.
  await callback();
}

async function exec(address, callback) {
  return memory.registerexec(address, () => trace(callback), { cpu: CPU });
}

await exec(0x02075488, async () => {
  const r0 = await reg("r0");
  const lr = await reg("r14");
  if (r0 === CTABLE_SEED && lr !== 0x02075628) {
    const position = await consumeRandomPosition();
    print(`c rand: lr 0x${lr.toString(16).padStart(8, "0")} max 0x${(await reg("r1")).toString(16).padStart(8, "0")} #${position}`);
  } else if (r0 !== CTABLE_SEED) {
    print("c rand: non-C-table path");
  }
});

await exec(0x02075514, async () => {
  if (await reg("r0") === CTABLE_SEED) {
    const position = await consumeRandomPosition();
    print(`float: lr 0x${(await reg("r14")).toString(16).padStart(8, "0")} r1 0x${(await reg("r1")).toString(16).padStart(8, "0")} r2 0x${(await reg("r2")).toString(16).padStart(8, "0")} #${position}`);
  }
});

await exec(0x020754d8, async () => {
  const lr = await reg("r14");
  if (lr !== 0x02075534 && lr !== 0x020754b0) {
    const position = await consumeRandomPosition();
    print(`getFloatRand: lr 0x${lr.toString(16).padStart(8, "0")} #${position}`);
  }
});

await exec(0x02075604, async () => {
  const position = await consumeRandomPosition();
  print(`randIntRange: lr 0x${(await reg("r14")).toString(16).padStart(8, "0")} r1 ${await reg("r1")} r2 ${await reg("r2")} #${position}`);
});
await exec(0x02075560, async () => {
  const position = await consumeRandomPosition();
  print(`getFloatRandWithPower: lr 0x${(await reg("r14")).toString(16).padStart(8, "0")} r1 ${await reg("r1")} r2 ${await reg("r2")} r3 ${await reg("r3")} #${position}`);
});
await exec(0x0207544c, async () => {
  const lr = await reg("r14");
  if (lr !== 0x020754f0) {
    const position = await consumeRandomPosition();
    print(`UpdateLGC: lr 0x${lr.toString(16).padStart(8, "0")} #${position}`);
  }
});

for (const [address, label] of [[0x021ebd9c, "start FUN_021ebd9c_ct"], [0x0215f950, "end FUN_021ebd9c_ct"], [0x021594bc, "start FUN_021594bc"], [0x0215f980, "end FUN_021594bc"], [0x02158dfc, "start FUN_02158dfc"], [0x0215f924, "end FUN_02158dfc"]]) {
  await exec(address, async () => print(`-------- ${label} --------`));
}

await exec(0x0208af54, async () => printhex("ULGC r3", await reg("r3")));
await exec(0x0208af40, async () => printhex("ULGC r2", await reg("r2")));
await exec(0x021e88f0, async () => printhex("dmTyD", await reg("r0")));
await exec(0x021e8680, async () => printhex("dmTyD", await reg("r0")));
await exec(0x0208aca8, async () => { printhex("action r0", await reg("r0")); printhex("action r5", await reg("r5")); });
await exec(0x0207564c, async () => { print("ATK", await reg("r0")); print("DEF", await reg("r1")); });
await exec(0x0208ac90, async () => { printhex("actions", ((await reg("r7")) + 0x18) >>> 0); printhex("actions ptr", ((await reg("r0")) + 0x148) >>> 0); });
await exec(0x021588f8, async () => printhex("mitore", await reg("r9")));
await exec(0x02158258, async () => printhex("kannsuu / kaihi r0", await reg("r0")));
await exec(0x021daeec, async () => printhex("FUN_021dae1c_jmp", await reg("r5")));
await exec(0x021587bc, async () => print("mikawasi", await reg("r0")));
await exec(0x02158700, async () => printhex("shield(float)", await reg("r4")));
await exec(0x02158590, async () => print(`kaisin: 10000/${await reg("r0")}`));
await exec(0x0208acf0, async () => print(`isCanActionTaken: ${(await reg("r0")) === 0 ? "changed" : "not changed"}`));
await exec(0x0208af7c, async () => print(`ULCG1 isCanActionTaken: ${(await reg("r0")) === 0 ? "changed" : "not changed"}`));
await exec(0x0208afa4, async () => print(`ULCG2 isCanActionTaken: ${(await reg("r0")) === 0 ? "changed" : "not changed"}`));
await exec(0x021f6fb8, async () => printhex("isCanActionTaken_jmp", await reg("r7")));
await exec(0x021e81a0, async () => print(`0damage: ${await reg("r0")}`));
await exec(0x021e3a18, async () => print(`doku 021e3a18: 100/${await reg("r1")}`));
await exec(0x02158ad0, async () => print(`doku 02158ad0: 100/${await reg("r0")}`));
await exec(0x021e3594, async () => { const r1 = await reg("r1"); if (r1 !== 0xffffffff) printhex("heartbreak", r1); });
await exec(0x021ecf78, async () => print(`ProcessingDefense1: ${await reg("r0")}`));

printhex("seed1 native", await native32(CTABLE_SEED));
printhex("seed2 native", await native32(CTABLE_SEED + 4));
const startupCandidates = recoverInitialSeed(await currentSeed64());
print(`initial seed: ${startupCandidates.length === 1 ? `0x${startupCandidates[0].initialSeed.toString(16).padStart(12, "0")}` : `unresolved (${startupCandidates.length} candidates)`}`);
print("Ctable trace hooks registered");
