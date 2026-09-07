import type { DraftBufferEntry } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import './app.css';
import { fetchDraftBuffer, sendFeedback } from './api.js';
import { buildBannerSources } from './app/banners.tsx';
import {
    EMPTY_ITERATIONS,
    EMPTY_THREADS,
    hostDisplayName,
    reviewStateForKeys,
    sliceReviewState,
} from './app/review-state.js';
import { useAuditFilter } from './app/use-audit-filter.js';
import { useChat } from './app/use-chat.js';
import { useDiffStore } from './app/use-diff-store.js';
import { useIterationPicker } from './app/use-iteration-picker.tsx';
import { useProgressWriter } from './app/use-progress-writer.js';
import { useReviewData, useReviewState } from './app/use-review-data.js';
import { useRouteGeneration } from './app/use-route-generation.js';
import { useShipVerdict } from './app/use-ship-verdict.js';
import { agentPillView } from './components/agent-pill-view.js';
import { auditScopeBannerVisible } from './components/audit-banner.tsx';
import { BannerSlot } from './components/banner-slot.tsx';
import { ChatPanel } from './components/chat-panel.tsx';
import { useChatDock } from './components/dock.js';
import { usePrCommentsGate } from './components/pr-comments-gate.js';
import { routeLocaleBannerVisible } from './components/route-locale-banner.tsx';
import { reconnectCommand } from './components/reconnect-command.js';
import type { ReviewCompletion } from './components/review-action-bar.tsx';
import {
    reviewActionBarVisible,
    ReviewActionBar,
    ReviewActionBarLoading,
} from './components/review-action-bar.tsx';
import { useUpdateCheckCommand, useUpdateToast } from './components/update-state.js';
import { UpdateToast } from './components/update-toast.tsx';
import { ReviewComplete } from './components/review-complete.tsx';
import { ShortcutCheatsheet } from './components/shortcut-cheatsheet.tsx';
import { TopBar } from './components/top-bar.tsx';
import { BlobLoaderProvider } from './diff-view/blob-loader.tsx';
import { expandFileContext } from './diff-view/expand.js';
import { findAgentNote, flashAgentNote, revealWhenReady } from './diff-view/line-target.js';
import {
    buildFileFilters,
    filterFiles,
    filterStats,
    findFilter,
    PCI_FILTER_ID,
} from './filters/lens-filters.js';
import { updateFragment } from './fragment.js';
import { useLocale, useT } from './i18n/index.js';
import { useLocaleCommands } from './i18n/locale-commands.js';
import { ReadOnlyIterationProvider, SLICE_READ_ONLY_REASON } from './iterations/read-only.tsx';
import { ThreadPinProvider } from './iterations/thread-pin.tsx';
import type { ThreadPinContextValue } from './iterations/thread-pin.tsx';
import {
    activeIterationDiffId,
    fallbackSnapshots,
    resolveViewing,
    VIEWING_CURRENT,
} from './iterations/viewing.js';
import {
    TourHost,
    tourAnchorEpoch,
    TourScaffold,
    useTourActive,
    useTourReplayCommand,
} from './onboarding/index.js';
import { CommandPalette } from './palette/command-palette.tsx';
import type { PaletteDiffSource, PaletteNavigation, PaletteNavigationTarget } from './palette/diff-source.tsx';
import { breadcrumbFor, documentTitleFor } from './pr-key.js';
import type { ReportedRouteSummary, RouteSummary } from './route/route-summary.js';
import { routeFactsForSnapshot } from './route/route-summary.js';
import type { SessionStore } from './session/session-store.js';
import type { ViewId } from './session/views.js';
import { useShortcut, useShortcutRegistry } from './shortcuts/context.tsx';
import type { ShortcutScope } from './shortcuts/registry.js';
import type { Store } from './store.js';
import { attachComposerBeforeUnload } from './threads/before-unload.js';
import { syncBufferedComposers } from './threads/draft-buffer.js';
import { createComposerTransport } from './threads/transport.js';
import { persistentThreadStore } from './threads/persistent-store.js';
import type { ThreadStore } from './threads/store.js';
import { UI_VERSION } from './version.js';
import { FullDiffView } from './views/full-diff.tsx';
import { secondPassBannerVisible } from './views/route/iteration-banners.tsx';
import { RouteCommands, RouteGenerateCommand, RoutePresetCommand } from './views/route/route-commands.tsx';
import { RouteFailedView, RouteReadingView } from './views/route/route-generating.tsx';
import { RouteView } from './views/route/route-view.tsx';
import { IterationWithoutRoute, SliceWithoutOverview, ViewFrame } from './views/view-frames.tsx';

/** Shortcut registry scope for the open view (SPEC §5). */
const SCOPE_OF_VIEW: Readonly<Record<ViewId, ShortcutScope>> = {
    overview: 'overview',
    route: 'route',
    diff: 'full-diff',
};

/** The main page reads server and session stores through `useSyncExternalStore`. */
export interface AppProps {
    readonly store: Store;
    readonly session: SessionStore;
    readonly token: string;
}

export function App({ store, session, token }: AppProps) {
    const t = useT();
    /** The tab's effective language also sets the route and chat response language (M5-T4). */
    const uiLocale = useLocale();
    // Language changes use palette commands in the "Sherpa" group. The design has no separate settings popover.
    useLocaleCommands();
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const { view, filter: filterId, preset, routeFilter, viewing, paletteOpen, chatOpen } = useSyncExternalStore(
        session.subscribe,
        session.getSnapshot,
    );
    const viewSelection = useSyncExternalStore(
        session.subscribeViewSelection,
        session.getViewSelectionSnapshot,
        session.getViewSelectionSnapshot,
    );
    // An open chat narrows the content column. CSS uses the class to calculate `--dock-*` and action panel layers.
    useChatDock(chatOpen);
    // The shortcut registry scope is the open view. The same key means different things in different views.
    const shortcutRegistry = useShortcutRegistry();
    useEffect(() => {
        shortcutRegistry?.setActiveScope(SCOPE_OF_VIEW[view]);
    }, [shortcutRegistry, view]);
    const state = snapshot.state;
    const reviewReady = state !== null;
    // "Check for updates" palette command (M5-T9). The toast below waits for the tour to finish.
    const [paletteStatus, setPaletteStatus] = useState<string | null>(null);
    useUpdateCheckCommand({
        token,
        current: state?.update?.current ?? UI_VERSION,
        onStatus: setPaletteStatus,
    });
    // The browser tab identifies the PR (#37). Before metadata arrives, it uses the number from the key, so it is never empty.
    const documentTitle = state === null ? null : documentTitleFor(state.prKey, state.pr);
    const reviewHost = state?.reviewHost ?? null;
    const reviewKey = `${token}\u0000${reviewHost ?? 'none'}`;
    const chatKey = [reviewKey, state?.prKey ?? 'none'].join(':');

    // --- Iteration selection: snapshot list, selection resolution, tab data key (M4-T9) ---

    const {
        snapshotsState,
        setSnapshotsState,
        facts,
        setActiveFacts,
        applyActiveRoute,
        reviewState,
        setReviewState,
    } = useReviewState(reviewKey, reviewHost);
    const snapshotsLoaded = snapshotsState.key === reviewKey && snapshotsState.loaded;
    const snapshots = useMemo(
        () => (snapshotsState.key === reviewKey ? snapshotsState.list : null) ?? fallbackSnapshots(facts.snapshot),
        [facts.snapshot, reviewKey, snapshotsState],
    );
    const iterations = state?.iterations ?? EMPTY_ITERATIONS;
    // Read the route from stored state so selection resolution does not wait for a reload.
    // Endpoint parameters do not depend on the route anyway, only labels do.
    const storedRoute = reviewState.key === reviewKey ? reviewState.route : null;
    const resolved = useMemo(
        () =>
            resolveViewing({
                viewing,
                snapshots,
                iterations,
                route: storedRoute,
                activeDiffId: facts.diffId,
                activeCommit: facts.commit,
                snapshotsLoaded,
                activeLoaded: facts.routeSettled,
            }),
        [facts.commit, facts.diffId, facts.routeSettled, iterations, snapshots, snapshotsLoaded, storedRoute, viewing],
    );
    // The active PR iteration is also the reference point for thread pins (M4-T10).
    const activeDiffId = useMemo(
        () => activeIterationDiffId({ iterations, activeDiffId: facts.diffId }),
        [facts.diffId, iterations],
    );
    const viewDiffId = resolved.diffId;
    /** The iteration used to place notes: the selected one, or the active one by default. */
    const notesDiffId = viewDiffId ?? activeDiffId;
    const viewSnapshotId = resolved.snapshotId;
    const viewPending = resolved.pending;
    const readOnly = resolved.readOnly;
    /** The tab shows a slice between iterations (M4-T12). The diff loads through the `base`/`head` endpoint. */
    const sliceBase = resolved.slice?.base ?? null;
    const sliceHead = resolved.slice?.head ?? null;
    /**
     * Reload key for the diff and lenses without parameters. They have no revision of their own and learn about
     * a push only here. While the route snapshot belongs to a previous iteration, the key keeps that diff
     * (stop anchors address files by their own iteration's `fileId`, task breakdown decision 10) and moves
     * when a new skeleton is accepted. Without a snapshot, it follows the active iteration in state.
     * `activeDiffId` does not work here. Its fallback `facts.diffId` comes from the diff response itself
     * and would trigger two requests on open. The key does not move a selected iteration, snapshot or slice.
     */
    const activeIterationKey = useMemo(() => {
        if (viewDiffId !== null || sliceBase !== null) {
            return null;
        }
        const active = iterations.find((iteration) => iteration.status === 'active')?.diffId ?? null;
        return active === null ? null : (facts.snapshot?.diffId ?? active);
    }, [facts.snapshot, iterations, sliceBase, viewDiffId]);
    const viewKey = `${reviewKey}\u0000${viewDiffId ?? ''}\u0000${viewSnapshotId ?? ''}\u0000${sliceBase ?? ''}`;
    const storedReview = reviewStateForKeys(reviewState, reviewKey, viewKey);
    /**
     * Tab data. A slice has no progress, lenses or threads. Its `fileId` values belong to a separate
     * namespace, and iteration endpoints do not apply to it (M4-T1 decision). Use empty placeholders
     * instead, or Full diff would wait for data that will never arrive.
     */
    const currentReview = useMemo(
        () => (sliceBase === null ? storedReview : sliceReviewState(storedReview)),
        [sliceBase, storedReview],
    );
    // The URL selection is absent from both the list and current state. Show the current state.
    useEffect(() => {
        if (resolved.unknown) {
            session.setViewing(VIEWING_CURRENT);
        }
    }, [resolved.unknown, session]);
    const currentDiff = currentReview.diff;
    const viewedMirrorAvailable = state?.pr?.capabilities.fileViewedSync === true;
    /** The host provides slices between iterations. Otherwise hide this picker section (M4-T4). */
    const interdiffAvailable = state?.pr?.capabilities.iterations === true;
    /** Image bytes (M5-T24): without `capabilities.blobs`, image cards do not render at all. */
    const blobsAvailable = state?.pr?.capabilities.blobs === true;
    const routeSnapshotId = currentReview.route?.snapshot?.snapshotId ?? null;
    const prKey = state?.prKey ?? null;
    const { diffStore, loadBlob } = useDiffStore({ diff: currentDiff, prKey, blobsAvailable, token });
    const { progressWriter, stopProgress, mirroredFileWrites, progressWritesSettled } = useProgressWriter({
        viewKey,
        diffStore,
        routeSnapshotId,
        token,
        readOnly,
    });
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
     * The report survives outside the tab, but only for its own snapshot.
     */
    const [routeSummaryState, setRouteSummaryState] = useState<
        ({ readonly key: string } & ReportedRouteSummary) | null
    >(null);
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

    const { refreshRoute } = useReviewData({
        token,
        reviewKey,
        viewKey,
        reviewReady,
        reviewHost,
        routeRevision: snapshot.routeRevision,
        progressRevision: snapshot.progressRevision,
        threadsRevision: snapshot.threadsRevision,
        viewDiffId,
        viewSnapshotId,
        viewPending,
        sliceBase,
        sliceHead,
        activeIterationKey,
        readOnly,
        currentDiff,
        progress: currentReview.progress,
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
    });

    const threadFileIds = useMemo(
        () => new Set(currentDiff?.files.map((file) => file.fileId) ?? []),
        [currentDiff],
    );
    /**
     * The displayed diff belongs to a previous iteration with its own `fileId` values. Threads arrive once for
     * the active iteration. Placement finds files by `path` and keeps only pinned threads beside lines.
     */
    const threadIterationLayout = useMemo(
        () =>
            currentDiff === null || activeDiffId === null || currentDiff.diffId === activeDiffId
                ? null
                : {
                      diffId: currentDiff.diffId,
                      fileIdByPath: new Map(currentDiff.files.map((file) => [file.path, file.fileId])),
                  },
        [activeDiffId, currentDiff],
    );
    const serverThreads = currentReview.threads ?? EMPTY_THREADS;
    /**
     * Thread store key: a slice shares its `diffId` with the active iteration, so it needs its own key.
     * Otherwise its empty thread list would overwrite the active iteration's threads and open composers.
     */
    const threadStoreKey =
        sliceBase === null ? (currentDiff?.diffId ?? null) : `${sliceBase}..${sliceHead ?? ''}`;
    const threadStore = useMemo<ThreadStore | null>(
        () =>
            currentDiff === null || state === null || threadStoreKey === null
                ? null
                : persistentThreadStore(
                      state.prKey,
                      threadStoreKey,
                      serverThreads,
                      threadFileIds,
                      threadIterationLayout,
                  ),
        [currentDiff, serverThreads, state, threadFileIds, threadIterationLayout, threadStoreKey],
    );
    // A push turns the open iteration from active to previous. Keep the same store (it holds
    // open composers), and change only placement.
    useEffect(() => {
        threadStore?.setIterationLayout(threadIterationLayout);
    }, [threadIterationLayout, threadStore]);
    useEffect(() => {
        if (threadStore !== null && currentReview.threads !== null) {
            threadStore.setServerThreads(currentReview.threads);
        }
    }, [currentReview.threads, threadStore]);
    useEffect(() => (threadStore === null ? undefined : attachComposerBeforeUnload(threadStore)), [threadStore]);
    const composerTransport = useMemo(() => createComposerTransport(token), [token]);

    const { shipVerdict, shipVerdictNow, setShipVerdict, publishHere } = useShipVerdict(
        state?.pr?.verdicts ?? null,
        token,
    );

    /**
     * The draft buffer (M5-T15) is read along with threads, using the same `review` event and token.
     * A read failure gets no separate error display. Keep the last known buffer on screen,
     * and reload it at the next revision.
     */
    const [draftBuffer, setDraftBuffer] = useState<readonly DraftBufferEntry[]>(EMPTY_DRAFT_BUFFER);
    useEffect(() => {
        if (!reviewReady || reviewHost === null) {
            return;
        }
        let alive = true;
        void fetchDraftBuffer(token).then(
            (entries) => {
                if (alive) {
                    setDraftBuffer(entries);
                }
            },
            () => undefined,
        );
        return () => {
            alive = false;
        };
    }, [reviewHost, reviewReady, snapshot.threadsRevision, token]);
    // Buffered entries return to composers at their own anchors. After a tab reload,
    // the text must appear on the same line.
    // Threads are dependencies for restoration, not rendering: a draft edit can only be restored together
    // with its comment, which arrives separately.
    useEffect(() => {
        if (threadStore !== null) {
            syncBufferedComposers(threadStore, draftBuffer);
        }
    }, [currentReview.threads, draftBuffer, threadStore]);

    const { setDiffFilterHandler, showAllAuditFiles } = useAuditFilter(session);

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
                      t,
                  }),
        [currentDiff, currentReview.lenses, t],
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
    // The tour starts as soon as there is a snapshot and diff, without waiting for a route (decision 2026-09-04).
    const tourActive = useTourActive(state !== null && currentDiff !== null);

    const {
        routePhase,
        routeKind,
        generating,
        cancelling,
        routeActionError,
        startGeneration,
        fillStop,
        cancelGeneration,
        now,
        longRunning,
        actionErrorInPlace,
        generateAvailable,
    } = useRouteGeneration({
        route,
        token,
        uiLocale,
        t,
        session,
        view,
        tasks: state?.tasks,
        tourActive,
        refreshRoute,
    });

    /**
     * The snapshot behind the review counts is a completed route with a `contentHash`. The old ready
     * snapshot still qualifies during a rebuild. The new partial snapshot stays out until `ready`.
     */
    const routeSnapshot = route?.snapshot?.contentHash == null ? null : route.snapshot;
    /** The Route tab renders any live snapshot, including the old one during a rebuild. */
    const routeViewSnapshot = routeKind === 'workspace' && !resolved.routeless ? (route?.snapshot ?? null) : null;
    /**
     * Generation cap (SPEC §4.1). The server calculates it from the active snapshot, so it stays
     * silent when reading a previous iteration because the displayed route belongs to another iteration.
     */
    const generationCap = readOnly ? null : (state?.generationCap ?? null);
    /**
     * The second-pass banner is dismissed for this snapshot. It describes a filter, so it is dismissible
     * (SPEC §2.21). Dismissal lives in the tab session and resets when a new snapshot arrives.
     */
    const [dismissedSecondPass, setDismissedSecondPass] = useState<string | null>(null);
    const secondPassVisible = secondPassBannerVisible(
        view,
        routeSnapshot,
        route?.stale ?? null,
        dismissedSecondPass,
        readOnly,
    );
    /** Classified stops in the ready snapshot, counted by the second-pass banner. */
    const routeChangedStops = routeSnapshot?.stops.filter((stop) => stop.change !== null).length ?? 0;
    /** Whether the ready snapshot has classified stops determines the "what is new" filter. */
    const routeHasChanges = routeChangedStops > 0;
    /**
     * The "what is new" filter is invalid on a ready snapshot without classified stops
     * (decision 6) and resets. Otherwise it would stay in the URL and silently activate on the next
     * pass with classifications, even though the reviewer did not enable it then.
     */
    useEffect(() => {
        if (routeFilter === 'new' && routeSnapshot !== null && !routeHasChanges) {
            session.setRouteFilter('all');
        }
    }, [routeFilter, routeHasChanges, routeSnapshot, session]);

    const {
        pickerMenuRows,
        selectViewing,
        openIterationWithoutRoute,
        sliceCommits,
        backToActiveIteration,
        snapshotPill,
    } = useIterationPicker({
        session,
        snapshots,
        iterations,
        factsDiffId: facts.diffId,
        factsCommit: facts.commit,
        interdiffAvailable,
        resolved,
        now,
    });

    const agentConnected = state?.worker.kind === 'connected';
    const {
        chatData,
        currentChat,
        currentChatComposer,
        setChatComposerContext,
        chatFocusRequest,
        chatPrefillRequest,
        chatScrollRequest,
        chatAnchorNavigationRequest,
        noteFocusRequest,
        openNoteInChat,
        lostNoteIds,
        firstLostNote,
        notesInCode,
        isSelectionPending,
        selectChatAnchor,
        openChatForSelection,
        composeRouteQuestion,
        composeDiffQuestion,
        closeChat,
        toggleChat,
        handleChatScrollRequest,
        askChat,
        cancelChat,
        retryChat,
        deleteNote,
        navigateChatAnchor,
        navigateToNote,
        paletteChat,
    } = useChat({
        chatKey,
        token,
        uiLocale,
        session,
        reviewHost,
        reviewReady,
        chatRevision: snapshot.chatRevision,
        view,
        notesDiffId,
        sliceBase,
        currentDiff,
        now,
        agentConnected,
    });

    const [dismissedNotesLost, setDismissedNotesLost] = useState<string | null>(null);
    /**
     * "Keep it" on the route language banner (M5-T4): tab-local memory, keyed by snapshot id.
     * A new snapshot in a different language asks again.
     */
    const [keptRouteLocale, setKeptRouteLocale] = useState<string | null>(null);
    const routeLocaleVisible = routeLocaleBannerVisible({
        route,
        uiLocale,
        generating,
        keptSnapshotId: keptRouteLocale,
        readOnly,
    });
    /** Why "Rebuild" is unavailable. `undefined` means it is available. */
    const routeLocaleRebuildBlocked = generateAvailable
        ? undefined
        : route?.smallPr === true
          ? t('route.smallPr.notGenerated')
          : t('route.locale.rebuild.unavailable');

    const bannerSources = buildBannerSources({
        view,
        session,
        now,
        readOnly,
        resolved,
        route,
        routePhase,
        generating,
        cancelling,
        generateAvailable,
        startGeneration,
        cancelGeneration,
        routeActionError,
        actionErrorInPlace,
        openIterationWithoutRoute,
        routeSnapshot,
        routeChangedStops,
        secondPassVisible,
        onDismissSecondPass: setDismissedSecondPass,
        routeUnderExplained,
        lostNoteIds,
        firstLostNote,
        dismissedNotesLost,
        onDismissNotesLost: setDismissedNotesLost,
        openNoteInChat,
        shipVerdict,
        shipVerdictNow,
        onDismissShipVerdict: () => {
            setShipVerdict(null);
        },
        generationCap,
        routeLocaleVisible,
        routeLocaleRebuildBlocked,
        onKeepRouteLocale: () => {
            setKeptRouteLocale(route?.snapshot?.snapshotId ?? null);
        },
        auditVisible,
        auditKey,
        pci,
        pciStats,
        pciPaths,
        showAllAuditFiles,
        onDismissAudit: setDismissedAuditKey,
    });
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
    const routeSummary = useMemo(() => {
        if (routeSnapshot === null) {
            return null;
        }
        const reported = routeSummaryState?.key === reviewKey ? routeSummaryState : null;
        return routeFactsForSnapshot(routeSnapshot, stopViewed, reported);
    }, [reviewKey, routeSnapshot, routeSummaryState, stopViewed]);
    const reportRouteSummary = useCallback(
        (value: RouteSummary) => {
            // Counts are intermediate while the route is being filled. The guardrail and review result
            // pick them up at `ready` (the phase dependency restarts the report).
            if (routePhase === 'ready' && routeSnapshot !== null) {
                setRouteSummaryState({ key: reviewKey, snapshotId: routeSnapshot.snapshotId, value });
            }
        },
        [reviewKey, routePhase, routeSnapshot],
    );
    const jumpToStop = useCallback(
        (stopId: string) => {
            routeNavigationId.current += 1;
            setRouteNavigation({ id: routeNavigationId.current, stopId });
            session.setView('route');
        },
        [session],
    );

    const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
    useShortcut({
        id: 'help.cheatsheet',
        keys: ['?'],
        label: 'shortcut.help.cheatsheet',
        scope: 'global',
        section: 'navigation',
        action: () => {
            setCheatsheetOpen(true);
        },
    });
    useEffect(() => {
        if (noteFocusRequest === null || (view !== 'route' && view !== 'diff')) {
            return;
        }

        return revealWhenReady(() => {
            const root =
                view === 'route'
                    ? document.querySelector<HTMLElement>('#view-route')
                    : document.querySelector<HTMLElement>('.full-diff');
            const note = root === null ? null : findAgentNote(root, noteFocusRequest.noteId);
            if (note === null) {
                return false;
            }
            note.scrollIntoView({ block: 'center' });
            flashAgentNote(note);
            return true;
        }, NOTE_FOCUS_SEARCH_MS);
    }, [noteFocusRequest, view]);

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
    /** Opens a thread by id: set the `thread` fragment and switch to the full diff, where it is visible. */
    const openThreadInDiff = useCallback(
        (threadId: string) => {
            window.location.hash = updateFragment(window.location.hash, { thread: threadId, file: null });
            session.setView('diff');
        },
        [session],
    );
    /**
     * "View at the old commit" (SPEC §2.17) opens the pinned iteration in the Full diff tab.
     * It usually has no route. Patch the selection and `thread` into the fragment together,
     * or changing iterations would clear `thread` as an anchor from another diff.
     */
    const openThreadAtIteration = useCallback(
        (diffId: string, threadId: string) => {
            session.setView('diff');
            session.setViewing({ kind: 'diff', diffId }, { thread: threadId, file: null });
            // replaceState writes the URL without waking `hashchange` listeners.
            window.dispatchEvent(new Event('hashchange'));
        },
        [session],
    );
    // PR comments modal, opened by the action panel and discussion card (§1e item 5).
    const prComments = usePrCommentsGate();
    const threadPin = useMemo<ThreadPinContextValue>(
        () => ({ activeDiffId, viewingDiffId: currentDiff?.diffId ?? null, openAtPin: openThreadAtIteration }),
        [activeDiffId, currentDiff, openThreadAtIteration],
    );

    /** Tour step 06 opens the chat panel and closes it on leaving the step (SPEC-onboarding §2). */
    const openChatPanel = useCallback(() => {
        session.setChatOpen(true);
    }, [session]);
    /** Pass key. "Show onboarding again" recreates the host so the tour starts at 01. */
    const [tourReplays, setTourReplays] = useState(0);
    useTourReplayCommand(() => {
        setTourReplays((count) => count + 1);
    });
    const tourEpoch = tourAnchorEpoch({
        view,
        routeKind,
        anyStopFilled: routeViewSnapshot?.stops.some((stop) => stop.status === 'ready') === true,
        chatOpen,
        completed: completion !== null,
    });
    /**
     * Tour scaffold replaces an empty Route tab: until a route exists, anchors for steps 01–03
     * have no targets. A small PR or previous iteration will never have a route, so the scaffold
     * would misrepresent that state, and the steps use fallback placement.
     */
    const tourScaffoldVisible =
        tourActive &&
        view === 'route' &&
        completion === null &&
        !resolved.routeless &&
        (routeKind === 'invitation' || routeKind === 'reading' || routeKind === 'failed');
    // Update toast (M5-T9) waits for the tour to finish. It does not appear on top of it.
    const updateToast = useUpdateToast(state?.update ?? null, tourActive);

    if (snapshot.connection === 'fatal') {
        return (
            <MessageScreen title={t('app.stopped')}>
                <p>{snapshot.error}</p>
            </MessageScreen>
        );
    }

    if (state === null) {
        return (
            <MessageScreen title={t('app.name')}>
                <p>{snapshot.connection === 'connecting' ? t('app.connecting') : t('app.reconnecting')}</p>
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
        <BlobLoaderProvider loadBlob={loadBlob}>
        <ReadOnlyIterationProvider
            readOnly={readOnly}
            {...(sliceBase === null ? {} : { reason: SLICE_READ_ONLY_REASON })}
        >
            <ThreadPinProvider value={threadPin}>
            <TopBar
                version={UI_VERSION}
                update={state.update}
                onOpenUpdate={updateToast.reopen}
                breadcrumb={breadcrumbFor(state.prKey, state.pr)}
                agent={agentPillView(state.worker, state.tasks, t)}
                reconnectCommand={reconnectCommand(state.prKey)}
                chatOpen={chatOpen}
                onToggleChat={toggleChat}
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

            <div className="app-workspace">
                <div className="app-workspace__content">
            {snapshot.connection === 'reconnecting' ? (
                <div className="connection-banner">
                    <div className="connection-banner__title">{t('app.reconnecting')}</div>
                    <p>{t('app.reconnecting.text')}</p>
                </div>
            ) : null}

            <BannerSlot sources={bannerSources} />

            {completion !== null ? (
                <ReviewComplete
                    completion={completion}
                    onOpenThread={openThreadInDiff}
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
                    agentConnected={state.worker.kind === 'connected'}
                    onAskSelection={openChatForSelection}
                    isSelectionPending={isSelectionPending}
                    onSelectionAnchorChange={selectChatAnchor}
                    onComposeQuestion={composeDiffQuestion}
                    notes={notesInCode}
                    onOpenNoteInChat={openNoteInChat}
                    onDeleteNote={deleteNote}
                    selectionNavigationRequest={chatAnchorNavigationRequest}
                    paletteNavigation={paletteNavigation}
                    onFilterChangeHandler={setDiffFilterHandler}
                    onPaletteActiveFileChange={(fileId) => {
                        if (fileId !== null) {
                            setActiveFileId(fileId);
                        }
                    }}
                    routeSnapshot={resolved.routeless ? null : routeSnapshot}
                    onJumpToStop={jumpToStop}
                    smallPr={route?.smallPr === true}
                    headerAside={snapshotPill}
                    slice={sliceCommits}
                    onActiveIteration={backToActiveIteration}
                />
            ) : view === 'overview' && sliceCommits !== null ? (
                <SliceWithoutOverview
                    slice={sliceCommits}
                    onReadDiff={() => {
                        session.setView('diff');
                    }}
                />
            ) : view === 'route' && resolved.routeless ? (
                <IterationWithoutRoute
                    commit={resolved.label?.commit ?? null}
                    slice={sliceCommits}
                    onReadDiff={() => {
                        session.setView('diff');
                    }}
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
                    agentConnected={state.worker.kind === 'connected'}
                    onAskSelection={openChatForSelection}
                    isSelectionPending={isSelectionPending}
                    onSelectionAnchorChange={selectChatAnchor}
                    onComposeQuestion={composeRouteQuestion}
                    notes={notesInCode}
                    onOpenNoteInChat={openNoteInChat}
                    onDeleteNote={deleteNote}
                    selectionNavigationRequest={chatAnchorNavigationRequest}
                    agentStopped={routePhase === 'filling' && state.worker.kind === 'disconnected'}
                    navigation={routeNavigation}
                    onUnderExplained={setRouteUnderExplained}
                    {...(routePhase === 'ready' ? { onFillStop: fillStop } : {})}
                    onRouteSummary={reportRouteSummary}
                    onOpenThread={openThreadInDiff}
                    headerAside={snapshotPill}
                    generationCap={generationCap}
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
                    picker={{ rows: pickerMenuRows, viewing: resolved.viewing, now, onSelect: selectViewing }}
                    {...(snapshotPill === null ? {} : { headerAside: snapshotPill })}
                    {...(showReviewActionBar && reviewActionBarDataReady
                        ? { onWritePrComment: prComments.openModal }
                        : {})}
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

            {/* Tour scaffold: placeholder anchors in the Route tab until a route exists (M5-T8). */}
            {tourScaffoldVisible ? <TourScaffold /> : null}
                </div>
                {chatOpen ? (
                    <>
                        <button
                            type="button"
                            className="chat-panel-scrim"
                            aria-label={t('app.closeChat')}
                            onClick={closeChat}
                        />
                        <ChatPanel
                            prKey={state.prKey}
                            worker={state.worker}
                            tasks={state.tasks}
                            exchanges={chatData.exchanges}
                            notes={chatData.notes}
                            loading={currentChat.loading}
                            error={currentChat.error}
                            reconnectCommand={reconnectCommand(state.prKey)}
                            anchor={currentChatComposer.anchor}
                            focusRequest={chatFocusRequest}
                            prefillRequest={chatPrefillRequest}
                            scrollRequest={chatScrollRequest}
                            onScrollRequestHandled={handleChatScrollRequest}
                            onClose={closeChat}
                            onRemoveAnchor={() => {
                                setChatComposerContext({ key: chatKey, anchor: null, latched: false });
                            }}
                            onAsk={askChat}
                            onCancel={cancelChat}
                            onRetry={retryChat}
                            onNavigate={navigateChatAnchor}
                            onNavigateToNote={navigateToNote}
                            viewDiffId={notesDiffId}
                        />
                    </>
                ) : null}
            </div>

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

            {cheatsheetOpen ? (
                <ShortcutCheatsheet
                    onClose={() => {
                        setCheatsheetOpen(false);
                    }}
                />
            ) : null}

            <CommandPalette
                open={paletteOpen}
                source={paletteSource}
                iterations={{ rows: pickerMenuRows, viewing: resolved.viewing, now, onSelect: selectViewing }}
                chat={paletteChat}
                sourceError={currentReview.diffError}
                status={paletteStatus}
                onStatusHandled={() => {
                    setPaletteStatus(null);
                }}
                onOpen={() => {
                    session.setPaletteOpen(true);
                }}
                onClose={() => {
                    session.setPaletteOpen(false);
                }}
            />

            {tourActive ? (
                <TourHost
                    key={tourReplays}
                    epoch={tourEpoch}
                    agentConnected={agentConnected}
                    onOpenChat={openChatPanel}
                    onCloseChat={closeChat}
                />
            ) : null}

            {updateToast.visible && state.update !== null ? (
                <UpdateToast
                    update={state.update}
                    onLater={updateToast.later}
                    onDismissVersion={updateToast.dismissVersion}
                />
            ) : null}

            {showReviewActionBar ? (
                reviewActionBarDataReady && reviewHost !== null && state.pr !== null ? (
                    <ReviewActionBar
                        pr={state.pr}
                        diff={currentDiff}
                        diffStore={diffStore}
                        threadStore={threadStore}
                        connection={snapshot.connection}
                        hostName={hostDisplayName(reviewHost, t)}
                        route={routeSummary === null ? null : { ...routeSummary, viewed: stopViewed }}
                        composerTransport={composerTransport}
                        draftBuffer={draftBuffer}
                        onPublish={publishHere}
                        onComplete={completeReview}
                        prComments={prComments}
                        chatOpen={chatOpen}
                    />
                ) : (
                    <ReviewActionBarLoading diffError={currentReview.diffError} />
                )
            ) : null}
            </ThreadPinProvider>
        </ReadOnlyIterationProvider>
        </BlobLoaderProvider>
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

const EMPTY_DRAFT_BUFFER: readonly DraftBufferEntry[] = [];
/** How long to wait for a note after navigation. The virtualizer and route take time to render cards. */
const NOTE_FOCUS_SEARCH_MS = 3000;
