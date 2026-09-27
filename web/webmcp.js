// Every operation is discoverable on its own; the shared dispatcher stays internal.
export async function registerWebMcp(api, modelContext = document.modelContext || navigator.modelContext) {
  if (!modelContext?.registerTool) return 0;
  let count = 0;
  for (const name of api.toolNames()) {
    const globalTool = ['listInstances', 'createInstance', 'loadRomMany'].includes(name);
    // Blob-backed operations need a local File selector; JSON WebMCP cannot carry a File.
    if (['loadRom', 'loadRomMany'].includes(name)) continue;
    const schema = {
      type: 'object', properties: globalTool ? {} : { instanceId: { type: 'integer', minimum: 0, maximum: 15 } },
      required: globalTool ? [] : ['instanceId'], additionalProperties: true
    };
    try {
      await modelContext.registerTool({
        name: `melonds.${name}`, title: `melonDS ${name}`,
        description: `${name} operates on the actual melonDS backend and resolves when it finishes. ${globalTool ? 'Global operation.' : 'An explicit instanceId is required.'}`,
        inputSchema: schema,
        execute: async args => {
          try { return { content: [{ type: 'text', text: JSON.stringify(await api[name](args)) }] }; }
          catch (error) { return { isError: true, content: [{ type: 'text', text: String(error.message || error) }] }; }
        }
      });
      count++;
    } catch (error) {
      console.warn(`WebMCP registration failed: melonds.${name}`, error);
    }
  }
  return count;
}
