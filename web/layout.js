export const TILE_TYPES = Object.freeze([
  'screen', 'debugger', 'memory', 'disassembly', 'registers', 'breakpoints', 'callstack', 'save',
  'local-log', 'wifi-log', 'script', 'persistent-scripts', 'input', 'state', 'files', 'system', 'workspace'
]);
export const LABELS = Object.freeze({
  screen: 'エミュレータ', debugger: 'デバッガ', memory: 'メモリ',
  disassembly: '逆アセンブル', registers: 'レジスタ', breakpoints: 'ブレークポイント',
  'local-log': 'ローカル通信', 'wifi-log': 'Wi-Fi', script: 'スクリプト',
  'persistent-scripts': '常駐スクリプト', input: '入力', state: 'ステート', save: 'セーブデータ', callstack: 'コールスタック',
  files: 'DLCファイル', system: 'BIOS / FW', workspace: '全体保存 .mel'
});
const KEY = 'melonds.workspace.v1';
const defaultTiles = [
  { type: 'screen', instanceId: 0, x: 0, y: 0, width: 300, height: 540 },
  { type: 'debugger', instanceId: 0, x: 310, y: 0, width: 330, height: 340 },
  { type: 'registers', instanceId: 0, x: 650, y: 0, width: 280, height: 340 },
  { type: 'state', instanceId: 0, x: 940, y: 0, width: 330, height: 340 }
];

export function makeTile(type, options = {}) {
  if (!TILE_TYPES.includes(type)) throw new RangeError('Unknown tile type');
  return {
    id: globalThis.crypto?.randomUUID?.() || `tile-${Date.now()}-${Math.random()}`,
    type, x: 0, y: 0, width: type === 'screen' ? 316 : type === 'files' ? 520 : 360,
    height: type === 'screen' ? 540 : type === 'files' ? 440 : 340, z: 1, instanceId: 0,
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
          gridHeight: t.gridHeight ? Math.max(120, finite(t.gridHeight, 340)) : undefined,
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
