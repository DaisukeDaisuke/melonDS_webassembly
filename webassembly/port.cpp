#include "Args.h"
#include "NDS.h"
#include "NDSCart.h"
#include "LocalMP.h"
#include "virtual-net.h"
#include <array>
#include <cstring>
#include <memory>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>
#include <emscripten/emscripten.h>

namespace {
struct Instance {
    int id;
    std::unique_ptr<melonDS::NDS> nds;
    std::vector<melonDS::u8> save;
    std::array<std::vector<melonDS::u8>, 10> states;
    std::mutex coreMutex;
    std::mutex wakeMutex;
    std::condition_variable wake;
    std::thread runner;
    std::atomic<bool> alive {true};
    std::atomic<bool> paused {true};
    std::atomic<bool> romLoaded {false};
    std::atomic<unsigned> completedFrames {0};
};
std::array<std::unique_ptr<Instance>, 16> instances;
melonDS::LocalMP localMP;
Instance* get(int id) { return id >= 0 && id < 16 ? instances[id].get() : nullptr; }
void runFrames(Instance* inst) {
    using clock = std::chrono::steady_clock;
    auto next = clock::now();
    while (inst->alive.load()) {
        if (inst->paused.load() || !inst->romLoaded.load()) {
            std::unique_lock<std::mutex> waitLock(inst->wakeMutex);
            inst->wake.wait(waitLock, [inst] { return !inst->alive.load() ||
                (!inst->paused.load() && inst->romLoaded.load()); });
            next = clock::now();
            continue;
        }
        {
            std::lock_guard<std::mutex> guard(inst->coreMutex);
            if (inst->alive.load() && !inst->paused.load() && inst->nds->IsRunning()) {
                inst->nds->RunFrame();
                inst->completedFrames = inst->nds->NumFrames;
            }
            else if (!inst->nds->IsRunning()) inst->paused = true;
        }
        next += std::chrono::microseconds(16742);
        if (next < clock::now()) next = clock::now();
        std::this_thread::sleep_until(next);
    }
}
int loadStateLocked(Instance* inst, int slot) {
    if (slot < 0 || slot >= 10 || inst->states[slot].empty()) return -1;
    melonDS::Savestate rollback;
    if (!inst->nds->DoSavestate(&rollback) || rollback.Error) return -2;
    rollback.Finish();
    if (rollback.Error) return -2;
    auto& bytes = inst->states[slot];
    melonDS::Savestate file(bytes.data(), bytes.size(), false);
    if (inst->nds->DoSavestate(&file) && !file.Error) {
        inst->completedFrames = inst->nds->NumFrames;
        return 0;
    }
    melonDS::Savestate restore(rollback.Buffer(), rollback.Length(), false);
    inst->nds->DoSavestate(&restore);
    inst->completedFrames = inst->nds->NumFrames;
    return -2;
}
}

// The dispatcher Worker owns all exported calls. Each NDS has a dedicated
// pthread running inside the SAME shared Wasm memory as the real LocalMP FIFO.
// Per-instance core locks make RPC completion a safe observation boundary.
extern "C" {
EMSCRIPTEN_KEEPALIVE int web_create(int id) {
    if (id < 0 || id >= 16 || instances[id]) return -1;
    auto instance = std::make_unique<Instance>();
    instance->id = id;
    melonDS::NDSArgs args;
    args.JIT = std::nullopt;
    instance->nds = std::make_unique<melonDS::NDS>(std::move(args), instance.get());
    instances[id] = std::move(instance);
    instances[id]->runner = std::thread(runFrames, instances[id].get());
    return id;
}
EMSCRIPTEN_KEEPALIVE int web_destroy(int id) {
    auto* inst = get(id);
    if (!inst) return -1;
    inst->paused = true;
    inst->alive = false;
    inst->wake.notify_all();
    if (inst->runner.joinable()) inst->runner.join();
    inst->nds->Stop();
    instances[id].reset();
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_load_rom(int id, const melonDS::u8* data, int length) {
    auto* inst = get(id);
    if (!inst || !data || length < 0x200 || length > 128 * 1024 * 1024) return -1;
    const bool wasPaused = inst->paused.exchange(true);
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    auto cart = melonDS::NDSCart::ParseROM(data, length, inst);
    if (!cart) { inst->paused = wasPaused; if (!wasPaused) inst->wake.notify_one(); return -2; }
    inst->nds->Stop();
    inst->nds->SetNDSCart(std::move(cart));
    inst->save.clear();
    for (auto& state : inst->states) state.clear();
    inst->nds->Reset();
    inst->nds->SetupDirectBoot("web.nds");
    inst->nds->Start();
    inst->completedFrames = inst->nds->NumFrames;
    inst->romLoaded = true;
    inst->paused = false;
    inst->wake.notify_one();
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_reset(int id) {
    auto* inst = get(id); if (!inst) return -1;
    const bool paused = inst->paused.exchange(true);
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    inst->nds->Stop(); inst->nds->Reset();
    if (inst->nds->CartInserted()) inst->nds->SetupDirectBoot("web.nds");
    inst->nds->Start(); inst->paused = paused;
    inst->completedFrames = inst->nds->NumFrames;
    if (!paused) inst->wake.notify_one();
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_pause(int id) {
    auto* inst = get(id); if (!inst) return -1;
    inst->paused = true;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_resume(int id) {
    auto* inst = get(id); if (!inst || !inst->romLoaded.load()) return -1;
    inst->paused = false; inst->wake.notify_one(); return 0;
}
EMSCRIPTEN_KEEPALIVE int web_frame(int id) {
    auto* inst = get(id); if (!inst) return -1;
    // Explicit frame step only while paused; normal frames run on its pthread.
    if (!inst->paused.load()) return -2;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    if (!inst->nds->IsRunning()) return -1;
    inst->nds->RunFrame();
    inst->completedFrames = inst->nds->NumFrames;
    return static_cast<int>(inst->nds->NumFrames);
}
EMSCRIPTEN_KEEPALIVE int web_frame_number(int id) {
    auto* inst = get(id); if (!inst) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    return static_cast<int>(inst->nds->NumFrames);
}
EMSCRIPTEN_KEEPALIVE int web_peek_frame_number(int id) {
    auto* inst = get(id);
    return inst ? static_cast<int>(inst->completedFrames.load()) : -1;
}
EMSCRIPTEN_KEEPALIVE int web_register(int id, int cpu, int reg) {
    auto* inst = get(id); if (!inst || (cpu != 7 && cpu != 9) || reg < 0 || reg > 16) return 0;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    auto* arm = cpu == 9 ? static_cast<melonDS::ARM*>(inst->nds->ARM9) : inst->nds->ARM7;
    if (reg == 16) return arm->CPSR;
    return reg == 15 ? arm->R[15] - ((arm->CPSR & 0x20) ? 2 : 4) : arm->R[reg];
}
EMSCRIPTEN_KEEPALIVE int web_set_register(int id, int cpu, int reg, unsigned value) {
    auto* inst = get(id); if (!inst || (cpu != 7 && cpu != 9) || reg < 0 || reg > 16 || !inst->paused.load()) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    auto* arm = cpu == 9 ? static_cast<melonDS::ARM*>(inst->nds->ARM9) : inst->nds->ARM7;
    if (reg == 16) arm->CPSR = value;
    else if (reg == 15) arm->JumpTo(value);
    else arm->R[reg] = value;
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_read_memory(int id, int cpu, unsigned address, melonDS::u8* out, int length) {
    auto* inst = get(id); if (!inst || !out || (cpu != 7 && cpu != 9) || length < 0 || length > 4096) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    for (int n = 0; n < length; n++) out[n] = cpu == 9 ? inst->nds->ARM9Read8(address + n) : inst->nds->ARM7Read8(address + n);
    return length;
}
EMSCRIPTEN_KEEPALIVE int web_write_memory(int id, int cpu, unsigned address, const melonDS::u8* in, int length) {
    // The per-instance lock serializes writes with its frame pthread.
    auto* inst = get(id); if (!inst || !in || (cpu != 7 && cpu != 9) || length < 0 || length > 4096) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    for (int n = 0; n < length; n++) {
        if (cpu == 9) inst->nds->ARM9Write8(address + n, in[n]);
        else inst->nds->ARM7Write8(address + n, in[n]);
    }
    return length;
}
EMSCRIPTEN_KEEPALIVE int web_key_mask(int id, unsigned mask) {
    auto* inst = get(id); if (!inst) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    inst->nds->SetKeyMask(mask); return 0;
}
EMSCRIPTEN_KEEPALIVE int web_save_state(int id, int slot) {
    auto* inst = get(id); if (!inst || slot < 0 || slot >= 10) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    if (!inst->nds->CartInserted()) return -1;
    melonDS::Savestate file;
    if (!inst->nds->DoSavestate(&file) || file.Error) return -2;
    file.Finish();
    if (file.Error) return -2;
    const auto* data = static_cast<const melonDS::u8*>(file.Buffer());
    inst->states[slot].assign(data, data + file.Length());
    return static_cast<int>(inst->states[slot].size());
}
EMSCRIPTEN_KEEPALIVE int web_load_state(int id, int slot) {
    auto* inst = get(id); if (!inst) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    return loadStateLocked(inst, slot);
}
EMSCRIPTEN_KEEPALIVE int web_state_size(int id, int slot) {
    auto* inst = get(id); if (!inst || slot < 0 || slot >= 10) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    return static_cast<int>(inst->states[slot].size());
}
EMSCRIPTEN_KEEPALIVE int web_state_export(int id, int slot, melonDS::u8* dest, int capacity) {
    auto* inst = get(id); if (!inst || slot < 0 || slot >= 10 || !dest || capacity < 0) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    const auto& bytes = inst->states[slot];
    if (capacity < static_cast<int>(bytes.size())) return -2;
    std::memcpy(dest, bytes.data(), bytes.size());
    return bytes.size();
}
EMSCRIPTEN_KEEPALIVE int web_state_import(int id, int slot, const melonDS::u8* data, int length) {
    auto* inst = get(id);
    if (!inst || slot < 0 || slot >= 10 || !data || length < 8 || length > 64 * 1024 * 1024) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    auto previous = std::move(inst->states[slot]);
    inst->states[slot].assign(data, data + length);
    const int result = loadStateLocked(inst, slot);
    if (result < 0) inst->states[slot] = std::move(previous);
    return result;
}
EMSCRIPTEN_KEEPALIVE int web_save_size(int id) {
    auto* inst = get(id); if (!inst) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    return static_cast<int>(inst->nds->GetNDSSaveLength());
}
EMSCRIPTEN_KEEPALIVE int web_save_export(int id, melonDS::u8* dest, int capacity) {
    auto* inst = get(id); if (!inst || !dest || capacity < 0) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    const auto* data = inst->nds->GetNDSSave();
    int size = inst->nds->GetNDSSaveLength();
    if (!data || capacity < size) return -2;
    std::memcpy(dest, data, size); return size;
}
EMSCRIPTEN_KEEPALIVE int web_save_import(int id, const melonDS::u8* data, int length) {
    auto* inst = get(id);
    if (!inst || !data || length < 0 || length > 16 * 1024 * 1024) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    if (!inst->nds->CartInserted()) return -1;
    inst->nds->SetNDSSave(data, length);
    inst->save.assign(data, data + length);
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_copy_frame(int id, melonDS::u8* destination, int capacity) {
    constexpr int kOneScreenBytes = 256 * 192 * 4;
    auto* inst = get(id); if (!inst || !destination || capacity < kOneScreenBytes * 2) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    void* top = nullptr; void* bottom = nullptr;
    if (!inst->nds->GPU.GetFramebuffers(&top, &bottom)) return -2;
    if (!top || !bottom) return -2;
    memcpy(destination, top, kOneScreenBytes);
    memcpy(destination + kOneScreenBytes, bottom, kOneScreenBytes);
    return kOneScreenBytes * 2;
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
static std::array<melonDS::Platform::WebNetFrame, 512> netLogs;
static unsigned netLogCount;
static unsigned netLogDropped;
EMSCRIPTEN_KEEPALIVE int web_net_enqueue(int id, const melonDS::u8* bytes, int length) {
    if (!get(id)) return -1;
    return melonDS::Platform::WebNetEnqueue(id, bytes, length);
}
EMSCRIPTEN_KEEPALIVE int web_net_log_count() {
    netLogCount = melonDS::Platform::WebNetDrain(netLogs.data(), netLogs.size(), &netLogDropped);
    return netLogCount;
}
EMSCRIPTEN_KEEPALIVE int web_net_log_entry(int index, unsigned* meta, melonDS::u8* payload, int capacity) {
    if (index < 0 || static_cast<unsigned>(index) >= netLogCount || !meta || !payload) return -1;
    const auto& record = netLogs[index];
    if (capacity < record.length) return -2;
    meta[0] = record.timestamp & 0xffffffff;
    meta[1] = record.timestamp >> 32;
    meta[2] = record.instanceId;
    meta[3] = record.received;
    meta[4] = netLogDropped;
    memcpy(payload, record.data.data(), record.length);
    return record.length;
}
}

namespace melonDS::Platform {
void saveNDSToInstance(const u8* data, u32 length, void* userdata) {
    auto* inst = static_cast<Instance*>(userdata);
    if (inst && data) inst->save.assign(data, data + length);
}
LocalMP& localMultiplayer() { return localMP; }
}
