// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
// Modern libc++ no longer supplies these standard library declarations
// transitively to the pinned melonDS core implementation files.
#include <algorithm> // std::copy in FreeBIOS.cpp
#include <cstdlib>   // malloc, free, realloc in Savestate.cpp
