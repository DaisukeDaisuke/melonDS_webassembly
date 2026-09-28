// Vendor the exact DeSmuME disassembler supplied with this task, verified
// against the read-only archive. No emulator dependency is introduced.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('./vendor/desmume-source/', import.meta.url);
const files = [
 ['frontend/modules/Disassembler.cpp','3cf544e64f7b278b792fe4274ead907082330b6b457c5e04e2a5bd6d3c138941'],
 ['frontend/modules/Disassembler.h','e35909d2d29d24e89de1b1f7090668be01838bfacb9d11e6c169fc5905038c40'],
 ['instruction_tabdef.inc','de572264bd4faeed8d54641f82695a17da6e541df850c53c7089e75d0fc2558b'],
 ['thumb_tabdef.inc','b58aa1e36771a56fcead8314e5f71a214797ba645994d102957baae41553b42c'],
 ['utils/bits.h','8fd56a9d5aeeba7bacfee67791f3c79da9628fb874a4178c9a7ca8742e6ef17e']
];
await mkdir(new URL('utils/',root),{recursive:true});
for (const [file, sha] of files) {
 const response=await fetch('https://raw.githubusercontent.com/DaisukeDaisukeForks/desmume/535f676778dff6e2cbd57ff8468b4a9846d23933/desmume/src/'+file);
 if (!response.ok) throw Error(`${file}: HTTP ${response.status}`);
 const data=Buffer.from(await response.arrayBuffer());
 if (createHash('sha256').update(data).digest('hex')!==sha) throw Error('Archive hash mismatch: '+file);
 const destination=file.startsWith('frontend/modules/')?file.split('/').at(-1):file;
 await writeFile(new URL(destination,root),data,{flag:'wx'});
 console.log('Vendored '+destination+' (archive SHA-256 matched)');
}
await writeFile(new URL('types.h',root),'#pragma once\n#include <cstdint>\nusing u8 = uint8_t; using u32 = uint32_t; using s32 = int32_t;\n',{flag:'wx'});
await writeFile(new URL('armcpu.h',root),'#pragma once\n#define CONDITION(i) ((i)>>28)\n#define REG_POS(i,n) (((i)>>(n))&15)\n#define INSTRUCTION_INDEX(i) ((((i)>>16)&0xFF0)|(((i)>>4)&15))\n',{flag:'wx'});
await writeFile(new URL('ORIGIN.txt',root),'DeSmuME commit 535f676778dff6e2cbd57ff8468b4a9846d23933.\nDisassembler.cpp/.h and tables are GPL-2.0-or-later; original copyright notices retained.\nThe two small types.h/armcpu.h adapters replace emulator-wide includes.\nSource content verified against the user-supplied read-only ZIP.\n',{flag:'wx'});
