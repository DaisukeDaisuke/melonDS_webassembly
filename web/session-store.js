// Binary save files and savestate slots are kept out of localStorage.
const DB_NAME = 'melonds-session-data';
let opening;
function database() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('data', { keyPath: 'key' });
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opening = null; }; resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('Session storage blocked by another tab'));
  }).catch(error => { opening = null; throw error; });
  return opening;
}
async function access(mode, call) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('data', mode);
    let value;
    const request = call(transaction.objectStore('data'));
    request.onsuccess = () => { value = request.result; };
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || Error('Session storage aborted'));
  });
}
function key(instanceId, slot) {
  if (!Number.isInteger(instanceId) || instanceId < 0 || instanceId > 15) throw RangeError('instanceId must be 0..15');
  if (slot !== 'save' && (!Number.isInteger(slot) || slot < 0 || slot > 9)) throw RangeError('slot must be 0..9');
  return `${instanceId}:${slot}`;
}
export const sessionStore = Object.freeze({
  async put({ instanceId, slot, data }) {
    const name = key(instanceId, slot);
    const blob = data instanceof Blob ? data : new Blob([new Uint8Array(data)]);
    if (blob.size > 64 * 1024 * 1024) throw RangeError('State exceeds 64 MiB');
    await access('readwrite', store => store.put({ key: name, blob, updatedAt: Date.now() }));
    return { instanceId, slot, size: blob.size };
  },
  async get({ instanceId, slot }) {
    return (await access('readonly', store => store.get(key(instanceId, slot))))?.blob || null;
  },
  async list({ instanceId }) {
    key(instanceId, 'save');
    const entries = await access('readonly', store => store.getAll());
    return entries.filter(item => item.key.startsWith(`${instanceId}:`))
      .map(item => ({ instanceId, slot: item.key.slice(item.key.indexOf(':') + 1), size: item.blob.size, updatedAt: item.updatedAt }));
  },
  async remove({ instanceId, slot }) {
    await access('readwrite', store => store.delete(key(instanceId, slot)));
    return { instanceId, slot };
  }
});
