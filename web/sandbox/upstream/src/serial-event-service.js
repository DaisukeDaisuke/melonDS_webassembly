import { subscribeAbort } from "./validation.js";

export function createSerialEventService() {
    let serial = 0;
    let latest = null;
    const listeners = new Set();

    function publish(details = {}) {
        const event = Object.freeze({ ...details, serial: ++serial });
        latest = event;
        for (const listener of listeners) listener(event);
        return event;
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function waitForEvent({ afterSerial = serial, predicate = () => true, signal } = {}) {
        if (latest && latest.serial > afterSerial && predicate(latest)) {
            return Promise.resolve(latest);
        }
        return new Promise((resolve, reject) => {
            let unsubscribeAbort = () => {};
            const cleanup = () => {
                listeners.delete(done);
                unsubscribeAbort();
            };
            const done = (event) => {
                if (event.serial <= afterSerial || !predicate(event)) return;
                cleanup();
                resolve(event);
            };
            const aborted = () => {
                cleanup();
                reject(new DOMException("aborted", "AbortError"));
            };
            listeners.add(done);
            unsubscribeAbort = subscribeAbort(signal, aborted);
        });
    }

    return Object.freeze({
        currentSerial: () => serial,
        latest: () => latest,
        publish,
        subscribe,
        waitForEvent
    });
}
