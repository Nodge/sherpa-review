import type {
    AgentNote,
    ChatAnchor,
    DraftBufferEntry,
    Iteration,
    PrDiff,
    PublishResult,
    RouteSnapshot,
    Thread,
    UiChatAskAnchor,
    UiChatResponse,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
    UiRoutePhase,
    UiRouteState,
    UiSnapshotSummary,
    UiTask,
    Verdict,
} from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import './app.css';
import {
    ApiError,
    askReviewChat,
    cancelReviewChat,
    cancelTask,
    fetchDraftBuffer,
    fetchReviewChat,
    fetchReviewDiff,
    fetchReviewLenses,
    fetchReviewProgress,
    fetchReviewRoute,
    fetchReviewSnapshots,
    fetchReviewThreads,
    deleteReviewChatNote,
    fillRouteStop,
    generateReviewRoute,
    mirrorViewedFiles,
    publishReview,
    retryReviewChat,
    sendFeedback,
    setFileViewed,
    setStopViewed,
} from './api.js';
import { agentPillView } from './components/agent-pill-view.js';
import { auditScopeBannerVisible, AuditScopeBanner } from './components/audit-banner.tsx';
import type { BannerSource } from './components/banner-slot.tsx';
import { BANNER_PRIORITY, BannerSlot } from './components/banner-slot.tsx';
import type { ChatScrollTarget } from './components/chat-panel.tsx';
import { ChatPanel, sameChatAnchor } from './components/chat-panel.tsx';
import { useChatDock } from './components/dock.js';
import { reconnectCommand } from './components/reconnect-command.js';
import type { ReviewCompletion } from './components/review-action-bar.tsx';
import {
    reviewActionBarVisible,
    ReviewActionBar,
    ReviewActionBarLoading,
} from './components/review-action-bar.tsx';
import { ReviewComplete } from './components/review-complete.tsx';
import { TopBar } from './components/top-bar.tsx';
import { expandFileContext } from './diff-view/expand.js';
import { findAgentNote, flashAgentNote, revealWhenReady } from './diff-view/line-target.js';
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
import { ReadOnlyIterationProvider, SLICE_READ_ONLY_REASON } from './iterations/read-only.tsx';
import { ThreadPinProvider } from './iterations/thread-pin.tsx';
import type { ThreadPinContextValue } from './iterations/thread-pin.tsx';
import { SnapshotPill } from './iterations/snapshot-picker.tsx';
import {
    activeIterationDiffId,
    fallbackSnapshots,
    pickerRows,
    resolveViewing,
    VIEWING_CURRENT,
} from './iterations/viewing.js';
import { noteAnchorForIteration, notesForIteration, noteVisibleInIteration } from './notes/model.js';
import { CommandPalette } from './palette/command-palette.tsx';
import type { PaletteDiffSource, PaletteNavigation, PaletteNavigationTarget } from './palette/diff-source.tsx';
import { breadcrumbFor, documentTitleFor } from './pr-key.js';
import { usePrStateStore } from './pr-state/context.tsx';
import { collapsedFromMap, collapsedToMap } from './pr-state/pr-state-store.js';
import { selectionLinkHash } from './selection-link.js';
import { createProgressWriter } from './progress/progress-writer.js';
import type { ProgressWriter } from './progress/progress-writer.js';
import { createStopProgressStore } from './progress/stop-progress-store.js';
import { viewedMirrorUpdate } from './progress/viewed-mirror.js';
import {
    generationIsLong,
    openRouteTasks,
    routeActionErrorInPlace,
    routeGenerationAvailable,
    routeViewKind,
} from './route/generation.js';
import type { ReportedRouteSummary, RouteSummary } from './route/route-summary.js';
import { routeFactsForSnapshot } from './route/route-summary.js';
import type { SessionStore } from './session/session-store.js';
import type { ViewId } from './session/views.js';
import { useUiSettingsStore } from './settings/context.tsx';
import type { Store } from './store.js';
import { attachComposerBeforeUnload } from './threads/before-unload.js';
import type { ShipVerdictEvent, ShipVerdictWatch } from './components/ship-verdict-banner.tsx';
import {
    INITIAL_SHIP_VERDICT_WATCH,
    observeShipVerdicts,
    ShipVerdictBanner,
} from './components/ship-verdict-banner.tsx';
import { syncBufferedComposers } from './threads/draft-buffer.js';
import { createComposerTransport } from './threads/transport.js';
import { persistentThreadStore } from './threads/persistent-store.js';
import type { ThreadStore } from './threads/store.js';
import { UI_VERSION } from './version.js';
import { FullDiffView } from './views/full-diff.tsx';
import {
    GenerationFailedBanner,
    RouteActionErrorBanner,
    RouteFillingBanner,
    RouteRegeneratingBanner,
} from './views/route/generation-card.tsx';
import {
    NotesLostBanner,
    notesLostBannerVisible,
    notesLostKey,
    ReadOnlyIterationBanner,
    RouteSecondPassBanner,
    RouteStaleBanner,
    secondPassBannerVisible,
    staleBannerVisible,
} from './views/route/iteration-banners.tsx';
import { RegenerateBanner } from './views/route/other-card.tsx';
import { RouteCommands, RouteGenerateCommand, RoutePresetCommand } from './views/route/route-commands.tsx';
import { RouteFailedView, RouteReadingView } from './views/route/route-generating.tsx';
import { RouteView } from './views/route/route-view.tsx';
import { IterationWithoutRoute, SliceWithoutOverview, ViewFrame } from './views/view-frames.tsx';

/** The main page reads server and session stores through `useSyncExternalStore`. */
export interface AppProps {
    readonly store: Store;
    readonly session: SessionStore;
    readonly token: string;
}

/** A generation or cancellation endpoint failed. The phase is the one when the reviewer clicked. */
interface RouteActionFailure {
    readonly phase: UiRoutePhase | null;
    readonly message: string;
}

interface ChatState {
    readonly key: string;
    readonly data: UiChatResponse | null;
    readonly error: string | null;
    readonly loading: boolean;
}

export interface ChatScrollRequest {
    readonly id: number;
    readonly target: ChatScrollTarget;
}

/** Opens the panel and returns an explicit feed target for the linked exchange. */
export function openNoteInChatRequest(session: SessionStore, note: AgentNote, id: number): ChatScrollRequest {
    session.setChatOpen(true);
    return { id, target: { kind: 'exchange', exchangeId: note.exchangeId } };
}

interface ChatComposerContext {
    readonly key: string;
    readonly anchor: UiChatAskAnchor | null;
    readonly latched: boolean;
}

/** PR snapshot list. `list === null` in loaded state means the server has no endpoint. */
interface SnapshotsState {
    readonly key: string;
    readonly list: readonly UiSnapshotSummary[] | null;
    readonly loaded: boolean;
}

/**
 * Known facts about the active PR iteration. Collected only from responses without parameters and kept
 * separate from tab data. Selecting a previous iteration must not erase the facts used
 * to resolve that very selection (read-only mode, labels, fallback snapshot list).
 */
interface ActiveFacts {
    readonly key: string;
    readonly diffId: string | null;
    readonly commit: string | null;
    readonly snapshot: RouteSnapshot | null;
    /** The route endpoint without parameters has already responded, including with a rejection. */
    readonly routeSettled: boolean;
}

interface ReviewState {
    readonly key: string;
    /** Key of the selected iteration. Reload the diff, progress and route when it changes. */
    readonly viewKey: string;
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
    const state = snapshot.state;
    const reviewReady = state !== null;
    // The browser tab identifies the PR (#37). Before metadata arrives, it uses the number from the key, so it is never empty.
    const documentTitle = state === null ? null : documentTitleFor(state.prKey, state.pr);
    const reviewHost = state?.reviewHost ?? null;
    const reviewKey = `${token}\u0000${reviewHost ?? 'none'}`;
    const chatKey = [reviewKey, state?.prKey ?? 'none'].join(':');

    // --- Iteration selection: snapshot list, selection resolution, tab data key (M4-T9) ---

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
    const [chatState, setChatState] = useState<ChatState>(() => emptyChatState(chatKey, reviewHost !== null));
    const currentChat = chatState.key === chatKey ? chatState : emptyChatState(chatKey, reviewHost !== null);
    const chatData = currentChat.data ?? EMPTY_CHAT_RESPONSE;
    const pendingNoteDeletions = useRef<{ key: string; ids: Set<number> }>({ key: chatKey, ids: new Set() });
    const [chatComposerContext, setChatComposerContext] = useState<ChatComposerContext>(() => ({
        key: chatKey,
        anchor: null,
        latched: false,
    }));
    const currentChatComposer =
        chatComposerContext.key === chatKey
            ? chatComposerContext
            : { key: chatKey, anchor: null, latched: false } satisfies ChatComposerContext;
    const [chatFocusRequest, setChatFocusRequest] = useState(0);
    // Prefill the composer: a request with a new id takes effect even when its text is unchanged.
    const [chatPrefillRequest, setChatPrefillRequest] = useState<{ readonly id: number; readonly text: string } | null>(
        null,
    );
    const chatPrefillRequestId = useRef(0);
    const [chatScrollRequest, setChatScrollRequest] = useState<ChatScrollRequest | null>(null);
    const chatScrollRequestId = useRef(0);
    const [chatAnchorNavigationRequest, setChatAnchorNavigationRequest] = useState(0);
    const [noteFocusRequest, setNoteFocusRequest] = useState<{ readonly id: number; readonly noteId: number } | null>(null);
    const noteFocusRequestId = useRef(0);
    const currentDiff = currentReview.diff;
    const progressLoaded = currentReview.progress !== null;
    const viewedMirrorAvailable = state?.pr?.capabilities.fileViewedSync === true;
    /** The host provides slices between iterations. Otherwise hide this picker section (M4-T4). */
    const interdiffAvailable = state?.pr?.capabilities.iterations === true;
    const routeSnapshotId = currentReview.route?.snapshot?.snapshotId ?? null;
    const prKey = state?.prKey ?? null;
    const settings = useUiSettingsStore();
    const prState = usePrStateStore();
    const diffStore = useMemo(
        () =>
            currentDiff === null || prKey === null
                ? null
                : createDiffViewStore({
                      files: currentDiff.files,
                      // Take the snapshot once when creating the store. A late endpoint response
                      // must not recreate the store while the reviewer is reading.
                      collapsed: collapsedToMap(prState.getSnapshot().diffCollapsed),
                      // Diff mode is global. It comes from the server and is written back there.
                      diffMode: settings.getSnapshot().diffMode,
                      onDiffModeChange: (mode) => {
                          settings.update({ diffMode: mode });
                      },
                  }),
        [currentDiff, prKey, prState, settings],
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
    const [progressWritesSettled, setProgressWritesSettled] = useState(0);
    // Stop marks live alongside file marks. They share a progress revision and one writer.
    // Changing the PR, host or selected iteration means a different route, so the old marks do not apply.
    const [stopProgressState, setStopProgressState] = useState(() => ({
        key: viewKey,
        store: createStopProgressStore(),
    }));
    if (stopProgressState.key !== viewKey) {
        setStopProgressState({ key: viewKey, store: createStopProgressStore() });
    }
    const stopProgress = stopProgressState.store;
    const mirroredFileWrites = useRef(new Set<string>());
    const writingProgress = useMemo<ProgressWriter | null>(
        () =>
            diffStore === null
                ? null
                : createProgressWriter({
                      initialRevision: 0,
                      read: (fileId) => diffStore.getSnapshot().progress.get(fileId) ?? null,
                      apply: (fileId, viewed) => {
                          if (viewed) {
                              mirroredFileWrites.current.delete(fileId);
                          } else {
                              mirroredFileWrites.current.add(fileId);
                          }
                          // markViewed synchronously notifies the mirror subscriber. Change the flag before writing to the store.
                          diffStore.markViewed(fileId, viewed);
                      },
                      restore: diffStore.restoreProgress,
                      send: async (fileId, viewed) => {
                          try {
                              return (await setFileViewed(token, fileId, viewed)).progressRevision;
                          } catch (error) {
                              if (!viewed) {
                                  mirroredFileWrites.current.delete(fileId);
                              }
                              throw error;
                          }
                      },
                      stops: {
                          read: (stopId) => stopProgress.getSnapshot().get(stopId) ?? null,
                          apply: stopProgress.setViewed,
                          restore: stopProgress.restore,
                          send: async (stopId, viewed, ranges) => {
                              if (routeSnapshotId === null) {
                                  throw new Error('Cannot mark a stop without a route snapshot.');
                              }
                              return (await setStopViewed(token, routeSnapshotId, stopId, viewed, ranges))
                                  .progressRevision;
                          },
                      },
                      onSettled: () => {
                          setProgressWritesSettled((settled) => settled + 1);
                      },
                  }),
        [diffStore, routeSnapshotId, stopProgress, token],
    );
    /**
     * For a previous iteration, the progress writer only refreshes the snapshot. It rejects writes
     * before the optimistic mark, so the control does not flash or revert (M4 boundaries).
     * The controls themselves are disabled. Only internal paths can reach this point.
     */
    const progressWriter = useMemo<ProgressWriter | null>(
        () =>
            writingProgress === null || !readOnly
                ? writingProgress
                : { ...writingProgress, write: () => Promise.resolve(false), writeStop: () => Promise.resolve(false) },
        [readOnly, writingProgress],
    );
    const viewedMirrorBaseline = useRef<{
        readonly reviewKey: string;
        readonly diffId: string;
        readonly state: ReadonlyMap<string, boolean>;
    } | null>(null);
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
        const revision = snapshot.routeRevision;
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
    }, [reviewHost, reviewKey, reviewReady, snapshot.routeRevision, token]);

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
        sliceBase,
        sliceHead,
        token,
        viewDiffId,
        viewKey,
        viewPending,
    ]);

    // Overview and Full diff filters need lenses, but load them independently of the raw diff.
    // A slice has no lenses. Ownership and audit scope use iteration files, while a slice has its own `fileId` values.
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
    }, [activeIterationKey, reviewHost, reviewKey, reviewReady, sliceBase, token, viewKey, viewPending]);

    // App owns one ProgressWriter. Server snapshots go through its merge,
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
            progressWriter === null ||
            viewPending ||
            // Progress uses iteration `fileId` values. A slice has its own values, with no marks for them.
            sliceBase !== null
        ) {
            return;
        }
        const initial = currentReview.progress === null;
        if (!initial && !progressWriter.shouldReload(snapshot.progressRevision)) {
            return;
        }

        let alive = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        const mark = progressWriter.beginReload();
        void fetchReviewProgress(token, viewDiffId).then(
            (response) => {
                if (!alive) {
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
        currentReview.progress,
        diffStore,
        progressRetryAttempt,
        progressWriter,
        progressWritesSettled,
        reviewHost,
        reviewKey,
        reviewReady,
        sliceBase,
        snapshot.progressRevision,
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
    }, [currentDiff, diffStore, progressLoaded, readOnly, reviewKey, token, viewedMirrorAvailable]);

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
    }, [reviewHost, reviewKey, reviewReady, snapshot.threadsRevision, threadRetryAttempt, token, viewKey]);

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
        const revision = snapshot.routeRevision;
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
        snapshot.routeRevision,
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
        const revision = snapshot.routeRevision;
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
    }, [applyActiveRoute, reviewHost, reviewKey, reviewReady, snapshot.routeRevision, token, viewPending, viewSnapshotId]);

    // Read chat history when the PR opens and refresh it only after the SSE revision increases.
    const seenChat = useRef<{ key: string; revision: number | null; loaded: boolean }>({
        key: chatKey,
        revision: null,
        loaded: false,
    });
    const [chatRetry, setChatRetry] = useState<{ key: string; attempt: number }>({ key: chatKey, attempt: 0 });
    const chatRetryAttempt = chatRetry.key === chatKey ? chatRetry.attempt : 0;
    useEffect(() => {
        if (!reviewReady || reviewHost === null) {
            return;
        }
        if (seenChat.current.key !== chatKey) {
            seenChat.current = { key: chatKey, revision: null, loaded: false };
        }
        const revision = snapshot.chatRevision;
        if (seenChat.current.loaded && seenChat.current.revision === revision) {
            return;
        }

        let alive = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        void fetchReviewChat(token).then(
            (response) => {
                if (!alive) {
                    return;
                }
                seenChat.current = { key: chatKey, revision, loaded: true };
                setChatState((current) => ({
                    key: chatKey,
                    data: mergeChatResponse(
                        response,
                        chatStateForKey(current, chatKey).data,
                        pendingNoteDeletions.current.key === chatKey
                            ? pendingNoteDeletions.current.ids
                            : EMPTY_NOTE_DELETIONS,
                    ),
                    error: null,
                    loading: false,
                }));
                if (chatRetryAttempt !== 0) {
                    setChatRetry({ key: chatKey, attempt: 0 });
                }
            },
            (error: unknown) => {
                if (!alive) {
                    return;
                }
                if (error instanceof ApiError && error.status === 404) {
                    seenChat.current = { key: chatKey, revision, loaded: true };
                    setChatState({ key: chatKey, data: EMPTY_CHAT_RESPONSE, error: null, loading: false });
                    return;
                }
                setChatState((current) => {
                    const next = chatStateForKey(current, chatKey);
                    return {
                        ...next,
                        // A background failure does not clear history already on screen.
                        error: next.data === null ? errorMessage(error) : null,
                        loading: false,
                    };
                });
                retry = setTimeout(() => {
                    setChatRetry({ key: chatKey, attempt: chatRetryAttempt + 1 });
                }, Math.min(1000 * 2 ** chatRetryAttempt, 15_000));
            },
        );
        return () => {
            alive = false;
            if (retry !== null) {
                clearTimeout(retry);
            }
        };
    }, [chatKey, chatRetryAttempt, reviewHost, reviewReady, snapshot.chatRevision, token]);

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

    /**
     * Another reviewer's ship (M5-T15): verdicts arrive in the metadata snapshot without timestamps, so
     * we record when we see them. The first snapshot in a tab session is the baseline and shows no banner.
     */
    const verdictWatch = useRef<ShipVerdictWatch>(INITIAL_SHIP_VERDICT_WATCH);
    const [shipVerdict, setShipVerdict] = useState<ShipVerdictEvent | null>(null);
    const [shipVerdictNow, setShipVerdictNow] = useState(() => Date.now());
    const verdicts = state?.pr?.verdicts ?? null;
    useEffect(() => {
        if (verdicts === null) {
            return;
        }
        const observed = observeShipVerdicts(verdictWatch.current, verdicts, Date.now());
        verdictWatch.current = observed.watch;
        if (observed.event !== null) {
            setShipVerdict(observed.event);
            setShipVerdictNow(observed.event.observedAt);
        }
    }, [verdicts]);
    const publishHere = useCallback(
        async (verdict: Verdict): Promise<PublishResult> => {
            const result = await publishReview(token, verdict);
            if (verdict === 'ship' || verdict === 'sticky_ship') {
                // Our own verdict is about to appear in metadata. There is nobody to notify with a banner.
                verdictWatch.current = { ...verdictWatch.current, ownShipPending: true };
            }
            return result;
        },
        [token],
    );
    // After a minute, "just now" becomes "N min ago". The banner time updates automatically.
    useEffect(() => {
        if (shipVerdict === null) {
            return;
        }
        const timer = window.setInterval(() => {
            setShipVerdictNow(Date.now());
        }, 60_000);
        return () => {
            window.clearInterval(timer);
        };
    }, [shipVerdict]);

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
        if (
            !routeGenerationAvailable({
                phase: routePhase,
                smallPr: route?.smallPr === true,
                generating: generationInFlight.current,
            })
        ) {
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
    }, [route?.smallPr, routePhase, stopGenerating, token]);
    const fillStop = useCallback(
        (planIndex: number) => {
            const snapshotId = route?.snapshot?.snapshotId;
            if (routePhase !== 'ready' || snapshotId === undefined) {
                return;
            }

            setRouteActionFailure(null);
            void fillRouteStop(token, { snapshotId, planIndex }).then(
                (outcome) => {
                    if (outcome === 'stale_snapshot' || outcome === 'not_unfilled') {
                        refreshRoute();
                    }
                },
                (error: unknown) => {
                    setRouteActionFailure({ phase: routePhase, message: errorMessage(error) });
                },
            );
        },
        [refreshRoute, route?.snapshot?.snapshotId, routePhase, token],
    );
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
    const generateAvailable = routeGenerationAvailable({
        phase: routePhase,
        smallPr: route?.smallPr === true,
        generating,
    });

    /**
     * The snapshot behind the review counts is a completed route with a `contentHash`. The old ready
     * snapshot still qualifies during a rebuild. The new partial snapshot stays out until `ready`.
     */
    const routeSnapshot = route?.snapshot?.contentHash == null ? null : route.snapshot;
    /** The Route tab renders any live snapshot, including the old one during a rebuild. */
    const routeViewSnapshot = routeKind === 'workspace' && !resolved.routeless ? (route?.snapshot ?? null) : null;
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
    /** Whether the ready snapshot has classified stops determines the "what is new" filter. */
    const routeHasChanges = routeSnapshot?.stops.some((stop) => stop.change !== null) ?? false;
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

    /** Iteration selection: the pill menu and Overview card use the same rows. */
    const pickerMenuRows = useMemo(
        () =>
            pickerRows({
                snapshots,
                iterations,
                activeIteration:
                    facts.diffId === null || facts.commit === null
                        ? null
                        : { diffId: facts.diffId, commit: facts.commit },
                interdiff: interdiffAvailable,
            }),
        [facts.commit, facts.diffId, interdiffAvailable, iterations, snapshots],
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

    const openNoteInChat = useCallback(
        (note: AgentNote) => {
            chatScrollRequestId.current += 1;
            setChatScrollRequest(openNoteInChatRequest(session, note, chatScrollRequestId.current));
        },
        [session],
    );

    /**
     * Notes with anchors lost after a push (M4-T11). Banner dismissal lives in the tab session
     * and resets as soon as another note loses its anchor.
     */
    const lostNotes = useMemo(() => chatData.notes.filter((note) => note.lostAnchor), [chatData.notes]);
    const lostNoteIds = useMemo(() => lostNotes.map((note) => note.id), [lostNotes]);
    /** "Show" navigates to the first note with a lost anchor, in chat feed order. */
    const firstLostNote = lostNotes[0];
    const [dismissedNotesLost, setDismissedNotesLost] = useState<string | null>(null);

    const bannerSources: readonly BannerSource[] = [
        {
            id: 'generation-failed',
            priority: BANNER_PRIORITY.generationFailed,
            // Without a snapshot, the route tab shows the same reason in a full-screen red card.
            active: () => routePhase === 'failed' && (view !== 'route' || route?.snapshot != null),
            render: () =>
                route?.failure == null ? null : (
                    <GenerationFailedBanner
                        message={route.failure.message}
                        rebuilding={route.snapshot !== null}
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
            id: 'route-regenerating',
            priority: BANNER_PRIORITY.routeRegenerating,
            active: () => view === 'route' && routePhase === 'reading' && route?.snapshot != null,
            render: () => <RouteRegeneratingBanner cancelling={cancelling} onCancel={cancelGeneration} />,
        },
        {
            id: 'route-stale',
            priority: BANNER_PRIORITY.routeStale,
            active: () => staleBannerVisible(routePhase, route?.stale ?? null, route?.snapshot ?? null, readOnly),
            render: () =>
                route?.stale == null || route.snapshot == null ? null : (
                    <RouteStaleBanner
                        stale={route.stale}
                        stops={route.snapshot.stops}
                        onRegenerate={startGeneration}
                        onOpenDiffWithoutRoute={openIterationWithoutRoute}
                    />
                ),
        },
        {
            id: 'read-only-iteration',
            priority: BANNER_PRIORITY.readOnlyIteration,
            active: () => readOnly && resolved.label !== null,
            render: () =>
                resolved.label === null ? null : (
                    <ReadOnlyIterationBanner
                        label={resolved.label}
                        createdAt={resolved.createdAt}
                        now={now}
                        gone={resolved.gone}
                        onCurrent={() => {
                            session.setViewing(VIEWING_CURRENT);
                        }}
                    />
                ),
        },
        {
            id: 'route-second-pass',
            priority: BANNER_PRIORITY.routeSecondPass,
            active: () => secondPassVisible,
            render: () =>
                routeSnapshot === null ? null : (
                    <RouteSecondPassBanner
                        commit={routeSnapshot.commit}
                        carried={routeSnapshot.carried}
                        hasChanges={routeHasChanges}
                        onShowNew={() => {
                            session.setRouteFilter('new');
                        }}
                        onDismiss={() => {
                            setDismissedSecondPass(routeSnapshot.snapshotId);
                        }}
                    />
                ),
        },
        {
            id: 'route-under-explained',
            priority: BANNER_PRIORITY.routeUnderExplained,
            active: () => view === 'route' && routeUnderExplained,
            render: () => <RegenerateBanner {...(generateAvailable ? { onGenerate: startGeneration } : {})} />,
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
            id: 'notes-lost',
            priority: BANNER_PRIORITY.notesLost,
            active: () => notesLostBannerVisible(routePhase, lostNoteIds, dismissedNotesLost, readOnly),
            render: () =>
                firstLostNote === undefined ? null : (
                    <NotesLostBanner
                        count={lostNoteIds.length}
                        onShow={() => {
                            openNoteInChat(firstLostNote);
                        }}
                        onDismiss={() => {
                            setDismissedNotesLost(notesLostKey(lostNoteIds));
                        }}
                    />
                ),
        },
        {
            id: 'ship-verdict',
            priority: BANNER_PRIORITY.shipVerdict,
            active: () => shipVerdict !== null,
            render: () =>
                shipVerdict === null ? null : (
                    <ShipVerdictBanner
                        event={shipVerdict}
                        now={shipVerdictNow}
                        onDismiss={() => {
                            setShipVerdict(null);
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

    /**
     * Code shows notes for this iteration, using its anchors and excluding lost anchors (M4-T11).
     * A slice has no code notes. Their anchors use iteration `fileId` values, while a slice has its own.
     */
    const notesInCode = useMemo(
        () => (sliceBase === null ? notesForIteration(chatData.notes, notesDiffId) : EMPTY_NOTES),
        [chatData.notes, notesDiffId, sliceBase],
    );
    const isSelectionPending = useCallback(
        (anchor: UiChatAskAnchor | null): boolean =>
            anchor !== null &&
            chatData.exchanges.some(
                (exchange) =>
                    (exchange.status === 'queued' || exchange.status === 'running') &&
                    sameChatAnchor(exchange.anchor, anchor),
            ),
        [chatData.exchanges],
    );
    const selectChatAnchor = useCallback(
        (anchor: UiChatAskAnchor | null) => {
            setChatComposerContext((current) => {
                const next = current.key === chatKey ? current : { key: chatKey, anchor: null, latched: false };
                return next.latched ? next : { ...next, anchor };
            });
        },
        [chatKey],
    );
    /**
     * Shared chat entry point: save the anchor and prefill the question without sending it. The reviewer presses ⏎
     * (README §2, §10). Without text, this simply opens the panel for the selection.
     */
    const openChatWithQuestion = useCallback(
        (text: string | null, anchor: UiChatAskAnchor | null) => {
            setChatComposerContext({ key: chatKey, anchor, latched: anchor !== null });
            session.setChatOpen(true);
            if (text !== null) {
                chatPrefillRequestId.current += 1;
                setChatPrefillRequest({ id: chatPrefillRequestId.current, text });
            }
            setChatFocusRequest((request) => request + 1);
        },
        [chatKey, session],
    );
    const openChatForSelection = useCallback(
        (anchor: UiChatAskAnchor) => {
            openChatWithQuestion(null, anchor);
        },
        [openChatWithQuestion],
    );
    /** "Other" on the Route: many ranges, but one question anchor, so the ranges are listed in the text. */
    const composeRouteQuestion = useCallback(
        (text: string) => {
            openChatWithQuestion(text, null);
        },
        [openChatWithQuestion],
    );
    /** Full diff hatch band: the anchor matches its exact range. */
    const composeDiffQuestion = useCallback(
        (text: string, anchor?: UiChatAskAnchor) => {
            openChatWithQuestion(text, anchor ?? null);
        },
        [openChatWithQuestion],
    );
    const closeChat = useCallback(() => {
        setChatScrollRequest(null);
        // The prefill lasts only while the panel is open. Otherwise reopening chat would overwrite
        // the composer with a question the reviewer has already seen.
        setChatPrefillRequest(null);
        session.setChatOpen(false);
    }, [session]);
    const toggleChat = useCallback(
        (target: ChatScrollTarget | null) => {
            if (session.getSnapshot().chatOpen) {
                closeChat();
                return;
            }
            session.setChatOpen(true);
            if (target === null) {
                setChatScrollRequest(null);
                return;
            }
            chatScrollRequestId.current += 1;
            setChatScrollRequest({ id: chatScrollRequestId.current, target });
        },
        [closeChat, session],
    );
    const handleChatScrollRequest = useCallback((id: number) => {
        setChatScrollRequest((current) => (current?.id === id ? null : current));
    }, []);
    const askChat = useCallback(
        async (text: string, anchor?: UiChatAskAnchor) => {
            const exchange = await askReviewChat(token, text, anchor);
            setChatState((current) => {
                const next = chatStateForKey(current, chatKey);
                const data = next.data ?? EMPTY_CHAT_RESPONSE;
                return {
                    key: chatKey,
                    error: null,
                    loading: false,
                    data: {
                        ...data,
                        exchanges: [...data.exchanges.filter((candidate) => candidate.id !== exchange.id), exchange],
                    },
                };
            });
            return exchange;
        },
        [chatKey, token],
    );
    const cancelChat = useCallback(
        async (exchangeId: number): Promise<void> => {
            if ((await cancelReviewChat(token, exchangeId)) !== 'cancelled') {
                return;
            }
            setChatState((current) => updateChatExchange(current, chatKey, exchangeId, 'cancelled'));
        },
        [chatKey, token],
    );
    const retryChat = useCallback(
        async (exchangeId: number): Promise<void> => {
            if ((await retryReviewChat(token, exchangeId)) !== 'retried') {
                return;
            }
            setChatState((current) => updateChatExchange(current, chatKey, exchangeId, 'queued'));
        },
        [chatKey, token],
    );
    const deleteNote = useCallback(
        async (noteId: number): Promise<void> => {
            const pending =
                pendingNoteDeletions.current.key === chatKey
                    ? pendingNoteDeletions.current
                    : { key: chatKey, ids: new Set<number>() };
            pendingNoteDeletions.current = pending;
            if (pending.ids.has(noteId)) {
                return;
            }
            pending.ids.add(noteId);
            const removed = chatData.notes.find((note) => note.id === noteId) ?? null;
            setChatState((current) => {
                const next = chatStateForKey(current, chatKey);
                return next.data === null ? next : { ...next, data: withoutChatNote(next.data, noteId) };
            });
            try {
                await deleteReviewChatNote(token, noteId);
                pending.ids.delete(noteId);
            } catch (error) {
                pending.ids.delete(noteId);
                if (removed !== null) {
                    setChatState((current) => {
                        const next = chatStateForKey(current, chatKey);
                        const data = next.data ?? EMPTY_CHAT_RESPONSE;
                        return data.notes.some((note) => note.id === removed.id)
                            ? next
                            : { ...next, data: { ...data, notes: [...data.notes, removed] } };
                    });
                }
                throw error;
            }
        },
        [chatData.notes, chatKey, token],
    );
    const navigateChatAnchor = useCallback(
        (anchor: ChatAnchor) => {
            window.location.hash = selectionLinkHash(window.location.hash, anchor);
            setChatAnchorNavigationRequest((request) => request + 1);
            if (view !== 'route' && view !== 'diff') {
                session.setView('diff');
            }
        },
        [session, view],
    );
    const navigateToNote = useCallback(
        (note: AgentNote) => {
            // A note with a lost anchor is absent from this iteration's code, so there is nowhere to navigate.
            if (!noteVisibleInIteration(note, notesDiffId)) {
                return;
            }
            session.expandNote(note.id);
            navigateChatAnchor(noteAnchorForIteration(note, notesDiffId));
            noteFocusRequestId.current += 1;
            setNoteFocusRequest({ id: noteFocusRequestId.current, noteId: note.id });
        },
        [navigateChatAnchor, notesDiffId, session],
    );
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
    const threadPin = useMemo<ThreadPinContextValue>(
        () => ({ activeDiffId, viewingDiffId: currentDiff?.diffId ?? null, openAtPin: openThreadAtIteration }),
        [activeDiffId, currentDiff, openThreadAtIteration],
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
        <ReadOnlyIterationProvider
            readOnly={readOnly}
            {...(sliceBase === null ? {} : { reason: SLICE_READ_ONLY_REASON })}
        >
            <ThreadPinProvider value={threadPin}>
            <TopBar
                version={UI_VERSION}
                breadcrumb={breadcrumbFor(state.prKey, state.pr)}
                agent={agentPillView(state.worker, state.tasks)}
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
                    <div className="connection-banner__title">Server unavailable, reconnecting…</div>
                    <p>This is the last known state. It will update automatically when the connection returns.</p>
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
                </div>
                {chatOpen ? (
                    <>
                        <button
                            type="button"
                            className="chat-panel-scrim"
                            aria-label="Close chat"
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

            <CommandPalette
                open={paletteOpen}
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
                        draftBuffer={draftBuffer}
                        onPublish={publishHere}
                        onComplete={completeReview}
                        chatOpen={chatOpen}
                    />
                ) : (
                    <ReviewActionBarLoading diffError={currentReview.diffError} />
                )
            ) : null}
            </ThreadPinProvider>
        </ReadOnlyIterationProvider>
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

const EMPTY_CHAT_RESPONSE: UiChatResponse = { exchanges: [], notes: [], chatRevision: 0 };

function emptyChatState(key: string, loading: boolean): ChatState {
    return { key, data: null, error: null, loading };
}

function chatStateForKey(current: ChatState, key: string): ChatState {
    return current.key === key ? current : emptyChatState(key, true);
}

export function mergeChatResponse(
    server: UiChatResponse,
    local: UiChatResponse | null,
    pendingNoteDeletions: ReadonlySet<number> = EMPTY_NOTE_DELETIONS,
): UiChatResponse {
    const notes = server.notes.filter((note) => !pendingNoteDeletions.has(note.id));
    if (local === null) {
        return { ...server, notes };
    }
    const exchanges = new Map(server.exchanges.map((exchange) => [exchange.id, exchange]));
    for (const exchange of local.exchanges) {
        const fromServer = exchanges.get(exchange.id);
        if (fromServer === undefined || Date.parse(exchange.updatedAt) > Date.parse(fromServer.updatedAt)) {
            exchanges.set(exchange.id, exchange);
        }
    }
    return { ...server, notes, exchanges: [...exchanges.values()] };
}

export function withoutChatNote(data: UiChatResponse, noteId: number): UiChatResponse {
    return { ...data, notes: data.notes.filter((note) => note.id !== noteId) };
}

function updateChatExchange(
    current: ChatState,
    key: string,
    exchangeId: number,
    status: UiChatResponse['exchanges'][number]['status'],
): ChatState {
    const next = chatStateForKey(current, key);
    const data = next.data ?? EMPTY_CHAT_RESPONSE;
    return {
        ...next,
        data: {
            ...data,
            exchanges: data.exchanges.map((exchange) =>
                exchange.id === exchangeId
                    ? {
                          ...exchange,
                          status,
                          answer: status === 'done' ? exchange.answer : null,
                          progressText: null,
                          error: null,
                          updatedAt: new Date().toISOString(),
                      }
                    : exchange,
            ),
        },
    };
}

const EMPTY_SLICE_LENSES: UiReviewLensesResponse = { ownership: null, extra: [] };
const EMPTY_SLICE_PROGRESS: UiReviewProgressResponse = { files: [], stops: [], progressRevision: 0 };

/**
 * Tab state in a slice: lenses, progress and threads are replaced with empty values. Their endpoints
 * are never called because this data refers to iteration `fileId` values that a slice does not have.
 */
function sliceReviewState(current: ReviewState): ReviewState {
    return {
        ...current,
        lenses: EMPTY_SLICE_LENSES,
        lensesError: null,
        lensesLoading: false,
        progress: EMPTY_SLICE_PROGRESS,
        progressError: null,
        progressLoading: false,
        threads: EMPTY_THREADS,
        threadsError: null,
        threadsLoading: false,
    };
}

function emptyReviewState(key: string, viewKey: string, loading: boolean): ReviewState {
    return {
        key,
        viewKey,
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

/**
 * Changing the PR or host resets everything. Changing the selected iteration resets only the diff, progress and route:
 * threads and lenses belong to the host and are shared across the PR. Old data never appears as new data.
 * The view receives a loading skeleton (SPEC §3).
 */
/**
 * PR-wide layers (lenses, threads) do not depend on the selected iteration and must not overwrite
 * `viewKey`. A response that lags behind a selection change could roll back an already loaded diff.
 */
function sharedReviewState(current: ReviewState, key: string, viewKey: string): ReviewState {
    return current.key === key ? current : emptyReviewState(key, viewKey, true);
}

function reviewStateForKeys(current: ReviewState, key: string, viewKey: string): ReviewState {
    if (current.key !== key) {
        return emptyReviewState(key, viewKey, true);
    }
    if (current.viewKey === viewKey) {
        return current;
    }
    return {
        ...current,
        viewKey,
        diff: null,
        progress: null,
        route: null,
        diffError: null,
        progressError: null,
        routeError: null,
        diffLoading: true,
        progressLoading: true,
        routeLoading: true,
    };
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

function emptySnapshots(key: string): SnapshotsState {
    return { key, list: null, loaded: false };
}

function emptyActiveFacts(key: string): ActiveFacts {
    return { key, diffId: null, commit: null, snapshot: null, routeSettled: false };
}

const EMPTY_THREADS: readonly Thread[] = [];
const EMPTY_DRAFT_BUFFER: readonly DraftBufferEntry[] = [];
const EMPTY_NOTES: readonly AgentNote[] = [];
const EMPTY_ITERATIONS: readonly Iteration[] = [];
const EMPTY_TASKS: readonly UiTask[] = [];
const EMPTY_NOTE_DELETIONS: ReadonlySet<number> = new Set();
/** How long to wait for a note after navigation. The virtualizer and route take time to render cards. */
const NOTE_FOCUS_SEARCH_MS = 3000;
/** How often to recalculate "Still working". The threshold is coarse, so second-level precision is unnecessary. */
const LONG_GENERATION_TICK = 5000;
