// Every operation is discoverable on its own; the shared dispatcher stays internal.
import { compactOutputText } from './sandbox/upstream/src/compact-output.js';

function compactResult(value, name) {
  if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    && ['readMemory', 'exportState', 'exportSave'].includes(name)) {
    return `ok=true\nlength=${value.length}\nhex=${value.slice(0, 256).map(byte => byte.toString(16).padStart(2, '0')).join(' ')}${value.length > 256 ? '\ntruncated=true' : ''}`;
  }
  if (name === 'screenshot' && value?.top && value?.bottom) {
    return `ok=true\nwidth=${value.width}\nheight=${value.height}\ntop.bytes=${value.top.length}\nbottom.bytes=${value.bottom.length}`;
  }
  return compactOutputText({ ok: true, value }).slice(0, 64 * 1024);
}

export async function registerWebMcp(api, modelContext = document.modelContext || navigator.modelContext) {
  if (!modelContext?.registerTool) return 0;
  let count = 0;
  for (const name of api.toolNames()) {
    const globalTool = ['listInstances', 'createInstance', 'loadRomMany'].includes(name);
    const binaryTool = ['loadRom', 'loadRomMany', 'loadState', 'importSave'].includes(name);
    const schema = {
      type: 'object', properties: {
        ...(!globalTool ? { instanceId: { type: 'integer', minimum: 0, maximum: 15 } } : {}),
        ...(binaryTool ? { fileBase64: { type: 'string', description: 'Local ROM/state/save bytes, base64 encoded.' } } : {}),
        ...(name === 'loadRomMany' ? { instanceIds: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 15 }, minItems: 1, maxItems: 16 } } : {})
      },
      required: [...(globalTool ? [] : ['instanceId']), ...(name === 'loadRom' || name === 'loadRomMany' || name === 'importSave' ? ['fileBase64'] : []),
        ...(name === 'loadRomMany' ? ['instanceIds'] : [])], additionalProperties: true
    };
    try {
      await modelContext.registerTool({
        name: `melonds.${name}`, title: `melonDS ${name}`,
        description: `${name} operates on the actual melonDS backend and resolves when it finishes. ${globalTool ? 'Global operation.' : 'An explicit instanceId is required.'}`,
        inputSchema: schema,
        execute: async args => {
          try {
            const params = typeof args === 'string' ? JSON.parse(args) : { ...args };
            if (binaryTool && params.fileBase64 !== undefined) {
              if (typeof params.fileBase64 !== 'string' || !/^[a-zA-Z0-9+/]*={0,2}$/.test(params.fileBase64)) {
                throw new TypeError('fileBase64 must be valid base64');
              }
              const decoded = atob(params.fileBase64);
              const bytes = new Uint8Array(decoded.length);
              for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
              params.file = new Blob([bytes]);
              delete params.fileBase64;
            }
            const value = await api[name](params);
            return { content: [{ type: 'text', text: compactResult(value, name) }] };
          }
          catch (error) { return { isError: true, content: [{ type: 'text', text: compactOutputText({ ok: false, error: { message: String(error.message || error) } }).slice(0, 2048) }] }; }
        }
      });
      count++;
    } catch (error) {
      console.warn(`WebMCP registration failed: melonds.${name}`, error);
    }
  }
  return count;
}
