export function createBreakpointService({ ownerStore }) {
    let serial = 0;
    const listeners = new Set();

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function waitForEvent({
        afterSerial = serial,
        scriptBreakpoints = "ignore",
        predicate = () => true,
        signal
    } = {}) {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                listeners.delete(done);
                signal?.removeEventListener("abort", aborted);
            };
            const done = (event) => {
                if (event.serial <= afterSerial) return;
                if (scriptBreakpoints !== "include" && event.scriptOnly) return;
                if (!predicate(event)) return;
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

    return {
        publish(hit) {
            const site = {
                cpu: String(hit.cpu),
                type: String(hit.type),
                address: Number(hit.address) >>> 0
            };
            const classification = ownerStore.classifySite(hit.ownerSite || site);
            const event = { ...hit, ...classification, serial: ++serial, site };
            for (const listener of listeners) listener(event);
            return event;
        },
        currentSerial: () => serial,
        subscribe,
        waitForEvent
    };
}
