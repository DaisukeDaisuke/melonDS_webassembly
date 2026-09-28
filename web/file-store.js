// DLC file explorer backing store. Paths follow the source server's
// virtual /<four-letter-gamecd>/<filename> layout; bodies live in IndexedDB, not layout
// localStorage. Both the tile and WFC handler use the same database.
const database = 'melonds-workbench-files';
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 128
  && !/[\x00-\x1f\x7f"';/\\<>:|?*]/.test(name) && !name.includes('..')
  && !/[ .]$/.test(name) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
export function dlcPath(gamecd, name) {
  if (!/^[a-z]{4}$/i.test(gamecd) || !validName(name)) throw new TypeError('Expected a four-letter game ID and safe filename');
  return `/${gamecd.toUpperCase()}/${name}`;
}
function checkedPath(path) {
  if (typeof path !== 'string') throw new TypeError('path is required');
  const segments = path.split('/');
  if (segments.length !== 3 || segments[0] !== '' || dlcPath(segments[1], segments[2]) !== path) {
    throw new TypeError('Expected /<four-letter-game-ID>/<filename>');
  }
  return path;
}
let opening;
function open() {
  if (typeof indexedDB === 'undefined') return Promise.reject(Error('IndexedDB is unavailable'));
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'path' });
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); opening = null; };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('File database upgrade blocked by another tab'));
  }).catch(error => { opening = null; throw error; });
  return opening;
}
async function transact(mode, use) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('files', mode), store = transaction.objectStore('files');
    let result;
    const request = use(store);
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || Error('File transaction aborted'));
  });
}
export function createFileStore() {
  return Object.freeze({
    snapshot: () => transact('readonly', store => store.getAll()),
    async restore(records) {
      if (!Array.isArray(records) || records.length > 10000) throw Error('Invalid DLC workspace');
      for (const record of records) {
        checkedPath(record.path);
        if (!(record.blob instanceof Blob) || record.blob.size > 16 * 1024 * 1024) throw Error('Invalid DLC file');
      }
      await transact('readwrite', store => {
        let request = store.clear();
        for (const record of records) request = store.put(record);
        return request;
      });
    },
    async put({ path, data }) {
      checkedPath(path);
      const blob = data instanceof Blob ? data : new Blob([data], {
        type: typeof data === 'string' ? 'text/plain;charset=utf-8' : 'application/octet-stream'
      });
      if (blob.size > (path.endsWith('/_list.txt') ? 1024 * 1024 : 16 * 1024 * 1024)) throw RangeError('DLC file is too large');
      if (path.endsWith('/_list.txt')) {
        new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
      }
      await transact('readwrite', store => store.put({ path, blob, updatedAt: Date.now() }));
      return { path, size: blob.size, type: blob.type };
    },
    async get({ path }) {
      checkedPath(path);
      return (await transact('readonly', store => store.get(path)))?.blob || null;
    },
    async list({ prefix = '/' } = {}) {
      if (prefix !== '/' && !/^\/[A-Z]{4}\/$/.test(prefix)) throw new TypeError('Invalid DLC directory');
      const records = await transact('readonly', store => store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`)));
      return records.map(({ path, blob, updatedAt }) => ({ path, size: blob.size, type: blob.type, updatedAt }));
    },
    async remove({ path }) {
      checkedPath(path);
      await transact('readwrite', store => store.delete(path));
      return { path };
    },
    async readText({ path }) {
      const blob = await this.get({ path });
      if (!blob) throw Error(`No file at ${path}`);
      return new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
    },
    async writeText({ path, text }) {
      if (typeof text !== 'string') throw TypeError('text must be a UTF-8 string');
      return this.put({ path, data: text });
    }
  });
}
