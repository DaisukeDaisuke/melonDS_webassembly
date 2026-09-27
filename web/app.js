import { createApi, MAX_INSTANCES } from './api.js';
import { createWasmBackend } from './backend.js';
import { createScriptBackend } from './script-service.js';
import { loadLayout, saveLayout, makeTile, TILE_TYPES, LABELS } from './layout.js';
import { registerWebMcp } from './webmcp.js';
import { createVirtualNetwork } from './virtual-network.js';
import { renderFileExplorer } from './file-explorer.js';

const $ = selector => document.querySelector(selector);
const workspace = $('#workspace');
const layout = loadLayout();
const backend = createScriptBackend(createWasmBackend());
const api = createApi(backend);
const state = { instances: [], names: new Map(), logs: { 'local-log': [], 'wifi-log': [] }, pending: new Set() };
const audio = { context: null, next: Array(16).fill(0) };
globalThis.melonds = api;
globalThis.melondsVirtualNetwork = createVirtualNetwork(api);
globalThis.melondsFiles = globalThis.melondsVirtualNetwork.files;

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
  backend.setAudioTargets([...new Set([...workspace.querySelectorAll('[data-type=screen]')]
    .filter(node => node._audioActive)
    .map(node => Number(node.querySelector('.instance-select').value)))]);
}
function playAudio({ instanceId, samples }) {
  if (!audio.context || !samples?.length) return;
  const frames = samples.length / 2;
  const buffer = audio.context.createBuffer(2, frames, 48000);
  const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
  for (let n = 0; n < frames; n++) {
    left[n] = samples[n * 2] / 32768;
    right[n] = samples[n * 2 + 1] / 32768;
  }
  const source = audio.context.createBufferSource();
  source.buffer = buffer; source.connect(audio.context.destination);
  const now = audio.context.currentTime;
  if (audio.next[instanceId] < now || audio.next[instanceId] > now + .25) audio.next[instanceId] = now + .02;
  source.start(audio.next[instanceId]);
  audio.next[instanceId] += frames / 48000;
  source.onended = () => source.disconnect();
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
  return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) ?? '—';
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
  const url = URL.createObjectURL(new Blob([data], { type }));
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
  const tile = makeTile(type, { x: Math.max(0, x), y: Math.max(0, y), z: top, instanceId: Number($('#rom-instance').value) || 0 });
  layout.tiles.push(tile); save(); renderTile(tile); refreshSummary(); updateScreenTargets(); updateAudioTargets();
}
function renderLog(body, tile) {
  const controls = row(body);
  const filter = el('label', '', '全インスタンス ');
  const showAll = el('input'); showAll.type = 'checkbox'; showAll.checked = !!tile.settings.all;
  filter.prepend(showAll); controls.append(filter);
  const pause = el('input'); pause.type = 'checkbox'; pause.checked = !!tile.settings.paused;
  const pauseLabel = el('label', '', ' 表示を停止'); pauseLabel.prepend(pause); controls.append(pauseLabel);
  controls.append(button('消去', () => { state.logs[tile.type] = []; update(); }));
  if (tile.type === 'wifi-log') {
    controls.append(button('DQ9 WFC 接続', async () => {
      await globalThis.melondsVirtualNetwork.registerDq9WfcFromSameOrigin({ instanceId: tile.instanceId });
      await api.setNetworkBackend({ instanceId: tile.instanceId, backend: 'virtual' });
    }));
    controls.append(button('ネットワーク切断', () => api.setNetworkBackend({ instanceId: tile.instanceId, backend: 'disabled' })));
  }
  const table = el('table', 'packet-table');
  const head = el('thead'); const header = el('tr');
  for (const label of ['時刻', '方向', '送信/SenderID', '受信', '種別', '長さ', 'raw payload']) header.append(el('th', '', label));
  head.append(header); table.append(head); const tbody = el('tbody'); table.append(tbody); body.append(table);
  const empty = el('p', 'muted', '受信データはまだありません。'); body.append(empty);
  function update() {
    if (tile.settings.paused) return;
    tbody.replaceChildren();
    const entries = state.logs[tile.type].filter(packet => tile.settings.all ||
      packet.instanceId === tile.instanceId || packet.destination === tile.instanceId).slice(-100);
    empty.hidden = !!entries.length;
    for (const packet of entries) {
      const tr = el('tr');
      const sender = tile.type === 'wifi-log' && packet.direction === 'RX' ? 'NET' : packet.senderId ?? packet.instanceId;
      const receiver = tile.type === 'wifi-log' ? (packet.direction === 'RX' ? packet.instanceId : 'NET') : packet.destination ?? '*';
      for (const value of [packet.timestamp, packet.direction || 'TX', sender, receiver,
        packet.packetType || 'PACKET', packet.length ?? packet.payload?.length ?? 0,
        fmt(packet.payload ?? packet.data ?? '')]) tr.append(el('td', '', String(value)));
      tbody.append(tr);
    }
  }
  showAll.onchange = () => { tile.settings.all = showAll.checked; save(); update(); };
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
  if (tile.type === 'files') return renderFileExplorer(body, {
    files: globalThis.melondsFiles, tile, save, onError: errorMessage
  });
  if (tile.type === 'screen') {
    const stack = el('div', 'screens');
    stack.tabIndex = 0;
    stack.setAttribute('aria-label', 'ゲーム画面。方向キー、X=A、Z=B、S=X、A=Y、Q=L、W=R、Enter=START、Shift=SELECT');
    stack.title = '方向キー / X:A Z:B S:X A:Y Q:L W:R Enter:START Shift:SELECT';
    const top = el('canvas'); const bottom = el('canvas');
    top.width = bottom.width = 256; top.height = bottom.height = 192;
    top.setAttribute('aria-label', '上画面'); bottom.setAttribute('aria-label', '下画面');
    const toolbar = el('div', 'screen-toolbar');
    toolbar.append(button('再開', () => api.resume(args())), button('停止', () => api.pause(args())));
    const rom = el('input'); rom.type = 'file'; rom.accept = '.nds,.srl'; rom.hidden = true;
    rom.setAttribute('aria-label', `インスタンス${tile.instanceId}のROM`);
    rom.onchange = () => void apply(null, async () => {
      const file = rom.files?.[0]; if (!file) return;
      await ensureInstance(tile.instanceId);
      await api.loadRom({ instanceId: tile.instanceId, file });
      state.names.set(tile.instanceId, file.name); filename.textContent = file.name;
    }).finally(() => { rom.value = ''; });
    toolbar.append(button('ROM', () => rom.click()), rom);
    const frameLabel = el('span', 'screen-state', '—'); toolbar.append(frameLabel);
    const footer = el('div', 'screen-footer');
    const filename = el('span', '', state.names.get(tile.instanceId) || 'ROM未読込');
    const toggleAudio = button('音声 OFF', async () => {
      if (!audio.context) audio.context = new AudioContext({ sampleRate: 48000 });
      await audio.context.resume();
      tileElement._audioActive = !tileElement._audioActive;
      toggleAudio.textContent = tileElement._audioActive ? '音声 ON' : '音声 OFF';
      toggleAudio.setAttribute('aria-pressed', String(tileElement._audioActive));
      updateAudioTargets();
    });
    footer.append(filename, toggleAudio);
    stack.append(top, bottom);
    body.append(toolbar, stack, footer);
    const held = new Set();
    const keymap = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', KeyX: 'A', KeyZ: 'B', KeyS: 'X', KeyA: 'Y', KeyQ: 'L', KeyW: 'R', Enter: 'START', ShiftLeft: 'SELECT', ShiftRight: 'SELECT' };
    stack.addEventListener('keydown', event => {
      const key = keymap[event.code]; if (!key) return;
      event.preventDefault(); if (held.has(key)) return;
      held.add(key); void apply(null, () => api.input(args({ key, pressed: true })));
    });
    stack.addEventListener('keyup', event => {
      const key = keymap[event.code]; if (!key) return;
      event.preventDefault(); held.delete(key); void apply(null, () => api.input(args({ key, pressed: false })));
    });
    let touchPointer = null, touchedInstance = null;
    const release = () => {
      for (const key of held) void api.input(args({ key, pressed: false })).catch(() => {});
      held.clear();
      if (touchedInstance !== null) void api.touch({ instanceId: touchedInstance, x: 0, y: 0, pressed: false }).catch(() => {});
      touchPointer = null; touchedInstance = null;
    };
    tileElement._releaseInput = release;
    stack.addEventListener('blur', release);
    const touch = event => {
      const rect = bottom.getBoundingClientRect();
      void apply(null, () => api.touch({ instanceId: touchedInstance,
        x: Math.max(0, Math.min(255, Math.floor((event.clientX - rect.left) * 256 / rect.width))),
        y: Math.max(0, Math.min(191, Math.floor((event.clientY - rect.top) * 192 / rect.height))), pressed: true }));
    };
    bottom.addEventListener('pointerdown', event => {
      if (event.button !== 0 || touchPointer !== null) return;
      stack.focus(); bottom.setPointerCapture(event.pointerId);
      touchPointer = event.pointerId; touchedInstance = tile.instanceId; touch(event);
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
      for (const canvas of [top, bottom]) canvas.getContext('2d').clearRect(0, 0, 256, 192);
      frameLabel.textContent = '—'; filename.textContent = state.names.get(tile.instanceId) || 'ROM未読込';
      if (state.instances.includes(tile.instanceId)) void api.screenshot(args()).then(frame => draw({ ...frame, type: 'frame', instanceId: tile.instanceId })).catch(() => {});
    });
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
  if (tile.type === 'files') {
    node.querySelector('.tile-id').textContent = 'DLC';
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
  if (['screen', 'local-log', 'wifi-log', 'input', 'state', 'script', 'persistent-scripts'].includes(tile.type)) node.querySelector('.cpu-label').hidden = true;
  const min = node.querySelector('.tile-minimize');
  min.onclick = () => { tile.minimized = !tile.minimized; node.classList.toggle('minimized', tile.minimized); min.setAttribute('aria-label', tile.minimized ? '展開' : '最小化'); save(); updateScreenTargets(); };
  node.classList.toggle('minimized', tile.minimized);
  node.querySelector('.tile-close').onclick = () => { node._releaseInput?.(); node._resizeObserver?.disconnect(); layout.tiles.splice(layout.tiles.indexOf(tile), 1); node.remove(); save(); updateScreenTargets(); updateAudioTargets(); refreshSummary(); $('#workspace-empty').hidden = !!layout.tiles.length; };
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
  for (const node of workspace.querySelectorAll('.tile')) { node._releaseInput?.(); node._resizeObserver?.disconnect(); }
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
  node.querySelector('.palette-icon').textContent = ({ screen: '▣', debugger: '⌁', memory: '▤', disassembly: '≡', registers: 'R', breakpoints: '◆', 'local-log': '↔', 'wifi-log': '◉', script: '⌘', 'persistent-scripts': '⟲', input: '＋', state: '◫', files: '▥' })[type];
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
      await api.loadRomMany({ instanceIds: [...state.instances], file });
      for (const id of state.instances) state.names.set(id, file.name);
    } else {
      const id = Number($('#rom-instance').value);
      await ensureInstance(id);
      await api.loadRom({ instanceId: id, file });
      state.names.set(id, file.name);
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
    } else if (event.action === 'createInstance' && !state.instances.includes(event.instanceId)) state.instances.push(event.instanceId);
    if (event.romName) state.names.set(event.instanceId, event.romName);
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
