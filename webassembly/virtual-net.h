#pragma once
#include "Platform.h"
#include <array>

namespace melonDS::Platform {
struct WebNetFrame {
    u64 timestamp;
    int instanceId;
    int length;
    bool received;
    std::array<u8, 2048> data;
};
int WebNetEnqueue(int instanceId, const u8* data, int length);
int WebNetDrain(WebNetFrame* out, int capacity, u32* dropped);
}
