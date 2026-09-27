export function createEmbeddedWorker(source) {
    let url;
    try {
        url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const worker = new Worker(url);
        let disposed = false;
        let workerTerminated = false;
        let blobUrlRevoked = false;
        return {
            worker,
            dispose() {
                if (disposed) return;
                disposed = true;
                worker.terminate();
                workerTerminated = true;
                URL.revokeObjectURL(url);
                blobUrlRevoked = true;
            },
            status() {
                return Object.freeze({ disposed, workerTerminated, blobUrlRevoked });
            }
        };
    } catch (error) {
        if (url) URL.revokeObjectURL(url);
        throw error;
    }
}
