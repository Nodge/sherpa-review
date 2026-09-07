import type {
    AgentNote,
    FileContent,
    FileDiff,
    PrDiff,
    PrMeta,
    RouteSnapshot,
    RouteTier,
    UiChatAskAnchor,
    UiGenerationCap,
    UiReviewLensesResponse,
    UiStopSeenRange,
} from '@sherpa/protocol';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { PrHeader, prHeaderCounts } from '../../components/pr-header.tsx';
import { chatAnchorFromSelection, SelectionPopover } from '../../components/selection-popover.tsx';
import type { DiffFileModel } from '../../diff/model.js';
import type { Feedback } from '../../diff-view/file-card.tsx';
import type { DiffViewStore } from '../../diff-view/store.js';
import { useSelectionLifecycle } from '../../diff-view/use-selection.js';
import '../../diff-view/diff-view.css';
import { useT } from '../../i18n/index.js';
import { useReadOnlyIteration } from '../../iterations/read-only.tsx';
import { SnapshotPill } from '../../iterations/snapshot-picker.tsx';
import type { ViewingLabel } from '../../iterations/viewing.js';
import {
    ALL_FILTER_ID,
    buildFileFilters,
    findFilter,
    PCI_FILTER_ID,
    selectFilter,
    zeroResultText,
} from '../../filters/lens-filters.js';
import { useTurnNoteIntoDraft } from '../../notes/use-note-draft.js';
import { createProgressWriter } from '../../progress/progress-writer.js';
import type { ProgressWriter } from '../../progress/progress-writer.js';
import { readStateOf } from '../../progress/read-state.js';
import type { StopProgressStore } from '../../progress/stop-progress-store.js';
import { createStopProgressStore } from '../../progress/stop-progress-store.js';
import { buildCoverageStrip } from '../../route/coverage-model.js';
import type { RouteEntry, RouteFileGroup, RouteStopView } from '../../route/route-model.js';
import { generationProgress, snapshotFilling } from '../../route/generation.js';
import type { RouteSummary } from '../../route/route-summary.js';
import {
    buildRouteModel,
    changeFilterAvailable,
    countStopComments,
    entryMatchesChangeFilter,
    otherMatchesFilter,
    stopMatchesFilter,
} from '../../route/route-model.js';
import type { SessionStore } from '../../session/session-store.js';
import { createThreadActions } from '../../threads/actions.js';
import type { ComposerTransport } from '../../threads/composer.js';
import { countThreadSources } from '../../threads/model.js';
import type { ThreadStore } from '../../threads/store.js';
import { OutsideThreads } from '../../threads/thread-list.tsx';
import type { ThreadActions } from '../../threads/thread-list.tsx';
import { CoverageStrip } from './coverage-strip.tsx';
import { OtherSection } from './other-section.tsx';
import { RouteToolbar } from './route-toolbar.tsx';
import { stopChangeThreads } from './stop-card.tsx';
import { entryId } from './stop-lookup.js';
import { collapsedStopShown, StopSection } from './stop-section.tsx';
import { useRouteJump } from './use-route-jump.js';
import { useRouteParse } from './use-route-parse.js';
import { useRouteReveal } from './use-route-reveal.js';
import { useRouteShortcuts } from './use-route-shortcuts.js';
import { useStopCards } from './use-stop-cards.tsx';
import { useStopViewed } from './use-stop-viewed.js';
import './route.css';

/**
 * Rendering half of the Route view. Plain props let it render in the state
 * gallery too. It only holds the route model, lenses and markup, and delegates work to hooks:
 * `use-route-parse` (patch parsing), `use-route-jump` (scrolling and anchors), `use-route-reveal`
 * (making the jump target visible), `use-stop-viewed` (stop viewed marks), `use-stop-cards`
 * (file cards and focus) and `use-route-shortcuts` (keys). Calls follow the order of
 * the former single component, which determines the order of effects and command registration.
 */

export interface RouteWorkspaceProps {
    readonly pr: PrMeta;
    readonly diff: PrDiff;
    readonly lenses: UiReviewLensesResponse;
    readonly snapshot: RouteSnapshot;
    /** Agent disconnected during generation: filled stops get a note (SPEC §4.4). */
    readonly agentStopped?: boolean;
    readonly session: SessionStore;
    readonly store: DiffViewStore;
    readonly threadStore: ThreadStore;
    /** The app creates the writer and viewed store one level up. The gallery's workspace creates its own. */
    readonly progressWriter?: ProgressWriter;
    readonly stopProgress?: StopProgressStore;
    /** The first server progress snapshot has been applied. A standalone workspace starts ready. */
    readonly progressLoaded?: boolean;
    /** Initial stop marks for the gallery and tests (the server supplies them in the app). */
    readonly initialStopViewed?: readonly string[];
    readonly onSetViewed?: (fileId: string, viewed: boolean) => Promise<number>;
    readonly onSetStopViewed?: (
        stopId: string,
        viewed: boolean,
        ranges: readonly UiStopSeenRange[],
    ) => Promise<number>;
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    readonly threadTransport?: ComposerTransport;
    readonly onResolveThread?: (threadId: string, resolved: boolean) => Promise<void>;
    /** Fixed clock for the gallery. The application captures the time when the view mounts. */
    readonly threadNow?: number;
    readonly navigation?: { readonly id: number; readonly stopId: string } | null;
    readonly initialSelectionTarget?: { readonly fileId: string; readonly side: 'old' | 'new'; readonly start: number } | null;
    readonly selectionNavigationRequest?: number;
    readonly agentConnected?: boolean;
    readonly onAskSelection?: (anchor: UiChatAskAnchor) => void;
    readonly isSelectionPending?: (anchor: UiChatAskAnchor | null) => boolean;
    readonly onSelectionAnchorChange?: (anchor: UiChatAskAnchor | null) => void;
    /** See `RouteViewProps.onComposeQuestion`. Without it, Other has no button to place ranges. */
    readonly onComposeQuestion?: (text: string) => void;
    readonly notes?: readonly AgentNote[];
    readonly onOpenNoteInChat?: (note: AgentNote) => void;
    readonly onDeleteNote?: (noteId: number) => Promise<void>;
    readonly onUnderExplained?: (value: boolean) => void;
    readonly onFillStop?: (planIndex: number) => void;
    readonly onRouteSummary?: (summary: RouteSummary) => void;
    /** Initial "kept on screen" state lets the gallery show the filter state without a click. */
    readonly initialKeptStopId?: string | null;
    /** Open a thread by id: links from "why this stop changed" (README §1 item 4). */
    readonly onOpenThread?: (threadId: string) => void;
    /** Right edge of the header: the snapshot picker from App, or a static snapshot pill without it. */
    readonly headerAside?: ReactNode;
    /** See `RouteViewProps.generationCap`. */
    readonly generationCap?: UiGenerationCap | null;
}

export function RouteWorkspace(props: RouteWorkspaceProps) {
    const t = useT();
    const {
        pr,
        diff,
        lenses,
        snapshot,
        agentStopped = false,
        session,
        store,
        threadStore,
        parse,
        loadContent,
        onSetViewed = EMPTY_SET_VIEWED,
        onSetStopViewed = EMPTY_SET_STOP_VIEWED,
        progressLoaded = true,
        navigation = null,
        initialSelectionTarget = null,
        selectionNavigationRequest = 0,
        agentConnected = false,
        onAskSelection = EMPTY_ASK_SELECTION,
        isSelectionPending = NO_SELECTION_PENDING,
        onSelectionAnchorChange = NO_SELECTION_ANCHOR_CHANGE,
        onComposeQuestion,
        notes = EMPTY_NOTES,
        onOpenNoteInChat = EMPTY_OPEN_NOTE,
        onDeleteNote = EMPTY_DELETE_NOTE,
        onUnderExplained,
        onFillStop,
        onRouteSummary,
        onOpenThread,
    } = props;
    // A previous iteration is read-only. Viewed marks and stop filling are unavailable (M4 scope).
    const readOnly = useReadOnlyIteration();
    const [threadNow] = useState(() => props.threadNow ?? Date.now());
    // The third argument is the same snapshot. Stores are isomorphic, and tests render the view statically.
    const diffSnapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const threadSnapshot = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot, threadStore.getSnapshot);
    const composersSnapshot = useSyncExternalStore(
        threadStore.subscribeComposers,
        threadStore.getComposersSnapshot,
        threadStore.getComposersSnapshot,
    );
    const {
        filter: filterId,
        preset,
        routeFilter,
        threadsShow,
        stops: stopState,
    } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

    const threadsById = useMemo(
        () => new Map(threadSnapshot.threads.map((thread) => [thread.id, thread])),
        [threadSnapshot.threads],
    );

    const threadTransport = props.threadTransport ?? EMPTY_THREAD_TRANSPORT;
    const resolveThread = props.onResolveThread ?? EMPTY_RESOLVE;
    const threadActions = useMemo<ThreadActions>(
        () => createThreadActions(threadStore, threadTransport, resolveThread),
        [resolveThread, threadStore, threadTransport],
    );
    const turnNoteIntoDraft = useTurnNoteIntoDraft({
        threadStore,
        clearSelection: store.clearSelection,
        commentIssues: pr.capabilities.commentIssues,
    });
    const noteActions = useMemo(
        () => ({ onOpenInChat: onOpenNoteInChat, onTurnIntoDraft: turnNoteIntoDraft, onDelete: onDeleteNote }),
        [onDeleteNote, onOpenNoteInChat, turnNoteIntoDraft],
    );
    const notesByFile = useMemo(() => {
        const grouped = new Map<string, AgentNote[]>();
        for (const note of notes) {
            const bucket = grouped.get(note.anchor.fileId);
            if (bucket === undefined) {
                grouped.set(note.anchor.fileId, [note]);
            } else {
                bucket.push(note);
            }
        }
        return grouped;
    }, [notes]);

    const initialStopViewed = props.initialStopViewed;
    const createdStopProgress = useMemo(
        () =>
            createStopProgressStore(
                (initialStopViewed ?? []).map((stopId) => ({ stopId, viewed: true })),
            ),
        [initialStopViewed],
    );
    const stopProgress = props.stopProgress ?? createdStopProgress;
    const stopViewed = useSyncExternalStore(
        stopProgress.subscribe,
        stopProgress.getSnapshot,
        stopProgress.getSnapshot,
    );

    const createdWriter = useMemo(
        () =>
            createProgressWriter({
                initialRevision: 0,
                read: (fileId) => store.getSnapshot().progress.get(fileId) ?? null,
                apply: store.markViewed,
                restore: store.restoreProgress,
                send: onSetViewed,
                stops: {
                    read: (stopId) => stopProgress.getSnapshot().get(stopId) ?? null,
                    apply: stopProgress.setViewed,
                    restore: stopProgress.restore,
                    send: onSetStopViewed,
                },
                // App handles progress refreshes over SSE. A standalone workspace (gallery) does not.
                onSettled: () => undefined,
            }),
        [onSetStopViewed, onSetViewed, stopProgress, store],
    );
    const writer = props.progressWriter ?? createdWriter;
    const markViewed = useCallback(
        async function mark(fileId: string, viewed: boolean): Promise<Feedback> {
            if (await writer.write(fileId, viewed)) {
                return null;
            }
            return { text: t('route.stop.notSaved'), retry: () => mark(fileId, viewed) };
        },
        [t, writer],
    );

    const filters = useMemo(
        () => buildFileFilters({ files: diff.files, ownership: lenses.ownership, extra: lenses.extra, t }),
        [diff.files, lenses, t],
    );
    const filter = selectFilter(filters, filterId);
    const pci = findFilter(filters, PCI_FILTER_ID);

    const { parseErrors, failedFiles, requestParse, retryParse, retryFailed, expand } = useRouteParse({
        files: diff.files,
        store,
        parse,
        loadContent,
        contentAvailable: pr.capabilities.fileContent,
    });

    const model = useMemo(
        () =>
            buildRouteModel({
                snapshot,
                files: diff.files,
                models: diffSnapshot.models,
                failed: failedFiles,
                preset,
                filling: snapshotFilling(snapshot),
            }),
        [diff.files, diffSnapshot.models, failedFiles, preset, snapshot],
    );
    // The route is still being built. The snapshot's slot statuses carry the phase.
    const filling = useMemo(() => snapshotFilling(snapshot), [snapshot]);
    const progress = useMemo(() => generationProgress(snapshot), [snapshot]);
    const stopIdsKey = useMemo(() => model.entries.map(entryId).join(' '), [model.entries]);
    const otherStopId = useMemo(
        () => model.entries.find((entry) => entry.kind === 'other')?.view.stop.id ?? null,
        [model.entries],
    );
    const uncoveredLines = model.totals.uncovered;
    // While any file remains unparsed, uncovered ranges are unknown. The bar and exposed counts
    // wait for parsing, or the guardrail and review summary would record a temporary "100% explained".
    const settled = model.totals.pendingFiles === 0;
    // The action bar and review summary need route counts, which can only be calculated here:
    // uncovered lines are known only from parsed diff models.
    useEffect(() => {
        if (!settled) {
            return;
        }
        onRouteSummary?.({
            stopIds: stopIdsKey === '' ? [] : stopIdsKey.split(' '),
            otherStopId,
            uncoveredLines,
        });
    }, [onRouteSummary, otherStopId, settled, stopIdsKey, uncoveredLines]);

    const underExplained = model.promoted;
    useEffect(() => {
        onUnderExplained?.(underExplained);
        // App shows the banner, but only the view knows about it. The view must clear it on leaving,
        // or it would stay above the invitation after the phase or review changes.
        return () => {
            onUnderExplained?.(false);
        };
    }, [onUnderExplained, underExplained]);

    // Cards start line selection, and the window ends it. Same hook as in the full diff.
    useSelectionLifecycle(store);

    const {
        containerRef,
        setContainer,
        popoverHost,
        settling,
        topStopRef,
        keyboardStopRef,
        flashStopId,
        jumpStopId,
        updateTopStop,
        requestJump,
    } = useRouteJump(preset);
    const [keptStopId, setKeptStopId] = useState<string | null>(props.initialKeptStopId ?? null);
    const [otherOpen, setOtherOpen] = useState(false);
    /** Toolbar measurement: the sticky column offset uses the `route.css` fallback until the first measurement. */
    const [toolbarHeight, setToolbarHeight] = useState<number | null>(null);
    const [openedCollapsed, setOpenedCollapsed] = useState<ReadonlySet<string>>(new Set());

    const matches = useCallback(
        (entry: RouteEntry, ids: ReadonlySet<string> | null): boolean =>
            entry.kind === 'stop' ? stopMatchesFilter(entry.view, ids) : otherMatchesFilter(entry.view, ids),
        [],
    );
    /**
     * "What is new since the last pass" filter (README §9). Invalid when there are no classified
     * stops: the route stays intact, no chip appears, and no value enters the URL.
     */
    const changeFilterOn = routeFilter === 'new' && changeFilterAvailable(model.entries);
    const shown = useMemo(
        () =>
            model.entries.filter(
                (entry) =>
                    (entryMatchesChangeFilter(entry, changeFilterOn) && matches(entry, filter.fileIds)) ||
                    entryId(entry) === keptStopId,
            ),
        [changeFilterOn, filter.fileIds, keptStopId, matches, model.entries],
    );

    const handleScroll = useCallback(() => {
        // Reviewer scrolling clears "kept on screen", but our own scroll correction does not.
        if (settling.current === 0) {
            setKeptStopId(null);
            keyboardStopRef.current = null;
        }
        updateTopStop();
    }, [keyboardStopRef, settling, updateTopStop]);

    const changeFilter = useCallback(
        (id: string) => {
            const next = selectFilter(filters, id);
            if (next.id === filter.id) {
                return;
            }
            const top = topStopRef.current?.stopId ?? null;
            const entry = model.entries.find((candidate) => entryId(candidate) === top) ?? null;
            setKeptStopId(entry !== null && !matches(entry, next.fileIds) ? entryId(entry) : null);
            session.setFilter(next.id);
        },
        [filter.id, filters, matches, model.entries, session, topStopRef],
    );

    const { expandStop, openFile, anchorReachable, openAnchor } = useRouteReveal({
        model,
        fileIds: filter.fileIds,
        matches,
        session,
        store,
        stopProgress,
        setOtherOpen,
        openedCollapsed,
        setOpenedCollapsed,
        expand,
        requestJump,
        initialSelectionTarget,
        selectionNavigationRequest,
    });

    // Filter changes need the top stop even before the first scroll (SPEC §2.7).
    useEffect(() => {
        updateTopStop();
    }, [shown, updateTopStop]);

    // Capture the preset-change anchor at the switch, while the DOM still has the old
    // order. The store subscription runs before rerendering. A scroll event would be too late
    // because it only arrives when the browser paints a frame (background tabs have none).
    useEffect(() => {
        let last = session.getSnapshot().preset;
        return session.subscribe(() => {
            const next = session.getSnapshot().preset;
            if (next !== last) {
                last = next;
                updateTopStop();
            }
        });
    }, [session, updateTopStop]);

    /**
     * The "what is new" filter changes outside the view, through the second-pass banner button and chip,
     * so the same store subscription detects it before rerendering, while the DOM
     * still has the old set of stops. As with the file filter, the view keeps the top stop
     * on screen even when the new filter would hide it (SPEC §2.7).
     */
    useEffect(() => {
        let last = session.getSnapshot().routeFilter;
        return session.subscribe(() => {
            const next = session.getSnapshot().routeFilter;
            if (next === last) {
                return;
            }
            last = next;
            updateTopStop();
            const top = topStopRef.current?.stopId ?? null;
            const entry = model.entries.find((candidate) => entryId(candidate) === top) ?? null;
            const nextChangeOn = next === 'new' && changeFilterAvailable(model.entries);
            const shownNext =
                entry !== null && entryMatchesChangeFilter(entry, nextChangeOn) && matches(entry, filter.fileIds);
            setKeptStopId(entry === null || shownNext ? null : entryId(entry));
        });
    }, [filter.fileIds, matches, model.entries, session, topStopRef, updateTopStop]);

    const handledNavigation = useRef<number | null>(null);
    useEffect(() => {
        if (navigation === null || handledNavigation.current === navigation.id) {
            return;
        }
        handledNavigation.current = navigation.id;
        // The filter may have hidden the stop. Showing it is part of the jump.
        const entry = model.entries.find((candidate) => entryId(candidate) === navigation.stopId) ?? null;
        if (entry !== null && !matches(entry, filter.fileIds)) {
            session.setFilter(ALL_FILTER_ID);
        }
        requestJump(navigation.stopId, null);
    }, [filter.fileIds, matches, model.entries, navigation, requestJump, session]);

    /** Jump to a stop from the coverage bar. Restore it on screen first if a filter hides it. */
    const jumpToStop = useCallback(
        (stopId: string) => {
            const entry = model.entries.find((candidate) => entryId(candidate) === stopId) ?? null;
            if (entry !== null && !matches(entry, filter.fileIds)) {
                session.setFilter(ALL_FILTER_ID);
            }
            requestJump(stopId, null);
        },
        [filter.fileIds, matches, model.entries, requestJump, session],
    );

    const { markStop, stopFailures, announcement, unfilledEntry, viewedStops } = useStopViewed({
        model,
        filling,
        stopViewed,
        fileIds: filter.fileIds,
        matches,
        session,
        stopProgress,
        writer,
        progressLoaded,
        diffSnapshot,
        requestJump,
    });

    /** Whether the stop is collapsed by a viewed mark, manual `x` collapse or the low-tier default. */
    const collapsedOf = useCallback(
        (view: RouteStopView): boolean => {
            const id = view.stop.id;
            if (stopViewed.get(id) === true) {
                return !stopState.expandedViewed.has(id);
            }
            return stopState.collapsed.has(id) || (view.stop.tier === 'low' && !stopState.expanded.has(id));
        },
        [stopState, stopViewed],
    );
    const toggleCollapse = useCallback(
        (entry: RouteEntry) => {
            const stopId = entryId(entry);
            if (entry.kind === 'other') {
                setOtherOpen((open) => !open);
                return;
            }
            if (!collapsedOf(entry.view)) {
                if (stopViewed.get(stopId) === true) {
                    session.setViewedStopExpanded(stopId, false);
                } else if (entry.view.stop.tier === 'low') {
                    session.setStopExpanded(stopId, false);
                } else {
                    session.setStopCollapsed(stopId, true);
                }
                return;
            }
            expandStop(stopId);
        },
        [collapsedOf, expandStop, session, stopViewed],
    );

    // --- Coverage strip (SPEC §2.4) ---

    const coverage = useMemo(
        () => buildCoverageStrip({ totals: model.totals, entries: model.entries, t }),
        [model.entries, model.totals, t],
    );
    const [hoverTier, setHoverTier] = useState<RouteTier | null>(null);
    const markedStops = useMemo<ReadonlySet<string>>(
        () =>
            new Set(
                hoverTier === null
                    ? []
                    : (coverage.segments.find((segment) => segment.tier === hoverTier)?.stopIds ?? []),
            ),
        [coverage.segments, hoverTier],
    );

    const [selectionCard, setSelectionCard] = useState<{ readonly stopId: string; readonly group: RouteFileGroup } | null>(
        null,
    );
    useEffect(() => {
        if (diffSnapshot.selection === null) {
            setSelectionCard(null);
        }
    }, [diffSnapshot.selection]);

    const {
        cardFor,
        busyFileIds,
        stopLayoutKey,
        commentLine,
        focusedLine,
        focusedThreadId,
        selectedShownModel,
        threadVisible,
        visibleByFile,
        iterationLayout,
    } = useStopCards({
        files: diff.files,
        capabilities: pr.capabilities,
        session,
        store,
        threadStore,
        threadActions,
        threadNow,
        diffSnapshot,
        threadSnapshot,
        composersSnapshot,
        threadsShow,
        preset,
        noteActions,
        notesByFile,
        parseErrors,
        openedCollapsed,
        setOpenedCollapsed,
        containerRef,
        selectionCard,
        setSelectionCard,
        expand,
        retryParse,
        markViewed,
        requestJump,
    });

    useRouteShortcuts({
        model,
        shown,
        readOnly,
        stopProgress,
        unfilledEntry,
        markStop,
        toggleCollapse,
        focusedLine,
        focusedThreadId,
        threads: threadSnapshot.threads,
        threadStore,
        commentLine,
        session,
        changeFilterOn,
        keyboardStopRef,
        topStopRef,
        jumpToStop,
        diffSnapshot,
        openedCollapsed,
        expand,
    });

    /** First planned stop. Its diff column stays in the DOM as the entry point and onboarding tour anchor. */
    const firstStopId = shown.find((entry) => entry.kind === 'stop')?.view.stop.id ?? null;
    /**
     * The first low-stop fold anchors tour step 02 (M5-T8). Selection follows the
     * rendering conditions: viewed stops show a summary row, unfilled stops a skeleton, and stops
     * with drift or no files have their own row. Otherwise the anchor would go to a stop that does not
     * render a fold, and the step would needlessly use fallback placement despite real folds below.
     */
    const tourFoldStopId = useMemo(
        () =>
            shown.find(
                (entry) =>
                    entry.kind === 'stop' &&
                    entry.view.stop.tier === 'low' &&
                    stopViewed.get(entry.view.stop.id) !== true &&
                    collapsedOf(entry.view) &&
                    collapsedStopShown(entry.view, entryId(entry) === keptStopId ? null : filter.fileIds),
            )?.view.stop.id ?? null,
        [collapsedOf, filter.fileIds, keptStopId, shown, stopViewed],
    );

    const outsideThreads = threadSnapshot.outside.filter(
        (thread) => threadSnapshot.keptVisible.has(thread.id) || threadVisible(thread),
    );
    const selectedFile =
        diffSnapshot.selection === null
            ? null
            : (diff.files.find((file) => file.fileId === diffSnapshot.selection?.fileId) ?? null);
    const selectedModel =
        selectedFile === null
            ? null
            : (selectedShownModel ?? diffSnapshot.models.get(selectedFile.fileId) ?? null);

    return (
        <main
            className="route selection-popover-host"
            id="view-route"
            ref={setContainer}
            onScroll={handleScroll}
            style={
                toolbarHeight === null
                    ? undefined
                    : ({ '--route-toolbar-height': `${String(toolbarHeight)}px` } as CSSProperties)
            }
        >
            <PrHeader
                pr={pr}
                counts={prHeaderCounts(diff)}
                pci={pci?.available === true ? pci : null}
                pciActive={filter.id === PCI_FILTER_ID}
                onTogglePci={() => {
                    changeFilter(filter.id === PCI_FILTER_ID ? ALL_FILTER_ID : PCI_FILTER_ID);
                }}
                aside={props.headerAside ?? <SnapshotPill label={pillLabelOf(snapshot)} />}
            />

            <RouteToolbar
                store={store}
                preset={preset}
                onHeight={setToolbarHeight}
                onPreset={session.setPreset}
                filters={filters}
                filter={filter}
                onFilter={changeFilter}
                threadsShow={threadsShow}
                threadCounts={countThreadSources(threadSnapshot.threads)}
                onThreadsShow={session.setThreadsShow}
                changeFilterOn={changeFilterOn}
                onClearChangeFilter={() => {
                    session.setRouteFilter('all');
                }}
                generationCap={props.generationCap ?? null}
                strip={
                    <CoverageStrip
                        model={settled && !filling ? coverage : null}
                        loading={
                            filling
                                ? { kind: 'plan', ready: progress.ready, total: progress.total }
                                : {
                                      kind: 'diff',
                                      ready: diff.files.length - model.totals.pendingFiles,
                                      total: diff.files.length,
                                  }
                        }
                        viewedStops={viewedStops}
                        totalStops={model.stopCount}
                        onJump={jumpToStop}
                        onHoverTier={setHoverTier}
                    />
                }
            />

            <div className="route__stops">
                {shown.length === 0 ? (
                    <div className="route__zero">
                        <p className="route__zero-text">{zeroResultText(filter, t)}</p>
                        <button
                            type="button"
                            className="route__zero-action"
                            onClick={() => {
                                changeFilter(ALL_FILTER_ID);
                            }}
                        >
                            {t('lens.showAll')}
                        </button>
                    </div>
                ) : null}

                {shown.map((entry) =>
                    entry.kind === 'stop' ? (
                        <StopSection
                            key={entry.view.stop.id}
                            view={entry.view}
                            first={entry.view.stop.id === firstStopId}
                            tourFold={entry.view.stop.id === tourFoldStopId}
                            busyFileIds={busyFileIds}
                            layoutKeyOf={stopLayoutKey}
                            jumping={jumpStopId === entry.view.stop.id}
                            entries={model.entries}
                            stopCount={model.stopCount}
                            comments={countStopComments(entry.view, visibleByFile, iterationLayout)}
                            changeThreads={stopChangeThreads(entry.view.stop.change, threadsById, t)}
                            {...(onOpenThread === undefined ? {} : { onOpenThread })}
                            fileIds={entryId(entry) === keptStopId ? null : filter.fileIds}
                            keptInView={entryId(entry) === keptStopId}
                            viewed={stopViewed.get(entry.view.stop.id) === true}
                            pending={entry.view.pending}
                            parseFailed={entry.view.parseFailed}
                            filledBeforeStop={agentStopped}
                            collapsed={collapsedOf(entry.view)}
                            collapsedManually={stopState.collapsed.has(entry.view.stop.id)}
                            marked={markedStops.has(entry.view.stop.id)}
                            failedViewed={stopFailures.get(entry.view.stop.id) ?? null}
                            flash={flashStopId === entry.view.stop.id}
                            readStateOf={(fileId) =>
                                diffSnapshot.readState.get(fileId) ??
                                readStateOf({
                                    file: diff.files.find((file) => file.fileId === fileId) ?? EMPTY_FILE,
                                    record: null,
                                })
                            }
                            onViewed={(value) => {
                                void markStop(entry.view.stop.id, value);
                            }}
                            {...(onFillStop === undefined || filling ? {} : { onFillStop })}
                            onExpand={() => {
                                expandStop(entry.view.stop.id);
                            }}
                            onOpenFile={openFile}
                            onVisible={requestParse}
                            renderCard={cardFor}
                            testCodeShown={stopState.testCode.has(entry.view.stop.id)}
                            onToggleTestCode={() => {
                                session.setStopTestCode(
                                    entry.view.stop.id,
                                    !stopState.testCode.has(entry.view.stop.id),
                                );
                            }}
                            anchorReachable={(fileId, line) =>
                                anchorReachable(entry.view.stop.id, fileId, line)
                            }
                            onOpenAnchor={(fileId, line) => {
                                openAnchor(entry.view.stop.id, fileId, line);
                            }}
                        />
                    ) : (
                        <OtherSection
                            key={entry.view.stop.id}
                            view={entry.view}
                            stopCount={model.stopCount}
                            pending={model.totals.pendingFiles > 0}
                            parseFailed={model.totals.failedFiles > 0}
                            filling={filling}
                            failedFiles={model.totals.failedFiles}
                            onRetryFailed={retryFailed}
                            agentConnected={agentConnected}
                            {...(onComposeQuestion === undefined ? {} : { onComposeQuestion })}
                            opened={otherOpen}
                            fileIds={entryId(entry) === keptStopId ? null : filter.fileIds}
                            keptInView={entryId(entry) === keptStopId}
                            viewed={stopViewed.get(entry.view.stop.id) === true}
                            marked={markedStops.has(entry.view.stop.id)}
                            failedViewed={stopFailures.get(entry.view.stop.id) ?? null}
                            flash={flashStopId === entry.view.stop.id}
                            onViewed={(value) => {
                                void markStop(entry.view.stop.id, value);
                            }}
                            onOpen={() => {
                                setOtherOpen((open) => !open);
                            }}
                            renderCard={cardFor}
                        />
                    ),
                )}

                {/* Threads outside the diff are the same as in the full diff. They share one list per PR. */}
                <OutsideThreads threads={outsideThreads} store={threadStore} actions={threadActions} now={threadNow} />
            </div>

            {diffSnapshot.selection === null || selectedFile === null || selectedModel === null ? null : (
                <SelectionPopover
                    key={`${diffSnapshot.selection.fileId}:${diffSnapshot.selection.side ?? ''}:${diffSnapshot.selection.anchor}:${diffSnapshot.selection.focus}`}
                    host={popoverHost}
                    diffId={diff.diffId}
                    file={selectedFile}
                    model={selectedModel}
                    selection={diffSnapshot.selection}
                    dragging={diffSnapshot.selectionDragging}
                    agentConnected={agentConnected}
                    inFlight={isSelectionPending(
                        chatAnchorFromSelection(selectedFile, selectedModel, diffSnapshot.selection, diff.diffId),
                    )}
                    onAsk={onAskSelection}
                    onSelectionAnchorChange={onSelectionAnchorChange}
                    onComment={(side, line) => {
                        commentLine(selectedFile.fileId, side, line);
                    }}
                    onClear={store.clearSelection}
                />
            )}

            <span className="visually-hidden" role="status" aria-live="polite">
                {announcement}
            </span>
        </main>
    );
}

/** Pill without a picker: the snapshot on screen is current (gallery, standalone workspace). */
function pillLabelOf(snapshot: RouteSnapshot): ViewingLabel {
    return { kind: 'snapshot', commit: snapshot.commit, status: 'current' };
}

/** Defaults for optional note props, omitted by callers without chat (gallery, tests). */
export const EMPTY_NOTES: readonly AgentNote[] = [];
export const EMPTY_OPEN_NOTE = (): void => undefined;
export const EMPTY_DELETE_NOTE = (): Promise<void> => Promise.reject(new Error('deleting notes is unavailable here'));

const EMPTY_FILE = {
    generated: false,
    viewed: false,
    additions: 0,
    deletions: 0,
} as const;
const EMPTY_THREAD_TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error('writing drafts is unavailable in this state')),
    update: () => Promise.reject(new Error('writing drafts is unavailable in this state')),
    delete: () => Promise.reject(new Error('writing drafts is unavailable in this state')),
};

const EMPTY_RESOLVE = (): Promise<void> => Promise.reject(new Error('resolve is unavailable in this state'));
const EMPTY_SET_VIEWED = (): Promise<number> =>
    Promise.reject(new Error('marking viewed is unavailable in this state'));
const EMPTY_ASK_SELECTION = (): void => undefined;
const NO_SELECTION_PENDING = (): boolean => false;
const NO_SELECTION_ANCHOR_CHANGE = (): void => undefined;
const EMPTY_SET_STOP_VIEWED = (): Promise<number> =>
    Promise.reject(new Error('marking a stop viewed is unavailable in this state'));
