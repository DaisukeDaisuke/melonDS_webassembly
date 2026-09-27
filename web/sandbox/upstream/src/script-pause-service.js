export function createScriptPauseService() {
    let serial = 0;
    const listeners = new Set();

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function publish(details) {
        const event = { ...details, serial: ++serial };
        for (const listener of listeners) listener(event);
        return event;
    }

    function waitForEvent({ afterSerial = serial, signal } = {}) {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                listeners.delete(done);
                signal?.removeEventListener("abort", aborted);
            };
            const done = (event) => {
                if (event.serial <= afterSerial) return;
                cleanup();
                resolve(event);
            };
            const aborted = () => {
                cleanup();
                reject(new DOMException("aborted", "AbortError"));
            };
            listeners.add(done);
            signal?.addEventListener("abort", aborted, { once: true });
            if (signal?.aborted) aborted();
        });
    }

    return Object.freeze({
        currentSerial: () => serial,
        publish,
        subscribe,
        waitForEvent
    });
}
