export function createFileIoService() {
    function download(name, bytes, type = "application/octet-stream") {
        const anchor = document.createElement("a");
        anchor.href = URL.createObjectURL(new Blob([bytes], { type }));
        anchor.download = name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    }

    function readInput(input) {
        return new Promise((resolve, reject) => {
            const file = input.files && input.files[0];
            if (!file) {
                reject(new Error("file not selected"));
                return;
            }
            file.arrayBuffer().then((buffer) => {
                input.value = "";
                resolve({ file, bytes: new Uint8Array(buffer) });
            }, reject);
        });
    }

    function openPicker(input) {
        input.value = "";
        return new Promise((resolve, reject) => {
            let settled = false;
            let cancelTimer = 0;
            const cleanup = () => {
                settled = true;
                clearTimeout(cancelTimer);
                input.removeEventListener("change", onChange);
                input.removeEventListener("cancel", onCancel);
                window.removeEventListener("focus", onFocus);
            };
            const settle = (fn, value) => {
                if (settled) return;
                cleanup();
                fn(value);
            };
            const onChange = () => {
                readInput(input).then(
                    (selection) => settle(resolve, selection),
                    (error) => settle(reject, error)
                );
            };
            const onCancel = () => settle(reject, new Error("file selection cancelled"));
            const onFocus = () => {
                clearTimeout(cancelTimer);
                cancelTimer = setTimeout(() => {
                    if (!input.files || input.files.length === 0) {
                        settle(reject, new Error("file selection cancelled"));
                    }
                }, 250);
            };
            input.addEventListener("change", onChange, { once: true });
            input.addEventListener("cancel", onCancel, { once: true });
            window.addEventListener("focus", onFocus);
            input.click();
        });
    }

    return Object.freeze({ download, openPicker, readInput });
}
