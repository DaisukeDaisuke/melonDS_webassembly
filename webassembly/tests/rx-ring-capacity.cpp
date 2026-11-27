#include "../rx-ring-capacity.h"

using melonDS::Platform::AccessPointRxBytes;
using melonDS::Platform::AccessPointRxHasRoom;

static_assert(AccessPointRxBytes(1514) == 1548);
static_assert(AccessPointRxBytes(562) == 596);
// The 2000-byte UDP datagram's second fragment must wait if the first
// still occupies a 2048-byte RX ring.
static_assert(AccessPointRxHasRoom(1514, 0x4000, 0x4800, 0, 0));
static_assert(!AccessPointRxHasRoom(562, 0x4000, 0x4800, 0, 1548 / 2));
static_assert(AccessPointRxHasRoom(562, 0x4000, 0x4800, 1548 / 2, 1548 / 2));
// Ring wrap, exact-full rejection, invalid or disabled ring.
static_assert(AccessPointRxHasRoom(562, 0x4000, 0x4800, 500, 1000));
static_assert(!AccessPointRxHasRoom(562, 0x4000, 0x4800, 298, 0));
static_assert(!AccessPointRxHasRoom(1514, 0x4000, 0x4000, 0, 0));
static_assert(!AccessPointRxHasRoom(1514, 0x4000, 0x4800, 2000, 0));
static_assert(AccessPointRxHasRoom(1514, 0x4000, 0x6000, 0, 0));
static_assert(AccessPointRxHasRoom(562, 0x5000, 0x5800, 0x800, 0x800));

int main() {}
