// Visual debugger adapted from DeSmuME's debugger-service: PC/BP gutters,
// instruction classes, call-stack lane selection and caller/callee navigation.
// RPC remains structured; objects are never dumped into the workbench UI.
const H = (n, width = 8) => (Number(n) >>> 0).toString(16).toUpperCase().padStart(width, '0');
const E = (tag, cls = '', text) => { const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const parse = value => { const text = String(value).trim().replace(/^0x/i, ''); if (!/^[0-9a-f]{1,8}$/i.test(text)) throw Error('アドレスは8桁以内の16進数で指定してください'); return parseInt(text, 16) >>> 0; };
const dataBytes = value => { const text = value.replace(/\s+/g, ''); if (!text || text.length % 2 || !/^[0-9a-f]+$/i.test(text)) throw Error('バイト列は 01 02 FF の形式で指定してください'); return Uint8Array.from(text.match(/../g), n => parseInt(n, 16)); };
const modes = { 16: 'USR', 17: 'FIQ', 18: 'IRQ', 19: 'SVC', 23: 'ABT', 27: 'UND', 31: 'SYS' };
function operands(text, jump) {
  const out = E('span', 'asm-operands');
  for (const token of text.split(/(\b(?:r(?:1[0-5]|[0-9])|sp|lr|pc|cpsr|spsr)\b|#-?(?:0x)?[\da-f]+|\b(?:0x)?[\da-f]{8}\b)/ig)) {
    if (!token) continue;
    if (/^(?:0x)?[\da-f]{8}$/i.test(token)) {
      const link = E('button', 'address-link', token); link.type = 'button'; link.onclick = () => jump(parse(token)); out.append(link);
    } else out.append(E('span', /^(?:r\d+|sp|lr|pc|cpsr|spsr)$/i.test(token) ? 'asm-register' : token[0] === '#' ? 'asm-immediate' : '', token));
  }
  return out;
}
function table(headings) {
  const t = E('table', 'debug-table'), head = E('thead'), row = E('tr'), body = E('tbody');
  headings.forEach(h => row.append(E('th', '', h))); head.append(row); t.append(head, body); return [t, body];
}
export function renderDebuggerTool(body, tile, node, { api, save, onError, jump }) {
  if (!['debugger', 'disassembly', 'memory', 'breakpoints', 'callstack'].includes(tile.type)) return false;
  body.classList.add('visual-debugger');
  const controls = E('div', 'control-row'), status = E('div', 'debug-status', 'ROM未読込'), view = E('div', 'debug-view');
  body.append(controls, status, view);
  const args = extra => ({ instanceId: tile.instanceId, cpu: tile.cpu, ...extra });
  let revision = 0, closed = false, refreshing = false, repeat = false, timer;
  let displayAddress = tile.settings.address ?? null, previous = new Map(), selectedLane = null;
  function report(error) { status.textContent = error?.message || String(error); status.dataset.error = 'true'; onError(error); }
  const action = (label, run, title = label) => {
    const b = E('button', '', label); b.type = 'button'; b.title = title;
    b.onclick = async () => { b.disabled = true; try { await run(); } catch (error) { report(error); } finally { b.disabled = false; } };
    controls.append(b); return b;
  };
  function input(label, value, width = '8em') {
    const n = E('input'); n.setAttribute('aria-label', label); n.title = label; n.value = value; n.style.width = width; controls.append(n); return n;
  }
  const navigate = (address, thumb) => {
    displayAddress = address >>> 0; tile.settings.address = displayAddress; tile.settings.followPc = false;
    if (addressInput) addressInput.value = H(displayAddress);
    if (thumb !== undefined && mode) mode.value = thumb ? 'thumb' : 'arm';
    save(); void refresh();
  };
  let addressInput, mode, pattern, lengthInput, follow;
  if (tile.type === 'debugger' || tile.type === 'disassembly') {
    action('停止', async () => { await api.pause(args()); await refresh(); });
    action('再開', async () => { await api.resume(args()); status.textContent = '実行中'; });
    action('Step', async () => { await api.pause(args()); await api.step(args()); tile.settings.followPc = true; await refresh(); }, '1命令進む');
    action('Smart', async () => { await api.pause(args()); await api.smartStep(args()); tile.settings.followPc = true; await refresh(); }, '呼び出しを飛び越し、それ以外は1命令進む');
    action('Over', async () => { await api.pause(args()); await api.stepOver(args()); tile.settings.followPc = true; await refresh(); }, 'ステップオーバー');
    addressInput = input('表示アドレス (hex / PC)', displayAddress === null ? 'PC' : H(displayAddress));
    mode = E('select'); mode.setAttribute('aria-label', '命令セット'); mode.append(new Option('自動', 'auto'), new Option('ARM', 'arm'), new Option('Thumb', 'thumb')); controls.append(mode);
    action('表示', () => { if (/^pc$/i.test(addressInput.value.trim())) { tile.settings.followPc = true; return refresh(); } return navigate(parse(addressInput.value)); });
    action('PC', () => { tile.settings.followPc = true; return refresh(); });
    action('ここまで', async () => { const address = /^pc$/i.test(addressInput.value.trim()) ? displayAddress : parse(addressInput.value); if (address === null) throw Error('到達先を指定してください'); await api.runUntil(args({ address })); tile.settings.followPc = true; await refresh(); });
    action('←', () => navigate(Math.max(0, (displayAddress ?? 0) - 64)));
    action('→', () => navigate(((displayAddress ?? 0) + 64) >>> 0));
    mode.onchange = () => void refresh();
    addressInput.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); void Promise.resolve().then(() => navigate(parse(addressInput.value))).catch(report); } };
  } else if (tile.type === 'memory') {
    addressInput = input('メモリアドレス (hex)', H(displayAddress ?? 0x02000000));
    lengthInput = input('表示バイト数', String(tile.settings.length ?? 256), '5em'); lengthInput.type = 'number'; lengthInput.min = 16; lengthInput.max = 4096;
    action('表示', () => { displayAddress = parse(addressInput.value); tile.settings.address = displayAddress; tile.settings.length = Number(lengthInput.value); save(); return refresh(); });
    action('SP', async () => { const r = await api.getRegisters(args()); navigate(r.r13); });
    action('←', () => navigate(Math.max(0, parse(addressInput.value) - Number(lengthInput.value))));
    action('→', () => navigate((parse(addressInput.value) + Number(lengthInput.value)) >>> 0));
    pattern = input('バイト列 (hex)', '', '12em'); pattern.placeholder = '01 02 FF';
    action('書込', async () => { await api.writeMemory(args({ address: parse(addressInput.value), data: dataBytes(pattern.value) })); await refresh(); });
    action('固定', async () => { await api.memoryFreeze(args({ address: parse(addressInput.value), data: dataBytes(pattern.value) })); await refresh(); });
    action('固定解除', async () => { await api.removeMemoryFreeze(args({ address: parse(addressInput.value) })); await refresh(); });
    for (const [label, type] of [['読取BP', 'read'], ['書込BP', 'write']]) action(label, async () => { await api.addBreakpoint(args({ address: parse(addressInput.value), type, length: pattern.value.trim() ? dataBytes(pattern.value).length : 1 })); status.textContent = `${label} ${addressInput.value}`; });
    action('検索', async () => {
      const found = await api.memorySearch(args({ pattern: dataBytes(pattern.value), limit: 256 }));
      view.replaceChildren(); const addresses = Array.isArray(found) ? found : found.addresses || found.matches || [];
      status.textContent = `${addresses.length} 件`;
      for (const address of addresses) { const n = E('button', 'address-link', H(address.address ?? address)); n.onclick = () => navigate(address.address ?? address); view.append(n); }
    });
  } else if (tile.type === 'breakpoints') {
    addressInput = input('停止アドレス (hex)', '02000000');
    lengthInput = input('監視バイト数', '1', '4em'); lengthInput.type = 'number'; lengthInput.min = 1; lengthInput.max = 4096;
    for (const [label, type] of [['実行', 'execute'], ['読取', 'read'], ['書込', 'write']]) action(label, async () => { await api.addBreakpoint(args({ address: parse(addressInput.value), length: Number(lengthInput.value), type })); await refresh(); });
    action('更新', refresh);
  } else {
    action('更新', refresh);
    action('Markdownをコピー', async () => {
      const stack = await api.callStack(args({ limit: 128 }));
      await navigator.clipboard.writeText('| Caller | Callee | Return | SP | CPSR |\n|---|---|---|---|---|\n' + stack.frames.map(f => `| ${H(f.caller)} | ${H(f.callee)} | ${H(f.returnAddress)} | ${H(f.sp)} | ${H(f.cpsr)} |`).join('\n'));
      status.textContent = 'コピーしました';
    });
  }
  async function refresh() {
    if (closed) return;
    if (refreshing) { repeat = true; return; }
    refreshing = true;
    const version = revision, target = args();
    try {
      status.dataset.error = 'false';
      if (tile.type === 'memory') {
        const address = parse(addressInput.value), length = Number(lengthInput.value);
        if (!Number.isInteger(length) || length < 16 || length > 4096) throw Error('表示範囲は16〜4096バイトです');
        const values = await api.readMemory({ ...target, address, length });
        if (version !== revision || closed) return;
        const columns = Math.max(4, Math.min(16, Math.floor((view.clientWidth - 116) / 30 / 4) * 4 || 4));
        const [t, rows] = table(['Address', ...Array.from({ length: columns }, (_, i) => H(i, 2)), 'ASCII']); t.classList.add('hex-table');
        const fresh = new Map();
        for (let offset = 0; offset < values.length; offset += columns) {
          const r = E('tr'); r.append(E('th', 'hex-address', H(address + offset)));
          for (let col = 0; col < columns; col++) {
            const i = offset + col, at = (address + i) >>> 0, value = values[i];
            const cell = E('td', value !== undefined && previous.has(at) && previous.get(at) !== value ? 'value-changed' : '', value === undefined ? '' : H(value, 2));
            if (value !== undefined) {
              fresh.set(at, value); cell.tabIndex = 0; cell.title = `${H(at)} · ダブルクリックで編集`;
              const edit = async () => { const text = prompt(`${H(at)} の値 (00〜FF)`, H(value, 2)); if (text === null) return; const number = parse(text); if (number > 255) throw Error('1バイトの値を指定してください'); await api.writeMemory({ ...target, address: at, data: [number] }); await refresh(); };
              cell.ondblclick = () => void edit().catch(report); cell.onkeydown = e => { if (e.key === 'Enter') void edit().catch(report); };
            }
            r.append(cell);
          }
          r.append(E('td', 'hex-ascii', Array.from(values.slice(offset, offset + columns), b => b >= 32 && b < 127 ? String.fromCharCode(b) : '·').join(''))); rows.append(r);
        }
        previous = fresh; view.replaceChildren(t); status.textContent = `${target.cpu}  ${H(address)}–${H(address + length - 1)} · ${length} bytes`;
      } else if (tile.type === 'breakpoints') {
        const points = await api.listBreakpoints(target); if (version !== revision || closed) return;
        const [t, rows] = table(['CPU', '条件', 'アドレス', '長さ', '']);
        for (const bp of points) {
          const r = E('tr'); r.dataset.breakpointId = bp.id;
          for (const value of [bp.cpu, { execute: '実行', read: '読取', write: '書込' }[bp.type], H(bp.address), `${bp.length} B`]) r.append(E('td', '', value));
          const cell = E('td'), remove = E('button', '', '削除'); remove.onclick = () => void api.removeBreakpoint({ ...target, id: bp.id }).then(refresh).catch(report); cell.append(remove); r.append(cell); rows.append(r);
        }
        view.replaceChildren(t); status.textContent = `${points.length} 件のブレイクポイント`;
      } else if (tile.type === 'callstack') {
        const [data, regs] = await Promise.all([api.callStack({ ...target, limit: 128 }), api.getRegisters(target)]);
        if (version !== revision || closed) return;
        const lanes = data.stacks?.length ? data.stacks : [{ id: 1, active: true, frames: data.frames, nowPc: regs.r15, sp: regs.r13 }];
        if (!lanes.some(l => l.id === selectedLane)) selectedLane = data.activeStackId ?? lanes.find(l => l.active)?.id ?? lanes[0].id;
        const tabs = E('div', 'stack-lanes');
        for (const lane of lanes) {
          const b = E('button', '', `${lane.active ? '● ' : ''}${modes[lane.cpsr & 31] || target.cpu} SP ${H(lane.sp ?? lane.frames[0]?.sp ?? regs.r13)} · ${lane.frames.length}`);
          b.setAttribute('aria-pressed', String(lane.id === selectedLane)); b.onclick = () => { selectedLane = lane.id; void refresh(); }; tabs.append(b);
        }
        const selected = lanes.find(l => l.id === selectedLane) || lanes[0];
        const [t, rows] = table(['#', 'Caller', 'Callee', 'Return', 'SP', 'Mode']);
        selected.frames.forEach((f, i) => {
          const r = E('tr', (f.cpsr & 31) === 18 ? 'mode-irq' : ''); r.append(E('td', '', String(i)));
          for (const address of [f.caller, f.callee, f.returnAddress]) { const td = E('td'), b = E('button', 'address-link', H(address)); b.onclick = () => jump({ ...target, type: 'disassembly', address: address & ~1, thumb: !!(f.cpsr & 32) }); td.append(b); r.append(td); }
          r.append(E('td', '', H(f.sp)), E('td', '', `${f.cpsr & 32 ? 'T' : 'A'} ${modes[f.cpsr & 31] || '?'} ${H(f.cpsr)}`)); rows.append(r);
        });
        view.replaceChildren(tabs, t); status.textContent = `${target.cpu} PC ${H(selected.nowPc ?? regs.r15)} · ${selected.frames.length} frames（ロード後の実行履歴）`;
      } else {
        const [regs, points, current] = await Promise.all([api.getRegisters(target), api.listBreakpoints(target), api.status(target)]);
        if (version !== revision || closed) return;
        if (!current.loaded) { view.replaceChildren(); status.textContent = 'ROM未読込'; return; }
        const thumb = mode.value === 'auto' ? !!(regs.cpsr & 32) : mode.value === 'thumb';
        const width = thumb ? 2 : 4;
        if (tile.settings.followPc !== false || displayAddress === null) displayAddress = Math.max(0, regs.r15 - 4 * width);
        displayAddress = (displayAddress & ~(width - 1)) >>> 0;
        addressInput.value = H(displayAddress);
        const count = Math.max(8, Math.min(128, Math.ceil((view.clientHeight || 300) / 24) + 6));
        const instructions = await api.disassemble({ ...target, address: displayAddress, count, thumb });
        if (version !== revision || closed) return;
        const [t, rows] = table(['BP', '', 'Address', 'Opcode', 'Instruction']); t.classList.add('disasm-table');
        const active = new Map(points.filter(p => p.type === 'execute' && p.cpu === target.cpu).map(p => [p.address, p]));
        for (const instruction of instructions) {
          const mnemonic = instruction.text.trim().split(/\s+/)[0], operand = instruction.text.trim().slice(mnemonic.length).trim();
          const isCall = /^BL|^PUSH/i.test(mnemonic), isReturn = /^(?:BX\s+LR|POP.*PC|LDM.*PC)/i.test(instruction.text), branch = /^B(?:X|L|EQ|NE|CS|CC|MI|PL|VS|VC|HI|LS|GE|LT|GT|LE)?$/i.test(mnemonic);
          const r = E('tr', ['disasm-line', instruction.address === regs.r15 ? 'current' : '', active.has(instruction.address) ? 'breakpoint-line' : '', isCall ? 'entry-line' : isReturn ? 'return-line' : branch ? 'branch-line' : ''].join(' '));
          r.dataset.address = H(instruction.address);
          const gutter = E('td'), bp = E('button', 'bp-gutter', active.has(instruction.address) ? '●' : '○'); bp.title = `実行ブレイクポイント ${H(instruction.address)}`; bp.setAttribute('aria-pressed', String(active.has(instruction.address)));
          bp.onclick = async () => { try { const existing = active.get(instruction.address); if (existing) await api.removeBreakpoint({ ...target, id: existing.id }); else await api.addBreakpoint({ ...target, address: instruction.address, type: 'execute' }); await refresh(); } catch (error) { report(error); } };
          gutter.append(bp); const cell = E('td', 'instruction'); cell.append(E('span', 'asm-mnemonic', mnemonic), document.createTextNode(' '), operands(operand, navigate));
          const addressCell = E('td'), link = E('button', 'address-link', H(instruction.address)); link.title = 'メモリで開く'; link.onclick = () => jump({ ...target, type: 'memory', address: instruction.address }); addressCell.append(link);
          r.append(gutter, E('td', 'pc-gutter', instruction.address === regs.r15 ? '▶' : ''), addressCell, E('td', 'asm-bytes', instruction.opcode.replace(/^0x/i, '').toUpperCase()), cell); rows.append(r);
        }
        view.replaceChildren(t);
        const flags = ['N', 'Z', 'C', 'V'].map((f, i) => regs.cpsr & (1 << (31 - i)) ? f : '·').join('');
        status.textContent = `${current.paused ? '停止中' : '実行中'} · ${target.cpu} ${thumb ? 'Thumb' : 'ARM'} · PC ${H(regs.r15)} · ${modes[regs.cpsr & 31] || '?'} ${flags}`;
      }
    } catch (error) { if (version === revision && !closed) { status.textContent = error?.message || String(error); status.dataset.error = 'true'; } }
    finally { refreshing = false; if (repeat && !closed) { repeat = false; queueMicrotask(refresh); } }
  }
  node._debugListener = event => { if (event.instanceId === tile.instanceId) { if (tile.type === 'debugger' || tile.type === 'disassembly') tile.settings.followPc = true; void refresh(); } };
  body.addEventListener('target-change', () => { revision++; previous.clear(); selectedLane = null; void refresh(); });
  body.addEventListener('address-jump', event => { if (event.detail.thumb !== undefined && mode) mode.value = event.detail.thumb ? 'thumb' : 'arm'; navigate(event.detail.address); });
  const resize = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(refresh, 120); }); resize.observe(view);
  node._cleanup = () => { closed = true; revision++; clearTimeout(timer); resize.disconnect(); };
  queueMicrotask(refresh);
  return true;
}
