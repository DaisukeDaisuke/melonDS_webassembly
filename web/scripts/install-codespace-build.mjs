// Install only build outputs staged by Codespaces MCP under webassembly/return-build.
// Source files, ROMs, user states/saves and IndexedDB data are not touched.
import { cp, mkdir, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../../', import.meta.url);
const stage = new URL('webassembly/return-build/', root);
for (const required of ['public/index.html','public/loader.js','public/main.js','public/melonds.wasm','dist/melonds.js','dist/melonds.wasm']) {
  const info = await stat(new URL(required, stage));
  if (!info.isFile() || !info.size) throw Error('Missing staged build output: ' + required);
}
await mkdir(new URL('public/', root), { recursive: true });
await mkdir(new URL('web/dist/', root), { recursive: true });
await cp(new URL('public/', stage), new URL('public/', root), { recursive: true, force: true });
await cp(new URL('dist/', stage), new URL('web/dist/', root), { recursive: true, force: true });
for (const path of ['public/loader.js','public/main.js','public/melonds.wasm','web/dist/melonds.js','web/dist/melonds.wasm']) {
  const bytes = await readFile(new URL(path, root));
  console.log(createHash('sha256').update(bytes).digest('hex'), bytes.length, path);
}
