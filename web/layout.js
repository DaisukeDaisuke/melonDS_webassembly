export const TILE_TYPES = Object.freeze([
  'screen', 'debugger', 'memory', 'disassembly', 'registers', 'breakpoints',
  'local-log', 'wifi-log', 'script', 'persistent-scripts', 'input', 'state', 'files'
]);
export const LABELS = Object.freeze({
  screen: 'Emulator Screen', debugger: 'Debugger', memory: 'Memory Viewer',
  disassembly: 'Disassembler', registers: 'Registers', breakpoints: 'Breakpoints',
  'local-log': 'Local Communication', 'wifi-log': 'Wi-Fi Logger', script: 'Script Console',
  'persistent-scripts': 'Persistent Scripts', input: 'Input Controller', state: 'State Manager',
  files: 'File Explorer'
});
const KEY = 'melonds.workspace.v1';
const defaultTiles = [
  { type: 'screen', instanceId: 0, x: 0, y: 0, width: 316, height: 474 },
  { type: 'debugger', instanceId: 0, x: 336, y: 0, width: 360, height: 300 },
  { type: 'local-log', instanceId: 0, x: 716, y: 0, width: 500, height: 300 }
];

export function makeTile(type, options = {}) {
  if (!TILE_TYPES.includes(type)) throw new RangeError('Unknown tile type');
  return {
    id: globalThis.crypto?.randomUUID?.() || `tile-${Date.now()}-${Math.random()}`,
    type, x: 0, y: 0, width: type === 'screen' ? 316 : type === 'files' ? 520 : 360,
    height: type === 'screen' ? 474 : type === 'files' ? 440 : 300, z: 1, instanceId: 0,
    cpu: 'ARM9', minimized: false, settings: {}, ...options
  };
}

export function loadLayout(storage = globalThis.localStorage) {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return { mode: 'grid', tiles: defaultTiles.map(t => makeTile(t.type, t)) };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.tiles) || !['grid', 'free'].includes(parsed.mode)) throw Error();
    return {
      mode: parsed.mode,
      tiles: parsed.tiles.slice(0, 128).filter(t => TILE_TYPES.includes(t.type) &&
        Number.isInteger(t.instanceId) && t.instanceId >= 0 && t.instanceId < 16)
        .map(t => makeTile(t.type, {
          id: String(t.id), x: finite(t.x, 0), y: finite(t.y, 0),
          width: Math.max(240, finite(t.width, 360)),
          height: Math.max(120, finite(t.height, 300)),
          z: finite(t.z, 1), instanceId: t.instanceId,
          cpu: t.cpu === 'ARM7' ? 'ARM7' : 'ARM9',
          minimized: t.minimized === true,
          settings: t.settings && typeof t.settings === 'object' && !Array.isArray(t.settings)
            ? t.settings : {}
        }))
    };
  } catch {
    return { mode: 'grid', tiles: defaultTiles.map(t => makeTile(t.type, t)) };
  }
}

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function saveLayout(layout, storage = globalThis.localStorage) {
  storage.setItem(KEY, JSON.stringify(layout));
}
