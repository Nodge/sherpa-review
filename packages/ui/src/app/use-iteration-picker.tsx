import type { Iteration, UiSnapshotSummary } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useMemo } from 'react';

import { SnapshotPill } from '../iterations/snapshot-picker.tsx';
import type { PickerRows, ResolvedViewing } from '../iterations/viewing.js';
import { pickerRows, VIEWING_CURRENT } from '../iterations/viewing.js';
import type { SessionStore } from '../session/session-store.js';

export interface IterationPickerOptions {
    readonly session: SessionStore;
    readonly snapshots: readonly UiSnapshotSummary[];
    readonly iterations: readonly Iteration[];
    /** Active PR iteration from route facts returned without parameters. */
    readonly factsDiffId: string | null;
    readonly factsCommit: string | null;
    /** The host provides slices between iterations. Otherwise hide this picker section (M4-T4). */
    readonly interdiffAvailable: boolean;
    readonly resolved: ResolvedViewing;
    readonly now: number;
}

export interface IterationPickerResult {
    readonly pickerMenuRows: PickerRows;
    readonly selectViewing: SessionStore['setViewing'];
    readonly openIterationWithoutRoute: (diffId: string) => void;
    readonly sliceCommits: { readonly baseCommit: string; readonly headCommit: string } | null;
    readonly backToActiveIteration: () => void;
    readonly snapshotPill: ReactNode;
}

/** Iteration selection: picker rows, header pill and transitions between iteration, slice and current. */
export function useIterationPicker({
    session,
    snapshots,
    iterations,
    factsDiffId,
    factsCommit,
    interdiffAvailable,
    resolved,
    now,
}: IterationPickerOptions): IterationPickerResult {
    /** Iteration selection: the pill menu and Overview card use the same rows. */
    const pickerMenuRows = useMemo(
        () =>
            pickerRows({
                snapshots,
                iterations,
                activeIteration:
                    factsDiffId === null || factsCommit === null
                        ? null
                        : { diffId: factsDiffId, commit: factsCommit },
                interdiff: interdiffAvailable,
            }),
        [factsCommit, factsDiffId, interdiffAvailable, iterations, snapshots],
    );
    const selectViewing = session.setViewing;
    /** Navigation from the stale banner: an active iteration without a route is not read-only. */
    const openIterationWithoutRoute = useCallback(
        (diffId: string) => {
            session.setViewing({ kind: 'diff', diffId });
            session.setView('diff');
        },
        [session],
    );
    /** Slice commits for Full diff screens: both the empty slice and the error name both sides. */
    const sliceCommits = useMemo(
        () =>
            resolved.label?.kind === 'slice'
                ? { baseCommit: resolved.label.baseCommit, headCommit: resolved.label.commit }
                : null,
        [resolved.label],
    );
    /** Leave the slice: return the tab to the active iteration and its route. */
    const backToActiveIteration = useCallback(() => {
        session.setViewing(VIEWING_CURRENT);
    }, [session]);
    const snapshotPill =
        resolved.label === null ? null : (
            <SnapshotPill
                label={resolved.label}
                menu={{ rows: pickerMenuRows, viewing: resolved.viewing, now, onSelect: selectViewing }}
            />
        );

    return {
        pickerMenuRows,
        selectViewing,
        openIterationWithoutRoute,
        sliceCommits,
        backToActiveIteration,
        snapshotPill,
    };
}
