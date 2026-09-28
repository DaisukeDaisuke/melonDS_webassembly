#pragma once
#include <ctime>
#include "NDS.h"
inline void initializeWallClock(melonDS::NDS& nds) {
    // DeSmuME normal-mode RTC reads the host clock, not a saved calendar.
    // Native melonDS state imports retain their own saved date/time.
    const std::time_t now = std::time(nullptr);
    const auto* time = std::localtime(&now);
    if (time) nds.RTC.SetDateTime(time->tm_year + 1900, time->tm_mon + 1,
        time->tm_mday, time->tm_hour, time->tm_min, time->tm_sec);
}
