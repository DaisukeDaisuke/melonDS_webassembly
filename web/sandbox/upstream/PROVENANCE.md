# Isolated script Worker source

This directory contains the DeSmuME Web Debugger script Worker source, parser policy, resource bounds, supporting modules, scripts and package lock copied into **this repository**. No checkout of another application repository is needed to build or run melonDS. The original file layout was retained to preserve Worker imports and security boundaries. Original project: `DaisukeDaisuke/desmume_webassembly` (source snapshot aligned with commit `a8c4555ebf05e37dc6c531eab520ed6e9711dec9`). Licensing is in `LICENSE`.

`web/scripts/build-workers.mjs` uses this directory's own `scripts/dependency-bundle-policy.mjs` to verify the exact Acorn parser hash. It bundles `src/workers/parser.worker.js`, `eval.worker.js`, `eval-supervisor.worker.js`, `persistent-script.worker.js`, and `persistent-script-supervisor.worker.js` **without rewriting their execution/sandbox code**. The generated `web/dist/script-workers.js` is an artifact. `web/script-service.js` is the melonDS-specific RPC and instance routing adapter.

Some copied application modules and scripts are present as context for further feature-equivalent migration; they are not loaded as the DeSmuME emulator in the melonDS page.
