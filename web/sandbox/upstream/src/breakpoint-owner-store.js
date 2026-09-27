import { ErrorCode } from "./error-codes.js";

export function breakpointSiteKey({ cpu, type, address }) {
    return `${cpu}:${type}:${Number(address) >>> 0}`;
}

export function createBreakpointOwnerStore({
    onFirstOwner = () => {},
    onLastOwner = () => {},
    onClearNative = () => {},
    onReconcileStart = () => {},
    onReconcileSuccess = () => {},
    onReconcileFailure = () => {}
} = {}) {
    const sites = new Map();
    const ids = new Map();

    function getSite(key) {
        return sites.get(typeof key === "string" ? key : breakpointSiteKey(key));
    }

    function getOwners(key) {
        return [...(getSite(key)?.owners.values() || [])];
    }

    function classifySite(key) {
        const owners = getOwners(key).filter((owner) => owner.enabled !== false);
        const has = (origin) => owners.some((owner) => owner.origin === origin);
        return {
            scriptOnly: owners.length > 0 && owners.every((owner) => owner.origin === "script"),
            userVisible: has("user"),
            operationOwned: has("operation"),
            mixed: has("script") && (has("user") || has("operation")),
            owners
        };
    }

    return {
        addOwner(site, owner) {
            const key = breakpointSiteKey(site);
            if (ids.has(owner.id)) {
                const error = new Error(`breakpoint owner ID already exists: ${owner.id}`);
                error.mcpCode = ErrorCode.BREAKPOINT_EXISTS;
                error.mcpDetails = { id: owner.id, existingSite: ids.get(owner.id), requestedSite: key };
                throw error;
            }
            const existingEntry = sites.get(key);
            const entry = existingEntry || {
                    ...site,
                    key,
                    address: Number(site.address) >>> 0,
                    owners: new Map()
                };
            const first = entry.owners.size === 0;
            if (first) onFirstOwner(entry);
            entry.owners.set(owner.id, { enabled: true, ...owner });
            ids.set(owner.id, key);
            if (!existingEntry) sites.set(key, entry);
            return entry;
        },
        removeOwner(ownerId) {
            const key = ids.get(ownerId);
            const entry = key && sites.get(key);
            if (!entry) return null;
            const owner = entry.owners.get(ownerId);
            const last = entry.owners.size === 1;
            if (last) onLastOwner(entry);
            entry.owners.delete(ownerId);
            ids.delete(ownerId);
            if (last) {
                sites.delete(key);
            }
            return { entry, owner };
        },
        discardOwner(ownerId) {
            const key = ids.get(ownerId);
            const entry = key && sites.get(key);
            if (!entry) return null;
            const owner = entry.owners.get(ownerId);
            entry.owners.delete(ownerId);
            ids.delete(ownerId);
            if (!entry.owners.size) sites.delete(key);
            return { entry, owner };
        },
        reconcileNativeBreakpoints() {
            onReconcileStart();
            try {
                onClearNative();
                let registered = 0;
                for (const entry of sites.values()) {
                    if (![...entry.owners.values()].some((owner) => owner.enabled !== false)) continue;
                    onFirstOwner(entry);
                    registered++;
                }
                onReconcileSuccess({ registered });
                return { cleared: true, registered };
            } catch (error) {
                try { onClearNative(); } catch {}
                onReconcileFailure(error);
                throw error;
            }
        },
        findBreakpointById(ownerId) {
            const key = ids.get(ownerId);
            return key ? sites.get(key) : null;
        },
        getSite,
        getOwners,
        classifySite,
        list() {
            return [...sites.values()];
        },
        hasWaitableBreakpoints({ includeScripts = false } = {}) {
            return [...sites.values()].some((entry) => {
                const classification = classifySite(entry.key);
                return classification.userVisible
                    || classification.operationOwned
                    || (includeScripts && classification.scriptOnly);
            });
        },
        removeOwnersByOrigin(origin) {
            const removed = [];
            for (const entry of [...sites.values()]) {
                for (const owner of [...entry.owners.values()]) {
                    if (origin !== "all" && owner.origin !== origin) continue;
                    const result = this.removeOwner(owner.id);
                    if (result) removed.push({ ...owner, site: result.entry });
                }
            }
            return removed;
        },
        discardOwnersByOrigin(origin) {
            const removed = [];
            for (const entry of [...sites.values()]) {
                for (const owner of [...entry.owners.values()]) {
                    if (origin !== "all" && owner.origin !== origin) continue;
                    const result = this.discardOwner(owner.id);
                    if (result) removed.push({ ...owner, site: result.entry });
                }
            }
            return removed;
        }
    };
}
