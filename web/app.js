import { createApi, MAX_INSTANCES } from './api.js';
import { systemFiles, systemKind } from './system-files.js';
import { createWorkspaceService } from './workspace-service.js';
import { createWasmBackend } from './backend.js';
import { createScriptBackend } from './script-service.js';
import { loadLayout, saveLayout, makeTile, TILE_TYPES, LABELS } from './layout.js';
import { registerWebMcp } from './webmcp.js';
import { createVirtualNetwork } from './virtual-network.js';
import { renderFileExplorer } from './file-explorer.js';
import { renderDebuggerTool } from './debugger-ui.js';
import { renderStorageTool } from './storage-ui.js';
import { createAudioBus } from './audio.js';
import { decodePacket } from './packet-decode.js';

const $ = selector => document.querySelector(selector);
const workspace = $('#workspace');
const layout = loadLayout();
const backend = createScriptBackend(createWasmBackend());
const api = createApi(backend);
const state = { instances: [], names: new Map(), logs: { 'local-log': [], 'wifi-log': [] }, pending: new Set() };
const audio = createAudioBus({ onTargets: ids => backend.setAudioTargets(ids), onChange: updateAudioTargets });
globalThis.melondsAudio = Object.freeze({ stats: () => audio.stats() });
globalThis.melonds = api;
globalThis.melondsVirtualNetwork = createVirtualNetwork(api, { onEvent: event => {
  if (event.type !== 'wifi-log') return;
  state.logs['wifi-log'].push(event);
  if (state.logs['wifi-log'].length > 2000) state.logs['wifi-log'].splice(0, state.logs['wifi-log'].length - 2000);
  for (const tile of workspace.querySelectorAll('[data-type="wifi-log"]')) tile.querySelector('.tile-body').dispatchEvent(new Event('packet'));
} });
globalThis.melondsFiles = globalThis.melondsVirtualNetwork.files;
globalThis.melondsWorkspace = createWorkspaceService({ api, backend, network: globalThis.melondsVirtualNetwork,
  readUI: () => ({ layout: structuredClone(layout), names: [...state.names], logs: structuredClone(state.logs),
    selectedInstance: $('#rom-instance').value, audio: audio.stats().instances.map(record => record.instanceId) }),
  async restoreUI(saved, scripts) {
    Object.assign(layout, saved.layout);
    state.names = new Map(saved.names); state.logs = saved.logs;
    for (const script of scripts) {
      if (!layout.tiles.some(tile => tile.type === 'persistent-scripts' && tile.instanceId === script.instanceId && tile.settings.code === script.code)) {
        layout.tiles.push(makeTile('persistent-scripts', { instanceId: script.instanceId, settings: { code: script.code, name: script.name } }));
      }
    }
    renderLayout(); save(); $('#rom-instance').value = saved.selectedInstance;
    for (const instanceId of saved.audio || []) if (state.instances.includes(instanceId) && !audio.has(instanceId)) await audio.toggle(instanceId);
    if (scripts.some(script => script.running)) $('#notice').textContent = 'スクリプトのソースを復元しました。Workerは停止状態です。';
  }
});

function errorMessage(error) {
  $('#notice').textContent = error?.message || String(error);
  $('#notice').hidden = false;
}
function save() { saveLayout(layout); }
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
  head.append(header); table.append(head); const tbody = el('tbody'); table.append(tbody); body.append(table);
  const empty = el('p', 'muted', '受信データはまだありません。'); body.append(empty);
  const detail = el('pre', 'network-detail'); detail.hidden = true; body.append(detail);
  let selectedPacket = null;
  function update() {
    if (tile.settings.paused) return;
    tbody.replaceChildren();
    const entries = state.logs[tile.type].filter(packet => (!tile.settings.decodedOnly || packet.logical) &&
      (tile.settings.all || packet.instanceId === tile.instanceId || packet.destination === tile.instanceId)).slice(-100);
    empty.hidden = !!entries.length;
    for (const packet of entries) {
      const tr = el('tr');
      const sender = tile.type === 'wifi-log' && packet.direction === 'RX' ? 'NET' : packet.senderId ?? packet.instanceId;
      const receiver = tile.type === 'wifi-log' ? (packet.direction === 'RX' ? packet.instanceId : 'NET') : packet.destination ?? '*';
      const decoded = tile.type === 'wifi-log' ? (packet.decoded ||= decodePacket(packet)) : null;
      const raw = () => packet.payload ? Array.from(packet.payload, n => n.toString(16).padStart(2, '0')).join(' ') : '';
      for (const value of [packet.timestamp, packet.direction || 'TX', decoded?.source || sender, decoded?.destination || receiver,
        decoded?.protocol || packet.packetType || 'PACKET', packet.length ?? packet.payload?.length ?? 0,
        decoded?.summary || Array.from(packet.payload?.slice(0, 64) || [], n => n.toString(16).padStart(2, '0')).join(' ')]) tr.append(el('td', '', String(value)));
      tr.tabIndex = 0; tr.classList.toggle('selected', selectedPacket === packet);
      tr.onclick = () => { selectedPacket = packet; for (const selected of tbody.querySelectorAll('.selected')) selected.classList.remove('selected'); tr.classList.add('selected'); detail.hidden = false; detail.textContent = decoded?.detail || raw(); };
      tr.onkeydown = event => { if (event.key === 'Enter') tr.click(); };
      tbody.append(tr);
    }
  }
  showAll.onchange = () => { tile.settings.all = showAll.checked; save(); update(); };
  decodedOnly.onchange = () => { tile.settings.decodedOnly = decodedOnly.checked; save(); update(); };
  pause.onchange = () => { tile.settings.paused = pause.checked; save(); update(); };
  body.addEventListener('target-change', update);
  let repaint = 0;
  body.addEventListener('packet', () => {
    if (repaint) return;
    repaint = setTimeout(() => { repaint = 0; if (body.isConnected) update(); }, 100);
  });
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
    const destroy = button('中断', async () => { const id = tile.instanceId; release(); audio.disable(id); await api.destroyInstance({ instanceId: id }); });
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
    linkInput.onchange = () => { release(); tile.settings.inputLink = linkInput.value === '' ? null : Number(linkInput.value); save(); };
    const targets = () => [...new Set([tile.instanceId, tile.settings.inputLink].filter(id => Number.isInteger(id) && state.instances.includes(id)))];
    footer.append(filename, button('キー入力', () => stack.focus({ preventScroll: true })), linkInput, toggleAudio);
    stack.append(top, bottom);
    body.append(toolbar, stack, footer);
    const fit = new ResizeObserver(() => {
      const available = Math.max(1, body.clientHeight - toolbar.offsetHeight - footer.offsetHeight - 8);
      stack.style.width = `${Math.max(1, Math.min(body.clientWidth - 8, available * 256 / 388))}px`;
    });
    fit.observe(body); fit.observe(toolbar); fit.observe(footer);
    tileElement._cleanup = () => fit.disconnect();
    const held = new Map();
    const keymap = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', KeyX: 'A', KeyZ: 'B', KeyS: 'X', KeyA: 'Y', KeyQ: 'L', KeyW: 'R', Enter: 'START', ShiftLeft: 'SELECT', ShiftRight: 'SELECT' };
    stack.addEventListener('keydown', event => {
      const key = keymap[event.code]; if (!key) return;
      event.preventDefault(); if (held.has(key)) return;
      const ids = targets(); held.set(key, ids);
      for (const instanceId of ids) void apply(null, () => api.input({ instanceId, key, pressed: true }));
    });
    stack.addEventListener('keyup', event => {
      const key = keymap[event.code]; if (!key) return;
      event.preventDefault(); const ids = held.get(key) || []; held.delete(key);
      for (const instanceId of ids) void apply(null, () => api.input({ instanceId, key, pressed: false }));
    });
    let touchPointer = null, touchedInstances = [], pendingTouch = null, touchFrame = 0;
    let touchQueue = Promise.resolve();
    const sendTouch = value => {
      const ids = [...touchedInstances];
      touchQueue = touchQueue.catch(() => {}).then(async () => {
        for (const instanceId of ids) await api.touch({ instanceId, ...value });
      }).catch(errorMessage);
    };
    const release = () => {
      for (const [key, ids] of held) for (const instanceId of ids) void api.input({ instanceId, key, pressed: false }).catch(() => {});
      held.clear();
      cancelAnimationFrame(touchFrame); touchFrame = 0; pendingTouch = null;
      if (touchedInstances.length) sendTouch({ x: 0, y: 0, pressed: false });
      touchPointer = null; touchedInstances = [];
    };
    tileElement._releaseInput = release;
    stack.addEventListener('blur', release);
    const touch = (event, immediate = false) => {
      const rect = bottom.getBoundingClientRect();
      pendingTouch = {
        x: Math.max(0, Math.min(255, Math.floor((event.clientX - rect.left) * 256 / rect.width))),
        y: Math.max(0, Math.min(191, Math.floor((event.clientY - rect.top) * 192 / rect.height))), pressed: true };
      const flush = () => { touchFrame = 0; if (pendingTouch) { sendTouch(pendingTouch); pendingTouch = null; } };
      if (immediate) flush(); else if (!touchFrame) touchFrame = requestAnimationFrame(flush);
    };
    bottom.addEventListener('pointerdown', event => {
      if (event.button !== 0 || touchPointer !== null) return;
      stack.focus(); bottom.setPointerCapture(event.pointerId);
      touchPointer = event.pointerId; touchedInstances = targets(); touch(event, true);
    });
    bottom.addEventListener('pointermove', event => { if (event.pointerId === touchPointer) touch(event); });
    bottom.addEventListener('pointerup', release); bottom.addEventListener('pointercancel', release);
    const draw = event => {
      if (event.type !== 'frame' || event.instanceId !== tile.instanceId) return;
      if (event.frame !== undefined) frameLabel.textContent = `${event.frame} f`;
      filename.textContent = state.names.get(tile.instanceId) || 'ROM未読込';
      for (const [canvas, pixels] of [[top, event.top], [bottom, event.bottom]]) {
        if (!pixels || pixels.length !== 256 * 192 * 4) continue;
        canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels), 256, 192), 0, 0);
      }
    };
    tileElement._frameListener = draw;
    body.addEventListener('target-change', () => {
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
    const showRegisters = async () => {
      const registers = await api.getRegisters(args());
      output.className = 'register-grid'; output.replaceChildren();
      for (const [name, value] of Object.entries(registers)) {
        const item = el('div', 'register-cell');
        item.append(el('span', '', name.toUpperCase()), el('strong', '', (value >>> 0).toString(16).padStart(8, '0')));
        output.append(item);
      }
    };
    controls.append(button('更新', showRegisters));
    tileElement._debugListener = event => { if (event.instanceId === tile.instanceId) void showRegisters().catch(errorMessage); };
    const name = textInput(controls, 'レジスタ名', 'r0');
    const value = textInput(controls, '値 (hex)', '0');
    controls.append(button('設定', async () => { await api.setRegister(args({ register: name.value, value: hex(value) })); await showRegisters(); }));
  } else if (tile.type === 'disassembly') {
    const address = textInput(controls, '開始アドレス (hex)', '02000000');
    act('逆アセンブル', () => api.disassemble(args({ address: hex(address), count: 16 })));
  } else if (tile.type === 'breakpoints') {
    const address = textInput(controls, 'アドレス (hex)', '02000000');
    const kind = el('select');
    for (const value of ['execute', 'read', 'write']) kind.append(new Option(value, value));
    controls.append(kind);
    act('追加', () => api.addBreakpoint(args({ address: hex(address), type: kind.value })));
    act('削除', () => api.removeBreakpoint(args({ address: hex(address) })));
    act('一覧', () => api.listBreakpoints(args()));
  } else if (tile.type === 'input') {
    act('記録開始', () => api.startInputRecording(args()));
    act('記録停止', () => api.stopInputRecording(args()));
    act('入力履歴', () => api.getInputRecording(args()));
    act('記録を再生', async () => {
      const recording = await api.getInputRecording(args());
      if (recording.truncated) throw Error('入力記録が上限を超えています');
      return api.inputSequence(args({ events: recording.events }));
    });
    act('再生停止', () => api.stopInputSequence(args()));
    for (const key of ['A', 'B', 'X', 'Y', 'L', 'R', 'START', 'SELECT', 'UP', 'DOWN', 'LEFT', 'RIGHT']) {
      const item = el('button', '', key); item.type = 'button';
      let pressed = false;
      const set = active => {
        if (pressed === active) return;
        pressed = active; item.setAttribute('aria-pressed', String(active));
        void apply(null, () => api.input(args({ key, pressed: active })));
      };
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
    repeatControls.append(button('連打', async () => { const target = args(); await api.repeatInput({ ...target, keys: [repeatKey.value], count: Number(repeatCount.value), pressFrames: Number(pressFrames.value), releaseFrames: Number(releaseFrames.value) }); await api.resume(target); output.textContent = `${repeatKey.value} × ${repeatCount.value} 回`; }), button('連打を停止', async () => { await api.stopInputSequence(args()); output.textContent = '連打を停止しました'; }));
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
  node.addEventListener('pointerdown', () => { tile.z = Math.max(1, ...layout.tiles.map(t => t.z || 1)) + 1; node.style.zIndex = tile.z; save(); });
  node.querySelector('.tile-header').addEventListener('pointerdown', event => {
    if (layout.mode !== 'free' || event.button !== 0 || event.target.closest('button')) return;
    const startX = event.clientX, startY = event.clientY, left = tile.x, top = tile.y;
    const handle = event.currentTarget; handle.setPointerCapture(event.pointerId);
    const move = e => { tile.x = Math.max(0, left + e.clientX - startX); tile.y = Math.max(0, top + e.clientY - startY); place(node, tile); };
    const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); save(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  });
  node._resizeObserver = new ResizeObserver(() => {
    if (!node.isConnected || tile.minimized) return;
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
for (const type of TILE_TYPES) {
  const node = $('#palette-template').content.firstElementChild.cloneNode(true);
  node.querySelector('.palette-name').textContent = LABELS[type];
  node.querySelector('.palette-icon').textContent = ({ screen: '▣', debugger: '⌁', memory: '▤', disassembly: '≡', registers: 'R', breakpoints: '◆', callstack: '↳', save: '▱', 'local-log': '↔', 'wifi-log': '◉', script: '⌘', 'persistent-scripts': '⟲', input: '＋', state: '◫', files: '▥', system: '⚙', workspace: '◫' })[type];
  node.onclick = () => addTile(type, 16 + layout.tiles.length * 24, 16 + layout.tiles.length * 24);
  node.ondragstart = event => { event.dataTransfer.setData('text/plain', type); event.dataTransfer.effectAllowed = 'copy'; };
  $('#palette-tools').append(node);
}
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

$('#rom-target').onchange = () => { $('#instance-count-label').hidden = $('#rom-target').value !== 'all'; };
$('#rom-target').onchange();
$('#rom-file').onchange = event => {
  const input = event.currentTarget, file = input.files?.[0];
  if (!file) return;
  void apply(null, async () => {
    if ($('#rom-target').value === 'all') {
      const count = Number($('#instance-count').value);
      if (!Number.isInteger(count) || count < 1 || count > MAX_INSTANCES) throw Error('台数は1〜16で指定してください');
      for (let id = 0; state.instances.length < count && id < MAX_INSTANCES; id++) await ensureInstance(id);
      const targets = [...state.instances].sort((a, b) => a - b).slice(0, count);
      await api.loadRomMany({ instanceIds: targets, file });
      for (const id of targets) { state.names.set(id, file.name); ensureScreen(id); }
    } else {
      const id = Number($('#rom-instance').value);
      await ensureInstance(id);
      await api.loadRom({ instanceId: id, file });
      state.names.set(id, file.name);
      ensureScreen(id);
    }
    refreshSummary();
  }).finally(() => { input.value = ''; });
};
api.subscribe(event => {
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
    for (const node of workspace.querySelectorAll('.tile')) node._debugListener?.({ type: 'debug-stop', instanceId: event.instanceId });
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
  if (list.length > 2000) list.splice(0, list.length - 2000);
  for (const tile of workspace.querySelectorAll(`[data-type="${event.type}"]`)) tile.querySelector('.tile-body').dispatchEvent(new Event('packet'));
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
