#pragma once
#include "Platform.h"
#include <array>
namespace melonDS { class Savestate; }

namespace melonDS::Platform {
struct WebNetFrame {
    u64 timestamp;
    int instanceId;
    int length;
    bool received;
    std::array<u8, 2048> data;
    // Use the trailing padding in the existing .mel transport record.
    std::array<u8, 6> bssid;
};
static_assert(sizeof(WebNetFrame) == 2072);
int WebNetEnqueue(int instanceId, const u8* data, int length, const u8* bssid = nullptr);
int WebNetDrain(WebNetFrame* out, int capacity, u32* dropped);
int WebNetDrainOutgoing(WebNetFrame* out, int capacity);
void WebNetClear(int instanceId);
void WebNetClearAccessPoint(int instanceId, const u8* bssid);
int WebNetSetEnabled(int instanceId, bool enabled);
int WebNetGetEnabled(int instanceId);
void WebNetDoTransportState(Savestate* state);
void WebSemaphoreState(Savestate* state, Semaphore* semaphore);
}
