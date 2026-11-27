// Strings retain the original UTF-8 API; binary views retain their exact bytes.
export function apBytes(value = '') {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
    return new Uint8Array(value);
  }
  return Uint8Array.from(value);
}

export function apSecurity(value = 'open') {
  if (typeof value === 'number') return value;
  switch (value) {
    case 'open': return 0;
    case 'wep40': return 1;
    case 'wep104': return 2;
    default: return -1;
  }
}
