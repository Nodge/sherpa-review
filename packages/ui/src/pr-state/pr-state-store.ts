import type { UiPrState, UiPrStatePatch } from '@sherpa/protocol';
import { uiPrStateSchema } from '@sherpa/protocol';

/**
 * UI state for one PR (M3-T18): collapsed tree directories and diff cards, recent palette
 * commands. Stored in the PR database on the server, rather than `localStorage`: each PR server listens on a random
 * port, and browser storage is empty for the new port.
 *
 * Changes apply optimistically, with debounced writes following. Collapsing a directory is
 * a series of clicks, and each does not need its own request. A failed write keeps the choice:
 * the reviewer already sees the collapsed tree, and jumping back is worse than losing persistence.
 *
 * The endpoint replaces each named field in full, so requests are built on top of server state:
 * writes wait until boot-GET responds, and are disabled entirely if it fails.
 * Otherwise the first collapse would send a map built from defaults and erase everything this
 * PR remembered.
 */

export const DEFAULT_UI_PR_STATE: UiPrState = uiPrStateSchema.parse({});

/** How many recent commands the palette shows (the UI enforces the display limit, the server only stores them). */
export const PALETTE_RECENT_LIMIT = 5;

/** Delay before sending: a series of tree clicks becomes one PATCH with the latest value. */
export const PR_STATE_SEND_DEBOUNCE_MS = 300;

/**
 * Individual state fields. The patch schema cannot be used here: `.partial()` on a schema with defaults
 * supplies a default for a missing key, turning "leave the field alone" into "reset it".
 */
const PR_STATE_FIELDS = [
    'treeCollapsed',
    'diffCollapsed',
    'paletteRecent',
] as const satisfies readonly (keyof UiPrState)[];

export interface UiPrStateStore {
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => UiPrState;
    /** Applies named fields immediately and delays sending. Unchanged fields are never sent. */
    readonly update: (patch: UiPrStatePatch) => void;
    /**
     * State boot-GET: writes wait for its outcome because a patch replaces each field
     * in full. On success, server state enters the snapshot and pending writes are released.
     * On failure, state stays in memory with defaults, and writes are disabled until reload.
     * The server response preserves fields the reviewer has already changed by hand (maps merge by
     * key: reviewer choices go on top of server values instead of discarding them).
     */
    readonly load: (fetchState: () => Promise<UiPrState>) => Promise<void>;
    /** Send unacknowledged changes immediately: the tab is leaving (`pagehide`), with no second chance. */
    readonly flush: () => void;
}

export interface UiPrStateStoreOptions {
    readonly initial?: Partial<UiPrState>;
    /** Write transport. Without it, state lives only in memory (tests, gallery). */
    readonly send?: (patch: UiPrStatePatch, options?: { readonly keepalive?: boolean }) => Promise<UiPrState>;
}

/** A store without a declared boot-GET writes immediately: it either has no server or nothing to overwrite. */
type LoadState = 'ready' | 'pending' | 'failed';

export function createUiPrStateStore(options: UiPrStateStoreOptions = {}): UiPrStateStore {
    const listeners = new Set<() => void>();
    const changedHere = new Set<keyof UiPrState>();
    /**
     * Fields whose current values the server has not acknowledged yet. Each request builds them from
     * the snapshot instead of an accumulated patch: failed and interrupted writes stay here and
     * go out with the next send or `flush()`.
     */
    const unconfirmed = new Set<keyof UiPrState>();
    let snapshot: UiPrState = { ...DEFAULT_UI_PR_STATE, ...options.initial };
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Writes form a chain: two consecutive PATCH requests must not apply in reverse order.
    let queue: Promise<unknown> = Promise.resolve();
    // Increments on flush: queued writes from the previous epoch are no longer needed. Flush
    // sent their fields with current values, so they have no reason to overtake it.
    let epoch = 0;
    let loadState: LoadState = 'ready';

    const notify = (): void => {
        for (const listener of [...listeners]) {
            listener();
        }
    };

    /** Applies only named fields that differ and returns those fields to send. */
    const applyLocally = (patch: UiPrStatePatch): UiPrStatePatch => {
        const changes: UiPrStatePatch = {};
        for (const field of PR_STATE_FIELDS) {
            const value = patch[field];
            if (value !== undefined && !sameFieldValue(value, snapshot[field])) {
                Object.assign(changes, { [field]: value });
            }
        }
        if (Object.keys(changes).length === 0) {
            return changes;
        }
        // The snapshot always passes the schema, so invalid values cannot enter it.
        snapshot = uiPrStateSchema.parse({ ...snapshot, ...changes });
        notify();
        return changes;
    };

    /** Builds the request from the snapshot, sending what the reviewer sees now. */
    const unconfirmedPatch = (): UiPrStatePatch => {
        const patch: UiPrStatePatch = {};
        for (const field of PR_STATE_FIELDS) {
            if (unconfirmed.has(field)) {
                Object.assign(patch, { [field]: snapshot[field] });
            }
        }
        return patch;
    };

    /** A field is acknowledged only if it has not changed again since sending. */
    const confirm = (patch: UiPrStatePatch): void => {
        for (const field of PR_STATE_FIELDS) {
            const sent = patch[field];
            if (sent !== undefined && sameFieldValue(sent, snapshot[field])) {
                unconfirmed.delete(field);
            }
        }
    };

    const dispatch = (keepalive: boolean): void => {
        const transport = options.send;
        if (transport === undefined || loadState !== 'ready' || unconfirmed.size === 0) {
            return;
        }
        const patch = unconfirmedPatch();
        const fire = (): Promise<void> =>
            transport(patch, keepalive ? { keepalive: true } : {}).then(
                () => {
                    confirm(patch);
                },
                (error: unknown) => {
                    console.warn('Failed to save UI state on the server:', error);
                },
            );
        if (keepalive) {
            // The tab is leaving: send the request directly in the event handler, bypassing the queue. If
            // it waited for the previous write, the browser would tear down the page before the request could run.
            epoch += 1;
            void fire();
            return;
        }
        const sendEpoch = epoch;
        queue = queue.then(
            () => (sendEpoch === epoch ? fire() : undefined),
            () => undefined,
        );
    };

    /**
     * Initial server state. It preserves fields the reviewer has already touched, but
     * maps still need their server values. Otherwise the next write, which replaces the whole field, would erase
     * server keys. Reviewer choices go on top of them.
     */
    const applyLoaded = (loaded: UiPrState): void => {
        const fresh: UiPrStatePatch = {};
        for (const field of PR_STATE_FIELDS) {
            if (!changedHere.has(field)) {
                Object.assign(fresh, { [field]: loaded[field] });
                continue;
            }
            const merged = localOverLoaded(loaded[field], snapshot[field]);
            if (merged !== undefined) {
                Object.assign(fresh, { [field]: merged });
            }
        }
        applyLocally(fresh);
    };

    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,

        update: (patch) => {
            const changes = applyLocally(patch);
            for (const field of PR_STATE_FIELDS) {
                if (changes[field] !== undefined) {
                    changedHere.add(field);
                    unconfirmed.add(field);
                }
            }
            if (Object.keys(changes).length === 0) {
                return;
            }
            // The first change opens the window: a series of clicks goes out in one request without waiting
            // indefinitely while the reviewer keeps clicking through the tree.
            timer ??= setTimeout(() => {
                timer = null;
                dispatch(false);
            }, PR_STATE_SEND_DEBOUNCE_MS);
        },

        load: (fetchState) => {
            loadState = 'pending';
            return fetchState().then(
                (loaded) => {
                    applyLoaded(loaded);
                    loadState = 'ready';
                    // Changes made while the response was in flight go out on top of server state.
                    dispatch(false);
                },
                (error: unknown) => {
                    loadState = 'failed';
                    unconfirmed.clear();
                    console.warn(
                        'This PR\'s UI state failed to load. Using defaults. Writes are disabled until' +
                            ' reload: the request replaces the entire field and would erase saved state.',
                        error,
                    );
                },
            );
        },

        flush: () => {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            dispatch(true);
        },
    };
}

/** MRU list of recent palette commands: latest first, no duplicates, length within the display limit. */
export function addRecentCommand(recent: readonly string[], commandId: string): string[] {
    return [commandId, ...recent.filter((candidate) => candidate !== commandId)].slice(0, PALETTE_RECENT_LIMIT);
}

/** Collapse maps are objects in the contract and `Map` in the diff store and tree. Convert at the boundary. */
export function collapsedToMap(collapsed: Readonly<Record<string, boolean>>): Map<string, boolean> {
    return new Map(Object.entries(collapsed));
}

export function collapsedFromMap(collapsed: ReadonlyMap<string, boolean>): Record<string, boolean> {
    return Object.fromEntries(collapsed);
}

/**
 * Merges server and local values for map fields: reviewer keys win, and other
 * server keys stay. `undefined` means there is nothing to merge (the recent-command MRU list has an order,
 * rather than a set of keys), so the entire local value wins.
 */
function localOverLoaded(loaded: unknown, local: unknown): Record<string, unknown> | undefined {
    if (isPlainRecord(loaded) && isPlainRecord(local)) {
        return { ...loaded, ...local };
    }
    return undefined;
}

/** Shallow field comparison: collapse maps and the command list are flat structures. */
function sameFieldValue(next: unknown, current: unknown): boolean {
    if (Array.isArray(next) && Array.isArray(current)) {
        return next.length === current.length && next.every((item, index) => item === current[index]);
    }
    if (isPlainRecord(next) && isPlainRecord(current)) {
        const keys = Object.keys(next);
        return (
            keys.length === Object.keys(current).length &&
            keys.every((key) => Object.hasOwn(current, key) && next[key] === current[key])
        );
    }
    return next === current;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
