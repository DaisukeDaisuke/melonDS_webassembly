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
const GRID_UNIT_VERSION = 2;
const WIDE_GRID_TYPES = new Set(['local-log', 'wifi-log', 'files']);
const defaultGridSpan = type => WIDE_GRID_TYPES.has(type) ? 4 : 2;
function gridSpan(type, value, version) {
  if (!Number.isFinite(value)) return defaultGridSpan(type);
  const span = Math.max(1, Math.round(value));
  return Math.min(32, version === GRID_UNIT_VERSION ? span : span * 2);
}
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
    height: type === 'screen' ? 540 : type === 'files' ? 440 : 340, gridSpan: defaultGridSpan(type), z: 1, instanceId: 0,
    cpu: 'ARM9', minimized: false, settings: {}, ...options
  };
}

export function loadLayout(storage = globalThis.localStorage) {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return { mode: 'grid', gridUnitVersion: GRID_UNIT_VERSION, tiles: defaultTiles.map(t => makeTile(t.type, t)) };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.tiles) || !['grid', 'free'].includes(parsed.mode)) throw Error();
    return {
      mode: parsed.mode,
      gridUnitVersion: GRID_UNIT_VERSION,
      toolOrder: [...new Set([...(Array.isArray(parsed.toolOrder) ? parsed.toolOrder : []), ...TILE_TYPES])].filter(type => TILE_TYPES.includes(type)),
      tiles: parsed.tiles.slice(0, 128).filter(t => TILE_TYPES.includes(t.type) &&
        Number.isInteger(t.instanceId) && t.instanceId >= 0 && t.instanceId < 16)
        .map(t => makeTile(t.type, {
          id: String(t.id), x: finite(t.x, 0), y: finite(t.y, 0),
          width: Math.max(240, finite(t.width, 360)),
          height: Math.max(120, finite(t.height, 300)),
          gridHeight: t.gridHeight ? Math.max(120, finite(t.gridHeight, 340)) : undefined,
          gridSpan: gridSpan(t.type, t.gridSpan, parsed.gridUnitVersion),
          z: finite(t.z, 1), instanceId: t.instanceId,
          cpu: t.cpu === 'ARM7' ? 'ARM7' : 'ARM9',
          minimized: t.minimized === true,
          settings: t.settings && typeof t.settings === 'object' && !Array.isArray(t.settings)
            ? t.settings : {}
        }))
    };
  } catch {
    return { mode: 'grid', gridUnitVersion: GRID_UNIT_VERSION, tiles: defaultTiles.map(t => makeTile(t.type, t)) };
  }
}

export function migrateWorkspaceLayout(saved) {
  if (!saved || !Array.isArray(saved.tiles)) return saved;
  const version = saved.gridUnitVersion;
  for (const tile of saved.tiles) tile.gridSpan = gridSpan(tile.type, tile.gridSpan, version);
  saved.gridUnitVersion = GRID_UNIT_VERSION;
  return saved;
}

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function saveLayout(layout, storage = globalThis.localStorage) {
  storage.setItem(KEY, JSON.stringify(layout));
}
