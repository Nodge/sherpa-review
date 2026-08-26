import type {
    PrDiff,
    PrMeta,
    Thread,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
    UiRouteState,
    Verdict,
} from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import './app.css';
import {
    fetchReviewDiff,
    fetchReviewLenses,
    fetchReviewPr,
    fetchReviewProgress,
    fetchReviewRoute,
    fetchReviewThreads,
    deleteReviewDraft,
    publishReview,
    saveReviewDraft,
    setFileViewed,
    setStopViewed,
    updateReviewDraft,
} from './api.js';
import { agentPillView } from './components/agent-pill-view.js';
import { auditScopeBannerVisible, AuditScopeBanner } from './components/audit-banner.tsx';
import type { BannerSource } from './components/banner-slot.tsx';
import { BannerSlot } from './components/banner-slot.tsx';
import { DisconnectedBanner } from './components/disconnected-banner.tsx';
import { reconnectCommand } from './components/reconnect-command.js';
import type { ReviewCompletion } from './components/review-action-bar.tsx';
import { ReviewActionBar } from './components/review-action-bar.tsx';
import { ReviewComplete } from './components/review-complete.tsx';
import { TopBar } from './components/top-bar.tsx';
import { createDiffViewStore } from './diff-view/store.js';
import {
    ALL_FILTER_ID,
    buildFileFilters,
    filterFiles,
    filterStats,
    findFilter,
    PCI_FILTER_ID,
} from './filters/lens-filters.js';
import { updateFragment } from './fragment.js';
import { CommandPalette } from './palette/command-palette.tsx';
import type { PaletteDiffSource, PaletteNavigation, PaletteNavigationTarget } from './palette/diff-source.tsx';
import { breadcrumbFromPrKey } from './pr-key.js';
import { createProgressWriter } from './progress/progress-writer.js';
import type { ProgressWriter } from './progress/progress-writer.js';
import { createStopProgressStore } from './progress/stop-progress-store.js';
import type { SessionStore } from './session/session-store.js';
import type { ViewId } from './session/views.js';
import type { Store } from './store.js';
import type { ComposerTransport } from './threads/composer.js';
import { persistentThreadStore } from './threads/persistent-store.js';
import type { ThreadStore } from './threads/store.js';
import { UI_VERSION } from './version.js';
import { FullDiffView } from './views/full-diff.tsx';
import { RegenerateBanner } from './views/route/other-card.tsx';
import { RouteCommands } from './views/route/route-commands.tsx';
import type { RouteSummary } from './views/route/route-view.tsx';
import { RouteView } from './views/route/route-view.tsx';
import { ViewFrame } from './views/view-frames.tsx';

/** The main page reads server and session stores through `useSyncExternalStore`. */
export interface AppProps {
    readonly store: Store;
    readonly session: SessionStore;
    readonly token: string;
}

/**
 * What the application knows about the route beyond its snapshot. `uncoveredLines: null` means the route view
 * has not been opened in this session, so nothing has calculated uncovered lines yet.
 */
interface RouteFacts {
    readonly stopIds: readonly string[];
    readonly otherStopId: string | null;
    readonly uncoveredLines: number | null;
}

interface ReviewState {
    readonly key: string;
    readonly pr: PrMeta | null;
    readonly diff: PrDiff | null;
    readonly lenses: UiReviewLensesResponse | null;
    readonly progress: UiReviewProgressResponse | null;
    readonly threads: readonly Thread[] | null;
    readonly route: UiRouteState | null;
    readonly prError: string | null;
    readonly diffError: string | null;
    readonly lensesError: string | null;
    readonly progressError: string | null;
    readonly threadsError: string | null;
    readonly routeError: string | null;
    readonly prLoading: boolean;
    readonly diffLoading: boolean;
    readonly lensesLoading: boolean;
    readonly progressLoading: boolean;
    readonly threadsLoading: boolean;
    readonly routeLoading: boolean;
}

export function App({ store, session, token }: AppProps) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const { view, filter: filterId, paletteOpen } = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const viewSelection = useSyncExternalStore(
        session.subscribeViewSelection,
        session.getViewSelectionSnapshot,
        session.getViewSelectionSnapshot,
    );
    const state = snapshot.state;
    const reviewReady = state !== null;
    const reviewHost = state?.reviewHost ?? null;
    const reviewKey = `${token}\u0000${reviewHost ?? 'none'}`;
    const [reviewState, setReviewState] = useState<ReviewState>(() => emptyReviewState(reviewKey, reviewHost !== null));
    const currentReview = reviewState.key === reviewKey ? reviewState : emptyReviewState(reviewKey, reviewHost !== null);
    const currentDiff = currentReview.diff;
    const diffStore = useMemo(
        () => (currentDiff === null ? null : createDiffViewStore({ files: currentDiff.files })),
        [currentDiff],
    );
    const [progressWritesSettled, setProgressWritesSettled] = useState(0);
    // Stop marks live alongside file marks. They share a progress revision and one writer.
    // A different PR or host means a different route. Previous marks do not apply.
    const [stopProgressState, setStopProgressState] = useState(() => ({
        key: reviewKey,
        store: createStopProgressStore(),
    }));
    if (stopProgressState.key !== reviewKey) {
        setStopProgressState({ key: reviewKey, store: createStopProgressStore() });
    }
    const stopProgress = stopProgressState.store;
    const progressWriter = useMemo<ProgressWriter | null>(
        () =>
            diffStore === null
                ? null
                : createProgressWriter({
                      initialRevision: 0,
                      read: (fileId) => diffStore.getSnapshot().progress.get(fileId) ?? null,
                      apply: diffStore.markViewed,
                      restore: diffStore.restoreProgress,
                      send: async (fileId, viewed) => (await setFileViewed(token, fileId, viewed)).progressRevision,
                      stops: {
                          read: (stopId) => stopProgress.getSnapshot().get(stopId) ?? null,
                          apply: stopProgress.setViewed,
                          restore: stopProgress.restore,
                          send: async (stopId, viewed, ranges) =>
                              (await setStopViewed(token, stopId, viewed, ranges)).progressRevision,
                      },
                      onSettled: () => {
                          setProgressWritesSettled((settled) => settled + 1);
                      },
                  }),
        [diffStore, stopProgress, token],
    );
    const [activeFileId, setActiveFileId] = useState<string | null>(null);
    const [paletteNavigation, setPaletteNavigation] = useState<PaletteNavigation | null>(null);
    const navigationId = useRef(0);
    /** Jump to a stop from the palette. The route view completes scrolling using the increasing `id`. */
    const [routeNavigation, setRouteNavigation] = useState<{ id: number; stopId: string } | null>(null);
    const routeNavigationId = useRef(0);
    /** The route explains less than half the diff. The notification slot shows the banner (SPEC §4.3). */
    const [routeUnderExplained, setRouteUnderExplained] = useState(false);
    /**
     * Route counts from the view: only it knows them (uncovered lines are counted from parsed models).
     * The view keeps them when unmounting because the action bar and review summary also appear in the full diff.
     */
    const [routeSummaryState, setRouteSummaryState] = useState<{ key: string; value: RouteSummary } | null>(null);
    // Every session.setView call, including reselecting the current tab, clears Review complete.
    const [completionState, setCompletionState] = useState<{
        key: string;
        viewSelection: number;
        value: ReviewCompletion;
    } | null>(null);
    const completion =
        completionState?.key === reviewKey && completionState.viewSelection === viewSelection
            ? completionState.value
            : null;

    // The header and final actions need PR metadata. It loads independently of the other data.
    useEffect(() => {
        if (!reviewReady || reviewHost === null) {
            return;
        }
        let alive = true;
        void fetchReviewPr(token).then(
            (pr) => {
                if (alive) {
                    setReviewState((current) => ({
                        ...reviewStateForKey(current, reviewKey),
                        pr,
                        prError: null,
                        prLoading: false,
                    }));
                }
            },
            (error: unknown) => {
                if (alive) {
                    setReviewState((current) => ({
                        ...reviewStateForKey(current, reviewKey),
                        pr: null,
                        prError: errorMessage(error),
                        prLoading: false,
                    }));
                }
            },
        );
        return () => {
            alive = false;
        };
    }, [reviewHost, reviewKey, reviewReady, token]);

    // Publish the diff as soon as it is ready. Lens and thread requests do not block the reader.
    useEffect(() => {
        if (!reviewReady || reviewHost === null) {
            return;
        }
        let alive = true;
        void fetchReviewDiff(token).then(
            (diff) => {
                if (!alive) {
                    return;
                }
                setActiveFileId(null);
                setPaletteNavigation(null);
                setReviewState((current) => ({
                    ...reviewStateForKey(current, reviewKey),
                    diff,
                    diffError: null,
                    diffLoading: false,
                }));
            },
            (error: unknown) => {
                if (alive) {
                    setReviewState((current) => ({
                        ...reviewStateForKey(current, reviewKey),
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
    }, [reviewHost, reviewKey, reviewReady, token]);

    // Overview and Full diff filters need lenses, but load them independently of the raw diff.
    useEffect(() => {
        if (!reviewReady || reviewHost === null) {
            return;
        }
        let alive = true;
        void fetchReviewLenses(token).then(
            (lenses) => {
                if (alive) {
                    setReviewState((current) => ({
                        ...reviewStateForKey(current, reviewKey),
                        lenses,
                        lensesError: null,
                        lensesLoading: false,
                    }));
                }
            },
            (error: unknown) => {
                if (alive) {
                    setReviewState((current) => ({
                        ...reviewStateForKey(current, reviewKey),
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
    }, [reviewHost, reviewKey, reviewReady, token]);

    // App owns one ProgressWriter. Server snapshots go through its merge,
    // and its own write event does not trigger an extra refresh unless there is a revision gap.
    const [progressRetry, setProgressRetry] = useState<{ key: string; attempt: number }>({
        key: reviewKey,
        attempt: 0,
    });
    const progressRetryAttempt = progressRetry.key === reviewKey ? progressRetry.attempt : 0;
    useEffect(() => {
        if (!reviewReady || reviewHost === null || diffStore === null || progressWriter === null) {
            return;
        }
        const initial = currentReview.progress === null;
        const revision = snapshot.progressRevision;
        if (!initial && (revision === null || !progressWriter.shouldReload(revision))) {
            return;
        }

        let alive = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        const mark = progressWriter.beginReload();
        void fetchReviewProgress(token).then(
            (response) => {
                if (!alive) {
                    return;
                }
                const merged = progressWriter.finishReload(response, mark);
                if (merged !== null) {
                    diffStore.setProgress(merged.files);
                    stopProgress.setAll(merged.stops);
                }
                setReviewState((current) => ({
                    ...reviewStateForKey(current, reviewKey),
                    ...(merged === null
                        ? {}
                        : { progress: { ...response, files: [...merged.files], stops: [...merged.stops] } }),
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
                    const next = reviewStateForKey(current, reviewKey);
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
        currentReview.progress,
        diffStore,
        progressRetryAttempt,
        progressWriter,
        progressWritesSettled,
        reviewHost,
        reviewKey,
        reviewReady,
        snapshot.progressRevision,
        stopProgress,
        token,
    ]);

    // App is the sole owner of thread reads. A revision is marked seen only after a successful read.
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
        const revision = snapshot.threadsRevision;
        if (seenThreads.current.loaded && seenThreads.current.revision === revision) {
            return;
        }

        let alive = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        setReviewState((current) => {
            const next = reviewStateForKey(current, reviewKey);
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
                    ...reviewStateForKey(current, reviewKey),
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
                    ...reviewStateForKey(current, reviewKey),
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
    }, [reviewHost, reviewKey, reviewReady, snapshot.threadsRevision, threadRetryAttempt, token]);

    // Read the route in the same loop as threads. The event carries only the revision. Fetch data
    // from the endpoint and mark the revision as seen only after success.
    const seenRoute = useRef<{ key: string; revision: number | null; loaded: boolean }>({
        key: reviewKey,
        revision: null,
        loaded: false,
    });
    const [routeRetry, setRouteRetry] = useState<{ key: string; attempt: number }>({ key: reviewKey, attempt: 0 });
    const routeRetryAttempt = routeRetry.key === reviewKey ? routeRetry.attempt : 0;
    useEffect(() => {
        if (!reviewReady || reviewHost === null) {
            return;
        }
        if (seenRoute.current.key !== reviewKey) {
            seenRoute.current = { key: reviewKey, revision: null, loaded: false };
        }
        const revision = snapshot.routeRevision;
        if (seenRoute.current.loaded && seenRoute.current.revision === revision) {
            return;
        }

        let alive = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        void fetchReviewRoute(token).then(
            (response) => {
                if (!alive) {
                    return;
                }
                seenRoute.current = { key: reviewKey, revision, loaded: true };
                setReviewState((current) => ({
                    ...reviewStateForKey(current, reviewKey),
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
                setReviewState((current) => {
                    const next = reviewStateForKey(current, reviewKey);
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
    }, [reviewHost, reviewKey, reviewReady, routeRetryAttempt, snapshot.routeRevision, token]);

    const threadFileIds = useMemo(
        () => new Set(currentDiff?.files.map((file) => file.fileId) ?? []),
        [currentDiff],
    );
    const serverThreads = currentReview.threads ?? EMPTY_THREADS;
    const threadStore = useMemo<ThreadStore | null>(
        () =>
            currentDiff === null || state === null
                ? null
                : persistentThreadStore(state.prKey, currentDiff.diffId, serverThreads, threadFileIds),
        [currentDiff, serverThreads, state, threadFileIds],
    );
    useEffect(() => {
        if (threadStore !== null && currentReview.threads !== null) {
            threadStore.setServerThreads(currentReview.threads);
        }
    }, [currentReview.threads, threadStore]);
    const composerTransport = useMemo<ComposerTransport>(
        () => ({
            save: (draft) => saveReviewDraft(token, draft),
            update: (commentId, body) => updateReviewDraft(token, commentId, body),
            delete: (commentId) => deleteReviewDraft(token, commentId),
        }),
        [token],
    );

    const diffFilterHandler = useRef<((id: string) => void) | null>(null);
    const setDiffFilterHandler = useCallback((handler: ((id: string) => void) | null) => {
        diffFilterHandler.current = handler;
    }, []);
    const showAllAuditFiles = useCallback(() => {
        const handler = diffFilterHandler.current;
        if (handler === null) {
            // While Full diff is loading, there is nothing to preserve. Neither the list nor its top card is on screen.
            session.setFilter(ALL_FILTER_ID);
            return;
        }
        handler(ALL_FILTER_ID);
    }, [session]);

    const navigateFromPalette = useCallback(
        (target: PaletteNavigationTarget) => {
            navigationId.current += 1;
            setPaletteNavigation({ id: navigationId.current, target });
            session.setView('diff');
        },
        [session],
    );
    const paletteSource = useMemo<PaletteDiffSource | null>(() => {
        if (currentDiff === null || diffStore === null) {
            return null;
        }
        return {
            files: currentDiff.files,
            activeFileId,
            goToFile: (fileId) => {
                navigateFromPalette({ kind: 'file', fileId });
            },
            goToLine: (fileId, side, line) => {
                navigateFromPalette({ kind: 'line', fileId, side, line });
            },
            toggleDiffMode: () => {
                const current = diffStore.getSnapshot().diffMode;
                diffStore.setDiffMode(current === 'unified' ? 'split' : 'unified');
            },
        };
    }, [activeFileId, currentDiff, diffStore, navigateFromPalette]);

    const filters = useMemo(
        () =>
            currentDiff === null || currentReview.lenses === null
                ? []
                : buildFileFilters({
                      files: currentDiff.files,
                      ownership: currentReview.lenses.ownership,
                      extra: currentReview.lenses.extra,
                  }),
        [currentDiff, currentReview.lenses],
    );
    const pci = findFilter(filters, PCI_FILTER_ID);
    const pciStats = currentDiff === null || pci === null ? null : filterStats(currentDiff.files, pci);
    const pciPaths =
        currentDiff === null || pci === null ? [] : filterFiles(currentDiff.files, pci).map((file) => file.path);
    const auditKey = `${reviewKey}\u0000${filterId}`;
    const [dismissedAuditKey, setDismissedAuditKey] = useState<string | null>(null);
    useEffect(() => {
        const timer = window.setTimeout(() => {
            setDismissedAuditKey(null);
        }, 0);
        return () => {
            window.clearTimeout(timer);
        };
    }, [filterId, reviewKey]);
    const auditVisible = auditScopeBannerVisible(
        view,
        filterId,
        dismissedAuditKey === auditKey,
        pciStats?.files ?? 0,
    );
    const bannerSources: readonly BannerSource[] = [
        {
            id: 'agent-disconnected',
            priority: 300,
            active: () => state?.worker.kind === 'disconnected',
            render: () => <DisconnectedBanner prKey={state?.prKey ?? ''} />,
        },
        {
            id: 'route-under-explained',
            priority: 200,
            active: () => view === 'route' && routeUnderExplained,
            render: () => <RegenerateBanner />,
        },
        {
            id: 'audit-scope',
            priority: 100,
            active: () => auditVisible && pci !== null && pciStats !== null,
            render: () =>
                pci === null || pciStats === null ? null : (
                    <AuditScopeBanner
                        filter={pci}
                        stats={pciStats}
                        paths={pciPaths}
                        onShowAll={showAllAuditFiles}
                        onDismiss={() => {
                            setDismissedAuditKey(auditKey);
                        }}
                    />
                ),
        },
    ];
    // The view gets the route only in the `ready` phase. Other phases are generation
    // states from M2-T10. Until then, Route stays the M1 invitation.
    const routeSnapshot =
        currentReview.route?.phase === 'ready' ? currentReview.route.snapshot : null;
    const stopViewed = useSyncExternalStore(
        stopProgress.subscribe,
        stopProgress.getSnapshot,
        stopProgress.getSnapshot,
    );
    /**
     * Until the route view mounts, slots come from the snapshot. "Other" enters the set
     * only with its own mark: only a rendered stop can be marked, and with no uncovered
     * lines it is not rendered. Otherwise the guardrail would keep asking to view a nonexistent
     * stop. The mounted view refines the set because only it knows whether uncovered lines remain.
     */
    const routeSummary = useMemo<RouteFacts | null>(() => {
        if (routeSnapshot === null) {
            return null;
        }
        const reported = routeSummaryState?.key === reviewKey ? routeSummaryState.value : null;
        if (reported !== null) {
            return reported;
        }
        const otherStopId = routeSnapshot.stops.find((stop) => stop.tier === 'other')?.id ?? null;
        return {
            stopIds: routeSnapshot.stops
                .filter((stop) => stop.tier !== 'other' || stopViewed.get(stop.id) === true)
                .map((stop) => stop.id),
            otherStopId,
            uncoveredLines: null,
        };
    }, [reviewKey, routeSnapshot, routeSummaryState, stopViewed]);
    const reportRouteSummary = useCallback(
        (value: RouteSummary) => {
            setRouteSummaryState({ key: reviewKey, value });
        },
        [reviewKey],
    );
    const jumpToStop = useCallback(
        (stopId: string) => {
            routeNavigationId.current += 1;
            setRouteNavigation({ id: routeNavigationId.current, stopId });
            session.setView('route');
        },
        [session],
    );

    const selectView = useCallback(
        (next: ViewId) => {
            session.setView(next);
        },
        [session],
    );
    const completeReview = useCallback(
        (value: ReviewCompletion) => {
            setCompletionState({ key: reviewKey, viewSelection: session.getViewSelectionSnapshot(), value });
            void fetchReviewPr(token).then(
                (pr) => {
                    setReviewState((current) => ({
                        ...reviewStateForKey(current, reviewKey),
                        pr,
                        prError: null,
                        prLoading: false,
                    }));
                },
                () => {
                    // The publish endpoint has already confirmed the result. The header status reloads with the page.
                },
            );
        },
        [reviewKey, session, token],
    );
    const openCompletedThread = useCallback(
        (threadId: string) => {
            window.location.hash = updateFragment(window.location.hash, { thread: threadId, file: null });
            session.setView('diff');
        },
        [session],
    );

    if (snapshot.connection === 'fatal') {
        return (
            <MessageScreen title="Sherpa stopped">
                <p>{snapshot.error}</p>
            </MessageScreen>
        );
    }

    if (state === null) {
        return (
            <MessageScreen title="Sherpa">
                <p>
                    {snapshot.connection === 'connecting'
                        ? 'Connecting to the server…'
                        : 'Server unavailable, reconnecting…'}
                </p>
            </MessageScreen>
        );
    }

    return (
        <>
            <TopBar
                version={UI_VERSION}
                breadcrumb={breadcrumbFromPrKey(state.prKey)}
                agent={agentPillView(state.worker, state.tasks)}
                reconnectCommand={reconnectCommand(state.prKey)}
                view={view}
                onSelectView={selectView}
                onOpenSearch={() => {
                    session.setPaletteOpen(true);
                }}
            />

            {snapshot.connection === 'reconnecting' ? (
                <div className="connection-banner">
                    <div className="connection-banner__title">Server unavailable, reconnecting…</div>
                    <p>This is the last known state. It will update automatically when the connection returns.</p>
                </div>
            ) : null}

            <BannerSlot sources={bannerSources} />

            {completion !== null ? (
                <ReviewComplete
                    completion={completion}
                    onOpenThread={openCompletedThread}
                    onOpenFullDiff={() => {
                        session.setView('diff');
                    }}
                />
            ) : view === 'diff' ? (
                <FullDiffView
                    token={token}
                    prKey={state.prKey}
                    session={session}
                    pr={currentReview.pr}
                    prError={currentReview.prError}
                    diff={currentDiff}
                    diffError={currentReview.diffError}
                    lenses={currentReview.lenses}
                    lensesError={currentReview.lensesError}
                    progress={currentReview.progress}
                    progressError={currentReview.progressError}
                    progressWriter={progressWriter}
                    store={diffStore}
                    threadStore={threadStore}
                    paletteNavigation={paletteNavigation}
                    onFilterChangeHandler={setDiffFilterHandler}
                    onPaletteActiveFileChange={(fileId) => {
                        if (fileId !== null) {
                            setActiveFileId(fileId);
                        }
                    }}
                />
            ) : view === 'route' && routeSnapshot !== null ? (
                <RouteView
                    token={token}
                    session={session}
                    pr={currentReview.pr}
                    prError={currentReview.prError}
                    diff={currentDiff}
                    diffError={currentReview.diffError}
                    lenses={currentReview.lenses}
                    lensesError={currentReview.lensesError}
                    progress={currentReview.progress}
                    progressError={currentReview.progressError}
                    progressWriter={progressWriter}
                    stopProgress={stopProgress}
                    store={diffStore}
                    threadStore={threadStore}
                    snapshot={routeSnapshot}
                    navigation={routeNavigation}
                    onUnderExplained={setRouteUnderExplained}
                    onRouteSummary={reportRouteSummary}
                />
            ) : (
                <ViewFrame
                    view={view}
                    token={token}
                    prKey={state.prKey}
                    session={session}
                    diff={currentDiff}
                    lenses={currentReview.lenses}
                    threads={currentReview.threads}
                    reviewHostAvailable={reviewHost !== null}
                    diffLoading={currentReview.diffLoading}
                    lensesLoading={currentReview.lensesLoading}
                    threadsLoading={currentReview.threadsLoading}
                    diffError={currentReview.diffError}
                    lensesError={currentReview.lensesError}
                    threadsError={currentReview.threadsError}
                    {...(threadStore === null ? {} : { threadStore })}
                />
            )}

            {routeSnapshot === null ? null : <RouteCommands snapshot={routeSnapshot} onJump={jumpToStop} />}

            <CommandPalette
                open={paletteOpen}
                prKey={state.prKey}
                source={paletteSource}
                sourceError={currentReview.diffError}
                onOpen={() => {
                    session.setPaletteOpen(true);
                }}
                onClose={() => {
                    session.setPaletteOpen(false);
                }}
            />

            {completion === null &&
            (view === 'route' || view === 'diff') &&
            reviewHost !== null &&
            currentReview.pr !== null &&
            currentReview.progress !== null &&
            currentReview.threads !== null &&
            currentDiff !== null &&
            diffStore !== null &&
            threadStore !== null ? (
                <ReviewActionBar
                    pr={currentReview.pr}
                    diff={currentDiff}
                    diffStore={diffStore}
                    threadStore={threadStore}
                    connection={snapshot.connection}
                    hostName={hostDisplayName(reviewHost)}
                    route={routeSummary === null ? null : { ...routeSummary, viewed: stopViewed }}
                    composerTransport={composerTransport}
                    onPublish={(verdict: Verdict) => publishReview(token, verdict)}
                    onComplete={completeReview}
                />
            ) : null}
        </>
    );
}

export function MessageScreen({ title, children }: { title: string; children: ReactNode }) {
    return (
        <main className="message-screen">
            <h1 className="message-screen__title">{title}</h1>
            {children}
        </main>
    );
}

function emptyReviewState(key: string, loading: boolean): ReviewState {
    return {
        key,
        pr: null,
        diff: null,
        lenses: null,
        progress: null,
        threads: null,
        route: null,
        prError: null,
        diffError: null,
        lensesError: null,
        progressError: null,
        threadsError: null,
        routeError: null,
        prLoading: loading,
        diffLoading: loading,
        lensesLoading: loading,
        progressLoading: loading,
        threadsLoading: loading,
        routeLoading: loading,
    };
}

function reviewStateForKey(current: ReviewState, key: string): ReviewState {
    return current.key === key ? current : emptyReviewState(key, true);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function hostDisplayName(host: string): string {
    if (host === 'github') {
        return 'GitHub';
    }
    return host === 'fixture' ? 'FixtureHost' : host;
}

const EMPTY_THREADS: readonly Thread[] = [];
