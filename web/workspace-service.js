import { encodeWorkspace, decodeWorkspace } from './workspace-file.js';
export function createWorkspaceService({ api, backend, network, readUI, restoreUI, beforeRestore }) {
  let busy = false;
  async function exclusive(action) {
    if (busy) throw Error('.mel の保存または復元を実行中です');
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  const pauseAll = async () => {
    const statuses = await Promise.all((await api.listInstances()).map(instanceId => api.status({ instanceId })));
    await Promise.all(statuses.map(({ instanceId }) => api.pause({ instanceId })));
    await backend.execute('workspaceFlush'); await network.suspend();
    await backend.execute('workspacePacketSuspend');
    return statuses;
  };
  const resume = async statuses => {
    await backend.execute('workspacePacketResume');
    network.resume();
    await Promise.all(statuses.filter(status => status.loaded && !status.paused).map(({ instanceId }) => api.resume({ instanceId })));
  };
  return Object.freeze({
    export: () => exclusive(async () => {
      const statuses = await pauseAll();
      try {
        const sourceRoms = await backend.execute('workspaceRoms'), roms = [], romIndex = new Map();
        const instances = [];
        for (const status of statuses) {
          const rom = sourceRoms.find(record => record.instanceId === status.instanceId);
          if (status.loaded && !rom) throw Error(`ROM #${status.instanceId} の元データがありません`);
          let index = null;
          if (rom) {
            if (!romIndex.has(rom.hash)) { romIndex.set(rom.hash, roms.length); roms.push(rom.file); }
            index = romIndex.get(rom.hash);
          }
          const data = await backend.execute('workspaceCapture', { instanceId: status.instanceId });
          const captured = await api.status({ instanceId: status.instanceId });
          instances.push({ ...captured, paused: status.paused, rom: index, data });
        }
        await backend.execute('workspaceFlush'); await network.suspend();
        const result = { version: 3, createdAt: new Date().toISOString(), instances, roms,
          transport: await backend.execute('workspaceTransport'), network: network.snapshot(),
          files: await network.files.snapshot(), scripts: await backend.execute('workspaceScripts'), packetControl: await backend.execute('workspacePackets'), ui: readUI() };
        return encodeWorkspace(result);
      } finally { await resume(statuses); }
    }),
    import: file => exclusive(async () => {
      const saved = await decodeWorkspace(file);
      if (![3, 4].includes(saved.version) || !Array.isArray(saved.instances) || saved.instances.length > 16 || !Array.isArray(saved.roms)
        || !saved.transport || !Array.isArray(saved.files) || !saved.ui) throw Error('Invalid .mel workspace');
      const ids = new Set();
      for (const record of saved.instances) {
        if (!Number.isInteger(record.instanceId) || record.instanceId < 0 || record.instanceId > 15 || ids.has(record.instanceId)) throw Error('Invalid .mel instance ID');
        ids.add(record.instanceId);
        if (record.loaded && !(saved.roms[record.rom] instanceof Blob)) throw Error('Missing .mel ROM');
        if (record.data?.slots?.length !== 10 || !record.data.system) throw Error('Missing .mel state');
      }
      await beforeRestore?.();
      await pauseAll();
      try {
        network.restore([]);
        for (const instanceId of await api.listInstances()) await api.destroyInstance({ instanceId });
        for (const record of saved.instances) {
          const instanceId = record.instanceId;
          await api.createInstance({ instanceId });
          for (const [kind, data] of Object.entries(record.data.system)) await api.loadSystemFile({ instanceId, kind, file: new Blob([data]), preserveMac: true });
          if (record.loaded) {
            await api.loadRom({ instanceId, file: saved.roms[record.rom] });
            await api.pause({ instanceId });
          }
          await backend.execute('workspaceRestore', { instanceId, data: record.data });
        }
        await network.files.restore(saved.files);
        await backend.execute('workspaceTransport', { data: saved.transport });
        await backend.execute('workspacePackets', { data: saved.packetControl });
        network.restore(saved.network);
        await restoreUI(saved.ui, saved.scripts || []);
        await resume(saved.instances);
        return { instances: saved.instances.map(record => record.instanceId), scripts: saved.scripts?.length || 0 };
      } catch (error) {
        // Do not run a partially restored workspace after an import error.
        await Promise.all((await api.listInstances()).map(instanceId => api.pause({ instanceId })));
        await backend.execute('workspacePacketResume'); network.resume(); throw error;
      }
    })
  });
}
