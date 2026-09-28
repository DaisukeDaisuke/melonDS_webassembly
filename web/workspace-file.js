// .mel: versioned, variable-length binary chunks with a small JSON directory.
// ROM bytes are stored once per hash; JSON never contains expanded byte arrays.
const magic = new TextEncoder().encode('MELWSP01');
export function encodeWorkspace(value) {
  const chunks = [], seen = new WeakMap();
  const json = JSON.stringify(value, (_, item) => {
    if (!(item instanceof Blob) && !ArrayBuffer.isView(item) && !(item instanceof ArrayBuffer)) return item;
    if (seen.has(item)) return seen.get(item);
    const kind = item instanceof Blob ? 'blob' : 'bytes';
    const blob = item instanceof Blob ? item : new Blob([item]);
    const reference = { $melBinary: chunks.length, kind, length: blob.size, type: blob.type,
      name: item instanceof File ? item.name : undefined };
    chunks.push(blob); seen.set(item, reference); return reference;
  });
  const directory = new TextEncoder().encode(json);
  const header = new Uint8Array(16); header.set(magic);
  const view = new DataView(header.buffer);
  view.setUint32(8, directory.length, true); view.setUint32(12, chunks.length, true);
  const parts = [header, directory];
  for (const chunk of chunks) {
    const length = new Uint8Array(8); new DataView(length.buffer).setBigUint64(0, BigInt(chunk.size), true);
    parts.push(length, chunk);
  }
  return new Blob(parts, { type: 'application/x-melonds-workspace' });
}
export async function decodeWorkspace(file) {
  if (!(file instanceof Blob) || file.size < 16) throw Error('Invalid .mel file');
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (!magic.every((byte, i) => header[i] === byte)) throw Error('Unknown .mel format');
  const view = new DataView(header.buffer), size = view.getUint32(8, true), count = view.getUint32(12, true);
  if (size > 32 * 1024 * 1024 || count > 100000 || 16 + size > file.size) throw Error('Invalid .mel directory');
  const directory = JSON.parse(await file.slice(16, 16 + size).text());
  const chunks = [], decoded = new Map();
  let offset = 16 + size;
  for (let i = 0; i < count; i++) {
    if (offset + 8 > file.size) throw Error('Truncated .mel chunk');
    const length = Number(new DataView(await file.slice(offset, offset + 8).arrayBuffer()).getBigUint64(0, true));
    offset += 8;
    if (!Number.isSafeInteger(length) || offset + length > file.size) throw Error('Invalid .mel chunk size');
    chunks.push(file.slice(offset, offset + length)); offset += length;
  }
  if (offset !== file.size) throw Error('Unexpected .mel trailing bytes');
  async function expand(item, depth = 0) {
    if (depth > 80) throw Error('Invalid .mel nesting');
    if (!item || typeof item !== 'object') return item;
    if ('$melBinary' in item) {
      const id = item.$melBinary, blob = chunks[id];
      if (!Number.isInteger(id) || !blob || blob.size !== item.length || !['blob', 'bytes'].includes(item.kind)) throw Error('Invalid .mel binary reference');
      if (!decoded.has(id)) decoded.set(id, item.kind === 'bytes' ? new Uint8Array(await blob.arrayBuffer())
        : item.name ? new File([blob], item.name, { type: item.type || '' }) : blob.slice(0, blob.size, item.type || ''));
      return decoded.get(id);
    }
    if (Array.isArray(item)) return Promise.all(item.map(value => expand(value, depth + 1)));
    const result = Object.create(null);
    for (const [key, value] of Object.entries(item)) result[key] = await expand(value, depth + 1);
    return result;
  }
  return expand(directory);
}
