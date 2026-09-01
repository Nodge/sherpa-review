import type {
    FileContent,
    FileDiff,
    PrDiff,
    PrMeta,
    RouteSnapshot,
    RouteTier,
    Thread,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
    UiStopSeenRange,
} from '@sherpa/protocol';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
    deleteReviewDraft,
    fetchFileContent,
    saveReviewDraft,
    setReviewThreadResolved,
    updateReviewDraft,
} from '../../api.js';
import { PrHeader } from '../../components/pr-header.tsx';
import type { DiffClient } from '../../diff/client.js';
import { createDiffClient } from '../../diff/client.js';
import type { DiffFileModel } from '../../diff/model.js';
import { toParseRequest } from '../../diff/model.js';
import type { ContextExpandRequest, ContextExpandResult } from '../../diff-view/context-expansion.js';
import { expandContext } from '../../diff-view/context-expansion.js';
import type { FileExpansion } from '../../diff-view/expand.js';
import type { Feedback, FileCardActions } from '../../diff-view/file-card.tsx';
import { flashRow } from '../../diff-view/line-target.js';
import type { DiffViewStore } from '../../diff-view/store.js';
import { fileCollapseReason } from '../../diff-view/store.js';
import { useSelectionLifecycle } from '../../diff-view/use-selection.js';
import '../../diff-view/diff-view.css';
import { readFragmentParam } from '../../fragment.js';
import {
    ALL_FILTER_ID,
    buildFileFilters,
    findFilter,
    PCI_FILTER_ID,
    selectFilter,
    zeroResultText,
} from '../../filters/lens-filters.js';
import { createProgressWriter } from '../../progress/progress-writer.js';
import type { ProgressWriter } from '../../progress/progress-writer.js';
import { readStateOf } from '../../progress/read-state.js';
import type { StopProgressStore } from '../../progress/stop-progress-store.js';
import { createStopProgressStore } from '../../progress/stop-progress-store.js';
import { buildCoverageStrip } from '../../route/coverage-model.js';
import { buildDigest, buildDigestTestCode, resolveAnchor } from '../../route/digest.js';
import type { RouteEntry, RouteFileGroup, RouteOtherView, RouteStopView } from '../../route/route-model.js';
import { generationProgress, snapshotFilling } from '../../route/generation.js';
import type { RouteSummary } from '../../route/route-summary.js';
import { stopCoveredByProgress } from '../../route/stop-coverage.js';
import {
    buildRouteModel,
    composersForGroup,
    countStopComments,
    entryParseFailed,
    entryPending,
    entryUnfilled,
    filterOtherView,
    lazyCards,
    otherMatchesFilter,
    stopMatchesFilter,
    stopSeenRanges,
    threadsForGroup,
    uncoveredAsGroup,
} from '../../route/route-model.js';
import type { SessionStore } from '../../session/session-store.js';
import { useShortcut } from '../../shortcuts/context.tsx';
import { createThreadActions } from '../../threads/actions.js';
import type { ComposerTransport } from '../../threads/composer.js';
import { countThreadSources, threadIsVisible } from '../../threads/model.js';
import type { ThreadStore } from '../../threads/store.js';
import { openNewComposer, OutsideThreads } from '../../threads/thread-list.tsx';
import type { ThreadActions } from '../../threads/thread-list.tsx';
import { formatCount, plural } from '../../text.js';
import { commentPosition } from '../full-diff.tsx';
import { CoverageStrip } from './coverage-strip.tsx';
import { FileChips } from './file-chips.tsx';
import { OtherCard } from './other-card.tsx';
import { RouteToolbar } from './route-toolbar.tsx';
import type { JumpStep, StopBox } from './scroll.js';
import {
    animateScrollTo,
    cssEscape,
    JUMP_DURATION,
    JUMP_STEPS,
    jumpTarget,
    pickTopStop,
    targetScrollTop,
} from './scroll.js';
import { AnchorDrift, CollapsedStop, EmptyStop, StopCard, StopSkeleton, ViewedSummary } from './stop-card.tsx';
import { StopFileCard } from './stop-file-card.tsx';
import { TestDigest } from './test-digest.tsx';
import { useOnScreen } from './use-on-screen.js';
import './route.css';

/**
 * Route view, triage preset (README §1–2): PR header with a snapshot pill, sticky toolbar
 * and stop grid with a sticky narrative column on the left and the actual diff on the right, clipped to
 * the stop's anchors.
 *
 * Split as in the full diff: `RouteView` holds live endpoints, while `RouteWorkspace` works
 * with plain props, so it can render in the state gallery. Stores (diff, threads, progress)
 * come from App as the same instances used by the full diff. Marks, drafts and diff
 * mode must match across views (brief principle 5).
 */

export interface RouteViewProps {
    readonly token: string;
    readonly session: SessionStore;
    readonly pr: PrMeta | null;
    readonly diff: PrDiff | null;
    readonly diffError: string | null;
    readonly lenses: UiReviewLensesResponse | null;
    readonly lensesError: string | null;
    readonly progress: UiReviewProgressResponse | null;
    readonly progressError: string | null;
    readonly progressWriter: ProgressWriter | null;
    readonly stopProgress: StopProgressStore | null;
    readonly store: DiffViewStore | null;
    readonly threadStore: ThreadStore | null;
    readonly snapshot: RouteSnapshot;
    /** Agent disconnected during generation: filled stops get a note (SPEC §4.4). */
    readonly agentStopped?: boolean;
    /** Palette navigation increments `id`, and the view finishes scrolling to the stop. */
    readonly navigation?: { readonly id: number; readonly stopId: string } | null;
    /** Uncovered fraction exceeds the threshold: App shows "consider regenerating" (SPEC §4.3). */
    readonly onUnderExplained?: (value: boolean) => void;
    readonly onFillStop?: (planIndex: number) => void;
    /** Expose route counts. Only the view computes them, and the action panel and review summary need them. */
    readonly onRouteSummary?: (summary: RouteSummary) => void;
}

export function RouteView({
    token,
    session,
    pr,
    diff,
    diffError,
    lenses,
    lensesError,
    progress,
    progressError,
    progressWriter,
    stopProgress,
    store,
    threadStore,
    snapshot,
    agentStopped = false,
    navigation = null,
    onUnderExplained,
    onFillStop,
    onRouteSummary,
}: RouteViewProps) {
    const clientRef = useRef<DiffClient | null>(null);
    // One worker per view, as in the full diff. Models are cached in the shared store.
    useEffect(
        () => () => {
            clientRef.current?.close();
            clientRef.current = null;
        },
        [],
    );

    const diffId = diff?.diffId ?? null;
    const parse = useCallback(
        (file: FileDiff) => {
            clientRef.current ??= createDiffClient();
            return clientRef.current.parseFile(diffId ?? '', toParseRequest(file));
        },
        [diffId],
    );
    const loadContent = useCallback((fileId: string) => fetchFileContent(token, fileId), [token]);
    const threadTransport = useMemo<ComposerTransport>(
        () => ({
            save: (draft) => saveReviewDraft(token, draft),
            update: (commentId, body, issue) => updateReviewDraft(token, commentId, body, issue),
            delete: (commentId) => deleteReviewDraft(token, commentId),
        }),
        [token],
    );
    const resolveThread = useCallback(
        (threadId: string, resolved: boolean) => setReviewThreadResolved(token, threadId, resolved),
        [token],
    );
    // Two sources of stop navigation: the palette and the `stop` fragment parameter (a link
    // copied from the stop header). One counter lets the view distinguish jumps by increasing id.
    const [target, setTarget] = useState<{ id: number; stopId: string } | null>(null);
    const targetId = useRef(0);
    const jumpTo = useCallback((stopId: string) => {
        targetId.current += 1;
        setTarget({ id: targetId.current, stopId });
    }, []);
    const fragmentStop = useRef<string | null>(null);
    useEffect(() => {
        const read = (): void => {
            const stopId = readFragmentParam(window.location.hash, 'stop');
            if (stopId === null || stopId === fragmentStop.current) {
                return;
            }
            fragmentStop.current = stopId;
            jumpTo(stopId);
        };
        read();
        window.addEventListener('hashchange', read);
        return () => {
            window.removeEventListener('hashchange', read);
        };
    }, [jumpTo]);
    const paletteJump = useRef<number | null>(null);
    useEffect(() => {
        if (navigation === null || paletteJump.current === navigation.id) {
            return;
        }
        paletteJump.current = navigation.id;
        jumpTo(navigation.stopId);
    }, [jumpTo, navigation]);

    if (
        diffError !== null ||
        lensesError !== null ||
        (progress === null && progressError !== null) ||
        pr === null ||
        diff === null ||
        lenses === null ||
        progressWriter === null ||
        stopProgress === null ||
        store === null ||
        threadStore === null
    ) {
        return (
            <main className="route route--status" id="view-route">
                <p className="route__status">{diffError ?? lensesError ?? progressError ?? 'Loading route…'}</p>
            </main>
        );
    }

    return (
        <RouteWorkspace
            pr={pr}
            diff={diff}
            lenses={lenses}
            snapshot={snapshot}
            agentStopped={agentStopped}
            session={session}
            store={store}
            threadStore={threadStore}
            progressWriter={progressWriter}
            stopProgress={stopProgress}
            progressLoaded={progress !== null}
            parse={parse}
            loadContent={loadContent}
            threadTransport={threadTransport}
            onResolveThread={resolveThread}
            navigation={target}
            {...(onUnderExplained === undefined ? {} : { onUnderExplained })}
            {...(onFillStop === undefined ? {} : { onFillStop })}
            {...(onRouteSummary === undefined ? {} : { onRouteSummary })}
        />
    );
}

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
    readonly onUnderExplained?: (value: boolean) => void;
    readonly onFillStop?: (planIndex: number) => void;
    readonly onRouteSummary?: (summary: RouteSummary) => void;
    /** Initial "kept on screen" state lets the gallery show the filter state without a click. */
    readonly initialKeptStopId?: string | null;
}

export function RouteWorkspace(props: RouteWorkspaceProps) {
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
        onUnderExplained,
        onFillStop,
        onRouteSummary,
    } = props;
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
        threadsShow,
        stops: stopState,
    } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

    const threadTransport = props.threadTransport ?? EMPTY_THREAD_TRANSPORT;
    const resolveThread = props.onResolveThread ?? EMPTY_RESOLVE;
    const threadActions = useMemo<ThreadActions>(
        () => createThreadActions(threadStore, threadTransport, resolveThread),
        [resolveThread, threadStore, threadTransport],
    );

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
            return { text: 'not saved', retry: () => mark(fileId, viewed) };
        },
        [writer],
    );

    const filters = useMemo(
        () => buildFileFilters({ files: diff.files, ownership: lenses.ownership, extra: lenses.extra }),
        [diff.files, lenses],
    );
    const filter = selectFilter(filters, filterId);
    const pci = findFilter(filters, PCI_FILTER_ID);
    // Files whose parsing failed: they have no model until the reviewer requests a retry,
    // and their counts must not be treated as unfinished, or "Other" would wait forever.
    const [parseErrors, setParseErrors] = useState<ReadonlyMap<string, string>>(new Map());
    const failedFiles = useMemo(() => new Set(parseErrors.keys()), [parseErrors]);
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
    const entryId = (entry: RouteEntry): string => entry.view.stop.id;
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

    // Patch parsing: request a stop's files once it has entered the viewport. Parse the rest
    // in the background after the first frame, or "Other" and the counters would have nothing to count.
    const requested = useRef(new Set<string>());
    const requestParse = useCallback(
        (fileIds: readonly string[]) => {
            for (const fileId of fileIds) {
                const file = diff.files.find((candidate) => candidate.fileId === fileId);
                // The model is already in the shared store (parsed by Full diff or the gallery), so no need to repeat it.
                if (file === undefined || requested.current.has(fileId) || store.getSnapshot().models.has(fileId)) {
                    continue;
                }
                requested.current.add(fileId);
                void parse(file).then(
                    (parsed) => {
                        store.setModel(fileId, parsed);
                    },
                    (error: unknown) => {
                        setParseErrors((previous) =>
                            new Map(previous).set(fileId, error instanceof Error ? error.message : String(error)),
                        );
                    },
                );
            }
        },
        [diff.files, parse, store],
    );
    useEffect(() => {
        const timer = setTimeout(() => {
            requestParse(diff.files.map((file) => file.fileId));
        }, BACKGROUND_PARSE_DELAY);
        return () => {
            clearTimeout(timer);
        };
    }, [diff.files, requestParse]);
    const retryParse = useCallback(
        (fileIds: readonly string[]) => {
            for (const fileId of fileIds) {
                requested.current.delete(fileId);
            }
            setParseErrors((previous) => {
                const next = new Map(previous);
                for (const fileId of fileIds) {
                    next.delete(fileId);
                }
                return next;
            });
            requestParse(fileIds);
        },
        [requestParse],
    );
    const retryFailed = useCallback(() => {
        retryParse([...failedFiles]);
    }, [failedFiles, retryParse]);

    // Cards start line selection, and the window ends it. Same hook as in the full diff.
    useSelectionLifecycle(store);

    const containerRef = useRef<HTMLElement | null>(null);
    /** The top stop in the viewport and its offset from the container edge anchor a preset change. */
    const topStopRef = useRef<{ stopId: string; offset: number } | null>(null);
    const settling = useRef(0);
    const [keptStopId, setKeptStopId] = useState<string | null>(props.initialKeptStopId ?? null);
    const [flashStopId, setFlashStopId] = useState<string | null>(null);
    const [otherOpen, setOtherOpen] = useState(false);
    /** Toolbar measurement: the sticky column offset uses the `route.css` fallback until the first measurement. */
    const [toolbarHeight, setToolbarHeight] = useState<number | null>(null);
    const [openedCollapsed, setOpenedCollapsed] = useState<ReadonlySet<string>>(new Set());

    const matches = useCallback(
        (entry: RouteEntry, ids: ReadonlySet<string> | null): boolean =>
            entry.kind === 'stop' ? stopMatchesFilter(entry.view, ids) : otherMatchesFilter(entry.view, ids),
        [],
    );
    const shown = useMemo(
        () => model.entries.filter((entry) => matches(entry, filter.fileIds) || entryId(entry) === keptStopId),
        [filter.fileIds, keptStopId, matches, model.entries],
    );

    const updateTopStop = useCallback(() => {
        const container = containerRef.current;
        if (container === null) {
            return;
        }
        const top = container.getBoundingClientRect().top;
        // The sticky toolbar covers the container's top strip, so readable content starts below it.
        const toolbar = container.querySelector<HTMLElement>('.route-toolbar');
        const line = toolbar === null ? top : Math.max(top, toolbar.getBoundingClientRect().bottom);
        const anchor = pickTopStop(top, line, stopBoxes(container));
        if (anchor !== null) {
            topStopRef.current = anchor;
        }
    }, []);
    const handleScroll = useCallback(() => {
        // Reviewer scrolling clears "kept on screen", but our own scroll correction does not.
        if (settling.current === 0) {
            setKeptStopId(null);
        }
        updateTopStop();
    }, [updateTopStop]);

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
        [filter.id, filters, matches, model.entries, session],
    );

    // Correction and flashing survive rerenders. Only the next jump or leaving the view cancels them.
    // Cancelling them on every dependency change would interrupt scrolling halfway through.
    const running = useRef<JumpRun | null>(null);
    const stopJump = useCallback(() => {
        const current = running.current;
        if (current === null) {
            return;
        }
        running.current = null;
        current.cancel();
        if (current.frame !== null) {
            cancelAnimationFrame(current.frame);
        }
        for (const timer of current.timers) {
            clearTimeout(timer);
        }
        settling.current = Math.max(0, settling.current - 1);
    }, []);

    /**
     * Jump to a stop, file card or line (README "Interactions"): scroll the dedicated
     * container directly to −150px from the target top, and flash the target.
     *
     * The target is almost never ready in the same frame: a filter may have hidden the stop,
     * a card may be deferred by lazy rendering until its stop appears onscreen (SPEC §2.9), and a line may
     * be waiting for file parsing. So the jump proceeds in stages, "section → card → line". Each
     * stage found immediately pulls scrolling towards it (reaching the section makes the view show it,
     * so deferred cards render). Later stages are sought frame by frame until the deadline. If it cannot reach the target,
     * it stays at the last stage reached, a visible fallback instead of doing nothing.
     *
     * `side` is required with `line`: without the gutter side, an added line with the same number
     * would intercept a jump to a deleted line.
     */
    const requestJump = useCallback(
        (
            stopId: string,
            fileId: string | null,
            line: number | null = null,
            side: 'old' | 'new' | null = null,
        ) => {
            stopJump();
            const container = containerRef.current;
            if (container === null) {
                return;
            }

            settling.current += 1;
            const run: JumpRun = { cancel: () => undefined, timers: [], frame: null, reached: 'none' };
            running.current = run;
            const deadline = Date.now() + JUMP_SEARCH_MS;

            const goTo = (step: JumpStep, element: HTMLElement): void => {
                if (JUMP_STEPS[step] <= JUMP_STEPS[run.reached]) {
                    return;
                }
                run.reached = step;
                run.cancel();
                run.cancel = animateScrollTo(container, targetScrollTop(container, element));
            };
            const finish = (): void => {
                run.frame = null;
                run.timers.push(
                    setTimeout(() => {
                        // Our correction has ended: the next scroll counts as a reviewer gesture again.
                        if (running.current === run) {
                            running.current = null;
                            settling.current = Math.max(0, settling.current - 1);
                        }
                    }, JUMP_DURATION + SETTLE_TAIL),
                );
            };

            const step = (): void => {
                if (running.current !== run) {
                    return;
                }
                const target = jumpTarget(container, stopId, fileId, line, side);
                if (target !== null) {
                    if (run.reached === 'none') {
                        setFlashStopId(stopId);
                        run.timers.push(
                            setTimeout(() => {
                                setFlashStopId(null);
                            }, FLASH_MS),
                        );
                    }
                    goTo(target.step, target.element);
                    // The final stage depends on the request: only look for a line if one was requested.
                    const done =
                        target.step === 'row' ||
                        (target.step === 'card' && line === null) ||
                        (target.step === 'section' && fileId === null);
                    if (target.step === 'row') {
                        flashRow(target.element);
                    }
                    if (done) {
                        finish();
                        return;
                    }
                }
                if (Date.now() >= deadline) {
                    finish();
                    return;
                }
                run.frame = requestAnimationFrame(step);
            };

            // Start the first attempt on the next frame: the same handler requests stop expansion
            // and filter clearing, so the target is absent from the markup until the rerender.
            run.frame = requestAnimationFrame(step);
        },
        [stopJump],
    );

    /** Expand a stop regardless of why it collapsed: by hand, by tier or by a viewed mark. */
    const expandStop = useCallback(
        (stopId: string) => {
            session.setStopCollapsed(stopId, false);
            if (stopProgress.isViewed(stopId)) {
                session.setViewedStopExpanded(stopId, true);
            } else {
                session.setStopExpanded(stopId, true);
            }
        },
        [session, stopProgress],
    );

    /**
     * Prepare a route entry for a jump: lens, collapsed state and hidden test code. Check the filter
     * against the file itself, not the stop: a lens keeps a stop on screen
     * even when it hides the very file the jump points to.
     */
    const revealTarget = useCallback(
        (entry: RouteEntry, fileId: string | null) => {
            const hidden =
                fileId === null
                    ? !matches(entry, filter.fileIds)
                    : filter.fileIds !== null && !filter.fileIds.has(fileId);
            if (hidden) {
                session.setFilter(ALL_FILTER_ID);
            }
            if (fileId !== null) {
                store.revealFile(fileId);
            }
            if (entry.kind === 'other') {
                setOtherOpen(true);
                return;
            }
            // Expand a collapsed stop before scrolling to it (SPEC §2.11).
            expandStop(entry.view.stop.id);
            // A file hidden by the digest behind "Show test code" would otherwise be absent from the markup.
            if (fileId !== null && buildDigest(entry.view.stop)?.testFileIds.has(fileId) === true) {
                session.setStopTestCode(entry.view.stop.id, true);
            }
        },
        [expandStop, filter.fileIds, matches, session, store],
    );

    const openFile = useCallback(
        (stopId: string, fileId: string) => {
            const entry = model.entries.find((candidate) => entryId(candidate) === stopId) ?? null;
            if (entry !== null) {
                revealTarget(entry, fileId);
            }
            requestJump(stopId, fileId);
        },
        [model.entries, requestJump, revealTarget],
    );

    const anchorReachable = useCallback(
        (stopId: string, fileId: string, line: number) =>
            resolveAnchor(model.entries, stopId, fileId, line) !== null,
        [model.entries],
    );

    /**
     * Follow a digest assertion anchor (README §2). An `uncovered` anchor points to code
     * that has no coverage, and another stop or "Other" explains that code:
     * jump to where the line actually renders, not where the click came from.
     */
    const openAnchor = useCallback(
        (stopId: string, fileId: string, line: number) => {
            const target = resolveAnchor(model.entries, stopId, fileId, line);
            const entry =
                target === null
                    ? null
                    : (model.entries.find((candidate) => entryId(candidate) === target.stopId) ?? null);
            if (target === null || entry === null) {
                return;
            }
            revealTarget(entry, fileId);
            requestJump(target.stopId, fileId, line, target.side);
        },
        [model.entries, requestJump, revealTarget],
    );

    // Our scroll adjustment does not count as a reviewer gesture while anchor correction is running: the browser
    // dispatches scroll events in the next task, so a timer closes the window.
    const anchoring = useRef<{ frames: number[]; timers: ReturnType<typeof setTimeout>[] } | null>(null);
    const endAnchoring = useCallback(() => {
        const run = anchoring.current;
        if (run === null) {
            return;
        }
        anchoring.current = null;
        for (const frame of run.frames) {
            cancelAnimationFrame(frame);
        }
        for (const timer of run.timers) {
            clearTimeout(timer);
        }
        settling.current = Math.max(0, settling.current - 1);
    }, []);
    useEffect(
        () => () => {
            stopJump();
            endAnchoring();
        },
        [endAnchoring, stopJump],
    );

    /**
     * Changing the preset anchors the viewport to the top stop (SPEC §2.5): the same stop id stays
     * on screen without resetting scrolling to the start. A layout effect restores it before
     * the new order is painted, without animation: the reading position stays the same.
     */
    const presetRef = useRef(preset);
    useAnchorEffect(() => {
        if (presetRef.current === preset) {
            return;
        }
        presetRef.current = preset;
        const anchor = topStopRef.current;
        if (anchor === null || containerRef.current === null) {
            return;
        }
        const apply = (): void => {
            const container = containerRef.current;
            const section = container?.querySelector<HTMLElement>(`[data-stop="${cssEscape(anchor.stopId)}"]`) ?? null;
            if (container === null || section === null) {
                return;
            }
            const delta = section.getBoundingClientRect().top - container.getBoundingClientRect().top;
            container.scrollTop += delta - anchor.offset;
        };

        // An unfinished correction from the previous jump would pull the container towards the old target.
        stopJump();
        endAnchoring();
        apply();
        settling.current += 1;
        const run: { frames: number[]; timers: ReturnType<typeof setTimeout>[] } = { frames: [], timers: [] };
        anchoring.current = run;
        // Neighbouring stops render their cards after entering the viewport and grow above
        // the anchor after reordering. So the position is confirmed a few more times.
        run.frames.push(
            requestAnimationFrame(() => {
                apply();
                run.frames.push(requestAnimationFrame(apply));
            }),
        );
        run.timers.push(
            setTimeout(() => {
                apply();
                // The last scroll adjustment is ours too: its event arrives in the next task,
                // so the correction window must stay open until then, or kept-in-view would be cleared.
                run.timers.push(setTimeout(endAnchoring, SETTLE_TAIL));
            }, ANCHOR_SETTLE),
        );
    }, [endAnchoring, preset, stopJump]);

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

    // --- A stop's "viewed" mark (SPEC §2.10, requirements §3.1) ---

    /**
     * Nothing to mark: the stop is unfilled, and "Other" on an unfinished route counts
     * everything the agent has not reached yet, rather than what remains in the model.
     */
    const unfilledEntry = useCallback(
        (entry: RouteEntry): boolean => entryUnfilled(entry) || (filling && entry.kind === 'other'),
        [filling],
    );
    const [stopFailures, setStopFailures] = useState<ReadonlyMap<string, boolean>>(EMPTY_FAILURES);
    const [announcement, setAnnouncement] = useState('');
    const autoMarking = useRef(new Set<string>());
    /** Last computed coverage: the first ready snapshot sets the baseline, without counting as a reviewer action. */
    const autoCoverage = useRef(new Map<string, boolean>());
    /** Clearing a mark by hand blocks automatic marking until coverage actually disappears. */
    const manuallyUnmarked = useRef(new Set<string>());
    const stopCoverageSnapshot = useMemo(
        () => ({ progress: diffSnapshot.progress, readState: diffSnapshot.readState }),
        [diffSnapshot.progress, diffSnapshot.readState],
    );
    const viewedStops = useMemo(
        () => model.entries.filter((entry) => stopViewed.get(entryId(entry)) === true).length,
        [model.entries, stopViewed],
    );
    const nextVisibleEntry = useCallback(
        (stopId: string): string | null => {
            const current = model.entries.findIndex((entry) => entryId(entry) === stopId);
            if (current < 0) {
                return null;
            }
            const next = model.entries.slice(current + 1).find((entry) => matches(entry, filter.fileIds));
            return next === undefined ? null : entryId(next);
        },
        [filter.fileIds, matches, model.entries],
    );

    const markStop = useCallback(
        async (stopId: string, viewed: boolean, withFeedback = true): Promise<void> => {
            const entry = model.entries.find((candidate) => entryId(candidate) === stopId) ?? null;
            const wasViewed = stopProgress.isViewed(stopId);
            if (entry === null || wasViewed === viewed) {
                return;
            }
            // A mark writes seen ranges, which can only be counted from parsed models:
            // before parsing, the mark would reach the server with an empty set and would not be rewritten later.
            // An unfilled stop has no ranges at all, and a file whose parsing failed
            // will have none until a retry. Clearing a mark does not require ranges.
            if (
                viewed &&
                (entryPending(entry, model.totals) ||
                    entryParseFailed(entry, model.totals) ||
                    unfilledEntry(entry))
            ) {
                return;
            }
            if (!viewed) {
                // Block before the optimistic update: its synchronous render will already see the cleared mark.
                manuallyUnmarked.current.add(stopId);
                // A viewed card's temporary expansion lasts only while the mark is set.
                session.forgetViewedExpansion(stopId);
            }
            setStopFailures((previous) => {
                if (!previous.has(stopId)) {
                    return previous;
                }
                const next = new Map(previous);
                next.delete(stopId);
                return next;
            });

            // The UI calculates ranges: the server has no diff model (decision log, 2026-08-26).
            const written = writer.writeStop(stopId, viewed, viewed ? stopSeenRanges(entry) : []);
            if (viewed && withFeedback) {
                const next = nextVisibleEntry(stopId);
                if (next !== null) {
                    // This continues collapsing, not stepping: keep the lens and the state of the next entry.
                    requestJump(next, null);
                }
            }
            if (withFeedback) {
                // The mark has already been applied optimistically, so announce what the reviewer sees on screen.
                const snapshot = stopProgress.getSnapshot();
                const count = model.entries.filter((candidate) => snapshot.get(entryId(candidate)) === true).length;
                setAnnouncement(
                    `Stop ${entry.view.planLabel} ${viewed ? 'marked viewed' : 'unmarked'}, ${String(count)} of ${String(model.stopCount)}`,
                );
            }
            if (!(await written)) {
                if (!viewed) {
                    manuallyUnmarked.current.delete(stopId);
                }
                setStopFailures((previous) => new Map(previous).set(stopId, viewed));
            }
        },
        [
            model.entries,
            model.stopCount,
            model.totals,
            nextVisibleEntry,
            requestJump,
            session,
            stopProgress,
            unfilledEntry,
            writer,
        ],
    );

    useEffect(() => {
        // Before the endpoint's first response, the store contains only defaults. That snapshot is not a baseline:
        // otherwise incoming server progress would look like new reading and trigger scrolling.
        if (!progressLoaded) {
            return;
        }

        const candidates: RouteEntry[] = [];
        const currentIds = new Set<string>();
        let feedbackStopId: string | null = null;

        for (const entry of model.entries) {
            const stopId = entryId(entry);
            currentIds.add(stopId);
            // While ranges cannot be counted correctly, this is not `false`: the first ready result
            // must become the baseline without turning data loading into a reviewer action.
            if (
                entryPending(entry, model.totals) ||
                entryParseFailed(entry, model.totals) ||
                unfilledEntry(entry)
            ) {
                continue;
            }

            const covered = stopCoveredByProgress(entry, stopCoverageSnapshot);
            const previous = autoCoverage.current.get(stopId);
            autoCoverage.current.set(stopId, covered);
            if (!covered) {
                manuallyUnmarked.current.delete(stopId);
                continue;
            }
            if (
                previous !== false ||
                stopViewed.get(stopId) === true ||
                manuallyUnmarked.current.has(stopId) ||
                autoMarking.current.has(stopId)
            ) {
                continue;
            }

            candidates.push(entry);
            if (matches(entry, filter.fileIds)) {
                // Several marks in one snapshot produce one jump and one final aria announcement.
                feedbackStopId = stopId;
            }
        }

        for (const stopId of autoCoverage.current.keys()) {
            if (!currentIds.has(stopId)) {
                autoCoverage.current.delete(stopId);
                manuallyUnmarked.current.delete(stopId);
            }
        }

        const start = (entry: RouteEntry): void => {
            const stopId = entryId(entry);
            autoMarking.current.add(stopId);
            void markStop(stopId, true, stopId === feedbackStopId).finally(() => {
                autoMarking.current.delete(stopId);
            });
        };
        for (const entry of candidates) {
            if (entryId(entry) !== feedbackStopId) {
                start(entry);
            }
        }
        const feedbackEntry = candidates.find((entry) => entryId(entry) === feedbackStopId);
        if (feedbackEntry !== undefined) {
            start(feedbackEntry);
        }
    }, [
        filter.fileIds,
        markStop,
        matches,
        model.entries,
        model.totals,
        progressLoaded,
        stopCoverageSnapshot,
        stopViewed,
        unfilledEntry,
    ]);

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

    /** The focused stop contains the focused element: its section has `data-stop` (SPEC §5). */
    const focusedEntry = useCallback((): RouteEntry | null => {
        if (typeof document === 'undefined') {
            return null;
        }
        const active = document.activeElement;
        const stopId = active instanceof Element ? (active.closest<HTMLElement>('[data-stop]')?.dataset.stop ?? null) : null;
        return stopId === null ? null : (shown.find((entry) => entryId(entry) === stopId) ?? null);
    }, [shown]);

    /** A stop can be marked only once its ranges are counted. Clearing a mark is always allowed. */
    const canToggleViewed = useCallback(
        (entry: RouteEntry): boolean =>
            stopProgress.isViewed(entryId(entry)) ||
            (!entryPending(entry, model.totals) &&
                !entryParseFailed(entry, model.totals) &&
                !unfilledEntry(entry)),
        [model.totals, stopProgress, unfilledEntry],
    );
    useShortcut({
        id: 'route.toggleStopViewed',
        keys: ['v'],
        label: 'Mark the stop viewed',
        when: () => {
            const entry = focusedEntry();
            return entry !== null && canToggleViewed(entry);
        },
        action: () => {
            const entry = focusedEntry();
            if (entry !== null) {
                void markStop(entryId(entry), !stopProgress.isViewed(entryId(entry)));
            }
        },
    });
    useShortcut({
        id: 'route.toggleStopCollapse',
        keys: ['x'],
        label: 'Collapse or expand the stop',
        when: () => focusedEntry() !== null,
        action: () => {
            const entry = focusedEntry();
            if (entry !== null) {
                toggleCollapse(entry);
            }
        },
    });

    // --- Coverage strip (SPEC §2.4) ---

    const coverage = useMemo(
        () => buildCoverageStrip({ totals: model.totals, entries: model.entries }),
        [model.entries, model.totals],
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

    const threadVisible = useCallback((thread: Thread) => threadIsVisible(thread, threadsShow), [threadsShow]);
    const visibleThreads = useCallback(
        (group: RouteFileGroup): readonly Thread[] =>
            threadsForGroup(group, threadSnapshot.byFile).filter(
                (thread) =>
                    (threadSnapshot.keptByFile.get(group.fileId)?.has(thread.id) ?? false) || threadVisible(thread),
            ),
        [threadSnapshot.byFile, threadSnapshot.keptByFile, threadVisible],
    );
    const visibleByFile = useMemo(() => {
        const map = new Map<string, readonly Thread[]>();
        for (const [fileId, threads] of threadSnapshot.byFile) {
            map.set(
                fileId,
                threads.filter(
                    (thread) => (threadSnapshot.keptByFile.get(fileId)?.has(thread.id) ?? false) || threadVisible(thread),
                ),
            );
        }
        return map;
    }, [threadSnapshot.byFile, threadSnapshot.keptByFile, threadVisible]);

    const expand = useCallback(
        (fileId: string, request: ContextExpandRequest): Promise<ContextExpandResult> =>
            expandContext({
                store,
                fileId,
                request,
                contentAvailable: pr.capabilities.fileContent,
                loadContent,
            }),
        [loadContent, pr.capabilities.fileContent, store],
    );

    const [focusedLine, setFocusedLine] = useState<{ fileId: string; side: 'old' | 'new'; line: number } | null>(null);
    const commentLine = useCallback(
        (fileId: string, side: 'old' | 'new', line: number) => {
            const file = diff.files.find((candidate) => candidate.fileId === fileId);
            if (file === undefined) {
                return;
            }
            const position = commentPosition(
                diffSnapshot.selection,
                diffSnapshot.models.get(fileId) ?? null,
                fileId,
                side,
                line,
            );
            const key = `new:${fileId}:${position.side}:${String(position.line)}`;
            openNewComposer(threadStore, key, { fileId, path: file.path, position }, pr.capabilities.commentIssues);
            // The range moved into the composer, so the live selection is no longer needed. Leaving it
            // would keep the line pencil visible and mix it into the next comment.
            store.clearSelection();
        },
        [diff.files, diffSnapshot.models, diffSnapshot.selection, pr.capabilities.commentIssues, store, threadStore],
    );
    useShortcut({
        id: 'thread.commentLine',
        keys: ['c'],
        label: 'Comment on the line under the cursor',
        when: () => focusedLine !== null,
        action: () => {
            if (focusedLine !== null) {
                commentLine(focusedLine.fileId, focusedLine.side, focusedLine.line);
            }
        },
    });

    const actions = useMemo<FileCardActions>(
        () => ({
            onViewed: markViewed,
            onExpand: expand,
            onRetryParse: (fileId: string) => {
                retryParse([fileId]);
            },
            onOpenFile: store.openFile,
            onShowWhitespace: store.showWhitespace,
            onSelectStart: (fileId, key, extend) => {
                store.beginSelection();
                if (extend) {
                    store.extendSelection(fileId, key);
                } else {
                    store.startSelection(fileId, key);
                }
            },
            onSelectExtend: store.extendSelection,
            onCommentLine: commentLine,
            onLineFocus: (fileId, side, line) => {
                setFocusedLine({ fileId, side, line });
            },
            onLineBlur: () => {
                setFocusedLine(null);
            },
        }),
        [commentLine, expand, markViewed, retryParse, store],
    );

    const cardFor = useCallback(
        (stopId: string, group: RouteFileGroup) => {
            const key = `${stopId}\u0000${group.fileId}`;
            const collapseReason = fileCollapseReason(diffSnapshot, group.file);
            return (
                <StopFileCard
                    key={group.fileId}
                    group={group}
                    model={diffSnapshot.models.get(group.fileId) ?? null}
                    parseError={parseErrors.get(group.fileId) ?? null}
                    mode={diffSnapshot.effectiveMode}
                    content={diffSnapshot.content.get(group.fileId)}
                    contentAvailable={pr.capabilities.fileContent}
                    expansion={diffSnapshot.expansion.get(group.fileId) ?? EMPTY_EXPANSION}
                    read={
                        diffSnapshot.readState.get(group.fileId) ??
                        readStateOf({ file: group.file, record: null })
                    }
                    collapseReason={collapseReason}
                    onToggleCollapse={() => {
                        actions.onLineBlur?.();
                        store.toggleFileCollapse(group.fileId);
                    }}
                    showWhitespace={diffSnapshot.whitespaceShown.has(group.fileId)}
                    selection={diffSnapshot.selection?.fileId === group.fileId ? diffSnapshot.selection : null}
                    threads={visibleThreads(group)}
                    composers={composersForGroup(group, composersSnapshot.byFile)}
                    threadStore={threadStore}
                    threadActions={threadActions}
                    threadNow={threadNow}
                    onFocusThread={NOOP_THREAD}
                    actions={actions}
                    collapsedOpen={openedCollapsed.has(key)}
                    onToggleCollapsed={() => {
                        setOpenedCollapsed((previous) => {
                            const next = new Set(previous);
                            if (next.has(key)) {
                                next.delete(key);
                            } else {
                                next.add(key);
                            }
                            return next;
                        });
                    }}
                />
            );
        },
        [
            actions,
            composersSnapshot.byFile,
            diffSnapshot,
            openedCollapsed,
            parseErrors,
            pr.capabilities.fileContent,
            store,
            threadActions,
            threadNow,
            threadStore,
            visibleThreads,
        ],
    );

    const outsideThreads = threadSnapshot.outside.filter(
        (thread) => threadSnapshot.keptVisible.has(thread.id) || threadVisible(thread),
    );

    return (
        <main
            className="route"
            id="view-route"
            ref={containerRef}
            onScroll={handleScroll}
            style={
                toolbarHeight === null
                    ? undefined
                    : ({ '--route-toolbar-height': `${String(toolbarHeight)}px` } as CSSProperties)
            }
        >
            <PrHeader
                pr={pr}
                additions={sum(diff.files, 'additions')}
                deletions={sum(diff.files, 'deletions')}
                files={diff.files.length}
                pci={pci?.available === true ? pci : null}
                pciActive={filter.id === PCI_FILTER_ID}
                onTogglePci={() => {
                    changeFilter(filter.id === PCI_FILTER_ID ? ALL_FILTER_ID : PCI_FILTER_ID);
                }}
                aside={<SnapshotPill snapshot={snapshot} />}
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
                        <p className="route__zero-text">{zeroResultText(filter)}</p>
                        <button
                            type="button"
                            className="route__zero-action"
                            onClick={() => {
                                changeFilter(ALL_FILTER_ID);
                            }}
                        >
                            Show all files
                        </button>
                    </div>
                ) : null}

                {shown.map((entry) =>
                    entry.kind === 'stop' ? (
                        <StopSection
                            key={entry.view.stop.id}
                            view={entry.view}
                            entries={model.entries}
                            stopCount={model.stopCount}
                            comments={countStopComments(entry.view, visibleByFile)}
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

            <span className="visually-hidden" role="status" aria-live="polite">
                {announcement}
            </span>
        </main>
    );
}

interface StopSectionProps {
    readonly view: RouteStopView;
    readonly entries: readonly RouteEntry[];
    readonly stopCount: number;
    readonly comments: number;
    /** null shows all stop files (no filter, or the stop is kept on screen). */
    readonly fileIds: ReadonlySet<string> | null;
    readonly keptInView: boolean;
    readonly viewed: boolean;
    /** Stop files are still being parsed, so mark ranges cannot be computed yet. */
    readonly pending: boolean;
    /** Parsing failed for some files. Their ranges are unavailable until retry. */
    readonly parseFailed: boolean;
    /** Agent disconnected during generation: filled stops get a quiet note (SPEC §4.4). */
    readonly filledBeforeStop: boolean;
    /** Collapsed by a viewed mark, manual `x` collapse or the low-tier default. */
    readonly collapsed: boolean;
    readonly collapsedManually: boolean;
    /** The stop is highlighted by hovering over a coverage strip segment (SPEC §2.4). */
    readonly marked: boolean;
    /** Value of the failed mark write. `null` means no write has failed. */
    readonly failedViewed: boolean | null;
    readonly flash: boolean;
    readonly readStateOf: (fileId: string) => ReturnType<typeof readStateOf>;
    readonly onViewed: (viewed: boolean) => void;
    readonly onFillStop?: (planIndex: number) => void;
    readonly onExpand: () => void;
    readonly onOpenFile: (stopId: string, fileId: string) => void;
    readonly onVisible: (fileIds: readonly string[]) => void;
    readonly renderCard: (stopId: string, group: RouteFileGroup) => ReactNode;
    /** Digest stop: test code expands below the digest card (README §2). */
    readonly testCodeShown: boolean;
    readonly onToggleTestCode: () => void;
    /** Whether a route card renders the file containing the assertion's anchor. */
    readonly anchorReachable: (fileId: string, line: number) => boolean;
    readonly onOpenAnchor: (fileId: string, line: number) => void;
}

function StopSection({
    view,
    entries,
    stopCount,
    comments,
    fileIds,
    keptInView,
    viewed,
    pending,
    parseFailed,
    filledBeforeStop,
    collapsed,
    collapsedManually,
    marked,
    failedViewed,
    flash,
    readStateOf: readState,
    onViewed,
    onFillStop,
    onExpand,
    onOpenFile,
    onVisible,
    renderCard,
    testCodeShown,
    onToggleTestCode,
    anchorReachable,
    onOpenAnchor,
}: StopSectionProps) {
    const ref = useRef<HTMLDivElement | null>(null);
    const onScreen = useOnScreen(ref);
    const files = useMemo(
        () => (fileIds === null ? view.files : view.files.filter((group) => fileIds.has(group.fileId))),
        [fileIds, view.files],
    );
    // Parsing is requested for all stop files, including hidden test code. The viewed mark's seen ranges
    // marks are computed from stop anchors and do not depend on the toggle (M2-T7).
    const ids = useMemo(() => files.map((group) => group.fileId), [files]);
    useEffect(() => {
        if (onScreen) {
            onVisible(ids);
        }
    }, [ids, onScreen, onVisible]);

    const digest = useMemo(() => buildDigest(view.stop), [view.stop]);
    // Hybrid "digest + regular files": hide only assertion anchor files that also belong
    // to this stop after applying the lens. Render all other cards as usual.
    const testCode = useMemo(
        () =>
            digest === null
                ? null
                : buildDigestTestCode(
                      digest,
                      entries,
                      view.stop.id,
                      files.map((group) => group.fileId),
                  ),
        [digest, entries, files, view.stop.id],
    );
    const shownFiles = useMemo(
        () =>
            testCode === null || testCodeShown
                ? files
                : files.filter((group) => !testCode.hiddenFileIds.has(group.fileId)),
        [files, testCode, testCodeShown],
    );

    const lines = files.reduce((total, group) => total + group.additions + group.deletions, 0);
    const cards = onScreen ? shownFiles : lazyCards(shownFiles);

    const status = view.stop.status;
    const diff = status === 'queued' || status === 'filling' ? (
        // Planned slot awaiting filling. Show a skeleton because there is nothing to explain yet, not "no hunks".
        <StopSkeleton />
    ) : view.drift ? (
        <AnchorDrift paths={view.unresolvedPaths} />
    ) : files.length === 0 && digest === null ? (
        <EmptyStop
            text={
                status === 'failed'
                    ? 'No hunks: the agent has not filled this stop.'
                    : view.empty
                      ? 'No hunks: filling did not mark any ranges.'
                      : 'The current filter hides this stop\'s files.'
            }
        />
    ) : collapsed ? (
        viewed ? (
            <ViewedSummary
                lines={lines}
                files={files.length}
                assertions={digest?.total ?? 0}
                onExpand={onExpand}
            />
        ) : (
            <CollapsedStop
                lines={lines}
                files={files.length}
                reason={collapsedManually ? 'collapsed by hand' : 'low tier'}
                onExpand={onExpand}
            />
        )
    ) : (
        <>
            {/* Some anchors fail to resolve, while others survive. Place the notice above the remaining cards. */}
            {view.unresolvedPaths.length === 0 ? null : <AnchorDrift paths={view.unresolvedPaths} partial />}
            {digest === null ? null : (
                <TestDigest
                    model={digest}
                    shown={testCodeShown}
                    onToggle={onToggleTestCode}
                    hiddenFiles={testCode?.hiddenFileIds.size ?? 0}
                    location={testCode?.location ?? null}
                    anchorReachable={(anchor) => anchorReachable(anchor.fileId, anchor.line)}
                    onOpenAnchor={(anchor) => {
                        onOpenAnchor(anchor.fileId, anchor.line);
                    }}
                />
            )}
            {cards.map((group) => renderCard(view.stop.id, group))}
            {cards.length < shownFiles.length ? (
                <p className="route-stop__lazy">
                    another {formatCount(shownFiles.length - cards.length)}{' '}
                    {plural(shownFiles.length - cards.length, 'card', 'cards', 'cards')} will appear as you
                    scroll
                </p>
            ) : null}
        </>
    );

    return (
        <div ref={ref} data-stop={view.stop.id}>
            <StopCard
                view={view}
                stopCount={stopCount}
                comments={comments}
                viewed={viewed}
                pending={pending}
                parseFailed={parseFailed}
                filledBeforeStop={filledBeforeStop}
                onViewed={onViewed}
                {...(onFillStop === undefined ? {} : { onFillStop })}
                failedViewed={failedViewed}
                marked={marked}
                keptInView={keptInView}
                flash={flash}
                chips={
                    <FileChips
                        files={files}
                        readStateOf={readState}
                        onOpen={(fileId) => {
                            onOpenFile(view.stop.id, fileId);
                        }}
                    />
                }
                diff={diff}
            />
        </div>
    );
}

function OtherSection({
    view,
    stopCount,
    pending,
    parseFailed,
    filling,
    failedFiles,
    onRetryFailed,
    opened,
    fileIds,
    keptInView,
    viewed,
    marked,
    failedViewed,
    flash,
    onViewed,
    onOpen,
    renderCard,
}: {
    view: RouteOtherView;
    stopCount: number;
    pending: boolean;
    /** Some diff files failed to parse, so their uncovered ranges have not been counted. */
    parseFailed: boolean;
    /** The route is still filling: Other counts vacant plan slots, not what the model left over. */
    filling: boolean;
    failedFiles: number;
    onRetryFailed: () => void;
    opened: boolean;
    /** null means show all uncovered ranges (no filter or the card is kept in view). */
    fileIds: ReadonlySet<string> | null;
    keptInView: boolean;
    viewed: boolean;
    marked: boolean;
    failedViewed: boolean | null;
    flash: boolean;
    onViewed: (viewed: boolean) => void;
    onOpen: () => void;
    renderCard: (stopId: string, group: RouteFileGroup) => ReactNode;
}) {
    // The card counts the same set that expands. Otherwise the button would promise all lines
    // and show only the subset that passes the filter.
    const filtered = useMemo(() => filterOtherView(view, fileIds), [fileIds, view]);
    const groups = useMemo(() => filtered.files.map((file) => uncoveredAsGroup(file)), [filtered.files]);

    return (
        <div data-stop={view.stop.id}>
            <OtherCard
                view={filtered}
                stopCount={stopCount}
                pending={pending}
                parseFailed={parseFailed}
                filling={filling}
                failedFiles={failedFiles}
                onRetryFailed={onRetryFailed}
                keptInView={keptInView}
                viewed={viewed}
                marked={marked}
                failedViewed={failedViewed}
                flash={flash}
                onViewed={onViewed}
                opened={opened}
                onOpen={onOpen}
                diff={groups.map((group) => renderCard(view.stop.id, group))}
            />
        </div>
    );
}

/** Static snapshot pill (README §1). Snapshot selection comes in M4. */
export function SnapshotPill({ snapshot }: { snapshot: RouteSnapshot }) {
    return (
        <span className="route-snapshot" title={`Route built for commit ${snapshot.commit}`}>
            snapshot {snapshot.commit.slice(0, 7)}
        </span>
    );
}

/** Stop sections in markup order. Lazy measurement stops at the first visible section when selecting an anchor. */
function* stopBoxes(container: HTMLElement): Generator<StopBox> {
    for (const section of container.querySelectorAll<HTMLElement>('[data-stop]')) {
        const stopId = section.dataset.stop;
        if (stopId !== undefined) {
            const rect = section.getBoundingClientRect();
            yield { stopId, top: rect.top, bottom: rect.bottom };
        }
    }
}

function sum(files: readonly FileDiff[], key: 'additions' | 'deletions'): number {
    return files.reduce((total, file) => total + file[key], 0);
}

/**
 * Adjust the scroll anchor before painting the frame, or the new order would flash at the wrong position.
 * Static rendering (tests, SSR) has no layout effects: use a regular effect there so React
 * does not warn about a layout effect on the server.
 */
const useAnchorEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

/** Thread focus is needed only by the full diff reply shortcut, which the route does not have. */
const NOOP_THREAD = (): void => undefined;
const EMPTY_EXPANSION: FileExpansion = new Map();

const FLASH_MS = 900;
/** Allow time after the animation: the browser dispatches scroll events after the final step. */
const SETTLE_TAIL = 50;
const BACKGROUND_PARSE_DELAY = 300;

interface JumpRun {
    /** Cancel the current scroll: the next stage takes over halfway through. */
    cancel: () => void;
    timers: ReturnType<typeof setTimeout>[];
    /** Frame for the next target search. `null` means the search has ended. */
    frame: number | null;
    reached: JumpStep;
}

/**
 * How long to wait for the jump target to appear. A filter may have hidden the section, lazy rendering may
 * defer the card until the stop enters the viewport, and the line may be waiting for file parsing.
 * Past the deadline, the jump stays at the last stage reached.
 */
const JUMP_SEARCH_MS = 1500;
/**
 * How long to keep the preset-change anchor: allow lazy rendering of neighbouring stops to finish
 * (the visibility observer and its rerender), but do not keep it long enough to fight
 * the reviewer's own scrolling.
 */
const ANCHOR_SETTLE = 120;
const EMPTY_FILE = {
    generated: false,
    viewed: false,
    additions: 0,
    deletions: 0,
} as const;
const EMPTY_THREAD_TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error('draft writing is unavailable in this state')),
    update: () => Promise.reject(new Error('draft writing is unavailable in this state')),
    delete: () => Promise.reject(new Error('draft writing is unavailable in this state')),
};
const EMPTY_RESOLVE = (): Promise<void> => Promise.reject(new Error('resolve is unavailable in this state'));
const EMPTY_SET_VIEWED = (): Promise<number> => Promise.reject(new Error('marking is unavailable in this state'));
const EMPTY_SET_STOP_VIEWED = (): Promise<number> =>
    Promise.reject(new Error('stop marking is unavailable in this state'));
const EMPTY_FAILURES: ReadonlyMap<string, boolean> = new Map();
