// SPDX-License-Identifier: GPL-2.0-or-later
// SP-lane selection adapted from DeSmuME wasm-port.cpp; per-instance/CPU state.
#pragma once
#include <algorithm>
#include <cstddef>
#include <vector>
template<class Frame> struct CallStackLens {
    struct Lane { unsigned id, lastSp, nowPc, cpsr; std::vector<Frame> frames; };
    std::vector<Lane> lanes;
    size_t active = 0;
    unsigned nextId = 1;
    static unsigned distance(unsigned a, unsigned b) { return a > b ? a - b : b - a; }
    void clear() { lanes.clear(); active = 0; nextId = 1; }
    size_t select(unsigned sp, unsigned pc, unsigned cpsr) {
        size_t best = lanes.size(); unsigned delta = ~0u;
        for (size_t n = 0; n < lanes.size(); ++n) {
            auto& lane = lanes[n];
            if ((lane.cpsr & 31) != (cpsr & 31)) continue;
            const unsigned reference = lane.frames.empty() ? lane.lastSp : lane.frames.back().sp;
            const unsigned diff = distance(reference, sp);
            if (diff <= 0x2000 && diff < delta) { best = n; delta = diff; }
        }
        if (best == lanes.size()) { lanes.push_back({nextId++, sp, pc, cpsr, {}}); best = lanes.size() - 1; }
        active = best;
        if (lanes.size() > 128) { const size_t drop = active == 0 ? 1 : 0; lanes.erase(lanes.begin() + drop); if (active > drop) --active; }
        auto& lane = lanes[active]; lane.lastSp = sp; lane.nowPc = pc; lane.cpsr = cpsr;
        return active;
    }
    void tick(unsigned sp, unsigned pc, unsigned cpsr) {
        if (lanes.empty() || active >= lanes.size() || (lanes[active].cpsr & 31) != (cpsr & 31) || distance(lanes[active].lastSp, sp) > 0x2000) select(sp, pc, cpsr);
        auto& lane = lanes[active]; lane.lastSp = sp; lane.nowPc = pc; lane.cpsr = cpsr;
    }
    void call(Frame frame) {
        auto& lane = lanes[select(frame.sp, frame.callee, frame.cpsr)];
        if (lane.frames.size() >= 1024) lane.frames.erase(lane.frames.begin());
        lane.frames.push_back(frame);
    }
    void enter(Frame frame) {
        auto& lane = lanes[select(frame.sp, frame.callee, frame.cpsr)];
        while (!lane.frames.empty() && lane.frames.back().sp <= frame.sp) lane.frames.pop_back();
        if (!lane.frames.empty() && lane.frames.back().returnAddress == frame.returnAddress) { lane.frames.back().sp = frame.sp; return; }
        if (lane.frames.size() >= 1024) lane.frames.erase(lane.frames.begin());
        lane.frames.push_back(frame);
    }
    void branch(unsigned target, unsigned sp, unsigned cpsr, bool canReturn) {
        tick(sp, target, cpsr);
        auto& lane = lanes[active];
        if (!canReturn && (lane.frames.empty() || lane.frames.back().returnAddress != (target & ~1u))) return;
        for (size_t attempt = 0; attempt < lanes.size(); ++attempt) {
            const size_t n = (active + attempt) % lanes.size(); auto& candidate = lanes[n];
            if ((candidate.cpsr & 31) != (cpsr & 31)) continue;
            for (size_t i = candidate.frames.size(); i > 0; --i) {
                if (candidate.frames[i - 1].returnAddress != (target & ~1u)) continue;
                candidate.frames.resize(i - 1); active = n; candidate.lastSp = sp; candidate.nowPc = target; candidate.cpsr = cpsr; return;
            }
        }
    }
    const std::vector<Frame>& frames() const {
        static const std::vector<Frame> empty;
        return lanes.empty() || active >= lanes.size() ? empty : lanes[active].frames;
    }
};
