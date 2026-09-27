export function createSaveService({ native, romService }) {
    function savePath(name) {
        const path = String(name).toLowerCase().endsWith(".dsv") ? "rom.dsv" : "rom.sav";
        return path;
    }

    async function applyAndReload(name, bytes, options = {}) {
        const result = await romService.reload({
            ...options,
            candidateSave: { name, bytes: new Uint8Array(bytes) }
        });
        return { path: savePath(name), ret: result };
    }

    function exportBytes() {
        return native.exportSaveBytes();
    }

    return Object.freeze({ applyAndReload, exportBytes });
}
