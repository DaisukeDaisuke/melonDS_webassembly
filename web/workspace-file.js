// .mel v3: MELWSP01, uncompressed variable-length binary chunks.
// .mel v4: MELWSP04, the same directory/chunk model with per-chunk deflate.
// ROM bytes are stored once per hash; JSON never contains expanded byte arrays.
const encoder = new TextEncoder();
const magicV3 = encoder.encode('MELWSP01');
const magicV4 = encoder.encode('MELWSP04');
const contentType = 'application/x-melonds-workspace';

function collect(value) {
  const chunks = [], references = [], seen = new WeakMap();
  const replacer = (_, item) => {
    if (!(item instanceof Blob) && !ArrayBuffer.isView(item) && !(item instanceof ArrayBuffer)) return item;
    if (seen.has(item)) return seen.get(item);
    const kind = item instanceof Blob ? 'blob' : 'bytes';
    const blob = item instanceof Blob ? item : new Blob([item]);
    const reference = { $melBinary: chunks.length, kind, length: blob.size, type: blob.type,
      name: item instanceof File ? item.name : undefined };
    chunks.push(blob); references.push(reference); seen.set(item, reference); return reference;
  };
  JSON.stringify(value, replacer);
  return {
    chunks, references,
    stringify: () => JSON.stringify(value, (_, item) => {
      if (!(item instanceof Blob) && !ArrayBuffer.isView(item) && !(item instanceof ArrayBuffer)) return item;
      return seen.get(item);
    })
  };
}

function pack(magic, directory, chunks) {
  const bytes = encoder.encode(directory);
  const header = new Uint8Array(16); header.set(magic);
  const view = new DataView(header.buffer);
  view.setUint32(8, bytes.length, true); view.setUint32(12, chunks.length, true);
  const parts = [header, bytes];
  for (const chunk of chunks) {
    const length = new Uint8Array(8); new DataView(length.buffer).setBigUint64(0, BigInt(chunk.size), true);
    parts.push(length, chunk);
  }
  return new Blob(parts, { type: contentType });
}

function encodeWorkspaceV3(value) {
  const { chunks, stringify } = collect(value);
  return pack(magicV3, stringify(), chunks);
}

async function deflate(blob) {
  return new Response(blob.stream().pipeThrough(new CompressionStream('deflate'))).blob();
}

async function encodeWorkspaceV4(value) {
  const current = { ...value, version: 4 };
  const { chunks, references, stringify } = collect(current);
  const stored = [];
  let saved = 0;
  for (let i = 0; i < chunks.length; i++) {
    const source = chunks[i], compressed = await deflate(source);
    if (compressed.size < source.size) {
      references[i].compression = 'deflate';
      references[i].storedLength = compressed.size;
      stored.push(compressed);
      saved += source.size - compressed.size;
    } else {
      references[i].compression = 'none';
      references[i].storedLength = source.size;
      stored.push(source);
    }
  }
  return { blob: pack(magicV4, stringify(), stored), saved };
}

export async function encodeWorkspace(value) {
  const legacy = encodeWorkspaceV3(value);
  if (typeof CompressionStream !== 'function') return legacy;
  try {
    const { blob, saved } = await encodeWorkspaceV4(value);
    return saved > 0 && blob.size < legacy.size ? blob : legacy;
  } catch {
    return legacy;
  }
}

async function inflate(blob, expectedLength) {
  if (typeof DecompressionStream !== 'function') throw Error('This browser cannot decompress .mel v4 files');
  const output = await new Response(blob.stream().pipeThrough(new DecompressionStream('deflate'))).blob();
  if (output.size !== expectedLength) throw Error('Invalid .mel compressed chunk');
  return output;
}

export async function decodeWorkspace(file) {
  if (!(file instanceof Blob) || file.size < 16) throw Error('Invalid .mel file');
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const isV3 = magicV3.every((byte, i) => header[i] === byte);
  const isV4 = magicV4.every((byte, i) => header[i] === byte);
  if (!isV3 && !isV4) throw Error('Unknown .mel format');
  const view = new DataView(header.buffer), size = view.getUint32(8, true), count = view.getUint32(12, true);
  if (size > 32 * 1024 * 1024 || count > 100000 || 16 + size > file.size) throw Error('Invalid .mel directory');
  const directory = JSON.parse(await file.slice(16, 16 + size).text());
  if ((isV3 && directory.version !== 3) || (isV4 && directory.version !== 4)) throw Error('Invalid .mel version');
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
      const id = item.$melBinary, stored = chunks[id];
      if (!Number.isInteger(id) || !stored || !Number.isSafeInteger(item.length) || !['blob', 'bytes'].includes(item.kind)) {
        throw Error('Invalid .mel binary reference');
      }
      if (!decoded.has(id)) {
        let blob = stored;
        if (isV4) {
          if (!['deflate', 'none'].includes(item.compression) || !Number.isSafeInteger(item.storedLength) || stored.size !== item.storedLength) {
            throw Error('Invalid .mel v4 binary reference');
          }
          if (item.compression === 'deflate') blob = await inflate(stored, item.length);
          else if (blob.size !== item.length) throw Error('Invalid .mel v4 chunk length');
        } else if (blob.size !== item.length) {
          throw Error('Invalid .mel binary reference');
        }
        decoded.set(id, item.kind === 'bytes' ? new Uint8Array(await blob.arrayBuffer())
          : item.name ? new File([blob], item.name, { type: item.type || '' }) : blob.slice(0, blob.size, item.type || ''));
      }
      return decoded.get(id);
    }
    if (Array.isArray(item)) return Promise.all(item.map(value => expand(value, depth + 1)));
    const result = Object.create(null);
    for (const [key, value] of Object.entries(item)) result[key] = await expand(value, depth + 1);
    return result;
  }
  return expand(directory);
}
