#include "Args.h"
#include "NDS.h"
#include "NDSCart.h"
#include "LocalMP.h"
#include <array>
#include <cstring>
#include <memory>
#include <vector>
#include <emscripten/emscripten.h>

namespace {
struct Instance {
    int id;
    std::unique_ptr<melonDS::NDS> nds;
    std::vector<melonDS::u8> save;
    bool paused = true;
};
std::array<std::unique_ptr<Instance>, 16> instances;
melonDS::LocalMP localMP;
Instance* get(int id) { return id >= 0 && id < 16 ? instances[id].get() : nullptr; }
}

// This frontend uses a single serialized Wasm worker. Every exported call
// completes the native operation before returning to its RPC caller.
extern "C" {
EMSCRIPTEN_KEEPALIVE int web_create(int id) {
    if (id < 0 || id >= 16 || instances[id]) return -1;
    auto instance = std::make_unique<Instance>();
    instance->id = id;
    melonDS::NDSArgs args;
    args.JIT = std::nullopt;
    instance->nds = std::make_unique<melonDS::NDS>(std::move(args), instance.get());
    instances[id] = std::move(instance);
    return id;
}
EMSCRIPTEN_KEEPALIVE int web_destroy(int id) {
    auto* inst = get(id);
    if (!inst) return -1;
    inst->nds->Stop();
    instances[id].reset();
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_load_rom(int id, const melonDS::u8* data, int length) {
    auto* inst = get(id);
    if (!inst || !data || length < 0x200 || length > 128 * 1024 * 1024) return -1;
    auto cart = melonDS::NDSCart::ParseROM(data, length, inst);
    if (!cart) return -2;
    inst->nds->Stop();
    inst->nds->SetNDSCart(std::move(cart));
    inst->nds->Reset();
    inst->nds->SetupDirectBoot("web.nds");
    inst->nds->Start();
    inst->paused = false;
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_reset(int id) {
    auto* inst = get(id); if (!inst) return -1;
    const bool paused = inst->paused;
    inst->nds->Stop(); inst->nds->Reset();
    if (inst->nds->CartInserted()) inst->nds->SetupDirectBoot("web.nds");
    inst->nds->Start(); inst->paused = paused;
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_pause(int id) { auto* inst = get(id); if (!inst) return -1; inst->paused = true; return 0; }
EMSCRIPTEN_KEEPALIVE int web_resume(int id) { auto* inst = get(id); if (!inst) return -1; inst->paused = false; return 0; }
EMSCRIPTEN_KEEPALIVE int web_frame(int id) {
    auto* inst = get(id); if (!inst || !inst->nds->IsRunning()) return -1;
    if (!inst->paused) inst->nds->RunFrame();
    return static_cast<int>(inst->nds->NumFrames);
}
EMSCRIPTEN_KEEPALIVE int web_register(int id, int cpu, int reg) {
    auto* inst = get(id); if (!inst || (cpu != 7 && cpu != 9) || reg < 0 || reg > 16) return 0;
    auto* arm = cpu == 9 ? static_cast<melonDS::ARM*>(inst->nds->ARM9) : inst->nds->ARM7;
    return reg == 16 ? arm->CPSR : arm->R[reg];
}
EMSCRIPTEN_KEEPALIVE int web_set_register(int id, int cpu, int reg, unsigned value) {
    auto* inst = get(id); if (!inst || (cpu != 7 && cpu != 9) || reg < 0 || reg > 16 || !inst->paused) return -1;
    auto* arm = cpu == 9 ? static_cast<melonDS::ARM*>(inst->nds->ARM9) : inst->nds->ARM7;
    if (reg == 16) arm->CPSR = value;
    else arm->R[reg] = value;
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_read_memory(int id, int cpu, unsigned address, melonDS::u8* out, int length) {
    auto* inst = get(id); if (!inst || !out || (cpu != 7 && cpu != 9) || length < 0 || length > 4096) return -1;
    for (int n = 0; n < length; n++) out[n] = cpu == 9 ? inst->nds->ARM9Read8(address + n) : inst->nds->ARM7Read8(address + n);
    return length;
}
EMSCRIPTEN_KEEPALIVE int web_write_memory(int id, int cpu, unsigned address, const melonDS::u8* in, int length) {
    auto* inst = get(id); if (!inst || !in || (cpu != 7 && cpu != 9) || length < 0 || length > 4096 || !inst->paused) return -1;
    for (int n = 0; n < length; n++) {
        if (cpu == 9) inst->nds->ARM9Write8(address + n, in[n]);
        else inst->nds->ARM7Write8(address + n, in[n]);
    }
    return length;
}
EMSCRIPTEN_KEEPALIVE int web_key_mask(int id, unsigned mask) {
    auto* inst = get(id); if (!inst) return -1;
    inst->nds->SetKeyMask(mask); return 0;
}
EMSCRIPTEN_KEEPALIVE int web_framebuffers(int id, unsigned* addresses) {
    auto* inst = get(id); if (!inst || !addresses) return -1;
    void* top = nullptr; void* bottom = nullptr;
    if (!inst->nds->GPU.GetFramebuffers(&top, &bottom)) return -2;
    addresses[0] = reinterpret_cast<uintptr_t>(top);
    addresses[1] = reinterpret_cast<uintptr_t>(bottom);
    return 0;
}
static std::array<melonDS::LocalMP::PacketLogEntry, melonDS::LocalMP::kLogCapacity> logs;
static unsigned logCount;
static unsigned logDropped;
EMSCRIPTEN_KEEPALIVE int web_log_count() {
    logCount = localMP.DrainPacketLog(logs.data(), logs.size(), &logDropped);
    return logCount;
}
EMSCRIPTEN_KEEPALIVE int web_log_entry(int index, unsigned* meta, melonDS::u8* payload, int capacity) {
    if (index < 0 || static_cast<unsigned>(index) >= logCount || !meta || !payload) return -1;
    const auto& record = logs[index];
    if (capacity < record.Length) return -2;
    meta[0] = record.Timestamp & 0xffffffff;
    meta[1] = record.Timestamp >> 32;
    meta[2] = record.Sequence;
    meta[3] = record.Type;
    meta[4] = record.SenderID;
    meta[5] = record.ReceiverID;
    meta[6] = record.Received;
    meta[7] = logDropped;
    std::memcpy(payload, record.Payload.data(), record.Length);
    return record.Length;
}
}

namespace melonDS::Platform {
void saveNDSToInstance(const u8* data, u32 length, void* userdata) {
    auto* inst = static_cast<Instance*>(userdata);
    if (inst && data) inst->save.assign(data, data + length);
}
LocalMP& localMultiplayer() { return localMP; }
}
