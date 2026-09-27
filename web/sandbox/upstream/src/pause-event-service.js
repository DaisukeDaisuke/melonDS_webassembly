import { subscribeAbort } from "./validation.js";

export function createPauseEventService() {
    let serial = 0;
    let latest = null;
    const listeners = new Set();

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function publish(details = {}) {
        const event = Object.freeze({
            paused: true,
            running: false,
            ...details,
            serial: ++serial
        });
        latest = event;
        for (const listener of listeners) listener(event);
        return event;
    }

    function waitForEvent({
        afterSerial = serial,
        kinds,
        signal
    } = {}) {
        const acceptedKinds = kinds ? new Set(kinds) : null;
        if (latest
            && latest.serial > afterSerial
            && (!acceptedKinds || acceptedKinds.has(latest.pauseKind))) {
            return Promise.resolve(latest);
        }
        return new Promise((resolve, reject) => {
            let unsubscribeAbort = () => {};
            const cleanup = () => {
                listeners.delete(done);
                unsubscribeAbort();
            };
            const done = (event) => {
                if (event.serial <= afterSerial) return;
                if (acceptedKinds && !acceptedKinds.has(event.pauseKind)) return;
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
