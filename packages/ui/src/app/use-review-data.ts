import type { PrDiff, UiReviewProgressResponse, UiRouteState, UiSnapshotSummary } from '@sherpa/protocol';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
    fetchReviewDiff,
    fetchReviewLenses,
    fetchReviewProgress,
    fetchReviewRoute,
    fetchReviewSnapshots,
    fetchReviewThreads,
    mirrorViewedFiles,
} from '../api.js';
import type { DiffViewStore } from '../diff-view/store.js';
import type { PaletteNavigation } from '../palette/diff-source.tsx';
import type { ProgressWriter } from '../progress/progress-writer.js';
import type { StopProgressStore } from '../progress/stop-progress-store.js';
import { viewedMirrorUpdate } from '../progress/viewed-mirror.js';
import type { ActiveFacts, ReviewState, SnapshotsState } from './review-state.js';
import {
    emptyActiveFacts,
    emptyReviewState,
    emptySnapshots,
    errorMessage,
    reviewStateForKeys,
    sharedReviewState,
} from './review-state.js';

/** Tab state populated by review endpoints, and parsing of the route response without parameters. */
export interface ReviewStateSlots {
    readonly snapshotsState: SnapshotsState;
    readonly setSnapshotsState: Dispatch<SetStateAction<SnapshotsState>>;
    /** Active iteration facts matched to the current `reviewKey`. */
    readonly facts: ActiveFacts;
    readonly setActiveFacts: Dispatch<SetStateAction<ActiveFacts>>;
    readonly applyActiveRoute: (route: UiRouteState | null) => void;
    readonly reviewState: ReviewState;
    readonly setReviewState: Dispatch<SetStateAction<ReviewState>>;
}

/**
 * State slots are read before the tab key is known. They resolve the selected iteration,
 * then the endpoints (`useReviewData`) populate them with the resolved `viewKey`.
 */
export function useReviewState(reviewKey: string, reviewHost: string | null): ReviewStateSlots {
    const [snapshotsState, setSnapshotsState] = useState<SnapshotsState>(() => emptySnapshots(reviewKey));
    const [activeFacts, setActiveFacts] = useState<ActiveFacts>(() => emptyActiveFacts(reviewKey));
    const facts = activeFacts.key === reviewKey ? activeFacts : emptyActiveFacts(reviewKey);
    /** The route without parameters provides the active iteration's `diffId` and commit, and the current snapshot. */
    const applyActiveRoute = useCallback(
        (route: UiRouteState | null) => {
            setActiveFacts((current) => {
                const base = current.key === reviewKey ? current : emptyActiveFacts(reviewKey);
                if (route === null) {
                    return base.routeSettled ? base : { ...base, routeSettled: true };
                }
                const next: ActiveFacts = {
                    key: reviewKey,
                    diffId: route.stale?.prDiffId ?? route.snapshot?.diffId ?? base.diffId,
                    commit: route.stale?.prCommit ?? route.snapshot?.commit ?? base.commit,
                    snapshot: route.snapshot,
                    routeSettled: true,
                };
                return base.routeSettled &&
                    base.diffId === next.diffId &&
                    base.commit === next.commit &&
                    base.snapshot?.snapshotId === next.snapshot?.snapshotId
                    ? base
                    : next;
            });
        },
        [reviewKey],
    );
    const [reviewState, setReviewState] = useState<ReviewState>(() =>
        emptyReviewState(reviewKey, reviewKey, reviewHost !== null),
    );
    return {
        snapshotsState,
        setSnapshotsState,
        facts,
        setActiveFacts,
        applyActiveRoute,
        reviewState,
        setReviewState,
    };
}

export interface ReviewDataOptions {
    readonly token: string;
    readonly reviewKey: string;
    readonly viewKey: string;
    readonly reviewReady: boolean;
    readonly reviewHost: string | null;
    readonly routeRevision: number | null;
    readonly progressRevision: number | null;
    readonly threadsRevision: number | null;
    readonly viewDiffId: string | null;
    readonly viewSnapshotId: string | null;
    readonly viewPending: boolean;
    readonly sliceBase: string | null;
    readonly sliceHead: string | null;
    readonly activeIterationKey: string | null;
    readonly readOnly: boolean;
    readonly currentDiff: PrDiff | null;
    readonly progress: UiReviewProgressResponse | null;
    readonly viewedMirrorAvailable: boolean;
    readonly diffStore: DiffViewStore | null;
    readonly progressWriter: ProgressWriter | null;
    readonly stopProgress: StopProgressStore;
    readonly mirroredFileWrites: RefObject<Set<string>>;
    readonly progressWritesSettled: number;
    readonly setSnapshotsState: Dispatch<SetStateAction<SnapshotsState>>;
    readonly setActiveFacts: Dispatch<SetStateAction<ActiveFacts>>;
    readonly setReviewState: Dispatch<SetStateAction<ReviewState>>;
    readonly applyActiveRoute: (route: UiRouteState | null) => void;
    /** An incoming diff clears references to files in the previous diff. */
    readonly setActiveFileId: (fileId: string | null) => void;
    readonly setPaletteNavigation: (navigation: PaletteNavigation | null) => void;
}

export interface ReviewDataResult {
    /** Refresh the route outside the SSE revision cycle after an endpoint reports "snapshot is stale". */
    readonly refreshRoute: () => void;
}

/**
 * Review endpoints: snapshots, diff, lenses, progress, viewed file mirror, threads and route.
 * Effect order is part of the contract. Tests check the request list and order against it.
 */
export function useReviewData({
    token,
    reviewKey,
    viewKey,
    reviewReady,
    reviewHost,
    routeRevision,
    progressRevision,
    threadsRevision,
    viewDiffId,
    viewSnapshotId,
    viewPending,
    sliceBase,
    sliceHead,
    activeIterationKey,
    readOnly,
    currentDiff,
    progress,
    viewedMirrorAvailable,
    diffStore,
    progressWriter,
    stopProgress,
    mirroredFileWrites,
    progressWritesSettled,
    setSnapshotsState,
    setActiveFacts,
    setReviewState,
    applyActiveRoute,
    setActiveFileId,
    setPaletteNavigation,
}: ReviewDataOptions): ReviewDataResult {
    const progressLoaded = progress !== null;
    const viewedMirrorBaseline = useRef<{
        readonly reviewKey: string;
        readonly diffId: string;
        readonly state: ReadonlyMap<string, boolean>;
    } | null>(null);

    /**
     * Snapshot list for the picker. Refresh it on the same route revision as the route itself.
     * An endpoint failure is not a UI error. The server may not support it yet, so the list falls
     * back to the current snapshot alone.
     */
    const seenSnapshots = useRef<{ key: string; revision: number | null; loaded: boolean }>({
        key: reviewKey,
        revision: null,
        loaded: false,
    });
    useEffect(() => {
        if (!reviewReady || reviewHost === null) {
            return;
        }
        if (seenSnapshots.current.key !== reviewKey) {
            seenSnapshots.current = { key: reviewKey, revision: null, loaded: false };
        }
        const revision = routeRevision;
        if (seenSnapshots.current.loaded && seenSnapshots.current.revision === revision) {
            return;
        }

        let alive = true;
        const settle = (list: readonly UiSnapshotSummary[] | null): void => {
            if (!alive) {
                return;
            }
            seenSnapshots.current = { key: reviewKey, revision, loaded: true };
            setSnapshotsState({ key: reviewKey, list, loaded: true });
        };
        void fetchReviewSnapshots(token).then(settle, () => {
            settle(null);
        });
        return () => {
            alive = false;
        };
    }, [reviewHost, reviewKey, reviewReady, routeRevision, setSnapshotsState, token]);

    // Publish the diff as soon as it is ready. Lens and thread requests do not block the reader.
    useEffect(() => {
        if (!reviewReady || reviewHost === null || viewPending) {
            return;
        }
        let alive = true;
        const selection =
            sliceBase === null || sliceHead === null ? { diffId: viewDiffId } : { base: sliceBase, head: sliceHead };
        void fetchReviewDiff(token, selection).then(
            (diff) => {
                if (!alive) {
                    return;
                }
                setActiveFileId(null);
                setPaletteNavigation(null);
                // The diff without parameters is the active iteration. Read-only mode needs its id.
                if (viewDiffId === null) {
                    setActiveFacts((current) => {
                        if (current.key === reviewKey && current.diffId === diff.diffId) {
                            return current;
                        }
                        const base = current.key === reviewKey ? current : emptyActiveFacts(reviewKey);
                        return { ...base, diffId: diff.diffId };
                    });
                }
                setReviewState((current) => ({
                    ...reviewStateForKeys(current, reviewKey, viewKey),
                    diff,
                    diffError: null,
                    diffLoading: false,
                }));
            },
            (error: unknown) => {
                if (alive) {
                    setReviewState((current) => ({
                        ...reviewStateForKeys(current, reviewKey, viewKey),
                        diff: null,
                        diffError: errorMessage(error),
                        diffLoading: false,
                    }));
                }
            },
        );
        return () => {
            alive = false;
        };
    }, [
        activeIterationKey,
        reviewHost,
        reviewKey,
        reviewReady,
        setActiveFacts,
        setActiveFileId,
        setPaletteNavigation,
        setReviewState,
        sliceBase,
        sliceHead,
        token,
        viewDiffId,
        viewKey,
        viewPending,
    ]);

    // Overview and Full diff filters need lenses, but load them independently of the raw diff.
    // A slice has no lenses. Ownership and audit lenses use iteration files, while a slice has its own `fileId` values.
    // Until the selection from the URL resolves, lenses wait alongside the diff. Otherwise a slice
    // opened by URL would fetch them needlessly.
    useEffect(() => {
        if (!reviewReady || reviewHost === null || sliceBase !== null || viewPending) {
            return;
        }
        let alive = true;
        void fetchReviewLenses(token).then(
            (lenses) => {
                if (alive) {
                    setReviewState((current) => ({
                        ...sharedReviewState(current, reviewKey, viewKey),
                        lenses,
                        lensesError: null,
                        lensesLoading: false,
                    }));
                }
            },
            (error: unknown) => {
                if (alive) {
                    setReviewState((current) => ({
                        ...sharedReviewState(current, reviewKey, viewKey),
                        lenses: null,
                        lensesError: errorMessage(error),
                        lensesLoading: false,
                    }));
                }
            },
        );
        return () => {
            alive = false;
        };
        // Include `viewKey` in dependencies for a fresh closure. A response that lags behind a selection change
        // must not overwrite the key of an already loaded diff.
    }, [activeIterationKey, reviewHost, reviewKey, reviewReady, setReviewState, sliceBase, token, viewKey, viewPending]);

    // There is one `ProgressWriter` per tab (`use-progress-writer.ts`). Server snapshots pass through its merge,
    // and its own write event does not trigger an extra refresh unless there is a revision gap.
    const [progressRetry, setProgressRetry] = useState<{ key: string; attempt: number }>({
        key: reviewKey,
        attempt: 0,
    });
    const progressRetryAttempt = progressRetry.key === reviewKey ? progressRetry.attempt : 0;
    useEffect(() => {
        if (
            !reviewReady ||
            reviewHost === null ||
            diffStore === null ||
            currentDiff === null ||
            progressWriter === null ||
            viewPending ||
            // Progress uses iteration `fileId` values. A slice has its own values, with no marks for them.
            sliceBase !== null
        ) {
            return;
        }
        // Request progress for the iteration on screen. Until the route is rebuilt,
        // the tab shows the snapshot iteration's diff, whose `fileId` values do not match the active iteration's marks.
        const drawnDiffId = viewDiffId ?? currentDiff.diffId;
        // Progress belongs to a different iteration than the one on screen. Refresh it regardless of revision:
        // switching iterations does not create a gap in our revision, but the displayed marks no longer apply.
        const otherIteration = progress?.diffId !== drawnDiffId;
        if (!otherIteration && !progressWriter.shouldReload(progressRevision)) {
            return;
        }

        let alive = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        const mark = progressWriter.beginReload();
        void fetchReviewProgress(token, drawnDiffId).then(
            (response) => {
                if (!alive) {
                    return;
                }
                if (response.diffId !== drawnDiffId) {
                    // A response for another iteration raced with a selection change. Applying it would
                    // clear marks on the diff still on screen. Leave the refresh to the next progress
                    // event. The writer is already requesting it.
                    setReviewState((current) => ({
                        ...reviewStateForKeys(current, reviewKey, viewKey),
                        progressLoading: false,
                    }));
                    return;
                }
                const merged = progressWriter.finishReload(response, mark);
                diffStore.setProgress(merged.files);
                // setProgress synchronously notifies the mirror. Clear the flag after writing the cleared ranges.
                mirroredFileWrites.current.clear();
                stopProgress.setAll(merged.stops);
                setReviewState((current) => ({
                    ...reviewStateForKeys(current, reviewKey, viewKey),
                    progress: { ...response, files: [...merged.files], stops: [...merged.stops] },
                    progressError: null,
                    progressLoading: false,
                }));
                if (progressRetryAttempt !== 0) {
                    setProgressRetry({ key: reviewKey, attempt: 0 });
                }
            },
            (error: unknown) => {
                if (!alive) {
                    return;
                }
                setReviewState((current) => {
                    const next = reviewStateForKeys(current, reviewKey, viewKey);
                    return {
                        ...next,
                        // A background failure does not replace progress already on screen with a full-screen error.
                        progressError: next.progress === null ? errorMessage(error) : null,
                        progressLoading: false,
                    };
                });
                retry = setTimeout(() => {
                    setProgressRetry({ key: reviewKey, attempt: progressRetryAttempt + 1 });
                }, Math.min(1000 * 2 ** progressRetryAttempt, 15_000));
            },
        );
        return () => {
            alive = false;
            if (retry !== null) {
                clearTimeout(retry);
            }
        };
    }, [
        progress,
        currentDiff,
        diffStore,
        progressRetryAttempt,
        progressWriter,
        progressWritesSettled,
        reviewHost,
        reviewKey,
        reviewReady,
        setReviewState,
        sliceBase,
        progressRevision,
        mirroredFileWrites,
        stopProgress,
        token,
        viewDiffId,
        viewKey,
        viewPending,
    ]);

    // One app-level subscriber mirrors only coverage-driven read transitions. The first complete snapshot
    // of diff and progress is the baseline. Opening a tab does not replay history to the host.
    useEffect(() => {
        if (readOnly || !viewedMirrorAvailable || currentDiff === null || diffStore === null || !progressLoaded) {
            return;
        }
        const sync = (): void => {
            const previous = viewedMirrorBaseline.current;
            const diffSnapshot = diffStore.getSnapshot();
            const update = viewedMirrorUpdate(
                previous?.reviewKey === reviewKey && previous.diffId === currentDiff.diffId ? previous.state : null,
                {
                    readStates: diffSnapshot.readState,
                    progress: diffSnapshot.progress,
                    fileWrites: mirroredFileWrites.current,
                },
            );
            viewedMirrorBaseline.current = { reviewKey, diffId: currentDiff.diffId, state: update.state };
            if (update.entries.length > 0) {
                void mirrorViewedFiles(token, update.entries).catch(() => undefined);
            }
        };

        const unsubscribe = diffStore.subscribe(sync);
        sync();
        return unsubscribe;
    }, [
        currentDiff,
        diffStore,
        mirroredFileWrites,
        progressLoaded,
        readOnly,
        reviewKey,
        token,
        viewedMirrorAvailable,
    ]);

    // Read threads only here. Mark the revision as seen only after success.
    const seenThreads = useRef<{ key: string; revision: number | null; loaded: boolean }>({
        key: reviewKey,
        revision: null,
        loaded: false,
    });
    const [threadRetry, setThreadRetry] = useState<{ key: string; attempt: number }>({ key: reviewKey, attempt: 0 });
    const threadRetryAttempt = threadRetry.key === reviewKey ? threadRetry.attempt : 0;
    useEffect(() => {
        if (!reviewReady || reviewHost === null) {
            return;
        }
        if (seenThreads.current.key !== reviewKey) {
            seenThreads.current = { key: reviewKey, revision: null, loaded: false };
        }
        const revision = threadsRevision;
        if (seenThreads.current.loaded && seenThreads.current.revision === revision) {
            return;
        }

        let alive = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        setReviewState((current) => {
            const next = sharedReviewState(current, reviewKey, viewKey);
            return {
                ...next,
                threadsError: null,
                threadsLoading: next.threads === null,
            };
        });
        void fetchReviewThreads(token).then(
            (threads) => {
                if (!alive) {
                    return;
                }
                seenThreads.current = { key: reviewKey, revision, loaded: true };
                setReviewState((current) => ({
                    ...sharedReviewState(current, reviewKey, viewKey),
                    threads,
                    threadsError: null,
                    threadsLoading: false,
                }));
                if (threadRetryAttempt !== 0) {
                    setThreadRetry({ key: reviewKey, attempt: 0 });
                }
            },
            (error: unknown) => {
                if (!alive) {
                    return;
                }
                setReviewState((current) => ({
                    ...sharedReviewState(current, reviewKey, viewKey),
                    threadsError: errorMessage(error),
                    threadsLoading: false,
                }));
                retry = setTimeout(() => {
                    setThreadRetry({ key: reviewKey, attempt: threadRetryAttempt + 1 });
                }, Math.min(1000 * 2 ** threadRetryAttempt, 15_000));
            },
        );
        return () => {
            alive = false;
            if (retry !== null) {
                clearTimeout(retry);
            }
        };
        // `viewKey` keeps the closure fresh, see the lens effect. Threads themselves do not depend on the selection.
    }, [reviewHost, reviewKey, reviewReady, setReviewState, threadsRevision, threadRetryAttempt, token, viewKey]);

    // Read the route in the same loop as threads. The event carries only the revision. Fetch data
    // from the endpoint and mark the revision as seen only after success.
    const seenRoute = useRef<{ key: string; revision: number | null; loaded: boolean }>({
        key: viewKey,
        revision: null,
        loaded: false,
    });
    /** Revision whose active iteration facts have already been collected, shared by both route effects. */
    const seenActiveRoute = useRef<{ key: string; revision: number | null }>({ key: reviewKey, revision: null });
    const [routeRetry, setRouteRetry] = useState<{ key: string; attempt: number }>({ key: reviewKey, attempt: 0 });
    const routeRetryAttempt = routeRetry.key === reviewKey ? routeRetry.attempt : 0;
    const refreshRoute = useCallback(() => {
        seenRoute.current.loaded = false;
        setRouteRetry((current) => ({
            key: reviewKey,
            attempt: current.key === reviewKey ? current.attempt + 1 : 1,
        }));
    }, [reviewKey]);
    useEffect(() => {
        if (!reviewReady || reviewHost === null || viewPending) {
            return;
        }
        if (seenRoute.current.key !== viewKey) {
            seenRoute.current = { key: viewKey, revision: null, loaded: false };
        }
        const revision = routeRevision;
        if (seenRoute.current.loaded && seenRoute.current.revision === revision) {
            return;
        }

        let alive = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        void fetchReviewRoute(token, viewSnapshotId).then(
            (response) => {
                if (!alive) {
                    return;
                }
                seenRoute.current = { key: viewKey, revision, loaded: true };
                // The route without parameters describes the active iteration. It supplies both the facts
                // used to compare the selection and the fallback snapshot list.
                if (viewSnapshotId === null) {
                    seenActiveRoute.current = { key: reviewKey, revision };
                    applyActiveRoute(response.route);
                }
                setReviewState((current) => ({
                    ...reviewStateForKeys(current, reviewKey, viewKey),
                    route: response.route,
                    routeError: null,
                    routeLoading: false,
                }));
                if (routeRetryAttempt !== 0) {
                    setRouteRetry({ key: reviewKey, attempt: 0 });
                }
            },
            (error: unknown) => {
                if (!alive) {
                    return;
                }
                if (viewSnapshotId === null) {
                    applyActiveRoute(null);
                }
                setReviewState((current) => {
                    const next = reviewStateForKeys(current, reviewKey, viewKey);
                    return {
                        ...next,
                        // A background failure does not clear the route already on screen.
                        routeError: next.route === null ? errorMessage(error) : null,
                        routeLoading: false,
                    };
                });
                retry = setTimeout(
                    () => {
                        setRouteRetry({ key: reviewKey, attempt: routeRetryAttempt + 1 });
                    },
                    Math.min(1000 * 2 ** routeRetryAttempt, 15_000),
                );
            },
        );
        return () => {
            alive = false;
            if (retry !== null) {
                clearTimeout(retry);
            }
        };
    }, [
        applyActiveRoute,
        reviewHost,
        reviewKey,
        reviewReady,
        routeRetryAttempt,
        routeRevision,
        setReviewState,
        token,
        viewKey,
        viewPending,
        viewSnapshotId,
    ]);

    /**
     * While the tab shows a past snapshot (or has yet to resolve its selection), nothing reads the route
     * without parameters. Without it, the active iteration is unknown. Read-only mode,
     * selection labels and URL parsing would have no facts to use and would reset the selection.
     */
    useEffect(() => {
        if (!reviewReady || reviewHost === null) {
            return;
        }
        if (!viewPending && viewSnapshotId === null) {
            return;
        }
        const revision = routeRevision;
        if (seenActiveRoute.current.key === reviewKey && seenActiveRoute.current.revision === revision) {
            return;
        }

        let alive = true;
        const settle = (route: UiRouteState | null): void => {
            if (!alive) {
                return;
            }
            seenActiveRoute.current = { key: reviewKey, revision };
            applyActiveRoute(route);
        };
        void fetchReviewRoute(token, null).then(
            (response) => {
                settle(response.route);
            },
            () => {
                settle(null);
            },
        );
        return () => {
            alive = false;
        };
    }, [applyActiveRoute, reviewHost, reviewKey, reviewReady, routeRevision, token, viewPending, viewSnapshotId]);

    return { refreshRoute };
}
