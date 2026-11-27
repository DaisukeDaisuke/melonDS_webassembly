#include "../../webassembly/call-stack-lens.h"
#include <cassert>

struct Frame {
    unsigned caller, callee, returnAddress, sp, cpsr;
};
int main() {
    CallStackLens<Frame> lens;
    lens.call({0x100, 0x200, 0x104, 0x1000, 0x13});
    assert(lens.lanes.size() == 1 && lens.active == 0);
    // An unmatched SP/mode must not manufacture a frame or a new lane.
    lens.tick(0x8000, 0x300, 0x13);
    assert(lens.active == lens.lanes.size() && lens.missValid);
    for (unsigned n = 0; n < 100000; ++n) lens.tick(0x8000, 0x300 + n * 4, 0x13);
    assert(lens.active == lens.lanes.size());
    assert(lens.lanes.size() == 1 && lens.frames().empty());
    // Changing SP must retry the lookup and recover the original frame.
    lens.tick(0x1000, 0x400, 0x13);
    assert(lens.active == 0 && !lens.missValid && lens.frames().size() == 1);
    // A new frame must invalidate the previous miss, even at the same SP.
    lens.tick(0x8000, 0x404, 0x13);
    lens.call({0x500, 0x600, 0x504, 0x8000, 0x13});
    assert(lens.lanes.size() == 2 && lens.active == 1 && !lens.missValid);
    lens.tick(0x8000, 0x604, 0x13);
    assert(lens.frames().back().returnAddress == 0x504);
    // A miss in another CPU mode must not hide a matching existing lane.
    lens.tick(0x1000, 0x700, 0x17);
    assert(lens.missValid);
    lens.tick(0x1000, 0x704, 0x13);
    assert(lens.active == 0 && !lens.missValid);
}
