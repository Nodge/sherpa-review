import type { PrDiff } from '@sherpa/protocol';
import { useEffect, useMemo } from 'react';

import { fetchBlob } from '../api.js';
import type { BlobLoader } from '../diff-view/blob-loader.tsx';
import type { DiffViewStore } from '../diff-view/store.js';
import { createDiffViewStore } from '../diff-view/store.js';
import { collapsedFromMap, collapsedToMap } from '../pr-state/pr-state-store.js';
import { usePrStateStore } from '../pr-state/context.tsx';
import { useUiSettingsStore } from '../settings/context.tsx';

export interface DiffStoreOptions {
    readonly diff: PrDiff | null;
    readonly prKey: string | null;
    readonly blobsAvailable: boolean;
    readonly token: string;
}

export interface DiffStoreResult {
    readonly diffStore: DiffViewStore | null;
    readonly loadBlob: BlobLoader | null;
}

/**
 * Diff store for the open tab. A new diff creates a new store, with two-way synchronization
 * of settings (diff mode) and PR state (collapsed cards).
 */
export function useDiffStore({ diff, prKey, blobsAvailable, token }: DiffStoreOptions): DiffStoreResult {
    const settings = useUiSettingsStore();
    const prState = usePrStateStore();
    const loadBlob = useMemo(
        () => (blobsAvailable ? (blobId: string) => fetchBlob(token, blobId) : null),
        [blobsAvailable, token],
    );
    const diffStore = useMemo(
        () =>
            diff === null || prKey === null
                ? null
                : createDiffViewStore({
                      files: diff.files,
                      // Take the snapshot once when creating the store. A late endpoint response
                      // must not recreate the store while the reviewer is reading.
                      collapsed: collapsedToMap(prState.getSnapshot().diffCollapsed),
                      // Diff mode is global. It comes from the server and is written back there.
                      diffMode: settings.getSnapshot().diffMode,
                      onDiffModeChange: (mode) => {
                          settings.update({ diffMode: mode });
                      },
                  }),
        [diff, prKey, prState, settings],
    );
    // Apply settings that arrived after store creation or changed in another view.
    useEffect(() => {
        if (diffStore === null) {
            return;
        }
        const sync = (): void => {
            diffStore.setDiffMode(settings.getSnapshot().diffMode);
        };
        sync();
        return settings.subscribe(sync);
    }, [diffStore, settings]);
    // Card collapse state may arrive after store creation (boot-GET missed the timeout).
    // Apply it the same way as diff mode, without recreating the store. Otherwise the store
    // would keep an empty map, and the first manual collapse would erase the server's map:
    // the patch replaces the whole field.
    useEffect(() => {
        if (diffStore === null) {
            return;
        }
        const sync = (): void => {
            diffStore.setCollapsePreferences(collapsedToMap(prState.getSnapshot().diffCollapsed));
        };
        sync();
        return prState.subscribe(sync);
    }, [diffStore, prState]);
    // Write only when preferences actually change. Other store updates (mode, progress,
    // file models) do not affect collapse state and need no request.
    useEffect(() => {
        if (diffStore === null) {
            return;
        }
        let collapsePreferences = diffStore.getSnapshot().collapsePreferences;
        return diffStore.subscribe(() => {
            const next = diffStore.getSnapshot().collapsePreferences;
            if (next === collapsePreferences) {
                return;
            }
            collapsePreferences = next;
            prState.update({ diffCollapsed: collapsedFromMap(collapsePreferences) });
        });
    }, [diffStore, prState]);

    return { diffStore, loadBlob };
}
