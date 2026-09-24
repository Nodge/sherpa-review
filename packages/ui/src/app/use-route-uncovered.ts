import type { FileDiff, PrDiff, RouteSnapshot } from '@sherpa/protocol';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type { DiffFileModel } from '../diff/model.js';
import type { DiffViewStore } from '../diff-view/store.js';
import { snapshotFilling } from '../route/other-stop.js';
import { routeUncoveredLines } from '../route/route-model.js';

export interface RouteUncoveredOptions {
    readonly diff: PrDiff | null;
    readonly store: DiffViewStore | null;
    /** Live route snapshot. */
    readonly snapshot: RouteSnapshot | null;
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
}

/**
 * Uncovered ranges in a completed route for everything outside the route view: Overview, the palette,
 * the tour and the action bar. Without this, they would not know whether "Other" exists until the reviewer opens
 * the route. Parse the diff into the shared store in the background. `null` means parsing is unfinished or the route is building.
 */
export function useRouteUncovered({ diff, store, snapshot, parse }: RouteUncoveredOptions): number | null {
    const settled = snapshot !== null && !snapshotFilling(snapshot);
    // A parse failure is also a result. Exclude its lines, otherwise the count would wait forever.
    const [failedState, setFailedState] = useState<{ store: DiffViewStore; ids: ReadonlySet<string> } | null>(null);
    const failed = failedState !== null && failedState.store === store ? failedState.ids : EMPTY_IDS;

    useEffect(() => {
        if (!settled || diff === null || store === null) {
            return;
        }
        const timer = setTimeout(() => {
            for (const file of diff.files) {
                if (file.changeType === 'conflict' || store.getSnapshot().models.has(file.fileId)) {
                    continue;
                }
                parseSafely(parse, file).then(
                    (model) => {
                        store.setModel(file.fileId, model);
                    },
                    () => {
                        setFailedState((previous) => ({
                            store,
                            ids: new Set(previous?.store === store ? previous.ids : EMPTY_IDS).add(file.fileId),
                        }));
                    },
                );
            }
        }, BACKGROUND_PARSE_DELAY);
        return () => {
            clearTimeout(timer);
        };
    }, [diff, parse, settled, store]);

    const read = useMemo(
        () =>
            !settled || diff === null || store === null
                ? readNothing
                : uncoveredReader({ store, snapshot, files: diff.files, failed }),
        [diff, failed, settled, snapshot, store],
    );
    return useSyncExternalStore(store?.subscribe ?? noSubscribe, read, read);
}

/**
 * Read uncovered ranges for `useSyncExternalStore`. The store updates on every selection and mark,
 * but recalculation is needed only when the models change.
 */
function uncoveredReader({
    store,
    snapshot,
    files,
    failed,
}: {
    store: DiffViewStore;
    snapshot: RouteSnapshot;
    files: readonly FileDiff[];
    failed: ReadonlySet<string>;
}): () => number | null {
    let models: ReadonlyMap<string, DiffFileModel> | null = null;
    let value: number | null = null;
    return () => {
        const current = store.getSnapshot().models;
        if (current !== models) {
            models = current;
            value = routeUncoveredLines({ snapshot, files, models: current, failed });
        }
        return value;
    };
}

/** A worker can fail to start synchronously (no `Worker`). Treat this as a parse failure too. */
function parseSafely(parse: (file: FileDiff) => Promise<DiffFileModel>, file: FileDiff): Promise<DiffFileModel> {
    try {
        return parse(file);
    } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
}

const EMPTY_IDS: ReadonlySet<string> = new Set();
const BACKGROUND_PARSE_DELAY = 300;
const readNothing = (): null => null;
const noSubscribe = (): (() => void) => () => undefined;
