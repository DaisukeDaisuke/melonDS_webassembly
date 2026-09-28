// Included after port.cpp's entry points: shares the existing instance owners.
// This is the native part of the .mel workspace, not an alternative emulator.
namespace {
std::vector<melonDS::u8> workspaceCore, workspaceTransport;
template<class T> void workspaceVector(melonDS::Savestate& state, std::vector<T>& values, unsigned maximum) {
    unsigned count = values.size(); state.Var32(&count);
    if (count > maximum) { state.Error = true; return; }
    if (!state.Saving) values.resize(count);
    if (count) state.VarArray(values.data(), count * sizeof(T));
}
void workspaceTransportState(melonDS::Savestate& state) {
    state.Section("WTRN");
    unsigned version = 2, mask = 0;
    for (int id = 0; id < 16; ++id) if (get(id)) mask |= 1u << id;
    const unsigned expectedMask = mask;
    state.Var32(&version); state.Var32(&mask);
    if (version != 2 || mask != expectedMask) { state.Error = true; return; }
    for (auto& owner : instances) if (owner) {
        auto& inst = *owner;
        inst.nds->Wifi.DoTransportState(&state);
        {
            std::lock_guard<std::mutex> videoLock(inst.videoMutex);
            state.VarBool(&inst.videoValid);
            state.VarArray(inst.video.data(), inst.video.size());
        }
        workspaceVector(state, inst.save, 8 * 1024 * 1024);
        state.Var32(&inst.systemFiles);
        auto& firmware = inst.nds->GetFirmware();
        unsigned length = firmware.Length(); state.Var32(&length);
        if (length != 0x20000 && length != 0x40000 && length != 0x80000) { state.Error = true; return; }
        std::vector<melonDS::u8> image(length);
        if (state.Saving) std::memcpy(image.data(), firmware.Buffer(), length);
        state.VarArray(image.data(), length);
        if (!state.Saving && !state.Error) inst.nds->SetFirmware(melonDS::Firmware(image.data(), length));
        workspaceVector(state, inst.breakpoints, 4096);
        state.Var32(&inst.nextBreakpointId);
        unsigned count = inst.freezes.size(); state.Var32(&count);
        if (count > 4096) { state.Error = true; return; }
        if (!state.Saving) inst.freezes.resize(count);
        for (auto& freeze : inst.freezes) {
            state.VarArray(&freeze.cpu, sizeof(freeze.cpu)); state.Var32(&freeze.address);
            workspaceVector(state, freeze.bytes, 1024 * 1024);
        }
        workspaceVector(state, inst.recordedInput, 1000000);
        workspaceVector(state, inst.scheduledInput, 1000000);
        state.Var32(&inst.recordStart); state.Var32(&inst.scheduleStart);
        state.VarArray(&inst.scheduleOffset, sizeof(inst.scheduleOffset));
        state.VarBool(&inst.recording); state.VarBool(&inst.recordingOverflow);
        state.VarArray(&inst.skipCpu, sizeof(inst.skipCpu)); state.Var32(&inst.skipAddress);
        for (auto& lens : inst.callTrace) {
            unsigned lanes = lens.lanes.size(); state.Var32(&lanes);
            if (lanes > 128) { state.Error = true; return; }
            if (!state.Saving) lens.lanes.resize(lanes);
            state.VarArray(&lens.active, sizeof(lens.active)); state.Var32(&lens.nextId);
            for (auto& lane : lens.lanes) {
                state.Var32(&lane.id); state.Var32(&lane.lastSp); state.Var32(&lane.nowPc); state.Var32(&lane.cpsr);
                workspaceVector(state, lane.frames, 1024);
            }
        }
        if (state.Error) return;
    }
    localMP.DoTransportState(&state, melonDS::Platform::WebSemaphoreState);
    melonDS::Platform::WebNetDoTransportState(&state);
}
bool workspaceLock(std::vector<std::unique_lock<std::mutex>>& locks) {
    for (const auto& owner : instances) if (owner && !owner->paused.load()) return false;
    for (const auto& owner : instances) if (owner) locks.emplace_back(owner->coreMutex);
    return true;
}
}
extern "C" {
EMSCRIPTEN_KEEPALIVE int web_workspace_state_capture(int id) {
    auto* inst = get(id); if (!inst || !inst->paused.load()) return -1;
    std::vector<melonDS::u8> prior;
    { std::lock_guard<std::mutex> lock(inst->coreMutex); prior.swap(inst->states[0]); }
    const int result = web_save_state(id, 0);
    { std::lock_guard<std::mutex> lock(inst->coreMutex);
      workspaceCore = std::move(inst->states[0]); inst->states[0] = std::move(prior); }
    return result < 0 ? result : static_cast<int>(workspaceCore.size());
}
EMSCRIPTEN_KEEPALIVE const melonDS::u8* web_workspace_state_pointer() { return workspaceCore.data(); }
EMSCRIPTEN_KEEPALIVE int web_workspace_slot_restore(int id, int slot, const melonDS::u8* data, int length) {
    auto* inst = get(id);
    if (!inst || !inst->paused || slot < 0 || slot >= 10 || length < 0 || length > 64 * 1024 * 1024 || (!data && length)) return -1;
    std::lock_guard<std::mutex> lock(inst->coreMutex);
    if (length) inst->states[slot].assign(data, data + length); else inst->states[slot].clear();
    return 0;
}
EMSCRIPTEN_KEEPALIVE int web_system_size(int id, int kind) {
    auto* inst = get(id); if (!inst) return -1;
    if (kind == 7) return inst->nds->GetARM7BIOS().size();
    if (kind == 9) return inst->nds->GetARM9BIOS().size();
    if (kind == 0) return inst->nds->GetFirmware().Length();
    return -1;
}
EMSCRIPTEN_KEEPALIVE const melonDS::u8* web_system_pointer(int id, int kind) {
    auto* inst = get(id); if (!inst) return nullptr;
    if (kind == 7) return inst->nds->GetARM7BIOS().data();
    if (kind == 9) return inst->nds->GetARM9BIOS().data();
    if (kind == 0) return inst->nds->GetFirmware().Buffer();
    return nullptr;
}
EMSCRIPTEN_KEEPALIVE int web_transport_capture() {
    std::vector<std::unique_lock<std::mutex>> locks;
    if (!workspaceLock(locks)) return -1;
    melonDS::Savestate state(1024 * 1024); workspaceTransportState(state); state.Finish();
    if (state.Error) return -2;
    const auto* bytes = static_cast<const melonDS::u8*>(state.Buffer());
    workspaceTransport.assign(bytes, bytes + state.Length());
    return workspaceTransport.size();
}
EMSCRIPTEN_KEEPALIVE const melonDS::u8* web_transport_pointer() { return workspaceTransport.data(); }
EMSCRIPTEN_KEEPALIVE int web_transport_import(melonDS::u8* bytes, int length) {
    if (!bytes || length < 16 || length > 64 * 1024 * 1024) return -1;
    std::vector<std::unique_lock<std::mutex>> locks;
    if (!workspaceLock(locks)) return -1;
    melonDS::Savestate state(bytes, length, false); workspaceTransportState(state);
    return state.Error ? -2 : 0;
}
}
