const LOCK_ATTRIBUTE = "data-desmume-ui-interaction-locked";
const LOCK_STYLE_ID = "desmume-ui-interaction-lock-style";
const BLOCKED_EVENT_TYPES = Object.freeze([
    "pointerdown",
    "mousedown",
    "touchstart",
    "click",
    "dblclick",
    "contextmenu",
    "keydown",
    "keypress",
    "wheel"
]);

function validateOwner(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
        const error = new Error("UI interaction lock owner must be a non-empty identifier up to 128 characters");
        error.mcpCode = "INVALID_ARGUMENT";
        throw error;
    }
    return value;
}

export function createUiInteractionLock({ documentRef = document, eventTarget = window } = {}) {
    const owners = new Set();
    const root = documentRef.documentElement;
    const blockTrustedUserEvent = (event) => {
        if (owners.size === 0 || event?.isTrusted !== true) return;
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
    };
    for (const type of BLOCKED_EVENT_TYPES) {
        eventTarget.addEventListener(type, blockTrustedUserEvent, { capture: true });
    }
    const style = documentRef.createElement("style");
    style.id = LOCK_STYLE_ID;
    style.textContent = `
html[${LOCK_ATTRIBUTE}="true"] button,
html[${LOCK_ATTRIBUTE}="true"] .file-button,
html[${LOCK_ATTRIBUTE}="true"] input,
html[${LOCK_ATTRIBUTE}="true"] select,
html[${LOCK_ATTRIBUTE}="true"] textarea,
html[${LOCK_ATTRIBUTE}="true"] [data-button],
html[${LOCK_ATTRIBUTE}="true"] #screen-shell {
    pointer-events: none !important;
    cursor: not-allowed !important;
}
html[${LOCK_ATTRIBUTE}="true"] button,
html[${LOCK_ATTRIBUTE}="true"] .file-button,
html[${LOCK_ATTRIBUTE}="true"] input,
html[${LOCK_ATTRIBUTE}="true"] select,
html[${LOCK_ATTRIBUTE}="true"] textarea,
html[${LOCK_ATTRIBUTE}="true"] [data-button] {
    opacity: 0.55;
}
`;
    documentRef.head.append(style);
    const snapshot = () => ({
        locked: owners.size > 0,
        ownerCount: owners.size,
        owners: [...owners].sort()
    });
    const syncRoot = () => {
        if (owners.size > 0) root.setAttribute(LOCK_ATTRIBUTE, "true");
        else root.removeAttribute(LOCK_ATTRIBUTE);
    };
    const set = ({ owner, locked }) => {
        const normalizedOwner = validateOwner(owner);
        if (typeof locked !== "boolean") {
            const error = new Error("UI interaction lock locked must be boolean");
            error.mcpCode = "INVALID_ARGUMENT";
            throw error;
        }
        if (locked) owners.add(normalizedOwner);
        else owners.delete(normalizedOwner);
        syncRoot();
        return snapshot();
    };
    const dispose = () => {
        owners.clear();
        syncRoot();
        for (const type of BLOCKED_EVENT_TYPES) {
            eventTarget.removeEventListener(type, blockTrustedUserEvent, { capture: true });
        }
        style.remove();
    };
    return { set, snapshot, dispose };
}

export { BLOCKED_EVENT_TYPES, LOCK_ATTRIBUTE, LOCK_STYLE_ID };
