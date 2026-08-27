/**
 * Full diff card collapse state survives reloads and is stored separately for each PR.
 * Stores the reviewer's explicit choice. A file without an entry still follows
 * the viewed and `generated` defaults, even if those defaults change later.
 */

export type CollapsedStorage = Pick<Storage, 'getItem' | 'setItem'>;

const PREFIX = 'sherpa.diff.collapsed';

export function collapsedStorageKey(prKey: string): string {
    return `${PREFIX}.${prKey}`;
}

/** An empty map means a missing or corrupt record. Broken storage is no reason to crash. */
export function readCollapsed(storage: CollapsedStorage | null, prKey: string): Map<string, boolean> {
    let raw: string | null;
    try {
        raw = storage?.getItem(collapsedStorageKey(prKey)) ?? null;
    } catch {
        return new Map();
    }
    if (raw === null) {
        return new Map();
    }

    let payload: unknown;
    try {
        payload = JSON.parse(raw);
    } catch {
        return new Map();
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return new Map();
    }

    const result = new Map<string, boolean>();
    for (const [fileId, value] of Object.entries(payload)) {
        if (typeof value === 'boolean') {
            result.set(fileId, value);
        }
    }
    return result;
}

export function writeCollapsed(
    storage: CollapsedStorage | null,
    prKey: string,
    collapsed: ReadonlyMap<string, boolean>,
): void {
    try {
        storage?.setItem(collapsedStorageKey(prKey), JSON.stringify(Object.fromEntries(collapsed)));
    } catch {
        // Quota or browser policy restriction. Collapsed state simply will not survive a reload.
    }
}

/** `localStorage` may be absent (tests, worker), despite what lib.dom promises. */
export function globalCollapsedStorage(): CollapsedStorage | null {
    try {
        const storage: unknown = globalThis.localStorage;
        return storage == null ? null : (storage as CollapsedStorage);
    } catch {
        return null;
    }
}
