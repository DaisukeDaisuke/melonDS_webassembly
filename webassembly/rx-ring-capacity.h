#pragma once

namespace melonDS::Platform {

// WifiAP::RecvPacket converts an Ethernet frame into a 24-byte 802.11
// header, 8-byte LLC/SNAP header, payload, padding and 4-byte FCS.
// Wifi::StartRX also reserves a 12-byte hardware receive header.
constexpr int AccessPointRxBytes(int ethernetLength) {
    return ((ethernetLength + 18 + 3) & ~3) + 4 + 12;
}

// Begin/end are byte addresses; hardware cursors are halfword addresses.
// Leave room before the read cursor so a completed packet cannot make
// a full ring indistinguishable from an empty one.
constexpr bool AccessPointRxHasRoom(int ethernetLength, unsigned begin,
                                   unsigned end, unsigned readCursor,
                                   unsigned writeCursor) {
    constexpr unsigned mask = 0x1FFF;
    if (ethernetLength < 14 || begin == end) return false;
    begin &= 0x1FFE;
    end &= 0x1FFE;
    unsigned capacity = (end - begin) & mask;
    if (capacity == 0) capacity = mask + 1;
    const unsigned read = ((readCursor << 1) - begin) & mask;
    const unsigned write = ((writeCursor << 1) - begin) & mask;
    if (read >= capacity || write >= capacity) return false;
    const unsigned free = read > write ? read - write : capacity - write + read;
    return static_cast<unsigned>(AccessPointRxBytes(ethernetLength)) < free;
}

}
