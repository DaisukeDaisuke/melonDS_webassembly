#pragma once
#include <cstddef>
#include "../melonDS_w/src/types.h"
namespace melonDS {
class NDS;
// Input is a v12 DeSmuME state with its zlib envelope already expanded.
// Returns a negative error without claiming compatibility with an unknown format.
int ImportDeSmuMEState(NDS& nds, const u8* data, size_t length);
// -1 means that the DST does not expose a comparable ARM7 BIOS image.
int CompareDeSmuMEARM7BIOS(const NDS& nds, const u8* data, size_t length, bool& hle);
}
