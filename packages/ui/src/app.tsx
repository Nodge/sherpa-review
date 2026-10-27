import type { DraftBufferEntry } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import './app.css';
import { fetchDraftBuffer, sendFeedback, setReviewThreadResolved } from './api.js';
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
import { useRouteUncovered } from './app/use-route-uncovered.js';
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
} from './components/review-action-bar.tsx';
import { useUpdateCheckCommand, useUpdateToast } from './components/update-state.js';
import { UpdateToast } from './components/update-toast.tsx';
import { ReviewComplete } from './components/review-complete.tsx';
import { ShortcutCheatsheet } from './components/shortcut-cheatsheet.tsx';
import { TopBar } from './components/top-bar.tsx';
import { ReviewHostProvider } from './app/review-host-context.tsx';
import { BlobLoaderProvider } from './diff-view/blob-loader.tsx';
import { expandFileContext } from './diff-view/expand.js';
import { findAgentNote, flashAgentNote, revealWhenReady } from './diff-view/line-target.js';
import { activeAuditFilter, buildFileFilters, filterFiles, filterStats } from './filters/lens-filters.js';
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
import type { OtherStopFacts } from './route/other-stop.js';
import { visibleStops } from './route/other-stop.js';
import type { SessionStore } from './session/session-store.js';
import type { ViewId } from './session/views.js';
import { useShortcut, useShortcutRegistry } from './shortcuts/context.tsx';
import type { ShortcutScope } from './shortcuts/registry.js';
import type { Store } from './store.js';
import { attachComposerBeforeUnload } from './threads/before-unload.js';
import { syncBufferedComposers } from './threads/draft-buffer.js';
import { createThreadActions } from './threads/actions.js';
import { createComposerTransport, createPublishedCommentTransport } from './threads/transport.js';
import type { ThreadActions } from './threads/thread-list.tsx';
import { persistentThreadStore } from './threads/persistent-store.js';
import type { ThreadStore } from './threads/store.js';
import { UI_VERSION } from './version.js';
import { FullDiffView } from './views/full-diff.tsx';
import { secondPassBannerVisible } from './views/route/iteration-banners.tsx';
import { RouteCommands, RouteGenerateCommand, RoutePresetCommand } from './views/route/route-commands.tsx';
import { RouteFailedView, RouteReadingView } from './views/route/route-generating.tsx';
import { RouteView } from './views/route/route-view.tsx';
import { IterationWithoutRoute, SliceWithoutOverview, ViewFrame } from './views/view-frames.tsx';

/** Subscription to a store that does not exist yet. The reference must stay stable. */
const noSubscribe = (): (() => void) => () => undefined;

/** Shortcut registry scope for the open view (docs/design/SPEC-elements.md §5). */
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
    /** The effective tab language also controls route generation and chat answers. */
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
    // The "Check for updates" palette command. The toast below waits until the tour ends.
    const [paletteStatus, setPaletteStatus] = useState<string | null>(null);
    useUpdateCheckCommand({
        token,
        current: state?.update?.current ?? UI_VERSION,
        onStatus: setPaletteStatus,
    });
    // The browser tab identifies the PR (#37). Before metadata arrives, it uses the number from the key, so it is never empty.
    const documentTitle = state === null ? null : documentTitleFor(state.prKey, state.pr);
    const reviewHost = state?.reviewHost ?? null;
    // Keys and effects use the adapter name, not the host description object.
    const reviewHostId = reviewHost?.id ?? null;
    /**
     * Iterations are working-tree snapshots. The UI uses specific wording for a previous iteration.
     * Read the field here instead of in a helper. React Compiler treats an object passed to a function
     * as mutable and stops memoizing the callbacks below.
     */
    const localHost = reviewHost?.iterations === 'tree';
    const reviewKey = `${token}\u0000${reviewHostId ?? 'none'}`;
    const chatKey = [reviewKey, state?.prKey ?? 'none'].join(':');

    // --- Iteration selection: snapshot list, selection resolution, tab data key ---

    const {
        snapshotsState,
        setSnapshotsState,
        facts,
        setActiveFacts,
        applyActiveRoute,
        reviewState,
        setReviewState,
    } = useReviewState(reviewKey, reviewHostId);
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
    // The active PR iteration is also the reference point for thread pins.
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
    /** The tab displays an inter-iteration slice. Load its diff through the `base`/`head` endpoint. */
    const sliceBase = resolved.slice?.base ?? null;
    const sliceHead = resolved.slice?.head ?? null;
    /**
     * Reload key for the diff and lenses without parameters. They have no revision of their own and learn about
     * a push only here. While the route snapshot belongs to a previous iteration, the key keeps that diff
     * (stop anchors address files by the `fileId` of their own iteration) and moves
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
    const viewKey = [reviewKey, viewDiffId ?? '', viewSnapshotId ?? '', sliceBase ?? '', sliceHead ?? ''].join('\u0000');
    const storedReview = reviewStateForKeys(reviewState, reviewKey, viewKey);
    /**
     * Tab data. A slice has no progress, lenses or threads. Its `fileId` values belong to a separate
     * namespace, so iteration endpoints do not apply. Use empty placeholders
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
    /** The host provides inter-iteration slices. Without this, Shift+click in the picker cannot build a slice. */
    const interdiffAvailable = state?.pr?.capabilities.iterations === true;
    /** Image bytes. Without `capabilities.blobs`, image cards are not rendered at all. */
    const blobsAvailable = state?.pr?.capabilities.blobs === true;
    const routeSnapshotId = currentReview.route?.snapshot?.snapshotId ?? null;
    const prKey = state?.prKey ?? null;
    const { diffStore, loadBlob, parse } = useDiffStore({ diff: currentDiff, prKey, blobsAvailable, token });
    /*
     * The app needs the actual diff mode for one reason: it changes the code panel limit,
     * and therefore the tour frame. The subscription returns a string, so other store updates (model parsing,
     * progress) do not trigger a React render because the value stays the same.
     */
    const effectiveDiffMode = useSyncExternalStore(
        diffStore?.subscribe ?? noSubscribe,
        () => diffStore?.getSnapshot().effectiveMode ?? 'unified',
    );
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
    /** When the route explains less than half the diff, the notification slot shows a banner (docs/design/SPEC-elements.md §4.3). */
    const [routeUnderExplained, setRouteUnderExplained] = useState(false);
    /**
     * Route counts from the view: stops in render order and uncovered ranges for the guardrail and review result.
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
        reviewHost: reviewHostId,
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
     * Thread store key. A slice shares its `diffId` with its head iteration, so it needs a separate key,
     * or its empty thread list would erase that iteration's threads and open composers.
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
    // Published comments belong to the reviewer if they match the identity in PR metadata.
    const viewerLogin = state?.pr?.viewer?.login ?? null;
    useEffect(() => {
        threadStore?.setViewer(viewerLogin);
    }, [threadStore, viewerLogin]);
    useEffect(() => (threadStore === null ? undefined : attachComposerBeforeUnload(threadStore)), [threadStore]);
    const composerTransport = useMemo(() => createComposerTransport(token), [token]);
    const publishedTransport = useMemo(() => createPublishedCommentTransport(token), [token]);
    const resolveThread = useCallback(
        (threadId: string, resolved: boolean) => setReviewThreadResolved(token, threadId, resolved),
        [token],
    );
    /**
     * Thread actions for the "PR comments" modal. It sits beside the action panel
     * rather than in the diff view and has no resolve or edit wiring of its own. The write queue
     * belongs to the store, so a second set of actions does not create another queue.
     */
    const prCapabilities = state?.pr?.capabilities ?? null;
    const prThreadActions = useMemo<ThreadActions | null>(
        () =>
            threadStore === null || prCapabilities === null
                ? null
                : createThreadActions(
                      threadStore,
                      composerTransport,
                      resolveThread,
                      {
                          transport: publishedTransport,
                          commentResolve: prCapabilities.commentResolve,
                          editPublished: prCapabilities.editPublished,
                      },
                      prCapabilities.commentIssues,
                  ),
        [composerTransport, prCapabilities, publishedTransport, resolveThread, threadStore],
    );

    const { shipVerdict, shipVerdictNow, setShipVerdict, publishHere } = useShipVerdict(
        state?.pr?.verdicts ?? null,
        token,
    );

    /**
     * Read the draft buffer along with threads, using the same `review` event and token.
     * A read failure gets no separate error display. Keep the last known buffer on screen,
     * and reload it at the next revision.
     */
    const [draftBuffer, setDraftBuffer] = useState<readonly DraftBufferEntry[]>(EMPTY_DRAFT_BUFFER);
    useEffect(() => {
        if (!reviewReady || reviewHostId === null) {
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
    }, [reviewHostId, reviewReady, snapshot.threadsRevision, token]);
    // Buffered entries return to composers at their own anchors. After a tab reload,
    // the text must appear on the same line.
    // Threads are not a dependency for rendering. Both a draft edit and a reply are restored
    // only with their own comment in the snapshot, which arrives in its own time.
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
    const audit = activeAuditFilter(filters, filterId);
    const auditStats = currentDiff === null || audit === null ? null : filterStats(currentDiff.files, audit);
    const auditPaths =
        currentDiff === null || audit === null ? [] : filterFiles(currentDiff.files, audit).map((file) => file.path);
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
        audit?.id ?? null,
        dismissedAuditKey === auditKey,
        auditStats?.files ?? 0,
    );

    // --- Route generation: endpoints, long-running task, default view for a small PR ---

    const route = currentReview.route;
    // The tour starts as soon as a state snapshot and diff exist. It does not wait for a route.
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
     * Generation cap (docs/design/SPEC-elements.md §4.1). The server calculates it from the active snapshot, so it stays
     * silent when reading a previous iteration because the displayed route belongs to another iteration.
     */
    const generationCap = readOnly ? null : (state?.generationCap ?? null);
    /**
     * The second-pass banner is dismissed for this snapshot. It describes a filter, so it is dismissible
     * (docs/design/SPEC-elements.md §2.21). Dismissal lives in the tab session and clears when a new snapshot arrives.
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
     * and resets. Otherwise it would stay in the URL and silently activate on the next pass
     * that has classifications, even though the reviewer did not enable it then.
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
        localHost,
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
        reviewHost: reviewHostId,
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
     * "Keep it" on the route language banner: tab memory keyed by snapshot id.
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
        localHost,
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
        audit,
        auditStats,
        auditPaths,
        showAllAuditFiles,
        onDismissAudit: setDismissedAuditKey,
    });
    const stopViewed = useSyncExternalStore(
        stopProgress.subscribe,
        stopProgress.getSnapshot,
        stopProgress.getSnapshot,
    );
    /**
     * Whether "Other" (`otherStopVisible`) appears in Overview, the palette, the tour and the action panel uses the same
     * models as the route view, without mounting it. Parse the diff in the background.
     */
    const routeUncovered = useRouteUncovered({
        diff: currentDiff,
        store: diffStore,
        snapshot: route?.snapshot ?? null,
        parse,
    });
    const conflictFiles = useMemo(
        () => currentDiff?.files.filter((file) => file.changeType === 'conflict').length ?? 0,
        [currentDiff],
    );
    const routeOtherFacts = useMemo<OtherStopFacts>(
        () => ({ uncovered: routeUncovered, conflictFiles }),
        [conflictFiles, routeUncovered],
    );
    const reportedRouteSummary = routeSummaryState?.key === reviewKey ? routeSummaryState : null;
    const routeSummary = useMemo(
        () =>
            routeSnapshot === null ? null : routeFactsForSnapshot(routeSnapshot, reportedRouteSummary, routeOtherFacts),
        [reportedRouteSummary, routeOtherFacts, routeSnapshot],
    );
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
     * "Show on old commit" (docs/design/SPEC-elements.md §2.17) opens the pinned iteration in the full diff tab.
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

    /** Tour step 06 opens the chat panel and closes it on leaving the step (docs/design/SPEC-onboarding-2026-09-02.md §2). */
    const openChatPanel = useCallback(() => {
        session.setChatOpen(true);
    }, [session]);
    /** Pass key. "Show onboarding again" recreates the host so the tour starts at 01. */
    const [tourReplays, setTourReplays] = useState(0);
    const replayTour = useCallback(() => {
        setTourReplays((count) => count + 1);
    }, []);
    useTourReplayCommand(replayTour, agentConnected);
    const tourEpoch = tourAnchorEpoch({
        view,
        routeKind,
        anyStopFilled:
            routeViewSnapshot !== null &&
            visibleStops(routeViewSnapshot, routeOtherFacts).some((stop) => stop.status === 'ready'),
        chatOpen,
        completed: completion !== null,
        diffMode: effectiveDiffMode,
        locale: uiLocale,
    });
    /**
     * Tour scaffold in place of an empty route tab. Without a route, steps 01–03
     * have no targets. A small PR or previous iteration will never have a route, so the scaffold
     * would misrepresent them. Those steps use their fallback positions instead.
     */
    const tourScaffoldVisible =
        tourActive &&
        view === 'route' &&
        completion === null &&
        !resolved.routeless &&
        (routeKind === 'invitation' || routeKind === 'reading' || routeKind === 'failed');
    // The update toast waits for the tour to end. It never appears over the tour.
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
        completed: completion !== null,
        reviewHost,
        pr: state.pr,
        dataReady: reviewActionBarDataReady,
    });

    return (
        <ReviewHostProvider value={reviewHost}>
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
                agentConnected={agentConnected}
                onReplayTour={replayTour}
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
                    parse={parse}
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
                    parse={parse}
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
                    picker={{ rows: pickerMenuRows, viewing: resolved.viewing, now, localHost, onSelect: selectViewing }}
                    {...(snapshotPill === null ? {} : { headerAside: snapshotPill })}
                    {...(showReviewActionBar && reviewActionBarDataReady
                        ? { onWritePrComment: prComments.openModal }
                        : {})}
                    onJumpToStop={jumpToStop}
                    onOpenFile={(fileId) => {
                        navigateFromPalette({ kind: 'file', fileId });
                    }}
                    generation={{
                        route,
                        other: routeOtherFacts,
                        longRunning,
                        cancelling,
                        retrying: generating,
                        actionError: routeActionError,
                        onRetry: startGeneration,
                        onCancel: cancelGeneration,
                    }}
                />
            )}

            {/* Tour scaffold: placeholder step targets on the route tab until a route exists. */}
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
                    <RouteCommands snapshot={routeViewSnapshot} other={routeOtherFacts} onJump={jumpToStop} />
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
                iterations={{ rows: pickerMenuRows, viewing: resolved.viewing, now, localHost, onSelect: selectViewing }}
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
                        draftDestination={reviewHost.drafts}
                        route={routeSummary === null ? null : { ...routeSummary, viewed: stopViewed }}
                        composerTransport={composerTransport}
                        {...(prThreadActions === null ? {} : { threadActions: prThreadActions })}
                        draftBuffer={draftBuffer}
                        onPublish={publishHere}
                        onComplete={completeReview}
                        prComments={prComments}
                        chatOpen={chatOpen}
                    />
                ) : null
            ) : null}
            </ThreadPinProvider>
        </ReadOnlyIterationProvider>
        </BlobLoaderProvider>
        </ReviewHostProvider>
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
