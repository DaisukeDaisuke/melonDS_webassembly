import { sessionStore } from './session-store.js';
const el = (tag, cls = '', text) => { const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const filename = (text, suffix) => String(text || 'state').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.(?:dst|ml|sav)$/i, '') + suffix;
export function renderStorageTool(body, tile, node, { api, save, onError, download, audio }) {
  if (tile.type !== 'state' && tile.type !== 'save') return false;
  const isState = tile.type === 'state';
  const toolbar = el('div', 'control-row'), status = el('div', 'debug-status'), list = el('div', 'storage-list');
  body.append(toolbar, status, list);
  const args = extra => ({ instanceId: tile.instanceId, ...extra });
  let revision = 0, disposed = false;
  function button(label, fn, parent = toolbar) {
    const b = el('button', '', label); b.type = 'button'; parent.append(b);
    b.onclick = async () => { b.disabled = true; const token = revision;
      try { await fn(); if (token === revision && !disposed) { status.dataset.error = 'false'; await refresh(); } }
      catch (error) { if (token === revision && !disposed) { status.textContent = error.message || String(error); status.dataset.error = 'true'; onError(error); } }
      finally { b.disabled = false; }
    }; return b;
  }
  const name = el('input'); name.placeholder = 'ステート名'; name.setAttribute('aria-label', 'ステート名'); name.value = tile.settings.stateName || 'state';
  name.oninput = () => { tile.settings.stateName = name.value; save(); };
  const stateName = () => { const value = name.value.trim(); if (!value || value.length > 120) throw Error('ステート名を1〜120文字で入力してください'); return value; };
  if (isState) {
    toolbar.append(name);
    button('名前を付けて保存', async () => { const title = stateName(), target = args(); await api.saveStateToBrowser({ ...target, name: title }); status.textContent = `「${title}」を保存しました`; });
    button('ファイルに保存', async () => { const title = stateName(), target = args(); await api.saveState(target); download(await api.exportState(target), filename(title, '.ml')); status.textContent = `「${title}.ml」を保存しました`; });
  } else {
    button('SAVを書き出す', async () => { const target = args(); download(await api.exportSave(target), `instance-${target.instanceId}.sav`); status.textContent = 'セーブデータを書き出しました'; });
    button('ブラウザに保存', async () => { await api.saveSaveToBrowser(args()); status.textContent = 'セーブデータをブラウザに保存しました'; });
  }
  const input = el('input'); input.type = 'file'; input.accept = isState ? '.dst,.ml' : '.sav,.dsv'; input.hidden = true;
  input.setAttribute('aria-label', isState ? 'ステートファイル' : 'セーブファイル'); toolbar.append(input);
  button(isState ? 'DST / ML を開く' : 'SAVを読み込む', () => input.click());
  input.onchange = async () => {
    const file = input.files?.[0], target = args(); if (!file) return; input.disabled = true;
    try {
      audio.flush(target.instanceId);
      if (isState) await api.loadState({ ...target, file });
      else { await api.importSave({ ...target, file }); await api.reset(target); }
      status.textContent = `${file.name} → #${String(target.instanceId).padStart(2, '0')}`; await refresh();
      document.dispatchEvent(new CustomEvent('melonds-state-loaded', { detail: target }));
    } catch (error) { status.textContent = error.message || String(error); onError(error); }
    finally { input.disabled = false; input.value = ''; }
  };
  button('更新', refresh);
  async function refresh() {
    const token = revision, target = args();
    const entries = (await api.listBrowserStates(target)).filter(item => isState ? item.slot !== 'save' : item.slot === 'save');
    if (disposed || token !== revision) return;
    list.replaceChildren();
    if (!entries.length) { list.append(el('p', 'muted', isState ? '保存したステートはありません。' : 'ブラウザ内にセーブデータはありません。')); return; }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const item of entries) {
      const card = el('div', 'storage-entry'), title = isState ? item.slot.startsWith('state:') ? item.slot.slice(6) : `スロット ${item.slot}` : 'セーブデータ';
      const info = el('div', 'storage-info'); info.append(el('strong', '', title), el('small', 'muted', `${new Date(item.updatedAt).toLocaleString()} · ${(item.size / 1024).toFixed(1)} KiB`));
      card.append(info); const actions = el('div', 'control-row'); card.append(actions);
      button('読込', async () => {
        audio.flush(target.instanceId);
        if (isState) await api.loadStateFromBrowser({ ...target, ...(item.slot.startsWith('state:') ? { name: title } : { slot: Number(item.slot) }) });
        else { await api.loadSaveFromBrowser(target); await api.reset(target); }
        status.textContent = `「${title}」を読み込みました`;
        document.dispatchEvent(new CustomEvent('melonds-state-loaded', { detail: target }));
      }, actions);
      button('書出', async () => {
        const record = await sessionStore.getRecord({ ...target, slot: /^\d$/.test(item.slot) ? Number(item.slot) : item.slot });
        if (!record) throw Error('保存データが見つかりません'); download(record.blob, filename(title, isState ? '.ml' : '.sav'));
      }, actions);
      button('削除', async () => { await sessionStore.remove({ ...target, slot: /^\d$/.test(item.slot) ? Number(item.slot) : item.slot }); status.textContent = `「${title}」を削除しました`; }, actions);
      list.append(card);
    }
  }
  body.addEventListener('target-change', () => { revision++; list.replaceChildren(); status.textContent = ''; void refresh().catch(onError); });
  node._cleanup = () => { disposed = true; revision++; };
  queueMicrotask(() => { if (!disposed) void refresh().catch(onError); });
  return true;
}
