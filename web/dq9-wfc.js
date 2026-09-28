// Browser port of dq9_micro_dwc_server_emulator.cpp's RequestHandler.cpp.
// The original project's MIT notice is in ./dq9/LICENSE.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const token = 'NDSX0zyY6Wc6SQ6GnvXStABwbFCBjgt+MVQyhs1vMO5qsMnBePlcnGOjjPTcloogWX03yHVP9Q5xnUms8jZUzyd2W9ytWFtlwUOhAcO0x9WfFv2qPNFNr9O0ehktRYRcv89';
const maxFile = 16 * 1024 * 1024;

function encoded(value) {
  const bytes = encoder.encode(String(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('=', '*');
}
function param(body, name) {
  if (body.length > 128 * 1024) return '';
  const form = new URLSearchParams(decoder.decode(body));
  const value = form.get(name);
  if (!value || value.length > 128 * 1024) return '';
  const base64 = value.replaceAll('*', '=');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) return '';
  try {
    const decoded = atob(base64);
    return decoded.length <= 64 * 1024 ? decoded : '';
  } catch { return ''; }
}
const validGame = game => /^[a-z]{4}$/i.test(game);
const validFile = name => typeof name === 'string' && name.length > 0 && name.length <= 128
  && !/[\x00-\x1f\x7f"';/\\<>:|?*]/.test(name) && !name.includes('..')
  && !/[ .]$/.test(name) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
const response = (status, body, headers = {}) => ({ status, body: body instanceof Uint8Array ? body : encoder.encode(String(body)), headers });
const dateFor = game => game === 'YDQJ' ? 'Sat, 31 Dec 2050 12:00:00 GMT' : new Date().toUTCString();
const normalizeList = text => String(text).split(/\r\n|\r|\n/).map(record => record.replace(/^[\r\n]+|[\r\n]+$/g, ''))
  .filter(Boolean).map(record => `${record}\r\n`).join('');
const connectionTest = encoder.encode('HTTP/1.1 200 OK\r\nServer: Nintendo Wii (http) \r\n'
  + 'Content-type: text/html\r\nX-Organization: Nintendo\r\nVary: Accept-Encoding\r\n'
  + 'Connection: close\r\n\r\nok');

export function createDq9WfcHandler({ dlc = {}, getFile } = {}) {
  // Each game supplies its own _list.txt and named binary contents. The source
  // project ships no DLC data. Values may be strings, Uint8Arrays or Blobs.
  const games = new Map(Object.entries(dlc).map(([game, files]) => [game.toUpperCase(), files]));
  async function file(game, name, maxSize = maxFile) {
    const value = games.get(game.toUpperCase())?.[name] ?? (getFile ? await getFile({ gamecd: game, name }) : null);
    if (value == null) return null;
    if ((value instanceof Blob && value.size > maxSize) || (typeof value === 'string' && value.length > maxSize)) return 'oversize';
    const bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer())
      : typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
    return bytes.length <= maxSize ? bytes : 'oversize';
  }
  return Object.freeze({
    setDlc(game, files) {
      if (!validGame(game) || !files || typeof files !== 'object') throw new TypeError('Invalid game or DLC files');
      games.set(game.toUpperCase(), { ...files });
    },
    async handle({ port, host = '', method = 'GET', path = '/', body = new Uint8Array() }) {
      if (port === 80) return { raw: connectionTest };
      if (port !== 443) return response(404, 'err');
      // Retail and test endpoints implement the same NAS/DLS wire protocol.
      const domain = host.toLowerCase().split(':')[0].replace(/^(nas|dls1)\.test\.nintendowifi\.net$/, '$1.nintendowifi.net');
      if (domain === 'nas.nintendowifi.net') {
        if (path === '/ac') {
          const action = param(body, 'action');
          const game = param(body, 'gamecd');
          if (!validGame(game)) return response(401, 'err');
          if (action === 'login' || action === 'LOGIN') {
            const fields = { returncd: '001', retry: '0', locator: 'gamespy.com', challenge: 'RNR1HLAS', token };
            return response(200, Object.entries(fields).map(([key, value]) => `${key}=${encoded(value)}`).join('&'),
              { Date: dateFor(game) });
          }
          if (action === 'svcloc' || action === 'SVCLOC') {
            const svc = param(body, 'svc');
            let fields = [['returncd', '007'], ['statusdata', 'Y'], ['retry', '0']];
            // Preserve the C++ RequestHandler's two independent ifs, including
            // its extra servicetoken for svc=9000.
            if (svc === '9000') fields = [...fields, ['token', token], ['svchost', 'dls1.nintendowifi.net']];
            if (svc === '0000') fields = [...fields, ['servicetoken', token], ['svchost', 'n/a']];
            else fields = [...fields, ['servicetoken', token], ['svchost', 'dls1.nintendowifi.net']];
            return response(200, fields.map(([key, value]) => `${key}=${encoded(value)}`).join('&'),
              { Date: dateFor(game) });
          }
        }
        if (path === '/pr') {
          const wordsValue = param(body, 'words');
          const words = wordsValue ? wordsValue.split('\t').length : 0;
          if (words > 4096) return response(400, 'err');
          const flags = '0'.repeat(words);
          const fields = { prwords: flags, returncd: '000', datetime: '20250101120000' };
          for (const letter of 'ACEJKP') fields[`prwords${letter}`] = flags;
          return response(200, Object.entries(fields).map(([key, value]) => `${key}=${encoded(value)}`).join('&'),
            { 'Content-Type': 'text/plain', NODE: 'wifiappe1' });
        }
      }
      if (domain === 'dls1.nintendowifi.net' && path.startsWith('/download')) {
        const game = param(body, 'gamecd');
        if (!validGame(game)) return response(401, 'err');
        const action = param(body, 'action');
        const headers = { 'Content-Type': 'text/plain', 'X-DLS-Host': 'http://127.0.0.1/' };
        if (['count', 'COUNT', 'list', 'LIST'].includes(action)) {
          const list = await file(game, '_list.txt', 1024 * 1024);
          if (list === 'oversize') return response(413, 'err');
          if (!list || !list.length) return response(500, 'err');
          const normalized = normalizeList(decoder.decode(list));
          return response(200, action.toLowerCase() === 'count' ? String(normalized.split('\r\n').length - 1) : normalized, headers);
        }
        if (action === 'contents' || action === 'CONTENTS') {
          const contents = param(body, 'contents');
          if (!validFile(contents)) return response(400, 'err');
          const payload = await file(game, contents);
          if (payload === 'oversize') return response(413, 'err');
          if (!payload) return response(404, 'err');
          return response(200, payload, { ...headers, 'Content-Type': 'application/x-dsdl',
            'Content-Disposition': `attachment; filename="${contents}"` });
        }
      }
      return response(404, 'err');
    }
  });
}

export function httpBytes(result) {
  if (result.raw) return result.raw;
  const reasons = { 200: 'OK', 400: 'err', 401: 'err', 404: 'Not Found', 413: 'err', 500: 'err' };
  const lines = [`HTTP/1.1 ${result.status} ${reasons[result.status] || 'err'}`];
  for (const [key, value] of Object.entries(result.headers || {})) {
    if (!/^[A-Za-z0-9-]+$/.test(key) || /[\r\n\x00]/.test(String(value))) throw Error('Invalid response header');
    lines.push(`${key}: ${value}`);
  }
  lines.push(`Content-Length: ${result.body.length}`, 'Connection: close', '', '');
  const header = encoder.encode(lines.join('\r\n'));
  const data = new Uint8Array(header.length + result.body.length);
  data.set(header); data.set(result.body, header.length);
  return data;
}
