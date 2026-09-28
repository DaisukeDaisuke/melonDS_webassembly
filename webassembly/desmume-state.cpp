// DeSmuME v12 frame-boundary state import. The two cores' internal caches are
// rebuilt from hardware state; no game addresses or game-specific patches are used.
#include "desmume-state.h"
#include "wall-clock.h"
#include "NDS.h"
#include "ARM.h"
#include "GPU.h"
#include "GPU3D.h"
#include "SPU.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

namespace melonDS {
namespace {
struct Bytes {
    const u8* p = nullptr; size_t n = 0; bool* valid = nullptr;
    Bytes part(size_t offset, size_t size) const {
        if (offset > n || size > n - offset) { if (valid) *valid = false; return {nullptr, 0, valid}; }
        return {p + offset, size, valid};
    }
    u64 value(size_t offset, size_t width) const {
        const auto b = part(offset, width); u64 v = 0;
        if (b.p) for (size_t i = 0; i < width; i++) v |= u64(b.p[i]) << (i * 8);
        return v;
    }
    u8 b(size_t i = 0) const { return value(i, 1); }
    u16 h(size_t i = 0) const { return value(i, 2); }
    u32 w(size_t i = 0) const { return value(i, 4); }
    u64 q(size_t i = 0) const { return value(i, 8); }
    float f(size_t i = 0) const { u32 v = w(i); float out; memcpy(&out, &v, 4); return out; }
    void copy(void* target, size_t size, size_t offset = 0) const {
        const auto b = part(offset, size); if (b.p) memcpy(target, b.p, size);
    }
};
struct Reader {
    Bytes bytes; size_t pos = 0;
    Bytes take(size_t n) { const auto b = bytes.part(pos, n); pos += n; return b; }
    u8 b() { return take(1).b(); } u16 h() { return take(2).h(); }
    u32 w() { return take(4).w(); } u64 q() { return take(8).q(); }
};
struct Tags {
    std::unordered_map<std::string, Bytes> fields; bool* valid;
    explicit Tags(Bytes data) : valid(data.valid) {
        Reader r{data};
        while (*valid && r.pos < data.n) {
            auto tag = r.take(4); const u64 width = r.w(), count = r.w();
            if (!tag.p || width * count > data.n || fields.size() > 1024) { *valid = false; break; }
            auto value = r.take(size_t(width * count));
            if (tag.p && !fields.emplace(std::string((const char*)tag.p, 4), value).second) *valid = false;
        }
    }
    Bytes get(const std::string& name) const {
        auto it = fields.find(name); if (it != fields.end()) return it->second;
        *valid = false; return {nullptr, 0, valid};
    }
    u32 number(const std::string& name) const {
        auto b = get(name); return b.value(0, std::min<size_t>(4, b.n));
    }
};
struct SavedDMA { Bytes b; };
struct SavedVertex { Vertex vertex {}; };
struct SavedPolygon { u32 count, attr, texture, palette, viewport; u16 indices[4]; };
void color15(u32 value, u8* target) {
    for (int i = 0; i < 3; i++) target[i] = (value >> (5 * i)) & 31;
}
void viewport(GPU3D& g, u32 v) {
    g.Viewport[0] = v & 255; g.Viewport[1] = (191 - ((v >> 8) & 255)) & 255;
    g.Viewport[2] = (v >> 16) & 255; g.Viewport[3] = (191 - (v >> 24)) & 255;
    g.Viewport[4] = (g.Viewport[2] - g.Viewport[0] + 1) & 511;
    g.Viewport[5] = (g.Viewport[1] - g.Viewport[3] + 1) & 255;
}
}

int ImportDeSmuMEState(NDS& n, const u8* data, size_t length) {
    bool valid = true;
    Bytes source{data, length, &valid};
    if (length < 32 || memcmp(data, "DeSmuME SState", 13) || source.w(16) != 12
        || source.w(28) != 0xffffffff || source.w(24) != length - 32) return -20;
    std::unordered_map<u32, Bytes> chunks;
    Reader body{source.part(32, length - 32)};
    while (valid && body.pos < body.bytes.n) {
        u32 id = body.w(); if (id == 0xffffffff) break;
        u32 size = body.w(); auto chunk = body.take(size);
        if (chunks.size() >= 256 || !chunks.emplace(id, chunk).second) return -20;
    }
    auto chunk = [&](u32 id) -> Bytes {
        auto it = chunks.find(id); if (it != chunks.end()) return it->second;
        valid = false; return {nullptr, 0, &valid};
    };
    Tags cpu9(chunk(1)), cpu7(chunk(2)), memory(chunk(4)), nds(chunk(5)), mmu(chunk(60));
    Tags gx(chunk(90)), movie(chunk(100)), rtc(chunk(120)), rom(chunk(130));
    if (!valid) return -20;
    auto header = rom.get("GINF");
    if (!n.GetNDSCart() || header.n < 512
        || memcmp(header.p, n.GetNDSCart()->GetROM(), 0x160)) return -21;
    // Mid-command/card/DMA snapshots have core-specific continuations. Refuse
    // them instead of silently dropping a pending transaction.
    if (nds.number("_VCT") != 262 || gx.number("GINB") || gx.number("GFSZ") || gx.number("GPSZ")
        || mmu.number("GC0T") || mmu.number("GC1T") || mmu.number("MDV1") || mmu.number("MSQ1")) return -22;
    auto io9 = memory.get("9REG"), io7 = mmu.get("M7RG");
    if (io9.n != 0x2000 || io7.n < 0x1000 || memory.get("WRAM").n != 0x400000) return -20;
    Reader time{chunk(51)};
    if (time.w() != 4) return -23;
    const u64 ticks = time.q(), ticks9 = time.q(), ticks7 = time.q();
    Reader cp15{chunk(3)};
    if (cp15.w() != 1) return -23;
    u32 cp[27]; for (auto& v : cp) v = cp15.w();
    Reader device{chunk(61)};
    if (device.w() != 8 || device.w() != 5) return -23;
    device.w(); const u32 backupCommand = device.w();
    device.take(12);
    const auto save = device.take(device.w());
    device.take(device.w()); device.take(15);
    if (backupCommand || save.n > 16 * 1024 * 1024 || device.w() != 1) return -22;
    device.take(5);
    std::array<SavedDMA, 8> dma;
    for (auto& d : dma) {
        d.b = device.take(57);
        if (d.b.w() != 1 || d.b.w(29) || d.b.w(33)) return -22;
    }
    // MMU v8 ends with [u32 firmware size][firmware bytes]. The radio's
    // calibration and the game's cached RF setup must come from that same
    // image, not from the frontend's independently generated firmware.
    Bytes firmware{nullptr, 0, &valid};
    const auto devices = chunk(61);
    for (size_t size : {size_t(0x20000), size_t(0x40000), size_t(0x80000)}) {
        if (devices.n >= size + 4 && devices.w(devices.n - size - 4) == size) {
            firmware = devices.part(devices.n - size, size); break;
        }
    }
    if (!firmware.p) return -23;
    Reader drawing{chunk(91)};
    if (drawing.w() != 4) return -23;
    const u32 vertexCount = drawing.w();
    if (vertexCount > 6144) return -24;
    std::vector<SavedVertex> vertices(vertexCount);
    for (auto& v : vertices) {
        const auto b = drawing.take(39);
        for (int j = 0; j < 4; j++) {
            const double position = double(b.f(j * 4)) * 4096.0;
            if (!std::isfinite(position) || position < -2147483648.0 || position > 2147483647.0) return -24;
            v.vertex.Position[j] = s32(std::llround(position));
        }
        for (int j = 0; j < 2; j++) {
            float uv = b.f(16 + j * 4);
            if (!std::isfinite(uv) || uv < -32768 || uv > 32767) return -24;
            v.vertex.TexCoords[j] = s16(std::lround(uv * 16));
        }
        for (int j = 0; j < 3; j++) v.vertex.Color[j] = (u32(b.b(24 + j)) << 12) + 0xfff;
        v.vertex.Clipped = false;
    }
    const u32 polygonCount = drawing.w();
    if (polygonCount > 2048) return -24;
    std::vector<SavedPolygon> polygons(polygonCount);
    for (auto& p : polygons) {
        auto b = drawing.take(36); p.count = b.w();
        if (p.count != 3 && p.count != 4) return -24;
        for (u32 i = 0; i < 4; i++) {
            p.indices[i] = b.h(4 + 2 * i);
            if (i < p.count && p.indices[i] >= vertexCount) return -24;
        }
        p.attr = b.w(12); p.texture = b.w(16); p.palette = b.w(20); p.viewport = b.w(24);
    }
    const u32 projSP = drawing.w(); const auto projStack = drawing.take(64);
    const u32 posSP = drawing.w(); const auto posStack = drawing.take(32 * 64);
    drawing.w(); const auto vecStack = drawing.take(32 * 64);
    const u32 texSP = drawing.w(); const auto texStack = drawing.take(64);
    // Version 4 ends with the four transformed light and half vectors.
    const auto lightState = chunk(91).part(chunk(91).n - 128, 128);
    Reader sound{chunk(8)};
    if (sound.w() != 7) return -23;
    std::array<Bytes, 16> channels;
    for (auto& c : channels) c = sound.take(56);
    sound.take(8); const auto master = sound.take(8);
    std::array<Bytes, 2> captures;
    for (auto& c : captures) c = sound.take(28);
    Reader screen{chunk(7)};
    if (screen.w() != 2) return -23;
    const auto display = screen.take(256 * 192 * 4);
    const auto affine = screen.take(32);
    if (!valid) return -20;

    // Start from the core's own reset wiring, then replace hardware contents.
    // Native scheduled callbacks/renderer objects are retained, not foreign pointers.
    n.Stop(); n.SetFirmware(Firmware(firmware.p, firmware.n));
    n.Reset(); n.SetupDirectBoot("web.nds");
    initializeWallClock(n);
    memory.get("WRAM").copy(n.MainRAM, 0x400000);
    memory.get("ITCM").copy(n.ARM9->ITCM, 0x8000);
    memory.get("DTCM").copy(n.ARM9->DTCM, 0x4000);
    // M7ER is the ARM7's private 64 KiB WRAM. M7WI is Wi-Fi RAM,
    // despite its name; using it erases the ARM7 code on state import.
    mmu.get("M7ER").copy(n.ARM7WRAM, 0x10000);
    mmu.get("MSWI").copy(n.SharedWRAM, 0x8000);
    const auto arm7Bios = mmu.get("M7BI");
    // DeSmuME's HLE BIOS uses self-branches at the exception vectors; its
    // SWIs are intercepted outside that byte array. Do not replace melonDS'
    // executable FreeBIOS with this placeholder (SWI would loop at 0x08).
    const bool hlePlaceholder = arm7Bios.w(0) == 0xeafffffeu
        && arm7Bios.w(4) == 0xeafffffeu && arm7Bios.w(8) == 0xeafffffeu;
    if (!hlePlaceholder) arm7Bios.copy(n.ARM7BIOS.data(), n.ARM7BIOS.size());
    if (save.n) n.SetNDSSave(save.p, save.n);
    memory.get("VMEM").copy(n.GPU.Palette, sizeof(n.GPU.Palette));
    memory.get("OAMS").copy(n.GPU.OAM, sizeof(n.GPU.OAM));
    const auto vram = memory.get("LCDM"); size_t vramOffset = 0;
    for (int i = 0; i < 9; i++) {
        vram.copy(n.GPU.VRAM[i], n.GPU.VRAMMask[i] + 1, vramOffset);
        vramOffset += n.GPU.VRAMMask[i] + 1;
        memset(n.GPU.VRAMDirty[i].Data, 0xff, sizeof(n.GPU.VRAMDirty[i].Data));
    }
    n.ARM9->CP15Write(0x100, cp[3]);
    n.ARM9->PU_DataCacheable = cp[4]; n.ARM9->PU_CodeCacheable = cp[5]; n.ARM9->PU_DataCacheWrite = cp[6];
    n.ARM9->PU_DataRW = cp[8]; n.ARM9->PU_CodeRW = cp[9];
    std::copy(cp + 10, cp + 18, n.ARM9->PU_Region);
    n.ARM9->ITCMSetting = cp[21];
    // DeSmuME masks DTCMRegion with 0x0FFFF000 on MCR, discarding
    // the size field, and always maps its 16 KiB DTCM. Restore that size;
    // using the saved base as a hardware register maps only 4 KiB here.
    n.ARM9->DTCMSetting = (cp[22] & 0xfffff000u) | (5u << 1);
    n.ARM9->TraceProcessID = cp[23];
    n.ARM9->UpdateITCMSetting(); n.ARM9->UpdateDTCMSetting(); n.ARM9->UpdatePURegions(true);
    n.ARM9->ICacheInvalidateAll();
    // DeSmuME stores POWCNT in nds.power1/power2, not ARMx_REG[0x304].
    // Enable the 2D engines before their register writes, which are ignored
    // by melonDS when the corresponding engine is powered off.
    const u16 power9 = (nds.number("_P00") ? 1 : 0) | (nds.number("_P01") ? 2 : 0)
        | (nds.number("_P02") ? 4 : 0) | (nds.number("_P03") ? 8 : 0)
        | (nds.number("_P04") ? 0x200 : 0) | (nds.number("_P05") ? 0x8000 : 0);
    const u16 power7 = (nds.number("_P06") ? 1 : 0) | (nds.number("_P07") ? 2 : 0);
    n.ARM9IOWrite16(0x04000304, power9);
    n.ARM7IOWrite16(0x04000304, power7);
    for (int i = 0; i < 9; i++) {
        const u32 off = 0x240 + i + (i >= 7 ? 1 : 0);
        n.ARM9IOWrite8(0x04000000 + off, io9.b(off));
    }
    n.ARM9IOWrite8(0x04000247, mmu.number("MWRA"));
    n.SetExMemCnt(0, io9.h(0x204), 0xffff); n.SetExMemCnt(1, io7.h(0x204), 0xffff);
    n.PostFlag9 = io9.b(0x300); n.PostFlag7 = io7.b(0x300);
    n.ARM7BIOSProt = io7.h(0x308);
    n.IPCSync9 = io9.h(0x180); n.IPCSync7 = io7.h(0x180);
    // DeSmuME persists the dynamic empty/full status bits in ARMx_REG.
    // melonDS computes those bits from FIFO state on every read; retaining
    // bit 8 here makes a nonempty receive FIFO appear permanently empty.
    n.IPCFIFOCnt9 = io9.h(0x184) & 0xc404; n.IPCFIFOCnt7 = io7.h(0x184) & 0xc404;
    n.IPCFIFO9.Clear(); n.IPCFIFO7.Clear();
    for (int i = 0; i < 2; i++) {
        auto& fifo = i ? n.IPCFIFO7 : n.IPCFIFO9; // Both cores store the sender's FIFO.
        const std::string prefix = i ? "F1" : "F0";
        const u32 head = mmu.number(prefix + "TH"), count = mmu.number(prefix + "SZ");
        auto bytes = mmu.get(prefix + "BF");
        if (head >= 16 || count > 16) return -20;
        // Preserve the last-word-on-empty behaviour as well as queued entries.
        fifo.Write(0); fifo.Read(); // DeSmuME's empty FIFO read returns zero, not a stale ring entry.
        for (u32 j = 0; j < count; j++) fifo.Write(bytes.w(((head + j) & 15) * 4));
        n.IME[i] = mmu.get("MIME").w(i * 4); n.IE[i] = mmu.get("MIE_").w(i * 4);
        n.IF[i] = mmu.get("MIF_").w(i * 4) | mmu.get("MIFP").w(i * 4);
        n.KeyCnt[i] = (i ? io7 : io9).h(0x132);
    }
    n.KeyInput = (io9.h(0x130) & 0x3ff) | ((io7.h(0x136) & 3) << 10) | (io7.h(0x136) << 16);
    n.RCnt = io7.h(0x134);
    n.DivCnt = io9.h(0x280);
    io9.copy(n.DivNumerator, 8, 0x290); io9.copy(n.DivDenominator, 8, 0x298);
    mmu.get("MDV2").copy(n.DivQuotient, 8); mmu.get("MDV3").copy(n.DivRemainder, 8);
    n.SqrtCnt = io9.h(0x2b0); io9.copy(n.SqrtVal, 8, 0x2b8); n.SqrtRes = mmu.number("MSQ2");
    for (int cpu = 0; cpu < 2; cpu++) {
        auto& e = cpu ? n.GPU.GPU2D_B : n.GPU.GPU2D_A;
        const u32 base = cpu * 0x1000;
        e.Write32(base, io9.w(base));
        for (u32 offset = 8; offset <= 0x54; offset += 2) {
            if ((offset >= 0x28 && offset <= 0x2e) || (offset >= 0x38 && offset <= 0x3e)
                || offset == 0x4e) continue;
            e.Write16(base + offset, io9.h(base + offset));
        }
        for (u32 off : {0x28u, 0x2cu, 0x38u, 0x3cu}) e.Write32(base + off, io9.w(base + off));
        for (int j = 0; j < 2; j++) {
            e.BGXRefInternal[j] = affine.w(cpu * 16 + j * 8);
            e.BGYRefInternal[j] = affine.w(cpu * 16 + j * 8 + 4);
        }
        e.DispCntLatch[0] = e.DispCntLatch[1] = e.DispCntLatch[2] = e.DispCnt;
        e.LayerEnable = (e.DispCnt >> 8) & 15; e.OBJEnable = e.DispCnt & (1 << 12);
        e.ForcedBlank = e.DispCnt & (1 << 7);
        n.GPU.DispStat[cpu] = (cpu ? io7 : io9).h(4);
    }
    n.GPU.MasterBrightnessA = io9.h(0x6c); n.GPU.MasterBrightnessB = io9.h(0x106c);
    n.GPU.CaptureCnt = io9.w(0x64); n.GPU.VCount = 262; n.GPU.TotalScanlines = 263;

    auto& g = n.GPU.GPU3D;
    g.DispCnt = gx.number("GCTL"); g.AlphaRefVal = gx.number("GSAR"); g.AlphaRef = g.AlphaRefVal;
    g.ClearAttr1 = gx.number("GSCC"); g.ClearAttr2 = (io9.h(0x354) & 0x7fff) | (io9.w(0x356) << 16);
    g.FogColor = io9.w(0x358); g.FogOffset = io9.h(0x35c);
    io9.copy(g.EdgeTable, 16, 0x330); io9.copy(g.FogDensityTable, 32, 0x360); io9.copy(g.ToonTable, 64, 0x380);
    g.NumVertices = 0; g.NumPolygons = 0; g.NumOpaquePolygons = 0;
    for (const auto& p : polygons) {
        for (u32 i = 0; i < p.count; i++) g.TempVertexBuffer[i] = vertices[p.indices[i]].vertex;
        g.PolygonMode = p.count == 4 ? 1 : 0; g.CurPolygonAttr = p.attr;
        g.TexParam = p.texture; g.TexPalette = p.palette; g.LastStripPolygon = nullptr;
        viewport(g, p.viewport);
        if (g.NumVertices + p.count > 6144) return -24;
        g.SubmitPolygon();
    }
    g.FlushAttributes = gx.number("GSAF") & 3; g.FlushRequest = 1;
    g.VBlank(); g.RenderFrameIdentical = false;
    auto matrices = gx.get("GMCU");
    matrices.copy(g.ProjMatrix, 64); matrices.copy(g.PosMatrix, 64, 64);
    matrices.copy(g.VecMatrix, 64, 128); matrices.copy(g.TexMatrix, 64, 192);
    projStack.copy(g.ProjMatrixStack, 64); posStack.copy(g.PosMatrixStack, 2048);
    vecStack.copy(g.VecMatrixStack, 2048); texStack.copy(g.TexMatrixStack, 64);
    g.ProjMatrixStackPointer = projSP; g.PosMatrixStackPointer = posSP; g.TexMatrixStackPointer = texSP;
    g.MatrixMode = gx.number("GMOD"); g.ClipMatrixDirty = true;
    g.PolygonAttr = gx.number("GPAP"); g.CurPolygonAttr = gx.number("GPAT");
    g.TexParam = gx.number("GTFM"); g.TexPalette = gx.number("GTPA"); viewport(g, gx.number("GSVP"));
    for (int j = 0; j < 3; j++) g.VertexColor[j] = gx.get("GCOL").b(j);
    color15(gx.number("GMDI"), g.MatDiffuse); color15(gx.number("GMAM"), g.MatAmbient);
    color15(gx.number("GMSP"), g.MatSpecular); color15(gx.number("GMEM"), g.MatEmission);
    g.UseShininessTable = gx.number("GMSP") & 0x8000;
    gx.get("GSSU").copy(g.ShininessTable, 128);
    for (int l = 0; l < 4; l++) {
        color15(gx.get("GLCO").w(l * 4), g.LightColor[l]);
        for (int j = 0; j < 3; j++) g.LightDirection[l][j] = -s32(lightState.w(l * 16 + j * 4)) / 8;
        const s32 den = g.LightDirection[l][2] + 512;
        g.SpecRecip[l] = den ? (1 << 18) / den : 0;
    }
    g.RawTexCoords[0] = gx.number("G_S_"); g.RawTexCoords[1] = gx.number("G_T_");
    g.TexCoords[0] = gx.number("GL_S"); g.TexCoords[1] = gx.number("GL_T");
    g.VertexNum = g.VertexNumInPoly = g.NumConsecutivePolygons = 0; g.LastStripPolygon = nullptr;
    g.CycleCount = 0; g.VertexPipeline = g.NormalPipeline = g.PolygonPipeline = 0;
    g.VertexSlotCounter = 0; g.VertexSlotsFree = 1;

    for (int i = 0; i < 8; i++) {
        auto& d = n.DMAs[i]; auto b = dma[i].b; const auto io = i < 4 ? io9 : io7;
        d.SrcAddr = b.w(49); d.DstAddr = b.w(53);
        d.WriteCnt(io.w(0xb8 + (i & 3) * 12));
        d.CurSrcAddr = b.w(17); d.CurDstAddr = b.w(21);
        d.RemCount = 0; d.IterCount = 0; d.Running = 0;
        d.InProgress = false; d.Executing = false; d.Stall = false;
    }
    for (int i = 0; i < 4; i++) n.DMA9Fill[i] = io9.w(0xe0 + 4 * i);
    // DeSmuME timestamps use the 67MHz clock, melonDS system/ARM7 use 33MHz.
    const u64 system = ticks >> 1;
    // Inactive periodic events retain their last timestamp. In particular LCD
    // is inactive between frames, and StartScanline schedules relative to it.
    // Shift those anchors too; otherwise the first target jumps back to reset
    // time and neither CPU executes until the scheduler catches up.
    for (u32 i = 0; i < Event_MAX; i++) n.SchedList[i].Timestamp += system;
    n.SysTimestamp = system; n.ARM9Timestamp = ticks9; n.ARM7Timestamp = ticks7 >> 1;
    n.ARM9Target = ticks9; n.ARM7Target = ticks7 >> 1;
    n.TimerTimestamp[0] = ticks9 >> 1; n.TimerTimestamp[1] = ticks7 >> 1;
    n.FrameStartTimestamp = system; n.LastSysClockCycles = 560190;
    g.Timestamp = system;
    n.TimerCheckMask[0] = n.TimerCheckMask[1] = 0;
    for (int i = 0; i < 8; i++) {
        auto& t = n.Timers[i]; const auto io = i < 4 ? io9 : io7;
        t.Reload = mmu.get("MTRL").h(i * 2); t.Cnt = io.h(0x102 + (i & 3) * 4);
        const u32 shifts[4] = {0, 6, 8, 10}; t.CycleShift = 10 - shifts[t.Cnt & 3];
        u64 counter = mmu.get("MTIM").h(i * 2); u32 fraction = 0;
        if ((t.Cnt & 0x84) == 0x80) {
            const u32 shift = shifts[t.Cnt & 3] + 1;
            const u64 last = nds.get("_TCY").q(i * 8), delta = ticks >= last ? ticks - last : 0;
            counter += delta >> shift;
            if (counter >= 65536) counter = t.Reload + (counter - 65536) % (65536 - t.Reload);
            fraction = ((delta & ((1u << shift) - 1)) * 1024) >> shift;
            n.TimerCheckMask[i >> 2] |= 1 << (i & 3);
        }
        t.Counter = (u32(counter) << 10) | fraction;
    }
    for (int i = 0; i < 16; i++) {
        const auto b = channels[i]; auto& c = n.SPU.Channels[i];
        const u32 format = b.b(10), state = b.b(11), divisor = b.b(5);
        const u32 control = b.b(4) | ((divisor == 4 ? 3 : divisor) << 8) | (b.b(6) << 15)
            | (b.b(7) << 16) | (b.b(8) << 24) | (b.b(9) << 27) | (format << 29) | (u32(state != 0) << 31);
        c.SetSrcAddr(b.w(13)); c.SetTimerReload(b.h(17)); c.SetLoopPos(b.h(19)); c.SetLength(b.w(21));
        c.SetCnt(control); c.KeyOn = false; c.Pos = s32(b.w(29)) - 1;
        c.Timer = c.TimerReload + u32((u64(b.w(25)) * (65536 - c.TimerReload)) >> 32);
        c.CurSample = s16(b.h(41 + ((b.b(12) + 3) & 3) * 2));
        c.PrevSample[0] = c.PrevSample[1] = c.PrevSample[2] = c.CurSample;
        c.NoiseVal = b.h(53); c.ADPCMIndex = std::min<u32>(88, b.w(49)); c.ADPCMVal = c.CurSample;
        c.FIFOReadPos = c.FIFOWritePos = c.FIFOLevel = 0;
        u32 nextByte = 0;
        if (c.Pos >= 0) nextByte = format == 0 ? c.Pos + 1 : format == 1 ? (c.Pos + 1) * 2 : (c.Pos / 2 + 1);
        c.FIFOReadOffset = nextByte & ~3u;
        if (format != 3 && state && c.LoopPos + c.Length >= 4) {
            c.FIFO_BufferData(); c.FIFO_BufferData();
            c.FIFOReadPos = nextByte & 3; c.FIFOLevel -= std::min(c.FIFOLevel, nextByte & 3);
        }
        if (format == 2) {
            const u32 h = n.ARM7Read32(c.SrcAddr);
            c.ADPCMValLoop = s16(h); c.ADPCMIndexLoop = std::min<u32>(88, (h >> 16) & 127);
            for (u32 sample = 8; sample <= c.LoopPos * 2 && sample < 0x200000; sample++) {
                const u8 nibble = (n.ARM7Read8(c.SrcAddr + (sample >> 1)) >> ((sample & 1) * 4)) & 15;
                const u32 step = SPUChannel::ADPCMTable[c.ADPCMIndexLoop];
                const int diff = (step >> 3) + ((nibble & 1) ? step >> 2 : 0)
                    + ((nibble & 2) ? step >> 1 : 0) + ((nibble & 4) ? step : 0);
                c.ADPCMValLoop = std::clamp(c.ADPCMValLoop + ((nibble & 8) ? -diff : diff), -32767, 32767);
                c.ADPCMIndexLoop = std::clamp(c.ADPCMIndexLoop + SPUChannel::ADPCMIndexTable[nibble & 7], 0, 88);
            }
            c.ADPCMCurByte = n.ARM7Read8(c.SrcAddr + std::max(0, c.Pos) / 2);
        }
    }
    n.SPU.Write16(0x04000500, master.b() | (master.b(1) << 8) | (master.b(2) << 10)
        | (master.b(3) << 12) | (master.b(4) << 13) | (master.b(5) << 15));
    n.SPU.SetBias(master.h(6));
    for (int i = 0; i < 2; i++) {
        const auto b = captures[i]; auto& c = n.SPU.Capture[i];
        c.DstAddr = b.w(5); c.Length = b.h(9) * 4; c.Pos = (b.w(12) - c.DstAddr) / (b.b(3) ? 1 : 2);
        c.Cnt = b.b(0) | (b.b(1) << 1) | (b.b(2) << 2) | (b.b(3) << 3) | (b.b(4) << 7);
        c.TimerReload = n.SPU.Channels[i ? 3 : 1].TimerReload; c.Timer = c.TimerReload;
    }
    RTC::StateData clock; n.RTC.GetState(clock);
    clock.StatusReg1 = rtc.number("R000"); clock.StatusReg2 = rtc.number("R010");
    clock.ClockAdjust = rtc.number("R020"); clock.FreeReg = rtc.number("R030"); n.RTC.SetState(clock);
    auto restoreCPU = [&](ARM& arm, const Tags& tags, char digit) {
        auto key = [&](const char* tail) { return std::string(1, digit) + tail; };
        tags.get(key("REG")).copy(arm.R, sizeof(arm.R)); arm.CPSR = tags.number(key("CPS"));
        struct Bank { u32* r; const char* d; const char* e; const char* s; u32 mode; };
        Bank banks[] = {{arm.R_SVC,"DSV","ESV","SVC",0x13}, {arm.R_ABT,"DAB","EAB","ABT",0x17},
            {arm.R_UND,"DUN","EUN","UND",0x1b}, {arm.R_IRQ,"DIR","EIR","IRQ",0x12}};
        for (auto& bank : banks) {
            const bool active = (arm.CPSR & 31) == bank.mode;
            bank.r[0] = tags.number(key(active ? "DUS" : bank.d));
            bank.r[1] = tags.number(key(active ? "EUS" : bank.e)); bank.r[2] = tags.number(key(bank.s));
        }
        const char* fiq[] = {"8FI","9FI","AFI","BFI","CFI","DFI","EFI","FIQ"};
        for (int j = 0; j < 8; j++) arm.R_FIQ[j] = tags.number(key(fiq[j]));
        arm.Halted = (tags.number(key("FRZ")) & 1) ? 1 : 0;
        arm.IRQ = (n.IME[arm.Num] && (n.IE[arm.Num] & n.IF[arm.Num])) ? 1 : 0;
        arm.IdleLoop = 0; arm.Cycles = 0;
        arm.JumpTo(tags.number(key("INA")) | ((arm.CPSR & 0x20) ? 1 : 0));
    };
    n.ARM9->PU_Map = (cpu9.number("9CPS") & 31) == 0x10 ? n.ARM9->PU_UserMap : n.ARM9->PU_PrivMap;
    restoreCPU(*n.ARM9, cpu9, '9'); restoreCPU(*n.ARM7, cpu7, '7');
    n.NumFrames = movie.number("FRAC"); n.NumLagFrames = movie.number("LAGC");
    n.CPUStop = 0; n.CurCPU = 0; n.Running = true; n.RunningGame = true;
    void* top = nullptr; void* bottom = nullptr;
    if (n.GPU.GetFramebuffers(&top, &bottom) && top && bottom) {
        for (int screenId = 0; screenId < 2; screenId++) {
            auto* pixels = static_cast<u32*>(screenId ? bottom : top);
            for (int i = 0; i < 256 * 192; i++) {
                const u32 p = display.h((screenId * 256 * 192 + i) * 2);
                const u32 r = (p & 31) * 255 / 31, g = ((p >> 5) & 31) * 255 / 31, b = ((p >> 10) & 31) * 255 / 31;
                pixels[i] = 0xff000000 | (r << 16) | (g << 8) | b;
            }
        }
    }
    return valid ? 0 : -20;
}
}
