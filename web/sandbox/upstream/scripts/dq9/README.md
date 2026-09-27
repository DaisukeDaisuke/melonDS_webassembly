# DQ9 persistent scripts

These are JavaScript ports of the local DeSmuME Lua helpers. Load one with **Script Injection → Load source**, then choose **Run / Update**. They run only in the browser's isolated persistent-script Worker and write output to that script's console.

For WebMCP, read the newest ten lines with:

```json
{ "command": "listScriptPrint", "params": { "max": 10 } }
```

The trace scripts automatically resume after their execution breakpoint callback. Stop them with the UI or `stopScript`; every registered breakpoint is then removed.

`memory.read16` / `memory.read32` use the project API's Big Endian byte-view values. The ports use a small `native32()` helper when they need the original Lua/DS little-endian numeric word.
