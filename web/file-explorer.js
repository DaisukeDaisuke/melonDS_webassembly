import { dlcPath } from './file-store.js';

function entryFiles(entry, prefix = '') {
  if (entry.isFile) return new Promise((resolve, reject) => {
    entry.file(file => resolve([{ file, relative: `${prefix}${file.name}` }]), reject);
  });
  if (!entry.isDirectory) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const reader = entry.createReader(), children = [];
    function next() {
      reader.readEntries(batch => {
        if (!batch.length) { resolve(children); return; }
        children.push(...batch); next();
      }, reject);
    }
    next();
  }).then(async children => (await Promise.all(children.map(child => entryFiles(child, `${prefix}${entry.name}/`)))).flat());
}
export function uploadPath(relative, gamecd) {
  const parts = relative.replace(/^\/+/, '').split('/');
  if (parts[0] === 'dlc') parts.shift();
  if (parts.length === 1) return dlcPath(gamecd, parts[0]);
  if (parts.length === 2) return dlcPath(parts[0], parts[1]);
  throw TypeError('Drop files directly, or folders in /<four-letter-game-ID>/<filename> form');
}

export function renderFileExplorer(body, { files, tile, save, onError }) {
  const make = (tag, className, label) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label) node.textContent = label;
    return node;
  };
  const execute = async (button, action) => {
    if (button) button.disabled = true;
    try { await action(); } catch (error) { onError(error); }
    finally { if (button) button.disabled = false; }
  };
  const controls = make('div', 'control-row');
  const game = make('input'); game.setAttribute('aria-label', '4文字ゲームID'); game.maxLength = 4;
  game.placeholder = 'Game code'; game.value = tile.settings.gamecd || 'YDQJ';
  game.onchange = () => { game.value = game.value.trim().toUpperCase(); tile.settings.gamecd = game.value; save(); };
  controls.append(make('span', 'muted', '/'), game);
  const filename = make('input'); filename.placeholder = '新しいUTF-8ファイル名';
  filename.setAttribute('aria-label', '新しいDLCテキストファイル名'); controls.append(filename);
  body.append(controls);
  const actions = make('div', 'control-row');
  const browse = make('input'); browse.type = 'file'; browse.multiple = true; browse.hidden = true;
  const folder = make('input'); folder.type = 'file'; folder.multiple = true; folder.hidden = true;
  folder.setAttribute('webkitdirectory', '');
  const add = (label, action) => {
    const button = make('button', '', label); button.type = 'button';
    button.onclick = () => execute(button, action); actions.append(button); return button;
  };
  add('ファイルを追加', () => browse.click());
  add('フォルダを追加', () => folder.click());
  add('UTF-8を新規作成', async () => {
    const path = dlcPath(game.value.trim(), filename.value.trim());
    selected = path; editor.value = ''; editor.hidden = false; editor.focus();
  });
  body.append(actions, browse, folder);
  const drop = make('div', 'file-drop', 'ここにDLCのファイル / フォルダをドロップ');
  drop.setAttribute('role', 'button'); drop.tabIndex = 0;
  drop.onclick = () => browse.click();
  drop.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); browse.click(); } };
  drop.ondragover = event => { event.preventDefault(); event.stopPropagation(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  body.append(drop);
  const listing = make('div', 'file-list'); body.append(listing);
  const details = make('div', 'file-details'); body.append(details);
  const label = make('p', 'muted', 'ファイルを選択してください'); details.append(label);
  const editor = make('textarea'); editor.rows = 7; editor.hidden = true;
  editor.setAttribute('aria-label', 'UTF-8ファイルの内容'); details.append(editor);
  const buttons = make('div', 'control-row'); details.append(buttons);
  let selected = null;
  addDetail('UTF-8を保存', async () => {
    if (!selected || editor.hidden) throw Error('UTF-8テキストを選択してください');
    await files.writeText({ path: selected, text: editor.value }); await refresh();
  });
  addDetail('ダウンロード', async () => {
    if (!selected) throw Error('ファイルを選択してください');
    const blob = await files.get({ path: selected });
    if (!blob) throw Error('ファイルがありません');
    const url = URL.createObjectURL(blob);
    try { const anchor = make('a'); anchor.href = url; anchor.download = selected.split('/').at(-1); anchor.click(); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
  });
  addDetail('削除', async () => {
    if (!selected) throw Error('ファイルを選択してください');
    await files.remove({ path: selected }); selected = null; editor.value = ''; editor.hidden = true;
    label.textContent = 'ファイルを選択してください'; await refresh();
  });
  function addDetail(text, action) {
    const button = make('button', '', text); button.type = 'button';
    button.onclick = () => execute(button, action); buttons.append(button);
  }
  async function refresh() {
    const entries = await files.list();
    if (!body.isConnected) return;
    listing.replaceChildren();
    for (const entry of entries) {
      const item = make('button', 'file-item', `${entry.path} · ${entry.size} bytes`);
      item.type = 'button'; item.setAttribute('aria-pressed', String(selected === entry.path));
      item.onclick = () => execute(item, async () => {
        selected = entry.path; label.textContent = `${entry.path} · ${entry.size} bytes`;
        const blob = await files.get({ path: selected });
        editor.hidden = !(selected.endsWith('.txt') || blob?.type.startsWith('text/'));
        editor.value = editor.hidden ? '' : await files.readText({ path: selected });
        for (const row of listing.children) row.setAttribute('aria-pressed', String(row === item));
      });
      listing.append(item);
    }
    if (!entries.length) listing.append(make('p', 'muted', 'DLCファイルはまだありません。'));
  }
  async function upload(incoming) {
    if (incoming.length > 1024) throw RangeError('一度に1024ファイルまでアップロードできます');
    for (const { file, relative } of incoming) {
      const path = uploadPath(relative, game.value.trim());
      await files.put({ path, data: file });
    }
    await refresh();
  }
  const fromInput = input => {
    void execute(null, async () => {
      await upload([...input.files].map(file => ({ file, relative: file.webkitRelativePath || file.name })));
      input.value = '';
    });
  };
  browse.onchange = () => fromInput(browse);
  folder.onchange = () => fromInput(folder);
  drop.ondrop = event => {
    event.preventDefault(); event.stopPropagation(); drop.classList.remove('over');
    void execute(null, async () => {
      const items = [...event.dataTransfer.items].filter(item => item.kind === 'file');
      const nested = await Promise.all(items.map(item => {
        const entry = item.webkitGetAsEntry?.();
        return entry ? entryFiles(entry) : [{ file: item.getAsFile(), relative: item.getAsFile()?.name }];
      }));
      await upload(nested.flat().filter(item => item.file));
    });
  };
  void execute(null, refresh);
}
