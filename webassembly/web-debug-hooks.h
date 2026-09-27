#pragma once
#include "types.h"

namespace melonDS {
class ARM;
namespace WebDebugger {
// Called only by the Wasm interpreter while the owning instance's core lock
// is held. Returning false aborts the in-progress frame before this opcode.
bool BeforeInstruction(ARM* cpu, u32 address);
void AfterInstruction(ARM* cpu, u32 address);
void MemoryAccess(ARM* cpu, u32 address, u32 size, bool write);
}
}
