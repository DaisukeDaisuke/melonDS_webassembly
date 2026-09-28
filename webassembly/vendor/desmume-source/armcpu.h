#pragma once
#define CONDITION(i) ((i)>>28)
#define REG_POS(i,n) (((i)>>(n))&15)
#define INSTRUCTION_INDEX(i) ((((i)>>16)&0xFF0)|(((i)>>4)&15))
