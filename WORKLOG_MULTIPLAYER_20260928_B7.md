# Multiplayer runtime work — 2026-09-28

## Current deployed build
- Codespace: organic-fishstick-wrjpjx79qjwc5qgr, existing public port 8000 server retained.
- Current tested build ID: `596ae7d1fe67f5ff9f29`.
- Full source sync was completed first: 2,991 local/source SHA-256 values matched the Codespace before changes.
- Local files are authoritative; edits are made through local MCP. User ZIP and runtime_issue.txt are not overwritten.

## Applied and built
- Local packet observation events are batched; actual LocalMP packet/reply FIFOs are unchanged.
- At most one screen notification per instance is in flight; acknowledge consumption instead of queueing old pixel buffers.
- Packet table updates reuse rows; log dispatch is batched at 100 ms. Frame-counter text also updates at 100 ms without slowing the emulated game.
- Translation observer excludes packet rows and frame counters. Frame copying avoids an extra typed-array clone.
- A content build ID propagates from index to loader, main, pthread worker and Wasm URL. Warm-cache reload was checked.
- Live key/touch input no longer blocks the dispatcher on the emulation core mutex. Native commands are applied at an available core/frame boundary, with completion tokens; the API resolves only after application. Existing scheduled input, recording, and legacy exports remain.

## Actual checks
- workspace.mel restored #0/#1/#2; #1/#2 repeated A produces real CMD/REPLY/ACK traffic.
- Before the native input fix, one live key-down request took 3,899 ms.
- After the fix, tested key/touch edges completed in approximately 15–37 ms. A 120-frame movement completed in 2,050 ms with roughly 60 fps on the three running instances and no RPC >=40 ms in that measurement.
- One earlier one-second sample dipped to ~34 fps and then caught up; not claimed perfectly uniform frame pacing.
- runtime_issue.txt subsequently explicitly confirmed that the input bug was fixed.
- dq9_new2.nds loaded. battle.dst loaded and rendered the actual three-enemy battle/command screen; existing ARM7 BIOS/HLE mismatch warning was preserved.
- 29_dlcs.sav imported and re-exported byte-for-byte equal (65,536 bytes); actual reset/boot showed its Lv51 save and entered Stornway church.
- The four supplied DLC files were placed in /YDQJ in the browser's DLC store, with exact input sizes (105/1368/744/468 bytes). Same-origin WFC registration succeeded. A game-driven DLC download has not yet been rechecked in this run.

## Current follow-up: unstable 1 host / 2 guests
- Restored #1 and #2 both have radio MAC `00:09:BF:11:22:34` at ARM7 Wi-Fi register 0x04800018.
- Both also have the same SDK MAC bytes at ARM9 0x027FFCF4.
- Observed REPLY frames from both carry that same source MAC and rawType 0x00010002 (AID 1).
- Fresh ROM+SAV boots, without cloning the core state, have distinct MACs: #0 00:09:BF:12:34:56 (firmware from supplied DST), #1 00:09:BF:11:22:34, #2 00:09:BF:11:22:35.
- Therefore the duplicate is present in the restored running state, not just the frontend's instance ID. Do not claim it is a game bug or fix it by fabricating ACKs/rewriting arbitrary game RAM.
- Also found workspace firmware import currently adds instanceId to already captured firmware MAC again; exact restoration must not add it twice. Work in progress.

## Tool issues
- Some compound/evaluate requests were blocked by a request-check layer and succeeded when split into smaller authorized calls.
- The initial per-file compound source transfer was very slow; a generated source-only archive plus hash verification completed the sync. Cancel of the redundant compound transfer was unsupported, so final source hash reconciliation is necessary.
- GitHub CLI in the Codespace was unauthenticated. Public Actions metadata was read via GitHub REST; the latest inspected Actions run did actually rebuild Wasm. No evidence was found for a stale-Wasm Actions cache hit.
- No new tests, sanitizer runs, generic memory scans, or unrelated quality refactors were added.
