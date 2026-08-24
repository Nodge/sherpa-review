export type RecentStorage = Pick<Storage, 'getItem' | 'setItem'>;

const PREFIX = 'sherpa.palette.recent';
export const RECENT_LIMIT = 5;

export function recentStorageKey(prKey: string): string {
    return `${PREFIX}.${prKey}`;
}

/** A corrupt or unavailable record means an empty history. */
export function readRecent(storage: RecentStorage | null, prKey: string): readonly string[] {
    let raw: string | null;
    try {
        raw = storage?.getItem(recentStorageKey(prKey)) ?? null;
    } catch {
        return [];
    }
    if (raw === null) {
        return [];
    }

    try {
        const payload: unknown = JSON.parse(raw);
        if (!Array.isArray(payload) || !payload.every((item) => typeof item === 'string')) {
            return [];
        }
        return [...new Set(payload)].slice(0, RECENT_LIMIT);
    } catch {
        return [];
    }
}

export function writeRecent(storage: RecentStorage | null, prKey: string, ids: readonly string[]): void {
    try {
        storage?.setItem(recentStorageKey(prKey), JSON.stringify([...new Set(ids)].slice(0, RECENT_LIMIT)));
    } catch {
        // With a quota limit or browser policy restriction, history will not survive a reload.
    }
}

export function addRecent(storage: RecentStorage | null, prKey: string, id: string): readonly string[] {
    const next = [id, ...readRecent(storage, prKey).filter((candidate) => candidate !== id)].slice(0, RECENT_LIMIT);
    writeRecent(storage, prKey, next);
    return next;
}

/** `localStorage` may be unavailable in the gallery, tests or a restricted browser environment. */
export function globalRecentStorage(): RecentStorage | null {
    try {
        const storage: unknown = globalThis.localStorage;
        return storage == null ? null : (storage as RecentStorage);
    } catch {
        return null;
    }
}
