import type { UiStopProgress } from '@sherpa/protocol';

/**
 * Viewed marks on route stops (docs/design/README.md, State model: `viewed {stopId→bool}`).
 * Persistence is on the server: the progress endpoint supplies the source of truth, and the store holds its snapshot with an optimistic
 * layer on top, just as `DiffViewStore` holds file records.
 *
 * The store lives outside the React tree (like the other UI stores): subscription plus `useSyncExternalStore`.
 */

export interface StopProgressStore {
    readonly subscribe: (listener: () => void) => () => void;
    /** Stop marks. An absent key means unviewed. */
    readonly getSnapshot: () => ReadonlyMap<string, boolean>;
    readonly isViewed: (stopId: string) => boolean;
    /** Optimistic mark: the control responds without waiting for the network. */
    readonly setViewed: (stopId: string, viewed: boolean) => void;
    /** Roll back a failed write: `null` means there was no record at all. */
    readonly restore: (stopId: string, viewed: boolean | null) => void;
    /** Full server snapshot (already merged with writes it missed). */
    readonly setAll: (records: readonly UiStopProgress[]) => void;
}

export function createStopProgressStore(initial: readonly UiStopProgress[] = []): StopProgressStore {
    const listeners = new Set<() => void>();
    let snapshot: ReadonlyMap<string, boolean> = new Map(
        initial.map((record) => [record.stopId, record.viewed]),
    );

    const update = (next: ReadonlyMap<string, boolean>): void => {
        snapshot = next;
        for (const listener of [...listeners]) {
            listener();
        }
    };

    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,
        isViewed: (stopId) => snapshot.get(stopId) === true,
        setViewed: (stopId, viewed) => {
            if (snapshot.get(stopId) === viewed) {
                return;
            }
            update(new Map(snapshot).set(stopId, viewed));
        },
        restore: (stopId, viewed) => {
            if (viewed === null) {
                if (!snapshot.has(stopId)) {
                    return;
                }
                const next = new Map(snapshot);
                next.delete(stopId);
                update(next);
                return;
            }
            if (snapshot.get(stopId) === viewed) {
                return;
            }
            update(new Map(snapshot).set(stopId, viewed));
        },
        setAll: (records) => {
            update(new Map(records.map((record) => [record.stopId, record.viewed])));
        },
    };
}
