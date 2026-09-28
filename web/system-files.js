// User-provided system images stay in this browser; the deployment never hosts them.
let opening;
function database() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open('melonds-system-files', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'kind' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('BIOSストレージを開けません'));
  }).catch(error => { opening = null; throw error; });
  return opening;
}
async function access(mode, operation) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('files', mode);
    const request = operation(transaction.objectStore('files'));
    let result;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || Error('BIOS保存を中断しました'));
  });
}
export function systemKind(file) {
  if (file.size === 16384) return 'bios7';
  if (file.size === 4096) return 'bios9';
  if ([131072, 262144, 524288].includes(file.size)) return 'firmware';
  throw Error(`${file.name || '本体ファイル'}: BIOS7は16 KiB、BIOS9は4 KiB、FWは128/256/512 KiBです`);
}
export const systemFiles = Object.freeze({
  list: () => access('readonly', store => store.getAll()),
  async put(file) {
    const kind = systemKind(file);
    await access('readwrite', store => store.put({ kind, file }));
    return kind;
  },
  async apply(backend, instanceId) {
    for (const { kind, file } of await this.list()) {
      await backend.execute('loadSystemFile', { instanceId, kind, file });
    }
  }
});
