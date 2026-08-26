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
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
    deleteReviewDraft,
    fetchFileContent,
    openInEditor,
    saveReviewDraft,
    setReviewThreadResolved,
    updateReviewDraft,
} from '../../api.js';
import { PrHeader } from '../../components/pr-header.tsx';
import type { DiffClient } from '../../diff/client.js';
import { createDiffClient } from '../../diff/client.js';
import type { DiffFileModel } from '../../diff/model.js';
import { toParseRequest } from '../../diff/model.js';
import { copyFileLink, copyStopLink } from '../../diff-view/copy-link.js';
import type { Feedback, FileCardActions } from '../../diff-view/file-card.tsx';
import type { ExpandAmount } from '../../diff-view/expand.js';
import type { DiffViewStore } from '../../diff-view/store.js';
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
import type { RouteEntry, RouteFileGroup, RouteOtherView, RouteStopView } from '../../route/route-model.js';
import {
    buildRouteModel,
    composersForGroup,
    countStopComments,
    entryPending,
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
import { animateScrollTo, JUMP_DURATION, targetScrollTop } from './scroll.js';
import { AnchorDrift, CollapsedStop, EmptyStop, StopCard, ViewedSummary } from './stop-card.tsx';
import { StopFileCard } from './stop-file-card.tsx';
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
    readonly prError: string | null;
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
    /** Palette navigation increments `id`, and the view finishes scrolling to the stop. */
    readonly navigation?: { readonly id: number; readonly stopId: string } | null;
    /** Uncovered fraction exceeds the threshold: App shows "consider regenerating" (SPEC §4.3). */
    readonly onUnderExplained?: (value: boolean) => void;
    /** Expose route counts. Only the view computes them, and the action panel and review summary need them. */
    readonly onRouteSummary?: (summary: RouteSummary) => void;
}

/** What the route view reports to the application: route slots and uncovered lines (README §13, SPEC §2.19). */
export interface RouteSummary {
    /** Stops in render order, including "Other" if present. */
    readonly stopIds: readonly string[];
    readonly otherStopId: string | null;
    readonly uncoveredLines: number;
}

export function RouteView({
    token,
    session,
    pr,
    prError,
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
    navigation = null,
    onUnderExplained,
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
            update: (commentId, body) => updateReviewDraft(token, commentId, body),
            delete: (commentId) => deleteReviewDraft(token, commentId),
        }),
        [token],
    );
    const resolveThread = useCallback(
        (threadId: string, resolved: boolean) => setReviewThreadResolved(token, threadId, resolved),
        [token],
    );
    const openFileInEditor = useCallback(
        async (path: string): Promise<Feedback> => {
            const result = await openInEditor(token, path);
            return result.outcome === 'opened' ? null : result.message;
        },
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
        prError !== null ||
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
                <p className="route__status">{prError ?? diffError ?? lensesError ?? progressError ?? 'Loading the route…'}</p>
            </main>
        );
    }

    return (
        <RouteWorkspace
            pr={pr}
            diff={diff}
            lenses={lenses}
            snapshot={snapshot}
            session={session}
            store={store}
            threadStore={threadStore}
            progressWriter={progressWriter}
            stopProgress={stopProgress}
            parse={parse}
            loadContent={loadContent}
            onOpenInEditor={openFileInEditor}
            threadTransport={threadTransport}
            onResolveThread={resolveThread}
            navigation={target}
            {...(onUnderExplained === undefined ? {} : { onUnderExplained })}
            {...(onRouteSummary === undefined ? {} : { onRouteSummary })}
        />
    );
}

export interface RouteWorkspaceProps {
    readonly pr: PrMeta;
    readonly diff: PrDiff;
    readonly lenses: UiReviewLensesResponse;
    readonly snapshot: RouteSnapshot;
    readonly session: SessionStore;
    readonly store: DiffViewStore;
    readonly threadStore: ThreadStore;
    /** The app creates the writer and viewed store one level up. The gallery's workspace creates its own. */
    readonly progressWriter?: ProgressWriter;
    readonly stopProgress?: StopProgressStore;
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
    readonly onOpenInEditor: (path: string) => Promise<Feedback>;
    readonly threadTransport?: ComposerTransport;
    readonly onResolveThread?: (threadId: string, resolved: boolean) => Promise<void>;
    /** Fixed clock for the gallery. The application captures the time when the view mounts. */
    readonly threadNow?: number;
    readonly navigation?: { readonly id: number; readonly stopId: string } | null;
    readonly onUnderExplained?: (value: boolean) => void;
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
        session,
        store,
        threadStore,
        parse,
        loadContent,
        onOpenInEditor,
        onSetViewed = EMPTY_SET_VIEWED,
        onSetStopViewed = EMPTY_SET_STOP_VIEWED,
        navigation = null,
        onUnderExplained,
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
        () => buildRouteModel({ snapshot, files: diff.files, models: diffSnapshot.models, failed: failedFiles }),
        [diff.files, diffSnapshot.models, failedFiles, snapshot],
    );
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
    const topStopRef = useRef<string | null>(null);
    const settling = useRef(0);
    const [keptStopId, setKeptStopId] = useState<string | null>(props.initialKeptStopId ?? null);
    const [flashStopId, setFlashStopId] = useState<string | null>(null);
    const [copyHint, setCopyHint] = useState<{ stopId: string; text: string } | null>(null);
    const [otherOpen, setOtherOpen] = useState(false);
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
        for (const section of container.querySelectorAll<HTMLElement>('[data-stop]')) {
            if (section.getBoundingClientRect().bottom > top) {
                topStopRef.current = section.dataset.stop ?? null;
                return;
            }
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
            const top = topStopRef.current;
            const entry = model.entries.find((candidate) => entryId(candidate) === top) ?? null;
            setKeptStopId(entry !== null && !matches(entry, next.fileIds) ? entryId(entry) : null);
            session.setFilter(next.id);
        },
        [filter.id, filters, matches, model.entries, session],
    );

    // Jump to a file card (README Interactions): custom container scroll, −150px, flash.
    const jump = useRef<{ id: number; stopId: string; fileId: string | null } | null>(null);
    const jumpCounter = useRef(0);
    const [jumpTick, setJumpTick] = useState(0);
    const requestJump = useCallback((stopId: string, fileId: string | null) => {
        jumpCounter.current += 1;
        jump.current = { id: jumpCounter.current, stopId, fileId };
        setJumpTick(jumpCounter.current);
    }, []);
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
    const openFile = useCallback(
        (stopId: string, fileId: string) => {
            // Expand a collapsed stop before scrolling to it (SPEC §2.11).
            expandStop(stopId);
            requestJump(stopId, fileId);
        },
        [expandStop, requestJump],
    );

    // Correction and flashing survive rerenders. Only the next jump or leaving the view cancels them.
    // Cancelling them on every dependency change would interrupt scrolling halfway through.
    const running = useRef<{ cancel: () => void; timers: ReturnType<typeof setTimeout>[] } | null>(null);
    const stopJump = useCallback(() => {
        const current = running.current;
        if (current === null) {
            return;
        }
        running.current = null;
        current.cancel();
        for (const timer of current.timers) {
            clearTimeout(timer);
        }
        settling.current = Math.max(0, settling.current - 1);
    }, []);
    useEffect(() => () => {
        stopJump();
    }, [stopJump]);

    useEffect(() => {
        const target = jump.current;
        const container = containerRef.current;
        if (target === null || container === null) {
            return;
        }
        const section = container.querySelector<HTMLElement>(`[data-stop="${cssEscape(target.stopId)}"]`);
        const element =
            target.fileId === null
                ? section
                : (section?.querySelector<HTMLElement>(`[data-file="${cssEscape(target.fileId)}"]`) ?? null);
        if (element === null) {
            // The card has not rendered yet. The next effect run will find it.
            return;
        }

        jump.current = null;
        stopJump();
        settling.current += 1;
        setFlashStopId(target.stopId);
        running.current = {
            cancel: animateScrollTo(container, targetScrollTop(container, element)),
            timers: [
                setTimeout(() => {
                    setFlashStopId(null);
                }, FLASH_MS),
                setTimeout(() => {
                    // The adjustment is done. The next scroll counts as a reviewer gesture again.
                    running.current = null;
                    settling.current = Math.max(0, settling.current - 1);
                }, JUMP_DURATION + SETTLE_TAIL),
            ],
        };
        // `stopViewed` is a dependency because expanding a marked stop changes
        // the markup, and the jump target appears only after expansion.
    }, [jumpTick, shown, diffSnapshot.models, stopJump, stopState, stopViewed]);

    // Filter changes need the top stop even before the first scroll (SPEC §2.7).
    useEffect(() => {
        updateTopStop();
    }, [shown, updateTopStop]);

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

    const [stopFailures, setStopFailures] = useState<ReadonlyMap<string, boolean>>(EMPTY_FAILURES);
    const [announcement, setAnnouncement] = useState('');
    const viewedStops = useMemo(
        () => model.entries.filter((entry) => stopViewed.get(entryId(entry)) === true).length,
        [model.entries, stopViewed],
    );

    const markStop = useCallback(
        async (stopId: string, viewed: boolean): Promise<void> => {
            const entry = model.entries.find((candidate) => entryId(candidate) === stopId) ?? null;
            if (entry === null) {
                return;
            }
            // A mark writes seen ranges, which can only be counted from parsed models:
            // before parsing, the mark would reach the server with an empty set and would not be rewritten later.
            // Clearing a mark needs no ranges, so always allow it.
            if (viewed && entryPending(entry, model.totals)) {
                return;
            }
            if (!viewed) {
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
            // The mark is already applied optimistically, so announce what the reviewer sees on screen.
            const snapshot = stopProgress.getSnapshot();
            const count = model.entries.filter((candidate) => snapshot.get(entryId(candidate)) === true).length;
            setAnnouncement(
                `Stop ${entry.view.planLabel} ${viewed ? 'marked' : 'unmarked'}, ${String(count)} of ${String(model.stopCount)}`,
            );
            if (!(await written)) {
                setStopFailures((previous) => new Map(previous).set(stopId, viewed));
            }
        },
        [model.entries, model.stopCount, model.totals, session, stopProgress, writer],
    );

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
            stopProgress.isViewed(entryId(entry)) || !entryPending(entry, model.totals),
        [model.totals, stopProgress],
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
        async (fileId: string, amount?: ExpandAmount): Promise<Feedback> => {
            if (!pr.capabilities.fileContent) {
                return null;
            }
            if (store.getSnapshot().content.has(fileId)) {
                store.expand(fileId, amount);
                return null;
            }
            let content: FileContent | null;
            try {
                content = await loadContent(fileId);
            } catch (error: unknown) {
                const reason = (error instanceof Error ? error.message : String(error)).replace(/\s*\.\s*$/, '');
                return `Could not fetch the file contents: ${reason}. Try again.`;
            }
            store.setContent(fileId, content);
            if (content !== null) {
                store.expand(fileId, amount);
            }
            return null;
        },
        [loadContent, pr.capabilities.fileContent, store],
    );

    const commentLine = useCallback(
        (fileId: string, side: 'old' | 'new', line: number) => {
            const file = diff.files.find((candidate) => candidate.fileId === fileId);
            if (file === undefined) {
                return;
            }
            const position = commentPosition(diffSnapshot.selection, fileId, side, line);
            const key = `new:${fileId}:${position.side}:${String(position.line)}`;
            openNewComposer(threadStore, key, { fileId, path: file.path, position });
        },
        [diff.files, diffSnapshot.selection, threadStore],
    );

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
            onOpenInEditor,
            onCopyLink: copyFileLink,
            onCommentLine: commentLine,
        }),
        [commentLine, expand, markViewed, onOpenInEditor, retryParse, store],
    );

    const cardFor = useCallback(
        (stopId: string, group: RouteFileGroup) => {
            const key = `${stopId}\u0000${group.fileId}`;
            return (
                <StopFileCard
                    key={group.fileId}
                    group={group}
                    model={diffSnapshot.models.get(group.fileId) ?? null}
                    parseError={parseErrors.get(group.fileId) ?? null}
                    mode={diffSnapshot.effectiveMode}
                    content={diffSnapshot.content.get(group.fileId)}
                    contentAvailable={pr.capabilities.fileContent}
                    expansion={diffSnapshot.expansion.get(group.fileId) ?? 0}
                    read={
                        diffSnapshot.readState.get(group.fileId) ??
                        readStateOf({ file: group.file, record: null })
                    }
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
                filters={filters}
                filter={filter}
                onFilter={changeFilter}
                threadsShow={threadsShow}
                threadCounts={countThreadSources(threadSnapshot.threads)}
                onThreadsShow={session.setThreadsShow}
                strip={
                    <CoverageStrip
                        model={settled ? coverage : null}
                        loading={{
                            kind: 'diff',
                            ready: diff.files.length - model.totals.pendingFiles,
                            total: diff.files.length,
                        }}
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
                            stopCount={model.stopCount}
                            comments={countStopComments(entry.view, visibleByFile)}
                            fileIds={entryId(entry) === keptStopId ? null : filter.fileIds}
                            keptInView={entryId(entry) === keptStopId}
                            viewed={stopViewed.get(entry.view.stop.id) === true}
                            pending={entry.view.pending}
                            collapsed={collapsedOf(entry.view)}
                            collapsedManually={stopState.collapsed.has(entry.view.stop.id)}
                            marked={markedStops.has(entry.view.stop.id)}
                            failedViewed={stopFailures.get(entry.view.stop.id) ?? null}
                            flash={flashStopId === entry.view.stop.id}
                            copyHint={copyHint?.stopId === entry.view.stop.id ? copyHint.text : null}
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
                            onExpand={() => {
                                expandStop(entry.view.stop.id);
                            }}
                            onOpenFile={openFile}
                            onCopyLink={() => {
                                void copyStopLink(entry.view.stop.id).then((text) => {
                                    setCopyHint({ stopId: entry.view.stop.id, text });
                                });
                            }}
                            onVisible={requestParse}
                            renderCard={cardFor}
                        />
                    ) : (
                        <OtherSection
                            key={entry.view.stop.id}
                            view={entry.view}
                            stopCount={model.stopCount}
                            pending={model.totals.pendingFiles > 0}
                            failedFiles={model.totals.failedFiles}
                            onRetryFailed={retryFailed}
                            opened={otherOpen}
                            fileIds={entryId(entry) === keptStopId ? null : filter.fileIds}
                            keptInView={entryId(entry) === keptStopId}
                            viewed={stopViewed.get(entry.view.stop.id) === true}
                            marked={markedStops.has(entry.view.stop.id)}
                            failedViewed={stopFailures.get(entry.view.stop.id) ?? null}
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
    readonly stopCount: number;
    readonly comments: number;
    /** null shows all stop files (no filter, or the stop is kept on screen). */
    readonly fileIds: ReadonlySet<string> | null;
    readonly keptInView: boolean;
    readonly viewed: boolean;
    /** Stop files are still being parsed, so mark ranges cannot be computed yet. */
    readonly pending: boolean;
    /** Collapsed by a viewed mark, manual `x` collapse or the low-tier default. */
    readonly collapsed: boolean;
    readonly collapsedManually: boolean;
    /** The stop is highlighted by hovering over a coverage strip segment (SPEC §2.4). */
    readonly marked: boolean;
    /** Value of the failed mark write. `null` means no write has failed. */
    readonly failedViewed: boolean | null;
    readonly flash: boolean;
    readonly copyHint: string | null;
    readonly readStateOf: (fileId: string) => ReturnType<typeof readStateOf>;
    readonly onViewed: (viewed: boolean) => void;
    readonly onExpand: () => void;
    readonly onOpenFile: (stopId: string, fileId: string) => void;
    readonly onCopyLink: () => void;
    readonly onVisible: (fileIds: readonly string[]) => void;
    readonly renderCard: (stopId: string, group: RouteFileGroup) => ReactNode;
}

function StopSection({
    view,
    stopCount,
    comments,
    fileIds,
    keptInView,
    viewed,
    pending,
    collapsed,
    collapsedManually,
    marked,
    failedViewed,
    flash,
    copyHint,
    readStateOf: readState,
    onViewed,
    onExpand,
    onOpenFile,
    onCopyLink,
    onVisible,
    renderCard,
}: StopSectionProps) {
    const ref = useRef<HTMLDivElement | null>(null);
    const onScreen = useOnScreen(ref);
    const files = useMemo(
        () => (fileIds === null ? view.files : view.files.filter((group) => fileIds.has(group.fileId))),
        [fileIds, view.files],
    );
    const ids = useMemo(() => files.map((group) => group.fileId), [files]);
    useEffect(() => {
        if (onScreen) {
            onVisible(ids);
        }
    }, [ids, onScreen, onVisible]);

    const lines = files.reduce((total, group) => total + group.additions + group.deletions, 0);
    const cards = onScreen ? files : lazyCards(files);

    const diff = view.drift ? (
        <AnchorDrift paths={view.unresolvedPaths} />
    ) : files.length === 0 ? (
        <EmptyStop
            text={
                view.empty
                    ? 'No hunks: filling marked up no ranges at all.'
                    : 'The files of this stop are hidden by the current filter.'
            }
        />
    ) : collapsed ? (
        viewed ? (
            <ViewedSummary lines={lines} files={files.length} onExpand={onExpand} />
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
            {cards.map((group) => renderCard(view.stop.id, group))}
            {cards.length < files.length ? (
                <p className="route-stop__lazy">
                    {formatCount(files.length - cards.length)} more{' '}
                    {plural(files.length - cards.length, 'card', 'cards', 'cards')} — they appear as you scroll
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
                onViewed={onViewed}
                failedViewed={failedViewed}
                marked={marked}
                keptInView={keptInView}
                onCopyLink={onCopyLink}
                copyHint={copyHint}
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
    failedFiles,
    onRetryFailed,
    opened,
    fileIds,
    keptInView,
    viewed,
    marked,
    failedViewed,
    onViewed,
    onOpen,
    renderCard,
}: {
    view: RouteOtherView;
    stopCount: number;
    pending: boolean;
    failedFiles: number;
    onRetryFailed: () => void;
    opened: boolean;
    /** null means show all uncovered ranges (no filter or the card is kept in view). */
    fileIds: ReadonlySet<string> | null;
    keptInView: boolean;
    viewed: boolean;
    marked: boolean;
    failedViewed: boolean | null;
    onViewed: (viewed: boolean) => void;
    onOpen: () => void;
    renderCard: (stopId: string, group: RouteFileGroup) => ReactNode;
}) {
    // The card counts the same set that will expand. Otherwise the button would promise 34 lines,
    // and show only the subset that passes the filter.
    const filtered = useMemo(() => filterOtherView(view, fileIds), [fileIds, view]);
    const groups = useMemo(() => filtered.files.map((file) => uncoveredAsGroup(file)), [filtered.files]);

    return (
        <div data-stop={view.stop.id}>
            <OtherCard
                view={filtered}
                stopCount={stopCount}
                pending={pending}
                failedFiles={failedFiles}
                onRetryFailed={onRetryFailed}
                keptInView={keptInView}
                viewed={viewed}
                marked={marked}
                failedViewed={failedViewed}
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
            snapshot {snapshot.commit.slice(0, 7)} · current
        </span>
    );
}

function sum(files: readonly FileDiff[], key: 'additions' | 'deletions'): number {
    return files.reduce((total, file) => total + file[key], 0);
}

/** `CSS.escape` is not always available (tests without a DOM), but the selector still needs to be built. */
function cssEscape(value: string): string {
    return typeof CSS === 'undefined' ? value.replace(/["\\]/g, '\\$&') : CSS.escape(value);
}

/** Thread focus is needed only by the full diff reply shortcut, which the route does not have. */
const NOOP_THREAD = (): void => undefined;

const FLASH_MS = 900;
/** Allow time after the animation: the browser dispatches scroll events after the final step. */
const SETTLE_TAIL = 50;
const BACKGROUND_PARSE_DELAY = 300;
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
