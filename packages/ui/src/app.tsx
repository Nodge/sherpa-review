import type {
    PrDiff,
    Thread,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
    UiRoutePhase,
    UiRouteState,
    UiTask,
    Verdict,
} from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import './app.css';
import {
    cancelTask,
    fetchReviewDiff,
    fetchReviewLenses,
    fetchReviewProgress,
    fetchReviewRoute,
    fetchReviewThreads,
    deleteReviewDraft,
    generateReviewRoute,
    publishReview,
    saveReviewDraft,
    sendFeedback,
    setFileViewed,
    setStopViewed,
    updateReviewDraft,
} from './api.js';
import { agentPillView } from './components/agent-pill-view.js';
import { auditScopeBannerVisible, AuditScopeBanner } from './components/audit-banner.tsx';
import type { BannerSource } from './components/banner-slot.tsx';
import { BANNER_PRIORITY, BannerSlot } from './components/banner-slot.tsx';
import { reconnectCommand } from './components/reconnect-command.js';
import type { ReviewCompletion } from './components/review-action-bar.tsx';
import {
    reviewActionBarVisible,
    ReviewActionBar,
    ReviewActionBarLoading,
} from './components/review-action-bar.tsx';
import { ReviewComplete } from './components/review-complete.tsx';
import { TopBar } from './components/top-bar.tsx';
import { globalCollapsedStorage, readCollapsed as readFileCollapsed } from './diff-view/collapsed-storage.js';
import { expandFileContext } from './diff-view/expand.js';
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
import { breadcrumbFor, documentTitleFor } from './pr-key.js';
import { createProgressWriter } from './progress/progress-writer.js';
import type { ProgressWriter } from './progress/progress-writer.js';
import { createStopProgressStore } from './progress/stop-progress-store.js';
import {
    generationIsLong,
    openRouteTasks,
    routeActionErrorInPlace,
    routeViewKind,
} from './route/generation.js';
import type { SessionStore } from './session/session-store.js';
import type { ViewId } from './session/views.js';
import type { Store } from './store.js';
import type { ComposerTransport } from './threads/composer.js';
import { persistentThreadStore } from './threads/persistent-store.js';
import type { ThreadStore } from './threads/store.js';
import { UI_VERSION } from './version.js';
import { FullDiffView } from './views/full-diff.tsx';
import {
    GenerationFailedBanner,
    RouteActionErrorBanner,
    RouteFillingBanner,
} from './views/route/generation-card.tsx';
import { RegenerateBanner } from './views/route/other-card.tsx';
import { RouteCommands, RouteGenerateCommand, RoutePresetCommand } from './views/route/route-commands.tsx';
import { RouteFailedView, RouteReadingView } from './views/route/route-generating.tsx';
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

/** A generation or cancellation endpoint failed. The phase is the one when the reviewer clicked. */
interface RouteActionFailure {
    readonly phase: UiRoutePhase | null;
    readonly message: string;
}

interface ReviewState {
    readonly key: string;
    readonly diff: PrDiff | null;
    readonly lenses: UiReviewLensesResponse | null;
    readonly progress: UiReviewProgressResponse | null;
    readonly threads: readonly Thread[] | null;
    readonly route: UiRouteState | null;
    readonly diffError: string | null;
    readonly lensesError: string | null;
    readonly progressError: string | null;
    readonly threadsError: string | null;
    readonly routeError: string | null;
    readonly diffLoading: boolean;
    readonly lensesLoading: boolean;
    readonly progressLoading: boolean;
    readonly threadsLoading: boolean;
    readonly routeLoading: boolean;
}

export function App({ store, session, token }: AppProps) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const { view, filter: filterId, preset, paletteOpen } = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const viewSelection = useSyncExternalStore(
        session.subscribeViewSelection,
        session.getViewSelectionSnapshot,
        session.getViewSelectionSnapshot,
    );
    const state = snapshot.state;
    const reviewReady = state !== null;
    // The browser tab identifies the PR (#37). Before metadata arrives, it uses the number from the key, so it is never empty.
    const documentTitle = state === null ? null : documentTitleFor(state.prKey, state.pr);
    const reviewHost = state?.reviewHost ?? null;
    const reviewKey = `${token}\u0000${reviewHost ?? 'none'}`;
    const [reviewState, setReviewState] = useState<ReviewState>(() => emptyReviewState(reviewKey, reviewHost !== null));
    const currentReview = reviewState.key === reviewKey ? reviewState : emptyReviewState(reviewKey, reviewHost !== null);
    const currentDiff = currentReview.diff;
    const prKey = state?.prKey ?? null;
    const diffStore = useMemo(
        () =>
            currentDiff === null || prKey === null
                ? null
                : createDiffViewStore({
                      files: currentDiff.files,
                      collapsed: readFileCollapsed(globalCollapsedStorage(), prKey),
                  }),
        [currentDiff, prKey],
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

    useEffect(() => {
        if (documentTitle !== null) {
            document.title = documentTitle;
        }
    }, [documentTitle]);

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
        if (!initial && !progressWriter.shouldReload(snapshot.progressRevision)) {
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
                diffStore.setProgress(merged.files);
                stopProgress.setAll(merged.stops);
                setReviewState((current) => ({
                    ...reviewStateForKey(current, reviewKey),
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
            searchModels: () => {
                const snapshot = diffStore.getSnapshot();
                return new Map(
                    [...snapshot.models].map(([fileId, model]) => [
                        fileId,
                        expandFileContext(
                            model,
                            snapshot.content.get(fileId) ?? null,
                            snapshot.expansion.get(fileId) ?? new Map(),
                        ),
                    ]),
                );
            },
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

    // --- Route generation: endpoints, long-running task, default view for a small PR (M2-T10) ---

    const route = currentReview.route;
    const routePhase = route?.phase ?? null;
    const routeKind = routeViewKind(route);
    const routeTasks = useMemo(() => openRouteTasks(state?.tasks ?? EMPTY_TASKS), [state?.tasks]);
    const [generating, setGenerating] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    /**
     * Store the reason with the phase that produced it. When the server reports something new,
     * the old endpoint complaint is stale and disappears without a separate reset.
     */
    const [routeActionFailure, setRouteActionFailure] = useState<RouteActionFailure | null>(null);
    const routeActionError = routeActionFailure?.phase === routePhase ? routeActionFailure.message : null;
    /** Phase where generation was requested. The button keeps loading until the phase changes. */
    const generationFrom = useRef<string | null>(null);
    /**
     * Mirror `generating` for the repeated-start guard. React state updates by the next
     * render, but two consecutive calls (palette, button) can happen in the same render.
     */
    const generationInFlight = useRef(false);
    const stopGenerating = useCallback(() => {
        generationInFlight.current = false;
        setGenerating(false);
    }, []);
    useEffect(() => {
        if (generating && generationFrom.current !== routePhase) {
            stopGenerating();
        }
    }, [generating, routePhase, stopGenerating]);
    const startGeneration = useCallback(() => {
        // The server would reject a second request with `already_running`, and its response would clear
        // the loading indicator for the generation already in progress.
        if (generationInFlight.current) {
            return;
        }
        generationInFlight.current = true;
        generationFrom.current = routePhase;
        setGenerating(true);
        setRouteActionFailure(null);
        void generateReviewRoute(token).then(
            (outcome) => {
                // Generation has started. The SSE phase change releases the button, not the endpoint response.
                if (outcome !== 'started') {
                    stopGenerating();
                }
                if (outcome === 'small_pr') {
                    setRouteActionFailure({
                        phase: routePhase,
                        message: 'The PR is below the route threshold, generation will not start.',
                    });
                }
            },
            (error: unknown) => {
                stopGenerating();
                setRouteActionFailure({ phase: routePhase, message: errorMessage(error) });
            },
        );
    }, [routePhase, stopGenerating, token]);
    const cancelGeneration = useCallback(() => {
        const ids = routeTasks.map((task) => task.id);
        if (ids.length === 0) {
            return;
        }
        setCancelling(true);
        setRouteActionFailure(null);
        void Promise.all(ids.map((id) => cancelTask(token, id))).then(
            () => {
                setCancelling(false);
            },
            (error: unknown) => {
                setCancelling(false);
                setRouteActionFailure({ phase: routePhase, message: errorMessage(error) });
            },
        );
    }, [routePhase, routeTasks, token]);

    // The clock ticks only while the agent has work to do. "Still working" depends on elapsed time.
    const [now, setNow] = useState(() => Date.now());
    const hasRouteTasks = routeTasks.length > 0;
    useEffect(() => {
        if (!hasRouteTasks) {
            return;
        }
        const timer = setInterval(() => {
            setNow(Date.now());
        }, LONG_GENERATION_TICK);
        return () => {
            clearInterval(timer);
        };
    }, [hasRouteTasks]);
    const longRunning = generationIsLong(routeTasks, now);

    /**
     * A small PR opens in the full diff (SPEC §4.1). Respect the reviewer's choice,
     * whether from the URL or by hand, so decide once and only for the default.
     */
    const smallPrRedirected = useRef(false);
    useEffect(() => {
        if (smallPrRedirected.current || routePhase !== 'none' || route?.smallPr !== true) {
            return;
        }
        smallPrRedirected.current = true;
        if (!session.viewPinned()) {
            session.setView('diff');
        }
    }, [route?.smallPr, routePhase, session]);

    const actionErrorInPlace = routeActionErrorInPlace(view, route);

    const bannerSources: readonly BannerSource[] = [
        {
            id: 'generation-failed',
            priority: BANNER_PRIORITY.generationFailed,
            // Do not duplicate this on the route tab: the red card there shows the same reason.
            active: () => routePhase === 'failed' && view !== 'route',
            render: () =>
                route?.failure == null ? null : (
                    <GenerationFailedBanner
                        message={route.failure.message}
                        retrying={generating}
                        onRetry={startGeneration}
                    />
                ),
        },
        {
            id: 'route-action-error',
            priority: BANNER_PRIORITY.routeActionError,
            active: () => routeActionError !== null && !actionErrorInPlace,
            render: () =>
                routeActionError === null ? null : <RouteActionErrorBanner message={routeActionError} />,
        },
        {
            id: 'route-under-explained',
            priority: BANNER_PRIORITY.routeUnderExplained,
            active: () => view === 'route' && routeUnderExplained,
            render: () => <RegenerateBanner />,
        },
        {
            id: 'route-filling',
            priority: BANNER_PRIORITY.routeFilling,
            active: () => view === 'route' && routePhase === 'filling' && route?.snapshot != null,
            render: () =>
                route?.snapshot == null ? null : (
                    <RouteFillingBanner
                        snapshot={route.snapshot}
                        onReadDiff={() => {
                            session.setView('diff');
                        }}
                    />
                ),
        },
        {
            id: 'audit-scope',
            priority: BANNER_PRIORITY.auditScope,
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
    /**
     * The snapshot behind review counts: only a ready route. A partial one lives in the route
     * view (README §8), but cannot supply counts for the action panel or review outcome because half
     * its slots are still unfilled.
     */
    const routeSnapshot = routePhase === 'ready' ? (route?.snapshot ?? null) : null;
    /** What the "Route" tab renders: a ready or partially filled route. */
    const routeViewSnapshot = routePhase === 'ready' || routePhase === 'filling' ? (route?.snapshot ?? null) : null;
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
            // Counts are intermediate while the route is being filled. The guardrail and review result
            // pick them up at `ready` (the phase dependency restarts the report).
            if (routePhase === 'ready') {
                setRouteSummaryState({ key: reviewKey, value });
            }
        },
        [reviewKey, routePhase],
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
            // After publishing, the server reloads the PR status itself and sends it in a snapshot.
            setCompletionState({ key: reviewKey, viewSelection: session.getViewSelectionSnapshot(), value });
        },
        [reviewKey, session],
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

    const reviewActionBarDataReady =
        currentReview.progress !== null &&
        currentReview.threads !== null &&
        currentDiff !== null &&
        diffStore !== null &&
        threadStore !== null;
    const showReviewActionBar = reviewActionBarVisible({
        view,
        completed: completion !== null,
        reviewHost,
        pr: state.pr,
        dataReady: reviewActionBarDataReady,
    });

    return (
        <>
            <TopBar
                version={UI_VERSION}
                breadcrumb={breadcrumbFor(state.prKey, state.pr)}
                agent={agentPillView(state.worker, state.tasks)}
                reconnectCommand={reconnectCommand(state.prKey)}
                view={view}
                onSelectView={selectView}
                onOpenSearch={() => {
                    session.setPaletteOpen(true);
                }}
                feedback={state.feedback}
                feedbackContext={{
                    uiVersion: UI_VERSION,
                    prKey: state.prKey,
                    view,
                    routePhase: routePhase ?? 'none',
                    worker: state.worker,
                }}
                onSendFeedback={(request) => sendFeedback(token, request)}
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
                    pr={state.pr}
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
                    routeSnapshot={routeSnapshot}
                    onJumpToStop={jumpToStop}
                    smallPr={route?.smallPr === true}
                />
            ) : view === 'route' && routeKind === 'workspace' && routeViewSnapshot !== null ? (
                <RouteView
                    token={token}
                    session={session}
                    pr={state.pr}
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
                    snapshot={routeViewSnapshot}
                    agentStopped={routePhase === 'filling' && state.worker.kind === 'disconnected'}
                    navigation={routeNavigation}
                    onUnderExplained={setRouteUnderExplained}
                    onRouteSummary={reportRouteSummary}
                />
            ) : view === 'route' && routeKind === 'reading' ? (
                <RouteReadingView
                    onOpenDiff={() => {
                        session.setView('diff');
                    }}
                />
            ) : view === 'route' && routeKind === 'failed' && route?.failure != null ? (
                <RouteFailedView
                    failure={route.failure}
                    retrying={generating}
                    actionError={routeActionError}
                    onRetry={startGeneration}
                    onOpenDiff={() => {
                        session.setView('diff');
                    }}
                />
            ) : (
                <ViewFrame
                    view={view}
                    token={token}
                    prKey={state.prKey}
                    session={session}
                    pr={state.pr}
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
                    generation={{
                        route,
                        longRunning,
                        cancelling,
                        retrying: generating,
                        actionError: routeActionError,
                        onRetry: startGeneration,
                        onCancel: cancelGeneration,
                    }}
                />
            )}

            {routeViewSnapshot === null ? null : (
                <>
                    <RouteCommands snapshot={routeViewSnapshot} onJump={jumpToStop} />
                    <RoutePresetCommand
                        preset={preset}
                        setPreset={session.setPreset}
                        setView={session.setView}
                    />
                </>
            )}
            <RouteGenerateCommand
                phase={routePhase}
                smallPr={route?.smallPr === true}
                generating={generating}
                onGenerate={startGeneration}
            />

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

            {showReviewActionBar ? (
                reviewActionBarDataReady && reviewHost !== null && state.pr !== null ? (
                    <ReviewActionBar
                        pr={state.pr}
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
                ) : (
                    <ReviewActionBarLoading diffError={currentReview.diffError} />
                )
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
        diff: null,
        lenses: null,
        progress: null,
        threads: null,
        route: null,
        diffError: null,
        lensesError: null,
        progressError: null,
        threadsError: null,
        routeError: null,
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
const EMPTY_TASKS: readonly UiTask[] = [];
/** How often to recalculate "Still working". The threshold is coarse, so second-level precision is unnecessary. */
const LONG_GENERATION_TICK = 5000;
