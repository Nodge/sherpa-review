import type {
    FileContent,
    FileDiff,
    PrDiff,
    PrMeta,
    RouteSnapshot,
    Thread,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
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
import type { RouteEntry, RouteFileGroup, RouteOtherView, RouteStopView } from '../../route/route-model.js';
import {
    buildRouteModel,
    composersForGroup,
    countStopComments,
    filterOtherView,
    lazyCards,
    otherMatchesFilter,
    stopMatchesFilter,
    threadsForGroup,
    uncoveredAsGroup,
} from '../../route/route-model.js';
import type { SessionStore } from '../../session/session-store.js';
import { createThreadActions } from '../../threads/actions.js';
import type { ComposerTransport } from '../../threads/composer.js';
import { countThreadSources, threadIsVisible } from '../../threads/model.js';
import type { ThreadStore } from '../../threads/store.js';
import { openNewComposer, OutsideThreads } from '../../threads/thread-list.tsx';
import type { ThreadActions } from '../../threads/thread-list.tsx';
import { formatCount, plural } from '../../text.js';
import { commentPosition } from '../full-diff.tsx';
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
    readonly store: DiffViewStore | null;
    readonly threadStore: ThreadStore | null;
    readonly snapshot: RouteSnapshot;
    /** Palette navigation increments `id`, and the view finishes scrolling to the stop. */
    readonly navigation?: { readonly id: number; readonly stopId: string } | null;
    /** Uncovered fraction exceeds the threshold: App shows "consider regenerating" (SPEC §4.3). */
    readonly onUnderExplained?: (value: boolean) => void;
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
    store,
    threadStore,
    snapshot,
    navigation = null,
    onUnderExplained,
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
            parse={parse}
            loadContent={loadContent}
            onOpenInEditor={openFileInEditor}
            threadTransport={threadTransport}
            onResolveThread={resolveThread}
            navigation={target}
            {...(onUnderExplained === undefined ? {} : { onUnderExplained })}
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
    /** The app creates the writer one level up. In the gallery, the workspace builds it itself. */
    readonly progressWriter?: ProgressWriter;
    readonly onSetViewed?: (fileId: string, viewed: boolean) => Promise<number>;
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    readonly onOpenInEditor: (path: string) => Promise<Feedback>;
    readonly threadTransport?: ComposerTransport;
    readonly onResolveThread?: (threadId: string, resolved: boolean) => Promise<void>;
    /** Fixed clock for the gallery. The application captures the time when the view mounts. */
    readonly threadNow?: number;
    readonly navigation?: { readonly id: number; readonly stopId: string } | null;
    readonly onUnderExplained?: (value: boolean) => void;
    /** Initial "kept on screen" state lets the gallery show the filter state without a click. */
    readonly initialKeptStopId?: string | null;
    /**
     * The stop mark is already applied to the session. This is the hook for writing seen ranges
     * to progress (M2-T7). In M2-T6 the mark stays visual only.
     */
    readonly onStopViewed?: (stopId: string, viewed: boolean) => void;
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
        navigation = null,
        onUnderExplained,
        onStopViewed,
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

    const createdWriter = useMemo(
        () =>
            createProgressWriter({
                initialRevision: 0,
                read: (fileId) => store.getSnapshot().progress.get(fileId) ?? null,
                apply: store.markViewed,
                restore: store.restoreProgress,
                send: onSetViewed,
                // App handles progress refreshes over SSE. A standalone workspace (gallery) does not.
                onSettled: () => undefined,
            }),
        [onSetViewed, store],
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

    const entryId = (entry: RouteEntry): string => entry.view.stop.id;
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
    const openFile = useCallback(
        (stopId: string, fileId: string) => {
            // Expand a collapsed stop before scrolling to it (SPEC §2.11).
            if (stopState.viewed.has(stopId)) {
                session.setViewedStopExpanded(stopId, true);
            } else {
                session.setStopExpanded(stopId, true);
            }
            requestJump(stopId, fileId);
        },
        [requestJump, session, stopState.viewed],
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
    }, [jumpTick, shown, diffSnapshot.models, stopJump, stopState]);

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
                            viewed={stopState.viewed.has(entry.view.stop.id)}
                            expanded={stopState.expanded.has(entry.view.stop.id)}
                            expandedViewed={stopState.expandedViewed.has(entry.view.stop.id)}
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
                                session.setStopViewed(entry.view.stop.id, value);
                                onStopViewed?.(entry.view.stop.id, value);
                            }}
                            onExpand={() => {
                                session.setStopExpanded(entry.view.stop.id, true);
                            }}
                            onExpandViewed={() => {
                                session.setViewedStopExpanded(entry.view.stop.id, true);
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
    readonly expanded: boolean;
    readonly expandedViewed: boolean;
    readonly flash: boolean;
    readonly copyHint: string | null;
    readonly readStateOf: (fileId: string) => ReturnType<typeof readStateOf>;
    readonly onViewed: (viewed: boolean) => void;
    readonly onExpand: () => void;
    readonly onExpandViewed: () => void;
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
    expanded,
    expandedViewed,
    flash,
    copyHint,
    readStateOf: readState,
    onViewed,
    onExpand,
    onExpandViewed,
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
    const collapsed = viewed ? !expandedViewed : view.stop.tier === 'low' && !expanded;
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
            <ViewedSummary lines={lines} files={files.length} onExpand={onExpandViewed} />
        ) : (
            <CollapsedStop lines={lines} files={files.length} reason="low tier" onExpand={onExpand} />
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
                onViewed={onViewed}
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
