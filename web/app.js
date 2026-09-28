import { createApi, MAX_INSTANCES } from './api.js';
import { systemFiles, systemKind } from './system-files.js';
import { createWorkspaceService } from './workspace-service.js';
import { createWasmBackend } from './backend.js';
import { createScriptBackend } from './script-service.js';
import { loadLayout, saveLayout, makeTile, migrateWorkspaceLayout, TILE_TYPES, LABELS } from './layout.js';
import { registerWebMcp } from './webmcp.js';
import { createVirtualNetwork } from './virtual-network.js';
import { renderFileExplorer } from './file-explorer.js';
import { renderDebuggerTool } from './debugger-ui.js';
import { renderStorageTool } from './storage-ui.js';
import { createAudioBus } from './audio.js';
import { decodePacket } from './packet-decode.js';
import { installLanguageSwitcher } from './i18n.js';

installLanguageSwitcher();

const $ = selector => document.querySelector(selector);
const workspace = $('#workspace');
const layout = loadLayout();
const backend = createScriptBackend(createWasmBackend());
const api = createApi(backend);
const state = { instances: [], names: new Map(), logs: { 'local-log': [], 'wifi-log': [] }, pending: new Set() };
const LOG_RETENTION = Object.freeze({ 'local-log': 10000, 'wifi-log': 2000 });
const LOG_RENDER_LIMIT = 100;
const LOCAL_PACKET_NAMES = Object.freeze(['PACKET', 'CMD', 'REPLY', 'ACK']);
function retainLogs(type, list) {
  const limit = LOG_RETENTION[type] || 2000;
  if (list.length > limit) list.splice(0, list.length - limit);
}
const dirtyLogs = new Set();
let logRepaint = 0;
function queueLogUpdate(type) {
  dirtyLogs.add(type);
  if (logRepaint) return;
  logRepaint = setTimeout(() => {
    logRepaint = 0;
    for (const type of dirtyLogs) {
      for (const tile of workspace.querySelectorAll(`[data-type="${type}"]`)) tile.querySelector('.tile-body').dispatchEvent(new Event('packet'));
    }
    dirtyLogs.clear();
  }, 100);
}
const stateWarnings = new Map();
let stateWarningsDismissed = false;
function dismissStateWarnings() {
  stateWarningsDismissed = true;
  stateWarnings.clear();
  for (const node of workspace.querySelectorAll('.tile')) node._stateWarning?.(null);
}
const audio = createAudioBus({ onTargets: ids => backend.setAudioTargets(ids), onChange: updateAudioTargets });
globalThis.melondsAudio = Object.freeze({ stats: () => audio.stats() });
globalThis.melonds = api;
globalThis.melondsVirtualNetwork = createVirtualNetwork(api, { onEvent: event => {
  if (event.type !== 'wifi-log') return;
  state.logs['wifi-log'].push(event);
  retainLogs('wifi-log', state.logs['wifi-log']);
  queueLogUpdate('wifi-log');
} });
globalThis.melondsFiles = globalThis.melondsVirtualNetwork.files;
globalThis.melondsWorkspace = createWorkspaceService({ api, backend, network: globalThis.melondsVirtualNetwork,
  beforeRestore: () => Promise.all([...document.querySelectorAll('.tile')].map(node => node._releaseInput?.())),
  readUI: () => ({ layout: structuredClone(layout), names: [...state.names], logs: structuredClone(state.logs),
    selectedInstance: $('#rom-instance').value, audio: audio.stats().instances.map(record => record.instanceId) }),
  async restoreUI(saved, scripts) {
    Object.assign(layout, migrateWorkspaceLayout(saved.layout));
    state.names = new Map(saved.names); state.logs = saved.logs;
    for (const script of scripts) {
      if (!layout.tiles.some(tile => tile.type === 'persistent-scripts' && tile.instanceId === script.instanceId && tile.settings.code === script.code)) {
        layout.tiles.push(makeTile('persistent-scripts', { instanceId: script.instanceId, settings: { code: script.code, name: script.name } }));
      }
    }
    renderLayout(); renderPalette(); save(); $('#rom-instance').value = saved.selectedInstance;
    for (const instanceId of saved.audio || []) if (state.instances.includes(instanceId) && !audio.has(instanceId)) await audio.toggle(instanceId);
    if (scripts.some(script => script.running)) $('#notice').textContent = 'スクリプトのソースを復元しました。Workerは停止状態です。';
  }
});

function errorMessage(error) {
  $('#notice').textContent = error?.message || String(error);
  $('#notice').hidden = false;
}
function save() { saveLayout(layout); }
function linkedInputTargets(instanceId) {
  // Links form an undirected component, not a chain of forwarded key events.
  // Resolve IDs once per input edge: cycles and duplicate screen tiles cannot
  // deliver a key twice, and input from either end reaches the whole group.
  const group = new Set([instanceId]);
  let changed;
  do {
    changed = false;
    for (const tile of layout.tiles) {
      const other = tile.settings.inputLink;
      if (tile.type !== 'screen' || !Number.isInteger(other) || other < 0 || other >= MAX_INSTANCES) continue;
      if (!group.has(tile.instanceId) && !group.has(other)) continue;
      const size = group.size;
      group.add(tile.instanceId); group.add(other);
      changed ||= group.size !== size;
    }
  } while (changed);
  return state.instances.filter(id => group.has(id));
}
const keyOwners = new Map();
function linkedKey(owner, ids, key, pressed) {
  const requests = [];
  for (const instanceId of ids) {
    const address = `${instanceId}:${key}`;
    let owners = keyOwners.get(address);
    if (!owners) { if (!pressed) continue; keyOwners.set(address, owners = new Set()); }
    const wasPressed = owners.size > 0;
    if (pressed) owners.add(owner); else owners.delete(owner);
    const isPressed = owners.size > 0;
    if (!isPressed) keyOwners.delete(address);
    if (wasPressed !== isPressed && state.instances.includes(instanceId))
      requests.push(api.input({ instanceId, key, pressed: isPressed }));
  }
  return Promise.all(requests);
}
function updateScreenTargets() {
  backend.setScreenTargets([...new Set(layout.tiles.filter(tile => tile.type === 'screen' && !tile.minimized)
    .map(tile => tile.instanceId))]);
}
function updateAudioTargets() {
  for (const node of workspace.querySelectorAll('[data-type=screen]')) node._syncAudio?.();
}
function playAudio({ instanceId, samples }) {
  audio.push({ instanceId, samples });
}
function apply(target, callback) {
  const button = target instanceof HTMLElement ? target : null;
  if (button) button.disabled = true;
  return Promise.resolve().then(callback).then(result => {
    $('#notice').hidden = true;
    return result;
  }).catch(error => { errorMessage(error); return undefined; })
    .finally(() => { if (button) button.disabled = false; });
}
function fmt(value) {
  if (value instanceof Uint8Array) return Array.from(value, b => b.toString(16).padStart(2, '0')).join(' ');
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map((item, index) => typeof item === 'object' ? `${index + 1}. ${fmt(item)}` : String(item)).join('\n');
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${fmt(item)}`).join('\n');
  return String(value);
}
function el(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function button(text, callback) {
  const item = el('button', '', text);
  item.type = 'button';
  item.addEventListener('click', () => apply(item, callback));
  return item;
}
function row(parent) { const item = el('div', 'control-row'); parent.append(item); return item; }
function readout(parent, initial = '—') {
  const item = el('pre', 'readout', initial); parent.append(item); return item;
}
function textInput(parent, placeholder, defaultValue = '') {
  const item = el('input'); item.placeholder = placeholder; item.value = defaultValue;
  item.setAttribute('aria-label', placeholder); parent.append(item); return item;
}
function hex(input) {
  const value = input.value.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(value)) throw new Error('16進数を入力してください');
  return Number.parseInt(value, 16);
}
function bytes(input) {
  const value = input.value.replace(/\s+/g, '');
  if (!value || value.length % 2 || !/^[0-9a-f]+$/i.test(value)) throw Error('偶数桁のhexデータを入力してください');
  return Uint8Array.from(value.match(/.{2}/g), n => Number.parseInt(n, 16));
}
function download(data, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([Array.isArray(data) ? new Uint8Array(data) : data], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function loadDelayMs() {
  const value = Number($('#load-delay')?.value || 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
async function waitForLoadDelay(index, startedAt) {
  const remaining = index * loadDelayMs() - (performance.now() - startedAt);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
}
function csvField(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function localPacketName(packet) {
  return String(packet.packetType || 'PACKET');
}

function populateInstances(select, chosen) {
  select.replaceChildren();
  for (let id = 0; id < MAX_INSTANCES; id++) {
    const option = new Option(`#${String(id).padStart(2, '0')}${state.instances.includes(id) ? '' : ' · 未作成'}`, id);
    select.append(option);
  }
  select.value = String(chosen);
}
function refreshSummary() {
  $('#session-summary').textContent = `${state.instances.length} / 16 台 · ${layout.tiles.length} ツール`;
  populateInstances($('#rom-instance'), Number($('#rom-instance').value) || 0);
  for (const tile of workspace.querySelectorAll('.tile')) {
    const model = layout.tiles.find(t => t.id === tile.dataset.id);
    if (model) populateInstances(tile.querySelector('.instance-select'), model.instanceId);
  }
}
function addTile(type, x, y) {
  const top = Math.max(1, ...layout.tiles.map(t => t.z || 1)) + 1;
  const unusedScreen = Array.from({ length: MAX_INSTANCES }, (_, id) => id).find(id => !layout.tiles.some(tile => tile.type === 'screen' && tile.instanceId === id));
  const tile = makeTile(type, { x: Math.max(0, x), y: Math.max(0, y), z: top, instanceId: type === 'screen' && unusedScreen !== undefined ? unusedScreen : Number($('#rom-instance').value) || 0 });
  layout.tiles.push(tile); save(); renderTile(tile); refreshSummary(); updateScreenTargets(); updateAudioTargets();
}
function renderLog(body, tile) {
  const controls = row(body);
  const filter = el('label', '', '全インスタンス ');
  const showAll = el('input'); showAll.type = 'checkbox'; showAll.checked = !!tile.settings.all;
  filter.prepend(showAll); controls.append(filter);
  const pause = el('input'); pause.type = 'checkbox'; pause.checked = !!tile.settings.paused;
  const pauseLabel = el('label', '', ' 表示を停止'); pauseLabel.prepend(pause); controls.append(pauseLabel);
  const decodedOnly = el('input'); decodedOnly.type = 'checkbox'; decodedOnly.checked = !!tile.settings.decodedOnly;
  if (tile.type === 'wifi-log') { const label = el('label', '', ' 復号・再構成済み'); label.prepend(decodedOnly); controls.append(label); }
  controls.append(button('消去', () => { state.logs[tile.type] = []; update(); }));
  if (tile.type === 'local-log') {
    const exportFilter = el('details', 'packet-export-filter');
    exportFilter.append(el('summary', '', 'CSV対象'));
    const exportOptions = el('div', 'packet-export-options');
    for (const packetName of LOCAL_PACKET_NAMES) {
      const label = el('label');
      const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.value = packetName; checkbox.checked = true;
      label.append(checkbox, document.createTextNode(` ${packetName}`));
      exportOptions.append(label);
    }
    exportFilter.append(exportOptions); controls.append(exportFilter);
    controls.append(button('CSV出力', () => {
      const selected = new Set([...exportOptions.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value));
      if (!selected.size) throw Error('CSVに出力するパケット名を1つ以上選択してください');
      const entries = state.logs['local-log'].filter(packet => selected.has(localPacketName(packet)) &&
        (tile.settings.all || packet.instanceId === tile.instanceId || packet.destination === tile.instanceId));
      if (!entries.length) throw Error('選択条件に一致するパケットがありません');
      const lines = [['timestamp', 'direction', 'sender', 'destination', 'packet_name', 'raw_type', 'sequence', 'length', 'dropped', 'payload_hex'].join(',')];
      for (const packet of entries) {
        const rawType = Number.isInteger(packet.rawType) ? `0x${packet.rawType.toString(16).padStart(8, '0')}` : '';
        const payload = Array.from(packet.payload || [], byte => byte.toString(16).padStart(2, '0')).join(' ');
        lines.push([
          packet.timestamp, packet.direction || 'TX', packet.senderId ?? packet.instanceId ?? '',
          packet.destination ?? '*', localPacketName(packet), rawType, packet.sequence ?? '',
          packet.length ?? packet.payload?.length ?? 0, packet.dropped ?? '', payload
        ].map(csvField).join(','));
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      download(`\ufeff${lines.join('\r\n')}\r\n`, `melonds-local-packets-${stamp}.csv`, 'text/csv;charset=utf-8');
    }));
  }
  if (tile.type === 'wifi-log') {
    controls.append(button('DQ9 WFC 接続', async () => {
      await globalThis.melondsVirtualNetwork.registerDq9WfcFromSameOrigin({ instanceId: tile.instanceId });
      await api.setNetworkBackend({ instanceId: tile.instanceId, backend: 'virtual' });
    }));
    controls.append(button('ネットワーク切断', () => api.setNetworkBackend({ instanceId: tile.instanceId, backend: 'disabled' })));
  }
  const table = el('table', tile.type === 'wifi-log' ? 'packet-table network-log' : 'packet-table');
  const head = el('thead'); const header = el('tr');
  for (const label of ['時刻', '方向', '送信元', '宛先', 'プロトコル', '長さ', '内容']) header.append(el('th', '', label));
  head.append(header); table.append(head); const tbody = el('tbody', 'packet-rows'); table.append(tbody); body.append(table);
  const empty = el('p', 'muted', '受信データはまだありません。'); body.append(empty);
  const detail = el('pre', 'network-detail'); detail.hidden = true; body.append(detail);
  let selectedPacket = null;
  const cachedRows = new WeakMap();
  function update() {
    if (tile.settings.paused) return;
    const entries = [];
    const log = state.logs[tile.type];
    for (let index = log.length - 1; index >= 0 && entries.length < LOG_RENDER_LIMIT; index--) {
      const packet = log[index];
      if ((!tile.settings.decodedOnly || packet.logical) &&
        (tile.settings.all || packet.instanceId === tile.instanceId || packet.destination === tile.instanceId)) entries.push(packet);
    }
    entries.reverse();
    empty.hidden = !!entries.length;
    const rows = entries.map(packet => {
      let tr = cachedRows.get(packet);
      if (!tr) {
      tr = el('tr');
      const sender = tile.type === 'wifi-log' && packet.direction === 'RX' ? 'NET' : packet.senderId ?? packet.instanceId;
      const receiver = tile.type === 'wifi-log' ? (packet.direction === 'RX' ? packet.instanceId : 'NET') : packet.destination ?? '*';
      const decoded = tile.type === 'wifi-log' ? (packet.decoded ||= decodePacket(packet)) : null;
      const raw = () => packet.payload ? Array.from(packet.payload, n => n.toString(16).padStart(2, '0')).join(' ') : '';
      for (const value of [packet.timestamp, packet.direction || 'TX', decoded?.source || sender, decoded?.destination || receiver,
        decoded?.protocol || packet.packetType || 'PACKET', packet.length ?? packet.payload?.length ?? 0,
        decoded?.summary || Array.from(packet.payload?.slice(0, 64) || [], n => n.toString(16).padStart(2, '0')).join(' ')]) tr.append(el('td', '', String(value)));
      tr.tabIndex = 0;
      tr.onclick = () => { selectedPacket = packet; for (const selected of tbody.querySelectorAll('.selected')) selected.classList.remove('selected'); tr.classList.add('selected'); detail.hidden = false; detail.textContent = decoded?.detail || raw(); };
      tr.onkeydown = event => { if (event.key === 'Enter') tr.click(); };
      cachedRows.set(packet, tr);
      }
      tr.classList.toggle('selected', selectedPacket === packet);
      return tr;
    });
    const retained = new Set(rows);
    for (const tr of [...tbody.children]) if (!retained.has(tr)) tr.remove();
    let next = tbody.firstChild;
    for (const tr of rows) {
      if (tr === next) next = next.nextSibling;
      else tbody.insertBefore(tr, next);
    }
  }
  showAll.onchange = () => { tile.settings.all = showAll.checked; save(); update(); };
  decodedOnly.onchange = () => { tile.settings.decodedOnly = decodedOnly.checked; save(); update(); };
  pause.onchange = () => { tile.settings.paused = pause.checked; save(); update(); };
  body.addEventListener('target-change', update);
  body.addEventListener('packet', update);
  update();
}

function renderBody(body, tile, tileElement) {
  const args = extra => ({ instanceId: tile.instanceId, cpu: tile.cpu, ...extra });
  if (renderDebuggerTool(body, tile, tileElement, { api, save, onError: errorMessage, jump: jumpTo })) return;
  if (renderStorageTool(body, tile, tileElement, { api, save, onError: errorMessage, download, audio })) return;
  if (tile.type === 'files') return renderFileExplorer(body, {
    files: globalThis.melondsFiles, tile, save, onError: errorMessage
  });
  if (tile.type === 'system') {
    return renderSystem();
  }
  if (tile.type === 'workspace') {
    const controls = row(body), input = el('input'), status = el('div');
    input.type = 'file'; input.accept = '.mel'; input.hidden = true; input.setAttribute('aria-label', '.mel を開く');
    const name = textInput(controls, 'ファイル名', tile.settings.filename || 'workspace.mel');
    controls.append(button('全体を保存', async () => {
      status.textContent = '保存中…';
      try {
        const file = await globalThis.melondsWorkspace.export();
        tile.settings.filename = name.value || 'workspace.mel'; save();
        download(file, tile.settings.filename.endsWith('.mel') ? tile.settings.filename : `${tile.settings.filename}.mel`);
        status.textContent = `${(file.size / 1048576).toFixed(1)} MiB · 保存済み`;
      } catch (error) { status.textContent = String(error.message || error); throw error; }
    }), button('.mel を開く', () => input.click()), input);
    input.onchange = () => void apply(null, async () => {
      const file = input.files?.[0]; if (!file) return;
      status.textContent = '復元中…';
      await globalThis.melondsWorkspace.import(file);
      $('#notice').textContent = `${file.name} · 復元しました`;
    }).finally(() => { input.value = ''; });
    body.append(status); return;
  }
  function renderSystem() {
    const controls = row(body), input = el('input');
    input.type = 'file'; input.accept = '.bin,.rom'; input.multiple = true; input.hidden = true;
    input.setAttribute('aria-label', 'BIOSとファームウェア');
    const all = el('input'); all.type = 'checkbox';
    const allLabel = el('label', '', ' 全インスタンス'); allLabel.prepend(all);
    const defaults = el('input'); defaults.type = 'checkbox'; defaults.checked = true;
    const defaultLabel = el('label', '', ' 次回も使用'); defaultLabel.prepend(defaults);
    controls.append(button('ファイルを開く', () => input.click()), allLabel, defaultLabel, input);
    const information = el('div', 'system-status'); body.append(information);
    const refresh = async () => {
      if (!state.instances.includes(tile.instanceId)) { information.textContent = 'インスタンス未作成'; return; }
      const { system } = await api.status(args());
      information.replaceChildren(...[['BIOS7', system.nativeBios7 ? '実機' : system.bios7 ? '読込済み' : '内蔵'],
        ['BIOS9', system.nativeBios9 ? '実機' : system.bios9 ? '読込済み' : '内蔵'],
        ['Firmware', system.firmware ? '読込済み' : '内蔵']].map(([name, value]) => el('p', '', `${name}: ${value}`)));
    };
    controls.append(button('更新', refresh));
    tileElement._systemListener = event => {
      if (event.instanceId === tile.instanceId) void apply(null, refresh);
    };
    input.onchange = () => {
      const images = [...input.files];
      void apply(null, async () => {
        const incoming = images.map(file => ({ file, kind: systemKind(file) }));
        await ensureInstance(tile.instanceId);
        const ids = all.checked ? [...state.instances] : [tile.instanceId];
        const statuses = await Promise.all(ids.map(instanceId => api.status({ instanceId })));
        for (const status of statuses) await api.pause({ instanceId: status.instanceId });
        try {
          for (const { file, kind } of incoming) {
            for (const status of statuses) await api.loadSystemFile({ instanceId: status.instanceId, kind, file });
            if (defaults.checked) await systemFiles.put(file);
          }
        } finally {
          for (const status of statuses) if (status.loaded && !status.paused) await api.resume({ instanceId: status.instanceId });
        }
        await refresh();
      }).finally(() => { input.value = ''; });
    };
    body.addEventListener('target-change', () => void apply(null, refresh));
    void apply(null, refresh);
    return;
  }
  if (tile.type === 'screen') {
    const stack = el('div', 'screens');
    stack.tabIndex = 0;
    stack.setAttribute('aria-label', 'ゲーム画面。方向キー、X=A、Z=B、S=X、A=Y、Q=L、W=R、Enter=START、Shift=SELECT');
    stack.title = '方向キー / X:A Z:B S:X A:Y Q:L W:R Enter:START Shift:SELECT';
    const top = el('canvas'); const bottom = el('canvas');
    top.width = bottom.width = 256; top.height = bottom.height = 192;
    top.setAttribute('aria-label', '上画面'); bottom.setAttribute('aria-label', '下画面');
    const toolbar = el('div', 'screen-toolbar');
    toolbar.append(button('再開', () => { audio.flush(tile.instanceId); return api.resume(args()); }), button('停止', async () => { await api.pause(args()); audio.flush(tile.instanceId); }));
    const rom = el('input'); rom.type = 'file'; rom.accept = '.nds,.srl'; rom.hidden = true;
    rom.setAttribute('aria-label', `インスタンス${tile.instanceId}のROM`);
    rom.onchange = () => void apply(null, async () => {
      const file = rom.files?.[0]; if (!file) return;
      await ensureInstance(tile.instanceId);
      await api.loadRom({ instanceId: tile.instanceId, file });
      state.names.set(tile.instanceId, file.name); filename.textContent = file.name;
    }).finally(() => { rom.value = ''; });
    toolbar.append(button('ROM', () => rom.click()), rom);
    for (const [label, accept, kind] of [['DST', '.dst,.ml', 'state'], ['SAV', '.sav,.dsv', 'save']]) {
      const fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = accept; fileInput.hidden = true;
      fileInput.dataset.loadKind = kind; fileInput.setAttribute('aria-label', `${label}をこのエミュレーターに読み込む`);
      fileInput.onchange = () => { const file = fileInput.files?.[0], id = tile.instanceId; if (!file) return;
        void apply(null, async () => { audio.flush(id); if (kind === 'state') await api.loadState({ instanceId: id, file }); else { await api.importSave({ instanceId: id, file }); await api.reset({ instanceId: id }); }
          for (const item of workspace.querySelectorAll('.tile')) item._debugListener?.({ type: 'debug-stop', instanceId: id });
        }).finally(() => { fileInput.value = ''; });
      };
      toolbar.append(button(label, () => fileInput.click()), fileInput);
    }
    const frameLabel = el('span', 'screen-state', '—'); toolbar.append(frameLabel);
    const destroy = button('中断', async () => { const id = tile.instanceId; await release(); audio.disable(id); await api.destroyInstance({ instanceId: id }); });
    destroy.className = 'screen-destroy'; destroy.title = '実行を停止し、このエミュレーターを破棄'; toolbar.append(destroy);
    const footer = el('div', 'screen-footer');
    const filename = el('span', '', state.names.get(tile.instanceId) || 'ROM未読込');
    const toggleAudio = button('音声 OFF', async () => {
      await audio.toggle(tile.instanceId);
    });
    tileElement._syncAudio = () => { toggleAudio.textContent = audio.has(tile.instanceId) ? '音声 ON' : '音声 OFF'; toggleAudio.setAttribute('aria-pressed', String(audio.has(tile.instanceId))); };
    tileElement._syncAudio();
    const linkInput = el('select'); linkInput.setAttribute('aria-label', '入力連動先');
    linkInput.append(new Option('入力連動なし', ''));
    for (let id = 0; id < MAX_INSTANCES; id++) linkInput.append(new Option(`#${id} と連動`, String(id)));
    linkInput.value = Number.isInteger(tile.settings.inputLink) ? String(tile.settings.inputLink) : '';
    linkInput.onchange = () => void apply(linkInput, async () => {
      await Promise.all([...workspace.querySelectorAll('.tile')].map(node => node._releaseInput?.()));
      tile.settings.inputLink = linkInput.value === '' ? null : Number(linkInput.value); save();
    });
    const targets = () => linkedInputTargets(tile.instanceId);
    footer.append(filename, button('キー入力', () => stack.focus({ preventScroll: true })), linkInput, toggleAudio);
    stack.append(top, bottom);
    const warning = el('div', 'state-warning'); warning.hidden = true; warning.setAttribute('role', 'alert');
    tileElement._stateWarning = info => {
      warning.hidden = !info || stateWarningsDismissed;
      warning.replaceChildren();
      if (info && !stateWarningsDismissed) {
        const message = el('span', 'state-warning-message');
        message.append(el('strong', '', 'DSTのBIOS不一致'), document.createTextNode(` ARM7 · ${info.differences} / ${info.bytes} bytes${info.hle ? ' · DeSmuME HLE' : ''}`));
        const dismiss = el('button', 'state-warning-dismiss', '了解');
        dismiss.type = 'button'; dismiss.onclick = dismissStateWarnings;
        warning.append(message, dismiss);
      }
    };
    const refreshWarning = () => {
      if (stateWarningsDismissed) { tileElement._stateWarning(null); return; }
      tileElement._stateWarning(stateWarnings.get(tile.instanceId));
      const instanceId = tile.instanceId;
      if (state.instances.includes(instanceId)) void api.status({ instanceId }).then(value => {
        if (!stateWarningsDismissed && tile.instanceId === instanceId && warning.isConnected) tileElement._stateWarning(value.stateWarning);
      }).catch(() => {});
    };
    body.append(toolbar, warning, stack, footer); refreshWarning();
    body.addEventListener('target-change', refreshWarning);
    const fit = new ResizeObserver(() => {
      const available = Math.max(1, body.clientHeight - toolbar.offsetHeight - footer.offsetHeight - warning.offsetHeight - 8);
      stack.style.width = `${Math.max(1, Math.min(body.clientWidth - 8, available * 256 / 388))}px`;
    });
    fit.observe(body); fit.observe(toolbar); fit.observe(footer); fit.observe(warning);
    tileElement._cleanup = () => fit.disconnect();
    const held = new Map();
    const keymap = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', KeyX: 'A', KeyZ: 'B', KeyS: 'X', KeyA: 'Y', KeyQ: 'L', KeyW: 'R', Enter: 'START', ShiftLeft: 'SELECT', ShiftRight: 'SELECT' };
    stack.addEventListener('keydown', event => {
      const key = keymap[event.code]; if (!key) return;
      event.preventDefault(); if (held.has(event.code)) return;
      const input = { key, ids: targets(), owner: Symbol(event.code) }; held.set(event.code, input);
      void apply(null, () => linkedKey(input.owner, input.ids, key, true));
    });
    stack.addEventListener('keyup', event => {
      const key = keymap[event.code]; if (!key) return;
      event.preventDefault(); const input = held.get(event.code); if (!input) return;
      held.delete(event.code);
      void apply(null, () => linkedKey(input.owner, input.ids, input.key, false));
    });
    let touchPointer = null, touchedInstances = [], pendingTouch = null, touchFrame = 0;
    const touchQueue = [];
    let touchDrain = null;
    const sendTouch = (value, coalesce = false) => {
      const packet = { ids: [...touchedInstances], value, coalesce }, tail = touchQueue.at(-1);
      if (coalesce && tail?.coalesce && String(tail.ids) === String(packet.ids)) touchQueue[touchQueue.length - 1] = packet;
      else touchQueue.push(packet);
      if (!touchDrain) touchDrain = (async () => {
        try {
          while (touchQueue.length) {
            const current = touchQueue.shift();
            await Promise.all(current.ids.map(instanceId => api.touch({ instanceId, ...current.value }).catch(errorMessage)));
          }
        } finally { touchDrain = null; }
      })();
      return touchDrain;
    };
    const release = () => {
      const releases = [];
      for (const input of held.values()) releases.push(linkedKey(input.owner, input.ids, input.key, false).catch(() => {}));
      held.clear();
      cancelAnimationFrame(touchFrame); touchFrame = 0; pendingTouch = null;
      if (touchedInstances.length) sendTouch({ x: 0, y: 0, pressed: false });
      touchPointer = null; touchedInstances = [];
      return Promise.all([...releases, touchDrain]);
    };
    tileElement._releaseInput = release;
    stack.addEventListener('blur', release);
    const touch = (event, immediate = false) => {
      const rect = bottom.getBoundingClientRect();
      pendingTouch = {
        x: Math.max(0, Math.min(255, Math.floor((event.clientX - rect.left) * 256 / rect.width))),
        y: Math.max(0, Math.min(191, Math.floor((event.clientY - rect.top) * 192 / rect.height))), pressed: true };
      const flush = () => { touchFrame = 0; if (pendingTouch) { sendTouch(pendingTouch, !immediate); pendingTouch = null; } };
      if (immediate) flush(); else if (!touchFrame) touchFrame = requestAnimationFrame(flush);
    };
    bottom.addEventListener('pointerdown', event => {
      if (event.button !== 0 || touchPointer !== null) return;
      stack.focus(); bottom.setPointerCapture(event.pointerId);
      touchPointer = event.pointerId; touchedInstances = targets(); touch(event, true);
    });
    bottom.addEventListener('pointermove', event => { if (event.pointerId === touchPointer) touch(event); });
    bottom.addEventListener('pointerup', release); bottom.addEventListener('pointercancel', release);
    let frameLabelTimer = 0, latestFrame;
    const draw = event => {
      if (event.type !== 'frame' || event.instanceId !== tile.instanceId) return;
      if (event.frame !== undefined) {
        latestFrame = event.frame;
        if (!frameLabelTimer) frameLabelTimer = setTimeout(() => {
          frameLabelTimer = 0;
          if (body.isConnected) frameLabel.textContent = `${latestFrame} f`;
        }, 100);
      }
      const name = state.names.get(tile.instanceId) || 'ROM未読込';
      if (filename.textContent !== name) filename.textContent = name;
      for (const [canvas, pixels] of [[top, event.top], [bottom, event.bottom]]) {
        if (!pixels || pixels.length !== 256 * 192 * 4) continue;
        const rgba = ArrayBuffer.isView(pixels)
          ? new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength)
          : new Uint8ClampedArray(pixels);
        canvas.getContext('2d').putImageData(new ImageData(rgba, 256, 192), 0, 0);
      }
    };
    tileElement._frameListener = draw;
    body.addEventListener('target-change', () => {
      clearTimeout(frameLabelTimer); frameLabelTimer = 0;
      tileElement._syncAudio();
      for (const canvas of [top, bottom]) canvas.getContext('2d').clearRect(0, 0, 256, 192);
      frameLabel.textContent = '—'; filename.textContent = state.names.get(tile.instanceId) || 'ROM未読込';
      const instanceId = tile.instanceId;
      if (state.instances.includes(instanceId)) void api.screenshot({ instanceId }).then(frame => draw({ ...frame, type: 'frame', instanceId })).catch(() => {});
    });
    queueMicrotask(() => body.dispatchEvent(new Event('target-change')));
    return;
  }
  if (tile.type === 'local-log' || tile.type === 'wifi-log') return renderLog(body, tile);
  const controls = row(body);
  const output = readout(body);
  const act = (label, fn) => controls.append(button(label, async () => { output.textContent = fmt(await fn()); }));
  body.addEventListener('target-change', () => { output.textContent = '—'; });
  if (tile.type === 'debugger') {
    tileElement._debugListener = event => { if (event.instanceId === tile.instanceId) output.textContent = fmt(event); };
    act('一時停止', () => api.pause(args())); act('再開', () => api.resume(args()));
    act('リセット', () => api.reset(args())); act('ステップ', () => api.step(args()));
    act('ステップオーバー', () => api.stepOver(args()));
    const address = textInput(controls, '到達PC (hex)', '02000000');
    act('指定位置まで', () => api.runUntil(args({ address: hex(address) })));
    act('状態取得', () => api.status(args()));
    act('呼出履歴', () => api.callStack(args()));
    const frames = textInput(controls, '待つフレーム数', '60');
    act('フレーム待機', () => api.waitFrames(args({ frames: Number(frames.value) })));
  } else if (tile.type === 'memory') {
    const address = textInput(controls, '開始アドレス (hex)', '02000000');
    const length = textInput(controls, '長さ (byte)', '64');
    act('読み取り', () => api.readMemory(args({ address: hex(address), length: Number(length.value) })));
    const content = textInput(controls, '書き込みhex');
    act('書き込み', () => api.writeMemory(args({ address: hex(address), data: bytes(content) })));
    act('検索', () => api.memorySearch(args({ address: hex(address), length: Number(length.value), pattern: bytes(content) })));
    act('固定', () => api.memoryFreeze(args({ address: hex(address), data: bytes(content) })));
    act('固定解除', () => api.removeMemoryFreeze(args({ address: hex(address) })));
    act('値を待つ', () => api.waitMemory(args({ address: hex(address), pattern: bytes(content) })));
  } else if (tile.type === 'registers') {
    let refreshing = false, closed = false;
    const showRegisters = async () => {
      if (refreshing || closed) return;
      refreshing = true;
      try {
      const target = args(), current = await api.status(target);
      for (const field of output.querySelectorAll('input')) field.disabled = !current.paused;
      if (output.contains(document.activeElement) && current.paused) return;
      const registers = await api.getRegisters(target);
      if (closed || target.instanceId !== tile.instanceId || target.cpu !== tile.cpu) return;
      output.className = 'register-grid'; output.replaceChildren();
      for (const [name, value] of Object.entries(registers)) {
        const item = el('label', 'register-cell'), field = el('input');
        field.value = (value >>> 0).toString(16).toUpperCase().padStart(8, '0');
        field.maxLength = 10; field.spellcheck = false; field.disabled = !current.paused;
        field.setAttribute('aria-label', `${target.cpu} ${name.toUpperCase()} (hex)`);
        field.onchange = () => void apply(null, async () => {
          if (!(await api.status(target)).paused) throw Error('レジスタの編集は停止中に行ってください');
          const value = hex(field); field.disabled = true;
          await api.setRegister({ ...target, register: name, value });
          field.blur(); await showRegisters();
        });
        field.onkeydown = event => { if (event.key === 'Enter') field.blur(); };
        item.append(el('span', '', name.toUpperCase()), field);
        output.append(item);
      }
      } finally { refreshing = false; }
    };
    controls.append(button('更新', showRegisters));
    tileElement._debugListener = event => { if (event.instanceId === tile.instanceId) void showRegisters().catch(errorMessage); };
    const timer = setInterval(() => void showRegisters().catch(() => {}), 300);
    tileElement._cleanup = () => { closed = true; clearInterval(timer); };
    body.addEventListener('target-change', () => void showRegisters().catch(errorMessage));
    void showRegisters().catch(errorMessage);
  } else if (tile.type === 'disassembly') {
    const address = textInput(controls, '開始アドレス (hex)', '02000000');
    act('逆アセンブル', () => api.disassemble(args({ address: hex(address), count: 16 })));
  } else if (tile.type === 'breakpoints') {
    const address = textInput(controls, 'アドレス (hex)', '02000000');
    const kind = el('select');
    for (const value of ['execute', 'read', 'write', 'access', 'dataAbort', 'prefetchAbort', 'undefinedInstruction']) kind.append(new Option(value, value));
    controls.append(kind);
    act('追加', () => api.addBreakpoint(args({ address: hex(address), type: kind.value })));
    act('削除', () => api.removeBreakpoint(args({ address: hex(address) })));
    act('一覧', () => api.listBreakpoints(args()));
  } else if (tile.type === 'input') {
    let sequenceTargets = [];
    const stopSequence = async () => {
      const ids = [...new Set([...sequenceTargets, ...linkedInputTargets(tile.instanceId)])];
      sequenceTargets = [];
      return Promise.all(ids.filter(id => state.instances.includes(id)).map(instanceId => api.stopInputSequence({ instanceId })));
    };
    const keyReleases = [];
    tileElement._releaseInput = () => Promise.all(keyReleases.map(release => release()));
    act('記録開始', () => api.startInputRecording(args()));
    act('記録停止', () => api.stopInputRecording(args()));
    act('入力履歴', () => api.getInputRecording(args()));
    act('記録を再生', async () => {
      const recording = await api.getInputRecording(args());
      if (recording.truncated) throw Error('入力記録が上限を超えています');
      sequenceTargets = linkedInputTargets(tile.instanceId);
      return Promise.all(sequenceTargets.map(instanceId => api.inputSequence({ instanceId, events: recording.events })));
    });
    act('再生停止', stopSequence);
    for (const key of ['A', 'B', 'X', 'Y', 'L', 'R', 'START', 'SELECT', 'UP', 'DOWN', 'LEFT', 'RIGHT']) {
      const item = el('button', '', key); item.type = 'button';
      let pressed = false;
      let pressedTargets = [];
      const owner = Symbol(key);
      const set = active => {
        if (pressed === active) return;
        pressed = active; item.setAttribute('aria-pressed', String(active));
        if (active) pressedTargets = linkedInputTargets(tile.instanceId);
        const targets = pressedTargets;
        if (!active) pressedTargets = [];
        return apply(null, () => linkedKey(owner, targets, key, active));
      };
      keyReleases.push(() => set(false));
      item.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        item.setPointerCapture(event.pointerId); set(true);
      });
      item.addEventListener('pointerup', () => set(false));
      item.addEventListener('pointercancel', () => set(false));
      item.addEventListener('keydown', event => {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault(); set(true);
      });
      item.addEventListener('keyup', event => {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault(); set(false);
      });
      item.addEventListener('blur', () => set(false));
      controls.append(item);
    }
    const repeatControls = row(body); repeatControls.classList.add('repeat-controls');
    const repeatKey = el('select'); repeatKey.setAttribute('aria-label', '連打するボタン');
    for (const key of ['A', 'B', 'X', 'Y', 'L', 'R', 'START', 'SELECT', 'UP', 'DOWN', 'LEFT', 'RIGHT']) repeatKey.append(new Option(key, key));
    repeatControls.append(repeatKey);
    const repeatCount = textInput(repeatControls, '回数', '120'); repeatCount.type = 'number'; repeatCount.min = 1; repeatCount.max = 50000;
    const pressFrames = textInput(repeatControls, '押下フレーム数', '2'); pressFrames.type = 'number'; pressFrames.min = 1;
    const releaseFrames = textInput(repeatControls, '解放フレーム数', '2'); releaseFrames.type = 'number'; releaseFrames.min = 1;
    repeatControls.append(button('連打', async () => {
      sequenceTargets = linkedInputTargets(tile.instanceId);
      await Promise.all(sequenceTargets.map(async instanceId => {
        await api.repeatInput({ instanceId, keys: [repeatKey.value], count: Number(repeatCount.value), pressFrames: Number(pressFrames.value), releaseFrames: Number(releaseFrames.value) });
        await api.resume({ instanceId });
      }));
      output.textContent = `${repeatKey.value} × ${repeatCount.value} 回`;
    }), button('連打を停止', async () => { await stopSequence(); output.textContent = '連打を停止しました'; }));
  } else if (tile.type === 'state') {
    const slot = textInput(controls, 'スロット (0-9)', '0');
    act('ステート保存', () => api.saveState(args({ slot: Number(slot.value) })));
    act('ステート読込', () => api.loadState(args({ slot: Number(slot.value) })));
    act('ブラウザへステート保存', () => api.saveStateToBrowser(args({ slot: Number(slot.value) })));
    act('ブラウザからステート復元', () => api.loadStateFromBrowser(args({ slot: Number(slot.value) })));
    act('ブラウザへSave保存', () => api.saveSaveToBrowser(args()));
    act('ブラウザからSave復元', () => api.loadSaveFromBrowser(args()));
    act('ブラウザ内の一覧', () => api.listBrowserStates(args()));
    controls.append(button('ステートを書き出す', async () => {
      const data = await api.exportState(args({ slot: Number(slot.value) }));
      download(new Uint8Array(data), `instance-${tile.instanceId}-slot-${slot.value}.ml`);
    }));
    controls.append(button('Saveを書き出す', async () => {
      const data = await api.exportSave(args());
      download(new Uint8Array(data), `instance-${tile.instanceId}.sav`);
    }));
    const stateInput = el('input'); stateInput.type = 'file'; stateInput.accept = '.ml,.ml0,.ml1,.ml2,.ml3,.ml4,.ml5,.ml6,.ml7,.ml8,.ml9,.dst,.sav,.dsv';
    stateInput.setAttribute('aria-label', 'State または Save をインポート');
    stateInput.onchange = () => void apply(null, async () => {
      const file = stateInput.files?.[0]; if (!file) return;
      if (/\.(sav|dsv)$/i.test(file.name)) { await api.importSave(args({ file })); await api.reset(args()); }
      else await api.loadState(args({ slot: Number(slot.value), file }));
      output.textContent = `${file.name} · 読込済み`;
    }).finally(() => { stateInput.value = ''; });
    body.insertBefore(stateInput, output);
    controls.append(button('スクリーンショット', async () => {
      const frame = await api.screenshot(args());
      const canvas = document.createElement('canvas'); canvas.width = frame.width; canvas.height = frame.height * 2;
      const context = canvas.getContext('2d');
      context.putImageData(new ImageData(new Uint8ClampedArray(frame.top), frame.width, frame.height), 0, 0);
      context.putImageData(new ImageData(new Uint8ClampedArray(frame.bottom), frame.width, frame.height), 0, frame.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      if (!blob) throw Error('Screenshot encoding failed');
      download(blob, `instance-${tile.instanceId}.png`, 'image/png');
    }));
    act('フレーム基準を保存', () => api.captureFrame(args()));
    act('フレーム差分', () => api.compareFrames(args()));
  } else if (tile.type === 'script') {
    const code = el('textarea'); code.rows = 5; code.placeholder = 'await mcp.call("status", { instanceId: 0 })';
    code.value = tile.settings.code || '';
    code.addEventListener('input', () => { tile.settings.code = code.value; save(); });
    body.insertBefore(code, output);
    act('実行', () => api.runScript(args({ code: code.value })));
  } else if (tile.type === 'persistent-scripts') {
    const name = textInput(controls, 'スクリプト名');
    const code = el('textarea'); code.rows = 5; code.placeholder = 'emu_ontick(async () => { /* ... */ });';
    code.value = tile.settings.code || '';
    code.addEventListener('input', () => { tile.settings.code = code.value; save(); });
    body.insertBefore(code, output);
    act('一覧', () => api.listPersistentScripts(args()));
    act('開始', () => api.startPersistentScript(args({ name: name.value, code: code.value })));
    act('停止', () => api.stopPersistentScript(args({ name: name.value })));
    act('再起動', () => api.restartPersistentScript(args({ name: name.value })));
  }
}

function renderTile(tile) {
  const node = $('#tile-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = tile.id; node.dataset.type = tile.type;
  node.querySelector('.tile-title').textContent = LABELS[tile.type];
  node.querySelector('.tile-id').textContent = `#${String(tile.instanceId).padStart(2, '0')}`;
  if (tile.type === 'files' || tile.type === 'workspace') {
    node.querySelector('.tile-id').textContent = tile.type === 'files' ? 'DLC' : '.mel';
    node.querySelector('.tile-target').hidden = true;
  }
  const select = node.querySelector('.instance-select'); populateInstances(select, tile.instanceId);
  select.onchange = () => {
    node._releaseInput?.();
    tile.instanceId = Number(select.value); node.querySelector('.tile-id').textContent = `#${select.value.padStart(2, '0')}`;
    save(); updateScreenTargets(); updateAudioTargets(); node.querySelector('.tile-body').dispatchEvent(new Event('target-change'));
  };
  const cpu = node.querySelector('.cpu-select'); cpu.value = tile.cpu;
  cpu.onchange = () => { tile.cpu = cpu.value; save(); node.querySelector('.tile-body').dispatchEvent(new Event('target-change')); };
  if (['screen', 'local-log', 'wifi-log', 'input', 'state', 'save', 'script', 'persistent-scripts', 'system', 'workspace', 'files'].includes(tile.type)) node.querySelector('.cpu-label').hidden = true;
  const min = node.querySelector('.tile-minimize');
  min.onclick = () => { tile.minimized = !tile.minimized; node.classList.toggle('minimized', tile.minimized); min.setAttribute('aria-label', tile.minimized ? '展開' : '最小化'); save(); updateScreenTargets(); };
  node.classList.toggle('minimized', tile.minimized);
  node.querySelector('.tile-close').onclick = () => { node._releaseInput?.(); node._cleanup?.(); node._resizeObserver?.disconnect(); layout.tiles.splice(layout.tiles.indexOf(tile), 1); node.remove(); save(); updateScreenTargets(); updateAudioTargets(); refreshSummary(); $('#workspace-empty').hidden = !!layout.tiles.length; };
  node.style.zIndex = tile.z;
  if (layout.mode === 'free') place(node, tile);
  else if (tile.gridHeight) node.style.height = `${tile.gridHeight}px`;
  const grip = el('div', 'tile-width-grip');
  grip.setAttribute('role', 'separator'); grip.setAttribute('aria-label', '横幅を変更'); grip.setAttribute('aria-orientation', 'vertical');
  grip.tabIndex = 0; node.append(grip);
  const columns = () => Math.max(1, getComputedStyle(workspace).gridTemplateColumns.split(' ').filter(Boolean).length);
  node._gridSpan = () => {
    if (layout.mode !== 'grid') return;
    node.style.gridColumn = `span ${Math.max(1, Math.min(columns(), tile.gridSpan || (['wifi-log','local-log','files'].includes(tile.type) ? 2 : 1)))}`;
  };
  grip.onpointerdown = event => {
    if (layout.mode !== 'grid' || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const start = event.clientX, count = columns(), gap = parseFloat(getComputedStyle(workspace).columnGap) || 0;
    const unit = (workspace.clientWidth + gap) / count, width = node.getBoundingClientRect().width;
    grip.setPointerCapture(event.pointerId); document.body.classList.add('is-column-resizing');
    const move = e => { tile.gridSpan = Math.max(1, Math.min(count, Math.round((width + e.clientX - start + gap) / unit))); node._gridSpan(); };
    const end = () => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', end); grip.removeEventListener('pointercancel', end);
      document.body.classList.remove('is-column-resizing'); save();
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
  };
  grip.onkeydown = event => {
    if (!['ArrowLeft','ArrowRight'].includes(event.key) || layout.mode !== 'grid') return;
    event.preventDefault(); tile.gridSpan = Math.max(1, Math.min(columns(), (tile.gridSpan || 1) + (event.key === 'ArrowRight' ? 1 : -1))); node._gridSpan(); save();
  };
  node.addEventListener('pointerdown', () => { tile.z = Math.max(1, ...layout.tiles.map(t => t.z || 1)) + 1; node.style.zIndex = tile.z; save(); });
  const header = node.querySelector('.tile-header');
  header.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    if (layout.mode === 'grid') {
      if (!event.target.closest('.tile-handle')) return;
      event.preventDefault(); event.stopPropagation();
      const rect = node.getBoundingClientRect();
      const count = columns(), gap = parseFloat(getComputedStyle(workspace).columnGap) || 0;
      const unit = (workspace.clientWidth + gap) / count;
      const span = Math.max(1, Math.min(count, Math.round((rect.width + gap) / unit)));
      const placeholder = el('div', 'tile-drop-placeholder');
      placeholder.style.height = `${rect.height}px`; placeholder.style.gridColumn = `span ${span}`;
      node.before(placeholder);
      const previousStyle = Object.fromEntries(['position', 'left', 'top', 'width', 'height', 'zIndex', 'pointerEvents', 'resize']
        .map(property => [property, node.style[property]]));
      const offsetX = event.clientX - rect.left, offsetY = event.clientY - rect.top;
      header.setPointerCapture(event.pointerId); document.body.classList.add('is-grabbing'); node.classList.add('grid-dragging');
      Object.assign(node.style, {
        position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
        zIndex: '10001', pointerEvents: 'none', resize: 'none'
      });
      const movePlaceholder = (x, y) => {
        const candidates = [...workspace.querySelectorAll('.tile')].filter(candidate => candidate !== node);
        if (!candidates.length) { workspace.append(placeholder); return; }
        let closest = null, closestRect = null, closestDistance = Infinity;
        for (const candidate of candidates) {
          const candidateRect = candidate.getBoundingClientRect();
          const dx = x - (candidateRect.left + candidateRect.width / 2);
          const dy = y - (candidateRect.top + candidateRect.height / 2);
          const distance = dx * dx + dy * dy;
          if (distance < closestDistance) { closest = candidate; closestRect = candidateRect; closestDistance = distance; }
        }
        const centerY = closestRect.top + closestRect.height / 2;
        const sameRow = y >= closestRect.top && y <= closestRect.bottom;
        const after = sameRow ? x > closestRect.left + closestRect.width / 2 : y > centerY;
        closest[after ? 'after' : 'before'](placeholder);
      };
      const move = e => {
        node.style.left = `${e.clientX - offsetX}px`; node.style.top = `${e.clientY - offsetY}px`;
        movePlaceholder(e.clientX, e.clientY);
      };
      const end = e => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end);
        document.body.classList.remove('is-grabbing'); node.classList.remove('grid-dragging');
        if (e.type === 'pointercancel') placeholder.remove();
        else {
          movePlaceholder(e.clientX, e.clientY);
          placeholder.replaceWith(node);
          const order = new Map([...workspace.querySelectorAll('.tile')].map((element, index) => [element.dataset.id, index]));
          layout.tiles.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
        }
        Object.assign(node.style, previousStyle); save();
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
      return;
    }
    if (layout.mode !== 'free') return;
    const startX = event.clientX, startY = event.clientY, left = tile.x, top = tile.y;
    const handle = event.currentTarget; handle.setPointerCapture(event.pointerId);
    document.body.classList.add('is-grabbing');
    const move = e => { tile.x = Math.max(0, left + e.clientX - startX); tile.y = Math.max(0, top + e.clientY - startY); place(node, tile); };
    const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); document.body.classList.remove('is-grabbing'); save(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  });
  node._resizeObserver = new ResizeObserver(() => {
    if (!node.isConnected || tile.minimized || node.classList.contains('grid-dragging')) return;
    const rect = node.getBoundingClientRect();
    if (layout.mode !== 'free') {
      if (tile.gridHeight !== Math.round(rect.height)) { tile.gridHeight = Math.round(rect.height); save(); }
      return;
    }
    if (Math.abs(rect.width - tile.width) > 1 || Math.abs(rect.height - tile.height) > 1) {
      tile.width = rect.width; tile.height = rect.height; save();
    }
  });
  node._resizeObserver.observe(node);
  renderBody(node.querySelector('.tile-body'), tile, node);
  workspace.append(node);
  node._gridSpan();
}
function place(node, tile) {
  node.style.left = `${tile.x}px`; node.style.top = `${tile.y}px`;
  node.style.width = `${tile.width}px`; node.style.height = `${tile.height}px`;
}
function renderLayout() {
  for (const node of workspace.querySelectorAll('.tile')) { node._releaseInput?.(); node._cleanup?.(); node._resizeObserver?.disconnect(); }
  workspace.replaceChildren();
  workspace.className = `workspace ${layout.mode}`;
  for (const tile of layout.tiles) renderTile(tile);
  $('#workspace-empty').hidden = !!layout.tiles.length;
  for (const [mode, id] of [['grid', '#grid-mode'], ['free', '#free-mode']]) $(id).setAttribute('aria-pressed', String(layout.mode === mode));
  refreshSummary();
  updateScreenTargets();
  updateAudioTargets();
}
function renderPalette() {
  const order = layout.toolOrder = [...new Set([...(layout.toolOrder || []), ...TILE_TYPES])].filter(type => TILE_TYPES.includes(type));
  $('#palette-tools').replaceChildren(); $('#tool-order-list').replaceChildren();
  for (const [index, type] of order.entries()) {
  const node = $('#palette-template').content.firstElementChild.cloneNode(true);
  node.querySelector('.palette-name').textContent = LABELS[type];
  node.querySelector('.palette-icon').textContent = ({ screen: '▣', debugger: '⌁', memory: '▤', disassembly: '≡', registers: 'R', breakpoints: '◆', callstack: '↳', save: '▱', 'local-log': '↔', 'wifi-log': '◉', script: '⌘', 'persistent-scripts': '⟲', input: '＋', state: '◫', files: '▥', system: '⚙', workspace: '◫' })[type];
  node.onclick = () => addTile(type, 16 + layout.tiles.length * 24, 16 + layout.tiles.length * 24);
  node.ondragstart = event => { event.dataTransfer.setData('text/plain', type); event.dataTransfer.effectAllowed = 'copy'; };
  $('#palette-tools').append(node);
  const item = el('div', 'tool-order-row'); item.dataset.type = type;
  item.append(el('span', 'tool-order-grip', '⠿'), el('span', '', LABELS[type]));
  item.onpointerdown = event => {
    if (event.button !== 0 || !event.target.closest('.tool-order-grip')) return;
    event.preventDefault(); event.stopPropagation();
    const list = $('#tool-order-list'), rect = item.getBoundingClientRect();
    const placeholder = el('div', 'tool-order-placeholder');
    placeholder.style.height = `${rect.height}px`; item.before(placeholder);
    const previousStyle = Object.fromEntries(['position', 'left', 'top', 'width', 'height', 'zIndex', 'pointerEvents']
      .map(property => [property, item.style[property]]));
    const offsetX = event.clientX - rect.left, offsetY = event.clientY - rect.top;
    item.setPointerCapture(event.pointerId); document.body.classList.add('is-grabbing'); item.classList.add('moving');
    Object.assign(item.style, {
      position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`, zIndex: '10002', pointerEvents: 'none'
    });
    const move = e => {
      item.style.left = `${e.clientX - offsetX}px`; item.style.top = `${e.clientY - offsetY}px`;
      const rows = [...list.querySelectorAll('.tool-order-row')].filter(row => row !== item);
      if (!rows.length) { list.append(placeholder); return; }
      let closest = null, closestRect = null, closestDistance = Infinity;
      for (const row of rows) {
        const rowRect = row.getBoundingClientRect(), distance = Math.abs(e.clientY - (rowRect.top + rowRect.height / 2));
        if (distance < closestDistance) { closest = row; closestRect = rowRect; closestDistance = distance; }
      }
      closest[e.clientY > closestRect.top + closestRect.height / 2 ? 'after' : 'before'](placeholder);
    };
    const end = e => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end);
      document.body.classList.remove('is-grabbing'); item.classList.remove('moving');
      const committed = e.type !== 'pointercancel';
      if (e.type === 'pointercancel') placeholder.remove();
      else {
        move(e);
        placeholder.replaceWith(item);
        layout.toolOrder = [...list.querySelectorAll('.tool-order-row')].map(row => row.dataset.type);
      }
      Object.assign(item.style, previousStyle); save();
      if (committed) renderPalette();
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
  };
  $('#tool-order-list').append(item);
  }
}
renderPalette();
new ResizeObserver(() => { for (const node of workspace.querySelectorAll('.tile')) node._gridSpan?.(); }).observe(workspace);
workspace.ondragover = event => { if (event.dataTransfer.types.includes('text/plain')) event.preventDefault(); };
workspace.ondrop = event => {
  const type = event.dataTransfer.getData('text/plain');
  if (!TILE_TYPES.includes(type)) return;
  event.preventDefault();
  const rect = workspace.getBoundingClientRect();
  addTile(type, event.clientX - rect.left + workspace.scrollLeft, event.clientY - rect.top + workspace.scrollTop);
};
for (const mode of ['grid', 'free']) $(`#${mode}-mode`).onclick = () => { layout.mode = mode; save(); renderLayout(); };
async function ensureInstance(id) {
  if (state.instances.includes(id)) return id;
  await api.createInstance({ instanceId: id });
  if (!state.instances.includes(id)) state.instances.push(id);
  refreshSummary(); return id;
}
function requestedInstanceCount() {
  const count = Number($('#instance-count').value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_INSTANCES) throw Error('台数は1〜16で指定してください');
  return count;
}
async function ensureBulkTargets() {
  const count = requestedInstanceCount();
  for (let id = 0; state.instances.length < count && id < MAX_INSTANCES; id++) await ensureInstance(id);
  return [...state.instances].sort((a, b) => a - b).slice(0, count);
}
async function ensureHeaderBulkTargets() {
  const end = Number($('#bulk-end-instance').value);
  if (!Number.isInteger(end) || end < 0 || end >= MAX_INSTANCES) throw Error('一括読込範囲が不正です');
  for (let id = 0; id <= end; id++) await ensureInstance(id);
  return Array.from({ length: end + 1 }, (_, id) => id);
}
async function loadRomTargets(targets, file) {
  if (loadDelayMs() === 0 && targets.length > 1) {
    await api.loadRomMany({ instanceIds: targets, file });
  } else {
    const startedAt = performance.now();
    await Promise.all(targets.map(async (instanceId, index) => {
      await waitForLoadDelay(index, startedAt);
      await api.loadRom({ instanceId, file });
    }));
  }
  for (const instanceId of targets) { state.names.set(instanceId, file.name); ensureScreen(instanceId); }
}
async function loadStateTargets(targets, file) {
  const statuses = await Promise.all(targets.map(instanceId => api.status({ instanceId })));
  if (statuses.some(status => !status.loaded)) throw Error('DST / MLの一括読込先には先にROMを読み込んでください');
  const startedAt = performance.now();
  await Promise.all(targets.map(async (instanceId, index) => {
    await waitForLoadDelay(index, startedAt);
    audio.flush(instanceId);
    await api.loadState({ instanceId, file });
    for (const item of workspace.querySelectorAll('.tile')) item._debugListener?.({ type: 'debug-stop', instanceId });
  }));
}
$('#create-instance').onclick = event => apply(event.currentTarget, async () => {
  const result = await api.createInstance({});
  const id = typeof result === 'number' ? result : result?.instanceId;
  if (!Number.isInteger(id) || id < 0 || id >= 16) throw Error('バックエンドが有効なinstanceIdを返しませんでした');
  if (!state.instances.includes(id)) state.instances.push(id);
  refreshSummary();
  $('#rom-instance').value = String(id);
  if (!layout.tiles.some(tile => tile.type === 'screen' && tile.instanceId === id)) addTile('screen', 16 + id * 24, 16 + id * 24);
});
$('#open-rom').onclick = () => $('#rom-file').click();
$('#bulk-rom').onclick = () => $('#bulk-rom-file').click();
$('#bulk-state').onclick = () => $('#bulk-state-file').click();

$('#rom-target').onchange = () => { $('#instance-count-label').hidden = $('#rom-target').value !== 'all'; };
$('#rom-target').onchange();
$('#rom-file').onchange = event => {
  const input = event.currentTarget, file = input.files?.[0];
  if (!file) return;
  void apply(null, async () => {
    if ($('#rom-target').value === 'all') {
      await loadRomTargets(await ensureBulkTargets(), file);
    } else {
      const id = Number($('#rom-instance').value);
      await ensureInstance(id);
      await loadRomTargets([id], file);
    }
    refreshSummary();
  }).finally(() => { input.value = ''; });
};
$('#bulk-rom-file').onchange = event => {
  const input = event.currentTarget, file = input.files?.[0]; if (!file) return;
  void apply($('#bulk-rom'), async () => {
    await loadRomTargets(await ensureHeaderBulkTargets(), file);
    refreshSummary();
  }).finally(() => { input.value = ''; });
};
$('#bulk-state-file').onchange = event => {
  const input = event.currentTarget, file = input.files?.[0]; if (!file) return;
  void apply($('#bulk-state'), async () => {
    await loadStateTargets(await ensureHeaderBulkTargets(), file);
  }).finally(() => { input.value = ''; });
};
api.subscribe(event => {
  if (event.type === 'state-warning') {
    if (event.warning) { stateWarningsDismissed = false; stateWarnings.set(event.instanceId, event.warning); }
    else stateWarnings.delete(event.instanceId);
    for (const node of workspace.querySelectorAll('.tile')) {
      const model = layout.tiles.find(tile => tile.id === node.dataset.id);
      if (model?.instanceId === event.instanceId) { node._stateWarning?.(event.warning); node._systemListener?.(event); }
    }
    return;
  }
  if (!event || typeof event !== 'object') return;
  if (event.type === 'instance-change') {
    if (event.action === 'destroyInstance') {
      state.instances = state.instances.filter(id => id !== event.instanceId); state.names.delete(event.instanceId);
      globalThis.melondsVirtualNetwork.unregister({ instanceId: event.instanceId });

      audio.disable(event.instanceId);
      for (const node of workspace.querySelectorAll('[data-type=screen]')) {
        const model = layout.tiles.find(t => t.id === node.dataset.id);
        if (model?.instanceId === event.instanceId) { node._releaseInput?.(); node.querySelector('.tile-body').dispatchEvent(new Event('target-change')); }
      }
    } else if (event.action === 'createInstance' && !state.instances.includes(event.instanceId)) state.instances.push(event.instanceId);
    if (event.romName) state.names.set(event.instanceId, event.romName);
    if (event.action === 'loadRom' || event.action === 'loadRomMany') audio.flush(event.instanceId);
    for (const node of workspace.querySelectorAll('.tile')) {
      node._debugListener?.({ type: 'debug-stop', instanceId: event.instanceId });
      node._systemListener?.(event);
    }
    refreshSummary();
    return;
  }
  if (event.type === 'audio') { playAudio(event); return; }
  if (event.type === 'breakpoint' || event.type === 'debug-stop') {
    for (const tile of workspace.querySelectorAll('.tile')) tile._debugListener?.(event);
    return;
  }
  if (event.type === 'frame') {
    for (const tile of workspace.querySelectorAll('[data-type=screen]')) tile._frameListener?.(event);
    return;
  }
  if (!['local-log', 'wifi-log'].includes(event.type) || !Number.isInteger(event.instanceId)) return;
  const list = state.logs[event.type]; list.push(event);
  retainLogs(event.type, list);
  queueLogUpdate(event.type);
});
renderLayout();
function ensureScreen(id) {
  if (layout.tiles.some(t => t.type === 'screen' && t.instanceId === id)) return;
  const tile = makeTile('screen', { instanceId: id, x: 16 + id * 24, y: 16 + id * 24 });
  layout.tiles.push(tile); renderTile(tile); save(); updateScreenTargets(); refreshSummary();
}
function jumpTo({ type, instanceId, cpu, address, thumb }) {
  let model = layout.tiles.find(t => t.type === type && t.instanceId === instanceId && t.cpu === cpu);
  if (!model) { model = makeTile(type, { instanceId, cpu, x: 32, y: 32, width: 680, height: 460 }); layout.tiles.push(model); renderTile(model); }
  model.minimized = false;
  const node = [...workspace.querySelectorAll('.tile')].find(n => n.dataset.id === model.id);
  node.classList.remove('minimized'); node.querySelector('.tile-body').dispatchEvent(new CustomEvent('address-jump', { detail: { address, thumb } }));
  node.scrollIntoView({ block: 'nearest' }); save(); refreshSummary();
}
  void apply(null, async () => {
    const list = await api.listInstances();
    $('#backend-status').textContent = '接続済み';
    $('#backend-status').dataset.ready = 'true';
    state.instances = list.map(value => typeof value === 'number' ? value : value.instanceId);
    if (!state.instances.length) await ensureInstance(0);
    refreshSummary();
  });
void registerWebMcp(api).catch(errorMessage);
window.addEventListener('blur', () => { for (const node of workspace.querySelectorAll('.tile')) node._releaseInput?.(); });
document.addEventListener('melonds-state-loaded', event => { for (const node of workspace.querySelectorAll('.tile')) node._debugListener?.({ type: 'debug-stop', ...event.detail }); });
