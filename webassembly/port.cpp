#include "Args.h"
#include "NDS.h"
#include "NDSCart.h"
#include "LocalMP.h"
#include "virtual-net.h"
#include "web-debug-hooks.h"
#include "desmume-state.h"
#include <array>
#include <cstring>
#include <deque>
#include <memory>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>
#include <emscripten/emscripten.h>
#include "call-stack-lens.h"
#include "wall-clock.h"

namespace {
struct Freeze {
    int cpu;
    unsigned address;
    std::vector<melonDS::u8> bytes;
};
struct InputEvent {
    unsigned frame;
    unsigned mask;
};
struct Breakpoint {
    unsigned id;
    int cpu;
    unsigned address;
    unsigned length;
    int kind; // 1=execute, 2=read, 3=write
};
struct DebugEvent {
    int instanceId;
    int cpu;
    int kind; // 1=execute, 2=read, 3=write, 4=step, 5=runUntil, 6=pause
    unsigned id;
    unsigned address;
    unsigned pc;
    unsigned frame;
};
struct TraceFrame {
    unsigned caller;
    unsigned callee;
    unsigned returnAddress;
    unsigned sp;
    unsigned cpsr;
};
struct Instance {
    int id;
    std::unique_ptr<melonDS::NDS> nds;
    std::vector<melonDS::u8> save;
    unsigned systemFiles = 0;
    int stateBiosDifferences = -1;
    bool stateBiosHLE = false;
    std::array<std::vector<melonDS::u8>, 10> states;
    std::vector<Freeze> freezes;
    std::vector<InputEvent> recordedInput;
    std::vector<InputEvent> scheduledInput;
    unsigned recordStart = 0;
    unsigned scheduleStart = 0;
    size_t scheduleOffset = 0;
    bool recording = false;
    bool recordingOverflow = false;
    std::vector<Breakpoint> breakpoints;
    unsigned nextBreakpointId = 1;
    std::mutex debugMutex;
    std::condition_variable debugWake;
    std::unique_lock<std::mutex>* frameLock = nullptr; // runner thread only
    bool frameActive = false; // debugMutex
    bool debugSuspended = false; // debugMutex
    std::atomic<bool> abortFrame {false};
    bool checkpointRequested = false; // debugMutex
    bool checkpointMode = false; // coreMutex
    int checkpointSlot = 0; // coreMutex
    int checkpointResult = -3; // debugMutex
    bool stepActive = false; // coreMutex
    int stepCpu = 9; // coreMutex
    bool untilActive = false; // coreMutex
    int untilCpu = 9; // coreMutex
    unsigned untilAddress = 0; // coreMutex
    int skipCpu = 0; // coreMutex
    unsigned skipAddress = 0; // coreMutex
    int watchKind = 0; // coreMutex
    unsigned watchId = 0; // coreMutex
    unsigned watchAddress = 0; // coreMutex
    std::array<CallStackLens<TraceFrame>, 2> callTrace;
    std::array<unsigned, 2> beforeLr {};
    std::array<bool, 2> beforeThumb {};
    std::mutex coreMutex;
    std::mutex wakeMutex;
    std::condition_variable wake;
    std::thread runner;
    std::atomic<bool> alive {true};
    std::atomic<bool> paused {true};
    std::atomic<bool> romLoaded {false};
    std::atomic<unsigned> completedFrames {0};
    // Presentation is published at a frame boundary. Reading a window must
    // never wait for another instance's interpreter or LocalMP receive.
    std::mutex videoMutex;
    std::array<melonDS::u8, 256 * 192 * 4 * 2> video {};
    bool videoValid = false;
};
std::array<std::unique_ptr<Instance>, 16> instances;
melonDS::LocalMP localMP;
std::mutex debugEventMutex;
std::deque<DebugEvent> debugEvents;
std::vector<DebugEvent> drainedDebugEvents;
unsigned debugEventsDropped = 0;
unsigned drainedDebugDropped = 0;
Instance* get(int id) { return id >= 0 && id < 16 ? instances[id].get() : nullptr; }
void publishFrame(Instance* inst) {
    void* top = nullptr; void* bottom = nullptr;
    if (!inst->nds->GPU.GetFramebuffers(&top, &bottom) || !top || !bottom) return;
    std::lock_guard<std::mutex> lock(inst->videoMutex);
    constexpr size_t bytes = 256 * 192 * 4;
    std::memcpy(inst->video.data(), top, bytes);
    std::memcpy(inst->video.data() + bytes, bottom, bytes);
    inst->videoValid = true;
}
void queueDebugEvent(const DebugEvent& event) {
    std::lock_guard<std::mutex> lock(debugEventMutex);
    if (debugEvents.size() == 1024) {
        debugEvents.pop_front(); ++debugEventsDropped;
    }
    debugEvents.push_back(event);
}
void abortActiveFrame(Instance* inst) {
    std::unique_lock<std::mutex> lock(inst->debugMutex);
    if (!inst->frameActive) return;
    inst->paused = true;
    inst->abortFrame = true;
    if (inst->checkpointRequested) {
        inst->checkpointRequested = false;
        inst->checkpointResult = -3;
    }
    inst->debugWake.notify_all();
    inst->debugWake.wait(lock, [inst] { return !inst->frameActive; });
    inst->abortFrame = false;
}
bool abortSuspendedFrame(Instance* inst) {
    bool suspended;
    {
        std::lock_guard<std::mutex> lock(inst->debugMutex);
        suspended = inst->debugSuspended;
    }
    if (suspended) abortActiveFrame(inst);
    return suspended;
}
int saveStateLocked(Instance* inst, int slot) {
    if (!inst->nds->CartInserted()) return -1;
    melonDS::Savestate file;
    if (!inst->nds->DoSavestate(&file) || file.Error) return -2;
    file.Finish();
    if (file.Error) return -2;
    const auto* data = static_cast<const melonDS::u8*>(file.Buffer());
    inst->states[slot].assign(data, data + file.Length());
    return static_cast<int>(inst->states[slot].size());
}
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
            std::unique_lock<std::mutex> guard(inst->coreMutex);
            if (inst->alive.load() && !inst->paused.load() && inst->nds->IsRunning()) {
                if (inst->scheduleOffset < inst->scheduledInput.size()) {
                    const unsigned frame = inst->nds->NumFrames - inst->scheduleStart;
                    while (inst->scheduleOffset < inst->scheduledInput.size()
                        && inst->scheduledInput[inst->scheduleOffset].frame <= frame) {
                        inst->nds->SetKeyMask(inst->scheduledInput[inst->scheduleOffset++].mask);
                    }
                }
                {
                    std::lock_guard<std::mutex> debugLock(inst->debugMutex);
                    inst->frameActive = true;
                    inst->frameLock = &guard;
                }
                inst->nds->RunFrame();
                publishFrame(inst);
                if (inst->checkpointMode) {
                    const int result = saveStateLocked(inst, inst->checkpointSlot);
                    inst->checkpointMode = false;
                    inst->paused = true;
                    std::lock_guard<std::mutex> debugLock(inst->debugMutex);
                    inst->checkpointResult = result;
                    inst->checkpointRequested = false;
                    inst->debugWake.notify_all();
                }
                {
                    std::lock_guard<std::mutex> debugLock(inst->debugMutex);
                    inst->frameActive = false;
                    inst->frameLock = nullptr;
                    inst->debugWake.notify_all();
                }
                for (const auto& freeze : inst->freezes) {
                    for (size_t n = 0; n < freeze.bytes.size(); ++n) {
                        if (freeze.cpu == 9) inst->nds->ARM9Write8(freeze.address + n, freeze.bytes[n]);
                        else inst->nds->ARM7Write8(freeze.address + n, freeze.bytes[n]);
                    }
                }
                inst->completedFrames = inst->nds->NumFrames;
            }
            else if (!inst->nds->IsRunning()) inst->paused = true;
        }
        next += std::chrono::microseconds(16742);
        // Preserve the deadline across small overruns instead of accumulating
        // sleep jitter into a slower emulation/audio clock.
        if (next + std::chrono::milliseconds(100) < clock::now()) next = clock::now();
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
        inst->scheduledInput.clear(); inst->scheduleOffset = 0;
        inst->recording = false;
        inst->stepActive = false; inst->untilActive = false;
        inst->skipCpu = 0; inst->watchKind = 0;
        for (auto& trace : inst->callTrace) trace.clear();
        inst->completedFrames = inst->nds->NumFrames;
        publishFrame(inst);
        return 0;
    }
    melonDS::Savestate restore(rollback.Buffer(), rollback.Length(), false);
    inst->nds->DoSavestate(&restore);
    inst->completedFrames = inst->nds->NumFrames;
    return -2;
}
}

namespace melonDS::WebDebugger {
namespace {
bool park(Instance* inst, ARM* cpu, int kind, unsigned id, unsigned address, unsigned pc) {
    std::unique_lock<std::mutex> state(inst->debugMutex);
    inst->paused = true;
    inst->debugSuspended = true;
    if (kind == 1 || kind == 5) { inst->skipCpu = cpu->Num ? 7 : 9; inst->skipAddress = address; }
    inst->stepActive = false;
    inst->untilActive = false;
    queueDebugEvent({inst->id, cpu->Num ? 7 : 9, kind, id, address, pc, inst->nds->NumFrames});
    inst->debugWake.notify_all();
    // The runner cannot own coreMutex while stopped: RPC register/memory calls
    // must observe the suspended interpreter before the next instruction.
    inst->frameLock->unlock();
    inst->debugWake.wait(state, [inst] {
        return inst->abortFrame || !inst->alive.load() || !inst->paused.load();
    });
    const bool abort = inst->abortFrame || !inst->alive.load();
    inst->debugSuspended = false;
    inst->debugWake.notify_all();
    state.unlock();
    inst->frameLock->lock();
    if (abort) inst->nds->Stop();
    return !abort;
}
}
bool BeforeInstruction(ARM* cpu, u32 address) {
    auto* inst = static_cast<Instance*>(cpu->NDS.UserData);
    if (!inst) return true;
    if (inst->abortFrame.load(std::memory_order_relaxed) || !inst->alive.load(std::memory_order_relaxed)) {
        inst->nds->Stop();
        return false;
    }
    if (inst->checkpointMode) return true;
    const int which = cpu->Num ? 7 : 9;
    if (inst->paused.load() && !park(inst, cpu, 6, 0, address, address)) return false;
    if (inst->checkpointMode) return true;
    // Pausing releases coreMutex; a concurrent reset may abort this frame.
    if (!cpu->NDS.IsRunning()) return false;
    const unsigned currentAddress = cpu->R[15] - ((cpu->CPSR & 0x20) ? 2 : 4);
    if (currentAddress != address) return BeforeInstruction(cpu, currentAddress);
    if (inst->skipCpu == which && inst->skipAddress == address) inst->skipCpu = 0;
    else {
        if (inst->untilActive && inst->untilCpu == which && inst->untilAddress == address) {
            const bool continueFrame = park(inst, cpu, 5, 0, address, address);
            if (continueFrame) {
                inst->beforeLr[cpu->Num] = cpu->R[14];
                inst->beforeThumb[cpu->Num] = !!(cpu->CPSR & 0x20);
            }
            return continueFrame;
        }
        for (const auto& bp : inst->breakpoints) {
            if (bp.kind == 1 && bp.cpu == which && bp.address == address) {
                const bool continueFrame = park(inst, cpu, 1, bp.id, address, address);
                if (continueFrame) {
                    inst->beforeLr[cpu->Num] = cpu->R[14];
                    inst->beforeThumb[cpu->Num] = !!(cpu->CPSR & 0x20);
                }
                return continueFrame;
            }
        }
    }
    inst->beforeLr[cpu->Num] = cpu->R[14];
    inst->beforeThumb[cpu->Num] = !!(cpu->CPSR & 0x20);
    return true;
}
bool Exception(ARM* cpu, int kind, u32 address) {
    auto* inst = static_cast<Instance*>(cpu->NDS.UserData);
    if (!inst || inst->checkpointMode || !inst->frameLock
        || std::this_thread::get_id() != inst->runner.get_id()) return true;
    const int which = cpu->Num ? 7 : 9;
    for (const auto& bp : inst->breakpoints) {
        if (bp.cpu == which && bp.kind == kind) return park(inst, cpu, kind, bp.id, address, address);
    }
    return true;
}
void MemoryAccess(ARM* cpu, u32 address, u32 size, bool write) {
    auto* inst = static_cast<Instance*>(cpu->NDS.UserData);
    if (!inst || inst->watchKind) return;
    const int which = cpu->Num ? 7 : 9;
    for (const auto& bp : inst->breakpoints) {
        if (bp.cpu != which || (bp.kind != 10 && bp.kind != (write ? 3 : 2))) continue;
        if (static_cast<uint64_t>(address) < static_cast<uint64_t>(bp.address) + bp.length
            && static_cast<uint64_t>(bp.address) < static_cast<uint64_t>(address) + size) {
            inst->watchKind = bp.kind; inst->watchId = bp.id; inst->watchAddress = address;
            return;
        }
    }
}
void AfterInstruction(ARM* cpu, u32 address) {
    auto* inst = static_cast<Instance*>(cpu->NDS.UserData);
    if (!inst) return;
    if (inst->checkpointMode) { inst->watchKind = 0; return; }
    const unsigned opcode = cpu->CurInstr;
    const bool thumb = inst->beforeThumb[cpu->Num];
    const bool call = thumb ? ((opcode & 0xf800) == 0xf800 || (opcode & 0xf800) == 0xe800 || (opcode & 0xff87) == 0x4780)
        : ((opcode & 0x0f000000) == 0x0b000000
            || (opcode & 0xfe000000) == 0xfa000000
            || (opcode & 0x0ffffff0) == 0x012fff30);
    const unsigned target = cpu->R[15] - ((cpu->CPSR & 0x20) ? 2 : 4);
    auto& trace = inst->callTrace[cpu->Num];
    trace.tick(cpu->R[13], target, cpu->CPSR);
    if (call && (cpu->R[14] != inst->beforeLr[cpu->Num] || target != address + (thumb ? 2u : 4u))) {
        trace.call({thumb && ((opcode & 0xf800) == 0xf800 || (opcode & 0xf800) == 0xe800) ? address - 2 : address, target, cpu->R[14] & ~1u, cpu->R[13], cpu->CPSR});
    } else if (target != address + (thumb ? 2u : 4u)) {
        const bool indirect = thumb ? ((opcode & 0xff00) == 0x4700 || (opcode & 0xff00) == 0xbd00 || (opcode & 0xff87) == 0x4687)
            : ((opcode & 0x0ffffff0) == 0x012fff10 || ((opcode & 0x0c000000) == 0 && (opcode & 0xf000) == 0xf000)
               || ((opcode & 0x0e108000) == 0x08108000) || ((opcode & 0x0c10f000) == 0x0410f000));
        trace.branch(target, cpu->R[13], cpu->CPSR, indirect);
    } else if (thumb ? (opcode & 0xff00) == 0xb500 : (opcode & 0x0fff4000) == 0x092d4000) {
        trace.enter({address, address, cpu->R[14] & ~1u, cpu->R[13], cpu->CPSR});
    }
    if (inst->watchKind) {
        const int kind = inst->watchKind;
        const unsigned id = inst->watchId, watched = inst->watchAddress;
        inst->watchKind = 0;
        park(inst, cpu, kind, id, watched, address);
    } else if (inst->stepActive && inst->stepCpu == (cpu->Num ? 7 : 9)) {
        park(inst, cpu, 4, 0, address, address);
    }
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
    args.Firmware.GetHeader().MacAddr[5] = static_cast<melonDS::u8>(0x33 + id);
    args.Firmware.UpdateChecksums();
    instance->nds = std::make_unique<melonDS::NDS>(std::move(args), instance.get());
    initializeWallClock(*instance->nds);
    instances[id] = std::move(instance);
    instances[id]->runner = std::thread(runFrames, instances[id].get());
    return id;
}
EMSCRIPTEN_KEEPALIVE int web_system_import(int id, int kind, const melonDS::u8* data, int length) {
    auto* inst = get(id);
    if (!inst || !data) return -1;
    if ((kind == 7 && length != melonDS::ARM7BIOSSize) ||
        (kind == 9 && length != melonDS::ARM9BIOSSize) ||
        (kind == 0 && length != 0x20000 && length != 0x40000 && length != 0x80000) ||
        (kind != 0 && kind != 7 && kind != 9)) return -2;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    if (kind == 7) {
        std::array<melonDS::u8, melonDS::ARM7BIOSSize> image;
        std::memcpy(image.data(), data, image.size());
        inst->nds->SetARM7BIOS(image); inst->systemFiles |= 1;
    } else if (kind == 9) {
        std::array<melonDS::u8, melonDS::ARM9BIOSSize> image;
        std::memcpy(image.data(), data, image.size());
        inst->nds->SetARM9BIOS(image); inst->systemFiles |= 2;
    } else {
        melonDS::Firmware image(data, length);
        image.GetHeader().MacAddr[5] = static_cast<melonDS::u8>(image.GetHeader().MacAddr[5] + id);
        image.UpdateChecksums();
        inst->nds->SetFirmware(std::move(image)); inst->systemFiles |= 4;
    }
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_system_status(int id) {
    auto* inst = get(id); if (!inst) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    return inst->systemFiles | (inst->nds->IsLoadedARM7BIOSKnownNative() ? 8 : 0)
        | (inst->nds->IsLoadedARM9BIOSKnownNative() ? 16 : 0);
}
EMSCRIPTEN_KEEPALIVE int web_destroy(int id) {
    auto* inst = get(id);
    if (!inst) return -1;
    inst->paused = true;
    inst->alive = false;
    abortActiveFrame(inst);
    inst->wake.notify_all();
    if (inst->runner.joinable()) inst->runner.join();
    inst->nds->Stop();
    melonDS::Platform::MP_End(inst);
    melonDS::Platform::WebNetClear(id);
    melonDS::Platform::WebNetSetEnabled(id, true);
    instances[id].reset();
    localMP.ClearPacketControl(id);
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_load_rom(int id, const melonDS::u8* data, int length) {
    auto* inst = get(id);
    if (!inst || !data || length < 0x200 || length > 512 * 1024 * 1024) return -1;
    auto cart = melonDS::NDSCart::ParseROM(data, length, inst);
    if (!cart) return -2;

    inst->paused = true;
    abortActiveFrame(inst);
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    inst->nds->Stop();
    melonDS::Platform::MP_End(inst);
    melonDS::Platform::WebNetClear(id);
    inst->nds->SetNDSCart(std::move(cart));
    // SetCart normalizes a decrypted secure area by re-encrypting it. Match
    // only after that normalization; comparing the uploaded bytes against
    // an already-inserted cart prevented sharing and exhausted Wasm at 16 ROMs.
    for (const auto& other : instances) {
        if (other && other.get() != inst && other->nds->GetNDSCart()
            && inst->nds->GetNDSCart()->ShareROMFrom(*other->nds->GetNDSCart())) break;
    }
    inst->save.clear();
    for (auto& state : inst->states) state.clear();
    inst->freezes.clear();
    inst->breakpoints.clear(); inst->stepActive = false; inst->untilActive = false;
    inst->skipCpu = 0; inst->watchKind = 0;
    for (auto& trace : inst->callTrace) trace.clear();
    inst->recordedInput.clear(); inst->scheduledInput.clear();
    inst->recording = false; inst->scheduleOffset = 0;
    inst->recordingOverflow = false;
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
    abortActiveFrame(inst);
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    inst->nds->Stop(); inst->nds->Reset();
    inst->scheduledInput.clear(); inst->recording = false;
    inst->stepActive = false; inst->untilActive = false; inst->watchKind = 0; inst->skipCpu = 0;
    for (auto& trace : inst->callTrace) trace.clear();
    melonDS::Platform::MP_End(inst);
    melonDS::Platform::WebNetClear(id);
    if (inst->nds->CartInserted()) inst->nds->SetupDirectBoot("web.nds");
    inst->nds->Start(); inst->paused = paused;
    inst->completedFrames = inst->nds->NumFrames;
    publishFrame(inst);
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
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    if (!inst->nds->IsRunning()) return -2;
    inst->stepActive = false; inst->untilActive = false;
    inst->paused = false; inst->wake.notify_one(); inst->debugWake.notify_all(); return 0;
}
EMSCRIPTEN_KEEPALIVE int web_is_paused(int id) {
    auto* inst = get(id);
    return inst ? static_cast<int>(inst->paused.load()) : -1;
}
EMSCRIPTEN_KEEPALIVE int web_frame(int id) {
    auto* inst = get(id); if (!inst) return -1;
    // Explicit frame step only while paused; normal frames run on its pthread.
    {
        std::lock_guard<std::mutex> debugLock(inst->debugMutex);
        if (inst->debugSuspended) return -3;
    }
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    if (!inst->paused.load()) return -2;
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
EMSCRIPTEN_KEEPALIVE int web_breakpoint_add(int id, int cpu, int kind, unsigned address, unsigned length) {
    auto* inst = get(id);
    if (!inst || (cpu != 7 && cpu != 9) || (kind != 1 && kind != 2 && kind != 3 && kind != 7 && kind != 8 && kind != 9 && kind != 10) || length < 1 || length > 4096
        || static_cast<uint64_t>(address) + length > 0x100000000ull) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    if (inst->breakpoints.size() >= 256) return -2;
    const unsigned bpId = inst->nextBreakpointId++;
    inst->breakpoints.push_back({bpId, cpu, address, length, kind});
    return static_cast<int>(bpId);
}
EMSCRIPTEN_KEEPALIVE int web_breakpoint_remove(int id, unsigned breakpointId) {
    auto* inst = get(id); if (!inst) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    auto& entries = inst->breakpoints;
    for (auto it = entries.begin(); it != entries.end(); ++it) {
        if (it->id == breakpointId) { entries.erase(it); return 1; }
    }
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_breakpoint_count(int id) {
    auto* inst = get(id); if (!inst) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    return static_cast<int>(inst->breakpoints.size());
}
EMSCRIPTEN_KEEPALIVE int web_breakpoint_entry(int id, int index, unsigned* output) {
    auto* inst = get(id); if (!inst || !output) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    if (index < 0 || static_cast<size_t>(index) >= inst->breakpoints.size()) return -1;
    const auto& bp = inst->breakpoints[index];
    output[0] = bp.id; output[1] = bp.cpu; output[2] = bp.kind;
    output[3] = bp.address; output[4] = bp.length;
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_debug_step(int id, int cpu) {
    auto* inst = get(id); if (!inst || (cpu != 7 && cpu != 9) || !inst->paused.load()) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    if (!inst->nds->IsRunning()) return -2;
    inst->stepCpu = cpu; inst->stepActive = true; inst->untilActive = false;
    inst->paused = false;
    inst->wake.notify_one(); inst->debugWake.notify_all();
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_debug_until(int id, int cpu, unsigned address) {
    auto* inst = get(id); if (!inst || (cpu != 7 && cpu != 9) || !inst->romLoaded.load()) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    if (!inst->nds->IsRunning()) return -2;
    inst->untilCpu = cpu; inst->untilAddress = address; inst->untilActive = true;
    inst->stepActive = false; inst->paused = false;
    inst->wake.notify_one(); inst->debugWake.notify_all();
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_debug_event_count() {
    std::lock_guard<std::mutex> guard(debugEventMutex);
    drainedDebugDropped = debugEventsDropped; debugEventsDropped = 0;
    drainedDebugEvents.assign(debugEvents.begin(), debugEvents.end());
    debugEvents.clear();
    return static_cast<int>(drainedDebugEvents.size());
}
EMSCRIPTEN_KEEPALIVE int web_debug_event_entry(int index, unsigned* output) {
    if (index < 0 || static_cast<size_t>(index) >= drainedDebugEvents.size() || !output) return -1;
    const auto& event = drainedDebugEvents[index];
    output[0] = event.instanceId; output[1] = event.cpu; output[2] = event.kind;
    output[3] = event.id; output[4] = event.address; output[5] = event.pc;
    output[6] = event.frame; output[7] = drainedDebugDropped;
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_call_stack_count(int id, int cpu) {
    auto* inst = get(id); if (!inst || (cpu != 7 && cpu != 9)) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    return static_cast<int>(inst->callTrace[cpu == 9 ? 0 : 1].frames().size());
}
EMSCRIPTEN_KEEPALIVE int web_call_stack_entry(int id, int cpu, int index, unsigned* output) {
    auto* inst = get(id); if (!inst || !output || (cpu != 7 && cpu != 9)) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    const auto& frames = inst->callTrace[cpu == 9 ? 0 : 1].frames();
    if (index < 0 || static_cast<size_t>(index) >= frames.size()) return -1;
    const auto& frame = frames[frames.size() - 1 - index];
    output[0] = frame.caller; output[1] = frame.callee;
    output[2] = frame.returnAddress; output[3] = frame.sp;
    output[4] = frame.cpsr;
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_call_stack_snapshot(int id, int cpu, unsigned* out, int capacity, int limit) {
    auto* inst = get(id);
    if (!inst || !out || (cpu != 7 && cpu != 9) || limit < 1 || limit > 128) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    auto& lens = inst->callTrace[cpu == 9 ? 0 : 1];
    lens.pruneEmpty();
    size_t required = 3;
    for (const auto& lane : lens.lanes) required += 5 + std::min(lane.frames.size(), static_cast<size_t>(limit)) * 5;
    if (capacity < 0 || required > static_cast<size_t>(capacity)) return -2;
    unsigned cursor = 0, total = 0;
    for (const auto& lane : lens.lanes) total += lane.frames.size();
    out[cursor++] = lens.lanes.size();
    out[cursor++] = lens.active >= lens.lanes.size() ? 0 : lens.lanes[lens.active].id;
    out[cursor++] = total;
    for (const auto& lane : lens.lanes) {
        const auto count = std::min(lane.frames.size(), static_cast<size_t>(limit));
        out[cursor++] = lane.id; out[cursor++] = lane.lastSp; out[cursor++] = lane.nowPc;
        out[cursor++] = lane.cpsr; out[cursor++] = count;
        for (size_t i = 0; i < count; ++i) {
            const auto& frame = lane.frames[lane.frames.size() - 1 - i];
            out[cursor++] = frame.caller; out[cursor++] = frame.callee; out[cursor++] = frame.returnAddress;
            out[cursor++] = frame.sp; out[cursor++] = frame.cpsr;
        }
    }
    return cursor;
}
EMSCRIPTEN_KEEPALIVE int web_rom_info(int id, int field) {
    auto* inst = get(id); if (!inst || !inst->nds->GetNDSCart()) return 0;
    const auto* cart = inst->nds->GetNDSCart();
    if (field == 0) return cart->GetROMLength();
    int count = 0;
    for (const auto& other : instances) {
        if (other && other->nds->GetNDSCart() && other->nds->GetNDSCart()->GetROM() == cart->GetROM()) ++count;
    }
    return count;
}
EMSCRIPTEN_KEEPALIVE double web_cpu_info(int id, int cpu, int field) {
    auto* inst = get(id); if (!inst || (cpu != 7 && cpu != 9)) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    auto& n = *inst->nds;
    auto* arm = cpu == 9 ? static_cast<melonDS::ARM*>(n.ARM9) : n.ARM7;
    switch (field) {
    case 0: return arm->Halted;
    case 1: return arm->IRQ;
    case 2: return cpu == 9 ? n.ARM9Timestamp : n.ARM7Timestamp;
    case 3: return cpu == 9 ? n.ARM9Target : n.ARM7Target;
    case 4: return n.ARM7Timestamp;
    case 5: return n.CPUStop;
    case 6: return n.ARM9ClockShift;
    case 7: return arm->IdleLoop;
    case 8: return n.IME[cpu == 9 ? 0 : 1];
    case 9: return n.IE[cpu == 9 ? 0 : 1];
    case 10: return n.IF[cpu == 9 ? 0 : 1];
    case 11: return cpu == 9 ? n.ARM9IORead16(0x04000184) : n.ARM7IORead16(0x04000184);
    case 12: return cpu == 9 ? n.ARM9IORead16(0x04000180) : n.ARM7IORead16(0x04000180);
    default: return -1;
    }
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
    auto* arm = cpu == 9 ? static_cast<melonDS::ARM*>(inst->nds->ARM9) : inst->nds->ARM7;
    for (int n = 0; n < length; n++) out[n] = static_cast<melonDS::u8>(arm->ReadMem(address + n, 8));
    return length;
}
EMSCRIPTEN_KEEPALIVE int web_write_memory(int id, int cpu, unsigned address, const melonDS::u8* in, int length) {
    // The per-instance lock serializes writes with its frame pthread.
    auto* inst = get(id); if (!inst || !in || (cpu != 7 && cpu != 9) || length < 0 || length > 4096) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    for (int n = 0; n < length; n++) {
        if (cpu == 9) inst->nds->ARM9->WriteMem(address + n, 8, in[n]);
        else inst->nds->ARM7->WriteMem(address + n, 8, in[n]);
    }
    return length;
}
EMSCRIPTEN_KEEPALIVE int web_freeze_set(int id, int cpu, unsigned address, const melonDS::u8* data, int length) {
    auto* inst = get(id);
    if (!inst || !data || (cpu != 7 && cpu != 9) || length < 1 || length > 256 || address > 0xffffffffu - length) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    for (auto& freeze : inst->freezes) {
        if (freeze.cpu == cpu && freeze.address == address) {
            freeze.bytes.assign(data, data + length);
            return 0;
        }
    }
    if (inst->freezes.size() >= 256) return -2;
    inst->freezes.push_back({cpu, address, std::vector<melonDS::u8>(data, data + length)});
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_freeze_remove(int id, int cpu, unsigned address) {
    auto* inst = get(id); if (!inst || (cpu != 7 && cpu != 9)) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    auto& entries = inst->freezes;
    for (auto it = entries.begin(); it != entries.end(); ++it) {
        if (it->cpu == cpu && it->address == address) { entries.erase(it); return 1; }
    }
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_touch(int id, int x, int y, int pressed) {
    auto* inst = get(id);
    if (!inst || !inst->romLoaded.load() || x < 0 || x > 255 || y < 0 || y > 191) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    if (pressed) inst->nds->TouchScreen(x, y);
    else inst->nds->ReleaseScreen();
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_key_mask(int id, unsigned mask) {
    auto* inst = get(id); if (!inst || mask > 0xfff) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    inst->nds->SetKeyMask(mask);
    if (inst->recording) {
        if (inst->recordedInput.size() < 100000)
            inst->recordedInput.push_back({inst->nds->NumFrames - inst->recordStart, mask});
        else { inst->recording = false; inst->recordingOverflow = true; }
    }
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_key_mask_get(int id) {
    auto* inst = get(id); if (!inst) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    return static_cast<int>((inst->nds->KeyInput & 0x3ff) | ((inst->nds->KeyInput >> 6) & 0xc00));
}
EMSCRIPTEN_KEEPALIVE int web_input_record_start(int id) {
    auto* inst = get(id); if (!inst) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    inst->recordedInput.clear(); inst->recordStart = inst->nds->NumFrames;
    inst->recordingOverflow = false;
    inst->recording = true;
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_input_record_stop(int id) {
    auto* inst = get(id); if (!inst) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    inst->recording = false;
    return static_cast<int>(inst->recordedInput.size());
}
EMSCRIPTEN_KEEPALIVE int web_input_record_count(int id) {
    auto* inst = get(id); if (!inst) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    return static_cast<int>(inst->recordedInput.size());
}
EMSCRIPTEN_KEEPALIVE int web_input_record_overflow(int id) {
    auto* inst = get(id); if (!inst) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    return inst->recordingOverflow ? 1 : 0;
}
EMSCRIPTEN_KEEPALIVE int web_input_record_entry(int id, int index, unsigned* output) {
    auto* inst = get(id); if (!inst || !output) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    if (index < 0 || static_cast<size_t>(index) >= inst->recordedInput.size()) return -1;
    output[0] = inst->recordedInput[index].frame;
    output[1] = inst->recordedInput[index].mask;
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_input_schedule(int id, const InputEvent* events, int count) {
    auto* inst = get(id); if (!inst || !events || count < 0 || count > 100000) return -1;
    for (int n = 0; n < count; ++n) {
        if (events[n].mask > 0xfff || (n && events[n].frame < events[n - 1].frame)) return -2;
    }
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    inst->scheduledInput.assign(events, events + count);
    inst->scheduleStart = inst->nds->NumFrames;
    inst->scheduleOffset = 0;
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_input_schedule_stop(int id) {
    auto* inst = get(id); if (!inst) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    inst->scheduledInput.clear(); inst->scheduleOffset = 0;
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_save_state(int id, int slot) {
    auto* inst = get(id); if (!inst || slot < 0 || slot >= 10) return -1;
    bool suspended;
    {
        std::lock_guard<std::mutex> state(inst->debugMutex);
        suspended = inst->debugSuspended;
    }
    if (!suspended) {
        std::lock_guard<std::mutex> guard(inst->coreMutex);
        return saveStateLocked(inst, slot);
    }
    // A savestate taken inside RunFrame would lose its scheduler continuation.
    // Finish that frame without new traps, checkpoint at its real boundary,
    // and return only after the runner has committed the slot.
    {
        std::lock_guard<std::mutex> guard(inst->coreMutex);
        if (!inst->nds->CartInserted()) return -1;
        std::lock_guard<std::mutex> state(inst->debugMutex);
        inst->checkpointSlot = slot;
        inst->checkpointMode = true;
        inst->checkpointResult = -3;
        inst->checkpointRequested = true;
        inst->paused = false;
        inst->debugWake.notify_all();
    }
    std::unique_lock<std::mutex> state(inst->debugMutex);
    inst->debugWake.wait(state, [inst] { return !inst->checkpointRequested || !inst->alive.load(); });
    return inst->checkpointResult;
}
EMSCRIPTEN_KEEPALIVE int web_load_state(int id, int slot) {
    auto* inst = get(id); if (!inst || slot < 0 || slot >= 10) return -1;
    {
        std::lock_guard<std::mutex> guard(inst->coreMutex);
        if (inst->states[slot].empty()) return -1;
    }
    const bool stopped = abortSuspendedFrame(inst);
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    if (stopped) inst->nds->Start();
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
    const bool stopped = abortSuspendedFrame(inst);
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    if (stopped) inst->nds->Start();
    if (length >= 32 && !std::memcmp(data, "DeSmuME SState", 13)) {
        melonDS::Savestate rollback;
        if (!inst->nds->DoSavestate(&rollback) || rollback.Error) return -2;
        rollback.Finish();
        if (rollback.Error) return -2;
        bool hle = false;
        const int differences = melonDS::CompareDeSmuMEARM7BIOS(*inst->nds, data, length, hle);
        int result = melonDS::ImportDeSmuMEState(*inst->nds, data, length);
        if (result == 0) {
            inst->scheduledInput.clear(); inst->scheduleOffset = 0; inst->recording = false;
            inst->stepActive = false; inst->untilActive = false; inst->skipCpu = 0; inst->watchKind = 0;
            for (auto& trace : inst->callTrace) trace.clear();
            result = saveStateLocked(inst, slot) < 0 ? -2 : 0;
            if (result == 0) { inst->stateBiosDifferences = differences; inst->stateBiosHLE = hle; }
        }
        if (result < 0) {
            melonDS::Savestate restore(rollback.Buffer(), rollback.Length(), false);
            inst->nds->DoSavestate(&restore);
        }
        inst->completedFrames = inst->nds->NumFrames;
        publishFrame(inst);
        return result;
    }
    auto previous = std::move(inst->states[slot]);
    inst->states[slot].assign(data, data + length);
    const int result = loadStateLocked(inst, slot);
    if (result == 0) { inst->stateBiosDifferences = -1; inst->stateBiosHLE = false; }
    if (result < 0) inst->states[slot] = std::move(previous);
    return result;
}
EMSCRIPTEN_KEEPALIVE int web_state_bios_warning(int id, int field) {
    auto* inst = get(id); if (!inst) return -1;
    return field == 1 ? static_cast<int>(inst->stateBiosHLE) : inst->stateBiosDifferences;
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
EMSCRIPTEN_KEEPALIVE int web_prepare_virtual_ap(int id) {
    auto* inst = get(id); if (!inst) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    auto& firmware = inst->nds->SPI.GetFirmware();
    auto& points = firmware.GetAccessPoints();
    melonDS::Firmware::WifiAccessPoint* selected = nullptr;
    for (auto& point : points) {
        if (point.Status == melonDS::Firmware::AccessPointStatus::Normal && point.SSID[0]) { selected = &point; break; }
    }
    if (!selected) {
        points[0] = melonDS::Firmware::WifiAccessPoint(inst->nds->ConsoleType);
        points[0].UpdateChecksum();
        selected = &points[0];
    }
    inst->nds->Wifi.SetAccessPointSSID(selected->SSID, strnlen(selected->SSID, sizeof(selected->SSID)));
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_copy_frame(int id, melonDS::u8* destination, int capacity) {
    constexpr int kOneScreenBytes = 256 * 192 * 4;
    auto* inst = get(id); if (!inst || !destination || capacity < kOneScreenBytes * 2) return -1;
    std::lock_guard<std::mutex> guard(inst->videoMutex);
    if (!inst->videoValid) return -2;
    memcpy(destination, inst->video.data(), kOneScreenBytes * 2);
    return kOneScreenBytes * 2;
}
EMSCRIPTEN_KEEPALIVE int web_read_audio(int id, melonDS::s16* destination, int frames) {
    auto* inst = get(id); if (!inst || !destination || frames < 1 || frames > 4096) return -1;
    // SPU::ReadOutput owns AudioLock. The dispatcher serializes destruction.
    return inst->nds->SPU.ReadOutput(destination, frames);
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
EMSCRIPTEN_KEEPALIVE int web_net_backend(int id, int enabled) {
    auto* inst = get(id); if (!inst || (enabled != 0 && enabled != 1)) return -1;
    std::lock_guard<std::mutex> guard(inst->coreMutex);
    return melonDS::Platform::WebNetSetEnabled(id, enabled != 0);
}
EMSCRIPTEN_KEEPALIVE int web_net_backend_status(int id) {
    if (!get(id)) return -1;
    return melonDS::Platform::WebNetGetEnabled(id);
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

#include "workspace-native.h"
#include "packet-control-native.h"
