// DeSmuME opcode tables are standalone; no DeSmuME emulator is linked.
#include "vendor/desmume-source/Disassembler.h"
#include <cstdio>
#include <emscripten/emscripten.h>

extern "C" EMSCRIPTEN_KEEPALIVE const char* web_disassemble_opcode(unsigned address, unsigned opcode, int thumb) {
    static char text[256];
    text[0] = 0;
    if (thumb) des_thumb_instructions_set[(opcode & 65535) >> 6](address, opcode & 65535, text);
    else des_arm_instructions_set[((opcode >> 16) & 0xff0) | ((opcode >> 4) & 15)](address, opcode, text);
    return text;
}
