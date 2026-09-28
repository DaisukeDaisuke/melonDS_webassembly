#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v emcmake >/dev/null 2>&1; then
  echo 'Emscripten is required (emcmake not found).' >&2
  exit 1
fi
if ! test -f "$root/melonDS_w/src/NDS.cpp"; then
  echo 'Initialize the melonDS_w submodule before building.' >&2
  exit 1
fi
if ! test -f "$root/webassembly/vendor/desmume-source/Disassembler.cpp"; then
  node "$root/webassembly/vendor-disassembler.mjs"
fi
emcmake cmake -S "$root/webassembly" -B "$root/webassembly/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$root/webassembly/build" --target melonds -j "${BUILD_JOBS:-2}"
npm ci --prefix "$root/web/sandbox/upstream" --no-audit --no-fund
node "$root/web/scripts/build-workers.mjs"
if ! test -s "$root/web/dq9/certs/server.crt" || ! test -s "$root/web/dq9/certs/server.key"; then
  bash "$root/web/dq9/generate-certs.sh"
fi
node "$root/web/scripts/build-app.mjs"
echo "Built $root/public — loader.js, main.js, melonds.wasm"
